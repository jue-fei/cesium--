<template>
  <div class="rounded-md border border-border-primary/60 bg-bg-secondary/70 px-3 py-2">
    <div class="truncate text-[11px] text-text-muted" :title="item.name">{{ item.name }}</div>
    <div class="mt-1 font-mono text-lg leading-tight text-text-primary">{{ text }}</div>
    <div class="mt-0.5 text-[10px] text-text-muted/80">{{ procLabel }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

import { formatValue } from '../services/twinKpiFormat.js'

const PROC_LABEL = {
  geology: '地质',
  blasting: '爆破',
  haulage: '运搬',
  safety: '防控',
  optimization: '优化',
  twin: '孪生'
}

const props = defineProps({
  item: { type: Object, required: true }
})

const text = computed(() => formatValue(props.item.value, props.item.unit))
const procLabel = computed(() => PROC_LABEL[props.item.proc] || props.item.proc || '')
</script>
