/**
 * useTunnelMap3DLabels.js —— 标记/标签管理（TunnelMap3D 专用 composable）
 *
 * 职责：
 *   - 创建 CSS2D 标签对象（巷道段编号 / 节点名 / 设备名 / 坐标轴 / 竖井地表等）
 *   - 统一登记标签：区分"巷道旁标识"（seg）与普通标签，供场景重建时整体移除清理
 *   - 巷道旁编号小标签的批量显隐开关（模板复选框绑定 showSegLabels + applySegLabels）
 */
import { ref } from 'vue'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export function useTunnelMap3DLabels() {
  // 巷道旁编号小标签显隐开关（控制巷道段/竖井/主井/地表等巷道旁标识）
  const showSegLabels = ref(true)
  // 已创建的"巷道旁标识"标签对象（供开关批量显隐，设备/节点标签不在此列）
  let segLabels = []
  // 已创建的全部标签对象（供重建时整体从父节点移除）
  let labelObjs = []

  function makeLabel(text, cls) {
    const div = document.createElement('div')
    div.className = cls
    div.textContent = text
    return new CSS2DObject(div)
  }

  // 登记标签：isSeg=true 的标签同时进入"巷道旁标识"清单，受显隐开关控制
  function registerLabel(label, isSeg = false) {
    labelObjs.push(label)
    if (isSeg) segLabels.push(label)
  }

  // 场景重建前清理：把全部标签从父节点（scene / 设备组）移除并重置登记表
  function resetLabels() {
    for (const l of labelObjs) l.removeFromParent()
    labelObjs = []
    segLabels = []
  }

  function applySegLabels() {
    try {
      for (const l of segLabels) {
        if (l && l.element) l.element.style.visibility = showSegLabels.value ? 'visible' : 'hidden'
      }
    } catch (e) {
      /* 场景未就绪时静默忽略 */
    }
  }

  return { showSegLabels, applySegLabels, makeLabel, registerLabel, resetLabels }
}
