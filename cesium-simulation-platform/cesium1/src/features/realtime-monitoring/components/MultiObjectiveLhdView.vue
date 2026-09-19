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
                  <span class="seg-detail-name">{{ activeSegMeta.name || '—' }}</span>
                  <span class="seg-detail-risk" :class="riskOf(activeSegMeta).clazz">
                    {{ riskOf(activeSegMeta).label }} · 评分{{ riskOf(activeSegMeta).score }}
                  </span>
                  <span class="seg-detail-status" :class="segState(activeSegMeta).clazz">
                    {{ segState(activeSegMeta).label }}
                  </span>
                  <button class="seg-detail-close" title="关闭" @click="activeSegId = ''">×</button>
                </div>
                <div
                  v-if="activeSegMeta.blocked || activeSegMeta.passableLoaded === false"
                  class="seg-detail-alert"
                >
                  <span v-if="activeSegMeta.blocked">⚠ 本路段封锁中，暂不通车</span>
                  <span v-else>⚠ 本路段重载禁行，满载铲运车无法通过</span>
                </div>
                <div class="seg-detail-grid">
                  <div class="sd-item">
                    <span>净宽</span><b>{{ fmtM(activeSegMeta.clearWidthM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>净高</span><b>{{ fmtM(activeSegMeta.clearHeightM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>坡度</span><b>{{ fmtV(activeSegMeta.maxGradePct) }}%</b>
                  </div>
                  <div class="sd-item">
                    <span>转弯半径</span><b>{{ fmtM(activeSegMeta.minTurnRadiusM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>长度</span><b>{{ fmtM(activeSegMeta.lengthM) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>炮烟</span
                    ><b :class="barColor(activeSegMeta.smoke)">{{ pct(activeSegMeta.smoke) }}</b>
                  </div>
                  <div class="sd-item">
                    <span>拥堵</span
                    ><b :class="barColor(activeSegMeta.congestion)">{{
                      pct(activeSegMeta.congestion)
                    }}</b>
                  </div>
                  <div class="sd-item">
                    <span>岩爆</span
                    ><b :class="barColor(activeSegMeta.rockburst)">{{
                      pct(activeSegMeta.rockburst)
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
        硬约束：采区全覆盖（有矿采场至少一车）+ 品位下限 {{ gradeFloorPct }}%。候选路线均为「采矿点
        → 出口」重载 出矿线，按采场着色/标注；跨采场同时运输的共享巷道冲突由「巷道冲突」目标并算。
        <span class="ref-note"
          >口径：王雷等(2025)、贾纯纯等(2025) 多采场调度/品位容量约束；Wang 等(2020)
          采场矿石量输入； Freire 等(2023)LHD {{ FREIRE_2023_LHD_SPEED }}、Hooli 等(2024) 装载{{
            HOOLI_2024_LOAD_TIME
          }}/卸载{{ HOOLI_2024_DUMP_TIME }}/调整{{
            HOOLI_2024_ADJUST_TIME
          }}
          校核时效。设备规模参照大型地下矿（如 Khoemacau 铜矿 {{ KHOEMACAU_LHD_FLEET_SIZE }} 台
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
import { buildLayout } from '../services/undergroundLayout.js'
import { fetchScenarioConfig } from '../services/scenarioConfig.js'
import { applyAssignment as applyAssignmentApi } from '../services/schedulingApi.js'
import { useMultiObjectiveLhdSort } from './useMultiObjectiveLhdSort.js'
import { useMultiObjectiveLhdScatter } from './useMultiObjectiveLhdScatter.js'
import { useMultiObjectiveLhdTunnel } from './useMultiObjectiveLhdTunnel.js'
import TunnelMap3D from './TunnelMap3D.vue'

// ===== 文献口径数值（仅供底部 ref-note 口径文案插值展示，勿改字面口径） =====
/** Freire 等 (2023)：LHD 运行速度参考值 */
const FREIRE_2023_LHD_SPEED = '15km/h'
/** Hooli 等 (2024)：装载 / 卸载 / 调整（换位）时长参考值 */
const HOOLI_2024_LOAD_TIME = '40s'
const HOOLI_2024_DUMP_TIME = '15s'
const HOOLI_2024_ADJUST_TIME = '30s'
/** 设备规模参考：Khoemacau 铜矿 LHD 台数 */
const KHOEMACAU_LHD_FLEET_SIZE = 10

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
const { sortKeys, sortRank, sortDirCls, objName, onSortClick, clearSort, sortedRows } =
  useMultiObjectiveLhdSort({ objectives, paretoFront })

// ===== 巷道网络数据加工：3D 段/节点/分层 + 段安全元数据 + 选中方案路线投影 =====
const {
  nodePositions,
  segmentLines,
  levels,
  nodeHeights,
  metaById,
  routePoints,
  equipNames,
  activeSegMeta,
  segState,
  riskOf,
  fmtM,
  fmtV,
  pct,
  barColor,
  cnId,
  cnPath
} = useMultiObjectiveLhdTunnel({
  layout,
  snapshot: computed(() => props.snapshot),
  activeSegId,
  selected,
  candidates,
  equipIds,
  equipmentItems
})

// ===== 帕累托前沿（2D 投影）：任意两两目标投影，通过 pairIdx 切换坐标轴对 =====
const { PLOT, pairOptions, pairIdx, paretoScatter, fmtTick, fmtTickPoint } =
  useMultiObjectiveLhdScatter({ objectives, paretoFront, selectedIndex })

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
      const json = await applyAssignmentApi(decoded)
      feedback.value = `派单完成：${json.data?.applied?.length || 0} 台设备采用 NSGA-III 选路`
    }
  } catch (e) {
    feedback.value = `派单失败：${e.message}`
  }
}
</script>

<style scoped src="./multiObjectiveLhdView.css"></style>
