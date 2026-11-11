/**
 * 节理网络模型 — 用三组结构面（倾向/倾角/间距）描述岩体的切割形态。
 *
 * 依据：
 *  - 结构面（节理组）控制爆破块度的尺寸与形状：节理间距决定块体三个方向的
 *    尺寸，组间夹角决定块体的棱面形态（胡英国 2024，岩土工程学报；
 *    陶明 2025，爆炸与冲击）。
 *  - Zingg 分类：b/a（伸长率）与 c/b（扁平度）把块体分为等轴块状 / 板状 /
 *    柱状 / 片状四类；本模块用三组节理间距比直接给出这两项比值，替代旧版
 *    "按块度区间硬映射形状类型"的做法。
 */
import { makeRng } from '../utils/rng.js'

const DEG = Math.PI / 180

/** 倾向(dipDirection)/倾角(dip) → 单位法线（y 轴向上，右手系） */
export function normalFromDip(dipDeg, dipDirDeg) {
  const dip = (Number(dipDeg) || 0) * DEG
  const dir = (Number(dipDirDeg) || 0) * DEG
  const s = Math.sin(dip)
  return { x: s * Math.sin(dir), y: Math.cos(dip), z: s * Math.cos(dir) }
}

/**
 * 节理组预设。每组 = { dip, dipDir, spacing, jitter }：
 *  - dip/dipDir：结构面产状（度）
 *  - spacing   ：相对间距（同组相邻结构面距离，决定该方向块体尺寸）
 *  - jitter    ：产状随机扰动幅度（度），模拟节理组的自然离散
 *
 * 三组间距比 = 块体三轴尺寸比，直接对应 Zingg 分类：
 *  - massive  ：近正交等间距 → 等轴块状（真实硬岩爆破主体）
 *  - bedded   ：一组密集水平层理 → 板状（层状岩体）
 *  - columnar ：两组密集竖向节理 → 柱状
 */
export const JOINT_PRESETS = {
  massive: {
    key: 'massive',
    label: '块状（节理稀发）',
    sets: [
      { dip: 4, dipDir: 20, spacing: 1.0, jitter: 8 },
      { dip: 88, dipDir: 25, spacing: 0.95, jitter: 8 },
      { dip: 86, dipDir: 115, spacing: 1.05, jitter: 8 }
    ]
  },
  bedded: {
    key: 'bedded',
    label: '层状（发育水平层理）',
    sets: [
      // 层理间距压到 0.24：扁平度 c/b ≈ 0.21~0.29，稳定落在 Zingg 板状区间(<0.33)
      { dip: 6, dipDir: 0, spacing: 0.24, jitter: 5 },
      { dip: 88, dipDir: 30, spacing: 1.0, jitter: 9 },
      { dip: 85, dipDir: 120, spacing: 1.0, jitter: 9 }
    ]
  },
  columnar: {
    key: 'columnar',
    label: '柱状（两组密集竖向节理）',
    sets: [
      // 两轴压到 0.20/0.22，产状抖动收窄到 4°：伸长率稳定在 0.2~0.3，
      // 几何求交+扰动后仍能保持在 Zingg 柱状区间（<0.33）
      { dip: 6, dipDir: 15, spacing: 1.0, jitter: 4 },
      { dip: 87, dipDir: 20, spacing: 0.2, jitter: 4 },
      { dip: 84, dipDir: 100, spacing: 0.22, jitter: 4 }
    ]
  },
  sheared: {
    key: 'sheared',
    label: '碎裂（多组节理 + 强扰动）',
    sets: [
      // 三轴比落在 0.63~0.71：Zingg 的“不规则”区间，靠大 jitter 增强棱面随机性
      { dip: 35, dipDir: 10, spacing: 0.85, jitter: 18 },
      { dip: 62, dipDir: 75, spacing: 0.6, jitter: 18 },
      { dip: 25, dipDir: 150, spacing: 0.38, jitter: 18 }
    ]
  }
}

/** 把任意输入解成预设对象（支持字符串 key、预设对象或自定义 sets） */
export function resolveJointPreset(preset, rng = Math.random) {
  if (typeof preset === 'string' && JOINT_PRESETS[preset]) return JOINT_PRESETS[preset]
  if (preset && Array.isArray(preset.sets) && preset.sets.length >= 3) return preset
  return JOINT_PRESETS.massive
}

/**
 * 创建一组节理网络实例（每个块体用它切出自己的凸多面体）。
 * @param {{ preset?: string|Object, seed?: number, spacingScale?: number }} options
 * @returns {{ sets: Array<{normal:{x,y,z}, spacing:number}>, presetKey:string, label:string }}
 */
export function createJointNetwork(options = {}) {
  const rng = makeRng(Number(options.seed) || 1)
  const preset = resolveJointPreset(options.preset, rng)
  const scale = Number(options.spacingScale) > 0 ? Number(options.spacingScale) : 1

  const sets = preset.sets.slice(0, 3).map(set => {
    const jitter = Math.max(0, Number(set.jitter) || 0)
    // 产状在组内离散：同一岩体不同位置处的节理面并非完全平行
    const dip = Number(set.dip) + (rng() - 0.5) * 2 * jitter
    const dipDir = Number(set.dipDir) + (rng() - 0.5) * 2 * jitter
    return {
      normal: normalFromDip(dip, dipDir),
      // 间距带 ±12% 的自然变异，避免全部块体尺寸一致
      spacing: Math.max(0.05, Number(set.spacing) * scale * (0.88 + rng() * 0.24))
    }
  })

  return { sets, presetKey: preset.key, label: preset.label }
}

/**
 * 由节理间距比推导块体形状统计（Zingg 分类）。
 * @param {{ sets: Array<{spacing:number}> }} network
 * @returns {{ a:number, b:number, c:number, elongation:number, flatness:number, zingg:string }}
 */
export function deriveShapeStats(network) {
  const raw = (network?.sets || []).slice(0, 3).map(s => Math.max(1e-6, Number(s.spacing) || 1))
  while (raw.length < 3) raw.push(1)
  const sorted = raw.slice().sort((x, y) => y - x) // a ≥ b ≥ c
  const a = sorted[0]
  const b = sorted[1]
  const c = sorted[2]
  const elongation = b / a
  const flatness = c / b
  return {
    a: a / a,
    b: b / a,
    c: c / a,
    elongation,
    flatness,
    zingg: classifyZingg(elongation, flatness)
  }
}

/**
 * Zingg 分类（1935）：以 b/a（伸长率）与 c/b（扁平度）划四类。
 *  - 等轴块状：两项都 > 0.67
 *  - 板状    ：扁平度 < 0.33
 *  - 柱状    ：伸长率 < 0.33
 *  - 片状/过渡：其余
 */
export function classifyZingg(elongation, flatness) {
  if (flatness < 0.33) return 'platy'
  if (elongation < 0.33) return 'columnar'
  if (elongation > 0.67 && flatness > 0.67) return 'blocky'
  return 'irregular'
}

/** 中文名（供 UI / 报告使用）。rounded 由浑圆几何生成器直接指定，不走节理分类 */
export const ZINGG_LABELS = {
  blocky: '等轴块状',
  rounded: '浑圆状',
  platy: '板状',
  columnar: '柱状',
  irregular: '不规则'
}
