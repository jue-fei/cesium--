/**
 * 爆破模拟 API — 对接后端 MySQL 数据
 * 提供事件 CRUD、爆破设计、爆破效果等接口
 * 后端 GET 响应字段为 camelCase（由后端 _row_to_camel 转换），
 * POST/PUT 请求体使用 snake_case 字段名以匹配 Pydantic schema，
 * 本模块在发送前自动将 camelCase 对象转换为 snake_case。
 */

const API_BASE = '/api/blasting'

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

/**
 * 将单个 camelCase 字符串转换为 snake_case
 * 例如：tunnelWidth → tunnel_width，expectedX50 → expected_x50
 * @param {string} s
 * @returns {string}
 */
function _camelToSnake(s) {
  return s.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * 将对象的所有 key 从 camelCase 转换为 snake_case
 * 若 key 本身即为 snake_case（无大写字母），则保持不变（即对 snake_case 输入是幂等的）
 * @param {Object|null|undefined} obj
 * @returns {Object}
 */
function _objCamelToSnake(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj || {}
  const out = {}
  for (const k of Object.keys(obj)) {
    out[_camelToSnake(k)] = obj[k]
  }
  return out
}

// ─── 爆破事件 CRUD ─────────────────────────────────────

/**
 * 获取所有爆破事件列表
 * @param {string} [status] - 可选状态过滤
 * @returns {Promise<Array>}
 */
export function fetchBlastingEvents(status = null) {
  const url = status
    ? `${API_BASE}/events?status=${encodeURIComponent(status)}`
    : `${API_BASE}/events`
  return request(url).then(r => r.data || [])
}

/**
 * 获取单个爆破事件详情
 * @param {string} eventId
 * @returns {Promise<Object>}
 */
export function fetchBlastingEvent(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}`).then(r => r.data)
}

/**
 * 创建爆破事件
 * @param {Object} data - BlastingEventCreate 字段（snake_case，如 event_id/name/center_lon 等）
 * @returns {Promise<Object>}
 */
export function createBlastingEvent(data) {
  return request(`${API_BASE}/events/`, {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 更新爆破事件
 * @param {string} eventId
 * @param {Object} data - BlastingEventUpdate 字段（snake_case）
 * @returns {Promise<Object>}
 */
export function updateBlastingEvent(eventId, data) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

/**
 * 删除爆破事件
 * @param {string} eventId
 * @returns {Promise<Object>}
 */
export function deleteBlastingEvent(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE'
  })
}

// ─── 爆破设计（隧道断面+掏槽+起爆+装药+效果预期+安全+炮孔） ─

/**
 * 获取爆破设计（含炮孔列表）
 * 后端返回 { code:0, data:{ design:{camelCase}, holes:[{camelCase}] } }
 * @param {string} eventId
 * @returns {Promise<{design: Object|null, holes: Array}>}
 */
export function fetchBlastingDesign(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/design`).then(r => r.data)
}

/**
 * 保存爆破设计（upsert design + 批量替换 holes）
 * 接收 camelCase 对象，内部转换为 snake_case 后提交以匹配 BlastingDesignCreate schema
 * @param {string} eventId
 * @param {Object} data
 * @param {Object} [data.design] - 设计参数（camelCase，如 tunnelShape/tunnelWidth/expectedX50 等）
 * @param {Array} [data.holes] - 炮孔列表（camelCase，如 posX/posY/holeType/chargeKg 等）
 * @returns {Promise<Object>}
 */
export function saveBlastingDesign(eventId, data = {}) {
  const design = data.design || {}
  const holes = data.holes || []
  const payload = {
    ..._objCamelToSnake(design),
    event_id: eventId,
    holes: holes.map(h => _objCamelToSnake(h))
  }
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/design`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

// ─── 爆破效果结果 ───────────────────────────────────────

/**
 * 获取爆破效果数据
 * 后端返回 { code:0, data:{camelCase} }（如 craterDepth/fragmentX50/throwDistanceMax 等）
 * @param {string} eventId
 * @returns {Promise<Object>}
 */
export function fetchBlastingResult(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/result`).then(r => r.data)
}

/**
 * 创建或更新爆破效果（upsert）
 * 接收 camelCase 对象，内部转换为 snake_case 后提交以匹配 BlastingResultCreate schema
 * @param {string} eventId
 * @param {Object} data - 爆破效果字段（camelCase，如 craterDepth/fragmentX50/vibrationPeak 等）
 * @returns {Promise<Object>}
 */
export function saveBlastingResult(eventId, data = {}) {
  const payload = {
    ..._objCamelToSnake(data),
    event_id: eventId
  }
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/result`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
}

/**
 * 批量获取多事件爆破效果用于历史对比
 * 后端返回 { code:0, data:{ results:[...], comparison:{...} } }
 * @param {string[]} eventIds - 事件ID列表
 * @returns {Promise<Array>} 各事件的爆破效果数组（camelCase，含 eventId）
 */
export function fetchBlastingResults(eventIds) {
  return request(`${API_BASE}/results/compare`, {
    method: 'POST',
    body: JSON.stringify({ event_ids: eventIds })
  }).then(r => (r.data && r.data.results) || [])
}

// ─── 运行时统计（blasting_runtime_stats） ───────────────

/**
 * 保存运行时统计快照（每次 replay 生成一行）
 * @param {string} eventId 事件 ID
 * @param {Object} payload { randomSeed, algorithmVersion, paramsSnapshot, statsSnapshot }
 * @returns {Promise<Object>}
 */
export function saveRuntimeStats(eventId, payload) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/runtime-stats`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

/**
 * 查询事件历次运行时统计（按时间倒序）
 * @param {string} eventId 事件 ID
 * @returns {Promise<Array>}
 */
export function fetchRuntimeStats(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/runtime-stats`).then(
    r => r.data || []
  )
}
