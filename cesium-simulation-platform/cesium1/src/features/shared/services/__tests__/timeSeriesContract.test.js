/**
 * timeSeriesContract.test.js —— 时序化工况数据前后端契约（前端侧）
 *
 * 锁定 timeSeriesClient.js 的 API 路径与 downsample 枚举与仓库根
 * shared-consistency-baseline.json#timeseriesCmps 一致。后端对应用例为
 * backend-py/tests/test_ts_store.py（策略常量真源：retention.py）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 由 features/shared/services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.timeseriesCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('时序工况数据契约（timeseriesCmps）', () => {
  it('baseline 存在 timeseriesCmps 且结构完整', () => {
    expect(CMP.downsamples).toEqual(['raw', '1m', '1h'])
    expect(CMP.bucketSeconds).toEqual({ raw: 0, '1m': 60, '1h': 3600 })
    expect(CMP.retentionDays).toEqual({ raw: 7, '1m': 90, '1h': 730 })
    expect(CMP.maxPointsPerQuery).toBeGreaterThan(0)
  })

  it('timeSeriesClient 的 API 路径与 downsample 枚举与契约一致', () => {
    const src = featureSrc('../timeSeriesClient.js')
    expect(src).toContain('/api/timeseries')
    expect(src).toContain('/api/timeseries/metrics')
    for (const d of CMP.downsamples) {
      expect(src).toContain(`'${d}'`)
    }
  })
})
