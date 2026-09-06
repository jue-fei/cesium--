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


def ppv_field_3d(grid_xyz: np.ndarray, blast_center: np.ndarray,
                 charge_kg: float, K: float = 30, alpha: float = 1.5,
                 beta: float = 0.02, c_p: float = 4500, t: float = 0.0,
                 visual_c_p: float = 35.0, visual_beta: float = 0.8) -> np.ndarray:
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
    # 萨道夫斯基几何衰减
    ppv = K * (charge_kg ** (1.0 / 3.0) / r) ** alpha
    # 实时质点速度：波前未到达置 0，到达后按物理 β + 可视化 β_v 指数回落
    mask = t >= arrival
    ppv = ppv * np.exp(-(beta + visual_beta) * (t - arrival)) * mask
    return (ppv * 0.01).astype(np.float32)  # cm/s → m/s


def ppv_field_3d_multi(grid_xyz: np.ndarray, sources: List[dict],
                       t: float, K: float = 30, alpha: float = 1.5,
                       beta: float = 0.02, c_p: float = 4500,
                       visual_c_p: float = 35.0, visual_beta: float = 0.8,
                       min_standoff: float = 0.5) -> np.ndarray:
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
        amp *= np.exp(-(beta + visual_beta) * (t - np.maximum(arrival, 0.0)))  # 实时回落
        # 单位径向矢量：u = d / r（标准化）
        unit = d / r_safe
        contrib = (amp * unit) * (mask[:, None].astype(np.float64))  # (N,3) cm/s 矢量
        v += contrib

    ppv = np.sqrt((v ** 2).sum(axis=1))
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

    爆破应力波在岩体中产生两种破坏性应力（这是岩体爆破破坏/生成裂隙的机制）：
        - 径向压应力 σ_rr（加载相）：σ_rr = ρ · c_p · v_r   （波阻抗关系）
        - 切向拉应力 σ_θθ（幅值）：σ_θθ = (ν / (1−ν)) · σ_rr（切向受拉，方向与径向相反）
    切向拉应力是产生径向裂隙的主因（应力波使介质切向受拉，见文献依据）。

    主应力状态（压缩为正，切向拉为负）：σ_1 = σ_rr（最大主应力，径向），
               σ_2 = σ_3 = −σ_θθ（切向，两正交方向相等，为拉应力）。
    von Mises 等效应力：

        σ_vm = |σ_rr − σ_θθ| = σ_rr · (1 + ν/(1−ν)) = σ_rr / (1−ν)

    适用范围与局限：
        - 弹性一阶近似，适用于中远场（r > 5R_charge，R_charge 为药包半径）；
        - 近场（爆腔附近）存在塑性变形，弹性预测偏低，需配合损伤分区修正；
        - σ_θθ 为切向拉应力幅值（成缝判据 σ_θθ ≥ σ_t 岩体抗拉强度）。

    理论依据：
        - Hwang & Mohanty, Int. J. Rock Mech. Min. Sci., 2005（球面波应力-速度关系）
        - 罗章喜, 爆炸与冲击 1982, 3:34-40（光面爆破理论：冲击波使岩石切向受拉）
        - Wang X. et al., Processes 2023, 11(9):2805（σ_θ = −b·σ_r, b = ν/(1−ν)）
        - 梁瑞等, 高压物理学报 2022, 36(6):064202（裂隙区径向压力+切向拉力，Mises 判据）
        - 陶颂霖《爆破力学》，中南大学出版社（弹性波应力反演）

    :param ppv: (N,) PPV 数组(m/s)，来自 ppv_field_3d（已含 ×0.01 cm/s→m/s）
    :param rho: 岩体密度(kg/m³)，默认 2650（中硬岩）
    :param c_p: 纵波速度(m/s)，默认 4500
    :param nu: 泊松比，默认 0.25
    :return: dict，各字段均为 (N,) float32 数组，单位 Pa：
        sigma_rr   - 径向应力幅值（最大主应力 σ_1，压应力）
        sigma_theta- 切向拉应力幅值（σ_θθ = ν/(1−ν)·σ_rr，最小主应力 σ_3）
        sigma_vm   - von Mises 等效应力 = σ_rr/(1−ν)
        sigma_1    - 最大主应力（= sigma_rr）
        sigma_3    - 最小主应力（= −sigma_theta，切向拉应力）
    """
    ppv = np.asarray(ppv, dtype=np.float32)
    # 径向应力 σ_rr = ρ·c_p·v_r（Pa）；PPV 为标量峰值，方向沿径向
    sigma_rr = (rho * c_p * ppv).astype(np.float32)
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

    分区定义（近场 PPV 临界值，cm/s）：
        0 elastic       弹性区      PPV < 5      无损伤，应力波衰减后岩体完整
        1 micro_crack   微裂纹区    5 ≤ PPV < 15 初始微裂纹萌生，σ_vm 接近抗拉强度
        2 crack_growth  裂纹扩展区  15 ≤ PPV < 30 裂纹扩展贯通，损伤累积
        3 fracture      破碎区      30 ≤ PPV < 50 岩体破碎，强度丧失
        4 throw         抛掷区      PPV ≥ 50     介质抛掷，爆腔形成

    阈值依据中硬岩（σ_c≈80~120 MPa, σ_t≈6~10 MPa）实验统计，
    弹性反演 σ_vm = ρ·c_p·v·(1/(1−ν))（ν=0.25 时 σ_vm≈15.9·v_mps MPa）：
        PPV=5 cm/s  → σ_vm≈0.79 MPa，微裂纹萌生（实验统计起裂阈值）
        PPV=15 cm/s → σ_vm≈2.38 MPa，裂纹扩展贯通
        PPV=30 cm/s → σ_vm≈4.77 MPa，接近中硬岩抗拉强度下限
        PPV=50 cm/s → σ_vm≈7.95 MPa，超过软弱岩体抗拉强度，破碎
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
        """二阶扩散平滑（Laplacian smoothing）：用于抑制同位网格的奇偶解耦合倾向

        对速度场施加二阶扩散项 κ·∇²v（拉普拉斯平滑，作为人工粘性的简化近似）。
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
          4. 人工粘性 + 海绵吸收层阻尼
        """
        dt = self.dt
        rho = self.rho
        lam, mu = self.lam, self.mu
        h = self.h
        # 二阶扩散平滑（等同于拉普拉斯算子，作为人工粘性的简化近似）
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

            # 海绵吸收层阻尼（施加在速度上）
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

            # 3. 爆腔源：在各源腔体区域施加各向同性压应力 P(t - delay)（多源延迟起爆）
            #    σij -= dt · Σ_s P_s(t-delay_s) · δij · mask_s · src_scale_s
            #    每源按各自 delay 独立起爆：未到延时者跳过（H(t-delay) 门控），
            #    已起爆源在腔体其余位置持续注入，多源球面波在岩体内叠加干涉。
            for s_src in self._multi_sources:
                local_t = t - s_src['delay']
                if local_t < 0.0:
                    continue
                p_src = s_src['source'].pressure_at(local_t, self.cp)
                src_term = dt * p_src * s_src['mask'] * s_src['src_scale']
                self.sxx -= src_term
                self.syy -= src_term
                self.szz -= src_term

            # 海绵吸收层阻尼（施加在应力上）
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
            return ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape,
                                     jwl_sources[0]['source'], rock,
                                     blast_center=blast_center, sources=jwl_sources)
    source = JWLBlastSource(charge_kg, explosive_type)
    return ElasticWaveFDTD3D(grid_xyz, bounds_min, bounds_max, grid_shape, source, rock,
                             blast_center=blast_center)

