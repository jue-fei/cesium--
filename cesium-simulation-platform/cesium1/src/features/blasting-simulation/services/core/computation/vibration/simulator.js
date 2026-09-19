/**
 * 本地振动模拟器类（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * LocalVibrationSimulator：管理网格、逐帧三场更新（PPV/应力/损伤）与数据推送。
 */

import {
  LOCAL_SIM_DEFAULT_ALPHA,
  LOCAL_SIM_DEFAULT_K,
  NEAR_FIELD_GAIN,
  nearFieldRadius
} from './shared.js'
import { buildPpvGrid } from './grid.js'
import {
  computeMultiSourcePpvField3d,
  computePpvField3d,
  computeStressFieldFromPpv
} from './ppvField.js'
import { computeMultiSourcePeakDamageZones, computePeakDamageZones } from './damage.js'

/**
 * 本地振动模拟器类，管理网格、逐帧更新、数据推送
 */
export class LocalVibrationSimulator {
  /**
   * @param {Object} options - 模拟参数
   * @param {number} options.chargeKg - 总装药量(kg)
   * @param {number} options.tunnelWidth - 隧道宽度(m)
   * @param {number} options.tunnelHeight - 隧道总高度(m)
   * @param {number} [options.lengthZ=40] - 轴向长度(m)
   * @param {number} [options.nx=48] - X 网格数
   * @param {number} [options.ny=48] - Y 网格数
   * @param {number} [options.nz=72] - Z 网格数
   *
   *   分辨率说明（性能修复）：多装药源模式下，每帧需对 网格点数 × 源数 做同步
   *   矢量叠加。原默认 96×96×192=177 万点·源/帧，会把主线程阻塞到秒级（动画卡死）。
   *   现将默认降到 48×48×72=16.6 万点，且 (点,源) 的距离场由 _getDistCache 一次性
   *   预计算、之后逐时刻重算直接查表（省去每次 nS×nPts 次的 sqrt）。热力图是光滑场，
   *   该分辨率仍保留波场干涉形态，而每次全量重算耗时约降到原来的 1/5~1/7。
   * @param {number} [options.K=30] - 萨道夫斯基 K（已针对隧道尺度可视化校准，见下方说明）
   * @param {number} [options.alpha=1.5] - 萨道夫斯基 alpha
   * @param {number} [options.beta=0.02] - 阻尼系数
   * @param {number} [options.cp=4500] - 纵波速度
   * @param {number} [options.rho=2650] - 岩体密度
   * @param {number} [options.nu=0.25] - 泊松比
   * @param {number[]} [options.origin] - 爆心在网格局部坐标系中的坐标 [x,y,z]（如掏槽孔质心
   *                [x, y, faceOffset]），缺省 [0,0,0]
   */
  constructor(options) {
    this.chargeKg = options.chargeKg ?? 100
    this.tunnelWidth = options.tunnelWidth ?? 18
    this.tunnelHeight = options.tunnelHeight ?? 15
    this.lengthZ = options.lengthZ ?? 40
    this.nx = options.nx ?? 48
    this.ny = options.ny ?? 48
    this.nz = options.nz ?? 72
    // 爆心（网格局部坐标，缺省网格原点）——应力波/损伤从实际爆破位置（掏槽孔质心）扩散
    this._origin = Array.isArray(options.origin) ? options.origin.map(Number) : null
    // 多装药源：由实际炮孔布孔（楔形掏槽等）推算的装药源列表 [{x,y,z,chargeKg,delayMs}]。
    // 提供时启用多源矢量叠加（多应力波干涉波场）；为空则退化为单源（原行为）。
    this._sources = Array.isArray(options.sources) ? options.sources : null
    // 显式边界（与 WS 网格对齐时传入；null 则按隧道尺寸推导对称边界）
    this._explicitBounds =
      options.boundsMin && options.boundsMax
        ? { boundsMin: options.boundsMin, boundsMax: options.boundsMax }
        : null

    // 岩体与萨道夫斯基参数
    // K 默认取 30（而非工程常用 200）：本体积盒尺度为隧道局部（宽度≤18m、纵深≤40m），
    // 若 K=200，按 Q=100kg 计算即使盒最远角（≈42m）PPV 仍约 22 cm/s，远超 PPV 色阶上限
    // 15 cm/s，导致整个体积盒饱和成一片红（用户看到的"红色方形"），应力/损伤也被淹没。
    // K=30 时近爆心 PPV 仍达数十 cm/s（破碎/抛掷区，红），远场衰减至 ~1 cm/s（蓝），
    // 呈现"近红→中绿→远蓝"的球面梯度，使 PPV/应力/损伤三模式均能正确分级显示。
    this.params = {
      K: options.K ?? LOCAL_SIM_DEFAULT_K,
      alpha: options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA,
      beta: options.beta ?? 0.02,
      visualBeta: options.visualBeta ?? 0.8, // 可视化时变衰减（波峰回落实时速度）
      cp: options.cp ?? 4500,
      visualCp: options.visualCp ?? 35, // 波前可视传播速度（见 computePpvField3d 注释）
      // 瞬时振速为多源矢量叠加的平滑衰减包络：物理干涉由各炮孔延期差+路径差
      // （相位差）本身产生，不叠加任何人工 cos 载波（载波伪影已废弃）。
      // 空间门控（与后端 influence_radius 同口径）：峰值场 × env(influenceRadius)
      // （tau=3m）。由 blastingManager 按岩体几何实测透传，缺省 0=关。
      influenceRadius: Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0,
      // 隧道马蹄形轮廓自由面放大配置（与 GPU uFaceBoost 同口径；null=关）
      tunnelFace: options.tunnelFace || null,
      rho: options.rho ?? 2650,
      nu: options.nu ?? 0.25,
      minStandoff: 0.5,
      // 近场几何修正（应力场专用，见模块头 NEAR_FIELD_* 注释）：
      // 交叉半径缺省由装药量反算（r_nf = MULT × 空腔半径），可被外部覆盖。
      nearFieldRadius:
        Number(options.nearFieldRadius) > 0
          ? Number(options.nearFieldRadius)
          : nearFieldRadius(options.chargeKg ?? 100),
      nearFieldGain:
        Number(options.nearFieldGain) > 0 ? Number(options.nearFieldGain) : NEAR_FIELD_GAIN,
      // 爆心（掏槽孔质心）；computePpvField3d / computePeakDamageZones 均以该点为波源
      origin: this._origin,
      // 多装药源：提供时 computeAtTime 走多源矢量叠加（多应力波干涉波场）
      sources: this._sources,
      // 自由面反射（镜象源法）：掌子面/临空面自由边界对波场的反射参与计算。
      // 默认按"爆心所在掌子面"近似：反射面 z = origin.z（掌子面轴向位置）。
      reflections:
        Array.isArray(options.reflections) && options.reflections.length
          ? options.reflections
          : this._origin
            ? [{ axis: 'z', value: Number(this._origin[2]) || 0, coeff: 0.85 }]
            : null
    }

    // 预计算网格
    const grid = buildPpvGrid(
      this.tunnelWidth,
      this.tunnelHeight,
      this.lengthZ,
      this.nx,
      this.ny,
      this.nz,
      this._explicitBounds
    )
    this.gridXyz = grid.gridXyz
    this.gridShape = grid.gridShape
    this.boundsMin = grid.boundsMin
    this.boundsMax = grid.boundsMax

    // 缓存上一帧计算结果
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
    this._cachedZones = null

    // 预分配输出缓冲区（computeAtTime 每帧调用，避免 new Float32Array(65536)×2 + Int8Array(65536) 导致 GC 压力）
    const nPoints = this.nx * this.ny * this.nz
    this._ppvBuf = new Float32Array(nPoints)
    this._peakBuf = new Float32Array(nPoints)
    this._sigmaBuf = new Float32Array(nPoints)
    this._zoneBuf = new Int8Array(nPoints)
    // 各网格点到爆心的距离(m)：应力近场几何修正用。网格与爆心在整个生命周期内
    // 不变 → 预计算一次，避免每帧再算一遍 O(N) 开方。
    const origin = this._origin
    const ox = origin ? Number(origin[0]) || 0 : 0
    const oy = origin ? Number(origin[1]) || 0 : 0
    const oz = origin ? Number(origin[2]) || 0 : 0
    this._gridR = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      const dx = this.gridXyz[i * 3] - ox
      const dy = this.gridXyz[i * 3 + 1] - oy
      const dz = this.gridXyz[i * 3 + 2] - oz
      this._gridR[i] = Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }

  /** 获取网格信息（供渲染器初始化） */
  getGridInfo() {
    return {
      gridShape: this.gridShape,
      boundsMin: this.boundsMin,
      boundsMax: this.boundsMax
    }
  }

  /**
   * 计算指定时刻的三场数据（PPV/应力/损伤）
   * @param {number} t - 模拟时间(s)
   * @returns {Object} { ppv: Float32Array, sigmaVm: Float32Array, zones: Int8Array }
   *          输出已按 WebGL 轴序（x-最快）排列，可直接传给 blastVibrationFieldRenderer
   *
   * 轴序说明：buildPpvGrid 生成的 gridXyz 已是 x-最快（zi 最外层、xi 最内层，
   * idx = zi*ny*nx + yi*nx + xi），computePpvField3d / computeStressFieldFromPpv /
   * classifyDamageZones 均逐点保持该顺序。该顺序与后端 pack_ppv_binary 中
   * np.transpose(2,1,0) 后的 WebGL 布局完全一致，无需再做轴序重排
   * （任何按 x-最慢假设的二次转置都会导致数据错乱）。
   */
  computeAtTime(t) {
    // 全量计算（增量优化意义不大，网格不大，直接计算可保证精度）
    // 复用预分配缓冲区，避免每帧 576KB 临时数组分配导致 GC 压力
    const multi = Array.isArray(this.params.sources) && this.params.sources.length > 0
    const ppv = multi
      ? computeMultiSourcePpvField3d(this.gridXyz, t, this.params, this._ppvBuf)
      : computePpvField3d(this.gridXyz, this.chargeKg, t, this.params, this._ppvBuf)
    // 应力场由**瞬时振速**反演 + 近场几何修正 F(r)——与 GPU shader 解析支
    // （mps × stressFactor × F(r)）同口径，保证波前/梯度清晰可见。
    // 【勿改回峰值包络】峰值场是静态云图，会丢失波前时间结构
    // （用户实测："巨大的黄色高斯云，缺乏波场结构"）。
    // 与振速场的区别来自近场项 F(r)（局部、温和）+ 独立标定的满量程
    // （σ_ref 锚在场最大值，见 blastingManager._computeAutoFieldRefs）。
    const sigmaVm = computeStressFieldFromPpv(ppv, this.params, this._sigmaBuf, this._gridR)
    // 损伤分区：按"波峰几何峰值 × 波前到达门控"（computePeakDamageZones / 多源版）——
    // 确定性算法，与播放方向无关：正放/回拉/拖进度条同一时刻结果一致，
    // 波前到达处显示常驻五色分区、未到达处 0（修复回拉进度条时序错乱）。
    const zones = multi
      ? computeMultiSourcePeakDamageZones(this.gridXyz, t, this.params, this._zoneBuf)
      : computePeakDamageZones(this.gridXyz, this.chargeKg, t, this.params, this._zoneBuf)

    this._lastT = t
    this._cachedPpv = ppv
    this._cachedSigmaVm = sigmaVm
    this._cachedZones = zones

    return { ppv, sigmaVm, zones }
  }

  /**
   * 重设多装药源（切换爆破事件/炮孔布孔时调用）。
   * 更新 params.sources 并使下一帧重算（清除缓存）。
   * 传入空数组/null 则退化为单源模式。
   * @param {Array|null} sources - [{x,y,z,chargeKg,delayMs}]
   */
  setSources(sources) {
    this._sources = Array.isArray(sources) && sources.length > 0 ? sources : null
    this.params.sources = this._sources
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
  }

  /** 是否已初始化 */
  get isReady() {
    return !!this.gridXyz && this.gridXyz.length > 0
  }
}
