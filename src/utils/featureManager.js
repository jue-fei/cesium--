import * as Cesium from 'cesium'

/**
 * 要素与模型管理器 - 封装所有模型和要素相关的逻辑
 * 包括：要素扫描、模型可见性控制、高亮、透明度调整等
 */
export class FeatureManager {
    constructor(tileset = null) {
        this.tileset = tileset
        this.featureMap = new Map()
        this.modelList = []
        this.selectedModel = null
    }

    // 设置 tileset
    setTileset(tileset) {
        this.tileset = tileset
    }

    // 重置状态
    resetState() {
        this.featureMap.clear()
        this.selectedModel = null
    }

    // 扫描并存储所有要素
    scanAndStoreFeatures() {
        if (!this.tileset) {
            console.debug('No tileset available for feature scanning')
            return
        }
        console.debug('Scanning and storing features from tileset...')
        this.featureMap.clear()

        const processTile = (tile) => {
            if (tile.content && tile.content.featuresLength > 0) {
                for (let i = 0; i < tile.content.featuresLength; ++i) {
                    const feature = tile.content.getFeature(i)
                    const featureId = this.getFeatureId(feature)
                    if (!this.featureMap.has(featureId)) {
                        this.featureMap.set(featureId, feature)
                    }
                }
            }
            if (tile.children) {
                for (let j = 0; j < tile.children.length; ++j) {
                    processTile(tile.children[j])
                }
            }
        }

        if (this.tileset.root) processTile(this.tileset.root)
        this.tileset.tileLoad.addEventListener((tile) => processTile(tile))
        console.debug(`Feature scan completed. Found ${this.featureMap.size} unique features.`)
    }

    // 获取要素ID
    getFeatureId(feature) {
        try {
            if (typeof feature.getProperty === 'function') {
                return (
                    feature.getProperty('id') ||
                    feature.getProperty('ID') ||
                    feature.getProperty('name') ||
                    feature.getProperty('Name') ||
                    feature.getProperty('GUID') ||
                    feature.getProperty('guid') ||
                    feature.getProperty('description') ||
                    feature._id ||
                    `feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`
                )
            }
            return feature._id || `feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`
        } catch (error) {
            console.warn('获取要素ID失败:', error)
            return `feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`
        }
    }

    // 切换模型可见性
    toggleModelVisibility(model) {
        if (!this.tileset) return

        try {
            const feature = this.featureMap.get(model.id)
            if (feature && feature.color !== undefined) {
                // 使用透明度模拟可见性
                const currentColor = feature.color || Cesium.Color.WHITE
                // 当可见时，使用当前透明度设置；当不可见时，设置为0（完全透明）
                const opacityValue = model.visible ? (1 - model.opacity / 100) : 0
                feature.color = new Cesium.Color(
                    currentColor.red,
                    currentColor.green,
                    currentColor.blue,
                    opacityValue
                )
                return { success: true, message: `${model.visible ? '显示' : '隐藏'}了模型: ${model.name}` }
            } else {
                console.debug(`无法找到模型要素或要素没有color属性，ID: ${model.id}, 名称: ${model.name}`)
                return { success: false, message: `无法操作模型: ${model.name} (ID不匹配)` }
            }
        } catch (error) {
            console.error('切换模型可见性失败:', error)
            return { success: false, message: '切换显示状态失败' }
        }
    }

    // 高亮模型
    highlightModel(model) {
        if (!this.tileset) return

        try {
            const feature = this.featureMap.get(model.id)
            if (feature && feature.color !== undefined) {
                const originalColor = feature.color.clone()
                const opacityValue = 1 - model.opacity / 100
                feature.color = Cesium.Color.YELLOW.withAlpha(opacityValue)
                setTimeout(() => {
                    if (feature && feature.color !== undefined) {
                        feature.color = originalColor
                    }
                }, 3000)
            }
        } catch (error) {
            console.error('高亮模型失败:', error)
        }
    }

    // 更新模型透明度
    updateModelOpacity(model, globalOpacity = 0) {
        const feature = this.featureMap.get(model.id)
        if (feature && feature.color !== undefined) {
            // 计算透明度，注意：1表示完全不透明，0表示完全透明
            const modelOpacityValue = model.opacity / 100
            const globalOpacityValue = globalOpacity / 100
            // 最终透明度 = 模型透明度 * 全局透明度（当两者都为100时，最终透明度为1）
            const finalOpacity = (1 - modelOpacityValue) * (1 - globalOpacityValue)
            const currentColor = feature.color || Cesium.Color.WHITE
            feature.color = new Cesium.Color(
                currentColor.red,
                currentColor.green,
                currentColor.blue,
                finalOpacity
            )
            return { success: true, message: `更新了模型透明度: ${model.name}` }
        }
        return { success: false, message: `无法更新模型透明度: ${model.name} (ID不匹配)` }
    }

    // 重置所有透明度
    resetAllOpacity(modelList, globalOpacity = 0) {
        try {
            let successCount = 0
            let failCount = 0
            modelList.forEach((model) => {
                if (model.visible) {
                    const result = this.updateModelOpacity(model, globalOpacity)
                    if (result.success) {
                        successCount++
                    } else {
                        failCount++
                    }
                }
            })
            return {
                success: failCount === 0,
                successCount,
                failCount,
                message: failCount === 0 ? `成功重置 ${successCount} 个模型的透明度` : `部分模型ID不匹配: 成功 ${successCount}，失败 ${failCount}`
            }
        } catch (error) {
            console.error('重置所有模型透明度失败:', error)
            return { success: false, message: '重置透明度失败' }
        }
    }

    // 显示所有模型
    showAllModels(modelList) {
        modelList.forEach((m) => {
            if (!m.visible) {
                m.visible = true
                this.toggleModelVisibility(m)
            }
        })
    }

    // 隐藏所有模型
    hideAllModels(modelList) {
        modelList.forEach((m) => {
            if (m.visible) {
                m.visible = false
                this.toggleModelVisibility(m)
            }
        })
    }

    // 获取 featureMap 的大小
    getFeatureCount() {
        return this.featureMap.size
    }

    // 获取所有要素ID
    getAllFeatureIds() {
        return Array.from(this.featureMap.keys())
    }
}
