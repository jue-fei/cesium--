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
      属性信息: {{ selectedModel.name }}
    </div>
    <div class="grid grid-cols-2 gap-2 bg-black/20 p-2 rounded-md border border-white/5">
      <div class="flex flex-col">
        <span class="text-[10px] text-gray-400 mb-0.5">ID</span>
        <span class="text-xs text-gray-200 break-all">{{ selectedModel.id || '-' }}</span>
      </div>
      <div class="flex flex-col">
        <span class="text-[10px] text-gray-400 mb-0.5">名称</span>
        <span class="text-xs text-gray-200 break-all">{{ selectedModel.name || '-' }}</span>
      </div>
      <div class="flex flex-col">
        <span class="text-[10px] text-gray-400 mb-0.5">类型</span>
        <span class="text-xs text-gray-200 break-all">{{ selectedModel.type || '未知' }}</span>
      </div>
      <div
        v-for="(entry, index) in displayProperties"
        :key="entry.key || index"
        class="flex flex-col"
      >
        <span class="text-[10px] text-gray-400 mb-0.5">{{ entry.key || '属性' }}</span>
        <span class="text-xs text-gray-200 break-all">{{ entry.value }}</span>
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
import useModel from '../../model-control/services/useModel.js'

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

const displayProperties = computed(() => {
  if (!selectedModel.value) return []
  const props = selectedModel.value.geologyProperties || {}
  return Object.keys(props).map(key => ({ key, value: props[key] }))
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
  if (selectedModel.value && selectedModel.value.geologyProperties) {
    const text = JSON.stringify(selectedModel.value.geologyProperties, null, 2)
    navigator.clipboard.writeText(text).then(() => {
      alert('属性已复制到剪贴板')
    })
  }
}
</script>
