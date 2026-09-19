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
 *
 * 布孔骨架（垂直楔形掏槽 → 环形扩槽/崩落 → 周边光爆，无中心空孔）与
 * nanshan / sanlengshan / yuyang 同构，统一由 tunnelDesignFactory 参数化实现。
 */
import { createWedgeCutDesign } from './tunnelDesignFactory.js'

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

// 达巴莱隧道布孔参数表（喂给 createWedgeCutDesign）
const DABALAI_CONFIG = {
  section: DABALAI_SECTION, // 马蹄形断面：宽 9.0m × 总高 7.0m（估算）
  idPrefix: 'DB', // 炮孔编号前缀
  holeDepth: DABALAI_HOLE_DEPTH, // 掏槽孔深 3.0m
  margin: 0.3, // 布孔断面内缩余量 (m)
  explosiveType: 'emulsion', // 2号岩石乳化炸药
  yCut: 1.8, // 掏槽核心线高度（掌子面中下部）
  emptyHoleId: null, // 文献方案无中心空孔（掏槽孔先起爆自行创造自由面）
  seriesIntervalMs: DABALAI_SEG_INTERVAL_MS, // 段间延时 (ms)：延时 = (段号-1) × 75ms
  wedge: {
    // 楔形掏槽：每排为上下两孔对称斜孔向核心线汇拢成 V 形，[孔口横向展布, 距核心线竖向Δy, 倾角°]
    // 初始组=内排(delay 0)，次生组=外排(delay 4ms，电子雷管分段)；2 排×2 侧×上下=8 孔
    rows: [
      [0.4, 0.5, 9], // 内排（初始组）
      [1.2, 1.3, 25] // 外排（次生组）
    ],
    chargeKg: 2.4, // 掏槽单眼装药量 (kg)
    chargeLengthFactor: 0.7, // 装药长度 = 孔深 × 0.7
    rowDelays: [0, 4], // 内排初始组 0ms / 外排次生组 4ms（电子雷管精密延时）
    idStyle: 'spacing' // 编号：DB-CU-<R|L><孔口展布×10>
  },
  relief: {
    // 扩槽/崩落层：[半径(相对核心线), 孔数, 单眼药量kg, 雷管段]（段 3/5 由内向外）
    layers: [
      [2.4, 12, 1.8, 3],
      [3.6, 16, 1.5, 5]
    ],
    chargeLengthFactor: 0.65, // 装药长度 = 孔深 × 0.65
    delayMode: 'series' // 延时 = (段号-1) × 75ms
  },
  perimeter: {
    archInset: 0.25, // 拱部孔落位于轮廓线内侧距离 (m)（光爆距）
    archMinN: 10, // 拱顶最少孔数
    spacing: 0.6, // 周边最小抵抗线 / 光爆爆距 (m)
    archChargeKg: 0.6, // 拱顶单眼药量 (kg)，段 9
    archChargeLengthFactor: 0.6, // 拱顶装药长度 = 孔深 × 0.6
    archSegment: 9, // 拱顶雷管段
    archDelayMs: (9 - 1) * DABALAI_SEG_INTERVAL_MS, // 拱顶延时 (ms)
    wallOffsetX: 0.3, // 边墙孔距直墙轮廓内缩 (m)
    wallRatios: [0.35, 0.7], // 边墙孔高度比例（× 直墙高）
    wallChargeKg: 1.2, // 边墙单眼药量 (kg)，段 7
    wallChargeLengthFactor: 0.6, // 边墙装药长度 = 孔深 × 0.6
    wallSegment: 7, // 边墙雷管段
    wallDelayMs: (7 - 1) * DABALAI_SEG_INTERVAL_MS, // 边墙延时 (ms)
    floorCount: 9, // 底板孔数（密集均布一排，段 7）
    floorHalfInset: 1.0, // 底板孔距侧轮廓内缩 (m)
    floorY: 0.5, // 底板孔高度 (m)
    floorChargeKg: 1.8, // 底板单眼药量 (kg)
    floorChargeLengthFactor: 0.7, // 底板装药长度 = 孔深 × 0.7
    floorSegment: 7, // 底板雷管段
    floorDelayMs: (7 - 1) * DABALAI_SEG_INTERVAL_MS // 底板延时 (ms)
  }
}

/**
 * 生成达巴莱隧道掌子面布孔（楔形掏槽精密延时 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致。
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export const buildDabalaiTunnelDesign = createWedgeCutDesign(DABALAI_CONFIG)
