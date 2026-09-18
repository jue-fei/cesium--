import { describe, it, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
// canvas stub 单源：../__tests__/helpers/canvasStub.js
import { installCanvasStub } from '../__tests__/helpers/canvasStub.js'

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

// re-use the same open-edge analysis
function edgeUse(geo) {
  const pos = geo.attributes.position
  const P = pos.count
  const pa = pos.array
  const idx = geo.index
  const triArr = idx ? idx.array : null
  const triCount = triArr ? triArr.length / 3 : P / 3
  const vk = i => `${pa[i * 3].toFixed(3)}|${pa[i * 3 + 1].toFixed(3)}|${pa[i * 3 + 2].toFixed(3)}`
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const use = new Map()
  const samp = new Map()
  for (let t = 0; t < triCount; t++) {
    const a = triArr ? triArr[t * 3] : t * 3
    const b = triArr ? triArr[t * 3 + 1] : t * 3 + 1
    const c = triArr ? triArr[t * 3 + 2] : t * 3 + 2
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const aa = vk(p),
        bb = vk(q)
      const key = aa < bb ? `${aa}|${bb}` : `${bb}|${aa}`
      use.set(key, (use.get(key) || 0) + 1)
      if (!samp.has(key))
        samp.set(key, [
          pa[p * 3],
          pa[p * 3 + 1],
          pa[p * 3 + 2],
          pa[q * 3],
          pa[q * 3 + 1],
          pa[q * 3 + 2]
        ])
    }
  }
  const open = []
  for (const [k, n] of use) if (n === 1) open.push(samp.get(k))
  return open
}

beforeAll(installCanvasStub)

describe('debug slit axis0', () => {
  it('dump open edges for x=0 (through tunnel) loop structure', () => {
    const sb = buildBuilder()
    const mesh = sb.benchMesh
    const post = sb._rockGeoPost
    post.computeBoundingBox()
    const bmin = post.boundingBox.min,
      bmax = post.boundingBox.max
    const pos = bmin.x + (bmax.x - bmin.x) * 0.5 // x=0 through tunnel
    mesh.geometry = sb._rockGeoPost
    sb._applySectionCut(0, pos)
    const open = edgeUse(mesh.geometry)
    console.log('cut pos=', pos, ' total open edges=', open.length)
    // group into connected loops
    const ptk = (x, y, z) =>
      `${Math.round(x * 1000)}|${Math.round(y * 1000)}|${Math.round(z * 1000)}`
    const adj = new Map()
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, [])
      if (!adj.has(b)) adj.set(b, [])
      adj.get(a).push(b)
      adj.get(b).push(a)
    }
    const pts = new Map()
    for (const e of open) {
      const a = ptk(e[0], e[1], e[2]),
        b = ptk(e[3], e[4], e[5])
      link(a, b)
      if (!pts.has(a)) pts.set(a, [e[0], e[1], e[2]])
      if (!pts.has(b)) pts.set(b, [e[3], e[4], e[5]])
    }
    const visited = new Set()
    const loops = []
    for (const s of adj.keys()) {
      if (visited.has(s)) continue
      let cur = s,
        prev = null,
        ring = []
      const guard = new Set()
      while (cur != null && !guard.has(cur)) {
        guard.add(cur)
        visited.add(cur)
        ring.push(cur)
        const nbs = adj.get(cur) || []
        const nb = nbs.find(x => x !== prev) ?? nbs[0] ?? null
        prev = cur
        cur = nb
      }
      if (ring.length >= 3) loops.push(ring)
    }
    loops.sort((a, b) => a.length - b.length)
    loops.forEach((r, i) => {
      const zs = r.map(k => pts.get(k)[2])
      const ys = r.map(k => pts.get(k)[1])
      const zr = [Math.min(...zs), Math.max(...zs)],
        yr = [Math.min(...ys), Math.max(...ys)]
      console.log(
        `loop${i}: len ${r.length} yRange[${yr[0].toFixed(1)},${yr[1].toFixed(1)}] zRange[${zr[0].toFixed(2)},${zr[1].toFixed(2)}]`
      )
    })
  })
})
