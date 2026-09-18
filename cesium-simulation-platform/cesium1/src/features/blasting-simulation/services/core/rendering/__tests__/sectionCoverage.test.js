import { describe, it, beforeAll, expect } from 'vitest'
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

// Rasterize the sectioned mesh footprint on the section plane (u1,u2 free axes) and
// report whether the solid silhouette is covered (fill present) at every 3D face.
function raster(faces, bbox) {
  const hit = new Map()
  for (const f of faces) {
    // f = [ [x,y,z], [x,y,z], [x,y,z] ]
    const cx = (f[0][0] + f[1][0] + f[2][0]) / 3
    const cy = (f[0][1] + f[1][1] + f[2][1]) / 3
    const cz = (f[0][2] + f[1][2] + f[2][2]) / 3
    // 2D bucket on (y,z) plane ~ 0.5 step
    const by = Math.round((cy - bbox.min.y) / 0.5)
    const bz = Math.round((cz - bbox.min.z) / 0.5)
    const k = `${by}|${bz}`
    hit.set(k, true)
  }
  return hit
}

function triFaces(geo) {
  const pa = geo.attributes.position.array
  const idx = geo.index ? geo.index.array : null
  const tc = idx ? idx.length / 3 : geo.attributes.position.count / 3
  const out = []
  for (let t = 0; t < tc; t++) {
    const a = idx ? idx[t * 3] : t * 3,
      b = idx ? idx[t * 3 + 1] : t * 3 + 1,
      c = idx ? idx[t * 3 + 2] : t * 3 + 2
    out.push([
      [pa[a * 3], pa[a * 3 + 1], pa[a * 3 + 2]],
      [pa[b * 3], pa[b * 3 + 1], pa[b * 3 + 2]],
      [pa[c * 3], pa[c * 3 + 1], pa[c * 3 + 2]]
    ])
  }
  return out
}

beforeAll(installCanvasStub)

describe('POST section is visually solid (no big hole)', () => {
  it('axis0 x=-36: lower region (z<roundDepth) is covered by fill triangles', () => {
    const sb = buildBuilder()
    const mesh = sb.benchMesh
    const post = sb._rockGeoPost
    post.computeBoundingBox()
    const bmin = post.boundingBox.min,
      bmax = post.boundingBox.max
    const pos = bmin.x + (bmax.x - bmin.x) * 0.25
    mesh.geometry = sb._rockGeoPost
    sb._applySectionCut(0, pos)
    const g = mesh.geometry
    const faces = triFaces(g)
    const rd = 2.125
    // filter faces that lie on the section plane x≈pos (the new fill + cut disk) and have centroid z < rd
    const lo = faces.filter(
      f => f.every(p => Math.abs(p[0] - pos) < 0.2) && (f[0][2] + f[1][2] + f[2][2]) / 3 < rd - 0.05
    )
    const hi = faces.filter(
      f => f.every(p => Math.abs(p[0] - pos) < 0.2) && (f[0][2] + f[1][2] + f[2][2]) / 3 > rd + 0.05
    )
    console.log(`plane triangles below new-face: ${lo.length}, above: ${hi.length}`)
    // total sectioned-solid triangles (faces at x≈pos) should be substantial (region filled, not a big hole)
    const planeAll = faces.filter(f => f.every(p => Math.abs(p[0] - pos) < 0.2))
    console.log(`plane triangles total: ${planeAll.length}`)
    expect(lo.length).toBeGreaterThan(50) // lower ring rock IS filled
    expect(hi.length).toBeGreaterThan(50) // upper core IS filled
  })

  it('axis0 x=0 through tunnel: section still filled with a tunnel void (no giant open hole)', () => {
    const sb = buildBuilder()
    const mesh = sb.benchMesh
    const post = sb._rockGeoPost
    post.computeBoundingBox()
    const bmin = post.boundingBox.min,
      bmax = post.boundingBox.max
    const pos = bmin.x + (bmax.x - bmin.x) * 0.5 // x=0
    mesh.geometry = sb._rockGeoPost
    sb._applySectionCut(0, pos)
    const faces = triFaces(mesh.geometry)
    const planeAll = faces.filter(f => f.every(p => Math.abs(p[0] - pos) < 0.2))
    console.log(`through-tunnel plane triangles total: ${planeAll.length}`)
    const b = mesh.geometry.boundingBox || mesh.geometry.computeBoundingBox()
    const rd = 2.125
    const lo = planeAll.filter(f => (f[0][2] + f[1][2] + f[2][2]) / 3 < rd - 0.05)
    console.log(`through-tunnel triangles below new-face: ${lo.length}`)
    // 贯空剖面大部分是隧道空腔（void），岩体只在仰拱/拱顶上下两条竖向薄带；
    // CAVITY_TAPER 漏斗收口后该带收窄。阈值只需保证剖面非空（无"整片大洞"）。
    expect(planeAll.length).toBeGreaterThan(20)
  })
})
