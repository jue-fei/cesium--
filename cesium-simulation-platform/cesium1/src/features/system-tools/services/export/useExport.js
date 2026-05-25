import {
  exportSceneData as exportSceneDataUtil,
  exportReport as exportReportUtil,
  exportScreenshot as exportScreenshotUtil,
  exportMeasurementsCSV
} from './exportManager.js'
import useViewer from '@/composables/useViewer.js'
import useModel from '@/features/model-control/services/useModel.js'
import useMeasurement from '@/features/measurement-analysis/services/useMeasurement.js'
import useClipping from '@/features/model-clipping/services/useClipping.js'
import useGeologyAnalysis from '@/features/geology-analysis/services/useGeologyAnalysis.js'
import useMessage from '@/composables/useMessage.js'
import { DEFAULT_SCREENSHOT_OPTIONS, EXPORT_TYPES } from '../../types/exportConstants.js'

export default function useExport() {
  const { showMessage } = useMessage()

  const { viewer, coordinateSystem } = useViewer()
  const { modelList } = useModel()
  const { measurementHistory } = useMeasurement()
  const { clippingPlanes } = useClipping()
  const { getGeologyData } = useGeologyAnalysis()

  /**
   * 执行数据导出
   * @param {Object} exportConfig - 导出配置
   */
  const handleExportData = async exportConfig => {
    const { type, options } = exportConfig

    const viewerInstance = viewer.value

    const sceneData = {
      modelList: modelList.value,
      measurementHistory: measurementHistory.value,
      coordinateSystem: coordinateSystem.value,
      clippingPlanes: clippingPlanes.value,
      geologyData: getGeologyData ? getGeologyData() : null,
      viewer: viewerInstance
    }

    try {
      switch (type) {
        case EXPORT_TYPES.JSON:
          await exportSceneDataUtil(options, sceneData)
          showMessage('场景数据JSON导出成功！', 'success')
          break
        case EXPORT_TYPES.REPORT:
          exportReportUtil(options, sceneData)
          showMessage('分析报告生成成功！', 'success')
          break
        case EXPORT_TYPES.SCREENSHOT: {
          const screenshotOptions = {
            width: options?.useCustomSize ? options.width : null,
            height: options?.useCustomSize ? options.height : null,
            quality: options?.quality ?? DEFAULT_SCREENSHOT_OPTIONS.quality,
            format: options?.format || DEFAULT_SCREENSHOT_OPTIONS.format
          }
          exportScreenshotUtil(viewerInstance, screenshotOptions)
          showMessage(`截图导出成功！格式: ${screenshotOptions.format.toUpperCase()}`, 'success')
          break
        }
        case EXPORT_TYPES.CSV:
          if (measurementHistory.value && measurementHistory.value.length > 0) {
            exportMeasurementsCSV(measurementHistory.value)
            showMessage('测量数据CSV导出成功！', 'success')
          } else {
            showMessage('没有可导出的测量数据', 'warning')
          }
          break
        default:
          showMessage('未知的导出类型', 'error')
      }
    } catch (error) {
      console.error('Export failed:', error)
      showMessage(`导出失败: ${error.message}`, 'error')
    }
  }

  return {
    handleExportData
  }
}
