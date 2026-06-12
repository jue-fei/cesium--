<template>
  <div
    class="fixed right-0 top-1/2 -translate-y-1/2 w-[60px] bg-bg-secondary backdrop-blur-md rounded-l-lg border border-r-0 border-border-primary flex flex-col gap-2 py-4 z-[2000] shadow-tech-lg">
    <el-tooltip v-for="tool in tools" :key="tool.id" :content="tool.name" placement="left" effect="dark"
      :show-after="500">
      <div
        class="w-full h-12 flex flex-col items-center justify-center text-text-muted cursor-pointer transition-all duration-200 relative hover:text-text-primary hover:bg-white/5 hover:scale-110 active:scale-95 group"
        :class="{ '!text-primary bg-primary/10': activeTool === tool.id }" @click="toggleTool(tool.id)">
        <div v-if="activeTool === tool.id"
          class="absolute left-0 top-[10%] bottom-[10%] w-[3px] bg-primary rounded-r-sm shadow-glow"></div>
        <el-icon :size="24">
          <component :is="getIcon(tool.icon)" />
        </el-icon>
      </div>
    </el-tooltip>
  </div>
</template>

<script setup>
import {
  Location,
  Monitor,
  Scissor,
  VideoPlay,
  DataLine,
  Mouse,
  Setting,
  EditPen,
  Histogram,
  Aim
} from '@element-plus/icons-vue'
import useUI from '@/composables/useUI.js'
import { TOOL_REGISTRY } from '@/features/shared/index.js'

const tools = TOOL_REGISTRY.map(t => ({ id: t.id, name: t.name, icon: t.icon }))
const { activeTool, toggleTool } = useUI()

const iconMap = {
  Location,
  Monitor,
  Ruler: EditPen,
  Scissor,
  VideoPlay,
  DataLine,
  Mouse,
  Setting,
  Histogram,
  Aim
}

const getIcon = name => iconMap[name] || Setting
</script>
