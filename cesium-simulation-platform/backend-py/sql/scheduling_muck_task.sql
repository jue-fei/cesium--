-- =====================================================================
-- 现场调度·采矿区任务配置表（scheduling_muck_task）
-- ---------------------------------------------------------------------
-- 用途：存放每个采矿区(装载点)的"需采矿工作量 + 各类信息"，后端可手动编辑
--   （GET/PUT /api/scheduling/muck_tasks），非死代码。
-- 数据来源优先级：
--   1. 本表记录（source=manual，人工维护）
--   2. 关联爆破事件 blast_event_id → blasting_result 的块度分布（source=blasting，跨板块反哺）
--   3. 场景配置 muckPoints 兜底（seed 时写入本表）
-- =====================================================================

CREATE TABLE IF NOT EXISTS `scheduling_muck_task` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `task_id`           VARCHAR(32)  NOT NULL COMMENT '采矿区/装载点 id（如 M1）',
  `scenario`          VARCHAR(128) NOT NULL DEFAULT '' COMMENT '所属场景（config scenario 字段；多场景共用本表，按场景隔离）',
  `zone`              VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '采矿区名称',
  `gantry`            VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '装矿横巷',
  `node`              VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '巷道图节点',
  `muck_level`        INT          NOT NULL DEFAULT 0 COMMENT '所在开采水平',
  `required_work_t`   DOUBLE       NOT NULL DEFAULT 0 COMMENT '需采矿工作量(t)',
  `remaining_work_t`  DOUBLE       NOT NULL DEFAULT 0 COMMENT '剩余工作量(t)',
  `grade_pct`         DOUBLE       NOT NULL DEFAULT 0.8 COMMENT '矿石品位(% Cu)',
  `blast_event_id`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '关联爆破事件(跨板块反哺来源)',
  `frag_x50_m`        DOUBLE       NULL COMMENT '中位块度 x50(m)',
  `frag_x80_m`        DOUBLE       NULL COMMENT '80%通过块度 x80(m)',
  `frag_xmax_m`       DOUBLE       NULL COMMENT '最大块度 xmax(m)',
  `frag_b`            DOUBLE       NULL COMMENT 'Swebrec 弯曲参数 b',
  `frag_n`            DOUBLE       NULL COMMENT 'Cunningham 均匀指数 n',
  `size_hist_json`    TEXT         NULL COMMENT '块度分布直方图 JSON [{range,pct},...]',
  `big_block_ratio`   DOUBLE       NOT NULL DEFAULT 3.0 COMMENT '大块率(%)',
  `recognize_rate`    DOUBLE       NOT NULL DEFAULT 0.95 COMMENT '>10cm 块度识别率',
  `shape`             VARCHAR(32)  NOT NULL DEFAULT '半锥体散堆' COMMENT '爆堆形态',
  `spread_r_m`        DOUBLE       NOT NULL DEFAULT 8.0 COMMENT '爆堆散布半径(m)',
  `height_m_m`        DOUBLE       NOT NULL DEFAULT 2.0 COMMENT '爆堆堆高(m)',
  `blast_cycle`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '爆破周期',
  `source`            VARCHAR(16)  NOT NULL DEFAULT 'manual' COMMENT '数据来源: manual|blasting|scenario',
  `enabled`           TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否启用',
  `remark`            VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注',
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_task_id` (`task_id`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='现场调度·采矿区任务配置（可手动编辑，部分字段由爆破板块反哺）';
