const COLORMAP_JET = [
  [0, 0, 143], // 深蓝
  [0, 0, 255],
  [0, 127, 255],
  [0, 255, 255], // 青色
  [0, 255, 127],
  [127, 255, 0], // 绿
  [255, 255, 0], // 黄
  [255, 127, 0], // 橙
  [255, 0, 0], // 红
  [143, 0, 0] // 深红
]

const COLORMAP_COOLWARM = [
  [59, 76, 192],
  [98, 130, 234],
  [141, 176, 254],
  [184, 208, 249],
  [220, 220, 220], // 中性白
  [245, 182, 164],
  [246, 122, 98],
  [221, 54, 38],
  [180, 12, 4],
  [128, 0, 38]
]

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

function sampleColormap(value, colormap, vmin, vmax) {
  const range = vmax - vmin
  if (range < 1e-12) {
    const mid = Math.floor(colormap.length / 2)
    return colormap[mid]
  }
  const t = Math.max(0, Math.min(1, (value - vmin) / range))
  const segCount = colormap.length - 1
  const segFloat = t * segCount
  const segIndex = Math.min(segCount - 1, Math.floor(segFloat))
  const segT = segFloat - segIndex
  return lerpColor(colormap[segIndex], colormap[segIndex + 1], segT)
}

export function renderHeatmapToCanvas(gridData, options = {}) {
  const {
    width = 300,
    height = 240,
    colormap = COLORMAP_JET,
    showColorBar = true,
    title = '',
    subtitle = '',
    zSliceLabel = '',
    vmin = null,
    vmax = null,
    bgColor = '#1a1d24',
    gridColor = 'rgba(255,255,255,0.04)',
    fontColor = '#a3a6ad',
    pixelRatio = 2
  } = options

  const { grid, values } = gridData
  const nx = grid.width
  const ny = grid.height

  const canvas = document.createElement('canvas')
  const cw = Math.round(width * pixelRatio)
  const ch = Math.round(height * pixelRatio)
  canvas.width = cw
  canvas.height = ch

  const ctx = canvas.getContext('2d')
  const headerH = title ? 44 * pixelRatio : 0
  const colorBarW = showColorBar ? 36 * pixelRatio : 0
  const footerH = subtitle ? 28 * pixelRatio : 0

  const plotX = 0
  const plotY = headerH
  const plotW = cw - colorBarW
  const plotH = ch - headerH - footerH

  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, cw, ch)

  if (title) {
    ctx.fillStyle = '#e5eaf3'
    ctx.font = `${13 * pixelRatio}px 'Segoe UI', sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(title, cw / 2, 26 * pixelRatio)
    if (zSliceLabel) {
      ctx.fillStyle = fontColor
      ctx.font = `${10 * pixelRatio}px 'Segoe UI', sans-serif`
      ctx.fillText(zSliceLabel, cw / 2, 42 * pixelRatio)
    }
  }

  if (subtitle) {
    ctx.fillStyle = fontColor
    ctx.font = `${10 * pixelRatio}px 'Segoe UI', sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(subtitle, cw / 2, ch - 8 * pixelRatio)
  }

  const validValues = []
  for (const v of values) {
    if (Number.isFinite(v)) validValues.push(v)
  }
  const minVal = vmin !== null ? vmin : Math.min(...validValues)
  const maxVal = vmax !== null ? vmax : Math.max(...validValues)

  const cellW = plotW / nx
  const cellH = plotH / ny
  const drawCellW = Math.max(2, Math.ceil(cellW))
  const drawCellH = Math.max(2, Math.ceil(cellH))

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i
      const val = values[idx]
      if (!Number.isFinite(val)) continue
      const color = sampleColormap(val, colormap, minVal, maxVal)

      const x = Math.round(plotX + i * cellW)
      const y = Math.round(plotY + j * cellH)
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`
      ctx.fillRect(x, y, drawCellW, drawCellH)
    }
  }

  if (gridColor !== 'none' && (drawCellW > 4 || drawCellH > 4)) {
    ctx.strokeStyle = gridColor
    ctx.lineWidth = 0.5
    for (let j = 0; j <= ny; j++) {
      const y = Math.round(plotY + j * cellH)
      ctx.beginPath()
      ctx.moveTo(plotX, y)
      ctx.lineTo(plotX + plotW, y)
      ctx.stroke()
    }
    for (let i = 0; i <= nx; i++) {
      const x = Math.round(plotX + i * cellW)
      ctx.beginPath()
      ctx.moveTo(x, plotY)
      ctx.lineTo(x, plotY + plotH)
      ctx.stroke()
    }
  }

  if (showColorBar) {
    const barX = plotX + plotW + 8 * pixelRatio
    const barW = 12 * pixelRatio
    const barH = plotH
    const barY = plotY

    const gradSteps = 64
    const stepH = barH / gradSteps
    for (let i = 0; i < gradSteps; i++) {
      const t = i / (gradSteps - 1)
      const v = minVal + (maxVal - minVal) * t
      const color = sampleColormap(v, colormap, minVal, maxVal)
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`
      ctx.fillRect(barX, barY + i * stepH, barW, Math.ceil(stepH))
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ctx.strokeRect(barX, barY, barW, barH)

    ctx.fillStyle = fontColor
    ctx.font = `${9 * pixelRatio}px 'Segoe UI', sans-serif`
    ctx.textAlign = 'left'

    const maxLabel =
      maxVal >= 100 ? maxVal.toFixed(1) : maxVal >= 1 ? maxVal.toFixed(2) : maxVal.toExponential(2)
    const minLabel =
      minVal >= 100 ? minVal.toFixed(1) : minVal >= 1 ? minVal.toFixed(2) : minVal.toExponential(2)

    ctx.fillText(maxLabel, barX + barW + 3 * pixelRatio, barY + 10 * pixelRatio)
    ctx.fillText(minLabel, barX + barW + 3 * pixelRatio, barY + barH - 3 * pixelRatio)
  }

  return canvas
}

export function renderDifferenceHeatmap(gridDataA, gridDataB, options = {}) {
  const { grid, values: valsA } = gridDataA
  const { values: valsB } = gridDataB
  const nx = grid.width
  const ny = grid.height

  const diffValues = new Float32Array(nx * ny)
  for (let i = 0; i < nx * ny; i++) {
    diffValues[i] = valsA[i] - valsB[i]
  }

  const diffGrid = { grid, values: diffValues }

  return renderHeatmapToCanvas(diffGrid, {
    ...options,
    colormap: COLORMAP_COOLWARM,
    title: options.title || '差值分布',
    subtitle: options.subtitle || '(方法A − 方法B)',
    showColorBar: true
  })
}

export function heatmapToDataURL(canvas) {
  return canvas.toDataURL('image/png')
}

export function createHeatmapPlaceholder(text, options = {}) {
  const {
    width = 260,
    height = 200,
    bgColor = '#1a1d24',
    fontColor = '#6b7280',
    pixelRatio = 2
  } = options

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * pixelRatio)
  canvas.height = Math.round(height * pixelRatio)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = fontColor
  ctx.font = `${11 * pixelRatio}px 'Segoe UI', sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)

  return canvas
}
