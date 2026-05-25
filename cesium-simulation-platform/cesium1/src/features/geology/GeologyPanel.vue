<template>
  <div class="flex flex-col gap-6 p-5">
    <!-- 模型管理部分 (已拆分) -->
    <ModelList />

    <!-- 属性查看器 (已拆分) -->
    <ModelProperties />

    <!-- 地质统计 (已拆分) -->
    <GeologyStats :stats="geologicalStats" />

    <!-- 钻孔查询 (已拆分) -->
    <BoreholeQuery />

    <!-- 矿体列表 (已拆分) -->
    <LayerList />
  </div>
</template>

<script setup>
import { onUnmounted, onMounted } from 'vue'
import useGeologyAnalysis from '../../composables/useGeologyAnalysis.js'
import ModelList from './components/ModelList.vue'
import ModelProperties from './components/ModelProperties.vue'
import GeologyStats from './components/GeologyStats.vue'
import BoreholeQuery from './components/BoreholeQuery.vue'
import LayerList from './components/LayerList.vue'

// 组合式函数
const { destroy, initGeologyManager, geologicalStats } = useGeologyAnalysis()

onMounted(() => {
  initGeologyManager()
})

onUnmounted(() => {
  destroy()
})
</script>
