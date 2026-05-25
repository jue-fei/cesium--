<template>
  <div
    class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      场景视角
    </div>
    <div class="grid grid-cols-2 gap-2">
      <button
        v-for="preset in cameraPresets"
        :key="preset.id"
        class="flex flex-col items-center gap-1 p-3 rounded bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all"
        :class="selectedCamera === preset.id ? 'bg-blue-500/15 border-blue-500/40' : ''"
        @click="selectPreset(preset.id)"
      >
        <span class="text-lg">{{ preset.emoji || '📷' }}</span>
        <span class="text-xs font-medium text-gray-200">{{ preset.name }}</span>
        <span class="text-[10px] text-gray-500 text-center leading-tight">{{
          preset.description
        }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '场景视角' })

defineProps({
  cameraPresets: {
    type: Array,
    default: () => []
  },
  selectedCamera: {
    type: String,
    default: 'overview'
  }
})

const emit = defineEmits(['select'])

const selectPreset = id => {
  emit('select', id)
}
</script>
