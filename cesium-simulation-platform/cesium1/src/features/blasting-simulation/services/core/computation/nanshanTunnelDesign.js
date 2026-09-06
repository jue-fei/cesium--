/**
 * 南山隧道（大连市南山公路隧道）上台阶楔形掏槽微差爆破 —— 文献化设计参数
 *
 * 数据来源：北京交通大学硕士论文《复杂环境下隧道钻爆施工降振试验研究及控制》
 *（汪亚飞）。南山隧道为双向六车道分离式公路隧道，洞身采用曲墙式复合衬砌。
 *  - 断面模型：开挖宽约 15.56m、开挖高约 10.23m、开挖面积约 142.6m²。
 *    取马蹄形：直墙高 2.45m + 拱部半径 7.78m → totalH=10.23m。
 *  - 掏槽：垂直向楔形掏槽（孔口对称布于掌子面中部，斜孔向眼底楔状收敛），
 *    微差控制爆破以降振 + 周边光面爆破控轮廓。
 *  - 装药（表3-1）：掏槽孔单眼 2.4kg，扩槽/崩落孔 1.2~1.8kg，边墙 1.2kg，
 *    底板 1.95kg，拱顶 0.4kg；普通毫秒雷管逐段（1/3/5/7/11/13/15 段）微差延时。
 *  - 回归公式（图5-1/5-2，掌子面前方地表振速）：V = 113.64·(Q^(1/3)/R)^1.341，
 *    即 K=113.64、α=1.341，R²=0.6125。
 *
 * 布孔为对称、分级的标准上台阶楔形掏槽系统：
 *   中心空孔 1 + 楔形掏槽 6 + 扩槽/崩落 3 环（r=3.2/5.2/7.2，共 30）
 *   + 拱部光爆点 ~48 + 边墙 4 + 底板 5  ≈ 94 眼。
 *
 * 该设计用于平台"楔形掏槽"事件（cutPattern==='wedge'，即 BLAST-2026-002）：
 * 前端据此覆盖 DB 的通用菱形掏槽，使 3D 模型（隧道断面、炮孔布局）与文献标定
 * 一致，同时为多源应力波叠加提供空间铺开、时序错开的装药源，使应力场呈
 * 多源矢量叠加干涉而非单一同心圆。
 */

export const NANSHAN_SECTION = {
  width: 15.56, // 开挖宽度 (m)
  wallHeight: 2.45, // 直墙高 (m)
  archRadius: 7.78, // 拱部半径 (m)
  shape: 'horseshoe',
  totalHeight: 10.23 // 2.45 + 7.78
}

// 掏槽孔纵深
const HOLE_DEPTH = 3.0
// 楔形掏槽：三对孔口横向展布（m），由内到外对称
const WEDGE_X = [1.1, 1.9, 2.7]
// 掏槽孔口在掌子面中的竖向位置（相对断面中心下移 0.3，向眼底楔状收敛）
const WEDGE_Y = 5.115 - 0.3
// 掏槽孔单眼装药量（kg）：表3-1 掏槽孔单眼 2.4kg
const WEDGE_CHARGE_KG = [2.4, 2.4, 2.4]
// 掏槽孔向核心收敛角（°）：由内到外递陡
const WEDGE_INCLIN = [55, 62, 68]
// 向里空孔/掏槽间不设崩落；扩槽崩落 3 环 [半径, 孔数, 单眼药量kg, 延时ms]
//（半径受断面竖向限制：中心 cy0=5.115，环底不得越过底板 y≈0，故最大约 5.0）
const AUX_RINGS = [
  [2.6, 8, 1.8, 100],
  [3.8, 10, 1.5, 200],
  [5.0, 12, 1.3, 300]
]
// 拱部光爆点间距 (m)
const PERIM_SPACING = 0.5

/**
 * 生成南山隧道掌子面布孔（楔形掏槽 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致，
 * 可直接注入 SceneBuilder.setBlastHoleDesign 与 blastingManager._computeBlastSources。
 *
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export function buildNanshanTunnelDesign(opt = {}) {
  const sec = NANSHAN_SECTION
  const depth = Number(opt.holeDepth) || HOLE_DEPTH
  const Hw = sec.wallHeight
  const cy0 = sec.totalHeight * 0.5
  const holes = []

  // 弹型序号（用于雷管段别可视化）
  let series = 0

  const push = h => {
    // 超过断面 -> 丢弃，保证不越界/不穿底
    if (!_insideSection(h.posX, h.posY, sec, 0.5)) return
    holes.push(h)
  }

  // ── 0. 中心空孔（不装药，提供自由面）──────────────────────────
  series++
  holes.push({
    posX: 0,
    posY: _r1(WEDGE_Y),
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

  // ── 1. 楔形掏槽孔（6 孔，左右对称，单眼 2.4kg，段 1）───────────
  for (let i = 0; i < WEDGE_X.length; i++) {
    for (const side of [-1, 1]) {
      series++
      push({
        posX: side * WEDGE_X[i],
        posY: _r1(WEDGE_Y),
        holeType: 'cut',
        isEmptyHole: false,
        depth,
        inclinationAngle: WEDGE_INCLIN[i],
        inclinationAzimuth: side > 0 ? 90 : -90, // 朝掏槽核心收敛
        chargeKg: WEDGE_CHARGE_KG[i],
        chargeLength: depth * 0.7,
        explosiveType: 'emulsion',
        detonatorSeries: 1,
        delayMs: 0,
        id: `NS-W${i + 1}-${side > 0 ? 'R' : 'L'}`
      })
    }
  }

  // ── 2. 环形扩槽/崩落孔（随半径递增延时、装药递减）─────────────
  for (let ri = 0; ri < AUX_RINGS.length; ri++) {
    const [r, n, chg, delay] = AUX_RINGS[ri]
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      series = (series % 20) + 1
      push({
        posX: _r1(Math.cos(a) * r),
        posY: _r1(cy0 + Math.sin(a) * r),
        holeType: 'auxiliary',
        isEmptyHole: false,
        depth,
        inclinationAngle: 5,
        inclinationAzimuth: 0,
        chargeKg: chg,
        chargeLength: depth * 0.65,
        explosiveType: 'emulsion',
        detonatorSeries: series,
        delayMs: delay + ((series - 1) % 6) * 5,
        id: `NS-A${ri + 1}-${i + 1}`
      })
    }
  }

  // ── 3. 周边光爆孔（拱部 + 边墙 + 底板，半孔率 0.75）───────────
  // 周边孔务必贴合开挖轮廓线内侧（光爆），坐标按轮廓计算，天然在断面内、
  // 无需过 _insideSection 越界过滤（否则会被贴线判定误丢）。
  const R_arch = sec.archRadius - 0.2 // 拱部孔落位在轮廓线内侧 0.2m（光爆爆距）
  const archN = Math.max(10, Math.round((Math.PI * R_arch) / PERIM_SPACING))
  for (let i = 0; i < archN; i++) {
    const a = Math.PI * (i / (archN - 1)) // π → 0，覆盖整拱
    const x = Math.cos(a) * R_arch
    const y = Hw + Math.sin(a) * R_arch
    const azi = _r1(Math.degrees(Math.atan2(x, y - Hw)))
    series = (series % 20) + 1
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
      delayMs: 650,
      id: `NS-PA${i + 1}`
    })
  }
  // 边墙（两侧，平滑洞身）
  const wallX = sec.width / 2 - 0.3
  for (const side of [-1, 1]) {
    for (const wyR of [0.4, 0.75]) {
      series = (series % 20) + 1
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
        delayMs: 600,
        id: `NS-PW${side > 0 ? 'R' : 'L'}${wyR === 0.4 ? 'U' : 'L'}`
      })
    }
  }
  // 底板（5 孔沿底板均布，帮助翻渣）
  const floorN = 5
  for (let i = 0; i < floorN; i++) {
    series = (series % 20) + 1
    holes.push({
      posX: _r1(((2 * i) / (floorN - 1) - 1) * (sec.width / 2 - 1.0)),
      posY: _r1(0.5),
      holeType: 'perimeter',
      isEmptyHole: false,
      depth,
      inclinationAngle: 6,
      inclinationAzimuth: 0,
      chargeKg: 1.95,
      chargeLength: depth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: 11,
      delayMs: 500,
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
