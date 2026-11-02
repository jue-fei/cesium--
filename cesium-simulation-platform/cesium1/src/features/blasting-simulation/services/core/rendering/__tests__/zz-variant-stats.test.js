import { describe, it } from 'vitest'
import { getRockVariantShapeStats } from '../rockGeometryFactory.js'

describe('zz variant stats', () => {
    it('print', () => {
        const stats = getRockVariantShapeStats()
        for (const s of stats) {
            console.log(
                `[v] idx=${s.variantIndex} ${s.family} zingg=${s.zingg} ` +
                `elong=${s.elongation.toFixed(2)} flat=${s.flatness.toFixed(2)} tri=${s.faceTriangles}`
            )
        }
        const count = k => stats.filter(s => s.zingg === k).length
        console.log(
            `[v] zingg 分布 blocky=${count('blocky')} irregular=${count('irregular')} ` +
            `columnar=${count('columnar')} platy=${count('platy')}`
        )
    })
})
