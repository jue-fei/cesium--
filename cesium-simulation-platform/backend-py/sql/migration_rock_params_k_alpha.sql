-- ============================================================
-- 迁移：rock_params 增加萨道夫斯基场地常数 K/α
-- 基线：blasting_schema.sql（已含 density/youngs_modulus/compressive_strength/p_wave_speed/s_wave_speed）
-- 日期：2026-08-12
-- ============================================================

-- 新增字段（ALTER TABLE 不动已有数据）
ALTER TABLE `rock_params`
  ADD COLUMN `sadosky_k` DOUBLE DEFAULT 200 COMMENT '萨道夫斯基场地常数 K（中硬岩 150-250，GB6722 附录）',
  ADD COLUMN `sadosky_alpha` DOUBLE DEFAULT 1.5 COMMENT '萨道夫斯基衰减指数 α（1.0-2.0）';

-- 按岩性更新默认值（硬岩 K 偏高 α 偏小，软岩反之）
UPDATE `rock_params` SET `sadosky_k` = 220, `sadosky_alpha` = 1.45 WHERE `rock_type` = 'granite';
UPDATE `rock_params` SET `sadosky_k` = 200, `sadosky_alpha` = 1.50 WHERE `rock_type` = 'limestone';
UPDATE `rock_params` SET `sadosky_k` = 160, `sadosky_alpha` = 1.65 WHERE `rock_type` = 'sandstone';
UPDATE `rock_params` SET `sadosky_k` = 210, `sadosky_alpha` = 1.48 WHERE `rock_type` = 'marble';
UPDATE `rock_params` SET `sadosky_k` = 240, `sadosky_alpha` = 1.40 WHERE `rock_type` = 'basalt';
UPDATE `rock_params` SET `sadosky_k` = 180, `sadosky_alpha` = 1.55 WHERE `rock_type` = 'schist';
UPDATE `rock_params` SET `sadosky_k` = 200, `sadosky_alpha` = 1.50 WHERE `rock_type` = 'andesite';
UPDATE `rock_params` SET `sadosky_k` = 230, `sadosky_alpha` = 1.42 WHERE `rock_type` = 'diorite';
