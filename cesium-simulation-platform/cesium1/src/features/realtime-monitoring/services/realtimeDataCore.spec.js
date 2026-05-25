import { describe, expect, it } from 'vitest'
import {
  appendHistoryEntry,
  findNearestHistoryPoint,
  findPathSegmentByDistance,
  getHistoryTimeRange,
  getTruckStatesAtTime,
  isValidRealtimeTruckData,
  normalizeLoopProgress,
  normalizeRealtimeTruckData,
  resolveSampledPathInterpolation,
  TRAJECTORY_HISTORY_LIMIT
} from './realtimeDataCore.js'

describe('realtimeDataCore', () => {
  it('标准化循环进度到 [0, 1)', () => {
    expect(normalizeLoopProgress(1.25)).toBeCloseTo(0.25)
    expect(normalizeLoopProgress(-0.2)).toBeCloseTo(0.8)
    expect(normalizeLoopProgress(0)).toBe(0)
  })

  it('按目标距离解析路径线段并给出段内进度', () => {
    const points = [
      { cumulativeDistance: 0, id: 'a' },
      { cumulativeDistance: 10, id: 'b' },
      { cumulativeDistance: 30, id: 'c' }
    ]

    const segment = findPathSegmentByDistance(points, 20)

    expect(segment.prev.id).toBe('b')
    expect(segment.curr.id).toBe('c')
    expect(segment.segmentProgress).toBeCloseTo(0.5)
  })

  it('解析采样路径插值索引', () => {
    expect(resolveSampledPathInterpolation(0.5, 5)).toEqual({
      index1: 2,
      index2: 3,
      localProgress: 0
    })
    const wrapped = resolveSampledPathInterpolation(1.2, 5)
    expect(wrapped.index1).toBe(0)
    expect(wrapped.index2).toBe(1)
    expect(wrapped.localProgress).toBeCloseTo(0.8)
  })

  it('校验并标准化实时矿卡数据', () => {
    const raw = {
      truckId: 'T-01',
      position: { longitude: 120, latitude: 30 },
      timestamp: 100,
      speed: 12
    }

    expect(isValidRealtimeTruckData(raw)).toBe(true)
    expect(isValidRealtimeTruckData({ truckId: 'x', position: null })).toBe(false)
    expect(normalizeRealtimeTruckData(raw, 200)).toEqual({
      ...raw,
      receivedAt: 200,
      timestamp: 100,
      speed: 12,
      heading: 0,
      status: '未知',
      payload: 0,
      driver: '未知驾驶员',
      mineralType: { name: '未知', code: 'UNK' }
    })
  })

  it('维护轨迹历史上限并支持时刻查询', () => {
    const historyMap = new Map()
    for (let i = 0; i < TRAJECTORY_HISTORY_LIMIT + 2; i++) {
      appendHistoryEntry(historyMap, 'T-01', {
        timestamp: i,
        position: { longitude: i, latitude: i },
        id: i
      })
    }

    const history = historyMap.get('T-01')
    expect(history).toHaveLength(TRAJECTORY_HISTORY_LIMIT)
    expect(history[0].timestamp).toBe(2)

    const nearest = findNearestHistoryPoint(history, 801)
    expect(nearest.timestamp).toBe(801)

    const states = getTruckStatesAtTime(historyMap, 900)
    expect(states).toHaveLength(1)
    expect(states[0].id).toBe(900)
  })

  it('从轨迹历史中计算时间范围', () => {
    const historyMap = new Map([
      [
        'A',
        [
          { timestamp: 10, data: {} },
          { timestamp: 20, data: {} }
        ]
      ],
      [
        'B',
        [
          { timestamp: 5, data: {} },
          { timestamp: 30, data: {} }
        ]
      ]
    ])

    expect(getHistoryTimeRange(historyMap, 99)).toEqual({
      startTime: 5,
      endTime: 30
    })
    expect(getHistoryTimeRange(new Map(), 99)).toEqual({
      startTime: 99,
      endTime: 99
    })
  })
})
