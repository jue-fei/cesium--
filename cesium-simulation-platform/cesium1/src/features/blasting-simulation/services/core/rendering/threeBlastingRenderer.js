/**
 * Three.js 爆破粒子渲染器
 * 基于 GPU 粒子系统实现真实爆破效果：
 *  - 火球（膨胀消散 + 颜色渐变 + 闪烁）
 *  - 烟雾柱（蘑菇云 + 上升膨胀 + 湍流）
 *  - 火花（高速拖尾 + 重力衰减）
 *  - 岩石碎片（旋转 + 落地堆积）
 *  - 冲击波（球面扩散 + 透明度衰减）
 *
 * 该渲染器运行在独立的 three.js 场景中，通过 Cesium-Three 桥接器同步相机。
 *
 * 模块拆分：
 *  - SceneBuilder：场景光照、隧道/掌子面/岩体/钻孔/标注等场景元素
 *  - FragmentRenderer：碎片 InstancedMesh 的创建、更新与释放
 *  - rockGeometryFactory：岩石几何体池
 *  - BlastEffectManager：粒子特效（火焰/烟雾/火花/冲击波/粉尘）
 *  - BlastPhysicsEngineWorker：碎片物理引擎（Web Worker）
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { BlastPhysicsEngineWorker } from '../computation/blastPhysicsEngineWorker.js'
import { mulberry32 } from '../computation/blastPhysicsEngine.js'
import { generateFragmentSpecs } from './fragmentSpecGenerator.js'
import { BlastEffectManager } from './blastEffectManager.js'
import { DEFAULT_KCO_PARAMS, calculateKCOParams, sampleSwebrecSize } from '../computation/kcoModelCore.js'
import { JWL_PARAMS } from '../computation/blastConstants.js'
import { createRockGeometryPool } from './rockGeometryFactory.js'
import { SceneBuilder, createFireTexture, createSmokeTexture, createSparkTexture } from './sceneBuilder.js'
import { FragmentRenderer } from './fragmentRenderer.js'
import { DamageZoneRenderer } from './damageZoneRenderer.js'
import { PPVFieldRenderer } from './ppvFieldRenderer.js'
import { BlastAudioSynth } from './blastAudioSynth.js'

// ─── 粒子类型常量 ──────────────────────────────────────
export const THREE_PARTICLE_TYPES = {
  FIRE: 'fire',
  SMOKE: 'smoke',
  SPARK: 'spark',
  FRAGMENT: 'fragment',
  SHOCK_WAVE: 'shock_wave',
  DUST: 'dust'
}

// ─── 主渲染器 ─────────────────────────────────────────
// 注：旧 BlastParticle 类（含已知 bug 的 1-k·v²·dt 阻力公式）已删除，
// 碎片物理模拟改由独立的 BlastPhysicsEngine（core/computation/blastPhysicsEngine.js）处理
export class ThreeBlastingRenderer {
  constructor(container) {
    this.container = container
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000)
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false
    })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4))
    this.bloomEnabled = true
    this._initBloomComposer()
    this.container.appendChild(this.renderer.domElement)

    // 纹理
    this.textures = {
      fire: createFireTexture(),
      smoke: createSmokeTexture(),
      spark: createSparkTexture()
    }

    // 粒子组
    this.particleGroups = {
      [THREE_PARTICLE_TYPES.FIRE]: null,
      [THREE_PARTICLE_TYPES.SMOKE]: null,
      [THREE_PARTICLE_TYPES.SPARK]: null,
      [THREE_PARTICLE_TYPES.FRAGMENT]: null,
      [THREE_PARTICLE_TYPES.SHOCK_WAVE]: null,
      [THREE_PARTICLE_TYPES.DUST]: null
    }

    this.particles = []
    this.clock = new THREE.Clock()
    this.center = new THREE.Vector3(0, 0, 0)
    this.chargeKg = 100
    this.active = false
    // 粒子模拟时间（秒），由时间轴驱动
    this.simTime = 0
    // 爆破触发标志（掌子面损伤演化：爆破前掌子面完整，触发后碎石化飞出）
    this.blastTriggered = false
    this.blastTriggerTime = 0.1 // 起爆时刻（秒）
    // 保存最近一次 initBlast 参数，用于时间轴跳变时重建粒子
    this._lastBlastParams = null

    // 图层可见性开关（供 UI 切换烟雾/碎石/隧道/钻孔/标注等）
    // 粒子图层：与 THREE_PARTICLE_TYPES 对应；mesh 图层：tunnel/bench/face/blastHoles/annotations
    this.layerVisibility = {
      fire: true,
      smoke: true,
      spark: true,
      fragment: true,
      shock_wave: true,
      dust: true,
      tunnel: true,
      bench: true,
      face: true,
      blastHoles: true,
      annotations: true,
      // 新增可视化图层（默认关闭，不影响现有视觉）
      damageZone: false,    // 损伤区可视化（球壳+剖面切片）
      ppvField: false,      // PPV 振动速度场
      blockColor: false     // 碎石块度分区染色
    }

    // 掌子面/台阶几何参数（爆破方向参考）
    // 默认朝 -Z 方向（北）：与 BlastingManager.flyToCenter 中 heading=0（正北）的相机视线一致，
    // 保证初始视角直面掌子面。Cesium ENU 北 ↔ three.js -Z（见 cesiumThreeBridge 坐标映射）。
    this.faceDirection = new THREE.Vector3(0, 0, -1)
    this.facePosition = new THREE.Vector3(0, 0, 0) // 掌子面位置
    this.benchLength = 80 // 岩体深度(m)，增厚确保远距离仍为实心

    // 隧道断面参数（马蹄形：直墙 + 半圆拱，垂直于地面）
    // 尺寸放大至真实隧道规模，与碎片/烟雾比例协调
    this.tunnelWidth = 18 // 隧道宽度(m)
    this.tunnelWallHeight = 6 // 直墙高度(m)
    this.tunnelArchRadius = 9 // 拱部半径(m) = tunnelWidth/2
    this.tunnelHeight = this.tunnelWallHeight + this.tunnelArchRadius
    // T-02：参数化隧道断面（用于 setTunnelSection + fragmentSpecGenerator）
    this.tunnelSection = {
      width: this.tunnelWidth,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      shape: 'horseshoe'
    }
    // 兼容旧字段：碎片散布范围沿用隧道断面尺寸
    this.benchHeight = this.tunnelHeight
    this.benchWidth = this.tunnelWidth

    // 3D 岩石碎片几何体池
    this.rockGeometries = createRockGeometryPool()

    // 撞击飞溅粒子池（落地时激活）
    this.impactDustPool = []
    this.impactSparkPool = []
    this.impactChipPool = []

    // ── 子模块 ──
    this._sceneBuilder = new SceneBuilder(this.scene, {
      center: this.center,
      faceDirection: this.faceDirection,
      layerVisibility: this.layerVisibility,
      tunnelWidth: this.tunnelWidth,
      tunnelWallHeight: this.tunnelWallHeight,
      tunnelArchRadius: this.tunnelArchRadius,
      tunnelHeight: this.tunnelHeight,
      benchLength: this.benchLength,
      tunnelSection: this.tunnelSection
    })

    this._physicsEngine = new BlastPhysicsEngineWorker()
    this._randomSeed = null  // 当前物理引擎的随机种子（确定性模式：相同种子产生相同 bodyStates）
    this._fragmentRenderer = new FragmentRenderer(
      this.scene, this.rockGeometries, this._physicsEngine, this.layerVisibility
    )
    this._effectManager = new BlastEffectManager(this.scene, this.renderer)
    // 损伤区可视化渲染器（球壳+剖面切片，默认不可见，由 damageZone 图层开关控制）
    this._damageZoneRenderer = new DamageZoneRenderer(this.scene)
    // PPV 振动速度场渲染器（消费后端 /ppv-field 数据，默认不可见，由 ppvField 图层开关控制）
    this._ppvFieldRenderer = new PPVFieldRenderer(this.scene, this.camera)
    this._fragmentSpecs = null
    this._lastSpecGenParams = null

    // ── 阶段六：音效合成器（Web Audio API 延迟初始化） ──
    // 需在用户首次交互后调用 init() 才能创建 AudioContext（浏览器自动播放策略）
    this._audioSynth = new BlastAudioSynth()

    // 窗口大小调整
    this._resizeHandler = () => this.resize()
    window.addEventListener('resize', this._resizeHandler)

    // 初始化尺寸：同步 renderer/camera/bloomComposer 三者，修复初始渲染不高清 bug
    this.resize()
  }

  /**
   * 设置爆破方向（掌子面朝向）
   * @param {number} dx - 方向向量 X 分量
   * @param {number} dy - 方向向量 Y 分量
   * @param {number} dz - 方向向量 Z 分量
   */
  setFaceDirection(dx, dy, dz) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len > 0.001) {
      this.faceDirection.set(dx / len, dy / len, dz / len)
    }
  }

  /**
   * 设置爆心位置（three.js 局部坐标，单位：米）
   */
  setCenter(x, y, z) {
    this.center.set(x, y, z)
    // 火光位于掌子面处（爆心 + faceDirection*3）
    this._sceneBuilder.fireLight.position.copy(this.center).addScaledVector(this.faceDirection, 3)
  }

  setChargeKg(kg) {
    this.chargeKg = Math.max(1, kg)
  }

  /**
   * 初始化爆破粒子系统
   * @param {Object} params
   * @param {number} params.chargeKg - 装药量(kg)
   * @param {number} params.fragmentCount - 碎片数量
   */
  initBlast(params = {}) {
    this.clear()
    this._lastBlastParams = { ...params }
    // 确定性模式：randomSeed 变化时重建物理引擎，透传 randomSeed 到 BlastPhysicsEngineWorker
    const randomSeed = params.randomSeed ?? null
    if (randomSeed !== this._randomSeed) {
      this._randomSeed = randomSeed
      this._physicsEngine.dispose()
      this._physicsEngine = new BlastPhysicsEngineWorker(randomSeed != null ? { randomSeed } : {})
      this._fragmentRenderer.physicsEngine = this._physicsEngine
    }
    this.simTime = 0
    const chargeKg = params.chargeKg || this.chargeKg
    this.setChargeKg(chargeKg)

    // 设置爆破方向（如果提供了掌子面方向）
    if (params.faceDirection) {
      this.setFaceDirection(params.faceDirection.x, params.faceDirection.y, params.faceDirection.z)
    }

    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection

    // 构建爆破方向的局部坐标系（隧道轴向 = forward，爆破沿此方向推进）
    // 烟雾/粉尘在隧道内部应沿 forward 扩散，而非向上（顶板阻挡）
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    // 构建掌子面/台阶几何体
    this._sceneBuilder.buildBenchGeometry()
    const faceCenter = new THREE.Vector3().copy(this.center).addScaledVector(forward, 3)

    // 同步隧道内部补光
    this._sceneBuilder.updateTunnelLights(this.center, this.faceDirection, this.tunnelHeight)

    // 隧道截面边界（用于物理引擎碰撞检测）
    this._tunnelBounds = {
      right: right.clone(), forward: forward.clone(), center: this.center.clone(),
      halfWidth: this.tunnelWidth / 2, wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius, floorY: this.center.y
    }

    // ── 1. KCO 模型计算 ──
    const throwDir = forward.clone().negate()
    const kcoInput = { Q: chargeKg, ...(params.kcoParams || {}) }
    const kco = calculateKCOParams(kcoInput)

    // ── 2. 爆破粒子特效 ──
    this._effectManager.init({
      chargeKg,
      center: { x: faceCenter.x, y: faceCenter.y, z: faceCenter.z },
      throwDir: { x: throwDir.x, y: throwDir.y, z: throwDir.z },
      right: { x: right.x, y: right.y, z: right.z },
      up: { x: up.x, y: up.y, z: up.z },
      tunnelSection: { width: this.tunnelWidth, wallHeight: this.tunnelWallHeight, archRadius: this.tunnelArchRadius, shape: this.tunnelSection.shape },
      kcoOutput: { A: kco.A }
    })
    // 初始化后立即同步当前图层可见性（确保撞击扬尘等跟随用户之前的开关状态）
    for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
      this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
    }

    // ── 3. KCO 碎片规格生成 ──
    const faceDesc = {
      cx: faceCenter.x, cy: faceCenter.y, cz: faceCenter.z,
      nx: dir.x, ny: dir.y, nz: dir.z,
      rx: right.x, ry: right.y, rz: right.z,
      ux: up.x, uy: up.y, uz: up.z,
      width: this.tunnelWidth, wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius, shape: this.tunnelSection.shape
    }
    // 准备炮孔设计数据（供碎片规格生成器按孔分配碎片、驱动初速与延迟起爆）
    const holeSpecs = this._buildHoleSpecsForFragmentGen()

    const rng = this._randomSeed != null ? mulberry32(this._randomSeed) : Math.random
    // 碎片数量：体积驱动（量级匹配），数据导入时优先用 fragmentCount
    const volumePerRound = this._computeVolumePerRound()
    const { specs, positions, velocities } = generateFragmentSpecs({
      kco, face: faceDesc, chargeKg,
      targetCount: params.fragmentCount || undefined,
      volumePerRound,
      breakingRatio: 0.8,
      holes: holeSpecs,
      rng
    })
    this._fragmentSpecs = specs
    // 保存碎片初始数据，供 seekTo 异步快进时重新 init Worker
    this._lastFragmentData = { specs, positions, velocities }
    // 保存物理边界，供 seekToAsync 使用
    this._lastPhysicsBounds = {
      centerX: this.center.x, centerY: this.center.y, centerZ: this.center.z,
      rightX: right.x, rightY: right.y, rightZ: right.z,
      forwardX: forward.x, forwardY: forward.y, forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2, wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius, floorY: this.center.y,
      shape: this.tunnelSection.shape
    }

    // ── 4. 物理引擎初始化 ──
    this._physicsEngine.reset()
    this._physicsEngine.setTunnelBounds({
      centerX: this.center.x, centerY: this.center.y, centerZ: this.center.z,
      rightX: right.x, rightY: right.y, rightZ: right.z,
      forwardX: forward.x, forwardY: forward.y, forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2, wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius, floorY: this.center.y,
      shape: this.tunnelSection.shape
    })
    // 阶段二：配置 JWL 爆生气膨胀参数（使前 100ms 碎片获得持续推力）
    // chargeVolume = chargeKg / explosiveDensity，密度按炸药类型从 JWL_PARAMS 读取（替代硬编码 1200）
    const explosiveType = params.explosiveType || 'emulsion'
    const explosiveDensity = JWL_PARAMS[explosiveType]?.rho || JWL_PARAMS.emulsion.rho
    this._physicsEngine.setBlastConfig({
      blastCenterX: faceCenter.x,
      blastCenterY: faceCenter.y,
      blastCenterZ: faceCenter.z,
      chargeVolume: chargeKg / explosiveDensity,
      chargeLength: params.holeDepth || 3.0,
      explosiveType,
      throwDirX: throwDir.x,
      throwDirY: throwDir.y,
      throwDirZ: throwDir.z
    })
    this._physicsEngine.onBodyLanded = (body, impactSpeed) => {
      this._effectManager.spawnImpactDebris({ x: body.posX, y: body.posY, z: body.posZ }, impactSpeed)
      // 阶段六：碎片撞击音效（带限流合并）
      if (this._audioSynth) {
        this._audioSynth.playFragmentImpact({
          impactSpeed,
          fragmentSize: body.physSize
        })
      }
    }
    this._physicsEngine.init(specs, positions, velocities)

    // ── 5. 碎片 InstancedMesh ──
    this._fragmentRenderer.buildFragmentMesh(specs)

    // ── 6. 缓存参数 ──
    this._lastSpecGenParams = { kco, face: faceDesc, chargeKg, fragmentCount: specs.length }

    console.log('[ThreeBlastingRenderer] initBlast (新架构)', {
      specs: specs.length, kco: { Q: chargeKg, A: kco.A.toFixed(3), x50: kco.x50.toFixed(3), xmax: kco.xmax.toFixed(3), n: kco.n.toFixed(3), b: kco.b.toFixed(3) }
    })

    // ── 7. 损伤区可视化初始化（球壳+剖面切片，默认不可见） ──
    // 爆心位于掌子面处，faceDirection 指向岩体内部（爆破推进方向）
    this._damageZoneRenderer.init({
      chargeKg,
      explosiveDensity,
      VoD: params.VoD || 4500,
      rockUCS: params.rockUCS || 120e6,
      rockTensile: params.rockTensile || 10e6,
      blastCenter: { x: faceCenter.x, y: faceCenter.y, z: faceCenter.z },
      faceNormal: { x: dir.x, y: dir.y, z: dir.z }
    })

    // ── 8. 块度染色阈值（供 FragmentRenderer 按 physSize 分档染色） ──
    // x80 估算：Swebrec 分布中 x80 ≈ x50 × (1 + b^0.3)
    const estX80 = kco.x50 * (1 + Math.pow(Math.max(0.01, kco.b), 0.3))
    this._fragmentRenderer.setBlockColorThresholds({
      x50: kco.x50, x80: estX80, xmax: kco.xmax
    })

    // ── 9. 爆破前状态 ──
    this.blastTriggered = false
    this._fragmentRenderer.updateFragmentMesh()
    this.active = true
  }


  /**
   * 更新粒子模拟（新架构：物理引擎 + 特效管理器）
   */
  update(dt) {
    if (!this.active) return
    if (dt <= 0) return
    this.simTime += dt

    // 爆破触发
    if (!this.blastTriggered && this.simTime >= this.blastTriggerTime) {
      this._triggerBlast()
    }

    // 渐进破裂动画驱动（爆破触发后 0.5s 内）
    if (this.blastTriggered && this._sceneBuilder.fracturing) {
      this._sceneBuilder.updateFracture(this.simTime - this.blastTriggerTime)
    }

    // 物理引擎步进
    this._physicsEngine.step(dt)

    // 特效更新
    this._effectManager.update(dt)

    // PPV 振动场更新（时间衰减）
    if (this.layerVisibility.ppvField) {
      this._ppvFieldRenderer.update(dt)
    }

    // 火光同步（加 NaN 守卫，防止 fireIntensity 异常导致 intensity 永久 NaN）
    const fireLight = this._sceneBuilder.fireLight
    const fireIntensity = this._effectManager.getFireLightIntensity()
    if (Number.isFinite(fireIntensity)) {
      fireLight.intensity += (fireIntensity - fireLight.intensity) * 0.6
      if (fireLight.intensity < 0.01) fireLight.intensity = 0
    } else if (!Number.isFinite(fireLight.intensity)) {
      fireLight.intensity = 0
    }

    // 碎片 InstancedMesh 同步
    this._fragmentRenderer.updateFragmentMesh()

    this.renderFrame()
  }

  _triggerBlast() {
    this.blastTriggered = true
    this._sceneBuilder.triggerBlastProgressive(0.5)
    // 岩体不消失：真实爆破中掌子面后方的岩体仍然存在，仅表层破碎抛出
    this._physicsEngine.activateAll()

    // 阶段四：触发应力波传播（重置计时器 + 显示波环）
    this._effectManager.triggerStressWave()

    // 阶段六：触发爆破主音效（4 层合成：爆轰脉冲 + 低频轰鸣 + 岩石碎裂 + 后续撞击）
    if (this._audioSynth) {
      this._audioSynth.playBlastSound({
        chargeKg: this.chargeKg,
        distance: 30,  // 默认监听距离（相机距掌子面约 55m，此处取保守值 30m 增强临场感）
        explosiveType: (this._lastBlastParams && this._lastBlastParams.explosiveType) || 'emulsion'
      })
    }

    // 损伤区可视化：爆破触发后显示（若图层开启）
    if (this.layerVisibility.damageZone) {
      this._damageZoneRenderer.show()
    }
    // PPV 振动场：爆破触发后显示（若图层开启且已加载 PPV 数据）
    if (this.layerVisibility.ppvField) {
      this._ppvFieldRenderer.show()
    }
  }

  /**
   * 初始化音频上下文（需在用户首次交互时调用，如点击"播放"按钮）
   * 浏览器自动播放策略要求 AudioContext 必须由用户手势触发创建
   */
  initAudio() {
    if (this._audioSynth) {
      this._audioSynth.init()
    }
  }

  renderFrame() {
    if (this.bloomEnabled && this.bloomComposer) {
      this.bloomComposer.render()
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  _initBloomComposer() {
    this.bloomComposer = new EffectComposer(this.renderer)
    this.bloomComposer.setPixelRatio(this.renderer.getPixelRatio())
    const renderPass = new RenderPass(this.scene, this.camera)
    this.bloomComposer.addPass(renderPass)
    // 使用容器尺寸初始化 BloomPass，避免初始渲染分辨率错误（高清 bug 根因）
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    // 阶段七：HDR Bloom 参数优化
    // strength 0.6→1.5：增强火光/火花/应力波环的 bloom 辉光，匹配爆破场景高动态范围
    // radius 0.4：bloom 扩散半径（中等）
    // threshold 0.85：亮度阈值，只有火焰/火花/应力波环会被 bloom（暗部岩体不受影响）
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      1.5, 0.4, 0.85
    )
    this.bloomComposer.addPass(this.bloomPass)
    const outputPass = new OutputPass()
    this.bloomComposer.addPass(outputPass)
  }

  resize() {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this._applySize(width, height)
  }

  /**
   * 显式指定尺寸进行 resize（供 CesiumThreeBridge 用 Cesium canvas 尺寸同步）
   * 同步 renderer / camera.aspect / bloomComposer 三者，避免任一遗漏导致模糊或错位
   * @param {number} width
   * @param {number} height
   */
  resizeTo(width, height) {
    const w = Math.max(1, width || 0)
    const h = Math.max(1, height || 0)
    this._applySize(w, h)
  }

  _applySize(width, height) {
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.bloomComposer) {
      this.bloomComposer.setSize(width, height)
      // 同步 pixelRatio，防止 EffectComposer 渲染目标分辨率与 renderer 不一致导致模糊
      this.bloomComposer.setPixelRatio(this.renderer.getPixelRatio())
    }
  }

  /**
   * 将粒子系统定位到指定模拟时间（与时间轴同步）。
   * - 时间轴正常推进：增量更新粒子
   * - 时间轴暂停（targetTime ≈ simTime）：不更新，粒子静止
   * - 时间轴跳变（回退或大跨度前进）：异步重建并快进到 targetTime
   *
   * Web Worker 化后，跳变快进在 Worker 线程执行，主线程 UI 不卡顿。
   * 主线程同步快进特效（_effectManager），Worker 后台快进物理引擎，
   * Worker 完成后通过回调更新碎片 InstancedMesh。
   * @param {number} targetTime - 目标模拟时间（秒）
   */
  seekTo(targetTime) {
    if (!this.active) return
    const t = Math.max(0, Number(targetTime) || 0)
    const delta = t - this.simTime

    // 暂停或静止：不推进
    if (Math.abs(delta) < 0.001) return

    // 回退或大跨度前进（>0.5s，相当于跳变）：异步重建并快进
    if (delta < 0 || delta > 0.5) {
      this._asyncSeekTo(t)
      return
    }

    // 正常增量推进
    this.update(delta)
  }

  /**
   * 异步重建粒子系统并快进到指定时间（用于时间轴跳变）。
   *
   * 主线程：重建特效 + 同步快进 _effectManager 到 targetTime
   * Worker：后台 init + 循环 step 到 targetTime，完成后推送最终 bodyStates
   *
   * 快进期间碎片 InstancedMesh 暂不更新（Worker 未返回最终状态），
   * Worker 完成后立即渲染正确位置。
   */
  _asyncSeekTo(targetTime) {
    if (!this._lastBlastParams) return
    // 防止重复触发（用户连续拖动时间轴）
    if (this._physicsEngine.seekInProgress) return

    // 超时保护：Worker 回调丢失时 seekInProgress 会永久阻塞后续 seekTo
    // 设置 3 秒超时，超时后强制清除阻塞标志
    if (this._seekTimeout) clearTimeout(this._seekTimeout)
    this._seekTimeout = setTimeout(() => {
      if (this._physicsEngine && this._physicsEngine.seekInProgress) {
        console.warn('[ThreeBlastingRenderer] seekTo Worker 超时，强制清除阻塞标志')
        this._physicsEngine.seekInProgress = false
      }
      this._seekTimeout = null
    }, 3000)

    const params = this._lastBlastParams
    // 保存爆心与方向（initBlast 的 clear 不应改变它们，但显式保存更安全）
    const savedCenter = this.center.clone()
    const savedDir = this.faceDirection.clone()

    // initBlast 内部会 clear + 重新生成粒子 + 重置 simTime=0 + 重建特效
    // 物理引擎 init 会异步发送到 Worker（立即返回）
    this.initBlast(params)

    // 恢复爆心与方向（防止 initBlast 中 faceDirection 被覆盖）
    this.center.copy(savedCenter)
    this.faceDirection.copy(savedDir)

    // 主线程同步快进特效到 targetTime（特效不含物理，快进很快）
    const fireLight = this._sceneBuilder.fireLight
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    const maxSteps = 800
    let stepCount = 0
    while (remaining > 0 && stepCount < maxSteps) {
      const dt = Math.min(step, remaining)
      this.simTime += dt
      this._effectManager.update(dt)
      // 火光同步（加 NaN 守卫，与 update 方法一致）
      const fireIntensity = this._effectManager.getFireLightIntensity()
      if (Number.isFinite(fireIntensity)) {
        fireLight.intensity += (fireIntensity - fireLight.intensity) * 0.6
        if (fireLight.intensity < 0.01) fireLight.intensity = 0
      }
      remaining -= dt
      stepCount++
    }

    // Worker 异步快进物理引擎（后台 init + 循环 step）
    const { specs, positions, velocities } = this._lastFragmentData
    const bounds = this._lastPhysicsBounds
    this._physicsEngine.seekToAsync(targetTime, specs, positions, velocities, bounds, () => {
      // Worker 完成：清除超时定时器并渲染一帧
      if (this._seekTimeout) { clearTimeout(this._seekTimeout); this._seekTimeout = null }
      this._fragmentRenderer.updateFragmentMesh()
    })
  }

  /**
   * 同步相机参数（由 Cesium-Three 桥接器调用）
   * @param {THREE.Vector3} position - 相机位置
   * @param {THREE.Vector3} direction - 视线方向
   * @param {THREE.Vector3} up - 上方向
   * @param {number} fov - 视场角（度）
   * @param {number} aspect - 宽高比
   * @param {number} near - 近裁剪面
   * @param {number} far - 远裁剪面
   */
  syncCamera(position, direction, up, fov, aspect, near, far) {
    this.camera.fov = fov
    this.camera.aspect = aspect
    this.camera.near = near
    this.camera.far = far
    this.camera.position.copy(position)
    this.camera.up.copy(up)

    // 使用方向/上方向直接构造相机姿态，避免大坐标下 lookAt 的精度损失。
    const forward = direction.clone().normalize()
    const cameraZ = forward.clone().negate()
    const cameraX = new THREE.Vector3().crossVectors(up, cameraZ).normalize()
    const cameraY = new THREE.Vector3().crossVectors(cameraZ, cameraX).normalize()
    const rotationMatrix = new THREE.Matrix4().makeBasis(cameraX, cameraY, cameraZ)
    this.camera.quaternion.setFromRotationMatrix(rotationMatrix)
    this.camera.updateMatrixWorld(true)
    this.camera.updateProjectionMatrix()
  }

  setBloomEnabled(enabled) {
    this.bloomEnabled = !!enabled
  }

  setBloomParams(params = {}) {
    if (!this.bloomPass) return
    if (params.strength != null) this.bloomPass.strength = Math.max(0, Number(params.strength))
    if (params.radius != null) this.bloomPass.radius = Math.max(0, Number(params.radius))
    if (params.threshold != null) this.bloomPass.threshold = Math.max(0, Math.min(1, Number(params.threshold)))
  }

  clear() {
    for (const key of Object.keys(this.particleGroups)) {
      if (this.particleGroups[key]) {
        this.scene.remove(this.particleGroups[key])
        this.particleGroups[key].geometry?.dispose()
        this.particleGroups[key].material?.dispose()
        this.particleGroups[key] = null
      }
    }
    // 清理碎片
    this._fragmentRenderer.clear()
    // 清理场景网格（掌子面/岩体/隧道/钻孔/标注）
    this._sceneBuilder.clear()
    this.active = false
    this.simTime = 0
    this.blastTriggered = false
    // 清理新架构模块
    this._physicsEngine.reset()
    this._effectManager.clear()
    // 清理损伤区与 PPV 场可视化
    this._damageZoneRenderer.dispose()
    this._ppvFieldRenderer.dispose()
    this._fragmentSpecs = null
    this._lastSpecGenParams = null
  }

  dispose() {
    this.clear()
    window.removeEventListener('resize', this._resizeHandler)
    Object.values(this.textures).forEach(tex => tex.dispose())
    this._fragmentRenderer.dispose()
    this.rockGeometries.forEach(g => g.dispose())
    this.rockGeometries = []
    this._sceneBuilder.dispose()
    this._effectManager.dispose()
    // 释放 Worker 资源，避免内存泄漏
    this._physicsEngine.dispose()
    // 释放音频资源
    if (this._audioSynth) {
      this._audioSynth.dispose()
      this._audioSynth = null
    }
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }

  getStats() {
    return {
      total: this._physicsEngine.bodies.length,
      alive: this._physicsEngine.aliveFragmentCount,
      landed: this._physicsEngine.landedFragmentCount
    }
  }

  setTunnelSection(section = {}) {
    if (!section || typeof section !== 'object') return
    // 同步更新 SceneBuilder 中的隧道参数
    this._sceneBuilder.setTunnelSection(section)
    // 同步本地隧道参数
    this.tunnelSection = this._sceneBuilder.tunnelSection
    this.tunnelWidth = this._sceneBuilder.tunnelWidth
    this.tunnelWallHeight = this._sceneBuilder.tunnelWallHeight
    this.tunnelArchRadius = this._sceneBuilder.tunnelArchRadius
    this.tunnelHeight = this._sceneBuilder.tunnelHeight
    this.benchHeight = this.tunnelHeight
    this.benchWidth = this.tunnelWidth
    this.benchLength = this._sceneBuilder.benchLength
    if (this.facePosition) this._sceneBuilder.buildBenchGeometry()
  }

  /**
   * 注入数据库炮孔设计数据与其他爆破设计参数
   * 调用后 _buildBlastHoles 将优先使用数据库数据动态渲染钻孔布局
   * @param {Array} holes - 数据库炮孔设计数组（来自 dataset.design.holes）
   * @param {Object} [designParams] - 其他爆破设计参数（来自 dataset.design.designParams）
   */
  setBlastHoleDesign(holes, designParams = null) {
    this._sceneBuilder.blastHoleDesign = Array.isArray(holes) ? holes : null
    if (designParams && typeof designParams === 'object') {
      this._sceneBuilder.designParams = designParams
    }
  }

  /** 清除数据库炮孔设计数据，回退到硬编码布局 */
  clearBlastHoleDesign() {
    this._sceneBuilder.blastHoleDesign = null
    this._sceneBuilder.designParams = null
  }

  /**
   * 构建用于碎片规格生成器的炮孔数据
   * 从 blastHoleDesign 提取 posX/posY/chargeKg/delayMs/isEmptyHole，
   * 转换为 fragmentSpecGenerator 需要的 {x, y, chargeKg, delayMs, isEmpty} 格式
   * @returns {Array<Object>|null}
   */
  _buildHoleSpecsForFragmentGen() {
    const blastHoleDesign = this._sceneBuilder.blastHoleDesign
    if (!Array.isArray(blastHoleDesign) || blastHoleDesign.length === 0) {
      return null
    }
    return blastHoleDesign.map(h => ({
      x: Number(h.posX) || 0,
      y: Number(h.posY) || 0,
      chargeKg: Number(h.chargeKg) || 0,
      delayMs: Number(h.delayMs) || 0,
      isEmpty: !!h.isEmptyHole
    }))
  }

  /**
   * 注入爆破效果数据（表2：超欠挖/爆破漏斗/最大抛掷距离/半孔率等）
   * 存储后可在渲染时用于：漏斗坑可视化（craterDepth/craterRadius）、
   * 周边孔半孔率标注（halfHoleRatio）、碎块尺寸（fragmentX50）等
   * @param {Object} effect - 来自 dataset.design.blastEffect
   */
  setBlastEffect(effect) {
    this._sceneBuilder.blastEffect = effect || null
  }

  setLayerVisible(layer, visible) {
    if (!this.layerVisibility || !(layer in this.layerVisibility)) return
    this.layerVisibility[layer] = !!visible
    this._applyLayerVisibility(layer)
  }

  /** 批量设置多个图层可见性 */
  setLayersVisible(map = {}) {
    for (const [layer, vis] of Object.entries(map)) {
      if (this.layerVisibility && layer in this.layerVisibility) {
        this.layerVisibility[layer] = !!vis
        this._applyLayerVisibility(layer)
      }
    }
  }

  /** 将指定图层的可见性应用到对应 Three.js 对象 */
  _applyLayerVisibility(layer) {
    const visible = this.layerVisibility[layer]
    // 粒子图层：委托给 BlastEffectManager
    if (['fire', 'smoke', 'spark', 'dust', 'shock_wave'].includes(layer)) {
      this._effectManager.setVisible(layer, visible)
    }
    // 碎片图层：委托给 FragmentRenderer
    if (layer === 'fragment') {
      this._fragmentRenderer.applyLayerVisibility(visible)
    }
    // 场景网格图层：委托给 SceneBuilder
    if (['tunnel', 'bench', 'face', 'blastHoles', 'annotations'].includes(layer)) {
      this._sceneBuilder.applyLayerVisibility(layer, visible, this.blastTriggered)
    }
    // 损伤区图层：委托给 DamageZoneRenderer
    if (layer === 'damageZone' && this._damageZoneRenderer) {
      this._damageZoneRenderer.setVisible(visible)
    }
    // PPV 振动场图层：委托给 PPVFieldRenderer
    if (layer === 'ppvField' && this._ppvFieldRenderer) {
      if (visible) this._ppvFieldRenderer.show()
      else this._ppvFieldRenderer.hide()
    }
    // 块度染色图层：委托给 FragmentRenderer
    if (layer === 'blockColor') {
      this._fragmentRenderer.applyBlockColorMode(visible)
    }
  }

  /** 获取当前所有图层可见性状态（供 UI 回显） */
  getLayerVisibility() {
    return { ...this.layerVisibility }
  }

  // ─── 爆破效果评价：数据获取 + 联动高亮 API ──────────────────

  /**
   * 获取损伤区半径数据（供 UI 显示）
   * @returns {{crushedZoneRadius:number, fracturedZoneRadius:number, elasticZoneStart:number}|null}
   */
  getDamageZones() {
    return this._damageZoneRenderer?.getZones() || null
  }

  /**
   * 联动高亮：高亮指定损伤区（球壳 + 区域内碎石），其他变暗
   * @param {'crushed'|'fractured'|'elastic'|null} zone
   */
  highlightDamageZone(zone) {
    // 1. 球壳高亮（现有）
    this._damageZoneRenderer?.highlightZone(zone)

    // 2. 联动碎片按半径高亮（新增）
    if (!zone) {
      this._fragmentRenderer?.highlightByZone(null)
      return
    }
    const center = this._damageZoneRenderer?.getBlastCenter?.()
    const zones = this._damageZoneRenderer?.getZones?.()
    if (!center || !zones) return

    let radius, colorHex
    if (zone === 'crushed') {
      radius = zones.crushedZoneRadius
      colorHex = 0xff3030  // 红（与粉碎区球壳一致）
    } else if (zone === 'fractured') {
      radius = zones.fracturedZoneRadius
      colorHex = 0xff8c00  // 橙（与裂隙区球壳一致）
    } else {
      // elastic: 用弹性区外半径（fracturedRadius * 1.3）
      radius = this._damageZoneRenderer?.getElasticRadius?.() || zones.fracturedZoneRadius * 1.3
      colorHex = 0x30ff30  // 绿
    }
    this._fragmentRenderer?.highlightByZone(
      { x: center.x, y: center.y, z: center.z }, radius, colorHex
    )
  }

  /**
   * 联动高亮：高亮指定块度等级的碎片（可多选），未选中保持原色
   * @param {('large'|'medium'|'small')[]|'large'|'medium'|'small'|null} classes - 数组/单值/null(取消)
   */
  highlightBlockClass(classes) {
    this._fragmentRenderer?.highlightBlockClass(classes)
  }

  /**
   * 设置 PPV 振动场数据（由 blastingManager 调用 blastingApi.fetchPPVField 后传入）
   * @param {{nx:number, ny:number, gridX:number[], gridY:number[], ppv:Float32Array, maxPpv:number, meanPpv:number}} data
   * @param {Object} [opts] - { safetyStandard, blastCenter, faceNormal, maxRadius }
   */
  setPPVFieldData(data, opts = {}) {
    this._ppvFieldRenderer.init({
      nx: data.nx, ny: data.ny,
      gridX: data.gridX, gridY: data.gridY,
      ppv: data.ppv,
      safetyStandard: opts.safetyStandard || 'general_building',
      blastCenter: opts.blastCenter || { x: this.center.x, y: this.center.y, z: this.center.z },
      faceNormal: opts.faceNormal || { x: this.faceDirection.x, y: this.faceDirection.y, z: this.faceDirection.z },
      maxRadius: opts.maxRadius || 50
    })
    this._ppvFieldStats = { maxPpv: data.maxPpv, meanPpv: data.meanPpv }
  }

  /** 获取 PPV 场统计（maxPpv/meanPpv，需先 setPPVFieldData） */
  getPPVFieldStats() {
    return this._ppvFieldStats || null
  }

  /** 切换 PPV 色标安全标准（运行时） */
  setSafetyStandard(std) {
    this._ppvFieldRenderer?.setSafetyStandard(std)
  }

  /**
   * 计算爆破效果统计（最远抛掷距离、平均抛掷距离、碎片数量等）
   * 从物理引擎当前 bodyStates 读取
   * @returns {{throwDistanceMax:number, throwDistanceAvg:number, fragmentCount:number, landedCount:number}|null}
   */
  getBlastEffectStats() {
    const bodyStates = this._physicsEngine.getBodyStates?.()
    if (!bodyStates || bodyStates.length === 0) return null
    const cx = this.center.x, cy = this.center.y, cz = this.center.z
    let maxDist = 0, sumDist = 0, count = 0, landed = 0
    for (const b of bodyStates) {
      if (!b.alive) continue
      count++
      const dx = b.posX - cx, dz = b.posZ - cz
      const dist = Math.sqrt(dx * dx + dz * dz)  // 水平抛掷距离
      if (dist > maxDist) maxDist = dist
      sumDist += dist
      if (b.landed) landed++
    }
    return {
      throwDistanceMax: maxDist,
      throwDistanceAvg: count > 0 ? sumDist / count : 0,
      fragmentCount: count,
      landedCount: landed
    }
  }

  /**
   * 联动：相机飞到最远碎片位置（点击"最大抛掷距离"时调用）
   * 通过返回最远碎片坐标，由 blastingManager/cesiumThreeBridge 执行实际相机飞行
   * @returns {{x,y,z}|null}
   */
  getFarthestFragmentPosition() {
    const bodyStates = this._physicsEngine.getBodyStates?.()
    if (!bodyStates || bodyStates.length === 0) return null
    const cx = this.center.x, cz = this.center.z
    let maxDist = -1, pos = null
    for (const b of bodyStates) {
      if (!b.alive) continue
      const dx = b.posX - cx, dz = b.posZ - cz
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > maxDist) { maxDist = dist; pos = { x: b.posX, y: b.posY, z: b.posZ } }
    }
    return pos
  }

  /**
   * 计算单循环爆破方量（用于碎片数量体积驱动）
   * 直接使用隧道断面参数，不依赖 blastHolePattern（可能未初始化）
   * @returns {number} 单循环爆破方量(m³)
   */
  _computeVolumePerRound() {
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const dp = (this._sceneBuilder && this._sceneBuilder.designParams) || {}
    const holeDepth = Number(dp.holeDepth) || 2.5
    const utilization = Number(dp.utilization) || 0.85
    const advanceDepth = Number(dp.advanceLength) || (holeDepth * utilization)
    return sectionArea * advanceDepth
  }

  /**
   * 获取爆破设计数据（供 UI 展示炮孔布置图与统计）
   * @returns {object|null} 包含炮孔布置、统计、装药参数等
   */
  getBlastDesign() {
    const blastHolePattern = this._sceneBuilder.blastHolePattern
    if (!blastHolePattern) return null
    const p = blastHolePattern
    const dp = this._sceneBuilder.designParams || {}
    const W = p.section.W
    const Hw = p.section.Hw
    const R = p.section.R
    const totalH = p.section.totalH
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const holeDepth = Number(dp.holeDepth) || 2.5
    const utilization = Number(dp.utilization) || 0.85
    const advanceDepth = Number(dp.advanceLength) || (holeDepth * utilization)
    const volumePerRound = sectionArea * advanceDepth // 单循环爆破方量(m³)
    const chargeDensityCut = Number(dp.chargeDensityCut) || 1.2
    const chargeDensityAux = Number(dp.chargeDensityAux) || 1.0
    const chargeDensityPerim = Number(dp.chargeDensityPerim) || 0.7
    const cutCharge = p.counts.cut * holeDepth * chargeDensityCut
    const auxCharge = p.counts.auxiliary * holeDepth * chargeDensityAux
    const perimCharge = p.counts.perimeter * holeDepth * chargeDensityPerim
    const totalCharge = cutCharge + auxCharge + perimCharge
    const specificCharge = totalCharge / volumePerRound // 炸药单耗 kg/m³
    return {
      section: { W, Hw, R, totalH, area: sectionArea },
      holeDepth,
      utilization,
      advanceDepth,
      volumePerRound,
      counts: p.counts,
      holes: p.holes,
      charge: {
        cut: cutCharge,
        auxiliary: auxCharge,
        perimeter: perimCharge,
        total: totalCharge,
        specific: specificCharge
      }
    }
  }
}
