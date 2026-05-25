import { describe, expect, it } from 'vitest'
import { buildExampleBlastingDataset, normalizeBlastingDataset } from './blastingDataCore.js'

describe('blastingDataCore', () => {
  it('buildExampleBlastingDataset returns valid summary', () => {
    const dataset = buildExampleBlastingDataset()
    expect(dataset.summary.frameCount).toBeGreaterThan(2)
    expect(dataset.summary.fragmentCount).toBeGreaterThan(1)
    expect(dataset.summary.holeCount).toBeGreaterThan(0)
    expect(dataset.summary.rockBlockCount).toBeGreaterThan(0)
    expect(dataset.visual.fragmentRenderMode).toBe('model')
    expect(dataset.frames.length).toBe(dataset.summary.frameCount)
  })

  it('normalizeBlastingDataset normalizes user dataset', () => {
    const input = {
      event: {
        id: 'BL-001',
        name: '测试爆破',
        center: { lon: 120.1, lat: 30.2, height: 35 }
      },
      design: {
        holes: [
          {
            id: 'H1',
            collar: { lon: 120.1, lat: 30.2, height: 38 },
            toe: { lon: 120.1001, lat: 30.2001, height: 35 },
            diameter: 0.1,
            chargeKg: 40,
            delayMs: 35
          }
        ],
        rockBlocks: [{ id: 'RB1', size: 0.3, weightKg: 25 }]
      },
      frames: [
        {
          t: 0,
          waveRadius: 5,
          fragments: [{ id: 'A', size: 1, position: { lon: 120.1, lat: 30.2, height: 35 } }]
        },
        {
          t: 0.1,
          waveRadius: 12,
          fragments: [{ id: 'A', size: 1, position: { lon: 120.1002, lat: 30.2002, height: 37 } }]
        }
      ]
    }
    const result = normalizeBlastingDataset(input)
    expect(result.ok).toBe(true)
    expect(result.dataset.summary.frameCount).toBe(2)
    expect(result.dataset.summary.fragmentCount).toBe(1)
    expect(result.dataset.summary.holeCount).toBe(1)
    expect(result.dataset.summary.rockBlockCount).toBe(1)
    expect(result.dataset.design.holes[0].id).toBe('H1')
    expect(result.dataset.visual.fragmentModelUri.length).toBeGreaterThan(10)
  })

  it('generates animation frames from design data when frames are missing', () => {
    const fileA = normalizeBlastingDataset({
      event: {
        id: 'A',
        name: '方案A',
        center: { lon: 116.1, lat: 39.9, height: 0 },
        chargeKg: 150
      },
      design: {
        holes: [
          {
            id: 'A1',
            collar: { lon: 116.1, lat: 39.9, height: 2 },
            toe: { lon: 116.10005, lat: 39.90004, height: 0.2 },
            chargeKg: 25
          }
        ],
        rockBlocks: [{ id: 'RB1', size: 0.2, weightKg: 20 }]
      }
    })
    const fileB = normalizeBlastingDataset({
      event: {
        id: 'B',
        name: '方案B',
        center: { lon: 116.1, lat: 39.9, height: 0 },
        chargeKg: 360
      },
      design: {
        holes: Array.from({ length: 8 }, (_, i) => ({
          id: `B${i + 1}`,
          collar: { lon: 116.1 + i * 0.00001, lat: 39.9, height: 2 },
          toe: { lon: 116.10003 + i * 0.00001, lat: 39.90002, height: 0.2 },
          chargeKg: 45 + i
        })),
        rockBlocks: [
          { id: 'RB1', size: 0.4, weightKg: 90 },
          { id: 'RB2', size: 0.7, weightKg: 160 }
        ]
      }
    })

    expect(fileA.ok).toBe(true)
    expect(fileB.ok).toBe(true)
    expect(fileA.dataset.frames.length).toBeGreaterThan(2)
    expect(fileB.dataset.frames.length).toBeGreaterThan(2)
    expect(fileA.dataset.simulation.source).toBe('file-driven')
    expect(fileB.dataset.simulation.source).toBe('file-driven')
    expect(fileA.dataset.summary.frameCount).not.toBe(fileB.dataset.summary.frameCount)
  })
})
