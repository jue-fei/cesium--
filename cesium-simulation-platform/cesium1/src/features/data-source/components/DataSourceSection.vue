<template>
  <div class="flex-1 min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <div class="panel-section">
        <div class="flex items-center justify-between">
          <div class="panel-section-title">数据接入台账</div>
          <button
            class="px-2 py-1 text-xs bg-white/5 border border-white/10 rounded hover:bg-white/10 disabled:opacity-50"
            :disabled="loading"
            @click="reload"
          >
            {{ loading ? '刷新中' : '刷新' }}
          </button>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-text-secondary">
          四类接入方式：REST / WebSocket / 文件 / 数据库。逐条连通性测试结果写回台账，用于「集成方式
          ≥4 种」举证。
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
          <span class="rounded bg-white/5 border border-white/10 px-2 py-0.5">
            已登记 <b class="text-text-primary">{{ sources.length }}</b>
          </span>
          <span
            class="rounded bg-green-500/10 border border-green-500/30 px-2 py-0.5 text-green-300"
          >
            已连通 <b>{{ connectedCount }}</b>
          </span>
          <span
            v-if="errorCount"
            class="rounded bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-red-300"
          >
            异常 <b>{{ errorCount }}</b>
          </span>
          <span v-if="kinds.length" class="rounded bg-white/5 border border-white/10 px-2 py-0.5">
            支持 {{ kinds.join(' / ') }}
          </span>
        </div>
      </div>

      <div class="panel-section">
        <button
          class="w-full py-2 text-xs bg-white/5 border border-white/10 rounded hover:bg-white/10 transition-all"
          @click="formOpen = !formOpen"
        >
          {{ formOpen ? '收起登记表单' : '+ 登记数据源' }}
        </button>
        <div v-if="formOpen" class="mt-3 grid grid-cols-2 gap-2 text-xs">
          <label class="flex flex-col gap-1">
            <span class="text-text-secondary">编码</span>
            <input v-model.trim="form.code" class="form-input" placeholder="如 blasting-rest" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-text-secondary">名称</span>
            <input v-model.trim="form.name" class="form-input" placeholder="爆破事件 REST" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-text-secondary">类型</span>
            <select v-model="form.kind" class="form-input">
              <option v-for="k in kindOptions" :key="k.value" :value="k.value">
                {{ k.label }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-text-secondary">责任人</span>
            <input v-model.trim="form.owner" class="form-input" placeholder="可选" />
          </label>
          <label class="col-span-2 flex flex-col gap-1">
            <span class="text-text-secondary">地址 / 视图 / 说明</span>
            <input
              v-model.trim="form.endpoint"
              class="form-input"
              placeholder="rest: /api/blasting/events；db: 只读视图名"
            />
          </label>
          <button
            class="col-span-2 py-2 bg-primary/20 border border-primary/40 rounded text-primary hover:bg-primary/30 disabled:opacity-50"
            :disabled="saving"
            @click="submitForm"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
        <p class="mt-2 text-[11px] text-text-secondary">
          rest→HTTP 接口；db→只读视图；file→上传 JSON/CSV；ws→外部系统推送。
        </p>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">台账列表</div>
        <div v-if="!sources.length" class="mt-2 text-xs text-text-secondary">
          暂无数据源，先登记一条。
        </div>
        <div
          v-for="s in sources"
          :key="s.code"
          class="mt-2 rounded-lg border border-white/10 bg-white/5 p-3"
          :class="{ 'opacity-60': busyCode === s.code }"
        >
          <div class="flex items-center gap-2">
            <span class="truncate text-sm text-text-primary" :title="s.name">{{ s.name }}</span>
            <span class="rounded bg-white/5 border border-white/10 px-1.5 py-0.5 text-[10px]">
              {{ kindLabel(s.kind) }}
            </span>
            <span class="ml-auto rounded px-1.5 py-0.5 text-[10px]" :class="statusClass(s.status)">
              {{ statusLabel(s.status) }}
            </span>
          </div>
          <div class="mt-1.5 flex flex-col gap-0.5 text-[11px] text-text-secondary">
            <span class="font-mono">{{ s.code }}</span>
            <span v-if="s.endpoint" class="truncate" :title="s.endpoint">{{ s.endpoint }}</span>
            <span>最近同步：{{ s.last_sync_at || '未同步' }}</span>
            <span v-if="s.owner">责任人：{{ s.owner }}</span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <button class="act-btn" :disabled="busyCode === s.code" @click="onTest(s)">
              测试连通
            </button>
            <button
              v-if="s.kind === 'rest' || s.kind === 'db'"
              class="act-btn"
              :disabled="busyCode === s.code"
              @click="onPull(s)"
            >
              拉取
            </button>
            <button
              v-if="s.kind === 'file'"
              class="act-btn"
              :disabled="busyCode === s.code"
              @click="pickFile(s.code)"
            >
              上传
            </button>
            <button class="act-btn" :disabled="busyCode === s.code" @click="onBatches(s)">
              批次
            </button>
            <button class="act-btn act-danger" :disabled="busyCode === s.code" @click="onDelete(s)">
              删除
            </button>
          </div>
        </div>
      </div>

      <div v-if="batchesFor" class="panel-section">
        <div class="flex items-center justify-between">
          <div class="panel-section-title">批次回溯 · {{ batchesFor }}</div>
          <button
            class="px-2 py-1 text-xs bg-white/5 border border-white/10 rounded hover:bg-white/10"
            @click="closeBatches"
          >
            关闭
          </button>
        </div>
        <div v-if="!batches.length" class="mt-2 text-xs text-text-secondary">暂无批次记录。</div>
        <div
          v-for="b in batches"
          :key="b.batch_no"
          class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-white/10 px-2 py-1.5 text-[11px] text-text-secondary"
        >
          <span class="font-mono text-text-primary">{{ b.batch_no }}</span>
          <span class="truncate">{{ b.filename || '—' }}</span>
          <span>{{ b.rows_accepted }}/{{ b.rows_total }} 接收</span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px]"
            :class="
              b.status === 'ok' ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'
            "
          >
            {{ b.status }}
          </span>
          <span class="ml-auto">{{ b.created_at }}</span>
        </div>
      </div>

      <p
        v-if="message"
        class="rounded border px-3 py-2 text-[11px] leading-relaxed"
        :class="
          messageKind === 'error'
            ? 'border-red-500/40 bg-red-500/10 text-red-300'
            : 'border-green-500/40 bg-green-500/10 text-green-300'
        "
      >
        {{ message }}
      </p>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".json,.csv,application/json,text/csv"
      class="hidden"
      @change="onFileChange"
    />
  </div>
</template>

<script setup>
defineOptions({ name: '数据接入台账' })

import { computed, onMounted, ref } from 'vue'

import {
  deleteSource,
  fetchBatches,
  fetchSources,
  pullSource,
  testSource,
  uploadSourceFile,
  upsertSource
} from '../services/dataSourceApi.js'

const KIND_LABEL = { rest: 'REST', ws: 'WebSocket', file: '文件', db: '数据库' }
const KIND_OPTIONS = [
  { value: 'rest', label: 'REST' },
  { value: 'ws', label: 'WebSocket' },
  { value: 'file', label: '文件' },
  { value: 'db', label: '数据库' }
]

const sources = ref([])
const kinds = ref([])
const loading = ref(false)
const saving = ref(false)
const busyCode = ref('')
const message = ref('')
const messageKind = ref('ok')
const formOpen = ref(false)
const form = ref({ code: '', name: '', kind: 'rest', endpoint: '', owner: '' })
const batchesFor = ref('')
const batches = ref([])
const fileInput = ref(null)
const pendingUpload = ref('')

const kindOptions = computed(() => {
  if (!kinds.value.length) return KIND_OPTIONS
  return KIND_OPTIONS.filter(item => kinds.value.includes(item.value))
})

const connectedCount = computed(
  () => sources.value.filter(item => item.status === 'connected').length
)
const errorCount = computed(() => sources.value.filter(item => item.status === 'error').length)

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || '—'
}

function statusLabel(status) {
  if (status === 'connected') return '已连通'
  if (status === 'error') return '异常'
  return '待检测'
}

function statusClass(status) {
  if (status === 'connected') return 'bg-green-500/10 border border-green-500/30 text-green-300'
  if (status === 'error') return 'bg-red-500/10 border border-red-500/30 text-red-300'
  return 'bg-white/5 border border-white/10 text-text-secondary'
}

function notify(text, kind = 'ok') {
  message.value = text
  messageKind.value = kind
}

async function reload() {
  loading.value = true
  try {
    const data = await fetchSources()
    sources.value = data.sources || []
    kinds.value = data.kinds || []
  } catch (err) {
    notify(`台账加载失败：${err.message}`, 'error')
  } finally {
    loading.value = false
  }
}

async function runAction(code, fn) {
  busyCode.value = code
  try {
    return await fn()
  } catch (err) {
    notify(`操作失败：${err.message}`, 'error')
    return null
  } finally {
    busyCode.value = ''
  }
}

async function onTest(source) {
  const res = await runAction(source.code, () => testSource(source.code))
  if (!res) return
  const ok = Boolean(res.data?.ok)
  notify(
    ok
      ? `${source.name} 连通正常（耗时 ${res.data?.latencyMs ?? '—'} ms）`
      : `${source.name} 连通失败：${res.data?.message || '无响应'}`,
    ok ? 'ok' : 'error'
  )
  await reload()
}

async function onPull(source) {
  const res = await runAction(source.code, () => pullSource(source.code, 100))
  if (!res) return
  const data = res.data || {}
  notify(
    data.ok
      ? `拉取完成：接收 ${data.rowsAccepted}/${data.rowsTotal} 行，批次 ${data.batchNo}`
      : `拉取失败：${data.message || '未知原因'}`,
    data.ok ? 'ok' : 'error'
  )
  await reload()
}

function pickFile(code) {
  pendingUpload.value = code
  fileInput.value?.click()
}

async function onFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  const code = pendingUpload.value
  pendingUpload.value = ''
  if (!file || !code) return
  const res = await runAction(code, () => uploadSourceFile(code, file))
  if (!res) return
  const data = res.data || {}
  notify(
    data.ok
      ? `上传完成：接收 ${data.rowsAccepted}/${data.rowsTotal} 行，批次 ${data.batchNo}`
      : `上传失败：${data.message || '未知原因'}`,
    data.ok ? 'ok' : 'error'
  )
  await reload()
}

async function onBatches(source) {
  const rows = await runAction(source.code, () => fetchBatches(source.code, 20))
  if (rows === null) return
  batchesFor.value = source.code
  batches.value = rows
}

function closeBatches() {
  batchesFor.value = ''
  batches.value = []
}

async function submitForm() {
  if (!form.value.code || !form.value.name) {
    notify('编码与名称必填', 'error')
    return
  }
  saving.value = true
  try {
    const res = await upsertSource({ ...form.value })
    if (res.code !== 0) {
      notify(res.message || '保存失败', 'error')
      return
    }
    notify(`已保存 ${form.value.code}`, 'ok')
    form.value = { code: '', name: '', kind: 'rest', endpoint: '', owner: '' }
    formOpen.value = false
    await reload()
  } catch (err) {
    notify(`保存失败：${err.message}`, 'error')
  } finally {
    saving.value = false
  }
}

async function onDelete(source) {
  if (!window.confirm(`确认删除数据源 ${source.code}？`)) return
  const res = await runAction(source.code, () => deleteSource(source.code))
  if (!res) return
  notify(
    res.code === 0 ? `已删除 ${source.code}` : res.message || '删除失败',
    res.code === 0 ? 'ok' : 'error'
  )
  await reload()
}

onMounted(reload)
</script>

<style scoped>
.form-input {
  width: 100%;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 12px;
  outline: none;
}

.form-input:focus {
  border-color: rgba(103, 232, 249, 0.5);
  background: rgba(255, 255, 255, 0.08);
}

.act-btn {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #c7d5e3;
  transition: all 0.15s ease;
}

.act-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(103, 232, 249, 0.4);
}

.act-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.act-danger {
  color: #fca5a5;
  border-color: rgba(248, 113, 113, 0.3);
}
</style>
