/**
 * 爆破物理引擎 Web Worker 入口
 *
 * 在 Worker 线程中执行碎片物理模拟，避免 200+ 碎片的 step 计算和
 * seekTo 快进（最多 400 步）阻塞主线程渲染。
 *
 * 依赖：blastPhysicsEngine.js（纯 JavaScript 数学计算，无 Three.js 依赖）
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'init', specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, requestId: number }
 *   { type: 'step', dt: number, requestId: number }
 *   { type: 'seekTo', targetTime: number, specs: Float32Array, positions: Float32Array, velocities: Float32Array, bounds: object, requestId: number }
 *   { type: 'activateAll' }
 *   { type: 'reset' }
 *   { type: 'setOnBodyLanded', enabled: boolean }
 *   { type: 'getStats', requestId: number }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'ready' }
 *   { type: 'bodyStates', data: Float32Array, count: number, requestId: number }
 *   { type: 'seekComplete', data: Float32Array, count: number, requestId: number }
 *   { type: 'bodyLanded', posX, posY, posZ, impactSpeed }
 *   { type: 'stats', total, alive, landed, requestId }
 *   { type: 'error', message, stack }
 *
 * bodyStates Float32Array 字段布局（每碎片 16 个 float）：
 *   [posX, posY, posZ, quatX, quatY, quatZ, quatW, velX, velY, velZ, flags, physSize, bounceCount, angVelX, angVelY, angVelZ]
 */

import { BlastPhysicsEngine } from './blastPhysicsEngine.js'

const engine = new BlastPhysicsEngine()
let bodyLandedEnabled = false

// ─── 工具：解包主线程传来的 Float32Array ─────────────────
/**
 * 解包 specs Float32Array 为 FragmentSpec 对象数组
 * 布局：每碎片 12 个 float
 *   [physSize, density, restitution, friction, maxBounces, variantIndex, dispSize, colorR, delayTime,
 *    interRestitution, interFriction, collisionRadiusScale]
 * 注：colorG/colorB 在主线程渲染时按 variantIndex 派生，不传输以减小带宽
 */
function unpackSpecs(buf) {
    const N = buf.length / 12
    const out = new Array(N)
    for (let i = 0; i < N; i++) {
        const o = i * 12
        out[i] = {
            physSize: buf[o],
            density: buf[o + 1],
            restitution: buf[o + 2],
            friction: buf[o + 3],
            maxBounces: buf[o + 4],
            variantIndex: buf[o + 5],
            dispSize: buf[o + 6],
            colorR: buf[o + 7],
            delayTime: buf[o + 8],
            interRestitution: buf[o + 9],
            interFriction: buf[o + 10],
            collisionRadiusScale: buf[o + 11]
        }
    }
    return out
}

/** 解包 vec3 Float32Array 为 {x,y,z} 数组 */
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
/** 打包 bodies 数组为 Float32Array（Transferable 零拷贝传输） */
function packBodyStates(bodies) {
    const N = bodies.length
    const buf = new Float32Array(N * 16)
    for (let i = 0; i < N; i++) {
        const b = bodies[i]
        const o = i * 16
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
        buf[o + 13] = b.angVelX || 0
        buf[o + 14] = b.angVelY || 0
        buf[o + 15] = b.angVelZ || 0
        b._idx = i // 缓存索引供 bodyLanded 回调用
    }
    return buf
}

function sendBodyStates(requestId) {
    const buf = packBodyStates(engine.bodies)
    self.postMessage(
        { type: 'bodyStates', data: buf, count: engine.bodies.length, requestId },
        [buf.buffer]
    )
}

// ─── Worker 消息处理 ─────────────────────────────────
self.onmessage = (e) => {
    const msg = e.data
    try {
        switch (msg.type) {
            case 'init': {
                // 确定性模式：主线程通过消息携带 randomSeed，在 init 前重置 PRNG
                // 必须在 engine.init 之前调用，确保碎片初始角速度等随机量使用新 PRNG
                if (msg.randomSeed !== undefined) engine.setRandomSeed(msg.randomSeed)
                const specs = unpackSpecs(msg.specs)
                const positions = unpackVec3(msg.positions)
                const velocities = unpackVec3(msg.velocities)
                if (msg.bounds) engine.setTunnelBounds(msg.bounds)
                engine.init(specs, positions, velocities)
                sendBodyStates(msg.requestId)
                break
            }
            case 'step': {
                engine.step(msg.dt)
                sendBodyStates(msg.requestId)
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
            case 'reset': {
                engine.reset()
                break
            }
            case 'setBlastConfig': {
                engine.setBlastConfig(msg.cfg)
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
                    total: engine.bodies.length,
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

/**
 * 执行 seekTo 快进：用主线程传来的 specs/positions/velocities 重新 init，
 * 然后循环 step 到 targetTime，最后返回最终 bodyStates。
 *
 * 整个过程在 Worker 线程执行，不阻塞主线程 UI。
 */
function doSeekTo(msg) {
    const { targetTime, specs, positions, velocities, bounds, requestId, randomSeed } = msg

    // 1. 重新初始化物理引擎
    engine.reset()
    // 确定性模式：seekTo 重建时也要重置 PRNG，保证快进结果与正常播放一致
    if (randomSeed !== undefined) engine.setRandomSeed(randomSeed)
    if (bounds) engine.setTunnelBounds(bounds)
    const specObjs = unpackSpecs(specs)
    const posObjs = unpackVec3(positions)
    const velObjs = unpackVec3(velocities)
    engine.init(specObjs, posObjs, velObjs)
    engine.activateAll()

    // 2. 后台循环 step 到目标时间（固定步长保证物理稳定性）
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    // 限制最大快进步数，避免极端值导致 Worker 长时间占用
    const maxSteps = 800
    let stepCount = 0
    while (remaining > 0 && stepCount < maxSteps) {
        const dt = Math.min(step, remaining)
        engine.step(dt)
        remaining -= dt
        stepCount++
    }

    // 3. 推送最终状态
    const buf = packBodyStates(engine.bodies)
    self.postMessage(
        { type: 'seekComplete', data: buf, count: engine.bodies.length, requestId },
        [buf.buffer]
    )
}

// 通知主线程 Worker 已就绪
self.postMessage({ type: 'ready' })
