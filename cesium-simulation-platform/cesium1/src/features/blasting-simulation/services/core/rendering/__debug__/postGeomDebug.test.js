import { describe, it, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
import { removeTrianglesOnPlane } from '../geometrySmoothing.js'
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
    craterSeed: 7,
    surfacePolish: false
  }
  const sb = new SceneBuilder(scene, config)
  sb.buildBenchGeometry()
  return sb
}

// use edge-count with QUAD precision (round to 4 decimals) so coincident seam vertices combine
function edgeReport(geo, q = 4) {
  const pos = geo.attributes.position
  const P = pos.count
  const pa = pos.array
  const idx = geo.index
  const triArr = idx ? idx.array : null
  const triCount = triArr ? triArr.length / 3 : P / 3
  const vk = i => `${pa[i * 3].toFixed(q)}|${pa[i * 3 + 1].toFixed(q)}|${pa[i * 3 + 2].toFixed(q)}`
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const use = new Map()
  const samp = new Map()
  const zhist = new Map()
  for (let t = 0; t < triCount; t++) {
    const a = triArr ? triArr[t * 3] : t * 3
    const b = triArr ? triArr[t * 3 + 1] : t * 3 + 1
    const c = triArr ? triArr[t * 3 + 2] : t * 3 + 2
    for (const [p, q2] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const key = ek(vk(p), vk(q2))
      use.set(key, (use.get(key) || 0) + 1)
      if (!samp.has(key))
        samp.set(key, [
          pa[p * 3],
          pa[p * 3 + 1],
          pa[p * 3 + 2],
          pa[q2 * 3],
          pa[q2 * 3 + 1],
          pa[q2 * 3 + 2]
        ])
    }
  }
  let open = 0,
    over = 0
  const openE = []
  for (const [k, n] of use) {
    if (n === 1) {
      open++
      openE.push(samp.get(k))
      const z = +samp.get(k)[2].toFixed(2)
      zhist.set(z, (zhist.get(z) || 0) + 1)
    }
    if (n > 2) over++
  }
  // sort open edges by z then x then y, print a sample
  openE.sort((A, B) => A[2] - B[2] || A[0] - B[0] || A[1] - B[1])
  return { triCount, open, over, openE, zhist }
}

beforeAll(installCanvasStub)

describe('POST geometry hole/gap root cause', () => {
  it('uncut POST watertight + open edges grouped by z', () => {
    const sb = buildBuilder()
    const post = sb._rockGeoPost
    post.computeBoundingBox()
    const r = edgeReport(post, 4)
    console.log('POST uncut open=', r.open, 'over=', r.over, 'tris=', r.triCount)
    console.log(
      'z-hist (open edge count per z):',
      JSON.stringify([...r.zhist].sort((a, b) => a[0] - b[0]))
    )
    console.log('sample open edges:', JSON.stringify(r.openE.slice(0, 25)))
  })

  it('around z=roundDepth: does ring wall inner rim meet center disc?', () => {
    const sb = buildBuilder()
    const post = sb._rockGeoPost
    // find open edges strictly on z=2.125
    const r = edgeReport(post, 4)
    const atPlane = r.openE.filter(
      e => Math.abs(e[2] - 2.125) < 0.01 && Math.abs(e[5] - 2.125) < 0.01
    )
    console.log('open edges entirely on z=2.125:', atPlane.length)
    console.log('sample:', JSON.stringify(atPlane.slice(0, 20)))
  })

  it('CRITICAL: which z-depth does the big full-width seam live at (coarse tol 1e-1)?', () => {
    // At tolerance 0.1 the whole new-face stack merges; count components
    const sb = buildBuilder()
    const post = sb._rockGeoPost
    const r = edgeReport(post, 1)
    console.log('coarse tol open=', r.open, 'over=', r.over)
    console.log('coarse z-hist:', JSON.stringify([...r.zhist].sort((a, b) => a[0] - b[0])))
    console.log('coarse sample open:', JSON.stringify(r.openE.slice(0, 20)))
  })
})
