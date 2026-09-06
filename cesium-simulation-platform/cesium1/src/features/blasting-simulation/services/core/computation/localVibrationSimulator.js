/**
 * 本地爆破振动场模拟器（萨道夫斯基经验公式 + 球面波传播 + 弹性应力反演 + 损伤分区）
 *
 * 用途：在后端 WebSocket 不可用时，提供本地模拟的振动传播过程，
 * 满足用户"自行模拟实时数据"的需求，保证动态热力图和粒子效果始终可用。
 *
 * 物理模型完全复刻后端 blast_physics.py：
 *   1. PPV 实时质点速度：萨道夫斯基经验公式 + 球面波前传播 + 时变回落
 *      v(r, t) = K·(Q^(1/3)/R)^α · exp(-(β+βv)·(t - R/c̄)) · H(t - R/c̄)
 *      （c̄=visualCp 可视化波速；βv=visualBeta 可视化时变衰减，见 computePpvField3d）
 *   2. 应力场反演（弹性球面波本构一阶近似）：
 *      σ_rr = ρ·c_p·v_r（径向压）, σ_θθ = (ν/(1−ν))·σ_rr（切向拉幅值）,
 *      σ_vm = σ_rr/(1−ν)（von Mises）
 *   3. 损伤分区（Persson 模型，基于"波峰几何峰值×波前到达门控"，单位 cm/s）：
 *      0 elastic  (<5)    → 弹性区，无损伤
 *      1 micro_crack (5~15) → 微裂纹萌生
 *      2 crack_growth (15~30) → 裂纹扩展
 *      3 fracture (30~50) → 岩体破碎
 *      4 throw (≥50) → 抛掷爆腔
 *
 * 坐标系：与 threeBlastingRenderer 一致，采用隧道局部坐标系（局部 ENU 原点）。
 * 默认 blastCenter = [0,0,0]（网格原点）；可通过 options.origin 指定爆心为任意点
 * （如掏槽孔组质心，位于掌子面 [x, y, faceOffset]），使应力波/损伤从实际爆破位置出发。
 * 网格轴序：输出按 WebGL Data3DTexture 要求（x-最快，z-最慢），保证纹理采样正确。
 */

// 损伤分区阈值（Persson 模型，近场损伤临界值，单位：cm/s）
// 与后端 DAMAGE_THRESHOLDS_CMPS 完全一致
const DAMAGE_THRESHOLDS_CMPS = [5.0, 15.0, 30.0, 50.0]

/**
 * 生成 3D 网格坐标（X, Y, Z），覆盖隧道断面范围沿轴向扩展
 * @param {number} tunnelWidth - 隧道宽度(m)，横向(X)范围 [-w/2, w/2]
 * @param {number} tunnelHeight - 隧道总高度(m)，竖向(Y)范围 [-h/2, h/2]
 * @param {number} lengthZ - 沿隧道轴向(Z)长度(m)，范围 [0, lengthZ]
 * @param {number} nx - X 方向网格数
 * @param {number} ny - Y 方向网格数
 * @param {number} nz - Z 方向网格数
 * @param {Object} [explicitBounds] - 显式边界覆盖 { boundsMin: [x,y,z], boundsMax: [x,y,z] }，
 *                用于与后端 WS 网格完全对齐（后端 y 边界非对称：[-0.2h, 1.2h]）
 * @returns {Object} { gridXyz: Float32Array(n*3), gridShape: [nx,ny,nz], boundsMin: [xmin,ymin,zmin], boundsMax: [xmax,ymax,zmax] }
 */
export function buildPpvGrid(
  tunnelWidth,
  tunnelHeight,
  lengthZ = 40,
  nx = 32,
  ny = 32,
  nz = 64,
  explicitBounds = null
) {
  let xMin = -tunnelWidth / 2
  let xMax = tunnelWidth / 2
  let yMin = -tunnelHeight / 2
  let yMax = tunnelHeight / 2
  let zMin = 0
  let zMax = lengthZ
  if (explicitBounds?.boundsMin && explicitBounds?.boundsMax) {
    xMin = explicitBounds.boundsMin[0]
    yMin = explicitBounds.boundsMin[1]
    zMin = explicitBounds.boundsMin[2]
    xMax = explicitBounds.boundsMax[0]
    yMax = explicitBounds.boundsMax[1]
    zMax = explicitBounds.boundsMax[2]
  }

  const gridShape = [nx, ny, nz]
  const nTotal = nx * ny * nz
  const gridXyz = new Float32Array(nTotal * 3)

  let idx = 0
  for (let zi = 0; zi < nz; zi++) {
    const z = zMin + ((zMax - zMin) * (zi + 0.5)) / nz
    for (let yi = 0; yi < ny; yi++) {
      const y = yMin + ((yMax - yMin) * (yi + 0.5)) / ny
      for (let xi = 0; xi < nx; xi++) {
        const x = xMin + ((xMax - xMin) * (xi + 0.5)) / nx
        gridXyz[idx * 3 + 0] = x
        gridXyz[idx * 3 + 1] = y
        gridXyz[idx * 3 + 2] = z
        idx++
      }
    }
  }

  return {
    gridXyz,
    gridShape,
    boundsMin: [xMin, yMin, zMin],
    boundsMax: [xMax, yMax, zMax]
  }
}

/**
 * 萨道夫斯基经验公式计算 PPV（质点峰值速度，单位 m/s）
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} distance - 采样点到爆心距离(m)
 * @param {Object} options - { K: 场地常数, alpha: 衰减指数, minStandoff: 最小距离下限 }
 * @returns {number} PPV (m/s)
 */
export function sadoskyPpv(chargeKg, distance, options = {}) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const r = Math.max(distance, minStandoff)
  // K 单位为 cm/s → 转换为 m/s 需要 ×0.01
  return K * Math.pow(chargeKg ** (1 / 3) / r, alpha) * 0.01
}

/**
 * 计算指定时刻的 3D PPV 场
 * @param {Float32Array} gridXyz - 网格坐标数组 [x0,y0,z0, x1,y1,z1, ...]
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - 岩体介质参数
 * @param {number} [options.K=200] - 萨道夫斯基场地常数
 * @param {number} [options.alpha=1.5] - 萨道夫斯基衰减指数
 * @param {number} [options.beta=0.02] - 介质阻尼系数（物理）
 * @param {number} [options.visualBeta=0.8] - 可视化时变衰减（1/s，非物理阻尼）：
 *                仅用于展示"实时质点速度"的波峰回落过程——波前扫过后速度按该常数
 *                指数衰减，使动画呈现"到达→峰值→回落"的瞬时演化，而非全场恒为峰值色
 * @param {number} [options.cp=4500] - 纵波速度(m/s)
 * @param {number} [options.minStandoff=0.5] - 最小距离下限
 * @param {number[]} [options.origin] - 爆心在网格局部坐标系中的坐标 [x,y,z]，缺省 [0,0,0]
 * @returns {Float32Array} PPV 数组，长度 = gridXyz.length / 3，单位 m/s
 */
export function computePpvField3d(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const cp = options.cp ?? 4500.0
  const visualCp = options.visualCp ?? cp
  const minStandoff = options.minStandoff ?? 0.5
  const origin = options.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0

  const nPoints = gridXyz.length / 3
  const ppv = out ?? new Float32Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    // 爆心在局部坐标 (ox,oy,oz)（缺省为原点），即掏槽孔爆破位置
    const dx = x - ox
    const dy = y - oy
    const dz = z - oz
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const arrival = r / visualCp // 波前到达时间（可视化速度）
    if (t < arrival) {
      ppv[i] = 0 // 波前未到达
      continue
    }
    // 实时质点速度 = 萨道夫斯基峰值 × 指数时间衰减（物理 β + 可视化回落 visualBeta）
    const peak = sadoskyPpv(chargeKg, r, { K, alpha, minStandoff })
    ppv[i] = peak * Math.exp(-(beta + visualBeta) * (t - arrival))
  }

  return ppv
}

/**
 * 由单孔几何推算单个装药源的位置（装药源坐标，爆破应力波由此孔出发）
 *
 * 坐标系与平台一致：x=掌子面内横向（左右）、y=掌子面内竖向、z=掌子面轴向（进入岩体为正）。
 * 掌子面位于 z=faceOffset；collar 位于 (posX, posY, faceOffset)。
 *
 * 装药沿炮孔布置、偏孔底（底部起爆）。装药源中心取装药段中点：
 *   - 已知 chargeLength（装药段长）时，源距孔口 = depth − chargeLength/2；
 *   - 缺省时按"底部 60%"经验（cd = 0.6·depth）。
 *
 * 两类布孔方向：
 *   1. 楔形/倾斜掏槽孔（cut，inclination>0）：孔口分列掏槽核心两侧、孔底向核心收敛
 *      —— 这是楔形掏槽"多应力波叠加增强"的几何本源。横向收敛量 lat=depth·sinθ、
 *      轴向进尺 axial=depth·cosθ，方向由孔口指向掏槽孔组质心 (center.x, center.y)。
 *      故各掏槽孔装药源在孔底汇拢，应力波在该区域重叠干涉，不再呈单一同心圆。
 *   2. 直孔/辅助/周边孔（inclination≈0）：沿孔轴向内，位移由 inclination/azimuth
 *      按 sceneBuilder._buildHoleMeshes 的 Euler XYZ 旋转约定计算，与绘制炮孔对齐。
 *
 * @param {Object} h - 炮孔数据 { posX, posY, depth, chargeLength, inclinationAngle/azimuth,
 *                       holeType/type, chargeKg, delayMs, isEmptyHole, id }
 * @param {number} faceOffset - 掌子面轴向位置(m)
 * @param {Object} center - 掏槽孔质心 { x, y }（用于楔形孔向内收敛）
 * @returns {{x:number,y:number,z:number,chargeKg:number,delayMs:number,id?:*} | null}
 *          空孔或未装药孔返回 null（不参与应力波源）
 */
export function resolveChargePosition(h, faceOffset, center) {
  const q = Number(h.chargeKg)
  if (!(q > 0) || !!h.isEmptyHole) return null

  const type = String(h?.holeType || h?.type || 'production').toLowerCase()
  const isCut = type === 'cut' || type === 'easing'
  const depth = Math.max(0.2, Number(h.depth) || 2.5)
  const cxl = Number(h.chargeLength)
  const cd = Number.isFinite(cxl) && cxl > 0 ? Math.max(0.2, depth - cxl * 0.5) : depth * 0.6
  const inc = Math.max(0, Number(h.inclinationAngle ?? h.inclination) || 0) * (Math.PI / 180)

  const collarX = Number(h.posX) || 0
  const collarY =
    Number.isFinite(Number(h.posY)) && Number(h.posY) !== 0 ? Number(h.posY) : center.y
  const collarZ = faceOffset

  if (isCut && inc > 0.02) {
    // 楔形掏槽：孔底向掏槽核心收敛（核心 = 掏槽孔质心）
    const dvx = (center.x || 0) - collarX
    const dvy = (center.y || 0) - collarY
    const dl = Math.hypot(dvx, dvy) || 1
    const lat = depth * Math.sin(inc)
    const axial = depth * Math.cos(inc)
    return {
      x: collarX + (dvx / dl) * lat,
      y: collarY + (dvy / dl) * lat,
      z: collarZ + axial,
      chargeKg: q,
      delayMs: Number(h.delayMs) || 0,
      id: h.id
    }
  }

  // 直孔/辅助/周边：按绘制炮孔的 Euler XYZ 旋转约定计算孔内偏移
  const azi = (Number(h.inclinationAzimuth ?? h.azimuth) || 0) * (Math.PI / 180)
  const rx = -Math.sin(azi) * inc
  const ry = Math.cos(azi) * inc
  return {
    x: collarX - cd * Math.cos(rx) * Math.sin(ry),
    y: collarY - cd * Math.sin(rx),
    z: collarZ + cd * Math.cos(rx) * Math.cos(ry),
    chargeKg: q,
    delayMs: Number(h.delayMs) || 0,
    id: h.id
  }
}

/**
 * 从炮孔列表构建多应力波源（用于本地多源叠加模拟）
 * @param {Array} holes - 炮孔数据列表
 * @param {number} faceOffset - 掌子面轴向位置(m)
 * @param {Object} cutCenter - 掏槽孔质心 { x, y }（楔形孔向内收敛的基准）
 * @returns {Array} 装药源列表 [{x,y,z,chargeKg,delayMs,id}]；无有效源时返回空数组
 */
export function buildChargeSources(holes, faceOffset, cutCenter) {
  if (!Array.isArray(holes) || holes.length === 0) return []
  const center = cutCenter || { x: 0, y: 0 }
  const sources = []
  for (const h of holes) {
    const s = resolveChargePosition(h, faceOffset, center)
    if (s) sources.push(s)
  }
  return sources
}

/**
 * 计算指定时刻的 3D PPV 场 —— 多装药源矢量叠加（波场干涉，非单一同心圆）
 *
 * 物理模型：N 个装药源（对应掏槽/辅助/周边各炮孔的装药段）在不同位置、按各自
 * delayMs 时序依次起爆。每个源发出一个球面波：
 *
 *   v_s(t) = K·(q_s^(1/3)/r_s)^α · exp(−(β+βv)·(t − delay_s − r_s/c̄)) · H(t − delay_s − r_s/c̄)
 *
 * 各源的瞬时质点速度是**矢量**：方向沿各自径向单位向量 u_s = (p − src_s)/r_s。
 * 某点的总瞬时质点速度 = 各源波场矢量和：v(p,t) = Σ_s v_s(t)·u_s，
 * 其模长 |v| 即为 PPV。由于各源位置分离、起爆时序错开，矢量和会产生
 * 相长/相消干涉：掏槽孔在孔底汇拢处源间距离小时相长（核心高应力增强），
 * 源间距离大或相位错开处出现干涉瓣——正是"多应力波叠加"的真实波场形态，
 * 不再是一个药包中心的单一同心圆。σ_vm 由该 PPV 线性反演（computeStressFieldFromPpv），
 * 故应力场同样呈现非同心、多源干涉的斑块结构。
 *
 * 空源（无装药孔）时退化为单源（源在 options.origin，缺省网格原点），
 * 与 computePpvField3d 行为一致，保证向后兼容。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} t - 模拟时间(s)
 * @param {Object} options - { K, alpha, beta, visualBeta, cp, visualCp, minStandoff,
 *                            sources: [{x,y,z,chargeKg,delayMs}], origin }
 * @param {Float32Array} [out] - 复用输出缓冲区
 * @returns {Float32Array} PPV 数组（m/s）
 */
export function computeMultiSourcePpvField3d(gridXyz, t, options = {}, out = null) {
  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0)
    return computePpvField3d(gridXyz, options.chargeKg ?? 100, t, options, out)

  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const visualCp = options.visualCp ?? options.cp ?? 4500.0
  const minStandoff = options.minStandoff ?? 0.5

  const src = sources.map(s => ({
    x: Number(s.x) || 0,
    y: Number(s.y) || 0,
    z: Number(s.z) || 0,
    chargeKg: Number(s.chargeKg),
    delay: (Number(s.delayMs) || 0) / 1000
  }))

  const nPoints = gridXyz.length / 3
  const ppv = out ?? new Float32Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    let vx = 0
    let vy = 0
    let vz = 0
    for (let s = 0; s < src.length; s++) {
      const srcS = src[s]
      const dx = x - srcS.x
      const dy = y - srcS.y
      const dz = z - srcS.z
      const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
      const arrival = srcS.delay + r / visualCp
      if (t < arrival) continue // 该源波前未到达
      const peak = sadoskyPpv(srcS.chargeKg, r, { K, alpha, minStandoff })
      const a = peak * Math.exp(-(beta + visualBeta) * (t - arrival))
      const inv = 1 / Math.max(r, 1e-6)
      vx += a * dx * inv
      vy += a * dy * inv
      vz += a * dz * inv
    }
    ppv[i] = Math.sqrt(vx * vx + vy * vy + vz * vz)
  }
  return ppv
}

/**
 * 由 PPV 场反演 von Mises 等效应力场（弹性球面波一阶近似）
 * @param {Float32Array} ppv - PPV 场数组 (m/s)
 * @param {Object} options - 岩体参数
 * @param {number} [options.rho=2650] - 岩体密度(kg/m³)
 * @param {number} [options.cp=4500] - 纵波速度(m/s)
 * @param {number} [options.nu=0.25] - 泊松比
 * @returns {Float32Array} σ_vm 等效应力场，单位 Pa
 *
 * 爆破应力波在岩体中产生两种破坏性应力（岩体爆破破坏/生成裂隙的机制）：
 *   - 径向压应力 σ_rr = ρ·c_p·v_r（加载相，波阻抗关系）
 *   - 切向拉应力 σ_θθ = ν/(1−ν)·σ_rr（切向受拉，方向与径向相反；σ_θθ≥σ_t
 *     抗拉强度处产生径向裂隙，是爆破成缝的主因）
 * von Mises：σ_1=σ_rr（压）、σ_2=σ_3=−σ_θθ（拉）→ σ_vm = σ_rr/(1−ν)
 * 与后端 blast_physics.py::stress_field_from_ppv 完全一致。
 *
 * 适用范围与局限（弹性假设标注）：
 *   - 弹性一阶近似，仅适用于中远场（r > 5R_charge，R_charge 为药包半径）；
 *   - 近场（爆腔附近）存在塑性变形与卸载拉应力，弹性预测偏低，
 *     需配合损伤分区（classifyDamageZones）修正理解。
 *
 * 理论依据：
 *   - Hwang & Mohanty, Int. J. Rock Mech. Min. Sci., 2005（球面波应力-速度关系）
 *   - 罗章喜, 爆炸与冲击 1982, 3:34-40（冲击波使岩石切向受拉）
 *   - Wang X. et al., Processes 2023, 11(9):2805（σ_θ = −b·σ_r, b = ν/(1−ν)）
 *   - 梁瑞等, 高压物理学报 2022, 36(6):064202（裂隙区径向压力+切向拉力，Mises 判据）
 */
export function computeStressFieldFromPpv(ppv, options = {}, out = null) {
  const rho = options.rho ?? 2650.0
  const cp = options.cp ?? 4500.0
  const nu = options.nu ?? 0.25

  const nPoints = ppv.length
  const sigmaVm = out ?? new Float32Array(nPoints)

  // σ_vm = ρ·c_p·v / (1−ν)——径向压 + 切向拉（幅值 ν/(1−ν)·σ_rr）的等效应力。
  // 相比旧的弹性一维应变式 σ_vm=σ_rr·(1−2ν)/(1−ν)，本式体现了爆破破坏由
  // 切向拉应力主导的力学机制，数值更贴近实测应力幅值。
  const vmFactor = 1.0 / (1.0 - nu)

  for (let i = 0; i < nPoints; i++) {
    const ppv_i = ppv[i]
    sigmaVm[i] = rho * cp * ppv_i * vmFactor
  }

  return sigmaVm
}

/**
 * PPV 场分类为损伤分区（Persson 模型）
 * @param {Float32Array} ppv - PPV 场数组 (m/s)
 * @param {number[]} [thresholds] - 阈值数组 (cm/s)，默认 DAMAGE_THRESHOLDS_CMPS
 * @returns {Int8Array} 分区 id 数组：0~4，对应 elastic → throw
 */
export function classifyDamageZones(ppv, thresholds = DAMAGE_THRESHOLDS_CMPS, out = null) {
  const nPoints = ppv.length
  const zones = out ?? new Int8Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const ppvCmps = ppv[i] * 100.0 // m/s → cm/s
    let zone = 0
    for (let t = 0; t < thresholds.length; t++) {
      if (ppvCmps >= thresholds[t]) {
        zone = t + 1
      }
    }
    // 上限：≥last 阈值 → zone = len(thresholds) = 4，共 0~4 五级
    zones[i] = zone
  }

  return zones
}

/**
 * 按"该点波峰几何峰值 × 波前到达门控"计算损伤分区（与播放方向无关的确定性算法）
 *
 * 损伤是每个点经历过的最大 PPV 的不可逆判据。对时变衰减场 v(t)=peak·e^(−D(t−arrival))
 * （单调递减），"经历过的峰值"到任意时刻 t（t≥arrival）都等于 full peak（到达时刻的值），
 * 故分区 = digitize(峰值 cm/s)，仅以 波前是否到达（t ≥ r/c̄）作门控（未到达处 0）。
 *
 * 相比"逐帧峰值累积"，本式是纯确定的：同一时刻 (r,t) 无论正放、回拉、拖进度条都得到
 * 相同结果，修复"回拉进度条时损伤模式时序错乱"；且与场盒外解析分支（mpsPeak）语义一致。
 *
 * @param {Float32Array} gridXyz - 网格坐标数组 (N×3)
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, origin }（与 computePpvField3d 一致）
 * @param {Int8Array} [out] - 复用输出缓冲区
 * @returns {Int8Array} 分区 id 数组 0~4
 */
export function computePeakDamageZones(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  const origin = options.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0

  const nPoints = gridXyz.length / 3
  const zones = out ?? new Int8Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    const dx = x - ox
    const dy = y - oy
    const dz = z - oz
    const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
    // 波前未到达：无损伤（0=elastic）
    if (t < r / visualCp) {
      zones[i] = 0
      continue
    }
    // 峰值 PPV（无时变衰减）→ cm/s → Persson 档位
    const cm = sadoskyPpv(chargeKg, r, { K, alpha, minStandoff }) * 100.0
    let zone = 0
    for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
      if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
    }
    zones[i] = zone
  }

  return zones
}

/**
 * 多源模式损伤分区（基于各源"几何峰值矢量叠加"，波前到达门控，确定性算法）
 *
 * 与单源 computePeakDamageZones 同语义：损伤是不可逆的峰值判据（无时间衰减）。
 * 对多源，该点的损伤强度取 N 个源各自峰值 PPV 的**矢量叠加**模长（峰值同向时相长、
 * 异向时相消，反映布孔几何），并仅以"任意源波前是否到达（t ≥ min_s(delay_s + r_s/c̄)）"
 * 作门控——未到达处 0（弹性）。结果随 (t, 源几何) 确定，正放/回拉/拖进度条一致。
 *
 * 空源时退化为单源（= computePeakDamageZones），向后兼容。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, sources }
 * @param {Int8Array} [out] - 复用输出缓冲区
 * @returns {Int8Array} 分区 id 数组 0~4
 */
export function computeMultiSourcePeakDamageZones(gridXyz, t, options = {}, out = null) {
  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0) {
    return computePeakDamageZones(gridXyz, options.chargeKg ?? 100, t, options, out)
  }

  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0

  const src = sources.map(s => ({
    x: Number(s.x) || 0,
    y: Number(s.y) || 0,
    z: Number(s.z) || 0,
    chargeKg: Number(s.chargeKg),
    delay: (Number(s.delayMs) || 0) / 1000
  }))

  const nPoints = gridXyz.length / 3
  const zones = out ?? new Int8Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    let sxv = 0
    let syv = 0
    let szv = 0
    let reached = false
    for (let s = 0; s < src.length; s++) {
      const srcS = src[s]
      const dx = x - srcS.x
      const dy = y - srcS.y
      const dz = z - srcS.z
      const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
      if (t >= srcS.delay + r / visualCp) reached = true
      const peak = sadoskyPpv(srcS.chargeKg, r, { K, alpha, minStandoff })
      const inv = 1 / Math.max(r, 1e-6)
      sxv += peak * dx * inv
      syv += peak * dy * inv
      szv += peak * dz * inv
    }
    if (!reached) {
      zones[i] = 0
      continue
    }
    const cm = Math.sqrt(sxv * sxv + syv * syv + szv * szv) * 100.0
    let zone = 0
    for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
      if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
    }
    zones[i] = zone
  }
  return zones
}

/**
 * 将 3D 场从 (nx, ny, nz) 原始顺序（numpy indexing='ij'）转换为 WebGL Data3DTexture 要求的 x-最快顺序
 * @param {Float32Array} field - 一维展平场，原始顺序 nx×ny×nz（x-最慢，z-最快）
 * @param {number[]} gridShape - [nx, ny, nz]
 * @returns {Float32Array} 转换后场 (nz × ny × nx)，x 在内存中连续最快，与后端 _webgl_flatten_3d 完全一致
 */
export function reorderForWebGL(field, gridShape) {
  const [nx, ny, nz] = gridShape
  const output = new Float32Array(nx * ny * nz)

  // 原始：field[x*ny*nz + y*nz + z] → (nx, ny, nz)
  // WebGL 需要：output[z*ny*nx + y*nx + x] → (nz, ny, nx)，即转置 (2, 1, 0)
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        const srcIdx = x * ny * nz + y * nz + z
        const dstIdx = z * ny * nx + y * nx + x
        output[dstIdx] = field[srcIdx]
      }
    }
  }

  return output
}

/**
 * 本地振动模拟器类，管理网格、逐帧更新、数据推送
 */
export class LocalVibrationSimulator {
  /**
   * @param {Object} options - 模拟参数
   * @param {number} options.chargeKg - 总装药量(kg)
   * @param {number} options.tunnelWidth - 隧道宽度(m)
   * @param {number} options.tunnelHeight - 隧道总高度(m)
   * @param {number} [options.lengthZ=40] - 轴向长度(m)
   * @param {number} [options.nx=64] - X 网格数
   * @param {number} [options.ny=64] - Y 网格数
   * @param {number} [options.nz=96] - Z 网格数
   *
   *   分辨率说明（A5 性能修复）：多装药源模式下，每帧需对 网格点数 × 源数 做同步
   *   矢量叠加。原默认 96×96×192=177 万点·源/帧，会把主线程阻塞到秒级（动画卡死）。
   *   现将默认降到 64×64×96=39 万点，配合仅掏槽孔组多源（N≤12），单帧
   *   约 源数×39万 次叠加，交互仍流畅，同时保留波场干涉的形态分辨率。
   * @param {number} [options.K=30] - 萨道夫斯基 K（已针对隧道尺度可视化校准，见下方说明）
   * @param {number} [options.alpha=1.5] - 萨道夫斯基 alpha
   * @param {number} [options.beta=0.02] - 阻尼系数
   * @param {number} [options.cp=4500] - 纵波速度
   * @param {number} [options.rho=2650] - 岩体密度
   * @param {number} [options.nu=0.25] - 泊松比
   * @param {number[]} [options.origin] - 爆心在网格局部坐标系中的坐标 [x,y,z]（如掏槽孔质心
   *                [x, y, faceOffset]），缺省 [0,0,0]
   */
  constructor(options) {
    this.chargeKg = options.chargeKg ?? 100
    this.tunnelWidth = options.tunnelWidth ?? 18
    this.tunnelHeight = options.tunnelHeight ?? 15
    this.lengthZ = options.lengthZ ?? 40
    this.nx = options.nx ?? 64
    this.ny = options.ny ?? 64
    this.nz = options.nz ?? 96
    // 爆心（网格局部坐标，缺省网格原点）——应力波/损伤从实际爆破位置（掏槽孔质心）扩散
    this._origin = Array.isArray(options.origin) ? options.origin.map(Number) : null
    // 多装药源：由实际炮孔布孔（楔形掏槽等）推算的装药源列表 [{x,y,z,chargeKg,delayMs}]。
    // 提供时启用多源矢量叠加（多应力波干涉波场）；为空则退化为单源（原行为）。
    this._sources = Array.isArray(options.sources) ? options.sources : null
    // 显式边界（与 WS 网格对齐时传入；null 则按隧道尺寸推导对称边界）
    this._explicitBounds =
      options.boundsMin && options.boundsMax
        ? { boundsMin: options.boundsMin, boundsMax: options.boundsMax }
        : null

    // 岩体与萨道夫斯基参数
    // K 默认取 30（而非工程常用 200）：本体积盒尺度为隧道局部（宽度≤18m、纵深≤40m），
    // 若 K=200，按 Q=100kg 计算即使盒最远角（≈42m）PPV 仍约 22 cm/s，远超 PPV 色阶上限
    // 15 cm/s，导致整个体积盒饱和成一片红（用户看到的"红色方形"），应力/损伤也被淹没。
    // K=30 时近爆心 PPV 仍达数十 cm/s（破碎/抛掷区，红），远场衰减至 ~1 cm/s（蓝），
    // 呈现"近红→中绿→远蓝"的球面梯度，使 PPV/应力/损伤三模式均能正确分级显示。
    this.params = {
      K: options.K ?? 30,
      alpha: options.alpha ?? 1.5,
      beta: options.beta ?? 0.02,
      visualBeta: options.visualBeta ?? 0.8, // 可视化时变衰减（波峰回落实时速度）
      cp: options.cp ?? 4500,
      visualCp: options.visualCp ?? 35, // 波前可视传播速度（见 computePpvField3d 注释）
      rho: options.rho ?? 2650,
      nu: options.nu ?? 0.25,
      minStandoff: 0.5,
      // 爆心（掏槽孔质心）；computePpvField3d / computePeakDamageZones 均以该点为波源
      origin: this._origin,
      // 多装药源：提供时 computeAtTime 走多源矢量叠加（多应力波干涉波场）
      sources: this._sources
    }

    // 预计算网格
    const grid = buildPpvGrid(
      this.tunnelWidth,
      this.tunnelHeight,
      this.lengthZ,
      this.nx,
      this.ny,
      this.nz,
      this._explicitBounds
    )
    this.gridXyz = grid.gridXyz
    this.gridShape = grid.gridShape
    this.boundsMin = grid.boundsMin
    this.boundsMax = grid.boundsMax

    // 缓存上一帧计算结果
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
    this._cachedZones = null

    // 预分配输出缓冲区（computeAtTime 每帧调用，避免 new Float32Array(65536)×2 + Int8Array(65536) 导致 GC 压力）
    const nPoints = this.nx * this.ny * this.nz
    this._ppvBuf = new Float32Array(nPoints)
    this._sigmaBuf = new Float32Array(nPoints)
    this._zoneBuf = new Int8Array(nPoints)
  }

  /** 获取网格信息（供渲染器初始化） */
  getGridInfo() {
    return {
      gridShape: this.gridShape,
      boundsMin: this.boundsMin,
      boundsMax: this.boundsMax
    }
  }

  /**
   * 计算指定时刻的三场数据（PPV/应力/损伤）
   * @param {number} t - 模拟时间(s)
   * @returns {Object} { ppv: Float32Array, sigmaVm: Float32Array, zones: Int8Array }
   *          输出已按 WebGL 轴序（x-最快）排列，可直接传给 blastVibrationFieldRenderer
   *
   * 轴序说明：buildPpvGrid 生成的 gridXyz 已是 x-最快（zi 最外层、xi 最内层，
   * idx = zi*ny*nx + yi*nx + xi），computePpvField3d / computeStressFieldFromPpv /
   * classifyDamageZones 均逐点保持该顺序。该顺序与后端 pack_ppv_binary 中
   * np.transpose(2,1,0) 后的 WebGL 布局完全一致，因此这里不能再调用 reorderForWebGL
   * （它假设输入为 x-最慢），否则会二次转置导致数据错乱。
   */
  computeAtTime(t) {
    // 全量计算（增量优化意义不大，网格不大，直接计算可保证精度）
    // 复用预分配缓冲区，避免每帧 576KB 临时数组分配导致 GC 压力
    const multi = Array.isArray(this.params.sources) && this.params.sources.length > 0
    const ppv = multi
      ? computeMultiSourcePpvField3d(this.gridXyz, t, this.params, this._ppvBuf)
      : computePpvField3d(this.gridXyz, this.chargeKg, t, this.params, this._ppvBuf)
    const sigmaVm = computeStressFieldFromPpv(ppv, this.params, this._sigmaBuf)
    // 损伤分区：按"波峰几何峰值 × 波前到达门控"（computePeakDamageZones / 多源版）——
    // 确定性算法，与播放方向无关：正放/回拉/拖进度条同一时刻结果一致，
    // 波前到达处显示常驻五色分区、未到达处 0（修复回拉进度条时序错乱）。
    const zones = multi
      ? computeMultiSourcePeakDamageZones(this.gridXyz, t, this.params, this._zoneBuf)
      : computePeakDamageZones(this.gridXyz, this.chargeKg, t, this.params, this._zoneBuf)

    this._lastT = t
    this._cachedPpv = ppv
    this._cachedSigmaVm = sigmaVm
    this._cachedZones = zones

    return { ppv, sigmaVm, zones }
  }

  /**
   * 重设多装药源（切换爆破事件/炮孔布孔时调用）。
   * 更新 params.sources 并使下一帧重算（清除缓存）。
   * 传入空数组/null 则退化为单源模式。
   * @param {Array|null} sources - [{x,y,z,chargeKg,delayMs}]
   */
  setSources(sources) {
    this._sources = Array.isArray(sources) && sources.length > 0 ? sources : null
    this.params.sources = this._sources
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
  }

  /**
   * 重置损伤状态（保留 API 兼容：损伤分区已改为"峰值×到达门控"的确定性算法，
   * 输出只与当前时刻 t 有关，不再跨帧累积，故无需额外状态清理）。
   */
  resetPeak() {
    // 确定性算法下无需清理；保留空实现以兼容外部调用（循环回卷/seek 跳变）。
  }

  /** 是否已初始化 */
  get isReady() {
    return !!this.gridXyz && this.gridXyz.length > 0
  }
}

/**
 * 振动场计算 Web Worker 客户端
 *
 * 把 LocalVibrationSimulator 中最重的逐帧计算（多源矢量叠加 PPV/应力/损伤场）
 * 卸载到 Worker 线程，避免主线程因"网格点数×源数×幂/指数"计算卡死动画。
 * 使用 Transferable 零拷贝取回结果；同一时刻只允许一个 compute 请求在途，
 * requestId 用于识别并丢弃过期的中途结果。
 */
export class VibrationComputeClient {
  constructor() {
    this._worker = null
    this._simKey = null // 绑定的 sim 实例引用（识别是否需要重新 config）
    this._configSig = null // 已下发 Worker 的物理参数签名（K/α/网格/源数），变化时重配
  }

  get isWorkerAvailable() {
    return this._worker != null
  }

  /** 计算已下发配置的参数签名（K/α/介质/网格/源数；setSadoskyParams 原地改参后据此重配） */
  _signature(sim) {
    const p = sim.params
    return [
      sim.gridXyz ? sim.gridXyz.length : 0,
      Number(p.K),
      Number(p.alpha),
      Number(p.beta),
      Number(p.visualBeta),
      Number(p.visualCp),
      sim.chargeKg,
      Array.isArray(p.sources) ? p.sources.length : 0
    ].join('|')
  }

  /**
   * 确保 Worker 已启动并为本 sim 配备好网格/参数（只在 sim 或参数变化时重新 config）。
   * @param {LocalVibrationSimulator} sim
   * @returns {boolean} Worker 是否就绪（不可用时返回 false，供调用方回退同步计算）
   */
  ensure(sim) {
    if (!sim || !sim.gridXyz) return false
    const sig = this._signature(sim)
    if (this._worker && this._simKey === sim && this._configSig === sig) return true
    if (!this._worker) {
      try {
        this._worker = new Worker(new URL('./vibrationComputeWorker.js', import.meta.url), {
          type: 'module'
        })
      } catch (err) {
        this._worker = null
        console.warn('[VibrationComputeClient] Worker 启动失败，回退主线程计算', err)
        return false
      }
    }
    this._simKey = sim
    this._configSig = sig
    this._postConfig(sim)
    return true
  }

  _postConfig(sim) {
    // params 深拷贝一份发给 Worker（worker 侧不可变）；含 sources（多装药源）与萨道夫斯基参数
    const params = {
      ...sim.params,
      sources: Array.isArray(sim.params.sources) ? sim.params.sources.map(s => ({ ...s })) : null,
      origin: sim.params.origin ? sim.params.origin.slice() : null
    }
    this._worker.postMessage({
      type: 'config',
      gridXyz: sim.gridXyz,
      params,
      chargeKg: sim.chargeKg
    })
    // 注意：gridXyz 故意不进行 Transferable 转移——主线程 sim 仍需自身 gridXyz
    // 做同步回退计算(computeAtTime)，转移会 detach 主线程侧缓冲。仅每次 sim 变化
    // config 一次，结构化克隆 3D 坐标（~数 MB）开销可忽略。
  }

  /**
   * 请求计算某时刻三场数据（异步）。
   * @param {number} t - 模拟时间(s)
   * @param {number} requestId - 调用方自增 id，用于在回调中丢弃过期结果
   * @returns {Promise<{ppv:Float32Array,sigmaVm:Float32Array,zones:Int8Array,t:number,requestId:number}> | null}
   */
  compute(t, requestId) {
    if (!this._worker) return null
    return new Promise(resolve => {
      const handler = e => {
        const d = e.data
        if (!d || d.type !== 'result') return
        if (d.requestId !== requestId) return // 过期结果，丢弃
        this._worker.removeEventListener('message', handler)
        this._worker.removeEventListener('error', handler)
        resolve({ ppv: d.ppv, sigmaVm: d.sigmaVm, zones: d.zones, t: d.t, requestId: d.requestId })
      }
      const error = err => {
        this._worker.removeEventListener('message', handler)
        resolve(null) // 计算失败回退：调用方应自行兜底
        console.warn('[VibrationComputeClient] Worker 计算错误', err)
      }
      this._worker.addEventListener('message', handler)
      this._worker.addEventListener('error', error)
      this._worker.postMessage({ type: 'compute', t, requestId })
    })
  }

  /** 丢弃未决结果并断开 Worker（场景重建/销毁时调用） */
  dispose() {
    if (this._worker) {
      this._worker.terminate()
      this._worker = null
    }
    this._simKey = null
  }
}

/**
 * 振动传播粒子系统（粒子跟随波前扩散，增强可视化效果）
 * 每个粒子沿径向从爆心向外运动，速度接近纵波速度，存活时间与波前位置匹配
 */
export class VibrationParticleSystem {
  /**
   * @param {number} maxParticles - 最大粒子数
   */
  constructor(maxParticles = 500) {
    this.maxParticles = maxParticles
    this.particles = [] // { x, y, z, vx, vy, vz, birthT, lifetime, size, alpha }
    this._rng = Math.random
  }

  /**
   * 在爆心附近发射一批粒子，沿径向扩散
   * @param {number} t - 当前发射时间
   * @param {number} count - 发射数量
   * @param {number} _cp - 纵波速度(m/s)（未使用，保留用于API一致性）
   */
  emitBurst(t, count, _cp = 4500) {
    // 视觉速度：波前粒子用于可视化，与热力图波前可视速度（visualCp≈35m/s）匹配，
    // 使粒子始终跟随波前在视野内扩散，形成可见的振动传播效果。
    const visualSpeed = 35 + 15 * this._rng() // 35~50 m/s
    for (let i = 0; i < count && this.particles.length < this.maxParticles; i++) {
      // 均匀采样球面方向
      const theta = this._rng() * 2 * Math.PI
      const phi = Math.acos(2 * this._rng() - 1)
      const speed = visualSpeed * (0.8 + 0.4 * this._rng()) // 散射
      const vx = speed * Math.sin(phi) * Math.cos(theta)
      const vy = speed * Math.sin(phi) * Math.sin(theta)
      const vz = speed * Math.cos(phi)

      // 从爆心（原点）附近发射
      const r0 = 0.5 + 2 * this._rng() // 0.5~2.5m 初始半径
      const x0 = r0 * Math.sin(phi) * Math.cos(theta)
      const y0 = r0 * Math.sin(phi) * Math.sin(theta)
      const z0 = r0 * Math.cos(phi)

      this.particles.push({
        x: x0,
        y: y0,
        z: z0,
        vx,
        vy,
        vz,
        birthT: t,
        lifetime: 1.5 + 1.5 * this._rng(), // 存活 1.5~3s，覆盖整个体积盒扩散过程
        size: 3.0 + 8.0 * this._rng(), // 像素大小（点精灵）
        alpha: 0.6 + 0.4 * this._rng()
      })
    }
  }

  /**
   * 更新粒子位置，淘汰过期粒子
   * @param {number} t - 当前时间(s)
   * @param {number} dt - 时间步长(s)
   */
  update(t, dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      const age = t - p.birthT
      if (age > p.lifetime) {
        this.particles.splice(i, 1)
        continue
      }
      // 简单匀速运动（阻尼可忽略，粒子寿命很短）
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      // alpha 随年龄衰减
      p.alpha = (1 - age / p.lifetime) * p.alpha
    }
  }

  /** 清除所有粒子 */
  clear() {
    this.particles.length = 0
  }

  /** 获取当前活跃粒子 */
  get activeParticles() {
    return this.particles
  }
}

export default {
  buildPpvGrid,
  sadoskyPpv,
  computePpvField3d,
  computeStressFieldFromPpv,
  classifyDamageZones,
  computePeakDamageZones,
  resolveChargePosition,
  buildChargeSources,
  computeMultiSourcePpvField3d,
  computeMultiSourcePeakDamageZones,
  reorderForWebGL,
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient
}
