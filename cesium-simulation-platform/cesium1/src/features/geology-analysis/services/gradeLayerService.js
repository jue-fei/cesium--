/**
 * gradeLayerService.js —— 矿石品位层渲染服务（Cesium Primitive）
 *
 * 数据：GET /api/geology/grade-blocks（当前为合成示例，data.source==='synthetic'，
 * 界面由 GradePanel 显著标注"仿真示例数据"；将来换真实勘探数据前端零发布）。
 * 渲染：单个 Cesium.Primitive 承载全部 BoxGeometry 实例（逐实例着色，
 * PerInstanceColorAppearance 半透明），一次 draw call；采区过滤通过重建实例实现。
 * 生命周期：跟随地质面板挂载 ensureLayer / setVisible；场景重建后重新 ensureLayer
 * （块段数据缓存在模块内，重建零请求）；resetLayer 供显式清理。
 */
import * as Cesium from 'cesium'
import { gradeColorHex } from './gradeScale.js'

/** 块段半透明度：热力着色不遮掩岩体细节（用户口径：半透明叠加） */
const BLOCK_ALPHA = 0.55

/** 仿真数据徽标文案（GradePanel 与 layer 共用单源） */
export const SYNTHETIC_BADGE_TEXT = '仿真示例数据'

let cachedData = null
let primitive = null
let boundViewer = null
let visible = true
let zoneFilter = null // null = 全部采区；否则 Set<zone>
let timelineReveal = null // null = 不限中段；否则 int（时间轴已显现的最大 levelIndex）

/**
 * 纯函数：时间轴进度 → 已显现的最大中段 index。
 * fracs 来自后端 meta.levelRevealFracs（单源）；frac <= progress 的最大 index。
 * 无 fracs 时返回 Number.MAX_SAFE_INTEGER（退化为全显）。
 */
export function computeRevealedLevel(progress, fracs) {
  if (!Array.isArray(fracs) || !fracs.length) return Number.MAX_SAFE_INTEGER
  if (progress >= 1) return fracs.length - 1
  let revealed = 0
  for (let i = 0; i < fracs.length; i++) {
    if (fracs[i] <= progress) revealed = i
  }
  return revealed
}

/** 时间轴进度（0~1）→ 中段显现过滤；null 取消过滤（全部显现）。 */
export function setTimelineProgress(progress) {
  if (progress == null) {
    if (timelineReveal == null) return
    timelineReveal = null
  } else {
    const fracs = cachedData?.meta?.levelRevealFracs
    const revealed = computeRevealedLevel(progress, fracs)
    if (revealed === timelineReveal) return
    timelineReveal = revealed
  }
  if (primitive && boundViewer) rebuildLayer(boundViewer)
}

/** 拉取（带模块级缓存）品位块段数据；失败返回 null 并记录 message。 */
export async function fetchGradeData() {
  if (cachedData) return cachedData
  try {
    const res = await fetch('/api/geology/grade-blocks')
    const json = await res.json()
    if (json?.code !== 0 || !json.data?.blocks) {
      throw new Error(json?.message || '品位块段数据响应为空')
    }
    cachedData = json.data
  } catch (e) {
    console.error('[GradeLayer] 拉取品位数据失败', e)
    return null
  }
  return cachedData
}

export function getGradeData() {
  return cachedData
}

export function getZoneFilter() {
  return zoneFilter
}

export function isVisible() {
  return visible
}

function filteredBlocks() {
  if (!cachedData) return []
  const blocks = cachedData.blocks || []
  return blocks.filter(b => {
    if (zoneFilter && !zoneFilter.has(b.zone)) return false
    if (timelineReveal != null && (b.levelIndex ?? 0) > timelineReveal) return false
    return true
  })
}

function buildInstances(blocks) {
  const levels = cachedData.gradeLevels || []
  const instances = []
  for (const b of blocks) {
    const color = Cesium.Color.fromCssColorString(gradeColorHex(b.gradePct, levels)).withAlpha(
      BLOCK_ALPHA
    )
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.height)
    )
    instances.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.BoxGeometry({
          dimensions: new Cesium.Cartesian3(b.sizeM[0], b.sizeM[1], b.sizeM[2]),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
        }),
        modelMatrix,
        id: `grade-block-${b.id}`,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color)
        }
      })
    )
  }
  return instances
}

function removePrimitive() {
  if (primitive && boundViewer?.scene?.primitives) {
    boundViewer.scene.primitives.remove(primitive)
  }
  primitive = null
}

/** 重建图元（数据/过滤变化时调用）。 */
export function rebuildLayer(viewer) {
  if (!viewer?.scene?.primitives || !cachedData) return false
  boundViewer = viewer
  removePrimitive()
  const instances = buildInstances(filteredBlocks())
  if (!instances.length) return false
  primitive = new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ closed: true, translucent: true }),
    asynchronous: true
  })
  primitive.show = visible
  viewer.scene.primitives.add(primitive)
  return true
}

/**
 * 确保图层已挂到当前 viewer（面板 onMounted / 场景重建后调用）。
 * @returns {Promise<boolean>} 是否成功渲染
 */
export async function ensureLayer(viewer) {
  if (!viewer) return false
  if (!cachedData) await fetchGradeData()
  if (!cachedData) return false
  if (primitive && boundViewer === viewer) {
    primitive.show = visible
    return true
  }
  return rebuildLayer(viewer)
}

/** 显隐切换（面板开关）。 */
export function setVisible(v) {
  visible = !!v
  if (primitive) primitive.show = visible
}

/** 采区过滤（null = 全部）。 */
export function setZoneFilter(zones) {
  zoneFilter = zones && zones.length ? new Set(zones) : null
  if (primitive && boundViewer) rebuildLayer(boundViewer)
}

/** 清理图元（保留数据缓存，场景重建时零请求重建）。 */
export function resetLayer() {
  removePrimitive()
  boundViewer = null
}
