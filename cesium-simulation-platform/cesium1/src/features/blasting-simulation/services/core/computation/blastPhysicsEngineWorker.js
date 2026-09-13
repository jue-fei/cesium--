/**
 * BlastPhysicsEngine 的 Web Worker 包装器
 *
 * - 优先使用 Worker 异步执行物理模拟（200+ 碎片 step + seekTo 快进）
 * - Worker 不可用时自动降级为同步主线程模式（与原 BlastPhysicsEngine 行为一致）
 * - 保持与 BlastPhysicsEngine 相同的 API（init/setTunnelBounds/step/activateAll/reset）
 * - getBodyStates 返回上次 Worker 推送的状态（可能延迟 1 帧 ≈ 16ms，用户不可感知）
 *
 * 性能提升：
 * - 60fps 持续渲染：物理计算移出主线程，帧时间从 18-25ms 降至 8-12ms
 * - seekTo 跳变：Worker 后台快进，主线程 UI 不卡顿（原主线程同步快进卡 800-1500ms）
 *
 * @example
 * const engine = new BlastPhysicsEngineWorker()
 * engine.setTunnelBounds(bounds)
 * engine.init(specs, positions, velocities)  // 异步，立即返回
 * engine.activateAll()
 * // 每帧调用（异步，不阻塞）：
 * engine.step(dt)
 * // 渲染时读缓存：
 * const states = engine.getBodyStates()
 * // 时间轴跳变：
 * engine.seekToAsync(targetTime, specs, positions, velocities, bounds)
 */

import { BlastPhysicsEngine } from './blastPhysicsEngine.js'
// 共享 LCG RNG（utils/rng.js 无 Three.js 依赖，可在 Worker/computation 层安全引入）
import { makeRng } from '../utils/rng.js'
import {
  DEFAULT_RESTITUTION,
  DEFAULT_FRICTION,
  DEFAULT_MAX_BOUNCES,
  REST_SPEED
} from '../blastDefaults.js'

// bodyStates Float32Array 字段布局常量（与 blastPhysicsWorker.js 保持一致）
const FLOATS_PER_BODY = 13
const FLAG_ALIVE = 0x01
const FLAG_LANDED = 0x02

export class BlastPhysicsEngineWorker {
  constructor(config = {}) {
    this._config = config
    /** @type {Float32Array|null} Worker 推送的最新 bodyStates（紧凑布局） */
    this._cachedStates = null
    /** @type {number} 缓存的碎片总数 */
    this._cachedCount = 0
    /** @type {Array<{x,y,z}>|null} 上次 init 的 positions（用于 fallback 同步 init） */
    this._lastInitData = null
    /** @type {Object|null} 上次 setTunnelBounds 的参数 */
    this._cachedBounds = null
    /** @type {Function|null} 碎片落地回调 */
    this._onBodyLanded = null
    /** @type {number} 请求 ID（用于 seekTo 防抖） */
    this._seekRequestId = 0
    /** @type {boolean} seekTo 是否正在进行 */
    this._seekInProgress = false
    /** @type {Function|null} seekTo 完成回调 */
    this._onSeekComplete = null
    /** @type {boolean} 是否使用 Worker */
    this._useWorker = false
    /** @type {BlastPhysicsEngine|null} 降级模式下的同步引擎 */
    this._syncEngine = null
    /** @type {Worker|null} */
    this._worker = null
    /** @type {Object|null} Worker 推送的最新能量统计缓存 */
    this._cachedEnergyStats = null
    /** @type {number|null} 上次 init 的随机种子（供 seekToAsync 复用，确保快进确定性） */
    this._randomSeed = null
    /** @type {boolean} Worker 是否已就绪（收到 ready 消息） */
    this._workerReady = false
    /** @type {number|null} Worker 就绪超时定时器（Rapier WASM 加载失败时降级） */
    this._readyTimer = null
    /**
     * 状态代数（epoch）：每次 reset/seekToAsync 递增。Worker 推送的 bodyStates/
     * seekComplete 携带产生该状态的 epoch，主线程只接受与当前 epoch 一致的数据，
     * 丢弃旧代数残留（如循环重播时仍在途的上一轮爆堆位置），避免碎片被
     * 陈旧物理状态覆盖导致"动画未重播"。
     */
    this._epoch = 0
    /**
     * 步进恢复模式：循环重播 reset 后置 true，期间同一时刻只允许 1 个 step
     * 在途（收到 bodyStates 前不再发送），避免 step 队列在 Worker 重建
     * 4500 个凸包期间不断堆积，把 reset/init 埋到队尾永远轮不到执行。
     */
    this._recoverSteps = false
    /** 恢复模式下当前是否有 step 在途 */
    this._stepInFlight = false
    /** 恢复模式超时定时器（5s 未收到 initDone 则强制退出） */
    this._recoverTimer = null
    /**
     * 关键帧回放数据（Worker 预烘焙完成后的缓存）：
     * { durationS, keyDt, keyCount, bodyCount, floatsPerBody, keys: Float32Array, landings: Float32Array }
     * 播放倍速/循环重播/进度条时长均基于该数据，动画与进度条解耦。
     */
    this._replay = null
    /** 当前回放帧解包对象数组（getBodyStates 返回它，fragmentRenderer/muckPile 无需改动） */
    this._replayCache = null
    /** 当前回放帧索引（避免同帧重复解包） */
    this._replayCacheKeyIdx = -1
    /**
     * 烘焙会话号：仅在 reset()（重建场景/新事件）时递增。
     * Worker 烘焙完成回传该会话号，主线程据此丢弃旧会话的陈旧关键帧；
     * resetToInitial（循环重播回 t=0）不改变会话号 → 同一事件的烘焙始终有效。
     */
    this._blastSession = 0
    /** 全速预计算进度（Worker 推送）：{ active, pct } */
    this._replayProgress = { active: false, pct: 0 }

    this._tryCreateWorker()
  }

  _tryCreateWorker() {
    try {
      if (typeof Worker === 'undefined') {
        this._fallbackToSync()
        return
      }
      // Vite 原生支持 ES Module Worker：new URL + import.meta.url
      this._worker = new Worker(new URL('./blastPhysicsWorker.js', import.meta.url), {
        type: 'module'
      })
      this._worker.onmessage = e => this._onMessage(e.data)
      this._worker.onerror = e => {
        console.warn('[BlastPhysics] Worker 运行时错误，降级为同步模式:', e.message)
        this._fallbackToSync()
      }
      this._useWorker = true
      // Rapier WASM 异步加载：6s 内未就绪视为加载失败，降级到手写引擎
      // 避免 Worker 静默挂起导致物理模拟永不推进（碎片悬空、无抛掷）
      this._readyTimer = setTimeout(() => {
        if (!this._workerReady) {
          console.warn('[BlastPhysics] Worker 6s 未就绪（Rapier WASM 加载超时），降级为同步模式')
          this._fallbackToSync()
        }
      }, 6000)
    } catch (err) {
      console.warn('[BlastPhysics] Worker 创建失败，降级为同步模式:', err.message)
      this._fallbackToSync()
    }
  }

  _fallbackToSync() {
    this._useWorker = false
    this._recoverSteps = false
    this._stepInFlight = false
    if (this._worker) {
      try {
        this._worker.terminate()
      } catch (_) {
        /* ignore */
      }
      this._worker = null
    }
    if (!this._syncEngine) {
      this._syncEngine = new BlastPhysicsEngine(this._config)
    }
    // 把缓存的状态迁移到同步引擎
    if (this._cachedBounds) this._syncEngine.setTunnelBounds(this._cachedBounds)
    if (this._onBodyLanded) this._syncEngine.onBodyLanded = this._onBodyLanded
    if (this._lastInitData) {
      const { specs, positions, velocities, randomSeed } = this._lastInitData
      if (randomSeed != null) {
        this._syncEngine._rng = makeRng(randomSeed)
      }
      this._syncEngine.init(specs, positions, velocities)
    }
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        // Worker 加载完成
        this._workerReady = true
        if (this._readyTimer) {
          clearTimeout(this._readyTimer)
          this._readyTimer = null
        }
        break
      case 'bodyStates':
        if (msg.epoch !== undefined && msg.epoch !== this._epoch) return
        this._cachedStates = msg.data
        this._cachedCount = msg.count
        this._stepInFlight = false
        // 直播 step 到达说明预计算已被打断（进入直播录制模式），清除"预计算中"指示
        this._replayProgress = { active: false, pct: 0 }
        break
      case 'seekComplete':
        if (msg.epoch !== undefined && msg.epoch !== this._epoch) return
        this._cachedStates = msg.data
        this._cachedCount = msg.count
        this._seekInProgress = false
        this._stepInFlight = false
        if (this._onSeekComplete) {
          const cb = this._onSeekComplete
          this._onSeekComplete = null
          cb(msg.count)
        }
        break
      case 'initDone':
        // 新代数初始化完成：退出步进恢复模式
        if (msg.epoch !== undefined && msg.epoch !== this._epoch) return
        this.endStepRecovery()
        break
      case 'bodyLanded':
        if (this._onBodyLanded) {
          this._onBodyLanded({ posX: msg.posX, posY: msg.posY, posZ: msg.posZ }, msg.impactSpeed)
        }
        break
      case 'energyStats':
        // Worker 推送的能量统计，缓存供主线程 getEnergyStats() 读取
        this._cachedEnergyStats = {
          totalKineticEnergy: msg.totalKineticEnergy,
          settledMassRatio: msg.settledMassRatio,
          timeSeries: msg.timeSeries
        }
        break
      case 'replayComplete':
        // Worker 关键帧预烘焙完成：缓存关键帧数据供回放采样。
        // keys 为 transfer 移交的 Float32Array（主线程侧直接可用）。
        // blastSession 校验：拒绝旧事件/旧重建残留的陈旧烘焙数据。
        if (msg.blastSession !== undefined && msg.blastSession !== this._blastSession) break
        this._replayProgress = { active: false, pct: 100 }
        this._replay = msg.keys
          ? {
              durationS: msg.durationS,
              keyDt: msg.keyDt,
              keyCount: msg.keyCount,
              bodyCount: msg.bodyCount,
              floatsPerBody: msg.floatsPerBody,
              keys: msg.keys,
              landings: msg.landings || null
            }
          : null
        this._replayCache = null
        this._replayCacheKeyIdx = -1
        if (this._replay) {
          console.warn(
            `[BlastPhysics] 关键帧回放就绪 duration=${msg.durationS.toFixed(1)}s ` +
              `keys=${msg.keyCount} bodies=${msg.bodyCount}`
          )
        }
        break
      case 'precomputeStart':
        // Worker 开始全速预计算整段物理
        this._replayProgress = { active: true, pct: 0 }
        break
      case 'replayProgress':
        // 预计算进度回报（主线程显示"物理预计算中 x%"）
        this._replayProgress = { active: !!msg.active, pct: Number(msg.pct) || 0 }
        break
      case 'stats':
        // 暂未使用，预留
        break
      case 'error':
        // Worker 内异常（含 Rapier WASM 加载失败）：降级为同步模式
        console.error('[BlastPhysics] Worker 内异常:', msg.message, msg.stack)
        this._fallbackToSync()
        break
      default:
        console.warn('[BlastPhysics] 未知 Worker 消息:', msg.type)
    }
  }

  _postMessage(msg, transfer = []) {
    if (this._worker) {
      this._worker.postMessage(msg, transfer)
    }
  }

  // ─── 兼容 BlastPhysicsEngine 的 API ────────────────────

  /** 设置碎片落地回调 */
  set onBodyLanded(fn) {
    this._onBodyLanded = fn
    if (this._useWorker) {
      this._postMessage({ type: 'setOnBodyLanded', enabled: !!fn })
    } else if (this._syncEngine) {
      this._syncEngine.onBodyLanded = fn
    }
  }

  get onBodyLanded() {
    return this._onBodyLanded
  }

  /**
   * 设置隧道截面边界
   * @param {Object} bounds - 与 BlastPhysicsEngine.setTunnelBounds 相同
   */
  setTunnelBounds(bounds) {
    this._cachedBounds = bounds
    if (this._useWorker) {
      this._postMessage({ type: 'setTunnelBounds', bounds })
    } else if (this._syncEngine) {
      this._syncEngine.setTunnelBounds(bounds)
    }
  }

  /**
   * 设置 15 种几何体变体的顶点数据（供 Rapier 凸包碰撞体使用）
   * 必须在 init 之前调用。顶点数据通过结构化克隆传输（非 Transferable，
   * 因为主线程渲染仍需保留原始几何体）。
   * @param {Array<Float32Array>} vertices - 15 个 Float32Array [x,y,z,...]
   */
  setGeometryVertices(vertices) {
    if (this._useWorker) {
      this._postMessage({ type: 'setGeometryVertices', vertices })
    }
    // 同步模式（手写引擎）不需要几何顶点，碰撞按等效球体计算
  }

  /**
   * 用碎片规格初始化物理引擎（异步，立即返回）
   * @param {FragmentSpec[]} specs
   * @param {Array<{x,y,z}>} positions
   * @param {Array<{x,y,z}>} velocities
   * @param {Object} [options]
   * @param {number} [options.randomSeed] - 随机种子，传入后物理引擎角速度/底板偏转可确定性复现
   */
  init(specs, positions, velocities, options = {}) {
    this._lastInitData = { specs, positions, velocities, randomSeed: options.randomSeed }
    this._cachedEnergyStats = null
    this._randomSeed = options.randomSeed ?? null
    if (this._useWorker) {
      const sBuf = packSpecs(specs)
      const pBuf = packVec3(positions)
      const vBuf = packVec3(velocities)
      this._postMessage(
        {
          type: 'init',
          specs: sBuf,
          positions: pBuf,
          velocities: vBuf,
          bounds: this._cachedBounds,
          randomSeed: options.randomSeed,
          blastTriggerTime: options.blastTriggerTime,
          blastSession: this._blastSession,
          requestId: 0,
          epoch: this._epoch
        },
        [sBuf.buffer, pBuf.buffer, vBuf.buffer]
      )
    } else if (this._syncEngine) {
      if (options.randomSeed != null) {
        this._syncEngine._rng = makeRng(options.randomSeed)
      }
      this._syncEngine.init(specs, positions, velocities)
      this._syncCacheFromEngine()
    }
  }

  /** 激活所有身体（爆破触发时调用） */
  activateAll() {
    if (this._useWorker) {
      this._postMessage({ type: 'activateAll' })
    } else if (this._syncEngine) {
      this._syncEngine.activateAll()
      this._syncCacheFromEngine()
    }
  }

  /** 进入步进恢复模式（循环重播 reset 后调用） */
  beginStepRecovery() {
    this._recoverSteps = true
    this._stepInFlight = false
    clearTimeout(this._recoverTimer)
    this._recoverTimer = setTimeout(() => {
      if (this._recoverSteps) {
        console.warn('[BlastPhysics] 步进恢复超时（5s），强制退出')
        this.endStepRecovery()
      }
    }, 5000)
  }

  /** 退出步进恢复模式（Worker init 完成、新代数数据开始到达时调用） */
  endStepRecovery() {
    this._recoverSteps = false
    this._stepInFlight = false
    clearTimeout(this._recoverTimer)
    this._recoverTimer = null
  }

  /** 设置碎片间碰撞开关（性能模式切换时调用） */
  setEnableInterCollision(value) {
    if (this._useWorker) {
      this._postMessage({ type: 'setConfig', enableInterCollision: !!value })
    }
    if (this._syncEngine) {
      this._syncEngine.enableInterCollision = !!value
    }
  }

  /**
   * 推进物理模拟一步（异步，立即返回）
   * 主线程下一帧渲染时通过 getBodyStates() 读取最新缓存状态。
   * 异步模式下，物理状态比渲染状态延迟 1 帧（≈16ms），用户不可感知。
   * @param {number} dt - 时间步长(s)
   */
  step(dt) {
    if (dt <= 0) return
    if (this._useWorker) {
      // 恢复模式：同一时刻最多 1 个 step 在途，避免队列堆积
      if (this._recoverSteps) {
        if (this._stepInFlight) return
        this._stepInFlight = true
      }
      this._postMessage({ type: 'step', dt, requestId: 0, epoch: this._epoch })
    } else if (this._syncEngine) {
      this._syncEngine.step(dt)
      this._syncCacheFromEngine()
    }
  }

  /**
   * 异步快进到指定时间（用于时间轴跳变）
   * 主线程立即返回，Worker 在后台执行 init + 循环 step，完成后通过 onSeekComplete 回调通知。
   * @param {number} targetTime - 目标模拟时间（秒）
   * @param {FragmentSpec[]} specs - 重新生成的碎片规格
   * @param {Array<{x,y,z}>} positions - 初始位置
   * @param {Array<{x,y,z}>} velocities - 初始速度
   * @param {Object} bounds - 隧道边界
   * @param {Function} [onComplete] - 快进完成回调，参数为碎片数量
   */
  seekToAsync(targetTime, specs, positions, velocities, bounds, onComplete) {
    this._seekRequestId++
    this._seekInProgress = true
    this._onSeekComplete = onComplete || null
    this._cachedBounds = bounds
    this._lastInitData = { specs, positions, velocities, randomSeed: this._randomSeed }
    this._cachedEnergyStats = null
    // seek 本质也是重建：递增 epoch，丢弃 seek 前在途的旧状态
    this._epoch++

    if (this._useWorker) {
      const sBuf = packSpecs(specs)
      const pBuf = packVec3(positions)
      const vBuf = packVec3(velocities)
      this._postMessage(
        {
          type: 'seekTo',
          targetTime,
          specs: sBuf,
          positions: pBuf,
          velocities: vBuf,
          bounds,
          randomSeed: this._randomSeed,
          requestId: this._seekRequestId,
          epoch: this._epoch
        },
        [sBuf.buffer, pBuf.buffer, vBuf.buffer]
      )
    } else if (this._syncEngine) {
      // 降级模式：主线程同步快进（会卡顿，但保证可用）
      this._syncEngine.reset()
      this._syncEngine.setTunnelBounds(bounds)
      if (this._randomSeed != null) {
        this._syncEngine._rng = makeRng(this._randomSeed)
      }
      this._syncEngine.init(specs, positions, velocities)
      this._syncEngine.activateAll()
      const step = 0.05
      let remaining = Math.max(0, targetTime)
      const maxSteps = 800
      let stepCount = 0
      while (remaining > 0 && stepCount < maxSteps) {
        const dt = Math.min(step, remaining)
        this._syncEngine.step(dt)
        remaining -= dt
        stepCount++
      }
      this._syncCacheFromEngine()
      this._seekInProgress = false
      if (onComplete) onComplete(this._cachedCount)
    }
  }

  /** seekTo 是否正在进行中 */
  get seekInProgress() {
    return this._seekInProgress
  }

  /** 强制清除 seekInProgress（超时保护用，正常流程不应调用） */
  set seekInProgress(v) {
    this._seekInProgress = v
    if (!v) this._onSeekComplete = null
  }

  /** 重置引擎 */
  reset() {
    // 递增 epoch：使在途的旧代数 bodyStates 全部失效
    this._epoch++
    // 重建场景/新事件：烘焙会话切换，旧会话的关键帧作废
    this._blastSession++
    this._cachedStates = null
    this._cachedCount = 0
    this._lastInitData = null
    this._seekInProgress = false
    this._onSeekComplete = null
    this._cachedEnergyStats = null
    // 旧关键帧数据作废（reset 通常紧接新 init，烘焙由新 init 重新启动）
    this._replay = null
    this._replayCache = null
    this._replayCacheKeyIdx = -1
    this._replayProgress = { active: false, pct: 0 }
    if (this._useWorker) {
      this._postMessage({ type: 'reset', epoch: this._epoch })
    } else if (this._syncEngine) {
      this._syncEngine.reset()
    }
  }

  /**
   * 原位重置到初始状态（循环重播回到 t=0 时调用）。
   * 复用 Worker 内已有刚体/凸包，仅重设位置/速度/启用状态并立即回传
   * bodyStates，避免 reset+init 重建数千凸包造成的长时间 n=0 冻结
   * （表现为"碎石回到掌子面后不抛掷"）。
   * @param {FragmentSpec[]} specs - 初始规格（与首次 init 一致）
   * @param {Array<{x,y,z}>} positions - 初始位置
   * @param {Array<{x,y,z}>} velocities - 初始速度
   */
  resetToInitial(specs, positions, velocities) {
    this._lastInitData = { specs, positions, velocities, randomSeed: this._randomSeed }
    this._cachedEnergyStats = null
    // 递增 epoch：使在途的旧代数 bodyStates 全部失效
    this._epoch++
    this._cachedStates = null
    this._cachedCount = 0
    this._seekInProgress = false
    this._onSeekComplete = null
    if (this._useWorker) {
      const pBuf = packVec3(positions)
      const vBuf = packVec3(velocities)
      this._postMessage(
        {
          type: 'resetToInitial',
          positions: pBuf,
          velocities: vBuf,
          requestId: 0,
          epoch: this._epoch
        },
        [pBuf.buffer, vBuf.buffer]
      )
    } else if (this._syncEngine) {
      this._syncEngine.reset()
      this._syncEngine.init(specs, positions, velocities)
      this._syncCacheFromEngine()
    }
  }

  /**
   * 获取所有身体状态（供渲染器使用）
   * 返回对象数组，与原 BlastPhysicsEngine.getBodyStates() 兼容。
   * Worker 模式下读取上次 Worker 推送的缓存（可能延迟 1 帧）；
   * 关键帧回放就绪后返回当前回放帧的状态（fragmentRenderer/muckPile 无需改动）。
   * @returns {Array<Object>}
   */
  getBodyStates() {
    if (this._useWorker) {
      if (this.isReplayReady() && this._replayCache) return this._replayCache
      return unpackBodyStates(this._cachedStates, this._cachedCount)
    } else if (this._syncEngine) {
      return this._syncEngine.getBodyStates()
    }
    return []
  }

  // ─── 关键帧回放（Replay）API ─────────────────────────

  /** 关键帧回放是否就绪（Worker 预烘焙完成） */
  isReplayReady() {
    return (
      this._useWorker &&
      !!this._replay &&
      !!this._replay.keys &&
      this._replay.keyCount > 0 &&
      this._replay.bodyCount > 0
    )
  }

  /** 回放总时长（全部落地 + 保持 3s，秒）；未就绪返回 null */
  getReplayDurationS() {
    return this.isReplayReady() ? this._replay.durationS : null
  }

  /** 全速预计算进度：{ active: boolean, pct: 0-100 }（供 UI 显示"物理预计算中"） */
  getReplayProgress() {
    return this._replayProgress
  }

  /**
   * 将回放采样到指定模拟时刻（秒）。
   * 命中最近关键帧并解包为 bodyStates 对象数组缓存，
   * 之后 getBodyStates() 直接返回缓存（同时刻重复调用零开销）。
   * @param {number} t - 模拟时间（秒）
   * @returns {boolean} 是否回放就绪并已采样
   */
  applyReplayAtTime(t) {
    if (!this.isReplayReady()) return false
    const r = this._replay
    const k = Math.round(t / r.keyDt)
    const idx = Math.max(0, Math.min(r.keyCount - 1, k))
    if (idx === this._replayCacheKeyIdx && this._replayCache) return true
    this._replayCache = this._unpackReplayKey(idx)
    this._replayCacheKeyIdx = idx
    return true
  }

  /**
   * 全量落地事件（预烘焙时记录）：布局 [t,x,y,z,speed] 每组 5 个 float。
   * 由渲染器按"落地时刻在 [上次游标, 当前]"区间消费，驱动撞击扬尘。
   * @returns {Float32Array|null}
   */
  getReplayLandings() {
    if (!this.isReplayReady() || !this._replay.landings) return null
    return this._replay.landings
  }

  /**
   * 解包第 idx 个关键帧为对象数组（与 unpackBodyStates 输出形状一致）。
   * 速度用相邻关键帧位置差分估算（供爆堆测量"飞行中碎片"过滤使用）。
   */
  _unpackReplayKey(idx) {
    const r = this._replay
    const keys = r.keys
    const stride = r.bodyCount * r.floatsPerBody
    const base = idx * stride
    const prevBase = idx > 0 ? (idx - 1) * stride : -1
    const specsArr = this._lastInitData ? this._lastInitData.specs : null
    const N = r.bodyCount
    const out = new Array(N)
    for (let i = 0; i < N; i++) {
      const o = base + i * r.floatsPerBody
      const flags = keys[o + 7]
      const alive = (flags & 1) !== 0
      const landed = (flags & 2) !== 0
      let velX = 0
      let velY = 0
      let velZ = 0
      if (prevBase >= 0) {
        const p = prevBase + i * r.floatsPerBody
        velX = (keys[o] - keys[p]) / r.keyDt
        velY = (keys[o + 1] - keys[p + 1]) / r.keyDt
        velZ = (keys[o + 2] - keys[p + 2]) / r.keyDt
      }
      out[i] = {
        posX: keys[o],
        posY: keys[o + 1],
        posZ: keys[o + 2],
        quatX: keys[o + 3],
        quatY: keys[o + 4],
        quatZ: keys[o + 5],
        quatW: keys[o + 6],
        velX,
        velY,
        velZ,
        flags,
        alive,
        landed,
        physSize: specsArr && specsArr[i] ? Number(specsArr[i].physSize) || 0.3 : 0.3,
        bounceCount: 0
      }
    }
    return out
  }

  /** 碎片总数（兼容 engine.bodies.length） */
  get bodies() {
    return { length: this._cachedCount }
  }

  /** 存活碎片数量 */
  get aliveFragmentCount() {
    return countFlags(this._cachedStates, FLAG_ALIVE)
  }

  /** 已落地碎片数量 */
  get landedFragmentCount() {
    return countFlags(this._cachedStates, FLAG_LANDED)
  }

  /**
   * 静止质量比（与 BlastPhysicsEngine.restMassRatio 同口径，供"抛掷结束"时长判据）。
   * Worker 模式用最近一帧缓存的位姿/速度/physSize 估算：密度对所有碎片一致时
   * 质量比与密度无关（m ∝ size³），故以 physSize³ 作权重。
   * @returns {number} 静止质量占比 0~1
   */
  get restMassRatio() {
    if (!this._useWorker) {
      return this._syncEngine?.restMassRatio ?? 0
    }
    const buf = this._cachedStates
    if (!buf || buf.length < FLOATS_PER_BODY) return 0
    const N = buf.length / FLOATS_PER_BODY
    let rest = 0
    let total = 0
    for (let i = 0; i < N; i++) {
      const o = i * FLOATS_PER_BODY
      const flags = buf[o + 10]
      if ((flags & FLAG_ALIVE) === 0) continue
      const size = Math.max(buf[o + 11], 0.01)
      const w = size * size * size
      total += w
      if (flags & FLAG_LANDED) {
        rest += w
        continue
      }
      const vx = buf[o + 7]
      const vy = buf[o + 8]
      const vz = buf[o + 9]
      if (vx * vx + vy * vy + vz * vz <= REST_SPEED * REST_SPEED) rest += w
    }
    return total > 0 ? rest / total : 0
  }

  /**
   * 获取能量统计：当前总动能、已落地质量占比、时间序列
   * Worker 模式下返回上次 Worker 推送的缓存（可能延迟 1 帧）；
   * 降级模式下直接委托同步引擎。
   * @returns {{totalKineticEnergy:number, settledMassRatio:number, timeSeries:Array}}
   */
  getEnergyStats() {
    if (this._useWorker) {
      return (
        this._cachedEnergyStats ?? {
          totalKineticEnergy: 0,
          settledMassRatio: 0,
          timeSeries: []
        }
      )
    }
    if (this._syncEngine) {
      return this._syncEngine.getEnergyStats()
    }
    return { totalKineticEnergy: 0, settledMassRatio: 0, timeSeries: [] }
  }

  /** 释放 Worker 资源 */
  dispose() {
    if (this._worker) {
      try {
        this._worker.terminate()
      } catch (_) {
        /* ignore */
      }
      this._worker = null
    }
    this._syncEngine = null
    this._cachedStates = null
    this._useWorker = false
    this._replay = null
    this._replayCache = null
    this._replayCacheKeyIdx = -1
  }

  // ─── 内部工具 ─────────────────────────────────────────

  /** 降级模式下从同步引擎同步缓存 */
  _syncCacheFromEngine() {
    if (!this._syncEngine) return
    const states = this._syncEngine.getBodyStates()
    this._cachedCount = states.length
    this._cachedStates = packBodyStatesFromObjects(states)
  }
}

// ─── 打包/解包工具函数 ─────────────────────────────────

/**
 * 打包 FragmentSpec 数组为 Float32Array
 * 布局：每碎片 9 个 float [physSize, density, restitution, friction, maxBounces, variantIndex, dispSize, colorR, delayTime]
 */
function packSpecs(specs) {
  const N = specs.length
  const buf = new Float32Array(N * 9)
  for (let i = 0; i < N; i++) {
    const s = specs[i]
    const o = i * 9
    buf[o] = s.physSize || 0.1
    buf[o + 1] = s.density || 2700
    buf[o + 2] = s.restitution ?? DEFAULT_RESTITUTION
    buf[o + 3] = s.friction ?? DEFAULT_FRICTION
    buf[o + 4] = s.maxBounces ?? DEFAULT_MAX_BOUNCES
    buf[o + 5] = s.variantIndex || 0
    buf[o + 6] = s.dispSize || 0.2
    buf[o + 7] = (s.color && s.color.r) || 0.5
    buf[o + 8] = Number(s.delayTime) || 0
  }
  return buf
}

/** 打包 {x,y,z} 数组为 Float32Array */
function packVec3(arr) {
  const N = arr.length
  const buf = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    const v = arr[i]
    const o = i * 3
    buf[o] = v.x || 0
    buf[o + 1] = v.y || 0
    buf[o + 2] = v.z || 0
  }
  return buf
}

/**
 * 解包 bodyStates Float32Array 为对象数组（与原 getBodyStates 返回格式兼容）
 * @param {Float32Array|null} buf
 * @param {number} count
 * @returns {Array<Object>}
 */
function unpackBodyStates(buf, count) {
  if (!buf || count === 0) return []
  const out = new Array(count)
  for (let i = 0; i < count; i++) {
    const o = i * FLOATS_PER_BODY
    out[i] = {
      posX: buf[o],
      posY: buf[o + 1],
      posZ: buf[o + 2],
      quatX: buf[o + 3],
      quatY: buf[o + 4],
      quatZ: buf[o + 5],
      quatW: buf[o + 6],
      velX: buf[o + 7],
      velY: buf[o + 8],
      velZ: buf[o + 9],
      alive: (buf[o + 10] & FLAG_ALIVE) !== 0,
      landed: (buf[o + 10] & FLAG_LANDED) !== 0,
      physSize: buf[o + 11],
      bounceCount: buf[o + 12]
    }
  }
  return out
}

/** 从对象数组打包为 Float32Array（降级模式下使用） */
function packBodyStatesFromObjects(states) {
  const N = states.length
  const buf = new Float32Array(N * FLOATS_PER_BODY)
  for (let i = 0; i < N; i++) {
    const s = states[i]
    const o = i * FLOATS_PER_BODY
    buf[o] = s.posX
    buf[o + 1] = s.posY
    buf[o + 2] = s.posZ
    buf[o + 3] = s.quatX
    buf[o + 4] = s.quatY
    buf[o + 5] = s.quatZ
    buf[o + 6] = s.quatW
    buf[o + 7] = s.velX || 0
    buf[o + 8] = s.velY || 0
    buf[o + 9] = s.velZ || 0
    let flags = 0
    if (s.alive) flags |= FLAG_ALIVE
    if (s.landed) flags |= FLAG_LANDED
    buf[o + 10] = flags
    buf[o + 11] = s.physSize || 0.1
    buf[o + 12] = s.bounceCount || 0
  }
  return buf
}

/** 从缓存中统计具有指定 flag 的碎片数量 */
function countFlags(buf, flag) {
  if (!buf) return 0
  const N = buf.length / FLOATS_PER_BODY
  let c = 0
  for (let i = 0; i < N; i++) {
    if ((buf[i * FLOATS_PER_BODY + 10] & flag) !== 0) c++
  }
  return c
}

export default BlastPhysicsEngineWorker
