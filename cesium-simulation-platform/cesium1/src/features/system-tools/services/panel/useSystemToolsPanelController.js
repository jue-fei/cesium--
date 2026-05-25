import { computed, ref } from 'vue'
import useViewer from '@/composables/useViewer.js'
import useModel from '@/features/model-control/services/useModel.js'
import useMeasurement from '@/features/measurement-analysis/services/useMeasurement.js'
import useClipping from '@/features/model-clipping/services/useClipping.js'
import useExport from '../export/useExport.js'
import { useDepthRuler } from '@/composables/useDepthRuler.js'
import { DEFAULT_EXPORT_TYPE } from '../../types/exportConstants.js'

export function useSystemToolsPanelController() {
  const {
    displayQuality,
    terrainQuality,
    coordinateSystem,
    updateDisplayQuality,
    updateTerrainQuality,
    updateCoordinateSystem,
    toggleFullscreen
  } = useViewer()
  const { modelList, fitToModels, resetView } = useModel()
  const { measurementHistory } = useMeasurement()
  const { clippingPlanes } = useClipping()
  const { handleExportData } = useExport()
  const { enabled: depthRulerEnabled, toggle: toggleDepthRuler } = useDepthRuler()

  const dialogVisible = ref(false)
  const currentExportType = ref(DEFAULT_EXPORT_TYPE)

  return {
    displayQuality,
    terrainQuality,
    coordinateSystem,
    updateDisplayQuality,
    updateTerrainQuality,
    updateCoordinateSystem,
    toggleFullscreen,
    fitToModels,
    resetView,
    depthRulerEnabled,
    toggleDepthRuler,
    dialogVisible,
    currentExportType,
    modelCount: computed(() => modelList.value.length),
    measurementCount: computed(() => measurementHistory.value.length),
    clippingCount: computed(() => clippingPlanes.value.length),
    showExportDialog: type => {
      currentExportType.value = type
      dialogVisible.value = true
    },
    closeDialog: () => {
      dialogVisible.value = false
    },
    handleExportConfirm: options => {
      handleExportData({ type: currentExportType.value, options })
      dialogVisible.value = false
    }
  }
}
