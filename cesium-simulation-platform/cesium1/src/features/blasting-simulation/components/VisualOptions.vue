<template>
  <div class="panel-section">
    <div class="panel-section-title">图层可见性</div>
    <div class="hint-text">
      单独控制 3D 场景中各爆破元素的显示/隐藏，便于聚焦观察特定效果。
    </div>
    <div class="layer-grid">
      <label v-for="layer in layerDefs" :key="layer.key" class="toggle-label layer-toggle">
        <input type="checkbox" :checked="layerVisibility[layer.key]" @change="onToggle(layer.key, $event)" />
        {{ layer.label }}
      </label>
    </div>
    <div class="controls-row mt-3">
      <button class="compact-action-btn" @click="setAll(true)">全部显示</button>
      <button class="compact-action-btn" @click="setAll(false)">仅场景</button>
      <button class="compact-action-btn" @click="$emit('sync-visibility')">同步状态</button>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'VisualOptions' })

const props = defineProps({
  layerDefs: { type: Array, default: () => [] },
  layerVisibility: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['set-layer-visible', 'sync-visibility'])

function onToggle(layer, event) {
  const checked = event?.target?.checked
  emit('set-layer-visible', layer, checked)
}

function setAll(visible) {
  for (const def of props.layerDefs) {
    emit('set-layer-visible', def.key, visible)
  }
}
</script>
