import { describe, it, expect } from 'vitest'
import { BlastingManager } from '../blastingManager.js'

/**
 * 回归：拖动进度条 Seek 后热力图骤暗 / 损伤区错位（"Seek Bug 仍未解决"）。
 *
 * 根因：WS 推流启动后，首个二进制帧携带后端网格 → ensureVibrationField →
 * _syncLocalVibrationSimGrid 按后端网格重建本地模拟器，但只传了网格/装药/边界，
 * 漏传 K/α/influenceRadius → 重建后的模拟器回落
 * 默认 K=30（场地标定值 K=90）、α=1.5（标定 1.58）、包络关闭。
 * 暂停（stopStream 后本地接管）、推流完成后回拖进度条时，本地模拟器写入的
 * 场值比 WS 帧暗约 3 倍且无包络收束——表现为"拖动进度条后画面变化/变暗"。
 *
 * 修复：重建时透传全部物理口径参数，保证 WS 模式与本地接管模式同一物理曲线。
 * （载波与损伤硬上限已废弃：损伤半径由 PPV 阈值纯物理计算，不做人工收束。）
 */
function makeBareManager() {
  const mgr = Object.create(BlastingManager.prototype)
  mgr._sadoskyK = 90
  mgr._sadoskyAlpha = 1.58
  mgr._vibInfluenceRadius = 30
  mgr.getPpvStreamParams = () => ({
    chargeKg: 84,
    k: 90,
    alpha: 1.58,
    tunnelWidth: 12,
    tunnelHeight: 10
  })
  mgr._computeBlastOrigin = () => [0, 5, 1]
  mgr._computeBlastSources = () => [{ x: 0, y: 5, z: 1, chargeKg: 42, delayMs: 0 }]
  mgr._tunnelFaceConfig = () => null
  mgr.threeBridge = { getThreeRenderer: () => null }
  mgr._vibComputeClient = { dispose: () => {} }
  mgr._localVibrationSim = null
  mgr._localParticleSystem = null
  mgr._particleEmitState = null
  return mgr
}

describe('WS 网格同步重建本地模拟器保留全部物理参数（seek 骤暗回归）', () => {
  it('重建后 K/α/包络与标定值一致', () => {
    const mgr = makeBareManager()
    mgr._syncLocalVibrationSimGrid({
      gridShape: [19, 15, 18],
      boundsMin: [-13.5, -3, 0],
      boundsMax: [13.5, 18, 25]
    })
    const sim = mgr._localVibrationSim
    expect(sim).toBeTruthy()
    expect(sim.params.K).toBe(90)
    expect(sim.params.alpha).toBe(1.58)
    expect(sim.params.influenceRadius).toBe(30)
    // 损伤半径由 PPV 阈值纯物理计算，不设人工上限（载波亦已废弃）
    expect(sim.params.damageMaxRadius).toBeUndefined()
    expect(sim.params.carrierHz).toBeUndefined()
  })

  it('同网格重复同步不重建（保持参数不再丢失）', () => {
    const mgr = makeBareManager()
    const cfg = {
      gridShape: [19, 15, 18],
      boundsMin: [-13.5, -3, 0],
      boundsMax: [13.5, 18, 25]
    }
    mgr._syncLocalVibrationSimGrid(cfg)
    const sim1 = mgr._localVibrationSim
    mgr._syncLocalVibrationSimGrid(cfg)
    expect(mgr._localVibrationSim).toBe(sim1)
    expect(sim1.params.K).toBe(90)
  })
})
