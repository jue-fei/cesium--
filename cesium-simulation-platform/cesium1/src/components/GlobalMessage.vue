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

const messageTypeClass = computed(() => {
  switch (messageType.value) {
    case 'success':
      return 'border-success'
    case 'error':
      return 'border-secondary'
    case 'warning':
      return 'border-warning'
    case 'info':
    default:
      return 'border-primary'
  }
})

const iconColorClass = computed(() => {
  switch (messageType.value) {
    case 'success':
      return 'text-success'
    case 'error':
      return 'text-secondary'
    case 'warning':
      return 'text-warning'
    case 'info':
    default:
      return 'text-primary'
  }
})
</script>
