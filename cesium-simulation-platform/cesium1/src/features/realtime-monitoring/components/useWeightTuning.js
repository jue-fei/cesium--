/**
 * useWeightTuning.js —— 多目标权重调节交互（MultiObjectiveLhdView 专用 composable）
 *
 * 数据流：
 *   ML 推荐权重（后端 /weights/recommend，外部 ML 服务或等权降级）
 *     → 滑杆微调（0..100 原始值，展示层按和归一化为百分比）
 *     → 快路径 POST /multi-objective/solve {resolve:false}：在既有前沿上加权
 *       推荐方案（毫秒级，300ms 防抖，AbortController 取消过期请求）
 *     → 深路径 resolve:true：权重作为偏好参考方向重新运行 NSGA-III（onSolved 回调
 *       由组件用返回前沿覆盖展示）。
 *
 * 目标 id 清单 / 来源枚举契约见 shared-consistency-baseline.json#weightTuningCmps。
 */
import { ref, computed } from 'vue'
import { fetchWeightRecommend, solveMultiObjective } from '../services/schedulingApi.js'

/** 滑杆改动后自动求解的防抖间隔（ms） */
const DEBOUNCE_MS = 300

/**
 * @param {object} opts
 * @param {import('vue').ComputedRef<string>|string} opts.scenario 场景名
 * @param {import('vue').ComputedRef<Array<{id:string,name:string,desc?:string}>>} opts.objectives 目标定义
 * @param {(index:number)=>void} [opts.onRecommend] 推荐解下标回调（联动选中方案）
 * @param {(data:object)=>void} [opts.onSolved] 深路径重求解完成回调（携带新前沿）
 */
export function useWeightTuning({ scenario, objectives, onRecommend, onSolved }) {
  const scen = () => (typeof scenario === 'function' ? scenario() : (scenario?.value ?? scenario))

  // 滑杆原始值（0..100 整数）；展示权重 = raw / Σraw
  const raw = ref({})
  // 权重来源：'ml-external' | 'fallback' | 'manual' | ''（未加载）
  const source = ref('')
  const modelVersion = ref('')
  const degraded = ref(false)
  const loading = ref(false)
  const solving = ref(false)
  const error = ref('')
  // 锁定 ML 推荐：锁定期间前端不因前沿刷新重算；滑杆改动自动解锁
  const locked = ref(false)
  // 最近一次加权推荐的解下标（-1 = 无前沿/未求解）
  const recommendIndex = ref(-1)

  let debounceTimer = null
  let abortCtrl = null

  /** 归一化后的权重（Σ=1），供提交与展示 */
  const normW = computed(() => {
    const ids = objectives.value.map(o => o.id)
    const total = ids.reduce((s, id) => s + (raw.value[id] || 0), 0)
    const out = {}
    if (total <= 0) {
      ids.forEach(id => {
        out[id] = 1 / ids.length
      })
      return out
    }
    ids.forEach(id => {
      out[id] = (raw.value[id] || 0) / total
    })
    return out
  })

  /** 用后端权重填充滑杆（映射到 0..100 整数，舍入误差补到最大项） */
  function fillWeights(weights, src) {
    const ids = objectives.value.map(o => o.id)
    const total = ids.reduce((s, id) => s + Math.max(0, Number(weights?.[id]) || 0), 0)
    const next = {}
    ids.forEach(id => {
      next[id] =
        total > 0
          ? Math.round((Math.max(0, Number(weights[id]) || 0) / total) * 100)
          : Math.round(100 / ids.length)
    })
    let diff = 100 - Object.values(next).reduce((a, b) => a + b, 0)
    const byDesc = Object.keys(next).sort((a, b) => next[b] - next[a])
    let i = 0
    while (diff !== 0 && byDesc.length) {
      const id = byDesc[i % byDesc.length]
      next[id] += diff > 0 ? 1 : -1
      diff += diff > 0 ? -1 : 1
      i++
    }
    raw.value = next
    if (src) source.value = src
  }

  /** 拉取 ML 推荐权重并填充；成功后未锁定则自动快路径求解一次 */
  async function loadRecommend() {
    loading.value = true
    error.value = ''
    try {
      const json = await fetchWeightRecommend(scen())
      const data = json?.data
      if (json?.code !== 0 || !data?.weights) {
        throw new Error(json?.message || '推荐权重响应为空')
      }
      fillWeights(data.weights, data.source)
      modelVersion.value = data.modelVersion || ''
      degraded.value = !!data.degraded
      if (!locked.value) scheduleSolve()
    } catch (e) {
      error.value = e.message || String(e)
    } finally {
      loading.value = false
    }
  }

  /** 滑杆输入：来源转为手动并防抖求解 */
  function onSliderInput() {
    locked.value = false
    source.value = 'manual'
    scheduleSolve()
  }

  function scheduleSolve() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      solveFast()
    }, DEBOUNCE_MS)
  }

  /** 快路径：在既有前沿上加权推荐（不重跑算法） */
  async function solveFast() {
    if (abortCtrl) abortCtrl.abort()
    abortCtrl = new AbortController()
    solving.value = true
    error.value = ''
    try {
      const json = await solveMultiObjective({
        weights: normW.value,
        scenario: scen(),
        signal: abortCtrl.signal
      })
      if (json?.code !== 0) throw new Error(json?.message || '权重求解请求失败')
      recommendIndex.value = json.data.recommendedIndex
      if (json.data.recommendedIndex >= 0) onRecommend?.(json.data.recommendedIndex)
    } catch (e) {
      if (e?.name !== 'AbortError') error.value = e.message || String(e)
    } finally {
      solving.value = false
    }
  }

  /** 深路径：权重作为偏好参考方向重新运行 NSGA-III（onSolved 交组件覆盖前沿） */
  async function deepSolve() {
    solving.value = true
    error.value = ''
    try {
      const json = await solveMultiObjective({
        weights: normW.value,
        resolve: true,
        scenario: scen()
      })
      if (json?.code !== 0) throw new Error(json?.message || '按权重重求解失败')
      recommendIndex.value = json.data.recommendedIndex
      onSolved?.(json.data)
      if (json.data.recommendedIndex >= 0) onRecommend?.(json.data.recommendedIndex)
    } catch (e) {
      error.value = e.message || String(e)
    } finally {
      solving.value = false
    }
  }

  /** 前沿刷新（快照轮询换前沿）后重算推荐；锁定时不重算，保持当前选中不漂移 */
  function refreshOnFrontChange() {
    if (source.value && !locked.value) scheduleSolve()
  }

  function lockRecommend(v) {
    locked.value = v ?? !locked.value
  }

  return {
    raw,
    normW,
    source,
    modelVersion,
    degraded,
    loading,
    solving,
    error,
    locked,
    recommendIndex,
    loadRecommend,
    onSliderInput,
    solveFast,
    deepSolve,
    refreshOnFrontChange,
    lockRecommend
  }
}
