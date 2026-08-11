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
import { generateFragmentSpecs } from './fragmentSpecGenerator.js'
import { BlastEffectManager } from './blastEffectManager.js'
import { KCO_SOURCE_MODE, calculateKCOParams } from '../computation/kcoModelCore.js'
import { createRockGeometryPool } from './rockGeometryFactory.js'
import {
  SceneBuilder,
  createFireTexture,
  createSmokeTexture,
  createSparkTexture
} from './sceneBuilder.js'
import { FragmentRenderer } from './fragmentRenderer.js'
import { BlastVibrationFieldRenderer } from './blastVibrationFieldRenderer.js'

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
      // PPV 振动场体积（实时推送的动态热力图）
      vibrationField: true
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
    this._fragmentRenderer = new FragmentRenderer(
      this.scene,
      this.rockGeometries,
      this._physicsEngine,
      this.layerVisibility
    )
    this._effectManager = new BlastEffectManager(this.scene, this.renderer)
    // PPV 振动场体积渲染器（Data3DTexture + GLSL raymarching）
    // 在收到首个 PPV 二进制帧时按需 init，故此处仅创建实例
    this._vibrationFieldRenderer = new BlastVibrationFieldRenderer(this.scene)
    this._fragmentSpecs = null
    this._lastSpecGenParams = null
    this._fragmentStats = null

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
    this.simTime = 0
    const chargeKg = params.chargeKg || this.chargeKg
    this.setChargeKg(chargeKg)

    // 性能模式：设置碎片间碰撞开关
    if (params.enableInterCollision !== undefined && this._physicsEngine?.setEnableInterCollision) {
      this._physicsEngine.setEnableInterCollision(params.enableInterCollision)
    }

    // 设置爆破方向（如果提供了掌子面方向）
    if (params.faceDirection) {
      this.setFaceDirection(params.faceDirection.x, params.faceDirection.y, params.faceDirection.z)
    }

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
      right: right.clone(),
      forward: forward.clone(),
      center: this.center.clone(),
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y
    }

    // ── 1. KCO 模型计算 ──
    const throwDir = forward.clone().negate()
    const kcoInput = {
      Q: chargeKg,
      sourceMode: params.kcoParams?.sourceMode || KCO_SOURCE_MODE.DESIGN,
      ...(params.kcoParams || {})
    }
    const kco = calculateKCOParams(kcoInput)

    // ── 2. 爆破粒子特效 ──
    this._lastEffectParams = {
      chargeKg,
      center: { x: faceCenter.x, y: faceCenter.y, z: faceCenter.z },
      throwDir: { x: throwDir.x, y: throwDir.y, z: throwDir.z },
      right: { x: right.x, y: right.y, z: right.z },
      up: { x: up.x, y: up.y, z: up.z },
      tunnelSection: {
        width: this.tunnelWidth,
        wallHeight: this.tunnelWallHeight,
        archRadius: this.tunnelArchRadius,
        shape: this.tunnelSection.shape
      },
      kcoOutput: { A: kco.A }
    }
    this._effectManager.init(this._lastEffectParams)
    // 初始化后立即同步当前图层可见性（确保撞击扬尘等跟随用户之前的开关状态）
    for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
      this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
    }

    // ── 3. KCO 碎片规格生成 ──
    const faceDesc = {
      cx: faceCenter.x,
      cy: faceCenter.y,
      cz: faceCenter.z,
      nx: dir.x,
      ny: dir.y,
      nz: dir.z,
      rx: right.x,
      ry: right.y,
      rz: right.z,
      ux: up.x,
      uy: up.y,
      uz: up.z,
      width: this.tunnelWidth,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      shape: this.tunnelSection.shape
    }
    // 准备炮孔设计数据（供碎片规格生成器按孔分配碎片、驱动初速与延迟起爆）
    const holeSpecs = this._buildHoleSpecsForFragmentGen()

    const {
      specs,
      positions,
      velocities,
      stats: generationStats
    } = generateFragmentSpecs({
      kco,
      face: faceDesc,
      chargeKg,
      targetCount: params.fragmentCountTarget || chargeKg * 0.5,
      countLimit: params.fragmentCountRenderLimit || 320,
      holes: holeSpecs,
      metrics: params.generationMetrics || {},
      randomSeed: params.randomSeed
    })
    this._fragmentSpecs = specs
    this._fragmentStats = {
      fragmentCountTarget:
        generationStats?.fragmentCountTarget ??
        Math.max(40, Math.floor(params.fragmentCountTarget || chargeKg * 0.5)),
      fragmentCountGenerated: specs.length,
      fragmentCountRenderLimit: Math.max(40, Number(params.fragmentCountRenderLimit) || 320),
      kcoSourceMode: kco.sourceMode,
      x50Applied: kco.x50,
      nApplied: kco.n,
      x50Computed: kco.computedX50,
      nComputed: kco.computedN,
      fragmentMassTargetKg: generationStats?.fragmentMassTargetKg ?? null,
      fragmentMassGeneratedKg: generationStats?.fragmentMassGeneratedKg ?? null,
      fragmentMassCoverage: generationStats?.fragmentMassCoverage ?? null,
      velocityMean: generationStats?.velocityMean ?? null,
      velocityP95: generationStats?.velocityP95 ?? null,
      throwDistancePredictedAvg: generationStats?.throwDistancePredictedAvg ?? null,
      throwDistancePredictedMax: generationStats?.throwDistancePredictedMax ?? null,
      throwDistanceTargetAvg: generationStats?.throwDistanceTargetAvg ?? null,
      throwDistanceTargetMax: generationStats?.throwDistanceTargetMax ?? null,
      velocityScaleApplied: generationStats?.velocityScaleApplied ?? 1,
      sizeHistogramGenerated: generationStats?.sizeHistogramGenerated ?? null,
      sizeHistogramTarget: generationStats?.sizeHistogramTarget ?? null,
      sizeKLDivergence: generationStats?.sizeKLDivergence ?? null,
      velocityHistogramGenerated: generationStats?.velocityHistogramGenerated ?? null
    }
    // 保存碎片初始数据，供 seekTo 异步快进时重新 init Worker
    this._lastFragmentData = { specs, positions, velocities }
    // 保存物理边界，供 seekToAsync 使用
    this._lastPhysicsBounds = {
      centerX: this.center.x,
      centerY: this.center.y,
      centerZ: this.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y,
      shape: this.tunnelSection.shape
    }

    // ── 4. 物理引擎初始化 ──
    this._physicsEngine.reset()
    this._physicsEngine.setTunnelBounds({
      centerX: this.center.x,
      centerY: this.center.y,
      centerZ: this.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y,
      shape: this.tunnelSection.shape
    })
    this._physicsEngine.onBodyLanded = (body, impactSpeed) => {
      this._effectManager.spawnImpactDebris(
        { x: body.posX, y: body.posY, z: body.posZ },
        impactSpeed
      )
    }
    this._physicsEngine.init(specs, positions, velocities, { randomSeed: params.randomSeed })

    // ── 5. 碎片 InstancedMesh ──
    this._fragmentRenderer.buildFragmentMesh(specs)

    // ── 6. 缓存参数 ──
    this._lastSpecGenParams = { kco, face: faceDesc, chargeKg, fragmentCount: specs.length }

    console.log('[ThreeBlastingRenderer] initBlast (新架构)', {
      specs: specs.length,
      kco: {
        Q: chargeKg,
        A: kco.A.toFixed(3),
        x50: kco.x50.toFixed(3),
        xmax: kco.xmax.toFixed(3),
        n: kco.n.toFixed(3),
        b: kco.b.toFixed(3)
      }
    })

    // ── 7. 爆破前状态 ──
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

    // 物理引擎步进
    this._physicsEngine.step(dt)

    // 特效更新
    this._effectManager.update(dt)

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
    this._sceneBuilder.triggerBlast()
    // 岩体不消失：真实爆破中掌子面后方的岩体仍然存在，仅表层破碎抛出
    this._physicsEngine.activateAll()
  }

  renderFrame() {
    // 振动场 raymarching 需要相机在 box 局部系下的位置作为射线起点
    if (this._vibrationFieldRenderer?.hasField) {
      this._vibrationFieldRenderer.updateCamera(this.camera)
    }
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
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.85)
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
    // 防止重复触发（用户连续拖动时间轴）。
    // _seekBlocked 覆盖 RAF 特效快进阶段；seekInProgress 覆盖 Worker 物理快进阶段。
    if (this._physicsEngine.seekInProgress || this._seekBlocked) return

    // 超时保护：RAF 回调丢失或 Worker 回调丢失时，阻塞标志会永久阻塞后续 seekTo。
    // 设置 3 秒超时，超时后强制清除阻塞标志并取消未完成的 RAF。
    if (this._seekTimeout) clearTimeout(this._seekTimeout)
    this._seekTimeout = setTimeout(() => {
      if (this._seekRafId) {
        cancelAnimationFrame(this._seekRafId)
        this._seekRafId = null
      }
      this._seekBlocked = false
      if (this._physicsEngine && this._physicsEngine.seekInProgress) {
        console.warn('[ThreeBlastingRenderer] seekTo Worker 超时，强制清除阻塞标志')
        this._physicsEngine.seekInProgress = false
      }
      this._seekTimeout = null
    }, 3000)

    // 不调用 initBlast（避免 clear 清除碎片 InstancedMesh 导致快进期间碎片消失）。
    // 只重置特效到 t=0 并快进，碎片保持当前位置，Worker 快进完成后更新到目标位置。
    this.simTime = 0
    if (this._lastEffectParams) {
      this._effectManager.clear()
      this._effectManager.init(this._lastEffectParams)
      for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
        this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
      }
    }

    // 主线程分块快进特效到 targetTime（requestAnimationFrame，避免长循环阻塞主线程）。
    // 特效不含物理，单步 0.05s；每帧最多执行 STEPS_PER_FRAME 步（约 16ms 工作量），
    // 剩余步骤在下一帧 requestAnimationFrame 回调中继续，完成后移交 Worker 物理快进。
    const fireLight = this._sceneBuilder.fireLight
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    const maxSteps = 800
    let stepCount = 0
    const STEPS_PER_FRAME = 16

    // 标记 RAF 阶段进行中，阻止此期间再次进入 _asyncSeekTo
    this._seekBlocked = true

    // 特效快进完成后启动 Worker 物理快进（保留原有 seekToAsync 调用与回调）
    const startWorkerSeek = () => {
      this._seekBlocked = false
      // Worker 异步快进物理引擎（后台 init + 循环 step）
      const { specs, positions, velocities } = this._lastFragmentData
      const bounds = this._lastPhysicsBounds
      this._physicsEngine.seekToAsync(targetTime, specs, positions, velocities, bounds, () => {
        // Worker 完成：清除超时定时器并渲染一帧
        if (this._seekTimeout) {
          clearTimeout(this._seekTimeout)
          this._seekTimeout = null
        }
        this._fragmentRenderer.updateFragmentMesh()
      })
    }

    const tick = () => {
      this._seekRafId = null
      // 每帧最多执行 STEPS_PER_FRAME 步，避免单帧工作量过大阻塞主线程
      let frameSteps = 0
      while (remaining > 0 && stepCount < maxSteps && frameSteps < STEPS_PER_FRAME) {
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
        frameSteps++
      }

      if (remaining > 0 && stepCount < maxSteps) {
        // 还有剩余步骤，下一帧继续
        this._seekRafId = requestAnimationFrame(tick)
      } else {
        // 全部完成（或达到步数上限），启动 Worker 物理快进
        startWorkerSeek()
      }
    }

    this._seekRafId = requestAnimationFrame(tick)
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

  /**
   * 高亮 physSize 在 [minSize, maxSize] 范围内的碎片
   * @param {number} minSize - 物理尺寸下限（米）
   * @param {number} maxSize - 物理尺寸上限（米）
   */
  highlightFragmentsBySize(minSize, maxSize) {
    this._fragmentRenderer.highlightBySizeRange(minSize, maxSize)
  }

  /** 清除碎片高亮，恢复原始颜色 */
  clearFragmentHighlight() {
    this._fragmentRenderer.clearHighlight()
  }

  /**
   * 获取块度分布统计：
   *  - 从 fragmentRenderer.fragmentMeshes 的 userData.specs 收集所有 spec.physSize
   *  - 按块度区间分组（0-0.1m, 0.1-0.3m, 0.3-0.5m, 0.5-1.0m, 1.0m+）
   *  - 计算 x50/x80/xmax 等特征尺寸
   * @returns {{ buckets: Array, total: number, x50: number|null, x80: number|null, xmax: number|null } | null}
   */
  getFragmentDistribution() {
    const meshes = this._fragmentRenderer?.fragmentMeshes
    if (!Array.isArray(meshes) || meshes.length === 0) return null

    const sizes = []
    for (const mesh of meshes) {
      const group = mesh.userData?.specs
      if (!Array.isArray(group)) continue
      for (const entry of group) {
        const physSize = Number(entry?.spec?.physSize)
        if (Number.isFinite(physSize) && physSize > 0) sizes.push(physSize)
      }
    }
    if (sizes.length === 0) return null

    // 块度区间定义（单位：米）
    const bucketDefs = [
      { min: 0, max: 0.1, label: '0 - 0.1 m' },
      { min: 0.1, max: 0.3, label: '0.1 - 0.3 m' },
      { min: 0.3, max: 0.5, label: '0.3 - 0.5 m' },
      { min: 0.5, max: 1.0, label: '0.5 - 1.0 m' },
      { min: 1.0, max: Infinity, label: '1.0 m+' }
    ]
    const total = sizes.length
    const buckets = bucketDefs.map(def => {
      // 上界开放、下界闭，避免边界重复计数（1.0 m+ 区间下界闭）
      const count = sizes.filter(s => s >= def.min && (def.max === Infinity ? true : s < def.max)).length
      return {
        min: def.min,
        max: def.max === Infinity ? null : def.max,
        label: def.label,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0
      }
    })

    // 特征尺寸：将 physSize 升序排列后按分位数计算
    const sorted = [...sizes].sort((a, b) => a - b)
    const percentile = p => {
      if (sorted.length === 0) return null
      const idx = (p / 100) * (sorted.length - 1)
      const lo = Math.floor(idx)
      const hi = Math.ceil(idx)
      if (lo === hi) return sorted[lo]
      // 线性插值
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
    }
    return {
      buckets,
      total,
      x50: percentile(50),
      x80: percentile(80),
      xmax: sorted[sorted.length - 1] ?? null
    }
  }

  setBloomParams(params = {}) {
    if (!this.bloomPass) return
    if (params.strength != null) this.bloomPass.strength = Math.max(0, Number(params.strength))
    if (params.radius != null) this.bloomPass.radius = Math.max(0, Number(params.radius))
    if (params.threshold != null)
      this.bloomPass.threshold = Math.max(0, Math.min(1, Number(params.threshold)))
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
    // 清理振动场体积（释放 3D 纹理与 mesh，保留渲染器实例与 LUT 供下次重建）
    this._vibrationFieldRenderer?.disposeMesh()
    this._fragmentSpecs = null
    this._lastSpecGenParams = null
    this._fragmentStats = null
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
    // 完全释放振动场渲染器（含 LUT 纹理）
    this._vibrationFieldRenderer?.dispose()
    // 释放 Worker 资源，避免内存泄漏
    this._physicsEngine.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }

  getStats() {
    const generated =
      this._fragmentStats?.fragmentCountGenerated ?? this._physicsEngine.bodies.length
    return {
      total: this._physicsEngine.bodies.length,
      alive: this._physicsEngine.aliveFragmentCount,
      landed: this._physicsEngine.landedFragmentCount,
      fragmentCountTarget: this._fragmentStats?.fragmentCountTarget ?? generated,
      fragmentCountGenerated: generated,
      fragmentCountRendered: this._physicsEngine.bodies.length,
      fragmentCountRenderLimit: this._fragmentStats?.fragmentCountRenderLimit ?? generated,
      kcoSourceMode: this._fragmentStats?.kcoSourceMode ?? KCO_SOURCE_MODE.DESIGN,
      x50Applied: this._fragmentStats?.x50Applied ?? null,
      nApplied: this._fragmentStats?.nApplied ?? null,
      x50Computed: this._fragmentStats?.x50Computed ?? null,
      nComputed: this._fragmentStats?.nComputed ?? null,
      fragmentMassTargetKg: this._fragmentStats?.fragmentMassTargetKg ?? null,
      fragmentMassGeneratedKg: this._fragmentStats?.fragmentMassGeneratedKg ?? null,
      fragmentMassCoverage: this._fragmentStats?.fragmentMassCoverage ?? null,
      velocityMean: this._fragmentStats?.velocityMean ?? null,
      velocityP95: this._fragmentStats?.velocityP95 ?? null,
      throwDistancePredictedAvg: this._fragmentStats?.throwDistancePredictedAvg ?? null,
      throwDistancePredictedMax: this._fragmentStats?.throwDistancePredictedMax ?? null,
      throwDistanceTargetAvg: this._fragmentStats?.throwDistanceTargetAvg ?? null,
      throwDistanceTargetMax: this._fragmentStats?.throwDistanceTargetMax ?? null,
      velocityScaleApplied: this._fragmentStats?.velocityScaleApplied ?? 1,
      sizeHistogramGenerated: this._fragmentStats?.sizeHistogramGenerated ?? null,
      sizeHistogramTarget: this._fragmentStats?.sizeHistogramTarget ?? null,
      sizeKLDivergence: this._fragmentStats?.sizeKLDivergence ?? null,
      velocityHistogramGenerated: this._fragmentStats?.velocityHistogramGenerated ?? null,
      energyStats: this._physicsEngine?.getEnergyStats?.() ?? null
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

  // ─── PPV 振动场（实时推送的动态热力图）──────────────────────

  /**
   * 计算隧道局部基向量 (right, up, forward)
   * 与 initBlast 中一致：forward = faceDirection 投影到水平面后归一化
   * @returns {{right: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3}}
   */
  _computeTunnelBasis() {
    const up = new THREE.Vector3(0, 1, 0)
    const dir = this.faceDirection.clone()
    // 投影到水平面（去除垂直分量），保证 right 水平
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
    dir.normalize()
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()
    return { right, up, forward }
  }

  /**
   * 初始化（或重建）PPV 振动场体积。
   * 由 useBlasting 在收到首个 PPV 二进制帧时调用，
   * 使用当前爆心与隧道朝向定位 box。
   * @param {Object} cfg
   * @param {number[]} cfg.gridShape - [nx, ny, nz]
   * @param {number[]} cfg.boundsMin - [x,y,z]
   * @param {number[]} cfg.boundsMax - [x,y,z]
   */
  initVibrationField(cfg) {
    if (!this._vibrationFieldRenderer) return
    const { right, up, forward } = this._computeTunnelBasis()
    this._vibrationFieldRenderer.init({
      gridShape: cfg.gridShape,
      boundsMin: cfg.boundsMin,
      boundsMax: cfg.boundsMax,
      center: this.center,
      right,
      up,
      forward
    })
    // 同步当前图层可见性
    this._vibrationFieldRenderer.setVisible(this.layerVisibility.vibrationField !== false)
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */
  updateVibrationField(ppv, t, frame) {
    this._vibrationFieldRenderer?.updateField(ppv, t, frame)
  }

  /** 更新 σ_vm 应力场（每个 STRESS 二进制帧调用） */
  updateStressField(sigmaVm, t, frame) {
    this._vibrationFieldRenderer?.updateStressField(sigmaVm, t, frame)
  }

  /** 更新损伤分区场（每个 DAMAGE 二进制帧调用） */
  updateDamageField(zones, t, frame) {
    this._vibrationFieldRenderer?.updateDamageField(zones, t, frame)
  }

  /** 切换振动场显示模式（ppv/stress/damage） */
  setVibrationDisplayMode(mode) {
    this._vibrationFieldRenderer?.setDisplayMode(mode)
  }

  /** 当前是否已有可渲染的振动场 */
  hasVibrationField() {
    return !!this._vibrationFieldRenderer?.hasField
  }

  /** 振动场元信息（供 UI 显示当前场时间/帧/网格） */
  getVibrationFieldInfo() {
    return this._vibrationFieldRenderer?.getFieldInfo?.() ?? null
  }

  /** 设置振动场整体不透明度（0..1） */
  setVibrationFieldOpacity(o) {
    this._vibrationFieldRenderer?.setOpacity(o)
  }

  /** 设置振动场 raymarching 步数（性能/精度权衡） */
  setVibrationFieldRaySteps(n) {
    this._vibrationFieldRenderer?.setRaySteps(n)
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
    // PPV 振动场图层
    if (layer === 'vibrationField') {
      this._vibrationFieldRenderer?.setVisible(visible)
    }
  }

  /** 获取当前所有图层可见性状态（供 UI 回显） */
  getLayerVisibility() {
    return { ...this.layerVisibility }
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
    const advanceDepth = Number(dp.advanceLength) || holeDepth * utilization
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
