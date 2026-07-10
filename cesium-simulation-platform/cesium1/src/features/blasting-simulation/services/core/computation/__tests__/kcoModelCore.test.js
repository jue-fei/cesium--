/**
 * kcoModelCore 单元测试
 *
 * 覆盖：
 * - Task 1：Cunningham 均匀性指数 n 公式（2 因子简化版）+ clamp [0.5, 2.5]
 * - x50：Kuznetsov-Cunningham 方程形式与典型值
 * - RWS 参数名（SANFO 不存在，RWS 生效）
 * - Swebrec 分布采样反演
 * - Task 5：constants 导入（KCO_OVERSIZE_THRESHOLD 来自 blastConstants.js）
 * - Task 11：swebrecCdf 与后端 kco_validator.py:_swebrec_cdf 公式对齐
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KCO_PARAMS,
  calculateKCOParams,
  swebrecCdf,
  sampleSwebrecSize
} from '../kcoModelCore.js'
import { KCO_OVERSIZE_THRESHOLD } from '../blastConstants.js'

// ─── Task 1：n 公式（2 因子简化版）──────────────────────────────────────────
describe('Task 1: Cunningham 均匀性指数 n 公式', () => {
  it('默认参数(Q=320,A=3.6,RWS=100,B=1.5,d=0.04,W_abs=0.2) → n≈0.7916', () => {
    // n = (2.2 - 14·d/B) × (1 - W_abs/B) / 2
    //   = (2.2 - 14·0.04/1.5) × (1 - 0.2/1.5) / 2
    //   = 1.82667 × 0.86667 / 2 ≈ 0.7916
    const r = calculateKCOParams()
    expect(r.n).toBeCloseTo(0.7916, 3)
  })

  it('n 公式手算验证（独立计算对比）', () => {
    const d = 0.04, B = 1.5, W_abs = 0.2
    const expected = (2.2 - 14 * d / B) * (1 - W_abs / B) / 2
    const r = calculateKCOParams()
    expect(r.n).toBeCloseTo(expected, 6)
  })

  it('n 被 clamp 至 [0.5, 2.5] 区间内', () => {
    const r = calculateKCOParams()
    expect(r.n).toBeGreaterThanOrEqual(0.5)
    expect(r.n).toBeLessThanOrEqual(2.5)
  })

  it('极端大孔径(d=10) → n 钳制为下界 0.5', () => {
    // 14·10/1.5 ≈ 93.3 → (2.2-93.3) 为大负数 → clamp 0.5
    const r = calculateKCOParams({ d: 10 })
    expect(r.n).toBe(0.5)
  })

  it('n 在多组合理输入下始终 ∈ [0.5, 2.5]', () => {
    const inputs = [
      { d: 0.038, B: 1.2, SD: 0.15 },
      { d: 0.05, B: 2.0, SD: 0.3 },
      { d: 0.04, B: 1.5, SD: 0.2 },
      { d: 0.045, B: 1.8, SD: 0.1 }
    ]
    for (const p of inputs) {
      const r = calculateKCOParams(p)
      expect(r.n).toBeGreaterThanOrEqual(0.5)
      expect(r.n).toBeLessThanOrEqual(2.5)
    }
  })

  it('n 公式不含旧版多余因子（与 d/B 简化版一致）', () => {
    // 旧实现含 Lc/Ltot、Lb/Ltot、H/B 因子，新版已删除；
    // 改变这些参数不应影响 n（仅 d/B 与 W_abs/B 影响 n）
    const base = calculateKCOParams({ Lc: 3.0, Ltot: 4.5, Lb: 1.5, H: 4.5 })
    const varied = calculateKCOParams({ Lc: 5.0, Ltot: 8.0, Lb: 3.0, H: 8.0 })
    expect(varied.n).toBeCloseTo(base.n, 6)
  })
})

// ─── x50：Kuznetsov-Cunningham 方程 ─────────────────────────────────────────
describe('x50: Kuznetsov-Cunningham 方程', () => {
  it('默认参数 → x50 ≈ 0.103m（独立公式验证）', () => {
    // x50 = 0.01·A·Q^(1/6)·(115/RWS)^(19/30)
    // A = 0.06·(RMD+RDI+HF) = 0.06·60 = 3.6
    const A = 0.06 * (20 + 15 + 25)
    const Q = 320
    const RWS = 100
    const expected = 0.01 * A * Math.pow(Q, 1 / 6) * Math.pow(115 / RWS, 19 / 30)
    const r = calculateKCOParams()
    expect(r.x50).toBeCloseTo(expected, 6)
    // 典型值数量级 ~0.1m
    expect(r.x50).toBeGreaterThan(0.05)
    expect(r.x50).toBeLessThan(0.2)
  })

  it('x50 为正数', () => {
    const r = calculateKCOParams()
    expect(r.x50).toBeGreaterThan(0)
  })

  it('A 因子 = 0.06·(RMD+RDI+HF)', () => {
    const r = calculateKCOParams()
    expect(r.A).toBeCloseTo(0.06 * (20 + 15 + 25), 6)
    expect(r.A).toBe(3.6)
  })
})

// ─── RWS 参数名（SANFO→RWS 修正）──────────────────────────────────────────
describe('RWS 参数名（Task 1: SANFO→RWS）', () => {
  it('DEFAULT_KCO_PARAMS 不含 SANFO 字段', () => {
    expect(DEFAULT_KCO_PARAMS).not.toHaveProperty('SANFO')
  })

  it('DEFAULT_KCO_PARAMS 含 RWS 字段', () => {
    expect(DEFAULT_KCO_PARAMS).toHaveProperty('RWS')
    expect(DEFAULT_KCO_PARAMS.RWS).toBe(100)
  })

  it('RWS=80 产生比 RWS=100 更大的 x50', () => {
    // (115/RWS) 项：RWS 越小 → (115/RWS) 越大 → x50 越大
    const r80 = calculateKCOParams({ RWS: 80 })
    const r100 = calculateKCOParams({ RWS: 100 })
    expect(r80.x50).toBeGreaterThan(r100.x50)
  })

  it('传入 SANFO 参数被忽略（回退默认 RWS=100）', () => {
    // SANFO 非有效字段，不应影响结果
    const r = calculateKCOParams({ SANFO: 80 })
    const rDefault = calculateKCOParams()
    expect(r.x50).toBeCloseTo(rDefault.x50, 6)
    expect(r.n).toBeCloseTo(rDefault.n, 6)
  })

  it('RWS 极小值仍被有效钳制（max(1, RWS)）', () => {
    const r = calculateKCOParams({ RWS: 1 })
    expect(r.x50).toBeGreaterThan(0)
    expect(Number.isFinite(r.x50)).toBe(true)
  })
})

// ─── Swebrec 分布采样 ──────────────────────────────────────────────────────
describe('Swebrec 分布采样（sampleSwebrecSize）', () => {
  const x50 = 0.103
  const xmax = 2.0
  const n = 1.0
  const b = 2.0

  it('u=0.5 → x ≈ x50（中位块度，P(x50)=0.5）', () => {
    // 指数形式 P(x50) = 1 - exp(-ln2·1/1) = 1 - 0.5 = 0.5，故反函数 u=0.5 → x=x50
    // 二分法收敛精度约 1e-12，使用 3 位精度足够
    const x = sampleSwebrecSize(x50, xmax, n, b, () => 0.5)
    expect(x).toBeCloseTo(x50, 3)
  })

  it('u→1 → x 增大且 P(x)≈u（反函数正确，指数形式尾部收敛较慢）', () => {
    const u = 0.9999
    const x = sampleSwebrecSize(x50, xmax, n, b, () => u)
    expect(x).toBeLessThanOrEqual(xmax)
    // u>0.5 → x>x50（cdf 单调递增）
    expect(x).toBeGreaterThan(x50)
    // 反函数法核心验证：采样点的 cdf 应等于输入 u
    expect(swebrecCdf(x, x50, xmax, n, b)).toBeCloseTo(u, 3)
  })

  it('u→0 → x 趋近下界 0.02（P(0)=0）', () => {
    const x = sampleSwebrecSize(x50, xmax, n, b, () => 0.001)
    expect(x).toBeCloseTo(0.02, 6)
  })

  it('采样结果始终 ∈ [0.02, xmax]', () => {
    const uValues = [0.001, 0.1, 0.3, 0.5, 0.7, 0.9, 0.999]
    for (const u of uValues) {
      const x = sampleSwebrecSize(x50, xmax, n, b, () => u)
      expect(x).toBeGreaterThanOrEqual(0.02)
      expect(x).toBeLessThanOrEqual(xmax)
    }
  })

  it('x50 接近 xmax 时仍返回有效尺寸（safeX50 钳制）', () => {
    const x = sampleSwebrecSize(1.99, 2.0, n, 2.0, () => 0.5)
    expect(x).toBeGreaterThanOrEqual(0.02)
    expect(x).toBeLessThanOrEqual(2.0)
  })
})

// ─── Task 11：swebrecCdf 与后端公式对齐 ────────────────────────────────────
describe('Task 11: swebrecCdf 与后端 kco_validator.py:_swebrec_cdf 对齐', () => {
  // 后端公式（kco_validator.py:83-92）：
  //   P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
  // 前端无法直接调用后端，此处用后端同一公式手算 expected 验证前端实现数学正确性
  const x50 = 0.3
  const xmax = 1.2
  const n = 1.2
  const b = 2.5
  const LN2 = Math.log(2)

  it('x=0.5 处与后端公式手算结果一致（≈0.90913）', () => {
    const x = 0.5
    // 手算：ratio=(0.5/0.3)^1.2, denom=((1.2-0.5)/(1.2-0.3))^2.5
    const ratio = Math.pow(x / x50, n)
    const denom = Math.pow((xmax - x) / (xmax - x50), b)
    const expected = 1 - Math.exp(-LN2 * ratio / denom)
    // 预期值 ≈ 0.909129（独立计算，与后端公式逐项一致）
    expect(expected).toBeCloseTo(0.909129, 4)
    expect(swebrecCdf(x, x50, xmax, n, b)).toBeCloseTo(expected, 10)
    expect(swebrecCdf(x, x50, xmax, n, b)).toBeCloseTo(0.909129, 4)
  })

  it('x=x50 → P=0.5（中位块度定义）', () => {
    // (x50/x50)^n=1, ((xmax-x50)/(xmax-x50))^b=1 → P=1-exp(-ln2)=0.5
    expect(swebrecCdf(x50, x50, xmax, n, b)).toBeCloseTo(0.5, 10)
  })

  it('x=0 → P=0（边界）', () => {
    expect(swebrecCdf(0, x50, xmax, n, b)).toBe(0)
  })

  it('x≥xmax → P=1（边界）', () => {
    expect(swebrecCdf(xmax, x50, xmax, n, b)).toBe(1)
    expect(swebrecCdf(xmax + 0.5, x50, xmax, n, b)).toBe(1)
  })

  it('CDF 在未饱和区间 (0, xmax*0.6] 上严格单调递增', () => {
    // 限制在未饱和区间：x 接近 xmax 时 exp(-large) 浮点下溢为 0，P 数值上饱和到 1.0，
    // 相邻点 P 相等无法严格递增；此处验证分布形状的单调性
    let prev = -Infinity
    for (let i = 1; i <= 12; i++) {
      const x = (xmax * 0.6 * i) / 12
      const p = swebrecCdf(x, x50, xmax, n, b)
      expect(p).toBeGreaterThan(prev)
      prev = p
    }
  })

  it('反函数采样一致性：swebrecCdf(sampleSwebrecSize(u)) ≈ u', () => {
    // 采样返回 x，其 cdf 应等于输入 u（验证反函数法正确性）
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const x = sampleSwebrecSize(x50, xmax, n, b, () => u)
      expect(swebrecCdf(x, x50, xmax, n, b)).toBeCloseTo(u, 3)
    }
  })
})

// ─── Task 5：constants 导入验证 ─────────────────────────────────────────────
describe('Task 5: constants 导入（KCO_OVERSIZE_THRESHOLD）', () => {
  it('KCO_OVERSIZE_THRESHOLD 来自 blastConstants.js 且 = 0.8', () => {
    // 与后端 kco_validator.py oversize_threshold 对齐
    expect(KCO_OVERSIZE_THRESHOLD).toBe(0.8)
  })

  it('KCO_OVERSIZE_THRESHOLD 为有限正数', () => {
    expect(Number.isFinite(KCO_OVERSIZE_THRESHOLD)).toBe(true)
    expect(KCO_OVERSIZE_THRESHOLD).toBeGreaterThan(0)
  })
})
