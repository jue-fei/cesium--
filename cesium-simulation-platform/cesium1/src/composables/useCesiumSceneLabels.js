import { watch, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { useViewerStore } from '@/stores/viewerStore.js'

const DEFAULT_BACKGROUND = Cesium.Color.BLACK.withAlpha(0.72)
const DEFAULT_OUTLINE = Cesium.Color.BLACK
const ENTITY_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(150, 1.6, 6000, 0.7)
const ENTITY_PIXEL_OFFSET_SCALE = new Cesium.NearFarScalar(150, 1.1, 6000, 0.85)
const PRIMITIVE_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(150, 1.6, 6000, 0.7)
const PRIMITIVE_PIXEL_OFFSET_SCALE = new Cesium.NearFarScalar(150, 1.1, 6000, 0.85)
const SCAN_INTERVAL_MS = 400

function readPropertyValue(value) {
  if (value && typeof value.getValue === 'function') {
    try {
      return value.getValue(Cesium.JulianDate.now())
    } catch {
      return undefined
    }
  }
  return value
}

function ensureEntityLabelStyle(label) {
  if (!label) return

  label.scaleByDistance = ENTITY_SCALE_BY_DISTANCE
  label.pixelOffsetScaleByDistance = ENTITY_PIXEL_OFFSET_SCALE
  label.disableDepthTestDistance = Number.POSITIVE_INFINITY
  label.style = Cesium.LabelStyle.FILL_AND_OUTLINE

  if (!readPropertyValue(label.showBackground)) {
    label.showBackground = true
  }
  if (!readPropertyValue(label.backgroundColor)) {
    label.backgroundColor = DEFAULT_BACKGROUND
  }
  if (!readPropertyValue(label.outlineColor)) {
    label.outlineColor = DEFAULT_OUTLINE
  }

  const outlineWidth = Number(readPropertyValue(label.outlineWidth))
  if (!Number.isFinite(outlineWidth) || outlineWidth < 3) {
    label.outlineWidth = 3
  }
}

function ensurePrimitiveLabelStyle(label) {
  if (!label) return

  label.scaleByDistance = PRIMITIVE_SCALE_BY_DISTANCE
  label.pixelOffsetScaleByDistance = PRIMITIVE_PIXEL_OFFSET_SCALE
  label.disableDepthTestDistance = Number.POSITIVE_INFINITY
  label.style = Cesium.LabelStyle.FILL_AND_OUTLINE
  label.showBackground = true
  label.backgroundColor = label.backgroundColor || DEFAULT_BACKGROUND
  label.outlineColor = label.outlineColor || DEFAULT_OUTLINE
  label.outlineWidth = Math.max(Number(label.outlineWidth) || 0, 3)
}

function walkPrimitiveCollection(collection, visitor) {
  if (!collection || typeof collection.length !== 'number' || typeof collection.get !== 'function')
    return

  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index)
    if (!primitive) continue
    visitor(primitive)
    walkPrimitiveCollection(primitive, visitor)
  }
}

function applySceneLabelStyles(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return

  const entities = Array.isArray(viewer.entities?.values) ? viewer.entities.values : []
  entities.forEach(entity => ensureEntityLabelStyle(entity?.label))

  walkPrimitiveCollection(viewer.scene?.primitives, primitive => {
    if (!(primitive instanceof Cesium.LabelCollection)) return
    for (let index = 0; index < primitive.length; index += 1) {
      ensurePrimitiveLabelStyle(primitive.get(index))
    }
  })
}

export function useCesiumSceneLabels() {
  const store = useViewerStore()
  const { viewer } = storeToRefs(store)
  let detachPostRender = null
  let lastScanTime = 0

  const stopWatching = watch(
    viewer,
    nextViewer => {
      if (detachPostRender) {
        detachPostRender()
        detachPostRender = null
      }
      if (!nextViewer || nextViewer.isDestroyed?.()) return

      const scanLabels = () => {
        const now = Date.now()
        if (now - lastScanTime < SCAN_INTERVAL_MS) return
        lastScanTime = now
        applySceneLabelStyles(nextViewer)
      }

      nextViewer.scene?.postRender?.addEventListener(scanLabels)
      applySceneLabelStyles(nextViewer)

      detachPostRender = () => {
        try {
          nextViewer.scene?.postRender?.removeEventListener(scanLabels)
        } catch {
          /* noop */
        }
      }
    },
    { immediate: true }
  )

  onUnmounted(() => {
    stopWatching()
    if (detachPostRender) detachPostRender()
  })

  return {
    refreshSceneLabels: () => applySceneLabelStyles(viewer.value)
  }
}
