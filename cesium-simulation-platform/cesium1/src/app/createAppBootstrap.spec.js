import { describe, expect, it, vi } from 'vitest'
import { createAppBootstrap } from './createAppBootstrap.js'

function createDependencies() {
  const calls = []
  const viewerInstance = { id: 'viewer' }
  const deps = {
    viewer: {
      initViewer: vi.fn(async containerId => {
        calls.push(`viewer:init:${containerId}`)
        return viewerInstance
      }),
      destroyViewer: vi.fn(() => calls.push('viewer:destroy')),
      getViewer: vi.fn(() => viewerInstance)
    },
    model: {
      initModel: vi.fn(async () => calls.push('model:init')),
      startGlobalFpsMonitoring: vi.fn(() => calls.push('model:fps-start')),
      stopGlobalFpsMonitoring: vi.fn(() => calls.push('model:fps-stop')),
      destroyModel: vi.fn(() => calls.push('model:destroy'))
    },
    clipping: {
      initClippingManager: vi.fn(() => calls.push('clipping:init'))
    },
    geology: {
      initGeologyManager: vi.fn(viewer => calls.push(`geology:init:${viewer.id}`))
    },
    monitoring: {
      initMonitoringManager: vi.fn(async viewer => calls.push(`monitoring:init:${viewer.id}`)),
      destroyMonitoringManager: vi.fn(() => calls.push('monitoring:destroy'))
    },
    blasting: {
      initBlastingManager: vi.fn(viewer => calls.push(`blasting:init:${viewer.id}`))
    },
    measurement: {
      loadMeasurementHistory: vi.fn(() => calls.push('measurement:load'))
    },
    lifecycle: {
      notifyViewer: vi.fn(viewer => calls.push(`lifecycle:viewer:${viewer.id}`)),
      destroyAll: vi.fn(() => calls.push('lifecycle:destroy'))
    }
  }

  return { deps, calls, viewerInstance }
}

describe('createAppBootstrap', () => {
  it('按统一顺序初始化应用模块', async () => {
    const { deps, calls, viewerInstance } = createDependencies()
    const bootstrap = createAppBootstrap(deps)

    const result = await bootstrap.start('custom-container')

    expect(result).toBe(viewerInstance)
    expect(calls).toEqual([
      'viewer:init:custom-container',
      'lifecycle:viewer:viewer',
      'model:init',
      'clipping:init',
      'geology:init:viewer',
      'monitoring:init:viewer',
      'blasting:init:viewer',
      'measurement:load',
      'model:fps-start'
    ])
    expect(bootstrap.isStarted).toBe(true)
  })

  it('初始化失败时执行统一回滚', async () => {
    const { deps, calls } = createDependencies()
    deps.monitoring.initMonitoringManager.mockImplementationOnce(async viewer => {
      calls.push(`monitoring:init:${viewer.id}`)
      throw new Error('monitor failed')
    })
    const bootstrap = createAppBootstrap(deps)

    await expect(bootstrap.start()).rejects.toThrow('monitor failed')

    expect(calls).toEqual([
      'viewer:init:cesiumContainer',
      'lifecycle:viewer:viewer',
      'model:init',
      'clipping:init',
      'geology:init:viewer',
      'monitoring:init:viewer',
      'model:fps-stop',
      'lifecycle:destroy',
      'monitoring:destroy',
      'model:destroy',
      'viewer:destroy'
    ])
    expect(bootstrap.isStarted).toBe(false)
  })
})
