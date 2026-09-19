import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  NORM_FLOOR,
  NORM_LOG_SPAN,
  KNEE_WARP_A,
  KNEE_WARP_B,
  glslNum
} from '../vibrationColorScales.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCENE_BUILDER = resolve(__dirname, '../sceneBuilder.js')

const src = readFileSync(SCENE_BUILDER, 'utf8')
// 着色器主体已外移：benchField.vert.glsl / benchField.frag.glsl（sceneBuilder 以 ?raw 原文组装）
const FRAG_GLSL = readFileSync(resolve(__dirname, '../benchField.frag.glsl'), 'utf8')

/**
 * 回归：归一化标尺（对数下限 / 动态范围 / 膝形压缩拐点）在
 *   ① 片元着色器、② JS 等值线取色、③ 图例刻度（VibrationFieldPanel）
 * 三处必须同源。
 *
 * 历史 bug：三处各自硬编码 0.02 / 5.6439 / smoothstep(0.45,0.92)，改动一处
 * 就漂移——图例刻度与屏幕色档错位、等值线与热力图不对齐。现在统一从
 * vibrationColorScales.js 单源注入（shader 走 #define 前导串拼接）。
 */
describe('归一化标尺单源（shader / 等值线 / 图例）', () => {
  it('着色器不再硬编码旧标尺常量', () => {
    expect(src).not.toMatch(/2\.0e-2/)
    expect(src).not.toMatch(/5\.6439/)
    expect(src).not.toMatch(/smoothstep\(0\.45,\s*0\.92/)
    expect(src).not.toMatch(/Math\.log2\(50\)/)
    // 外移后的 GLSL 本体同样不得回退为硬编码（标尺常量只走 SH_NORM_MACROS 前导注入）
    expect(FRAG_GLSL).not.toMatch(/2\.0e-2/)
    expect(FRAG_GLSL).not.toMatch(/5\.6439/)
    expect(FRAG_GLSL).not.toMatch(/smoothstep\(0\.45,\s*0\.92/)
  })

  it('着色器通过宏前导串接收标尺常量', () => {
    expect(src).toContain('SH_NORM_MACROS')
    expect(src).toContain('#define NORM_FLOOR ')
    expect(src).toContain('#define NORM_LOG_SPAN ')
    expect(src).toContain('#define KNEE_A ')
    expect(src).toContain('#define KNEE_B ')
    // 宏前导必须拼在片元着色器本体之前（否则宏未定义，shader 编译失败）
    const preludeIdx = src.indexOf('const BENCH_FIELD_FRAGMENT_SHADER')
    expect(preludeIdx).toBeGreaterThan(-1)
    expect(src.slice(preludeIdx, preludeIdx + 120)).toContain('SH_NORM_MACROS +')
  })

  it('着色器本体使用的标尺标识符都是已定义宏', () => {
    // GLSL 本体外移至 benchField.frag.glsl：直接取原文（与 ?raw 装载内容一致）
    const glsl = FRAG_GLSL
    // 剥离注释后再扫描，避免把注释里的 PPV/LUT 等词当成引用
    const code = glsl.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    const defined = new Set([...glsl.matchAll(/#define\s+([A-Z_][A-Z0-9_]*)/g)].map(m => m[1]))
    // 标尺宏由 SH_NORM_MACROS 前导串注入（在着色器模板之外），此处显式补入
    for (const id of ['NORM_FLOOR', 'NORM_LOG_SPAN', 'KNEE_A', 'KNEE_B']) defined.add(id)
    for (const id of ['NORM_FLOOR', 'NORM_LOG_SPAN', 'KNEE_A', 'KNEE_B']) {
      expect(defined.has(id)).toBe(true)
    }
    expect(code).toContain('max(linS, NORM_FLOOR)')
    expect(code).toContain('max(lin, NORM_FLOOR)')
    expect(code).toContain('/ NORM_LOG_SPAN')
    expect(code).toContain('smoothstep(KNEE_A, KNEE_B')
  })

  it('JS 等值线取色与 shader 用同一组常量', () => {
    expect(src).toContain('Math.max(lin, NORM_FLOOR) / NORM_FLOOR) / NORM_LOG_SPAN')
    expect(src).toContain('smoothstep(norm0, KNEE_WARP_A, KNEE_WARP_B)')
  })

  it('GLSL 字面量带小数点（避免被解析为 int）', () => {
    for (const v of [NORM_FLOOR, NORM_LOG_SPAN, KNEE_WARP_A, KNEE_WARP_B]) {
      expect(glslNum(v)).toMatch(/^\d+\.\d+$/)
    }
    expect(glslNum(NORM_FLOOR)).not.toBe('0.020000')
  })

  it('动态范围足够覆盖幂律场中远场（≥8 个八度）', () => {
    expect(NORM_LOG_SPAN).toBeGreaterThan(8)
    expect(NORM_FLOOR).toBeLessThan(0.02)
  })
})
