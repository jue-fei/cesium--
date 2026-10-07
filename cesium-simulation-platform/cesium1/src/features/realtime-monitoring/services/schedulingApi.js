/**
 * schedulingApi.js —— 现场调度（scheduling）一次性动作 HTTP API 封装
 *
 * 与 useScheduling.js（WebSocket 长连接 / HTTP 轮询数据服务）互补：
 * 这里收纳组件直接提交的调度动作接口，统一维护请求路径、方法与负载契约。
 * 写接口（3.2.1 起）统一注入协作身份头（X-Client-Id / X-Operator），后端据此刻画
 * 审计 actor 与来源终端；身份真源见 features/shared/services/collabIdentity.js。
 */
import { withIdentity } from '../../shared/services/collabIdentity.js'

/**
 * 提交 NSGA-III 选解派单。
 * @param {Array<{equipId:string, target:string, path:string[]}>} assignments 派单列表（decodeAssignment 输出）
 * @param {{baseRev?:number, force?:boolean}} [opts] 3.2.3 乐观并发：baseRev 与当前
 *   派单 rev 不符时后端返回 {code:2}（可 force=true 跳过校验）
 * @returns {Promise<object>} 后端 JSON（{code, data:{applied, rejected, rev}}）；HTTP/网络错误向上抛出由调用方处理
 */
export function applyAssignment(assignments, { baseRev, force } = {}) {
  const q = new URLSearchParams()
  if (baseRev != null) q.set('baseRev', String(baseRev))
  if (force) q.set('force', 'true')
  const qs = q.toString() ? `?${q.toString()}` : ''
  return fetch(
    `/api/scheduling/apply_assignment${qs}`,
    withIdentity({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assignments)
    })
  ).then(r => r.json())
}

/**
 * 读取拖拽式设备部署与出矿工序顺序（3.2）。真源 config/deployments/<场景名>.json。
 * @param {string} scenario 场景名
 * @returns {Promise<object>} {code, data:{deployments:{[equipId]:{node,level}}, processOrder:string[]}}
 */
export function fetchDeployment(scenario) {
  const q = scenario ? `?scenario=${encodeURIComponent(scenario)}` : ''
  return fetch(`/api/deployment${q}`).then(r => r.json())
}

/**
 * 保存设备部署/出矿工序顺序（3.2）。后端校验→落盘→即刻应用到运行中的仿真器
 * （空闲设备迁移待命点；作业中设备下次仿真重置生效）。
 * @param {{scenario?:string, deployments?:Object, processOrder?:string[]}} payload
 *   deployments 为增量合并（设备→{node,level}），processOrder 为整体替换
 * @returns {Promise<object>} {code, data:{deployments, processOrder, applied, skipped}}；code!==0 时 message 带原因
 */
export function saveDeployment(payload) {
  return fetch(
    '/api/deployment',
    withIdentity({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  ).then(r => r.json())
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
  return fetch(
    '/api/scheduling/multi-objective/solve',
    withIdentity({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  ).then(r => r.json())
}
