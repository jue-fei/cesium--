<template>
  <!--
    现场调度中心：地下巷道铲运机(LHD)出矿调度
    原露天矿矿卡调度已整体改造为井下巷道场景（见 scheduling/ 下的新面板）。
  -->
  <LhdSchedulingPanel />
</template>

<script setup>
defineOptions({ name: '现场调度中心面板' })
import LhdSchedulingPanel from './scheduling/LhdSchedulingPanel.vue'
</script>