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
    const destination = new Cesium.Cartesian3(...snapshot.position)
    // 跨场景护栏：默认配置切换（如 demo → 阿舍勒矿山）后，上次会话的相机
    // 通常在另一个模型上空（距离远超模型半径数倍），恢复它会把用户带回
    // 错误地点并盖掉 resetViewToModel 的初始视角。此处仅在快照位于当前
    // 模型附近时才恢复。
    const prims = viewer.scene && viewer.scene.primitives
    if (prims) {
      let tileset = null
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i)
        if (p.root && p.boundingSphere) {
          tileset = p
          break
        }
      }
      if (tileset) {
        const bs = tileset.boundingSphere
        const maxDist = (bs.radius || 1000) * 6
        if (Cesium.Cartesian3.distance(destination, bs.center) > maxDist) return
      }
    }
    viewer.camera.setView({
      destination,
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
