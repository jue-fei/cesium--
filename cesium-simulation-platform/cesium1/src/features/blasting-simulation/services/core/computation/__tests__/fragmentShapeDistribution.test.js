/**
 * 形状分布与初始位置均匀性回归测试
 *
 * 覆盖用户提出的两个质疑：
 *  1) "碎石很大一部分不是块状，而是扁平片状" → 扁平度中位数必须 ≥ 0.45，
 *     板状占比 ≤ 20%，等轴块状占比 ≥ 40%
 *  2) "先算块度再按正态分布撒到掌子面是否合理" → 初始位置应按待爆体积
 *     均匀铺满断面（四象限计数均衡），而不是聚集在孔轴附近
 */
import { describe, it, expect } from 'vitest'
import { generateFragmentSpecs } from '../../rendering/fragmentSpecGenerator.js'
import {
    getRockVariantShapeStats,
    ROCK_VARIANT_TOTAL
} from '../../rendering/rockGeometryFactory.js'

const W = 18
const HW = 6
const R = 9

const FACE = {
    cx: 0,
    cy: 0,
    cz: 0,
    nx: 0,
    ny: 0,
    nz: -1,
    rx: 1,
    ry: 0,
    rz: 0,
    ux: 0,
    uy: 1,
    uz: 0,
    width: W,
    wallHeight: HW,
    archRadius: R,
    shape: 'horseshoe',
    floorY: 0
}

const KCO = { x50: 0.35, xmax: 1.2, b: 2.0, n: 1.2 }

function median(arr) {
    if (!arr.length) return 0
    const s = arr.slice().sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

describe('碎石形状分布与初始位置', () => {
    it('几何池为 18 个节理块体变体，族与 Zingg 分类严格一致', () => {
        const stats = getRockVariantShapeStats()
        expect(ROCK_VARIANT_TOTAL).toBe(18)
        expect(stats).toHaveLength(18)
        // 族名必须是实际几何 Zingg 分类（避免"族名柱状、几何不规则"的错位）
        for (const s of stats) {
            expect(s.family).toBe(s.zingg)
        }
        // 四类 Zingg 均存在，且块状为主体（≥8/18）
        expect(stats.filter(s => s.zingg === 'blocky').length).toBeGreaterThanOrEqual(8)
        expect(stats.some(s => s.zingg === 'platy')).toBe(true)
        expect(stats.some(s => s.zingg === 'columnar')).toBe(true)
        expect(stats.some(s => s.zingg === 'irregular')).toBe(true)
    })

    it('碎块扁平度中位数 ≥ 0.45、板状占比 ≤ 20%（不再以片状为主）', () => {
        const out = generateFragmentSpecs({
            kco: KCO,
            face: FACE,
            chargeKg: 320,
            targetCount: 1000,
            countLimit: 1200,
            randomSeed: 2024
        })
        expect(out.specs.length).toBeGreaterThan(300)

        const stats = getRockVariantShapeStats()
        const flatness = out.specs.map(s => stats[s.variantIndex].flatness)
        expect(median(flatness)).toBeGreaterThanOrEqual(0.45)

        const platy = out.specs.filter(s => stats[s.variantIndex].zingg === 'platy').length
        const blocky = out.specs.filter(s => stats[s.variantIndex].zingg === 'blocky').length
        expect(platy / out.specs.length).toBeLessThanOrEqual(0.2)
        expect(blocky / out.specs.length).toBeGreaterThanOrEqual(0.4)
    })

    it('变体索引全部合法（0 ~ 17）', () => {
        const out = generateFragmentSpecs({
            kco: KCO,
            face: FACE,
            chargeKg: 200,
            targetCount: 400,
            countLimit: 500,
            randomSeed: 7
        })
        for (const s of out.specs) {
            expect(s.variantIndex).toBeGreaterThanOrEqual(0)
            expect(s.variantIndex).toBeLessThan(ROCK_VARIANT_TOTAL)
        }
    })

    it('初始位置在断面内按体积均匀铺满（左右均衡、竖向全覆盖）', () => {
        const out = generateFragmentSpecs({
            kco: KCO,
            face: FACE,
            chargeKg: 320,
            targetCount: 800,
            countLimit: 1000,
            randomSeed: 99
        })
        const total = out.positions.length
        // 左右均衡：断面左右对称，纯高斯聚集在孔轴时两侧仍均衡，但结合竖向覆盖
        // 与下方左右/上部占比可排除“只沿孔列分布”的偏折
        const left = out.positions.filter(p => p.x < 0).length
        expect(left / total).toBeGreaterThan(0.4)
        expect(left / total).toBeLessThan(0.6)

        // 竖向覆盖：直墙下部与拱部都必须有碎块（旧版纯高斯集中在孔周，
        // 远离孔的断面边缘与拱部会缺失）
        const low = out.positions.filter(p => p.y < HW * 0.5).length
        const high = out.positions.filter(p => p.y > HW + R * 0.5).length
        expect(low / total).toBeGreaterThan(0.1)
        expect(high / total).toBeGreaterThan(0.05)
    })

    it('体积守恒误差可报告（未夹紧时应接近 0）', () => {
        const out = generateFragmentSpecs({
            kco: KCO,
            face: FACE,
            chargeKg: 320,
            targetCount: 1000,
            countLimit: 1200,
            randomSeed: 5,
            metrics: {
                volumeRoundM3: 120,
                enableVolumeRestore: true,
                bulkFactor: 1.5
            }
        })
        expect(out.stats.volumeConservationError).not.toBeNull()
        // 计划要求：ΣV 与目标松散体积偏差 < 2%（k 未被夹紧时应接近 0）
        expect(out.stats.volumeConservationError).toBeLessThan(0.02)
    })
})
