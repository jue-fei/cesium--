import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'

export const useGeologyStore = defineStore('geology', () => {
  const boreholes = shallowRef([])
  const sections = shallowRef([])
  const orebodies = shallowRef([])

  const stats = ref({
    averageThickness: 0,
    mineralizationIntensity: 0,
    estimatedReserves: 0,
    averageGrade: 0
  })

  function setBoreholes(data) {
    boreholes.value = data
  }

  function addBoreholes(data) {
    boreholes.value = [...boreholes.value, ...data]
  }

  function setSections(data) {
    sections.value = data
  }

  function addSection(section) {
    sections.value = [...sections.value, section]
  }

  function setOrebodies(data) {
    orebodies.value = data
  }

  function updateStats(newStats) {
    stats.value = { ...stats.value, ...newStats }
  }

  function clearAll() {
    boreholes.value = []
    sections.value = []
    orebodies.value = []
    stats.value = {
      averageThickness: 0,
      mineralizationIntensity: 0,
      estimatedReserves: 0,
      averageGrade: 0
    }
  }

  return {
    boreholes,
    sections,
    orebodies,
    stats,
    setBoreholes,
    addBoreholes,
    setSections,
    addSection,
    setOrebodies,
    updateStats,
    clearAll
  }
})
