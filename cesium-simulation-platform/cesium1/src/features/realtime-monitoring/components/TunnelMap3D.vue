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
import { DEFAULT_LEVELS, DEFAULT_VIEW_BOX } from '../services/undergroundLayout.js'
import { useTunnelMap3DLabels } from './useTunnelMap3DLabels.js'
import { useTunnelMap3DScene } from './useTunnelMap3DScene.js'
import { useTunnelMap3DRebuild } from './useTunnelMap3DRebuild.js'

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

// —— 多深度分层：由父组件按场景配置 layout.levels 传入（缺省用 undergroundLayout 兜底），
//    层间再由斜井/联络巷贯通，从而在 X / Y / Z 三个方向都铺满真实可行的道路 ——
const levels = computed(() => (props.levels && props.levels.length ? props.levels : DEFAULT_LEVELS))

// —— 标记管理：巷道旁编号小标签的创建/登记/显隐开关 ——
const labels = useTunnelMap3DLabels()
const { showSegLabels, applySegLabels } = labels

// —— 场景基础设施：创建/渲染循环/射线拾取交互/销毁。
//    生命周期归属保持拆分前时序：composable 不注册钩子，由组件在下方
//    onMounted(+nextTick 后 init)/onBeforeUnmount(dispose) 显式驱动 ——
const scene3d = useTunnelMap3DScene({
  containerEl,
  onSelect: id => emit('select', id),
  onClear: () => emit('clear')
})

// —— 场景内容构建：巷道/节点/竖井/主井/路线/设备/坐标轴（随 props 变化整体重建） ——
const { rebuild } = useTunnelMap3DRebuild({ props, levels, sceneApi: scene3d, labels })

// 右上角设备工作/空闲状态：当前方案给该设备分配了路线(route 非空)=工作中，否则空闲
const equipStatus = computed(() =>
  props.equipNames.map((name, i) => {
    const r = props.routes[i]
    return { name, working: !!r && r.length > 0 }
  })
)

onMounted(() => nextTick(scene3d.init))
onBeforeUnmount(scene3d.dispose)

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
    if (scene3d.isReady()) rebuild()
  },
  { deep: true }
)
</script>

<style scoped src="./tunnelMap3D.css"></style>
<style src="./tunnelMap3DLabels.css"></style>
