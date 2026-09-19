import { DEFAULT_TUNNEL_WALL_HEIGHT, DEFAULT_TUNNEL_ARCH_RADIUS } from '../core/blastDefaults.js'
import { buildChargeSources } from '../core/computation/localVibrationSimulator.js'

/**
 * 爆源解析域（BlastSourceResolver）
 *
 * 从 BlastingManager 拆出的"爆源"职责：由当前爆破事件的炮孔布孔解析出
 *  - 爆心（应力场/振动场爆心 = 掏槽孔组质心，骑在掌子面上）；
 *  - 多装药源集合（每个装药孔解析为一个独立应力波源，驱动多源矢量叠加，
 *    含雷管延期概率抖动模型与源数安全阀）。
 * 经门面实例（this.m）访问共享状态（_threeRenderer、_effectiveHoles、dataset、
 * _delayJitterMs、_rngSeed），自身仅持有源数诊断标记 _lastLoggedSourceCount。
 */
export class BlastSourceResolver {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  /**
   * 计算应力场/振动场爆心（网格局部坐标 [x, y, z]）。
   *
   * 爆心取"掏槽孔组质心"：骑在掌子面（z=faceOffset）上、断面孔位坐标系
   * （x=横向、y=距底板高度）下的掏槽孔位均值。这样初始应力波/损伤从实际
   * 掏槽爆破位置向外扩散，而不是从网格原点（隧道底板、掌子面前方 3m 空气中）。
   * 无数据库孔位（走 sceneBuilder 回退布孔）时退回典型布孔掏槽中心 (0, H/2)。
   *
   * @returns {number[]} [x, y, z] 网格局部坐标（米）
   */
  computeBlastOrigin() {
    const renderer = this.m._threeRenderer
    const totalH =
      Math.max(1, Number(renderer?.tunnelHeight)) ||
      DEFAULT_TUNNEL_WALL_HEIGHT + DEFAULT_TUNNEL_ARCH_RADIUS
    const faceOffset = Number(renderer?.faceOffset) || 3
    // 优先 _effectiveHoles（楔形掏槽对齐 Da Balai 布孔），缺省回退 DB/回退布孔
    const holes = Array.isArray(this.m._effectiveHoles)
      ? this.m._effectiveHoles
      : Array.isArray(this.m.dataset?.design?.holes)
        ? this.m.dataset.design.holes
        : []
    // 掏槽孔（DB 孔型 'cut'/'easing'，含中心空孔——空孔位于掏槽组中心，参与定位质心）
    const cut = holes.filter(h => {
      const t = String(h?.holeType || 'production').toLowerCase()
      return t === 'cut' || t === 'easing'
    })
    if (cut.length > 0) {
      let sx = 0
      let sy = 0
      for (const h of cut) {
        sx += Number(h?.posX) || 0
        sy += Number(h?.posY) || 0
      }
      return [sx / cut.length, sy / cut.length, faceOffset]
    }
    // 回退：中央掏槽（空孔在 (0, H/2)，见 sceneBuilder._collectFallbackHoles）
    return [0, totalH * 0.5, faceOffset]
  }

  /**
   * 由当前爆破事件的炮孔布孔推算多装药源（驱动多应力波叠加模拟）。
   *
   * 依据文献（Da Balai 隧道楔形掏槽微差爆破 / 《爆炸与冲击》空孔直眼掏槽）：
   * 爆破应力场由 N 个炮孔装药段各自起爆的应力波在岩体内叠加形成——掏槽孔
   * 逐段微差起爆、孔底向掏槽核心收敛，使多源波场重叠干涉，而非单一药包产生的
   * 同心球面波。本方法把每个装药孔解析为一个独立源（位置=装药段中心沿孔向，
   * 楔形掏槽孔底向核心收敛），供 LocalVibrationSimulator 做矢量叠加。
   *
   * @returns {Array|null} [{x,y,z,chargeKg,delayMs,id}]；无事件/无装药孔时 null（退化为单源）
   */
  computeBlastSources() {
    const renderer = this.m._threeRenderer
    const faceOffset = Number(renderer?.faceOffset) || 3
    const totalH =
      Math.max(1, Number(renderer?.tunnelHeight)) ||
      DEFAULT_TUNNEL_WALL_HEIGHT + DEFAULT_TUNNEL_ARCH_RADIUS

    // 炮孔来源：优先 _effectiveHoles（_initThreeBridge 按楔形掏槽对齐 Da Balai 布孔），
    // 其次 DB design.holes；缺省时回退到 SceneBuilder 生成的布孔
    // （getBlastDesign().holes 即楔形掏槽/菱形/辅助/周边孔集），使多源应力波
    // 叠加始终由"当前实际布孔"驱动，而非缺省退化为单源同心圆。
    let holes = Array.isArray(this.m._effectiveHoles)
      ? this.m._effectiveHoles
      : Array.isArray(this.m.dataset?.design?.holes)
        ? this.m.dataset.design.holes
        : []
    if (holes.length === 0) {
      const rbHoles = renderer?.getBlastDesign?.()?.holes
      if (Array.isArray(rbHoles)) holes = rbHoles
    }
    if (holes.length === 0) return null

    // 掏槽孔质心（楔形孔向内收敛的核心）
    const cut = holes.filter(h => {
      const t = String(h?.holeType || h?.type || 'production').toLowerCase()
      return t === 'cut' || t === 'easing'
    })
    let cx = 0
    let cy = 0
    if (cut.length > 0) {
      let sx = 0
      let sy = 0
      for (const h of cut) {
        // SceneBuilder 回退孔位用 x/y，DB 用 posX/posY，两种字段都归一化
        sx += Number(h?.posX ?? h?.x) || 0
        sy += Number(h?.posY ?? h?.y) || 0
      }
      cx = sx / cut.length
      cy = sy / cut.length
    } else {
      cy = totalH * 0.5
    }

    // 归一化孔位 schema：resolveChargePosition 读取 posX/posY、isEmptyHole、
    // holeType、inclinationAngle；SceneBuilder 回退孔位用 x/y、isEmpty、type、inclination
    const normalized = holes.map(h => ({
      posX: Number(h?.posX ?? h?.x) || 0,
      posY: Number.isFinite(Number(h.posY))
        ? Number(h.posY)
        : Number.isFinite(Number(h.y))
          ? Number(h.y)
          : cy,
      holeType: h?.holeType ?? h?.type ?? 'production',
      type: h?.holeType ?? h?.type ?? 'production',
      isEmptyHole: !!(h?.isEmptyHole ?? h?.isEmpty),
      isEmpty: !!(h?.isEmptyHole ?? h?.isEmpty),
      depth: Number(h?.depth) || Number(this.m.dataset?.design?.holeDepth) || 2.5,
      inclinationAngle: Number(h?.inclinationAngle ?? h?.inclination) || 0,
      azimuth: Number(h?.inclinationAzimuth ?? h?.azimuth) || 0,
      chargeKg: Number(h?.chargeKg) || 0,
      chargeLength: Number(h?.chargeLength) || 0,
      delayMs: Number(h?.delayMs) || 0,
      id: h?.id
    }))

    // A5：应力波源 = 全部装药孔（全孔矢量叠加）。
    // 【全源修复】旧版只送掏槽组 + 掌子面四向极端代表孔（上限 16）：002 南山 69 个
    // 装药孔仅 12 个进入叠加（有效药量 24.75kg / 全量 115kg），415/418ms 周边光爆段
    // 整体缺席 → 场值整体偏低、低值等值线贴可见门控阈值被大面积切除（等值线断点
    // 主因，isoline-lab/verify-nanshan.mjs 数值复现），波场观感呈"几个波的简单叠加"
    // 而非全孔矢量干涉。旧 16 上限是 Worker 卸载前保护主线程的历史值；现 GPU 逐
    // 片元叠加与 Worker 卸载的本地模拟均可承受全孔数（96 槽位已扩容）。
    // 安全阀：极端设计超 96 孔时按装药量降序截断，与 sceneBuilder MAX_SOURCES=96
    // 同口径，保证 GPU 解析场与 CPU 网格场两路看到的源集一致。
    const MAX_SRCS = 96
    let charged = normalized.filter(h => !h.isEmptyHole && Number(h.chargeKg) > 0)
    // 【兜底】DB 只给了总装药量、未给单孔药量时，把总药量均摊到全部非空孔，
    // 保证多源矢量叠加不静默退化成单源同心圆（干涉条纹丢失的根因之一）。
    if (charged.length === 0) {
      const nonEmpty = normalized.filter(h => !h.isEmptyHole)
      const totalKg = Number(this.m.dataset?.event?.chargeKg) || 0
      if (nonEmpty.length > 0 && totalKg > 0) {
        const per = totalKg / nonEmpty.length
        charged = nonEmpty.map(h => ({ ...h, chargeKg: per }))
        console.warn('[BlastingManager] 炮孔缺单孔药量，已按总装药量均摊以保留多源干涉', {
          孔数: nonEmpty.length,
          总药量kg: totalKg,
          单孔kg: Number(per.toFixed(3))
        })
      }
    }
    const srcHoles =
      charged.length > MAX_SRCS
        ? [...charged].sort((a, b) => Number(b.chargeKg) - Number(a.chargeKg)).slice(0, MAX_SRCS)
        : charged

    const sources = buildChargeSources(
      srcHoles,
      faceOffset,
      { x: cx, y: cy },
      {
        // 默认让显示/计算源与事件炮孔孔口一致；装药段中点仅作显式对比模式。
        sourcePositionMode: 'collar',
        // 事件默认严格使用设计表中的 delayMs；只有 UI 显式设置 delayJitterMs>0
        // 才叠加概率误差。
        // 雷管延期误差（韩亮 2019 逐段概率模型）：σ_base(t)=0.017·t+3.483ms，
        // UI 的 delayJitterMs 作为 100ms 段的锚定缩放（默认 5ms 与旧常数口径衔接，
        // 长段别按回归式比例放大）；0=关闭（复现精确设计延期）。确定性抖动：
        // GPU 着色器/局部模拟/等值线/点采样共用同一批抖动后源。
        jitterModel: this.m._delayJitterMs > 0 ? 'han2019' : 'off',
        detonatorType: 'nonel',
        delayJitterMs: this.m._delayJitterMs,
        rngSeed: this.m._rngSeed
      }
    )
    // 【诊断】源数决定波场是否有多孔干涉：=1 时必然是完美同心圆（用户可见的
    // "波纹是同心圆、干涉条纹丢失"）。这里打印一次便于在控制台直接定位。
    if (sources.length !== this._lastLoggedSourceCount) {
      this._lastLoggedSourceCount = sources.length
      console.warn('[BlastingManager] 多装药源解析完成', {
        布孔总数: holes.length,
        装药源数: sources.length,
        延时范围ms: sources.length
          ? [
              Math.min(...sources.map(s => Number(s.delayMs) || 0)),
              Math.max(...sources.map(s => Number(s.delayMs) || 0))
            ]
          : null
      })
    }
    return sources.length > 0 ? sources : null
  }
}
