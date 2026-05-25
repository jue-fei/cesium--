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
defineOptions({ name: 'LOD优化面板' })
import { InfoFilled } from '@element-plus/icons-vue'
import { useLodPanelController } from '../services/panel/useLodPanelController.js'

const {
  modelLoaded,
  dirty,
  fps,
  memoryMb,
  presetKey,
  presetOptions,
  currentPresetLabel,
  openGroupIds,
  groups,
  local,
  lodRuntime,
  applyPreset,
  formatField,
  getFieldNumber,
  setFieldNumber,
  setFieldBoolean,
  apply,
  rollback,
  reset
} = useLodPanelController()
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
