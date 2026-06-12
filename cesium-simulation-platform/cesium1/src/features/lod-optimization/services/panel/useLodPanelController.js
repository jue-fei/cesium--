import { computed, ref, watch } from 'vue'
import useModel from '@/features/model-control/services/useModel.js'
import useMessage from '@/composables/useMessage.js'
import { PRESETS } from '@/config/constants/modelConfig.js'
import { LOD_STAGE_DEFINITIONS, cesiumColorToHex } from '../lodRuntime.js'

// ---- 从单一数据源派生阶段常量（模块级，非响应式）----
export const STAGE_KEYS = LOD_STAGE_DEFINITIONS.map(d => d.key)
export const STAGE_LABELS = Object.fromEntries(
  LOD_STAGE_DEFINITIONS.map(d => [d.key, d.label.replace(/^S\d\s/, '')])
)
export const STAGE_COLORS = Object.fromEntries(
  LOD_STAGE_DEFINITIONS.map(d => [d.key, cesiumColorToHex(d.color)])
)

export function useLodPanelController() {
  const {
    lodConfig,
    updateLodConfig,
    resetLodConfig,
    tilesetRef,
    fps,
    DEFAULT_LOD_CONFIG,
    lodRuntime,
    adaptiveLoadState,
    lodVisualizationState,
    applyLodVisualizationMode
  } = useModel()
  const { showMessage } = useMessage()

  const local = ref({})
  const modelLoaded = computed(() => !!tilesetRef.value)
  const presetKey = ref('balanced')
  const openGroupIds = ref([])
  const peakTrianglesSelected = ref(0)
  const peakSelectedTiles = ref(0)
  const peakCommands = ref(0)
  let collapseInitialized = false

  const memoryMb = computed(() => {
    const bytes = tilesetRef.value ? tilesetRef.value.totalMemoryUsageInBytes : 0
    return Math.round((bytes / 1024 / 1024) * 10) / 10
  })

  const presets = computed(() => {
    const order = ['high_quality', 'balanced', 'performance']
    const list = Object.keys(PRESETS || {}).map(key => ({
      key,
      ...(PRESETS[key] || {})
    }))
    return list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  })

  const presetOptions = computed(() => [
    ...presets.value.map(p => ({ key: p.key, label: p.displayName || p.key })),
    { key: 'custom', label: '自定义' }
  ])

  const currentPresetLabel = computed(() => {
    if (presetKey.value === 'custom') return '自定义'
    const preset = PRESETS[presetKey.value]
    return preset?.displayName || presetKey.value
  })

  const dependencyLabelMap = {
    dynamicScreenSpaceError: '动态误差',
    foveatedScreenSpaceError: '中心优先加载',
    skipLevelOfDetail: '跳级 LOD',
    cullRequestsWhileMoving: '移动时裁剪请求'
  }

  const applyPreset = async key => {
    presetKey.value = key
    if (key === 'custom') return
    const preset = PRESETS[key]
    const nextConfig = sanitize({
      ...DEFAULT_LOD_CONFIG,
      ...(preset && preset.config ? preset.config : {})
    })
    local.value = { ...nextConfig }

    if (!modelLoaded.value) {
      showMessage('模型未加载，无法切换预设', 'warning')
      return
    }

    const ok = updateLodConfig(nextConfig)
    if (ok) {
      showMessage('LOD预设已在线应用', 'success')
      return
    }
    showMessage('LOD预设应用失败', 'error')
  }

  const onLocalChange = () => {
    presetKey.value = 'custom'
  }

  const clamp = (value, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, n))
  }

  const bytesToMb = bytes => Math.round((Number(bytes) || 0) / 1024 / 1024)
  const mbToBytes = mb => Math.round((Number(mb) || 0) * 1024 * 1024)

  const getStepDecimals = step => {
    const s = String(step)
    const idx = s.indexOf('.')
    if (idx === -1) return 0
    return Math.max(0, s.length - idx - 1)
  }

  const groups = computed(() => [
    {
      id: 'quality',
      title: '细节与缓存',
      subtitle: '阈值与预算',
      defaultOpen: true,
      fields: [
        {
          key: 'maximumScreenSpaceError',
          label: '细节阈值 (SSE)',
          min: 2,
          max: 64,
          step: 1,
          type: 'number',
          hint: '越小越清晰；越大越省资源'
        },
        {
          key: 'cacheBytes',
          label: '缓存上限',
          min: 64,
          max: 4096,
          step: 64,
          type: 'bytes_mb',
          hint: '越大越顺滑，内存占用更高（MB）'
        },
        {
          key: 'maximumCacheOverflowBytes',
          label: '缓存溢出余量',
          min: 0,
          max: 4096,
          step: 64,
          type: 'bytes_mb',
          hint: '高需求时允许的额外缓存（MB）'
        },
        {
          key: 'progressiveResolutionHeightFraction',
          label: '渐进加载比例',
          min: 0,
          max: 0.5,
          step: 0.01,
          type: 'number',
          hint: '首屏优先，建议 0.2–0.35'
        }
      ]
    },
    {
      id: 'dynamic',
      title: '动态误差',
      subtitle: '远景减负',
      defaultOpen: false,
      fields: [
        {
          key: 'dynamicScreenSpaceError',
          label: '开启动态误差',
          type: 'checkbox',
          hint: '远景视角减轻瓦片加载压力'
        },
        {
          key: 'dynamicScreenSpaceErrorDensity',
          label: '密度',
          dependsOn: 'dynamicScreenSpaceError',
          min: 0,
          max: 0.01,
          step: 0.00001,
          type: 'number',
          hint: '越大越影响近处；越小越影响远处'
        },
        {
          key: 'dynamicScreenSpaceErrorFactor',
          label: '强度',
          dependsOn: 'dynamicScreenSpaceError',
          min: 0,
          max: 64,
          step: 1,
          type: 'number',
          hint: '越大越偏性能（远处更容易降细节）'
        },
        {
          key: 'dynamicScreenSpaceErrorHeightFalloff',
          label: '高度衰减',
          dependsOn: 'dynamicScreenSpaceError',
          min: 0,
          max: 1,
          step: 0.01,
          type: 'number',
          hint: '取值 0–1；相机越接近地面时作用越明显'
        }
      ]
    },
    {
      id: 'foveated',
      title: '中心优先加载',
      subtitle: '中心优先',
      defaultOpen: false,
      fields: [
        {
          key: 'foveatedScreenSpaceError',
          label: '开启中心优先',
          type: 'checkbox',
          hint: '中心优先，边缘延后'
        },
        {
          key: 'foveatedConeSize',
          label: '中心锥大小',
          dependsOn: 'foveatedScreenSpaceError',
          min: 0,
          max: 1,
          step: 0.01,
          type: 'number',
          hint: '取值 0–1；越大越接近全屏优先'
        },
        {
          key: 'foveatedMinimumScreenSpaceErrorRelaxation',
          label: '边缘放松起点',
          dependsOn: 'foveatedScreenSpaceError',
          min: 0,
          max: 64,
          step: 1,
          type: 'number',
          hint: '越大边缘越延后'
        },
        {
          key: 'foveatedTimeDelay',
          label: '停下后延迟',
          dependsOn: 'foveatedScreenSpaceError',
          min: 0,
          max: 2,
          step: 0.01,
          type: 'number',
          hint: '单位秒；抑制移动时边缘请求'
        }
      ]
    },
    {
      id: 'skip',
      title: '跳级 LOD',
      subtitle: '跳级加速',
      defaultOpen: false,
      fields: [
        {
          key: 'skipLevelOfDetail',
          label: '启用跳级',
          type: 'checkbox',
          hint: '减少遍历，提速；细节跳变'
        },
        {
          key: 'baseScreenSpaceError',
          label: '跳级起点 (SSE)',
          dependsOn: 'skipLevelOfDetail',
          min: 0,
          max: 4096,
          step: 32,
          type: 'number',
          hint: '达到阈值后启用跳级'
        },
        {
          key: 'skipScreenSpaceErrorFactor',
          label: '跳级因子',
          dependsOn: 'skipLevelOfDetail',
          min: 1,
          max: 64,
          step: 1,
          type: 'number',
          hint: '越大越容易跳级'
        },
        {
          key: 'skipLevels',
          label: '最小跳级层数',
          dependsOn: 'skipLevelOfDetail',
          min: 0,
          max: 10,
          step: 1,
          type: 'number',
          hint: '0 表示不跳级'
        },
        {
          key: 'immediatelyLoadDesiredLevelOfDetail',
          label: '仅加载目标细节',
          dependsOn: 'skipLevelOfDetail',
          type: 'checkbox',
          hint: '按目标阈值直达，补齐更慢'
        },
        {
          key: 'loadSiblings',
          label: '加载相邻瓦片',
          dependsOn: 'skipLevelOfDetail',
          type: 'checkbox',
          hint: '减裂缝，增请求'
        }
      ]
    },
    {
      id: 'culling',
      title: '裁剪与预加载',
      subtitle: '裁剪策略',
      defaultOpen: false,
      fields: [
        {
          key: 'cullWithChildrenBounds',
          label: '用子节点联合包围裁剪',
          type: 'checkbox',
          hint: '建议开启，减少无效请求'
        },
        {
          key: 'cullRequestsWhileMoving',
          label: '移动时裁剪请求',
          type: 'checkbox',
          hint: '移动时抑制过期请求'
        },
        {
          key: 'cullRequestsWhileMovingMultiplier',
          label: '移动裁剪强度',
          dependsOn: 'cullRequestsWhileMoving',
          min: 0,
          max: 120,
          step: 1,
          type: 'number',
          hint: '越大越激进，停下补齐更慢'
        },
        {
          key: 'preloadWhenHidden',
          label: '隐藏时预加载',
          type: 'checkbox',
          hint: '隐藏仍加载，切换更快'
        },
        {
          key: 'preloadFlightDestinations',
          label: '飞行目标预加载',
          type: 'checkbox',
          hint: '飞行中预载目标区域'
        },
        {
          key: 'preferLeaves',
          label: '优先加载叶子节点',
          type: 'checkbox',
          hint: '优先细节，短时压力↑'
        }
      ]
    },
    {
      id: 'visual',
      title: 'LOD可视化',
      subtitle: '直观看层级变化',
      defaultOpen: true,
      fields: [
        {
          key: 'debugShowGeometricError',
          label: '显示几何误差',
          type: 'checkbox',
          hint: '在瓦片上显示 geometric error，可直观看出当前层级误差'
        },
        {
          key: 'debugShowRenderingStatistics',
          label: '显示渲染统计',
          type: 'checkbox',
          hint: '在瓦片上直接显示命令数、点数、三角面和要素数'
        },
        {
          key: 'debugShowMemoryUsage',
          label: '显示瓦片内存',
          type: 'checkbox',
          hint: '在瓦片上显示几何和纹理内存占用'
        }
      ]
    }
  ])

  const visualizationModeOptions = [
    { key: 'off', label: '关闭覆盖', hint: '保持原始纹理，仅显示正常模型' },
    { key: 'stage_color', label: '十级分层', hint: '按瓦片几何误差显示 S0-S9 十级 LOD 阶段' },
    { key: 'stage_wireframe', label: '分层+线框', hint: '分层着色基础上叠加线框' },
    { key: 'random_tiles', label: '随机瓦片', hint: '突出瓦片切块边界和切换区域' },
    { key: 'random_wireframe', label: '随机+线框', hint: '同时观察切块与网格结构' }
  ]

  const stageLegend = STAGE_KEYS.map((key, index) => ({
    key,
    label: `S${index}`,
    title: STAGE_LABELS[key],
    color: STAGE_COLORS[key]
  }))

  const flattenFields = groupsValue =>
    groupsValue.reduce((acc, g) => acc.concat(g.fields || []), [])

  const sanitize = input => {
    const fields = flattenFields(groups.value)
    const next = { ...(input || {}) }

    for (const field of fields) {
      const raw = next[field.key]
      if (field.type === 'checkbox') {
        next[field.key] = Boolean(raw)
        continue
      }

      if (field.type === 'bytes_mb') {
        const mb = clamp(
          raw === undefined ? bytesToMb(DEFAULT_LOD_CONFIG[field.key]) : bytesToMb(raw),
          field.min,
          field.max
        )
        next[field.key] = mbToBytes(mb)
        continue
      }

      const v =
        raw === undefined
          ? DEFAULT_LOD_CONFIG[field.key]
          : field.step < 1
            ? Number(raw)
            : Math.round(Number(raw))

      next[field.key] = clamp(v, field.min, field.max)
    }

    return next
  }

  const dirty = computed(() => {
    const a = local.value || {}
    const b = lodConfig.value || {}
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    for (const k of keys) {
      if (a[k] !== b[k]) return true
    }
    return false
  })

  const isFieldDisabled = field => Boolean(field?.dependsOn && !local.value[field.dependsOn])

  const getFieldHint = field => {
    const baseHint = field?.hint || ''
    if (!field?.dependsOn || !isFieldDisabled(field)) return baseHint
    const dependencyLabel = dependencyLabelMap[field.dependsOn] || field.dependsOn
    return `${baseHint}；需先开启${dependencyLabel}`
  }

  const requestStageLabel = computed(() => {
    if (lodRuntime.value?.allTilesLoaded) return '完成'
    if (lodRuntime.value?.initialTilesLoaded) return '首屏'
    if ((lodRuntime.value?.pendingRequests || 0) > 0 || (lodRuntime.value?.tilesProcessing || 0) > 0) {
      return '进行中'
    }
    return modelLoaded.value ? '待加载' : '未加载'
  })

  const detailTierLabel = computed(() => {
    const sse = Number(local.value?.maximumScreenSpaceError ?? lodConfig.value?.maximumScreenSpaceError ?? 16)
    if (sse <= 10) return '高细节'
    if (sse <= 24) return '平衡'
    return '性能优先'
  })

  const adaptiveStatusLabel = computed(() => {
    if (!modelLoaded.value) return '待机'
    if (!adaptiveLoadState.enabled) return '关闭'
    if (adaptiveLoadState.level > 0) return adaptiveLoadState.appliedStepLabel || `等级 ${adaptiveLoadState.level}`
    return '基线'
  })

  const adaptivePressureLabel = computed(() => {
    const pressure = adaptiveLoadState.pressure
    if (pressure === 'high') return '高'
    if (pressure === 'medium') return '中'
    return '低'
  })

  const currentVisualizationMode = computed(() => lodVisualizationState.mode || 'off')

  const setVisualizationMode = mode => {
    applyLodVisualizationMode(mode)
  }

  const formatMetricValue = value => {
    const n = Number(value) || 0
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return String(Math.round(n))
  }

  const tilesReadyRatioLabel = computed(() => {
    const ready = Number(lodRuntime.value?.contentReadyTiles) || 0
    const total = Number(lodRuntime.value?.totalTiles) || 0
    if (total <= 0) return '0%'
    return `${Math.round((ready / total) * 100)}%`
  })

  const lodVisualSummary = computed(() => {
    const flags = []
    const mode = currentVisualizationMode.value
    if (mode === 'stage_color') flags.push('十级分层覆盖')
    if (mode === 'stage_wireframe') flags.push('十级分层 + 线框')
    if (mode === 'random_tiles') flags.push('随机瓦片')
    if (mode === 'random_wireframe') flags.push('随机瓦片 + 线框')
    if (lodRuntime.value?.debugShowGeometricError) flags.push('几何误差')
    if (lodRuntime.value?.debugShowRenderingStatistics) flags.push('渲染统计')
    if (lodRuntime.value?.debugShowMemoryUsage) flags.push('内存标签')
    return flags.length > 0 ? flags.join(' / ') : '未开启'
  })

  const classifyComplexityTier = (current, peak) => {
    if (!current || !peak) return { key: 'idle', label: '空闲', ratio: 0 }
    const ratio = peak <= 0 ? 0 : current / peak
    if (ratio >= 0.9) return { key: 'v5', label: '极高', ratio }
    if (ratio >= 0.72) return { key: 'v4', label: '高', ratio }
    if (ratio >= 0.5) return { key: 'v3', label: '中高', ratio }
    if (ratio >= 0.3) return { key: 'v2', label: '中', ratio }
    if (ratio >= 0.12) return { key: 'v1', label: '较低', ratio }
    return { key: 'v0', label: '极低', ratio }
  }

  const trianglesTier = computed(() =>
    classifyComplexityTier(lodRuntime.value?.trianglesSelected, peakTrianglesSelected.value)
  )

  const visibleTilesTier = computed(() =>
    classifyComplexityTier(lodRuntime.value?.selectedTiles, peakSelectedTiles.value)
  )

  const commandsTier = computed(() =>
    classifyComplexityTier(lodRuntime.value?.commands, peakCommands.value)
  )

  const stageDistribution = computed(() => {
    const counts = lodRuntime.value?.stageCounts || {}
    const total = STAGE_KEYS.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0)
    return STAGE_KEYS.map(key => {
      const count = Number(counts[key]) || 0
      const percent = total > 0 ? Math.round((count / total) * 100) : 0
      return {
        key,
        label: STAGE_LABELS[key],
        count,
        percent,
        color: STAGE_COLORS[key]
      }
    })
  })

  const lodComplexityIndex = computed(() => {
    const tri = trianglesTier.value.ratio * 45
    const tiles = visibleTilesTier.value.ratio * 25
    const cmds = commandsTier.value.ratio * 15
    const stage = (Number(lodRuntime.value?.lodStageScore) || 0) * 0.15
    return Math.round(Math.min(100, tri + tiles + cmds + stage))
  })

  const lodComplexityLabel = computed(() => {
    const score = lodComplexityIndex.value
    if (score >= 85) return '满细节'
    if (score >= 68) return '高细节'
    if (score >= 50) return '标准'
    if (score >= 32) return '简化'
    if (score >= 15) return '强简化'
    return '极简'
  })

  const lodMetricCards = computed(() => [
    {
      key: 'trianglesSelected',
      label: '当前三角面',
      value: formatMetricValue(lodRuntime.value?.trianglesSelected),
      hint: `峰值占比 ${Math.round(trianglesTier.value.ratio * 100)}% / ${trianglesTier.value.label}`
    },
    {
      key: 'selectedTiles',
      label: '可见瓦片',
      value: formatMetricValue(lodRuntime.value?.selectedTiles),
      hint: `峰值占比 ${Math.round(visibleTilesTier.value.ratio * 100)}% / ${visibleTilesTier.value.label}`
    },
    {
      key: 'contentReadyTiles',
      label: '已加载瓦片',
      value: `${formatMetricValue(lodRuntime.value?.contentReadyTiles)} / ${formatMetricValue(lodRuntime.value?.totalTiles)}`,
      hint: `内容就绪瓦片占比 ${tilesReadyRatioLabel.value}`
    },
    {
      key: 'commands',
      label: '渲染命令',
      value: formatMetricValue(lodRuntime.value?.commands),
      hint: `峰值占比 ${Math.round(commandsTier.value.ratio * 100)}% / ${commandsTier.value.label}`
    },
    {
      key: 'featuresSelected',
      label: '当前要素',
      value: formatMetricValue(lodRuntime.value?.featuresSelected),
      hint: '当前可见特征数量'
    },
    {
      key: 'pointsSelected',
      label: '当前点数',
      value: formatMetricValue(lodRuntime.value?.pointsSelected),
      hint: '点云或点要素模型时尤其有参考意义'
    }
  ])

  // ---- 新增：瓦片详情与分析数据 ----
  const tileDetailList = computed(() => {
    return lodRuntime.value?.tileDetailList || []
  })

  const geometricErrorDistribution = computed(() => {
    return lodRuntime.value?.geometricErrorDistribution || []
  })

  const screenSpaceErrorRange = computed(() => {
    return lodRuntime.value?.screenSpaceErrorRange || { min: 0, max: 0, avg: 0 }
  })

  const perStageStats = computed(() => {
    return lodRuntime.value?.perStageStats || {}
  })

  const stageTransitionInfo = computed(() => {
    return lodRuntime.value?.stageTransitionInfo || []
  })

  const maxBucketCount = computed(() => {
    const dist = geometricErrorDistribution.value
    if (!dist.length) return 0
    return Math.max(...dist.map(b => b.count))
  })

  const formatField = field => {
    if (field.type === 'checkbox') return ''
    const v = getFieldNumber(field)
    if (field.type === 'bytes_mb') return String(v)
    if (field.step < 1) return Number(v).toFixed(getStepDecimals(field.step))
    return String(v)
  }

  const getFieldNumber = field => {
    const v = local.value[field.key]
    if (field.type === 'bytes_mb') return bytesToMb(v)
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    return n
  }

  const setFieldNumber = (field, rawValue) => {
    const value = field.type === 'bytes_mb' ? clamp(rawValue, field.min, field.max) : rawValue
    local.value = {
      ...local.value,
      [field.key]:
        field.type === 'bytes_mb'
          ? mbToBytes(value)
          : field.step < 1
            ? Number(value)
            : Math.round(Number(value))
    }
    onLocalChange()
  }

  const setFieldBoolean = (field, checked) => {
    local.value = { ...local.value, [field.key]: Boolean(checked) }
    onLocalChange()
  }

  const apply = () => {
    if (!modelLoaded.value) {
      showMessage('模型未加载，无法应用配置', 'warning')
      return
    }
    const ok = updateLodConfig(sanitize(local.value))
    if (ok) {
      showMessage('LOD配置已应用', 'success')
    } else {
      showMessage('LOD配置应用失败', 'error')
    }
  }

  const rollback = () => {
    local.value = { ...lodConfig.value }
    presetKey.value = 'custom'
    showMessage('已撤销到当前已应用配置', 'info')
  }

  const reset = () => {
    resetLodConfig()
    local.value = { ...lodConfig.value }
    presetKey.value = 'balanced'
    showMessage('已重置为默认配置', 'info')
  }

  watch(
    lodConfig,
    v => {
      local.value = { ...v }
    },
    { immediate: true }
  )

  watch(
    () => lodRuntime.value?.trianglesSelected,
    value => {
      peakTrianglesSelected.value = Math.max(peakTrianglesSelected.value, Number(value) || 0)
    },
    { immediate: true }
  )

  watch(
    () => lodRuntime.value?.selectedTiles,
    value => {
      peakSelectedTiles.value = Math.max(peakSelectedTiles.value, Number(value) || 0)
    },
    { immediate: true }
  )

  watch(
    () => lodRuntime.value?.commands,
    value => {
      peakCommands.value = Math.max(peakCommands.value, Number(value) || 0)
    },
    { immediate: true }
  )

  watch(
    modelLoaded,
    loaded => {
      if (loaded) return
      peakTrianglesSelected.value = 0
      peakSelectedTiles.value = 0
      peakCommands.value = 0
    },
    { immediate: true }
  )

  watch(
    groups,
    v => {
      if (collapseInitialized) return
      openGroupIds.value = (v || []).filter(g => g.defaultOpen).map(g => g.id)
      collapseInitialized = true
    },
    { immediate: true }
  )

  return {
    modelLoaded,
    dirty,
    fps,
    memoryMb,
    presetKey,
    presetOptions,
    currentPresetLabel,
    detailTierLabel,
    requestStageLabel,
    adaptiveStatusLabel,
    adaptivePressureLabel,
    tilesReadyRatioLabel,
    lodVisualSummary,
    lodComplexityIndex,
    lodComplexityLabel,
    trianglesTier,
    visibleTilesTier,
    commandsTier,
    stageDistribution,
    stageLegend,
    visualizationModeOptions,
    currentVisualizationMode,
    lodMetricCards,
    openGroupIds,
    groups,
    local,
    lodRuntime,
    adaptiveLoadState,
    lodVisualizationState,
    // 新增导出
    tileDetailList,
    geometricErrorDistribution,
    screenSpaceErrorRange,
    perStageStats,
    stageTransitionInfo,
    maxBucketCount,
    // 方法
    applyPreset,
    formatField,
    formatMetricValue,
    getFieldNumber,
    getFieldHint,
    isFieldDisabled,
    setVisualizationMode,
    setFieldNumber,
    setFieldBoolean,
    apply,
    rollback,
    reset
  }
}
