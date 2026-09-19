/**
 * 余漾隧道爆堆块度（某隧道钻爆法全断面）—— 文献化布孔设计
 *
 * 数据来源：余漾等《隧道爆堆块度图像识别及块度分布快速评价研究》现代工程科技 2026,5(9)。
 *  - 工程：某隧道采用钻爆法施工，掌子面单次爆破方量约 180m³。
 *  - 岩性：新近系泥岩夹砂岩、砾岩以及三叠系砂岩、板岩和砾岩为主；岩体结构致密，
 *    节理裂隙发育中等。
 *  - 爆破参数：单孔装药量 1.3~2.0 kg/m（线装药密度），孔深 3.2~3.3m，孔径 32mm，
 *    孔距 600~1300mm。
 *  - 块度：五次爆堆图像识别+Swebrec 拟合，x50≈156~252mm、xmax≈0.65~1.37m、
 *    b≈5.58~8.17；级配不良（Cu=1.82~2.92<5，Cc=1.08~1.18 合格）。
 *
 * 断面尺寸文献未给出，按"单次 180m³、进尺≈2.7m"推算断面积约 65~67m²：
 * 马蹄形 10.8m×7.4m（宽×高）。该设计用于平台 005 事件（BLAST-2026-005，余漾），
 * 前端据此覆盖 DB 的通用设计，使 3D 模型（隧道断面、炮孔布局、雷管段别）与文献一致。
 *
 * 布孔骨架（空孔 → 垂直楔形掏槽 → 环形扩槽/崩落 → 周边光爆）与
 * nanshan / dabalai / sanlengshan 同构，统一由 tunnelDesignFactory 参数化实现。
 */
import { createWedgeCutDesign } from './tunnelDesignFactory.js'

export const YUYANG_SECTION = {
  width: 10.8, // 开挖宽度 (m)
  wallHeight: 2.0, // 直墙高 (m)
  archRadius: 5.4, // 拱部半径 (m) = 宽/2
  shape: 'horseshoe',
  totalHeight: 7.4 // 2.0 + 5.4
}

// 余漾隧道布孔参数表（喂给 createWedgeCutDesign）
const YUYANG_CONFIG = {
  section: YUYANG_SECTION, // 马蹄形断面：宽 10.8m × 总高 7.4m
  idPrefix: 'YY', // 炮孔编号前缀
  holeDepth: 3.2, // 孔深 3.2m（文献孔深 3.2~3.3m）
  margin: 0.35, // 布孔断面内缩余量 (m)
  explosiveType: 'emulsion', // 乳化炸药
  yCut: 2.4, // 掏槽核心线高度（掌子面中下）
  emptyHoleId: 'YY-E', // 中心空孔编号（自由面，段 1）
  wedge: {
    // 楔形掏槽：每排为上下两孔对称斜孔向核心线汇拢，[孔口横向展布, 距核心线竖向Δy, 倾角°]
    rows: [
      [1.2, 0.7, 13],
      [1.8, 1.4, 25]
    ],
    chargeKg: 1.8, // 掏槽单眼装药量 (kg)，文献单孔装药 1.3~2.0kg/m 区间
    chargeLengthFactor: 0.65, // 装药长度 = 孔深 × 0.65
    rowDelays: [0, 1], // 掏槽排间微差 (ms)
    idStyle: 'indexed' // 编号：YY-CU-<排号>-<R|L>
  },
  relief: {
    // 扩槽/崩落层：[半径, 孔数, 单眼药量kg, 雷管段]（由内向外段 3→5→7）
    layers: [
      [3.0, 18, 1.5, 3],
      [4.8, 26, 1.4, 5],
      [6.6, 34, 1.3, 7]
    ],
    chargeLengthFactor: 0.6, // 装药长度 = 孔深 × 0.6
    delayMode: 'layerBase', // 层内延时 = 层基准 + 孔序 × 2ms
    layerDelayBases: [6, 16, 36] // 各层延时基准 (ms)
  },
  perimeter: {
    archInset: 0.25, // 拱部孔落位于轮廓线内侧距离 (m)（光爆距）
    archMinN: 14, // 拱顶最少孔数
    spacing: 0.65, // 周边最小抵抗线 / 光爆爆距 (m)（文献孔距 600~1300mm）
    archChargeKg: 0.6, // 拱顶单眼药量 (kg)，段 9
    archChargeLengthFactor: 0.5, // 拱顶装药长度 = 孔深 × 0.5
    archSegment: 9, // 拱顶雷管段
    archDelayMs: 400 + 18, // 拱顶延时 (ms)
    wallOffsetX: 0.35, // 边墙孔距直墙轮廓内缩 (m)
    wallRatios: [0.3, 0.6, 0.85], // 边墙孔高度比例（× 直墙高）
    wallChargeKg: 1.2, // 边墙单眼药量 (kg)，段 7
    wallChargeLengthFactor: 0.55, // 边墙装药长度 = 孔深 × 0.55
    wallSegment: 7, // 边墙雷管段
    wallDelayMs: 300 + 15, // 边墙延时 (ms)
    floorCount: 11, // 底板孔数（密集均布一排，段 7）
    floorHalfInset: 1.2, // 底板孔距侧轮廓内缩 (m)
    floorY: 0.5, // 底板孔高度 (m)
    floorChargeKg: 1.6, // 底板单眼药量 (kg)
    floorChargeLengthFactor: 0.7, // 底板装药长度 = 孔深 × 0.7
    floorSegment: 7, // 底板雷管段
    floorDelayMs: 300 + 14 // 底板延时 (ms)
  }
}

/**
 * 生成余漾隧道掌子面布孔（空孔 + 垂直楔形掏槽 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致。
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export const buildYuyangTunnelDesign = createWedgeCutDesign(YUYANG_CONFIG)
