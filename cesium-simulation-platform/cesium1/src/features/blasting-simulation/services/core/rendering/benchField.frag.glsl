precision highp float;
precision highp sampler3D;

uniform sampler2D uRockMap;            // 岩石纹理（底色）
uniform sampler3D uPpvTexture;         // PPV 场（m/s）
uniform sampler3D uStressTexture;      // σ_vm 场（Pa）
uniform sampler3D uDamageTexture;      // 损伤分区（0~4）
uniform sampler2D uPpvLut;             // PPV 色阶 LUT
uniform sampler2D uStressLut;          // σ_vm 色阶 LUT

uniform vec3  uBoundsMin;              // grid 边界下界
uniform vec3  uBoundsMax;              // grid 边界上界
uniform vec3  uGridSize;               // 3D 场纹理尺寸(nx,ny,nz)
uniform float uGridSampleMode;         // 0=voxel centers, 1=endpoint nodes
uniform float uDamageReady;            // 已收到有效 DAMAGE 分类场时为 1
uniform vec3  uCenter;                 // 爆心世界坐标
uniform vec3  uBlastOrigin;            // 爆源 grid 局部坐标（缺省网格原点；掏槽孔质心）
uniform vec3  uRight;                  // 隧道宽度方向基向量
uniform vec3  uUp;                     // 竖直方向基向量
uniform vec3  uForward;                // 掌子面朝向基向量
uniform int   uDisplayMode;            // 0=PPV, 1=STRESS, 2=DAMAGE

// —— 隧道洞身截断 & 轴向延展（破除纯径向"同心球"）——
// 洞身近似为"自爆心沿 +uForward 延伸 uHoleLen 的圆柱柱(半径 uHoleRadius)"：
// 爆心位于掌子面(洞身起点)，已开挖洞身向岩身方向推进一段。
// 视线(爆心→片元)若穿过该洞身圆柱，片元的直达波被空腔截断 → 乘遮挡衰减；
// 传播方向越"横向(近自由面/临空面)"能量卸荷越快 → 轴向延展，波沿巷道向远传。
uniform float uHoleRadius;             // 洞身圆柱半径(=半幅宽)
uniform float uHoleLen;                // 洞身沿轴向长度(=单循环进尺 roundDepth)
uniform float uLateralAttn;            // 横向衰减系数(<1：离开轴向的水平向衰减更多)
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
uniform float uPpvVisualBeta;          // 已废弃（峰值判据改为按起爆段取最大，不再用可视化衰减项；保留槽位兼容下发）
uniform float uVisualCp;               // 可视化波前传播速度(m/s)
uniform float uSimTime;                // 当前模拟时间(s)
uniform float uStressFactor;           // ρ·c_p/(1−ν)，PPV→σ_vm(Pa)
uniform vec3  uRockColor;              // 岩石基础色
uniform vec3  uSunDir;                 // 方向光方向（世界空间，用于岩面明暗）
uniform float uGlobalOpacity;          // 全局透明度（1=不透明；隧道内壁等半透明面用）
uniform float uSectionEnabled;         // 剖面裁剪开关（1=启用）
uniform vec3  uSectionNWorld;          // 剖切平面法线（世界空间，与岩体 CSG 切面一致）
uniform float uSectionCWorld;          // 剖切平面常量（世界空间：dot(p,n)+c >= 0 一侧保留）
uniform float uSectionAxis;            // 裁剪轴（0=X 1=Y 2=Z，基于场景 rel 坐标）
uniform float uSectionPos;             // 裁剪平面位置（沿轴，场景相对 uCenter）
// 剖面裁剪：外部调用 setSectionPlane，用于爆破模式下观察岩体内部

// 多装药源（各炮孔装药段）波包矢量叠加：驱动岩面非同心圆干涉波场。
// 掏槽楔形孔在孔底汇拢、各源延时起爆，矢量叠加产生相长/相消干涉瓣（同 backend ppv_field_3d_multi）。
// 【扩容 96】16 上限会把多孔事件按顺序截断、丢掉后段延期（300~525ms）波系 →
// 中期波前过后场值走低、波系不完整。96 覆盖全部布孔，与 CPU 全源口径一致。
// 【打包存储】vec4(xyz=位置, w=源强度系数 K·q^(α/3)·0.01)：JS 侧一次算好，
// 片元内免去每源一次 pow；96+24=120 个 uniform 向量槽，低于 WebGL2 片元保底 224。
#define MAX_SOURCES 96
uniform int   uSourceCount;                 // 有效装药源数量（0=退化为单一 uBlastOrigin 源）
uniform vec4  uSourcePosQ[MAX_SOURCES];     // xyz=各源 grid 局部坐标(m)，w=源强度系数
uniform float uSourceDelay[MAX_SOURCES];    // 各源延期(s)——【须按延时升序写入】峰值累加依赖此序
uniform float uCarrierHz;                   // 波包子波载波频率(Hz，0=关)：行波环/多源干涉瓣
uniform float uArrivalRise;                 // 波前起跳沿时长(s)：见源循环处注释
// 瞬时场**显示**时变衰减(1/s)：只作用于瞬时场（显示"薄亮环向外推进"）。
// 峰值判据不再依赖任何时变衰减（按起爆段取最大，见 peak 计算处），
// 亮环厚度 ≈ uVisualCp / uDisplayDecay。旧实现显示/判据共用 0.8 衰减，
// 亮带厚达视觉波速×1.2s（≈42m），近乎铺满整块岩体 → 观感"波一动不动"。
uniform float uDisplayDecay;
uniform float uReflectOn;                   // 掌子面自由面镜象反射(1=开)
uniform float uReflectCoeff;                // 反射系数（自由面近全反射取 0.85）
uniform float uFaceZ;                       // 掌子面轴向位置(m，grid 局部系)

// 波动相位子波包络（视觉 Hz）：正交双分量 cos/sin 共用，按品质因数 Q=12 指数衰减
// （8Hz 时衰减率 π·8/12≈2.1/s，单波环可见持时 ~1.4s）——行波脉冲环既要"分明"，
// 又要在数秒时间轴上有足够可见持时（Q=4 时 0.5s 内即衰减殆尽，播放中后段全场死蓝）。
#define WAVELET_Q 12.0
// 场值归一化：线性标尺 + 动态满量程（uNormAutoScale）——与 LS-DYNA 色带口径一致
// （数据范围内线性均分：低值=蓝、高值=红）。常量由
// vibrationColorScales.js 单源提供（图例刻度/渐变共用同一套映射）。
uniform float uNormAutoScale;
in vec3 vWorldPos;
in vec2 vUv;
in vec3 vWorldNormal;
in vec3 vViewDir; // 片元→相机单位方向（轮廓高光用）
out vec4 fragColor;

// 损伤分区离散取色（zone 0~4）；返回 rgb 与强度
// zone 语义与阈值见 vibrationColorScales.js DAMAGE_ZONES/DAMAGE_THRESHOLDS_CMPS
// （0 弹性 / 1 微裂纹 / 2 裂隙扩展 / 3 破碎 / 4 粉碎区-近炮腔；历史上 zone4 曾误标"抛掷区"，
//  抛掷是碎片运动学概念，由 fragmentSpecGenerator 速度场负责，与 PPV 分区无对应关系）
void damageColor(float zone, out vec3 col, out float alpha) {
  // 与 vibrationColorScales.js 中 DAMAGE_ZONES 色卡完全同值。
  // zone 0 为弹性区，仅保留岩面底色；正损伤档直接显示色卡颜色。
  if (zone < 0.5)                    col = vec3(77.0, 77.0, 89.0) / 255.0;
  else if (zone < 1.5)                col = vec3(230.0, 217.0, 77.0) / 255.0;
  else if (zone < 2.5)                col = vec3(242.0, 140.0, 38.0) / 255.0;
  else if (zone < 3.5)                col = vec3(230.0, 51.0, 38.0) / 255.0;
  else                                col = vec3(153.0, 13.0, 26.0) / 255.0;
  alpha = zone < 0.5 ? 0.0 : 1.0;
}

vec3 damageTextureCoordinates(vec3 gridPosition) {
  vec3 size = max(uGridSize, vec3(1.0));
  vec3 extent = max(uBoundsMax - uBoundsMin, vec3(1e-6));
  vec3 normalizedPosition = clamp((gridPosition - uBoundsMin) / extent, 0.0, 1.0);
  if (uGridSampleMode > 0.5) {
    // 后端 linspace 网格：bounds 对应首末采样点，映射到 texel center。
    vec3 sampleIndex = normalizedPosition * max(size - 1.0, vec3(0.0));
    return (sampleIndex + 0.5) / size;
  }
  // 本地网格：bounds 是体素盒外边界，采样点位于各 texel center。
  return normalizedPosition;
}

// —— 隧道洞身遮挡（自遮挡视线剔除，解析极省）——
// 洞身 = 沿局部 +z(隧道轴向)、自爆心起 uHoleLen 长的圆柱(半径 uHoleRadius)。
// 视线 dirn(相对爆心的单位方向)若在中途穿过洞身圆柱，则该处片元的直达波
// 被空腔临空面截断（只能绕射），乘遮挡衰减系数返回。
float holeOcclusion(vec3 p) {
  float Plen = length(p);
  if (Plen < 1e-3) return 1.0;
  vec3 dirn = p / Plen;
  float ax = dirn.z; // 局部 +z = 隧道轴向（爆心在掌子面/洞身起点）
  float sinT = sqrt(max(1.0 - ax * ax, 0.0));
  // 视线偏离轴向(朝洞外/几乎垂直轴向)不造成洞身截断
  if (ax <= 1e-4 || sinT < 1e-3) return 1.0;
  // 视线与洞身圆柱表面交于"横向=半径"处；仅当该交点落在洞身轴向段内才遮挡
  float ttHit = uHoleRadius / sinT;
  float aHit = ax * ttHit;
  if (aHit < 0.0 || aHit > uHoleLen) return 1.0;
  // 横截越彻底(视线越偏离轴越难绕射)遮挡越强。旧下限 0.35 会把拱顶/底板等
  // 环抱空腔的围岩直射波压得过低，导致纵截面上"上/下围岩应力偏低、呈漏斗形"。
  // 抬高下限到 0.72 并有侧向放大(略大于1)：● 环抱洞腔的拱顶/底板围岩经
  // 空腔临空面反射仍受强大压应力(不随直射被遮挡而塌陷)● 仅对真正被空腔
  // 长距离隔断的远区保留轻微指向性，避免退化回纯同心球。
  return mix(0.72, 1.06, 1.0 - smoothstep(0.0, 0.5, sinT));
}

// 轴向延展因子：传播方向越贴近隧道轴向(±z)能量衰减少、沿巷道传远；
// 越横向(倾向临空面/自由面)卸荷越快 → 球面波被拉成沿隧道延伸的椭球状。
float axialGain(vec3 dirn) {
  float ax = abs(dirn.z);
  return mix(uLateralAttn, 1.0, smoothstep(0.0, 0.55, ax));
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

  // PPV/应力模式在岩面上按解析场计算；DAMAGE 模式走唯一权威的分类纹理，
  // 因此此处不再为三种显示模式重复计算峰值分区。损伤纹理只在其已覆盖网格域内着色。
  vec3 accE = vec3(0.0);   // 各源波包同相(cos)分量矢量叠加
  vec3 accQ = vec3(0.0);   // 各源波包正交(sin)分量矢量叠加
  float wvCarrier = 6.2831853 * uCarrierHz;
  float wvEnvDecay = uCarrierHz > 0.5 ? 3.14159265 * uCarrierHz / WAVELET_Q : 0.0;
  if (uDisplayMode != 2) {
    if (uSourceCount < 1) {
      // 无装药源退化：单一 uBlastOrigin 源（总装药量），保持与原单源场一致
    vec3 srcRel = g - uBlastOrigin;
    float rr = max(length(srcRel), 0.5);
    vec3 dirS = srcRel / max(rr, 1e-3);
    float arrival = rr / max(uVisualCp, 1e-3);
    float gap = uSimTime - arrival;
    float peakS = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(rr, -uSadoskyAlpha) * 0.01;
    // 波包前缘在 uArrivalRise 秒内平滑升起；此解析分支仅用于 PPV/应力瞬时显示。
    float ampS = 0.0;
    float oscC = 1.0;
    float oscS = 0.0;
    if (gap > 0.0) {
      ampS = smoothstep(0.0, max(uArrivalRise, 1e-4), gap) * peakS * exp(-uDisplayDecay * gap);
      if (wvCarrier > 0.0) {
        float wv = exp(-wvEnvDecay * gap);
        oscC = cos(wvCarrier * gap) * wv;
        oscS = sin(wvCarrier * gap) * wv;
      }
    }
    accE = dirS * (ampS * oscC);
    accQ = dirS * (ampS * oscS);
    // 掌子面自由面反射（镜象源法）：岩体侧（g.z≥uFaceZ）计入镜像反射波。
    // 【负号镜像】自由面是压力释放边界：镜像贡献方向取"指向镜像点"（dirI 取负），
    // 面上法向振速与直达同向叠加而加倍；正号镜像对应刚性边界（面上归零）。
    if (uReflectOn > 0.5 && g.z >= uFaceZ) {
      float rz2 = 2.0 * uFaceZ - uBlastOrigin.z;
      vec3 imgRel = vec3(srcRel.x, srcRel.y, g.z - rz2);
      float rri = max(length(imgRel), 0.5);
      vec3 dirI = -imgRel / max(rri, 1e-3);
      float arrI = rri / max(uVisualCp, 1e-3);
      float gapI = uSimTime - arrI;
      float peakI = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(rri, -uSadoskyAlpha) * 0.01;
      if (gapI > 0.0) {
        float ampI = smoothstep(0.0, max(uArrivalRise, 1e-4), gapI) * peakI * exp(-uDisplayDecay * gapI);
        float oC = 1.0;
        float oS = 0.0;
        if (wvCarrier > 0.0) {
          float wvI = exp(-wvEnvDecay * gapI);
          oC = cos(wvCarrier * gapI) * wvI;
          oS = sin(wvCarrier * gapI) * wvI;
        }
        accE += dirI * (ampI * uReflectCoeff * oC);
        accQ += dirI * (ampI * uReflectCoeff * oS);
      }
    }
  } else {
    // 多装药源：各炮孔装药段按"径向单位向量 × 质点速度"矢量叠加，模长即 PPV。
    // sq.w 由 applyFieldPhysics 预计算为源强度系数 K·q^(α/3)·0.01，此处只剩幂律衰减。
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (i >= uSourceCount) break;
      vec4 sq = uSourcePosQ[i];
      vec3 srcRel = g - sq.xyz;
      float rr = max(length(srcRel), 0.5);
      vec3 dirS = srcRel / max(rr, 1e-3);
      float dS = uSourceDelay[i];
      float arrival = dS + rr / max(uVisualCp, 1e-3);
      float gap = uSimTime - arrival;
      float peakS = sq.w * pow(rr, -uSadoskyAlpha);
      float ampS = 0.0;
      float oscC = 1.0;
      float oscS = 0.0;
      if (gap > 0.0) {
        ampS = smoothstep(0.0, max(uArrivalRise, 1e-4), gap) * peakS * exp(-uDisplayDecay * gap);
        if (wvCarrier > 0.0) {
          float wvS = exp(-wvEnvDecay * gap);
          oscC = cos(wvCarrier * gap) * wvS;
          oscS = sin(wvCarrier * gap) * wvS;
        }
      }
      accE += dirS * (ampS * oscC);
      accQ += dirS * (ampS * oscS);
      // 掌子面自由面反射（镜象源法，负号镜像，见单源分支注释）
      if (uReflectOn > 0.5 && g.z >= uFaceZ && sq.z > uFaceZ) {
        float rz2 = 2.0 * uFaceZ - sq.z;
        vec3 imgRel = vec3(srcRel.x, srcRel.y, g.z - rz2);
        float rri = max(length(imgRel), 0.5);
        vec3 dirI = -imgRel / max(rri, 1e-3);
        float arrI = dS + rri / max(uVisualCp, 1e-3);
        float gapI = uSimTime - arrI;
        if (gapI > 0.0) {
          float peakI = sq.w * pow(rri, -uSadoskyAlpha);
          float ampI = smoothstep(0.0, max(uArrivalRise, 1e-4), gapI) * peakI * exp(-uDisplayDecay * gapI);
          float oCi = 1.0;
          float oSi = 0.0;
          if (wvCarrier > 0.0) {
            float wvI = exp(-wvEnvDecay * gapI);
            oCi = cos(wvCarrier * gapI) * wvI;
            oSi = sin(wvCarrier * gapI) * wvI;
          }
          accE += dirI * (ampI * uReflectCoeff * oCi);
          accQ += dirI * (ampI * uReflectCoeff * oSi);
        }
      }
    }
  }
  }
  // 瞬时质点速度幅值 = 波包正交双分量模长（行波脉冲包络，恒正平滑、无过零闪烁）
  float mps = sqrt(dot(accE, accE) + dot(accQ, accQ));
  // PPV/应力瞬时场的方向性衰减；DAMAGE 已由分类纹理给出，不对其再次缩放/重算。
  if (uDisplayMode != 2) {
    vec3 relSrc = g - uBlastOrigin;
    // 【洞身遮挡已禁用】圆柱切线投影会产生 X 形/斜向黑影伪影；保留轴向延展即可。
    float occ = 1.0;
    float agn = axialGain(normalize(relSrc + vec3(1e-5)));
    mps *= occ * agn;
  }

  vec3 fieldCol = vec3(0.0);
  float alpha = 0.0;

  // 低场值区直接取色带低端的深藏蓝（LUT 0 档，见 vibrationColorScales.js）：
  // 与 LS-DYNA/ANSYS 等专业软件的 rainbow 口径一致——远场大片深藏蓝、
  // 近场热点按值落位到暖色。旧实现曾用浅冷色"波前带"替代低端深色
  //（避免低值区堕成黑窟窿），已随 alpha=1 全量铺色方案废弃。
  if (uDisplayMode == 1) {
    // σ_vm 等效应力：σ = ρ·c_p·v/(1−ν)；绝对标度相对 uStressRefMPa，保留随距衰减
    float pa = max(mps, 1e-6) * uStressFactor;
    // 线性标尺（LS-DYNA 口径）：数据范围内线性均分，低值=色带低端（蓝）、高值=红；
    // uNormAutoScale 把当前范围映射进色域（见 uniform 注释）。
    float norm = clamp(((pa / 1.0e6) / max(uStressRefMPa, 1e-6)) * uNormAutoScale, 0.0, 1.0);
    fieldCol = texture(uStressLut, vec2(norm, 0.5)).rgb;
    // 【全量替换】alpha 恒 1：开启场图层后整个岩面由热力图色取代（低值区同样取色带
    // 低值），不再用透明度把岩体本色透出来——"低值区域显示模型原色/模型像半透明"
    // 的根因即旧实现把 alpha 压到 vis/arrived 下限、并把场色上限钳在 0.85。
    alpha = 1.0;
  } else if (uDisplayMode == 2) {
    // 损伤分区只渲染分类器产出的 DAMAGE texture；GPU 不再复制实现一套 PPV/分区算法。
    // 场盒外、首帧前及 -1(尚未到达/未分类)均不着色，不把 no-data 冒充弹性区。
    bool insideDamageBounds = all(greaterThanEqual(g, uBoundsMin)) &&
                              all(lessThanEqual(g, uBoundsMax));
    if (uDamageReady > 0.5 && insideDamageBounds) {
      float zone = texture(uDamageTexture, damageTextureCoordinates(g)).r;
      if (zone >= -0.5 && zone <= 4.5) {
        damageColor(floor(zone + 0.5), fieldCol, alpha);
      } else {
        fieldCol = vec3(0.0);
        alpha = 0.0;
      }
    } else {
      fieldCol = vec3(0.0);
      alpha = 0.0;
    }
  } else {
    // PPV 振动场：实时质点速度，绝对标度相对 uPpvRefMps，随距随实时衰减；
    // 线性标尺（同应力分支，LS-DYNA 口径）：低值=色带低端蓝，高值=红
    float iVal = clamp((mps / max(uPpvRefMps, 1e-4)) * uNormAutoScale, 0.0, 1.0);
    fieldCol = texture(uPpvLut, vec2(iVal, 0.5)).rgb;
    // 【全量替换】alpha 恒 1（同应力分支）：整面由热力图覆盖，无半透明透底
    alpha = 1.0;
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

  // 场色不透明度：1.0 → 岩面完全由热力图色覆盖（低值区即色带低值，绝无透底/半透明）
  float wv = clamp(w / max(uFieldWeight, 1e-4), 0.0, 1.0);

  bool damageMode = uDisplayMode == 2;
  vec3 fieldOut = fieldCol;
  if (!damageMode) {
    // 连续场色允许轻度增强/抖动；离散 DAMAGE 色必须保留色卡原值，确保图例可读。
    float lum = dot(fieldCol, vec3(0.299, 0.587, 0.114));
    fieldCol = mix(vec3(lum), fieldCol, 1.08);
    float noise =
      (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    fieldCol += noise;
    fieldOut = mix(fieldCol, vec3(0.97, 0.98, 1.0), 0.45 * step(0.5, uWhiteModel));

    // 连续场保留明暗与轮廓辅助；损伤档位则保持与 UI 色卡一致。
    float shade = 0.72 + 0.42 * mDiff;
    fieldOut *= shade;
    float rim = pow(1.0 - clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0), 3.0);
    fieldOut += vec3(0.85, 0.92, 1.0) * (rim * 0.5);
  }

  // 最终：场图层开启 → 岩面按热力图着色（wv=1 全覆盖，不透明）；
  // 关闭 → wv=0 → 输出带岩石纹理的原始观感。
  vec3 final = mix(bg, fieldOut, wv);

  // 裁剪剖面：沿世界平面（由岩体 CSG 切面求出）剪掉负半空间，露出内部剖面观察。
  // 用 uSectionNWorld/uSectionCWorld（世界空间）而非旧的 rel/uCenter 系，确保掌子面/
  // 漏斗/隧道壳等所有对象与岩体 CSG 切面严格共面，避免保留侧相反或错位。
  if (uSectionEnabled > 0.5) {
    if (dot(vWorldPos, uSectionNWorld) + uSectionCWorld < 0.0) discard;
  }

  fragColor = vec4(final, uGlobalOpacity);
}
