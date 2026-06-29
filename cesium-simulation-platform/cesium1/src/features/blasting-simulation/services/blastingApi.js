/**
 * 爆破模拟 API — 对接后端 MySQL 数据
 * 提供事件列表、完整数据集、岩体参数、渲染配置等接口
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
 * 获取所有爆破事件列表
 * @param {string} [status] - 可选状态过滤
 * @returns {Promise<Array>}
 */
export function fetchBlastingEvents(status = null) {
  const url = status ? `${API_BASE}/events?status=${encodeURIComponent(status)}` : `${API_BASE}/events`
  return request(url).then(r => r.data || [])
}

/**
 * 获取单个爆破事件详情（含炮孔）
 * @param {string} eventId
 * @returns {Promise<Object>}
 */
export function fetchBlastingEvent(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}`).then(r => r.data)
}

/**
 * 获取完整爆破模拟数据集（事件+炮孔+帧+粒子+振动+应力）
 * @param {string} eventId
 * @param {Object} [opts]
 * @param {number} [opts.frameStart=0]
 * @param {number} [opts.frameEnd]
 * @returns {Promise<Object>}
 */
export function fetchBlastingDataset(eventId, opts = {}) {
  const params = new URLSearchParams()
  if (opts.frameStart != null) params.set('frame_start', opts.frameStart)
  if (opts.frameEnd != null) params.set('frame_end', opts.frameEnd)
  const qs = params.toString()
  const url = `${API_BASE}/events/${encodeURIComponent(eventId)}/dataset${qs ? '?' + qs : ''}`
  return request(url).then(r => r.data)
}

/**
 * 获取所有岩体参数
 * @returns {Promise<Array>}
 */
export function fetchRockParams() {
  return request(`${API_BASE}/rock-params`).then(r => r.data || [])
}

/**
 * 获取指定岩石类型的岩体参数
 * @param {string} rockType
 * @returns {Promise<Object>}
 */
export function fetchRockParamsByType(rockType) {
  return request(`${API_BASE}/rock-params/${encodeURIComponent(rockType)}`).then(r => r.data)
}

/**
 * 获取所有渲染配置
 * @returns {Promise<Array>}
 */
export function fetchRenderConfigs() {
  return request(`${API_BASE}/render-configs`).then(r => r.data || [])
}

/**
 * 获取指定渲染配置
 * @param {string} configName
 * @returns {Promise<Object>}
 */
export function fetchRenderConfig(configName) {
  return request(`${API_BASE}/render-configs/${encodeURIComponent(configName)}`).then(r => r.data)
}

/**
 * 获取事件帧统计列表
 * @param {string} eventId
 * @returns {Promise<Array>}
 */
export function fetchBlastingFrames(eventId) {
  return request(`${API_BASE}/events/${encodeURIComponent(eventId)}/frames`).then(r => r.data || [])
}

/**
 * 获取指定帧的粒子数据
 * @param {string} eventId
 * @param {number} frameIndex
 * @param {string} [particleType]
 * @returns {Promise<Array>}
 */
export function fetchBlastingParticles(eventId, frameIndex, particleType = null) {
  const params = new URLSearchParams({ frame_index: frameIndex })
  if (particleType) params.set('particle_type', particleType)
  return request(
    `${API_BASE}/events/${encodeURIComponent(eventId)}/particles?${params.toString()}`
  ).then(r => r.data || [])
}

/**
 * 获取应力时程数据
 * @param {string} eventId
 * @param {string} [pointId]
 * @returns {Promise<Array>}
 */
export function fetchBlastingStress(eventId, pointId = null) {
  const url = pointId
    ? `${API_BASE}/events/${encodeURIComponent(eventId)}/stress?point_id=${encodeURIComponent(pointId)}`
    : `${API_BASE}/events/${encodeURIComponent(eventId)}/stress`
  return request(url).then(r => r.data || [])
}

/**
 * 创建爆破事件
 * @param {Object} data
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
 * @param {Object} data
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

/**
 * 创建炮孔
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export function createBlastingHole(data) {
  return request(`${API_BASE}/holes/`, {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 删除炮孔
 * @param {string} eventId
 * @param {string} holeId
 * @returns {Promise<Object>}
 */
export function deleteBlastingHole(eventId, holeId) {
  return request(
    `${API_BASE}/holes/${encodeURIComponent(eventId)}/${encodeURIComponent(holeId)}`,
    { method: 'DELETE' }
  )
}

/**
 * 将后端渲染配置转换为前端 BlastingManager 渲染参数
 * @param {Object} config - 后端 blasting_render_config 记录
 * @returns {Object}
 */
export function parseRenderConfig(config) {
  if (!config) return {}
  return {
    particleMode: config.particle_mode || 'point_primitive',
    fireballEnabled: !!config.fireball_enabled,
    smokeColumnEnabled: !!config.smoke_column_enabled,
    fragmentTrailEnabled: !!config.fragment_trail_enabled,
    glowEffect: !!config.glow_effect,
    maxVisibleParticles: config.max_visible_particles || 2000,
    smokeColumnHeight: config.smoke_column_height || 80,
    smokeColumnRadius: config.smoke_column_radius || 15,
    fireballRadius: config.fireball_radius || 12,
    fireballDuration: config.fireball_duration || 1.5,
    fragmentOutline: config.fragment_outline !== 0,
    transparencyEnabled: config.transparency_enabled !== 0,
    lodDistance: config.lod_distance || 500
  }
}
