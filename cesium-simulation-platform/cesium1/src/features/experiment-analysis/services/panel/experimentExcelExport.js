import { METHOD_LABELS, METRIC_LABELS, METRIC_UNITS } from '../../types/experimentDefaults.js'
import { formatMetricValue, formatTimingMs } from '../benchmark/statisticsUtils.js'
const CHART_METRICS = [
  { key: 'rmse', title: 'RMSE 对比', lowerIsBetter: true },
  { key: 'mae', title: 'MAE 对比', lowerIsBetter: true },
  { key: 'r2', title: 'R² 对比', lowerIsBetter: false },
  { key: 'mape', title: 'MAPE 对比', lowerIsBetter: true }
]

function safeText(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function methodLabel(key, fallback) {
  return METHOD_LABELS[key] || fallback || key
}

function autoFitColumns(worksheet, minWidth = 12, maxWidth = 28) {
  worksheet.columns?.forEach(column => {
    let maxLength = minWidth
    column.eachCell?.({ includeEmpty: true }, cell => {
      const raw = cell.value
      const value =
        typeof raw === 'object' && raw?.richText
          ? raw.richText.map(item => item.text).join('')
          : safeText(raw, '')
      maxLength = Math.max(maxLength, value.length + 2)
    })
    column.width = Math.min(maxWidth, maxLength)
  })
}

function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2F5597' }
    }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9E1F2' } },
      left: { style: 'thin', color: { argb: 'FFD9E1F2' } },
      bottom: { style: 'thin', color: { argb: 'FFD9E1F2' } },
      right: { style: 'thin', color: { argb: 'FFD9E1F2' } }
    }
  })
}

function styleDataRows(worksheet, startRow, endRow) {
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
    const row = worksheet.getRow(rowIndex)
    row.eachCell(cell => {
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E5E5' } },
        left: { style: 'thin', color: { argb: 'FFE5E5E5' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E5E5' } },
        right: { style: 'thin', color: { argb: 'FFE5E5E5' } }
      }
    })
  }
}

function addSectionTitle(worksheet, rowIndex, title) {
  const cell = worksheet.getCell(`A${rowIndex}`)
  cell.value = title
  cell.font = { bold: true, size: 13, color: { argb: 'FF1F1F1F' } }
  worksheet.mergeCells(`A${rowIndex}:H${rowIndex}`)
  return rowIndex + 1
}

function createMetricChartSvg(rows, metricKey, title, lowerIsBetter) {
  const validRows = rows
    .map(row => ({
      label: methodLabel(row.key, row.method),
      value: safeNumber(row.metrics?.[metricKey])
    }))
    .filter(row => row.value !== null)

  if (!validRows.length) return null

  const width = 920
  const barHeight = 28
  const chartTop = 80
  const labelLeft = 180
  const valueRight = 110
  const chartWidth = width - labelLeft - valueRight - 48
  const height = chartTop + validRows.length * 52 + 42
  const bestValue = lowerIsBetter
    ? Math.min(...validRows.map(item => item.value))
    : Math.max(...validRows.map(item => item.value))
  const worstValue = lowerIsBetter
    ? Math.max(...validRows.map(item => item.value))
    : Math.min(...validRows.map(item => item.value))
  const maxMagnitude = Math.max(...validRows.map(item => Math.abs(item.value)), 1e-9)
  const unit = METRIC_UNITS[metricKey] || ''

  const bars = validRows
    .map((item, index) => {
      const y = chartTop + index * 52
      const ratio =
        metricKey === 'r2'
          ? Math.max(0, Math.min(1, item.value))
          : Math.abs(item.value) / maxMagnitude
      const barWidth = Math.max(8, chartWidth * ratio)
      const fill =
        item.value === bestValue ? '#2F9E44' : item.value === worstValue ? '#D94841' : '#4C6EF5'
      return `
        <text x="20" y="${y + 18}" font-size="16" fill="#1F2937">${escapeXml(item.label)}</text>
        <rect x="${labelLeft}" y="${y}" rx="6" ry="6" width="${chartWidth}" height="${barHeight}" fill="#E9EEF7" />
        <rect x="${labelLeft}" y="${y}" rx="6" ry="6" width="${barWidth}" height="${barHeight}" fill="${fill}" />
        <text x="${labelLeft + chartWidth + 16}" y="${y + 19}" font-size="16" fill="#111827">${escapeXml(
          formatMetricValue(item.value, unit)
        )}</text>
      `
    })
    .join('')

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <text x="20" y="34" font-size="24" font-weight="700" fill="#111827">${escapeXml(title)}</text>
      <text x="20" y="58" font-size="14" fill="#6B7280">绿色表示当前指标最优，红色表示当前指标最弱，蓝色表示其余方法。</text>
      ${bars}
    </svg>
  `
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function svgToPngDataUrl(svg, width, height) {
  return await new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas 上下文不可用')
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(image, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/png'))
      } catch (error) {
        URL.revokeObjectURL(url)
        reject(error)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图表渲染失败'))
    }
    image.src = url
  })
}

function buildOverviewRows(config, results) {
  const rows = []
  const summary = results?.comparison?.summary
  rows.push(['导出时间', new Date().toLocaleString()])
  rows.push(['最佳方法', safeText(summary?.bestMethod)])
  rows.push(['最佳 RMSE', formatMetricValue(summary?.bestRMSE, METRIC_UNITS.rmse)])
  rows.push(['最弱方法', safeText(summary?.worstMethod)])
  rows.push(['最弱 RMSE', formatMetricValue(summary?.worstRMSE, METRIC_UNITS.rmse)])
  rows.push(['方法数量', safeText(summary?.totalMethods)])
  rows.push(['训练集点数', safeText(results?.dataset?.trainCount)])
  rows.push(['测试集点数', safeText(results?.dataset?.testCount)])
  rows.push([
    '噪声水平',
    safeText(
      safeNumber(results?.dataset?.noiseLevel) !== null
        ? `${(results.dataset.noiseLevel * 100).toFixed(1)}%`
        : '-'
    )
  ])
  rows.push(['异常点数', safeText(results?.dataset?.anomalyCount)])
  rows.push(['随机种子', safeText(config?.dataGeneration?.seed)])
  rows.push(['重复实验轮次', safeText(results?.repeatCount || config?.comparison?.repeatCount)])
  return rows
}

function addOverviewSheet(workbook, config, results) {
  const worksheet = workbook.addWorksheet('概览')
  worksheet.getCell('A1').value = '插值实验导出概览'
  worksheet.getCell('A1').font = { bold: true, size: 16 }
  worksheet.mergeCells('A1:D1')

  let rowIndex = 3
  rowIndex = addSectionTitle(worksheet, rowIndex, '实验摘要')
  const rows = buildOverviewRows(config, results)
  for (const [label, value] of rows) {
    worksheet.addRow([label, value])
  }
  styleDataRows(worksheet, rowIndex, rowIndex + rows.length - 1)

  rowIndex = rowIndex + rows.length + 2
  rowIndex = addSectionTitle(worksheet, rowIndex, '实验配置')
  const configRows = [
    [
      '场尺寸',
      Array.isArray(config?.dataGeneration?.fieldSize)
        ? config.dataGeneration.fieldSize.join(' × ')
        : '-'
    ],
    ['采样点数', safeText(config?.dataGeneration?.pointCount)],
    ['测试比例', safeText(config?.dataGeneration?.testRatio)],
    ['噪声水平', safeText(config?.dataGeneration?.noiseLevel)],
    ['异常值数量', safeText(config?.dataGeneration?.anomalyCount)],
    ['异常值倍率', safeText(config?.dataGeneration?.anomalyMagnitude)],
    ['真值场类型', safeText(config?.dataGeneration?.trendType)],
    [
      'Kriging 模型',
      Array.isArray(config?.comparison?.krigingModels)
        ? config.comparison.krigingModels.join(', ')
        : '-'
    ],
    ['交叉验证折数', safeText(config?.comparison?.crossValidationFolds)],
    ['IDW 邻域策略', safeText(config?.comparison?.idwConfig?.neighborPolicy)],
    ['IDW 扇区数', safeText(config?.comparison?.idwConfig?.sectorCount)],
    ['PSO 优化', config?.comparison?.idwConfig?.optimizeParameters !== false ? '开启' : '关闭']
  ]
  for (const row of configRows) worksheet.addRow(row)
  styleDataRows(worksheet, rowIndex, rowIndex + configRows.length - 1)
  worksheet.columns = [{ width: 18 }, { width: 36 }, { width: 18 }, { width: 18 }]
  return worksheet
}

function addComparisonSheet(workbook, results) {
  const worksheet = workbook.addWorksheet('精度对比')
  const header = [
    '方法',
    'RMSE',
    'MAE',
    'R²',
    '最大误差',
    'MAPE',
    '总耗时',
    'PSO耗时',
    '预测耗时',
    '幂指数 p',
    '邻域数 k',
    '邻域策略',
    '扇区数'
  ]
  const headerRow = worksheet.addRow(header)
  styleHeaderRow(headerRow)

  const rows = results?.comparison?.rows || []
  for (const row of rows) {
    worksheet.addRow([
      methodLabel(row.key, row.method),
      safeNumber(row.metrics?.rmse),
      safeNumber(row.metrics?.mae),
      safeNumber(row.metrics?.r2),
      safeNumber(row.metrics?.maxError),
      safeNumber(row.metrics?.mape),
      formatTimingMs(row.timing?.totalMs),
      formatTimingMs(row.timing?.psoMs),
      formatTimingMs(row.timing?.predictionMs),
      safeNumber(row.params?.power),
      safeNumber(row.params?.neighborCount),
      safeText(row.params?.neighborPolicy),
      safeNumber(row.params?.sectorCount)
    ])
  }

  styleDataRows(worksheet, 2, rows.length + 1)
  autoFitColumns(worksheet)
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  return worksheet
}

function addStabilitySheet(workbook, results) {
  const worksheet = workbook.addWorksheet('稳定性')
  const headerRow = worksheet.addRow([
    '方法',
    'RMSE均值',
    'RMSE标准差',
    '变异系数 CV',
    'MAE均值',
    'R²均值',
    'MAPE均值',
    '重复轮次'
  ])
  styleHeaderRow(headerRow)

  const aggregation = results?.aggregation || {}
  const entries = Object.entries(aggregation)
  for (const [key, data] of entries) {
    const rmseMean = safeNumber(data?.metrics?.rmse?.mean)
    const rmseStd = safeNumber(data?.metrics?.rmse?.std)
    const cv =
      rmseMean !== null && rmseStd !== null && Math.abs(rmseMean) > 1e-9
        ? Math.abs(rmseStd / rmseMean) * 100
        : null
    worksheet.addRow([
      methodLabel(key, key),
      rmseMean,
      rmseStd,
      cv,
      safeNumber(data?.metrics?.mae?.mean),
      safeNumber(data?.metrics?.r2?.mean),
      safeNumber(data?.metrics?.mape?.mean),
      safeNumber(data?.repeatCount)
    ])
  }

  styleDataRows(worksheet, 2, entries.length + 1)
  autoFitColumns(worksheet)
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  return worksheet
}

async function addChartsSheet(workbook, results) {
  const worksheet = workbook.addWorksheet('图表')
  worksheet.getCell('A1').value = '实验图表'
  worksheet.getCell('A1').font = { bold: true, size: 16 }
  const rows = results?.comparison?.rows || []
  if (!rows.length) {
    worksheet.getCell('A3').value = '暂无可导出的图表数据'
    return worksheet
  }

  let imageIndex = 0
  for (const metric of CHART_METRICS) {
    const svg = createMetricChartSvg(
      rows,
      metric.key,
      `${METRIC_LABELS[metric.key]}对比`,
      metric.lowerIsBetter
    )
    if (!svg) continue
    const pngDataUrl = await svgToPngDataUrl(svg, 920, 320)
    const imageId = workbook.addImage({
      base64: pngDataUrl,
      extension: 'png'
    })
    const rowOffset = Math.floor(imageIndex / 1) * 18 + 3
    worksheet.addImage(imageId, {
      tl: { col: 0.2, row: rowOffset },
      ext: { width: 920, height: 320 }
    })
    imageIndex++
  }

  return worksheet
}

function addHeatmapSheet(workbook, results) {
  const worksheet = workbook.addWorksheet('热力图')
  worksheet.getCell('A1').value = '热力图与差值图'
  worksheet.getCell('A1').font = { bold: true, size: 16 }

  const images = results?.heatmap?.images || []
  let row = 3
  let col = 0
  for (const item of images) {
    if (!item?.dataURL) continue
    const imageId = workbook.addImage({
      base64: item.dataURL,
      extension: 'png'
    })
    worksheet.getCell(row, col + 1).value = item.label
    worksheet.getCell(row, col + 1).font = { bold: true }
    worksheet.addImage(imageId, {
      tl: { col: col + 0.2, row: row + 1 },
      ext: { width: 320, height: 250 }
    })
    col += 4
    if (col >= 8) {
      col = 0
      row += 18
    }
  }

  if (results?.heatmap?.diffImage?.dataURL) {
    row += col > 0 ? 18 : 0
    const imageId = workbook.addImage({
      base64: results.heatmap.diffImage.dataURL,
      extension: 'png'
    })
    worksheet.getCell(`A${row}`).value = results.heatmap.diffImage.label || '差值图'
    worksheet.getCell(`A${row}`).font = { bold: true }
    worksheet.addImage(imageId, {
      tl: { col: 0.2, row: row },
      ext: { width: 360, height: 280 }
    })
  }

  return worksheet
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export async function exportExperimentResultsToExcel({ config, results }) {
  if (!results) throw new Error('没有可导出的实验结果')

  const excelModule = await import('exceljs')
  const ExcelJS = excelModule.default || excelModule
  const Workbook = ExcelJS.Workbook || ExcelJS.default?.Workbook
  const workbook = new Workbook()
  workbook.creator = 'Trae'
  workbook.created = new Date()
  workbook.modified = new Date()

  addOverviewSheet(workbook, config, results)
  addComparisonSheet(workbook, results)
  addStabilitySheet(workbook, results)
  await addChartsSheet(workbook, results)
  addHeatmapSheet(workbook, results)

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  triggerDownload(blob, `interpolation-experiment-${Date.now()}.xlsx`)
}
