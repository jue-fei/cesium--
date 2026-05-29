import { clamp01 as clamp01Core } from '../services/core/shared/stressActionShared.js'
export { downloadText } from '../../../utils/download.js'

export function buildChartView(series, options) {
  const width = Number(options?.width) || 640
  const height = Number(options?.height) || 240
  const xMode = options?.xMode || 'time'
  const yMode = options?.yMode || 'value'
  const pad = { left: 68, right: 20, top: 24, bottom: 36 }
  const innerWidth = Math.max(1, width - pad.left - pad.right)
  const innerHeight = Math.max(1, height - pad.top - pad.bottom)
  const values = buildChartValues(series, xMode, yMode)
  const bounds = resolveChartBounds(values, yMode)
  const { xMin, xMax, yMin, yMax } = bounds
  const xDen = Math.max(1e-12, xMax - xMin)
  const yDen = Math.max(1e-12, yMax - yMin)
  const mapX = x => pad.left + ((x - xMin) / xDen) * innerWidth
  const mapY = y => pad.top + (1 - (y - yMin) / yDen) * innerHeight
  const points = values.map(p => ({ x: mapX(p.xVal), y: mapY(p.yVal) }))
  const linePath = buildPolylinePath(points)
  const xTicksRaw = buildTicks(xMin, xMax, xMode === 'frame' ? 6 : 7)
  const yTicksRaw = buildTicks(yMin, yMax, 6)
  const xTicks = xTicksRaw.map(v => ({
    x: mapX(v),
    label: formatAxisNumber(v, xMode === 'frame' ? 0 : 3)
  }))
  const yTicks = yTicksRaw.map(v => ({
    y: mapY(v),
    label: formatAxisNumber(v, yMode === 'normalized' ? 3 : 4)
  }))
  let axisPath = ''
  axisPath += `M ${pad.left} ${height - pad.bottom} L ${width - pad.right} ${height - pad.bottom}`
  axisPath += ` M ${pad.left} ${height - pad.bottom} L ${pad.left} ${pad.top}`
  let gridPath = ''
  for (const t of xTicks) gridPath += `M ${t.x} ${pad.top} L ${t.x} ${height - pad.bottom} `
  for (const t of yTicks) gridPath += `M ${pad.left} ${t.y} L ${width - pad.right} ${t.y} `
  return {
    width,
    height,
    linePath,
    axisPath,
    gridPath: gridPath.trim(),
    points,
    xTicks,
    yTicks
  }
}

function buildChartValues(series, xMode, yMode) {
  const hasData = Array.isArray(series) && series.length > 0
  if (!hasData) return []
  const baseValue = Number(series[0].v)
  const numericSeries = series.map(s => Number(s.v))
  const min = Math.min(...numericSeries)
  const max = Math.max(...numericSeries)
  const denNorm = Math.max(1e-12, max - min)
  const denDelta = Math.max(1e-12, Math.abs(baseValue))
  return series.map(p => {
    const xVal = xMode === 'frame' ? Number(p.frame) : Number(p.t)
    const raw = Number(p.v)
    if (yMode === 'normalized') return { xVal, yVal: (raw - min) / denNorm }
    if (yMode === 'delta_percent') return { xVal, yVal: ((raw - baseValue) / denDelta) * 100 }
    return { xVal, yVal: raw }
  })
}

function resolveChartBounds(values, yMode) {
  let xMin = Number.POSITIVE_INFINITY
  let xMax = Number.NEGATIVE_INFINITY
  let yMin = Number.POSITIVE_INFINITY
  let yMax = Number.NEGATIVE_INFINITY
  for (const p of values) {
    if (p.xVal < xMin) xMin = p.xVal
    if (p.xVal > xMax) xMax = p.xVal
    if (p.yVal < yMin) yMin = p.yVal
    if (p.yVal > yMax) yMax = p.yVal
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
    xMin = 0
    xMax = 1
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = 0
    yMax = 1
  }
  if (xMin === xMax) {
    xMin -= 0.5
    xMax += 0.5
  }
  if (yMode === 'normalized') {
    yMin = 0
    yMax = 1
  } else if (yMode === 'delta_percent') {
    yMin = Math.min(yMin, 0)
    yMax = Math.max(yMax, 0)
  }
  if (yMin === yMax) {
    const abs = Math.max(1e-6, Math.abs(yMin))
    yMin -= abs * 0.05
    yMax += abs * 0.05
  }
  return { xMin, xMax, yMin, yMax }
}

function buildPolylinePath(points) {
  if (!Array.isArray(points) || points.length === 0) return ''
  let d = ''
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    d += i === 0 ? `M ${p.x} ${p.y}` : ` L ${p.x} ${p.y}`
  }
  return d
}

function buildTicks(min, max, targetCount = 6) {
  const span = Math.max(1e-12, max - min)
  const roughStep = span / Math.max(2, targetCount - 1)
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const norm = roughStep / mag
  const stepNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  const step = stepNorm * mag
  const start = Math.ceil(min / step) * step
  const ticks = []
  for (let v = start; v <= max + step * 0.5; v += step) {
    ticks.push(Number(v.toPrecision(14)))
    if (ticks.length > 200) break
  }
  if (!ticks.length) {
    ticks.push(Number(min.toPrecision(14)))
    ticks.push(Number(max.toPrecision(14)))
  }
  return ticks
}

export function buildSvgContent(view, title, xLabel, yLabel) {
  const p = view?.linePath || ''
  if (!p) return ''
  const axis = view.axisPath || ''
  const grid = view.gridPath || ''
  const xTickText = (view.xTicks || [])
    .map(
      t =>
        `<text x="${t.x}" y="${view.height - 8}" font-size="11" text-anchor="middle" fill="rgba(255,255,255,0.66)">${escapeXml(t.label)}</text>`
    )
    .join('')
  const yTickText = (view.yTicks || [])
    .map(
      t =>
        `<text x="6" y="${t.y + 4}" font-size="11" fill="rgba(255,255,255,0.66)">${escapeXml(t.label)}</text>`
    )
    .join('')
  const pointText = (view.points || [])
    .map(point => `<circle cx="${point.x}" cy="${point.y}" r="2" fill="#b6ff66" />`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">
  <rect x="0" y="0" width="${view.width}" height="${view.height}" fill="#000" />
  <path d="${grid}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
  <path d="${axis}" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="1.2" />
  <path d="${p}" fill="none" stroke="#4caf50" stroke-width="2.2" />
  ${pointText}
  ${xTickText}
  ${yTickText}
  <text x="8" y="18" font-size="12" fill="rgba(255,255,255,0.68)">${escapeXml(title)}</text>
  <text x="${view.width - 8}" y="${view.height - 8}" font-size="11" text-anchor="end" fill="rgba(255,255,255,0.76)">${escapeXml(xLabel)}</text>
  <text x="10" y="30" font-size="11" fill="rgba(255,255,255,0.76)">${escapeXml(yLabel)}</text>
</svg>`
}

export async function exportChartPng(view, title, xLabel, yLabel, fileName) {
  const svg = buildSvgContent(view, title, xLabel, yLabel)
  if (!svg) return
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    const canvas = document.createElement('canvas')
    canvas.width = view.width
    canvas.height = view.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    await new Promise((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
      img.src = url
    })
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png', 1)
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = fileName
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function fetchText(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    return await res.text()
  } catch (e) {
    return ''
  }
}

export function safeInt(val, min, max) {
  const n = Math.round(Number(val))
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

export function formatNumber(val, digits = 3) {
  const n = Number(val)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

export function formatAxisNumber(val, maxDigits = 4) {
  const n = Number(val)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return n.toExponential(3)
  const digits = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 10 ? 3 : maxDigits
  return n.toFixed(digits)
}

export function formatScientific(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return '—'
  return n.toExponential(3)
}

export const clamp01 = clamp01Core

function escapeXml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
