<template>
  <span
    class="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full border"
    :style="badgeStyle"
  >
    <i class="w-1.5 h-1.5 rounded-full inline-block" :style="{ background: dotColor }" />
    {{ label }}
  </span>
</template>

<script setup>
/**
 * DataSourceBadge.vue —— 全域实时推送数据源状态灯
 *
 * 连接 /ws/realtime/equipment（RealtimeWsConnector），展示"模拟数据源"徽标与
 * 连接状态（绿=在线 / 黄=重连中 / 红=离线）。数据源为真实遥测（source!=='simulated'）
 * 时自动切换文案——将来接 MQTT 真实源前端零改动。
 */
defineOptions({ name: 'DataSourceBadge' })
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RealtimeWsConnector } from '../services/connectors/RealtimeWsConnector.js'

const status = ref('idle')
const source = ref(null)

let connector = null

const isSimulated = computed(() => (source.value ?? 'simulated') === 'simulated')
const label = computed(() => {
  const src = isSimulated.value ? '模拟数据源' : '实时遥测源'
  const map = {
    connected: '在线',
    reconnecting: '重连中',
    connecting: '连接中',
    error: '异常',
    disconnected: '离线'
  }
  return `${src} · ${map[status.value] ?? '未连接'}`
})
const dotColor = computed(() => {
  if (status.value === 'connected') return isSimulated.value ? '#fbbf24' : '#34d399'
  if (status.value === 'reconnecting' || status.value === 'connecting') return '#f59e0b'
  if (status.value === 'error') return '#ef4444'
  return '#9ca3af'
})
const badgeStyle = computed(() => ({ borderColor: `${dotColor.value}55`, color: dotColor.value }))

onMounted(() => {
  connector = new RealtimeWsConnector({ scope: 'equipment' })
    .onData(frame => {
      status.value = 'connected'
      source.value = frame.source
    })
    .onStatusChange(s => {
      status.value = s
    })
  connector.connect()
})

onBeforeUnmount(() => {
  connector?.destroy()
  connector = null
})
</script>
