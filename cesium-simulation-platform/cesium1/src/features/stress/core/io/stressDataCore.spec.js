import { describe, it, expect } from 'vitest'
import { validateAndNormalizeStressFile } from './stressDataCore.js'

function buildBasePointFile() {
  return {
    格式版本: '应力点-1.0',
    坐标原点: [110, 30, 0],
    场尺寸: [200, 200, 100],
    时间: { 维度: '秒', 时间点: [0, 1, 2] },
    点: [
      {
        id: 'P1',
        中心_UVW: [0.5, 0.5, 0.5]
      }
    ]
  }
}

describe('stressDataCore', () => {
  it('支持点文件直接传入 von_mises 数组', () => {
    const json = buildBasePointFile()
    json['点'][0]['von_mises'] = [10, 20, 30]
    const result = validateAndNormalizeStressFile(json)
    expect(result.ok).toBe(true)
    expect(result.data.__type).toBe('point_config')
    expect(result.data.points.length).toBeGreaterThan(0)
  })

  it('支持点文件 tensor6 应力分量', () => {
    const json = buildBasePointFile()
    json['点'][0]['应力'] = {
      类型: 'tensor6',
      xx: [10, 11, 12],
      yy: [8, 8, 8],
      zz: [5, 5, 5],
      xy: [1, 1, 1],
      yz: [0, 0, 0],
      zx: [0, 0, 0]
    }
    const result = validateAndNormalizeStressFile(json)
    expect(result.ok).toBe(true)
    expect(result.data.points[0].tensor6).toBeTruthy()
  })

  it('在应力值长度错误时返回明确错误', () => {
    const json = buildBasePointFile()
    json['点'][0]['应力'] = { 类型: 'von_mises', 值: [10, 20] }
    const result = validateAndNormalizeStressFile(json)
    expect(result.ok).toBe(false)
    expect(result.message.includes('长度必须')).toBe(true)
  })
})
