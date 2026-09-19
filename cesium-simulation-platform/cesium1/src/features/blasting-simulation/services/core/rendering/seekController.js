/**
 * 时间轴跳变控制器（SeekController）
 *
 * 从 ThreeBlastingRenderer（门面）按职责域拆分的组合控制器之一，负责：
 *  - seekTo：时间轴定位入口（正常增量推进 / 回起点同步重置 / 跳变异步快进的分流）
 *  - _resetToStart：循环重播回到 t=0 的同步重置（回放关键帧采样或物理原位重置）
 *  - _asyncSeekTo：异步快进编排（特效 RAF 分块快进 + Worker 物理快进 + 回放直采）
 *  - _startSeekWatchdog/_clearSeekWatchdog/_cancelSeek：seek 阶段超时兜底与
 *    紧急取消（RAF/Worker 回调丢失时强制清除阻塞标志，防止永久卡死后续 seek）
 *
 * 职责边界：
 *  - 不持有任何仿真状态：simTime、_fieldTimeLocked、_seekBlocked、_seekRafId、
 *    _seekTimeout、_lastBlastParams、_lastFragmentData、_physicsEngine 等字段
 *    仍全部保存在门面实例上，经 this.r 访问。
 *  - 与其他控制器互不引用，仅经门面协作（seekTo 增量推进委托门面 update，
 *    快进渲染委托门面 renderFrame）。
 *  - 门面保留 seekTo 公共委托入口；私有方法由门面内部调用
 *    （构造函数 _onCtxLost → _cancelSeek、dispose → _clearSeekWatchdog）。
 */

export class SeekController {
  /**
   * @param {ThreeBlastingRenderer} renderer - 门面渲染器实例（经 this.r 访问门面状态与公共方法）
   */
  constructor(renderer) {
    this.r = renderer
  }

  /**
   * 将粒子系统定位到指定模拟时间（与时间轴同步）。
   * - 时间轴正常推进：增量更新粒子
   * - 时间轴暂停（targetTime ≈ simTime）：不更新，粒子静止
   * - 时间轴跳变（回退或大跨度前进）：异步重建并快进到 targetTime
   *
   * Web Worker 化后，跳变快进在 Worker 线程执行，主线程 UI 不卡顿。
   * 主线程同步快进特效（_effectManager），Worker 后台快进物理引擎，
   * Worker 完成后通过回调更新碎片 InstancedMesh。
   * @param {number} targetTime - 目标模拟时间（秒）
   */
  seekTo(targetTime) {
    if (!this.r.active) return
    const t = Math.max(0, Number(targetTime) || 0)
    const delta = t - this.r.simTime

    // 暂停或静止：不推进
    if (Math.abs(delta) < 0.001) return

    // 回到起点（循环重播）：同步重置，不走异步 Worker 快进。
    // 异步快进与主线程后续 update() 推进存在竞态——Worker 完成时主线程
    // simTime 已推进到爆破触发点后，碎片位置与掌子面/特效状态不一致，
    // 表现为"进度条重新循环但动画没有重播"。
    if (t === 0 && delta < 0) {
      this._resetToStart()
      return
    }

    // 回退或大跨度前进（>0.5s，相当于跳变）：异步重建并快进
    if (delta < 0 || delta > 0.5) {
      this._asyncSeekTo(t)
      return
    }

    // 正常增量推进
    this.r.update(delta)
  }

  /**
   * 同步重置到起爆前初始状态（循环重播回到 t=0 时调用）。
   * 不走异步 Worker 快进：targetTime=0 时快进 0 步无意义，且避免
   * 异步快进与主线程 update() 推进的竞态导致动画状态不一致。
   */
  _resetToStart() {
    if (!this.r._lastBlastParams) {
      console.warn('[BlastSim] _resetToStart 跳过：无 _lastBlastParams')
      return
    }
    if (!this.r._lastFragmentData) {
      console.warn('[BlastSim] _resetToStart 跳过：无 _lastFragmentData')
      return
    }
    this.r.simTime = 0
    this.r._fieldTimeLocked = true
    this.r._sceneBuilder?.setContourTime?.(0) // 等值线门控时间同步归零（防重播瞬间残留整幅旧线）
    this.r._sceneBuilder?.setFieldSimTime?.(0) // uSimTime 同步归零（解析外推波前门控重放）
    // 特效重置到 t=0
    if (this.r._lastEffectParams) {
      this.r._effectManager.clear()
      this.r._effectManager.init(this.r._lastEffectParams)
      for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
        this.r._effectManager.setVisible(layer, this.r.layerVisibility[layer] !== false)
      }
    }
    // 掌子面恢复未爆破状态
    this.r.blastTriggered = false
    this.r._sceneBuilder.applyBlastState(false)
    this.r._landAllAt = null

    // 回放模式：直接从预烘焙关键帧采样 t=0，瞬时完成、无竞态
    if (this.r._physicsEngine?.isReplayReady?.()) {
      this.r._physicsEngine.applyReplayAtTime(0)
      this.r._replayLandCursor = 0
      this.r._replayModeActive = true
      this.r._fragmentRenderer.updateFragmentMesh()
      this.r.renderFrame()
      this.r._fieldTimeLocked = false
      console.log('[BlastSim] 循环重播已重置（回放模式）', {
        replayDuration: this.r._physicsEngine.getReplayDurationS?.()
      })
      return
    }

    // 物理引擎原位重置到初始状态：复用已有刚体/凸包，仅重设位置与速度，
    // 避免 reset+init 重建数千凸包造成的长时间无物理状态（碎石不抛掷）
    const { specs, positions, velocities } = this.r._lastFragmentData
    this.r._physicsEngine.resetToInitial(specs, positions, velocities)
    this.r._physicsEngine.beginStepRecovery()
    // 立即用初始位置渲染碎片（不等 Worker 推送，避免一帧旧位置闪烁）
    this.r._fragmentRenderer.applyInitialPositions(positions)
    this.r.renderFrame()
    console.log('[BlastSim] 循环重播已重置', { fragmentCount: positions.length })
  }

  /**
   * 异步重建粒子系统并快进到指定时间（用于时间轴跳变）。
   *
   * 主线程：重建特效 + 同步快进 _effectManager 到 targetTime
   * Worker：后台 init + 循环 step 到 targetTime，完成后推送最终 bodyStates
   *
   * 快进期间碎片 InstancedMesh 暂不更新（Worker 未返回最终状态），
   * Worker 完成后立即渲染正确位置。
   */
  _asyncSeekTo(targetTime) {
    if (!this.r._lastBlastParams) return
    // 防止重复触发（用户连续拖动时间轴）。
    // _seekBlocked 覆盖 RAF 特效快进阶段；seekInProgress 覆盖 Worker 物理快进阶段。
    if (this.r._physicsEngine.seekInProgress || this.r._seekBlocked) return

    // 超时保护：RAF 回调或 Worker 回调丢失时，阻塞标志会永久阻塞后续 seekTo。
    // 与旧逻辑（在 _asyncSeekTo 开头起 3s 计时的 watchdog）不同：
    //  - RAF 特效快进阶段用较短 watchdog（该阶段主线程可控，正常 <1s 完成）；
    //  - Worker 物理快进阶段才真正消耗物理求解时间（Rapier 200+ 碎片 + 碎片间碰撞
    //    可能需数秒），watchdog 从 Worker 真正开始时起算并放宽到 10s，
    //    避免"合法但较慢的 seek"被误判超时而强制清除，进而反复重进 _asyncSeekTo。
    this._startSeekWatchdog('effect', 8000)

    // 不调用 initBlast（避免 clear 清除碎片 InstancedMesh 导致快进期间碎片消失）。
    // 只重置特效到 t=0 并快进，碎片保持当前位置，Worker 快进完成后更新到目标位置。
    this.r.simTime = 0
    // uSimTime 与播放时钟同步归零（此前只重置等值线时钟）：回跳 seek 后解析外推
    // 波前门控 gap = uSimTime - arrival 若仍用 seek 前的旧时间，波环位置/时变衰减
    // 与目标时刻的场纹理脱节。锁住 WS 尾帧的时间信任，uSimTime 由下方快进 tick
    // 逐帧推进到目标时刻。
    this.r._fieldTimeLocked = true
    this.r._sceneBuilder?.setContourTime?.(0) // 等值线门控时间同步归零
    this.r._sceneBuilder?.setFieldSimTime?.(0)
    if (this.r._lastEffectParams) {
      this.r._effectManager.clear()
      this.r._effectManager.init(this.r._lastEffectParams)
      for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
        this.r._effectManager.setVisible(layer, this.r.layerVisibility[layer] !== false)
      }
    }

    // 按目标时刻同步掌子面/待爆岩体可见状态：
    // 回退到起爆前应恢复完整掌子面+待爆岩体；跳过起爆点后应显示破碎掌子面+掏槽腔
    const blastJustTriggered = targetTime >= this.r.blastTriggerTime
    this.r.blastTriggered = blastJustTriggered
    this.r._sceneBuilder.applyBlastState(blastJustTriggered)

    // 主线程分块快进特效到 targetTime（requestAnimationFrame，避免长循环阻塞主线程）。
    // 特效不含物理，单步 0.05s；每帧最多执行 STEPS_PER_FRAME 步（约 16ms 工作量），
    // 剩余步骤在下一帧 requestAnimationFrame 回调中继续，完成后移交 Worker 物理快进。
    const fireLight = this.r._sceneBuilder.fireLight
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    const maxSteps = 800
    let stepCount = 0
    const STEPS_PER_FRAME = 16

    // 标记 RAF 阶段进行中，阻止此期间再次进入 _asyncSeekTo
    this.r._seekBlocked = true

    // 特效快进完成后启动 Worker 物理快进（保留原有 seekToAsync 调用与回调）。
    // 回放模式：跳过 Worker 重建/快进，直接采样预烘焙关键帧（瞬时完成、任意倍速）。
    const startWorkerSeek = () => {
      this.r._seekBlocked = false
      if (this.r._physicsEngine?.isReplayReady?.()) {
        this._clearSeekWatchdog()
        this.r.simTime = targetTime
        this.r._sceneBuilder?.setContourTime?.(targetTime) // 等值线门控时间随 seek 跳变
        // uSimTime 随 seek 跳变对齐（回放分支无快进 tick，需显式同步），
        // 同步后解锁恢复 WS 场帧时间的单调信任
        this.r._sceneBuilder?.setFieldSimTime?.(targetTime)
        this.r._fieldTimeLocked = false
        this.r._physicsEngine.applyReplayAtTime(targetTime)
        this.r._replayLandCursor = targetTime
        this.r._fragmentRenderer.updateFragmentMesh()
        this.r.renderFrame()
        return
      }
      // Worker 物理求解阶段单独起 watchdog（放宽到 10s，从真正开始时起算）
      this._startSeekWatchdog('physics', 10000)
      // Worker 异步快进物理引擎（后台 init + 循环 step）
      const { specs, positions, velocities } = this.r._lastFragmentData
      const bounds = this.r._lastPhysicsBounds
      this.r._physicsEngine.seekToAsync(targetTime, specs, positions, velocities, bounds, () => {
        // Worker 完成：清除 watchdog 并渲染一帧
        this._clearSeekWatchdog()
        // uSimTime 对齐目标时刻后解锁（快进 tick 已把播放时钟推进到 targetTime）
        this.r._sceneBuilder?.setFieldSimTime?.(this.r.simTime)
        this.r._fieldTimeLocked = false
        this.r._fragmentRenderer.updateFragmentMesh()
        this.r.renderFrame()
      })
    }

    const tick = () => {
      this.r._seekRafId = null
      // 每帧最多执行 STEPS_PER_FRAME 步，避免单帧工作量过大阻塞主线程
      let frameSteps = 0
      while (remaining > 0 && stepCount < maxSteps && frameSteps < STEPS_PER_FRAME) {
        const dt = Math.min(step, remaining)
        this.r.simTime += dt
        this.r._effectManager.update(dt, this.r.simTime)
        // 火光同步（加 NaN 守卫，与 update 方法一致）
        const fireIntensity = this.r._effectManager.getFireLightIntensity()
        if (Number.isFinite(fireIntensity)) {
          fireLight.intensity += (fireIntensity - fireLight.intensity) * 0.6
          if (fireLight.intensity < 0.01) fireLight.intensity = 0
        }
        remaining -= dt
        stepCount++
        frameSteps++
      }
      // uSimTime 跟随快进播放时钟（每 tick 一次即可）：解析外推波环/波前门控
      // 与场纹理同步重放，而非停留在 seek 前的旧时刻
      this.r._sceneBuilder?.setFieldSimTime?.(this.r.simTime)

      if (remaining > 0 && stepCount < maxSteps) {
        // 还有剩余步骤，下一帧继续
        this.r._seekRafId = requestAnimationFrame(tick)
      } else {
        // 全部完成（或达到步数上限），启动 Worker 物理快进
        startWorkerSeek()
      }
    }

    this.r._seekRafId = requestAnimationFrame(tick)
  }

  /**
   * 启动 seekTo 超时 watchdog。
   * 仅在 RAF/Worker 回调真正丢失时兜底强制清除阻塞标志，避免永久卡住后续 seek。
   * @param {'effect'|'physics'} kind - 当前阶段（仅用于日志）
   * @param {number} ms - 超时时长（毫秒）
   */
  _startSeekWatchdog(kind, ms) {
    this._clearSeekWatchdog()
    this.r._seekTimeout = setTimeout(() => {
      this.r._seekTimeout = null
      if (this.r._seekRafId) {
        cancelAnimationFrame(this.r._seekRafId)
        this.r._seekRafId = null
      }
      this.r._seekBlocked = false
      // 解除 seek 时间锁（uSimTime 停在归零值，锁死会让解析场波前永久全关）
      this.r._fieldTimeLocked = false
      if (this.r._physicsEngine && this.r._physicsEngine.seekInProgress) {
        console.warn(`[ThreeBlastingRenderer] seekTo(${kind}) 超时，强制清除阻塞标志`)
        this.r._physicsEngine.seekInProgress = false
      }
    }, ms)
  }

  _clearSeekWatchdog() {
    if (this.r._seekTimeout) {
      clearTimeout(this.r._seekTimeout)
      this.r._seekTimeout = null
    }
  }

  /** 取消进行中的 seek（上下文丢失等紧急场景），清理所有阻塞标志与定时器 */
  _cancelSeek() {
    this._clearSeekWatchdog()
    if (this.r._seekRafId) {
      cancelAnimationFrame(this.r._seekRafId)
      this.r._seekRafId = null
    }
    this.r._seekBlocked = false
    this.r._fieldTimeLocked = false
    if (this.r._physicsEngine) this.r._physicsEngine.seekInProgress = false
  }
}
