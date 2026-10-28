<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div class="flex justify-between items-center mb-3">
      <span
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
        >模型管理</span
      >
      <button
        v-if="!isConfigPanelOpen"
        class="p-1 rounded bg-transparent text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
        title="配置"
        @click="toggleConfigPanel"
      >
        <span class="text-sm">⚙️</span>
      </button>
    </div>

    <!-- 配置文件管理 -->
    <transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="max-h-0 opacity-0 overflow-hidden"
      enter-to-class="max-h-[200px] opacity-100"
      leave-active-class="transition-all duration-300 ease-in"
      leave-from-class="max-h-[200px] opacity-100"
      leave-to-class="max-h-0 opacity-0 overflow-hidden"
    >
      <div v-if="isConfigPanelOpen" class="mb-3 bg-black/20 rounded p-3 border border-white/5">
        <div class="mb-2">
          <div class="flex justify-between items-center mb-1 text-xs text-gray-400">
            <span>配置文件</span>
            <button
              class="text-blue-400 hover:text-blue-300 hover:underline"
              @click="toggleConfigPanel"
            >
              收起
            </button>
          </div>
          <select
            v-model="currentConfigFileLocal"
            :disabled="undergroundViewEnabled || switching"
            class="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            @change="handleLoadConfig"
          >
            <option value="">请选择配置文件</option>
            <option v-for="file in modelConfigFiles" :key="file.path" :value="file.path">
              {{ file.name }}{{ isModelCached(file.path) ? ' ⚡' : '' }}
            </option>
          </select>
          <p v-if="undergroundViewEnabled" class="mt-1 text-[11px] text-gray-500">
            地下模式开启时不可切换模型
          </p>
        </div>
        <div class="flex gap-2">
          <button
            :disabled="undergroundViewEnabled || switching"
            class="px-3 py-1 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            @click="reloadCurrentConfig"
          >
            {{ switching ? '切换中...' : '刷新' }}
          </button>
        </div>
      </div>
    </transition>

    <!-- 全局透明度 -->
    <div class="mb-3">
      <div class="flex justify-between items-center mb-1 text-xs text-gray-400">
        <span>全局透明度</span>
        <span class="text-blue-400 font-mono">{{ globalOpacityLocal }}%</span>
      </div>
      <div>
        <input
          v-model.number="globalOpacityLocal"
          type="range"
          min="0"
          max="100"
          step="1"
          class="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
          @input="handleGlobalOpacityChange"
          @change="handleGlobalOpacityChange"
        />
      </div>
    </div>

    <!-- 分区筛选 -->
    <div class="mb-3">
      <div class="flex items-center justify-between mb-1.5 text-xs text-gray-400">
        <span>功能分区</span>
        <span class="text-[10px] text-gray-500">{{ filteredModelList.length }}/{{ modelList.length }}</span>
      </div>
      <div class="flex flex-wrap gap-1">
        <button
          class="px-2 py-0.5 rounded-full text-[10px] border transition-colors"
          :class="
            activePartition === ''
              ? 'bg-blue-500/80 border-blue-400 text-white'
              : 'bg-white/5 border-white/15 text-gray-400 hover:text-white hover:border-white/30'
          "
          @click="activePartition = ''"
        >
          全部
        </button>
        <button
          v-for="p in partitionOptions"
          :key="p.key"
          class="px-2 py-0.5 rounded-full text-[10px] border transition-colors flex items-center gap-1"
          :class="
            activePartition === p.key
              ? 'text-white'
              : 'bg-white/5 border-white/15 text-gray-400 hover:text-white hover:border-white/30'
          "
          :style="
            activePartition === p.key
              ? { background: p.color + 'CC', borderColor: p.color }
              : {}
          "
          @click="selectPartition(p.key)"
        >
          <span class="w-1.5 h-1.5 rounded-full inline-block" :style="{ background: p.color }"></span>
          {{ p.name }}
        </button>
      </div>
    </div>

    <!-- 模型列表（分区分组折叠） -->
    <div
      class="max-h-[320px] overflow-y-auto border border-white/10 rounded-md bg-black/20 custom-scrollbar"
    >
      <div v-if="!filteredModelList.length" class="p-3 text-xs text-gray-500 text-center">
        该分区暂无组件
      </div>
      <div
        v-for="group in groupedModels"
        :key="group.key"
        class="border-b border-white/5 last:border-0"
      >
        <!-- 组头 -->
        <div
          class="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none hover:bg-white/5 transition-colors"
          @click="toggleGroupExpand(group.key)"
        >
          <span class="text-[10px] text-gray-500 w-3 text-center">{{
            expandedPartitions.has(group.key) ? '▾' : '▸'
          }}</span>
          <span
            class="w-2 h-2 rounded-full flex-none"
            :style="{ background: group.color, boxShadow: '0 0 4px ' + group.color + '66' }"
          ></span>
          <span class="text-xs font-medium text-gray-200 flex-1">{{ group.name }}</span>
          <span class="text-[10px] text-gray-500 font-mono mr-1"
            >{{ groupVisibleCount(group) }}/{{ group.models.length }}</span
          >
          <button
            class="p-0.5 rounded text-[11px] hover:bg-white/10 transition-colors"
            :class="groupVisibleCount(group) === 0 ? 'opacity-40' : 'text-gray-300'"
            :title="groupVisibleCount(group) ? '隐藏本分区' : '显示本分区'"
            @click.stop="toggleGroupVisibility(group)"
          >
            👁
          </button>
        </div>
        <!-- 组内组件 -->
        <div v-show="expandedPartitions.has(group.key)">
          <div
            v-for="model in group.models"
            :key="model.id"
            :data-mid="model.id"
            class="relative pl-6 pr-2 py-1 border-t border-white/5 transition-colors hover:bg-white/5 cursor-pointer select-none"
            :class="rowClass(model)"
            title="点击选择 · Ctrl+点击 多选 · Shift+点击 连选"
            @click="onRowClick(model, $event)"
            @mouseenter="hoveredModelId = model.id"
            @mouseleave="hoveredModelId = null"
          >
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-2 group flex-1 min-w-0">
                <div class="relative flex items-center flex-none" @click.stop>
                  <input
                    v-model="model.visible"
                    type="checkbox"
                    class="peer appearance-none w-3.5 h-3.5 border border-gray-500 rounded-sm bg-transparent checked:bg-blue-500 checked:border-blue-500 transition-colors"
                    @change="toggleModelVisibility(model)"
                  />
                  <svg
                    class="absolute w-3.5 h-3.5 pointer-events-none hidden peer-checked:block text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <span
                  class="text-xs text-gray-300 group-hover:text-white transition-colors truncate flex items-center gap-1.5"
                  >{{ model.name
                  }}<span
                    v-if="model._dbLinked"
                    class="text-[10px] text-blue-400 flex-none"
                    title="数据来源：数据库"
                    >◈</span
                  ></span
                >
              </div>
              <div
                class="flex gap-0.5 flex-none transition-opacity"
                @click.stop
                :class="{
                  'opacity-0 group-hover:opacity-100':
                    hoveredModelId !== model.id &&
                    followedModelId !== (model.featureId || model.id),
                  'opacity-100':
                    hoveredModelId === model.id ||
                    followedModelId === (model.featureId || model.id)
                }"
              >
                <button
                  class="p-0.5 rounded hover:bg-white/10 text-gray-400 hover:text-yellow-300 transition-colors text-[11px]"
                  title="高亮"
                  @click="highlightModel(model)"
                >
                  🔆
                </button>
                <button
                  class="p-0.5 rounded transition-colors text-[11px]"
                  :class="
                    followedModelId === (model.featureId || model.id)
                      ? 'bg-green-500/25 text-green-300'
                      : 'hover:bg-white/10 text-gray-400 hover:text-green-300'
                  "
                  :title="
                    followedModelId === (model.featureId || model.id)
                      ? '取消视角追随'
                      : '视角追随（目标移动时相机跟随）'
                  "
                  @click="toggleFollowModel(model)"
                >
                  🎥
                </button>
                <button
                  class="p-0.5 rounded hover:bg-white/10 text-gray-400 hover:text-blue-300 transition-colors text-[11px]"
                  title="属性"
                  @click="showModelProperties(model)"
                >
                  📋
                </button>
              </div>
            </div>

            <!-- 单个模型透明度（绝对定位浮层, 不产生布局位移） -->
            <div
              v-show="hoveredModelId === model.id || model.opacity > 0"
              class="absolute left-6 right-2 top-full z-10 mt-0.5 px-2 py-1 bg-[#111a2af2] rounded border border-white/10"
              @click.stop
            >
              <input
                v-model.number="model.opacity"
                type="range"
                min="0"
                max="100"
                step="1"
                class="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
                @input="updateModelOpacity(model)"
                @change="updateModelOpacity(model)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 多选批量操作条（Ctrl/Shift 选择后出现） -->
    <transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="opacity-0 translate-y-1"
      leave-active-class="transition-all duration-150 ease-in"
      leave-to-class="opacity-0 translate-y-1"
    >
      <div
        v-if="selectedIds.size > 0"
        class="mt-2 flex items-center gap-1.5 flex-wrap bg-blue-500/10 border border-blue-400/30 rounded px-2 py-1.5"
      >
        <span class="text-[11px] text-blue-200 font-medium mr-0.5">已选 {{ selectedIds.size }}</span>
        <button
          class="px-1.5 py-0.5 rounded text-[11px] bg-white/5 border border-white/10 text-gray-200 hover:bg-blue-500/40 hover:text-white transition-colors"
          @click="batchSetVisible(true)"
        >
          显示
        </button>
        <button
          class="px-1.5 py-0.5 rounded text-[11px] bg-white/5 border border-white/10 text-gray-200 hover:bg-blue-500/40 hover:text-white transition-colors"
          @click="batchSetVisible(false)"
        >
          隐藏
        </button>
        <button
          class="px-1.5 py-0.5 rounded text-[11px] bg-white/5 border border-white/10 text-gray-200 hover:bg-blue-500/40 hover:text-white transition-colors"
          title="隐藏其它全部, 仅显示所选"
          @click="batchShowOnly"
        >
          仅显所选
        </button>
        <button
          class="px-1.5 py-0.5 rounded text-[11px] bg-transparent border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-colors ml-auto"
          @click="clearSelection"
        >
          取消选择
        </button>
      </div>
    </transition>

    <!-- 批量操作 -->
    <div class="flex gap-2 mt-3 pt-3 border-t border-white/5">
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="showAllModels"
      >
        全显
      </button>
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="hideAllModels"
      >
        全隐
      </button>
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="resetAllOpacity"
      >
        重置
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import useModel from '../../model-control/services/useModel.js'
import { hasCachedTileset } from '../../model-control/services/modelCache.js'

const {
  modelConfigFiles,
  currentConfigFile,
  modelList,
  selectedModel,
  globalOpacity,
  undergroundViewEnabled,
  onConfigChange,
  reloadCurrentConfig,
  updateGlobalOpacity,
  toggleModelVisibility,
  setModelsVisibility,
  updateModelOpacity,
  highlightModel,
  toggleFollowModel,
  followedModelId,
  showModelProperties,
  showAllModels,
  hideAllModels,
  resetAllOpacity
} = useModel()

const isConfigPanelOpen = ref(false)
const hoveredModelId = ref(null)
const currentConfigFileLocal = ref('')
const globalOpacityLocal = ref(0)
const switching = ref(false)

// 点击场景模型（或列表选择）后：自动展开所在分区并滚动定位到该组件行，
// 让"场景里选中的组件"在 UI 中可见、可控。
watch(selectedModel, model => {
  if (!model || !model.partition) return
  if (!expandedPartitions.value.has(model.partition)) {
    const next = new Set(expandedPartitions.value)
    next.add(model.partition)
    expandedPartitions.value = next
  }
  nextTick(() => {
    const el = document.querySelector(`[data-mid="${model.id}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
})

const isModelCached = path => hasCachedTileset(path)

// ===== 功能分区 =====
const activePartition = ref('')

// 分区选项：优先取数据自带的分区元信息，按固定顺序展示
const PARTITION_ORDER = [
  '选矿厂区',
  '地表设施',
  '提升运输',
  '通风排水',
  '采掘作业',
  '地质资源',
  '移动装备',
  '感知监测'
]
const partitionOptions = computed(() => {
  const map = new Map()
  for (const m of modelList.value || []) {
    if (!m.partition || !m.partitionName) continue
    if (!map.has(m.partition))
      map.set(m.partition, { key: m.partition, name: m.partitionName, color: m.partitionColor || '#6fb3ff' })
  }
  return [...map.values()].sort(
    (a, b) => PARTITION_ORDER.indexOf(a.name) - PARTITION_ORDER.indexOf(b.name)
  )
})

const filteredModelList = computed(() => {
  if (!activePartition.value) return modelList.value || []
  return (modelList.value || []).filter(m => m.partition === activePartition.value)
})

// ===== 分区分组折叠 =====
const expandedPartitions = ref(new Set())

const groupedModels = computed(() => {
  const map = new Map()
  for (const m of filteredModelList.value) {
    const key = m.partition || '_other'
    if (!map.has(key))
      map.set(key, {
        key,
        name: m.partitionName || '其他',
        color: m.partitionColor || '#6fb3ff',
        models: []
      })
    map.get(key).models.push(m)
  }
  return [...map.values()].sort(
    (a, b) => PARTITION_ORDER.indexOf(a.name) - PARTITION_ORDER.indexOf(b.name)
  )
})

// 组内可见计数（响应式依赖 model.visible）
function groupVisibleCount(group) {
  return group.models.filter(m => m.visible).length
}

function toggleGroupExpand(key) {
  const next = new Set(expandedPartitions.value)
  next.has(key) ? next.delete(key) : next.add(key)
  expandedPartitions.value = next
}

function toggleGroupVisibility(group) {
  const target = groupVisibleCount(group) === 0
  setModelsVisibility(group.models, target)
}

// ===== 多选（点击选择 · Ctrl+点击 多选 · Shift+点击 连选）=====
const selectedIds = ref(new Set())
const anchorId = ref(null)

function rowClass(model) {
  if (selectedIds.value.has(model.id))
    return 'bg-blue-500/20 ring-1 ring-inset ring-blue-400/50'
  return hoveredModelId.value === model.id ? 'bg-white/5' : ''
}

function clearSelection() {
  selectedIds.value = new Set()
  anchorId.value = null
}

function selectSingle(model) {
  selectedIds.value = new Set([model.id])
  anchorId.value = model.id
}

function toggleSel(model) {
  const next = new Set(selectedIds.value)
  if (next.has(model.id)) next.delete(model.id)
  else next.add(model.id)
  selectedIds.value = next
  anchorId.value = model.id
}

function rangeSel(model) {
  const list = filteredModelList.value
  const to = list.findIndex(x => x.id === model.id)
  if (to < 0) return
  const from =
    anchorId.value != null ? list.findIndex(x => x.id === anchorId.value) : -1
  const lo = from < 0 ? to : Math.min(from, to)
  const hi = from < 0 ? to : Math.max(from, to)
  const next = new Set(selectedIds.value)
  for (let i = lo; i <= hi; i++) next.add(list[i].id)
  selectedIds.value = next
}

function onRowClick(model, e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    toggleSel(model)
    return
  }
  if (e.shiftKey) {
    e.preventDefault()
    rangeSel(model)
    return
  }
  selectSingle(model)
}

function selectedModels() {
  return (modelList.value || []).filter(m => selectedIds.value.has(m.id))
}

function batchSetVisible(v) {
  const ms = selectedModels()
  if (ms.length) setModelsVisibility(ms, v)
}

function batchShowOnly() {
  hideAllModels()
  const ms = selectedModels()
  if (ms.length) setModelsVisibility(ms, true)
}

// 配置切换后选择失效
watch(modelList, () => clearSelection())

// 分区 tag 点击：过滤到该分区并自动展开
function selectPartition(key) {
  activePartition.value = activePartition.value === key ? '' : key
  if (key) {
    const next = new Set(expandedPartitions.value)
    next.add(key)
    expandedPartitions.value = next
  }
}

// 同步全局状态
watch(
  currentConfigFile,
  val => {
    currentConfigFileLocal.value = val
  },
  { immediate: true }
)

watch(
  globalOpacity,
  val => {
    globalOpacityLocal.value = val
  },
  { immediate: true }
)

// 方法
const toggleConfigPanel = () => {
  isConfigPanelOpen.value = !isConfigPanelOpen.value
}

const handleLoadConfig = () => {
  if (undergroundViewEnabled.value) return
  if (!currentConfigFileLocal.value) return
  switching.value = true
  onConfigChange(currentConfigFileLocal.value).finally(() => {
    switching.value = false
  })
}

const handleGlobalOpacityChange = () => {
  updateGlobalOpacity(globalOpacityLocal.value)
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
