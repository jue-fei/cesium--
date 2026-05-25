<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <div class="panel-section">
        <div class="panel-section-title">应力数据导入</div>
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="onFileChange"
          />
          <el-button class="whitespace-nowrap" type="primary" @click="fileInput?.click()">
            选择数据文件（JSON）
          </el-button>
          <el-button class="whitespace-nowrap" plain @click="importExample">一键导入示例</el-button>
          <el-button
            :disabled="!canExitAnalysis"
            type="danger"
            plain
            class="whitespace-nowrap"
            @click="onExitAnalysis"
          >
            退出分析
          </el-button>
          <div class="text-xs text-text-muted truncate basis-full min-w-0">{{ importedHint }}</div>
        </div>
        <div class="mt-2 text-xs text-text-muted leading-5">
          <div>格式版本：应力点-1.0 / 应力分析-1.0（全中文字段）</div>
          <div>推荐：应力点-1.0（仅点位+应力+时间线；渲染算法由平台负责，交互更流畅）</div>
          <div>兼容：应力分析-1.0（体素六分量/应变换算应力；可选点）。</div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">渲染设置</div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[64px] shrink-0">显示量</div>
            <el-select
              class="flex-1 min-w-0"
              :model-value="metric"
              placeholder="请选择"
              @update:model-value="v => setMetric(v)"
            >
              <el-option
                v-for="opt in metricOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="grid grid-cols-1 gap-3">
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">弹性模量E</div>
              <el-input-number
                class="flex-1 min-w-0"
                :min="0"
                :controls="false"
                :model-value="materialE"
                :disabled="!isStrainSource"
                @update:model-value="v => setMaterial(v, materialNu)"
              />
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">泊松比nu</div>
              <el-input-number
                class="flex-1 min-w-0"
                :min="-0.99"
                :max="0.49"
                :step="0.01"
                :controls="false"
                :model-value="materialNu"
                :disabled="!isStrainSource"
                @update:model-value="v => setMaterial(materialE, v)"
              />
            </div>
            <div class="text-xs text-text-muted">{{ materialHint }}</div>
          </div>

          <div v-if="metric === 'snn' || metric === 'tau_n'" class="grid grid-cols-1 gap-3">
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">方位角（°）</div>
              <el-input-number
                class="flex-1 min-w-0"
                :min="0"
                :max="360"
                :controls="false"
                :model-value="directionAzimuth"
                @update:model-value="v => setDirection(v, directionDip)"
              />
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">倾角（°）</div>
              <el-input-number
                class="flex-1 min-w-0"
                :min="-90"
                :max="90"
                :controls="false"
                :model-value="directionDip"
                @update:model-value="v => setDirection(directionAzimuth, v)"
              />
            </div>
            <div class="text-xs text-text-muted">
              方位角：以北为 0° 顺时针；倾角：向上为正（ENU 本地坐标）
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">值域</div>
            <div class="text-sm font-mono text-text-primary">{{ valueRangeText }}</div>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">时间控制</div>
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm">时间：{{ timeLabel }} {{ currentTime + 1 }} / {{ maxTime + 1 }}</div>
          <div class="flex items-center gap-2">
            <el-button type="primary" plain class="!text-white" @click="togglePlayback">
              {{ isPlaying ? '暂停' : '播放' }}
            </el-button>
          </div>
        </div>
        <el-slider
          :min="0"
          :max="maxTime"
          :step="1"
          :model-value="sliderTime"
          @update:model-value="v => onSliderChange(v)"
        />
      </div>

      <div class="panel-section">
        <div class="panel-section-title">热力图颜色-应力映射</div>
        <div class="border border-border-primary rounded-lg overflow-hidden">
          <div
            class="flex items-center justify-between gap-3 px-3 py-1 text-[11px] text-text-muted bg-black/10"
          >
            <div class="truncate">渐变色标（{{ gradientScaleRangeText }}）</div>
            <div class="font-mono shrink-0">阈值：{{ gradientCutoffText }}</div>
          </div>
          <div class="grid grid-cols-[22px_1fr] gap-3 px-3 py-3 items-stretch">
            <div class="rounded border border-border-primary/80" :style="gradientLegendCss"></div>
            <div class="h-[260px] flex flex-col justify-between">
              <div
                v-for="(tick, index) in gradientValueTickRows"
                :key="`tick-${index}`"
                class="flex items-center justify-between gap-2 text-xs font-mono text-text-primary"
              >
                <div
                  :class="
                    tick.major
                      ? 'h-px flex-1 bg-border-primary'
                      : 'h-px flex-1 bg-border-primary/45'
                  "
                ></div>
                <div
                  :class="tick.major ? 'shrink-0 text-text-primary' : 'shrink-0 text-text-muted'"
                >
                  {{ tick.text }}
                </div>
              </div>
            </div>
          </div>
          <div class="px-3 py-1 text-[11px] text-text-muted border-t border-border-primary/60">
            单位：{{ gradientUnitLabel }}
          </div>
        </div>
      </div>

      <div v-if="importStatus" class="panel-section">
        <div class="panel-section-title">导入诊断</div>
        <div class="text-xs text-text-muted leading-5">
          <div>状态：{{ importStatus.ok ? 'OK' : '需要处理' }}</div>
          <div>{{ importStatus.message }}</div>
          <div v-for="(line, idx) in importStatus.details || []" :key="idx">{{ line }}</div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">点选与图表导出</div>
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <el-button
            class="whitespace-nowrap"
            type="primary"
            :disabled="!canPick"
            @click="onPickPoint"
          >
            在模型上选点
          </el-button>
          <div class="text-xs text-text-muted truncate basis-full min-w-0">{{ pickHint }}</div>
        </div>

        <div v-if="pickedPoint" class="mt-3 flex flex-col gap-2">
          <div class="text-xs text-text-muted">选点坐标：{{ pickedPointText }}</div>
          <div class="text-sm">
            当前值（{{ metricLabel }}）：<span class="font-mono">{{ pickedPointValueText }}</span>
          </div>

          <StressPointTensorDetails
            v-if="pickedPointDetails"
            :details="pickedPointDetails"
            :fmt="fmt"
            :unit="config?.field?.data?.unitStress || unitStress || ''"
            :direction-azimuth="directionAzimuth"
            :direction-dip="directionDip"
          />

          <div class="flex items-center gap-3 mt-1">
            <div class="text-sm text-text-muted w-[64px] shrink-0">曲线指标</div>
            <el-select
              class="flex-1 min-w-0"
              :model-value="chartMetric"
              @update:model-value="v => onChartMetricChange(v)"
            >
              <el-option
                v-for="opt in chartMetricOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">横轴</div>
              <el-select
                class="flex-1 min-w-0"
                :model-value="chartXAxisMode"
                @update:model-value="onChartXAxisModeChange"
              >
                <el-option
                  v-for="opt in chartXAxisOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">纵轴</div>
              <el-select
                class="flex-1 min-w-0"
                :model-value="chartYAxisMode"
                @update:model-value="onChartYAxisModeChange"
              >
                <el-option
                  v-for="opt in chartYAxisOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
          </div>

          <div
            class="bg-black/10 border border-border-primary rounded-lg p-2 overflow-hidden cursor-zoom-in"
            @click="openChartDialog"
          >
            <StressChartSvg
              :view="chartView"
              :title="chartTitle"
              :x-label="chartXAxisLabel"
              :y-label="chartYAxisLabel"
            />
            <div class="text-[11px] text-text-muted mt-1">点击图表可放大查看</div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <el-button :disabled="pickedPointSeries.length === 0" @click="exportCsv"
              >导出 CSV</el-button
            >
            <el-button :disabled="!pickedPoint" @click="exportCsvAll"
              >导出 CSV（全部指标）</el-button
            >
            <el-button :disabled="pickedPointSeries.length === 0" @click="exportSvg"
              >导出 SVG</el-button
            >
            <el-button :disabled="pickedPointSeries.length === 0" @click="exportPng"
              >导出 PNG</el-button
            >
          </div>
        </div>

        <div v-else class="mt-2 text-xs text-text-muted">
          提示：选点后将自动生成“时间-应力”曲线，可导出为 CSV/SVG/PNG。
        </div>
      </div>

      <el-dialog
        v-model="chartDialogVisible"
        title="曲线放大查看"
        append-to-body
        width="90%"
        class="chart-dialog"
      >
        <div
          class="bg-black/10 border border-border-primary rounded-lg p-4 overflow-hidden h-[70vh]"
        >
          <StressChartSvg
            :view="chartViewLarge"
            :title="chartTitle"
            :x-label="chartXAxisLabel"
            :y-label="chartYAxisLabel"
            :large="true"
          />
        </div>
        <template #footer>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <el-button :disabled="pickedPointSeries.length === 0" @click="exportDialogSvg"
              >导出放大图 SVG</el-button
            >
            <el-button :disabled="pickedPointSeries.length === 0" @click="exportDialogPng"
              >导出放大图 PNG</el-button
            >
          </div>
        </template>
      </el-dialog>

      <div class="panel-section">
        <div class="panel-section-title">评估与反馈</div>
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <el-button type="primary" :loading="evaluationRunning" @click="runAutoEvaluation">
              运行自动评估（10秒）
            </el-button>
            <el-button :disabled="!evaluationResult" @click="exportEvaluation">
              导出评估报告（JSON）
            </el-button>
            <div class="text-xs text-text-muted truncate basis-full min-w-0">
              {{ evaluationHint }}
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3">
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">易用性</div>
              <el-input-number
                class="flex-1"
                :min="1"
                :max="5"
                :controls="false"
                :model-value="feedback.usability"
                @update:model-value="v => (feedback.usability = v)"
              />
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">清晰度</div>
              <el-input-number
                class="flex-1"
                :min="1"
                :max="5"
                :controls="false"
                :model-value="feedback.clarity"
                @update:model-value="v => (feedback.clarity = v)"
              />
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[64px] shrink-0">流畅度</div>
              <el-input-number
                class="flex-1"
                :min="1"
                :max="5"
                :controls="false"
                :model-value="feedback.smoothness"
                @update:model-value="v => (feedback.smoothness = v)"
              />
            </div>
          </div>

          <el-input
            type="textarea"
            :rows="3"
            :model-value="feedback.notes"
            placeholder="补充建议/问题描述（可选）"
            @update:model-value="v => (feedback.notes = v)"
          />

          <div class="flex items-center gap-3">
            <el-button @click="exportFeedback">导出反馈（JSON）</el-button>
            <div class="text-xs text-text-muted">
              建议每轮演示导出一次评估报告与反馈，作为迭代依据。
            </div>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title flex items-center justify-between">
          <span>热力图参数调整</span>
          <el-button
            link
            class="!text-text-muted"
            @click="heatmapTuningExpanded = !heatmapTuningExpanded"
          >
            {{ heatmapTuningExpanded ? '收起' : '展开' }}
          </el-button>
        </div>
        <div v-if="heatmapTuningExpanded" class="grid grid-cols-1 gap-3">
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">色值对比度</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0.6"
              :max="2.8"
              :step="0.05"
              :model-value="heatmapContrast"
              @update:model-value="
                v => ((heatmapContrast = Number(v) || 1), applyHeatmapPanelTuning())
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapContrast, 2) }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">色值伽马</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0.45"
              :max="2.4"
              :step="0.05"
              :model-value="heatmapGamma"
              @update:model-value="
                v => ((heatmapGamma = Number(v) || 1), applyHeatmapPanelTuning())
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapGamma, 2) }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">颜色阈值</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0"
              :max="0.25"
              :step="0.005"
              :model-value="heatmapCutoff"
              @update:model-value="
                v => ((heatmapCutoff = Math.max(0, Number(v) || 0)), applyHeatmapPanelTuning())
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapCutoff, 3) }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">可见增强</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0"
              :max="1"
              :step="0.02"
              :model-value="heatmapForceVisible"
              @update:model-value="
                v => (
                  (heatmapForceVisible = Math.max(0, Math.min(1, Number(v) || 0))),
                  applyHeatmapPanelTuning()
                )
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapForceVisible, 2) }}
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <el-button
              size="small"
              type="primary"
              plain
              class="!text-white"
              @click="applyHeatmapPreset('clear')"
            >
              清晰热力图预设
            </el-button>
            <el-button size="small" @click="applyHeatmapPreset('balanced')">平衡预设</el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import StressChartSvg from './panel/components/StressChartSvg.vue'
import StressPointTensorDetails from './panel/components/StressPointTensorDetails.vue'
import { useStressPanelController } from './panel/composables/useStressPanelController.js'

const {
  fileInput,
  currentTime,
  maxTime,
  timeLabel,
  sliderTime,
  isPlaying,
  metric,
  metricLabel,
  metricOptions,
  materialE,
  materialNu,
  materialHint,
  isStrainSource,
  setMaterial,
  setMetric,
  directionAzimuth,
  directionDip,
  setDirection,
  valueRangeText,
  togglePlayback,
  canExitAnalysis,
  onExitAnalysis,
  onSliderChange,
  config,
  unitStress,
  importedHint,
  importStatus,
  onFileChange,
  importExample,
  gradientScaleRangeText,
  gradientCutoffText,
  gradientLegendCss,
  gradientValueTickRows,
  gradientUnitLabel,
  canPick,
  pickHint,
  onPickPoint,
  pickedPoint,
  pickedPointText,
  pickedPointValueText,
  pickedPointDetails,
  fmt,
  chartMetric,
  chartMetricOptions,
  chartXAxisMode,
  chartYAxisMode,
  chartXAxisOptions,
  chartYAxisOptions,
  onChartMetricChange,
  onChartXAxisModeChange,
  onChartYAxisModeChange,
  chartView,
  chartViewLarge,
  chartTitle,
  chartXAxisLabel,
  chartYAxisLabel,
  pickedPointSeries,
  chartDialogVisible,
  openChartDialog,
  exportCsv,
  exportCsvAll,
  exportSvg,
  exportPng,
  exportDialogSvg,
  exportDialogPng,
  evaluationRunning,
  evaluationResult,
  evaluationHint,
  runAutoEvaluation,
  exportEvaluation,
  feedback,
  exportFeedback,
  heatmapTuningExpanded,
  heatmapContrast,
  heatmapGamma,
  heatmapCutoff,
  heatmapForceVisible,
  applyHeatmapPanelTuning,
  applyHeatmapPreset,
  formatNumber
} = useStressPanelController()
</script>
