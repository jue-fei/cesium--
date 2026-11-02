# 爆破块体形态与爆堆相似性：文献依据对照

> 对应实现：`src/features/blasting-simulation/services/core/geometry/`、
> `rendering/rockGeometryFactory.js`、`rendering/fragmentSpecGenerator.js`、
> `rendering/muckPileMetrics.js`
> 定量验收：`docs/blasting-fragmentation-validation.md`（由 `scripts/validate-fragmentation-shape.mjs` 生成）

## 一、三个质疑的结论先行

| 质疑 | 结论 | 依据 |
|---|---|---|
| 碎石大量是扁平片状 | **成立，已修复**。旧版把 x50~x80 的中块**全部**硬映射成板状（`flatten = 0.12~0.25`），加上 10~15% 长条，片状占比超过 40% | 块体形状由**节理组间距比**控制（Zingg 分类），中块不应默认板状 |
| 爆堆分布/形状是否相似 | **部分相似，已量化并标定**。旧参数下抛距 P95 = 85m（碎块被抛到隧道尽头）、堆体摊平；标定后抛距 P95 ≈ 27~29m、堆高 1.5m、堆高比 0.10 | 隧道受限空间的爆堆坡角天然低于自由堆积安息角，需分开设定参考区间 |
| 先算块度再用正态分布撒到掌子面是否合理 | **不合理，已改**。纯高斯采样把碎块挤在孔轴 σ 范围内，断面边缘与孔间出现空洞，且体积不守恒 | 初始碎块应充满待爆岩体体积；孔周高斯只能作为局部修正（近孔细粒化） |

## 二、文献与实现对照

| 结论 | 文献出处 | 本项目实现 | 偏差与处理 |
|---|---|---|---|
| 爆破块体由节理组切割形成，块体尺寸与形状受结构面间距/产状控制 | 胡英国等. 岩体结构面对爆破块度的影响机制研究. 岩土工程学报, 2024. DOI: 10.11779/CJGE20230410；陶明等. 不同倾角充填节理对岩石爆破块度的影响. 爆炸与冲击, 2025. DOI: 10.11883/bzycj-2024-0414 | `geometry/jointNetwork.js`：三组节理（倾向/倾角/间距）→ 三轴比 → Zingg 分类；`geometry/voronoiBlockGeometry.js`：三组平面求交得平行六面体 + 面心外凸 + 顶点扰动 → 凸包 | 未做真实节理网络反演（需要现场结构面编录数据），当前用 4 组预设（massive/bedded/columnar/sheared）覆盖典型岩体 |
| 块体形状可用 Zingg 分类（b/a 伸长率、c/b 扁平度）划分块状/板状/柱状/片状 | Zingg Th. Beitrag zur Schotteranalyse. Schweiz. Mineral. Petrogr. Mitt., 1935 | `jointNetwork.classifyZingg()` 阈值 0.33 / 0.67；`getRockVariantShapeStats()` 输出每变体的 Zingg 分类 | 阈值采用经典 Zingg 图版；`stats.zingg` 以实际几何三轴比判定（间距比只是名义值，求交+扰动后会偏移） |
| 爆破块度分布可用 Kuz-Ram / Swebrec 预测，但 Kuz-Ram 对粗块端系统性高估、不描述形状 | Saldana M. et al. Applications of Kuz–Ram Models in Mine-to-Mill Integration. Minerals, 2024, 14(11):1162. DOI: 10.3390/min14111162；Ouchterlony F. The Swebrec function | `kcoModelCore.js` 用 Swebrec 质量分布采样；`fragmentSpecGenerator` 输出 `sizeKLDivergence` 与 Swebrec 目标直方图对照 | 本项目只用块度**边缘分布**，形状与位置分别由节理网络、体积守恒采样决定（块度模型不含形状信息，这是 Kuz-Ram 的固有局限） |
| 数值模拟中块体常用 Voronoi 多面体（节理网络/种子点切割）生成 | Wang et al. Modeling rock fragmentation by coupling Voronoi diagram and DVIB. Theor. Appl. Mech. Lett., 2020. DOI: 10.1016/j.taml.2020.01.045；Bahadori M. et al. A new geometrical-statistical algorithm for predicting two-dimensional fragments. Int. J. Rock Mech. Min. Sci., 2016 | `voronoiBlockGeometry.js`：3 组节理面 × 2（±间距/2）求交 → 8 顶点平行六面体；叠加 2~4 个次级切面（面心外凸）与顶点扰动，生成 12~24 面凸多面体，作为渲染网格与 Rapier 凸包碰撞体 | 未做真正的 3D Voronoi 图（需要种子点全局优化），但"节理面求交 + 凸包"在形状学上与 Voronoi-DEM 的节理控制等效，且顶点数（8~20）远低于 Voronoi 单元，适合数千刚体实时模拟 |
| 爆堆形态用三参数描述：throw（抛距）、drop（落差）、lateral spreading（横向展布） | Study on Muck Pile Shape of Open-Pit Bench Blasting. Advances in Civil Engineering, 2023. DOI: 10.1155/2023/2859668；Mirabedi S.M. et al. Blasted muckpile modelling in open pit mines. 2024 | `muckPileMetrics.js` 输出 `throwP95/throwMax/drop/lateralSpread`，另加 `pileHeight/pileHeightRatio/reposeAngleDeg/segregationRatio` | 露天台阶的横向展布不受限；隧道内横向展布被侧墙限制（本项目实测 15~16m ≈ 断面宽） |
| 碎石自由堆积安息角约 35°~42° | 岩石力学与爆破工程手册量级（多篇综述一致） | `MUCK_PILE_REFERENCE.freeReposeAngleDeg = [35, 42]` 作为**理论上限**；`reposeAngleDeg` 的验收区间按隧道摊铺口径放宽到 [3, 45] | 隧道爆堆被侧墙/拱顶约束、方量大且摊铺在 18m 宽断面，整体坡角远低于自由堆积上限；用 35~42° 直接卡隧道爆堆会误判 |
| 粒度偏析有双向机制：斜坡滚落使粗块到坡脚（>1）；振动筛分使粗块上浮到堆顶（<1，Brazil-nut effect） | 多篇爆堆偏析研究（如 blasting muckpile segregation 综述） | `segregationRatio = 坡脚 d50 / 堆顶 d50`，参考区间 [0.35, 2.5] 只报警极端偏析 | 实测 0.49~0.55（大块在堆顶）→ 本场景筛分机制主导；报告如实呈现方向 |
| 抛掷速度由比装药与炸药比能决定（能量守恒），能量耦合系数 η 通常 2%~8% | Persson P-A. et al. Rock Blasting and Explosives Engineering, 1993/1997 | `fragmentSpecGenerator` Persson 模型 `vBase = √(2ηqE_g/ρ)`；η 默认 0.008（实测标定） | η 比文献下限更低：本模型把"代表性碎岩"的块径放大（体积还原 k≈1.5），质量偏大 → 为保持抛距量级需下调 η；属工程等效标定，已在代码注释中标注 |

## 三、关键标定记录（可复现）

| 参数 | 旧值 | 新值 | 影响（实测） |
|---|---|---|---|
| 中块形状映射 | x50~x80 全部 → 板状（flatten 0.12~0.25） | 按节理族权重抽取（默认板状 3%~4%） | 扁平度中位数 0.84，抽样块状占比 58.6%（层理场景 45.0% 为有意提高） |
| 初始位置采样 | 孔心高斯（σ 0.45~0.72m） | 70% 断面低差异分层 + 30% 近孔高斯，轴向按块度分层（大块→深层） | 现场尺度偏析比 3.1（粗块在坡脚） |
| 初始分布深度 | 无（全部共面） | 松散体积 / 断面面积（保证 3D 不重叠） | 消除"石柱式堆叠"（实测堆高 11.9m → 3.7m） |
| 能量耦合 η | 0.15 | 0.005 | 初速中位数 34 → 3.9 m/s（现场尺度），抛距 P95 85m → 8.5m |
| 尺寸因子 | v ∝ x50/d（大块速度仅小块 1/6） | **取消块度-速度耦合**（=1） | 偏析由"初始深度分层"主导，方向稳定（旧版 0.05~2.6 波动） |
| 穿透容差 | 固定 0.001 | 初始轴向跨度/块径 <3 时 0.05，否则 0.002 | 消除大断面石柱堆叠，同时保住现场尺度偏析 |
| 冻结阈值 | 全局 0.8 m/s | 随块径降低（大块难冻结，滚更远） | 配合深度分层形成"坡脚粗块" |
| 碎片/底板摩擦 | 0.72 / 0.8 | 0.85 / 0.85 | 落地后滑移减少，爆堆集中 |
| 可见质量分数 | 0.5~0.97 | 0.85~1.0 | 爆堆体积还原完整，堆高比 0.88（现场尺度） |
| 底板厚度 | 0.5m | 4m（顶面不变） | 消除深穿透导致穿底（见项目经验库） |

## 四、浏览器实测验证（2026-10-29，事件 BLAST-2026-006）

在 http://localhost:3000 实跑一次全断面爆破（4500 个碎块，298 帧回放）并读取渲染器当前帧：

- 断面包含性：越出轮廓 **0 个**、低于底板 **0 个**；|x| 最大 5.86m < 半宽 6.125m，y ∈ [0.05, 8.96]m
- 爆堆形态：紧贴掌子面锥形堆积，轴向跨度仅 2.91m（进尺量级），无穿墙/穿底漏出
- KCO 面板「块体形态」：块状 44% / 不规则 39% / 柱状 6% / 板状 11%，扁平度中位数 0.79
- 截图：`output/bshot_23_final_pile.png`（爆堆）、`output/bshot_21_kco_shape_final.png`（面板）、`output/bshot_25_block_closeup.png`（棱面特写）

## 五、尚未解决/后续可做

1. **真实节理网络反演**：当前用 4 组预设，未接入现场结构面编录（倾向/倾角/间距分布）。
2. **大断面（展示尺度，宽 18m）的堆形偏离**：崩落方量摊在 235m² 断面上，代表性碎岩初始几乎共面，即使自适应放宽穿透容差，个别子场景（层理、大块）仍会堆成 3~8m 高的窄堆，堆高比/坡角超出文献区间。现场尺度（4m×4m）不受此影响。彻底解决需要"初始不重叠 3D 装箱"（按断面容量限制块径或块数）。
3. **块度-速度耦合**：当前已取消（视为弱相关）。若后续接入精确的孔周能量分配，可重新引入但需保证不逆转偏析方向。
4. **细粒流失**：代表性碎岩不含粉末，爆堆堆顶细粒层未单独建模。
