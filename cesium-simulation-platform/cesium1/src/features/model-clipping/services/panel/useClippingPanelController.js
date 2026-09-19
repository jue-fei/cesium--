import { ref, computed, watch, onScopeDispose } from 'vue'
import useClipping from '../useClipping.js'
import {
  CLIPPING_AXES,
  CLIPPING_DIRECTIONS,
  DEFAULT_PLANE_UI,
  DEFAULT_POSITION_RANGE,
  POLYGON_DIRECTION_OPTIONS
} from '../../types/clippingConstants.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'

// 爆破模式下 useClipping 解构别名（非爆破时透传给其实现）
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 }

export function useClippingPanelController() {
  const clipping = useClipping()

  // 爆破场景活跃状态（订阅工具桥）
  const blastingSceneActive = ref(blastingSceneTools.active)

  const isBlast = () => blastingSceneActive.value

  // 爆破模式下 Cesium 距离滑块已弃用（爆破改用拾取式切割），移位到面板隐藏，
  // 故无需再 syncSection；非爆破路径由 useClipping 各自处理。

  const setDirection = direction => clipping.updatePolygonDirection(direction)

  const updateDepth = value => {
    currentPolygonDepth.value = Number(value) || 0
    clipping.updatePolygonDepth(currentPolygonDepth.value)
  }

  const resetPolygon = () => clipping.resetPolygonSettings()

  const updatePolygonOpacity = value => {
    currentPolygonVisualizationOpacity.value = Number(value) || 0
    clipping.updatePolygonVisualizationOpacity(currentPolygonVisualizationOpacity.value / 100)
  }

  const positionRange = ref({ ...DEFAULT_POSITION_RANGE })
  const axisArr = ref([...CLIPPING_AXES])
  const directionArr = ref([...CLIPPING_DIRECTIONS])
  const polygonModeOptions = POLYGON_DIRECTION_OPTIONS
  const currentPolygonDepth = ref(0)
  const currentPolygonVisualizationOpacity = ref(35)

  const currentPlaneDistance = ref(DEFAULT_PLANE_UI.distance)
  const currentPlaneRotationX = ref(DEFAULT_PLANE_UI.rotation.x)
  const currentPlaneRotationY = ref(DEFAULT_PLANE_UI.rotation.y)
  const currentPlaneRotationZ = ref(DEFAULT_PLANE_UI.rotation.z)
  const currentPlaneOpacity = ref(DEFAULT_PLANE_UI.opacity * 100)
  const currentPlaneColor = ref(DEFAULT_PLANE_UI.color)
  const currentPlaneAxis = ref(DEFAULT_PLANE_UI.axis)
  const currentPlaneDirection = ref(DEFAULT_PLANE_UI.direction)

  watch(
    clipping.activePlaneConfig,
    config => {
      if (config) {
        currentPlaneDistance.value = config.distance || DEFAULT_PLANE_UI.distance
        currentPlaneRotationX.value = config.rotation?.x || DEFAULT_PLANE_UI.rotation.x
        currentPlaneRotationY.value = config.rotation?.y || DEFAULT_PLANE_UI.rotation.y
        currentPlaneRotationZ.value = config.rotation?.z || DEFAULT_PLANE_UI.rotation.z
        currentPlaneOpacity.value = (config.opacity ?? DEFAULT_PLANE_UI.opacity) * 100
        currentPlaneColor.value = config.color || DEFAULT_PLANE_UI.color
        currentPlaneAxis.value = config.axis || DEFAULT_PLANE_UI.axis
        currentPlaneDirection.value = config.direction || DEFAULT_PLANE_UI.direction
      }
    },
    { immediate: true, deep: true }
  )

  watch(
    clipping.polygonDepth,
    value => {
      currentPolygonDepth.value = Number(value) || 0
    },
    { immediate: true }
  )

  watch(
    clipping.polygonVisualizationOpacity,
    value => {
      currentPolygonVisualizationOpacity.value = Math.round((Number(value) || 0) * 100)
    },
    { immediate: true }
  )

  // ── 平面裁剪：爆破模式重定向到拾取式 three 剖切，否则走 Cesium useClipping ──
  const toggleClipping = () => {
    if (isBlast()) {
      if (blastEnabled.value || pickSectionActive.value || pickedPoint.value) cancelPickSection()
      else startPickSection()
      return
    }
    clipping.toggleClipping()
  }

  const addNewPlane = () => {
    if (isBlast()) {
      startPickSection()
      return
    }
    clipping.addClippingPlane()
  }

  const removePlane = () => {
    if (isBlast()) {
      cancelPickSection()
      return
    }
    clipping.removeClippingPlane(clipping.activePlaneIndex.value)
  }

  const setActivePlane = index => {
    if (isBlast()) return
    clipping.setActiveClippingPlane(index)
  }

  const updatePlaneDistance = () => {
    if (isBlast()) return // 拾取式切割不依赖距离滑块
    clipping.updateClippingPlaneDistance({
      index: clipping.activePlaneIndex.value,
      distance: Number(currentPlaneDistance.value)
    })
  }

  const updateRotation = (axis, value) => {
    if (isBlast()) return // three 剖面仅按主轴平移，不支持任意旋转
    const val = Number(value)
    if (axis === 'X') currentPlaneRotationX.value = val
    if (axis === 'Y') currentPlaneRotationY.value = val
    if (axis === 'Z') currentPlaneRotationZ.value = val
    updatePlaneRotation()
  }

  const updatePlaneRotation = () => {
    if (isBlast()) return
    clipping.updateClippingPlaneRotation({
      index: clipping.activePlaneIndex.value,
      rotationX: Number(currentPlaneRotationX.value),
      rotationY: Number(currentPlaneRotationY.value),
      rotationZ: Number(currentPlaneRotationZ.value)
    })
  }

  const updatePlaneOpacity = () => {
    if (isBlast()) return
    clipping.updateClippingPlaneOpacity({
      index: clipping.activePlaneIndex.value,
      opacity: currentPlaneOpacity.value / 100
    })
  }

  const updatePlaneColor = () => {
    if (isBlast()) return
    clipping.updateClippingPlaneColor({
      index: clipping.activePlaneIndex.value,
      color: currentPlaneColor.value
    })
  }

  const changeAxis = axis => {
    currentPlaneAxis.value = axis
    if (isBlast()) {
      changePickAxis(axis)
      return
    }
    clipping.updateClippingPlaneAxis({
      index: clipping.activePlaneIndex.value,
      axis
    })
  }

  const changeDirection = direction => {
    currentPlaneDirection.value = direction
    if (isBlast()) return
    clipping.updateClippingPlaneDirection({
      index: clipping.activePlaneIndex.value,
      direction
    })
  }

  const resetCurrentPlane = () => {
    currentPlaneDistance.value = 0
    currentPlaneRotationX.value = 0
    currentPlaneRotationY.value = 0
    currentPlaneRotationZ.value = 0
    currentPlaneOpacity.value = 0
    currentPlaneColor.value = DEFAULT_PLANE_UI.color
    if (isBlast()) {
      cancelPickSection()
      return
    }
    clipping.resetClippingPlane(clipping.activePlaneIndex.value)
  }

  const clearAllPlanes = () => {
    if (isBlast()) {
      cancelPickSection()
      return
    }
    clipping.clearAllClippingPlanes()
  }

  const resetClipping = () => {
    if (isBlast()) {
      cancelPickSection()
      return
    }
    clipping.resetClipping()
  }

  // ── 拾取式剖切（爆破模式专用）──────────────────────────
  // 严格两步流程：① 在岩体表面拾取一点（仅显示标记，不切割）
  //              ② 选择 X/Y/Z 轴 → 才沿该轴切出过该点的平面
  const blastEnabled = ref(false) // 爆破模式下是否已应用剖面（关闭=还原完整岩体）
  const pickSectionActive = ref(false)
  const pickedPoint = ref(null) // {x,y,z} 岩体局部坐标
  const pickedAxis = ref('X')
  let _pickDetach = null

  const stopPickListening = () => {
    if (_pickDetach) {
      _pickDetach()
      _pickDetach = null
    }
    pickSectionActive.value = false
  }

  const applyPickSection = () => {
    if (!isBlast() || !pickedPoint.value) return
    blastingSceneTools.setSectionPick(AXIS_INDEX[pickedAxis.value] ?? 0, pickedPoint.value)
    blastEnabled.value = true
  }

  const startPickSection = () => {
    if (!isBlast()) return
    // 重新拾取前清除上一次的切割与标记，保证"先选点、再选方向"的顺序
    cancelPickSection()
    pickSectionActive.value = true
    _pickDetach = blastingSceneTools.pickRockPoint(res => {
      if (!res) return
      pickedPoint.value = { x: res.x, y: res.y, z: res.z }
      stopPickListening()
      // 仅标记拾取点，不自动切割；等待用户选择 X/Y/Z 轴
      blastingSceneTools.setPickPointMarker(pickedPoint.value)
    })
  }

  const changePickAxis = axis => {
    pickedAxis.value = axis
    if (pickedPoint.value) applyPickSection()
  }

  const cancelPickSection = () => {
    stopPickListening()
    pickedPoint.value = null
    blastEnabled.value = false
    blastingSceneTools.clearSectionPick()
  }

  // 订阅爆破场景激活：进入时不自动剖切（改为用户拾取一点再选轴）
  const unsubscribe = blastingSceneTools.subscribe(v => {
    blastingSceneActive.value = v
    if (!v) cancelPickSection()
  })
  onScopeDispose(() => {
    unsubscribe()
    stopPickListening()
  })

  // ── UI 数据源：爆破模式呈现 single 剖面，否则透传 useClipping ──
  // 注意：useClipping 返回的均为 ref，包裹进 computed 时必须解包 .value，
  // 否则会形成嵌套 ref，模板里字面量拼接退化为 "[object Object]"。
  const clippingEnabled = computed(() =>
    isBlast()
      ? blastEnabled.value || pickSectionActive.value || !!pickedPoint.value
      : clipping.clippingEnabled.value
  )
  const activePlaneIndex = computed(() => (isBlast() ? 0 : clipping.activePlaneIndex.value))
  const clippingPlanes = computed(() => {
    if (!isBlast()) return clipping.clippingPlanes.value
    return [
      {
        axis: currentPlaneAxis.value,
        distance: Number(currentPlaneDistance.value) || 0,
        opacity: currentPlaneOpacity.value / 100,
        color: currentPlaneColor.value,
        enabled: blastEnabled.value
      }
    ]
  })

  // ── 面板视图派生：模板直接消费的聚合/提示状态 ──
  // 当前切割面三轴旋转聚合（滑杆行按 {X,Y,Z} 渲染）
  const rotationMap = computed(() => ({
    X: currentPlaneRotationX.value,
    Y: currentPlaneRotationY.value,
    Z: currentPlaneRotationZ.value
  }))

  // 拾取式切割流程提示文案
  const pickHint = computed(() => {
    if (pickSectionActive.value) return '请在岩体表面点击选取切割点'
    if (sectionPicked.value && !blastEnabled.value) return '已拾取切割点，请选择切割轴方向'
    if (blastEnabled.value) return `已沿 ${pickedAxis.value} 轴切割，可切换轴或重新拾取`
    return '请先在岩体表面拾取切割点'
  })

  // 拾取式切割流程提示配色（warn/ok/info/muted）
  const hintTone = computed(() => {
    if (pickSectionActive.value) return 'warn'
    if (blastEnabled.value) return 'ok'
    if (sectionPicked.value) return 'info'
    return 'muted'
  })

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled: clipping.polygonClippingEnabled,
    isDrawingPolygon: clipping.isDrawingPolygon,
    polygonDepth: clipping.polygonDepth,
    polygonDirection: clipping.polygonDirection,
    polygonVisualizationOpacity: clipping.polygonVisualizationOpacity,
    blastingSceneActive,
    positionRange,
    axisArr,
    directionArr,
    polygonModeOptions,
    currentPolygonDepth,
    currentPolygonVisualizationOpacity,
    currentPlaneDistance,
    currentPlaneRotationX,
    currentPlaneRotationY,
    currentPlaneRotationZ,
    currentPlaneOpacity,
    currentPlaneColor,
    currentPlaneAxis,
    currentPlaneDirection,
    toggleClipping,
    resetClipping,
    togglePolygonClipping: clipping.togglePolygonClipping,
    toggleDrawingPolygon: clipping.toggleDrawingPolygon,
    clearAllPolygons: clipping.clearAllPolygons,
    setDirection,
    updateDepth,
    updatePolygonOpacity,
    resetPolygon,
    addNewPlane,
    removePlane,
    setActivePlane,
    updatePlaneDistance,
    updateRotation,
    updatePlaneOpacity,
    updatePlaneColor,
    changeAxis,
    changeDirection,
    resetCurrentPlane,
    clearAllPlanes,
    // 拾取式切割（爆破模式）
    pickSectionActive,
    pickedPoint,
    pickedAxis,
    blastEnabled,
    sectionPicked: computed(() => !!pickedPoint.value),
    startPickSection,
    changePickAxis,
    cancelPickSection,
    // 视图派生（模板直接消费）
    rotationMap,
    pickHint,
    hintTone
  }
}
