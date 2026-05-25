export const CLIPPING_AXES = ['X', 'Y', 'Z']
export const CLIPPING_DIRECTIONS = ['正向', '反向']

export const POLYGON_DIRECTION_OPTIONS = [
  { key: 'excavate', label: '挖掘' },
  { key: 'isolate', label: '保留' }
]

export const DEFAULT_POSITION_RANGE = {
  min: -2000,
  max: 2000,
  step: 0.5
}

export const DEFAULT_PLANE_UI = {
  distance: 0,
  rotation: { x: 0, y: 0, z: 0 },
  opacity: 0.3,
  color: '#ffffff',
  axis: 'X',
  direction: '正向'
}
