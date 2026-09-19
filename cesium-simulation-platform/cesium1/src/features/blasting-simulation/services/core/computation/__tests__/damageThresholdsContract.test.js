import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { DAMAGE_THRESHOLDS_CMPS } from '../vibration/shared.js'

// 前后端一致性基线（实时互算契约）：读取仓库根目录 shared-consistency-baseline.json，
// 与 kcoFormulas.test.js 共用同一契约文件；后端对应用例为
// backend-py/tests/test_damage_thresholds.py。任一端改动损伤 PPV 阈值而不同步
// 基线/对端实现，对应测试即失败，避免"两端各持一份常量"静默漂移。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = path.resolve(
  __dirname,
  '../../../../../../../../shared-consistency-baseline.json'
)
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))

// 损伤分区 PPV 阈值（cm/s）：elastic <20 / micro_crack 20–50 /
// crack_growth 50–100 / fracture 100–200 / throw ≥200
describe('damageThresholds 前后端契约', () => {
  it('DAMAGE_THRESHOLDS_CMPS 与基线 damageThresholdsCmps 逐项相等', () => {
    const baseline = BASELINE.damageThresholdsCmps
    expect(Array.isArray(baseline)).toBe(true)
    expect(DAMAGE_THRESHOLDS_CMPS).toHaveLength(baseline.length)
    baseline.forEach((v, i) => {
      expect(DAMAGE_THRESHOLDS_CMPS[i]).toBe(v)
    })
  })

  it('基线阈值单调递增且共 4 档', () => {
    const t = BASELINE.damageThresholdsCmps
    expect(t).toHaveLength(4)
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThan(t[i - 1])
    }
  })
})
