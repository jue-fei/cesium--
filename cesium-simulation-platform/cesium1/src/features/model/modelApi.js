export async function ensureResourceAvailable(path) {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return true
}

export async function fetchJsonOrNull(path) {
  try {
    const response = await fetch(path)
    if (!response.ok) return null
    return await response.json()
  } catch (e) {
    void e
    return null
  }
}

export async function discoverModelConfigs(maxScanLimit = 10) {
  const manifest = await fetchJsonOrNull('/3d/models.json')
  if (Array.isArray(manifest) && manifest.length > 0) {
    return manifest
  }

  const configs = []
  for (let i = 1; i <= maxScanLimit; i++) {
    const dirName = `demo${i}`
    const basePath = `/3d/${dirName}`
    const featureCandidates = ['feature.json', 'features.json']

    for (const fileName of featureCandidates) {
      const path = `${basePath}/${fileName}`
      const config = await fetchJsonOrNull(path)
      if (config) {
        configs.push({
          name: `${dirName} 配置`,
          path
        })
        break
      }
    }
  }

  return configs
}

export async function saveModelConfig(path, data) {
  const response = await fetch('/api/model-config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, data })
  })
  if (!response.ok) {
    return { success: false, message: '保存失败' }
  }
  const result = await response.json()
  if (!result?.success) {
    return { success: false, message: result?.message || '保存失败' }
  }
  return { success: true, message: '保存成功' }
}
