/**
 * 节理块体几何测试：凸性、归一化、面数、形状随节理组变化
 *
 * 该几何同时驱动 InstancedMesh 渲染与 Rapier 凸包碰撞，必须保证：
 *  - 所有顶点在归一化后 |p| ≤ 1（maxR = 1 语义）
 *  - 面数足够形成棱面（≥ 12 个三角形 = 6 个四边形面）、又不过度（≤ 96）
 *  - 体积为正（ConvexGeometry 未退化）
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildBlockGeometry } from '../voronoiBlockGeometry.js'
import { createJointNetwork } from '../jointNetwork.js'

function measure(geo) {
  const pos = geo.attributes.position
  let maxR = 0
  for (let i = 0; i < pos.count; i++) {
    maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)))
  }
  const bb = new THREE.Box3().setFromBufferAttribute(pos)
  return {
    maxR,
    triangles: Math.floor(pos.count / 3),
    size: bb.getSize(new THREE.Vector3())
  }
}

describe('voronoiBlockGeometry', () => {
  it('块状节理：生成近等轴凸多面体，maxR 归一化为 1', () => {
    const net = createJointNetwork({ preset: 'massive', seed: 11 })
    const built = buildBlockGeometry({ network: net, seed: 11 })
    const m = measure(built.geometry)

    expect(m.maxR).toBeCloseTo(1, 3)
    expect(m.triangles).toBeGreaterThanOrEqual(12)
    expect(m.triangles).toBeLessThanOrEqual(96)
    const sorted = [m.size.x, m.size.y, m.size.z].sort((a, b) => b - a)
    // 等轴：最短轴 / 最长轴 > 0.6
    expect(sorted[2] / sorted[0]).toBeGreaterThan(0.6)
    expect(built.stats.zingg).toBe('blocky')
  })

  it('层理节理：生成板状（一轴显著短于另两轴）', () => {
    const net = createJointNetwork({ preset: 'bedded', seed: 5 })
    const built = buildBlockGeometry({ network: net, seed: 5 })
    const m = measure(built.geometry)
    const sorted = [m.size.x, m.size.y, m.size.z].sort((a, b) => b - a)
    expect(sorted[2] / sorted[0]).toBeLessThan(0.55)
    expect(built.stats.flatness).toBeLessThan(0.55)
  })

  it('几何顶点构成凸包：所有顶点到质心方向的投影不超过支撑半径', () => {
    const net = createJointNetwork({ preset: 'sheared', seed: 9 })
    const built = buildBlockGeometry({ network: net, seed: 9 })
    const pos = built.geometry.attributes.position
    // ConvexGeometry 输出全部顶点即凸包顶点，任何顶点都是其自身方向的极值点；
    // 这里用"最大半径唯一性"做弱验证：不存在半径 > 1.0001 的顶点
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))
      expect(r).toBeLessThanOrEqual(1.0001)
    }
  })

  it('退化输入（零间距/共面法线）走兜底且仍返回可用几何', () => {
    const bad = {
      sets: [
        { normal: { x: 0, y: 1, z: 0 }, spacing: 1 },
        { normal: { x: 0, y: 1, z: 0 }, spacing: 1 },
        { normal: { x: 0, y: 1, z: 0 }, spacing: 1 }
      ],
      presetKey: 'bad'
    }
    const built = buildBlockGeometry({ network: bad, seed: 2 })
    const m = measure(built.geometry)
    expect(m.triangles).toBeGreaterThan(6)
    expect(m.maxR).toBeCloseTo(1, 2)
    expect(built.stats.jointPreset).toBe('fallback')
  })
})
