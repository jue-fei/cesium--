import * as Cesium from 'cesium'

const STORAGE_KEY = 'cesium-platform:ui-state'

export function loadUIState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveUIState(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用（隐私模式/配额满）时静默跳过，不影响页面
  }
}

export function clearUIState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // 同上
  }
}

function captureCamera(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return null
  const c = viewer.camera
  // Cesium 的 Cartesian3 实例没有实例方法 toArray()（1.138 起已移除），
  // 直接用 x/y/z 字段构造数组，避免序列化时抛错
  const vec3 = v => (v && typeof v.x === 'number' ? [v.x, v.y, v.z] : null)
  return {
    position: vec3(c.position),
    direction: vec3(c.direction),
    up: vec3(c.up)
  }
}

export function restoreCamera(viewer, snapshot) {
  if (!viewer || !snapshot) return
  try {
    viewer.camera.setView({
      destination: new Cesium.Cartesian3(...snapshot.position),
      orientation: {
        direction: new Cesium.Cartesian3(...snapshot.direction),
        up: new Cesium.Cartesian3(...snapshot.up)
      }
    })
  } catch {
    // 快照非法时忽略，保持默认视角
  }
}

export function restoreUIState({ getViewer, setActiveTool, isToolIdValid }) {
  const saved = loadUIState()
  if (!saved) return null
  if (saved.activeTool && (!isToolIdValid || isToolIdValid(saved.activeTool))) {
    setActiveTool(saved.activeTool)
  }
  restoreCamera(getViewer(), saved.camera)
  return saved
}

export function attachSessionSave({ getViewer, getActiveTool }) {
  const persist = () => {
    saveUIState({
      activeTool: getActiveTool(),
      camera: captureCamera(getViewer())
    })
  }
  // 页面转入后台/被冻结/即将卸载时各保存一次；多事件幂等，覆盖浏览器各类回收时机
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') persist()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', persist)
  document.addEventListener('freeze', persist)

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', persist)
    document.removeEventListener('freeze', persist)
  }
}
