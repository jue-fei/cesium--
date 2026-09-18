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

function edgeReport(geo, q = 6) {
  const px = geo.attributes.position
  const pa = px.array
  const idx = geo.index
  const ta = idx ? idx.array : null
  const tc = ta ? ta.length / 3 : px.count / 3
  const vk = i => `${pa[i * 3].toFixed(q)}|${pa[i * 3 + 1].toFixed(q)}|${pa[i * 3 + 2].toFixed(q)}`
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const use = new Map()
  const samp = new Map()
  for (let t = 0; t < tc; t++) {
    const a = ta ? ta[t * 3] : t * 3,
      b = ta ? ta[t * 3 + 1] : t * 3 + 1,
      c = ta ? ta[t * 3 + 2] : t * 3 + 2
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const k = ek(vk(p), vk(q))
      use.set(k, (use.get(k) || 0) + 1)
      if (!samp.has(k))
        samp.set(k, [
          pa[p * 3],
          pa[p * 3 + 1],
          pa[p * 3 + 2],
          pa[q * 3],
          pa[q * 3 + 1],
          pa[q * 3 + 2]
        ])
    }
  }
  let open = 0
  const oe = []
  for (const [k, n] of use) {
    if (n === 1) {
      open++
      oe.push(samp.get(k))
    }
  }
  return { open, oe }
}

beforeAll(installCanvasStub)

describe('locate residual open edge', () => {
  for (const axis of [0, 1]) {
    it(`axis=${axis} residual open edge coords`, () => {
      const sb = buildBuilder()
      const post = sb._rockGeoPost
      post.computeBoundingBox()
      const bmin = post.boundingBox.min,
        bmax = post.boundingBox.max
      for (const frac of [0.25, 0.6, 0.9]) {
        const pos =
          bmin.getComponent(axis) + (bmax.getComponent(axis) - bmin.getComponent(axis)) * frac
        const sb2 = buildBuilder()
        const mesh = sb2.benchMesh
        mesh.geometry = sb2._rockGeoPost
        sb2._applySectionCut(axis, pos)
        const r = edgeReport(mesh.geometry, 6)
        console.log(
          `axis=${axis} frac=${frac} pos=${pos.toFixed(2)} open=${r.open} edges=${JSON.stringify(r.oe)}`
        )
      }
    })
  }
})
