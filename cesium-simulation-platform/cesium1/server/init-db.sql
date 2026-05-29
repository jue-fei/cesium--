-- ============================================================
-- Cesium 矿山仿真平台 - 数据库初始化脚本
-- 数据库: cesium_platform
-- 字符集: utf8mb4
-- ============================================================

CREATE DATABASE IF NOT EXISTS `cesium_platform`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `cesium_platform`;

-- ============================================================
-- 1. 3D 模型配置索引 (来自 models.json)
-- ============================================================
CREATE TABLE IF NOT EXISTS `model_configs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL COMMENT '模型配置名称',
  `path` VARCHAR(255) NOT NULL COMMENT 'feature.json 路径',
  `sort_order` INT DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='3D模型配置索引';

INSERT INTO `model_configs` (`name`, `path`, `sort_order`) VALUES
('demo1 配置', '/3d/demo1/feature.json', 1),
('demo2 配置', '/3d/demo2/features.json', 2),
('demo3 配置', '/3d/demo3/feature.json', 3),
('demo4 配置', '/3d/demo4/feature.json', 4);

-- ============================================================
-- 2. 模型属性定义 (来自 feature.json modelMappings)
-- ============================================================
CREATE TABLE IF NOT EXISTS `model_features` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `model_config_id` INT NOT NULL,
  `feature_id` VARCHAR(64) NOT NULL COMMENT '模型feature唯一ID',
  `name` VARCHAR(100) NOT NULL COMMENT '模型名称',
  `type` VARCHAR(50) DEFAULT NULL COMMENT '类型: surface/terrain/mining_pit/ore_body/waste_rock',
  `category` VARCHAR(50) DEFAULT NULL COMMENT '分类: 地形地貌/采矿工程/矿产资源',
  `style_properties` JSON DEFAULT NULL COMMENT '样式属性(color/opacity/visible/highlightColor)',
  `geology_properties` JSON DEFAULT NULL COMMENT '地质属性',
  `mining_properties` JSON DEFAULT NULL COMMENT '采矿属性',
  `safety_properties` JSON DEFAULT NULL COMMENT '安全属性',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_feature_id` (`feature_id`),
  INDEX `idx_model_config` (`model_config_id`),
  FOREIGN KEY (`model_config_id`) REFERENCES `model_configs`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='模型属性定义';

-- demo4 的模型属性 (默认模型)
INSERT INTO `model_features` (`model_config_id`, `feature_id`, `name`, `type`, `category`, `style_properties`, `geology_properties`, `mining_properties`, `safety_properties`) VALUES
(4, 'a5771bce93e200c36f7cd9dfd0e5deaa', '地表模型-4', 'surface', '地形地貌',
 '{"color":"#f6f4f4","opacity":0.9,"visible":true,"highlightColor":"#CDDC39"}',
 '{"地质类型":"地表层","地貌特征":"矿山地表","土地利用":"采矿作业区","植被覆盖":"稀疏","地表物质":"残坡积物","侵蚀程度":"中等","稳定性":"一般","工程地质条件":"需边坡支护"}',
 '{"开采影响":"直接受影响","复垦要求":"需要复垦","监测重点":"地表沉降","安全等级":"B级"}',
 '{}'),
(4, '3416a75f4cea9109507cacd8e2f2aefc', '地形模型', 'terrain', '地形地貌',
 '{"color":"#ffffff","opacity":0.8,"visible":true,"highlightColor":"#5D4037"}',
 '{"地质类型":"地形模型","地形特征":"数字高程","高程范围":"动态计算","坡度分布":"需分析","地形起伏":"中等","用途":"地形分析基础"}',
 '{"开采规划依据":"是","排水设计参考":"是","运输路线规划":"需要"}',
 '{}'),
(4, 'd645920e395fedad7bbbed0eca3fe2e0', '采场模型1', 'mining_pit', '采矿工程',
 '{"color":"#ffffff","opacity":0.85,"visible":true,"highlightColor":"#FF5722"}',
 '{"地质类型":"露天采场","开采方式":"露天开采","采场阶段":"一期","边坡角度":"需测量","坑底标高":"需测量","安全平台":"需要设置","排水系统":"需要完善"}',
 '{"开采状态":"正在开采","采矿方法":"台阶式开采","设备配置":"挖掘机、卡车","生产能力":"待评估","剩余储量":"需计算","服务年限":"待评估"}',
 '{"边坡稳定性":"需要监测","滑坡风险":"中等","监测点数量":"需要布设","安全措施":"边坡雷达监测"}'),
(4, 'd67d8ab4f4c10bf22aa353e27879133c', '采场模型2', 'mining_pit', '采矿工程',
 '{"color":"#ffffff","opacity":0.85,"visible":true,"highlightColor":"#D84315"}',
 '{"地质类型":"露天采场","开采方式":"露天开采","采场阶段":"二期","边坡角度":"需测量","坑底标高":"需测量","与采场1关系":"相邻","开采顺序":"后续开采"}',
 '{"开采状态":"规划中","采矿方法":"台阶式开采","设备配置":"待配置","预计产能":"待评估","预计储量":"需计算","开采时间":"未来计划"}',
 '{"边坡稳定性":"需要设计","对采场1影响":"需要评估","安全距离":"需要确定"}'),
(4, '17e62166fc8586dfa4d1bc0e1742c08b', '矿体模型', 'ore_body', '矿产资源',
 '{"color":"#ffffff","opacity":0.9,"visible":true,"highlightColor":"#B71C1C"}',
 '{"地质类型":"矿体","矿石类型":"待鉴定","赋存状态":"层状/脉状","产状要素":"需测量","围岩性质":"待分析","构造控制":"需要研究","蚀变特征":"需要描述"}',
 '{"资源储量":"待计算","平均品位":"待化验","开采价值":"待评估","开采技术条件":"需要研究","可选性":"待试验","经济价值":"待评估"}',
 '{}'),
(4, 'a1d0c6e83f027327d8461063f4ac58a6', '夹石模型', 'waste_rock', '矿产资源',
 '{"color":"#ffffff","opacity":0.7,"visible":true,"highlightColor":"#616161"}',
 '{"地质类型":"夹石","岩石类型":"待鉴定","成因":"岩浆分异/沉积间层","与矿体关系":"穿插/包裹","分布特征":"需要研究","厚度变化":"需要测量"}',
 '{"剥离量":"待计算","处理方式":"排土场堆放","综合利用":"可能性评估","对采矿影响":"增加剥离成本","分采分选":"需要研究"}',
 '{}'),
(4, 'eb160de1de89d9058fcb0b968dbbbd68', '巷道一', 'surface', '地形地貌',
 '{"color":"#8BC34A","opacity":0.9,"visible":true,"highlightColor":"#CDDC39"}',
 '{"地质类型":"地表层","地貌特征":"矿山地表","土地利用":"采矿作业区","植被覆盖":"稀疏","地表物质":"残坡积物","侵蚀程度":"中等","稳定性":"一般","工程地质条件":"需边坡支护"}',
 '{"开采影响":"直接受影响","复垦要求":"需要复垦","监测重点":"地表沉降","安全等级":"B级"}',
 '{}'),
(4, '812b4ba287f5ee0bc9d43bbf5bbe87fb', '2', 'unknown', 'Unknown',
 '{"color":"#ffffff","opacity":1,"visible":true,"highlightColor":"#ffffff"}',
 '{"地质类型":"Unknown","ID":"812b4ba287f5ee0bc9d43bbf5bbe87fb"}',
 '{}',
 '{}');

-- ============================================================
-- 3. 模型全局属性 (来自 feature.json globalProperties)
-- ============================================================
CREATE TABLE IF NOT EXISTS `model_global_props` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `model_config_id` INT NOT NULL,
  `project_name` VARCHAR(200) DEFAULT NULL,
  `coord_system` VARCHAR(50) DEFAULT 'WGS84',
  `data_source` VARCHAR(200) DEFAULT NULL,
  `last_update` VARCHAR(50) DEFAULT NULL,
  `manager` VARCHAR(50) DEFAULT NULL,
  `remarks` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`model_config_id`) REFERENCES `model_configs`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='模型全局属性';

INSERT INTO `model_global_props` (`model_config_id`, `project_name`, `coord_system`, `data_source`, `last_update`, `manager`, `remarks`) VALUES
(4, '某矿山三维地质模型', 'WGS84', '地质勘查+三维建模', '2024-01-15', '待指定', '属性值中"待XX"的字段需要根据实际情况填写');

-- ============================================================
-- 4. 应用设置 (来自 appConfig.js + modelConfig.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `app_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `setting_key` VARCHAR(100) NOT NULL UNIQUE,
  `setting_value` JSON NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='应用级配置设置';

INSERT INTO `app_settings` (`setting_key`, `setting_value`, `description`) VALUES
('ore_grade_thresholds', '{"HIGH":3.0,"MEDIUM":2.0}', '矿品位阈值'),
('model_defaults', '{"OPACITY":100,"VISIBLE":true}', '模型默认显示配置'),
('highlight_config', '{"COLOR":"#ffff00","DURATION":1000}', '高亮配置'),
('borehole_config', '{"COLOR":"#ff0000","ALPHA":0.8,"DEPTH_FAIL_ALPHA":0.3,"WIDTH":3,"MARKER_SIZE":24}', '钻孔配置'),
('section_config', '{"COLOR":"#0000ff","ALPHA":0.7,"DEPTH_FAIL_ALPHA":0.3,"WIDTH":2}', '剖面配置'),
('default_ore_density', '{"value":2.5}', '默认矿石密度'),
('id_prefix', '{"value":"feature_"}', 'Feature ID前缀'),
('default_position', '{"longitude":113.323,"latitude":23.106,"height":-26}', '默认模型位置'),
('default_transform', '{"rotationX":15,"rotationY":0,"rotationZ":0}', '默认模型变换'),
('default_model_config_path', '{"value":"/3d/demo4/feature.json"}', '默认模型配置路径'),
('default_lod_config', '{"maximumScreenSpaceError":16,"cacheBytes":536870912,"maximumCacheOverflowBytes":536870912,"cullWithChildrenBounds":true,"dynamicScreenSpaceError":true,"dynamicScreenSpaceErrorDensity":0.0002,"dynamicScreenSpaceErrorFactor":24,"dynamicScreenSpaceErrorHeightFalloff":0.25,"cullRequestsWhileMoving":true,"cullRequestsWhileMovingMultiplier":60,"preferLeaves":false,"foveatedScreenSpaceError":true,"foveatedConeSize":0.1,"foveatedMinimumScreenSpaceErrorRelaxation":0,"foveatedTimeDelay":0.2,"skipLevelOfDetail":false,"baseScreenSpaceError":1024,"skipScreenSpaceErrorFactor":16,"skipLevels":1,"immediatelyLoadDesiredLevelOfDetail":false,"loadSiblings":false,"preloadWhenHidden":false,"preloadFlightDestinations":true,"progressiveResolutionHeightFraction":0.3}', '默认LOD配置'),
('lod_presets', '{"high_quality":{"displayName":"高质量","config":{"maximumScreenSpaceError":8,"cacheBytes":1073741824,"maximumCacheOverflowBytes":1073741824,"dynamicScreenSpaceError":true,"foveatedScreenSpaceError":false,"skipLevelOfDetail":false,"preloadFlightDestinations":true}},"balanced":{"displayName":"平衡","config":{"maximumScreenSpaceError":16}},"performance":{"displayName":"高性能","config":{"maximumScreenSpaceError":32,"cacheBytes":268435456,"maximumCacheOverflowBytes":268435456,"dynamicScreenSpaceError":true,"skipLevelOfDetail":true,"skipLevels":2,"cullRequestsWhileMoving":true,"cullRequestsWhileMovingMultiplier":80,"foveatedScreenSpaceError":true,"foveatedConeSize":0.12,"foveatedTimeDelay":0.35,"preloadWhenHidden":false}}}', 'LOD预设方案'),
('adaptive_load_config', '{"enabled":true,"lowFpsThreshold":24,"pressureFpsThreshold":32,"recoverFpsThreshold":48,"degradeAfterSamples":3,"recoverAfterSamples":5,"cooldownMs":4000,"pendingRequestsThreshold":12,"tilesProcessingThreshold":8,"memoryThresholdMb":768,"steps":[{"label":"提高细节阈值","branch":"standard","lodConfig":{"maximumScreenSpaceError":32}},{"label":"切换低精度分支","branch":"low_precision","lodConfig":{"maximumScreenSpaceError":48,"skipLevelOfDetail":true,"skipLevels":2,"immediatelyLoadDesiredLevelOfDetail":true,"loadSiblings":false,"dynamicScreenSpaceError":true,"dynamicScreenSpaceErrorFactor":32},"displayQuality":"medium"},{"label":"降低地形影像分辨率","branch":"low_precision","lodConfig":{"maximumScreenSpaceError":64,"skipLevelOfDetail":true,"skipLevels":3,"immediatelyLoadDesiredLevelOfDetail":true,"progressiveResolutionHeightFraction":0.5,"foveatedConeSize":0.18,"foveatedTimeDelay":0.5},"displayQuality":"low","terrainQuality":"low"}]}', '自适应降级加载配置');

-- ============================================================
-- 5. 工具注册表 (来自 toolRegistry.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `tool_registry` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `tool_id` VARCHAR(50) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `icon` VARCHAR(50) NOT NULL,
  `component_path` VARCHAR(255) NOT NULL COMMENT '组件懒加载路径',
  `sort_order` INT DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='功能工具注册表';

INSERT INTO `tool_registry` (`tool_id`, `name`, `icon`, `component_path`, `sort_order`) VALUES
('model_control', '模型控制', 'Location', '@/features/model-control/components/ModelTransformPanel.vue', 1),
('geology', '地质分析', 'Monitor', '@/features/geology-analysis/components/GeologyPanel.vue', 2),
('measure', '测量分析', 'Ruler', '@/features/measurement-analysis/components/MeasurementPanel.vue', 3),
('clipping', '模型切割', 'Scissor', '@/features/model-clipping/components/ClippingPanel.vue', 4),
('monitoring', '现场调度中心', 'DataLine', '@/features/realtime-monitoring/components/MonitoringPanel.vue', 5),
('blasting', '爆破模拟', 'VideoPlay', '@/features/blasting-simulation/components/BlastingPanel.vue', 6),
('lod', 'LOD优化', 'Odometer', '@/features/lod-optimization/components/LodPanel.vue', 7),
('stress', '应力分析', 'Histogram', '@/features/stress-analysis/components/StressPanel.vue', 8),
('experiment', '实验分析', 'DataAnalysis', '@/features/experiment-analysis/components/ExperimentPanel.vue', 9),
('system', '系统工具', 'Setting', '@/features/system-tools/components/SystemTools.vue', 10);

-- ============================================================
-- 6. 相机预设位 (来自 monitoringDefaults.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `camera_presets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `preset_id` VARCHAR(50) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `emoji` VARCHAR(10) DEFAULT NULL,
  `destination` JSON NOT NULL COMMENT '{x,y,z} 经纬度坐标',
  `heading` DOUBLE DEFAULT 0,
  `pitch` DOUBLE DEFAULT 0,
  `roll` DOUBLE DEFAULT 0,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='相机预设位';

INSERT INTO `camera_presets` (`preset_id`, `name`, `description`, `emoji`, `destination`, `heading`, `pitch`, `roll`, `sort_order`) VALUES
('overview', '总览镜头', '查看采场1、采场2及矿卡整体运行', '🗺️',
 '{"x":116.391156,"y":39.901164,"z":800}', 0, -1.2, 0, 1),
('loading', '装载区镜头', '查看采场1矿卡装载位置', '⛏️',
 '{"x":116.391178,"y":39.901187,"z":200}', 0.5, -0.7, 0, 2),
('road', '运输线镜头', '查看采场1到采场2运输线路', '🛣️',
 '{"x":116.391116,"y":39.901180,"z":300}', 0.8, -0.8, 0, 3),
('dump', '卸载区镜头', '查看采场2矿卡卸载位置', '📤',
 '{"x":116.391054,"y":39.901173,"z":200}', -1.2, -0.7, 0, 4);

-- ============================================================
-- 7. 矿物类型 (来自 monitoringDefaults.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `mineral_types` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(10) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `density` DOUBLE DEFAULT 0,
  `color` VARCHAR(10) DEFAULT '#ffffff',
  `grade` VARCHAR(20) DEFAULT NULL,
  `value_level` VARCHAR(20) DEFAULT NULL,
  `destination` VARCHAR(100) DEFAULT NULL,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='矿物类型定义';

INSERT INTO `mineral_types` (`code`, `name`, `density`, `color`, `grade`, `value_level`, `destination`, `sort_order`) VALUES
('CU', '铜矿石', 2.8, '#B87333', '1.2%', '高', '冶炼厂A区', 1),
('FE', '铁矿石', 3.5, '#8B4513', '45%', '中', '选矿厂B区', 2),
('AU', '金矿石', 4.2, '#FFD700', '3.5g/t', '极高', '精炼厂C区', 3);

-- ============================================================
-- 8. 矿卡运输单元 (来自 monitoringDefaults.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `transport_units` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `unit_id` VARCHAR(20) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `driver` VARCHAR(30) DEFAULT NULL,
  `phase_offset` DOUBLE DEFAULT 0,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='矿卡运输单元定义';

INSERT INTO `transport_units` (`unit_id`, `name`, `driver`, `phase_offset`, `sort_order`) VALUES
('T01', '1号矿卡', '张鹏', 0.0, 1),
('T02', '2号矿卡', '刘威', 0.33, 2),
('T03', '3号矿卡', '王超', 0.66, 3);

-- ============================================================
-- 9. 采场模型规格 (来自 monitoringDefaults.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `mining_pit_specs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `pit_key` VARCHAR(20) NOT NULL UNIQUE,
  `model_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(50) NOT NULL,
  `cartesian` JSON NOT NULL COMMENT '[x,y,z]笛卡尔坐标',
  `lon_lat` JSON NOT NULL COMMENT '{x,y,z}经纬度坐标',
  `radius` DOUBLE DEFAULT 0
) ENGINE=InnoDB COMMENT='采场模型规格';

INSERT INTO `mining_pit_specs` (`pit_key`, `model_id`, `name`, `cartesian`, `lon_lat`, `radius`) VALUES
('pit1', 'd645920e395fedad7bbbed0eca3fe2e0', '采场模型1',
 '[-2178472.525158,4385068.251249,4073979.895907]',
 '{"x":116.391178,"y":39.901187,"z":-27.68}', 1217.7),
('pit2', 'd67d8ab4f4c10bf22aa353e27879133c', '采场模型2',
 '[-2178458.198413,4385055.390495,4073957.614462]',
 '{"x":116.391054,"y":39.901173,"z":-23.34}', 993.82);

-- ============================================================
-- 10. 应力指标定义 (来自 computation/index.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `stress_metrics` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `metric_key` VARCHAR(50) NOT NULL UNIQUE,
  `label` VARCHAR(100) NOT NULL,
  `is_base_metric` TINYINT(1) DEFAULT 1,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='应力分析指标定义';

INSERT INTO `stress_metrics` (`metric_key`, `label`, `is_base_metric`, `sort_order`) VALUES
('von_mises', '等效应力（von Mises）', 1, 1),
('principal_1', '最大主应力（σ1）', 1, 2),
('principal_2', '中间主应力（σ2）', 1, 3),
('principal_3', '最小主应力（σ3）', 1, 4),
('max_abs_normal', '三向正应力合成（最大绝对值）', 1, 5),
('mean_stress', '平均应力（p=tr(σ)/3）', 1, 6),
('pressure', '静水压力（-p）', 1, 7),
('j2', '第二偏应力不变量（J2）', 1, 8),
('tau_max', '最大剪应力（τmax）', 1, 9),
('tau_oct', '八面体剪应力（τoct）', 1, 10),
('sxx', 'σxx', 1, 11),
('syy', 'σyy', 1, 12),
('szz', 'σzz', 1, 13),
('sxy', 'σxy', 1, 14),
('syz', 'σyz', 1, 15),
('szx', 'σzx', 1, 16),
('snn', '方向正应力（σnn）', 1, 17),
('tau_n', '方向剪应力（τn）', 1, 18),
('safety_score', '综合安全评分', 1, 19);

-- ============================================================
-- 11. 热力图色带 (来自 heatmapPalette.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `heatmap_ramps` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `value` DOUBLE NOT NULL COMMENT '归一化值 0-1',
  `color` VARCHAR(10) NOT NULL,
  `label` VARCHAR(30) NOT NULL,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='热力图色带定义';

INSERT INTO `heatmap_ramps` (`value`, `color`, `label`, `sort_order`) VALUES
(0.0, '#000080', '极低应力', 1),
(0.1667, '#0066CC', '低应力', 2),
(0.3333, '#00CCFF', '应力调整', 3),
(0.5, '#00CC66', '轻微集中', 4),
(0.625, '#99CC00', '弱岩爆倾向', 5),
(0.7083, '#FFCC00', '黄色预警', 6),
(0.7917, '#FF8800', '橙色报警', 7),
(0.875, '#FF0000', '红色危险', 8),
(1.0, '#990000', '严重破坏', 9);

-- ============================================================
-- 12. 预警规则 (来自 warningEngine.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `warning_rules` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `rule_id` VARCHAR(50) NOT NULL UNIQUE,
  `metric` VARCHAR(50) NOT NULL,
  `level` ENUM('red','orange','yellow') NOT NULL,
  `title` VARCHAR(100) NOT NULL,
  `description_template` VARCHAR(500) DEFAULT NULL,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='预警规则定义';

INSERT INTO `warning_rules` (`rule_id`, `metric`, `level`, `title`, `description_template`, `sort_order`) VALUES
('safety_score_critical', 'safety_score', 'red', '综合安全评分 — 极高风险', '综合安全评分达极高风险等级，需立即检查', 1),
('safety_score_high', 'safety_score', 'orange', '综合安全评分 — 高风险', '综合安全评分进入高风险区间，建议加密监测', 2),
('safety_score_warning', 'safety_score', 'yellow', '综合安全评分 — 中风险', '综合安全评分中风险区间，保持常规监测', 3),
('hoek_brown_critical', 'hb_utilization', 'red', 'Hoek-Brown 接近峰值强度', 'Hoek-Brown σ₁/σ₁_peak ≥ 95%，裂隙网络贯通，接近极限承载', 4),
('hoek_brown_yield', 'hb_utilization', 'orange', 'Hoek-Brown 进入屈服阶段', 'Hoek-Brown σ₁/σ₁_peak ≥ 75%，塑性变形显著发展', 5),
('mc_shear_failure', 'mc_shear_util', 'red', 'Mohr-Coulomb 剪切破坏临近', '剪切利用率 ≥ 90%，τ_max → c + σₙ·tanφ，可能发生剪切滑移破坏', 6),
('mc_tension_failure', 'mc_tension_util', 'red', 'Mohr-Coulomb 拉伸破坏临近', '拉应力利用率 ≥ 85%，接近抗拉截断值，可能发生张拉裂隙/剥离', 7),
('von_mises_critical', 'von_mises_util', 'red', '等效应力达到破坏阶段', 'von Mises / 参考强度 ≥ 90%', 8),
('von_mises_elevated', 'von_mises_util', 'orange', '等效应力偏高', 'von Mises / 参考强度 60%-90%，进入损伤-屈服阶段', 9),
('rockburst_strong', 'rockburst_ratio', 'red', '强岩爆风险 (σ_θ/σ_c ≥ 0.55)', '岩体可能弹射抛射，伴随巨响和冲击波', 10),
('rockburst_moderate', 'rockburst_ratio', 'orange', '中等岩爆风险 (0.3 ≤ σ_θ/σ_c < 0.55)', '可能出现片帮、弹射，伴随清脆爆裂声', 11),
('rockburst_weak', 'rockburst_ratio', 'yellow', '弱岩爆风险 (σ_θ/σ_c < 0.3)', '可能有轻微剥落或小片帮', 12);

-- ============================================================
-- 13. 地质示例数据 (来自 geologyDemoData.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `geology_orebodies` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `orebody_id` VARCHAR(20) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `grade` DOUBLE DEFAULT 0,
  `reserves` DOUBLE DEFAULT 0 COMMENT '储量(万吨)',
  `thickness` DOUBLE DEFAULT 0 COMMENT '厚度(m)',
  `bbox_min_x` DOUBLE DEFAULT 0,
  `bbox_max_x` DOUBLE DEFAULT 0,
  `bbox_min_y` DOUBLE DEFAULT 0,
  `bbox_max_y` DOUBLE DEFAULT 0,
  `bbox_min_z` DOUBLE DEFAULT 0,
  `bbox_max_z` DOUBLE DEFAULT 0
) ENGINE=InnoDB COMMENT='矿体示例数据';

INSERT INTO `geology_orebodies` (`orebody_id`, `name`, `grade`, `reserves`, `thickness`, `bbox_min_x`, `bbox_max_x`, `bbox_min_y`, `bbox_max_y`, `bbox_min_z`, `bbox_max_z`) VALUES
('ore1', '主矿体', 2.5, 500, 12.5, 0, 100, 0, 100, 0, 50),
('ore2', '北翼延伸', 1.2, 120, 8.0, 100, 150, 0, 50, 0, 30);

CREATE TABLE IF NOT EXISTS `geology_stats` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `stat_key` VARCHAR(50) NOT NULL UNIQUE,
  `stat_value` DOUBLE NOT NULL
) ENGINE=InnoDB COMMENT='地质统计数据';

INSERT INTO `geology_stats` (`stat_key`, `stat_value`) VALUES
('average_thickness', 15.4),
('mineralization_intensity', 0.85),
('estimated_reserves', 620),
('average_grade', 1.85);

-- ============================================================
-- 14. 实验预设配置 (来自 experimentDefaults.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `experiment_presets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `preset_id` VARCHAR(50) NOT NULL UNIQUE,
  `label` VARCHAR(50) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `config_json` JSON NOT NULL,
  `sort_order` INT DEFAULT 0
) ENGINE=InnoDB COMMENT='实验预设配置';

INSERT INTO `experiment_presets` (`preset_id`, `label`, `description`, `config_json`, `sort_order`) VALUES
('visual_contrast', '强对比可视化场景', '45 个稀疏采样点，梯度峰值应力场，三类 Kriging 模型同时对比，便于肉眼观察差异',
 '{"dataGeneration":{"pointCount":45,"noiseLevel":0.1,"anomalyCount":6,"anomalyMagnitude":2.2,"trendType":"gradient_peak"},"comparison":{"krigingModels":["exponential","gaussian","spherical"]}}', 1),
('small_dense', '小规模密集点', '100 个采样点，低噪声，适合验证基本插值精度',
 '{"dataGeneration":{"pointCount":100,"noiseLevel":0.02,"anomalyCount":3}}', 2),
('medium_sparse', '中等规模稀疏点', '60 个采样点，中等噪声，模拟实际钻孔数据分布',
 '{"dataGeneration":{"pointCount":60,"noiseLevel":0.08,"anomalyCount":5}}', 3),
('large_noisy', '大规模含噪点', '200 个采样点，高噪声+异常值，检验算法鲁棒性',
 '{"dataGeneration":{"pointCount":200,"noiseLevel":0.15,"anomalyCount":12,"anomalyMagnitude":2.5}}', 4),
('gradient_field', '梯度应力场', '线性梯度+高斯峰混合场，模拟真实地质应力分布',
 '{"dataGeneration":{"pointCount":150,"noiseLevel":0.05,"anomalyCount":6,"trendType":"gradient_peak"}}', 5);

CREATE TABLE IF NOT EXISTS `experiment_methods` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `method_key` VARCHAR(50) NOT NULL UNIQUE,
  `label` VARCHAR(100) NOT NULL,
  `title` VARCHAR(100) DEFAULT NULL,
  `formula` VARCHAR(200) DEFAULT NULL,
  `description` TEXT DEFAULT NULL
) ENGINE=InnoDB COMMENT='实验方法定义';

INSERT INTO `experiment_methods` (`method_key`, `label`, `title`, `formula`, `description`) VALUES
('idw', 'IDW（反距离加权）', 'IDW — 反距离加权插值', 'Z(x) = Σ(wᵢ · Zᵢ) / Σwᵢ ， wᵢ = 1/d(x, xᵢ)ᵖ', 'IDW是一种确定性空间插值方法，核心假设是"距离越近的点对目标点的贡献越大"。'),
('kriging', 'Kriging（普通克里金）', 'Kriging — 克里金插值', 'Z*(x) = Σλᵢ · Z(xᵢ)， λ = K⁻¹k', 'Kriging是一种基于变异函数的最优线性无偏估计方法，同时考虑距离和空间相关性结构。'),
('idw_optimized', 'IDW-PSO（PSO优化）', NULL, NULL, NULL),
('idw_default', 'IDW（默认参数）', NULL, NULL, NULL),
('kriging_exponential', 'Kriging（指数模型）', '指数模型', 'γ(h) = C₀ + C₁[1 − exp(−3h/a)]', '空间相关性随距离指数衰减，适合连续渐变的应力场'),
('kriging_gaussian', 'Kriging（高斯模型）', '高斯模型', 'γ(h) = C₀ + C₁[1 − exp(−3h²/a²)]', '近距相关性更强（抛物线起点），适合高度平滑的地质场'),
('kriging_spherical', 'Kriging（球状模型）', '球状模型', 'γ(h) = C₀ + C₁[1.5(h/a) − 0.5(h/a)³]（h≤a时）', '到达变程 a 后相关为零，适合具有明显影响半径的矿体');

CREATE TABLE IF NOT EXISTS `experiment_default_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_json` JSON NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='实验默认配置';

INSERT INTO `experiment_default_config` (`config_json`) VALUES
('{"dataGeneration":{"fieldSize":[200,200,100],"pointCount":150,"testRatio":0.3,"seed":2026,"noiseLevel":0.05,"anomalyCount":8,"anomalyMagnitude":2.0,"trendType":"gaussian_mixture"},"comparison":{"krigingModels":["exponential"],"idwConfig":{"optimizeParameters":false,"neighborPolicy":"sector","sectorCount":8},"krigingConfig":{"model":"exponential"},"gridResolution":32,"crossValidationFolds":5,"repeatCount":5},"metrics":["rmse","mae","r2","maxError","mape"],"chart":{"colors":{"idw":"#409EFF","kriging":"#67C23A","krigingGaussian":"#E6A23C","krigingSpherical":"#F56C6C"}}}');

-- ============================================================
-- 15. 显示质量配置 (来自 viewerQualityProfiles.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `display_quality_profiles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `quality_level` ENUM('low','medium','high') NOT NULL,
  `profile_type` ENUM('display','terrain') NOT NULL,
  `config_json` JSON NOT NULL,
  UNIQUE KEY `uk_level_type` (`quality_level`, `profile_type`)
) ENGINE=InnoDB COMMENT='显示/地形质量配置';

INSERT INTO `display_quality_profiles` (`quality_level`, `profile_type`, `config_json`) VALUES
('low', 'display', '{"resolutionScale":0.65,"useBrowserRecommendedResolution":true,"fxaa":false}'),
('medium', 'display', '{"resolutionScale":0.85,"useBrowserRecommendedResolution":true,"fxaa":false}'),
('high', 'display', '{"resolutionScale":1,"useBrowserRecommendedResolution":true,"fxaa":false}'),
('low', 'terrain', '{"maximumScreenSpaceError":32}'),
('medium', 'terrain', '{"maximumScreenSpaceError":16}'),
('high', 'terrain', '{"maximumScreenSpaceError":8}');

-- ============================================================
-- 16. 爆破模拟配置 (来自 blastingDataCore.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `blasting_configs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_key` VARCHAR(50) NOT NULL UNIQUE,
  `config_value` JSON NOT NULL
) ENGINE=InnoDB COMMENT='爆破模拟配置';

INSERT INTO `blasting_configs` (`config_key`, `config_value`) VALUES
('default_fragment_model_uri', '{"value":"https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb"}'),
('default_playback_speed_ms', '{"value":120}'),
('default_blast_center', '{"lon":116.3915,"lat":39.9015,"height":0}'),
('example_event', '{"id":"BLAST-DEMO-001","name":"示例爆破事件","chargeKg":320}'),
('example_design_face_before', '{"width":10,"height":8,"thickness":0.8,"headingDeg":15}'),
('example_design_face_after', '{"width":10.6,"height":8.5,"thickness":0.8,"headingDeg":15}'),
('example_holes', '[{"id":"H1","row":1,"column":1,"diameter":0.09,"chargeKg":45,"delayMs":0},{"id":"H2","row":1,"column":2,"diameter":0.09,"chargeKg":48,"delayMs":25},{"id":"H3","row":1,"column":3,"diameter":0.09,"chargeKg":51,"delayMs":50},{"id":"H4","row":2,"column":1,"diameter":0.09,"chargeKg":54,"delayMs":75},{"id":"H5","row":2,"column":2,"diameter":0.09,"chargeKg":57,"delayMs":100},{"id":"H6","row":2,"column":3,"diameter":0.09,"chargeKg":60,"delayMs":125}]'),
('example_rock_blocks', '[{"id":"RB1","size":0.35,"weightKg":60},{"id":"RB2","size":0.52,"weightKg":125},{"id":"RB3","size":0.9,"weightKg":360}]'),
('default_blasting_summary', '{"frameCount":0,"fragmentCount":0,"durationSec":0,"maxWaveRadius":0,"holeCount":0,"rockBlockCount":0}');

-- ============================================================
-- 17. 矿卡车辆配置 (来自 RealtimeDataEngine.js)
-- ============================================================
CREATE TABLE IF NOT EXISTS `truck_configs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `truck_id` VARCHAR(20) NOT NULL UNIQUE,
  `name` VARCHAR(50) NOT NULL,
  `driver` VARCHAR(30) NOT NULL,
  `driver_info` JSON DEFAULT NULL COMMENT '{age,experience,license}',
  `vehicle_info` JSON DEFAULT NULL COMMENT '{brand,capacity,maxSpeed}',
  `mineral_type` JSON DEFAULT NULL COMMENT '{code,name,grade,destination,color}',
  `phase` DOUBLE DEFAULT 0
) ENGINE=InnoDB COMMENT='矿卡车辆配置';

INSERT INTO `truck_configs` (`truck_id`, `name`, `driver`, `driver_info`, `vehicle_info`, `mineral_type`, `phase`) VALUES
('T001', '1号矿卡', '张鹏',
 '{"age":35,"experience":"8年","license":"A2"}',
 '{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}',
 '{"code":"CU","name":"铜矿石","grade":"1.2%","destination":"冶炼厂A区","color":"#B87333"}', 0.0),
('T002', '2号矿卡', '刘威',
 '{"age":42,"experience":"12年","license":"A2"}',
 '{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}',
 '{"code":"FE","name":"铁矿石","grade":"45%","destination":"选矿厂B区","color":"#8B4513"}', 0.33),
('T003', '3号矿卡', '王超',
 '{"age":28,"experience":"5年","license":"A2"}',
 '{"brand":"徐工XDE240","capacity":72,"maxSpeed":40}',
 '{"code":"AU","name":"金矿石","grade":"3.5g/t","destination":"精炼厂C区","color":"#FFD700"}', 0.66);

-- ============================================================
-- 18. 模拟参数配置
-- ============================================================
CREATE TABLE IF NOT EXISTS `simulation_configs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_key` VARCHAR(50) NOT NULL UNIQUE,
  `config_value` JSON NOT NULL
) ENGINE=InnoDB COMMENT='模拟参数配置';

INSERT INTO `simulation_configs` (`config_key`, `config_value`) VALUES
('monitoring_tick_ms', '{"value":1000}'),
('max_trajectory_points', '{"value":240}'),
('default_camera_preset_id', '{"value":"overview"}'),
('active_layers', '{"equipment":true,"risk":true}'),
('speed_profile', '{"loading":{"min":4,"max":6},"loadedTransport":{"min":23,"max":30},"unloading":{"min":4,"max":6},"emptyReturn":{"min":30,"max":38}}'),
('phase_ratio', '{"loading":0.15,"loadedTransport":0.35,"unloading":0.15,"emptyReturn":0.35}'),
('vehicle_status', '{"engineTemp":{"min":80,"max":100},"tirePressure":[8.0,8.1,8.2,8.0],"fuelLevel":{"min":60,"max":90}}'),
('heatmap_panel_defaults', '{"contrast":2.2,"gamma":0.65,"cutoff":0.04,"lowRangeOpacity":0.12,"forceVisible":0.18,"diffuseMix":0.88,"emissiveMix":0.72,"anchorToModel":true,"blendMode":"max","maskMode":"none","enableContour":true,"enableGlow":false,"enableMarker":false}'),
('stress_default_metric', '{"value":"von_mises"}'),
('stress_default_unit', '{"value":"MPa"}'),
('clipping_constants', '{"axes":["X","Y","Z"],"directions":["正向","反向"],"polygonDirections":[{"key":"excavate","label":"挖掘"},{"key":"isolate","label":"保留"}],"defaultPositionRange":{"min":-2000,"max":2000,"step":0.5}}'),
('measurement_constants', '{"types":{"DISTANCE":"distance","AREA":"area"},"minPoints":{"distance":2,"area":3}}'),
('export_constants', '{"types":{"JSON":"json","REPORT":"report","SCREENSHOT":"screenshot","CSV":"csv"},"screenshotFormatOptions":[{"value":"png","label":"PNG"},{"value":"jpeg","label":"JPEG"}],"defaultScreenshotOptions":{"format":"png","quality":1.0}}');
