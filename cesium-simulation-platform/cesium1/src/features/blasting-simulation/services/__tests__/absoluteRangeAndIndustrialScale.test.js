import { describe, it, expect } from 'vitest'
import { BlastingManager } from '../blastingManager.js'
import {
  NORM_FLOOR,
  INDUSTRIAL_BANDS_DEFAULT,
  industrialBandCount,
  industrialBandBoundaries,
  industrialLegendItems,
  buildIndustrialLutData,
  industrialContourColor,
  jetSrgb
} from '../core/rendering/vibrationColorScales.js'
import { computeContourLevels } from '../core/computation/contourExtractor.js'

function makeBareManager() {
  const mgr = Object.create(BlastingManager.prototype)
  mgr._vibInfluenceRadius = 15
  mgr._vibDamageMaxRadius = 7
  mgr._sadoskyK = 90
  mgr._sadoskyAlpha = 1.58
  mgr.threeBridge = {
    getThreeRenderer: () => ({
      setFieldPhysics: p => {
        mgr._pushedPhysics = p
      }
    })
  }
  mgr.getPpvStreamParams = () => ({ chargeKg: 84 })
  mgr._computeBlastSources = () => []
  mgr._pushVectorFieldNow = () => {}
  mgr._syncMonitorMarkers = () => {}
  mgr.dataset = { design: {}, event: { rockParams: {} } }
  return mgr
}

/**
 * 【绝对量程】色标满刻度在仿真开始前一次性解析扫描并固定，播放/拖动/回卷期间
 * 恒定 —— 图例区间与等值线级别因此全程有效。
 * 旧 EMA（_healFieldRef 快升慢降）随帧改满刻度，会让图例/等值线级别同步漂移，
 * 与工程图惯例相悖，已移除。
 */
describe('绝对量程（无 EMA 自愈）', () => {
  it('满刻度由解析扫描给出且固定：PPV=近场峰值、应力=场最大值', () => {
    const mgr = makeBareManager()
    mgr._pushFieldPhysics()
    const p = mgr._pushedPhysics
    const K = 90
    const alpha = 1.58
    const q = Math.pow(84, 1 / 3)
    // PPV 满刻度 = rRef=4m 代表值（解析扫描，无实测叠加）
    expect(p.ppvRefMps).toBeCloseTo(K * Math.pow(q / 4, alpha) * 0.01, 6)
    // 应力满刻度 = 场最大值（standoff=0.5m）× 近场项 F(0.5)
    const stressFactor = (2650 * 4500) / 0.75
    const vNear = K * Math.pow(q / 0.5, alpha) * 0.01
    const rb = Math.cbrt((3 * (84 / 1250)) / (4 * Math.PI))
    const rnf = Math.min(4, Math.max(0.5, 2 * rb))
    const fNear = 1 + 2 * (rnf / 0.5) ** 2
    expect(p.stressRefMPa).toBeCloseTo((stressFactor * vNear * fNear) / 1.0e6, 3)
  })

  it('再推一次参数满刻度不变（不随帧漂移）', () => {
    const mgr = makeBareManager()
    mgr._pushFieldPhysics()
    const first = { ...mgr._pushedPhysics }
    mgr._pushFieldPhysics()
    expect(mgr._pushedPhysics.ppvRefMps).toBeCloseTo(first.ppvRefMps, 12)
    expect(mgr._pushedPhysics.stressRefMPa).toBeCloseTo(first.stressRefMPa, 9)
  })
})

/**
 * 【工业离散色阶】热力图/等值线/图例三处同源对齐。
 */
describe('工业离散色阶（Jet，12~16 档）', () => {
  it('Jet 色带端点：深蓝起步、红色收尾、中部黄', () => {
    const [, , b0] = jetSrgb(0)
    expect(b0).toBeCloseTo(0.5, 6)
    const yellow = jetSrgb(0.625)
    expect(yellow[0]).toBeGreaterThan(0.99)
    expect(yellow[1]).toBeGreaterThan(0.99)
    expect(yellow[2]).toBeLessThan(0.01)
    const [r1] = jetSrgb(1)
    expect(r1).toBeCloseTo(0.5, 6)
  })

  it('档数钳制到 12~16，LUT 为 N 档 RGBA', () => {
    expect(industrialBandCount(5)).toBe(12)
    expect(industrialBandCount(14)).toBe(14)
    expect(industrialBandCount(99)).toBe(16)
    const data = buildIndustrialLutData(14)
    expect(data).toHaveLength(14 * 4)
    for (let i = 0; i < 14; i++) expect(data[i * 4 + 3]).toBe(255)
  })

  it('等值线级别 = 色阶边界（N−1 条，与 shader 归一化互逆）', () => {
    const ref = 1.03
    const levels = computeContourLevels({
      displayMode: 0,
      normMode: 1,
      ppvRefMps: ref,
      density: INDUSTRIAL_BANDS_DEFAULT
    })
    expect(levels).toHaveLength(INDUSTRIAL_BANDS_DEFAULT - 1)
    const expectBoundaries = industrialBandBoundaries({
      ref,
      normMode: 1,
      bands: INDUSTRIAL_BANDS_DEFAULT
    })
    levels.forEach((v, i) => expect(v).toBeCloseTo(expectBoundaries[i], 12))
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1])
    expect(levels[levels.length - 1]).toBeLessThan(ref)
  })

  it('图例区间覆盖 [FLOOR·满刻度, 满刻度] 且相邻区间首尾相接', () => {
    const ref = 1.03
    const items = industrialLegendItems({ ref, unitScale: 100, normMode: 1 })
    expect(items).toHaveLength(INDUSTRIAL_BANDS_DEFAULT)
    // items 已按高档在前排列
    expect(items[0].hi).toBeCloseTo(ref * 100, 6)
    expect(items[items.length - 1].lo).toBeCloseTo(ref * 100 * NORM_FLOOR, 6)
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i].lo).toBeCloseTo(items[i + 1].hi, 9)
    }
  })

  it('等值线颜色按色档亮度取黑/白实线（不再向白提亮）', () => {
    // 亮档（t≈0.6 的黄绿，亮度≈0.99）→ 黑线；暗档（深蓝）→ 白线
    expect(industrialContourColor(8)).toBe('#111111')
    expect(industrialContourColor(0)).toBe('#ffffff')
  })
})
