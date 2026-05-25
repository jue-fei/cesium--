import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useViewerStore } from './viewerStore.js'

describe('Viewer Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('should have initial state', () => {
    const store = useViewerStore()
    expect(store.viewer).toBe(null)
    expect(store.coordinateSystem).toBe('wgs84')
    expect(store.displayQuality).toBe('high')
    expect(store.terrainQuality).toBe('high')
  })

  it('should update display quality', () => {
    const store = useViewerStore()
    store.setDisplayQuality('low')
    expect(store.displayQuality).toBe('low')
  })

  it('should update terrain quality', () => {
    const store = useViewerStore()
    store.setTerrainQuality('medium')
    expect(store.terrainQuality).toBe('medium')
  })

  it('should update coordinate system', () => {
    const store = useViewerStore()
    store.setCoordinateSystem('gcj02')
    expect(store.coordinateSystem).toBe('gcj02')
  })

  it('should set viewer instance', () => {
    const store = useViewerStore()
    const mockViewer = { isDestroyed: () => false, destroy: () => {} }
    store.setViewer(mockViewer)
    expect(store.viewer).toBe(mockViewer)
  })
})
