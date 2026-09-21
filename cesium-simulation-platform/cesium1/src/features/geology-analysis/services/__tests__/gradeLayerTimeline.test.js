/**
 * gradeLayerTimeline.test.js —— 品位层 4D 中段显现逻辑（纯函数）
 *
 * fracs 真源在后端 meta.levelRevealFracs（generate_grade_synth.py 固定 seed
 * 生成，test_grade_synth.py 锁定文件与脚本一致）；本文件只锁定
 * computeRevealedLevel 的显现判定行为。
 */
import { describe, expect, it } from 'vitest'
import { computeRevealedLevel } from '../gradeLayerService.js'

const FRACS = [0.0, 0.4, 0.75]

describe('品位层时间轴中段显现（computeRevealedLevel）', () => {
  it('进度 0 只显现首中段，推进后逐段解锁', () => {
    expect(computeRevealedLevel(0, FRACS)).toBe(0)
    expect(computeRevealedLevel(0.39, FRACS)).toBe(0)
    expect(computeRevealedLevel(0.4, FRACS)).toBe(1)
    expect(computeRevealedLevel(0.74, FRACS)).toBe(1)
    expect(computeRevealedLevel(0.75, FRACS)).toBe(2)
  })

  it('progress≥1 显现全部中段', () => {
    expect(computeRevealedLevel(1, FRACS)).toBe(2)
    expect(computeRevealedLevel(1.5, FRACS)).toBe(2)
  })

  it('无 fracs 退化为全显（Number.MAX_SAFE_INTEGER）', () => {
    expect(computeRevealedLevel(0, undefined)).toBe(Number.MAX_SAFE_INTEGER)
    expect(computeRevealedLevel(0.5, [])).toBe(Number.MAX_SAFE_INTEGER)
  })
})
