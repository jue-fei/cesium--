import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import { MAX_SOURCE_COUNT } from './stressShared.js'

/**
 * 纹理与资源生命周期域（TextureLifecycle）
 *
 * 从 HeatmapManager 拆出的"纹理创建/更新/销毁"职责：
 *  - 空纹理懒创建（getEmptyTexture / getEmptySourceTexture / getEmptyColorLUTTexture），
 *    缓存写在门面共享状态（this.m.empty*）上供各域取用；
 *  - 源纹理与 LUT 构建（prepareSourceTexture / prepareColorLUT / jetRGB / rainbowRGB）；
 *  - 网格场纹理（prepareField / createFieldTexture / computeWorldToLocal，值域统计
 *    normalizeRange / computeSkewness / computeRobustRange，帧纹理 LRU 缓存
 *    getOrCreateFieldFrameTexture / bumpFieldFrameTextureOrder）；
 *  - 资源销毁公共路径（destroyTextureUniform / clearSourceTextureCache /
 *    destroyStressResources / destroyConfigResources）。
 * 经门面实例（this.m）读写共享纹理缓存状态，自身不持有状态。
 */

const clamp01 = v => Math.max(0, Math.min(1, v))

const MAX_FIELD_FRAME_TEXTURE_CACHE = 16

// 数据偏度阈值：|偏度| 超过该值视为显著偏态分布，自适应分位数裁剪保留更多极端值
const SKEWNESS_THRESHOLD = 1.5

export class TextureLifecycle {
  /** @param {import('./HeatmapManager.js').HeatmapManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  static createMutableIdentityMatrix() {
    // Cesium 的 Matrix4.IDENTITY 是 Object.freeze 冻结的只读单例，
    // 直接作为 CustomShader uniform 值会被 setUniform 内 clone 写入而抛「只读属性」错误，
    // 因此统一使用可变副本。
    return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, new Cesium.Matrix4())
  }

  getEmptySourceTexture() {
    if (this.m.emptySourceTexture) return this.m.emptySourceTexture
    const data = new Float32Array(8)
    this.m.emptySourceTexture = {
      enabled: false,
      texture: new Cesium.TextureUniform({
        typedArray: /** @type {any} */ (data),
        width: 1,
        height: 2,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.FLOAT,
        repeat: false,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
      }),
      size: new Cesium.Cartesian2(1, 2)
    }
    return this.m.emptySourceTexture
  }

  prepareSourceTexture(sources) {
    const maxSources = MAX_SOURCE_COUNT
    const width = maxSources
    const height = 2
    const data = new Float32Array(width * height * 4)
    const count = Math.min(maxSources, Array.isArray(sources) ? sources.length : 0)
    for (let i = 0; i < count; i++) {
      const s = sources[i]
      const center = s?.center
      const radius = Number(s?.radius) || 0
      const intensity = Number(s?.intensity) || 0
      const o0 = (0 * width + i) * 4
      data[o0] = Number.isFinite(center?.x) ? center.x : 0
      data[o0 + 1] = Number.isFinite(center?.y) ? center.y : 0
      data[o0 + 2] = Number.isFinite(center?.z) ? center.z : 0
      data[o0 + 3] = Number.isFinite(radius) ? radius : 0

      const o1 = (1 * width + i) * 4
      data[o1] = Number.isFinite(intensity) ? intensity : 0
      data[o1 + 1] = 0
      data[o1 + 2] = 0
      data[o1 + 3] = 0
    }

    return {
      enabled: true,
      texture: new Cesium.TextureUniform({
        typedArray: /** @type {any} */ (data),
        width,
        height,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.FLOAT,
        repeat: false,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
      }),
      size: new Cesium.Cartesian2(width, height)
    }
  }

  prepareField(field) {
    if (!field || field.type !== 'grid' || !field.data) {
      const texture = this.getEmptyTexture()
      return {
        enabled: false,
        combine: 1,
        texture,
        textures: [],
        textureSize: new Cesium.Cartesian2(1, 1),
        gridSize: new Cesium.Cartesian3(1, 1, 1),
        size: new Cesium.Cartesian3(1, 1, 1),
        worldToLocal: TextureLifecycle.createMutableIdentityMatrix()
      }
    }

    const grid = field.data.grid || field.grid
    const frames = field.data.frames || []
    const origin = field.data.origin || field.origin
    const size = field.data.size || field.size

    if (!grid || !origin || !size || frames.length === 0) {
      const texture = this.getEmptyTexture()
      return {
        enabled: false,
        combine: 1,
        texture,
        textures: [],
        textureSize: new Cesium.Cartesian2(1, 1),
        gridSize: new Cesium.Cartesian3(1, 1, 1),
        size: new Cesium.Cartesian3(1, 1, 1),
        worldToLocal: TextureLifecycle.createMutableIdentityMatrix()
      }
    }

    const gridSize = new Cesium.Cartesian3(grid.width, grid.height, grid.depth)
    const textureWidth = grid.width * grid.depth
    const textureHeight = grid.height
    const textureSize = new Cesium.Cartesian2(textureWidth, textureHeight)
    const worldToLocal = this.computeWorldToLocal(origin)
    const sizeVec = new Cesium.Cartesian3(size[0], size[1], size[2])
    const valueRange = field.data.valueRange || field.valueRange
    const frameTextureCache = new Map()
    const frameTextureOrder = []
    const baseTexture =
      frames.length > 0
        ? this.createFieldTexture(frames[0].values || [], grid, valueRange)
        : this.getEmptyTexture()
    if (frames.length > 0) {
      frameTextureCache.set(0, baseTexture)
      frameTextureOrder.push(0)
    }
    const combineMap = { replace: 0, max: 1, add: 2 }
    const combine = combineMap[field.combine] ?? 0

    return {
      enabled: true,
      combine,
      texture: baseTexture,
      textures: [],
      frameCount: frames.length,
      frameTextureCache,
      frameTextureOrder,
      frameValues: frames,
      textureSize,
      gridSize,
      size: sizeVec,
      worldToLocal,
      valueRange
    }
  }

  getOrCreateFieldFrameTexture(field, frameIndex) {
    if (!field?.enabled || !Number.isInteger(frameIndex) || frameIndex < 0) {
      return field?.texture || this.getEmptyTexture()
    }
    if (field.frameTextureCache?.has(frameIndex)) {
      this.bumpFieldFrameTextureOrder(field, frameIndex)
      return field.frameTextureCache.get(frameIndex)
    }
    const frame = Array.isArray(field.frameValues) ? field.frameValues[frameIndex] : null
    const values = frame?.values || []
    const texture = this.createFieldTexture(
      values,
      {
        width: Math.max(1, Math.round(field.gridSize?.x || 1)),
        height: Math.max(1, Math.round(field.gridSize?.y || 1)),
        depth: Math.max(1, Math.round(field.gridSize?.z || 1))
      },
      field.valueRange
    )
    if (!field.frameTextureCache) field.frameTextureCache = new Map()
    if (!Array.isArray(field.frameTextureOrder)) field.frameTextureOrder = []
    field.frameTextureCache.set(frameIndex, texture)
    field.frameTextureOrder.push(frameIndex)
    while (field.frameTextureOrder.length > MAX_FIELD_FRAME_TEXTURE_CACHE) {
      const staleIndex = field.frameTextureOrder.shift()
      if (!Number.isInteger(staleIndex) || staleIndex === frameIndex) continue
      const staleTexture = field.frameTextureCache.get(staleIndex)
      field.frameTextureCache.delete(staleIndex)
      if (staleTexture && staleTexture !== this.m.emptyTexture && staleTexture !== field.texture) {
        this.destroyTextureUniform(staleTexture)
      }
    }
    return texture
  }

  bumpFieldFrameTextureOrder(field, frameIndex) {
    if (!Array.isArray(field?.frameTextureOrder)) return
    const idx = field.frameTextureOrder.indexOf(frameIndex)
    if (idx >= 0) field.frameTextureOrder.splice(idx, 1)
    field.frameTextureOrder.push(frameIndex)
  }

  computeWorldToLocal(origin) {
    const position = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
    const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(position)
    return Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  }

  createFieldTexture(values, grid, valueRange) {
    const width = grid.width * grid.depth
    const height = grid.height
    const data = new Uint8Array(width * height)
    const range = this.normalizeRange(values, valueRange)
    const min = range.min
    const max = range.max
    const denom = Math.max(0.0001, max - min)

    for (let z = 0; z < grid.depth; z++) {
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          const valueIndex = z * grid.width * grid.height + y * grid.width + x
          const rawValue = values[valueIndex]
          const v = Number(rawValue ?? min)
          const n = Math.min(1, Math.max(0, (v - min) / denom))
          const col = z * grid.width + x
          const row = y
          const texIndex = row * width + col
          data[texIndex] = Math.round(n * 255)
        }
      }
    }

    return new Cesium.TextureUniform({
      typedArray: data,
      width,
      height,
      pixelFormat: Cesium.PixelFormat.LUMINANCE,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
    })
  }

  getEmptyTexture() {
    if (this.m.emptyTexture) return this.m.emptyTexture
    const data = new Uint8Array([0])
    this.m.emptyTexture = new Cesium.TextureUniform({
      typedArray: data,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.LUMINANCE,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
    })
    return this.m.emptyTexture
  }

  getEmptyColorLUTTexture() {
    if (this.m.emptyColorLUTTexture) return this.m.emptyColorLUTTexture
    const data = new Uint8Array([0, 0, 0, 255])
    this.m.emptyColorLUTTexture = new Cesium.TextureUniform({
      typedArray: data,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
    })
    return this.m.emptyColorLUTTexture
  }

  prepareColorLUT(spec) {
    if (!spec || typeof spec !== 'object') {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const size = Number(spec.size ?? spec['级数'] ?? 0)
    if (!(Number.isInteger(size) && size >= 2)) {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const table = Array.isArray(spec.table)
      ? spec.table
      : Array.isArray(spec['表'])
        ? spec['表']
        : null
    const preset = String(spec.preset ?? spec['色标'] ?? '')

    const rgba = new Uint8Array(size * 4)
    if (table) {
      if (table.length !== size) {
        return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
      }
      for (let i = 0; i < size; i++) {
        const c = table[i]
        const offset = i * 4
        if (Array.isArray(c) && c.length >= 3) {
          rgba[offset] = Math.max(0, Math.min(255, Math.round(Number(c[0]) || 0)))
          rgba[offset + 1] = Math.max(0, Math.min(255, Math.round(Number(c[1]) || 0)))
          rgba[offset + 2] = Math.max(0, Math.min(255, Math.round(Number(c[2]) || 0)))
          rgba[offset + 3] =
            c.length >= 4 ? Math.max(0, Math.min(255, Math.round(Number(c[3]) || 255))) : 255
          continue
        }
        if (typeof c === 'string') {
          const col = Cesium.Color.fromCssColorString(c)
          rgba[offset] = Math.round(col.red * 255)
          rgba[offset + 1] = Math.round(col.green * 255)
          rgba[offset + 2] = Math.round(col.blue * 255)
          rgba[offset + 3] = Math.round((Number.isFinite(col.alpha) ? col.alpha : 1) * 255)
          continue
        }
        rgba[offset] = 0
        rgba[offset + 1] = 0
        rgba[offset + 2] = 0
        rgba[offset + 3] = 255
      }
    } else if (preset) {
      // 数据集配置可触发：foundation.js 允许 LUT 仅提供 色标 而无 表，
      // 故该 preset 降级路径仍需保留（CIELAB 主路径仅覆盖由配色带推导的 LUT）。
      const name = preset.toLowerCase()
      for (let i = 0; i < size; i++) {
        const t = size === 1 ? 0 : i / (size - 1)
        const [r, g, b] = name === 'rainbow' ? this.rainbowRGB(t) : this.jetRGB(t)
        const offset = i * 4
        rgba[offset] = Math.round(r * 255)
        rgba[offset + 1] = Math.round(g * 255)
        rgba[offset + 2] = Math.round(b * 255)
        rgba[offset + 3] = 255
      }
    } else {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const texture = new Cesium.TextureUniform({
      typedArray: rgba,
      width: size,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
    })

    return { enabled: true, texture, size }
  }

  jetRGB(t) {
    const clamp01 = v => Math.max(0, Math.min(1, v))
    const r = clamp01(1.5 - Math.abs(4 * t - 3))
    const g = clamp01(1.5 - Math.abs(4 * t - 2))
    const b = clamp01(1.5 - Math.abs(4 * t - 1))
    return [r, g, b]
  }

  rainbowRGB(t) {
    const clamp01 = v => Math.max(0, Math.min(1, v))
    const h = ((1 - clamp01(t)) * 0.75) % 1
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const q = 1 - f
    const m = 0
    const idx = i % 6
    if (idx === 0) return [1, f, m]
    if (idx === 1) return [q, 1, m]
    if (idx === 2) return [m, 1, f]
    if (idx === 3) return [m, q, 1]
    if (idx === 4) return [f, m, 1]
    return [1, m, q]
  }

  normalizeRange(values, valueRange, mapper = null) {
    if (Array.isArray(valueRange) && valueRange.length === 2) {
      const vMin = Number(valueRange[0])
      const vMax = Number(valueRange[1])
      if (Number.isFinite(vMin) && Number.isFinite(vMax) && vMax > vMin) {
        return { min: vMin, max: vMax }
      }
      return this.computeRobustRange(values, mapper)
    }
    return this.computeRobustRange(values, mapper)
  }

  /** 计算数据偏度 —— 正值=右偏（极端高值），负值=左偏 */
  computeSkewness(arr) {
    if (arr.length < 3) return 0
    const n = arr.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += arr[i]
    const mean = sum / n
    let m2 = 0
    let m3 = 0
    for (let i = 0; i < n; i++) {
      const d = arr[i] - mean
      m2 += d * d
      m3 += d * d * d
    }
    if (m2 < 1e-12) return 0
    const variance = m2 / n
    const std = Math.sqrt(variance)
    return m3 / n / (std * std * std)
  }

  computeRobustRange(values, mapper = null, quantileOpts = null) {
    const arr = []
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i++) {
        const raw = values[i]
        const v = typeof mapper === 'function' ? mapper(raw) : raw
        if (typeof v === 'number' && Number.isFinite(v)) arr.push(v)
      }
    } else if (values && typeof values[Symbol.iterator] === 'function') {
      for (const raw of values) {
        const v = typeof mapper === 'function' ? mapper(raw) : raw
        if (typeof v === 'number' && Number.isFinite(v)) arr.push(v)
      }
    }
    if (arr.length === 0) return { min: 0, max: 1 }
    if (arr.length === 1) {
      const v = arr[0]
      return { min: v, max: v === 0 ? 1 : v + Math.abs(v) * 0.1 || 1 }
    }
    arr.sort((a, b) => a - b)

    // 自适应分位数裁剪 —— 根据数据偏度动态调整裁剪比例
    let loQ = 0.02
    let hiQ = 0.98
    if (quantileOpts) {
      loQ = Number.isFinite(Number(quantileOpts.lo)) ? clamp01(Number(quantileOpts.lo)) : loQ
      hiQ = Number.isFinite(Number(quantileOpts.hi)) ? clamp01(Number(quantileOpts.hi)) : hiQ
    } else {
      const skew = this.computeSkewness(arr)
      if (skew > SKEWNESS_THRESHOLD) {
        // 右偏分布（多数低应力，少数高应力）→ 保留更多上尾极端值
        loQ = 0.01
        hiQ = 0.995
      } else if (skew < -SKEWNESS_THRESHOLD) {
        // 左偏分布 → 保留更多下尾
        loQ = 0.005
        hiQ = 0.97
      }
      // 接近对称分布 → 标准 2%-98% 裁剪
    }

    const loIdx = Math.max(0, Math.floor(arr.length * loQ))
    const hiIdx = Math.min(arr.length - 1, Math.ceil(arr.length * hiQ))
    const lo = arr[loIdx]
    const hi = arr[hiIdx]
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      const rawMin = arr[0]
      const rawMax = arr[arr.length - 1]
      return rawMin < rawMax ? { min: rawMin, max: rawMax } : { min: rawMin, max: rawMin + 1 }
    }
    const padding = Math.max(0.01, (hi - lo) * 0.05)
    return { min: lo - padding, max: hi + padding }
  }

  destroyTextureUniform(textureUniform) {
    if (!textureUniform || typeof textureUniform.destroy !== 'function') return
    try {
      textureUniform.destroy()
    } catch (e) {
      warn('heatmap', 'HeatmapManager', e)
    }
  }

  /**
   * 清空 entry 的应力源纹理缓存（销毁其中所有非空纹理）
   * @private
   */
  clearSourceTextureCache(entry) {
    if (!(entry?.sourceTextureCache instanceof Map)) return
    for (const tex of entry.sourceTextureCache.values()) {
      if (tex && tex !== this.m.emptySourceTexture?.texture) {
        this.destroyTextureUniform(tex)
      }
    }
    entry.sourceTextureCache.clear()
  }

  destroyStressResources(entry) {
    if (!entry) return
    const { shader, config, field } = entry
    if (shader && typeof shader.destroy === 'function') {
      try {
        shader.destroy()
      } catch (e) {
        warn('heatmap', 'HeatmapManager', e)
      }
    }
    this.clearSourceTextureCache(entry)
    this.destroyConfigResources(config, field)
  }

  /**
   * 销毁配置相关的纹理（LUT / 应力源纹理 / 场纹理）。
   * destroyStressResources 与 updateStressConfig 的公共清理路径。
   * @private
   */
  destroyConfigResources(config, field) {
    const lutTexture = config?.lut?.texture || null
    if (lutTexture && lutTexture !== this.m.emptyColorLUTTexture) {
      this.destroyTextureUniform(lutTexture)
    }
    const sourceTexture = config?.sourceTex?.texture || null
    if (sourceTexture && sourceTexture !== this.m.emptySourceTexture?.texture) {
      this.destroyTextureUniform(sourceTexture)
    }
    const fieldTextures = Array.isArray(field?.textures) ? field.textures : []
    const cachedFrameTextures = field?.frameTextureCache
      ? Array.from(field.frameTextureCache.values())
      : []
    const textureSet = new Set([...fieldTextures, ...cachedFrameTextures, field?.texture])
    for (const tex of textureSet) {
      if (tex && tex !== this.m.emptyTexture) {
        this.destroyTextureUniform(tex)
      }
    }
  }
}
