<template>
  <div
    class="fixed top-5 right-5 flex items-center gap-3 px-6 py-4 bg-bg-secondary/95 backdrop-blur-md rounded-lg shadow-tech-lg z-[9999] translate-x-[120%] transition-transform duration-400 ease-[cubic-bezier(0.68,-0.55,0.265,1.55)] border-l-4"
    :class="[{ '!translate-x-0': isVisible }, messageTypeClass]"
  >
    <span class="text-xl font-bold" :class="iconColorClass">{{
      messageType === 'success' ? '✓' : messageType === 'error' ? '✕' : 'ℹ'
    }}</span>
    <span class="text-sm font-medium text-text-primary">{{ message }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import useMessage from '@/composables/useMessage.js'

const { message, messageType, isVisible } = useMessage()

const TYPE_MAP = {
  success: { border: 'border-success', text: 'text-success' },
  error: { border: 'border-secondary', text: 'text-secondary' },
  warning: { border: 'border-warning', text: 'text-warning' },
  info: { border: 'border-primary', text: 'text-primary' }
}

const messageTypeClass = computed(() => (TYPE_MAP[messageType.value] || TYPE_MAP.info).border)
const iconColorClass = computed(() => (TYPE_MAP[messageType.value] || TYPE_MAP.info).text)
</script>
