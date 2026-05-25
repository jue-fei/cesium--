import * as Cesium from 'cesium'

function toCartesian(position) {
  return Cesium.Cartesian3.fromDegrees(
    Number(position?.lon || 0),
    Number(position?.lat || 0),
    Number(position?.height || 0)
  )
}

export class BlastingManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for BlastingManager')
    this.viewer = viewer
    this.dataset = null
    this.currentFrame = 0
    this.centerEntity = null
    this.waveEntities = []
    this.fragmentEntities = []
    this.landingEntities = []
    this.designEntities = []
    this.holeEntities = []
  }

  clearScene() {
    if (this.centerEntity) this.viewer.entities.remove(this.centerEntity)
    this.waveEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.fragmentEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.landingEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.designEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.holeEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.centerEntity = null
    this.waveEntities = []
    this.fragmentEntities = []
    this.landingEntities = []
    this.designEntities = []
    this.holeEntities = []
    this.dataset = null
    this.currentFrame = 0
  }

  setDataset(dataset) {
    this.clearScene()
    this.dataset = dataset
    this.currentFrame = 0
    this.buildEntities()
  }

  setFrame(frameIndex) {
    if (!this.dataset) return
    const max = Math.max(0, this.dataset.frames.length - 1)
    this.currentFrame = Math.max(0, Math.min(max, Number(frameIndex) || 0))
  }

  buildEntities() {
    if (!this.dataset) return
    const center = this.dataset.event.center
    const visual = this.dataset?.visual || {}
    const waveRings = Number(visual.waveRings || 2)
    const centerCartesian = toCartesian(center)

    this.centerEntity = this.viewer.entities.add({
      position: centerCartesian,
      point: {
        pixelSize: 10,
        color: Cesium.Color.ORANGE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
      },
      label: {
        text: this.dataset.event.name,
        font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        pixelOffset: new Cesium.Cartesian2(0, -24)
      }
    })

    for (let ring = 0; ring < waveRings; ring++) {
      const ringOffset = ring * 0.18
      const ringScale = 1 + ring * 0.25
      const waveRadiusProperty = new Cesium.CallbackProperty(() => {
        if (!this.dataset) return 1
        const base = Number(this.dataset.frames[this.currentFrame]?.waveRadius ?? 1)
        return base * ringScale + base * ringOffset
      }, false)
      const waveEntity = this.viewer.entities.add({
        position: centerCartesian,
        ellipse: {
          semiMajorAxis: waveRadiusProperty,
          semiMinorAxis: waveRadiusProperty,
          height: center.height + ring * 0.03,
          material: Cesium.Color.ORANGE.withAlpha(Math.max(0.08, 0.26 - ring * 0.08)),
          outline: true,
          outlineColor: Cesium.Color.ORANGE.withAlpha(Math.max(0.25, 0.68 - ring * 0.18))
        }
      })
      this.waveEntities.push(waveEntity)
    }
    this.buildDesignEntities()

    const trackMap = new Map()
    this.dataset.frames.forEach(frame => {
      frame.fragments.forEach(fragment => {
        if (!trackMap.has(fragment.id)) trackMap.set(fragment.id, [])
        trackMap.get(fragment.id).push({
          position: toCartesian(fragment.position),
          size: fragment.size
        })
      })
    })

    const renderMode = String(visual.fragmentRenderMode || 'point')
    const fragmentModelUri = String(visual.fragmentModelUri || '')
    const maxModelFragments = Number(visual.maxModelFragments || 48)
    const trailWidth = Number(visual.trailWidth || 2.5)
    let fragmentIndex = 0
    trackMap.forEach((track, fragmentId) => {
      const positionProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        return track[Math.max(0, idx)]?.position
      }, false)

      const sizeProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        return Math.max(4, Number(track[Math.max(0, idx)]?.size || 0.5) * 6)
      }, false)

      const scaleProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        return Math.max(0.4, Number(track[Math.max(0, idx)]?.size || 0.5) * 1.5)
      }, false)

      const pathProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame + 1, track.length)
        return track.slice(0, Math.max(1, idx)).map(item => item.position)
      }, false)

      const visualPayload = {}
      if (renderMode === 'model' && fragmentModelUri && fragmentIndex < maxModelFragments) {
        visualPayload.model = {
          uri: fragmentModelUri,
          scale: scaleProperty,
          minimumPixelSize: Number(visual.fragmentMinPixelSize || 24),
          maximumScale: Number(visual.fragmentMaxScale || 18),
          color: Cesium.Color.WHITE.withAlpha(0.96)
        }
      } else {
        visualPayload.point = {
          pixelSize: sizeProperty,
          color: Cesium.Color.YELLOW.withAlpha(0.92),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
          outlineWidth: 1
        }
      }

      const fragmentEntity = this.viewer.entities.add({
        id: `blasting-fragment-${fragmentId}`,
        position: positionProperty,
        ...visualPayload,
        polyline: {
          positions: pathProperty,
          width: Math.max(1, trailWidth),
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.22,
            color: Cesium.Color.YELLOW.withAlpha(0.55)
          })
        }
      })

      this.fragmentEntities.push(fragmentEntity)
      fragmentIndex += 1
      const landingPosition = track[track.length - 1]?.position
      if (landingPosition) {
        const showLanding = new Cesium.CallbackProperty(() => {
          return this.currentFrame >= track.length - 1
        }, false)
        const landingEntity = this.viewer.entities.add({
          position: landingPosition,
          show: showLanding,
          point: {
            pixelSize: 5,
            color: Cesium.Color.RED.withAlpha(0.85),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.75),
            outlineWidth: 1
          }
        })
        this.landingEntities.push(landingEntity)
      }
    })
  }

  buildDesignEntities() {
    const design = this.dataset?.design
    if (!design) return

    const buildFace = (face, color, label) => {
      if (!face?.center) return
      const facePosition = toCartesian(face.center)
      const headingRad = Cesium.Math.toRadians(Number(face.headingDeg || 0))
      const orientation = Cesium.Transforms.headingPitchRollQuaternion(
        facePosition,
        new Cesium.HeadingPitchRoll(headingRad, 0, 0)
      )
      const faceEntity = this.viewer.entities.add({
        position: facePosition,
        orientation,
        box: {
          dimensions: new Cesium.Cartesian3(
            Number(face.width || 1),
            Number(face.thickness || 0.2),
            Number(face.height || 1)
          ),
          material: color.withAlpha(0.25),
          outline: true,
          outlineColor: color.withAlpha(0.9)
        },
        label: {
          text: label,
          font: '12px sans-serif',
          fillColor: color,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
          pixelOffset: new Cesium.Cartesian2(0, -22)
        }
      })
      this.designEntities.push(faceEntity)
    }

    buildFace(design.faceBefore, Cesium.Color.CYAN, '掌子面-爆前')
    buildFace(design.faceAfter, Cesium.Color.LIME, '掌子面-爆后')

    const holes = Array.isArray(design.holes) ? design.holes : []
    holes.forEach(hole => {
      if (!hole?.collar || !hole?.toe) return
      const collar = toCartesian(hole.collar)
      const toe = toCartesian(hole.toe)
      const width = Math.max(1, Number(hole?.diameter || 0.08) * 30)
      const holeEntity = this.viewer.entities.add({
        position: collar,
        polyline: {
          positions: [collar, toe],
          width,
          material: Cesium.Color.DODGERBLUE.withAlpha(0.8)
        },
        label: {
          text: `${hole.id}  ${Number(hole.delayMs || 0)}ms`,
          font: '11px monospace',
          fillColor: Cesium.Color.AZURE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.35),
          pixelOffset: new Cesium.Cartesian2(0, -12)
        }
      })
      this.holeEntities.push(holeEntity)
    })
  }
}
