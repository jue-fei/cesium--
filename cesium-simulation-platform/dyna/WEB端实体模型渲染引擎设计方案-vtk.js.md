# WEB 端「实体模型」渲染引擎设计方案（vtk.js 路线）

> 目标：替换现有 three.js 表面壳渲染管线，实现可在浏览器离线单页中渲染的**真实体**模型
> 针对痛点：① 只有外壳、内部空心 ② 剖切慢 / 拼接不严 ③ 云图块状、光照不真实
> 结论先行：**换库不解决问题，换数据形态才解决问题。**

---

## 0. 一句话结论

vtk.js 只识别 `vtkPolyData`（几何面）与 `vtkImageData`（体数据）两种数据，**不支持 LS-DYNA 的六面体非结构网格**。
因此"从 three.js 换成 vtk.js"本身不会带来任何改善——把现有四边形壳喂给 vtk.js，出来的还是壳。

真正的解法是新增一条 **「离线重采样 → 体数据（vtkImageData）→ GPU 体绘制」** 的管线，
让 vtk.js 去渲染它最擅长的内容，并复用 vtk.js 成熟的**真几何剖切（自带封盖）、平滑着色、等值面、工程标尺**能力。

---

## 1. 三个痛点的根因（定位到现有代码）

| 痛点 | 根因 | 现有实现位置 |
|---|---|---|
| ① 只有外壳、内部空心 | Python 只提取「共享面计数=1」的外表面，再对顶部切一刀补封盖；渲染对象是一层壳，内部无体积与场值 | `extract_web_data.py` 的 `extract_exterior()`；数据端 NQ=216,211 个四边形 |
| ② 剖切慢 / 拼接不严 | 用 JS 自研 CSG 布尔切片（80ms 防抖），布尔运算在浮点边界天然产生缝隙与空壳 | `index.html` 的 `cutGeometryCSG()`（借鉴 `cesium1/sectionCutter.js`） |
| ③ 云图块状、光照不真实 | 每个四边形独占 4 个顶点（顶点不共享）+ 每顶点写常数场值 + 面法线 → 无法平滑插值、无法 Gouraud 着色；自定义 ShaderMaterial 无真实光照模型 | `buildFemPart()`：`computeVertexNormals()` + 逐 quad 写 `aField` |

> 关键事实：顶点不共享 → `computeVertexNormals()` 得到的是**面法线**，所以表面永远"棱角分明"；场值按四边形写入 → 等值线永远"块状"。

---

## 2. 能力核查（决定方案走向的事实）

| 需要的能力 | vtk.js 是否支持 | 可用模块 |
|---|---|---|
| 渲染**非结构网格**（六面体单元） | ❌ **不支持**，且官方明确无短期计划 | —（须离线重采样） |
| **体绘制** `vtkImageData`（GPU 光线投射） | ✅ 支持，含线性插值、颜色/透明度传递函数、与不透明表面混合 | `Rendering/Profiles/Volume`、`vtkVolumeMapper`、`vtkVolume` |
| **真几何剖切 + 自动封盖**（水密） | ✅ `vtkClipClosedSurface` 对**闭合**表面做裁剪并生成封闭切面 | `Filters/General/ClipClosedSurface` |
| 体数据剖切 / 裁剪 | ✅ | `Imaging/Core/ImageCropFilter`、`Filters/Core/Cutter` |
| **合并重复顶点**（消除缝隙根因） | ✅ v35+ 新增 | `Filters/Core/CleanPolyData` |
| 平滑点法线 / Gouraud 着色 | ✅ | `Filters/Core/PolyDataNormals` |
| 等值面 / 等值线 | ✅ | `Imaging/Core/ImageMarchingCubes`、`Filters/General/ContourLoopExtraction` |
| 色标 / 工程图例 | ✅ | `vtkColorTransferFunction`、`vtkPiecewiseFunction`、`vtkScalarBarActor` |
| 数据集读取（含二进制分块） | ✅ | `IO/Core/HttpDataSetReader`（index.json + 二进制） |
| 相机交互 | ✅ 可自定义按键映射 | `Interaction/Style/*`、`vtkInteractorStyleTrackballCamera` |
| WebGPU 后端 | ⚠️ 实验性，尚不成熟 | 保持 WebGL2 后端 |

> ⚠️ 备选：若必须**保留真非结构网格**在前端，则要改用 **VTK.wasm**（Kitware 的 WebAssembly 版 VTK，原生支持 `vtkUnstructuredGrid` 与全套过滤器）。
> 代价：WASM 体积数十 MB、需 Emscripten 构建/官方包，与现有「纯离线单页、零外部依赖」目标冲突。**本方案不采用，仅作为保真度兜底预案。**

---

## 3. 总体架构（三层）

```
┌───────────────────────── ① 离线预处理层（Python，沿用现有管线）─────────────────────────┐
│  d3plot 指纹定位解析（现有能力，不改）                                                    │
│      ├─ 新增 exporter A：闭合外表面 vtkPolyData（共享顶点 + 逐点场值）                    │
│      └─ 新增 exporter B：均匀体数据 vtkImageData（六面体→体素重采样 + 平滑）              │
│  统一编排入口：auto_convert.py（保证「导入 d3plot 即出结果、无需改代码」）                 │
└───────────────────────────────────┬─────────────────────────────────────────────────────┘
                                    │  vtk.js 原生数据集格式（index.json + *.bin）
┌───────────────────────────────────▼──── ② vtk.js 运行时层 ───────────────────────────────┐
│  DataSource 层：vtkHttpDataSetReader / 手搓 vtkPolyData、vtkImageData                    │
│  Pipeline 层：CleanPolyData → PolyDataNormals → Mapper/Actor（表面模式）                  │
│               ImageCropFilter → VolumeMapper → Volume（实体模式）                          │
│               ClipClosedSurface → Mapper/Actor（剖面模式，水密切面）                        │
│               ImageMarchingCubes → 等值面                                                │
│  交互层：自定义 InteractorStyle（左键平移 / 中键旋转 / 滚轮缩放）                          │
│  渲染层：vtkGenericRenderWindow（WebGL2）+ vtkScalarBarActor                             │
└───────────────────────────────────┬─────────────────────────────────────────────────────┘
                                    │  事件桥接（帧/场/剖切状态）
┌───────────────────────────────────▼──── ③ UI 桥接层（复用现有 dashboard DOM）────────────┐
│  时间轴 / 图例 / 取点曲线 / 起爆时序 / energy 曲线 / 算例切换 —— 全部保留，仅替换 3D 视口   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

设计原则不变：**重活仍在 Python 一次性完成**，浏览器只做"上传 + 着色 + 交互"。

---

## 4. 数据层改造

### 4.1 产物 A —— 闭合外表面 `vtkPolyData`（用于"表面云图 / 剖面"）

相对于现状的三个关键改动：

1. **不再在 Python 端预剖切**。现状是"提取外表面 → 切掉顶面 → 补封盖"，这直接破坏了闭合性。改为**导出完整闭合外表面**，剖切交给运行时的 `vtkClipClosedSurface`。
   → 这一步同时解决痛点②的"缝隙"：`vtkClipClosedSurface` 对闭合体做解析裁剪并**自动生成平齐的封盖**，切面与侧面共享边界，天然无缝。
2. **顶点共享**。按节点去重建 `Points` + `Polys`，而不是每四边形复制 4 个顶点。
   → 配合运行时 `vtkCleanPolyData` 合并重合点 + `vtkPolyDataNormals` 计算**点法线**，表面即获得连续平滑法线与 Gouraud 着色，解决痛点③的"块状/无光照"。
3. **逐点场值**。由现有的"单元值→节点平均→回插"平滑（当前已有 2 轮拉普拉斯）直接产出 **pointData** 标量数组，一帧一数组。
   → 等值线自然连续，不再块状。

### 4.2 产物 B —— 均匀体数据 `vtkImageData`（用于"实体模型"，解决痛点①）

在 Python 端把六面体单元**重采样到均匀三维网格**：

- 对每个体素中心做**点在六面体内的定位**（可用单元包围盒分桶加速），取该单元的场值 → 得到逐体素的场分布；
- 采用与现状一致的量化（损伤 `D/255`、塑性应变线性、压力/超压 `asinh`、密度 `log`）保持跨 6 个量级的对比度；
- 对损伤/应变/VM 做 2 轮拉普拉斯平滑（压力/密度保持锐利波阵面，与现有策略一致）；
- 输出：`u8` 标量体 + `origin/spacing/extent` + 各场 `[min,max]` 元数据。

运行时 `vtkVolumeMapper` 用**线性插值**采样 3D 纹理 → 跨单元连续，波形平滑；内部任意位置都可见 → **真正的实体**。

### 4.3 体素分辨率预算（必须显式约束，否则内存爆炸）

体数据内存 = `Nx·Ny·Nz × 1 字节/场/帧`。必须按"体素预算"自动定分辨率：

| 预算档 | 单场单帧 | 12 帧单场 | 适用 |
|---|---|---|---|
| 4M 体素（≈160³） | 4 MB | 48 MB | 推荐默认，配合惰性加载 |
| 8M 体素（≈200³） | 8 MB | 96 MB | 高精度，仅当前算例常驻 |
| 16M 体素（≈250³） | 16 MB | 192 MB | 逼近 3D 纹理上限，需分块 |

> **与硬约束的冲突提示**：项目约定"动画帧必须与 d3plot 状态 1:1，不得抽帧"。体数据若要覆盖全部 102/87 状态，按 4M 体素 × 102 帧 = 408 MB/场，浏览器不可接受。
> 建议：**全状态按低分辨率生成（≈96³，1 MB/帧）保证 1:1 可播放；关键帧按高分辨率生成供"实体高保真"查看**。此取舍需你确认，见 §9 待确认项。

### 4.4 与现有元数据的对接

`cases.json` 已有 `scales`（如 `p_absmax`、`vm_max`、`eps_max`、`v_absmax`…）与 `fields` 描述，可直接映射为 vtk.js 的传递函数量程：

```
ctf.setMappingRange(min, max)        // 来自 scales.*
pwf.addPoint(value, opacity)         // 岩石高不透明、空气/空洞近透明
mapper.setScalarRange(min, max)
```

现有「必需内容默认提取 + 可选参数勾选」的分层提取契约保持不变，体数据/表面数据按同一分层规则决定是否生成。

---

## 5. 渲染层设计（三种视图模式）

### 模式 A：实体（体绘制）—— 主打"真实体"

```
vtkHttpDataSetReader（或直接构造 vtkImageData）
  → vtkVolumeMapper（blendMode=COMPOSITE，sampleDistance≈0.5 体素）
      + vtkColorTransferFunction（turbo 7 段 / 蓝-红发散 5 段，替代现有 GLSL 手写色图）
      + vtkPiecewiseFunction（岩石不透明、空气/开挖空洞透明）
  → vtkVolume
  → renderer.addVolume()
```
- 内部任意位置可见，**无空心**；
- 剖切 = 调整采样区间 / `vtkImageCropFilter`，**瞬时完成，无 CSG**；
- 自动增益可控（对比现有 `autoGain`）。

### 模式 B：表面云图（几何）—— 替代现有四边形壳

```
Python 导出的闭合 vtkPolyData
  → vtkCleanPolyData（合并重合点）
  → vtkPolyDataNormals（computePointNormals=true，不撕裂）
  → vtkMapper（scalarVisibility=true + vtkLookupTable/ColorTransferFunction + setScalarRange）
  → vtkActor
```

### 模式 C：剖面（真几何切面，水密）

```
闭合 vtkPolyData
  → vtkClipClosedSurface（clippingPlanes=[vtkPlane]，generateClosedOutput=true）
      → 输出**水密闭合体**：切面自动封盖且按场值着色
  → vtkMapper + vtkActor
```
- 无缝、无空壳（解决痛点②）；切面显示的是真实内部场值（配合模式 A 即可看体积内部）。

### 附加：等值面 / 工程风格等值线

`vtkImageMarchingCubes`（体数据）→ 损伤等值面 / 等值线，得到接近 LS-DYNA 后处理的硬朗等值面效果；
配合 `vtkScalarBarActor` 输出工程色标图例。

---

## 6. 三大痛点 → 解法映射（自检表）

| 痛点 | 解法 | 验收标准 |
|---|---|---|
| ① 只有外壳、内部空心 | 模式 A 体绘制（体数据线性插值）+ 模式 C 水密切面 | 剖开模型可看到内部连续的场分布，非空腔 |
| ② 剖切慢、拼接不严 | 运行时 `vtkClipClosedSurface` 真几何裁剪（自带封盖）；体模式用 crop 瞬时裁剪 | 切面与侧面无缝、无空壳；拖动剖切滑块无可感卡顿 |
| ③ 云图块状、光照不真实 | 共享顶点 + `vtkCleanPolyData` + `vtkPolyDataNormals` 点法线 + 传递函数 | 表面平滑过渡、有连续光照；等值线连续不断裂 |

---

## 7. 交互与 UI 集成

### 7.1 相机按键映射（沿用既有约定，必须一致）

现有约定：**左键平移 / 中键旋转 / 右键或滚轮缩放**。vtk.js 默认是"左键旋转"，需自定义 `InteractorStyle`（继承 `vtkInteractorStyleTrackballCamera`）重写 `handleLeftButtonDown`/`handleMiddleButtonDown`/`handleMouseWheel` 完成映射。

### 7.2 与 dashboard DOM 桥接

- 保留现有 HTML 面板（时间轴、图例、取点曲线、起爆时序、能量曲线、算例切换、剖切滑块）；
- 3D 视口仅把 `<canvas id="gl">` 的渲染循环从 THREE 换成 `vtkGenericRenderWindow`；
- 取点曲线：延续既有结论——**必须用全分辨率节点时程**，不得用单元均值；vtk.js 可通过 `vtkCellPicker`/`vtkPointPicker` 命中节点索引后回查现有 nodal history。

### 7.3 粒子（SPH / PBM）

`vtkPointGaussianMapper`（软边粒子）或 `vtkSphereSource` + `vtkGlyph3DMapper`（实体球/多面体碎块，符合"至少 3–4 种形状、相对尺寸可辨"的既有要求）。

---

## 8. 工程集成

### 8.1 离线单页打包（保持零外部依赖）

- 用 **esbuild/rollup 一次性树摇**打包 `@kitware/vtk.js` 所需模块 → 产出本地 `webapp/lib/vtk.js`（与现有 `lib/three.module.js` 同策略），页面用本地 ESM 引用，不依赖 `esm.sh`/CDN；
- 只 import 实际用到的模块与 Rendering Profile，避免整包体积。

### 8.2 模块划分（替换现有单文件内的渲染段）

```
webapp/vtk/
  ├─ engine.js        # GenericRenderWindow / Renderer / 相机 / InteractorStyle
  ├─ datasource.js    # 数据集读取与构建（PolyData / ImageData）
  ├─ surface.js       # 模式 B：CleanPolyData/Normals/Mapper/Actor
  ├─ volume.js        # 模式 A：VolumeMapper/TransferFunction/Volume
  ├─ section.js       # 模式 C：ClipClosedSurface + vtkPlane
  ├─ iso.js           # 等值面/等值线 + ScalarBar
  ├─ glyph.js         # SPH/PBM 粒子与碎块
  └─ bridge.js        # 与现有 dashboard DOM 的事件/状态桥接
```

Python 侧新增：`export_polydata.py`、`export_volume.py`，由 `auto_convert.py` 统一编排，保持自动化导入。

---

## 9. 实施路线（每步可独立验收）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 能力验证** | 用最小算例（airblast ~14K 面）跑通 vtk.js：闭合 PolyData → ClipClosedSurface → 无缝剖切 | 切面水密无缝隙，"真几何裁剪 + 封盖"假设被证实 |
| **M1 表面云图** | 共享顶点 PolyData + CleanPolyData + PolyDataNormals + 传递函数 | 表面平滑、光照连续、等值线连续（痛点③消除） |
| **M2 实体体绘制** | Python 重采样体数据 + VolumeMapper 线性插值 | 剖开可见真实内部场，无空腔（痛点①消除） |
| **M3 剖切替换** | ClipClosedSurface（表面） + ImageCropFilter（体）替换自研 CSG | 拖动剖切即时响应、无缝（痛点②消除） |
| **M4 交互与迁移** | 自定义按键映射、dashboard 桥接、等值面/标尺、粒子 glyph、惰性加载 | 三算例全部可切换播放，交互与现有约定一致 |

### 待你确认的取舍

1. **体数据帧覆盖策略**：全状态低分辨率（保 1:1）vs 关键帧高分辨率（保画质）——建议前者保证硬约束，高保真走关键帧；
2. **是否允许引入构建步骤**（esbuild 树摇打包）——换取离线单页与体积可控；
3. **体素预算默认档**（建议 4M 体素）。

---

## 10. 风险与备选

| 风险 | 说明 | 应对 |
|---|---|---|
| 重采样有损 | 体数据是"探测采样"，亚体素的锐利单元界面会被平滑 | 用足够分辨率 + 仅对损伤/应变平滑、压力/密度保原始；必要时叠加模式 B 表面云图做精确对照 |
| 3D 纹理尺寸上限 | 大域高分辨率可能超显卡 `MAX_3D_TEXTURE_SIZE` | 自动降分辨率或分块（brick） |
| vtk.js 无 `vtkResampleToImage` | 该过滤器仅在 C++/Python VTK 中 | 重采样放在 Python 离线完成（与现有架构一致，非缺陷） |
| 前端需真非结构网格 | vtk.js 不支持 | 兜底改用 **VTK.wasm**（体积大，牺牲离线单页） |
| vtk.js 尚需许可确认 | 开源（BSD 系）但会引入第三方代码 | 引入前确认许可与署名 |

---

## 11. 参考来源

- [vtk.js Overview（支持 ImageData/PolyData，WebGL + WebGPU soon）](https://kitware.github.io/vtk-js/docs/index.html)
- [vtk.js 不支持 unstructured grid（官方回复）](https://discourse.vtk.org/t/vtk-js-unstructured-grid/13513)
- [vtk.js Volume（体绘制能力说明）](https://kitware.github.io/vtk-js/api/Rendering_Core_Volume.html)
- [vtk.js VolumeMapper（GPU 光线投射）](https://kitware.github.io/vtk-js/api/Rendering_Core_VolumeMapper.html)
- [vtk.js CutterMapper 示例（剖切）](http://kitware.github.io/vtk-js/examples/CutterMapper/index.html)
- [vtk.js ClipClosedSurface 示例（闭合裁剪+封盖）](https://kitware.github.io/vtk-js/examples/ClipClosedSurface.html)
- [vtk.js PolyDataNormals（平滑法线）](https://discourse.vtk.org/t/hide-edges-in-3d/15227)
- [vtk.js v35 Release（新增 vtkCleanPolyData / vtkThresholdPoints）](https://www.kitware.com/vtk-js-v35-release/)
- [vtk.js ImageMarchingCubes 示例（等值面）](https://kitware.github.io/vtk-js/examples/ImageMarchingCubes.html)
- [vtk.js HttpDataSetReader（数据集格式）](https://kitware.github.io/vtk-js/api/IO_Core_HttpDataSetReader.html)
- [vtk.js 作为 ES 依赖打包](https://kitware.github.io/vtk-js/docs/intro_vtk_as_es6_dependency.html)
- [VTK.wasm（浏览器内非结构网格兜底方案）](http://kitware.github.io/vtk-wasm/news.html)
- [VTK WebGPU Roadmap](https://discourse.vtk.org/t/vtk-webgpu-roadmap/13749)
