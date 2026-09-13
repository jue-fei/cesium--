import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BlastPhysicsEngine } from '../core/computation/blastPhysicsEngine.js'
import { generateFragmentSpecs } from '../core/rendering/fragmentSpecGenerator.js'
import {
  REST_SPEED,
  SETTLE_REST_MASS_RATIO,
  HOLD_AFTER_SETTLED,
  REPLAY_MAX_DURATION
} from '../core/blastDefaults.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = p => readFileSync(resolve(__dirname, p), 'utf8')

/**
 * 回归：动画时长判据。
 *
 * 现象（用户实测）：波动传播与碎石抛掷早已结束，时间条还剩一大截，
 * 进度条停在 13/800（= 40s，即 REPLAY_MAX_DURATION 硬上限）。
 *
 * 根因：时长锚在"99% 碎片计数 FLAG_LANDED"上，而该计数存在平台期——
 * 少数贴合不良/反复受滚的边角石永不置位（实测约 99.3% 即到顶）。平台期
 * 一旦低于 99%，判据永不达成，`durationS` 直接回退到硬上限，时间条虚长数倍。
 *
 * 修复：改用质量加权的静止比（LANDED 或速度 < REST_SPEED），天然收敛到 1。
 */
function runScenario({ steps = 220 } = {}) {
  const W = 18
  const face = {
    cx: 0,
    cy: 3,
    cz: 0,
    nx: 0,
    ny: 0,
    nz: 1,
    rx: 1,
    ry: 0,
    rz: 0,
    ux: 0,
    uy: 1,
    uz: 0,
    width: W,
    wallHeight: 6,
    archRadius: 9,
    shape: 'horseshoe'
  }
  const kco = {
    x50: 0.14,
    x80: 0.24,
    xmax: 0.65,
    b: 2.3,
    n: 0.9,
    A: 1.0,
    sourceMode: 'computed',
    computedX50: 0.14,
    computedN: 0.9
  }
  const { specs, positions, velocities } = generateFragmentSpecs({
    kco,
    face,
    chargeKg: 83.8,
    targetCount: 83.8 * 1.5,
    countLimit: 1000,
    holes: null,
    metrics: { rockDensityKgM3: 2650, volumeRoundM3: 120 },
    randomSeed: 42
  })
  const engine = new BlastPhysicsEngine({ rng: () => 0.5 })
  engine.setTunnelBounds({
    centerX: 0,
    centerY: 3,
    centerZ: 0,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: 1,
    halfWidth: W / 2,
    wallHeight: 6,
    archRadius: 9,
    floorY: 0,
    shape: 'horseshoe'
  })
  engine.init(specs, positions, velocities)
  const total = specs.length
  let activated = false
  const trace = []
  for (let i = 0; i < steps; i++) {
    if (!activated && engine.simTime >= 0.1) {
      engine.activateAll()
      activated = true
    }
    engine.step(0.05)
    const landedFraction = engine.landedFragmentCount / total
    trace.push({
      t: engine.simTime,
      landedFraction,
      rest: engine.restMassRatio,
      energySettled: engine.getEnergyStats().settledMassRatio
    })
  }
  return trace
}

describe('动画时长判据：质量加权静止比（而非落地计数）', () => {
  const trace = runScenario()

  it('静止比在"落地计数尚未达标"时就已收敛（判据更早、更稳）', () => {
    const fired = trace.find(r => r.rest >= SETTLE_REST_MASS_RATIO)
    expect(fired).toBeTruthy()
    // 关键：触发时刻的"落地占比"明显低于 99% —— 说明旧计数判据此时还没到，
    // 而新判据已经可以收工（不再被长尾拖住）
    expect(fired.landedFraction).toBeLessThan(0.99)
    // 真实事件尺度：抛掷结束应在个位数量级秒内（而非几十秒）
    expect(fired.t).toBeLessThan(8)
  })

  it('落地计数存在平台期（旧判据可能永不达成的直接证据）', () => {
    const last = trace[trace.length - 1]
    // 跑到 11s，仍有一部分碎片未置 FLAG_LANDED
    expect(last.landedFraction).toBeLessThan(1)
    // 而静止比已收敛到 1：以速度为准的口径不受该平台期影响
    expect(last.rest).toBeGreaterThan(0.999)
    // 落地口径（只认 FLAG_LANDED）同样卡在平台期
    expect(last.energySettled).toBeLessThan(1)
  })

  it('静止比整体单调（允许 ~1e-3 抖动）、且始终 ≥ 落地质量比', () => {
    let prev = -1
    for (const r of trace) {
      // 存在受安息角判定影响的微小回落，故留 2e-3 容差；同时该抖动远小于
      // 阈值余量（平台期 ~0.999 vs 阈值 0.98），需靠"连续达标"确认抵消
      expect(r.rest).toBeGreaterThanOrEqual(prev - 2e-3)
      expect(r.rest).toBeGreaterThanOrEqual(r.energySettled - 1e-9)
      prev = r.rest
    }
  })

  it('进入达标区后不再跌出阈值（确认机制可达成的余量证据）', () => {
    const fired = trace.findIndex(r => r.rest >= SETTLE_REST_MASS_RATIO)
    expect(fired).toBeGreaterThan(-1)
    // 首次达标之后，静止比不应再回落到阈值以下（保证连续 N 帧确认能锁定）
    const drops = trace.slice(fired).filter(r => r.rest < SETTLE_REST_MASS_RATIO)
    expect(drops).toHaveLength(0)
  })
})

describe('时长常量口径', () => {
  it('阈值与硬上限落在"真实事件尺度"内', () => {
    expect(REST_SPEED).toBeGreaterThan(0)
    expect(REST_SPEED).toBeLessThan(5)
    expect(SETTLE_REST_MASS_RATIO).toBeGreaterThan(0.9)
    expect(SETTLE_REST_MASS_RATIO).toBeLessThan(1)
    // 保持时长不再以"等最后一颗石头"为尺度
    expect(HOLD_AFTER_SETTLED).toBeLessThanOrEqual(2)
    // 硬上限显著低于旧值 40s（旧值使时间条虚长数倍）
    expect(REPLAY_MAX_DURATION).toBeLessThanOrEqual(20)
  })

  it('Worker 烘焙与渲染器直播两侧共用同一组常量（无重复硬编码）', () => {
    const worker = read('../core/computation/blastPhysicsWorker.js')
    const renderer = read('../core/rendering/threeBlastingRenderer.js')
    const defaults = read('../core/blastDefaults.js')

    // 单源定义
    expect(defaults).toMatch(/export const SETTLE_REST_MASS_RATIO/)
    expect(defaults).toMatch(/export const HOLD_AFTER_SETTLED/)
    expect(defaults).toMatch(/export const REPLAY_MAX_DURATION/)

    // 两侧都是 import，不再各自硬编码 0.99 / 3 / 40
    for (const src of [worker, renderer]) {
      expect(src).toContain('blastDefaults.js')
      expect(src).not.toMatch(/SETTLE_REST_MASS_RATIO\s*=\s*0\./)
      expect(src).not.toMatch(/HOLD_AFTER_SETTLED\s*=\s*\d/)
    }
    expect(worker).not.toMatch(/landed >= total \* 0\.99/)
    expect(worker).not.toMatch(/REPLAY_MAX_DURATION\s*=\s*40/)
    expect(renderer).not.toMatch(/landed >= total \* 0\.99/)
    expect(renderer).not.toMatch(/simTime \+ 3\b/)

    // 两侧都以 restMassRatio 为判据
    expect(worker).toContain('engine.restMassRatio')
    expect(renderer).toContain('restMassRatio')
  })
})
