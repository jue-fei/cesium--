/**
 * schedulingApi.js —— 现场调度（scheduling）一次性动作 HTTP API 封装
 *
 * 与 useScheduling.js（WebSocket 长连接 / HTTP 轮询数据服务）互补：
 * 这里收纳组件直接提交的调度动作接口，统一维护请求路径、方法与负载契约。
 */

/**
 * 提交 NSGA-III 选解派单。
 * @param {Array<{equipId:string, target:string, path:string[]}>} assignments 派单列表（decodeAssignment 输出）
 * @returns {Promise<object>} 后端 JSON（{code, data:{applied:[...]}}）；HTTP/网络错误向上抛出由调用方处理
 */
export function applyAssignment(assignments) {
  return fetch('/api/scheduling/apply_assignment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assignments)
  }).then(r => r.json())
}

/**
 * 获取推荐权重方案。外部 ML 权重服务优先（训练与推理在外部，平台只消费结果），
 * 未启用/失败时后端自动降级等权（data.source='fallback' 且 data.degraded=true）。
 * 契约见 shared-consistency-baseline.json#weightTuningCmps。
 * @param {string} scenario 场景名
 * @returns {Promise<object>} {code, data:{weights, source, modelVersion, degraded, latencyMs}}
 */
export function fetchWeightRecommend(scenario) {
  const q = scenario ? `?scenario=${encodeURIComponent(scenario)}` : ''
  return fetch(`/api/scheduling/weights/recommend${q}`).then(r => r.json())
}

/**
 * 按权重观察多目标优化结果。
 * @param {{weights:Object, resolve?:boolean, scenario?:string, signal?:AbortSignal}} payload
 *   resolve=false（默认·快路径）：在快照既有前沿上加权推荐，毫秒级返回 recommendedIndex；
 *   resolve=true（深路径）：权重作为偏好参考方向重新运行 NSGA-III，返回新前沿。
 * @returns {Promise<object>} {code, data:{solved, weights, recommendedIndex, ...}}
 */
export function solveMultiObjective(payload) {
  const { signal, ...body } = payload
  return fetch('/api/scheduling/multi-objective/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  }).then(r => r.json())
}
