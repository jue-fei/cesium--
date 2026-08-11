/**
 * 确定性伪随机数生成器（LCG）
 *
 * 全模块共享实现，避免在 blastPhysicsEngineWorker.js / blastPhysicsWorker.js /
 * rockGeometryFactory.js 中维护三份重复代码。
 *
 * 算法：线性同余生成器（Numerical Recipes 常数）
 *   s_{n+1} = (a · s_n + c) mod 2^32
 *   a = 1664525, c = 1013904223
 *   输出归一化到 [0, 1)
 *
 * 设计约束：
 *   - 纯 JavaScript 数值运算，无 Three.js 依赖（computation 层可安全引入）
 *   - 同一种子产生同一序列，保证碎片物理与几何变体可复现
 *   - 32 位无符号整数运算（`>>> 0` 强制截断），跨浏览器一致
 *
 * @param {number} seed - 非负整数种子（0 也是合法输入）
 * @returns {() => number} 返回 [0, 1) 区间浮点数的 RNG 函数
 */
export function makeRng(seed) {
  let s = (seed + 1) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
