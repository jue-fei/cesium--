/**
 * 碎片渲染器
 *
 * 负责 3D 岩石碎片的 InstancedMesh 创建、更新与释放。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'

/**
 * 碎片渲染器类
 * 管理碎片 InstancedMesh 的生命周期：创建、逐帧更新（从物理引擎同步状态）、释放。
 */
export class FragmentRenderer {
  /**
   * @param {THREE.Scene} scene - Three.js 场景
   * @param {THREE.BufferGeometry[]} rockGeometries - 岩石几何体池（引用，由主渲染器创建和释放）
   * @param {BlastPhysicsEngineWorker} physicsEngine - 物理引擎（读取碎片状态）
   * @param {Object} layerVisibility - 图层可见性（引用，与主渲染器共享）
   */
  constructor(scene, rockGeometries, physicsEngine, layerVisibility) {
    this.scene = scene
    this.rockGeometries = rockGeometries
    this.physicsEngine = physicsEngine
    this.layerVisibility = layerVisibility

    // 碎片 InstancedMesh 列表（按几何变体分组）
    this.fragmentMeshes = []
    // 共享材质（延迟创建）
    this.rockMaterial = null

    // 块度染色模式（按 physSize 分三档：大块红/中块黄/小块绿）
    this._blockColorEnabled = false
    this._kcoThresholds = null  // { x50, x80, xmax }
    // 块度染色高亮（联动：可同时高亮多档，空集合表示不高亮）
    this._highlightedClass = null  // Set<'large'|'medium'|'small'> | null
    // 损伤区按半径高亮（联动：高亮爆心半径内的碎片，优先级高于块度染色）
    this._zoneHighlight = null  // { center: THREE.Vector3, radius: number, color: THREE.Color } | null
  }

  /**
   * 构建碎片 InstancedMesh（接受 FragmentSpec[]）
   * @param {FragmentSpec[]} specs - 碎片规格数组
   */
  buildFragmentMesh(specs) {
    // 清理旧碎片
    this.fragmentMeshes.forEach(mesh => { this.scene.remove(mesh) })
    this.fragmentMeshes = []

    if (!specs || specs.length === 0) return

    if (!this.rockMaterial) {
      this.rockMaterial = new THREE.MeshStandardMaterial({
        roughness: 0.9, metalness: 0.0, flatShading: true
      })
    }

    const variantCount = this.rockGeometries.length
    const groups = Array.from({ length: variantCount }, () => [])
    specs.forEach((s, i) => {
      const v = s.variantIndex !== undefined ? s.variantIndex : (i % variantCount)
      groups[v].push({ spec: s, specIndex: i })
    })

    const dummy = new THREE.Object3D()
    groups.forEach((group, variant) => {
      if (group.length === 0) return
      const geometry = this.rockGeometries[variant]
      const mesh = new THREE.InstancedMesh(geometry, this.rockMaterial, group.length)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true; mesh.receiveShadow = true
      mesh.frustumCulled = false

      group.forEach(({ spec }, localIdx) => {
        // 初始隐藏：放到屏幕外 + 缩放到 0
        dummy.position.set(0, -9999, 0)
        dummy.scale.setScalar(0)
        dummy.updateMatrix()
        mesh.setMatrixAt(localIdx, dummy.matrix)
        const c = spec.color
        mesh.setColorAt(localIdx, new THREE.Color(c.r, c.g, c.b))
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.userData.specs = group
      mesh.count = group.length
      this.scene.add(mesh)
      this.fragmentMeshes.push(mesh)
    })
  }

  /** 更新碎片 InstancedMesh（从物理引擎读状态） */
  updateFragmentMesh() {
    const bodyStates = this.physicsEngine.getBodyStates()
    if (!bodyStates || bodyStates.length === 0) return

    const dummy = new THREE.Object3D()

    for (const mesh of this.fragmentMeshes) {
      const group = mesh.userData.specs
      if (!group) continue
      let visibleCount = 0
      const fragmentLayerOn = this.layerVisibility.fragment !== false

      for (let localIdx = 0; localIdx < group.length; localIdx++) {
        const bodyIdx = group[localIdx].specIndex
        const body = bodyIdx < bodyStates.length ? bodyStates[bodyIdx] : null

        if (body && body.alive) {
          const dispSize = group[localIdx].spec ? group[localIdx].spec.dispSize : body.physSize * 2
          dummy.position.set(body.posX, body.posY, body.posZ)
          dummy.quaternion.set(body.quatX, body.quatY, body.quatZ, body.quatW)
          dummy.scale.setScalar(dispSize)
          visibleCount++
        } else {
          dummy.position.set(0, -9999, 0)
          dummy.scale.setScalar(0)
        }
        dummy.updateMatrix()
        mesh.setMatrixAt(localIdx, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.count = group.length
      mesh.visible = visibleCount > 0 && fragmentLayerOn
    }
  }

  /**
   * 应用碎片图层可见性
   * @param {boolean} visible - 是否可见
   */
  applyLayerVisibility(visible) {
    if (this.fragmentMeshes) {
      for (const m of this.fragmentMeshes) m.visible = visible
    }
  }

  /**
   * 设置块度染色阈值（由 threeBlastingRenderer 在 initBlast 后调用）
   * @param {{x50:number, x80:number, xmax:number}} thresholds
   */
  setBlockColorThresholds(thresholds) {
    this._kcoThresholds = thresholds || null
    if (this._blockColorEnabled) this._recolorInstances()
  }

  /**
   * 开启/关闭块度染色模式
   * @param {boolean} enabled - true=按 physSize 染色（大红/中黄/小绿），false=恢复原始岩石色
   */
  applyBlockColorMode(enabled) {
    this._blockColorEnabled = !!enabled
    if (!enabled) this._highlightedClass = null
    this._recolorInstances()
  }

  /**
   * 联动高亮：高亮指定块度等级（可多选），未选中等级保持原色（独立于 blockColor 模式）
   * @param {('large'|'medium'|'small')[]|'large'|'medium'|'small'|null} classes - 数组/单值/null(取消)
   */
  highlightBlockClass(classes) {
    if (!classes || (Array.isArray(classes) && classes.length === 0)) {
      this._highlightedClass = null
    } else {
      const arr = Array.isArray(classes) ? classes : [classes]
      this._highlightedClass = new Set(arr)
    }
    this._recolorInstances()
  }

  /**
   * 按损伤区半径高亮碎片：半径内碎片着指定颜色，半径外保持原色
   * 优先级高于块度染色（zone 高亮激活时覆盖 blockColor 效果）
   * @param {{x,y,z}|null} center - 损伤区中心（null 取消高亮，恢复块度染色/原色）
   * @param {number} radius - 高亮半径（米）
   * @param {number} colorHex - 高亮颜色（如 0xff3030）
   */
  highlightByZone(center, radius, colorHex) {
    if (!center) {
      this._zoneHighlight = null
    } else {
      this._zoneHighlight = {
        center: new THREE.Vector3(center.x, center.y, center.z),
        radius: Math.max(0.01, radius),
        color: new THREE.Color(colorHex)
      }
    }
    this._recolorInstances()
  }

  /**
   * 按 physSize 判定块度等级
   * @param {number} physSize
   * @returns {'large'|'medium'|'small'}
   */
  _classifyBlock(physSize) {
    const th = this._kcoThresholds
    if (!th) return physSize > 0.3 ? 'large' : (physSize > 0.1 ? 'medium' : 'small')
    if (physSize >= th.x80) return 'large'
    if (physSize >= th.x50) return 'medium'
    return 'small'
  }

  /** 内部：重染所有碎片实例（损伤区高亮 > 单档块度高亮 > 块度染色 > 恢复原始色） */
  _recolorInstances() {
    const enabled = this._blockColorEnabled
    const hl = this._highlightedClass
    const zh = this._zoneHighlight
    // 损伤区高亮激活时需读取碎片实时位置
    const bodyStates = zh ? this.physicsEngine.getBodyStates?.() : null

    for (const mesh of this.fragmentMeshes) {
      const group = mesh.userData.specs
      if (!group) continue
      for (let i = 0; i < group.length; i++) {
        const spec = group[i].spec
        let color

        if (zh && bodyStates) {
          // 损伤区高亮优先级最高：半径内着色，半径外保持原色
          const body = bodyStates[group[i].specIndex]
          if (!body || !body.alive) {
            color = new THREE.Color(0, 0, 0)  // 不可见碎片不着色
          } else {
            const dx = body.posX - zh.center.x
            const dy = body.posY - zh.center.y
            const dz = body.posZ - zh.center.z
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
            if (dist <= zh.radius) {
              color = zh.color.clone()
            } else {
              // 半径外碎片：保持原色（不变暗）
              const c = spec.color
              color = new THREE.Color(c.r, c.g, c.b)
            }
          }
        } else if (hl && hl.size > 0) {
          // 多档块度高亮：高亮选中等级（可多选），其他保持原色（独立于 blockColor 模式）
          const cls = this._classifyBlock(spec.physSize)
          if (hl.has(cls)) {
            if (cls === 'large') color = new THREE.Color(0.9, 0.2, 0.15)
            else if (cls === 'medium') color = new THREE.Color(0.95, 0.75, 0.15)
            else color = new THREE.Color(0.2, 0.8, 0.25)
          } else {
            // 非高亮等级：保持原色（不变暗）
            const c = spec.color
            color = new THREE.Color(c.r, c.g, c.b)
          }
        } else if (enabled) {
          // 块度染色模式：全部按等级染色
          const cls = this._classifyBlock(spec.physSize)
          if (cls === 'large') color = new THREE.Color(0.9, 0.2, 0.15)
          else if (cls === 'medium') color = new THREE.Color(0.95, 0.75, 0.15)
          else color = new THREE.Color(0.2, 0.8, 0.25)
        } else {
          // 恢复原始岩石颜色
          const c = spec.color
          color = new THREE.Color(c.r, c.g, c.b)
        }
        mesh.setColorAt(i, color)
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  /** 清理碎片网格（不释放材质和几何体池，仅释放实例缓冲） */
  clear() {
    this.fragmentMeshes.forEach(mesh => {
      this.scene.remove(mesh)
      // InstancedMesh 的 instanceMatrix/instanceColor 是独立 GPU buffer，必须显式释放
      // 不调用 geometry/material.dispose()：几何体与材质由池共享
      if (mesh.dispose) mesh.dispose()
      mesh.geometry = null
      mesh.material = null
    })
    this.fragmentMeshes = []
  }

  /** 释放碎片渲染资源（材质；几何体池由主渲染器释放） */
  dispose() {
    this.clear()
    if (this.rockMaterial) {
      this.rockMaterial.dispose()
      this.rockMaterial = null
    }
  }
}
