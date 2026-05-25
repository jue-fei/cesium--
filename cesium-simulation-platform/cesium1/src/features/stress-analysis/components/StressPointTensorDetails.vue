<template>
  <div class="bg-black/10 border border-border-primary rounded-lg p-2">
    <div class="text-xs text-text-muted mb-2">该点应力状态（当前时刻）</div>
    <div class="grid grid-cols-1 gap-x-3 gap-y-1 text-xs min-w-0">
      <div>
        σxx：<span class="font-mono">{{ fmt(details.tensor.sxx) }}</span>
      </div>
      <div>
        σyy：<span class="font-mono">{{ fmt(details.tensor.syy) }}</span>
      </div>
      <div>
        σzz：<span class="font-mono">{{ fmt(details.tensor.szz) }}</span>
      </div>
      <div>
        σxy：<span class="font-mono">{{ fmt(details.tensor.sxy) }}</span>
      </div>
      <div>
        σyz：<span class="font-mono">{{ fmt(details.tensor.syz) }}</span>
      </div>
      <div>
        σzx：<span class="font-mono">{{ fmt(details.tensor.szx) }}</span>
      </div>
      <div>
        σ1：<span class="font-mono">{{ fmt(details.principal.sigma1) }}</span>
      </div>
      <div>
        σ2：<span class="font-mono">{{ fmt(details.principal.sigma2) }}</span>
      </div>
      <div>
        σ3：<span class="font-mono">{{ fmt(details.principal.sigma3) }}</span>
      </div>
      <div>
        p：<span class="font-mono">{{ fmt(details.invariants.mean) }}</span>
      </div>
      <div>
        von Mises：<span class="font-mono">{{ fmt(details.invariants.vonMises) }}</span>
      </div>
      <div>
        τmax：<span class="font-mono">{{ fmt(details.invariants.tauMax) }}</span>
      </div>
      <div>
        σnn：<span class="font-mono">{{ fmt(details.traction.snn) }}</span>
      </div>
      <div>
        τn：<span class="font-mono">{{ fmt(details.traction.tauN) }}</span>
      </div>
    </div>
    <div class="mt-2 text-xs text-text-muted">
      单位：{{ unit }}；方向：方位角 {{ directionAzimuth }}°，倾角 {{ directionDip }}°
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '应力分析点选详情组件' })
defineProps({
  details: { type: Object, required: true },
  fmt: { type: Function, required: true },
  unit: { type: String, default: '' },
  directionAzimuth: { type: [Number, String], required: true },
  directionDip: { type: [Number, String], required: true }
})
</script>
