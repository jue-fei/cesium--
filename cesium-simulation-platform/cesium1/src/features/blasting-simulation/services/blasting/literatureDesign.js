/**
 * 文献设计盖章域（LiteratureDesignService）
 *
 * 从 BlastingManager 拆出的"文献化隧道设计"职责：按事件匹配对应的文献隧道模型，
 * 并在 setDataset 流程中将文献断面/布孔/孔深/进尺写回 dataset.design，保证 3D
 * 模型与 UI 全程读取同一套数据。经门面实例（this.m）访问共享状态（dataset、
 * _useLiteratureDesign），自身仅持有盖章标记 _literatureStamped。
 *
 * 数据源已后端化（config/blasting_designs/*.json，经 /api/blasting/events/{id}
 * 的 design.literature 注入）：事件→key 匹配与文献断面/布孔/孔深/利用率/萨道夫斯基
 * K/α 均由后端下发，本域只消费 dataset.design.literature，不再本地构建模型。
 */
export class LiteratureDesignService {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  /**
   * 读取后端注入的文献化隧道设计（dataset.design.literature）。
   * 事件→key 的匹配规则（event_id 结尾 / 名称关键词，按序首个命中）由后端
   * match_literature_event 承担，语义与前端旧实现一致。
   * @returns {{ key: string|null, design?: {section, holes}, holeDepth?: number, utilization?: number }}
   */
  resolveLiteratureDesign() {
    const lit = this.m.dataset?.design?.literature
    if (!lit) return { key: null, design: null }
    return {
      key: lit.key,
      design: { section: lit.section, holes: lit.holes },
      holeDepth: lit.holeDepth,
      utilization: lit.utilization
    }
  }

  /**
   * 将文献化隧道设计写回 dataset.design（CO 对应 002 南山 / 004 昆阳 及其余文献事件）。
   * 数据库种子对楔形/掏槽事件可能回退到通用菱形掏槽 + 通用断面，与文献不符，
   * 故在此统一覆盖，保证 3D 模型与 UI 全程读取同一套数据（断面/布孔/孔深/进尺一致）。
   * 数据来自后端注入的 design.literature；无 literature 则不盖章（保持数据库原始设计）。
   */
  stampLiteratureDesignIfNeeded() {
    const design = this.m.dataset?.design
    if (!this.m._useLiteratureDesign || !design) return
    const literature = design.literature
    if (!literature?.section || !Array.isArray(literature.holes)) return
    const s = literature.section
    const holes = literature.holes
    const depth = literature.holeDepth ?? 3.0
    const utilization = literature.utilization ?? 0.85
    design.tunnelWidth = s.width
    design.tunnelWallHeight = s.wallHeight
    design.tunnelArchRadius = s.archRadius
    design.tunnelTotalHeight = s.totalHeight
    design.tunnelShape = s.shape
    design.holeDepth = depth
    design.utilization = utilization
    design.advanceLength = depth * utilization
    design.holeDiameter = design.holeDiameter || 0.04
    design.holes = holes
    this._literatureStamped = literature.key
  }
}
