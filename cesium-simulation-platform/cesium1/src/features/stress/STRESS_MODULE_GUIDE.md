# 应力分析模块结构文档与维护指南

## 1. 重构目标

- 按业务域拆分「面板层」「状态编排层」「计算与渲染层」
- 将超大面板组件的核心逻辑迁移到组合式函数
- 抽离可复用子组件，减少模板重复
- 建立统一目录与命名规范，降低耦合

## 2. 当前目录结构

```text
features/stress
├─ StressPanel.vue
├─ STRESS_MODULE_GUIDE.md
├─ panel
│  ├─ composables
│  │  └─ useStressPanelController.js
│  └─ components
│     ├─ StressChartSvg.vue
│     └─ StressPointTensorDetails.vue
├─ core
│  ├─ stressActions.js
│  ├─ computation
│  │  └─ stressComputation.js
│  ├─ points
│  │  └─ stressPointCore.js
│  ├─ render
│  │  └─ stressRenderCore.js
│  └─ io
│     └─ stressDataCore.js
```

## 3. 分层职责

### 3.1 面板层（panel）

- `StressPanel.vue`
  - 面板视图入口
  - 负责页面布局与组件组合
- `panel/composables/useStressPanelController.js`
  - 承接原大组件中的状态、计算属性、交互流程、导出逻辑
  - 面向模板提供统一可消费接口
- `panel/components/StressChartSvg.vue`
  - 统一小图/大图 SVG 图表绘制
- `panel/components/StressPointTensorDetails.vue`
  - 统一应力张量详情展示

### 3.2 状态编排层（useStress + core）

- `src/composables/useStress.js`
  - 对外统一暴露 state/actions
  - 与模型、Viewer、HeatmapManager 建立连接
- `core/stressActions.js`
  - 合并数据动作、导入动作、采样动作
  - 对外保持 `createStressDataActions/createStressImportActions/createStressSamplingActions` 三个工厂函数
  - 通过“单入口 + 多工厂”减少碎片化 JS 文件数量

### 3.3 计算与渲染层（core 子模块）

- `core/computation/stressComputation.js`
  - 指标目录、指标映射、标量场计算、特征值求解
- `core/points/stressPointCore.js`
  - 点位坐标解析、采样、点位时序构建、张量详情
- `core/render/stressRenderCore.js`
  - 热力图显示调优、Tileset 坐标与半径计算、配置构建
- `core/io/stressDataCore.js`
  - 文件导入校验、帧生成、渲染配置归一化、诊断提示

## 4. 命名与组织规范

- 组件文件：`PascalCase.vue`，如 `StressChartSvg.vue`
- 组合式函数：`useXxx.js`，如 `useStressPanelController.js`
- 动作模块：集中在 `core/stressActions.js`
- 能力模块：按 `computation/points/render/io` 四类聚合
- 目录职责单一：
  - `panel` 仅放 UI 相关
  - `core/stressActions.js` 仅放状态编排动作
  - `core/*` 子目录放纯能力函数，避免跨层耦合

## 5. 维护建议

- 新增面板交互优先放入 `useStressPanelController.js`
- 新增图表或详情样式优先复用 `panel/components` 子组件
- 新增导入规则先改 `core/io/stressDataCore.js`，再补 `core/stressActions.js` 报告输出
- 新增指标先维护 `core/computation/stressComputation.js`
- 对外暴露接口统一经 `useStress.js` 汇总，避免组件直接依赖底层算法文件

## 6. 回归验证清单

- 导入「应力分析-1.0」与「应力点-1.0/2.0」文件
- 切换显示量、方向角、材料参数后渲染正常刷新
- 时间轴播放/暂停、滑块跳转正常
- 模型选点后曲线、张量详情、导出 CSV/SVG/PNG 正常
- 自动评估与反馈导出正常
