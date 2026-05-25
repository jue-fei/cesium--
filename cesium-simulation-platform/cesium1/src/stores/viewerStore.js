import { defineStore } from 'pinia'
import { shallowRef, ref } from 'vue'

export const useViewerStore = defineStore('viewer', () => {
  const viewer = shallowRef(null)

  const coordinateSystem = ref('wgs84')
  const displayQuality = ref('high')
  const terrainQuality = ref('high')

  function setViewer(instance) {
    viewer.value = instance
  }

  function destroyViewer() {
    if (viewer.value && !viewer.value.isDestroyed()) {
      viewer.value.destroy()
    }
    viewer.value = null
  }

  function setCoordinateSystem(system) {
    coordinateSystem.value = system
  }

  function setDisplayQuality(quality) {
    displayQuality.value = quality
  }

  function setTerrainQuality(quality) {
    terrainQuality.value = quality
  }

  return {
    viewer,
    coordinateSystem,
    displayQuality,
    terrainQuality,
    setViewer,
    destroyViewer,
    setCoordinateSystem,
    setDisplayQuality,
    setTerrainQuality
  }
})
