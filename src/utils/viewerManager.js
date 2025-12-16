import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

// Cesium Viewer实例管理
let viewer = null

/**
 * 初始化Cesium Viewer
 * @param {string} containerId - 容器ID
 * @returns {Promise<Cesium.Viewer>} Cesium Viewer实例
 */
export async function initViewer(containerId) {
    // Cesium配置
    window.CESIUM_BASE_URL = "/"
    Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyYjQwMDhkNy04NjljLTRkZGQtYTI4MS0yYTA4ZGQ4NTczYTEiLCJpZCI6MzE2NzQ2LCJpYXQiOjE3NTEyMDQ1MzV9.CZ2M4g2o2JGRE7OFtHVmXuJ_A-XMx59BgOqjqbIz9xQ"

    viewer = new Cesium.Viewer(containerId, {
        infoBox: false,
        timeline: false,
        animation: false,
        selectionIndicator: false,
        homeButton: false,
        sceneModePicker: false,
        baseLayerPicker: false,
        geocoder: false,
        navigationHelpButton: false,
        navigationInstructionsInitiallyVisible: false,
        fullscreenButton: false,
        terrainProvider: await Cesium.createWorldTerrainAsync({
            requestVertexNormals: true,
        })
    })

    viewer.cesiumWidget.creditContainer.style.display = 'none'

    return viewer
}

/**
 * 获取当前Viewer实例
 * @returns {Cesium.Viewer} Cesium Viewer实例
 */
export function getViewer() {
    return viewer
}

/**
 * 销毁Viewer
 */
export function destroyViewer() {
    if (viewer) {
        viewer.destroy()
        viewer = null
    }
}

/**
 * 重置视角到指定模型
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @returns {Promise<void>}
 */
export async function resetViewToModel(tileset) {
    if (viewer && tileset) {
        await viewer.zoomTo(tileset)
    }
}