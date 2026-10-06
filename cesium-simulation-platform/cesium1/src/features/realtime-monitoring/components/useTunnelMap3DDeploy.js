/**
 * useTunnelMap3DDeploy.js —— 拖拽式设备部署交互（3.2，TunnelMap3D 专用 composable）
 *
 * 职责（仅 props.deployMode 开启时绑定事件，关闭即解绑）：
 *   - 悬停设备显示抓取光标；在设备上按下进入拖拽（临时禁用轨道控制器，拖完恢复）
 *   - 拖拽中设备沿其所在高度的水平面跟随指针；同时按屏幕距离在节点球中寻找吸附
 *     目标（跨水平节点同样可命中——按屏幕所见即所得），并以高亮环指示
 *   - 松开：命中节点则回调 onDeploy({equipIndex, equipId, node, level})，由父组件
 *     PUT /api/deployment 持久化并联动调度；未命中则设备回弹原位
 *
 * 依赖：sceneApi.getCamera/getRendererDom/setControlsEnabled（场景基础设施暴露）、
 * rebuildApi.getNodeBalls/getEquipGroups（rebuild 暴露的只读访问器）。
 */
import { watch, onBeforeUnmount } from 'vue'
import * as THREE from 'three'

// 吸附判定：指针与节点球中心的屏幕距离阈值（像素，按画布对角归一）
const SNAP_PX = 52
// 吸附高亮环（工程黄，与选中巷道的亮黄口径区分：环躺在节点上而非套在巷道上）
const SNAP_RING_COLOR = '#facc15'
const SNAP_RING_RADIUS = 6.0
const SNAP_RING_TUBE = 0.7

export function useTunnelMap3DDeploy({ props, sceneApi, rebuildApi, onDeploy }) {
  let dragging = null // { group, equipIndex, equipId, startPos, planeY }
  let snapTarget = null // { node, level, pos }
  let snapRing = null
  const pointer = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const dragPlane = new THREE.Plane()
  const planeHit = new THREE.Vector3()
  const tmpV = new THREE.Vector3()

  function setPointer(e) {
    const el = sceneApi.getRendererDom()
    if (!el) return
    const rect = el.getBoundingClientRect()
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  function ensureRing() {
    const scene = sceneApi.getScene()
    if (!scene) return
    if (!snapRing) {
      snapRing = new THREE.Mesh(
        new THREE.TorusGeometry(SNAP_RING_RADIUS, SNAP_RING_TUBE, 10, 36),
        new THREE.MeshBasicMaterial({
          color: SNAP_RING_COLOR,
          transparent: true,
          opacity: 0.95,
          depthWrite: false
        })
      )
      snapRing.rotation.x = -Math.PI / 2 // 平躺在节点所在水平面
      snapRing.renderOrder = 6
    }
    snapRing.visible = false
    scene.add(snapRing)
  }

  function removeRing() {
    if (snapRing) {
      snapRing.geometry.dispose()
      snapRing.material.dispose()
      snapRing.removeFromParent()
      snapRing = null
    }
  }

  // 屏幕空间最近节点球（含水平信息）：距离阈值按画布尺寸换算为 NDC 半径
  function findSnap() {
    const cam = sceneApi.getCamera()
    if (!cam) return null
    const el = sceneApi.getRendererDom()
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // NDC 半径 = SNAP_PX 像素 / 画布半宽（x 轴）与半高（y 轴）分别换算
    const rx = (SNAP_PX / rect.width) * 2
    const ry = (SNAP_PX / rect.height) * 2
    let best = null
    for (const b of rebuildApi.getNodeBalls()) {
      const ud = b.userData || {}
      if (ud.nodeId == null) continue // 地表井口等非部署目标
      tmpV.copy(b.position).project(cam)
      if (tmpV.z < -1 || tmpV.z > 1) continue // 相机背后/远裁剪外
      const dx = (pointer.x - tmpV.x) / rx
      const dy = (pointer.y - tmpV.y) / ry
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= 1 && (!best || d < best.d)) best = { d, node: ud.nodeId, level: ud.level, pos: b.position }
    }
    return best
  }

  function updateSnapVisual() {
    snapTarget = dragging ? findSnap() : null
    if (snapRing) {
      if (snapTarget) {
        snapRing.position.copy(snapTarget.pos).add(new THREE.Vector3(0, 1.2, 0))
        snapRing.visible = true
      } else {
        snapRing.visible = false
      }
    }
  }

  function onPointerDown(e) {
    if (e.button !== 0 || dragging) return
    const cam = sceneApi.getCamera()
    if (!cam) return
    setPointer(e)
    raycaster.setFromCamera(pointer, cam)
    // 递归拾取设备子网格，再向上找到设备组（组上带 equipIndex/equipId）
    const hits = raycaster.intersectObjects(rebuildApi.getEquipGroups(), true)
    if (!hits.length) return
    let group = hits[0].object
    while (group && !(group.userData && group.userData.equipIndex != null)) group = group.parent
    if (!group) return
    // 进入拖拽：接管左键（禁轨道控制器），设备沿当前高度水平面跟随
    dragging = {
      group,
      equipIndex: group.userData.equipIndex,
      equipId: group.userData.equipId,
      startPos: group.position.clone(),
      planeY: group.position.y
    }
    group.userData.dragging = true
    dragPlane.set(new THREE.Vector3(0, 1, 0), -dragging.planeY)
    sceneApi.setControlsEnabled(false)
    const el = sceneApi.getRendererDom()
    el.style.cursor = 'grabbing'
    el.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (!sceneApi.getRendererDom()) return
    setPointer(e)
    if (dragging) {
      raycaster.setFromCamera(pointer, sceneApi.getCamera())
      if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
        dragging.group.position.set(planeHit.x, dragging.planeY, planeHit.z)
      }
      updateSnapVisual()
      return
    }
    // 非拖拽悬停：命中设备显示抓取光标（覆盖场景默认光标）
    const cam = sceneApi.getCamera()
    if (!cam) return
    raycaster.setFromCamera(pointer, cam)
    const hits = raycaster.intersectObjects(rebuildApi.getEquipGroups(), true)
    const el = sceneApi.getRendererDom()
    el.style.cursor = hits.length ? 'grab' : 'default'
  }

  function onPointerUp(e) {
    const el = sceneApi.getRendererDom()
    if (e && el && el.releasePointerCapture) {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch (_) {
        /* 指针已释放时忽略 */
      }
    }
    if (!dragging) return
    const { group, equipIndex, equipId, startPos } = dragging
    group.userData.dragging = false
    const target = snapTarget
    dragging = null
    snapTarget = null
    if (snapRing) snapRing.visible = false
    sceneApi.setControlsEnabled(true)
    if (el) el.style.cursor = 'default'
    if (target) onDeploy({ equipIndex, equipId, node: target.node, level: target.level })
    else group.position.copy(startPos) // 未命中节点：回弹原位
  }

  function bind() {
    const el = sceneApi.getRendererDom()
    if (!el) return
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    sceneApi.setDeployCameraMode(true)
    ensureRing()
  }

  function unbind() {
    const el = sceneApi.getRendererDom()
    if (el) {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      el.style.cursor = 'default'
    }
    onPointerUp(null)
    sceneApi.setDeployCameraMode(false)
    removeRing()
  }

  watch(
    () => props.deployMode,
    mode => {
      if (mode) bind()
      else unbind()
    },
    { immediate: true }
  )

  onBeforeUnmount(unbind)

  return { isDragging: () => !!dragging }
}
