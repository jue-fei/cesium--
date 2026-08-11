"""KCO 碎块分布共享公式模块（前后端对齐）

统一使用 Kuz-Ram exp 形式的 Swebrec 分布函数：
    P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)

后端（本文件）与前端 kcoFormulas.js 导出语义一致的 4 个函数，
数值结果在 1e-6（CDF）/1e-4（反解）量级内一致，便于双向校验。
"""
import math

LN2 = math.log(2.0)

try:  # 优先使用 scipy 的高精度求根
    from scipy.optimize import brentq as _scipy_brentq
except Exception:  # pragma: no cover - scipy 不可用时走纯 Python 兜底
    _scipy_brentq = None


def _brentq_pure(fn, a, b, tol=1e-7, max_iter=100):
    """纯 Python 版 Brent-Dekker 求根（scipy 不可用时的兜底实现）。"""
    fa = fn(a)
    fb = fn(b)
    if not (math.isfinite(fa) and math.isfinite(fb)):
        return float("nan")
    if fa == 0.0:
        return a
    if fb == 0.0:
        return b
    if fa * fb > 0:
        return float("nan")  # 未围根

    # 令 b 为当前最佳近似（|fb| < |fa|）
    if abs(fa) < abs(fb):
        a, b = b, a
        fa, fb = fb, fa

    c, fc = a, fa
    mflag = True
    d = b

    for _ in range(max_iter):
        if abs(fb) <= tol or abs(b - a) <= tol:
            return b

        if fa != fc and fb != fc:
            # 逆二次插值
            s = (
                (a * fb * fc) / ((fa - fb) * (fa - fc))
                + (b * fa * fc) / ((fb - fa) * (fb - fc))
                + (c * fa * fb) / ((fc - fa) * (fc - fb))
            )
        else:
            # 割线法
            s = b - (fb * (b - a)) / (fb - fa)
        if not math.isfinite(s):
            s = (a + b) / 2.0

        lo = (3.0 * a + b) / 4.0
        in_range = (lo <= s <= b) if b >= a else (b <= s <= lo)
        cond2 = mflag and abs(s - b) >= abs(b - c) / 2.0
        cond3 = (not mflag) and abs(s - b) >= abs(c - d) / 2.0
        cond4 = mflag and abs(b - c) < tol
        cond5 = (not mflag) and abs(c - d) < tol
        if not in_range or cond2 or cond3 or cond4 or cond5:
            s = (a + b) / 2.0
            mflag = True
        else:
            mflag = False

        fs = fn(s)
        d, c, fc = c, b, fb
        if fa * fs < 0:
            b, fb = s, fs
        else:
            a, fa = s, fs
        if abs(fa) < abs(fb):
            a, b = b, a
            fa, fb = fb, fa

    return b


def _brentq(fn, a, b, tol=1e-7, max_iter=100):
    """统一求根入口：优先 scipy，否则纯 Python 兜底。"""
    if _scipy_brentq is not None:
        try:
            return float(_scipy_brentq(fn, a, b, xtol=tol, maxiter=max_iter))
        except (ValueError, RuntimeError):
            return float("nan")
    return _brentq_pure(fn, a, b, tol=tol, max_iter=max_iter)


def swebrec_cdf(x, x50, xmax, n, b):
    """Kuz-Ram exp 形式 Swebrec 累积分布函数。

    P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
    """
    if x <= 0:
        return 0.0
    if x >= xmax:
        return 1.0
    if x50 <= 0 or xmax <= x50:
        return float("nan")
    numer = (x / x50) ** n
    denom = ((xmax - x) / (xmax - x50)) ** b
    return 1.0 - math.exp((-LN2 * numer) / denom)


def swebrec_inverse(u, x50, xmax, n, b):
    """Swebrec CDF 的数值反解：求解 swebrec_cdf(x) = u，u∈(0,1)。"""
    if x50 <= 0 or xmax <= x50:
        return float("nan")
    if u <= 0:
        return 0.0
    if u >= 1:
        return xmax
    eps = 1e-9
    return _brentq(lambda x: swebrec_cdf(x, x50, xmax, n, b) - u, eps, xmax - eps)


def solve_x80(x50, xmax, n, b):
    """求解 80% 通过块度 x80。"""
    return swebrec_inverse(0.8, x50, xmax, n, b)


def cunningham_n(B, d, W_abs):
    """Cunningham 均匀性指数 n。

    n = (2.2 - 14*d/B) * (1 - W_abs/B) / 2，clamp 到 [0.5, 2.5]。
    """
    if B <= 0:
        return 1.0
    raw = (2.2 - 14.0 * d / B) * (1.0 - W_abs / B) / 2.0
    return max(0.5, min(2.5, raw))
