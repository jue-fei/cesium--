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
        <!-- 第1行：名称 + 状态标记 + 品位标记 -->
        <div class="flex justify-between items-center mb-1.5">
          <span
            class="font-semibold text-gray-200 text-xs group-hover:text-blue-200 transition-colors"
            >{{ orebody.name }}</span
          >
          <div class="flex items-center gap-1">
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full"
              :class="getStatusClass(orebody.status)"
            >
              {{ orebody.status }}
            </span>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full"
              :class="getGradeClass(orebody.grade)"
            >
              品位 {{ orebody.grade }}%
            </span>
          </div>
        </div>

        <!-- 第2行：厚度 / 储量 / 矿石类型 -->
        <div class="flex justify-between text-[10px] text-gray-400 mb-1">
          <span
            >厚度: <span class="text-gray-300 font-mono">{{ orebody.thickness }}m</span></span
          >
          <span
            >储量: <span class="text-gray-300 font-mono">{{ orebody.reserves }}万吨</span></span
          >
          <span v-if="orebody.oreType"
            >类型: <span class="text-blue-400 font-mono">{{ orebody.oreType }}</span></span
          >
        </div>

        <!-- 第3行：埋深范围 / 开采方式 / 倾角 -->
        <div class="flex justify-between text-[10px] text-gray-400 mb-1">
          <span v-if="orebody.depthTop || orebody.depthBottom">
            埋深:
            <span class="text-gray-300 font-mono">
              {{ orebody.depthTop ?? '?' }}~{{ orebody.depthBottom ?? '?' }}m
            </span>
          </span>
          <span v-if="orebody.miningMethod"
            >开采: <span class="text-yellow-400 font-mono">{{ orebody.miningMethod }}</span></span
          >
          <span v-if="orebody.dipAngle"
            >倾角: <span class="text-gray-300 font-mono">{{ orebody.dipAngle }}°</span></span
          >
        </div>

        <!-- 第4行：密度 / 金属量 / 资源置信度 -->
        <div class="flex justify-between text-[10px] text-gray-400">
          <span v-if="orebody.density"
            >密度: <span class="text-gray-300 font-mono">{{ orebody.density }}t/m³</span></span
          >
          <span v-if="orebody.metalContent"
            >金属量:
            <span class="text-green-400 font-mono">{{ orebody.metalContent }}万吨</span></span
          >
          <span v-if="orebody.confidenceLevel"
            >置信度:
            <span
              class="text-[10px] px-1 rounded"
              :class="getConfidenceClass(orebody.confidenceLevel)"
            >
              {{ orebody.confidenceLevel }}
            </span>
          </span>
        </div>

        <!-- 第5行：描述（截断显示） -->
        <div
          v-if="orebody.description"
          class="mt-1.5 pt-1.5 border-t border-white/5 text-[10px] text-gray-500 leading-relaxed line-clamp-2"
        >
          {{ orebody.description }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import useGeologyAnalysis from '../services/useGeologyAnalysis.js'
import { ORE_GRADE_THRESHOLDS } from '../../../config/constants/appConfig.js'

const { orebodies } = useGeologyAnalysis()

const getGradeClass = grade => {
  if (typeof grade !== 'number' || isNaN(grade)) {
    return 'bg-gray-500/10 text-gray-400'
  }
  if (grade >= ORE_GRADE_THRESHOLDS.HIGH) return 'bg-green-500/10 text-green-400'
  if (grade >= ORE_GRADE_THRESHOLDS.MEDIUM) return 'bg-yellow-500/10 text-yellow-400'
  return 'bg-blue-500/10 text-blue-400'
}

const getStatusClass = status => {
  const map = {
    正在开采: 'bg-green-500/10 text-green-400',
    勘探: 'bg-blue-500/10 text-blue-400',
    规划中: 'bg-yellow-500/10 text-yellow-400',
    已闭坑: 'bg-gray-500/10 text-gray-400'
  }
  return map[status] || 'bg-gray-500/10 text-gray-400'
}

const getConfidenceClass = level => {
  const map = {
    探明: 'bg-green-500/10 text-green-400',
    控制: 'bg-yellow-500/10 text-yellow-400',
    推断: 'bg-blue-500/10 text-blue-400'
  }
  return map[level] || 'bg-gray-500/10 text-gray-400'
}
</script>
