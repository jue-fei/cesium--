# dyna2web 容器转换器 · 使用手册（v8 / schema 2）

> 适用版本：`工作区/dyna2web.py`（2026-10-22，2923+ 行）
> 容器：`webapp/data_v3/`（magic `D2W3` / `D2W3F`，`schema_version=2`）
> 前端：`webapp/index.html` + `ui.css`（容器-only，`V3_MIN_SV=2`）

---

## 1. 快速开始

```powershell
cd 工作区

# 1) 只探测（不写容器）：布局/单位/状态数/分类依据
python dyna2web.py "D:\lsdyna\case1" --key case1 --label 算例1 --stage probe

# 2) 全量转换（核心字段 + 速度；单元级核心场 + 量化存储）
python dyna2web.py "D:\lsdyna\case1" --key case1 --label 算例1 `
  --k "D:\lsdyna\case1\model.k" `
  --stage all --compress zstd --verify `
  --field-location element --extract velocity

# 3) 本地查看
python webapp/start_server.py      # http://localhost:8765/
```

转换产物：

| 文件 | 说明 |
|---|---|
| `webapp/data_v3/{key}.mesh.bin` | 几何/连接表/part/表面/粒子（自描述头 + 块） |
| `webapp/data_v3/{key}.frames.bin` | 逐帧字段（每帧独立 zstd 块 + 帧索引 + `globals_all`） |
| `webapp/data_v3/cases.json` | 算例摘要（标签、帧数、字段、`schema_version`、`requires_frontend`） |
| `reports/{key}.report.json` | 审计报告（布局命中、单位依据、字段表、峰值、`--verify` 结果） |

---

## 2. CLI 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `dirs`（位置参数） | — | 一个或多个含 `d3plot` 的目录 |
| `--key` | 目录名 | 容器键（`data_v3/{key}.*`、前端标签页标识） |
| `--label` | 同 key | 界面显示名 |
| `--k` | 自动找同目录最大 `.k` | 关键字文件（part 名称/材料/起爆点/单位锚点） |
| `--parts` | 无 | 手工覆盖角色，如 `1=structure,2=air` |
| `--units` | 自动判定 | 强制单位制：`g-cm-µs` / `g-mm-ms` / `kg-mm-ms` / `t-mm-s` / `kg-m-s` |
| `--fieldmap` | 内置 | 覆盖字段映射（`config/fieldmaps.json` 结构） |
| `--field-location` | `node` | 核心标量场存储位置：`node`（插值）或 `element`（单元值，推荐，与 LS-PrePost 单元云图一致） |
| `--precision` | `auto` | `auto`=按字段表；`f4`=除掩膜外全 f4（无损）；`u2`=标量/矢量量化，`stress`/`hist`/`pbm_pos` 仍 f4 |
| `--extract` | 空 | 可选层：`stress` / `velocity` / `acceleration` / `sph` / `hist` / `all`（逗号分隔） |
| `--stage` | `probe` | `probe`（只出报告）或 `all`（写容器） |
| `--out` | probe→`reports/`，all→`data_v3/` | 输出目录 |
| `--verify` | 关 | 写完后抽样 4 帧与 d3plot 逐位/容差对比 |
| `--frames-limit` | 全部 | 只写前 N 帧（调试/fixture） |
| `--compress` | `zstd` | `zstd`（需 `zstandard`）或 `none` |
| `--zstd-level` | 9 | zstd 级别 |
| `--json` | 关 | 只输出 JSON 摘要 |

### 字段与精度

| 字段 | 位置 | 精度 | 说明 |
|---|---|---|---|
| `u` | node | u2 | 位移（相对首帧坐标） |
| `damage` / `eps` / `pressure` | `--field-location` 决定 | u2 | 核心标量场；element 时为逐单元值 |
| `vel` | node | u2 | 质点速度（PPV） |
| `acc` | node | u2 | 加速度（需 `--extract acceleration`） |
| `stress` | node | f4 | 六分量，`components=sxx..sxz`（需 `--extract stress`） |
| `hist` | element | f4 | `nv3d` 个 word；w0..w5=应力分量，其余 `history var#N`（需 `--extract hist`） |
| `sph_density` / `sph_damage` | sph | u2 | 粒子槽位不足时跳过（`W010`） |
| `pbm_pos` / `pbm_pressure` | pbm | f4 / u2 | 粒子位置/爆轰压力 |
| `active_mask` / `pbm_active` | element / pbm | u1 | 1 bit/单元（LSB 优先） |

> `u2` 语义：`value = raw*scale + offset`（全帧 min/max 归一化）。
> `--precision f4` 会让容器体积增大 2~3 倍，但可声明“无损”。

---

## 3. 配置文件

| 文件 | 作用 | 缺失时 |
|---|---|---|
| `config/field_spec.json` | 字段注册表（前后端共享；`store` 落盘口径 + `render` 展示口径 + 派生字段） | 后端 `E004`；前端回退内置（`W005`） |
| `config/fieldmaps.json` | 本构 → `nv3d` word 偏移（`stress/damage/eps/pressure`） | 用 `"*"` 兜底规则 |
| `config/layouts.json` | 版本/求解器 → 状态块布局 | 用头部字段生成候选 + 三重校验 |

---

## 4. 容器结构（schema 2）

### 4.1 `mesh.bin`

```
D2W3 | header_len(u32) | header_json | blocks
```

关键 header：

| 键 | 说明 |
|---|---|
| `schema_version` | 2（前端 `V3_MIN_SV=2`，旧容器直接拒绝） |
| `id_base` / `id_source` | 1 基；`k_elem_align` / `contiguous` / `internal` / `fallback` |
| `units` / `units_system` | 换算因子表；判定出的单位制 |
| `parts[]` | `pid/name/mat/sec/roles/elform/elems`（名称来自 `.k *PART`） |
| `surf_groups[]` | `faces i4[quads*4]` / `owner_elem i4[quads]` / `ecent f32[quads*2]` |
| `conn` / `conn_part` | 六面体连接表 `i4[nel,8]` / 每单元 part `i4[nel]` |
| `particles[]` | `kind/n/pos0/ids/nodes`（`nodes` 为未被实体单元引用的节点索引） |
| `counts` | `numnp` / `nel` |
| `markers` / `outline` | 视觉层参数（起爆点样式、描边阈值） |
| `source` | 求解器/版本/d3plot 文件列表/stride/block_plan/layout |

块偏移均**相对块区起点**（`magic+len+header_json`）。

### 4.2 `frames.bin`

```
D2W3F | header_len(u32) | header_json | padding(header_reserve=1 MiB) | frame_blocks | globals_all
```

| 键 | 说明 |
|---|---|
| `frames_base` | `9 + header_reserve`；帧块区起点（绝对字节） |
| `frames[i]` | `{offset(绝对字节), len(压缩后), usize(解压后=frame_bytes)}` |
| `codec` / `frame_bytes` | `zstd`/`none`；单帧解压后字节数 |
| `fields[]` | `id/dtype/location/count/scale/offset/comps/components/role` |
| `precision` / `precision_mode` | 字段 dtype 表 / `auto|f4|u2` |
| `times[]` | 原始单位（显示时 × `mesh.units.time`） |
| `energy` | `ke/ie/te`（`globals[0..2]`） |
| `damage_frac[]` | 岩石单元 `D>0.5` 占比（%） |
| `globals_all` | `{offset(相对 frames_base), len, dtype:'f8', shape:[nfr, nglbv]}` |

> 注意两个 offset 口径不同：`frames[].offset` 是**绝对**，`globals_all.offset` 是**相对 frames_base**。
> 前端版本闸：`schema_version` 读容器头；`cases.json` 的字段只供列表页/运维核对。

---

## 5. 错误码 / 告警

| 码 | 级别 | 含义 | 处理 |
|---|---|---|---|
| `E001` | error | 单元族布局未知（含 te4/tshell 但无样本） | 中止 + 明确报错 |
| `E002` | error | 检测到 MPP 结果（`d3plot.01/.02`） | 中止，建议先用 LS-PrePost 合并 |
| `E003` | error | 容器写盘失败 / 空间不足 | 中止 + 清理残留 |
| `E004` | error | `field_spec.json` 缺失/解析失败 | 后端中止；前端回退内置 |
| `E005` | error | `stride` 候选全失败 | 中止 + 附候选残差 |
| `E006` | error | 字段块长度与期望不符 | 中止 + 声明实际/期望 |
| `E007` | error | frames 头超 `header_reserve` | 调大 `FRAMES_HDR_RESERVE` |
| `E008` | error | 单元族区间契约违反 | 中止 + 附 ranges |
| `E009` | error | `formula` 编译失败（前端） | 该字段不渲染 |
| `E010` | error | 字段注册表与容器产出不一致 | CI 阻断（字段对齐测试） |
| `E011` | error | 容器不可读/截断（含 Range 未启用） | 前端告警 toast + 保留上一帧/回退算例 |
| `E012` | error | zstd 解压失败 / fzstd 缺失 | 跳过该帧 + 提示 |
| `W001` | warning | 编号多候选无法区分 | 报告 |
| `W005` | warning | 前端 `field_spec` 加载失败 | 回退内置 |
| `W007` | warning | 单位制置信度低 | 报告 + 副标题 `unit?` |
| `W009` | warning | 首帧失败 → 降级白模 | 场景不销毁 |
| `W010` | warning | SPH/PBM 槽位不足 → 跳过字段 | 不写零值假数据 |
| `W011` | warning | SPH 节点集判定回退（尾段） | 报告 `node_source` |
| `I001`~`I003` | info | include 树 / 单位依据 / 编号候选 | 仅报告 |

完整列表见 `reports/{key}.report.json#diagnostics`；容器头只留前 20 条。

---

## 6. 导入 API（本地服务器）

`webapp/start_server.py`（开发/演示用，非生产）：

| 接口 | 说明 |
|---|---|
| `POST /api/convert` | `{path, key?, label?, k?, layers?[]}` → `{job, key}`；后台跑 `dyna2web.py --field-location element` |
| `POST /api/cancel` | `{job}` → 终止转换子进程，任务状态 `cancelled` |
| `GET /api/job?id=` | 任务状态与日志 |
| `GET /api/report?key=` | 返回 `reports/{key}.report.json`（key 仅 `[A-Za-z0-9_-]`，防路径穿越） |
| `GET /api/field_spec` | 字段注册表 |
| `GET /api/incoming` | `webapp/incoming/` 下的快捷目录 |

`layers` 支持集 = `stress / velocity / acceleration / sph`；`velocity` 默认补上，未知层写入任务日志（不再静默丢弃）。

---

## 7. 校验与 CI

```powershell
cd 工作区

# 一键全跑（容器 + 数据层 + 粒子 + 前端符号/控件）
node tests/run_all.js

# 单独
node tests/validate_container.js                 # 7 例容器头/块/帧索引/抽样解码
node tests/validate_container.js data_v3 --key smooth --frames 0,50,101
node validate_datalayer.js                       # smooth/presplit 统计
node validate_sph.js                             # sph1/sph2 粒子链路
node smoke_test.js                               # 前端关键符号/控件

# fixture（3.46 MB，2 帧）
python tests/gen_fixtures.py                     # 首次生成（--force 重建）
node tests/validate_container.js tests/fixtures/container_v2
```

建议 CI 顺序：`gen_fixtures --check`（可选）→ `validate_container` → `validate_datalayer` → `validate_sph` → `smoke_test`；任一非 0 即失败。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `E002 检测到 MPP` | `d3plot.01/.02` 形式；先用 LS-PrePost 合并为 SMP 结果 |
| 前端提示“容器过旧” | `schema_version<2`；重新转换（不提供 v1 兼容分支） |
| 容器体积过大 | 默认含 `stress`（f4×6）与可能 `hist`；改按需 `--extract`，或 `--precision u2` |
| 损伤云图“太平滑” | 核心场按 `node` 插值；重转加 `--field-location element` |
| `--extract hist` 后字段很多 | 前端把 `hist` 展开为 `hist_w0..w(nv3d-1)`；w6+ 多为 `unknown`，按需查看 |
| `zstd` 不可用 | `pip install zstandard`；或 `--compress none`（体积大） |
| 前端取帧报 Range 错误 | 用新版 `start_server.py`（需 206）；生产建议 nginx/caddy |
| 4 字节字 d3plot | 有分支但无样本，未验证；建议先用 8 字节字版本 |
| `.k` 含中文标题乱码 | 已按 `utf-8-sig→utf-8→gbk→latin-1` 自适应；报告 `deck.encoding` 可核对 |

---

## 9. 已知限制

- 仅六面体实体（`nel8`）；四面体/壳场值/梁/2D/厚壳未实现（壳为静态几何、未验证）。
- 不支持 MPP rank 合并。
- 仅小端；大端 d3plot 未探测。
- `*INCLUDE` 支持递归与循环检测，但 `*PARAMETER` 未展开。
- `--verify` 抽 4 帧，非全帧。
- 前端首帧/切帧性能尚未实测（无预算基线）。
