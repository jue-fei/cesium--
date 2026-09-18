/**
 * 马蹄形隧道断面几何判定工具。
 *
 * 坐标系约定（掌子面局部平面坐标）：
 *  - 底板为 y=0，y 轴向上为正；
 *  - 下部为直墙段：y ∈ [0, wallHeight]，左右边界 |x| ≤ width/2；
 *  - 上部为圆拱段：圆心位于 (0, wallHeight)、半径 archRadius 的半圆弧；
 *  - 断面总高 = wallHeight + archRadius（即 profile.totalHeight）。
 */

/**
 * 判断点 (x, y) 是否在马蹄形断面内（可预留 margin，防止炮孔越洞周/穿底板）。
 * @param {Object} profile 断面轮廓 { width, wallHeight, archRadius }
 * @param {number} x 点横坐标 (m)
 * @param {number} y 点纵坐标 (m)，底板 y=0
 * @param {number} [margin=0] 内缩余量 (m)：直墙半宽与拱半径同时减去 margin
 * @param {number} [epsilon=0] 底板容差 (m)：y < -epsilon 才视为越过底板
 * @returns {boolean} 点是否位于断面内
 */
export function isInsideSection(profile, x, y, margin = 0, epsilon = 0) {
  if (y < -epsilon) return false // 不越过底板（掌子面底部 y=0）
  const halfW = profile.width / 2 - margin
  const Hw = profile.wallHeight
  const R = profile.archRadius - margin
  if (y <= Hw) return Math.abs(x) <= halfW
  const dx = x
  const dy = y - Hw
  return dx * dx + dy * dy <= R * R
}
