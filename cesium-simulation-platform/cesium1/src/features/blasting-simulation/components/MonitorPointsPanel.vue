<template>
  <div class="mp-wrap">
    <!-- 控制行：添加测点 / 雷管延期误差 -->
    <div class="mp-controls">
      <button class="mp-btn" :class="{ active: monitorPickActive }" @click="$emit('toggle-pick')">
        {{ monitorPickActive ? '点 3D 岩体连续布点…(再点停止)' : '＋ 添加测点' }}
      </button>
      <div class="mp-jitter">
        <span class="mp-jitter-label" title="真实雷管各段存在 ±σ ms 起爆误差，打破完美对称干涉"
          >雷管误差 σ</span
        >
        <input
          class="mp-range"
          type="range"
          min="0"
          max="20"
          step="1"
          :value="delayJitter"
          @input="$emit('set-delay-jitter', Number($event.target.value))"
        />
        <span class="mp-jitter-val">{{ delayJitter > 0 ? '±' + delayJitter + 'ms' : '关' }}</span>
      </div>
    </div>

    <!-- 测点列表 -->
    <div v-if="monitorPoints.length" class="mp-list">
      <div
        v-for="m in monitorPoints"
        :key="m.id"
        class="mp-item"
        :class="{ sel: m.id === selectedId }"
        @click="selectedId = m.id"
      >
        <span class="mp-item-name">{{ m.label }}</span>
        <span class="mp-item-crd"
          >({{ m.x.toFixed(2) }},{{ m.y.toFixed(2) }},{{ m.z.toFixed(2) }})</span
        >
        <span class="mp-item-ppv">PPV {{ (m.ppv * 100).toFixed(2) }} cm/s</span>
        <button class="mp-item-del" @click.stop="$emit('remove', m.id)">✕</button>
      </div>
    </div>
    <div v-else class="mp-empty">无监测点。点击"＋ 添加测点"后用鼠标在 3D 岩体表面点选。</div>

    <!-- 选中测点：三分量时程 + 合成模曲线 -->
    <div v-if="selected" class="mp-chart-card">
      <div class="mp-chart-head">
        <span class="mp-chart-title">{{ selected.label }} 时程曲线</span>
        <span class="mp-chart-ppv">PPV={{ (selected.ppv * 100).toFixed(2) }} cm/s</span>
      </div>
      <canvas ref="canvasRef" class="mp-canvas"></canvas>
      <div class="mp-legend">
        <span class="lg"><i class="c1"></i>Vx</span>
        <span class="lg"><i class="c2"></i>Vy</span>
        <span class="lg"><i class="c3"></i>Vz</span>
        <span class="lg"><i class="c4"></i>|V|</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

defineOptions({ name: 'MonitorPointsPanel' })

const props = defineProps({
  monitorPoints: { type: Array, default: () => [] },
  monitorPickActive: Boolean,
  delayJitter: { type: Number, default: 5 }
})
defineEmits(['remove', 'toggle-pick', 'set-delay-jitter'])

const selectedId = ref(null)
const canvasRef = ref(null)
let dpr = 1
let ro = null
let raf = 0

const selected = computed(() => props.monitorPoints.find(m => m.id === selectedId.value) || null)

function draw() {
  raf = 0
  const sel = selected.value
  const canvas = canvasRef.value
  if (!sel || !sel.history || !canvas) return
  const { vx, vy, vz, vmag, t } = sel.history
  const n = t.length
  if (n < 2) return
  const parent = canvas.parentElement
  const w = parent.clientWidth || 320
  const h = 180
  dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const padL = 10
  const padR = 8
  const padT = 8
  const padB = 18
  const plotW = w - padL - padR
  const plotH = h - padT - padB

  // 值轴量程：以合成模 |V| 峰值为主，其余分量对称缩放（保证不被极值压垮且可看负向）
  let pmax = 1e-6
  for (let i = 0; i < n; i++) pmax = Math.max(pmax, Math.abs(vmag[i]))
  const ys = [vx, vy, vz, vmag]
  for (const arr of ys) for (let i = 0; i < n; i++) pmax = Math.max(pmax, Math.abs(arr[i]))
  // 轴上限：取 1.1×pmax，向 1/2/5×10^k 靠拢取整刻度
  const niceMax = _nice(pmax * 1.15)
  const tmax = Math.max(1e-6, t[n - 1])

  // 网格 + 刻度
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '10px Consolas, monospace'
  ctx.lineWidth = 1
  const gx = 4
  const gy = 4
  for (let i = 0; i <= gx; i++) {
    const x = padL + (i / gx) * plotW
    ctx.beginPath()
    ctx.moveTo(x, padT)
    ctx.lineTo(x, padT + plotH)
    ctx.stroke()
  }
  for (let i = 0; i <= gy; i++) {
    const y = padT + (i / gy) * plotH
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + plotW, y)
    ctx.stroke()
    if (i === gy) continue
    const val = niceMax * (1 - i / gy)
    ctx.fillText(val > 10 ? val.toFixed(0) : val.toFixed(2), padL, y - 2)
  }
  ctx.fillText('0', padL, padT + plotH + 12)
  ctx.fillText(tmax.toFixed(2) + 's', padL + plotW - 26, padT + plotH + 12)

  // 曲线
  const series = [
    { arr: vx, color: '#7aa2f7', lw: 1.4 },
    { arr: vy, color: '#e0af68', lw: 1.4 },
    { arr: vz, color: '#73daca', lw: 1.4 },
    { arr: vmag, color: '#f7768e', lw: 2 }
  ]
  for (const s of series) {
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.lw
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const px = padL + (t[i] / tmax) * plotW
      const py = padT + plotH * (1 - Math.abs(s.arr[i]) / niceMax) * (s.arr[i] >= 0 ? 1 : 0) // 占位
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }

  // 上方 1/2 高度绘制正负向对称轴（|V| 恒正显示在上半区，Vx/Vy/Vz 可在 0 轴上下）
  const zeroY = padT + plotH / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.beginPath()
  ctx.moveTo(padL, zeroY)
  ctx.lineTo(padL + plotW, zeroY)
  ctx.stroke()
}

function _nice(v) {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const m = v / base
  const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return niceM * base
}

watch(
  selected,
  () => {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(draw)
  },
  { deep: true }
)

onMounted(() => {
  ro = new ResizeObserver(() => {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(draw)
  })
  if (canvasRef.value?.parentElement) ro.observe(canvasRef.value.parentElement)
  if (selected.value) {
    raf = requestAnimationFrame(draw)
  }
})
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  ro?.disconnect()
})
</script>

<style scoped>
.mp-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mp-btn {
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.mp-btn:hover {
  border-color: rgba(64, 158, 255, 0.4);
  color: var(--text-primary);
}
.mp-btn.active {
  color: var(--primary-light);
  background: rgba(64, 158, 255, 0.18);
  border-color: rgba(64, 158, 255, 0.45);
}
.mp-jitter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.mp-jitter-label {
  font-size: 11px;
  color: var(--text-muted);
}
.mp-range {
  width: 90px;
}
.mp-jitter-val {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 48px;
  font-family: 'Consolas', monospace;
  text-align: right;
}
.mp-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 150px;
  overflow: auto;
}
.mp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
}
.mp-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.mp-item.sel {
  border-color: rgba(64, 158, 255, 0.4);
  background: rgba(64, 158, 255, 0.1);
}
.mp-item-name {
  font-weight: 600;
  color: var(--text-primary);
}
.mp-item-crd {
  color: var(--text-muted);
  font-family: 'Consolas', monospace;
}
.mp-item-ppv {
  margin-left: auto;
  color: var(--primary-light);
  font-family: 'Consolas', monospace;
}
.mp-item-del {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
}
.mp-item-del:hover {
  color: #f56c6c;
}
.mp-empty {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 6px;
}
.mp-chart-card {
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: 8px;
  background: rgba(0, 0, 0, 0.22);
}
.mp-chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.mp-chart-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.mp-chart-ppv {
  font-size: 11px;
  color: #f7768e;
  font-family: 'Consolas', monospace;
}
.mp-canvas {
  display: block;
  width: 100%;
}
.mp-legend {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}
.lg {
  font-size: 11px;
  color: var(--text-muted);
}
.lg i {
  display: inline-block;
  width: 10px;
  height: 3px;
  border-radius: 2px;
  vertical-align: middle;
  margin-right: 4px;
}
.c1 {
  background: #7aa2f7;
}
.c2 {
  background: #e0af68;
}
.c3 {
  background: #73daca;
}
.c4 {
  background: #f7768e;
}
</style>
