<template>
  <div
    class="fixed top-5 right-[70px] bottom-5 z-10 w-panel flex flex-col animate-[slideLeft_0.3s_cubic-bezier(0.4,0,0.2,1)]"
  >
    <el-card
      class="flex-1 !bg-bg-primary backdrop-blur-md !border-border-primary !rounded-lg shadow-tech-lg overflow-hidden flex flex-col"
      :body-style="{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%' }"
    >
      <template #header>
        <div
          class="flex justify-between items-center px-5 py-4 bg-bg-secondary border-b border-border-primary shrink-0"
        >
          <h3 class="m-0 text-lg text-text-primary font-semibold tracking-wide">{{ title }}</h3>
          <el-button
            link
            class="!text-text-muted hover:!text-text-primary transition-colors"
            @click="onClose"
          >
            <el-icon :size="20">
              <Close />
            </el-icon>
          </el-button>
        </div>
      </template>

      <div class="flex-1 overflow-y-auto p-0">
        <slot></slot>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { Close } from '@element-plus/icons-vue'

defineProps({
  title: {
    type: String,
    default: '功能面板'
  }
})

const emit = defineEmits(['close'])

const onClose = () => {
  emit('close')
}
</script>

<style scoped>
@keyframes slideLeft {
  from {
    opacity: 0;
    transform: translateX(20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 响应式断点 */
@media (max-width: 480px) {
  .fixed {
    top: auto;
    bottom: 60px;
    right: 0;
    left: 0;
    width: 100%;
    height: 60vh;
    border-radius: 16px 16px 0 0;
  }
}
</style>
