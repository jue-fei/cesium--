import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 热力图"细线/网格伪影"回归守卫（源码守卫，仿 stressFieldDistinct.test.js 模式）。
 *
 * 伪影根因（HEAD 版本）：8Hz 载波相干干涉 × 14 档 floor(norm·bands) 硬量化 ×
 * 8bit LUT NearestFilter —— 中高梯度区档宽 <2px，逐像素档号跳变成像素级细线/
 * 棋盘格，干涉花瓣水平集被切片成放射状细线。修复口径：
 *   1. shader 连续色阶：norm 直接采样 LUT（LinearFilter 在档色间线性插值），
 *      不做 floor 硬量化；
 *   2. LUT 纹理 LinearFilter + ClampToEdge —— **两条创建路径都要设**：
 *      初始创建与 setFieldNormBands 重建（拖"等值线密度"滑块会走重建路径，
 *      漏设则伪影复发）；
 *   3. 不重新引入未接线的档边界/抖动死代码（bandContour/bandCoordAA/
 *      bayerDither4 曾只有定义无调用点，误导排查）。
 */

const testDir = dirname(fileURLToPath(import.meta.url))
// 源码守卫文本：sceneBuilder.js + 外移的着色器主体（benchField.*.glsl，
// 由 sceneBuilder 以 ?raw 原文组装）——着色器断言须覆盖 GLSL 本体
const sceneBuilderSrc = [
  readFileSync(join(testDir, '..', 'sceneBuilder.js'), 'utf8'),
  readFileSync(join(testDir, '..', 'benchField.vert.glsl'), 'utf8'),
  readFileSync(join(testDir, '..', 'benchField.frag.glsl'), 'utf8')
].join('\n')
// useBlasting 已按职责拆分至 useBlastingParts/*：振动场开关（carrierHz/isoLineEnabled）
// 随代码迁移到 vibrationParts.js，守卫文本须覆盖主文件 + 迁移文件
const useBlastingSrc = [
  readFileSync(join(testDir, '..', '..', '..', 'useBlasting.js'), 'utf8'),
  readFileSync(join(testDir, '..', '..', '..', 'useBlastingParts', 'vibrationParts.js'), 'utf8')
].join('\n')
const blastingManagerSrc = readFileSync(
  join(testDir, '..', '..', '..', 'blastingManager.js'),
  'utf8'
)
const fieldPanelSrc = readFileSync(
  join(testDir, '..', '..', '..', '..', 'components', 'VibrationFieldPanel.vue'),
  'utf8'
)

describe('热力图色阶连续化守卫（细线伪影回归）', () => {
  it('shader 直接用连续 norm 采样 LUT，无 floor 硬量化', () => {
    expect(sceneBuilderSrc).toContain('texture(uStressLut, vec2(norm, 0.5))')
    expect(sceneBuilderSrc).toContain('texture(uPpvLut, vec2(iVal, 0.5))')
    // 旧伪影实现：floor(clamp(norm…)*uNormBands) 硬量化 —— 不得回归
    expect(sceneBuilderSrc).not.toMatch(/floor\s*\(\s*clamp\s*\(\s*(norm|iVal)/)
  })

  it('LUT 初始创建与 setFieldNormBands 重建均设 LinearFilter（滑块拖动不复发）', () => {
    // 初始创建路径（材质 uniforms 构造附近）
    const initIdx = sceneBuilderSrc.indexOf('this._fieldPpvLut = new THREE.DataTexture')
    expect(initIdx).toBeGreaterThan(-1)
    const initBlock = sceneBuilderSrc.slice(initIdx, initIdx + 1200)
    expect(initBlock).toContain('LinearFilter')
    expect(initBlock).toContain('ClampToEdgeWrapping')
    // 重建路径（等值线密度滑块 → setFieldNormBands）
    const rebuildIdx = sceneBuilderSrc.indexOf('setFieldNormBands(n)')
    expect(rebuildIdx).toBeGreaterThan(-1)
    const rebuildBlock = sceneBuilderSrc.slice(rebuildIdx, rebuildIdx + 1400)
    expect(rebuildBlock).toContain('LinearFilter')
    expect(rebuildBlock).toContain('ClampToEdgeWrapping')
    // 重建路径重建的是两张 LUT
    expect((rebuildBlock.match(/LinearFilter/g) || []).length).toBeGreaterThanOrEqual(4)
  })

  it('对载波相位欠采样启用屏幕空间 LOD，并保持 peak 判据独立', () => {
    expect(sceneBuilderSrc).toContain('float envelopeSq = 0.0')
    expect(sceneBuilderSrc).toContain('float phaseFootprint = 0.0')
    expect(sceneBuilderSrc).toContain('fwidth(gap)')
    expect(sceneBuilderSrc).toContain('fwidth(gapI)')
    expect(sceneBuilderSrc).toContain('fwidth(wvCarrier * (uSimTime - length(g - uBlastOrigin)')
    expect(sceneBuilderSrc).toContain(
      'float coherentLod = smoothstep(0.35, 3.14159265, phaseFootprint)'
    )
    expect(sceneBuilderSrc).toContain(
      'float faceCleanLod = 1.0 - smoothstep(0.10, 0.55, abs(g.z - uFaceZ))'
    )
    expect(sceneBuilderSrc).toContain(
      'float postFaceCleanLod = 1.0 - smoothstep(0.10, 0.55, abs(g.z - (uFaceZ + uHoleLen)))'
    )
    expect(sceneBuilderSrc).toContain('faceCleanLod = max(faceCleanLod, postFaceCleanLod)')
    expect(sceneBuilderSrc).toContain(
      'float postFaceBlend = 1.0 - smoothstep(0.08, 0.60, abs(g.z - (uFaceZ + uHoleLen)))'
    )
    expect(sceneBuilderSrc).toContain('facePlaneBlend = max(facePlaneBlend, postFaceBlend)')
    expect(sceneBuilderSrc).toContain(
      'vec3 geomN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)))'
    )
    expect(sceneBuilderSrc).toContain('float capSurfaceMask = smoothstep(0.985, 0.9995')
    expect(sceneBuilderSrc).toContain('float capDist = max(length(g - uBlastOrigin), 0.5)')
    expect(sceneBuilderSrc).toContain('mps = mix(mps, capMps, capSurfaceMask)')
    expect(sceneBuilderSrc).toContain('coherentLod = max(coherentLod, faceCleanLod)')
    expect(sceneBuilderSrc).toContain('float wvFinal = max(wv, 0.98 * facePlaneBlend)')
    expect(sceneBuilderSrc).toContain(
      'mps = wvCarrier > 0.0 ? mix(mps, envelope, coherentLod) : envelope'
    )
    // LOD 只改瞬时 mps；peak 仍在其后按既有口径计算。
    expect(sceneBuilderSrc.indexOf('mps = mix(mps, envelope, coherentLod)')).toBeLessThan(
      sceneBuilderSrc.indexOf('float peak = uPeakHistory')
    )
  })

  it('热力图显示不叠加屏幕哈希噪声，并绕过高频岩石底纹', () => {
    expect(sceneBuilderSrc).toContain('float fieldLayerOn = smoothstep(1e-4, 0.04, uFieldWeight)')
    expect(sceneBuilderSrc).toContain('if (fieldLayerOn < 0.999)')
    expect(sceneBuilderSrc).not.toContain('gl_FragCoord.xy, vec2(12.9898, 78.233)')
    expect(sceneBuilderSrc).not.toContain('fieldCol +=')
  })

  it('正面默认关闭高频载波与几何等力线', () => {
    expect(sceneBuilderSrc).toContain('carrierHz: 0')
    expect(useBlastingSrc).toContain('const carrierHz = ref(0)')
    expect(blastingManagerSrc).toContain('this._vibCarrierHz = 0')
    expect(sceneBuilderSrc).toContain('this._isoLineOn = false')
    expect(useBlastingSrc).toContain('const isoLineEnabled = ref(false)')
    expect(fieldPanelSrc).toContain('isoLineEnabled: { type: Boolean, default: false }')
  })

  it('不重新引入未接线的档边界/抖动死代码', () => {
    expect(sceneBuilderSrc).not.toContain('bandContour')
    expect(sceneBuilderSrc).not.toContain('bandCoordAA')
    expect(sceneBuilderSrc).not.toContain('bayerDither4')
  })
})
