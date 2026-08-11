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
  generateSwebrecHistogram,
  binHistogram,
  computeKLDivergence
} from '../computation/kcoModelCore.js'
import { makeRng, selectVariantBySize } from './rockGeometryFactory.js'

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
  const count = Math.min(safeCountLimit, Math.max(40, blendedCount))

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
    const explosiveSpecificEnergy = {
      emulsion: 3.9e6,
      anfo: 2.484e6,
      dynamite: 3.56e6
    }
    const Eg = explosiveSpecificEnergy[metrics.explosiveType || 'emulsion'] || 3.9e6
    const q = chargeKg / Number(metrics.volumeRoundM3) // 比装药 kg/m³
    const eta = 0.15 // 能量耦合系数
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
        // 1. KCO Swebrec 采样物理尺寸，叠加孔型粒径系数与延时块度衰减
        const physSize = sampleSwebrecSize(x50, xmax, n, b, rng) * w.sizeFactor * delaySizeFactor

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
          rng
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
        const density = 2500 + rng() * 500
        generatedMassKg += _computeFragmentMassKg(physSize, density)

        specs.push({
          physSize,
          dispSize,
          density,
          restitution: 0.38,
          friction: 0.5,
          maxBounces: 4,
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
      // 1. KCO Swebrec 采样物理尺寸
      const physSize = sampleSwebrecSize(x50, xmax, n, b, rng)

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
        rng
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
      const density = 2500 + rng() * 500
      generatedMassKg += _computeFragmentMassKg(physSize, density)

      specs.push({
        physSize,
        dispSize,
        density,
        restitution: 0.15,
        friction: 0.7,
        maxBounces: 2,
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

  // ─── 分布直方图诊断（分布闭合） ───
  const safeXmaxForHist = Math.max(0.1, Number(metrics.fragmentXmax) || Number(kco?.xmax) || 2.0)
  const sizeBinCount = 20
  const sizeBinWidth = safeXmaxForHist / sizeBinCount
  const sizeBinEdges = Array.from({ length: sizeBinCount + 1 }, (_, i) => i * sizeBinWidth)

  // 实际块度直方图（基于生成碎石的 physSize）
  const sizeValues = specs.map(s => Number(s.physSize) || 0)
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
      fragmentCountTarget: count,
      fragmentCountGenerated: specs.length,
      fragmentMassTargetKg: targetVisibleMassKg || generatedMassKg,
      fragmentMassGeneratedKg: scaledMassKg,
      fragmentMassCoverage:
        targetVisibleMassKg > 0 ? scaledMassKg / Math.max(1, targetVisibleMassKg) : 1,
      visibleMassFraction,
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
    total += _computeFragmentMassKg(sampleSwebrecSize(x50, xmax, n, b, rng), density)
  }
  return total / sampleCount
}

function _computeVisibleMassFraction(metrics, chargeKg) {
  // 可见质量分数：控制崩落体中参与渲染的飞石比例
  // 调高至 30%~80% 区间，确保碎石量充足，视觉效果饱满
  const specificCharge = Number(metrics.specificChargeKgM3) || 0
  const throwAvg = Number(metrics.throwDistanceTargetAvg) || 0
  const chargeTerm = Math.min(0.2, Math.sqrt(Math.max(1, chargeKg)) * 0.0075)
  const specificTerm = Math.min(0.15, specificCharge * 0.11)
  const throwTerm = Math.min(0.12, throwAvg * 0.0075)
  return Math.max(0.3, Math.min(0.8, 0.25 + chargeTerm + specificTerm + throwTerm))
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
  rng = Math.random
) {
  // ─── 发射运动学常量（来源标注：文献/标定/经验值）───
  const BASE_LAUNCH_ANGLE = Math.PI * 0.25 // 45° 最优射程角（弹道学经典值，文献）
  const ANGLE_BIAS_LIMIT = 0.6 // 大/小块抛角偏差上限 rad（工程经验值，未标定）
  const SIZE_RATIO_REF = 0.5 // sizeRatio 基准点：physSize=x50 时 angleBias=0（工程经验值）
  const ANGLE_JITTER = Math.PI * 0.12 // ±10.8° 随机扰动（工程经验值，未标定）
  const LAUNCH_ANGLE_MIN = 0.08 // ~4.6° 下限，防水平抛射（工程经验值）
  const LAUNCH_ANGLE_MAX = Math.PI * 0.48 // ~86.4° 上限，防垂直抛射（工程经验值）
  const AZIMUTH_SPREAD = Math.PI * 0.67 // ±60° 锥形扩散，受隧道断面约束（工程经验值）
  const V_VARIATION_BASE = 0.75 // 速度随机下界（工程经验值，未标定）
  const V_VARIATION_RANGE = 0.5 // 速度随机范围 → [0.75, 1.25]（工程经验值）
  const AXIAL_WEIGHT = 0.85 // 轴向分量权重，掌子面法向主导（工程经验值，未标定）
  const LATERAL_WEIGHT = 0.7 // 横向分量权重（工程经验值，未标定）
  // 注：AXIAL_WEIGHT/LATERAL_WEIGHT 不满足单位向量条件，
  // 未来应改为基于掌子面法向与隧道轴向的几何投影（见 OPTIMIZATION_PLAN 问题4）

  // 发射角：大块低抛，小块高抛，严格限制在 (0, π/2) 确保只向隧道内抛掷
  const sizeRatio = physSize / Math.max(0.1, x50)
  const angleBias = Math.max(-ANGLE_BIAS_LIMIT, Math.min(ANGLE_BIAS_LIMIT, (SIZE_RATIO_REF - sizeRatio) * ANGLE_BIAS_LIMIT))
  // 叠加孔型与延时场轴向偏置，使速度方向轴向占比变化
  let launchAngle = BASE_LAUNCH_ANGLE + angleBias + (rng() - 0.5) * ANGLE_JITTER + axialBias
  launchAngle = Math.max(LAUNCH_ANGLE_MIN, Math.min(LAUNCH_ANGLE_MAX, launchAngle))

  // 方位角：锥形扩散（收窄，避免碎片飞过大截面侧散到岩体内）
  const azimuth = (rng() - 0.5) * AZIMUTH_SPREAD

  // 尺寸因子：动能均分 v ∝ (m_mean/m)^{1/3} = x50/physSize（m ∝ physSize³）
  // 加上界 MAX_SIZE_FACTOR 防止 physSize→0 时发散；下界不裁剪（小碎片该慢就慢）
  const MAX_SIZE_FACTOR = 3.0 // 工程经验值：小碎片速度上限 = vBase × 3（对应 physSize ≈ x50/3）
  const sizeFactor = Math.min(x50 / Math.max(0.1, physSize), MAX_SIZE_FACTOR)
  const vVariation = V_VARIATION_BASE + rng() * V_VARIATION_RANGE
  const speed = Math.max(0.5, vBase * sizeFactor * vVariation) // 下界 0.5 m/s 防静止，无硬编码上界

  // 速度分解：轴向加强向前，横向收窄，竖向保留
  // 使用 abs 确保轴向始终指向隧道内
  const cosLaunch = Math.abs(Math.cos(launchAngle))
  const axialComp = cosLaunch * Math.cos(azimuth) * speed * AXIAL_WEIGHT
  const lateralComp = cosLaunch * Math.sin(azimuth) * speed * LATERAL_WEIGHT
  const verticalComp = Math.sin(launchAngle) * speed

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
