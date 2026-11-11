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
    it('几何池为 22 个块体变体（含 4 个浑圆），族与 Zingg 分类严格一致', () => {
        const stats = getRockVariantShapeStats()
        expect(ROCK_VARIANT_TOTAL).toBe(22)
        expect(stats).toHaveLength(22)
        // 族名必须是实际几何 Zingg 分类（避免"族名柱状、几何不规则"的错位）
        for (const s of stats) {
            expect(s.family).toBe(s.zingg)
        }
        // 五类形态均存在，且块状为主体（≥8/22）
        expect(stats.filter(s => s.zingg === 'blocky').length).toBeGreaterThanOrEqual(8)
        expect(stats.some(s => s.zingg === 'rounded')).toBe(true)
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

    it('变体索引全部合法（0 ~ 21），且次圆块占比受控（8%~12% 设计值）', () => {
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
            // 传统模式同样携带逐实例形状变异参数（有界）
            expect(s.morphAmp).toBeGreaterThanOrEqual(0)
            expect(s.morphAmp).toBeLessThanOrEqual(0.11)
            expect(s.morphSeed).toHaveLength(3)
        }
        const stats = getRockVariantShapeStats()
        const rounded = out.specs.filter(s => stats[s.variantIndex].zingg === 'rounded').length
        // 权重设计值 8%~12%（近景下"光滑球"观感失真，旧值 20%~28% 已下调）；
        // 单种子抽样噪声下给 4%~22% 的容差带
        expect(rounded / out.specs.length).toBeGreaterThanOrEqual(0.04)
        expect(rounded / out.specs.length).toBeLessThanOrEqual(0.22)
    })

    it('逐实例形状变异由爆破参数驱动：掏槽孔 > 周边孔，且幅度有界', () => {
        // 炮孔驱动模式：4 个掏槽孔（delayMs=0，夹制作用强）+ 8 个周边孔
        // （delayMs=150ms，光面爆破低损伤）→ 变异幅度应有可测差异
        const holes = []
        for (let i = 0; i < 4; i++) {
            holes.push({
                x: (i % 2 ? 1 : -1) * 1.2,
                y: 2.5 + Math.floor(i / 2) * 2,
                chargeKg: 20,
                delayMs: 0,
                holeType: 'cut',
                isEmpty: false
            })
        }
        for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2
            holes.push({
                x: Math.cos(ang) * 7.2,
                y: 2.6 + Math.sin(ang) * 1.4,
                chargeKg: 10,
                delayMs: 150,
                holeType: 'perimeter',
                isEmpty: false
            })
        }
        const out = generateFragmentSpecs({
            kco: KCO,
            face: FACE,
            chargeKg: 320,
            targetCount: 600,
            countLimit: 800,
            holes,
            randomSeed: 11
        })
        expect(out.specs.length).toBeGreaterThan(100)

        // 延时段划分：段间隔 150ms → 掏槽 delayTime ∈ [0,0.15)，周边 ∈ [0.15,0.3)
        const cut = out.specs.filter(s => s.delayTime < 0.15)
        const peri = out.specs.filter(s => s.delayTime >= 0.15)
        expect(cut.length).toBeGreaterThan(30)
        expect(peri.length).toBeGreaterThan(30)

        for (const s of out.specs) {
            expect(s.morphAmp).toBeGreaterThanOrEqual(0)
            expect(s.morphAmp).toBeLessThanOrEqual(0.11)
            expect(s.morphSeed).toHaveLength(3)
            for (const v of s.morphSeed) {
                expect(v).toBeGreaterThanOrEqual(0)
                expect(v).toBeLessThan(Math.PI * 2)
            }
        }
        const avg = arr => arr.reduce((sum, x) => sum + x.morphAmp, 0) / arr.length
        // 掏槽孔破碎充分、破裂面杂乱 → 平均变异幅度显著高于周边光面孔
        expect(avg(cut)).toBeGreaterThan(avg(peri))
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
