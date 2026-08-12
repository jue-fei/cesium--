# 爆破板块优化方案（基于代码审查）

> 审查日期：2026-08-11
> 审查范围：`src/features/blasting-simulation/` 全模块 + `backend-py/app/services/blasting/`
> 基线：当前主干代码（含 2026-08-11 修复的 `LUT_MAX_CMPS` 重复声明）
> 定位：本文档为后续实时优化的依据，每条问题附代码证据（文件:行号）与可执行方案。

---

## 一、问题清单与解决方案

### 问题 1：速度模型默认用错的（总药量 Q 而非比装药 q）

**证据**
- [fragmentSpecGenerator.js:156-185](services/core/rendering/fragmentSpecGenerator.js#L156-L185)
- 默认走经验拟合 `vBase = 6 + √Q×0.3`，作者自承认"加性常数 6 和系数 0.3 无物理依据"，且 `Q` 应为比装药 `q=Q/V`
- Persson(1997) 物理模型 `vBase = √(2·η·q·E_g/ρ_rock)` 已实现但默认不开（`usePerssonVelocity === true` 才启用）

**方案**
1. 将 Persson 模型设为默认路径，经验公式仅作 `volumeRoundM3 ≤ 0` 时的 fallback
2. `η=0.15` 能量耦合系数改为可配置参数（配合问题 10 的 UI 输入）
3. fallback 路径在 UI 标注"非物理近似"

**优先级**：高（物理正确性根基）
**成本**：低（代码已写好，仅改默认分支）

---

### 问题 2：抛掷距离校准"凑结果"（√(target/actual) 反推缩放速度）

**证据**
- [fragmentSpecGenerator.js:695-752](services/core/rendering/fragmentSpecGenerator.js#L695-L752) `_calibrateVelocitiesToThrowTargets`
- [fragmentSpecGenerator.js:378](services/core/rendering/fragmentSpecGenerator.js#L378) 作者自承认"校准后速度场失去原始物理含义，属'凑结果'非物理推导"
- [fragmentSpecGenerator.js:721](services/core/rendering/fragmentSpecGenerator.js#L721) `scale = Math.max(0.55, Math.min(1.1, scale))` 人为裁剪物理结果

**方案**
1. **短期**：加 `enableCalibration` 开关，默认 false；删除 `clamp(0.55, 1.1)` 裁剪
2. **中期**：用实测数据样本（装药参数 → 实测平均抛距）最小二乘反演 Persson 模型的 `η`，让物理模型本身产出合理抛距
3. **长期**：`targetAvg/targetMax` 从物理管线剥离，仅作 UI 参考线叠加显示，不参与速度计算

**优先级**：高
**成本**：中（短期低，长期需实测数据）

---

### 问题 3：sizeFactor 无限加速，靠 clamp(5,14) 兜底

**证据**
- [fragmentSpecGenerator.js:677-679](services/core/rendering/fragmentSpecGenerator.js#L677-L679)
  ```js
  const sizeFactor = Math.pow(x50 / Math.max(0.1, physSize), 1.0)
  const speed = Math.max(5, Math.min(14, vBase * sizeFactor * vVariation))
  ```
- `physSize→0` 时 `sizeFactor` 发散，靠硬编码 `[5,14]` 裁剪

**方案**
1. 换用有界模型：`v(physSize) = vBase * (m_mean/m)^{1/3}`，其中 `m ∝ physSize³`
2. 上界与 `vBase` 挂钩（如 `vBase * 2`）而非硬编码 14
3. 删除 `Math.max(5, ...)` 下界——小碎片该慢就慢

**优先级**：中
**成本**：低

---

### 问题 4：发射方向满地魔法数字

**证据**
- [fragmentSpecGenerator.js:670-686](services/core/rendering/fragmentSpecGenerator.js#L670-L686)
- 裸数字：`0.25`（基准角）、`0.12`（扰动）、`0.67`（方位扩散）、`0.85`/`0.7`/`1.0`（三向权重）、`[5,14]`（速度区间）
- 轴向/横向/竖向权重不满足单位向量条件，物理意义不明

**方案**
1. 提取为 `LAUNCH_CONFIG` 常量对象，每个数字必须附三种来源之一：(a) 文献、(b) 实测标定、(c) 显式标注"工程经验值，未标定"
2. 三向权重改为基于掌子面法向与隧道轴向的几何投影，而非三个独立权重

**优先级**：低（影响可维护性）
**成本**：低

---

### 问题 5：手写球体物理引擎，堆积形态失真 ★重点★ ✅ 已完成（commit 8aaa286）

**实现说明**：实际文件名为 `rapierPhysicsEngine.js`（非计划中的 `blastPhysicsEngineRapier.js`）。Worker 不可用时降级为手写引擎（保留 `BlastPhysicsEngine` 作为同步 fallback），而非仅 WebAssembly 不可用时降级。隧道壁用 cuboid 近似（未用 trimesh），足以约束碎片。未实现 `InteractionGroups` 分组（rapier 默认 BVH 已足够）。验证：vite build 通过，vitest 47 项测试全部通过。

**证据**
- [blastPhysicsEngine.js:14-41](services/core/computation/blastPhysicsEngine.js#L14-L41) "模型保真度声明"自承认未用 cannon-es/rapier
- [blastPhysicsEngine.js:20-24](services/core/computation/blastPhysicsEngine.js#L20-L24) 球体碰撞近似，块状碎片在斜面过度滚动
- 项目记忆记载 cannon-es 曾踩三坑：`angularDamping>1` NaN、SAPBroadphase 不兼容 Plane、球体角速度弹飞

**调研结论**：矿业专用免费 web 物理引擎不存在（JKSimBlast 等均商业闭源）。通用引擎候选评估：

| 候选 | 凸包 | 3000 碎片性能 | 许可证 | 适配度 |
|------|------|--------------|--------|--------|
| **rapier3d-compat** | 原生支持 | 4× ammo，SIMD | MIT/Apache-2.0 | ✅ 最优 |
| ammo.js | 支持 | 内存 >10MB | zlib | ❌ 太重 |
| cannon-es | 弱（已踩坑） | 200 body 上限 | MIT | ❌ 不适合 |
| box3d-wasm | 支持 | 不支持 thin-instance | MIT | ❌ InstancedMesh 灾难 |

**方案（确定采用 rapier3d-compat）**
1. 新建 `services/core/computation/blastPhysicsEngineRapier.js`，实现与 `BlastPhysicsEngine` 相同 API（`init/step/setTunnelBounds/getBodyStates/activateAll`）
2. 碎片凸包：从 `rockGeometryFactory.js` 的 5 种几何体提取顶点，喂给 `RAPIER.ColliderDesc.convexHull(points)`
3. 隧道壁：用 `RAPIER.ColliderDesc.trimesh(vertices, indices)` 构造马蹄形断面 80m 内壁（静态碰撞体）
4. 通过现有 `blastPhysicsEngineWorker.js` 的 Worker 包装层切换底层引擎，主线程 API 不变
5. 手写引擎保留为 `legacy` 分支，仅当 `typeof WebAssembly === 'undefined'` 时降级，UI 标注"低精度模式"
6. 用 `InteractionGroups` 分组（掏槽/辅助/周边孔碎片），减少碰撞对数

**附带免费解决**：问题 6（安息角单点支撑）、问题 7（悬空补丁）一并消除

**优先级**：高（"像不像"的核心）
**成本**：中高（需学 rapier API + 凸包生成，但比手写 GJK/EPA 划算）

---

### 问题 6：安息角单点支撑判定，堆积偏松散

**证据**
- [blastPhysicsEngine.js:536-594](services/core/computation/blastPhysicsEngine.js#L536-L594) `_applyReposeSettling`
- [blastPhysicsEngine.js:544-552](services/core/computation/blastPhysicsEngine.js#L544-L552) 只取 `minHoriz` 最小的单个支撑
- 作者自承认"堆积形态偏松散"

**方案**
- 若落地问题 5 的 rapier 路线 → **此项自动解决**（rapier 原生多接触点求解）
- 若暂不换引擎 → 收集所有下方支撑点，计算支撑凸包，判断重心是否落在凸包水平投影内

**优先级**：中（做问题 5 则免费解决）
**成本**：中（手写版）/ 零（rapier 版）

---

### 问题 7：悬空碎片事后打补丁

**证据**
- [blastPhysicsEngine.js:567-578](services/core/computation/blastPhysicsEngine.js#L567-L578) 悬空修正说明 LANDED 标记过激进
- 根因：`SETTLE_FRAMES=3`（[L52](services/core/computation/blastPhysicsEngine.js#L52)）太短，低速 3 帧就冻结

**方案**
1. 冻结前强制做一次支撑检查，无支撑则不冻结（事前门禁替代事后补丁）
2. 或把 LANDED 改为软标记：低速碎片先进入 `RESTING`，连续 N 帧有支撑才升为 `LANDED`
3. 做问题 5 后此项消失

**优先级**：低
**成本**：低

---

### 问题 8：前后端割裂，前端不调后端 JWL 精确计算

**证据**
- [blast_physics.py:1-11](../../../../backend-py/app/services/blasting/blast_physics.py#L1-L11) 后端有 JWL 状态方程、波动方程求解
- [blast_physics.py:45-46](../../../../backend-py/app/services/blasting/blast_physics.py#L45-L46) 前端用的是萨道夫斯基 `K=200, α=1.5` 硬编码
- [blast_physics.py:52-83](../../../../backend-py/app/services/blasting/blast_physics.py#L52-L83) JWL 精确计算结果前端完全没用
- [blast_physics.py:88-95](../../../../backend-py/app/services/blasting/blast_physics.py#L88-L95) 作者自承认修正了历史版本三个物理错误（双重衰减、P/S 波混淆、包络硬编码）

**方案**
1. 后端 `_stream_loop` 把 JWL 计算的爆源压力时程作为初始条件喂给波动方程，替换萨道夫斯基峰值
2. 前端 `blastVibrationFieldRenderer` 直接渲染后端推送的场数据，不再前端自算萨道夫斯基
3. 萨道夫斯基降级为"后端不可用时的离线 fallback"，UI 明确标注"近似模式"
4. `K`/`α` 改为按场地标定可配置

**优先级**：中
**成本**：中高

---

### 问题 9：KCO 默认参数硬编码"公路隧道中硬岩典型值"

**证据**
- [kcoModelCore.js:32-49](services/core/computation/kcoModelCore.js#L32-L49) `DEFAULT_KCO_PARAMS`
- `Q=320`、`B=1.5`、`RMD=20/RDI=15/HF=25` 等全为硬编码典型值

**方案**
1. 拆分为"必填参数 + 场地预设"：
   ```js
   const SITE_PRESETS = {
     'highway-tunnel-hard': { RMD:20, RDI:15, HF:25, ... },
     'subway-tunnel-soft':  { RMD:12, RDI:10, HF:15, ... },
     'mine-drift-hard':     { RMD:25, RDI:18, HF:28, ... },
   }
   ```
2. 必填参数（Q/B/S/d/chargeKg）不给默认值，缺失时报错而非静默用 320kg
3. 配合问题 10 的 UI 改造，让用户选预设或手填

**优先级**：中
**成本**：低

---

### 问题 10：UI 只能选历史事件回放，无参数编辑

**证据**
- [BlastingPanel.vue:20-46](components/BlastingPanel.vue#L20-L46) 只有数据库事件下拉框
- [BlastDesign.vue](components/BlastDesign.vue) 全程 `{{ }}` 只读展示，无 input
- [VisualOptions.vue](components/VisualOptions.vue) 只有图层开关与模式切换

**方案**
1. 新增 `BlastDesignEditor.vue`：
   - 岩石参数：RMD/RDI/HF 三滑块（带预设下拉）
   - 装药参数：炸药类型下拉（ANFO/乳化/dynamite）、单孔药量、孔径、抵抗线、孔间距
   - 断面参数：宽度、直墙高、拱半径
   - 高级：钻孔偏差 W_abs、能量耦合 η
2. 编辑后调后端 KCO 计算接口，返回 x50/xmax/n/b 驱动碎片生成
3. 用 Pydantic 校验（后端已有约定），前端用同 schema 生成校验规则
4. 保留"历史回放"为只读模式，新增"设计模式"为可编辑模式

**优先级**：高（从"动画玩具"变"工程工具"的关键）
**成本**：中高

---

### 问题 11：炮孔布局回退硬编码模板

**证据**
- [sceneBuilder.js:547](services/core/rendering/sceneBuilder.js#L547) 无数据库数据时回退
- [sceneBuilder.js:625](services/core/rendering/sceneBuilder.js#L625) 硬编码"菱形掏槽 + 辅助 + 周边"

**方案**
1. 改为根据断面尺寸 + 抵抗线 + 孔间距**程序化生成**：
   - 掏槽形式可选：菱形掏槽 / 螺旋掏槽 / 楔形掏槽
   - 辅助孔圈数 = `ceil((min(W,H) - 掏槽区) / S)`
   - 周边孔间距 = `0.8 × S`（光面爆破经验）
2. 生成结果写入与数据库相同的 schema，下游无感知

**优先级**：中
**成本**：中

---

### 问题 12：重复声明进运行时，缺类型检查/构建

**证据**
- 2026-08-11 修复的 `LUT_MAX_CMPS` 重复声明（[blastVibrationFieldRenderer.js:45](services/core/rendering/blastVibrationFieldRenderer.js#L45) import + 原 L54 local const）
- 此类错误跑一次构建即可发现，却进运行时

**方案**
1. **加 ESLint `no-redeclare` 规则**（零配置），import 与 const 重名直接报错
2. **CI 跑 `npm run build`**（vite build 会做模块解析，重复导出失败）
3. **可选 TS**：把 `blastPhysicsEngine.js` / `fragmentSpecGenerator.js` / `kcoFormulas.js` 三个核心文件改 `.ts`（已有 JSDoc typedef，迁移成本低）
4. 不建议一次性全量 TS 迁移，先覆盖核心计算模块

**优先级**：高（防回归）
**成本**：低（ESLint+CI）/ 中（TS）

---

### 问题 13：测试避重就轻，关键函数无覆盖

**证据**
- [blastPhysicsEngine.test.js](services/core/computation/__tests__/blastPhysicsEngine.test.js) 测了简单情形
- `_calibrateVelocitiesToThrowTargets`（最有问题）无测试
- KCO 测试只验数值精度，不验输入边界（Q≤0、B<0、x50>xmax、d=0）

**方案**
1. 补 `_calibrateVelocitiesToThrowTargets` 测试：scale clamp 边界、target=0、velocity 全零、单碎片
2. 补 KCO 输入边界测试：非法参数应返回 NaN 或抛错，不静默产出垃圾
3. 加能量守恒回归测试：无阻力 + restitution=1 + friction=0 下总动能守恒（允许 1% 误差），量化显式 Euler 是否泄漏
4. 加 property-based test（fast-check）：随机合法参数，断言 `swebrecCdf` 单调递增、值域 [0,1]、`swebrecInverse ∘ swebrecCdf = identity`

**优先级**：中
**成本**：中

---

### 问题 14：项目记忆曾有虚假声明

**证据**
- 项目记忆自述："2026-07-16 审查发现 8+ 条 Hard Constraints 与代码矛盾（cannon-es/Persson/33ms/AB循环移除等均为虚假声明），已重写为真实状态"

**方案**
1. 加 CI 脚本：扫描 `project_memory.md` 的 `evidence: 文件:行号` 标注，用 Grep 验证对应位置确实包含声明内容，evidence 失效则 CI 失败
2. 或轻量方案：约定每条 Hard Constraint 必须带 `evidence:`，PR 审查时人工抽查 3 条
3. 禁止在记忆里写"已实现 X"而不附 evidence

**优先级**：低
**成本**：低

---

## 二、优先级路线图

| 阶段 | 任务 | 预期收益 |
|------|------|----------|
| 立即 | 问题 12（ESLint + build CI） | 防止低级错误进运行时 |
| 短期 | 问题 1（Persson 默认）+ 问题 2（拿掉 clamp 裁剪）+ 问题 13（补测试） | 物理可信度从"假"变"有争议" |
| 中期 | 问题 5（rapier-wasm）+ 问题 10（参数编辑 UI） | 从"动画玩具"变"工程工具" |
| 长期 | 问题 8（前后端打通 JWL）+ 问题 11（参数化布孔） | 从"工程工具"变"可信辅助决策" |

---

## 三、问题 5（物理引擎）选型决策记录

### 决策：采用 rapier3d-compat

**决策日期**：2026-08-11

**候选与淘汰理由**：
- **rapier3d-compat** ✅：Rust→WASM，MIT/Apache-2.0，凸包原生支持，4× ammo 性能，活跃维护（v0.28.0, 2025-08），WASM 适配现有 Worker 架构
- **ammo.js** ❌：Bullet WASM 封装，工业级精度但内存 >10MB、启动慢 800-1200ms，3000 碎片规模吃力
- **cannon-es** ❌：纯 JS 轻量，但 200 body 上限，项目历史已踩三坑
- **box3d-wasm** ❌：2026 年新出，不支持 thin-instance batching，与 InstancedMesh 渲染不兼容
- **矿业专用** ❌：JKSimBlast/Datamine 等均商业闭源，web 端无免费矿业物理引擎

**适配本项目的关键点**：
1. `Collider.convexHull(points)` 直接用 `rockGeometryFactory.js` 的 5 种碎片顶点，解决球体近似
2. `Collider.trimesh` 构造马蹄形隧道壁，解决 axis-aligned 碰撞体穿墙问题
3. `InteractionGroups` 分组（掏槽/辅助/周边），减少碰撞对数
4. WASM + 现有 Worker 包装层，主线程 API 零改动
5. Rust 数值内核规避 cannon-es 的 JS 浮点坑（NaN、精度丢失）

**需接受的代价**：
- 包体积 ~1.5-2MB（gzip），对工程平台可接受
- API 学习曲线（声明式 vs 命令式）
- 异步初始化 `await RAPIER()`（现有 Worker 链路天然兼容）

**附带解决**：问题 6（安息角）、问题 7（悬空补丁）

---

## 四、验收标准

每项优化落地后需满足：
1. 物理类改动：能量守恒回归测试通过（无阻力弹性系统总动能误差 < 1%）
2. 渲染类改动：60fps 不掉帧（3000 碎片规模，中端 GPU）
3. UI 类改动：Pydantic 校验边界用例全覆盖
4. 工程类改动：ESLint + build CI 全绿
5. 所有改动：附 evidence（文件:行号）更新到项目记忆
