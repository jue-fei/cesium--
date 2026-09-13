import { describe, it, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
import { creaseNormals } from '../geometrySmoothing.js'

function canvas(ctx) { return { width: 0, height: 0, getContext: () => ctx } }
function makeCtx() {
  return { fillStyle:'',strokeStyle:'',lineWidth:1,textBaseline:'alphabetic',font:'',
    fillRect(){},strokeRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},
    stroke(){},measureText(t){return{width:String(t||'').length*12}},fillText(){},
    scale(){},translate(){},rotate(){},setTransform(){},save(){},restore(){},clearRect(){} }
}
beforeAll(() => { if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => canvas(makeCtx()) } })

function buildBuilder() {
  const scene = new THREE.Scene()
  const config = {
    center: new THREE.Vector3(0, 0, 0), faceDirection: new THREE.Vector3(0, 0, 1),
    layerVisibility: { face: true }, tunnelWidth: 18, tunnelWallHeight: 6, tunnelArchRadius: 9,
    tunnelHeight: 15, benchLength: 40,
    tunnelSection: { tunnelWidth: 18, tunnelHeight: 15, tunnelWallHeight: 6, tunnelArchRadius: 9 },
    designParams: { holeDepth: 2.5 }, craterSeed: 7
  }
  const sb = new SceneBuilder(scene, config)
  sb.buildBenchGeometry()
  return sb
}

describe('POST 几何水密性诊断', () => {
  it('统计开放边界边（单面边=水密性失败）与重叠边', () => {
    const sb = buildBuilder()
    const geo = sb._rockGeoPost
    const rd = sb._rockRoundDepth
    const pos = geo.attributes.position
    const idx = geo.index
    const P = pos.count
    const pa = new Float64Array(pos.array)
    const triArr = idx ? idx.array : null
    const triCount = triArr ? triArr.length / 3 : P / 3
    const vk = (i) => `${pa[i*3].toFixed(4)}|${pa[i*3+1].toFixed(4)}|${pa[i*3+2].toFixed(4)}`
    const ek = (a,b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
    const edgeUse = new Map() // undirected edge -> count
    const edgeSamples = new Map()
    for (let t = 0; t < triCount; t++) {
      const a = triArr ? triArr[t*3] : t*3
      const b = triArr ? triArr[t*3+1] : t*3+1
      const c = triArr ? triArr[t*3+2] : t*3+2
      const k3 = [vk(a), vk(b), vk(c)]
      const pairs = [[0,1],[1,2],[2,0]]
      for (const [p,q] of pairs) {
        const key = ek(k3[p], k3[q])
        const n = (edgeUse.get(key) || 0) + 1
        edgeUse.set(key, n)
        if (!edgeSamples.has(key)) edgeSamples.set(key, { a: k3[p].split('|').map(Number), b: k3[q].split('|').map(Number) })
      }
    }
    const open = []
    const over = []
    for (const [k, n] of edgeUse) {
      if (n === 1) open.push(k)
      if (n > 2) over.push(k)
    }
    const zAt = (k) => { const s = edgeSamples.get(k); return (s.a[2] + s.b[2]) / 2 }
    const yAt = (k) => { const s = edgeSamples.get(k); return (s.a[1] + s.b[1]) / 2 }
    const openNearJunct = open.filter(k => Math.abs(zAt(k) - rd) < 0.3)
    const openNear0 = open.filter(k => Math.abs(zAt(k)) < 0.3)
    const openNearBack = open.filter(k => Math.abs(zAt(k) - 0) < 1 && Math.abs(zAt(k) - rd) > 0.3)
    console.log(`POST: tris=${triCount} verts=${P} indexed=${!!idx}`)
    console.log(`roundDepth=${rd}`)
    console.log(`openEdges(单面边,非水密)=${open.length}  overUsedEdges(>2面共享)=${over.length}`)
    console.log(`  openEdges@近 z=roundDepth(±0.3)=${openNearJunct.length}`)
    console.log(`  openEdges@近 z=0 掌子面开口(±0.3)=${openNear0.length}`)
    console.log(`  openEdges@其余位置=${open.length - openNearJunct.length - openNear0.length}`)
    const sample = open.slice(0, 12).map(k => { const s = edgeSamples.get(k); return `z~${zAt(k).toFixed(2)} y~${yAt(k).toFixed(2)} @(${s.a.map(x=>x.toFixed(1)).join(',')})-(${s.b.map(x=>x.toFixed(1)).join(',')})` })
    console.log('  open 边样例:', JSON.stringify(sample))

    // 新掌子面中心（隧道断面洞口，z≈roundDepth, x≈0）法线方向应朝 -z（面向隧道口/空腔）
    const nap = geo.attributes.normal.array
    const posA = pa
    let centerNormZ = null, countOnFace = 0, negZ = 0
    for (let t = 0; t < triCount; t++) {
      const a = triArr ? triArr[t*3] : t*3
      // 用三角形三个顶点都在 z≈rd、且几何中心 x≈0 的三角形代表新掌子面
      const vx = [a, triArr? triArr[t*3+1]:t*3+1, triArr? triArr[t*3+2]:t*3+2]
      if (vx.every(i => Math.abs(posA[i*3+2] - rd) < 0.05)) {
        const cx = (posA[vx[0]*3]+posA[vx[1]*3]+posA[vx[2]*3])/3
        if (Math.abs(cx) < 2.5) {
          countOnFace++
          // triangle normal from index (only valid for raw positions; use winding)
          const e1x=posA[vx[1]*3]-posA[vx[0]*3], e1y=posA[vx[1]*3+1]-posA[vx[0]*3+1], e1z=posA[vx[1]*3+2]-posA[vx[0]*3+2]
          const e2x=posA[vx[2]*3]-posA[vx[0]*3], e2y=posA[vx[2]*3+1]-posA[vx[0]*3+1], e2z=posA[vx[2]*3+2]-posA[vx[0]*3+2]
          const nz = e1x*e2y-e1y*e2x
          if (nz < 0) negZ++
        }
      }
    }
    console.log(`新掌子面中心区三角形: count=${countOnFace} 法线-z(面朝隧道口)占比=${countOnFace? (negZ/countOnFace*100).toFixed(1):'-'}%`)
    // 打印平面三角的分布：按 (x,y) 归类 +z 与 -z，帮助判断来源（环背盖 or 中心盘）
    const buckets = {}
    for (let t = 0; t < triCount; t++) {
      const vx = [ triArr?triArr[t*3]:t*3, triArr?triArr[t*3+1]:t*3+1, triArr?triArr[t*3+2]:t*3+2 ]
      if (!vx.every(i => Math.abs(posA[i*3+2] - rd) < 0.05)) continue
      const cx = (posA[vx[0]*3]+posA[vx[1]*3]+posA[vx[2]*3])/3
      const cy = (posA[vx[0]*3+1]+posA[vx[1]*3+1]+posA[vx[2]*3+1])/3
      const k = `${Math.round(cx/3)},${Math.round(cy/3)}`
      const e1x=posA[vx[1]*3]-posA[vx[0]*3], e1y=posA[vx[1]*3+1]-posA[vx[0]*3+1]
      const e2x=posA[vx[2]*3]-posA[vx[0]*3], e2y=posA[vx[2]*3+1]-posA[vx[0]*3+1]
      const nz = e1x*e2y-e1y*e2x
      const dir = nz < 0 ? 'n' : 'p'
      buckets[k] = buckets[k] || { p: 0, n: 0 }
      buckets[k][dir]++
    }
    const stable = Object.entries(buckets).map(([k,v]) => `${k}(-${v.n}/+${v.p})`).join('  ')
    console.log('平面三角按(x,y)分布:', stable)
    const allNeg = Object.values(buckets).every(v => v.p === 0)
    console.log('新掌子面整面全部朝-z(无背向三角):', allNeg)

    // 直接构造中心盘并反转绕序，检查其法线分布（隔离 creaseNormals 影响）
    const ts = sb._createTunnelShape(0, 18, 6, 9, 15)
    let probe = new THREE.ShapeGeometry(ts, 64)
    if (probe.index) {
      const a = probe.index.array
      for (let i = 0; i < a.length; i += 3) { const t = a[i+1]; a[i+1] = a[i+2]; a[i+2] = t }
    }
    const pp = probe.attributes.position.array
    const pidx = probe.index.array
    let pNeg = 0, pPos = 0
    for (let t = 0; t < pidx.length; t += 3) {
      const a = pidx[t], b = pidx[t+1], c = pidx[t+2]
      const e1x=pp[b*3]-pp[a*3], e1y=pp[b*3+1]-pp[a*3+1]
      const e2x=pp[c*3]-pp[a*3], e2y=pp[c*3+1]-pp[a*3+1]
      const nz = e1x*e2y - e1y*e2x
      if (nz < 0) pNeg++; else pPos++
    }
    console.log(`probe disc: triangles=${pidx.length/3} 反转绕序后 法线-z=${pNeg} 法线+z=${pPos}`)
    // 测试不平移、不 merge，直接对该 disc 做 creaseNormals 看是否翻转
    let probeCrease
    try {
      probeCrease = creaseNormals(probe.toNonIndexed(), 45, 1e-4)
      const pi = probeCrease.index.array
      const pp2 = probeCrease.attributes.position.array
      let z2 = 0, o2 = 0
      for (let t = 0; t < pi.length; t += 3) {
        const a=pi[t], b=pi[t+1], c=pi[t+2]
        const e1x=pp2[b*3]-pp2[a*3], e1y=pp2[b*3+1]-pp2[a*3+1]
        const e2x=pp2[c*3]-pp2[a*3], e2y=pp2[c*3+1]-pp2[a*3+1]
        if (e1x*e2y-e1y*e2x < 0) z2++; else o2++
      }
      console.log(`probe disc crease后  法线-z=${z2} 法线+z=${o2}`)
    } catch (e) { console.log('crease import fail', e.message) }
  })
})