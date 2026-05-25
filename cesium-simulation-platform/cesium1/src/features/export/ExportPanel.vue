<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-[3000] bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center overflow-y-auto"
    @click.self="close"
  >
    <div
      class="w-full max-w-[520px] max-h-[calc(100vh-2rem)] rounded-xl border border-border-primary bg-bg-secondary p-5 shadow-tech-lg flex flex-col"
    >
      <div class="flex items-center justify-between">
        <div class="flex flex-col">
          <div class="text-base font-semibold text-text-primary">{{ title }}</div>
          <div class="text-xs text-text-muted">导出范围按勾选项生成</div>
        </div>
        <button
          class="w-8 h-8 rounded border border-border-primary bg-white/5 hover:bg-white/10 transition-colors text-text-muted"
          @click="close"
        >
          ✕
        </button>
      </div>

      <div class="mt-4 flex flex-col gap-4 flex-1 overflow-y-auto">
        <div class="flex flex-col gap-2">
          <div class="text-xs font-semibold text-text-secondary">基本信息</div>
          <div class="grid grid-cols-2 gap-2">
            <input
              v-model="exportOptions.projectName"
              class="col-span-2 px-3 py-2 rounded border border-border-primary bg-black/20 text-text-primary text-sm outline-none focus:border-primary"
              placeholder="项目名称"
            />
            <textarea
              v-model="exportOptions.description"
              class="col-span-2 px-3 py-2 rounded border border-border-primary bg-black/20 text-text-primary text-sm outline-none focus:border-primary"
              placeholder="项目描述"
              rows="2"
            ></textarea>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-xs font-semibold text-text-secondary">导出内容</div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeBasicInfo" type="checkbox" />
              <span class="text-text-primary">场景信息</span>
            </label>
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeCameraView" type="checkbox" />
              <span class="text-text-primary">相机视角</span>
            </label>
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeModels" type="checkbox" />
              <span class="text-text-primary">模型数据 ({{ modelCount }})</span>
            </label>
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeClipping" type="checkbox" />
              <span class="text-text-primary">切割平面 ({{ clippingCount }})</span>
            </label>
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeMeasurements" type="checkbox" />
              <span class="text-text-primary">测量数据 ({{ measurementCount }})</span>
            </label>
            <label
              class="flex items-center gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <input v-model="exportOptions.includeGeology" type="checkbox" />
              <span class="text-text-primary">地质数据</span>
            </label>
          </div>
        </div>

        <div v-if="exportType === 'screenshot'" class="flex flex-col gap-2">
          <div class="text-xs font-semibold text-text-secondary">截图设置</div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <label
              class="flex items-center justify-between gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <span class="text-text-primary">格式</span>
              <select
                v-model="screenshot.format"
                class="px-2 py-1 rounded border border-border-primary bg-black/20 text-text-primary outline-none"
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
            </label>
            <label
              class="flex items-center justify-between gap-2 rounded border border-border-primary bg-white/5 px-3 py-2"
            >
              <span class="text-text-primary">质量</span>
              <input
                v-model.number="screenshot.quality"
                type="range"
                min="0.1"
                max="1"
                step="0.1"
              />
            </label>
          </div>
        </div>
      </div>

      <div class="mt-4 flex items-center justify-end gap-2 shrink-0">
        <button
          class="px-4 py-2 rounded border border-border-primary bg-white/5 hover:bg-white/10 transition-colors text-sm text-text-primary"
          @click="close"
        >
          取消
        </button>
        <button
          class="px-4 py-2 rounded border border-primary bg-primary/20 hover:bg-primary/30 transition-colors text-sm text-text-primary"
          @click="confirm"
        >
          确认导出
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  exportType: { type: String, default: 'json' },
  modelCount: { type: Number, default: 0 },
  measurementCount: { type: Number, default: 0 },
  clippingCount: { type: Number, default: 0 }
})

const emit = defineEmits(['close', 'confirm'])

const exportOptions = reactive({
  projectName: '',
  description: '',
  includeBasicInfo: true,
  includeModels: true,
  includeMeasurements: true,
  includeClipping: true,
  includeGeology: true,
  includeCameraView: true
})

const screenshot = reactive({
  format: 'png',
  quality: 1.0
})

const title = computed(() => {
  if (props.exportType === 'report') return '导出报告'
  if (props.exportType === 'screenshot') return '导出截图'
  if (props.exportType === 'csv') return '导出CSV'
  return '导出JSON'
})

const close = () => emit('close')

const confirm = () => {
  if (props.exportType === 'screenshot') {
    emit('confirm', { ...exportOptions, ...screenshot })
    return
  }
  emit('confirm', { ...exportOptions })
}
</script>
