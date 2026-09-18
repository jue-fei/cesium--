import { describe, it, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
// canvas stub 单源：../__tests__/helpers/canvasStub.js
import { installCanvasStub } from '../__tests__/helpers/canvasStub.js'

function buildBuilder(triggered) {
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
  if (triggered) sb.applyBlastState(true)
  return sb
}

function polyArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - p.y * q.x
  }
  return a / 2
}

// Project a 3D region outline to the section plane and return plot points {x,y}
function projectRegion(region, axis) {
  const u1 = (axis + 1) % 3
  const u2 = (axis + 2) % 3
  const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
  const to2 = pts => pts.map(p => ({ x: c(p, u1), y: c(p, u2) }))
  return { outer: to2(region.outer), holes: region.holes.map(to2) }
}

function pointInPoly(px, py, poly) {
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

function triArea2(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2
}
function pointInTri(p, a, b, c) {
  return (
    Math.abs(triArea2(a, b, c) - triArea2(p, b, c) - triArea2(a, p, c) - triArea2(a, b, p)) <= 1e-6
  )
}

// Uniformly sample a grid across the bounding box of the section; for each sample point:
//   * expected-covered = inside the rock section (inside an outer ring and not inside its hole)
//   * actually-covered = inside any cap triangle
// Report missed ratio.
function analyzeHoles(sb, axis) {
  const regions = sb._sectionRegions
  if (!regions || !regions.length)
    return {
      axis,
      regions: regions ? regions.length : 0,
      fillTris: 0,
      missed: 0,
      total: 0,
      ratio: 1
    }

  const plots = regions.map(r => projectRegion(r, axis))
  const u1 = (axis + 1) % 3
  const u2 = (axis + 2) % 3
  const c = (v, ax) => (v[ax] === 0 ? 0 : v[ax])

  // cap triangles: read from _sectionFill geometry positions (vertex triples)
  const fg = sb._sectionFill?.geometry
  const tris = []
  if (fg) {
    const pos = fg.getAttribute('position').array
    for (let i = 0; i < pos.length; i += 9) {
      const a = { x: pos[i + u1], y: pos[i + u2] }
      const b = { x: pos[i + 3 + u1], y: pos[i + 3 + u2] }
      const cc = { x: pos[i + 6 + u1], y: pos[i + 6 + u2] }
      tris.push([a, b, cc])
    }
  }

  // bounding box of all outer rings
  let mn = Infinity
  let mx = -Infinity
  for (const p of plots) {
    for (const pt of p.outer) {
      mn = Math.min(mn, pt.x, pt.y)
      mx = Math.max(mx, pt.x, pt.y)
    }
  }

  const N = 240
  let total = 0
  let missed = 0
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const px = mn + ((mx - mn) * i) / N
      const py = mn + ((mx - mn) * j) / N
      // expected covered?
      let exp = false
      for (const pl of plots) {
        if (!pointInPoly(px, py, pl.outer)) continue
        let inHole = false
        for (const h of pl.holes) if (pointInPoly(px, py, h)) inHole = true
        if (inHole) continue
        exp = true
        break
      }
      if (!exp) continue
      total++
      let cov = false
      for (const [a, b, cc] of tris) {
        if (pointInTri({ x: px, y: py }, a, b, cc)) {
          cov = true
          break
        }
      }
      if (!cov) missed++
    }
  }
  const ratio = total ? missed / total : 0
  return {
    axis,
    regions: regions.length,
    fillTris: tris.length,
    missed,
    total,
    ratio: +ratio.toFixed(4)
  }
}

beforeAll(installCanvasStub)

describe('REPRO: section cap holes (stress field mode)', () => {
  it('scan pre/post geometry cuts for uncovered (hole) regions', () => {
    for (const triggered of [false, true]) {
      const sb = buildBuilder(triggered)
      const geo = triggered ? sb._rockGeoPost : sb._rockGeoPre
      geo.computeBoundingBox()
      const b = geo.boundingBox

      const report = []
      // general scan across each axis (positions set by _applySectionCut interprets as the axis coordinate clamping into AABB)
      for (let axis = 0; axis < 3; axis++) {
        const min = axis === 0 ? b.min.x : axis === 1 ? b.min.y : b.min.z
        const max = axis === 0 ? b.max.x : axis === 1 ? b.max.y : b.max.z
        const positions = []
        for (let k = 1; k <= 4; k++) positions.push(min + ((max - min) * k) / 5)
        for (const pos of positions) {
          sb.setSectionPlane({ enabled: 0, axis: 0, pos: 0 })
          sb._sectionRegions = null
          const point = { x: 0, y: 0, z: 0 }
          point[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'] = pos
          sb.setSectionPick(axis, point)
          const r = analyzeHoles(sb, axis)
          r.pos = +pos.toFixed(2)
          report.push(r)
        }
      }
      // POST ring region: Z cut within [0, roundDepth=2.5] reveals rectangle-with-tunnel-hole ring
      if (triggered) {
        for (const pos of [0.6, 1.2, 1.8, 2.4]) {
          sb.setSectionPlane({ enabled: 0, axis: 0, pos: 0 })
          sb._sectionRegions = null
          sb.setSectionPick(2, { x: 0, y: 0, z: pos })
          const r = analyzeHoles(sb, 2)
          r.pos = +pos.toFixed(2)
          r.tag = 'RING'
          report.push(r)
        }
      }
      console.log(`\n[REPRO] geometry=${triggered ? 'POST' : 'PRE'}  states:`)
      for (const r of report) {
        console.log(
          `  ${r.tag || '   '} axis=${r.axis} pos=${r.pos} regions=${r.regions} fillTris=${r.fillTris} ` +
            `sample=${r.total} missed=${r.missed} HOLE_RATIO=${r.ratio}`
        )
      }
      const bad = report.filter(r => r.ratio > 0.03)
      console.log(
        `  → significant hole ratio (>3%): ${
          bad.map(r => `ax${r.axis}@${r.pos}:${r.ratio}`).join(', ') || 'NONE'
        }`
      )
    }
  }, 120000)
})
