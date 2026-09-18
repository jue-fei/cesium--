/**
 * 达巴莱隧道（Da Balai Tunnel）楔形掏槽精密延时爆破 —— 文献化布孔设计
 *
 * 数据来源：Hu Y, Yang R, Zuo J 等 "Study on the Characteristics and Parameter
 * Optimization of Wedge Cut Delayed Blasting in a Tunnel", Eng 2026, 7, 161.
 *  https://doi.org/10.3390/eng7040161
 *
 * 工程背景（现场应用章 5.1）：
 *  - Da Balai 隧道位于浙江遂昌县新路湾镇，最大埋深约 25m，洞口直线距离 20m 处有桥梁
 *    施工场地；区域岩性为中等风化石灰岩，节理裂隙较发育、岩体破碎。
 *  - 采用电子雷管精密延时楔形掏槽：掏槽孔分为初始组与次生组，用电子雷管精确控制
 *    段间延时，最优延时范围 4~8ms（现场采用 Δt=4ms）。
 *  - 现场各 10 次常规/延时爆破对比：平均拉槽效率 77.8%→97.3%（+19.5%），大块率
 *    30.6%→11.4%（-19.2%），PPV 11.8→5.6 cm/s（-52.5%），主频 34.1→66.5Hz（+48.7%）。
 *
 * 断面尺寸：文献未给出隧道开挖断面，按"浅埋小断面/近桥临建"工程背景取合理马蹄形估算
 * （以下游公路隧道小断面量级）：宽 9.0m、直墙高 2.5m、拱部半径 4.5m、总高 7.0m。
 *
 * 萨道夫斯基 K/α：文献未做该隧道的 K/α 回归，取中等风化石灰岩典型量级 K=150、α=1.7
 * 作为估算基线（可与 UI 面板按实测值覆盖）。
 *
 * 渲染注释：渲染器仅支持 horseshoe/circular/rectangular，此处 ob 用 9.0×7.0m 马蹄形断面
 * 表达。段间隔压缩为 75ms（与 006 昆阳一致），保证抛掷在时间上交叠成连续过程；底层真实
 * 段别为电子雷管毫秒延时的初始/次生掏槽分组，顺序与原案一致。
 */
export const DABALAI_SECTION = {
  width: 9.0, // 开挖断面宽（m，估算）
  wallHeight: 2.5, // 直墙高（m）
  archRadius: 4.5, // 拱部半径（m）≈ 宽/2
  shape: 'horseshoe',
  totalHeight: 7.0 // 2.5 + 4.5
}

export const DABALAI_HOLE_DEPTH = 3.0
export const DABALAI_UTILIZATION = 0.85
// 段间隔(ms)：与昆阳一致压缩到真实毫秒级量级，使抛掷连续；掏槽孔内微差用 4ms（对应文献电子雷管）
export const DABALAI_SEG_INTERVAL_MS = 75

// 掏槽核心线高度（掌子面中下部）
const Y_CUT = 1.8
// 楔形掏槽：每排为上下两孔对称斜孔向核心线汇拢成 V 形，[孔口横向展布, 距核心线竖向Δy, 倾角°]
// 初始组=内排(delay 0)，次生组=外排(delay 4ms，电子雷管分段)；2 排×2 侧×上下=8 孔
const WEDGE_ROWS = [
  [0.4, 0.5, 9], // 内排（初始组）
  [1.2, 1.3, 25] // 外排（次生组）
]
const WEDGE_CHARGE_KG = 2.4

// 扩槽/崩落层：[半径(相对核心线), 孔数, 单眼药量kg, 雷管段]（段 3/5 由内向外）
const RELIEF_LAYERS = [
  [2.4, 12, 1.8, 3],
  [3.6, 16, 1.5, 5]
]

// 周边最小抵抗线 / 光爆爆距（m）
const PERIM_SPACING = 0.6

export function buildDabalaiTunnelDesign(opt = {}) {
  const sec = DABALAI_SECTION
  const depth = Number(opt.holeDepth) || DABALAI_HOLE_DEPTH
  const Hw = sec.wallHeight
  const R = sec.archRadius
  const ITV = DABALAI_SEG_INTERVAL_MS
  const holes = []

  const push = h => {
    if (!_insideSection(h.posX, h.posY, sec, 0.3)) return
    holes.push(h)
    return h
  }

  // ── ① 楔形掏槽（初始组 4 + 次生组 4 = 8，段 1，掏槽内微差 4ms）────
  const wedgePush = (row, delayMs) => {
    for (const side of [-1, 1]) {
      push({
        posX: _r1(side * row[0]),
        posY: _r1(Y_CUT + row[1]),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: row[2],
        inclinationAzimuth: -90,
        chargeKg: WEDGE_CHARGE_KG,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs,
        id: `DB-CU-${side > 0 ? 'R' : 'L'}${Math.round(row[0] * 10)}`
      })
      push({
        posX: _r1(side * row[0]),
        posY: _r1(Y_CUT - row[1]),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: row[2],
        inclinationAzimuth: 90,
        chargeKg: WEDGE_CHARGE_KG,
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs,
        id: `DB-CL-${side > 0 ? 'R' : 'L'}${Math.round(row[0] * 10)}`
      })
    }
  }
  wedgePush(WEDGE_ROWS[0], 0) // 内排初始组
  wedgePush(WEDGE_ROWS[1], 4) // 外排次生组（电子雷管 4ms）

  // ── ② 扩槽/崩落层（段 3→5）─────────────────────
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
        id: `DB-R${ri + 1}-${i + 1}`
      })
    }
  }

  // ── ③ 周边光爆孔（拱顶 段9 + 边墙 段7 + 底排 段7）────────
  const R_arch = R - 0.25
  const archN = Math.max(10, Math.round((Math.PI * R_arch) / PERIM_SPACING))
  for (let i = 0; i < archN; i++) {
    const a = Math.PI * (i / (archN - 1))
    const x = Math.cos(a) * R_arch
    const y = Hw + Math.sin(a) * R_arch
    const azi = _r1(Math.degrees(Math.atan2(x, y - Hw)))
    holes.push({
      posX: _r1(x),
      posY: _r1(y),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 3,
      inclinationAzimuth: azi,
      chargeKg: 0.6,
      chargeLength: depth * 0.6,
      explosiveType: 'emulsion',
      detonatorSeries: 9,
      delayMs: (9 - 1) * ITV,
      id: `DB-PA${i + 1}`
    })
  }
  const wallX = sec.width / 2 - 0.3
  for (const side of [-1, 1]) {
    for (const wyR of [0.35, 0.7]) {
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
        detonatorSeries: 7,
        delayMs: (7 - 1) * ITV,
        id: `DB-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }
  const floorN = 9
  const floorHalf = sec.width / 2 - 1.0
  for (let i = 0; i < floorN; i++) {
    holes.push({
      posX: _r1(((2 * i) / (floorN - 1) - 1) * floorHalf),
      posY: _r1(0.5),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: 1.8,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 7,
      delayMs: (7 - 1) * ITV,
      id: `DB-F${i + 1}`
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
