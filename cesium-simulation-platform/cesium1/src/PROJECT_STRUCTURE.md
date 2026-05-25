# 项目目录与分层规范

## 1. 顶层分层

- `components/`：跨功能复用的通用 UI 组件
- `features/`：按业务域划分的功能模块
- `composables/`：跨页面状态编排与业务流程封装
- `stores/`：Pinia 状态仓库
- `config/`：常量与静态配置
- `assets/`：全局样式与静态资源
- `utils/`：与业务无关的工具能力（当前仅保留 bench）

## 2. 依赖方向

- `components` 可依赖 `composables`
- `composables` 可依赖 `features` 与 `stores`
- `features` 不依赖 `composables`
- `stores` 不依赖 `features`

## 3. 命名与放置规则

- 组合式函数统一放在 `src/composables/useXxx.js`
- Pinia 仓库统一放在 `src/stores/*Store.js`
- 业务模块内部可继续细分为 `core/panel/components/composables`
- Feature 私有 API 放在对应模块目录内，例如 `features/model/modelApi.js`

## 4. 新增文件检查清单

- 是否放在最小职责目录
- 是否引入了反向依赖
- 是否使用统一别名导入（`@/composables`、`@/stores`）
- 是否需要补充对应模块文档与测试
