/**
 * useLodRenderEnhancement.js —— 渲染增强面板（AO / 太阳光照 / 阴影）交互（LodPanel 专用 composable）
 *
 * 持有渲染增强折叠面板的展开态与各效果的参数字段定义（滑杆范围/步长/提示），
 * 负责从 renderEnhancementState 取值、布尔/数值归一与展示格式化；
 * 实际写入仍委托 useLodPanelController 提供的 setRenderEffectParam。
 */
import { ref } from 'vue'

// 步长小于该值视为小数参数（直接取值并保留两位展示），否则按整数取整
const DECIMAL_STEP_THRESHOLD = 1

export function useLodRenderEnhancement({ renderEnhancementState, setRenderEffectParam }) {
  // ---- 渲染增强：折叠面板与参数定义 ----
  const renderOpenIds = ref(['ao'])
  const renderEffectGroups = [
    {
      id: 'ao',
      effectKey: 'ambientOcclusion',
      title: '环境光遮蔽 (AO)',
      icon: '🌑',
      hint: '凹陷与缝隙处变暗，凸显几何细节（最关键）',
      fields: [
        { key: 'intensity', label: '强度', min: 0, max: 6, step: 0.1 },
        { key: 'bias', label: '偏置', min: 0, max: 1, step: 0.01 },
        { key: 'lengthCap', label: '采样半径', min: 0, max: 0.2, step: 0.005 },
        { key: 'stepSize', label: '步长', min: 0.5, max: 4, step: 0.1 },
        { key: 'blurStepSize', label: '模糊步长', min: 0, max: 2, step: 0.01 }
      ]
    },
    {
      id: 'light',
      effectKey: 'lighting',
      title: '太阳光照',
      icon: '☀️',
      hint: '不同朝向面产生明暗对比，增强立体感',
      fields: [
        { key: 'brightness', label: '亮度系数', min: 0.2, max: 2, step: 0.05 },
        {
          key: 'dynamicAtmosphereLighting',
          label: '大气散射',
          type: 'checkbox',
          hint: '工业模型场景建议关闭'
        }
      ]
    },
    {
      id: 'shadow',
      effectKey: 'shadow',
      title: '阴影',
      icon: '🌗',
      hint: '增加深度感与空间层次',
      fields: [
        {
          key: 'size',
          label: '阴影贴图尺寸',
          min: 512,
          max: 4096,
          step: 512,
          options: [512, 1024, 2048, 4096]
        },
        { key: 'darkness', label: '阴影浓度', min: 0, max: 1, step: 0.05 },
        { key: 'softShadows', label: '柔和阴影', type: 'checkbox' }
      ]
    }
  ]

  function getRenderEffectValue(effectKey, paramKey) {
    return renderEnhancementState.config[effectKey]?.[paramKey]
  }

  function onRenderEffectParamChange(effectKey, field, value) {
    let v = value
    if (field.type !== 'checkbox') {
      v = field.step < DECIMAL_STEP_THRESHOLD ? Number(value) : Math.round(Number(value))
    } else {
      v = Boolean(value)
    }
    setRenderEffectParam(effectKey, field.key, v)
  }

  function formatRenderParam(field, value) {
    if (field.type === 'checkbox') return value ? '开' : '关'
    const n = Number(value)
    if (!Number.isFinite(n)) return '0'
    if (field.step < DECIMAL_STEP_THRESHOLD) return n.toFixed(2)
    return String(n)
  }

  return {
    renderOpenIds,
    renderEffectGroups,
    getRenderEffectValue,
    onRenderEffectParamChange,
    formatRenderParam
  }
}
