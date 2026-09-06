/**
 * 爆破振动场数据持有者（PPV 振动 / σ_vm 应力 / 损伤分区 三模式）
 *
 * 本类负责通过 WebSocket / 本地模拟接收并存储球面波场的 3D 数据纹理
 * （PPV / 应力 / 损伤三场），并暴露给岩体模型（benchMesh）的着色材质使用。
 *
 * 设计说明（v2）：
 *  - 不再创建 raymarching 体积盒子（避免掌子面前方出现"红色方块"）。
 *  - 应力/损伤场直接渲染在实体岩体模型表面：threeBlastingRenderer 将本类持有的
 *    Data3DTexture 与 LUT 注入 benchMesh 的 ShaderMaterial，逐片元按世界坐标
 *    换算到 grid 局部坐标并采样取色，实现"在岩体上着色"的科学可视化。
 *
 * 数据流（三场同帧推送，t 对齐）：
 *   后端 ppv_field_3d / stress_field_from_ppv / damage_zone_classify
 *     → pack_ppv/stress/damage_binary (WebSocket 二进制帧, 大端)
 *     → blastingWsConnector._parsePpv/Stress/DamageField
 *     → 本类 updateField / updateStressField / updateDamageField (写 Data3DTexture)
 *     → threeBlastingRenderer 将纹理注入 benchMesh 材质 → 岩体表面着色
 *
 * 坐标系对齐：
 *   后端 grid 局部系: X=宽度, Y=高度, Z=前方(正)
 *   three.js 场景:    blastCenter 为原点, faceDirection=前方
 *   本类以 (right, up, forward) 基向量定义 grid 到世界的映射，
 *   使镜框的局部 (X,Y,Z) 与 grid (X,Y,Z) 严格对应。
 *
 * 参考：
 * - GB6722-2014 第 6.2 条 & 表 4（爆破振动安全允许标准）
 * - Persson P.A. et al. "The Rock Blasting Handbook", 1997（损伤分区 PPV 阈值）
 * - 胡英国等. 爆炸与冲击, 2015, 35(4):547-554（岩体爆破损伤临界值）
 * - three.js r169 Data3DTexture / WebGL2 sampler3D
 */
import * as THREE from 'three'

// 色阶常量：从 vibrationColorScales.js 单源 import（供材质着色使用）
import {
  PPV_COLOR_STOPS_LINEAR as GB6722_COLOR_STOPS,
  PPV_LUT_MAX_CMPS as LUT_MAX_CMPS,
  STRESS_COLOR_STOPS_LINEAR as STRESS_COLOR_STOPS,
  STRESS_LUT_MAX_MPA
} from './vibrationColorScales.js'

/** LUT 采样数（1D 纹理宽度） */
const LUT_SIZE = 256

/** σ_vm 低于此值（Pa）视为透明 */
const STRESS_VISIBLE_THRESHOLD_PA = 5.0e4 // 0.05 MPa

/** PPV 低于此值（cm/s）视为透明，避免场外围噪声淹没场景 */
const PPV_VISIBLE_THRESHOLD_CMPS = 0.1

/** 显示模式枚举（与材质 uDisplayMode 对应） */
const DISPLAY_MODE = { PPV: 0, STRESS: 1, DAMAGE: 2 }

// ─── LUT 构建 ─────────────────────────────────────────────────────

/**
 * 线性插值取色（GB6722 色阶）
 * @param {number} ppvCmps - PPV（cm/s）
 * @returns {[number,number,number]} [r,g,b] 0..1
 */
function sampleColorStops(ppvCmps) {
  const stops = GB6722_COLOR_STOPS
  if (ppvCmps <= stops[0][0]) return stops[0][1]
  if (ppvCmps >= stops[stops.length - 1][0]) return stops[stops.length - 1][1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i]
    const [p1, c1] = stops[i + 1]
    if (ppvCmps >= p0 && ppvCmps <= p1) {
      const k = (ppvCmps - p0) / (p1 - p0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return stops[stops.length - 1][1]
}

/**
 * 构建 GB6722 色阶 1D LUT 纹理（256×1 RGBA）
 * @param {[number,number[]][]} stops - 色阶 [v, [r,g,b]]
 * @param {number} max - 色阶上限
 * @returns {THREE.DataTexture}
 */
function buildLUT(stops, max) {
  const data = new Uint8Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const norm = i / (LUT_SIZE - 1)
    const val = norm * max
    let col = stops[stops.length - 1][1]
    if (val <= stops[0][0]) {
      col = stops[0][1]
    } else {
      for (let j = 0; j < stops.length - 1; j++) {
        const [p0, c0] = stops[j]
        const [p1, c1] = stops[j + 1]
        if (val >= p0 && val <= p1) {
          const k = (val - p0) / (p1 - p0)
          col = [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
          break
        }
      }
    }
    // alpha 曲线：低值更透、高值更实
    const a = Math.pow(norm, 0.7)
    data[i * 4] = Math.round(col[0] * 255)
    data[i * 4 + 1] = Math.round(col[1] * 255)
    data[i * 4 + 2] = Math.round(col[2] * 255)
    data[i * 4 + 3] = Math.round(a * 255)
  }
  const tex = new THREE.DataTexture(data, LUT_SIZE, 1, THREE.RGBAFormat)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

// ─── 数据持有类 ─────────────────────────────────────────────────────

export class BlastVibrationFieldRenderer {
  /**
   * @param {THREE.Scene} scene - 保留引用（兼容旧接口，不再持有 mesh）
   */
  constructor(scene) {
    this.scene = scene
    this._ppvTexture = null
    this._stressTexture = null
    this._damageTexture = null
    this._lutTexture = buildLUT(GB6722_COLOR_STOPS, LUT_MAX_CMPS)
    this._stressLutTexture = buildLUT(STRESS_COLOR_STOPS, STRESS_LUT_MAX_MPA)
    this._visible = true
    this._displayMode = DISPLAY_MODE.PPV
    // 场参数缓存
    this._gridShape = null
    this._boundsMin = null
    this._boundsMax = null
    this._center = null
    this._right = null
    this._up = null
    this._forward = null
    // 爆源（网格局部坐标，缺省网格原点）：解析外推/波环距离的波源位置
    this._blastOrigin = null
    this._lastT = -1
    this._lastFrame = -1
    // 各场是否已收到首帧
    this._hasPpv = false
    this._hasStress = false
    this._hasDamage = false
  }

  /**
   * 初始化（或重建）振动场数据纹理
   * @param {Object} cfg
   * @param {number[]} cfg.gridShape - [nx, ny, nz]
   * @param {number[]} cfg.boundsMin - [x,y,z] grid 边界下界
   * @param {number[]} cfg.boundsMax - [x,y,z] grid 边界上界
   * @param {THREE.Vector3} cfg.center - 爆心（grid 局部原点）世界坐标
   * @param {THREE.Vector3} cfg.right - 隧道宽度方向单位向量
   * @param {THREE.Vector3} cfg.up    - 竖直方向单位向量
   * @param {THREE.Vector3} cfg.forward - 掌子面朝向（前方）单位向量
   * @param {number[]|THREE.Vector3} [cfg.origin] - 爆源网格局部坐标（掏槽孔质心），缺省网格原点
   */
  init(cfg) {
    this.disposeMesh()
    const { gridShape, boundsMin, boundsMax, center, right, up, forward } = cfg
    this._gridShape = gridShape
    this._boundsMin = boundsMin
    this._boundsMax = boundsMax
    this._center = center
    this._right = right
    this._up = up
    this._forward = forward
    this._blastOrigin = cfg.origin ?? null

    const [nx, ny, nz] = gridShape
    const voxelCount = nx * ny * nz

    // Data3DTexture：单通道 float32。纹理轴序 u↔nx(width/right), v↔ny(height/up), w↔nz(depth/forward)
    const createTex = () => {
      const tex = new THREE.Data3DTexture(new Float32Array(voxelCount), nx, ny, nz)
      tex.format = THREE.RedFormat
      tex.type = THREE.FloatType
      tex.unpackAlignment = 4
      // 3D 场纹理保持最近邻采样；平滑插值在片元着色器内手动 trilinear 完成，
      // 不依赖 OES_texture_float_linear 扩展，保证所有 GPU 上色带连续（无方块色斑）。
      tex.minFilter = THREE.NearestFilter
      tex.magFilter = THREE.NearestFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.wrapR = THREE.ClampToEdgeWrapping
      tex.needsUpdate = true
      return tex
    }

    this._ppvTexture = createTex()
    this._stressTexture = createTex()
    this._damageTexture = createTex()
    this._voxelCount = voxelCount
  }

  /**
   * 更新 PPV 场数据（每收到一个 PPV 二进制帧调用一次）
   * @param {Float32Array} ppv - 宿主字节序 PPV 数组，长度须 = nx*ny*nz
   * @param {number} t - 模拟时间（秒）
   * @param {number} frame - 帧序号
   */
  updateField(ppv, t, frame) {
    if (!this._ppvTexture || !this._gridShape) return
    const [nx, ny, nz] = this._gridShape
    const expected = nx * ny * nz
    if (!ppv || ppv.length !== expected) {
      console.warn(
        '[BlastVibrationFieldRenderer] PPV length mismatch:',
        ppv?.length,
        'expected',
        expected
      )
      return
    }
    const tex = this._ppvTexture
    if (tex.image.data.length !== expected) {
      tex.image.data = new Float32Array(ppv)
    } else {
      tex.image.data.set(ppv)
    }
    tex.needsUpdate = true
    this._lastT = t
    this._lastFrame = frame
    this._hasPpv = true
  }

  /**
   * 更新 σ_vm 应力场（每收到一个 STRESS 二进制帧调用一次）
   * @param {Float32Array} sigmaVm - σ_vm 数组（Pa），长度须 = nx*ny*nz
   */
  updateStressField(sigmaVm) {
    if (!this._stressTexture || !this._gridShape) return
    const [nx, ny, nz] = this._gridShape
    const expected = nx * ny * nz
    if (!sigmaVm || sigmaVm.length !== expected) {
      console.warn(
        '[BlastVibrationFieldRenderer] stress length mismatch:',
        sigmaVm?.length,
        'expected',
        expected
      )
      return
    }
    const tex = this._stressTexture
    if (tex.image.data.length !== expected) {
      tex.image.data = new Float32Array(sigmaVm)
    } else {
      tex.image.data.set(sigmaVm)
    }
    tex.needsUpdate = true
    this._hasStress = true
  }

  /**
   * 更新损伤分区场（每收到一个 DAMAGE 二进制帧调用一次）
   * @param {Int8Array} zones - 分区 id 数组（0~4），长度须 = nx*ny*nz
   */
  updateDamageField(zones) {
    if (!this._damageTexture || !this._gridShape) return
    const [nx, ny, nz] = this._gridShape
    const expected = nx * ny * nz
    if (!zones || zones.length !== expected) {
      console.warn(
        '[BlastVibrationFieldRenderer] damage length mismatch:',
        zones?.length,
        'expected',
        expected
      )
      return
    }
    // int8 → float32 上传（兼容 sampler3D float 采样）
    const tex = this._damageTexture
    const data = tex.image.data
    if (data.length !== expected) {
      tex.image.data = new Float32Array(zones)
    } else {
      for (let i = 0; i < expected; i++) data[i] = zones[i]
    }
    tex.needsUpdate = true
    this._hasDamage = true
  }

  /**
   * 在世界坐标处采样振动场（点选拾取/查询某点 PPV 用）。
   *
   * 数据流：世界点 → 映射回 grid 局部坐标（左右/上下/前方基向量点积，顺序先 local→grid）
   *         → 归一化到 0..1 → 三线性插值取样 ppv/stress/damage 三场。
   * 该方法是纯增量查询，不修改任何现有场数据或渲染路径；
   * 直接读 Data3DTexture.image.data（宿主字节序），不依赖 GPU 采样，可在 node 下单测。
   *
   * 坐标映射约定（与材质一致）：grid 局部 X=宽度方向(right)、Y=高度方向(up)、Z=前方(forward)。
   * 世界坐标 → grid 局部坐标：取 (right,up,forward) 各基向量的归一化方量（原点为爆心 center），
   * 这是因为 right/up/forward 构成正交基，投影即得局部坐标。
   *
   * @param {THREE.Vector3|number[]} worldPos - 场景世界坐标 [x,y,z] 或 Vector3
   * @returns {null|{gridX:number,gridY:number,gridZ:number,inside:boolean,
   *                 local:[number,number,number], metric:number,
   *                 ppvCmps:number, stressMPa:number, zone:number}}
   *   - 世界点落出场盒外时返回 { inside:false, metric:0 }；无 PPV 场时返回 null。
   *   - ppvCmps 单位 cm/s；stressMPa 为 von Mises 应力（MPa）；zone 为损伤档位 0~4。
   *   - metric：归一化"命中强度"（0..1），用于表示该点在场网格内的置信度（立方体内为 1）。
   */
  sampleAtWorldPoint(worldPos) {
    if (!this._ppvTexture || !this._gridShape || !this._center) return null
    const [nx, ny, nz] = this._gridShape
    const data = this._ppvTexture.image.data
    const stressData = this._stressTexture?.image?.data
    const zoneData = this._damageTexture?.image?.data

    const [wx, wy, wz] = Array.isArray(worldPos) ? worldPos : [worldPos.x, worldPos.y, worldPos.z]
    const c = this._center
    // 世界→局部：(right,up,forward) 正交基投影（坐标 b ∈ [0,1]，center 为原点）
    const dx = wx - c.x
    const dy = wy - c.y
    const dz = wz - c.z
    // 局部坐标（right/up/forward 单位向量的点积 = 沿该轴投影距离）
    const r = this._right, u = this._up, f = this._forward
    let lx = dx * r.x + dy * r.y + dz * r.z
    let ly = dx * u.x + dy * u.y + dz * u.z
    let lz = dx * f.x + dy * f.y + dz * f.z

    const bmin = this._boundsMin, bmax = this._boundsMax
    // 归一化到网格内 0..1 的体素坐标（voxel center 对齐：i+0.5）
    const fx = (lx - bmin[0]) / (bmax[0] - bmin[0])
    const fy = (ly - bmin[1]) / (bmax[1] - bmin[1])
    const fz = (lz - bmin[2]) / (bmax[2] - bmin[2])
    const gx = fx * nx - 0.5
    const gy = fy * ny - 0.5
    const gz = fz * nz - 0.5

    const inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 && fz >= 0 && fz <= 1
    if (!inside) return { inside, gridX: 0, gridY: 0, gridZ: 0, local: [lx, ly, lz], metric: 0, ppvCmps: 0, stressMPa: 0, zone: 0 }

    // 越界 clamp（边界采样）
    const xi = Math.max(0, Math.min(nx - 2, Math.floor(gx)))
    const yi = Math.max(0, Math.min(ny - 2, Math.floor(gy)))
    const zi = Math.max(0, Math.min(nz - 2, Math.floor(gz)))
    const tx = Math.max(0, Math.min(1, gx - xi))
    const ty = Math.max(0, Math.min(1, gy - yi))
    const tz = Math.max(0, Math.min(1, gz - zi))
    const idx = (i, j, k) => (k * ny + j) * nx + i
    const trilinear = (src) =>
      src[idx(xi, yi, zi)] * (1 - tx) * (1 - ty) * (1 - tz) +
      src[idx(xi + 1, yi, zi)] * tx * (1 - ty) * (1 - tz) +
      src[idx(xi, yi + 1, zi)] * (1 - tx) * ty * (1 - tz) +
      src[idx(xi, yi, zi + 1)] * (1 - tx) * (1 - ty) * tz +
      src[idx(xi + 1, yi + 1, zi)] * tx * ty * (1 - tz) +
      src[idx(xi, yi + 1, zi + 1)] * (1 - tx) * ty * tz +
      src[idx(xi + 1, yi, zi + 1)] * tx * (1 - ty) * tz +
      src[idx(xi + 1, yi + 1, zi + 1)] * tx * ty * tz

    const ppvMps = trilinear(data)
    return {
      inside: true,
      gridX: gx, gridY: gy, gridZ: gz,
      local: [lx, ly, lz],
      metric: 1,
      ppvCmps: ppvMps * 100.0, // m/s → cm/s
      stressMPa: stressData ? trilinear(stressData) / 1e6 : null,
      zone: zoneData ? Math.round(trilinear(zoneData)) : null
    }
  }

  /** 当前场在世界坐标处的 PPV 值（cm/s）；失配/缺场返回 null。JS 层语义便捷封装。 */
  samplePpvAt(worldPos) {
    const s = this.sampleAtWorldPoint(worldPos)
    return s && s.inside ? s.ppvCmps : null
  }

  /**
   * 切换显示模式
   * @param {string|number} mode - 'ppv'|'stress'|'damage' 或 0|1|2
   */
  setDisplayMode(mode) {
    let m
    if (typeof mode === 'string') {
      m =
        mode === 'stress'
          ? DISPLAY_MODE.STRESS
          : mode === 'damage'
            ? DISPLAY_MODE.DAMAGE
            : DISPLAY_MODE.PPV
    } else {
      m =
        Number(mode) === DISPLAY_MODE.STRESS
          ? DISPLAY_MODE.STRESS
          : Number(mode) === DISPLAY_MODE.DAMAGE
            ? DISPLAY_MODE.DAMAGE
            : DISPLAY_MODE.PPV
    }
    this._displayMode = m
  }

  get displayMode() {
    return this._displayMode
  }

  /** 当前显示模式编号（0/1/2，供材质 uDisplayMode 使用） */
  get displayModeValue() {
    return this._displayMode
  }

  /**
   * 对外暴露场数据（供 threeBlastingRenderer 注入 benchMesh 材质）
   * @returns {{
   *   ppvTexture: THREE.Data3DTexture|null,
   *   stressTexture: THREE.Data3DTexture|null,
   *   damageTexture: THREE.Data3DTexture|null,
   *   lutTexture: THREE.DataTexture,
   *   stressLutTexture: THREE.DataTexture,
   *   boundsMin: number[]|null,
   *   boundsMax: number[]|null,
   *   gridShape: number[]|null,
   *   center: THREE.Vector3|null,
   *   right: THREE.Vector3|null,
   *   up: THREE.Vector3|null,
   *   forward: THREE.Vector3|null,
   *   stressRefMPa: number,
   *   ppvRefMps: number,
   *   thresholdMps: number,
   * }} 场数据
   */
  getFieldData() {
    return {
      ppvTexture: this._ppvTexture,
      stressTexture: this._stressTexture,
      damageTexture: this._damageTexture,
      lutTexture: this._lutTexture,
      stressLutTexture: this._stressLutTexture,
      boundsMin: this._boundsMin,
      boundsMax: this._boundsMax,
      gridShape: this._gridShape,
      center: this._center,
      right: this._right,
      up: this._up,
      forward: this._forward,
      blastOrigin: this._blastOrigin,
      stressRefMPa: STRESS_LUT_MAX_MPA,
      ppvRefMps: LUT_MAX_CMPS / 100.0,
      thresholdMps: PPV_VISIBLE_THRESHOLD_CMPS / 100.0,
      stressVisiblePa: STRESS_VISIBLE_THRESHOLD_PA
    }
  }

  setVisible(v) {
    this._visible = !!v
  }

  get visible() {
    return this._visible
  }

  setOpacity() {} // 兼容旧接口：不再使用体积不透明度

  setRaySteps() {} // 兼容旧接口：不再使用 raymarch 步数

  /** 当前显示模式是否有可渲染的场（已 init 且至少收到过一帧数据） */
  get hasField() {
    if (!this._gridShape) return false
    if (this._displayMode === DISPLAY_MODE.STRESS) return this._hasStress
    if (this._displayMode === DISPLAY_MODE.DAMAGE) return this._hasDamage
    return this._hasPpv
  }

  /** 三场中任意一场是否有数据 */
  get hasAnyField() {
    if (!this._gridShape) return false
    return this._hasPpv || this._hasStress || this._hasDamage
  }

  /** 最近帧元信息（供 UI 显示当前场时间/帧/模式） */
  getFieldInfo() {
    const modeName =
      this._displayMode === DISPLAY_MODE.STRESS
        ? 'stress'
        : this._displayMode === DISPLAY_MODE.DAMAGE
          ? 'damage'
          : 'ppv'
    return {
      gridShape: this._gridShape,
      boundsMin: this._boundsMin,
      boundsMax: this._boundsMax,
      lastT: this._lastT,
      lastFrame: this._lastFrame,
      voxelCount: this._voxelCount,
      displayMode: modeName,
      hasPpv: this._hasPpv,
      hasStress: this._hasStress,
      hasDamage: this._hasDamage
    }
  }

  /** 释放 3D 纹理（LUT 在 dispose 中释放） */
  disposeMesh() {
    if (this._ppvTexture) {
      this._ppvTexture.dispose()
      this._ppvTexture = null
    }
    if (this._stressTexture) {
      this._stressTexture.dispose()
      this._stressTexture = null
    }
    if (this._damageTexture) {
      this._damageTexture.dispose()
      this._damageTexture = null
    }
    this._gridShape = null
    this._boundsMin = null
    this._boundsMax = null
    this._center = null
    this._right = null
    this._up = null
    this._forward = null
    this._blastOrigin = null
    this._lastFrame = -1
    this._lastT = -1
    this._hasPpv = false
    this._hasStress = false
    this._hasDamage = false
  }

  /** 完全销毁（含 LUT） */
  dispose() {
    this.disposeMesh()
    if (this._lutTexture) {
      this._lutTexture.dispose()
      this._lutTexture = null
    }
    if (this._stressLutTexture) {
      this._stressLutTexture.dispose()
      this._stressLutTexture = null
    }
  }
}