# 贡献指南

## 分支建议

- `main`：稳定分支。
- `feature/*`：新功能开发。
- `fix/*`：缺陷修复。
- `refactor/*`：重构与工程化治理。

## 提交前检查

前端目录 `cesium1/` 中执行：

```bash
npm run lint:check
npm run imports:check
npm run build
```

后端目录 `backend-py/` 中执行：

```bash
python main.py
```

## 代码约定

- `App.vue`、`src/components/`、`src/composables/` 优先从 `src/features/shared/index.js` 导入功能模块。
- 不直接赋值 `window.onerror` 或 `window.onunhandledrejection`，统一走 `src/utils/globalErrorCapture.js`。
- 业务日志不直接散落 `console.*`，优先走 `src/utils/logger.js`。
- 新增环境变量时同步更新 `.env.example` 和 `README.md`。

## 文档要求

- 新增部署相关变更时同步更新 `docs/deployment.md`。
- 新增跨模块能力或导出入口时同步更新 `docs/architecture.md`。
- 大型重构前先在 `docs/` 下补充方案，再落地代码。
