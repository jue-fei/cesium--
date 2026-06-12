const API_BASE = '/api/truck-routes'

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

export function fetchRoutes() {
  return request(API_BASE).then(r => r.data || [])
}

export function fetchDefaultRoute() {
  return request(`${API_BASE}/default`).then(r => r.data)
}

export function fetchRoute(routeId) {
  return request(`${API_BASE}/${routeId}`).then(r => r.data)
}

export function createRoute(name, points, isDefault = false) {
  return request(API_BASE, {
    method: 'POST',
    body: JSON.stringify({ name, points, is_default: isDefault ? 1 : 0 })
  }).then(r => r.data)
}

export function updateRoute(routeId, data) {
  return request(`${API_BASE}/${routeId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

export function setDefaultRoute(routeId) {
  return request(`${API_BASE}/${routeId}/set-default`, { method: 'PUT' })
}

export function deleteRoute(routeId) {
  return request(`${API_BASE}/${routeId}`, { method: 'DELETE' })
}
