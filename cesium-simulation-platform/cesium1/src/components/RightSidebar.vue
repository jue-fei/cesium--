<template>
  <div
    class="fixed right-0 top-1/2 -translate-y-1/2 w-[60px] bg-bg-secondary rounded-l-lg border border-r-0 border-border-primary flex flex-col gap-2 py-4 z-[2000] shadow-tech-lg"
  >
    <template v-for="(group, index) in groups" :key="group.id">
      <div v-if="index > 0" class="group-sep"></div>
      <el-tooltip
        v-for="tool in group.tools"
        :key="tool.id"
        :content="tool.name"
        placement="left"
        effect="dark"
        :show-after="500"
      >
        <div
          class="w-full h-12 flex flex-col items-center justify-center text-text-muted cursor-pointer transition-all duration-200 relative hover:text-text-primary hover:bg-white/5 hover:scale-110 active:scale-95 group"
          :class="{ '!text-primary bg-primary/10': activeTool === tool.id }"
          role="button"
          tabindex="0"
          :aria-label="tool.name"
          :title="tool.name"
          @click="toggleTool(tool.id)"
        >
          <div
            v-if="activeTool === tool.id"
            class="absolute left-0 top-[10%] bottom-[10%] w-[3px] bg-primary rounded-r-sm shadow-glow"
          ></div>
          <el-icon :size="24">
            <component :is="getIcon(tool.icon)" />
          </el-icon>
        </div>
      </el-tooltip>
    </template>
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
  Aim,
  DataBoard
} from '@element-plus/icons-vue'
import useUI from '@/composables/useUI.js'
import { TOOL_REGISTRY } from '@/features/shared/index.js'

// 按「场景分析 / 工序协同 / 平台工具」三组排列，组间用细线分隔；
// 新能力（驾驶舱、数据接入）不再作为并列工具，而是收进顶部孪生层与系统工具。
const GROUPS = [
  {
    id: 'scene',
    ids: ['model_control', 'geology', 'measure', 'clipping']
  },
  {
    id: 'process',
    ids: ['monitoring', 'blasting', 'stress']
  },
  {
    id: 'platform',
    ids: ['lod', 'dyna_twin', 'system']
  }
]

const tools = TOOL_REGISTRY.map(t => ({ id: t.id, name: t.name, icon: t.icon }))
const groups = GROUPS.map(group => ({
  ...group,
  tools: tools.filter(tool => group.ids.includes(tool.id))
})).filter(group => group.tools.length)

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
  Aim,
  DataBoard
}

const getIcon = name => iconMap[name] || Setting
</script>

<style scoped>
.group-sep {
  width: 28px;
  height: 1px;
  margin: 2px auto;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.16), transparent);
}
</style>
