/**
 * 隧道布孔设计通用工具函数（各 tunnelDesign 模块共享，避免重复定义）。
 */

/**
 * 数值规整：保留 1 位小数（四舍五入），用于炮孔坐标/方位角等布孔数值。
 * @param {number} v 待规整数值
 * @returns {number} 规整后的数值
 */
export function round1(v) {
  return Math.round(v * 10) / 10
}

/**
 * 弧度转角度。替代部分运行环境缺失的 Math.degrees（避免向全局 Math 挂载 polyfill）。
 * @param {number} rad 弧度值
 * @returns {number} 对应角度值
 */
export function toDegrees(rad) {
  return (rad * 180) / Math.PI
}
