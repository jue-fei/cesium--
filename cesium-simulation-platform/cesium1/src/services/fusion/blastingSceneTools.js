/**
 * 爆破场景工具桥（跨模块单例）
 *
 * 当爆破模拟的 three.js 场景就绪时，由 BlastingManager 注册渲染器句柄；
 * 其它功能模块（模型控制透明、测量、裁剪等面板）在爆破模式下通过本桥
 * 把操作转发到爆破 three 场景，而非 Cesium 场景。
 *
 * 本模块不依赖任何 Vue/Cesium，仅持有一个渲染器引用（可空）。
 * active 具备轻量订阅能力：外部（Vue 组件）可 subscribe 以响应式感知
 * 爆破场景的激活/销毁。
 */
const _subscribers = new Set()

const tools = {
  _renderer: null,

  _emit(active) {
    for (const fn of _subscribers) {
      try {
        fn(active)
      } catch (e) {
        /* 订阅者异常不影响工具桥 */
      }
    }
  },

  /** 注册当前爆破渲染器（threeBlastingRenderer） */
  setRenderer(renderer) {
    this._renderer = renderer
    this._emit(this.active)
  },

  /** 注销（场景销毁/切换出去时调用） */
  clear() {
    if (this._renderer || _subscribers.size) {
      this._renderer = null
      this._emit(false)
    }
  },

  /** 订阅爆破场景激活状态变化；返回取消订阅函数 */
  subscribe(fn) {
    _subscribers.add(fn)
    fn(this.active)
    return () => _subscribers.delete(fn)
  },

  /** 是否处于爆破场景活跃状态 */
  get active() {
    return !!this._renderer
  },

  // ── 透明度 ─────────────────────────────────────────────
  setOpacity(which, opacity) {
    this._renderer?.setSceneObjectOpacity?.(which, opacity)
  },

  getOpacity(which) {
    return this._renderer?.getSceneObjectOpacity?.(which) ?? null
  },

  // ── 岩体剖面裁剪 ────────────────────────────────────────
  setSection(plane) {
    this._renderer?.setSceneSection?.(plane)
  },

  getSection() {
    return this._renderer?.getSceneSection?.() ?? { enabled: 0, axis: 0, pos: 0 }
  },

  // ── 拾取式剖切（爆破模式）───────────────────────────────
  /** 在爆破场景中对真实岩体做射线拾取，回调岩体局部点 */
  pickRockPoint(handler) {
    const detach = this._renderer?.pickRockPoint?.(handler)
    return detach || (() => {})
  },

  /** 沿所选轴切出过拾取点的平面 */
  setSectionPick(axis, point) {
    return this._renderer?.setSceneSectionPick?.(axis, point) ?? { enabled: 0 }
  },

  /** 显示/隐藏拾取点标记（选轴前给出视觉反馈） */
  setPickPointMarker(point) {
    this._renderer?.setScenePickPointMarker?.(point)
  },

  /** 清除拾取式剖切并还原完整岩体 */
  clearSectionPick() {
    this._renderer?.clearSceneSectionPick?.()
  }
}

export const blastingSceneTools = tools
