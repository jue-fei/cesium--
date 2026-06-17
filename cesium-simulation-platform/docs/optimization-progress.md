# 三维数字孪生平台（Cesium）优化进展与后续计划

> 本文档基于当前仓库的实际改造进度整理，区别于 `docs/optimization-plan.md` 中的原始建议方案。  
> 目标是明确两件事：已经完成了什么，接下来优先做什么。

---

## 1. 当前基线

### 已达成的基础状态

- `npm run lint:check -- --quiet` 已通过，说明当前仓库已无 ESLint `error`。
- `npm run lint:check` 可执行通过，当前剩余为 `warning`，不是阻断性问题。
- `npm run build` 可执行通过。
- `docs/` 目录已建立并具备基础文档结构。
- 前端和后端均已补充 `.env.example`。

### 当前主要剩余问题

- 仍存在较多 `warning`，主要集中在：
  - 超长文件：`max-lines`
  - 超长函数：`max-lines-per-function`
  - 复杂度偏高：`complexity`
  - 少量未使用变量：`no-unused-vars`
- 重点集中模块仍然是：
  - `stress-analysis`
  - `realtime-monitoring`
  - `model-control`

---

## 2. 已完成的优化

## 2.1 工程与文档基线

- 新增前端环境示例：`cesium1/.env.example`
- 新增后端环境示例：`backend-py/.env.example`
- 新增文档：
  - `docs/architecture.md`
  - `docs/deployment.md`
  - `docs/contributing.md`
- 更新 `cesium1/README.md`，补充：
  - `VITE_CESIUM_TOKEN`
  - `VITE_CESIUM_ASSETS_URL`
  - API 文档入口
  - 文档索引

### 本阶段收益

- 新成员可以更快完成环境配置。
- 前后端目录结构和部署入口更清晰。
- 文档不再完全依赖口头传递。

---

## 2.2 日志、错误捕获与入口治理

- 新增统一日志工具：`cesium1/src/utils/logger.js`
- 新增全局错误捕获：`cesium1/src/utils/globalErrorCapture.js`
- 新增 Cesium 资源基址初始化：`cesium1/src/utils/cesiumBaseUrl.js`
- 更新 `src/main.js`：
  - 不再直接写裸 `window.onerror`
  - 改为统一安装全局错误捕获
  - 在启动时初始化 Cesium 基址
- 更新 `src/utils/errorHandler.js`，统一接入 `logger`

### 本阶段收益

- 日志输出不再分散为无结构的 `console.*`
- 全局错误捕获方式更规范
- Cesium 资源基址初始化更可维护，兼容当前运行方式

---

## 2.3 导入边界与质量门禁

- 扩展 `src/features/shared/index.js`，将部分功能模块统一从 shared 入口暴露
- 将 `App.vue` 中的部分 feature 直连导入调整为通过 shared 入口使用
- 新增导入边界脚本：`cesium1/scripts/check-import-boundaries.mjs`
- 更新 `package.json`：
  - 新增 `imports:check`
  - 新增 `ci:check`
- 更新 `eslint.config.js`：
  - 增加 `max-lines`
  - 增加 `max-lines-per-function`
  - 增加 `complexity`
  - 增加 `no-restricted-imports`
  - 限制直接使用 `window.onerror` / `window.onunhandledrejection`

### 本阶段收益

- 工程边界开始具备可执行规则，不再只靠约定
- 入口层和 feature 内部实现之间的耦合有所收敛
- 后续继续重构时更容易发现回退问题

---

## 2.4 API、Viewer 与运行时观测点

- 在 `src/services/api/initApiConfig.js` 中补充：
  - 配置加载日志
  - Performance API 打点
- 在 `src/composables/useViewer.js` 中补充：
  - Viewer 初始化日志
  - `viewer-init` 性能打点

### 本阶段收益

- 已具备最基础的初始化链路可观测性
- 后续接入 Sentry 或性能分析平台时不需要从零开始

---

## 2.5 Lint Error 清零

- 逐步修复了多个历史文件中的：
  - `prettier/prettier`
  - 空 `catch {}`
  - 未使用变量
  - 局部格式错误
- 全仓已达到：
  - 无 lint `error`
  - 构建可通过

### 本阶段收益

- 工程进入“可持续治理”状态
- 后续重构时可以先关注 warning，而不是被 error 阻断

---

## 2.6 Stress 模块第一轮结构整理

### 已完成内容

- `useStress.js` 已完成第一轮拆分，保持外部接口不变
- 新增：
  - `stressHistoryController.js`
  - `knownPointStressOverlayController.js`
  - `stressPlaybackController.js`

### 已取得的结果

- `useStress.js` 主文件已从接近千行下降到约 `481` 行
- 主文件职责已从“全部内联”收敛为：
  - 状态聚合
  - service wiring
  - watcher 编排
  - 外部 actions 暴露

### 说明

- 用户已明确表示暂不继续沿这条拆分线推进，因此该模块后续只保留为存量成果，不作为下一轮优先工作。

---

## 2.7 Realtime Monitoring 模块优化

### 已完成内容

- 将实时监控模块中的裸 `console.*` 替换为 `logger`
- 调整文件包括：
  - `useMonitoring.js`
  - `RealtimeDataEngine.js`
  - `equipmentManager.js`
  - `connectors/WebSocketConnector.js`
  - `components/MultiObjectiveView.vue`
- 移除明确未使用符号：
  - `RealtimeDataEngine.js` 中的 `ENDPOINT_PATH_WINDOW`
  - `MultiObjectiveView.vue` 中的 `pickBestByCrowding`
- 重组 `siteSurfaceResolver.js`，由“大工厂函数”改为：
  - 顶层 helper
  - 轻量工厂封装

### 已取得的结果

- `realtime-monitoring` 内部日志更加统一
- `siteSurfaceResolver.js` 的职责边界更清晰
- 全局 warning 总数从 `175` 降至 `172`

---

## 3. 当前未完成项

## 3.1 高优先级

### 1. RealtimeDataEngine 深度收口

目标文件：

- `src/features/realtime-monitoring/services/RealtimeDataEngine.js`

当前问题：

- `sampleGroundHeight()` 复杂度高
- 文件整体仍偏长
- 地表采样、路径采样、时间轴数据管理仍有混合职责

建议动作：

- 抽离地表采样 helper
- 抽离路径采样/插值逻辑
- 继续压缩引擎类的方法复杂度

### 2. useMonitoring 主编排收口

目标文件：

- `src/features/realtime-monitoring/services/useMonitoring.js`

当前问题：

- 仍是较长的 orchestrator 文件
- 初始化、时间轴、告警、渲染节流等职责混合

建议动作：

- 抽离时间轴控制器
- 抽离告警管理
- 抽离渲染节流和 live/historical 模式切换

### 3. Model Control 模块收口

目标文件：

- `src/features/model-control/services/useModel.js`

当前问题：

- 文件和函数长度仍明显偏大
- 主编排承担过多状态与流程控制职责

建议动作：

- 优先拆初始化流程
- 拆点击交互与模型状态同步
- 逐步向更细粒度 service 收口

---

## 3.2 中优先级

### 4. NSGA-III 相关逻辑继续收口

目标文件：

- `src/features/realtime-monitoring/services/nsga3Core.js`
- `src/features/realtime-monitoring/components/MultiObjectiveView.vue`

当前问题：

- 文件偏长
- 部分核心函数复杂度仍高

建议动作：

- 将目标评估函数拆为更细的 objective 计算单元
- 将大组件中的数据计算逻辑继续迁到 composable 或 service

### 5. TruckSimulator 和 realtimeDataCore 小型复杂度治理

目标文件：

- `src/features/realtime-monitoring/services/TruckSimulator.js`
- `src/features/realtime-monitoring/services/realtimeDataCore.js`

建议动作：

- 将条件归一化逻辑抽成更小 helper
- 优先消除低成本 complexity warning

---

## 3.3 低优先级但必要

### 6. CI/CD 真正落地

当前状态：

- 已有文档和脚本基线
- 但尚未真正补齐：
  - GitHub Actions
  - Dockerfile
  - 部署回滚脚本

建议动作：

- 先落地 `lint + imports:check + build`
- 测试脚本完善后再加入 test 阶段

### 7. 依赖图与循环依赖检测

当前状态：

- 尚未真正接入 `madge`

建议动作：

- 新增依赖检查脚本
- 先扫描 `src/`
- 确认跨模块循环依赖风险后再收规则

### 8. 可观测性下一阶段

当前状态：

- 已有 logger 和基础错误捕获

下一步建议：

- 接入 Sentry
- 上传 SourceMap
- 补齐核心性能埋点
- 再考虑 Session Replay

---

## 4. 建议的下一阶段执行顺序

| 顺序 | 模块 | 动作 | 预期收益 |
|---|---|---|---|
| 1 | `realtime-monitoring` | 拆 `RealtimeDataEngine.js` 的地表采样与路径采样逻辑 | 降低复杂度，便于后续稳定维护 |
| 2 | `realtime-monitoring` | 收口 `useMonitoring.js` 编排逻辑 | 降低主入口维护成本 |
| 3 | `model-control` | 拆 `useModel.js` 的主流程 | 缓解模型模块耦合 |
| 4 | `realtime-monitoring` | 继续精简 `nsga3Core.js` 与 `MultiObjectiveView.vue` | 提升调度模块可读性 |
| 5 | 工程化 | 补 CI/CD、Docker、依赖检查 | 让治理成果进入自动化流程 |
| 6 | 可观测性 | 接入 Sentry 与 SourceMap | 提升线上问题定位能力 |

---

## 5. 验收口径

### 已达到

- `lint error = 0`
- `build = 通过`
- 文档基线已建立
- 环境变量示例已补齐
- 日志与错误捕获基础设施已上线

### 下一阶段验收目标

- `warning` 总数持续下降
- `realtime-monitoring` 主体文件继续瘦身
- `model-control` 进入第二轮结构治理
- CI/CD 从文档状态变成可执行状态

---

## 6. 备注

- 原始建议方案保留在 `docs/optimization-plan.md`，适合作为总体方向参考。
- 本文档更偏“实施跟踪”，应在每轮优化后持续更新。
- 若后续优先级变化，应优先调整“第 4 节 建议的下一阶段执行顺序”。
