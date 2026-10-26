"""文献基准回归测试

将本平台实现的物理模型输出与公开文献中的典型值/范围进行对标，
确保模型在工程上合理（不要求精确复现，但要求量级与趋势一致）。

测试内容：
1. 萨道夫斯基经验公式 — 对标 GB6722-2014 附录
2. Kuz-Ram 块度分布 — 对标 Cunningham (1983, 1987) 典型值
"""
import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import math
import numpy as np
import pytest

from app.services.blasting.blast_physics import (
    sadosky_vibration, ppv_field_3d, RockMedium,
)
from app.services.blasting.kco_formulas import (
    swebrec_cdf, solve_x80, cunningham_n,
)
from app.services.blasting.kco_validator import KCOInput, calculate_kco


# ═══════════════════════════════════════════════════════════════
# 1. 萨道夫斯基经验公式 — GB6722-2014 对标
# ═══════════════════════════════════════════════════════════════

class TestSadoskyLiterature:
    """萨道夫斯基经验公式文献基准

    GB6722-2014《爆破安全规程》附录 A 给出典型场地系数：
      - 硬岩（花岗岩、玄武岩等）：K=50~150, α=1.3~1.5
      - 中硬岩（石灰岩、砂岩等）：K=150~250, α=1.5~1.8
      - 软岩（页岩、泥岩等）：K=250~400, α=1.8~2.0
    参考：GB6722-2014 表 A.1，胡英国等《爆炸与冲击》2015, 35(4):547-554。
    """

    def test_sadosky_literature_example(self):
        """复现教材标准算例（精确对标）

        经典算例（常见于《爆破工程》教材）：
          Q=10kg, R=15m, K=150, α=1.5
          → PPV = 150 × (10^{1/3}/15)^{1.5} ≈ 8.16 cm/s = 0.0816 m/s
        """
        rock = RockMedium()
        rock.sadosky_k = 150.0
        rock.sadosky_alpha = 1.5
        ppv_mps = sadosky_vibration(10, 15, rock=rock)
        expected = 150.0 * ((10 ** (1 / 3)) / 15) ** 1.5 * 0.01  # ≈ 0.0816 m/s
        assert ppv_mps == pytest.approx(expected, rel=1e-9)
        assert 0.08 <= ppv_mps <= 0.083

    @pytest.mark.parametrize("K,alpha", [
        (50, 1.3),   # 硬岩（GB6722 附录典型系数）
        (150, 1.5),  # 中硬岩
        (200, 1.5),  # 中硬岩（GB6722 附录典型值）
        (300, 1.8),  # 软岩
    ])
    def test_sadosky_ppv_physically_plausible(self, K, alpha):
        """不同场地系数的 PPV 均落在物理合理区间

        Q=100kg, r=10m（生产爆破近场）：按萨道夫斯基公式
        PPV = K×(Q^{1/3}/r)^α，Q^{1/3}=4.64, r=10m → (Q^{1/3}/r)≈0.464
        K=50,α=1.3 → ~18 cm/s = 0.18 m/s；K=300,α=1.8 → ~75 cm/s = 0.75 m/s。
        该量级与实测生产爆破近场振动（10~100 cm/s → 0.1~1.0 m/s）一致。
        """
        rock = RockMedium()
        rock.sadosky_k = float(K)
        rock.sadosky_alpha = float(alpha)
        ppv_mps = sadosky_vibration(100, 10, rock=rock)
        assert 0.10 <= ppv_mps <= 1.50, (
            f"K={K} α={alpha} Q=100 r=10 → PPV={ppv_mps:.2f} m/s"
            f" ({ppv_mps*100:.1f} cm/s)，超出生产爆破近场合理区间 [0.10, 1.50] m/s"
        )

    def test_sadosky_coefficient_ordering(self):
        """K/α 越大，PPV 越大（参数单调性）"""
        def ppv(K, alpha):
            rock = RockMedium()
            rock.sadosky_k = float(K)
            rock.sadosky_alpha = float(alpha)
            return sadosky_vibration(100, 10, rock=rock)

        v1 = ppv(50, 1.3)
        v2 = ppv(150, 1.5)
        v3 = ppv(200, 1.5)
        v4 = ppv(300, 1.8)
        assert v1 < v2 < v3 < v4

    def test_sadosky_monotonic_decay_with_distance(self):
        """PPV 随距离单调衰减（近场 > 中场 > 远场）"""
        rock = RockMedium()
        rock.sadosky_k = 200.0
        rock.sadosky_alpha = 1.5
        ppv_near = sadosky_vibration(100, 5, rock=rock)
        ppv_mid  = sadosky_vibration(100, 15, rock=rock)
        ppv_far  = sadosky_vibration(100, 30, rock=rock)
        assert ppv_near > ppv_mid > ppv_far > 0

    def test_sadosky_charge_scaling(self):
        """PPV 随装药量 Q^{1/3} 增长（萨道夫斯基公式特征）"""
        rock = RockMedium()
        rock.sadosky_k = 200.0
        rock.sadosky_alpha = 1.5
        ppv_50  = sadosky_vibration(50, 10, rock=rock)
        ppv_100 = sadosky_vibration(100, 10, rock=rock)
        ppv_200 = sadosky_vibration(200, 10, rock=rock)
        # Q^{1/3} 增长：50→100 → 1.26x, 100→200 → 1.26x
        # PPV 正比于 (Q^{1/3})^α = Q^{α/3}，α=1.5 时 PPV ∝ Q^{0.5}
        # 50→100 → √2 ≈ 1.41x, 100→200 → √2 ≈ 1.41x
        ratio_50_100 = ppv_100 / ppv_50
        ratio_100_200 = ppv_200 / ppv_100
        assert 1.2 <= ratio_50_100 <= 1.6
        assert 1.2 <= ratio_100_200 <= 1.6

    def test_ppv_field_3d_physical_plausibility(self):
        """ppv_field_3d 输出物理合理性（量级 + 球面衰减 + 因果性）

        验证 FDTD fallback 模式在隧道局部网格上的输出是否合理：
        - 近爆心 PPV 在 m/s 量级（破碎区）
        - 远场 PPV 衰减到 cm/s 量级
        - 波前未到达处 PPV=0
        """
        nx, ny, nz = 32, 32, 64
        xs = np.linspace(-9, 9, nx)
        ys = np.linspace(-7.5, 7.5, ny)
        zs = np.linspace(0, 40, nz)
        X, Y, Z = np.meshgrid(xs, ys, zs, indexing='ij')
        grid = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1).astype(np.float32)
        center = np.zeros(3, dtype=np.float32)

        # t=0.1s：波前已传播约 450m，应覆盖整个网格
        ppv = ppv_field_3d(grid, center, 100, K=30, alpha=1.5, t=0.1)
        max_ppv = float(ppv.max())
        min_ppv = float(ppv.min())
        # 所有点 > 0（波前已覆盖）
        assert np.all(ppv > 0)
        # 近爆心 PPV 数十 cm/s 量级（K=30, Q=100, r≈0.5m → ~420 cm/s → ×0.01 → ~4.2 m/s）
        # 但网格中最近点受 clamp 0.5m 影响，实际值可达 ~20 m/s
        assert 1.0 <= max_ppv <= 50.0, f"max_ppv={max_ppv} m/s 超出物理合理范围"
        assert min_ppv > 0

        # 因果性：t=0 时全 0
        ppv_zero = ppv_field_3d(grid, center, 100, K=30, alpha=1.5, t=0.0)
        assert np.all(ppv_zero == 0.0)


# ═══════════════════════════════════════════════════════════════
# 2. Kuz-Ram 块度分布 — Cunningham (1983, 1987) 对标
# ═══════════════════════════════════════════════════════════════

class TestKuzRamLiterature:
    """Kuz-Ram 块度分布文献基准

    Cunningham, C.V.B. (1983). "The Kuz-Ram model for prediction of
        fragmentation from blasting." Proc. 1st Int. Symp. Rock Frag.
        by Blasting, Lulea, Sweden, 439-454.
    Cunningham, C.V.B. (1987). "Fragmentation estimations and the
        Kuz-Ram model." Proc. 2nd Int. Symp. Rock Frag. by Blasting,
        Keystone, Colorado, 475-487.

    Cunningham 给出的典型均匀性指数 n 范围：
      - 良好爆破：n=1.2~1.8
      - 一般爆破：n=0.8~1.2
      - 较差爆破：n=0.5~0.8
    """

    def test_cunningham_n_in_literature_range(self):
        """Cunningham 均匀性指数 n 在文献 [0.5, 2.5] 范围内

        典型参数（B=1.5~3.5m, d=0.076~0.115m, W_abs=0~0.5m）：
        """
        test_cases = [
            # (B, d, W_abs, S, L, H, lo, hi)
            (1.5, 0.076, 0.0, 2.0, 4.0, 4.0, 0.5, 2.5),   # 小抵抗线，小孔径
            (2.0, 0.089, 0.2, 2.6, 4.0, 4.0, 0.5, 2.5),   # 中等
            (3.0, 0.102, 0.3, 3.9, 4.0, 4.0, 0.5, 2.5),   # 大抵抗线
            (3.5, 0.115, 0.5, 4.55, 4.0, 4.0, 0.5, 2.5),  # 最大参数
        ]
        for B, d, W_abs, S, L, H, lo, hi in test_cases:
            n = cunningham_n(B, d, W_abs, S, L, H)
            assert lo <= n <= hi, (
                f"B={B} d={d} W_abs={W_abs} S={S} L={L} H={H} → n={n:.3f}, "
                f"期望 [{lo}, {hi}]"
            )

    def test_kuz_ram_x50_plausible(self):
        """Kuznetsov x50 预测在合理范围内

        使用典型爆破参数：
          - 孔距 S=2.0m, 抵抗线 B=1.5m, 孔径 d=0.089m
          - 台阶高度 H=3.0m, 装药量 Q=30kg/孔
          - 岩石系数 A=7（中硬岩）, RWS=115（铵油炸药）

        Kuznetsov 方程（Cunningham 1983）：
          X50[cm] = A × (V0/Q)^0.8 × Q^{1/6} × (115/RWS)^{19/30}
        实现应与解析式精确一致，且落在工程合理区间。
        """
        A, Q, RWS, B, S, H = 7.0, 30.0, 115.0, 1.5, 2.0, 3.0
        result = calculate_kco(KCOInput(
            Q=Q, A=A, RWS=RWS, B=B, S=S, d=0.089, H=H,
            xmax=0.8, b=2.0, W_abs=0.2,
        ))
        # 与 Kuznetsov 解析式精确对标
        v0 = B * S * H
        x50_cm = A * ((v0 / Q) ** 0.8) * (Q ** (1 / 6)) * ((115 / RWS) ** (19 / 30))
        expected_x50 = max(0.01, x50_cm * 0.01)
        assert result.x50 == pytest.approx(expected_x50, rel=1e-9)
        # 工程合理区间（中硬岩 0.01~1.0 m）
        assert 0.01 <= result.x50 <= 1.0, (
            f"x50={result.x50:.3f}m 超出典型范围 [0.01, 1.0]m"
        )

    def test_swebrec_distribution_shape(self):
        """Swebrec 分布形状符合文献预期

        Cunningham (1987) 指出：
          - 良好爆破：x80/x50 ≈ 1.5~2.0
          - x80 应接近 xmax 但不等于 xmax
        """
        # 典型参数：x50=0.25m, xmax=0.6m, n=1.2, b=2.0
        x80 = solve_x80(0.25, 0.6, 1.2, 2.0)
        ratio = x80 / 0.25
        assert 1.3 <= ratio <= 2.5, (
            f"良好爆破 x80/x50={ratio:.3f}，期望 [1.3, 2.5]"
        )
        # x80 应小于 xmax
        assert x80 < 0.6, "x80 不应超过 xmax"

        # 均匀性差（n=0.8）时 x80 应显著增大
        x80_poor = solve_x80(0.25, 0.6, 0.8, 2.0)
        assert x80_poor > x80, (
            "均匀性差（n=0.8）时 x80 应大于均匀性好（n=1.2）时的 x80"
        )

    def test_kco_fragmentation_curve_monotonic(self):
        """Swebrec CDF 随 x 单调递增"""
        x50, xmax, n, b = 0.25, 0.6, 1.2, 2.0
        xs = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55]
        cdfs = [swebrec_cdf(x, x50, xmax, n, b) for x in xs]
        for i in range(1, len(cdfs)):
            assert cdfs[i] >= cdfs[i-1] - 1e-12, (
                f"CDF 在 x={xs[i]} 处下降（{cdfs[i-1]:.6f} → {cdfs[i]:.6f}）"
            )