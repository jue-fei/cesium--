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
 *
 * 布孔骨架（空孔 → 垂直楔形掏槽 → 环形扩槽/崩落 → 周边光爆）与
 * dabalai / sanlengshan / yuyang 同构，统一由 tunnelDesignFactory 参数化实现。
 */
import { createWedgeCutDesign } from './tunnelDesignFactory.js'

export const NANSHAN_SECTION = {
  width: 15.56, // 开挖宽度 (m)
  wallHeight: 2.45, // 直墙高 (m)
  archRadius: 7.78, // 拱部半径 (m)
  shape: 'horseshoe',
  totalHeight: 10.23 // 2.45 + 7.78
}

// 南山隧道布孔参数表（喂给 createWedgeCutDesign）
const NANSHAN_CONFIG = {
  section: NANSHAN_SECTION, // 马蹄形断面：直墙高 2.45m + 拱部半径 7.78m
  idPrefix: 'NS', // 炮孔编号前缀
  holeDepth: 3.0, // 掏槽孔纵深 (m)
  margin: 0.35, // 布孔断面内缩余量 (m)，防止越界/穿底
  explosiveType: 'emulsion', // 岩石乳化炸药
  // 垂直向楔形掏槽：核心线高度取断面下部（y=2.6，贴近底板、处于拱心 Hw=2.45 上方一点）。
  // 文献布置图中掏槽区位于掌子面**中下部**、1段/3段斜孔先起爆，崩落/周边由它向上向
  // 四周扇扩（而非以断面几何中心为锚的"同心圆靶"）。以底部掏槽为锚后，崩落环自然
  // 向下被底板截断、向上逐渐展开，形成文献那种"底部掏槽+向上扇扩"的阶梯形态。
  yCut: 2.6,
  emptyHoleId: 'NS-E', // 中心空孔编号（不装药，段 1 最先临空）
  wedge: {
    // 每项 = [孔口横向展布 x(m), 距核心线竖向距离 Δy(m), 倾角°]；倾角保证孔底在
    // 3.0m 深处向核心线汇拢（tanθ≈Δy/depth；内排 Δy=0.7→13°，外排 Δy=1.4→25°）。
    //   - 上排孔 (y=yCut+Δy)：方位角 -90°（向下向核心线），保持 x 不变；
    //   - 下排孔 (y=yCut-Δy)：方位角 +90°（向上向核心线）。
    // 既非"±90° 右孔朝上/左孔朝下散开、又非沿洞轴向平移"，保证先起爆掏槽朝自由面破碎。
    rows: [
      [1.2, 0.7, 13],
      [1.8, 1.4, 25]
    ],
    chargeKg: 2.4, // 掏槽单眼装药量 (kg)，表3-1
    chargeLengthFactor: 0.7, // 装药长度 = 孔深 × 0.7
    rowDelays: [0, 1], // 掏槽排间微差 (ms)（0/1ms），先临空再碎
    idStyle: 'indexed' // 编号：NS-CU-<排号>-<R|L>
  },
  relief: {
    // 扩槽/崩落层：[半径 r(相对掏槽核心线 y=2.6), 孔数, 单眼药量kg, 雷管段]
    // 以底部掏槽为圆心向上展开（向下被底板截断），层间径向间隔约 1.8m；段 3/5/7
    //（普通毫秒雷管）。
    layers: [
      [2.8, 14, 1.8, 3],
      [4.6, 20, 1.5, 5],
      [6.4, 28, 1.3, 7]
    ],
    chargeLengthFactor: 0.65, // 装药长度 = 孔深 × 0.65
    delayMode: 'layerBase', // 层内延时 = 层基准 + 孔序 × 2ms
    layerDelayBases: [6, 16, 36] // 各层延时基准 (ms)，段间隔微差（外层更晚）
  },
  perimeter: {
    archInset: 0.25, // 拱部孔落位于轮廓线内侧距离 (m)（光爆距）
    archMinN: 12, // 拱顶最少孔数
    spacing: 0.6, // 周边最小抵抗线 / 光爆爆距 (m)
    archChargeKg: 0.4, // 拱顶单眼药量 (kg)，段 15
    archChargeLengthFactor: 0.55, // 拱顶装药长度 = 孔深 × 0.55
    archSegment: 15, // 拱顶雷管段
    archDelayMs: 400 + 18, // 拱顶延时 (ms)
    wallOffsetX: 0.35, // 边墙孔距直墙轮廓内缩 (m)，平滑洞身
    wallRatios: [0.3, 0.6, 0.85], // 边墙孔高度比例（× 直墙高）
    wallChargeKg: 1.2, // 边墙单眼药量 (kg)，段 15
    wallChargeLengthFactor: 0.55, // 边墙装药长度 = 孔深 × 0.55
    wallSegment: 15, // 边墙雷管段
    wallDelayMs: 400 + 15, // 边墙延时 (ms)
    floorCount: 13, // 底板孔数（密集均布一排，段 13，帮助翻渣并平整底板）
    floorHalfInset: 1.2, // 底板孔距侧轮廓内缩 (m)
    floorY: 0.55, // 底板孔高度 (m)
    floorChargeKg: 1.95, // 底板单眼药量 (kg)
    floorChargeLengthFactor: 0.7, // 底板装药长度 = 孔深 × 0.7
    floorSegment: 13, // 底板雷管段
    floorDelayMs: 300 + 12 // 底板延时 (ms)
  }
}

/**
 * 生成南山隧道掌子面布孔（垂直向楔形掏槽 + 环形扩槽/崩落孔 + 周边光爆孔）。
 * 返回 { section, holes }，holes 与库表 blasting_design_holes 字段一致。
 * @param {Object} [opt] 可选：{ holeDepth }
 */
export const buildNanshanTunnelDesign = createWedgeCutDesign(NANSHAN_CONFIG)
