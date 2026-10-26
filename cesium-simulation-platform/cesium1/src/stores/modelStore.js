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

  // 默认开启地下模式：阿舍勒聚合模型含井下工程（矿体/巷道延伸到椭球面以下），
  // 不开启时地表不透明球体会遮住地下部分；模型加载完成后由 syncUndergroundViewIfNeeded 自动生效。
  // 地表/背面不透明度默认 0（地表完全看穿）；UI 已移除，仅爆破场景会复用这两个值作滑块初值。
  const undergroundViewEnabled = ref(true)
  const globeFrontFaceAlpha = ref(0)
  const globeBackFaceAlpha = ref(0)

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
