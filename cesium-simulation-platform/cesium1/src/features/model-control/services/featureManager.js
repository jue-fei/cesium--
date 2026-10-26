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
    /**
     * 点击闪烁动画注册表：featureId → { timer, feature, original }
     * 防止连点叠加重叠动画导致颜色恢复错乱
     */
    this._flashTimers = new Map()
    /**
     * 当前"选中持续高亮"的 featureId（选中模型在面板中保持高亮）
     */
    this._selectedHighlightId = null
    /**
     * 测量模式锁定：为 true 期间（距离/面积测量激活），所有点击选中/高亮/透明响应被禁用
     */
    this.highlightLocked = false
  }

  /**
   * 设置测量模式锁定。锁定时点击模型不产生任何选中/高亮/透明响应
   * @param {boolean} locked
   */
  setHighlightLocked(locked) {
    this.highlightLocked = !!locked
    if (locked) {
      // 进入测量的一瞬间，清除既有选中高亮（仅清高亮，不影响可见性/透明度设置）
      this.clearSelectedHighlight()
    }
  }

  /**
   * 设置选中持续高亮：被选中的组件保持高亮色，直到选中其它组件。
   * 与可见性/透明度/全局透明度自动叠加，瓦片重载后由样式重放自动恢复。
   * @param {string} featureId
   */
  setSelectedHighlight(featureId) {
    if (!featureId || featureId === this._selectedHighlightId) return
    this.clearSelectedHighlight()
    this._selectedHighlightId = featureId
    this._applyHighlightIfPresent(featureId)
  }

  /**
   * 清除选中持续高亮（恢复该组件常规颜色与透明度）
   * @param {string} [featureId] 传入时仅当匹配才清除
   */
  clearSelectedHighlight(featureId) {
    if (featureId && this._selectedHighlightId !== featureId) return
    const prev = this._selectedHighlightId
    this._selectedHighlightId = null
    if (!prev) return
    const feature = this.featureMap.get(prev)
    if (!feature) return
    try {
      const state = this.styleState.get(prev)
      // 恢复为常规白色底色 × 语义透明度（常规路径的 RGB 恒为白）
      const opacityValue =
        state && state.visible
          ? toAlpha(state.opacity) * toAlpha(this.currentGlobalOpacity)
          : toAlpha(this.currentGlobalOpacity)
      feature.color = new Cesium.Color(1, 1, 1, opacityValue)
      try {
        feature.show = opacityValue > 0.001
      } catch (_) {
        /* stale 引用 */
      }
    } catch (_) {
      /* stale 引用 */
    }
  }

  _applyHighlightIfPresent(featureId) {
    const feature = this.featureMap.get(featureId)
    if (!feature) return // 尚未加载：瓦片加载重放样式时会自动补上高亮
    try {
      feature.color = this._highlightColorFor(featureId)
      try {
        feature.show = true
      } catch (_) {
        /* stale */
      }
    } catch (_) {
      /* stale 引用 */
    }
  }

  /** 选中高亮色（高亮色 × 固定半透明系数 × 组件可见性/透明度语义） */
  _highlightColorFor(featureId) {
    const state = this.styleState.get(featureId)
    const alpha =
      state && state.visible
        ? toAlpha(state.opacity) * toAlpha(this.currentGlobalOpacity)
        : toAlpha(this.currentGlobalOpacity)
    return HIGHLIGHT_CONFIG.COLOR.withAlpha(alpha * (HIGHLIGHT_CONFIG.ALPHA ?? 1))
  }

  /**
   * 点击反馈：对拾取到的 feature 做短暂闪烁高亮（约 0.9s，3 次明暗）。
   * 直接操作 feature.color，对实体与线图元均有效。
   * @param {Cesium.Cesium3DTileFeature} feature
   */
  flashFeature(feature) {
    if (!feature || !feature.color || typeof feature.color.clone !== 'function') return
    let fid = null
    try {
      fid = typeof this.getFeatureId === 'function' ? this.getFeatureId(feature) : null
    } catch (_) {
      fid = null
    }
    // 连点保护：先终止同 feature 上未完成的闪烁并还原
    if (fid && this._flashTimers.has(fid)) {
      const prev = this._flashTimers.get(fid)
      clearInterval(prev.timer)
      try {
        if (prev.feature && prev.feature.color) prev.feature.color = prev.original
      } catch (_) {
        /* stale 引用，忽略 */
      }
      this._flashTimers.delete(fid)
    }
    try {
      const original = feature.color.clone()
      const highlight = HIGHLIGHT_CONFIG.COLOR.withAlpha(original.alpha)
      let tick = 0
      const total = 6 // 3 次明暗
      const timer = setInterval(() => {
        try {
          if (!feature.color) {
            clearInterval(timer)
            if (fid) this._flashTimers.delete(fid)
            return
          }
          if (tick >= total) {
            feature.color = original
            clearInterval(timer)
            if (fid) this._flashTimers.delete(fid)
            return
          }
          feature.color = tick % 2 === 0 ? highlight : original
          tick += 1
        } catch (_) {
          clearInterval(timer)
          if (fid) this._flashTimers.delete(fid)
        }
      }, 150)
      if (fid) this._flashTimers.set(fid, { timer, feature, original })
    } catch (_) {
      /* 闪烁失败不影响选择流程 */
    }
  }

  detachTileLoadListener() {
    if (this.listenerTileset && this.tileLoadListener) {
      this.listenerTileset.tileLoad.removeEventListener(this.tileLoadListener)
    }
    if (this.listenerTileset && this.tileUnloadListener) {
      this.listenerTileset.tileUnload.removeEventListener(this.tileUnloadListener)
    }
    this.tileLoadListener = null
    this.tileUnloadListener = null
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
    this._selectedHighlightId = null
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
      // 选中持续高亮：瓦片重载重放样式时保持高亮色
      if (featureId === this._selectedHighlightId && state.visible && opacityValue > 0.001) {
        feature.color = HIGHLIGHT_CONFIG.COLOR.withAlpha(opacityValue)
      } else {
        feature.color = new Cesium.Color(
          currentColor.red,
          currentColor.green,
          currentColor.blue,
          opacityValue
        )
      }
      // 与 toggleModelVisibility 保持一致：feature.show 为主隐藏机制
      try {
        feature.show = !!state.visible && opacityValue > 0.001
      } catch (e2) {
        // stale feature 引用，忽略
      }
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
    // 瓦片卸载时移除对应 feature 引用：Cesium 重新加载瓦片会生成全新 feature
    // 对象，featureMap 里的旧引用会变成 stale（对 stale 写 color/show 静默
    // 无效——显隐/高亮/透明度偶发失效的根源）。卸载即删，重载时 tileLoad
    // 会以新引用重新注册并重放样式状态。
    this.tileUnloadListener = tile => {
      if (tile.content && tile.content.featuresLength > 0) {
        for (let i = 0; i < tile.content.featuresLength; ++i) {
          try {
            const f = tile.content.getFeature(i)
            const fid = this.getFeatureId(f)
            if (this.featureMap.get(fid) === f) this.featureMap.delete(fid)
          } catch (e) {
            // ignore
          }
        }
      }
    }
    this.tileset.tileUnload.addEventListener(this.tileUnloadListener)
    this.listenerTileset = this.tileset
  }

  /**
   * 销毁管理器，清理资源
   */
  destroy() {
    this.detachTileLoadListener()
    this._flashTimers.forEach(entry => clearInterval(entry.timer))
    this._flashTimers.clear()
    this._selectedHighlightId = null
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
          // 阿舍勒全矿场景：批表属性为 component（sj_001/kt_001 等）
          feature.getProperty('component') ||
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
  toggleModelVisibility(model, globalOpacity = MODEL_DEFAULTS.OPACITY, skipStyleRebuild = false) {
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
        // 选中持续高亮：高亮色 × 固定半透明系数 × 语义透明度
        if (featureId === this._selectedHighlightId && model.visible && opacityValue > 0.001) {
          feature.color = HIGHLIGHT_CONFIG.COLOR.withAlpha(
            opacityValue * (HIGHLIGHT_CONFIG.ALPHA ?? 1)
          )
        } else {
          feature.color = new Cesium.Color(
            currentColor.red,
            currentColor.green,
            currentColor.blue,
            opacityValue
          )
        }
        // 主隐藏机制：feature.show——实测对量化/KTX2/线内容均可靠，渲染与拾取
        // 两层同时生效；color alpha 仅承担透明度渐变（对部分内容会被历史
        // per-feature 写入干扰，且 alpha=0 的要素仍留在拾取缓冲中）。
        try {
          feature.show = !!model.visible && opacityValue > 0.001
        } catch (e) {
          // 瓦片重载后旧 feature 引用失效（stale）时静默忽略；
          // 重载后 tileLoad 监听会以新引用重放本状态。
        }
        if (!skipStyleRebuild) this.applyVisibilityStyle()
        return { success: true, message: `${model.visible ? '显示' : '隐藏'}了模型: ${model.name}` }
      } else {
        this.applyVisibilityStyle()
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
      // 选中持续高亮：高亮色 × 语义透明度
      if (featureId === this._selectedHighlightId && model.visible && finalOpacity > 0.001) {
        feature.color = HIGHLIGHT_CONFIG.COLOR.withAlpha(finalOpacity)
      } else {
        feature.color = new Cesium.Color(
          currentColor.red,
          currentColor.green,
          currentColor.blue,
          finalOpacity
        )
      }
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
      // 强制全量应用（不跳过已是目标状态的）：历史上的失效渲染残留
      // （visible=false 但 color/show 未生效的组件）只有重新应用才会被清除
      m.visible = true
      this.toggleModelVisibility(m, globalOpacity, true)
    })
    this.applyVisibilityStyle()
  }

  /**
   * 隐藏所有模型
   * @param {ModelItem[]} modelList
   */
  hideAllModels(modelList) {
    modelList.forEach(m => {
      m.visible = false
      this.toggleModelVisibility(m, MODEL_DEFAULTS.OPACITY, true)
    })
    this.applyVisibilityStyle()
  }

  /**
   * 用 3D Tiles style 表达式兜底应用可见性：
   * per-feature color 在部分量化/外部 tileset 组合下可能不生效，
   * style.show 走 Cesium 标准条件管线（已在阿舍勒数据上实测可靠）。
   * 隐藏清单来自 styleState（visible=false 的 featureId）。
   */
  applyVisibilityStyle() {
    if (!this.tileset) return
    try {
      const hidden = []
      this.styleState.forEach((st, fid) => {
        if (!st.visible) hidden.push(fid)
      })
      let expr = 'true'
      if (hidden.length) {
        expr = hidden
          .map(id => "${component} !== '" + String(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'")
          .join(' && ')
      }
      this.tileset.style = new Cesium.Cesium3DTileStyle({ show: expr })
    } catch (error) {
      // style 兜底失败不影响主流程（feature.color 机制仍在）
    }
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
