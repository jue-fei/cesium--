/**
 * 冯银巷道爆破环间延时（备战铁矿）—— 文献化布孔设计
 *
 * 数据来源：冯银、陈辉《巷道爆破环间延时对岩石抛掷距离的影响》采矿技术 2024,24(1)。
 *  - 工程：新疆维吾尔自治区备战铁矿，巷道断面尺寸 4.2m×4.0m。
 *  - 岩性：绿帘石化矽卡岩、磁铁矿化矽卡岩、晶屑凝灰岩为主；平均单轴抗压 65.94MPa、
 *    抗拉 8.73MPa，质量等级Ⅲ~Ⅳ级。
 *  - 爆破：双楔形掏槽 + 光面爆破；手持式凿岩机，共 50 个炮孔；2号岩石乳化炸药，
 *    单次消耗220卷、66kg；数码电子雷管环间延时爆破。
 *  - 起爆分段（表2）：第一级掏槽孔[1~4]0ms / 第二级掏槽孔[5~14]100ms /
 *    第一级辅助眼[15~22]200ms / 第二级辅助眼[23~31]300ms / 帮眼[32~37]400ms /
 *    底眼[38~43]500ms / 顶眼[44~50]600ms。
 *  - 环间延时对抛掷的影响：50ms→62m、100ms→48m、150ms→28m、200ms→26m、500ms→20m；
 *    爆堆高度 1.78/1.86/2.14/2.23/2.59m。50ms 对抛掷效果提升最显著。
 *
 * 该设计用于平台 007 事件（BLAST-2026-007，冯银）。
 */

export const FENGYIN_SECTION = {
  width: 4.2, // 巷道开挖宽度 (m)
  wallHeight: 1.9, // 直墙高 (m) = 4.0 - 2.1
  archRadius: 2.1, // 拱部半径 (m) = 宽/2
  shape: 'horseshoe',
  totalHeight: 4.0 // 巷道断面高 (m)
}

const HOLE_DEPTH = 3.0 // 掏槽孔深 3.0m
const Y_CUT = 1.6 // 掏槽核心线高度（掌子面中下）
// 双楔形掏槽：内排(段1, 0ms) + 外排(段2, 100ms)，[孔口横向展布, 距核心线竖向Δy, 倾角°]
const WEDGE_INNER = [
  [0.35, 0.3, 18],
  [0.7, 0.65, 28]
] // 段1：第一级掏槽
const WEDGE_OUTER = [
  [1.1, 0.35, 20],
  [1.5, 0.8, 30]
] // 段2：第二级掏槽
const WEDGE_INNER_CHARGE = 0.9 // 第一级掏槽单孔装药量 (kg)
const WEDGE_OUTER_CHARGE = 1.5 // 第二级掏槽单孔装药量 (kg)
const AUX1_CHARGE = 1.5 // 第一级辅助眼
const AUX2_CHARGE = 1.33 // 第二级辅助眼
const WALL_CHARGE = 1.2 // 帮眼
const FLOOR_CHARGE = 1.5 // 底眼
const TOP_CHARGE = 1.03 // 顶眼

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

export function buildFengyinTunnelDesign(opt = {}) {
  const sec = FENGYIN_SECTION
  const depth = Number(opt.holeDepth) || HOLE_DEPTH
  const Hw = sec.wallHeight
  const R = sec.archRadius
  const holes = []
  const id = 'FY'

  const push = h => {
    if (!_insideSection(h.posX, h.posY, sec, 0.25)) return
    holes.push(h)
  }

  // ── ① 中心空孔（自由面，段 1，0ms）────────
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
    id: `${id}-E`
  })

  // ── ② 第一级掏槽（双楔形内排 4 孔，段 1，0ms）────
  for (const [dx, dy, inc] of WEDGE_INNER) {
    for (const side of [-1, 1]) {
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT + dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: -90,
        chargeKg: WEDGE_INNER_CHARGE,
        chargeLength: depth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: 0,
        id: `${id}-IN${side > 0 ? 'R' : 'L'}${Math.round(dx * 10)}`
      })
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT - dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: 90,
        chargeKg: WEDGE_INNER_CHARGE,
        chargeLength: depth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: 0,
        id: `${id}-IN${side > 0 ? 'R' : 'L'}${Math.round(dx * 10)}b`
      })
    }
  }

  // ── ③ 第二级掏槽（双楔形外排 4 孔，段 2，100ms）────
  for (const [dx, dy, inc] of WEDGE_OUTER) {
    for (const side of [-1, 1]) {
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT + dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: -90,
        chargeKg: WEDGE_OUTER_CHARGE,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 2,
        delayMs: 100,
        id: `${id}-OUT${side > 0 ? 'R' : 'L'}${Math.round(dx * 10)}`
      })
      push({
        posX: _r1(side * dx),
        posY: _r1(Y_CUT - dy),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: inc,
        inclinationAzimuth: 90,
        chargeKg: WEDGE_OUTER_CHARGE,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 2,
        delayMs: 100,
        id: `${id}-OUT${side > 0 ? 'R' : 'L'}${Math.round(dx * 10)}b`
      })
    }
  }

  // ── ④ 辅助眼（环，段 3@200ms / 段 4@300ms）────
  const auxRings = [
    [0.9, 8, AUX1_CHARGE, 3],
    [1.35, 10, AUX2_CHARGE, 4]
  ]
  for (const [ri, ring] of auxRings.entries()) {
    const [r, n, chg, seg] = ring
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.cos(a) * r
      const y = Y_CUT + Math.sin(a) * r
      if (!_insideSection(x, y, sec, 0.15)) continue
      const azi = _r1(_degrees(Math.atan2(Math.cos(a) * r, Math.sin(a) * r)))
      push({
        posX: _r1(x),
        posY: _r1(y),
        holeType: 'auxiliary',
        isEmptyHole: false,
        depth,
        inclinationAngle: 4,
        inclinationAzimuth: azi,
        chargeKg: chg,
        chargeLength: depth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: seg,
        delayMs: (seg - 1) * 100,
        id: `${id}-AUX${seg}-${i + 1}`
      })
    }
  }

  // ── ⑤ 帮眼（两侧，段 5，400ms）────
  const wallX = sec.width / 2 - 0.25
  for (const side of [-1, 1]) {
    for (const wyR of [0.4, 0.8]) {
      push({
        posX: side * wallX,
        posY: _r1(Hw * wyR),
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 3,
        inclinationAzimuth: side > 0 ? 90 : -90,
        chargeKg: WALL_CHARGE,
        chargeLength: depth * 0.55,
        explosiveType: 'emulsion',
        detonatorSeries: 5,
        delayMs: 400,
        id: `${id}-W${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }

  // ── ⑥ 底眼（段 6，500ms）────
  for (const fx of [-1.2, -0.6, 0, 0.6, 1.2]) {
    push({
      posX: _r1(fx),
      posY: _r1(0.4),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: FLOOR_CHARGE,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 6,
      delayMs: 500,
      id: `${id}-F${Math.round((fx + 1.2) * 10)}`
    })
  }

  // ── ⑦ 顶眼（拱顶，段 7，600ms）────
  const archR = R - 0.25
  const topN = 7
  for (let i = 0; i < topN; i++) {
    const a = Math.PI * (i / (topN - 1))
    const x = Math.cos(a) * archR
    const y = Hw + Math.sin(a) * archR
    const azi = _r1(_degrees(Math.atan2(x, y - Hw)))
    push({
      posX: _r1(x),
      posY: _r1(y),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 3,
      inclinationAzimuth: azi,
      chargeKg: TOP_CHARGE,
      chargeLength: depth * 0.5,
      explosiveType: 'emulsion',
      detonatorSeries: 7,
      delayMs: 600,
      id: `${id}-T${i + 1}`
    })
  }

  return { section: sec, holes }
}
