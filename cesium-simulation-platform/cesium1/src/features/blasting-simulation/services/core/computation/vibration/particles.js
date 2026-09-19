/**
 * 振动传播粒子系统（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * VibrationParticleSystem：粒子跟随波前扩散，增强可视化效果。
 */

/**
 * 振动传播粒子系统（粒子跟随波前扩散，增强可视化效果）
 * 每个粒子沿径向从爆心向外运动，速度接近纵波速度，存活时间与波前位置匹配
 */
export class VibrationParticleSystem {
  /**
   * @param {number} maxParticles - 最大粒子数
   */
  constructor(maxParticles = 500) {
    this.maxParticles = maxParticles
    this.particles = [] // { x, y, z, vx, vy, vz, birthT, lifetime, size, alpha }
    this._rng = Math.random
  }

  /**
   * 在爆心附近发射一批粒子，沿径向扩散
   * @param {number} t - 当前发射时间
   * @param {number} count - 发射数量
   * @param {number} _cp - 纵波速度(m/s)（未使用，保留用于API一致性）
   */
  emitBurst(t, count, _cp = 4500) {
    // 视觉速度：波前粒子用于可视化，与热力图波前可视速度（visualCp≈35m/s）匹配，
    // 使粒子始终跟随波前在视野内扩散，形成可见的振动传播效果。
    const visualSpeed = 35 + 15 * this._rng() // 35~50 m/s
    for (let i = 0; i < count && this.particles.length < this.maxParticles; i++) {
      // 均匀采样球面方向
      const theta = this._rng() * 2 * Math.PI
      const phi = Math.acos(2 * this._rng() - 1)
      const speed = visualSpeed * (0.8 + 0.4 * this._rng()) // 散射
      const vx = speed * Math.sin(phi) * Math.cos(theta)
      const vy = speed * Math.sin(phi) * Math.sin(theta)
      const vz = speed * Math.cos(phi)

      // 从爆心（原点）附近发射
      const r0 = 0.5 + 2 * this._rng() // 0.5~2.5m 初始半径
      const x0 = r0 * Math.sin(phi) * Math.cos(theta)
      const y0 = r0 * Math.sin(phi) * Math.sin(theta)
      const z0 = r0 * Math.cos(phi)

      this.particles.push({
        x: x0,
        y: y0,
        z: z0,
        vx,
        vy,
        vz,
        birthT: t,
        lifetime: 1.5 + 1.5 * this._rng(), // 存活 1.5~3s，覆盖整个体积盒扩散过程
        size: 3.0 + 8.0 * this._rng(), // 像素大小（点精灵）
        alpha: 0.6 + 0.4 * this._rng()
      })
    }
  }

  /**
   * 更新粒子位置，淘汰过期粒子
   * @param {number} t - 当前时间(s)
   * @param {number} dt - 时间步长(s)
   */
  update(t, dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      const age = t - p.birthT
      if (age > p.lifetime) {
        this.particles.splice(i, 1)
        continue
      }
      // 简单匀速运动（阻尼可忽略，粒子寿命很短）
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      // alpha 随年龄衰减
      p.alpha = (1 - age / p.lifetime) * p.alpha
    }
  }

  /** 清除所有粒子 */
  clear() {
    this.particles.length = 0
  }

  /** 获取当前活跃粒子 */
  get activeParticles() {
    return this.particles
  }
}
