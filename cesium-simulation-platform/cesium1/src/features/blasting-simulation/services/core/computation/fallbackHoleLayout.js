/**
 * 回退布孔设计数据生成（纯计算，无渲染依赖）
 *
 * 未接入数据库炮孔设计时的硬编码典型布孔：菱形/楔形/螺旋掏槽 + 辅助圈 + 周边孔，
 * 含单孔药量计算与越界过滤（isInsideSection）。从 sceneBuilder._collectFallbackHoles
 * 原样迁移：布孔算法/注释逐行保持，仅把调用侧读取的 this.designParams/this.kcoParams/
 * this.tunnelHeight 改为纯函数入参。
 */
import { isInsideSection } from './sectionShape.js'

// ─── 回退模式：硬编码典型布孔（菱形掏槽 + 辅助 + 周边）
export function buildFallbackHoles({ W, Hw, R, totalH, cy0, designParams, kcoParams }) {
  // ─ 参数化：B/S/q/cutPattern 从 designParams/kcoParams 读取 ─
  const B = Math.max(0.3, Number(designParams?.burden) || Number(kcoParams?.B) || 1.5)
  const S = Math.max(0.3, Number(designParams?.spacing) || Number(kcoParams?.S) || 2.0)
  const q = Math.max(0.05, Number(kcoParams?.q) || 0.8)
  const cutPattern = designParams?.cutPattern || 'wedge'
  const holeDepth = Math.max(0.5, Number(designParams?.holeDepth) || 2.5)
  const realDia = Number(designParams?.holeDiameter) || 0.04
  const visRadius = Math.max(0.025, realDia * 1.2) // 与 _collectDesignHoles 一致：按真实孔径细钉
  const emptyVisRadius = visRadius * 1.3

  // 单孔药量 = q × B × S × holeDepth × 孔型系数
  const chargeKg = factor => q * B * S * holeDepth * factor

  const holes = []
  let series = 1
  const nextSeries = () => {
    series = (series % 20) + 1
    return series
  }

  // ─ 1. 掏槽孔（按 cutPattern 分发） ─
  const cutR = B * 0.6 // 抵抗线驱动，替代硬编码 1.0
  // 中心空孔（所有掏槽形式共用）
  holes.push({
    x: 0,
    y: cy0,
    type: 'cut',
    isEmpty: true,
    depth: holeDepth,
    visRadius: emptyVisRadius,
    inclination: 0,
    azimuth: 0,
    chargeKg: 0,
    chargeLength: 0,
    explosiveType: 'emulsion',
    detonatorSeries: 1,
    delayMs: 0,
    id: 'CUT-EMPTY'
  })

  if (cutPattern === 'spiral') {
    // 螺旋掏槽：4 孔螺旋递进，半径从 B×0.4 到 B×0.7
    const spiralSteps = 4
    for (let i = 0; i < spiralSteps; i++) {
      const r = B * (0.4 + 0.1 * i)
      const a = (i / spiralSteps) * Math.PI * 2
      holes.push({
        x: Math.cos(a) * r,
        y: cy0 + Math.sin(a) * r,
        type: 'cut',
        isEmpty: false,
        depth: holeDepth,
        visRadius,
        inclination: 0,
        azimuth: 0,
        chargeKg: chargeKg(1.2),
        chargeLength: holeDepth * 0.8,
        explosiveType: 'emulsion',
        detonatorSeries: nextSeries(),
        delayMs: 50 * (i + 1),
        id: `CUT-S${i + 1}`
      })
    }
  } else if (cutPattern === 'wedge') {
    // 楔形掏槽（Da Balai 文献模式）：2~3 排斜孔 V 形开口，角度 70→60°
    // 掏槽孔分"初始(primary) + 辅助(secondary)"两批，消除耦合延时 Δt（文献最优 4~8ms，
    // 现场取 Δt=4ms），且**初始掏槽孔减量装药**（微差延迟爆破减振机理的核心）：
    //   primary 减量 0.7× 先起爆 → 生成初始爆破自由面；
    //   secondary 1.0× 延时 Δt 后起爆 → 朝自由面充分破碎、降低围岩约束。
    // 各孔日期延时而分布在 0~Δt 内（2ms 步进），使掏出孔组应力波在孔底汇拢处
    // 相长干涉、错相位处相消 → 应力场呈多源干涉斑块，而非单一同心圆。
    const wedgeN = 3
    // 延时方案：孔内微差按 [0, 2, 4] ms 递进（secondary 落在文献最优延时窗 4ms）
    const wedgeCutDelayMs = [0, 2, 4]
    // 装药系数：初始孔减量(0.7×未爆抛)，随批次接近完整(1.0×)
    const wedgeChargeFactor = [0.7, 0.85, 1.0]
    for (let i = 0; i < wedgeN; i++) {
      const offset = B * (0.5 + 0.15 * i)
      for (const side of [-1, 1]) {
        holes.push({
          x: side * offset,
          y: cy0,
          type: 'cut',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          // 倾角 = 偏离孔轴法向(垂直掌子面)的小角，使孔底在洞深处向隧洞中心汇拢：
          //   之前用 70°~74° 接近平行掌子面，孔底竖向偏移过大导致装药"出掌子面"。
          //   改为按 offset/depth 换算的向心角（首排更陡向核心）。
          inclination: i === 0 ? 18 : [17, 21, 26][i],
          // 方位：右孔朝 -x、左孔朝 +x 内倾，形成 V 形楔形掏槽；勿用 ±90（右孔朝上/左孔朝下散开）。
          azimuth: side > 0 ? 180 : 0,
          chargeKg: chargeKg(wedgeChargeFactor[i] * 1.2),
          chargeLength: holeDepth * 0.8,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: wedgeCutDelayMs[i],
          id: `CUT-W${i + 1}-${side > 0 ? 'R' : 'L'}`
        })
      }
    }
  } else {
    // 菱形掏槽（默认）：4 孔 + 1 空孔
    const cutPos = [
      [cutR, cy0],
      [-cutR, cy0],
      [0, cy0 + cutR],
      [0, cy0 - cutR]
    ]
    cutPos.forEach((p, i) => {
      holes.push({
        x: p[0],
        y: p[1],
        type: 'cut',
        isEmpty: false,
        depth: holeDepth,
        visRadius,
        inclination: 0,
        azimuth: 0,
        chargeKg: chargeKg(1.2),
        chargeLength: holeDepth * 0.8,
        explosiveType: 'emulsion',
        detonatorSeries: nextSeries(),
        delayMs: 100 * (i + 2),
        id: `CUT-${i + 1}`
      })
    })
  }

  // ─ 2. 辅助孔（圈数/半径/孔数由 B/S/断面驱动） ─
  const cutZone = 2 * cutR
  const maxR = Math.min(W, totalH) * 0.45
  const ringCount = Math.max(1, Math.ceil((maxR - cutZone) / (2 * B)))
  for (let ring = 1; ring <= ringCount; ring++) {
    const r = cutZone + 2 * B * ring
    if (r > maxR) break
    const n = Math.max(6, Math.floor((2 * Math.PI * r) / S))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.cos(a) * r
      const y = cy0 + Math.sin(a) * r
      if (_isInsideTunnelSection(x, y, W, Hw, R)) {
        holes.push({
          x,
          y,
          type: 'auxiliary',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 0,
          azimuth: 0,
          chargeKg: chargeKg(1.0),
          chargeLength: holeDepth * 0.7,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: series * 100,
          id: `AUX-${ring}-${i}`
        })
      }
    }
  }
  // ─ 3. 周边孔（间距 = 0.8 × S，光面爆破经验） ─
  const perimSpacing =
    Number(designParams?.perimeterSpacing) > 0 ? Number(designParams.perimeterSpacing) : 0.8 * S
  let perimSeries = series
  for (let y = 1.0; y <= Hw - 0.3; y += perimSpacing) {
    for (const x of [-W / 2 + 0.35, W / 2 - 0.35]) {
      holes.push({
        x,
        y,
        type: 'perimeter',
        isEmpty: false,
        depth: holeDepth,
        visRadius,
        inclination: 3,
        azimuth: x > 0 ? 90 : -90,
        chargeKg: chargeKg(0.5),
        chargeLength: holeDepth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: perimSeries,
        delayMs: perimSeries * 100,
        id: `PER-W-${perimSeries}`
      })
      perimSeries = (perimSeries % 20) + 1
    }
  }
  const archN = Math.max(8, Math.floor((Math.PI * R) / perimSpacing))
  for (let i = 1; i < archN; i++) {
    const a = Math.PI - (i / archN) * Math.PI
    const x = Math.cos(a) * R
    const y = Hw + Math.sin(a) * R
    holes.push({
      x,
      y,
      type: 'perimeter',
      isEmpty: false,
      depth: holeDepth,
      visRadius,
      inclination: 3,
      azimuth: (Math.atan2(x, y - Hw) * 180) / Math.PI,
      chargeKg: chargeKg(0.5),
      chargeLength: holeDepth * 0.6,
      explosiveType: 'emulsion',
      detonatorSeries: perimSeries,
      delayMs: perimSeries * 100,
      id: `PER-A-${perimSeries}`
    })
    perimSeries = (perimSeries % 20) + 1
  }
  holes.push({
    x: -W / 2 + 0.4,
    y: 0.5,
    type: 'perimeter',
    isEmpty: false,
    depth: holeDepth,
    visRadius,
    inclination: 5,
    azimuth: -90,
    chargeKg: chargeKg(0.5),
    chargeLength: holeDepth * 0.7,
    explosiveType: 'emulsion',
    detonatorSeries: perimSeries,
    delayMs: perimSeries * 100,
    id: 'PER-BL'
  })
  holes.push({
    x: W / 2 - 0.4,
    y: 0.5,
    type: 'perimeter',
    isEmpty: false,
    depth: holeDepth,
    visRadius,
    inclination: 5,
    azimuth: 90,
    chargeKg: chargeKg(0.5),
    chargeLength: holeDepth * 0.7,
    explosiveType: 'emulsion',
    detonatorSeries: perimSeries,
    delayMs: perimSeries * 100,
    id: 'PER-BR'
  })
  return holes
}

// ─── 断面内判断 ──────────────────────────────────────
// 原 sceneBuilder._isInsideTunnelSection：仅被回退布孔消费，随布孔算法一并迁移至此。
function _isInsideTunnelSection(x, y, W, Hw, R) {
  return isInsideSection({ width: W, wallHeight: Hw, archRadius: R }, x, y, 0.2)
}
