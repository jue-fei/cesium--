import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import {
  DEFAULT_LOD_CONFIG,
  DEFAULT_POSITION,
  DEFAULT_TRANSFORM
} from '@/config/constants/modelConfig.js'
import { createLodRuntimeState } from '@/features/lod-optimization/services/lodRuntime.js'

export const useModelStore = defineStore('model', () => {
  const modelConfigFiles = ref([])
  const currentConfigFile = ref('')
  const modelList = ref([])
  const globalOpacity = ref(0)
  const modelPosition = ref({ ...DEFAULT_POSITION })
  const modelTransform = ref({ ...DEFAULT_TRANSFORM })
  const modelLoadStatus = ref(null)
  const loading = ref(false)
  const selectedModel = ref(null)
  const modelConfigRaw = ref(null)

  const undergroundViewEnabled = ref(false)
  const globeFrontFaceAlpha = ref(20)
  const globeBackFaceAlpha = ref(20)

  const tileset = shallowRef(null)
  const lodConfig = ref({ ...DEFAULT_LOD_CONFIG })
  const lodRuntime = ref(createLodRuntimeState())

  return {
    modelConfigFiles,
    currentConfigFile,
    modelList,
    globalOpacity,
    modelPosition,
    modelTransform,
    modelLoadStatus,
    loading,
    selectedModel,
    modelConfigRaw,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    tileset,
    lodConfig,
    lodRuntime
  }
})
