<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <ModelList />
      <ModelProperties />
      <GeologyStats :stats="geologicalStats" />
      <BoreholeQuery />
      <LayerList />
      <GradePanel />
      <TimelineBar title="品位层 · 开采推进" :window-minutes="5" />
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '地质分析面板' })
import { onBeforeUnmount } from 'vue'
import { useGeologyPanelController } from '../services/panel/useGeologyPanelController.js'
import ModelList from './ModelList.vue'
import ModelProperties from './ModelProperties.vue'
import GeologyStats from './GeologyStats.vue'
import BoreholeQuery from './BoreholeQuery.vue'
import LayerList from './LayerList.vue'
import GradePanel from './GradePanel.vue'
import TimelineBar from '../../shared/playback/TimelineBar.vue'
import { timelineBus } from '../../shared/playback/timelineController.js'
import { setTimelineProgress } from '../services/gradeLayerService.js'

const { geologicalStats } = useGeologyPanelController()

// 4D 时间总线 → 品位层中段推进（拖动/播放时间轴，已"开采"中段的块段逐段显现）
const unsubTimeline = timelineBus.on(state => setTimelineProgress(state.progress))
onBeforeUnmount(() => {
  unsubTimeline()
  setTimelineProgress(null) // 离开板块恢复全显
})
</script>
