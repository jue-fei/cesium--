<template>
  <div class="mt-3 kco-panel">
    <BlastKcoEditor
      v-model:section-form="sectionForm"
      v-model:kco-params="kcoParams"
      :cut-pattern="cutPattern"
      :section-derived="sectionDerived"
      :selected-preset-key="selectedPresetKey"
      :site-presets="sitePresets"
      :explosive-types="EXPLOSIVE_TYPES"
      :explosive-type="explosiveType"
      :advanced-open="advancedOpen"
      @apply-section="applySection"
      @update:cut-pattern="cutPattern = $event"
      @update:selected-preset-key="selectedPresetKey = $event"
      @apply-preset="applyPreset"
      @explosive-select="onExplosiveSelect"
      @toggle-advanced="advancedOpen = !advancedOpen"
    />

    <BlastKcoInsights
      :dataset="dataset"
      :kco-params="kcoParams"
      :kco-source-label="kcoSourceLabel"
      :kco-x50="kcoX50"
      :kco-n="kcoN"
      :kco-xmax="kcoXmax"
      :kco-x80="kcoX80"
      :broken-volume="brokenVolume"
      :fragment-count-est="fragmentCountEst"
      :trend-cards="trendCards"
      :kco-replaying="kcoReplaying"
      :preset-name="presetName"
      :selected-preset-id="selectedPresetId"
      :preset-list="presetList"
      @apply-replay="applyKcoAndReplay"
      @reset-kco="$emit('reset-kco')"
      @update:preset-name="presetName = $event"
      @update:selected-preset-id="selectedPresetId = $event"
      @save-preset="savePreset"
      @load-preset="loadPreset"
      @delete-preset="deletePreset"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import BlastKcoEditor from './BlastKcoEditor.vue'
import BlastKcoInsights from './BlastKcoInsights.vue'
import {
  KCO_SOURCE_MODE,
  calculateKCOParams,
  EXPLOSIVE_TYPES
} from '../services/core/computation/kcoModelCore.js'
import { fetchKcoSitePresets } from '../services/blastingApi.js'
import { calcTunnelArea } from '../services/core/blastDefaults.js'
import {
  buildBlastPreviewInsights,
  snapshotBaselineParams
} from '../services/core/computation/blastPreviewInsights.js'

defineOptions({ name: 'BlastKcoPanel' })

const props = defineProps({
  dataset: { type: Object, default: null },
  blastDesign: { type: Object, default: null },
  kcoModel: { type: Object, required: true }
})

const emit = defineEmits(['replay-blast', 'reset-kco', 'update-section', 'update-kco'])

const kcoParams = ref({})
let syncingKcoFromParent = false

function syncKcoDraft(next = {}) {
  syncingKcoFromParent = true
  const obj = kcoParams.value
  for (const key of Object.keys(obj)) {
    if (!(key in next)) delete obj[key]
  }
  Object.assign(obj, next)
  syncingKcoFromParent = false
}

watch(
  () => props.kcoModel,
  next => {
    syncKcoDraft(next || {})
  },
  { immediate: true, deep: true }
)

watch(
  kcoParams,
  next => {
    if (syncingKcoFromParent) return
    emit('update-kco', { ...next })
  },
  { deep: true }
)

const sectionForm = ref({
  width: 12,
  wallHeight: 5,
  archRadius: 6,
  shape: 'horseshoe'
})
const cutPattern = ref('diamond')

watch(
  () => props.blastDesign?.section,
  section => {
    if (!section) return
    if (section.W != null) sectionForm.value.width = section.W
    if (section.wallHeight != null) sectionForm.value.wallHeight = section.wallHeight
    if (section.archRadius != null) sectionForm.value.archRadius = section.archRadius
    if (section.shape != null) sectionForm.value.shape = section.shape
  },
  { immediate: true }
)

const sectionDerived = computed(() => {
  const { width: widthValue, wallHeight, archRadius, shape } = sectionForm.value
  return {
    totalH: wallHeight + archRadius,
    area: calcTunnelArea(shape, widthValue, wallHeight, archRadius)
  }
})

function applySection() {
  emit('update-section', {
    width: Number(sectionForm.value.width),
    wallHeight: Number(sectionForm.value.wallHeight),
    archRadius: Number(sectionForm.value.archRadius),
    shape: sectionForm.value.shape,
    cutPattern: cutPattern.value
  })
}

const kcoPreview = computed(() => {
  const params = {}
  const src = kcoParams.value
  for (const key of Object.keys(src || {})) {
    params[key] = key === 'sourceMode' || key === 'explosiveType' ? src[key] : Number(src[key])
  }
  return calculateKCOParams(params)
})

const kcoSourceLabel = computed(() => {
  return kcoPreview.value?.sourceMode === KCO_SOURCE_MODE.RESULT ? '结果驱动' : '设计驱动'
})

const kcoX50 = computed(() => {
  const x50 = kcoPreview.value?.x50
  return Number.isFinite(x50) ? x50 : 0
})

const kcoN = computed(() => {
  const n = kcoPreview.value?.n
  return Number.isFinite(n) ? n : 0.5
})

const kcoXmax = computed(() => {
  const value = Number(kcoParams.value.xmax)
  return Math.max(0.2, Math.min(5.0, Number.isFinite(value) ? value : 2.0))
})

const selectedPresetKey = ref('')

// 场地预设：数据真源已后端化（backend-py/config/kco_site_presets.json），
// 运行时经 GET /api/blasting/kco-site-presets 拉取一次；拉取失败时下拉为空，
// KCO 参数仍可在编辑器中手动输入。
const sitePresets = ref({})
onMounted(async () => {
  try {
    sitePresets.value = (await fetchKcoSitePresets()) || {}
  } catch {
    sitePresets.value = {}
  }
})

function applyPreset() {
  const preset = sitePresets.value[selectedPresetKey.value]
  if (!preset) return
  for (const key of Object.keys(preset)) {
    if (key === 'label') continue
    kcoParams.value[key] = preset[key]
  }
  const matchedType = Object.keys(EXPLOSIVE_TYPES).find(
    type => EXPLOSIVE_TYPES[type].SANFO === preset.SANFO
  )
  if (matchedType) kcoParams.value.explosiveType = matchedType
  ElMessage.success(`已应用预设：${preset.label}`)
}

const explosiveType = computed({
  get: () => kcoParams.value.explosiveType || 'emulsion',
  set: value => {
    kcoParams.value.explosiveType = value
  }
})

function onExplosiveChange() {
  const info = EXPLOSIVE_TYPES[explosiveType.value]
  if (!info) return
  kcoParams.value.SANFO = info.SANFO
  kcoParams.value.Eg = info.Eg
}

function onExplosiveSelect(event) {
  explosiveType.value = event?.target?.value || 'emulsion'
  onExplosiveChange()
}

const advancedOpen = ref(false)
const baselineParams = ref(null)

watch(
  () => props.dataset?.event?.eventId || props.dataset?.event?.id || null,
  () => {
    if (!props.dataset) {
      baselineParams.value = null
      return
    }
    baselineParams.value = snapshotBaselineParams(kcoParams.value)
  },
  { immediate: true }
)

const previewInsights = computed(() =>
  buildBlastPreviewInsights({
    currentParams: kcoParams.value,
    baselineParams: baselineParams.value
  })
)

const kcoX80 = computed(() => previewInsights.value.kcoX80 || 0)
const brokenVolume = computed(() => previewInsights.value.brokenVolume || 0)
const fragmentCountEst = computed(() => previewInsights.value.fragmentCountEst || 0)
const trendCards = computed(() => previewInsights.value.trendCards || [])

const kcoReplaying = ref(false)
let kcoDebounceTimer = null
let kcoNeedsReplay = false

function applyKcoAndReplay() {
  if (!props.dataset) return
  kcoParams.value.sourceMode = KCO_SOURCE_MODE.DESIGN
  kcoReplaying.value = true
  emit('replay-blast')
  setTimeout(() => {
    kcoReplaying.value = false
  }, 600)
}

watch(
  () => {
    const rest = { ...kcoParams.value }
    delete rest.sourceMode
    return JSON.stringify(rest)
  },
  () => {
    if (!props.dataset) return
    if (kcoReplaying.value) {
      kcoNeedsReplay = true
      return
    }
    if (kcoDebounceTimer) clearTimeout(kcoDebounceTimer)
    kcoDebounceTimer = setTimeout(() => {
      kcoReplaying.value = true
      kcoParams.value.sourceMode = KCO_SOURCE_MODE.DESIGN
      emit('replay-blast')
      setTimeout(() => {
        kcoReplaying.value = false
        if (!kcoNeedsReplay) return
        kcoNeedsReplay = false
        kcoDebounceTimer = setTimeout(() => {
          kcoReplaying.value = true
          kcoParams.value.sourceMode = KCO_SOURCE_MODE.DESIGN
          emit('replay-blast')
          setTimeout(() => {
            kcoReplaying.value = false
          }, 600)
        }, 200)
      }, 600)
    }, 800)
  }
)

const PRESET_STORAGE_KEY = 'blasting_presets'
const presetName = ref('')
const selectedPresetId = ref('')
const presetList = ref([])

function formatPresetTime(ts) {
  const date = new Date(ts)
  const pad = num => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function loadPresetList() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY)
    presetList.value = raw ? JSON.parse(raw) : []
  } catch {
    presetList.value = []
  }
}

function persistPresets() {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presetList.value))
  } catch {
    ElMessage.error('方案保存失败：本地存储不可用')
  }
}

function savePreset() {
  const name = presetName.value.trim()
  if (!name) {
    ElMessage.warning('请输入方案名称')
    return
  }
  presetList.value.unshift({
    id: `preset_${Date.now()}`,
    name,
    savedAt: formatPresetTime(Date.now()),
    params: { ...kcoParams.value }
  })
  persistPresets()
  presetName.value = ''
  ElMessage.success(`方案「${name}」已保存`)
}

function loadPreset() {
  const preset = presetList.value.find(item => item.id === selectedPresetId.value)
  if (!preset) {
    ElMessage.warning('未找到该方案')
    return
  }
  Object.assign(kcoParams.value, preset.params)
  ElMessage.success(`方案「${preset.name}」已加载`)
}

function deletePreset() {
  const index = presetList.value.findIndex(item => item.id === selectedPresetId.value)
  if (index < 0) return
  const name = presetList.value[index].name
  presetList.value.splice(index, 1)
  persistPresets()
  selectedPresetId.value = ''
  ElMessage.success(`方案「${name}」已删除`)
}

loadPresetList()
</script>
