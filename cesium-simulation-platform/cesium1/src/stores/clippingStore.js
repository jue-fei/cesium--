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
  const polygonVertices = ref([])
  const polygonVisualizationOpacity = ref(0.35)

  function resetAll() {
    clippingEnabled.value = false
    clippingPlanes.value = []
    activePlaneIndex.value = null
    polygonClippingEnabled.value = false
    isDrawingPolygon.value = false
    polygonDepth.value = 0
    polygonDirection.value = 'excavate'
    polygonVertices.value = []
    polygonVisualizationOpacity.value = 0.35
  }

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    polygonVertices,
    polygonVisualizationOpacity,
    resetAll,
    setClippingEnabled: v => {
      clippingEnabled.value = v
    },
    setClippingPlanes: v => {
      clippingPlanes.value = v
    },
    addClippingPlane: v => {
      clippingPlanes.value.push(v)
    },
    setActivePlaneIndex: v => {
      activePlaneIndex.value = v
    },
    setPolygonClippingEnabled: v => {
      polygonClippingEnabled.value = v
    },
    setIsDrawingPolygon: v => {
      isDrawingPolygon.value = v
    },
    setPolygonVertices: v => {
      polygonVertices.value = Array.isArray(v) ? v : []
    }
  }
})
