/**
 * gasExpansionModel 单元测试
 *
 * 覆盖：
 * - jwlPressure：JWL 状态方程（V=1、小 V、三种炸药）
 * - computeGasThrustAccel：时间窗口、装药边界、径向方向、压力钳制
 * - Task 5：constants 导入（JWL_PARAMS / GAS_EFFECTIVE_TIME 来自 blastConstants.js）
 */
import { describe, it, expect } from 'vitest'
import {
  jwlPressure,
  computeGasThrustAccel,
  computeChargeVolume,
  default as gasDefault
} from '../gasExpansionModel.js'
import {
  JWL_PARAMS,
  GAS_EFFECTIVE_TIME,
  P_MAX_CLAMP
} from '../blastConstants.js'

// ─── jwlPressure：JWL 状态方程 ─────────────────────────────────────────────
describe('jwlPressure: JWL 状态方程', () => {
  it('V=1 返回 GPa 级正压力（emulsion ≈ 7.68e9 Pa）', () => {
    const P = jwlPressure(1, 'emulsion')
    expect(P).toBeGreaterThan(0)
    expect(Number.isFinite(P)).toBe(true)
    // GPa 量级（1e9 ~ 1e10）
    expect(P).toBeGreaterThan(1e9)
    expect(P).toBeLessThan(1e10)
    // 精确值验证
    expect(P).toBeCloseTo(7.68e9, -8)
  })

  it('V 减小 → 压力增大（压缩使压力上升）', () => {
    const P1 = jwlPressure(1, 'emulsion')
    const P01 = jwlPressure(0.1, 'emulsion')
    const P001 = jwlPressure(0.01, 'emulsion')
    expect(P01).toBeGreaterThan(P1)
    expect(P001).toBeGreaterThan(P01)
  })

  it('V→0.001 返回远超 P_MAX_CLAMP 的高压（jwlPressure 本身不钳制）', () => {
    // 钳制发生在 computeGasThrustAccel，jwlPressure 返回原始高压
    const P = jwlPressure(0.001, 'emulsion')
    expect(P).toBeGreaterThan(P_MAX_CLAMP)
    expect(Number.isFinite(P)).toBe(true)
  })

  it('三种炸药返回不同压力值', () => {
    const Pe = jwlPressure(1, 'emulsion')
    const Pa = jwlPressure(1, 'anfo')
    const Pd = jwlPressure(1, 'dynamite')
    expect(Pe).not.toBeCloseTo(Pa, -8)
    expect(Pe).not.toBeCloseTo(Pd, -8)
    expect(Pa).not.toBeCloseTo(Pd, -8)
  })

  it('未知炸药类型回退到 emulsion', () => {
    const P = jwlPressure(1, 'unknown_type')
    const Pe = jwlPressure(1, 'emulsion')
    expect(P).toBe(Pe)
  })

  it('V≤0 时被钳制为 0.01 防止除零/指数发散', () => {
    const P = jwlPressure(0, 'emulsion')
    expect(Number.isFinite(P)).toBe(true)
    expect(P).toBeGreaterThan(0)
  })
})

// ─── computeGasThrustAccel：爆生气推力加速度 ───────────────────────────────
describe('computeGasThrustAccel: 爆生气推力', () => {
  const baseParams = {
    posX: 1, posY: 0, posZ: 0,
    blastCX: 0, blastCY: 0, blastCZ: 0,
    physSize: 0.3, mass: 19.0,
    simTime: 0.01, chargeVolume: 0.01,
    explosiveType: 'emulsion',
    throwDir: [0, 0, 1],
    chargeLength: 3.0
  }

  it('simTime > GAS_EFFECTIVE_TIME → 推力为 0', () => {
    const r = computeGasThrustAccel({ ...baseParams, simTime: 0.2 })
    expect(r.ax).toBe(0)
    expect(r.ay).toBe(0)
    expect(r.az).toBe(0)
  })

  it('simTime < 0 → 推力为 0', () => {
    const r = computeGasThrustAccel({ ...baseParams, simTime: -0.1 })
    expect(r.ax).toBe(0)
    expect(r.ay).toBe(0)
    expect(r.az).toBe(0)
  })

  it('正常场景：推力沿径向（背离爆心）', () => {
    // 碎片在 +X 方向，爆心在原点 → 推力 ax > 0
    const r = computeGasThrustAccel(baseParams)
    expect(r.ax).toBeGreaterThan(0)
    expect(Number.isFinite(r.ax)).toBe(true)
  })

  it('碎片位于爆心时使用抛掷方向', () => {
    // posX=blastCX → dist=0 → 方向取 throwDir=[0,0,1] → az 为主分量
    const r = computeGasThrustAccel({ ...baseParams, posX: 0, posY: 0, posZ: 0 })
    expect(Number.isFinite(r.az)).toBe(true)
    // throwDir 为 Z+，az 应为非零主分量
    expect(Math.abs(r.az)).toBeGreaterThanOrEqual(Math.abs(r.ax))
  })

  it('chargeVolume=0 → 推力近似为 0（相对体积极大）', () => {
    const r = computeGasThrustAccel({ ...baseParams, chargeVolume: 0 })
    // chargeVolume 被 max(1e-9,0)=1e-9 钳制，relativeVolume 极大 → P→0
    const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2)
    expect(mag).toBeLessThan(1e-3)
  })

  it('爆心处高压被钳制为 P_MAX_CLAMP（隐含 P_eff ≤ P_MAX_CLAMP）', () => {
    // 碎片位于爆心、simTime=0 → effDist≈0 → relativeVolume→0 → JWL 高压
    // computeGasThrustAccel 通过 Math.min(P, P_MAX_CLAMP) 钳制
    const r = computeGasThrustAccel({
      ...baseParams,
      posX: 0, posY: 0, posZ: 0,
      simTime: 0,
      chargeVolume: 0.001
    })
    expect(Number.isFinite(r.ax)).toBe(true)
    expect(Number.isFinite(r.ay)).toBe(true)
    expect(Number.isFinite(r.az)).toBe(true)
    // 反推有效压力 P_eff = |accel|·mass / crossSection，应 ≤ P_MAX_CLAMP·eta
    const crossSection = Math.PI * (0.3 / 2) ** 2
    const mag = Math.sqrt(r.ax ** 2 + r.ay ** 2 + r.az ** 2)
    const impliedPeff = (mag * 19.0) / crossSection
    // simTime=0, dist=0 → eta=1，钳制后 P_eff ≤ P_MAX_CLAMP
    expect(impliedPeff).toBeLessThanOrEqual(P_MAX_CLAMP * (1 + 1e-6))
  })

  it('质量越大 → 加速度越小（a=F/m）', () => {
    const light = computeGasThrustAccel({ ...baseParams, mass: 10 })
    const heavy = computeGasThrustAccel({ ...baseParams, mass: 1000 })
    const magLight = Math.sqrt(light.ax ** 2 + light.ay ** 2 + light.az ** 2)
    const magHeavy = Math.sqrt(heavy.ax ** 2 + heavy.ay ** 2 + heavy.az ** 2)
    expect(magHeavy).toBeLessThan(magLight)
  })
})

// ─── computeChargeVolume ───────────────────────────────────────────────────
describe('computeChargeVolume: 装药体积计算', () => {
  it('chargeKg / rho 返回装药体积', () => {
    // emulsion rho=1200 → 120kg / 1200 = 0.1 m³
    const v = computeChargeVolume(120, 'emulsion')
    expect(v).toBeCloseTo(0.1, 6)
  })

  it('不同炸药密度不同 → 体积不同', () => {
    const ve = computeChargeVolume(100, 'emulsion')   // rho=1200
    const va = computeChargeVolume(100, 'anfo')       // rho=850
    const vd = computeChargeVolume(100, 'dynamite')   // rho=1400
    expect(va).toBeGreaterThan(ve)
    expect(ve).toBeGreaterThan(vd)
  })
})

// ─── Task 5：constants 导入验证 ─────────────────────────────────────────────
describe('Task 5: constants 导入（JWL_PARAMS / GAS_EFFECTIVE_TIME / P_MAX_CLAMP）', () => {
  it('JWL_PARAMS 来自 blastConstants.js（同一对象引用）', () => {
    // gasExpansionModel 默认导出中包含 JWL_PARAMS，应为 blastConstants 导出的同一引用
    expect(gasDefault.JWL_PARAMS).toBe(JWL_PARAMS)
  })

  it('JWL_PARAMS 含三种炸药参数', () => {
    expect(JWL_PARAMS).toHaveProperty('emulsion')
    expect(JWL_PARAMS).toHaveProperty('anfo')
    expect(JWL_PARAMS).toHaveProperty('dynamite')
    for (const key of ['emulsion', 'anfo', 'dynamite']) {
      const p = JWL_PARAMS[key]
      expect(p).toHaveProperty('A')
      expect(p).toHaveProperty('B')
      expect(p).toHaveProperty('R1')
      expect(p).toHaveProperty('R2')
      expect(p).toHaveProperty('w')
      expect(p).toHaveProperty('E0')
    }
  })

  it('GAS_EFFECTIVE_TIME = 0.1s（100ms）', () => {
    expect(GAS_EFFECTIVE_TIME).toBe(0.1)
  })

  it('P_MAX_CLAMP = 5.0e9 Pa（5 GPa）', () => {
    expect(P_MAX_CLAMP).toBe(5.0e9)
  })

  it('gasExpansionModel 使用 constants 而非内联（jwlPressure 基于 JWL_PARAMS）', () => {
    // 验证 jwlPressure 结果与基于 JWL_PARAMS 的手算一致
    const p = JWL_PARAMS.emulsion
    const V = 1
    const Vc = Math.max(0.01, V)
    const expected =
      p.A * (1 - p.w / (p.R1 * Vc)) * Math.exp(-p.R1 * Vc) +
      p.B * (1 - p.w / (p.R2 * Vc)) * Math.exp(-p.R2 * Vc) +
      p.w * p.E0 / Vc
    expect(jwlPressure(V, 'emulsion')).toBeCloseTo(expected, 0)
  })
})
