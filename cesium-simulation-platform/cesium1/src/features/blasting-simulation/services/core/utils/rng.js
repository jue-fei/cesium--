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

/**
 * 确定性伪随机数生成器（mulberry32）
 *
 * 与上方 LCG 并存的第二种实现：早期在 sceneBuilder（漏斗形状）与
 * kcoModelCore.massWeighted 测试中各自内联一份，现收归此单源。
 * 两份副本的字节码完全一致，替换不改变任何已有几何/测试结果。
 *
 * @param {number} seed - 32 位种子
 * @returns {() => number} 返回 [0, 1) 区间浮点数的 RNG 函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
