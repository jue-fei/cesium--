import * as Cesium from 'cesium'
import { MODEL_DEFAULTS, HIGHLIGHT_CONFIG, ID_PREFIX } from '../../../config/constants/appConfig.js'

/**
 * @typedef {Object} ModelItem
 * @property {string} id - 唯一标识
 * @property {string} name - 显示名称
 * @property {boolean} visible - 可见状态
 * @property {number} opacity - 透明度（0-100）
 */

// 安全获取透明度值，避免 0 被 || 误判为 falsy
function safeOpacity(val) {
  return val != null ? Number(val) : MODEL_DEFAULTS.OPACITY
}

function toAlpha(val) {
  return 1 - safeOpacity(val) / MODEL_DEFAULTS.OPACITY
}

/**
 * 要素与模型管理器 - 封装所有模型和要素相关的逻辑
 * 包括：要素扫描、模型可见性控制、高亮、透明度调整等
 */
export class FeatureManager {
  /**
   * @param {Cesium.Cesium3DTileset|null} tileset - 三维瓦片集实例
   */
  constructor(tileset = null) {
    /**
     * @type {Cesium.Cesium3DTileset|null}
     */
    this.tileset = tileset
    /**
     * @type {Map<string, Cesium.Cesium3DTileFeature>}
     */
    this.featureMap = new Map()
    this.tileLoadListener = null
    this.listenerTileset = null
    /**
     * @type {Map<string, {opacity: number, visible: boolean}>}
     * 持久化样式状态，当新的 tile 加载时自动应用
     */
    this.styleState = new Map()
    /**
     * 当前全局透明度，用于新加载瓦片时恢复正确的透明度组合
     */
    this.currentGlobalOpacity = MODEL_DEFAULTS.OPACITY
  }

  detachTileLoadListener() {
    if (this.listenerTileset && this.tileLoadListener) {
      this.listenerTileset.tileLoad.removeEventListener(this.tileLoadListener)
    }
    this.tileLoadListener = null
    this.listenerTileset = null
  }

  /**
   * 设置 tileset
   * @param {Cesium.Cesium3DTileset} tileset
   */
  setTileset(tileset) {
    if (this.tileset !== tileset) {
      this.detachTileLoadListener()
    }
    this.tileset = tileset
  }

  /**
   * 重置状态
   */
  resetState() {
    this.featureMap.clear()
    this.styleState.clear()
    this.currentGlobalOpacity = MODEL_DEFAULTS.OPACITY
  }

  /**
   * 为 feature 应用已记录的样式状态
   * @param {Cesium.Cesium3DTileFeature} feature
   * @param {string} featureId
   */
  _applyStyleState(feature, featureId) {
    const state = this.styleState.get(featureId)
    if (!state || !feature) return

    try {
      const currentColor = feature.color || Cesium.Color.WHITE
      // 恢复时同时考虑模型透明度和全局透明度（两者都使用“透明度”语义）
      const opacityValue = state.visible
        ? toAlpha(state.opacity) * toAlpha(this.currentGlobalOpacity)
        : 0
      feature.color = new Cesium.Color(
        currentColor.red,
        currentColor.green,
        currentColor.blue,
        opacityValue
      )
    } catch (e) {
      // Ignore stale feature references while replaying cached style state.
    }
  }

  /**
   * 扫描并存储所有要素
   */
  scanAndStoreFeatures() {
    if (!this.tileset) {
      return
    }
    this.detachTileLoadListener()
    this.featureMap.clear()

    const processTile = tile => {
      if (tile.content && tile.content.featuresLength > 0) {
        for (let i = 0; i < tile.content.featuresLength; ++i) {
          const feature = tile.content.getFeature(i)
          const featureId = this.getFeatureId(feature)
          const isNew = !this.featureMap.has(featureId)
          this.featureMap.set(featureId, feature)
          // 为新加载的 feature 自动应用已记录的样式
          if (isNew || this.styleState.has(featureId)) {
            this._applyStyleState(feature, featureId)
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
    this.tileLoadListener = tile => processTile(tile)
    this.tileset.tileLoad.addEventListener(this.tileLoadListener)
    this.listenerTileset = this.tileset
  }

  /**
   * 销毁管理器，清理资源
   */
  destroy() {
    this.detachTileLoadListener()
    this.featureMap.clear()
    this.styleState.clear()
    this.tileset = null
  }

  /**
   * 获取要素ID
   * @param {Cesium.Cesium3DTileFeature} feature
   * @returns {string}
   */
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
          // @ts-ignore
          feature._id ||
          `${ID_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1000)}`
        )
      }
      // @ts-ignore
      return feature._id || `${ID_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1000)}`
    } catch (error) {
      return `${ID_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1000)}`
    }
  }

  /**
   * 切换模型可见性
   * @param {ModelItem} model
   * @returns {{success: boolean, message: string}}
   */
  toggleModelVisibility(model, globalOpacity = MODEL_DEFAULTS.OPACITY) {
    if (!this.tileset) return { success: false, message: 'Tileset not initialized' }

    try {
      this.currentGlobalOpacity = safeOpacity(globalOpacity)
      const featureId = model.featureId || model.id
      // 持久化可见性状态
      this.styleState.set(featureId, {
        opacity: safeOpacity(model.opacity),
        visible: !!model.visible
      })

      const feature = this.featureMap.get(featureId)
      if (feature) {
        const currentColor = feature.color || Cesium.Color.WHITE
        // 可见时：模型不透明度系数 × 全局不透明度系数；不可见时：完全透明
        const opacityValue = model.visible ? toAlpha(model.opacity) * toAlpha(globalOpacity) : 0
        feature.color = new Cesium.Color(
          currentColor.red,
          currentColor.green,
          currentColor.blue,
          opacityValue
        )
        return { success: true, message: `${model.visible ? '显示' : '隐藏'}了模型: ${model.name}` }
      } else {
        return {
          success: true,
          message: `${model.visible ? '显示' : '隐藏'}了模型: ${model.name} (待加载后生效)`
        }
      }
    } catch (error) {
      return { success: false, message: '切换显示状态失败' }
    }
  }

  /**
   * 高亮模型
   * @param {ModelItem} model
   */
  highlightModel(model) {
    if (!this.tileset) return

    try {
      const featureId = model.featureId || model.id
      const feature = this.featureMap.get(featureId)
      // 增加更严格的类型检查，防止渲染错误
      if (feature && feature.color && typeof feature.color.clone === 'function') {
        const opacityValue = toAlpha(model.opacity)

        // 保存原始颜色的深拷贝
        const originalColor = feature.color.clone()

        // 设置高亮颜色
        feature.color = HIGHLIGHT_CONFIG.COLOR.withAlpha(opacityValue)

        // 异步恢复原始颜色，使用闭包确保访问到正确的feature和颜色
        setTimeout(
          (f, origColor) => {
            try {
              if (f && f.color) {
                f.color = origColor
              }
            } catch (e) {
              console.error('恢复模型颜色失败:', e)
            }
          },
          HIGHLIGHT_CONFIG.DURATION,
          feature,
          originalColor
        )
      }
    } catch (error) {
      console.error('高亮模型失败:', error)
      // 确保不会因为高亮错误影响渲染
    }
  }

  /**
   * 更新模型透明度
   * @param {ModelItem} model
   * @param {number} globalOpacity - 0 到 100，0 表示不透明，100 表示完全透明
   * @returns {{success: boolean, message: string}}
   */
  updateModelOpacity(model, globalOpacity = MODEL_DEFAULTS.OPACITY) {
    this.currentGlobalOpacity = safeOpacity(globalOpacity)
    const featureId = model.featureId || model.id

    // 持久化透明度状态
    this.styleState.set(featureId, {
      opacity: safeOpacity(model.opacity),
      visible: !!model.visible
    })

    const feature = this.featureMap.get(featureId)
    if (feature) {
      // model.opacity / globalOpacity 范围 0~100，0=完全不透明，100=完全透明
      const modelAlpha = toAlpha(model.opacity)
      const globalAlpha = toAlpha(globalOpacity)
      // 最终 alpha = 模型不透明度系数 * 全局不透明度系数；若模型不可见则强制为0
      const finalOpacity = model.visible ? modelAlpha * globalAlpha : 0
      const currentColor = feature.color || Cesium.Color.WHITE
      feature.color = new Cesium.Color(
        currentColor.red,
        currentColor.green,
        currentColor.blue,
        finalOpacity
      )
      return { success: true, message: `更新了模型透明度: ${model.name}` }
    }
    return { success: true, message: `更新了模型透明度: ${model.name} (待加载后生效)` }
  }

  updateModelColor(model, hexColor = '#ffffff', globalOpacity = MODEL_DEFAULTS.OPACITY) {
    const featureId = model.featureId || model.id
    const feature = this.featureMap.get(featureId)
    if (!feature) return { success: false, message: `未找到模型: ${model.name}` }
    try {
      const col = Cesium.Color.fromCssColorString(hexColor || '#ffffff')
      const modelAlpha = toAlpha(model.opacity)
      const globalAlpha = toAlpha(globalOpacity)
      // 若模型不可见则强制透明，避免意外显示
      const finalOpacity = model.visible ? modelAlpha * globalAlpha : 0
      feature.color = new Cesium.Color(col.red, col.green, col.blue, finalOpacity)
      return { success: true, message: `更新了模型配色: ${model.name}` }
    } catch (e) {
      return { success: false, message: `设置颜色失败: ${model.name}` }
    }
  }

  /**
   * 重置所有透明度
   * @param {ModelItem[]} modelList
   * @param {number} globalOpacity
   * @returns {{success: boolean, successCount: number, failCount: number, message: string}}
   */
  resetAllOpacity(modelList, globalOpacity = 0) {
    try {
      let successCount = 0
      let failCount = 0
      modelList.forEach(model => {
        const result = this.updateModelOpacity(model, globalOpacity)
        if (result.success) {
          successCount++
        } else {
          failCount++
        }
      })
      return {
        success: failCount === 0,
        successCount,
        failCount,
        message:
          failCount === 0
            ? `成功重置 ${successCount} 个模型的透明度`
            : `部分模型ID不匹配: 成功 ${successCount}，失败 ${failCount}`
      }
    } catch (error) {
      console.error('重置所有模型透明度失败:', error)
      return { success: false, message: '重置透明度失败' }
    }
  }

  /**
   * 显示所有模型
   * @param {ModelItem[]} modelList
   */
  showAllModels(modelList, globalOpacity = MODEL_DEFAULTS.OPACITY) {
    modelList.forEach(m => {
      if (!m.visible) {
        m.visible = true
        this.toggleModelVisibility(m, globalOpacity)
      }
    })
  }

  /**
   * 隐藏所有模型
   * @param {ModelItem[]} modelList
   */
  hideAllModels(modelList) {
    modelList.forEach(m => {
      if (m.visible) {
        m.visible = false
        this.toggleModelVisibility(m)
      }
    })
  }

  /**
   * 获取 featureMap 的大小
   * @returns {number}
   */
  getFeatureCount() {
    return this.featureMap.size
  }

  /**
   * 获取所有要素ID
   * @returns {string[]}
   */
  getAllFeatureIds() {
    return Array.from(this.featureMap.keys())
  }
}
