/**
 * 场景构建器
 *
 * 负责场景光照、隧道/掌子面/台阶网格、爆破钻孔、标注等场景元素的构建与管理。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { creaseNormals, sealPlaneOpenBoundaries } from './geometrySmoothing.js'

// ─── 表面抛光总开关 ────────────────────────────────────
// 几何焊接 + 折痕法线平滑：消除热力图在"纸片拼接/接缝"处的断档（详见 geometrySmoothing.js）。
// 置 false 可整体回滚到旧 flat 法线拼接形态（便于 A/B 目检）。
const ENABLE_SURFACE_POLISH = true

/** 折痕平滑角：连续曲面（夹角<此值）合并平滑，锐棱保留 */
const POLISH_CREASE_DEG = 45

/** 岩体/掌子面统一岩色：消除共享轮廓两侧底色深浅台阶造成的"拼接线" */
const ROCK_TINT = 0xa2907d

// ─── 默认光照配置（可由 config.lighting 覆盖） ──────────
const DEFAULT_LIGHTING = {
  ambient: { color: 0xb0b8c0, intensity: 2.5 },
  sun: { color: 0xffffff, intensity: 2.2, position: [50, 80, 30] },
  hemisphere: { sky: 0xaaccff, ground: 0x998866, intensity: 1.5 },
  tunnelLight: {
    color: 0xffeecc,
    intensity: 3.0,
    distance: 180,
    decay: 1.5,
    position: [0, 8, -10]
  },
  tunnelLight2: {
    color: 0xfff4dd,
    intensity: 2.5,
    distance: 180,
    decay: 1.5,
    position: [0, 6, -30]
  },
  fireLight: { color: 0xff6600, intensity: 0, distance: 500, decay: 2 }
}

// ─── 爆破后掌子面破碎腔（掏槽+辅助孔区域）比例 ─────────
// 依据井下矿/隧道掌子面爆破实测文献（见文献调研）：
// 全断面爆破后掏槽孔+辅助孔将断面绝大部分破碎抛出，周边孔（轮廓孔）仅负责
// 轮廓控制，留下的超挖控制岩圈仅约 7~25cm（优化案例 7.6~8.1cm，传统 25±8cm），
// 围岩损伤带约 2.4m。因此中央破碎腔应覆盖断面约 97%，
// 四周只保留约 1.5% 宽的极薄光爆岩圈，呈现"整个掌子面整体掀开"的真实爆破形态。
// 注意：破碎腔孔洞必须与断面同形（缩小马蹄形）且整体位于断面内部，
// 否则 ExtrudeGeometry 在孔洞越出断面的边界交叉处会三角化出尖刺（掌子面畸形）。
const CRATER_SCALE = 0.97

// ─── 炮孔类型颜色编码 ──────────────────────────────────
const HOLE_TYPE_COLORS = {
  cut: 0xff6b6b,
  easing: 0xff6b6b, // easing 等同 cut
  auxiliary: 0xfeca57,
  production: 0xfeca57, // production 默认归入辅助
  perimeter: 0x1dd1a1
}
const EMPTY_HOLE_COLOR = 0xffffff

// ─── 岩体表面振动场着色（应力/损伤/PPV 直接渲染在岩体上）──────
// 不再使用 raymarching 体积盒子（避免掌子面前方"红色方块"），
// 改为在 benchMesh 的 ShaderMaterial 中逐片元按世界坐标采样 3D 场纹理着色的方式。
// 坐标换算：世界坐标 P → grid 局部 (gx,gy,gz) = ((P-center)·right, ·up, ·forward)
//          → 纹理坐标 uvw = (g - boundsMin) / (boundsMax - boundsMin)
const BENCH_FIELD_VERTEX_SHADER = /* glsl */ `precision highp float;
precision highp sampler3D;

// 顶点世界坐标（用于换算到 grid 采样坐标）
out vec3 vWorldPos;
out vec2 vUv;
out vec3 vWorldNormal;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // 世界空间法线（用于简单的 lambert 明暗，让岩面有起伏光感而非纯平色）
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const BENCH_FIELD_FRAGMENT_SHADER = /* glsl */ `precision highp float;
precision highp sampler3D;

uniform sampler2D uRockMap;            // 岩石纹理（底色）
uniform sampler3D uPpvTexture;         // PPV 场（m/s）
uniform sampler3D uStressTexture;      // σ_vm 场（Pa）
uniform sampler3D uDamageTexture;      // 损伤分区（0~4）
uniform sampler2D uPpvLut;             // PPV 色阶 LUT
uniform sampler2D uStressLut;          // σ_vm 色阶 LUT

uniform vec3  uBoundsMin;              // grid 边界下界
uniform vec3  uBoundsMax;              // grid 边界上界
uniform vec3  uCenter;                 // 爆心世界坐标
uniform vec3  uBlastOrigin;            // 爆源 grid 局部坐标（缺省网格原点；掏槽孔质心）
uniform vec3  uRight;                  // 隧道宽度方向基向量
uniform vec3  uUp;                     // 竖直方向基向量
uniform vec3  uForward;                // 掌子面朝向基向量
uniform int   uDisplayMode;            // 0=PPV, 1=STRESS, 2=DAMAGE
uniform float uFieldWeight;            // 场着色强度（0=纯岩色，1=完全覆盖）
uniform float uWhiteModel;             // 底材白模开关（1=岩体切白模底，0=保留岩石纹理）
uniform float uPpvRefMps;              // PPV 色阶参考（m/s）
uniform float uStressRefMPa;           // 应力色阶参考（MPa）
uniform float uThresholdMps;           // PPV 可见阈值（m/s）
uniform float uStressVisiblePa;        // σ_vm 可见阈值（Pa）
uniform float uChargeKg;               // 总装药量(kg)（外推用）
uniform float uSadoskyK;               // 萨道夫斯基场地常数 K（cm/s）
uniform float uSadoskyAlpha;           // 萨道夫斯基衰减指数 α
uniform float uSadoskyBeta;            // 介质阻尼 β
uniform float uPpvVisualBeta;          // PPV 可视化时变衰减（波峰回落实时速度）
uniform float uVisualCp;               // 可视化波前传播速度(m/s)
uniform float uSimTime;                // 当前模拟时间(s)
uniform float uStressFactor;           // ρ·c_p/(1−ν)，PPV→σ_vm(Pa)
uniform vec3  uRockColor;              // 岩石基础色
uniform vec3  uSunDir;                 // 方向光方向（世界空间，用于岩面明暗）
uniform float uGlobalOpacity;          // 全局透明度（1=不透明；隧道内壁等半透明面用）
uniform float uSectionEnabled;         // 剖面裁剪开关（1=启用）
uniform float uSectionAxis;            // 裁剪轴（0=X 1=Y 2=Z，基于场景 rel 坐标）
uniform float uSectionPos;             // 裁剪平面位置（沿轴，场景相对 uCenter）
// 剖面裁剪：外部调用 setSectionPlane，用于爆破模式下观察岩体内部

// 多装药源（各炮孔装药段）萨道夫斯基矢量叠加：驱动岩面非同心圆干涉波场。
// 掏槽楔形孔在孔底汇拢、各源延时起爆，矢量叠加产生相长/相消干涉瓣（同 backend ppv_field_3d_multi）。
#define MAX_SOURCES 16
uniform int   uSourceCount;            // 有效装药源数量（0=退化为单一 uBlastOrigin 源）
uniform vec3  uSourcePos[MAX_SOURCES]; // 各源 grid 局部坐标(m)
uniform float uSourceCharge[MAX_SOURCES]; // 各源装药量(kg)
uniform float uSourceDelay[MAX_SOURCES];  // 各源延期(s)

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vWorldNormal;
out vec4 fragColor;

// 损伤分区离散取色（zone 0~4）；返回 rgb 与强度
void damageColor(float zone, out vec3 col, out float alpha) {
  if (zone >= 0.5 && zone < 1.5)      col = vec3(0.90, 0.85, 0.30); // micro_crack
  else if (zone < 2.5)                col = vec3(0.95, 0.55, 0.15); // crack_growth
  else if (zone < 3.5)                col = vec3(0.90, 0.20, 0.15); // fracture
  else                                col = vec3(0.60, 0.05, 0.10); // throw
  alpha = 0.55 + zone * 0.10;
}

void main() {
  // 岩石底色（带基础色调制）
  vec3 rock = texture(uRockMap, vUv).rgb * uRockColor;
  vec3 baseRock = rock; // 保留未受光照衰减的底纹，供场图层开启时抬亮暗部

  // 简单 lambert 明暗，让岩面随朝向呈现亮暗起伏（消除"纯平光滑"感）：
  // 法线叠加由岩石纹理高频亮度驱动的凹凸扰动，模拟岩体表面粗糙起伏；
  // 环境项 0.42 保证背光面不至于全黑。
  vec3 N = normalize(vWorldNormal);
  float hgt = dot(texture(uRockMap, vUv * 1.6).rgb, vec3(0.299, 0.587, 0.114));
  vec3 perturbed = normalize(N + vec3(hgt - 0.5, hgt - 0.5, (hgt - 0.5) * 0.25));
  float diff = clamp(dot(perturbed, normalize(uSunDir)), 0.0, 1.0);
  rock *= (0.42 + 0.72 * diff);

  // 世界坐标 → grid 局部坐标（仅用于解析场，以爆源为心）
  vec3 rel = vWorldPos - uCenter;
  vec3 g;
  g.x = dot(rel, uRight);
  g.y = dot(rel, uUp);
  g.z = dot(rel, uForward);

  // 全场统一萨道夫斯基解析源（多装药源矢量叠加）：
  // 不再做"场盒包围盒"的 inside 门控，也去掉"盒内采样纹理 / 盒外解析外推"
  // 的双分支——整块岩体同一套物理曲线，根除矩形色块（包围盒面硬切岩体）
  // 与内外围接缝（两套色源在盒边界数值/透明度不齐）。
  // 多源模式（uSourceCount>0）：遍历各炮孔装药段，按"径向单位向量 × 质点速度"
  // 矢量叠加，模长即 PPV → 相长/相消干涉、非单一同心圆（同 backend ppv_field_3d_multi）。
  // 源数与本地/后端 WS 多源模拟保持一致；无源时退化为单一 uBlastOrigin 源（总装药量）。
  vec3 totalVel = vec3(0.0);
  vec3 totalPeak = vec3(0.0);
  float front = 0.0;
  if (uSourceCount < 1) {
    // 无装药源退化：单一 uBlastOrigin 源（总装药量），保持与原单源场一致
    vec3 srcRel = g - uBlastOrigin;
    float rr = max(length(srcRel), 0.5);
    vec3 dirS = srcRel / max(rr, 1e-3);
    float arrival = rr / max(uVisualCp, 1e-3);
    float gap = uSimTime - arrival;
    front = gap < 0.0 ? 0.0 : exp(-gap / 1.2);
    float peakS = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(rr, -uSadoskyAlpha) * 0.01;
    float mpsS = gap < 0.0 ? 0.0 : peakS * exp(-(uSadoskyBeta + uPpvVisualBeta) * gap);
    totalVel = dirS * mpsS;
    totalPeak = dirS * peakS;
  } else {
    // 多装药源：各炮孔装药段按"径向单位向量 × 质点速度"矢量叠加，模长即 PPV。
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (i >= uSourceCount) break;
      vec3 srcRel = g - uSourcePos[i];
      float rr = max(length(srcRel), 0.5);
      vec3 dirS = srcRel / max(rr, 1e-3);
      float qS = max(uSourceCharge[i], 0.001);
      float dS = uSourceDelay[i];
      float arrival = dS + rr / max(uVisualCp, 1e-3);
      float gap = uSimTime - arrival;
      float frontS = gap < 0.0 ? 0.0 : exp(-gap / 1.2);
      front = max(front, frontS);
      float peakS = uSadoskyK * pow(qS, uSadoskyAlpha / 3.0) * pow(rr, -uSadoskyAlpha) * 0.01;
      float mpsS = gap < 0.0 ? 0.0 : peakS * exp(-(uSadoskyBeta + uPpvVisualBeta) * gap);
      totalVel += dirS * mpsS;
      totalPeak += dirS * peakS;
    }
  }
  // 矢量叠加后 PPV = 合速度模长（干涉波场）；peak = 合峰值模长（损伤判据）
  float mps = length(totalVel);
  float peak = length(totalPeak);

  vec3 fieldCol = vec3(0.0);
  float alpha = 0.0;

  // 波前浅色带：当某处的场值尚未达到"可见下限"、但波前已扫过时，
  // 用浅冷色表示"波已到达、量级尚弱"，替代色阶低端的深色（LUT 0 档为近黑深蓝）。
  // 否则应力/PPV 模式下，整个切割面/岩体上低场值的大片区域会被深色基底盖成
  // 一个黑窟窿（漏洞），掩盖岩体与热力分级的真实观感。
  vec3 waveBand = vec3(0.68, 0.83, 0.89);

  // 场值可见系数：0=低于可见下限（退化为浅波前带），1=完全露出热力图真色。
  // 下限取 [0.015,0.12]，使低场值区不被色阶最暗档覆盖。
  if (uDisplayMode == 1) {
    // σ_vm 等效应力：σ = ρ·c_p·v/(1−ν)；绝对标度相对 uStressRefMPa，保留随距衰减
    float pa = max(mps, 1e-6) * uStressFactor;
    float norm = clamp((pa / 1.0e6) / max(uStressRefMPa, 1e-6), 0.0, 1.0);
    // 过渡带加宽：弱化"波已到达/未到达"的硬边界，让波向外的色带柔和融合成渐变
    float vis = smoothstep(0.02, 0.20, norm);
    fieldCol = texture(uStressLut, vec2(norm, 0.5)).rgb;
    fieldCol = mix(waveBand, fieldCol, vis);
    // 波环仅作淡色补充，不掩盖真实梯度；降低波前强环亮度，避免切割面上出现
    // 明显的移动亮环/硬边线条，同时保留"应力从爆心向外扩散"的物理观感
    alpha = max(vis, front * 0.16);
  } else if (uDisplayMode == 2) {
    // 损伤分区：按"峰值 PPV"持久分区（离散五色，清晰分界），波前未到达处
    // front=0 → 不显示；不随时变衰减回落 → 动画后期不消失
    float cmps = peak * 100.0;
    float zone = cmps < 5.0 ? 0.0 : cmps < 15.0 ? 1.0 : cmps < 30.0 ? 2.0 : cmps < 50.0 ? 3.0 : 4.0;
    if (zone >= 0.5) {
      damageColor(zone, fieldCol, alpha);
      // 损伤区自身 alpha 已 ≥0.55 持久可见，无需额外全场面常驻色
      alpha = max(alpha, front * 0.85);
    } else {
      fieldCol = vec3(0.90, 0.86, 0.78); // 中性波前色，不暗示损伤分区
      alpha = front * 0.85;
    }
  } else {
    // PPV 振动场：实时质点速度，绝对标度相对 uPpvRefMps，随距随实时衰减；
    // 只在振动波已到达的面上着色，整块岩体不会预先常驻弱色→非"类球"整图
    float iVal = clamp(mps / max(uPpvRefMps, 1e-4), 0.0, 1.0);
    float vis = smoothstep(0.02, 0.20, iVal);
    fieldCol = texture(uPpvLut, vec2(iVal, 0.5)).rgb;
    fieldCol = mix(waveBand, fieldCol, vis);
    alpha = max(vis, front * 0.30);
  }

  // 场着色权重（uFieldWeight 为 0~1 的全局强度，alpha 为像素局部场强）
  float w = uFieldWeight * alpha;

  // 震动场图层开启时（uFieldWeight>0 且 uWhiteModel=1），岩体切成"白模"底材：
  // 去除岩石纹理/颜色/凹凸扰动，仅用平滑法线 lambert 明暗表现岩体形状，
  // 使 PPV/应力/损伤热力图以干净的白色为底、分级色更醒目。
  // uWhiteModel=0 时即使场图层开启也保留岩石纹理底（热力色叠在岩色上）。
  float mDiff = clamp(dot(N, normalize(uSunDir)), 0.0, 1.0);
  vec3 whiteModel = vec3(0.94, 0.95, 0.97) * (0.58 + 0.45 * mDiff);
  // 场图层开启时（fieldOn>0）：即使"白模底材"关闭，也自动把岩面暗部抬亮，
  // 防止暗色巷道内切割面/整块岩体在热力图未覆盖处堕成纯黑空洞（漏洞）。
  // 保留岩石纹理明暗 → 热力色半透明叠在可见岩面上；fieldOn=0 时观感不变。
  float fieldOn = smoothstep(1e-4, 0.04, uFieldWeight);
  vec3 rockShown = rock + baseRock * (0.55 * fieldOn);
  // 场图层开启时对基面做兜底抬亮：掌子面法线背向阳光（面向隧道内部），若只靠
  // rock+baseRock 抬升仍会偏暗，加上光照变化后可能堕成近黑（切割面"黑色空洞"漏洞）。
  // 仅在基面本身偏暗时向一个可见的暖棕地板抬升，暗面被救起、亮面保留纹理明暗。
  vec3 warmFloor = vec3(0.48, 0.43, 0.37);
  float rockLum = dot(rockShown, vec3(0.299, 0.587, 0.114));
  float liftAmt = smoothstep(0.10, 0.30, rockLum); // 越暗→liftAmt越小→越贴地板
  rockShown = mix(rockShown, warmFloor, (1.0 - liftAmt) * 0.62 * fieldOn);
  vec3 bg = mix(rockShown, whiteModel, uWhiteModel * fieldOn);

  // 场色不透明度统一回 alpha 尺度（解除权重 0.62 对色彩的整体压低），
  // 白底上图例色保持完整饱和度；关闭场图层时 wv=0 自然回到岩石纹理观感。
  float wv = clamp(w / max(uFieldWeight, 1e-4), 0.0, 0.85);

  // 增强场色饱和度与对比度，使分级更醒目（中等强度，避免各色带硬边过强、呈"线条"感）
  float lum = dot(fieldCol, vec3(0.299, 0.587, 0.114));
  fieldCol = mix(vec3(lum), fieldCol, 1.08);

  // 微抖动噪声打破 LUT 色带（banding），让色带过渡更细腻
  float noise =
    (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  fieldCol += noise;

  // 最终：场图层开启 → 白模上叠加场色（alpha 决定显隐/波前淡出）；
  // 关闭 → wv=0 → 输出带岩石纹理的原始观感。
  vec3 final = mix(bg, fieldCol, wv);

  // 裁剪剖面：对岩体施加一个沿主轴(X/Y/Z)的可移动平面，露出内部剖面观察
  if (uSectionEnabled > 0.5) {
    vec3 sn = vec3(0.0);
    if (uSectionAxis < 0.5) sn.x = 1.0;
    else if (uSectionAxis < 1.5) sn.y = 1.0;
    else sn.z = 1.0;
    if (dot(rel, sn) < uSectionPos) discard;
  }

  fragColor = vec4(final, uGlobalOpacity);
}
`

/** 默认场着色参数（无数据时的占位） */
const BENCH_FIELD_DEFAULTS = {
  displayMode: 0,
  fieldWeight: 0.0,
  ppvRefMps: 0.15,
  stressRefMPa: 30.0,
  thresholdMps: 0.001,
  stressVisiblePa: 5.0e4,
  chargeKg: 100,
  sadoskyK: 30,
  sadoskyAlpha: 1.5,
  sadoskyBeta: 0.02,
  ppvVisualBeta: 0.8, // PPV 可视化时变衰减(1/s)：波峰回落实时速度（见 computePpvField3d）
  visualCp: 35,
  // ρ·c_p/(1−ν)，默认 ρ=2650, c_p=4500, ν=0.25 → 2650×4500/0.75=1.59e7
  // （σ_vm=ρ·c_p·v/(1−ν)，径向压+切向拉，见 computeStressFieldFromPpv）
  stressFactor: 1.59e7
}

// ─── seeded RNG（mulberry32，保证漏斗形状可复现） ──────
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── 粒子纹理生成（程序化，无需外部资源） ──────────────
export function createFireTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.2, 'rgba(255,220,120,0.9)')
  gradient.addColorStop(0.5, 'rgba(255,120,20,0.6)')
  gradient.addColorStop(0.8, 'rgba(180,40,10,0.2)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export function createSmokeTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 噪声烟雾纹理
  const imageData = ctx.createImageData(size, size)
  const data = imageData.data
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const dx = i - size / 2
      const dy = j - size / 2
      const dist = Math.sqrt(dx * dx + dy * dy) / (size / 2)
      const noise = Math.random() * 0.3 + 0.7
      const alpha = Math.max(0, (1 - dist) * noise)
      const idx = (i * size + j) * 4
      data[idx] = 80 + Math.random() * 40
      data[idx + 1] = 80 + Math.random() * 40
      data[idx + 2] = 80 + Math.random() * 40
      data[idx + 3] = alpha * 255
    }
  }
  ctx.putImageData(imageData, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export function createSparkTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,200,1)')
  gradient.addColorStop(0.3, 'rgba(255,200,50,0.8)')
  gradient.addColorStop(1, 'rgba(255,100,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ─── 程序化岩石纹理（用于掌子面/台阶） ─────────────────
export function createRockTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 基础颜色：亮棕灰色
  ctx.fillStyle = '#9a8a78'
  ctx.fillRect(0, 0, size, size)
  // 添加岩石纹理：随机亮色块
  for (let i = 0; i < 350; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 20 + 5
    const gray = 120 + Math.random() * 80
    ctx.fillStyle = `rgba(${gray},${gray * 0.85},${gray * 0.7},${Math.random() * 0.5})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // 添加裂纹
  ctx.strokeStyle = 'rgba(80,60,40,0.25)'
  ctx.lineWidth = 1
  for (let i = 0; i < 15; i++) {
    ctx.beginPath()
    ctx.moveTo(Math.random() * size, Math.random() * size)
    for (let j = 0; j < 5; j++) {
      ctx.lineTo(Math.random() * size, Math.random() * size)
    }
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 2)
  tex.needsUpdate = true
  return tex
}

/**
 * 场景构建器类
 * 管理场景中的静态/半静态元素：光照、隧道壳体、掌子面、岩体、爆破钻孔、标注等。
 */
export class SceneBuilder {
  /**
   * @param {THREE.Scene} scene - Three.js 场景
   * @param {Object} config - 配置项
   * @param {THREE.Vector3} config.center - 爆心位置（引用，随主渲染器更新）
   * @param {THREE.Vector3} config.faceDirection - 掌子面朝向（引用）
   * @param {Object} config.layerVisibility - 图层可见性（引用）
   * @param {number} config.tunnelWidth - 隧道宽度
   * @param {number} config.tunnelWallHeight - 直墙高度
   * @param {number} config.tunnelArchRadius - 拱部半径
   * @param {number} config.tunnelHeight - 隧道总高
   * @param {number} config.benchLength - 岩体深度
   * @param {Object} config.tunnelSection - 隧道断面参数
   * @param {Object} [config.lighting] - 光照参数覆盖（结构同 DEFAULT_LIGHTING）
   * @param {number} [config.craterSeed] - 漏斗形状随机种子（默认 12345，保证可复现）
   */
  constructor(scene, config) {
    this.scene = scene

    // 共享状态引用（由主渲染器持有和更新）
    this.center = config.center
    this.faceDirection = config.faceDirection
    this.layerVisibility = config.layerVisibility

    // 隧道断面参数
    this.tunnelWidth = config.tunnelWidth
    this.tunnelWallHeight = config.tunnelWallHeight
    this.tunnelArchRadius = config.tunnelArchRadius
    this.tunnelHeight = config.tunnelHeight
    this.benchLength = config.benchLength
    this.tunnelSection = config.tunnelSection

    // 光照配置（支持外部覆盖，默认值经调校保证隧道内部可见度）
    this.lighting = { ...DEFAULT_LIGHTING, ...(config.lighting || {}) }
    // 漏斗形状随机种子（保证可复现，便于调试与回归测试）
    this._rng = mulberry32(config.craterSeed ?? 12345)
    // 表面抛光开关（构造层级默认开，外部可用 config.surfacePolish 关闭做 A/B）
    this.surfacePolish = ENABLE_SURFACE_POLISH && config.surfacePolish !== false
    // 剖面裁剪的"场景级请求"：剖切是直接改 benchMesh.geometry 的副作用，而爆破状态机
    // 会在起爆/回卷/seek 时把 geometry 换回 _rockGeoPre/_rockGeoPost。为让剖面不随拖动
    // 丢失，把"剖切请求"存这里，在 _setRockGeometry 换基时对同一平面重新剖切。
    this._sectionEnabled = false
    this._sectionAxis = 0
    this._sectionPos = null // 已解析的平面局部坐标（沿轴），换基后原样重切
    // 剖切结果缓存：键=基础几何对象（pre/post），值={axis,pos,geo}。
    // 播放时间轴在 pre/post 间互换几何时直接复用，避免每次对整块岩体重算 CSG 导致卡顿。
    this._sectionCache = new Map()

    // 设计数据（由主渲染器注入）
    this.blastHoleDesign = null
    this.designParams = null
    this.blastEffect = null
    this.blastHolePattern = null

    // 场景网格（由 SceneBuilder 创建和管理）
    this.benchMesh = null
    this.faceMesh = null
    this.faceDamagedMesh = null
    this.tunnelShellMesh = null
    this.blastHolesGroup = null
    this.annotationsGroup = null
    this.craterMesh = null
    this.rockTexture = null

    // 光照
    this.sunLight = null
    this.tunnelLight = null
    this.tunnelLight2 = null
    this.fireLight = null

    this._setupLights()
  }

  // ─── 光照 ─────────────────────────────────────────────
  _setupLights() {
    const L = this.lighting

    // 环境光（大幅增强，暗部细节清晰可见）
    const ambient = new THREE.AmbientLight(L.ambient.color, L.ambient.intensity)
    this.scene.add(ambient)

    // 方向光（模拟太阳光）
    this.sunLight = new THREE.DirectionalLight(L.sun.color, L.sun.intensity)
    this.sunLight.position.set(...L.sun.position)
    this.scene.add(this.sunLight)

    // 半球光（天空-地面）
    const hemiLight = new THREE.HemisphereLight(
      L.hemisphere.sky,
      L.hemisphere.ground,
      L.hemisphere.intensity
    )
    this.scene.add(hemiLight)

    // 隧道内部补光 #1（掌子面附近，模拟施工照明）
    const tl = L.tunnelLight
    this.tunnelLight = new THREE.PointLight(tl.color, tl.intensity, tl.distance, tl.decay)
    this.tunnelLight.position.set(...tl.position)
    this.scene.add(this.tunnelLight)

    // 隧道内部补光 #2（相机后方，向前照射掌子面+碎石）
    const tl2 = L.tunnelLight2
    this.tunnelLight2 = new THREE.PointLight(tl2.color, tl2.intensity, tl2.distance, tl2.decay)
    this.tunnelLight2.position.set(...tl2.position)
    this.scene.add(this.tunnelLight2)

    // 爆心点光源（动态火光）
    const fl = L.fireLight
    this.fireLight = new THREE.PointLight(fl.color, fl.intensity, fl.distance, fl.decay)
    this.scene.add(this.fireLight)
  }

  /**
   * 同步隧道补光位置（由主渲染器在 initBlast 后调用）
   * @param {THREE.Vector3} center - 爆心位置
   * @param {THREE.Vector3} faceDirection - 掌子面朝向
   * @param {number} tunnelHeight - 隧道总高
   */
  updateTunnelLights(center, faceDirection, tunnelHeight) {
    if (this.tunnelLight) {
      this.tunnelLight.position.set(
        center.x - faceDirection.x * 15,
        center.z + tunnelHeight * 0.5,
        center.y - faceDirection.z * 15
      )
    }
    if (this.tunnelLight2) {
      this.tunnelLight2.position.set(
        center.x - faceDirection.x * 40,
        center.z + tunnelHeight * 0.45,
        center.y - faceDirection.z * 40
      )
    }
  }

  // ─── 隧道断面 Shape 构建 ─────────────────────────────
  /**
   * 构建马蹄形断面 Shape（直墙 + 半圆拱），可选中央爆破漏斗洞口。
   * 该中央洞口即"掏槽+辅助孔"破碎腔：向导坑底部运行时只有一个居中的深凹腔，
   * 四周保留一圈完整围岩（光面爆破轮廓），与真实浅埋/掏槽爆破一致。
   * @param {boolean} withCrater - 是否包含爆破漏斗洞口
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @param {number} totalH - 隧道总高
   * @returns {THREE.Shape}
   */
  _createTunnelShape(withCrater, W, Hw, R, totalH, craterPtsArr) {
    const shape = new THREE.Shape()
    shape.moveTo(-W / 2, 0)
    shape.lineTo(-W / 2, Hw)
    // 半圆拱：从左侧经顶部到右侧（顺时针扫过 π→0）
    shape.absarc(0, Hw, R, Math.PI, 0, true)
    shape.lineTo(W / 2, 0)
    shape.closePath()

    if (withCrater) {
      // 真实爆破掌子面：中央深破碎抛出 + 四周围岩圈残留（轮廓孔光面爆破痕迹）
      // 1) 中央破碎腔（掏槽+辅助孔区域，被抛掷成深凹腔）。
      //    与断面同形的缩小马蹄形，仅留约 1.5% 宽的极薄周边岩圈
      //    （对应文献中 7~25cm 超挖控制区），接近"整个掌子面整体掀开"的真实爆破形态。
      // 注意：craterPtsArr 必须由调用方传入（与 3D 漏斗共用同一组点），
      // 不能在此处再调 _computeCraterPoints —— RNG 有状态，重复调用会产生不同轮廓，
      // 导致掌子面孔洞与破碎腔开口错位（畸形）。
      const crater = new THREE.Path()
      const pts = craterPtsArr || this._computeCraterPoints(W, Hw, R)
      pts.forEach((p, i) => {
        if (i === 0) crater.moveTo(p.x, p.y)
        else crater.lineTo(p.x, p.y)
      })
      crater.closePath()
      shape.holes.push(crater)
    }
    return shape
  }

  // ─── 围岩加厚（掌子面前方待爆岩体的横断面外扩） ────────
  /**
   * 围岩厚度系数：7 × 巷道断面外廓最大半径。
   * 马蹄形取 max(半宽, 拱半径)；圆形同上（半宽=拱半径）；矩形取断面半对角线。
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @returns {number} 围岩加厚厚度 t（米）
   */
  _computeRockThickness(W, Hw, R) {
    const halfW = W / 2
    let rMax = Math.max(halfW, R)
    if (this.tunnelSection?.shape === 'rectangular') {
      rMax = Math.hypot(halfW, Hw / 2)
    }
    return Math.max(1, 7 * rMax)
  }

  /**
   * 由开挖轮廓各边向外扩 t 构建待爆岩体横断面：**矩形实体块**（立方体状）。
   * 底板下延至 -t、两侧墙外扩 t、拱顶向上加高总量 Hw+R 后再加 t；
   * 断面为完整矩形（x∈[-W/2-t, W/2+t]，y∈[-t, Hw+R+t]），巷道断面位于其中。
   * 待爆岩体即为一个矩形/立方体状的待开挖岩块，适合观察球形应力波在块内扩散。
   * @returns {THREE.Shape}
   */
  _buildInflatedRockShape(W, Hw, R, t) {
    const w2 = W / 2 + t
    const top = Hw + R + t
    const shape = new THREE.Shape()
    shape.moveTo(-w2, -t)
    shape.lineTo(w2, -t)
    shape.lineTo(w2, top)
    shape.lineTo(-w2, top)
    shape.closePath()
    return shape
  }

  /**
   * 围岩环横断面：外扩轮廓为外边界、开挖轮廓为内洞。
   * 用于爆破后待爆循环段：核心开挖空腔贯通、四周围岩环保留。
   * @returns {THREE.Shape}
   */
  _buildRockRingShape(W, Hw, R, t, tunnelShape) {
    const ring = this._buildInflatedRockShape(W, Hw, R, t)
    ring.holes.push(tunnelShape)
    return ring
  }

  /**
   * 计算掌子面中央破碎腔（掏槽+辅助孔区域）的轮廓点。
   * 破碎腔纵向居中、下缘贴底（水沟线），边缘带锯齿噪声，轮廓自然不规则。
   * 掌子面洞口（_createTunnelShape）与 3D 破碎腔漏斗（_buildFaceDamagedMesh）
   * 共用同一组轮廓点，保证开口与深腔严格贴合。
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @returns {Array<{x:number,y:number}>}
   */
  _computeCraterPoints(W, Hw, R) {
    // 与隧道断面同形的缩小马蹄形破碎腔轮廓。
    // 关键：孔洞必须整体位于断面内部（沿断面质心缩放），
    // 否则 ExtrudeGeometry 在孔洞越出断面的边界交叉处会三角化出尖刺（掌子面畸形）。
    const s = CRATER_SCALE
    const rectArea = W * Hw
    const archArea = (Math.PI * R * R) / 2
    const totalArea = rectArea + archArea
    const hcy = (rectArea * (Hw * 0.5) + archArea * (Hw + (4 * R) / (3 * Math.PI))) / totalArea
    const halfW = (W / 2) * s
    const rectBottom = hcy * (1 - s)
    const rectTop = Hw * s + hcy * (1 - s)
    const archR = R * s
    const archCY = rectTop

    // 边缘锯齿噪声（小幅度，保证不越出断面，周边岩圈始终存在）
    let accJag = 0
    for (let k = 0; k < 8; k++) accJag += this._rng()
    const baseJag = (accJag / 8 - 0.5) * 0.03
    const pts = []
    const wallN = 6
    const archN = 24
    // 左墙（自下而上）
    for (let i = 0; i <= wallN; i++) {
      const t = i / wallN
      const y = rectBottom + (rectTop - rectBottom) * t
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({ x: -halfW + nz, y })
    }
    // 拱顶（左→右，经顶部）
    for (let i = 0; i <= archN; i++) {
      const a = Math.PI - (i / archN) * Math.PI
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({
        x: Math.cos(a) * archR + nz,
        y: archCY + Math.sin(a) * archR
      })
    }
    // 右墙（自上而下）
    for (let i = 0; i <= wallN; i++) {
      const t = i / wallN
      const y = rectTop - (rectTop - rectBottom) * t
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({ x: halfW + nz, y })
    }
    return pts
  }

  // ─── 统一释放 Group 及其子对象资源 ────────────────────
  _disposeGroup(group) {
    if (!group) return
    this.scene.remove(group)
    group.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        if (o.material.map) o.material.map.dispose()
        o.material.dispose()
      }
    })
  }

  // ─── 清理旧场景网格 ──────────────────────────────────
  _cleanupBenchGeometry() {
    // 复位剖切状态与临时件（重建时旧切片/封口/拾取标记一并清理，避免状态残留）
    this._sectionEnabled = false
    this._sectionAxis = 0
    this._sectionPos = null
    if (this._sliceCutGeo) {
      if (this._sliceCutGeo.dispose) this._sliceCutGeo.dispose()
      this._sliceCutGeo = null
    }
    this._slicePristineGeo = null
    for (const c of this._sectionCache.values()) {
      if (c.geo && c.geo.dispose) c.geo.dispose()
    }
    this._sectionCache.clear()
    for (const key of ['_pickPointMarker', '_sectionMarkerGroup']) {
      const g = this[key]
      if (g) {
        if (g.parent) g.parent.remove(g)
        g.traverse(o => {
          if (o.geometry?.dispose) o.geometry.dispose()
          if (o.material?.dispose) o.material.dispose()
        })
        this[key] = null
      }
    }
    this._sectionLine = null
    this._sectionFill = null
    this._sectionSphere = null
    this._lastCutAxis = null
    this._lastCutPos = null
    this._sectionBox = null
    this._sectionRegions = null
    this._sectionLastAxis = null

    const disposeSingle = mesh => {
      if (!mesh) return
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    disposeSingle(this.benchMesh)
    // 剖面封口片：随岩体一同释放，避免残留空心腔体
    disposeSingle(this._sectionCapMesh)
    this._sectionCapMesh = null
    // 岩体前后两套几何（整段实心/退切实心）独立释放，避免泄漏
    if (this._rockGeoPre) {
      this._rockGeoPre.dispose()
      this._rockGeoPre = null
    }
    if (this._rockGeoPost) {
      this._rockGeoPost.dispose()
      this._rockGeoPost = null
    }
    this.benchMesh = null
    disposeSingle(this.faceMesh)
    this.faceMesh = null
    disposeSingle(this.faceDamagedMesh)
    this.faceDamagedMesh = null
    // 场着色材质释放：bench 与 face 共用同一套占位纹理/ LUT，统一在此清理一次
    this._benchFieldMaterial = null
    this._faceFieldMaterial = null
    if (this._fieldDummyTexture) {
      this._fieldDummyTexture.dispose()
      this._fieldDummyTexture = null
    }
    if (this._fieldPpvLut) {
      this._fieldPpvLut.dispose()
      this._fieldPpvLut = null
    }
    if (this._fieldStressLut) {
      this._fieldStressLut.dispose()
      this._fieldStressLut = null
    }
    disposeSingle(this.tunnelShellMesh)
    this.tunnelShellMesh = null
    disposeSingle(this.craterMesh)
    this.craterMesh = null
    disposeSingle(this.excavatedTubeMesh)
    this.excavatedTubeMesh = null
    this._disposeGroup(this.blastHolesGroup)
    this.blastHolesGroup = null
    this._disposeGroup(this.annotationsGroup)
    this.annotationsGroup = null
  }

  // ─── 主构建入口 ───────────────────────────────────────
  /**
   * 构建隧道掌子面与岩体几何体。
   * 掌子面为马蹄形（直墙 + 半圆拱）垂直平面，垂直于地面、法线沿爆破方向。
   *
   * 采用"单循环进尺"模型以贴合真实爆破（起爆后岩体不消失，而是新挖出一段空腔）：
   * - benchMesh：待爆岩体（实心马蹄形挤出），前缘推进到 faceOffset+roundDepth——
   *   即爆破后新掌子面位置，始终存在，作为外层围岩/前方未开挖岩体
   * - frontPlugMesh：爆破前待爆的那一个循环（faceOffset → faceOffset+roundDepth 的实心段），
   *   爆破后隐藏（该循环岩体被抛掷），露出与之同体的开挖空腔
   * - excavatedTubeMesh：与 frontPlugMesh 同区间的"开挖空腔壁"（空心马蹄环），
   *   爆破后显示，呈现刚开挖出的一段岩壁空腔；爆破前隐藏
   * - faceMesh：完整掌子面（爆破前可见）
   */
  buildBenchGeometry() {
    this._cleanupBenchGeometry()

    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection

    // 创建岩石纹理（程序化生成）
    if (!this.rockTexture) {
      this.rockTexture = createRockTexture()
    }

    // 隧道断面尺寸
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 朝向旋转：绕 Y 轴旋转，使局部 +Z（挤出方向）对齐爆破方向 dir
    const yaw = Math.atan2(dir.x, dir.z)
    const faceOffset = 3 // 掌子面距爆心前方 3m
    // 单循环进尺（一个开挖循环的深度）：爆破后新掌子面向前推进该距离，= 炮孔深度
    const roundDepth = Math.max(1.5, Number(this.designParams?.holeDepth) || 2.5)

    // 缓存无漏斗断面 Shape（bench/shell/face 共用，避免重复构建 3 次）
    const tunnelShape = this._createTunnelShape(false, W, Hw, R, totalH)
    // 围岩加厚：掌子面前方待爆岩体横断面在开挖轮廓基础上向外扩 7×巷道最大半径
    // （开挖轮廓/爆破腔/隧道壳保持原断面不变，只加厚未开挖岩体的外廓）
    const rockThickness = this._computeRockThickness(W, Hw, R)
    const rockShape = this._buildInflatedRockShape(W, Hw, R, rockThickness)
    const ctx = {
      W,
      Hw,
      R,
      totalH,
      yaw,
      faceOffset,
      roundDepth,
      cx,
      cy,
      cz,
      dir,
      tunnelShape,
      rockShape,
      rockThickness
    }

    // 材质
    const benchMat = new THREE.MeshStandardMaterial({
      color: ROCK_TINT,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })
    const faceMat = new THREE.MeshStandardMaterial({
      color: ROCK_TINT,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })

    // 掌子面前方未开挖岩体 = 单一连续实心体（待爆段与后方岩体合并为一个整体），
    // 爆破后仅整体退到新掌子面（切出需爆破的空腔段），无缝拼接。
    this._buildRockBodyMesh({ ...ctx, benchMat })
    // 掌子面后方的已开挖段：由半透明空心隧道壳（tunnelShellMesh）表示，
    // 开口端对齐掌子面（faceOffset），无前端实体 cap，确保掌子面/岩体不被遮挡。
    this._buildTunnelShell(ctx)
    this._buildFaceMesh({ ...ctx, faceMat })
    // 依赖 _buildFaceMesh 生成的 _faceFieldMaterial/faceMesh.position：
    // 创建爆破后的损伤掌子面（含洞口）+ 3D 掏槽漏斗（craterMesh）
    this._buildFaceDamagedMesh(ctx)
    this._buildExcavatedTube(ctx)
    this._buildBlastHoles(yaw, faceOffset)
  }

  // ─── 开挖空腔壁（爆破后待爆循环变成的一段岩壁空腔） ──
  /**
   * 开挖空腔的岩壁（空心马蹄环侧壁），覆盖 faceOffset → faceOffset+roundDepth。
   * 与 frontPlugMesh 同区间、不同状态：
   * - 爆破前：hidden（该区间是实心 frontPlugMesh 填充）
   * - 爆破后：visible（frontPlugMesh 隐藏后，此半透明环提示刚开挖的一段空腔范围）
   * 复用 _buildOpenTubeGeometry（与已开挖段隧道内壁同构，几何稳定可靠）。
   */
  _buildExcavatedTube(ctx) {
    const { roundDepth } = ctx
    const tubeGeo = this._buildOpenTubeGeometry(ctx.tunnelShape, roundDepth, 96)
    // 开挖空腔壁与已开挖段隧道内壁保持一致：半透明（不写深度、不遮挡后方岩体），
    // 恢复"已开挖部分透明"的观感——新爆出的这段空腔不再是实心环壁，
    // 从隧道内部隔空仍能透视到其后方的实体岩体/新掌子面。
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x9c7c58,
      map: this.rockTexture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0.05
    })
    this.excavatedTubeMesh = new THREE.Mesh(tubeGeo, tubeMat)
    // 开口管近端(local z=0)对齐新掌子面(faceOffset+roundDepth)，向 -forward 覆盖一个循环
    this.excavatedTubeMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + roundDepth),
      ctx.cz,
      ctx.cy + ctx.dir.z * (ctx.faceOffset + roundDepth)
    )
    this.excavatedTubeMesh.rotation.y = ctx.yaw
    this.excavatedTubeMesh.castShadow = true
    this.excavatedTubeMesh.receiveShadow = true
    this.excavatedTubeMesh.visible = false
    this.scene.add(this.excavatedTubeMesh)
  }

  // ─── 掌子面前方未开挖岩体（单一连续实心体） ──────────
  /**
   * 待爆段（faceOffset → faceOffset+roundDepth）与后方岩体（更远）合并为
   * **一个连续的实心马蹄形体** rockBody，不再拆分成 frontPlug/bench 两个 mesh。
   * - 爆破前：整体实心（_rockGeoPre），与掌子面（faceMesh）共面封端；
   * - 爆破后：整体退到新掌子面（_rockGeoPost = 切掉待爆段的连续实心）。
   *   待爆段空腔壁由 excavatedTubeMesh、漏斗 craterMesh、破损掌子面
   *   faceDamagedMesh 覆盖，三者的接触环在 faceOffset+roundDepth 处与
   *   rockBody 新掌子面严格共面，实现无缝拼接（不再有 frontPlug/bench 缝合面）。
   * @param {Object} ctx - 构建上下文（含 tunnelShape/faceOffset/roundDepth/...）
   */
  _buildRockBodyMesh(ctx) {
    const roundDepth = ctx.roundDepth
    const benchLength = this.benchLength
    const D = roundDepth + benchLength
    this._rockRoundDepth = roundDepth

    const extrudeOpts = { bevelEnabled: false, steps: 48, curveSegments: 64 }

    // 爆破前几何：整段连续实心 [0, D]，横断面 = 开挖轮廓 + 围岩加厚外扩
    // （steps/curveSegments 加密保证场色带平滑）
    this._rockGeoPre = new THREE.ExtrudeGeometry(ctx.rockShape || ctx.tunnelShape, {
      ...extrudeOpts,
      depth: D
    })

    // 爆破后几何：仅保留新掌子面 (roundDepth) 之后的连续实心；
    // 待爆循环段 [0, roundDepth] 的核心开挖空腔贯通、四周围岩环保留，
    // 与实心段无缝合并为一个几何体（避免周围岩体在爆破段出现空洞缺失）。
    if (ctx.rockShape && ctx.tunnelShape) {
      const ringShape = this._buildRockRingShape(
        ctx.W,
        ctx.Hw,
        ctx.R,
        ctx.rockThickness,
        ctx.tunnelShape
      )
      const ringGeo = new THREE.ExtrudeGeometry(ringShape, {
        ...extrudeOpts,
        depth: roundDepth
      })
      const solidPost = new THREE.ExtrudeGeometry(ctx.rockShape, {
        ...extrudeOpts,
        depth: benchLength
      })
      solidPost.translate(0, 0, roundDepth)
      this._rockGeoPost = mergeGeometries([ringGeo, solidPost]) || solidPost
      ringGeo.dispose()
      if (this._rockGeoPost !== solidPost) solidPost.dispose()
    } else {
      // 回退（无围岩外扩）：与旧行为一致，退切后的整段实心
      this._rockGeoPost = new THREE.ExtrudeGeometry(ctx.tunnelShape, {
        ...extrudeOpts,
        depth: benchLength
      })
      this._rockGeoPost.translate(0, 0, roundDepth)
    }

    // 表面抛光：对 pre/post 各做折痕法线平滑（内部按位置归并重复顶点、平滑区共享顶点
    // 取面积加权法线、硬棱保留，见 geometrySmoothing.js）。产物覆盖回引用，保证
    // _setRockGeometry / _restoreSectionGeometry 对象引用互换语义。
    // 注意：**不得**对 post 做 removeTrianglesOnPlane(+z 内部盖面) —— 该剔除会把
    // z=roundDepth 内壁开口 131 条边，破坏水密，剖切切到即成大缺口（creaseNormals
    // 本身保持水密，见 _probe：raw0 / crease0 / rm131）。内部 +z/-z 共面盖面虽在，
    // 但 crease 已把它们按法线分组、且对内不可见，不再做额外剔除。
    if (this.surfacePolish) {
      const preRaw = this._rockGeoPre
      const postRaw = this._rockGeoPost
      this._rockGeoPre = creaseNormals(preRaw, POLISH_CREASE_DEG)
      this._rockGeoPost = creaseNormals(postRaw, POLISH_CREASE_DEG)
      preRaw.dispose()
      postRaw.dispose()
    }

    // 与 faceMesh 共用同一套场 LUT/纹理，保证岩体表面应力/PPV/损伤色带连续。
    // 未爆破的岩体为不透明实体：应力/PPV/损伤场直接着色在其表面（不穿透显内腔）。
    this._benchFieldMaterial = this._createFieldMaterial(ctx.benchMat, {
      opacity: 1,
      transparent: true,
      depthWrite: true
    })
    this.benchMesh = new THREE.Mesh(this._rockGeoPre, this._benchFieldMaterial)
    // 岩体前缘 = 掌子面（faceOffset），向 +forward 深入；爆破后整体退到新掌子面。
    // 几何底为局部 z=0（掌子面端）、向 +z 挤出 D，故网格原点即置于 faceOffset，
    // 使岩体世界覆盖 [faceOffset, faceOffset+D]，与隧道壳/掌子面严格相接。
    this.benchMesh.position.set(
      ctx.cx + ctx.dir.x * ctx.faceOffset,
      ctx.cz,
      ctx.cy + ctx.dir.z * ctx.faceOffset
    )
    this.benchMesh.rotation.y = ctx.yaw
    this.benchMesh.castShadow = true
    this.benchMesh.receiveShadow = true
    this.scene.add(this.benchMesh)
    // 岩体轮廓线（边缘高亮）：暗背景/热力图满铺时仍能看清岩体轮廓
    // 岩体为大块实体，外框线用较低透明度（细淡），避免"红色方体框"式突兀
    this._attachRockOutline(this.benchMesh, 0.55)
  }

  /**
   * 切换掌子面前方岩体的几何形态（爆破前=整段实心；爆破后=退到新掌子面）。
   * 复用预构建的 _rockGeoPre/_rockGeoPost，不做重复三角化，保证与漏斗/空腔壁
   * 接触面严格共面。
   * @param {boolean} triggered - true=已爆破（使用退切后的实心体）
   */
  _setRockGeometry(triggered) {
    const mesh = this.benchMesh
    if (!mesh) return
    const next = triggered ? this._rockGeoPost : this._rockGeoPre
    if (!next) return
    // 剖面处于激活态时：换到新的基础几何后对同一平面重新剖切（命中缓存则复用，
    // 避免播放时间轴起爆/回卷/seek 反复整块 CSG 重算导致的卡顿）。
    if (this._sectionEnabled && this._sectionPos != null && mesh.geometry !== next) {
      this._cutBaseGeometry(next)
      // 同步切面轮廓标记（pre/post 截面轮廓不同，需按当前基础几何刷新）
      if (this._sectionMarkerGroup) this._updateSectionMarker(this._sectionAxis)
      this._attachRockOutline(mesh)
      return
    }
    if (mesh.geometry !== next) {
      mesh.geometry = next
      // 几何切换后同步轮廓线（pre/post 外廓不同，避免显示陈旧的外形轮廓）
      this._attachRockOutline(mesh)
    }
  }

  /**
   * 在网格外轮廓上贴一圈高亮轮廓线（EdgesGeometry + LineSegments），
   * 使岩体在暗背景巷道或振动场热力图满铺时仍能看出清晰轮廓。
   * 轮廓线作为网格子节点，随父网格隐藏/显隐；几何替换时调用本方法重建。
   * @param {THREE.Mesh} mesh - 目标网格（岩体 / 掌子面）
   * @param {number} [opacity=0.9] - 轮廓线透明度（岩体大块实体用低值细淡，掌子面断面用高值清晰）
   */
  _attachRockOutline(mesh, opacity = 0.9) {
    if (!mesh || !mesh.geometry) return
    // 清除已挂载的旧轮廓（LineSegments：仅几何 + 材质，内联释放）
    if (mesh.userData?.__outlineLine) {
      const old = mesh.userData.__outlineLine
      mesh.remove(old)
      if (old.geometry) old.geometry.dispose()
      if (old.material) old.material.dispose()
      mesh.userData.__outlineLine = null
    }
    // 阈值角取 20°：只保留真正的折痕边/外轮廓，不显示平面内部的细分边
    const edges = new THREE.EdgesGeometry(mesh.geometry, 20)
    const mat = new THREE.LineBasicMaterial({
      color: 0xbfe0ff, // 冷白描边，暗背景下醒目且与热力暖色区分
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    })
    const line = new THREE.LineSegments(edges, mat)
    line.renderOrder = 999 // 始终压在最上层，保证轮廓不被热力图盖住
    line.frustumCulled = false
    mesh.add(line)
    mesh.userData.__outlineLine = line
  }

  /**
   * 构建振动场表面着色材质（ShaderMaterial）。
   * 以指定岩石纹理为底色，叠加应力/损伤/PPV 场颜色。
   * 初始无场数据时纯显示岩色（uFieldWeight=0）。
   * 岩体（bench）与掌子面（face/damaged）共用同一套 LUT 与占位纹理。
   * @param {THREE.MeshStandardMaterial} baseMat - 原始岩石材质（提供纹理与基础色）
   * @param {Object} [opts] - 材质选项
   * @param {number} [opts.opacity=1] - 全局透明度（<1 时半透明，隧道内壁用）
   * @param {boolean} [opts.transparent] - 是否开启透明混合（默认 opacity<1 时开启）
   * @param {boolean} [opts.depthWrite=true] - 是否写入深度（半透明面设为 false 以免遮挡后方岩体）
   * @returns {THREE.ShaderMaterial}
   */
  _createFieldMaterial(baseMat, opts = {}) {
    const opacity = opts.opacity ?? 1
    const transparent = opts.transparent ?? opacity < 1
    const depthWrite = opts.depthWrite ?? true
    // 占位 3D 纹理（无场数据时避免 sampler3D 未绑定）
    if (!this._fieldDummyTexture) {
      const dummy = new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1)
      dummy.format = THREE.RedFormat
      dummy.type = THREE.FloatType
      dummy.needsUpdate = true
      this._fieldDummyTexture = dummy
    }
    // 占位 1D LUT（无场数据时避免 sampler2D 未绑定）
    if (!this._fieldPpvLut) {
      this._fieldPpvLut = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
      this._fieldPpvLut.needsUpdate = true
    }
    if (!this._fieldStressLut) {
      this._fieldStressLut = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
      this._fieldStressLut.needsUpdate = true
    }
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uRockMap: { value: baseMat?.map || createRockTexture() },
        uPpvTexture: { value: this._fieldDummyTexture },
        uStressTexture: { value: this._fieldDummyTexture },
        uDamageTexture: { value: this._fieldDummyTexture },
        uPpvLut: { value: this._fieldPpvLut },
        uStressLut: { value: this._fieldStressLut },
        uBoundsMin: { value: new THREE.Vector3(0, 0, 0) },
        uBoundsMax: { value: new THREE.Vector3(1, 1, 1) },
        uGridSize: { value: new THREE.Vector3(32, 32, 64) },
        uCenter: { value: new THREE.Vector3() },
        uBlastOrigin: { value: new THREE.Vector3(0, 0, 0) },
        // 多装药源（各炮孔装药段）：与片段着色器 MAX_SOURCES=16 对齐。
        // uSourceCount=0 时片段着色器退化为单一 uBlastOrigin 源（同心圆退化分支）。
        uSourceCount: { value: 0 },
        uSourcePos: { value: Array.from({ length: 16 }, () => new THREE.Vector3(0, 0, 0)) },
        uSourceCharge: { value: new Array(16).fill(0) },
        uSourceDelay: { value: new Array(16).fill(0) },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uForward: { value: new THREE.Vector3(0, 0, 1) },
        uDisplayMode: { value: BENCH_FIELD_DEFAULTS.displayMode },
        uFieldWeight: { value: BENCH_FIELD_DEFAULTS.fieldWeight },
        uWhiteModel: { value: 0 }, // 默认关闭白模：保留岩石纹理底，场色叠在岩色上
        uPpvRefMps: { value: BENCH_FIELD_DEFAULTS.ppvRefMps },
        uStressRefMPa: { value: BENCH_FIELD_DEFAULTS.stressRefMPa },
        uThresholdMps: { value: BENCH_FIELD_DEFAULTS.thresholdMps },
        uStressVisiblePa: { value: BENCH_FIELD_DEFAULTS.stressVisiblePa },
        // 场盒外解析外推（萨道夫斯基）用参数，默认与后端/本地模拟器缺省一致
        uChargeKg: { value: BENCH_FIELD_DEFAULTS.chargeKg },
        uSadoskyK: { value: BENCH_FIELD_DEFAULTS.sadoskyK },
        uSadoskyAlpha: { value: BENCH_FIELD_DEFAULTS.sadoskyAlpha },
        uSadoskyBeta: { value: BENCH_FIELD_DEFAULTS.sadoskyBeta },
        uPpvVisualBeta: { value: BENCH_FIELD_DEFAULTS.ppvVisualBeta },
        uVisualCp: { value: BENCH_FIELD_DEFAULTS.visualCp },
        uSimTime: { value: 0 },
        uStressFactor: { value: BENCH_FIELD_DEFAULTS.stressFactor },
        uRockColor: { value: new THREE.Color(baseMat?.color || 0xb8946e) },
        // 方向光（世界空间，归一化）：上右前，模拟隧道内主照明方向
        uSunDir: { value: new THREE.Vector3(0.55, 0.75, 0.45).normalize() },
        uGlobalOpacity: { value: opacity },
        uSectionEnabled: { value: 0 },
        uSectionAxis: { value: 0 },
        uSectionPos: { value: 0 }
      },
      vertexShader: BENCH_FIELD_VERTEX_SHADER,
      fragmentShader: BENCH_FIELD_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      transparent,
      opacity,
      depthWrite
    })
  }

  /** 所有应用了振动场着色的材质（岩体 + 掌子面 + 损伤掌子面 + 已开挖段围岩） */
  _fieldMaterials() {
    const mats = [this._benchFieldMaterial, this._faceFieldMaterial]
    // 已开挖段隧道围岩若使用独立的场着色材质（未与岩体共用），同样纳入同步
    const shell = this.tunnelShellMesh?.material
    if (shell && shell !== this._benchFieldMaterial && shell.uniforms?.uFieldWeight) {
      mats.push(shell)
    }
    return mats.filter(Boolean)
  }

  /**
   * 注入振动场数据纹理与坐标基向量（由 threeBlastingRenderer 在 initVibrationField 时调用）
   * @param {Object} data - BlastVibrationFieldRenderer.getFieldData() 的返回值（伪子集）
   */
  setBenchFieldData(data) {
    const mats = this._fieldMaterials()
    if (!mats.length) return
    for (const m of mats) {
      const u = m.uniforms
      if (data) {
        if (data.stressTexture) u.uStressTexture.value = data.stressTexture
        if (data.damageTexture) u.uDamageTexture.value = data.damageTexture
        if (data.ppvTexture) u.uPpvTexture.value = data.ppvTexture
        if (data.lutTexture) u.uPpvLut.value = data.lutTexture
        if (data.stressLutTexture) u.uStressLut.value = data.stressLutTexture
        if (data.boundsMin) u.uBoundsMin.value.set(...data.boundsMin)
        if (data.boundsMax) u.uBoundsMax.value.set(...data.boundsMax)
        if (data.gridShape) u.uGridSize.value.set(...data.gridShape.slice(0, 3), 1)
        if (data.center) u.uCenter.value.copy(data.center)
        if (data.blastOrigin) {
          const o = Array.isArray(data.blastOrigin)
            ? data.blastOrigin
            : [data.blastOrigin.x, data.blastOrigin.y, data.blastOrigin.z]
          u.uBlastOrigin.value.set(Number(o[0]) || 0, Number(o[1]) || 0, Number(o[2]) || 0)
        }
        if (data.right) u.uRight.value.copy(data.right)
        if (data.up) u.uUp.value.copy(data.up)
        if (data.forward) u.uForward.value.copy(data.forward)
        if (data.ppvRefMps != null) u.uPpvRefMps.value = data.ppvRefMps
        if (data.stressRefMPa != null) u.uStressRefMPa.value = data.stressRefMPa
        if (data.thresholdMps != null) u.uThresholdMps.value = data.thresholdMps
        if (data.stressVisiblePa != null) u.uStressVisiblePa.value = data.stressVisiblePa
      } else {
        // 无数据：恢复占位纹理与默认坐标
        u.uStressTexture.value = this._fieldDummyTexture
        u.uDamageTexture.value = this._fieldDummyTexture
        u.uPpvTexture.value = this._fieldDummyTexture
      }
    }
  }

  /** 切换岩体/掌子面振动场显示模式（0=PPV, 1=STRESS, 2=DAMAGE） */
  setBenchFieldDisplayMode(mode) {
    const v = Number(mode) || 0
    for (const m of this._fieldMaterials()) m.uniforms.uDisplayMode.value = v
  }

  /** 设置岩体/掌子面振动场着色权重（0~1），0=关闭只显示岩色 */
  setBenchFieldWeight(weight) {
    const v = Math.max(0, Math.min(1, Number(weight) || 0))
    for (const m of this._fieldMaterials()) m.uniforms.uFieldWeight.value = v
  }

  /** 设置岩体/掌子面底材是否"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setFieldWhiteModel(enabled) {
    const v = enabled ? 1 : 0
    for (const m of this._fieldMaterials()) m.uniforms.uWhiteModel.value = v
  }

  /** 同步模拟时间到场材质（驱动场盒外的萨道夫斯基波前外推逐帧传播） */
  setFieldSimTime(t) {
    const v = Number(t) || 0
    for (const m of this._fieldMaterials()) m.uniforms.uSimTime.value = v
  }

  /**
   * 设置爆破场景对象的透明度（供外部工具／面板在爆破模式下控制）。
   * @param {'rock'|'tunnel'} which - 'rock'=未爆破岩体(掌子面)，'tunnel'=已开挖巷道(隧道壳/空腔)
   * @param {number} opacity - 0..1，1=完全不透明
   */
  setObjectOpacity(which, opacity) {
    const o = Number(opacity)
    const v = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1
    if (which === 'rock') {
      for (const m of this._fieldMaterials()) {
        if (!m.uniforms?.uGlobalOpacity) continue
        m.uniforms.uGlobalOpacity.value = v
        m.transparent = true
        m.depthWrite = v >= 0.999
        m.needsUpdate = true
      }
    } else if (which === 'tunnel') {
      for (const mesh of [this.tunnelShellMesh, this.excavatedTubeMesh]) {
        if (!mesh?.material) continue
        mesh.material.transparent = true
        mesh.material.opacity = v
        mesh.material.needsUpdate = true
      }
    }
  }

  /** 读取爆破场景对象的当前透明度（默认：岩体不透明、巷道透明）。 */
  getObjectOpacity(which) {
    if (which === 'rock') {
      const m = this._benchFieldMaterial
      return m?.uniforms?.uGlobalOpacity ? m.uniforms.uGlobalOpacity.value : 1
    }
    if (which === 'tunnel') {
      return this.tunnelShellMesh?.material?.opacity ?? 0.38
    }
    return 1
  }

  /**
   * 设置岩体剖面裁剪（爆破模式下观察内部）。
   * @param {number} [enabled] 0 关 / 1 开
   * @param {number} [axis] 0=X 1=Y 2=Z（基于场景 rel 坐标）
   * @param {number} [pos] 裁剪平面沿轴位置
   */
  setSectionPlane({ enabled = 0, axis = 0, pos = 0 } = {}) {
    const a = [0, 1, 2].includes(Number(axis)) ? Number(axis) : 0
    // 采用几何真剖切（CSG）：关闭材质 discard（避免二次削切），剖面由几何封口保证实心
    for (const m of this._fieldMaterials()) {
      if (m.uniforms?.uSectionEnabled) m.uniforms.uSectionEnabled.value = 0
    }
    if (!enabled) {
      // 还原出完整几何体（并释放剖切生成的临时封口几何与缓存）
      this._sectionEnabled = false
      this._sectionPos = null
      this._clearSectionCache()
      this._restoreSectionGeometry()
      return
    }
    // 若已处于剖切态，先还原完整几何，再对新的平面位置重新剖切，
    // 避免在已剖切几何上反复裁剪导致顶点流失、封口错乱
    if (this._sliceCutGeo) this._restoreSectionGeometry()
    this._clearSectionCache()
    const base = this.benchMesh?.geometry
    this._applySectionCut(a, Number(pos) || 0)
    // 记录"场景级剖切请求"：_setRockGeometry 换基时据此对同一平面重新剖切
    this._sectionEnabled = true
    this._sectionAxis = a
    this._sectionPos = this._lastCutPos != null ? this._lastCutPos : Number(pos) || 0
    if (base && this.benchMesh && this.benchMesh.geometry !== base) {
      this._sectionCache.set(base, {
        axis: this._sectionAxis,
        pos: this._sectionPos,
        geo: this.benchMesh.geometry
      })
    }
  }

  /** 还原被剖切前的完整岩体几何（并释放剖切生成的临时封口几何） */
  _restoreSectionGeometry() {
    const mesh = this.benchMesh
    if (this._sliceCutGeo) {
      if (this._sliceCutGeo.dispose) this._sliceCutGeo.dispose()
      this._sliceCutGeo = null
    }
    if (this._slicePristineGeo && mesh && mesh.geometry !== this._slicePristineGeo) {
      mesh.geometry = this._slicePristineGeo
    }
    this._slicePristineGeo = null
  }

  /** 释放剖切结果缓存（并释放各缓存几何） */
  _clearSectionCache() {
    const current = this.benchMesh?.geometry
    for (const c of this._sectionCache.values()) {
      if (c.geo && c.geo !== current && c.geo.dispose) c.geo.dispose()
    }
    this._sectionCache.clear()
  }

  /**
   * 对给定基础几何(base)应用当前剖切请求，返回剖切几何（命中缓存则直接复用，
   * 避免爆破状态互换时反复整块 CSG 重算）。会同步 benchMesh.geometry 到该几何。
   * @param {THREE.BufferGeometry} base 基础几何（_rockGeoPre / _rockGeoPost）
   * @returns {THREE.BufferGeometry}
   */
  _cutBaseGeometry(base) {
    const mesh = this.benchMesh
    if (!mesh) return base
    const hit = this._sectionCache.get(base)
    if (hit && hit.axis === this._sectionAxis && hit.pos === this._sectionPos) {
      // 复用缓存：落到当前基础几何，仅换引用，不重算
      if (this._sliceCutGeo && this._sliceCutGeo !== hit.geo && this._sliceCutGeo.dispose) {
        this._sliceCutGeo.dispose()
      }
      this._sliceCutGeo = hit.geo
      this._slicePristineGeo = base
      mesh.geometry = hit.geo
      return hit.geo
    }
    // 未命中：先还原并释放旧剖切，再在基础几何上重切
    if (this._sliceCutGeo) {
      if (this._sliceCutGeo.dispose) this._sliceCutGeo.dispose()
      this._sliceCutGeo = null
    }
    this._slicePristineGeo = null
    mesh.geometry = base
    this._applySectionCut(this._sectionAxis, this._sectionPos)
    const out = mesh.geometry
    this._sectionCache.set(base, { axis: this._sectionAxis, pos: this._sectionPos, geo: out })
    return out
  }

  /**
   * 几何真剖切（CSG，axis-aligned 平面）：保留 dot(v,轴)>=pos 的一侧，并在平面处
   * 生成贴合岩体实际截面的实心封口面，使剖切后为封闭实体块（three 仍是表面网格，
   * 但剖面被真实三角剖分封口，视觉上呈现实心断面）。
   * @param {number} axis 0=X 1=Y 2=Z（局部坐标轴）
   * @param {number} pos 归一化比例 [0,1]：0=包围盒一端，1=另一端，0.5=居中
   */
  _applySectionCut(axis, pos) {
    const mesh = this.benchMesh
    const geo = mesh?.geometry
    const posAttr = geo?.getAttribute?.('position')
    if (!posAttr) return
    const P = posAttr.array
    // 仅当尚未捕获原始几何时才记录为"原始"，防止反复剖切时把已剖切的几何误记为原始，
    // 导致 _restoreSectionGeometry 还原到一个已被切的几何上（顶点流失/封口错乱）。
    if (this._slicePristineGeo == null) this._slicePristineGeo = geo

    // 计算岩体完整 AABB（标记尺寸与剖切钳制共用），并把剖切面位置
    // 解释为沿该轴的实际局部坐标、钳制在包围盒内，保证任何取值都只做
    // 真实剖切、不会把整块岩体剔除。
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (let i = 0; i < P.length; i += 3) {
      for (let c2 = 0; c2 < 3; c2++) {
        const v = P[i + c2]
        if (v < box.min[c2]) box.min[c2] = v
        if (v > box.max[c2]) box.max[c2] = v
      }
    }
    if (Number.isFinite(box.min[axis]) && Number.isFinite(box.max[axis])) {
      this._sectionBox = box
    }
    let cutPos = Number(pos)
    if (!Number.isFinite(cutPos)) cutPos = (box.min[axis] + box.max[axis]) / 2
    if (box.min[axis] <= box.max[axis]) {
      cutPos = Math.max(box.min[axis], Math.min(box.max[axis], cutPos))
    }

    const N = geo.getAttribute('normal').array
    const UV = geo.getAttribute('uv')?.array
    const idx = geo.index ? geo.index.array : null
    const count = posAttr.count

    const outPos = []
    const outNor = []
    const outUv = []
    const outIdx = []
    const secKey = new Map()
    const secPts = []
    const secEdges = []

    const vkey = (x, y, z) => `${x.toFixed(6)}|${y.toFixed(6)}|${z.toFixed(6)}`
    const getSec = (x, y, z, u, v) => {
      const k = vkey(x, y, z)
      let i = secKey.get(k)
      if (i == null) {
        i = secPts.length
        secKey.set(k, i)
        secPts.push({ x, y, z, u, v })
      }
      return i
    }

    const emitTri = (a, b, c) => {
      let nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
      let ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)
      let nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      const base = outPos.length / 3
      outPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      outNor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
      outUv.push(a.u, a.v, b.u, b.v, c.u, c.v)
      outIdx.push(base, base + 1, base + 2)
    }

    const process = (i0, i1, i2) => {
      const v = [i0, i1, i2].map(i => ({
        x: P[i * 3],
        y: P[i * 3 + 1],
        z: P[i * 3 + 2],
        nx: N[i * 3],
        ny: N[i * 3 + 1],
        nz: N[i * 3 + 2],
        u: UV ? UV[i * 2] : 0,
        v: UV ? UV[i * 2 + 1] : 0
      }))
      const ins = v.map(o => {
        const c = axis === 0 ? o.x : axis === 1 ? o.y : o.z
        return c - cutPos >= -1e-7
      })
      const anyOut = !ins[0] || !ins[1] || !ins[2]
      if (!anyOut) {
        emitTri(v[0], v[1], v[2])
        return
      }
      if (!ins[0] && !ins[1] && !ins[2]) return
      // 跨越平面：保留 keep 侧顶点 + 在平面处插值出顶点
      const keep = []
      const plane = []
      for (let e = 0; e < 3; e++) {
        const a = v[e]
        const b = v[(e + 1) % 3]
        if (ins[e]) keep.push(a)
        if (ins[e] !== ins[(e + 1) % 3]) {
          const ca = axis === 0 ? a.x : axis === 1 ? a.y : a.z
          const cb = axis === 0 ? b.x : axis === 1 ? b.y : b.z
          const t = (cutPos - ca) / (cb - ca)
          const iv = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
            u: a.u + (b.u - a.u) * t,
            v: a.v + (b.v - a.v) * t
          }
          keep.push(iv)
          plane.push(iv)
        }
      }
      for (let k = 1; k < keep.length - 1; k++) emitTri(keep[0], keep[k], keep[k + 1])
      if (plane.length === 2) {
        const ia = getSec(plane[0].x, plane[0].y, plane[0].z, plane[0].u, plane[0].v)
        const ib = getSec(plane[1].x, plane[1].y, plane[1].z, plane[1].u, plane[1].v)
        if (ia !== ib) secEdges.push([ia, ib])
      }
    }

    if (idx) for (let i = 0; i < idx.length; i += 3) process(idx[i], idx[i + 1], idx[i + 2])
    else for (let i = 0; i < count; i += 3) process(i, i + 1, i + 2)

    // 剖面封口：把截面边缘段连成若干个闭合环，再按环逐环扇形三角化，
    // 生成贴合岩体实际截面的实心封口面（岩体为封闭实体 → 每个截面恰为 1 个闭合环，
    // 但通用地按多环处理以兼容罕见的非连通截面）。
    if (secPts.length >= 3 && secEdges.length) {
      const adj = secPts.map(() => [])
      const seenEdge = new Set()
      const ekey = (a, b) => `${Math.min(a, b)}|${Math.max(a, b)}`
      for (const [a, b] of secEdges) {
        // 同一平面边会被相邻两个曲面三角形各贡献一次，去重保证图度数为 2
        const k = ekey(a, b)
        if (seenEdge.has(k)) continue
        seenEdge.add(k)
        adj[a].push(b)
        adj[b].push(a)
      }
      const rings = []
      const usedVer = new Set()
      for (let s = 0; s < secPts.length; s++) {
        if (usedVer.has(s)) continue
        const ring = []
        let cur = s
        let prev = -1
        let safety = 0
        while (cur !== -1 && !ring.includes(cur) && safety < secPts.length + 2) {
          ring.push(cur)
          usedVer.add(cur)
          const next = adj[cur].find(x => x !== prev) ?? -1
          prev = cur
          cur = next
          safety++
        }
        if (ring.length >= 3) rings.push(ring)
      }
      // 用 ear-clipping（含孔洞）三角化封口面，避免质心扇形对马蹄形(外环+隧道孔洞)
      // 截面产生覆盖孔洞/重叠/空洞，导致切开后后方岩体空心。
      this._fillSection(axis, rings, secPts, emitTri)
    }

    let newGeo = new THREE.BufferGeometry()
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
    newGeo.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3))
    newGeo.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2))
    newGeo.setIndex(outIdx)
    newGeo.computeBoundingSphere()
    // 剖切缺口密封：侧向剖切(X/Y，切面沿长轴)的剖面 rim 由挤出 steps 分段生成，
    // cap 与侧壁存在系统性错位开口缝（Z 向剖切断面轮廓短、无此现象，见
    // geometrySmoothing.test）。sealPlaneOpenBoundaries 只补平面上"单面开口环"，
    // 真实空腔/炮孔的孔洞边界会被腔壁与 cap 两面占用而不被误填。
    // 注意：不要再对剖切 newGeo 做 creaseNormals/weldPositions 二次抛光——会把已
    // 按折痕拆棱的网格上的大平面封口误判退化整面丢弃（剖切面露出大洞的旧回归）。
    // 迭代密封：每补一轮后可能暴露新的开口环，循环补到不再变化（最多 5 轮）。
    for (let i = 0; i < 5; i++) {
      const sealed = sealPlaneOpenBoundaries(newGeo, axis, cutPos, 0.05)
      if (sealed === newGeo) break
      newGeo.dispose()
      newGeo = sealed
    }
    if (this._sliceCutGeo) {
      if (this._sliceCutGeo.dispose) this._sliceCutGeo.dispose()
      this._sliceCutGeo = null
    }
    mesh.geometry = newGeo
    this._sliceCutGeo = newGeo
    mesh.material.needsUpdate = true
    // 剖切替换几何后，旧轮廓线（基于完整几何的 EdgesGeometry）仍挂在网格外，
    // 会把完整岩体的折痕线穿过剖切面叠加成杂乱线条。基于新几何重建描边，
    // 让轮廓线贴合剖切后的真实边界。
    this._attachRockOutline(mesh, 0.9)
    this._lastCutAxis = axis
    this._lastCutPos = cutPos
  }

  // 用质心扇形三角化填充一个没有孔洞的截面环（作为 ear-clipping 的兜底）
  _fillSectionRing(ring, points, emitTri) {
    const n = ring.length
    if (n < 3) return
    let cx = 0
    let cy = 0
    let cz = 0
    for (const i of ring) {
      cx += points[i].x
      cy += points[i].y
      cz += points[i].z
    }
    const c = { x: cx / n, y: cy / n, z: cz / n, u: cx / n, v: cy / n }
    for (let k = 1; k < n - 1; k++) {
      emitTri(c, points[ring[k]], points[ring[k + 1]])
    }
  }

  /**
   * 把截面环分组为"外环 + 孔洞"区域。支持多个互不相交的区域（如 X/Y 向剖切
   * 穿过隧道时，截面分为底板下方与拱顶上方两个独立区域），每个区域独立三角化，
   * 否则把第二个区域误当第一个区域的孔洞会导致其不被填充 → 剖开后空心。
   * @param {number} axis 0=X 1=Y 2=Z（截面平面法线轴）
   * @param {number[][]} rings 每个元素为 secPts 索引环
   * @param {{x,y,z,u?,v?}[]} secPts 截面顶点池
   * @returns {Array<{outer:number[], holes:number[][]}>} 索引指向 rings
   */
  _groupSectionRegions(axis, rings, secPts) {
    const u1 = (axis + 1) % 3
    const u2 = (axis + 2) % 3
    const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
    const ringPts = rings.map(ring => ring.map(i => ({ x: c(secPts[i], u1), y: c(secPts[i], u2) })))
    const areas = ringPts.map(pts => {
      let a = 0
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]
        const q = pts[(k + 1) % pts.length]
        a += p.x * q.y - p.y * q.x
      }
      return a / 2
    })
    const pointInPoly = (px, py, poly) => {
      let inside = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x
        const yi = poly[i].y
        const xj = poly[j].x
        const yj = poly[j].y
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
      }
      return inside
    }
    // 每个环的"直接父环"：包含它且面积最小的环；-1 表示它是外环
    const parent = rings.map((_, j) => {
      let best = -1
      let bestArea = Infinity
      for (let i = 0; i < rings.length; i++) {
        if (i === j || Math.abs(areas[i]) <= Math.abs(areas[j])) continue
        const pts = ringPts[j]
        let anyIn = false
        for (const p of pts) {
          if (pointInPoly(p.x, p.y, ringPts[i])) {
            anyIn = true
            break
          }
        }
        if (anyIn && Math.abs(areas[i]) < bestArea) {
          best = i
          bestArea = Math.abs(areas[i])
        }
      }
      return best
    })
    const regions = []
    for (let i = 0; i < rings.length; i++) {
      if (parent[i] !== -1) continue
      const holes = []
      for (let j = 0; j < rings.length; j++) {
        if (parent[j] === i) holes.push(rings[j])
      }
      regions.push({ outer: rings[i], holes })
    }
    return regions
  }

  /**
   * 在剖面载体上把截面三角化成实心封口面。
   * 岩体截面可能为"外环 + 隧道孔洞"（Z 向剖切）或"多个互不相交区域"
   * （X/Y 向剖切穿过隧道：底板下方 + 拱顶上方），按区域分组后逐区域
   * 用耳切法(ear-clipping，THREE.ShapeUtils 内含 earcut)三角化，
   * 才能真正闭合成实心；否则质心扇形/单外环会把孔洞填满或漏掉独立区域，
   * 切开后看进去仍是空洞。
   * 同时把各区域的外环/孔洞三维顶点记录到 this._sectionRegions 供切面轮廓标记复用。
   * @param {number} axis 0=X 1=Y 2=Z（截面平面法线轴）
   * @param {number[][]} rings 每个元素为 secPts 索引环
   * @param {{x,y,z,u?,v?}[]} secPts 截面顶点池
   * @param {Function} emitTri 输出三角面的回调
   */
  _fillSection(axis, rings, secPts, emitTri) {
    if (!rings || !rings.length) return
    const regions = this._groupSectionRegions(axis, rings, secPts)
    if (!regions.length) return

    // 记录轮廓点（三维）供切面轮廓标记绘制：各区域外环 + 各孔洞环
    this._sectionRegions = regions.map(({ outer, holes }) => ({
      outer: outer.map(i => new THREE.Vector3(secPts[i].x, secPts[i].y, secPts[i].z)),
      holes: holes.map(h => h.map(i => new THREE.Vector3(secPts[i].x, secPts[i].y, secPts[i].z)))
    }))
    if (this._sectionLastAxis !== axis) this._sectionLastAxis = axis

    for (const { outer, holes } of regions) {
      const outer3D = outer.map(i => secPts[i])
      const holes3D = holes.map(h => h.map(i => secPts[i]))
      const faces = this._triangulateRings(axis, outer3D, holes3D)
      if (faces) {
        const order = [...outer]
        for (const h of holes) order.push(...h)
        for (const t of faces) {
          emitTri(secPts[order[t[0]]], secPts[order[t[1]]], secPts[order[t[2]]])
        }
      } else {
        // 兜底：外环质心扇形（仅当 ear-clipping 由于退化输入失败时）
        this._fillSectionRing(outer, secPts, emitTri)
      }
    }
  }

  /**
   * ear-clipping：把外环 + 孔洞环三角化（在法线=axis 的截面上做 2D 投影）。
   * 注意：contour/hole 必须用 THREE.Vector2（带 .equals），否则 ShapeUtils 内部
   * removeDupEndPts 调用 points[l-1].equals(...) 对纯对象抛异常 → 永远回退质心扇形。
   * @returns {number[][]|null} 三角面（索引指向 order = outer 后接各 hole 顶点序列），失败返回 null
   */
  _triangulateRings(axis, outer, holes) {
    const u1 = (axis + 1) % 3
    const u2 = (axis + 2) % 3
    const c = (p, ax) => (ax === 0 ? p.x : ax === 1 ? p.y : p.z)
    try {
      const contour = outer.map(p => new THREE.Vector2(c(p, u1), c(p, u2)))
      const holeArr = holes.map(h => h.map(p => new THREE.Vector2(c(p, u1), c(p, u2))))
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeArr)
      // triangulateShape 内部 removeDupEndPts 可能 pop 掉终止重复点，导致索引漂移 → 保守回退
      if (contour.length !== outer.length) return null
      return faces.filter(t => t.length === 3)
    } catch (e) {
      return null
    }
  }

  // ─── 拾取式剖切（爆破模式）──────────────────────────
  /** 返回可被射线拾取的岩体网格列表 */
  getRockMeshes() {
    const list = []
    if (this.benchMesh) list.push(this.benchMesh)
    return list
  }

  /**
   * 拾取式剖切：给定岩体上的一个局部点与切割轴，构造过该点、法线沿该轴的
   * 剖切面，生成实体封口断面，并在切面上绘制轮廓轮廓标记（半透明面 + 边界线 + 中心点）。
   * @param {number} axis 0=X 1=Y 2=Z
   * @param {Object} point {x,y,z} 岩体局部坐标
   */
  setSectionPick(axis, point = {}) {
    const a = [0, 1, 2].includes(Number(axis)) ? Number(axis) : 0
    // 关闭材质 discard 路径（本次剖切纯靠几何真割 + 封口），避免二次削切
    for (const m of this._fieldMaterials()) {
      if (m.uniforms?.uSectionEnabled) m.uniforms.uSectionEnabled.value = 0
    }
    // 若已处于剖切态（切换切割轴），先还原完整几何，再对新的平面位置重新剖切，
    // 避免在已剖切几何上反复裁剪导致顶点流失、封口错乱、切面不贴合真实截面。
    if (this._sliceCutGeo) this._restoreSectionGeometry()
    this._clearSectionCache()
    const base = this.benchMesh?.geometry
    const comp = a === 0 ? point.x : a === 1 ? point.y : point.z
    this._applySectionCut(a, Number.isFinite(Number(comp)) ? Number(comp) : 0)
    this._sectionEnabled = true
    this._sectionAxis = a
    this._sectionPos = this._lastCutPos ?? 0
    if (base && this.benchMesh && this.benchMesh.geometry !== base) {
      this._sectionCache.set(base, {
        axis: this._sectionAxis,
        pos: this._sectionPos,
        geo: this.benchMesh.geometry
      })
    }
    this._updateSectionMarker(a)
    return { enabled: 1, axis: a, pos: this._sectionPos }
  }

  /**
   * 显示/隐藏拾取点标记：在岩体表面拾取一点后、选择切割轴前给出视觉反馈，
   * 让用户明确"切割面将过这个点"。point 传 null 或非法值时隐藏。
   * @param {{x,y,z}|null} point 岩体局部坐标
   */
  setPickPointMarker(point = null) {
    const mesh = this.benchMesh
    if (!mesh) return
    if (!this._pickPointMarker) {
      const group = new THREE.Group()
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 20, 16),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
      )
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 20, 16),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.35,
          depthWrite: false
        })
      )
      group.add(core, halo)
      group.renderOrder = 100
      mesh.add(group)
      this._pickPointMarker = group
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
      this._pickPointMarker.position.set(point.x, point.y, point.z)
      this._pickPointMarker.visible = true
    } else {
      this._pickPointMarker.visible = false
    }
  }

  /** 更新切面轮廓标记到当前剖切面（局部坐标，作为岩体子对象）。
   *  轮廓取自真实剖切截面：各区域外环 + 各孔洞环边界线，以及 ear-clipping 填充面。 */
  _updateSectionMarker(axis) {
    const mesh = this.benchMesh
    const cutPos = this._lastCutPos
    if (!mesh || !Number.isFinite(cutPos)) return
    const regions = this._sectionRegions || []
    if (!regions.length) return

    // 边界线：各区域外环 + 各孔洞环（首尾闭合，拆成线段对）
    const linePts = []
    for (const { outer, holes } of regions) {
      for (let i = 0; i < outer.length; i++) linePts.push(outer[i], outer[(i + 1) % outer.length])
      for (const h of holes) {
        for (let i = 0; i < h.length; i++) linePts.push(h[i], h[(i + 1) % h.length])
      }
    }
    // 填充面：逐区域 ear-clipping 三角化（含孔洞）
    const fillPos = this._sectionFillPositions(axis, regions)

    if (!this._sectionMarkerGroup) {
      this._sectionMarkerGroup = new THREE.Group()
      this._sectionLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95 })
      )
      this._sectionFill = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: 0x3b82f6,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      this._sectionSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
      )
      this._sectionMarkerGroup.add(this._sectionFill, this._sectionLine, this._sectionSphere)
      this._sectionMarkerGroup.renderOrder = 99
      mesh.add(this._sectionMarkerGroup)
    }

    const lg = this._sectionLine.geometry
    const lpos = lg.getAttribute('position')
    if (!lpos || lpos.count !== linePts.length) {
      const arr = new Float32Array(linePts.length * 3)
      linePts.forEach((p, i) => {
        arr[i * 3] = p.x
        arr[i * 3 + 1] = p.y
        arr[i * 3 + 2] = p.z
      })
      lg.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    } else {
      linePts.forEach((p, i) => lpos.setXYZ(i, p.x, p.y, p.z))
      lpos.needsUpdate = true
    }

    const fg = this._sectionFill.geometry
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fillPos), 3))
    fg.computeVertexNormals()

    // 中心点球置于剖切面上（沿轴取 cutPos，其余轴取最大外环质心）
    let largest = regions[0]
    for (const r of regions) {
      if (r.outer.length > largest.outer.length) largest = r
    }
    const outer = largest.outer
    let cx = 0
    let cy = 0
    let cz = 0
    for (const p of outer) {
      cx += p.x
      cy += p.y
      cz += p.z
    }
    const n = outer.length || 1
    this._sectionSphere.position.set(
      axis === 0 ? cutPos : cx / n,
      axis === 1 ? cutPos : cy / n,
      axis === 2 ? cutPos : cz / n
    )
    this._sectionMarkerGroup.visible = true
  }

  /** 计算切面填充面顶点（平面坐标序列 [x,y,z,...]），逐区域 ear-clipping 含孔洞三角化 */
  _sectionFillPositions(axis, regions) {
    const out = []
    for (const { outer, holes } of regions) {
      const faces = this._triangulateRings(axis, outer, holes)
      if (faces) {
        const order = [...outer]
        for (const h of holes) order.push(...h)
        for (const t of faces) {
          for (const i of t) out.push(order[i].x, order[i].y, order[i].z)
        }
        continue
      }
      // 兜底：外环质心扇形
      const n = outer.length
      const c = { x: 0, y: 0, z: 0 }
      for (const p of outer) {
        c.x += p.x
        c.y += p.y
        c.z += p.z
      }
      c.x /= n
      c.y /= n
      c.z /= n
      for (let k = 1; k < n - 1; k++) {
        out.push(
          c.x,
          c.y,
          c.z,
          outer[k].x,
          outer[k].y,
          outer[k].z,
          outer[k + 1].x,
          outer[k + 1].y,
          outer[k + 1].z
        )
      }
    }
    return out
  }

  /** 清除拾取式剖切：移除轮廓标记并还原完整岩体 */
  clearSectionPick() {
    if (this._pickPointMarker) {
      const parent = this._pickPointMarker.parent
      if (parent) parent.remove(this._pickPointMarker)
      this._pickPointMarker.traverse(o => {
        if (o.geometry?.dispose) o.geometry.dispose()
        if (o.material?.dispose) o.material.dispose()
      })
      this._pickPointMarker = null
    }
    if (this._sectionMarkerGroup) {
      const parent = this._sectionMarkerGroup.parent
      if (parent) parent.remove(this._sectionMarkerGroup)
      if (this._sectionLine) this._sectionLine.geometry.dispose()
      if (this._sectionFill) this._sectionFill.geometry.dispose()
      if (this._sectionSphere) this._sectionSphere.geometry.dispose()
      this._sectionMarkerGroup = null
      this._sectionLine = null
      this._sectionFill = null
      this._sectionSphere = null
    }
    this._sectionEnabled = false
    this._sectionPos = null
    this._clearSectionCache()
    this._restoreSectionGeometry()
    this._sectionBox = null
    this._sectionRegions = null
    this._sectionLastAxis = null
    this._lastCutAxis = null
    this._lastCutPos = null
  }

  getSectionPlane() {
    return {
      enabled: this._sectionEnabled ? 1 : 0,
      axis: this._sectionAxis,
      pos: this._sectionPos ?? 0
    }
  }

  /**
   * 注入场盒外解析外推（萨道夫斯基）的物理参数，使外圈岩体着色与网格内
   * 同一物理模型的 PPV/应力/损伤分布及传播曲线一致。
   * @param {Object} p - { chargeKg, K, alpha, beta, visualCp, rho, cp, nu }
   */
  applyFieldPhysics(p = {}) {
    for (const m of this._fieldMaterials()) {
      const u = m.uniforms
      if (Number.isFinite(Number(p.chargeKg)) && p.chargeKg > 0)
        u.uChargeKg.value = Number(p.chargeKg)
      if (Number.isFinite(Number(p.k)) && p.k > 0) u.uSadoskyK.value = Number(p.k)
      if (Number.isFinite(Number(p.alpha)) && p.alpha > 0) u.uSadoskyAlpha.value = Number(p.alpha)
      if (Number.isFinite(Number(p.beta)) && p.beta > 0) u.uSadoskyBeta.value = Number(p.beta)
      if (Number.isFinite(Number(p.visualCp)) && p.visualCp > 0)
        u.uVisualCp.value = Number(p.visualCp)
      // 爆源 grid 局部坐标（掏槽孔质心）：解析外推波环/波前以该点为心
      if (p.origin) {
        const o = Array.isArray(p.origin) ? p.origin : [p.origin.x, p.origin.y, p.origin.z]
        u.uBlastOrigin.value.set(Number(o[0]) || 0, Number(o[1]) || 0, Number(o[2]) || 0)
      }
      if (Number(p.rho) > 0 && Number(p.cp) > 0 && Number.isFinite(Number(p.nu))) {
        const nu = Math.max(0, Math.min(0.49, Number(p.nu)))
        // 应力幅值系数 ρ·c_p/(1−ν)：σ_vm = ρ·c_p·v/(1−ν)（径向压+切向拉，见
        // stress_field_from_ppv / computeStressFieldFromPpv），旧值 ρ·c_p·|1−ν/(1−ν)|
        // 为弹性一维应变近似，未体现切向拉应力主导的爆破破坏机制。
        u.uStressFactor.value = Number(p.rho) * Number(p.cp) * (1 / (1 - nu))
      }
      // 多装药源：将各炮孔装药段写入 uniform 数组（与 GLSL MAX_SOURCES=16 对齐）。
      // 片段着色器据此做各源矢量叠加，驱动非同心圆干涉波场；源数>0 即脱离单源同心圆退化分支。
      if (Array.isArray(p.sources)) {
        const list = p.sources.slice(0, 16)
        u.uSourceCount.value = list.length
        for (let i = 0; i < 16; i++) {
          const s = list[i]
          if (s) {
            u.uSourcePos.value[i].set(Number(s.x) || 0, Number(s.y) || 0, Number(s.z) || 0)
            u.uSourceCharge.value[i] = Number(s.chargeKg) || 0
            u.uSourceDelay.value[i] = (Number(s.delayMs) || 0) / 1000 // ms → s（与 uSimTime 秒同单位）
          } else {
            u.uSourcePos.value[i].set(0, 0, 0)
            u.uSourceCharge.value[i] = 0
            u.uSourceDelay.value[i] = 0
          }
        }
      }
    }
  }

  // ─── 开口隧道内壁几何（两端无 cap 面） ────────────────
  /**
   * 由断面 Shape 轮廓构建开口管状几何（两端开口，无 cap 面）。
   * 相比 ExtrudeGeometry：ExtrudeGeometry 会在两端生成实心 cap 面，
   * 前端 cap 面正好挡住掌子面/岩体，导致"隧道外壁与掌子面重叠部分看不到"。
   * 开口管保证掌子面及后方岩体始终可见，且不产生共面 z-fighting。
   * @param {THREE.Shape} shape - 马蹄形断面（外层轮廓）
   * @param {number} depth - 管长（>0）
   * @param {number} segments - 轮廓采样点数
   * @returns {THREE.BufferGeometry}
   */
  _buildOpenTubeGeometry(shape, depth, segments = 96) {
    const pts = shape.getPoints(segments)
    const n = pts.length
    const positions = new Float32Array(n * 2 * 3)
    const uvs = new Float32Array(n * 2 * 2)
    const nearZ = 0
    const farZ = -depth
    for (let i = 0; i < n; i++) {
      // 轮廓弧长比例作 u、管深比例作 v：供振动场着色材质的岩石纹理/uRockMap 采样
      const u = n > 1 ? i / (n - 1) : 0
      positions[i * 6 + 0] = pts[i].x
      positions[i * 6 + 1] = pts[i].y
      positions[i * 6 + 2] = nearZ
      positions[i * 6 + 3] = pts[i].x
      positions[i * 6 + 4] = pts[i].y
      positions[i * 6 + 5] = farZ
      uvs[i * 4 + 0] = u
      uvs[i * 4 + 1] = 0
      uvs[i * 4 + 2] = u
      uvs[i * 4 + 3] = 1
    }
    const indices = []
    for (let i = 0; i < n; i++) {
      const a = i
      const b = (i + 1) % n
      const na = a * 2
      const fa = a * 2 + 1
      const nb = b * 2
      const fb = b * 2 + 1
      indices.push(na, fa, nb, fa, fb, nb)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    return geo
  }

  // ─── 已开挖段隧道（空心透明轮廓，示意已开挖） ──
  _buildTunnelShell(ctx) {
    const shellLength = 80 // 隧道轮廓长度(m)，覆盖相机视野
    // 已开挖巷道为透明空心轮廓：表示已被开挖，不与未爆破岩体抢视觉。
    // 不参与应力场着色（隧道空腔内部不渲染场色带）——应力场在掌子面前方未爆破岩体内传播。
    const shellGeo = this._buildOpenTubeGeometry(ctx.tunnelShape, shellLength, 96)
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x6a6560,
      map: this.rockTexture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0.05
    })
    this.tunnelShellMesh = new THREE.Mesh(shellGeo, tubeMat)
    // 前端开口位于掌子面处（faceOffset），向 -forward 延伸
    this.tunnelShellMesh.position.set(
      ctx.cx + ctx.dir.x * ctx.faceOffset,
      ctx.cz,
      ctx.cy + ctx.dir.z * ctx.faceOffset
    )
    this.tunnelShellMesh.rotation.y = ctx.yaw
    this.tunnelShellMesh.receiveShadow = true
    this.scene.add(this.tunnelShellMesh)
  }

  // ─── 完整掌子面（薄板马蹄形，爆破前可见） ────────────
  _buildFaceMesh(ctx) {
    const faceThickness = 2
    let faceGeo = new THREE.ExtrudeGeometry(ctx.tunnelShape, {
      depth: faceThickness,
      bevelEnabled: false
    })
    faceGeo.translate(0, 0, -faceThickness / 2)
    // 表面抛光：折痕法线平滑（薄板拱厚棱侧壁 flat→随拱平滑，轮廓仍硬）
    if (this.surfacePolish) {
      const polished = creaseNormals(faceGeo, POLISH_CREASE_DEG)
      faceGeo.dispose()
      faceGeo = polished
    }
    // 掌子面同样使用振动场着色材质，使爆破前后掌子面上都显示 PPV/应力/损伤色带
    this._faceFieldMaterial = this._createFieldMaterial(ctx.faceMat)
    this.faceMesh = new THREE.Mesh(faceGeo, this._faceFieldMaterial)
    this.faceMesh.position.set(
      ctx.cx + ctx.dir.x * ctx.faceOffset,
      ctx.cz,
      ctx.cy + ctx.dir.z * ctx.faceOffset
    )
    this.faceMesh.rotation.y = ctx.yaw
    this.faceMesh.castShadow = true
    this.faceMesh.receiveShadow = true
    this.faceMesh.visible = true
    this.scene.add(this.faceMesh)
    // 掌子面轮廓线：马蹄形断面边缘高亮，暗背景下清晰可辨
    this._attachRockOutline(this.faceMesh)
  }

  // ─── 损伤掌子面 + 3D 爆破漏斗（爆破后可见） ──────────
  _buildFaceDamagedMesh(ctx) {
    const faceThickness = 2
    // 损伤面复用掌子面场着色材质（共用同一套场数据，直接显示 PPV/应力/损伤色带）
    const damagedMat = this._faceFieldMaterial
    // 先计算一次破碎腔轮廓：掌子面孔洞与 3D 漏斗共用同一组点，
    // 保证开口与深腔严格贴合（RNG 有状态，不能分别调用 _computeCraterPoints）
    const craterPtsArr = this._computeCraterPoints(ctx.W, ctx.Hw, ctx.R)
    // 损伤面含漏斗洞口，使用独立 Shape（withCrater=true，复用同一组轮廓点）
    let damagedGeo = new THREE.ExtrudeGeometry(
      this._createTunnelShape(true, ctx.W, ctx.Hw, ctx.R, ctx.totalH, craterPtsArr),
      { depth: faceThickness, bevelEnabled: false }
    )
    damagedGeo.translate(0, 0, -faceThickness / 2)
    // 表面抛光：折痕法线平滑
    if (this.surfacePolish) {
      const polished = creaseNormals(damagedGeo, POLISH_CREASE_DEG)
      damagedGeo.dispose()
      damagedGeo = polished
    }
    this.faceDamagedMesh = new THREE.Mesh(damagedGeo, damagedMat)
    this.faceDamagedMesh.position.copy(this.faceMesh.position)
    this.faceDamagedMesh.rotation.y = ctx.yaw
    this.faceDamagedMesh.castShadow = true
    this.faceDamagedMesh.receiveShadow = true
    this.faceDamagedMesh.visible = false
    this.scene.add(this.faceDamagedMesh)

    // ── 3D 爆破漏斗（掏槽破碎深腔，与掌子面破碎腔尺寸严格一致） ──
    // 开口贴合掌子面破碎腔轮廓（_computeCraterPoints 同一组点），沿进尺方向
    // 收敛成马蹄形深腔；深度与单循环进尺（roundDepth）匹配，避免圆形漏斗
    // 与马蹄形断面错位、以及过浅/过深失真。
    // 深度约束：几何层漏斗最深处 = 开口偏移 + 1.02×depth（见 _buildCraterGeometry
    // 的底部收口 bottomZ=d*1.02），必须止于岩体前缘（新掌子面 faceOffset+roundDepth）
    // 之前并留出 clearance。否则漏斗收口底体会嵌进后方岩体的前方面产生穿模。
    const CRATER_MOUTH_OFFSET = 0.15
    const CRATER_TAIL_CLEAR = 0.15
    const craterDepth = Math.max(
      0.5,
      (ctx.roundDepth - CRATER_MOUTH_OFFSET - CRATER_TAIL_CLEAR) / 1.02
    )
    let craterGeo = this._buildCraterGeometry(craterPtsArr, craterDepth)
    // 表面抛光：折痕法线平滑（漏斗收敛壁光照连续，口/底环仍锐利）
    if (this.surfacePolish) {
      const polished = creaseNormals(craterGeo, POLISH_CREASE_DEG)
      craterGeo.dispose()
      craterGeo = polished
    }
    // 复用掌子面振动场着色材质（_faceFieldMaterial）：让爆破漏斗壁同样显示
    // PPV/应力/损伤场色，彻底替换原先的纯黑 void 材质，与周围岩体/掌子面
    // 的场色拼接一致（不再"无着色/拼接突兀"）。
    this.craterMesh = new THREE.Mesh(craterGeo, this._faceFieldMaterial)
    // 漏斗几何已在隧道局部坐标系（y=高度，z=向岩体纵深），
    // 定位与掌子面一致即可，无需再叠加断面质心高度 hcy
    this.craterMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + CRATER_MOUTH_OFFSET),
      ctx.cz,
      ctx.cy + ctx.dir.z * (ctx.faceOffset + CRATER_MOUTH_OFFSET)
    )
    this.craterMesh.rotation.y = ctx.yaw
    this.craterMesh.castShadow = true
    this.craterMesh.receiveShadow = true
    this.craterMesh.visible = false
    this.scene.add(this.craterMesh)
  }

  // ─── 爆破钻孔（主协调入口） ──────────────────────────
  /**
   * 在掌子面上构建爆破钻孔布孔图案。
   * 若设置了 this.blastHoleDesign（数据库炮孔设计数据），则动态渲染；
   * 否则回退到硬编码典型布孔（中央菱形掏槽 + 2 圈辅助 + 周边孔）。
   */
  _buildBlastHoles(yaw, faceOffset) {
    this._disposeGroup(this.blastHolesGroup)
    this.blastHolesGroup = null

    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight
    const cy0 = totalH * 0.5 // 掌子面中心高度

    // 1. 收集孔位（数据库模式 / 回退模式）
    const holes = this._collectBlastHoles(cy0, W, Hw, R, totalH)

    // 2. 构建 mesh + 孔位标注
    const group = this._buildHoleMeshes(holes)

    // 3. 整体定位到掌子面位置
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = true
    this.scene.add(group)
    this.blastHolesGroup = group

    // 4. 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）
    this._saveBlastHolePattern(holes, W, Hw, R, totalH)

    // 5. 构建专业标注（掘进深度、断面尺寸、孔型分区标签）
    this._buildAnnotations(yaw, faceOffset)
  }

  // ─── 孔位收集：按数据源分发 ──────────────────────────
  _collectBlastHoles(cy0, W, Hw, R, _totalH) {
    if (this.blastHoleDesign && this.blastHoleDesign.length > 0) {
      return this._collectDesignHoles(cy0)
    }
    return this._collectFallbackHoles(cy0, W, Hw, R)
  }

  // ─── 数据库模式：从 blastHoleDesign 动态生成孔位 ──────
  _collectDesignHoles(cy0) {
    const defaultDepth = Number(this.designParams?.holeDepth) || 2.5
    const defaultDiameter = Number(this.designParams?.holeDiameter) || 0.04
    const holes = []
    for (const h of this.blastHoleDesign) {
      const type = (h.holeType || 'production').toLowerCase()
      let mappedType = 'auxiliary'
      if (type === 'cut' || type === 'easing') mappedType = 'cut'
      else if (type === 'perimeter') mappedType = 'perimeter'
      const isEmpty = !!h.isEmptyHole
      const depth = Math.max(0.1, Number(h.depth) || defaultDepth)
      const realDia = Number(h.diameter) || defaultDiameter
      const visRadius = Math.max(0.08, realDia * 4) // 视觉放大 4 倍
      const x = Number(h.posX) || 0
      const y = Number(h.posY) || cy0
      // 运行时断面钳制：孔口坐标必须落在掌子面马蹄形轮廓内侧，否则丢弃，
      // 防止任何来源（设计/数据库）的越界孔显示在洞周/底板之外。
      if (!this._insideFaceProfile(x, y)) continue
      holes.push({
        x,
        y,
        type: mappedType,
        isEmpty,
        depth,
        visRadius,
        inclination: Number(h.inclinationAngle ?? h.inclination) || 0,
        azimuth: Number(h.inclinationAzimuth ?? h.azimuth) || 0,
        chargeKg: Number(h.chargeKg) || 0,
        chargeLength: Number(h.chargeLength) || 0,
        explosiveType: h.explosiveType || 'emulsion',
        detonatorSeries: Number(h.detonatorSeries) || 1,
        delayMs: Number(h.delayMs) || 0,
        id: h.id
      })
    }
    return holes
  }

  // 孔口是否落在掌子面马蹄形断面轮廓内侧（基准：底板 y=0，直墙高 Hw，拱半 R）
  _insideFaceProfile(x, y) {
    if (y < -1e-4) return false // 不越底板
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const halfW = this.tunnelWidth / 2
    if (y <= Hw) return Math.abs(x) <= halfW
    const dy = y - Hw
    return x * x + dy * dy <= R * R
  }

  // ─── 回退模式：硬编码典型布孔（菱形掏槽 + 辅助 + 周边）
  _collectFallbackHoles(cy0, W, Hw, R) {
    // ─ 参数化：B/S/q/cutPattern 从 designParams/kcoParams 读取 ─
    const B = Math.max(0.3, Number(this.designParams?.burden) || Number(this.kcoParams?.B) || 1.5)
    const S = Math.max(0.3, Number(this.designParams?.spacing) || Number(this.kcoParams?.S) || 2.0)
    const q = Math.max(0.05, Number(this.kcoParams?.q) || 0.8)
    const cutPattern = this.designParams?.cutPattern || 'wedge'
    const holeDepth = Math.max(0.5, Number(this.designParams?.holeDepth) || 2.5)
    const realDia = Number(this.designParams?.holeDiameter) || 0.04
    const visRadius = Math.max(0.08, realDia * 4)
    const emptyVisRadius = visRadius * 1.6
    const totalH = this.tunnelHeight

    // 单孔药量 = q × B × S × holeDepth × 孔型系数
    const chargeKg = factor => q * B * S * holeDepth * factor

    const holes = []
    let series = 1
    const nextSeries = () => {
      series = (series % 20) + 1
      return series
    }

    // ─ 1. 掏槽孔（按 cutPattern 分发） ─
    const cutR = B * 0.6 // 抵抗线驱动，替代硬编码 1.0
    // 中心空孔（所有掏槽形式共用）
    holes.push({
      x: 0,
      y: cy0,
      type: 'cut',
      isEmpty: true,
      depth: holeDepth,
      visRadius: emptyVisRadius,
      inclination: 0,
      azimuth: 0,
      chargeKg: 0,
      chargeLength: 0,
      explosiveType: 'emulsion',
      detonatorSeries: 1,
      delayMs: 0,
      id: 'CUT-EMPTY'
    })

    if (cutPattern === 'spiral') {
      // 螺旋掏槽：4 孔螺旋递进，半径从 B×0.4 到 B×0.7
      const spiralSteps = 4
      for (let i = 0; i < spiralSteps; i++) {
        const r = B * (0.4 + 0.1 * i)
        const a = (i / spiralSteps) * Math.PI * 2
        holes.push({
          x: Math.cos(a) * r,
          y: cy0 + Math.sin(a) * r,
          type: 'cut',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 0,
          azimuth: 0,
          chargeKg: chargeKg(1.2),
          chargeLength: holeDepth * 0.8,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: 50 * (i + 1),
          id: `CUT-S${i + 1}`
        })
      }
    } else if (cutPattern === 'wedge') {
      // 楔形掏槽（Da Balai 文献模式）：2~3 排斜孔 V 形开口，角度 70→60°
      // 掏槽孔分"初始(primary) + 辅助(secondary)"两批，消除耦合延时 Δt（文献最优 4~8ms，
      // 现场取 Δt=4ms），且**初始掏槽孔减量装药**（微差延迟爆破减振机理的核心）：
      //   primary 减量 0.7× 先起爆 → 生成初始爆破自由面；
      //   secondary 1.0× 延时 Δt 后起爆 → 朝自由面充分破碎、降低围岩约束。
      // 各孔日期延时而分布在 0~Δt 内（2ms 步进），使掏出孔组应力波在孔底汇拢处
      // 相长干涉、错相位处相消 → 应力场呈多源干涉斑块，而非单一同心圆。
      const wedgeN = 3
      // 延时方案：孔内微差按 [0, 2, 4] ms 递进（secondary 落在文献最优延时窗 4ms）
      const wedgeCutDelayMs = [0, 2, 4]
      // 装药系数：初始孔减量(0.7×未爆抛)，随批次接近完整(1.0×)
      const wedgeChargeFactor = [0.7, 0.85, 1.0]
      for (let i = 0; i < wedgeN; i++) {
        const offset = B * (0.5 + 0.15 * i)
        const incline = 70 - i * 5
        for (const side of [-1, 1]) {
          holes.push({
            x: side * offset,
            y: cy0,
            type: 'cut',
            isEmpty: false,
            depth: holeDepth,
            visRadius,
            inclination: i === 0 ? 74 : incline, // 首排更陡向核心
            azimuth: side > 0 ? 90 : -90,
            chargeKg: chargeKg(wedgeChargeFactor[i] * 1.2),
            chargeLength: holeDepth * 0.8,
            explosiveType: 'emulsion',
            detonatorSeries: nextSeries(),
            delayMs: wedgeCutDelayMs[i],
            id: `CUT-W${i + 1}-${side > 0 ? 'R' : 'L'}`
          })
        }
      }
    } else {
      // 菱形掏槽（默认）：4 孔 + 1 空孔
      const cutPos = [
        [cutR, cy0],
        [-cutR, cy0],
        [0, cy0 + cutR],
        [0, cy0 - cutR]
      ]
      cutPos.forEach((p, i) => {
        holes.push({
          x: p[0],
          y: p[1],
          type: 'cut',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 0,
          azimuth: 0,
          chargeKg: chargeKg(1.2),
          chargeLength: holeDepth * 0.8,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: 100 * (i + 2),
          id: `CUT-${i + 1}`
        })
      })
    }

    // ─ 2. 辅助孔（圈数/半径/孔数由 B/S/断面驱动） ─
    const cutZone = 2 * cutR
    const maxR = Math.min(W, totalH) * 0.45
    const ringCount = Math.max(1, Math.ceil((maxR - cutZone) / (2 * B)))
    for (let ring = 1; ring <= ringCount; ring++) {
      const r = cutZone + 2 * B * ring
      if (r > maxR) break
      const n = Math.max(6, Math.floor((2 * Math.PI * r) / S))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.cos(a) * r
        const y = cy0 + Math.sin(a) * r
        if (this._isInsideTunnelSection(x, y, W, Hw, R)) {
          holes.push({
            x,
            y,
            type: 'auxiliary',
            isEmpty: false,
            depth: holeDepth,
            visRadius,
            inclination: 0,
            azimuth: 0,
            chargeKg: chargeKg(1.0),
            chargeLength: holeDepth * 0.7,
            explosiveType: 'emulsion',
            detonatorSeries: nextSeries(),
            delayMs: series * 100,
            id: `AUX-${ring}-${i}`
          })
        }
      }
    }
    // ─ 3. 周边孔（间距 = 0.8 × S，光面爆破经验） ─
    const perimSpacing =
      Number(this.designParams?.perimeterSpacing) > 0
        ? Number(this.designParams.perimeterSpacing)
        : 0.8 * S
    let perimSeries = series
    for (let y = 1.0; y <= Hw - 0.3; y += perimSpacing) {
      for (const x of [-W / 2 + 0.35, W / 2 - 0.35]) {
        holes.push({
          x,
          y,
          type: 'perimeter',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 3,
          azimuth: x > 0 ? 90 : -90,
          chargeKg: chargeKg(0.5),
          chargeLength: holeDepth * 0.6,
          explosiveType: 'emulsion',
          detonatorSeries: perimSeries,
          delayMs: perimSeries * 100,
          id: `PER-W-${perimSeries}`
        })
        perimSeries = (perimSeries % 20) + 1
      }
    }
    const archN = Math.max(8, Math.floor((Math.PI * R) / perimSpacing))
    for (let i = 1; i < archN; i++) {
      const a = Math.PI - (i / archN) * Math.PI
      const x = Math.cos(a) * R
      const y = Hw + Math.sin(a) * R
      holes.push({
        x,
        y,
        type: 'perimeter',
        isEmpty: false,
        depth: holeDepth,
        visRadius,
        inclination: 3,
        azimuth: (Math.atan2(x, y - Hw) * 180) / Math.PI,
        chargeKg: chargeKg(0.5),
        chargeLength: holeDepth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: perimSeries,
        delayMs: perimSeries * 100,
        id: `PER-A-${perimSeries}`
      })
      perimSeries = (perimSeries % 20) + 1
    }
    holes.push({
      x: -W / 2 + 0.4,
      y: 0.5,
      type: 'perimeter',
      isEmpty: false,
      depth: holeDepth,
      visRadius,
      inclination: 5,
      azimuth: -90,
      chargeKg: chargeKg(0.5),
      chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: perimSeries,
      delayMs: perimSeries * 100,
      id: 'PER-BL'
    })
    holes.push({
      x: W / 2 - 0.4,
      y: 0.5,
      type: 'perimeter',
      isEmpty: false,
      depth: holeDepth,
      visRadius,
      inclination: 5,
      azimuth: 90,
      chargeKg: chargeKg(0.5),
      chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: perimSeries,
      delayMs: perimSeries * 100,
      id: 'PER-BR'
    })
    return holes
  }

  // ─── 构建钻孔几何体（按类型分组共享材质/几何，性能优化）──
  _buildHoleMeshes(holes) {
    const group = new THREE.Group()
    const faceThickness = 2
    const frontZ = faceThickness / 2 + 0.02 // 略凸出掌子面前表面

    // 按类型 + visRadius 聚合，减少几何体实例数
    const geoCache = new Map()
    const matCache = new Map()
    const getGeo = (visRadius, depth) => {
      const key = `${visRadius.toFixed(3)}_${depth.toFixed(3)}`
      if (!geoCache.has(key)) {
        const g = new THREE.CylinderGeometry(visRadius, visRadius, depth, 12)
        g.rotateX(Math.PI / 2) // Y → Z 轴，向 -Z 延伸
        geoCache.set(key, g)
      }
      return geoCache.get(key)
    }
    const getMat = (type, isEmpty) => {
      const key = `${type}_${isEmpty ? 'e' : 'f'}`
      if (!matCache.has(key)) {
        const color = isEmpty ? EMPTY_HOLE_COLOR : (HOLE_TYPE_COLORS[type] ?? 0xfeca57)
        const m = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.7,
          metalness: 0.1,
          emissive: isEmpty ? 0x222222 : color & 0x222222, // 空孔弱自发光
          emissiveIntensity: isEmpty ? 0.2 : 0.1,
          flatShading: true
        })
        matCache.set(key, m)
      }
      return matCache.get(key)
    }

    holes.forEach(h => {
      const geo = getGeo(h.visRadius, h.depth)
      const mat = getMat(h.type, h.isEmpty)
      const mesh = new THREE.Mesh(geo, mat)
      // 位置：圆柱中心位于 frontZ - depth/2，使前端贴齐掌子面、向岩体内延伸
      mesh.position.set(h.x, h.y, frontZ - h.depth / 2)

      // 倾斜渲染
      if (h.inclination && h.inclination > 0.1) {
        const incRad = (h.inclination * Math.PI) / 180
        const aziRad = (h.azimuth * Math.PI) / 180
        mesh.rotation.set(-Math.sin(aziRad) * incRad, Math.cos(aziRad) * incRad, 0, 'XYZ')
      }

      // 孔位标注已移除：模型上不再显示每孔编号/段别/装药量标签，仅保留孔位圆柱
      group.add(mesh)
    })
    return group
  }

  // ─── 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）──
  _saveBlastHolePattern(holes, W, Hw, R, totalH) {
    const cutHoles = holes.filter(h => h.type === 'cut')
    const perimHoles = holes.filter(h => h.type === 'perimeter')
    const auxHoles = holes.filter(h => h.type === 'auxiliary')
    this.blastHolePattern = {
      section: { W, Hw, R, totalH },
      holes: holes.map(h => ({
        x: h.x,
        y: h.y,
        isEmpty: h.isEmpty,
        type: h.type,
        depth: h.depth,
        inclination: h.inclination,
        azimuth: h.azimuth,
        chargeKg: h.chargeKg,
        chargeLength: h.chargeLength,
        explosiveType: h.explosiveType,
        detonatorSeries: h.detonatorSeries,
        delayMs: h.delayMs,
        id: h.id
      })),
      counts: {
        cut: cutHoles.length,
        auxiliary: auxHoles.length,
        perimeter: perimHoles.length,
        total: holes.length,
        empty: holes.filter(h => h.isEmpty).length
      }
    }
  }

  // ─── 专业爆破元素 3D 标注 ─────────────────────────────
  _buildAnnotations(yaw, faceOffset) {
    // 独立清理旧标注组（避免重复调用时累积）
    this._disposeGroup(this.annotationsGroup)
    this.annotationsGroup = null

    const group = new THREE.Group()
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 掘进深度标注（保留）
    const holeDepth = Number(this.designParams?.holeDepth) || 2.5
    const utilization = Number(this.designParams?.utilization) || 0.85
    const advanceDepth = Number(this.designParams?.advanceLength) || holeDepth * utilization
    const advanceLabel = this._createTextSprite(
      `掘进进尺: ${advanceDepth.toFixed(2)} m  (孔深${holeDepth.toFixed(1)}m × 利用率${(utilization * 100).toFixed(0)}%)`,
      '#ffd166',
      32
    )
    advanceLabel.position.set(W * 0.5 + 1.5, totalH - 1, 0.1)
    group.add(advanceLabel)

    // 断面尺寸标注（保留）
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const shapeLabel = this.tunnelSection?.shape || 'horseshoe'
    const shapeCN =
      shapeLabel === 'horseshoe'
        ? '马蹄形'
        : shapeLabel === 'circular'
          ? '圆形'
          : shapeLabel === 'rectangular'
            ? '矩形'
            : '拱形'
    const sizeLabel = this._createTextSprite(
      `断面: ${shapeCN} ${W}m × ${totalH.toFixed(1)}m  (A=${sectionArea.toFixed(1)}m²)`,
      '#4fc3f7',
      28
    )
    sizeLabel.position.set(-W * 0.5 - 1.5, totalH - 1, 0.1)
    group.add(sizeLabel)

    // 整体定位到掌子面前表面
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = this.layerVisibility.annotations !== false
    this.scene.add(group)
    this.annotationsGroup = group
  }

  // ─── 文字 Sprite 创建 ────────────────────────────────
  /**
   * 创建文字 Sprite（Canvas 纹理，始终面向相机）
   * @param {string} text - 文字内容
   * @param {string} color - 文字颜色（CSS）
   * @param {number} fontSize - 字号
   * @returns {THREE.Sprite}
   */
  _createTextSprite(text, color = '#ffffff', fontSize = 24) {
    const padding = 12
    const supersample = 4 // 4x 超采样保证文字高清锐利
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const logicalFont = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    ctx.font = logicalFont
    const metrics = ctx.measureText(text)
    const logicalW = Math.ceil(metrics.width) + padding * 2
    const logicalH = fontSize + padding * 2
    canvas.width = logicalW * supersample
    canvas.height = logicalH * supersample
    const c2 = canvas.getContext('2d')
    c2.scale(supersample, supersample)
    c2.font = logicalFont
    c2.fillStyle = 'rgba(0, 0, 0, 0.55)'
    c2.fillRect(0, 0, logicalW, logicalH)
    c2.strokeStyle = color
    c2.lineWidth = 2
    c2.strokeRect(1, 1, logicalW - 2, logicalH - 2)
    c2.fillStyle = color
    c2.textBaseline = 'middle'
    c2.fillText(text, padding, logicalH / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(material)
    // 缩放：使用逻辑尺寸（非超采样物理尺寸）映射到 3D 场景
    const scale = 0.035
    sprite.scale.set(logicalW * scale, logicalH * scale, 1)
    return sprite
  }

  // ─── 爆破漏斗几何 ────────────────────────────────────
  /**
   * 构建爆破漏斗 3D 几何（贴合掌子面破碎腔轮廓的收敛深腔）
   * @param {Array<{x:number,y:number}>} pts - 掌子面破碎腔开口轮廓点（隧道局部坐标，y=高度）
   * @param {number} depth - 腔深(m)
   */
  _buildCraterGeometry(pts, depth) {
    const geo = new THREE.BufferGeometry()
    const n = pts.length
    const d = Math.max(0.5, depth)
    const verts = []
    const uvs = [] // 漏斗共享场着色材质需要 uv（此前缺失→岩石纹理恒取 (0,0) 单色块）
    const idx = []
    const pushV = (x, y, z, u, v) => {
      verts.push(x, y, z)
      uvs.push(u, v)
    }
    // 开口环（与掌子面破碎腔轮廓严格一致）；u 沿轮廓、v 沿腔深
    for (let j = 0; j < n; j++) {
      const p = pts[j]
      pushV(p.x, p.y, 0, j / n, 0)
    }
    // 轮廓包围盒中心作为收敛基准
    const cx = pts.reduce((s, p) => s + p.x, 0) / n
    const cy = pts.reduce((s, p) => s + p.y, 0) / n
    // 收敛分层：逐层向中心缓收并沿 z 下沉，形成马蹄形深腔。
    // 全断面爆破后的空腔接近等断面（仅轻微收敛），避免过度收成"钻孔尖锥"
    // 表面抛光开启时提高细分，消漏斗"折纸"多面体感
    const rings = this.surfacePolish ? 18 : 8
    for (let ring = 1; ring <= rings; ring++) {
      const t = ring / rings
      const z = d * t * t
      const s = 1 - t * 0.35
      for (let j = 0; j < n; j++) {
        const p = pts[j]
        pushV(cx + (p.x - cx) * s, cy + (p.y - cy) * s, z, j / n, t)
      }
    }
    // 底部收口（保留较大开口而非尖点，避免"钻孔腔"观感）
    const bottomScale = 0.55
    const bottomZ = d * 1.02
    for (let j = 0; j < n; j++) {
      const p = pts[j]
      pushV(cx + (p.x - cx) * bottomScale, cy + (p.y - cy) * bottomScale, bottomZ, j / n, 1)
    }
    const bottomBase = verts.length / 3 - n
    for (let ring = 0; ring < rings; ring++) {
      for (let i = 0; i < n; i++) {
        const a = ring * n + i
        const b = ring * n + ((i + 1) % n)
        const c = a + n
        // 注意：i=n-1 时 (i+1)%n=0，e 必须回到下一环首点，不能写成 c+((i+1)%n)（会 e==c 产生退化三角形）
        const e = (ring + 1) * n + ((i + 1) % n)
        idx.push(a, b, c, b, e, c)
      }
    }
    // 底部收口面：连接最后一层收缩环与底部小环
    for (let i = 0; i < n; i++) {
      const a = rings * n + i
      const b = rings * n + ((i + 1) % n)
      const c = bottomBase + i
      const e = bottomBase + ((i + 1) % n)
      idx.push(a, b, c, b, e, c)
    }
    // 底部小环封底（使腔体闭合，避免看到腔后的岩体）。
    // 凹马蹄形不能用单点扇形剖分（会产生交叉/退化三角形），改用耳切法三角剖分
    const bottomRing = []
    for (let i = 0; i < n; i++) {
      bottomRing.push(
        new THREE.Vector2(verts[(bottomBase + i) * 3], verts[(bottomBase + i) * 3 + 1])
      )
    }
    const bottomTris = THREE.ShapeUtils.triangulateShape(bottomRing, [])
    for (const tri of bottomTris) {
      idx.push(bottomBase + tri[0], bottomBase + tri[1], bottomBase + tri[2])
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    return geo
  }

  // ─── 断面内判断 ──────────────────────────────────────
  _isInsideTunnelSection(x, y, W, Hw, R) {
    if (Math.abs(x) > W / 2 - 0.2) return false
    if (y < 0.2) return false
    if (y <= Hw) return true
    const dx = x
    const dy = y - Hw
    return dx * dx + dy * dy <= (R - 0.2) * (R - 0.2)
  }

  // ─── 爆破触发（切换掌子面可见性） ────────────────────
  triggerBlast() {
    this.applyBlastState(true)
  }

  /**
   * 统一应用爆破前后掌子面/待爆岩体的可见状态。
   * @param {boolean} triggered - true=已爆破（待爆循环变成开挖空腔、新掌子面前移；
   *                              外层围岩始终保留）；false=未爆破（完整掌子面+待爆循环）
   */
  applyBlastState(triggered) {
    const showFace = this.layerVisibility.face !== false
    // 外层围岩/掌子面前方岩体始终存在；爆破后整体退到新掌子面（无缝拼接）
    if (this.benchMesh) {
      this.benchMesh.visible = true
      this._setRockGeometry(triggered)
    }
    // 爆破后：待爆段变为开挖空腔壁（覆盖层），其接触环与岩体新掌子面共面
    if (this.excavatedTubeMesh) this.excavatedTubeMesh.visible = triggered
    if (this.faceMesh) this.faceMesh.visible = !triggered && showFace
    if (this.faceDamagedMesh) this.faceDamagedMesh.visible = triggered && showFace
    if (this.craterMesh) this.craterMesh.visible = triggered && showFace
    if (this.blastHolesGroup) this.blastHolesGroup.visible = !triggered
  }

  // ─── 图层可见性应用 ──────────────────────────────────
  /**
   * 将指定图层的可见性应用到对应 Three.js 对象
   * @param {string} layer - 图层名
   * @param {boolean} visible - 是否可见
   * @param {boolean} blastTriggered - 爆破是否已触发
   */
  applyLayerVisibility(layer, visible, blastTriggered) {
    switch (layer) {
      case 'tunnel':
        if (this.tunnelShellMesh) this.tunnelShellMesh.visible = visible
        break
      case 'bench':
        // 层开关控制外层岩体；爆破后岩体退到新掌子面，空腔壁跟随爆破状态切换
        if (this.benchMesh) {
          this.benchMesh.visible = visible
          this._setRockGeometry(blastTriggered)
        }
        if (this.excavatedTubeMesh) this.excavatedTubeMesh.visible = visible && blastTriggered
        break
      case 'face':
        if (this.faceMesh) this.faceMesh.visible = visible && !blastTriggered
        if (this.faceDamagedMesh) this.faceDamagedMesh.visible = visible && blastTriggered
        if (this.craterMesh) this.craterMesh.visible = visible && blastTriggered
        break
      case 'blastHoles':
        if (this.blastHolesGroup) {
          this.blastHolesGroup.visible = visible && !blastTriggered
        }
        break
      case 'annotations':
        if (this.annotationsGroup) this.annotationsGroup.visible = visible
        break
    }
  }

  /**
   * 控制待爆岩体表面振动场着色强度（兼容旧接口名）。
   *
   * 旧实现通过把岩体半透明化来"透显"掌子面前方体积盒（raymarching 云图），
   * 现已改为直接把应力/损伤/PPV 场渲染在岩体表面（benchMesh ShaderMaterial），
   * 故不再需要半透明。此处改为控制表面场的着色权重：
   *   semi=true  → 岩体表面按场数据着色（场强度由各像素场值决定）
   *   semi=false → 只显示岩石本色
   * @param {boolean} semi - true=显示岩体表面场着色；false=仅岩石本色
   */
  setRockSemiTransparent(semi) {
    const on = !!semi
    if (this._rockSemiTransparent === on) return
    this._rockSemiTransparent = on
    // 保持适中权重（0.62），既呈现应力/损伤/PPV 场色，又保留岩石纹理细节，
    // 避免场色完全覆盖岩面导致看不出模型细节。
    this.setBenchFieldWeight(on ? 0.62 : 0.0)
  }

  // ─── 隧道断面参数更新 ────────────────────────────────
  /**
   * 更新隧道断面参数（由主渲染器 setTunnelSection 调用）
   * @param {Object} section - 断面参数
   */
  setTunnelSection(section) {
    const next = { ...this.tunnelSection, ...section }
    next.width = Math.max(2, Number(next.width) || this.tunnelSection.width)
    next.wallHeight = Math.max(1, Number(next.wallHeight) || this.tunnelSection.wallHeight)
    next.archRadius = Math.max(1, Number(next.archRadius) || this.tunnelSection.archRadius)
    const validShapes = ['horseshoe', 'circular', 'rectangular']
    if (!validShapes.includes(next.shape)) next.shape = 'horseshoe'
    this.tunnelSection = next
    this.tunnelWidth = next.width
    this.tunnelWallHeight = next.wallHeight
    this.tunnelArchRadius = next.archRadius
    this.tunnelHeight =
      next.shape === 'circular'
        ? next.archRadius * 2
        : next.shape === 'rectangular'
          ? next.wallHeight
          : next.wallHeight + next.archRadius
  }

  // ─── 清理场景网格 ────────────────────────────────────
  clear() {
    this._cleanupBenchGeometry()
    // 清理岩石纹理
    if (this.rockTexture) {
      this.rockTexture.dispose()
      this.rockTexture = null
    }
    this.fireLight.intensity = 0
  }

  // ─── 资源释放 ────────────────────────────────────────
  dispose() {
    this.clear()
  }
}
