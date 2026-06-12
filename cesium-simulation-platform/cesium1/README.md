# 地下金属矿数字孪生可视化平台

基于 CesiumJS + Vue 3 的地下金属矿山三维数字孪生可视化平台，提供模型控制、地质分析、应力分析、爆破模拟、实时调度监控等功能。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3（Composition API + `<script setup>`） |
| 状态管理 | Pinia |
| 3D 引擎 | CesiumJS 1.138 |
| UI 组件库 | Element Plus |
| CSS 框架 | Tailwind CSS 3 |
| HTTP 客户端 | Axios |
| 构建工具 | Vite 5 |
| 后端 | Express 5 + better-sqlite3 |
| 代码检查 | ESLint 8 + Prettier |

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装与运行

```bash
# 1. 安装依赖
npm install

# 2. 配置 Cesium Ion Token（可选，使用默认 token 即可）
# 编辑 .env 文件中的 VITE_CESIUM_TOKEN

# 3. 同时启动前端开发服务器 + API 服务器
npm run dev:all

# 或者分别启动：
npm run dev          # 前端 → http://localhost:3000
npm run dev:server   # API  → http://localhost:3001
```

### 生产构建

```bash
npm run build
npm run preview
```

## 项目结构

```
cesium1/
├── public/                     # 静态资源
│   ├── 3d/                     # 3D 模型（GLB / 3D Tiles）
│   │   ├── demo4/              # 默认模型（tileset.json + GLB）
│   │   └── models.json         # 模型索引
│   ├── simulation-config.json  # 卡车仿真参数
│   ├── trucks-config.json      # 卡车单元配置
│   └── default-route.json      # 默认运输路线
├── server/                     # Express API 服务
│   ├── index.js                # 入口，路由挂载
│   ├── db.js                   # SQLite 数据库（含种子数据）
│   └── routes/                 # 路由模块（8 个业务域）
├── src/
│   ├── main.js                 # Vue 应用入口
│   ├── App.vue                 # 根组件
│   ├── app/                    # 应用启动引导
│   ├── assets/styles/          # 全局样式 + CSS 变量
│   ├── components/             # 全局组件（BasePanel、RightSidebar 等）
│   ├── composables/            # 通用组合函数（useViewer、useLifecycle 等）
│   ├── config/constants/       # 硬编码默认配置
│   ├── features/               # 功能模块（见下方功能列表）
│   │   ├── shared/             # 公共 API 层（跨模块导入入口）
│   │   └── toolRegistry.js     # 工具注册表
│   ├── services/api/           # API 服务层
│   └── stores/                 # Pinia 状态仓库
├── .env                        # 环境变量
├── vite.config.js              # Vite 配置
├── eslint.config.js            # ESLint 配置
├── tailwind.config.js          # Tailwind 配置
└── package.json
```

## 功能模块

| 模块 | ID | 说明 |
|------|-----|------|
| 模型控制 | `model_control` | 3D 模型加载、变换、透明度、地下视图、特征管理 |
| 地质分析 | `geology` | 钻孔可视化、地质剖面、矿体储量计算 |
| 测量分析 | `measure` | 直线/地形距离测量、面积测量、历史记录 |
| 模型切割 | `clipping` | 平面裁剪、多边形裁剪 |
| 现场调度中心 | `monitoring` | 矿车实时监控、数据引擎、路径回放 |
| 爆破模拟 | `blasting` | 爆破碎片轨迹、冲击波动画 |
| LOD 优化 | `lod` | FPS 监控、自适应降级、质量预设 |
| 应力分析 | `stress` | 热力图渲染、IDW/Kriging 插值、安全评估 |
| 实验分析 | `experiment` | IDW/Kriging 基准测试、交叉验证 |
| 系统工具 | `system` | 场景导出（JSON/报告/截图/CSV）、坐标系切换 |

## 常用命令

```bash
npm run dev          # 启动前端开发服务器
npm run dev:server   # 启动 API 服务器
npm run dev:all      # 同时启动前后端
npm run build        # 生产构建
npm run preview      # 预览生产构建
npm run lint         # ESLint 检查并修复
npm run lint:check   # ESLint 仅检查
npm run format       # Prettier 格式化
npm run audit:prod   # 生产依赖审计
```

## API 端点

API 服务运行在 `http://localhost:3001/api/`，前端 Vite 开发服务器自动代理 `/api` 请求。

### 模型配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models` | 获取所有模型配置 |
| GET | `/api/models/:id/feature` | 获取指定模型特征 |

### 应用配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/app-config` | 获取所有应用设置 |
| GET | `/api/app-config/:key` | 获取单个设置项 |

### 监控数据
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/monitoring/cameras` | 相机预设 |
| GET | `/api/monitoring/minerals` | 矿物类型 |
| GET | `/api/monitoring/transport-units` | 运输单元 |
| GET | `/api/monitoring/mining-pits` | 采场规格 |
| GET | `/api/monitoring/trucks` | 卡车配置 |
| GET | `/api/monitoring/simulation` | 仿真参数 |
| GET | `/api/monitoring/full-config` | 聚合：全部监控配置 |

### 应力分析
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stress/metrics` | 应力指标定义 |
| GET | `/api/stress/heatmap-ramp` | 热力图色带 |
| GET | `/api/stress/warning-rules` | 预警规则 |
| GET | `/api/stress/defaults` | 默认指标/单位 |

### 地质数据
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/geology/orebodies` | 矿体列表 |
| GET | `/api/geology/stats` | 汇总统计 |
| GET | `/api/geology/full` | 聚合：矿体 + 统计 |

### 实验分析
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/experiment/presets` | 实验预设 |
| GET | `/api/experiment/methods` | 插值方法 |
| GET | `/api/experiment/default-config` | 默认配置 |
| GET | `/api/experiment/full` | 聚合：全部实验配置 |

### 爆破模拟
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/blasting/config` | 爆破配置 |

### 系统工具
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system/tools` | 工具注册表 |
| GET | `/api/system/display-profiles` | 显示/地形质量配置 |
| GET | `/api/system/full` | 聚合：工具 + 显示配置 |

### 其他
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/db-view` | 数据库浏览页面（HTML） |

## 架构说明

### 公共 API 层

跨功能模块通信统一通过 `@/features/shared/` 入口：

```js
// 推荐：从公共 API 层导入
import { useModel, useMeasurement, useClipping } from '@/features/shared/index.js'

// 也可直接导入特定功能模块（用于功能模块内部）
import useModel from '@/features/model-control/services/useModel.js'
```

### 优雅降级

所有 API 服务均内建回退机制——后端不可用时自动使用本地默认数据，确保离线可用。

### 自适应 LOD

系统实时监控 FPS，当性能下降时自动逐级降低 LOD 配置（提高细节阈值 → 低精度分支 → 低分辨率地形），性能恢复后逐级复原。
