/**
 * KCO 碎块分布共享公式模块（前后端对齐）
 *
 * 统一使用 Kuz-Ram exp 形式的 Swebrec 分布函数：
 *   P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
 *
 * 前端（本文件）与后端 kco_formulas.py 导出语义一致的 4 个函数，
 * 数值结果在 1e-6（CDF）/1e-4（反解）量级内一致，便于双向校验。
 */

const LN2 = Math.log(2)

/**
 * 标准 Brent-Dekker 求根算法
 * 在区间 [a, b] 上求解 fn(x)=0，要求 fn(a) 与 fn(b) 异号。
 * @param {(x:number)=>number} fn
 * @param {number} a
 * @param {number} b
 * @param {number} [tol=1e-7]
 * @param {number} [maxIter=100]
 * @returns {number} 近似根；若无法围根返回 NaN
 */
function brentq(fn, a, b, tol = 1e-7, maxIter = 100) {
  let fa = fn(a)
  let fb = fn(b)
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return NaN
  if (fa === 0) return a
  if (fb === 0) return b
  if (fa * fb > 0) return NaN // 未围根

  // 令 b 为当前最佳近似（|fb| < |fa|）
  if (Math.abs(fa) < Math.abs(fb)) {
    const ta = a; a = b; b = ta
    const tfa = fa; fa = fb; fb = tfa
  }

  let c = a
  let fc = fa
  let mflag = true
  let d = b

  for (let iter = 0; iter < maxIter; iter++) {
    if (Math.abs(fb) <= tol || Math.abs(b - a) <= tol) {
      return b
    }

    let s
    if (fa !== fc && fb !== fc) {
      // 逆二次插值
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb))
    } else {
      // 割线法
      s = b - (fb * (b - a)) / (fb - fa)
    }
    if (!Number.isFinite(s)) {
      s = (a + b) / 2
    }

    // s 必须落在 [(3a+b)/4, b] 区间内，否则改用二分
    const lo = (3 * a + b) / 4
    const inRange = b >= a ? s >= lo && s <= b : s >= b && s <= lo
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2
    const cond4 = mflag && Math.abs(b - c) < tol
    const cond5 = !mflag && Math.abs(c - d) < tol
    if (!inRange || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2
      mflag = true
    } else {
      mflag = false
    }

    const fs = fn(s)
    d = c
    c = b
    fc = fb
    if (fa * fs < 0) {
      b = s
      fb = fs
    } else {
      a = s
      fa = fs
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      const ta = a; a = b; b = ta
      const tfa = fa; fa = fb; fb = tfa
    }
  }
  return b
}

/**
 * Kuz-Ram exp 形式 Swebrec 累积分布函数
 *   P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
 * @param {number} x - 块度尺寸
 * @param {number} x50 - 中位块度
 * @param {number} xmax - 最大块度
 * @param {number} n - 均匀性指数
 * @param {number} b - Swebrec 弯曲参数
 * @returns {number} 通过比例 [0,1]；参数非法返回 NaN
 */
export function swebrecCdf(x, x50, xmax, n, b) {
  if (x <= 0) return 0
  if (x >= xmax) return 1
  if (x50 <= 0 || xmax <= x50) return NaN
  const numer = Math.pow(x / x50, n)
  const denom = Math.pow((xmax - x) / (xmax - x50), b)
  return 1 - Math.exp((-LN2 * numer) / denom)
}

/**
 * Swebrec CDF 的数值反解：求解 swebrecCdf(x) = u
 * @param {number} u - 目标通过比例，u∈(0,1)
 * @param {number} x50
 * @param {number} xmax
 * @param {number} n
 * @param {number} b
 * @returns {number} 对应块度 x∈(0,xmax)；参数非法返回 NaN
 */
export function swebrecInverse(u, x50, xmax, n, b) {
  if (x50 <= 0 || xmax <= x50) return NaN
  if (u <= 0) return 0
  if (u >= 1) return xmax
  const eps = 1e-9
  const fn = (x) => swebrecCdf(x, x50, xmax, n, b) - u
  return brentq(fn, eps, xmax - eps)
}

/**
 * 求解 80% 通过块度 x80
 * @param {number} x50
 * @param {number} xmax
 * @param {number} n
 * @param {number} b
 * @returns {number}
 */
export function solveX80(x50, xmax, n, b) {
  return swebrecInverse(0.8, x50, xmax, n, b)
}

/**
 * Cunningham 均匀性指数 n
 *   n = (2.2 - 14*d/B) * (1 - W_abs/B) / 2，clamp 到 [0.5, 2.5]
 * @param {number} B - 抵抗线(m)
 * @param {number} d - 孔径(m，与 B 同单位)
 * @param {number} W_abs - 钻孔偏差(m)
 * @returns {number}
 */
export function cunninghamN(B, d, W_abs) {
  if (B <= 0) return 1.0
  const raw = (2.2 - (14 * d) / B) * (1 - W_abs / B) / 2
  return Math.max(0.5, Math.min(2.5, raw))
}

export default {
  swebrecCdf,
  swebrecInverse,
  solveX80,
  cunninghamN
}
