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
