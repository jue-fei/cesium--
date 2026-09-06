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

// ─── 延时场耦合参数 ───
// 后序孔因前序孔形成新自由面，块度更细、方向偏向已形成自由面（轴向）
const DELAY_SIZE_DECAY = 0.04 // 每序块度衰减系数
const DELAY_SIZE_FLOOR = 0.8 // 块度衰减下限
const DELAY_DIR_BIAS_PER_ORDER = (5 * Math.PI) / 180 // 每序方向偏移 5°（弧度）
const DELAY_DIR_BIAS_MAX = (20 * Math.PI) / 180 // 方向偏移上限 20°（弧度）

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
 * 生成碎片规格数组
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

  const { x50, xmax, b, n } = kco

  // x80（用于 variantIndex 分级）：优先使用 calculateKCOParams 通过 solveX80 反解得到的 x80
  const safeX50 = Math.max(0.01, x50)
  const safeXmax = Math.max(safeX50 * 1.01, xmax)
  const estX80 = Number(kco?.x80) > 0 ? kco.x80 : safeX50 * 1.5

  // n 因子：块度均匀时减少碎片数，分散时增加
  const nFactor = 1 + (1.2 - n) * 0.5
  const safeCountLimit = Math.max(40, Number(countLimit) || 320)
  const densityBase = Math.max(2200, Number(metrics.rockDensityKgM3) || 2650)
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
    ? Math.round(massDrivenCount * 0.65 + targetCount * nFactor * 0.35)
    : Math.floor(targetCount * nFactor)
  const requestedCount = Math.max(40, blendedCount)
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

  // 速度基准 — Persson(1997) 物理模型为默认，经验拟合仅作 fallback
  //
  // 模型 A（默认，Persson 1997 物理模型）：vBase = √(2·η·q·E_g/ρ_rock)
  //   - q = 比装药 (kg/m³) = chargeKg / brokenVolume
  //   - E_g = 炸药比能 (J/kg)，ANFO≈2.484e6, emulsion≈3.9e6, dynamite≈3.56e6
  //   - ρ_rock = 岩体密度 (kg/m³)
  //   - η = 0.15 能量耦合系数（经验，炸药能量转化为碎片动能的比例）
  //   - 物理依据：炸药总能量 E_total = Q·E_g，转化为碎片动能 E_k = ½·m·v²
  //     假设能量耦合 η，碎片总质量 m = V·ρ_rock，则 v = √(2·η·Q·E_g/(V·ρ_rock)) = √(2·η·q·E_g/ρ_rock)
  //
  // 模型 B（fallback，经验拟合）：vBase = 6 + √Q×0.3
  //   - 仅当 brokenVolume 不可得（≤0）或显式关闭 Persson 时使用
  //   - 量级吻合隧道爆破抛掷速度（5-30 m/s），但加性常数 6 和系数 0.3 无物理依据
  //   - 缺陷：应与比装药 q=Q/V 相关而非总药量 Q
  //
  // 切换：metrics.usePerssonVelocity === false 可强制关闭 Persson（仅诊断用）
  const perssonDisabled = metrics.usePerssonVelocity === false
  const hasVolume = Number(metrics.volumeRoundM3) > 0
  let vBase
  let velocityModel = 'empirical' // 标注当前使用的速度模型
  if (!perssonDisabled && hasVolume) {
    // Persson(1997) 物理模型（默认）
    const Eg =
      EXPLOSIVE_TYPES[metrics.explosiveType || 'emulsion']?.Eg || EXPLOSIVE_TYPES.emulsion.Eg
    const q = chargeKg / Number(metrics.volumeRoundM3) // 比装药 kg/m³
    const eta = Number(metrics.eta) > 0 ? Number(metrics.eta) : 0.15 // 能量耦合系数（UI 可配置，默认 0.15）
    vBase = Math.sqrt((2 * eta * q * Eg) / densityBase)
    velocityModel = 'persson1997'
  } else {
    // 经验拟合公式（fallback：无体积数据或强制关闭 Persson 时）
    vBase = 6 + Math.sqrt(Math.max(1, chargeKg)) * 0.3
  }

  // 面向开挖侧的抛掷方向（掌子面法线指向岩体，碎片反向抛出）
  const throwNx = -face.nx
  const throwNy = -face.ny
  const throwNz = -face.nz

  const specs = []
  const positions = []
  const velocities = []
  let generatedMassKg = 0

  // ── 炮孔参数驱动模式 ──
  // 提供有效 holes 时，按 chargeKg 比例分配碎片数到各孔，位置从孔附近高斯采样，
  // 速度受孔 chargeKg 影响（局部 vBase），delayMs 转换为 delayTime 写入 spec
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

  if (useHoleDriven) {
    // ── 炮孔驱动模式：逐孔生成碎片 ──
    for (const alloc of holeAllocations) {
      const h = alloc.hole
      // 空孔不装药，仅提供自由面，跳过碎石生成
      if (h.holeType === 'empty') continue

      const holeChargeKg = Number(h.chargeKg) || 0
      const delayTime = (Number(h.delayMs) || 0) / 1000 // ms → s

      // 孔型权重（默认辅助孔基准）
      const w = HOLE_TYPE_WEIGHTS[h.holeType] || HOLE_TYPE_WEIGHTS.auxiliary

      // 延时场耦合：后序孔因前序孔形成新自由面，块度更细、方向偏向前方
      const delayOrder = delayOrderMap.get(Number(h.delayMs) || 0) || 0
      const delaySizeFactor =
        delayOrder > 0 ? Math.max(DELAY_SIZE_FLOOR, 1 - DELAY_SIZE_DECAY * delayOrder) : 1
      const delayDirBias =
        delayOrder > 0 ? Math.min(DELAY_DIR_BIAS_MAX, DELAY_DIR_BIAS_PER_ORDER * delayOrder) : 0

      // 局部速度基准：单孔装药量越大，该孔碎片初速越高
      // vBase_hole = vBase × (holeChargeKg / avgHoleChargeKg)^0.4，再叠加孔型速度系数
      const avgCharge = chargeKg / validHoles.length
      const chargeRatio = Math.max(0.3, Math.min(2.5, holeChargeKg / Math.max(0.1, avgCharge)))
      const vBaseHole = vBase * Math.pow(chargeRatio, 0.4) * w.velocityFactor

      // 速度方向轴向偏置（孔型 axialBias + 延时场方向偏移）
      const totalAxialBias = w.axialBias + delayDirBias

      // 孔位世界坐标
      const holeWorldPos = {
        x: face.cx + face.rx * (h.x || 0) + face.ux * (h.y || 0),
        y: face.cy + face.ry * (h.x || 0) + face.uy * (h.y || 0),
        z: face.cz + face.rz * (h.x || 0) + face.uz * (h.y || 0)
      }

      for (let i = 0; i < alloc.count; i++) {
        // 1. KCO Swebrec 等质量分层采样物理尺寸，叠加孔型粒径系数与延时块度衰减
        const physSize =
          sampleSwebrecMassWeighted(x50, xmax, n, b, rng, {
            index: i,
            totalCount: alloc.count
          }) *
          w.sizeFactor *
          delaySizeFactor

        // 2. 显示尺寸
        const dispSize = _computeDisplaySize(physSize)

        // 3. 从孔附近高斯采样位置（σ = 0.35m，模拟炮孔破裂范围）
        const facePos = _sampleNearHole(face, holeWorldPos, 0.35, rng)

        // 4. 用孔局部 vBase 计算发射速度（叠加轴向偏置）
        const vel = _computeLaunchVelocity(
          physSize,
          x50,
          vBaseHole,
          throwNx,
          throwNy,
          throwNz,
          face,
          totalAxialBias,
          rng,
          velocityScale
        )

        // 5. 岩石颜色
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
          restitution: ENHANCED_RESTITUTION,
          friction: ENHANCED_FRICTION,
          maxBounces: ENHANCED_MAX_BOUNCES,
          variantIndex: selectVariantBySize(physSize, safeX50, estX80, safeXmax, rng),
          color,
          delayTime // 分段起爆延迟（秒），物理引擎在 simTime < delayTime 时跳过该碎片
        })

        positions.push(facePos)
        velocities.push(vel)
      }
    }
  } else {
    // ── 传统模式：全掌子面随机采样 ──
    for (let i = 0; i < count; i++) {
      // 1. KCO Swebrec 等质量分层采样物理尺寸
      const physSize = sampleSwebrecMassWeighted(x50, xmax, n, b, rng, {
        index: i,
        totalCount: count
      })

      // 2. 显示尺寸
      const dispSize = _computeDisplaySize(physSize)

      // 3. 在掌子面表面采样位置
      const facePos = _sampleFacePosition(face, rng)

      // 4. 计算发射速度
      const vel = _computeLaunchVelocity(
        physSize,
        x50,
        vBase,
        throwNx,
        throwNy,
        throwNz,
        face,
        0,
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

      // 6. 岩石密度（花岗岩典型范围）
      const density = _sampleFragmentDensity(densityBase, rng)
      generatedMassKg += _computeFragmentMassKg(physSize, density)

      specs.push({
        physSize,
        dispSize,
        density,
        restitution: DEFAULT_RESTITUTION,
        friction: DEFAULT_FRICTION,
        maxBounces: DEFAULT_MAX_BOUNCES,
        variantIndex: selectVariantBySize(physSize, safeX50, estX80, safeXmax, rng),
        color,
        delayTime: 0 // 无延迟，立即起爆
      })

      positions.push(facePos)
      velocities.push(vel)
    }
  }

  // 抛掷校准 — 默认关闭（保留物理速度场），仅当 metrics.enableVelocityCalibration=true 时启用
  //
  // 校准原理：v² ∝ d（抛距），故 v_new = v_old·√(d_target/d_actual)
  // 已知缺陷：校准后速度场失去原始物理含义，属"凑结果"非物理推导
  // 0.65/0.35 加权混合与 [0.55,1.1] 硬夹紧均为工程调参，无理论依据
  const enableCalibration = metrics.enableVelocityCalibration === true
  const velocityStats = _calibrateVelocitiesToThrowTargets({
    velocities,
    positions,
    floorY: Number(face.floorY) || 0,
    targetAvg: enableCalibration ? Number(metrics.throwDistanceTargetAvg) || null : null,
    targetMax: enableCalibration ? Number(metrics.throwDistanceTargetMax) || null : null
  })

  // ─── 崩落体积还原（代表性碎岩）──────────────────────────
  // 真实隧道爆破中 cm~m 级岩块数量达十万~百万级，受实时渲染上限（~数千个）
  // 约束，只能渲染"代表性碎岩"。若直接用真实 KCO 粒径 + 数千个碎片，其总
  // 体积通常只占崩落实方量的个位数~几十个百分点，导致爆堆严重偏矮、摊平。
  // 解法：对全部碎片物理尺寸施加统一体积还原系数
  //   k = (V_target / Σ(π/6·dᵢ³))^(1/3)，V_target = V_崩落 × 可见质量分数 × 碎胀系数
  // 使碎片总物理体积与松散爆堆体积一致，从而填出符合工程量级的堆积高度。
  // 均匀缩放不破坏相对块度层级；真实 KCO 粒径单独存至 physSizeTrue，
  // 供图3-3块度直方图与块度高亮使用（保持级配统计的学术真实性）。
  // 依据：坚硬岩石碎胀系数 1.4~1.6（文献常见 1.5~1.6，取 1.5）；
  // 松散爆堆体积≈崩落实体×碎胀系数。
  const volumeRoundM3restore = Number(metrics.volumeRoundM3) || 0
  const enableVolumeRestore = metrics.enableVolumeRestore !== false
  const bulkFactor = Number(metrics.bulkFactor) > 0 ? Number(metrics.bulkFactor) : 1.5
  let volumeRestoreScale = 1
  let representativeVolumeM3 = 0
  let representativeMassKg = generatedMassKg
  if (enableVolumeRestore && specs.length > 0 && volumeRoundM3restore > 0) {
    const looseTargetM3 = volumeRoundM3restore * visibleMassFraction * bulkFactor
    let trueVolM3 = 0
    for (const s of specs) trueVolM3 += (Math.PI / 6) * s.physSize ** 3
    if (trueVolM3 > 1e-6) {
      const kRaw = Math.cbrt(looseTargetM3 / trueVolM3)
      // 夹紧到 [1, 3.5]：k<1 时无需缩小（已超体积，保持原状避免离谱）；k>3.5 时碎片过
      // 于夸大（>3.5m）会失真，此时由数量兜底，而非单颗无限放大。
      const k = Math.min(3.5, Math.max(1, kRaw))
      let repMass = 0
      let repVol = 0
      for (const s of specs) {
        if (!Number.isFinite(Number(s.physSizeTrue)) || s.physSizeTrue <= 0) {
          s.physSizeTrue = s.physSize // 首次还原前记录真实 KCO 粒径
        }
        s.physSize *= k
        s.dispSize = _computeDisplaySize(s.physSize)
        const vol = (Math.PI / 6) * s.physSize ** 3
        repVol += vol
        repMass += vol * s.density
      }
      volumeRestoreScale = k
      representativeVolumeM3 = repVol
      representativeMassKg = repMass
    }
  }

  // ─── 渲染体积归一化（几何填充率修正，解决"渲染显多/显满"）───────────
  // 渲染 InstancedMesh 的 scale=dispSize，而各变体的实心单位体积 V_unit 差异
  // 巨大（实测 0.22~3.06，≠ 球形口径 π/6≈0.52）。若直接把 dispSize 赋给几何，
  // Σ 渲染实心体积 = Σ V_unit·dispSize³ 会系统性偏大——几何填充越"胖"的变体
  // 显得越多。按变体施加 f=cbrt((π/6)/V_unit) 缩放 dispSize，使渲染实心体积
  // 严格退回到球形账目标 Σ(π/6)·physSize³，堆体不再虚胖。只改 dispSize 不动
  // physSize（质量/块度统计不受影响）；物理碰撞体按 dispSize 与视觉同归一化，
  // 视觉/碰撞口径一致、不脱节。
  const unitVols = getRockVariantUnitVolumes()
  for (const s of specs) {
    const cu = unitVols[s.variantIndex]
    const f = cu > 0.001 ? Math.cbrt(Math.PI / 6 / cu) : 1
    // 夹紧避免极小/极大填充几何被异常放大或缩到离谱（保留形态不致失真）
    s.dispSize *= Math.min(1.4, Math.max(0.5, f))
  }

  // ─── 初始位置推出掌子面并收进断面 ─────────────────────
  // 碎片采样位置在掌子面表面（中心恰在面平面），体积还原后 physSize 最大
  // 可达数米，半个碎片会嵌进岩体，视觉与物理上都表现为"卡在掌子面"。
  // 统一沿面法线反向（已开挖侧）推出 半径+0.05m，使碎片初始完全位于掌子面前方。
  // 之后再按断面形状收拢：渲染网格是 maxR≈1.2~2.0 倍的 dispSize（比物理碰撞体
  // 的 physSize/2 大得多），靠近侧墙/拱顶/底板的大块碎片必须按各自变体的真实
  // 渲染半径收进隧道内，否则碎石网格会穿出隧道外壁。
  const variantMaxRadii = getRockVariantMaxRadius()
  for (let i = 0; i < positions.length; i++) {
    const maxR = variantMaxRadii[specs[i].variantIndex] || 1.2
    // 物理碰撞体已与渲染尺寸对齐（半径 = maxR×dispSize），推出距离按完整视觉半径
    const p = _nudgeOffFace(face, positions[i], specs[i].dispSize * maxR)
    positions[i] = _clampInsideTunnel(face, p, specs[i].dispSize * maxR)
  }

  // ─── 分布直方图诊断（分布闭合） ───
  const safeXmaxForHist = Math.max(0.1, Number(metrics.fragmentXmax) || Number(kco?.xmax) || 2.0)
  const sizeBinCount = 20
  const sizeBinWidth = safeXmaxForHist / sizeBinCount
  const sizeBinEdges = Array.from({ length: sizeBinCount + 1 }, (_, i) => i * sizeBinWidth)

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
    Math.min(safeXmaxForHist * 0.99, Number(metrics.fragmentX50) || Number(kco?.x50) || 0.5)
  )
  const safeBForHist = Math.max(0.1, Number(metrics.fragmentB) || Number(kco?.b) || 2.0)
  const safeNForHist = Number(metrics.fragmentN) || Number(kco?.n) || 1.2
  const sizeHistogramTarget = generateSwebrecHistogram(
    safeX50ForHist,
    safeXmaxForHist,
    safeNForHist,
    safeBForHist,
    sizeBinCount
  )

  // KL 散度（目标 vs 实际）
  const sizeKLDivergence = computeKLDivergence(
    sizeHistogramGenerated.map(b => b.pct),
    sizeHistogramTarget.map(b => b.pct)
  )

  // 实际速度直方图（基于初始速度大小）
  const speedValues = velocities.map(v => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z))
  const maxSpeed = speedValues.length > 0 ? Math.max(...speedValues) : 1
  const velBinCount = 20
  const velBinWidth = Math.max(0.1, maxSpeed) / velBinCount
  const velBinEdges = Array.from({ length: velBinCount + 1 }, (_, i) => i * velBinWidth)
  const velocityHistogramGenerated = binHistogram(speedValues, velBinEdges)

  // 质量放大系数：当碎片数被 countLimit 截断时，每个渲染碎片代表多个实际碎片，
  // 统计总质量按比例放大以反映实际爆破方量（物理模拟仍用真实单碎片质量）。
  const massScaleFactor =
    targetVisibleMassKg > 0 && generatedMassKg > 0
      ? Math.max(1, targetVisibleMassKg / generatedMassKg)
      : 1
  const scaledMassKg = generatedMassKg * massScaleFactor

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
      fragmentCountTarget: requestedCount,
      fragmentCountGenerated: specs.length,
      fragmentMassTargetKg: targetVisibleMassKg || generatedMassKg, // 可见方量目标
      fragmentMassGeneratedKg: generatedMassKg, // 实际生成碎片总质量（未放大，与区间质量求和自洽）
      fragmentMassBlastedKg: scaledMassKg, // 方量估计（按 massScaleFactor 放大，反映爆破方量）
      fragmentMassCoverage:
        targetVisibleMassKg > 0 ? generatedMassKg / Math.max(1, targetVisibleMassKg) : 1,
      blastVolumeM3: Number(metrics.volumeRoundM3) > 0 ? Number(metrics.volumeRoundM3) : null,
      visibleMassFraction,
      bulkFactor,
      volumeRestoreScale,
      representativeVolumeM3,
      representativeMassKg,
      estimatedMeanMassKg,
      velocityMean: velocityStats.velocityMean,
      velocityP95: velocityStats.velocityP95,
      throwDistancePredictedAvg: velocityStats.throwDistanceAvg,
      throwDistancePredictedMax: velocityStats.throwDistanceMax,
      throwDistanceTargetAvg: Number(metrics.throwDistanceTargetAvg) || null,
      throwDistanceTargetMax: Number(metrics.throwDistanceTargetMax) || null,
      velocityScaleApplied: velocityStats.velocityScaleApplied,
      sizeHistogramGenerated,
      sizeHistogramTarget,
      sizeKLDivergence,
      velocityHistogramGenerated
    }
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
 * 在掌子面表面采样一个位置
 * 使用 rejection sampling 确保点位于断面形状内
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
  const sv = 0.97 // 内缩安全系数（断面内边界缓冲）

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
  const visibleFloor = 0.08
  if (size >= visibleFloor) return size
  // 仅对很小的碎石做温和视觉补偿，避免整体体积被系统性放大。
  return visibleFloor * Math.sqrt(size / visibleFloor)
}

function _computeFragmentMassKg(size, density) {
  const diameter = Math.max(0.02, Number(size) || 0.02)
  const rho = Math.max(100, Number(density) || 2650)
  const volume = (4 / 3) * Math.PI * Math.pow(diameter / 2, 3)
  return volume * rho
}

function _estimateMeanFragmentMass({ x50, xmax, b, n, density }, rng = Math.random) {
  let total = 0
  const sampleCount = 96
  for (let i = 0; i < sampleCount; i++) {
    total += _computeFragmentMassKg(
      sampleSwebrecMassWeighted(x50, xmax, n, b, rng, {
        index: i,
        totalCount: sampleCount
      }),
      density
    )
  }
  return total / sampleCount
}

function _sampleFragmentDensity(densityBase, rng = Math.random) {
  const base = Math.max(2200, Number(densityBase) || 2650)
  const variation = 0.94 + rng() * 0.12
  return Math.max(1800, base * variation)
}

function _computeVisibleMassFraction(metrics, chargeKg) {
  // 可见质量分数：控制崩落体中参与渲染的飞石比例
  // 真实全断面掌子面爆破接近整断面破碎，可见比例应尽量高；
  // 提至 50%~97% 区间，配合体积还原使碎石量与爆堆饱满
  const specificCharge = Number(metrics.specificChargeKgM3) || 0
  const throwAvg = Number(metrics.throwDistanceTargetAvg) || 0
  const chargeTerm = Math.min(0.2, Math.sqrt(Math.max(1, chargeKg)) * 0.0085)
  const specificTerm = Math.min(0.15, specificCharge * 0.12)
  const throwTerm = Math.min(0.12, throwAvg * 0.008)
  return Math.max(0.5, Math.min(0.97, 0.45 + chargeTerm + specificTerm + throwTerm))
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

function _isPointInsideFace(face, lx, ly) {
  const shape = face.shape || 'horseshoe'
  const halfW = face.width / 2
  const hw = face.wallHeight
  const r = face.archRadius
  if (shape === 'circular') {
    const dy = ly - r
    return lx * lx + dy * dy <= r * r * 0.98
  }
  if (shape === 'rectangular') {
    return Math.abs(lx) <= halfW * 0.98 && ly >= 0 && ly <= hw * 0.98
  }
  if (ly < 0) return false
  if (ly <= hw) return Math.abs(lx) <= halfW * 0.98
  const dy = ly - hw
  return lx * lx + dy * dy <= r * r * 0.98
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
  const MAX_SIZE_FACTOR = 2.2 // 工程经验值：小碎片速度上限 = vBase × 2.2（旧值 3.0 使细小碎片抛距过远）
  const sizeFactor = Math.min(x50 / Math.max(0.1, physSize), MAX_SIZE_FACTOR)
  const vVariation = V_VARIATION_BASE + rng() * V_VARIATION_RANGE
  // VELOCITY_SCALE：抛掷速度收缩系数（UI 可调，默认 1.0 = 不收缩·纯物理量级）。
  // 历史 0.42 原是面向"隧道舱内近景视域"的视觉收缩——把特征抛速压到物理实测量级，
  // 避免碎片抛满整条隧道、让爆堆紧贴掌子面成形（0.5→0.42 进一步收缩抛散）。
  // 现默认 1.0 不做视觉降速，物理引擎按 Persson 初速的原生量级积分抛掷；
  // 调小该系数 → 抛距收缩、爆堆更贴掌子面。
  const VELOCITY_SCALE = Number(velocityScale) > 0 ? Number(velocityScale) : 1
  const speed = Math.max(0.5, vBase * sizeFactor * vVariation * VELOCITY_SCALE) // 下界 0.5 m/s 防静止

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
  if (targetAvg && currentStats.throwDistanceAvg > 0.1) {
    scale *= Math.sqrt(targetAvg / currentStats.throwDistanceAvg)
  }
  if (targetMax && currentStats.throwDistanceMax > 0.1) {
    const maxScale = Math.sqrt(targetMax / currentStats.throwDistanceMax)
    scale = scale * 0.65 + maxScale * 0.35
  }
  // 注：原 clamp(0.55, 1.1) 已移除——人为裁剪物理结果只会掩盖模型偏差，
  // 应通过 Persson η 标定或 sizeFactor 模型修正源头，而非事后砍 scale。
  // enableCalibration=false 时 targetAvg/targetMax 为 null，scale 恒为 1 不校准。

  if (Math.abs(scale - 1) > 0.03) {
    for (const v of velocities) {
      v.x *= scale
      v.y *= scale
      v.z *= scale
    }
  }

  // 超速碎片单独 cap：校准后仍超过 targetMax 的碎片缩放到上限
  // 防止个别小碎片因 sizeFactor 过大导致最大抛距远超目标
  if (targetMax && targetMax > 0.1) {
    // 简化抛距公式 d ≈ v²/g → v_max = sqrt(d_max * g)
    const maxAllowedSpeed = Math.sqrt(targetMax * 9.8)
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
    const time = (v.y + Math.sqrt(Math.max(0, v.y * v.y + 2 * 9.8 * startHeight))) / 9.8
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
