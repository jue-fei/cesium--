import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'

// createRockTexture() 依赖浏览器 canvas（document.createElement + 2D ctx），
// 测试环境无 document。此处注入最小 2D canvas/ctx 桩，仅用于几何校验（不实际渲染，
// THREE.CanvasTexture 只持有引用、测试中不会被上传到 GPU）。
function makeCtxStub() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textBaseline: 'alphabetic',
    font: '',
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text) {
      return { width: String(text || '').length * 12 }
    },
    fillText() {},
    scale() {},
    translate() {},
    rotate() {},
    setTransform() {},
    save() {},
    restore() {},
    clearRect() {}
  }
}
function makeCanvasStub() {
  return {
    width: 0,
    height: 0,
    getContext() {
      return makeCtxStub()
    }
  }
}
beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { createElement: () => makeCanvasStub() }
  }
})

function allFinite(geo) {
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  }
  return true
}

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

describe('岩体单一连续实心体（rockBody 合并重构）', () => {
  it('爆破前为整段连续实心，爆破后退到新掌子面，且断面一致、无 NaN', () => {
    const sb = buildBuilder()

    const pre = sb._rockGeoPre
    const post = sb._rockGeoPost
    expect(pre).toBeTruthy()
    expect(post).toBeTruthy()

    const roundDepth = sb._rockRoundDepth // 2.5
    const D = roundDepth + 40

    // 几何均为有限坐标
    expect(allFinite(pre)).toBe(true)
    expect(allFinite(post)).toBe(true)

    pre.computeBoundingBox()
    post.computeBoundingBox()
    const preMin = pre.boundingBox.min
    const postMin = post.boundingBox.min
    const preMax = pre.boundingBox.max
    const postMax = post.boundingBox.max

    // 爆破前几何覆盖 [0, D]（前端对齐掌子面 faceOffset 处局部 z=0）
    expect(preMin.z).toBeCloseTo(0, 5)
    expect(preMax.z).toBeCloseTo(D, 3)
    // 爆破后几何：待爆段核心开挖空腔贯通、四周围岩环保留 → 岩体后缘仍为原掌子面（z=0），
    // 实心段退到 [roundDepth, D]；整体覆盖 [0, D]（围岩环 + 新掌子面之后的连续实心）
    expect(postMin.z).toBeCloseTo(0, 5)
    expect(postMax.z).toBeCloseTo(D, 3)

    // 前后断面（x/y 范围）完全一致（均为围岩加厚后的外廓）
    // → 与空腔壁/漏斗/破损掌子面接触面严格共面
    expect(Math.abs(preMin.x - postMin.x)).toBeLessThan(1e-6)
    expect(Math.abs(preMax.x - postMax.x)).toBeLessThan(1e-6)
    expect(Math.abs(preMin.y - postMin.y)).toBeLessThan(1e-6)
    expect(Math.abs(preMax.y - postMax.y)).toBeLessThan(1e-6)
  })

  it('岩体世界坐标摆放正确：后缘贴合掌子面 faceOffset，不留轴向间隙', () => {
    const sb = buildBuilder()
    const faceOffset = 3
    const roundDepth = sb._rockRoundDepth // 2.5
    // 爆破前：岩体世界后缘 = faceOffset，与隧道壳/掌子面相接
    const boxPre = new THREE.Box3().setFromObject(sb.benchMesh)
    expect(boxPre.min.z).toBeCloseTo(faceOffset, 3)
    // 爆破后：围岩环保留至原掌子面 faceOffset（待爆循环段核心开挖、四周围岩不消失），
    // 实心段前缘（新掌子面）退到 faceOffset+roundDepth
    sb.applyBlastState(true)
    const boxPost = new THREE.Box3().setFromObject(sb.benchMesh)
    expect(boxPost.min.z).toBeCloseTo(faceOffset, 3)
    expect(boxPost.max.z).toBeCloseTo(faceOffset + roundDepth + sb.benchLength, 1)
    // 隧道壳（已开挖段）前端开口须落在 faceOffset，与岩体后缘共面 → 无间隙
    const boxShell = new THREE.Box3().setFromObject(sb.tunnelShellMesh)
    expect(boxShell.max.z).toBeCloseTo(faceOffset, 3)
  })

  it('爆破状态切换在预/后几何间互换，且始终为同一连续实心 mesh', () => {
    const sb = buildBuilder()
    const mesh = sb.benchMesh
    expect(mesh).toBeTruthy()
    expect(mesh.geometry).toBe(sb._rockGeoPre)

    sb.applyBlastState(true)
    expect(mesh.geometry).toBe(sb._rockGeoPost)

    sb.applyBlastState(false)
    expect(mesh.geometry).toBe(sb._rockGeoPre)
  })

  it('消除待爆段与后方岩体的缝合（不再存在 frontPlugMesh，仅单一 rockBody）', () => {
    const sb = buildBuilder()
    expect(sb.benchMesh).toBeTruthy()
    expect(sb.frontPlugMesh).toBeFalsy()
    // 空腔壁仍在（爆破后画面），后世界坐标与岩体前缘一致，用于衔接
    expect(sb.excavatedTubeMesh).toBeTruthy()
    expect(sb.excavatedTubeMesh.geometry).toBeTruthy()
  })
})
