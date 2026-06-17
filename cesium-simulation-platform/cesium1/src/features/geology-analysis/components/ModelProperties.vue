<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      模型查询
    </div>
    <div class="flex gap-2">
      <input
        v-model="searchId"
        class="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
        placeholder="输入模型ID"
        @keyup.enter="handleSearch"
      />
      <button
        class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
        @click="handleSearch"
      >
        搜索
      </button>
    </div>
    <div v-if="searchTouched" class="mt-2">
      <div v-if="searchResults.length" class="space-y-1">
        <div
          v-for="model in searchResults"
          :key="model.id"
          class="flex items-center justify-between bg-black/20 rounded px-2 py-1 border border-white/5"
        >
          <div class="flex flex-col">
            <span class="text-xs text-gray-200">{{ model.name }}</span>
            <span class="text-[10px] text-gray-400 break-all">{{ model.id }}</span>
          </div>
          <div class="flex gap-1">
            <button
              class="px-2 py-0.5 rounded bg-white/10 border border-white/20 text-[10px] text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
              @click="selectModel(model)"
            >
              选择
            </button>
            <button
              class="px-2 py-0.5 rounded bg-white/10 border border-white/20 text-[10px] text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
              @click="soloModel(model)"
            >
              独显
            </button>
          </div>
        </div>
      </div>
      <div v-else class="text-xs text-gray-400">未找到匹配模型</div>
    </div>
  </div>

  <div
    v-if="selectedModel"
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      属性信息: {{ selectedModel.name
      }}<span
        v-if="selectedModel._dbLinked"
        class="ml-1 text-[10px] text-blue-400"
        title="已关联数据库"
        >◈ DB</span
      >
    </div>
    <div class="grid grid-cols-2 gap-2 bg-black/20 p-2 rounded-md border border-white/5">
      <div
        v-for="(entry, index) in basicFeatureEntries"
        :key="entry.key || index"
        class="flex flex-col"
      >
        <span class="text-[10px] text-gray-400 mb-0.5">{{ entry.key || '属性' }}</span>
        <span class="text-xs text-gray-200 break-all">{{ entry.value }}</span>
      </div>
    </div>
    <div v-if="featureSections.length" class="space-y-3 mt-3">
      <div
        v-for="section in featureSections"
        :key="section.key"
        class="bg-black/20 p-2 rounded-md border border-white/5"
      >
        <div class="text-xs font-semibold text-blue-100 mb-2">{{ section.title }}</div>
        <div class="grid grid-cols-2 gap-2">
          <div
            v-for="(entry, entryIndex) in section.entries"
            :key="`${section.key}-${entry.key || entryIndex}`"
            class="flex flex-col"
          >
            <span class="text-[10px] text-gray-400 mb-0.5">{{ entry.key || '属性' }}</span>
            <span class="text-xs text-gray-200 break-all whitespace-pre-wrap">{{
              entry.value
            }}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="flex flex-wrap gap-2 items-center mt-3">
      <button
        class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
        @click="openEditDialog"
      >
        修改
      </button>
      <button
        class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
        @click="soloModel(selectedModel)"
      >
        独显
      </button>
      <button
        class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
        @click="showAllModels"
      >
        全显
      </button>
      <button
        class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
        @click="copyPropertiesToClipboard"
      >
        复制属性
      </button>
    </div>
  </div>

  <el-dialog
    v-model="editDialogVisible"
    width="80vw"
    top="5vh"
    :append-to-body="true"
    :close-on-click-modal="false"
    :before-close="handleEditDialogBeforeClose"
  >
    <template #header>
      <div class="flex flex-col">
        <div class="text-sm font-semibold text-text-primary">编辑属性</div>
        <div class="text-xs text-text-muted">{{ selectedModel?.name }}</div>
      </div>
    </template>

    <div class="max-h-[70vh] overflow-auto pr-1">
      <div class="grid grid-cols-2 gap-3 bg-black/20 p-3 rounded-md border border-white/5">
        <div class="flex flex-col">
          <span class="text-[10px] text-gray-400 mb-0.5">ID</span>
          <input
            v-model="editId"
            class="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div class="flex flex-col">
          <span class="text-[10px] text-gray-400 mb-0.5">名称</span>
          <input
            v-model="editName"
            class="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div class="flex flex-col">
          <span class="text-[10px] text-gray-400 mb-0.5">类型</span>
          <span class="text-xs text-gray-200 break-all">{{ selectedModel?.type || '未知' }}</span>
        </div>
        <div v-for="(entry, index) in propertyEntries" :key="index" class="flex flex-col">
          <span class="text-[10px] text-gray-400 mb-0.5">属性 {{ index + 1 }}</span>
          <div class="flex gap-1 items-center">
            <input
              v-model="entry.key"
              class="w-1/2 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="属性名"
            />
            <input
              v-model="entry.value"
              class="w-1/2 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="属性值"
            />
            <button
              class="px-2 py-1 rounded bg-white/10 border border-white/20 text-[10px] text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
              @click="removeProperty(index)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap gap-2 justify-end">
        <button
          class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
          @click="cancelEdit"
        >
          取消
        </button>
        <button
          class="px-3 py-1.5 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
          @click="addProperty"
        >
          新增属性
        </button>
        <button
          class="px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-500"
          @click="saveEdit"
        >
          保存
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import useModel from '@/features/model-control/services/useModel.js'

const {
  modelList,
  selectedModel,
  syncModelInfo,
  showOnlyModel,
  showAllModels,
  updateModelId,
  saveModelConfig
} = useModel()

const searchId = ref('')
const searchResults = ref([])
const searchTouched = ref(false)

watch(searchId, newValue => {
  const query = newValue.trim().toLowerCase()
  if (!query) {
    searchResults.value = []
    searchTouched.value = false
  }
})

const handleSearch = () => {
  searchTouched.value = true
  const query = searchId.value.trim().toLowerCase()
  if (!query) {
    searchResults.value = []
    return
  }
  searchResults.value = modelList.value.filter(model => {
    const idText = String(model.id || '').toLowerCase()
    const featureText = String(model.featureId || '').toLowerCase()
    return idText.includes(query) || featureText.includes(query)
  })
}

const selectModel = model => {
  syncModelInfo(model)
}

const soloModel = model => {
  if (model) showOnlyModel(model)
}

const editId = ref('')
const editName = ref('')
const editDialogVisible = ref(false)
const propertyEntries = ref([])

const SECTION_TITLE_MAP = {
  style_properties: '样式属性',
  styleProperties: '样式属性',
  geology_properties: '地质属性',
  geologyProperties: '地质属性',
  mining_properties: '采矿属性',
  miningProperties: '采矿属性',
  safety_properties: '安全属性',
  safetyProperties: '安全属性'
}

const RESERVED_FEATURE_KEYS = new Set([
  'id',
  'feature_id',
  'featureId',
  'name',
  'type',
  'category',
  'style_properties',
  'styleProperties',
  'geology_properties',
  'geologyProperties',
  'mining_properties',
  'miningProperties',
  'safety_properties',
  'safetyProperties'
])

const isPlainObject = value => Object.prototype.toString.call(value) === '[object Object]'

const getObjectValueByKeys = (target, keys) => {
  if (!isPlainObject(target)) return undefined
  for (const key of keys) {
    if (key in target) return target[key]
  }
  return undefined
}

const toSectionTitle = key => {
  if (!key) return '属性信息'
  if (SECTION_TITLE_MAP[key]) return SECTION_TITLE_MAP[key]
  const readable = String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return readable || '属性信息'
}

const formatValue = value => {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const mergeSectionValue = (source, currentValue) => {
  const rawSection = isPlainObject(source) ? source : {}
  const currentSection = isPlainObject(currentValue) ? currentValue : {}
  // source（数据库原始数据）为基础，current（用户编辑）覆盖
  return { ...rawSection, ...currentSection }
}

/**
 * 模型属性快照 - 以数据库 sourceFeature 为主体，
 * 用户编辑过的字段（model.geologyProperties 等）覆盖数据库原始值
 */
const featureSnapshot = computed(() => {
  const model = selectedModel.value
  if (!model) return null

  // sourceFeature 是加载时数据库数据的深层拷贝，为渲染主体
  const sourceFeature = isPlainObject(model.sourceFeature) ? model.sourceFeature : {}
  const featureId =
    model.featureId || model.id || sourceFeature.feature_id || sourceFeature.featureId || ''

  // 以数据库原始数据为基底 (...sourceFeature)，用户编辑覆盖特定字段
  return {
    ...sourceFeature,
    id: model.id || sourceFeature.id || featureId || '',
    feature_id: sourceFeature.feature_id || featureId || '',
    name: model.name || sourceFeature.name || '',
    type: model.type || sourceFeature.type || '',
    category: model.category || sourceFeature.category || '',
    _dbLinked: model._dbLinked || false,
    style_properties: mergeSectionValue(
      getObjectValueByKeys(sourceFeature, ['style_properties', 'styleProperties']),
      model.styleProperties
    ),
    geology_properties: mergeSectionValue(
      getObjectValueByKeys(sourceFeature, ['geology_properties', 'geologyProperties']),
      model.geologyProperties
    ),
    mining_properties: mergeSectionValue(
      getObjectValueByKeys(sourceFeature, ['mining_properties', 'miningProperties']),
      model.miningProperties
    ),
    safety_properties: mergeSectionValue(
      getObjectValueByKeys(sourceFeature, ['safety_properties', 'safetyProperties']),
      model.safetyProperties
    )
  }
})

const basicFeatureEntries = computed(() => {
  const snapshot = featureSnapshot.value
  if (!snapshot) return []

  const dataSource = snapshot._dbLinked ? '数据库' : '3D模型默认'
  const entries = [
    { key: 'ID', value: formatValue(snapshot.id) },
    { key: '名称', value: formatValue(snapshot.name) },
    { key: '类型', value: formatValue(snapshot.type || '未知') },
    { key: '数据来源', value: dataSource }
  ]

  const featureId = snapshot.feature_id || snapshot.featureId
  if (featureId && featureId !== snapshot.id) {
    entries.push({ key: 'Feature ID', value: formatValue(featureId) })
  }
  if (snapshot.category) {
    entries.push({ key: '分类', value: formatValue(snapshot.category) })
  }

  // 渲染数据库中的所有标量字段（非对象、非保留字段）
  Object.entries(snapshot).forEach(([key, value]) => {
    if (RESERVED_FEATURE_KEYS.has(key) || isPlainObject(value) || key.startsWith('_')) return
    entries.push({ key: toSectionTitle(key), value: formatValue(value) })
  })

  return entries
})

const featureSections = computed(() => {
  const snapshot = featureSnapshot.value
  if (!snapshot) return []

  const sections = []
  const pushSection = (key, title, value) => {
    if (!isPlainObject(value)) return
    const entries = Object.entries(value).map(([entryKey, entryValue]) => ({
      key: entryKey,
      value: formatValue(entryValue)
    }))
    if (entries.length) {
      sections.push({ key, title, entries })
    }
  }

  pushSection('style_properties', '样式属性', snapshot.style_properties)
  pushSection('geology_properties', '地质属性', snapshot.geology_properties)
  pushSection('mining_properties', '采矿属性', snapshot.mining_properties)
  pushSection('safety_properties', '安全属性', snapshot.safety_properties)

  Object.entries(snapshot).forEach(([key, value]) => {
    if (RESERVED_FEATURE_KEYS.has(key) || !isPlainObject(value)) return
    pushSection(key, toSectionTitle(key), value)
  })

  return sections
})

const syncLocalFromSelectedModel = () => {
  const model = selectedModel.value
  if (!model) return
  editId.value = model.id || ''
  editName.value = model.name || ''
  propertyEntries.value = Object.keys(model.geologyProperties || {}).map(key => ({
    key,
    value: model.geologyProperties[key]
  }))
}

watch(
  selectedModel,
  model => {
    if (!model) return
    syncLocalFromSelectedModel()
    editDialogVisible.value = false
  },
  { immediate: true }
)

const addProperty = () => {
  propertyEntries.value.push({ key: '', value: '' })
}

const removeProperty = index => {
  propertyEntries.value.splice(index, 1)
}

const openEditDialog = () => {
  if (!selectedModel.value) return
  syncLocalFromSelectedModel()
  editDialogVisible.value = true
}

const cancelEdit = () => {
  syncLocalFromSelectedModel()
  editDialogVisible.value = false
}

const handleEditDialogBeforeClose = done => {
  syncLocalFromSelectedModel()
  done()
}

const saveEdit = async () => {
  if (!selectedModel.value) return
  let changed = false
  if (editName.value && editName.value !== selectedModel.value.name) {
    selectedModel.value.name = editName.value
    changed = true
  }
  if (editId.value && editId.value !== selectedModel.value.id) {
    const updated = updateModelId(selectedModel.value, editId.value)
    if (updated) changed = true
  }
  const nextProperties = {}
  propertyEntries.value.forEach(entry => {
    const key = String(entry.key || '').trim()
    if (!key) return
    nextProperties[key] = entry.value ?? ''
  })
  selectedModel.value.geologyProperties = { ...nextProperties }
  selectedModel.value.includeInConfig = true
  changed = true
  if (changed) await saveModelConfig()
  editDialogVisible.value = false
}

const copyPropertiesToClipboard = () => {
  if (featureSnapshot.value) {
    const text = JSON.stringify(featureSnapshot.value, null, 2)
    navigator.clipboard.writeText(text).then(() => {
      alert('属性已复制到剪贴板')
    })
  }
}
</script>
