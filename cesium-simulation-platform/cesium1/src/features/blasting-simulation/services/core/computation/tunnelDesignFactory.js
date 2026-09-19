/**
 * 隧道布孔设计工厂 —— 垂直楔形掏槽全断面布孔骨架（参数化实现）。
 *
 * 骨架与 nanshan / dabalai / sanlengshan / yuyang 四份文献化设计完全同构：
 *   ① 中心空孔（可选）：不装药，段 1 最先临空，为掏槽提供自由面；
 *   ② 垂直向楔形掏槽：上/下排斜孔向核心线汇拢成 V（上排方位角 -90°、下排 +90°），段 1；
 *   ③ 环形扩槽/崩落层：以掏槽核心线为圆心由内向外展开，段 3/5/7…；
 *   ④ 周边光爆孔：拱顶（沿拱弧均布）+ 两侧边墙 + 密集底排（坐标不经过越界过滤）。
 * 各隧道差异全部由 config 参数表表达（断面尺寸、掏槽排布、环层参数、周边孔参数、延时）。
 * 炮孔对象键序与原实现一致（posX→posY→holeType→…→id），保证输出与重构前逐字节相同。
 *
 * 结构不同构、不并入本工厂的隧道（保留各自独立实现）：
 *  - kunyang：水平楔形掏槽（方位角 0/180）+ 辅助眼逐孔变段 + 固定角度周边布点；
 *  - fengyin：双楔形两级掏槽（不同药量/段别/延时）+ 固定坐标底眼；
 *  - dongwujun：台阶法按全断面呈现，掏槽 2.2m / 其余 2.0m 孔深不统一，
 *    装药长度按固定 2.0m×系数（不随孔深变化）。
 */
import { round1, toDegrees } from './designUtils.js'
import { isInsideSection } from './sectionShape.js'

/**
 * 创建某隧道的掌子面布孔构建函数。
 *
 * @param {Object} config 隧道布孔参数表：
 *  - section           断面轮廓 { width, wallHeight, archRadius, shape, totalHeight }
 *  - idPrefix          炮孔编号前缀（如 'NS'）
 *  - holeDepth         默认孔深 (m)，可被调用方 opt.holeDepth 覆写
 *  - margin            掏槽/扩槽孔的断面内缩余量 (m)（防越界/穿底）
 *  - explosiveType     炸药类型
 *  - yCut              掏槽核心线高度 (m)（掌子面中下部）
 *  - emptyHoleId       中心空孔编号；null 表示该方案无空孔
 *  - seriesIntervalMs  段间延时间隔 (ms)（relief.delayMode / archDelayMs 为 'series' 时使用）
 *  - wedge             楔形掏槽参数：rows=[dx,Δy,倾角]、chargeKg、chargeLengthFactor、
 *                      rowDelays（排间微差 ms）、idStyle（'indexed' | 'spacing'）
 *  - relief            扩槽/崩落环参数：layers=[半径,孔数,药量,段]、chargeLengthFactor、
 *                      delayMode（'layerBase'：层基准+孔序×2ms | 'series'：(段-1)×间隔）、
 *                      layerDelayBases（'layerBase' 模式的各层延时基准）
 *  - perimeter         周边光爆参数：拱顶（archInset/archMinN/spacing/archSegment/
 *                      archDelayMs/药量/装药系数，archSegment 与 archDelayMs 可为
 *                      'series' 或函数）、边墙（wallOffsetX/wallRatios/…）、底板
 *                      （floorCount/floorHalfInset/floorY/…）
 * @returns {(opt?: { holeDepth?: number }) => { section: Object, holes: Array<Object> }}
 *          返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致
 */
export function createWedgeCutDesign(config) {
  return function buildWedgeCutDesign(opt = {}) {
    const sec = config.section
    const depth = Number(opt.holeDepth) || config.holeDepth
    const Hw = sec.wallHeight
    const R = sec.archRadius
    const prefix = config.idPrefix
    const holes = []

    const push = h => {
      // 超过断面 -> 丢弃，保证不越界/不穿底
      if (!isInsideSection(sec, h.posX, h.posY, config.margin)) return
      holes.push(h)
    }

    // ── ① 中心空孔（不装药，提供自由面，段 1 最先临空）───────────────
    if (config.emptyHoleId) {
      push({
        posX: 0,
        posY: round1(config.yCut),
        holeType: 'cut',
        isEmptyHole: true,
        depth,
        inclinationAngle: 0,
        inclinationAzimuth: 0,
        chargeKg: 0,
        chargeLength: 0,
        explosiveType: config.explosiveType,
        detonatorSeries: 1,
        delayMs: 0,
        id: config.emptyHoleId
      })
    }

    // ── ② 垂直向楔形掏槽（上下两排 × 两侧斜孔向核心线汇拢成 V，段 1）──
    // 编号风格：'indexed' 为 <排号>-<R|L>（如 NS-CU-1-R）；
    //           'spacing' 为 <R|L><孔口展布×10>（如 DB-CU-R4）。
    config.wedge.rows.forEach(([dx, dy, inc], i) => {
      for (const side of [-1, 1]) {
        const tag =
          config.wedge.idStyle === 'spacing'
            ? `${side > 0 ? 'R' : 'L'}${Math.round(dx * 10)}`
            : `${i + 1}-${side > 0 ? 'R' : 'L'}`
        // 上排孔（y 高于核心线）：向下 -90° 向核心线俯冲
        push({
          posX: round1(side * dx),
          posY: round1(config.yCut + dy),
          holeType: 'cut',
          isEmptyHole: false,
          depth,
          inclinationAngle: inc,
          inclinationAzimuth: -90,
          chargeKg: config.wedge.chargeKg,
          chargeLength: depth * config.wedge.chargeLengthFactor,
          explosiveType: config.explosiveType,
          detonatorSeries: 1,
          delayMs: config.wedge.rowDelays[i], // 掏槽排间微差，先临空再碎
          id: `${prefix}-CU-${tag}`
        })
        // 下排孔（y 低于核心线）：向上 +90° 向核心线抬升
        push({
          posX: round1(side * dx),
          posY: round1(config.yCut - dy),
          holeType: 'cut',
          isEmptyHole: false,
          depth,
          inclinationAngle: inc,
          inclinationAzimuth: 90,
          chargeKg: config.wedge.chargeKg,
          chargeLength: depth * config.wedge.chargeLengthFactor,
          explosiveType: config.explosiveType,
          detonatorSeries: 1,
          delayMs: config.wedge.rowDelays[i],
          id: `${prefix}-CL-${tag}`
        })
      }
    })

    // ── ③ 环形扩槽/崩落层（中心 y=yCut，由内向外逐环起爆）───────────
    config.relief.layers.forEach(([r, n, chg, seg], ri) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = round1(Math.cos(a) * r)
        const y = round1(config.yCut + Math.sin(a) * r)
        const azi = round1(toDegrees(Math.atan2(Math.cos(a) * r, Math.sin(a) * r)))
        push({
          posX: x,
          posY: y,
          holeType: 'auxiliary',
          isEmptyHole: false,
          depth,
          inclinationAngle: 4,
          inclinationAzimuth: azi,
          chargeKg: chg,
          chargeLength: depth * config.relief.chargeLengthFactor,
          explosiveType: config.explosiveType,
          detonatorSeries: seg,
          delayMs:
            config.relief.delayMode === 'series'
              ? (seg - 1) * config.seriesIntervalMs
              : config.relief.layerDelayBases[ri] + (i % n) * 2,
          id: `${prefix}-R${ri + 1}-${i + 1}`
        })
      }
    })

    // ── ④ 周边光爆孔（贴开挖轮廓：拱顶 + 两侧边墙 + 密集底排）─────
    // 坐标天然落在轮廓内侧（光爆爆距），不经过越界过滤。
    const P = config.perimeter
    // 拱顶：沿拱弧均布，孔数由光爆爆距换算（不少于 archMinN）
    const R_arch = R - P.archInset
    const archN = Math.max(P.archMinN, Math.round((Math.PI * R_arch) / P.spacing))
    const archSegOf = typeof P.archSegment === 'function' ? P.archSegment : () => P.archSegment
    for (let i = 0; i < archN; i++) {
      const a = Math.PI * (i / (archN - 1)) // π → 0，覆盖整拱
      const x = Math.cos(a) * R_arch
      const y = Hw + Math.sin(a) * R_arch
      const azi = round1(toDegrees(Math.atan2(x, y - Hw)))
      const seg = archSegOf(a)
      const delayMs =
        P.archDelayMs === 'series' ? (seg - 1) * config.seriesIntervalMs : P.archDelayMs
      const id =
        P.archIdStyle === 'angleSeg'
          ? `${prefix}-PA${Math.round(a * 100)}-${seg}`
          : `${prefix}-PA${i + 1}`
      holes.push({
        posX: round1(x),
        posY: round1(y),
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 3,
        inclinationAzimuth: azi,
        chargeKg: P.archChargeKg,
        chargeLength: depth * P.archChargeLengthFactor,
        explosiveType: config.explosiveType,
        detonatorSeries: seg,
        delayMs,
        id
      })
    }
    // 边墙（两侧直墙，按高度比例布点）
    const wallX = sec.width / 2 - P.wallOffsetX
    for (const side of [-1, 1]) {
      for (const wyR of P.wallRatios) {
        holes.push({
          posX: side * wallX,
          posY: round1(Hw * wyR),
          holeType: 'perimeter',
          isEmptyHole: false,
          depth,
          inclinationAngle: 3,
          inclinationAzimuth: side > 0 ? 90 : -90,
          chargeKg: P.wallChargeKg,
          chargeLength: depth * P.wallChargeLengthFactor,
          explosiveType: config.explosiveType,
          detonatorSeries: P.wallSegment,
          delayMs: P.wallDelayMs,
          id: `${prefix}-PW${side > 0 ? 'R' : 'L'}${Math.round(wyR * 100)}`
        })
      }
    }
    // 底板：密集均布一排（帮助翻渣并最后形成平整底板）
    const floorN = P.floorCount
    const floorHalf = sec.width / 2 - P.floorHalfInset
    for (let i = 0; i < floorN; i++) {
      holes.push({
        posX: round1(((2 * i) / (floorN - 1) - 1) * floorHalf),
        posY: round1(P.floorY),
        holeType: 'perimeter',
        isEmptyHole: false,
        depth,
        inclinationAngle: 6,
        inclinationAzimuth: 0,
        chargeKg: P.floorChargeKg,
        chargeLength: depth * P.floorChargeLengthFactor,
        explosiveType: config.explosiveType,
        detonatorSeries: P.floorSegment,
        delayMs: P.floorDelayMs,
        id: `${prefix}-F${i + 1}`
      })
    }

    return { section: sec, holes }
  }
}
