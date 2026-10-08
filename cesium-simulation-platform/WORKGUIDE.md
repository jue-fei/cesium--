# 数智孪生平台后续工作指导

> 建立时间：2026-10-06 · 依据：3.2/3.3 两期完整交付后的项目状态
> 用途：新会话/新成员接手后续工作的自包含指导。配套硬约束全文见
> `c:\Users\allblack\.trae-cn\memory\projects\-c-Users-allblack-Desktop-2-------p2-ff43a68f5e85c07b0cee\project_memory.md`

---

## 一、平台与架构速览

- **任务书**：开采过程多工序多要素融合的数智孪生三维可视化技术
- **仓库**：`c:\Users\allblack\Desktop\2\cesium-simulation-platform`（工作目录 `早期版本` 是废弃快照，勿动）
- **技术栈**：Vue3 + Cesium + Three.js 前端（`cesium1/`，dev 端口 3000）；FastAPI 后端（`backend-py/`，端口 3003）；MySQL
- **分支状态**：main 领先 origin/main **15 commits**，最新提交 `52b8c45`（3.3 审计）
- **测试基线**：**vitest 33 文件 / 207 用例 + pytest 76 全绿**（每次全量跑，不许带病提交）

### 前端部署功能入口链（UI 深层，改动时需知道）

RightSidebar 第 5 图标（现场调度中心）→ MonitoringPanel → LhdSchedulingPanel → tab③ 默认渲染 nsga-placeholder → 点「放大查看多目标优化」（`.nsga-ph-btn`）→ nsgaFullscreen dialog → MultiObjectiveLhdView(expanded) → 「设备部署」toggle（`.deploy-toggle`）→ TunnelMap3D 拖拽模式

---

## 二、本次对话完成内容

### 3.2 拖拽式设备部署与出矿工序调整（提交 `4ddb7dd`，18 文件 +1234/-15）

**后端**：
- 部署真源 `config/deployments/{scenarioKey}.json`（tmp+os.replace 原子写，gitignore 不入库，缺失=空部署）
- `GET/PUT /api/deployment`：五重校验（设备/节点/水平范围/巷道归属/工序）→ 落盘 → `apply_deployment(only_idle=True)`——空闲设备即刻迁移待命点并清派单状态，**作业中设备不瞬移**、下次仿真重置生效
- 仿真器：`processOrder` 作为出矿工序优先级偏置 `PROCESS_PRIORITY_BIAS=5.0`（量级低于单趟总成本，只在近均衡候选间体现工序先后，非硬约束）；快照设备项新增 `level`
- 前端部署 API 路径为模板串运行时拼接（`` `/api/deployment${q}` ``）

**前端**：
- `useTunnelMap3DDeploy` 拖拽 composable：raycast 递归拾取设备 + 屏幕空间最近节点球吸附（SNAP_PX，跨水平所见即所得）+ 未命中回弹
- `LhdDeployPanel` 部署侧栏：部署清单 + 工序上移/下移/保存
- 部署模式冻结实时落位静态摆放；部署相机左键 PAN

**真机验证**：拖拽 LHD-01 跨水平吸附至 S0·L5 → UI 文案/侧栏更新 → 后端真源落盘 → 作业中设备（hauling 途中）不瞬移，全链路通过。

### 3.3 操作审计与可追溯（提交 `52b8c45`，15 文件 +1076/-4）

**后端**：
- `app/services/audit/audit_log.py`：JSONL 追加写 `config/audit/audit-log.jsonl`（gitignore 不入库；tmp+os.replace 原子落盘；线程锁防并发；超 2000 条压缩保留最近 1000；id 自增重启续接；**append 失败只 warning 绝不阻断业务**）
- **11 个审计点**显式植入各写路由成功路径（失败/校验不过不记录）：
  - 调度域 6：`deployment.save` / `muck_task.update` / `scheduling.solve`（仅 resolve=true 深路径，滑杆快路径不记录）/ `scheduling.reset` / `scheduling.apply`（applied 非空才记录，rejected 存在时 ok=False）/ `scheduling.blastpile`
  - 爆破域 5：`blasting.event.create` / `.update` / `.delete` / `blasting.design.save` / `blasting.result.save`
  - 计算/只读类不审计（compare/kco/jwl/vibration 等）
- `GET /api/audit/logs`（倒序 + 动作/场景过滤 + before_id 分页）、`GET /api/audit/actions`（动作枚举下发）——**只读端点，审计不可外部篡改**

**前端**：
- 第 9 个工具「操作审计」（Clock 图标，索引 8，应力分析与系统工具之间）：`features/operation-audit/` 下的 AuditPanel 时间线——域过滤 chips（现场调度青/爆破模拟橙）+ 动作类型下拉 + 点击展开 detail 键值 + 加载更早记录
- **动作标签真源在后端** AUDIT_ACTIONS，前端不自持映射表 → 新增审计点零前端发布

**契约**（`shared-consistency-baseline.json#auditCmps`）：
- 前端 `auditContract.test.js` 含特色反向断言：**前端源码不得硬编码任何动作 id**
- 后端 `test_audit.py` 含路由源码扫描：**每个动作 id 必须真实植入**对应路由文件（防枚举与实现脱节）

**真机验证**：8 步全 PASS（图标定位/3 条记录倒序/域过滤→空态→恢复/详情展开收起）。

### 贯穿两期的共性交付模式（后续沿用）

1. **数据真源后端持有**：标定值/阈值/站点数据/审计动作枚举全部后端 JSON 或常量表，前端只消费（最多保留明确标注的最小 fallback）→ 数据变更零前端发布
2. **跨端契约锁**：键结构写入 `shared-consistency-baseline.json` 对应 `*Cmps` 段，前端 vitest + 后端 pytest 双端测试锁定
3. **运行时状态不入库**：`config/deployments/*.json`、`config/audit/*.jsonl` 均 gitignore
4. **响应约定**：`{code: 0, data}` / `{code: 1, message}`

---

## 三、后续工作（按优先级）

### 3.1 Solver 抽象（方案已定，**待用户拍板是否实施**）

> 以下四条为已敲定的完整方案，实施时严格照此执行：

1. 求解后端经 `config/scheduling_solver.json` 配置，支持 `backend=nsga3|ml` 与 fallback 链（ML 失败→NSGA-III），`optStats.source` 如实标注降级；**solver 切换零前端发布**
2. 统一输出契约：`{paretoFront, objectiveDefs, optStats(含 source/label), source}`；**所有 solver 只返回设备候选索引，后端用 `evaluate_assignment()` 重算目标值，不信任外部自报**；候选索引越界需校验
3. 实施位置 `app/services/scheduling/solver_registry.py`（Protocol + `solve()`）；Nsga3Solver 包装现有 `solve_pareto` **零行为变化**；MlSolver HTTP 外呼（超时/重试/错误处理）
4. 前端仅改 `optSourceLabel` 读 `optStats.label` + 标题 kicker「NSGA-III · 帕累托前沿优化」动态化；散点/明细表/派单/权重面板等消费 UI **零改动**；契约测试锁定输出一致性；**默认 nsga3 路径行为逐字节不变**

### 3.2 四期：跨终端协同（方案已细化，**待拍板 4 项关键决策后实施**）

**目标**：同一场景下多终端（多浏览器/多操作员）协同——操作实时可见、来源可追溯、并发写有仲裁与提示。
沿用两期共性交付模式：数据真源后端持有、跨端契约锁（`collabCmps`）、运行时状态不入库、`{code:0,data}`/`{code:1,message}` 响应约定。

**子能力 A · 终端/操作员身份（前端生成 → 后端透传 → 审计消费）**
- 前端：`clientId`（`crypto.randomUUID()` 截短 + localStorage 持久化）+ `operator`（可编辑显示名，默认「操作员」）；统一 REST 层注入 `X-Client-Id` / `X-Operator` 头（`schedulingApi.js` / `operation-audit` / `blasting` 写接口共用）
- 后端：新增 `app/services/collab/identity.py` 解析头 → `{clientId, operator}`（长度/字符集校验；缺省 `anonymous`）；**未带头等价旧行为**（向后兼容）
- 审计：`audit_append(actor=...)` 由固定 `"operator"` 改为 `<operator>@<clientId短码>`，记录新增 `clientId` 键；AuditPanel 展示 actor
- 契约：`collabCmps.identityHeaders`

**子能力 B · 操作广播（复用 WS 底座，新增协作通道）**
- 后端：`app/services/collab/broadcaster.py`——异步、按场景分频道、无订阅者即丢弃、失效连接清理（照搬 `BlastConnectionManager.broadcast` 模式）；新增 `/ws/collab?scenario=`（独立连接，不污染快照流节流语义）
- 帧：服务端→客户端 `{type:'collab_event', data:{id,ts,actor,clientId,action,scenario,summary,ok}}` / `{type:'hello', clientId}`；客户端→服务端 `{type:'ping'}`
- 投递：写路由成功 → `audit_append()` 返回记录 → `broadcast_collab(scenario, rec)`；审计跑在 FastAPI threadpool、广播在事件循环 → `asyncio.run_coroutine_threadsafe`（启动时抓主 loop 引用）
- 前端：`useCollab()` + `collabWsConnector` → 顶部协作通知条 + AuditPanel 时间线实时插入；**回声抑制**：`data.clientId === 本机` 不弹提示（仅标「本机」）；按 action 触发面板刷新（`deployment.save`→重拉部署；`scheduling.apply/reset`→刷新；`blasting.*`→刷新事件列表）
- 契约：`collabCmps.wsUrl / frameTypes / eventKeys`

**子能力 C · 并发写仲裁（乐观并发 + revision）**
- 范围：两个命名冲突面——**部署**（`config/deployments/{scenario}.json`）与**派单**（`sim.pending_assignments`）
- 部署真源新增 `rev`（整型，每次保存 +1）：`GET /api/deployment` 回传 rev；`PUT` 可带 `baseRev`——缺省不校验（向后兼容），与当前 rev 不等回 `{code: 2, message:'部署已被其他终端更新', data:{currentRev, current, by}}`（附当前内容供合并/覆盖），命中则落盘并 rev+1，`force=true` 跳过校验
- 派单同理：新增 `sim.assignment_rev`，`POST /api/scheduling/apply_assignment` 带 `baseRev`
- 前端：保存/派单请求带 `baseRev`；收到 `code=2` 弹冲突条「另一终端（`<actor>`）已更新 — [刷新并重试] / [强制覆盖]」
- 契约：`collabCmps.revisionFields` + `conflictCode: 2`

**必须一并修复的既有缺陷（否则多终端不可用）**
- `scheduling_ws.py` 当前**每个连接各起一个 `_tick_broadcast` 推进共享 sim** → N 个终端同时在线时仿真时间被 N 倍加速。跨终端协同须改为**单一推进循环 + 多订阅者广播**：`SchedulingStreamManager` 补 `broadcast()`，仅在有订阅者时推进、节流由服务端统一（该类已预留 `_subs` 池但未使用）

**分期（每期独立可验证、独立提交，沿用四段提交格式）**
1. **3.2.1 身份 + 审计扩展**（✅ 已完成 2026-10-07）：identity 解析 + actor 组装 + 审计 clientId + 前端写接口注入头 + AuditPanel 标「本机」；`test_collab.py` / `collabContract.test.js`
2. **3.2.2 协作广播**（✅ 已完成 2026-10-07）：`collab/broadcaster.py` + `/ws/collab` 通道 + 审计落盘即广播（落盘失败不广播）+ 前端 `collabWsConnector`/`useCollab`（心跳 15s/退避重连/回声抑制/全局 Toast）+ AuditPanel 实时插入与「协作在线」态；`test_collab.py` / `collabContract.test.js`。**面板 opt-in 刷新已接线**：`MultiObjectiveLhdView`（他端 `deployment.save`→重拉部署真源，本机正在保存时跳过）与 `BlastingPanel`（他端 `blasting.event.*`→重拉事件列表）；调度域靠快照 WS 自然同步，无需额外刷新
3. **3.2.3 冲突仲裁**（✅ 已完成 2026-10-07）：部署真源 / 派单队列各带 `rev`（部署落 `rev`+`updatedBy`，派单走 `sim.assignment_rev`）；写请求带 `baseRev`（缺省不校验，向后兼容）→ 陈旧回 `code=2` 附 `currentRev`/`by`/`current`，`force=true` 跳过；前端 `MultiObjectiveLhdView` 冲突条「刷新并重试 / 强制覆盖」；契约 `collabCmps.revision` 锁定
4. **3.2.4 scheduling_ws 单推进多广播修复**（✅ 已完成 2026-10-07）：推进循环按 **(场景,频道)** 全局唯一（`ensure_ticker` 幂等 + 无订阅者 `stop_ticker` 不空转），单次采集快照 → `broadcast` 给全部订阅者；tick 按需重新解析 sim（reset 替换实例后自动跟随）。**顺带修掉原实现 `int(interval) // sim.dt` 得 float → `range()` TypeError，推进循环每帧崩溃**的既有缺陷。用例 `tests/test_scheduling_ws.py`

> **3.2 四期跨终端协同已全面完成**（身份/审计 → 广播 → 冲突仲裁 → WS 修复 → 面板 opt-in 刷新）。遗留：`npm run imports:check` 在 HEAD 即失败（非 3.2.x 引入，已修）；3.2 真机验收已执行并修复缺陷（2026-10-07，提交 `f110e77`）。

**真机验收**：两浏览器窗口同场景 → A 保存部署 → B 实时收协作帧且部署刷新；B 以陈旧 `baseRev` 保存 → 收冲突提示；A/B 操作在审计中 actor 可区分；两终端在线仿真时间不加速（Cesium 场景**禁截图**，用 DOM snapshot/文本断言）

**验收结论（2026-10-07 · 提交 `f110e77`）**
- 协议层（两真实终端直连运行中的后端）：广播帧含 actor/clientId、陈旧 `baseRev` 回 `code=2`（`force=true` 可覆盖）、审计 actor 双端可区分、双终端仿真速率比 **1.004**（修复前应≈2.0）——全部通过。
- 真机浏览器验收暴露并修复两处缺陷：
  1. **协作订阅场景与运行场景不一致**：协作流订阅固定 `ashale`，而调度面板/部署真源运行 `large` → 后端按场景分频道的广播**无人订阅**，跨终端操作不可见；部署面板 opt-in 刷新又被场景守卫（`evt.scenario !== props.scenario`）跳过。修复：新增前端单一真源 `cesium1/src/features/shared/services/activeScenario.js`（`ACTIVE_SCENARIO`），App 启动订阅 / `collabWsConnector` 默认 / `useCollab` 默认 / 调度面板场景统一取之；契约 `collabCmps.activeScenario`。
  2. **无场景事件被广播器丢弃**：爆破域审计 `scenario=None` → `publish` 直接 return → `blasting.*` 跨终端事件永不广播（BlastingPanel 联动刷新失效）。修复：`scenario` 为空的事件广播至**全部**订阅频道；契约 `collabCmps.globalBroadcastScenario=null`。
- 修复后复验（真机 DOM 断言）：他端保存 → 全局 Toast「其他终端 · 巡检终端@patrolTe：保存设备部署：…」+ 部署面板 rev 自动跟随 **6→9**（与后端真源 `rev=9`、`updatedBy=巡检终端@patrolTe` 一致）；陈旧 `baseRev` → `.collab-conflict`「刷新并重试 / 强制覆盖」正常；审计 `.collab-chip`=协作在线、`.tl-actor`=`<操作员>@<8位码>`、本机条目标「本机」（`.is-self`）。
- 回归基线更新为 **vitest 35 文件 / 225 用例、pytest 134 用例**。
- 教训：脚本化协议自测若两端用同一场景，会**掩盖**前端订阅场景错配——协同类特性必须做真机（浏览器）验收。

**已拍板决策（2026-10-06）**
- 通道：新增独立 `/ws/collab`（职责单一，不污染快照流节流/心跳语义）
- 身份粒度：终端 id + **可编辑操作员名**（前端本地填写显示名，无服务端账号校验）
- 冲突策略：**乐观并发 rev + `code=2` 提示**（陈旧写入返回当前内容供合并/覆盖）
- 范围：**纳入** 3.2.4 `scheduling_ws` 多订阅者修复

### 3.3 待清理事项

- ~~工作区 5 个遗留未提交文件~~ ✅ **已处置（2026-10-07）**：核实结论——5 个改动**全是纯格式噪声**（换行/缩进，零语义变化），且与项目 Prettier 规范相悖：`HEAD` 版本 `prettier --check` 全 **clean**、改动后全 **dirty**；又因 `lint-staged` 提交时会 `prettier --write`，它们会被改写回 HEAD（diff 归零）。已 `git restore` 恢复 HEAD，工作区干净、prettier 合规。
  - 涉及：`VibrationFieldPanel.vue` / `fallbackHoleLayout.js` / `LodPanel.vue` / `useLodRenderEnhancement.js` / `StressPanel.vue`
- ~~运行时部署文件被测试写入~~ ✅ **已清理（2026-10-08）**：`config/deployments/{ashale,large}.json`（含 3.2 真机验收残留的 LHD-01→S0 部署与 processOrder）已删除，两场景 `GET /api/deployment` 均回 `rev=0`、空部署；`config/audit/audit-log.jsonl` 按需求保留。二者均 gitignore 不入库。**注意**：运行中的后端仿真器仍在内存里保留验收时应用的部署/工序（删文件只影响重建），如需彻底归零可 `POST /api/scheduling/reset?scenario=<名>`。
- ~~`npm run imports:check` 失败~~ ✅ **已修复（2026-10-07）**：`src/composables/useViewer.js` 越过 shared 入口直连 `@/features/lod-optimization/services/renderEnhancementManager.js` → 改为经 `@/features/shared/index.js` 入口（在该入口增补 `getRenderEnhancementManager` 再导出，沿用既有 lod-optimization 服务出口惯例）。`node scripts/check-import-boundaries.mjs` 现已通过。

---

## 四、开发流程要求（每期必做）

1. **测试先行**：全量 `npx vitest run`（cesium1 下）+ `python -m pytest -q`（backend-py 下）双绿才提交；新功能必须带契约测试
2. **git 提交纪律**：
   - 只 add 本期明确变更文件（逐一列出），**勿用 `git add -A`**
   - 提交前工作区应干净（5 个遗留文件已于 2026-10-07 处置完毕，见 §3.3）
   - 提交信息经 UTF-8 临时文件 + `git commit -F`（PowerShell 无 heredoc 且编码坑多）；风格：`feat:/fix: <期号> <中文标题>——<要点>`，正文分后端/前端/契约三段 + 测试基线
3. **真机验证**：浏览器代理验证 UI（Cesium 大场景**禁止截图**，会超时——用 DOM snapshot/文本断言）；Vue dev 组件内部经 `document.querySelector('.x').__vueParentComponent.setupState` 访问
4. **每期收尾**：更新 project_memory.md（沉淀架构决策）+ 汇报用户 + 询问下一步

## 五、运维与排障备忘

- **后端启动**：`backend-py` 下 `python -m uvicorn main:app --host 0.0.0.0 --port 3003`（后台运行）
- **僵尸端口坑**：uvicorn `--reload`（WatchFiles）父进程死后，multiprocessing 子进程**持有继承的端口句柄**，表现为 netstat 有 LISTEN 但 `Get-Process`/`taskkill` 找不到进程、新进程 bind 报 10048。处理：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name like 'python%'"   # 找 ParentProcessId=<死PID> 的孤儿子进程
  taskkill /PID <孤儿PID> /F
  ```
- **PowerShell**：该版本不支持 `&&`，用 `;` 分隔；vitest 4 无 `basic` reporter，直接 `npx vitest run`
- **Python 3.14 环境警告**：`asyncio.iscoroutinefunction` DeprecationWarning 属第三方库（starlette）噪音，不处理
- **前端工具注册**：新面板需同步改 `toolRegistryMeta.js`（TOOL_REGISTRY_META + resolveToolLoader 两处）+ `RightSidebar.vue` iconMap（Element Plus 图标需 import）
- **多目标视图自适应口径**（2026-10-08 起）：`multiObjectiveLhdView.css` 顶部集中声明——布局断点用**容器查询**（`@container moo`，见 `.moo-lhd { container-type: inline-size }`），不要再用视口 `@media`（同组件会进不同宽度容器）；内容宽度 `--moo-content-max: 1920px` 封顶居中（超宽屏与 1920 表现一致）；字号统一走 `--moo-fs-*` 流体令牌（基准 `--moo-fs-base`），**新增样式不要写死 px 字号**。验证可用 CDP 无头 Chrome 跑 1024/1280/1366/1600/1920/2560/3440 七档视口快照。
