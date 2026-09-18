/**
 * 文献化爆破事件映射表（单源）
 *
 * 数据库中的文献事件（001~007）按「事件ID 结尾 / 名称关键词」匹配到对应文献隧道设计
 * 与现场标定的萨道夫斯基 K/α。此前该映射在 blastingManager._resolveLiteratureDesign
 * （设计盖章）与 useBlasting.loadDbEvent（K/α 注入）各维护一份 if-chain，改一处漏一处，
 * 现收敛到本模块。
 *
 * 匹配规则：eventId 以 idSuffix 结尾，或事件名称包含任一 nameKeywords（按数组顺序
 * 首个命中即返回，与原 if-chain 判定顺序一致）。匹配不到 → 返回 null
 * （保持数据库原始设计 / 重置默认 K/α）。
 */

/**
 * 萨道夫斯基 K/α（文献回归值；null = 该事件无振动场地回归，调用方应回退默认值）
 *   - 南山：汪亚飞博士论文 图5-1/5-2，R²=0.6125
 *   - 昆阳：王万禄等，据 M1~M3 三方向合成速度拟合（M4 异常剔除）
 *   - 达巴莱：估算（文献未回归，取中等风化石灰岩典型量级）
 *   - 三棱山：徐言 近场分段拟合精度95%（远场 K≈1.23、α=0.372 未入库）
 */
export const LITERATURE_EVENTS = [
  {
    key: 'nanshan',
    idSuffix: '002',
    nameKeywords: ['南山'],
    holeDepth: 3.0,
    utilization: 0.85,
    sadosky: { k: 113.64, alpha: 1.341 }
  },
  {
    key: 'kunyang',
    idSuffix: '004',
    nameKeywords: ['昆阳'],
    holeDepth: 3.0,
    utilization: 0.85,
    sadosky: { k: 90.63, alpha: 1.58 }
  },
  {
    key: 'dabalai',
    idSuffix: '001',
    nameKeywords: ['Da Balai', '达巴莱'],
    holeDepth: 3.0,
    utilization: 0.85,
    sadosky: { k: 150, alpha: 1.7 }
  },
  {
    key: 'sanlengshan',
    idSuffix: '003',
    nameKeywords: ['三棱山'],
    holeDepth: 3.0,
    utilization: 0.9,
    sadosky: { k: 19.3, alpha: 1.082 }
  },
  {
    key: 'yuyang',
    idSuffix: '005',
    nameKeywords: ['余漾'],
    holeDepth: 3.2,
    utilization: 0.85,
    sadosky: null
  },
  {
    key: 'dongwujun',
    idSuffix: '006',
    nameKeywords: ['天江里', '董武俊'],
    holeDepth: 2.2,
    utilization: 0.9,
    sadosky: null
  },
  {
    key: 'fengyin',
    idSuffix: '007',
    nameKeywords: ['备战铁矿', '冯银'],
    holeDepth: 3.0,
    utilization: 0.9,
    sadosky: null
  }
]

/**
 * 匹配文献事件
 * @param {string} eventId - 事件 ID（按结尾匹配）
 * @param {string} eventName - 事件名称（按关键词包含匹配）
 * @returns {object|null} LITERATURE_EVENTS 中的一项，或 null
 */
export function matchLiteratureEvent(eventId, eventName) {
  const id = String(eventId || '')
  const name = String(eventName || '')
  return (
    LITERATURE_EVENTS.find(
      e => id.endsWith(e.idSuffix) || e.nameKeywords.some(kw => name.includes(kw))
    ) || null
  )
}
