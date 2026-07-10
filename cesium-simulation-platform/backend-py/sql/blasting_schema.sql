-- ============================================================
-- 爆破模拟数据库 Schema（关系型版：4 业务表 + 1 字典表）
--
-- 设计目标：表格数量固定（5 张），事件数无上限（INSERT 即增）
--   - blasting_events        事件主表（每事件 1 行）
--   - blasting_design        设计表（与事件 1:1）
--   - blasting_design_holes  炮孔表（与事件 1:N，每孔 1 行）
--   - blasting_result        效果表（与事件 1:1）
--   - rock_params            岩体参数字典表（独立于事件）
--
-- 旧设计（blasting_event_001~005 扁平表）已废弃，表数与事件数解耦
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ─── 删除旧的关系型表（重建）──────────────────────────────
DROP TABLE IF EXISTS `blasting_result`;
DROP TABLE IF EXISTS `blasting_design_holes`;
DROP TABLE IF EXISTS `blasting_design`;
DROP TABLE IF EXISTS `blasting_events`;
DROP TABLE IF EXISTS `rock_params`;

-- ─── 删除旧的扁平表（已废弃）──────────────────────────────
DROP TABLE IF EXISTS `blasting_event_001`;
DROP TABLE IF EXISTS `blasting_event_002`;
DROP TABLE IF EXISTS `blasting_event_003`;
DROP TABLE IF EXISTS `blasting_event_004`;
DROP TABLE IF EXISTS `blasting_event_005`;

-- ─── 删除可能残留的旧表 ──────────────────────────────────
DROP TABLE IF EXISTS `blasting_holes`;
DROP TABLE IF EXISTS `blasting_frames`;
DROP TABLE IF EXISTS `blasting_particles`;
DROP TABLE IF EXISTS `blasting_vibration`;
DROP TABLE IF EXISTS `blasting_stress`;
DROP TABLE IF EXISTS `blasting_monitor_points`;
DROP TABLE IF EXISTS `blasting_kco_params`;
DROP TABLE IF EXISTS `blasting_blastface_design`;
DROP TABLE IF EXISTS `blasting_blast_effect`;
DROP TABLE IF EXISTS `blasting_blast_effect`;
DROP TABLE IF EXISTS `blasting_rock_params`;
DROP TABLE IF EXISTS `blasting_render_config`;
DROP TABLE IF EXISTS `blasting_tunnel_sections`;
DROP TABLE IF EXISTS `blasting_design_params`;
DROP TABLE IF EXISTS `blasting_delay_series`;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 1. blasting_events 事件主表（每事件 1 行，无上限）
-- ============================================================
CREATE TABLE `blasting_events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL COMMENT '事件编号',
  `name` VARCHAR(128) NOT NULL COMMENT '事件名称',
  `center_lon` DOUBLE NOT NULL COMMENT '爆心经度',
  `center_lat` DOUBLE NOT NULL COMMENT '爆心纬度',
  `center_height` DOUBLE NOT NULL DEFAULT 0 COMMENT '爆心高程(m)',
  `charge_kg` DOUBLE NOT NULL COMMENT '总装药量(kg)',
  `explosive_type` VARCHAR(32) NOT NULL DEFAULT 'emulsion' COMMENT '炸药类型: emulsion/anfo/dynamite',
  `detonation_method` VARCHAR(64) COMMENT '起爆方式: electric/nonel/electronic',
  `blast_time` DATETIME NOT NULL COMMENT '爆破时间',
  `rock_type` VARCHAR(32) NOT NULL COMMENT '岩体类型（关联 rock_params.rock_type）',
  `weather` VARCHAR(32) COMMENT '天气: clear/cloudy/rain',
  `temperature` DOUBLE COMMENT '温度(°C)',
  `wind_speed` DOUBLE COMMENT '风速(m/s)',
  `wind_direction` DOUBLE COMMENT '风向(°)',
  `status` VARCHAR(16) NOT NULL DEFAULT 'planned' COMMENT 'planned/executed/aborted',
  `description` TEXT,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_id` (`event_id`),
  KEY `idx_status` (`status`),
  KEY `idx_blast_time` (`blast_time`),
  KEY `idx_rock_type` (`rock_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破事件主表';

-- ============================================================
-- 2. blasting_design 设计表（与事件 1:1）
-- ============================================================
CREATE TABLE `blasting_design` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  -- 隧道断面
  `tunnel_shape` VARCHAR(16) NOT NULL DEFAULT 'horseshoe' COMMENT 'horseshoe/circular/rectangular',
  `tunnel_width` DOUBLE NOT NULL DEFAULT 18 COMMENT '断面宽度(m)',
  `tunnel_wall_height` DOUBLE NOT NULL DEFAULT 6 COMMENT '直墙高度(m)',
  `tunnel_arch_radius` DOUBLE NOT NULL DEFAULT 9 COMMENT '拱部半径(m)',
  `tunnel_total_height` DOUBLE NOT NULL DEFAULT 15 COMMENT '断面总高度(m)',
  `tunnel_length` DOUBLE NOT NULL DEFAULT 80 COMMENT '已开挖隧道长度(m)',
  `face_thickness` DOUBLE NOT NULL DEFAULT 2 COMMENT '掌子面厚度(m)',
  `face_offset` DOUBLE NOT NULL DEFAULT 3 COMMENT '掌子面距爆心前方距离(m)',
  -- 掏槽与起爆
  `cut_pattern` VARCHAR(32) NOT NULL DEFAULT 'four_section' COMMENT 'four_section/single_spiral/double_spiral/wedge/burn',
  `cut_angle` DOUBLE DEFAULT 0 COMMENT '楔形掏槽倾斜角(°)',
  `cut_hole_count` INT DEFAULT 4 COMMENT '装药掏槽孔数',
  `empty_hole_count` INT DEFAULT 1 COMMENT '空孔数',
  `initiation_network` VARCHAR(32) COMMENT 'electric/nonel/electronic/detonating_cord',
  `delay_interval_ms` INT DEFAULT 25 COMMENT '段间延时间隔(ms)',
  -- 装药参数
  `charge_density_cut` DOUBLE DEFAULT 1.2 COMMENT '掏槽孔线装药密度(kg/m)',
  `charge_density_aux` DOUBLE DEFAULT 1.0 COMMENT '辅助孔线装药密度(kg/m)',
  `charge_density_perim` DOUBLE DEFAULT 0.7 COMMENT '周边孔线装药密度(kg/m)',
  `stemming_length` DOUBLE DEFAULT 0.5 COMMENT '堵塞长度(m)',
  -- 钻孔参数
  `hole_depth` DOUBLE NOT NULL DEFAULT 2.5 COMMENT '钻孔深度(m)',
  `hole_diameter` DOUBLE NOT NULL DEFAULT 0.04 COMMENT '钻孔直径(m)',
  `utilization` DOUBLE NOT NULL DEFAULT 0.85 COMMENT '炮孔利用率',
  `advance_length` DOUBLE COMMENT '单循环进尺(m), 由 hole_depth*utilization 计算',
  -- 预期效果
  `expected_x50` DOUBLE COMMENT '预期中位块度(m)',
  `expected_xmax` DOUBLE COMMENT '预期最大块度(m)',
  `expected_throw_distance` DOUBLE COMMENT '预期抛掷距离(m)',
  `expected_overbreak` DOUBLE COMMENT '预期超挖(m)',
  -- 安全
  `min_safety_distance` DOUBLE DEFAULT 100 COMMENT '最小安全距离(m)',
  `max_vibration_velocity` DOUBLE DEFAULT 5.0 COMMENT '最大质点振动速度(cm/s)',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_id` (`event_id`),
  CONSTRAINT `fk_design_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破设计表';

-- ============================================================
-- 3. blasting_design_holes 炮孔表（与事件 1:N，每孔 1 行）
-- 废弃 holes_json TEXT 存储，支持独立查询与索引
-- ============================================================
CREATE TABLE `blasting_design_holes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `hole_index` INT NOT NULL COMMENT '孔序号',
  `pos_x` DOUBLE NOT NULL COMMENT '断面内 X 坐标(m), 相对断面中心',
  `pos_y` DOUBLE NOT NULL COMMENT '断面内 Y 坐标(m), 相对底板',
  `pos_z` DOUBLE NOT NULL DEFAULT 0 COMMENT '断面内 Z 坐标(m), 一般为 0',
  `hole_type` VARCHAR(16) NOT NULL COMMENT 'cut/auxiliary/perimeter/empty',
  `diameter` DOUBLE NOT NULL DEFAULT 0.04 COMMENT '孔径(m)',
  `depth` DOUBLE NOT NULL DEFAULT 2.5 COMMENT '孔深(m)',
  `inclination_angle` DOUBLE NOT NULL DEFAULT 0 COMMENT '倾角(度)',
  `inclination_azimuth` DOUBLE NOT NULL DEFAULT 0 COMMENT '方位角(度)',
  `charge_kg` DOUBLE NOT NULL DEFAULT 0 COMMENT '单孔装药量(kg)',
  `charge_length` DOUBLE DEFAULT 0 COMMENT '装药长度(m)',
  `explosive_type` VARCHAR(32) DEFAULT 'emulsion' COMMENT '炸药类型',
  `detonator_series` INT DEFAULT 1 COMMENT '雷管段别',
  `delay_ms` INT DEFAULT 0 COMMENT '延期时间(ms)',
  `is_empty_hole` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否空孔: 0=装药孔, 1=空孔',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_hole` (`event_id`, `hole_index`),
  KEY `idx_event_type` (`event_id`, `hole_type`),
  CONSTRAINT `fk_holes_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破炮孔表';

-- ============================================================
-- 4. blasting_result 效果表（与事件 1:1）
-- 岩体参数通过 JOIN rock_params 获取，不再冗余存储
-- ============================================================
CREATE TABLE `blasting_result` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  -- 模拟控制
  `random_seed` INT DEFAULT 42 COMMENT '随机数种子（保证回放可复现）',
  `simulation_duration_s` DOUBLE DEFAULT 8.0 COMMENT '模拟总时长(s)',
  `time_step_s` DOUBLE DEFAULT 0.016 COMMENT '模拟时间步长(s)',
  -- 漏斗
  `crater_depth` DOUBLE COMMENT '漏斗深度(m)',
  `crater_radius` DOUBLE COMMENT '漏斗开口半径(m)',
  `crater_center_offset_y` DOUBLE DEFAULT 0 COMMENT '漏斗中心高度偏移(相对断面)',
  -- 超挖
  `overbreak_max` DOUBLE COMMENT '最大超挖(m)',
  `overbreak_min` DOUBLE COMMENT '最小超挖(m)',
  `half_barrel_ratio` DOUBLE COMMENT '半孔率(0-1, 光面爆破质量)',
  -- 碎块（KCO 输出）
  `fragment_count` INT COMMENT '碎片总数',
  `fragment_x50` DOUBLE COMMENT '中位块度(m, KCO模型输出)',
  `fragment_x80` DOUBLE COMMENT '80%通过块度(m)',
  `fragment_xmax` DOUBLE COMMENT '最大块度(m)',
  `fragment_b` DOUBLE COMMENT 'Swebrec 弯曲参数',
  `fragment_n` DOUBLE COMMENT 'Cunningham 均匀性指数',
  -- 抛掷
  `throw_distance_max` DOUBLE COMMENT '最大抛掷距离(m)',
  `throw_distance_avg` DOUBLE COMMENT '平均抛掷距离(m)',
  `spread_angle` DOUBLE DEFAULT 45 COMMENT '抛掷扩散角(°)',
  -- 振动
  `vibration_peak` DOUBLE COMMENT '峰值振动强度(Kine)',
  `vibration_velocity_max` DOUBLE COMMENT '最大质点振动速度(cm/s)',
  `stress_peak_mpa` DOUBLE COMMENT '峰值应力(MPa)',
  -- 安全
  `min_safety_factor` DOUBLE COMMENT '最小安全系数',
  -- 视觉强度
  `smoke_intensity` DOUBLE DEFAULT 0.6 COMMENT '烟雾强度(0-1)',
  `dust_intensity` DOUBLE DEFAULT 0.5 COMMENT '粉尘强度(0-1)',
  `fire_intensity` DOUBLE DEFAULT 0.8 COMMENT '火球强度(0-1)',
  `spark_intensity` DOUBLE DEFAULT 0.7 COMMENT '火花强度(0-1)',
  `shockwave_speed_factor` DOUBLE DEFAULT 1.0 COMMENT '冲击波速度系数',
  -- 岩体参数通过 JOIN rock_params 获取，不再冗余存储
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_id` (`event_id`),
  CONSTRAINT `fk_result_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破效果表';

-- ============================================================
-- 5. rock_params 岩体参数字典表（独立于事件，消除冗余）
-- ============================================================
CREATE TABLE `rock_params` (
  `rock_type` VARCHAR(32) PRIMARY KEY,
  `density` DOUBLE NOT NULL COMMENT '密度(kg/m³)',
  `youngs_modulus` DOUBLE NOT NULL COMMENT '弹性模量(Pa)',
  `compressive_strength` DOUBLE NOT NULL COMMENT '抗压强度(Pa)',
  `p_wave_speed` DOUBLE NOT NULL COMMENT 'P波速度(m/s)',
  `s_wave_speed` DOUBLE NOT NULL COMMENT 'S波速度(m/s)',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岩体力学参数字典表';

-- ─── 预填常见岩体参数 ──────────────────────────────────────
INSERT INTO `rock_params` (`rock_type`, `density`, `youngs_modulus`, `compressive_strength`, `p_wave_speed`, `s_wave_speed`) VALUES
  ('granite',      2650, 50e9, 120e6, 4500, 2600),
  ('limestone',    2400, 40e9, 80e6,  3800, 2200),
  ('sandstone',    2300, 25e9, 60e6,  3200, 1900),
  ('marble',       2700, 55e9, 100e6, 4300, 2500),
  ('basalt',       2850, 60e9, 150e6, 5000, 2900),
  ('schist',       2750, 35e9, 70e6,  3500, 2100),
  ('andesite',     2550, 45e9, 110e6, 4200, 2450),
  ('diorite',      2780, 52e9, 130e6, 4600, 2700);
