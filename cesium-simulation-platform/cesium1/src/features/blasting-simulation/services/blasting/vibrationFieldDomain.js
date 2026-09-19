import {
  computeSurfacePeakField,
  tunnelFaceBoostFactor,
  nearFieldRadius,
  nearFieldGain,
  NEAR_FIELD_GAIN
} from '../core/computation/localVibrationSimulator.js'
import { extractContours, computeContourLevels } from '../core/computation/contourExtractor.js'
import { SADOVSKY_DEFAULT_K, SADOVSKY_DEFAULT_ALPHA } from '../core/vibrationDefaults.js'

/**
 * 振动场量程与等值线域（VibrationFieldDomain）
 *
 * 从 BlastingManager 拆出的"场量程/等值线"职责：
 *  - 自动量程解析基准（computeAutoFieldRefs）：PPV 锚 rRef=4m 代表值、应力锚
 *    场最大值（近场 standoff×F），一次性计算满刻度并回写门面 _lastFieldRefs；
 *  - 绝对量程启动分位扫描（fixFieldRefOnce，P99.7，锁定后恒定）与分位值计算；
 *  - 解析展开基线（analyticAutoscale）：等值线峰值场 P99.9 到达前的保守 autoscale；
 *  - 等值线提取管线（ensureContourPipeline / buildAndPushContours）：峰值场 MS
 *    提取（Worker/主线程回退）→ computeContourLevels → extractContours → Line2 下发。
 * 经门面实例（this.m）访问跨域共享状态（_localVibrationSim、_vibComputeClient、
 * _threeRenderer、_lastFieldRefs、_fieldAutoScale、_contour* 等），自身仅持有
 * 单域状态 _contourReqId / _absScan / _analyticRefs / _stressFactorCache。
 */
export class VibrationFieldDomain {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
    this._contourReqId = 0 // computeContour 请求 id（过期结果丢弃）
  }

  /**
   * 自动量程：确定色标满刻度，使每个片元按其真实计算震速映射到有区分度的色域。
   * 满刻度 = 解析场在"距源代表可视距离 rRef"处的真实计算震速。
   *
   * 说明：若用近场极值(0.5m处~3000cm/s)当满刻度，岩体上绝大多数点位震速远小于它，
   * 归一化后场值全落在 shader 的可见下限(<0.02)内 → 整片塌成浅波前色带，"看不出
   * 按数值对应色域"。取隧道内代表可视半径(rRef≈4m)处的真实值当满刻度，使岩体从
   * 近场(顶色)沿距离真实衰变到冷色(远段)，每个点位颜色=该点真实计算震速在色标中
   * 的对应色，梯度清晰、量程不再被极值压垮。
   * @returns {{ ppvRefMps:number, stressRefMPa:number }}
   */
  computeAutoFieldRefs(params, sources, design, rockParams) {
    const K = this.m._sadoskyK ?? SADOVSKY_DEFAULT_K
    const alpha = this.m._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA
    // 有效总装药：优先各装药段之和，否则用事件总装药
    let Q = 0
    if (Array.isArray(sources) && sources.length) {
      for (const s of sources) Q += Number(s?.chargeKg) || 0
    }
    if (!(Q > 0)) Q = Number(params?.chargeKg) || 100
    // 距源代表可视半径(m)：取隧道内代表可视半径 rRef=4m（K·(Q^(1/3)/4)^α·0.01）。
    // 注意：不得收紧到 2m——基线抬高 2^α≈3 倍会把满刻度整体抬高，对数标尺上
    // 全场颜色下移约 1.6 个八度、可见下限(NORM_FLOOR·ref)同步抬高 3 倍，
    // 热力图表现为"颜色变暗、渲染范围收窄"（用户实测反馈的强度回归根因）。
    // 中心过曝由【绝对量程】锚定场最大值天然规避（中心即满刻度，饱和区只剩
    // 爆源核心），不再需要任何随帧自愈。
    const rRef = 4.0
    const ppvRefMps = K * Math.pow(Math.pow(Q, 1 / 3) / rRef, alpha) * 0.01
    const rho = Number(design?.rockDensity) || 2650
    const cp = Number(rockParams?.pWaveSpeed) || 4500
    // Number(undefined)=NaN 不是 nullish，?? 链不生效 → nu/stressFactor 变 NaN，
    // stressRefMPa 随之 NaN 且 applyFieldPhysics 拒收 → 应力模式量程失效。显式判有限值。
    const nuDesign = Number(design?.poissonRatio)
    const nuRock = Number(rockParams?.poissonRatio)
    const nu = Number.isFinite(nuDesign) ? nuDesign : Number.isFinite(nuRock) ? nuRock : 0.25
    // 动态泊松比 μ_d=0.8μ（梁瑞 2020 长江科学院院报 37(4):67-72）：
    // 与后端 stress_field_from_ppv(dynamic_poisson=True) / computeStressFieldFromPpv 同口径
    const nuDyn = 0.8 * Math.max(0, Math.min(0.49, nu))
    const stressFactor = rho * cp * (1 / (1 - nuDyn))
    const nfR = nearFieldRadius(Number(params?.chargeKg) || Q)
    this.m._stressNearFieldR = nfR
    this.m._stressNearFieldGain = NEAR_FIELD_GAIN
    // 应力满量程：锚定**场最大值**（近场 standoff 处），并把 F(standoff) 一并计入。
    // 【收紧满量程】若锚在 rRef=4m 代表值，中心(standoff≈0.5m)会比满刻度高
    // ~27×F → 近场深饱和、糊成大片黄云（用户实测"巨大黄色高斯云"的根因）；
    // 锚在场最大值后中心恰好落在色阶顶部、饱和区只剩爆源核心，梯度全程可见。
    const MIN_STANDOFF = 0.5
    const vNear = K * Math.pow(Math.pow(Q, 1 / 3) / MIN_STANDOFF, alpha) * 0.01
    const nfC = nearFieldGain(MIN_STANDOFF, nfR, NEAR_FIELD_GAIN)
    const refs = {
      ppvRefMps,
      stressRefMPa: (stressFactor * vNear * nfC) / 1.0e6
    }
    this.m._lastFieldRefs = refs
    // 解析基线快照（只由 rRef=4m 的解析值决定，不含自愈成分）：
    // → cap=base×MULT 同步抬高 → 正反馈把满刻度重新推到近场极值。
    this._analyticRefs = { ppvRefMps, stressRefMPa: refs.stressRefMPa }
    this._stressFactorCache = stressFactor // 供 stress 场帧自愈换算
    return refs
  }

  // ─── 绝对量程·启动分位扫描（应力用，P99.7，锁定后恒定）────────
  // 解析近场值受 standoff 钳制与**隧道空腔掩码**影响，可能是"渲染数据中永不
  // 出现的奇点"——爆心位于已开挖洞身内，近源网格点被 void_mask 清零。用解析
  // 极值当满刻度会把有效场值全压到最低档（用户实测：应力图几乎全蓝）。
  // 做法：仿真开始后的前 ABS_SCAN_FRAMES 个**有效帧**（分位峰值>0）对渲染场做
  // P99.7 分位扫描、取单调最大，之后锁定为绝对量程。锁定后图例区间与等值线
  // 级别不再变化（满足"仿真前全局扫描并固定最大/最小值"的工程要求）。
  static ABS_SCAN_FRAMES = 24

  /** 分位值（下采样 + 降序取第 (1-q) 分位；arr 为 Float32Array，O(N)） */
  fieldQuantile(arr, q = 0.997) {
    if (!(arr && arr.length)) return 0
    const step = Math.max(1, Math.floor(arr.length / 2400))
    const vals = []
    for (let i = 0; i < arr.length; i += step) {
      const v = Number(arr[i])
      if (Number.isFinite(v) && v > 0) vals.push(v)
    }
    if (!vals.length) return 0
    vals.sort((a, b) => b - a)
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * (1 - q)))] || 0
  }

  /**
   * 启动分位扫描（每帧调用，锁定后零开销直接返回）。
   * @param {'ppv'|'stress'} kind - ppv 数组单位 m/s；stress 数组单位 Pa
   */
  fixFieldRefOnce(kind, arr) {
    if (!(arr && arr.length)) return
    if (!this._absScan) this._absScan = { ppv: { n: 0, v: 0 }, stress: { n: 0, v: 0 } }
    const st = this._absScan[kind]
    if (!st || st.n >= VibrationFieldDomain.ABS_SCAN_FRAMES) return // 已锁定
    const q = this.fieldQuantile(arr)
    if (!(q > 0)) return // 波前未到/全零帧：不计入
    if (q > st.v) st.v = q
    st.n++
    if (st.n < VibrationFieldDomain.ABS_SCAN_FRAMES) return

    // ── 锁定：以实测分位峰值作为满刻度，并一次性下发 ──
    const isPpv = kind === 'ppv'
    const value = isPpv ? st.v : st.v / 1.0e6 // Pa → MPa
    this.m._lastFieldRefs = {
      ...(this.m._lastFieldRefs || {}),
      [isPpv ? 'ppvRefMps' : 'stressRefMPa']: value
    }
    this.m._threeRenderer?.setFieldPhysics?.(isPpv ? { ppvRefMps: value } : { stressRefMPa: value })
    console.warn('[BlastingManager] 绝对量程已锁定（P99.7 分位扫描）', {
      场: kind,
      满刻度: Number(value.toPrecision(4)),
      采样帧数: st.n
    })
  }

  /**
   * 解析展开基线（autoscale 回退）：应力满刻度锚在近场(0.5m)极值，而岩体绝大多数
   * 点位应力远小于它 → 全片塌成低端深蓝。这里以 PPV 惯例的代表可视半径 rRef=4m
   * 处的解析应力为"期望铺满色域"的满刻度，反解展开因子 S = stressRef/stressAt4。
   * PPV 满刻度本就锚在 4m 代表值 → S≈1 保持原样。待值线峰值场 P99.9 实测到达后
   * 由 _buildAndPushContours 动态精细化（真实分布更贴近现场形态）。
   * @returns {number} 1~80 的展开因子（1=不缩放）
   */
  analyticAutoscale(params, sources, design, rockParams) {
    const K = this.m._sadoskyK ?? SADOVSKY_DEFAULT_K
    const alpha = this.m._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA
    let Q = 0
    if (Array.isArray(sources) && sources.length) {
      for (const s of sources) Q += Number(s?.chargeKg) || 0
    }
    if (!(Q > 0)) Q = Number(params?.chargeKg) || 100
    const rho = Number(design?.rockDensity) || 2650
    const cp = Number(rockParams?.pWaveSpeed) || 4500
    const nuDesign = Number(design?.poissonRatio)
    const nuRock = Number(rockParams?.poissonRatio)
    const nu = Number.isFinite(nuDesign) ? nuDesign : Number.isFinite(nuRock) ? nuRock : 0.25
    // 动态泊松比 μ_d=0.8μ（梁瑞 2020），与后端/本地模拟器应力反演同口径
    const nuDyn = 0.8 * Math.max(0.01, Math.min(0.49, nu))
    const stressFactor = rho * cp * (1 / (1 - nuDyn))
    const vAt4 = K * Math.pow(Math.pow(Q, 1 / 3) / 4.0, alpha) * 0.01
    const stressAt4 = (stressFactor * vAt4) / 1.0e6
    const stressRef = Number(this.m._lastFieldRefs?.stressRefMPa) || 0
    if (!(stressRef > 0) || !(stressAt4 > 0)) return 1
    return Math.min(80, Math.max(1, stressRef / (stressAt4 * 1.06)))
  }

  /**
   * 确保等值线折线与当前场景/样式一致（每播放 tick 调用，内部指纹比对）。
   *
   * 峰值场与时间无关 → 每个事件/参数组合只算一次：
   *   ① 从 renderer 导出岩面顶点集（getContourSurface，版本缓存零重算）；
   *   ② Worker 计算顶点峰值场 + 到达时刻（contourConfig/computeContour 协议，
   *      Worker 内结果缓存，样式变化时秒回）；Worker 不可用回退主线程同步计算；
   *   ③ computeContourLevels 按当前显示模式/标尺反解级别 → extractContours
   *      （Marching Squares + 拓扑后处理）→ setContourPolylines 构建 Line2 渲染组。
   *
   * 重提取触发（指纹失配）：岩体几何版本（build/爆后切换/剖切）、显示模式、
   * 色彩标尺、等值线密度、sim 事件参数（K/α/装药/源数）。
   * 单在途 coalesce：在途期间指纹再变记 dirty，完成后补算最新（不堆积请求）。
   * @param {object} renderer - three.js 渲染器
   */
  ensureContourPipeline(renderer) {
    const sim = this.m._localVibrationSim
    if (!sim || !renderer?.getContourSurface) return
    const surface = renderer.getContourSurface()
    if (!surface || !surface.positions?.length || surface.positions.length < 9) return
    const rp = renderer.getFieldRenderParams?.() || {}
    const p = sim.params || {}
    // 指纹：几何版本 | 显示模式 | 标尺 | 满刻度 | 密度 | sim 事件参数（K/α/cp/装药/源数）
    const fp = [
      surface.version,
      Number(rp.displayMode) || 0,
      Number(rp.normMode) > 0 ? 1 : 0,
      (Number(rp.ppvRefMps) || 0).toFixed(4),
      (Number(rp.stressRefMPa) || 0).toFixed(3),
      (Number(rp.stressFactor) || 0).toExponential(4),
      this.m._contourDensity,
      Number(p.K) || 0,
      Number(p.alpha) || 0,
      Number(p.visualCp) || 0,
      // 包络半径纳入指纹：滑块拖动 → 峰值场 env 变化 → 等值线必须重提取
      Number(p.influenceRadius) || 0,
      sim.chargeKg || 0,
      Array.isArray(p.sources) ? p.sources.length : 0,
      this.m._delayJitterMs // 雷管误差变更 → 源延期抖动变化 → 峰值场干涉形态变化，强制重提
    ].join('|')
    if (fp === this.m._contourBuiltFp) return
    if (this.m._contourInFlight) {
      this.m._contourDirty = true
      return
    }
    this.m._contourInFlight = true
    const reqId = ++this._contourReqId
    const finish = (peak, arrival) => {
      this.m._contourInFlight = false
      this.m._contourBuiltFp = fp
      try {
        // 等值线峰值场与 GPU 岩面热力图同口径：统一在 JS 侧附加隧道轮廓自由面
        // 放大（Worker 与主线程回退都未带此修正，避免双乘；不改变 arrival 门控）
        const tunnelFace = sim.params?.tunnelFace
        if (tunnelFace && Number(tunnelFace.coeff) > 0.001) {
          const pos = surface.positions
          for (let i = 0; i < peak.length; i++) {
            peak[i] *= tunnelFaceBoostFactor(
              [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]],
              tunnelFace
            )
          }
        }
        this.buildAndPushContours(peak, arrival, surface, rp, renderer)
      } catch (err) {
        console.warn('[BlastingManager] 等值线构建失败', err)
      }
      if (this.m._contourDirty) {
        this.m._contourDirty = false
        this.ensureContourPipeline(renderer)
      }
    }
    if (this.m._vibComputeClient.ensure(sim)) {
      // Worker 路径：顶点集只在版本变化时重发（样式变化命中 Worker 缓存，避免
      // 每次数百 KB 结构化克隆）；computeContour 带 requestId 丢弃过期结果。
      if (surface.version !== this.m._contourConfiguredVersion) {
        this.m._vibComputeClient.contourConfig(surface.positions, surface.shaping)
        this.m._contourConfiguredVersion = surface.version
      }
      this.m._vibComputeClient.computeContour(reqId).then(res => {
        if (res && res.requestId === reqId && res.peak?.length === surface.positions.length / 3) {
          finish(res.peak, res.arrival)
        } else {
          // 过期/异常：复位在途标记，下一 tick 指纹仍失配会自动重试
          this.m._contourInFlight = false
          this.m._contourBuiltFp = null
        }
      })
      return
    }
    // Worker 不可用 → 主线程同步回退（computeSurfacePeakField 与 Worker 同口径）
    try {
      const sp = sim.params || {}
      const shaping = surface.shaping || {}
      // 与 Worker 路径（vibrationComputeWorker {...p}）完全同参：展开 sim.params
      // 而非手工挑字段——此前漏传 beta/visualBeta/peakMethod/influenceRadius/
      // reflections，事件 attenuationP≠0.02 或开启反射时两路径等值线口径分叉，
      // 且被 computeSurfacePeakField 的默认值兜底掩盖。展开式传参从构造上保证
      // 两条路径永不漂移。
      const r = computeSurfacePeakField(surface.positions, {
        ...sp,
        chargeKg: sim.chargeKg,
        sources: Array.isArray(sp.sources) ? sp.sources : [],
        origin: Array.isArray(sp.origin) ? sp.origin : (shaping.origin ?? [0, 0, 0]),
        reflections: sp.reflections, // 掌子面自由面反射（与 Worker 路径同口径）
        holeRadius: shaping.holeRadius,
        holeLen: shaping.holeLen,
        lateralAttn: shaping.lateralAttn
      })
      if (r) finish(r.peak, r.arrival)
      else this.m._contourInFlight = false
    } catch (err) {
      console.warn('[BlastingManager] 等值线主线程回退计算失败', err)
      this.m._contourInFlight = false
    }
  }

  /**
   * 由顶点峰值场构建等值线折线并下发渲染器。
   * @param {Float32Array} peak - 每顶点峰值 PPV（m/s，含 occ×agn 整形）
   * @param {Float32Array} arrival - 每顶点最早波前到达时刻(s)
   * @param {object} surface - getContourSurface 导出（positions/normals/index）
   * @param {object} rp - getFieldRenderParams（displayMode/normMode/满刻度）
   * @param {object} renderer - three.js 渲染器
   */
  buildAndPushContours(peak, arrival, surface, rp, renderer) {
    const mode = Number(rp.displayMode) || 0
    const stressFactor = Number(rp.stressFactor)
    // 等值线级别与 shader 归一化必须同单位：应力模式下把顶点峰值 PPV(m/s) 换算成
    // σ_vm(MPa)（σ=ρcp/(1-ν)·v，surface 远场近似；近场几何增益分量在 surface
    // 提取中未含，故此处用同一解析换算，保持"级别/像素值"线性一致）。
    const inStressUnits = mode === 1 && Number.isFinite(stressFactor) && stressFactor > 0
    const values = inStressUnits ? new Float32Array(peak.length) : peak
    if (inStressUnits) {
      const cSt = stressFactor / 1.0e6
      for (let i = 0; i < peak.length; i++) values[i] = peak[i] * cSt
    }
    // 动态满量程（P99.9）：以当前显示模式下实测峰值场 P99.9 反解展开因子 S，
    // 使岩体实际分布铺满色域（修"应力全场深蓝"）；S 在数值单位上与 levels 同源，
    // 随事件固定（不随帧漂移），与 shader lin*=uNormAutoScale 严格互逆 → 等值线
    // 始终落在色阶边界上。
    const refDisp = mode === 1 ? Number(rp.stressRefMPa) || 0 : Number(rp.ppvRefMps) || 0
    let autoscale = 1
    if (refDisp > 0) autoscale = this.m._p99Autoscale(values, refDisp)
    this.m._fieldAutoScale = autoscale
    renderer.setFieldPhysics?.({ normAutoScale: autoscale })
    const levels = computeContourLevels({
      displayMode: rp.displayMode,
      normMode: rp.normMode,
      ppvRefMps: rp.ppvRefMps,
      stressRefMPa: rp.stressRefMPa,
      stressFactor: rp.stressFactor,
      density: this.m._contourDensity
    }).map(l => l / autoscale)
    if (!levels.length) {
      this.m._contourStats = null
      renderer.setContourPolylines?.({ polylines: [] })
      return
    }
    const { polylines, stats } = extractContours(
      {
        positions: surface.positions,
        normals: surface.normals,
        index: surface.index,
        values,
        arrival
      },
      { minLoopPerimeter: 0.9, minOpenLength: 0.6, chaikinIterations: 2 }
    )
    this.m._contourStats = stats
    renderer.setContourPolylines?.({
      polylines,
      displayMode: Number(rp.displayMode) || 0,
      normMode: Number(rp.normMode) > 0 ? 1 : 0,
      ppvRefMps: rp.ppvRefMps,
      stressRefMPa: rp.stressRefMPa,
      stressFactor: rp.stressFactor
    })
  }
}
