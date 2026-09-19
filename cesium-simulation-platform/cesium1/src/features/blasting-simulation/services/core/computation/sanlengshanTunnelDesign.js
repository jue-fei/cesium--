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
 *
 * 布孔骨架（空孔 → 垂直楔形掏槽 → 环形扩槽/崩落 → 周边光爆）与
 * nanshan / dabalai / yuyang 同构，统一由 tunnelDesignFactory 参数化实现。
 */
import { createWedgeCutDesign } from './tunnelDesignFactory.js'

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

// 三棱山隧道布孔参数表（喂给 createWedgeCutDesign）
const SANLENGSHAN_CONFIG = {
  section: SANLENGSHAN_SECTION, // 马蹄形断面：宽 13.5m × 总高 10.25m（估算）
  idPrefix: 'SL', // 炮孔编号前缀
  holeDepth: SANLENGSHAN_HOLE_DEPTH, // 钻孔深度 3.0m（文献 2.2）
  margin: 0.35, // 布孔断面内缩余量 (m)
  explosiveType: 'emulsion', // 2 号岩石乳化炸药
  yCut: 2.6, // 掏槽核心线高度（掌子面中下）
  emptyHoleId: 'SL-E', // 中心空孔编号（提供自由面，段 1）
  seriesIntervalMs: SANLENGSHAN_SEG_INTERVAL_MS, // 段间延时 (ms)：延时 = (段号-1) × 75ms
  wedge: {
    // 楔形掏槽（段 1，掏槽孔内微差 0/1ms）：
    // [孔口横向展布 x(m), 距核心线竖向距离 Δy(m), 倾角°]
    rows: [
      [0.8, 0.7, 13],
      [1.4, 1.4, 25]
    ],
    chargeKg: 2.4, // 掏槽单眼装药量 (kg)
    chargeLengthFactor: 0.7, // 装药长度 = 孔深 × 0.7
    rowDelays: [0, 1], // 掏槽排间微差 (ms)
    idStyle: 'indexed' // 编号：SL-CU-<排号>-<R|L>
  },
  relief: {
    // 扩槽/崩落层：[半径, 孔数, 单眼药量kg, 雷管段]（段 3/5/7 由内向外）
    layers: [
      [3.0, 16, 1.8, 3],
      [4.8, 22, 1.5, 5],
      [6.6, 30, 1.3, 7]
    ],
    chargeLengthFactor: 0.65, // 装药长度 = 孔深 × 0.65
    delayMode: 'series' // 延时 = (段号-1) × 75ms
  },
  perimeter: {
    archInset: 0.25, // 拱部孔落位于轮廓线内侧距离 (m)（光爆爆距）
    archMinN: 16, // 拱顶最少孔数
    spacing: 0.6, // 周边孔距 (m，文献孔距 0.5~0.7m)
    archChargeKg: 0.5, // 拱顶单眼药量 (kg)（间隔装药，药量偏低）
    archChargeLengthFactor: 0.6, // 拱顶装药长度 = 孔深 × 0.6（间隔装药）
    // 拱顶段 (顶部 1/3 拱) 用段13，两侧拱用段11（文献：周边孔 MS11 / 拱顶孔 MS13）
    archSegment: a => (Math.abs(a - Math.PI / 2) < Math.PI / 6 ? 13 : 11),
    archDelayMs: 'series', // 延时 = (段号-1) × 75ms（段别随孔位变化）
    archIdStyle: 'angleSeg', // 编号：SL-PA<弧度×100>-<段别>
    wallOffsetX: 0.35, // 边墙孔距直墙轮廓内缩 (m)
    wallRatios: [0.3, 0.6, 0.85], // 边墙孔高度比例（× 直墙高）
    wallChargeKg: 1.2, // 边墙单眼药量 (kg)，段 11
    wallChargeLengthFactor: 0.6, // 边墙装药长度 = 孔深 × 0.6
    wallSegment: 11, // 边墙雷管段（MS11）
    wallDelayMs: (11 - 1) * SANLENGSHAN_SEG_INTERVAL_MS, // 边墙延时 (ms)
    floorCount: 13, // 底板孔数（密集均布一排，段 9）
    floorHalfInset: 1.2, // 底板孔距侧轮廓内缩 (m)
    floorY: 0.55, // 底板孔高度 (m)
    floorChargeKg: 1.8, // 底板单眼药量 (kg)
    floorChargeLengthFactor: 0.7, // 底板装药长度 = 孔深 × 0.7
    floorSegment: 9, // 底板雷管段
    floorDelayMs: (9 - 1) * SANLENGSHAN_SEG_INTERVAL_MS // 底板延时 (ms)
  }
}

/**
 * 生成三棱山隧道掌子面布孔（空孔 + 垂直楔形掏槽 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致。
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export const buildSanlengshanTunnelDesign = createWedgeCutDesign(SANLENGSHAN_CONFIG)
