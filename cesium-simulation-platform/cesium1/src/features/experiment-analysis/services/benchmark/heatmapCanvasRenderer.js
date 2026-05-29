// 16 级应力科学色带（与 GPU 端 STRESS_TURBO_RAMP_16 一致）
const COLORMAP_STRESS_16 = [
  [18, 59, 122],  // #123b7a 零应力基底
  [25, 90, 153],  // #195a99 极低应力
  [33, 120, 183], // #2178b7 低应力
  [42, 150, 207], // #2a96cf 中低应力
  [55, 176, 216], // #37b0d8 中等偏下
  [74, 196, 207], // #4ac4cf 中等应力
  [95, 206, 184], // #5fceb8 中等偏上
  [113, 209, 151], // #71d197 轻微集中
  [136, 205, 111], // #88cd6f 应力集中
  [175, 197, 77], // #afc54d 弱岩爆倾向
  [219, 186, 65], // #dbba41 黄色预警
  [244, 163, 58], // #f4a33a 橙色报警
  [251, 125, 49], // #fb7d31 红色危险
  [245, 82, 40],  // #f55228 严重危险
  [221, 49, 32],  // #dd3120 极限破坏
  [152, 24, 26]   // #98181a 已损毁区
]

// 发散色带 —— 差值对比用（蓝→白→红）
const COLORMAP_DIVERGING = [
  [33, 102, 172],  // 远低于 #2166ac
  [103, 169, 207], // 低于   #67a9cf
  [209, 229, 240], // 近低   #d1e5f0
  [247, 247, 247], // 中性   #f7f7f7
  [253, 219, 199], // 近高   #fddbc7
  [244, 165, 130], // 高于   #f4a582
  [239, 138, 98],  // 偏高   #ef8a62
  [232, 91, 38],   // 超阈值 #e85b26
  [215, 25, 28],   // 报警   #d7191c
  [165, 0, 38]     // 危险   #a50026
]

// 保持旧名兼容
const COLORMAP_JET = COLORMAP_STRESS_16
const COLORMAP_COOLWARM = COLORMAP_DIVERGING

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
    colormap = COLORMAP_STRESS_16,
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
