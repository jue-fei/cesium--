/**
 * 振动波传播粒子特效渲染器
 *
 * 用 Three.js Points + 自定义 shader 渲染从爆心向外扩散的波前粒子，
 * 粒子位置由 VibrationParticleSystem（localVibrationSimulator.js）驱动，
 * 用于直观展示爆破振动传播 / 岩体位移的球面波过程。
 *
 * 坐标映射：粒子位于隧道局部坐标（X=宽度, Y=高度, Z=轴向前方，爆心为原点），
 * 渲染时通过 (center, right, up, forward) 基映射到世界坐标，与振动场 box 对齐。
 */
import * as THREE from 'three'

const MAX_PARTICLES = 600

// 圆点纹理（软边，避免锯齿方块）
function createDotTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.4, 'rgba(255,255,255,0.8)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  return texture
}

const PARTICLE_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;

void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uDotTexture;
varying float vAlpha;
varying vec3 vColor;

void main() {
  vec4 tex = texture2D(uDotTexture, gl_PointCoord);
  gl_FragColor = vec4(vColor, tex.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}
`

export class VibrationParticleRenderer {
  constructor(scene) {
    this.scene = scene
    this._group = null
    this._points = null
    this._positions = new Float32Array(MAX_PARTICLES * 3)
    this._sizes = new Float32Array(MAX_PARTICLES)
    this._alphas = new Float32Array(MAX_PARTICLES)
    this._colors = new Float32Array(MAX_PARTICLES * 3)

    // 坐标基（由 init 传入，与振动场 box 对齐）
    this._center = new THREE.Vector3()
    this._right = new THREE.Vector3(1, 0, 0)
    this._up = new THREE.Vector3(0, 1, 0)
    this._forward = new THREE.Vector3(0, 0, 1)

    this._visible = true
    this._enabled = true

    // 隧道断面约束参数（位置由 init 注入；用于把波前粒子限制在隧道内，不穿入岩体）
    this._section = {
      width: 10,
      wallHeight: 5,
      archRadius: 5,
      shape: 'horseshoe'
    }
  }

  /**
   * 初始化粒子系统（与振动场 init 同步调用）
   * @param {Object} opts - { center, right, up, forward, section? }
   */
  init(opts = {}) {
    this._center.copy(opts.center || new THREE.Vector3())
    if (opts.right) this._right.copy(opts.right)
    if (opts.up) this._up.copy(opts.up)
    if (opts.forward) this._forward.copy(opts.forward)
    if (opts.section) {
      const s = opts.section
      this._section = {
        width: s?.width ?? this._section.width,
        wallHeight: s?.wallHeight ?? this._section.wallHeight,
        archRadius: s?.archRadius ?? this._section.archRadius,
        shape: s?.shape ?? this._section.shape
      }
    }

    if (this._points) {
      this._group.visible = this._visible
      return
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this._positions, 3).setUsage(THREE.DynamicDrawUsage)
    )
    geometry.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this._sizes, 1).setUsage(THREE.DynamicDrawUsage)
    )
    geometry.setAttribute(
      'aAlpha',
      new THREE.BufferAttribute(this._alphas, 1).setUsage(THREE.DynamicDrawUsage)
    )
    geometry.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this._colors, 3).setUsage(THREE.DynamicDrawUsage)
    )

    const material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uDotTexture: { value: createDotTexture() }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })

    this._points = new THREE.Points(geometry, material)
    this._points.frustumCulled = false
    this._group = new THREE.Group()
    this._group.add(this._points)
    this._group.name = 'vibrationParticles'
    this._group.visible = this._visible
    this.scene.add(this._group)
  }

  /**
   * 每帧更新粒子（将局部坐标映射到世界坐标）
   * @param {Array} particles - VibrationParticleSystem 的活跃粒子
   */
  update(particles = []) {
    if (!this._points || !this._enabled) return
    const count = Math.min(particles.length, MAX_PARTICLES)
    for (let i = 0; i < count; i++) {
      const p = particles[i]
      // 把波前粒子约束在隧道断面内（局部坐标：X=横向, Y=竖向从洞底起, Z=沿隧道轴向），
      // 避免振动传播粒子穿过巷道壁渲染到岩体/巷道外。
      this._constrainToTunnel(p)
      // 局部 (x,y,z) → 世界 = center + x*right + y*up + z*forward
      const wx = this._center.x + p.x * this._right.x + p.y * this._up.x + p.z * this._forward.x
      const wy = this._center.y + p.x * this._right.y + p.y * this._up.y + p.z * this._forward.y
      const wz = this._center.z + p.x * this._right.z + p.y * this._up.z + p.z * this._forward.z
      this._positions[i * 3 + 0] = wx
      this._positions[i * 3 + 1] = wy
      this._positions[i * 3 + 2] = wz
      this._sizes[i] = p.size
      this._alphas[i] = Math.max(0, p.alpha)
      this._colors[i * 3 + 0] = 1.0
      this._colors[i * 3 + 1] = 0.75
      this._colors[i * 3 + 2] = 0.3
    }
    // 隐藏多余顶点（尺寸 0）
    for (let i = count; i < MAX_PARTICLES; i++) {
      this._sizes[i] = 0
      this._positions[i * 3 + 0] = 0
      this._positions[i * 3 + 1] = -9999
      this._positions[i * 3 + 2] = 0
    }
    const geo = this._points.geometry
    geo.attributes.position.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
    geo.attributes.aColor.needsUpdate = true
    geo.setDrawRange(0, MAX_PARTICLES)
  }

  /**
   * 把波前粒子局部坐标（X=横向, Y=竖向自洞底 0 起, Z=沿隧道轴向）约束在隧道断面内，
   * 粒子触碰巷道壁/底板沿壁滑动，不再穿入岩体或飘到巷道外。
   */
  _constrainToTunnel(p) {
    const s = this._section
    const halfW = s.width / 2
    const hw = s.wallHeight
    const R = s.archRadius
    const sv = 0.92 // 内缩安全系数，避免贴壁穿模

    // 横向侧墙约束
    const lxLimit = halfW * sv
    let lx = Math.max(-lxLimit, Math.min(lxLimit, p.x))

    // 底板约束（Y≥0，不穿地）
    let ly = Math.max(0, p.y)

    // 拱部/顶部约束
    if (s.shape === 'circular') {
      const cy = R
      const du = ly - cy
      const limit = R * sv
      const d = Math.hypot(lx, du)
      if (d > limit) {
        const k = limit / Math.max(1e-6, d)
        lx *= k
        ly = cy + du * k
      }
    } else if (s.shape === 'horseshoe' && ly > hw) {
      const du = ly - hw
      const limit = R * sv
      const d = Math.hypot(lx, du)
      if (d > limit) {
        const k = limit / Math.max(1e-6, d)
        lx *= k
        ly = hw + du * k
      }
    } else if (s.shape === 'rectangular') {
      ly = Math.min(hw * sv, ly)
    }

    p.x = lx
    p.y = ly
  }

  /** 清空粒子 */
  clear() {
    if (!this._points) return
    this._positions.fill(0)
    this._sizes.fill(0)
    this._alphas.fill(0)
    const geo = this._points.geometry
    geo.attributes.position.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
  }

  /** 启用/禁用（开关图层） */
  setEnabled(enabled) {
    this._enabled = !!enabled
    if (this._group) this._group.visible = this._visible && this._enabled
  }

  /** 显隐 */
  setVisible(visible) {
    this._visible = !!visible
    if (this._group) this._group.visible = this._visible && this._enabled
  }

  /** 释放资源 */
  dispose() {
    if (this._points) {
      this.scene.remove(this._group)
      this._points.geometry.dispose()
      this._points.material.dispose()
      this._points = null
      this._group = null
    }
  }
}
