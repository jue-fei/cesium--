import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { useModelStore } from '../stores/modelStore.js'
import useViewer from './useViewer.js'

const RULER_COLOR = Cesium.Color.WHITE.withAlpha(0.88)
const GUIDE_COLOR = Cesium.Color.WHITE.withAlpha(0.35)
const LABEL_COLOR = Cesium.Color.fromCssColorString('#FFD400')
const LABEL_CARD_COLOR = Cesium.Color.fromCssColorString('#F4F7FB').withAlpha(0.72)
const LABEL_STEP = 50
const ABOVE_GROUND_HEIGHT = 100
const BELOW_GROUND_DEPTH = 500

let polylineCollection = null
let labelCollection = null
const enabled = ref(false)

function removePrimitives() {
  if (polylineCollection) {
    polylineCollection.removeAll()
  }
  if (labelCollection) {
    labelCollection.removeAll()
  }
}

function getFramePosition(transform, x, y, z) {
  return Cesium.Matrix4.multiplyByPoint(
    transform,
    new Cesium.Cartesian3(x, y, z),
    new Cesium.Cartesian3()
  )
}

function createColorMaterial(color) {
  return new Cesium.Material({
    fabric: {
      type: 'Color',
      uniforms: { color }
    }
  })
}

function createDashMaterial(color) {
  return new Cesium.Material({
    fabric: {
      type: 'PolylineDash',
      uniforms: {
        color,
        gapColor: Cesium.Color.TRANSPARENT,
        dashLength: 14
      }
    }
  })
}

function resolveSurfaceZ(viewer, tileset, center, localFrame, fallbackSurfaceZ) {
  const scene = viewer?.scene
  const centerCartographic = Cesium.Cartographic.fromCartesian(center)
  if (!scene || !centerCartographic) return fallbackSurfaceZ

  const samplePoint = new Cesium.Cartographic(
    centerCartographic.longitude,
    centerCartographic.latitude,
    centerCartographic.height
  )

  let surfaceHeight

  try {
    if (typeof scene.sampleHeight === 'function' && scene.mode === Cesium.SceneMode.SCENE3D) {
      const sampledHeight = scene.sampleHeight(samplePoint, tileset ? [tileset] : [])
      if (Number.isFinite(sampledHeight)) surfaceHeight = sampledHeight
    }
  } catch {
    /* noop */
  }

  if (!Number.isFinite(surfaceHeight)) {
    const globeHeight = scene.globe?.getHeight?.(samplePoint)
    if (Number.isFinite(globeHeight)) surfaceHeight = globeHeight
  }

  if (!Number.isFinite(surfaceHeight)) return fallbackSurfaceZ

  const surfaceCartesian = Cesium.Cartesian3.fromRadians(
    centerCartographic.longitude,
    centerCartographic.latitude,
    surfaceHeight
  )
  const inverseFrame = Cesium.Matrix4.inverseTransformation(localFrame, new Cesium.Matrix4())
  const localSurfacePosition = Cesium.Matrix4.multiplyByPoint(
    inverseFrame,
    surfaceCartesian,
    new Cesium.Cartesian3()
  )

  return Number.isFinite(localSurfacePosition.z) ? localSurfacePosition.z : fallbackSurfaceZ
}

function formatDepthLabel(depth) {
  if (depth === 0) return '0m'
  return depth > 0 ? `+${depth}m` : `${depth}m`
}

function buildRuler(viewer, tileset) {
  if (!viewer || !viewer.scene || !tileset) return false
  const center = tileset.boundingSphere?.center
  const radius = tileset.boundingSphere?.radius || 200
  if (!center) return false
  const localFrame = Cesium.Transforms.eastNorthUpToFixedFrame(center)
  const rulerOffsetX = radius * 1.004
  const guideEndX = radius
  const tickOuterX = rulerOffsetX + radius * 0.05
  const labelOffsetX = tickOuterX + radius * 0.025
  const surfaceZ = resolveSurfaceZ(viewer, tileset, center, localFrame, radius)
  const topZ = surfaceZ + ABOVE_GROUND_HEIGHT
  const bottomZ = surfaceZ - BELOW_GROUND_DEPTH

  if (!polylineCollection) {
    polylineCollection = new Cesium.PolylineCollection()
    viewer.scene.primitives.add(polylineCollection)
  }
  if (!labelCollection) {
    labelCollection = new Cesium.LabelCollection()
    viewer.scene.primitives.add(labelCollection)
  }

  removePrimitives()

  polylineCollection.add({
    positions: [
      getFramePosition(localFrame, rulerOffsetX, 0, topZ),
      getFramePosition(localFrame, rulerOffsetX, 0, bottomZ)
    ],
    width: 2.5,
    material: createColorMaterial(RULER_COLOR)
  })

  for (let offset = ABOVE_GROUND_HEIGHT; offset >= -BELOW_GROUND_DEPTH; offset -= LABEL_STEP) {
    const z = surfaceZ + offset

    polylineCollection.add({
      positions: [
        getFramePosition(localFrame, guideEndX, 0, z),
        getFramePosition(localFrame, rulerOffsetX, 0, z)
      ],
      width: 1.2,
      material: createDashMaterial(GUIDE_COLOR)
    })

    polylineCollection.add({
      positions: [
        getFramePosition(localFrame, rulerOffsetX, 0, z),
        getFramePosition(localFrame, tickOuterX, 0, z)
      ],
      width: 1.8,
      material: createColorMaterial(RULER_COLOR)
    })

    labelCollection.add({
      position: getFramePosition(localFrame, labelOffsetX, 0, z),
      text: formatDepthLabel(offset),
      font: 'bold 18px sans-serif',
      fillColor: LABEL_COLOR,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: LABEL_CARD_COLOR,
      backgroundPadding: new Cesium.Cartesian2(10, 6),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(6, 0)
    })
  }

  return true
}

let watchInstalled = false

export function useDepthRuler() {
  const modelStore = useModelStore()
  const { tileset } = storeToRefs(modelStore)
  const { getViewer } = useViewer()

  function renderRuler() {
    const viewer = getViewer()
    const t = tileset.value
    if (!viewer || !t || !enabled.value) {
      hideRuler()
      return
    }
    if (!t.boundingSphere?.center) return
    buildRuler(viewer, t)
  }

  function hideRuler() {
    removePrimitives()
  }

  function showRuler() {
    renderRuler()
  }

  function toggle() {
    enabled.value = !enabled.value
    if (enabled.value) {
      showRuler()
    } else {
      hideRuler()
    }
  }

  if (!watchInstalled) {
    watchInstalled = true

    watch(
      () => tileset.value,
      t => {
        if (!t) {
          hideRuler()
          return
        }
        if (enabled.value && t.boundingSphere?.center) {
          renderRuler()
        }
      },
      { immediate: true }
    )

    watch(
      enabled,
      value => {
        if (value) {
          renderRuler()
        } else {
          hideRuler()
        }
      },
      { immediate: true }
    )
  }

  return {
    enabled,
    show: showRuler,
    hide: hideRuler,
    toggle
  }
}
