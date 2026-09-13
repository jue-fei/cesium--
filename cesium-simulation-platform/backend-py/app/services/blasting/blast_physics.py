"""爆破物理引擎（Python科学计算版）

用于：
1. JWL状态方程（爆生气膨胀）
2. 波动方程求解（振动场精确计算）
3. 批量参数扫描（敏感度分析）

与前端blastPhysicsEngine.js互补：
- 前端：实时近似计算（萨道夫斯基经验公式），用于交互渲染
- 后端：离线精确计算（数值求解），用于安全评估报告
"""
import numpy as np
from dataclasses import dataclass, field
from typing import List, Tuple, Optional

import math

try:
    from numba import njit, prange
    _HAS_NUMBA = True
except ImportError:  # 无 numba 时静默回退纯 NumPy 路径
    _HAS_NUMBA = False

_NJT_WARMED = False  # numba 内核是否已预热编译（进程内单例）


@dataclass
class BlastSource:
    """爆源参数"""
    charge_kg: float
    explosive_type: str = "emulsion"
    velocity_of_detonation: float = 4500  # 爆速(m/s)
    density: float = 1200  # 炸药密度(kg/m³)


@dataclass
class RockMedium:
    """岩体介质参数"""
    density: float = 2650
    p_wave_speed: float = 4500
    s_wave_speed: float = 2600
    youngs_modulus: float = 50e9
    poissons_ratio: float = 0.25
    attenuation_p: float = 0.012
    attenuation_s: float = 0.018


def sadosky_vibration(charge_kg: float, distance: float, rock: RockMedium = None,
                      min_standoff: float = 0.5) -> float:
    """萨道夫斯基经验公式计算峰值振动速度

    v = K * (Q^(1/3) / R)^alpha

    K: 场地常数(50~400), alpha: 衰减指数(1.0~2.0)

    **单位约定（A1 修复）**：公式原始量纲为 cm/s（K 的量纲为 cm/s），
    本函数在 return 处统一 ×0.01 转换为 **m/s**，返回值为 m/s。
    库内所有内部函数与返回值统一使用 m/s，仅在边界（Persson 损伤阈值、
    前端展示）处做一次 cm/s 转换。

    近场处理（修正历史版本奇点/跳变）：
    - 萨道夫斯基经验公式仅在中远场（R 远大于药包尺寸）成立，R→0 时发散。
    - 旧实现 R<0.1m 直接返回常数 K，与 R=0.1m 处的公式值（可达数十万 cm/s）
      形成巨大跳变，破坏单调性。
    - 现改为把距离钳制到有效下限 min_standoff（默认 0.5m，经验公式适用下限），
      使曲线在近场连续、有界且单调。

    K/α 取值：优先取 rock.sadosky_k / rock.sadosky_alpha（DB rock_params 迁移字段），
    未提供时回退默认 K=200、α=1.5（中硬岩，GB6722 附录）。
    """
    if rock is None:
        rock = RockMedium()
    K = getattr(rock, "sadosky_k", 200.0)
    alpha = getattr(rock, "sadosky_alpha", 1.5)
    r = max(distance, min_standoff)
    # 公式结果为 cm/s，统一换算为 m/s（K 的量纲为 cm/s）
    return K * (charge_kg ** (1/3) / r) ** alpha * 0.01


def jwl_pressure(relative_volume: float, explosive_type: str = "emulsion",
                 charge_kg: Optional[float] = None) -> float:
    """JWL状态方程计算爆生气压力

    P = A*(1 - w/(R1*V))*exp(-R1*V) + B*(1 - w/(R2*V))*exp(-R2*V) + w*E0/V

    V: 相对体积(无量纲), E0: 初始内能密度(J/m³)

    物理量纲说明：
    - A/B/E0 均为量纲强度量（Pa 与 J/m³，1 Pa = 1 J/m³），因此 w*E0/V 项量纲为 Pa，
      与 A/B 两项一致，方程自洽。
    - JWL 压力为强度量（intensive）：在相同相对体积 V 下仅依赖炸药类型（CJ 压力是
      炸药材料属性），与装药量无关。
    - 装药量只影响爆腔体积/半径（见 JWLBlastSource.cavity_radius = (3·V_charge/4π)^(1/3)）
      与爆生气体总能量，不改变局部压力。把 E0 乘以装药体积会引入错误量纲（J 而非 J/m³），
      导致同种炸药不同装药量算出不同压力，违反 CJ 压力为材料属性的物理事实。

    charge_kg 参数保留仅为 /physics/jwl 端点请求兼容，不影响计算结果。
    """
    # JWL 参数（A/B/R1/R2/w 为炸药固有属性；E0 为单位体积初始内能 J/m³）
    params = {
        "emulsion": {"A": 3.7377e11, "B": 3.747e9, "R1": 4.15, "R2": 0.9, "w": 0.35, "E0": 3.9e9},
        "anfo": {"A": 4.946e11, "B": 1.216e9, "R1": 4.5, "R2": 1.0, "w": 0.3, "E0": 2.484e9},
        "dynamite": {"A": 5.242e11, "B": 2.067e9, "R1": 4.2, "R2": 1.1, "w": 0.35, "E0": 3.56e9},
    }

    p = params.get(explosive_type, params["emulsion"])
    V = max(0.01, relative_volume)
    # E0 为强度量（J/m³），不随装药量缩放（见 docstring 量纲说明）
    E0 = p["E0"]
    P = (p["A"] * (1 - p["w"] / (p["R1"] * V)) * np.exp(-p["R1"] * V)
         + p["B"] * (1 - p["w"] / (p["R2"] * V)) * np.exp(-p["R2"] * V)
         + p["w"] * E0 / V)
    return float(P)


def wave_field_1d(charge_kg: float, distances: np.ndarray, times: np.ndarray,
                  rock: RockMedium = RockMedium()) -> np.ndarray:
    """一维振动场传播（运动学 + 峰值 + 单指数时间衰减）

    修正历史版本的三个物理问题：
    1. 双重衰减：萨道夫斯基峰值已含几何扩散 (Q^(1/3)/R)^α，原代码再乘 exp(-βr)/(1+0.01r)
       属重复计衰减。现仅保留时间衰减项。
    2. P/S 波运动学混淆：原代码到达判定用 P 波 t<r/c_p，但高斯包络中心对 S 波 t=r/c_s，
       物理上不一致。现统一用 P 波运动学（爆破近场以 P 波为主导）。
    3. 包络宽度 0.25s 硬编码无物理依据：改为衰减时间常数 1/attenuation_p。

    返回 (len(times), len(distances)) 的振动速度矩阵 (m/s)
    """
    field = np.zeros((len(times), len(distances)))
    # 衰减时间常数：1/attenuation_p，避免硬编码 0.25s
    tau = 1.0 / max(rock.attenuation_p, 1e-6)
    for i, t in enumerate(times):
        for j, r in enumerate(distances):
            if r < 0.1:
                continue
            arrival = r / rock.p_wave_speed  # 统一用 P 波到达
            if t < arrival:
                continue
            # 萨道夫斯基峰值（已含几何扩散）+ 单一来源时间衰减
            peak = sadosky_vibration(charge_kg, r, rock)
            envelope = np.exp(-(t - arrival) / tau)
            field[i, j] = peak * envelope
    return field


def parameter_sweep(base_params: dict, param_name: str,
                    values: list, fixed: dict = None) -> List[dict]:
    """参数扫描（敏感度分析）

    对指定参数在给定值范围内扫描，返回每组的计算结果
    包含：萨道夫斯基振动速度 + JWL 爆生气峰值压力

    单位约定（A1 修复）：所有速度字段统一为 **m/s**。
    - 'vibration_velocity' 为峰值振动速度（m/s），'vibration_velocity_mps' 为同值的
      显式单位标注字段（保持单位自解释，供下游直接使用）。
    - 'safe' 判定阈值默认 0.05 m/s（= 5 cm/s，GB6722 远场安全允许下限）。
    """
    results = []
    for val in values:
        params = {**base_params, **(fixed or {}), param_name: val}
        v = sadosky_vibration(params.get('charge_kg', 100), params.get('distance', 50))
        # JWL 爆生气压力（取相对体积=1，即初始爆生气状态）
        explosive = params.get('explosive_type', 'emulsion')
        p_jwl = jwl_pressure(params.get('relative_volume', 1.0), explosive)
        results.append({
            'param_name': param_name,
            'param_value': val,
            'vibration_velocity': v,
            'vibration_velocity_mps': v,  # 显式单位标注（m/s）
            'jwl_peak_pressure': p_jwl,
            'safe': v < params.get('threshold', 0.05)
        })
    return results


def build_ppv_grid(tunnel_width: float = 18, tunnel_height: float = 15,
                   extent_forward: float = 25, resolution: float = 0.75
                   ) -> Tuple[np.ndarray, tuple, np.ndarray, np.ndarray]:
    """构建掌子面前方岩体的 3D 采样网格（局部坐标系，爆心在原点）

    网格范围覆盖隧道断面周围岩体 + 掌子面前方 extent_forward 米。
    坐标系：X=宽度方向，Y=高度方向，Z=前方（掌子面朝向，默认-Z）。

    :param tunnel_width: 隧道宽度(m)
    :param tunnel_height: 隧道高度(m)
    :param extent_forward: 前方采样深度(m)
    :param resolution: 采样分辨率(m)
    :return: (grid_xyz, grid_shape, bounds_min, bounds_max)
        grid_xyz: (N,3) 采样点坐标
        grid_shape: (nx, ny, nz)
        bounds_min/max: 体素盒边界（用于前端定位）
    """
    x_min, x_max = -tunnel_width * 0.75, tunnel_width * 0.75
    y_min, y_max = -tunnel_height * 0.2, tunnel_height * 1.2
    z_min, z_max = 0.0, extent_forward

    nx = max(2, int((x_max - x_min) / resolution) + 1)
    ny = max(2, int((y_max - y_min) / resolution) + 1)
    nz = max(2, int((z_max - z_min) / resolution) + 1)

    x = np.linspace(x_min, x_max, nx)
    y = np.linspace(y_min, y_max, ny)
    z = np.linspace(z_min, z_max, nz)

    XX, YY, ZZ = np.meshgrid(x, y, z, indexing='ij')
    grid_xyz = np.column_stack([XX.ravel(), YY.ravel(), ZZ.ravel()])

    bounds_min = np.array([x_min, y_min, z_min], dtype=np.float32)
    bounds_max = np.array([x_max, y_max, z_max], dtype=np.float32)

    return grid_xyz, (nx, ny, nz), bounds_min, bounds_max


# 干涉子波载波品质因数（与前端 localVibrationSimulator.js 的 WAVELET_Q=4 同口径）：
# 载波 cos(2πf·gap)·exp(-πf·gap/Q) 为有限时长瞬态脉冲（每周期 e^(-π/Q)≈0.46，
# 4 周期后 <5%）。短的子波脉冲使各炮孔源的波前环彼此分明，多源相长/相消干涉
# 在色带上更容易读出（Q=10 的长波列会把干涉糊成同心圆）。
WAVELET_Q = 4.0


def ppv_field_3d(grid_xyz: np.ndarray, blast_center: np.ndarray,
                 charge_kg: float, K: float = 30, alpha: float = 1.5,
                 beta: float = 0.02, c_p: float = 4500, t: float = 0.0,
                 visual_c_p: float = 35.0, visual_beta: float = 0.8,
                 carrier_hz: float = 0.0,
                 influence_radius: Optional[float] = None,
                 influence_tau: float = 3.0) -> np.ndarray:
    """3D 球面波 PPV 振动场计算

    萨道夫斯基经验公式 + 球面波前传播 + 指数阻尼：

        PPV(r, t) = K · (Q^{1/3} / R)^{α} · exp(-(β + β_v)·(t - R/c_view)) · H(t - R/c_view)

    其中 R 为采样点到爆心的球面距离，H 为 Heaviside 阶跃函数
    （波前未到达处 PPV=0），β 为介质阻尼系数，β_v 为可视化时变衰减。

    β_v 说明（非物理阻尼，仅用于展示"实时质点速度"）：实时速度场随时间衰减，
    默认 β=0.02 的时间常数≈35s，在动画时间尺度内几乎看不到波峰回落，最终全场
    呈现恒为峰值的高数值颜色。β_v（默认 0.8/s，τ≈1.25s）只增强"波前扫过后速度
    回落"的瞬时演化，使动画呈现 到达→峰值→回落 的真实振动过程；峰值幅值与
    Persson 损伤分区仍由 K/α 几何衰减主导。

    波前速度说明：物理纵波速度 c_p≈4500 m/s，在 0.05s 推送步长下波前 1 帧内就
    贯穿整个网格（25m 仅需约 5.5ms），观看完全看不到"波从爆心向外扩散"的过程。
    这里为可视化取 `visual_c_p≈35 m/s`（与前端本地模拟器一致）——把波前到达
    时间拉长到数百毫秒到数秒，使 PPV 以球面波环的形式从爆心向外可见地传播、
    逐帧扩散、衰减，从而呈现真实的振动传播动画。c_p 仅保留作物理参考参数。

    理论依据：
    - 萨道夫斯基经验公式（GB6722-2014 第 6.2 条）
    - 胡英国等《爆炸与冲击》2015, 35(4):547-554（岩体爆破损伤 PPV 临界值）
    - 周传波等 JRMGE 2025（考虑介质阻尼与几何扩散的振动场正演算法）

    :param grid_xyz: (N,3) 采样点坐标
    :param blast_center: (3,) 爆心坐标
    :param charge_kg: 装药量(kg)
    :param K: 场地常数。默认 30（而非工程常用 200）：本网格为隧道局部尺度
        （27×21×25m），若 K=200，按 Q=100kg 计算网格最远角（≈34m）PPV 仍约 10 cm/s、
        中远场普遍 >15 cm/s，超出前端 PPV 色阶上限 15 cm/s，导致整个体积盒饱和成一片红
        （前端表现为"掌子面前红色方形"），应力/损伤场也由该饱和 PPV 派生而无法分级显示。
        K=30 时近爆心 PPV 仍达数十 cm/s（破碎/抛掷区，红），远场衰减至 ~1 cm/s（蓝），
        使 PPV/应力/损伤三场均呈现"近红→中绿→远蓝"的球面梯度。
    :param alpha: 衰减指数（1.5-1.8）
    :param beta: 介质阻尼系数（0.01-0.05，物理）
    :param c_p: 纵波速度(m/s)（物理参考；波前可视化速度见 visual_c_p）
    :param t: 模拟时间(s)
    :param visual_c_p: 波前可视化传播速度(m/s)，默认 35 使波环在视野内可见扩散
    :param visual_beta: 可视化时变衰减(1/s)，默认 0.8（见上方 β_v 说明）
    :return: (N,) PPV 数组(m/s)，波前未到达处为 0
    """
    r = np.linalg.norm(grid_xyz - blast_center, axis=1)
    r = np.maximum(r, 0.5)  # 避免爆心奇点，下限 0.5m

    arrival = r / visual_c_p  # 波前到达时间（可视化波速）
    # 实时质点速度：波前未到达置 0，到达后按物理 β + 可视化 β_v 指数回落
    mask = t >= arrival
    gap = np.maximum(t - arrival, 0.0)
    decay = np.exp(-(beta + visual_beta) * gap)
    # 干涉子波载波（与前端 waveletOsc 同口径）：从到达处起振为 0、有限时长脉冲；
    # carrier_hz=0 时退化为单调衰减包络
    if carrier_hz > 0:
        decay = decay * np.sin(2.0 * np.pi * carrier_hz * gap) * np.exp(
            (-np.pi * carrier_hz * gap) / WAVELET_Q)
    ppv = K * (charge_kg ** (1.0 / 3.0) / r) ** alpha * decay * mask
    # 爆源影响半径能量包络：把解析场收束为有界爆源体积（P0-2 近场物理近似）
    if influence_radius is not None and influence_radius > 0:
        ppv = ppv * _radial_energy_envelope(r, influence_radius, influence_tau)
    return (ppv * 0.01).astype(np.float32)  # cm/s → m/s


def ppv_field_3d_multi(grid_xyz: np.ndarray, sources: List[dict],
                       t: float, K: float = 30, alpha: float = 1.5,
                       beta: float = 0.02, c_p: float = 4500,
                       visual_c_p: float = 35.0, visual_beta: float = 0.8,
                       min_standoff: float = 0.5,
                       carrier_hz: float = 0.0,
                       influence_radius: Optional[float] = None,
                       influence_tau: float = 3.0) -> np.ndarray:
    """3D 多装药源 PPV 场 —— 多应力波矢量叠加（波场干涉，非单一同心圆）

    爆破应力场由 N 个炮孔装药段各自起爆、按微差延时依次传播的应力波叠加而成
    （依据：Da Balai 隧道楔形掏槽微差爆破 Eng 2026；《爆炸与冲击》空孔直眼掏槽）。
    每个装药源 play 一个球面波，其瞬时质点速度为**矢量**、方向沿该源径向：

        v_s(p,t) = K·(q_s^(1/3)/r_s)^α · exp(−(β+β_v)·(t − d_s − r_s/c_view))
                   · H(t − d_s − r_s/c_view) · û_s

    某点总瞬时速度 = 各源矢量和 v(p,t) = Σ_s v_s·û_s，PPV = |v|。
    源间距离与延时差产生相长/相消干涉：掏槽孔孔底汇拢处相长（核心高应力）、
    相位错开处出现干涉瓣——波场不再是一个药包中心的单一同心球面环。

    :param sources: 装药源列表，每项 {pos:[x,y,z], charge_kg:float, delay_s:float}
    :return: (N,) PPV 数组(m/s)（矢量叠加模长，波前未到达处为 0）
    """
    if not sources:
        return np.zeros(grid_xyz.shape[0], dtype=np.float32)

    grid = np.asarray(grid_xyz, dtype=np.float64)  # (N,3)
    v = np.zeros((grid.shape[0], 3), dtype=np.float64)

    for s in sources:
        pos = np.asarray(s.get('pos', [0.0, 0.0, 0.0]), dtype=np.float64).reshape(1, 3)
        q = float(s.get('charge_kg', 0.0))
        delay = float(s.get('delay_s', 0.0))
        if q <= 0:
            continue
        d = grid - pos                    # (N,3)
        r = np.linalg.norm(d, axis=1, keepdims=True)          # (N,1)
        r_safe = np.maximum(r, min_standoff)
        arrival = delay + r_safe[:, 0] / visual_c_p
        mask = t >= arrival               # 该源波前到达
        if not mask.any():
            continue
        amp = K * (q ** (1.0 / 3.0) / r_safe) ** alpha            # (N,1) cm/s
        gap = np.maximum(t - arrival, 0.0).reshape(-1, 1)  # (N,1) 对齐 amp
        amp *= np.exp(-(beta + visual_beta) * gap)  # 实时回落
        # 多孔延差+路径差 → 相位差 → 干涉条纹（同前端 waveletOsc，Q=WAVELET_Q）
        if carrier_hz > 0:
            amp *= np.sin(2.0 * np.pi * carrier_hz * gap) * np.exp(
                (-np.pi * carrier_hz * gap) / WAVELET_Q)
        # 单位径向矢量：u = d / r（标准化）
        unit = d / r_safe
        contrib = (amp * unit) * (mask[:, None].astype(np.float64))  # (N,3) cm/s 矢量
        v += contrib

    ppv = np.sqrt((v ** 2).sum(axis=1))
    # 爆源影响半径能量包络：取到最近爆源的距离作径向坐标，收束为有界爆源体积
    if influence_radius is not None and influence_radius > 0:
        dmin = np.full(grid.shape[0], np.inf, dtype=np.float64)
        for s in sources:
            pos = np.asarray(s.get('pos', [0.0, 0.0, 0.0]), dtype=np.float64).reshape(1, 3)
            dmin = np.minimum(dmin, np.linalg.norm(grid - pos, axis=1))
        ppv = ppv * _radial_energy_envelope(dmin, influence_radius, influence_tau)
    return (ppv * 0.01).astype(np.float32)  # cm/s → m/s


def peak_ppv_envelope_multi(grid_xyz: np.ndarray, sources: List[dict],
                            K: float = 30.0, alpha: float = 1.5,
                            min_standoff: float = 0.5, visual_c_p: float = 35.0,
                            influence_radius: Optional[float] = None,
                            influence_tau: float = 3.0) -> tuple:
    """确定性峰值包络 + 波前到达时刻（损伤判据专用，seek 即时无重算）

    与前端 localVibrationSimulator.computeMultiSourcePeakDamageZones 同口径：

        peak(p)   = |Σ_s A_s(r_s)·û_s|，A_s(r)=K·(q_s^(1/3)/r)^α·0.01（m/s）
        arrival(p)= min_s(delay_s + r_s/c_view)
        peak(p,t) = peak(p) · 1[t ≥ arrival(p)]

    损伤是"经历过的最大 PPV"的不可逆判据：对时变衰减场 v(t)=A·e^(−D·gap)（单调
    递减），波前扫过该点时即取得全程峰值，故峰值=几何峰值、与载波相位/采样时刻
    无关。与"逐帧采样 np.maximum 累积"（受载波过零与时变衰减影响而欠估计，且
    seek 需 O(target) 次全场正演重算、阻塞事件循环）相比，本式一次预计算
    (peak_full, arrival)，任意 t（含 seek 回拉）只做 O(N) 门控——同一 (t, 源
    几何) 正放/回拉/拖动进度条结果完全一致。

    :param sources: 装药源列表，每项 {pos:[x,y,z], charge_kg:float, delay_s:float}
    :return: (peak_full(N,) float32 全程几何峰值 m/s, arrival(N,) float64 最早到达 s)
    """
    n = grid_xyz.shape[0]
    grid = np.asarray(grid_xyz, dtype=np.float64)
    v = np.zeros((n, 3), dtype=np.float64)
    arrival = np.full(n, np.inf, dtype=np.float64)
    dmin = np.full(n, np.inf, dtype=np.float64)
    if not sources:
        return np.zeros(n, dtype=np.float32), arrival
    for s in sources:
        pos = np.asarray(s.get('pos', [0.0, 0.0, 0.0]), dtype=np.float64).reshape(1, 3)
        q = float(s.get('charge_kg', 0.0))
        delay = float(s.get('delay_s', 0.0))
        if q <= 0:
            continue
        d = grid - pos
        r = np.linalg.norm(d, axis=1, keepdims=True)          # (N,1)
        r_safe = np.maximum(r, min_standoff)
        np.minimum(arrival, delay + r_safe[:, 0] / visual_c_p, out=arrival)
        np.minimum(dmin, r_safe[:, 0], out=dmin)
        amp = K * (q ** (1.0 / 3.0) / r_safe) ** alpha * 0.01  # (N,1) m/s
        unit = d / r_safe                                       # 单位径向矢量
        v += amp * unit
    peak = np.sqrt((v ** 2).sum(axis=1))
    if influence_radius is not None and influence_radius > 0:
        # 与瞬时场同口径的空间包络：峰值收束在同一有界爆源体积内
        peak = peak * _radial_energy_envelope(dmin, influence_radius, influence_tau)
    peak = np.where(np.isfinite(dmin), peak, 0.0)
    return peak.astype(np.float32), arrival


def pack_ppv_binary(frame: int, t: float, grid_shape: tuple,
                     bounds_min: np.ndarray, bounds_max: np.ndarray,
                     ppv: np.ndarray) -> bytes:
    """将 PPV 场打包为二进制帧（供 WebSocket send_bytes 推送）

    帧格式（网络字节序）：
        偏移  长度  类型     含义
        0     1    uint8   type_id = 0x02 (PPV_FIELD)
        1     4    uint32  sim_frame
        5     4    float32 t
        9     4    uint32  grid_w
        13    4    uint32  grid_h
        17    4    uint32  grid_d
        21    4    float32 bounds_min_x
        25    4    float32 bounds_min_y
        29    4    float32 bounds_min_z
        33    4    float32 bounds_max_x
        37    4    float32 bounds_max_y
        41    4    float32 bounds_max_z
        45    N*4  float32[N] PPV 数组（N = grid_w * grid_h * grid_d）

    :return: bytes 二进制帧
    """
    import struct
    nx, ny, nz = grid_shape
    header = struct.pack('>B I f I I I 6f',
                         0x02, frame, float(t),
                         nx, ny, nz,
                         float(bounds_min[0]), float(bounds_min[1]), float(bounds_min[2]),
                         float(bounds_max[0]), float(bounds_max[1]), float(bounds_max[2]))
    # 轴序转换：grid_xyz 由 np.meshgrid(indexing='ij') 构建，ravel 后为 x-最慢、z-最快；
    # 而 WebGL Data3DTexture 期望 x-最快、z-最慢（data[z*nx*ny + y*nx + x]）。
    # 故先 reshape 回 (nx,ny,nz) 再 transpose(2,1,0) → (nz,ny,nx)，使 x 在内存中连续最快。
    ppv_3d = ppv.reshape((nx, ny, nz))
    ppv_webgl = np.ascontiguousarray(ppv_3d.transpose(2, 1, 0))  # (nz, ny, nx)
    ppv_bytes = ppv_webgl.astype('>f4').tobytes()
    return header + ppv_bytes


# ─── 损伤分区阈值（对齐 Persson–Holmberg 近场 PPV 临界值，cm/s）───────
# 量级依据 Persson/Holmberg 近场岩体损伤判据：峰值振速达 700–1000 mm/s
# （70–100 cm/s）时岩体产生/扩展裂纹、进入破碎损伤带。
#
# 【P0-1 修正】原始低档阈值 (10,30,70,100) cm/s 在本平台解析场（K=30、α=1.5、
# Q≈100kg）下把损伤半径推到十几米，远大于隧道断面尺度 → 出现"无视隧道轮廓的
# 无边大红圆/热处理球"。现依据岩体近场损伤判据整体提高阈值：
#   elastic     <  20 cm/s（σ_vm ≈ 3.2 MPa，低于中硬岩抗压/抗拉强度 → 无损伤）
#   micro_crack  20–50 cm/s（初始微裂纹萌生）
#   crack_growth 50–100 cm/s（裂纹扩展贯通，接近 Persson 700 mm/s 判据）
#   fracture     100–200 cm/s（岩体破碎，对应 Persson–Holmberg 700–1000 mm/s 临界带）
#   throw        ≥ 200 cm/s（岩体抛掷，爆腔形成）
# 意义：使损伤区收束到爆源邻近数米——按 Q=100kg、R 处 PPV=K·(Q^(1/3)/R)^α：
#   micro_crack 起于≈5.5m；crack_growth 起于≈3.1m；fracture 起于≈2.0m；throw 起于≈1.3m。
# 说明：强岩体实际损伤要求更高 PPV（>50–100 cm/s），此处高档已按用户要求大幅上提；
# 与 GB6722（保护建(构)筑物，0.5~15 cm/s）远场安全标准语义不同，二者不混用。
# 依据：
#   Holmberg R, Persson P A. Charge Calculations for Tunneling. 1979（700–1000 mm/s 临界判据）
#   Persson P A, Holmberg R, Lee J. Rock Blasting and Explosives Engineering. 1994
#   胡英国等. 爆炸与冲击, 2015, 35(4):547-554（岩体爆破损伤 PPV 临界值实验研究）
#   周传波等. JRMGE, 2025（考虑介质阻尼的振动场正演与损伤评价）
DAMAGE_THRESHOLDS_CMPS = (20.0, 50.0, 100.0, 200.0)
DAMAGE_ZONE_LABELS = ('elastic', 'micro_crack', 'crack_growth', 'fracture', 'throw')

# 【P0-2】损伤区空间约束（把"各向同性无穷大红圆"收束到隧道临空面附近数米）：
# 解析场（萨道夫斯基）近场本身不适用，故以"距最近爆源的最大损伤半径 + 平滑衰减"
# 作为深度衰减上限，使损伤沿隧道轮廓（掌子面/临空面）向外只发展 5~10 米。
DAMAGE_MAX_RADIUS = 7.0   # 米：损伤区最大计算半径（解析近场近似上限）
DAMAGE_ATTEN_TAU = 1.5    # 米：max_radius 前开始平滑过渡到 0 的宽度（防硬切突变）

# 解析波场/应力场的"爆源影响半径"（米）：超过后能量包络衰减到 0。
# 使 PPV/应力/损伤三场表现为"有界爆源体积"，而非无视隧道、铺满整个岩体 slab 的球。
# 默认 30m（原 14m）：14+tau=17m 把中远场梯度拦腰截断，热力图渲染范围/强度
# 明显弱于引入包络之前；30+tau=33m 覆盖整个计算域（1.5m 分辨率网格对角 ≈40m），
# 恢复全盒渐变的同时场仍收敛于有界体积（远小于岩体 slab 尺度）。
BLAST_INFLUENCE_RADIUS = 30.0
BLAST_INFLUENCE_TAU = 3.0


def _radial_energy_envelope(distance: np.ndarray, radius: float, tau: float) -> np.ndarray:
    """平滑径向能量包络：r ≤ radius 内为 1，radius→radius+tau 线性过渡到 0。
    用于把解析场收束为有界爆源体积（r > radius+tau 后强度为 0），
    体现"爆破能量/应力/损伤只影响隧道临空面附近有限范围"的近场物理。
    """
    r = np.asarray(distance, dtype=np.float64)
    tau = max(tau, 1e-6)
    return np.clip((radius + tau - r) / tau, 0.0, 1.0).astype(np.float64)


# ─── 应力近场几何修正（区分"应力场"与"振速场"的空间结构）─────────────
# 与前端 localVibrationSimulator.js 的 NEAR_FIELD_MULT / NEAR_FIELD_GAIN 跨语言镜像。
# 弹性球面波在近场尚未充分发散：空腔膨胀的准静态应力场（σ ∝ r^-3）与几何修正
# （波幅 ∝ r^-2）只在中远场过渡为纯辐射项 σ = ρ·c_p·v。若应力直接取该辐射项，
# 它与瞬时振速场只差一个常数——归一化后逐点相等、色阶也只差一张 Viridis 表，
# 表现为"震速的图和应力的图一模一样"（用户实测反馈）。
# 此处给辐射项叠加一阶等效的近场几何放大 F(r) = 1 + GAIN·(r_nf/r)²，
# 交叉半径 r_nf = MULT × 装药空腔半径（由装药体积反算）。
# 【幅值必须温和】r_nf 取 2×r_b ≈ 0.5 m，近场项只在 1~2 m 内起作用；
# 若 r_nf 取到 1.5 m、GAIN=2，F(0.5m)=19，中心被抬 19 倍 → 相对满量程深饱和，
# 整图糊成"巨大黄色高斯云"（用户实测反馈）。
# 说明：弹性解在近场塑性区失效，本项按一阶几何等效给定，仅表达空间结构。
NEAR_FIELD_MULT = 2.0
NEAR_FIELD_GAIN = 2.0
EXPLOSIVE_DENSITY_DEFAULT = 1250.0  # kg/m³（乳化炸药量级）


def compute_near_field_radius(charge_kg: float,
                              rho_explosive: float = EXPLOSIVE_DENSITY_DEFAULT) -> float:
    """应力近场几何修正的交叉半径 r_nf(m)

    r_nf = NEAR_FIELD_MULT × 装药空腔半径 r_b，r_b = (3V/4π)^(1/3)，V = m/ρ_e；
    钳制到 [0.5, 4] m（工程尺度）。
    """
    m = max(0.0, float(charge_kg or 0.0))
    rho_e = float(rho_explosive) if rho_explosive else EXPLOSIVE_DENSITY_DEFAULT
    if m <= 0.0 or rho_e <= 0.0:
        return 0.0
    v = m / rho_e
    rb = (3.0 * v / (4.0 * math.pi)) ** (1.0 / 3.0)
    return float(min(4.0, max(0.5, NEAR_FIELD_MULT * rb)))


def stress_field_from_ppv(ppv: np.ndarray,
                          rho: float = 2650.0,
                          c_p: float = 4500.0,
                          nu: float = 0.25,
                          r: Optional[np.ndarray] = None,
                          near_field_radius: float = 0.0,
                          near_field_gain: float = NEAR_FIELD_GAIN) -> dict:
    """由 PPV 振动场反演岩体应力场（弹性球面波本构，一阶近似）

    爆破应力波在岩体中产生两种破坏性应力（这是岩体爆破破坏/生成裂隙的机制）：
        - 径向压应力 σ_rr（加载相）：σ_rr = ρ · c_p · v_r   （波阻抗关系）
        - 切向拉应力 σ_θθ（幅值）：σ_θθ = (ν / (1−ν)) · σ_rr（切向受拉，方向与径向相反）
    切向拉应力是产生径向裂隙的主因（应力波使介质切向受拉，见文献依据）。

    主应力状态（压缩为正，切向拉为负）：σ_1 = σ_rr（最大主应力，径向），
               σ_2 = σ_3 = −σ_θθ（切向，两正交方向相等，为拉应力）。
    von Mises 等效应力：

        σ_vm = |σ_rr − σ_θθ| = σ_rr · (1 + ν/(1−ν)) = σ_rr / (1−ν)   （再乘近场项 F(r)）

    近场几何修正（与前端 localVibrationSimulator.NEAR_FIELD_* 同口径）：
        F(r) = 1 + NEAR_FIELD_GAIN · (r_nf / r)²
    没有它时 σ 只是 v 的常数倍——前端归一化后与振速场逐点相等，两模式同一张图。

    适用范围与局限：
        - 弹性一阶近似，适用于中远场（r > 5R_charge，R_charge 为药包半径）；
        - 近场（爆腔附近）存在塑性变形，弹性预测偏低，需配合损伤分区修正；
          近场修正项按一阶几何等效给定，仅表达空间结构，不作工程定量结论；
        - σ_θθ 为切向拉应力幅值（成缝判据 σ_θθ ≥ σ_t 岩体抗拉强度）。

    理论依据：
        - Hwang & Mohanty, Int. J. Rock Mech. Min. Sci., 2005（球面波应力-速度关系）
        - 罗章喜, 爆炸与冲击 1982, 3:34-40（光面爆破理论：冲击波使岩石切向受拉）
        - Wang X. et al., Processes 2023, 11(9):2805（σ_θ = −b·σ_r, b = ν/(1−ν)）
        - 梁瑞等, 高压物理学报 2022, 36(6):064202（裂隙区径向压力+切向拉力，Mises 判据）
        - 陶颂霖《爆破力学》，中南大学出版社（弹性波应力反演）

    :param ppv: (N,) PPV 数组(m/s)，来自 ppv_field_3d（已含 ×0.01 cm/s→m/s）。
        注意：应传**峰值包络**（peak_ppv_envelope_multi），不是瞬时振速 v(t)——
        否则应力场与振速场只差常数（两图相同）。
    :param rho: 岩体密度(kg/m³)，默认 2650（中硬岩）
    :param c_p: 纵波速度(m/s)，默认 4500
    :param nu: 泊松比，默认 0.25
    :param r: (N,) 各点到爆心距离(m)，近场几何修正用；None 或 near_field_radius<=0 时不施加
    :param near_field_radius: 近场交叉半径 r_nf(m)，由 compute_near_field_radius() 给出
    :param near_field_gain: 近场增益 A
    :return: dict，各字段均为 (N,) float32 数组，单位 Pa：
        sigma_rr   - 径向应力幅值（最大主应力 σ_1，压应力）
        sigma_theta- 切向拉应力幅值（σ_θθ = ν/(1−ν)·σ_rr，最小主应力 σ_3）
        sigma_vm   - von Mises 等效应力 = σ_rr/(1−ν)·F(r)
        sigma_1    - 最大主应力（= sigma_rr）
        sigma_3    - 最小主应力（= −sigma_theta，切向拉应力）
    """
    ppv = np.asarray(ppv, dtype=np.float32)
    # 近场几何放大 F(r) = 1 + gain·(r_nf/r)²（缺 r 或 r_nf<=0 → 不施加，退化为旧行为）
    nf = None
    if r is not None and float(near_field_radius) > 0.0:
        rr = np.maximum(np.asarray(r, dtype=np.float32), np.float32(0.5))
        gain = float(near_field_gain) if float(near_field_gain) > 0.0 else NEAR_FIELD_GAIN
        nf = (1.0 + gain * (float(near_field_radius) / rr) ** 2).astype(np.float32)
    # 径向应力 σ_rr = ρ·c_p·v_r · F(r)（Pa）；PPV 为标量峰值，方向沿径向
    sigma_rr = (rho * c_p * ppv).astype(np.float32)
    if nf is not None:
        sigma_rr = (sigma_rr * nf).astype(np.float32)
    # 切向拉应力幅值 σ_θθ = (ν/(1−ν))·σ_rr；ν=0.25 → 系数 0.333
    theta_factor = nu / (1.0 - nu)
    sigma_theta = (sigma_rr * theta_factor).astype(np.float32)
    # von Mises：σ_1=σ_rr, σ_2=σ_3=−σ_θθ（拉）→ σ_vm = |σ_rr + σ_θθ| = σ_rr/(1−ν)
    sigma_vm = (sigma_rr / (1.0 - nu)).astype(np.float32)
    return {
        'sigma_rr': sigma_rr,
        'sigma_theta': sigma_theta,
        'sigma_vm': sigma_vm,
        'sigma_1': sigma_rr,        # 最大主应力（径向压应力主导）
        'sigma_3': -sigma_theta     # 最小主应力（切向拉应力）
    }


def damage_zone_classify(ppv: np.ndarray,
                         thresholds: tuple = DAMAGE_THRESHOLDS_CMPS) -> np.ndarray:
    """基于 PPV 阈值划分岩体爆破损伤分区（Persson 模型）

    分区定义见模块级 DAMAGE_THRESHOLDS_CMPS（五档：elastic/micro_crack/
    crack_growth/fracture/throw）。阈值已按 P0-1 提高至 (20,50,100,200) cm/s，
    使损伤区收束到爆源邻近数米，避免解析场下出现"无视隧道轮廓的无穷大红圆"。

    :param ppv: (N,) PPV 数组(m/s)
    :param thresholds: (4,) 分区上界阈值(cm/s)，默认 DAMAGE_THRESHOLDS_CMPS
    :return: (N,) int8 数组，取值 0~4，对应 DAMAGE_ZONE_LABELS
    """
    ppv = np.asarray(ppv, dtype=np.float32)
    ppv_cmps = ppv * 100.0  # m/s → cm/s
    bins = np.asarray(thresholds, dtype=np.float32)
    # np.digitize: 返回 0(<bins[0]), 1([bins0,bins1)), ..., len(bins)(>=bins[-1])
    zones = np.digitize(ppv_cmps, bins).astype(np.int8)
    return zones


def tunnel_void_mask(grid_xyz: np.ndarray,
                     tunnel_width: float = 18.0,
                     tunnel_height: float = 15.0,
                     face_axis: str = 'z',
                     face_pos: float = 0.0) -> np.ndarray:
    """生成隧道已开挖空腔掩码（自由面/临空面所在空洞）

    爆破发生在掌子面（新临空面），已开挖隧道空腔沿轴向向"已采侧"延伸。为体现
    "隧道不是透明贴图、波场/应力/损伤不进入已开挖空腔"，把位于空腔范围内的网格点
    标记为 1（该处无岩体、无损伤、场值置 0）。

    网格局部坐标约定与 build_ppv_grid 一致：X=宽度，Y=高度，Z=轴向（前方为正）。
    坐标 face_axis=沿着轴向的轴，face_pos=掌子面位置；空腔位于 face_pos 之后
    （朝已开挖侧）。隧道断面简化为矩形 w×h（拱形隧道用宽度等效）。

    :param grid_xyz: (N,3) 网格点坐标
    :param tunnel_width: 隧道宽度(m)
    :param tunnel_height: 隧道高度(m)
    :param face_axis: 轴向轴名 'x'|'y'|'z'
    :param face_pos: 掌子面在该轴上的坐标（空腔位于该轴减小方向）
    :return: (N,) bool 掩码，True=位于空腔内
    """
    g = np.asarray(grid_xyz, dtype=np.float64)
    x, y, z = g[:, 0], g[:, 1], g[:, 2]
    hw, hh = tunnel_width * 0.5, tunnel_height * 0.5
    # 断面内：|横坐标| ≤ 半宽、竖直坐标居中 ± 半高（隧道竖直范围近似对称于 Y=0）
    in_face = (
        (np.abs(x) <= hw) &
        (np.abs(y) <= hh)
    )
    if face_axis == 'x':
        toward_void = z < face_pos
    elif face_axis == 'y':
        toward_void = x < face_pos
    else:
        toward_void = z < face_pos
    return in_face & toward_void


def damage_zone_field(grid_xyz: np.ndarray,
                      peak_ppv_mps: np.ndarray,
                      sources: Optional[List[dict]] = None,
                      blast_center: Optional[tuple] = None,
                      thresholds: tuple = DAMAGE_THRESHOLDS_CMPS,
                      max_radius: float = DAMAGE_MAX_RADIUS,
                      atten_tau: float = DAMAGE_ATTEN_TAU,
                      void_mask: Optional[np.ndarray] = None) -> np.ndarray:
    """带空间约束的损伤分区（P0-2：把损伤收束到隧道临空面附近）。

    解析近场用萨道夫斯基经验公式本身不适用（R→0 发散、无爆腔膨胀项），故在此对
    所需最大损伤半径做硬约束 + 平滑深度衰减，使损伤只沿隧道轮廓向外发展 5~10m，
    而非等向铺满整个计算域的红圆：

      1. 距最近爆源距离 r → 深度衰减系数 g(r)：r ≤ (max_radius−atten_tau) 内为 1，
     (max_radius−atten_tau)→max_radius 线性过渡到 0，r ≥ max_radius 后为 0
     ——max_radius 为**硬上限**（恰在 max_radius 处归零），超程一律 elastic。
       等效于把"参与损伤分区的有效 PPV"乘 g：越往外档位越低，超程归 elastic。
      2. 叠加隧道空腔掩码：空腔（已开挖洞身）内无岩体 → 一律归 0（elastic）。
      3. 复用升级后的 Persson 阈值分区（damage_zone_classify）。

    :param grid_xyz: (N,3) 网格点坐标
    :param peak_ppv_mps: (N,) 各点经历的最大 PPV(m/s)（或瞬时场，平坦化自理）
    :param sources: 爆源列表 [{pos, charge_kg, ...}]，缺省用 blast_center
    :param blast_center: 单爆心 (x,y,z)，sources 缺省时的爆源
    :param thresholds: (4,) PPV 阈值(cm/s)
    :param max_radius: 损伤区最大计算半径(m)（硬上限，恰在此处衰减到 0）
    :param atten_tau: 超过 (max_radius−atten_tau) 后平滑衰减到 0 的过渡宽度(m)
    :param void_mask: (N,) bool 隧道空腔掩码（可选）
    :return: (N,) int8 分区数组（同 damage_zone_classify）
    """
    g = np.asarray(grid_xyz, dtype=np.float64)
    ppv = np.asarray(peak_ppv_mps, dtype=np.float32).reshape(-1)
    n = g.shape[0]
    # 最近爆源距离 → 深度衰减系数（缺省无爆源约束时衰减系数恒为 1）
    if max_radius is not None and max_radius > 0:
        dmin = np.full(n, np.inf, dtype=np.float64)
        src_list = sources if sources else ([{'pos': list(blast_center)}] if blast_center is not None else [])
        for s in src_list:
            pos = np.asarray(s.get('pos', [0.0, 0.0, 0.0]), dtype=np.float64).reshape(1, 3)
            dmin = np.minimum(dmin, np.linalg.norm(g - pos, axis=1))
        g_r = np.where(np.isfinite(dmin), dmin, 0.0)
        tau = max(float(atten_tau), 1e-6)
        # 硬上限衰减：r ≤ (radius−tau) 为 1；→ radius 线性归 0；r ≥ radius 为 0
        atten = np.clip((max_radius - g_r) / tau, 0.0, 1.0).astype(np.float64)
    else:
        atten = np.ones(n, dtype=np.float64)
    ppv_eff = ppv * atten
    if void_mask is not None:
        ppv_eff = np.where(np.asarray(void_mask, dtype=bool), 0.0, ppv_eff)
    # 空腔/无效点（peak=0 或衰减=0）经 digitize 后自动落入 elastic 档
    return damage_zone_classify(ppv_eff, thresholds)


def _webgl_flatten_3d(field: np.ndarray, grid_shape: tuple) -> np.ndarray:
    """将 (N,) 一维场按 WebGL Data3DTexture 的 x-最快轴序展平

    grid_xyz 由 np.meshgrid(indexing='ij') 构建，ravel 后为 x-最慢、z-最快；
    而 WebGL Data3DTexture 期望 data[z*nx*ny + y*nx + x]（x-最快、z-最慢）。
    故 reshape 回 (nx,ny,nz) 再 transpose(2,1,0) → (nz,ny,nx)，使 x 在内存连续最快。

    :return: C-contiguous ndarray，形状 (nz, ny, nx)，可直接 tobytes
    """
    nx, ny, nz = grid_shape
    field_3d = field.reshape((nx, ny, nz))
    return np.ascontiguousarray(field_3d.transpose(2, 1, 0))


def pack_stress_binary(frame: int, t: float, grid_shape: tuple,
                       bounds_min: np.ndarray, bounds_max: np.ndarray,
                       sigma_vm: np.ndarray) -> bytes:
    """将应力场（von Mises 等效应力）打包为二进制帧（WebSocket send_bytes 推送）

    帧格式与 pack_ppv_binary 一致（45 字节头 + 载荷），仅 type_id=0x03：
        0     1    uint8   type_id = 0x03 (STRESS_FIELD)
        1     4    uint32  sim_frame
        5     4    float32 t
        9     12   3×uint32 grid_w/grid_h/grid_d
        21    24   6×float32 bounds_min(xyz) + bounds_max(xyz)
        45    N*4  float32[N] σ_vm 数组（Pa，x-最快轴序，N=grid_w*grid_h*grid_d）

    仅推送 σ_vm 单通道：它是损伤评估的核心指标，且前端可由
    σ_vm = σ_rr·(1−2ν)/(1−ν) 反推 σ_rr（ν 为已知岩体参数），无需重复推送。

    :param sigma_vm: (N,) von Mises 等效应力数组(Pa)，来自 stress_field_from_ppv
    :return: bytes 二进制帧
    """
    import struct
    nx, ny, nz = grid_shape
    header = struct.pack('>B I f I I I 6f',
                         0x03, frame, float(t),
                         nx, ny, nz,
                         float(bounds_min[0]), float(bounds_min[1]), float(bounds_min[2]),
                         float(bounds_max[0]), float(bounds_max[1]), float(bounds_max[2]))
    body = _webgl_flatten_3d(sigma_vm, grid_shape).astype('>f4').tobytes()
    return header + body


def pack_damage_binary(frame: int, t: float, grid_shape: tuple,
                       bounds_min: np.ndarray, bounds_max: np.ndarray,
                       zones: np.ndarray) -> bytes:
    """将损伤分区场打包为二进制帧（WebSocket send_bytes 推送）

    帧格式与 pack_ppv_binary 一致（45 字节头 + 载荷），仅 type_id=0x04：
        0     1    uint8   type_id = 0x04 (DAMAGE_FIELD)
        1     4    uint32  sim_frame
        5     4    float32 t
        9     12   3×uint32 grid_w/grid_h/grid_d
        21    24   6×float32 bounds_min(xyz) + bounds_max(xyz)
        45    N*1  int8[N] 分区 id（0~4，x-最快轴序，N=grid_w*grid_h*grid_d）

    损伤分区为 int8 单通道，带宽仅为 PPV/应力帧的 1/4。
    分区 id 含义见 damage_zone_classify 与 DAMAGE_ZONE_LABELS。

    :param zones: (N,) int8 分区数组，来自 damage_zone_classify
    :return: bytes 二进制帧
    """
    import struct
    nx, ny, nz = grid_shape
    header = struct.pack('>B I f I I I 6f',
                         0x04, frame, float(t),
                         nx, ny, nz,
                         float(bounds_min[0]), float(bounds_min[1]), float(bounds_min[2]),
                         float(bounds_max[0]), float(bounds_max[1]), float(bounds_max[2]))
    # int8 单字节，无字节序问题；轴序转 WebGL x-最快
    body = _webgl_flatten_3d(zones.astype(np.int8), grid_shape).tobytes()
    return header + body


# ─── JWL 爆腔源 + 3D 弹性波 FDTD（方案 B：完整波动方程数值解）──────────
# 物理链路：
#   JWL 状态方程 → 爆腔峰值压力 P0（CJ 压力量级，仅依赖炸药类型）
#   装药量 → 爆腔初始半径 R0 = (3·V_charge/(4π))^(1/3)
#   爆腔压力时程 P(t) = P0 · exp(-t/τ)，τ = R0/c_p（爆腔声学时间）
#   P(t) 作为爆腔区域(r<R0)的各向同性压力源项，喂给弹性波动方程
#   FDTD 同位网格简化求解器（2 阶中心差分 + 二阶扩散平滑）求解岩体中波场
#   输出 PPV = √(vx²+vy²+vz²)
#
# 理论依据：
#   - 同位网格显式有限差分通用方法（弹性波数值模拟）
#   - JWL 状态方程：Lee & Tarver, Phys. Fluids, 1980
#   - 弹性波方程：Aki & Richards《定量地震学》


class JWLBlastSource:
    """JWL 爆腔源：由 JWL 状态方程给出爆腔压力时程 P(t)

    P0 = jwl_pressure(V=1, explosive, charge_kg=None)：CJ 压力量级，
        仅依赖炸药类型（单位体积能量决定，与装药量无关）
    R0 = (3·V_charge/(4π))^(1/3)：装药量决定爆腔初始半径
    τ = R0/c_p：爆腔声学特征时间，P(t) 衰减时间常数

    P(t) = P0 · exp(-t/τ) · H(t)，物理近似：爆气绝热膨胀驱动爆腔壁，
    压力随爆腔膨胀按指数衰减。
    """

    EXPLOSIVE_DENSITY = {"emulsion": 1100.0, "anfo": 800.0, "dynamite": 1400.0}

    def __init__(self, charge_kg: float, explosive_type: str = "emulsion"):
        if charge_kg <= 0:
            raise ValueError(f"charge_kg 必须 > 0，得到 {charge_kg}")
        self.charge_kg = charge_kg
        self.explosive_type = explosive_type
        self._rho_explosive = self.EXPLOSIVE_DENSITY.get(explosive_type, 1000.0)
        self._v_charge = charge_kg / self._rho_explosive
        # 爆腔初始半径(m)
        self.cavity_radius = (3.0 * self._v_charge / (4.0 * np.pi)) ** (1.0 / 3.0)
        # JWL 峰值压力(Pa)：charge_kg=None 取单位体积 CJ 压力（不缩放）
        self.peak_pressure = jwl_pressure(1.0, explosive_type, None)

    def characteristic_time(self, c_p: float = 4500.0) -> float:
        """爆腔声学特征时间 τ = R0/c_p"""
        return self.cavity_radius / max(c_p, 1.0)

    def pressure_at(self, t: float, c_p: float = 4500.0) -> float:
        """爆腔压力时程 P(t) = P0 · exp(-t/τ) · H(t)"""
        if t < 0:
            return 0.0
        tau = self.characteristic_time(c_p)
        return self.peak_pressure * np.exp(-t / max(tau, 1e-9))


if _HAS_NUMBA:
    @njit(nogil=True, cache=True, fastmath=True, parallel=True)
    def _fdtd_step_numba(vx, vy, vz,
                         sxx, syy, szz, sxy, sxz, syz,
                         damp,
                         ax, ay, az,               # 复用 scratch（加速度）
                         inj, delay, p0, tau,      # inj:(nsrc,nx,ny,nz) f32
                         lam, mu, rho, dt, h, qv,
                         n_sub, t_start):
        """推进 n_sub 个子步（原地修改状态场），返回最终 sim_time。

        数值逻辑与 ElasticWaveFDTD3D 原 Python/NumPy 实现逐项等价：
        中心差分仅内部点非 0（边界视为 0），速度读旧场做人工粘性后再更新，
        应力读阻尼后速度，源注入先于应力海绵阻尼。标量源系数用 float64 算 exp。
        """
        nx, ny, nz = vx.shape
        nsrc = inj.shape[0]
        inv2h = 1.0 / (2.0 * h)
        inv_rho = 1.0 / rho
        qvh2 = qv / (h * h)
        t = t_start
        coef = np.empty(nsrc, np.float64)
        for _sub in range(n_sub):
            # 多源注入系数（随当前 t 指数衰减；delay 未到置 0）
            for s in range(nsrc):
                lt = t - delay[s]
                if lt < 0.0:
                    coef[s] = 0.0
                else:
                    coef[s] = dt * p0[s] * math.exp(-lt / tau[s])
            # pass A1：三向加速度 = div(σ)/ρ + qv·∇²v/ρ 等价式（读旧 v/σ）
            for i in prange(nx):
                for j in range(ny):
                    for k in range(nz):
                        # x 分量
                        dv = 0.0
                        if i > 0 and i < nx - 1:
                            dv += sxx[i + 1, j, k] - sxx[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            dv += sxy[i, j + 1, k] - sxy[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            dv += sxz[i, j, k + 1] - sxz[i, j, k - 1]
                        lap = 0.0
                        if i > 0 and i < nx - 1:
                            lap += vx[i + 1, j, k] - 2.0 * vx[i, j, k] + vx[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            lap += vx[i, j + 1, k] - 2.0 * vx[i, j, k] + vx[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            lap += vx[i, j, k + 1] - 2.0 * vx[i, j, k] + vx[i, j, k - 1]
                        ax[i, j, k] = dv * inv2h * inv_rho + lap * qvh2
                        # y 分量
                        dv = 0.0
                        if i > 0 and i < nx - 1:
                            dv += sxy[i + 1, j, k] - sxy[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            dv += syy[i, j + 1, k] - syy[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            dv += syz[i, j, k + 1] - syz[i, j, k - 1]
                        lap = 0.0
                        if i > 0 and i < nx - 1:
                            lap += vy[i + 1, j, k] - 2.0 * vy[i, j, k] + vy[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            lap += vy[i, j + 1, k] - 2.0 * vy[i, j, k] + vy[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            lap += vy[i, j, k + 1] - 2.0 * vy[i, j, k] + vy[i, j, k - 1]
                        ay[i, j, k] = dv * inv2h * inv_rho + lap * qvh2
                        # z 分量
                        dv = 0.0
                        if i > 0 and i < nx - 1:
                            dv += sxz[i + 1, j, k] - sxz[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            dv += syz[i, j + 1, k] - syz[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            dv += szz[i, j, k + 1] - szz[i, j, k - 1]
                        lap = 0.0
                        if i > 0 and i < nx - 1:
                            lap += vz[i + 1, j, k] - 2.0 * vz[i, j, k] + vz[i - 1, j, k]
                        if j > 0 and j < ny - 1:
                            lap += vz[i, j + 1, k] - 2.0 * vz[i, j, k] + vz[i, j - 1, k]
                        if k > 0 and k < nz - 1:
                            lap += vz[i, j, k + 1] - 2.0 * vz[i, j, k] + vz[i, j, k - 1]
                        az[i, j, k] = dv * inv2h * inv_rho + lap * qvh2
            # pass A2：应用速度更新 + 海绵吸收层阻尼
            for i in prange(nx):
                for j in range(ny):
                    for k in range(nz):
                        d = damp[i, j, k]
                        vx[i, j, k] = (vx[i, j, k] + dt * ax[i, j, k]) * d
                        vy[i, j, k] = (vy[i, j, k] + dt * ay[i, j, k]) * d
                        vz[i, j, k] = (vz[i, j, k] + dt * az[i, j, k]) * d
            # pass B：应变率→应力 + 源注入 + 海绵阻尼（读阻尼后速度）
            for i in prange(nx):
                for j in range(ny):
                    for k in range(nz):
                        exx = 0.0
                        if i > 0 and i < nx - 1:
                            exx += (vx[i + 1, j, k] - vx[i - 1, j, k]) * inv2h
                        eyy = 0.0
                        if j > 0 and j < ny - 1:
                            eyy += (vy[i, j + 1, k] - vy[i, j - 1, k]) * inv2h
                        ezz = 0.0
                        if k > 0 and k < nz - 1:
                            ezz += (vz[i, j, k + 1] - vz[i, j, k - 1]) * inv2h
                        tr = exx + eyy + ezz
                        # 该胞元受所有已起爆源的压应力叠加
                        src = 0.0
                        for s in range(nsrc):
                            src += coef[s] * inj[s, i, j, k]
                        d = damp[i, j, k]
                        sxx[i, j, k] = (sxx[i, j, k] + dt * (lam * tr + 2.0 * mu * exx) - src) * d
                        syy[i, j, k] = (syy[i, j, k] + dt * (lam * tr + 2.0 * mu * eyy) - src) * d
                        szz[i, j, k] = (szz[i, j, k] + dt * (lam * tr + 2.0 * mu * ezz) - src) * d
                        # 剪应力：sxy=μ(dvy/dx+dvx/dy) 等
                        exy = 0.0
                        if i > 0 and i < nx - 1:
                            exy += (vy[i + 1, j, k] - vy[i - 1, j, k]) * inv2h
                        if j > 0 and j < ny - 1:
                            exy += (vx[i, j + 1, k] - vx[i, j - 1, k]) * inv2h
                        sxy[i, j, k] = (sxy[i, j, k] + dt * mu * exy) * d
                        exz = 0.0
                        if i > 0 and i < nx - 1:
                            exz += (vz[i + 1, j, k] - vz[i - 1, j, k]) * inv2h
                        if k > 0 and k < nz - 1:
                            exz += (vx[i, j, k + 1] - vx[i, j, k - 1]) * inv2h
                        sxz[i, j, k] = (sxz[i, j, k] + dt * mu * exz) * d
                        eyz = 0.0
                        if j > 0 and j < ny - 1:
                            eyz += (vz[i, j + 1, k] - vz[i, j - 1, k]) * inv2h
                        if k > 0 and k < nz - 1:
                            eyz += (vy[i, j, k + 1] - vy[i, j, k - 1]) * inv2h
                        syz[i, j, k] = (syz[i, j, k] + dt * mu * eyz) * d
            t += dt
        return t


def _ensure_numba_warm():
    """进程内首次以微型形状触发内核编译（cache=True，避免流式首帧卡编译）"""
    global _NJT_WARMED
    if not _HAS_NUMBA or _NJT_WARMED:
        return
    _NJT_WARMED = True
    try:
        n = 4
        z = np.zeros((n, n, n), np.float32)
        o = np.ones((n, n, n), np.float32)
        inj = np.zeros((1, n, n, n), np.float32)
        z1 = np.zeros((1,), np.float64)
        o1 = np.ones((1,), np.float64)
        _fdtd_step_numba(z, z, z, z, z, z, z, z, z,
                         o, z, z, z, inj, z1, o1, o1,
                         1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
                         0, 0.0)
    except Exception:  # 预热失败不影响后续（走 numpy 回退或下次再编译）
        pass


class ElasticWaveFDTD3D:
    """3D 弹性波同位网格简化求解器（co-located grid FDTD）

    状态：v=(vx,vy,vz), σ=(σxx,σyy,σzz,σxy,σxz,σyz)
    方程（各向同性弹性介质）：
        ρ·∂vi/∂t = ∂σij/∂xj
        ∂σij/∂t = λ·δij·(∂vk/∂xk) + μ·(∂vi/∂xj + ∂vj/∂xi)
    空间差分：2 阶中心差分（同位网格，co-located grid）
    稳定化：二阶扩散平滑（Laplacian smoothing），用于抑制同位网格的奇偶解耦合倾向
    边界：简化海绵吸收层（sponge layer），在边界 N_pml 层内对场施加乘性衰减因子

    时间步进：显式 Euler
    CFL：dt < dx / (c_p·√3)

    理论：同位网格显式有限差分通用方法（参见 Aki & Richards《定量地震学》等弹性波数值方法参考）
    """

    def __init__(self, grid_xyz: np.ndarray, bounds_min: np.ndarray,
                 bounds_max: np.ndarray, grid_shape: tuple,
                 source: JWLBlastSource, rock: RockMedium = RockMedium(),
                 n_pml: int = 4,
                 blast_center: Optional[np.ndarray] = None,
                 sources: Optional[list] = None):
        self.grid_shape = grid_shape
        nx, ny, nz = grid_shape
        self.nx, self.ny, self.nz = nx, ny, nz
        self.bounds_min = bounds_min
        self.bounds_max = bounds_max
        self.source = source
        self.rock = rock

        # 网格间距（build_ppv_grid 各轴等分辨率 linspace）
        dx = (bounds_max[0] - bounds_min[0]) / max(nx - 1, 1)
        dy = (bounds_max[1] - bounds_min[1]) / max(ny - 1, 1)
        dz = (bounds_max[2] - bounds_min[2]) / max(nz - 1, 1)
        self.dx = float(dx)
        # 各向同性假设：取三轴平均（build_ppv_grid 理论上相等）
        if not (abs(dx - dy) < 0.01 * dx and abs(dx - dz) < 0.01 * dx):
            # 网格非各向同性时取 dx（build_ppv_grid 默认各轴等分辨率，此分支极少触发）
            pass
        self.h = float(dx)

        # 弹性模量
        self.rho = float(rock.density)
        self.cp = float(rock.p_wave_speed)
        self.cs = float(rock.s_wave_speed)
        # λ, μ 由 c_p, c_s, ρ 反演：μ=ρ·cs²，λ=ρ·cp² - 2μ
        self.mu = self.rho * self.cs ** 2
        self.lam = self.rho * self.cp ** 2 - 2.0 * self.mu

        # CFL 稳定时间步
        self.dt = 0.9 * self.h / (self.cp * np.sqrt(3.0))
        # A2：显式 CFL 断言，防止回归破坏稳定性
        #   3D 弹性波同位网格 FDTD 的 CFL 条件：dt < h / (c_p·√3)
        assert self.dt < self.h / (self.cp * np.sqrt(3.0)), (
            f"CFL 条件被破坏：dt={self.dt} ≥ h/(cp·√3)={self.h / (self.cp * np.sqrt(3.0))}"
        )
        # 源位置：爆心 = 掏槽孔质心（坐标由前端 WS 下发，缺省网格原点，与 build_ppv_grid 一致）
        if blast_center is not None:
            self.blast_center = np.asarray(blast_center, dtype=np.float32).reshape(3)
        else:
            self.blast_center = np.array([0.0, 0.0, 0.0], dtype=np.float32)

        # 多/单爆腔源：为每个源独立建腔体掩膜
        # A4：多装药源支持 —— sources=[{'source':JWLBlastSource,'pos':(x,y,z),'delay':秒}]
        # 对应真实爆破各炮孔装药段不同位置、不同起爆延时的应力波叠加。每个源单独
        # 计算爆腔掩膜、src_scale 与延时；仅传单 source（缺省）时退化为单源（delay=0）。
        # 孔位以**装药段中心**为源点（democour width 楔形掏槽孔底向核心收敛），
        # 使 JWL 压力从真实布孔位置发射，多源球面波在岩体内干涉叠加（非单一同心圆）。
        self.source = source
        self._multi_sources: list[dict] = []
        if sources and len(sources) > 0:
            for s in sources:
                s_src = s.get('source', source)
                s_pos = np.asarray(s.get('pos', self.blast_center), dtype=np.float32).reshape(3)
                s_delay = float(s.get('delay', 0.0))
                r = np.linalg.norm(grid_xyz - s_pos, axis=1)
                mask = (r < s_src.cavity_radius).reshape(grid_shape).astype(np.float32)
                if not mask.any():
                    idx = int(np.argmin(r))
                    mask = np.zeros(grid_shape, dtype=np.float32)
                    mask[np.unravel_index(idx, grid_shape)] = 1.0
                cavity_vol = 4.0 / 3.0 * np.pi * s_src.cavity_radius ** 3
                n_cell = max(int(mask.sum()), 1)
                self._multi_sources.append({
                    'source': s_src,
                    'delay': s_delay,
                    'mask': mask,
                    'src_scale': cavity_vol / (n_cell * self.h ** 0.75)
                })
            self._cavity_volume = sum(
                4.0 / 3.0 * np.pi * s['source'].cavity_radius ** 3 for s in self._multi_sources
            )
        else:
            r = np.linalg.norm(grid_xyz - self.blast_center, axis=1)
            mask = (r < source.cavity_radius).reshape(grid_shape).astype(np.float32)
            if not mask.any():
                idx = int(np.argmin(r))
                mask = np.zeros(grid_shape, dtype=np.float32)
                mask[np.unravel_index(idx, grid_shape)] = 1.0
            cavity_vol = 4.0 / 3.0 * np.pi * source.cavity_radius ** 3
            n_cell = max(int(mask.sum()), 1)
            self._multi_sources.append({
                'source': source,
                'delay': 0.0,
                'mask': mask,
                'src_scale': cavity_vol / (n_cell * self.h ** 0.75)
            })
            self._cavity_volume = cavity_vol

        # A2：爆腔源体积等效归一化（改进点源，使源强度不随网格分辨率变化）
        #   原实现把全压 P(t) 施加到 cavity_mask 内每个胞元，源总强度 ∝ 覆盖胞元数，
        #   网格加密时源总强度随胞元数增长，导致峰值 PPV 对网格分辨率敏感。
        #
        #   物理基础（体积守恒）：爆腔源的总强度应正比于爆腔体积 V_cavity、
        #   平均分配到覆盖的 n_cavity_cells 个胞元。源强度 = P(t) × V_cavity/n，
        #   即每个胞元乘 src_scale = V_cavity / (n_cavity_cells·h³)（V_cell = h³）。
        #   量纲：V_cavity/(n·V_cell) 无量纲，src_term 仍为 Pa。
        #
        #   数值收敛修正（经验指数）：本求解器为 2 阶空间差分的简化同位网格 FDTD，
        #   且爆腔 R0 远小于生产网格间距 h，属于"欠解析点源"情形，
        #   离散源响应对网格分辨率存在系统性偏差，故用 src_scale = V_cavity/(n_cell·h^0.75)
        #   的 h^+2.25 经验修正（多源下逐源独立计算，不共享）。
        # 向后兼容：单源掩膜/归一化系数别名（外部/测试仍引用 cavity_mask、_src_scale）
        self.cavity_mask = self._multi_sources[0]['mask']
        self._src_scale = self._multi_sources[0]['src_scale']

        # 数值内核加速（numba）预合成源注入：逐源 mask·src_scale 堆叠 + 各源
        # delay/峰值压力/特征时间并行数组；内核按当前 t 指数衰减逐源注入。
        # （纯 NumPy 回退仍遍历 self._multi_sources 原样计算，二者数值等价）
        if _HAS_NUMBA:
            nsrc = len(self._multi_sources)
            inj = np.zeros((nsrc, self.nx, self.ny, self.nz), dtype=np.float32)
            delay = np.zeros((nsrc,), dtype=np.float64)
            p0 = np.zeros((nsrc,), dtype=np.float64)
            tau = np.zeros((nsrc,), dtype=np.float64)
            for s_i, m in enumerate(self._multi_sources):
                inj[s_i] = m['mask'] * m['src_scale']
                delay[s_i] = m['delay']
                p0[s_i] = m['source'].peak_pressure
                tau[s_i] = m['source'].characteristic_time(self.cp)
            self._src_inj = np.ascontiguousarray(inj)
            self._src_delay = np.ascontiguousarray(delay)
            self._src_p0 = np.ascontiguousarray(p0)
            self._src_tau = np.ascontiguousarray(tau)
            # numba 内核复用 scratch（三向加速度），避免每子步分配
            self._k_ax = np.empty((self.nx, self.ny, self.nz), dtype=np.float32)
            self._k_ay = np.empty((self.nx, self.ny, self.nz), dtype=np.float32)
            self._k_az = np.empty((self.nx, self.ny, self.nz), dtype=np.float32)
        else:
            self._src_inj = None
            self._src_delay = None
            self._src_p0 = None
            self._src_tau = None
            self._k_ax = None
            self._k_ay = None
            self._k_az = None
        self._np_buf = None

        # 阻尼吸收层（简化海绵层）
        self.damp = self._build_damping_field(n_pml)

        # 状态场（同位网格，全部 (nx,ny,nz)）
        self.vx = np.zeros(grid_shape, dtype=np.float32)
        self.vy = np.zeros(grid_shape, dtype=np.float32)
        self.vz = np.zeros(grid_shape, dtype=np.float32)
        self.sxx = np.zeros(grid_shape, dtype=np.float32)
        self.syy = np.zeros(grid_shape, dtype=np.float32)
        self.szz = np.zeros(grid_shape, dtype=np.float32)
        self.sxy = np.zeros(grid_shape, dtype=np.float32)
        self.sxz = np.zeros(grid_shape, dtype=np.float32)
        self.syz = np.zeros(grid_shape, dtype=np.float32)

        self.sim_time = 0.0

    def _build_damping_field(self, n_pml: int) -> np.ndarray:
        """构建简化海绵吸收层（sponge layer）：在边界 N_pml 层内对场施加乘性衰减因子

        边界层内对场乘 (1 - d)，d 在边界最大、向内递减，内部为 1.0。
        d_max 取 0.15/步（经验值，足够吸收且不过度反射）。
        """
        nx, ny, nz = self.grid_shape
        damp = np.ones((nx, ny, nz), dtype=np.float32)
        d_max = 0.15
        for i in range(n_pml):
            factor = 1.0 - d_max * ((n_pml - i) / n_pml) ** 2
            # x 边界
            damp[i, :, :] = np.minimum(damp[i, :, :], factor)
            damp[-(i + 1), :, :] = np.minimum(damp[-(i + 1), :, :], factor)
            # y 边界
            damp[:, i, :] = np.minimum(damp[:, i, :], factor)
            damp[:, -(i + 1), :] = np.minimum(damp[:, -(i + 1), :], factor)
            # z 边界
            damp[:, :, i] = np.minimum(damp[:, :, i], factor)
            damp[:, :, -(i + 1)] = np.minimum(damp[:, :, -(i + 1)], factor)
        return damp

    def _step_numpy(self, n_substeps: int = 1):
        """纯 NumPy 推进（无 numba 环境回退），数值与 _fdtd_step_numba 等价。

        相比逐子步 zeros_like 的早期实现，预分配缓冲并按子步原位复用，
        消除每子步约 30 次整数组分配。该路径仅在 numba 不可用时启用。
        """
        q_visc = 0.02
        if self._np_buf is None:
            shp = self.vx.shape
            mk = lambda: np.zeros(shp, dtype=np.float32)
            self._np_buf = {
                'ax': mk(), 'ay': mk(), 'az': mk(), 'lap': mk(),
                'exx': mk(), 'eyy': mk(), 'ezz': mk(), 'tr': mk(), 'sh': mk(),
            }
        b = self._np_buf
        ax, ay, az, lap = b['ax'], b['ay'], b['az'], b['lap']
        exx, eyy, ezz, tr, sh = b['exx'], b['eyy'], b['ezz'], b['tr'], b['sh']
        dt, rho = self.dt, self.rho
        lam, mu, h = self.lam, self.mu, self.h
        inv2h = 1.0 / (2.0 * h)
        inv_rho = 1.0 / rho
        qvh2 = q_visc / (h * h)
        damp = self.damp
        vx, vy, vz = self.vx, self.vy, self.vz
        sxx, syy, szz = self.sxx, self.syy, self.szz
        sxy, sxz, syz = self.sxy, self.sxz, self.syz
        sources = self._multi_sources
        cp = self.cp

        for _ in range(n_substeps):
            t = self.sim_time
            # 1) 速度加速度（σ 散度 + 旧 v 人工粘性 Laplacian），写入 scratch
            ax[:] = 0.0
            ax[1:-1, :, :] = sxx[2:, :, :] - sxx[:-2, :, :]
            ax[:, 1:-1, :] += sxy[:, 2:, :] - sxy[:, :-2, :]
            ax[:, :, 1:-1] += sxz[:, :, 2:] - sxz[:, :, :-2]
            lap[:] = 0.0
            lap[1:-1, :, :] = vx[2:, :, :] - 2.0 * vx[1:-1, :, :] + vx[:-2, :, :]
            lap[:, 1:-1, :] += vx[:, 2:, :] - 2.0 * vx[:, 1:-1, :] + vx[:, :-2, :]
            lap[:, :, 1:-1] += vx[:, :, 2:] - 2.0 * vx[:, :, 1:-1] + vx[:, :, :-2]
            ax *= inv2h * inv_rho
            ax += lap * qvh2
            vx += dt * ax
            vx *= damp
            ay[:] = 0.0
            ay[1:-1, :, :] = sxy[2:, :, :] - sxy[:-2, :, :]
            ay[:, 1:-1, :] += syy[:, 2:, :] - syy[:, :-2, :]
            ay[:, :, 1:-1] += syz[:, :, 2:] - syz[:, :, :-2]
            lap[:] = 0.0
            lap[1:-1, :, :] = vy[2:, :, :] - 2.0 * vy[1:-1, :, :] + vy[:-2, :, :]
            lap[:, 1:-1, :] += vy[:, 2:, :] - 2.0 * vy[:, 1:-1, :] + vy[:, :-2, :]
            lap[:, :, 1:-1] += vy[:, :, 2:] - 2.0 * vy[:, :, 1:-1] + vy[:, :, :-2]
            ay *= inv2h * inv_rho
            ay += lap * qvh2
            vy += dt * ay
            vy *= damp
            az[:] = 0.0
            az[1:-1, :, :] = sxz[2:, :, :] - sxz[:-2, :, :]
            az[:, 1:-1, :] += syz[:, 2:, :] - syz[:, :-2, :]
            az[:, :, 1:-1] += szz[:, :, 2:] - szz[:, :, :-2]
            lap[:] = 0.0
            lap[1:-1, :, :] = vz[2:, :, :] - 2.0 * vz[1:-1, :, :] + vz[:-2, :, :]
            lap[:, 1:-1, :] += vz[:, 2:, :] - 2.0 * vz[:, 1:-1, :] + vz[:, :-2, :]
            lap[:, :, 1:-1] += vz[:, :, 2:] - 2.0 * vz[:, :, 1:-1] + vz[:, :, :-2]
            az *= inv2h * inv_rho
            az += lap * qvh2
            vz += dt * az
            vz *= damp

            # 2) 应变率→应力 + 爆腔源 + 海绵阻尼（读阻尼后速度）
            exx[:] = 0.0
            exx[1:-1, :, :] = (vx[2:, :, :] - vx[:-2, :, :]) * inv2h
            eyy[:] = 0.0
            eyy[:, 1:-1, :] = (vy[:, 2:, :] - vy[:, :-2, :]) * inv2h
            ezz[:] = 0.0
            ezz[:, :, 1:-1] = (vz[:, :, 2:] - vz[:, :, :-2]) * inv2h
            tr[:] = exx + eyy + ezz
            sxx += dt * (lam * tr + 2.0 * mu * exx)
            syy += dt * (lam * tr + 2.0 * mu * eyy)
            szz += dt * (lam * tr + 2.0 * mu * ezz)
            for s_src in sources:
                local_t = t - s_src['delay']
                if local_t < 0.0:
                    continue
                p_src = s_src['source'].pressure_at(local_t, cp)
                src_term = dt * p_src * s_src['mask'] * s_src['src_scale']
                sxx -= src_term
                syy -= src_term
                szz -= src_term
            sh[:] = 0.0
            sh[1:-1, :, :] = (vy[2:, :, :] - vy[:-2, :, :]) * inv2h       # dvy/dx
            sh[:, 1:-1, :] += (vx[:, 2:, :] - vx[:, :-2, :]) * inv2h      # dvx/dy
            sxy += dt * mu * sh
            sh[:] = 0.0
            sh[1:-1, :, :] = (vz[2:, :, :] - vz[:-2, :, :]) * inv2h       # dvz/dx
            sh[:, :, 1:-1] += (vx[:, :, 2:] - vx[:, :, :-2]) * inv2h      # dvx/dz
            sxz += dt * mu * sh
            sh[:] = 0.0
            sh[:, 1:-1, :] = (vz[:, 2:, :] - vz[:, :-2, :]) * inv2h       # dvz/dy
            sh[:, :, 1:-1] += (vy[:, :, 2:] - vy[:, :, :-2]) * inv2h      # dvy/dz
            syz += dt * mu * sh
            sxx *= damp
            syy *= damp
            szz *= damp
            sxy *= damp
            sxz *= damp
            syz *= damp
            self.sim_time += dt

    def step(self, n_substeps: int = 1):
        """推进 n_substeps 个 FDTD 子步

        每个子步：
          1. 速度更新：v += (dt/ρ) · div(σ)
          2. 应力更新：σ += dt · (λ·tr(ε̇)·I + 2μ·ε̇)
          3. 爆腔源：σxx/σyy/σzz -= dt · P(t) · cavity_mask（压应力）
          4. 人工粘性 + 海绵吸收层阻尼

        numba 可用时走 _fdtd_step_numba 编译内核（等价逻辑、C 级单循环），
        否则回退 _step_numpy（复用缓冲的纯 NumPy 路径）。
        """
        if _HAS_NUMBA and self._src_inj is not None:
            self.sim_time = _fdtd_step_numba(
                self.vx, self.vy, self.vz,
                self.sxx, self.syy, self.szz, self.sxy, self.sxz, self.syz,
                self.damp,
                self._k_ax, self._k_ay, self._k_az,
                self._src_inj, self._src_delay, self._src_p0, self._src_tau,
                self.lam, self.mu, self.rho, self.dt, self.h, 0.02,
                n_substeps, self.sim_time,
            )
        else:
            self._step_numpy(n_substeps)

    def get_ppv(self) -> np.ndarray:
        """当前时刻 PPV = √(vx²+vy²+vz²)，单位 m/s"""
        ppv = np.sqrt(self.vx ** 2 + self.vy ** 2 + self.vz ** 2)
        return ppv.astype(np.float32)

    def get_velocity(self) -> tuple:
        """返回 (vx, vy, vz) 三向速度场"""
        return self.vx, self.vy, self.vz

    def get_sigma_vm(self) -> np.ndarray:
        """由完整应力张量直接计算 von Mises 等效应力场（Pa，float32）

        σ_vm = √( ½[(σxx−σyy)² + (σyy−σzz)² + (σzz−σxx)²] + 3(σxy² + σxz² + σyz²) )

        相比由 PPV 标量反演的一阶近似，本方法保留应力张量各分量的空间分布
        （径向压缩 + 切向受拉的真实波场耦合），近场/爆腔附近的应力集中、
        波前极性均能如实呈现，是爆破应力场的数值解级输出。
        依据：von Mises 屈服准则（Boresi et al.，标准连续介质力学）。
        """
        sx, sy, sz, txy, txz, tyz = self.sxx, self.syy, self.szz, self.sxy, self.sxz, self.syz
        dev = 0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2)
        shear = 3.0 * (txy ** 2 + txz ** 2 + tyz ** 2)
        return np.sqrt(dev + shear).astype(np.float32)


def ppv_field_3d_fdtd(grid_xyz: np.ndarray, blast_center: np.ndarray,
                      charge_kg: float, explosive_type: str = "emulsion",
                      rock: RockMedium = RockMedium(),
                      grid_shape: Optional[tuple] = None,
                      sim_time: float = 0.0,
                      n_substeps: int = 0,
                      engine: Optional[ElasticWaveFDTD3D] = None
                      ) -> tuple:
    """3D 弹性波 FDTD 振动场计算（JWL 爆腔源 + 速度-应力格式）

    有状态模式（推荐，供 _stream_loop 增量推进）：
        传入 engine 实例，调用 engine.step(n_substeps) 后返回 engine.get_ppv()
    无状态模式（单次快照，仅用于测试/离线）：
        不传 engine，须显式传入 grid_shape（A3 修复），内部创建并推进 sim_time/dt 个子步

    :param engine: 复用的 FDTD 引擎实例（流式推送时传入避免重建）
    :param grid_shape: 无状态模式必需的网格形状 (nx, ny, nz)（A3 修复：
        原实现用 n^(1/3) 平方根估算推断 (nx,nx,nx)，对非立方网格（如 27×21×25）
        静默产生错误形状。现强制显式传入并强校验 grid_xyz.shape[0] == prod(grid_shape)，
        不传或形状不匹配时明确报错，不再静默近似。）
    :param sim_time: 目标模拟时间(s)，无状态模式下推进到此时刻
    :param n_substeps: 有状态模式下推进的子步数（= timestep/dt）
    :return: (ppv_mps, engine) —— ppv 单位 m/s，engine 为新建或复用的引擎
    """
    if engine is None:
        # 无状态模式：创建引擎并推进到 sim_time
        if grid_shape is None:
            raise ValueError(
                "无状态模式必须显式传入 grid_shape（如 build_ppv_grid 返回的 (nx, ny, nz)）；"
                "不再支持从 grid_xyz 用 n^(1/3) 立方近似推断（对非立方网格会静默出错）。"
            )
        if grid_xyz.shape[0] != int(np.prod(grid_shape)):
            raise ValueError(
                f"grid_xyz.shape[0]={grid_xyz.shape[0]} 与 prod(grid_shape)={int(np.prod(grid_shape))} "
                f"不一致（grid_shape={grid_shape}）"
            )
        source = JWLBlastSource(charge_kg, explosive_type)
        bounds_min = np.array([grid_xyz[:, 0].min(), grid_xyz[:, 1].min(), grid_xyz[:, 2].min()], dtype=np.float32)
        bounds_max = np.array([grid_xyz[:, 0].max(), grid_xyz[:, 1].max(), grid_xyz[:, 2].max()], dtype=np.float32)
        engine = ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape, source, rock,
                                   blast_center=blast_center)
        n_sub = max(1, int(sim_time / engine.dt))
        engine.step(n_sub)
    else:
        # 有状态模式：推进指定子步数
        if n_substeps > 0:
            engine.step(n_substeps)
    return engine.get_ppv(), engine


def make_fdtd_engine(grid_xyz: np.ndarray, grid_shape: tuple,
                     bounds_min: np.ndarray, bounds_max: np.ndarray,
                     charge_kg: float, explosive_type: str = "emulsion",
                     rock: RockMedium = RockMedium(),
                     blast_center: Optional[np.ndarray] = None,
                     sources: Optional[list] = None) -> ElasticWaveFDTD3D:
    """工厂函数：创建 FDTD 引擎（供 blasting_ws StreamState 复用）

    与 ppv_field_3d_fdtd 不同，本函数不推进时间，仅返回引擎实例。
    调用方负责 step() 与 get_ppv()。

    :param sources: 多装药源 [{x,y,z,chargeKg,delayMs}] —— 每个炮孔装药段作为独立
        JWL 爆腔源，按 delayMs 延时起爆，实现多应力波叠加(JWL 数值解级波场干涉)。
        缺省时退化为单源（charge_kg 于 blast_center，delay=0）。
    """
    if sources and len(sources) > 0:
        jwl_sources = []
        for s in sources:
            q = float(s.get('charge_kg') or s.get('chargeKg') or 0)
            if q <= 0:
                continue
            jwl_sources.append({
                'source': JWLBlastSource(q, explosive_type),
                'pos': [
                    float(s.get('x') or s.get('posX') or 0),
                    float(s.get('y') or s.get('posY') or 0),
                    float(s.get('z') or s.get('posZ') or 0),
                ],
                'delay': float(s.get('delay_ms') or s.get('delayMs') or 0) / 1000.0,
            })
        if jwl_sources:
            engine = ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape,
                                       jwl_sources[0]['source'], rock,
                                       blast_center=blast_center, sources=jwl_sources)
            _ensure_numba_warm()
            return engine
    source = JWLBlastSource(charge_kg, explosive_type)
    engine = ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape, source, rock,
                               blast_center=blast_center)
    _ensure_numba_warm()
    return engine

