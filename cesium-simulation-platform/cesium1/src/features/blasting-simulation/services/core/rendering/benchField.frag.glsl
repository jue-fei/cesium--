precision highp float;
precision highp sampler3D;

uniform sampler2D uRockMap;            // 岩石纹理（底色）
uniform sampler2D uPpvLut;             // PPV 色阶 LUT
uniform sampler2D uStressLut;          // σ_vm 色阶 LUT
uniform sampler2D uDamageLut;          // 损伤五色 LUT（vibrationColorScales DAMAGE_ZONES 单源）

uniform vec3  uBoundsMin;              // 模拟网格盒边界下界（点选采样的坐标元信息）
uniform vec3  uBoundsMax;              // 模拟网格盒边界上界（不参与岩面着色）
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
uniform float uInfluenceRadius;        // 波场可达半径(m)：取"爆心→岩体几何顶点"的最远距离，
                                       // 波传播到该处即衰减殆尽（岩体外即无片元）；下方 env 生效
uniform float uInfluenceFade;          // 边界窄过渡带(m)：避免能量在边界处出现高频断崖
uniform float uDamageMaxRadius;        // P0-1 损伤区最大半径(m)，边缘平滑衰减到 0（非硬切）
uniform float uDamageFalloff;          // 损伤软边缘带宽(m)：距爆源 [max−falloff, max] 间等级线性归零
uniform float uFieldWeight;            // 场着色强度（0=纯岩色，1=完全覆盖）
uniform float uWhiteModel;             // 底材白模开关（1=岩体切白模底，0=保留岩石纹理）
uniform float uPpvRefMps;              // PPV 色阶参考（m/s）
uniform float uStressRefMPa;           // 应力色阶参考（MPa）
uniform float uChargeKg;               // 总装药量(kg)（外推用）
uniform float uSadoskyK;               // 萨道夫斯基场地常数 K（cm/s）
uniform float uSadoskyAlpha;           // 萨道夫斯基衰减指数 α
uniform float uSadoskyBeta;            // 介质阻尼 β
uniform float uPpvVisualBeta;          // PPV 可视化时变衰减（波峰回落实时速度）
// 波前起跳沿时长(s)：各源到达后幅值在 uArrivalRise 秒内平滑升起。
// 【为何需要】原来用 "gap≤0 取 0 / gap>0 取峰值" 的直角阶跃，每个源的到达曲线在
// 岩面上留下一条 1px 硬边界；多源（46~75 孔）叠加后满屏细线，且载波把源间相位差
// 放大——实测相邻像素色阶跳变最大 67.9 级（加 0.05s 上升沿后降到 5.1 级）。
// 真实波包前缘本就不是阶跃，这是模型缺陷而非渲染问题。只作用于瞬时场（显示用），
// 不改 peak 判据（损伤分区/等值线口径不变）。
uniform float uArrivalRise;
uniform float uCarrierHz;             // 干涉子波频率（视觉 Hz，0=关）：瞬时质点速度×waveletOsc，多孔延时干涉波纹
uniform int   uNormMode;              // 色彩映射标尺（0=线性，1=对数）：对数展开幂律衰减的动态范围
uniform float uNormAutoScale;         // 动态满量程（P99.9 收紧）：lin*=uNormAutoScale，使当前场实际分布铺满色域
                                      // 1=基准满刻度；<1 收紧（场值普遍过小时把低值展开避免"全蓝"）；JS 每帧经场景
                                      // setAutoFieldScale 由场体素 P99.9 分位数计算，快升慢降抑制闪烁
// 等值线已迁移到几何提取（contourExtractor 峰值场 Marching Squares + Line2 渲染组，
// 由 blastingManager 下发 polylines，见 setContourPolylines）：相位 fract 法在陡梯度区
// 欠采样产生摩尔纹断带、源附近碎成小闭环，且随瞬时场逐帧明灭——已整体移除。
uniform float uVisualCp;               // 可视化波前传播速度(m/s)
uniform float uSimTime;                // 当前模拟时间(s)
uniform float uStressFactor;           // ρ·c_p/(1−ν)，PPV→σ_vm(Pa)
uniform float uStressNfR;              // 应力近场几何修正交叉半径 r_nf(m)，0=关
uniform float uStressNfA;              // 应力近场几何修正增益 A：F(r)=1+A·(r_nf/r)²
// —— 工业风格渲染（工程标准视觉）——
uniform float uNormBands;              // 离散色阶数 N（12~16），热力图/等值线/图例同源
uniform float uZeroLift;               // 零场抬亮强度：把场值 0（未着色处/周期零点）抬离
                                       // 色阶最暗档（Jet 底≈纯黑），消除热力图整片死黑麻点
uniform float uIndustrialStyle;        // 1=工业风格（离散色阶/硬边/不透明/白模底）
// —— 掌子面自由面反射（镜象源法）：让隧道轮廓真正参与波场计算 ——
// 掌子面/临空面是自由面（应力为零），应力波入射近全反射（拉伸波）：自由面处
// 法向质点速度加倍、靠近轮廓处产生"扰动/局部放大/直达-反射干涉相消"。
// 对每个装药源沿 z=uFaceZ 面镜像同号虚拟源（幅值×uReflectCoeff），接收点仅在
// 岩体一侧（g.z ≥ uFaceZ）计入反射波。与 CPU computeMultiSource* 同口径。
uniform float uFaceZ;                  // 掌子面轴向位置(m，grid 局部系)
uniform float uReflectOn;              // 自由面反射开关（1=开）
uniform float uReflectCoeff;           // 反射系数（0~1，自由面近全反射取 0.85）
uniform float uFieldTranslucent;      // 半透明渲染（1=场色上限降到 0.55 露出岩底，0=0.85 实色）
// —— 隧道马蹄形轮廓自由面（SDF 反射放大）：让隧道壁真正参与波场 ——
// 直墙+拱顶轮廓是自由面（应力为零）：波在此发生反射，轮廓附近法向振速放大、出现
// 畸变/干涉（用户要求"波场必须在隧道壁处出现不连续或梯度剧变"）。用轮廓距离场
// SDF 近似：d→0 处乘 (1 + coeff·exp(-d/λ)) 放大，离开轮廓指数衰减。GPU 与 CPU
// （compute*Field 的 options.tunnelFace）同口径；coeff=0 关闭。
uniform float uTunnelFloorY;           // 底板平面 y（grid 局部系）
uniform float uTunnelArchH;            // 直墙高度 Hw（拱冠圆心位于 floorY+Hw）
uniform float uFaceBoostCoeff;         // 轮廓自由面放大系数（0=关，自由面近全反射取 0.6）
uniform float uFaceBoostLambda;        // 放大的空间衰减长度(m，默认 1.2)
uniform vec3  uRockColor;              // 岩石基础色
uniform vec3  uSunDir;                 // 方向光方向（世界空间，用于岩面明暗）
uniform float uGlobalOpacity;          // 全局透明度（1=不透明；隧道内壁等半透明面用）
uniform float uSectionEnabled;         // 剖面裁剪开关（1=启用）
uniform vec3  uSectionNWorld;          // 剖切平面法线（世界空间，与岩体 CSG 切面一致）
uniform float uSectionCWorld;          // 剖切平面常量（世界空间：dot(p,n)+c >= 0 一侧保留）
uniform float uSectionAxis;            // 裁剪轴（0=X 1=Y 2=Z，基于场景 rel 坐标）
uniform float uSectionPos;             // 裁剪平面位置（沿轴，场景相对 uCenter）
// 剖面裁剪：外部调用 setSectionPlane，用于爆破模式下观察岩体内部

// 多装药源（各炮孔装药段）萨道夫斯基矢量叠加：驱动岩面非同心圆干涉波场。
// 掏槽楔形孔在孔底汇拢、各源延时起爆，矢量叠加产生相长/相消干涉瓣（同 backend ppv_field_3d_multi）。
// 【全源修复】原 MAX_SOURCES=16 + slice(0,16) 会静默丢弃 43 孔设计中的 27 个源
// （只保留数组前 16 个 ≈ 掏槽+部分辅助孔），GPU 岩面场只剩总装药量的 ~45%、
// 且缺失后段延期（300~525ms）的波系 → 观感即"几个波的简单叠加"。
// 【扩容 96】48 上限曾把 002 南山 69 个装药孔按药量截断到 48，整段丢弃
// 415/418ms 周边光爆波系 → 中期波前过后场值走低、低值等值线贴到达门控阈值
// 被大面积切除（等值线断点主因，isoline-lab/verify-nanshan.mjs 数值复现）。
// 96 覆盖全部布孔（昆阳 43、南山 69 孔全量），与 CPU 全源口径一致。
// 存储打包：vec4(xyz=位置, w=药量) + float 延期数组 = 96+24=120 个 uniform 向量槽，
// 低于 WebGL2 片元 uniform 保底 224；若用 vec3/float/float 三数组则需 96+24+24=144 槽。
#define MAX_SOURCES 96
uniform int   uSourceCount;                 // 有效装药源数量（0=退化为单一 uBlastOrigin 源）
uniform vec4  uSourcePosQ[MAX_SOURCES];     // xyz=各源 grid 局部坐标(m)，w=源强度系数 K·q^(α/3)·0.01（applyFieldPhysics 预计算）
uniform float uSourceDelay[MAX_SOURCES];    // 各源延期(s)——【须按延时升序写入】时域错峰叠加峰值依赖延时序累加
uniform float uPeakHistory;                 // 峰值方法：1=时域错峰叠加（默认，杨年华 2012 时域叠加口径）
                                            //        0=全源同时叠加保守上界（Holmberg–Persson 类旧口径）

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vWorldNormal;
out vec4 fragColor;

// 损伤分区离散取色（zone 0~4）：查五色 LUT（uDamageLut，由
// vibrationColorScales.js DAMAGE_ZONES 单源生成，勿在此硬编码）。
void damageColor(float zone, out vec3 col, out float alpha) {
  col = texture(uDamageLut, vec2((zone + 0.5) / 5.0, 0.5)).rgb;
  alpha = 0.55 + zone * 0.10;
}

// 损伤模式统一着色：zone≥0.5 查 LUT（持久可见），zone 0 用中性波前色随波前淡出
void damageShade(float zone, float front, out vec3 col, out float alpha) {
  if (zone >= 0.5) {
    damageColor(zone, col, alpha);
    alpha = max(alpha, front * 0.85);
  } else {
    col = vec3(0.90, 0.86, 0.78); // 中性波前色，不暗示损伤分区
    alpha = front * 0.85;
  }
}

// 波动相位子波包络（视觉 Hz）：双分量 cos/sin 共用，按品质因数 Q=12 指数衰减
// （8Hz 时衰减率 π·8/12≈2.1/s，单源波环可见持时 ~1.4s、波列长 Q/f≈1.5s）——
// 行波脉冲环既要"分明"又要在 8s 时间轴上有足够可见持时（Q=4 时 0.5s 内即衰减殆尽，
// 播放中后段全场死蓝）。与 localVibrationSimulator.js 的工程口径 WAVELET_Q=4 不同：
// 该处用于 CPU 时程/采样曲线（production 不传 carrierHz），此处为 GPU 展示专属。
#define WAVELET_Q 12.0

// 场值零抬亮：把 0（未着色处 / 振荡过零点，归一化后可低至 NORM_FLOOR）抬到色阶
// 内部的分数 zl，消除 Jet 最暗档（≈纯黑）在色带与波前处留下的死黑麻点。
// 只抬极小值附近，按 smoothstep(zl, zl+0.08) 渐出 → 中高场值完全不受影响。
float liftZero(float x, float zl) {
  return mix(zl, x, smoothstep(zl, zl + 0.08, x));
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
  // 纯轴向（sinT→0）数学上视线不穿洞身侧壁 → 无遮挡
  if (sinT < 1e-3) return 1.0;
  // 视线与洞身圆柱表面交于"横向=半径"处；交点轴向位置 aHit
  float ttHit = uHoleRadius / sinT;
  float aHit = ax * ttHit;
  // 【连续化】原实现用 if(aHit∈[0,uHoleLen]) 做硬分支，遮挡系数在洞身圆柱
  // 投影边界处从 0.72~1.06 阶跃回 1.0 → 截图里出现沿洞壁投影的直线分界/楔形，
  // 热力图在交界处色带错位、观感不连续。这里全部改用 smoothstep 平滑过渡：
  //   · 轴向段内(aHit 落到洞身中段) → 进入遮挡；两端平滑回 1
  //   · 视线朝轴线后方(ax<0) 不遮挡，平滑切入
  //   · sinT 越大(越横穿洞腔) 遮挡越强
  // 遮挡幅值保留原范围 [0.72,1.06]，拱顶/底板围岩应力下限(0.72)不变。
  float inLen = 1.0 - smoothstep(uHoleLen - 0.6, uHoleLen + 0.6, aHit);
  float axialIn = smoothstep(-0.35, 0.35, ax);
  inLen = clamp(inLen * axialIn, 0.0, 1.0);
  float cross = smoothstep(0.02, 0.35, sinT);
  float occInside = mix(0.72, 1.06, 1.0 - cross);
  return mix(1.0, occInside, inLen);
}

// 轴向延展因子：传播方向越贴近隧道轴向(±z)能量衰减少、沿巷道传远；
// 越横向(倾向临空面/自由面)卸荷越快 → 球面波被拉成沿隧道延伸的椭球状。
float axialGain(vec3 dirn) {
  float ax = abs(dirn.z);
  return mix(uLateralAttn, 1.0, smoothstep(0.0, 0.55, ax));
}

// 隧道马蹄形轮廓到点 p（grid 局部系）的近似距离场。
// 简化马蹄：直墙区 x∈[-halfW, halfW]、y∈[floorY, floorY+Hw]，拱冠为圆心
// (0, floorY+Hw)、半径 halfW 的上半圆。轮廓 = 直墙面+底板线+拱线 的最近距离，
// 负值表示进入孔腔内部（该处通常无岩面片元，放大项自然失效）。
float tunnelFaceSdf(vec3 p) {
  float halfW = max(uHoleRadius, 0.5);
  float yFloor = uTunnelFloorY;
  float archC = yFloor + uTunnelArchH;
  // 直墙段（底板到拱冠）竖向区间，横向超半宽外为正
  float dx = abs(p.x) - halfW;
  float wall = max(dx, 0.0);
  // 竖直：底板下为正、拱冠以上为脱离直墙区
  float vlow = yFloor - p.y;
  float vhigh = p.y - archC;
  float wallV = max(wall, vhigh > 0.0 ? vhigh : vlow);
  // 拱圆最近距离（相对圆心幅角距离，径向偏移）
  float arc = length(vec2(abs(p.x), p.y - archC)) - halfW;
  return min(wallV, arc);
}

// 岩体表面为单一逐片元解析场（与后端同口径的多源矢量叠加），不再做"网格盒内
// 采样仿真纹理 / 盒外解析外推"双源混合——3D 场纹理现已无人消费：岩面着色改用
// 解析场（后端的色带本就由同一套萨道夫斯基+子波参数驱动），场点采样
// （sampleAtWorldPoint）由 CPU 解析采样承担。字段 uBoundsMin/Max 仅作点选元信息。

void main() {
  // 热力图开启时使用干净的低频底材：正面近距离视角下，程序化岩石纹理及其
  // 高频法线扰动会被投影成细密斜纹，并与场色叠加成看似摩尔纹的颗粒噪声。
  // 场值与损伤判据仍按下方解析公式计算，这里只清理显示底材。
  float fieldLayerOn = smoothstep(1e-4, 0.04, uFieldWeight);
  vec3 rockTexture = texture(uRockMap, vUv).rgb * uRockColor;
  vec3 rock = mix(rockTexture, uRockColor * 0.92, fieldLayerOn);
  vec3 baseRock = rock; // 场图层开启时保留稳定的低频底色，避免纹理高频穿透

  // 非热力图状态保留岩石纹理的 lambert 起伏；热力图状态使用平滑几何法线，
  // 避免第二次高频 uRockMap 采样通过明暗调制把彩色场切成细斑/斜带。
  vec3 N = normalize(vWorldNormal);
  if (fieldLayerOn < 0.999) {
    float hgt = dot(texture(uRockMap, vUv * 1.6).rgb, vec3(0.299, 0.587, 0.114));
    vec3 perturbed = normalize(N + vec3(hgt - 0.5, hgt - 0.5, (hgt - 0.5) * 0.25));
    float diff = clamp(dot(perturbed, normalize(uSunDir)), 0.0, 1.0);
    rock *= (0.42 + 0.72 * diff);
  } else {
    float diff = clamp(dot(N, normalize(uSunDir)), 0.0, 1.0);
    rock *= (0.58 + 0.45 * diff);
  }

  // 世界坐标 → grid 局部坐标（仅用于解析场，以爆源为心）
  vec3 rel = vWorldPos - uCenter;
  vec3 g;
  g.x = dot(rel, uRight);
  g.y = dot(rel, uUp);
  g.z = dot(rel, uForward);
  // Extrude/Shape 的掌子面盖板是多三角片平面。若沿用合并几何的逐顶点
  // 法线，盖板三角剖分会把白模 Lambert 明暗切成与三角片一致的斜纹。
  // 正面场图只需要统一的掌子面法线；岩体侧壁仍使用原始平滑法线。
  float facePlaneBlend = 1.0 - smoothstep(0.08, 0.60, abs(g.z - uFaceZ));
  // 爆破后 rockGeoPost 的新掌子面位于 faceZ + roundDepth；uHoleLen
  // 与该 roundDepth 同步下发，因此这里同时覆盖爆破后的端面。
  float postFaceBlend = 1.0 - smoothstep(0.08, 0.60, abs(g.z - (uFaceZ + uHoleLen)));
  facePlaneBlend = max(facePlaneBlend, postFaceBlend);
  // 不再依赖端面绝对 z：模型的可见"正面"可能是爆前盖板、爆后新掌子面，
  // 也可能因朝向/状态切换落到挤出体另一端。用片元位置导数重建真实几何法线，
  // 只要该平面法线与隧道轴向平行，就认作掌子面盖板。该判定不受顶点法线平滑、
  // 三角剖分或 faceOffset 坐标口径影响。
  vec3 geomN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  float capSurfaceMask = smoothstep(0.985, 0.9995, abs(dot(geomN, normalize(uForward))));
  facePlaneBlend = max(facePlaneBlend, capSurfaceMask);
  N = normalize(mix(N, normalize(uForward), facePlaneBlend));

  // 全场统一萨道夫斯基解析源（多装药源矢量叠加）：
  // 不再做"场盒包围盒"的 inside 门控，也去掉"盒内采样纹理 / 盒外解析外推"
  // 的双分支——整块岩体同一套物理曲线，根除矩形色块（包围盒面硬切岩体）
  // 与内外围接缝（两套色源在盒边界数值/透明度不齐）。
  // 多源模式（uSourceCount>0）：遍历各炮孔装药段，按"径向单位向量 × 质点速度"
  // 矢量叠加，模长即 PPV → 相长/相消干涉、非单一同心圆（同 backend ppv_field_3d_multi）。
  // 源数与本地/后端 WS 多源模拟保持一致；无源时退化为单一 uBlastOrigin 源（总装药量）。
  // 【瞬时振荡 → 双分量平方和】v = A·cos(ωt)·e^-βt 会周期性过零；逐片元取模长后，
  // 波峰波谷处落回色阶最暗档（Jet 底≈纯黑）→ 热力图上整片"死黑麻点"闪烁（用户实测）。
  // 物理上振速幅值以 √2·(v/√2) 的双分量表示时，|v|=A 恒正无零点，且保留了参数
  // （θ=ωt+相位）对干涉条纹的全部信息：cosθ 与 sinθ 由同一相位算出，多源相位差照旧
  // 产生相长/相消。故总场幅值改用"cos 分量² + sin 分量²"的平方和开方计算。
  // 【波动相位子波（已恢复）】瞬时质点速度 = 各源"波包子波"（余弦载波 × Q=12
  // 指数衰减包络）按"径向单位向量 × 幅值"的**正交双分量**矢量叠加：
  //   accE = Σ A·cos(2πf·gap)·e^(−πf·gap/Q)·û，accQ = Σ A·sin(...)·e^(...)
  //   mps = √(|accE|²+|accQ|²)（载波开启时的相干波包结果）
  // 每源贡献一个有限时长行波脉冲 → 波前环以 visualCp 逐帧外推、多孔延差+路径差
  // 直接转化为相位差 → 相长/相消干涉瓣可见；uCarrierHz=0 时改用标量非相干包络，
  // 不再把各源径向方向的相消误读成正面放射状纹路。
  vec3 accE = vec3(0.0);   // 各源波包同相(cos)分量矢量叠加
  vec3 accQ = vec3(0.0);   // 各源波包正交(sin)分量矢量叠加
  // 供屏幕空间 LOD 使用的非相干包络：只在载波欠采样时替代相干结果，
  // 避免近掌子面/掠射角下的相位条纹折叠成摩尔纹。它不参与 peak 判据。
  float envelopeSq = 0.0;
  float phaseFootprint = 0.0;
  vec3 totalPeak = vec3(0.0);
  // 时域错峰叠加峰值（uPeakHistory=1，默认）：B 按延时升序累加 A·e^(+D·arr)·û，
  // 每源到达时刻取候选 e^(−D·arr)·|B|——杨年华 2012 时域线性叠加预测口径，
  // 修正全源同时叠加（bound）对错峰波形的系统性高估（Blair 1993；李洪超 2026）。
  // 【口径注】精确解须按"逐点到达序"累加（arr=delay+r/c 随点变化）；此处逐片元
  // 无法排序，保持延时序累加的近似——路径时差远小于延期间隔时与精确解一致。
  vec3 peakB = vec3(0.0);
  float peakHist = 0.0;
  float pdk = uSadoskyBeta + uPpvVisualBeta; // 峰值时变衰减率（与瞬时场同口径）
  float wvCarrier = 6.2831853 * uCarrierHz;
  float wvEnvDecay = uCarrierHz > 0.5 ? 3.14159265 * uCarrierHz / WAVELET_Q : 0.0;
  float front = 0.0;
  if (uSourceCount < 1) {
    // 无装药源退化：单一 uBlastOrigin 源（总装药量），保持与原单源场一致
    vec3 srcRel = g - uBlastOrigin;
    float rr = max(length(srcRel), 0.5);
    vec3 dirS = srcRel / max(rr, 1e-3);
    float arrival = rr / max(uVisualCp, 1e-3);
    float gap = uSimTime - arrival;
    float gapFwidth = fwidth(gap);
    front = gap < 0.0 ? 0.0 : exp(-gap / 1.2);
    float peakS = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(rr, -uSadoskyAlpha) * 0.01;
    // 波包子波幅值：到达后按包络衰减 + 载波相位；uCarrierHz=0 → 退化为纯包络
    float ampS = 0.0;
    float oscC = 1.0;
    float oscS = 0.0;
    float waveEnvS = 0.0;
    if (gap > 0.0) {
      ampS = smoothstep(0.0, uArrivalRise, gap) * peakS * exp(-(uSadoskyBeta + uPpvVisualBeta) * gap);
      waveEnvS = ampS;
      if (wvCarrier > 0.0) {
        float wv = exp(-wvEnvDecay * gap);
        waveEnvS *= wv;
        oscC = cos(wvCarrier * gap) * wv;
        oscS = sin(wvCarrier * gap) * wv;
        phaseFootprint = max(phaseFootprint, wvCarrier * gapFwidth);
      }
    }
    envelopeSq += waveEnvS * waveEnvS;
    accE = dirS * (ampS * oscC);
    accQ = dirS * (ampS * oscS);
    if (uPeakHistory > 0.5) {
      peakB += dirS * (peakS * exp(min(pdk * arrival, 20.0)));
      peakHist = max(peakHist, exp(-pdk * arrival) * length(peakB));
    } else {
      totalPeak = dirS * peakS;
    }
    // 掌子面自由面反射（单源分支）：岩体侧（g.z≥uFaceZ）计入镜像反射波。
    // 【负号镜像】自由面为压力释放边界：镜像贡献方向取"指向镜像点"（dirI 取负），
    // 面上法向振速与直达同向叠加而加倍；正号镜像对应刚性边界（面上归零）。
    if (uReflectOn > 0.5 && g.z >= uFaceZ) {
      float rz2 = 2.0 * uFaceZ - uBlastOrigin.z;
      vec3 imgRel = vec3(srcRel.x, srcRel.y, g.z - rz2);
      float rri = max(length(imgRel), 0.5);
      vec3 dirI = -imgRel / max(rri, 1e-3);
      float arrI = rri / max(uVisualCp, 1e-3);
      float gapI = uSimTime - arrI;
      float gapIFwidth = fwidth(gapI);
      float peakI = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(rri, -uSadoskyAlpha) * 0.01;
      if (gapI > 0.0) {
        float ampI = smoothstep(0.0, uArrivalRise, gapI) * peakI * exp(-(uSadoskyBeta + uPpvVisualBeta) * gapI);
        float waveEnvI = ampI * uReflectCoeff;
        float oC = 1.0;
        float oS = 0.0;
        if (wvCarrier > 0.0) {
          float wvI = exp(-wvEnvDecay * gapI);
          waveEnvI *= wvI;
          oC = cos(wvCarrier * gapI) * wvI;
          oS = sin(wvCarrier * gapI) * wvI;
          phaseFootprint = max(phaseFootprint, wvCarrier * gapIFwidth);
        }
        envelopeSq += waveEnvI * waveEnvI;
        accE += dirI * (ampI * uReflectCoeff * oC);
        accQ += dirI * (ampI * uReflectCoeff * oS);
        if (uPeakHistory > 0.5) {
          peakB += dirI * (peakI * uReflectCoeff * exp(min(pdk * arrI, 20.0)));
          peakHist = max(peakHist, exp(-pdk * arrI) * length(peakB));
        } else {
          totalPeak += dirI * (peakI * uReflectCoeff);
        }
      }
    }
  } else {
    // 多装药源：各炮孔装药段按"径向单位向量 × 质点速度"矢量叠加，模长即 PPV。
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (i >= uSourceCount) break;
      vec4 sq = uSourcePosQ[i];
      vec3 srcRel = g - sq.xyz;
      float rr = max(length(srcRel), 0.5);
      vec3 dirS = srcRel / max(rr, 1e-3);
      float dS = uSourceDelay[i];
      float arrival = dS + rr / max(uVisualCp, 1e-3);
      float gap = uSimTime - arrival;
      float gapFwidth = fwidth(gap);
      float frontS = gap < 0.0 ? 0.0 : exp(-gap / 1.2);
      front = max(front, frontS);
      // sq.w 由 applyFieldPhysics 预计算为源强度系数 K·q^(α/3)·0.01（JS 侧一次算好，
      // 免去每片元 96 次幂运算）；此处只剩随距离的幂律衰减
      float peakS = sq.w * pow(rr, -uSadoskyAlpha);
      // 波包子波幅值（正交双分量）：多孔延差+路径差 → 相位差 → 干涉条纹
      float ampS = 0.0;
      float oscC = 1.0;
      float oscS = 0.0;
      float waveEnvS = 0.0;
      if (gap > 0.0) {
        ampS = smoothstep(0.0, uArrivalRise, gap) * peakS * exp(-(uSadoskyBeta + uPpvVisualBeta) * gap);
        waveEnvS = ampS;
        if (wvCarrier > 0.0) {
          float wvS = exp(-wvEnvDecay * gap);
          waveEnvS *= wvS;
          oscC = cos(wvCarrier * gap) * wvS;
          oscS = sin(wvCarrier * gap) * wvS;
          phaseFootprint = max(phaseFootprint, wvCarrier * gapFwidth);
        }
      }
      envelopeSq += waveEnvS * waveEnvS;
      accE += dirS * (ampS * oscC);
      accQ += dirS * (ampS * oscS);
      // 时域错峰叠加峰值：源已按延时升序写入 uniform（applyFieldPhysics），
      // 增量累加 B 并在该源到达时刻取候选——延时错开处峰值≈最强单源，
      // 齐发段退化为同相叠加（与 CPU 峰值场/损伤分区同口径）
      if (uPeakHistory > 0.5) {
        peakB += dirS * (peakS * exp(min(pdk * arrival, 20.0)));
        peakHist = max(peakHist, exp(-pdk * arrival) * length(peakB));
      } else {
        totalPeak += dirS * peakS;
      }
      // 掌子面自由面反射（镜象源法）：源在岩体侧、接收点也在岩体侧时，
      // 计入该源的镜像反射波——【负号镜像】（dirI 取负）：自由面为压力释放
      // 边界，面上法向振速与直达同向叠加而加倍；靠近掌子面出现局部放大与
      // 直达/反射干涉条纹，隧道轮廓不再是"贴图"。
      if (uReflectOn > 0.5 && g.z >= uFaceZ && sq.z > uFaceZ) {
        float rz2 = 2.0 * uFaceZ - sq.z;
        vec3 imgRel = vec3(srcRel.x, srcRel.y, g.z - rz2);
        float rri = max(length(imgRel), 0.5);
        vec3 dirI = -imgRel / max(rri, 1e-3);
        float arrI = dS + rri / max(uVisualCp, 1e-3);
        float gapI = uSimTime - arrI;
        float gapIFwidth = fwidth(gapI);
        if (gapI > 0.0) {
          float peakI = sq.w * pow(rri, -uSadoskyAlpha);
          float ampI = smoothstep(0.0, uArrivalRise, gapI) * peakI * exp(-(uSadoskyBeta + uPpvVisualBeta) * gapI);
          float waveEnvI = ampI * uReflectCoeff;
          float oCi = 1.0;
          float oSi = 0.0;
          if (wvCarrier > 0.0) {
            float wvI = exp(-wvEnvDecay * gapI);
            waveEnvI *= wvI;
            oCi = cos(wvCarrier * gapI) * wvI;
            oSi = sin(wvCarrier * gapI) * wvI;
            phaseFootprint = max(phaseFootprint, wvCarrier * gapIFwidth);
          }
          envelopeSq += waveEnvI * waveEnvI;
          accE += dirI * (ampI * uReflectCoeff * oCi);
          accQ += dirI * (ampI * uReflectCoeff * oSi);
          if (uPeakHistory > 0.5) {
            peakB += dirI * (peakI * uReflectCoeff * exp(min(pdk * arrI, 20.0)));
            peakHist = max(peakHist, exp(-pdk * arrI) * length(peakB));
          } else {
            totalPeak += dirI * (peakI * uReflectCoeff);
          }
        }
      }
    }
  }
  // 瞬时质点速度幅值 = 波包正交双分量模长（行波脉冲包络，恒正平滑、无过零闪烁）
  float mps = sqrt(dot(accE, accE) + dot(accQ, accQ));
  // 载波在一个片元覆盖范围内跨过太多相位时，直接取相干干涉结果会发生
  // undersampling：真实的细密相位瓣折叠成视角相关的摩尔纹。用到达时间的
  // 屏幕空间梯度估计相位覆盖量；仅对瞬时显示场做连续 LOD 混合，不改 peak。
  float envelope = sqrt(max(envelopeSq, 0.0));
  // 直接对最终载波相位再取一次导数，避免动态分支/多源 max 让某些 GPU
  // 漏掉前面逐源记录的梯度。相位覆盖量以弧度计，π 表示一个完整的
  // 欠采样危险区间。
  float carrierPhaseFootprint = wvCarrier > 0.0 ? fwidth(wvCarrier * (uSimTime - length(g - uBlastOrigin) / max(uVisualCp, 1e-3))) : 0.0;
  phaseFootprint = max(phaseFootprint, carrierPhaseFootprint);
  float coherentLod = smoothstep(0.35, 3.14159265, phaseFootprint);
  // 截图中的正面是近临空面/反射波叠加区。即使单像素相位导数尚未越过
  // Nyquist，直达-反射与多源方向矢量也会在掌子面三角片上形成密集颗粒。
  // 正面显示只保留非相干包络，避免把可见的物理场折叠成视角相关纹路；
  // peak/损伤判据仍使用下方独立的 peak。
  float faceCleanLod = 1.0 - smoothstep(0.10, 0.55, abs(g.z - uFaceZ));
  // 爆破后当前可见的是后退后的新掌子面；它不在 uFaceZ，而在
  // uFaceZ + uHoleLen。前一版只清理爆破前端面，所以截图在播放中段
  // 仍会出现从洞口向四角发散的矢量抵消纹。
  float postFaceCleanLod = 1.0 - smoothstep(0.10, 0.55, abs(g.z - (uFaceZ + uHoleLen)));
  faceCleanLod = max(faceCleanLod, postFaceCleanLod);
  coherentLod = max(coherentLod, faceCleanLod);
  // uCarrierHz=0 的语义是"纯包络"。此前虽然关闭了 cos/sin 载波，
  // 但 accE 仍按多源径向方向做矢量叠加，方向相消会在正面生成放射状
  // 暗纹；这不是包络，而是无载波的相干矢量场。默认/关闭载波时直接使用
  // 标量非相干包络，彻底消除该伪条纹，同时不改 peak 判据。
  mps = wvCarrier > 0.0 ? mix(mps, envelope, coherentLod) : envelope;
  // 掌子面盖板采用等效总装药单源的平滑标量包络。多孔逐源到达门控即使不带载波，
  // 仍会把 43~99 个延期波前叠成密集平行/放射纹；它们在正面大平面上属于显示混叠，
  // 而非需要读取的损伤判据。曲面/侧壁继续保留上面的完整多源场。
  float capDist = max(length(g - uBlastOrigin), 0.5);
  float capGap = uSimTime - capDist / max(uVisualCp, 1e-3);
  float capMps = 0.0;
  if (capGap > 0.0) {
    float capPeak = uSadoskyK * pow(uChargeKg, uSadoskyAlpha / 3.0) * pow(capDist, -uSadoskyAlpha) * 0.01;
    float capRise = max(uArrivalRise * 2.0, 0.40);
    capMps = smoothstep(0.0, capRise, capGap) * capPeak * exp(-pdk * capGap);
  }
  mps = mix(mps, capMps, capSurfaceMask);
  // peak = 损伤判据峰值：默认时域错峰叠加（杨年华 2012），可切回保守上界
  float peak = uPeakHistory > 0.5 ? peakHist : length(totalPeak);

  // 隧道马蹄形轮廓自由面（SDF 放大）：d→0（紧贴隧道壁）处反射叠加 → 法向振速放大，
  // 轮廓附近出现局部畸变/增强；离开轮廓指数衰减。coeff=0 关闭。
  // 【仅解析支】本地模拟纹理数据已含同款 boost（tunnelFaceBoostFactor），混合后
  // 再乘会双重放大；后端 WS 帧不含 boost——盒内以数据为准。故在混合前作用于解析值。
  if (uFaceBoostCoeff > 0.001) {
    float ds = tunnelFaceSdf(g);
    float boost = 1.0 + uFaceBoostCoeff * exp(-max(ds, 0.0) / max(uFaceBoostLambda, 0.05));
    mps *= boost;
    peak *= boost;
  }

  // 全套场（解析 + 反射 + 隧道面放大）在此完成。
  // 【勿再引入"盒内纹理 / 盒外解析"双源混合】后端/本地模拟网格盒只有
  // 19.5m×25m（build_ppv_grid 缺省），远小于岩体模型；两套色源在盒面数值无法
  // 逐点对齐，交叉淡化的过渡带会在岩面正中央显形为一个矩形接缝（用户实测
  // "热力图中间有矩形异形"）。解析场与后端同口径（同一 K/α/visualCp/子波/反射），
  // 故直接整场用解析场，几何上无接缝。

  // 洞身截断 + 轴向延展(破同心球)：以爆心为参照的视线遮挡与方向性衰减，
  // 对 PPV/应力/损伤三场统一生效——被隧道空腔隔断处强度衰减、横向临空面卸荷，
  // 使波场不再铺满整块岩体的纯同心球，而是沿围岩与巷道走向延伸的椭球状。
  vec3 relSrc = g - uBlastOrigin;
  // 【禁用洞身遮挡】holeOcclusion 用"爆心→片元视线与洞身圆柱求交"近似临空面
  // 截断，其圆柱轮廓切线在岩面上投影为一对直线 → 生成 X 形/斜向黑影伪影
  // （用户实测：应力图左下角斜向黑影、振速图 X 形伪影）。真实临空面效应应由
  // 自由面反射（uReflectOn）与隧道空腔掩码（后端 void_mask）承担，此处关闭。
  float occ = 1.0;
  float agn = axialGain(normalize(relSrc + vec3(1e-5)));
  mps *= occ * agn;
  peak *= occ * agn;

  // 计算域边界：波传播到"岩体几何边界"即归零消失——不反弹、不绕射、不回到场内
  // （一阶解析模型本来就不含反射/衍射）。uInfluenceRadius 由 _syncInfluenceRadius
  // 按"爆心→岩体包围盒最远顶点"实测下发（覆盖整块岩体、且落在几何外缘），
  // 故岩体表面不会出现"波在中间就被截断"的圆圈。
  float blastDist = length(relSrc);
  float env = 1.0 - smoothstep(uInfluenceRadius, uInfluenceRadius + uInfluenceFade, blastDist);
  mps *= env;
  peak *= env;

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
    // σ_vm 等效应力（瞬时场）：与振速同用瞬时波形 mps → 波前/梯度清晰可见。
    // 【不用峰值包络】改用 peak 会把应力场变成静态云图，丢失波前与时间结构
    // （用户实测："巨大的黄色高斯云，缺乏波场结构"）。
    // 近场几何修正 F(r)=1+A·(r_nf/r)²：F 的幅值取温和版（r_nf≈0.5m、A=2 → F(0.5)=3）。
    float nfk = uStressNfR / max(blastDist, 0.5);
    float nff = 1.0 + uStressNfA * nfk * nfk;
    float pa = max(mps, 1e-6) * uStressFactor * nff;
    float linS = clamp((pa / 1.0e6) / max(uStressRefMPa, 1e-6), 0.0, 1.0);
    // 动态满量程（P99.9 收紧）：lin*autoscale 使"当前帧场值 P99.9"映射到近满刻度，
    // 外围低应力从"深蓝"展开为青绿、中心高应力保持黄红，消除早期帧/窄量程的全蓝。
    linS = clamp(linS * uNormAutoScale, 0.0, 1.0);
    // 对数标尺（uNormMode=1）：floor=NORM_FLOOR·ref，动态范围 1/NORM_FLOOR。
    // 萨道夫斯基应力按 r^-α 幂律衰减：线性标尺下近源挤成饱和色、远场糊成深蓝，
    // 对数把两端展开成连续梯度；等值线分层（contourExtractor）用同一标尺反解级别
    // → 线与色档边界对齐。NORM_FLOOR 由 vibrationColorScales.js 单源注入。
    float norm = uNormMode > 0
      ? clamp(log2(max(linS, NORM_FLOOR) / NORM_FLOOR) / NORM_LOG_SPAN, 0.0, 1.0)
      : linS;
    // 零抬亮（防死黑）：场值 0 区（未着色处）与白底都会被 Jet 0 档涂成近纯黑。
    // 抬到色阶内部后白模上呈现"浅波前带"，不再有黑色麻点；中高场值不受影响。
    norm = liftZero(norm, uZeroLift);
    // 膝形压缩仅非工业风格启用：工业离散色阶要求"归一化值 ↔ 色阶边界"严格互逆
    // （等值线级别与图例区间都按同一公式反解），任何非线性映射都会让色档边界错位。
    float kneeS = mix(norm, 1.0 - pow(1.0 - norm, 1.35), smoothstep(KNEE_A, KNEE_B, norm));
    norm = mix(kneeS, norm, uIndustrialStyle);
    // 【连续色阶】基底热力图直接用连续 norm 采样 LUT（LinearFilter 在相邻档色间插值），
    // 不再做 floor(norm·N) 逐档硬切——那会把连续物理场切成硬色带边界，在屏幕上呈
    // "细线条"，背离 LS-DYNA 平滑包络观感。等值线由几何折线组(contourExtractor)独立绘制。
    float visSI = step(0.0005, norm);
    float visSS = uNormMode > 0 ? smoothstep(0.0, 0.20, norm) : smoothstep(0.02, 0.12, norm);
    float vis = mix(visSS, visSI, uIndustrialStyle);
    // 连续采样 256 texel 光滑渐变表（见 buildIndustrialLutGradient）：
    // 每级色对应约 1/256 归一化区间 → 屏幕色是连续梯度上的真实取样，无竖向条纹
    fieldCol = texture(uStressLut, vec2(norm, 0.5)).rgb;
    fieldCol = mix(waveBand, fieldCol, vis);
    // 等值线不再由本 shader 用 fwidth 屏幕空间法绘制（锯齿/开关失效根因）。
    // 改为几何折线：contourExtractor.js Marching Squares + B-Spline 平滑，
    // 渲染见 setContourPolylines 的 Line2 组，显隐由面板"等值线"开关控制。
    // 工业风格不做波前淡色补充（alpha=vis 硬边）；非工业保留淡波前带
    alpha = mix(max(vis, front * 0.16), vis, uIndustrialStyle);
  } else if (uDisplayMode == 2) {
    // 损伤分区：按"峰值 PPV"持久分区（离散五色，清晰分界），波前未到达处
    // front=0 → 不显示；不随时变衰减回落 → 动画后期不消失。
    // 阈值须与后端 DAMAGE_THRESHOLDS_CMPS / localVibrationSimulator 一致：
    // 20/50/100/200 cm/s（P0-1 提高后的近场损伤临界值）。
    float cmps = peak * 100.0;
    float zone = cmps < 20.0 ? 0.0 : cmps < 50.0 ? 1.0 : cmps < 100.0 ? 2.0 : cmps < 200.0 ? 3.0 : 4.0;
    // P0-1 损伤软边缘：距爆源在 [max−falloff, max] 间损伤等级平滑衰减到 0。
    // 旧实现 if(blastDist>uDamageMaxRadius) zone=0 是"一刀切"硬阶跃：损伤外沿
    // 出现生硬的环形断崖、配合像素化呈"矩形/锯齿框"。平滑后外沿渐变淡出。
    float dmgFade = 1.0 - smoothstep(uDamageMaxRadius - uDamageFalloff, uDamageMaxRadius, blastDist);
    zone *= dmgFade;
    damageShade(zone, front, fieldCol, alpha);
  } else {
    // PPV 振动场：实时质点速度，绝对标度相对 uPpvRefMps，随距随实时衰减；
    // 只在振动波已到达的面上着色，整块岩体不会预先常驻弱色→非"类球"整图
    float lin = clamp(mps / max(uPpvRefMps, 1e-4), 0.0, 1.0);
    // 动态满量程（同应力）：lin*autoscale 收紧到当前帧实际分布，波前/衰减梯度清晰
    lin = clamp(lin * uNormAutoScale, 0.0, 1.0);
    // 对数标尺（同应力模式）：适应 PPV 幂律衰减的动态范围展开
    float iVal = uNormMode > 0
      ? clamp(log2(max(lin, NORM_FLOOR) / NORM_FLOOR) / NORM_LOG_SPAN, 0.0, 1.0)
      : lin;
    // 零抬亮（防死黑）：未着色的 0 区在白模上会被 Jet 0 档涂成近纯黑，抬到色阶内部
    // → 与"白模底材"一致地呈浅波前带，消除整片死黑（同时保留低频波前淡带）。
    iVal = liftZero(iVal, uZeroLift);
    // 膝形压缩（同应力模式）：工业风格禁用（保证色阶边界严格互逆）
    float kneeP = mix(iVal, 1.0 - pow(1.0 - iVal, 1.35), smoothstep(KNEE_A, KNEE_B, iVal));
    iVal = mix(kneeP, iVal, uIndustrialStyle);
    // 【连续色阶】同应力模式：连续 iVal 采样 LUT，不做逐档硬切（避免色带边界细线条）
    float visPI = step(0.0005, iVal);
    float visPS = uNormMode > 0 ? smoothstep(0.0, 0.20, iVal) : smoothstep(0.02, 0.12, iVal);
    float vis = mix(visPS, visPI, uIndustrialStyle);
    // 同应力模式：连续采样 256 texel 光滑渐变表
    fieldCol = texture(uPpvLut, vec2(iVal, 0.5)).rgb;
    fieldCol = mix(waveBand, fieldCol, vis);
    // 等值线同应力：改由 Marching Squares 折线组绘制，开关控制显隐（见 setContourPolylines）
    alpha = mix(max(vis, front * 0.30), vis, uIndustrialStyle);
  }

  // 等值线（等力线）不再由本 shader 绘制：见头部注释——几何提取见
  // contourExtractor.js（峰值场 Marching Squares），渲染见 setContourPolylines
  // 的 Line2 渲染组（像素级线宽 + 波前 arrival 门控，随播放时钟逐段浮现）。

  // 不在最终场色上叠加屏幕空间哈希/抖动。
  // 该类 ±1 LSB 噪声在正面高饱和色块上会被放大成可见颗粒，不能作为摩尔纹修复。

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
  float fieldOn = fieldLayerOn;
  vec3 rockShown = rock + baseRock * (0.55 * fieldOn);
  // 场图层开启时对基面做兜底抬亮：掌子面法线背向阳光（面向隧道内部），若只靠
  // rock+baseRock 抬升仍会偏暗，加上光照变化后可能堕成近黑（切割面"黑色空洞"漏洞）。
  // 仅在基面本身偏暗时向一个可见的暖棕地板抬升，暗面被救起、亮面保留纹理明暗。
  vec3 warmFloor = vec3(0.48, 0.43, 0.37);
  float rockLum = dot(rockShown, vec3(0.299, 0.587, 0.114));
  float liftAmt = smoothstep(0.10, 0.30, rockLum); // 越暗→liftAmt越小→越贴地板
  rockShown = mix(rockShown, warmFloor, (1.0 - liftAmt) * 0.62 * fieldOn);
  // 【工业风格】白模不再被无条件强制：uWhiteModel 开关同时作用于经典与工业两支，
  // 关闭后保留岩石纹理底（热力色叠在岩色上），使"白模底材"开关真正可调。
  vec3 bgIndustrial = mix(rockShown, whiteModel, uWhiteModel * fieldOn);
  vec3 bgClassic = mix(rockShown, whiteModel, uWhiteModel * fieldOn);
  vec3 bg = mix(bgClassic, bgIndustrial, uIndustrialStyle * fieldOn);

  // 场色不透明度统一回 alpha 尺度（解除权重 0.62 对色彩的整体压低），
  // 白底上图例色保持完整饱和度；关闭场图层时 wv=0 自然回到岩石纹理观感。
  // 半透明渲染（uFieldTranslucent=1）：上限降到 0.55，让岩体轮廓/内壁透出来。
  // 【工业风格】强制完全不透明（上限 1.0）：场数据不与底图做透明混合
  float wvMaxClassic = uFieldTranslucent > 0.5 ? 0.55 : 0.85;
  float wvMax = mix(wvMaxClassic, 1.0, uIndustrialStyle);
  float wv = clamp(w / max(uFieldWeight, 1e-4), 0.0, wvMax);

  // 增强场色饱和度与对比度，使分级更醒目（中等强度，避免各色带硬边过强、呈"线条"感）
  // 【工业风格】取消：离散色阶本身要求颜色与图例色块完全一致，任何增强都会让
  // 屏幕色与图例对不上
  float lum = dot(fieldCol, vec3(0.299, 0.587, 0.114));
  fieldCol = mix(mix(vec3(lum), fieldCol, 1.08), fieldCol, uIndustrialStyle);

  // 场图层开启 → 白模上叠加场色（alpha 决定显隐/波前淡出）；
  // 关闭 → wv=0 → 输出带岩石纹理的原始观感。
  // （等值线的可见度由 Line2 渲染组独立管理，不再在此兜底。）
  // 掌子面热力图不再让低场值的底材透过：正面盖板/爆后新端面若保留
  // rockShown 的法线明暗，会把三角剖分重新显成规则斜纹。只提高正面场层
  // 不透明度，侧壁仍保持原有透明/底材显示策略。
  float wvFinal = max(wv, 0.98 * facePlaneBlend);
  vec3 final = mix(bg, fieldCol, wvFinal);

  // 去带条不再依赖屏幕空间抖动：Bayer/频散抖动会在色块交界产生"雪花/颗粒"噪点
  // （用户实测"8bit 抖动雪花屏"）。改由数据层高斯平滑（updateVibrationField /
  // updateStressField 的 3D 可分离卷积）磨掉粗网格阶梯，这里不再叠加任何确定性噪声。

  // 裁剪剖面：沿世界平面（由岩体 CSG 切面求出）剪掉负半空间，露出内部剖面观察。
  // 用 uSectionNWorld/uSectionCWorld（世界空间）而非旧的 rel/uCenter 系，确保掌子面/
  // 漏斗/隧道壳等所有对象与岩体 CSG 切面严格共面，避免保留侧相反或错位。
  if (uSectionEnabled > 0.5) {
    if (dot(vWorldPos, uSectionNWorld) + uSectionCWorld < 0.0) discard;
  }

  fragColor = vec4(final, uGlobalOpacity);
}
