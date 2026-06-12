import { METHOD_LABELS, METRIC_LABELS, METRIC_UNITS } from '../../types/experimentDefaults.js'
import { formatMetricValue, formatTimingMs } from '../benchmark/statisticsUtils.js'

// ==================== 样式常量 ====================

const COLORS = {
  primaryDark: 'FF1F3864',
  primary: 'FF2F5597',
  primaryLight: 'FF4472C4',
  accent: 'FF5B9BD5',
  headerFont: 'FFFFFFFF',
  border: 'FFD9E1F2',
  borderLight: 'FFE5E5E5',
  bgTitle: 'FFF2F6FC',
  bgAltRow: 'FFF7F9FC',
  bgWhite: 'FFFFFFFF',
  textDark: 'FF1F1F1F',
  textBody: 'FF333333',
  textDim: 'FF666666',
  success: 'FF2FB344',
  danger: 'FFF56C6C',
  warning: 'FFE6A23C',
  anomalyBg: 'FFFFF2F2'
}

const FONTS = {
  title: { bold: true, size: 16, color: { argb: COLORS.textDark } },
  sectionTitle: { bold: true, size: 12, color: { argb: COLORS.primaryDark } },
  header: { bold: true, size: 10, color: { argb: COLORS.headerFont } },
  body: { size: 10, color: { argb: COLORS.textBody } },
  dim: { size: 9, color: { argb: COLORS.textDim } },
  bold: { bold: true, size: 10, color: { argb: COLORS.textDark } },
  success: { bold: true, size: 10, color: { argb: COLORS.success } },
  danger: { bold: true, size: 10, color: { argb: COLORS.danger } },
  link: { size: 10, color: { argb: COLORS.primaryLight }, underline: true }
}

const HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: COLORS.primary }
}

const HEADER_FILL_DARK = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: COLORS.primaryDark }
}

const CENTER = { vertical: 'middle', horizontal: 'center', wrapText: true }
const LEFT = { vertical: 'middle', horizontal: 'left', wrapText: true }
const RIGHT = { vertical: 'middle', horizontal: 'right' }

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: COLORS.borderLight } },
  bottom: { style: 'thin', color: { argb: COLORS.borderLight } },
  left: { style: 'thin', color: { argb: COLORS.borderLight } },
  right: { style: 'thin', color: { argb: COLORS.borderLight } }
}

const HEADER_BORDER = {
  top: { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'medium', color: { argb: COLORS.border } },
  left: { style: 'thin', color: { argb: COLORS.border } },
  right: { style: 'thin', color: { argb: COLORS.border } }
}

// ==================== 工具函数 ====================

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

// ==================== 样式应用函数 ====================

function applyHeaderStyle(row, dark = false) {
  row.eachCell(cell => {
    cell.font = FONTS.header
    cell.fill = dark ? HEADER_FILL_DARK : HEADER_FILL
    cell.alignment = CENTER
    cell.border = HEADER_BORDER
  })
}

function applyDataRowStyle(row, isAltRow = false, isAnomaly = false) {
  row.eachCell(cell => {
    cell.font = FONTS.body
    cell.alignment = CENTER
    cell.border = THIN_BORDER
    if (isAnomaly) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.anomalyBg } }
    } else if (isAltRow) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bgAltRow } }
    }
  })
}

function applyTitleCell(cell, fontSize = 16) {
  cell.font = { bold: true, size: fontSize, color: { argb: COLORS.textDark } }
  cell.alignment = { vertical: 'middle', horizontal: 'left' }
}

function applySectionCell(cell) {
  cell.font = FONTS.sectionTitle
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bgTitle } }
  cell.alignment = LEFT
  cell.border = {
    bottom: { style: 'thin', color: { argb: COLORS.primaryLight } }
  }
}

function formatNumberCell(cell, value, decimals = 4) {
  if (!Number.isFinite(value)) {
    cell.value = '-'
    cell.font = FONTS.dim
    return
  }
  cell.value = Number(value.toFixed(decimals))
  cell.numFmt = '0.' + '0'.repeat(decimals)
}

function autoFitColumns(worksheet, minWidth = 10, maxWidth = 32) {
  worksheet.columns?.forEach(column => {
    let maxLength = minWidth
    column.eachCell?.({ includeEmpty: true }, cell => {
      const raw = cell.value
      const text =
        typeof raw === 'object' && raw?.richText
          ? raw.richText.map(item => item.text).join('')
          : safeText(raw, '')
      maxLength = Math.max(maxLength, Math.min(maxWidth, text.length + 2))
    })
    column.width = maxLength
  })
}

// ==================== Sheet 1: 实验概览 ====================

function addOverviewSheet(workbook, config, results) {
  const ws = workbook.addWorksheet('实验概览')

  // 标题
  ws.mergeCells('A1:F1')
  const titleCell = ws.getCell('A1')
  titleCell.value = '插值方法对比实验 — 导出报告'
  applyTitleCell(titleCell, 16)
  ws.getRow(1).height = 32

  ws.mergeCells('A2:F2')
  ws.getCell('A2').value = `导出时间：${new Date().toLocaleString()}`
  ws.getCell('A2').font = FONTS.dim

  // === 实验摘要 ===
  let r = 4
  ws.mergeCells(`A${r}:F${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎实验摘要'
  ws.getRow(r).height = 22
  r++

  const summary = results?.comparison?.summary
  const summaryData = [
    ['最佳插值方法', safeText(summary?.bestMethod)],
    ['最佳 RMSE', formatMetricValue(summary?.bestRMSE, METRIC_UNITS.rmse)],
    ['最弱插值方法', safeText(summary?.worstMethod)],
    ['最弱 RMSE', formatMetricValue(summary?.worstRMSE, METRIC_UNITS.rmse)],
    ['对比方法总数', safeText(summary?.totalMethods)],
    ['训练集点数', safeText(results?.dataset?.trainCount)],
    ['测试集点数', safeText(results?.dataset?.testCount)],
    [
      '噪声水平',
      safeNumber(results?.dataset?.noiseLevel) !== null
        ? `${(results.dataset.noiseLevel * 100).toFixed(1)}%`
        : '-'
    ],
    ['异常点数量', safeText(results?.dataset?.anomalyCount)],
    ['异常值倍率', safeText(results?.dataset?.anomalyMagnitude)],
    [
      '应力场类型',
      results?.dataset?.trendType === 'gradient_peak' ? '梯度+峰值复合场' : '高斯混合峰值场'
    ],
    ['随机种子', safeText(results?.dataset?.seed || config?.dataGeneration?.seed)],
    ['重复实验轮次', safeText(results?.repeatCount || config?.comparison?.repeatCount)]
  ]

  summaryData.forEach(([label, value], i) => {
    const row = ws.getRow(r)
    ws.getCell(`A${r}`).value = label
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.getCell(`A${r}`).alignment = RIGHT
    ws.getCell(`B${r}`).value = String(value)
    ws.getCell(`B${r}`).font = FONTS.body
    ws.mergeCells(`B${r}:F${r}`)
    if (i % 2 === 1) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bgAltRow } }
      })
    }
    r++
  })

  // === 实验参数配置 ===
  r += 1
  ws.mergeCells(`A${r}:F${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎实验参数配置'
  ws.getRow(r).height = 22
  r++

  const paramHeader = ws.getRow(r)
  ws.getCell(`A${r}`).value = '参数分类'
  ws.getCell(`B${r}`).value = '参数名称'
  ws.getCell(`C${r}`).value = '设定值'
  ws.getCell(`D${r}`).value = '说明'
  ws.mergeCells(`D${r}:F${r}`)
  applyHeaderStyle(paramHeader)
  r++

  const dg = config?.dataGeneration || {}
  const cm = config?.comparison || {}
  const idwCfg = cm?.idwConfig || {}

  const paramRows = [
    [
      '数据生成',
      '场尺寸',
      Array.isArray(dg.fieldSize) ? dg.fieldSize.join(' × ') + ' m' : '-',
      '三维应力场空间范围'
    ],
    ['数据生成', '采样点数', safeText(dg.pointCount), '合成数据集的采样点总数'],
    ['数据生成', '测试比例', safeText(dg.testRatio), '测试集占总数据的比例'],
    ['数据生成', '噪声水平', safeText(dg.noiseLevel), '高斯噪声标准差占比'],
    ['数据生成', '异常值数量', safeText(dg.anomalyCount), '额外注入的异常点数量'],
    ['数据生成', '异常值倍率', safeText(dg.anomalyMagnitude), '异常点值为真值的倍数'],
    [
      '数据生成',
      '真值场类型',
      dg.trendType === 'gradient_peak' ? '梯度+峰值复合场' : '高斯混合峰值场',
      '合成应力场数学模型'
    ],
    ['数据生成', '随机种子', safeText(dg.seed), '固定种子保证可复现性'],
    [
      '插值配置',
      'Kriging 模型',
      Array.isArray(cm.krigingModels) ? cm.krigingModels.join(', ') : '-',
      '变异函数模型类型'
    ],
    ['插值配置', '网格分辨率', safeText(cm.gridResolution), '热力图网格密度'],
    ['插值配置', '交叉验证折数', safeText(cm.crossValidationFolds), 'PSO适应度评估折数'],
    [
      'IDW配置',
      'PSO优化',
      idwCfg.optimizeParameters !== false ? '开启' : '关闭',
      '粒子群优化自动搜索最优参数'
    ],
    ['IDW配置', '邻域策略', safeText(idwCfg.neighborPolicy), 'sector=扇区搜索 | nearest=最近邻'],
    ['IDW配置', '扇区数', safeText(idwCfg.sectorCount), '扇区搜索的扇区划分数量'],
    ['实验控制', '重复轮次', safeText(cm.repeatCount), '重复实验的轮次数']
  ]

  paramRows.forEach((row, i) => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = row[0]
    ws.getCell(`B${r}`).value = row[1]
    ws.getCell(`C${r}`).value = String(row[2])
    ws.getCell(`D${r}`).value = row[3]
    applyDataRowStyle(excelRow, i % 2 === 1)
    ws.getCell(`A${r}`).font = FONTS.bold
    r++
  })

  // === 评估指标说明 ===
  r += 1
  ws.mergeCells(`A${r}:F${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎评估指标说明'
  ws.getRow(r).height = 22
  r++

  const metricHeader = ws.getRow(r)
  ws.getCell(`A${r}`).value = '指标'
  ws.getCell(`B${r}`).value = '全称'
  ws.getCell(`C${r}`).value = '单位'
  ws.getCell(`D${r}`).value = '说明'
  ws.mergeCells(`D${r}:F${r}`)
  applyHeaderStyle(metricHeader)
  r++

  const metricInfo = [
    ['RMSE', '均方根误差', 'MPa', '误差平方均值的平方根，核心精度指标，越小越好'],
    ['MAE', '平均绝对误差', 'MPa', '误差绝对值的均值，反映平均偏差大小'],
    ['R²', '决定系数', '—', '插值对真实值变异性的解释程度，越接近1越好'],
    ['MaxError', '最大误差', 'MPa', '所有测试点中偏差的最大值，反映最坏情况'],
    ['MAPE', '平均绝对百分比误差', '%', '相对误差的均值百分比，便于跨尺度对比']
  ]

  metricInfo.forEach((row, i) => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = row[0]
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.getCell(`B${r}`).value = row[1]
    ws.getCell(`C${r}`).value = row[2]
    ws.getCell(`D${r}`).value = row[3]
    applyDataRowStyle(excelRow, i % 2 === 1)
    r++
  })

  ws.columns = [
    { width: 14 },
    { width: 18 },
    { width: 20 },
    { width: 22 },
    { width: 22 },
    { width: 22 }
  ]
  ws.views = [{ state: 'frozen', ySplit: 4 }]
  return ws
}

// ==================== Sheet 2: 训练数据明细 ====================

function addTrainingDataSheet(workbook, results) {
  const ws = workbook.addWorksheet('训练数据')

  const ds = results?.dataset
  if (!ds?.trainPoints?.length) {
    ws.getCell('A1').value = '无训练数据'
    return ws
  }

  // 标题
  ws.mergeCells('A1:H1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '训练数据集明细'
  ws.getRow(1).height = 28

  ws.mergeCells('A2:H2')
  ws.getCell('A2').value =
    `共 ${ds.trainCount} 个训练点 | 含噪声观测值 | 异常值倍率：${ds.anomalyMagnitude || '-'} | 噪声水平：${(ds.noiseLevel * 100).toFixed(1)}%`
  ws.getCell('A2').font = FONTS.dim

  // 统计摘要
  let r = 4
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎数据统计摘要'
  ws.getRow(r).height = 22
  r++

  const trainVals = ds.trainValues.map(Number).filter(Number.isFinite)
  const trainTrueVals = ds.trainTrueValues.map(Number).filter(Number.isFinite)
  const anomalyCount = ds.trainAnomaly?.filter(Boolean).length || 0

  function calcStats(arr) {
    if (!arr.length) return { min: '-', max: '-', mean: '-', std: '-' }
    let min = Infinity,
      max = -Infinity,
      sum = 0
    for (const v of arr) {
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    const mean = sum / arr.length
    let sq = 0
    for (const v of arr) sq += (v - mean) ** 2
    return {
      min: min.toFixed(4),
      max: max.toFixed(4),
      mean: mean.toFixed(4),
      std: Math.sqrt(sq / arr.length).toFixed(4)
    }
  }

  const obsStats = calcStats(trainVals)
  const trueStats = calcStats(trainTrueVals)

  const statsData = [
    ['数据点数', String(trainVals.length), '异常点数', String(anomalyCount)],
    ['观测值最小值', obsStats.min + ' MPa', '观测值最大值', obsStats.max + ' MPa'],
    ['观测值均值', obsStats.mean + ' MPa', '观测值标准差', obsStats.std + ' MPa'],
    ['真值最小值', trueStats.min + ' MPa', '真值最大值', trueStats.max + ' MPa'],
    ['真值均值', trueStats.mean + ' MPa', '真值标准差', trueStats.std + ' MPa']
  ]

  statsData.forEach(row => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = row[0]
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.getCell(`A${r}`).alignment = RIGHT
    ws.getCell(`B${r}`).value = row[1]
    ws.mergeCells(`B${r}:C${r}`)
    ws.getCell(`D${r}`).value = row[2]
    ws.getCell(`D${r}`).font = FONTS.bold
    ws.getCell(`D${r}`).alignment = RIGHT
    ws.getCell(`E${r}`).value = row[3]
    ws.mergeCells(`E${r}:H${r}`)
    applyDataRowStyle(excelRow, r % 2 === 0)
    r++
  })

  // 数据表
  r += 1
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎训练点坐标与观测值（含异常点标记）'
  ws.getRow(r).height = 22
  r++

  const headerRow = ws.getRow(r)
  const headers = [
    '序号',
    'X (m)',
    'Y (m)',
    'Z (m)',
    '真值 (MPa)',
    '观测值 (MPa)',
    '噪声偏差',
    '异常标记'
  ]
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  ws.getRow(r).height = 20
  r++

  for (let i = 0; i < ds.trainPoints.length; i++) {
    const excelRow = ws.getRow(r)
    const p = ds.trainPoints[i]
    const trueVal = Number(ds.trainTrueValues[i])
    const obsVal = Number(ds.trainValues[i])
    const isAnomaly = ds.trainAnomaly?.[i] || false
    const noiseDelta = Number.isFinite(trueVal) ? obsVal - trueVal : 0

    formatNumberCell(ws.getCell(r, 1), i + 1, 0)
    formatNumberCell(ws.getCell(r, 2), Number(p?.x) || 0, 2)
    formatNumberCell(ws.getCell(r, 3), Number(p?.y) || 0, 2)
    formatNumberCell(ws.getCell(r, 4), Number(p?.z) || 0, 2)
    formatNumberCell(ws.getCell(r, 5), trueVal, 4)
    formatNumberCell(ws.getCell(r, 6), obsVal, 4)
    formatNumberCell(ws.getCell(r, 7), noiseDelta, 4)

    const tagCell = ws.getCell(r, 8)
    tagCell.value = isAnomaly ? '异常点' : '正常'
    tagCell.font = isAnomaly ? FONTS.danger : FONTS.success
    tagCell.alignment = CENTER

    applyDataRowStyle(excelRow, i % 2 === 1, isAnomaly)
    r++
  }

  ws.columns = [
    { width: 8 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
    { width: 14 },
    { width: 12 }
  ]
  ws.views = [{ state: 'frozen', ySplit: 8 }]
  return ws
}

// ==================== Sheet 3: 测试数据明细 ====================

function addTestDataSheet(workbook, results) {
  const ws = workbook.addWorksheet('测试数据')

  const ds = results?.dataset
  if (!ds?.testPoints?.length) {
    ws.getCell('A1').value = '无测试数据'
    return ws
  }

  // 标题
  ws.mergeCells('A1:G1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '测试数据集明细'
  ws.getRow(1).height = 28

  ws.mergeCells('A2:G2')
  ws.getCell('A2').value = `共 ${ds.testCount} 个测试点 | 真实场真值（不含噪声）`
  ws.getCell('A2').font = FONTS.dim

  let r = 4
  ws.mergeCells(`A${r}:G${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎数据统计摘要'
  ws.getRow(r).height = 22
  r++

  const testVals = ds.testTrueValues.map(Number).filter(Number.isFinite)
  const anomalyCount = ds.testAnomaly?.filter(Boolean).length || 0

  function calcStats(arr) {
    if (!arr.length) return { min: '-', max: '-', mean: '-', std: '-' }
    let min = Infinity,
      max = -Infinity,
      sum = 0
    for (const v of arr) {
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    const mean = sum / arr.length
    let sq = 0
    for (const v of arr) sq += (v - mean) ** 2
    return {
      min: min.toFixed(4),
      max: max.toFixed(4),
      mean: mean.toFixed(4),
      std: Math.sqrt(sq / arr.length).toFixed(4)
    }
  }

  const stats = calcStats(testVals)
  const statsData = [
    ['数据点数', String(testVals.length), '异常点数', String(anomalyCount)],
    ['真值最小值', stats.min + ' MPa', '真值最大值', stats.max + ' MPa'],
    ['真值均值', stats.mean + ' MPa', '真值标准差', stats.std + ' MPa']
  ]

  statsData.forEach(row => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = row[0]
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.getCell(`A${r}`).alignment = RIGHT
    ws.getCell(`B${r}`).value = row[1]
    ws.mergeCells(`B${r}:C${r}`)
    ws.getCell(`D${r}`).value = row[2]
    ws.getCell(`D${r}`).font = FONTS.bold
    ws.getCell(`D${r}`).alignment = RIGHT
    ws.getCell(`E${r}`).value = row[3]
    ws.mergeCells(`E${r}:G${r}`)
    applyDataRowStyle(excelRow, r % 2 === 0)
    r++
  })

  // 数据表
  r += 1
  ws.mergeCells(`A${r}:G${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎测试点坐标与真值（含异常点标记）'
  ws.getRow(r).height = 22
  r++

  const headerRow = ws.getRow(r)
  const headers = ['序号', 'X (m)', 'Y (m)', 'Z (m)', '真值 (MPa)', '异常标记', '备注']
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  ws.getRow(r).height = 20
  r++

  for (let i = 0; i < ds.testPoints.length; i++) {
    const excelRow = ws.getRow(r)
    const p = ds.testPoints[i]
    const trueVal = Number(ds.testTrueValues[i])
    const isAnomaly = ds.testAnomaly?.[i] || false

    formatNumberCell(ws.getCell(r, 1), i + 1, 0)
    formatNumberCell(ws.getCell(r, 2), Number(p?.x) || 0, 2)
    formatNumberCell(ws.getCell(r, 3), Number(p?.y) || 0, 2)
    formatNumberCell(ws.getCell(r, 4), Number(p?.z) || 0, 2)
    formatNumberCell(ws.getCell(r, 5), trueVal, 4)

    const tagCell = ws.getCell(r, 6)
    tagCell.value = isAnomaly ? '异常点' : '正常'
    tagCell.font = isAnomaly ? FONTS.danger : FONTS.success
    tagCell.alignment = CENTER

    ws.getCell(r, 7).value = isAnomaly ? '该点由异常生成器产生，真值已被放大' : ''

    applyDataRowStyle(excelRow, i % 2 === 1, isAnomaly)
    r++
  }

  ws.columns = [
    { width: 8 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 12 },
    { width: 28 }
  ]
  ws.views = [{ state: 'frozen', ySplit: 8 }]
  return ws
}

// ==================== Sheet 4: 精度对比 ====================

function addComparisonSheet(workbook, results) {
  const ws = workbook.addWorksheet('精度对比')

  ws.mergeCells('A1:M1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '插值方法精度对比'
  ws.getRow(1).height = 28

  const rows = results?.comparison?.rows || []
  if (!rows.length) {
    ws.getCell('A3').value = '暂无比对数据'
    return ws
  }

  // 结论摘要
  let r = 3
  if (results?.comparison?.summary) {
    const s = results.comparison.summary
    ws.mergeCells(`A${r}:M${r}`)
    ws.getCell(`A${r}`).value =
      `结论：最佳方法 = ${s.bestMethod} (RMSE=${formatMetricValue(s.bestRMSE, 'MPa')}) | 最弱方法 = ${s.worstMethod} (RMSE=${formatMetricValue(s.worstRMSE, 'MPa')})`
    ws.getCell(`A${r}`).font = { bold: true, size: 11, color: { argb: COLORS.primaryDark } }
    ws.getRow(r).height = 22
    r += 2
  }

  // 表头
  const headerRow = ws.getRow(r)
  const headers = [
    '插值方法',
    'RMSE (MPa)',
    'MAE (MPa)',
    'R²',
    '最大误差 (MPa)',
    'MAPE (%)',
    '总耗时',
    'PSO耗时',
    '预测耗时',
    '幂指数 p',
    '邻域数 k',
    '邻域策略',
    '扇区数'
  ]
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow, true)
  ws.getRow(r).height = 22
  r++

  // 数据行
  rows.forEach((row, idx) => {
    const excelRow = ws.getRow(r)
    ws.getCell(r, 1).value = methodLabel(row.key, row.method)

    // 指标值
    const metricKeys = ['rmse', 'mae', 'r2', 'maxError', 'mape']
    metricKeys.forEach((key, ci) => {
      const val = Number(row.metrics?.[key])
      if (!Number.isFinite(val)) {
        ws.getCell(r, ci + 2).value = 'N/A'
        ws.getCell(r, ci + 2).font = FONTS.dim
      } else {
        formatNumberCell(ws.getCell(r, ci + 2), val, key === 'r2' ? 4 : key === 'mape' ? 2 : 3)
      }
    })

    // 耗时
    ws.getCell(r, 7).value = formatTimingMs(row.timing?.totalMs)
    ws.getCell(r, 8).value = formatTimingMs(row.timing?.psoMs)
    ws.getCell(r, 9).value = formatTimingMs(row.timing?.predictionMs)

    // 参数
    ws.getCell(r, 10).value =
      safeNumber(row.params?.power) !== null ? Number(row.params.power.toFixed(3)) : '-'
    ws.getCell(r, 11).value = safeText(row.params?.neighborCount)
    ws.getCell(r, 12).value = safeText(row.params?.neighborPolicy)
    ws.getCell(r, 13).value = safeText(row.params?.sectorCount)

    // RMSE 最佳高亮
    if (
      row.key === results?.comparison?.summary?.bestMethod ||
      (row.metrics?.rmse !== undefined &&
        row.metrics?.rmse === Math.min(...rows.map(r => r.metrics?.rmse || Infinity)))
    ) {
      ws.getCell(r, 1).font = FONTS.success
      ws.getCell(r, 2).font = FONTS.success
    }

    applyDataRowStyle(excelRow, idx % 2 === 1)
    r++
  })

  autoFitColumns(ws, 12, 26)
  ws.views = [{ state: 'frozen', ySplit: 5 }]
  return ws
}

// ==================== Sheet 5: 插值预测结果 ====================

function addPredictionSheet(workbook, results) {
  const ws = workbook.addWorksheet('插值预测')

  ws.mergeCells('A1:K1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '各方法插值预测结果明细'
  ws.getRow(1).height = 28

  const ds = results?.dataset
  const compRows = results?.comparison?.rows || []
  if (!ds?.testPoints?.length) {
    ws.getCell('A3').value = '无测试数据'
    return ws
  }

  ws.mergeCells('A2:K2')
  ws.getCell('A2').value = `对每个测试点列出真值及各方法的预测值，共 ${ds.testCount} 个测试点`
  ws.getCell('A2').font = FONTS.dim

  let r = 4

  // 动态构建表头
  const headers = ['序号', 'X (m)', 'Y (m)', 'Z (m)', '真值 (MPa)']
  // 为每个方法添加一列预测值
  const methodCols = compRows.map(row => ({
    key: row.key,
    label: methodLabel(row.key, row.method)
  }))
  // 添加误差列（以第一个方法的预测值为例）
  methodCols.forEach(m => {
    headers.push(m.label + ' (MPa)')
  })
  headers.push('最优方法预测')

  const headerRow = ws.getRow(r)
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  ws.getRow(r).height = 22
  r++

  // 需要从 kriging 结果中提取预测值
  const krResults = results?.kriging || {}
  const methodPreds = {}
  for (const row of compRows) {
    if (row.key === 'idw_optimized') {
      methodPreds[row.key] = results?.idw?.predictions || []
    } else if (row.key === 'idw_default') {
      methodPreds[row.key] = results?.idwDefault?.predictions || []
    } else if (row.key.startsWith('kriging_')) {
      const modelName = row.key.replace('kriging_', '')
      const krData = krResults[modelName]
      methodPreds[row.key] = krData?.predictions || []
    }
  }

  // 找出每行最优方法
  function bestMethodForRow(i) {
    let bestKey = null
    let bestDiff = Infinity
    const truth = Number(ds.testTrueValues[i])
    if (!Number.isFinite(truth)) return null

    for (const row of compRows) {
      const preds = methodPreds[row.key]
      if (!preds || i >= preds.length) continue
      const pred = Number(preds[i])
      if (!Number.isFinite(pred)) continue
      const diff = Math.abs(pred - truth)
      if (diff < bestDiff) {
        bestDiff = diff
        bestKey = row.key
      }
    }
    return bestKey ? methodLabel(bestKey, bestKey) : null
  }

  for (let i = 0; i < ds.testPoints.length; i++) {
    const excelRow = ws.getRow(r)
    const p = ds.testPoints[i]
    const truth = Number(ds.testTrueValues[i])

    formatNumberCell(ws.getCell(r, 1), i + 1, 0)
    formatNumberCell(ws.getCell(r, 2), Number(p?.x) || 0, 2)
    formatNumberCell(ws.getCell(r, 3), Number(p?.y) || 0, 2)
    formatNumberCell(ws.getCell(r, 4), Number(p?.z) || 0, 2)
    formatNumberCell(ws.getCell(r, 5), truth, 4)

    let col = 6
    for (const row of compRows) {
      const preds = methodPreds[row.key]
      const pred = preds && i < preds.length ? Number(preds[i]) : NaN
      if (Number.isFinite(pred)) {
        formatNumberCell(ws.getCell(r, col), pred, 4)
      } else {
        ws.getCell(r, col).value = '-'
        ws.getCell(r, col).font = FONTS.dim
      }
      col++
    }

    // 最优方法
    ws.getCell(r, col).value = bestMethodForRow(i) || '-'

    applyDataRowStyle(excelRow, i % 2 === 1)
    r++
  }

  ws.columns = headers.map(() => ({ width: 16 }))
  ws.columns[0].width = 8
  ws.views = [{ state: 'frozen', ySplit: 4 }]
  return ws
}

// ==================== Sheet 6: 稳定性统计 ====================

function addStabilitySheet(workbook, results) {
  const ws = workbook.addWorksheet('稳定性统计')

  ws.mergeCells('A1:J1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '重复实验稳定性统计'
  ws.getRow(1).height = 28

  const aggregation = results?.aggregation
  if (!aggregation || !Object.keys(aggregation).length) {
    ws.getCell('A3').value = '未执行重复实验，无稳定性数据。建议使用"重复实验"按钮进行多轮实验。'
    ws.getCell('A3').font = FONTS.dim
    return ws
  }

  ws.mergeCells('A2:J2')
  ws.getCell('A2').value =
    `已完成 ${results.repeatCount || '-'} 轮重复实验 | 变异系数越低，方法越稳定`
  ws.getCell('A2').font = FONTS.dim

  let r = 4

  const headerRow = ws.getRow(r)
  const headers = [
    '插值方法',
    'RMSE均值',
    'RMSE标准差',
    '变异系数 CV',
    'MAE均值',
    'R²均值',
    'MAPE均值',
    'RMSE最小值',
    'RMSE最大值',
    '重复轮次'
  ]
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow, true)
  ws.getRow(r).height = 22
  r++

  const entries = Object.entries(aggregation)
  entries.forEach(([key, data], idx) => {
    const excelRow = ws.getRow(r)
    const rmseMean = safeNumber(data?.metrics?.rmse?.mean)
    const rmseStd = safeNumber(data?.metrics?.rmse?.std)
    const cv =
      rmseMean !== null && rmseStd !== null && Math.abs(rmseMean) > 1e-9
        ? Math.abs(rmseStd / rmseMean) * 100
        : null

    ws.getCell(r, 1).value = methodLabel(key, key)

    formatNumberCell(ws.getCell(r, 2), rmseMean, 3)
    formatNumberCell(ws.getCell(r, 3), rmseStd, 3)

    const cvCell = ws.getCell(r, 4)
    if (cv !== null) {
      cvCell.value = Number(cv.toFixed(2))
      cvCell.numFmt = '0.00"%"'
      if (cv <= 5) {
        cvCell.font = FONTS.success
      } else if (cv <= 15) {
        cvCell.font = { bold: true, size: 10, color: { argb: COLORS.warning } }
      } else {
        cvCell.font = FONTS.danger
      }
    } else {
      cvCell.value = '-'
      cvCell.font = FONTS.dim
    }

    formatNumberCell(ws.getCell(r, 5), safeNumber(data?.metrics?.mae?.mean), 3)
    formatNumberCell(ws.getCell(r, 6), safeNumber(data?.metrics?.r2?.mean), 4)
    formatNumberCell(ws.getCell(r, 7), safeNumber(data?.metrics?.mape?.mean), 2)
    formatNumberCell(ws.getCell(r, 8), safeNumber(data?.metrics?.rmse?.min), 3)
    formatNumberCell(ws.getCell(r, 9), safeNumber(data?.metrics?.rmse?.max), 3)
    ws.getCell(r, 10).value = safeNumber(data?.repeatCount) || '-'

    applyDataRowStyle(excelRow, idx % 2 === 1)
    r++
  })

  autoFitColumns(ws, 14, 22)
  ws.views = [{ state: 'frozen', ySplit: 4 }]
  return ws
}

// ==================== Sheet 7: PSO 优化详情 ====================

function addPSODetailSheet(workbook, results) {
  const ws = workbook.addWorksheet('PSO优化')

  ws.mergeCells('A1:D1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = 'PSO参数优化详情'
  ws.getRow(1).height = 28

  const optimalParams = results?.idw?.optimalParams
  if (!optimalParams) {
    ws.getCell('A3').value = '未启用 PSO 优化，或优化未收敛。'
    ws.getCell('A3').font = FONTS.dim
    return ws
  }

  // 优化参数
  let r = 3
  ws.mergeCells(`A${r}:D${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎最优参数'
  ws.getRow(r).height = 22
  r++

  const paramData = [
    [
      '最优幂指数 p',
      safeNumber(optimalParams.power) !== null ? optimalParams.power.toFixed(3) : '-',
      '控制距离衰减速度'
    ],
    ['最优邻域数 k', safeText(optimalParams.neighborCount), '参与插值的最近邻点数'],
    ['邻域策略', safeText(optimalParams.neighborPolicy), 'sector=扇区 | nearest=最近邻'],
    ['扇区数', safeText(optimalParams.sectorCount), '扇区搜索划分数量'],
    [
      '适应度值',
      safeNumber(optimalParams.fitness) !== null ? optimalParams.fitness.toFixed(4) : '-',
      '越低越好，综合 RMSE+Bias+Variance'
    ],
    ['PSO耗时', formatTimingMs(optimalParams.psoTimeMs), '粒子群优化计算耗时'],
    ['重启次数', safeText(optimalParams.restarts), '多起点 PSO 独立运行次数']
  ]

  paramData.forEach((row, i) => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = row[0]
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.getCell(`B${r}`).value = String(row[1])
    ws.getCell(`C${r}`).value = row[2]
    ws.getCell(`C${r}`).font = FONTS.dim
    applyDataRowStyle(excelRow, i % 2 === 1)
    r++
  })

  // 优化效果对比
  r += 1
  ws.mergeCells(`A${r}:D${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎优化效果对比'
  ws.getRow(r).height = 22
  r++

  const idwDefault = results?.idwDefault?.metrics
  const idwOptimized = results?.idw?.metrics

  if (idwDefault && idwOptimized) {
    const compareHeader = ws.getRow(r)
    ws.getCell(`A${r}`).value = '指标'
    ws.getCell(`B${r}`).value = 'IDW默认参数'
    ws.getCell(`C${r}`).value = 'IDW-PSO优化'
    ws.getCell(`D${r}`).value = '改善幅度'
    applyHeaderStyle(compareHeader)
    r++

    const metricsToCompare = ['rmse', 'mae', 'r2', 'maxError', 'mape']
    metricsToCompare.forEach((key, i) => {
      const excelRow = ws.getRow(r)
      const defVal = safeNumber(idwDefault[key])
      const optVal = safeNumber(idwOptimized[key])
      const label = METRIC_LABELS[key] || key

      ws.getCell(`A${r}`).value = label
      ws.getCell(`A${r}`).font = FONTS.bold
      formatNumberCell(ws.getCell(`B${r}`), defVal, 4)
      formatNumberCell(ws.getCell(`C${r}`), optVal, 4)

      const impCell = ws.getCell(`D${r}`)
      if (defVal !== null && optVal !== null && defVal !== 0) {
        const improvement = ((defVal - optVal) / Math.abs(defVal)) * 100
        const isBetter = key === 'r2' ? improvement < 0 : improvement > 0
        impCell.value = `${improvement >= 0 ? '↓' : '↑'}${Math.abs(improvement).toFixed(1)}%`
        impCell.font = isBetter ? FONTS.success : FONTS.danger
      } else {
        impCell.value = '-'
        impCell.font = FONTS.dim
      }

      applyDataRowStyle(excelRow, i % 2 === 1)
      r++
    })
  }

  ws.columns = [{ width: 20 }, { width: 18 }, { width: 18 }, { width: 18 }]
  return ws
}

// ==================== 各插值方法独立详情页 ====================

function getVariogramFormula(modelName, nugget, range, sill) {
  const C0 = nugget ?? 0
  const a = range ?? 0
  const C = (sill ?? 0) - C0
  if (modelName === 'gaussian') {
    return `γ(h) = ${C0.toFixed(4)} + ${C.toFixed(4)} × [1 - exp(-3×(h/${a.toFixed(2)})²)]`
  } else if (modelName === 'spherical') {
    return `γ(h) = ${C0.toFixed(4)} + ${C.toFixed(4)} × [1.5×(h/${a.toFixed(2)}) - 0.5×(h/${a.toFixed(2)})³]  (h < ${a.toFixed(2)})`
  }
  return `γ(h) = ${C0.toFixed(4)} + ${C.toFixed(4)} × [1 - exp(-3×h/${a.toFixed(2)})]`
}

function addMethodDetailSheet(workbook, methodKey, methodLabel, results) {
  const ws = workbook.addWorksheet(methodLabel)

  ws.mergeCells('A1:H1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = `${methodLabel} — 实验详情`
  ws.getRow(1).height = 32

  let r = 3

  // === 方法概述 ===
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎方法概述'
  ws.getRow(r).height = 22
  r++

  const methodDesc = {
    'IDW-PSO（PSO优化）':
      '反距离加权插值（IDW）配合粒子群优化（PSO）自动搜索最优幂指数和邻域参数。',
    'IDW（默认参数）': '反距离加权插值（IDW）使用默认参数（p=2, k=8）进行预测。',
    'Kriging（高斯模型）': '克里金插值使用高斯变异函数模型，适合空间相关性随距离缓慢衰减的场景。',
    'Kriging（指数模型）': '克里金插值使用指数变异函数模型，适合空间相关性随距离快速衰减的场景。',
    'Kriging（球状模型）': '克里金插值使用球状变异函数模型，适合有明确影响范围的地质现象。'
  }

  ws.mergeCells(`A${r}:H${r}`)
  ws.getCell(`A${r}`).value = methodDesc[methodLabel] || '插值方法详情'
  ws.getCell(`A${r}`).font = FONTS.body
  ws.getCell(`A${r}`).alignment = LEFT
  r += 2

  // === 精度指标 ===
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎精度指标'
  ws.getRow(r).height = 22
  r++

  const compRow = results?.comparison?.rows?.find(row => row.key === methodKey)
  if (compRow?.metrics) {
    const metrics = compRow.metrics
    const metricData = [
      ['RMSE（均方根误差）', formatMetricValue(metrics.rmse, 'MPa'), '核心精度指标，越小越好'],
      ['MAE（平均绝对误差）', formatMetricValue(metrics.mae, 'MPa'), '反映平均偏差大小'],
      ['R²（决定系数）', formatMetricValue(metrics.r2, ''), '越接近1越好'],
      ['最大误差', formatMetricValue(metrics.maxError, 'MPa'), '最坏情况偏差'],
      ['MAPE（平均绝对百分比误差）', formatMetricValue(metrics.mape, '%'), '相对误差百分比']
    ]
    metricData.forEach((rowData, i) => {
      const excelRow = ws.getRow(r)
      ws.getCell(`A${r}`).value = rowData[0]
      ws.getCell(`A${r}`).font = FONTS.bold
      ws.getCell(`B${r}`).value = rowData[1]
      ws.getCell(`B${r}`).font = FONTS.bold
      ws.mergeCells(`C${r}:H${r}`)
      ws.getCell(`C${r}`).value = rowData[2]
      ws.getCell(`C${r}`).font = FONTS.dim
      applyDataRowStyle(excelRow, i % 2 === 1)
      r++
    })
  } else {
    ws.mergeCells(`A${r}:H${r}`)
    ws.getCell(`A${r}`).value = '无指标数据'
    ws.getCell(`A${r}`).font = FONTS.dim
    r++
  }

  r += 1

  // === 模型参数 / 变异函数 ===
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎模型参数与函数表达式'
  ws.getRow(r).height = 22
  r++

  if (methodKey.startsWith('kriging_')) {
    const modelName = methodKey.replace('kriging_', '')
    const krData = results?.kriging?.[modelName]
    const model = krData?.model

    if (model) {
      const paramData = [
        [
          '变异函数模型',
          modelName === 'gaussian'
            ? '高斯模型'
            : modelName === 'spherical'
              ? '球状模型'
              : '指数模型'
        ],
        [
          '块金值 Nugget (C₀)',
          safeNumber(model.nugget)?.toFixed(6) ?? '-',
          '表示距离为0时的变异，反映随机误差和微观变异'
        ],
        [
          '变程 Range (a)',
          safeNumber(model.range)?.toFixed(2) ?? '-',
          '空间相关性的作用范围，超过此距离视为不相关'
        ],
        [
          '基台值 Sill (C₀+C)',
          safeNumber(model.sill)?.toFixed(4) ?? '-',
          '变异函数达到平稳时的值，反映总体变异程度'
        ],
        [
          '拱高 Partial Sill (C)',
          safeNumber(model.sill - model.nugget)?.toFixed(4) ?? '-',
          '基台值与块金值之差，反映空间自相关引起的变异'
        ],
        [
          '拟合误差',
          safeNumber(model.fitError)?.toFixed(6) ?? '-',
          '理论模型与经验变异函数的拟合残差'
        ],
        ['模型状态', model.status === 'ok' ? '正常' : model.status || '未知']
      ]

      paramData.forEach((rowData, i) => {
        const excelRow = ws.getRow(r)
        ws.getCell(`A${r}`).value = rowData[0]
        ws.getCell(`A${r}`).font = FONTS.bold
        ws.getCell(`B${r}`).value = rowData[1]
        ws.getCell(`B${r}`).font = FONTS.body
        if (rowData[2]) {
          ws.mergeCells(`C${r}:H${r}`)
          ws.getCell(`C${r}`).value = rowData[2]
          ws.getCell(`C${r}`).font = FONTS.dim
        }
        applyDataRowStyle(excelRow, i % 2 === 1)
        r++
      })

      r += 1
      ws.mergeCells(`A${r}:H${r}`)
      ws.getCell(`A${r}`).value = '▎变异函数数学表达式'
      ws.getCell(`A${r}`).font = FONTS.sectionTitle
      ws.getCell(`A${r}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: COLORS.bgTitle }
      }
      ws.getCell(`A${r}`).border = {
        bottom: { style: 'thin', color: { argb: COLORS.primaryLight } }
      }
      r++

      const formula = getVariogramFormula(modelName, model.nugget, model.range, model.sill)
      ws.mergeCells(`A${r}:H${r}`)
      ws.getCell(`A${r}`).value = formula
      ws.getCell(`A${r}`).font = { bold: true, size: 11, color: { argb: COLORS.primaryDark } }
      ws.getCell(`A${r}`).alignment = LEFT
      r++

      ws.mergeCells(`A${r}:H${r}`)
      ws.getCell(`A${r}`).value = '其中 h 为两点间距离，γ(h) 为半方差。'
      ws.getCell(`A${r}`).font = FONTS.dim
      r++
    } else {
      ws.mergeCells(`A${r}:H${r}`)
      ws.getCell(`A${r}`).value = '无 Kriging 模型数据'
      ws.getCell(`A${r}`).font = FONTS.dim
      r++
    }
  } else if (methodKey === 'idw_optimized' || methodKey === 'idw_default') {
    const params = compRow?.params
    const isOptimized = methodKey === 'idw_optimized'

    const paramData = [
      [
        '幂指数 p',
        safeNumber(params?.power)?.toFixed(3) ?? '-',
        '控制距离衰减速度，p越大近点权重越高'
      ],
      ['邻域数 k', safeText(params?.neighborCount), '参与插值的最近邻点数'],
      ['邻域策略', safeText(params?.neighborPolicy), 'sector=扇区搜索 | nearest=最近邻'],
      ['扇区数', safeText(params?.sectorCount), '扇区搜索的扇区划分数量'],
      [
        '是否PSO优化',
        isOptimized ? '是' : '否',
        isOptimized ? '使用粒子群优化搜索最优参数' : '使用默认参数'
      ]
    ]

    if (isOptimized) {
      const optParams = results?.idw?.optimalParams
      paramData.push(['PSO适应度', safeNumber(optParams?.fitness)?.toFixed(4) ?? '-', '越低越好'])
      paramData.push(['PSO耗时', formatTimingMs(optParams?.psoTimeMs), '参数优化计算耗时'])
      paramData.push(['重启次数', safeText(optParams?.restarts), '多起点独立运行次数'])
    }

    paramData.forEach((rowData, i) => {
      const excelRow = ws.getRow(r)
      ws.getCell(`A${r}`).value = rowData[0]
      ws.getCell(`A${r}`).font = FONTS.bold
      ws.getCell(`B${r}`).value = rowData[1]
      ws.getCell(`B${r}`).font = FONTS.body
      if (rowData[2]) {
        ws.mergeCells(`C${r}:H${r}`)
        ws.getCell(`C${r}`).value = rowData[2]
        ws.getCell(`C${r}`).font = FONTS.dim
      }
      applyDataRowStyle(excelRow, i % 2 === 1)
      r++
    })

    r += 1
    ws.mergeCells(`A${r}:H${r}`)
    ws.getCell(`A${r}`).value = '▎IDW 权重计算公式'
    ws.getCell(`A${r}`).font = FONTS.sectionTitle
    ws.getCell(`A${r}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLORS.bgTitle }
    }
    ws.getCell(`A${r}`).border = { bottom: { style: 'thin', color: { argb: COLORS.primaryLight } } }
    r++

    const p = params?.power ?? 2
    ws.mergeCells(`A${r}:H${r}`)
    ws.getCell(`A${r}`).value = `wᵢ = 1 / dᵢ^${p.toFixed(1)}    Z = Σ(wᵢ × Zᵢ) / Σ(wᵢ)`
    ws.getCell(`A${r}`).font = { bold: true, size: 11, color: { argb: COLORS.primaryDark } }
    ws.getCell(`A${r}`).alignment = LEFT
    r++

    ws.mergeCells(`A${r}:H${r}`)
    ws.getCell(`A${r}`).value =
      '其中 dᵢ 为预测点到第 i 个已知点的距离，Zᵢ 为第 i 个已知点的观测值。'
    ws.getCell(`A${r}`).font = FONTS.dim
    r++
  }

  r += 1

  // === 耗时统计 ===
  ws.mergeCells(`A${r}:H${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎耗时统计'
  ws.getRow(r).height = 22
  r++

  if (compRow?.timing) {
    const timing = compRow.timing
    const timingData = [
      ['总耗时', formatTimingMs(timing.totalMs)],
      ['PSO优化耗时', formatTimingMs(timing.psoMs)],
      ['预测耗时', formatTimingMs(timing.predictionMs)]
    ]
    timingData.forEach((rowData, i) => {
      const excelRow = ws.getRow(r)
      ws.getCell(`A${r}`).value = rowData[0]
      ws.getCell(`A${r}`).font = FONTS.bold
      ws.getCell(`B${r}`).value = rowData[1]
      applyDataRowStyle(excelRow, i % 2 === 1)
      r++
    })
  } else {
    ws.mergeCells(`A${r}:H${r}`)
    ws.getCell(`A${r}`).value = '无耗时数据'
    ws.getCell(`A${r}`).font = FONTS.dim
    r++
  }

  autoFitColumns(ws, 14, 28)
  ws.views = [{ state: 'frozen', ySplit: 3 }]
  return ws
}

// ==================== Sheet 8: 变异函数参数（汇总） ====================

function addVariogramSheet(workbook, results) {
  const ws = workbook.addWorksheet('变异函数')

  ws.mergeCells('A1:F1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = 'Kriging 变异函数模型参数'
  ws.getRow(1).height = 28

  const krResults = results?.kriging
  if (!krResults || !Object.keys(krResults).length) {
    ws.getCell('A3').value = '无 Kriging 模型数据'
    ws.getCell('A3').font = FONTS.dim
    return ws
  }

  let r = 3
  const headerRow = ws.getRow(r)
  const headers = ['模型名称', '块金值 Nugget', '变程 Range', '基台值 Sill', '拟合误差', '状态']
  headers.forEach((h, i) => {
    ws.getCell(r, i + 1).value = h
  })
  applyHeaderStyle(headerRow, true)
  ws.getRow(r).height = 22
  r++

  const modelNames = {
    exponential: '指数模型',
    gaussian: '高斯模型',
    spherical: '球状模型'
  }

  Object.entries(krResults).forEach(([modelName, data], idx) => {
    const excelRow = ws.getRow(r)
    const model = data?.model
    ws.getCell(r, 1).value = modelNames[modelName] || modelName
    formatNumberCell(ws.getCell(r, 2), safeNumber(model?.nugget), 6)
    formatNumberCell(ws.getCell(r, 3), safeNumber(model?.range), 2)
    formatNumberCell(ws.getCell(r, 4), safeNumber(model?.sill), 4)
    formatNumberCell(ws.getCell(r, 5), safeNumber(model?.fitError), 6)

    const statusCell = ws.getCell(r, 6)
    statusCell.value = model?.status === 'ok' ? '正常' : model?.status || '未知'
    statusCell.font = model?.status === 'ok' ? FONTS.success : FONTS.danger

    applyDataRowStyle(excelRow, idx % 2 === 1)
    r++
  })

  autoFitColumns(ws, 14, 22)
  ws.views = [{ state: 'frozen', ySplit: 3 }]
  return ws
}

// ==================== Sheet 9: 图表 ====================

const CHART_METRICS = [
  { key: 'rmse', title: 'RMSE 对比', lowerIsBetter: true },
  { key: 'mae', title: 'MAE 对比', lowerIsBetter: true },
  { key: 'r2', title: 'R² 对比', lowerIsBetter: false },
  { key: 'mape', title: 'MAPE 对比', lowerIsBetter: true }
]

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
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

async function addChartsSheet(workbook, results) {
  const ws = workbook.addWorksheet('图表')

  ws.mergeCells('A1:D1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '实验图表 — 插值方法指标对比'
  ws.getRow(1).height = 28

  const rows = results?.comparison?.rows || []
  if (!rows.length) {
    ws.getCell('A3').value = '暂无可导出的图表数据'
    ws.getCell('A3').font = FONTS.dim
    return ws
  }

  // 添加数据表（图表对应的数据源）
  let r = 3
  ws.mergeCells(`A${r}:E${r}`)
  applySectionCell(ws.getCell(`A${r}`))
  ws.getCell(`A${r}`).value = '▎图表数据源'
  ws.getRow(r).height = 22
  r++

  const dataHeader = ws.getRow(r)
  ws.getCell(`A${r}`).value = '方法'
  CHART_METRICS.forEach((m, i) => {
    ws.getCell(r, i + 2).value = METRIC_LABELS[m.key] || m.key
  })
  applyHeaderStyle(dataHeader)
  r++

  rows.forEach((row, idx) => {
    const excelRow = ws.getRow(r)
    ws.getCell(`A${r}`).value = methodLabel(row.key, row.method)
    CHART_METRICS.forEach((m, i) => {
      const val = safeNumber(row.metrics?.[m.key])
      if (val !== null) {
        formatNumberCell(ws.getCell(r, i + 2), val, 4)
      } else {
        ws.getCell(r, i + 2).value = '-'
        ws.getCell(r, i + 2).font = FONTS.dim
      }
    })
    applyDataRowStyle(excelRow, idx % 2 === 1)
    r++
  })

  // 添加图表图片
  r += 2
  let imageIndex = 0
  for (const metric of CHART_METRICS) {
    const svg = createMetricChartSvg(
      rows,
      metric.key,
      `${METRIC_LABELS[metric.key]}对比`,
      metric.lowerIsBetter
    )
    if (!svg) continue

    try {
      const pngDataUrl = await svgToPngDataUrl(svg, 920, 320)
      const imageId = workbook.addImage({
        base64: pngDataUrl,
        extension: 'png'
      })
      const rowOffset = r + Math.floor(imageIndex / 1) * 18
      ws.addImage(imageId, {
        tl: { col: 0.2, row: rowOffset },
        ext: { width: 920, height: 320 }
      })
      imageIndex++
    } catch (_) {
      // 图表渲染失败时跳过
    }
  }

  ws.columns = [{ width: 24 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }]
  return ws
}

// ==================== Sheet 10: 热力图 ====================

function addHeatmapSheet(workbook, results) {
  const ws = workbook.addWorksheet('热力图')

  ws.mergeCells('A1:H1')
  applyTitleCell(ws.getCell('A1'))
  ws.getCell('A1').value = '插值场热力图与差值图'
  ws.getRow(1).height = 28

  const heatmap = results?.heatmap
  if (!heatmap?.images?.length) {
    ws.getCell('A3').value = '无热力图数据。热力图在主线程渲染，请确保实验包含热力图结果。'
    ws.getCell('A3').font = FONTS.dim
    return ws
  }

  // 全局色标信息
  let r = 3
  ws.mergeCells(`A${r}:H${r}`)
  ws.getCell(`A${r}`).value =
    `统一色标范围：${heatmap.globalRange?.min?.toFixed(1) || '-'} ~ ${heatmap.globalRange?.max?.toFixed(1) || '-'} MPa | 场尺寸：${heatmap.fieldSize?.join('×') || '-'} m`
  ws.getCell(`A${r}`).font = FONTS.dim
  r += 1

  const images = heatmap.images || []
  let col = 0
  for (const item of images) {
    if (!item?.dataURL) continue
    const imageId = workbook.addImage({
      base64: item.dataURL,
      extension: 'png'
    })
    ws.getCell(r, col + 1).value = item.label
    ws.getCell(r, col + 1).font = FONTS.bold
    ws.addImage(imageId, {
      tl: { col: col + 0.2, row: r + 1 },
      ext: { width: 320, height: 250 }
    })
    col += 4
    if (col >= 8) {
      col = 0
      r += 18
    }
  }

  if (heatmap?.diffImage?.dataURL) {
    r += col > 0 ? 18 : 0
    const imageId = workbook.addImage({
      base64: heatmap.diffImage.dataURL,
      extension: 'png'
    })
    ws.getCell(`A${r}`).value = heatmap.diffImage.label || '差值图'
    ws.getCell(`A${r}`).font = FONTS.bold
    ws.addImage(imageId, {
      tl: { col: 0.2, row: r },
      ext: { width: 360, height: 280 }
    })
  }

  return ws
}

// ==================== 导出主函数 ====================

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
  workbook.creator = 'Cesium Simulation Platform'
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.properties.date1904 = false

  // 按专业顺序添加各个Sheet
  addOverviewSheet(workbook, config, results) // 1. 实验概览
  addComparisonSheet(workbook, results) // 2. 精度对比
  addStabilitySheet(workbook, results) // 3. 稳定性统计

  // 4-8. 每种插值方法独立详情页（包含函数表达式和参数）
  const methodRows = results?.comparison?.rows || []
  for (const row of methodRows) {
    addMethodDetailSheet(workbook, row.key, methodLabel(row.key, row.method), results)
  }

  addPredictionSheet(workbook, results) // 9. 插值预测结果明细
  addTrainingDataSheet(workbook, results) // 10. 训练数据明细
  addTestDataSheet(workbook, results) // 11. 测试数据明细
  addPSODetailSheet(workbook, results) // 12. PSO优化详情
  addVariogramSheet(workbook, results) // 13. 变异函数参数汇总
  await addChartsSheet(workbook, results) // 14. 图表
  addHeatmapSheet(workbook, results) // 15. 热力图

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  triggerDownload(blob, `插值实验报告-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
