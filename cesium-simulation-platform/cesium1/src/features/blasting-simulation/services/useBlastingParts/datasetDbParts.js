import {
  fetchBlastingEvents,
  fetchBlastingEvent,
  fetchBlastingDesign,
  saveBlastingDesign,
  fetchBlastingResult,
  saveBlastingResult,
  saveRuntimeStats
} from '../blastingApi.js'
import { DEFAULT_KCO_PARAMS } from '../core/computation/kcoModelCore.js'
import { DEFAULT_FRAGMENT_RENDER_LIMIT } from '../core/blastDefaults.js'
import { matchLiteratureEvent } from '../core/literatureEvents.js'
import { SADOVSKY_DEFAULT_K, SADOVSKY_DEFAULT_ALPHA } from '../core/vibrationDefaults.js'

// 算法版本号（用于运行时统计可追溯）
const ALGORITHM_VERSION = 'kco-v2.1'

/**
 * 数据集与数据库域工厂（数据集应用 / MySQL 事件加载 / 结果与设计保存）
 *
 * 从 useBlasting() 拆出的"数据集应用 + 数据库事件加载"职责区：
 * applyDataset 把 {event, design, result} 数据集落到渲染器并联动各域状态；
 * loadDbEvents/loadDbEvent 走后端 API 组装数据集；saveSimulationResult/
 * saveDesign 把结果与设计回写数据库。
 *
 * 状态归属：dataset/currentFrame/kcoParams/randomSeed/dbEvents/dbLoading/
 * currentEventId/loadProgress 均为模块级响应式单例，仍驻留 useBlasting.js
 * 模块作用域，经 ctx 直接共享。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.playback.pausePlayback / startPlayback （数据集切换时停播/自动开播）
 * - ctx.render.syncLayerVisibility （数据加载后同步图层可见性）
 * - ctx.keyframe.startPrecomputeWatch （监控全速预计算进度）
 * - ctx.vibration.setSadoskyParams （按事件注入文献化萨道夫斯基参数）
 * - ctx.ws.connectBlastingWs （加载完成后建立实时推送通道）
 */
export function createDatasetDbParts(ctx) {
  const {
    showMessage,
    dataset,
    currentFrame,
    kcoParams,
    randomSeed,
    dbEvents,
    dbLoading,
    currentEventId,
    loadProgress,
    getManager
  } = ctx

  // ─── 数据集应用 ─────────────────────────────────────
  const applyDataset = (nextDataset, options = {}) => {
    const autoPlay = Boolean(options?.autoPlay)
    ctx.playback.pausePlayback()
    dataset.value = nextDataset
    currentFrame.value = 0
    getManager()?.setDataset(nextDataset, {
      kcoOverride: {
        ...kcoParams.value,
        randomSeed: randomSeed.value
      }
    })
    getManager()?.setFrame(0)
    // 数据加载后同步图层可见性与爆破设计数据
    ctx.render.syncLayerVisibility()
    // 监控全速预计算进度；就绪后若请求了自动播放则开始
    ctx.keyframe.startPrecomputeWatch()
    if (autoPlay) ctx.playback.startPlayback()
  }

  // ─── MySQL 数据库事件加载 ───────────────────────────

  const loadDbEvents = async () => {
    dbLoading.value = true
    try {
      const events = await fetchBlastingEvents()
      dbEvents.value = events
      return events
    } catch (error) {
      showMessage(`加载事件列表失败: ${error.message}`, 'error')
      dbEvents.value = []
      return []
    } finally {
      dbLoading.value = false
    }
  }

  // SubTask 6.1：重写 loadDbEvent
  // 数据流：fetchBlastingEvent → fetchBlastingDesign + fetchBlastingResult
  //        → 组装 {event, design, result} → BlastingManager.setDataset
  const loadDbEvent = async (eventId, options = {}) => {
    const autoPlay = options.autoPlay === true
    dbLoading.value = true
    // B7：加载进度反馈
    loadProgress.value = 10
    try {
      // 1. 获取事件（fetchBlastingEvent 返回 { event, design, result }，取 event 字段）
      const eventData = await fetchBlastingEvent(eventId)
      const event = eventData?.event || eventData
      loadProgress.value = 30
      // 2. 获取爆破设计 + 炮孔列表
      const { design, holes } = await fetchBlastingDesign(eventId)
      loadProgress.value = 60
      // 3. 获取爆破结果（新事件可能尚无结果，容错处理）
      let result = null
      try {
        result = await fetchBlastingResult(eventId)
      } catch (e) {
        // result 可能尚未生成（新建事件），置为 null 即可
        result = null
      }
      loadProgress.value = 80
      // 4. 组装数据集
      const nextDataset = {
        event,
        design: { ...design, holes: holes || [] },
        result
      }
      // 5. SubTask 6.3：从 design + result 提取 KCO 参数（不再单独 fetchKCOParams）
      // Q 为单孔装药量：优先取孔位平均单孔药量，否则按总药量 ÷ 孔数估算
      const chargedHoles = (holes || []).filter(h => Number(h.chargeKg) > 0)
      const holeChargeKg =
        chargedHoles.length > 0
          ? chargedHoles.reduce((s, h) => s + Number(h.chargeKg), 0) / chargedHoles.length
          : holes && holes.length > 0
            ? Number(event.chargeKg || 100) / holes.length
            : Number(event.chargeKg || 100)
      if (result) {
        kcoParams.value = {
          ...DEFAULT_KCO_PARAMS,
          Q: holeChargeKg,
          xmax: result.fragmentXmax ?? 2.0,
          x50: result.fragmentX50 ?? 0.5,
          b: result.fragmentB ?? 2.0,
          n: result.fragmentN ?? 1.5,
          explosiveType: event.explosiveType || 'emulsion',
          rockDensity:
            Number(event.rockParams?.density) ||
            Number(event.density) ||
            DEFAULT_KCO_PARAMS.rockDensity ||
            2650,
          sourceMode: 'result',
          fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT
        }
      } else {
        kcoParams.value = {
          ...DEFAULT_KCO_PARAMS,
          Q: holeChargeKg,
          explosiveType: event.explosiveType || 'emulsion',
          rockDensity:
            Number(event.rockParams?.density) ||
            Number(event.density) ||
            DEFAULT_KCO_PARAMS.rockDensity ||
            2650,
          sourceMode: 'design',
          fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT
        }
      }
      // 文献化萨道夫斯基参数注入：按事件下发场地常数，避免同一套参数通用或上一事件残留。
      // 事件匹配规则与各事件 K/α 见 core/literatureEvents.js（单源，与设计盖章共用同一映射）；
      // 无文献标定的事件（005~007）重置默认 K/α，避免残留上一事件参数。
      const litEvent = matchLiteratureEvent(eventId, nextDataset.event?.name)
      ctx.vibration.setSadoskyParams(
        litEvent?.sadosky || { k: SADOVSKY_DEFAULT_K, alpha: SADOVSKY_DEFAULT_ALPHA }
      )
      applyDataset(nextDataset, { autoPlay })
      currentEventId.value = eventId
      // 建立实时推送通道（WS 不可用时降级到本地 setInterval 播放）
      ctx.ws.connectBlastingWs(eventId)
      loadProgress.value = 100
      showMessage(`爆破事件 ${eventId} 已加载，可手动播放或重播预览`, 'success')
      return nextDataset
    } catch (error) {
      loadProgress.value = 0
      showMessage(`加载事件失败: ${error.message}`, 'error')
      return null
    } finally {
      dbLoading.value = false
    }
  }

  // SubTask 6.7：保存模拟结果回写到数据库
  // 设计结果写入 blasting_result，运行时统计写入 blasting_runtime_stats
  const saveSimulationResult = async () => {
    if (!currentEventId.value || !dataset.value?.result) {
      showMessage('无可保存的模拟结果', 'warning')
      return
    }
    // 获取 three.js 运行时统计
    const stats = getManager()?.getThreeStats?.() || {}

    // 步骤1：设计结果字段写入 blasting_result
    // 保留现有 dataset.result 字段（fragmentX50/N/xmax/b、throwDistance、crater 等）
    const resultData = {
      ...dataset.value.result,
      // 仅在算法侧未提供 fragmentCount 时兜底使用生成数，避免用渲染统计污染设计结果语义。
      ...(stats &&
      typeof stats.fragmentCountGenerated === 'number' &&
      !Number.isFinite(Number(dataset.value.result?.fragmentCount))
        ? { fragmentCount: stats.fragmentCountGenerated }
        : {})
    }
    // 新增：数量细分字段
    if (stats.fragmentCountTarget != null)
      resultData.fragmentCountTarget = stats.fragmentCountTarget
    if (stats.fragmentCountGenerated != null)
      resultData.fragmentCountGenerated = stats.fragmentCountGenerated
    if (stats.fragmentCountRendered != null)
      resultData.fragmentCountRendered = stats.fragmentCountRendered
    // 新增：质量字段
    if (stats.fragmentMassTargetKg != null)
      resultData.fragmentMassTargetKg = stats.fragmentMassTargetKg
    if (stats.fragmentMassGeneratedKg != null)
      resultData.fragmentMassGeneratedKg = stats.fragmentMassGeneratedKg
    // 新增：直方图 JSON 字段
    if (stats.sizeHistogramGenerated)
      resultData.fragmentHistogramJson = stats.sizeHistogramGenerated
    if (stats.velocityHistogramGenerated)
      resultData.velocityHistogramJson = stats.velocityHistogramGenerated
    if (stats.renderScaleMode) resultData.renderScaleMode = stats.renderScaleMode

    try {
      await saveBlastingResult(currentEventId.value, resultData)
    } catch (e) {
      console.error('[saveSimulationResult] 保存设计结果失败:', e)
      showMessage(`保存设计结果失败: ${e.message}`, 'error')
    }

    // 步骤2：运行时统计写入 blasting_runtime_stats
    const runtimePayload = {
      randomSeed: randomSeed.value,
      algorithmVersion: ALGORITHM_VERSION,
      paramsSnapshot: {
        // 核心输入参数快照
        chargeKg: stats.chargeKg || null,
        x50: stats.x50Applied || null,
        n: stats.nApplied || null,
        explosiveType: stats.explosiveType || null,
        rockDensityKgM3: stats.rockDensityKgM3 || null,
        fragmentCountTarget: stats.fragmentCountTarget || null,
        fragmentCountRenderLimit: stats.fragmentCountRenderLimit || null,
        kcoSourceMode: stats.kcoSourceMode || null
      },
      statsSnapshot: {
        fragmentCountGenerated: stats.fragmentCountGenerated || null,
        fragmentCountRendered: stats.fragmentCountRendered || null,
        fragmentMassCoverage: stats.fragmentMassCoverage || null,
        velocityMean: stats.velocityMean || null,
        velocityP95: stats.velocityP95 || null,
        throwDistancePredictedAvg: stats.throwDistancePredictedAvg || null,
        throwDistancePredictedMax: stats.throwDistancePredictedMax || null,
        sizeKLDivergence: stats.sizeKLDivergence || null,
        energyStats: stats.energyStats || null,
        sizeHistogramGenerated: stats.sizeHistogramGenerated || null,
        velocityHistogramGenerated: stats.velocityHistogramGenerated || null
      }
    }

    try {
      await saveRuntimeStats(currentEventId.value, runtimePayload)
      showMessage('预览结果已保存', 'success')
    } catch (e) {
      console.error('[saveSimulationResult] 保存运行时统计失败:', e)
      showMessage(`保存运行时统计失败: ${e.message}`, 'error')
    }
  }

  // 保存爆破设计到数据库，并自动重新加载事件以同步前端状态
  // designPayload: { design: {...}, holes: [...] }（camelCase）
  const saveDesign = async designPayload => {
    if (!currentEventId.value) {
      showMessage('未选中事件，无法保存设计', 'warning')
      return
    }
    try {
      await saveBlastingDesign(currentEventId.value, designPayload)
      showMessage('爆破设计已保存，正在重新加载...', 'success')
      // 保存成功后自动重载事件，使前端状态与 DB 一致
      await loadDbEvent(currentEventId.value, { autoPlay: false })
    } catch (error) {
      showMessage(`保存设计失败: ${error.message}`, 'error')
    }
  }

  return {
    loadDbEvents,
    loadDbEvent,
    saveSimulationResult,
    saveDesign
  }
}
