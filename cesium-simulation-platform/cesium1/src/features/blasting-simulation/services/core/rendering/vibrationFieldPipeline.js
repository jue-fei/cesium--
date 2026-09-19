/**
 * 振动场渲染管道控制器（VibrationFieldPipeline）
 *
 * 从 ThreeBlastingRenderer（门面）按职责域拆分的组合控制器之一，负责
 * PPV/应力/损伤振动场的纹理管道与场渲染样式转发：
 *  - initVibrationField：场体积初始化（坐标基定位、岩体表面着色注入、
 *    解析外推物理参数与波源、振动波粒子特效联动）
 *  - updateVibrationField/updateStressField/updateDamageField：三场二进制帧推送
 *  - _advanceFieldSimTime：场时钟统一推进（防回退防闪烁、活动播放期忽略 WS 超前帧）
 *  - setFieldPhysics/_applyFieldPhysics：萨道夫斯基解析外推物理参数下发
 *  - _applyVibrationOcclusion：场图层开关 → 岩体半透明/场着色淡入联动
 *  - _computeTunnelBasis：隧道局部基向量（与 initBlast 同口径）
 *  - clearFieldTextures：Seek 清屏（三张 3D 场纹理清零并强制重传）
 *  - updateVibrationParticles/clearVibrationParticles/setVibrationDisplayMode/
 *    setBenchWhiteModel/setIsoLine/setIsoLineStyle/setNormMode/setFieldTranslucent/
 *    setVectorField/clearVectorField/getContourSurface/getInfluenceRadius/
 *    setContourPolylines/getFieldRenderParams/hasVibrationField/
 *    getVibrationFieldInfo/setVibrationFieldRaySteps：场样式与元信息转发
 *
 * 职责边界：
 *  - 不持有任何状态：_vibrationFieldRenderer、_vibrationParticles、_sceneBuilder、
 *    layerVisibility、_fieldPhysicsParams、simTime 等仍全部保存在门面实例上，
 *    经 this.r 访问。
 *  - 与其他控制器互不引用；门面保留全部同名公共委托入口。
 */

import * as THREE from 'three'

export class VibrationFieldPipeline {
  /**
   * @param {ThreeBlastingRenderer} renderer - 门面渲染器实例（经 this.r 访问门面状态与公共方法）
   */
  constructor(renderer) {
    this.r = renderer
  }

  // ─── PPV 振动场（实时推送的动态热力图）──────────────────────

  /**
   * 计算隧道局部基向量 (right, up, forward)
   * 与 initBlast 中一致：forward = faceDirection 投影到水平面后归一化
   * @returns {{right: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3}}
   */
  _computeTunnelBasis() {
    const up = new THREE.Vector3(0, 1, 0)
    const dir = this.r.faceDirection.clone()
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
    if (!this.r._vibrationFieldRenderer) return
    const { right, up, forward } = this._computeTunnelBasis()
    const origin = cfg?.origin ?? this.r._blastOrigin
    this.r._vibrationFieldRenderer.init({
      gridShape: cfg.gridShape,
      boundsMin: cfg.boundsMin,
      boundsMax: cfg.boundsMax,
      center: this.r.center,
      right,
      up,
      forward,
      origin
    })
    // 将振动场数据纹理/坐标基注入岩体表面着色材质（应力/损伤/PPV 直接渲染在岩体上）
    this._applyVibrationFieldToBench()
    // 波场可达半径（= 爆心 → 岩体几何最远顶点）回传给 manager：
    // 本地模拟器/后端包络必须取同一半径，否则本地兜底接管时会在岩体中部截断
    const rInfluence = this.r._sceneBuilder?.influenceRadius ?? 0
    if (Number(rInfluence) > 0) this.r.onInfluenceRadiusMeasured?.(Number(rInfluence))
    // 点选查询的遮挡/轴向延展修正与 shader 同口径：getter 保证岩体重建后取最新洞身参数
    this.r._vibrationFieldRenderer.setHoleGeomProvider(
      () => this.r._sceneBuilder?._holeGeom || null
    )
    // 同步场盒外解析外推（萨道夫斯基）的物理参数与初始时间
    this._applyFieldPhysics()
    // 解析外推的波源随爆心注入（掏槽孔质心），保证盒外波前与盒内纹理同源
    this.r._sceneBuilder.applyFieldPhysics({
      origin: Array.isArray(origin) ? origin : [origin.x, origin.y, origin.z]
    })
    this.r._sceneBuilder.setFieldSimTime(this.r.simTime ?? 0)
    // 同步初始化振动波粒子特效（使用相同的坐标系基；显隐由独立图层 vibrationParticles 控制）
    this.r._vibrationParticles.init({
      center: this.r.center,
      right,
      up,
      forward,
      section: {
        width: this.r.tunnelWidth,
        wallHeight: this.r.tunnelWallHeight,
        archRadius: this.r.tunnelArchRadius,
        shape: this.r.tunnelSection.shape
      }
    })
    this.r._vibrationParticles.setVisible(this.r.layerVisibility.vibrationParticles !== false)
    // 同步当前图层可见性
    this.r._vibrationFieldRenderer.setVisible(this.r.layerVisibility.vibrationField !== false)
    // 联动岩体表面场着色强度
    this._applyVibrationOcclusion()
  }

  /**
   * 将振动场数据纹理/坐标基注入岩体表面着色材质。
   * 数据由 BlastVibrationFieldRenderer 持有，这里转发给 SceneBuilder 的 benchMesh 材质。
   */
  _applyVibrationFieldToBench() {
    if (!this.r._sceneBuilder.setBenchFieldData) return
    const data = this.r._vibrationFieldRenderer.getFieldData()
    if (data) this.r._sceneBuilder.setBenchFieldData(data)
  }

  /**
   * 根据振动场图层的开关状态，联动岩体表面场着色强度。
   *
   * 【不再以 hasAnyField 为门控】场着色是逐片元解析计算，不依赖任何场数据或
   * 场纹理即可出图（数据只用于点选查询与等值线）。此前要求"已收到首帧场数据"
   * 才切权重，导致开关滞后到数据到达才生效——观感即"打开热力图不是直接渲染，
   * 而是要加载一段时间"。改为按图层开关直接切目标权重（内部走 FIELD_FADE_MS
   * 缓动淡入），数据到达时自然接上，无跳变。
   */
  _applyVibrationOcclusion() {
    const on = this.r.layerVisibility?.vibrationField !== false
    this.r._sceneBuilder.setRockSemiTransparent(on)
    this.r._sceneBuilder.updateFieldFade()
  }

  /**
   * 更新振动波传播粒子（每帧由本地模拟器驱动）
   * @param {Array} particles - VibrationParticleSystem 的活跃粒子
   */
  updateVibrationParticles(particles) {
    this.r._vibrationParticles?.update(particles || [])
  }

  /** 清空振动波粒子 */
  clearVibrationParticles() {
    this.r._vibrationParticles?.clear()
  }

  /**
   * 岩体热力图解析外推的时间源统一推进（防回退防闪烁）。
   *
   * 热力图（岩面片元着色器的解析外推）的时间由本地播放时钟平滑驱动：
   * renderer.update() 每帧写 uSimTime = this.r.simTime，单调推进且支持循环归零重放。
   * WS 场帧按 ~0.1s 推送、到达常滞后于本地播放时钟（倍速时更甚）；若其 t 直接覆盖，
   * uSimTime 会回退 → 波前 gap<0、front 过渡项归零 → 整片明灭 / 亮环跳闪
   * （多源延时场景对时间更敏感，表现最明显）。
   *
   * 处理：仅当帧时间超前本地时钟时才前推 uSimTime。这样
   *  - 正常播放：本地时钟领先 → WS 迟到帧被忽略，时间单调；
   *  - 被动大屏/本地时钟未推进：WS t 始终超前 simTime → 热力图仍由 WS 帧驱动；
   *  - 循环/回跳归零：本地时钟归零后自己重写，热力图正常重播。
   * @param {number} t - 场帧的模拟时间(s)
   */
  _advanceFieldSimTime(t) {
    if (this.r._fieldTimeLocked) return
    // 【场时钟统一】本地播放时钟活跃期间（RAF update 正常推进，见 update() 内
    // _lastLocalFieldClockMs 戳记），忽略 WS 场帧的时间推进：
    // 后端按墙钟 0.05s/帧匀速推流，本地 RAF 时钟受渲染负载抖动/追帧步进影响，
    // WS 一旦超前就会把 uSimTime 拽到"未来"——解析波前从掌子面瞬移到岩体深处，
    // 下一帧 update() 又拉回本地时钟，反复横跳。视觉上即"首轮播放热力图从岩体
    // 后面开始传播"（WS 推流仅首轮存在；第二遍 WS 已 COMPLETED、纯本地时钟故
    // 正常）。被动大屏（本地时钟停更 >250ms、无 RAF update）仍由 WS 帧驱动，
    // 保持原行为。
    const nowMs = performance.now()
    if (this.r._lastLocalFieldClockMs != null && nowMs - this.r._lastLocalFieldClockMs < 250) {
      if (t > this.r.simTime + 0.25 && !this.r._wsAheadWarned) {
        this.r._wsAheadWarned = true
        console.warn(
          '[FieldClock] 活动播放期间忽略 WS 场帧时间超前推进（WS 与本地时钟软同步偏差）',
          {
            wsT: Number(t.toFixed(3)),
            localT: Number(this.r.simTime.toFixed(3)),
            超前s: Number((t - this.r.simTime).toFixed(3))
          }
        )
      }
      return
    }
    if (t > this.r.simTime) this.r._sceneBuilder.setFieldSimTime(t)
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */
  updateVibrationField(ppv, t, frame) {
    this.r._vibrationFieldRenderer?.updateField(ppv, t, frame)
    this._advanceFieldSimTime(t)
  }

  /** 更新 σ_vm 应力场（每个 STRESS 二进制帧调用） */
  updateStressField(sigmaVm, t, frame) {
    this.r._vibrationFieldRenderer?.updateStressField(sigmaVm, t, frame)
    this._advanceFieldSimTime(t)
  }

  /** 更新损伤分区场（每个 DAMAGE 二进制帧调用） */
  updateDamageField(zones, t, frame) {
    this.r._vibrationFieldRenderer?.updateDamageField(zones, t, frame)
    this._advanceFieldSimTime(t)
  }

  /**
   * 【Seek 清屏】把 PPV/应力/损伤三张 3D 场纹理全部清零并强制重传。
   *
   * 拖动进度条后"糊成色块"的直接来源：GPU 里仍驻留着 seek 前的场数据
   * （尤其是峰值/损伤这类"未来帧最大值"，以及应力纹理的旧时刻切片），
   * 新帧到达前着色器读到的是新旧混合内容。清零后在新帧落地前不再显示
   * 任何残留，等价于"Seek 期间阻塞着色器读取旧数据"。
   */
  clearFieldTextures() {
    this.r._vibrationFieldRenderer.clearFieldTextures()
  }

  /**
   * 注入场盒外解析外推（萨道夫斯基）的物理参数，并应用到岩体表面着色材质。
   * @param {Object} params - { chargeKg, k, alpha, beta, visualCp, rho, cp, nu }
   */
  setFieldPhysics(params) {
    this.r._fieldPhysicsParams = { ...(this.r._fieldPhysicsParams || {}), ...params }
    this._applyFieldPhysics()
  }

  /** 将缓存的场物理参数下发到 SceneBuilder（采样一致性） */
  _applyFieldPhysics() {
    if (!this.r._fieldPhysicsParams) return
    this.r._sceneBuilder.applyFieldPhysics(this.r._fieldPhysicsParams)
  }

  /** 切换振动场显示模式（ppv/stress/damage） */
  setVibrationDisplayMode(mode) {
    this.r._vibrationFieldRenderer?.setDisplayMode(mode)
    // 同步岩体表面着色模式
    const m = this.r._vibrationFieldRenderer?.displayModeValue
    if (m != null) this.r._sceneBuilder.setBenchFieldDisplayMode(m)
  }

  /** 切换振动场底材"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setBenchWhiteModel(enabled) {
    this.r._sceneBuilder.setFieldWhiteModel(!!enabled)
  }

  /** 开关振动场等力线（等值线）叠加显示 */
  setIsoLine(enabled) {
    this.r._sceneBuilder.setIsoLine(!enabled ? { on: false } : { on: true })
  }

  /** 设置等值线样式（线宽 px / 统一颜色；color=null 恢复按级别取色） */
  setIsoLineStyle({ width, color } = {}) {
    this.r._sceneBuilder.setIsoLine({ width, color })
  }

  /** 设置色彩映射标尺：0=线性，1=对数（默认；适应 PPV/应力幂律衰减） */
  setNormMode(mode) {
    this.r._sceneBuilder.setNormMode(mode)
  }

  /** 设置半透明渲染（1=场色上限 0.55 露出岩底，0=实色 0.85） */
  setFieldTranslucent(on) {
    this.r._sceneBuilder.setFieldTranslucent(!!on)
  }

  /** 下发矢量箭头场（P1-6：波传播方向可视化；数据来自 blastingManager 逐帧计算） */
  setVectorField(data) {
    this.r._sceneBuilder.setVectorField(data || null)
  }

  /** 清空/隐藏矢量箭头场 */
  clearVectorField() {
    this.r._sceneBuilder.clearVectorField()
  }

  /**
   * 导出岩面顶点集（grid 局部系）+ 洞身整形参数，供等值线峰值场计算。
   * 含版本号（几何 build/爆后切换/剖切时自增），调用方据此判断是否重提取。
   */
  getContourSurface() {
    return this.r._sceneBuilder.getContourSurface() ?? null
  }

  /** 波场可达半径（= 爆心 → 岩体几何最远顶点，m；0=岩体尚未构建） */
  getInfluenceRadius() {
    return this.r._sceneBuilder.influenceRadius ?? 0
  }

  /** 下发等值线折线组（contourExtractor 输出）构建 Line2 渲染组 */
  setContourPolylines(data) {
    this.r._sceneBuilder.setContourPolylines(data)
  }

  /** 当前热力图渲染参数（displayMode/normMode/满刻度，等值线级别计算同口径） */
  getFieldRenderParams() {
    return this.r._sceneBuilder.getFieldRenderParams() ?? null
  }

  /** 当前是否已有可渲染的振动场（三场中任意一场有数据即视为已初始化） */
  hasVibrationField() {
    return !!this.r._vibrationFieldRenderer?.hasAnyField
  }

  /** 振动场元信息（供 UI 显示当前场时间/帧/网格） */
  getVibrationFieldInfo() {
    return this.r._vibrationFieldRenderer.getFieldInfo() ?? null
  }

  /** 设置振动场 raymarching 步数（性能/精度权衡） */
  setVibrationFieldRaySteps(n) {
    this.r._vibrationFieldRenderer?.setRaySteps(n)
  }
}
