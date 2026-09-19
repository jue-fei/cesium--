/**
 * 爆破初始化控制器（BlastInitController）
 *
 * 从 ThreeBlastingRenderer（门面）按职责域拆分的组合控制器之一，负责：
 *  - initBlast：单次爆破的完整初始化流程（KCO 模型计算 → 粒子特效配置 →
 *    碎片规格生成 → 爆堆轮廓/物理边界注入 → 物理引擎初始化 →
 *    碎片 InstancedMesh 构建 → 参数缓存与爆破前状态复位）；
 *    内部按既有分节注释拆分为顺序编排的私有步骤方法
 *    （_computeBasis/_configureMuckPile/_rebuildScene/_resolveKco/_setupEffects/
 *    _generateFragmentSpecs/_initPhysicsEngine/_setupFragmentRenderer/
 *    _cacheBlastParams/_resetPreBlastState）
 *  - _buildHoleSpecsForFragmentGen：数据库炮孔设计数据 → 碎片规格生成器
 *    输入格式（{x, y, chargeKg, delayMs, isEmpty, holeType}）的转换
 *
 * 职责边界：
 *  - 不持有任何仿真状态：simTime、_lastBlastParams、_physicsEngine、
 *    _sceneBuilder、layerVisibility、center 等字段仍全部保存在门面实例上，
 *    经构造时注入的门面引用 this.r 访问。
 *  - 与其他控制器（Seek/PointPicker/VibrationFieldPipeline/CameraView）
 *    互不引用，仅经门面协作。
 *  - 门面 ThreeBlastingRenderer 保留同名公共方法 initBlast 作为委托入口，
 *    外部调用方（blastingManager / cesiumThreeBridge 等）零改动。
 */

import * as THREE from 'three'
import { KCO_SOURCE_MODE, calculateKCOParams } from '../computation/kcoModelCore.js'
import { generateFragmentSpecs } from './fragmentSpecGenerator.js'
import { getRockVariantHalfExtents } from './rockGeometryFactory.js'

export class BlastInitController {
  /**
   * @param {ThreeBlastingRenderer} renderer - 门面渲染器实例（经 this.r 访问门面状态与公共方法）
   */
  constructor(renderer) {
    this.r = renderer
  }

  /**
   * 初始化爆破粒子系统（顺序编排器：各步骤一行调用，逻辑见各私有方法）
   * @param {Object} params
   * @param {number} params.chargeKg - 装药量(kg)
   * @param {number} params.fragmentCount - 碎片数量
   */
  initBlast(params = {}) {
    this.r.clear()
    this.r._lastBlastParams = { ...params }
    this.r.simTime = 0
    const chargeKg = params.chargeKg || this.r.chargeKg
    this.r.setChargeKg(chargeKg)

    // 性能模式：设置碎片间碰撞开关
    if (
      params.enableInterCollision !== undefined &&
      this.r._physicsEngine.setEnableInterCollision
    ) {
      this.r._physicsEngine.setEnableInterCollision(params.enableInterCollision)
    }

    // 设置爆破方向（如果提供了掌子面方向）
    if (params.faceDirection) {
      this.r.setFaceDirection(
        params.faceDirection.x,
        params.faceDirection.y,
        params.faceDirection.z
      )
    }

    const basis = this._computeBasis()
    this._configureMuckPile(basis)
    const faceCenter = this._rebuildScene(basis)
    const { kco, throwDir } = this._resolveKco(params, chargeKg, basis.forward)
    const ctx = { ...basis, faceCenter, kco, throwDir }
    this._setupEffects(chargeKg, ctx)
    const gen = this._generateFragmentSpecs(params, chargeKg, ctx)
    this._initPhysicsEngine(params, ctx, gen)
    this._setupFragmentRenderer(gen)
    this._cacheBlastParams(chargeKg, ctx, gen)
    this._resetPreBlastState()
  }

  /**
   * 计算掌子面局部基向量：面内水平方向 dir、世界上方向 up、侧向 right、轴向 forward。
   * @returns {{ dir: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3, forward: THREE.Vector3 }}
   */
  _computeBasis() {
    const dir = this.r.faceDirection.clone()
    // 投影到水平面（去除垂直分量）并归一化，保证 right 水平、forward 有限；
    // 与 _computeTunnelBasis 一致——面方向平行于 up 时 cross 会得零向量，
    // normalize 得 NaN，进而污染爆堆包裹壳几何（computeBoundingSphere 报 NaN）。
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
    dir.normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()
    return { dir, up, right, forward }
  }

  /**
   * 配置爆堆轮廓渲染器的局部基与隧道断面参数。
   * @param {{ forward: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3 }} basis
   */
  _configureMuckPile({ forward, right, up }) {
    // 配置爆堆轮廓渲染器局部基：轴向 forward、侧向 right、竖直 up、爆堆中心、
    // 底板高度、掌子面轴向距离（裁掉穿模进未爆破岩体的碎片，否则包裹壳
    // 会被撑进岩体内部、贴不住真实爆堆）
    this.r._muckPileOutline.configure({
      forward,
      right,
      up,
      center: this.r.center,
      floorY: this.r.center.y,
      faceOffset: this.r.faceOffset,
      // 隧道断面参数：剔除"卡在隧道外"的碎石，不参与爆堆轮廓
      section: {
        width: this.r.tunnelWidth,
        wallHeight: this.r.tunnelWallHeight,
        archRadius: this.r.tunnelArchRadius,
        shape: this.r.tunnelSection.shape
      }
    })
  }

  /**
   * 构建掌子面/台阶几何、同步隧道补光并写入隧道截面物理边界。
   * @param {{ forward: THREE.Vector3, right: THREE.Vector3 }} basis
   * @returns {THREE.Vector3} 掌子面中心（爆心沿轴向前方 3m）
   */
  _rebuildScene({ forward, right }) {
    // 构建掌子面/台阶几何体
    this.r._sceneBuilder.buildBenchGeometry()
    const faceCenter = new THREE.Vector3().copy(this.r.center).addScaledVector(forward, 3)

    // 同步隧道内部补光
    this.r._sceneBuilder.updateTunnelLights(
      this.r.center,
      this.r.faceDirection,
      this.r.tunnelHeight
    )

    // 隧道截面边界（用于物理引擎碰撞检测）
    this.r._tunnelBounds = {
      right: right.clone(),
      forward: forward.clone(),
      center: this.r.center.clone(),
      halfWidth: this.r.tunnelWidth / 2,
      wallHeight: this.r.tunnelWallHeight,
      archRadius: this.r.tunnelArchRadius,
      floorY: this.r.center.y
    }
    return faceCenter
  }

  /**
   * KCO 模型计算：由装药量与 UI 覆盖参数（params.kcoParams）计算块度分布输出。
   * @param {Object} params
   * @param {number} chargeKg - 装药量(kg)
   * @param {THREE.Vector3} forward - 掌子面轴向基向量
   * @returns {{ kco: Object, throwDir: THREE.Vector3 }} kco 输出与抛掷方向（forward 反向）
   */
  _resolveKco(params, chargeKg, forward) {
    // ── 1. KCO 模型计算 ──
    const throwDir = forward.clone().negate()
    const kcoInput = {
      Q: chargeKg,
      sourceMode: params.kcoParams?.sourceMode || KCO_SOURCE_MODE.DESIGN,
      ...(params.kcoParams || {})
    }
    const kco = calculateKCOParams(kcoInput)
    return { kco, throwDir }
  }

  /**
   * 爆破粒子特效配置：写入特效参数缓存、初始化特效管理器并同步图层可见性。
   * @param {number} chargeKg - 装药量(kg)
   * @param {{ faceCenter: THREE.Vector3, throwDir: THREE.Vector3, right: THREE.Vector3,
   *           up: THREE.Vector3, kco: Object }} ctx
   */
  _setupEffects(chargeKg, { faceCenter, throwDir, right, up, kco }) {
    // ── 2. 爆破粒子特效 ──
    this.r._lastEffectParams = {
      chargeKg,
      center: { x: faceCenter.x, y: faceCenter.y, z: faceCenter.z },
      throwDir: { x: throwDir.x, y: throwDir.y, z: throwDir.z },
      right: { x: right.x, y: right.y, z: right.z },
      up: { x: up.x, y: up.y, z: up.z },
      tunnelSection: {
        width: this.r.tunnelWidth,
        wallHeight: this.r.tunnelWallHeight,
        archRadius: this.r.tunnelArchRadius,
        shape: this.r.tunnelSection.shape
      },
      kcoOutput: { A: kco.A },
      // 主爆破粒子（火球/火花/烟雾/粉尘/冲击波）从起爆时刻开始涌现，
      // 出生前不老化、不渲染（配合 BlastEffectManager 的 bornAt 门控）
      triggerTime: this.r.blastTriggerTime
    }
    this.r._effectManager.init(this.r._lastEffectParams)
    // 初始化后立即同步当前图层可见性（确保撞击扬尘等跟随用户之前的开关状态）
    for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
      this.r._effectManager.setVisible(layer, this.r.layerVisibility[layer] !== false)
    }
  }

  /**
   * KCO 碎片规格生成：构建掌子面描述与炮孔数据，生成碎片规格/初值，并写入
   * 碎片统计、爆堆轮廓逐碎片包围盒、seekTo 复用数据与物理边界缓存。
   * @param {Object} params
   * @param {number} chargeKg - 装药量(kg)
   * @param {{ dir: THREE.Vector3, forward: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3,
   *           faceCenter: THREE.Vector3, kco: Object }} ctx
   * @returns {{ specs: Array<Object>, positions: Float32Array, velocities: Float32Array,
   *             variantHalfExtents: Array<number[]>, faceDesc: Object }}
   */
  _generateFragmentSpecs(params, chargeKg, { dir, forward, right, up, faceCenter, kco }) {
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
      width: this.r.tunnelWidth,
      wallHeight: this.r.tunnelWallHeight,
      archRadius: this.r.tunnelArchRadius,
      shape: this.r.tunnelSection.shape
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
      targetCount: params.fragmentCountTarget || chargeKg * 1.5,
      countLimit: params.fragmentCountRenderLimit || 1000,
      holes: holeSpecs,
      metrics: params.generationMetrics || {},
      randomSeed: params.randomSeed
    })
    this.r._fragmentSpecs = specs
    // 爆堆轮廓逐碎片渲染包围盒半轴（变体 AABB 半轴 × dispSize），
    // 轮廓渲染器据此 + 四元数做精确投影，壳面紧贴可见碎石
    const variantHalfExtents = getRockVariantHalfExtents()
    this.r._muckPileOutline.setFragmentExtents(
      specs.map(s => {
        const e = variantHalfExtents[s.variantIndex] || [0.6, 0.6, 0.6]
        // variant + size 供包裹壳做"真实投影轮廓"掩码（见 muckPileOutlineRenderer）
        return {
          hx: e[0] * s.dispSize,
          hy: e[1] * s.dispSize,
          hz: e[2] * s.dispSize,
          variant: s.variantIndex,
          size: s.dispSize
        }
      })
    )
    this.r._fragmentStats = {
      fragmentCountTarget:
        generationStats?.fragmentCountTarget ??
        Math.max(40, Math.floor(params.fragmentCountTarget || chargeKg * 1.5)),
      fragmentCountGenerated: specs.length,
      fragmentCountRenderLimit: Math.max(40, Number(params.fragmentCountRenderLimit) || 1000),
      chargeKg,
      explosiveType:
        params.kcoParams?.explosiveType || params.generationMetrics?.explosiveType || 'emulsion',
      rockDensityKgM3: Number(params.generationMetrics?.rockDensityKgM3) || null,
      kcoSourceMode: kco.sourceMode,
      x50Applied: kco.x50,
      nApplied: kco.n,
      x80Applied: kco.x80,
      xmaxApplied: kco.xmax,
      bApplied: kco.b,
      x50Computed: kco.computedX50,
      nComputed: kco.computedN,
      fragmentMassTargetKg: generationStats?.fragmentMassTargetKg ?? null,
      fragmentMassGeneratedKg: generationStats?.fragmentMassGeneratedKg ?? null,
      fragmentMassBlastedKg: generationStats?.fragmentMassBlastedKg ?? null,
      fragmentMassCoverage: generationStats?.fragmentMassCoverage ?? null,
      bulkFactor: generationStats?.bulkFactor ?? null,
      volumeRestoreScale: generationStats?.volumeRestoreScale ?? null,
      representativeVolumeM3: generationStats?.representativeVolumeM3 ?? null,
      representativeMassKg: generationStats?.representativeMassKg ?? null,
      blastVolumeM3: generationStats?.blastVolumeM3 ?? null,
      estimatedMeanMassKg: generationStats?.estimatedMeanMassKg ?? null,
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
    this.r._lastFragmentData = { specs, positions, velocities }
    // 保存物理边界，供 seekToAsync 使用
    this.r._lastPhysicsBounds = {
      centerX: this.r.center.x,
      centerY: this.r.center.y,
      centerZ: this.r.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.r.tunnelWidth / 2,
      wallHeight: this.r.tunnelWallHeight,
      archRadius: this.r.tunnelArchRadius,
      floorY: this.r.center.y,
      faceOffset: this.r.faceOffset, // 掌子面到隧道中心的轴向距离(m)
      shape: this.r.tunnelSection.shape
    }
    return { specs, positions, velocities, variantHalfExtents, faceDesc }
  }

  /**
   * 物理引擎初始化：复位、写入隧道边界、挂接碎片落地回调并注入碎片初值。
   * @param {Object} params
   * @param {{ right: THREE.Vector3, forward: THREE.Vector3 }} basis
   * @param {{ specs: Array<Object>, positions: Float32Array, velocities: Float32Array }} gen
   */
  _initPhysicsEngine(params, { right, forward }, { specs, positions, velocities }) {
    // ── 4. 物理引擎初始化 ──
    this.r._physicsEngine.reset()
    this.r._physicsEngine.setTunnelBounds({
      centerX: this.r.center.x,
      centerY: this.r.center.y,
      centerZ: this.r.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.r.tunnelWidth / 2,
      wallHeight: this.r.tunnelWallHeight,
      archRadius: this.r.tunnelArchRadius,
      floorY: this.r.center.y,
      faceOffset: this.r.faceOffset,
      shape: this.r.tunnelSection.shape
    })
    this.r._physicsEngine.onBodyLanded = (body, impactSpeed) => {
      this.r._effectManager.spawnImpactDebris(
        { x: body.posX, y: body.posY, z: body.posZ },
        impactSpeed
      )
    }
    this.r._physicsEngine.init(specs, positions, velocities, {
      randomSeed: params.randomSeed,
      blastTriggerTime: this.r.blastTriggerTime
    })
  }

  /**
   * 碎片 InstancedMesh 构建：按规格重建实例网格，写入断面剔除边界与变体半轴表。
   * @param {{ specs: Array<Object>, variantHalfExtents: Array<number[]> }} gen
   */
  _setupFragmentRenderer({ specs, variantHalfExtents }) {
    // ── 5. 碎片 InstancedMesh ──
    this.r._fragmentRenderer.buildFragmentMesh(specs)
    // 按隧道断面隐藏"卡在隧道外/拱顶尖角伸出"的实例（口径与爆堆轮廓一致）
    this.r._fragmentRenderer.setSectionBounds(this.r._lastPhysicsBounds)
    this.r._fragmentRenderer.setExtentTable(variantHalfExtents)
  }

  /**
   * 缓存本次爆破的规格生成参数（供重播/seekTo 复用）。
   * @param {number} chargeKg - 装药量(kg)
   * @param {{ kco: Object }} ctx
   * @param {{ specs: Array<Object>, faceDesc: Object }} gen
   */
  _cacheBlastParams(chargeKg, { kco }, { specs, faceDesc }) {
    // ── 6. 缓存参数 ──
    this.r._lastSpecGenParams = { kco, face: faceDesc, chargeKg, fragmentCount: specs.length }

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
  }

  /** 爆破前状态复位：清触发/实测时长/回放标记并刷新实例网格。 */
  _resetPreBlastState() {
    // ── 7. 爆破前状态 ──
    this.r.blastTriggered = false
    // 重置实测时长状态（新一次爆破重新观测）
    this.r._observedDurationS = null
    this.r._landAllAt = null
    this.r._settleConfirmFrames = 0
    this.r._replayLandCursor = 0
    this.r._replayModeActive = false
    this.r._fragmentRenderer.updateFragmentMesh()
    this.r.active = true
  }

  /**
   * 构建用于碎片规格生成器的炮孔数据
   * 从 blastHoleDesign 提取 posX/posY/chargeKg/delayMs/isEmptyHole/holeType，
   * 转换为 fragmentSpecGenerator 需要的 {x, y, chargeKg, delayMs, isEmpty, holeType} 格式
   * @returns {Array<Object>|null}
   */
  _buildHoleSpecsForFragmentGen() {
    const blastHoleDesign = this.r._sceneBuilder.blastHoleDesign
    if (!Array.isArray(blastHoleDesign) || blastHoleDesign.length === 0) {
      return null
    }
    return blastHoleDesign.map(h => {
      // 孔型映射：与 sceneBuilder._collectDesignHoles 一致
      const rawType = (h.holeType || 'production').toLowerCase()
      let holeType = 'auxiliary'
      if (h.isEmptyHole) holeType = 'empty'
      else if (rawType === 'cut' || rawType === 'easing') holeType = 'cut'
      else if (rawType === 'perimeter') holeType = 'perimeter'
      return {
        x: Number(h.posX) || 0,
        y: Number(h.posY) || 0,
        chargeKg: Number(h.chargeKg) || 0,
        delayMs: Number(h.delayMs) || 0,
        isEmpty: !!h.isEmptyHole,
        holeType
      }
    })
  }
}
