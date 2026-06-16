# 地下金属矿数字孪生可视化平台

基于 `Vue 3 + CesiumJS + FastAPI` 的地下金属矿山三维数字孪生平台，提供模型控制、地质分析、实时监控、应力分析、爆破模拟和系统工具等功能。

## 当前架构

仓库按前后端分离组织：

```text
cesium-simulation-platform/
├── cesium1/      # 前端：Vue 3 + Vite + Cesium
└── backend-py/   # 后端：FastAPI + PyMySQL
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3（Composition API + `<script setup>`） |
| 状态管理 | Pinia |
| 三维引擎 | CesiumJS 1.138 |
| UI 组件库 | Element Plus |
| 样式方案 | Tailwind CSS 3 |
| HTTP | 原生 `fetch` |
| 构建工具 | Vite 5 |
| 后端框架 | FastAPI |
| 数据库访问 | PyMySQL |
| 代码检查 | ESLint 8 + Prettier |

## 启动方式

### 前置要求

- Node.js >= 18
- npm >= 9
- Python >= 3.11
- 可访问的 MySQL 实例

### 启动后端

在 `backend-py/` 目录执行：

```bash
pip install -r requirements.txt
python main.py
```

默认启动地址为 `http://localhost:3003`。

可通过环境变量调整：

```bash
API_PORT=3003
CORS_ALLOW_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
CORS_ALLOW_CREDENTIALS=true
```

### 启动前端

在 `cesium1/` 目录执行：

```bash
npm install
npm run dev
```

默认地址为 `http://localhost:3000`，并通过 Vite 代理将 `/api` 请求转发到 `http://localhost:3003`。

### 生产构建

```bash
npm run build
npm run preview
```

## 常用命令

```bash
npm run dev
npm run build
npm run preview
npm run lint
npm run lint:check
npm run format
npm run audit:prod
```

## 目录结构

```text
cesium1/
├── public/                     # Cesium 资源、3D Tiles、静态示例数据
├── src/
│   ├── app/                    # 应用启动与编排
│   ├── components/             # 通用组件
│   ├── composables/            # 通用组合式函数
│   ├── config/constants/       # 运行时默认配置
│   ├── features/               # 按业务域划分的功能模块
│   ├── services/api/           # API 初始化与配置加载
│   └── stores/                 # Pinia 状态仓库
├── vite.config.js
├── eslint.config.js
└── package.json
```

## 功能模块

| 模块 | ID | 说明 |
|------|-----|------|
| 模型控制 | `model_control` | 3D 模型加载、变换、透明度、地下视图、特征管理 |
| 地质分析 | `geology` | 钻孔可视化、地质剖面、矿体分析 |
| 测量分析 | `measure` | 距离、面积与历史记录 |
| 模型切割 | `clipping` | 平面裁剪、多边形裁剪 |
| 现场调度中心 | `monitoring` | 实时监控、路径管理、轨迹回放 |
| 爆破模拟 | `blasting` | 爆破轨迹与动画 |
| LOD 优化 | `lod` | FPS 监控与自适应降级 |
| 应力分析 | `stress` | 热力图、插值与安全评估 |
| 实验分析 | `experiment` | 插值性能与精度基准 |
| 系统工具 | `system` | 导出、截图与显示配置 |

## 后端 API

后端当前暴露的主要接口如下。

### 健康检查

- `GET /api/health`

### 模型配置

- `GET /api/models`
- `GET /api/models/{model_id}`
- `POST /api/models/`
- `PUT /api/models/{model_id}`
- `DELETE /api/models/{model_id}`
- `GET /api/models/{model_id}/features`
- `GET /api/models/{model_id}/scenetree`
- `GET /api/models/{model_id}/tileset`
- `GET /api/models/by-path/tileset?path=...`
- `POST /api/models/save`

### 矿卡

- `GET /api/trucks`
- `GET /api/trucks/{truck_id}`
- `POST /api/trucks/`
- `PUT /api/trucks/{truck_id}`
- `DELETE /api/trucks/{truck_id}`

### 钻孔

- `GET /api/boreholes`
- `GET /api/boreholes/{borehole_id}`
- `POST /api/boreholes/`
- `PUT /api/boreholes/{borehole_id}`
- `DELETE /api/boreholes/{borehole_id}`

### 矿体

- `GET /api/orebodies`
- `GET /api/orebodies/{orebody_id}`
- `POST /api/orebodies/`
- `PUT /api/orebodies/{orebody_id}`
- `DELETE /api/orebodies/{orebody_id}`

### 辅助配置

- `GET /api/monitoring/minerals`
- `GET /api/monitoring/mining-pits`
- `GET /api/geology/stats`

### 路线管理

- `GET /api/truck-routes`
- `GET /api/truck-routes/default`
- `GET /api/truck-routes/{route_id}`
- `POST /api/truck-routes`
- `PUT /api/truck-routes/{route_id}`
- `PUT /api/truck-routes/{route_id}/set-default`
- `DELETE /api/truck-routes/{route_id}`

## 运行说明

### 公共 API 层

跨功能模块的公共导出统一放在 `@/features/shared/index.js`，优先通过该入口复用模块能力。

### 路线离线兜底

默认情况下，监控模块只使用数据库中的路线配置。

如需启用本地 `localStorage` 或 `public/default-route.json` 作为离线兜底，请显式设置：

```bash
VITE_ENABLE_ROUTE_OFFLINE_FALLBACK=true
```

### 自适应 LOD

系统会根据 FPS 逐级调整渲染质量，在性能恢复后再逐步回升。
