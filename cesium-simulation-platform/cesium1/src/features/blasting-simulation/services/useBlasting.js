import { ref, watch } from 'vue'
import { DEFAULT_KCO_PARAMS } from './core/computation/kcoModelCore.js'
import { DEFAULT_FRAGMENT_RENDER_LIMIT } from './core/blastDefaults.js'
import useMessage from '@/composables/useMessage.js'
import { createPlaybackParts, DEFAULT_PLAYBACK_SPEED_MS } from './useBlastingParts/playbackParts.js'
import { createWsParts } from './useBlastingParts/wsParts.js'
import { createKeyframeParts } from './useBlastingParts/keyframeParts.js'
import { createVibrationParts } from './useBlastingParts/vibrationParts.js'
import { createRenderParts } from './useBlastingParts/renderParts.js'
import { createDatasetDbParts } from './useBlastingParts/datasetDbParts.js'

let blastingManager = null
let playbackTimer = null
let blastingWs = null
let pendingWsDataset = null
let lastWsSeekFrame = -1
// ─── Seek Lock（拖动进度条期间的帧守卫）────────────────
// "拖动后糊成色块"的来源之一：seek 请求发出后，后端在**旧游标**位置继续推送的
// 若干帧会先于目标帧到达，与目标帧/残留纹理混写。这里维护一把锁：seek 生效
// 期间丢弃非目标帧，直到目标帧的三场切片到达（或超时兜底）再解锁渲染。
let seekLockFrame = null
let seekLockDropped = 0
// 超时兜底：后端对 seek 目标帧号有 clamp（total_frames），前端 maxFrame 与之
// 可能差 1 帧；若严格等待会永久锁死 → 丢弃超过 40 帧（约 2s 推流）自动解锁。
const SEEK_LOCK_MAX_DROPS = 40
const isStaleSeekFrame = frame => {
  if (seekLockFrame == null) return false
  if (Number(frame) === seekLockFrame) {
    seekLockFrame = null
    seekLockDropped = 0
    return false
  }
  seekLockDropped++
  if (seekLockDropped > SEEK_LOCK_MAX_DROPS) {
    seekLockFrame = null
    seekLockDropped = 0
    return false
  }
  return true
}
let lastStatsUpdateMs = 0
// 预计算完成后待自动播放（用户在预计算期间点了播放）
let pendingAutoStart = false
// WS 振动场数据是否已开始到达（首帧 PPV 到达前保持本地模拟，避免可视化空窗）
let wsVibrationStarted = false
// WS 连接状态（供 UI 显示连接指示器）
const wsConnected = ref(false)
// 后端推送完成标志：COMPLETED 帧到达时置 true，
// 与本地播放到达末尾双条件满足后才弹窗"预览播放完成"
const wsBackendCompleted = ref(false)

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
// 关键帧回放（全速预计算）是否就绪：就绪后播放/倍速/循环/拖拽全部基于关键帧，即时响应
const replayReady = ref(false)
// 全速预计算进度 { active, pct }（UI 显示"爆破物理预计算中 x%"）
const replayPrecompute = ref({ active: false, pct: 0 })

// 诊断脏标记：blastingManager 是模块级 let 变量（非响应式），
// threeStats computed 需要读取此 ref 才能在 setDataset / replayBlast /
// 播放逐帧后重新求值，否则首次缓存后永久冻结，诊断面板不更新。
const statsVersion = ref(0)

// MySQL 数据库事件相关状态
const dbEvents = ref([])
const dbLoading = ref(false)
const currentEventId = ref(null)

// ─── 单例可变状态（全部收拢到模块级）─────────────────────
// useBlasting() 会被多处调用（App.vue、面板控制器），此前部分状态定义在函数内，
// 每次调用各建一份（定时器/watch 重复注册、累加器不同步）。现统一为模块级单例，
// 与下方响应式状态共享同一生命周期（应用级，不随组件卸载销毁）。
// 运行时统计可追溯的随机种子（当前渲染器未注入种子，仅作为本次运行的种子标识供未来复现）
const randomSeed = ref(42 + Math.floor(Math.random() * 1000))
// RAF 播放累加器：每帧积累真实时间，超过有效帧间隔时推进一帧。
// 速度切换时无需重启定时器，下一帧自然按新间隔计算，无中断。
let _playbackAccumulator = 0
let _playbackLastTime = 0
// 预计算完成轮询定时器
let precomputePollTimer = null
// 重播请求序号：丢弃过期的并发请求结果
let replaySeq = 0
// 爆堆轮廓测量轮询定时器
let muckPollTimer = null
// 爆堆轮廓（三维包络 + 安息角标注）开关：用于论文图3-4"碎片落地堆积形成的爆堆"，
// 绘制爆堆半透明包络面、屋脊线、底部足迹框与安息角坡线。默认关闭，由预览面板按钮手动开启。
const muckPileOutlineEnabled = ref(false)
// 爆堆测量值（安息角 φ/堆高/堆宽/堆长），由渲染器节流更新
const muckPileMeasure = ref(null)
// 爆堆轮廓开启期间持续回读测量值：渲染器在暂停/播放任意状态下都按帧重建
// measure（renderFrame 内 _muckPileOutline.update() 每帧调用），UI 需独立轮询
// 才能拿到最新数据，否则暂停后碎片已落地堆成、面板仍显示"等待落地堆积"。
// 模块级单例仅注册一次；定时器由 enabled 状态收敛（关闭即清除）。
watch(
  muckPileOutlineEnabled,
  enabled => {
    if (enabled) {
      muckPileMeasure.value = blastingManager?.getMuckPileMeasure?.() ?? null
      muckPollTimer = setInterval(() => {
        muckPileMeasure.value = blastingManager?.getMuckPileMeasure?.() ?? null
      }, 500)
    } else if (muckPollTimer) {
      clearInterval(muckPollTimer)
      muckPollTimer = null
    }
  },
  { immediate: true }
)

// KCO 模型参数（碎块尺寸分布）
// fragmentCountRenderLimit 为碎片渲染上限（UI 可调，40-20000），默认 3000
const kcoParams = ref({
  ...DEFAULT_KCO_PARAMS,
  sourceMode: 'design',
  velocityScale: 0.42, // 抛掷速度收缩系数（UI 可调）。隧道受限空腔：压缩初速使爆堆紧贴掌子面成形（历史 0.42 量级），勿改回 1.0 否则碎片抛满整条隧道、散开不成堆
  fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT
})

// ─── 模块级可变句柄存取器（供 useBlastingParts/* 域工厂经 ctx 存取）───────
// 上方 let 声明的句柄会被整体重绑定（let 赋新值），域工厂不得捕获值副本；
// 统一经以下存取器读写，保持"模块级单例"语义与拆分前完全一致。
const getManager = () => blastingManager
const setManager = manager => {
  blastingManager = manager
}
const getPlaybackTimer = () => playbackTimer
const setPlaybackTimer = timer => {
  playbackTimer = timer
}
const getWs = () => blastingWs
const setWs = ws => {
  blastingWs = ws
}
const getPendingWsDataset = () => pendingWsDataset
const setPendingWsDataset = ds => {
  pendingWsDataset = ds
}
const getLastWsSeekFrame = () => lastWsSeekFrame
const setLastWsSeekFrame = frame => {
  lastWsSeekFrame = frame
}
// seek 锁写入器：两处写点均为"设帧号 + 清零丢弃计数"（读取仅在 isStaleSeekFrame 内）
const setSeekLockFrame = frame => {
  seekLockFrame = frame
}
const setSeekLockDropped = dropped => {
  seekLockDropped = dropped
}
const getLastStatsUpdateMs = () => lastStatsUpdateMs
const setLastStatsUpdateMs = ms => {
  lastStatsUpdateMs = ms
}
const getPendingAutoStart = () => pendingAutoStart
const setPendingAutoStart = pending => {
  pendingAutoStart = pending
}
const getWsVibrationStarted = () => wsVibrationStarted
const setWsVibrationStarted = started => {
  wsVibrationStarted = started
}
const getPlaybackAccumulator = () => _playbackAccumulator
const setPlaybackAccumulator = acc => {
  _playbackAccumulator = acc
}
const getPlaybackLastTime = () => _playbackLastTime
const setPlaybackLastTime = t => {
  _playbackLastTime = t
}
const getPrecomputePollTimer = () => precomputePollTimer
const setPrecomputePollTimer = timer => {
  precomputePollTimer = timer
}
const getReplaySeq = () => replaySeq
const setReplaySeq = seq => {
  replaySeq = seq
}

/**
 * 爆破板块组合式状态（应用级单例）
 *
 * 关键可变句柄与定时器等单例状态收拢在模块作用域（见上方"单例可变状态"块）：
 * 多次调用本函数返回同一份共享状态（App.vue 与面板控制器共享 dataset/播放状态），
 * 调用方无需（也不得）假设独立实例。组件卸载不清理播放定时器——
 * 面板收起后动画持续运行是有意行为。
 *
 * 函数体按六大职责拆分至 useBlastingParts/*：回放控制（playbackParts）、
 * 实时推送（wsParts）、关键帧预计算（keyframeParts）、数据集与数据库
 * （datasetDbParts）、渲染与图层（renderParts）、振动场与监测点
 * （vibrationParts）。本函数收缩为聚合器：构建共享上下文 ctx → 依次调用
 * 各域工厂 → 组装返回对象（键集合与键序与拆分前完全一致）。
 */
export default function useBlasting() {
  const { showMessage } = useMessage()

  // 共享上下文：模块级单例状态 + 可变句柄存取器，显式传给各域工厂（避免隐藏耦合）。
  // 跨域方法经 ctx.<域>.<方法> 在运行期调用（延迟绑定，见下方绑定处），
  // 各工厂构造期不得互调——与拆分前的惰性求值行为一致。
  const ctx = {
    showMessage,
    // 模块级响应式单例（稳定引用，直接共享）
    dataset,
    isPlaying,
    currentFrame,
    playbackSpeedMs,
    playbackRate,
    isLooping,
    abLoop,
    loadProgress,
    replayReady,
    replayPrecompute,
    statsVersion,
    randomSeed,
    wsConnected,
    wsBackendCompleted,
    dbEvents,
    dbLoading,
    currentEventId,
    muckPileOutlineEnabled,
    muckPileMeasure,
    kcoParams,
    // 模块级可变句柄存取器（let 重绑定，经存取器读写）
    getManager,
    setManager,
    getPlaybackTimer,
    setPlaybackTimer,
    getWs,
    setWs,
    getPendingWsDataset,
    setPendingWsDataset,
    getLastWsSeekFrame,
    setLastWsSeekFrame,
    setSeekLockFrame,
    setSeekLockDropped,
    getLastStatsUpdateMs,
    setLastStatsUpdateMs,
    getPendingAutoStart,
    setPendingAutoStart,
    getWsVibrationStarted,
    setWsVibrationStarted,
    getPlaybackAccumulator,
    setPlaybackAccumulator,
    getPlaybackLastTime,
    setPlaybackLastTime,
    getPrecomputePollTimer,
    setPrecomputePollTimer,
    getReplaySeq,
    setReplaySeq,
    // 模块级纯函数（seek 锁判帧，直接读写上方模块句柄）
    isStaleSeekFrame
  }

  // 六大职责域工厂（各调用一次）。工厂内的函数内局部 ref（effectiveDurationS、
  // cameraViewMode、layerVisibility、振动场各开关等）随每次 useBlasting() 调用
  // 重建——与拆分前"定义在函数内"的生命周期一致；模块级单例仍全局共享。
  const playback = createPlaybackParts(ctx)
  const ws = createWsParts(ctx)
  const keyframe = createKeyframeParts(ctx)
  const vibration = createVibrationParts(ctx)
  const render = createRenderParts(ctx)
  const datasetDb = createDatasetDbParts(ctx)

  // 跨域 API 延迟绑定：工厂体内经 ctx.playback / ctx.ws / ctx.keyframe /
  // ctx.vibration / ctx.render 调用彼此（datasetDb 无被调方，暂不暴露）
  ctx.playback = playback
  ctx.ws = ws
  ctx.keyframe = keyframe
  ctx.vibration = vibration
  ctx.render = render
  ctx.datasetDb = datasetDb

  return {
    dataset,
    isPlaying,
    currentFrame,
    maxFrame: playback.maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    setPlaybackRate: playback.setPlaybackRate,
    playbackRates: playback.PLAYBACK_RATES,
    isLooping,
    abLoop,
    stepFrame: playback.stepFrame,
    toggleLoop: playback.toggleLoop,
    markAbLoopPoint: playback.markAbLoopPoint,
    clearAbLoop: playback.clearAbLoop,
    toggleAbLoop: playback.toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // 关键帧回放就绪 / 全速预计算进度
    replayReady,
    replayPrecompute,
    previewMode: playback.previewMode,
    previewDisclaimer: playback.previewDisclaimer,
    // 实时推送连接状态
    wsConnected,
    // three.js 渲染
    threeStats: render.threeStats,
    replayBlast: render.replayBlast,
    // 块度分布与高亮
    fragmentDistribution: render.fragmentDistribution,
    highlightFragmentsBySize: render.highlightFragmentsBySize,
    clearFragmentHighlight: render.clearFragmentHighlight,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams: render.resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS: render.LAYER_DEFS,
    layerVisibility: render.layerVisibility,
    setLayerVisible: render.setLayerVisible,
    updateSection: render.updateSection,
    syncLayerVisibility: render.syncLayerVisibility,
    // 振动场显示模式（PPV/应力/损伤）
    VIBRATION_MODES: vibration.VIBRATION_MODES,
    vibrationDisplayMode: vibration.vibrationDisplayMode,
    vibrationFieldInfo: vibration.vibrationFieldInfo,
    setVibrationDisplayMode: vibration.setVibrationDisplayMode,
    // 萨道夫斯基场地参数（K/α）
    sadoskyParams: vibration.sadoskyParams,
    setSadoskyParams: vibration.setSadoskyParams,
    // 自动量程（色标满刻度跟随岩体代表性峰值，供图例显示）
    fieldRange: vibration.fieldRange,
    // 振动场底材"白模"开关（场图层开启时是否切白模底）
    whiteModelEnabled: vibration.whiteModelEnabled,
    setWhiteModelEnabled: vibration.setWhiteModelEnabled,
    translucentEnabled: vibration.translucentEnabled,
    setTranslucentEnabled: vibration.setTranslucentEnabled,
    isoLineEnabled: vibration.isoLineEnabled,
    setIsoLineEnabled: vibration.setIsoLineEnabled,
    // 色彩标尺 / 等值线密度 / 提取诊断
    normMode: vibration.normMode,
    setVibrationNormMode: vibration.setVibrationNormMode,
    carrierHz: vibration.carrierHz,
    setVibrationCarrierHz: vibration.setVibrationCarrierHz,
    contourDensity: vibration.contourDensity,
    setVibrationContourDensity: vibration.setVibrationContourDensity,
    contourStats: vibration.contourStats,
    // 矢量箭头场（P1-6）
    vectorFieldOn: vibration.vectorFieldOn,
    setVectorFieldOn: vibration.setVectorFieldOn,
    // 仿真 PPV 衰减 vs 萨道夫斯基对比曲线（P2-8 验证）
    ppvDecayData: vibration.ppvDecayData,
    // 场点拾取全时程曲线（P1-6 点击出时程）
    pointHistory: vibration.pointHistory,
    // 雷管延期误差（蒙特卡洛）
    delayJitter: vibration.delayJitter,
    setDelayJitter: vibration.setDelayJitter,
    // 监测点（测点波时程曲线）
    monitorPoints: vibration.monitorPoints,
    addMonitorPoint: vibration.addMonitorPoint,
    removeMonitorPoint: vibration.removeMonitorPoint,
    monitorPickActive: vibration.monitorPickActive,
    toggleMonitorPick: vibration.toggleMonitorPick,
    // 场点拾取（查询空间任意点 PPV/应力/损伤）
    ppvPickEnabled: vibration.ppvPickEnabled,
    pickedPpv: vibration.pickedPpv,
    togglePpvPick: vibration.togglePpvPick,
    blastDesign: render.blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents: datasetDb.loadDbEvents,
    loadDbEvent: datasetDb.loadDbEvent,
    // SubTask 6.7：模拟结果保存
    saveSimulationResult: datasetDb.saveSimulationResult,
    // 运行时统计随机种子（供 UI 展示或编辑）
    randomSeed,
    // 保存爆破设计（保存后自动重载）
    saveDesign: datasetDb.saveDesign,
    flyToCenter: render.flyToCenter,
    cameraViewMode: render.cameraViewMode,
    setCameraViewMode: render.setCameraViewMode,
    // 爆堆轮廓（三维包络 + 安息角标注）
    muckPileOutlineEnabled,
    muckPileMeasure,
    toggleMuckPileOutline: render.toggleMuckPileOutline,
    initBlastingManager: render.initBlastingManager,
    setFrame: playback.setFrame,
    togglePlayback: playback.togglePlayback,
    clearSimulation: ws.clearSimulation
  }
}
