/**
 * Worker安全工具函数（无Cesium依赖）
 * 这些函数可在Web Worker中使用
 */

import { parsePointCenter } from '../shared/parsePointCenter.js'
import { toNumberOrDefault, toFiniteNumber, clamp, clampInt } from '../shared/stressMathUtils.js'

export { parsePointCenter }
export { toNumberOrDefault, toFiniteNumber, clamp, clampInt }
