# [OPEN] known-point-stress-crash

## 症状
- 打开“显示已知点应力”后，切换到其他板块。
- Cesium 报错：`An error occurred while rendering. Rendering has stopped.`
- 关键堆栈包含：`TypeError: Cannot read properties of undefined (reading 'length')`

## 复现路径
1. 进入应力相关板块。
2. 打开“显示已知点应力”。
3. 跳转到其他板块。
4. 观察 Cesium 渲染停止。

## 当前假设
- 假设 1：切板块时已知点应力对应的实体/primitive 没有正确销毁，但其动态属性仍在每帧回调里运行。
- 假设 2：已知点应力图层在离开面板后把 `polyline.positions`、`polygon.hierarchy` 或类似数组属性置成了 `undefined`。
- 假设 3：应力模块与其他板块共用 viewer 状态，退出时清理了上游数据数组，但保留了 Cesium entity 引用。
- 假设 4：面板切换触发了 watcher / lifecycle 清理顺序问题，导致 callback 在资源释放后继续访问 `length`。
- 假设 5：已知点应力显示使用的点位集合在“显示中”与“切板块”之间发生竞态，某一帧拿到了空对象而非数组。

## 证据计划
- 给“显示已知点应力”的创建、更新、销毁链路加运行时埋点。
- 给板块切换时的清理逻辑加埋点。
- 记录进入/退出后实体数量、目标数组类型、长度、viewer 存活状态。

## 状态
- 已建立调试会话，待插桩取证。

## 第一轮证据
- `setKnownPointStressVisible(true)` 后，`updateKnownPointStressOverlay()` 连续进入两次。
- 第一次 `viewer.dataSources.add(knownPointStressDataSource)` 后，日志显示 `containsAfterAdd=false`。
- 第二次进入时由于 `contains()` 仍为 `false`，又走了一次重复挂载分支。
- 切板块时未观察到 `exitStressAnalysis()` 调用证据，但观察到 `onUnmounted()` 执行，且卸载前数据源内仍有 16 个实体。
- Cesium 渲染崩溃发生在上述重复挂载后。

## 假设结论
- 假设 1：部分确认。问题核心不是“完全未销毁”，而是数据源生命周期管理异常，切板块卸载时触发崩溃。
- 假设 2：当前无证据表明 `polyline.positions` / `polygon.hierarchy` 被直接置为 `undefined`。
- 假设 3：未见“先清数据再留实体引用”的直接证据。
- 假设 4：确认存在生命周期顺序问题的表现，但更具体的根因是 `CustomDataSource` 重复 add。
- 假设 5：否。`knownPoints` 在复现时稳定为 16，不是空对象竞态。

## 已实施修复
- 去掉对 `viewer.dataSources.contains()` 立即结果的依赖。
- 改为显式维护 `knownPointStressDataSourceAttached`，避免同一 `CustomDataSource` 在 watcher 连续触发时被重复 add。
- 保留埋点，准备进行 `post-fix` 验证。
