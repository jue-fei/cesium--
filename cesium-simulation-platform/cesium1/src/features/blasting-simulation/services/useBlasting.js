import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { BlastingManager } from './blastingManager.js'
import {
  fetchBlastingEvents,
  fetchBlastingEvent,
  createBlastingEvent,
  updateBlastingEvent,
  deleteBlastingEvent,
  fetchBlastingDesign,
  saveBlastingDesign,
  fetchBlastingResult,
  saveBlastingResult
} from './blastingApi.js'
import { DEFAULT_KCO_PARAMS } from './core/computation/kcoModelCore.js'
import useMessage from '@/composables/useMessage.js'

// 本地定义默认播放速度（原 blastingDataCore 已移除）
const DEFAULT_PLAYBACK_SPEED_MS = 50

let blastingManager = null
let playbackTimer = null

// ─── 响应式状态 ───────────────────────────────────────
const dataset = ref(null)
const isPlaying = ref(false)
const currentFrame = ref(0)
const playbackSpeedMs = ref(DEFAULT_PLAYBACK_SPEED_MS)
// B1 回放增强：播放倍速（1/2/4/8 循环切换）
const playbackRate = ref(1)
// B1 回放增强：整体循环播放开关（默认开启，保持原有循环行为）
const isLooping = ref(true)
// B1 回放增强：AB 区间循环 { a: 起始帧, b: 结束帧, enabled: 是否启用 }
const abLoop = ref({ a: null, b: null, enabled: false })
// B7 加载进度反馈：0-100
const loadProgress = ref(0)

// MySQL 数据库事件相关状态
const dbEvents = ref([])
const dbLoading = ref(false)
const currentEventId = ref(null)

// KCO 模型参数（碎块尺寸分布）
const kcoParams = ref({ ...DEFAULT_KCO_PARAMS })

export default function useBlasting() {
  const { showMessage } = useMessage()

  // ─── 时间-based 回放控制 ─────────────────────────────
  // SubTask 6.6：新数据集不再包含 frames 数组，总帧数由
  // result.simulationDurationS / result.timeStepS 计算
  const maxFrame = computed(() => {
    const duration = Number(dataset.value?.result?.simulationDurationS) || 10
    const dt = Number(dataset.value?.result?.timeStepS) || 0.05
    return Math.max(0, Math.floor(duration / dt) - 1)
  })

  const setFrame = frame => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    blastingManager?.setFrame(clamped)
  }

  const pausePlayback = () => {
    if (playbackTimer) clearInterval(playbackTimer)
    playbackTimer = null
    isPlaying.value = false
  }

  // B1：根据 playbackRate 计算实际播放间隔（rate 越大间隔越短）
  const computePlaybackInterval = () => {
    const base = Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    const rate = Math.max(1, Number(playbackRate.value) || 1)
    return Math.max(16, base / rate)
  }

  // B1：播放时计算下一帧（处理 AB 区间循环与整体循环）
  const computeNextFrame = () => {
    const cur = currentFrame.value
    const last = maxFrame.value
    // AB 区间循环优先
    if (abLoop.value.enabled && abLoop.value.a != null && abLoop.value.b != null) {
      const a = Math.min(abLoop.value.a, abLoop.value.b)
      const b = Math.max(abLoop.value.a, abLoop.value.b)
      // 当前位于区间内：到 B 点回到 A 点
      if (cur >= a && cur <= b) {
        return cur >= b ? a : cur + 1
      }
      // 当前位于区间外：跳回 A 点
      if (cur < a) return a
      return a // cur > b
    }
    // 整体循环
    if (cur >= last) {
      return isLooping.value ? 0 : cur
    }
    return cur + 1
  }

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    isPlaying.value = true
    playbackTimer = setInterval(() => {
      const next = computeNextFrame()
      // 非循环模式到达末尾：停止
      if (
        next === currentFrame.value &&
        currentFrame.value >= maxFrame.value &&
        !isLooping.value &&
        !(abLoop.value.enabled && abLoop.value.a != null)
      ) {
        pausePlayback()
        return
      }
      setFrame(next)
    }, computePlaybackInterval())
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  // B1：倍速循环切换 1→2→4→8→1
  const cyclePlaybackRate = () => {
    const rates = [1, 2, 4, 8]
    const idx = rates.indexOf(Number(playbackRate.value) || 1)
    playbackRate.value = rates[(idx + 1) % rates.length]
    // 若正在播放，以新倍速重启定时器
    if (isPlaying.value) {
      pausePlayback()
      startPlayback()
    }
    showMessage(`播放倍速 ${playbackRate.value}x`, 'info')
  }

  // B1：逐帧步进（direction: +1 前进 / -1 后退）
  const stepFrame = (direction = 1) => {
    if (!dataset.value) return
    pausePlayback()
    const target = currentFrame.value + (direction > 0 ? 1 : -1)
    setFrame(Math.max(0, Math.min(maxFrame.value, target)))
  }

  // B1：整体循环开关
  const toggleLoop = () => {
    isLooping.value = !isLooping.value
    showMessage(`整体循环已${isLooping.value ? '开启' : '关闭'}`, 'info')
  }

  // B1：标记 AB 区间点（在当前帧打点，第一次标记 A，第二次标记 B）
  const markAbLoopPoint = () => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    const cur = currentFrame.value
    const ab = abLoop.value
    if (ab.a == null) {
      abLoop.value = { ...ab, a: cur, b: null }
      showMessage(`已标记 A 点（帧 ${cur + 1}）`, 'info')
    } else if (ab.b == null) {
      abLoop.value = { ...ab, b: cur, enabled: true }
      showMessage(`已标记 B 点（帧 ${cur + 1}），AB 循环已启用`, 'success')
    } else {
      // 重新开始标记
      abLoop.value = { a: cur, b: null, enabled: false }
      showMessage(`重新标记 A 点（帧 ${cur + 1}）`, 'info')
    }
  }

  // B1：清除 AB 区间
  const clearAbLoop = () => {
    abLoop.value = { a: null, b: null, enabled: false }
    showMessage('AB 区间循环已清除', 'info')
  }

  // B1：切换 AB 循环启用状态
  const toggleAbLoop = () => {
    const ab = abLoop.value
    if (ab.a == null || ab.b == null) {
      showMessage('请先标记 A、B 两点', 'warning')
      return
    }
    abLoop.value = { ...ab, enabled: !ab.enabled }
    showMessage(`AB 循环已${abLoop.value.enabled ? '启用' : '禁用'}`, 'info')
  }

  const clearSimulation = () => {
    pausePlayback()
    blastingManager?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    currentEventId.value = null
    // B1：重置回放增强状态
    abLoop.value = { a: null, b: null, enabled: false }
    loadProgress.value = 0
  }

  // 组件卸载时清理播放定时器，避免内存泄漏
  // 面板收起（组件卸载）时不清除播放定时器，保持动画持续运行
  // blastingManager 为模块级单例，生命周期独立于面板组件
  // onUnmounted(() => {
  //   if (playbackTimer) {
  //     clearInterval(playbackTimer)
  //     playbackTimer = null
  //   }
  // })

  // ─── 数据集应用 ─────────────────────────────────────
  const applyDataset = (nextDataset, options = {}) => {
    const autoPlay = Boolean(options?.autoPlay)
    pausePlayback()
    dataset.value = nextDataset
    currentFrame.value = 0
    blastingManager?.setDataset(nextDataset)
    blastingManager?.setFrame(0)
    // 数据加载后同步图层可见性与爆破设计数据
    syncLayerVisibility()
    if (autoPlay) startPlayback()
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
    const autoPlay = options.autoPlay !== false
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
      if (result) {
        kcoParams.value = {
          Q: Number(event.chargeKg || 100),
          xmax: result.fragmentXmax ?? 2.0,
          x50: result.fragmentX50 ?? 0.5,
          b: result.fragmentB ?? 2.0,
          n: result.fragmentN ?? 1.5
        }
      }
      applyDataset(nextDataset, { autoPlay })
      currentEventId.value = eventId
      loadProgress.value = 100
      showMessage(`爆破事件 ${eventId} 已加载`, 'success')
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
  const saveSimulationResult = async () => {
    if (!currentEventId.value || !dataset.value?.result) {
      showMessage('无可保存的模拟结果', 'warning')
      return
    }
    try {
      // 获取 three.js 运行时统计，合并到结果数据中
      const stats = blastingManager?.getThreeStats?.()
      const resultData = {
        ...dataset.value.result,
        // 合并运行时统计（覆盖数据库旧值，确保保存的是最新模拟结果）
        // fragmentCount 对应 blasting_result.fragment_count
        ...(stats && typeof stats.total === 'number'
          ? { fragmentCount: stats.total }
          : {})
      }
      await saveBlastingResult(currentEventId.value, resultData)
      showMessage('模拟结果已保存', 'success')
    } catch (error) {
      showMessage(`保存失败: ${error.message}`, 'error')
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

  // ─── Three.js 渲染管理 ─────────────────────────────

  const initBlastingManager = viewer => {
    if (!blastingManager && viewer) {
      blastingManager = new BlastingManager(viewer)
    }
  }

  const flyToCenter = () => {
    blastingManager?.flyToCenter()
  }

  // 重新触发 three.js 爆破效果
  // kcoOverride：可选，外部传入的 KCO 参数覆盖（用于 UI 实时编辑后重播）
  const replayBlast = kcoOverride => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    const merged = { ...kcoParams.value, ...(kcoOverride || {}) }
    blastingManager?.replayBlast(merged)
    // 重播后重新同步图层与设计数据
    syncLayerVisibility()
    showMessage('爆破效果已重播（KCO 模型）', 'success')
  }

  // 获取 three.js 渲染统计
  const threeStats = computed(() => {
    return blastingManager?.getThreeStats() || null
  })

  // 重置 KCO 参数为默认值
  const resetKcoParams = () => {
    kcoParams.value = { ...DEFAULT_KCO_PARAMS }
    showMessage('KCO 参数已重置为默认值', 'info')
  }

  // ─── 图层可见性控制（烟雾/碎石/隧道/钻孔/标注等） ─────
  // 图层定义：key → 中文标签，用于 UI 显示
  const LAYER_DEFS = [
    { key: 'smoke', label: '烟雾' },
    { key: 'dust', label: '粉尘' },
    { key: 'fragment', label: '碎石' },
    { key: 'fire', label: '火球' },
    { key: 'spark', label: '火花' },
    { key: 'shock_wave', label: '冲击波' },
    { key: 'tunnel', label: '隧道内壁' },
    { key: 'bench', label: '岩体' },
    { key: 'face', label: '掌子面' },
    { key: 'blastHoles', label: '爆破钻孔' },
    { key: 'annotations', label: '专业标注' },
    // 新增可视化图层（默认关闭，需手动开启）
    { key: 'damageZone', label: '损伤区' },
    { key: 'ppvField', label: 'PPV振动场' },
    { key: 'blockColor', label: '块度染色' }
  ]
  // 各图层开关状态（与渲染器 layerVisibility 同步）
  // 新增的三个可视化图层默认关闭，不影响现有视觉
  const layerVisibility = ref(
    LAYER_DEFS.reduce((acc, def) => {
      acc[def.key] = !['damageZone', 'ppvField', 'blockColor'].includes(def.key)
      return acc
    }, {})
  )
  // 爆破设计数据（炮孔布置图 + 统计）
  const blastDesign = ref(null)

  // PPV 数据是否已加载（避免在 setLayerVisible 中重复请求后端）
  const ppvDataLoaded = ref(false)

  const setLayerVisible = (layer, visible) => {
    layerVisibility.value[layer] = !!visible
    // PPV 振动场：首次开启时需先从后端加载数据，否则 show() 时 ppvMesh 为空无显示
    // 通过 getPPVFieldStats() 判断是否已加载（可能已由 BlastEffect 标签页触发加载）
    if (layer === 'ppvField' && visible && !getPPVFieldStats()) {
      loadPPVField({ safetyStandard: 'general_building' })
        .then(ok => {
          if (ok) {
            ppvDataLoaded.value = true
            blastingManager?.setLayerVisible('ppvField', true)
          } else {
            // 加载失败：恢复关闭状态
            layerVisibility.value['ppvField'] = false
          }
        })
      return
    }
    blastingManager?.setLayerVisible(layer, !!visible)
  }

  // 将 Vue 的图层可见性状态推送到渲染器（数据加载后调用，保持用户设置不被覆盖）
  const syncLayerVisibility = () => {
    // 推送当前 Vue 状态到渲染器，而非从渲染器回读
    const current = { ...layerVisibility.value }
    if (blastingManager) {
      blastingManager.setLayersVisible(current)
    }
    blastDesign.value = blastingManager?.getBlastDesign?.() || null
  }

  // ─── 爆破效果评价：数据获取 + 联动高亮 ──────────────────
  /** 获取损伤区半径数据（供 UI 显示） */
  const getDamageZones = () => blastingManager?.getDamageZones?.() || null
  /** 联动高亮：高亮指定损伤区（null 取消） */
  const highlightDamageZone = (zone) => blastingManager?.highlightDamageZone?.(zone)
  /** 联动高亮：高亮指定块度等级的碎片（null 取消） */
  const highlightBlockClass = (cls) => blastingManager?.highlightBlockClass?.(cls)
  /** 获取爆破效果统计（最远抛掷距离等，从物理引擎实时读取） */
  const getBlastEffectStats = () => blastingManager?.getBlastEffectStats?.() || null
  /** 获取 PPV 场统计（maxPpv/meanPpv，需先 loadPPVField） */
  const getPPVFieldStats = () => blastingManager?.getPPVFieldStats?.() || null
  /** 切换 PPV 色标安全标准 */
  const setSafetyStandard = (std) => blastingManager?.setSafetyStandard?.(std)
  /** 异步加载 PPV 振动场数据 */
  const loadPPVField = (params) => blastingManager?.loadPPVField?.(params) || Promise.resolve(false)
  /** 联动：相机飞到最远碎片位置 */
  const flyToFarthestFragment = () => blastingManager?.flyToFarthestFragment?.() || false

  return {
    dataset,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    isLooping,
    abLoop,
    cyclePlaybackRate,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // three.js 渲染
    threeStats,
    replayBlast,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    syncLayerVisibility,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents,
    loadDbEvent,
    // SubTask 6.7：模拟结果保存
    saveSimulationResult,
    // 保存爆破设计（保存后自动重载）
    saveDesign,
    flyToCenter,
    initBlastingManager,
    setFrame,
    togglePlayback,
    clearSimulation,
    // 爆破效果评价：数据获取 + 联动高亮
    getDamageZones,
    highlightDamageZone,
    highlightBlockClass,
    getBlastEffectStats,
    getPPVFieldStats,
    setSafetyStandard,
    loadPPVField,
    flyToFarthestFragment
  }
}
