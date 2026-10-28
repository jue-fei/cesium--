# LS-DYNA → Web 数字孪生可视化（工作区）

把 LS-DYNA `d3plot` 转成自描述容器（`mesh.bin` / `frames.bin`），在浏览器里做云图/剖切/粒子/图表展示。

## 目录

| 路径 | 说明 |
|---|---|
| `dyna2web.py` | 转换器（`--stage probe` 探测 / `all` 写容器） |
| `config/field_spec.json` | 字段注册表（前后端共享） |
| `config/fieldmaps.json` | 本构 → `nv3d` word 偏移 |
| `config/layouts.json` | 版本/求解器 → 状态块布局 |
| `webapp/index.html` + `webapp/ui.css` | 前端（容器-only，Three.js） |
| `webapp/start_server.py` | 本地服务器（Range + 导入/取消/报告 API） |
| `webapp/data_v3/` | 容器与 `cases.json` |
| `docs/usage_v8.md` | CLI / 容器 / 错误码 / 校验手册 |
| `tests/validate_container.js` | 容器校验器（块边界/帧索引/抽样解码） |
| `tests/gen_fixtures.py` + `tests/fixtures/` | fixture 生成与回归样本 |
| `reports/{key}.report.json` | 转换审计报告 |

## 快速开始

```powershell
cd 工作区

# 1) 探测
python dyna2web.py "D:\lsdyna\case1" --key case1 --stage probe

# 2) 转换（单元级核心场 + 速度 + 校验）
python dyna2web.py "D:\lsdyna\case1" --key case1 `
  --k "D:\lsdyna\case1\model.k" --stage all --compress zstd --verify `
  --field-location element --extract velocity

# 3) 启动
python webapp/start_server.py     # http://localhost:8765/
```

## 校验

```powershell
node tests/run_all.js --with-fixture     # 容器 + 数据层 + 粒子 + 冒烟 + fixture
python tests/gen_fixtures.py --force     # 重建 3.5 MB fixture
```

## 当前能力

- 7 个算例（FEM / ALE / SPH+PBM），`schema_version=2`，全部 `verify.ok=true`
- 字段：位移 / 损伤 / 应变 / 压力（element 或 node）、速度 / 加速度、应力 6 分量 + `vm/σ1/σ3`、SPH/PBM、`hist`（可选）
- 前端：2 着色 + 5 叠加、色板/色阶/等值线/色标范围、变形缩放、部件显隐+隔离、单轴剖切（截面/剪切、Alt 拖动）、多点取点 + CSV、Shift 悬浮探针、时间轴起爆标记、URL 状态同步、PNG 导出、6 张图表
- 工程：容器校验器 + fixture + `usage_v8.md` + 一键 `run_all`

## 元数据入库（MySQL）

算例与产物文件信息以 MySQL 为权威源，磁盘只放容器本体（`mesh.bin` / `frames.bin`）。

| 表 | 粒度 | 关键列 |
|---|---|---|
| `dyna_cases` | 一算例一行 | `label` / `type` / `nframes` / `mesh_bytes` / `frames_bytes` / `summary_json`（原 cases.json 条目） |
| `dyna_case_files` | 一算例一文件一行 | `role`(mesh/frames/report) / `bytes` / `raw_bytes` / `codec` / `ratio` / `nframes` / `frame_bytes` / `mtime` / `exists_flag` |

```powershell
cd ..\backend-py
.venv\Scripts\python.exe migrate_dyna.py          # 全量同步（自动建表 + upsert）
.venv\Scripts\python.exe migrate_dyna.py tnt_1    # 只同步单例
```

- 接口：`GET /api/dyna/cases`（清单）、`GET /api/dyna/files[?key=]`（文件明细 + 压缩前/后汇总）
- 转换完成（webapp 导入或 `/api/dyna/convert`）会自动 upsert 上述两张表，失败不阻断转换
- `frames.bytes` 是**压缩后**实际占用；`raw_bytes` 取自转换报告 `container.frames.raw_bytes`，`ratio ≈ 2.0~2.8×`（u2 量化 + 每帧 zstd-9）。关掉压缩会回到 `raw_bytes` 量级。

### 删除算例

`DELETE /api/dyna/cases/{key}` —— 一次清干净：`dyna_cases` + `dyna_case_files` 行、`mesh.bin` / `frames.bin`、`reports/<key>.report.json`、`cases.json` 条目。
`?keep_files=true` 只摘元数据、保留文件。文件删除只认 `cases.json` 登记过的文件名且限制在存储根内，不接受任意路径。

前端：算例标签悬停出现 `×`，二次确认后删除并自动切到剩余算例。

## 渲染与播放

- **帧解码在 Web Worker**（`lib/decode_worker.js`，module worker）：zstd 解压 + u2→f32 换算全部离主线程。
  解码器优先 **WASM zstd**（`lib/zstddec.mjs`，wasm 内联在文件里，无外部依赖），失败回退纯 JS `fzstd`。
  实测单帧（Node，同帧数据、输出逐字节一致）：

  | 算例 | 解压后 | fzstd | WASM | 提速 |
  |---|---:|---:|---:|---:|
  | airblast | 2.9 MB | 97 ms | 29 ms | 3.4× |
  | tnt_1 | 3.3 MB | 52 ms | 15 ms | 3.5× |
  | smooth | 10.9 MB | 136 ms | 41 ms | 3.3× |
  | sph1 | 28.7 MB | 317 ms | 138 ms | 2.3× |

  浏览器内实测 airblast 取帧+解码 29~35 ms（此前 fzstd 约 90~100 ms）。
- **播放节流**：按真实时间推进，目标帧率 `0.5×=15 / 1×=30 / 2×=60 / 4×=120 fps`（旧实现是每 12 个 RAF 推进一帧 ≈ 5 fps）。
  上一帧渲染完成才推进下一帧；解码是瓶颈时不丢帧（宁可降帧率也看全每帧），只有目标帧率高于屏幕刷新时才小幅跳帧。
  预取最多 2 帧在飞。
- **纯 ALE 算例**（airblast：只有 air + explosive 部件）默认强制打开空气面并落在 `pressure` 场，
  否则「默认只画岩石面」会整屏空白。
- 排障：控制台执行 `__v3diag()` 可看当前算例/字段/可见层/帧号/解码通道/实测 fps 与解码、渲染耗时。
  开启剖切后还会返回 `clip`（轴向/模式）与 `cut`（每层截面的顶点数/三角数/唯一位置数/场值范围）。

### 剖切截面

- **截面（section）** 由 `csgCutSolid` 逐单元求交得到：一个六面体被平面切出 3~6 个交点，按角度排序后扇形三角化。
  顶点不共享（4× 重复）是设计如此——每片多边形独立着色，便于按单元取场值。
- 顶点同时记录 `elemId`（所属单元），单元级字段（损伤/压力/应变…）靠它取到真实值；
  早期版本靠 `srcQuad` 判断"是否剖切几何"，而纯截面的 `srcQuad` 是**零长度数组（truthy）**，
  于是走了"裁剪表面"分支、`sq[v]` 为 undefined → 截面场值全部落 0 → 整片截面是最小色（发暗、发脏）。已修。
- 空气/炸药与结构面在剖切面上常完全共面（空气盒包住岩石）→ 深度相同会 z-fighting 出条纹；
  剖切期间给非结构层加 `polygonOffset(+2)` 把结构面稳定压在上面。
- **截面按当前帧的变形坐标求交**（`mo.ptsArr`），不再"初始坐标求交 + 每帧 aDisp 二次位移"。
  后者在大变形时会把截面顶点推出平面、互相穿插，表现为一束束彩色细条。
  代价：一次重建约 200ms（6.5 万单元 CSG），所以有 260ms 防抖；**播放期间不重建**（否则播放被卡死），
  暂停时由 `flushPendingCut()` 补切当前帧。静态看截面时每帧重建一次，延迟约 0.3s。
- 剪切（cut）模式 = 裁剪后的表面 + **逐单元截面多边形**拼成的封盖。
  早期封盖用耳切（`earClip`）沿截面环封口，在带孔洞（炮孔/空腔）的截面上会切出巨大薄片：
  实测最大三角形面积 333000（正常约 17），渲染出来就是一束束彩色细条。现在改成
  `concatCuts(表面, csgCutSolid(...))`，与「截面」模式共用同一套逐单元多边形，天然铺满切面。
  顺带修了 `concatCuts` 里 `srcA` 没被拼接（给了全 0 新数组）的问题——那会让合并几何的每个顶点
  都被算成 quad 0 的单元，侵蚀掩膜和单元字段全错。

### 剖切与粒子

- 粒子（SPH / PBM）**跟随剖切**：点云没有"截面"可言，做法是按 `clipPlane` 丢弃被切掉一侧的粒子，
  紧凑写入后 `setDrawRange` 只画保留部分（实测 X 轴中位剖切：SPH 48200→23995、PBM 26154→13758）。
  实现在 `v3Particles()` 里的 `cutKeepPoint()`；不依赖材质 `clippingPlanes`（点云上不可靠）。
- 剪切模式下**空气/炸药层不封盖**：它们的切面与结构层切面完全共面，两片共面三角形会 z-fighting，
  表现为"结构面上莫名出现一块块彩色/蓝色花斑"。
- 节点级字段（位移/速度/应力）在剖切几何上走 `nodeA/nodeB/wDisp` 插值；注意 `userData` 里的属性名是
  `wDisp`（由 `nodeW` 映射而来），写成 `nodeW` 会直接抛 `Cannot read properties of undefined`。
- 单元级字段（损伤/压力/应变）在切面上是**逐单元平涂**，所以看起来是一块一块的——这是数据本身，
  切到位移场即可看到平滑过渡，可用来判断"花斑是数据还是着色 bug"。
- **坑：`qa` 是层内局部 quad 序号，`quadOwner` 是全局序号**。剖切几何取单元值必须走
  `quadOwner[qfi[q*4]]`（`qfi` 是每层 4 顶点/quad 的局部→全局表），直接 `quadOwner[qa[v]]` 会让
  空气/炸药层读到结构层的单元值 → 表现为"原本没有热力图的空气 part 切割后凭空出现热力图"。

### 前端版本自检（避免"改了却看到旧页面"）

- 左上角 `BUILD xxxxxxx` 读的是 `<meta name="dyna-build">`，与 `BUILD` 常量、`ui.css?v=` 同源，**改前端必须一起 bump**。
- `GET /api/dyna/page_version` 返回服务器上 index.html 的构建号；页面启动时比对，不一致直接提示强制刷新。
- `/dyna` 下所有静态资源由后端中间件强制 `Cache-Control: no-store`。

## 体积构成

`docs/存储体积报告.html`（自包含页面，可直接浏览器打开）给出逐算例体积、帧内字段占比与瘦身手段的预估收益；
数据由 `docs/gen_size_report.py` 从容器头 + 转换报告 + 源 d3plot 目录现算，重转或删算例后复跑即可刷新：

```powershell
python docs/gen_size_report.py docs/存储体积报告.html
```

要点：容器约为源 d3plot 的 9%（30 GiB → 2.7 GiB），已在转换阶段做 u2 量化 + 每帧 zstd（≈2.0×）；
剩余体积由 `帧数 × 单元/节点数 × 字段数 × 精度` 决定，其中 `stress`（6 分量 f4）占每帧 57~61%。

### 导入与进度

`POST /api/dyna/convert` 启动转换子进程，前端每秒轮询 `GET /api/dyna/job?id=` 拿 `status / log / progress`。
`progress` 由后端从转换日志解析（不改转换器）：

| 阶段 | 百分比 | 触发日志 |
|---|---|---|
| 解析 d3plot 布局 / 识别单元类型 / 装配表面 / 规划字段 | 6 → 28% | `块表` `元素类型` `外表面` `字段:` |
| 写入 mesh.bin / 计算量化系数 | 34 → 38% | `mesh.bin` `u2 归一化` |
| 逐帧转换 | 40 → 97% | `帧 n/m`（含 `压缩 a/b MB`） |
| 完成 | 100% | `完成:` |

- `progress` 结构：`{stage, label, pct, done, total, writtenMB, frameMB, elapsed}`，只前进不后退。
- 子进程必须 `PYTHONUNBUFFERED=1`，否则 stdout 走管道时是块缓冲，进度要等结束才一次性吐出来（踩过）。
- 前端：导入弹窗里的进度条 + 阶段文字 + `n/m 帧 · 本帧 a/b MB` + 已用时间；完成后变绿并停留 0.7s 再关闭弹窗。
  后端没给 `progress` 时（旧后端 / 独立 8765 服务）前端会从日志里正则兜底。

## 已知限制

- 仅六面体实体；四面体/壳场值/梁/2D/厚壳未实现（壳仅静态几何、未验证）
- 不支持 MPP rank 合并（检测即报错）
- 仅小端 d3plot；大端会明确报错
- `*PARAMETER` 仅展开数值；`*INCLUDE` 已支持递归/循环检测
- `--verify` 抽样 4 帧，非全帧
- 前端首帧/切帧性能尚未实测
