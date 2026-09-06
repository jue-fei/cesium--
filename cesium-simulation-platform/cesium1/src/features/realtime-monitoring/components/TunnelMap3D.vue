<template>
  <div ref="containerEl" class="tmap3d">
    <div class="tmap3d-hint">左键旋转 · 滚轮缩放 · 中键拖拽平移 · 点击巷道段查详情</div>
    <div class="tmap3d-axis">
      <span class="axis-x"><i></i>X 水平(东西)</span>
      <span class="axis-y"><i></i>Y 竖向(多层·下深)</span>
      <span class="axis-z"><i></i>Z 水平(南北)</span>
    </div>
    <div class="tmap3d-levels">
      <div v-for="(lv, i) in levels" :key="i" class="lv">
        <span class="lv-idx">L{{ i + 1 }}</span>
        <span class="lv-name">{{ lv.name }}</span>
      </div>
    </div>
    <!-- 巷道旁编号小标签显隐开关（位于小地图旁） -->
    <label class="tmap3d-segtoggle">
      <input v-model="showSegLabels" type="checkbox" @change="applySegLabels" />
      <span>巷道标识</span>
    </label>
    <!-- 巷道风险评价图例：综合风险评分→颜色梯度 -->
    <div class="tmap3d-states">
      <span class="st"><i class="st-dot st-safe"></i>安全</span>
      <span class="st"><i class="st-dot st-low"></i>低风险</span>
      <span class="st"><i class="st-dot st-mid"></i>中风险</span>
      <span class="st"><i class="st-dot st-high"></i>高风险</span>
      <span class="st"><i class="st-dot st-vhigh"></i>极高危险</span>
      <span class="st"><i class="st-dot st-block"></i>封锁/禁行</span>
    </div>
    <!-- 设备工作/空闲状态面板（右上角）：当前方案给该设备分配了路线=工作中，否则空闲 -->
    <div class="tmap3d-devstatus">
      <div class="devstatus-title">设备状态</div>
      <div v-for="(it, i) in equipStatus" :key="i" class="devstatus-item">
        <span class="devstatus-dot" :class="it.working ? 'dev-on' : 'dev-idle'"></span>
        <span class="devstatus-name">{{ it.name }}</span>
        <span class="devstatus-state" :class="it.working ? 'dev-on' : 'dev-idle'">
          {{ it.working ? '工作中' : '空闲' }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { DEFAULT_LEVELS, DEFAULT_VIEW_BOX, deriveRiserMeta } from '../services/undergroundLayout.js'
import { riskScore, riskColor, baseRiskScore } from '../services/riskUtils.js'

const props = defineProps({
  segments: { type: Array, default: () => [] }, // [{id, aId, bId, a:{x,y}, b:{x,y}}]
  nodes: { type: Object, default: () => {} }, // {id:{x,y,isDump,isMuck}}
  metaById: { type: Object, default: () => ({}) },
  routes: { type: Array, default: () => [] },
  routeZones: { type: Array, default: () => [] }, // 与 routes 同序：每条路线所属采场名（''=无）
  zoneColors: { type: Object, default: () => ({}) }, // 采场名 → 颜色（按采场着色出矿线）
  activeZone: { type: String, default: '' }, // 筛选的采场：非空时仅渲染该采场出矿线（其它采场路线及移动光环整体隐藏）
  levels: { type: Array, default: () => [] }, // 三维分层（由场景配置 layout.levels 驱动）
  viewBox: { type: Object, default: () => DEFAULT_VIEW_BOX }, // 2D 布局画布范围
  equipColors: { type: Array, default: () => [] },
  equipNames: { type: Array, default: () => [] },
  activeSegId: { type: String, default: '' }
})
const emit = defineEmits(['select', 'clear'])

const containerEl = ref(null)

// 巷道旁编号小标签显隐开关（控制巷道段/竖井/主井/地表等巷道旁标识）
const showSegLabels = ref(true)
// 已创建的"巷道旁标识"标签对象（供开关批量显隐，设备/节点标签不在此列）
let segLabels = []
function applySegLabels() {
  try {
    for (const l of segLabels) {
      if (l && l.element) l.element.style.visibility = showSegLabels.value ? 'visible' : 'hidden'
    }
  } catch (e) {
    /* 场景未就绪时静默忽略 */
  }
}

// —— 多深度分层：由父组件按场景配置 layout.levels 传入（缺省用 undergroundLayout 兜底），
//    层间再由斜井/联络巷贯通，从而在 X / Y / Z 三个方向都铺满真实可行的道路 ——
const levels = computed(() => (props.levels && props.levels.length ? props.levels : DEFAULT_LEVELS))
const LAYERS = computed(() => levels.value.map(l => l.y))
const TOP = computed(() => LAYERS.value[0]) // 主水平（真实数据/设备/派送路线所在操作水平）

// —— 巷道段现已由父组件按开采水平批量传入：深层每条都带【独立编号 SEG-{层}-{序}
//    与独立安全配置】，这里仅按 level 分组即可，任一层任一段都可点击、携带专属信息 ——

// 右上角设备工作/空闲状态：当前方案给该设备分配了路线(route 非空)=工作中，否则空闲
const equipStatus = computed(() =>
  props.equipNames.map((name, i) => {
    const r = props.routes[i]
    return { name, working: !!r && r.length > 0 }
  })
)

// 2D 布局坐标 → 三维坐标：偏移与缩放由场景配置 viewBox 自适应（不写死 185/145）
function to3(mx, my, y) {
  const vb = props.viewBox || DEFAULT_VIEW_BOX
  const cx = vb.x + vb.width / 2 - 10
  const cy = vb.y + vb.height / 2 - 5
  return new THREE.Vector3((mx - cx) * 1.15, y, (my - cy) * 1.15)
}
// 某节点在指定开采水平上的三维坐标（含该层平面错位）
function nodeAt(id, li) {
  const n = props.nodes[id]
  if (!n) return null
  const lv = levels.value[li]
  if (!lv) return null
  return to3(n.x + lv.shift.x, n.y + lv.shift.z, lv.y)
}

let renderer, css2d, scene, camera, controls, raycaster, mouse, renderLoop, resizeObs
let segBores = [],
  nodeBalls = [],
  equipGroups = [],
  routesMeshes = [],
  routeArrows = [],
  labelObjs = []
let raycastTargets = []

const ROCK = '#7f8ca0'

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
      if (m.maxGradePct != null) score += Math.max(0, m.maxGradePct - 8) * 1.2
      if (m.clearWidthM != null && m.clearWidthM < 4.5) score += (4.5 - m.clearWidthM) * 6
    }
    score = Math.min(100, Math.round(score))
  }
  const color = riskColor(score)
  return { color, glow: score >= 32 ? color : null }
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
  if (len > 0.0001) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
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
  if (len > 0.0001) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  return mesh
}

function makeLabel(text, cls) {
  const div = document.createElement('div')
  div.className = cls
  div.textContent = text
  return new CSS2DObject(div)
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

function rebuild() {
  if (!scene) return

  for (const m of segBores) scene.remove(m)
  for (const b of nodeBalls) scene.remove(b)
  for (const g of equipGroups) scene.remove(g)
  for (const m of routesMeshes) scene.remove(m)
  for (const a of routeArrows) scene.remove(a.mesh)
  for (const l of labelObjs) l.removeFromParent()
  segBores = []
  nodeBalls = []
  equipGroups = []
  routesMeshes = []
  routeArrows = []
  labelObjs = []
  segLabels = []

  // —— 层间斜井/竖向通道：与普通巷道段一致渲染（风险配色 + 编号标签 + 可点击信息）——
  //    颜色用 deriveRiserMeta 推导的同一份安全参数上色，保证 3D 颜色与详情面板评分严格一致
  const drawRiser = (pa, pb, node, li) => {
    const rid = `VERT-${node}-${li + 1}`
    const meta = deriveRiserMeta(rid) || {}
    const rc = laneColor(meta, li, node, node)
    const body = tunnelBody(pa, pb, 1.8, rc.color, rc.glow, li === 0 ? 0.42 : 0.34)
    body.userData.segId = rid
    body.userData.isRiser = true
    scene.add(body)
    segBores.push(body)
    // 竖井编号标签（与其他巷道段的编号标注一致，点击可查）
    const mid = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5)
    const label = makeLabel(`竖井·${node}`, 'lbl lbl-seg lbl-riser')
    label.position.copy(mid)
    scene.add(label)
    labelObjs.push(label)
    segLabels.push(label)
  }

  // —— 在某开采水平上绘制一条巷道段：任一层任一段都可点击、携带专属段信息 ——
  //    巷道主体直接用风险评级颜色渲染，使每条巷道一眼就能看出它的风险评级颜色；
  //    中风险以上再外圈叠加一个半透明发光光晕，让高危险巷道更醒目。
  // 选中段高亮：粗体亮黄 + 外圈高亮光晕，一眼就能看到选中的巷道
  const ACTIVE_HALO = '#FFD93D'
  const ACTIVE_COLOR = '#FFF3B0'
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
    const radius = li === 0 ? 1.5 : 1.2
    // 巷道主体：所有图层中最透明（顶层 0.45 / 深层 0.35），仅作风险着色背景，尽量透亮
    const body = tunnelBody(a, b, radius, color, glow, li === 0 ? 0.45 : 0.35)
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
      const label = makeLabel(labelText, li === 0 ? 'lbl lbl-seg' : 'lbl lbl-seg lbl-seg-deep')
      label.position.copy(mid)
      scene.add(label)
      labelObjs.push(label)
      segLabels.push(label)
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
    const label = makeLabel(
      n.isMuck ? `采矿点·${n.label || id}` : n.isDump ? `出口·${n.label || id}` : id,
      'lbl lbl-node' + (n.isMuck ? ' lbl-muck' : n.isDump ? ' lbl-dump' : '')
    )
    const pTop = nodeAt(id, anchorLi) || nodeAt(id, 0) || to3(n.x, n.y, TOP.value)
    if (pTop) label.position.copy(pTop).add(new THREE.Vector3(0, isSpecial ? 7.5 : 5.2, 0))
    scene.add(label)
    labelObjs.push(label)
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
      const shaftLbl = makeLabel('主井 · 提升', 'lbl lbl-shaft')
      shaftLbl.position.set(sx + 6, (topY + LAYERS.value[0]) / 2, sz)
      scene.add(shaftLbl)
      labelObjs.push(shaftLbl)
      segLabels.push(shaftLbl)
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
      const surfaceLbl = makeLabel('地表 · 卸载/提升井口', 'lbl lbl-surface')
      surfaceLbl.position.set(sx, topY + 9.5, sz)
      scene.add(surfaceLbl)
      labelObjs.push(surfaceLbl)
      segLabels.push(surfaceLbl)
    }
  }

  // —— 派送路线 + 设备：按路由点所处水平逐段绘制，跨层段以竖井/提升井形式升降 ——
  //    当前帕累托解的道路：半透明亮黄管（透明度 0.65，介于箭头与巷道之间），内部能透出锥形方向箭头
  const ROUTE_GLOW = '#FFD93D'
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
      const t = routeTube(pa, pb, 1.6, 0.65, routeCol)
      scene.add(t)
      routesMeshes.push(t)
      // 沿段放置方向箭头（高亮发光锥）：白亮核心 + 暖色光晕锥，加法混合增强亮度，
      // 位于隧道（道路管）内部轴心、沿 pa→pb 单向流动
      const len = pa.distanceTo(pb)
      const dir = new THREE.Vector3().subVectors(pb, pa).normalize()
      const count = Math.max(1, Math.round(len / 9))
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
      const zl = makeLabel(`${zone} · 出矿线`, 'lbl lbl-zone-route')
      zl.position.copy(pts[0]).add(new THREE.Vector3(0, 12, 0))
      scene.add(zl)
      labelObjs.push(zl)
      segLabels.push(zl)
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
    const nameLbl = makeLabel(props.equipNames[i] || `设备${i + 1}`, 'lbl lbl-eq')
    nameLbl.position.set(0, 6.2, 0)
    g.add(nameLbl)
    labelObjs.push(nameLbl)
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
      const l = makeLabel(text, cls)
      l.position.set(axBase[0] + dx, axBase[1] + dy, axBase[2] + dz)
      scene.add(l)
      labelObjs.push(l)
    }
    mk(60, 0, 0, 'X', 'lbl lbl-axis axis-x')
    mk(0, 62, 0, 'Y', 'lbl lbl-axis axis-y')
    mk(0, 0, 60, 'Z', 'lbl lbl-axis axis-z')
  }

  raycastTargets = segBores.filter(m => m.userData.segId)
  applySegLabels()
}

function animate(t) {
  renderLoop = requestAnimationFrame(animate)
  const time = t * 0.001
  equipGroups.forEach((g, i) => {
    // 高亮发光脉冲：光晕/光环随正弦起伏，强化"移动中"的指示（每台错相位闪烁）
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2 + i * 1.3)
    if (g.userData.halo) {
      g.userData.halo.material.opacity = 0.16 + 0.18 * pulse
      g.userData.halo.scale.setScalar(1 + 0.18 * pulse)
    }
    if (g.userData.ring) {
      g.userData.ring.material.opacity = 0.35 + 0.3 * pulse
    }
    const route = g.userData.route || []
    if (route.length < 2) return
    const span = route.length - 1
    let total = 0
    for (let k = 1; k <= span; k++) total += route[k].distanceTo(route[k - 1])
    if (total <= 0) return
    let d = (time * 8) % total
    const fwd = Math.floor((time * 8) / total) % 2 === 0
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
    const d = (time * 8 + a.off) % segLen
    a.mesh.position.copy(a.a.clone().lerp(a.b, d / segLen))
  })
  controls && controls.update()
  renderer.render(scene, camera)
  css2d.render(scene, camera)
}

function init() {
  const el = containerEl.value
  const w = el.clientWidth
  const h = el.clientHeight || 340

  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0a0f18')
  scene.fog = new THREE.Fog('#0a0f18', 520, 1100)

  camera = new THREE.PerspectiveCamera(44, w / h, 0.5, 1400)
  camera.position.set(200, 100, 240)
  camera.lookAt(0, -15, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  el.insertBefore(renderer.domElement, el.firstChild)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'

  css2d = new CSS2DRenderer()
  css2d.setSize(w, h)
  css2d.domElement.style.position = 'absolute'
  css2d.domElement.style.inset = '0'
  css2d.domElement.style.pointerEvents = 'none'
  el.insertBefore(css2d.domElement, renderer.domElement.nextSibling)

  scene.add(new THREE.AmbientLight('#9fb3c8', 0.95))
  const key = new THREE.DirectionalLight('#ffffff', 1.2)
  key.position.set(200, 320, 140)
  scene.add(key)
  const fill = new THREE.DirectionalLight('#6aa3ff', 0.5)
  fill.position.set(-200, 60, -140)
  scene.add(fill)
  const warm = new THREE.PointLight('#ffb35c', 0.45, 700)
  warm.position.set(-120, -80, 150)
  scene.add(warm)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.target.set(0, -15, 0)
  controls.maxPolarAngle = Math.PI * 0.6
  // 交互口径：左键旋转，中键拖拽平移（模型在视野中上下左右移动），右键+滚轮缩放
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.DOLLY
  }

  raycaster = new THREE.Raycaster()
  mouse = new THREE.Vector2()
  renderer.domElement.addEventListener('pointermove', onHover)
  renderer.domElement.addEventListener('click', onClick)
  // 抑制中键默认的“自动滚动”光标/滚屏，只把中键交给 OrbitControls 做平移拖拽
  renderer.domElement.addEventListener('mousedown', e => {
    if (e.button === 1) e.preventDefault()
  })

  rebuild()
  animate(performance.now())

  resizeObs = new ResizeObserver(() => {
    const nw = el.clientWidth
    const nh = el.clientHeight || 340
    camera.aspect = nw / nh
    camera.updateProjectionMatrix()
    renderer.setSize(nw, nh)
    css2d.setSize(nw, nh)
  })
  resizeObs.observe(el)
}

function pickPointer(e) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
}
function onHover(e) {
  if (!raycaster) return
  pickPointer(e)
  raycaster.setFromCamera(mouse, camera)
  const hits = raycaster.intersectObjects(raycastTargets, false)
  renderer.domElement.style.cursor = hits.length ? 'pointer' : 'default'
}
function onClick(e) {
  if (!raycaster) return
  pickPointer(e)
  raycaster.setFromCamera(mouse, camera)
  const hits = raycaster.intersectObjects(raycastTargets, false)
  if (hits.length && hits[0].object.userData.segId) emit('select', hits[0].object.userData.segId)
  else emit('clear')
}

function dispose() {
  renderLoop && cancelAnimationFrame(renderLoop)
  resizeObs && resizeObs.disconnect()
  if (renderer) {
    renderer.domElement.removeEventListener('pointermove', onHover)
    renderer.domElement.removeEventListener('click', onClick)
  }
  scene &&
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material)
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose())
    })
  renderer && renderer.dispose()
  if (css2d) css2d.domElement && css2d.domElement.remove()
  renderer = css2d = scene = camera = controls = null
}

onMounted(() => nextTick(init))
onBeforeUnmount(dispose)

watch(
  () => [
    props.segments,
    props.nodes,
    props.routes,
    props.routeZones,
    props.zoneColors,
    props.activeZone,
    props.levels,
    props.viewBox,
    props.equipColors,
    props.equipNames,
    props.metaById,
    props.activeSegId
  ],
  () => {
    if (scene) rebuild()
  },
  { deep: true }
)
</script>

<style scoped>
.tmap3d {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 340px;
  border-radius: 10px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  background: linear-gradient(180deg, #0a0f18 0%, #101a2b 100%);
}
.tmap3d-hint {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  z-index: 3;
  font-size: 10px;
  color: rgba(148, 163, 184, 0.55);
  pointer-events: none;
  white-space: nowrap;
}
.tmap3d-axis {
  position: absolute;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 9px;
  color: #94a3b8;
  pointer-events: none;
  background: rgba(10, 15, 24, 0.6);
  padding: 3px 6px;
  border-radius: 6px;
}
.tmap3d-axis span {
  display: flex;
  align-items: center;
  gap: 4px;
  letter-spacing: 0.02em;
}
.tmap3d-axis i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  display: inline-block;
}
.axis-x i {
  background: #ff3b30;
}
.axis-y i {
  background: #30d158;
}
.axis-z i {
  background: #0a84ff;
}
.tmap3d-states {
  position: absolute;
  left: 8px;
  bottom: 6px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 10px;
  color: #cbd5e1;
  pointer-events: none;
  background: rgba(10, 15, 24, 0.62);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  line-height: 1.4;
}
.tmap3d-states .st {
  display: flex;
  align-items: center;
  gap: 5px;
}
.tmap3d-segtoggle {
  position: absolute;
  left: 108px;
  top: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: #cbd5e1;
  cursor: pointer;
  background: rgba(10, 15, 24, 0.62);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  user-select: none;
}
.tmap3d-segtoggle input {
  accent-color: #4a9eff;
  cursor: pointer;
}
.tmap3d-devstatus {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  min-width: 150px;
  background: rgba(10, 15, 24, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 11px;
  color: #cbd5e1;
  user-select: none;
}
.tmap3d-devstatus .devstatus-title {
  font-weight: 700;
  font-size: 11px;
  color: #e6edf5;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  padding-bottom: 4px;
  margin-bottom: 4px;
}
.tmap3d-devstatus .devstatus-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.tmap3d-devstatus .devstatus-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.devstatus-dot.dev-on {
  background: #34d399;
  box-shadow: 0 0 6px #34d399;
}
.devstatus-dot.dev-idle {
  background: #64748b;
}
.tmap3d-devstatus .devstatus-name {
  flex: 1;
  color: #e6edf5;
}
.tmap3d-devstatus .devstatus-state {
  font-weight: 600;
}
.devstatus-state.dev-on {
  color: #34d399;
}
.devstatus-state.dev-idle {
  color: #94a3b8;
}
.st-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}
.st-safe {
  background: #4ade80;
}
.st-low {
  background: #a3e635;
}
.st-mid {
  background: #fbbf24;
}
.st-high {
  background: #fb923c;
}
.st-vhigh {
  background: #f43f5e;
}
.st-block {
  background: #f43f5e;
}
.lbl-shaft {
  color: #e8c98a;
  background: rgba(60, 46, 12, 0.75);
  border: 1px solid #c9a86a;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.lbl-surface {
  color: #d9f99d;
  background: rgba(30, 43, 10, 0.78);
  border: 1px solid #a3e635;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.tmap3d-levels {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10.5px;
  color: #cbd5e1;
  pointer-events: none;
  background: rgba(10, 15, 24, 0.62);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  line-height: 1.3;
}
.tmap3d-levels .lv {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lv-idx {
  font-weight: 700;
  color: #0a0f18;
  background: linear-gradient(135deg, #6aa3ff, #4a9eff);
  font-size: 9px;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 1.4;
}
.tmap3d-levels .lv:nth-child(1) .lv-idx {
  background: linear-gradient(135deg, #7dd3fc, #38bdf8);
}
.tmap3d-levels .lv:nth-child(2) .lv-idx {
  background: linear-gradient(135deg, #6ee7b7, #34d399);
}
.tmap3d-levels .lv:nth-child(3) .lv-idx {
  background: linear-gradient(135deg, #fcd34d, #f59e0b);
}
.tmap3d-levels .lv:nth-child(4) .lv-idx {
  background: linear-gradient(135deg, #fb923c, #f97316);
}
.tmap3d-levels .lv:nth-child(5) .lv-idx {
  background: linear-gradient(135deg, #f87171, #ef4444);
}
</style>

<style>
.lbl {
  color: #e6edf5;
  background: rgba(10, 15, 24, 0.72);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  border: 1px solid rgba(148, 163, 184, 0.28);
  pointer-events: none;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}
.lbl-node {
  font-weight: 700;
  background: rgba(10, 15, 24, 0.82);
}
/* 采矿区（采矿点）标签：金色高亮发光 */
.lbl-muck {
  color: #ffd77a;
  font-size: 12.5px;
  background: rgba(46, 32, 4, 0.85);
  border: 1px solid rgba(255, 201, 87, 0.75);
  box-shadow:
    0 0 8px rgba(255, 190, 60, 0.45),
    0 0 16px rgba(255, 190, 60, 0.25);
}
/* 出口（卸载点/井口）标签：红色高亮发光 */
.lbl-dump {
  color: #ffb4a8;
  font-size: 12.5px;
  background: rgba(56, 12, 8, 0.85);
  border: 1px solid rgba(255, 129, 117, 0.75);
  box-shadow:
    0 0 8px rgba(255, 99, 88, 0.45),
    0 0 16px rgba(255, 99, 88, 0.25);
}
/* 竖井/斜井（上下层连接段）标签：与普通段同风格，虚边区分竖向连接 */
.lbl-riser {
  color: #b8c7dd;
  background: rgba(18, 26, 40, 0.82);
  border: 1px dashed rgba(148, 163, 184, 0.6);
  font-size: 11px;
}
.lbl-seg {
  font-size: 11px;
  color: #cbd5e1;
  opacity: 0.92;
}
/* 采场出矿线标签：采场色描边，标识"该色路线属于哪个采区" */
.lbl-zone-route {
  font-size: 11.5px;
  font-weight: 700;
  color: #ffd77a;
  background: rgba(20, 24, 34, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
}
.lbl-seg-deep {
  font-size: 9.5px;
  color: #8fa3bd;
  opacity: 0.62;
}
.lbl-eq {
  color: #ffd77a;
  font-weight: 700;
  background: rgba(25, 18, 4, 0.78);
  border-color: rgba(255, 215, 122, 0.45);
}
.lbl-axis {
  font-weight: 700;
  background: transparent;
  border: none;
  font-size: 13px;
}
.lbl-axis.axis-x {
  color: #ff6b5e;
}
.lbl-axis.axis-y {
  color: #4cd964;
}
.lbl-axis.axis-z {
  color: #4a9eff;
}
</style>
