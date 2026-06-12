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
          <div>导入支持自动识别关键字段，无需额外声明格式信息。</div>
          <div>点数据：提供点/点位、坐标、应力、时间信息即可统一渲染。</div>
          <div>场数据：提供网格、数据、时间、材料信息即可统一渲染。</div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">渲染设置</div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-end gap-2">
            <el-button size="small" plain :disabled="!canUndo" @click="onUndo">撤销</el-button>
            <el-button size="small" plain :disabled="!canRedo" @click="onRedo">重做</el-button>
          </div>
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

      <div v-if="isPointMode" class="panel-section">
        <div class="panel-section-title">渲染模式与分辨率</div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[64px] shrink-0">渲染</div>
            <el-select
              class="flex-1 min-w-0"
              :model-value="renderMode"
              :loading="renderModeApplying"
              :disabled="renderModeApplying"
              @update:model-value="v => onRenderModeChange(v)"
            >
              <el-option label="点扩散" value="points" />
              <el-option label="插值(IDW)" value="idw" />
              <el-option label="插值(Kriging)" value="kriging" />
            </el-select>
          </div>
          <div v-if="renderModeApplyStatus" class="text-[11px] text-emerald-300">
            {{ renderModeApplyStatus }}
          </div>
          <div
            v-if="isInterpolationMode && renderProgress?.active"
            class="border border-border-primary/60 rounded-md px-2 py-2 bg-black/10"
          >
            <div class="flex items-center gap-2 text-[11px] text-text-muted">
              <div
                class="h-3.5 w-3.5 rounded-full border-2 border-border-primary/40 border-t-primary animate-spin shrink-0"
              ></div>
              <div class="truncate">{{ renderProgress.text || '插值渲染中...' }}</div>
              <div class="font-mono ml-auto shrink-0">
                {{ Math.max(0, Math.min(100, Math.round(Number(renderProgress.percent) || 0))) }}%
              </div>
            </div>
          </div>
          <div
            v-if="isInterpolationMode && interpolationFallbackText"
            class="border border-amber-400/40 rounded-md px-2 py-2 bg-amber-500/10 text-[11px] text-amber-200"
          >
            {{ interpolationFallbackText }}
          </div>
          <div
            v-if="isInterpolationMode && interpolationNeedsConfirm"
            class="border border-primary/50 rounded-md px-2 py-2 bg-primary/10"
          >
            <div class="text-[11px] text-text-muted">
              预览结果已应用到模型，确认后将启动完整分辨率重建。
            </div>
            <div class="mt-2 flex items-center gap-2">
              <el-button size="small" type="primary" @click="onConfirmInterpolationFinalPass">
                生成精细结果
              </el-button>
              <el-button size="small" plain @click="onKeepInterpolationPreview">
                保留预览
              </el-button>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[64px] shrink-0">源点</div>
            <el-select
              class="flex-1 min-w-0"
              :model-value="sourceMode"
              :disabled="renderModeApplying"
              @update:model-value="v => onPointSourceModeChange(v)"
            >
              <el-option
                v-for="opt in pointSourceModeOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>
          <div
            class="flex items-center justify-between gap-3 rounded-md border border-border-primary/60 px-3 py-2"
          >
            <div class="flex flex-col gap-1">
              <div class="text-sm text-text-primary">显示已知点应力</div>
              <div class="text-[11px] text-text-muted">
                在模型上显示原始已知点的当前位置与当前时间帧应力值
              </div>
            </div>
            <el-switch
              :model-value="knownPointStressVisible"
              @update:model-value="v => setKnownPointStressVisible(Boolean(v))"
            />
          </div>
          <div v-if="isInterpolationMode" class="border border-border-primary/60 rounded-md p-2">
            <div class="flex items-center gap-2 text-[12px] text-text-muted">
              <div class="shrink-0">插值网格</div>
              <el-input-number
                size="small"
                class="w-[90px]"
                :min="1"
                :max="interpolationGridMaxWidth"
                :controls="false"
                :model-value="interpolationGridWidth"
                @update:model-value="v => (interpolationGridWidth = v)"
              />
              <div>×</div>
              <el-input-number
                size="small"
                class="w-[90px]"
                :min="1"
                :max="interpolationGridMaxHeight"
                :controls="false"
                :model-value="interpolationGridHeight"
                @update:model-value="v => (interpolationGridHeight = v)"
              />
              <div>×</div>
              <el-input-number
                size="small"
                class="w-[90px]"
                :min="1"
                :max="interpolationGridMaxDepth"
                :controls="false"
                :model-value="interpolationGridDepth"
                @update:model-value="v => (interpolationGridDepth = v)"
              />
              <el-button
                size="small"
                plain
                :loading="interpolationApplying"
                :disabled="interpolationApplying"
                @click="onApplyInterpolationGrid"
              >
                {{ interpolationApplying ? '应用中' : '应用' }}
              </el-button>
            </div>
            <div class="mt-1 text-[11px] text-text-muted">
              {{ interpolationGridHint }}
            </div>
            <div v-if="interpolationApplyStatus" class="mt-1 text-[11px] text-emerald-300">
              {{ interpolationApplyStatus }}
            </div>
            <div class="mt-2 flex items-center gap-2 flex-wrap">
              <el-button
                v-for="preset in interpolationGridPresets"
                :key="preset.key"
                size="small"
                plain
                :disabled="interpolationApplying"
                @click="onApplyInterpolationGridPreset(preset.key)"
              >
                {{ preset.label }}
              </el-button>
            </div>
          </div>
          <div v-else class="text-xs text-text-muted">点扩散模式无需插值网格分辨率设置</div>
          <div
            v-if="renderMode === 'idw'"
            class="border border-border-primary/60 rounded-md p-2 flex items-center gap-2"
          >
            <div class="text-[12px] text-text-muted shrink-0">IDW 幂参数</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="1.0"
              :max="4.0"
              :step="0.1"
              :model-value="idwPower"
              :disabled="idwPowerApplying"
              @update:model-value="
                v => {
                  idwPower = Number(v) || 2.0
                }
              "
              @change="applyIdwPower"
            />
            <div class="text-xs font-mono w-[42px] text-right">
              {{ Number(idwPower).toFixed(1) }}
            </div>
            <div class="text-[10px] text-text-muted shrink-0">
              {{ idwPower <= 1.5 ? '(平滑)' : idwPower >= 3.0 ? '(局部)' : '(标准)' }}
            </div>
          </div>
          <div v-if="renderMode === 'idw'" class="text-[10px] text-text-muted">
            p 越小热力图越平滑（减少牛眼效应），p 越大越强调局部测点（保留峰值）。岩土文献推荐
            1.5~2.5
          </div>

          <div
            v-if="isInterpolationMode"
            class="rounded-lg border border-border-primary/60 px-3 py-2 bg-black/10"
          >
            <div class="text-xs text-text-muted leading-5">
              <div class="font-medium text-text-primary mb-1">
                {{ renderMode === 'idw' ? 'IDW vs Kriging 方法差异' : 'Kriging 方法说明' }}
              </div>
              <template v-if="renderMode === 'idw'">
                <div>· IDW 保留局部峰值，可能产生"牛眼效应"</div>
                <div>· 不提供插值不确定性估计</div>
                <div>· 适合：密集测点、均匀应力场</div>
              </template>
              <template v-if="renderMode === 'kriging'">
                <div>· 基于变差函数的空间相关性建模</div>
                <div>· 包含估计方差场（支持不确定性可视化）</div>
                <div>· 可能平滑局部应力集中（条件偏倚）</div>
                <div>· 适合：稀疏测点、复杂空间变异</div>
              </template>
            </div>
          </div>
        </div>
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

      <div class="panel-section">
        <div class="panel-section-title">安全区域分析</div>
        <div class="flex flex-col gap-3">
          <div
            class="rounded-lg border border-border-primary/60 bg-black/10 px-3 py-3 flex flex-col gap-2"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="text-sm text-text-primary">{{ safetySummaryTitle }}</div>
              <div
                :class="
                  safetySummaryEnabled
                    ? 'text-[11px] px-2 py-1 rounded-full bg-primary/20 text-primary'
                    : 'text-[11px] px-2 py-1 rounded-full bg-black/20 text-text-muted'
                "
              >
                {{ safetySummaryEnabled ? '当前用于渲染' : '切到安全评分可着色' }}
              </div>
            </div>
            <div class="text-xs text-text-muted leading-5">{{ safetySummaryHint }}</div>
            <div class="grid grid-cols-1 gap-1 text-[11px] text-text-muted leading-5">
              <div
                v-for="(line, index) in safetyScoreStandardLines"
                :key="`safety-standard-${index}`"
              >
                {{ line }}
              </div>
            </div>
          </div>

          <div v-if="safetySummary" class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div class="rounded-lg border border-border-primary/60 px-3 py-3 bg-black/10">
              <div class="text-xs text-text-muted">综合安全评分</div>
              <div class="mt-1 text-2xl font-mono text-rose-300">
                {{ formatNumber(safetySummary.overallScore, 2) }}
              </div>
              <div class="mt-1 text-[11px] text-text-muted">1 为安全，10 为极不安全</div>
            </div>
            <div class="rounded-lg border border-border-primary/60 px-3 py-3 bg-black/10">
              <div class="text-xs text-text-muted">峰值风险评分</div>
              <div class="mt-1 text-2xl font-mono text-amber-300">
                {{ formatNumber(safetySummary.peakScore, 2) }}
              </div>
              <div class="mt-1 text-[11px] text-text-muted">
                高风险样本占比 {{ formatNumber(safetySummary.highRiskRatio, 1) }}%
              </div>
            </div>
            <div class="rounded-lg border border-border-primary/60 px-3 py-3 bg-black/10">
              <div class="text-xs text-text-muted">地质因素参与</div>
              <div class="mt-1 text-lg text-text-primary">
                {{ safetySummary.geologyParticipation ? '已参与综合评分' : '未接入，按应力评估' }}
              </div>
              <div class="mt-1 text-[11px] text-text-muted">
                采样数 {{ safetySummary.sampleCount }}
              </div>
            </div>
          </div>

          <div
            v-if="safetySummary?.topRegions?.length"
            class="rounded-lg border border-border-primary/60 overflow-hidden"
          >
            <div class="px-3 py-2 text-xs text-text-muted bg-black/10">高风险区域排序</div>
            <div
              v-for="region in safetySummary.topRegions"
              :key="region.id"
              class="px-3 py-3 border-t border-border-primary/40 flex flex-col gap-1"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm text-text-primary">{{ region.label }}</div>
                <div class="font-mono text-rose-300">
                  {{ formatNumber(region.peakScore, 2) }}/10
                </div>
              </div>
              <div class="text-[11px] text-text-muted">
                平均 {{ formatNumber(region.avgScore, 2) }}，{{ region.riskLevel }}，样本
                {{ region.count }}
              </div>
              <div class="text-[11px] text-text-muted">地质特征：{{ region.geologyLabel }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">预警中心</div>
        <WarningList :warnings="warnings" :summary="warningSummary" />
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
            <div class="text-sm text-text-muted w-[92px] shrink-0">低值保留</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0"
              :max="0.6"
              :step="0.02"
              :model-value="heatmapLowRangeOpacity"
              @update:model-value="
                v => (
                  (heatmapLowRangeOpacity = Math.max(0, Math.min(0.6, Number(v) || 0))),
                  applyHeatmapPanelTuning()
                )
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapLowRangeOpacity, 2) }}
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
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">扩散混合</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0"
              :max="1"
              :step="0.02"
              :model-value="heatmapDiffuseMix"
              @update:model-value="
                v => (
                  (heatmapDiffuseMix = Math.max(0, Math.min(1, Number(v) || 0))),
                  applyHeatmapPanelTuning()
                )
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapDiffuseMix, 2) }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">自发光混合</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0"
              :max="1"
              :step="0.02"
              :model-value="heatmapEmissiveMix"
              @update:model-value="
                v => (
                  (heatmapEmissiveMix = Math.max(0, Math.min(1, Number(v) || 0))),
                  applyHeatmapPanelTuning()
                )
              "
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapEmissiveMix, 2) }}
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[92px] shrink-0">混合模式</div>
              <el-select
                class="flex-1 min-w-0"
                :model-value="heatmapBlendMode"
                @update:model-value="
                  v => ((heatmapBlendMode = v || 'max'), applyHeatmapPanelTuning())
                "
              >
                <el-option label="最大值" value="max" />
                <el-option label="叠加" value="add" />
                <el-option label="覆写" value="overlay" />
              </el-select>
            </div>
            <div class="flex items-center gap-3">
              <div class="text-sm text-text-muted w-[92px] shrink-0">掩模模式</div>
              <el-select
                class="flex-1 min-w-0"
                :model-value="heatmapMaskMode"
                @update:model-value="
                  v => ((heatmapMaskMode = v || 'none'), applyHeatmapPanelTuning())
                "
              >
                <el-option label="关闭" value="none" />
                <el-option label="点位" value="points" />
              </el-select>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              class="flex items-center justify-between gap-3 rounded-md border border-border-primary/60 px-3 py-2"
            >
              <div class="text-sm text-text-muted">锚定模型</div>
              <el-switch
                :model-value="heatmapAnchorToModel"
                @update:model-value="
                  v => ((heatmapAnchorToModel = Boolean(v)), applyHeatmapPanelTuning())
                "
              />
            </div>
            <div
              class="flex items-center justify-between gap-3 rounded-md border border-border-primary/60 px-3 py-2"
            >
              <div class="text-sm text-text-muted">等值线</div>
              <el-switch
                :model-value="heatmapEnableContour"
                @update:model-value="
                  v => ((heatmapEnableContour = Boolean(v)), applyHeatmapPanelTuning())
                "
              />
            </div>
            <div
              class="flex items-center justify-between gap-3 rounded-md border border-border-primary/60 px-3 py-2"
            >
              <div class="text-sm text-text-muted">高应力发光</div>
              <el-switch
                :model-value="heatmapEnableGlow"
                @update:model-value="
                  v => ((heatmapEnableGlow = Boolean(v)), applyHeatmapPanelTuning())
                "
              />
            </div>
            <div
              class="flex items-center justify-between gap-3 rounded-md border border-border-primary/60 px-3 py-2"
            >
              <div class="text-sm text-text-muted">点标记</div>
              <el-switch
                :model-value="heatmapEnableMarker"
                @update:model-value="
                  v => ((heatmapEnableMarker = Boolean(v)), applyHeatmapPanelTuning())
                "
              />
            </div>
          </div>
          <div v-show="heatmapEnableContour" class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">等值线密度</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="2"
              :max="40"
              :step="1"
              :model-value="heatmapContourLevels"
              @update:model-value="onContourLevelsChange"
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ heatmapContourLevels }}
            </div>
          </div>
          <div v-show="heatmapEnableContour" class="flex items-center gap-3">
            <div class="text-sm text-text-muted w-[92px] shrink-0">等值线宽度</div>
            <el-slider
              class="flex-1 min-w-0"
              :min="0.003"
              :max="0.12"
              :step="0.003"
              :model-value="heatmapContourWidth"
              @update:model-value="onContourWidthChange"
            />
            <div class="text-xs font-mono w-[52px] text-right">
              {{ formatNumber(heatmapContourWidth, 2) }}
            </div>
          </div>
          <div
            v-show="heatmapEnableContour && contourValueRows.length"
            class="rounded-md border border-border-primary/60 px-3 py-2"
          >
            <div class="text-sm text-text-muted mb-2">等值线数值对照</div>
            <div
              class="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] font-mono text-text-primary max-h-[160px] overflow-y-auto"
            >
              <div v-for="row in contourValueRows" :key="row.index" class="flex items-center gap-1">
                <span class="text-text-muted shrink-0">L{{ row.index }}</span>
                <span class="truncate">{{ row.text }}</span>
              </div>
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-gray-400">色图</span>
              <el-select
                v-model="heatmapColormapPreset"
                size="small"
                class="!w-40"
                @change="applyHeatmapPanelTuning()"
              >
                <el-option
                  v-for="opt in colormapPresetOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
            <el-button
              size="small"
              type="primary"
              plain
              class="!text-white"
              @click="applyHeatmapPreset('clear')"
            >
              清晰热力图预设
            </el-button>
            <el-button size="small" @click="applyHeatmapPreset('continuous')"
              >低值连续预设</el-button
            >
            <el-button size="small" @click="applyHeatmapPreset('balanced')">平衡预设</el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '应力分析面板' })
import StressChartSvg from './StressChartSvg.vue'
import StressPointTensorDetails from './StressPointTensorDetails.vue'
import WarningList from './WarningList.vue'
import { useStressPanelController } from '../services/panel/useStressPanelController.js'
import { getColormapPresetOptions } from '../services/panel/stressHeatmapPanelState.js'

const colormapPresetOptions = getColormapPresetOptions()

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
  canUndo,
  canRedo,
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
  safetySummary,
  safetySummaryTitle,
  safetySummaryHint,
  safetySummaryEnabled,
  safetyScoreStandardLines,
  warnings,
  warningSummary,
  knownPointStressVisible,
  setKnownPointStressVisible,
  runAutoEvaluation,
  exportEvaluation,
  feedback,
  exportFeedback,
  isPointMode,
  renderMode,
  renderModeApplying,
  renderModeApplyStatus,
  onRenderModeChange,
  sourceMode,
  pointSourceModeOptions,
  onPointSourceModeChange,
  renderProgress,
  isInterpolationMode,
  interpolationGridWidth,
  interpolationGridHeight,
  interpolationGridDepth,
  interpolationApplying,
  interpolationApplyStatus,
  interpolationGridMaxWidth,
  interpolationGridMaxHeight,
  interpolationGridMaxDepth,
  interpolationGridPresets,
  interpolationGridHint,
  interpolationNeedsConfirm,
  interpolationFallbackText,
  onApplyInterpolationGrid,
  onApplyInterpolationGridPreset,
  onConfirmInterpolationFinalPass,
  onKeepInterpolationPreview,
  idwPower,
  idwPowerApplying,
  applyIdwPower,
  heatmapTuningExpanded,
  heatmapContrast,
  heatmapGamma,
  heatmapCutoff,
  heatmapLowRangeOpacity,
  heatmapForceVisible,
  heatmapDiffuseMix,
  heatmapEmissiveMix,
  heatmapAnchorToModel,
  heatmapBlendMode,
  heatmapMaskMode,
  heatmapEnableContour,
  heatmapContourLevels,
  heatmapContourWidth,
  heatmapEnableGlow,
  heatmapEnableMarker,
  heatmapColormapPreset,
  contourValueRows,
  onUndo,
  onRedo,
  applyHeatmapPanelTuning,
  applyHeatmapPreset,
  formatNumber
} = useStressPanelController()

function onContourLevelsChange(v) {
  heatmapContourLevels.value = Math.max(2, Math.min(40, Number(v) || 24))
  applyHeatmapPanelTuning()
}

function onContourWidthChange(v) {
  heatmapContourWidth.value = Math.max(0.003, Math.min(0.12, Number(v) || 0.015))
  applyHeatmapPanelTuning()
}
</script>
