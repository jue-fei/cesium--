/**
 * 碎片规格生成器
 *
 * 给定 KCO 模型输出、掌子面几何描述和爆破参数，生成完整的 FragmentSpec 数组。
 * 核心改进：碎片位置采样在掌子面表面上（而非后方随机），实现"面破碎为碎片"。
 *
 * 每个 FragmentSpec 包含：
 * - 物理属性：physSize, density, restitution, friction, maxBounces
 * - 渲染属性：dispSize, color, variantIndex
 * - 不含位置/速度（由调用方传入 PhysicsEngine）
 *
 * 主流程 generateFragmentSpecs 为编排器，按阶段顺序调用文件内私有函数：
 *   数量预算 → 速度模型 → 逐孔分配规划 → 统一生成循环 → 抛掷校准
 *   → 体积还原 → 渲染归一化/位置收拢 → 统计直方图
 */

import {
  sampleSwebrecSize,
  sampleSwebrecMassWeighted,
  generateSwebrecHistogram,
  binHistogram,
  computeKLDivergence,
  EXPLOSIVE_TYPES
} from '../computation/kcoModelCore.js'
import {
  makeRng,
  selectVariantBySize,
  getRockVariantMaxRadius,
  getRockVariantUnitVolumes
} from './rockGeometryFactory.js'
import {
  DEFAULT_RESTITUTION,
  DEFAULT_FRICTION,
  DEFAULT_MAX_BOUNCES,
  ENHANCED_RESTITUTION,
  ENHANCED_FRICTION,
  ENHANCED_MAX_BOUNCES
} from '../blastDefaults.js'

// 诊断日志开关：生产环境关闭，避免每次生成碎片都打印诊断信息
const DEBUG_FRAGMENT_SPECS = false

// ─── 孔型权重（工程经验值）───
// cut: 掏槽孔夹制作用强，速度高、破碎充分（粒径小）
// auxiliary: 辅助孔基准
// perimeter: 周边孔低损伤控制爆破，速度低、大块多
// empty: 空孔仅提供自由面，不装药不生成碎石
export const HOLE_TYPE_WEIGHTS = {
  cut: { velocityFactor: 1.25, axialBias: 0.15, sizeFactor: 0.85 },
  auxiliary: { velocityFactor: 1.0, axialBias: 0.0, sizeFactor: 1.0 },
  perimeter: { velocityFactor: 0.8, axialBias: -0.1, sizeFactor: 1.15 },
  empty: { velocityFactor: 0, axialBias: 0, sizeFactor: 0 }
}

// 初始破碎扩散半径：从孔心附近做高斯采样生成碎石头起始位置。
// 旧值 σ=0.35m 偏小，破碎区呈"孔状斑块"、断面边缘与孔间空隙覆盖偏稀；放大到 0.45m
// 并随装药量平缓过渡，使破碎带覆盖更接近真实"沿孔周形成的连续破碎带"。
const HOLE_SIGMA_BASE = 0.45 // 基准σ(m)，装药量=平均时的扩散半径
const HOLE_SIGMA_RATIO_MIN = 0.7 // 最小σ倍数（小装药孔扩散收窄）
const HOLE_SIGMA_RATIO_MAX = 1.6 // 最大σ倍数（大装药孔扩散放宽）

// ─── 延时场耦合参数 ───
// 后序孔因前序孔形成新自由面，块度更细、方向偏向已形成自由面（轴向）
const DELAY_SIZE_DECAY = 0.04 // 每序块度衰减系数
const DELAY_SIZE_FLOOR = 0.8 // 块度衰减下限
const DELAY_DIR_BIAS_PER_ORDER = (5 * Math.PI) / 180 // 每序方向偏移 5°（弧度）
const DELAY_DIR_BIAS_MAX = (20 * Math.PI) / 180 // 方向偏移上限 20°（弧度）

// ─── 数量预算参数 ───
// 最少碎片数下限：无论质量/目标数如何折算，渲染至少生成该数量的碎片（视觉兜底）
const MIN_FRAGMENT_COUNT = 40
// n 因子：块度均匀性对碎片数的调节。n=1.2（Swebrec 常见值）为基准不增不减；
// 块度更均匀（n<1.2）减少碎片数、更分散（n>1.2）增加碎片数，增益 0.5 为工程调参
const N_FACTOR_REFERENCE = 1.2
const N_FACTOR_GAIN = 0.5
// 数量混合权重：质量驱动数量（可见方量/平均单块质量）与"目标数×n 因子"的凸组合
// （工程调参，无理论依据）
const COUNT_BLEND_MASS_WEIGHT = 0.65
const COUNT_BLEND_TARGET_WEIGHT = 0.35

// ─── 岩石密度参数 ───
// 花岗岩典型密度（kg/m³），metrics.rockDensityKgM3 缺省值
const TYPICAL_ROCK_DENSITY_KG_M3 = 2650
// 岩体密度下限（kg/m³）：低于该值视为异常输入，夹紧到该下限
const ROCK_DENSITY_FLOOR_KG_M3 = 2200
// 单块密度采样：围绕基准密度的随机涨落区间 [0.94, 1.06]（工程经验值，模拟岩体非均质）
const DENSITY_VARIATION_BASE = 0.94
const DENSITY_VARIATION_RANGE = 0.12

// ─── 速度模型参数 ───
// Persson(1997) 能量耦合系数缺省值：炸药能量转化为碎片动能的比例（UI 可经 metrics.eta 覆盖）
const PERSSON_ETA_DEFAULT = 0.15
// 经验拟合 fallback：vBase = 6 + √Q×0.3（加性常数与系数无物理依据，
// 量级吻合隧道爆破抛掷速度 5-30 m/s）
const EMPIRICAL_V_BASE = 6
const EMPIRICAL_V_SQRT_COEF = 0.3
// 重力加速度（m/s²）：抛距估算 d ≈ v²/g 与滞空时间求解共用
const GRAVITY_ACCELERATION = 9.8

// ─── 抛掷校准参数（仅 metrics.enableVelocityCalibration=true 时生效）───
// avg/max 两路缩放系数的凸组合权重（工程调参，无理论依据）
const THROW_BLEND_AVG_WEIGHT = 0.65
const THROW_BLEND_MAX_WEIGHT = 0.35
// 缩放死区：|scale-1| 小于该值不施加校准（避免微缩放无谓扰动速度场）
const THROW_SCALE_DEADBAND = 0.03
// 参与校准计算的最小抛距门槛（m）：低于该值认为统计不可靠，跳过对应缩放
const THROW_MIN_DISTANCE_M = 0.1

// ─── 崩落体积还原参数 ───
// 球体积系数：V = (π/6)·d³（碎片物理体积按等直径球折算）
const SPHERE_VOLUME_COEFF = Math.PI / 6
// 体积还原系数夹紧区间 [1, 3.5]：k<1 时无需缩小（已超体积，保持原状避免离谱）；
// k>3.5 时碎片过于夸大（>3.5m）会失真，此时由数量兜底，而非单颗无限放大（工程调参）
const VOLUME_RESTORE_SCALE_MIN = 1
const VOLUME_RESTORE_SCALE_MAX = 3.5
// 松散爆堆碎胀系数缺省值：坚硬岩石文献常见 1.4~1.6，取 1.5（UI 可经 metrics.bulkFactor 覆盖）
const DEFAULT_BULK_FACTOR = 1.5

// ─── 渲染归一化参数 ───
// 显示尺寸可见下限（m）：小于该值的碎片做温和视觉补偿（sqrt 渐变），避免不可见
const DISPLAY_VISIBLE_FLOOR_M = 0.08
// 几何填充率修正的 dispSize 缩放夹紧 [0.5, 1.4]：避免极小/极大填充几何被
// 异常放大或缩到离谱（保留形态不致失真，工程调参）
const DISP_FILL_FACTOR_MIN = 0.5
const DISP_FILL_FACTOR_MAX = 1.4

// ─── 统计直方图参数 ───
const SIZE_BIN_COUNT = 20 // 块度直方图分箱数
const VELOCITY_BIN_COUNT = 20 // 速度直方图分箱数

// ─── 可见质量分数经验公式常量 ───
// visibleMassFraction = 0.45 + 装药项 + 比装药项 + 抛距项，夹紧到 [0.5, 0.97]。
// 真实全断面掌子面爆破接近整断面破碎，可见比例应尽量高（0.5~0.97），
// 配合体积还原使碎石量与爆堆饱满；各项系数与上限均为工程调参，无理论依据。
const VISIBLE_MASS_FRACTION_BASE = 0.45
const VISIBLE_MASS_FRACTION_MIN = 0.5
const VISIBLE_MASS_FRACTION_MAX = 0.97
// 装药量项：min(0.2, √Q × 0.0085)
const VISIBLE_MASS_CHARGE_CAP = 0.2
const VISIBLE_MASS_CHARGE_COEF = 0.0085
// 比装药项：min(0.15, q × 0.12)
const VISIBLE_MASS_SPECIFIC_CAP = 0.15
const VISIBLE_MASS_SPECIFIC_COEF = 0.12
// 抛距项：min(0.12, d_avg × 0.008)
const VISIBLE_MASS_THROW_CAP = 0.12
const VISIBLE_MASS_THROW_COEF = 0.008

// ─── 平均单块质量估算参数 ───
// 蒙特卡洛采样数：估算 Swebrec 分布的平均单块质量（数量-质量混合预算用）
const MEAN_MASS_SAMPLE_COUNT = 96

// ─── 逐孔装药驱动的局部速度参数 ───
// vBase_hole = vBase × (holeCharge/avgCharge)^0.4 × 孔型速度系数；
// 装药比夹紧 [0.3, 2.5]：抑制极端孔（过小装药不至于停滞、过大装药不至于爆表）
const CHARGE_RATIO_EXPONENT = 0.4
const CHARGE_RATIO_MIN = 0.3
const CHARGE_RATIO_MAX = 2.5

// ─── 发射运动学常量（来源标注：文献/标定/经验值）───
// 隧道掌子面爆破的抛掷几何：自由面只在"已开挖的隧道空腔"这条唯一的轴向开口上，
// 因此碎片应当沿隧道轴向（往开挖侧空腔）以窄锥角抛出，仰角平缓（不能对空腔拱顶过冲）。
// 旧参数（45° 基角 + 未加权的竖向 sin 分量可达 71% 速度 + 横向 ±60° 散射）会让碎片
// 大面积冲向拱顶/侧墙，再被高速弹回，视觉上表现为"抛掷方向紊乱"。此处重调为：
const BASE_LAUNCH_ANGLE = Math.PI * 0.09 // ≈16°：平缓抛射角，沿隧道轴向向前下方滑翔落地
const ANGLE_BIAS_LIMIT = 0.5 // 大/小块抛角偏差上限 rad（工程经验值，未标定）
const SIZE_RATIO_REF = 0.5 // sizeRatio 基准点：physSize=x50 时 angleBias=0（工程经验值）
const ANGLE_JITTER = Math.PI * 0.05 // ≈±9° 随机扰动（工程经验值，未标定）
const LAUNCH_ANGLE_MIN = 0.02 // ~1.2° 下限，几乎水平抛出，避免竖向贴地
const LAUNCH_ANGLE_MAX = Math.PI * 0.17 // ≈30° 上限，防碎片过冲拱顶
const AZIMUTH_SPREAD = Math.PI * 0.11 // ≈±20° 窄锥形扩散，贴合隧道轴向自由面（工程经验值）
const V_VARIATION_BASE = 0.75 // 速度随机下界（工程经验值，未标定）
const V_VARIATION_RANGE = 0.5 // 速度随机范围 → [0.75, 1.25]（工程经验值）
const AXIAL_WEIGHT = 1.0 // 轴向分量权重：掌子面法向（轴向）主导抛掷
const LATERAL_WEIGHT = 0.35 // 横向分量权重：大幅收窄，避免侧散撞墙（工程经验值，未标定）
const VERTICAL_WEIGHT = 0.75 // 竖向分量权重：抑制对拱顶过冲（工程经验值，未标定）
const MAX_SIZE_FACTOR = 2.2 // 小碎片速度上限倍数：vBase × 2.2（旧值 3.0 使细小碎片抛距过远）
const MIN_LAUNCH_SPEED = 0.5 // 最小发射速度（m/s），防止碎片静止

// ─── 断面内缩系数（本文件专用的"比例内缩"口径）───
// ⚠️ 与 computation/sectionShape.js 的 isInsideSection 语义不同，刻意不合并：
//   - isInsideSection：精确边界 + 绝对 margin 内缩（供炮孔布置等几何约束使用）；
//   - 本文件：按断面特征尺寸做"比例内缩"，为碎片采样/收拢预留边缘缓冲，
//     避免碎片中心贴在断面边界上导致半颗嵌入围岩。二者口径与用途不同，勿合并。
const FACE_INNER_SHRINK_RATIO = 0.98 // 碎片采样点内缩判定：边界按特征尺寸的 98%
const CLAMP_INNER_SHRINK_RATIO = 0.97 // 碎片位置收拢：断面内边界按特征尺寸的 97% 内缩

/**
 * @typedef {Object} FragmentSpec
 * @property {number} physSize - 真实物理直径(m)
 * @property {number} dispSize - 显示缩放尺寸
 * @property {number} density - 岩石密度(kg/m³)
 * @property {number} restitution - 弹性恢复系数
 * @property {number} friction - 表面摩擦系数
 * @property {number} maxBounces - 最大反弹次数
 * @property {number} variantIndex - 几何体变体索引(0-14，5种形态×3子变体)
 * @property {{r:number,g:number,b:number}} color - 岩石颜色
 */

/**
 * @typedef {Object} FaceGeometry
 * @property {number} cx/cy/cz - 掌子面中心世界坐标
 * @property {number} nx/ny/nz - 掌子面法线（指向岩体内部）
 * @property {number} rx/ry/rz - 横向方向（面内右侧）
 * @property {number} ux/uy/uz - 竖向方向（面内上方）
 * @property {number} width - 隧道宽度
 * @property {number} wallHeight - 直墙高度
 * @property {number} archRadius - 拱顶半径
 * @property {string} shape - 断面形状 'horseshoe'|'circular'|'rectangular'
 */

/**
 * 生成碎片规格数组（编排器：按阶段顺序调用文件内私有函数，参数逐段传递）
 * @param {Object} options
 * @param {{x50:number,xmax:number,b:number,n:number,A:number}} options.kco - KCO 模型输出
 * @param {FaceGeometry} options.face - 掌子面几何描述
 * @param {number} options.chargeKg - 总装药量(kg)
 * @param {number} options.targetCount - 目标碎片数量
 * @param {Array<Object>} [options.holes] - 数据库炮孔设计数据（可选）：
 *   每孔 { x, y, chargeKg, delayMs, holeType, isEmpty }
 *   x/y 为断面内局部坐标（x 横向，y 高度，原点为断面中心）
 *   提供时按 chargeKg 比例分配碎片数，位置从孔附近高斯采样，速度受孔 chargeKg 影响，
 *   delayMs 转换为 delayTime（秒）写入 spec，由物理引擎实现分段起爆
 * @returns {{ specs: FragmentSpec[], positions: Array<{x:number,y:number,z:number}>, velocities: Array<{x:number,y:number,z:number}> }}
 */
export function generateFragmentSpecs(options = {}) {
  const {
    kco,
    face,
    chargeKg = 320,
    targetCount = 200,
    countLimit = 320,
    holes,
    metrics = {},
    randomSeed = 42 + Math.floor(Math.random() * 1000)
  } = options
  // 创建确定性伪随机数生成器，使同一种子+同一参数可完全复现
  const rng = makeRng(randomSeed)
  if (!kco || !face) {
    throw new Error('[FragmentSpecGenerator] 缺少必要参数 kco 或 face')
  }

  // 阶段 1：数量预算（质量驱动 + n 因子混合，含碎石量诊断日志）。
  // ⚠️ 消费 rng（平均单块质量蒙特卡洛估算），必须最先调用，保证随机数消耗顺序不变。
  const budget = _budgetFragmentCount({ kco, chargeKg, targetCount, countLimit, metrics, rng })

  // 阶段 2：速度基准模型（Persson 物理 / 经验拟合 fallback）
  const { vBase, velocityModel } = _computeVelocities({
    chargeKg,
    densityBase: budget.densityBase,
    metrics
  })

  // 阶段 3：逐孔分配规划（纯计算，不消费随机数）
  const plan = _assignByHoles({ holes, count: budget.count, chargeKg })

  // 阶段 4：统一碎片生成循环（经典/孔驱动双模式参数化合并，rng 消耗顺序不变）
  const { specs, positions, velocities, holeGroups, generatedMassKg } = _generateFragments({
    face,
    kco,
    budget,
    plan,
    chargeKg,
    vBase,
    velocityScale: budget.velocityScale,
    rng
  })

  // 阶段 5：抛掷校准 — 默认关闭（保留物理速度场），仅当 metrics.enableVelocityCalibration=true 时启用
  //
  // 校准原理：v² ∝ d（抛距），故 v_new = v_old·√(d_target/d_actual)
  // 已知缺陷：校准后速度场失去原始物理含义，属"凑结果"非物理推导
  // 0.65/0.35 加权混合均为工程调参，无理论依据
  const enableCalibration = metrics.enableVelocityCalibration === true
  const velocityStats = _calibrateVelocitiesToThrowTargets({
    velocities,
    positions,
    floorY: Number(face.floorY) || 0,
    targetAvg: enableCalibration ? Number(metrics.throwDistanceTargetAvg) || null : null,
    targetMax: enableCalibration ? Number(metrics.throwDistanceTargetMax) || null : null
  })

  // 阶段 6：崩落体积还原（代表性碎岩）
  const restore = _restoreVolume({
    specs,
    metrics,
    visibleMassFraction: budget.visibleMassFraction,
    generatedMassKg
  })

  // 阶段 7：渲染尺寸归一化 + 初始位置推出/收进断面/孔内错开
  _normalizeDisplaySizes(specs)
  _settleFragmentPositions({ face, specs, positions, holeGroups, rng })

  // 阶段 8：统计直方图（块度/速度分布闭合诊断与质量放大系数）
  const stats = _computeStats({
    specs,
    velocities,
    metrics,
    kco,
    targetVisibleMassKg: budget.targetVisibleMassKg,
    generatedMassKg
  })

  return {
    specs,
    positions,
    velocities,
    meta: {
      velocityModel, // 'empirical' | 'persson1997'
      velocityCalibrated: enableCalibration, // 是否启用事后校准
      velocityScaleApplied: velocityStats.velocityScaleApplied
    },
    stats: {
      fragmentCountTarget: budget.requestedCount,
      fragmentCountGenerated: specs.length,
      fragmentMassTargetKg: budget.targetVisibleMassKg || generatedMassKg, // 可见方量目标
      fragmentMassGeneratedKg: generatedMassKg, // 实际生成碎片总质量（未放大，与区间质量求和自洽）
      fragmentMassBlastedKg: stats.scaledMassKg, // 方量估计（按 massScaleFactor 放大，反映爆破方量）
      fragmentMassCoverage:
        budget.targetVisibleMassKg > 0
          ? generatedMassKg / Math.max(1, budget.targetVisibleMassKg)
          : 1,
      blastVolumeM3: Number(metrics.volumeRoundM3) > 0 ? Number(metrics.volumeRoundM3) : null,
      visibleMassFraction: budget.visibleMassFraction,
      bulkFactor: restore.bulkFactor,
      volumeRestoreScale: restore.volumeRestoreScale,
      representativeVolumeM3: restore.representativeVolumeM3,
      representativeMassKg: restore.representativeMassKg,
      estimatedMeanMassKg: budget.estimatedMeanMassKg,
      velocityMean: velocityStats.velocityMean,
      velocityP95: velocityStats.velocityP95,
      throwDistancePredictedAvg: velocityStats.throwDistanceAvg,
      throwDistancePredictedMax: velocityStats.throwDistanceMax,
      throwDistanceTargetAvg: Number(metrics.throwDistanceTargetAvg) || null,
      throwDistanceTargetMax: Number(metrics.throwDistanceTargetMax) || null,
      velocityScaleApplied: velocityStats.velocityScaleApplied,
      sizeHistogramGenerated: stats.sizeHistogramGenerated,
      sizeHistogramTarget: stats.sizeHistogramTarget,
      sizeKLDivergence: stats.sizeKLDivergence,
      velocityHistogramGenerated: stats.velocityHistogramGenerated
    }
  }
}

/**
 * 阶段 1：数量预算。
 *
 * 估算本次应生成的碎片数量：质量驱动数量（可见方量 / 平均单块质量，需消耗
 * MEAN_MASS_SAMPLE_COUNT 次随机采样估算均值）与"目标数 × n 因子"按
 * COUNT_BLEND_MASS_WEIGHT / COUNT_BLEND_TARGET_WEIGHT 凸混合，再夹紧到
 * [MIN_FRAGMENT_COUNT, countLimit]。
 * 同时产出后续阶段共用的派生上下文（安全粒径、密度基准、速度缩放、可见质量分数等）。
 *
 * ⚠️ 本函数消费 rng（平均单块质量估算的蒙特卡洛采样），必须先于其他消耗随机数
 * 的阶段调用，以保证随机数消耗顺序与拆分前一致。
 *
 * @param {Object} p
 * @param {{x50:number,xmax:number,b:number,n:number,x80?:number}} p.kco - KCO 模型输出
 * @param {number} p.chargeKg - 总装药量(kg)
 * @param {number} p.targetCount - 目标碎片数量
 * @param {number} p.countLimit - 渲染数量上限
 * @param {Object} p.metrics - 生成指标（密度/方量/速度缩放等）
 * @param {Function} p.rng - 确定性伪随机数生成器
 * @returns {Object} budget：count 与后续阶段共用的派生上下文
 */
function _budgetFragmentCount({ kco, chargeKg, targetCount, countLimit, metrics, rng }) {
  const { x50, xmax, b, n } = kco

  // x80（用于 variantIndex 分级）：优先使用 calculateKCOParams 通过 solveX80 反解得到的 x80
  const safeX50 = Math.max(0.01, x50)
  const safeXmax = Math.max(safeX50 * 1.01, xmax)
  const estX80 = Number(kco?.x80) > 0 ? kco.x80 : safeX50 * 1.5

  // n 因子：块度均匀时减少碎片数，分散时增加
  const nFactor = 1 + (N_FACTOR_REFERENCE - n) * N_FACTOR_GAIN
  const safeCountLimit = Math.max(MIN_FRAGMENT_COUNT, Number(countLimit) || 320)
  const densityBase = Math.max(
    ROCK_DENSITY_FLOOR_KG_M3,
    Number(metrics.rockDensityKgM3) || TYPICAL_ROCK_DENSITY_KG_M3
  )
  // 抛掷速度收缩系数（UI 可调，metrics.velocityScale；缺省 1.0 = 纯物理量级不做视觉降速）
  const velocityScale = Number(metrics.velocityScale) > 0 ? Number(metrics.velocityScale) : 1
  const visibleMassFraction = _computeVisibleMassFraction(metrics, chargeKg)
  const targetVisibleMassKg = Math.max(
    80,
    Number(metrics.volumeRoundM3) > 0
      ? Number(metrics.volumeRoundM3) * densityBase * visibleMassFraction
      : 0
  )
  const estimatedMeanMassKg = _estimateMeanFragmentMass(
    {
      x50,
      xmax,
      b,
      n,
      density: densityBase
    },
    rng
  )
  const massDrivenCount =
    targetVisibleMassKg > 0 && estimatedMeanMassKg > 0
      ? Math.round(targetVisibleMassKg / estimatedMeanMassKg)
      : null
  const blendedCount = massDrivenCount
    ? Math.round(
        massDrivenCount * COUNT_BLEND_MASS_WEIGHT +
          targetCount * nFactor * COUNT_BLEND_TARGET_WEIGHT
      )
    : Math.floor(targetCount * nFactor)
  const requestedCount = Math.max(MIN_FRAGMENT_COUNT, blendedCount)
  const count = Math.min(safeCountLimit, requestedCount)

  // 诊断日志：碎石量计算全过程（由 DEBUG_FRAGMENT_SPECS 开关控制，生产环境关闭）
  if (DEBUG_FRAGMENT_SPECS) {
    console.log('[FragmentSpecGenerator] 碎石量计算诊断', {
      '入参.targetCount': targetCount,
      '入参.countLimit': countLimit,
      '入参.chargeKg': chargeKg,
      '入参.volumeRoundM3': metrics.volumeRoundM3,
      'KCO.x50': x50,
      'KCO.xmax': xmax,
      'KCO.b': b,
      'KCO.n': n,
      '中间.visibleMassFraction': visibleMassFraction.toFixed(4),
      '中间.densityBase': densityBase,
      '中间.targetVisibleMassKg': targetVisibleMassKg.toFixed(1),
      '中间.estimatedMeanMassKg': estimatedMeanMassKg.toFixed(1),
      '中间.massDrivenCount': massDrivenCount,
      '中间.nFactor': nFactor.toFixed(3),
      '中间.blendedCount': blendedCount,
      '中间.safeCountLimit': safeCountLimit,
      '最终.count': count,
      是否被截断: blendedCount > safeCountLimit ? '是(被上限截断)' : '否'
    })
  }

  return {
    count,
    requestedCount,
    blendedCount,
    massDrivenCount,
    nFactor,
    safeX50,
    safeXmax,
    estX80,
    safeCountLimit,
    densityBase,
    velocityScale,
    visibleMassFraction,
    targetVisibleMassKg,
    estimatedMeanMassKg
  }
}

/**
 * 阶段 2：速度基准模型。
 *
 * 模型 A（默认，Persson 1997 物理模型）：vBase = √(2·η·q·E_g/ρ_rock)
 *   - q = 比装药 (kg/m³) = chargeKg / brokenVolume
 *   - E_g = 炸药比能 (J/kg)，ANFO≈2.484e6, emulsion≈3.9e6, dynamite≈3.56e6
 *   - ρ_rock = 岩体密度 (kg/m³)
 *   - η = 0.15 能量耦合系数（经验，炸药能量转化为碎片动能的比例）
 *   - 物理依据：炸药总能量 E_total = Q·E_g，转化为碎片动能 E_k = ½·m·v²
 *     假设能量耦合 η，碎片总质量 m = V·ρ_rock，则 v = √(2·η·Q·E_g/(V·ρ_rock)) = √(2·η·q·E_g/ρ_rock)
 *
 * 模型 B（fallback，经验拟合）：vBase = 6 + √Q×0.3
 *   - 仅当 brokenVolume 不可得（≤0）或显式关闭 Persson 时使用
 *   - 量级吻合隧道爆破抛掷速度（5-30 m/s），但加性常数 6 和系数 0.3 无物理依据
 *   - 缺陷：应与比装药 q=Q/V 相关而非总药量 Q
 *
 * 切换：metrics.usePerssonVelocity === false 可强制关闭 Persson（仅诊断用）
 *
 * @param {Object} p
 * @param {number} p.chargeKg - 总装药量(kg)
 * @param {number} p.densityBase - 岩体密度基准(kg/m³)
 * @param {Object} p.metrics - 生成指标
 * @returns {{ vBase:number, velocityModel:string }} velocityModel: 'empirical' | 'persson1997'
 */
function _computeVelocities({ chargeKg, densityBase, metrics }) {
  const perssonDisabled = metrics.usePerssonVelocity === false
  const hasVolume = Number(metrics.volumeRoundM3) > 0
  let vBase
  let velocityModel = 'empirical' // 标注当前使用的速度模型
  if (!perssonDisabled && hasVolume) {
    // Persson(1997) 物理模型（默认）
    const Eg =
      EXPLOSIVE_TYPES[metrics.explosiveType || 'emulsion']?.Eg || EXPLOSIVE_TYPES.emulsion.Eg
    const q = chargeKg / Number(metrics.volumeRoundM3) // 比装药 kg/m³
    const eta = Number(metrics.eta) > 0 ? Number(metrics.eta) : PERSSON_ETA_DEFAULT
    vBase = Math.sqrt((2 * eta * q * Eg) / densityBase)
    velocityModel = 'persson1997'
  } else {
    // 经验拟合公式（fallback：无体积数据或强制关闭 Persson 时）
    vBase = EMPIRICAL_V_BASE + Math.sqrt(Math.max(1, chargeKg)) * EMPIRICAL_V_SQRT_COEF
  }
  return { vBase, velocityModel }
}

/**
 * 阶段 3：逐孔分配规划（纯计算，不消费随机数）。
 *
 * 提供有效 holes 时，按 chargeKg 比例把碎片数分配到各孔（取整误差修正到装药量
 * 最大的孔）；同时构建延时场：同段孔 delayOrder 相同，段间最小间隔作为同段内
 * 各碎块脱离时间抖动的上限。无有效炮孔时 useHoleDriven=false，生成阶段退化为
 * 经典全掌子面采样。
 *
 * @param {Object} p
 * @param {Array<Object>|undefined} p.holes - 炮孔设计数据
 * @param {number} p.count - 数量预算阶段得出的碎片总数
 * @param {number} p.chargeKg - 总装药量(kg)
 * @returns {{ validHoles:Array, useHoleDriven:boolean, holeAllocations:Array|null,
 *   delayOrderMap:Map, segGapMs:number }}
 */
function _assignByHoles({ holes, count, chargeKg }) {
  // 有效炮孔：非空孔且装药量 > 0
  const validHoles = Array.isArray(holes)
    ? holes.filter(h => !h.isEmpty && Number(h.chargeKg) > 0)
    : []
  const useHoleDriven = validHoles.length > 0

  // 计算每孔分配的碎片数
  let holeAllocations = null
  if (useHoleDriven) {
    const totalHoleCharge = validHoles.reduce((s, h) => s + Number(h.chargeKg), 0)
    if (totalHoleCharge <= 0) {
      // 全部为 0，退化为均匀分配
      holeAllocations = validHoles.map(h => ({
        hole: h,
        count: Math.ceil(count / validHoles.length)
      }))
    } else {
      holeAllocations = []
      let allocated = 0
      for (let i = 0; i < validHoles.length; i++) {
        const fraction = Number(validHoles[i].chargeKg) / totalHoleCharge
        const holeCount = Math.max(1, Math.round(count * fraction))
        holeAllocations.push({ hole: validHoles[i], count: holeCount })
        allocated += holeCount
      }
      // 修正取整误差：差额加到装药量最大的孔
      if (allocated !== count && holeAllocations.length > 0) {
        const maxIdx = holeAllocations.reduce(
          (mx, item, i) => (item.hole.chargeKg > holeAllocations[mx].hole.chargeKg ? i : mx),
          0
        )
        holeAllocations[maxIdx].count += count - allocated
      }
    }
  }

  // 计算延时序号（同段孔 delayOrder 相同），用于延时场耦合
  const sortedDelays = [...new Set((holes || []).map(h => Number(h.delayMs) || 0))].sort(
    (a, b) => a - b
  )
  const delayOrderMap = new Map()
  sortedDelays.forEach((d, i) => delayOrderMap.set(d, i))

  // 段间间隔(ms)：取相邻不同延时段的最小间隔，作为同段内各碎块脱离时间抖动的上限。
  // 真实爆破中同段雷管仍有亚毫秒级起爆离散、且岩体破碎后各块并非同一瞬间脱离开来，
  // 用该量级的连续抖动打散"同段整批齐射"，使相邻段抛掷在时间上交叠成连续过程。
  let segGapMs = 100
  if (sortedDelays.length > 1) {
    for (let k = 1; k < sortedDelays.length; k++) {
      segGapMs = Math.min(segGapMs, sortedDelays[k] - sortedDelays[k - 1])
    }
  }
  segGapMs = Math.max(10, segGapMs)

  return { validHoles, useHoleDriven, holeAllocations, delayOrderMap, segGapMs }
}

/**
 * 构建统一生成循环的"组配置"列表（纯计算，不消费随机数）。
 *
 * 经典模式 = 单一伪组：全掌子面随机采样、无孔型/延时耦合、默认物理常量组、立即起爆；
 * 孔驱动模式 = 每个非空孔一组：孔位/孔型权重/延时场耦合/局部 vBase/扩散 σ 逐孔
 * 预计算；空孔（holeType='empty'）不装药仅提供自由面，跳过碎石生成。
 *
 * 双模式差异点全部收敛到组配置字段，逐碎片主体完全共用（见 _generateFragments）：
 *   - sizeFactor / delaySizeFactor：孔型粒径系数与延时块度衰减（经典均为 1，
 *     乘 1 不改变数值，且保持与原实现一致的乘法结合顺序）
 *   - vBaseEff / axialBias：局部速度基准与轴向偏置（经典 = 全局 vBase / 0）
 *   - isHoleDriven：选择位置采样器、物理常量组与延时抖动分支
 *
 * @param {Object} p
 * @param {FaceGeometry} p.face - 掌子面几何描述
 * @param {Object} p.plan - 逐孔分配规划（_assignByHoles 输出）
 * @param {number} p.vBase - 全局速度基准
 * @param {number} p.chargeKg - 总装药量(kg)
 * @param {number} p.count - 数量预算（经典模式的伪组碎片数）
 * @returns {Array<Object>} groups：组配置数组
 */
function _buildGenerationGroups({ face, plan, vBase, chargeKg, count }) {
  if (!plan.useHoleDriven) {
    // ── 经典模式：单一伪组，全掌子面随机采样 ──
    return [
      {
        isHoleDriven: false,
        count,
        vBaseEff: vBase,
        axialBias: 0,
        sizeFactor: 1,
        delaySizeFactor: 1,
        delayBaseMs: 0
      }
    ]
  }

  // ── 炮孔参数驱动模式：逐孔预计算组配置 ──
  const groups = []
  for (const alloc of plan.holeAllocations) {
    const h = alloc.hole
    // 空孔不装药，仅提供自由面，跳过碎石生成
    if (h.holeType === 'empty') continue

    const holeChargeKg = Number(h.chargeKg) || 0
    const delayBaseMs = Number(h.delayMs) || 0 // 该孔所属雷管段的标称延时(ms)

    // 孔型权重（默认辅助孔基准）
    const w = HOLE_TYPE_WEIGHTS[h.holeType] || HOLE_TYPE_WEIGHTS.auxiliary

    // 延时场耦合：后序孔因前序孔形成新自由面，块度更细、方向偏向前方
    const delayOrder = plan.delayOrderMap.get(Number(h.delayMs) || 0) || 0
    const delaySizeFactor =
      delayOrder > 0 ? Math.max(DELAY_SIZE_FLOOR, 1 - DELAY_SIZE_DECAY * delayOrder) : 1
    const delayDirBias =
      delayOrder > 0 ? Math.min(DELAY_DIR_BIAS_MAX, DELAY_DIR_BIAS_PER_ORDER * delayOrder) : 0

    // 局部速度基准：单孔装药量越大，该孔碎片初速越高
    // vBase_hole = vBase × (holeChargeKg / avgHoleChargeKg)^0.4，再叠加孔型速度系数
    const avgCharge = chargeKg / plan.validHoles.length
    const chargeRatio = Math.max(
      CHARGE_RATIO_MIN,
      Math.min(CHARGE_RATIO_MAX, holeChargeKg / Math.max(0.1, avgCharge))
    )
    const vBaseHole = vBase * Math.pow(chargeRatio, CHARGE_RATIO_EXPONENT) * w.velocityFactor

    // 初始破碎扩散半径随装药量平缓过渡：装药越多的孔破碎越充分、扩散带越宽
    const sampleSigma =
      HOLE_SIGMA_BASE * Math.max(HOLE_SIGMA_RATIO_MIN, Math.min(HOLE_SIGMA_RATIO_MAX, chargeRatio))

    // 孔位世界坐标
    const holeWorldPos = {
      x: face.cx + face.rx * (h.x || 0) + face.ux * (h.y || 0),
      y: face.cy + face.ry * (h.x || 0) + face.uy * (h.y || 0),
      z: face.cz + face.rz * (h.x || 0) + face.uz * (h.y || 0)
    }

    groups.push({
      isHoleDriven: true,
      count: alloc.count,
      vBaseEff: vBaseHole,
      // 速度方向轴向偏置（孔型 axialBias + 延时场方向偏移）
      axialBias: w.axialBias + delayDirBias,
      sizeFactor: w.sizeFactor,
      delaySizeFactor,
      holeWorldPos,
      sampleSigma,
      delayBaseMs,
      // 记录本孔碎片的分组（体积还原后用放大后块径做孔内非重叠排布）
      holeLocalCX: _worldToFaceLateral(face, holeWorldPos),
      holeLocalCY: _worldToFaceHeight(face, holeWorldPos)
    })
  }
  return groups
}

/**
 * 阶段 4：统一碎片生成循环（经典/孔驱动双模式参数化合并）。
 *
 * 两模式逐碎片主体（尺寸采样 → 显示尺寸 → 位置采样 → 发射速度 → 颜色 → 密度 →
 * 规格落表）原本大面积重复（约 70%），现合并为单一参数化循环，差异点由组配置
 * （_buildGenerationGroups）经少量条件分支实现：
 *   - 位置采样：孔驱动 = 孔附近高斯；经典 = 掌子面 rejection 采样。二者经条件
 *     分支二选一，各自恰好消费一次 rng，随机数消耗顺序与合并前逐位一致
 *   - 物理常量组：孔驱动用 ENHANCED_*（分段起爆场景），经典用 DEFAULT_*
 *   - 起爆延迟：孔驱动在段标称延时上叠加 [0, segGapMs) 连续抖动（消耗一次 rng）；
 *     经典为 0（不消耗 rng）
 *   - 尺寸修正：孔驱动叠加 sizeFactor × delaySizeFactor（经典为 1×1，数值不变）
 *
 * @param {Object} p
 * @param {FaceGeometry} p.face - 掌子面几何描述
 * @param {{x50:number,xmax:number,b:number,n:number}} p.kco - KCO 模型输出
 * @param {Object} p.budget - 数量预算及派生上下文（_budgetFragmentCount 输出）
 * @param {Object} p.plan - 逐孔分配规划（_assignByHoles 输出）
 * @param {number} p.chargeKg - 总装药量(kg)
 * @param {number} p.vBase - 全局速度基准
 * @param {number} p.velocityScale - 抛掷速度收缩系数
 * @param {Function} p.rng - 确定性伪随机数生成器
 * @returns {{ specs:Array, positions:Array, velocities:Array, holeGroups:Array, generatedMassKg:number }}
 */
function _generateFragments({ face, kco, budget, plan, chargeKg, vBase, velocityScale, rng }) {
  const { x50, xmax, b, n } = kco
  const { safeX50, safeXmax, estX80, densityBase } = budget

  // 面向开挖侧的抛掷方向（掌子面法线指向岩体，碎片反向抛出）
  const throwNx = -face.nx
  const throwNy = -face.ny
  const throwNz = -face.nz

  const specs = []
  const positions = []
  const velocities = []
  const holeGroups = [] // 每种孔产生的碎片索引分组（供体积还原后按块径做孔内排布）
  let generatedMassKg = 0

  const groups = _buildGenerationGroups({ face, plan, vBase, chargeKg, count: budget.count })

  for (const group of groups) {
    // 记录本组碎片的起始索引（孔驱动模式下用于按孔分组，供体积还原后孔内错开排布）
    const groupStartIdx = specs.length
    for (let i = 0; i < group.count; i++) {
      // 1. KCO Swebrec 等质量分层采样物理尺寸
      //    孔驱动模式叠加孔型粒径系数与延时块度衰减（经典为 1×1，乘法不改变数值）
      const physSize =
        sampleSwebrecMassWeighted(x50, xmax, n, b, rng, {
          index: i,
          totalCount: group.count
        }) *
        group.sizeFactor *
        group.delaySizeFactor

      // 2. 显示尺寸
      const dispSize = _computeDisplaySize(physSize)

      // 3. 采样位置：孔驱动 = 从孔附近高斯采样（σ 随装药量变化，模拟炮孔破裂范围）；
      //    经典 = 在掌子面表面 rejection 采样
      const facePos = group.isHoleDriven
        ? _sampleNearHole(face, group.holeWorldPos, group.sampleSigma, rng)
        : _sampleFacePosition(face, rng)

      // 4. 计算发射速度（叠加孔型/延时场轴向偏置；经典模式偏置为 0）
      const vel = _computeLaunchVelocity(
        physSize,
        x50,
        group.vBaseEff,
        throwNx,
        throwNy,
        throwNz,
        face,
        group.axialBias,
        rng,
        velocityScale
      )

      // 5. 岩石颜色（大块深褐色，小块浅灰色）
      const sizeNorm = Math.min(1, physSize / Math.max(0.1, xmax))
      const brown = 0.6 - sizeNorm * 0.4 + (rng() - 0.5) * 0.08
      const color = {
        r: Math.max(0.15, brown),
        g: Math.max(0.12, brown * 0.72),
        b: Math.max(0.08, brown * 0.45)
      }

      // 6. 岩石密度
      const density = _sampleFragmentDensity(densityBase, rng)
      generatedMassKg += _computeFragmentMassKg(physSize, density)

      specs.push({
        physSize,
        dispSize,
        density,
        // 孔驱动模式（分段起爆场景）用增强物理常量组，经典模式用默认组
        restitution: group.isHoleDriven ? ENHANCED_RESTITUTION : DEFAULT_RESTITUTION,
        friction: group.isHoleDriven ? ENHANCED_FRICTION : DEFAULT_FRICTION,
        maxBounces: group.isHoleDriven ? ENHANCED_MAX_BOUNCES : DEFAULT_MAX_BOUNCES,
        variantIndex: selectVariantBySize(physSize, safeX50, estX80, safeXmax, rng),
        color,
        // 分段起爆延迟（秒）：孔驱动模式在所属段标称延时上叠加 [0,segGapMs) 连续抖动，
        // 打散同段整批齐射，使相邻段抛掷在时间上交叠成连续过程。
        // 物理引擎在 simTime < delayTime 时跳过该碎片；经典模式无延迟立即起爆（不消耗 rng）
        delayTime: group.isHoleDriven ? (group.delayBaseMs + rng() * plan.segGapMs) / 1000 : 0
      })

      positions.push(facePos)
      velocities.push(vel)
    }
    // 本孔生成成功时记录分组（体积还原后按放大块径做孔内非重叠排布）
    if (group.isHoleDriven && specs.length > groupStartIdx) {
      holeGroups.push({
        lx: group.holeLocalCX,
        ly: group.holeLocalCY,
        indices: Array.from({ length: specs.length - groupStartIdx }, (_, k) => groupStartIdx + k)
      })
    }
  }

  return { specs, positions, velocities, holeGroups, generatedMassKg }
}

/**
 * 阶段 6：崩落体积还原（代表性碎岩）。
 *
 * 真实隧道爆破中 cm~m 级岩块数量达十万~百万级，受实时渲染上限（~数千个）
 * 约束，只能渲染"代表性碎岩"。若直接用真实 KCO 粒径 + 数千个碎片，其总
 * 体积通常只占崩落实方量的个位数~几十个百分点，导致爆堆严重偏矮、摊平。
 * 解法：对全部碎片物理尺寸施加统一体积还原系数
 *   k = (V_target / Σ(π/6·dᵢ³))^(1/3)，V_target = V_崩落 × 可见质量分数 × 碎胀系数
 * 使碎片总物理体积与松散爆堆体积一致，从而填出符合工程量级的堆积高度。
 * 均匀缩放不破坏相对块度层级；真实 KCO 粒径单独存至 physSizeTrue，
 * 供图3-3块度直方图与块度高亮使用（保持级配统计的学术真实性）。
 * 依据：坚硬岩石碎胀系数 1.4~1.6（文献常见 1.5~1.6，取 1.5）；
 * 松散爆堆体积≈崩落实体×碎胀系数。
 *
 * @param {Object} p
 * @param {Array} p.specs - 碎片规格数组（原地修改 physSize/dispSize/physSizeTrue）
 * @param {Object} p.metrics - 生成指标
 * @param {number} p.visibleMassFraction - 可见质量分数
 * @param {number} p.generatedMassKg - 生成碎片总质量(kg)
 * @returns {{ volumeRestoreScale:number, representativeVolumeM3:number,
 *   representativeMassKg:number, bulkFactor:number }}
 */
function _restoreVolume({ specs, metrics, visibleMassFraction, generatedMassKg }) {
  const volumeRoundM3restore = Number(metrics.volumeRoundM3) || 0
  const enableVolumeRestore = metrics.enableVolumeRestore !== false
  const bulkFactor =
    Number(metrics.bulkFactor) > 0 ? Number(metrics.bulkFactor) : DEFAULT_BULK_FACTOR
  let volumeRestoreScale = 1
  let representativeVolumeM3 = 0
  let representativeMassKg = generatedMassKg
  if (enableVolumeRestore && specs.length > 0 && volumeRoundM3restore > 0) {
    const looseTargetM3 = volumeRoundM3restore * visibleMassFraction * bulkFactor
    let trueVolM3 = 0
    for (const s of specs) trueVolM3 += SPHERE_VOLUME_COEFF * s.physSize ** 3
    if (trueVolM3 > 1e-6) {
      const kRaw = Math.cbrt(looseTargetM3 / trueVolM3)
      // 夹紧到 [VOLUME_RESTORE_SCALE_MIN, VOLUME_RESTORE_SCALE_MAX]（含义见常量注释）
      const k = Math.min(VOLUME_RESTORE_SCALE_MAX, Math.max(VOLUME_RESTORE_SCALE_MIN, kRaw))
      let repMass = 0
      let repVol = 0
      for (const s of specs) {
        if (!Number.isFinite(Number(s.physSizeTrue)) || s.physSizeTrue <= 0) {
          s.physSizeTrue = s.physSize // 首次还原前记录真实 KCO 粒径
        }
        s.physSize *= k
        s.dispSize = _computeDisplaySize(s.physSize)
        const vol = SPHERE_VOLUME_COEFF * s.physSize ** 3
        repVol += vol
        repMass += vol * s.density
      }
      volumeRestoreScale = k
      representativeVolumeM3 = repVol
      representativeMassKg = repMass
    }
  }
  return { volumeRestoreScale, representativeVolumeM3, representativeMassKg, bulkFactor }
}

/**
 * 阶段 7a：渲染体积归一化（几何填充率修正，解决"渲染显多/显满"）。
 *
 * 渲染 InstancedMesh 的 scale=dispSize，而各变体的实心单位体积 V_unit 差异
 * 巨大（实测 0.22~3.06，≠ 球形口径 π/6≈0.52）。若直接把 dispSize 赋给几何，
 * Σ 渲染实心体积 = Σ V_unit·dispSize³ 会系统性偏大——几何填充越"胖"的变体
 * 显得越多。按变体施加 f=cbrt((π/6)/V_unit) 缩放 dispSize，使渲染实心体积
 * 严格退回到球形账目标 Σ(π/6)·physSize³，堆体不再虚胖。只改 dispSize 不动
 * physSize（质量/块度统计不受影响）；物理碰撞体按 dispSize 与视觉同归一化，
 * 视觉/碰撞口径一致、不脱节。
 *
 * @param {Array} specs - 碎片规格数组（原地修改 dispSize）
 */
function _normalizeDisplaySizes(specs) {
  const unitVols = getRockVariantUnitVolumes()
  for (const s of specs) {
    const cu = unitVols[s.variantIndex]
    const f = cu > 0.001 ? Math.cbrt(SPHERE_VOLUME_COEFF / cu) : 1
    // 夹紧避免极小/极大填充几何被异常放大或缩到离谱（保留形态不致失真）
    s.dispSize *= Math.min(DISP_FILL_FACTOR_MAX, Math.max(DISP_FILL_FACTOR_MIN, f))
  }
}

/**
 * 阶段 7b：初始位置推出掌子面并收进断面 + 孔内错开排布。
 *
 * 碎片采样位置在掌子面表面（中心恰在面平面），体积还原后 physSize 最大
 * 可达数米，半个碎片会嵌进岩体，视觉与物理上都表现为"卡在掌子面"。
 * 统一沿面法线反向（已开挖侧）推出 半径+0.05m，使碎片初始完全位于掌子面前方。
 * 之后再按断面形状收拢：渲染网格是 maxR≈1.2~2.0 倍的 dispSize（比物理碰撞体
 * 的 physSize/2 大得多），靠近侧墙/拱顶/底板的大块碎片必须按各自变体的真实
 * 渲染半径收进隧道内，否则碎石网格会穿出隧道外壁。
 *
 * 体积还原后物理块径被统一放大（k≤3.5），而初始采样点仍挤在孔心 σ 附近。
 * 若不做排布，大碎块会互相重叠、甚至"从掌子面里冒出"。此处对同一炮孔的碎片
 * 按其放大后渲染半径在掌子面内错开：块与块不重叠、离孔心至少一个半径，
 * 使起爆面铺得更接近真实"沿孔周连续破碎带"。
 *
 * ⚠️ 本阶段的 _repackHolePositions 消费随机数，必须位于生成循环之后，且不得与
 * 其他消耗 rng 的阶段交换顺序。
 *
 * @param {Object} p
 * @param {FaceGeometry} p.face - 掌子面几何描述
 * @param {Array} p.specs - 碎片规格数组
 * @param {Array<{x,y,z}>} p.positions - 碎片初始位置数组（原地修改）
 * @param {Array<{lx,ly,indices}>} p.holeGroups - 孔内碎片索引分组
 * @param {Function} p.rng - 确定性伪随机数生成器
 */
function _settleFragmentPositions({ face, specs, positions, holeGroups, rng }) {
  const variantMaxRadii = getRockVariantMaxRadius()
  for (let i = 0; i < positions.length; i++) {
    const maxR = variantMaxRadii[specs[i].variantIndex] || 1.2
    // 物理碰撞体已与渲染尺寸对齐（半径 = maxR×dispSize），推出距离按完整视觉半径
    const p = _nudgeOffFace(face, positions[i], specs[i].dispSize * maxR)
    positions[i] = _clampInsideTunnel(face, p, specs[i].dispSize * maxR)
  }

  // 同孔碎片按放大后渲染半径在掌子面内错开排布（算法详见 _repackHolePositions）
  if (holeGroups.length > 0) {
    _repackHolePositions(face, specs, positions, holeGroups, variantMaxRadii, rng)
  }
}

/**
 * 阶段 8：统计直方图（分布闭合诊断）。
 *
 * 实际块度直方图基于 physSizeTrue（体积还原前的真实 KCO 粒径），保证图3-3级配
 * 统计与 Swebrec 理论分布可比（不受代表性碎岩缩放影响）；等质量分层语义下
 * 计数直方图即质量分布，与理论质量分布直接可比，无需再按 size³ 加权。
 *
 * @param {Object} p
 * @param {Array} p.specs - 碎片规格数组
 * @param {Array<{x,y,z}>} p.velocities - 初始速度数组
 * @param {Object} p.metrics - 生成指标
 * @param {{x50:number,xmax:number,b:number,n:number}} p.kco - KCO 模型输出
 * @param {number} p.targetVisibleMassKg - 可见方量目标质量(kg)
 * @param {number} p.generatedMassKg - 生成碎片总质量(kg)
 * @returns {{ sizeHistogramGenerated:Array, sizeHistogramTarget:Array,
 *   sizeKLDivergence:number, velocityHistogramGenerated:Array,
 *   massScaleFactor:number, scaledMassKg:number }}
 */
function _computeStats({ specs, velocities, metrics, kco, targetVisibleMassKg, generatedMassKg }) {
  const safeXmaxForHist = Math.max(0.1, Number(metrics.fragmentXmax) || Number(kco.xmax) || 2.0)
  const sizeBinWidth = safeXmaxForHist / SIZE_BIN_COUNT
  const sizeBinEdges = Array.from({ length: SIZE_BIN_COUNT + 1 }, (_, i) => i * sizeBinWidth)

  // 实际块度直方图（基于生成碎石的 physSize）
  // 等质量分层语义：每片承载相等质量份额，故计数直方图即质量分布，
  // 与理论质量分布（swebrecCdf）直接可比，无需再按 size³ 加权（避免双重加权）。
  // 块度直方图使用真实 KCO 粒径 physSizeTrue（体积还原前的采样值），
  // 保证图3-3级配统计与 Swebrec 理论分布可比（不受代表性碎岩缩放影响）。
  const sizeValues = specs.map(s => Number(s.physSizeTrue || s.physSize) || 0)
  const sizeHistogramGenerated = binHistogram(sizeValues, sizeBinEdges)

  // 目标块度直方图（Swebrec 理论分布，使用相同分箱边界）
  const safeX50ForHist = Math.max(
    0.01,
    Math.min(safeXmaxForHist * 0.99, Number(metrics.fragmentX50) || Number(kco.x50) || 0.5)
  )
  const safeBForHist = Math.max(0.1, Number(metrics.fragmentB) || Number(kco.b) || 2.0)
  const safeNForHist = Number(metrics.fragmentN) || Number(kco.n) || 1.2
  const sizeHistogramTarget = generateSwebrecHistogram(
    safeX50ForHist,
    safeXmaxForHist,
    safeNForHist,
    safeBForHist,
    SIZE_BIN_COUNT
  )

  // KL 散度（目标 vs 实际）
  const sizeKLDivergence = computeKLDivergence(
    sizeHistogramGenerated.map(bin => bin.pct),
    sizeHistogramTarget.map(bin => bin.pct)
  )

  // 实际速度直方图（基于初始速度大小）
  const speedValues = velocities.map(v => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z))
  const maxSpeed = speedValues.length > 0 ? Math.max(...speedValues) : 1
  const velBinWidth = Math.max(0.1, maxSpeed) / VELOCITY_BIN_COUNT
  const velBinEdges = Array.from({ length: VELOCITY_BIN_COUNT + 1 }, (_, i) => i * velBinWidth)
  const velocityHistogramGenerated = binHistogram(speedValues, velBinEdges)

  // 质量放大系数：当碎片数被 countLimit 截断时，每个渲染碎片代表多个实际碎片，
  // 统计总质量按比例放大以反映实际爆破方量（物理模拟仍用真实单碎片质量）。
  const massScaleFactor =
    targetVisibleMassKg > 0 && generatedMassKg > 0
      ? Math.max(1, targetVisibleMassKg / generatedMassKg)
      : 1
  const scaledMassKg = generatedMassKg * massScaleFactor

  return {
    sizeHistogramGenerated,
    sizeHistogramTarget,
    sizeKLDivergence,
    velocityHistogramGenerated,
    massScaleFactor,
    scaledMassKg
  }
}

/**
 * 在指定炮孔附近高斯采样一个位置
 * @param {FaceGeometry} face - 掌子面几何描述
 * @param {{x:number,y:number,z:number}} holeWorldPos - 孔位世界坐标
 * @param {number} sigma - 高斯采样标准差(m)
 * @returns {{x:number,y:number,z:number}}
 */
function _sampleNearHole(face, holeWorldPos, sigma, rng = Math.random) {
  for (let attempt = 0; attempt < 12; attempt++) {
    // Box-Muller 高斯采样
    const u1 = rng() || 1e-6
    const u2 = rng()
    const r = Math.sqrt(-2 * Math.log(u1))
    const dx = r * Math.cos(2 * Math.PI * u2) * sigma
    const dy = r * Math.sin(2 * Math.PI * u2) * sigma
    const localX = _worldToFaceLateral(face, holeWorldPos) + dx
    const localY = _worldToFaceHeight(face, holeWorldPos) + dy
    if (_isPointInsideFace(face, localX, localY)) {
      return {
        x: face.cx + face.rx * localX + face.ux * localY,
        y: face.cy + face.ry * localX + face.uy * localY,
        z: face.cz + face.rz * localX + face.uz * localY
      }
    }
  }
  return _projectWorldPointToFace(face, holeWorldPos)
}

/**
 * 方案2：体积还原后，把同孔内碎片的初始位置按其放大后块径错开排布。
 * 使同一炮孔破碎出的几块代表性碎岩在掌子面上不重叠、且离孔心至少一个半径，
 * 避免"大碎块全部挤在孔心、起爆时互相穿模/从掌子面里冒出"的失真。
 * 采用大块先置、小块填空隙的贪心：每块在孔心附近环形带上随机试位，
 * 首个与已放置块不相交（间距 ≥ 半径和）且落在断面内的位置即被采用；
 * 找不到时兜底保留当前位置。仅调整掌子面内（横向/高度）排布，
 * 保留已有的沿面法线推离量；只保证同孔内部不重叠，相邻炮孔破碎带相互衔接属正常。
 * @param {FaceGeometry} face
 * @param {Array} specs
 * @param {Array<{x,y,z}>} positions
 * @param {Array<{lx:number,ly:number,indices:number[]}>} holeGroups
 * @param {Array<number>} variantMaxRadii
 * @param {Function} rng
 */
function _repackHolePositions(
  face,
  specs,
  positions,
  holeGroups,
  variantMaxRadii,
  rng = Math.random
) {
  for (const g of holeGroups) {
    // 由大到小排布：大块先占位当骨架，小块填空隙
    const items = g.indices
      .map(idx => ({
        idx,
        r: Math.max(0.05, (variantMaxRadii[specs[idx].variantIndex] || 1.2) * specs[idx].dispSize)
      }))
      .sort((a, b) => b.r - a.r)

    const placed = []
    for (const it of items) {
      const ri = it.r
      const minRad = ri + 0.05 // 离孔心至少一个半径，避免压在孔轴线上
      const searchMax = Math.max(minRad + 0.4, 1.4)
      let chosen = null
      for (let attempt = 0; attempt < 48; attempt++) {
        const rad = minRad + rng() * (searchMax - minRad)
        const ang = rng() * Math.PI * 2
        const lx = g.lx + Math.cos(ang) * rad
        const ly = g.ly + Math.sin(ang) * rad
        if (!_isPointInsideFace(face, lx, ly)) continue
        let clear = true
        for (const p of placed) {
          if (Math.hypot(lx - p.x, ly - p.y) < ri + p.r) {
            clear = false
            break
          }
        }
        if (clear) {
          chosen = { x: lx, y: ly }
          break
        }
      }
      if (!chosen) {
        chosen = {
          x: _worldToFaceLateral(face, positions[it.idx]),
          y: _worldToFaceHeight(face, positions[it.idx])
        }
      }
      // 重建世界坐标：面内用新排布的 (lx,ly)，保留已有沿面法线推离量 s
      const px = positions[it.idx]
      const s = (px.x - face.cx) * face.nx + (px.y - face.cy) * face.ny + (px.z - face.cz) * face.nz
      positions[it.idx] = _clampInsideTunnel(
        face,
        {
          x: face.cx + face.rx * chosen.x + face.ux * chosen.y + face.nx * s,
          y: face.cy + face.ry * chosen.x + face.uy * chosen.y + face.ny * s,
          z: face.cz + face.rz * chosen.x + face.uz * chosen.y + face.nz * s
        },
        ri
      )
      placed.push({ x: chosen.x, y: chosen.y, r: ri })
    }
  }
}

/**
 * 在掌子面表面采样一个位置
 * 使用 rejection sampling 确保点位于断面形状内
 *
 * 注：内缩边界（0.95 / 0.98）为本采样专用的"比例内缩"，为碎片中心预留边缘缓冲；
 * 与 computation/sectionShape.js 的 isInsideSection（精确边界 + 绝对 margin 内缩）
 * 语义不同，刻意不合并。
 *
 * @param {FaceGeometry} face
 * @returns {{x:number,y:number,z:number}}
 */
function _sampleFacePosition(face, rng = Math.random) {
  const shape = face.shape || 'horseshoe'
  const halfW = face.width / 2
  const hw = face.wallHeight
  const r = face.archRadius
  const totalH = hw + r

  let lx, ly, valid
  for (let attempt = 0; attempt < 16; attempt++) {
    lx = (rng() - 0.5) * face.width
    ly = rng() * totalH

    if (shape === 'circular') {
      const dy = ly - r
      valid = lx * lx + dy * dy <= r * r * 0.95
    } else if (shape === 'rectangular') {
      valid = Math.abs(lx) <= halfW * 0.95 && ly <= hw * 0.98
    } else {
      // 马蹄形
      if (ly <= hw) {
        valid = Math.abs(lx) <= halfW * 0.95
      } else {
        const dy = ly - hw
        valid = lx * lx + dy * dy <= r * r * 0.95
      }
    }
    if (valid) break
  }
  // 兜底：取中心点
  if (!valid) {
    lx = 0
    ly = totalH * 0.4
  }

  // 转换为世界坐标：faceCenter + right * lx + up * ly
  return {
    x: face.cx + face.rx * lx + face.ux * ly,
    y: face.cy + face.ry * lx + face.uy * ly,
    z: face.cz + face.rz * lx + face.uz * ly
  }
}

/**
 * 将掌子面表面的采样位置沿面法线反向（已开挖侧）推出，使碎片初始
 * 完全位于掌子面前方，避免半个碎片嵌进岩体（"卡在掌子面"）。
 * @param {FaceGeometry} face
 * @param {{x:number,y:number,z:number}} pos - 掌子面表面位置
 * @param {number} radius - 碎片视觉/碰撞半径（maxR × dispSize，完整尺寸推出）
 * @returns {{x:number,y:number,z:number}}
 */
function _nudgeOffFace(face, pos, radius) {
  const push = (Number(radius) || 0.1) + 0.05
  return {
    x: pos.x - face.nx * push,
    y: pos.y - face.ny * push,
    z: pos.z - face.nz * push
  }
}

/**
 * 将碎片约束在隧道断面内：按其"渲染球半径"（变体 maxR × dispSize，覆盖
 * 顶点最外伸的块状/不规则/长条造型）向断面内部收拢，确保碎石网格不会伸出
 * 侧墙/拱顶/底板（"碎石挤到隧道外"）。轴向（z）已由 _nudgeOffFace 处理。
 *
 * 注：内缩系数 CLAMP_INNER_SHRINK_RATIO（0.97）为本收拢专用的"比例内缩"，
 * 与 computation/sectionShape.js 的 isInsideSection（精确边界 + 绝对 margin）
 * 口径不同，刻意不合并（见文件顶部"断面内缩系数"注释）。
 *
 * @param {FaceGeometry} face
 * @param {{x:number,y:number,z:number}} pos
 * @param {number} radius - 渲染球半径（maxR[variant] × dispSize）
 * @returns {{x:number,y:number,z:number}}
 */
function _clampInsideTunnel(face, pos, radius) {
  const shape = face.shape || 'horseshoe'
  const halfW = face.width / 2
  const hw = face.wallHeight
  const R = face.archRadius
  const r = Math.max(0.05, Number(radius) || 0.1)
  const sv = CLAMP_INNER_SHRINK_RATIO // 内缩安全系数（断面内边界缓冲）

  let lx = _worldToFaceLateral(face, pos)
  let ly = _worldToFaceHeight(face, pos)

  // 侧墙：中心距侧墙 ≥ 渲染半径
  const lxLimit = Math.max(r, halfW * sv - r)
  lx = Math.max(-lxLimit, Math.min(lxLimit, lx))

  // 底板：底部不低于断面底边
  ly = Math.max(r, ly)

  if (shape === 'circular') {
    // 圆心 (0, R)，半径 R 的圆
    const dy = ly - R
    const limit = Math.max(r, R * sv - r)
    const d = Math.hypot(lx, dy)
    if (d > limit) {
      const s = limit / Math.max(1e-6, d)
      lx *= s
      ly = R + dy * s
    }
  } else if (shape === 'rectangular') {
    // 平顶矩形：仅限制顶部高度
    const lyMax = Math.max(r, hw * sv - r)
    ly = Math.min(ly, lyMax)
  } else {
    // 马蹄形：直墙段只受侧墙约束；拱段按拱心圆约束
    if (ly > hw) {
      const dy0 = ly - hw
      const limit = Math.max(r, R * sv - r)
      const d = Math.hypot(lx, dy0)
      if (d > limit) {
        const s = limit / Math.max(1e-6, d)
        lx *= s
        ly = hw + dy0 * s
      }
    } else {
      const topY = Math.max(r, hw * sv - r)
      ly = Math.min(topY, ly)
    }
  }

  return {
    x: face.cx + face.rx * lx + face.ux * ly,
    y: face.cy + face.ry * lx + face.uy * ly,
    z: pos.z
  }
}

function _computeDisplaySize(physSize) {
  const size = Math.max(0.02, Number(physSize) || 0.02)
  if (size >= DISPLAY_VISIBLE_FLOOR_M) return size
  // 仅对很小的碎石做温和视觉补偿，避免整体体积被系统性放大。
  return DISPLAY_VISIBLE_FLOOR_M * Math.sqrt(size / DISPLAY_VISIBLE_FLOOR_M)
}

function _computeFragmentMassKg(size, density) {
  const diameter = Math.max(0.02, Number(size) || 0.02)
  const rho = Math.max(100, Number(density) || 2650)
  const volume = (4 / 3) * Math.PI * Math.pow(diameter / 2, 3)
  return volume * rho
}

function _estimateMeanFragmentMass({ x50, xmax, b, n, density }, rng = Math.random) {
  let total = 0
  for (let i = 0; i < MEAN_MASS_SAMPLE_COUNT; i++) {
    total += _computeFragmentMassKg(
      sampleSwebrecMassWeighted(x50, xmax, n, b, rng, {
        index: i,
        totalCount: MEAN_MASS_SAMPLE_COUNT
      }),
      density
    )
  }
  return total / MEAN_MASS_SAMPLE_COUNT
}

function _sampleFragmentDensity(densityBase, rng = Math.random) {
  const base = Math.max(ROCK_DENSITY_FLOOR_KG_M3, Number(densityBase) || TYPICAL_ROCK_DENSITY_KG_M3)
  const variation = DENSITY_VARIATION_BASE + rng() * DENSITY_VARIATION_RANGE
  return Math.max(1800, base * variation)
}

function _computeVisibleMassFraction(metrics, chargeKg) {
  // 可见质量分数：控制崩落体中参与渲染的飞石比例（经验公式，常量含义见文件顶部）
  // 真实全断面掌子面爆破接近整断面破碎，可见比例应尽量高；
  // 提至 50%~97% 区间，配合体积还原使碎石量与爆堆饱满
  const specificCharge = Number(metrics.specificChargeKgM3) || 0
  const throwAvg = Number(metrics.throwDistanceTargetAvg) || 0
  const chargeTerm = Math.min(
    VISIBLE_MASS_CHARGE_CAP,
    Math.sqrt(Math.max(1, chargeKg)) * VISIBLE_MASS_CHARGE_COEF
  )
  const specificTerm = Math.min(
    VISIBLE_MASS_SPECIFIC_CAP,
    specificCharge * VISIBLE_MASS_SPECIFIC_COEF
  )
  const throwTerm = Math.min(VISIBLE_MASS_THROW_CAP, throwAvg * VISIBLE_MASS_THROW_COEF)
  return Math.max(
    VISIBLE_MASS_FRACTION_MIN,
    Math.min(
      VISIBLE_MASS_FRACTION_MAX,
      VISIBLE_MASS_FRACTION_BASE + chargeTerm + specificTerm + throwTerm
    )
  )
}

function _worldToFaceLateral(face, point) {
  const rx = point.x - face.cx
  const ry = point.y - face.cy
  const rz = point.z - face.cz
  return rx * face.rx + ry * face.ry + rz * face.rz
}

function _worldToFaceHeight(face, point) {
  const rx = point.x - face.cx
  const ry = point.y - face.cy
  const rz = point.z - face.cz
  return rx * face.ux + ry * face.uy + rz * face.uz
}

/**
 * 判断面内局部坐标 (lx, ly) 是否位于掌子面断面内（碎片采样用）。
 *
 * ⚠️ 与 computation/sectionShape.js 的 isInsideSection 语义不同，刻意不合并：
 *   - isInsideSection：精确边界 + 绝对 margin 内缩（供炮孔布置等几何约束使用）；
 *   - 本函数：按断面特征尺寸做"比例内缩"（FACE_INNER_SHRINK_RATIO = 0.98），
 *     为碎片采样预留 2% 边缘缓冲，避免碎片中心贴在断面边界上导致半颗嵌入围岩。
 *   二者口径与用途不同，勿合并（详见文件顶部"断面内缩系数"注释）。
 *
 * @param {FaceGeometry} face
 * @param {number} lx - 面内横向局部坐标
 * @param {number} ly - 面内高度局部坐标
 * @returns {boolean}
 */
function _isPointInsideFace(face, lx, ly) {
  const shape = face.shape || 'horseshoe'
  const halfW = face.width / 2
  const hw = face.wallHeight
  const r = face.archRadius
  if (shape === 'circular') {
    const dy = ly - r
    return lx * lx + dy * dy <= r * r * FACE_INNER_SHRINK_RATIO
  }
  if (shape === 'rectangular') {
    return (
      Math.abs(lx) <= halfW * FACE_INNER_SHRINK_RATIO &&
      ly >= 0 &&
      ly <= hw * FACE_INNER_SHRINK_RATIO
    )
  }
  if (ly < 0) return false
  if (ly <= hw) return Math.abs(lx) <= halfW * FACE_INNER_SHRINK_RATIO
  const dy = ly - hw
  return lx * lx + dy * dy <= r * r * FACE_INNER_SHRINK_RATIO
}

function _projectWorldPointToFace(face, point) {
  const shape = face.shape || 'horseshoe'
  const halfW = face.width / 2
  const hw = face.wallHeight
  const r = face.archRadius
  let lx = _worldToFaceLateral(face, point)
  let ly = _worldToFaceHeight(face, point)

  if (shape === 'rectangular') {
    lx = Math.max(-halfW * 0.95, Math.min(halfW * 0.95, lx))
    ly = Math.max(0, Math.min(hw * 0.95, ly))
  } else if (shape === 'circular') {
    const cy = r
    let dx = lx
    let dy = ly - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    const limit = r * 0.95
    if (dist > limit && dist > 1e-6) {
      const s = limit / dist
      dx *= s
      dy *= s
    }
    lx = dx
    ly = cy + dy
  } else {
    ly = Math.max(0, ly)
    if (ly <= hw) {
      lx = Math.max(-halfW * 0.95, Math.min(halfW * 0.95, lx))
      ly = Math.min(hw * 0.95, ly)
    } else {
      let dx = lx
      let dy = ly - hw
      const dist = Math.sqrt(dx * dx + dy * dy)
      const limit = r * 0.95
      if (dist > limit && dist > 1e-6) {
        const s = limit / dist
        dx *= s
        dy *= s
      }
      lx = Math.max(-halfW * 0.95, Math.min(halfW * 0.95, dx))
      ly = hw + dy
    }
  }

  return {
    x: face.cx + face.rx * lx + face.ux * ly,
    y: face.cy + face.ry * lx + face.uy * ly,
    z: face.cz + face.rz * lx + face.uz * ly
  }
}

/**
 * 计算碎片发射速度
 * 大块碎片角度低、速度快（抛得远）；小块碎片角度高、速度分布广
 *
 * 注：发射运动学调参常量（BASE_LAUNCH_ANGLE / AZIMUTH_SPREAD / 各分量权重等）
 * 集中在文件顶部"发射运动学常量"分组，便于统一调参与溯源。
 *
 * @param {number} physSize
 * @param {number} x50
 * @param {number} vBase
 * @param {number} nx/ny/nz - 抛掷方向（已开挖侧）
 * @param {FaceGeometry} face
 * @param {number} [axialBias=0] - 轴向偏置（弧度），由孔型权重与延时场耦合叠加
 * @returns {{x:number,y:number,z:number}}
 */
function _computeLaunchVelocity(
  physSize,
  x50,
  vBase,
  nx,
  ny,
  nz,
  face,
  axialBias = 0,
  rng = Math.random,
  velocityScale = 1
) {
  // 发射角：大块低抛、小块相对略高，严格限制在 (0, 上限) 使碎片沿隧道轴向向前抛出
  const sizeRatio = physSize / Math.max(0.1, x50)
  const angleBias = Math.max(
    -ANGLE_BIAS_LIMIT,
    Math.min(ANGLE_BIAS_LIMIT, (SIZE_RATIO_REF - sizeRatio) * ANGLE_BIAS_LIMIT)
  )
  // 叠加孔型与延时场轴向偏置，使速度方向轴向占比变化
  let launchAngle = BASE_LAUNCH_ANGLE + angleBias + (rng() - 0.5) * ANGLE_JITTER + axialBias
  launchAngle = Math.max(LAUNCH_ANGLE_MIN, Math.min(LAUNCH_ANGLE_MAX, launchAngle))

  // 方位角：窄锥形扩散（贴合隧道轴向自由面，避免向两侧岩墙散开）
  const azimuth = (rng() - 0.5) * AZIMUTH_SPREAD

  // 尺寸因子：动能均分 v ∝ (m_mean/m)^{1/3} = x50/physSize（m ∝ physSize³）
  // 加上界 MAX_SIZE_FACTOR 防止 physSize→0 时发散；下界不裁剪（小碎片该慢就慢）
  const sizeFactor = Math.min(x50 / Math.max(0.1, physSize), MAX_SIZE_FACTOR)
  const vVariation = V_VARIATION_BASE + rng() * V_VARIATION_RANGE
  // VELOCITY_SCALE：抛掷速度收缩系数（UI 可调，默认 1.0 = 不收缩·纯物理量级）。
  // 历史 0.42 原是面向"隧道舱内近景视域"的视觉收缩——把特征抛速压到物理实测量级，
  // 避免碎片抛满整条隧道、让爆堆紧贴掌子面成形（0.5→0.42 进一步收缩抛散）。
  // 现默认 1.0 不做视觉降速，物理引擎按 Persson 初速的原生量级积分抛掷；
  // 调小该系数 → 抛距收缩、爆堆更贴掌子面。
  const VELOCITY_SCALE = Number(velocityScale) > 0 ? Number(velocityScale) : 1
  const speed = Math.max(MIN_LAUNCH_SPEED, vBase * sizeFactor * vVariation * VELOCITY_SCALE)

  // 速度分解：轴向（掌子面法向反向指向开挖空腔）主导，横向收窄，竖向被抑制
  // 使用 cos 保证轴向始终指向隧道内（launchAngle 已钳制在 [0, LAUNCH_ANGLE_MAX]）
  const cosLaunch = Math.cos(launchAngle)
  const axialComp = cosLaunch * Math.cos(azimuth) * speed * AXIAL_WEIGHT
  const lateralComp = cosLaunch * Math.sin(azimuth) * speed * LATERAL_WEIGHT
  const verticalComp = Math.sin(launchAngle) * speed * VERTICAL_WEIGHT

  return {
    x: nx * axialComp + face.rx * lateralComp + face.ux * verticalComp,
    y: ny * axialComp + face.ry * lateralComp + face.uy * verticalComp,
    z: nz * axialComp + face.rz * lateralComp + face.uz * verticalComp
  }
}

function _calibrateVelocitiesToThrowTargets({
  velocities,
  positions,
  floorY,
  targetAvg,
  targetMax
}) {
  if (!Array.isArray(velocities) || velocities.length === 0) {
    return {
      throwDistanceAvg: 0,
      throwDistanceMax: 0,
      velocityMean: 0,
      velocityP95: 0,
      velocityScaleApplied: 1
    }
  }

  const currentStats = _measureThrowStats(velocities, positions, floorY)
  let scale = 1
  if (targetAvg && currentStats.throwDistanceAvg > THROW_MIN_DISTANCE_M) {
    scale *= Math.sqrt(targetAvg / currentStats.throwDistanceAvg)
  }
  if (targetMax && currentStats.throwDistanceMax > THROW_MIN_DISTANCE_M) {
    const maxScale = Math.sqrt(targetMax / currentStats.throwDistanceMax)
    scale = scale * THROW_BLEND_AVG_WEIGHT + maxScale * THROW_BLEND_MAX_WEIGHT
  }
  // 注：原 clamp(0.55, 1.1) 已移除——人为裁剪物理结果只会掩盖模型偏差，
  // 应通过 Persson η 标定或 sizeFactor 模型修正源头，而非事后砍 scale。
  // enableCalibration=false 时 targetAvg/targetMax 为 null，scale 恒为 1 不校准。

  if (Math.abs(scale - 1) > THROW_SCALE_DEADBAND) {
    for (const v of velocities) {
      v.x *= scale
      v.y *= scale
      v.z *= scale
    }
  }

  // 超速碎片单独 cap：校准后仍超过 targetMax 的碎片缩放到上限
  // 防止个别小碎片因 sizeFactor 过大导致最大抛距远超目标
  if (targetMax && targetMax > THROW_MIN_DISTANCE_M) {
    // 简化抛距公式 d ≈ v²/g → v_max = sqrt(d_max * g)
    const maxAllowedSpeed = Math.sqrt(targetMax * GRAVITY_ACCELERATION)
    for (const v of velocities) {
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      if (sp > maxAllowedSpeed) {
        const ratio = maxAllowedSpeed / sp
        v.x *= ratio
        v.y *= ratio
        v.z *= ratio
      }
    }
  }

  const calibrated = _measureThrowStats(velocities, positions, floorY)
  return {
    ...calibrated,
    velocityScaleApplied: scale
  }
}

function _measureThrowStats(velocities, positions, floorY) {
  const throws = []
  const speeds = []
  for (let i = 0; i < velocities.length; i++) {
    const v = velocities[i]
    const p = positions[i]
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    const horizontal = Math.sqrt(v.x * v.x + v.z * v.z)
    const startHeight = Math.max(0, Number(p?.y || 0) - floorY)
    const time =
      (v.y + Math.sqrt(Math.max(0, v.y * v.y + 2 * GRAVITY_ACCELERATION * startHeight))) /
      GRAVITY_ACCELERATION
    throws.push(horizontal * Math.max(0, time))
    speeds.push(speed)
  }
  speeds.sort((a, b) => a - b)
  const velocityMean = speeds.reduce((sum, value) => sum + value, 0) / speeds.length
  const p95Index = Math.min(speeds.length - 1, Math.floor(speeds.length * 0.95))
  return {
    throwDistanceAvg: throws.reduce((sum, value) => sum + value, 0) / throws.length,
    throwDistanceMax: Math.max(...throws),
    velocityMean,
    velocityP95: speeds[p95Index]
  }
}

export default { generateFragmentSpecs }
