import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 geologyDemoData.js）----
const FALLBACK_OREBODIES = [
  { orebody_id: 'ore1', name: '主矿体', grade: 2.5, reserves: 500, thickness: 12.5, bbox_min_x: 0, bbox_max_x: 100, bbox_min_y: 0, bbox_max_y: 100, bbox_min_z: 0, bbox_max_z: 50 },
  { orebody_id: 'ore2', name: '北翼延伸', grade: 1.2, reserves: 120, thickness: 8.0, bbox_min_x: 100, bbox_max_x: 150, bbox_min_y: 0, bbox_max_y: 50, bbox_min_z: 0, bbox_max_z: 30 }
]

const FALLBACK_STATS = {
  average_thickness: 15.4,
  mineralization_intensity: 0.85,
  estimated_reserves: 620,
  average_grade: 1.85
}

export async function fetchOrebodies() {
  return safeRequest(() => client.get('/geology/orebodies'), FALLBACK_OREBODIES)
}

export async function fetchGeologyStats() {
  return safeRequest(() => client.get('/geology/stats'), FALLBACK_STATS)
}

export async function fetchFullGeologyData() {
  return safeRequest(
    () => client.get('/geology/full'),
    { orebodies: FALLBACK_OREBODIES, stats: FALLBACK_STATS }
  )
}
