<template>
  <!--
    现场调度中心：地下巷道铲运机(LHD)出矿调度
    原露天矿矿卡调度已整体改造为井下巷道场景（见 scheduling/ 下的新面板）。
    顶部 4D 时间轴：拖动/播放回放设备轨迹历史（经 useMonitoring 既有回放机制，
    末端自动回 live）；右上角数据源状态灯；下方设备健康面板。
  -->
  <div>
    <div class="relative">
      <div class="absolute top-2 right-3 z-10">
        <DataSourceBadge />
      </div>
      <LhdSchedulingPanel />
    </div>
    <div class="mt-4 flex flex-col gap-4">
      <TimelineBar title="设备层 · 轨迹回放" :window-minutes="5" />
      <EquipmentHealthPanel />
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '现场调度中心面板' })
import { onBeforeUnmount } from 'vue'
import LhdSchedulingPanel from './scheduling/LhdSchedulingPanel.vue'
import DataSourceBadge from './DataSourceBadge.vue'
import EquipmentHealthPanel from './EquipmentHealthPanel.vue'
import TimelineBar from '../../shared/playback/TimelineBar.vue'
import { timelineBus } from '../../shared/playback/timelineController.js'
import useMonitoring from '../services/useMonitoring.js'

// 4D 时间总线 → 设备层既有回放机制（getTruckStateAtTime + isHistoricalPlayback，
// 末端 HISTORY_LIVE_THRESHOLD_MS 内自动回 live）。设备层数据链路零改动。
const { handleTimelineTimeChange, handleTimelinePlayStateChange } = useMonitoring()
let prevPlaying = false
const unsubTimeline = timelineBus.on(state => {
  if (state.playing !== prevPlaying) {
    handleTimelinePlayStateChange(state.playing)
    prevPlaying = state.playing
  }
  handleTimelineTimeChange(state.ts)
})
onBeforeUnmount(() => {
  unsubTimeline()
})
</script>
