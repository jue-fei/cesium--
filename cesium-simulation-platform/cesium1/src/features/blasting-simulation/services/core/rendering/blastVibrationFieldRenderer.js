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

/** 显示模式枚举（与材质 uDisplayMode 对应） */
const DISPLAY_MODE = { PPV: 0, STRESS: 1, DAMAGE: 2 }

// ─── 3D 可分离高斯平滑（损伤场去像素化） ─────────────────────────
//
// 损伤分区在数据层是"整数档位 0~4"（elastic→throw），配合较粗的体素网格，即使
// 片元着色器做了三线性，离散整数阶跃仍会在隧道轮廓/损伤外沿形成"红色像素方块"
// 和生硬矩形边界。此处对写入纹素的整型分区做一次 3D 高斯卷积，把整数档位磨成
// 连续的浮点场（0~4 带小数，含跨挡平滑过渡），再由 shader 三线性 + LUT 线性取色，
// 得到全程连续的损伤梯度——像素块与矩形硬边界一并消除。
//
// 是可分离卷积（X→Y→Z 三次一维卷积），复杂度 O(N·(2r+1)·3)，远优于全 3D 核。

/**
 * 沿指定轴对三维场做一维高斯卷积（可分离 3D 高斯的第一步）。
 * @param {Float32Array} inp  输入（只读）
 * @param {Float32Array} out  输出（就地覆盖）
 * @param {number} nx,ny,nz    体素尺寸
 * @param {number} axis         0=X(步长1) 1=Y(步长nx) 2=Z(步长nx*ny)
 * @param {Float32Array} weights 一维高斯核（中心对称，(2r+1) 元素）
 * @param {number} r           核半径
 */
function _convAxis(inp, out, nx, ny, nz, axis, weights, r) {
  out.fill(0)
  const w = weights
  if (axis === 0) {
    const sY = nx,
      sZ = nx * ny
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const base = j * sY + k * sZ
        for (let i = 0; i < nx; i++) {
          let acc = 0
          for (let kk = -r; kk <= r; kk++) {
            let ii = i + kk
            if (ii < 0) ii = 0
            else if (ii >= nx) ii = nx - 1
            acc += inp[base + ii] * w[kk + r]
          }
          out[base + i] = acc
        }
      }
    }
  } else if (axis === 1) {
    const sX = 1,
      sZ = nx * ny
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const base = i * sX + k * sZ
        for (let j = 0; j < ny; j++) {
          let acc = 0
          for (let kk = -r; kk <= r; kk++) {
            let jj = j + kk
            if (jj < 0) jj = 0
            else if (jj >= ny) jj = ny - 1
            acc += inp[base + jj * nx] * w[kk + r]
          }
          out[base + j * nx] = acc
        }
      }
    }
  } else {
    const sY = nx
    const sZ = nx * ny
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const base = i + j * sY
        for (let k = 0; k < nz; k++) {
          let acc = 0
          for (let kk = -r; kk <= r; kk++) {
            let kkk = k + kk
            if (kkk < 0) kkk = 0
            else if (kkk >= nz) kkk = nz - 1
            acc += inp[base + kkk * sZ] * w[kk + r]
          }
          out[base + k * sZ] = acc
        }
      }
    }
  }
}

// ─── LUT 构建 ─────────────────────────────────────────────────────

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
          col = [
            c0[0] + (c1[0] - c0[0]) * k,
            c0[1] + (c1[1] - c0[1]) * k,
            c0[2] + (c1[2] - c0[2]) * k
          ]
          break
        }
      }
    }
    // alpha 通道未参与着色（shader 仅取 .rgb），固定不透明
    data[i * 4] = Math.round(col[0] * 255)
    data[i * 4 + 1] = Math.round(col[1] * 255)
    data[i * 4 + 2] = Math.round(col[2] * 255)
    data[i * 4 + 3] = 255
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
    // 洞身几何参数 getter（遮挡/轴向延展修正用，渲染层注入）
    this._holeGeomProvider = null
    this._lastT = -1
    this._lastFrame = -1
    // 各场是否已收到首帧
    this._hasPpv = false
    this._hasStress = false
    this._hasDamage = false
    // 连续场数据层高斯平滑（替代屏幕空间抖动去带条）；默认 0.8 体素
    this._fieldBlurSigma = 0.4
    this._fieldBlurBuf = null
    this._fieldBlurTmp = null
    this._fieldBlurKernel = null
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
      // 【颗粒感根因 → LinearFilter + Mipmap】旧版用 NearestFilter → 粗网格(1.5m)
      // 整格量化采样,叠加 14 档硬色阶 → 网格级马赛克。LinearFilter + Mipmap 让 GPU
      // 在不同 LOD 自带硬件三线性(并自动 mipmap 内 mip 插值),这是工程图常见做法
      // (用户取证 dump_frame.py 1.5m 网格本身光滑,马赛克纯属采样方式问题)。
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.wrapR = THREE.ClampToEdgeWrapping
      tex.generateMipmaps = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      // 各向异性过滤：3D 场纹理在倾斜/斜视角岩面上若用正方形 mip 主干会被拉到
      // 低分辨率 → 整片"糊"。设 anisotropy 让斜向采样走各向异性 mip，近处细节
      // （多源干涉峰值/梯度）在斜视下仍保持锐利（three 仅硬件支持时启用，无害）。
      tex.anisotropy = 8
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
    this._blurInto(tex, ppv, this._fieldBlurSigma)
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
    this._blurInto(tex, sigmaVm, this._fieldBlurSigma)
    tex.needsUpdate = true
    this._hasStress = true
  }

  /**
   * 设置损伤场 3D 高斯平滑强度（体素单位，0=关闭）。
   * 默认开启，把离散整数分区磨成连续浮点场，消除"红色像素方块"与矩形硬边界。
   * @param {number} sigma
   */
  setDamageBlurSigma(sigma) {
    this._dmgBlurSigma = Number.isFinite(Number(sigma)) && Number(sigma) >= 0 ? Number(sigma) : 1.2
  }

  /**
   * 设置 PPV/应力连续场的数据层高斯平滑强度（体素单位，0=关闭）。
   * 用于替代屏幕空间抖动：在数据写入 3D 纹理前磨掉粗网格阶梯，使色带自然均匀，
   * 不引入任何"雪花/颗粒"噪声。
   * 默认 σ=0.4 体素（抹平相邻体素阶跃防马赛克，保留多源干涉的包络梯度；
   * 过高 σ 会把这些细节糊成一团）。
   * @param {number} sigma
   */
  setFieldBlurSigma(sigma) {
    this._fieldBlurSigma =
      Number.isFinite(Number(sigma)) && Number(sigma) >= 0 ? Number(sigma) : 0.4
  }

  /**
   * 把一块连续场写入纹理，若 sigma>0 先做 3D 可分离高斯平滑（复用 _convAxis）。
   * 使用共享缓冲避免每帧 GC；与损伤场平滑同口径（X→Y→Z 三趟一维卷积）。
   * @param {THREE.Data3DTexture} tex
   * @param {Float32Array} arr - 宿主字节序源数据（只读）
   * @param {number} sigma - 0=不平滑直接写入
   */
  _blurInto(tex, arr, sigma) {
    const [nx, ny, nz] = this._gridShape
    const expected = nx * ny * nz
    let data = tex.image.data
    if (data.length !== expected) {
      data = new Float32Array(expected)
      tex.image.data = data
    }
    if (sigma == null || sigma <= 0.001) {
      for (let i = 0; i < expected; i++) data[i] = arr[i]
      return
    }
    let src = this._fieldBlurBuf
    if (!src || src.length !== expected) {
      src = new Float32Array(expected)
      this._fieldBlurBuf = src
    }
    for (let i = 0; i < expected; i++) src[i] = arr[i]
    const r = Math.max(1, Math.round(sigma * 2))
    let w = this._fieldBlurKernel
    if (!w || w.length !== 2 * r + 1) {
      w = new Float32Array(2 * r + 1)
      let sum = 0
      for (let k = -r; k <= r; k++) {
        const v = Math.exp(-(k * k) / (2 * sigma * sigma))
        w[k + r] = v
        sum += v
      }
      for (let i = 0; i < w.length; i++) w[i] /= sum
      this._fieldBlurKernel = w
    }
    let tmp = this._fieldBlurTmp
    if (!tmp || tmp.length !== expected) {
      tmp = new Float32Array(expected)
      this._fieldBlurTmp = tmp
    }
    _convAxis(src, tmp, nx, ny, nz, 0, w, r)
    _convAxis(tmp, data, nx, ny, nz, 1, w, r)
    _convAxis(data, tmp, nx, ny, nz, 2, w, r)
    for (let i = 0; i < expected; i++) data[i] = tmp[i]
  }

  /**
   * 更新损伤分区场（每收到一个 DAMAGE 二进制帧调用一次）
   * @param {Int8Array|Float32Array|ArrayBuffer} zones - 分区值数组（0~4），长度须 = nx*ny*nz；
   *   支持整型分区（离散档位）或已达连续的浮点场（本类直接上传）
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
    const tex = this._damageTexture
    let data = tex.image.data
    if (data.length !== expected) data = new Float32Array(expected)

    const sigma = this._dmgBlurSigma == null ? 1.2 : this._dmgBlurSigma

    if (sigma <= 0.001) {
      // 平滑关闭：直接按值上传（不区分 int/float）
      for (let i = 0; i < expected; i++) data[i] = zones[i]
    } else {
      // 先把源数据读进临时浮点缓冲（zones 可能是单字节视图，不能就地卷积）
      let src = this._dmgBlurBuf
      if (!src || src.length !== expected) {
        src = new Float32Array(expected)
        this._dmgBlurBuf = src
      }
      for (let i = 0; i < expected; i++) src[i] = zones[i]

      const r = Math.max(1, Math.round(sigma * 2))
      let w = this._dmgBlurKernel
      if (!w || w.length !== 2 * r + 1) {
        w = new Float32Array(2 * r + 1)
        let sum = 0
        for (let k = -r; k <= r; k++) {
          const v = Math.exp(-(k * k) / (2 * sigma * sigma))
          w[k + r] = v
          sum += v
        }
        for (let i = 0; i < w.length; i++) w[i] /= sum
        this._dmgBlurKernel = w
      }

      // 亮场再均衡：平滑把整数档位 0/1/2/3/4 各向邻域扩散，中心峰被削低。为保证
      // 损伤核心（zone≥3/4）仍保持强红、外沿渐弱，卷积后沿 LUT 整体提升，恢复峰值档。
      const pass = (inp, out, axis) => _convAxis(inp, out, nx, ny, nz, axis, w, r)

      let tmp = this._dmgBlurTmp
      if (!tmp || tmp.length !== expected) {
        tmp = new Float32Array(expected)
        this._dmgBlurTmp = tmp
      }
      pass(src, tmp, 0)
      pass(tmp, data, 1)
      pass(data, tmp, 2)
      // tmp 为最终 X→Y→Z 三次卷积结果
      for (let i = 0; i < expected; i++) data[i] = tmp[i]
      // （每点已被归一化权重加权，区间仍在 [min,max]，无须额外 clamp 到 0~4）
    }

    tex.image.data = data
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
    const r = this._right,
      u = this._up,
      f = this._forward
    let lx = dx * r.x + dy * r.y + dz * r.z
    let ly = dx * u.x + dy * u.y + dz * u.z
    let lz = dx * f.x + dy * f.y + dz * f.z

    const bmin = this._boundsMin,
      bmax = this._boundsMax
    // 归一化到网格内 0..1 的体素坐标（voxel center 对齐：i+0.5）
    const fx = (lx - bmin[0]) / (bmax[0] - bmin[0])
    const fy = (ly - bmin[1]) / (bmax[1] - bmin[1])
    const fz = (lz - bmin[2]) / (bmax[2] - bmin[2])
    const gx = fx * nx - 0.5
    const gy = fy * ny - 0.5
    const gz = fz * nz - 0.5

    const inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 && fz >= 0 && fz <= 1
    if (!inside)
      return {
        inside,
        gridX: 0,
        gridY: 0,
        gridZ: 0,
        local: [lx, ly, lz],
        metric: 0,
        ppvCmps: 0,
        stressMPa: 0,
        zone: 0
      }

    // 越界 clamp（边界采样）
    const xi = Math.max(0, Math.min(nx - 2, Math.floor(gx)))
    const yi = Math.max(0, Math.min(ny - 2, Math.floor(gy)))
    const zi = Math.max(0, Math.min(nz - 2, Math.floor(gz)))
    const tx = Math.max(0, Math.min(1, gx - xi))
    const ty = Math.max(0, Math.min(1, gy - yi))
    const tz = Math.max(0, Math.min(1, gz - zi))
    const idx = (i, j, k) => (k * ny + j) * nx + i
    const trilinear = src =>
      src[idx(xi, yi, zi)] * (1 - tx) * (1 - ty) * (1 - tz) +
      src[idx(xi + 1, yi, zi)] * tx * (1 - ty) * (1 - tz) +
      src[idx(xi, yi + 1, zi)] * (1 - tx) * ty * (1 - tz) +
      src[idx(xi, yi, zi + 1)] * (1 - tx) * (1 - ty) * tz +
      src[idx(xi + 1, yi + 1, zi)] * tx * ty * (1 - tz) +
      src[idx(xi, yi + 1, zi + 1)] * (1 - tx) * ty * tz +
      src[idx(xi + 1, yi, zi + 1)] * tx * (1 - ty) * tz +
      src[idx(xi + 1, yi + 1, zi + 1)] * tx * ty * tz

    // 洞身遮挡/轴向延展修正：与 sceneBuilder.js 片元 shader 同款后因子（纹理数据
    // 不含这两个纯几何显示修正），点选值乘同款系数 → 与屏幕热力图颜色同口径。
    const occAgn = this._occlusionAxialGain(lx, ly, lz)
    const ppvMps = trilinear(data) * occAgn
    return {
      inside: true,
      gridX: gx,
      gridY: gy,
      gridZ: gz,
      local: [lx, ly, lz],
      metric: 1,
      ppvCmps: ppvMps * 100.0, // m/s → cm/s
      stressMPa: stressData ? (trilinear(stressData) * occAgn) / 1e6 : null,
      zone: zoneData ? Math.round(trilinear(zoneData)) : null
    }
  }

  /**
   * 洞身遮挡×轴向延展后因子（与 sceneBuilder.js holeOcclusion/axialGain 同源同值）。
   * holeGeom 由渲染层经 setHoleGeomProvider 注入 getter（岩体重建后自动取最新），
   * 缺省（无隧道几何信息）时返回 1，退化为纯数据值。
   */
  _occlusionAxialGain(lx, ly, lz) {
    // 【洞身遮挡已禁用】与 sceneBuilder.js 着色器同口径：视线-圆柱求交的近似
    // 会在岩面上产生一对直线切线投影（X 形/斜向黑影伪影），已关闭。
    // 保留轴向延展因子 agn（uLateralAttn≈0.95，幅值温和、无直线边界）。
    const hg = this._holeGeomProvider?.()
    if (!hg) return 1
    const o = this._blastOrigin
    if (!o) return 1
    const ox = Number(o.x ?? o[0]) || 0
    const oy = Number(o.y ?? o[1]) || 0
    const oz = Number(o.z ?? o[2]) || 0
    const px = lx - ox
    const py = ly - oy
    const pz = lz - oz
    const plen = Math.sqrt(px * px + py * py + pz * pz)
    if (plen < 1e-3) return 1
    const ss = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    const ax = pz / plen // 局部 +z = 隧道轴向
    const lat = hg.lateralAttn ?? 0.95
    return lat + (1 - lat) * ss(0.0, 0.55, Math.abs(ax))
  }

  /** 注入洞身几何参数 getter：() => ({radius, len, lateralAttn}) | null */
  setHoleGeomProvider(fn) {
    this._holeGeomProvider = fn
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
      ppvRefMps: LUT_MAX_CMPS / 100.0
    }
  }

  setVisible(v) {
    this._visible = !!v
  }

  get visible() {
    return this._visible
  }

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

  /**
   * 【Seek 清屏】把 PPV/应力/损伤三张 3D 纹理数据全部清零并标记重传。
   *
   * 拖动进度条后"糊成色块"的直接来源：GPU 纹理里仍驻留着 seek 前的场数据
   * （峰值/损伤是"未来帧最大值"，应力是旧时刻切片），新帧落地前着色器读到的
   * 是新旧混合内容。清零后在新帧到达前不再显示任何残留。
   * 不改 hasField 标志：图层保持开启，只是内容为空（等价于阻塞读取旧数据）。
   */
  clearFieldTextures() {
    for (const tex of [this._ppvTexture, this._stressTexture, this._damageTexture]) {
      const data = tex && tex.image && tex.image.data
      if (data && typeof data.fill === 'function') {
        data.fill(0)
        tex.needsUpdate = true
      }
    }
    this._lastFrame = -1
    this._lastT = -1
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
