/**
 * 爆破物理引擎 Web Worker 入口（Rapier 版）
 *
 * 在 Worker 线程中执行碎片物理模拟，使用 Rapier 凸包碰撞体 + PGS 求解器。
 * RAPIER.init() 完成后才注册 onmessage，之前的消息由浏览器队列缓冲。
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'init', specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, randomSeed: number, requestId: number }
 *   { type: 'step', dt: number, requestId: number }
 *   { type: 'seekTo', targetTime: number, specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, randomSeed: number, requestId: number }
 *   { type: 'activateAll' }
 *   { type: 'reset' }
 *   { type: 'setOnBodyLanded', enabled: boolean }
 *   { type: 'setGeometryVertices', vertices: Array<Float32Array> }
 *   { type: 'setConfig', enableInterCollision: boolean }
 *   { type: 'getStats', requestId: number }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'ready' }
 *   { type: 'bodyStates', data: Float32Array, count: number, requestId: number }
 *   { type: 'seekComplete', data: Float32Array, count: number, requestId: number }
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

const FLAG_ALIVE = 0x01
const FLAG_LANDED = 0x02

let engine = null
let bodyLandedEnabled = false
let lastEnergySeriesLen = 0
let cachedGeometryVertices = null

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

function sendBodyStates(requestId) {
  const states = engine.getBodyStates()
  const buf = packBodyStates(states)
  self.postMessage({ type: 'bodyStates', data: buf, count: states.length, requestId }, [
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

// ─── 初始化 Rapier WASM，完成后注册消息处理 ──────────────
RAPIER.init().then(() => {
  engine = new RapierPhysicsEngine()
  // 如果在 RAPIER.init 期间已收到几何顶点，现在注入
  if (cachedGeometryVertices) {
    engine.setGeometryVertices(cachedGeometryVertices)
    cachedGeometryVertices = null
  }

  self.onmessage = (e) => {
    const msg = e.data
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
          lastEnergySeriesLen = 0
          sendBodyStates(msg.requestId)
          break
        }
        case 'step': {
          engine.step(msg.dt)
          sendBodyStates(msg.requestId)
          sendEnergyStats()
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
          break
        }
        case 'setConfig': {
          if (msg.enableInterCollision !== undefined) {
            engine.setEnableInterCollision(msg.enableInterCollision)
          }
          break
        }
        case 'setGeometryVertices': {
          // 存储 15 种几何体变体的顶点数据（Transferable Float32Array）
          engine.setGeometryVertices(msg.vertices)
          break
        }
        case 'setOnBodyLanded': {
          bodyLandedEnabled = msg.enabled
          engine.onBodyLanded = bodyLandedEnabled
            ? (body, speed) => {
                self.postMessage({
                  type: 'bodyLanded',
                  posX: body.posX,
                  posY: body.posY,
                  posZ: body.posZ,
                  impactSpeed: speed
                })
              }
            : null
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

  // 通知主线程 Worker 已就绪
  self.postMessage({ type: 'ready' })
})

/**
 * 执行 seekTo 快进：用主线程传来的 specs/positions/velocities 重新 init，
 * 然后循环 step 到 targetTime，最后返回最终 bodyStates。
 */
function doSeekTo(msg) {
  const { targetTime, specs, positions, velocities, bounds, requestId, randomSeed } = msg

  engine.reset()
  if (randomSeed != null) {
    engine._rng = makeRng(randomSeed)
  }
  if (bounds) engine.setTunnelBounds(bounds)
  const specObjs = unpackSpecs(specs)
  const posObjs = unpackVec3(positions)
  const velObjs = unpackVec3(velocities)
  engine.init(specObjs, posObjs, velObjs)
  engine.activateAll()
  lastEnergySeriesLen = 0

  const step = 0.05
  let remaining = Math.max(0, targetTime)
  const maxSteps = 800
  let stepCount = 0
  while (remaining > 0 && stepCount < maxSteps) {
    const dt = Math.min(step, remaining)
    engine.step(dt)
    remaining -= dt
    stepCount++
  }

  const states = engine.getBodyStates()
  const buf = packBodyStates(states)
  self.postMessage({ type: 'seekComplete', data: buf, count: states.length, requestId }, [
    buf.buffer
  ])
  sendEnergyStats()
}
