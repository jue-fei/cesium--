import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自原 models.json）----
const FALLBACK_MODELS = [
  { id: 1, name: 'demo1 配置', path: '/3d/demo1/feature.json', sort_order: 1 },
  { id: 2, name: 'demo2 配置', path: '/3d/demo2/features.json', sort_order: 2 },
  { id: 3, name: 'demo3 配置', path: '/3d/demo3/feature.json', sort_order: 3 },
  { id: 4, name: 'demo4 配置', path: '/3d/demo4/feature.json', sort_order: 4 }
]

export async function fetchModelConfigs() {
  return safeRequest(() => client.get('/models'), FALLBACK_MODELS)
}

export async function fetchModelFeatures(modelConfigId) {
  return safeRequest(
    () => client.get(`/models/${modelConfigId}/features`),
    null
  )
}

export async function fetchAllModelFeatures() {
  return safeRequest(
    () => client.get('/models/features/all'),
    { modelMappings: [], globalProperties: {} }
  )
}
