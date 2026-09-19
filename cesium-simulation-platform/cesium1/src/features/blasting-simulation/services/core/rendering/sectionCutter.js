/**
 * 剖面剖切器（SectionCutter）——从 SceneBuilder 拆分出的剖面 CSG 剪切算法组：
 * 几何裁剪（轴对齐平面三角裁剪）/ 截面环提取 / 区域三角化 / 剖面填充与标记。
 *
 * 与 SceneBuilder 的协作约定：构造时持有 SceneBuilder 实例（this.sb），剖切状态与
 * 岩体网格（benchMesh/_sliceCutGeo/_sectionCache/_lastCutAxis 等）一律经 sb 引用
 * 直读直写（零深拷贝），保证 SceneBuilder 侧 clear()/dispose()/_cleanupBenchGeometry
 * 及 _setRockGeometry 换基重切等既有清理/重算路径原样有效。
 */
import * as THREE from 'three'
import { sealPlaneOpenBoundaries, weldPositions } from './geometrySmoothing.js'

export class SectionCutter {
  /** @param {import('./sceneBuilder.js').SceneBuilder} sb 宿主 SceneBuilder（状态载体） */
  constructor(sb) {
    this.sb = sb
  }

  /**
   * 设置岩体剖面裁剪（爆破模式下观察内部）。
   * @param {number} [enabled] 0 关 / 1 开
   * @param {number} [axis] 0=X 1=Y 2=Z（基于场景 rel 坐标）
   * @param {number} [pos] 裁剪平面沿轴位置
   *
   * 切割策略：岩体（bench）用几何真剖切（CSG）保证截面实心封口；
   * 其余全部模型（掌子面/漏斗/隧道壳/开挖管/围岩环等）用**同一世界空间平面**
   * 统一施加材质级裁剪，与岩体剖切面对齐，实现"全部模型一同切割"而非只切岩体。
   */
  setSectionPlane({ enabled = 0, axis = 0, pos = 0 } = {}) {
    const sb = this.sb
    const a = [0, 1, 2].includes(Number(axis)) ? Number(axis) : 0
    if (!enabled) {
      // 还原出完整几何体（并释放剖切生成的临时封口几何与缓存）
      sb._sectionEnabled = false
      sb._sectionPos = null
      this._clearSectionCache()
      this._restoreSectionGeometry()
      // 清除全部模型的材质级裁剪（同世界平面解除）
      this._applySceneSection(false, a, 0)
      return
    }
    // 若已处于剖切态，先还原完整几何，再对新的平面位置重新剖切，
    // 避免在已剖切几何上反复裁剪导致顶点流失、封口错乱
    if (sb._sliceCutGeo) this._restoreSectionGeometry()
    this._clearSectionCache()
    const base = sb.benchMesh?.geometry
    this._applySectionCut(a, Number(pos) || 0)
    // 记录"场景级剖切请求"：_setRockGeometry 换基时据此对同一平面重新剖切
    sb._sectionEnabled = true
    sb._sectionAxis = a
    sb._sectionPos = sb._lastCutPos != null ? sb._lastCutPos : Number(pos) || 0
    if (base && sb.benchMesh && sb.benchMesh.geometry !== base) {
      sb._sectionCache.set(base, {
        axis: sb._sectionAxis,
        pos: sb._sectionPos,
        geo: sb.benchMesh.geometry
      })
    }
    // 全部模型一同切割：同一世界平面作用到场景所有对象材质
    this._applySceneSection(true, a, sb._sectionPos)
  }

  /**
   * 将场景级剖切平面施加/移除到"全部模型"材质（非岩体对象也一体切割）。
   * 与岩体 CSG 剖切使用同一世界平面（法线=世界轴，过 uCenter+axis·pos），保证各对象
   * 切面严格共面。
   * - 自定义场材质（带 uSectionEnabled）：走世界空间 discard（shader 内已实现）。
   * - 内置标准材质（MeshStandardMaterial 等）：用 material.clippingPlanes（世界平面，
   *   需 renderer.localClippingEnabled=true），Three 内部将其变换到对象局部空间。
   */
  _applySceneSection(enabled, axis, pos) {
    const sb = this.sb
    const mats = new Set()
    sb.scene?.traverse(o => {
      if (!o || !o.material) return
      const drawable = o.isMesh || o.isLine || o.isLineSegments || o.isPoints || o.isSprite
      if (!drawable) return
      if (Array.isArray(o.material)) o.material.forEach(m => mats.add(m))
      else mats.add(o.material)
    })

    // 求岩体 CSG 剖切面对应的"世界平面"：用与 _applySectionCut 相同的 mesh 变换，
    // 把"局部某轴上 = pos"的切面点局部坐标经 localToWorld 映射到世界，得到与岩体
    // 切面严格共面的平面(法线=该局部轴的世界方向)。这一步是掌子面/漏斗/隧道壳等
    // 全部对象与岩体一致切割、且保留侧不反的关键。
    const mesh = sb.benchMesh
    let plane = null
    let nWorld = new THREE.Vector3(1, 0, 0)
    let cWorld = 0
    if (enabled && mesh?.isMesh) {
      mesh.updateMatrixWorld(true)
      const e = new THREE.Vector3(0, 0, 0)
      const lp = new THREE.Vector3(0, 0, 0)
      if (axis === 1) {
        e.y = 1
        lp.y = Number(pos) || 0
      } else if (axis === 2) {
        e.z = 1
        lp.z = Number(pos) || 0
      } else {
        e.x = 1
        lp.x = Number(pos) || 0
      }
      const o = new THREE.Vector3(0, 0, 0)
      mesh.localToWorld(o) // 岩体坐标原点在世界
      const dir = mesh.localToWorld(e.clone()).sub(o)
      nWorld = dir.lengthSq() > 1e-12 ? dir.clone().normalize() : new THREE.Vector3(1, 0, 0)
      const pCut = mesh.localToWorld(lp) // 切面上世界点：局部该轴坐标 = pos
      cWorld = -pCut.dot(nWorld)
      plane = new THREE.Plane(nWorld.clone(), cWorld)
    }

    for (const m of mats) {
      if (m === sb._benchFieldMaterial) continue // 岩体走 CSG 几何剖切，避免双重削切封口
      if (m?.uniforms && m.uniforms.uSectionEnabled !== undefined) {
        // 自定义场材质：用同一世界平面 discard（与 CSG 一致）
        m.uniforms.uSectionEnabled.value = enabled ? 1 : 0
        if (enabled) {
          m.uniforms.uSectionNWorld.value.copy(nWorld)
          m.uniforms.uSectionCWorld.value = cWorld
          m.uniforms.uSectionAxis.value = axis
          m.uniforms.uSectionPos.value = Number(pos) || 0
        }
      } else {
        // 内置标准材质 + 线条/点材质（LineBasic/Points 等）：统一用世界平面裁剪，
        // 使轮廓线、描边线跨切面的半截部分随平面一同消失，不留"外形残留线"
        m.clippingPlanes = plane ? [plane] : null
        if (plane) m.clipShadows = true
        // 变更裁剪平面需重编译 shader，clipping 代码才会编入（仅运行时统一重编一次）
        m.needsUpdate = true
      }
    }
  }

  /** 还原被剖切前的完整岩体几何（并释放剖切生成的临时封口几何） */
  _restoreSectionGeometry() {
    const sb = this.sb
    const mesh = sb.benchMesh
    if (sb._sliceCutGeo) {
      if (sb._sliceCutGeo.dispose) sb._sliceCutGeo.dispose()
      sb._sliceCutGeo = null
    }
    if (sb._slicePristineGeo && mesh && mesh.geometry !== sb._slicePristineGeo) {
      mesh.geometry = sb._slicePristineGeo
      sb._benchGeoVersion++ // 还原完整几何 → 等值线需重提取
    }
    sb._slicePristineGeo = null
  }

  /** 释放剖切结果缓存（并释放各缓存几何） */
  _clearSectionCache() {
    const sb = this.sb
    const current = sb.benchMesh?.geometry
    for (const c of sb._sectionCache.values()) {
      if (c.geo && c.geo !== current && c.geo.dispose) c.geo.dispose()
    }
    sb._sectionCache.clear()
  }

  /**
   * 对给定基础几何(base)应用当前剖切请求，返回剖切几何（命中缓存则直接复用，
   * 避免爆破状态互换时反复整块 CSG 重算）。会同步 benchMesh.geometry 到该几何。
   * @param {THREE.BufferGeometry} base 基础几何（_rockGeoPre / _rockGeoPost）
   * @returns {THREE.BufferGeometry}
   */
  _cutBaseGeometry(base) {
    const sb = this.sb
    const mesh = sb.benchMesh
    if (!mesh) return base
    const hit = sb._sectionCache.get(base)
    if (hit && hit.axis === sb._sectionAxis && hit.pos === sb._sectionPos) {
      // 复用缓存：落到当前基础几何，仅换引用，不重算
      if (sb._sliceCutGeo && sb._sliceCutGeo !== hit.geo && sb._sliceCutGeo.dispose) {
        sb._sliceCutGeo.dispose()
      }
      sb._sliceCutGeo = hit.geo
      sb._slicePristineGeo = base
      mesh.geometry = hit.geo
      return hit.geo
    }
    // 未命中：先还原并释放旧剖切，再在基础几何上重切
    if (sb._sliceCutGeo) {
      if (sb._sliceCutGeo.dispose) sb._sliceCutGeo.dispose()
      sb._sliceCutGeo = null
    }
    sb._slicePristineGeo = null
    mesh.geometry = base
    this._applySectionCut(sb._sectionAxis, sb._sectionPos)
    const out = mesh.geometry
    sb._sectionCache.set(base, { axis: sb._sectionAxis, pos: sb._sectionPos, geo: out })
    return out
  }

  /**
   * 几何真剖切（CSG，axis-aligned 平面）：保留 dot(v,轴)>=pos 的一侧，并在平面处
   * 生成贴合岩体实际截面的实心封口面，使剖切后为封闭实体块（three 仍是表面网格，
   * 但剖面被真实三角剖分封口，视觉上呈现实心断面）。
   * @param {number} axis 0=X 1=Y 2=Z（局部坐标轴）
   * @param {number} pos 归一化比例 [0,1]：0=包围盒一端，1=另一端，0.5=居中
   */
  _applySectionCut(axis, pos) {
    const sb = this.sb
    const mesh = sb.benchMesh
    const geo = mesh?.geometry
    const posAttr = geo?.getAttribute?.('position')
    if (!posAttr) return
    const P = posAttr.array
    // 仅当尚未捕获原始几何时才记录为"原始"，防止反复剖切时把已剖切的几何误记为原始，
    // 导致 _restoreSectionGeometry 还原到一个已被切的几何上（顶点流失/封口错乱）。
    if (sb._slicePristineGeo == null) sb._slicePristineGeo = geo

    // 计算岩体完整 AABB（标记尺寸与剖切钳制共用），并把剖切面位置
    // 解释为沿该轴的实际局部坐标、钳制在包围盒内，保证任何取值都只做
    // 真实剖切、不会把整块岩体剔除。
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (let i = 0; i < P.length; i += 3) {
      for (let c2 = 0; c2 < 3; c2++) {
        const v = P[i + c2]
        if (v < box.min[c2]) box.min[c2] = v
        if (v > box.max[c2]) box.max[c2] = v
      }
    }
    if (Number.isFinite(box.min[axis]) && Number.isFinite(box.max[axis])) {
      sb._sectionBox = box
    }
    let cutPos = Number(pos)
    if (!Number.isFinite(cutPos)) cutPos = (box.min[axis] + box.max[axis]) / 2
    if (box.min[axis] <= box.max[axis]) {
      cutPos = Math.max(box.min[axis], Math.min(box.max[axis], cutPos))
    }

    const N = geo.getAttribute('normal').array
    const UV = geo.getAttribute('uv')?.array
    const idx = geo.index ? geo.index.array : null
    const count = posAttr.count

    const outPos = []
    const outNor = []
    const outUv = []
    const outIdx = []
    const secKey = new Map()
    const secPts = []
    const secEdges = []

    const vkey = (x, y, z) => `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`
    const getSec = (x, y, z, u, v) => {
      const k = vkey(x, y, z)
      let i = secKey.get(k)
      if (i == null) {
        i = secPts.length
        secKey.set(k, i)
        secPts.push({ x, y, z, u, v })
      }
      return i
    }

    const emitTri = (a, b, c) => {
      let nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
      let ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)
      let nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      const base = outPos.length / 3
      outPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      outNor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
      outUv.push(a.u, a.v, b.u, b.v, c.u, c.v)
      outIdx.push(base, base + 1, base + 2)
    }

    const process = (i0, i1, i2) => {
      const v = [i0, i1, i2].map(i => ({
        x: P[i * 3],
        y: P[i * 3 + 1],
        z: P[i * 3 + 2],
        nx: N[i * 3],
        ny: N[i * 3 + 1],
        nz: N[i * 3 + 2],
        u: UV ? UV[i * 2] : 0,
        v: UV ? UV[i * 2 + 1] : 0
      }))
      const ins = v.map(o => {
        const c = axis === 0 ? o.x : axis === 1 ? o.y : o.z
        return c - cutPos >= -1e-7
      })
      const anyOut = !ins[0] || !ins[1] || !ins[2]
      if (!anyOut) {
        emitTri(v[0], v[1], v[2])
        return
      }
      if (!ins[0] && !ins[1] && !ins[2]) return
      // 跨越平面：保留 keep 侧顶点 + 在平面处插值出顶点
      const keep = []
      const plane = []
      for (let e = 0; e < 3; e++) {
        const a = v[e]
        const b = v[(e + 1) % 3]
        if (ins[e]) keep.push(a)
        if (ins[e] !== ins[(e + 1) % 3]) {
          const ca = axis === 0 ? a.x : axis === 1 ? a.y : a.z
          const cb = axis === 0 ? b.x : axis === 1 ? b.y : b.z
          const t = (cutPos - ca) / (cb - ca)
          const iv = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
            u: a.u + (b.u - a.u) * t,
            v: a.v + (b.v - a.v) * t
          }
          keep.push(iv)
          plane.push(iv)
        }
      }
      for (let k = 1; k < keep.length - 1; k++) emitTri(keep[0], keep[k], keep[k + 1])
      if (plane.length === 2) {
        const ia = getSec(plane[0].x, plane[0].y, plane[0].z, plane[0].u, plane[0].v)
        const ib = getSec(plane[1].x, plane[1].y, plane[1].z, plane[1].u, plane[1].v)
        if (ia !== ib) secEdges.push([ia, ib])
      }
    }

    if (idx) for (let i = 0; i < idx.length; i += 3) process(idx[i], idx[i + 1], idx[i + 2])
    else for (let i = 0; i < count; i += 3) process(i, i + 1, i + 2)

    // 剖面封口：把截面边缘段连成若干个闭合环，再按环逐环三角化，生成贴合岩体
    // 实际截面的实心封口面（岩体为封闭实体 → 每个截面恰为 1 个闭合环，但通用地按
    // 多环处理以兼容罕见的非连通截面）。
    if (secPts.length >= 3 && secEdges.length) {
      // 关键：爆破后岩体_rockGeoPost 的"新掌子面"由薄盘拼成，与空腔壁呈 T 形相接，
      // 剖切平面经过新掌子面时，截面边界会出现度数 >2 的非流形顶点（T 形接点）。
      // 旧的贪心走查 adj[cur].find(x=>x!==prev) 在这种接点会走错分支，把边界碎裂成
      // 几十条零碎环，新掌子面那条带整段漏封 → 剖切截面露大洞（实测 39 条单面边）。
      // 这里改用"按平面极角排序的半边面遍历"（直线段平面镶嵌的面提取）：能为非流形
      // 图逐面提取出干净的边界环（内部 T 形缝把实体面再细分、无碍填充），从根上消除
      // 走查错乱。若提取结果不足则回退旧的贪心走查。
      const robust = this._extractSectionLoops(axis, secPts, secEdges)
      const rings =
        robust && robust.length ? robust : this._greedySectionLoops(secEdges, secPts.length)
      // 用 ear-clipping（含孔洞）三角化封口面，避免质心扇形对马蹄形(外环+隧道孔洞)
      // 截面产生覆盖孔洞/重叠/空洞，导致切开后后方岩体空心。
      this._fillSection(axis, rings, secPts, emitTri)
    }

    let newGeo = new THREE.BufferGeometry()
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
    newGeo.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3))
    newGeo.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
    newGeo.setIndex(outIdx)
    newGeo.computeBoundingSphere()
    // 剖切缺口密封：侧向剖切(X/Y，切面沿长轴)的剖面 rim 由挤出 steps 分段生成，
    // cap 与侧壁存在系统性错位开口缝（Z 向剖切断面轮廓短、无此现象，见
    // geometrySmoothing.test）。sealPlaneOpenBoundaries 只补平面上"单面开口环"，
    // 真实空腔/炮孔的孔洞边界会被腔壁与 cap 两面占用而不被误填。
    // 注意：不要再对剖切 newGeo 做 creaseNormals/weldPositions 二次抛光——会把已
    // 按折痕拆棱的网格上的大平面封口误判退化整面丢弃（剖切面露出大洞的旧回归）。
    // 迭代密封：每补一轮后可能暴露新的开口环，循环补到不再变化（最多 5 轮）。
    for (let i = 0; i < 5; i++) {
      const sealed = sealPlaneOpenBoundaries(newGeo, axis, cutPos, 0.05)
      if (sealed === newGeo) break
      newGeo.dispose()
      newGeo = sealed
    }
    // 剖切封口后，把所有位置重合的顶点焊回单一实例：封口面边界与岩体原始顶点经插值/去重后
    // 存在极微错位的小裂缝（尤其是贯穿零厚度新掌子面薄盘的区域），焊接后彻底闭合 → 剖切剖面
    // 不再露洞。随后按共享顶点重算法线（平滑，无碍视觉）。
    newGeo = weldPositions(newGeo, 1e-4)
    if (!newGeo.attributes.normal) newGeo.computeVertexNormals()
    if (sb._sliceCutGeo) {
      if (sb._sliceCutGeo.dispose) sb._sliceCutGeo.dispose()
      sb._sliceCutGeo = null
    }
    mesh.geometry = newGeo
    sb._sliceCutGeo = newGeo
    mesh.material.needsUpdate = true
    // 先记录本次剖切平面，再重建轮廓线：让 _attachRockOutline 能据此过滤掉
    // 完全落在切面上的三角剖分线，只保留岩体向切面以外延伸的真实外轮廓锐利折边。
    sb._lastCutAxis = axis
    sb._lastCutPos = cutPos
    // 剖切替换几何后，旧轮廓线（基于完整几何的 EdgesGeometry）仍挂在网格外，
    // 会把完整岩体的折痕线穿过剖切面叠加成杂乱线条。基于新几何重建描边，
    // 让轮廓线贴合剖切后的真实边界。
    sb._attachRockOutline(mesh, 0.9, 91)
    sb._benchGeoVersion++ // 剖切几何替换 → 等值线需重提取
  }

  // 旧式贪心走查截面环（仅在 _extractSectionLoops 退化时兜底）：
  // 沿 secEdges 邻接图，无脑取"不是前一个"的邻居继续走。要求每个顶点度数=2（流形），
  // 因此对爆破后岩体的 T 形接点（度数>2）会走错、碎裂。仅作为极少数退化输入的兜底。
  _greedySectionLoops(secEdges, n) {
    const adj = Array.from({ length: n }, () => [])
    const seenEdge = new Set()
    const ekey = (a, b) => `${Math.min(a, b)}|${Math.max(a, b)}`
    for (const [a, b] of secEdges) {
      const k = ekey(a, b)
      if (seenEdge.has(k)) continue
      seenEdge.add(k)
      adj[a].push(b)
      adj[b].push(a)
    }
    const rings = []
    const usedVer = new Set()
    for (let s = 0; s < n; s++) {
      if (usedVer.has(s)) continue
      const ring = []
      let cur = s
      let prev = -1
      let safety = 0
      while (cur !== -1 && !ring.includes(cur) && safety < n + 2) {
        ring.push(cur)
        usedVer.add(cur)
        const next = adj[cur].find(x => x !== prev) ?? -1
        prev = cur
        cur = next
        safety++
      }
      if (ring.length >= 3) rings.push(ring)
    }
    return rings
  }

  /**
   * 稳健的截面环提取：把剖切平面上的边缘段当作"直线段平面镶嵌"，对每个顶点的邻接
   * 半边按截面平面内极角排序，然后对每条有向半边做"左侧面"遍历，逐面提出边界环。
   *
   * 与贪心走查的区别：即便某顶点度数 >2（如爆破后新掌子面薄盘与空腔壁的 T 形接点），
   * 也能按角度正确选择"贴实体面走"的下一条边，而非随机走错分支；结果每个环都是实体
   * 面（或孔洞/独立区域）的干净闭合边界，供 _groupSectionRegions 分组后耳切填充。
   * @param {number} axis 截面平面法线轴（0=X 1=Y 2=Z）
   * @param {{x,y,z}[]} secPts 截面顶点池
   * @param {Array<[number,number]>} secEdges 截面边界段（顶点索引对）
   * @returns {number[][]} 闭环序列（每个元素为 secPts 索引环）
   */
  _extractSectionLoops(axis, secPts, secEdges) {
    const n = secPts.length
    if (n < 3 || !secEdges.length) return []
    const u1 = (axis + 1) % 3
    const u2 = (axis + 2) % 3
    const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
    // 2D 投影坐标
    const P2 = secPts.map(p => [c(p, u1), c(p, u2)])
    // 无向邻接表（按边去重；相邻曲面三角形对同一边各贡献一次）
    const adj = Array.from({ length: n }, () => [])
    const seen = new Set()
    const ekey = (a, b) => `${Math.min(a, b)}|${Math.max(a, b)}`
    for (const [a, b] of secEdges) {
      const k = ekey(a, b)
      if (seen.has(k)) continue
      seen.add(k)
      adj[a].push(b)
      adj[b].push(a)
    }
    // 每个顶点按平面内极角排序的有向半边（带出方向）
    const half = Array.from({ length: n }, () => [])
    for (let v = 0; v < n; v++) {
      const ent = adj[v].map(t => ({
        t,
        ang: Math.atan2(P2[t][1] - P2[v][1], P2[t][0] - P2[v][0])
      }))
      ent.sort((a, b) => a.ang - b.ang)
      half[v] = ent.map(e => e.t)
    }
    const used = new Set()
    const loops = []
    for (let v = 0; v < n; v++) {
      for (const nb of half[v]) {
        const dk = `${v}:${nb}`
        if (used.has(dk)) continue
        // 沿有向边 (v→nb) 的"左侧面"绕行：到 nb 后找反向边 (nb→v) 的位置，
        // 取逆时针序的下一条 → 恰好沿该面边界走一圈。
        const loop = []
        let a = v
        let b = nb
        let guard = 0
        while (!used.has(`${a}:${b}`) && guard++ < n + 2) {
          used.add(`${a}:${b}`)
          loop.push(a)
          const hb = half[b]
          const revIdx = hb.indexOf(a)
          // 反向半边 (b→a) 的下一条（逆时针）= revIdx+1；若 revIdx 未找到则按 0 兜底
          const next = revIdx >= 0 ? hb[(revIdx + 1) % hb.length] : (hb[0] ?? -1)
          if (next < 0) break
          a = b
          b = next
        }
        if (loop.length >= 3) loops.push(loop)
      }
    }
    // 去掉重复环（同一有向边可能被两个方向遍历出同一几何环）；按"顶点序列规范化"去重
    const norm = s => [...new Set(s)].sort((x, y) => x - y).join(',')
    const seenLoop = new Set()
    const out = []
    for (const lp of loops) {
      const key = norm(lp)
      if (seenLoop.has(key)) continue
      seenLoop.add(key)
      out.push(lp)
    }
    return out
  }

  // 用质心扇形三角化填充一个没有孔洞的截面环（作为 ear-clipping 的兜底）
  _fillSectionRing(ring, points, emitTri) {
    const n = ring.length
    if (n < 3) return
    let cx = 0
    let cy = 0
    let cz = 0
    for (const i of ring) {
      cx += points[i].x
      cy += points[i].y
      cz += points[i].z
    }
    const c = { x: cx / n, y: cy / n, z: cz / n, u: cx / n, v: cy / n }
    for (let k = 1; k < n - 1; k++) {
      emitTri(c, points[ring[k]], points[ring[k + 1]])
    }
  }

  /**
   * 把截面环分组为"外环 + 孔洞"区域。支持多个互不相交的区域（如 X/Y 向剖切
   * 穿过隧道时，截面分为底板下方与拱顶上方两个独立区域），每个区域独立三角化，
   * 否则把第二个区域误当第一个区域的孔洞会导致其不被填充 → 剖开后空心。
   * @param {number} axis 0=X 1=Y 2=Z（截面平面法线轴）
   * @param {number[][]} rings 每个元素为 secPts 索引环
   * @param {{x,y,z,u?,v?}[]} secPts 截面顶点池
   * @returns {Array<{outer:number[], holes:number[][]}>} 索引指向 rings
   */
  _groupSectionRegions(axis, rings, secPts) {
    const u1 = (axis + 1) % 3
    const u2 = (axis + 2) % 3
    const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
    const ringPts = rings.map(ring => ring.map(i => ({ x: c(secPts[i], u1), y: c(secPts[i], u2) })))
    const areas = ringPts.map(pts => {
      let a = 0
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]
        const q = pts[(k + 1) % pts.length]
        a += p.x * q.y - p.y * q.x
      }
      return a / 2
    })
    const pointInPoly = (px, py, poly) => {
      let inside = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x
        const yi = poly[i].y
        const xj = poly[j].x
        const yj = poly[j].y
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
      }
      return inside
    }
    // 每个环的"直接父环"：包含它且面积最小的环；-1 表示它是外环
    const parent = rings.map((_, j) => {
      let best = -1
      let bestArea = Infinity
      for (let i = 0; i < rings.length; i++) {
        if (i === j || Math.abs(areas[i]) <= Math.abs(areas[j])) continue
        const pts = ringPts[j]
        let anyIn = false
        for (const p of pts) {
          if (pointInPoly(p.x, p.y, ringPts[i])) {
            anyIn = true
            break
          }
        }
        if (anyIn && Math.abs(areas[i]) < bestArea) {
          best = i
          bestArea = Math.abs(areas[i])
        }
      }
      return best
    })
    const regions = []
    for (let i = 0; i < rings.length; i++) {
      if (parent[i] !== -1) continue
      const holes = []
      for (let j = 0; j < rings.length; j++) {
        if (parent[j] === i) holes.push(rings[j])
      }
      regions.push({ outer: rings[i], holes })
    }
    return regions
  }

  /**
   * 在剖面载体上把截面三角化成实心封口面。
   * 岩体截面可能为"外环 + 隧道孔洞"（Z 向剖切）或"多个互不相交区域"
   * （X/Y 向剖切穿过隧道：底板下方 + 拱顶上方），按区域分组后逐区域
   * 用耳切法(ear-clipping，THREE.ShapeUtils 内含 earcut)三角化，
   * 才能真正闭合成实心；否则质心扇形/单外环会把孔洞填满或漏掉独立区域，
   * 切开后看进去仍是空洞。
   * 同时把各区域的外环/孔洞三维顶点记录到 sb._sectionRegions 供切面轮廓标记复用。
   * @param {number} axis 0=X 1=Y 2=Z（截面平面法线轴）
   * @param {number[][]} rings 每个元素为 secPts 索引环
   * @param {{x,y,z,u?,v?}[]} secPts 截面顶点池
   * @param {Function} emitTri 输出三角面的回调
   */
  _fillSection(axis, rings, secPts, emitTri) {
    const sb = this.sb
    if (!rings || !rings.length) return
    const regions = this._groupSectionRegions(axis, rings, secPts)
    if (!regions.length) return

    // 记录轮廓点（三维）供切面轮廓标记绘制：各区域外环 + 各孔洞环
    sb._sectionRegions = regions.map(({ outer, holes }) => ({
      outer: outer.map(i => new THREE.Vector3(secPts[i].x, secPts[i].y, secPts[i].z)),
      holes: holes.map(h => h.map(i => new THREE.Vector3(secPts[i].x, secPts[i].y, secPts[i].z)))
    }))
    if (sb._sectionLastAxis !== axis) sb._sectionLastAxis = axis

    for (const { outer, holes } of regions) {
      const outer3D = outer.map(i => secPts[i])
      const holes3D = holes.map(h => h.map(i => secPts[i]))
      const faces = this._triangulateRings(axis, outer3D, holes3D)
      if (faces) {
        const order = [...outer]
        for (const h of holes) order.push(...h)
        for (const t of faces) {
          emitTri(secPts[order[t[0]]], secPts[order[t[1]]], secPts[order[t[2]]])
        }
      } else {
        // 兜底：外环质心扇形（仅当 ear-clipping 由于退化输入失败时）
        this._fillSectionRing(outer, secPts, emitTri)
      }
    }
  }

  /**
   * ear-clipping：把外环 + 孔洞环三角化（在法线=axis 的截面上做 2D 投影）。
   * 注意：contour/hole 必须用 THREE.Vector2（带 .equals），否则 ShapeUtils 内部
   * removeDupEndPts 调用 points[l-1].equals(...) 对纯对象抛异常 → 永远回退质心扇形。
   * @returns {number[][]|null} 三角面（索引指向 order = outer 后接各 hole 顶点序列），失败返回 null
   */
  _triangulateRings(axis, outer, holes) {
    const u1 = (axis + 1) % 3
    const u2 = (axis + 2) % 3
    const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
    try {
      const contour = outer.map(p => new THREE.Vector2(c(p, u1), c(p, u2)))
      const holeArr = holes.map(h => h.map(p => new THREE.Vector2(c(p, u1), c(p, u2))))
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeArr)
      // triangulateShape 内部 removeDupEndPts 可能 pop 掉终止重复点，导致索引漂移 → 保守回退
      if (contour.length !== outer.length) return null
      return faces.filter(t => t.length === 3)
    } catch (e) {
      return null
    }
  }

  /**
   * 拾取式剖切：给定岩体上的一个局部点与切割轴，构造过该点、法线沿该轴的
   * 剖切面，生成实体封口断面，并在切面上绘制轮廓轮廓标记（半透明面 + 边界线 + 中心点）。
   * @param {number} axis 0=X 1=Y 2=Z
   * @param {Object} point {x,y,z} 岩体局部坐标
   */
  setSectionPick(axis, point = {}) {
    const sb = this.sb
    const a = [0, 1, 2].includes(Number(axis)) ? Number(axis) : 0
    // 若已处于剖切态（切换切割轴），先还原完整几何，再对新的平面位置重新剖切，
    // 避免在已剖切几何上反复裁剪导致顶点流失、封口错乱、切面不贴合真实截面。
    if (sb._sliceCutGeo) this._restoreSectionGeometry()
    this._clearSectionCache()
    const base = sb.benchMesh?.geometry
    const comp = a === 0 ? point.x : a === 1 ? point.y : point.z
    this._applySectionCut(a, Number.isFinite(Number(comp)) ? Number(comp) : 0)
    sb._sectionEnabled = true
    sb._sectionAxis = a
    sb._sectionPos = sb._lastCutPos ?? 0
    if (base && sb.benchMesh && sb.benchMesh.geometry !== base) {
      sb._sectionCache.set(base, {
        axis: sb._sectionAxis,
        pos: sb._sectionPos,
        geo: sb.benchMesh.geometry
      })
    }
    this._updateSectionMarker(a)
    // 拾取式剖切同样作用于全部模型（掌子面/漏斗/隧道壳/开挖管等一同被切），
    // 与岩体几何剖切对齐同一世界平面。
    this._applySceneSection(true, a, sb._sectionPos)
    return { enabled: 1, axis: a, pos: sb._sectionPos }
  }

  /**
   * 显示/隐藏拾取点标记：在岩体表面拾取一点后、选择切割轴前给出视觉反馈，
   * 让用户明确"切割面将过这个点"。point 传 null 或非法值时隐藏。
   * @param {{x,y,z}|null} point 岩体局部坐标
   */
  setPickPointMarker(point = null) {
    const sb = this.sb
    const mesh = sb.benchMesh
    if (!mesh) return
    if (!sb._pickPointMarker) {
      const group = new THREE.Group()
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 20, 16),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
      )
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 20, 16),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.35,
          depthWrite: false
        })
      )
      group.add(core, halo)
      group.renderOrder = 100
      mesh.add(group)
      sb._pickPointMarker = group
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
      sb._pickPointMarker.position.set(point.x, point.y, point.z)
      sb._pickPointMarker.visible = true
    } else {
      sb._pickPointMarker.visible = false
    }
  }

  /** 更新切面轮廓标记到当前剖切面（局部坐标，作为岩体子对象）。
   *  轮廓取自真实剖切截面：各区域外环 + 各孔洞环边界线，以及 ear-clipping 填充面。 */
  _updateSectionMarker(axis) {
    const sb = this.sb
    const mesh = sb.benchMesh
    const cutPos = sb._lastCutPos
    if (!mesh || !Number.isFinite(cutPos)) return
    const regions = sb._sectionRegions || []
    if (!regions.length) return

    // 边界线：各区域外环 + 各孔洞环（首尾闭合，拆成线段对）
    const linePts = []
    for (const { outer, holes } of regions) {
      for (let i = 0; i < outer.length; i++) linePts.push(outer[i], outer[(i + 1) % outer.length])
      for (const h of holes) {
        for (let i = 0; i < h.length; i++) linePts.push(h[i], h[(i + 1) % h.length])
      }
    }
    // 填充面：逐区域 ear-clipping 三角化（含孔洞）
    const fillPos = this._sectionFillPositions(axis, regions)

    if (!sb._sectionMarkerGroup) {
      sb._sectionMarkerGroup = new THREE.Group()
      // 不再绘制蓝色边界轮廓线（用户反馈切面多一圈线，仅保留半透明填充面与中心球）
      sb._sectionFill = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: 0x3b82f6,
          transparent: true,
          opacity: 0.018,
          side: THREE.DoubleSide,
          depthWrite: false,
          // 蓝面与 CSG 岩体封口 cap 严格共面 → z-fighting：转动视角时封口三角网格透过
          // 半透明蓝面忽隐忽现（"切面布满网格线并一闪一闪"）。polygonOffset 让蓝面深度
          // 略朝相机偏置，解除与封口面的深度竞争，蓝面仍精确贴于切面位置。
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        })
      )
      sb._sectionSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
      )
      sb._sectionMarkerGroup.add(sb._sectionFill, sb._sectionSphere)
      sb._sectionMarkerGroup.renderOrder = 99
      mesh.add(sb._sectionMarkerGroup)
    }

    const fg = sb._sectionFill.geometry
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fillPos), 3))
    fg.computeVertexNormals()

    // 中心点球置于剖切面上（沿轴取 cutPos，其余轴取最大外环质心）
    let largest = regions[0]
    for (const r of regions) {
      if (r.outer.length > largest.outer.length) largest = r
    }
    const outer = largest.outer
    let cx = 0
    let cy = 0
    let cz = 0
    for (const p of outer) {
      cx += p.x
      cy += p.y
      cz += p.z
    }
    const n = outer.length || 1
    sb._sectionSphere.position.set(
      axis === 0 ? cutPos : cx / n,
      axis === 1 ? cutPos : cy / n,
      axis === 2 ? cutPos : cz / n
    )
    sb._sectionMarkerGroup.visible = true
  }

  /** 计算切面填充面顶点（平面坐标序列 [x,y,z,...]），逐区域 ear-clipping 含孔洞三角化 */
  _sectionFillPositions(axis, regions) {
    const out = []
    for (const { outer, holes } of regions) {
      const faces = this._triangulateRings(axis, outer, holes)
      if (faces) {
        const order = [...outer]
        for (const h of holes) order.push(...h)
        for (const t of faces) {
          for (const i of t) out.push(order[i].x, order[i].y, order[i].z)
        }
        continue
      }
      // 兜底：外环质心扇形
      const n = outer.length
      const c = { x: 0, y: 0, z: 0 }
      for (const p of outer) {
        c.x += p.x
        c.y += p.y
        c.z += p.z
      }
      c.x /= n
      c.y /= n
      c.z /= n
      for (let k = 1; k < n - 1; k++) {
        out.push(
          c.x,
          c.y,
          c.z,
          outer[k].x,
          outer[k].y,
          outer[k].z,
          outer[k + 1].x,
          outer[k + 1].y,
          outer[k + 1].z
        )
      }
    }
    return out
  }

  /** 清除拾取式剖切：移除轮廓标记并还原完整岩体 */
  clearSectionPick() {
    const sb = this.sb
    if (sb._pickPointMarker) {
      const parent = sb._pickPointMarker.parent
      if (parent) parent.remove(sb._pickPointMarker)
      sb._pickPointMarker.traverse(o => {
        if (o.geometry?.dispose) o.geometry.dispose()
        if (o.material?.dispose) o.material.dispose()
      })
      sb._pickPointMarker = null
    }
    if (sb._sectionMarkerGroup) {
      const parent = sb._sectionMarkerGroup.parent
      if (parent) parent.remove(sb._sectionMarkerGroup)
      if (sb._sectionFill) sb._sectionFill.geometry.dispose()
      if (sb._sectionSphere) sb._sectionSphere.geometry.dispose()
      sb._sectionMarkerGroup = null
      sb._sectionFill = null
      sb._sectionSphere = null
    }
    sb._sectionEnabled = false
    sb._sectionPos = null
    this._clearSectionCache()
    this._restoreSectionGeometry()
    sb._sectionBox = null
    sb._sectionRegions = null
    sb._sectionLastAxis = null
    sb._lastCutAxis = null
    sb._lastCutPos = null
    // 还原岩体的同时，解除全部模型的材质级裁剪（同世界平面移除）
    this._applySceneSection(false, 0, 0)
  }

  getSectionPlane() {
    const sb = this.sb
    return {
      enabled: sb._sectionEnabled ? 1 : 0,
      axis: sb._sectionAxis,
      pos: sb._sectionPos ?? 0
    }
  }
}
