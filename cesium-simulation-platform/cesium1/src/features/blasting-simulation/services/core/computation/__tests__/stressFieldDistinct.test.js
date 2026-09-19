import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  LocalVibrationSimulator,
  computeStressFieldFromPpv,
  computeMultiSourcePeakField3d,
  nearFieldRadius,
  nearFieldGain,
  cavityRadius,
  NEAR_FIELD_GAIN
} from '../localVibrationSimulator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = p => readFileSync(resolve(__dirname, p), 'utf8')

/**
 * 回归："震速的图和应力的图一模一样"。
 *
 * 旧实现：后端/前端都把 σ_vm 取作 ρ·c_p·v/(1−ν)（v 为瞬时振速），而前端又令
 * σ_ref = PPV_ref × 同一系数 → 归一化后两场逐点相等，配色只差一张 Viridis 表。
 *
 * 修复（三层一致）：
 *   1) 输入改用**峰值包络场**（computeMultiSourcePeakField3d，不可逆判据场）；
 *   2) 叠加近场几何修正 F(r) = 1 + A·(r_nf/r)²（空腔准静态项一阶等效）；
 *   3) shader 应力支改用 peak × arrived × F(r)，σ_ref 独立标定（含 F(rRef)）。
 */

function makeSim() {
  return new LocalVibrationSimulator({
    chargeKg: 83.8,
    K: 90,
    alpha: 1.58,
    tunnelWidth: 18,
    tunnelHeight: 15,
    lengthZ: 25,
    nx: 10,
    ny: 10,
    nz: 12,
    origin: [0, 0, 0],
    sources: [
      { x: -0.6, y: 0.4, z: 0.2, chargeKg: 30, delayMs: 0 },
      { x: 0.6, y: 0.4, z: 0.2, chargeKg: 30, delayMs: 50 },
      { x: 0, y: -0.5, z: 0.6, chargeKg: 23.8, delayMs: 120 }
    ],
    visualCp: 35,
    influenceRadius: 30
  })
}

describe('应力场与振速场空间结构不同（两图一模一样回归）', () => {
  const sim = makeSim()
  const { ppv, sigmaVm } = sim.computeAtTime(1.2)
  const n = sigmaVm.length

  it('应力 = ρ·c_p·瞬时振速/(1−μ_d)·F(r)，逐点可复算（波前可见，动态泊松比 μ_d=0.8ν）', () => {
    // 动态泊松比（梁瑞 2020 长江科学院院报 37(4):67-72，μ_d=0.8μ）：
    // σ_vm = ρ·c_p·v/(1−μ_d)·F(r)，与后端 stress_field_from_ppv(dynamic_poisson=True) 同口径
    const nuDyn = 0.8 * sim.params.nu
    const vmFactor = sim.params.rho * sim.params.cp * (1 / (1 - nuDyn))
    let checked = 0
    for (let i = 0; i < n; i++) {
      if (ppv[i] > 0.01) {
        const expectVal =
          vmFactor *
          ppv[i] *
          nearFieldGain(sim._gridR[i], sim.params.nearFieldRadius, sim.params.nearFieldGain)
        // σ_vm 量级 ~1e7 Pa，Float32 只有 ~7 位有效数字 → 用相对误差判定
        expect(Math.abs(sigmaVm[i] - expectVal) / expectVal).toBeLessThan(1e-5)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(20)
    // 近场项必须真实生效（否则又是常数比 → 两图一模一样）
    expect(sim.params.nearFieldRadius).toBeGreaterThan(0)
  })

  it('近场项只在中近场起作用（温和幅值，中心不再深饱和）', () => {
    // F(r) 在 standoff≈0.5m 处 ≈3，但在 4m 外应收敛到 ≈1
    const rnf = sim.params.nearFieldRadius
    const fNear = nearFieldGain(0.5, rnf, sim.params.nearFieldGain)
    const fFar = nearFieldGain(4.0, rnf, sim.params.nearFieldGain)
    expect(fNear).toBeGreaterThan(1.5)
    expect(fNear).toBeLessThan(6) // 幅值温和：不再出现 F=19 的深饱和放大
    expect(fFar).toBeLessThan(1.1)
  })

  it('应力与振速的比值随 r 变化（近场项带来空间结构差异）', () => {
    let mn = Infinity
    let mx = -Infinity
    let count = 0
    for (let i = 0; i < n; i++) {
      if (ppv[i] > 0.05) {
        const ratio = sigmaVm[i] / ppv[i]
        mn = Math.min(mn, ratio)
        mx = Math.max(mx, ratio)
        count++
      }
    }
    expect(count).toBeGreaterThan(20)
    // 比值 = ρ·c_p/(1−ν)·F(r)，F 随 r 衰减 → 比值非常数即证明两场结构不同
    expect(mx / mn).toBeGreaterThan(1.15)
  })

  it('缺省（不传 distance / r_nf=0）保持纯辐射口径 σ = ρ·c_p·v/(1−μ_d)（μ_d=0.8ν）', () => {
    const v = new Float32Array([1.0, 0.5, 0.2])
    const out = computeStressFieldFromPpv(v, { rho: 2650, cp: 4500, nu: 0.25 })
    // 默认 dynamicPoisson=true（梁瑞 2020）：侧应力系数按 μ_d=0.8·0.25=0.2 → 除以 0.8
    const expectVal = (2650 * 4500) / 0.8
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(out[i] - expectVal * v[i]) / (expectVal * v[i])).toBeLessThan(1e-6)
    }
    // 显式关闭动态泊松比 → 静态口径（向后兼容开关）
    const outStatic = computeStressFieldFromPpv(v, {
      rho: 2650,
      cp: 4500,
      nu: 0.25,
      dynamicPoisson: false
    })
    const expectStatic = (2650 * 4500) / 0.75
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(outStatic[i] - expectStatic * v[i]) / (expectStatic * v[i])).toBeLessThan(
        1e-6
      )
    }
  })
})

describe('近场几何修正参数', () => {
  it('r_nf 由装药量反算并钳制，F(r) 单调衰减到 1', () => {
    const rb = cavityRadius(83.8)
    expect(rb).toBeGreaterThan(0.2)
    expect(rb).toBeLessThan(0.4)
    // r_nf = MULT × r_b，MULT=2 → 近场项只作用于 1~2m 内（温和幅值）
    const rnf = nearFieldRadius(83.8)
    expect(rnf).toBeCloseTo(2 * rb, 6)
    // 大距离退化为 1（纯辐射项）
    expect(nearFieldGain(20, rnf)).toBeCloseTo(1, 2)
    // 近场放大但温和
    expect(nearFieldGain(rnf, rnf)).toBeCloseTo(1 + NEAR_FIELD_GAIN, 6)
    // 非法输入安全退化
    expect(nearFieldGain(0, 0)).toBe(1)
    expect(nearFieldRadius(0)).toBe(0)
  })
})

describe('shader 应力支与 CPU/后端同口径（源码守卫）', () => {
  // 源码守卫文本：sceneBuilder.js + 外移的着色器主体（benchField.*.glsl，
  // 由 sceneBuilder 以 ?raw 原文组装）——着色器断言须覆盖 GLSL 本体
  const src =
    read('../../rendering/sceneBuilder.js') +
    read('../../rendering/benchField.vert.glsl') +
    read('../../rendering/benchField.frag.glsl')

  it('应力支用瞬时场（波前可见）+ 近场项', () => {
    expect(src).toMatch(/float pa = max\(mps, 1e-6\) \* uStressFactor \* nff;/)
    expect(src).toContain('uStressNfR')
    expect(src).toContain('uStressNfA')
    // 峰值包络/到达门控不得再进入应力支（会变静态云图、丢失波前）
    expect(src).not.toMatch(/float paAnalytic = max\(peak/)
    expect(src).not.toMatch(/uStressFactor \* arrived/)
  })

  it('岩面着色只用解析场：不得再引入网格盒纹理采样/双源混合', () => {
    // 网格盒（19.5m×25m）远小于岩体模型，盒内外两套色源在盒面无法逐点对齐，
    // 交叉淡化的过渡带会在岩面正中央显形为矩形接缝（用户实测"中间矩形异形"）。
    expect(src).not.toMatch(/sampleFieldTex\(/)
    expect(src).not.toMatch(/sampleZoneTex\(/)
    expect(src).not.toMatch(/boxBlend\(/)
    expect(src).not.toMatch(/uFieldTexOn/)
  })

  it('洞身遮挡已禁用（X 形/斜向黑影伪影根源）', () => {
    expect(src).toMatch(/float occ = 1\.0;/)
    expect(src).not.toMatch(/float occ = holeOcclusion\(relSrc\);/)
  })

  it('应力满量程锚定场最大值（收紧满量程，中心不深饱和）', () => {
    // 满量程解析逻辑（_computeAutoFieldRefs）已迁至 blasting/vibrationFieldDomain.js
    const mgr =
      read('../../../blastingManager.js') + read('../../../blasting/vibrationFieldDomain.js')
    expect(mgr).toContain('stressRefMPa: (stressFactor * vNear * nfC) / 1.0e6')
    expect(mgr).not.toContain('stressRefMPa: (ppvRefMps * stressFactor')
  })
})
