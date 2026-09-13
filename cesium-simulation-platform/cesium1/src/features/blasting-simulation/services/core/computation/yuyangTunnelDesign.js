/**
 * 余漾隧道爆堆块度（某隧道钻爆法全断面）—— 文献化布孔设计
 *
 * 数据来源：余漾等《隧道爆堆块度图像识别及块度分布快速评价研究》现代工程科技 2026,5(9)。
 *  - 工程：某隧道采用钻爆法施工，掌子面单次爆破方量约 180m³。
 *  - 岩性：新近系泥岩夹砂岩、砾岩以及三叠系砂岩、板岩和砾岩为主；岩体结构致密，
 *    节理裂隙发育中等。
 *  - 爆破参数：单孔装药量 1.3~2.0 kg/m（线装药密度），孔深 3.2~3.3m，孔径 32mm，
 *    孔距 600~1300mm。
 *  - 块度：五次爆堆图像识别+Swebrec 拟合，x50≈156~252mm、xmax≈0.65~1.37m、
 *    b≈5.58~8.17；级配不良（Cu=1.82~2.92<5，Cc=1.08~1.18 合格）。
 *
 * 断面尺寸文献未给出，按"单次 180m³、进尺≈2.7m"推算断面积约 65~67m²：
 * 马蹄形 10.8m×7.4m（宽×高）。该设计用于平台 005 事件（BLAST-2026-005，余漾），
 * 前端据此覆盖 DB 的通用设计，使 3D 模型（隧道断面、炮孔布局、雷管段别）与文献一致。
 */

export const YUYANG_SECTION = {
  width: 10.8, // 开挖宽度 (m)
  wallHeight: 2.0, // 直墙高 (m)
  archRadius: 5.4, // 拱部半径 (m) = 宽/2
  shape: 'horseshoe',
  totalHeight: 7.4 // 2.0 + 5.4
}

const HOLE_DEPTH = 3.2
// 掏槽核心线高度（掌子面中下）
const Y_CUT = 2.4
// 楔形掏槽：每排为上下两孔对称斜孔向核心线汇拢，[孔口横向展布, 距核心线竖向Δy, 倾角°]
const WEDGE_ROWS = [
  [1.2, 0.7, 13],
  [1.8, 1.4, 25]
]
const WEDGE_CHARGE_KG = 1.8 // 掏槽单眼装药量 (kg)，文献单孔装药 1.3~2.0kg/m 区间
const RELIEF_LAYERS = [
  [3.0, 18, 1.5, 3],
  [4.8, 26, 1.4, 5],
  [6.6, 34, 1.3, 7]
]
const PERIM_SPACING = 0.65

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

function _degrees(rad) {
  return (rad * 180) / Math.PI
}

export function buildYuyangTunnelDesign(opt = {}) {
  const sec = YUYANG_SECTION
  const depth = Number(opt.holeDepth) || HOLE_DEPTH
  const Hw = sec.wallHeight
  const R = sec.archRadius
  const holes = []

  const push = h => {
    if (!_insideSection(h.posX, h.posY, sec, 0.35)) return
    holes.push(h)
  }

  // ── ① 中心空孔（自由面，段 1）───────────────
  push({
    posX: 0,
    posY: _r1(Y_CUT),
    holeType: 'cut',
    isEmptyHole: true,
    depth,
    inclinationAngle: 0,
    inclinationAzimuth: 0,
    chargeKg: 0,
    chargeLength: 0,
    explosiveType: 'emulsion',
    detonatorSeries: 1,
    delayMs: 0,
    id: 'YY-E'
  })

  // ── ② 楔形掏槽（上下两排 × 两侧 = 8 孔，段 1）──────
  for (let i = 0; i < WEDGE_ROWS.length; i++) {
    const [dx, dy, inc] = WEDGE_ROWS[i]
    for (const side of [-1, 1]) {
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT + dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: -90,
        chargeKg: WEDGE_CHARGE_KG,
        chargeLength: depth * 0.65,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: i,
        id: `YY-CU-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT - dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: 90,
        chargeKg: WEDGE_CHARGE_KG,
        chargeLength: depth * 0.65,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: i,
        id: `YY-CL-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── ③ 环形扩槽/崩落层（由内向外段 3→5→7）───────
  for (let ri = 0; ri < RELIEF_LAYERS.length; ri++) {
    const [r, n, chg, seg] = RELIEF_LAYERS[ri]
    const delayBase = [6, 16, 36][ri]
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = _r1(Math.cos(a) * r)
      const y = _r1(Y_CUT + Math.sin(a) * r)
      const azi = _r1(_degrees(Math.atan2(Math.cos(a) * r, Math.sin(a) * r)))
      push({
        posX: x,
        posY: y,
        holeType: 'auxiliary',
        isEmptyHole: false,
        depth,
        inclinationAngle: 4,
        inclinationAzimuth: azi,
        chargeKg: chg,
        chargeLength: depth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: seg,
        delayMs: delayBase + (i % n) * 2,
        id: `YY-R${ri + 1}-${i + 1}`
      })
    }
  }

  // ── ④ 周边光爆孔（拱顶 + 两侧边墙 + 底排）─────
  const R_arch = R - 0.25
  const archN = Math.max(14, Math.round((Math.PI * R_arch) / PERIM_SPACING))
  for (let i = 0; i < archN; i++) {
    const a = Math.PI * (i / (archN - 1))
    const x = Math.cos(a) * R_arch
    const y = Hw + Math.sin(a) * R_arch
    const azi = _r1(_degrees(Math.atan2(x, y - Hw)))
    holes.push({
      posX: _r1(x),
      posY: _r1(y),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 3,
      inclinationAzimuth: azi,
      chargeKg: 0.6,
      chargeLength: depth * 0.5,
      explosiveType: 'emulsion',
      detonatorSeries: 9,
      delayMs: 400 + 18,
      id: `YY-PA${i + 1}`
    })
  }
  const wallX = sec.width / 2 - 0.35
  for (const side of [-1, 1]) {
    for (const wyR of [0.3, 0.6, 0.85]) {
      holes.push({
        posX: side * wallX,
        posY: _r1(Hw * wyR),
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 3,
        inclinationAzimuth: side > 0 ? 90 : -90,
        chargeKg: 1.2,
        chargeLength: depth * 0.55,
        explosiveType: 'emulsion',
        detonatorSeries: 7,
        delayMs: 300 + 15,
        id: `YY-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }
  const floorN = 11
  const floorHalf = sec.width / 2 - 1.2
  for (let i = 0; i < floorN; i++) {
    holes.push({
      posX: _r1(((2 * i) / (floorN - 1) - 1) * floorHalf),
      posY: _r1(0.5),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: 1.6,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 7,
      delayMs: 300 + 14,
      id: `YY-F${i + 1}`
    })
  }

  return { section: sec, holes }
}