export const MEASUREMENT_HISTORY_STORAGE_KEY = 'measurementHistory'
export const TEMP_LINE_ENTITY_ID = 'measurement-temp-line'
export const TEMP_RESULT_LABEL_ENTITY_ID = 'measurement-temp-result-label'

export const MEASUREMENT_TYPES = {
  DISTANCE: 'distance',
  AREA: 'area'
}

export const MEASUREMENT_MIN_POINTS = {
  distance: 2,
  area: 3
}

export const CURSOR = {
  DEFAULT: 'default',
  MEASURING: 'crosshair'
}

export const MEASUREMENT_HINTS = {
  VOLUME: '体积分析：请在场景中选择多个点，系统将自动计算围合体积。',
  SLOPE: '坡度分析：已激活。请在地形上点击查看斜坡坡度信息。',
  VISIBILITY: '可视域分析：从当前视点计算可见范围。'
}

export const MEASUREMENT_MESSAGES = {
  START_DISTANCE: '开始距离测量',
  START_AREA: '开始面积测量'
}
