/**
 * 南山隧道（大连市南山公路隧道）全断面爆破 —— 文献化布孔设计
 *
 * 数据来源：北京交通大学硕士论文《复杂环境下隧道钻爆施工降振试验研究及控制》
 *（汪亚飞）。南山隧道为双向六车道分离式公路隧道，洞身采用曲墙式复合衬砌。
 *  - 断面模型：开挖宽约 15.56m、开挖高约 10.23m、开挖面积约 142.6m²。
 *    取马蹄形：直墙高 2.45m + 拱部半径 7.78m → totalH=10.23m。
 *  - 掏槽：论文明确"采用垂直向楔形掏槽孔掏槽，掏槽孔沿隧道中心线两侧对称布置，
 *    掏槽孔与掌子面的夹角约[55~70]°"。下方据此布置**竖直向 V 形掏槽**（核心线在
 *    掌子面中下部，上、下排斜孔向核心线汇拢），段 1。
 *  - 扩槽/崩落：边墙与掏槽之间"每隔[一定间距]布置一排扩槽孔（每侧多排、与掌子面
 *    垂直）"，掏槽上方"布置一排水平崩落孔、两排弧形崩落孔"，用 3 环递增的扩槽/
 *    崩落层表达，段 3/5/7。
 *  - 周边光爆：周边孔沿掌子面最外层布置（拱顶、两侧边墙、底板），最小抵抗线 ~0.5m，
 *    段 11/13/15（拱顶 + 边墙 + 密集底排）。
 *  - 装药（表3-1）：掏槽单眼 2.4kg，扩槽/崩落 1.2~1.8kg，边墙 1.2kg，底板 1.95kg，
 *    拱顶 0.4kg；普通毫秒雷管按 1/3/5/7/11/13/15 段微差延时。
 *  - 回归公式（图5-1/5-2，掌子面前方地表振速）：V = 113.64·(Q^(1/3)/R)^1.341，
 *    即 K=113.64、α=1.341，R²=0.6125。
 *
 * 该设计用于平台 002 事件（BLAST-2026-002，南山），前端据此覆盖 DB 的通用菱形掏槽，
 * 使 3D 模型（隧道断面、炮孔布局、雷管段别）与文献标定一致。
 */

export const NANSHAN_SECTION = {
  width: 15.56, // 开挖宽度 (m)
  wallHeight: 2.45, // 直墙高 (m)
  archRadius: 7.78, // 拱部半径 (m)
  shape: 'horseshoe',
  totalHeight: 10.23 // 2.45 + 7.78
}

// 掏槽孔纵深 (m)
const HOLE_DEPTH = 3.0
// 垂直向楔形掏槽：核心线高度取断面下部（y=2.6，贴近底板、处于拱心 Hw=2.45 上方一点）。
// 文献布置图中掏槽区位于掌子面**中下部**、1段/3段斜孔先起爆，崩落/周边由它向上向
// 四周扇扩（而非以断面几何中心为锚的"同心圆靶"）。以底部掏槽为锚后，崩落环自然
// 向下被底板截断、向上逐渐展开，形成文献那种"底部掏槽+向上扇扩"的阶梯形态。
const Y_CUT = 2.6
// 掏槽孔：两排上下对称斜孔向核心线汇拢成 V。
// 每项 = [孔口横向展布 x(m), 距核心线竖向距离 Δy(m), 倾角°]；倾角保证孔底在
// 3.0m 深处向核心线汇拢（tanθ≈Δy/depth；内排 Δy=0.7→13°，外排 Δy=1.4→25°）。
//   - 上排孔 (y=Y_CUT+Δy)：方位角 -90°（向下向核心线），保持 x 不变；
//   - 下排孔 (y=Y_CUT-Δy)：方位角 +90°（向上向核心线）。
// 既非"±90° 右孔朝上/左孔朝下散开、又非沿洞轴向平移"，保证先起爆掏槽朝自由面破碎。
const WEDGE_ROWS = [
  [1.2, 0.7, 13],
  [1.8, 1.4, 25]
]
const WEDGE_CHARGE_KG = 2.4 // 掏槽单眼装药量 (kg)，表3-1

// 扩槽/崩落层：[半径 r(相对掏槽核心线 y=Y_CUT), 孔数, 单眼药量kg, 雷管段]
// 以底部掏槽为圆心向上展开（向下被底板截断），层间径向间隔约 1.8m；段 3/5/7
//（普通毫秒雷管）。
const RELIEF_LAYERS = [
  [2.8, 14, 1.8, 3],
  [4.6, 20, 1.5, 5],
  [6.4, 28, 1.3, 7]
]

// 周边最小抵抗线 / 光爆爆距（m）
const PERIM_SPACING = 0.6

/**
 * 生成南山隧道掌子面布孔（垂直向楔形掏槽 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致。
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export function buildNanshanTunnelDesign(opt = {}) {
  const sec = NANSHAN_SECTION
  const depth = Number(opt.holeDepth) || HOLE_DEPTH
  const Hw = sec.wallHeight
  const R = sec.archRadius
  const holes = []

  const push = h => {
    // 超过断面 -> 丢弃，保证不越界/不穿底
    if (!_insideSection(h.posX, h.posY, sec, 0.35)) return
    holes.push(h)
  }

  // ── ① 中心空孔（不装药，提供自由面，段 1 最先临空）───────────────
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
    id: 'NS-E'
  })

  // ── ② 垂直向楔形掏槽（上下两排 × 两侧 = 8 孔，对称，段 1）──────
  for (let i = 0; i < WEDGE_ROWS.length; i++) {
    const [dx, dy, inc] = WEDGE_ROWS[i]
    for (const side of [-1, 1]) {
      // 上排孔（y 高于核心线）：向下 -90° 向核心线俯冲
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
        delayMs: i, // 掏槽孔内微差（0/1ms），先临空再碎
        id: `NS-CU-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
      // 下排孔（y 低于核心线）：向上 +90° 向核心线抬升
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
        id: `NS-CL-${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── ③ 环形扩槽/崩落层（中心 y=Y_CUT，由内向外段 3→5→7）───────
  for (let ri = 0; ri < RELIEF_LAYERS.length; ri++) {
    const [r, n, chg, seg] = RELIEF_LAYERS[ri]
    const delayBase = [6, 16, 36][ri] // 段间隔微差（外层更晚）
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
        delayMs: delayBase + (i % n) * 2,
        id: `NS-R${ri + 1}-${i + 1}`
      })
    }
  }

  // ── ④ 周边光爆孔（贴开挖轮廓：拱顶 + 两侧边墙 + 密集底排）─────
  // 坐标天然落在轮廓内侧（光爆爆距），不经过 _insideSection 越界过滤。
  // 拱顶：最外圈光爆孔（段 15），按拱弧均布，间距 PERIM_SPACING
  const R_arch = R - 0.25 // 拱部孔落位在轮廓线内侧 0.25m（光爆距）
  const archN = Math.max(12, Math.round((Math.PI * R_arch) / PERIM_SPACING))
  for (let i = 0; i < archN; i++) {
    const a = Math.PI * (i / (archN - 1)) // π → 0，覆盖整拱
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
      chargeKg: 0.4,
      chargeLength: depth * 0.55,
      explosiveType: 'emulsion',
      detonatorSeries: 15,
      delayMs: 400 + 18,
      id: `NS-PA${i + 1}`
    })
  }
  // 边墙（两侧，段 15，平滑洞身）
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
        detonatorSeries: 15,
        delayMs: 400 + 15,
        id: `NS-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
      })
    }
  }
  // 底板：密集均布一排（段 13，帮助翻渣并最后形成平整底板）
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
      chargeKg: 1.95,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 13,
      delayMs: 300 + 12,
      id: `NS-F${i + 1}`
    })
  }

  return { section: sec, holes }
}

// 判断点 (x, y) 是否在马蹄形断面内（预留 margin，防止孔越洞周/穿底板）
function _insideSection(x, y, sec, margin) {
  if (y < 0) return false // 不越过底板（掌子面底部 y=0）
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

// 兼容浏览器无 Math.degrees（Node ≥20 有）
if (typeof Math.degrees !== 'function') {
  Math.degrees = function degreesRad(rad) {
    return (rad * 180) / Math.PI
  }
}
