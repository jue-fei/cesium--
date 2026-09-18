/**
 * 岩体表面几何抛光工具（消除热力图"纸片拼接/接缝"）
 *
 * 背景：爆破岩体由多个 three.js 表面网格拼接而成。ExtrudeGeometry 等输出的
 * 曲面多为**无索引**几何 → 每三角形各持一份顶点 → computeVertexNormals 只能给
 * 逐面 flat 法线，连续曲面（拱形、爆破漏斗凹腔）按平面逐面打光，呈现"折纸"棱线；
 * 部件 merge 拼接处顶点不共享 → 法线/纹理在交线跳变、出现微缝。
 *
 * 本模块提供三道工具，用于把"热力面"几何原地抛光滑：
 *  - weldPositions：位置级去重（不依赖 normal/uv 是否一致），输出带索引几何；
 *  - creaseNormals：折痕法线平滑——同位置、相邻面夹角 ≤ creaseDeg 的面共享顶点并
 *    取**面积加权平均法线**（曲面变顺滑）；夹角更大的面拆为独立顶点保留硬棱
 *    （大盒 90° 棱、隧道轮廓剪影、漏斗口/底口环等刻意轮廓不被抹圆）。
 *  - removeTrianglesOnPlane：剔除位于某平面、朝向指定一侧的内部盖面（如岩体
 *    爆破后退切段 z=roundDepth 处由 ring 后盖+solid 前盖叠成的内部双盖面）。
 *
 * 注意：creaseNormals 之后**不得再调用 computeVertexNormals**（会把平滑打回 flat）。
 * 全部函数只依赖 three，node 环境可测。
 */
import * as THREE from 'three'

// ─── 位置分桶（配合 eps 容差，把"构造自同源 shape/同深度 translate"的共享边界焊上）──
const _bucketKey = (x, y, z, eps) =>
  `${Math.round(x / eps)}|${Math.round(y / eps)}|${Math.round(z / eps)}`

/**
 * 位置级去重：把坐标相同（容差 eps 内）的顶点合并为一个，输出**带索引**几何。
 * - normal 不再保留（旧的逐面 flat 值无意义，由 creaseNormals 重算）；
 * - uv/color 取同位置第一个顶点的值（对同一曲面 uv 连续处无影响）。
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [eps=1e-4] 合并容差（米）
 * @returns {THREE.BufferGeometry}
 */
export function weldPositions(geometry, eps = 1e-4) {
  const posAttr = geometry.attributes.position
  const P = posAttr.count
  const pa = posAttr.array
  const idx = geometry.index ? geometry.index.array : null
  const uvAttr = geometry.attributes.uv
  const uvA = uvAttr ? uvAttr.array : null
  const colAttr = geometry.attributes.color
  const colA = colAttr ? colAttr.array : null

  const keyToNode = new Map()
  const nodeOf = new Int32Array(P)
  const outPos = []
  const outUv = colA ? [] : uvA ? [] : null
  const outCol = colA ? [] : null

  for (let i = 0; i < P; i++) {
    const key = _bucketKey(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2], eps)
    let n = keyToNode.get(key)
    if (n == null) {
      n = outPos.length / 3
      keyToNode.set(key, n)
      outPos.push(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2])
      if (uvA) outUv.push(uvA[i * 2], uvA[i * 2 + 1])
      if (colA) outCol.push(colA[i * 3], colA[i * 3 + 1], colA[i * 3 + 2])
    }
    nodeOf[i] = n
  }

  const outIdx = []
  const triCount = idx ? idx.length / 3 : P / 3
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const na = nodeOf[a]
    const nb = nodeOf[b]
    const nc = nodeOf[c]
    // 跳过退化三角形（三顶点焊进同一点）
    if (na === nb || nb === nc || na === nc) continue
    outIdx.push(na, nb, nc)
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  if (uvA) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  if (colA) out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3))
  if (outIdx.length > 0) out.setIndex(outIdx)
  return out
}

/**
 * 折痕法线平滑。输入可带索引也可不带（带 uv 则保留），输出带索引。
 *
 * 算法（逐"空间位置节点"做并查集）：
 *   1. 以 eps 把坐标相同的顶点归并为同一节点；
 *   2. 每三角形算几何法线与面积；
 *   3. 对每个节点，把围绕它的面按其**共享边邻接**相连；两相邻面法线夹角
 *      ≤ creaseDeg（dot ≥ cos）则并入同一平滑组，否则留在不同组（硬棱）；
 *   4. 每组取成员面**面积加权法线**，作为该节点在该组的顶点法线；每组输出
 *      一个独立顶点实例，三角形角点引用各自所在组的顶点。
 *
 * 效果：连续曲面（拱/漏斗）光照随面平滑过渡；刻意锐边（90° 盒棱、轮廓剪影、
 * 漏斗口环）因面夹角大而被拆开保留。
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [creaseDeg=45] 平滑折痕角（面法线夹角阈值，度）
 * @param {number} [eps=1e-4] 位置归并容差（米）
 * @returns {THREE.BufferGeometry}
 */
export function creaseNormals(geometry, creaseDeg = 45, eps = 1e-4) {
  const posAttr = geometry.attributes.position
  const P = posAttr.count
  const pa = posAttr.array
  const uvAttr = geometry.attributes.uv
  const uvA = uvAttr ? uvAttr.array : null
  const idx = geometry.index ? geometry.index.array : null

  const cosTh = Math.cos((creaseDeg * Math.PI) / 180)

  // 1) 位置节点
  const nodeOf = new Int32Array(P)
  const nodeX = []
  const nodeY = []
  const nodeZ = []
  const nodeMap = new Map()
  for (let i = 0; i < P; i++) {
    const key = _bucketKey(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2], eps)
    let n = nodeMap.get(key)
    if (n == null) {
      n = nodeX.length
      nodeMap.set(key, n)
      nodeX.push(pa[i * 3])
      nodeY.push(pa[i * 3 + 1])
      nodeZ.push(pa[i * 3 + 2])
    }
    nodeOf[i] = n
  }
  const N = nodeX.length

  // 2) 三角面（跳过退化）→ 角点模型：每个角记录 节点id / 原始顶点id(取uv) / 面法线与面积
  const T = idx ? idx.length / 3 : P / 3
  const cnNode = [] // 角点 → 节点
  const cnOrig = [] // 角点 → 原始顶点 id（uv 采样）
  const cnFx = [] // 角点所在面的法线
  const cnFy = []
  const cnFz = []
  const nodeCorners = new Array(N)
  for (let i = 0; i < N; i++) nodeCorners[i] = []

  const readOrig = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k)

  for (let t = 0; t < T; t++) {
    const a = readOrig(t, 0)
    const b = readOrig(t, 1)
    const c = readOrig(t, 2)
    const na = nodeOf[a]
    const nb = nodeOf[b]
    const nc = nodeOf[c]
    if (na === nb || nb === nc || na === nc) continue

    const ax = nodeX[na]
    const ay = nodeY[na]
    const az = nodeZ[na]
    const bx = nodeX[nb]
    const by = nodeY[nb]
    const bz = nodeZ[nb]
    const cx2 = nodeX[nc]
    const cy2 = nodeY[nc]
    const cz2 = nodeZ[nc]
    // 法线 = (B-A)×(C-A)
    let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy2 - ay)
    let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az)
    let nz = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax)
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-12) continue
    nx /= len
    ny /= len
    nz /= len
    const area = len / 2

    const corners = [a, b, c]
    const nodes = [na, nb, nc]
    for (let k = 0; k < 3; k++) {
      const cn = cnNode.length
      cnNode.push(nodes[k])
      cnOrig.push(corners[k])
      cnFx.push(nx * area)
      cnFy.push(ny * area)
      cnFz.push(nz * area)
      nodeCorners[nodes[k]].push(cn)
    }
  }

  const C = cnNode.length

  // 3) 每节点内：共享边相邻且夹角≤threshold 的面并为一组（并查集）
  const parent = new Int32Array(C)
  for (let i = 0; i < C; i++) parent[i] = i
  const find = x => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }

  // 两角点所在面是否共享一条"经过 nd 的边"（即还共享另一个节点）
  const facesShareEdge = (cA, cB, nd) => {
    const fA = (cA / 3) | 0
    const fB = (cB / 3) | 0
    if (fA === fB) return false
    // 两个面都含节点 nd（角点在此节点）；检查是否另有公共节点 m ≠ nd：
    // 枚举面 A 中 != nd 的节点，看是否出现在面 B 的角点节点里
    for (let i = 0; i < 3; i++) {
      const m = cnNode[fA * 3 + i]
      if (m === nd) continue
      for (let j = 0; j < 3; j++) {
        if (cnNode[fB * 3 + j] === m) return true
      }
    }
    return false
  }

  const dot = (cA, cB) => {
    // 用面积加权向量归一后求夹角（近似即可，均含正面积系数可约去）
    const ax = cnFx[cA]
    const ay = cnFy[cA]
    const az = cnFz[cA]
    const bx = cnFx[cB]
    const by = cnFy[cB]
    const bz = cnFz[cB]
    const la = Math.hypot(ax, ay, az) || 1
    const lb = Math.hypot(bx, by, bz) || 1
    return (ax * bx + ay * by + az * bz) / (la * lb)
  }

  for (let nd = 0; nd < N; nd++) {
    const list = nodeCorners[nd]
    const k = list.length
    if (k < 2) continue
    for (let i = 0; i < k; i++) {
      const cA = list[i]
      for (let j = i + 1; j < k; j++) {
        const cB = list[j]
        if (dot(cA, cB) >= cosTh && facesShareEdge(cA, cB, nd)) {
          const ra = find(cA)
          const rb = find(cB)
          if (ra !== rb) parent[ra] = rb
        }
      }
    }
  }

  // 4) 每并查集根求面积加权平均法线 → 输出顶点（根为代表性角点，取其节点坐标与 uv）
  const outPos = []
  const outNor = []
  const outUv = uvA ? [] : null
  const rootToOut = new Map()
  const accX = new Map()
  const accY = new Map()
  const accZ = new Map()

  const emit = c => {
    const r = find(c)
    let outIdx = rootToOut.get(r)
    if (outIdx == null) {
      outIdx = outPos.length / 3
      rootToOut.set(r, outIdx)
      const nd = cnNode[r]
      outPos.push(nodeX[nd], nodeY[nd], nodeZ[nd])
      if (uvA) outUv.push(uvA[cnOrig[r] * 2], uvA[cnOrig[r] * 2 + 1])
      accX.set(r, 0)
      accY.set(r, 0)
      accZ.set(r, 0)
    }
    accX.set(r, accX.get(r) + cnFx[c])
    accY.set(r, accY.get(r) + cnFy[c])
    accZ.set(r, accZ.get(r) + cnFz[c])
    return outIdx
  }

  for (let c = 0; c < C; c++) emit(c)

  // 归一化法线
  for (const [r, outIdx] of rootToOut) {
    const ax = accX.get(r)
    const ay = accY.get(r)
    const az = accZ.get(r)
    const len = Math.hypot(ax, ay, az) || 1
    outNor[outIdx * 3] = ax / len
    outNor[outIdx * 3 + 1] = ay / len
    outNor[outIdx * 3 + 2] = az / len
  }

  // 5) 重建三角形索引（只查映射，不再累加）
  const getOut = c => rootToOut.get(find(c))
  const outIdxArr = []
  for (let c = 0; c < C; c += 3) {
    const oa = getOut(c)
    const ob = getOut(c + 1)
    const oc = getOut(c + 2)
    if (oa == null || ob == null || oc == null) continue
    if (oa === ob || ob === oc || oa === oc) continue
    outIdxArr.push(oa, ob, oc)
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3))
  if (uvA) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  out.setIndex(outIdxArr)
  return out
}

/**
 * 剔除位于某坐标平面上、朝向指定一侧的盖面三角（内部双盖/隐藏盖面清理）。
 * 例：axis=2(Z)、value=roundDepth、normalSign=+1 → 剔除 z≈roundDepth 且法线朝 +z 的三角。
 * @param {THREE.BufferGeometry} geometry
 * @param {0|1|2} axis
 * @param {number} value
 * @param {1|-1} normalSign 法线沿 axis 正/负方向
 * @param {number} [tol=0.02] 判定"位于平面"的容差（米）
 * @returns {THREE.BufferGeometry}
 */
export function removeTrianglesOnPlane(geometry, axis, value, normalSign, tol = 0.02) {
  const posAttr = geometry.attributes.position
  const P = posAttr.count
  const pa = posAttr.array
  const idx = geometry.index ? geometry.index.array : null
  const uvAttr = geometry.attributes.uv
  const uvA = uvAttr ? uvAttr.array : null
  const colAttr = geometry.attributes.color
  const colA = colAttr ? colAttr.array : null

  const triCount = idx ? idx.length / 3 : P / 3
  const ax = axis === 0 ? 0 : axis === 1 ? 1 : 2
  const keepOrig = [] // 保留的三角形（原始顶点三元组）
  const pt = (i, k) => pa[i * 3 + k]

  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const onPlane =
      Math.abs(pt(a, ax) - value) <= tol &&
      Math.abs(pt(b, ax) - value) <= tol &&
      Math.abs(pt(c, ax) - value) <= tol
    if (!onPlane) {
      keepOrig.push(a, b, c)
      continue
    }
    // 面法线沿 axis 分量符号（标准叉乘 (b-a)×(c-a)）
    const e1 = [pt(b, 0) - pt(a, 0), pt(b, 1) - pt(a, 1), pt(b, 2) - pt(a, 2)]
    const e2 = [pt(c, 0) - pt(a, 0), pt(c, 1) - pt(a, 1), pt(c, 2) - pt(a, 2)]
    const comp =
      ax === 0
        ? e1[1] * e2[2] - e1[2] * e2[1]
        : ax === 1
          ? e1[2] * e2[0] - e1[0] * e2[2]
          : e1[0] * e2[1] - e1[1] * e2[0]
    const sign = comp > 0 ? 1 : comp < 0 ? -1 : 0
    if (sign === normalSign) continue // 剔除
    keepOrig.push(a, b, c)
  }

  // 压缩为仅含被引用顶点的输出几何
  const keyToOut = new Map()
  const outPos = []
  const outUv = uvA ? [] : null
  const outCol = colA ? [] : null
  const outIdxArr = []
  for (let i = 0; i < keepOrig.length; i++) {
    const v = keepOrig[i]
    let o = keyToOut.get(v)
    if (o == null) {
      o = outPos.length / 3
      keyToOut.set(v, o)
      outPos.push(pa[v * 3], pa[v * 3 + 1], pa[v * 3 + 2])
      if (uvA) outUv.push(uvA[v * 2], uvA[v * 2 + 1])
      if (colA) outCol.push(colA[v * 3], colA[v * 3 + 1], colA[v * 3 + 2])
    }
    outIdxArr.push(o)
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  if (uvA) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  if (colA) out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3))
  if (outIdxArr.length > 0) out.setIndex(outIdxArr)
  return out
}

/**
 * 剖切缺口密封：把位于剖切平面(axis 坐标≈planeValue)上、只被 1 个三角占用的
 * "开口边"围成的环用耳切法补成三角面，闭合 CSG 剖切在 rim/内部遗留的漏缝。
 *
 * 依据：侧向剖切(X/Y，切面沿长轴)的剖面 rim 由挤出 steps 分段产生，cap 与侧壁
 * 各自生成少量错位顶点，出现系统性开口缝(Z 向剖切断面轮廓短、无此现象)。
 * 只补"单面开口环"——真实空腔(如炮孔/爆破腔)的孔洞边界边会被腔壁与 cap 两面占用
 * (count=2)，不会被误填，因此洞仍保留。
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {0|1|2} axis 剖切平面法线轴
 * @param {number} planeValue 剖切平面坐标
 * @param {number} [tol=0.05] 判定"在平面内"的容差(米)
 * @returns {THREE.BufferGeometry} 补洞后的几何（无开口环时返回原几何）
 */
export function sealPlaneOpenBoundaries(geometry, axis, planeValue, tol = 0.05) {
  const posAttr = geometry.attributes.position
  const P = posAttr.count
  const pa = posAttr.array
  const idx = geometry.index ? geometry.index.array : null
  const uvAttr = geometry.attributes.uv
  const uvA = uvAttr ? uvAttr.array : null
  const ax = axis

  const coord = (i, k) => pa[i * 3 + k]
  const onPlane = i => Math.abs(coord(i, ax) - planeValue) <= tol
  const vkey = i => `${coord(i, 0).toFixed(4)}|${coord(i, 1).toFixed(4)}|${coord(i, 2).toFixed(4)}`
  const triCount = idx ? idx.length / 3 : P / 3
  const read = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k)

  // 1) 统计每条空间边被几个三角占用
  const edgeCnt = new Map()
  for (let t = 0; t < triCount; t++) {
    const v = [read(t, 0), read(t, 1), read(t, 2)]
    for (let e = 0; e < 3; e++) {
      const a = v[e]
      const b = v[(e + 1) % 3]
      const ka = vkey(a)
      const kb = vkey(b)
      const k = ka < kb ? ka + '~' + kb : kb + '~' + ka
      edgeCnt.set(k, (edgeCnt.get(k) || 0) + 1)
    }
  }

  // 2) 平面内"开口边"(单面占用)建邻接图
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(b).add(a)
  }
  for (let t = 0; t < triCount; t++) {
    const v = [read(t, 0), read(t, 1), read(t, 2)]
    for (let e = 0; e < 3; e++) {
      const a = v[e]
      const b = v[(e + 1) % 3]
      if (!onPlane(a) || !onPlane(b)) continue
      const ka = vkey(a)
      const kb = vkey(b)
      const k = ka < kb ? ka + '~' + kb : kb + '~' + ka
      if (edgeCnt.get(k) === 1) link(ka, kb)
    }
  }
  if (adj.size < 3) return geometry

  // 每个节点采样一组坐标（用于 2D 投影与输出）
  const nodeCoord = new Map()
  for (let i = 0; i < P; i++) {
    if (!onPlane(i)) continue
    const k = vkey(i)
    if (!nodeCoord.has(k)) nodeCoord.set(k, [coord(i, 0), coord(i, 1), coord(i, 2)])
  }

  // 3) 追环（每环度数为 2 的闭路）
  const visited = new Set()
  const loops = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const path = [start]
    visited.add(start)
    let prev = start
    let cur = null
    const first = [...adj.get(start)][0]
    if (first == null) continue
    cur = first
    let guard = 0
    while (cur !== start && guard++ < adj.size + 2) {
      path.push(cur)
      visited.add(cur)
      const nbs = adj.get(cur) || new Set()
      const nb = [...nbs].find(x => x !== prev)
      if (nb == null) break
      prev = cur
      cur = nb
    }
    if (cur === start && path.length >= 3) loops.push(path)
  }
  if (!loops.length) return geometry

  // 4) 耳切填三角（复制原几何，再追加缺口封口面）
  const norAttr = geometry.attributes.normal
  const na = norAttr ? norAttr.array : null
  const u1 = (ax + 1) % 3
  const u2 = (ax + 2) % 3
  const outPos = []
  for (let i = 0; i < P; i++) outPos.push(coord(i, 0), coord(i, 1), coord(i, 2))
  const outNor = []
  if (na) for (let i = 0; i < na.length; i++) outNor.push(na[i])
  else for (let i = 0; i < outPos.length; i++) outNor.push(0)
  const outUv = uvA ? [] : null
  if (uvA) for (let i = 0; i < P; i++) outUv.push(uvA[i * 2], uvA[i * 2 + 1])
  const outIdx = []
  if (idx) for (let i = 0; i < idx.length; i++) outIdx.push(idx[i])
  else for (let i = 0; i < P; i++) outIdx.push(i)

  const axisDir = [0, 0, 0]
  axisDir[ax] = -1 // 剖切保留 dot>=planeValue 侧，开口朝移除侧 = -axis
  for (const loop of loops) {
    const coords = loop.map(k => nodeCoord.get(k)).filter(Boolean)
    if (coords.length < 3 || coords.length !== loop.length) continue
    const contour = coords.map(c => new THREE.Vector2(c[u1], c[u2]))
    let faces
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, [])
    } catch (e) {
      continue
    }
    if (!faces || !faces.length) continue
    // 顶点加入输出（本环内独立，避免环间缠绕）
    const base = outPos.length / 3
    for (const c of coords) {
      outPos.push(c[0], c[1], c[2])
      outNor.push(axisDir[0], axisDir[1], axisDir[2])
      if (uvA) outUv.push(0.5, 0.5)
    }
    for (const f of faces) {
      let a = base + f[0]
      let b = base + f[1]
      let c = base + f[2]
      if (a === b || b === c || a === c) continue
      // 校正绕序：耳切默认绕序不定，保证封口法线指向 -axis（移除侧）
      const px = [coords[f[0]], coords[f[1]], coords[f[2]]]
      const ex = [px[1][0] - px[0][0], px[1][1] - px[0][1], px[1][2] - px[0][2]]
      const ey = [px[2][0] - px[0][0], px[2][1] - px[0][1], px[2][2] - px[0][2]]
      const nx = ex[1] * ey[2] - ex[2] * ey[1]
      const ny = ex[2] * ey[0] - ex[0] * ey[2]
      const nz = ex[0] * ey[1] - ex[1] * ey[0]
      if ([nx, ny, nz][ax] > 0) {
        const t = b
        b = c
        c = t
      }
      outIdx.push(a, b, c)
    }
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3))
  if (uvA) out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
  out.setIndex(outIdx)
  return out
}

/**
 * 锐边提取（按"位置焊接"判共享边）——替代 THREE.EdgesGeometry 用于轮廓线。
 *
 * EdgesGeometry 按顶点索引判边：岩体几何经 weld/crease/孔洞桥接后存在大量
 * "坐标重合但索引不共享"的 T 形单面边，会被当成边界边**全部画出**——掌子面
 * （带洞端面）满屏细线、而侧面（干净侧壁）无线的直接原因。
 * 本实现按量化坐标判边共享：仅输出"恰好被两个面共享且二面角 > angleDeg"的边，
 * 单面边（T 形缝/剖切遗痕）与非流形边（>2 面）一律不画。保留真实锐利折边
 * （岩块外棱、隧道口沿等）。
 * @param {THREE.BufferGeometry} geometry 索引几何
 * @param {number} [angleDeg=20] 二面角阈值（度）
 * @param {number} [posDecimals=4] 位置量化精度（1e-4m）
 * @returns {THREE.BufferGeometry} LineSegments 几何（position, 2 点/段）
 */
export function buildSharpEdgesGeometry(geometry, angleDeg = 20, posDecimals = 4) {
  const posAttr = geometry.attributes.position
  const idxAttr = geometry.index
  if (!posAttr || !idxAttr) return new THREE.BufferGeometry()
  const pa = posAttr.array
  const ia = idxAttr.array
  const vmap = new Map() // 量化键 → 原始坐标 [x,y,z]
  const key = i => {
    const k = Math.pow(10, posDecimals)
    const s = `${Math.round(pa[i * 3] * k)}|${Math.round(pa[i * 3 + 1] * k)}|${Math.round(pa[i * 3 + 2] * k)}`
    if (!vmap.has(s)) vmap.set(s, [pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]])
    return s
  }
  const faceNormal = (a, b, c) => {
    const ux = pa[b * 3] - pa[a * 3], uy = pa[b * 3 + 1] - pa[a * 3 + 1], uz = pa[b * 3 + 2] - pa[a * 3 + 2]
    const vx = pa[c * 3] - pa[a * 3], vy = pa[c * 3 + 1] - pa[a * 3 + 1], vz = pa[c * 3 + 2] - pa[a * 3 + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    return [nx / l, ny / l, nz / l]
  }
  const cosThreshold = Math.cos((angleDeg * Math.PI) / 180)
  // 边 → { ka, kb, normals[] }（按面收集；位置键共享即同一逻辑边）
  const edgeMap = new Map()
  const nT = ia.length / 3
  for (let t = 0; t < nT; t++) {
    const i0 = ia[t * 3], i1 = ia[t * 3 + 1], i2 = ia[t * 3 + 2]
    const n = faceNormal(i0, i1, i2)
    const ks = [key(i0), key(i1), key(i2)]
    for (let e = 0; e < 3; e++) {
      const ka = ks[e]
      const kb = ks[(e + 1) % 3]
      if (ka === kb) continue
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      let rec = edgeMap.get(ek)
      if (!rec) {
        rec = ka < kb ? { ka, kb, normals: [] } : { ka: kb, kb: ka, normals: [] }
        edgeMap.set(ek, rec)
      }
      rec.normals.push(n)
    }
  }
  const out = []
  for (const rec of edgeMap.values()) {
    if (rec.normals.length !== 2) continue // 单面边(缝)/非流形边：不画
    const d =
      rec.normals[0][0] * rec.normals[1][0] +
      rec.normals[0][1] * rec.normals[1][1] +
      rec.normals[0][2] * rec.normals[1][2]
    if (d > cosThreshold) continue // 共面/近共面：不画
    const p1 = vmap.get(rec.ka)
    const p2 = vmap.get(rec.kb)
    out.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2])
  }
  const outGeo = new THREE.BufferGeometry()
  outGeo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  if (out.length) outGeo.computeBoundingSphere()
  return outGeo
}

export default {
  weldPositions,
  creaseNormals,
  removeTrianglesOnPlane,
  removeSliverTriangles,
  buildSharpEdgesGeometry,
  sealPlaneOpenBoundaries
}

/**
 * 剔除"细长/退化"三角形（长短边比超过 maxRatio 者），并对剔除暴露的内部缝
 * 做扇形补面（以环首顶点为扇心，不新增顶点）—— 返回新几何（保持水密：每条边仍恰被两面共享）。
 *
 * 背景：马蹄形断面（R≈W/2 的墙-拱交接）+ 近距孔洞（爆破漏斗口 97% 断面）的
 * Shape/Extrude 端面三角化会产出连接孔洞与远端外边界的扇形细长三角
 * （实测 608 个、长短边比达 708）：
 *   - 填充渲染时跨距数十米的插值/深度竞争 → 热力图横跨整面的细线/条纹伪影；
 *   - 轮廓提取把退化边全部画成线（正面满屏细线的直接来源）。
 * 单纯剔除会打开 T 形缝 → 剖切露洞（rockBodySectionCut.test.js 拦截）；本实现
 * 在剔除的同时，对"原为内部缝、剔除后单面开放"的边追踪成环，逐环以质心扇形
 * 补面（重用环上顶点）——覆盖恢复、
 * 水密保持，且不引入新顶点（剖切封口行走器按原顶点邻接正常工作）。
 *
 * @param {THREE.BufferGeometry} geometry 索引几何（非索引则原样返回）
 * @param {number} [maxRatio=40] 最长边/最短边比阈值
 * @param {number} [capAxisTol=0.02] "端面"判定：三顶点 z 坐标极差 ≤ 该值才剔除。
 *   挤出侧壁（含拱弧曲面段）的长面板长短边比同样超标但是**真实壁面**且不贴
 *   z=常平面——剔除它们会让侧壁被巨扇补面替换、X/Y 剖切水密性破坏；仅剔除
 *   掌子面端面（z=const 平面）上的扇形细长条。挤出轴为 z（与 build_ppv_grid 一致）。
 * @returns {THREE.BufferGeometry} userData.sliversRemoved = 剔除数，patchTris = 补面数
 */
export function removeSliverTriangles(geometry, maxRatio = 40, capAxisTol = 0.02) {
  const idxAttr = geometry.index
  const posAttr = geometry.attributes.position
  if (!idxAttr || !posAttr) return geometry
  const pa = posAttr.array
  const ia = idxAttr.array
  const nT = ia.length / 3
  const d2i = (i, j) => {
    const dx = pa[i * 3] - pa[j * 3]
    const dy = pa[i * 3 + 1] - pa[j * 3 + 1]
    const dz = pa[i * 3 + 2] - pa[j * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }
  // ── 1. 分类 keep / removed ──
  const isKept = new Array(nT)
  let keptTris = 0
  for (let t = 0; t < nT; t++) {
    const a = ia[t * 3], b = ia[t * 3 + 1], c = ia[t * 3 + 2]
    const e0 = d2i(a, b), e1 = d2i(b, c), e2 = d2i(c, a)
    const mn = Math.min(e0, e1, e2)
    const mx = Math.max(e0, e1, e2)
    let sliver = mn > 1e-12 && Math.sqrt(mx / mn) > maxRatio
    if (sliver) {
      // 端面判定：三顶点 z 极差 ≤ tol（贴 z=常平面）。侧壁面板 z 向跨度大 → 保留。
      const za = pa[a * 3 + 2], zb = pa[b * 3 + 2], zc = pa[c * 3 + 2]
      if (Math.max(za, zb, zc) - Math.min(za, zb, zc) > capAxisTol) sliver = false
    }
    isKept[t] = !sliver
    if (isKept[t]) keptTris++
  }
  // ── 2. 边统计（位置键判共享；kept/removed 分开计数）──
  const kq = Math.pow(10, 4)
  const vidx = new Map() // 位置键 -> 原顶点索引（首次出现）
  const vmap = new Map() // 位置键 -> 原始坐标
  const vk = i => {
    const s = `${Math.round(pa[i * 3] * kq)}|${Math.round(pa[i * 3 + 1] * kq)}|${Math.round(pa[i * 3 + 2] * kq)}`
    if (!vidx.has(s)) {
      vidx.set(s, i)
      vmap.set(s, [pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]])
    }
    return s
  }
  const edgeMap = new Map() // ek -> { ka, kb, kept, removed }
  for (let t = 0; t < nT; t++) {
    const ks = [vk(ia[t * 3]), vk(ia[t * 3 + 1]), vk(ia[t * 3 + 2])]
    for (let e = 0; e < 3; e++) {
      const ka = ks[e], kb = ks[(e + 1) % 3]
      if (ka === kb) continue
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      let rec = edgeMap.get(ek)
      if (!rec) {
        rec = ka < kb ? { ka, kb, kept: 0, removed: 0 } : { ka: kb, kb: ka, kept: 0, removed: 0 }
        edgeMap.set(ek, rec)
      }
      if (isKept[t]) rec.kept++
      else rec.removed++
    }
  }
  // ── 3. 洞边 = "原为内部缝、剔除后单面开放"（removed>=1 且 kept===1）──
  // （removed>=1 且 kept===0 的边是剔除区域内部/原本就开放的边界，不补）
  const holeEdges = []
  const holeAdj = new Map()
  for (const rec of edgeMap.values()) {
    if (rec.removed >= 1 && rec.kept === 1) {
      holeEdges.push(rec)
      for (const end of [rec.ka, rec.kb]) {
        let l = holeAdj.get(end)
        if (!l) { l = []; holeAdj.set(end, l) }
        l.push(rec)
      }
    }
  }
  // ── 4. 沿洞边贪心走环 ──
  const used = new Set()
  const loops = [] // 每环 = 位置键数组
  for (const start of holeEdges) {
    if (used.has(start)) continue
    used.add(start)
    const loop = [start.ka, start.kb]
    let tail = start.kb
    let guard = holeEdges.length + 2
    while (guard-- > 0) {
      if (tail === loop[0]) break
      const next = (holeAdj.get(tail) || []).find(e2 => !used.has(e2))
      if (!next) break
      used.add(next)
      tail = next.ka === tail ? next.kb : next.ka
      if (tail === loop[0]) break
      loop.push(tail)
    }
    if (loop.length >= 3) loops.push(loop)
  }
  // ── 5. 输出：保留三角 + 逐环扇形补面（以环首顶点为扇心，不新增顶点）──
  const extraIdx = []
  let patchTris = 0
  for (const loop of loops) {
    // Newell 法线 + 质心
    let nx = 0, ny = 0, nz = 0
    let cx = 0, cy = 0, cz = 0
    for (let i = 0; i < loop.length; i++) {
      const p = vmap.get(loop[i])
      const q = vmap.get(loop[(i + 1) % loop.length])
      nx += (p[1] - q[1]) * (p[2] + q[2])
      ny += (p[2] - q[2]) * (p[0] + q[0])
      nz += (p[0] - q[0]) * (p[1] + q[1])
      cx += p[0]; cy += p[1]; cz += p[2]
    }
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9) continue // 退化环：不补（罕见），接受该处开缝
    nx /= nl; ny /= nl; nz /= nl
    // 扇形补面以**环首顶点**为扇心（不新增顶点）：新增质心点是仅被补面面片
    // 共享的新高阶点，剖切封口行走器在其上无既有邻接信息，Y 轴剖切实测留 5 条
    // 开边；用既有顶点则剖切按原顶点的邻接表正常行走。
    const m = loop.length
    if (m < 3) continue
    const apex = vidx.get(loop[0])
    for (let i = 1; i < m - 1; i++) {
      const ia1 = vidx.get(loop[i])
      const ia2 = vidx.get(loop[i + 1])
      extraIdx.push(apex, ia1, ia2)
      patchTris++
    }
  }
  const keep = new Uint32Array(keptTris * 3 + extraIdx.length)
  let k = 0
  for (let t = 0; t < nT; t++) {
    if (!isKept[t]) continue
    keep[k++] = ia[t * 3]
    keep[k++] = ia[t * 3 + 1]
    keep[k++] = ia[t * 3 + 2]
  }
  for (let i = 0; i < extraIdx.length; i++) keep[k++] = extraIdx[i]
  const out = geometry.clone()
  out.setIndex(new THREE.BufferAttribute(keep, 1))
  out.userData = { ...(geometry.userData || {}), sliversRemoved: nT - keptTris, patchTris }
  return out
}
