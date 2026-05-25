import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useMeasurementStore = defineStore('measurement', () => {
  const isMeasuring = ref(false)
  const isAreaMeasuring = ref(false)
  const measurementPoints = ref([])
  const measurementDistance = ref(0)
  const measurementArea = ref(0)
  const measurementEntities = ref([])
  const measurementHistory = ref([])

  return {
    isMeasuring,
    isAreaMeasuring,
    measurementPoints,
    measurementDistance,
    measurementArea,
    measurementEntities,
    measurementHistory
  }
})
