/**
 * 扇区邻居选择工具
 * 用于空间插值中按扇区均匀采样邻居点，避免聚集偏差
 */

/**
 * 将候选点分配到扇区，并从每个扇区中选择最近的一个点
 * @param {Array} candidates - 候选点数组，每个元素需包含 distance2（或 options.distanceKey 指定的键）
 * @param {number} usedCount - 目标选择数量
 * @param {number} sectorCount - 扇区数量
 * @param {Function} getAngle - 获取候选点角度的函数 (candidate) => angle in radians
 * @param {Object} options - 可选配置
 * @param {string} options.distanceKey - 距离平方的键名，默认 'distance2'
 * @returns {Array} 按距离排序的选中点
 */
export function selectNeighborsBySector(
  candidates,
  usedCount,
  sectorCount,
  getAngle,
  options = {}
) {
  if (usedCount <= 2 || sectorCount <= 1 || candidates.length === 0) {
    return candidates.slice(0, usedCount)
  }

  const distanceKey = options.distanceKey || 'distance2'

  const sectors = new Array(sectorCount)
  for (let s = 0; s < sectorCount; s++) sectors[s] = []

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const a = getAngle(c)
    const t = (a + Math.PI) / (2 * Math.PI)
    const si = Math.max(0, Math.min(sectorCount - 1, Math.floor(t * sectorCount)))
    sectors[si].push(c)
  }

  const picked = []
  for (let s = 0; s < sectors.length && picked.length < usedCount; s++) {
    if (sectors[s].length > 0) picked.push(sectors[s].shift())
  }

  if (picked.length < usedCount) {
    const rest = []
    for (let s = 0; s < sectors.length; s++) {
      for (let i = 0; i < sectors[s].length; i++) rest.push(sectors[s][i])
    }
    rest.sort((a, b) => a[distanceKey] - b[distanceKey])
    for (let i = 0; i < rest.length && picked.length < usedCount; i++) picked.push(rest[i])
  }

  picked.sort((a, b) => a[distanceKey] - b[distanceKey])
  return picked
}
