/**
 * 等值线提取器（逐三角 Marching Squares + 拓扑后处理）
 *
 * 替代旧"相位 fract 法"等值线（shader 内 fract(v·density) 取窄条）：
 *   - 相位法在陡梯度区欠采样产生摩尔纹断带、在源附近/波前边缘碎成小闭环，
 *     且线条随热力图逐帧明灭（等值线锚在瞬时场上，载波振荡时剧烈闪烁）。
 *   - 本模块在**峰值场**（时间无关）上做真正的等值线几何提取：
 *       ① 逐三角 Marching Squares：三角形三顶点对 level 分类（上/下），
 *          线性插值求 crossing 点——网格表面分片线性场的等值集恰是
 *          分片线性曲线，数学上不自交、不断裂（断裂只发生在网格边界）；
 *       ② 折线拼接：crossing 段按量化端点哈希缝合为折线（open chain /
 *          closed loop），共享边的相邻三角形在量化精度内必然缝合；
 *       ③ 碎环过滤（拓扑修正之一）：周长 < minLoopPerimeter 的闭合环
 *          与长度 < minOpenLen 的开链删除——消灭"无意义的中心小闭环"
 *          与贴着网格边界的碎段；
 *       ④ Chaikin 切角平滑（2 轮）：折线角点按 1/4-3/4 切割，闭合环
 *          保持闭合、开链保持端点，输出仍不自交（切角在相邻段凸包内）。
 *
 * 等值线与时间无关 → 每个事件/参数只提取一次；动画期波前推进由渲染侧
 * 逐段 arrival 属性门控（见 sceneBuilder 等值线 Line2 渲染组）。
 */

// 归一化标尺与工业色阶常量（与 shader / 图例同源）
import {
  NORM_FLOOR,
  NORM_LOG_SPAN,
  INDUSTRIAL_BANDS_DEFAULT,
  industrialBandCount
} from '../rendering/vibrationColorScales.js'

/**
 * 从三角网格表面的标量场提取等值线折线
 * @param {Object} input
 * @param {Float32Array|number[]} input.positions - 顶点坐标 (N×3，任意一致坐标系)
 * @param {Uint32Array|Uint16Array|number[]} [input.index] - 三角形索引 (M×3)；
 *        缺省时按 positions 顺序每 3 点一个三角形（非索引几何）
 * @param {Float32Array|number[]} input.values - 每顶点标量值（如峰值 PPV）
 * @param {Float32Array|number[]} [input.arrival] - 每顶点波前到达时刻(s)，
 *        输出折线顶点携带插值后的到达时刻（渲染侧波前门控用）
 * @param {Float32Array|number[]} [input.normals] - 每顶点法线(N×3)，输出折线
 *        顶点携带插值归一法线（渲染侧沿法线外推防 z-fighting）
 * @param {number[]} input.levels - 等值线级别数组（标量值单位）
 * @param {Object} [opts]
 * @param {number} [opts.minLoopPerimeter=0.6] - 闭合环最小周长(m)，小于则过滤
 * @param {number} [opts.minOpenLength=0.4] - 开链最小长度(m)，小于则过滤
 * @param {number} [opts.chaikinIterations=2] - Chaikin 切角轮数（0=不平滑）
 * @param {number} [opts.maxEdgeRatio=0.85] - 跨越级别判定的最大插值比例钳制
 * @returns {{polylines: Array, stats: Object}}
 *          polylines[i] = { positions: Float32Array, arrival: Float32Array|null,
 *                           closed: boolean, level: number }
 *          stats = { segments, loops, openChains, loopsFiltered, chainsFiltered,
 *                    totalPoints, extractMs }
 */
export function extractContours(input, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const { positions, values, levels } = input
  const arrivalIn = input.arrival || null
  const normalsIn = input.normals || null
  const index = input.index || null
  if (!positions || !values || !Array.isArray(levels) || levels.length === 0) {
    return {
      polylines: [],
      stats: {
        segments: 0,
        loops: 0,
        openChains: 0,
        loopsFiltered: 0,
        chainsFiltered: 0,
        totalPoints: 0,
        extractMs: 0
      }
    }
  }

  const nVerts = Math.floor(positions.length / 3)
  const nTris = index ? Math.floor(index.length / 3) : Math.floor(nVerts / 3)
  const minLoopPerimeter = opts.minLoopPerimeter ?? 0.6
  const minOpenLength = opts.minOpenLength ?? 0.4
  const chaikinIters = Math.max(0, Math.min(4, opts.chaikinIterations ?? 2))
  // 插值比例钳制：极端狭长三角形中 crossing 点贴到顶点上（t→0/1），
  // 量化缝合时多个不同边的 crossing 塌到同一点，产生零长度段 → 碎环。
  const tEps = 0.03

  // 每级别独立收集段（levels 互不相交，几何无重叠，逐级别处理便于分层统计）
  const polylines = []
  let segments = 0
  let loopsFiltered = 0
  let chainsFiltered = 0
  let totalPoints = 0

  for (const level of levels) {
    // —— ① 逐三角 Marching Squares（三角形版：0/2 个 crossing 段）——
    // crossing 段端点 = (边的量化键) → 顶点数据；同一条网格边在相邻三角形中
    // 生成相同键 → 段自然缝合。退化三角形（三顶点同侧/含 level 恰好相等）跳过。
    const segMap = new Map() // qKey -> { x,y,z, arr, links: [] }
    const segList = [] // { a: node, b: node }

    const vertAbove = new Uint8Array(nVerts)
    for (let i = 0; i < nVerts; i++) vertAbove[i] = values[i] >= level ? 1 : 0

    const getNode = (vi, vj) => {
      // 边 (vi,vj) 的 crossing：value 线性插值，t 钳到 [tEps, 1-tEps] 防塌点
      const va = values[vi]
      const vb = values[vj]
      let t = (level - va) / (vb - va)
      if (!Number.isFinite(t)) t = 0.5
      t = Math.min(1 - tEps, Math.max(tEps, t))
      const x = positions[vi * 3] + (positions[vj * 3] - positions[vi * 3]) * t
      const y = positions[vi * 3 + 1] + (positions[vj * 3 + 1] - positions[vi * 3 + 1]) * t
      const z = positions[vi * 3 + 2] + (positions[vj * 3 + 2] - positions[vi * 3 + 2]) * t
      // 量化键：以 cm 级精度聚合（岩体尺度 m 级，cm 量化足够缝合且不误并）
      const qk = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`
      let node = segMap.get(qk)
      if (!node) {
        let arr = null
        if (arrivalIn) arr = arrivalIn[vi] + (arrivalIn[vj] - arrivalIn[vi]) * t
        let nx = null
        let ny = null
        let nz = null
        if (normalsIn) {
          // 法线线性插值后归一（渲染侧沿法线外推防 z-fighting，见 sceneBuilder）
          nx = normalsIn[vi * 3] + (normalsIn[vj * 3] - normalsIn[vi * 3]) * t
          ny = normalsIn[vi * 3 + 1] + (normalsIn[vj * 3 + 1] - normalsIn[vi * 3 + 1]) * t
          nz = normalsIn[vi * 3 + 2] + (normalsIn[vj * 3 + 2] - normalsIn[vi * 3 + 2]) * t
          const nl = Math.hypot(nx, ny, nz)
          if (nl > 1e-6) {
            nx /= nl
            ny /= nl
            nz /= nl
          } else {
            nx = ny = nz = null
          }
        }
        node = { x, y, z, arr, nx, ny, nz, segs: [] }
        segMap.set(qk, node)
      }
      return node
    }

    for (let ti = 0; ti < nTris; ti++) {
      const i0 = index ? index[ti * 3] : ti * 3
      const i1 = index ? index[ti * 3 + 1] : ti * 3 + 1
      const i2 = index ? index[ti * 3 + 2] : ti * 3 + 2
      const a0 = vertAbove[i0]
      const a1 = vertAbove[i1]
      const a2 = vertAbove[i2]
      const sum = a0 + a1 + a2
      if (sum === 0 || sum === 3) continue // 全同侧：无 crossing
      // 单顶点一侧：crossing 在该顶点对边的两条边上；双顶点一侧：对称情形
      let lo, hi1, hi2
      if (sum === 1) {
        // 单个 above 顶点
        if (a0) {
          lo = i0
          hi1 = i1
          hi2 = i2
        } else if (a1) {
          lo = i1
          hi1 = i0
          hi2 = i2
        } else {
          lo = i2
          hi1 = i0
          hi2 = i1
        }
        segList.push({ a: getNode(lo, hi1), b: getNode(lo, hi2) })
      } else {
        // 单个 below 顶点
        if (!a0) {
          lo = i0
          hi1 = i1
          hi2 = i2
        } else if (!a1) {
          lo = i1
          hi1 = i0
          hi2 = i2
        } else {
          lo = i2
          hi1 = i0
          hi2 = i1
        }
        segList.push({ a: getNode(lo, hi1), b: getNode(lo, hi2) })
      }
    }
    segments += segList.length

    // —— ② 折线拼接：段图（节点度数多数 ≤2）→ 链/环 ——
    // 邻接表：node.segs = [段下标...]，游走时 O(deg) 找未访问段（总体 O(S)；
    // 若线性扫段表会退化 O(S²)，大网格下不可用）。
    for (let si = 0; si < segList.length; si++) {
      const s = segList[si]
      s.a.segs.push(si)
      s.b.segs.push(si)
    }
    const visited = new Set()
    const walk = startNode => {
      const pts = [startNode]
      let cur = startNode
      while (true) {
        let found = -1
        for (const si of cur.segs) {
          if (!visited.has(si)) {
            found = si
            break
          }
        }
        if (found < 0) break
        visited.add(found)
        const s = segList[found]
        cur = s.a === cur ? s.b : s.a
        pts.push(cur)
      }
      return pts
    }
    const chains = []
    // 先从度数 1 的端点走（开链完整），再从任意带未访问段的节点走（闭环）。
    // 走回起点即闭合环（去掉重复的末点）。
    const endpoints = []
    for (const node of segMap.values()) if (node.segs.length === 1) endpoints.push(node)
    for (const ep of endpoints) {
      if (visited.size === segList.length) break
      // 端点所在段可能已被先前游走消耗（高学位退化节点），跳过
      if (ep.segs.every(si => visited.has(si))) continue
      const pts = walk(ep)
      if (pts.length >= 2) chains.push({ pts, closed: false })
    }
    if (visited.size < segList.length) {
      for (let si = 0; si < segList.length; si++) {
        if (visited.has(si)) continue
        const pts = walk(segList[si].a)
        const closed = pts.length >= 3 && pts[pts.length - 1] === pts[0]
        if (closed) pts.pop() // 去掉与起点重复的末点
        if (pts.length >= 3) chains.push({ pts, closed })
      }
    }

    // —— ③ 碎环/碎链过滤（拓扑修正：消灭小闭环与边界碎段）——
    const chainLength = (pts, closed) => {
      let L = 0
      for (let i = 1; i < pts.length; i++) {
        L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z)
      }
      if (closed && pts.length > 1) {
        const p0 = pts[0]
        const pn = pts[pts.length - 1]
        L += Math.hypot(pn.x - p0.x, pn.y - p0.y, pn.z - p0.z)
      }
      return L
    }
    const kept = []
    for (const ch of chains) {
      const L = chainLength(ch.pts, ch.closed)
      if (ch.closed && L < minLoopPerimeter) {
        loopsFiltered++
        continue
      }
      if (!ch.closed && L < minOpenLength) {
        chainsFiltered++
        continue
      }
      kept.push(ch)
    }

    // —— ④ Chaikin 切角平滑（保端点/保闭合）——
    for (const ch of kept) {
      let pts = ch.pts
      for (let it = 0; it < chaikinIters; it++) {
        const out = []
        const n = pts.length
        if (ch.closed) {
          for (let i = 0; i < n; i++) {
            const p = pts[i]
            const q = pts[(i + 1) % n]
            out.push(lerpNode(p, q, 0.25), lerpNode(p, q, 0.75))
          }
        } else {
          out.push(pts[0])
          for (let i = 0; i < n - 1; i++) {
            const p = pts[i]
            const q = pts[i + 1]
            out.push(lerpNode(p, q, 0.25), lerpNode(p, q, 0.75))
          }
          out.push(pts[n - 1])
        }
        pts = out
      }
      const m = pts.length
      const pos = new Float32Array(m * 3)
      const arr = arrivalIn ? new Float32Array(m) : null
      let hasNrm = false
      for (let i = 0; i < m; i++)
        if (pts[i].nx != null) {
          hasNrm = true
          break
        }
      const nrm = hasNrm ? new Float32Array(m * 3) : null
      for (let i = 0; i < m; i++) {
        pos[i * 3] = pts[i].x
        pos[i * 3 + 1] = pts[i].y
        pos[i * 3 + 2] = pts[i].z
        if (arr) arr[i] = pts[i].arr ?? 0
        if (nrm) {
          nrm[i * 3] = pts[i].nx ?? 0
          nrm[i * 3 + 1] = pts[i].ny ?? 0
          nrm[i * 3 + 2] = pts[i].nz ?? 1
        }
      }
      totalPoints += m
      polylines.push({ positions: pos, normals: nrm, arrival: arr, closed: ch.closed, level })
    }
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    polylines,
    stats: {
      segments,
      loops: polylines.filter(p => p.closed).length,
      openChains: polylines.filter(p => !p.closed).length,
      loopsFiltered,
      chainsFiltered,
      totalPoints,
      extractMs: t1 - t0
    }
  }
}

function lerpNode(p, q, t) {
  const node = {
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
    z: p.z + (q.z - p.z) * t,
    arr: p.arr != null && q.arr != null ? p.arr + (q.arr - p.arr) * t : (p.arr ?? q.arr ?? null)
  }
  if (p.nx != null && q.nx != null) {
    let nx = p.nx + (q.nx - p.nx) * t
    let ny = p.ny + (q.ny - p.ny) * t
    let nz = p.nz + (q.nz - p.nz) * t
    const nl = Math.hypot(nx, ny, nz)
    if (nl > 1e-6) {
      node.nx = nx / nl
      node.ny = ny / nl
      node.nz = nz / nl
    } else {
      node.nx = p.nx
      node.ny = p.ny
      node.nz = p.nz
    }
  } else if (p.nx != null) {
    node.nx = p.nx
    node.ny = p.ny
    node.nz = p.nz
  } else if (q.nx != null) {
    node.nx = q.nx
    node.ny = q.ny
    node.nz = q.nz
  }
  return node
}

/**
 * 由当前显示模式与归一化标尺推算等值线级别（峰值 PPV 单位 m/s）。
 *
 * 与 GPU 色彩映射同口径（sceneBuilder BENCH_FIELD_FRAGMENT_SHADER）：
 *   - PPV/应力模式：lin = 场值/参考值；对数标尺（normMode=1）时
 *     norm = log2(max(lin, 0.02)/0.02)/log2(50)，色带层位 u_k = k/density，
 *     反解 lin_k = 0.02·50^(u_k) → 级别 = lin_k × ref（ref 为该模式的满刻度）
 *   - 损伤模式：级别 = Persson 分区阈值（20/50/100/200 cm/s → 0.2~2.0 m/s），
 *     等值线恰为分区色带边界
 *
 * @param {Object} p
 * @param {number} p.displayMode - 0=PPV, 1=STRESS, 2=DAMAGE
 * @param {number} p.normMode - 0=线性, 1=对数
 * @param {number} [p.ppvRefMps] - PPV 满刻度(m/s)（displayMode=0）
 * @param {number} [p.stressRefMPa] - 应力满刻度(MPa)（displayMode=1）
 * @param {number} [p.stressFactor] - ρ·c_p/(1−ν)（Pa per m/s）
 * @param {number} [p.density=12] - 色带分档数（等值线条数 = density-1）
 * @returns {number[]} 级别数组（m/s，升序）
 */
export function computeContourLevels(p = {}) {
  const displayMode = Number(p.displayMode) || 0
  const normMode = Number(p.normMode) > 0 ? 1 : 0
  // 【工业离散色阶】色阶档数 N = 等值线条数 + 1（线画在色阶边界上）。
  // N 与 shader uNormBands / 图例区间列表同源（industrialBandCount 钳制 12~16）。
  const bands = industrialBandCount(p.bands ?? p.density ?? INDUSTRIAL_BANDS_DEFAULT)

  if (displayMode === 2) {
    // 损伤分区边界（Persson 阈值，cm/s → m/s）须与后端 DAMAGE_THRESHOLDS_CMPS
    // 及 localVibrationSimulator / sceneBuilder shader 一致：(20,50,100,200) cm/s。
    // 旧 5/15/30/50 会在 seek 波前全开后于 7~15m 处画出大片微裂纹假等值线。
    return [0.2, 0.5, 1.0, 2.0]
  }

  // 满刻度（与 shader 归一化分母一致）：
  //   PPV  → ppvRefMps (m/s)，级别输出 m/s
  //   应力 → stressRefMPa (MPa)，级别输出 MPa
  let refDisp
  if (displayMode === 1) {
    refDisp = Number(p.stressRefMPa) > 0 ? Number(p.stressRefMPa) : 30
  } else {
    refDisp = Number(p.ppvRefMps) > 0 ? Number(p.ppvRefMps) : 0.15
  }
  if (!(refDisp > 0)) return []

  // 【对齐修复】旧实现硬编码 floor=0.02·50^u，而 shader 已改用
  // NORM_FLOOR=0.002（动态范围 500×）→ 等值线与热力图色档整体错位。
  // 此处按同一公式反解：v(k/N) = ref·FLOOR·2^(SPAN·k/N)（对数）或 ref·k/N（线性）。
  // 工业风格下 shader 不做膝形压缩，故该反解是精确互逆，线与色档边界严格对齐。
  const levels = []
  for (let k = 1; k < bands; k++) {
    const u = k / bands
    levels.push(
      normMode === 1 ? refDisp * NORM_FLOOR * Math.pow(2, NORM_LOG_SPAN * u) : refDisp * u
    )
  }
  return levels
}
