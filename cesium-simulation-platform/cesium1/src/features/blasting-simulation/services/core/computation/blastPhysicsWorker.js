/**
 * 爆破物理引擎 Web Worker 入口（Rapier 版）
 *
 * 在 Worker 线程中执行碎片物理模拟，使用 Rapier 凸包碰撞体 + PGS 求解器。
 * RAPIER.init() 完成前到达的消息由 messageQueue 缓存，完成后按顺序回放。
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'init', specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, randomSeed: number, requestId: number }
 *   { type: 'step', dt: number, requestId: number }
 *   { type: 'seekTo', targetTime: number, specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, randomSeed: number, requestId: number }
 *   { type: 'activateAll' }
 *   { type: 'reset' }
 *   { type: 'resetToInitial', positions: Float32Array, velocities: Float32Array, requestId: number, epoch: number }
 *   { type: 'setOnBodyLanded', enabled: boolean }
 *   { type: 'setGeometryVertices', vertices: Array<Float32Array> }
 *   { type: 'setConfig', enableInterCollision: boolean }
 *   { type: 'getStats', requestId: number }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'ready' }
 *   { type: 'bodyStates', data: Float32Array, count: number, requestId: number, epoch: number }
 *   { type: 'seekComplete', data: Float32Array, count: number, requestId: number, epoch: number }
 *   { type: 'bodyLanded', posX, posY, posZ, impactSpeed }
 *   { type: 'energyStats', totalKineticEnergy, settledMassRatio, timeSeries }
 *   { type: 'stats', total, alive, landed, requestId }
 *   { type: 'error', message, stack }
 *
 * bodyStates Float32Array 字段布局（每碎片 13 个 float）：
 *   [posX, posY, posZ, quatX, quatY, quatZ, quatW, velX, velY, velZ, flags, physSize, bounceCount]
 */

import RAPIER from '@dimforge/rapier3d-compat'
import { RapierPhysicsEngine } from './rapierPhysicsEngine.js'
// 共享 LCG RNG（utils/rng.js 无 Three.js 依赖，可在 Worker/computation 层安全引入）
import { makeRng } from '../utils/rng.js'
// 时长判据常量单源（渲染器直播实测侧共用同一组值，避免两侧口径漂移）
import {
  SETTLE_REST_MASS_RATIO as REPLAY_SETTLE_REST_RATIO,
  HOLD_AFTER_SETTLED as REPLAY_HOLD_AFTER_SETTLED,
  REPLAY_MAX_DURATION
} from '../blastDefaults.js'

let engine = null
let bodyLandedEnabled = false
let lastEnergySeriesLen = 0
// 当前状态代数：reset/init 时更新；旧代数的 step 消息直接跳过，
// 避免循环重播时 Worker 还在处理上一轮遗留的步进队列、迟迟不执行重初始化。
let currentEpoch = null

// ─── 关键帧录制（Replay）───────────────────────────
// 方案：不再单独烘焙（大事件求解太慢 + 空闲门控会被连续播放饿死）。
// 直播 step 本身就是完整物理演化——每步 0.05s 求解后把状态录成关键帧，
// 抛掷结束（静止质量比达标）+ 保持 REPLAY_HOLD_AFTER_SETTLED 后打包推送主线程
// → 回放模式启用：
//  - 倍速播放不再受逐 step 求解吞吐限制（动画与进度条同步）；
//  - 循环重播回到 t=0 瞬时完成（无竞态、无需重建物理）；
//  - 进度条时长 = 抛掷结束 + 保持（随事件自适应），与真实物理事件同尺度。
// 录制零额外物理开销（只打包每步已算好的状态），首次完整播放结束即就绪。
const REPLAY_KEY_DT = 0.05 // 关键帧间隔(s)，与播放帧网格一致
// 抛掷结束后再录制多久(s)：只用于让观众看清爆堆成形，不是"等最后一颗石头"。
// 旧值 3s 叠加在已偏长的落地判据上，使时间条明显超出真实事件。
// （REPLAY_HOLD_AFTER_SETTLED / REPLAY_SETTLE_REST_RATIO / REPLAY_MAX_DURATION
//   三个常量由 blastDefaults.js 单源 import，渲染器直播实测侧用同一组值。）
const REPLAY_FLOATS_PER_BODY = 8 // 每碎片每关键帧 float 数 [px,py,pz,qx,qy,qz,qw,flags]
const REPLAY_MAX_KEYS = Math.ceil(REPLAY_MAX_DURATION / REPLAY_KEY_DT) + 4
// 静止比抖动确认步数：静止比存在 ~1e-4 量级抖动（碎片被安息角判定解除支撑、
// 又在斜面上重新滚动），单帧穿越阈值可能是尖峰 → 要求连续 N 步达标才锁定，
// 避免提前截断动画。3 步 = 0.15s，远小于事件尺度。
const SETTLE_CONFIRM_STEPS = 3

let replayKeyChunks = [] // Float32Array[]（每关键帧一块，顺序 = 录制顺序）
let replayLandingList = [] // [t,x,y,z,speed, ...]（每碎片一次落地事件）
let replayRecording = false // 是否在录制关键帧
let replaySettledAt = -1 // 抛掷结束（静止比达标）时刻(s)
let replaySettleConfirm = 0 // 连续达标步数（抗抖动尖峰）
let replaySession = null // 对应的烘焙会话号（主线程据此丢弃陈旧数据）

// ─── 全速预计算（Precompute）──────────────────────
// init 后立刻全速推进物理（分块让出事件循环），边算边录关键帧；
// 完成后推送 replayComplete → 主线程进入纯关键帧回放（播放/倍速/循环/
// 拖拽/时长全部与实时求解解耦，且不受 2000+ 碎片求解速度拖累）。
let precomputing = false // 预计算进行中
let precomputeTriggered = false // 预计算内是否已激活（起爆点 0.1s）
let precomputeChunkScheduled = false
// 最近一次 init/seek 的初始位置/速度（预计算被直播打断时把引擎重置回 t=0）
let lastInitPosVel = { positions: null, velocities: null }
const PRECOMPUTE_CHUNK = 64 // 每块最多推进的步数
const PRECOMPUTE_PROGRESS_EVERY = 8 // 每多少步上报一次进度
const PRECOMPUTE_ESTIMATE_S = 5 // 进度百分比估算基准（约一版事件的抛掷结束+保持）
const PRECOMPUTE_BLAST_TRIGGER = 0.1 // 预计算内起爆激活时刻（与主线程 blastTriggerTime 一致）

// ─── 工具：解包主线程传来的 Float32Array ─────────────────
function unpackSpecs(buf) {
  const N = buf.length / 9
  const out = new Array(N)
  for (let i = 0; i < N; i++) {
    const o = i * 9
    out[i] = {
      physSize: buf[o],
      density: buf[o + 1],
      restitution: buf[o + 2],
      friction: buf[o + 3],
      maxBounces: buf[o + 4],
      variantIndex: buf[o + 5],
      dispSize: buf[o + 6],
      colorR: buf[o + 7],
      delayTime: buf[o + 8]
    }
  }
  return out
}

function unpackVec3(buf) {
  const N = buf.length / 3
  const out = new Array(N)
  for (let i = 0; i < N; i++) {
    const o = i * 3
    out[i] = { x: buf[o], y: buf[o + 1], z: buf[o + 2] }
  }
  return out
}

// ─── 工具：打包 bodyStates 为 Float32Array ───────────────
function packBodyStates(bodies) {
  const N = bodies.length
  const buf = new Float32Array(N * 13)
  for (let i = 0; i < N; i++) {
    const b = bodies[i]
    const o = i * 13
    buf[o] = b.posX
    buf[o + 1] = b.posY
    buf[o + 2] = b.posZ
    buf[o + 3] = b.quatX
    buf[o + 4] = b.quatY
    buf[o + 5] = b.quatZ
    buf[o + 6] = b.quatW
    buf[o + 7] = b.velX
    buf[o + 8] = b.velY
    buf[o + 9] = b.velZ
    buf[o + 10] = b.flags
    buf[o + 11] = b.physSize
    buf[o + 12] = b.bounceCount
  }
  return buf
}

function sendBodyStates(requestId, epoch) {
  const states = engine.getBodyStates()
  const buf = packBodyStates(states)
  self.postMessage({ type: 'bodyStates', data: buf, count: states.length, requestId, epoch }, [
    buf.buffer
  ])
}

function sendEnergyStats() {
  const stats = engine.getEnergyStats()
  if (stats.timeSeries.length === lastEnergySeriesLen) return
  lastEnergySeriesLen = stats.timeSeries.length
  self.postMessage({
    type: 'energyStats',
    totalKineticEnergy: stats.totalKineticEnergy,
    settledMassRatio: stats.settledMassRatio,
    timeSeries: stats.timeSeries
  })
}

// ─── 关键帧录制：开启/录制/完成 ─────────────────────

/** 清空当前录制缓冲（下次录制重新起播） */
function clearReplayRecording() {
  replayKeyChunks = []
  replayLandingList = []
  replaySettledAt = -1
  replaySettleConfirm = 0
  replayRecording = false
  replaySession = null
}

/** 开启新一轮录制（init/resetToInitial/seekTo 起播时调用），并录制 t=0 首帧 */
function startReplayRecording(session) {
  clearReplayRecording()
  replayRecording = true
  replaySession = session == null ? null : session
  pushReplayKey()
}

/** 录制当前引擎状态为一块关键帧（每步 0.05s 求解后调用） */
function pushReplayKey() {
  const states = engine.getBodyStates()
  const buf = new Float32Array(states.length * REPLAY_FLOATS_PER_BODY)
  for (let i = 0; i < states.length; i++) {
    const s = states[i]
    const o = i * REPLAY_FLOATS_PER_BODY
    buf[o] = s.posX
    buf[o + 1] = s.posY
    buf[o + 2] = s.posZ
    buf[o + 3] = s.quatX
    buf[o + 4] = s.quatY
    buf[o + 5] = s.quatZ
    buf[o + 6] = s.quatW
    buf[o + 7] = s.flags
  }
  replayKeyChunks.push(buf)
}

/**
 * 每个 0.05s 直播 step 结束后调用：录制关键帧并检测完成
 * （全部落地 + 保持 3s，或达到时长/帧数上限 → 打包推送主线程）。
 * @returns {boolean} 是否已结束录制
 */
function recordStepIfNeeded() {
  if (!replayRecording) return false
  pushReplayKey()
  const total = engine._fragmentBodies.length
  // 抛掷结束判据：质量加权静止比 ≥ REPLAY_SETTLE_REST_RATIO（爆堆成形），
  // 且连续 SETTLE_CONFIRM_STEPS 步达标（抗静止比抖动尖峰）。
  // 不用"99% 碎片 FLAG_LANDED 计数"——该计数存在平台期（约 0.7% 的边角石永不
  // 置位），真实布孔下 99% 可能永不达成 → 时长回退到 REPLAY_MAX_DURATION，
  // 时间条虚长数倍（用户实测根因）。
  if (replaySettledAt < 0) {
    const restRatio = total > 0 ? engine.restMassRatio : 0
    replaySettleConfirm = restRatio >= REPLAY_SETTLE_REST_RATIO ? replaySettleConfirm + 1 : 0
    if (replaySettleConfirm >= SETTLE_CONFIRM_STEPS) replaySettledAt = engine.simTime
  }
  const done =
    (replaySettledAt >= 0 && engine.simTime - replaySettledAt >= REPLAY_HOLD_AFTER_SETTLED) ||
    engine.simTime >= REPLAY_MAX_DURATION ||
    replayKeyChunks.length >= REPLAY_MAX_KEYS
  if (done) {
    finishReplay()
    return true
  }
  return false
}

/** 录制完成：拼接关键帧与落地事件并推送主线程 */
function finishReplay() {
  if (!replayRecording) return
  const keyCount = replayKeyChunks.length
  const bodyCount = engine._fragmentBodies.length
  if (keyCount <= 0 || bodyCount <= 0) {
    clearReplayRecording()
    return
  }
  const durationS = Math.min(
    REPLAY_MAX_DURATION,
    replaySettledAt >= 0 ? replaySettledAt + REPLAY_HOLD_AFTER_SETTLED : engine.simTime
  )
  const total = keyCount * bodyCount * REPLAY_FLOATS_PER_BODY
  const keys = new Float32Array(total)
  let off = 0
  for (const chunk of replayKeyChunks) {
    keys.set(chunk, off)
    off += chunk.length
  }
  const landings = new Float32Array(replayLandingList)
  const meta = {
    type: 'replayComplete',
    durationS,
    keyDt: REPLAY_KEY_DT,
    keyCount,
    bodyCount,
    floatsPerBody: REPLAY_FLOATS_PER_BODY,
    landings,
    blastSession: replaySession
  }
  clearReplayRecording()
  try {
    // 复用 transfer：keys 一次性移交主线程（避免大数组结构化克隆拷贝）
    self.postMessage({ ...meta, keys }, [keys.buffer])
  } catch (err) {
    // 超大 buffer 跨线程失败时降级为结构化克隆
    try {
      self.postMessage(meta)
    } catch (_) {
      /* ignore */
    }
  }
  console.warn(
    `[BlastPhysicsWorker] 关键帧录制完成 duration=${durationS.toFixed(1)}s keys=${keyCount}`
  )
}

// ─── 全速预计算驱动 ─────────────────────────────────

/** 上报预计算进度（主线程据此显示"物理预计算中 x%"） */
function postPrecomputeProgress() {
  const pct = Math.min(100, Math.round((engine.simTime / PRECOMPUTE_ESTIMATE_S) * 100))
  self.postMessage({ type: 'replayProgress', active: true, pct, simTime: engine.simTime })
}

/** 启动全速预计算（init 后立即调用）：边推进物理边录制关键帧 */
function startPrecompute(session) {
  precomputing = true
  precomputeTriggered = false
  startReplayRecording(session)
  console.warn(
    `[BlastPhysicsWorker] 预计算启动 bodies=${engine._fragmentBodies.length} session=${session}`
  )
  self.postMessage({ type: 'precomputeStart', active: true })
  if (!precomputeChunkScheduled) {
    precomputeChunkScheduled = true
    setTimeout(runPrecomputeChunk, 0)
  }
}

/** 预计算被直播打断（用户提前点播放/拖进度条）：把引擎重置回 t=0 交给直播逐步推进 */
function abortPrecomputeForLive() {
  if (!precomputing) return
  precomputing = false
  precomputeChunkScheduled = false
  // 重置引擎到初始状态并重新录制 t=0，保证直播步进从 0 继续（与主线程 simTime 对齐）。
  // 预计算只在 init 后启动，lastInitPosVel 一定存在；缺失时保守跳过重置。
  if (lastInitPosVel.positions && lastInitPosVel.velocities) {
    engine.resetToInitial(lastInitPosVel.positions, lastInitPosVel.velocities)
  }
  replayKeyChunks = []
  replayLandingList = []
  replaySettledAt = -1
  replaySettleConfirm = 0
  replayRecording = true
  pushReplayKey()
}

function runPrecomputeChunk() {
  precomputeChunkScheduled = false
  if (!precomputing) return
  let n = 0
  let stepsSinceProgress = 0
  while (n < PRECOMPUTE_CHUNK && precomputing) {
    if (!precomputeTriggered && engine.simTime >= PRECOMPUTE_BLAST_TRIGGER) {
      engine.activateAll()
      precomputeTriggered = true
    }
    engine.step(REPLAY_KEY_DT)
    n++
    stepsSinceProgress++
    // 录制完成（全部落地 + 3s 或达上限）→ 结束预计算
    if (recordStepIfNeeded()) {
      precomputing = false
      return
    }
    if (stepsSinceProgress >= PRECOMPUTE_PROGRESS_EVERY) {
      postPrecomputeProgress()
      stepsSinceProgress = 0
    }
  }
  if (precomputing) {
    precomputeChunkScheduled = true
    setTimeout(runPrecomputeChunk, 0)
  }
}

// ─── 顶层消息缓冲 ───────────────────────────────────────
// RAPIER WASM 异步加载期间若未注册 onmessage，主线程消息会丢失。
// 此处 Worker 启动时立即注册 onmessage，将消息缓存到队列，
// init 完成后按顺序回放。
const messageQueue = []
let engineReady = false

self.onmessage = e => {
  if (!engineReady) {
    messageQueue.push(e.data)
    return
  }
  handleMessage(e.data)
}

function handleMessage(msg) {
  try {
    switch (msg.type) {
      case 'init': {
        const specs = unpackSpecs(msg.specs)
        const positions = unpackVec3(msg.positions)
        const velocities = unpackVec3(msg.velocities)
        if (msg.randomSeed != null) {
          engine._rng = makeRng(msg.randomSeed)
        }
        if (msg.bounds) engine.setTunnelBounds(msg.bounds)
        engine.init(specs, positions, velocities)
        lastInitPosVel = { positions, velocities }
        lastEnergySeriesLen = 0
        currentEpoch = msg.epoch
        sendBodyStates(msg.requestId, msg.epoch)
        // 通知主线程：新代数初始化完成，可退出步进恢复模式
        self.postMessage({ type: 'initDone', epoch: msg.epoch })
        // 全速预计算整段物理（边算边录关键帧）：完成后主线程进入纯关键帧回放，
        // 播放/倍速/循环/拖拽/时长全部与实时求解解耦
        startPrecompute(msg.blastSession)
        break
      }
      case 'step': {
        // 旧代数步进直接跳过（循环重播后的新 init 前遗留的上一轮步进无意义）
        if (currentEpoch !== null && msg.epoch !== undefined && msg.epoch !== currentEpoch) break
        // 预计算未完成时用户开始直播播放：放弃预计算，引擎重置回 t=0 交回直播逐步推进
        if (precomputing) abortPrecomputeForLive()
        engine.step(msg.dt)
        sendBodyStates(msg.requestId, msg.epoch)
        sendEnergyStats()
        // 关键帧录制：仅记录标准 0.05s 播放步长（滑块大跳的非标准步长会破坏
        // 关键帧网格，此时清空重录，保证录制序列始终是连贯的 0..T 演化）
        if (replayRecording && Math.abs(msg.dt - REPLAY_KEY_DT) >= 1e-6) {
          clearReplayRecording()
        } else {
          recordStepIfNeeded()
        }
        break
      }
      case 'seekTo': {
        doSeekTo(msg)
        break
      }
      case 'activateAll': {
        engine.activateAll()
        break
      }
      case 'setTunnelBounds': {
        if (msg.bounds) engine.setTunnelBounds(msg.bounds)
        break
      }
      case 'reset': {
        engine.reset()
        lastEnergySeriesLen = 0
        currentEpoch = msg.epoch
        // 重置/重建场景：停止预计算并作废旧录制数据，待新 init 后重新预计算
        precomputing = false
        precomputeChunkScheduled = false
        clearReplayRecording()
        break
      }
      case 'resetToInitial': {
        // 循环重播回到 t=0：原位重置已有刚体（不重建凸包，秒级完成），
        // 立即回传 bodyStates 供主线程恢复碎片渲染。
        const positions = unpackVec3(msg.positions)
        const velocities = unpackVec3(msg.velocities)
        engine.resetToInitial(positions, velocities)
        lastEnergySeriesLen = 0
        currentEpoch = msg.epoch
        sendBodyStates(msg.requestId, msg.epoch)
        self.postMessage({ type: 'initDone', epoch: msg.epoch })
        // 同一次爆破的循环重播：重新录制（会话号不变，仅清空缓冲从 t=0 重录）
        replayKeyChunks = []
        replayLandingList = []
        replaySettledAt = -1
        replaySettleConfirm = 0
        replayRecording = true
        pushReplayKey()
        break
      }
      case 'setConfig': {
        if (msg.enableInterCollision !== undefined) {
          engine.setEnableInterCollision(msg.enableInterCollision)
        }
        break
      }
      case 'setGeometryVertices': {
        engine.setGeometryVertices(msg.vertices)
        break
      }
      case 'setOnBodyLanded': {
        bodyLandedEnabled = msg.enabled
        // 无论开关如何都挂接落地回调：录制模式下把落地事件写入关键帧回放数据
        // （供回放时驱动撞击扬尘），postMessage 仅在开关开启时转发给主线程。
        engine.onBodyLanded = (body, speed) => {
          if (replayRecording) {
            replayLandingList.push(
              engine.simTime,
              body.posX,
              body.posY,
              body.posZ,
              Number(speed) || 0
            )
          }
          if (bodyLandedEnabled) {
            self.postMessage({
              type: 'bodyLanded',
              posX: body.posX,
              posY: body.posY,
              posZ: body.posZ,
              impactSpeed: speed
            })
          }
        }
        break
      }
      case 'getStats': {
        self.postMessage({
          type: 'stats',
          total: engine._fragmentBodies.length,
          alive: engine.aliveFragmentCount,
          landed: engine.landedFragmentCount,
          requestId: msg.requestId
        })
        break
      }
      default: {
        console.warn('[BlastPhysicsWorker] 未知消息类型:', msg.type)
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err.message,
      stack: err.stack
    })
  }
}

// ─── 初始化 Rapier WASM，完成后回放缓存的消息 ────────────
RAPIER.init()
  .then(() => {
    engine = new RapierPhysicsEngine()
    engineReady = true
    // 回放 RAPIER.init() 期间缓存的所有消息（按发送顺序）
    const queued = messageQueue.splice(0)
    for (const msg of queued) {
      handleMessage(msg)
    }
    // 通知主线程 Worker 已就绪
    self.postMessage({ type: 'ready' })
  })
  .catch(err => {
    // WASM 加载失败：通知主线程降级到手写物理引擎，避免消息永久排队
    console.error('[BlastPhysicsWorker] Rapier WASM 初始化失败:', err?.message || err)
    self.postMessage({
      type: 'error',
      message: `Rapier WASM 初始化失败: ${err?.message || err}`,
      stack: err?.stack
    })
  })

/**
 * 执行 seekTo 快进：用主线程传来的 specs/positions/velocities 重新 init，
 * 然后循环 step 到 targetTime，最后返回最终 bodyStates。
 *
 * 分块 + 让出执行权：避免 800 步 Rapier 求解一次性阻塞 Worker 事件循环，
 * 使快进期间仍能及时处理主线程的 step 消息（正在播放的动画不被冻结）。
 */
function doSeekTo(msg) {
  const { targetTime, specs, positions, velocities, bounds, requestId, randomSeed } = msg

  // 用户拖动进度条：放弃进行中的预计算
  precomputing = false
  precomputeChunkScheduled = false

  engine.reset()
  currentEpoch = msg.epoch
  if (randomSeed != null) {
    engine._rng = makeRng(randomSeed)
  }
  if (bounds) engine.setTunnelBounds(bounds)
  const specObjs = unpackSpecs(specs)
  const posObjs = unpackVec3(positions)
  const velObjs = unpackVec3(velocities)
  engine.init(specObjs, posObjs, velObjs)
  lastInitPosVel = { positions: posObjs, velocities: velObjs }
  engine.activateAll()
  lastEnergySeriesLen = 0
  // seek 重建后录制从 t=0 重新开始（快进步进同样按 0.05 网格录制；
  // 会话号不变——seek 属于同一事件，旧会话关键帧仍有效）
  replayKeyChunks = []
  replayLandingList = []
  replaySettledAt = -1
  replaySettleConfirm = 0
  replayRecording = true
  pushReplayKey()

  const step = 0.05
  let remaining = Math.max(0, targetTime)
  const maxSteps = 800
  let stepCount = 0
  // 每块最多 64 步，块间 setTimeout(0) 让出事件循环，保持 Worker 可响应
  const CHUNK = 64

  const runChunk = () => {
    let n = 0
    while (remaining > 0 && stepCount < maxSteps && n < CHUNK) {
      const dt = Math.min(step, remaining)
      engine.step(dt)
      remaining -= dt
      stepCount++
      n++
      if (replayRecording && Math.abs(dt - REPLAY_KEY_DT) < 1e-6 && recordStepIfNeeded()) {
        // 录制已完成（seek 恰好推进到全部落地+3s 之后）：结束循环
        remaining = 0
        break
      }
    }
    if (remaining > 0 && stepCount < maxSteps) {
      setTimeout(runChunk, 0)
    } else {
      const states = engine.getBodyStates()
      const buf = packBodyStates(states)
      self.postMessage(
        { type: 'seekComplete', data: buf, count: states.length, requestId, epoch: msg.epoch },
        [buf.buffer]
      )
      sendEnergyStats()
    }
  }
  runChunk()
}
