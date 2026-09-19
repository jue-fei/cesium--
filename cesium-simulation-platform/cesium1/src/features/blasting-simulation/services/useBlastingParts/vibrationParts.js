import { computed, ref, watch } from 'vue'
import { LOCAL_SIM_DEFAULT_K, LOCAL_SIM_DEFAULT_ALPHA } from '../core/vibrationDefaults.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'

/**
 * 振动场与监测点域工厂（PPV/应力/损伤三模式 / 萨道夫斯基参数 / 色标与等值线 /
 * 监测点 / 场点拾取）
 *
 * 从 useBlasting() 拆出的"振动场·监测点"职责区：三场显示模式切换、白模/半透明/
 * 等力线/矢量场等渲染开关、K-α 场地参数、色标与等值线密度、雷管延期误差、
 * 监测点管理与 3D 拾取、场点拾取与全时程曲线。
 *
 * 状态归属：本域全部 ref（vibrationDisplayMode/vibrationFieldInfo/sadoskyParams/
 * monitorPoints 等）与拆分前一致，为 useBlasting() 函数内局部状态——工厂随
 * 每次 useBlasting() 调用重建，生命周期不变。pickedPpv 的 watch 亦随调用注册。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.ws.startBlastingWsStream （K/α 变更后重启推流使后端按新参数重算）
 * - ctx.render.layerVisibility （切换振动场模式时自动开启振动场图层）
 */
export function createVibrationParts(ctx) {
  const { dataset, wsConnected, getManager, getWs, getWsVibrationStarted } = ctx

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
  // 初始值与 LocalVibrationSimulator 默认同源（vibrationDefaults.js）
  const sadoskyParams = ref({ k: LOCAL_SIM_DEFAULT_K, alpha: LOCAL_SIM_DEFAULT_ALPHA })

  // 振动场底材"白模"开关（true=场图层开启时岩体切白模底；false=保留岩石纹理底，
  // 热力色直接叠在岩色上，便于观察岩体纹理细节）。
  // 【默认 true】白模底用平滑法线 lambert 明暗 → 消除 flatShading 三角面高频明暗
  // 造成的"放射状细条纹/网格各向异性"伪影，热力色分级更干净。
  const whiteModelEnabled = ref(true)
  const setWhiteModelEnabled = enabled => {
    whiteModelEnabled.value = enabled === undefined ? !whiteModelEnabled.value : !!enabled
    getManager()?.setWhiteModelEnabled?.(whiteModelEnabled.value)
  }

  // 半透明渲染（D：1=热力场上限 0.55 露出岩底轮廓，0=实色 0.85）
  const translucentEnabled = ref(false)
  const setTranslucentEnabled = enabled => {
    translucentEnabled.value = enabled === undefined ? !translucentEnabled.value : !!enabled
    getManager()?.setVibrationTranslucent?.(translucentEnabled.value)
  }

  // 自动量程（色标满刻度跟随岩体代表性峰值）：供振动场图例实时显示当前 PPV/应力上限。
  // 依赖 sadoskyParams 与 dataset 建立响应式依赖，两者任一变（K/α 或事件切换）即重取。
  const fieldRange = computed(() => {
    sadoskyParams.value
    dataset.value
    return getManager()?.getFieldRange?.() ?? null
  })

  // 等力线（等值线）叠加显示开关：默认关闭，避免正面近视角下
  // 几何折线叠加成规则斜纹；需要时仍可从面板手动开启。
  const isoLineEnabled = ref(false)
  const setIsoLineEnabled = enabled => {
    isoLineEnabled.value = enabled === undefined ? !isoLineEnabled.value : !!enabled
    getManager()?.setIsoLineEnabled?.(isoLineEnabled.value)
  }

  // ─── 损伤边界（P0-1）────────────
  // 损伤半径由 PPV 阈值纯物理计算得出（见 computeMultiSourcePeakDamageZones），
  // 不设人工硬上限。influenceRadius：波场可达半径(m)——语义为"波传播到该半径外即衰减消失"，
  // 由岩体几何实测决定（manager.getInfluenceRadius()，见 sceneBuilder._syncInfluenceRadius），
  // 不再是 UI 可调项。这里只在发包时向 manager 取当前实测值，保证后端包络与渲染同口径。
  // 【实时生效】WS 推流中热更新后端场参数：后端重算包络/空腔掩码并推送校正帧，
  // 无需重启后端或重开推流
  const pushLiveFieldParams = () => {
    if (!(wsConnected.value && getWsVibrationStarted() && getWs())) return
    getWs()?.updateFieldParams?.({
      influenceRadius: getManager()?.getInfluenceRadius?.() ?? 60
    })
  }

  // ─── 矢量箭头场（P1-6） ─────
  // 矢量箭头场：瞬时质点速度方向可视化（与热图同一物理模型逐帧计算），默认关
  const vectorFieldOn = ref(false)
  const setVectorFieldOn = on => {
    vectorFieldOn.value = on === undefined ? !vectorFieldOn.value : !!on
    getManager()?.setVibrationVectorField?.(vectorFieldOn.value)
  }

  // 仿真 PPV 衰减 vs 萨道夫斯基公式对比（P2-8 验证，经由 blastingManager API）
  const ppvDecayData = computed(() => {
    if (!dataset.value) return null
    return getManager()?.getPpvDecayData?.() ?? null
  })

  // 雷管起爆延期误差（蒙特卡洛） ─────────────────────────────
  // 使各段雷管起爆真实存在 ±σ ms 误差，干涉图案不再完美对称。
  const delayJitter = ref(
    Number(getManager()?.getDelayJitter?.()) > 0 ? getManager().getDelayJitter() : 5
  )
  const setDelayJitter = ms => {
    const v = Math.max(0, Number(ms) || 0)
    delayJitter.value = v
    getManager()?.setDelayJitter?.(v)
    refreshMonitorPoints()
  }

  // ─── 监测点（测点波形：Vx/Vy/Vz/Vmag 时程 + PPV） ─────────────
  const monitorPoints = ref([])
  const refreshMonitorPoints = () => {
    monitorPoints.value = getManager()?.getMonitorPoints?.()?.slice() || []
  }
  const addMonitorPoint = (local, label) => {
    const mon = getManager()?.addMonitorPoint?.(local, label)
    refreshMonitorPoints()
    return mon || null
  }
  const removeMonitorPoint = id => {
    getManager()?.removeMonitorPoint?.(id)
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
    getManager()?.setVibrationNormMode?.(v)
    refreshContourStatsSoon()
  }

  // 波包载波频率（Hz，0=关）：只改变热力图瞬时场的空间频率（干涉条纹疏密），
  // 不影响损伤分区/等值线的峰值判据。默认关闭，直接使用纯包络云图，
  // 避免正面近距离/掠射角下的相位条纹投影成规则纹路；需要行波环时可手动开启。
  const carrierHz = ref(0)
  const setVibrationCarrierHz = hz => {
    const v = Math.max(0, Math.min(30, Number(hz) || 0))
    carrierHz.value = v
    getManager()?.setVibrationCarrierHz?.(v)
  }

  // 等值线密度（色带分档数，等值线条数 = density−1），变更后触发重提取
  const contourDensity = ref(12)
  const setVibrationContourDensity = d => {
    const v = Math.max(4, Math.min(24, Math.round(Number(d) || 12)))
    if (v === contourDensity.value) return
    contourDensity.value = v
    getManager()?.setVibrationContourDensity?.(v)
    refreshContourStatsSoon()
  }

  // 最近一次等值线提取诊断（segments/loops/碎环过滤等，随振动场元信息一并刷新）
  const contourStats = ref(null)
  const refreshContourStats = () => {
    contourStats.value = getManager()?.getVibrationContourStats?.() ?? null
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
    getManager()?.setSadoskyParams(next)
    // WS 已连接且事件已加载时重启推送，使后端按新 K/α 重新计算 PPV 场
    if (getWs() && wsConnected.value && dataset.value) {
      ctx.ws.startBlastingWsStream(dataset.value)
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
      pointHistory.value = getManager()?.samplePointHistory?.(sample.local) ?? null
    },
    { immediate: true }
  )

  const togglePpvPick = enabled => {
    const next = enabled === undefined ? !ppvPickEnabled.value : !!enabled
    if (next) {
      getManager()?.enablePpvPick(sample => {
        pickedPpv.value = sample
      })
    } else {
      getManager()?.disablePpvPick()
      pickedPpv.value = null
    }
    ppvPickEnabled.value = next
  }

  const setVibrationDisplayMode = mode => {
    if (!VIBRATION_MODES.some(m => m.key === mode)) return
    vibrationDisplayMode.value = mode
    getManager()?.setVibrationDisplayMode(mode)
    // 用户主动切换振动场模式时，自动开启振动场图层（默认关闭）。
    // 渲染器 _applyVibrationOcclusion 依赖 layerVisibility.vibrationField!==false，
    // 否则 uFieldWeight 恒为 0，岩体表面不会渲染热力图 → 此处显式开启。
    ctx.render.layerVisibility.value.vibrationField = true
    getManager()?.setLayerVisible('vibrationField', true)
    // 切换后立即刷新一次元信息（hasField 依赖当前模式）
    vibrationFieldInfo.value = getManager()?.getVibrationFieldInfo?.() || null
  }

  return {
    VIBRATION_MODES,
    vibrationDisplayMode,
    vibrationFieldInfo,
    setVibrationDisplayMode,
    sadoskyParams,
    setSadoskyParams,
    fieldRange,
    whiteModelEnabled,
    setWhiteModelEnabled,
    translucentEnabled,
    setTranslucentEnabled,
    isoLineEnabled,
    setIsoLineEnabled,
    pushLiveFieldParams,
    vectorFieldOn,
    setVectorFieldOn,
    ppvDecayData,
    delayJitter,
    setDelayJitter,
    monitorPoints,
    refreshMonitorPoints,
    addMonitorPoint,
    removeMonitorPoint,
    monitorPickActive,
    toggleMonitorPick,
    normMode,
    setVibrationNormMode,
    carrierHz,
    setVibrationCarrierHz,
    contourDensity,
    setVibrationContourDensity,
    contourStats,
    ppvPickEnabled,
    pickedPpv,
    pointHistory,
    togglePpvPick
  }
}
