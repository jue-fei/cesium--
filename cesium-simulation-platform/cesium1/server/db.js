const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, 'data.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ---- 建表 ----
db.exec(`
  CREATE TABLE IF NOT EXISTS model_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, path TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS model_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_config_id INTEGER NOT NULL, feature_id TEXT NOT NULL,
    name TEXT, type TEXT, category TEXT,
    style_properties TEXT DEFAULT '{}',
    geology_properties TEXT DEFAULT '{}',
    mining_properties TEXT DEFAULT '{}',
    safety_properties TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (model_config_id) REFERENCES model_configs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT NOT NULL UNIQUE, setting_value TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tool_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    icon TEXT NOT NULL, component_path TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS camera_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT, emoji TEXT, destination TEXT NOT NULL,
    heading REAL DEFAULT 0, pitch REAL DEFAULT 0, roll REAL DEFAULT 0, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mineral_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    density REAL DEFAULT 0, color TEXT DEFAULT '#ffffff',
    grade TEXT, value_level TEXT, destination TEXT, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transport_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    driver TEXT, phase_offset REAL DEFAULT 0, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mining_pit_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pit_key TEXT NOT NULL UNIQUE, model_id TEXT NOT NULL, name TEXT NOT NULL,
    cartesian TEXT NOT NULL, lon_lat TEXT NOT NULL, radius REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS stress_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    is_base_metric INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS heatmap_ramps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    value REAL NOT NULL, color TEXT NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS warning_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL UNIQUE, metric TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('red','orange','yellow')),
    title TEXT NOT NULL, description_template TEXT, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS geology_orebodies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orebody_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    grade REAL DEFAULT 0, reserves REAL DEFAULT 0, thickness REAL DEFAULT 0,
    bbox_min_x REAL DEFAULT 0, bbox_max_x REAL DEFAULT 0,
    bbox_min_y REAL DEFAULT 0, bbox_max_y REAL DEFAULT 0,
    bbox_min_z REAL DEFAULT 0, bbox_max_z REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS geology_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_key TEXT NOT NULL UNIQUE, stat_value REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS experiment_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    description TEXT, config_json TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS experiment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    title TEXT, formula TEXT, description TEXT
  );
  CREATE TABLE IF NOT EXISTS experiment_default_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS display_quality_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quality_level TEXT NOT NULL CHECK(quality_level IN ('low','medium','high')),
    profile_type TEXT NOT NULL CHECK(profile_type IN ('display','terrain')),
    config_json TEXT NOT NULL,
    UNIQUE(quality_level, profile_type)
  );
  CREATE TABLE IF NOT EXISTS blasting_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT NOT NULL UNIQUE, config_value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS truck_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    truck_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    driver TEXT NOT NULL, driver_info TEXT DEFAULT '{}',
    vehicle_info TEXT DEFAULT '{}', mineral_type TEXT DEFAULT '{}', phase REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS simulation_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT NOT NULL UNIQUE, config_value TEXT NOT NULL
  );
`)

// ---- 数据填充 ----
const count = db.prepare("SELECT count(*) as c FROM model_configs").get().c
if (count === 0) {
  console.log('[DB Init] 首次初始化, 正在插入数据...')

  const insert = db.prepare('INSERT INTO model_configs (id,name,path,sort_order) VALUES (?,?,?,?)')
  insert.run(1, 'demo1 配置', '/3d/demo1/feature.json', 1)
  insert.run(2, 'demo2 配置', '/3d/demo2/features.json', 2)
  insert.run(3, 'demo3 配置', '/3d/demo3/feature.json', 3)
  insert.run(4, 'demo4 配置', '/3d/demo4/feature.json', 4)

  const insFeature = db.prepare(`INSERT INTO model_features (id,model_config_id,feature_id,name,type,category,style_properties,geology_properties,mining_properties,safety_properties) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  insFeature.run(1,4,'a5771bce93e200c36f7cd9dfd0e5deaa','地表模型-4','surface','地形地貌','{"color":"#f6f4f4","opacity":0.9,"visible":true,"highlightColor":"#CDDC39"}','{"地质类型":"地表层","地貌特征":"矿山地表"}','{"开采影响":"直接受影响"}','{}')
  insFeature.run(2,4,'3416a75f4cea9109507cacd8e2f2aefc','地形模型','terrain','地形地貌','{"color":"#ffffff","opacity":0.8,"highlightColor":"#5D4037"}','{"地质类型":"地形模型"}','{}','{}')
  insFeature.run(3,4,'d645920e395fedad7bbbed0eca3fe2e0','采场模型1','mining_pit','采矿工程','{"color":"#ffffff","opacity":0.85,"highlightColor":"#FF5722"}','{"地质类型":"露天采场"}','{"开采状态":"正在开采"}','{"边坡稳定性":"需监测"}')
  insFeature.run(4,4,'d67d8ab4f4c10bf22aa353e27879133c','采场模型2','mining_pit','采矿工程','{"color":"#ffffff","opacity":0.85,"highlightColor":"#D84315"}','{"地质类型":"露天采场"}','{"开采状态":"规划中"}','{}')
  insFeature.run(5,4,'17e62166fc8586dfa4d1bc0e1742c08b','矿体模型','ore_body','矿产资源','{"color":"#ffffff","opacity":0.9,"highlightColor":"#B71C1C"}','{"地质类型":"矿体"}','{"资源储量":"待计算"}','{}')
  insFeature.run(6,4,'a1d0c6e83f027327d8461063f4ac58a6','夹石模型','waste_rock','矿产资源','{"color":"#ffffff","opacity":0.7,"highlightColor":"#616161"}','{"地质类型":"夹石"}','{"剥离量":"待计算"}','{}')

  const insApp = db.prepare('INSERT INTO app_settings (setting_key,setting_value,description) VALUES (?,?,?)')
  const appSettings = [
    ['ore_grade_thresholds','{"HIGH":3.0,"MEDIUM":2.0}','矿品位阈值'],
    ['model_defaults','{"OPACITY":100,"VISIBLE":true}','模型默认显示配置'],
    ['borehole_config','{"COLOR":"#ff0000","ALPHA":0.8,"WIDTH":3,"MARKER_SIZE":24}','钻孔配置'],
    ['section_config','{"COLOR":"#0000ff","ALPHA":0.7,"WIDTH":2}','剖面配置'],
    ['default_ore_density','{"value":2.5}','默认矿石密度'],
    ['default_position','{"longitude":113.323,"latitude":23.106,"height":-26}','默认模型位置'],
    ['default_transform','{"rotationX":15,"rotationY":0,"rotationZ":0}','默认模型变换'],
    ['default_model_config_path','{"value":"/3d/demo4/feature.json"}','默认模型配置路径'],
    ['default_lod_config','{"maximumScreenSpaceError":16,"cacheBytes":536870912,"dynamicScreenSpaceError":true}','默认LOD配置'],
    ['lod_presets','{"high_quality":{"displayName":"高质量"},"balanced":{"displayName":"平衡"},"performance":{"displayName":"高性能"}}','LOD预设']
  ]
  for (const s of appSettings) insApp.run(...s)

  const insTool = db.prepare('INSERT INTO tool_registry (tool_id,name,icon,component_path,sort_order) VALUES (?,?,?,?,?)')
  const tools = [
    ['model_control','模型控制','Location','@/features/model-control/components/ModelTransformPanel.vue',1],
    ['geology','地质分析','Monitor','@/features/geology-analysis/components/GeologyPanel.vue',2],
    ['measure','测量分析','Ruler','@/features/measurement-analysis/components/MeasurementPanel.vue',3],
    ['clipping','模型切割','Scissor','@/features/model-clipping/components/ClippingPanel.vue',4],
    ['monitoring','现场调度中心','DataLine','@/features/realtime-monitoring/components/MonitoringPanel.vue',5],
    ['blasting','爆破模拟','VideoPlay','@/features/blasting-simulation/components/BlastingPanel.vue',6],
    ['lod','LOD优化','Odometer','@/features/lod-optimization/components/LodPanel.vue',7],
    ['stress','应力分析','Histogram','@/features/stress-analysis/components/StressPanel.vue',8],
    ['experiment','实验分析','DataAnalysis','@/features/experiment-analysis/components/ExperimentPanel.vue',9],
    ['system','系统工具','Setting','@/features/system-tools/components/SystemTools.vue',10]
  ]
  for (const t of tools) insTool.run(...t)

  const insCam = db.prepare('INSERT INTO camera_presets (preset_id,name,description,emoji,destination,heading,pitch,roll,sort_order) VALUES (?,?,?,?,?,?,?,?,?)')
  insCam.run('overview','总览镜头','查看采场1、采场2及矿卡整体运行','🗺️','{"x":116.391156,"y":39.901164,"z":800}',0,-1.2,0,1)
  insCam.run('loading','装载区镜头','查看采场1矿卡装载位置','⛏️','{"x":116.391178,"y":39.901187,"z":200}',0.5,-0.7,0,2)
  insCam.run('road','运输线镜头','查看采场1到采场2运输线路','🛣️','{"x":116.391116,"y":39.901180,"z":300}',0.8,-0.8,0,3)
  insCam.run('dump','卸载区镜头','查看采场2矿卡卸载位置','📤','{"x":116.391054,"y":39.901173,"z":200}',-1.2,-0.7,0,4)

  const insMineral = db.prepare('INSERT INTO mineral_types (code,name,density,color,grade,value_level,destination,sort_order) VALUES (?,?,?,?,?,?,?,?)')
  insMineral.run('CU','铜矿石',2.8,'#B87333','1.2%','高','冶炼厂A区',1)
  insMineral.run('FE','铁矿石',3.5,'#8B4513','45%','中','选矿厂B区',2)
  insMineral.run('AU','金矿石',4.2,'#FFD700','3.5g/t','极高','精炼厂C区',3)

  const insUnit = db.prepare('INSERT INTO transport_units (unit_id,name,driver,phase_offset,sort_order) VALUES (?,?,?,?,?)')
  insUnit.run('T01','1号矿卡','张鹏',0.0,1)
  insUnit.run('T02','2号矿卡','刘威',0.33,2)
  insUnit.run('T03','3号矿卡','王超',0.66,3)

  const insPit = db.prepare('INSERT INTO mining_pit_specs (pit_key,model_id,name,cartesian,lon_lat,radius) VALUES (?,?,?,?,?,?)')
  insPit.run('pit1','d645920e395fedad7bbbed0eca3fe2e0','采场模型1','[-2178472.525158,4385068.251249,4073979.895907]','{"x":116.391178,"y":39.901187,"z":-27.68}',1217.7)
  insPit.run('pit2','d67d8ab4f4c10bf22aa353e27879133c','采场模型2','[-2178458.198413,4385055.390495,4073957.614462]','{"x":116.391054,"y":39.901173,"z":-23.34}',993.82)

  const insMetric = db.prepare('INSERT INTO stress_metrics (metric_key,label,sort_order) VALUES (?,?,?)')
  const metrics = [
    ['von_mises','等效应力（von Mises）',1],['principal_1','最大主应力（σ1）',2],
    ['principal_2','中间主应力（σ2）',3],['principal_3','最小主应力（σ3）',4],
    ['max_abs_normal','三向正应力合成',5],['mean_stress','平均应力',6],
    ['pressure','静水压力',7],['j2','第二偏应力不变量（J2）',8],
    ['tau_max','最大剪应力（τmax）',9],['tau_oct','八面体剪应力（τoct）',10],
    ['sxx','σxx',11],['syy','σyy',12],['szz','σzz',13],
    ['sxy','σxy',14],['syz','σyz',15],['szx','σzx',16],
    ['snn','方向正应力（σnn）',17],['tau_n','方向剪应力（τn）',18],
    ['safety_score','综合安全评分',19]
  ]
  for (const m of metrics) insMetric.run(...m)

  const insRamp = db.prepare('INSERT INTO heatmap_ramps (value,color,label,sort_order) VALUES (?,?,?,?)')
  const ramps = [
    [0.0,'#000080','极低应力',1],[0.1667,'#0066CC','低应力',2],
    [0.3333,'#00CCFF','应力调整',3],[0.5,'#00CC66','轻微集中',4],
    [0.625,'#99CC00','弱岩爆倾向',5],[0.7083,'#FFCC00','黄色预警',6],
    [0.7917,'#FF8800','橙色报警',7],[0.875,'#FF0000','红色危险',8],
    [1.0,'#990000','严重破坏',9]
  ]
  for (const r of ramps) insRamp.run(...r)

  const insRule = db.prepare('INSERT INTO warning_rules (rule_id,metric,level,title,sort_order) VALUES (?,?,?,?,?)')
  const rules = [
    ['safety_score_critical','safety_score','red','综合安全评分 — 极高风险',1],
    ['safety_score_high','safety_score','orange','综合安全评分 — 高风险',2],
    ['safety_score_warning','safety_score','yellow','综合安全评分 — 中风险',3],
    ['hoek_brown_critical','hb_utilization','red','Hoek-Brown 接近峰值强度',4],
    ['hoek_brown_yield','hb_utilization','orange','Hoek-Brown 进入屈服阶段',5],
    ['mc_shear_failure','mc_shear_util','red','Mohr-Coulomb 剪切破坏临近',6],
    ['mc_tension_failure','mc_tension_util','red','Mohr-Coulomb 拉伸破坏临近',7],
    ['von_mises_critical','von_mises_util','red','等效应力达到破坏阶段',8],
    ['von_mises_elevated','von_mises_util','orange','等效应力偏高',9],
    ['rockburst_strong','rockburst_ratio','red','强岩爆风险',10],
    ['rockburst_moderate','rockburst_ratio','orange','中等岩爆风险',11],
    ['rockburst_weak','rockburst_ratio','yellow','弱岩爆风险',12]
  ]
  for (const r of rules) insRule.run(...r)

  const insOre = db.prepare('INSERT INTO geology_orebodies (orebody_id,name,grade,reserves,thickness,bbox_min_x,bbox_max_x,bbox_min_y,bbox_max_y,bbox_min_z,bbox_max_z) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  insOre.run('ore1','主矿体',2.5,500,12.5,0,100,0,100,0,50)
  insOre.run('ore2','北翼延伸',1.2,120,8.0,100,150,0,50,0,30)

  const insStat = db.prepare('INSERT INTO geology_stats (stat_key,stat_value) VALUES (?,?)')
  insStat.run('average_thickness',15.4)
  insStat.run('mineralization_intensity',0.85)
  insStat.run('estimated_reserves',620)
  insStat.run('average_grade',1.85)

  const insExp = db.prepare('INSERT INTO experiment_presets (preset_id,label,description,config_json,sort_order) VALUES (?,?,?,?,?)')
  insExp.run('visual_contrast','强对比可视化','45个稀疏采样点','{"dataGeneration":{"pointCount":45,"noiseLevel":0.1}}',1)
  insExp.run('small_dense','小规模密集点','100个采样点','{"dataGeneration":{"pointCount":100,"noiseLevel":0.02}}',2)
  insExp.run('medium_sparse','中等规模稀疏','60个采样点','{"dataGeneration":{"pointCount":60,"noiseLevel":0.08}}',3)
  insExp.run('large_noisy','大规模含噪','200个采样点','{"dataGeneration":{"pointCount":200,"noiseLevel":0.15}}',4)
  insExp.run('gradient_field','梯度应力场','梯度+高斯峰','{"dataGeneration":{"pointCount":150,"noiseLevel":0.05}}',5)

  const insMethod = db.prepare('INSERT INTO experiment_methods (method_key,label,title,formula,description) VALUES (?,?,?,?,?)')
  insMethod.run('idw','IDW（反距离加权）','IDW','Z(x)=Σ(wᵢZᵢ)/Σwᵢ','确定性插值')
  insMethod.run('kriging','Kriging（克里金）','Kriging','Z*(x)=ΣλᵢZ(xᵢ)','最优线性无偏估计')
  insMethod.run('kriging_exponential','Kriging-指数模型','指数','γ(h)=C₀+C₁[1−exp(−3h/a)]','指数衰减')
  insMethod.run('kriging_gaussian','Kriging-高斯模型','高斯','γ(h)=C₀+C₁[1−exp(−3h²/a²)]','强相关')
  insMethod.run('kriging_spherical','Kriging-球状模型','球状','γ(h)=C₀+C₁[1.5h/a−0.5(h/a)³]','有变程')

  db.prepare('INSERT INTO experiment_default_config (id,config_json) VALUES (1,?)').run('{"fieldSize":[200,200,100],"pointCount":150,"seed":2026}')

  const insDisp = db.prepare('INSERT INTO display_quality_profiles (quality_level,profile_type,config_json) VALUES (?,?,?)')
  insDisp.run('low','display','{"resolutionScale":0.65,"fxaa":false}')
  insDisp.run('medium','display','{"resolutionScale":0.85,"fxaa":false}')
  insDisp.run('high','display','{"resolutionScale":1,"fxaa":false}')
  insDisp.run('low','terrain','{"maximumScreenSpaceError":32}')
  insDisp.run('medium','terrain','{"maximumScreenSpaceError":16}')
  insDisp.run('high','terrain','{"maximumScreenSpaceError":8}')

  const insBlast = db.prepare('INSERT INTO blasting_configs (config_key,config_value) VALUES (?,?)')
  insBlast.run('default_blast_center','{"lon":116.3915,"lat":39.9015,"height":0}')
  insBlast.run('example_holes','[{"id":"H1","diameter":0.09,"chargeKg":45,"delayMs":0},{"id":"H2","diameter":0.09,"chargeKg":48,"delayMs":25}]')
  insBlast.run('example_rock_blocks','[{"id":"RB1","size":0.35,"weightKg":60},{"id":"RB2","size":0.52,"weightKg":125}]')

  const insTruck = db.prepare('INSERT INTO truck_configs (truck_id,name,driver,driver_info,vehicle_info,mineral_type,phase) VALUES (?,?,?,?,?,?,?)')
  insTruck.run('T001','1号矿卡','张鹏','{"age":35,"experience":"8年","license":"A2"}','{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}','{"code":"CU","name":"铜矿石","grade":"1.2%","destination":"冶炼厂A区","color":"#B87333"}',0.0)
  insTruck.run('T002','2号矿卡','刘威','{"age":42,"experience":"12年","license":"A2"}','{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}','{"code":"FE","name":"铁矿石","grade":"45%","destination":"选矿厂B区","color":"#8B4513"}',0.33)
  insTruck.run('T003','3号矿卡','王超','{"age":28,"experience":"5年","license":"A2"}','{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}','{"code":"AU","name":"金矿石","grade":"3.5g/t","destination":"精炼厂C区","color":"#FFD700"}',0.66)

  const insSim = db.prepare('INSERT INTO simulation_configs (config_key,config_value) VALUES (?,?)')
  insSim.run('monitoring_tick_ms','{"value":1000}')
  insSim.run('speed_profile','{"loading":{"min":4,"max":6},"loadedTransport":{"min":23,"max":30},"unloading":{"min":4,"max":6},"emptyReturn":{"min":30,"max":38}}')
  insSim.run('phase_ratio','{"loading":0.15,"loadedTransport":0.35,"unloading":0.15,"emptyReturn":0.35}')
  insSim.run('heatmap_panel_defaults','{"contrast":2.2,"gamma":0.65,"blendMode":"max"}')
}

const tableCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c
console.log(`[DB] SQLite 数据库就绪: ${DB_PATH} (${tableCount} 张表)`)

module.exports = db
