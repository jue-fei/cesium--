import { matchLiteratureEvent } from '../core/literatureEvents.js'
import { buildNanshanTunnelDesign } from '../core/computation/nanshanTunnelDesign.js'
import { buildKunyangTunnelDesign } from '../core/computation/kunyangTunnelDesign.js'
import { buildDabalaiTunnelDesign } from '../core/computation/dabalaiTunnelDesign.js'
import { buildSanlengshanTunnelDesign } from '../core/computation/sanlengshanTunnelDesign.js'
import { buildYuyangTunnelDesign } from '../core/computation/yuyangTunnelDesign.js'
import { buildDongwujunTunnelDesign } from '../core/computation/dongwujunTunnelDesign.js'
import { buildFengyinTunnelDesign } from '../core/computation/fengyinTunnelDesign.js'

/**
 * 文献设计盖章域（LiteratureDesignService）
 *
 * 从 BlastingManager 拆出的"文献化隧道设计"职责：按事件匹配对应的文献隧道模型，
 * 并在 setDataset 流程中将文献断面/布孔/孔深/进尺写回 dataset.design，保证 3D
 * 模型与 UI 全程读取同一套数据。经门面实例（this.m）访问共享状态（dataset、
 * _useLiteratureDesign），自身仅持有盖章标记 _literatureStamped。
 */
// 文献事件 key → 隧道设计构建器（事件匹配规则见 core/literatureEvents.js）
const LITERATURE_DESIGN_BUILDERS = {
  nanshan: buildNanshanTunnelDesign,
  kunyang: buildKunyangTunnelDesign,
  dabalai: buildDabalaiTunnelDesign,
  sanlengshan: buildSanlengshanTunnelDesign,
  yuyang: buildYuyangTunnelDesign,
  dongwujun: buildDongwujunTunnelDesign,
  fengyin: buildFengyinTunnelDesign
}

export class LiteratureDesignService {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  /**
   * 按事件选择对应的文献化隧道设计（CO 按 event_id/名称赠送对应文献模型）。
   * 避免此前"凡 wedge 一律盖章南山"导致 006(Da Balai/昆阳) 与 002(南山) 模型完全相同。
   * 事件→key 的匹配规则与各事件孔深/利用率/K/α 见 core/literatureEvents.js（单源）。
   * @returns {{ key: 'nanshan'|'kunyang'|'dabalai'|'sanlengshan'|'yuyang'|'dongwujun'|'fengyin'|null,
   *    design?: {section, holes}, holeDepth?: number, utilization?: number }}
   */
  resolveLiteratureDesign() {
    const ev = this.m.dataset?.event
    const lit = matchLiteratureEvent(ev?.event_id, ev?.name)
    if (!lit) return { key: null, design: null }
    const builder = LITERATURE_DESIGN_BUILDERS[lit.key]
    return {
      key: lit.key,
      design: builder ? builder() : null,
      holeDepth: lit.holeDepth,
      utilization: lit.utilization
    }
  }

  /**
   * 将文献化隧道设计写回 dataset.design（CO 对应 002 南山 / 004 昆阳 及其余文献事件）。
   * 数据库种子对楔形/掏槽事件可能回退到通用菱形掏槽 + 通用断面，与文献不符，
   * 故在此统一覆盖，保证 3D 模型与 UI 全程读取同一套数据（断面/布孔/孔深/进尺一致）。
   */
  stampLiteratureDesignIfNeeded() {
    const design = this.m.dataset?.design
    if (!this.m._useLiteratureDesign || !design) return
    const lit = this.m._resolveLiteratureDesign()
    if (!lit.design) return
    const { section: s, holes } = lit.design
    const depth = lit.holeDepth ?? 3.0
    const utilization = lit.utilization ?? 0.85
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
    this._literatureStamped = lit.key
  }
}
