import {
  LocalVibrationSimulator,
  VibrationParticleSystem,
  computePointVector,
  computeMonitorTimeHistory
} from '../core/computation/localVibrationSimulator.js'
import { DEFAULT_TUNNEL_WALL_HEIGHT } from '../core/blastDefaults.js'
import { SADOVSKY_DEFAULT_K, SADOVSKY_DEFAULT_ALPHA } from '../core/vibrationDefaults.js'
import { INDUSTRIAL_BANDS_DEFAULT } from '../core/rendering/vibrationColorScales.js'

// WS 振动场帧陈旧判定阈值（ms）：超过该时长未收到帧则回退本地模拟
const WS_STALE_MS = 2000

/**
 * 本地振动场编排域（LocalVibrationOrchestrator）
 *
 * 从 BlastingManager 拆出的"本地振动场模拟"编排职责：WS 不可用时按播放时钟
 * 自行模拟实时数据——懒创建本地模拟器/粒子系统、逐帧推进波前粒子与三场
 * （PPV/应力/损伤）计算（Worker 卸载 + 节流 + 双缓冲插值）、把场地物理参数
 * 下发到岩体面场着色材质（_pushFieldPhysics）、矢量箭头场计算与场点时程采样。
 * 与 blastingWsConnector 推送同构：用相同物理模型（萨道夫斯基/弹性反演/
 * Persson 损伤），确保可视化效果与碎片动画同步。
 * 经门面实例（this.m）访问跨域共享状态（_localVibrationSim、_vibCompute*、
 * dataset、_threeRenderer 等），自身仅持有单域状态 _vibLastUpdateWallMs /
 * _vibLerpBuf。
 */
export class LocalVibrationOrchestrator {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
    // 上次热力图重算的墙钟时刻：与模拟时间节流共用（高倍速下重算频率仍被墙钟封顶，
    // 避免"模拟时间节流×倍速"把主线程重算压到每帧一次导致时序卡顿、与时间轴失同步）
    this._vibLastUpdateWallMs = 0
    this._vibLerpBuf = null // { ppv, sigma } —— 插值输出复用 scratch（避免逐帧分配大数组）
  }

  /**
   * 同步本地振动模拟器网格参数到外部传入的 gridShape
   * 当 gridShape 或 bounds 变化时重建模拟器，保证 computeAtTime 输出长度匹配。
   * 使用 WS 显式边界（后端 y 边界非对称 [-0.2h, 1.2h]），使本地采样点与 WS 网格完全对齐。
   */
  syncSimGrid(cfg) {
    if (!cfg?.gridShape) return
    const sim = this.m._localVibrationSim
    if (sim) {
      const [nx, ny, nz] = cfg.gridShape
      const sameShape =
        sim.nx === nx &&
        sim.ny === ny &&
        sim.nz === nz &&
        sim.boundsMin?.[0] === cfg.boundsMin?.[0] &&
        sim.boundsMin?.[1] === cfg.boundsMin?.[1] &&
        sim.boundsMin?.[2] === cfg.boundsMin?.[2] &&
        sim.boundsMax?.[0] === cfg.boundsMax?.[0] &&
        sim.boundsMax?.[1] === cfg.boundsMax?.[1] &&
        sim.boundsMax?.[2] === cfg.boundsMax?.[2]
      if (sameShape) return
    }
    // 重建模拟器：使用外部网格参数，保证数组长度匹配
    const params = this.m.getPpvStreamParams()
    if (!params) return
    const [nx, ny, nz] = cfg.gridShape
    const sizeX = (cfg.boundsMax?.[0] ?? 0) - (cfg.boundsMin?.[0] ?? 0)
    const sizeY = (cfg.boundsMax?.[1] ?? 0) - (cfg.boundsMin?.[1] ?? 0)
    const sizeZ = (cfg.boundsMax?.[2] ?? 0) - (cfg.boundsMin?.[2] ?? 0)
    this.m._localVibrationSim = new LocalVibrationSimulator({
      chargeKg: params.chargeKg,
      // 物理口径全量透传（与 _ensureLocalVibrationSim 初始创建一致）：重建路径漏传
      // K/α/包络会使模拟器回落默认 K=30/α=1.5、门控关闭 → 暂停或
      // 推流结束后本地接管（拖动进度条）时场值比 WS 模式暗约 3 倍且中远场超程
      // ——"Seek 后热力图骤暗/跳变"的根因（见 syncLocalSimParams.test.js）。
      K: params.k,
      alpha: params.alpha,
      influenceRadius: this.m._vibInfluenceRadius,
      tunnelWidth: Math.max(1, sizeX || params.tunnelWidth),
      tunnelHeight: Math.max(1, sizeY || params.tunnelHeight),
      lengthZ: Math.max(1, sizeZ || 40),
      nx: Math.max(2, nx),
      ny: Math.max(2, ny),
      nz: Math.max(2, nz),
      // 爆心 = 掏槽孔质心（与 WS blastCenter 一致，保证本地兜底与后端推送同源）
      origin: this.m._computeBlastOrigin(),
      // 多装药源：由实际炮孔布孔推算，驱动多应力波叠加（楔形掏槽微差起爆馆形干涉波场）
      sources: this.m._computeBlastSources(),
      // 隧道马蹄形轮廓自由面（与 GPU/初始 sim 同口径）
      tunnelFace: this.m._tunnelFaceConfig(
        this.m._threeRenderer,
        Math.max(1, sizeX || params.tunnelWidth),
        cfg.boundsMin?.[1] ?? 0
      ),
      // 显式边界：采样点与 WS 网格逐点对齐，避免应力/损伤云图错位
      boundsMin: cfg.boundsMin,
      boundsMax: cfg.boundsMax
    })
    // 补齐粒子系统与发射状态（_ensureLocalVibrationSim 因 sim 已存在会跳过创建，
    // 缺失时 stepLocalVibration 访问 _particleEmitState 会抛 TypeError 中断帧更新链）
    if (!this.m._localParticleSystem) {
      this.m._localParticleSystem = new VibrationParticleSystem(600)
    }
    if (!this.m._particleEmitState) {
      this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }
    }
    // 重置节流状态与时间轴标记，使下一帧立即按新网格计算
    this.m._vibFieldLastUpdate = -1
    this.m._vibLastStepT = -1
    this._vibLastUpdateWallMs = 0
    // 重建 sim 后废弃旧 Worker 配置与在途计算（避免旧网格结果与新纹理长度不匹配）
    this.m._vibComputeClient.dispose()
    this.m._vibComputeReqInFlight = false
    this.m._vibComputePending = null
    // 等值线峰值场随 sim 重建作废（源位置/参数已变，新 Worker 需重新收 contourConfig）
    this.m._contourBuiltFp = null
    this.m._contourConfiguredVersion = -1
    this.m._contourInFlight = false
    this.m._contourDirty = false
    // 显示满量程展开因子回归基准：重建后的新事件由 _buildAndPushContours 依新峰值
    // 场 P99.9 重新计算，不再沿用旧事件的实测 autoscale
    this.m._fieldAutoScale = 1
  }

  setEnabled(enabled) {
    this.m._localVibrationEnabled = !!enabled
    if (this.m._localVibrationEnabled) {
      // 恢复本地模式：清除 WS 新鲜度标记，本地应力/损伤兜底立即恢复写入
      this.m._lastWsStressMs = 0
      this.m._lastWsDamageMs = 0
    } else {
      // 停用时清理粒子（避免残留上一轮的波前粒子）
      this.m._threeRenderer?.clearVibrationParticles?.()
      this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }
    }
  }

  /**
   * 懒创建本地振动场模拟器与粒子系统（基于当前 dataset 参数）
   */
  ensureLocalVibrationSim() {
    if (this.m._localVibrationSim) return this.m._localVibrationSim
    const params = this.m.getPpvStreamParams()
    if (!params) return null
    // 让场边界完整覆盖岩体断面（而非对称包裹爆心）：岩体 horseshoe 断面
    // 底部对齐 y=floorY、顶部到 floorY+totalH；旧版默认用对称 [-H/2, H/2]，
    // 导致岩体上半部（拱顶+上部直墙）落在场外→"外围一圈无颜色"。
    // 分辨率按完整断面高度调高竖向（ny），使热力色带在拱高方向更细致。
    const renderer = this.m._threeRenderer
    const tsec = renderer?.tunnelSection
    const W = Math.max(1, Number(tsec?.width) || params.tunnelWidth)
    const totalH = Math.max(1, Number(renderer?.tunnelHeight) || params.tunnelHeight)
    const floorY = renderer?.center?.y ?? 0
    const depthZ = 40
    const sim = new LocalVibrationSimulator({
      chargeKg: params.chargeKg,
      // 场地标定（石灰岩/金属矿硬岩现场测振回归 K=90、α=1.58，见文档 3/4 文献）
      K: params.k,
      alpha: params.alpha,
      tunnelWidth: W,
      tunnelHeight: totalH,
      lengthZ: depthZ,
      // 网格 64×80×128≈65 万点：波场细节（多源干涉瓣/波前环）需要足够的采样密度，
      // x 向步长 = W/64 ≈ 0.28m、y 向 ≈ 0.19m、z 向 0.31m——原先 48×64×96
      // （x 步长 0.375m）下细密的干涉结构会被粗网格抹平。计算走 Worker，
      // 三线性插值+逐片元采样下视觉更连续。
      nx: 64,
      ny: 80,
      nz: 128,
      // 爆心 = 掏槽孔质心（掌子面上），应力波/损伤从实际爆破位置扩散
      origin: this.m._computeBlastOrigin(),
      // 多装药源：由实际炮孔布孔推算，驱动多应力波叠加（楔形掏槽微差起爆的干涉波场）
      sources: this.m._computeBlastSources(),
      boundsMin: [-W / 2, floorY, 0],
      boundsMax: [W / 2, floorY + totalH, depthZ]
    })
    this.m._localVibrationSim = sim
    this.m._localParticleSystem = new VibrationParticleSystem(600)
    this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }
    // 初次创建后即注入场地物理参数，驱动场盒外解析外推波前（与场盒内同一物理曲线）
    this.m._pushFieldPhysics()
    return sim
  }

  /**
   * 按播放时钟推进振动传播模拟（在 setFrame 中调用）
   *
   * 双职责：
   * 1. 波前粒子（振动传播可视化）始终由播放时钟驱动，与 WS 状态无关；
   * 2. 动态热力图（PPV/应力/损伤场）在本地模拟模式（WS 不可用）下由本模拟器
   *    逐帧计算并推送渲染器，与 WS 帧处理器使用同一接口，保证同步。
   *
   * @param {number} time - 模拟时间（秒）
   * @param {number} frame - 帧序号
   */
  step(time, frame) {
    const renderer = this.m._threeRenderer
    if (!renderer) return
    const sim = this.m._ensureLocalVibrationSim()
    if (!sim) return
    // 防御：sim 可能被 _syncLocalVibrationSimGrid 直接替换（绕过 _ensureLocalVibrationSim），
    // 此时粒子系统/发射状态可能未创建；缺失会导致下方访问抛 TypeError，中断整个 setFrame 链
    if (!this.m._localParticleSystem) this.m._localParticleSystem = new VibrationParticleSystem(600)
    if (!this.m._particleEmitState) this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }

    const t = Math.max(0, Number(time) || 0)
    // 起爆前（波前未到达）不初始化/不更新，避免全 0 体积占位
    const blastTriggerTime = Number(renderer.blastTriggerTime) || 0.1

    // ── 时间轴一致性：识别回卷/前跳（拖进度条、循环回卷、seek 跳变）──
    // 旧实现只按 _vibFieldLastUpdate 做正向节流：时间回退时 t−last<0 恒小于
    // interval → 热力图/损伤峰值停在跳变前的时刻，与时间轴脱节（循环回卷后
    // 甚至要等一整圈才能恢复刷新）。发现跳变立即强制：清掉旧波前粒子并重置
    // 发射状态、清空粒子、置 _vibFieldLastUpdate=-1 使本帧重算目标时刻。
    const rewind = t < this.m._vibLastStepT - 1e-4
    const jumpForward =
      this.m._vibLastStepT >= 0 && t - this.m._vibLastStepT > this.m._vibFieldUpdateInterval * 1.5
    if (rewind || jumpForward) {
      renderer.clearVibrationParticles?.()
      this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }
      // 【Seek 清屏】清空三张场纹理：回卷/前跳时 GPU 里驻留的旧帧（尤其是
      // 峰值/损伤的"未来帧最大值"）会在新帧落地前被读到 → 糊成色块。
      renderer.clearFieldTextures?.()
      // 清空插值缓冲：seek 后旧场已不适用，等待下一次全量重算重建双缓冲
      this.m._fieldPrev = null
      this.m._fieldCur = null
      this.m._vibFieldLastUpdate = -1 // 强制下一段立即按目标时刻重算
    }
    this.m._vibLastStepT = t

    if (t < blastTriggerTime) {
      if (this.m._particleEmitState.emittedUntil >= 0) {
        // 回到起爆前（循环回卷）：清空粒子
        renderer.clearVibrationParticles?.()
        this.m._particleEmitState = { emittedUntil: -1, lastT: -1 }
      }
      return
    }

    // 发射波前粒子：起爆后一段窗口内持续发射，粒子沿径向扩散（模拟振动传播）
    const emitWindowEnd = blastTriggerTime + 0.6
    const dt = this.m._particleEmitState.lastT >= 0 ? t - this.m._particleEmitState.lastT : 0
    this.m._particleEmitState.lastT = t
    if (t <= emitWindowEnd && this.m._particleEmitState.emittedUntil < t) {
      // 按时间比例发射：每 0.05s 发射一批（约 80 个），粒子寿命短，形成波前扩散效果
      const batch = Math.min(80, Math.max(20, Math.floor(80 * (dt / 0.05))))
      const cp = sim.params.cp
      this.m._localParticleSystem?.emitBurst(t, batch, cp)
      this.m._particleEmitState.emittedUntil = t
    }

    // 推进粒子（年龄/位移/衰减）并推送渲染器（与 WS 状态无关，始终可见）
    if (this.m._localParticleSystem) {
      // 钳制物理步长：seek 跳变时 dt 可能很大，避免粒子瞬间飞出视野
      const stepDt = Math.min(Math.max(0, dt), 0.1)
      this.m._localParticleSystem.update(t, Math.max(0.016, stepDt || 0.016))
      renderer.updateVibrationParticles?.(this.m._localParticleSystem.activeParticles)
    }

    // 首次进入起爆后：初始化振动场体积（粒子系统由 renderer.initVibrationField 同步初始化）
    if (!renderer.hasVibrationField?.()) {
      const gridInfo = sim.getGridInfo()
      renderer.initVibrationField?.(gridInfo)
    }

    // 计算节流：全量重算三场 + 上传 3 个 Data3DTexture 是主线程重负载。
    // 双重节流：①模拟时间间隔（默认 0.2s）保证低倍速下波形平滑；②墙钟间隔
    // （120ms）给高倍速封顶——高倍速时模拟时间飞驰，若只按模拟时间节流，
    // 重算频率 ×倍速 会被压到每帧一次，主线程卡顿导致播放与热力图时序错乱。
    const nowMsThrottle = performance.now()
    const wallOk = nowMsThrottle - this._vibLastUpdateWallMs >= 120
    if (
      this.m._vibFieldLastUpdate >= 0 &&
      t - this.m._vibFieldLastUpdate < this.m._vibFieldUpdateInterval &&
      !wallOk
    ) {
      return
    }
    this.m._vibFieldLastUpdate = t
    this._vibLastUpdateWallMs = nowMsThrottle

    // 计算当前时刻三场数据并推送渲染器。
    // 优先走 Worker 异步卸载（多源矢量叠加很重，逐帧跑会卡死主线程）；
    // Worker 不可用时回退主线程同步计算（旧逻辑，数据量小时可接受）。
    this.m._dispatchVibrationCompute(t, frame, renderer)
  }

  /**
   * 派发振动场三场计算（PPV/应力/损伤），异步经 Worker 卸载重负载。
   *
   * 调度策略：
   *  - 同一时刻仅允许一个请求在途（coalesce）；在途期间新目标记为 pending，
   *    当前请求完成后补算最新一帧——保证不堆积请求、不丢失最新时刻；
   *  - requestId 用于丢弃过期的中途结果（网格/参数变化后旧结果直接作废）；
   *  - Worker 不可用（低端浏览器）回退到 sim.computeAtTime 同步计算，功能不变。
   *
   * @param {number} t - 目标模拟时间(s)
   * @param {number} frame - 帧序号（透传给渲染器）
   * @param {object} renderer - three.js 渲染器实例
   */
  dispatchCompute(t, frame, renderer) {
    const sim = this.m._localVibrationSim
    if (!sim || !renderer) return

    if (this.m._vibComputeClient.ensure(sim)) {
      // Worker 可用 → 异步卸载
      if (this.m._vibComputeReqInFlight) {
        this.m._vibComputePending = { t, frame } // 只在途一次，完成后补算最新
        return
      }
      this.m._vibComputeReqInFlight = true
      const reqId = ++this.m._vibComputeReqId
      this.m._vibComputeClient.compute(t, reqId).then(res => {
        this.m._vibComputeReqInFlight = false
        if (res)
          this.m._applyVibrationFields(res.ppv, res.sigmaVm, res.zones, res.t, frame, renderer)
        // 期间到达了更新的目标帧 → 续算（只补最后一帧，避免堆积）
        if (this.m._vibComputePending) {
          const pending = this.m._vibComputePending
          this.m._vibComputePending = null
          this.m._dispatchVibrationCompute(pending.t, pending.frame, renderer)
        }
      })
      return
    }

    // Worker 不可用 → 主线程同步回退（旧路径）
    const result = sim.computeAtTime(t)
    this.m._applyVibrationFields(result.ppv, result.sigmaVm, result.zones, t, frame, renderer)
  }

  /**
   * 将计算好的三场数据写入渲染器体积纹理。
   * 仅本地模拟时更新 PPV；应力/损伤在 WS 帧新鲜（2s 内）时让位给 WS 数据，
   * 避免两数据源交替写同一纹理导致云图闪烁/回跳。
   * @param {Float32Array} ppv - PPV 场（m/s，x-最快轴序）
   * @param {Float32Array} sigmaVm - von Mises 应力场（Pa）
   * @param {Int8Array} zones - 损伤分区 id（0~4）
   * @param {number} t - 模拟时间(s)
   * @param {number} frame - 帧序号
   * @param {object} renderer - three.js 渲染器
   */
  applyFields(ppv, sigmaVm, zones, t, frame, renderer) {
    if (!renderer) return
    // 双缓冲记录：为逐帧时间插值保留最近两帧精确场（t 递增时 prev→cur→新cur）
    if (ppv) {
      this.m._fieldPrev = this.m._fieldCur
      this.m._fieldCur = { t, ppv, sigmaVm }
    }
    // PPV 场：仅在本地模拟模式（WS 不可用）下更新。
    // WS 模式下 PPV 由后端实时帧推送，避免本地与 WS 数据交替写入造成闪烁。
    if (this.m._localVibrationEnabled) {
      renderer.updateVibrationField?.(this.m._smoothField3d(ppv, this.m._vibGridShape), t, frame)
      // 【PPV 不做分位扫描】PPV 能量不像应力那样极度集中于近场，解析 rRef=4m
      // 代表值已给出正确梯度；P99.7 是近源峰值(≈5m/s)，当满刻度会让中远场饱和成红
      // （用户实测"外围纯红"）。应力保留 P99.7 扫描（其能量高度集中于近场）。
    }
    // 应力场：本地兜底更新同样参与绝对量程启动扫描（P99.7 分位，锁定后恒定）
    this.m._fixFieldRefOnce('stress', sigmaVm)
    // 应力场与损伤场：本地兜底更新，但 WS 帧新鲜（2s 内）时让位。
    // 本地模拟用 visualCp≈35m/s（可视波前），WS 用 cp=4500m/s（物理波前），
    // 两数据源交替写同一纹理会导致云图闪烁/回跳，故以 WS 优先、本地兜底。
    const nowMs = performance.now()
    if (nowMs - (this.m._lastWsStressMs || 0) > WS_STALE_MS) {
      renderer.updateStressField?.(this.m._smoothField3d(sigmaVm, this.m._vibGridShape), t, frame)
    }
    if (nowMs - (this.m._lastWsDamageMs || 0) > WS_STALE_MS) {
      renderer.updateDamageField?.(zones, t, frame)
    }
  }

  /**
   * 逐帧时间插值写热力图纹理（消除 throttle 跳变导致的闪烁）。
   *
   * 全量重算被 throttle 到 0.2s（+墙钟 120ms），若不在间隔内侧显示会"旧场停留→猛跳"。
   * 这里用最近两帧精确场（_fieldPrev / _fieldCur）在当前模拟时间 t 上做线性混合后
   * 写 PPV/应力纹理，使显示平滑跟随 t；损伤为离散档位不插值，由最新精确帧直接写入。
   * 仅本地模式生效（WS 帧本就逐帧推送）；t 落在窗口外时直接用最新场，不再重复上传。
   * @param {number} t - 当前模拟时间(s)
   * @param {number} frame - 帧序号
   * @param {object} renderer - three.js 渲染器
   */
  applyInterpolation(t, frame, renderer) {
    if (!this.m._localVibrationEnabled || !renderer) return
    const prev = this.m._fieldPrev
    const cur = this.m._fieldCur
    if (!prev || !cur || prev.t >= cur.t) return
    if (t < prev.t || t > cur.t) return // 窗口外：显示最新场即可（已写入），无需重复上传

    const count = cur.ppv.length
    if (prev.ppv.length !== count || !prev.sigmaVm || !cur.sigmaVm) return
    if (prev.sigmaVm.length !== cur.sigmaVm.length) return

    if (!this._vibLerpBuf) this._vibLerpBuf = { ppv: null, sigma: null }
    if (!this._vibLerpBuf.ppv || this._vibLerpBuf.ppv.length !== count)
      this._vibLerpBuf.ppv = new Float32Array(count)
    if (!this._vibLerpBuf.sigma || this._vibLerpBuf.sigma.length !== cur.sigmaVm.length)
      this._vibLerpBuf.sigma = new Float32Array(cur.sigmaVm.length)

    const frac = (t - prev.t) / (cur.t - prev.t)
    const p0 = prev.ppv
    const p1 = cur.ppv
    const s0 = prev.sigmaVm
    const s1 = cur.sigmaVm
    const ppvBuf = this._vibLerpBuf.ppv
    const sigBuf = this._vibLerpBuf.sigma
    for (let i = 0; i < count; i++) {
      ppvBuf[i] = p0[i] + (p1[i] - p0[i]) * frac
      sigBuf[i] = s0[i] + (s1[i] - s0[i]) * frac
    }

    renderer.updateVibrationField?.(ppvBuf, t, frame)
    const nowMs = performance.now()
    if (nowMs - (this.m._lastWsStressMs || 0) > WS_STALE_MS) {
      renderer.updateStressField?.(sigBuf, t, frame)
    }
  }

  /**
   * 将当前事件的爆源/场地物理参数下发到岩体面场着色材质，
   * 驱动"场盒外解析外推"（萨道夫斯基波前）用与场盒内纹理同一物理曲线渲染，
   * 使 PPV 传播过程在整个岩体外围连续可见、边界无缝衔接。
   * 仅传入可解析字段，缺省项保留 SceneBuilder 内置默认，不会覆盖为无效值。
   */
  pushFieldPhysics() {
    const renderer = this.m._threeRenderer
    if (!renderer) return
    const params = this.m.getPpvStreamParams()
    if (!params) return
    const design = this.m.dataset?.design || {}
    const rockParams = this.m.dataset?.event?.rockParams || {}
    const sources = this.m._computeBlastSources()
    const refs = this.m._computeAutoFieldRefs(params, sources, design, rockParams)
    // 【绝对量程】不再叠加实测自愈值（EMA 已移除）：满刻度在仿真开始前由
    // _computeAutoFieldRefs 一次性解析扫描并固定（PPV=近场峰值、应力=场最大值），
    // 整场播放/拖动/回卷期间恒定 —— 图例区间与等值线级别因此全程有效。
    // 旧 EMA 随帧改满刻度会导致图例/等值线级别同步漂移，与工程图惯例相悖。
    renderer.setFieldPhysics?.({
      chargeKg: params.chargeKg,
      k: this.m._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this.m._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta: Number(rockParams.attenuationP) || this.m.dataset?.event?.beta || 0.02,
      visualCp: 35,
      rho: Number(design.rockDensity) || 2650,
      cp: Number(rockParams.pWaveSpeed) || 4500,
      nu: Number(design.poissonRatio) ?? Number(rockParams.poissonRatio) ?? 0.25,
      // 自动量程：色标满刻度跟随岩体代表性峰值（避免全场饱和品红）
      ppvRefMps: refs.ppvRefMps,
      stressRefMPa: refs.stressRefMPa,
      // 应力近场几何修正 F(r)=1+A·(r_nf/r)²：使应力场（峰值判据场）与振速场
      // （瞬时波形）空间结构不同；r_nf 由装药量反算，与 CPU/后端同一口径。
      // 工业风格：离散色阶档数（与等值线密度同源，12~16）+ 总开关
      normBands: this.m._contourDensity ?? INDUSTRIAL_BANDS_DEFAULT,
      industrialStyle: true,
      stressNearFieldR: this.m._stressNearFieldR || 0,
      stressNearFieldGain: this.m._stressNearFieldGain || 0,
      // 爆心（掏槽孔质心）：解析外推波前以该点为源，与场盒内纹理数据一致
      origin: this.m._computeBlastOrigin(),
      // 掌子面自由面反射（镜象源法）：反射面 z=掌子面（grid 局部系），与
      // CPU/Worker 多源模型（sim.params.reflections）同一物理口径。
      faceZ: Number(renderer?.faceOffset) || 3,
      reflectOn: this.m._vibReflectOn,
      reflectCoeff: this.m._vibReflectCoeff,
      // 波包子波载波频率（Hz，0=纯包络）：控制热力图干涉条纹的空间密度
      carrierHz: this.m._vibCarrierHz,
      // 损伤半径由 PPV 阈值纯物理计算得出（不设人工硬上限）；波场可达半径已改由
      // 渲染侧按岩体几何实测下发（sceneBuilder._syncInfluenceRadius），此处不覆盖。
      // 半透明渲染（1=场色上限 0.55 露出岩底）
      translucent: this.m._vibTranslucent ? 1 : 0,
      // 隧道马蹄形轮廓自由面（SDF 放大）：与 GPU tunnelFaceSdf / CPU tunnelFaceBoostFactor 同口径。
      // floorY=底板 grid 局部 y；archH=直墙高。coeff=0.6、λ=1.2（自由面近全反射的柔和近似）
      faceBoostCoeff: this.m._vibFaceBoostCoeff ?? 0.85,
      faceBoostLambda: this.m._vibFaceBoostLambda ?? 0.7,
      tunnelFloorY: Number(renderer?.center?.y) || 0,
      tunnelArchH: Math.max(1, Number(renderer?.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT),
      // 多装药源（各炮孔装药段）：驱动岩面非同心圆干涉波场；null 时着色器退化为单源
      sources,
      // 显示侧动态满量程展开因子：固定满刻度锚在近场峰值（应力）时全场塌缩成
      // 低端深蓝。这里先按解析代表分布给一个保守展开基线，等值线峰值场 P99.9
      // 到达后由 _buildAndPushContours 以实测分布精细化（见 _fieldAutoScale）。
      normAutoScale:
        this.m._fieldAutoScale ?? this.m._analyticAutoscale(params, sources, design, rockParams)
    })
    // 矢量箭头场显隐状态在场景重建后同步（几何对象会重建）
    this.m._pushVectorFieldNow(false)
    // 场景重建/参数变更后重挂已放置测点的 3D 标记（新 benchMesh 上）
    this.m._syncMonitorMarkers()
  }

  /**
   * 计算并下发矢量箭头场（P1-6）。采样平面 = 过爆心的水平切片(y=originY) +
   * 竖直切片(x=originX)，仅取岩体侧 (z ≥ 掌子面)；每点按当前模拟时刻 t 计算
   * 瞬时质点速度矢量（与热图同一物理模型：多源矢量叠加 + 自由面反射）。
   * 箭头随播放向前推进/摆动，直观展示波的传播方向。
   * @param {boolean} [force=true] - true=即便未开启也强制按当前几何重算并下发
   */
  pushVectorFieldNow(force = true) {
    const renderer = this.m._threeRenderer
    if (!renderer) return
    if (!this.m._vibVectorFieldOn) {
      renderer.clearVectorField?.()
      return
    }
    const sim = this.m._localVibrationSim
    if (!sim || !sim.gridXyz) return
    const t = Math.max(0, Number(this.m._vibLastStepT) || 0)
    const origin = sim.params.origin || [0, 0, 0]
    const [bmin, bmax] = [sim.boundsMin, sim.boundsMax]
    const W = Math.max(0.5, bmax[0] - bmin[0])
    const H = Math.max(0.5, bmax[1] - bmin[1])
    const D = Math.max(0.5, bmax[2] - bmin[2])
    const faceZ = Math.max(bmin[2], origin[2])
    // 采样密度（保持箭头不重叠、可读）
    const NX = 10
    const NY = 8
    const NZ = 12
    const pts = []
    // 水平切片 y = originY（拱部/底板看岩体横截面）
    for (let i = 0; i < NX; i++) {
      const x = bmin[0] + ((i + 0.5) / NX) * W
      for (let k = 0; k < NZ; k++) {
        const z = Math.max(faceZ, bmin[2] + ((k + 0.5) / NZ) * D)
        pts.push([x, origin[1], z])
      }
    }
    // 竖直切片 x = originX
    for (let j = 0; j < NY; j++) {
      const y = bmin[1] + ((j + 0.5) / NY) * H
      for (let k = 0; k < NZ; k++) {
        const z = Math.max(faceZ, bmin[2] + ((k + 0.5) / NZ) * D)
        pts.push([origin[0], y, z])
      }
    }
    const sources = this.m._computeBlastSources()
    if (!sources || !sources.length) {
      renderer.clearVectorField?.()
      return
    }
    const opt = {
      K: this.m._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this.m._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta:
        Number(this.m.dataset?.event?.rockParams?.attenuationP) ||
        this.m.dataset?.event?.beta ||
        0.02,
      visualBeta: 0.8,
      visualCp: 35,
      minStandoff: 0.5,
      reflections: this.m._vibReflectOn
        ? [{ axis: 'z', value: faceZ, coeff: this.m._vibReflectCoeff }]
        : null
    }
    const n = pts.length
    const originArr = new Float32Array(n * 3)
    const dirArr = new Float32Array(n * 3)
    const scaleArr = new Float32Array(n)
    let magMax = 0
    const mags = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      const v = computePointVector(p, sources, t, opt)
      originArr[i * 3] = p[0]
      originArr[i * 3 + 1] = p[1]
      originArr[i * 3 + 2] = p[2]
      dirArr[i * 3] = v.vx
      dirArr[i * 3 + 1] = v.vy
      dirArr[i * 3 + 2] = v.vz
      mags[i] = v.mag
      if (v.mag > magMax) magMax = v.mag
    }
    // 模长归一化：当前帧最大模 → 满长（0 全场未到达时给一个小参考刻度避免除零）
    const ref = Math.max(magMax, this.m._lastFieldRefs?.ppvRefMps ?? 0.15, 1e-4)
    for (let i = 0; i < n; i++) scaleArr[i] = mags[i] / ref
    renderer.setVectorField?.({ origin: originArr, dir: dirArr, scale: scaleArr })
  }

  /**
   * 隧道马蹄形轮廓自由面放大配置（本地模拟器 tunnelFace 选项）。
   * 与 GPU 侧 uFaceBoostCoeff/uFaceBoostLambda/uTunnelFloorY/uTunnelArchH 同口径
   * （见 _pushFieldPhysics 与 localVibrationSimulator.tunnelFaceBoostFactor）：
   * coeff=0.85、λ=0.7（自由面近全反射的贴壁增强带），archH=直墙高。
   * @returns {{coeff:number, lambda:number, halfW:number, floorY:number, archH:number}|null}
   */
  tunnelFaceConfig(renderer, width, floorY) {
    const coeff = Number(this.m._vibFaceBoostCoeff ?? 0.85)
    if (!(coeff > 0.001)) return null
    return {
      coeff,
      lambda: this.m._vibFaceBoostLambda ?? 0.7,
      halfW: Math.max(0.5, (Number(width) || 18) / 2),
      floorY: Number(floorY) || 0,
      archH: Math.max(1, Number(renderer?.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT)
    }
  }

  /**
   * 测点时程曲线计算参数（computeMonitorTimeHistory 的 options）。
   * 与体积场/热力图同一物理模型口径（K/α/视觉衰减/波速）。
   */
  monitorParams(rockParams = {}) {
    return {
      K: this.m._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this.m._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta: Number(rockParams.attenuationP) || this.m.dataset?.event?.beta || 0.02,
      visualBeta: this.m._localVibrationSim?.params.visualBeta,
      cp: Number(rockParams.pWaveSpeed) || 4500,
      visualCp: 35,
      minStandoff: 0.5
    }
  }

  /**
   * 计算单个局部点的三分量全时程（Vx/Vy/Vz/Vmag + PPV）。
   * 供"场点拾取 → 弹出时程曲线"使用：点击任意点即可看到该点振动波形。
   * @param {number[]} local - 岩体局部坐标 [x,y,z]
   * @returns {Object|null} 同 computeMonitorTimeHistory 输出
   */
  samplePointHistory(local) {
    const sources = this.m._computeBlastSources()
    if (!sources || !sources.length) return null
    const duration =
      this.m.getDurationS() || Number(this.m.dataset?.result?.simulationDurationS) || 10
    const rockParams = this.m.dataset?.event?.rockParams || {}
    const dt = 0.005
    const n = Math.max(16, Math.floor(duration / dt))
    const times = new Float32Array(n)
    for (let i = 0; i < n; i++) times[i] = i * dt
    return computeMonitorTimeHistory(
      [Number(local?.[0]) || 0, Number(local?.[1]) || 0, Number(local?.[2]) || 0],
      sources,
      times,
      this.m._monitorParams(rockParams)
    )
  }

  /**
   * 峰值场 P99.9 分位数 → 显示展开因子 S∈[1,80]。
   * S = ref / (P99.9 × 1.12)：让 P99.9 映射到约 89% 满刻度（header room 防顶冲），
   * 使低值区（外围）从深蓝展开为青绿、高值区（中心）保持黄红。
   * @param {Float32Array|number[]} values 当前模式单位下的逐顶点峰值
   * @param {number} ref 同一单位的满刻度参考
   * @returns {number}
   */
  p99Autoscale(values, ref) {
    const vals = []
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v > 1e-9) vals.push(v)
    }
    if (!vals.length) return 1
    vals.sort((a, b) => a - b)
    const idx = Math.min(vals.length - 1, Math.floor(vals.length * 0.999))
    const p99 = vals[idx]
    if (!(p99 > 0)) return 1
    return Math.min(80, Math.max(1, ref / (p99 * 1.12)))
  }
}
