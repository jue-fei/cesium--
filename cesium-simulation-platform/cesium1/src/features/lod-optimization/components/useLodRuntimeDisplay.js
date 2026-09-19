/**
 * useLodRuntimeDisplay.js —— 实时观测区展示派生（LodPanel 专用 composable）
 *
 * 把 LOD 运行时快照转为面板可直接渲染的派生量：
 * 主导阶段色键、复杂度分档、自适应压力分档与大数缩写（K/M）。
 */
import { computed } from 'vue'

// 复杂度分档阈值（满分 100）
const COMPLEXITY_HIGH_THRESHOLD = 80
const COMPLEXITY_MID_THRESHOLD = 50
// 大数缩写分界：达到百万用 M、达到千用 K，其余取整展示
const COUNT_MILLION = 1000000
const COUNT_THOUSAND = 1000

export function useLodRuntimeDisplay({ lodRuntime, lodComplexityIndex, adaptivePressureLabel }) {
  const dominantStageKey = computed(() => {
    const m = (lodRuntime.value?.dominantLodStage || 'S0').match(/S(\d)/i)
    return m ? `s${m[1]}` : 's0'
  })

  const complexityClass = computed(() => {
    const v = lodComplexityIndex.value
    return v >= COMPLEXITY_HIGH_THRESHOLD ? 'high' : v >= COMPLEXITY_MID_THRESHOLD ? 'mid' : 'low'
  })

  const pressureClass = computed(() => {
    if (adaptivePressureLabel.value === '高') return 'high'
    if (adaptivePressureLabel.value === '中') return 'mid'
    return 'low'
  })

  function fmtNum(v) {
    const n = Number(v) || 0
    if (n >= COUNT_MILLION) return (n / COUNT_MILLION).toFixed(2) + 'M'
    if (n >= COUNT_THOUSAND) return (n / COUNT_THOUSAND).toFixed(1) + 'K'
    return String(Math.round(n))
  }

  return { dominantStageKey, complexityClass, pressureClass, fmtNum }
}
