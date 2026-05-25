import { ref, watch } from 'vue'
import useClipping from '../useClipping.js'
import {
  CLIPPING_AXES,
  CLIPPING_DIRECTIONS,
  DEFAULT_PLANE_UI,
  DEFAULT_POSITION_RANGE,
  POLYGON_DIRECTION_OPTIONS
} from '../../types/clippingConstants.js'

export function useClippingPanelController() {
  const {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    activePlaneConfig,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    polygonVisualizationOpacity,
    toggleClipping,
    addClippingPlane,
    removeClippingPlane,
    setActiveClippingPlane,
    updateClippingPlaneDistance,
    updateClippingPlaneRotation,
    updateClippingPlaneOpacity,
    updateClippingPlaneColor,
    updateClippingPlaneAxis,
    updateClippingPlaneDirection,
    resetClippingPlane,
    clearAllClippingPlanes,
    resetClipping,
    togglePolygonClipping,
    toggleDrawingPolygon,
    clearAllPolygons,
    updatePolygonDepth,
    updatePolygonDirection,
    updatePolygonVisualizationOpacity,
    resetPolygonSettings
  } = useClipping()

  const setDirection = direction => {
    updatePolygonDirection(direction)
  }

  const updateDepth = value => {
    currentPolygonDepth.value = Number(value) || 0
    updatePolygonDepth(currentPolygonDepth.value)
  }

  const resetPolygon = () => {
    resetPolygonSettings()
  }

  const updatePolygonOpacity = value => {
    currentPolygonVisualizationOpacity.value = Number(value) || 0
    updatePolygonVisualizationOpacity(currentPolygonVisualizationOpacity.value / 100)
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
    activePlaneConfig,
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
    polygonDepth,
    value => {
      currentPolygonDepth.value = Number(value) || 0
    },
    { immediate: true }
  )

  watch(
    polygonVisualizationOpacity,
    value => {
      currentPolygonVisualizationOpacity.value = Math.round((Number(value) || 0) * 100)
    },
    { immediate: true }
  )

  const addNewPlane = () => {
    addClippingPlane()
  }

  const removePlane = index => {
    removeClippingPlane(index)
  }

  const setActivePlane = index => {
    setActiveClippingPlane(index)
  }

  const updatePlaneDistance = () => {
    updateClippingPlaneDistance({
      index: activePlaneIndex.value,
      distance: Number(currentPlaneDistance.value)
    })
  }

  const updateRotation = (axis, value) => {
    const val = Number(value)
    if (axis === 'X') currentPlaneRotationX.value = val
    if (axis === 'Y') currentPlaneRotationY.value = val
    if (axis === 'Z') currentPlaneRotationZ.value = val
    updatePlaneRotation()
  }

  const updatePlaneRotation = () => {
    updateClippingPlaneRotation({
      index: activePlaneIndex.value,
      rotationX: Number(currentPlaneRotationX.value),
      rotationY: Number(currentPlaneRotationY.value),
      rotationZ: Number(currentPlaneRotationZ.value)
    })
  }

  const updatePlaneOpacity = () => {
    updateClippingPlaneOpacity({
      index: activePlaneIndex.value,
      opacity: currentPlaneOpacity.value / 100
    })
  }

  const updatePlaneColor = () => {
    updateClippingPlaneColor({
      index: activePlaneIndex.value,
      color: currentPlaneColor.value
    })
  }

  const changeAxis = axis => {
    currentPlaneAxis.value = axis
    updateClippingPlaneAxis({
      index: activePlaneIndex.value,
      axis
    })
  }

  const changeDirection = direction => {
    currentPlaneDirection.value = direction
    updateClippingPlaneDirection({
      index: activePlaneIndex.value,
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
    resetClippingPlane(activePlaneIndex.value)
  }

  const clearAllPlanes = () => {
    clearAllClippingPlanes()
  }

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    polygonVisualizationOpacity,
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
    togglePolygonClipping,
    toggleDrawingPolygon,
    clearAllPolygons,
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
    clearAllPlanes
  }
}
