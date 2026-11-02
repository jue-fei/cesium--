/**
 * 数据源台账 API（方案 WP1 T1.2–T1.7）
 *
 * 对应后端 app/routes/datasource.py：
 *   GET    /api/datasource                 台账列表
 *   POST   /api/datasource                 登记/更新
 *   DELETE /api/datasource/{code}          删除
 *   POST   /api/datasource/{code}/test     连通性检测
 *   POST   /api/datasource/{code}/pull     主动拉取（rest/db）
 *   POST   /api/datasource/{code}/upload   文件导入（原始 body + filename）
 *   GET    /api/datasource/{code}/batches  批次回溯
 */

const API_BASE = '/api/datasource'

async function request(url, options = {}) {
  const res = await fetch(url, options)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`)
  return json
}

function jsonRequest(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

export function fetchSources() {
  return request(API_BASE).then(res => res.data || { sources: [], kinds: [] })
}

export function upsertSource(payload) {
  return request(API_BASE, jsonRequest('POST', payload))
}

export function deleteSource(code) {
  return request(`${API_BASE}/${encodeURIComponent(code)}`, { method: 'DELETE' })
}

export function testSource(code) {
  return request(`${API_BASE}/${encodeURIComponent(code)}/test`, { method: 'POST' })
}

export function pullSource(code, limit = 100) {
  const q = `?limit=${Math.max(1, Math.min(1000, limit))}`
  return request(`${API_BASE}/${encodeURIComponent(code)}/pull${q}`, { method: 'POST' })
}

/** 文件导入：后端以原始字节 + filename 查询参数承载，不依赖 multipart。 */
export function uploadSourceFile(code, file) {
  const q = `?filename=${encodeURIComponent(file.name)}`
  return request(`${API_BASE}/${encodeURIComponent(code)}/upload${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  })
}

export function fetchBatches(code, limit = 20) {
  const q = `?limit=${Math.max(1, Math.min(200, limit))}`
  return request(`${API_BASE}/${encodeURIComponent(code)}/batches${q}`).then(
    res => res.data?.batches || []
  )
}
