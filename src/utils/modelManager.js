import * as Cesium from 'cesium'
import { getViewer, resetViewToModel } from './viewerManager.js'
import { applyModelTransform } from './modelTransform.js'

// 模型相关状态
let tileset = null
let originalModelMatrix = null

// 默认初始位置和变换
const DEFAULT_POSITION = {
    longitude: 113.323,
    latitude: 23.106,
    height: 50
}

const DEFAULT_TRANSFORM = {
    rotationX: 15,
    rotationY: 0,
    rotationZ: 0
}

/**
 * 加载3D模型
 * @param {Array<string>} modelPaths - 模型路径数组
 * @returns {Promise<Object>} 加载状态对象
 */
export async function load3DModel(modelPaths) {
    const viewer = getViewer()
    if (!viewer) {
        return {
            type: 'error',
            message: 'Cesium Viewer未初始化'
        }
    }

    // 清理旧模型
    if (tileset && viewer.scene.primitives.contains(tileset)) {
        console.log('清理旧模型')
        viewer.scene.primitives.remove(tileset)
        tileset = null
        originalModelMatrix = null
    }

    // 默认模型路径
    const possiblePaths = modelPaths || ['./3d/demo4/tileset.json']

    for (const path of possiblePaths) {
        try {
            console.log(`尝试加载模型路径: ${path}`)

            // 检查文件是否存在
            const response = await fetch(path)
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }

            // 加载模型
            tileset = await Cesium.Cesium3DTileset.fromUrl(path)
            viewer.scene.primitives.add(tileset)

            await tileset.readyPromise

            // 保存原始模型矩阵
            originalModelMatrix = Cesium.Matrix4.clone(tileset.modelMatrix)

            // 应用初始变换
            applyModelTransform(tileset, originalModelMatrix, DEFAULT_POSITION, DEFAULT_TRANSFORM)

            // 设置初始视角为模型
            await resetViewToModel(tileset)

            console.log('3D模型加载成功:', path)

            return {
                type: 'success',
                message: '矿山模型已成功加载',
                position: DEFAULT_POSITION,
                transform: DEFAULT_TRANSFORM
            }

        } catch (error) {
            console.log(`路径 ${path} 加载失败:`, error.message)
            continue
        }
    }

    // 所有路径都失败
    return {
        type: 'warning',
        message: '3D模型加载失败'
    }
}

/**
 * 更新模型位置
 * @param {Object} newPosition - 新位置对象
 * @returns {boolean} 是否成功
 */
export function updateModelPosition(newPosition) {
    if (!tileset || !originalModelMatrix) {
        console.error('模型未加载或原始矩阵不存在')
        return false
    }

    // 应用新位置
    applyModelTransform(tileset, originalModelMatrix, newPosition, {
        rotationX: 15,
        rotationY: 0,
        rotationZ: 0
    })

    return true
}

/**
 * 更新模型变换
 * @param {Object} newTransform - 新变换对象
 * @param {Object} currentPosition - 当前位置对象
 * @returns {boolean} 是否成功
 */
export function updateModelTransform(newTransform, currentPosition) {
    if (!tileset || !originalModelMatrix) {
        console.error('模型未加载或原始矩阵不存在')
        return false
    }

    // 应用新变换
    applyModelTransform(tileset, originalModelMatrix, currentPosition, newTransform)

    return true
}

/**
 * 重置模型到初始状态
 * @returns {Object} 重置后的位置和变换
 */
export function resetModel() {
    if (!tileset || !originalModelMatrix) {
        console.error('模型未加载或原始矩阵不存在')
        return null
    }

    // 应用默认位置和变换
    applyModelTransform(tileset, originalModelMatrix, DEFAULT_POSITION, DEFAULT_TRANSFORM)

    return {
        position: DEFAULT_POSITION,
        transform: DEFAULT_TRANSFORM
    }
}

/**
 * 获取当前模型实例
 * @returns {Cesium.Cesium3DTileset} 模型实例
 */
export function getModelInstance() {
    return tileset
}

/**
 * 获取当前原始模型矩阵
 * @returns {Cesium.Matrix4} 原始模型矩阵
 */
export function getOriginalModelMatrix() {
    return originalModelMatrix
}