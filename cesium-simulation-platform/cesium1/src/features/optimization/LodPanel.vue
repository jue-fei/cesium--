<template>
  <div class="p-4 text-text-primary text-base overflow-x-hidden">
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-1.5">
        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
          <span
            class="inline-flex items-center h-6 px-2 rounded border text-[11px] leading-none whitespace-nowrap"
            :class="
              modelLoaded
                ? 'border-success/40 text-success bg-success/10'
                : 'border-border-primary text-text-muted bg-white/5'
            "
            >{{ modelLoaded ? '模型已加载' : '等待模型' }}</span
          >
          <span
            class="inline-flex items-center h-6 px-2 rounded border text-[11px] leading-none whitespace-nowrap"
            :class="
              dirty
                ? 'border-warning/40 text-warning bg-warning/10'
                : 'border-border-primary text-text-muted bg-white/5'
            "
            >{{ dirty ? '未应用' : '已应用' }}</span
          >
        </div>

        <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <span
            class="inline-flex items-center h-6 px-2 rounded border border-border-primary bg-white/5 text-[11px] leading-none whitespace-nowrap text-text-muted font-mono"
          >
            FPS {{ fps }}
          </span>
          <span
            class="inline-flex items-center h-6 px-2 rounded border border-border-primary bg-white/5 text-[11px] leading-none whitespace-nowrap text-text-muted font-mono"
          >
            MEM {{ memoryMb }}MB
          </span>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">预设</div>
        <div class="flex flex-col gap-2">
          <el-radio-group
            class="!flex !flex-wrap w-full gap-2"
            :model-value="presetKey"
            size="default"
            @update:model-value="applyPreset"
          >
            <el-radio-button v-for="p in presetOptions" :key="p.key" :value="p.key" class="!mr-0">
              {{ p.label }}
            </el-radio-button>
          </el-radio-group>
          <div class="text-xs text-text-muted">当前：{{ currentPresetLabel }}</div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">参数</div>
        <el-collapse v-model="openGroupIds" class="!border-0">
          <el-collapse-item
            v-for="group in groups"
            :key="group.id"
            :name="group.id"
            class="!border-border-primary !bg-white/5 rounded mb-3 overflow-hidden"
          >
            <template #title>
              <div class="flex items-center justify-between w-full pr-2">
                <div class="flex flex-col">
                  <div class="text-sm font-semibold text-text-primary">{{ group.title }}</div>
                  <div v-if="group.subtitle" class="text-[11px] text-text-muted">
                    {{ group.subtitle }}
                  </div>
                </div>
              </div>
            </template>

            <div class="px-2 py-2 rounded-lg bg-black/10">
              <div v-for="field in group.fields" :key="field.key" class="control-item !mb-2.5">
                <div class="control-header">
                  <div class="flex items-center gap-2">
                    <div class="control-label !text-sm">{{ field.label }}</div>
                    <el-tooltip
                      v-if="field.hint"
                      :content="field.hint"
                      placement="top"
                      effect="dark"
                      :show-after="250"
                    >
                      <el-icon class="text-text-muted" :size="16">
                        <InfoFilled />
                      </el-icon>
                    </el-tooltip>
                  </div>

                  <div v-if="field.type !== 'checkbox'" class="flex items-center gap-1">
                    <span class="control-value !text-xs">{{ formatField(field) }}</span>
                    <span v-if="field.type === 'bytes_mb'" class="text-[10px] text-text-muted"
                      >MB</span
                    >
                  </div>
                </div>

                <div class="control-body !gap-1.5">
                  <el-switch
                    v-if="field.type === 'checkbox'"
                    :model-value="Boolean(local[field.key])"
                    size="default"
                    @update:model-value="v => setFieldBoolean(field, v)"
                  />

                  <template v-else>
                    <el-slider
                      class="control-slider"
                      :min="field.min"
                      :max="field.max"
                      :step="field.step"
                      :model-value="getFieldNumber(field)"
                      @update:model-value="v => setFieldNumber(field, v)"
                    />
                    <el-input-number
                      class="control-input"
                      :min="field.min"
                      :max="field.max"
                      :step="field.step"
                      :controls="false"
                      :model-value="getFieldNumber(field)"
                      @update:model-value="v => setFieldNumber(field, v)"
                    />
                  </template>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">操作</div>
        <div class="flex items-center gap-3">
          <el-button
            type="primary"
            class="flex-1"
            :disabled="!modelLoaded || !dirty"
            @click="apply"
          >
            应用到场景
          </el-button>
          <el-button :disabled="!dirty" @click="rollback">撤销</el-button>
          <el-button @click="reset">默认</el-button>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">运行状态</div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div class="min-w-0 rounded border border-border-primary bg-black/10 p-3">
            <div class="text-text-muted">请求队列</div>
            <div class="font-mono text-text-primary">{{ lodRuntime.pendingRequests || 0 }}</div>
          </div>
          <div class="min-w-0 rounded border border-border-primary bg-black/10 p-3">
            <div class="text-text-muted">解码/处理</div>
            <div class="font-mono text-text-primary">{{ lodRuntime.tilesProcessing || 0 }}</div>
          </div>
          <div class="min-w-0 rounded border border-border-primary bg-black/10 p-3">
            <div class="text-text-muted">瓦片内存 (MB)</div>
            <div class="font-mono text-text-primary">{{ memoryMb }}</div>
          </div>
          <div class="min-w-0 rounded border border-border-primary bg-black/10 p-3">
            <div class="text-text-muted">当前视角</div>
            <div class="font-mono text-text-primary">
              {{
                lodRuntime.allTilesLoaded
                  ? '完成'
                  : lodRuntime.initialTilesLoaded
                    ? '首屏'
                    : '进行中'
              }}
            </div>
          </div>
        </div>
        <div class="text-xs text-text-muted mt-2">
          说明：统计值随相机视角变化，用于定位卡顿与内存压力来源
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import useModel from '@/composables/useModel.js'
import useMessage from '@/composables/useMessage.js'
import { PRESETS } from '@/config/constants/modelConfig.js'

const {
  lodConfig,
  updateLodConfig,
  resetLodConfig,
  tilesetRef,
  fps,
  DEFAULT_LOD_CONFIG,
  lodRuntime
} = useModel()
const { showMessage } = useMessage()

const local = ref({})
const modelLoaded = computed(() => !!tilesetRef.value)
const presetKey = ref('balanced')
const openGroupIds = ref([])
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

const applyPreset = key => {
  presetKey.value = key
  if (key === 'custom') return
  const preset = PRESETS[key]
  local.value = { ...DEFAULT_LOD_CONFIG, ...(preset && preset.config ? preset.config : {}) }
  apply()
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
        min: 0,
        max: 0.01,
        step: 0.00001,
        type: 'number',
        hint: '越大越影响近处；越小越影响远处'
      },
      {
        key: 'dynamicScreenSpaceErrorFactor',
        label: '强度',
        min: 0,
        max: 64,
        step: 1,
        type: 'number',
        hint: '越大越偏性能（远处更容易降细节）'
      },
      {
        key: 'dynamicScreenSpaceErrorHeightFalloff',
        label: '高度衰减',
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
        min: 0,
        max: 1,
        step: 0.01,
        type: 'number',
        hint: '取值 0–1；越大越接近全屏优先'
      },
      {
        key: 'foveatedMinimumScreenSpaceErrorRelaxation',
        label: '边缘放松起点',
        min: 0,
        max: 64,
        step: 1,
        type: 'number',
        hint: '越大边缘越延后'
      },
      {
        key: 'foveatedTimeDelay',
        label: '停下后延迟',
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
        min: 0,
        max: 4096,
        step: 32,
        type: 'number',
        hint: '达到阈值后启用跳级'
      },
      {
        key: 'skipScreenSpaceErrorFactor',
        label: '跳级因子',
        min: 1,
        max: 64,
        step: 1,
        type: 'number',
        hint: '越大越容易跳级'
      },
      {
        key: 'skipLevels',
        label: '最小跳级层数',
        min: 0,
        max: 10,
        step: 1,
        type: 'number',
        hint: '0 表示不跳级'
      },
      {
        key: 'immediatelyLoadDesiredLevelOfDetail',
        label: '仅加载目标细节',
        type: 'checkbox',
        hint: '按目标阈值直达，补齐更慢'
      },
      {
        key: 'loadSiblings',
        label: '加载相邻瓦片',
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
  }
])

const flattenFields = groupsValue => groupsValue.reduce((acc, g) => acc.concat(g.fields || []), [])

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
  groups,
  v => {
    if (collapseInitialized) return
    openGroupIds.value = (v || []).filter(g => g.defaultOpen).map(g => g.id)
    collapseInitialized = true
  },
  { immediate: true }
)
</script>

<style scoped>
:deep(.control-item) {
  margin-bottom: 10px;
}

:deep(.control-header) {
  margin-bottom: 4px;
}

:deep(.control-input) {
  width: 72px !important;
}

:deep(.control-slider .el-slider__runway) {
  margin: 6px 0 !important;
}

:deep(.control-input .el-input__wrapper) {
  padding: 0 6px !important;
}

:deep(.control-input .el-input__inner) {
  height: 28px;
  line-height: 28px;
  font-size: 12px;
}
</style>
