import { computed } from 'vue'
import useMeasurement from '../useMeasurement.js'
import useMessage from '@/composables/useMessage.js'
import { MEASUREMENT_HINTS } from '../../types/measurementConstants.js'

function formatNumber(value) {
  if (value === undefined || value === null) return '0'
  if (value === 0) return '0'
  if (value < 0.001) return value.toExponential(2)
  if (value < 1) return value.toFixed(3)
  if (value < 1000) return value.toFixed(2)
  return value.toFixed(0)
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

export function useMeasurementPanelController() {
  const {
    isMeasuring,
    isAreaMeasuring,
    measurementDistance,
    terrainDistance,
    distanceMode,
    measurementArea,
    measurementHistory,
    highlightedRecordId,
    toggleMeasurement,
    toggleStraightMeasurement,
    toggleTerrainMeasurement,
    toggleAreaMeasurement,
    setDistanceMode,
    stopMeasurement,
    exitMeasurement,
    clearAllMeasurements,
    deleteMeasurementRecord,
    showHistoryOnScene,
    clearHistoryVisualization
  } = useMeasurement()
  const { showOperationMessage } = useMessage()

  const hasCurrentMeasurements = computed(
    () => measurementDistance.value > 0 || terrainDistance.value > 0 || measurementArea.value > 0
  )

  const hasMeasurements = computed(
    () =>
      measurementDistance.value > 0 ||
      terrainDistance.value > 0 ||
      measurementArea.value > 0 ||
      measurementHistory.value.length > 0
  )

  const activeDistance = computed(() =>
    distanceMode.value === 'terrain' ? terrainDistance.value : measurementDistance.value
  )

  const activeLabel = computed(() => (distanceMode.value === 'terrain' ? '路途距离' : '直线距离'))

  const categorizedHistory = computed(() => {
    const groups = [
      {
        key: 'straight',
        label: '直线距离',
        icon: '━',
        color: '#4fc3f7',
        items: []
      },
      {
        key: 'terrain',
        label: '路途距离',
        icon: '〰',
        color: '#81c784',
        items: []
      },
      {
        key: 'area',
        label: '面积测量',
        icon: '📐',
        color: '#ffb74d',
        items: []
      }
    ]

    measurementHistory.value.forEach(r => {
      if (r.type === 'area') {
        groups[2].items.push(r)
      } else if (r.distanceMode === 'terrain') {
        groups[1].items.push(r)
      } else {
        groups[0].items.push(r)
      }
    })

    return groups.filter(g => g.items.length > 0)
  })

  const allHistoryCount = computed(() => measurementHistory.value.length)

  const getRecordLabel = record => {
    if (record.type === 'area') return `${formatNumber(record.area)} m²`
    if (record.distanceMode === 'terrain') return `${formatNumber(record.terrainDistance)} m`
    return `${formatNumber(record.distance)} m`
  }

  return {
    isMeasuring,
    isAreaMeasuring,
    measurementDistance,
    terrainDistance,
    distanceMode,
    measurementArea,
    measurementHistory,
    highlightedRecordId,
    toggleMeasurement,
    toggleStraightMeasurement,
    toggleTerrainMeasurement,
    toggleAreaMeasurement,
    setDistanceMode,
    stopMeasurement,
    exitMeasurement,
    clearAllMeasurements,
    deleteMeasurementRecord,
    showHistoryOnScene,
    clearHistoryVisualization,
    formatNumber,
    formatTime,
    activeDistance,
    activeLabel,
    formattedActiveDistance: computed(() => formatNumber(activeDistance.value)),
    hasCurrentMeasurements,
    hasMeasurements,
    hasMeasurementHistory: computed(() => measurementHistory.value.length > 0),
    categorizedHistory,
    allHistoryCount,
    getRecordLabel,
    formattedDistance: computed(() => formatNumber(measurementDistance.value)),
    formattedTerrainDistance: computed(() => formatNumber(terrainDistance.value)),
    formattedArea: computed(() => formatNumber(measurementArea.value)),
    showVolumeAnalysis: () => showOperationMessage(MEASUREMENT_HINTS.VOLUME, 'info'),
    showSlopeAnalysis: () => showOperationMessage(MEASUREMENT_HINTS.SLOPE, 'info'),
    showVisibilityAnalysis: () => showOperationMessage(MEASUREMENT_HINTS.VISIBILITY, 'info')
  }
}
