/**
 * 爆破模拟 API — 对接后端 MySQL 数据
 * 提供事件 CRUD、爆破设计、爆破效果等接口
 *
 * 数据约定：本模块对外接收 camelCase 参数（UI 层约定），发送 POST/PUT 前
 * 内部将 camelCase 转为 snake_case 提交后端（后端再以 snake_case 存入 DB）；
 * GET 响应由后端将 DB 的 snake_case 转为 camelCase 返回，本模块直接透传。
 */

/**
 * V1 兼容字段已废弃：
 * 后端 _build_design 返回的 design 对象中，V1_ONLY 字段（expectedX50/expectedXmax/
 * expectedThrowDistance/expectedOverbreak/minSafetyDistance/maxVibrationVelocity 等）
 * 已标记 "_deprecated": true。前端应逐步迁移到 V2 字段，避免依赖 V1 兼容字段。
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
  const url = status ? `${API_BASE}/events?status=${encodeURIComponent(status)}` : `${API_BASE}/events`
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

// ─── 阶段五：PPV 振动速度场 / 损伤区 / JWL 曲线 ──────────

/**
 * 计算二维 PPV 振动速度场
 * 后端返回 base64 编码的 float32 二进制（ppv_b64），前端解码为 Float32Array
 * @param {Object} params - { chargeKg, time, xMin, xMax, yMin, yMax, nx, ny, explosiveType, pWaveSpeed, attenuationP, rockUcs }
 * @returns {Promise<{nx:number, ny:number, gridX:number[], gridY:number[], ppv:Float32Array, maxPpv:number, meanPpv:number}>}
 */
export async function fetchPPVField(params) {
  const res = await fetch(`${API_BASE}/ppv-field`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  const data = await res.json()
  // base64 → ArrayBuffer → Float32Array
  const binary = atob(data.ppv_b64)
  const buf = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  const ppv = new Float32Array(buf)
  return {
    nx: data.nx,
    ny: data.ny,
    gridX: data.grid_x,
    gridY: data.grid_y,
    ppv,  // Float32Array, length = nx*ny
    maxPpv: data.max_ppv,
    meanPpv: data.mean_ppv
  }
}

/**
 * 计算爆破损伤区半径（粉碎区 / 裂隙区 / 弹性区）
 * @param {Object} params - { chargeKg, explosiveDensity, VoD, rockUcs, rockTensile }
 * @returns {Promise<{chargeRadius:number, detonationPressure:number, crushedRadius:number, fracturedRadius:number, elasticZoneStart:number}>}
 */
export function fetchDamageZones(params) {
  return request(`${API_BASE}/damage-zones`, {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

/**
 * 计算 JWL 等熵膨胀曲线（P-V 关系）
 * @param {Object} params - { explosiveType }
 * @returns {Promise<{relativeVolume:number[], pressurePa:number[]}>}
 */
export function fetchJWLCurve(params) {
  return request(`${API_BASE}/jwl-curve`, {
    method: 'POST',
    body: JSON.stringify(params)
  })
}
