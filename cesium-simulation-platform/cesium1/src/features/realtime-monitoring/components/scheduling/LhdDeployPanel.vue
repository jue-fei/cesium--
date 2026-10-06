<template>
  <div class="deploy-panel">
    <div class="dp-head">
      <span class="dp-title">拖拽式设备部署 · 工序调整</span>
      <span class="dp-badge">3.2</span>
    </div>

    <!-- 部署清单：真源 config/deployments/<场景>.json，拖拽落点即保存 -->
    <div class="dp-sec">
      <div class="dp-sec-title">设备待命点（拖拽设备到巷道节点即部署保存）</div>
      <div v-for="e in equipmentItems" :key="e.id" class="dp-row">
        <span class="dp-name">{{ cnName(e.id) }}</span>
        <span v-if="deployments[e.id]" class="dp-node">
          {{ deployments[e.id].node }} · L{{ (deployments[e.id].level ?? 0) + 1 }} 水平
        </span>
        <span v-else class="dp-node dp-node-live">未部署 · 按实时位置</span>
      </div>
    </div>

    <!-- 出矿工序优先级：顺序即贪心派单偏置（靠前优先），可上下调整 -->
    <div class="dp-sec">
      <div class="dp-sec-title">出矿工序优先级（靠前优先 · 保存后即刻生效）</div>
      <div v-for="(mid, i) in orderView" :key="mid" class="dp-row dp-order-row">
        <span class="dp-rank" :class="{ 'dp-rank-top': i === 0 }">{{ i + 1 }}</span>
        <span class="dp-name">{{ muckLabel(mid) }}</span>
        <span class="dp-ops">
          <button :disabled="i === 0 || saving" title="提高优先级" @click="move(i, -1)">↑</button>
          <button :disabled="i === orderView.length - 1 || saving" title="降低优先级" @click="move(i, 1)">↓</button>
        </span>
      </div>
      <div class="dp-actions">
        <button class="dp-save" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : dirty ? '保存工序' : '与真源一致' }}
        </button>
      </div>
    </div>

    <div v-if="status" class="dp-status">{{ status }}</div>
  </div>
</template>

<script setup>
/**
 * LhdDeployPanel.vue —— 拖拽式设备部署与出矿工序调整的侧栏面板（3.2）
 *
 * 数据流：部署/工序真源在后端（config/deployments/<场景>.json），本面板只做展示与
 * 工序顺序的本地编辑；拖拽落点保存由父组件（MultiObjectiveLhdView）调 PUT /api/deployment
 * 完成，保存成功后 deployments/processOrder props 刷新回显。
 */
import { computed, ref, watch } from 'vue'

const props = defineProps({
  equipmentItems: { type: Array, default: () => [] }, // [{id, name, state, node, level}]
  deployments: { type: Object, default: () => ({}) }, // {equipId:{node,level}}
  processOrder: { type: Array, default: () => [] }, // 出矿工序优先级（muck id 列表）
  muckPoints: { type: Array, default: () => [] }, // [{id, zone, gantry, ...}]
  status: { type: String, default: '' },
  busy: { type: Boolean, default: false } // 父组件保存中（拖拽落点/工序保存共用一个状态位）
})
const emit = defineEmits(['save-order'])

// 工序顺序本地工作副本：已排序在前，未列入真源的采矿点按数据序排在后面（仍可被派单，无优先权）
const orderView = computed(() => {
  const rest = props.muckPoints.map(p => p.id).filter(id => !props.processOrder.includes(id))
  return [...props.processOrder, ...rest]
})

const localOrder = ref([])
const dirty = computed(() => JSON.stringify(localOrder.value) !== JSON.stringify(orderView.value))
const saving = computed(() => props.busy)

watch(
  orderView,
  v => {
    localOrder.value = [...v]
  },
  { immediate: true }
)

function move(i, dir) {
  const arr = [...localOrder.value]
  const j = i + dir
  if (j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  localOrder.value = arr
}

function save() {
  emit('save-order', [...localOrder.value])
}

// 显示名：LHD-01 → 铲运机01（与三维图例口径一致）
function cnName(id) {
  return String(id || '').replace(/^LHD-?/i, '铲运机')
}
// 采矿点显示：M1 · A采场
function muckLabel(mid) {
  const p = props.muckPoints.find(m => m.id === mid)
  return p && p.zone ? `${mid} · ${p.zone}` : mid
}
</script>

<style scoped>
.deploy-panel {
  position: absolute;
  left: 12px;
  bottom: 46px; /* 抬高避开底部图例行 */
  z-index: 5;
  width: 300px;
  max-height: calc(100% - 24px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: rgba(10, 15, 24, 0.92);
  border: 1px solid rgba(250, 204, 21, 0.35);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  font-size: 12px;
  color: #d7e2ee;
}
.dp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dp-title {
  font-weight: 700;
  font-size: 13px;
  color: #facc15;
}
.dp-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  color: #0a0f18;
  background: #facc15;
}
.dp-sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dp-sec-title {
  color: #8fa3b8;
  font-size: 11px;
  margin-bottom: 2px;
}
.dp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 5px;
}
.dp-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.dp-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-node {
  color: #7dd3fc;
  font-size: 11px;
}
.dp-node-live {
  color: #64748b;
}
.dp-rank {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  font-weight: 700;
  color: #cbd5e1;
}
.dp-rank-top {
  background: #facc15;
  color: #0a0f18;
}
.dp-ops {
  display: flex;
  gap: 4px;
}
.dp-ops button {
  width: 22px;
  height: 20px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #d7e2ee;
  cursor: pointer;
  line-height: 1;
}
.dp-ops button:hover:not(:disabled) {
  border-color: #facc15;
  color: #facc15;
}
.dp-ops button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.dp-actions {
  margin-top: 4px;
}
.dp-save {
  width: 100%;
  padding: 5px 0;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #facc15, #f59e0b);
  color: #0a0f18;
  font-weight: 700;
  cursor: pointer;
}
.dp-save:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dp-status {
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(125, 211, 252, 0.1);
  color: #7dd3fc;
  font-size: 11px;
  line-height: 1.5;
}
</style>
