<template>
  <div class="audit">
    <div class="audit-shell">
      <!-- ===== 头部 ===== -->
      <header class="audit-head">
        <div class="audit-head-left">
          <div class="audit-emblem">审计</div>
          <div class="audit-head-text">
            <h1 class="audit-title">操作审计中心</h1>
            <p class="audit-sub">关键操作时间线 · 可追溯 · 不可篡改（只追加）</p>
          </div>
        </div>
        <button class="audit-refresh" :disabled="loading" @click="reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spinning: loading }">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </header>

      <!-- ===== 过滤行：域 chips + 动作类型下拉 ===== -->
      <div class="audit-filters">
        <div class="audit-domains">
          <button
            v-for="d in domainChips"
            :key="d.id"
            class="domain-chip"
            :class="[domainFilter === d.id && 'is-active', `chip-${d.id}`]"
            @click="toggleDomain(d.id)"
          >
            {{ d.label }}
          </button>
        </div>
        <select v-model="actionFilter" class="audit-select" @change="reload">
          <option value="">全部动作类型</option>
          <optgroup
            v-for="(items, dom) in actionsByDomain"
            :key="dom"
            :label="domainLabel(dom)"
          >
            <option v-for="a in items" :key="a.id" :value="a.id">{{ a.label }}</option>
          </optgroup>
        </select>
      </div>

      <!-- ===== 时间线 ===== -->
      <div v-if="entries.length" class="audit-body">
        <p class="audit-count">已加载 {{ entries.length }} 条{{ hasMore ? ' · 仍有更早记录' : ' · 已到最早' }}</p>
        <ul class="audit-timeline">
          <li
            v-for="e in entries"
            :key="e.id"
            class="tl-item"
            :class="{ 'is-open': openId === e.id }"
            @click="toggleOpen(e.id)"
          >
            <i class="tl-dot" :class="[`dot-${domainOf(e.action)}`, { 'dot-fail': !e.ok }]"></i>
            <div class="tl-card">
              <div class="tl-row1">
                <span class="tl-time">{{ fmtTime(e.ts) }}</span>
                <span class="tl-badge" :class="`badge-${domainOf(e.action)}`">
                  {{ labelOf(e.action) }}
                </span>
                <span v-if="e.scenario" class="tl-scene">{{ e.scenario }}</span>
                <span v-if="e.actor" class="tl-actor" :class="{ 'is-self': isSelf(e) }">
                  {{ e.actor }}<template v-if="isSelf(e)"> · 本机</template>
                </span>
                <span class="tl-flex"></span>
                <span class="tl-state" :class="e.ok ? 'ok' : 'fail'">
                  {{ e.ok ? '成功' : '部分失败' }}
                </span>
              </div>
              <p class="tl-summary">{{ e.summary }}</p>
              <div v-if="openId === e.id && hasDetail(e.detail)" class="tl-detail">
                <div v-for="(v, k) in e.detail" :key="k" class="detail-row">
                  <span class="detail-key">{{ k }}</span>
                  <span class="detail-val">{{ fmtVal(v) }}</span>
                </div>
              </div>
            </div>
          </li>
        </ul>
        <button v-if="hasMore" class="audit-more" :disabled="loading" @click="loadMore">
          {{ loading ? '加载中…' : '加载更早记录' }}
        </button>
      </div>

      <!-- ===== 空态 / 失败态 ===== -->
      <div v-else-if="!loading" class="audit-empty">
        <div class="audit-empty-pulse"></div>
        <div class="audit-empty-title">{{ error || '暂无审计记录' }}</div>
        <div class="audit-empty-sub">部署调整、派单提交、爆破事件增删改等关键操作将在此留痕</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { fetchAuditLogs, fetchAuditActions } from '../services/auditApi.js'
import { getClientId } from '../../shared/services/collabIdentity.js'

defineOptions({ name: '操作审计中心' })

// 本机终端 id（3.2.1 协作身份）：用于把「本机操作」在时间线上标出来
const myClientId = getClientId()
function isSelf(e) {
  return !!e.clientId && e.clientId === myClientId
}

const entries = ref([])
const hasMore = ref(false)
const actions = ref([])
const loading = ref(false)
const error = ref('')
const openId = ref(null)
const domainFilter = ref('') // ''=全部 / scheduling / blasting
const actionFilter = ref('')

const domainChips = [
  { id: '', label: '全部' },
  { id: 'scheduling', label: '现场调度' },
  { id: 'blasting', label: '爆破模拟' }
]

// 动作 id → 元信息（来自后端枚举，前端不自持映射表）
const actionMeta = computed(() => {
  const m = {}
  for (const a of actions.value) m[a.id] = a
  return m
})

// 动作按域分组（下拉 optgroup）
const actionsByDomain = computed(() => {
  const g = {}
  for (const a of actions.value) (g[a.domain] = g[a.domain] || []).push(a)
  return g
})

function domainOf(actionId) {
  return actionMeta.value[actionId]?.domain || 'scheduling'
}
function labelOf(actionId) {
  return actionMeta.value[actionId]?.label || actionId
}
function domainLabel(dom) {
  return dom === 'blasting' ? '爆破模拟' : '现场调度'
}
function hasDetail(detail) {
  return detail && Object.keys(detail).length > 0
}
function fmtTime(ts) {
  // ISO 秒级 → 「MM-DD HH:mm:ss」
  return String(ts || '').replace('T', ' ').slice(5, 19)
}
function fmtVal(v) {
  if (v == null) return '-'
  if (Array.isArray(v)) return v.length ? v.join('、') : '（空）'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function toggleOpen(id) {
  openId.value = openId.value === id ? null : id
}

function toggleDomain(id) {
  domainFilter.value = domainFilter.value === id ? '' : id
  // 域切换联动动作下拉（选了爆破域时排除调度动作选项）
  if (actionFilter.value && domainOf(actionFilter.value) !== id) actionFilter.value = ''
  reload()
}

async function load(reset) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const params = { limit: 50 }
    if (actionFilter.value) params.action = actionFilter.value
    else if (domainFilter.value) {
      // 后端不支持按域过滤：前端按域内动作集合过滤（逐动作合并查询太重，改为拉全量本地滤）
      // —— 一次拉 200 条本地按域筛选，配合 hasMore 的"加载更多"继续翻页
      params.limit = 200
    }
    if (!reset && entries.value.length) params.beforeId = entries.value[entries.value.length - 1].id
    const res = await fetchAuditLogs(params)
    if (res.code !== 0) throw new Error(res.message || `code ${res.code}`)
    let list = res.data?.entries || []
    if (!actionFilter.value && domainFilter.value) {
      list = list.filter(e => domainOf(e.action) === domainFilter.value)
    }
    if (reset) entries.value = list
    else entries.value.push(...list)
    hasMore.value = !!res.data?.hasMore
  } catch (err) {
    error.value = `审计日志加载失败：${err.message || err}`
  } finally {
    loading.value = false
  }
}

function reload() {
  openId.value = null
  return load(true)
}
function loadMore() {
  return load(false)
}

onMounted(async () => {
  load(true)
  fetchAuditActions()
    .then(res => {
      if (res.code === 0) actions.value = res.data?.actions || []
    })
    .catch(() => {}) // 枚举拉取失败不阻断时间线（标签回退显示动作 id）
})
</script>

<style scoped>
.audit {
  height: 100%;
  overflow-y: auto;
}
.audit-shell {
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

/* ===== 头部 ===== */
.audit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.audit-head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.audit-emblem {
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
.audit-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #f1f5f9;
  letter-spacing: 0.02em;
}
.audit-sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: rgba(148, 163, 184, 0.9);
}
.audit-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 12px;
  color: #67e8f9;
  background: rgba(34, 211, 238, 0.08);
  border: 1px solid rgba(34, 211, 238, 0.25);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.audit-refresh:hover {
  background: rgba(34, 211, 238, 0.16);
}
.audit-refresh svg {
  width: 13px;
  height: 13px;
}
.audit-refresh svg.spinning {
  animation: audit-spin 0.8s linear infinite;
}
@keyframes audit-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== 过滤行 ===== */
.audit-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.audit-domains {
  display: inline-flex;
  gap: 6px;
}
.domain-chip {
  padding: 5px 13px;
  font-size: 12px;
  color: rgba(203, 213, 225, 0.85);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s;
}
.domain-chip.chip-scheduling.is-active {
  color: #67e8f9;
  background: rgba(34, 211, 238, 0.12);
  border-color: rgba(34, 211, 238, 0.45);
}
.domain-chip.chip-blasting.is-active {
  color: #fdba74;
  background: rgba(251, 146, 60, 0.12);
  border-color: rgba(251, 146, 60, 0.45);
}
.audit-select {
  margin-left: auto;
  max-width: 170px;
  padding: 6px 10px;
  font-size: 12px;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  outline: none;
}

/* ===== 时间线 ===== */
.audit-count {
  margin: 0;
  font-size: 11px;
  color: rgba(148, 163, 184, 0.75);
}
.audit-timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
  position: relative;
}
.audit-timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: linear-gradient(rgba(34, 211, 238, 0.35), rgba(148, 163, 184, 0.12));
}
.tl-item {
  position: relative;
  margin-bottom: 10px;
  cursor: pointer;
}
.tl-dot {
  position: absolute;
  left: -14px;
  top: 14px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid #0b1220;
}
.tl-dot.dot-scheduling {
  background: #22d3ee;
  box-shadow: 0 0 8px rgba(34, 211, 238, 0.55);
}
.tl-dot.dot-blasting {
  background: #fb923c;
  box-shadow: 0 0 8px rgba(251, 146, 60, 0.55);
}
.tl-dot.dot-fail {
  background: #f87171;
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.55);
}
.tl-card {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  transition: border-color 0.15s, background 0.15s;
}
.tl-item:hover .tl-card {
  border-color: rgba(34, 211, 238, 0.25);
}
.tl-item.is-open .tl-card {
  background: rgba(34, 211, 238, 0.05);
  border-color: rgba(34, 211, 238, 0.35);
}
.tl-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tl-time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgba(148, 163, 184, 0.9);
}
.tl-badge {
  padding: 2px 9px;
  font-size: 11px;
  border-radius: 999px;
}
.tl-badge.badge-scheduling {
  color: #67e8f9;
  background: rgba(34, 211, 238, 0.1);
  border: 1px solid rgba(34, 211, 238, 0.3);
}
.tl-badge.badge-blasting {
  color: #fdba74;
  background: rgba(251, 146, 60, 0.1);
  border: 1px solid rgba(251, 146, 60, 0.3);
}
.tl-scene {
  padding: 2px 8px;
  font-size: 11px;
  color: rgba(226, 232, 240, 0.8);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 5px;
}
.tl-actor {
  padding: 2px 8px;
  font-size: 11px;
  color: rgba(148, 163, 184, 0.9);
  border: 1px dashed rgba(148, 163, 184, 0.35);
  border-radius: 5px;
}
.tl-actor.is-self {
  color: #67e8f9;
  border-color: rgba(34, 211, 238, 0.45);
  background: rgba(34, 211, 238, 0.06);
}
.tl-flex {
  flex: 1;
}
.tl-state {
  font-size: 11px;
}
.tl-state.ok {
  color: #4ade80;
}
.tl-state.fail {
  color: #f87171;
}
.tl-summary {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: #e2e8f0;
}
.tl-detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(148, 163, 184, 0.2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-row {
  display: flex;
  gap: 10px;
  font-size: 11px;
  line-height: 1.5;
}
.detail-key {
  min-width: 96px;
  color: rgba(103, 232, 249, 0.85);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
}
.detail-val {
  flex: 1;
  color: rgba(203, 213, 225, 0.9);
  word-break: break-all;
  font-family: ui-monospace, 'Cascadia Mono', monospace;
}

/* ===== 加载更多 ===== */
.audit-more {
  margin-top: 4px;
  padding: 8px;
  width: 100%;
  font-size: 12px;
  color: rgba(203, 213, 225, 0.8);
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(148, 163, 184, 0.3);
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.15s;
}
.audit-more:hover {
  border-color: rgba(34, 211, 238, 0.45);
  color: #67e8f9;
}

/* ===== 空态 ===== */
.audit-empty {
  padding: 42px 16px;
  text-align: center;
}
.audit-empty-pulse {
  width: 44px;
  height: 44px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: rgba(34, 211, 238, 0.08);
  border: 1px solid rgba(34, 211, 238, 0.3);
  animation: audit-pulse 2s ease-in-out infinite;
}
@keyframes audit-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.25);
  }
  50% {
    box-shadow: 0 0 0 9px rgba(34, 211, 238, 0);
  }
}
.audit-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #cbd5e1;
}
.audit-empty-sub {
  margin-top: 6px;
  font-size: 12px;
  color: rgba(148, 163, 184, 0.75);
}
</style>
