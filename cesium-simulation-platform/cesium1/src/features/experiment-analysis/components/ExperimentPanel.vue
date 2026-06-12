<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <div class="panel-section">
        <div class="panel-section-header" @click="showMethodIntro = !showMethodIntro">
          <div class="panel-section-title">插值方法对比实验</div>
          <div class="text-xs text-dim">{{ showMethodIntro ? '收起说明 ▲' : '展开说明 ▼' }}</div>
        </div>

        <div v-if="showMethodIntro" class="method-intro">
          <div class="intro-block">
            <div class="intro-title">{{ METHOD_INTRO.idw.title }}</div>
            <div class="formula-text">{{ METHOD_INTRO.idw.formula }}</div>
            <div class="text-xs leading-relaxed text-dim">{{ METHOD_INTRO.idw.description }}</div>
          </div>

          <div class="intro-block">
            <div class="intro-title">{{ METHOD_INTRO.kriging.title }}</div>
            <div class="formula-text">{{ METHOD_INTRO.kriging.formula }}</div>
            <div class="text-xs leading-relaxed text-dim">
              {{ METHOD_INTRO.kriging.description }}
            </div>
          </div>

          <div class="intro-block">
            <div class="intro-title">变异函数模型对比</div>
            <div class="flex flex-col gap-2 mt-1">
              <div v-for="(v, k) in METHOD_INTRO.kriging_variogram" :key="k" class="variogram-item">
                <div class="text-xs font-semibold stat-item">{{ v.label }}</div>
                <div class="formula-text text-xs">{{ v.formula }}</div>
                <div class="text-xs text-dim">{{ v.description }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">实验预设方案</div>
        <el-select
          v-model="currentPreset"
          class="w-full"
          :disabled="isRunning"
          @change="applyPreset"
        >
          <el-option
            v-for="preset in presetOptions"
            :key="preset.id"
            :label="preset.label"
            :value="preset.id"
          />
        </el-select>
        <div class="mt-2 text-xs text-dim">{{ selectedPreset?.description || '' }}</div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">实验可行性与专业设计</div>
        <div class="feasibility-card">
          <div class="feasibility-header">
            <div>
              <div class="feasibility-title">{{ feasibilityReport.verdict }}</div>
              <div class="feasibility-text">{{ feasibilityReport.scope }}</div>
            </div>
            <div
              class="feasibility-badge"
              :class="`feasibility-badge-${feasibilityReport.reliabilityTone}`"
            >
              {{ feasibilityReport.reliabilityLabel }}
            </div>
          </div>
          <div class="feasibility-note">{{ feasibilityReport.limitation }}</div>
        </div>

        <div class="design-grid">
          <div class="design-block">
            <div class="design-title">实验协议</div>
            <div v-for="item in feasibilityReport.protocol" :key="item" class="design-line">
              {{ item }}
            </div>
          </div>
          <div class="design-block">
            <div class="design-title">变量控制</div>
            <div v-for="item in feasibilityReport.controls" :key="item.label" class="control-line">
              <span class="control-label">{{ item.label }}</span>
              <span class="control-value">{{ item.value }}</span>
            </div>
          </div>
        </div>

        <div v-if="feasibilityReport.warnings.length" class="warning-list">
          <div v-for="warning in feasibilityReport.warnings" :key="warning" class="warning-line">
            {{ warning }}
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">实验参数设置</div>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="合成数据集的采样点总数，影响插值密度与实验耗时"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">采样点数</div>
            </el-tooltip>
            <el-input-number
              v-model="config.dataGeneration.pointCount"
              class="flex-1 min-w-0"
              :min="10"
              :max="500"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="用于评估的测试集占比，剩余部分作为训练集构建插值模型"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">测试比例</div>
            </el-tooltip>
            <el-input-number
              v-model="config.dataGeneration.testRatio"
              class="flex-1 min-w-0"
              :min="0.1"
              :max="0.5"
              :step="0.05"
              :precision="2"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="叠加在真实值上的高斯噪声标准差占比，模拟测量误差"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">噪声水平</div>
            </el-tooltip>
            <el-input-number
              v-model="config.dataGeneration.noiseLevel"
              class="flex-1 min-w-0"
              :min="0"
              :max="0.5"
              :step="0.01"
              :precision="3"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="额外注入的异常点数量，其值为真值的数倍，检验算法抗干扰能力"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">异常点数</div>
            </el-tooltip>
            <el-input-number
              v-model="config.dataGeneration.anomalyCount"
              class="flex-1 min-w-0"
              :min="0"
              :max="30"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="合成真值场类型，用于评估算法对平滑峰值或梯度场的适应性"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">应力场</div>
            </el-tooltip>
            <el-select
              v-model="config.dataGeneration.trendType"
              class="flex-1 min-w-0"
              :disabled="isRunning"
            >
              <el-option label="高斯混合峰值场" value="gaussian_mixture" />
              <el-option label="梯度+峰值复合场" value="gradient_peak" />
            </el-select>
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="固定随机种子可复现实验；重复实验会在该种子基础上递增"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">随机种子</div>
            </el-tooltip>
            <el-input-number
              v-model="config.dataGeneration.seed"
              class="flex-1 min-w-0"
              :min="1"
              :max="999999"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="重复实验轮数越多，越能判断算法排序是否稳定；建议不少于 5 轮"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">重复轮次</div>
            </el-tooltip>
            <el-input-number
              v-model="config.comparison.repeatCount"
              class="flex-1 min-w-0"
              :min="3"
              :max="20"
              :controls="false"
              :disabled="isRunning"
            />
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip
              effect="dark"
              content="克里金插值使用的变异函数模型类型，可同时选择多个进行比较"
              placement="right"
            >
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">Kriging模型</div>
            </el-tooltip>
            <el-select
              class="flex-1 min-w-0"
              :model-value="config.comparison?.krigingModels || ['exponential']"
              :disabled="isRunning"
              multiple
              @update:model-value="
                v => {
                  config.comparison = { ...config.comparison, krigingModels: v }
                }
              "
            >
              <el-option label="指数模型" value="exponential" />
              <el-option label="高斯模型" value="gaussian" />
              <el-option label="球状模型" value="spherical" />
            </el-select>
          </div>
          <div class="flex items-center gap-3">
            <el-tooltip effect="dark" placement="right">
              <template #content>
                <div class="text-xs leading-relaxed max-w-[220px]">
                  <div class="font-semibold mb-1">慢·精准模式</div>
                  <div>24粒子 × 60迭代 × 3轮重启，优化充分，耗时约 3~8 秒</div>
                  <div class="font-semibold mt-2 mb-1">快·流畅模式</div>
                  <div>8粒子 × 20迭代 × 1轮，快速收敛，耗时约 0.5~1 秒</div>
                  <div class="mt-2 text-dim">
                    两种模式都使用 PSO 自动搜索最优参数，仅搜索深度不同
                  </div>
                </div>
              </template>
              <div class="text-sm text-dim w-[72px] shrink-0 cursor-help">PSO优化</div>
            </el-tooltip>
            <el-switch
              :model-value="config.comparison?.idwConfig?.optimizeParameters !== false"
              :disabled="isRunning"
              active-text="慢·精准"
              inactive-text="快·流畅"
              @update:model-value="
                v => {
                  config.comparison = {
                    ...config.comparison,
                    idwConfig: { ...config.comparison?.idwConfig, optimizeParameters: v }
                  }
                }
              "
            />
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="flex gap-2">
          <el-button
            type="primary"
            :loading="isRunning"
            :disabled="isRunning"
            class="flex-1"
            @click="startExperiment"
          >
            单次实验
          </el-button>
          <el-button
            :loading="isRunning"
            :disabled="isRunning"
            class="flex-1"
            @click="startRepeatedExperiment"
          >
            重复实验
          </el-button>
          <el-button v-if="results" plain :disabled="isRunning" @click="exportResults">
            导出Excel
          </el-button>
        </div>
      </div>

      <div v-if="isRunning" class="panel-section">
        <div class="progress-header">
          <div class="flex items-center gap-3 min-w-0">
            <div class="spinner"></div>
            <div class="text-sm text-dim truncate">{{ progressMessage }}</div>
          </div>
          <el-button type="danger" size="small" plain class="shrink-0" @click="cancelExperiment">
            取消实验
          </el-button>
        </div>
        <el-progress
          :percentage="progressPercent"
          :stroke-width="4"
          :show-text="false"
          class="mt-2"
        />
        <div class="text-xs text-dim mt-1">{{ progressPercent }}%</div>
      </div>

      <div v-if="status === 'error'" class="panel-section error-section">
        <div class="text-sm text-danger font-semibold mb-1">实验执行失败</div>
        <div class="text-xs text-dim">{{ progressMessage }}</div>
        <el-button size="small" class="mt-2" @click="status = 'idle'">关闭</el-button>
      </div>

      <div v-if="status === 'timeout'" class="panel-section warning-section">
        <div class="text-sm text-warning font-semibold mb-1">实验超时</div>
        <div class="text-xs text-dim">{{ progressMessage }}</div>
        <el-button size="small" class="mt-2" @click="status = 'idle'">关闭</el-button>
      </div>

      <div v-if="heatmapImages" class="panel-section">
        <div class="panel-section-title">插值场热力图直观对比</div>
        <div class="heatmap-intro">
          下方为同一应力场在不同插值方法下的 Z={{ (heatmapImages.fieldSize[2] / 2).toFixed(0) }}m
          水平截面。统一色标范围 {{ heatmapImages.globalRange.min.toFixed(1) }} ~
          {{ heatmapImages.globalRange.max.toFixed(1) }} MPa。
        </div>

        <div class="heatmap-grid">
          <div v-for="img in heatmapImages.images" :key="img.methodKey" class="heatmap-cell">
            <img :src="img.dataURL" :alt="img.label" class="heatmap-img" />
            <div class="heatmap-label">{{ img.label }}</div>
          </div>
        </div>

        <div v-if="heatmapImages.hasDiff" class="heatmap-diff">
          <div class="diff-header">
            <div class="panel-section-dot">差值分布图</div>
            <div class="text-xs text-dim">蓝→IDW低 | 白→一致 | 红→IDW高</div>
          </div>
          <img
            :src="heatmapImages.diffImage.dataURL"
            :alt="heatmapImages.diffImage.label"
            class="heatmap-img"
          />
          <div class="heatmap-label">{{ heatmapImages.diffImage.label }}</div>
        </div>

        <div class="mt-2 text-xs text-dim">
          同一色标确保视觉可比较；差值图突出两种方法在空间分布上的系统偏差区域。
        </div>
      </div>

      <div v-if="results" class="panel-section">
        <div class="panel-section-title">实验数据集概况</div>
        <div class="mb-3 p-3 rounded result-card">
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="flex justify-between">
              <span class="text-dim">训练集</span>
              <span class="stat-item font-semibold">{{ results.dataset?.trainCount }} 点</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">测试集</span>
              <span class="stat-item font-semibold">{{ results.dataset?.testCount }} 点</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">噪声水平</span>
              <span class="stat-item">{{ (results.dataset?.noiseLevel * 100).toFixed(1) }}%</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">异常点数</span>
              <span class="stat-item">{{ results.dataset?.anomalyCount }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="results?.dataset?.trainPoints?.length" class="panel-section">
        <div class="panel-section-header" @click="showRawData = !showRawData">
          <div class="panel-section-title">随机生成数据详情</div>
          <div class="text-xs text-dim">
            {{ showRawData ? '收起 ▲' : '展开 ▼' }}（共
            {{ (results.dataset?.trainCount || 0) + (results.dataset?.testCount || 0) }} 个数据点）
          </div>
        </div>

        <div v-if="showRawData" class="raw-data-container">
          <div class="raw-data-tabs">
            <button
              class="raw-tab"
              :class="{ 'raw-tab-active': rawDataTab === 'train' }"
              @click="rawDataTab = 'train'"
            >
              训练集（{{ results.dataset?.trainCount }} 点）
            </button>
            <button
              class="raw-tab"
              :class="{ 'raw-tab-active': rawDataTab === 'test' }"
              @click="rawDataTab = 'test'"
            >
              测试集（{{ results.dataset?.testCount }} 点）
            </button>
          </div>

          <div class="raw-data-toolbar">
            <span class="text-xs text-dim">
              异常点标记
              <span style="color: var(--danger-color)">● 异常点</span>
              <span style="color: var(--success-color)">● 正常点</span>
            </span>
            <span class="text-xs text-dim">
              {{ rawDataTab === 'train' ? '含噪声观测值' : '真实场真值（无噪声）' }}
            </span>
          </div>

          <div class="raw-data-table-wrap">
            <table class="raw-data-table">
              <thead>
                <tr>
                  <th class="raw-th">#</th>
                  <th class="raw-th">X (m)</th>
                  <th class="raw-th">Y (m)</th>
                  <th class="raw-th">Z (m)</th>
                  <th class="raw-th">
                    {{ rawDataTab === 'train' ? '观测值 (MPa)' : '真值 (MPa)' }}
                  </th>
                  <th v-if="rawDataTab === 'train'" class="raw-th">真值 (MPa)</th>
                  <th v-if="rawDataTab === 'train'" class="raw-th">噪声偏差</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, idx) in visibleRawData"
                  :key="idx"
                  class="raw-tr"
                  :class="{ 'raw-tr-anomaly': row.isAnomaly }"
                >
                  <td class="raw-td">
                    <span
                      class="anomaly-dot"
                      :class="row.isAnomaly ? 'dot-anomaly' : 'dot-normal'"
                    ></span>
                    {{ row.index + 1 }}
                  </td>
                  <td class="raw-td">{{ row.x.toFixed(2) }}</td>
                  <td class="raw-td">{{ row.y.toFixed(2) }}</td>
                  <td class="raw-td">{{ row.z.toFixed(2) }}</td>
                  <td class="raw-td" :class="{ 'value-anomaly': row.isAnomaly }">
                    {{ row.displayValue.toFixed(4) }}
                  </td>
                  <td v-if="rawDataTab === 'train'" class="raw-td">
                    {{ row.trueValue.toFixed(4) }}
                  </td>
                  <td v-if="rawDataTab === 'train'" class="raw-td">
                    {{ row.noiseDelta }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            v-if="
              (rawDataTab === 'train' ? results.dataset?.trainCount : results.dataset?.testCount) >
              rawDataPageSize
            "
            class="raw-data-pagination"
          >
            <el-button
              size="small"
              :disabled="rawDataPage <= 0"
              @click="rawDataPage = Math.max(0, rawDataPage - 1)"
            >
              上一页
            </el-button>
            <span class="text-xs text-dim mx-2">
              第 {{ rawDataPage + 1 }} / {{ rawDataTotalPages }} 页
            </span>
            <el-button
              size="small"
              :disabled="rawDataPage >= rawDataTotalPages - 1"
              @click="rawDataPage = Math.min(rawDataTotalPages - 1, rawDataPage + 1)"
            >
              下一页
            </el-button>
          </div>

          <div class="raw-data-stats">
            <div class="text-xs text-dim">
              {{ rawDataTab === 'train' ? '训练集统计：' : '测试集统计：' }}
              最小值 {{ rawDataStats.minVal }} MPa | 最大值 {{ rawDataStats.maxVal }} MPa | 均值
              {{ rawDataStats.meanVal }} MPa | 标准差 {{ rawDataStats.stdVal }} MPa
            </div>
          </div>
        </div>
      </div>

      <div v-if="results" class="panel-section">
        <div class="panel-section-title">实验结论</div>
        <div class="mb-3 p-3 rounded result-card-best">
          <div class="text-sm font-semibold result-highlight mb-1">
            最优方法：{{ conclusion?.bestMethod || '—' }}
          </div>
          <div class="text-xs text-dim">{{ conclusion?.summary }}</div>
        </div>
      </div>

      <div v-if="visualMetricCards.length" class="panel-section">
        <div class="panel-section-title">肉眼可见的实验对比</div>
        <div v-if="visibleSummary" class="visual-summary">
          <span class="visual-summary-label">差距结论</span>
          <span>{{ visibleSummary.text }}</span>
        </div>

        <div class="visual-grid">
          <div v-for="card in visualMetricCards" :key="card.key" class="visual-card">
            <div class="visual-card-header">
              <div>
                <div class="visual-title">{{ card.title }}</div>
                <div class="visual-caption">{{ card.caption }}</div>
              </div>
              <div class="visual-direction">{{ card.lowerIsBetter ? '越短越好' : '越长越好' }}</div>
            </div>

            <div class="visual-bars">
              <div v-for="row in card.rows" :key="row.key" class="visual-row">
                <div class="visual-method" :title="row.methodLabel">{{ row.methodLabel }}</div>
                <div class="visual-track">
                  <div
                    class="visual-fill"
                    :class="{ 'visual-fill-best': row.isBest, 'visual-fill-worst': row.isWorst }"
                    :style="{ width: `${row.barWidth}%` }"
                  ></div>
                </div>
                <div class="visual-value" :class="{ 'result-highlight font-semibold': row.isBest }">
                  {{ row.formatted }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="psoVisual" class="pso-visual">
          <div class="visual-title">PSO 优化前后差异</div>
          <div class="pso-compare-row">
            <div class="visual-method">IDW 默认参数</div>
            <div class="visual-track">
              <div class="visual-fill visual-fill-worst" style="width: 100%"></div>
            </div>
            <div class="visual-value">{{ psoVisual.defaultLabel }}</div>
          </div>
          <div class="pso-compare-row">
            <div class="visual-method">IDW-PSO</div>
            <div class="visual-track">
              <div
                class="visual-fill visual-fill-best"
                :style="{ width: `${psoVisual.optimizedWidth}%` }"
              ></div>
            </div>
            <div class="visual-value result-highlight font-semibold">
              {{ psoVisual.optimizedLabel }}
            </div>
          </div>
          <div class="mt-2 text-xs text-dim">
            绿色条缩短表示误差下降，当前 RMSE 降低 {{ psoVisual.improvement.toFixed(1) }}%。
          </div>
        </div>
      </div>

      <div v-if="stabilityRows.length" class="panel-section">
        <div class="panel-section-title">重复实验稳定性统计</div>
        <div class="stability-summary">
          已完成
          {{ results.repeatCount }} 轮重复实验。均值反映总体精度，标准差和变异系数反映结论稳定性。
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th class="p-2 border text-left">方法</th>
                <th class="p-2 border text-right">RMSE均值</th>
                <th class="p-2 border text-right">标准差</th>
                <th class="p-2 border text-right">变异系数</th>
                <th class="p-2 border text-right">稳定性</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in stabilityRows" :key="row.key" class="hover:bg-hover">
                <td class="p-2 border font-medium stat-item">{{ row.methodLabel }}</td>
                <td class="p-2 border text-right stat-item">{{ row.meanLabel }}</td>
                <td class="p-2 border text-right stat-item">{{ row.stdLabel }}</td>
                <td class="p-2 border text-right stat-item">{{ row.cvLabel }}</td>
                <td class="p-2 border text-right">
                  <span class="stability-tag" :class="`stability-${row.tone}`">{{
                    row.levelLabel
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="results" class="panel-section">
        <div class="panel-section-title">精度对比表</div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th class="p-2 border text-left">插值方法</th>
                <th
                  v-for="m in ['rmse', 'mae', 'r2', 'maxError', 'mape']"
                  :key="m"
                  class="p-2 border text-right"
                >
                  <el-tooltip effect="dark" placement="top">
                    <template #content>
                      <div class="text-xs leading-relaxed max-w-[200px]">
                        <div class="font-semibold mb-1">{{ METRIC_INTRO[m].label }}</div>
                        <div>{{ METRIC_INTRO[m].description }}</div>
                        <div class="mt-1" style="color: var(--success-color)">
                          {{ METRIC_INTRO[m].ranking }}
                        </div>
                      </div>
                    </template>
                    <span class="cursor-help border-b border-dotted border-current">{{
                      METRIC_LABELS[m]?.split('（')[0] || m.toUpperCase()
                    }}</span>
                  </el-tooltip>
                </th>
                <th class="p-2 border text-right">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in methodResults" :key="row.key" class="hover:bg-hover">
                <td class="p-2 border font-medium stat-item">{{ row.methodLabel }}</td>
                <td
                  v-for="m in row.metrics"
                  :key="m.key"
                  class="p-2 border text-right stat-item"
                  :class="{
                    'result-highlight font-semibold': m.key === 'rmse' && row.key === bestMethodKey
                  }"
                >
                  {{ m.value }}
                </td>
                <td class="p-2 border text-right text-dim">{{ row.formattedTiming }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-2 text-xs text-dim">
          说明：RMSE、MAE、R²、最大误差和 MAPE 共同反映精度与稳健性；耗时仅作为效率参考，不含 Web
          Worker 初始化开销
        </div>
      </div>

      <div v-if="results?.idw?.optimalParams" class="panel-section">
        <div class="panel-section-title">PSO 参数优化详情</div>
        <div class="p-2 rounded result-card">
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="flex justify-between">
              <span class="text-dim">最优幂指数 p</span>
              <span class="stat-item font-semibold">{{
                results.idw.optimalParams.power?.toFixed(3)
              }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">最优邻域数 k</span>
              <span class="stat-item font-semibold">{{
                results.idw.optimalParams.neighborCount
              }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">适应度值</span>
              <span class="stat-item">{{ results.idw.optimalParams.fitness?.toFixed(4) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-dim">PSO 耗时</span>
              <span class="stat-item">{{ fmtTime(results.idw.optimalParams.psoTimeMs) }}</span>
            </div>
          </div>
        </div>
        <div class="mt-1 text-xs text-dim">
          粒子群优化自动搜索 IDW 参数空间，适应度函数综合考虑 RMSE + Bias + Variance + Smoothness
        </div>
      </div>

      <div v-if="results?.idw?.optimalParams && results?.idwDefault?.metrics" class="panel-section">
        <div class="panel-section-title">PSO优化效果分析</div>
        <div class="p-2 rounded result-card">
          <div class="text-xs leading-relaxed stat-item">
            <div>
              IDW默认参数 RMSE：<span class="font-semibold">{{
                formatMetricValue(results.idwDefault.metrics.rmse, 'MPa')
              }}</span>
            </div>
            <div>
              IDW-PSO优化 RMSE：<span class="font-semibold result-highlight">{{
                formatMetricValue(results.idw.metrics.rmse, 'MPa')
              }}</span>
            </div>
            <div
              v-if="results.idwDefault.metrics.rmse && results.idw.metrics.rmse"
              class="mt-1 text-dim"
            >
              PSO优化使RMSE降低了
              {{
                (
                  ((results.idwDefault.metrics.rmse - results.idw.metrics.rmse) /
                    results.idwDefault.metrics.rmse) *
                  100
                ).toFixed(1)
              }}%
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import useExperimentPanel from '../services/panel/useExperimentPanelController.js'

const {
  config,
  results,
  status,
  progressMessage,
  currentPreset,
  selectedPreset,
  presetOptions,
  isRunning,
  progressPercent,
  methodResults,
  visualMetricCards,
  visibleSummary,
  psoVisual,
  feasibilityReport,
  stabilityRows,
  heatmapImages,
  conclusion,
  showMethodIntro,
  METHOD_INTRO,
  applyPreset,
  startExperiment,
  startRepeatedExperiment,
  cancelExperiment,
  exportResults
} = useExperimentPanel()

import {
  formatMetricValue,
  formatTimingMs as fmtTime
} from '../services/benchmark/statisticsUtils.js'

import { METRIC_LABELS, METRIC_INTRO } from '../types/experimentDefaults.js'

const bestMethodKey = computed(() => {
  if (!methodResults.value.length) return ''
  let best = methodResults.value[0]
  for (const row of methodResults.value) {
    const rmse = row.metrics?.find(m => m.key === 'rmse')?.raw
    const bestRmse = best.metrics?.find(m => m.key === 'rmse')?.raw
    if (
      rmse !== undefined &&
      rmse !== null &&
      bestRmse !== undefined &&
      bestRmse !== null &&
      rmse < bestRmse
    ) {
      best = row
    }
  }
  return best.key || ''
})

// ============ 随机生成数据展示 ============
const showRawData = ref(false)
const rawDataTab = ref('train')
const rawDataPage = ref(0)
const rawDataPageSize = 25

const rawDataTotalPages = computed(() => {
  const count =
    rawDataTab.value === 'train'
      ? results.value?.dataset?.trainCount || 0
      : results.value?.dataset?.testCount || 0
  return Math.max(1, Math.ceil(count / rawDataPageSize))
})

const rawDataStats = computed(() => {
  const ds = results.value?.dataset
  if (!ds) return { minVal: '-', maxVal: '-', meanVal: '-', stdVal: '-' }

  const values = rawDataTab.value === 'train' ? ds.trainTrueValues || [] : ds.testTrueValues || []

  if (!values.length) return { minVal: '-', maxVal: '-', meanVal: '-', stdVal: '-' }

  let min = Infinity,
    max = -Infinity,
    sum = 0
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) {
      if (n < min) min = n
      if (n > max) max = n
      sum += n
    }
  }
  const mean = sum / values.length
  let sumSq = 0
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) sumSq += (n - mean) ** 2
  }
  const std = Math.sqrt(sumSq / values.length)

  return {
    minVal: min.toFixed(4),
    maxVal: max.toFixed(4),
    meanVal: mean.toFixed(4),
    stdVal: std.toFixed(4)
  }
})

const visibleRawData = computed(() => {
  const ds = results.value?.dataset
  if (!ds) return []

  const isTrain = rawDataTab.value === 'train'
  const points = isTrain ? ds.trainPoints || [] : ds.testPoints || []
  const displayValues = isTrain ? ds.trainValues || [] : ds.testTrueValues || []
  const trueValues = isTrain ? ds.trainTrueValues || [] : []
  const anomalyFlags = isTrain ? ds.trainAnomaly || [] : ds.testAnomaly || []

  const start = rawDataPage.value * rawDataPageSize
  const end = Math.min(start + rawDataPageSize, points.length)

  const rows = []
  for (let i = start; i < end; i++) {
    const p = points[i]
    const displayVal = Number(displayValues[i])
    const trueVal = Number(trueValues[i])
    const noiseDelta = Number.isFinite(trueVal) ? (displayVal - trueVal).toFixed(4) : '-'

    rows.push({
      index: i,
      x: Number(p?.x) || 0,
      y: Number(p?.y) || 0,
      z: Number(p?.z) || 0,
      displayValue: displayVal,
      trueValue: trueVal,
      noiseDelta,
      isAnomaly: !!anomalyFlags[i]
    })
  }
  return rows
})
</script>

<style scoped>
.panel-section {
  padding: 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 10px;
}

.panel-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  margin-bottom: 0;
}

.panel-section-header .panel-section-title {
  margin-bottom: 0;
}

.panel-section-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.6rem;
  letter-spacing: 0.02em;
}

.method-intro {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.intro-block {
  padding: 0.5rem 0.6rem;
  background: var(--bg-tertiary);
  border-radius: 6px;
  border: 1px solid var(--border-primary);
}

.intro-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.formula-text {
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 0.7rem;
  color: var(--primary-light);
  background: rgba(var(--primary-rgb), 0.08);
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
  margin-bottom: 0.3rem;
  word-break: break-all;
}

.variogram-item {
  padding: 0.35rem 0.5rem;
  background: rgba(var(--primary-rgb), 0.04);
  border-radius: 4px;
}

.result-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
}

.result-card-best {
  background: rgba(103, 194, 58, 0.1);
  border: 1px solid rgba(103, 194, 58, 0.25);
}

.result-highlight {
  color: var(--success-color);
}

.feasibility-card {
  padding: 0.7rem;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
}

.feasibility-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.6rem;
}

.feasibility-title {
  color: var(--text-primary);
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.35;
}

.feasibility-text,
.feasibility-note {
  margin-top: 0.35rem;
  color: var(--text-muted);
  font-size: 0.7rem;
  line-height: 1.45;
}

.feasibility-note {
  padding-top: 0.45rem;
  border-top: 1px solid var(--border-primary);
}

.feasibility-badge {
  flex: 0 0 auto;
  padding: 0.22rem 0.45rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  white-space: nowrap;
}

.feasibility-badge-good {
  color: var(--success-color);
  background: rgba(103, 194, 58, 0.12);
  border: 1px solid rgba(103, 194, 58, 0.28);
}

.feasibility-badge-ok {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.12);
  border: 1px solid rgba(230, 162, 60, 0.28);
}

.design-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.65rem;
  margin-top: 0.75rem;
}

.design-block {
  padding: 0.65rem;
  background: rgba(var(--primary-rgb), 0.05);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 6px;
}

.design-title {
  margin-bottom: 0.4rem;
  color: var(--text-primary);
  font-size: 0.76rem;
  font-weight: 700;
}

.design-line {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.45;
}

.design-line + .design-line {
  margin-top: 0.25rem;
}

.control-line {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 0.45rem;
  font-size: 0.7rem;
  line-height: 1.45;
}

.control-line + .control-line {
  margin-top: 0.3rem;
}

.control-label {
  color: var(--text-primary);
  font-weight: 700;
}

.control-value {
  color: var(--text-secondary);
}

.warning-list {
  margin-top: 0.65rem;
  padding: 0.55rem 0.65rem;
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.1);
  border: 1px solid rgba(230, 162, 60, 0.24);
  border-radius: 6px;
}

.warning-line {
  font-size: 0.7rem;
  line-height: 1.45;
}

.warning-line + .warning-line {
  margin-top: 0.25rem;
}

.visual-summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  padding: 0.55rem 0.65rem;
  color: var(--text-primary);
  background: rgba(103, 194, 58, 0.1);
  border: 1px solid rgba(103, 194, 58, 0.25);
  border-radius: 6px;
  font-size: 0.75rem;
  line-height: 1.35;
}

.visual-summary-label {
  flex: 0 0 auto;
  color: var(--success-color);
  font-weight: 700;
}

.visual-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.visual-card,
.pso-visual {
  padding: 0.65rem;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
}

.visual-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.6rem;
  margin-bottom: 0.55rem;
}

.visual-title {
  color: var(--text-primary);
  font-size: 0.78rem;
  font-weight: 700;
}

.visual-caption,
.visual-direction {
  color: var(--text-muted);
  font-size: 0.68rem;
  line-height: 1.35;
}

.visual-direction {
  flex: 0 0 auto;
  padding-top: 0.05rem;
}

.visual-bars {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.visual-row,
.pso-compare-row {
  display: grid;
  grid-template-columns: minmax(82px, 0.95fr) minmax(90px, 1.45fr) minmax(48px, auto);
  align-items: center;
  gap: 0.45rem;
  min-height: 24px;
}

.visual-method {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.visual-track {
  position: relative;
  height: 10px;
  overflow: hidden;
  background: rgba(var(--primary-rgb), 0.1);
  border: 1px solid rgba(var(--primary-rgb), 0.16);
  border-radius: 999px;
}

.visual-fill {
  height: 100%;
  min-width: 3px;
  background: linear-gradient(90deg, #409eff, #7ab8ff);
  border-radius: inherit;
}

.visual-fill-best {
  background: linear-gradient(90deg, #2fb344, #7fd26b);
}

.visual-fill-worst {
  background: linear-gradient(90deg, #f56c6c, #f3a35c);
}

.visual-value {
  color: var(--text-secondary);
  font-size: 0.68rem;
  text-align: right;
  white-space: nowrap;
}

.pso-visual {
  margin-top: 0.75rem;
}

.pso-visual .visual-title {
  margin-bottom: 0.55rem;
}

.stability-summary {
  margin-bottom: 0.65rem;
  color: var(--text-muted);
  font-size: 0.72rem;
  line-height: 1.45;
}

.stability-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.4rem;
  padding: 0.12rem 0.38rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
}

.stability-good {
  color: var(--success-color);
  background: rgba(103, 194, 58, 0.12);
}

.stability-ok {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.12);
}

.stability-warn {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.12);
}

table {
  font-size: 0.75rem;
}

th {
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  white-space: nowrap;
}

td,
th {
  border-color: var(--border-primary);
}

.text-dim {
  color: var(--text-muted);
}

.stat-item {
  color: var(--text-primary);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-primary);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.error-section {
  border-color: rgba(245, 108, 108, 0.3);
  background: rgba(245, 108, 108, 0.08);
}

.error-section .text-danger {
  color: #f56c6c;
}

.warning-section {
  border-color: rgba(230, 162, 60, 0.3);
  background: rgba(230, 162, 60, 0.08);
}

.warning-section .text-warning {
  color: #e6a23c;
}

.heatmap-intro {
  margin-bottom: 0.65rem;
  color: var(--text-muted);
  font-size: 0.7rem;
  line-height: 1.45;
}

.heatmap-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.heatmap-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.heatmap-img {
  width: 100%;
  max-width: 280px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  display: block;
}

.heatmap-label {
  margin-top: 0.3rem;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-primary);
  text-align: center;
}

.heatmap-diff {
  margin-top: 0.65rem;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.diff-header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
}

.panel-section-dot {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
}

/* 随机生成数据详情 */
.raw-data-container {
  margin-top: 0.65rem;
  padding-top: 0.65rem;
  border-top: 1px solid var(--border-primary);
}

.raw-data-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 0.5rem;
}

.raw-tab {
  flex: 1;
  padding: 0.35rem 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  cursor: pointer;
  transition: all 0.15s;
}

.raw-tab:first-child {
  border-radius: 6px 0 0 6px;
}

.raw-tab:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}

.raw-tab-active {
  color: #fff;
  background: var(--primary-color);
  border-color: var(--primary-color);
}

.raw-data-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.4rem;
  padding: 0.3rem 0.5rem;
  background: var(--bg-tertiary);
  border-radius: 4px;
}

.raw-data-table-wrap {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border-primary);
  border-radius: 6px;
}

.raw-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.68rem;
}

.raw-th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.35rem 0.45rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 2px solid var(--border-primary);
  text-align: right;
  white-space: nowrap;
}

.raw-th:first-child {
  text-align: center;
}

.raw-tr {
  transition: background 0.12s;
}

.raw-tr:hover {
  background: var(--hover-bg);
}

.raw-tr:nth-child(even) {
  background: rgba(var(--primary-rgb), 0.03);
}

.raw-tr:hover {
  background: rgba(var(--primary-rgb), 0.08);
}

.raw-tr-anomaly {
  background: rgba(245, 108, 108, 0.06) !important;
}

.raw-tr-anomaly:nth-child(even) {
  background: rgba(245, 108, 108, 0.09) !important;
}

.raw-tr-anomaly:hover {
  background: rgba(245, 108, 108, 0.14) !important;
}

.raw-td {
  padding: 0.25rem 0.45rem;
  color: var(--text-primary);
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.08);
}

.raw-td:first-child {
  text-align: center;
}

.anomaly-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 3px;
  vertical-align: middle;
}

.dot-normal {
  background: var(--success-color);
}

.dot-anomaly {
  background: var(--danger-color, #f56c6c);
}

.value-anomaly {
  color: var(--danger-color, #f56c6c);
  font-weight: 600;
}

.raw-data-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 0.5rem;
}

.raw-data-stats {
  margin-top: 0.4rem;
  padding: 0.4rem 0.5rem;
  background: var(--bg-tertiary);
  border-radius: 4px;
}
</style>
