import { computed, ref, watch, onScopeDispose } from 'vue'
import { BlastingManager } from './blastingManager.js'
import {
  fetchBlastingEvents,
  fetchBlastingEvent,
  fetchBlastingDesign,
  saveBlastingDesign,
  fetchBlastingResult,
  saveBlastingResult,
  saveRuntimeStats,
  validateKco
} from './blastingApi.js'
import { DEFAULT_KCO_PARAMS } from './core/computation/kcoModelCore.js'
import { DEFAULT_FRAGMENT_RENDER_LIMIT } from './core/blastDefaults.js'
import { BlastingWsConnector, FrameType } from './core/realtime/blastingWsConnector.js'
import useMessage from '@/composables/useMessage.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'

// 本地定义默认播放速度（原 blastingDataCore 已移除）
const DEFAULT_PLAYBACK_SPEED_MS = 50

// ─── 统一高性能模式 ───
// 取消双档切换，始终使用高保真模式：开碰撞。
// fragmentCountRenderLimit 为默认碎片渲染上限（UI 可调 40-20000），用户未配置时回退此值。
const PERFORMANCE_PROFILE = {
  fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT,
  enableInterCollision: true
}

// 算法版本号（用于运行时统计可追溯）
const ALGORITHM_VERSION = 'kco-v2.1'

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

// KCO 模型参数（碎块尺寸分布）
// fragmentCountRenderLimit 为碎片渲染上限（UI 可调，40-20000），默认 3000
const kcoParams = ref({
  ...DEFAULT_KCO_PARAMS,
  sourceMode: 'design',
  velocityScale: 0.42, // 抛掷速度收缩系数（UI 可调）。隧道受限空腔：压缩初速使爆堆紧贴掌子面成形（历史 0.42 量级），勿改回 1.0 否则碎片抛满整条隧道、散开不成堆
  fragmentCountRenderLimit: DEFAULT_FRAGMENT_RENDER_LIMIT
})

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

export default function useBlasting() {
  const { showMessage } = useMessage()

  // 运行时统计可追溯的随机种子（当前渲染器未注入种子，仅作为本次运行的种子标识供未来复现）
  const randomSeed = ref(42 + Math.floor(Math.random() * 1000))

  // ─── 时间-based 回放控制 ─────────────────────────────
  // SubTask 6.6：新数据集不再包含 frames 数组，总帧数由
  // result.simulationDurationS / result.timeStepS 计算。
  // 时长优先取渲染器实测/回放时长（全部碎片落地 + 保持 3s，随事件自适应），
  // 使进度条与每个爆破事件真正绑定：碎片还在抛掷时进度条不会提前到底。
  const effectiveDurationS = ref(null)
  const maxFrame = computed(() => {
    const duration =
      effectiveDurationS.value || Number(dataset.value?.result?.simulationDurationS) || 10
    // 显示帧网格固定 0.05s：与回放关键帧烘焙网格/物理子步长一致
    const dt = 0.05
    return Math.max(0, Math.floor(duration / dt) - 1)
  })

  const previewMode = computed(() => {
    const sourceMode = threeStats.value?.kcoSourceMode || kcoParams.value?.sourceMode
    if (sourceMode === 'result') return '历史结果回放'
    return '参数趋势预览'
  })

  const previewDisclaimer = computed(
    () => '当前板块用于辅助观察参数与效果变化趋势，算法结果为可视化估算，不作为工程定量结论。'
  )

  const setFrame = (frame, isSeek = false) => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    blastingManager?.setFrame(clamped)
    // 进度条拖拽/jump（isSeek=true）：后端 WS 推流中时通知其复位游标并重置峰值累积，
    // 否则拖动回看仍顶着"未来帧的峰值"，损伤区自愈失效（seek 污染根因之一）。
    // 播放逐帧递增不设 isSeek，避免每 50ms 向后端刷 seek 造成重算风暴。
    if (isSeek && wsConnected.value && wsVibrationStarted && blastingWs) {
      if (lastWsSeekFrame !== clamped) {
        lastWsSeekFrame = clamped
        // 【Seek Lock】加锁 + 清空场纹理：锁住期间丢弃旧游标位置的帧，
        // 纹理清零保证目标帧落地前不显示任何残留（不糊成色块）。
        seekLockFrame = clamped
        seekLockDropped = 0
        blastingManager?.clearVibrationFieldTextures?.()
        blastingWs.sendSeek(clamped)
      } else {
        // 同一帧重复拖拽：仍需清屏（纹理可能已被旧游标帧污染）
        blastingManager?.clearVibrationFieldTextures?.()
      }
    } else if (isSeek) {
      // 本地模式：同样清屏，由本地模拟器下一 tick 重算填充
      blastingManager?.clearVibrationFieldTextures?.()
    }
    // 同步渲染器时长信号（回放就绪/实测达成时进度条随之延长，
    // 与每个事件的实际动画时长绑定：全落地 + 保持 3s）
    const d = blastingManager?.getDurationS?.()
    if (d != null && Number.isFinite(d) && d > 0 && d !== effectiveDurationS.value) {
      effectiveDurationS.value = d
    }
    // 始终刷新振动场元信息：无论 WS 是否连接，本地模拟与 WS 数据均通过同一渲染器接口
    // 更新场纹理，UI 需即时反映当前帧的 PPV/应力/损伤就绪状态
    vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    // 等值线提取诊断随元信息一并回读（提取为指纹缓存，常规帧为上次结果）
    contourStats.value = blastingManager?.getVibrationContourStats?.() ?? null
    // 递增脏标记，使 threeStats 重新求值
    // 节流到 200ms（5Hz），避免高倍速播放时 Vue 响应式风暴阻塞主线程
    const now = performance.now()
    if (!lastStatsUpdateMs || now - lastStatsUpdateMs >= 200) {
      lastStatsUpdateMs = now
      statsVersion.value++
    }
    // 爆堆轮廓开启时逐帧回读安息角/堆高/堆宽/堆长（渲染器节流重建，读不到时为 null）
    if (muckPileOutlineEnabled.value) {
      muckPileMeasure.value = blastingManager?.getMuckPileMeasure?.() ?? null
    }
  }

  const pausePlayback = () => {
    if (playbackTimer) {
      cancelAnimationFrame(playbackTimer)
      playbackTimer = null
    }
    _playbackAccumulator = 0
    _playbackLastTime = 0
    isPlaying.value = false
    pendingWsDataset = null
    blastingWs?.stopStream?.()
    blastingManager?.setLocalVibrationEnabled(true)
  }

  // RAF 播放累加器：每帧积累真实时间，超过有效帧间隔时推进一帧。
  // 速度切换时无需重启定时器，下一帧自然按新间隔计算，无中断。
  let _playbackAccumulator = 0
  let _playbackLastTime = 0

  // 根据 playbackRate 计算有效帧间隔（ms），rate 越大间隔越短
  // 不设下限，由 RAF 回调节流自然限制（~60fps ≈ 16.7ms/帧）
  const _effectiveFrameInterval = () => {
    const base = Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    const rate = Math.max(1, Number(playbackRate.value) || 1)
    return base / rate
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

  const _playbackTick = timestamp => {
    if (!isPlaying.value || !dataset.value) return
    if (_playbackLastTime === 0) {
      _playbackLastTime = timestamp
      playbackTimer = requestAnimationFrame(_playbackTick)
      return
    }
    const elapsed = timestamp - _playbackLastTime
    _playbackLastTime = timestamp
    _playbackAccumulator += elapsed

    const interval = _effectiveFrameInterval()
    while (_playbackAccumulator >= interval) {
      _playbackAccumulator -= interval
      const next = computeNextFrame()
      if (next === currentFrame.value && currentFrame.value >= maxFrame.value) {
        // 非循环模式到达末尾：停止
        if (!isLooping.value && !(abLoop.value.enabled && abLoop.value.a != null)) {
          pausePlayback()
          if (wsBackendCompleted.value) {
            showMessage('预览播放完成', 'success')
          }
          return
        }
      }
      setFrame(next)
    }
    playbackTimer = requestAnimationFrame(_playbackTick)
  }

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    // 全速预计算（关键帧烘焙）未完成：提示并等待，完成后自动开始播放。
    // 这样首次播放即进入关键帧回放——倍速/循环/拖拽/进度条时长全部即时、精确。
    if (!replayReady.value) {
      pendingAutoStart = true
      const pct = replayPrecompute.value?.pct ?? 0
      showMessage(
        pct > 0
          ? `爆破物理预计算中（${pct}%），完成后自动播放`
          : '爆破物理预计算中，完成后自动播放',
        'info'
      )
      return
    }
    isPlaying.value = true
    _playbackAccumulator = 0
    _playbackLastTime = 0
    if (currentFrame.value === 0) {
      pendingWsDataset = dataset.value
      if (wsConnected.value) {
        startBlastingWsStream(dataset.value)
      }
    } else {
      blastingManager?.setLocalVibrationEnabled(true)
    }
    playbackTimer = requestAnimationFrame(_playbackTick)
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  // B1：直接设置播放倍速（下拉选择全部倍数）
  const PLAYBACK_RATES = [1, 2, 4, 8]
  const setPlaybackRate = rate => {
    const r = Number(rate)
    if (!Number.isFinite(r) || r <= 0) return
    playbackRate.value = r
    // RAF 驱动模式下，速度切换后下一帧自然按新 interval 计算，无需重启
    showMessage(`播放倍速 ${r}x`, 'info')
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

  // ─── 实时推送通道（WebSocket） ──────────────────────
  // 建立与后端的实时连接，接收模拟进度帧与分段起爆事件。
  // 降级策略：WS 不可用或断开时，本地 setInterval 播放不受影响。
  const buildWsStartPayload = ds => {
    if (!ds) return null
    const duration = Number(ds?.result?.simulationDurationS) || 10
    const timestep = Number(ds?.result?.timeStepS) || 0.05
    const holes = (ds?.design?.holes || []).map(h => ({
      id: h.id,
      delayMs: h.delayMs,
      detonatorSeries: h.detonatorSeries,
      chargeKg: h.chargeKg
    }))
    const ppvParams = blastingManager?.getPpvStreamParams?.() || {}
    ppvParams.explosiveType =
      kcoParams.value?.explosiveType || ds?.event?.explosiveType || 'emulsion'
    // 多装药源（各炮孔装药段位置/药量/延时）：后端据此计算多应力波矢量叠加，
    // 非单一同心圆波场，符合真实掏槽微差起爆的波场干涉效果。
    // 【坐标系】getStreamBlastSources 已把源 z 平移到后端"掌子面 z=0"网格系
    // （与 ppvParams.blastCenter 同口径），GPU/本地模拟仍用 g 系源不受影响。
    ppvParams.sources = blastingManager?.getStreamBlastSources?.() || null
    // JWL+FDTD 在 build_ppv_grid 的 1.5m 分辨率网格上无法解析爆腔（R0≈0.28m < 1 格），
    // 实测 PPV 输出 ~1e-11 m/s（低于前端可见阈值 8 个数量级），三场（PPV/应力/损伤）
    // 全部不可见。降级萨道夫斯基近似（与本地模拟器同物理模型，量级正常），
    // 待后端 FDTD 支持亚格子源或自适应加密后再启用。
    ppvParams.useJwl = false
    // 损伤半径由 PPV 阈值纯物理计算得出（见 computeMultiSourcePeakDamageZones），
    // 不设人工硬上限。influenceRadius=波场可达半径，已按岩体几何自动取。
    const bd = blastingManager?.getDamageBoundary?.() || {}
    ppvParams.influenceRadius =
      Number(bd.influenceRadius) > 0 ? bd.influenceRadius : blastingManager?.getInfluenceRadius?.() || 60
    // 掌子面自由面反射（镜象源法）：与本地模拟/GPU 岩面同一物理口径——后端展开
    // 镜象源后，WS 场与本地兜底场在近掌子面处一致（反射放大 + 直达/反射干涉）
    ppvParams.reflections = blastingManager?.getVibrationReflections?.() || null
    if (ds?.event?.rockParams) {
      ppvParams.rockParams = ds.event.rockParams
    }
    return { duration, timestep, holes, ppvParams }
  }

  const startBlastingWsStream = (ds = dataset.value) => {
    if (!blastingWs) return
    const payload = buildWsStartPayload(ds)
    if (!payload) return
    // 新一轮推流复位 seek 去重标记，保证首帧拖拽必然下发 seek
    lastWsSeekFrame = -1
    seekLockFrame = null
    seekLockDropped = 0
    pendingWsDataset = null
    wsBackendCompleted.value = false
    wsVibrationStarted = false
    // 不立即禁用本地模拟：WS 数据到达前由本地模拟器填充振动场，避免可视化空窗。
    // 首帧 PPV 到达后由 PPV_FIELD 处理器禁用本地模拟，切换到 WS 实时数据。
    blastingManager?.setLocalVibrationEnabled(true)
    blastingWs.startStream(payload.duration, payload.timestep, payload.holes, payload.ppvParams)
  }

  const connectBlastingWs = eventId => {
    disconnectBlastingWs()
    // 启用本地振动场模拟作为主数据源（WS 不可用时自行模拟实时数据）
    // 波前粒子特效始终由播放时钟驱动，保证振动传播可视化始终可用
    blastingManager?.setLocalVibrationEnabled(true)
    blastingWs = new BlastingWsConnector(eventId)
    blastingWs.on('_open', () => {
      wsConnected.value = true
      wsBackendCompleted.value = false
      blastingManager?.setLocalVibrationEnabled(true)
      if (pendingWsDataset && currentFrame.value === 0 && isPlaying.value) {
        startBlastingWsStream(pendingWsDataset)
      }
    })
    blastingWs.on('_close', () => {
      wsConnected.value = false
      wsVibrationStarted = false
      // WS 断开：恢复本地热力图模拟，保证可视化不中断
      blastingManager?.setLocalVibrationEnabled(true)
    })
    blastingWs.on('_giveup', () => {
      wsConnected.value = false
      wsVibrationStarted = false
      blastingManager?.setLocalVibrationEnabled(true)
      showMessage('实时连接断开，已切换到本地预览', 'warning')
    })
    blastingWs.on(FrameType.PROGRESS, () => {
      // 不驱动 setFrame：本地播放定时器（startPlayback）已增量推进碎片动画，
      // PROGRESS 帧的 setFrame 会与本地播放冲突——偏差 > 10 帧时 seekTo
      // 触发异步重建粒子系统，碎片 InstancedMesh 在重建期间不更新，
      // 导致动画卡顿、帧跳转、轨迹不连贯。
      // WebSocket 仅负责推送振动场/应力/损伤数据，碎片动画由本地播放独立驱动。
    })
    // PPV 振动场二进制帧：首帧初始化体积，后续帧更新 Data3DTexture
    blastingWs.on(FrameType.PPV_FIELD, payload => {
      if (!blastingManager) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, ppv } = payload
      // 网格不一致时重建体积（本地模拟可能已用默认 32×32×64 网格初始化，
      // 不重建则 WS 帧因长度不匹配被丢弃，画面冻结）
      blastingManager.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      blastingManager.updateVibrationField(ppv, t, frame)
      // 首帧 WS 数据到达：禁用本地 PPV 写入（应力/损伤仍由本地兜底），切换到 WS 实时数据
      if (!wsVibrationStarted) {
        wsVibrationStarted = true
        blastingManager?.setLocalVibrationEnabled(false)
      }
      // 每帧刷新振动场元信息，使 UI 即时反映 PPV 就绪状态
      vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    })
    // σ_vm 应力场二进制帧：与 PPV 同时刻推送，更新应力纹理
    blastingWs.on(FrameType.STRESS_FIELD, payload => {
      if (!blastingManager) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, sigmaVm } = payload
      blastingManager.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      blastingManager.updateStressField(sigmaVm, t, frame)
      // 每帧刷新振动场元信息，使 UI 即时反映应力就绪状态
      vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    })
    // 损伤分区二进制帧：与 PPV 同时刻推送，更新损伤纹理
    blastingWs.on(FrameType.DAMAGE_FIELD, payload => {
      if (!blastingManager) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, zones } = payload
      blastingManager.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      blastingManager.updateDamageField(zones, t, frame)
      // 每帧刷新振动场元信息，使 UI 即时反映损伤就绪状态
      vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    })
    blastingWs.on(FrameType.COMPLETED, () => {
      // 后端推送完成 ≠ 本地动画播放完成。
      // 设置标志，等本地播放到达最后一帧时才弹窗（双条件同步）。
      // 若本地播放已停止（本地快于后端），直接弹窗。
      wsBackendCompleted.value = true
      // 推流结束不再有 WS 帧到达：恢复本地模拟写入（首个 WS PPV 帧曾禁用它），
      // 否则完成后拖动进度条时 PPV 热力图冻结在最后一帧、不跟随时间轴回退。
      blastingManager?.setLocalVibrationEnabled(true)
      if (!isPlaying.value) {
        showMessage('预览播放完成', 'success')
      }
    })
    blastingWs.connect()
  }

  const disconnectBlastingWs = () => {
    pendingWsDataset = null
    wsVibrationStarted = false
    if (blastingWs) {
      blastingWs.disconnect()
      blastingWs = null
    }
    wsConnected.value = false
    // WS 断开：恢复本地热力图模拟
    blastingManager?.setLocalVibrationEnabled(true)
  }

  const clearSimulation = () => {
    pausePlayback()
    disconnectBlastingWs()
    stopPrecomputeWatch()
    pendingAutoStart = false
    blastingManager?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    effectiveDurationS.value = null
    replayReady.value = false
    replayPrecompute.value = { active: false, pct: 0 }
    currentEventId.value = null
    // B1：重置回放增强状态
    abLoop.value = { a: null, b: null, enabled: false }
    loadProgress.value = 0
    // 清理场点拾取
    blastingManager?.disablePpvPick?.()
    ppvPickEnabled.value = false
    pickedPpv.value = null
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

  // ─── 关键帧回放就绪监听（全速预计算） ──────────────
  // 预计算（Worker 全速烘焙整段物理）完成后轮询置位 replayReady，
  // 期间若用户点了播放则等待完成后自动开始（保证首播即关键帧回放）。
  let precomputePollTimer = null

  const _pollPrecompute = () => {
    if (!blastingManager) return
    const ready = !!blastingManager.isBlastReplayReady?.()
    const prog = blastingManager.getReplayProgress?.() || { active: false, pct: 0 }
    replayReady.value = ready
    if (prog.active !== replayPrecompute.value.active || prog.pct !== replayPrecompute.value.pct) {
      replayPrecompute.value = { active: prog.active, pct: prog.pct }
    }
    if (ready) {
      if (pendingAutoStart) {
        pendingAutoStart = false
        startPlayback()
      }
      stopPrecomputeWatch()
    }
  }

  const startPrecomputeWatch = () => {
    stopPrecomputeWatch()
    if (!blastingManager) return
    const ready = !!blastingManager.isBlastReplayReady?.()
    replayReady.value = ready
    replayPrecompute.value = blastingManager.getReplayProgress?.() || { active: false, pct: 0 }
    if (!ready) {
      precomputePollTimer = setInterval(_pollPrecompute, 500)
    }
  }

  const stopPrecomputeWatch = () => {
    if (precomputePollTimer) {
      clearInterval(precomputePollTimer)
      precomputePollTimer = null
    }
  }

  // ─── 数据集应用 ─────────────────────────────────────
  const applyDataset = (nextDataset, options = {}) => {
    const autoPlay = Boolean(options?.autoPlay)
    pausePlayback()
    dataset.value = nextDataset
    currentFrame.value = 0
    blastingManager?.setDataset(nextDataset, {
      kcoOverride: {
        ...kcoParams.value,
        randomSeed: randomSeed.value
      }
    })
    blastingManager?.setFrame(0)
    // 数据加载后同步图层可见性与爆破设计数据
    syncLayerVisibility()
    // 监控全速预计算进度；就绪后若请求了自动播放则开始
    startPrecomputeWatch()
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
      //   001 达巴莱：K=150、α=1.7（估算 —— 文献未回归，取中等风化石灰岩典型量级）
      //   002 南山隧道：K=113.64、α=1.341（汪亚飞博士论文 图5-1/5-2，R²=0.6125）
      //   003 三棱山隧道：K=19.3、α=1.082（徐言 近场分段拟合精度95%；远场 K≈1.23、α=0.372）
      //   004 昆阳磷矿：K=90.63、α=1.58（王万禄等，据 M1~M3 三方向合成速度拟合；M4 异常剔除）
      //   其余事件（005~007 无振动场地回归）→ 重置默认 K=90、α=1.58，避免残留上一事件参数。
      // 判定按"事件ID 结尾匹配 / 名称含关键词"，保证任何加载路径都能命中，
      // 并显式同步 ref 与渲染层，避免面板仍显示默认 K=90/α=1.58。
      const _evId = String(eventId || '')
      const _evName = String(nextDataset.event?.name || '')
      if (_evId.endsWith('001') || _evName.includes('达巴莱')) {
        setSadoskyParams({ k: 150, alpha: 1.7 })
      } else if (_evId.endsWith('002') || _evName.includes('南山')) {
        setSadoskyParams({ k: 113.64, alpha: 1.341 })
      } else if (_evId.endsWith('003') || _evName.includes('三棱山')) {
        setSadoskyParams({ k: 19.3, alpha: 1.082 })
      } else if (_evId.endsWith('004') || _evName.includes('昆阳')) {
        setSadoskyParams({ k: 90.63, alpha: 1.58 })
      } else {
        setSadoskyParams({ k: 90, alpha: 1.58 })
      }
      applyDataset(nextDataset, { autoPlay })
      currentEventId.value = eventId
      // 建立实时推送通道（WS 不可用时降级到本地 setInterval 播放）
      connectBlastingWs(eventId)
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
    const stats = blastingManager?.getThreeStats?.() || {}

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

  // ─── Three.js 渲染管理 ─────────────────────────────

  const initBlastingManager = viewer => {
    if (!blastingManager && viewer) {
      blastingManager = new BlastingManager(viewer)
    }
  }

  const flyToCenter = () => {
    blastingManager?.flyToCenter()
  }

  // ─── 三维观察视角（内部 / 外部） ─────────────────────────
  // 'interior' = 隧道内部直面掌子面；'exterior' = 外部测区整体视角（见渲染器 setCameraViewMode）
  const cameraViewMode = ref('interior')
  const setCameraViewMode = mode => {
    if (mode !== 'interior' && mode !== 'exterior') return
    cameraViewMode.value = mode
    blastingManager?.setCameraViewMode(mode)
    showMessage(`已切换到${mode === 'interior' ? '隧道内部视角' : '外部测区视角'}`, 'info')
  }

  // ─── 爆堆轮廓（三维包络 + 安息角标注） ─────────────────────
  // 用于论文图3-4"碎片落地堆积形成的爆堆"：绘制爆堆半透明包络面、屋脊线、
  // 底部足迹框与安息角坡线。默认关闭，由预览面板按钮手动开启。
  const muckPileOutlineEnabled = ref(false)
  // 爆堆测量值（安息角 φ/堆高/堆宽/堆长），由渲染器节流更新
  const muckPileMeasure = ref(null)
  const toggleMuckPileOutline = () => {
    muckPileOutlineEnabled.value = !muckPileOutlineEnabled.value
    blastingManager?.setMuckPileOutlineEnabled?.(muckPileOutlineEnabled.value)
    if (muckPileOutlineEnabled.value) {
      const measure = blastingManager?.getMuckPileMeasure?.() ?? null
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

  // 爆堆轮廓开启期间持续回读测量值：渲染器在暂停/播放任意状态下都按帧重建
  // measure（renderFrame 内 _muckPileOutline.update() 每帧调用），UI 需独立轮询
  // 才能拿到最新数据，否则暂停后碎片已落地堆成、面板仍显示"等待落地堆积"。
  let muckPollTimer = null
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
  onScopeDispose(() => {
    if (muckPollTimer) {
      clearInterval(muckPollTimer)
      muckPollTimer = null
    }
  })

  // 重新触发 three.js 爆破效果
  // kcoOverride：可选，外部传入的 KCO 参数覆盖（用于 UI 实时编辑后重播）
  // KCO 参数（x50/n）已打通后端：由 /validate/kco 计算，后端不可用时回退本地计算。
  // 重播为异步：先请求后端再启动动画，用序号丢弃过期的并发请求结果。
  let replaySeq = 0
  const replayBlast = async kcoOverride => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    const seq = ++replaySeq
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
    if (seq !== replaySeq) return // 已有更新的重播请求，放弃本次结果
    if (backend) {
      // 显式注入后端计算的 x50/n；calculateKCOParams 优先使用显式值
      merged.x50 = backend.x50
      merged.n = backend.n
    } else {
      showMessage('后端 KCO 计算不可用，已使用本地计算', 'info')
    }
    blastingManager?.replayBlast(merged)
    // 重新预计算关键帧：重置就绪标志并重新监听（首个 step 到达前完成则直接就绪）
    startPrecomputeWatch()
    // 递增脏标记，使 threeStats 读取到新的 _fragmentStats
    statsVersion.value++
    // 重播后重新同步图层与设计数据
    syncLayerVisibility()

    // 完整重置播放状态：重置帧号 + 重置完成标志 + 重启播放
    // 不重连 WS：重连后端会重新推送振动场帧，与碎片动画 GPU 负载叠加导致卡顿。
    // 振动场数据在重新加载事件（loadDbEvent）时自动推送。
    wsBackendCompleted.value = false
    currentFrame.value = 0
    pausePlayback()
    startPlayback()

    showMessage('爆破效果已重播（KCO 模型）', 'success')
  }

  // 获取 three.js 渲染统计
  // 读取 statsVersion 建立响应式依赖，使 setFrame / replayBlast 后能自动刷新
  const threeStats = computed(() => {
    statsVersion.value // 建立响应式依赖
    return blastingManager?.getThreeStats() || null
  })

  // 块度分布统计（按 physSize 分组）：依赖 statsVersion 以便 replayBlast 后刷新
  const fragmentDistribution = computed(() => {
    statsVersion.value // 建立响应式依赖
    return blastingManager?.getFragmentDistribution?.() || null
  })

  // 高亮指定块度范围的碎片（FragmentDistribution 子组件以 { min, max } 对象形式 emit）
  const highlightFragmentsBySize = ({ min, max }) => {
    blastingManager?.highlightFragmentsBySize?.(Number(min), Number(max))
  }

  // 清除碎片高亮，恢复原始颜色
  const clearFragmentHighlight = () => {
    blastingManager?.clearFragmentHighlight?.()
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

  // ─── 振动场显示模式（PPV/应力/损伤 三模式切换）──────────────────
  // 与 blastVibrationFieldRenderer.DISPLAY_MODE 对应（字符串形式便于 UI）
  const VIBRATION_MODES = [
    // 注意：该模式渲染的是 t 时刻的瞬时质点振速 v(t)（波前到达→峰值→衰减回落），
    // 并非全程最大 PPV，故对外命名"瞬时振速"。内部字段/后端帧名沿用 ppv（其幅值即峰值）。
    { key: 'ppv', label: '瞬时振速', unit: 'cm/s' },
    { key: 'stress', label: 'σ_vm 应力', unit: 'MPa' },
    { key: 'damage', label: '损伤分区', unit: '' }
  ]
  const vibrationDisplayMode = ref('ppv')
  // 振动场元信息（gridShape/各场就绪状态/当前时间帧，由 WS 帧处理器刷新）
  const vibrationFieldInfo = ref(null)

  // 萨道夫斯基场地参数（K/α），可在振动场面板调节，经 WS 透传后端、同步本地模拟器
  const sadoskyParams = ref({ k: 30, alpha: 1.5 })

  // 振动场底材"白模"开关（true=场图层开启时岩体切白模底；false=保留岩石纹理底，
  // 热力色直接叠在岩色上，便于观察岩体纹理细节）。
  // 【默认 true】白模底用平滑法线 lambert 明暗 → 消除 flatShading 三角面高频明暗
  // 造成的"放射状细条纹/网格各向异性"伪影，热力色分级更干净。
  const whiteModelEnabled = ref(true)
  const setWhiteModelEnabled = enabled => {
    whiteModelEnabled.value = enabled === undefined ? !whiteModelEnabled.value : !!enabled
    blastingManager?.setWhiteModelEnabled?.(whiteModelEnabled.value)
  }

  // 半透明渲染（D：1=热力场上限 0.55 露出岩底轮廓，0=实色 0.85）
  const translucentEnabled = ref(false)
  const setTranslucentEnabled = enabled => {
    translucentEnabled.value = enabled === undefined ? !translucentEnabled.value : !!enabled
    blastingManager?.setVibrationTranslucent?.(translucentEnabled.value)
  }

  // 自动量程（色标满刻度跟随岩体代表性峰值）：供振动场图例实时显示当前 PPV/应力上限。
  // 依赖 sadoskyParams 与 dataset 建立响应式依赖，两者任一变（K/α 或事件切换）即重取。
  const fieldRange = computed(() => {
    sadoskyParams.value
    dataset.value
    return blastingManager?.getFieldRange?.() ?? null
  })

  // 等力线（等值线）叠加显示开关：默认关闭，避免正面近视角下
  // 几何折线叠加成规则斜纹；需要时仍可从面板手动开启。
  const isoLineEnabled = ref(false)
  const setIsoLineEnabled = enabled => {
    isoLineEnabled.value = enabled === undefined ? !isoLineEnabled.value : !!enabled
    blastingManager?.setIsoLineEnabled?.(isoLineEnabled.value)
  }

  // ─── 损伤边界（P0-1）────────────
  // 损伤半径由 PPV 阈值纯物理计算得出（见 computeMultiSourcePeakDamageZones），
  // 不设人工硬上限。influenceRadius：波场可达半径(m)——语义为"波传播到该半径外即衰减消失"，
  // 由岩体几何实测决定（manager.getInfluenceRadius()，见 sceneBuilder._syncInfluenceRadius），
  // 不再是 UI 可调项。这里只在发包时向 manager 取当前实测值，保证后端包络与渲染同口径。
  // 【实时生效】WS 推流中热更新后端场参数：后端重算包络/空腔掩码并推送校正帧，
  // 无需重启后端或重开推流
  const pushLiveFieldParams = () => {
    if (!(wsConnected.value && wsVibrationStarted && blastingWs)) return
    blastingWs.updateFieldParams?.({
      influenceRadius: blastingManager?.getInfluenceRadius?.() ?? 60
    })
  }

  // ─── 矢量箭头场（P1-6） ─────
  // 矢量箭头场：瞬时质点速度方向可视化（与热图同一物理模型逐帧计算），默认关
  const vectorFieldOn = ref(false)
  const setVectorFieldOn = on => {
    vectorFieldOn.value = on === undefined ? !vectorFieldOn.value : !!on
    blastingManager?.setVibrationVectorField?.(vectorFieldOn.value)
  }

  // 仿真 PPV 衰减 vs 萨道夫斯基公式对比（P2-8 验证，经由 blastingManager API）
  const ppvDecayData = computed(() => {
    if (!dataset.value) return null
    return blastingManager?.getPpvDecayData?.() ?? null
  })

  // 雷管起爆延期误差（蒙特卡洛） ─────────────────────────────
  // 使各段雷管起爆真实存在 ±σ ms 误差，干涉图案不再完美对称。
  const delayJitter = ref(
    Number(blastingManager?.getDelayJitter?.()) > 0 ? blastingManager.getDelayJitter() : 5
  )
  const setDelayJitter = ms => {
    const v = Math.max(0, Number(ms) || 0)
    delayJitter.value = v
    blastingManager?.setDelayJitter?.(v)
    refreshMonitorPoints()
  }

  // ─── 监测点（测点波形：Vx/Vy/Vz/Vmag 时程 + PPV） ─────────────
  const monitorPoints = ref([])
  const refreshMonitorPoints = () => {
    monitorPoints.value = blastingManager?.getMonitorPoints?.()?.slice() || []
  }
  const addMonitorPoint = (local, label) => {
    const mon = blastingManager?.addMonitorPoint?.(local, label)
    refreshMonitorPoints()
    return mon || null
  }
  const removeMonitorPoint = id => {
    blastingManager?.removeMonitorPoint?.(id)
    refreshMonitorPoints()
  }

  // 交互：'添加监测点' 后进入 3D 拾取模式，点击岩体连续布点；再次点击按钮/关闭停止
  const monitorPickActive = ref(false)
  let _monitorPickDetach = null
  const toggleMonitorPick = () => {
    if (monitorPickActive.value) {
      _monitorPickDetach?.()
      _monitorPickDetach = null
      monitorPickActive.value = false
      return
    }
    const detach = blastingSceneTools.pickRockPoint(local => {
      if (local && Number.isFinite(local.x)) {
        addMonitorPoint([local.x, local.y, local.z])
      }
    })
    _monitorPickDetach = detach
    monitorPickActive.value = true
  }

  // 热力图/等值线色彩标尺：0=线性，1=对数（默认。展开 PPV/应力幂律衰减的
  // 动态范围：线性标尺下近源挤成饱和红、远场糊成深蓝，对数把两端展开成连续梯度）
  const normMode = ref(1)
  const setVibrationNormMode = mode => {
    const v = Number(mode) > 0 ? 1 : 0
    normMode.value = v
    blastingManager?.setVibrationNormMode?.(v)
    refreshContourStatsSoon()
  }

  // 波包载波频率（Hz，0=关）：只改变热力图瞬时场的空间频率（干涉条纹疏密），
  // 不影响损伤分区/等值线的峰值判据。默认关闭，直接使用纯包络云图，
  // 避免正面近距离/掠射角下的相位条纹投影成规则纹路；需要行波环时可手动开启。
  const carrierHz = ref(0)
  const setVibrationCarrierHz = hz => {
    const v = Math.max(0, Math.min(30, Number(hz) || 0))
    carrierHz.value = v
    blastingManager?.setVibrationCarrierHz?.(v)
  }

  // 等值线密度（色带分档数，等值线条数 = density−1），变更后触发重提取
  const contourDensity = ref(12)
  const setVibrationContourDensity = d => {
    const v = Math.max(4, Math.min(24, Math.round(Number(d) || 12)))
    if (v === contourDensity.value) return
    contourDensity.value = v
    blastingManager?.setVibrationContourDensity?.(v)
    refreshContourStatsSoon()
  }

  // 最近一次等值线提取诊断（segments/loops/碎环过滤等，随振动场元信息一并刷新）
  const contourStats = ref(null)
  const refreshContourStats = () => {
    contourStats.value = blastingManager?.getVibrationContourStats?.() ?? null
  }
  // 密度/标尺变更触发异步重提取（Worker 计算峰值场），延迟回读一次诊断结果
  const refreshContourStatsSoon = () => {
    setTimeout(refreshContourStats, 800)
  }

  const setSadoskyParams = ({ k, alpha } = {}) => {
    const next = {
      k: Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : sadoskyParams.value.k,
      alpha:
        Number.isFinite(Number(alpha)) && Number(alpha) > 0
          ? Number(alpha)
          : sadoskyParams.value.alpha
    }
    sadoskyParams.value = next
    blastingManager?.setSadoskyParams(next)
    // WS 已连接且事件已加载时重启推送，使后端按新 K/α 重新计算 PPV 场
    if (blastingWs && wsConnected.value && dataset.value) {
      startBlastingWsStream(dataset.value)
    }
  }

  // 场点拾取：用户在场景中点击振动场内任意点，查询该点 PPV/应力/损伤
  const ppvPickEnabled = ref(false)
  const pickedPpv = ref(null)

  // 场点拾取全时程曲线（P1-6：点击岩体任一点 → Vx/Vy/Vz/Vmag 时程）。
  // 置于 pickedPpv 声明之后（避免 TDZ），命中场内点即异步计算全时程
  const pointHistory = ref(null)
  watch(
    pickedPpv,
    sample => {
      if (!sample || !sample.inside || !Array.isArray(sample.local)) {
        pointHistory.value = null
        return
      }
      pointHistory.value = blastingManager?.samplePointHistory?.(sample.local) ?? null
    },
    { immediate: true }
  )

  const togglePpvPick = enabled => {
    const next = enabled === undefined ? !ppvPickEnabled.value : !!enabled
    if (next) {
      blastingManager?.enablePpvPick(sample => {
        pickedPpv.value = sample
      })
    } else {
      blastingManager?.disablePpvPick()
      pickedPpv.value = null
    }
    ppvPickEnabled.value = next
  }

  const setVibrationDisplayMode = mode => {
    if (!VIBRATION_MODES.some(m => m.key === mode)) return
    vibrationDisplayMode.value = mode
    blastingManager?.setVibrationDisplayMode(mode)
    // 用户主动切换振动场模式时，自动开启振动场图层（默认关闭）。
    // 渲染器 _applyVibrationOcclusion 依赖 layerVisibility.vibrationField!==false，
    // 否则 uFieldWeight 恒为 0，岩体表面不会渲染热力图 → 此处显式开启。
    layerVisibility.value.vibrationField = true
    blastingManager?.setLayerVisible('vibrationField', true)
    // 切换后立即刷新一次元信息（hasField 依赖当前模式）
    vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
  }
  // 爆破设计数据（炮孔布置图 + 统计）
  const blastDesign = ref(null)

  const setLayerVisible = (layer, visible) => {
    layerVisibility.value[layer] = !!visible
    blastingManager?.setLayerVisible(layer, !!visible)
  }

  // 运行时更新断面参数 + cutPattern，并自动重播以重建布孔
  const updateSection = payload => {
    blastingManager?.updateSection(payload)
    replayBlast()
  }

  // 将 Vue 的图层可见性状态推送到渲染器（数据加载后调用，保持用户设置不被覆盖）
  const syncLayerVisibility = () => {
    // 推送当前 Vue 状态到渲染器，而非从渲染器回读
    const current = { ...layerVisibility.value }
    if (blastingManager) {
      blastingManager.setLayersVisible(current)
    }
    // 白模开关同样在场景重建后保持用户设置
    blastingManager?.setWhiteModelEnabled?.(whiteModelEnabled.value)
    // 等力线开关在场景重建后保持用户设置
    blastingManager?.setIsoLineEnabled?.(isoLineEnabled.value)
    // 标尺在材质重建（uniform 回默认值）后同样保持用户设置
    blastingManager?.setVibrationNormMode?.(normMode.value)
    // 载波频率同属材质 uniform，重建后一并重放
    blastingManager?.setVibrationCarrierHz?.(carrierHz.value)
    blastingManager?.setVibrationVectorField?.(vectorFieldOn.value)
    blastingManager?.setVibrationTranslucent?.(translucentEnabled.value)
    // 场景(重)建后：保持雷管误差设置、并同步监测点列表（与重建后的管理器状态一致）
    blastingManager?.setDelayJitter?.(delayJitter.value)
    refreshMonitorPoints()
    // 场景(重)建后立刻刷新振动场元信息，使"振动场"面板的模式按钮/就绪徽标
    // 无需等待播放帧或 WS 推送即可用（本地解析场三模式随时可切换）
    vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    blastDesign.value = blastingManager?.getBlastDesign?.() || null
    // 主动触发一次等值线构建（等值线不应依赖播放推进才可见——C 修复）
    blastingManager?.refreshContours?.()
  }

  return {
    dataset,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    setPlaybackRate,
    playbackRates: PLAYBACK_RATES,
    isLooping,
    abLoop,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // 关键帧回放就绪 / 全速预计算进度
    replayReady,
    replayPrecompute,
    previewMode,
    previewDisclaimer,
    // 实时推送连接状态
    wsConnected,
    // three.js 渲染
    threeStats,
    replayBlast,
    // 块度分布与高亮
    fragmentDistribution,
    highlightFragmentsBySize,
    clearFragmentHighlight,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    updateSection,
    syncLayerVisibility,
    // 振动场显示模式（PPV/应力/损伤）
    VIBRATION_MODES,
    vibrationDisplayMode,
    vibrationFieldInfo,
    setVibrationDisplayMode,
    // 萨道夫斯基场地参数（K/α）
    sadoskyParams,
    setSadoskyParams,
    // 自动量程（色标满刻度跟随岩体代表性峰值，供图例显示）
    fieldRange,
    // 振动场底材"白模"开关（场图层开启时是否切白模底）
    whiteModelEnabled,
    setWhiteModelEnabled,
    translucentEnabled,
    setTranslucentEnabled,
    isoLineEnabled,
    setIsoLineEnabled,
    // 色彩标尺 / 等值线密度 / 提取诊断
    normMode,
    setVibrationNormMode,
    carrierHz,
    setVibrationCarrierHz,
    contourDensity,
    setVibrationContourDensity,
    contourStats,
    // 矢量箭头场（P1-6）
    vectorFieldOn,
    setVectorFieldOn,
    // 仿真 PPV 衰减 vs 萨道夫斯基对比曲线（P2-8 验证）
    ppvDecayData,
    // 场点拾取全时程曲线（P1-6 点击出时程）
    pointHistory,
    // 雷管延期误差（蒙特卡洛）
    delayJitter,
    setDelayJitter,
    // 监测点（测点波时程曲线）
    monitorPoints,
    addMonitorPoint,
    removeMonitorPoint,
    monitorPickActive,
    toggleMonitorPick,
    // 场点拾取（查询空间任意点 PPV/应力/损伤）
    ppvPickEnabled,
    pickedPpv,
    togglePpvPick,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents,
    loadDbEvent,
    // SubTask 6.7：模拟结果保存
    saveSimulationResult,
    // 运行时统计随机种子（供 UI 展示或编辑）
    randomSeed,
    // 保存爆破设计（保存后自动重载）
    saveDesign,
    flyToCenter,
    cameraViewMode,
    setCameraViewMode,
    // 爆堆轮廓（三维包络 + 安息角标注）
    muckPileOutlineEnabled,
    muckPileMeasure,
    toggleMuckPileOutline,
    initBlastingManager,
    setFrame,
    togglePlayback,
    clearSimulation
  }
}
