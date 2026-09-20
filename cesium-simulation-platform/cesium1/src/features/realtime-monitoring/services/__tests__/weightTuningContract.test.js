/**
 * weightTuningContract.test.js —— 多目标权重调节前后端契约（前端侧）
 *
 * 锁定 lhdSchedulingUtils.LHD_OBJECTIVES 目标 id 与仓库根 shared-consistency-baseline.json
 * 的 weightTuningCmps.objectiveIds 一致；schedulingApi / useWeightTuning 的 API 路径与
 * 权重来源枚举同源校验。后端对应用例为 backend-py/tests/test_weight_source.py。
 * 任一端改动目标 id 清单 / 来源枚举 / API 路径而不同步基线/对端实现，对应测试即失败。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LHD_OBJECTIVES } from '../lhdSchedulingUtils.js'

// 由 services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.weightTuningCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('多目标权重调节契约（weightTuningCmps）', () => {
  it('baseline 存在 weightTuningCmps 且结构完整', () => {
    expect(Array.isArray(CMP.objectiveIds)).toBe(true)
    expect(CMP.objectiveIds.length).toBeGreaterThan(0)
    expect(Array.isArray(CMP.recommendSources)).toBe(true)
    expect(CMP.api?.recommend).toContain('/api/scheduling/weights/recommend')
    expect(CMP.api?.solve).toContain('/api/scheduling/multi-objective/solve')
  })

  it('LHD_OBJECTIVES 目标 id 与 baseline.objectiveIds 一致', () => {
    expect(LHD_OBJECTIVES.map(o => o.id)).toEqual(CMP.objectiveIds)
  })

  it('schedulingApi 的 API 路径与 baseline 契约一致', () => {
    const src = featureSrc('../schedulingApi.js')
    expect(src).toContain(CMP.api.recommend.split(' ')[1])
    expect(src).toContain(CMP.api.solve.split(' ')[1])
  })

  it('权重来源枚举与 useWeightTuning 消费口径一致', () => {
    expect(CMP.recommendSources).toContain('ml-external')
    expect(CMP.recommendSources).toContain('fallback')
    const src = featureSrc('../../components/useWeightTuning.js')
    for (const s of CMP.recommendSources) {
      expect(src).toContain(`'${s}'`)
    }
  })
})
