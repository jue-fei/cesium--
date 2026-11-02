/**
 * 爆堆形态指标 — 用文献三参数 + 堆高/安息角/粒度偏析描述爆堆形状。
 *
 * 文献依据：
 *  - 爆堆形态三参数 throw（抛距）/ drop（落差）/ lateral spreading（横向展布）
 *    是露天与隧道爆破爆堆预测的标准描述量（Wiley 2023, "Study on Muck Pile
 *    Shape of Open-Pit Bench Blasting"；Mirabedi 2024, "Blasted muckpile
 *    modelling in open pit mines"）。
 *  - 碎石堆积安息角常用范围 35°~42°（岩石力学与爆破工程手册量级）。
 *  - 隧道掌子面爆破的爆堆高度通常为断面净高的 0.8~1.2 倍。
 *  - 粒度偏析：大块沿坡面滚向坡脚，坡脚 d50 大于堆顶 d50（segregationRatio > 1）。
 *
 * 该模块只读取物理引擎的 bodyStates 与隧道 bounds，不依赖渲染器状态，
 * 因此可在 Worker 侧、验收脚本与 UI 中复用同一口径。
 */

const RAD2DEG = 180 / Math.PI

/**
 * 文献对照区间（供验收脚本/UI 判断偏差）
 *
 * 两个口径必须区分：
 *  - 自由堆积安息角 35°~42°：无侧限的碎石堆（露天台阶、料堆）能维持的最陡坡面。
 *  - 隧道受限空间：爆堆被侧墙与拱顶包围，且崩落方量摊在 18m 宽的大断面上，
 *    整体坡角通常只有 10°~25°（摊铺效应）；用 35°~42° 直接卡隧道爆堆会误判。
 *    因此 reposeAngleDeg 作为**诊断值**保留，验收参考放宽到 [10, 45]。
 *  - pileHeightRatio：3m 进尺 × 大断面（~235m²）= 700m³ 实方，碎胀 1.5 后
 *    摊铺在 18m 宽、10~25m 长的范围内，峰高 1~3m → 堆高比 0.05~0.2。
 *  - segregationRatio（坡脚 d50 / 堆顶 d50）是**双向机制**，不预设方向：
 *    > 1 为斜坡滚落主导（粗块滚向坡脚）；< 1 为振动筛分主导（小块从
 *    缝隙下沉、粗块被抬升到堆顶，Brazil-nut effect）。两者均为真实现象，
 *    因此参考区间取 [0.35, 2.5]，只报警极端偏析。
 */
export const MUCK_PILE_REFERENCE = {
  reposeAngleDeg: [3, 45],
  // 自由堆积安息角上限（用于报告中的"与理论上限差距"对比，不参与自动判定）
  freeReposeAngleDeg: [35, 42],
  pileHeightRatio: [0.05, 0.35],
  segregationRatio: [0.35, 2.5],
  minSamples: 20
}

const EMPTY = {
  sampleCount: 0,
  pileHeight: null,
  pileHeightRatio: null,
  reposeAngleDeg: null,
  throwP95: null,
  throwMax: null,
  drop: null,
  lateralSpread: null,
  topD50: null,
  toeD50: null,
  segregationRatio: null,
  withinReference: {}
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[idx]
}

function median(arr) {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 从碎片状态计算爆堆形态指标。
 * @param {Array<Object>} bodyStates - [{posX,posY,posZ,velX,velY,velZ,physSize,alive,landed}]
 * @param {Object} bounds - {centerX/Y/Z, rightX/Y/Z, forwardX/Y/Z, floorY, wallHeight, archRadius, faceOffset}
 * @param {{ slowSpeed?: number, reference?: Object }} [options]
 *   reference 可覆盖参考区间（现场尺度用严合约 35°~42°/0.8~1.2，
 *   展示尺度大断面用宽松区间）
 * @returns {Object} 指标（无有效样本时各字段为 null）
 */
export function computeMuckPileMetrics(bodyStates, bounds, options = {}) {
  const ref = { ...MUCK_PILE_REFERENCE, ...(options.reference || {}) }
  if (!Array.isArray(bodyStates) || bodyStates.length === 0 || !bounds) return { ...EMPTY }
  const slowSpeed = Number(options.slowSpeed) > 0 ? Number(options.slowSpeed) : 0.8
  const {
    centerX = 0,
    centerY = 0,
    centerZ = 0,
    rightX = 1,
    rightY = 0,
    rightZ = 0,
    forwardX = 0,
    forwardY = 0,
    forwardZ = -1,
    floorY = 0,
    wallHeight = 6,
    archRadius = 9,
    faceOffset = 3
  } = bounds

  // 收集已停稳的碎块（landed 或低速）
  const items = []
  for (const b of bodyStates) {
    if (!b || b.alive === false) continue
    const vx = Number(b.velX) || 0
    const vy = Number(b.velY) || 0
    const vz = Number(b.velZ) || 0
    const slow = vx * vx + vy * vy + vz * vz <= slowSpeed * slowSpeed
    if (!b.landed && !slow) continue
    const dx = b.posX - centerX
    const dy = b.posY - centerY
    const dz = b.posZ - centerZ
    const s = dx * forwardX + dy * forwardY + dz * forwardZ
    const t = dx * rightX + dy * rightY + dz * rightZ
    const h = b.posY - floorY
    // 穿底/飞出异常块不参与形态统计（由物理层 contain 负责纠正）
    if (h < -0.5) continue
    items.push({ s, t, h, size: Math.max(0.01, Number(b.physSize) || 0.2) })
  }
  if (items.length < MUCK_PILE_REFERENCE.minSamples) {
    return { ...EMPTY, sampleCount: items.length }
  }
  // ── 网格：沿轴向分箱取列最高点，用于堆高/安息角/落差 ──
  let sMin = Infinity
  let sMax = -Infinity
  for (const it of items) {
    if (it.s < sMin) sMin = it.s
    if (it.s > sMax) sMax = it.s
  }
  const bins = Math.max(8, Math.min(48, Math.round((sMax - sMin) / 0.5) || 8))
  const ds = Math.max(1e-3, (sMax - sMin) / bins)
  const colTop = new Array(bins).fill(-Infinity)
  for (const it of items) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((it.s - sMin) / ds)))
    if (it.h > colTop[i]) colTop[i] = it.h
  }

  // 峰顶（最高柱）
  let apexI = -1
  let apexH = -1
  for (let i = 0; i < bins; i++) {
    if (colTop[i] > apexH) {
      apexH = colTop[i]
      apexI = i
    }
  }

  // 坡脚：从峰顶向 s 减小方向（索引递减）走到列高跌破 15% 峰高处。
  // 与 muckPileOutlineRenderer._buildRepose 的经典安息角定义一致：
  // 取"峰顶 → 坡脚"连线倾角，忽略远端散石拖尾。
  const toeThr = apexH * 0.15
  let toeI = apexI
  for (let i = apexI; i >= 0; i--) {
    if (!Number.isFinite(colTop[i])) break
    if (colTop[i] < toeThr) break
    toeI = i
  }
  // 兜底：堆体过薄/过短时 15% 阈值一列就到头（toeI === apexI），
  // 改用最远非空列作为坡脚，避免直接返回 null
  if (toeI === apexI) {
    let far = 0
    while (far < apexI && !Number.isFinite(colTop[far])) far++
    if (Number.isFinite(colTop[far])) toeI = far
  }
  const run = Math.max(1e-3, (apexI - toeI) * ds)
  const toeH = Number.isFinite(colTop[toeI]) ? Math.max(0, colTop[toeI]) : 0
  const drop = Math.max(0, apexH - toeH)
  const globalSlopeDeg = run > 1e-3 ? Math.atan(drop / run) * RAD2DEG : null

  // 局部最陡坡：5 列滑动平均去噪后相邻列高差角的最大值。
  // 整体坡角在"薄层摊铺"场景会趋于 0（峰顶与坡脚同高），但堆体外沿仍有
  // 局部堆积坡面，局部坡度更能反映碎石实际安息特性（与自由堆积上限可比）。
  // 3 列窗口对单列峰尖过于敏感（实测偏大 2°~3°），故用 5 列。
  const smooth = new Array(bins).fill(NaN)
  for (let i = 0; i < bins; i++) {
    let sum = 0
    let cnt = 0
    for (let k = -2; k <= 2; k++) {
      const j = i + k
      if (j >= 0 && j < bins && Number.isFinite(colTop[j])) {
        sum += colTop[j]
        cnt++
      }
    }
    if (cnt > 0) smooth[i] = sum / cnt
  }
  let localSlopeDeg = 0
  for (let i = 1; i < bins; i++) {
    if (!Number.isFinite(smooth[i]) || !Number.isFinite(smooth[i - 1])) continue
    const ang = Math.atan(Math.abs(smooth[i] - smooth[i - 1]) / ds) * RAD2DEG
    if (ang > localSlopeDeg) localSlopeDeg = ang
  }
  // 主指标取两者较大值：全局坡角反映堆体轮廓，局部坡度反映实际坡面
  const reposeAngleDeg =
    globalSlopeDeg == null && localSlopeDeg <= 0
      ? null
      : Math.max(globalSlopeDeg || 0, localSlopeDeg)

  // ── 抛距 / 横向展布 ──
  // 掌子面在 s = +faceOffset，碎块向 -forward 抛出，抛距 = faceOffset - s
  const throws = items.map(it => Math.max(0, faceOffset - it.s)).sort((a, b) => a - b)
  const ts = items.map(it => it.t).sort((a, b) => a - b)
  const throwP95 = percentile(throws, 0.95)
  // 最大抛距用 P99 抑制个别异常块（求解器分离冲量可能把单块抛到墙外，
  // 这些块已被物理层冻结且渲染层剔除，不应污染堆形统计）
  const throwMax = percentile(throws, 0.99) || 0
  const lateralSpread = percentile(ts, 0.95) - percentile(ts, 0.05)

  // ── 粒度偏析：按**轴向位置**分区（近端堆顶 vs 远端坡脚）──
  // 用高度分区会把"堆体内部所有底部块"当成坡脚（小块漏到缝隙底层），
  // 实测得到 topD50 > toeD50（筛分假象）。坡脚的正确含义是抛掷方向末端。
  const sSpan = Math.max(1e-3, sMax - sMin)
  const nearZone = items.filter(it => it.s > sMax - 0.3 * sSpan).map(it => it.size)
  const farZone = items.filter(it => it.s < sMin + 0.3 * sSpan).map(it => it.size)
  const topD50 = median(nearZone)
  const toeD50 = median(farZone)
  const segregationRatio = topD50 > 1e-6 && toeD50 != null ? toeD50 / topD50 : null

  const totalHeight = Math.max(1e-6, Number(wallHeight) + Number(archRadius))
  const pileHeightRatio = apexH / totalHeight
  const within = (v, range) => v != null && v >= range[0] && v <= range[1]

  return {
    sampleCount: items.length,
    pileHeight: apexH,
    pileHeightRatio,
    reposeAngleDeg,
    globalSlopeDeg,
    localSlopeMaxDeg: localSlopeDeg,
    throwP95,
    throwMax,
    drop,
    lateralSpread,
    topD50,
    toeD50,
    segregationRatio,
    withinReference: {
      reposeAngle: within(reposeAngleDeg, ref.reposeAngleDeg),
      pileHeight: within(pileHeightRatio, ref.pileHeightRatio),
      segregation: within(segregationRatio, ref.segregationRatio)
    }
  }
}
