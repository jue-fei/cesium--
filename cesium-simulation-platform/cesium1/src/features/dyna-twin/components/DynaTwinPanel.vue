<template>
  <div class="p-4 space-y-4 text-text-primary">
    <div class="text-sm text-text-muted leading-6">
      LS-DYNA
      <code class="px-1 bg-white/10 rounded">d3plot</code>
      容器可视化（平台内置模块，随平台一起部署）。 服务地址默认
      <code class="px-1 bg-white/10 rounded">/dyna/</code>，由平台后端提供。
    </div>

    <div>
      <label class="block text-xs text-text-muted mb-1">服务地址</label>
      <el-input v-model="url" placeholder="/dyna/" clearable />
    </div>

    <div class="flex flex-wrap gap-2">
      <el-button type="primary" @click="openFull">平台内全屏打开</el-button>
      <el-button @click="openNewTab">新标签打开</el-button>
    </div>

    <el-alert v-if="loadError" :title="loadError" type="warning" :closable="false" show-icon />

    <div class="text-xs text-text-muted leading-5 space-y-1">
      <div>
        · 算例元信息：<code class="px-1 bg-white/10 rounded">MySQL / dyna_cases</code> + 容器目录
        <code class="px-1 bg-white/10 rounded">&lt;platform&gt;/dyna/webapp/data_v3/</code>
      </div>
      <div>· 支持：云图/剖切/粒子/部件显隐/多点取点/图表/URL 状态</div>
      <div>· 若空白：确认平台后端（3003）已启动，且 <code>/dyna/</code> 可访问</div>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="full" class="dyna-overlay">
      <div class="dyna-bar">
        <span class="dyna-title">LS-DYNA 数字孪生</span>
        <span class="dyna-url" :title="url">{{ url }}</span>
        <div class="dyna-actions">
          <el-button size="small" @click="reload">重载</el-button>
          <el-button size="small" @click="openNewTab">新标签</el-button>
          <el-button size="small" type="primary" @click="closeFull">关闭</el-button>
        </div>
      </div>
      <iframe ref="frameRef" :src="url" class="dyna-frame" allow="fullscreen" @load="onFrameLoad" />
    </div>
  </Teleport>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'

const STORAGE_KEY = 'dynaTwinUrl'
const DEFAULT_URL = '/dyna/'

const url = ref(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL)
const full = ref(false)
const frameRef = ref(null)
const loadError = ref('')
let loadTimer = null

watch(url, value => {
  const v = (value || '').trim()
  if (v) localStorage.setItem(STORAGE_KEY, v)
})

function openFull() {
  const v = (url.value || '').trim()
  if (!v) {
    loadError.value = '请先填写服务地址'
    return
  }
  url.value = v
  loadError.value = ''
  full.value = true
  startLoadTimer()
}

function closeFull() {
  full.value = false
  loadError.value = ''
  clearTimeout(loadTimer)
}

function startLoadTimer() {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(() => {
    loadError.value = '画面仍未加载：请确认平台后端（3003）已启动，且 /dyna/ 可访问'
  }, 8000)
}

function onFrameLoad() {
  clearTimeout(loadTimer)
  loadError.value = ''
}

function reload() {
  const base = (url.value || '').trim() || DEFAULT_URL
  const sep = base.includes('?') ? '&' : '?'
  if (frameRef.value) frameRef.value.src = `${base}${sep}t=${Date.now()}`
  startLoadTimer()
}

function openNewTab() {
  const v = (url.value || '').trim() || DEFAULT_URL
  window.open(v, '_blank', 'noopener')
}

function onKeydown(e) {
  if (e.key === 'Escape' && full.value) closeFull()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(loadTimer)
})
</script>

<style scoped>
.dyna-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  background: #04070c;
}

.dyna-bar {
  flex: 0 0 48px;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: #0b1118;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  color: #dbe6ef;
}

.dyna-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.dyna-url {
  font:
    11px/1.4 Consolas,
    monospace;
  color: #8fa3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dyna-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.dyna-frame {
  flex: 1 1 auto;
  width: 100%;
  border: 0;
  background: #ffffff;
}
</style>
