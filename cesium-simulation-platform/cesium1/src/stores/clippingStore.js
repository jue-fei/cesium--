import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useClippingStore = defineStore('clipping', () => {
  const clippingEnabled = ref(false)
  const clippingPlanes = ref([])
  const activePlaneIndex = ref(null)

  const polygonClippingEnabled = ref(false)
  const isDrawingPolygon = ref(false)
  const polygonDepth = ref(0)
  const polygonDirection = ref('excavate')

  function setClippingEnabled(enabled) {
    clippingEnabled.value = enabled
  }

  function setClippingPlanes(planes) {
    clippingPlanes.value = planes
  }

  function addClippingPlane(plane) {
    clippingPlanes.value.push(plane)
  }

  function setActivePlaneIndex(index) {
    activePlaneIndex.value = index
  }

  function setPolygonClippingEnabled(enabled) {
    polygonClippingEnabled.value = enabled
  }

  function setIsDrawingPolygon(drawing) {
    isDrawingPolygon.value = drawing
  }

  function resetAll() {
    clippingEnabled.value = false
    clippingPlanes.value = []
    activePlaneIndex.value = null
    polygonClippingEnabled.value = false
    isDrawingPolygon.value = false
    polygonDepth.value = 0
    polygonDirection.value = 'excavate'
  }

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    setClippingEnabled,
    setClippingPlanes,
    addClippingPlane,
    setActivePlaneIndex,
    setPolygonClippingEnabled,
    setIsDrawingPolygon,
    resetAll
  }
})
