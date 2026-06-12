"""
完整数据库迁移脚本 — 创建所有表并填充种子数据
运行: python migrate_all.py
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

conn = pymysql.connect(
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", 3306)),
    user=os.getenv("DB_USER", "root"),
    password=os.getenv("DB_PASSWORD", ""),
    database=os.getenv("DB_NAME", "cesium_platform"),
    charset="utf8mb4",
    cursorclass=DictCursor,
)
cursor = conn.cursor()

# ============================================================
# 1. 应用配置表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS app_settings")
cursor.execute("""
CREATE TABLE app_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(64) NOT NULL UNIQUE,
  setting_value JSON NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='应用配置'
""")

# ============================================================
# 2. 工具注册表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS tool_registry")
cursor.execute("""
CREATE TABLE tool_registry (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tool_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  icon VARCHAR(32) NOT NULL,
  component_path VARCHAR(255) NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='工具注册表'
""")

# ============================================================
# 3. 相机预设表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS camera_presets")
cursor.execute("""
CREATE TABLE camera_presets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  preset_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  emoji VARCHAR(16) DEFAULT NULL,
  destination JSON NOT NULL,
  heading DOUBLE DEFAULT 0,
  pitch DOUBLE DEFAULT 0,
  roll DOUBLE DEFAULT 0,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='相机预设'
""")

# ============================================================
# 4. 矿种类型表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS mineral_types")
cursor.execute("""
CREATE TABLE mineral_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(8) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  density DOUBLE DEFAULT 0,
  color VARCHAR(9) DEFAULT '#ffffff',
  grade VARCHAR(20) DEFAULT NULL,
  value_level VARCHAR(20) DEFAULT NULL,
  destination VARCHAR(100) DEFAULT NULL,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='矿种类型'
""")

# ============================================================
# 5. 运输单元表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS transport_units")
cursor.execute("""
CREATE TABLE transport_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unit_id VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  driver VARCHAR(50) DEFAULT NULL,
  phase_offset DOUBLE DEFAULT 0,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='运输单元'
""")

# ============================================================
# 6. 采场规格表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS mining_pit_specs")
cursor.execute("""
CREATE TABLE mining_pit_specs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pit_key VARCHAR(32) NOT NULL UNIQUE,
  model_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  cartesian JSON NOT NULL,
  lon_lat JSON NOT NULL,
  radius DOUBLE DEFAULT 0
) ENGINE=InnoDB COMMENT='采场规格'
""")

# ============================================================
# 7. 应力指标表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS stress_metrics")
cursor.execute("""
CREATE TABLE stress_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  metric_key VARCHAR(32) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  is_base_metric TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='应力指标'
""")

# ============================================================
# 8. 热力图色标表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS heatmap_ramps")
cursor.execute("""
CREATE TABLE heatmap_ramps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  value DOUBLE NOT NULL,
  color VARCHAR(9) NOT NULL,
  label VARCHAR(50) NOT NULL,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='热力图色标'
""")

# ============================================================
# 9. 预警规则表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS warning_rules")
cursor.execute("""
CREATE TABLE warning_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rule_id VARCHAR(64) NOT NULL UNIQUE,
  metric VARCHAR(64) NOT NULL,
  level VARCHAR(16) NOT NULL COMMENT 'red/orange/yellow',
  title VARCHAR(100) NOT NULL,
  description_template VARCHAR(255) DEFAULT NULL,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='预警规则'
""")

# ============================================================
# 10. 地质统计表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS geology_stats")
cursor.execute("""
CREATE TABLE geology_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stat_key VARCHAR(64) NOT NULL UNIQUE,
  stat_value DOUBLE NOT NULL
) ENGINE=InnoDB COMMENT='地质统计'
""")

# ============================================================
# 11. 实验预设表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS experiment_presets")
cursor.execute("""
CREATE TABLE experiment_presets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  preset_id VARCHAR(32) NOT NULL UNIQUE,
  label VARCHAR(50) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  config_json JSON NOT NULL,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB COMMENT='实验预设'
""")

# ============================================================
# 12. 实验方法表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS experiment_methods")
cursor.execute("""
CREATE TABLE experiment_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  method_key VARCHAR(32) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  title VARCHAR(100) DEFAULT NULL,
  formula VARCHAR(255) DEFAULT NULL,
  description VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB COMMENT='实验方法'
""")

# ============================================================
# 13. 实验默认配置表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS experiment_default_config")
cursor.execute("""
CREATE TABLE experiment_default_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  config_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='实验默认配置'
""")

# ============================================================
# 14. 显示质量配置表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS display_quality_profiles")
cursor.execute("""
CREATE TABLE display_quality_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quality_level VARCHAR(16) NOT NULL COMMENT 'low/medium/high',
  profile_type VARCHAR(16) NOT NULL COMMENT 'display/terrain',
  config_json JSON NOT NULL,
  UNIQUE KEY uq_quality_profile (quality_level, profile_type)
) ENGINE=InnoDB COMMENT='显示质量配置'
""")

# ============================================================
# 15. 爆破配置表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS blasting_configs")
cursor.execute("""
CREATE TABLE blasting_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  config_key VARCHAR(64) NOT NULL UNIQUE,
  config_value JSON NOT NULL
) ENGINE=InnoDB COMMENT='爆破配置'
""")

# ============================================================
# 16. 仿真配置表
# ============================================================
cursor.execute("DROP TABLE IF EXISTS simulation_configs")
cursor.execute("""
CREATE TABLE simulation_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  config_key VARCHAR(64) NOT NULL UNIQUE,
  config_value JSON NOT NULL
) ENGINE=InnoDB COMMENT='仿真配置'
""")

conn.commit()
print("[OK] 16 张表创建完成，开始填充种子数据...")

# ============================================================
# 填充种子数据
# ============================================================

# --- app_settings ---
app_settings = [
    ("ore_grade_thresholds", {"HIGH": 3.0, "MEDIUM": 2.0}, "矿品位阈值"),
    ("model_defaults", {"OPACITY": 100, "VISIBLE": True}, "模型默认显示配置"),
    ("borehole_config", {"COLOR": "#ff0000", "ALPHA": 0.8, "WIDTH": 3, "MARKER_SIZE": 24}, "钻孔配置"),
    ("section_config", {"COLOR": "#0000ff", "ALPHA": 0.7, "WIDTH": 2}, "剖面配置"),
    ("default_ore_density", {"value": 2.5}, "默认矿石密度"),
    ("default_position", {"longitude": 113.323, "latitude": 23.106, "height": -26}, "默认模型位置"),
    ("default_transform", {"rotationX": 15, "rotationY": 0, "rotationZ": 0}, "默认模型变换"),
    ("default_model_config_path", {"value": "/model/demo4/feature.json"}, "默认模型配置路径"),
    ("default_lod_config", {"maximumScreenSpaceError": 16, "cacheBytes": 536870912, "dynamicScreenSpaceError": True}, "默认LOD配置"),
    ("lod_presets", {"high_quality": {"displayName": "高质量"}, "balanced": {"displayName": "平衡"}, "performance": {"displayName": "高性能"}}, "LOD预设"),
]
cursor.executemany(
    "INSERT INTO app_settings (setting_key, setting_value, description) VALUES (%s, %s, %s)",
    [(k, json.dumps(v), d) for k, v, d in app_settings]
)

# --- tool_registry ---
tools = [
    ("model_control", "模型控制", "Location", "@/features/model-control/components/ModelTransformPanel.vue", 1),
    ("geology", "地质分析", "Monitor", "@/features/geology-analysis/components/GeologyPanel.vue", 2),
    ("measure", "测量分析", "Ruler", "@/features/measurement-analysis/components/MeasurementPanel.vue", 3),
    ("clipping", "模型切割", "Scissor", "@/features/model-clipping/components/ClippingPanel.vue", 4),
    ("monitoring", "现场调度中心", "DataLine", "@/features/realtime-monitoring/components/MonitoringPanel.vue", 5),
    ("blasting", "爆破模拟", "VideoPlay", "@/features/blasting-simulation/components/BlastingPanel.vue", 6),
    ("lod", "LOD优化", "Odometer", "@/features/lod-optimization/components/LodPanel.vue", 7),
    ("stress", "应力分析", "Histogram", "@/features/stress-analysis/components/StressPanel.vue", 8),
    ("experiment", "实验分析", "DataAnalysis", "@/features/experiment-analysis/components/ExperimentPanel.vue", 9),
    ("system", "系统工具", "Setting", "@/features/system-tools/components/SystemTools.vue", 10),
]
cursor.executemany(
    "INSERT INTO tool_registry (tool_id, name, icon, component_path, sort_order) VALUES (%s, %s, %s, %s, %s)",
    tools
)

# --- camera_presets ---
cameras = [
    ("overview", "总览镜头", "查看采场1、采场2及矿卡整体运行", "🗺️", {"x": 116.391156, "y": 39.901164, "z": 800}, 0, -1.2, 0, 1),
    ("loading", "装载区镜头", "查看采场1矿卡装载位置", "⛏️", {"x": 116.391178, "y": 39.901187, "z": 200}, 0.5, -0.7, 0, 2),
    ("road", "运输线镜头", "查看采场1到采场2运输线路", "🛣️", {"x": 116.391116, "y": 39.901180, "z": 300}, 0.8, -0.8, 0, 3),
    ("dump", "卸载区镜头", "查看采场2矿卡卸载位置", "📤", {"x": 116.391054, "y": 39.901173, "z": 200}, -1.2, -0.7, 0, 4),
]
cursor.executemany(
    "INSERT INTO camera_presets (preset_id, name, description, emoji, destination, heading, pitch, roll, sort_order) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
    [(c[0], c[1], c[2], c[3], json.dumps(c[4]), c[5], c[6], c[7], c[8]) for c in cameras]
)

# --- mineral_types ---
minerals = [
    ("CU", "铜矿石", 2.8, "#B87333", "1.2%", "高", "冶炼厂A区", 1),
    ("FE", "铁矿石", 3.5, "#8B4513", "45%", "中", "选矿厂B区", 2),
    ("AU", "金矿石", 4.2, "#FFD700", "3.5g/t", "极高", "精炼厂C区", 3),
]
cursor.executemany(
    "INSERT INTO mineral_types (code, name, density, color, grade, value_level, destination, sort_order) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
    minerals
)

# --- transport_units ---
units = [
    ("T01", "1号矿卡", "张鹏", 0.0, 1),
    ("T02", "2号矿卡", "刘威", 0.33, 2),
    ("T03", "3号矿卡", "王超", 0.66, 3),
]
cursor.executemany(
    "INSERT INTO transport_units (unit_id, name, driver, phase_offset, sort_order) VALUES (%s, %s, %s, %s, %s)",
    units
)

# --- mining_pit_specs ---
pits = [
    ("pit1", "d645920e395fedad7bbbed0eca3fe2e0", "采场模型1",
     [-2178472.525158, 4385068.251249, 4073979.895907],
     {"x": 116.391178, "y": 39.901187, "z": -27.68}, 1217.7),
    ("pit2", "d67d8ab4f4c10bf22aa353e27879133c", "采场模型2",
     [-2178458.198413, 4385055.390495, 4073957.614462],
     {"x": 116.391054, "y": 39.901173, "z": -23.34}, 993.82),
]
cursor.executemany(
    "INSERT INTO mining_pit_specs (pit_key, model_id, name, cartesian, lon_lat, radius) VALUES (%s, %s, %s, %s, %s, %s)",
    [(p[0], p[1], p[2], json.dumps(p[3]), json.dumps(p[4]), p[5]) for p in pits]
)

# --- stress_metrics ---
metrics = [
    ("von_mises", "等效应力（von Mises）", 1, 1), ("principal_1", "最大主应力（σ1）", 1, 2),
    ("principal_2", "中间主应力（σ2）", 1, 3), ("principal_3", "最小主应力（σ3）", 1, 4),
    ("max_abs_normal", "三向正应力合成", 1, 5), ("mean_stress", "平均应力", 1, 6),
    ("pressure", "静水压力", 1, 7), ("j2", "第二偏应力不变量（J2）", 1, 8),
    ("tau_max", "最大剪应力（τmax）", 1, 9), ("tau_oct", "八面体剪应力（τoct）", 1, 10),
    ("sxx", "σxx", 1, 11), ("syy", "σyy", 1, 12), ("szz", "σzz", 1, 13),
    ("sxy", "σxy", 1, 14), ("syz", "σyz", 1, 15), ("szx", "σzx", 1, 16),
    ("snn", "方向正应力（σnn）", 1, 17), ("tau_n", "方向剪应力（τn）", 1, 18),
    ("safety_score", "综合安全评分", 1, 19),
]
cursor.executemany(
    "INSERT INTO stress_metrics (metric_key, label, is_base_metric, sort_order) VALUES (%s, %s, %s, %s)",
    metrics
)

# --- heatmap_ramps ---
ramps = [
    (0.0, "#000080", "极低应力", 1), (0.1667, "#0066CC", "低应力", 2),
    (0.3333, "#00CCFF", "应力调整", 3), (0.5, "#00CC66", "轻微集中", 4),
    (0.625, "#99CC00", "弱岩爆倾向", 5), (0.7083, "#FFCC00", "黄色预警", 6),
    (0.7917, "#FF8800", "橙色报警", 7), (0.875, "#FF0000", "红色危险", 8),
    (1.0, "#990000", "严重破坏", 9),
]
cursor.executemany(
    "INSERT INTO heatmap_ramps (value, color, label, sort_order) VALUES (%s, %s, %s, %s)",
    ramps
)

# --- warning_rules ---
rules = [
    ("safety_score_critical", "safety_score", "red", "综合安全评分 — 极高风险", 1),
    ("safety_score_high", "safety_score", "orange", "综合安全评分 — 高风险", 2),
    ("safety_score_warning", "safety_score", "yellow", "综合安全评分 — 中风险", 3),
    ("hoek_brown_critical", "hb_utilization", "red", "Hoek-Brown 接近峰值强度", 4),
    ("hoek_brown_yield", "hb_utilization", "orange", "Hoek-Brown 进入屈服阶段", 5),
    ("mc_shear_failure", "mc_shear_util", "red", "Mohr-Coulomb 剪切破坏临近", 6),
    ("mc_tension_failure", "mc_tension_util", "red", "Mohr-Coulomb 拉伸破坏临近", 7),
    ("von_mises_critical", "von_mises_util", "red", "等效应力达到破坏阶段", 8),
    ("von_mises_elevated", "von_mises_util", "orange", "等效应力偏高", 9),
    ("rockburst_strong", "rockburst_ratio", "red", "强岩爆风险", 10),
    ("rockburst_moderate", "rockburst_ratio", "orange", "中等岩爆风险", 11),
    ("rockburst_weak", "rockburst_ratio", "yellow", "弱岩爆风险", 12),
]
cursor.executemany(
    "INSERT INTO warning_rules (rule_id, metric, level, title, sort_order) VALUES (%s, %s, %s, %s, %s)",
    rules
)

# --- geology_stats ---
geo_stats = [
    ("average_thickness", 15.4),
    ("mineralization_intensity", 0.85),
    ("estimated_reserves", 620),
    ("average_grade", 1.85),
]
cursor.executemany(
    "INSERT INTO geology_stats (stat_key, stat_value) VALUES (%s, %s)",
    geo_stats
)

# --- experiment_presets ---
exp_presets = [
    ("visual_contrast", "强对比可视化", "45个稀疏采样点", {"dataGeneration": {"pointCount": 45, "noiseLevel": 0.1}}, 1),
    ("small_dense", "小规模密集点", "100个采样点", {"dataGeneration": {"pointCount": 100, "noiseLevel": 0.02}}, 2),
    ("medium_sparse", "中等规模稀疏", "60个采样点", {"dataGeneration": {"pointCount": 60, "noiseLevel": 0.08}}, 3),
    ("large_noisy", "大规模含噪", "200个采样点", {"dataGeneration": {"pointCount": 200, "noiseLevel": 0.15}}, 4),
    ("gradient_field", "梯度应力场", "梯度+高斯峰", {"dataGeneration": {"pointCount": 150, "noiseLevel": 0.05}}, 5),
]
cursor.executemany(
    "INSERT INTO experiment_presets (preset_id, label, description, config_json, sort_order) VALUES (%s, %s, %s, %s, %s)",
    [(p[0], p[1], p[2], json.dumps(p[3]), p[4]) for p in exp_presets]
)

# --- experiment_methods ---
exp_methods = [
    ("idw", "IDW（反距离加权）", "IDW", "Z(x)=Σ(wᵢZᵢ)/Σwᵢ", "确定性插值"),
    ("kriging", "Kriging（克里金）", "Kriging", "Z*(x)=ΣλᵢZ(xᵢ)", "最优线性无偏估计"),
    ("kriging_exponential", "Kriging-指数模型", "指数", "γ(h)=C₀+C₁[1−exp(−3h/a)]", "指数衰减"),
    ("kriging_gaussian", "Kriging-高斯模型", "高斯", "γ(h)=C₀+C₁[1−exp(−3h²/a²)]", "强相关"),
    ("kriging_spherical", "Kriging-球状模型", "球状", "γ(h)=C₀+C₁[1.5h/a−0.5(h/a)³]", "有变程"),
]
cursor.executemany(
    "INSERT INTO experiment_methods (method_key, label, title, formula, description) VALUES (%s, %s, %s, %s, %s)",
    exp_methods
)

# --- experiment_default_config ---
cursor.execute(
    "INSERT INTO experiment_default_config (id, config_json) VALUES (1, %s)",
    (json.dumps({"fieldSize": [200, 200, 100], "pointCount": 150, "seed": 2026}),)
)

# --- display_quality_profiles ---
dq_profiles = [
    ("low", "display", {"resolutionScale": 0.65, "fxaa": False}),
    ("medium", "display", {"resolutionScale": 0.85, "fxaa": False}),
    ("high", "display", {"resolutionScale": 1, "fxaa": False}),
    ("low", "terrain", {"maximumScreenSpaceError": 32}),
    ("medium", "terrain", {"maximumScreenSpaceError": 16}),
    ("high", "terrain", {"maximumScreenSpaceError": 8}),
]
cursor.executemany(
    "INSERT INTO display_quality_profiles (quality_level, profile_type, config_json) VALUES (%s, %s, %s)",
    [(p[0], p[1], json.dumps(p[2])) for p in dq_profiles]
)

# --- blasting_configs ---
blasting = [
    ("default_blast_center", {"lon": 116.3915, "lat": 39.9015, "height": 0}),
    ("example_holes", [
        {"id": "H1", "diameter": 0.09, "chargeKg": 45, "delayMs": 0},
        {"id": "H2", "diameter": 0.09, "chargeKg": 48, "delayMs": 25}
    ]),
    ("example_rock_blocks", [
        {"id": "RB1", "size": 0.35, "weightKg": 60},
        {"id": "RB2", "size": 0.52, "weightKg": 125}
    ]),
]
cursor.executemany(
    "INSERT INTO blasting_configs (config_key, config_value) VALUES (%s, %s)",
    [(b[0], json.dumps(b[1])) for b in blasting]
)

# --- simulation_configs ---
sim_configs = [
    ("monitoring_tick_ms", {"value": 1000}),
    ("speed_profile", {
        "loading": {"min": 4, "max": 6},
        "loadedTransport": {"min": 23, "max": 30},
        "unloading": {"min": 4, "max": 6},
        "emptyReturn": {"min": 30, "max": 38}
    }),
    ("phase_ratio", {
        "loading": 0.15, "loadedTransport": 0.35,
        "unloading": 0.15, "emptyReturn": 0.35
    }),
    ("heatmap_panel_defaults", {"contrast": 2.2, "gamma": 0.65, "blendMode": "max"}),
]
cursor.executemany(
    "INSERT INTO simulation_configs (config_key, config_value) VALUES (%s, %s)",
    [(s[0], json.dumps(s[1])) for s in sim_configs]
)

conn.commit()
cursor.close()
conn.close()
print("[OK] 全部种子数据填充完成！")
print(f"[OK] 数据库 cesium_platform 迁移完成")
