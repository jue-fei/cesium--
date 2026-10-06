/**
 * auditApi.js —— 操作审计（3.3）只读查询 API 封装
 *
 * 审计记录由后端各业务写路由内部追加（不可外部写入），这里只提供
 * 时间线查询与动作枚举拉取。动作标签真源在后端（新增审计点零前端发布）。
 * 契约见 shared-consistency-baseline.json#auditCmps。
 */

/**
 * 查询审计时间线（倒序，最新在前）。
 * @param {{limit?:number, action?:string, scenario?:string, beforeId?:number}} params
 *   beforeId：分页游标（传当前已加载最旧一条的 id，取更早记录）。
 * @returns {Promise<object>} {code, data:{entries:[{id,ts,actor,action,scenario,summary,detail,ok}], hasMore}}
 */
export function fetchAuditLogs({ limit = 50, action = '', scenario = '', beforeId = null } = {}) {
  const q = new URLSearchParams()
  if (limit) q.set('limit', String(limit))
  if (action) q.set('action', action)
  if (scenario) q.set('scenario', scenario)
  if (beforeId != null) q.set('before_id', String(beforeId))
  const qs = q.toString()
  return fetch(`/api/audit/logs${qs ? `?${qs}` : ''}`).then(r => r.json())
}

/**
 * 拉取动作枚举（id/label/domain），供过滤下拉与域徽标渲染。
 * @returns {Promise<object>} {code, data:{actions:[{id,label,domain}]}}
 */
export function fetchAuditActions() {
  return fetch('/api/audit/actions').then(r => r.json())
}
