# 部署说明

## 目录约定

- 前端目录：`cesium1/`
- 后端目录：`backend-py/`

## 前端环境变量

复制 `cesium1/.env.example` 为本地环境文件：

```bash
cp .env.example .env
```

关键变量：

- `VITE_CESIUM_TOKEN`：Cesium ion Token。
- `VITE_CESIUM_ASSETS_URL`：Cesium 静态资源基址，默认 `/`。
- `VITE_ENABLE_ROUTE_OFFLINE_FALLBACK`：是否启用离线路线兜底。
- `VITE_SENTRY_DSN`：预留给后续错误上报平台。

## 后端环境变量

复制 `backend-py/.env.example` 为本地环境文件：

```bash
cp .env.example .env
```

关键变量：

- `API_PORT`：FastAPI 启动端口，默认 `3003`。
- `CORS_ALLOW_ORIGINS`：允许的前端来源，多个值用逗号分隔。
- `CORS_ALLOW_CREDENTIALS`：是否允许携带凭证。

## 本地构建

前端：

```bash
npm install
npm run lint:check
npm run imports:check
npm run build
```

后端：

```bash
pip install -r requirements.txt
python main.py
```

## 生产部署建议

- 使用 Nginx 托管 `cesium1/dist/`。
- 将 `/api` 反向代理到 `backend-py` 服务。
- 将 Cesium 静态资源与 3D Tiles 数据放在稳定的静态资源域名，并配置 `VITE_CESIUM_ASSETS_URL`。
- 前端构建产物与后端服务分别部署，避免运行时耦合。

## 可观测性建议

- 保留 `logger.js` 作为统一日志入口。
- 浏览器全局错误捕获统一通过 `globalErrorCapture.js` 安装。
- `viewer-init` 与 `api-config-load` 已加入 Performance API，可在 Chrome DevTools 中查看。

## Swagger 入口

后端 FastAPI 默认文档地址：

- `http://localhost:3003/docs`
