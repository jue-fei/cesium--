/**
 * 爆破损伤区可视化渲染器
 *
 * 基于 Holmberg-Persson 模型计算的三区半径，渲染：
 * 1. 三层半透明球壳（粉碎区红 / 裂隙区橙 / 弹性区绿虚线）
 * 2. 沿隧道轴向的纵剖面切片（显示损伤区在岩体内部的延伸）
 * 3. 半径数值标注（Sprite 文字，depthTest=false 防遮挡）
 *
 * 调用方：threeBlastingRenderer.initBlast 后调用 damageZoneRenderer.init({...})，
 * 通过 setLayerVisible('damageZone', true/false) 控制可见性。
 */
import * as THREE from 'three'
import { calculateDamageZones } from '../computation/damageZoneCalculator.js'

export class DamageZoneRenderer {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.visible = false
    this.scene.add(this.group)
    /** @type {{crushedZoneRadius:number, fracturedZoneRadius:number, elasticZoneStart:number}|null} */
    this._zones = null
    this._blastCenter = new THREE.Vector3()
    this._faceNormal = new THREE.Vector3(0, 0, -1)
    this._highlightedZone = null  // 联动高亮：'crushed'|'fractured'|'elastic'|null
  }

  /**
   * 初始化损伤区可视化
   * @param {Object} params
   * @param {number} params.chargeKg - 装药量(kg)
   * @param {number} [params.explosiveDensity=1200] - 炸药密度(kg/m³)
   * @param {number} [params.VoD=4500] - 爆速(m/s)
   * @param {number} [params.rockUCS=120e6] - 岩石单轴抗压强度(Pa)
   * @param {number} [params.rockTensile=10e6] - 岩石抗拉强度(Pa)
   * @param {{x,y,z}} [params.blastCenter] - 爆心世界坐标
   * @param {{x,y,z}} [params.faceNormal] - 掌子面法向量（指向岩体内部，爆破推进方向）
   */
  init(params = {}) {
    this.dispose()
    const {
      chargeKg,
      explosiveDensity = 1200, VoD = 4500,
      rockUCS = 120e6, rockTensile = 10e6,
      blastCenter = { x: 0, y: 0, z: 0 },
      faceNormal = { x: 0, y: 0, z: -1 }
    } = params

    // 计算三区半径
    const zones = calculateDamageZones(chargeKg, { explosiveDensity, VoD, rockUCS, rockTensile })
    this._zones = zones
    this._blastCenter.set(blastCenter.x, blastCenter.y, blastCenter.z)
    this._faceNormal.set(faceNormal.x, faceNormal.y, faceNormal.z).normalize()

    const r1 = zones.crushedZoneRadius
    const r2 = zones.fracturedZoneRadius
    const r3 = r2 * 1.3  // 弹性区示意边界（实际延伸至无穷远）

    // 1. 三层半球壳（仅朝 faceNormal 岩体方向，隧道空腔一侧不渲染）
    this._crushedShell = this._makeShell(r1, 0xff3030, 0.35)
    this._fracturedShell = this._makeShell(r2, 0xff8c00, 0.22)
    this._elasticWire = this._makeWireShell(r3, 0x30ff30)
    this.group.add(this._crushedShell, this._fracturedShell, this._elasticWire)

    // 2. 纵剖面切片（过爆心，含 faceNormal 与 up 的平面，法向量=right）
    this._buildCrossSection(r1, r2, r3)

    // 3. 半径标注
    this._labelCrushed = this._makeLabel(`粉碎区 R1=${r1.toFixed(2)}m`, r1, 0xff5050)
    this._labelFractured = this._makeLabel(`裂隙区 R2=${r2.toFixed(2)}m`, r2, 0xffaa30)
    this.group.add(this._labelCrushed, this._labelFractured)
  }

  /**
   * 创建半透明半球壳（仅朝 faceNormal 岩体方向，排除隧道空腔一侧）
   * SphereGeometry thetaStart=0, thetaLength=π/2 生成上半球（穹顶朝 +Y），
   * 再旋转使穹顶朝向 faceNormal。
   */
  _makeShell(radius, color, opacity) {
    const r = Math.max(0.01, radius)
    // thetaLength=π/2 → 上半球壳
    const geo = new THREE.SphereGeometry(r, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.copy(this._blastCenter)
    // 旋转 +Y → faceNormal，使穹顶朝向岩体内部
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._faceNormal)
    mesh.renderOrder = 5  // 防止被岩体遮挡
    return mesh
  }

  /** 创建线框半球壳（弹性区示意，仅朝 faceNormal 方向） */
  _makeWireShell(radius, color) {
    const r = Math.max(0.01, radius)
    const geo = new THREE.SphereGeometry(r, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.copy(this._blastCenter)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._faceNormal)
    mesh.renderOrder = 5
    return mesh
  }

  /**
   * 构建纵剖面切片：过爆心、含 faceNormal 与 up 的平面
   * 在剖面上绘制三区完整圆盘填充，展示损伤区在岩体内部的延伸
   */
  _buildCrossSection(r1, r2, r3) {
    // 用 Shape 画完整圆盘（在 faceNormal-up 平面内，360°）
    const makeDisc = (radius, color, opacity) => {
      const r = Math.max(0.01, radius)
      const shape = new THREE.Shape()
      shape.absarc(0, 0, r, 0, Math.PI * 2, false)
      const geo = new THREE.ShapeGeometry(shape, 48)
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.copy(this._blastCenter)
      // 旋转：Shape 的 X 轴 → faceNormal，使剖面法向量 = right
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(1, 0, 0), this._faceNormal
      )
      mesh.quaternion.copy(quat)
      mesh.renderOrder = 4
      return mesh
    }

    this._sectionElastic = makeDisc(r3, 0x30ff30, 0.10)
    this._sectionFractured = makeDisc(r2, 0xff8c00, 0.20)
    this._sectionCrushed = makeDisc(r1, 0xff3030, 0.32)
    this.group.add(this._sectionElastic, this._sectionFractured, this._sectionCrushed)
  }

  /** 创建文字标注 Sprite */
  _makeLabel(text, radius, color) {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 80
    const ctx = canvas.getContext('2d')
    const hex = '#' + color.toString(16).padStart(6, '0')
    // 描边 + 填充，确保任意背景下可读
    ctx.font = 'bold 26px Consolas, Microsoft YaHei, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(text, 160, 40)
    ctx.fillStyle = hex
    ctx.fillText(text, 160, 40)
    const tex = new THREE.CanvasTexture(canvas)
    tex.minFilter = THREE.LinearFilter
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    const sprite = new THREE.Sprite(mat)
    sprite.position.copy(this._blastCenter)
    // 标注偏移：沿水平方向 + 上方
    sprite.position.x += radius * 0.9
    sprite.position.y += radius * 0.7
    sprite.scale.set(5, 1.25, 1)
    sprite.renderOrder = 10
    return sprite
  }

  /** 设置可见性 */
  setVisible(visible) {
    this.group.visible = !!visible
  }

  show() { this.setVisible(true) }
  hide() { this.setVisible(false) }

  /** 获取三区半径数据（供 UI 显示） */
  getZones() { return this._zones }

  /** 获取爆心坐标（用于碎片按半径筛选） */
  getBlastCenter() {
    return this._blastCenter ? this._blastCenter.clone() : null
  }

  /** 获取弹性区外半径（r2 * 1.3） */
  getElasticRadius() {
    const z = this._zones
    if (!z) return 0
    return z.fracturedZoneRadius * 1.3
  }

  /**
   * 联动高亮：高亮指定区域，其他区域变暗
   * @param {'crushed'|'fractured'|'elastic'|null} zone - null 表示取消高亮
   */
  highlightZone(zone) {
    this._highlightedZone = zone
    const setOpacity = (mesh, base) => {
      if (!mesh) return
      mesh.material.opacity = base
    }
    // 恢复默认透明度
    const defaults = zone === null
    // 高亮区域提升透明度，非高亮区域保持默认透明度（不变暗）
    setOpacity(this._crushedShell, defaults ? 0.35 : (zone === 'crushed' ? 0.55 : 0.35))
    setOpacity(this._fracturedShell, defaults ? 0.22 : (zone === 'fractured' ? 0.38 : 0.22))
    setOpacity(this._elasticWire, defaults ? 0.25 : (zone === 'elastic' ? 0.45 : 0.25))
    setOpacity(this._sectionCrushed, defaults ? 0.32 : (zone === 'crushed' ? 0.5 : 0.32))
    setOpacity(this._sectionFractured, defaults ? 0.20 : (zone === 'fractured' ? 0.36 : 0.20))
    setOpacity(this._sectionElastic, defaults ? 0.10 : (zone === 'elastic' ? 0.22 : 0.10))
    // 标注：高亮或无高亮时显示，其他保持默认可见
    if (this._labelCrushed) this._setLabelVisible(this._labelCrushed, zone === null || zone === 'crushed')
    if (this._labelFractured) this._setLabelVisible(this._labelFractured, zone === null || zone === 'fractured')
  }

  /** 控制标注 Sprite 的可见性（联动高亮时隐藏非高亮标注） */
  _setLabelVisible(sprite, visible) {
    if (sprite && sprite.material) sprite.material.opacity = visible ? 1.0 : 0.2
  }

  /** 释放资源 */
  dispose() {
    this.group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose()
        obj.material.dispose()
      }
    })
    while (this.group.children.length) {
      this.group.remove(this.group.children[0])
    }
    this._zones = null
    this._highlightedZone = null
  }
}

export default DamageZoneRenderer
