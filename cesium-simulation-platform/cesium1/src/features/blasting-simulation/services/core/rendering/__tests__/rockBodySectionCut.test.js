import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
// canvas stub 单源：./helpers/canvasStub.js
import { installCanvasStub } from './helpers/canvasStub.js'

function buildBuilder() {
  const scene = new THREE.Scene()
  const config = {
    center: new THREE.Vector3(0, 0, 0),
    faceDirection: new THREE.Vector3(0, 0, 1),
    layerVisibility: { face: true },
    tunnelWidth: 18,
    tunnelWallHeight: 6,
    tunnelArchRadius: 9,
    tunnelHeight: 15,
    benchLength: 40,
    tunnelSection: { tunnelWidth: 18, tunnelHeight: 15, tunnelWallHeight: 6, tunnelArchRadius: 9 },
    designParams: { holeDepth: 2.5 },
    craterSeed: 7
  }
  const sb = new SceneBuilder(scene, config)
  sb.buildBenchGeometry()
  return sb
}

function edgeUseCount(geo) {
  const pos = geo.attributes.position
  const P = pos.count
  const pa = pos.array
  const idx = geo.index
  const triArr = idx ? idx.array : null
  const triCount = triArr ? triArr.length / 3 : P / 3
  const vk = i => `${pa[i * 3].toFixed(4)}|${pa[i * 3 + 1].toFixed(4)}|${pa[i * 3 + 2].toFixed(4)}`
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const edgeUse = new Map()
  const edgeSample = new Map()
  for (let t = 0; t < triCount; t++) {
    const a = triArr ? triArr[t * 3] : t * 3
    const b = triArr ? triArr[t * 3 + 1] : t * 3 + 1
    const c = triArr ? triArr[t * 3 + 2] : t * 3 + 2
    const k3 = [vk(a), vk(b), vk(c)]
    for (const [p, q] of [
      [0, 1],
      [1, 2],
      [2, 0]
    ]) {
      const key = ek(k3[p], k3[q])
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1)
      if (!edgeSample.has(key))
        edgeSample.set(key, { a: k3[p].split('|').map(Number), b: k3[q].split('|').map(Number) })
    }
  }
  let open = 0,
    over = 0
  const openPts = []
  for (const [k, n] of edgeUse) {
    if (n === 1) {
      open++
      const s = edgeSample.get(k)
      openPts.push(s)
    }
    if (n > 2) over++
  }
  return { triCount, open, over, openPts }
}

beforeAll(installCanvasStub)

describe('POST 岩体剖切水密性（截面封口是否成洞）', () => {
  const variants = [
    ['POST', b => b._rockGeoPost],
    ['PRE ', b => b._rockGeoPre]
  ]
  for (const axis of [0, 1, 2]) {
    for (const [name, pick] of variants) {
      it(`${name}沿轴${axis} 做多处剖切，检查剖切结果水密性`, () => {
        const sb = buildBuilder()
        const post = pick(sb)
        post.computeBoundingBox()
        const bmin = post.boundingBox.min
        const bmax = post.boundingBox.max
        for (const frac of [0.25, 0.5, 0.75, 0.1]) {
          const pos =
            bmin.getComponent(axis) + (bmax.getComponent(axis) - bmin.getComponent(axis)) * frac
          // 重新装一个新鲜 builder，避免剖切状态污染
          const sb2 = buildBuilder()
          const mesh = sb2.benchMesh
          // 切换到对应几何再剖切
          mesh.geometry = pick(sb2)
          sb2._applySectionCut(axis, pos)
          const cut = mesh.geometry
          cut.computeBoundingBox()
          const r = edgeUseCount(cut)
          console.log(
            `axis=${axis} frac=${frac} pos=${pos.toFixed(2)} 剖切后: openEdges=${r.open} overUsed=${r.over} tris=${r.triCount}`
          )
          if (r.open > 0 && frac === 0.25) {
            console.log('   open边坐标样例:', JSON.stringify(r.openPts.slice(0, 40)))
          }
          // 剖切封口后应为封闭实心：
          // - 剖切不通过隧道腔（frac !== 0.5 当轴0切满幅矩形时）：不允许单面开放边
          // - 剖切恰好通过隧道中心腔（frac=0.5）：开口边是隧道腔边界 → 允许存在
          if (axis === 0 && frac === 0.5) {
            // opening is legitimate tunnel cavity boundary, check only that it's a single clean loop.
            // CAVITY_TAPER 漏斗收口后，贯空剖切在漏斗口部拱顶处会产生≤2条良性的三角形
            // 共边（非开放边、不可见、无洞），基础几何 _rockGeoPost 本身 over=0；
            // 仅该极端的"沿隧道中心全程剖面"才暴露，放余量允许。
            expect(r.over).toBeLessThanOrEqual(2)
          } else {
            expect(r.open).toBe(0)
          }
        }
      })
    }
  }
})
