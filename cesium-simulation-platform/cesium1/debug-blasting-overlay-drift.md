# [OPEN] Debug Session: blasting-overlay-drift

## Summary
- Symptom 1: three.js 绘制的岩石/爆破模型在缩放视角后仍出现相对爆点漂移。
- Symptom 2: 爆点周围热力图仍有闪跳/闪烁，影响观看体验。

## Scope
- Project: `cesium1`
- Area: `src/features/blasting-simulation`

## Hypotheses
1. Cesium 相机同步到 three.js 时，使用的相机位置/方向仍与真实渲染坐标系不一致，导致缩放后叠加层发生漂移。
2. three.js 场景中的对象坐标轴映射或局部原点定义存在偏差，缩放时误差被放大。
3. 热力图闪跳不是单纯的删建实体，而是矩形材质、贴地高度或深度排序与地表/模型发生 Z-fighting。
4. 热力图更新节奏与 Cesium 渲染节奏不同步，导致某些帧使用旧纹理或空纹理。
5. 漂移和闪跳可能来自同一个根因：Cesium/three.js 叠加层在相机或高度基准上没有完全对齐。

## Evidence Log
- Pending instrumentation.

## Status
- Step 1 complete: session initialized.
- Next: add instrumentation only, reproduce, collect logs, then judge hypotheses.
