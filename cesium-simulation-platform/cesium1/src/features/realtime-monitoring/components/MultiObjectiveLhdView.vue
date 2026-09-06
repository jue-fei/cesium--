<template>
  <div class="moo-lhd" :class="expanded ? 'moo-expanded p-5 md:p-7' : 'p-3.5'">
    <!-- ===== 头部：结论性标题 + 状态/统计/操作 ===== -->
    <header class="moo-header">
      <div class="moo-title-block">
        <div class="moo-kicker">NSGA-III · 帕累托前沿优化</div>
        <h2 class="moo-title" :class="expanded && 'moo-title-lg'">井下铲运机多目标联合调度</h2>
      </div>

      <div class="moo-tools">
        <span class="moo-status is-ready">
          <span class="moo-status-dot"></span>
          {{ statusLabel }}
        </span>
        <span v-if="noCandidates" class="moo-note">无可用候选（等待后端快照）</span>
        <div class="moo-stats">
          <span class="stat"
            ><b>{{ equipIds.length }}</b
            >台设备</span
          >
          <span class="stat-divider"></span>
          <span class="stat"
            ><b>{{ zoneNames.length }}</b
            >个采场</span
          >
          <span class="stat-divider"></span>
          <span class="stat"
            ><b>{{ totalCandidates }}</b
            >条候选</span
          >
          <span class="stat-divider"></span>
          <span class="stat"
            ><b>{{ paretoSize }}</b
            >个 Pareto 方案</span
          >
        </div>
        <button v-if="!expanded" class="moo-btn moo-btn-accent" @click="$emit('toggle-expand')">
          放大查看
        </button>
        <button v-else class="moo-btn" @click="$emit('toggle-expand')">关闭（Esc）</button>
      </div>
    </header>

    <!-- ===== 采场摘要卡片 + 按采场筛选切换 ===== -->
    <section class="zone-strip" aria-label="采场摘要与筛选">
      <button
        type="button"
        class="zone-card zone-all"
        :class="zoneFilter === 'all' && 'is-active'"
        @click="zoneFilter = 'all'"
      >
        <i class="zc-glyph">全</i>
        <b class="zc-name">全部采场</b>
        <span class="zc-meta">联合调度 · 跨采场冲突并算</span>
        <span class="zc-cov ok">全局视图</span>
      </button>
      <button
        v-for="z in zoneCards"
        :key="'zc' + z.zone"
        type="button"
        class="zone-card"
        :class="[zoneFilter === z.zone && 'is-active', z.covered ? 'is-covered' : '']"
        @click="zoneFilter = zoneFilter === z.zone ? 'all' : z.zone"
      >
        <i class="zc-glyph" :style="{ background: zoneColorMap[z.zone] }">{{ z.zone.charAt(0) }}</i>
        <b class="zc-name" :style="{ color: zoneColorMap[z.zone] }">{{ z.zone }}</b>
        <span class="zc-muck">{{ z.muckIds.join(' / ') }}</span>
        <span class="zc-meta"
          >剩余 <b>{{ z.remainingWorkT }}</b> t · 品位 <b>{{ z.avgGradePct }}</b
          >%</span
        >
        <span class="zc-cov" :class="z.covered ? 'ok' : 'miss'">{{
          z.covered ? '已派车' : '待派车'
        }}</span>
      </button>
      <span class="zone-filter-hint">点击卡片切换 3D 高亮该采场出矿线</span>
    </section>

    <!-- ===== 证据区：展开态=当前方案整行 + 巷道图主舞台(前沿叠右侧、明细表叠右上) ===== -->
    <section class="moo-evidence">
      <!-- 当前建议方案（展开态位于地图上方整行） -->
      <div v-if="selected" class="panel rec-panel">
        <div class="panel-head">
          <div class="panel-label">
            当前建议方案
            <span class="rec-badge">P{{ selectedIndex + 1 }} · 推荐</span>
          </div>
          <div class="panel-hint">随点选联动</div>
        </div>
        <div class="panel-body rec-body">
          <div class="rec-obj-grid">
            <div
              v-for="obj in objectives"
              :key="'rec' + obj.id"
              class="rec-obj"
              :title="obj.why || obj.desc"
            >
              <span class="rec-obj-name">{{ obj.name }}</span>
              <b class="rec-obj-val" :class="'dir-' + (obj.dir === 'min' ? 'min' : 'max')">
                {{ fmt(selected.objectives[obj.id]) }}
              </b>
              <span class="rec-obj-dir">
                {{ obj.unit ? obj.unit + ' · ' : ''
                }}{{ obj.dir === 'min' ? '↓ 越小越好' : '↑ 越大越好' }}
              </span>
            </div>
          </div>
          <div class="rec-divider"></div>
          <div class="rec-route-list">
            <div v-for="(id, i) in equipIds" :key="'rr' + i" class="rec-route-item">
              <span
                class="rec-equip"
                :style="{ background: pathColors[i] + '22', color: pathColors[i] }"
                >{{ cnId(id) }}</span
              >
              <i
                v-if="routeZoneOf(i)"
                class="rec-zone-dot"
                :style="{ background: zoneColorMap[routeZoneOf(i)] }"
                :title="'所属采场：' + routeZoneOf(i)"
              ></i>
              <span class="rec-target">{{ cnPath(routeStep(i)) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 地图 + 右侧栏 横向 flex 容器：地图的宽度/高宽比决定整行高度，右侧栏贴合地图高度 -->
      <div class="map-row">
        <!-- 巷道图主舞台：地图为底，前沿叠右侧 / 明细表叠右上 -->
        <div class="map-stage">
          <!-- 巷道网络 -->
          <div class="panel map-panel">
            <div class="panel-head">
              <div class="panel-label">巷道网络与派送路径</div>
              <div class="panel-hint">
                {{
                  optSourceLabel
                    ? `方案 ${selectedIndex + 1} · ${optSourceLabel}`
                    : `方案 ${selectedIndex + 1}`
                }}
              </div>
            </div>
            <div class="panel-body">
              <!-- 三维巷道网络：隧道管道 + 节点标记 + 设备巡游 + 派送路线（按采场着色） -->
              <TunnelMap3D
                :segments="segmentLines"
                :nodes="nodePositions"
                :meta-by-id="metaById"
                :routes="routePoints"
                :route-zones="routeZones"
                :zone-colors="zoneColorMap"
                :active-zone="activeZone"
                :levels="levels"
                :equip-colors="pathColors"
                :equip-names="equipNames"
                :node-heights="nodeHeights"
                :active-seg-id="activeSegId"
                @select="activeSegId = $event"
                @clear="activeSegId = ''"
              />

              <!-- 路段约束详情条：点击巷道段后展开（每段独立编号 + 专有安全信息） -->
              <div v-if="activeSegId" class="seg-detail">
                <div class="seg-detail-head">
                  <b class="seg-detail-id">{{ cnId(activeSegId) }}</b>
                  <span class="seg-detail-name">{{ segMeta(activeSegId).name || '—' }}</span>
                  <span class="seg-detail-risk" :class="riskOf(segMeta(activeSegId)).clazz">
                    {{ riskOf(segMeta(activeSegId)).label }} · 评分{{
                      riskOf(segMeta(activeSegId)).score
                    }}
                  </span>
                  <span class="seg-detail-status" :class="segState(segMeta(activeSegId)).clazz">
                    {{ segState(segMeta(activeSegId)).label }}
                  </span>
                  <button class="seg-detail-close" title="关闭" @click="activeSegId = ''">×</button>
                </div>
                <div
                  v-if="
                    segMeta(activeSegId).blocked || segMeta(activeSegId).passableLoaded === false
                  "
                  class="seg-detail-alert"
                >
                  <span v-if="segMeta(activeSegId).blocked">⚠ 本路段封锁中，暂不通车</span>
                  <span v-else>⚠ 本路段重载禁行，满载铲运车无法通过</span>
                </div>
                <div class="seg-detail-grid">
                  <div class="sd-item">
                    <span>净宽</span><b>{{ fmtM(segMeta(activeSegId).clearWidthM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>净高</span><b>{{ fmtM(segMeta(activeSegId).clearHeightM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>坡度</span><b>{{ fmtV(segMeta(activeSegId).maxGradePct) }}%</b>
                  </div>
                  <div class="sd-item">
                    <span>转弯半径</span><b>{{ fmtM(segMeta(activeSegId).minTurnRadiusM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>长度</span><b>{{ fmtM(segMeta(activeSegId).lengthM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>炮烟</span
                    ><b :class="barColor(segMeta(activeSegId).smoke)">{{
                      pct(segMeta(activeSegId).smoke)
                    }}</b>
                  </div>
                  <div class="sd-item">
                    <span>拥堵</span
                    ><b :class="barColor(segMeta(activeSegId).congestion)">{{
                      pct(segMeta(activeSegId).congestion)
                    }}</b>
                  </div>
                  <div class="sd-item">
                    <span>岩爆</span
                    ><b :class="barColor(segMeta(activeSegId).rockburst)">{{
                      pct(segMeta(activeSegId).rockburst)
                    }}</b>
                  </div>
                </div>
              </div>

              <!-- 图例 -->
              <div class="legend-row">
                <span class="legend-item"> <i class="lv-dot lv-dump"></i> S0 卸载/溜井口 </span>
                <span class="legend-item">
                  <i class="lv-dot lv-muck"></i> M1~M{{ Math.max(zoneNames.length, 1) }} 装载点
                </span>
                <span class="legend-item"> <i class="lv-dot lv-node"></i> N 交叉节点 </span>
                <span class="legend-item legend-state">
                  <i class="lv-dot lv-state-ok"></i>通畅 <i class="lv-dot lv-state-ban"></i>禁行
                  <i class="lv-dot lv-state-block"></i>封锁
                </span>
                <span v-for="z in zoneNames" :key="'zl' + z" class="legend-item legend-zone">
                  <i class="lv-dot" :style="{ background: zoneColorMap[z] }"></i>{{ z }}
                </span>
                <span v-for="(c, i) in pathColors" :key="'pl' + i" class="legend-item legend-path">
                  <i class="lv-line" :style="{ background: c }"></i>
                  {{ cnId(equipIds[i]) || '设备' + (i + 1) }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <!-- /map-stage -->

        <!-- 右侧栏：坐标轴(上,1份) + 方案明细表(下,3份)，底部与地图对齐 -->
        <div class="map-side">
          <!-- 帕累托前沿（任意两两目标投影，带刻度） -->
          <div class="panel pf-panel">
            <div class="panel-head">
              <div class="panel-label">帕累托前沿</div>
              <div class="panel-controls">
                <select v-model.number="pairIdx" class="pf-pair-select" @change="selectedIndex = 0">
                  <option v-for="(pr, k) in pairOptions" :key="pr.label" :value="k">
                    {{ pr.label }}
                  </option>
                </select>
                <div class="panel-hint">{{ paretoSize }} 个非劣解 · 点击选方案</div>
              </div>
            </div>
            <div v-if="sparseFrontNote" class="pf-note">{{ sparseFrontNote }}</div>
            <div class="panel-body pf-body">
              <svg
                :viewBox="'0 0 200 150'"
                class="w-full h-auto"
                preserveAspectRatio="xMidYMid meet"
              >
                <!-- 网格（对齐刻度） -->
                <g class="grid-lines">
                  <line
                    v-for="tk in paretoScatter.xTicks"
                    :key="'gxv' + tk.px"
                    :y1="PLOT.y0"
                    :y2="PLOT.y1"
                    :x1="tk.px"
                    :x2="tk.px"
                    stroke="#ffffff"
                    stroke-opacity="0.04"
                  />
                  <line
                    v-for="tk in paretoScatter.yTicks"
                    :key="'gyv' + tk.py"
                    :x1="PLOT.x0"
                    :x2="PLOT.x1"
                    :y1="tk.py"
                    :y2="tk.py"
                    stroke="#ffffff"
                    stroke-opacity="0.04"
                  />
                </g>
                <!-- 坐标轴线 -->
                <line
                  :x1="PLOT.x0"
                  :x2="PLOT.x1"
                  :y1="PLOT.y1"
                  :y2="PLOT.y1"
                  stroke="#e2e8f0"
                  stroke-opacity="0.25"
                />
                <line
                  :x1="PLOT.x0"
                  :x2="PLOT.x0"
                  :y1="PLOT.y0"
                  :y2="PLOT.y1"
                  stroke="#e2e8f0"
                  stroke-opacity="0.25"
                />
                <!-- X 轴刻度 + 数值 -->
                <g v-for="tk in paretoScatter.xTicks" :key="'xt' + tk.px">
                  <line :x1="tk.px" :x2="tk.px" :y1="PLOT.y1" :y2="PLOT.y1 + 4" stroke="#64748b" />
                  <text
                    :x="tk.px"
                    :y="PLOT.y1 + 13"
                    fill="#94a3b8"
                    font-size="6.5"
                    text-anchor="middle"
                  >
                    {{ fmtTick(tk.v) }}
                  </text>
                </g>
                <!-- Y 轴刻度 + 数值 -->
                <g v-for="tk in paretoScatter.yTicks" :key="'yt' + tk.py">
                  <line :x1="PLOT.x0" :x2="PLOT.x0 - 4" :y1="tk.py" :y2="tk.py" stroke="#64748b" />
                  <text
                    :x="PLOT.x0 - 5"
                    :y="tk.py + 2.5"
                    fill="#94a3b8"
                    font-size="6.5"
                    text-anchor="end"
                  >
                    {{ fmtTick(tk.v) }}
                  </text>
                </g>
                <!-- 前沿线 + 解点 -->
                <polyline
                  v-if="paretoScatter.points.length > 1"
                  :points="paretoScatter.points.map(p => `${p.x},${p.y}`).join(' ')"
                  fill="none"
                  stroke="#22d3ee"
                  stroke-opacity="0.25"
                  stroke-width="1.5"
                />
                <circle
                  v-for="(pt, idx) in paretoScatter.points"
                  :key="'pf' + idx"
                  :cx="pt.x"
                  :cy="pt.y"
                  r="4.5"
                  :fill="pt.selected ? '#E6A23C' : '#22a06b'"
                  :stroke="pt.selected ? '#fff' : 'none'"
                  :stroke-width="pt.selected ? 1.5 : 0"
                  class="pf-point"
                  :class="pt.selected ? '' : 'is-clickable'"
                  :title="`${paretoScatter.xObj?.name}:${fmtTickPoint(pt, paretoScatter)} · 方案${pt.pfIndex + 1}`"
                  @click="!pt.selected && selectByIndex(pt.pfIndex)"
                />
                <!-- 轴标题 -->
                <text :x="PLOT.x1" :y="PLOT.y1 + 20" fill="#94a3b8" font-size="8" text-anchor="end">
                  {{ paretoScatter.xObj?.name }} → ({{ paretoScatter.xObj?.unit || '-' }})
                </text>
                <text
                  :x="7"
                  :y="PLOT.y0 + 52"
                  fill="#94a3b8"
                  font-size="8"
                  text-anchor="middle"
                  transform="rotate(-90 7 66)"
                >
                  {{ paretoScatter.yObj?.name }} ({{ paretoScatter.yObj?.unit || '-' }}) →
                </text>
              </svg>
              <div class="legend-row legend-scatter">
                <span class="legend-item"> <i class="lv-dot lv-pareto"></i> 帕累托解 </span>
                <span class="legend-item"> <i class="lv-dot lv-selected"></i> 当前选中 </span>
                <span class="legend-item legend-front"> <i class="lv-dash"></i> 前沿线 </span>
              </div>
            </div>
          </div>

          <!-- 方案明细表（学术化、紧凑，点击整行联动） -->
          <div class="panel moo-table-panel">
            <div class="panel-head">
              <div class="panel-label">帕累托解 · 方案明细</div>
              <div class="panel-hint" :class="sortKeys.length ? 'has-sort' : ''">
                <template v-if="sortKeys.length">
                  <span class="sort-crumb">排序</span>
                  <span v-for="(k, i) in sortKeys" :key="k.id" class="sort-chip">
                    {{ i + 1 }}.{{ objName(k.id) }} {{ k.dir === 'asc' ? '↑' : '↓' }}
                  </span>
                  <button
                    type="button"
                    class="sort-clear"
                    title="清除全部排序"
                    @click="clearSort()"
                  >
                    ×清零
                  </button>
                </template>
                <template v-else>N={{ paretoSize }} · 点列头排序 / Shift 叠加复合</template>
              </div>
            </div>
            <div class="table-scroll">
              <table class="moo-table moo-table-academic" :class="{ 'is-compact': !expanded }">
                <thead>
                  <tr>
                    <th class="tc-idx">方案</th>
                    <th v-for="obj in objectives" :key="obj.id" class="tc-obj">
                      <button
                        type="button"
                        class="th-sort"
                        :class="['th-sort-' + obj.dir, sortRank(obj.id) != null ? 'is-active' : '']"
                        :title="`${obj.why || obj.desc}｜点击排序，Shift+点击叠加复合排序`"
                        @click.stop.prevent="onSortClick(obj.id, $event)"
                      >
                        <span class="th-sort-inner">
                          <el-tooltip effect="dark" placement="top" :content="obj.why || obj.desc">
                            <span class="th-tip">{{ obj.name }}</span>
                          </el-tooltip>
                          <span class="th-meta"
                            >{{ obj.unit || '' }}<i :class="'arr arr-' + obj.dir" />
                          </span>
                        </span>
                        <span class="th-sort-arr">
                          <i class="sa-icon" :class="sortDirCls(obj.id)" />
                          <b v-if="sortRank(obj.id) != null" class="th-rank">{{
                            sortRank(obj.id) + 1
                          }}</b>
                        </span>
                      </button>
                    </th>
                    <th class="tc-route">设备选路</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in sortedRows"
                    :key="'row' + row.pfIndex"
                    class="moo-row"
                    :class="row.pfIndex === selectedIndex ? 'is-selected' : 'is-clickable'"
                    @click="selectByIndex(row.pfIndex)"
                  >
                    <td class="tc-idx">
                      <span class="idx-chip">{{ row.pfIndex + 1 }}</span>
                      <span v-if="row.pfIndex === selectedIndex" class="rec-tag">推荐</span>
                    </td>
                    <td v-for="obj in objectives" :key="'v' + obj.id" class="tc-obj">
                      <b class="obj-val">{{ fmt(row.ind.objectives[obj.id]) }}</b>
                    </td>
                    <td class="tc-route">
                      <div class="rc-wrap">
                        <span
                          v-for="(ci, i) in row.ind.assignment"
                          :key="'rt' + i"
                          class="route-chip"
                          :class="{ 'is-wait': ci >= (candidates[i]?.length || 0) }"
                          :style="{ '--rc': chipColor(i, ci) }"
                          :title="chipTitle(i, ci)"
                        >
                          {{ chipLabel(i, ci) }}
                        </span>
                        <span
                          class="row-cov"
                          :class="row.ind.objectives._constraint?.isFeasible ? 'is-ok' : 'is-miss'"
                          :title="covTitle(row.ind.assignment)"
                        >
                          {{ covText(row.ind.assignment) }}
                        </span>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="paretoFront.length === 0">
                    <td :colspan="objectives.length + 2" class="empty-row">暂无帕累托解</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <!-- /map-side -->
      </div>
      <!-- /map-row -->
    </section>

    <!-- ===== 行动带：执行 + 反馈 + 结论 ===== -->
    <section class="moo-action">
      <div class="action-main">
        <button
          class="moo-btn moo-btn-execute"
          :class="!canExecute && 'is-disabled'"
          :disabled="!canExecute"
          @click="executeSelected"
        >
          <span class="btn-icon"></span>
          执行该方案（派单给后端）
        </button>
        <span v-if="feedback" class="action-feedback">{{ feedback }}</span>
      </div>
      <div class="action-note">
        能耗 · 时效 · 安全 · 协同 · 负载 · 回收 · 采场均衡 · 积压 八要素 → NSGA-III 求帕累托前沿，
        硬约束：采区全覆盖（有矿采场至少一车）+ 品位下限 0.6%。候选路线均为「采矿点 → 出口」重载
        出矿线，按采场着色/标注；跨采场同时运输的共享巷道冲突由「巷道冲突」目标并算。
        <span class="ref-note"
          >口径：王雷等(2025)、贾纯纯等(2025) 多采场调度/品位容量约束；Wang 等(2020)
          采场矿石量输入； Freire 等(2023)LHD 15km/h、Hooli 等(2024) 装载40s/卸载15s/调整30s
          校核时效。设备规模参照大型地下矿（如 Khoemacau 铜矿 10 台
          LHD；锦丰金矿多中段出矿）。</span
        >
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, shallowRef, watch, onMounted } from 'vue'
import {
  decodeAssignment,
  LHD_OBJECTIVES,
  GRADE_FLOOR_PCT,
  assignmentZoneStats
} from '../services/lhdSchedulingUtils.js'
import { buildLayout, pathToPoints, deriveRiserMeta } from '../services/undergroundLayout.js'
import { riskScore, riskLevel, baseRiskScore } from '../services/riskUtils.js'
import { fetchScenarioConfig } from '../services/scenarioConfig.js'
import TunnelMap3D from './TunnelMap3D.vue'

defineOptions({ name: 'MultiObjectiveLhdView' })

// 全屏状态由父级（LhdSchedulingPanel）管理：放大时跳出当前面板，近全屏查看
const props = defineProps({
  snapshot: { type: Object, default: null },
  applyAssignment: { type: Function, default: null },
  scenario: { type: String, default: 'ashale' },
  expanded: { type: Boolean, default: false }
})
defineEmits(['toggle-expand'])

const selectedIndex = ref(0)
const feedback = ref('')
const activeSegId = ref('')

// ===== 优化结果：直接消费后端预计算结果 =====
// NSGA-III / 精确穷举已在后端快照阶段算好（backend-py/services/scheduling/multi_objective.py，
// 按候选内容缓存式预计算），随 snapshot.factors.optimization.paretoFront 下发；
// 前端打开本板块直接使用，不再在浏览器里运行算法。
const backendOpt = computed(() => props.snapshot?.factors?.optimization || null)

const result = computed(() => {
  const opt = backendOpt.value
  if (opt?.paretoFront && Array.isArray(opt.paretoFront) && opt.paretoFront.length > 0) {
    return {
      paretoFront: opt.paretoFront,
      objectives: opt.objectiveDefs?.length ? opt.objectiveDefs : LHD_OBJECTIVES,
      stats: opt.optStats || null
    }
  }
  return null
})

// 优化结果来源标注：后端统一由 pymoo NSGA-III 求解
const optSourceLabel = computed(() => {
  const s = backendOpt.value?.optStats?.source
  if (s === 'nsga3') return '后端 NSGA-III · pymoo'
  return ''
})
const statusLabel = computed(() => (optSourceLabel.value ? '就绪 · 后端预计算' : '就绪'))

// 场景布局：由后端 /api/scheduling/config?scenario=<名> 下发，buildLayout 动态构建
// 巷道 2D 布局 / 三维分层 / 深部分层段——新增巷道只需改场景 JSON，前端自动适配。
const layout = shallowRef(null)
onMounted(() => {
  fetchScenarioConfig(props.scenario).then(cfg => {
    if (cfg) layout.value = buildLayout(cfg)
  })
})
// 场景切换时重新拉取配置
watch(
  () => props.scenario,
  () => {
    fetchScenarioConfig(props.scenario).then(cfg => {
      layout.value = cfg ? buildLayout(cfg) : null
    })
  }
)

const pathColors = ['#67C23A', '#409EFF', '#F56C6C', '#E6A23C', '#909399', '#9C27B0']

// 采场配色：三维路线/表格芯片/摘要卡片 / 图例共用一个色板，保证"颜色=采场归属"全局一致
const ZONE_PALETTE = [
  '#F59E0B',
  '#10B981',
  '#38BDF8',
  '#8B5CF6',
  '#EC4899',
  '#F97316',
  '#14B8A6',
  '#6366F1'
]
const gradeFloorPct = GRADE_FLOOR_PCT

// 采区摘要（后端 snapshot.optimization.stopes 下发：zone/muckIds/remainingWorkT/avgGradePct）
const stopes = computed(() => props.snapshot?.factors?.optimization?.stopes || [])
const zoneNames = computed(() => stopes.value.map(s => s.zone))
const zoneColorMap = computed(() => {
  const m = {}
  stopes.value.forEach((s, i) => {
    m[s.zone] = ZONE_PALETTE[i % ZONE_PALETTE.length]
  })
  return m
})
// 按采场筛选：'all'=全局联合视图；选中某采场时 3D 只高亮该采场出矿线
const zoneFilter = ref('all')
const activeZone = computed(() => (zoneFilter.value === 'all' ? '' : zoneFilter.value))

// 空载设备数（提供候选）与有矿采场数：两者相等时"全覆盖"约束为 1:1，
// 真实非支配方案天然很少——在前沿面板给出引导提示，避免误以为算法异常。
const emptyEquipCount = computed(
  () => equipmentItems.value.filter(e => e.loadMode === 'empty' || e.state === 'idle').length
)
const sparseFrontNote = computed(() => {
  if (!paretoFront.value.length) return ''
  if (paretoFront.value.length >= 4) return ''
  const eqN = emptyEquipCount.value
  const zoneN = zoneNames.value.length
  if (eqN >= zoneN) {
    return `当前 ${eqN} 台空载设备需全覆盖 ${zoneN} 个有矿采场（1 车 1 采场），可行非劣方案仅 ${paretoFront.value.length} 个；可切换坐标轴查看多维差异，全部方案见下方明细表。`
  }
  return `当前可行非劣方案 ${paretoFront.value.length} 个；可切换坐标轴对查看不同目标维度，全部方案见下方明细表。`
})

// 采场卡片：候选人所在采场（后端候选只覆盖有矿采场），叠加当前选中方案的派车状态
const zoneCards = computed(() => {
  const cards = stopes.value.map(s => ({ ...s, covered: false }))
  const { served } = assignmentZoneStats(selected.value?.assignment || [], candidates.value)
  for (const c of cards) c.covered = served.has(c.zone)
  return cards
})

// 选中方案各设备路线所属采场（与 routePoints 同序，供 3D 按采场着色）
const routeZones = computed(() =>
  candidates.value.map((cands, i) => {
    const ci = selected.value?.assignment?.[i]
    if (ci == null || ci >= cands.length) return ''
    return cands[ci]?.zone || ''
  })
)

// —— 方案明细表：设备选路芯片按采场着色 + 采场覆盖/品位摘要 ——
function routeZoneOf(i) {
  const cands = candidates.value[i]
  const ci = selected.value?.assignment?.[i]
  if (!cands || ci == null || ci >= cands.length) return ''
  return cands[ci]?.zone || ''
}
function chipColor(i, ci) {
  const cands = candidates.value[i]
  if (!cands || ci >= cands.length) return pathColors[i] // 等待伪候选：设备色
  return zoneColorMap.value[cands[ci]?.zone] || pathColors[i]
}
function chipLabel(i, ci) {
  const cands = candidates.value[i]
  if (!cands || ci >= cands.length) return `${cnId(equipIds.value[i])} → 等待`
  const c = cands[ci]
  return `${cnId(equipIds.value[i])} → ${c.target}${c.zone ? ' · ' + c.zone : ''}`
}
function chipTitle(i, ci) {
  const cands = candidates.value[i]
  if (!cands || ci >= cands.length) return `${cnId(equipIds.value[i])} 本趟等待`
  const c = cands[ci]
  const parts = [
    `设备：${cnId(equipIds.value[i])}`,
    `采场：${c.zone || '-'}`,
    `装载点：${c.target}`,
    `品位：${(c.gradePct ?? 0).toFixed(1)}%`,
    `剩余工作量：${c.remainingWorkT ?? '-'} t`,
    `路线：${c.path?.join('→') || '-'}`,
    `能耗 ${(c.energyTotal ?? 0).toFixed(1)} kWh · 用时 ${(c.timeMin ?? 0).toFixed(1)} min`
  ]
  return parts.join('\n')
}
// 每个方案的采场覆盖 / 加权品位摘要
function covText(assignment) {
  const { served, assigned } = assignmentZoneStats(assignment, candidates.value)
  const total = zoneNames.value.length
  const covN = zoneNames.value.filter(z => served.has(z)).length
  const grades = assigned.map(a => a.c.gradePct || 0)
  const avg = grades.length ? (grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2) : '-'
  const missing = zoneNames.value.filter(z => !served.has(z)).join('/')
  return `覆盖 ${covN}/${total}${missing ? ' · 缺 ' + missing : ''} · 加权品位 ${avg}%`
}
function covTitle(assignment) {
  const cst = assignmentZoneStats(assignment, candidates.value)
  const grades = cst.assigned.map(a => a.c.gradePct || 0)
  const avg = grades.length ? (grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2) : '-'
  return `硬约束：采区全覆盖（有矿采场至少一车）+ 加权品位 ≥ ${gradeFloorPct}%\n加权品位 ${avg}%（当前方案）`
}

const candidatesByEquip = computed(() => props.snapshot?.factors?.optimization?.byEquipment || {})
const equipmentItems = computed(() => props.snapshot?.factors?.equipment?.items || [])
const equipIds = computed(() => equipmentItems.value.map(e => e.id))
const candidates = computed(() => equipIds.value.map(id => candidatesByEquip.value[id] || []))
const noCandidates = computed(
  () => candidates.value.length === 0 || candidates.value.every(c => !c.length)
)
const totalCandidates = computed(() => candidates.value.reduce((s, c) => s + c.length, 0))

const paretoFront = computed(() => result.value?.paretoFront || [])
const paretoSize = computed(() => paretoFront.value.length)
const objectives = computed(() => result.value?.objectives || LHD_OBJECTIVES)

const selected = computed(() => paretoFront.value[selectedIndex.value] || null)

// ===== 帕累托明细表排序：单因子(点列头) / 多因子复合(Shift+点叠加) =====
// 仅作用于表格行序；选中/散点/当前方案的 canonical 序号(selectedIndex)保持不变，
// 通过与原始 pfIndex 联动，保证排序切换后选中方案不漂移。
const sortKeys = ref([]) // [{ id, dir:'asc'|'desc' }]，索引越小优先级越高
function sortRank(id) {
  const i = sortKeys.value.findIndex(k => k.id === id)
  return i === -1 ? null : i
}
function sortDirOf(id) {
  const k = sortKeys.value.find(k => k.id === id)
  return k ? k.dir : null
}
function sortDirCls(id) {
  const d = sortDirOf(id)
  return d === null ? 'sa-none' : d === 'asc' ? 'sa-asc' : 'sa-desc'
}
function objName(id) {
  return objectives.value.find(o => o.id === id)?.name || id
}
function onSortClick(objId, e) {
  const has = sortKeys.value.some(k => k.id === objId)
  if (e.shiftKey) {
    // Shift+点：追加为更低优先级复合键；已在复合键中则切换其排序方向
    sortKeys.value = has
      ? sortKeys.value.map(k =>
          k.id === objId ? { id: objId, dir: k.dir === 'asc' ? 'desc' : 'asc' } : k
        )
      : [...sortKeys.value, { id: objId, dir: 'asc' }]
  } else if (has) {
    // 单因子：已在排序中 → 升/降 切换
    sortKeys.value = sortKeys.value.map(k =>
      k.id === objId ? { id: objId, dir: k.dir === 'asc' ? 'desc' : 'asc' } : k
    )
  } else {
    // 单因子：未排序 → 以该因子为唯一主排序（先升后降）
    sortKeys.value = [{ id: objId, dir: 'asc' }]
  }
}
function clearSort() {
  sortKeys.value = []
}
// 排序后的表行（保留原始 pfIndex 供选中联动）
const sortedRows = computed(() => {
  const rows = paretoFront.value.map((ind, pfIndex) => ({ pfIndex, ind }))
  const keys = sortKeys.value
  if (!keys.length) return rows
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const va = a.ind.objectives[k.id]
      const vb = b.ind.objectives[k.id]
      if (va == null && vb == null) continue
      if (va == null) return k.dir === 'asc' ? 1 : -1
      if (vb == null) return k.dir === 'asc' ? -1 : 1
      if (va === vb) continue
      const d = va < vb ? -1 : 1
      return k.dir === 'asc' ? d : -d
    }
    return a.pfIndex - b.pfIndex
  })
})

const nodePositions = computed(() => layout.value?.nodePositions || {})

// 全巷道段定义：顶层真实段(level 0，对接后端实时状态) + 深部分层专属巷道段
// (level 1..4，每条拥有独立编号 SEG-{层}-{序} 与独立安全配置，见 undergroundLayout)。
const segmentLines = computed(() => {
  const L = layout.value
  if (!L) return []
  const pos = L.nodePositions
  const defs = [
    ...L.segmentLinks.map(([id, aId, bId]) => ({ id, level: 0, aId, bId })),
    ...L.deepSegments
  ]
  return defs
    .map(s => {
      const a = pos[s.aId]
      const b = pos[s.bId]
      if (!a || !b) return null
      const label = segLabel(s.id)
      return { ...s, a, b, label, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, label } }
    })
    .filter(Boolean)
})

// 深部分层段的独立元数据（含安全配置），供点击后展示该段独有信息
const deepMetaById = computed(() => {
  const m = {}
  for (const s of layout.value?.deepSegments || []) m[s.id] = s
  return m
})

// 段 ID → {aId, bId, level}，用于数据缺失时按同一份 baseRiskScore 兜底评分
const segCoordById = computed(() => {
  const m = {}
  for (const s of segmentLines.value) m[s.id] = { aId: s.aId, bId: s.bId, level: s.level ?? 0 }
  return m
})

// 三维分层（y 深度 / 平面错位 / 活动度）与节点高程，均由场景配置 layout.* 驱动，
// TunnelMap3D 据此在 X/Y/Z 三个方向铺满真实道路，无需修改组件代码。
const levels = computed(() => layout.value?.levels || [])
const nodeHeights = computed(() => layout.value?.nodeElevation || {})

// 巷道段约束数据：硬约束（物理通过性）+ 动态（炮烟/拥堵/岩爆/封锁）按段 ID 合并
const hardBySeg = computed(() => {
  const map = {}
  for (const s of props.snapshot?.factors?.hardConstraints?.segments || []) map[s.id] = s
  return map
})
const dynBySeg = computed(() => {
  const map = {}
  for (const s of props.snapshot?.factors?.dynamicEnvironment?.segments || []) map[s.id] = s
  return map
})
function segMeta(id) {
  // 竖井/斜井（上下层连接段，VERT-节点-层）：确定性推导完整安全信息，与普通巷道段一致
  const vert = String(id || '').match(/^VERT-(\w+)-(\d+)$/)
  if (vert) return deriveRiserMeta(id) || { id, name: `竖井/斜井 ${vert[1]}`, type: '竖井/斜井' }
  // 深部分层段：直接返回该段专属的独立安全配置（编号/尺寸/炮烟/拥堵/岩爆/封锁等）
  const deep = deepMetaById.value[id]
  if (deep) return { ...deep }
  // 顶层真实段：合并后端硬约束 + 动态环境的实时状态
  const merged = {
    id,
    ...(hardBySeg.value[id] || {}),
    ...(dynBySeg.value[id] || {}),
    name: hardBySeg.value[id]?.name || dynBySeg.value[id]?.name || cnId(id)
  }
  // 数据缺失（无任何安全参数）时注入与 3D 渲染同一份 baseRiskScore 兜底分，
  // 保证详情评分与巷道颜色严格同源
  const hasParams =
    merged.passableLoaded === false ||
    merged.rockburst != null ||
    merged.congestion != null ||
    merged.smoke != null ||
    merged.maxGradePct != null ||
    merged.clearWidthM != null
  if (!hasParams) {
    const sc = segCoordById.value[id]
    if (sc) {
      merged._baseScore = baseRiskScore(sc.aId, sc.bId, sc.level, { nLevels: levels.value.length })
    }
  }
  return merged
}

// 综合约束状态：封锁 > 硬禁行 > 岩爆高发 > 拥堵 > 正常
const STATE_NORMAL = { stroke: '#64748b', label: '通畅' }
const STATE_CONGEST = { stroke: '#F59E0B', label: '拥堵缓行' }
const STATE_RBURST = { stroke: '#E6A23C', label: '岩爆高发' }
const STATE_BAN = { stroke: '#FB923C', label: '重载禁行' }
const STATE_BLOCK = { stroke: '#F56C6C', label: '封锁' }
function segState(m) {
  if (m.blocked) return { ...STATE_BLOCK, clazz: 'st-blocked' }
  if (m.passableLoaded === false) return { ...STATE_BAN, clazz: 'st-ban' }
  if ((m.rockburst || 0) > 0.7) return { ...STATE_RBURST, clazz: 'st-rburst' }
  if ((m.congestion || 0) > 0.6) return { ...STATE_CONGEST, clazz: 'st-congest' }
  return { ...STATE_NORMAL, clazz: 'st-ok' }
}
function fmtM(v) {
  return v == null ? '-' : `${Number(v).toFixed(1)}m`
}
function fmtV(v) {
  return v == null ? '-' : Number(v).toFixed(1)
}
function pct(v) {
  return v == null ? '-' : Math.round(v * 100) + '%'
}
function barColor(v) {
  const x = v || 0
  return x > 0.6 ? 'c-hot' : x > 0.3 ? 'c-mid' : 'c-low'
}

// 选中方案的各设备路径（段→节点→坐标数组），供三维地图绘制路线。
// 后端候选已带多水平路由(nodes + levels，含主井/斜井竖向穿梭)，这里逐点带上
// level，供 3D 图按真实开采水平落位、并绘制竖井升降段——让多目标算法走的新巷道真实可见。
const routePoints = computed(() => {
  if (!selected.value) return []
  const assignment = selected.value.assignment
  return candidates.value.map((cands, i) => {
    const idx = assignment[i]
    if (idx >= cands.length) return []
    const cand = cands[idx]
    // 优先用后端给出的多水平路由（节点序列与水平一一对应）
    if (
      Array.isArray(cand.nodes) &&
      Array.isArray(cand.levels) &&
      cand.nodes.length === cand.levels.length
    ) {
      const pts = []
      for (let k = 0; k < cand.nodes.length; k++) {
        const p = layout.value?.nodePositions[cand.nodes[k]]
        if (!p) continue
        pts.push({ node: cand.nodes[k], level: cand.levels[k] ?? 0, x: p.x, y: p.y })
      }
      return pts
    }
    // 兜底：纯平面候选（老数据）
    const startNode = equipmentItems.value[i]?.node || 'S0'
    return pathToPoints(cand.path, startNode, layout.value).map(p => ({
      node: p.node,
      level: 0,
      x: p.x,
      y: p.y
    }))
  })
})

// 设备显示名（三维设备 tooltip / 图例）
const equipNames = computed(() => equipIds.value.map((id, i) => cnId(id) || `设备${i + 1}`))
// 各巷道段约束元数据（三维地图按段状态着色）
const metaById = computed(() => {
  const out = {}
  for (const seg of segmentLines.value) out[seg.id] = segMeta(seg.id)
  return out
})

// 帕累托前沿（2D 投影）：
// 数据本身是 6 目标（能耗/时间/风险/冲突/负载/品位）联合解，散点图是任意两两组合的
// 二维投影——通过 pairIdx 切换坐标轴对，并为每组坐标补上真实刻度。
const PLOT = { x0: 30, x1: 186, y0: 14, y1: 124 }

// 全部两两目标组合（C(6,2)=15 组），供"其它因素关系坐标轴"选择
const pairOptions = computed(() => {
  const opts = []
  const objs = objectives.value
  for (let i = 0; i < objs.length; i++) {
    for (let j = i + 1; j < objs.length; j++) {
      opts.push({ xId: objs[i].id, yId: objs[j].id, label: `${objs[i].name} × ${objs[j].name}` })
    }
  }
  return opts
})
const pairIdx = ref(0)
const activePair = computed(() => pairOptions.value[pairIdx.value] || pairOptions.value[0] || null)

const paretoScatter = computed(() => {
  const front = paretoFront.value
  const pair = activePair.value
  if (!front.length || !pair) {
    return { points: [], xTicks: [], yTicks: [], xObj: null, yObj: null }
  }
  const X = front.map(ind => ind.objectives[pair.xId])
  const Y = front.map(ind => ind.objectives[pair.yId])
  const loX = Math.min(...X)
  const hiX = Math.max(...X)
  const loY = Math.min(...Y)
  const hiY = Math.max(...Y)
  const padX = (hiX - loX) * 0.05 || 1
  const padY = (hiY - loY) * 0.05 || 1
  const x0 = loX - padX
  const x1 = hiX + padX
  const y0 = loY - padY
  const y1 = hiY + padY
  const X0 = PLOT.x0
  const X1 = PLOT.x1
  const Y0 = PLOT.y0
  const Y1 = PLOT.y1
  const px = v => X0 + ((v - x0) / (x1 - x0)) * (X1 - X0)
  const py = v => Y1 - ((v - y0) / (y1 - y0)) * (Y1 - Y0)
  const xTicks = Array.from({ length: 5 }, (_, k) => x0 + (k * (x1 - x0)) / 4).map(v => ({
    v: Math.round(v * 100) / 100,
    px: px(v)
  }))
  const yTicks = Array.from({ length: 5 }, (_, k) => y0 + (k * (y1 - y0)) / 4).map(v => ({
    v: Math.round(v * 100) / 100,
    py: py(v)
  }))
  const points = front.map((ind, i) => ({
    x: px(ind.objectives[pair.xId]),
    y: py(ind.objectives[pair.yId]),
    valueX: ind.objectives[pair.xId],
    valueY: ind.objectives[pair.yId],
    selected: i === selectedIndex.value,
    pfIndex: i
  }))
  return {
    points,
    xTicks,
    yTicks,
    xObj: objectives.value.find(o => o.id === pair.xId) || null,
    yObj: objectives.value.find(o => o.id === pair.yId) || null
  }
})

function fmtTick(v) {
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
}

// 解点 tooltip：显示该解在“当前坐标轴对”下 x/y 两个目标的实际取值
function fmtTickPoint(pt, sc) {
  const xv = pt?.valueX ?? null
  const yv = pt?.valueY ?? null
  const xn = sc?.xObj?.name || ''
  const yn = sc?.yObj?.name || ''
  const xu = sc?.xObj?.unit || ''
  const yu = sc?.yObj?.unit || ''
  return `${xn}:${xv == null ? '-' : fmtTick(xv)}${xu} · ${yn}:${yv == null ? '-' : fmtTick(yv)}${yu}`
}

function selectByIndex(idx) {
  selectedIndex.value = idx
}

// 当前建议方案中某设备所选候选的"装载点 · 采场"标注（含完整路线）
function routeStep(i) {
  const ind = selected.value
  if (!ind) return ''
  const cands = candidates.value[i]
  const ci = ind.assignment[i]
  if (ci >= cands.length) return '待定'
  const c = cands[ci]
  const zone = c.zone ? ` · ${c.zone}` : ''
  return `${c.target}${zone} · ${c.path.join('→')}`
}

// 英文缩写 → 中文显示：LHD-* → 铲运机*；SEG-01 → 路段01；SEG-2-01 → 路段2-01；VERT-节点-层 → 竖井·节点
function cnId(id) {
  const s = String(id || '')
  if (/^LHD-?/i.test(s)) return s.replace(/^LHD-?/i, '铲运机')
  const vert = s.match(/^VERT-(\w+)-(\d+)$/)
  if (vert) return `竖井·${vert[1]}`
  const m = s.match(/^SEG-(\d{1,2})-(\d{2})$/i)
  if (m) return `路段${m[1]}-${m[2]}`
  return s.replace(/^SEG-?/i, '路段')
}
// 巷道段唯一编号显示：顶层=路段01…，深部分层=路段{层}-{序}
function segLabel(id) {
  const m = String(id || '').match(/^SEG-(\d{1,2})-(\d{2})$/i)
  if (m) return `路段${m[1]}-${m[2]}`
  return cnId(id)
}
// 综合安全评级（统一口径见 services/riskUtils.js）：
// 评分/颜色/标签共享同一阈值（封锁>禁行>岩爆>拥堵>炮烟 + 物理约束），与巷道渲染颜色严格对应
function riskOf(m) {
  const score = riskScore(m)
  const lv = riskLevel(score)
  return { score, label: lv.label, clazz: lv.clazz }
}
function cnPath(txt) {
  return String(txt || '').replace(/SEG-?/gi, '路段')
}

function fmt(v) {
  return v == null ? '-' : Number(v).toFixed(2)
}

// 后端前沿刷新/收缩时兜底修正选中索引，避免越界
watch(
  paretoFront,
  f => {
    if (selectedIndex.value > f.length - 1) selectedIndex.value = 0
  },
  { immediate: true }
)

const canExecute = computed(
  () =>
    !!selected.value && selected.value.assignment.some((ci, i) => ci < candidates.value[i]?.length)
)

async function executeSelected() {
  if (!selected.value) return
  const decoded = decodeAssignment(selected.value.assignment, candidates.value, equipIds.value)
  feedback.value = `已提交 ${decoded.length} 台设备派单…`
  try {
    if (props.applyAssignment) {
      const res = await props.applyAssignment(decoded)
      const data = res?.data || res
      const applied = data?.applied || []
      feedback.value = `派单完成：${applied.length} 台设备采用 NSGA-III 选路`
    } else {
      const res = await fetch('/api/scheduling/apply_assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decoded)
      })
      const json = await res.json()
      feedback.value = `派单完成：${json.data?.applied?.length || 0} 台设备采用 NSGA-III 选路`
    }
  } catch (e) {
    feedback.value = `派单失败：${e.message}`
  }
}
</script>

<style scoped>
/* =========================================================
   视觉系统：分析型 · 克制 · 冷静（决策文档风格）
   统一表面层级 / 细线 / 语义色，标题与证据区留出清晰节奏
   ========================================================= */
.moo-lhd {
  color: #e5e7eb;
}
.moo-expanded {
  background:
    radial-gradient(1200px 400px at 15% -5%, rgba(34, 211, 238, 0.05), transparent 60%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0));
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 14px;
}

/* ---------- 头部 ---------- */
.moo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.moo-kicker {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #64748b;
  margin-bottom: 4px;
}
.moo-title {
  font-size: 16px;
  font-weight: 700;
  color: #f8fafc;
  line-height: 1.2;
  margin: 0;
}
.moo-title-lg {
  font-size: 22px;
}
.moo-tools {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.moo-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
}
.moo-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.moo-status.is-ready {
  color: #6ee7b7;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.moo-status.is-ready .moo-status-dot {
  background: #34d399;
}
.moo-status.is-busy {
  color: #fde047;
  background: rgba(234, 179, 8, 0.12);
  border: 1px solid rgba(234, 179, 8, 0.35);
}
.moo-status.is-busy .moo-status-dot {
  background: #facc15;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.moo-note {
  font-size: 11px;
  color: #94a3b8;
}
.moo-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 4px;
  gap: 10px;
  font-size: 11px;
  color: #94a3b8;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}
.moo-stats .stat b {
  color: #e5e7eb;
  font-weight: 600;
  font-size: 12px;
  margin-right: 2px;
}
.stat-divider {
  width: 1px;
  height: 12px;
  background: rgba(255, 255, 255, 0.12);
}

/* ---------- 按钮 ---------- */
.moo-btn {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: all 0.18s ease;
}
.moo-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.18);
}
.moo-btn-accent {
  color: #67e8f9;
  background: rgba(34, 211, 238, 0.12);
  border-color: rgba(34, 211, 238, 0.3);
}
.moo-btn-accent:hover {
  background: rgba(34, 211, 238, 0.18);
  color: #a5f3fc;
  border-color: rgba(34, 211, 238, 0.5);
}
.moo-btn-execute {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: #fff;
  background: linear-gradient(135deg, #f59e0b, #ea8b0a);
  border: none;
  box-shadow: 0 4px 14px rgba(234, 139, 10, 0.28);
}
.moo-btn-execute:hover {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: #fff;
  border: none;
  box-shadow: 0 6px 18px rgba(234, 139, 10, 0.36);
}
.moo-btn-execute.is-disabled {
  background: rgba(255, 255, 255, 0.06);
  color: #64748b;
  box-shadow: none;
  cursor: not-allowed;
}
.btn-icon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
}

/* ---------- 证据区 / 面板 ---------- */
/* 布局口径：
   缩回态(侧栏/非全屏)=单栏纵向，避免窄窗两栏拥挤失衡；
   全屏态(.moo-expanded)=左侧巷道图 + 右侧帕累托解套件两栏等高(stretch)，
   消除一高一低的“锯齿”；套件将【前沿+当前方案+明细表】纵向整合并紧邻巷道图。 */
.moo-evidence {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 16px;
  align-items: stretch;
}
.map-stage {
  position: relative;
  min-height: 0;
  min-width: 0;
}
.map-stage > .panel + .panel {
  margin-top: 16px;
}
/* 展开态：上行 = 当前建议方案(整行)；下行 = 地图(左,占屏宽 0.75) + 右侧栏(占剩余宽度)。
     右侧栏内：坐标轴在上、方案明细表在下，高度按 1:4 分配，表格底部与地图对齐；
     地图高宽比 = 3:4（宽:高 = 4:3）。 */
@media (min-width: 1024px) {
  .moo-expanded .moo-evidence {
    position: relative;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    grid-template-areas:
      'rec'
      'maprow';
  }
  .moo-expanded .rec-panel {
    grid-area: rec;
  }
  /* 地图行：地图用 aspect-ratio 锚定自身 3:4 高度并决定整行高度（align-items:flex-start 避免
     stretch 覆盖 aspect-ratio，导致高度被右侧栏内容撑走）。右侧栏用绝对定位贴合地图高度，
     不参与决定行高，从而排除"内容把行撑高→地图被拉长"的干扰。 */
  .moo-expanded .map-row {
    grid-area: maprow;
    position: relative; /* 作为右侧栏绝对定位的锚点 */
    display: flex;
    flex-direction: row;
    align-items: flex-start; /* 不强拉伸地图，让 aspect-ratio 生效 */
    gap: 16px;
    min-width: 0;
    min-height: 0;
  }
  /* 地图占 0.74 屏宽；aspect-ratio 4:3（宽:高 = 4:3 ⇒ 高 = 宽的 3/4），
     高度由它自己锁定，地图既不被拉长也不被压扁；右侧栏保留足够宽度 */
  .moo-expanded .map-row .map-stage {
    flex: 0 0 74%;
    width: 74%;
    aspect-ratio: 4 / 3;
    align-self: flex-start;
    min-width: 0;
  }
  /* 右侧栏：绝对定位铺满地图右侧剩余宽度，top:0/bottom:0 与地图行严格等高，
     表格底部天然与地图底部对齐；内容超高时裁切/内部滚动 */
  .moo-expanded .map-row .map-side {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(74% + 16px); /* 地图右侧 + 间距 */
    right: 0;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .moo-expanded .map-stage .map-panel {
    height: 100%;
  }
  /* 右侧栏高度按 1:4 分配：上=坐标轴(1，较小) / 下=方案明细表(4)，底部自然与地图底对齐 */
  .moo-expanded .map-side .pf-panel {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .moo-expanded .map-side .pf-panel .pf-body {
    overflow: auto;
  }
  .moo-expanded .map-side .moo-table-panel {
    flex: 4;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .moo-expanded .map-side .moo-table-panel .table-scroll {
    max-height: none;
  }
  /* 展开态用 flex gap 间距，抵消缩回态的上下层叠 margin，避免双倍间距 */
  .moo-expanded .map-side > .panel + .panel {
    margin-top: 0;
  }
}
.map-panel {
  min-height: 0;
  align-self: stretch;
}
.map-panel .panel-body {
  gap: 10px;
  min-height: 0;
}
/* 巷道 3D 图在面板内弹性铺满：随网格等高对齐，长出的高度由详情/图例吸收 */
.map-panel .panel-body > .tmap3d {
  flex: 1 1 0;
  min-height: 340px;
}
.moo-expanded .map-panel {
  min-height: 0;
}
/* 缩回/窄屏时右侧栏上层叠排布 */
.map-side > .panel + .panel {
  margin-top: 16px;
}
/* 明细表内部：列方向布局，滚动区自适应 */
.moo-table-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.moo-table-panel .table-scroll {
  flex: 1;
  min-height: 120px;
  max-height: min(46vh, 380px);
}
.panel {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.panel-label {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}
.panel-hint {
  font-size: 10px;
  color: #64748b;
}
.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- 当前建议方案 ---------- */
.rec-panel .panel-body {
  gap: 10px;
}
.rec-obj-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
@media (min-width: 1024px) {
  .moo-expanded .rec-obj-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.rec-obj {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.rec-obj-name {
  font-size: 10px;
  color: #94a3b8;
  white-space: nowrap;
}
.rec-obj-val {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.rec-obj-val.dir-min {
  color: #38bdf8;
}
.rec-obj-val.dir-max {
  color: #34d399;
}
.rec-obj-dir {
  font-size: 9px;
  color: #64748b;
}
.rec-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
}
.rec-route-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rec-route-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}
.rec-equip {
  flex: none;
  font-weight: 600;
  color: #67c23a;
  background: rgba(103, 194, 58, 0.12);
  border-radius: 5px;
  padding: 1px 7px;
}
.rec-target {
  color: #cbd5e1;
  line-height: 1.5;
  word-break: break-all;
}

/* ---------- 图例 ---------- */
.legend-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #94a3b8;
}
.lv-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.lv-dump {
  background: #f56c6c;
}
.lv-muck {
  background: #e6a23c;
}
.lv-node {
  background: #409eff;
}
.lv-pareto {
  background: #22a06b;
}
.lv-selected {
  background: #e6a23c;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3);
}
.lv-line {
  width: 16px;
  height: 3px;
  border-radius: 2px;
  flex: none;
}
.lv-dash {
  width: 16px;
  height: 0;
  border-top: 2px dashed #22d3ee;
  opacity: 0.7;
  flex: none;
}

/* 图例：巷道约束状态 */
.legend-state {
  gap: 7px;
}
.legend-state .lv-dot {
  margin-left: 4px;
}
.lv-state-ok {
  background: #64748b;
}
.lv-state-ban {
  background: #fb923c;
}
.lv-state-block {
  background: #f56c6c;
}

/* ---------- 路段约束详情条 ---------- */
.seg {
  cursor: pointer;
}
.seg-line {
  transition: stroke-opacity 0.15s ease;
}
.seg.is-active .seg-line {
  stroke-opacity: 1;
}
.seg-detail {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  animation: segPop 0.16s ease;
}
@keyframes segPop {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.seg-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.seg-detail-id {
  font-size: 12px;
  font-weight: 700;
  color: #f8fafc;
}
.seg-detail-name {
  font-size: 10px;
  color: #64748b;
}
.seg-detail-status {
  flex: 1;
  text-align: right;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.seg-detail-status.st-blocked {
  color: #fed7d7;
  background: rgba(245, 108, 108, 0.18);
}
.seg-detail-status.st-ban {
  color: #fed7aa;
  background: rgba(251, 146, 60, 0.16);
}
.seg-detail-status.st-rburst {
  color: #fde68a;
  background: rgba(230, 162, 60, 0.16);
}
.seg-detail-status.st-congest {
  color: #fde68a;
  background: rgba(245, 158, 11, 0.14);
}
.seg-detail-status.st-ok {
  color: #a7f3d0;
  background: rgba(34, 197, 94, 0.12);
}
.seg-detail-close {
  flex: none;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.seg-detail-close:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.seg-detail-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.sd-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 7px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.sd-item span {
  font-size: 9px;
  color: #64748b;
}
.sd-item b {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #e2e8f0;
}
.sd-item b.c-hot {
  color: #f87171;
}
.sd-item b.c-mid {
  color: #fbbf24;
}
.sd-item b.c-low {
  color: #34d399;
}

/* ---------- Pareto 表格（学术化排版） ---------- */
.table-scroll {
  overflow: auto;
}
.moo-table {
  /* 让明细表按内容自然伸展：窄屏时分栏用横滑看全，宽屏时整行完整可见，
     避免随屏幕宽度不同导致行内容被压缩/截断 */
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.moo-table thead th {
  position: sticky;
  top: 0;
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  color: #a5b3c4;
  background: rgba(15, 18, 24, 0.95);
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  white-space: nowrap;
  z-index: 1;
  backdrop-filter: blur(6px);
}
.th-tip {
  cursor: help;
  border-bottom: 1px dotted currentColor;
}
/* 表头：目标名 + 单位 + 优化方向箭头 */
.th-meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  font-size: 8.5px;
  color: #64748b;
  font-weight: 500;
}
.arr {
  display: inline-block;
  width: 0;
  height: 0;
}
.arr-min {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid #38bdf8;
}
.arr-max {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 5px solid #34d399;
}

/* ---------- 表头排序（单因子 / Shift 复合） ---------- */
.th-sort {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.th-sort-inner {
  display: inline-flex;
  align-items: center;
}
.th-sort-arr {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: #64748b;
  opacity: 0.55;
}
.th-sort:hover .th-sort-arr {
  opacity: 1;
  color: #7dd3fc;
}
.th-sort.is-active .th-sort-arr {
  opacity: 1;
  color: #22d3ee;
}
/* 排序方向指示：升/降三角 */
.sa-icon {
  width: 0;
  height: 0;
}
.sa-none {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid #64748b;
  opacity: 0.35;
}
.sa-asc {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 5px solid #22d3ee;
}
.sa-desc {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid #22d3ee;
}
.th-rank {
  display: inline-grid;
  place-items: center;
  min-width: 13px;
  height: 13px;
  padding: 0 2px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 800;
  color: #0a0f18;
  background: #22d3ee;
  font-variant-numeric: tabular-nums;
}
/* 表头右侧的排序状态摘要（排序面板提示） */
.moo-table-panel .panel-head {
  align-items: center;
}
.panel-hint.has-sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  color: #7dd3fc;
}
.sort-crumb {
  font-size: 9px;
  color: #94a3b8;
  letter-spacing: 0.04em;
}
.sort-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 9.5px;
  font-weight: 600;
  color: #a5f3fc;
  background: rgba(34, 211, 238, 0.14);
  border: 1px solid rgba(34, 211, 238, 0.35);
  white-space: nowrap;
}
.sort-clear {
  border: none;
  background: none;
  padding: 1px 4px;
  font-size: 10px;
  color: #f87171;
  cursor: pointer;
}
.sort-clear:hover {
  color: #fca5a5;
  background: rgba(248, 113, 113, 0.12);
  border-radius: 4px;
}
.moo-table .tc-idx {
  width: 60px;
  color: #64748b;
  padding-left: 10px;
}
.idx-chip {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  color: #b6c2d2;
  font-size: 10px;
  font-weight: 700;
  vertical-align: middle;
  font-variant-numeric: tabular-nums;
}
.rec-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  color: #0a0f18;
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  vertical-align: middle;
}
.tc-obj {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.moo-table th.tc-obj {
  color: #7dd3fc;
}
.obj-val {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #d7e2ee;
}
.moo-table .tc-route {
  text-align: left;
  color: #b6c2d2;
  min-width: 130px;
}
.route-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin: 2px 6px 2px 0;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 10px;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  white-space: nowrap;
}
.route-chip::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--rc, #94a3b8);
  flex: none;
}
.moo-row {
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  transition: background 0.12s ease;
}
.moo-row td {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.moo-row:nth-child(even) {
  background: rgba(255, 255, 255, 0.014);
}
.moo-row.is-clickable:hover {
  background: rgba(255, 255, 255, 0.04);
}
.moo-row.is-selected {
  background: rgba(230, 162, 60, 0.12);
  box-shadow: inset 2px 0 0 #f59e0b;
}
.moo-row.is-selected .idx-chip {
  background: rgba(245, 158, 11, 0.25);
  color: #fbbf24;
}
.moo-row.is-selected .tc-obj {
  color: #fcd9a0;
  font-weight: 600;
}
.moo-row.is-selected .obj-val {
  color: #fcd9a0;
}
.moo-row.is-selected .tc-route {
  color: #f6e0c0;
}
.empty-row {
  text-align: center;
  color: #64748b;
  padding: 18px 0;
}

/* ---------- 紧凑表：非全屏（侧栏）时适配窄窗口 ---------- */
.moo-table.is-compact {
  display: table;
  width: 100%;
  table-layout: fixed;
  font-size: 11px;
}
.moo-table.is-compact th,
.moo-table.is-compact td {
  padding: 5px 8px;
}
.moo-table.is-compact thead th {
  font-size: 10px;
  font-weight: 600;
  padding: 5px 8px;
  white-space: normal;
  line-height: 1.3;
  word-break: keep-all;
}
.moo-table.is-compact .tc-idx {
  width: 56px;
  padding-left: 8px;
}
.moo-table.is-compact .tc-route {
  display: none;
}
.moo-table.is-compact .tc-obj {
  min-width: 0;
}

/* ---------- 当前方案徽标 ---------- */
.rec-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  color: #0a0f18;
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
}

/* ---------- 路段风险评级 + 封锁提示 ---------- */
.seg-detail-risk {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.seg-detail-risk.r-high {
  color: #fed7d7;
  background: rgba(245, 108, 108, 0.18);
  border: 1px solid rgba(245, 108, 108, 0.3);
}
.seg-detail-risk.r-mid {
  color: #fde68a;
  background: rgba(230, 162, 60, 0.16);
  border: 1px solid rgba(230, 162, 60, 0.3);
}
.seg-detail-risk.r-safe {
  color: #bbf7d0;
  background: rgba(74, 222, 128, 0.1);
  border: 1px solid rgba(74, 222, 128, 0.22);
}
.seg-detail-risk.r-low {
  color: #a7f3d0;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.26);
}
.seg-detail-alert {
  margin-bottom: 8px;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 10.5px;
  color: #fed7d7;
  background: rgba(245, 108, 108, 0.1);
  border: 1px dashed rgba(245, 108, 108, 0.35);
}
.seg-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

/* ---------- 行动带 ---------- */
.moo-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 12px 2px 2px;
}
.action-main {
  display: flex;
  align-items: center;
  gap: 12px;
}
.action-feedback {
  font-size: 12px;
  color: #34d399;
}
.action-note {
  font-size: 11px;
  line-height: 1.6;
  color: #64748b;
  max-width: 560px;
  text-align: right;
}
.ref-note {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: #475569;
}

/* ---------- 采场摘要卡片 + 按采场筛选 ---------- */
.zone-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  align-items: stretch;
  gap: 10px;
  margin: 0 0 14px;
}
.zone-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 9px 12px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease;
}
.zone-card:hover {
  border-color: rgba(255, 255, 255, 0.22);
}
.zone-card.is-active {
  background: rgba(255, 255, 255, 0.07);
  border-color: #f59e0b;
  box-shadow:
    0 0 0 1px rgba(245, 158, 11, 0.35),
    0 4px 18px rgba(245, 158, 11, 0.12);
}
.zone-card.is-covered::after {
  content: '';
  position: absolute;
  top: 8px;
  right: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 6px #34d399;
}
.zc-glyph {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
  color: #0a0f18;
  background: #64748b;
}
.zone-all .zc-name {
  color: #e2e8f0;
}
.zc-name {
  font-size: 13px;
  font-weight: 700;
}
.zc-muck {
  font-size: 10px;
  color: #94a3b8;
}
.zc-meta {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.5;
}
.zc-meta b {
  color: #e2e8f0;
}
.zc-cov {
  align-self: flex-start;
  margin-top: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}
.zc-cov.ok {
  color: #34d399;
  background: rgba(52, 211, 153, 0.12);
}
.zc-cov.miss {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
}
.zone-filter-hint {
  grid-column: 1 / -1; /* 横跨整行，避免被等宽网格压缩为单个单元格 */
  align-self: center;
  font-size: 10px;
  color: #475569;
  padding-bottom: 0;
}

/* 帕累托前沿：方案少时的引导提示 */
.pf-note {
  margin: 0 14px 6px;
  padding: 5px 9px;
  border-radius: 6px;
  font-size: 10px;
  line-height: 1.5;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.18);
}

/* 当前建议方案：路线前的采场归属圆点 */
.rec-zone-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}

/* 方案明细：设备选路芯片采场色 + 等待态 + 覆盖摘要行 */
.route-chip.is-wait {
  opacity: 0.55;
}
.route-chip.is-wait::before {
  background: #475569;
}
.rc-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 0;
}
.row-cov {
  display: block;
  width: 100%;
  margin: 2px 0 0;
  font-size: 9.5px;
  line-height: 1.4;
  color: #64748b;
}
.row-cov.is-miss {
  color: #fbbf24;
}
.row-cov.is-ok {
  color: #34d399;
}
.legend-zone {
  font-weight: 600;
}
</style>
