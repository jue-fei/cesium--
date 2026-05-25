import * as Cesium from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { createSiteSurfaceResolver } from './siteSurfaceResolver.js'

function createResolver(overrides = {}) {
  const defaultDeps = {
    getViewer: () => null,
    transformOriginalPointToCurrent: cartesian => cartesian,
    cartesianToWorldPosition: (cartesian, fallbackHeight = 0) => {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
      return {
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: Number.isFinite(cartographic.height) ? cartographic.height : fallbackHeight
      }
    },
    getModelScaleFactor: () => 1,
    buildFeatureSurfacePointPool: () => [],
    getNearestSurfacePointFromPool: () => null,
    constants: {
      vehicleSurfaceOffset: 0.5,
      siteRadius: 50,
      siteRadiusRatio: 0.05,
      initialSiteRadiusRatio: 0.2,
      minSiteRadius: 18,
      maxSiteRadius: 65,
      minInitialRadius: 4,
      maxInitialRadius: 12,
      featureSurfaceSearchStep: 2,
      featureSurfaceSearchRings: 2
    }
  }

  return createSiteSurfaceResolver({
    ...defaultDeps,
    ...overrides
  })
}

describe('siteSurfaceResolver', () => {
  it('解析 feature id 时优先读取属性并支持回退字段', () => {
    const resolver = createResolver()

    expect(
      resolver.getFeatureId({
        getProperty: key => ({ id: 'feature-a' })[key]
      })
    ).toBe('feature-a')
    expect(resolver.getFeatureId({ id: 'feature-b' })).toBe('feature-b')
    expect(resolver.getFeatureId(null)).toBeNull()
  })

  it('命中指定子模型表面后附加车辆表面偏移', () => {
    const approximateCartesian = Cesium.Cartesian3.fromDegrees(120, 30, 100)
    const hitPosition = Cesium.Cartesian3.fromDegrees(120, 30, 88)
    const resolver = createResolver({
      getViewer: () => ({
        scene: {
          drillPickFromRay: vi.fn(() => [
            {
              object: { id: 'feature-1' },
              position: hitPosition
            }
          ])
        }
      })
    })

    const snapped = resolver.snapCartesianToFeatureSurface('feature-1', approximateCartesian)

    expect(snapped).not.toBeNull()
    expect(Cesium.Cartesian3.distance(snapped, hitPosition)).toBeGreaterThan(0)
  })

  it('解析偏移位置时优先使用 surface pool', () => {
    const pooledCartesian = Cesium.Cartesian3.fromDegrees(121, 31, 66)
    const getNearestSurfacePointFromPool = vi.fn(() => ({
      currentCartesian: pooledCartesian
    }))
    const resolver = createResolver({
      getNearestSurfacePointFromPool
    })

    const cartesian = resolver.resolveSiteOffsetCartesian(
      {
        featureId: 'feature-1',
        longitude: 120,
        latitude: 30,
        height: 50
      },
      2,
      3,
      0
    )

    expect(getNearestSurfacePointFromPool).toHaveBeenCalled()
    expect(cartesian).toBe(pooledCartesian)
  })

  it('构建采场时使用 surface pool 中最高点更新中心', () => {
    const highestOriginalCartesian = Cesium.Cartesian3.fromDegrees(120.01, 30.02, 120)
    const resolver = createResolver({
      buildFeatureSurfacePointPool: () => [{ originalCartesian: highestOriginalCartesian }]
    })

    const site = resolver.buildMiningSiteFromSpec(
      {
        id: 'feature-1',
        name: '采场1',
        radius: 1000,
        cartesian: [
          Cesium.Cartesian3.fromDegrees(120, 30, 100).x,
          Cesium.Cartesian3.fromDegrees(120, 30, 100).y,
          Cesium.Cartesian3.fromDegrees(120, 30, 100).z
        ]
      },
      { x: 120, y: 30, z: 100 }
    )

    const highestCartographic = Cesium.Cartographic.fromCartesian(highestOriginalCartesian)
    expect(site.featureId).toBe('feature-1')
    expect(site.featureName).toBe('采场1')
    expect(site.height).toBeCloseTo(highestCartographic.height)
    expect(site.radius).toBe(50)
    expect(site.initialPlacementRadius).toBe(10)
  })
})
