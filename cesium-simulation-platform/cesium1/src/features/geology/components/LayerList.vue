<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      矿体列表
    </div>
    <div class="flex flex-col gap-2">
      <div
        v-for="orebody in orebodies"
        :key="orebody.id"
        class="bg-white/5 border border-white/10 rounded-md p-2.5 transition-all hover:translate-x-1 hover:bg-white/10 hover:border-blue-400/30 group"
      >
        <div class="flex justify-between items-center mb-1.5">
          <span
            class="font-semibold text-gray-200 text-xs group-hover:text-blue-200 transition-colors"
            >{{ orebody.name }}</span
          >
          <span
            class="text-[10px] px-1.5 py-0.5 rounded-full"
            :class="getGradeClass(orebody.grade)"
          >
            品位 {{ orebody.grade }}%
          </span>
        </div>
        <div class="flex justify-between text-[10px] text-gray-400">
          <span
            >厚度: <span class="text-gray-300 font-mono">{{ orebody.thickness }}m</span></span
          >
          <span
            >储量: <span class="text-gray-300 font-mono">{{ orebody.reserves }}万吨</span></span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import useGeologyAnalysis from '../../../composables/useGeologyAnalysis.js'
import { ORE_GRADE_THRESHOLDS } from '../../../config/constants/appConfig.js'

const { orebodies } = useGeologyAnalysis()

// 将品位阈值映射为样式类
const getGradeClass = grade => {
  if (typeof grade !== 'number' || isNaN(grade)) {
    return 'bg-gray-500/10 text-gray-400'
  }
  if (grade >= ORE_GRADE_THRESHOLDS.HIGH) return 'bg-green-500/10 text-green-400'
  if (grade >= ORE_GRADE_THRESHOLDS.MEDIUM) return 'bg-yellow-500/10 text-yellow-400'
  return 'bg-blue-500/10 text-blue-400'
}
</script>
