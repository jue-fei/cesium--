/**
 * 爆破振动场体积渲染器（PPV 振动 / σ_vm 应力 / 损伤分区 三模式）
 *
 * 基于 Three.js Data3DTexture + GLSL raymarching 实现球面波场的体积可视化，
 * 通过 uDisplayMode 在三种物理量间切换：
 *   - PPV(0)：质点峰值速度（GB6722-2014 安全允许标准色阶，cm/s）
 *   - STRESS(1)：σ_vm 等效应力（岩石力学色阶，Pa→MPa，6 MPa=抗拉下限阈值）
 *   - DAMAGE(2)：Persson 损伤分区（离散 5 色，0~4 弹性→抛掷）
 *
 * 数据流（三场同帧推送，t 对齐）：
 *   后端 ppv_field_3d / stress_field_from_ppv / damage_zone_classify
 *     → pack_ppv/stress/damage_binary (WebSocket 二进制帧, 大端)
 *     → blastingWsConnector._parsePpv/Stress/DamageField
 *     → 本渲染器 updateField / updateStressField / updateDamageField (写 Data3DTexture)
 *     → GLSL raymarching 按 uDisplayMode 采样 + LUT/离散取色 → 半透明体积叠加场景
 *
 * 坐标系对齐：
 *   后端 grid 局部系: X=宽度, Y=高度, Z=前方(正)
 *   three.js 场景:    blastCenter 为原点, faceDirection=前方
 *   本渲染器以 makeBasis(right, up, forward) 构造 box 朝向，
 *   使 box 局部 (X,Y,Z) 与 grid (X,Y,Z) 严格对应，
 *   从而纹理采样轴序与后端 np.meshgrid(indexing='ij') 一致。
 *
 * 参考：
 * - GB6722-2014 第 6.2 条 & 表 4（爆破振动安全允许标准）
 * - Persson P.A. et al. "The Rock Blasting Handbook", 1997（损伤分区 PPV 阈值）
 * - 胡英国等. 爆炸与冲击, 2015, 35(4):547-554（岩体爆破损伤临界值）
 * - three.js r169 Data3DTexture / WebGL2 sampler3D
 * - Engel et al., Real-Time Volume Graphics (2006), ray-box intersection & compositing
 */
import * as THREE from 'three'

// ─── GB6722-2014 PPV 色阶（cm/s）────────────────────────────────────
// 色阶依据《爆破安全规程》GB6722-2014 表4 安全允许标准设计：
//   ≤1.0   住宅类建筑安全阈值（蓝-青，安全）
//   1~2    一般民用建筑轻微振动（青-绿）
//   2~4    商业/工业建筑（绿-黄，注意）
//   4~7    结构显著响应（黄-橙，强）
//   7~10   矿山巷道软岩阈值（橙-红，损伤）
//   >10    矿山巷道硬岩阈值/严重损伤（红-品红）
// 注：后端 PPV 单位为 m/s（=cm/s×0.01），色阶按 cm/s 定义，shader 内做 ×100 换算。
// 色阶常量统一从 vibrationColorScales.js 单源 import（消除与 VisualOptions.vue 的双份维护）
import {
  PPV_COLOR_STOPS_LINEAR as GB6722_COLOR_STOPS,
  PPV_LUT_MAX_CMPS as LUT_MAX_CMPS,
  STRESS_COLOR_STOPS_LINEAR as STRESS_COLOR_STOPS,
  STRESS_LUT_MAX_MPA,
  DAMAGE_ZONES as DAMAGE_ZONES_SRC
} from './vibrationColorScales.js'

/** LUT 采样数（1D 纹理宽度） */
const LUT_SIZE = 256
// LUT_MAX_CMPS 已从 vibrationColorScales.js 单源 import（见上方 import 块）

// ─── 体积渲染参数 ─────────────────────────────────────────────────
const DEFAULT_RAY_STEPS = 48
const DEFAULT_OPACITY = 0.55
/** PPV 低于此值（cm/s）视为透明，避免场外围噪声淹没场景 */
const PPV_VISIBLE_THRESHOLD_CMPS = 0.3

// ─── GLSL 着色器 ──────────────────────────────────────────────────
const VOLUME_VERTEX_SHADER = /* glsl */ `precision highp float;
precision highp sampler3D;

// box 顶点局部坐标（BoxGeometry 默认 ±0.5，单位几何体）
// position/normal/modelViewMatrix/projectionMatrix 由 Three.js ShaderMaterial（GLSL3）自动注入

// 传递给片元的 box 局部归一化坐标（±0.5）
// 注意：真实尺度由 mesh.matrix（含 right/up/forward 缩放列）承担，
// 故这里直接透传 position，无需在 shader 中再乘 uBoxSize。
out vec3 vObjPos;

void main() {
  vObjPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const VOLUME_FRAGMENT_SHADER = /* glsl */ `precision highp float;
precision highp sampler3D;

uniform sampler3D uPpvTexture;     // PPV 标量场（R 通道，单位 m/s）
uniform sampler3D uStressTexture;  // σ_vm 等效应力场（R 通道，单位 Pa）
uniform sampler3D uDamageTexture;  // 损伤分区场（R 通道，float 0~4）
uniform sampler2D uLut;            // GB6722 PPV 色阶 LUT（256×1 RGBA）
uniform sampler2D uStressLut;      // σ_vm 应力色阶 LUT
uniform vec3  uCameraPosObj;       // 相机在 box 局部系下的坐标（±0.5 范围）
uniform float uRaySteps;           // 射线步进数
uniform float uOpacity;            // 整体不透明度
uniform float uPpvRefMps;          // 色阶参考 PPV（m/s，=LUT上限）
uniform float uThresholdMps;       // PPV 可见阈值（m/s）
uniform float uStressRefMPa;       // 应力色阶上限（MPa）
uniform float uStressVisibleThresholdPa; // σ_vm 可见阈值（Pa）
uniform int   uDisplayMode;        // 0=PPV, 1=STRESS, 2=DAMAGE

in vec3 vObjPos;
out vec4 fragColor;

// ray-box 求交（box 范围 ±0.5 在 box 局部坐标系）
bool intersectBox(vec3 rayOrigin, vec3 rayDir, out float tNear, out float tFar) {
  vec3 invDir = 1.0 / max(abs(rayDir), vec3(1e-8));
  vec3 t1 = (-0.5 - rayOrigin) * invDir;
  vec3 t2 = ( 0.5 - rayOrigin) * invDir;
  vec3 tmin = min(t1, t2);
  vec3 tmax = max(t1, t2);
  tNear = max(max(tmin.x, tmin.y), tmin.z);
  tFar  = min(min(tmax.x, tmax.y), tmax.z);
  return tFar >= max(tNear, 0.0);
}

// 损伤分区离散取色（zone 0~4）；返回 rgba，alpha 为强度因子（不含 uOpacity）
vec4 damageColor(float zone) {
  if (zone < 0.5) return vec4(0.0);                 // 0 elastic 透明不渲染
  vec3 col;
  if (zone < 1.5)      col = vec3(0.90, 0.85, 0.30); // 1 micro_crack 浅黄
  else if (zone < 2.5) col = vec3(0.95, 0.55, 0.15); // 2 crack_growth 橙
  else if (zone < 3.5) col = vec3(0.90, 0.20, 0.15); // 3 fracture 红
  else                 col = vec3(0.60, 0.05, 0.10); // 4 throw 深红
  // 强度因子随分区加深而增大，保证破碎/抛掷区更实
  float strength = 0.55 + zone * 0.10;
  return vec4(col, strength);
}

// 按 uDisplayMode 采样当前场并取色；返回 alpha 为强度因子（不含 uOpacity）
vec4 sampleFieldColor(vec3 uvw) {
  if (uDisplayMode == 1) {
    // σ_vm 等效应力场（Pa → MPa 归一化）
    float sigmaPa = texture(uStressTexture, uvw).r;
    if (sigmaPa < uStressVisibleThresholdPa) return vec4(0.0);
    float mpa = sigmaPa / 1.0e6;
    float norm = clamp(mpa / max(uStressRefMPa, 1e-6), 0.0, 1.0);
    vec4 c = texture(uStressLut, vec2(norm, 0.5));
    c.a *= smoothstep(0.0, 0.15, norm);
    return c;
  } else if (uDisplayMode == 2) {
    // 损伤分区（float 0~4，离散取色）
    float zone = texture(uDamageTexture, uvw).r;
    return damageColor(zone);
  }
  // 默认：PPV 振动场（m/s）
  float ppvMps = texture(uPpvTexture, uvw).r;
  float ppvCmps = ppvMps * 100.0;
  if (ppvCmps < uThresholdMps) return vec4(0.0);
  float norm = clamp(ppvMps / max(uPpvRefMps, 1e-6), 0.0, 1.0);
  vec4 c = texture(uLut, vec2(norm, 0.5));
  c.a *= smoothstep(0.0, 0.15, norm);
  return c;
}

void main() {
  // 在 box 局部归一化坐标系（±0.5）中重建射线
  vec3 surfaceObj = vObjPos;
  vec3 camObj = uCameraPosObj;
  vec3 rayDir = normalize(surfaceObj - camObj);

  float tNear, tFar;
  if (!intersectBox(camObj, rayDir, tNear, tFar)) {
    discard;
  }
  float tStart = max(tNear, 0.0);
  float tEnd = tFar;
  float dt = (tEnd - tStart) / uRaySteps;

  // 前向累积（front-to-back compositing）
  vec4 accum = vec4(0.0);
  float transmittance = 1.0;

  for (float t = tStart + dt * 0.5; t < tEnd; t += dt) {
    vec3 pObj = camObj + rayDir * t;            // box 局部坐标 ±0.5
    vec3 uvw = pObj + 0.5;                      // 纹理坐标 [0,1]
    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) continue;

    // 按 displayMode 取色，alpha 为强度因子
    vec4 color = sampleFieldColor(uvw);
    float sampleAlpha = color.a * uOpacity;
    if (sampleAlpha <= 0.001) continue;

    // 前向累积公式：C_acc += T_i * α_i * C_i ;  T *= (1 - α_i)
    accum.rgb += transmittance * sampleAlpha * color.rgb;
    accum.a   += transmittance * sampleAlpha;
    transmittance *= (1.0 - sampleAlpha);

    // 透射率足够低时提前退出（opacity correction）
    if (transmittance < 0.03) break;
  }

  if (accum.a <= 0.001) discard;
  fragColor = vec4(accum.rgb, accum.a);
}
`

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
 * 横轴为归一化 PPV [0,1]，对应 [0, LUT_MAX_CMPS] cm/s
 * @returns {THREE.DataTexture}
 */
function buildPpvLUT() {
  const data = new Uint8Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const norm = i / (LUT_SIZE - 1)
    const ppvCmps = norm * LUT_MAX_CMPS
    const [r, g, b] = sampleColorStops(ppvCmps)
    // alpha 曲线：低值更透、高值更实，增强层次感
    const a = Math.pow(norm, 0.7)
    data[i * 4] = Math.round(r * 255)
    data[i * 4 + 1] = Math.round(g * 255)
    data[i * 4 + 2] = Math.round(b * 255)
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

// ─── σ_vm 等效应力色阶（MPa，岩石力学）────────────────────────────
// 色阶阈值依据中硬岩力学强度设计：
//   σ_t≈6~10 MPa（抗拉强度）：6 MPa 达下限→拉裂起裂（黄）
//   σ_c≈80~120 MPa（抗压强度）：远场不会达到，仅近场破碎区接近
//   σ_vm 弹性反演范围通常 0.1~10 MPa（中远场），近场可达数十 MPa（弹性失效）
// STRESS_COLOR_STOPS 与 STRESS_LUT_MAX_MPA 已从 vibrationColorScales.js import
/** σ_vm 低于此值（Pa）视为透明 */
const STRESS_VISIBLE_THRESHOLD_PA = 1.0e5 // 0.1 MPa

// ─── 损伤分区离散色（Persson 模型 0~4）─────────────────────────────
// 与后端 DAMAGE_ZONE_LABELS 对应；zone=0 弹性区透明不显示，
// 避免大范围弹性区淹没场景，仅显示有损伤的区域（zone≥1）。
const DAMAGE_ZONE_COLORS = [
  [0.3, 0.3, 0.35, 0.0], // 0 elastic      灰  透明（不渲染）
  [0.9, 0.85, 0.3, 0.55], // 1 micro_crack  浅黄
  [0.95, 0.55, 0.15, 0.7], // 2 crack_growth 橙
  [0.9, 0.2, 0.15, 0.8], // 3 fracture     红
  [0.6, 0.05, 0.1, 0.85] // 4 throw        深红
]

/** 显示模式枚举（与 shader uDisplayMode 对应） */
const DISPLAY_MODE = { PPV: 0, STRESS: 1, DAMAGE: 2 }

/**
 * 构建 σ_vm 应力色阶 1D LUT 纹理（256×1 RGBA）
 * 横轴为归一化 σ_vm [0,1]，对应 [0, STRESS_LUT_MAX_MPA] MPa
 * @returns {THREE.DataTexture}
 */
function buildStressLUT() {
  const stops = STRESS_COLOR_STOPS
  const data = new Uint8Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const norm = i / (LUT_SIZE - 1)
    const mpa = norm * STRESS_LUT_MAX_MPA
    // 线性插值取色
    let col = stops[stops.length - 1][1]
    if (mpa <= stops[0][0]) {
      col = stops[0][1]
    } else {
      for (let j = 0; j < stops.length - 1; j++) {
        const [p0, c0] = stops[j]
        const [p1, c1] = stops[j + 1]
        if (mpa >= p0 && mpa <= p1) {
          const k = (mpa - p0) / (p1 - p0)
          col = [
            c0[0] + (c1[0] - c0[0]) * k,
            c0[1] + (c1[1] - c0[1]) * k,
            c0[2] + (c1[2] - c0[2]) * k
          ]
          break
        }
      }
    }
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

// ─── 渲染器类 ─────────────────────────────────────────────────────

export class BlastVibrationFieldRenderer {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene
    this._mesh = null
    this._material = null
    this._geometry = null
    this._ppvTexture = null
    this._stressTexture = null
    this._damageTexture = null
    this._lutTexture = buildPpvLUT()
    this._stressLutTexture = buildStressLUT()
    this._visible = true
    this._opacity = DEFAULT_OPACITY
    this._raySteps = DEFAULT_RAY_STEPS
    this._displayMode = DISPLAY_MODE.PPV
    // 场参数缓存
    this._gridShape = null
    this._boundsMin = null
    this._boundsMax = null
    this._lastT = -1
    this._lastFrame = -1
    // 各场是否已收到首帧（用于 hasField 判定与 UI 提示）
    this._hasPpv = false
    this._hasStress = false
    this._hasDamage = false
  }

  /**
   * 初始化（或重建）振动场体积
   * @param {Object} cfg
   * @param {number[]} cfg.gridShape - [nx, ny, nz]
   * @param {number[]} cfg.boundsMin - [x,y,z] grid 边界下界
   * @param {number[]} cfg.boundsMax - [x,y,z] grid 边界上界
   * @param {THREE.Vector3} cfg.center - 爆心（box 局部原点对齐处）世界坐标
   * @param {THREE.Vector3} cfg.right - 隧道宽度方向单位向量
   * @param {THREE.Vector3} cfg.up    - 竖直方向单位向量
   * @param {THREE.Vector3} cfg.forward - 掌子面朝向（前方）单位向量
   */
  init(cfg) {
    this.disposeMesh()
    const { gridShape, boundsMin, boundsMax, center, right, up, forward } = cfg
    this._gridShape = gridShape
    this._boundsMin = boundsMin
    this._boundsMax = boundsMax

    const [nx, ny, nz] = gridShape
    const sizeX = boundsMax[0] - boundsMin[0]
    const sizeY = boundsMax[1] - boundsMin[1]
    const sizeZ = boundsMax[2] - boundsMin[2]
    this._boxSize = new THREE.Vector3(sizeX, sizeY, sizeZ)

    // grid 中心（grid 局部坐标）
    const cx = (boundsMin[0] + boundsMax[0]) * 0.5
    const cy = (boundsMin[1] + boundsMax[1]) * 0.5
    const cz = (boundsMin[2] + boundsMax[2]) * 0.5

    // Data3DTexture：单通道 float32，存 PPV（m/s）
    // 纹理轴序：u↔nx(width/right), v↔ny(height/up), w↔nz(depth/forward)
    // 与后端 pack_ppv_binary 中 transpose(2,1,0) 后的 x-最快内存布局一致。
    const voxelCount = nx * ny * nz
    const initData = new Float32Array(voxelCount) // 初始全 0（波前未到达）
    const tex = new THREE.Data3DTexture(initData, nx, ny, nz)
    tex.format = THREE.RedFormat
    tex.type = THREE.FloatType
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.wrapR = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    this._ppvTexture = tex
    this._voxelCount = voxelCount

    // σ_vm 应力场纹理（RedFormat + Float，单位 Pa）；初始全 0
    const stressTex = new THREE.Data3DTexture(new Float32Array(voxelCount), nx, ny, nz)
    stressTex.format = THREE.RedFormat
    stressTex.type = THREE.FloatType
    stressTex.minFilter = THREE.LinearFilter
    stressTex.magFilter = THREE.LinearFilter
    stressTex.wrapS = THREE.ClampToEdgeWrapping
    stressTex.wrapT = THREE.ClampToEdgeWrapping
    stressTex.wrapR = THREE.ClampToEdgeWrapping
    stressTex.needsUpdate = true
    this._stressTexture = stressTex

    // 损伤分区场纹理（RedFormat + Float，存 zone 0~4）；
    // 后端送 int8，前端转 float 上传以兼容 sampler3D float 采样
    const damageTex = new THREE.Data3DTexture(new Float32Array(voxelCount), nx, ny, nz)
    damageTex.format = THREE.RedFormat
    damageTex.type = THREE.FloatType
    damageTex.minFilter = THREE.LinearFilter
    damageTex.magFilter = THREE.LinearFilter
    damageTex.wrapS = THREE.ClampToEdgeWrapping
    damageTex.wrapT = THREE.ClampToEdgeWrapping
    damageTex.wrapR = THREE.ClampToEdgeWrapping
    damageTex.needsUpdate = true
    this._damageTexture = damageTex

    // 单位 BoxGeometry（±0.5），真实尺度由下方仿射矩阵承担
    this._geometry = new THREE.BoxGeometry(1, 1, 1)

    // 仿射矩阵行列式符号：right·(up×forward)，<0 表示含反射（绕序翻转）。
    // 反射时 BoxGeometry 的 CCW 正面会变为 CW，需用 BackSide 才能渲染原本朝向相机的面；
    // 否则用 FrontSide。这样每条射线只产生一个面片元，避免 DoubleSide 的双重混合。
    const detSign = right.dot(new THREE.Vector3().crossVectors(up, forward))
    const side = detSign < 0 ? THREE.BackSide : THREE.FrontSide

    this._material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPpvTexture: { value: this._ppvTexture },
        uStressTexture: { value: this._stressTexture },
        uDamageTexture: { value: this._damageTexture },
        uLut: { value: this._lutTexture },
        uStressLut: { value: this._stressLutTexture },
        uCameraPosObj: { value: new THREE.Vector3() },
        uRaySteps: { value: this._raySteps },
        uOpacity: { value: this._opacity },
        uPpvRefMps: { value: LUT_MAX_CMPS / 100.0 }, // 15 cm/s → 0.15 m/s
        uThresholdMps: { value: PPV_VISIBLE_THRESHOLD_CMPS / 100.0 },
        uStressRefMPa: { value: STRESS_LUT_MAX_MPA }, // 30 MPa
        uStressVisibleThresholdPa: { value: STRESS_VISIBLE_THRESHOLD_PA },
        uDisplayMode: { value: this._displayMode }
      },
      vertexShader: VOLUME_VERTEX_SHADER,
      fragmentShader: VOLUME_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side,
      blending: THREE.NormalBlending
    })

    this._mesh = new THREE.Mesh(this._geometry, this._material)
    this._mesh.renderOrder = 5 // 在不透明几何之后、粒子之前渲染

    // ── 仿射变换：box 局部 (±0.5) → 世界 ──
    // 局部 (lx,ly,lz) 映射到 grid (x,y,z) = boundsMin + (l+0.5)*size，
    // 再由 (right, up, forward) 基向量变换到世界坐标。
    // 合成矩阵列向量为 (right*sizeX, up*sizeY, forward*sizeZ)，平移为 boxCenter。
    //
    // 注意：当 forward 与 right×up 反向（默认 forward=-Z 时）该矩阵 det=-1（反射），
    // Quaternion.setFromRotationMatrix 无法表示反射，故直接设置 mesh.matrix
    // 并禁用 matrixAutoUpdate，由 matrixWorld 承载完整仿射（含反射）。
    // 体积渲染以局部坐标采样纹理，反射不影响轴序对应关系。
    const boxCenter = new THREE.Vector3()
      .addScaledVector(right, cx)
      .addScaledVector(up, cy)
      .addScaledVector(forward, cz)
      .add(center)
    const colX = right.clone().multiplyScalar(sizeX)
    const colY = up.clone().multiplyScalar(sizeY)
    const colZ = forward.clone().multiplyScalar(sizeZ)
    const affine = new THREE.Matrix4().makeBasis(colX, colY, colZ)
    affine.setPosition(boxCenter)
    this._mesh.matrixAutoUpdate = false
    this._mesh.matrix.copy(affine)
    this._mesh.updateMatrixWorld(true)

    this._mesh.visible = this._visible
    this.scene.add(this._mesh)
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
    // 直接替换纹理数据：Data3DTexture 内部持同一 buffer 引用，
    // 重新赋值 image.data 并标记 needsUpdate 触发 GPU 上传
    const tex = this._ppvTexture
    // 为避免反复分配，复用内部 buffer（仅当容量匹配时）
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
   * @param {number} t - 模拟时间（秒）
   * @param {number} frame - 帧序号
   */
  updateStressField(sigmaVm, t, frame) {
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
   * @param {number} t - 模拟时间（秒）
   * @param {number} frame - 帧序号
   */
  updateDamageField(zones, t, frame) {
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
    if (this._material) this._material.uniforms.uDisplayMode.value = m
  }

  get displayMode() {
    return this._displayMode
  }

  /**
   * 每帧更新相机在 box 局部坐标系下的位置（供 raymarching 射线起点）
   * @param {THREE.Camera} camera
   */
  updateCamera(camera) {
    if (!this._mesh || !this._material) return
    // 将世界坐标相机位置转换为 mesh 局部坐标。
    // mesh.matrixWorld 含完整仿射（right/up/forward 缩放列 + 反射），
    // 其逆矩阵将相机世界位置映射回 box 局部 ±0.5 归一化空间，供 raymarching 射线起点。
    const inv = new THREE.Matrix4().copy(this._mesh.matrixWorld).invert()
    const camLocal = new THREE.Vector3()
    camera.getWorldPosition(camLocal)
    camLocal.applyMatrix4(inv)
    this._material.uniforms.uCameraPosObj.value.copy(camLocal)

    // 仅在相机位于 box 内部时渲染体积场（±0.5 范围）。
    // 体积渲染设计为从内部观察：从外部看 box 表面会形成色片，
    // 且 raymarching 穿过整个 box 截面导致 GPU 负载剧增、页面卡死。
    const inside =
      Math.abs(camLocal.x) <= 0.5 && Math.abs(camLocal.y) <= 0.5 && Math.abs(camLocal.z) <= 0.5
    this._mesh.visible = this._visible && inside
  }

  setVisible(v) {
    this._visible = !!v
    if (this._mesh) this._mesh.visible = this._visible
  }

  get visible() {
    return this._visible
  }

  setOpacity(o) {
    this._opacity = Math.max(0, Math.min(1, Number(o) || 0))
    if (this._material) this._material.uniforms.uOpacity.value = this._opacity
  }

  setRaySteps(n) {
    this._raySteps = Math.max(8, Math.min(128, Math.round(Number(n) || DEFAULT_RAY_STEPS)))
    if (this._material) this._material.uniforms.uRaySteps.value = this._raySteps
  }

  /** 当前显示模式是否有可渲染的场（已 init 且至少收到过一帧数据） */
  get hasField() {
    if (!this._gridShape) return false
    if (this._displayMode === DISPLAY_MODE.STRESS) return this._hasStress
    if (this._displayMode === DISPLAY_MODE.DAMAGE) return this._hasDamage
    return this._hasPpv
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

  /** 释放 mesh / 材质 / 几何 / 3D 纹理（LUT 在 dispose 中释放） */
  disposeMesh() {
    if (this._mesh) {
      this.scene.remove(this._mesh)
      this._mesh = null
    }
    if (this._geometry) {
      this._geometry.dispose()
      this._geometry = null
    }
    if (this._material) {
      this._material.dispose()
      this._material = null
    }
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
