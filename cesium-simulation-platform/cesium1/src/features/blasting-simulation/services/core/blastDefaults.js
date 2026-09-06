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
