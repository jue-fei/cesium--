/**
 * 三棱山隧道钻爆法掘进 —— 文献化布孔设计
 *
 * 数据来源：徐言《基于萨道夫斯基公式分段修正的隧道爆破振动研究》科学技术创新 2020(21):103-104
 * 工程背景（2.1）：三棱山隧道为京沈客专线路重要隧道，位于辽宁阜新阜蒙县紫都台乡，
 * 全长 8888m，最大埋深 217.56m，双向高铁线路隧道，断面大、地层条件差。
 *
 * 爆破方案（2.2）：
 *  - 炸药 2 号岩石乳化炸药；常规布孔（掏槽/辅助/崩落/周边/底孔），掏槽位于掌子面
 *    中下、楔形掏槽；爆破孔间距 0.5~0.7m，钻孔深度 3.0m。
 *  - 周边孔(MS11)与拱顶孔(MS13)采用间隔装药，其余不耦合装药，装药长度 2.5m。
 *  - 各段间毫秒延时爆破。
 *
 * 萨道夫斯基分段修正（3）：现场 20 组监测量，近/远场分界 R=110m
 *  - 近场(R<110m)：α=1.082，K=19.3（拟合精度 95%）
 *  - 远场(R>110m)：α=0.372，K≈1.23（拟合精度 81%）
 *  - 近场振速随距离衰减较慢、远场衰减较快；本平台振动场默认采用近场 K=19.3, α=1.082。
 *
 * 断面尺寸：文献未给出开挖断面，按"双向高铁线路隧道"标准量级取马蹄形估算：
 * 宽 13.5m、直墙高 3.5m、拱部半径 6.75m、总高 10.25m（高铁双线隧道常见开挖断面量级）。
 *
 * 渲染注释：段间隔压缩为 75ms（与 006 昆阳一致）保证抛掷连续；真实段别为毫秒雷管
 * 序列（掏槽 MS1 ~ 周边 MS11 / 拱顶 MS13），段次序与本方案一致。
 */
export const SANLENGSHAN_SECTION = {
  width: 13.5, // 开挖断面宽（m，估算，高铁双线量级）
  wallHeight: 3.5, // 直墙高（m）
  archRadius: 6.75, // 拱部半径（m）≈ 宽/2
  shape: 'horseshoe',
  totalHeight: 10.25 // 3.5 + 6.75
}

export const SANLENGSHAN_HOLE_DEPTH = 3.0 // 钻孔深度 3.0m（文献 2.2）
export const SANLENGSHAN_UTILIZATION = 0.9
// 段间隔(ms)：压缩到 75ms 保证抛掷连续；文献真实为毫秒雷管（周边 MS11 / 拱顶 MS13）
export const SANLENGSHAN_SEG_INTERVAL_MS = 75

// 掏槽核心线高度（掌子面中下）
const Y_CUT = 2.6
// 楔形掏槽（段 1，掏槽孔内微差 0/1ms）
const WEDGE_ROWS = [
  [0.8, 0.7, 13],
  [1.4, 1.4, 25]
]
const WEDGE_CHARGE_KG = 2.4

// 扩槽/崩落层：[半径, 孔数, 单眼药量kg, 雷管段]（段 3/5/7 由内向外）
const RELIEF_LAYERS = [
  [3.0, 16, 1.8, 3],
  [4.8, 22, 1.5, 5],
  [6.6, 30, 1.3, 7]
]

// 周边最小抵抗线 / 光爆爆距（m，文献孔距 0.5~0.7m）
const PERIM_SPACING = 0.6

export function buildSanlengshanTunnelDesign(opt = {}) {
  const sec = SANLENGSHAN_SECTION
  const depth = Number(opt.holeDepth) || SANLENGSHAN_HOLE_DEPTH
  const Hw = sec.wallHeight
  const R = sec.archRadius
  const ITV = SANLENGSHAN_SEG_INTERVAL_MS
  const holes = []

  const push = h => {
    if (!_insideSection(h.posX, h.posY, sec, 0.35)) return
    holes.push(h)
  }

  // ── ① 中心空孔（提供自由面，段 1）─────────────
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
    id: 'SL-E'
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
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: i, // 掏槽孔内微差
        id: `SL-CU-${i + 1}-${side > 0 ? 'R' : 'L'}`
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
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: i,
        id: `SL-CL-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── ③ 扩槽/崩落层（段 3→5→7）──────────────
  for (let ri = 0; ri < RELIEF_LAYERS.length; ri++) {
    const [r, n, chg, seg] = RELIEF_LAYERS[ri]
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = _r1(Math.cos(a) * r)
      const y = _r1(Y_CUT + Math.sin(a) * r)
      const azi = _r1(Math.degrees(Math.atan2(Math.cos(a) * r, Math.sin(a) * r)))
      push({
        posX: x,
        posY: y,
        holeType: 'auxiliary',
        isEmptyHole: false,
        depth,
        inclinationAngle: 4,
        inclinationAzimuth: azi,
        chargeKg: chg,
        chargeLength: depth * 0.65,
        explosiveType: 'emulsion',
        detonatorSeries: seg,
        delayMs: (seg - 1) * ITV,
        id: `SL-R${ri + 1}-${i + 1}`
      })
    }
  }

  // ── ④ 周边光爆孔（文献：周边孔 MS11 / 拱顶孔 MS13 间隔装药，段11/13；底排段 9）──
  const R_arch = R - 0.25
  const archN = Math.max(16, Math.round((Math.PI * R_arch) / PERIM_SPACING))
  for (let i = 0; i < archN; i++) {
    const a = Math.PI * (i / (archN - 1))
    const x = Math.cos(a) * R_arch
    const y = Hw + Math.sin(a) * R_arch
    const azi = _r1(Math.degrees(Math.atan2(x, y - Hw)))
    // 拱顶段 (顶部 1/3 拱) 用段13，两侧拱用段11
    const seg = Math.abs(a - Math.PI / 2) < Math.PI / 6 ? 13 : 11
    // 间隔装药：装药长度取孔深 0.6，周边单眼药量偏低
    holes.push({
      posX: _r1(x),
      posY: _r1(y),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 3,
      inclinationAzimuth: azi,
      chargeKg: 0.5,
      chargeLength: depth * 0.6,
      explosiveType: 'emulsion',
      detonatorSeries: seg,
      delayMs: (seg - 1) * ITV,
      id: `SL-PA${Math.round(a * 100)}-${seg}`
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
        chargeLength: depth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: 11,
        delayMs: (11 - 1) * ITV,
        id: `SL-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }
  const floorN = 13
  const floorHalf = sec.width / 2 - 1.2
  for (let i = 0; i < floorN; i++) {
    holes.push({
      posX: _r1(((2 * i) / (floorN - 1) - 1) * floorHalf),
      posY: _r1(0.55),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: 1.8,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 9,
      delayMs: (9 - 1) * ITV,
      id: `SL-F${i + 1}`
    })
  }

  return { section: sec, holes }
}

function _insideSection(x, y, sec, margin) {
  if (y < 0) return false
  const halfW = sec.width / 2 - margin
  const Hw = sec.wallHeight
  const RR = sec.archRadius - margin
  if (y <= Hw) return Math.abs(x) <= halfW
  const dx = x
  const dy = y - Hw
  return dx * dx + dy * dy <= RR * RR
}

function _r1(v) {
  return Math.round(v * 10) / 10
}

if (typeof Math.degrees !== 'function') {
  Math.degrees = function degreesRad(rad) {
    return (rad * 180) / Math.PI
  }
}