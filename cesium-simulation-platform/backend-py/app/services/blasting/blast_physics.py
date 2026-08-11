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


def sadosky_vibration(charge_kg: float, distance: float, rock: RockMedium = RockMedium()) -> float:
    """萨道夫斯基经验公式计算峰值振动速度
    
    v = K * (Q^(1/3) / R)^alpha
    
    K: 场地常数(50~400), alpha: 衰减指数(1.0~2.0)
    """
    K = 200  # 中硬岩场地常数
    alpha = 1.5  # 衰减指数
    if distance < 0.1:
        return K
    return K * (charge_kg ** (1/3) / distance) ** alpha


def jwl_pressure(relative_volume: float, explosive_type: str = "emulsion",
                 charge_kg: Optional[float] = None) -> float:
    """JWL状态方程计算爆生气压力

    P = A*(1 - w/(R1*V))*exp(-R1*V) + B*(1 - w/(R2*V))*exp(-R2*V) + w*E0/V

    V: 相对体积, E0: 初始内能（单位体积）
    charge_kg: 装药量(kg)，提供时按炸药密度换算装药体积并缩放总能量
               E_total = E0 * V_charge，V_charge = mass / rho_explosive
               不提供时退化为原始归一化形式（E0 单位体积内能）
    """
    # JWL 参数（A/B/R1/R2/w 为炸药固有属性；E0 为单位体积初始内能）
    params = {
        "emulsion": {"A": 3.7377e11, "B": 3.747e9, "R1": 4.15, "R2": 0.9, "w": 0.35, "E0": 3.9e9},
        "anfo": {"A": 4.946e11, "B": 1.216e9, "R1": 4.5, "R2": 1.0, "w": 0.3, "E0": 2.484e9},
        "dynamite": {"A": 5.242e11, "B": 2.067e9, "R1": 4.2, "R2": 1.1, "w": 0.35, "E0": 3.56e9},
    }
    # 炸药密度 (kg/m³)，用于装药量→装药体积换算
    explosive_density = {"emulsion": 1100.0, "anfo": 800.0, "dynamite": 1400.0}

    p = params.get(explosive_type, params["emulsion"])
    V = max(0.01, relative_volume)
    E0 = p["E0"]
    # 装药量缩放：总能量按装药体积线性放大
    if charge_kg is not None and charge_kg > 0:
        rho = explosive_density.get(explosive_type, 1000.0)
        v_charge = charge_kg / rho  # 装药体积 m³
        E0 = E0 * v_charge
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
            'jwl_peak_pressure': p_jwl,
            'safe': v < params.get('threshold', 5.0)
        })
    return results


def build_ppv_grid(tunnel_width: float = 18, tunnel_height: float = 15,
                   extent_forward: float = 25, resolution: float = 1.5
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


def ppv_field_3d(grid_xyz: np.ndarray, blast_center: np.ndarray,
                 charge_kg: float, K: float = 200, alpha: float = 1.5,
                 beta: float = 0.02, c_p: float = 4500, t: float = 0.0) -> np.ndarray:
    """3D 球面波 PPV 振动场计算

    萨道夫斯基经验公式 + 球面波前传播 + 指数阻尼：

        PPV(r, t) = K · (Q^{1/3} / R)^{α} · exp(-β·(t - R/c_p)) · H(t - R/c_p)

    其中 R 为采样点到爆心的球面距离，H 为 Heaviside 阶跃函数
    （波前未到达处 PPV=0），β 为介质阻尼系数。

    理论依据：
    - 萨道夫斯基经验公式（GB6722-2014 第 6.2 条）
    - 胡英国等《爆炸与冲击》2015, 35(4):547-554（岩体爆破损伤 PPV 临界值）
    - 周传波等 JRMGE 2025（考虑介质阻尼与几何扩散的振动场正演算法）

    :param grid_xyz: (N,3) 采样点坐标
    :param blast_center: (3,) 爆心坐标
    :param charge_kg: 装药量(kg)
    :param K: 场地常数（中硬岩 150-250，GB6722 附录）
    :param alpha: 衰减指数（1.5-1.8）
    :param beta: 介质阻尼系数（0.01-0.05）
    :param c_p: 纵波速度(m/s)
    :param t: 模拟时间(s)
    :return: (N,) PPV 数组(m/s)，波前未到达处为 0
    """
    r = np.linalg.norm(grid_xyz - blast_center, axis=1)
    r = np.maximum(r, 0.5)  # 避免爆心奇点，下限 0.5m

    arrival = r / c_p  # 波前到达时间
    # 萨道夫斯基几何衰减
    ppv = K * (charge_kg ** (1.0 / 3.0) / r) ** alpha
    # 波前未到达置 0，到达后按指数阻尼衰减
    mask = t >= arrival
    ppv = ppv * np.exp(-beta * (t - arrival)) * mask
    return (ppv * 0.01).astype(np.float32)  # cm/s → m/s


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


# ─── 损伤分区阈值（Persson 模型，近场 PPV 临界值，cm/s）──────────────
# 与 GB6722 远场安全阈值（用于 PPV 色阶）语义不同：
#   - GB6722 阈值（0.5~15 cm/s）：保护建（构）筑物的远场安全允许标准
#   - Persson 阈值（5~50 cm/s）：岩体近场爆破损伤临界值，划分岩体自身破坏程度
# 依据：
#   Persson P.A. et al. "The Rock Blasting Handbook", 1997
#   胡英国等. 爆炸与冲击, 2015, 35(4):547-554（岩体爆破损伤 PPV 临界值实验研究）
#   周传波等. JRMGE, 2025（考虑介质阻尼的振动场正演与损伤评价）
DAMAGE_THRESHOLDS_CMPS = (5.0, 15.0, 30.0, 50.0)
DAMAGE_ZONE_LABELS = ('elastic', 'micro_crack', 'crack_growth', 'fracture', 'throw')


def stress_field_from_ppv(ppv: np.ndarray,
                          rho: float = 2650.0,
                          c_p: float = 4500.0,
                          nu: float = 0.25) -> dict:
    """由 PPV 振动场反演岩体应力场（弹性球面波本构，一阶近似）

    在球面纵波假设下，质点速度方向沿径向（远离爆心），应力-速度关系为：

        σ_rr = ρ · c_p · v_r            （径向应力，加载相为压应力）
        σ_θθ = (ν / (1−ν)) · σ_rr       （切向应力，球面波弹性关系）

    主应力状态：σ_1 = σ_rr（最大主应力，径向），
               σ_2 = σ_3 = σ_θθ（切向，两正交方向相等）。
    von Mises 等效应力：

        σ_vm = |σ_rr − σ_θθ| = σ_rr · (1 − ν/(1−ν)) = σ_rr · (1−2ν)/(1−ν)

    适用范围与局限：
        - 弹性一阶近似，适用于中远场（r > 5R_charge，R_charge 为药包半径）；
        - 近场（爆腔附近）存在塑性变形与卸载拉应力，需配合损伤分区修正；
        - 切向拉应力（卸载相）是岩体拉裂的主因，本模型以应力幅值近似评估。

    理论依据：
        - Hwang & Mohanty, Int. J. Rock Mech. Min. Sci., 2005（球面波应力-速度关系）
        - 陶颂霖《爆破力学》，中南大学出版社（弹性波应力反演）

    :param ppv: (N,) PPV 数组(m/s)，来自 ppv_field_3d（已含 ×0.01 cm/s→m/s）
    :param rho: 岩体密度(kg/m³)，默认 2650（中硬岩）
    :param c_p: 纵波速度(m/s)，默认 4500
    :param nu: 泊松比，默认 0.25
    :return: dict，各字段均为 (N,) float32 数组，单位 Pa：
        sigma_rr   - 径向应力（最大主应力 σ_1，压应力为正）
        sigma_theta- 切向应力（最小主应力 σ_3，σ_2=σ_3）
        sigma_vm   - von Mises 等效应力
        sigma_1    - 最大主应力（= sigma_rr）
        sigma_3    - 最小主应力（= sigma_theta）
    """
    ppv = np.asarray(ppv, dtype=np.float32)
    # 径向应力 σ_rr = ρ·c_p·v_r（Pa）；PPV 为标量峰值，方向沿径向
    sigma_rr = (rho * c_p * ppv).astype(np.float32)
    # 切向应力 σ_θθ = (ν/(1−ν))·σ_rr；ν=0.25 → 系数 0.333
    theta_factor = nu / (1.0 - nu)
    sigma_theta = (sigma_rr * theta_factor).astype(np.float32)
    # von Mises：σ_1=σ_rr, σ_2=σ_3=σ_θθ → σ_vm = |σ_rr − σ_θθ|
    sigma_vm = np.abs(sigma_rr - sigma_theta).astype(np.float32)
    return {
        'sigma_rr': sigma_rr,
        'sigma_theta': sigma_theta,
        'sigma_vm': sigma_vm,
        'sigma_1': sigma_rr,        # 最大主应力（径向主导）
        'sigma_3': sigma_theta      # 最小主应力（切向）
    }


def damage_zone_classify(ppv: np.ndarray,
                         thresholds: tuple = DAMAGE_THRESHOLDS_CMPS) -> np.ndarray:
    """基于 PPV 阈值划分岩体爆破损伤分区（Persson 模型）

    分区定义（近场 PPV 临界值，cm/s）：
        0 elastic       弹性区      PPV < 5      无损伤，应力波衰减后岩体完整
        1 micro_crack   微裂纹区    5 ≤ PPV < 15 初始微裂纹萌生，σ_vm 接近抗拉强度
        2 crack_growth  裂纹扩展区  15 ≤ PPV < 30 裂纹扩展贯通，损伤累积
        3 fracture      破碎区      30 ≤ PPV < 50 岩体破碎，强度丧失
        4 throw         抛掷区      PPV ≥ 50     介质抛掷，爆腔形成

    阈值依据中硬岩（σ_c≈80~120 MPa, σ_t≈6~10 MPa）实验统计，
    弹性反演 σ_vm = ρ·c_p·v·(1−2ν)/(1−ν)（ν=0.25 时 σ_vm≈7.95·v_mps MPa）：
        PPV=5 cm/s  → σ_vm≈0.40 MPa，微裂纹萌生（实验统计起裂阈值）
        PPV=15 cm/s → σ_vm≈1.19 MPa，裂纹扩展贯通
        PPV=30 cm/s → σ_vm≈2.39 MPa，接近中硬岩抗拉强度下限
        PPV=50 cm/s → σ_vm≈3.98 MPa，超过软弱岩体抗拉强度，破碎
    注：Persson 阈值为实验统计的近场损伤临界值；近场塑性应力集中与卸载拉应力
    高于弹性预测，故 σ_vm 弹性反演值低于岩体抗拉强度时仍可发生损伤。

    :param ppv: (N,) PPV 数组(m/s)，来自 ppv_field_3d
    :param thresholds: (4,) 分区上界阈值(cm/s)，默认 (5,15,30,50)
    :return: (N,) int8 数组，取值 0~4，对应 DAMAGE_ZONE_LABELS
    """
    ppv = np.asarray(ppv, dtype=np.float32)
    ppv_cmps = ppv * 100.0  # m/s → cm/s
    bins = np.asarray(thresholds, dtype=np.float32)
    # np.digitize: 返回 0(<bins[0]), 1([bins0,bins1)), ..., len(bins)(>=bins[-1])
    zones = np.digitize(ppv_cmps, bins).astype(np.int8)
    return zones


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
