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

import { sampleSwebrecSize } from '../computation/kcoModelCore.js'
import { mulberry32 } from '../computation/blastPhysicsEngine.js'
import { selectVariantBySize, getCollisionRadiusScale } from './rockGeometryFactory.js'

/**
 * 计算尺寸相关的碰撞物性参数
 * 大块碎片：低恢复系数（撞击塑性变形多）+ 低摩擦（表面相对平整）
 * 小块碎片：高恢复系数（弹性好）+ 高摩擦（表面粗糙度高）
 *
 * @param {number} physSize - 碎块物理尺寸(m)
 * @param {number} x50 - KCO 中位块度(m)
 * @param {number} variantIndex - 几何体变体索引
 * @returns {{interRestitution:number, interFriction:number, collisionRadiusScale:number}}
 */
export function computeSizeDependentCollisionParams(physSize, x50, variantIndex) {
  const sizeRatio = physSize / Math.max(0.05, x50)
  // 大块(sizeRatio>2)→0.06，小块(sizeRatio<0.3)→0.38
  const interRestitution = Math.max(0.06, Math.min(0.38, 0.38 - (sizeRatio - 0.3) * 0.18))
  // 大块→0.18，小块→0.60
  const interFriction = Math.max(0.18, Math.min(0.60, 0.18 + (1.0 - Math.min(1, sizeRatio)) * 0.42))
  const collisionRadiusScale = getCollisionRadiusScale(variantIndex)
  return { interRestitution, interFriction, collisionRadiusScale }
}

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
 * 基于破碎方量与 Swebrec 分布期望单块体积，自动计算所需碎片数（量级匹配）
 * 当无数据导入（fragmentCount）时，由 volumePerRound 驱动碎片数量，
 * 使碎片总体积与掌子面破碎方量在同一量级。
 *
 * @param {number} volumePerRound - 单循环爆破方量(m³) = sectionArea × advanceDepth
 * @param {number} breakingRatio - 破碎比例（默认 0.6，断面中央破碎区占 60%）
 * @param {{x50:number,xmax:number,b:number,n:number}} kco - KCO 模型输出
 * @param {Function} rng - 随机数生成器
 * @returns {number} 所需碎片数
 */
export function computeFragmentCountByVolume(volumePerRound, breakingRatio, kco, rng) {
  const { x50, xmax, b, n } = kco
  const safeX50 = Math.max(0.01, x50)
  const safeXmax = Math.max(safeX50 * 1.01, xmax)
  const brokenVolume = volumePerRound * breakingRatio
  // 预采样 500 个 physSize，计算期望单块体积 E[V] = (π/6) × E[physSize³]
  const sampleN = 500
  let sumVolume = 0
  for (let i = 0; i < sampleN; i++) {
    const ps = sampleSwebrecSize(safeX50, safeXmax, n, b, rng)
    sumVolume += (Math.PI / 6) * ps * ps * ps
  }
  const avgFragmentVolume = Math.max(1e-6, sumVolume / sampleN)
  const count = Math.floor(brokenVolume / avgFragmentVolume)
  return count
}

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
  const { kco, face, chargeKg = 320, targetCount, holes, volumePerRound, breakingRatio = 0.6 } = options
  const rng = options.rng || Math.random
  if (!kco || !face) {
    throw new Error('[FragmentSpecGenerator] 缺少必要参数 kco 或 face')
  }

  const { x50, xmax, b, n } = kco

  // x80 估算（用于 variantIndex 分级）：Swebrec 分布中 x80 ≈ x50 × (1 + b^0.3)
  const safeX50 = Math.max(0.01, x50)
  const safeXmax = Math.max(safeX50 * 1.01, xmax)
  const estX80 = safeX50 * (1 + Math.pow(Math.max(0.1, b), 0.3))

  // n 因子：块度均匀时减少碎片数，分散时增加
  const nFactor = 1 + (1.2 - n) * 0.5
  // 碎片数量计算优先级：体积驱动 volumePerRound > 数据导入 fragmentCount > 回退 chargeKg×0.5
  // 体积驱动优先：种子数据中的 fragmentCount 多为早期硬编码小值，不应阻断物理计算
  let baseCount
  if (volumePerRound != null && volumePerRound > 0) {
    // 体积驱动模式：由破碎方量自动计算（量级匹配，用户核心需求）
    baseCount = computeFragmentCountByVolume(volumePerRound, breakingRatio, kco, rng)
  } else if (targetCount != null && targetCount > 0) {
    // 数据导入模式：无体积数据时使用 DB 值
    baseCount = targetCount
  } else {
    // 回退模式：装药量驱动
    baseCount = chargeKg * 0.5
  }
  const count = Math.min(3000, Math.max(60, Math.floor(baseCount * nFactor)))

  // 显示缩放因子：xmax 越小放大越多，保证小块可见
  const dispScale = Math.max(1.5, Math.min(4.0, 4.0 / Math.max(0.5, xmax)))

  // 速度基准（增大抛掷力度，碎片飞行更明显）
  const vBase = 6 + Math.sqrt(Math.max(1, chargeKg)) * 0.3

  // 面向开挖侧的抛掷方向（掌子面法线指向岩体，碎片反向抛出）
  const throwNx = -face.nx
  const throwNy = -face.ny
  const throwNz = -face.nz

  const specs = []
  const positions = []
  const velocities = []

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
      holeAllocations = validHoles.map(h => ({ hole: h, count: Math.ceil(count / validHoles.length) }))
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

  if (useHoleDriven) {
    // ── 炮孔驱动模式：逐孔生成碎片 ──
    for (const alloc of holeAllocations) {
      const h = alloc.hole
      const holeChargeKg = Number(h.chargeKg) || 0
      const delayTime = (Number(h.delayMs) || 0) / 1000 // ms → s

      // 局部速度基准：单孔装药量越大，该孔碎片初速越高
      // vBase_hole = vBase × (holeChargeKg / avgHoleChargeKg)^0.4
      const avgCharge = chargeKg / validHoles.length
      const chargeRatio = Math.max(0.3, Math.min(2.5, holeChargeKg / Math.max(0.1, avgCharge)))
      const vBaseHole = vBase * Math.pow(chargeRatio, 0.4)

      // 孔位世界坐标
      const holeWorldPos = {
        x: face.cx + face.rx * (h.x || 0) + face.ux * (h.y || 0),
        y: face.cy + face.ry * (h.x || 0) + face.uy * (h.y || 0),
        z: face.cz + face.rz * (h.x || 0) + face.uz * (h.y || 0)
      }

      for (let i = 0; i < alloc.count; i++) {
        // 1. KCO Swebrec 采样物理尺寸
        const physSize = sampleSwebrecSize(x50, xmax, n, b, rng)

        // 2. 显示尺寸
        const dispSize = Math.max(0.15, physSize * dispScale)  // 最小显示 15cm，保证远景可见

        // 3. 从孔附近高斯采样位置（σ = 0.35m，模拟炮孔破裂范围）
        const facePos = _sampleNearHole(face, holeWorldPos, 0.35, rng)

        // 4. 用孔局部 vBase 计算发射速度
        const vel = _computeLaunchVelocity(physSize, x50, vBaseHole, throwNx, throwNy, throwNz, face, rng)

        // 5. 岩石颜色
        const sizeNorm = Math.min(1, physSize / Math.max(0.1, xmax))
        const brown = 0.60 - sizeNorm * 0.40 + (rng() - 0.5) * 0.08
        const color = {
          r: Math.max(0.15, brown),
          g: Math.max(0.12, brown * 0.72),
          b: Math.max(0.08, brown * 0.45)
        }

        // 6. 岩石密度
        const density = 2500 + rng() * 500

        // 7. 尺寸相关碰撞物性
        const variantIndex = selectVariantBySize(physSize, safeX50, estX80, safeXmax, rng)
        const { interRestitution, interFriction, collisionRadiusScale } =
          computeSizeDependentCollisionParams(physSize, safeX50, variantIndex)

        specs.push({
          physSize,
          dispSize,
          density,
          restitution: 0.38,
          friction: 0.5,
          maxBounces: 4,
          variantIndex,
          color,
          delayTime, // 分段起爆延迟（秒），物理引擎在 simTime < delayTime 时跳过该碎片
          interRestitution,
          interFriction,
          collisionRadiusScale
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
      const dispSize = Math.max(0.15, physSize * dispScale)  // 最小显示 15cm，保证远景可见

      // 3. 在掌子面表面采样位置
      const facePos = _sampleFacePosition(face, rng)

      // 4. 计算发射速度
      const vel = _computeLaunchVelocity(physSize, x50, vBase, throwNx, throwNy, throwNz, face, rng)

      // 5. 岩石颜色（大块深褐色，小块浅灰色）
      const sizeNorm = Math.min(1, physSize / Math.max(0.1, xmax))
      const brown = 0.60 - sizeNorm * 0.40 + (rng() - 0.5) * 0.08
      const color = {
        r: Math.max(0.15, brown),
        g: Math.max(0.12, brown * 0.72),
        b: Math.max(0.08, brown * 0.45)
      }

      // 6. 岩石密度（花岗岩典型范围）
      const density = 2500 + rng() * 500

      // 7. 尺寸相关碰撞物性
      const variantIndex = selectVariantBySize(physSize, safeX50, estX80, safeXmax, rng)
      const { interRestitution, interFriction, collisionRadiusScale } =
        computeSizeDependentCollisionParams(physSize, safeX50, variantIndex)

      specs.push({
        physSize,
        dispSize,
        density,
        restitution: 0.38,
        friction: 0.5,
        maxBounces: 4,
        variantIndex,
        color,
        delayTime: 0, // 无延迟，立即起爆
        interRestitution,
        interFriction,
        collisionRadiusScale
      })

      positions.push(facePos)
      velocities.push(vel)
    }
  }

  return { specs, positions, velocities }
}

/**
 * 在指定炮孔附近高斯采样一个位置
 * @param {FaceGeometry} face - 掌子面几何描述
 * @param {{x:number,y:number,z:number}} holeWorldPos - 孔位世界坐标
 * @param {number} sigma - 高斯采样标准差(m)
 * @returns {{x:number,y:number,z:number}}
 */
function _sampleNearHole(face, holeWorldPos, sigma, rng) {
  // Box-Muller 高斯采样
  const u1 = rng() || 1e-6
  const u2 = rng()
  const r = Math.sqrt(-2 * Math.log(u1))
  const dx = r * Math.cos(2 * Math.PI * u2) * sigma
  const dy = r * Math.sin(2 * Math.PI * u2) * sigma
  return {
    x: holeWorldPos.x + face.rx * dx + face.ux * dy,
    y: holeWorldPos.y + face.ry * dx + face.uy * dy,
    z: holeWorldPos.z + face.rz * dx + face.uz * dy
  }
}

/**
 * 在掌子面表面采样一个位置
 * 使用 rejection sampling 确保点位于断面形状内
 * @param {FaceGeometry} face
 * @returns {{x:number,y:number,z:number}}
 */
function _sampleFacePosition(face, rng) {
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
 * 计算碎片发射速度
 * 大块碎片角度低、速度快（抛得远）；小块碎片角度高、速度分布广
 * @param {number} physSize
 * @param {number} x50
 * @param {number} vBase
 * @param {number} nx/ny/nz - 抛掷方向（已开挖侧）
 * @param {FaceGeometry} face
 * @returns {{x:number,y:number,z:number}}
 */
function _computeLaunchVelocity(physSize, x50, vBase, nx, ny, nz, face, rng) {
  // 发射角：大块低抛，小块高抛，严格限制在 (0, π/2) 确保只向隧道内抛掷
  const sizeRatio = physSize / Math.max(0.1, x50)
  const angleBias = Math.max(-0.6, Math.min(0.6, (0.5 - sizeRatio) * 0.6))
  let launchAngle = (Math.PI * 0.25 + angleBias) + (rng() - 0.5) * Math.PI * 0.12
  launchAngle = Math.max(0.08, Math.min(Math.PI * 0.48, launchAngle))

  // 方位角：锥形扩散 ±60°（收窄，避免碎片飞过大截面侧散到岩体内）
  const azimuth = (rng() - 0.5) * Math.PI * 0.67

  // 尺寸因子：小碎片加速
  const sizeFactor = Math.pow(x50 / Math.max(0.1, physSize), 1.0)
  const vVariation = 0.75 + rng() * 0.5
  // 隧道爆破实测抛速 5-20 m/s，钳制区间 [5,22] m/s（工程依据：隧道爆破现场高速摄影实测）
  const speed = Math.max(5, Math.min(22, vBase * sizeFactor * vVariation))

  // 速度分解：轴向×0.85（加强向前），横向×0.7，竖向×1.0
  // 使用 abs 确保轴向始终指向隧道内
  const cosLaunch = Math.abs(Math.cos(launchAngle))
  const axialComp = cosLaunch * Math.cos(azimuth) * speed * 0.85
  const lateralComp = cosLaunch * Math.sin(azimuth) * speed * 0.7
  const verticalComp = Math.sin(launchAngle) * speed

  return {
    x: nx * axialComp + face.rx * lateralComp + face.ux * verticalComp,
    y: ny * axialComp + face.ry * lateralComp + face.uy * verticalComp,
    z: nz * axialComp + face.rz * lateralComp + face.uz * verticalComp
  }
}

export default { generateFragmentSpecs, computeSizeDependentCollisionParams }
