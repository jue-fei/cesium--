-- ============================================================
-- 迁移脚本：blasting_result 表扩展 + blasting_runtime_stats 新表
-- 向后兼容：新字段均有默认值，不破坏现有数据
-- ============================================================

-- blasting_result 新增 12 个字段（ADD COLUMN IF NOT EXISTS 在 MySQL 8.0.29+ 支持，
-- 低版本需用存储过程或直接 ALTER，这里用兼容写法）
ALTER TABLE `blasting_result`
  ADD COLUMN IF NOT EXISTS `fragment_count_target` INT COMMENT '目标碎石数' AFTER `fragment_count`,
  ADD COLUMN IF NOT EXISTS `fragment_count_generated` INT COMMENT '算法生成碎石数' AFTER `fragment_count_target`,
  ADD COLUMN IF NOT EXISTS `fragment_count_rendered` INT COMMENT '实际渲染碎石数' AFTER `fragment_count_generated`,
  ADD COLUMN IF NOT EXISTS `fragment_mass_target_kg` DOUBLE COMMENT '目标总质量(kg)' AFTER `fragment_count_rendered`,
  ADD COLUMN IF NOT EXISTS `fragment_mass_generated_kg` DOUBLE COMMENT '生成总质量(kg)' AFTER `fragment_mass_target_kg`,
  ADD COLUMN IF NOT EXISTS `fragment_volume_target` DOUBLE COMMENT '目标爆破方量(m³)' AFTER `fragment_mass_generated_kg`,
  ADD COLUMN IF NOT EXISTS `fragment_volume_generated` DOUBLE COMMENT '生成方量(m³)' AFTER `fragment_volume_target`,
  ADD COLUMN IF NOT EXISTS `fragment_histogram_json` JSON COMMENT '块度分布直方图' AFTER `fragment_volume_generated`,
  ADD COLUMN IF NOT EXISTS `velocity_histogram_json` JSON COMMENT '速度分布直方图' AFTER `fragment_histogram_json`,
  ADD COLUMN IF NOT EXISTS `throw_distance_histogram_json` JSON COMMENT '抛距分布直方图' AFTER `velocity_histogram_json`,
  ADD COLUMN IF NOT EXISTS `render_scale_mode` VARCHAR(16) DEFAULT 'min_pixel' COMMENT '渲染尺寸模式' AFTER `throw_distance_histogram_json`,
  ADD COLUMN IF NOT EXISTS `render_scale_bias` DOUBLE DEFAULT 0 COMMENT '渲染尺寸偏移(m)' AFTER `render_scale_mode`;

-- 修改 fragment_count 注释标注 deprecated
ALTER TABLE `blasting_result`
  MODIFY COLUMN `fragment_count` INT COMMENT '碎片总数 (deprecated: 使用 fragment_count_generated)';

-- 新增运行时统计表
CREATE TABLE IF NOT EXISTS `blasting_runtime_stats` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` VARCHAR(32) NOT NULL,
  `random_seed` INT COMMENT '随机数种子',
  `algorithm_version` VARCHAR(32) COMMENT '算法版本号',
  `params_snapshot` JSON COMMENT '核心输入参数快照',
  `stats_snapshot` JSON COMMENT '运行时统计快照',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_event_id` (`event_id`),
  CONSTRAINT `fk_runtime_stats_event` FOREIGN KEY (`event_id`) REFERENCES `blasting_events`(`event_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破运行时统计表（每次 replay 一行）';
