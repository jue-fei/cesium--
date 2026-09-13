// 碎片渲染数量上限。较旧的 3000 配合真实 KCO 粒径难以填足爆堆体积，
// 抬升至 4500 以减轻"崩落体积还原系数"的放大负担，同时空间散列碰撞 O(N)
// 在 4500 碎片下仍保持实时（三维平台不追求千万级颗粒）。
export const DEFAULT_FRAGMENT_RENDER_LIMIT = 4500

export const DEFAULT_TUNNEL_WIDTH = 18
export const DEFAULT_TUNNEL_WALL_HEIGHT = 6
export const DEFAULT_TUNNEL_ARCH_RADIUS = 9

export const DEFAULT_RESTITUTION = 0.15
export const DEFAULT_FRICTION = 0.7
export const DEFAULT_MAX_BOUNCES = 2

// 炮孔驱动模式（隧道全断面/台阶爆破实际使用）：
// 低恢复系数 + 高摩擦 + 少反弹，使岩块落点处就地堆积，避免沿底板滑散摊平爆堆。
export const ENHANCED_RESTITUTION = 0.2
export const ENHANCED_FRICTION = 0.72
export const ENHANCED_MAX_BOUNCES = 2

export function calcHorseshoeArea(width, wallHeight, archRadius) {
  return width * wallHeight + (Math.PI * archRadius * archRadius) / 2
}

export function calcCircularArea(archRadius) {
  return Math.PI * archRadius * archRadius
}

export function calcRectArea(width, wallHeight) {
  return width * wallHeight
}

export function calcTunnelArea(shape, width, wallHeight, archRadius) {
  switch (shape) {
    case 'circular':
      return calcCircularArea(archRadius)
    case 'rectangular':
      return calcRectArea(width, wallHeight)
    default:
      return calcHorseshoeArea(width, wallHeight, archRadius)
  }
}

export function toFiniteNumber(value, fallback = null) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

// ─── 动画时长判据（Worker 回放烘焙 / 渲染器直播实测两侧共用）────────────
// 背景：旧判据是"99% 碎片计数 FLAG_LANDED"。实测该计数在约 99.3% 处进入
// 平台期（约 0.7% 的边角石因贴合不良/反复滚动永不置位），真实布孔下 99%
// 可能永不达成 → 时长回退到硬上限，进度条虚长数倍（时间条远超真实事件）。
// 改为质量加权的"静止比"：LANDED，或速度低于 REST_SPEED 即视为已停稳，
// 该口径天然收敛到 1，不受平台期影响。

/** 静止速度阈值(m/s)：碎片速度低于此值即视为"肉眼静止" */
export const REST_SPEED = 1.0

/** 静止质量比阈值：≥ 该比例质量已停稳即视为爆堆成形（抛掷结束） */
export const SETTLE_REST_MASS_RATIO = 0.98

/** 抛掷结束后额外保持时长(s)：仅用于让观众看清爆堆成形 */
export const HOLD_AFTER_SETTLED = 1.5

/** 回放时长硬上限(s)：兜底防永不静止（真实事件约 3~6s） */
export const REPLAY_MAX_DURATION = 20
