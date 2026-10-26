/**
 * schedulingCesium.js —— 现场调度 Cesium 总览层
 *
 * 在主三维场景(Cesium)叠加：
 *   1) 巷道实体图层：/3d/ashele/tunnel_solid/tileset.json（半透明，可开关）
 *   2) 铲运机实体：按调度仿真快照(segId+segProgress)沿真实巷道折线放置，
 *      与 TunnelMap3D 调度视图共用同一份快照与同一份 v2 场景几何 → 双视图天然同步
 *
 * 坐标：mine 局部系(x 东, y 北, z=海拔) → ECEF，与 integrate_platform.py 的
 * ENU 变换完全一致（锚点/经纬度/高度同源）。
 */
import * as Cesium from 'cesium'
import { useViewerStore } from '@/stores/viewerStore.js'

const TUNNEL_TILESET_URL = '/3d/ashele/tunnel_solid/tileset.json'
const MINE_ANCHOR = [-764.0270080566406, 1186.8692016601562, 899.3218994140625]
const LON = 86.339444
const LAT = 48.290278
const HEIGHT = 1000.0

let tunnelTileset = null
let tunnelVisible = true
const lhdEntities = new Map() // eqId → { entity, glbUrl }
let mineMatrix = null

/** mine→ECEF 4x4（Cesium Matrix4，列主序），与后端聚合 tileset 同一变换。 */
function getMineMatrix() {
  if (mineMatrix) return mineMatrix
  const lon = Cesium.Math.toRadians(LON)
  const lat = Cesium.Math.toRadians(LAT)
  const a = 6378137.0
  const e2 = 0.00669437999014
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const p = new Cesium.Cartesian3(
    (N + HEIGHT) * Math.cos(lat) * Math.cos(lon),
    (N + HEIGHT) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - e2) + HEIGHT) * Math.sin(lat)
  )
  const east = new Cesium.Cartesian3(-Math.sin(lon), Math.cos(lon), 0)
  const north = new Cesium.Cartesian3(
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat)
  )
  const up = new Cesium.Cartesian3(
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat)
  )
  // t = p - R*ANCHOR
  const t = new Cesium.Cartesian3(
    p.x - (east.x * MINE_ANCHOR[0] + north.x * MINE_ANCHOR[1] + up.x * MINE_ANCHOR[2]),
    p.y - (east.y * MINE_ANCHOR[0] + north.y * MINE_ANCHOR[1] + up.y * MINE_ANCHOR[2]),
    p.z - (east.z * MINE_ANCHOR[0] + north.z * MINE_ANCHOR[1] + up.z * MINE_ANCHOR[2])
  )
  mineMatrix = new Cesium.Matrix4(
    east.x, north.x, up.x, t.x,
    east.y, north.y, up.y, t.y,
    east.z, north.z, up.z, t.z,
    0, 0, 0, 1
  )
  return mineMatrix
}

/** mine 系坐标 → ECEF Cartesian3。 */
export function mineToCartesian(x, y, z) {
  return Cesium.Matrix4.multiplyByPoint(
    getMineMatrix(),
    new Cesium.Cartesian3(x, y, z),
    new Cesium.Cartesian3()
  )
}

/** 主 viewer（可能尚未就绪，轮询至存在为止）。 */
export function getViewerWhenReady(timeoutMs = 15000) {
  return new Promise(resolve => {
    const t0 = Date.now()
    const tryGet = () => {
      let v = null
      try {
        const store = useViewerStore()
        const raw = store.viewer
        v = raw && !raw.isDestroyed?.() ? raw : null
      } catch (e) {
        v = null
      }
      if (v) return resolve(v)
      if (Date.now() - t0 > timeoutMs) return resolve(null)
      setTimeout(tryGet, 500)
    }
    tryGet()
  })
}

/** 确保巷道实体图层加载（幂等）。返回 tileset 或 null。 */
export async function ensureTunnelLayer() {
  const viewer = await getViewerWhenReady()
  if (!viewer) return null
  if (tunnelTileset && viewer.scene.primitives.contains(tunnelTileset)) {
    tunnelTileset.show = tunnelVisible
    return tunnelTileset
  }
  if (tunnelTileset && !viewer.scene.primitives.contains(tunnelTileset)) {
    // viewer 被销毁重建过
    tunnelTileset = null
  }
  try {
    const ts = await Cesium.Cesium3DTileset.fromUrl(TUNNEL_TILESET_URL, {
      maximumScreenSpaceError: 24,
      show: tunnelVisible
    })
    ts.style = new Cesium.Cesium3DTileStyle({
      color: 'rgba(148, 158, 172, 0.42)'
    })
    viewer.scene.primitives.add(ts)
    tunnelTileset = ts
    // 不做相机飞行与地下查看联动：平台默认即为地下模式，视角保持用户当前状态
    // E2E 诊断句柄
    if (typeof window !== 'undefined') {
      window.__schedCesium = {
        get tileset() {
          return tunnelTileset
        },
        get entities() {
          return [...lhdEntities.keys()]
        },
        mineToCartesian,
        Cesium,
        describe() {
          if (!tunnelTileset) return null
          const bs = tunnelTileset.boundingSphere
          const cart = Cesium.Cartographic.fromCartesian(bs.center)
          return {
            show: tunnelTileset.show,
            lon: +Cesium.Math.toDegrees(cart.longitude).toFixed(5),
            lat: +Cesium.Math.toDegrees(cart.latitude).toFixed(5),
            height: +cart.height.toFixed(1),
            radius: +bs.radius.toFixed(1),
            tilesLoaded: tunnelTileset.tilesLoaded
          }
        }
      }
    }
    return ts
  } catch (e) {
    console.warn(
      '[schedCesium] 巷道实体图层加载失败:',
      e && e.message,
      '\n',
      e && e.stack ? String(e.stack).slice(0, 500) : e
    )
    return null
  }
}

/** 巷道实体图层开关。仅控制图层显隐，不联动相机与地下查看。 */
export function setTunnelLayerVisible(v) {
  tunnelVisible = !!v
  if (tunnelTileset) {
    tunnelTileset.show = tunnelVisible
  }
}

/** 折线上按弧长比例取点与切线（polyline: [[x,y,z],...] mine 系）。 */
function pointAtFraction(poly, t) {
  const segLens = []
  let total = 0
  for (let i = 1; i < poly.length; i++) {
    const dx = poly[i][0] - poly[i - 1][0]
    const dy = poly[i][1] - poly[i - 1][1]
    const dz = poly[i][2] - poly[i - 1][2]
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    segLens.push(L)
    total += L
  }
  let d = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < segLens.length; i++) {
    if (d <= segLens[i] || i === segLens.length - 1) {
      const f = segLens[i] > 0 ? d / segLens[i] : 0
      const p = [
        poly[i][0] + (poly[i + 1][0] - poly[i][0]) * f,
        poly[i][1] + (poly[i + 1][1] - poly[i][1]) * f,
        poly[i][2] + (poly[i + 1][2] - poly[i][2]) * f
      ]
      const dirLen = segLens[i] || 1
      const dir = [
        (poly[i + 1][0] - poly[i][0]) / dirLen,
        (poly[i + 1][1] - poly[i][1]) / dirLen,
        (poly[i + 1][2] - poly[i][2]) / dirLen
      ]
      return { p, dir }
    }
    d -= segLens[i]
  }
  return { p: poly[poly.length - 1], dir: [1, 0, 0] }
}

/**
 * 绑定实时快照流：内部维护 viewer 引用，snapshot 每帧更新实体位置。
 * 在调度面板 onMounted 调用一次；返回解除函数。
 */
export function bindLhdStream(getSnapshot, getSegPolylines, getEquipGlb) {
  let viewerRef = null
  let stopped = false
  let raf = 0

  getViewerWhenReady().then(v => {
    if (stopped) return
    viewerRef = v
    if (viewerRef) tick()
  })

  function ensureEntity(eq, segPolylines) {
    if (!viewerRef) return null
    let rec = lhdEntities.get(eq.id)
    const glbUrl = getEquipGlb?.(eq.id) || ''
    if (!rec) {
      const entity = viewerRef.entities.add({
        name: eq.id,
        label: {
          text: eq.id,
          font: '12px sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#ffd93d'),
          outlineColor: Cesium.Color.fromCssColorString('#000000'),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -26),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4000),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        model: glbUrl
          ? { uri: glbUrl, minimumPixelSize: 0, scale: 1 }
          : undefined,
        point: glbUrl
          ? undefined
          : { pixelSize: 10, color: Cesium.Color.YELLOW, disableDepthTestDistance: Number.POSITIVE_INFINITY }
      })
      rec = { entity, glbUrl }
      lhdEntities.set(eq.id, rec)
    } else if (glbUrl && rec.glbUrl !== glbUrl) {
      rec.entity.model = { uri: glbUrl, minimumPixelSize: 0, scale: 1 }
      rec.glbUrl = glbUrl
    }
    return rec
  }

  function tick() {
    if (stopped) return
    raf = 0
    const snap = getSnapshot?.()
    const segPolylines = getSegPolylines?.() || {}
    if (!viewerRef || !snap) {
      // 快照/视图未就绪：继续下一帧重试（否则循环死掉，实体永远不出现）
      raf = requestAnimationFrame(tick)
      return
    }
    const items = snap.factors?.equipment?.items || []
    const seen = new Set()
    for (const eq of items) {
      const poly = eq.segId ? segPolylines[eq.segId] : null
      let p = null
      let dir = null
      if (poly && poly.length >= 2) {
        const r = pointAtFraction(poly, eq.segProgress || 0)
        p = r.p
        dir = r.dir
      } else if (eq.node && segPolylines.__nodePos3?.[eq.node]) {
        p = segPolylines.__nodePos3[eq.node]
        dir = [1, 0, 0]
      }
      if (!p) continue
      seen.add(eq.id)
      const rec = ensureEntity(eq, segPolylines)
      if (!rec) continue
      const pos = mineToCartesian(p[0], p[1], p[2])
      rec.entity.position = pos
      if (dir) {
        // glTF 模型在 Cesium 中 Y-up→Z-up 自动校正；车长沿 mine 系 dir：
        // heading 自北顺时针 = atan2(east, north) = atan2(dx, dy)
        const heading = Math.atan2(dir[0], dir[1])
        const pitch = -Math.asin(Math.max(-1, Math.min(1, dir[2] || 0)))
        const hpr = new Cesium.HeadingPitchRoll(heading, pitch, 0)
        rec.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(pos, hpr)
      }
      rec.entity.label.text = `${eq.id} · ${eq.state || ''}`
    }
    // 移除已消失设备
    for (const [id, rec] of lhdEntities) {
      if (!seen.has(id)) {
        viewerRef.entities.remove(rec.entity)
        lhdEntities.delete(id)
      }
    }
    if (!raf) raf = requestAnimationFrame(tick)
  }

  return function unbind() {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    if (viewerRef) {
      for (const [, rec] of lhdEntities) viewerRef.entities.remove(rec.entity)
      lhdEntities.clear()
    }
  }
}
