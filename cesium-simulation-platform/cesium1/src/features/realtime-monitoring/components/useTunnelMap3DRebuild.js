/**
 * useTunnelMap3DRebuild.js —— 巷道三维场景内容构建（TunnelMap3D 专用 composable）
 *
 * 职责：
 *   - 2D 布局坐标 → 三维坐标映射（to3/nodeAt/routePt3，含开采水平平面错位与层深）
 *   - rebuild()：按 props 整体重建场景内容——分层巷道段（风险配色+编号标签+选中高亮）、
 *     节点标记（采矿点/出口高亮球与光晕）、层间竖井贯通、主井/地表卸载台、
 *     派送路线（按采场着色）与方向箭头、巡游设备、XYZ 坐标轴
 *   - 几何/材质工厂与巷道风险着色：tubeBetween / tunnelBody / buildEquipment / laneColor
 *   - 逐帧更新（注册给 useTunnelMap3DScene 渲染循环）：设备发光脉冲与沿线巡游、
 *     方向箭头沿各自线段单向流动
 */
import * as THREE from 'three'
import { computed } from 'vue'
import { DEFAULT_VIEW_BOX, deriveRiserMeta } from '../services/undergroundLayout.js'
import { riskScore, riskColor, baseRiskScore } from '../services/riskUtils.js'

// —— 坐标映射调参常量（数值与拆分前字面量一致） ——
const VIEW_SCALE = 1.15 // 2D 布局 → 三维坐标的整体缩放
const VIEW_CENTER_OFFSET_X = 10 // 布局中心向 X 方向的偏移（米）
const VIEW_CENTER_OFFSET_Y = 5 // 布局中心向 Z 方向的偏移（米）

// —— 巷道段渲染调参常量 ——
const LANE_RADIUS_TOP = 1.5 // 顶层巷道管半径
const LANE_RADIUS_DEEP = 1.2 // 深层巷道管半径
const RISER_RADIUS = 1.8 // 层间竖井管半径
const LANE_OPACITY_TOP = 0.45 // 顶层巷道主体透明度（所有图层中最透明，仅作风险着色背景）
const LANE_OPACITY_DEEP = 0.35 // 深层巷道主体透明度
const RISER_OPACITY_TOP = 0.42 // 顶层竖井透明度
const RISER_OPACITY_DEEP = 0.34 // 深层竖井透明度
const ROUTE_TUBE_RADIUS = 1.6 // 派送路线管半径
const ROUTE_TUBE_OPACITY = 0.65 // 派送路线管透明度（介于箭头与巷道之间）
const ARROW_SPACING_M = 9 // 方向箭头沿线放置间距（米）
const ROCK = '#7f8ca0' // 主井外壁岩石色
const ACTIVE_HALO = '#FFD93D' // 选中段外圈高亮光晕（亮黄）
const ACTIVE_COLOR = '#FFF3B0' // 选中段内层高亮管（亮黄白）
const ROUTE_GLOW = '#FFD93D' // 无采场归属时的路线默认色（半透明亮黄）

// —— 风险评分调参口径（与 services/riskUtils.js 的评分体系衔接） ——
const GLOW_SCORE_MIN = 32 // 综合评分达到该值才叠加发光描边
const GRADE_EXCESS_THRESHOLD = 8 // 坡度超过该百分比才计惩罚
const GRADE_EXCESS_WEIGHT = 1.2 // 坡度惩罚权重（分/%）
const WIDTH_MIN_M = 4.5 // 净宽低于该值（米）才计惩罚
const WIDTH_PENALTY_WEIGHT = 6 // 净宽惩罚权重（分/m）

// —— 动画调参常量 ——
const EQUIP_MOVE_SPEED = 8 // 设备巡游速度（路线单位/秒，往返折返）
const ARROW_FLOW_SPEED = 8 // 方向箭头流速（路线单位/秒）
const PULSE_SPEED = 3.2 // 发光脉冲角速度
const PULSE_PHASE_STEP = 1.3 // 相邻设备脉冲相位差
const HALO_OPACITY_BASE = 0.16 // 光晕透明度下限
const HALO_OPACITY_SWING = 0.18 // 光晕透明度起伏幅度
const HALO_SCALE_SWING = 0.18 // 光晕缩放起伏幅度
const RING_OPACITY_BASE = 0.35 // 光环透明度下限
const RING_OPACITY_SWING = 0.3 // 光环透明度起伏幅度

export function useTunnelMap3DRebuild({ props, levels, sceneApi, labels }) {
  const LAYERS = computed(() => levels.value.map(l => l.y))
  const TOP = computed(() => LAYERS.value[0]) // 主水平（真实数据/设备/派送路线所在操作水平）

  // 场景内容登记表（每次 rebuild 整体清空重建）
  let segBores = [],
    nodeBalls = [],
    equipGroups = [],
    routesMeshes = [],
    routeArrows = []

  // 2D 布局坐标 → 三维坐标：偏移与缩放由场景配置 viewBox 自适应（不写死 185/145）
  function to3(mx, my, y) {
    const vb = props.viewBox || DEFAULT_VIEW_BOX
    const cx = vb.x + vb.width / 2 - VIEW_CENTER_OFFSET_X
    const cy = vb.y + vb.height / 2 - VIEW_CENTER_OFFSET_Y
    return new THREE.Vector3((mx - cx) * VIEW_SCALE, y, (my - cy) * VIEW_SCALE)
  }
  // 某节点在指定开采水平上的三维坐标（含该层平面错位）
  function nodeAt(id, li) {
    const n = props.nodes[id]
    if (!n) return null
    const lv = levels.value[li]
    if (!lv) return null
    return to3(n.x + lv.shift.x, n.y + lv.shift.z, lv.y)
  }

  // 统一巷道段着色：评分口径与详情标签一致（见 services/riskUtils.js），
  // 有实测数据用实测评分；无数据时用同一份 baseRiskScore 兜底，保证评分↔颜色严格对应
  function laneColor(m, li, idA, idB) {
    if (m && m.blocked) return { color: '#F43F5E', glow: '#F43F5E' } // 封锁=100 极高危险（红）
    let score = null
    if (
      m &&
      (m.passableLoaded === false ||
        m.rockburst != null ||
        m.congestion != null ||
        m.smoke != null ||
        m.maxGradePct != null ||
        m.clearWidthM != null)
    ) {
      score = riskScore(m)
    }
    if (score == null) {
      score = baseRiskScore(idA, idB, li, {
        activity: levels.value[li]?.activity,
        nLevels: LAYERS.value.length
      })
      if (m) {
        if (m.maxGradePct != null)
          score += Math.max(0, m.maxGradePct - GRADE_EXCESS_THRESHOLD) * GRADE_EXCESS_WEIGHT
        if (m.clearWidthM != null && m.clearWidthM < WIDTH_MIN_M)
          score += (WIDTH_MIN_M - m.clearWidthM) * WIDTH_PENALTY_WEIGHT
      }
      score = Math.min(100, Math.round(score))
    }
    const color = riskColor(score)
    return { color, glow: score >= GLOW_SCORE_MIN ? color : null }
  }

  function tubeBetween(a, b, radius, hex, opacity, emissiveHex, emissiveIntensity) {
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    const mat = new THREE.MeshStandardMaterial({
      color: hex,
      transparent: true,
      opacity,
      roughness: 0.55,
      metalness: 0.25
    })
    if (emissiveHex) {
      mat.emissive = new THREE.Color(emissiveHex)
      mat.emissiveIntensity = emissiveIntensity || 0.4
    }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10, 1, true), mat)
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
    mesh.position.copy(mid)
    if (len > 0.0001)
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    return mesh
  }

  // 巷道主体：用【浅色 + 半透明】渲染风险评级颜色，既保留清晰的评级色相，又避免过于厚重
  function tunnelBody(a, b, radius, hex, glowHex, opacity = 1) {
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    const mat = new THREE.MeshStandardMaterial({
      color: hex,
      transparent: true,
      opacity,
      roughness: 0.5,
      metalness: 0.15
    })
    if (glowHex) {
      mat.emissive = new THREE.Color(glowHex)
      mat.emissiveIntensity = 0.55
    }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 14, 1, true), mat)
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
    mesh.position.copy(mid)
    if (len > 0.0001)
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    return mesh
  }

  function buildEquipment(color) {
    const g = new THREE.Group()
    // 车身带自发光（井下暗环境中高亮），保证移动设备一眼可见
    const body = () =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.5,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.9
      })
    const tire = new THREE.MeshStandardMaterial({ color: '#1f2430', roughness: 0.9 })
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 6), body())
    chassis.position.y = 1.8
    g.add(chassis)
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.4, 1.6),
      new THREE.MeshStandardMaterial({ color: '#e8edf2', roughness: 0.4 })
    )
    cab.position.set(0, 3.2, 2)
    g.add(cab)
    const bucket = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 1.6), body())
    bucket.position.set(0, 1.4, -3.2)
    bucket.rotation.x = 0.35
    g.add(bucket)
    for (const [sx, sz] of [
      [1.9, 1.8],
      [-1.9, 1.8],
      [1.9, -1.8],
      [-1.9, -1.8]
    ]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.7, 16), tire)
      w.rotation.z = Math.PI / 2
      w.position.set(sx, 1.05, sz)
      g.add(w)
    }
    // 高亮发光光晕：半透明叠加球体包裹设备，随设备移动并脉冲闪烁
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(5.4, 20, 20),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    )
    halo.position.y = 2.4
    g.add(halo)
    g.userData.halo = halo
    // 顶部高亮光环（环形光带，增强"移动中"的指示感）
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.8, 3.6, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 4.8
    g.add(ring)
    g.userData.ring = ring
    return g
  }

  // 路由点按其所处开采水平真实落位：x/z 带该层平面错位，y 用该层深度
  function routePt3(pt) {
    const lv = levels.value[pt.level] || levels.value[0]
    return to3(pt.x + lv.shift.x, pt.y + lv.shift.z, lv.y)
  }

  function pickEquipPos(i) {
    const r = props.routes[i]
    // 无路线的设备不生成初始位置（返回 null，调用方跳过渲染），
    // 避免没有派送方案的铲运机被错误地丢到地图中心(0, 顶层, 0)悬空。
    if (!r || !r.length) return null
    const pts = r.map(pt => routePt3(pt))
    return { pos: pts[0], route: pts }
  }

  // 逐帧更新：设备发光脉冲 + 沿路线巡游、方向箭头沿段流动（由场景渲染循环每帧调用）
  function updateFrame(time) {
    equipGroups.forEach((g, i) => {
      // 高亮发光脉冲：光晕/光环随正弦起伏，强化"移动中"的指示（每台错相位闪烁）
      const pulse = 0.5 + 0.5 * Math.sin(time * PULSE_SPEED + i * PULSE_PHASE_STEP)
      if (g.userData.halo) {
        g.userData.halo.material.opacity = HALO_OPACITY_BASE + HALO_OPACITY_SWING * pulse
        g.userData.halo.scale.setScalar(1 + HALO_SCALE_SWING * pulse)
      }
      if (g.userData.ring) {
        g.userData.ring.material.opacity = RING_OPACITY_BASE + RING_OPACITY_SWING * pulse
      }
      const route = g.userData.route || []
      if (route.length < 2) return
      const span = route.length - 1
      let total = 0
      for (let k = 1; k <= span; k++) total += route[k].distanceTo(route[k - 1])
      if (total <= 0) return
      let d = (time * EQUIP_MOVE_SPEED) % total
      const fwd = Math.floor((time * EQUIP_MOVE_SPEED) / total) % 2 === 0
      if (!fwd) d = total - d
      let acc = 0
      for (let k = 1; k <= span; k++) {
        const segL = route[k].distanceTo(route[k - 1])
        if (acc + segL >= d) {
          const f = segL > 0 ? Math.max(0, Math.min(1, (d - acc) / segL)) : 0
          g.position.copy(route[k - 1].clone().lerp(route[k], f))
          if (segL > 0.001) {
            const dir = new THREE.Vector3().subVectors(route[k], route[k - 1]).normalize()
            g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
          }
          break
        }
        acc += segL
      }
    })
    // 派送道路方向箭头：位于隧道内部轴心，沿各自线段按 pa→pb 单向循环流动，透明道路管可透视，清晰指示行进方向
    routeArrows.forEach(a => {
      const segLen = a.a.distanceTo(a.b)
      if (segLen <= 0) return
      const d = (time * ARROW_FLOW_SPEED + a.off) % segLen
      a.mesh.position.copy(a.a.clone().lerp(a.b, d / segLen))
    })
  }

  function rebuild() {
    const scene = sceneApi.getScene()
    if (!scene) return

    for (const m of segBores) scene.remove(m)
    for (const b of nodeBalls) scene.remove(b)
    for (const g of equipGroups) scene.remove(g)
    for (const m of routesMeshes) scene.remove(m)
    for (const a of routeArrows) scene.remove(a.mesh)
    labels.resetLabels()
    segBores = []
    nodeBalls = []
    equipGroups = []
    routesMeshes = []
    routeArrows = []

    // —— 层间斜井/竖向通道：与普通巷道段一致渲染（风险配色 + 编号标签 + 可点击信息）——
    //    颜色用 deriveRiserMeta 推导的同一份安全参数上色，保证 3D 颜色与详情面板评分严格一致
    const drawRiser = (pa, pb, node, li) => {
      const rid = `VERT-${node}-${li + 1}`
      const meta = deriveRiserMeta(rid) || {}
      const rc = laneColor(meta, li, node, node)
      const body = tunnelBody(
        pa,
        pb,
        RISER_RADIUS,
        rc.color,
        rc.glow,
        li === 0 ? RISER_OPACITY_TOP : RISER_OPACITY_DEEP
      )
      body.userData.segId = rid
      body.userData.isRiser = true
      scene.add(body)
      segBores.push(body)
      // 竖井编号标签（与其他巷道段的编号标注一致，点击可查）
      const mid = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5)
      const label = labels.makeLabel(`竖井·${node}`, 'lbl lbl-seg lbl-riser')
      label.position.copy(mid)
      scene.add(label)
      labels.registerLabel(label, true)
    }

    // —— 在某开采水平上绘制一条巷道段：任一层任一段都可点击、携带专属段信息 ——
    //    巷道主体直接用风险评级颜色渲染，使每条巷道一眼就能看出它的风险评级颜色；
    //    中风险以上再外圈叠加一个半透明发光光晕，让高危险巷道更醒目。
    // 选中段高亮：粗体亮黄 + 外圈高亮光晕，一眼就能看到选中的巷道
    function drawActiveHighlight(a, b, li) {
      const radius = li === 0 ? 2.1 : 1.7
      // 外圈高亮光晕（亮黄色，半透明）
      const halo = new THREE.Mesh(
        new THREE.CylinderGeometry(radius + 0.35, radius + 0.35, a.distanceTo(b), 18, 1, true),
        new THREE.MeshBasicMaterial({
          color: ACTIVE_HALO,
          transparent: true,
          opacity: li === 0 ? 0.55 : 0.4,
          depthWrite: false
        })
      )
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
      halo.position.copy(mid)
      const dir = new THREE.Vector3().subVectors(b, a)
      if (dir.length() > 0.0001)
        halo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
      halo.renderOrder = 4
      // 内层高亮管（亮黄白，强自发光）
      const inner = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 18, 1, true),
        new THREE.MeshBasicMaterial({ color: ACTIVE_COLOR, transparent: true, opacity: 0.95 })
      )
      inner.position.copy(mid)
      if (dir.length() > 0.0001)
        inner.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
      inner.renderOrder = 5
      scene.add(halo, inner)
      segBores.push(halo, inner)
    }

    const drawLane = (a, b, li, color, segId, glow, segLabel) => {
      const radius = li === 0 ? LANE_RADIUS_TOP : LANE_RADIUS_DEEP
      // 巷道主体：所有图层中最透明（顶层 0.45 / 深层 0.35），仅作风险着色背景，尽量透亮
      const body = tunnelBody(
        a,
        b,
        radius,
        color,
        glow,
        li === 0 ? LANE_OPACITY_TOP : LANE_OPACITY_DEEP
      )
      if (segId) body.userData.segId = segId // 任何层都支持点击回查段信息
      scene.add(body)
      segBores.push(body)
      // 中风险以上再外圈叠加纯色描边（无自发光、淡透明），让颜色边界锐利、与左下图例一致
      if (glow) {
        const rim = tubeBetween(a, b, radius + 0.15, color, 0.55, null, 0)
        rim.renderOrder = 1
        scene.add(rim)
        segBores.push(rim)
      }
      // 每段都标注【独立编号】（深层稍小、半透明，兼顾可读与画面密度）
      if (segId) {
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
        mid.y += 4
        const labelText = segLabel || String(segId).replace(/^SEG-?/i, '路段')
        const label = labels.makeLabel(
          labelText,
          li === 0 ? 'lbl lbl-seg' : 'lbl lbl-seg lbl-seg-deep'
        )
        label.position.copy(mid)
        scene.add(label)
        labels.registerLabel(label, true)
      }
    }

    // 按开采水平分组巷道段（父组件已为每条分配独立编号与安全配置）
    const byLevel = Array.from({ length: LAYERS.value.length }, () => [])
    for (const s of props.segments) {
      const li = s.level || 0
      if (byLevel[li]) byLevel[li].push(s)
    }

    // 逐水平布网
    const nodePresent = Array.from({ length: LAYERS.value.length }, () => new Set())
    for (let li = 0; li < LAYERS.value.length; li++) {
      for (const s of byLevel[li]) {
        const a = nodeAt(s.aId, li)
        const b = nodeAt(s.bId, li)
        if (!a || !b) continue
        nodePresent[li].add(s.aId)
        nodePresent[li].add(s.bId)
        let color,
          glow = null
        const m = props.metaById[s.id]
        const rc = laneColor(m || null, li, s.aId, s.bId)
        color = rc.color
        glow = rc.glow
        drawLane(a, b, li, color, s.id, glow, s.label)
        if (s.id === props.activeSegId) drawActiveHighlight(a, b, li)
      }
    }

    // —— 节点标记：仅在该水平确实有巷道相邻时才放置（与布网现象配对）——
    //    采矿区(采矿点)/卸载点(出口)用更大的高亮球 + 带区名的醒目标签，一眼定位
    for (const [id, n] of Object.entries(props.nodes)) {
      const col = n.isDump ? '#F56C6C' : n.isMuck ? '#E6A23C' : '#4a7dff'
      const isSpecial = n.isDump || n.isMuck
      for (let li = 0; li < LAYERS.value.length; li++) {
        if (!nodePresent[li].has(id)) continue
        const p = nodeAt(id, li)
        if (!p) continue
        const r = li === 0 ? (n.isDump ? 4.6 : n.isMuck ? 4.0 : 2.4) : 1.8
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(r, 16, 16),
          new THREE.MeshStandardMaterial({
            color: col,
            emissive: new THREE.Color(col),
            emissiveIntensity: isSpecial ? 1.0 : 0.4,
            roughness: 0.3,
            metalness: 0.2
          })
        )
        ball.position.copy(p)
        scene.add(ball)
        nodeBalls.push(ball)
        // 采矿区/卸载点额外叠加高亮光晕（金色/红色，明显区别于普通交叉节点）
        if (isSpecial) {
          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(r * 1.9, 16, 16),
            new THREE.MeshBasicMaterial({
              color: col,
              transparent: true,
              opacity: 0.2,
              blending: THREE.AdditiveBlending,
              depthWrite: false
            })
          )
          halo.position.copy(p)
          scene.add(halo)
          nodeBalls.push(halo)
        }
      }
      // 采矿区/卸载点标签显示区名（如 "M1 A采场" / "S0 卸载点"），带专属高亮样式。
      // 标签锚定在该节点"实际出现的最浅水平"（即其模型所在位置），
      // 避免深层采场的汉字标签被固定扔到主水平上空、离矿点模型过远。
      let anchorLi = 0
      if (isSpecial) {
        for (let li = 0; li < LAYERS.value.length; li++) {
          if (nodePresent[li].has(id)) {
            anchorLi = li
            break
          }
        }
      }
      const label = labels.makeLabel(
        n.isMuck ? `采矿点·${n.label || id}` : n.isDump ? `出口·${n.label || id}` : id,
        'lbl lbl-node' + (n.isMuck ? ' lbl-muck' : n.isDump ? ' lbl-dump' : '')
      )
      const pTop = nodeAt(id, anchorLi) || nodeAt(id, 0) || to3(n.x, n.y, TOP.value)
      if (pTop) label.position.copy(pTop).add(new THREE.Vector3(0, isSpecial ? 7.5 : 5.2, 0))
      scene.add(label)
      labels.registerLabel(label)
    }

    // —— 层间斜井/竖向通道：对每个节点，在其"实际出现的相邻水平"之间贯通 ——
    //    允许跨层贯通（中间层没有该节点时也照常连接），保证每个水平都真实接入主网络，
    //    避免最深水平因中间层缺段而在 3D 中孤立悬浮。
    const nodeLayers = new Map() // 节点 id → 出现该节点的水平列表（升序）
    for (let li = 0; li < LAYERS.value.length; li++) {
      for (const id of nodePresent[li]) {
        if (!nodeLayers.has(id)) nodeLayers.set(id, [])
        nodeLayers.get(id).push(li)
      }
    }
    for (const [id, list] of nodeLayers) {
      for (let i = 0; i + 1 < list.length; i++) {
        const pa = nodeAt(id, list[i])
        const pb = nodeAt(id, list[i + 1])
        if (pa && pb) drawRiser(pa, pb, id, list[i])
      }
    }

    // —— 主井/提升井：地表井口 → 井底车场 S0（主水平真实节点）的功能性竖向出口 ——
    //    顶端落在地表卸载台，底端精确接到顶层网络里的 S0(井底车场) 节点，
    //    使"井口直达地表"的出口与整个巷道网真实连通（设备到 S0 即到井口）。
    {
      const s0 = props.nodes && props.nodes['S0']
      if (s0) {
        const p0 = to3(s0.x, s0.y, 0)
        const sx = p0.x
        const sz = p0.z
        const topY = LAYERS.value[0] + 44 // 地表井口
        const bottom = nodeAt('S0', 0) || new THREE.Vector3(sx, LAYERS.value[0], sz) // 井底车场
        const pa = new THREE.Vector3(sx, topY, sz)
        const pb = new THREE.Vector3(bottom.x, bottom.y, bottom.z)
        const shell = tubeBetween(pa, pb, 3.0, ROCK, 0.3)
        const core = tubeBetween(pa, pb, 1.8, '#c9a86a', 0.55, '#c9a86a', 0.35)
        scene.add(shell, core)
        segBores.push(shell, core)
        // 提升/下放指示（一束自底向上的淡光，表达竖井实时升降）
        const lift = tubeBetween(pa, pb, 0.7, '#ffe9a8', 0.28, '#c9a86a', 0.6)
        scene.add(lift)
        segBores.push(lift)
        const shaftLbl = labels.makeLabel('主井 · 提升', 'lbl lbl-shaft')
        shaftLbl.position.set(sx + 6, (topY + LAYERS.value[0]) / 2, sz)
        scene.add(shaftLbl)
        labels.registerLabel(shaftLbl, true)
        // 井口/地表标记
        const surfaceBall = new THREE.Mesh(
          new THREE.SphereGeometry(3.0, 16, 16),
          new THREE.MeshStandardMaterial({
            color: '#c9a86a',
            emissive: new THREE.Color('#c9a86a'),
            emissiveIntensity: 0.5,
            roughness: 0.3,
            metalness: 0.4
          })
        )
        surfaceBall.position.set(sx, topY + 4, sz)
        scene.add(surfaceBall)
        nodeBalls.push(surfaceBall)
        // 地表卸载台（环形平台），直观表达"井口直达地表"的可达出口
        const plat = new THREE.Mesh(
          new THREE.CylinderGeometry(7.5, 7.5, 1.0, 24, 1, true),
          new THREE.MeshStandardMaterial({
            color: '#94a3b8',
            transparent: true,
            opacity: 0.35,
            roughness: 0.7,
            side: THREE.DoubleSide
          })
        )
        plat.position.set(sx, topY + 1.5, sz)
        scene.add(plat)
        segBores.push(plat)
        const surfaceLbl = labels.makeLabel('地表 · 卸载/提升井口', 'lbl lbl-surface')
        surfaceLbl.position.set(sx, topY + 9.5, sz)
        scene.add(surfaceLbl)
        labels.registerLabel(surfaceLbl, true)
      }
    }

    // —— 派送路线 + 设备：按路由点所处水平逐段绘制，跨层段以竖井/提升井形式升降 ——
    //    当前帕累托解的道路：半透明亮黄管（透明度 0.65，介于箭头与巷道之间），内部能透出锥形方向箭头
    const routeTube = (a, b, radius, opacity, color) => {
      const g = new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 14, 1, true)
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          color: color || ROUTE_GLOW,
          transparent: opacity < 1,
          opacity,
          depthWrite: false
        })
      )
      m.position.copy(a).add(b).multiplyScalar(0.5)
      const dir = new THREE.Vector3().subVectors(b, a)
      if (dir.length() > 0.0001)
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
      return m
    }
    props.routes.forEach((r, ri) => {
      if (!r || r.length < 2) return
      // 按采场筛选：选中某采场后，仅渲染该采场出矿线；其它采场路线整体隐藏
      //（不再淡化显示，连移动光环锥一并隐藏），保证"只看该采场的帕累托路线"
      const zone = props.routeZones[ri] || ''
      if (props.activeZone && props.activeZone !== zone) return
      const zoneCol = props.zoneColors[zone]
      const routeCol = zoneCol || ROUTE_GLOW
      const pts = r.map(pt => routePt3(pt))
      for (let k = 1; k < pts.length; k++) {
        const pa = pts[k - 1]
        const pb = pts[k]
        const t = routeTube(pa, pb, ROUTE_TUBE_RADIUS, ROUTE_TUBE_OPACITY, routeCol)
        scene.add(t)
        routesMeshes.push(t)
        // 沿段放置方向箭头（高亮发光锥）：白亮核心 + 暖色光晕锥，加法混合增强亮度，
        // 位于隧道（道路管）内部轴心、沿 pa→pb 单向流动
        const len = pa.distanceTo(pb)
        const dir = new THREE.Vector3().subVectors(pb, pa).normalize()
        const count = Math.max(1, Math.round(len / ARROW_SPACING_M))
        const pac = pa.clone()
        const pbc = pb.clone()
        for (let j = 0; j < count; j++) {
          const mesh = new THREE.Group()
          // 白亮核心（近白暖色 + 加法混合 → 高亮发光）
          const core = new THREE.Mesh(
            new THREE.ConeGeometry(1.0, 2.8, 14),
            new THREE.MeshBasicMaterial({
              color: '#FFF9E0',
              transparent: true,
              opacity: 1.0,
              blending: THREE.AdditiveBlending,
              depthWrite: false
            })
          )
          core.renderOrder = 3
          // 外圈暖色光晕锥（更大、半透明，叠加出"发光"效果）
          const glow = new THREE.Mesh(
            new THREE.ConeGeometry(1.9, 4.4, 16),
            new THREE.MeshBasicMaterial({
              color: '#FFC93C',
              transparent: true,
              opacity: 0.55,
              blending: THREE.AdditiveBlending,
              depthWrite: false
            })
          )
          glow.renderOrder = 2
          core.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
          glow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
          mesh.add(core)
          mesh.add(glow)
          scene.add(mesh)
          routeArrows.push({ mesh, a: pac, b: pbc, off: (j / count) * len })
        }
      }
      // 采场出矿线标注：路线起点（采矿区）上方竖一小标签，明确"该色出矿线属于哪个采区"
      if (zone && zoneCol && pts.length) {
        const zl = labels.makeLabel(`${zone} · 出矿线`, 'lbl lbl-zone-route')
        zl.position.copy(pts[0]).add(new THREE.Vector3(0, 12, 0))
        scene.add(zl)
        labels.registerLabel(zl, true)
      }
    })

    props.equipColors.forEach((color, i) => {
      // 选中某采场后，其它采场路线已隐藏：所属设备一并隐藏，避免悬空在隐形路线上
      const eZone = props.routeZones[i] || ''
      if (props.activeZone && props.activeZone !== eZone) return
      const placed = pickEquipPos(i)
      if (!placed) return // 无路线设备不渲染，避免中心空中悬停
      const { pos, route } = placed
      const g = buildEquipment(color)
      g.position.copy(pos)
      g.userData = { route }
      scene.add(g)
      const nameLbl = labels.makeLabel(props.equipNames[i] || `设备${i + 1}`, 'lbl lbl-eq')
      nameLbl.position.set(0, 6.2, 0)
      g.add(nameLbl)
      labels.registerLabel(nameLbl)
      equipGroups.push(g)
    })

    // —— XYZ 坐标轴（原点随场景配置 viewBox / 分层自适应） ——
    if (!scene.getObjectByName('axesHelper')) {
      const ax = to3(0, 0, LAYERS.value[0])
      const axBase = [ax.x, ax.y - 76, ax.z + 17]
      const ah = new THREE.AxesHelper(52)
      ah.position.set(axBase[0], axBase[1], axBase[2])
      ah.name = 'axesHelper'
      scene.add(ah)
      const mk = (dx, dy, dz, text, cls) => {
        const l = labels.makeLabel(text, cls)
        l.position.set(axBase[0] + dx, axBase[1] + dy, axBase[2] + dz)
        scene.add(l)
        labels.registerLabel(l)
      }
      mk(60, 0, 0, 'X', 'lbl lbl-axis axis-x')
      mk(0, 62, 0, 'Y', 'lbl lbl-axis axis-y')
      mk(0, 0, 60, 'Z', 'lbl lbl-axis axis-z')
    }

    sceneApi.setRaycastTargets(segBores.filter(m => m.userData.segId))
    labels.applySegLabels()
  }

  // 注册场景内容构建与逐帧更新（组件 setup 期完成，先于场景 init）
  sceneApi.setSceneContent(rebuild)
  sceneApi.setFrameUpdate(updateFrame)

  return { rebuild }
}
