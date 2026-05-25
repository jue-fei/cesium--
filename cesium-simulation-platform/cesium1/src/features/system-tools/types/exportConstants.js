export const EXPORT_TYPES = {
  JSON: 'json',
  REPORT: 'report',
  SCREENSHOT: 'screenshot',
  CSV: 'csv'
}

export const DEFAULT_EXPORT_TYPE = EXPORT_TYPES.JSON

export const EXPORT_ACTIONS = [
  { type: EXPORT_TYPES.JSON, label: 'JSON数据' },
  { type: EXPORT_TYPES.REPORT, label: 'HTML报告' },
  { type: EXPORT_TYPES.SCREENSHOT, label: '场景截图' },
  { type: EXPORT_TYPES.CSV, label: 'CSV数据' }
]

export const EXPORT_TITLES = {
  [EXPORT_TYPES.JSON]: '导出JSON',
  [EXPORT_TYPES.REPORT]: '导出报告',
  [EXPORT_TYPES.SCREENSHOT]: '导出截图',
  [EXPORT_TYPES.CSV]: '导出CSV'
}

export const SCREENSHOT_FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' }
]

export const DEFAULT_SCREENSHOT_OPTIONS = {
  format: 'png',
  quality: 1.0
}

export function createDefaultExportOptions() {
  return {
    projectName: '',
    description: '',
    includeBasicInfo: true,
    includeModels: true,
    includeMeasurements: true,
    includeClipping: true,
    includeGeology: true,
    includeCameraView: true
  }
}
