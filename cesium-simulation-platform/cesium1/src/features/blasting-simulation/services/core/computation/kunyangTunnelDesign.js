/**
 * 昆阳磷矿二矿巷道掘进光面爆破（楔形掏槽）—— 文献化设计参数
 *
 * 数据来源：王万禄等《昆阳磷矿二矿巷道围岩爆破振动监测与分析》，采矿技术 2025, 25(2):78-88
 *  监测/建模断面（1890m中段2#胶带巷道）：
 *  - 三心拱形掘进断面 4.7m 宽 × 3.75m 高，掘进断面积 15.81m²，净宽 4.50m / 净高 3.50m。
 *  - 岩体：底板白云岩，坚固性系数 f=4~10。
 *  - 打眼：YT28 气动凿岩机，孔深约 3.0m，1# 岩石乳化炸药，反向连续装药。
 *  - 布孔（监测段落，楔形掏槽）：掏槽眼 8 + 辅助眼 20 + 底眼 6 + 周边眼 9 = 43 孔，
 *    总装药量 84kg，爆破后进尺约 2.55m（炮眼利用率 83.33%）。
 *  - 起爆：数码电子雷管 8 段，段间隔毫秒延期（KUNYANG_SEG_INTERVAL_MS=75ms）；
 *    掏槽 1 段、辅助 2~6 段、底眼 7 段、周边 8 段。缩段间隔使各段抛掷在时间上交叠成连续过程。
 *
 * 振动回归（萨道夫斯基，据三方向合成速度最小二乘）：
 *   V = K·(Q^(1/3)/R)^α，K=90.63、α=1.58（据 M1~M3 拟合，M4 异常剔除）。
 *
 * 渲染注释：渲染器仅支持 horseshoe/circular/rectangular 三种断面类型，此处以 4.7×3.75m
 * 的马蹄形断面近似三心拱（拱部半径 = 宽/2 = 2.35m，直墙高 1.40m，总高 3.75m）。
 * 该设计用于平台 006 事件（BLAST-2026-006），与 002（南山 15.56×10.23m）显著区分，
 * 并使 3D 模型（隧道断面、炮孔布局）与昆阳文献标定一致。
 */

export const KUNYANG_SECTION = {
  width: 4.7, // 掘进断面宽 (m)
  wallHeight: 1.4, // 直墙高 (m)
  archRadius: 2.35, // 拱部半径 (m)，≈ 宽/2
  shape: 'horseshoe',
  totalHeight: 3.75, // 1.4 + 2.35
  area: 15.81 // 掘进断面积 (m²)
}

// 掏槽孔深 (m)、炮孔利用率、单循环进尺
export const KUNYANG_HOLE_DEPTH = 3.0
export const KUNYANG_UTILIZATION = 0.85
export const KUNYANG_ADVANCE = 3.0 * 0.85 // 2.55 m

// 段间延时间隔(ms)：贴近数码电子雷管毫秒延期。原 500ms 跨 8 段把抛掷铺到 3.5s，
// 叠加物理引擎"到点才整批瞬动"，造成"吐口水"式的一下一下分段抛掷；压缩到真实毫秒级后，
// 前序碎块仍在飞散时后段即起爆，各段抛掷在时间上交叠成连续过程（与后端 seed_kunyang_event.py 保持一致）。
export const KUNYANG_SEG_INTERVAL_MS = 75

// 楔形掏槽：4 对孔口横向展布（m），由内到外对称（共 8 孔，段 1）
const WEDGE_X = [0.4, 0.8, 1.2, 1.6]
const WEDGE_Y = 1.3 // 掌子面中下部
// 倾角 = "偏离孔轴线法向（垂直于掌子面的方向）"的角，由内到外增大。
// 渲染器按该角绕孔口做整角倾斜：55°~70° 接近平行掌子面，孔底竖向偏移达 ~2.8m，
// 会穿出拱顶/底板（"炸药出掌子面"）。改为由孔底在 3.0m 深向隧洞中心汇拢所需的小倾角：
//   tanθ ≈ x_out / depth ，外层 x=1.6 → θ≈28°，内层 x=0.4 → θ≈8°。
const WEDGE_INCLIN = [8, 15, 22, 28]
const WEDGE_CHARGE = 2.4 // 掏槽眼单眼装药量 (kg)

// 辅助眼两环（中心 y=1.3，共 20 孔，段 2~6）
// 环半径受底板(y=0)与拱部限制：r2=1.3 时低点 y=0、高点乃拱内，确保全部落在断面内
const AUX_RINGS = [
  [0.8, 8, 2.3], // [半径, 孔数, 单眼药量kg]
  [1.3, 12, 1.9]
]

/** 生成昆阳磷矿巷道掌子面布孔（楔形掏槽 + 环形辅助孔 + 周边光爆孔 + 底眼）。 */
export function buildKunyangTunnelDesign() {
  const sec = KUNYANG_SECTION
  const Hw = sec.wallHeight
  const cy = Hw // 拱心 y 坐标
  const depth = KUNYANG_HOLE_DEPTH
  const holes = []
  let series = 0

  const push = h => {
    if (!_insideSection(h.posX, h.posY, sec, 0.1)) return
    holes.push(h)
  }

  // ── 1. 楔形掏槽眼（8 孔，左右对称，段 1 / 无延时）──────────────
  for (let i = 0; i < WEDGE_X.length; i++) {
    for (const side of [-1, 1]) {
      holes.push({
        posX: _r1(side * WEDGE_X[i]),
        posY: _r1(WEDGE_Y),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: WEDGE_INCLIN[i],
        // 保持孔底在同一高度(y=1.3)、仅向隧洞中心 -x(右孔) / +x(左孔) 内倾，
        // 形成 V 形楔形掏槽并向孔底 3.0m 处汇拢；切勿用 ±90（会把右孔朝上、左孔朝下散开）。
        inclinationAzimuth: side > 0 ? 180 : 0,
        chargeKg: WEDGE_CHARGE,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: 0,
        id: `KY-W${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── 2. 辅助眼（两环，中心 y=1.3，随半径延时递增、段 2~6）──────
  for (let ri = 0; ri < AUX_RINGS.length; ri++) {
    const [r, n, chg] = AUX_RINGS[ri]
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = _r1(Math.cos(a) * r)
      const y = _r1(1.3 + Math.sin(a) * r)
      if (!_insideSection(x, y, sec, 0.1)) continue
      series = 2 + ((ri + i) % 5) // 段 2~6
      holes.push({
        posX: x,
        posY: y,
        holeType: 'auxiliary',
        isEmptyHole: false,
        depth,
        inclinationAngle: 4,
        inclinationAzimuth: Math.round(Math.degrees(Math.atan2(Math.cos(a) * r, Math.sin(a) * r))),
        chargeKg: chg,
        chargeLength: depth * 0.65,
        explosiveType: 'emulsion',
        detonatorSeries: series,
        delayMs: (series - 1) * KUNYANG_SEG_INTERVAL_MS, // 段间隔 KUNYANG_SEG_INTERVAL_MS ms
        id: `KY-A${ri + 1}-${i + 1}`
      })
    }
  }

  // ── 3. 周边光爆孔（拱部 5 + 帮眼 4 = 9，段 8）────────
  const archR = sec.archRadius - 0.2 // 落位在轮廓线内侧 0.2m（光爆爆距）
  const archAngs = [50, 70, 90, 110, 130]
  for (const ang of archAngs) {
    const rad = (ang * Math.PI) / 180
    const x = _r1(Math.cos(rad) * archR)
    const y = _r1(cy + Math.sin(rad) * archR)
    if (!_insideSection(x, y, sec, 0.05)) continue
    holes.push({
      posX: x,
      posY: y,
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 3,
      inclinationAzimuth: Math.round(Math.degrees(Math.atan2(x, y - cy))),
      chargeKg: 1.0,
      chargeLength: depth * 0.55,
      explosiveType: 'emulsion',
      detonatorSeries: 8,
      delayMs: (8 - 1) * KUNYANG_SEG_INTERVAL_MS,
      id: `KY-PA${Math.round(ang)}`
    })
  }
  // 帮眼（两侧直墙）
  const wallX = sec.width / 2 - 0.3
  for (const side of [-1, 1]) {
    for (const wy of [0.6, 1.05]) {
      holes.push({
        posX: side * wallX,
        posY: _r1(wy),
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 3,
        inclinationAzimuth: side > 0 ? 90 : -90,
        chargeKg: 1.0,
        chargeLength: depth * 0.55,
        explosiveType: 'emulsion',
        detonatorSeries: 8,
        delayMs: (8 - 1) * KUNYANG_SEG_INTERVAL_MS,
        id: `KY-PW${side > 0 ? 'R' : 'L'}${Math.round(wy * 100)}`
      })
    }
  }

  // ── 4. 底眼（6 孔，段 7，帮助翻渣）──────────────────
  const floorX = [0.6, 1.2, 1.8]
  for (const side of [-1, 1]) {
    for (const fx of floorX) {
      holes.push({
        posX: side * fx,
        posY: 0.4,
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 6,
        inclinationAzimuth: 0,
        chargeKg: 2.4,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 7,
        delayMs: (7 - 1) * KUNYANG_SEG_INTERVAL_MS,
        id: `KY-F${side > 0 ? 'R' : 'L'}${Math.round(fx * 10)}`
      })
    }
  }

  return { section: sec, holes }
}

// 判断点 (x, y) 是否在马蹄形断面内（预留 margin）
function _insideSection(x, y, sec, margin) {
  if (y < 0) return false
  const halfW = sec.width / 2 - margin
  const Hw = sec.wallHeight
  const R = sec.archRadius - margin
  if (y <= Hw) return Math.abs(x) <= halfW
  const dx = x
  const dy = y - Hw
  return dx * dx + dy * dy <= R * R
}

function _r1(v) {
  return Math.round(v * 10) / 10
}

if (typeof Math.degrees !== 'function') {
  Math.degrees = function degreesRad(rad) {
    return (rad * 180) / Math.PI
  }
}