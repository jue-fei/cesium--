import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FeatureManager } from './featureManager'
import * as Cesium from 'cesium'

// 模拟 Cesium
vi.mock('cesium', () => {
  const Color = class {
    constructor(r, g, b, a) {
      this.red = r
      this.green = g
      this.blue = b
      this.alpha = a
    }
    withAlpha(a) {
      return new Color(this.red, this.green, this.blue, a)
    }
    clone() {
      return new Color(this.red, this.green, this.blue, this.alpha)
    }
  }
  Color.WHITE = new Color(1, 1, 1, 1)
  Color.YELLOW = new Color(1, 1, 0, 1)

  return {
    Color,
    Cesium3DTileset: class {},
    Cesium3DTileFeature: class {}
  }
})

describe('FeatureManager', () => {
  let manager

  beforeEach(() => {
    manager = new FeatureManager()
  })

  describe('getFeatureId', () => {
    it('should return _id if present', () => {
      const mockFeature = { _id: 'test_id_123' }
      const id = manager.getFeatureId(mockFeature)
      expect(id).toBe('test_id_123')
    })

    it('should return property ID if present', () => {
      const mockFeature = {
        getProperty: key => (key === 'id' ? 'prop_id_456' : null)
      }
      const id = manager.getFeatureId(mockFeature)
      expect(id).toBe('prop_id_456')
    })

    it('should generate random ID if no ID present', () => {
      const mockFeature = { getProperty: () => null }
      const id = manager.getFeatureId(mockFeature)
      expect(id).toMatch(/^feature_\d+_\d+$/)
    })
  })

  describe('updateModelOpacity', () => {
    it('should calculate opacity correctly (Transparency Logic)', () => {
      const feature = { color: new Cesium.Color(1, 1, 1, 1) }
      manager.featureMap.set('m1', feature)

      // 模型透明度 20（对应不透明度 80%）
      const model = { id: 'm1', name: 'M1', opacity: 20, visible: true }

      // 全局透明度 0
      const result = manager.updateModelOpacity(model, 0)

      expect(result.success).toBe(true)
      // 透明度计算：alpha = (1 - 0.2) * (1 - 0) = 0.8
      expect(feature.color.alpha).toBeCloseTo(0.8)
    })

    it('should combine global and model transparency', () => {
      const feature = { color: new Cesium.Color(1, 1, 1, 1) }
      manager.featureMap.set('m1', feature)

      // 模型透明度 50
      const model = { id: 'm1', name: 'M1', opacity: 50, visible: true }

      // 全局透明度 50
      manager.updateModelOpacity(model, 50)

      // 透明度计算：alpha = (1 - 0.5) * (1 - 0.5) = 0.25
      expect(feature.color.alpha).toBeCloseTo(0.25)
    })
  })

  describe('toggleModelVisibility', () => {
    it('should set alpha to 0 when invisible', () => {
      const feature = { color: new Cesium.Color(1, 0, 0, 1) }
      manager.featureMap.set('m1', feature)
      manager.tileset = {}

      const model = { id: 'm1', name: 'M1', opacity: 0, visible: false }
      const result = manager.toggleModelVisibility(model)

      expect(result.success).toBe(true)
      expect(feature.color.alpha).toBe(0)
    })

    it('should restore alpha when visible', () => {
      const feature = { color: new Cesium.Color(1, 0, 0, 0) }
      manager.featureMap.set('m1', feature)
      manager.tileset = {}

      // 透明度 20 => alpha 0.8
      const model = { id: 'm1', name: 'M1', opacity: 20, visible: true }
      const result = manager.toggleModelVisibility(model)

      expect(result.success).toBe(true)
      expect(feature.color.alpha).toBeCloseTo(0.8)
    })
  })

  describe('highlightModel', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should change color to highlight color and revert after duration', () => {
      const feature = {
        color: new Cesium.Color(1, 0, 0, 1)
      }
      manager.featureMap.set('m1', feature)
      manager.tileset = {}

      const model = { id: 'm1', name: 'M1', opacity: 0 }

      manager.highlightModel(model)

      // 校验颜色已切换为高亮色
      expect(feature.color.red).toBe(1)
      expect(feature.color.green).toBe(1)
      expect(feature.color.blue).toBe(0)

      // 推进定时器
      vi.advanceTimersByTime(1000)

      // 校验颜色已恢复
      expect(feature.color.red).toBe(1)
      expect(feature.color.green).toBe(0)
      expect(feature.color.blue).toBe(0)
    })
  })
})
