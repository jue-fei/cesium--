import { downloadText } from '../../../../utils/download.js'

function safeNumber(val, fallback = 0) {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

function normalizeModel(model) {
  return {
    id: model.id || model.featureId || model.name || '',
    name: model.name || '',
    path: model.path || '',
    visible: model.visible !== false,
    opacity: safeNumber(model.opacity, 0),
    type: model.type || '3DTiles',
    category: model.category || '',
    position: model.position || null,
    transform: model.transform || null,
    properties: model.properties || model.styleProperties || null,
    geologyProperties: model.geologyProperties || null
  }
}

function normalizeMeasurement(item) {
  return {
    type: item.type || '',
    timestamp: item.timestamp || item.time || '',
    distance: item.distance ?? null,
    area: item.area ?? null,
    points: item.points || []
  }
}

function normalizeClippingPlane(plane) {
  return {
    index: plane.index ?? null,
    axis: plane.axis || 'X',
    direction: plane.direction || '正向',
    distance: plane.distance ?? 0,
    rotation: plane.rotation || { x: 0, y: 0, z: 0 },
    opacity: plane.opacity ?? 0,
    color: plane.color || '#ffffff'
  }
}

export async function exportSceneData(exportOptions, sceneData) {
  const {
    modelList,
    measurementHistory,
    coordinateSystem,
    clippingPlanes,
    geologyData,
    cameraView,
    viewer
  } = sceneData || {}

  const meta = {
    exportTime: new Date().toISOString(),
    exportVersion: '3.0',
    projectName: exportOptions?.projectName || '矿山3D场景',
    description: exportOptions?.description || ''
  }

  const payload = { metadata: meta }

  if (exportOptions?.includeBasicInfo !== false) {
    payload.sceneInfo = {
      coordinateSystem: coordinateSystem || 'wgs84',
      timestamp: new Date().toISOString()
    }
  }

  if (exportOptions?.includeModels && Array.isArray(modelList)) {
    payload.models = modelList.map(normalizeModel)
  }

  if (exportOptions?.includeMeasurements && Array.isArray(measurementHistory)) {
    payload.measurements = measurementHistory.map(normalizeMeasurement)
  }

  if (exportOptions?.includeClipping && Array.isArray(clippingPlanes)) {
    payload.clippingPlanes = clippingPlanes.map(normalizeClippingPlane)
  }

  if (exportOptions?.includeGeology && geologyData) {
    payload.geology = geologyData
  }

  if (exportOptions?.includeCameraView && viewer?.camera) {
    payload.camera = {
      position: viewer.camera.positionWC || viewer.camera.position,
      direction: viewer.camera.directionWC || viewer.camera.direction,
      up: viewer.camera.upWC || viewer.camera.up
    }
  } else if (exportOptions?.includeCameraView && cameraView) {
    payload.camera = cameraView
  }

  downloadText(JSON.stringify(payload, null, 2), 'scene-export.json', 'application/json')
}

export function exportReport(exportOptions, sceneData) {
  const { modelList, measurementHistory, clippingPlanes, geologyData } = sceneData || {}

  const name = exportOptions?.projectName || '矿山3D场景'
  const desc = exportOptions?.description || ''

  const modelCount = Array.isArray(modelList) ? modelList.length : 0
  const measureCount = Array.isArray(measurementHistory) ? measurementHistory.length : 0
  const clipCount = Array.isArray(clippingPlanes) ? clippingPlanes.length : 0
  const hasGeology = !!geologyData

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name} - 导出报告</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { color: #444; margin: 0 0 16px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
      th { background: #f6f6f6; }
      code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>${name} - 导出报告</h1>
    <p>${desc}</p>
    <table>
      <tr><th>导出时间</th><td>${new Date().toISOString()}</td></tr>
      <tr><th>模型数量</th><td>${modelCount}</td></tr>
      <tr><th>测量记录</th><td>${measureCount}</td></tr>
      <tr><th>切割平面</th><td>${clipCount}</td></tr>
      <tr><th>包含地质数据</th><td>${hasGeology ? '是' : '否'}</td></tr>
    </table>
    <p style="margin-top: 16px;">建议使用浏览器“打印”功能导出为 PDF。</p>
  </body>
</html>`

  const win = window.open('', '_blank')
  if (win) {
    win.document.write(html)
    win.document.close()
    win.focus()
  }
}

export function exportScreenshot(viewer, options = {}) {
  const sourceCanvas = viewer?.scene?.canvas || viewer?.canvas
  if (!sourceCanvas) {
    throw new Error('未找到渲染画布')
  }

  const format = options.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = safeNumber(options.quality, 1)

  try {
    const width = safeNumber(options.width, 0)
    const height = safeNumber(options.height, 0)

    let canvasForExport = sourceCanvas
    if (width > 0 && height > 0) {
      const target = document.createElement('canvas')
      target.width = width
      target.height = height
      const ctx = target.getContext('2d')
      if (!ctx) throw new Error('无法创建导出画布')
      ctx.drawImage(sourceCanvas, 0, 0, width, height)
      canvasForExport = target
    }

    const dataUrl = canvasForExport.toDataURL(`image/${format}`, quality)
    if (!dataUrl || dataUrl.length < 32) {
      throw new Error('截图数据为空')
    }

    const fileName = `scene-screenshot.${format}`
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = fileName
    link.click()
  } catch (e) {
    throw new Error(`截图导出失败（可能需要刷新页面或跨域资源限制）：${e?.message || e}`)
  }
}

export function exportMeasurementsCSV(measurementHistory) {
  if (!Array.isArray(measurementHistory)) return
  const header = ['type', 'timestamp', 'distance', 'area']
  const rows = [header.join(',')]
  for (const item of measurementHistory) {
    const r = normalizeMeasurement(item)
    rows.push([r.type, r.timestamp, r.distance ?? '', r.area ?? ''].join(','))
  }
  downloadText(rows.join('\n'), 'measurements.csv', 'text/csv')
}
