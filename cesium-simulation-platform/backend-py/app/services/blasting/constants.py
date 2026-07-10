"""爆破物理常量集中定义模块

所有物理计算模块 MUST 从本文件导入常量，禁止内联硬编码。
前端 cesium1/.../blastConstants.js 与本文件保持同结构。

常量来源：从 blast_physics.py / kco_validator.py 原有内联硬编码值提取。
"""

# ─── JWL 状态方程参数（3 种炸药）─────────────────────────
# 来源：blast_physics.py 中 jwl_pressure / jwl_isentrope 原内联 params 字典
# 键含义：A/B/R1/R2 为 JWL 系数，w 为 Grüneisen 系数，E0 为初始内能(J/m³)
JWL_PARAMS = {
    "emulsion": {
        "A": 3.7377e11, "B": 3.747e9, "R1": 4.15, "R2": 0.9,
        "w": 0.35, "E0": 3.9e9,
    },
    "anfo": {
        "A": 4.946e11, "B": 1.216e9, "R1": 4.5, "R2": 1.0,
        "w": 0.3, "E0": 2.484e9,
    },
    "dynamite": {
        "A": 5.242e11, "B": 2.067e9, "R1": 4.2, "R2": 1.1,
        "w": 0.35, "E0": 3.56e9,
    },
}

# ─── 萨道夫斯基振动公式默认经验常数 ─────────────────────
# 来源：blast_physics.py sadosky_vibration / wave_field_2d 原硬编码 K=200、alpha=1.5
SADOSKY_K_DEFAULT = 200.0       # 中国 GB6722-2014 中硬岩默认值
SADOSKY_ALPHA_DEFAULT = 1.5     # 衰减指数
SADOSKY_R_MIN = 0.5             # 距离最小钳制(m)，避免奇点

# ─── 损伤区计算系数 ─────────────────────────────────────
# 来源：blast_physics.py damage_zone_radii 原硬编码 1.8/1.5/2.5
DAMAGE_BETA = 2.5               # 应力衰减指数（柱面波 2 / 球面波 3 / 隧道取 2.5）
SIGMA_CD_FACTOR = 1.8           # 动态抗压强度 = 静态UCS × 该系数
SIGMA_TD_FACTOR = 1.5           # 动态抗拉强度 = 静态抗拉 × 该系数

# ─── KCO 模型 ───────────────────────────────────────────
# 来源：kco_validator.py calculate_kco 原硬编码 oversize_threshold = 0.8
KCO_OVERSIZE_THRESHOLD = 0.8    # oversize 判定阈值(m)，工程上常取 0.8m

# ─── 爆生气膨胀 ─────────────────────────────────────────
# 说明：blast_physics.py 原无内联定义，此处取工程典型参考值，供 Task 6 重构使用
GAS_EFFECTIVE_TIME = 0.1        # 气体有效作用时间(s)，爆生气典型作用时长 ~100ms
P_MAX_CLAMP = 5.0e9             # 压力上限钳制(Pa)，取 5 GPa 参考值
