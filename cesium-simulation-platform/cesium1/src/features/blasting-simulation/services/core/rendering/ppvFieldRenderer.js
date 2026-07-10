/**
 * PPV（峰值振动速度）场实时渲染器（阶段五）
 *
 * 在隧道截面上显示爆破振动的 PPV 分布，色标参考 GB6722-2014。
 *
 * Task 13 重构：不再在前端 GLSL 中重算萨道夫斯基公式，改为消费后端
 * /ppv-field 路由预计算的 2D PPV 场（Float32Array），通过 DataTexture
 * 上传至 GPU，Fragment Shader 仅做色标映射与距离渐隐。
 *
 * 调用方应先通过 blastingApi.fetchPPVField 获取
 * { nx, ny, gridX, gridY, ppv: Float32Array, maxPpv, meanPpv }，
 * 再将 { nx, ny, gridX, gridY, ppv } 传入 init 方法。
 */

import * as THREE from 'three'

// ─── safetyStandard 色标阈值定义（GB6722-2014）──────────────
// 每种标准 4 档阈值（cm/s）：t1 绿→黄, t2 黄→橙, t3 橙→红, t4 红→深紫
// t4 为红色区间渐变上限（超过 t3 后向深紫过渡的终点）
const SAFETY_THRESHOLDS = {
  // 一般建筑：允许振速 2.0-3.0 cm/s
  general_building: { t1: 1.0, t2: 2.0, t3: 3.0, t4: 6.0 },
  // 新浇混凝土：允许振速 1.0-2.0 cm/s
  new_concrete:     { t1: 0.5, t2: 1.0, t3: 2.0, t4: 4.0 },
  // 土窑洞/土房：允许振速 0.5-1.0 cm/s
  earth_cave:       { t1: 0.2, t2: 0.5, t3: 1.0, t4: 2.0 }
}

const DEFAULT_THRESHOLD = SAFETY_THRESHOLDS.general_building

// GB6722-2014 色标映射（GLSL 函数）—— 参数化阈值，支持 safetyStandard 切换
const VIBRATION_COLORMAP = /* glsl */ `
  // uThresholds = vec4(t1, t2, t3, t4)：绿→黄→橙→红→深紫
  vec3 ppvToColor(float ppv, vec4 t) {
    if (ppv < t.x) {
      return mix(vec3(0.0, 0.8, 0.0), vec3(0.8, 0.8, 0.0), clamp(ppv / t.x, 0.0, 1.0));
    } else if (ppv < t.y) {
      return mix(vec3(0.8, 0.8, 0.0), vec3(0.9, 0.5, 0.0), (ppv - t.x) / (t.y - t.x));
    } else if (ppv < t.z) {
      return mix(vec3(0.9, 0.5, 0.0), vec3(0.9, 0.1, 0.0), (ppv - t.y) / (t.z - t.y));
    }
    return mix(vec3(0.9, 0.1, 0.0), vec3(0.5, 0.0, 0.5), clamp((ppv - t.z) / (t.w - t.z), 0.0, 1.0));
  }
`

const PPV_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const PPV_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D ppvTexture;   // 后端 /ppv-field 返回的 PPV 场（RedFormat/FloatType）
  uniform vec4 uThresholds;       // safetyStandard 对应的色标阈值 (t1,t2,t3,t4)
  uniform vec3 uBlastCenter;      // 爆心世界坐标（用于距离渐隐）
  uniform float uMaxRadius;       // 最大显示半径（用于距离渐隐）
  uniform float uTimeDecay;       // 时间衰减因子
  varying vec2 vUv;
  varying vec3 vWorldPos;

  ${VIBRATION_COLORMAP}

  void main() {
    // 采样后端预计算的 PPV 场（不再在前端重算萨道夫斯基公式）
    float ppv = texture2D(ppvTexture, vUv).r;

    vec3 color = ppvToColor(ppv, uThresholds);
    // 透明度：PPV 越大越显眼，并随时间衰减
    float alpha = smoothstep(0.0, 1.5, ppv / uThresholds.z) * uTimeDecay;

    // 超出最大半径后渐隐
    float R = length(vWorldPos - uBlastCenter);
    float distFade = 1.0 - smoothstep(uMaxRadius * 0.8, uMaxRadius, R);
    alpha *= distFade * 0.55;

    gl_FragColor = vec4(color, alpha);
  }
`

export class PPVFieldRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(scene, camera) {
    this.scene = scene
    this.camera = camera

    /** @type {THREE.Mesh|null} */
    this.ppvMesh = null
    /** @type {THREE.ShaderMaterial|null} */
    this.ppvMaterial = null
    /** @type {THREE.DataTexture|null} */
    this.ppvTexture = null
    this._elapsed = 0
    this._maxDuration = 2.0  // PPV 场显示持续时间(s)
    this._visible = false
  }

  /**
   * 初始化 PPV 场渲染（消费后端 /ppv-field 数据）
   *
   * 调用方应先通过 blastingApi.fetchPPVField 获取
   * { nx, ny, gridX, gridY, ppv: Float32Array, maxPpv, meanPpv }，
   * 再将 { nx, ny, gridX, gridY, ppv } 传入本方法。
   *
   * @param {Object} params
   * @param {number} params.nx - x 方向网格数
   * @param {number} params.ny - y 方向网格数
   * @param {number[]} params.gridX - x 方向坐标数组（用于推算 plane 尺寸）
   * @param {number[]} params.gridY - y 方向坐标数组
   * @param {Float32Array} params.ppv - PPV 场数据，长度 = nx*ny
   * @param {('general_building'|'new_concrete'|'earth_cave')} [params.safetyStandard='general_building']
   * @param {{x:number,y:number,z:number}} [params.blastCenter={x:0,y:0,z:0}] - 爆心世界坐标
   * @param {{x:number,y:number,z:number}} [params.faceNormal={x:0,y:0,z:-1}] - 掌子面法向量
   * @param {number} [params.maxRadius=50] - 最大显示半径（距离渐隐用）
   */
  init(params = {}) {
    this.dispose()

    const {
      nx = 100, ny = 100,
      gridX = null, gridY = null,
      ppv = null,
      safetyStandard = 'general_building',
      blastCenter = { x: 0, y: 0, z: 0 },
      faceNormal = { x: 0, y: 0, z: -1 },
      maxRadius = 50
    } = params

    // ── 1. PPV 场数据 → DataTexture ──
    if (!ppv) {
      console.warn('[PPVFieldRenderer] init 缺少 ppv 数据，无法渲染')
      return
    }
    const texWidth = Math.max(1, nx)
    const texHeight = Math.max(1, ny)
    // 长度不匹配时按较小值裁剪，避免越界访问
    const expected = texWidth * texHeight
    let texData = ppv
    if (texData.length !== expected) {
      texData = ppv.subarray(0, expected)
    }
    const dataTexture = new THREE.DataTexture(
      texData,
      texWidth, texHeight,
      THREE.RedFormat, THREE.FloatType
    )
    // FloatType 纹理通常不支持线性过滤，使用 Nearest 避免黑屏
    dataTexture.minFilter = THREE.NearestFilter
    dataTexture.magFilter = THREE.NearestFilter
    dataTexture.wrapS = THREE.ClampToEdgeWrapping
    dataTexture.wrapT = THREE.ClampToEdgeWrapping
    dataTexture.needsUpdate = true
    this.ppvTexture = dataTexture

    // ── 2. 色标阈值（按 safetyStandard 选择）──
    const th = SAFETY_THRESHOLDS[safetyStandard] || DEFAULT_THRESHOLD

    // ── 3. plane 尺寸：优先由 gridX/gridY 范围推算，缺省回退到 maxRadius*2 ──
    let planeW = maxRadius * 2
    let planeH = maxRadius * 2
    if (Array.isArray(gridX) && gridX.length > 1) {
      planeW = Math.abs(gridX[gridX.length - 1] - gridX[0])
    }
    if (Array.isArray(gridY) && gridY.length > 1) {
      planeH = Math.abs(gridY[gridY.length - 1] - gridY[0])
    }
    planeW = Math.max(0.001, planeW)
    planeH = Math.max(0.001, planeH)

    const geo = new THREE.PlaneGeometry(planeW, planeH, 1, 1)
    this.ppvMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ppvTexture: { value: dataTexture },
        uThresholds: { value: new THREE.Vector4(th.t1, th.t2, th.t3, th.t4) },
        uBlastCenter: { value: new THREE.Vector3(blastCenter.x, blastCenter.y, blastCenter.z) },
        uMaxRadius: { value: maxRadius },
        uTimeDecay: { value: 1.0 }
      },
      vertexShader: PPV_VERTEX_SHADER,
      fragmentShader: PPV_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending
    })

    this.ppvMesh = new THREE.Mesh(geo, this.ppvMaterial)
    this.ppvMesh.position.set(blastCenter.x, blastCenter.y, blastCenter.z)
    // 面向掌子面法向量方向
    const normal = new THREE.Vector3(faceNormal.x, faceNormal.y, faceNormal.z).normalize()
    this.ppvMesh.lookAt(
      blastCenter.x + normal.x,
      blastCenter.y + normal.y,
      blastCenter.z + normal.z
    )
    this.ppvMesh.visible = false
    this.scene.add(this.ppvMesh)

    this._elapsed = 0
    this._maxDuration = 2.0
  }

  /**
   * 切换安全标准（运行时改变色标映射，无需重新创建纹理）
   * @param {('general_building'|'new_concrete'|'earth_cave')} safetyStandard
   */
  setSafetyStandard(safetyStandard) {
    const th = SAFETY_THRESHOLDS[safetyStandard] || DEFAULT_THRESHOLD
    if (this.ppvMaterial) {
      this.ppvMaterial.uniforms.uThresholds.value.set(th.t1, th.t2, th.t3, th.t4)
    }
  }

  /**
   * 每帧更新 PPV 场
   * @param {number} dt - 时间步长(s)
   */
  update(dt) {
    if (!this.ppvMaterial || !this.ppvMesh) return
    if (!this._visible) return

    this._elapsed += dt
    // 时间衰减：2秒内从 1.0 衰减到 0
    const timeDecay = Math.max(0, 1 - this._elapsed / this._maxDuration)
    this.ppvMaterial.uniforms.uTimeDecay.value = timeDecay

    if (this._elapsed > this._maxDuration) {
      this.ppvMesh.visible = false
      this._visible = false
    }
  }

  /** 显示 PPV 场（爆破触发时调用） */
  show() {
    if (this.ppvMesh) {
      this.ppvMesh.visible = true
      this._visible = true
      this._elapsed = 0
    }
  }

  /** 隐藏 PPV 场 */
  hide() {
    if (this.ppvMesh) {
      this.ppvMesh.visible = false
    }
    this._visible = false
  }

  /** 释放 GPU 资源 */
  dispose() {
    if (this.ppvMesh) {
      this.scene.remove(this.ppvMesh)
      this.ppvMesh.geometry.dispose()
      this.ppvMesh = null
    }
    if (this.ppvMaterial) {
      this.ppvMaterial.dispose()
      this.ppvMaterial = null
    }
    if (this.ppvTexture) {
      this.ppvTexture.dispose()
      this.ppvTexture = null
    }
    this._visible = false
  }
}

export default PPVFieldRenderer
