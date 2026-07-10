<template>
  <div class="blast-effect-panel">
    <!-- 损伤区参数 -->
    <div class="panel-section">
      <div class="panel-section-title">爆破损伤区参数</div>
      <div class="hint-text">基于 Holmberg-Persson 模型 · 点击参数项在 3D 场景中高亮对应区域</div>
      <div class="mt-2">
        <div class="clickable-stat" :class="{ active: highlight === 'crushed' }" @click.stop="onDamageClick('crushed')">
          <span class="stat-label"><span class="color-dot" style="background:#ff3030"></span>粉碎区半径 R1</span>
          <span class="stat-value">{{ damageZones ? damageZones.crushedZoneRadius.toFixed(2) : '--' }} m</span>
        </div>
        <div class="clickable-stat" :class="{ active: highlight === 'fractured' }"
          @click.stop="onDamageClick('fractured')">
          <span class="stat-label"><span class="color-dot" style="background:#ff8c00"></span>裂隙区半径 R2</span>
          <span class="stat-value">{{ damageZones ? damageZones.fracturedZoneRadius.toFixed(2) : '--' }} m</span>
        </div>
        <div class="clickable-stat" :class="{ active: highlight === 'elastic' }" @click.stop="onDamageClick('elastic')">
          <span class="stat-label"><span class="color-dot" style="background:#30ff30"></span>弹性区起始</span>
          <span class="stat-value">{{ damageZones ? damageZones.elasticZoneStart.toFixed(2) : '--' }} m</span>
        </div>
      </div>
    </div>

    <!-- 碎石块度参数 -->
    <div class="panel-section">
      <div class="panel-section-title">碎石块度分布参数</div>
      <div class="hint-text">KCO-Swebrec 模型 · 勾选粒径档位在 3D 场景中高亮对应碎片（可多选）</div>
      <div class="mt-2">
        <div class="stat-item">
          <span>中位块度 X50</span><span class="stat-value">{{ fmt(kcoOut.x50) }} m</span>
        </div>
        <div class="stat-item">
          <span>特征块度 X80</span><span class="stat-value">{{ fmt(kcoOut.x80) }} m</span>
        </div>
        <div class="stat-item">
          <span>最大块度 Xmax</span><span class="stat-value">{{ fmt(kcoOut.xmax) }} m</span>
        </div>
        <div class="stat-item">
          <span>均匀性指数 n</span><span class="stat-value">{{ fmt(kcoOut.n, 3) }}</span>
        </div>
        <div class="stat-item">
          <span>分布参数 b</span><span class="stat-value">{{ fmt(kcoOut.b, 3) }}</span>
        </div>
      </div>
      <!-- 三档分布柱状图 -->
      <div class="block-dist-chart mt-2">
        <div class="block-dist-title">块度分区比例（理论 Swebrec 分布）</div>
        <div class="block-bar-row" :class="{ active: selectedBlocks.includes('large') }" @click.stop="onBlockToggle('large')">
          <span class="block-bar-label">
            <input type="checkbox" class="block-checkbox" :checked="selectedBlocks.includes('large')" @click.stop="onBlockToggle('large')" />
            <span class="color-dot" style="background:#e63329"></span>大块 (≥X80)
          </span>
          <div class="block-bar-track">
            <div class="block-bar-fill large" :style="{ width: blockPercents.large + '%' }"></div>
          </div>
          <span class="block-bar-value">{{ blockPercents.large.toFixed(1) }}%</span>
        </div>
        <div class="block-bar-row" :class="{ active: selectedBlocks.includes('medium') }" @click.stop="onBlockToggle('medium')">
          <span class="block-bar-label">
            <input type="checkbox" class="block-checkbox" :checked="selectedBlocks.includes('medium')" @click.stop="onBlockToggle('medium')" />
            <span class="color-dot" style="background:#f2bf0f"></span>中块 (X50~X80)
          </span>
          <div class="block-bar-track">
            <div class="block-bar-fill medium" :style="{ width: blockPercents.medium + '%' }"></div>
          </div>
          <span class="block-bar-value">{{ blockPercents.medium.toFixed(1) }}%</span>
        </div>
        <div class="block-bar-row" :class="{ active: selectedBlocks.includes('small') }" @click.stop="onBlockToggle('small')">
          <span class="block-bar-label">
            <input type="checkbox" class="block-checkbox" :checked="selectedBlocks.includes('small')" @click.stop="onBlockToggle('small')" />
            <span class="color-dot" style="background:#33cc40"></span>小块 (&lt;X50)
          </span>
          <div class="block-bar-track">
            <div class="block-bar-fill small" :style="{ width: blockPercents.small + '%' }"></div>
          </div>
          <span class="block-bar-value">{{ blockPercents.small.toFixed(1) }}%</span>
        </div>
      </div>
    </div>

    <!-- PPV 振动参数 -->
    <div class="panel-section">
      <div class="panel-section-title">PPV 振动速度评价</div>
      <div class="hint-text">萨道夫斯基公式 · 点击加载并显示振动场（GB6722-2014 色标）</div>
      <div class="mt-2">
        <div class="clickable-stat" :class="{ active: ppvVisible }" @click="onPpvClick">
          <span class="stat-label">峰值振动速度 PPV</span>
          <span class="stat-value">{{ ppvStats ? ppvStats.maxPpv.toFixed(2) : '--' }} cm/s</span>
        </div>
        <div class="stat-item">
          <span>平均振动速度</span>
          <span class="stat-value">{{ ppvStats ? ppvStats.meanPpv.toFixed(2) : '--' }} cm/s</span>
        </div>
        <div class="stat-item">
          <span>安全标准</span>
          <select class="safety-select" :value="safetyStandard" @change="onSafetyChange">
            <option value="general_building">一般建筑 (2-3 cm/s)</option>
            <option value="new_concrete">新浇混凝土 (1-2 cm/s)</option>
            <option value="earth_cave">土窑洞/土房 (0.5-1 cm/s)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 抛掷参数 -->
    <div class="panel-section">
      <div class="panel-section-title">抛掷效果统计</div>
      <div class="hint-text">实时物理引擎数据 · 点击最远抛掷距离飞行至对应碎片</div>
      <div class="mt-2">
        <div class="clickable-stat" @click="onThrowClick">
          <span class="stat-label">最大抛掷距离</span>
          <span class="stat-value">{{ throwStats ? throwStats.throwDistanceMax.toFixed(2) : '--' }} m</span>
        </div>
        <div class="stat-item">
          <span>平均抛掷距离</span>
          <span class="stat-value">{{ throwStats ? throwStats.throwDistanceAvg.toFixed(2) : '--' }} m</span>
        </div>
        <div class="stat-item">
          <span>飞行中碎片数</span>
          <span class="stat-value">{{ throwStats ? throwStats.fragmentCount : '--' }}</span>
        </div>
        <div class="stat-item">
          <span>已落地碎片数</span>
          <span class="stat-value">{{ throwStats ? throwStats.landedCount : '--' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  dataset: { type: Object, default: () => null },
  getDamageZones: { type: Function, default: () => null },
  highlightDamageZone: { type: Function, default: () => { } },
  highlightBlockClass: { type: Function, default: () => { } },
  getBlastEffectStats: { type: Function, default: () => null },
  getPPVFieldStats: { type: Function, default: () => null },
  setSafetyStandard: { type: Function, default: () => { } },
  loadPPVField: { type: Function, default: () => Promise.resolve(false) },
  flyToFarthestFragment: { type: Function, default: () => false },
  setLayerVisible: { type: Function, default: () => { } }
})

// 损伤区数据
const damageZones = ref(null)
// 高亮状态
const highlight = ref(null)
const selectedBlocks = ref([])  // 块度多选高亮：['large','medium','small'] 的子集
// PPV
const ppvStats = ref(null)
const ppvLoaded = ref(false)   // 数据是否已加载（避免重复请求后端）
const ppvVisible = ref(false)  // 图层是否可见（toggle 显示/隐藏）
const safetyStandard = ref('general_building')
// 抛掷统计
const throwStats = ref(null)
// 定时刷新句柄
let refreshTimer = null

// KCO 输出参数（从 dataset.result 读取）
const kcoOut = computed(() => {
  const r = props.dataset?.result || {}
  const x50 = Number(r.fragmentX50) || 0
  const xmax = Number(r.fragmentXmax) || 0
  const b = Number(r.fragmentB) || 1.0
  const n = Number(r.fragmentN) || 1.0
  // x80 估算：Swebrec 分布中 x80 ≈ x50 × (1 + b^0.3)
  const x80 = x50 * (1 + Math.pow(Math.max(0.01, b), 0.3))
  return { x50, x80, xmax, n, b }
})

// Swebrec CDF: P(x) = 1 / (1 + (ln(xmax/x) / ln(xmax/x50))^b)
function swebrecCDF(x, x50, xmax, b) {
  if (xmax <= 0 || x50 <= 0) return 0
  if (x >= xmax) return 1
  if (x <= 0) return 0
  const ratio = Math.log(xmax / x) / Math.log(xmax / x50)
  return 1 / (1 + Math.pow(Math.max(1e-6, ratio), b))
}

// 三档块度比例（理论分布）
const blockPercents = computed(() => {
  const { x50, x80, xmax, b } = kcoOut.value
  if (x50 <= 0 || xmax <= 0) return { large: 0, medium: 0, small: 0 }
  const cdfX50 = swebrecCDF(x50, x50, xmax, b)  // 应为 0.5
  const cdfX80 = swebrecCDF(x80, x50, xmax, b)
  return {
    small: cdfX50 * 100,          // < x50
    medium: (cdfX80 - cdfX50) * 100,  // x50 ~ x80
    large: (1 - cdfX80) * 100     // >= x80
  }
})

function fmt(v, d = 3) {
  if (v == null || isNaN(v)) return '--'
  return Number(v).toFixed(d)
}

// ─── 点击联动 ─────────────────────────────────
// 统一清除所有高亮，恢复原状
function clearAllHighlights() {
  if (highlight.value !== null) {
    highlight.value = null
    props.highlightDamageZone(null)
    // 取消高亮时隐藏损伤区图层（恢复原状）
    props.setLayerVisible('damageZone', false)
  }
  if (selectedBlocks.value.length > 0) {
    selectedBlocks.value = []
    props.highlightBlockClass(null)
  }
}

function onDamageClick(zone) {
  if (highlight.value === zone) {
    // 再次点击取消高亮
    clearAllHighlights()
  } else {
    // 切换到新区域：先清除所有高亮
    clearAllHighlights()
    highlight.value = zone
    // 开启损伤区图层并高亮
    props.setLayerVisible('damageZone', true)
    props.highlightDamageZone(zone)
  }
}

// 块度多选切换：勾选/取消勾选某一档（可同时选中多档）
function onBlockToggle(cls) {
  const idx = selectedBlocks.value.indexOf(cls)
  if (idx >= 0) {
    // 已选中 → 取消
    selectedBlocks.value = selectedBlocks.value.filter(c => c !== cls)
  } else {
    // 未选中 → 添加
    selectedBlocks.value = [...selectedBlocks.value, cls]
  }
  // 选中为空时取消高亮，否则高亮选中档位
  if (selectedBlocks.value.length > 0) {
    props.highlightBlockClass([...selectedBlocks.value])
  } else {
    props.highlightBlockClass(null)
  }
}

async function onPpvClick() {
  // 已加载：toggle 显示/隐藏（不重复请求后端）
  // 通过 getPPVFieldStats() 判断数据是否已加载（可能已由图层开关触发加载）
  if (ppvLoaded.value || props.getPPVFieldStats()) {
    ppvLoaded.value = true
    ppvVisible.value = !ppvVisible.value
    props.setLayerVisible('ppvField', ppvVisible.value)
    return
  }
  // 首次加载 PPV 场数据
  const ok = await props.loadPPVField({ safetyStandard: safetyStandard.value })
  if (ok) {
    ppvStats.value = props.getPPVFieldStats()
    ppvLoaded.value = true
    ppvVisible.value = true
    props.setLayerVisible('ppvField', true)
  }
}

function onSafetyChange(e) {
  safetyStandard.value = e?.target?.value
  props.setSafetyStandard(safetyStandard.value)
}

function onThrowClick() {
  props.flyToFarthestFragment()
}

// ─── 定时刷新实时数据 ───────────────────────
function refresh() {
  damageZones.value = props.getDamageZones()
  throwStats.value = props.getBlastEffectStats()
  if (ppvLoaded.value && ppvVisible.value) {
    ppvStats.value = props.getPPVFieldStats()
  }
}

// ─── 点击其他地方取消高亮 ───────────────────────
// 高亮触发按钮使用 @click.stop 阻止冒泡，因此 document click 只在点击其他地方时触发
function onDocumentClick() {
  clearAllHighlights()
}

onMounted(() => {
  refresh()
  refreshTimer = setInterval(refresh, 500)  // 500ms 刷新一次
  document.addEventListener('click', onDocumentClick)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  document.removeEventListener('click', onDocumentClick)
  // 退出时取消所有高亮
  clearAllHighlights()
  // 退出时关闭 PPV 图层，避免残留
  if (ppvVisible.value) {
    props.setLayerVisible('ppvField', false)
    ppvVisible.value = false
  }
})
</script>

<style scoped>
.blast-effect-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md, 12px);
}

/* 区块标题美化：底部增加分隔线 */
.blast-effect-panel :deep(.panel-section-title) {
  padding-bottom: 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

/* 提示文字调淡 */
.blast-effect-panel :deep(.hint-text) {
  font-size: 11px;
  opacity: 0.65;
  line-height: 1.5;
}

.clickable-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
  padding: 8px 10px;
  font-size: var(--font-xs, 12px);
  cursor: pointer;
  border-radius: var(--radius-sm, 4px);
  transition: all 0.15s ease;
  border-left: 3px solid transparent;
}

.clickable-stat:hover {
  background: rgba(64, 158, 255, 0.08);
  border-left-color: rgba(64, 158, 255, 0.4);
}

.clickable-stat.active {
  background: rgba(64, 158, 255, 0.15);
  border-left-color: var(--primary-color, #409eff);
  box-shadow: 0 0 6px rgba(64, 158, 255, 0.2);
}

.stat-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary, #a0aec0);
}

.color-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 块度分布柱状图 */
.block-dist-chart {
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: var(--radius-md, 6px);
  border: 1px solid var(--border-primary, #2d3748);
}

.block-dist-title {
  font-size: 11px;
  color: var(--text-muted, #718096);
  margin-bottom: 10px;
}

.block-bar-row {
  display: grid;
  grid-template-columns: 150px 1fr 55px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  padding: 5px 6px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: background 0.15s ease;
  margin-bottom: 3px;
}

.block-bar-row:hover {
  background: rgba(64, 158, 255, 0.06);
}

.block-bar-row.active {
  background: rgba(64, 158, 255, 0.12);
  box-shadow: inset 0 0 0 1px rgba(64, 158, 255, 0.3);
}

.block-bar-label {
  color: var(--text-muted, #718096);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 块度多选复选框 */
.block-checkbox {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: #409eff;
  flex-shrink: 0;
}

.block-bar-track {
  position: relative;
  height: 16px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: var(--radius-sm, 4px);
  overflow: hidden;
}

.block-bar-fill {
  height: 100%;
  border-radius: var(--radius-sm, 4px);
  transition: width 0.4s ease;
}

.block-bar-fill.large {
  background: linear-gradient(90deg, #e63329, #ff6b5b);
}

.block-bar-fill.medium {
  background: linear-gradient(90deg, #f2bf0f, #ffd966);
}

.block-bar-fill.small {
  background: linear-gradient(90deg, #33cc40, #6ee07a);
}

.block-bar-value {
  text-align: right;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-light, #79bbff);
}

/* 安全标准下拉 */
.safety-select {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary, #e5eaf3);
  border: 1px solid var(--border-primary, #2d3748);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}

.safety-select option {
  background: #1a1d24;
  color: #e5eaf3;
}
</style>
