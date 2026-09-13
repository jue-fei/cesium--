/**
 * 董武俊台阶法隧道（天江里隧道）全断面爆破 —— 文献化布孔设计
 *
 * 数据来源：董武俊《台阶法隧道岩体爆破特性研究及岩石碎片块度预测》爆破 2023,40(2)。
 *  - 工程：天江里隧道，左右线分离的双向四车道高速公路隧道，主洞设计高 9.25m、
 *    宽 12.25m。采用台阶法施工：上台阶断面 35.91m²、下台阶断面 57.28m²。
 *  - 岩性：第三系泥质砂岩、砂岩、砾岩及第四系松散堆积层；Ⅲ级围岩为主、Ⅳ为辅。
 *  - 上台阶爆破（表1）：开槽孔(段1,孔深2.2m)4孔 / 扩槽孔(段5)4 / 辅助孔(段7)6 /
 *    辅助孔(段8)6 / 崩落孔(段9)17 / 轮廓孔(段10)25 / 底孔(段11)13 → 合计75孔、75.71kg。
 *  - 炸药：有水段乳化炸药(φ32mm×200mm，间隔/不耦合装药)，其余 2#岩石硝铵炸药。
 *  - 单耗：上台阶 1.05 kg/m³（实测），下台阶 0.75 kg/m³。
 *  - 块度：上台阶 x50=0.16m、xmax 实测 63.5cm、n=1.05、b=0.7；下台阶 x50=0.21m、
 *    xmax 实测 75.2cm、n=0.95、b=0.8。下台阶单耗低、断面积大、整体块度大。
 *
 * 该设计用于平台 006 事件（BLAST-2026-006，董武俊）。为适应平台单掌子面 3D 渲染，
 * 上、下台阶按同一全断面呈现，布孔映射表1 的段别与装药量。
 */

export const DONGWUJUN_SECTION = {
  width: 12.25, // 主洞开挖宽度 (m)
  wallHeight: 3.125, // 直墙高 (m) = 9.25 - 6.125
  archRadius: 6.125, // 拱部半径 (m) = 宽/2
  shape: 'horseshoe',
  totalHeight: 9.25 // 主洞设计高 (m)
}

const HOLE_DEPTH = 2.2 // 开槽孔孔深 2.2m，其余 2.0m（表中取 2.2 便于表达掏槽）
const Y_CUT = 3.0 // 掏槽核心线高度（掌子面中下）
// 楔形掏槽：[孔口横向展布, 距核心线竖向Δy, 倾角°]
const WEDGE_ROWS = [
  [1.4, 0.8, 13],
  [2.2, 1.6, 25]
]
const WEDGE_CHARGE_KG = 1.54 // 开槽孔单孔装药量 (kg)，段1
// 扩槽/崩落层：[半径 r(相对掏槽核心线), 孔数, 单孔药量kg, 雷管段]
const RELIEF_LAYERS = [
  [2.4, 8, 1.4, 5], // 扩槽孔 段5
  [3.8, 14, 1.2, 7], // 辅助孔 段7
  [4.6, 16, 1.2, 8], // 辅助孔 段8
  [5.6, 20, 1.0, 9] // 崩落孔 段9
]
const PERIM_SPACING = 0.7

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

export function buildDongwujunTunnelDesign(opt = {}) {
  const sec = DONGWUJUN_SECTION
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
    explosiveType: 'anfo',
    detonatorSeries: 1,
    delayMs: 0,
    id: 'DW-E'
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
        chargeLength: depth * 0.7,
        explosiveType: 'anfo',
        detonatorSeries: 1,
        delayMs: i,
        id: `DW-CU-${i + 1}-${side > 0 ? 'R' : 'L'}`
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
        chargeLength: depth * 0.7,
        explosiveType: 'anfo',
        detonatorSeries: 1,
        delayMs: i,
        id: `DW-CL-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── ③ 扩槽/辅助/崩落层（段 5→7→8→9）───────
  for (let ri = 0; ri < RELIEF_LAYERS.length; ri++) {
    const [r, n, chg, seg] = RELIEF_LAYERS[ri]
    const delayBase = [16, 36, 60, 92][ri]
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
        depth: seg === 5 ? depth : 2.0,
        inclinationAngle: 4,
        inclinationAzimuth: azi,
        chargeKg: chg,
        chargeLength: 2.0 * 0.6,
        explosiveType: 'anfo',
        detonatorSeries: seg,
        delayMs: delayBase + (i % n) * 2,
        id: `DW-R${ri + 1}-${i + 1}`
      })
    }
  }

  // ── ④ 周边光爆孔（拱顶 + 两侧边墙，段 10）─────
  const R_arch = R - 0.25
  const archN = Math.max(16, Math.round((Math.PI * R_arch) / PERIM_SPACING))
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
      depth: 2.0,
      inclinationAngle: 3,
      inclinationAzimuth: azi,
      chargeKg: 0.6,
      chargeLength: 2.0 * 0.5,
      explosiveType: 'anfo',
      detonatorSeries: 10,
      delayMs: 500 + 18,
      id: `DW-PA${i + 1}`
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
        depth: 2.0,
        inclinationAngle: 3,
        inclinationAzimuth: side > 0 ? 90 : -90,
        chargeKg: 0.6,
        chargeLength: 2.0 * 0.5,
        explosiveType: 'anfo',
        detonatorSeries: 10,
        delayMs: 500 + 15,
        id: `DW-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }

  // ── ⑤ 密集底孔（段 11，帮助翻渣并平整底板）─────
  const floorN = 14
  const floorHalf = sec.width / 2 - 1.2
  for (let i = 0; i < floorN; i++) {
    holes.push({
      posX: _r1(((2 * i) / (floorN - 1) - 1) * floorHalf),
      posY: _r1(0.55),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth: 2.0,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: 1.35,
      chargeLength: 2.0 * 0.7,
      explosiveType: 'anfo',
      detonatorSeries: 11,
      delayMs: 600 + 20,
      id: `DW-F${i + 1}`
    })
  }

  return { section: sec, holes }
}