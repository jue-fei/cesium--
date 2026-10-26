/**
 * 点选拾取采样测试：验证 BlastVibrationFieldRenderer.sampleAtWorldPoint /
 * samplePpvAt 在世界坐标处正确采样 PPV/应力场（三线性插值）与损伤场（最近邻离散档），
 * 场外返回 inside:false、缺场返回 null——不破坏既有渲染链路。
 *
 * 新增逻辑（纯增量查询，不改动渲染路径）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { BlastVibrationFieldRenderer } from '../blastVibrationFieldRenderer.js'
import { LocalVibrationSimulator } from '../../computation/localVibrationSimulator.js'

function makeRenderer() {
  const scene = new THREE.Scene()
  const renderer = new BlastVibrationFieldRenderer(scene)
  renderer.init({
    gridShape: [32, 32, 64],
    boundsMin: [-9, -7.5, 0],
    boundsMax: [9, 7.5, 40],
    center: new THREE.Vector3(0, 0, 0),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    forward: new THREE.Vector3(0, 0, 1)
  })
  const sim = new LocalVibrationSimulator({
    chargeKg: 100,
    tunnelWidth: 18,
    tunnelHeight: 15,
    nx: 32,
    ny: 32,
    nz: 64
  })
  // 用文献矿区参数（K=165.9, α=1.418）驱动全场
  sim.params.K = 165.9
  sim.params.alpha = 1.418
  sim.params.visualBeta = 0 // 关闭时变回落，使 PPV 恒等于峰值，便于理论对照
  sim.params.visualCp = 4500 // 高可视波速：t=0.05s 波前即刻覆盖全场（radius≈225m≫41m），全场均取峰值
  const { ppv, sigmaVm, zones } = sim.computeAtTime(0.05)
  renderer.updateField(ppv, 0.05, 1)
  renderer.updateStressField(sigmaVm, 0.05, 1)
  renderer.updateDamageField(zones, 0.05, 1)
  return renderer
}

// 相对爆心距离 r = |(x,y,z)| 处的萨道夫斯基 PPV(cm/s)
function sadovCmps(x, y, z, Q = 100, K = 165.9, alpha = 1.418, minStandoff = 0.5) {
  const r = Math.max(Math.hypot(x, y, z), minStandoff)
  return K * Math.pow(Q ** (1 / 3) / r, alpha)
}

describe('DAMAGE 分类纹理坐标与着色输入契约', () => {
  it('endpoint 节点按 texel 中心映射，且采样保持整数 zone', () => {
    const renderer = new BlastVibrationFieldRenderer(new THREE.Scene())
    renderer.init({
      gridShape: [2, 2, 2],
      boundsMin: [0, 0, 0],
      boundsMax: [1, 1, 1],
      gridSampleMode: 'nodes',
      center: new THREE.Vector3(),
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      forward: new THREE.Vector3(0, 0, 1)
    })
    renderer.updateField(new Float32Array(8), 0, 1)
    renderer.updateDamageField(new Int8Array([0, 4, 2, 1, 3, 2, 1, 4]), 0, 1, 'nodes')

    expect(renderer._damageTexture.minFilter).toBe(THREE.NearestFilter)
    expect(renderer.sampleAtWorldPoint([0.51, 0.01, 0.01]).zone).toBe(4)
    expect(renderer.sampleAtWorldPoint([1, 1, 1]).zone).toBe(4)
    expect(renderer.sampleAtWorldPoint([2, 1, 1]).inside).toBe(false)
  })

  it('shader 损伤分支直接采样 DAMAGE texture，不再依解析峰值重算', () => {
    const shader = readFileSync(new URL('../benchField.frag.glsl', import.meta.url), 'utf8')
    expect(shader).toContain('texture(uDamageTexture, damageTextureCoordinates(g))')
    expect(shader).toContain('uDamageReady > 0.5 && insideDamageBounds')
    expect(shader).toContain('alpha = zone < 0.5 ? 0.0 : 1.0')
    expect(shader).toContain('uniform float uGridSampleMode')
  })
})

describe('振动场点选拾取采样 sampleAtWorldPoint', () => {
  it('命中场中心且 PPV 与萨道夫斯基理论一致、三场同取', () => {
    const r = makeRenderer()
    const p = [2.0, 1.0, 5.0] // 世界坐标（爆心0,0,0，右/上/前方 1,0,0 /0,1,0 /0,0,1）
    const s = r.sampleAtWorldPoint(p)
    expect(s).not.toBeNull()
    expect(s.inside).toBe(true)
    expect(s.ppvCmps).toBeGreaterThan(0)
    // 理论值与采样值在阈值容差内一致（体素离散 → 宽容差）
    const theory = sadovCmps(2, 1, 5)
    expect(Math.abs(s.ppvCmps - theory) / theory).toBeLessThan(0.25)
    // 应力/损伤同步给出
    expect(s.stressMPa).not.toBeNull()
    expect(s.zone).not.toBeNull()
    expect(Number.isFinite(s.zone)).toBe(true)
  })

  it('距离越远 PPV 越小（空间分布正确，非单值）', () => {
    const r = makeRenderer()
    const near = r.sampleAtWorldPoint([1, 0, 1]).ppvCmps
    const mid = r.sampleAtWorldPoint([3, 0, 8]).ppvCmps
    const far = r.sampleAtWorldPoint([6, 5, 20]).ppvCmps
    expect(near).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(far)
  })

  it('场外返回 inside:false、缺场/未初始化返回 null', () => {
    const r = makeRenderer()
    const out = r.sampleAtWorldPoint([500, 500, 500])
    expect(out).not.toBeNull()
    expect(out.inside).toBe(false)
    expect(out.metric).toBe(0)
    expect(out.zone).toBeNull()
    // 未初始化实例（无场）→ null
    const fresh = new BlastVibrationFieldRenderer(new THREE.Scene())
    expect(fresh.sampleAtWorldPoint([0, 0, 0])).toBeNull()
    expect(fresh.samplePpvAt([0, 0, 0])).toBeNull()
  })

  it('samplePpvAt 便捷封装：场外返回 null，场内返回 cm/s', () => {
    const r = makeRenderer()
    expect(r.samplePpvAt([2, 1, 5])).toBeGreaterThan(0)
    expect(r.samplePpvAt([500, 500, 500])).toBeNull()
  })

  it('相对爆心对称点 PPV 一致（球面场各向同性）', () => {
    const r = makeRenderer()
    const a = r.sampleAtWorldPoint([3, 2, 4])
    const b = r.sampleAtWorldPoint([-3, 2, 4]) // 左右对称等距，均在 z∈[0,40] 场内
    expect(a.inside).toBe(true)
    expect(b.inside).toBe(true)
    expect(Math.abs(a.ppvCmps - b.ppvCmps)).toBeLessThan(1e-3)
  })
})
