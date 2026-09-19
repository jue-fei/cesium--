/**
 * useTunnelMap3DScene.js —— Three.js 场景基础设施（TunnelMap3D 专用 composable）
 *
 * 职责：
 *   - init()：场景 / 相机 / WebGL 渲染器 / CSS2D 渲染器 / 灯光 / 轨道控制器 / 射线拾取器的创建
 *   - 渲染循环 animate：先执行场景内容注册的逐帧更新（设备巡游 / 箭头流动，来自
 *     useTunnelMap3DRebuild），再更新控制器并输出 WebGL + CSS2D 两路渲染
 *   - 射线拾取交互：悬停切换光标、点击巷道段回调 onSelect / 落空回调 onClear
 *   - dispose()：停止渲染循环、解绑事件、释放几何体/材质/渲染器并移除 CSS2D DOM
 *   - 容器尺寸自适应（ResizeObserver）
 *
 * 生命周期归属：本 composable 不注册 onMounted/onBeforeUnmount，由组件按拆分前
 * 的原有时序显式调用 init（onMounted + nextTick 后）与 dispose（onBeforeUnmount），
 * 保证创建/销毁时机与拆分前完全一致。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

// —— 场景调参常量（数值与拆分前字面量一致） ——
const SCENE_BG = '#0a0f18'
const FOG_NEAR = 520
const FOG_FAR = 1100
const CAMERA_FOV = 44
const CAMERA_NEAR = 0.5
const CAMERA_FAR = 1400
const CAMERA_POSITION = { x: 200, y: 100, z: 240 }
const CAMERA_TARGET = { x: 0, y: -15, z: 0 }
const MAX_PIXEL_RATIO = 2
const MIN_CONTAINER_HEIGHT = 340
const ORBIT_DAMPING_FACTOR = 0.08
const MAX_POLAR_ANGLE = Math.PI * 0.6

export function useTunnelMap3DScene({ containerEl, onSelect, onClear }) {
  let renderer, css2d, scene, camera, controls, raycaster, mouse, renderLoop, resizeObs
  let raycastTargets = []
  // 场景内容构建与逐帧更新由 useTunnelMap3DRebuild 在组件 setup 期注册（先于 init 调用）
  let contentBuilder = null
  let frameUpdate = null

  function setSceneContent(fn) {
    contentBuilder = fn
  }
  function setFrameUpdate(fn) {
    frameUpdate = fn
  }
  function setRaycastTargets(list) {
    raycastTargets = list
  }
  // 场景是否已创建（重建 watch 与 dispose 判空用）
  function isReady() {
    return !!scene
  }

  function animate(t) {
    renderLoop = requestAnimationFrame(animate)
    const time = t * 0.001
    frameUpdate && frameUpdate(time)
    controls && controls.update()
    renderer.render(scene, camera)
    css2d.render(scene, camera)
  }

  function init() {
    const el = containerEl.value
    const w = el.clientWidth
    const h = el.clientHeight || MIN_CONTAINER_HEIGHT

    scene = new THREE.Scene()
    scene.background = new THREE.Color(SCENE_BG)
    scene.fog = new THREE.Fog(SCENE_BG, FOG_NEAR, FOG_FAR)

    camera = new THREE.PerspectiveCamera(CAMERA_FOV, w / h, CAMERA_NEAR, CAMERA_FAR)
    camera.position.set(CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z)
    camera.lookAt(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z)

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))
    renderer.setSize(w, h)
    el.insertBefore(renderer.domElement, el.firstChild)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    css2d = new CSS2DRenderer()
    css2d.setSize(w, h)
    css2d.domElement.style.position = 'absolute'
    css2d.domElement.style.inset = '0'
    css2d.domElement.style.pointerEvents = 'none'
    el.insertBefore(css2d.domElement, renderer.domElement.nextSibling)

    scene.add(new THREE.AmbientLight('#9fb3c8', 0.95))
    const key = new THREE.DirectionalLight('#ffffff', 1.2)
    key.position.set(200, 320, 140)
    scene.add(key)
    const fill = new THREE.DirectionalLight('#6aa3ff', 0.5)
    fill.position.set(-200, 60, -140)
    scene.add(fill)
    const warm = new THREE.PointLight('#ffb35c', 0.45, 700)
    warm.position.set(-120, -80, 150)
    scene.add(warm)

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = ORBIT_DAMPING_FACTOR
    controls.target.set(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z)
    controls.maxPolarAngle = MAX_POLAR_ANGLE
    // 交互口径：左键旋转，中键拖拽平移（模型在视野中上下左右移动），右键+滚轮缩放
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.DOLLY
    }

    raycaster = new THREE.Raycaster()
    mouse = new THREE.Vector2()
    renderer.domElement.addEventListener('pointermove', onHover)
    renderer.domElement.addEventListener('click', onClick)
    // 抑制中键默认的“自动滚动”光标/滚屏，只把中键交给 OrbitControls 做平移拖拽
    renderer.domElement.addEventListener('mousedown', e => {
      if (e.button === 1) e.preventDefault()
    })

    contentBuilder && contentBuilder()
    animate(performance.now())

    resizeObs = new ResizeObserver(() => {
      const nw = el.clientWidth
      const nh = el.clientHeight || MIN_CONTAINER_HEIGHT
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      css2d.setSize(nw, nh)
    })
    resizeObs.observe(el)
  }

  function pickPointer(e) {
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }
  function onHover(e) {
    if (!raycaster) return
    pickPointer(e)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(raycastTargets, false)
    renderer.domElement.style.cursor = hits.length ? 'pointer' : 'default'
  }
  function onClick(e) {
    if (!raycaster) return
    pickPointer(e)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(raycastTargets, false)
    if (hits.length && hits[0].object.userData.segId) onSelect(hits[0].object.userData.segId)
    else onClear()
  }

  function dispose() {
    renderLoop && cancelAnimationFrame(renderLoop)
    resizeObs && resizeObs.disconnect()
    if (renderer) {
      renderer.domElement.removeEventListener('pointermove', onHover)
      renderer.domElement.removeEventListener('click', onClick)
    }
    scene &&
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material)
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose())
      })
    renderer && renderer.dispose()
    if (css2d) css2d.domElement && css2d.domElement.remove()
    renderer = css2d = scene = camera = controls = null
  }

  return { init, dispose, isReady, setSceneContent, setFrameUpdate, setRaycastTargets }
}
