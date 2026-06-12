# Debug Session: MOO Worker Error

**Status:** [OPEN]
**Session ID:** moo-worker-error
**Started:** 2026-06-03

## Symptom
点击"开始优化"后，浏览器控制台报错：
```
MOO Worker error:
at handleWorkerError (MooPanel.vue:185:10)
```

## Hypotheses
1. **H1 - Worker 文件路径错误**：`new URL('../services/core/mooWorker.js', import.meta.url)` 路径解析失败，导致 Worker 无法加载
2. **H2 - Worker 内部 JS 语法/模块错误**：mooWorker.js 内部存在语法错误或模块导入问题，导致 Worker 初始化失败
3. **H3 - 消息格式不匹配**：Worker 期望的消息格式与实际发送的格式不一致，导致 Worker 内部抛出异常
4. **H4 - 结构化克隆失败**：虽然已修复 config 和 objectiveDefinitions 的克隆，但其他字段仍可能包含不可克隆的数据
5. **H5 - Worker 模块类型不支持**：浏览器或构建环境不支持 `{ type: 'module' }` 的 Worker 初始化方式

## Evidence
- 之前的 `DataCloneError` 已修复（通过 JSON 深拷贝）
- 现在错误变为更通用的 `MOO Worker error`，说明 Worker 可能已加载但执行出错

## Next Steps
1. 在 Worker 和 MooPanel 中添加插桩日志
2. 复现问题并收集日志
3. 根据日志确定根因
