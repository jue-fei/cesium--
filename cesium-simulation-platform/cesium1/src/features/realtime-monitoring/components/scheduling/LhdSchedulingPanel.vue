<template>
  <div class="sched h-full min-h-0 overflow-x-hidden overflow-y-auto">
    <div class="sched-shell">
      <!-- ===== 板块头部 ===== -->
      <header class="sched-head">
        <div class="sched-head-left">
          <div class="sched-emblem">出矿</div>
          <div class="sched-head-text">
            <h1 class="sched-title">现场调度中心</h1>
            <p class="sched-sub">井下铲运机出矿多目标联合调度 · NSGA-III</p>
          </div>
        </div>
        <div class="sched-head-right">
          <span class="sched-live"><i></i> 实时数据流</span>
          <button class="sched-expand" @click="panelFullscreen = true">
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            全屏查看
          </button>
        </div>
      </header>

      <SchedHeader
        :schema="schema"
        :equipment="equipment"
        :opex-save-pct="opexSavePct"
        :opex-target-pct="opexTargetPct"
        :connection-status="connectionStatus"
        @reset="handleReset"
      />

      <!-- ===== 空态 ===== -->
      <div v-if="!snapshot" class="sched-empty">
        <div class="sched-empty-pulse"></div>
        <div class="sched-empty-title">正在连接地下巷道调度仿真数据流…</div>
        <div class="sched-empty-sub">/ws/scheduling/stream · HTTP 降级 /api/scheduling/state</div>
      </div>

      <!-- ===== Tab 导航 + 分页内容 ===== -->
      <div v-else class="sched-body">
        <nav class="sched-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="sched-tab"
            :class="{ 'is-active': activeTab === tab.key }"
            :title="tab.hint"
            @click="activeTab = tab.key"
          >
            <span class="tab-num">{{ tab.num }}</span>
            {{ tab.label }}
          </button>
        </nav>

        <div class="sched-pane">
          <keep-alive>
            <div v-if="activeTab === 'env'" class="factor-stack">
              <FactorHardConstraints :segments="hardSegments" />
              <FactorDynamic :dynamic="dynamicEnvironment" />
            </div>
            <div v-else-if="activeTab === 'ops'" class="factor-stack">
              <FactorMuck :points="muckPoints" :recognition-req="recognitionReq" />
              <FactorEquipment
                :items="equipment"
                :save-pct="opexSavePct"
                :target-pct="opexTargetPct"
              />
            </div>
            <MultiObjectiveLhdView
              v-else
              :snapshot="snapshot"
              :apply-assignment="applyAssignment"
              :scenario="scenario"
              :expanded="false"
              @toggle-expand="nsgaFullscreen = true"
            />
          </keep-alive>
        </div>
      </div>
    </div>

    <!-- ===== 全屏弹窗（append-to-body：跳出当前布局，遍布整个屏幕） ===== -->
    <el-dialog
      v-model="panelFullscreen"
      fullscreen
      append-to-body
      class="sched-dialog"
      destroy-on-close
    >
      <template #header>
        <span class="dlg-title">现场调度中心</span>
      </template>
      <div class="dlg-body">
        <SchedHeader
          :schema="schema"
          :equipment="equipment"
          :opex-save-pct="opexSavePct"
          :opex-target-pct="opexTargetPct"
          :connection-status="connectionStatus"
          @reset="handleReset"
        />
        <template v-if="snapshot">
          <div class="dlg-tabs">
            <button
              v-for="tab in tabs"
              :key="'d' + tab.key"
              class="sched-tab"
              :class="{ 'is-active': activeTab === tab.key }"
              :title="tab.hint"
              @click="activeTab = tab.key"
            >
              <span class="tab-num">{{ tab.num }}</span>
              {{ tab.label }}
            </button>
          </div>
          <keep-alive>
            <div v-if="activeTab === 'env'" class="factor-stack">
              <FactorHardConstraints :segments="hardSegments" />
              <FactorDynamic :dynamic="dynamicEnvironment" />
            </div>
            <div v-else-if="activeTab === 'ops'" class="factor-stack">
              <FactorMuck :points="muckPoints" :recognition-req="recognitionReq" />
              <FactorEquipment
                :items="equipment"
                :save-pct="opexSavePct"
                :target-pct="opexTargetPct"
              />
            </div>
            <MultiObjectiveLhdView
              v-else
              :snapshot="snapshot"
              :apply-assignment="applyAssignment"
              :scenario="scenario"
              :expanded="false"
              @toggle-expand="nsgaFullscreen = true"
            />
          </keep-alive>
        </template>
      </div>
    </el-dialog>

    <!-- ===== NSGA-III 专窗全屏（跳出当前 div，遍布整个屏幕） ===== -->
    <el-dialog
      v-model="nsgaFullscreen"
      fullscreen
      append-to-body
      class="sched-dialog nsga-dialog"
      destroy-on-close
    >
      <template #header>
        <span class="dlg-title nsga-title">井下铲运机多目标联合调度 · NSGA-III</span>
      </template>
      <div v-if="snapshot" class="dlg-body">
        <MultiObjectiveLhdView
          :snapshot="snapshot"
          :apply-assignment="applyAssignment"
          :scenario="scenario"
          :expanded="true"
          @toggle-expand="nsgaFullscreen = false"
        />
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
defineOptions({ name: '井下LHD出矿调度中心' })
import { ref, computed } from 'vue'
import { useScheduling } from '../../services/useScheduling.js'
import SchedHeader from './SchedHeader.vue'
import FactorHardConstraints from './FactorHardConstraints.vue'
import FactorDynamic from './FactorDynamic.vue'
import FactorMuck from './FactorMuck.vue'
import FactorEquipment from './FactorEquipment.vue'
import MultiObjectiveLhdView from '../MultiObjectiveLhdView.vue'

// 场景名：巷道/装载点/设备等"可替换内容"来自 config/scenario_<名>.json
// 默认大型矿（多中段多采场，10 台铲运机），可切 ashale 小型场景
const scenario = ref('large')

const { snapshot, connectionStatus, reset, applyAssignment } = useScheduling({
  mode: 'websocket',
  autoStart: true,
  scenario: scenario.value
})

const tabs = [
  {
    key: 'env',
    label: '环境约束',
    hint: '巷道物理通过性 + 动态扰动（炮烟/拥堵/岩爆）',
    num: '①'
  },
  {
    key: 'ops',
    label: '作业与装备',
    hint: '矿堆状态 + 装备性能能耗',
    num: '②'
  },
  {
    key: 'nsga',
    label: '多目标优化',
    hint: 'NSGA-III 铲运机联合调度',
    num: '③'
  }
]

// 默认落在最核心的 NSGA-III 优化
const activeTab = ref('nsga')

const panelFullscreen = ref(false)
const nsgaFullscreen = ref(false)

const schema = computed(() => snapshot.value?.schema || null)
const factors = computed(() => snapshot.value?.factors || null)

const hardConstraints = computed(() => factors.value?.hardConstraints || null)
const hardSegments = computed(() => hardConstraints.value?.segments || [])

const dynamicEnvironment = computed(() => factors.value?.dynamicEnvironment || null)

const muckFactor = computed(() => factors.value?.muckPile || null)
const muckPoints = computed(() => muckFactor.value?.points || [])
const recognitionReq = computed(() => 0.9)

const equipFactor = computed(() => factors.value?.equipment || null)
const equipment = computed(() => equipFactor.value?.items || [])
const opexSavePct = computed(() => equipFactor.value?.opexSimulatedSavePct ?? null)
const opexTargetPct = computed(() => equipFactor.value?.opexReductionTargetPct ?? 10)

function handleReset() {
  reset()
}
</script>

<style scoped>
/* ================= 板块外壳 ================= */
.sched-shell {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background:
    radial-gradient(900px 300px at 0% 0%, rgba(34, 211, 238, 0.04), transparent 60%),
    rgba(255, 255, 255, 0.015);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  border-top: 2px solid rgba(34, 211, 238, 0.4);
}

/* ================= 板块头部 ================= */
.sched-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.sched-head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sched-emblem {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #e0faff;
  background: linear-gradient(135deg, #0ea5e9, #22d3ee);
  box-shadow: 0 6px 18px rgba(14, 165, 233, 0.35);
}
.sched-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #f1f5f9;
  line-height: 1.15;
}
.sched-sub {
  margin: 3px 0 0;
  font-size: 11px;
  color: #64748b;
}
.sched-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sched-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #34d399;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
}
.sched-live i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  animation: blink 1.4s infinite;
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.sched-expand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 500;
  color: #e0f2fe;
  background: linear-gradient(135deg, #0ea5e9, #0891b2);
  border: none;
  cursor: pointer;
  box-shadow: 0 5px 16px rgba(14, 165, 233, 0.3);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.sched-expand:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 22px rgba(14, 165, 233, 0.4);
}
.sched-expand .icon {
  width: 14px;
  height: 14px;
}

/* ================= 空态 ================= */
.sched-empty {
  text-align: center;
  padding: 44px 20px;
  border: 1px dashed rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}
.sched-empty-pulse {
  width: 26px;
  height: 26px;
  margin: 0 auto 12px;
  border-radius: 50%;
  border: 3px solid rgba(34, 211, 238, 0.25);
  border-top-color: #22d3ee;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.sched-empty-title {
  font-size: 13px;
  color: #94a3b8;
}
.sched-empty-sub {
  font-size: 11px;
  color: #475569;
  margin-top: 6px;
}

/* ================= Tab 导航 ================= */
.sched-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sched-tabs,
.dlg-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  overflow: hidden;
}
.sched-tabs {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(20, 23, 30, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.dlg-tabs {
  margin: 0 0 16px;
}
.sched-tab {
  flex: 1 1 0;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 9px 6px;
  border-radius: 9px;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
  color: #9aa7b8;
  cursor: pointer;
  white-space: normal;
  word-break: keep-all;
  transition: all 0.18s ease;
}
.sched-tab:hover {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.06);
}
.sched-tab.is-active {
  color: #fff;
  background: linear-gradient(135deg, #165dff, #1b6aff);
  box-shadow: 0 4px 14px rgba(22, 93, 255, 0.35);
}
.tab-num {
  flex: none;
  font-size: 10px;
  opacity: 0.7;
}
.sched-tab.is-active .tab-num {
  opacity: 0.9;
}
.sched-pane {
  animation: fadeUp 0.22s ease;
}
.factor-stack {
  /* 双栏并排：充分利用宽屏横向空间；窄屏(对话框/手机)回退单栏 */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: 14px;
  align-items: stretch;
}
@media (max-width: 760px) {
  .factor-stack {
    grid-template-columns: 1fr;
  }
}
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ================= 全屏弹窗：遍布整个屏幕 ================= */
.dlg-title {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
}
.nsga-title {
  color: #fbbf77;
}

.sched-dialog :deep(.el-overlay) {
  position: fixed;
  inset: 0;
  padding: 0;
  background-color: #14171e;
}
.sched-dialog :deep(.el-overlay-dialog) {
  position: static;
  height: 100%;
  overflow-y: auto;
  padding: 0;
}
.sched-dialog :deep(.el-dialog) {
  width: 100vw !important;
  height: 100vh !important;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.sched-dialog :deep(.el-dialog__header) {
  position: sticky;
  top: 0;
  z-index: 4;
  padding: 14px 24px;
  margin: 0;
  background: rgba(18, 21, 27, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.sched-dialog :deep(.el-dialog__body) {
  padding: 20px 24px 40px;
  overflow: visible;
}
</style>
