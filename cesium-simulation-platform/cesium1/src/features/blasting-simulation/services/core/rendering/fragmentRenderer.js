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
    // 高亮前的原始实例颜色快照：mesh -> THREE.Color[]
    this._originalColors = new Map()
  }

  /**
   * 构建碎片 InstancedMesh（接受 FragmentSpec[]）
   * @param {FragmentSpec[]} specs - 碎片规格数组
   */
  buildFragmentMesh(specs) {
    // 清理旧碎片
    this.fragmentMeshes.forEach(mesh => {
      this.scene.remove(mesh)
    })
    this.fragmentMeshes = []

    if (!specs || specs.length === 0) return

    if (!this.rockMaterial) {
      this.rockMaterial = new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0.0,
        flatShading: true
      })
    }

    const variantCount = this.rockGeometries.length
    const groups = Array.from({ length: variantCount }, () => [])
    specs.forEach((s, i) => {
      const v = s.variantIndex !== undefined ? s.variantIndex : i % variantCount
      groups[v].push({ spec: s, specIndex: i })
    })

    const dummy = new THREE.Object3D()
    groups.forEach((group, variant) => {
      if (group.length === 0) return
      const geometry = this.rockGeometries[variant]
      const mesh = new THREE.InstancedMesh(geometry, this.rockMaterial, group.length)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true
      mesh.receiveShadow = true
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
   * 高亮 physSize 在 [minSize, maxSize] 范围内的碎片：
   *  - 首次调用时将原始实例颜色快照保存到 this._originalColors
   *  - 匹配的实例改为橙色高亮色
   *  - 不匹配的实例降低亮度（乘以 0.3）
   * @param {number} minSize - 物理尺寸下限（米，包含）
   * @param {number} maxSize - 物理尺寸上限（米，包含）
   */
  highlightBySizeRange(minSize, maxSize) {
    const lo = Number(minSize)
    const hi = Number(maxSize)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return

    const highlightColor = new THREE.Color(1.0, 0.6, 0.0)
    const tmpColor = new THREE.Color()

    for (const mesh of this.fragmentMeshes) {
      if (!mesh.instanceColor) continue
      const group = mesh.userData.specs
      if (!Array.isArray(group)) continue

      // 首次高亮：保存原始颜色快照（深拷贝，防止后续修改污染）
      if (!this._originalColors.has(mesh)) {
        const snapshot = []
        for (let i = 0; i < group.length; i++) {
          mesh.getColorAt(i, tmpColor)
          snapshot.push(tmpColor.clone())
        }
        this._originalColors.set(mesh, snapshot)
      }

      for (let i = 0; i < group.length; i++) {
        const physSize = Number(group[i]?.spec?.physSize)
        const matched = Number.isFinite(physSize) && physSize >= lo && physSize <= hi
        if (matched) {
          mesh.setColorAt(i, highlightColor)
        } else {
          // 非匹配实例降低亮度（基于原始颜色乘以 0.3，避免连续调用累积变暗）
          const original = this._originalColors.get(mesh)[i]
          tmpColor.copy(original).multiplyScalar(0.3)
          mesh.setColorAt(i, tmpColor)
        }
      }
      mesh.instanceColor.needsUpdate = true
    }
  }

  /**
   * 清除高亮，从 this._originalColors 恢复每个实例的原始颜色
   */
  clearHighlight() {
    if (this._originalColors.size === 0) return
    const tmpColor = new THREE.Color()
    for (const mesh of this.fragmentMeshes) {
      const snapshot = this._originalColors.get(mesh)
      if (!snapshot || !mesh.instanceColor) continue
      for (let i = 0; i < snapshot.length; i++) {
        tmpColor.copy(snapshot[i])
        mesh.setColorAt(i, tmpColor)
      }
      mesh.instanceColor.needsUpdate = true
    }
    this._originalColors.clear()
  }

  /** 清理碎片网格（不释放材质和几何体池） */
  clear() {
    this.fragmentMeshes.forEach(mesh => {
      this.scene.remove(mesh)
    })
    this.fragmentMeshes = []
    // 清理高亮颜色快照，避免引用已移除的 mesh
    this._originalColors.clear()
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
