/**
 * 碎片渲染器
 *
 * 负责 3D 岩石碎片的 InstancedMesh 创建、更新与释放。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'

// 隧道碰撞体/壳体的半长(m)：与 RapierPhysicsEngine.TUNNEL_HALF_LEN 及
// sceneBuilder._buildTunnelShell(shellLength=80) 对齐，用于剔除飞出洞口的碎片。
const TUNNEL_HALF_LEN = 80

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
    // 预分配 dummy Object3D（updateFragmentMesh 每帧调用，避免 new 导致 GC 压力）
    this._dummy = new THREE.Object3D()
    // 隧道断面参数（按断面隐藏"隧道外"实例；null = 不裁剪）
    this._sectionBounds = null
    // 岩石变体 AABB 半轴表（索引=variantIndex，供"尖角探出断面"判定）
    this._extentTable = null
  }

  /**
   * 注入隧道断面定义（与物理引擎同源），用于隐藏"卡在隧道外/拱顶尖角伸出"
   * 的碎石实例——这些碎块的网格本体已跑出隧道，若照常渲染会在隧道外留下
   * 飘浮碎石（旧版仅轮廓剔除，壳不包但石头仍可见）。
   * @param {Object} bounds - 见 threeBlastingRenderer._lastPhysicsBounds
   */
  setSectionBounds(bounds) {
    this._sectionBounds = bounds
      ? {
          centerX: bounds.centerX,
          centerY: bounds.centerY,
          centerZ: bounds.centerZ,
          rightX: bounds.rightX,
          rightY: bounds.rightY,
          rightZ: bounds.rightZ,
          forwardX: bounds.forwardX || 0,
          forwardY: bounds.forwardY || 0,
          forwardZ: bounds.forwardZ || 0,
          floorY: bounds.floorY,
          halfWidth: Number(bounds.halfWidth) || 0,
          wallHeight: Number(bounds.wallHeight) || 0,
          archRadius: Number(bounds.archRadius) || 0,
          shape: bounds.shape || 'horseshoe'
        }
      : null
  }

  /** 注入岩石变体 AABB 半轴表（索引=variantIndex），配合四元数做尖角探出判定 */
  setExtentTable(table) {
    this._extentTable = Array.isArray(table) ? table : null
  }

  /** 隧道断面在侧向 t 处的净空高度（自底板起）；|t| 超出断面返回 null */
  _sectionCeiling(t) {
    const b = this._sectionBounds
    if (!b) return null
    const halfW = b.halfWidth
    const wallH = b.wallHeight
    const R = b.archRadius
    const at = Math.abs(Number(t) || 0)
    const shape = b.shape || 'horseshoe'
    if (shape === 'circular') {
      if (at > R) return null
      return R + Math.sqrt(Math.max(0, R * R - at * at))
    }
    if (shape === 'rectangular') {
      if (at > halfW) return null
      return wallH + R
    }
    if (at > halfW) return null
    if (at > R) return wallH
    return wallH + Math.sqrt(Math.max(0, R * R - at * at))
  }

  /**
   * 判定碎片实例是否"跑出隧道"（应隐藏）：
   *  1) 中心越过断面边界（同轮廓的 _outsideSection，容差一致）→ 隐藏；
   *  2) 中心在底板下方（穿底漏出）→ 隐藏；
   *  3) 轴向超出隧道壳（飞出洞口）→ 隐藏；
   *  4) 中心在内但 AABB 顶面（中心+竖向支撑）越过净空 + 容差（拱顶尖角
   *     伸出隧道）→ 隐藏。与爆堆轮廓的剔除口径一致：壳不包、石头也不显示。
   * @param {{posX:number,posY:number,posZ:number,qx?:number,qy?:number,qz?:number,qw?:number}} body
   * @param {{variantIndex:number,dispSize:number}|null} spec
   */
  _isOutsideSection(body, spec) {
    const b = this._sectionBounds
    if (!b) return false
    const dx = body.posX - b.centerX
    const dy = body.posY - b.centerY
    const dz = body.posZ - b.centerZ
    const t = dx * b.rightX + dy * b.rightY + dz * b.rightZ
    const u = body.posY - b.floorY
    const halfW = b.halfWidth
    const wallH = b.wallHeight
    const R = b.archRadius
    const shape = b.shape || 'horseshoe'
    const tol = 0.15 // 轻微越界的贴墙/贴拱正常堆积不误隐
    // 1) 中心越界
    if (shape === 'circular') {
      const cy = u - R
      if (Math.hypot(t, cy) > R + tol) return true
    } else if (shape === 'rectangular') {
      if (Math.abs(t) > halfW + tol || u > wallH + (R || 0) + tol) return true
    } else {
      if (u <= wallH) {
        if (Math.abs(t) > halfW + tol) return true
      } else {
        const cy = u - wallH
        if (Math.hypot(t, cy) > R + tol) return true
      }
    }
    // 2) 低于底板（穿底）：u<0 且 |t|<halfW 时上方判据全部"合法"，
    //    旧版因此对穿底碎片不做任何剔除（巷道下方大片飘浮碎石）。
    if (u < -tol) return true
    // 3) 轴向飞出洞口：隧道壳尽头以外不再显示
    const s = dx * b.forwardX + dy * b.forwardY + dz * b.forwardZ
    if (Math.abs(s) > TUNNEL_HALF_LEN) return true
    // 4) 拱顶尖角探出：AABB 顶面超过净空 + 容差
    const e =
      this._extentTable && spec && spec.variantIndex != null
        ? this._extentTable[spec.variantIndex]
        : null
    if (e) {
      const qx = body.qx || 0
      const qy = body.qy || 0
      const qz = body.qz || 0
      const qw = body.qw == null ? 1 : body.qw
      // 旋转 AABB 沿世界 up=(0,1,0) 的支撑半长
      const c1y = 2 * (qx * qy + qw * qz)
      const c2y = 1 - 2 * (qx * qx + qz * qz)
      const c3y = 2 * (qy * qz - qw * qx)
      const suExact =
        e[0] * spec.dispSize * Math.abs(c1y) +
        e[1] * spec.dispSize * Math.abs(c2y) +
        e[2] * spec.dispSize * Math.abs(c3y)
      const ceil = this._sectionCeiling(t)
      if (ceil != null && u + suExact > ceil + 0.3) return true
    }
    return false
  }

  /**
   * 材质补丁：注入逐实例形状变异（morph）顶点位移。
   *
   * 背景：几何池只有 22 个模板轮廓，同变体实例完全一致 → 爆堆观感"规整"。
   * 通过 aMorph(xyz=噪声种子, w=幅度) 逐实例沿径向做低频噪声鼓包/凹陷：
   *  - 位移只依赖物体空间 position（径向），ConvexGeometry 非索引的重复顶点
   *    位移一致 → 网格不裂面；
   *  - flatShading 用屏幕空间导数求法线，位移后明暗自动跟随，无需重算法线；
   *  - 幅度 ≤ 0.11·maxR：物理碰撞体仍用模板凸包，视觉与碰撞的微差远小于
   *    断面净空容差（0.15m），不参与物理积分。
   * @param {THREE.MeshStandardMaterial} material
   */
  _patchRockMaterial(material) {
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aMorph;')
        .replace(
          '#include <begin_vertex>',
          [
            'vec3 transformed = vec3( position );',
            '{',
            '  float mL = length( position );',
            '  vec3 mDir = mL > 1e-4 ? position / mL : vec3( 0.0 );',
            '  float mN = sin( position.x * 5.3 + aMorph.x ) * sin( position.y * 4.9 + aMorph.y ) * sin( position.z * 5.7 + aMorph.z )',
            '    + 0.5 * sin( position.x * 9.7 + aMorph.y ) * sin( position.y * 10.3 + aMorph.z ) * sin( position.z * 9.1 + aMorph.x );',
            '  transformed += mDir * ( aMorph.w * mN * 0.66 );',
            '}'
          ].join('\n')
        )
    }
    // 固定 program 缓存键：onBeforeCompile 补丁全局一致，避免逐材质重复编译
    material.customProgramCacheKey = () => 'fragment-morph-v1'
  }

  /**
   * 为变体几何写入逐实例 morph 属性（aMorph：xyz=噪声种子，w=幅度）。
   * 几何池为本渲染器独占（createRockGeometryPool 每实例新建）；重播重建时
   * 实例数可能变化：长度一致则原地更新，否则重建 attribute。
   * spec 未携带 morph 参数（旧数据）时全部填 0 → 保持模板原状。
   * @param {THREE.BufferGeometry} geometry
   * @param {Array<{spec:Object}>} group
   */
  _applyMorphAttribute(geometry, group) {
    const arr = new Float32Array(group.length * 4)
    group.forEach(({ spec }, localIdx) => {
      const seed = spec?.morphSeed
      const o = localIdx * 4
      arr[o] = Array.isArray(seed) && Number.isFinite(seed[0]) ? seed[0] : 0
      arr[o + 1] = Array.isArray(seed) && Number.isFinite(seed[1]) ? seed[1] : 0
      arr[o + 2] = Array.isArray(seed) && Number.isFinite(seed[2]) ? seed[2] : 0
      arr[o + 3] = Math.max(0, Number(spec?.morphAmp) || 0)
    })
    const prev = geometry.getAttribute('aMorph')
    if (prev && prev.array.length === arr.length) {
      prev.array.set(arr)
      prev.needsUpdate = true
      return
    }
    if (prev) geometry.deleteAttribute('aMorph')
    geometry.setAttribute('aMorph', new THREE.InstancedBufferAttribute(arr, 4))
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
        flatShading: true,
        vertexColors: true // 启用顶点颜色，使 USE_INSTANCING_COLOR 生效
      })
      this._patchRockMaterial(this.rockMaterial)
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
      this._applyMorphAttribute(geometry, group)
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

  /**
   * 立即将碎片 InstancedMesh 设置到初始位置（循环重播回到 t=0 时使用）。
   * 物理引擎 Worker 异步 init 期间，用初始 positions 直接渲染，
   * 避免碎片停留在爆破后位置造成"动画未重播"的观感。
   * @param {Array<{x:number,y:number,z:number}>} positions - 初始位置
   */
  applyInitialPositions(positions) {
    if (!positions || positions.length === 0) return
    const dummy = this._dummy
    for (const mesh of this.fragmentMeshes) {
      const group = mesh.userData.specs
      if (!group) continue
      let visibleCount = 0
      const fragmentLayerOn = this.layerVisibility.fragment !== false
      for (let localIdx = 0; localIdx < group.length; localIdx++) {
        const bodyIdx = group[localIdx].specIndex
        const spec = group[localIdx].spec
        const pos = bodyIdx < positions.length ? positions[bodyIdx] : null
        if (pos && !this._isOutsideSection(pos, spec)) {
          const dispSize = spec ? spec.dispSize : 0.2
          dummy.position.set(pos.x, pos.y, pos.z)
          dummy.quaternion.identity()
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
      mesh.visible = visibleCount > 0 && fragmentLayerOn
    }
  }

  /** 更新碎片 InstancedMesh（从物理引擎读状态） */
  updateFragmentMesh() {
    const bodyStates = this.physicsEngine.getBodyStates()
    if (!bodyStates || bodyStates.length === 0) return

    const dummy = this._dummy

    for (const mesh of this.fragmentMeshes) {
      const group = mesh.userData.specs
      if (!group) continue
      let visibleCount = 0
      const fragmentLayerOn = this.layerVisibility.fragment !== false

      for (let localIdx = 0; localIdx < group.length; localIdx++) {
        const bodyIdx = group[localIdx].specIndex
        const body = bodyIdx < bodyStates.length ? bodyStates[bodyIdx] : null
        const spec = group[localIdx].spec

        if (body && body.alive && !this._isOutsideSection(body, spec)) {
          const dispSize = spec ? spec.dispSize : body.physSize * 2
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
    // 允许 hi 为 Infinity（"1.0 m+" 区间，无上界），其余情况需为有限数值
    const loOk = Number.isFinite(lo)
    const hiOk = hi === Infinity || Number.isFinite(hi)
    if (!loOk || !hiOk || hi < lo) return

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
        const physSize = Number(group[i]?.spec?.physSizeTrue || group[i]?.spec?.physSize)
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
      mesh.dispose()
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
