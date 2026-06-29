-- ============================================================
-- 爆破模拟数据库 Schema
-- 包含全部爆破渲染显示参数，支持真实爆破效果模拟
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ─── 1. 爆破事件表 ───────────────────────────────────
DROP TABLE IF EXISTS `blasting_events`;
CREATE TABLE `blasting_events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL UNIQUE COMMENT '事件编号',
  `name` VARCHAR(128) NOT NULL COMMENT '事件名称',
  `center_lon` DOUBLE NOT NULL COMMENT '爆心经度',
  `center_lat` DOUBLE NOT NULL COMMENT '爆心纬度',
  `center_height` DOUBLE DEFAULT 0 COMMENT '爆心高度(m)',
  `charge_kg` DOUBLE NOT NULL COMMENT '总装药量(kg)',
  `explosive_type` VARCHAR(32) DEFAULT 'emulsion' COMMENT '炸药类型: emulsion/anfo/dynamite',
  `detonation_method` VARCHAR(32) DEFAULT 'electric' COMMENT '起爆方式: electric/nonel/electronic',
  `blast_time` DATETIME COMMENT '爆破时间',
  `rock_type` VARCHAR(64) DEFAULT 'granite' COMMENT '岩体类型',
  `weather` VARCHAR(32) DEFAULT 'clear' COMMENT '天气: clear/cloudy/rain',
  `temperature` DOUBLE DEFAULT 20 COMMENT '温度(°C)',
  `wind_speed` DOUBLE DEFAULT 0 COMMENT '风速(m/s)',
  `wind_direction` DOUBLE DEFAULT 0 COMMENT '风向(°)',
  `status` VARCHAR(16) DEFAULT 'planned' COMMENT '状态: planned/active/completed',
  `description` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_status` (`status`),
  INDEX `idx_blast_time` (`blast_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破事件主表';

-- ─── 2. 炮孔设计表 ───────────────────────────────────
DROP TABLE IF EXISTS `blasting_holes`;
CREATE TABLE `blasting_holes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL COMMENT '关联事件',
  `hole_id` VARCHAR(32) NOT NULL COMMENT '炮孔编号',
  `row` INT DEFAULT 1 COMMENT '排号',
  `column` INT DEFAULT 1 COMMENT '列号',
  `collar_lon` DOUBLE NOT NULL COMMENT '孔口经度',
  `collar_lat` DOUBLE NOT NULL COMMENT '孔口纬度',
  `collar_height` DOUBLE DEFAULT 0 COMMENT '孔口高度(m)',
  `toe_lon` DOUBLE NOT NULL COMMENT '孔底经度',
  `toe_lat` DOUBLE NOT NULL COMMENT '孔底纬度',
  `toe_height` DOUBLE DEFAULT 0 COMMENT '孔底高度(m)',
  `diameter` DOUBLE DEFAULT 0.09 COMMENT '孔径(m)',
  `depth` DOUBLE DEFAULT 10 COMMENT '孔深(m)',
  `charge_kg` DOUBLE DEFAULT 0 COMMENT '单孔装药量(kg)',
  `delay_ms` INT DEFAULT 0 COMMENT '延时(ms)',
  `hole_type` VARCHAR(16) DEFAULT 'production' COMMENT '孔类型: production/cut/easing/perimeter',
  `burden` DOUBLE DEFAULT 2.0 COMMENT '抵抗线(m)',
  `spacing` DOUBLE DEFAULT 2.5 COMMENT '孔距(m)',
  `subdrill` DOUBLE DEFAULT 0.5 COMMENT '超深(m)',
  `stemming` DOUBLE DEFAULT 1.0 COMMENT '堵塞长度(m)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_event` (`event_id`),
  INDEX `idx_hole` (`hole_id`),
  CONSTRAINT `fk_holes_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='炮孔设计参数';

-- ─── 3. 岩体力学参数表 ───────────────────────────────
DROP TABLE IF EXISTS `blasting_rock_params`;
CREATE TABLE `blasting_rock_params` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `rock_type` VARCHAR(64) NOT NULL UNIQUE COMMENT '岩体类型',
  `density` DOUBLE DEFAULT 2650 COMMENT '密度(kg/m³)',
  `youngs_modulus` DOUBLE DEFAULT 30e9 COMMENT '弹性模量(Pa)',
  `poissons_ratio` DOUBLE DEFAULT 0.25 COMMENT '泊松比',
  `compressive_strength` DOUBLE DEFAULT 80e6 COMMENT '抗压强度(Pa)',
  `tensile_strength` DOUBLE DEFAULT 8e6 COMMENT '抗拉强度(Pa)',
  `shear_strength` DOUBLE DEFAULT 15e6 COMMENT '抗剪强度(Pa)',
  `p_wave_speed` DOUBLE DEFAULT 4500 COMMENT 'P波速度(m/s)',
  `s_wave_speed` DOUBLE DEFAULT 2600 COMMENT 'S波速度(m/s)',
  `attenuation_p` DOUBLE DEFAULT 0.012 COMMENT 'P波衰减系数',
  `attenuation_s` DOUBLE DEFAULT 0.018 COMMENT 'S波衰减系数',
  `attenuation_rayleigh` DOUBLE DEFAULT 0.006 COMMENT '瑞利波衰减系数',
  `color_r` DOUBLE DEFAULT 0.45 COMMENT '岩体颜色R',
  `color_g` DOUBLE DEFAULT 0.35 COMMENT '岩体颜色G',
  `color_b` DOUBLE DEFAULT 0.25 COMMENT '岩体颜色B',
  `friction_angle` DOUBLE DEFAULT 35 COMMENT '内摩擦角(°)',
  `cohesion` DOUBLE DEFAULT 5e6 COMMENT '粘聚力(Pa)',
  `description` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岩体力学参数库';

-- ─── 4. 渲染配置表（全部爆破渲染显示参数） ──────────
DROP TABLE IF EXISTS `blasting_render_config`;
CREATE TABLE `blasting_render_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `config_name` VARCHAR(64) NOT NULL UNIQUE COMMENT '配置名称',
  `fragment_render_mode` VARCHAR(16) DEFAULT 'point' COMMENT '碎片渲染: point/model/particle',
  `max_particles` INT DEFAULT 5000 COMMENT '最大粒子数',
  `particle_size_shock` DOUBLE DEFAULT 6 COMMENT '冲击波粒子大小',
  `particle_size_fragment` DOUBLE DEFAULT 5 COMMENT '碎片粒子大小',
  `particle_size_dust` DOUBLE DEFAULT 3 COMMENT '粉尘粒子大小',
  `particle_size_spall` DOUBLE DEFAULT 4 COMMENT '剥落粒子大小',
  `particle_size_fire` DOUBLE DEFAULT 8 COMMENT '火焰粒子大小',
  `particle_size_smoke` DOUBLE DEFAULT 10 COMMENT '烟雾粒子大小',
  `color_shock_r` DOUBLE DEFAULT 1.0 COMMENT '冲击波颜色R',
  `color_shock_g` DOUBLE DEFAULT 0.78 COMMENT '冲击波颜色G',
  `color_shock_b` DOUBLE DEFAULT 0.2 COMMENT '冲击波颜色B',
  `color_shock_a` DOUBLE DEFAULT 0.8 COMMENT '冲击波透明度',
  `color_fragment_r` DOUBLE DEFAULT 0.86 COMMENT '碎片颜色R',
  `color_fragment_g` DOUBLE DEFAULT 0.63 COMMENT '碎片颜色G',
  `color_fragment_b` DOUBLE DEFAULT 0.31 COMMENT '碎片颜色B',
  `color_fragment_a` DOUBLE DEFAULT 0.9 COMMENT '碎片透明度',
  `color_dust_r` DOUBLE DEFAULT 0.71 COMMENT '粉尘颜色R',
  `color_dust_g` DOUBLE DEFAULT 0.67 COMMENT '粉尘颜色G',
  `color_dust_b` DOUBLE DEFAULT 0.63 COMMENT '粉尘颜色B',
  `color_dust_a` DOUBLE DEFAULT 0.4 COMMENT '粉尘透明度',
  `color_fire_r` DOUBLE DEFAULT 1.0 COMMENT '火焰颜色R',
  `color_fire_g` DOUBLE DEFAULT 0.4 COMMENT '火焰颜色G',
  `color_fire_b` DOUBLE DEFAULT 0.05 COMMENT '火焰颜色B',
  `color_fire_a` DOUBLE DEFAULT 0.85 COMMENT '火焰透明度',
  `color_smoke_r` DOUBLE DEFAULT 0.2 COMMENT '烟雾颜色R',
  `color_smoke_g` DOUBLE DEFAULT 0.2 COMMENT '烟雾颜色G',
  `color_smoke_b` DOUBLE DEFAULT 0.2 COMMENT '烟雾颜色B',
  `color_smoke_a` DOUBLE DEFAULT 0.5 COMMENT '烟雾透明度',
  `wave_rings` INT DEFAULT 3 COMMENT '冲击波环数',
  `wave_ring_opacity` DOUBLE DEFAULT 0.26 COMMENT '波环透明度',
  `trail_width` DOUBLE DEFAULT 2.0 COMMENT '轨迹宽度',
  `trail_glow_power` DOUBLE DEFAULT 0.22 COMMENT '轨迹辉光强度',
  `trail_color_r` DOUBLE DEFAULT 1.0 COMMENT '轨迹颜色R',
  `trail_color_g` DOUBLE DEFAULT 0.85 COMMENT '轨迹颜色G',
  `trail_color_b` DOUBLE DEFAULT 0.2 COMMENT '轨迹颜色B',
  `trail_color_a` DOUBLE DEFAULT 0.45 COMMENT '轨迹透明度',
  `heatmap_resolution` INT DEFAULT 48 COMMENT '热力图分辨率',
  `heatmap_max_radius` DOUBLE DEFAULT 200 COMMENT '热力图最大半径(m)',
  `heatmap_opacity` DOUBLE DEFAULT 0.6 COMMENT '热力图透明度',
  `fireball_duration` DOUBLE DEFAULT 1.5 COMMENT '火球持续时间(s)',
  `fireball_max_radius` DOUBLE DEFAULT 15 COMMENT '火球最大半径(m)',
  `smoke_duration` DOUBLE DEFAULT 8.0 COMMENT '烟雾持续时间(s)',
  `smoke_rise_speed` DOUBLE DEFAULT 2.0 COMMENT '烟雾上升速度(m/s)',
  `dust_duration` DOUBLE DEFAULT 8.0 COMMENT '粉尘持续时间(s)',
  `shockwave_speed` DOUBLE DEFAULT 5.0 COMMENT '冲击波传播系数',
  `fragment_min_size` DOUBLE DEFAULT 0.15 COMMENT '碎片最小尺寸(m)',
  `fragment_max_size` DOUBLE DEFAULT 2.0 COMMENT '碎片最大尺寸(m)',
  `fragment_count_base` INT DEFAULT 200 COMMENT '基础碎片数',
  `gravity` DOUBLE DEFAULT 9.8 COMMENT '重力加速度(m/s²)',
  `air_drag` DOUBLE DEFAULT 0.04 COMMENT '空气阻力系数',
  `restitution` DOUBLE DEFAULT 0.35 COMMENT '弹性恢复系数',
  `friction` DOUBLE DEFAULT 0.6 COMMENT '摩擦系数',
  `time_step` DOUBLE DEFAULT 0.05 COMMENT '模拟时间步长(s)',
  `frame_count` INT DEFAULT 120 COMMENT '帧数',
  `enable_collision` TINYINT DEFAULT 1 COMMENT '启用碰撞检测',
  `enable_heatmap` TINYINT DEFAULT 1 COMMENT '启用热力图',
  `enable_monitor_points` TINYINT DEFAULT 1 COMMENT '启用监测点',
  `enable_smoke` TINYINT DEFAULT 1 COMMENT '启用烟雾',
  `enable_fireball` TINYINT DEFAULT 1 COMMENT '启用火球',
  `enable_dust` TINYINT DEFAULT 1 COMMENT '启用粉尘',
  `enable_trails` TINYINT DEFAULT 1 COMMENT '启用轨迹',
  `description` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破渲染配置参数';

-- ─── 5. 模拟帧数据表 ─────────────────────────────────
DROP TABLE IF EXISTS `blasting_frames`;
CREATE TABLE `blasting_frames` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `frame_index` INT NOT NULL COMMENT '帧序号',
  `time_sec` DOUBLE NOT NULL COMMENT '时间(s)',
  `wave_radius` DOUBLE COMMENT '冲击波半径(m)',
  `alive_count` INT COMMENT '活跃粒子数',
  `landed_count` INT COMMENT '落地粒子数',
  `max_distance` DOUBLE COMMENT '最大飞溅距离(m)',
  `max_speed` DOUBLE COMMENT '最大速度(m/s)',
  `total_energy` DOUBLE COMMENT '系统总能量(J)',
  `vibration_max` DOUBLE COMMENT '峰值振动强度',
  `stress_max` DOUBLE COMMENT '峰值应力(MPa)',
  `min_safety_factor` DOUBLE COMMENT '最小安全系数',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_frame` (`event_id`, `frame_index`),
  INDEX `idx_event` (`event_id`),
  CONSTRAINT `fk_frames_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模拟帧统计';

-- ─── 6. 粒子数据表 ───────────────────────────────────
DROP TABLE IF EXISTS `blasting_particles`;
CREATE TABLE `blasting_particles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `particle_id` VARCHAR(32) NOT NULL COMMENT '粒子编号',
  `particle_type` VARCHAR(16) NOT NULL COMMENT '类型: shock_wave/rock_fragment/dust/spall/fire/smoke',
  `frame_index` INT NOT NULL COMMENT '帧序号',
  `pos_x` DOUBLE COMMENT 'X坐标(m)',
  `pos_y` DOUBLE COMMENT 'Y坐标(m)',
  `pos_z` DOUBLE COMMENT 'Z坐标(m)',
  `vel_x` DOUBLE COMMENT 'X速度(m/s)',
  `vel_y` DOUBLE COMMENT 'Y速度(m/s)',
  `vel_z` DOUBLE COMMENT 'Z速度(m/s)',
  `size` DOUBLE COMMENT '尺寸(m)',
  `speed` DOUBLE COMMENT '合速度(m/s)',
  `age` DOUBLE COMMENT '年龄(s)',
  `landed` TINYINT DEFAULT 0 COMMENT '是否落地',
  `energy` DOUBLE COMMENT '能量(J)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_event_frame` (`event_id`, `frame_index`),
  INDEX `idx_type` (`particle_type`),
  CONSTRAINT `fk_particles_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='粒子轨迹数据';

-- ─── 7. 振动场数据表 ─────────────────────────────────
DROP TABLE IF EXISTS `blasting_vibration`;
CREATE TABLE `blasting_vibration` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `frame_index` INT NOT NULL,
  `grid_resolution` INT DEFAULT 48,
  `max_radius` DOUBLE DEFAULT 200,
  `max_intensity` DOUBLE COMMENT '峰值强度',
  `field_data` LONGTEXT COMMENT '网格数据JSON',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_vib_event_frame` (`event_id`, `frame_index`),
  INDEX `idx_event` (`event_id`),
  CONSTRAINT `fk_vib_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='振动场网格数据';

-- ─── 8. 应力监测点表 ─────────────────────────────────
DROP TABLE IF EXISTS `blasting_monitor_points`;
CREATE TABLE `blasting_monitor_points` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `point_id` VARCHAR(32) NOT NULL COMMENT '监测点编号',
  `label` VARCHAR(64) COMMENT '标签',
  `zone_type` VARCHAR(16) COMMENT '区域: near_field/free_face/mid_field/far_field/borehole',
  `pos_x` DOUBLE COMMENT 'X(m)',
  `pos_y` DOUBLE COMMENT 'Y(m)',
  `pos_z` DOUBLE COMMENT 'Z(m)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_mp_event_point` (`event_id`, `point_id`),
  INDEX `idx_event` (`event_id`),
  CONSTRAINT `fk_mp_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应力监测点';

-- ─── 9. 应力时程数据表 ───────────────────────────────
DROP TABLE IF EXISTS `blasting_stress`;
CREATE TABLE `blasting_stress` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `point_id` VARCHAR(32) NOT NULL,
  `frame_index` INT NOT NULL,
  `time_sec` DOUBLE,
  `intensity` DOUBLE COMMENT '振动强度',
  `vibration_velocity` DOUBLE COMMENT '振动速度(m/s)',
  `sigma1` DOUBLE COMMENT '最大主应力(MPa)',
  `sigma2` DOUBLE COMMENT '中间主应力(MPa)',
  `sigma3` DOUBLE COMMENT '最小主应力(MPa)',
  `mises` DOUBLE COMMENT 'Mises等效应力(MPa)',
  `safety_factor` DOUBLE COMMENT '安全系数',
  `safety_level` VARCHAR(16) COMMENT '安全等级',
  `max_tensile` DOUBLE COMMENT '最大拉应力(MPa)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_event_frame` (`event_id`, `frame_index`),
  INDEX `idx_point` (`point_id`),
  CONSTRAINT `fk_stress_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应力时程数据';

SET FOREIGN_KEY_CHECKS = 1;
