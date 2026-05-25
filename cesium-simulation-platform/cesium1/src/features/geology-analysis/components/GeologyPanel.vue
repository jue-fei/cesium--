<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <ModelList />
      <ModelProperties />
      <GeologyStats :stats="geologicalStats" />
      <BoreholeQuery />
      <LayerList />
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '地质分析面板' })
import { useGeologyPanelController } from '../services/panel/useGeologyPanelController.js'
import ModelList from './ModelList.vue'
import ModelProperties from './ModelProperties.vue'
import GeologyStats from './GeologyStats.vue'
import BoreholeQuery from './BoreholeQuery.vue'
import LayerList from './LayerList.vue'

const { geologicalStats } = useGeologyPanelController()
</script>
