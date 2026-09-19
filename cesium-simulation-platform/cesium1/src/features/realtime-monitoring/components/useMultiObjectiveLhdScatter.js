/**
 * useMultiObjectiveLhdScatter.js —— 帕累托前沿 2D 散点投影（MultiObjectiveLhdView 专用 composable）
 *
 * 数据本身是 6 目标（能耗/时间/风险/冲突/负载/品位）联合解，散点图是任意两两组合的
 * 二维投影——通过 pairIdx 切换坐标轴对，并为每组坐标补上真实刻度。
 */
import { ref, computed } from 'vue'

// SVG 绘图区（viewBox "0 0 200 150" 内的实际绘图范围）
const PLOT = { x0: 30, x1: 186, y0: 14, y1: 124 }

export function useMultiObjectiveLhdScatter({ objectives, paretoFront, selectedIndex }) {
  // 全部两两目标组合（C(6,2)=15 组），供"其它因素关系坐标轴"选择
  const pairOptions = computed(() => {
    const opts = []
    const objs = objectives.value
    for (let i = 0; i < objs.length; i++) {
      for (let j = i + 1; j < objs.length; j++) {
        opts.push({ xId: objs[i].id, yId: objs[j].id, label: `${objs[i].name} × ${objs[j].name}` })
      }
    }
    return opts
  })
  const pairIdx = ref(0)
  const activePair = computed(() => pairOptions.value[pairIdx.value] || pairOptions.value[0] || null)

  const paretoScatter = computed(() => {
    const front = paretoFront.value
    const pair = activePair.value
    if (!front.length || !pair) {
      return { points: [], xTicks: [], yTicks: [], xObj: null, yObj: null }
    }
    const X = front.map(ind => ind.objectives[pair.xId])
    const Y = front.map(ind => ind.objectives[pair.yId])
    const loX = Math.min(...X)
    const hiX = Math.max(...X)
    const loY = Math.min(...Y)
    const hiY = Math.max(...Y)
    const padX = (hiX - loX) * 0.05 || 1
    const padY = (hiY - loY) * 0.05 || 1
    const x0 = loX - padX
    const x1 = hiX + padX
    const y0 = loY - padY
    const y1 = hiY + padY
    const X0 = PLOT.x0
    const X1 = PLOT.x1
    const Y0 = PLOT.y0
    const Y1 = PLOT.y1
    const px = v => X0 + ((v - x0) / (x1 - x0)) * (X1 - X0)
    const py = v => Y1 - ((v - y0) / (y1 - y0)) * (Y1 - Y0)
    const xTicks = Array.from({ length: 5 }, (_, k) => x0 + (k * (x1 - x0)) / 4).map(v => ({
      v: Math.round(v * 100) / 100,
      px: px(v)
    }))
    const yTicks = Array.from({ length: 5 }, (_, k) => y0 + (k * (y1 - y0)) / 4).map(v => ({
      v: Math.round(v * 100) / 100,
      py: py(v)
    }))
    const points = front.map((ind, i) => ({
      x: px(ind.objectives[pair.xId]),
      y: py(ind.objectives[pair.yId]),
      valueX: ind.objectives[pair.xId],
      valueY: ind.objectives[pair.yId],
      selected: i === selectedIndex.value,
      pfIndex: i
    }))
    return {
      points,
      xTicks,
      yTicks,
      xObj: objectives.value.find(o => o.id === pair.xId) || null,
      yObj: objectives.value.find(o => o.id === pair.yId) || null
    }
  })

  function fmtTick(v) {
    const a = Math.abs(v)
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
  }

  // 解点 tooltip：显示该解在“当前坐标轴对”下 x/y 两个目标的实际取值
  function fmtTickPoint(pt, sc) {
    const xv = pt?.valueX ?? null
    const yv = pt?.valueY ?? null
    const xn = sc?.xObj?.name || ''
    const yn = sc?.yObj?.name || ''
    const xu = sc?.xObj?.unit || ''
    const yu = sc?.yObj?.unit || ''
    return `${xn}:${xv == null ? '-' : fmtTick(xv)}${xu} · ${yn}:${yv == null ? '-' : fmtTick(yv)}${yu}`
  }

  return { PLOT, pairOptions, pairIdx, paretoScatter, fmtTick, fmtTickPoint }
}
