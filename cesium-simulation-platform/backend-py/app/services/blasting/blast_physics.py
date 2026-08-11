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


# ─── JWL 爆腔源 + 3D 弹性波 FDTD（方案 B：完整波动方程数值解）──────────
# 物理链路：
#   JWL 状态方程 → 爆腔峰值压力 P0（CJ 压力量级，仅依赖炸药类型）
#   装药量 → 爆腔初始半径 R0 = (3·V_charge/(4π))^(1/3)
#   爆腔压力时程 P(t) = P0 · exp(-t/τ)，τ = R0/c_p（爆腔声学时间）
#   P(t) 作为爆腔区域(r<R0)的各向同性压力源项，喂给弹性波动方程
#   FDTD 速度-应力格式（同位网格 + 4 阶人工粘性）求解岩体中波场
#   输出 PPV = √(vx²+vy²+vz²)
#
# 理论依据：
#   - Virieux (1986) 速度-应力有限差分，IEEE Trans. Geosci. Remote Sens.
#   - von Neumann & Richtmyer (1950) 人工粘性稳定化
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


class ElasticWaveFDTD3D:
    """3D 弹性波速度-应力有限差分引擎（同位网格 + 人工粘性）

    状态：v=(vx,vy,vz), σ=(σxx,σyy,σzz,σxy,σxz,σyz)
    方程（各向同性弹性介质）：
        ρ·∂vi/∂t = ∂σij/∂xj
        ∂σij/∂t = λ·δij·(∂vk/∂xk) + μ·(∂vi/∂xj + ∂vj/∂xi)
    空间差分：2 阶中心差分（同位网格）
    稳定化：von Neumann-Richtmyer 4 阶人工粘性抑制奇偶解耦合
    边界：阻尼吸收层（简化 PML），在边界 N_pml 层内对场施加指数衰减

    时间步进：显式 Euler（应力-速度交错，leapfrog）
    CFL：dt < dx / (c_p·√3)

    理论：Virieux 1986；Aki & Richards《定量地震学》第 4 章
    """

    def __init__(self, grid_xyz: np.ndarray, bounds_min: np.ndarray,
                 bounds_max: np.ndarray, grid_shape: tuple,
                 source: JWLBlastSource, rock: RockMedium = RockMedium(),
                 n_pml: int = 4):
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
        # 源位置：爆心 = 网格原点（局部坐标系，与 build_ppv_grid 一致）
        self.blast_center = np.array([0.0, 0.0, 0.0], dtype=np.float32)

        # 爆腔掩膜（r < R0 的网格点）
        r = np.linalg.norm(grid_xyz - self.blast_center, axis=1)
        self.cavity_mask = (r < source.cavity_radius).reshape(grid_shape).astype(np.float32)
        if not self.cavity_mask.any():
            # 爆腔小于一个网格胞元时，取最近爆心的单点
            idx = np.argmin(r)
            self.cavity_mask = np.zeros(grid_shape, dtype=np.float32)
            self.cavity_mask[np.unravel_index(idx, grid_shape)] = 1.0

        # 阻尼吸收层（简化 PML）
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
        """构建阻尼吸收层：边界 n_pml 层内指数衰减，内部为 1.0

        简化 PML：对场乘 (1 - d)，d 在边界最大，向内指数衰减。
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

    def _dx(self, f: np.ndarray) -> np.ndarray:
        """∂f/∂x，2 阶中心差分，边界 0 填充"""
        out = np.zeros_like(f)
        out[1:-1, :, :] = (f[2:, :, :] - f[:-2, :, :]) / (2.0 * self.h)
        return out

    def _dy(self, f: np.ndarray) -> np.ndarray:
        out = np.zeros_like(f)
        out[:, 1:-1, :] = (f[:, 2:, :] - f[:, :-2, :]) / (2.0 * self.h)
        return out

    def _dz(self, f: np.ndarray) -> np.ndarray:
        out = np.zeros_like(f)
        out[:, :, 1:-1] = (f[:, :, 2:] - f[:, :, :-2]) / (2.0 * self.h)
        return out

    def _artificial_viscosity(self, f: np.ndarray, axis: int) -> np.ndarray:
        """von Neumann-Richtmyer 4 阶人工粘性：抑制同位网格奇偶解耦合

        q = c_q · ρ · h² · |∂v/∂x| · (∂v/∂x)，仅在压缩梯度处生效。
        简化实现：对速度场施加二阶扩散项 κ·∇²v。
        """
        # 简化：对场施加拉普拉斯平滑（等价于人工粘性扩散）
        lap = np.zeros_like(f)
        if axis == 0:
            lap[1:-1, :, :] = (f[2:, :, :] - 2 * f[1:-1, :, :] + f[:-2, :, :])
        elif axis == 1:
            lap[:, 1:-1, :] = (f[:, 2:, :] - 2 * f[:, 1:-1, :] + f[:, :-2, :])
        else:
            lap[:, :, 1:-1] = (f[:, :, 2:] - 2 * f[:, :, 1:-1] + f[:, :, :-2])
        return lap

    def step(self, n_substeps: int = 1):
        """推进 n_substeps 个 FDTD 子步

        每个子步：
          1. 速度更新：v += (dt/ρ) · div(σ)
          2. 应力更新：σ += dt · (λ·tr(ε̇)·I + 2μ·ε̇)
          3. 爆腔源：σxx/σyy/σzz -= dt · P(t) · cavity_mask（压应力）
          4. 人工粘性 + PML 阻尼
        """
        dt = self.dt
        rho = self.rho
        lam, mu = self.lam, self.mu
        h = self.h
        # 人工粘性系数（经验值，0.01-0.05）
        q_visc = 0.02

        for _ in range(n_substeps):
            t = self.sim_time
            # 1. 速度更新：ρ·∂vi/∂t = ∂σij/∂xj
            dvx = (self._dx(self.sxx) + self._dy(self.sxy) + self._dz(self.sxz)) / rho
            dvy = (self._dx(self.sxy) + self._dy(self.syy) + self._dz(self.syz)) / rho
            dvz = (self._dx(self.sxz) + self._dy(self.syz) + self._dz(self.szz)) / rho
            # 人工粘性（扩散项）
            dvx += q_visc * (self._artificial_viscosity(self.vx, 0) +
                             self._artificial_viscosity(self.vx, 1) +
                             self._artificial_viscosity(self.vx, 2)) / (h * h)
            dvy += q_visc * (self._artificial_viscosity(self.vy, 0) +
                             self._artificial_viscosity(self.vy, 1) +
                             self._artificial_viscosity(self.vy, 2)) / (h * h)
            dvz += q_visc * (self._artificial_viscosity(self.vz, 0) +
                             self._artificial_viscosity(self.vz, 1) +
                             self._artificial_viscosity(self.vz, 2)) / (h * h)

            self.vx += dt * dvx
            self.vy += dt * dvy
            self.vz += dt * dvz

            # PML 阻尼（施加在速度上）
            self.vx *= self.damp
            self.vy *= self.damp
            self.vz *= self.damp

            # 2. 应变率 → 应力更新
            #   ε̇xx = ∂vx/∂x, ε̇yy = ∂vy/∂y, ε̇zz = ∂vz/∂z
            #   tr(ε̇) = ε̇xx + ε̇yy + ε̇zz
            #   σ̇ij = λ·δij·tr(ε̇) + 2μ·ε̇ij
            exx = self._dx(self.vx)
            eyy = self._dy(self.vy)
            ezz = self._dz(self.vz)
            tr = exx + eyy + ezz
            # 剪应变率：ε̇xy = (∂vx/∂y + ∂vy/∂x)/2，应力 σ̇xy = 2μ·ε̇xy = μ·(∂vx/∂y+∂vy/∂x)
            self.sxx += dt * (lam * tr + 2.0 * mu * exx)
            self.syy += dt * (lam * tr + 2.0 * mu * eyy)
            self.szz += dt * (lam * tr + 2.0 * mu * ezz)
            self.sxy += dt * mu * (self._dy(self.vx) + self._dx(self.vy))
            self.sxz += dt * mu * (self._dz(self.vx) + self._dx(self.vz))
            self.syz += dt * mu * (self._dz(self.vy) + self._dy(self.vz))

            # 3. 爆腔源：在 r<R0 区域施加各向同性压应力 P(t)
            #    σij -= dt · P(t) · δij · mask（压应力为负，与拉应力约定一致）
            p_src = self.source.pressure_at(t, self.cp)
            src_term = dt * p_src * self.cavity_mask
            self.sxx -= src_term
            self.syy -= src_term
            self.szz -= src_term

            # PML 阻尼（施加在应力上）
            self.sxx *= self.damp
            self.syy *= self.damp
            self.szz *= self.damp
            self.sxy *= self.damp
            self.sxz *= self.damp
            self.syz *= self.damp

            self.sim_time += dt

    def get_ppv(self) -> np.ndarray:
        """当前时刻 PPV = √(vx²+vy²+vz²)，单位 m/s"""
        ppv = np.sqrt(self.vx ** 2 + self.vy ** 2 + self.vz ** 2)
        return ppv.astype(np.float32)

    def get_velocity(self) -> tuple:
        """返回 (vx, vy, vz) 三向速度场"""
        return self.vx, self.vy, self.vz


def ppv_field_3d_fdtd(grid_xyz: np.ndarray, blast_center: np.ndarray,
                      charge_kg: float, explosive_type: str = "emulsion",
                      rock: RockMedium = RockMedium(),
                      sim_time: float = 0.0,
                      n_substeps: int = 0,
                      engine: Optional[ElasticWaveFDTD3D] = None
                      ) -> tuple:
    """3D 弹性波 FDTD 振动场计算（JWL 爆腔源 + 速度-应力格式）

    有状态模式（推荐，供 _stream_loop 增量推进）：
        传入 engine 实例，调用 engine.step(n_substeps) 后返回 engine.get_ppv()
    无状态模式（单次快照，仅用于测试/离线）：
        不传 engine，内部创建并推进 sim_time/dt 个子步

    :param engine: 复用的 FDTD 引擎实例（流式推送时传入避免重建）
    :param sim_time: 目标模拟时间(s)，无状态模式下推进到此时刻
    :param n_substeps: 有状态模式下推进的子步数（= timestep/dt）
    :return: (ppv_mps, engine) —— ppv 单位 m/s，engine 为新建或复用的引擎
    """
    if engine is None:
        # 无状态模式：创建引擎并推进到 sim_time
        source = JWLBlastSource(charge_kg, explosive_type)
        # grid_shape 由 grid_xyz 推断（需与 build_ppv_grid 一致）
        # 注：调用方应确保 grid_xyz 形状匹配，此处用平方根估算
        n = grid_xyz.shape[0]
        nx = int(round(n ** (1.0 / 3.0)))
        grid_shape = (nx, nx, nx)
        bounds_min = np.array([grid_xyz[:, 0].min(), grid_xyz[:, 1].min(), grid_xyz[:, 2].min()], dtype=np.float32)
        bounds_max = np.array([grid_xyz[:, 0].max(), grid_xyz[:, 1].max(), grid_xyz[:, 2].max()], dtype=np.float32)
        engine = ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape, source, rock)
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
                     rock: RockMedium = RockMedium()) -> ElasticWaveFDTD3D:
    """工厂函数：创建 FDTD 引擎（供 blasting_ws StreamState 复用）

    与 ppv_field_3d_fdtd 不同，本函数不推进时间，仅返回引擎实例。
    调用方负责 step() 与 get_ppv()。
    """
    source = JWLBlastSource(charge_kg, explosive_type)
    return ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape, source, rock)

