/**
 * 统一生命周期管理器。
 *
 * 管理所有依赖 Cesium Viewer/Tileset 的 Manager 实例的注册、通知与销毁。
 * Viewer 被销毁或重建时，通过此模块通知所有已注册的 Manager 更新引用或自行销毁。
 */

import { shallowRef } from 'vue'
import { warn } from '@/utils/errorHandler.js'

const managers = new Map()

const viewerRef = shallowRef(null)
const tilesetRef = shallowRef(null)

export function useLifecycle() {
  /**
   * 注册一个 Manager。
   * @param {string} name 唯一名称
   * @param {{ setViewer?: Function, setTileset?: Function, destroy?: Function }} manager
   */
  function register(name, manager) {
    if (!name || !manager) return
    if (managers.has(name)) {
      warn('lifecycle', `Manager "${name}" 重复注册，将被覆盖`)
    }
    managers.set(name, manager)

    if (viewerRef.value && typeof manager.setViewer === 'function') {
      manager.setViewer(viewerRef.value)
    }
    if (tilesetRef.value && typeof manager.setTileset === 'function') {
      manager.setTileset(tilesetRef.value)
    }
  }

  function unregister(name) {
    managers.delete(name)
  }

  function notifyViewer(viewer) {
    viewerRef.value = viewer
    for (const [name, mgr] of managers) {
      if (typeof mgr.setViewer === 'function') {
        try {
          mgr.setViewer(viewer)
        } catch (e) {
          warn('lifecycle', `Manager "${name}" setViewer 失败`, e)
        }
      }
    }
  }

  function notifyTileset(tileset) {
    tilesetRef.value = tileset
    for (const [name, mgr] of managers) {
      if (typeof mgr.setTileset === 'function') {
        try {
          mgr.setTileset(tileset)
        } catch (e) {
          warn('lifecycle', `Manager "${name}" setTileset 失败`, e)
        }
      }
    }
  }

  /**
   * 按注册逆序销毁所有 Manager。
   */
  function destroyAll() {
    const entries = [...managers.entries()].reverse()
    for (const [name, mgr] of entries) {
      if (typeof mgr.destroy === 'function') {
        try {
          mgr.destroy()
        } catch (e) {
          warn('lifecycle', `Manager "${name}" destroy 失败`, e)
        }
      }
    }
    managers.clear()
    viewerRef.value = null
    tilesetRef.value = null
  }

  function getViewer() {
    return viewerRef.value
  }

  function getTileset() {
    return tilesetRef.value
  }

  return {
    register,
    unregister,
    notifyViewer,
    notifyTileset,
    destroyAll,
    getViewer,
    getTileset
  }
}
