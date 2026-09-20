/**
 * realtimeWsContract.test.js —— 全域实时推送 WS 帧协议契约（前端侧）
 *
 * 锁定 RealtimeWsConnector 的 URL/帧类型/间隔区间与仓库根
 * shared-consistency-baseline.json#realtimeWsCmps 一致。后端对应用例为
 * backend-py/tests/test_realtime_telemetry.py（帧协议真源：realtime_ws.py）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAcceptableTelemetry } from '../connectors/RealtimeWsConnector.js'

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.realtimeWsCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('全域实时推送契约（realtimeWsCmps）', () => {
  it('baseline 结构完整', () => {
    expect(CMP.url).toBe('/ws/realtime/{scope}')
    expect(CMP.scopes).toContain('equipment')
    expect(CMP.frameTypes).toEqual(expect.arrayContaining(['telemetry', 'pong', 'error']))
    expect(CMP.minIntervalS).toBeLessThan(CMP.defaultIntervalS)
    expect(CMP.defaultIntervalS).toBeLessThan(CMP.maxIntervalS)
    expect(CMP.backoff.baseMs).toBeGreaterThan(0)
    expect(CMP.backoff.capMs).toBeGreaterThanOrEqual(CMP.backoff.baseMs)
  })

  it('RealtimeWsConnector 消费同一 URL/帧类型/消息类型', () => {
    const src = featureSrc('../connectors/RealtimeWsConnector.js')
    expect(src).toContain('/ws/realtime/')
    expect(src).toContain(`'${CMP.scopes[0]}'`)
    for (const t of CMP.frameTypes) {
      expect(src).toContain(`'${t}'`)
    }
    for (const m of CMP.clientMessages) {
      expect(src).toContain(`'${m}'`)
    }
    expect(src).toContain('backoff.js')
  })
})

describe('遥测帧 seq 过滤（isAcceptableTelemetry）', () => {
  const f = seq => ({ type: 'telemetry', seq })

  it('递增 seq 接受，重复/回退拒绝', () => {
    expect(isAcceptableTelemetry(f(1), null)).toBe(true)
    expect(isAcceptableTelemetry(f(2), 1)).toBe(true)
    expect(isAcceptableTelemetry(f(2), 2)).toBe(false)
    expect(isAcceptableTelemetry(f(1), 5)).toBe(false)
  })

  it('非遥测帧/非法 seq 拒绝', () => {
    expect(isAcceptableTelemetry({ type: 'pong' }, 0)).toBe(false)
    expect(isAcceptableTelemetry(null, 0)).toBe(false)
    expect(isAcceptableTelemetry({ type: 'telemetry' }, 0)).toBe(false)
  })
})
