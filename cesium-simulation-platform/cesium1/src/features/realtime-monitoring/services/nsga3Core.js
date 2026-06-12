/**
 * NSGA-III (Non-dominated Sorting Genetic Algorithm III) 核心算法
 * 用于露天矿运输调度场景下的多目标路径优化。
 *
 * 说明:
 * - 进化阶段采用 NSGA-III 的非支配排序、参考方向和生态位保持机制。
 * - 相比传统 NSGA-II / MOEA/D，更适合 5 个以上目标与更高维路径参数场景。
 * - 展示阶段保留 Pareto 前沿、前沿分层和拥挤距离，便于结果解释与交互选解。
 *
 * 参考文献:
 * - Deb, K. & Jain, H. (2014). "An Evolutionary Many-Objective Optimization Algorithm
 *   Using Reference-Point-Based Nondominated Sorting Approach, Part I: Solving Problems
 *   With Box Constraints." IEEE Trans. on Evolutionary Computation, 18(4), 577-601.
 * - Deb, K. & Agrawal, R.B. (1995). "Simulated Binary Crossover for Continuous Search Space"
 *   Complex Systems, 9(2), 115-148.
 */

// ===================== 算法配置 =====================

const DEFAULT_CONFIG = {
  populationSize: 72,         // 结合 5 目标参考方向，适合 many-objective 展示
  generations: 90,            // 适度增加迭代轮次提升前沿覆盖
  crossoverProbability: 0.9,  // 交叉概率
  mutationProbability: 0.12,  // 变异概率
  etaC: 20,                   // SBX交叉分布指数
  etaM: 20,                   // 多项式变异分布指数
  tournamentSize: 2,          // 兼容旧配置，当前父代选择不使用该参数
  referenceDivisions: 4,      // 5 目标下生成 70 个标准参考方向
  numWaypoints: 6             // 决策变量个数 = 中继点数 * 2，更适合多参数场景
}

// ===================== 目标定义 =====================

const OBJECTIVES = [
  { id: 'd', name: '运输距离', dir: 'min' },
  { id: 't', name: '运输时间', dir: 'min' },
  { id: 'f', name: '燃油消耗', dir: 'min' },
  { id: 's', name: '安全系数', dir: 'max' },
  { id: 'l', name: '重载通行适配性', dir: 'max' }
]

// ===================== 矿山地形系统 =====================

const UNIT_TO_M = 10  // 1 SVG单位 = 10米
const MAX_GRADE = 0.15
const MIN_TURN_RADIUS_SVG = 5   // 5 SVG单位 = 50米
const MIN_TURN_RADIUS_M = MIN_TURN_RADIUS_SVG * UNIT_TO_M
const CONSTRAINT_EPS = 1e-9

/**
 * 危险区域定义
 * 直接对角线穿越将经过爆破区A、设备交叉区，产生真实的安全vs距离trade-off
 */
const HAZARD_ZONES = [
  { cx: 75, cy: 115, r: 16, severity: 0.90, label: '爆破作业区A' },
  { cx: 185, cy: 55, r: 14, severity: 0.85, label: '不稳定边坡' },
  { cx: 135, cy: 85, r: 18, severity: 0.70, label: '设备交叉区' },
  { cx: 55, cy: 55, r: 13, severity: 0.60, label: '积水区' },
  { cx: 225, cy: 105, r: 15, severity: 0.80, label: '爆破作业区B' }
]

/**
 * 矿山高程函数 (SVG坐标 → 海拔m)
 * 三层叠加：基底起伏 + NW-SE主山脊 + 矿坑凹陷
 */
function getElevation(x, y) {
  const nx = x / 280, ny = y / 160

  // 基底起伏
  const base = 50
    + 12 * Math.sin(2 * Math.PI * x / 140) * Math.cos(2 * Math.PI * y / 80)
    + 8 * Math.sin(2 * Math.PI * (x + y) / 100 + 0.7)
    + 6 * Math.cos(2 * Math.PI * x / 90) * Math.sin(2 * Math.PI * y / 55)

  // NW-SE 主山脊 (从左上到右下，贯穿对角线)
  const ridgeNx = 0.30, ridgeNy = -1.0
  const ridgeLen = Math.sqrt(ridgeNx * ridgeNx + ridgeNy * ridgeNy)
  const distFromRidge = Math.abs(ridgeNx * nx + ridgeNy * (ny - 0.65)) / ridgeLen
  const mainRidge = 70 * Math.exp(-distFromRidge * distFromRidge / 0.06)
  const secRidge1 = 35 * Math.exp(-(distFromRidge - 0.12) * (distFromRidge - 0.12) / 0.015)
  const secRidge2 = 35 * Math.exp(-(distFromRidge + 0.12) * (distFromRidge + 0.12) / 0.015)

  // 矿坑凹陷
  const pit1 = -35 * Math.exp(-((x - 130) * (x - 130) + (y - 75) * (y - 75)) / 700)
  const pit2 = -28 * Math.exp(-((x - 210) * (x - 210) + (y - 50) * (y - 50)) / 550)

  return Math.max(0, Math.min(150, base + mainRidge + secRidge1 + secRidge2 + pit1 + pit2))
}

/** 中心差分法计算高程梯度 */
function getElevationGradient(x, y) {
  const eps = 1
  const gx = (getElevation(x + eps, y) - getElevation(x - eps, y)) / (2 * eps)
  const gy = (getElevation(x, y + eps) - getElevation(x, y - eps)) / (2 * eps)
  return { gx, gy, mag: Math.sqrt(gx * gx + gy * gy) }
}

/** 坡度 (小数，如 0.05 = 5%) */
function getGrade(x, y) {
  return getElevationGradient(x, y).mag / UNIT_TO_M
}

/** 沿行进方向的有符号坡度，正值表示上坡，负值表示下坡 */
function getSignedGradeAlongDirection(x, y, dirX, dirY) {
  const dirLen = Math.hypot(dirX, dirY)
  if (dirLen === 0) return 0
  const { gx, gy } = getElevationGradient(x, y)
  return ((gx * dirX) / dirLen + (gy * dirY) / dirLen) / UNIT_TO_M
}

/** 危险暴露度 (0~1)，含缓冲带衰减 */
function getHazardExposure(x, y) {
  let exp = 0
  for (const h of HAZARD_ZONES) {
    const dx = x - h.cx, dy = y - h.cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < h.r) {
      exp += h.severity * (1 - dist / h.r) * (1 - dist / h.r)
    } else if (dist < h.r * 1.5) {
      const t = (dist - h.r) / (h.r * 0.5)
      exp += h.severity * 0.25 * (1 - t)
    }
  }
  return Math.min(1, exp)
}

/** 路面质量 (0~1)，坡度越大质量越低 */
function getRoadQuality(x, y) {
  const grade = getGrade(x, y)
  return Math.max(0.15, Math.min(1, 1 - grade / 0.20))
}

// ===================== 路径采样与几何 =====================

/** 沿线段按子区间中点采样，返回高程/坡度/危险度/路面质量 */
function sampleSegment(a, b, stepMeters = 50) {
  const dx = b.x - a.x, dy = b.y - a.y
  const segLen = Math.sqrt(dx * dx + dy * dy)
  const segLenM = segLen * UNIT_TO_M
  const numIntervals = Math.max(1, Math.ceil(segLenM / stepMeters))
  const results = []
  const subsegDist = segLenM / numIntervals
  for (let k = 0; k < numIntervals; k++) {
    const t = (k + 0.5) / numIntervals
    const x = a.x + t * dx, y = a.y + t * dy
    const signedGrade = getSignedGradeAlongDirection(x, y, dx, dy)
    results.push({
      x, y,
      elev: getElevation(x, y),
      grade: Math.abs(signedGrade),
      signedGrade,
      hazard: getHazardExposure(x, y),
      quality: getRoadQuality(x, y),
      subsegDist
    })
  }
  return results
}

/** 三点外接圆半径 → 转弯半径 */
function computeTurnRadius(prev, curr, next) {
  const a = Math.hypot(curr.x - next.x, curr.y - next.y)
  const b = Math.hypot(prev.x - curr.x, prev.y - curr.y)
  const c = Math.hypot(prev.x - next.x, prev.y - next.y)
  if (a * b === 0) return Infinity
  const area = 0.5 * Math.abs((curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x))
  if (area === 0) return Infinity
  return (a * b * c) / (4 * area)
}

/** 计算约束违规量；排序阶段采用可行性优先，目标值仅保留为软惩罚辅助 */
function computeConstraintViolations(waypoints, allSamples) {
  let gradeExcess = 0, turnDeficit = 0

  for (const s of allSamples) {
    if (s.grade > MAX_GRADE) {
      gradeExcess += (s.grade - MAX_GRADE) * s.subsegDist / 100
    }
  }

  for (let i = 1; i < waypoints.length - 1; i++) {
    const r = computeTurnRadius(waypoints[i - 1], waypoints[i], waypoints[i + 1])
    if (r < MIN_TURN_RADIUS_SVG) {
      turnDeficit += (MIN_TURN_RADIUS_SVG - r) / MIN_TURN_RADIUS_SVG
    }
  }

  const totalViolation = gradeExcess + turnDeficit
  return {
    gradeExcess,
    turnDeficit,
    totalViolation,
    isFeasible: totalViolation <= CONSTRAINT_EPS
  }
}

// ===================== 适应度计算 =====================

/**
 * 根据路径点计算各目标值 — 基于矿山物理模型
 * 决策变量: 路径点序列 [(x1,y1), (x2,y2), ..., (xn,yn)]
 *
 * 5个目标具有明确的工程权衡关系：
 *   d(距离) vs s(安全) — 穿越危险区域可缩短距离，但会降低安全评分
 *   d(距离) vs t(时间) — 坡度和弯道会破坏“距离越短时间越短”的线性关系
 *   f(油耗) vs s(安全) — 安全绕行通常意味着更长路径和更高燃油成本
 *   l(重载通行适配性) vs d(距离) — 适合重载车辆通行的路线通常更平缓、更绕行
 */
function evaluatePath(waypoints) {
  // ---- 1. 路径采样 ----
  const allSamples = []
  let totalDistM = 0

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1]
    const segSamples = sampleSegment(a, b, 50)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const segLenM = segLen * UNIT_TO_M
    totalDistM += segLenM
    for (const s of segSamples) { s.segIdx = i }
    allSamples.push(...segSamples)
  }

  const routeLenKm = totalDistM / 1000

  // ---- 2. 转弯属性 ----
  let totalTurnAngle = 0, minTurnRadius = Infinity, sharpTurns = 0
  for (let i = 1; i < waypoints.length - 1; i++) {
    const dx1 = waypoints[i].x - waypoints[i - 1].x
    const dy1 = waypoints[i].y - waypoints[i - 1].y
    const dx2 = waypoints[i + 1].x - waypoints[i].x
    const dy2 = waypoints[i + 1].y - waypoints[i].y
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2)
    if (len1 > 0 && len2 > 0) {
      const cosA = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)))
      const angle = Math.acos(cosA)
      totalTurnAngle += angle
      if (angle > Math.PI / 6) sharpTurns++
    }
    const r = computeTurnRadius(waypoints[i - 1], waypoints[i], waypoints[i + 1])
    if (r < minTurnRadius) minTurnRadius = r
  }
  if (minTurnRadius === Infinity) minTurnRadius = 50

  // ---- 3. 聚合路径统计 ----
  let maxGrade = 0, sumAbsGrade = 0, totalHazard = 0, sumQuality = 0, totalWeight = 0
  for (const s of allSamples) {
    if (s.grade > maxGrade) maxGrade = s.grade
    sumAbsGrade += s.grade * s.subsegDist
    totalHazard += s.hazard * s.subsegDist
    sumQuality += s.quality * s.subsegDist
    totalWeight += s.subsegDist
  }
  const avgGrade = totalWeight > 0 ? sumAbsGrade / totalWeight : 0
  const avgQuality = totalWeight > 0 ? sumQuality / totalWeight : 1
  const avgHazard = totalDistM > 0 ? totalHazard / totalDistM : 0

  // ---- 4. 约束违规 ----
  const viol = computeConstraintViolations(waypoints, allSamples)

  // ================================================================
  // 目标1: d — 运输距离 (km, 最小化)
  // ================================================================
  let d = routeLenKm + viol.gradeExcess * 0.5

  // ================================================================
  // 目标2: t — 运输时间 (min, 最小化)
  // 分段变速模型：速度 = 35 × 坡度折减 × 路面质量折减，含弯道减速
  // ================================================================
  let t = 0
  for (const s of allSamples) {
    const subKm = s.subsegDist / 1000
    const gradeFactor = s.signedGrade >= 0
      ? Math.max(0.14, 1 - s.signedGrade / 0.18)
      : Math.min(1.12, 1 + Math.abs(s.signedGrade) * 0.35)
    const qualityFactor = 0.8 + 0.2 * s.quality
    const speed = Math.max(5, 35 * gradeFactor * qualityFactor)
    t += subKm / speed * 60
  }
  // 弯道减速：每个急弯(>20°)增加0.3~0.8分钟
  for (let i = 1; i < waypoints.length - 1; i++) {
    const dx1 = waypoints[i].x - waypoints[i - 1].x, dy1 = waypoints[i].y - waypoints[i - 1].y
    const dx2 = waypoints[i + 1].x - waypoints[i].x, dy2 = waypoints[i + 1].y - waypoints[i].y
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2)
    if (len1 > 0 && len2 > 0) {
      const cosA = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)))
      const angle = Math.acos(cosA)
      if (angle > Math.PI / 9) t += 0.3 + (angle / Math.PI) * 0.5
    }
  }
  t += viol.gradeExcess * 1.0 + viol.turnDeficit * 0.5

  // ================================================================
  // 目标3: f — 燃油消耗 (L, 最小化)
  // 基础油耗7.5L/km，上坡×8倍，下坡×2倍，劣质路面+40%
  // ================================================================
  let f = 0
  for (const s of allSamples) {
    const subKm = s.subsegDist / 1000
    const gradeFuel = s.signedGrade >= 0
      ? 1 + s.signedGrade * 8
      : Math.max(0.65, 1 + s.signedGrade * 2)
    const roadFuel = 1 + (1 - s.quality) * 0.4
    f += subKm * 7.5 * gradeFuel * roadFuel
  }
  // 弯道油耗：出弯加速额外消耗
  for (let i = 1; i < waypoints.length - 1; i++) {
    const dx1 = waypoints[i].x - waypoints[i - 1].x, dy1 = waypoints[i].y - waypoints[i - 1].y
    const dx2 = waypoints[i + 1].x - waypoints[i].x, dy2 = waypoints[i + 1].y - waypoints[i].y
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2)
    if (len1 > 0 && len2 > 0) {
      const cosA = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)))
      f += (Math.acos(cosA) / Math.PI) * 0.6
    }
  }
  f += viol.gradeExcess * 1.5 + viol.turnDeficit * 1.0

  // ================================================================
  // 目标4: s — 安全系数 (0-100, 最大化)
  // 50%危险回避 + 30%坡度安全 + 20%转弯安全
  // ================================================================
  const hazardScore = 100 * (1 - Math.min(1, avgHazard / 0.5))
  const gradeScore = 100 * (1 - Math.min(1, maxGrade / 0.20))
  const radiusScore = 100 * Math.min(1, minTurnRadius / 15)
  let s = 0.50 * hazardScore + 0.30 * gradeScore + 0.20 * radiusScore
  s -= viol.gradeExcess * 4 + viol.turnDeficit * 3
  s = Math.max(1, Math.min(100, s))

  // ================================================================
  // 目标5: l — 重载通行适配性 (0-100, 最大化)
  // 40%路面质量 + 40%坡度限制 + 20%弯道限制
  // ================================================================
  const qualityScoreL = 100 * (0.3 + 0.7 * avgQuality)
  const gradeScoreL = 100 * (1 - Math.min(1, avgGrade / 0.12))
  const turnScoreL = 100 * Math.max(0, 1 - sharpTurns * 0.12)
  let l = 0.40 * qualityScoreL + 0.40 * gradeScoreL + 0.20 * turnScoreL
  l -= viol.gradeExcess * 6 + viol.turnDeficit * 4
  l = Math.max(1, Math.min(100, l))

  // ---- 5. 最终钳制 ----
  d = Math.max(0.1, d)
  t = Math.max(0.5, t)
  f = Math.max(0.5, f)

  const avgSpeedKmh = t > 0.01 ? routeLenKm / t * 60 : 35

  return {
    d, t, f, s, l,
    _constraint: viol,
    _params: {
      routeLen: routeLenKm,
      maxGrade: maxGrade * 100,
      avgGrade: avgGrade * 100,
      totalTurn: totalTurnAngle,
      totalTurnDeg: totalTurnAngle * 180 / Math.PI,
      hazardExposure: avgHazard,
      avgSpeed: avgSpeedKmh,
      minTurnRadius,
      minTurnRadiusM: minTurnRadius * UNIT_TO_M,
      minTurnRadiusLimitSvg: MIN_TURN_RADIUS_SVG,
      minTurnRadiusLimitM: MIN_TURN_RADIUS_M,
      roadQuality: avgQuality,
      numSharpTurns: sharpTurns
    }
  }
}

// ===================== 支配关系判断 =====================

/**
 * 比较两个个体的支配关系
 * @returns -1: a支配b, 1: b支配a, 0: 互不支配
 */
function compareDominance(a, b) {
  const aConstraint = a.objectives._constraint || { isFeasible: true, totalViolation: 0 }
  const bConstraint = b.objectives._constraint || { isFeasible: true, totalViolation: 0 }

  if (aConstraint.isFeasible !== bConstraint.isFeasible) {
    return aConstraint.isFeasible ? -1 : 1
  }

  if (!aConstraint.isFeasible && !bConstraint.isFeasible) {
    if (Math.abs(aConstraint.totalViolation - bConstraint.totalViolation) > CONSTRAINT_EPS) {
      return aConstraint.totalViolation < bConstraint.totalViolation ? -1 : 1
    }
    return 0
  }

  let aBetter = false
  let bBetter = false

  for (const obj of OBJECTIVES) {
    const va = a.objectives[obj.id]
    const vb = b.objectives[obj.id]

    if (obj.dir === 'min') {
      if (va < vb) aBetter = true
      else if (vb < va) bBetter = true
    } else {
      if (va > vb) aBetter = true
      else if (vb > va) bBetter = true
    }

    if (aBetter && bBetter) return 0  // 互不支配
  }

  if (aBetter) return -1  // a支配b
  if (bBetter) return 1   // b支配a
  return 0                // 完全相同
}

// ===================== 快速非支配排序 =====================

function fastNonDominatedSort(population) {
  const fronts = [[]]
  const dominatesSet = new Array(population.length).fill(null).map(() => [])
  const dominationCount = new Array(population.length).fill(0)

  for (let i = 0; i < population.length; i++) {
    for (let j = i + 1; j < population.length; j++) {
      const dominance = compareDominance(population[i], population[j])
      if (dominance < 0) {
        // i 支配 j → S_i 加入 j，n_j 增加
        dominatesSet[i].push(j)
        dominationCount[j]++
      } else if (dominance > 0) {
        // j 支配 i → S_j 加入 i，n_i 增加
        dominatesSet[j].push(i)
        dominationCount[i]++
      }
    }
    if (dominationCount[i] === 0) {
      population[i].rank = 0
      fronts[0].push(i)
    }
  }

  let fi = 0
  while (fronts[fi] && fronts[fi].length > 0) {
    const nextFront = []
    for (const idx of fronts[fi]) {
      for (const q of dominatesSet[idx]) {
        dominationCount[q]--
        if (dominationCount[q] === 0) {
          population[q].rank = fi + 1
          nextFront.push(q)
        }
      }
    }
    fi++
    if (nextFront.length > 0) fronts.push(nextFront)
  }

  return fronts
}

// ===================== 拥挤距离计算 =====================

function calculateCrowdingDistance(front, population) {
  if (front.length === 0) return

  for (const idx of front) {
    population[idx].crowdingDistance = 0
  }

  for (const obj of OBJECTIVES) {
    const sorted = [...front].sort((a, b) => {
      return population[a].objectives[obj.id] - population[b].objectives[obj.id]
    })

    population[sorted[0]].crowdingDistance += 1e10
    population[sorted[sorted.length - 1]].crowdingDistance += 1e10

    const objMin = population[sorted[0]].objectives[obj.id]
    const objMax = population[sorted[sorted.length - 1]].objectives[obj.id]
    const range = objMax - objMin

    if (range === 0) continue

    for (let i = 1; i < sorted.length - 1; i++) {
      const nextVal = population[sorted[i + 1]].objectives[obj.id]
      const prevVal = population[sorted[i - 1]].objectives[obj.id]
      population[sorted[i]].crowdingDistance += (nextVal - prevVal) / range
    }
  }
}

// ===================== NSGA-III 参考方向与归一化 =====================

function normalizeReferencePoint(point) {
  const sum = point.reduce((acc, value) => acc + Math.max(0, value), 0)
  if (sum <= 1e-12) {
    return new Array(point.length).fill(1 / point.length)
  }
  return point.map(value => Math.max(0, value) / sum)
}

function moveReferencePointToInterior(point, alpha) {
  const center = 1 / point.length
  return normalizeReferencePoint(
    point.map(value => (1 - alpha) * value + alpha * center)
  )
}

function appendUniqueReferencePoints(target, candidates, seen) {
  for (const candidate of candidates) {
    const normalized = normalizeReferencePoint(candidate)
    const key = normalized.map(value => value.toFixed(6)).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    target.push(normalized)
  }
}

function generateReferencePoints(dim, divisions) {
  const points = []
  const current = new Array(dim).fill(0)

  function dfs(depth, remain) {
    if (depth === dim - 1) {
      current[depth] = remain / divisions
      points.push([...current])
      return
    }

    for (let i = 0; i <= remain; i++) {
      current[depth] = i / divisions
      dfs(depth + 1, remain - i)
    }
  }

  dfs(0, divisions)
  return points
}

function fitReferencePoints(referencePoints, targetCount, divisions) {
  if (referencePoints.length === targetCount) return referencePoints

  if (referencePoints.length > targetCount) {
    const result = []
    const step = referencePoints.length / targetCount
    for (let i = 0; i < targetCount; i++) {
      result.push(referencePoints[Math.floor(i * step)])
    }
    return result
  }

  const extended = []
  const seen = new Set()
  appendUniqueReferencePoints(extended, referencePoints, seen)

  const shrinkFactors = [0.5, 0.25, 0.75]
  for (const alpha of shrinkFactors) {
    for (let div = Math.max(1, divisions - 1); div >= 1 && extended.length < targetCount; div--) {
      const layer = generateReferencePoints(OBJECTIVES.length, div).map(
        point => moveReferencePointToInterior(point, alpha)
      )
      appendUniqueReferencePoints(extended, layer, seen)
    }
    if (extended.length >= targetCount) break
  }

  if (extended.length < targetCount) {
    appendUniqueReferencePoints(
      extended,
      [new Array(OBJECTIVES.length).fill(1 / OBJECTIVES.length)],
      seen
    )
  }

  if (extended.length < targetCount) {
    const emphasis = 0.55
    const spread = (1 - emphasis) / (OBJECTIVES.length - 1)
    const anchors = []
    for (let i = 0; i < OBJECTIVES.length; i++) {
      const point = new Array(OBJECTIVES.length).fill(spread)
      point[i] = emphasis
      anchors.push(moveReferencePointToInterior(point, 0.35))
    }
    appendUniqueReferencePoints(extended, anchors, seen)
  }

  return extended.slice(0, targetCount)
}

function getMinimizationValue(objectives, objectiveIndex) {
  const objective = OBJECTIVES[objectiveIndex]
  const value = objectives[objective.id]
  return objective.dir === 'min' ? value : -value
}

function buildNormalizationBounds(population) {
  const ideal = new Array(OBJECTIVES.length).fill(Infinity)
  const nadir = new Array(OBJECTIVES.length).fill(-Infinity)

  for (const individual of population) {
    for (let j = 0; j < OBJECTIVES.length; j++) {
      const value = getMinimizationValue(individual.objectives, j)
      if (value < ideal[j]) ideal[j] = value
      if (value > nadir[j]) nadir[j] = value
    }
  }

  return { ideal, nadir }
}

function normalizeIndividualObjectives(individual, bounds) {
  const normalized = []
  for (let j = 0; j < OBJECTIVES.length; j++) {
    const value = getMinimizationValue(individual.objectives, j)
    const range = bounds.nadir[j] - bounds.ideal[j]
    normalized.push(range <= 1e-9 ? 0 : (value - bounds.ideal[j]) / range)
  }
  return normalized
}

function associateToReferencePoint(vector, referencePoints) {
  let bestIndex = 0
  let bestDistance = Infinity

  for (let i = 0; i < referencePoints.length; i++) {
    const reference = referencePoints[i]
    let dot = 0
    let refNorm2 = 0
    for (let j = 0; j < vector.length; j++) {
      dot += vector[j] * reference[j]
      refNorm2 += reference[j] * reference[j]
    }

    const scale = refNorm2 <= 1e-12 ? 0 : Math.max(0, dot / refNorm2)
    let dist2 = 0
    for (let j = 0; j < vector.length; j++) {
      const diff = vector[j] - scale * reference[j]
      dist2 += diff * diff
    }

    const distance = Math.sqrt(dist2)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }

  return { referenceIndex: bestIndex, distance: bestDistance }
}

// ===================== 交叉与变异 =====================

function sbxCrossover(parent1, parent2, etaC, crossoverProb) {
  const child1 = { waypoints: [] }
  const child2 = { waypoints: [] }

  for (let i = 0; i < parent1.waypoints.length; i++) {
    const x1 = parent1.waypoints[i].x
    const y1 = parent1.waypoints[i].y
    const x2 = parent2.waypoints[i].x
    const y2 = parent2.waypoints[i].y

    if (Math.random() < crossoverProb) {
      // SBX on x
      const betaX = sbxBeta(etaC)
      const childX1 = 0.5 * ((1 + betaX) * x1 + (1 - betaX) * x2)
      const childX2 = 0.5 * ((1 - betaX) * x1 + (1 + betaX) * x2)

      // SBX on y
      const betaY = sbxBeta(etaC)
      const childY1 = 0.5 * ((1 + betaY) * y1 + (1 - betaY) * y2)
      const childY2 = 0.5 * ((1 - betaY) * y1 + (1 + betaY) * y2)

      child1.waypoints.push({ x: Math.max(0, Math.min(280, childX1)), y: Math.max(0, Math.min(160, childY1)) })
      child2.waypoints.push({ x: Math.max(0, Math.min(280, childX2)), y: Math.max(0, Math.min(160, childY2)) })
    } else {
      child1.waypoints.push({ x: x1, y: y1 })
      child2.waypoints.push({ x: x2, y: y2 })
    }
  }

  return [child1, child2]
}

function sbxBeta(eta) {
  const u = Math.random()
  if (u <= 0.5) {
    return Math.pow(2 * u, 1 / (eta + 1))
  } else {
    return Math.pow(1 / (2 * (1 - u)), 1 / (eta + 1))
  }
}

function polynomialMutation(individual, etaM, mutationProb, bounds) {
  const mutated = { waypoints: [] }

  for (let i = 0; i < individual.waypoints.length; i++) {
    let x = individual.waypoints[i].x
    let y = individual.waypoints[i].y

    if (i > 0 && i < individual.waypoints.length - 1) {  // 不变异起点和终点
      if (Math.random() < mutationProb) {
        const u = Math.random()
        const deltaX = u < 0.5
          ? Math.pow(2 * u, 1 / (etaM + 1)) - 1
          : 1 - Math.pow(2 * (1 - u), 1 / (etaM + 1))
        x = x + deltaX * (bounds.x.max - bounds.x.min) * 0.3
        x = Math.max(bounds.x.min, Math.min(bounds.x.max, x))
      }

      if (Math.random() < mutationProb) {
        const u = Math.random()
        const deltaY = u < 0.5
          ? Math.pow(2 * u, 1 / (etaM + 1)) - 1
          : 1 - Math.pow(2 * (1 - u), 1 / (etaM + 1))
        y = y + deltaY * (bounds.y.max - bounds.y.min) * 0.3
        y = Math.max(bounds.y.min, Math.min(bounds.y.max, y))
      }
    }

    mutated.waypoints.push({ x, y })
  }

  return mutated
}

function createIndividual(waypoints) {
  return {
    waypoints,
    objectives: evaluatePath(waypoints),
    rank: 0,
    crowdingDistance: 0
  }
}

function isFeasibleIndividual(individual) {
  return Boolean(individual.objectives._constraint?.isFeasible)
}

function compareInitializationCandidates(a, b) {
  const aConstraint = a.objectives._constraint
  const bConstraint = b.objectives._constraint

  if (aConstraint.isFeasible !== bConstraint.isFeasible) {
    return aConstraint.isFeasible ? -1 : 1
  }

  if (Math.abs(aConstraint.totalViolation - bConstraint.totalViolation) > CONSTRAINT_EPS) {
    return aConstraint.totalViolation < bConstraint.totalViolation ? -1 : 1
  }

  return a.objectives.d - b.objectives.d
}

// ===================== 种群初始化 =====================

function initializePopulation(size, bounds, numWaypoints) {
  const start = { x: 35, y: 125 }
  const end = { x: 245, y: 35 }

  // 4种路径生成策略，各占25%，确保种群多样性
  const strategies = [
    {
      name: 'direct',
      // 大致沿对角线，轻量扰动
      getMid: (j, n) => {
        const t = j / (n + 1)
        return { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) }
      }
    },
    {
      name: 'north',
      // 北绕行：推向 y=0 方向（SVG上方），避开NW-SE主山脊
      getMid: (j, n) => {
        const t = j / (n + 1)
        const baseX = start.x + t * (end.x - start.x)
        const baseY = start.y + t * (end.y - start.y)
        const offset = 35 * Math.sin(t * Math.PI)
        return { x: baseX + 10 * Math.sin(t * Math.PI), y: baseY - offset }
      }
    },
    {
      name: 'south',
      // 南绕行：推向 y=160 方向（SVG下方），从另一侧避开山脊
      getMid: (j, n) => {
        const t = j / (n + 1)
        const baseX = start.x + t * (end.x - start.x)
        const baseY = start.y + t * (end.y - start.y)
        const offset = 35 * Math.sin(t * Math.PI)
        return { x: baseX - 10 * Math.sin(t * Math.PI), y: baseY + offset }
      }
    },
    {
      name: 'random',
      // 全随机（带危险区回避偏置）
      getMid: () => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const x = Math.random() * bounds.x.max, y = Math.random() * bounds.y.max
          if (getHazardExposure(x, y) < 0.5) return { x, y }
        }
        return { x: Math.random() * bounds.x.max, y: Math.random() * bounds.y.max }
      }
    }
  ]

  const population = []

  function buildCandidateWaypoints(strategy) {
    const waypoints = [{ x: start.x, y: start.y }]

    for (let j = 1; j <= numWaypoints; j++) {
      const base = strategy.getMid(j, numWaypoints)
      const jitterX = (Math.random() - 0.5) * 30
      const jitterY = (Math.random() - 0.5) * 30
      waypoints.push({
        x: Math.max(bounds.x.min, Math.min(bounds.x.max, base.x + jitterX)),
        y: Math.max(bounds.y.min, Math.min(bounds.y.max, base.y + jitterY))
      })
    }

    waypoints.push({ x: end.x, y: end.y })
    return waypoints
  }

  for (let i = 0; i < size; i++) {
    const strategy = strategies[i % 4]
    const maxAttempts = strategy.name === 'random' ? 20 : 12
    let bestCandidate = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = createIndividual(buildCandidateWaypoints(strategy))
      if (!bestCandidate || compareInitializationCandidates(candidate, bestCandidate) < 0) {
        bestCandidate = candidate
      }
      if (isFeasibleIndividual(candidate)) break
    }

    population.push(bestCandidate)
  }

  return population
}

// ===================== NSGA-III 环境选择 =====================

/**
 * 为当前种群补齐 rank / crowdingDistance，主要用于展示与排序结果解释。
 */
function assignRanksAndCrowding(population) {
  const fronts = fastNonDominatedSort(population)
  for (const front of fronts) {
    calculateCrowdingDistance(front, population)
  }
  return fronts
}

function randomSelect(population) {
  return population[Math.floor(Math.random() * population.length)]
}

function createOffspringPopulation(population, cfg, bounds) {
  const offspring = []
  const feasibleParents = population.filter(isFeasibleIndividual)
  const matingPool = feasibleParents.length >= 2 ? feasibleParents : population

  while (offspring.length < population.length) {
    const parent1 = randomSelect(matingPool)
    const parent2 = randomSelect(matingPool)
    const [child1, child2] = sbxCrossover(
      parent1,
      parent2,
      cfg.etaC,
      cfg.crossoverProbability
    )

    const candidates = [child1, child2]
    for (const candidate of candidates) {
      const child = polynomialMutation(
        candidate,
        cfg.etaM,
        cfg.mutationProbability,
        bounds
      )
      child.objectives = evaluatePath(child.waypoints)
      child.rank = 0
      child.crowdingDistance = 0
      offspring.push(child)
      if (offspring.length >= population.length) break
    }
  }

  return offspring
}

function selectByReferenceNiching(union, selectedIndices, splitFront, remainingSlots, referencePoints) {
  const bounds = buildNormalizationBounds(union)
  const associations = new Map()
  const relevantIndices = [...selectedIndices, ...splitFront]

  for (const idx of relevantIndices) {
    const normalized = normalizeIndividualObjectives(union[idx], bounds)
    associations.set(idx, associateToReferencePoint(normalized, referencePoints))
  }

  const nicheCounts = new Array(referencePoints.length).fill(0)
  for (const idx of selectedIndices) {
    nicheCounts[associations.get(idx).referenceIndex]++
  }

  const remaining = new Set(splitFront)
  const chosen = []

  while (chosen.length < remainingSlots && remaining.size > 0) {
    const nicheOptions = []
    for (let refIndex = 0; refIndex < referencePoints.length; refIndex++) {
      const candidates = [...remaining]
        .filter(idx => associations.get(idx).referenceIndex === refIndex)
        .sort((a, b) => {
          const distDiff = associations.get(a).distance - associations.get(b).distance
          if (Math.abs(distDiff) > CONSTRAINT_EPS) return distDiff
          return compareDominance(union[a], union[b])
        })

      if (candidates.length === 0) continue

      nicheOptions.push({
        refIndex,
        nicheCount: nicheCounts[refIndex],
        bestDistance: associations.get(candidates[0]).distance,
        candidates
      })
    }

    if (nicheOptions.length === 0) break

    nicheOptions.sort((a, b) => {
      if (a.nicheCount !== b.nicheCount) return a.nicheCount - b.nicheCount
      if (Math.abs(a.bestDistance - b.bestDistance) > CONSTRAINT_EPS) {
        return a.bestDistance - b.bestDistance
      }
      return a.refIndex - b.refIndex
    })

    const selectedRef = nicheOptions[0]
    const selectedIdx = selectedRef.candidates[0]
    chosen.push(selectedIdx)
    remaining.delete(selectedIdx)
    nicheCounts[selectedRef.refIndex]++
  }

  if (chosen.length < remainingSlots && remaining.size > 0) {
    const residual = [...remaining].sort((a, b) => {
      const nicheDiff =
        nicheCounts[associations.get(a).referenceIndex] -
        nicheCounts[associations.get(b).referenceIndex]
      if (nicheDiff !== 0) return nicheDiff
      const distDiff = associations.get(a).distance - associations.get(b).distance
      if (Math.abs(distDiff) > CONSTRAINT_EPS) return distDiff
      return compareDominance(union[a], union[b])
    })

    for (const idx of residual) {
      chosen.push(idx)
      nicheCounts[associations.get(idx).referenceIndex]++
      if (chosen.length >= remainingSlots) break
    }
  }

  return chosen
}

function environmentalSelection(union, populationSize, referencePoints) {
  const fronts = assignRanksAndCrowding(union)
  const selectedIndices = []
  let splitFront = []

  for (const front of fronts) {
    if (selectedIndices.length + front.length <= populationSize) {
      selectedIndices.push(...front)
    } else {
      splitFront = front
      break
    }
  }

  if (selectedIndices.length < populationSize && splitFront.length > 0) {
    const chosen = selectByReferenceNiching(
      union,
      selectedIndices,
      splitFront,
      populationSize - selectedIndices.length,
      referencePoints
    )
    selectedIndices.push(...chosen)
  }

  const nextPopulation = selectedIndices.map(idx => union[idx])
  const nextFronts = assignRanksAndCrowding(nextPopulation)
  return { population: nextPopulation, fronts: nextFronts }
}

// ===================== NSGA-III 主循环 =====================

/**
 * 运行 NSGA-III 算法。
 *
 * @param {Object} customConfig - 自定义配置（可选）
 * @param {Function} onProgress - 每代进度回调 (generation, population, fronts)
 * @returns {Object} { paretoFront, allFronts, population, stats }
 */
export function runNSGA3(customConfig = {}, onProgress = null) {
  const cfg = { ...DEFAULT_CONFIG, ...customConfig }
  const bounds = { x: { min: 0, max: 280 }, y: { min: 0, max: 160 } }
  const populationSize = cfg.populationSize
  const numWaypoints = cfg.numWaypoints
  const rawReferencePoints = generateReferencePoints(
    OBJECTIVES.length,
    Math.max(2, cfg.referenceDivisions)
  )
  const referencePoints = fitReferencePoints(
    rawReferencePoints,
    populationSize,
    Math.max(2, cfg.referenceDivisions)
  )

  let population = initializePopulation(populationSize, bounds, numWaypoints)
  let fronts = assignRanksAndCrowding(population)

  for (let gen = 0; gen < cfg.generations; gen++) {
    const offspring = createOffspringPopulation(population, cfg, bounds)
    const union = [...population, ...offspring]
    const selected = environmentalSelection(union, populationSize, referencePoints)
    population = selected.population
    fronts = selected.fronts

    if (onProgress && ((gen + 1) % 5 === 0 || gen === cfg.generations - 1)) {
      onProgress(gen + 1, population, fronts)
    }
  }

  const finalFronts = assignRanksAndCrowding(population)

  const allIndividuals = []
  for (let fi = 0; fi < finalFronts.length; fi++) {
    for (const idx of finalFronts[fi]) {
      allIndividuals.push({
        waypoints: population[idx].waypoints,
        objectives: population[idx].objectives,
        rank: population[idx].rank,
        crowdingDistance: population[idx].crowdingDistance
      })
    }
  }

  const paretoFront = (finalFronts[0] || []).map(idx => ({
    waypoints: population[idx].waypoints,
    objectives: population[idx].objectives,
    rank: population[idx].rank,
    crowdingDistance: population[idx].crowdingDistance
  }))

  return {
    paretoFront,
    allIndividuals,
    allFronts: finalFronts,
    population,
    stats: {
      algorithm: 'NSGA-III',
      paretoSize: paretoFront.length,
      numFronts: finalFronts.length,
      populationSize: population.length,
      objectiveRanges: calculateObjectiveRanges(paretoFront),
      referencePointCount: rawReferencePoints.length,
      effectiveReferenceCount: referencePoints.length,
      numWaypoints,
      decisionDimensions: numWaypoints * 2,
      objectiveCount: OBJECTIVES.length
    }
  }
}

function calculateObjectiveRanges(paretoFront) {
  if (paretoFront.length === 0) return {}

  const ranges = {}
  for (const obj of OBJECTIVES) {
    const values = paretoFront.map(ind => ind.objectives[obj.id])
    ranges[obj.id] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length
    }
  }
  return ranges
}

export { OBJECTIVES, DEFAULT_CONFIG }
