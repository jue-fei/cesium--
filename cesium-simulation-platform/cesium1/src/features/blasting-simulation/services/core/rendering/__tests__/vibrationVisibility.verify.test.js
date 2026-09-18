/**
 * 振动场体积渲染可见性验证测试
 *
 * 已由「临时验证」转正为行为测试（长期保留）：直接构造模拟器/渲染器/
 * SceneBuilder 实例，断言应力/损伤场体积渲染链路与岩体场着色联动
 * （`setRockSemiTransparent` → `uFieldWeight` 切换）及状态守卫行为正确。
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { BlastVibrationFieldRenderer } from '../blastVibrationFieldRenderer.js'
import { LocalVibrationSimulator } from '../../computation/localVibrationSimulator.js'
import { SceneBuilder, FIELD_FADE_MS } from '../sceneBuilder.js'

describe('振动场体积渲染可见性验证', () => {
  it('本地模拟器生成的应力/损伤场超过可见阈值', () => {
    const sim = new LocalVibrationSimulator({
      chargeKg: 100,
      tunnelWidth: 18,
      tunnelHeight: 15,
      nx: 32,
      ny: 32,
      nz: 64
    })
    // 起爆后 t=0.5s，波前已扩散（visualCp=35，z=40 处到达约 1.14s）
    const { ppv, sigmaVm, zones } = sim.computeAtTime(1.2)
    const n = ppv.length
    expect(n).toBe(32 * 32 * 64)

    // 统计非零样本
    let ppvVisible = 0
    let stressVisible = 0
    let damageVisible = 0
    let maxPpv = 0
    let maxStress = 0
    for (let i = 0; i < n; i++) {
      if (ppv[i] > 0.003) ppvVisible++
      if (sigmaVm[i] > 1e5) stressVisible++
      if (zones[i] >= 1) damageVisible++
      if (ppv[i] > maxPpv) maxPpv = ppv[i]
      if (sigmaVm[i] > maxStress) maxStress = sigmaVm[i]
    }
    console.log('[verify] maxPpv(m/s)=', maxPpv, 'maxStress(Pa)=', maxStress)
    console.log(
      '[verify] ppvVisible=',
      ppvVisible,
      'stressVisible=',
      stressVisible,
      'damageVisible=',
      damageVisible
    )
    expect(ppvVisible).toBeGreaterThan(1000)
    expect(stressVisible).toBeGreaterThan(1000)
    expect(damageVisible).toBeGreaterThan(1000)
  })

  it('损伤持久性：动画后期损伤区不消退，回拉进度条时序确定（峰值×到达门控）', () => {
    const sim = new LocalVibrationSimulator({
      chargeKg: 100,
      tunnelWidth: 18,
      tunnelHeight: 15,
      nx: 32,
      ny: 32,
      nz: 64
    })
    // 起爆后早期（波前已扩散到大部分网格）
    const { ppv: ppv1, zones: z1 } = sim.computeAtTime(1.2)
    const nz1 = Array.from(z1).reduce((s, z) => s + (z >= 1 ? 1 : 0), 0)
    const maxPpv1 = Math.max(...Array.from(ppv1))
    // 动画后期（波峰回落，瞬时速度显著衰减）
    const { ppv: ppv2, zones: z2 } = sim.computeAtTime(3.0)
    const nz2 = Array.from(z2).reduce((s, z) => s + (z >= 1 ? 1 : 0), 0)
    const maxPpv2 = Math.max(...Array.from(ppv2))
    // 损伤按"波峰几何峰值×到达门控"：后期 ≥ 早期（不随波峰消失）
    expect(nz2).toBeGreaterThanOrEqual(nz1)
    // 实时速度（PPV 展示通道）后期应明显回落
    expect(maxPpv2).toBeLessThan(maxPpv1 * 0.8)
    // 回拉确定性：重新计算同一时刻（t=1.2）分区应与首次完全一致（不允许累积残留）
    const { zones: z1b } = sim.computeAtTime(1.2)
    expect(Array.from(z1b)).toEqual(Array.from(z1))
    // 循环回卷后，未到达处重新为 0（损伤分区为确定性算法，无需显式重置）
    const { zones: z3 } = sim.computeAtTime(0.15)
    const nz3 = Array.from(z3).reduce((s, z) => s + (z >= 1 ? 1 : 0), 0)
    expect(nz3).toBeLessThan(nz2)
  })

  it('渲染器初始化后持有三场 Data3DTexture 且坐标对齐正确', () => {
    const scene = new THREE.Scene()
    const renderer = new BlastVibrationFieldRenderer(scene)
    const center = new THREE.Vector3(0, 0, 0)
    const right = new THREE.Vector3(1, 0, 0)
    const up = new THREE.Vector3(0, 1, 0)
    const forward = new THREE.Vector3(0, 0, 1)
    renderer.init({
      gridShape: [32, 32, 64],
      boundsMin: [-9, -7.5, 0],
      boundsMax: [9, 7.5, 40],
      center,
      right,
      up,
      forward
    })
    expect(renderer._ppvTexture).toBeTruthy()
    expect(renderer._stressTexture).toBeTruthy()
    expect(renderer._damageTexture).toBeTruthy()
    expect(renderer._voxelCount).toBe(32 * 32 * 64)
    // 场数据坐标与网格对齐：中心为爆心，尺寸 = 物理网格范围
    const data = renderer.getFieldData()
    expect(data.gridShape).toEqual([32, 32, 64])
    expect(data.boundsMin).toEqual([-9, -7.5, 0])
    expect(data.boundsMax).toEqual([9, 7.5, 40])
    expect(data.center).toBe(center)
    expect(data.forward).toBe(forward)
    // 更新三场数据后 hasAnyField = true
    const sim = new LocalVibrationSimulator({
      chargeKg: 100,
      tunnelWidth: 18,
      tunnelHeight: 15,
      nx: 32,
      ny: 32,
      nz: 64
    })
    const { ppv, sigmaVm, zones } = sim.computeAtTime(1.2)
    renderer.updateField(ppv, 1.2, 1)
    renderer.updateStressField(sigmaVm, 1.2, 1)
    renderer.updateDamageField(zones, 1.2, 1)
    expect(renderer.hasAnyField).toBe(true)
    expect(renderer.hasField).toBe(true)
  })

  it('SceneBuilder.setRockSemiTransparent 切换场着色权重：墙钟缓动淡入 + 状态守卫', () => {
    const scene = new THREE.Scene()
    const builder = new SceneBuilder(scene, {
      center: new THREE.Vector3(0, 0, 0),
      faceDirection: new THREE.Vector3(0, 0, 1),
      layerVisibility: {},
      tunnelWidth: 18,
      tunnelWallHeight: 6,
      tunnelArchRadius: 4.5,
      tunnelHeight: 15,
      benchLength: 80,
      tunnelSection: { width: 18, wallHeight: 6, archRadius: 4.5, shape: 'horseshoe' }
    })
    // 手动挂载 field 材质（场权重作用于 _benchFieldMaterial/_faceFieldMaterial）
    const mk = () => new THREE.ShaderMaterial({ uniforms: { uFieldWeight: { value: 0 } } })
    builder._benchFieldMaterial = mk()
    builder._faceFieldMaterial = mk()
    const fieldMats = [builder._benchFieldMaterial, builder._faceFieldMaterial]
    const weights = () => fieldMats.map(m => m.uniforms.uFieldWeight.value)

    // 初始：无场着色
    expect(builder._rockSemiTransparent).toBe(false)
    expect(weights()).toEqual([0, 0])

    // 打开 → 启动淡入；第一帧仍在起点，不是硬切
    const t0 = performance.now()
    let nowSpy = vi.spyOn(performance, 'now').mockReturnValue(t0)
    builder.setRockSemiTransparent(true)
    expect(builder._rockSemiTransparent).toBe(true)
    builder.updateFieldFade()
    expect(weights()).toEqual([0, 0])

    // 过渡中途：权重严格介于两端之间（连续，无跳变）
    nowSpy.mockReturnValue(t0 + FIELD_FADE_MS / 2)
    builder.updateFieldFade()
    const [mid, midFace] = weights()
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(0.62)
    expect(midFace).toBe(mid)

    // 时长到 → 收敛到目标权重
    nowSpy.mockReturnValue(t0 + FIELD_FADE_MS * 2)
    builder.updateFieldFade()
    expect(weights()).toEqual([0.62, 0.62])

    // 状态守卫 + 过渡结束：重复调用不再改动权重
    nowSpy.mockReturnValue(t0 + FIELD_FADE_MS * 3)
    builder.setRockSemiTransparent(true)
    builder.updateFieldFade()
    expect(weights()).toEqual([0.62, 0.62])

    // 关闭 → 同样走淡出并收敛到 0
    nowSpy.mockReturnValue(t0 + FIELD_FADE_MS * 3.1)
    builder.setRockSemiTransparent(false)
    expect(builder._rockSemiTransparent).toBe(false)
    nowSpy.mockReturnValue(t0 + FIELD_FADE_MS * 5)
    builder.updateFieldFade()
    expect(weights()).toEqual([0, 0])
    nowSpy.mockRestore()
  })
})
