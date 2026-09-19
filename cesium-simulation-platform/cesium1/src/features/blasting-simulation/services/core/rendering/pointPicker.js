/**
 * 点选拾取控制器（PointPicker）
 *
 * 从 ThreeBlastingRenderer（门面）按职责域拆分的组合控制器之一，负责：
 *  - enablePointPick/disablePointPick：PPV/应力/损伤场点选拾取（鼠标射线 ×
 *    场包围盒 Box3 求交 → sampleAtWorldPoint 采样回调），含"点击 vs 拖拽"位移阈值
 *  - pickRockPoint：岩体真实网格射线拾取（返回岩体局部坐标命中点）
 *  - setSceneSectionPick/clearSceneSectionPick：拾取式剖切（过拾取点沿轴切平面）
 *  - setScenePickPointMarker/setMonitorPointMarkers：拾取点标记与监测点持久标记
 *
 * 职责边界：
 *  - 不持有任何状态：canvas 监听卸载句柄 _pickDetach 仍保存在门面实例上
 *    （经 this.r 访问），enablePointPick 与 pickRockPoint 共用同一互斥句柄，
 *    与拆分前行为一致。
 *  - 与其他控制器互不引用；门面保留全部同名公共委托入口。
 */

import * as THREE from 'three'

export class PointPicker {
  /**
   * @param {ThreeBlastingRenderer} renderer - 门面渲染器实例（经 this.r 访问门面状态与公共方法）
   */
  constructor(renderer) {
    this.r = renderer
  }

  /**
   * 开启"点选拾取振动场"：单击时沿鼠标射线取与 PPV 场包围盒的交点，
   * 用振动场渲染器在世界坐标处采样 PPV/应力/损伤并回调。
   *
   * 设计要点：
   *  - 不依赖实体 mesh 命中（振动场直接着在岩体表面、可透明），改用 Box3
   *    与射线求交获得"该像素对应空间点"，最通用。
   *  - 用 pointerdown/pointerup 位移阈值区分"点击拾取"与"拖拽平移"，
   *    避免与 OrbitControls 左键平移冲突。
   *  - 纯增量：不改动渲染/相机/物理逻辑，仅在 canvas 上挂监听。
   *
   * @param {Function} handler - (sample|null) => void；sample 来自 sampleAtWorldPoint()
   * @param {Object} [opts]
   * @param {number} [opts.maxDragPx=4] - 判定为"点击"的最大拖拽位移(px)
   * @returns {Function} 用于关闭拾取的 detach 函数
   */
  enablePointPick(handler, opts = {}) {
    const maxDragPx = opts.maxDragPx ?? 4
    if (this.r._pickDetach) this.r._pickDetach()
    const canvas = this.r.renderer.domElement
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const _p0 = { x: 0, y: 0 }
    let down = false

    const box = () => {
      const fd = this.r._vibrationFieldRenderer?.getFieldData?.()
      if (!fd?.boundsMin || !fd?.boundsMax || !fd?.center) return null
      const { boundsMin, boundsMax } = fd
      return new THREE.Box3(
        new THREE.Vector3(boundsMin[0], boundsMin[1], boundsMin[2]).add(fd.center),
        new THREE.Vector3(boundsMax[0], boundsMax[1], boundsMax[2]).add(fd.center)
      )
    }

    const onDown = e => {
      down = true
      _p0.x = e.clientX
      _p0.y = e.clientY
    }
    const onUp = e => {
      if (!down) return
      down = false
      const dx = e.clientX - _p0.x
      const dy = e.clientY - _p0.y
      if (Math.hypot(dx, dy) > maxDragPx) return // 是拖拽，非点击
      const rect = canvas.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1)
      )
      raycaster.setFromCamera(ndc, this.r.camera)
      const b = box()
      if (!b) {
        handler(null)
        return
      }
      const hit = new THREE.Vector3()
      if (!raycaster.ray.intersectBox(b, hit)) {
        handler(null)
        return
      }
      const sample = this.r._vibrationFieldRenderer?.sampleAtWorldPoint?.(hit)
      handler(sample || null)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)

    this.r._pickDetach = () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      this.r._pickDetach = null
    }
    return this.r._pickDetach
  }

  /** 关闭点选拾取 */
  disablePointPick() {
    if (this.r._pickDetach) this.r._pickDetach()
  }

  /**
   * 拾取式剖切：在岩体表面拾取一点后，沿所选轴切出过该点的平面。
   * @param {number} axis 0=X 1=Y 2=Z
   * @param {{x,y,z}} point 岩体局部坐标
   */
  setSceneSectionPick(axis, point) {
    return this.r._sceneBuilder?.setSectionPick?.(axis, point) ?? { enabled: 0 }
  }

  /** 显示/隐藏拾取点标记（选轴前给出视觉反馈） */
  setScenePickPointMarker(point) {
    this.r._sceneBuilder?.setPickPointMarker?.(point)
  }

  /** 绘制监测点（测点）持久标记：维护岩体上已放置测点的粉球+光晕 */
  setMonitorPointMarkers(points) {
    this.r._sceneBuilder?.setMonitorPointMarkers?.(points)
  }

  /** 清除拾取式剖切（还原完整岩体并移除轮廓标记） */
  clearSceneSectionPick() {
    this.r._sceneBuilder?.clearSectionPick?.()
  }

  /**
   * 在爆破场景中对真实岩体网格做射线拾取，返回命中的岩体局部坐标点。
   * @param {(local:{x,y,z}|null)=>void} handler
   * @param {Object} [opts]
   * @param {number} [opts.maxDragPx=4] - 判定为"点击"的最大拖拽位移(px)
   * @returns {Function} detach 函数（用于停止拾取）
   */
  pickRockPoint(handler, opts = {}) {
    const maxDragPx = opts.maxDragPx ?? 4
    if (this.r._pickDetach) this.r._pickDetach()
    const sceneBuilder = this.r._sceneBuilder
    const canvas = this.r.renderer?.domElement
    if (!canvas || !sceneBuilder) {
      handler(null)
      return () => {}
    }
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const _p0 = { x: 0, y: 0 }
    let down = false

    const onDown = e => {
      down = true
      _p0.x = e.clientX
      _p0.y = e.clientY
    }
    const onUp = e => {
      if (!down) return
      down = false
      const dx = e.clientX - _p0.x
      const dy = e.clientY - _p0.y
      if (Math.hypot(dx, dy) > maxDragPx) return
      const rect = canvas.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1)
      )
      raycaster.setFromCamera(ndc, this.r.camera)
      const meshes = sceneBuilder.getRockMeshes?.() || []
      for (const m of meshes) {
        if (!m.visible) continue
        const hit = raycaster.intersectObject(m, false)[0]
        if (!hit) continue
        // 世界命中点 → 岩体局部坐标（几何剖切基于局部坐标）
        const local = m.worldToLocal(hit.point.clone())
        handler({ x: local.x, y: local.y, z: local.z, world: hit.point })
        return
      }
      handler(null)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)

    this.r._pickDetach = () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      this.r._pickDetach = null
    }
    return this.r._pickDetach
  }
}
