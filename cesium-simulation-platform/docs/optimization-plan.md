# 三维数字孪生平台（Cesium）优化方案

> 覆盖维度：1. 代码可读性与一致性、2. 模块化与耦合度、5. 项目结构与文档完整性、7. 构建/部署/CI/CD、9. 可观测性与日志。

---

## 1. 代码可读性与一致性（当前 6 分 → 目标 8 分）

### 现状痛点
- 核心服务文件严重超长：`src/features/stress-analysis/services/useStress.js` 932 行、`src/features/model-control/services/useModel.js` 591 行、`src/features/realtime-monitoring/services/RealtimeDataEngine.js` 709 行，函数平均长度远超 50 行阈值。
- JSDoc 覆盖率不足 5%，大量导出函数缺乏参数与返回值说明。
- 常量虽已提取，但部分业务文件仍存在内联字面量（如 `cooldownMs` 计算中的 `0.75` 等）。

### 量化目标
- 函数平均长度 ≤ 40 行，单个文件长度 ≤ 300 行（软限制）。
- 所有 `export` 函数 JSDoc 覆盖率 ≥ 80%。
- ESLint 报错数为 0，`max-lines-per-function` 规则阈值 50 行。

### 具体实施动作

| 步骤 | 动作 | 负责人 | 周期 |
|---|---|---|---|
| 1.1 | 在 `eslint.config.js` 中新增规则：`max-lines-per-function: [error, 50]`、`max-lines: [warn, 300]`、`complexity: [warn, 10]`。 | 前端负责人 | 0.5 天 |
| 1.2 | 安装 `eslint-plugin-jsdoc`，配置 `'jsdoc/require-jsdoc': ['error', { require: { FunctionDeclaration: true, MethodDefinition: true } }]`。 | 前端负责人 | 0.5 天 |
| 1.3 | 拆分 `useStress.js` 为 `stressDataService.js`（数据获取/状态）、`stressRenderService.js`（热力图/颜色映射）、`stressInteractionService.js`（用户交互/事件绑定）；保持对外接口不变，通过 `useStress.js` 重新导出。 | 核心开发 | 3 天 |
| 1.4 | 拆分 `useModel.js` 为 `modelLoadService.js`、`modelTransformService.js`、`modelCacheService.js`；同理处理 `useMonitoring.js`。 | 核心开发 | 3 天 |
| 1.5 | 对 `src/features/` 下所有 `export function` 批量补充 JSDoc（使用 IDE 批量模板生成）。 | 全体前端 | 2 天 |
| 1.6 | 统一常量命名：将散落在业务代码中的阈值、魔法字符串迁移至对应 `features/xxx/types/xxxDefaults.js` 或 `config/constants/`。 | 核心开发 | 1 天 |

### 验收标准
- `npm run lint:check` 零报错。
- `npx cloc src/ --by-file` 统计：JS 文件平均长度 ≤ 250 行。
- Code Review 随机抽查 20 个导出函数，JSDoc 完整率 ≥ 80%。

---

## 2. 模块化与耦合度（当前 7 分 → 目标 9 分）

### 现状痛点
- `useModel.js` 存在模块级隐式单例 `sharedModelService`，导致跨调用状态耦合。
- `window.CESIUM_BASE_URL`、`window.onerror`、`window.onunhandledrejection` 3 个自定义全局变量。
- 缺乏自动化循环依赖检测工具。

### 量化目标
- 全局自定义 window 变量数量 = 0。
- 模块间跨域导入全部通过 `features/shared/index.js` 完成，直接相对路径跨模块导入数 = 0。
- 无循环依赖（madge 报告循环依赖数为 0）。

### 具体实施动作

| 步骤 | 动作 | 负责人 | 周期 |
|---|---|---|---|
| 2.1 | 消除隐式单例：将 `let sharedModelService = null` 改为 `export function createModelService(deps)` 工厂函数；由 `createAppBootstrap.js` 统一实例化并注入 `viewer` / `store`。 | 架构师 | 2 天 |
| 2.2 | 全局变量治理：将 `window.CESIUM_BASE_URL = '/'` 移除，改为在 `index.html` 中通过 `<meta name="cesium-base-url" content="/">` 或 Vite `define` 注入；`window.onerror` / `onunhandledrejection` 封装到 `src/utils/globalErrorCapture.js`，内部使用 `addEventListener('error', ...)` 与 `addEventListener('unhandledrejection', ...)`，不再污染 `window` 属性。 | 核心开发 | 1 天 |
| 2.3 | 安装 `madge`（`npm install -D madge`），在 `package.json` 增加 `"deps:check": "madge --circular src/main.js"`，并在 CI 中阻断循环依赖。 | 前端负责人 | 0.5 天 |
| 2.4 | 强化导入管控：在 `eslint.config.js` 中配置 `no-restricted-imports`，禁止 `features/xxx/services` 被其他 features 直接相对路径引用（只允许通过 `features/shared/index.js` 暴露）。 | 前端负责人 | 1 天 |

### 验收标准
- `madge --circular src/main.js` 输出为空。
- `grep -r "window\.CESIUM_BASE_URL\|window\.onerror\s*=" src/` 无匹配（除封装文件外）。
- ESLint `no-restricted-imports` 对违规跨模块导入报错。

---

## 5. 项目结构与文档完整性（当前 6 分 → 目标 8 分）

### 现状痛点
- 无架构图/模块依赖图，新成员难以快速理解 10+ 个 feature 的交互关系。
- README 缺少 Cesium ion Token 配置说明、生产部署步骤、API 文档入口。
- 无独立 `docs/` 目录，文档与源码混杂。

### 量化目标
- 新增 `docs/` 目录，包含架构图、部署手册、贡献指南。
- README 关键章节覆盖率 100%（启动、构建、Token 配置、部署、API 入口）。
- 后端 FastAPI 自动文档（Swagger）可用，并在 README 中显式链接。

### 具体实施动作

| 步骤 | 动作 | 负责人 | 周期 |
|---|---|---|---|
| 5.1 | 在仓库根目录创建 `docs/`：包含 `architecture.md`（C4 容器图+组件图，使用 Mermaid 语法）、`deployment.md`（Docker/Nginx/CDN 配置）、`contributing.md`（Git 分支策略、提交规范）。 | 技术负责人 | 2 天 |
| 5.2 | 更新 `README.md`：新增 "Cesium ion Token 配置" 章节（说明 `.env` + `VITE_CESIUM_TOKEN`）；新增 "生产部署" 章节（指向 `docs/deployment.md`）；新增 "API 文档" 章节（链接到后端 `http://localhost:3003/docs`）。 | 前端负责人 | 0.5 天 |
| 5.3 | 后端 FastAPI 已天然支持 Swagger，确认 `backend-py/main.py` 中已挂载 `docs_url="/docs"`；若未挂载，补充并确保生产环境可访问（或内网限制 IP）。 | 后端负责人 | 0.5 天 |
| 5.4 | 在 `docs/architecture.md` 中绘制模块依赖矩阵：列出 `features/` 下 10 个业务域的依赖方向（谁依赖谁，通过 `features/shared/index.js` 还是直接引用）。 | 架构师 | 1 天 |

### 验收标准
- `docs/` 目录下至少包含 `architecture.md`、`deployment.md`、`contributing.md`。
- README 中存在 `VITE_CESIUM_TOKEN` 配置说明与 Swagger 链接。
- 新成员可在不询问他人的情况下，30 分钟内完成本地环境搭建（依据 README）。

---

## 7. 构建、部署与 CI/CD（当前 4 分 → 目标 8 分）

### 现状痛点
- 无 CI/CD 流水线，构建与部署完全手动。
- 无 `.env.example`，新成员无法得知必填环境变量。
- 无 Dockerfile，缺乏标准化运行环境。
- `public/Assets/` 中 Cesium 静态资源体积庞大，未做 CDN 分离。

### 量化目标
- 提交代码后 10 分钟内自动完成 lint + test + build + docker push。
- 构建产物支持 brotli 压缩（当前仅 gzip）。
- 回滚时间 < 5 分钟。

### 具体实施动作

| 步骤 | 动作 | 负责人 | 周期 |
|---|---|---|---|
| 7.1 | 新增 `.env.example`：列出 `VITE_CESIUM_TOKEN=`、`API_PORT=3003`、`CORS_ALLOW_ORIGINS=` 等必填/选填项及说明。 | 前端负责人 | 0.5 天 |
| 7.2 | 编写 `Dockerfile`（多阶段）：`node:20-alpine` 阶段执行 `npm ci && npm run build`；`nginx:alpine` 阶段托管 `dist/`，并配置 `nginx.conf` 开启 brotli/gzip、缓存策略。 | 前端负责人 | 1 天 |
| 7.3 | 编写 `.github/workflows/ci.yml`：阶段 1 `lint`（`npm run lint:check`）→ 阶段 2 `test`（预留 `npm run test`）→ 阶段 3 `build`（`npm run build`）→ 阶段 4 `docker-build-push`（构建镜像并推送至镜像仓库，tag 为 `${GITHUB_SHA}`）。 | DevOps | 2 天 |
| 7.4 | 构建优化：在 `vite.config.js` 中新增 `brotli` 压缩（`vite-plugin-compression` 已装，只需补充 `algorithm: 'brotliCompress'`）；将 `public/Assets/` 中 Cesium 基础资源（如 `IAU2006_XYS`、`Textures`）迁移至 OSS/CDN，通过环境变量 `VITE_CESIUM_ASSETS_URL` 动态指定 `CESIUM_BASE_URL`。 | 核心开发 | 2 天 |
| 7.5 | 回滚能力：编写 `scripts/rollback.sh`，通过 `docker pull <image>:<prev-sha>` 并重启容器实现一键回滚；在 `docs/deployment.md` 中记录回滚 SOP。 | DevOps | 1 天 |

### 验收标准
- `.env.example` 存在且包含 `VITE_CESIUM_TOKEN`。
- GitHub Actions 每次 push 自动执行并绿通（即使 test 阶段为空，也需成功占位）。
- `dist/` 构建产物中同时存在 `.gz` 与 `.br` 文件。
- 执行 `./scripts/rollback.sh <commit-sha>` 后 5 分钟内服务恢复上一版本。

---

## 9. 可观测性与日志（当前 2 分 → 目标 8 分）

### 现状痛点
- `errorHandler.js` 实现为空，DEV 模式下未实际输出日志。
- 42 处 `console.*` 散布在 20 个文件中，生产环境无法收集与检索。
- 无 Sentry、无 Performance API 打点、无用户操作回放。

### 量化目标
- `console.*` 数量从 42 降至 0（仅允许在 `logger.js` 内部使用）。
- 首屏加载、瓦片加载、API 配置加载三大核心指标 100% 接入 Performance API。
- 前端错误自动上报率 100%（覆盖 `errorHandler`、`window.onerror`、`vue errorHandler`）。

### 具体实施动作

| 步骤 | 动作 | 负责人 | 周期 |
|---|---|---|---|
| 9.1 | 安装 `@sentry/vue` 与 `@sentry/browser`，在 `main.js` 中初始化 Sentry（DSN 通过 `import.meta.env.VITE_SENTRY_DSN` 注入）；配置 `release` 为 Git commit SHA，`environment` 为 `import.meta.env.MODE`。 | 前端负责人 | 1 天 |
| 9.2 | 实现 `src/utils/logger.js`：统一接口 `logger.info(scope, message, meta)`、`logger.warn`、`logger.error`。DEV 模式下输出带颜色与 JSON 的 console；生产模式下将 error 上报 Sentry，并将日志作为 Breadcrumb 附带。 | 核心开发 | 1 天 |
| 9.3 | 全量替换：使用 `grep -r "console\." src/` 列出全部 42 处，逐条替换为 `logger.xxx`；禁止后续新增（ESLint `no-console: error`）。 | 全体前端 | 2 天 |
| 9.4 | 核心性能打点：<br>1. 首屏：在 `useViewer.js` `initViewer` 首尾添加 `performance.mark('viewer-init-start/end')`；<br>2. 瓦片：在 `modelControl` 的 `tileset.readyPromise` 与 `tileset.tileLoad` 中标记 `performance.mark('tileset-load')`；<br>3. API：在 `initApiConfig.js` `loadApiConfig` 首尾标记 `api-config-load`。 | 核心开发 | 1.5 天 |
| 9.5 | 接入 Sentry Session Replay（或轻量级 `rrweb`）：采集 10% 用户会话，用于复现三维交互异常。 | 前端负责人 | 1 天 |
| 9.6 | 构建时 SourceMap 上传：在 `vite.config.js` 中配置 `sourcemap: true`，并在 CI 的 build 阶段后执行 Sentry CLI `sourcemaps upload`。 | DevOps | 1 天 |

### 验收标准
- `grep -r "console\." src/ | grep -v "logger.js"` 结果为空。
- Chrome DevTools Performance 中可观测到 `viewer-init`、`tileset-load`、`api-config-load` 三条标记。
- Sentry Issues 面板中可收到模拟抛出的测试错误，且包含完整堆栈与 release 版本。
- Sentry Replay 可正常播放一次完整的模型加载 + 面板切换会话。

---

## 整体落地路线图

| 阶段 | 周期 | 主要交付 | 预期综合评分提升 |
|---|---|---|---|
| **Phase 1：基线建设与质量门禁** | 第 1-2 周 | ESLint 规则硬化（函数长度/JSDoc）、`.env.example`、husky 强化、madge 循环依赖检测 | +0.3（可读性 6→7，模块化 7→8） |
| **Phase 2：核心重构与拆分** | 第 3-4 周 | useStress/useModel/useMonitoring 拆分、sharedModelService 改为工厂注入、全局变量清零 | +0.6（可读性 7→8，模块化 8→9） |
| **Phase 3：CI/CD 与构建标准化** | 第 5-6 周 | GitHub Actions、Dockerfile、brotli、CDN 分离、一键回滚脚本 | +0.4（CI/CD 4→8） |
| **Phase 4：可观测性上线** | 第 7-8 周 | Sentry 接入、logger 全量替换、Performance API 打点、rrweb 录制 | +0.5（可观测性 2→8） |
| **Phase 5：文档补全** | 贯穿全程，第 8 周验收 | docs/ 目录、架构图 Mermaid、部署手册、README 完善 | +0.2（文档 6→8） |

**按上述路线执行后，预计综合评分可从当前 5.2 分提升至 7.2 分以上。**
