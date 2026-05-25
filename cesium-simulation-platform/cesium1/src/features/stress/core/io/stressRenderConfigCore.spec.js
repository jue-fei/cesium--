import { describe, expect, it } from 'vitest'
import { normalizeRenderConfig } from './stressRenderConfigCore.js'

describe('stressRenderConfigCore', () => {
  it('默认渲染配置可通过并生成默认配色', () => {
    const out = normalizeRenderConfig({})
    expect(out.ok).toBe(true)
    expect(out.data.colorRamp.length).toBe(4)
  })

  it('支持手动值域模式', () => {
    const out = normalizeRenderConfig({ 值域: { 模式: '手动', 最小: -2, 最大: 20 } })
    expect(out.ok).toBe(true)
    expect(out.data.valueRange).toEqual({ mode: '手动', min: -2, max: 20 })
  })

  it('校验错误的值域参数', () => {
    const out = normalizeRenderConfig({ 值域: { 模式: '手动', 最小: 2, 最大: 1 } })
    expect(out.ok).toBe(false)
    expect(out.message.includes('最小 < 最大')).toBe(true)
  })
})
