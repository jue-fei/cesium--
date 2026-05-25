import { ref } from 'vue'
import { ScenarioManager } from '../features/scenario/scenarioManager.js'

let scenarioManager = null

export default function useScenario() {
  const isEditing = ref(false)
  const deployedCount = ref(0)

  const initScenarioManager = viewer => {
    if (!scenarioManager && viewer) {
      scenarioManager = new ScenarioManager(viewer)
    }
  }

  const toggleEditMode = active => {
    if (!scenarioManager) return
    isEditing.value = active
    if (active) {
      scenarioManager.enableEditing()
    } else {
      scenarioManager.disableEditing()
    }
  }

  const deployEquipment = type => {
    if (!scenarioManager) return
    scenarioManager.deployEquipment(type)
    deployedCount.value++
  }

  const clearScenario = () => {
    if (!scenarioManager) return
    scenarioManager.clearScene()
    deployedCount.value = 0
  }

  return {
    isEditing,
    deployedCount,
    initScenarioManager,
    toggleEditMode,
    deployEquipment,
    clearScenario
  }
}
