import { computed, ref } from 'vue'
import { BlastingManager } from '../blastingManager.js'
import { validateKco } from '../blastingApi.js'
import { DEFAULT_KCO_PARAMS } from '../core/computation/kcoModelCore.js'
import { DEFAULT_FRAGMENT_RENDER_LIMIT } from '../core/blastDefaults.js'

// ─── 统一高性能模式 ───
// 取消双档切换，始终使用高保真模式：开碰撞。
// fragmentCountRenderLimit 为默认碎片渲染上限（UI 可调 40-20000），用户未配置时回退此值。
const PERFORMANCE_PROFILE = {
  fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT,
  enableInterCollision: true
}

// ─── 后端 KCO 计算（运行时打通 /validate/kco） ───────────
// x50/n 由后端统一计算，前端仅负责参数整理与分布采样，消除前后端公式漂移。
// 后端 schema 字段为大写字首（Q/A/RWS/B/S/d/H/xmax/b/W_abs/x_allow），见 blastingApi.validateKco。
function buildKcoBackendInput(params = {}) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null)
  const RMD = num(params.RMD) ?? 0
  const RDI = num(params.RDI) ?? 0
  const HF = num(params.HF) ?? 0
  const payload = {
    Q: num(params.Q) ?? 100,
    A: 0.06 * (RMD + RDI + HF),
    RWS: num(params.SANFO) ?? 100,
    B: num(params.B) ?? 1.5,
    S: num(params.S) ?? 2.0,
    d: (num(params.d) ?? 90) / 1000, // 孔径 mm → m
    H: num(params.H) ?? 4.5,
    xmax: num(params.xmax) ?? 2.0,
    b: num(params.b) ?? 2.0,
    W_abs: Math.max(0, num(params.drillDeviation) ?? 0)
  }
  // x_allow 可选（允许最大块度 m，≤xmax；不传则大块率为 0）
  const xAllow = num(params.x_allow)
  if (xAllow !== null) payload.x_allow = xAllow
  return payload
}

async function fetchKcoFromBackend(params) {
  try {
    const res = await validateKco(buildKcoBackendInput(params))
    if (res && Number.isFinite(res.x50) && res.x50 > 0) {
      return {
        x50: res.x50,
        n: Number.isFinite(res.n) ? res.n : null,
        x80: Number.isFinite(res.x80) ? res.x80 : null,
        oversizeRatio: Number.isFinite(res.oversizeRatio) ? res.oversizeRatio : null
      }
    }
  } catch (e) {
    console.warn('[useBlasting] 后端 KCO 计算失败，回退本地计算', e?.message)
  }
  return null
}

/**
 * 渲染与图层域工厂（Three.js 渲染管理 / 视角 / 爆堆轮廓 / KCO 重播 / 渲染统计 / 图层）
 *
 * 从 useBlasting() 拆出的"渲染·视角·爆堆·图层"职责区，并收拢原散落在
 * 振动场区尾部的图层同步（setLayerVisible/updateSection/syncLayerVisibility）
 * 与爆破设计数据（blastDesign）——它们与 layerVisibility 强耦合。
 *
 * 状态归属：blastingManager（let 重绑定，经 ctx 存取器读写）、statsVersion/
 * kcoParams/randomSeed/wsBackendCompleted/muckPile* 为模块级响应式单例（直接共享）；
 * cameraViewMode/layerVisibility/blastDesign 为本域函数内局部 ref——与拆分前
 * "定义在 useBlasting() 函数内"的生命周期一致（每次调用 useBlasting() 重建）。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.keyframe.startPrecomputeWatch （重播后重新预计算关键帧）
 * - ctx.playback.pausePlayback / startPlayback （重播后重启播放）
 * - ctx.vibration.* 各显示开关 ref 与 refreshMonitorPoints （场景重建后保持用户设置）
 */
export function createRenderParts(ctx) {
  const {
    showMessage,
    dataset,
    currentFrame,
    kcoParams,
    randomSeed,
    statsVersion,
    wsBackendCompleted,
    muckPileOutlineEnabled,
    muckPileMeasure,
    getManager,
    setManager,
    getReplaySeq,
    setReplaySeq
  } = ctx

  // ─── Three.js 渲染管理 ─────────────────────────────

  const initBlastingManager = viewer => {
    if (!getManager() && viewer) {
      setManager(new BlastingManager(viewer))
    }
  }

  const flyToCenter = () => {
    getManager()?.flyToCenter()
  }

  // ─── 三维观察视角（内部 / 外部） ─────────────────────────
  // 'interior' = 隧道内部直面掌子面；'exterior' = 外部测区整体视角（见渲染器 setCameraViewMode）
  const cameraViewMode = ref('interior')
  const setCameraViewMode = mode => {
    if (mode !== 'interior' && mode !== 'exterior') return
    cameraViewMode.value = mode
    getManager()?.setCameraViewMode(mode)
    showMessage(`已切换到${mode === 'interior' ? '隧道内部视角' : '外部测区视角'}`, 'info')
  }

  // ─── 爆堆轮廓（三维包络 + 安息角标注） ─────────────────────
  // 状态 muckPileOutlineEnabled/muckPileMeasure 为模块级单例（见文件头部"单例可变状态"块）
  const toggleMuckPileOutline = () => {
    muckPileOutlineEnabled.value = !muckPileOutlineEnabled.value
    getManager()?.setMuckPileOutlineEnabled(muckPileOutlineEnabled.value)
    if (muckPileOutlineEnabled.value) {
      const measure = getManager()?.getMuckPileMeasure() ?? null
      muckPileMeasure.value = measure
      showMessage(
        measure?.height != null
          ? measure.angle != null
            ? `已绘制爆堆轮廓，安息角 φ≈${measure.angle.toFixed(1)}°`
            : '已绘制爆堆轮廓'
          : '已开启爆堆轮廓，等待碎片落地堆积后测量安息角',
        'info'
      )
    } else {
      muckPileMeasure.value = null
      showMessage('已关闭爆堆轮廓', 'info')
    }
  }

  // 重新触发 three.js 爆破效果
  // kcoOverride：可选，外部传入的 KCO 参数覆盖（用于 UI 实时编辑后重播）
  // KCO 参数（x50/n）已打通后端：由 /validate/kco 计算，后端不可用时回退本地计算。
  // 重播为异步：先请求后端再启动动画，用序号丢弃过期的并发请求结果。
  const replayBlast = async kcoOverride => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    const seq = getReplaySeq() + 1
    setReplaySeq(seq)
    // 不强制 sourceMode='design'：保持与初次加载一致（'result'），
    // 避免重新播放时 KCO 参数计算方式不同导致动画不一致。
    // 只有用户在 UI 中修改了 KCO 参数时，_initThreeBridge 才会自动切到 'design'。
    const merged = {
      ...kcoParams.value,
      ...(kcoOverride || {}),
      enableInterCollision: PERFORMANCE_PROFILE.enableInterCollision,
      randomSeed: randomSeed.value
    }
    // 碎片渲染上限：优先用户配置（UI 可调，40-20000），未设置时用默认 3000
    const userLimit = Number(merged.fragmentCountRenderLimit)
    merged.fragmentCountRenderLimit = Number.isFinite(userLimit)
      ? Math.max(40, Math.min(20000, Math.round(userLimit)))
      : PERFORMANCE_PROFILE.fragmentCountRenderLimit
    // 运行时打通后端：x50/n 以后端 /validate/kco 计算结果为准
    const backend = await fetchKcoFromBackend(merged)
    if (seq !== getReplaySeq()) return // 已有更新的重播请求，放弃本次结果
    if (backend) {
      // 显式注入后端计算的 x50/n；calculateKCOParams 优先使用显式值
      merged.x50 = backend.x50
      merged.n = backend.n
    } else {
      showMessage('后端 KCO 计算不可用，已使用本地计算', 'info')
    }
    getManager()?.replayBlast(merged)
    // 重新预计算关键帧：重置就绪标志并重新监听（首个 step 到达前完成则直接就绪）
    ctx.keyframe.startPrecomputeWatch()
    // 递增脏标记，使 threeStats 读取到新的 _fragmentStats
    statsVersion.value++
    // 重播后重新同步图层与设计数据
    syncLayerVisibility()

    // 完整重置播放状态：重置帧号 + 重置完成标志 + 重启播放
    // 不重连 WS：重连后端会重新推送振动场帧，与碎片动画 GPU 负载叠加导致卡顿。
    // 振动场数据在重新加载事件（loadDbEvent）时自动推送。
    wsBackendCompleted.value = false
    currentFrame.value = 0
    ctx.playback.pausePlayback()
    ctx.playback.startPlayback()

    showMessage('爆破效果已重播（KCO 模型）', 'success')
  }

  // 获取 three.js 渲染统计
  // 读取 statsVersion 建立响应式依赖，使 setFrame / replayBlast 后能自动刷新
  const threeStats = computed(() => {
    statsVersion.value // 建立响应式依赖
    return getManager()?.getThreeStats() || null
  })

  // 块度分布统计（按 physSize 分组）：依赖 statsVersion 以便 replayBlast 后刷新
  const fragmentDistribution = computed(() => {
    statsVersion.value // 建立响应式依赖
    return getManager()?.getFragmentDistribution() || null
  })

  // 高亮指定块度范围的碎片（FragmentDistribution 子组件以 { min, max } 对象形式 emit）
  const highlightFragmentsBySize = ({ min, max }) => {
    getManager()?.highlightFragmentsBySize(Number(min), Number(max))
  }

  // 清除碎片高亮，恢复原始颜色
  const clearFragmentHighlight = () => {
    getManager()?.clearFragmentHighlight()
  }

  // 重置 KCO 参数为默认值
  const resetKcoParams = () => {
    kcoParams.value = { ...DEFAULT_KCO_PARAMS, sourceMode: 'design', velocityScale: 0.42 }
    showMessage('KCO 参数已重置为默认值', 'info')
  }

  // ─── 图层可见性控制（烟雾/碎石/隧道/钻孔/标注等） ─────
  // 图层定义：key → 中文标签，用于 UI 显示
  const LAYER_DEFS = [
    { key: 'smoke', label: '烟雾' },
    { key: 'dust', label: '粉尘' },
    { key: 'fragment', label: '碎块' },
    { key: 'fire', label: '火球' },
    { key: 'spark', label: '火花' },
    { key: 'shock_wave', label: '冲击波' },
    { key: 'glow', label: '泛光光斑' },
    { key: 'vibrationParticles', label: '振动波粒子' },
    { key: 'vibrationField', label: '振动场' },
    { key: 'tunnel', label: '隧道内壁' },
    { key: 'bench', label: '岩体' },
    { key: 'face', label: '掌子面' },
    { key: 'blastHoles', label: '爆破钻孔' },
    { key: 'annotations', label: '标注' }
  ]
  // 各图层开关状态（与渲染器 layerVisibility 同步）
  const layerVisibility = ref(
    LAYER_DEFS.reduce((acc, def) => {
      // 默认模式只显示原始爆破动画：振动场热力图与专业标注默认关闭，用户需要时开启
      acc[def.key] = def.key !== 'vibrationField' && def.key !== 'annotations'
      return acc
    }, {})
  )

  // 爆破设计数据（炮孔布置图 + 统计）
  const blastDesign = ref(null)

  const setLayerVisible = (layer, visible) => {
    layerVisibility.value[layer] = !!visible
    getManager()?.setLayerVisible(layer, !!visible)
  }

  // 运行时更新断面参数 + cutPattern，并自动重播以重建布孔
  const updateSection = payload => {
    getManager()?.updateSection(payload)
    replayBlast()
  }

  // 将 Vue 的图层可见性状态推送到渲染器（数据加载后调用，保持用户设置不被覆盖）
  const syncLayerVisibility = () => {
    // 推送当前 Vue 状态到渲染器，而非从渲染器回读
    const current = { ...layerVisibility.value }
    const mgr = getManager()
    if (mgr) {
      mgr.setLayersVisible(current)
    }
    // 白模开关同样在场景重建后保持用户设置
    mgr?.setWhiteModelEnabled(ctx.vibration.whiteModelEnabled.value)
    // 等力线开关在场景重建后保持用户设置
    mgr?.setIsoLineEnabled(ctx.vibration.isoLineEnabled.value)
    // 标尺在材质重建（uniform 回默认值）后同样保持用户设置
    mgr?.setVibrationNormMode(ctx.vibration.normMode.value)
    // 载波频率同属材质 uniform，重建后一并重放
    mgr?.setVibrationCarrierHz(ctx.vibration.carrierHz.value)
    mgr?.setVibrationVectorField(ctx.vibration.vectorFieldOn.value)
    mgr?.setVibrationTranslucent(ctx.vibration.translucentEnabled.value)
    // 场景(重)建后：保持雷管误差设置、并同步监测点列表（与重建后的管理器状态一致）
    mgr?.setDelayJitter?.(ctx.vibration.delayJitter.value)
    ctx.vibration.refreshMonitorPoints()
    // 场景(重)建后立刻刷新振动场元信息，使"振动场"面板的模式按钮/就绪徽标
    // 无需等待播放帧或 WS 推送即可用（本地解析场三模式随时可切换）
    ctx.vibration.vibrationFieldInfo.value = mgr?.getVibrationFieldInfo() || null
    blastDesign.value = mgr?.getBlastDesign() || null
    // 主动触发一次等值线构建（等值线不应依赖播放推进才可见——C 修复）
    mgr?.refreshContours()
  }

  return {
    initBlastingManager,
    flyToCenter,
    cameraViewMode,
    setCameraViewMode,
    toggleMuckPileOutline,
    replayBlast,
    threeStats,
    fragmentDistribution,
    highlightFragmentsBySize,
    clearFragmentHighlight,
    resetKcoParams,
    LAYER_DEFS,
    layerVisibility,
    blastDesign,
    setLayerVisible,
    updateSection,
    syncLayerVisibility
  }
}
