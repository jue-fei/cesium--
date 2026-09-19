/**
 * useMultiObjectiveLhdSort.js —— 帕累托明细表排序（MultiObjectiveLhdView 专用 composable）
 *
 * 单因子（点列头点击）/ 多因子复合（Shift+点击叠加）排序。
 * 仅作用于表格行序；选中/散点/当前方案的 canonical 序号(selectedIndex)保持不变，
 * 通过与原始 pfIndex 联动，保证排序切换后选中方案不漂移。
 */
import { ref, computed } from 'vue'

export function useMultiObjectiveLhdSort({ objectives, paretoFront }) {
  const sortKeys = ref([]) // [{ id, dir:'asc'|'desc' }]，索引越小优先级越高
  function sortRank(id) {
    const i = sortKeys.value.findIndex(k => k.id === id)
    return i === -1 ? null : i
  }
  function sortDirOf(id) {
    const k = sortKeys.value.find(k => k.id === id)
    return k ? k.dir : null
  }
  function sortDirCls(id) {
    const d = sortDirOf(id)
    return d === null ? 'sa-none' : d === 'asc' ? 'sa-asc' : 'sa-desc'
  }
  function objName(id) {
    return objectives.value.find(o => o.id === id)?.name || id
  }
  function onSortClick(objId, e) {
    const has = sortKeys.value.some(k => k.id === objId)
    if (e.shiftKey) {
      // Shift+点：追加为更低优先级复合键；已在复合键中则切换其排序方向
      sortKeys.value = has
        ? sortKeys.value.map(k =>
            k.id === objId ? { id: objId, dir: k.dir === 'asc' ? 'desc' : 'asc' } : k
          )
        : [...sortKeys.value, { id: objId, dir: 'asc' }]
    } else if (has) {
      // 单因子：已在排序中 → 升/降 切换
      sortKeys.value = sortKeys.value.map(k =>
        k.id === objId ? { id: objId, dir: k.dir === 'asc' ? 'desc' : 'asc' } : k
      )
    } else {
      // 单因子：未排序 → 以该因子为唯一主排序（先升后降）
      sortKeys.value = [{ id: objId, dir: 'asc' }]
    }
  }
  function clearSort() {
    sortKeys.value = []
  }
  // 排序后的表行（保留原始 pfIndex 供选中联动）
  const sortedRows = computed(() => {
    const rows = paretoFront.value.map((ind, pfIndex) => ({ pfIndex, ind }))
    const keys = sortKeys.value
    if (!keys.length) return rows
    return rows.slice().sort((a, b) => {
      for (const k of keys) {
        const va = a.ind.objectives[k.id]
        const vb = b.ind.objectives[k.id]
        if (va == null && vb == null) continue
        if (va == null) return k.dir === 'asc' ? 1 : -1
        if (vb == null) return k.dir === 'asc' ? -1 : 1
        if (va === vb) continue
        const d = va < vb ? -1 : 1
        return k.dir === 'asc' ? d : -d
      }
      return a.pfIndex - b.pfIndex
    })
  })

  return { sortKeys, sortRank, sortDirCls, objName, onSortClick, clearSort, sortedRows }
}
