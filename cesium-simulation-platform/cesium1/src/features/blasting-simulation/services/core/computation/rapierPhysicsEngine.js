/**
 * Rapier 物理引擎 — 基于 @dimforge/rapier3d-compat
 *
 * 替换手写 BlastPhysicsEngine，使用 Rapier 的凸包碰撞体和 PGS 求解器：
 * - 凸包碰撞体：从 rockGeometryFactory 的 15 种几何体顶点构建，解决块状碎片
 *   在斜面上球面支撑不符、过度滚动的问题
 * - PGS 多接触点求解器：天然支持多接触点稳定堆积，无需手写安息角启发式
 * - CCD 连续碰撞检测：防止高速碎片穿墙，替代手写自适应子步长
 * - BVH 宽相：高效处理 3000 动态体，替代手写空间散列
 *
 * API 与 BlastPhysicsEngine 完全一致，可透明替换。
 * 空气阻力（P-01 分段模型）和延迟激活（分段起爆）逻辑保留。
 */

import RAPIER from '@dimforge/rapier3d-compat'
import { DEFAULT_RESTITUTION, DEFAULT_FRICTION } from '../blastDefaults.js'
// 共享物理常量与 P-01 阻力模型：与 blastPhysicsEngine.js 同一实现（physicsConstants.js 单源）
import {
  GRAVITY,
  SETTLE_SPEED,
  SETTLE_FRAMES,
  ENERGY_SAMPLE_INTERVAL,
  computeDragAccel,
  FLAG_ALIVE,
  FLAG_LANDED
} from './physicsConstants.js'

// 碰撞分组（enableInterCollision=false 时使用）
const FRAG_GROUPS = 0x00020001 // group=0x0001, mask=0x0002（仅与隧道碰撞）
const TUNNEL_GROUPS = 0x00010002 // group=0x0002, mask=0x0001（仅与碎片碰撞）

// 隧道碰撞体半长(m)：与视觉隧道壳长度（sceneBuilder._buildTunnelShell shellLength=80）
// 对齐，避免碎片在壳内但无墙约束的"裸奔段"横向跑出视觉边界。
const TUNNEL_HALF_LEN = 80
// 悬浮检测周期（步）：每 30 步（1.5s）对已冻结（Fixed）块做一次几何悬空检测。
// 冻结块已不参与求解，支撑丢失（支撑它的动态块滚走）后不会自行下落，故仍需
// 周期性几何检测兜底；判据只在"周边确实没有可依托碎块"时才解除冻结。
const FLOAT_CHECK_INTERVAL = 30
// 单块最多因悬空解冻次数：支撑判据正确时每次解冻都会落到真实支撑上，
// 个别卡在拱顶角落"几何陷阱"的块物理上无法落稳，超过次数后接受其位置。
const MAX_FLOAT_WAKE = 2
// 底板厚度(m)：0.5m 薄板在 dt=0.05 的爆破初速下会被深穿透——穿透深度越过板厚
// 一半后求解器按"最近面"把碎片推向板底（实测 2.5s 内 37 块穿底、最远自由落体
// 1700m+，即截图中"碎石漏到巷道外"）。加厚后最近面恒为顶面，碎片被推回上方。
const FLOOR_HALF_THICKNESS = 2.0

// ─── 基向量 → 四元数（隧道朝向）────────────────────────
function basisToQuat(rx, ry, rz, ux, uy, uz, fx, fy, fz) {
  const trace = rx + uy + fz
  let qw, qx, qy, qz
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    qw = 0.25 / s
    qx = (uz - fy) * s
    qy = (fx - rz) * s
    qz = (ry - ux) * s
  } else if (rx > uy && rx > fz) {
    const s = 2 * Math.sqrt(1 + rx - uy - fz)
    qw = (uz - fy) / s
    qx = 0.25 * s
    qy = (ux + ry) / s
    qz = (fx + rz) / s
  } else if (uy > fz) {
    const s = 2 * Math.sqrt(1 + uy - rx - fz)
    qw = (fx - rz) / s
    qx = (ux + ry) / s
    qy = 0.25 * s
    qz = (fy + uz) / s
  } else {
    const s = 2 * Math.sqrt(1 + fz - rx - uy)
    qw = (ry - ux) / s
    qx = (fx + rz) / s
    qy = (fy + uz) / s
    qz = 0.25 * s
  }
  // 归一化兜底：本函数假定输入 [right, up, -forward] 为正规旋转矩阵
  //（约定 right × up = -forward，生产端由 right=dir×up、forward=up×right 保证）。
  // 若调用方传入左手系组合（如 right=+X、forward=+Z 的测试 bounds），矩阵变为
  // 反射（det=-1），Shepperd 公式会产出 |q|<1 的非法四元数；Rapier 0.20 的
  // setRotation 不做归一化，非单位四元数会使固定碰撞体退化成过原点的细针
  // （实测碎片全部穿地、永不落地，预计算被打满 40s 上限）。归一化对正规输入
  // 是无操作，对异常输入保证碰撞体姿态有效。
  const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
  if (qlen > 1e-9) {
    qx /= qlen
    qy /= qlen
    qz /= qlen
    qw /= qlen
  } else {
    qx = 0
    qy = 0
    qz = 0
    qw = 1
  }
  return { x: qx, y: qy, z: qz, w: qw }
}

// ─── 计算顶点数组的最大半径 ─────────────────────────────
function computeMaxRadius(points) {
  let maxR = 0
  for (let i = 0; i < points.length; i += 3) {
    const r = Math.sqrt(points[i] ** 2 + points[i + 1] ** 2 + points[i + 2] ** 2)
    if (r > maxR) maxR = r
  }
  return maxR || 1
}

export class RapierPhysicsEngine {
  constructor(config = {}) {
    this.gravity = config.gravity ?? GRAVITY
    this.enableInterCollision = config.enableInterCollision ?? true
    this._rng = config.rng || Math.random

    /** @type {RAPIER.World|null} */
    this._world = null
    /** @type {Array<Object>} 碎片刚体元数据 */
    this._fragmentBodies = []
    /** @type {Array<RAPIER.RigidBody>} 隧道壁固定刚体 */
    this._tunnelColliderBodies = []
    /** @type {Array<Float32Array>|null} 15 种几何体变体的顶点数据 */
    this._geometryVertices = null
    /** @type {Array<{maxR:number}>|null} 预计算的各变体最大半径 */
    this._variantMaxR = null

    this._tunnelBounds = null
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
    this.onBodyLanded = null
    this.activeCount = 0
    // 待激活延迟块计数 / 上一步醒着体计数（供 step() 全体休眠早退判定）
    this._pendingDelayed = 0
    this._awakeCount = 0
    this._stepCount = 0
  }

  /**
   * 初始化 Rapier World（必须在 init 前调用）
   * 在 Worker 中于 RAPIER.init() 完成后同步调用。
   */
  ensureReady() {
    if (this._world) return
    this._world = new RAPIER.World({ x: 0, y: -this.gravity, z: 0 })
    this._world.timestep = 0.05
    // 允许的线性穿透误差在 init() 中按"初始分布厚度/块径"自适应设置
    // （见 _tuneSolverForInitialOverlap）
    // 求解器迭代次数：8 → 4（Rapier 默认值）。4500+ 凸包刚体互撞时，
    // 迭代次数是单步耗时的主要乘数：8 次迭代的堆叠稳定增益对数千刚体
    // 而言已过剩，降到 4 次可换取 ~1.5-2x 的预计算提速（等待"关键帧
    // 回放就绪"的时间减半）。堆积稳定性由 _applySettling 的"停稳即静态化"
    // 兜底：残余求解误差只影响停止前的姿态，不会累积成弹跳。
    this._world.integrationParameters.numSolverIterations = 4
  }

  /**
   * 设置 15 种几何体变体的顶点数据（用于凸包碰撞体）
   * @param {Array<Float32Array>} vertices - 15 个 Float32Array，每个为 [x,y,z,...]
   */
  setGeometryVertices(vertices) {
    this._geometryVertices = vertices
    // 预计算各变体的最大半径，避免 init 时重复计算
    this._variantMaxR = vertices.map(v => computeMaxRadius(v))
  }

  /**
   * 设置隧道截面边界（与 BlastPhysicsEngine.setTunnelBounds 兼容）
   */
  setTunnelBounds(bounds) {
    this._tunnelBounds = bounds
    // 隧道碰撞体在 init() 中创建（需要先 reset 世界）
  }

  /**
   * 用碎片规格初始化物理引擎
   * @param {FragmentSpec[]} specs
   * @param {Array<{x,y,z}>} positions
   * @param {Array<{x,y,z}>} velocities
   */
  init(specs, positions, velocities) {
    this.ensureReady()
    this._clearBodies()

    // 创建隧道壁碰撞体
    this._createTunnelColliders()

    const count = Math.min(specs.length, positions.length, velocities.length)
    const fragGroups = this.enableInterCollision ? 0xffffffff : FRAG_GROUPS

    for (let i = 0; i < count; i++) {
      const s = specs[i]
      const p = positions[i]
      const v = velocities[i]
      const physSize = Math.max(0.01, Number(s.physSize) || 0.01)
      // 视觉直径 = dispSize：渲染网格 scale=dispSize、半径 = maxR×dispSize。
      // 物理碰撞体必须与之同尺寸，否则贴墙堆积时视觉网格穿出隧道壁
      //（"碎石挤到隧道外"）。质量仍按 KCO physSize 直径计算（下方 setMass 覆盖）。
      const dispSize = Math.max(0.01, Number(s.dispSize) || physSize)
      const density = Math.max(100, Number(s.density) || 2700)
      const mass = density * (4 / 3) * Math.PI * Math.pow(physSize / 2, 3)
      const variantIndex = Math.floor(Number(s.variantIndex)) || 0
      const restitution = s.restitution ?? DEFAULT_RESTITUTION
      const friction = s.friction ?? DEFAULT_FRICTION
      const delayTime = Math.max(0, Number(s.delayTime) || 0)

      // 创建碰撞体描述：凸包（有几何顶点时）或球体（fallback）
      let colDesc
      const variantVerts = this._geometryVertices?.[variantIndex]
      // 变体最大半径（决定凸包与视觉网格的统一外伸尺寸）
      const hullMaxR =
        variantVerts && variantVerts.length >= 9
          ? this._variantMaxR?.[variantIndex] || computeMaxRadius(variantVerts)
          : 1
      if (variantVerts && variantVerts.length >= 9) {
        // 顶点缩放 scale=dispSize：凸包最大半径 = hullMaxR×dispSize
        // = 渲染网格（scale=dispSize）的真实外伸半径，物理与视觉完全同尺寸。
        const scaled = new Float32Array(variantVerts.length)
        for (let j = 0; j < variantVerts.length; j++) {
          scaled[j] = variantVerts[j] * dispSize
        }
        colDesc = RAPIER.ColliderDesc.convexHull(scaled)
      } else {
        colDesc = RAPIER.ColliderDesc.ball(dispSize * hullMaxR)
      }

      if (!colDesc) {
        // convexHull 失败时 fallback 到球体（同样按渲染尺寸）
        colDesc = RAPIER.ColliderDesc.ball(dispSize * hullMaxR)
      }

      colDesc.setRestitution(restitution)
      colDesc.setFriction(friction)
      colDesc.setDensity(density)
      colDesc.setCollisionGroups(fragGroups)

      // 创建动态刚体（初始禁用，等 activateAll 激活）
      // 注意：RAPIER.RigidBodyDesc 无 enabled() 方法，需在 createRigidBody 后调用 setEnabled
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel(v.x, v.y, v.z)
        .setAngularDamping(0.5)
        .setLinearDamping(0) // 空气阻力手动施加
        .setCcdEnabled(true) // 连续碰撞检测防穿墙

      const body = this._world.createRigidBody(bodyDesc)
      const collider = this._world.createCollider(colDesc, body)
      // 碰撞体已按渲染尺寸放大（dispSize），但其体积质量会随体积³膨胀；
      // 显式覆盖为 KCO physSize 直径对应的真实质量，保持抛掷/堆积动力学不变。
      if (collider?.setMass) collider.setMass(mass)
      body.setEnabled(false)

      const entry = {
        rigidBody: body,
        physSize,
        // 碰撞半径 = 渲染网格的外伸半径（hullMaxR×dispSize，凸包/球体一致口径）
        collisionRadius: dispSize * hullMaxR,
        mass,
        // 初始速度大小：激活初期用干物理分离冲量钳制（见 _clampEarlySpeeds）
        initSpeed: Math.hypot(v.x, v.y, v.z),
        flags: delayTime > 0 ? 0 : FLAG_ALIVE,
        delayTime,
        _delayed: delayTime > 0,
        bounceCount: 0,
        lowSpeedFrames: 0,
        landTriggered: false,
        variantIndex,
        // ── 已停稳标记：true 表示刚体已转为 Fixed（静态），不再参与求解 ──
        // 落地后跳动/爆堆体积回缩的根因是"冻结只是 sleep，仍会被邻居唤醒"：
        // 休眠期间不生成接触流形，积压的穿透修正在唤醒步一次性释放 →
        // 分离冲量把块弹起（实测竖向峰值 10.2 m/s、单块弹起 5.5m），落回时
        // 又被压进更密的接触 → 堆体逐次收紧（体积不自然减小）。改为停稳即
        // 静态化：静止块不可被推动、不会被唤醒，堆体成形后彻底静止。
        _static: false,
        // 冻结时位置（悬空检测/纠位基准）
        _frozenPos: null,
        floatWakeCount: 0 // 悬空解冻次数（≥MAX_FLOAT_WAKE 不再解冻，防几何陷阱死循环）
      }
      this._fragmentBodies.push(entry)
    }
    this.activeCount = count
    // 待激活延迟块计数：step() 的"全体静止早退"必须知道还有没有延迟块要起爆，
    // 否则全部分片静止时会在延迟块激活前就跳过求解步（与本轮新增的静态化早退配合）。
    this._pendingDelayed = this._fragmentBodies.filter(b => b._delayed).length
    // 按初始分布厚度自适应穿透容差（需在碎片创建后调用，用到 collisionRadius）
    this._tuneSolverForInitialOverlap(positions)
  }

  /**
   * 初始分布厚度自适应穿透容差。
   *
   * 代表性碎岩充满岩体实方体积，初始必然存在深度重叠：
   *  - 初始轴向跨度 ≥ 3 个块径：3D 分布充分，严格容差（0.002）即可，
   *    保持接触刚度，大块滚向坡脚的偏析不被削弱（实测偏析比 2.4）；
   *  - 跨度 < 3 个块径：几乎共面堆叠，严格容差下的位置修正会把碎块"顶"成
   *    垂直石柱（实测大断面场景堆高 10.5m、坡角 72°），放宽到 0.05。
   */
  _tuneSolverForInitialOverlap(positions) {
    const tb = this._tunnelBounds
    if (!tb || !this._world || !positions?.length) return
    let sMin = Infinity
    let sMax = -Infinity
    let sumR = 0
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      const s =
        (p.x - tb.centerX) * tb.forwardX +
        (p.y - tb.centerY) * tb.forwardY +
        (p.z - tb.centerZ) * tb.forwardZ
      if (s < sMin) sMin = s
      if (s > sMax) sMax = s
      sumR += this._fragmentBodies[i]?.collisionRadius || 0.3
    }
    const avgR = sumR / positions.length
    const ratio = (sMax - sMin) / Math.max(0.05, avgR)
    this._world.integrationParameters.normalizedAllowedLinearError = ratio < 3 ? 0.05 : 0.002
  }

  /**
   * 激活所有非延迟碎片（爆破触发时调用）
   */
  activateAll() {
    for (const b of this._fragmentBodies) {
      if (b._delayed) continue
      b.flags |= FLAG_ALIVE
      b.rigidBody.setEnabled(true)
      b.rigidBody.wakeUp()
    }
  }

  /**
   * 设置碎片间碰撞开关
   */
  setEnableInterCollision(value) {
    this.enableInterCollision = !!value
    // 更新已有碎片碰撞体的碰撞分组
    const groups = this.enableInterCollision ? 0xffffffff : FRAG_GROUPS
    for (const b of this._fragmentBodies) {
      // Rapier 不支持直接修改碰撞分组，需通过 collider
      const collider = b.rigidBody.collider(0)
      if (collider) collider.setCollisionGroups(groups)
    }
  }

  /**
   * 推进物理模拟一步
   * @param {number} dt - 时间步长(s)
   */
  step(dt) {
    if (dt <= 0 || !this._world) return
    this.simTime += dt

    // 1. 激活到时的延迟碎片
    for (const b of this._fragmentBodies) {
      if (b._delayed && !(b.flags & FLAG_ALIVE)) {
        if (this.simTime >= b.delayTime) {
          b.flags |= FLAG_ALIVE
          b._delayed = false
          this._pendingDelayed--
          b.rigidBody.setEnabled(true)
          b.rigidBody.wakeUp()
        }
      }
    }

    // 2. 重置力 + 施加空气阻力
    // 【性能】睡眠体直接跳过：Rapier 不积分睡眠体的力，resetForces/resetTorques
    // 与 linvel 读取都是纯浪费。被撞醒后 isSleeping()=false，本循环下一步即照常
    // reset+加阻力，无陈旧力泄漏（冻结前残留的阻力在唤醒步开头即被清掉）。
    // 尾段（99% 碎片已冻结）每体每步省 ~3 次 WASM 边界调用。
    this._awakeCount = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      // 已静态化的停稳块：不施加任何力、不计入醒着体（Rapier 不积静态体的力）
      if (b._static) continue
      const rb = b.rigidBody
      // 未启用的刚体（起爆前的延迟块/待激活块）不参与求解：既不加力也不计入
      // 醒着体——否则起爆前（全部分片静止悬在岩体内）会走不到早退分支，
      // 白跑 world.step()，且被 _applySettling 误判为"已停稳"而提前静态化。
      if (!rb.isEnabled()) continue
      if (rb.isSleeping()) continue
      this._awakeCount++
      rb.resetForces(true)
      rb.resetTorques(true)

      if (b.flags & FLAG_LANDED) continue
      if (b.physSize <= 0.01 || b.mass <= 0) continue

      const vel = rb.linvel()
      const drag = computeDragAccel(vel.x, vel.y, vel.z, b.physSize, b.mass)
      rb.addForce({ x: drag.ax * b.mass, y: drag.ay * b.mass, z: drag.az * b.mass }, true)
    }

    // 2.5 悬空检测（周期性）：已静止（Fixed）块的支撑被移走（支撑它的动态块
    // 滚落/被撞飞）时不会自行下落 → 每 30 步用空间网格做一次几何检测，
    // 确认周边没有任何可依托碎块才恢复为动态体重新下落。检测仅在早退判定
    // 之前执行，全体静止后仍生效；判据"周边确有邻块"宁可漏检不可误判。
    this._stepCount++
    if (this._stepCount % FLOAT_CHECK_INTERVAL === 0) this._performFloatCheck()

    // 2.6 全体静止早退：所有存活体均已静态化/睡眠且无待激活延迟块时，跳过求解步。
    // 堆体成形后物理彻底停摆（落地堆积严格静止），同时省掉尾段每步的世界步进开销。
    // simTime 照常推进，关键帧录制不受影响。
    if (this._awakeCount === 0 && this._pendingDelayed <= 0) return

    // 3. 步进世界（Rapier 内部处理重力、碰撞、约束求解）
    this._world.timestep = dt
    this._world.step()

    // 4. 堆积判定：低速 + 有支撑 + 无深度穿透 → 静态化（停稳即 Fixed）
    this._applySettling()

    // 4.5 激活初期速度钳制：代表性碎岩块径被体积还原放大后，初始位置仍会
    //     相互重叠，Rapier 的分离冲量会把碎片"炸"到隧道尽头（实测 900 块
    //     抛距 P95 = 83m、爆堆摊平、安息角 8°）。前 0.6s（12 步）把速度限制在
    //     初始抛速的 2.5 倍以内；窗口再长会带来每步全量遍历的开销（实测
    //     400 体 × 120 步从 233ms 升到 424ms），而重叠已在 12 步内释放完毕。
    //     正常抛掷速度只受重力垂向加速，水平速度不会增长，因此钳制不影响
    //     正常抛距；只有求解器分离冲量会触发。
    if (this.simTime <= 0.6) this._clampEarlySpeeds()

    // 5. 隧道外碎石检查与消除：任何中心越出断面的碎片被"传送"回断面内
    //    最近合法点并清零速度。根治"碎石被挤到隧道外"——物理源头上就不
    //    存在越界块，渲染层与爆堆轮廓不会再被它们撑偏/撑高（此前只能靠
    //    渲染隐藏 + 轮廓剔除，壳仍被架桥出大片空档）
    this._containOutsideFragments()

    // 6. 能量统计采样
    if (this.simTime - this._lastSampleTime >= ENERGY_SAMPLE_INTERVAL) {
      this._sampleEnergy()
    }
  }

  /**
   * 隧道外碎石检查与消除：每步扫描存活碎片，中心越出隧道断面的碎片
   * （被挤到侧墙外/拱顶外侧/底板下方）立即传送回断面内最近的合法点。
   * 容差允许贴墙/贴拱正常堆积（与轮廓剔除口径一致）。
   *
   * 纠位一律"静默"（wake=false、不注入下落速度）：旧版 setTranslation(wake=true)
   * + setLinvel(-1) 会给越界块重新注入动能，形成"传送→坠落→再越界→再传送"
   * 的持续跳动循环。静默纠位对已静止（Fixed）块只改位置、不产生任何运动；
   * 对动态块则交由重力自然落回堆体。
   *
   * 底板下方的越界必须单独判定：u<0 且 |t|<halfW 的碎片在侧墙/拱顶判据下
   * 完全"合法"，旧版因此对穿底碎片彻底失管（一路自由落体到巷道外）。
   * 复位目标点按碎片自身碰撞半径收拢，否则中心贴边时网格仍外伸穿墙。
   */
  _containOutsideFragments() {
    const tb = this._tunnelBounds
    if (!tb || !this._world) return
    const fc = { x: tb.centerX, y: tb.floorY, z: tb.centerZ }
    const rx = tb.rightX
    const ry = tb.rightY
    const rz = tb.rightZ
    const fx = tb.forwardX
    const fy = tb.forwardY
    const fz = tb.forwardZ
    const halfW = tb.halfWidth
    const wallH = tb.wallHeight
    const R = tb.archRadius
    const shape = tb.shape || 'horseshoe'
    const tol = 0.15 // 轻微越界的贴墙/贴拱堆积不误传
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const rb = b.rigidBody
      const p = rb.translation()
      const dx = p.x - fc.x
      const dy = p.y - fc.y
      const dz = p.z - fc.z
      const t = dx * rx + dy * ry + dz * rz
      const u = p.y - fc.y
      const s = dx * fx + dy * fy + dz * fz // 轴向（+ = 掌子面前方岩体内）
      const fragR = b.collisionRadius || b.physSize * 0.5
      // 轴向飞出洞口（-forward 方向超出墙长度）：冻结而不是传送——
      // 传回会在洞口 80m 处瞬移显形，比飞出去更不自然。渲染层按同一
      // 轴向阈值剔除实例；冻结则停止其继续消耗求解算力。
      if (s < -TUNNEL_HALF_LEN) {
        if (!(b.flags & FLAG_LANDED)) {
          // 墙外无底板：冻结前把竖向拉回底面上方，避免永久悬空/继续穿底
          if (u < 0) {
            rb.setTranslation({ x: p.x, y: fc.y + fragR, z: p.z }, false)
          }
          this._freeze(b, 0)
        }
        continue
      }
      // 越界判定（与渲染 _outsideSection 同构）
      let outside = false
      if (shape === 'circular') {
        if (Math.hypot(t, u - R) > R + tol) outside = true
      } else if (shape === 'rectangular') {
        if (Math.abs(t) > halfW + tol || u > wallH + R + tol) outside = true
      } else {
        if (u <= wallH) {
          if (Math.abs(t) > halfW + tol) outside = true
        } else if (Math.hypot(t, u - wallH) > R + tol) outside = true
      }
      // 低于底板：低于底板中心即为穿底（含横向在宽度内的直下漏出）
      if (u < -tol) outside = true
      if (!outside) continue
      // 求断面内最近合法点（保留轴向位置不变）：横向与竖向都按碎片半径
      // 收拢，使凸包真正落回断面内而非"中心贴边、网格外伸"。
      const maxT = Math.max(0.01, halfW - fragR)
      const ct = Math.max(-maxT, Math.min(maxT, t))
      let ceilU = wallH + R
      if (shape === 'circular') {
        const dd = Math.min(R, Math.abs(ct))
        ceilU = R + Math.sqrt(Math.max(0, R * R - dd * dd))
      } else if (shape !== 'rectangular') {
        ceilU = Math.abs(ct) > R ? wallH : wallH + Math.sqrt(Math.max(0, R * R - ct * ct))
      }
      const minU = Math.max(0.02, fragR)
      const maxU = Math.max(minU, ceilU - fragR)
      const cu = Math.max(minU, Math.min(maxU, u))
      const corrected = {
        x: fc.x + rx * ct + fx * s,
        y: fc.y + ry * ct + cu + fy * s,
        z: fc.z + rz * ct + fz * s
      }
      // 已静态化（Fixed）的停稳块被堆体挤压轻微越界：静默纠位——不唤醒、
      // 不给下落速度、保持静止。静态体不参与求解，纠位一次即终止"挤压-越界"
      // 循环；旧路径 setTranslation(wake=true)+赋 -1m/s 会让块反复传送-坠落
      // （实测 561 次传送事件），是落地后持续跳动的推手之一。
      if (b._static || rb.isFixed()) {
        rb.setTranslation(corrected, false)
        b._frozenPos = { x: corrected.x, y: corrected.y, z: corrected.z }
        continue
      }
      // 动态块越界：同样静默纠位（不 wake、不注入速度），速度清零后由重力
      // 自然落回堆体——给 -1m/s 会让块在断面外"抛起再掉下"，形成可见跳动。
      rb.setTranslation(corrected, false)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, false)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, false)
      b.flags &= ~FLAG_LANDED
      b.lowSpeedFrames = 0
    }
  }

  /**
   * 激活初期速度钳制：限制重叠分离产生的异常速度（仅前 0.4s）。
   * 正常抛掷速度来自 spec 初速，远低于该上限；只有求解器因深穿透
   * 产生的分离冲量会触发钳制。
   */
  _clampEarlySpeeds() {
    const KC = 2.5 // 上限倍数：相对碎片自身初始速度
    const ABS_MIN = 3 // 绝对下限(m/s)，避免静止块完全不分离
    const ANG_CAP = 12 // 角速度上限(rad/s)
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      if (b._static) continue
      const rb = b.rigidBody
      if (rb.isSleeping()) continue
      const v = rb.linvel()
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      const cap = Math.max(ABS_MIN, (b.initSpeed || 0) * KC)
      if (sp > cap) {
        const k = cap / sp
        rb.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true)
      }
      const av = rb.angvel()
      const asp = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z)
      if (asp > ANG_CAP) {
        const ak = ANG_CAP / asp
        rb.setAngvel({ x: av.x * ak, y: av.y * ak, z: av.z * ak }, true)
      }
    }
  }

  /**
   * 周期性几何悬空检测：对已静态化（Fixed）的停稳块，用空间网格确认
   * 周边是否还有可依托的碎块（或本身贴底板）；确实悬空的块恢复为动态体
   * 重新下落。
   *
   * 为什么需要：静态块不参与求解，支撑它的动态块滚走/被撞飞后它不会自行
   * 下落 → 半空永久悬停。每 FLOAT_CHECK_INTERVAL 步检测一次，空间网格使
   * 4500 体开销可控。
   *
   * 判据（宽口径，宁可漏检不可误判）：只要存在任一存活邻块与自身包围球
   * 相交（含 10% 容差）即视为有依托——爆堆内部块体互相咬合，个别块即使
   * 略高于支撑面也算被楔住。旧判据（要求邻块中心明显低于自身）会在堆顶
   * 误判"无支撑"，制造 1.5s 一次的规律性误唤醒（= 用户看到的周期弹起）。
   */
  _performFloatCheck() {
    const tb = this._tunnelBounds
    if (!tb || this._fragmentBodies.length === 0) return
    const bodies = this._fragmentBodies
    const n = bodies.length
    const CELL = 2
    const floorY = tb.floorY
    // 建格（仅存活体），并缓存本步快照位置
    const grid = new Map()
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      if (!(b.flags & FLAG_ALIVE)) continue
      const p = b.rigidBody.translation()
      b._fcX = p.x
      b._fcY = p.y
      b._fcZ = p.z
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)},${Math.floor(p.z / CELL)}`
      const arr = grid.get(k)
      if (arr) arr.push(i)
      else grid.set(k, [i])
    }
    let woken = 0
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      if (!(b.flags & FLAG_ALIVE) || !b._static) continue
      if ((b.floatWakeCount || 0) >= MAX_FLOAT_WAKE) continue
      const px = b._fcX
      const py = b._fcY
      const pz = b._fcZ
      const rB = b.collisionRadius || b.physSize * 0.5
      // 底板快速路径：底部贴近底板即视为有支撑
      if (py - rB * 0.7 <= floorY + 0.25) continue
      const reach = rB + 3.5 // 邻居半径兜底
      const cx0 = Math.floor((px - reach) / CELL)
      const cx1 = Math.floor((px + reach) / CELL)
      const cy0 = Math.floor((py - reach) / CELL)
      const cy1 = Math.floor((py + reach) / CELL)
      const cz0 = Math.floor((pz - reach) / CELL)
      const cz1 = Math.floor((pz + reach) / CELL)
      let supported = false
      outer: for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const arr = grid.get(`${cx},${cy},${cz}`)
            if (!arr) continue
            for (let a = 0; a < arr.length; a++) {
              const j = arr[a]
              if (j === i) continue
              const oj = bodies[j]
              if (!(oj.flags & FLAG_ALIVE)) continue
              const rJ = oj.collisionRadius || oj.physSize * 0.5
              const dy = Math.abs(py - oj._fcY)
              if (dy > (rB + rJ) * 1.1) continue
              const dh = Math.hypot(px - oj._fcX, pz - oj._fcZ)
              if (dh > (rB + rJ) * 1.1) continue
              supported = true
              break outer
            }
          }
        }
      }
      if (supported) continue
      // 真悬空：恢复为动态体重新下落。次数上限防"几何陷阱"死循环
      // （卡在拱顶角落的块物理上无法落稳，超过次数后接受其位置，
      //  渲染层按断面剔除口径隐藏明显出界块）。
      b.floatWakeCount = (b.floatWakeCount || 0) + 1
      b.rigidBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      b._static = false
      b.flags &= ~FLAG_LANDED
      b.lowSpeedFrames = 0
      b._frozenPos = null
      woken++
    }
    if (woken > 0) this._awakeCount += woken
  }

  /**
   * 停稳判定：低速 + 有支撑 + 无深度穿透 → 静态化（转 Fixed 刚体）。
   *
   * 为什么必须"静态化"而不是仅仅 sleep：
   *  - sleep 只是让刚体暂不参与积分，邻居的接触仍会把它唤醒；
   *  - 休眠体对之间不生成接触流形，休眠期间堆体挤压造成的穿透被积压，
   *    一旦唤醒由求解器一次性释放 → 分离冲量把块弹起（实测单块弹起 5.5m、
   *    竖向峰值 10.2m/s），落回时又被压进更密接触 → 堆体逐次收紧、
   *    体积不自然减小；
   *  - 转 Fixed 后刚体不再被推动/唤醒，同时仍作为静态碰撞体支撑后续落石，
   *    爆堆一旦成形即完全静止。
   *
   * 冻结门控（缺一不可，避免"悬空卡石"与"穿透固化弹跳"）：
   *  - 速度低于随块径缩放的阈值并持续 SETTLE_FRAMES 帧（大块滚动阻力小，
   *    阈值更高 → 落到坡面后继续滚向坡脚，形成坡脚粗块偏析）；
   *  - 接触查询确认存在位于自身中心下方的接触点（真支撑，侧墙/掌子面不算）；
   *  - 最大穿透不超过 0.2×碰撞半径（深穿透时先让求解器推出，否则冻结会把
   *    穿透固化，唤醒即弹跳）。
   */
  _applySettling() {
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      // 已静态化：不再参与任何判定（Fixed 体速度恒为 0，也不会被唤醒）
      if (b._static) continue
      const rb = b.rigidBody
      // 起爆前的待激活块：未启用（不在求解中），不得判为"已停稳"——
      // 否则整片待爆破岩体会在 t=0 被静态化，起爆后碎片纹丝不动。
      if (!rb.isEnabled()) {
        b.lowSpeedFrames = 0
        continue
      }
      // Rapier 自动睡眠：速度连续 ~0.5s 低于睡眠阈值，等价于"已停稳"，
      // 直接静态化（旧版仅标记 LANDED，之后仍会被邻居唤醒 → 弹跳）。
      if (rb.isSleeping()) {
        this._freeze(b, 0)
        continue
      }
      const vel = rb.linvel()
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z)

      // 冻结阈值随块径降低：大块滚动阻力相对小（转动惯量 ∝ R²、接触微凸体
      // 相对高度小），落地后会继续沿坡面滚到坡脚，形成"坡脚粗块"的粒度偏析。
      // 下限 0.4 m/s：过低会让大块在密集堆体中永久"蠕动"。
      const sizeScale = Math.min(1.4, Math.max(0.45, 0.55 / Math.max(0.12, b.physSize)))
      const settleSpeed = Math.max(0.4, SETTLE_SPEED * sizeScale)
      if (speed >= settleSpeed) {
        b.lowSpeedFrames = 0
        continue
      }
      const info = this._contactInfo(b)
      const penLimit = 0.2 * (b.collisionRadius || b.physSize * 0.5)
      if (!info.supported || info.maxPen > penLimit) {
        // 悬空无支撑或深度穿透：不冻结，清空计数，继续下落/被推出
        b.lowSpeedFrames = 0
        continue
      }
      b.lowSpeedFrames = (b.lowSpeedFrames || 0) + 1
      if (b.lowSpeedFrames >= SETTLE_FRAMES) this._freeze(b, speed)
    }
  }

  /**
   * 冻结：把已停稳碎片转为静态刚体（Fixed），并记录冻结位置。
   * @param {Object} b - 碎片 entry
   * @param {number} impactSpeed - 落地冲击速度（仅用于落地事件特效）
   */
  _freeze(b, impactSpeed) {
    const rb = b.rigidBody
    const p = rb.translation()
    rb.setLinvel({ x: 0, y: 0, z: 0 }, false)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, false)
    rb.sleep()
    // 转静态：不再被求解器唤醒/推挤（这是"落地后停止跳动"的关键）
    rb.setBodyType(RAPIER.RigidBodyType.Fixed, false)
    b._static = true
    b.flags |= FLAG_LANDED
    b.lowSpeedFrames = 0
    b._frozenPos = { x: p.x, y: p.y, z: p.z }
    if (this.onBodyLanded && !b.landTriggered) {
      b.landTriggered = true
      this.onBodyLanded({ posX: p.x, posY: p.y, posZ: p.z }, Number(impactSpeed) || 0)
    }
  }

  /**
   * 接触信息查询：支撑判定 + 最大穿透深度。
   * 穿透深度供冻结门控使用——深度穿透的块不冻结（求解器尚未把块推出，
   * 冻结会把穿透"固化"，唤醒时一次性释放 → 分离冲量把块弹起，实测
   * 峰值速度 124 m/s）。穿透深度用几何接触对的 contactDist（负值=穿透）。
   * @param {Object} b - 碎片 entry
   * @returns {{supported: boolean, maxPen: number}} maxPen 为正值(米)
   */
  _contactInfo(b) {
    const pos = b.rigidBody.translation()
    const tb = this._tunnelBounds
    const fragR = b.collisionRadius || b.physSize * 0.5
    const floorY = tb ? tb.floorY : 0
    // 底板下方（中心低于顶面）不算"有支撑"：旧版只看"底部贴近/低于底板"，
    // 把已经穿到底板下的碎片也判为贴地→就地冻结，形成巷道外的静止碎堆。
    if (pos.y - fragR <= floorY + 0.2 && pos.y >= floorY - 0.05) {
      return { supported: true, maxPen: 0 }
    }

    const collider = b.rigidBody.collider(0)
    if (!collider || !this._world) return { supported: false, maxPen: 0 }
    const centerY = pos.y
    const pt = { x: 0, y: 0, z: 0 }
    let supported = false
    let maxPen = 0
    try {
      this._world.contactPairsWith(collider, other => {
        this._world.contactPair(collider, other, manifold => {
          const n = manifold.numSolverContacts()
          for (let i = 0; i < n; i++) {
            const p = manifold.solverContactPoint(i, pt)
            if (p && p.y < centerY - 0.02) {
              supported = true
            }
          }
          const nc = manifold.numContacts()
          for (let i = 0; i < nc; i++) {
            const d = manifold.contactDist(i)
            if (d < 0 && -d > maxPen) maxPen = -d
          }
        })
      })
    } catch (_) {
      // 接触查询失败时保守视为无支撑（不冻结），避免卡石
    }
    return { supported, maxPen }
  }

  /** 能量统计采样 */
  _sampleEnergy() {
    let totalKE = 0
    let settledMass = 0
    let totalMass = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const vel = b.rigidBody.linvel()
      const speed2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
      totalKE += 0.5 * b.mass * speed2
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) settledMass += b.mass
    }
    this._energyTimeSeries.push({
      t: this.simTime,
      kineticEnergy: totalKE,
      settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0
    })
    this._lastSampleTime = this.simTime
  }

  /**
   * 获取所有身体状态（供渲染器使用）
   * @returns {BodyState[]}
   */
  getBodyStates() {
    return this._fragmentBodies.map(b => {
      const pos = b.rigidBody.translation()
      const rot = b.rigidBody.rotation()
      const vel = b.rigidBody.linvel()
      return {
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z,
        quatX: rot.x,
        quatY: rot.y,
        quatZ: rot.z,
        quatW: rot.w,
        velX: vel.x,
        velY: vel.y,
        velZ: vel.z,
        // packBodyStates 读取 b.flags（数字），必须返回 flags 字段而非布尔 alive
        flags: b.flags,
        alive: !!(b.flags & FLAG_ALIVE),
        landed: !!(b.flags & FLAG_LANDED),
        physSize: b.physSize,
        bounceCount: b.bounceCount || 0
      }
    })
  }

  /**
   * 直接把当前状态打包为回放关键帧缓冲（零中间对象分配）。
   * 字段布局与 blastPhysicsWorker 的 REPLAY_FLOATS_PER_BODY=8 对应：
   *   [px, py, pz, qx, qy, qz, qw, flags]
   * 【性能】预计算/直播每 0.05s 步都录制一次关键帧。旧路径 getBodyStates()
   * 为每碎片创建 JS 对象并做 3 次 WASM 桥接调用（其中 linvel() 的结果根本
   * 不进关键帧）→ 3000 体 × 800 步累计 ~700 万次桥接调用 + 240 万次对象
   * 分配（GC 压力）。本方法每碎片仅 2 次桥接调用（translation/rotation），
   * flags 直接读 JS 侧元数据，是预计算耗时的大头削减项之一。
   * @param {Float32Array} out - 目标缓冲（长度 ≥ N × floatsPerBody）
   * @param {number} floatsPerBody - 每碎片 float 数（8）
   * @returns {number} 实际写入的碎片数
   */
  packReplayKey(out, floatsPerBody) {
    if (!out || !floatsPerBody) return 0
    const n = Math.min(this._fragmentBodies.length, Math.floor(out.length / floatsPerBody))
    for (let i = 0; i < n; i++) {
      const b = this._fragmentBodies[i]
      const p = b.rigidBody.translation()
      const r = b.rigidBody.rotation()
      const o = i * floatsPerBody
      out[o] = p.x
      out[o + 1] = p.y
      out[o + 2] = p.z
      out[o + 3] = r.x
      out[o + 4] = r.y
      out[o + 5] = r.z
      out[o + 6] = r.w
      out[o + 7] = b.flags
    }
    return n
  }

  /** 存活碎片数量 */
  get aliveFragmentCount() {
    let c = 0
    for (const b of this._fragmentBodies) {
      if (b.flags & FLAG_ALIVE) c++
    }
    return c
  }

  /** 已落地碎片数量 */
  get landedFragmentCount() {
    let c = 0
    for (const b of this._fragmentBodies) {
      if (b.flags & FLAG_LANDED) c++
    }
    return c
  }

  /**
   * 获取能量统计
   * @returns {{totalKineticEnergy:number, settledMassRatio:number, timeSeries:Array}}
   */
  getEnergyStats() {
    let totalKE = 0
    let settledMass = 0
    let totalMass = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const vel = b.rigidBody.linvel()
      const speed2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
      totalKE += 0.5 * b.mass * speed2
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) settledMass += b.mass
    }
    return {
      totalKineticEnergy: totalKE,
      settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0,
      timeSeries: this._energyTimeSeries
    }
  }

  /** 重置引擎 */
  reset() {
    this._clearBodies()
    this._fragmentBodies = []
    this.activeCount = 0
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
  }

  /**
   * 原位重置到初始状态（循环重播回到 t=0 时调用）。
   * 复用现有刚体与凸包碰撞体，仅重设位置/速度/启用状态，避免销毁重建
   * 数千个凸包导致的数秒卡顿与 WASM 内存抖动（表现为"碎石回到掌子面
   * 后长时间不抛掷"）。
   * 要求 specs 与首次 init 一致（_resetToStart 复用 _lastFragmentData）。
   * @param {Array<{x,y,z}>} positions - 初始位置
   * @param {Array<{x,y,z}>} velocities - 初始速度
   */
  resetToInitial(positions, velocities) {
    const n = Math.min(this._fragmentBodies.length, positions.length)
    for (let i = 0; i < n; i++) {
      const b = this._fragmentBodies[i]
      const p = positions[i]
      const v = velocities[i]
      // 上一轮已静态化的块必须先恢复为动态体，否则重播时永远是固定不动的
      if (b._static || b.rigidBody.isFixed()) {
        b.rigidBody.setBodyType(RAPIER.RigidBodyType.Dynamic, false)
      }
      b._static = false
      b.rigidBody.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
      b.rigidBody.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      b.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
      b.rigidBody.setEnabled(false)
      b.flags = b.delayTime > 0 ? 0 : FLAG_ALIVE
      b._delayed = b.delayTime > 0
      b.bounceCount = 0
      b.lowSpeedFrames = 0
      b.landTriggered = false
      // 停稳状态一并复位（否则循环重播会带着上一轮的静态冻结状态）
      b._frozenPos = null
      b.floatWakeCount = 0
    }
    this.activeCount = this._fragmentBodies.length
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
    // 待激活延迟块计数（step() 全体休眠早退判定：为 0 才允许跳过求解步）
    this._pendingDelayed = this._fragmentBodies.filter(b => b._delayed).length
    this._awakeCount = 0
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /** 清除所有刚体和碰撞体 */
  _clearBodies() {
    if (!this._world) return
    this._pendingDelayed = 0
    this._awakeCount = 0
    for (const b of this._fragmentBodies) {
      try {
        this._world.removeRigidBody(b.rigidBody)
      } catch (_) {
        /* ignore */
      }
    }
    for (const body of this._tunnelColliderBodies) {
      try {
        this._world.removeRigidBody(body)
      } catch (_) {
        /* ignore */
      }
    }
    this._tunnelColliderBodies = []
  }

  /**
   * 创建隧道壁碰撞体（固定 cuboid）
   * 马蹄形：底板 + 左右直墙 + 拱顶弧段
   * 圆形：底板 + 半圆弧段
   * 矩形：底板 + 左右直墙 + 顶板
   */
  _createTunnelColliders() {
    const tb = this._tunnelBounds
    if (!tb || !this._world) return

    const right = { x: tb.rightX, y: tb.rightY, z: tb.rightZ }
    const forward = { x: tb.forwardX, y: tb.forwardY, z: tb.forwardZ }
    const up = { x: 0, y: 1, z: 0 }
    const fc = { x: tb.centerX, y: tb.floorY, z: tb.centerZ }

    // 隧道朝向四元数（右手系：用 -forward 作为 z 轴）
    const quat = basisToQuat(
      right.x,
      right.y,
      right.z,
      up.x,
      up.y,
      up.z,
      -forward.x,
      -forward.y,
      -forward.z
    )

    const halfWidth = tb.halfWidth
    const wallHeight = tb.wallHeight
    const archRadius = tb.archRadius
    const halfLen = TUNNEL_HALF_LEN
    const tunnelGroups = this.enableInterCollision ? 0xffffffff : TUNNEL_GROUPS
    const shape = tb.shape || 'horseshoe'

    // 构建马蹄形/圆形/矩形截面轮廓点（局部 x-y，不含底板，逆时针）
    const points = []
    if (shape === 'rectangular') {
      const totalH = wallHeight + (archRadius || 0)
      points.push([-halfWidth, 0])
      points.push([-halfWidth, totalH])
      points.push([halfWidth, totalH])
      points.push([halfWidth, 0])
    } else if (shape === 'circular') {
      // 半圆（底板已覆盖底部）
      const segs = 24
      for (let i = 0; i <= segs; i++) {
        const a = Math.PI * (1 - i / segs) // 从 π 到 0
        points.push([archRadius * Math.cos(a), archRadius * Math.sin(a)])
      }
    } else {
      // 马蹄形（默认）：左墙 + 拱顶弧 + 右墙
      points.push([-halfWidth, 0])
      points.push([-halfWidth, wallHeight])
      const segs = 24
      for (let i = 1; i < segs; i++) {
        const a = Math.PI - (Math.PI * i) / segs // 从 π 到 0
        points.push([archRadius * Math.cos(a), wallHeight + archRadius * Math.sin(a)])
      }
      points.push([halfWidth, wallHeight])
      points.push([halfWidth, 0])
    }

    // 构建 trimesh 顶点：轮廓 × 2（z=±halfLen），局部坐标
    const verts = []
    for (const [px, py] of points) {
      verts.push(px, py, halfLen) // 前端面
      verts.push(px, py, -halfLen) // 后端面
    }
    // 侧面三角形（相邻轮廓点 × 前后 = 2 三角形）
    // 注意：原绕序计算出的法线朝外，Rapier 的 trimesh 是单面碰撞体，
    // 碎片从隧道内部撞到背面 → 直接穿墙。这里按"双面"发射（每个三角形
    // 同时写入正/反两个绕序），无论碎片从内部还是外部撞击都被阻挡，杜绝穿模。
    // 轮廓首末点均由 y=0 处发出，闭合段会生成一块与底板 cuboid 完全重叠的
    // 水平三角形——两套法线相反的共面碰撞使墙脚接触法线方向不确定（实测
    // 贴墙碎片被逐步压入底板下方）。底部由底板 cuboid 单独承担，此处不闭合。
    const idx = []
    for (let i = 0; i < points.length - 1; i++) {
      const next = i + 1
      const i0 = i * 2
      const i1 = i * 2 + 1
      const i2 = next * 2
      const i3 = next * 2 + 1
      // 面 1 的两个绕序（原绕序 + 反向）
      idx.push(i0, i2, i1)
      idx.push(i0, i1, i2)
      // 面 2 的两个绕序（原绕序 + 反向）
      idx.push(i1, i2, i3)
      idx.push(i1, i3, i2)
    }

    // 创建隧道侧壁 trimesh 碰撞体（固定刚体，位置在 fc，旋转对齐隧道朝向）
    const wallBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y, fc.z)
      .setRotation(quat)
    const wallBody = this._world.createRigidBody(wallBodyDesc)
    const wallCol = RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx))
    // 侧墙摩擦 0.4（原 0.8 过高，碎片贴壁/贴拱易滞留不滑落，加剧"卡石"）
    wallCol.setFriction(0.4)
    wallCol.setRestitution(0.1)
    wallCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(wallCol, wallBody)
    this._tunnelColliderBodies.push(wallBody)

    // 底板单独用 cuboid（平坦，碎片在上面堆积）。厚板：顶面仍为 floorY，
    // 向下加厚使深穿透时的最近面恒为顶面（薄板会被推到板下 → 穿地）。
    const floorBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y - FLOOR_HALF_THICKNESS, fc.z)
      .setRotation(quat)
    const floorBody = this._world.createRigidBody(floorBodyDesc)
    const floorCol = RAPIER.ColliderDesc.cuboid(halfWidth + 1, FLOOR_HALF_THICKNESS, halfLen)
    // 底板摩擦 0.85：与碎片摩擦组合后 ≈0.85，使落地碎块就地停下而非沿底板
    // 高速滑行（旧值 0.8 下爆堆被摊平，实测安息角仅 8°）
    floorCol.setFriction(0.85)
    floorCol.setRestitution(0.1)
    floorCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(floorCol, floorBody)
    this._tunnelColliderBodies.push(floorBody)

    // 新掌子面封堵板：碎块初始填充在待爆棱柱 [faceOffset, faceOffset+faceDepth] 内，
    // 其后侧是新暴露的未爆破岩体（实心）。必须在**进尺末端**加一块与该断面同形的
    // 平板，阻止初始重叠分离冲量/回弹把碎块射进岩体深处（实测无此板时 20% 碎块
    // 飞到岩体内部 8~21m 处，渲染被岩体遮挡 → 堆体凭空少一块、空腔填不满）。
    // 旧实现把板放在掌子面处（z=-faceOffset），那是碎块的自由面，反而堵住抛出通道。
    // 低摩擦 + 近零恢复：贴面碎块不反弹，而是沿面滑落入堆。
    const faceDepth = Number(tb.faceDepth) > 0 ? Number(tb.faceDepth) : 2.5
    const zFace = -Math.max(1, Number(tb.faceOffset) || 3) - faceDepth
    // 计算轮廓质心（fan 三角剖分中心）
    let cxx = 0
    let cyy = 0
    for (const [px, py] of points) {
      cxx += px
      cyy += py
    }
    cxx /= points.length
    cyy /= points.length
    const capVerts = []
    const capIdx = []
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i]
      const [px2, py2] = points[(i + 1) % points.length]
      capVerts.push(px, py, zFace)
      capVerts.push(px2, py2, zFace)
      capVerts.push(cxx, cyy, zFace)
      const base = capVerts.length / 3 - 3
      // 双面绕序（正/反），无论碎片从哪侧撞击都被阻挡
      capIdx.push(base, base + 1, base + 2)
      capIdx.push(base, base + 2, base + 1)
    }
    const capBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y, fc.z)
      .setRotation(quat)
    const capBody = this._world.createRigidBody(capBodyDesc)
    const capCol = RAPIER.ColliderDesc.trimesh(new Float32Array(capVerts), new Uint32Array(capIdx))
    capCol.setFriction(0.3)
    capCol.setRestitution(0.05)
    capCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(capCol, capBody)
    this._tunnelColliderBodies.push(capBody)
  }
}

export default RapierPhysicsEngine
