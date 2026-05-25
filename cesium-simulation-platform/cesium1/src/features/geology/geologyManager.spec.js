import { describe, it, expect, beforeEach } from 'vitest'
import { GeologyManager } from './geologyManager'

describe('GeologyManager', () => {
  let manager

  beforeEach(() => {
    manager = new GeologyManager()
  })

  describe('processBoreholes', () => {
    it('should validate and process boreholes correctly', () => {
      const data = [
        {
          id: 'b1',
          name: 'B1',
          x: 120,
          y: 30,
          z: 100,
          depth: 50,
          stratigraphy: []
        }
      ]

      const result = manager.processBoreholes(data)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('b1')
      expect(result[0].x).toBe(120)
      expect(result[0].entity).toBeUndefined()
    })

    it('should filter out invalid data', () => {
      const data = [{ id: 'b2' }] // Missing x, y
      const result = manager.processBoreholes(data)
      expect(result).toHaveLength(0)
    })
  })

  describe('calculateOreReserve', () => {
    it('should calculate volume and weight correctly', () => {
      const orebody = {
        id: 'o1',
        grade: 2.5,
        boundingBox: {
          minX: 0,
          maxX: 10,
          minY: 0,
          maxY: 10,
          minZ: 0,
          maxZ: 10
        }
      }

      // 体积 = 10 * 10 * 10 = 1000
      // 密度 = 2.5
      // 重量 = 1000 * 2.5 = 2500
      // 金属量 = 2500 * 2.5 / 100 = 62.5

      const result = manager.calculateOreReserve(orebody, 2.5)

      expect(result.volume).toBe(1000)
      expect(result.weight).toBe(2500)
      expect(result.metalContent).toBe(62.5)
    })

    it('should return zeros for invalid input', () => {
      const result = manager.calculateOreReserve(null)
      expect(result.volume).toBe(0)
    })

    it('should use cache for repeated calculations', () => {
      const orebody = {
        id: 'o1',
        boundingBox: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }
      }

      const res1 = manager.calculateOreReserve(orebody)
      expect(res1).toBeDefined() // Use result to satisfy linter
      // 写入缓存以验证重复调用走缓存分支
      manager.calculationCache.set(`reserve_${orebody.id}_2.7`, { volume: 999 })

      const res2 = manager.calculateOreReserve(orebody)
      const res3 = manager.calculateOreReserve(orebody)
      expect(res2).toBe(res3)
    })
  })

  describe('createSectionData', () => {
    it('should create a valid section object', () => {
      const points = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 }
      ]
      const result = manager.createSectionData(points, [])

      expect(result).toBeDefined()
      expect(result.points).toEqual(points)
      expect(result.id).toContain('section-')
    })
  })
})
