/**
 * 爆破块体形态与爆堆相似性验收（node 直跑）
 *
 * 用法：node scripts/validate-fragmentation-shape.mjs
 * 产出：docs/blasting-fragmentation-validation.md
 *
 * 验收三个文献口径：
 *  - 块体形状：Zingg 分类占比、扁平度中位数（不应以片状为主）
 *  - 块度：Swebrec 目标 vs 实际直方图 KL 散度
 *  - 爆堆：安息角 / 堆高比 / 抛距 / 落差 / 横向展布 / 粒度偏析
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import { generateFragmentSpecs } from '../src/features/blasting-simulation/services/core/rendering/fragmentSpecGenerator.js'
import {
    getRockVariantShapeStats,
    getRockVariantVertices
} from '../src/features/blasting-simulation/services/core/rendering/rockGeometryFactory.js'
import { RapierPhysicsEngine } from '../src/features/blasting-simulation/services/core/computation/rapierPhysicsEngine.js'
import {
    computeMuckPileMetrics,
    MUCK_PILE_REFERENCE
} from '../src/features/blasting-simulation/services/core/rendering/muckPileMetrics.js'
import { makeRng } from '../src/features/blasting-simulation/services/core/utils/rng.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_FILE = path.resolve(__dirname, '../docs/blasting-fragmentation-validation.md')

const W = 18
const HW = 6
const R = 9

const BOUNDS = {
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    halfWidth: W / 2,
    wallHeight: HW,
    archRadius: R,
    floorY: 0,
    faceOffset: 3,
    shape: 'horseshoe'
}

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

// 现场尺度断面：4m 宽 × 2.5m 直墙 + 1.5m 拱半径（总高 4m，面积 ≈ 13.5m²）
// 真实矿山巷道尺度。大断面（18m 宽）属展示尺度，崩落方量摊铺导致堆高比天然偏低，
// 堆高比/坡角的文献对照必须在现场尺度下进行。
const FIELD_W = 4
const FIELD_HW = 2.5
const FIELD_R = 1.5
const FIELD_BOUNDS = {
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    halfWidth: FIELD_W / 2,
    wallHeight: FIELD_HW,
    archRadius: FIELD_R,
    floorY: 0,
    faceOffset: 3,
    shape: 'horseshoe'
}

const FIELD_FACE = {
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
    width: FIELD_W,
    wallHeight: FIELD_HW,
    archRadius: FIELD_R,
    shape: 'horseshoe',
    floorY: 0
}

const SCENARIOS = [
    {
        key: 'hard-rock',
        name: '硬岩块状（节理稀发）',
        kco: { x50: 0.35, xmax: 1.2, b: 2.0, n: 1.2 },
        chargeKg: 320,
        shapeMix: null
    },
    {
        key: 'medium',
        name: '中硬岩（常规节理）',
        kco: { x50: 0.5, xmax: 1.6, b: 2.0, n: 1.2 },
        chargeKg: 260,
        shapeMix: null
    },
    {
        key: 'bedded',
        name: '层理发育（板状比例上调）',
        kco: { x50: 0.45, xmax: 1.5, b: 2.0, n: 1.2 },
        chargeKg: 300,
        shapeMix: { platy: 4, blocky: 0.7 }
    },
    {
        key: 'field-scale',
        name: '现场尺度（4m×4m 巷道，3m 进尺）',
        kco: { x50: 0.3, xmax: 1.0, b: 2.0, n: 1.2 },
        chargeKg: 30,
        shapeMix: null,
        bounds: FIELD_BOUNDS,
        face: FIELD_FACE,
        volumeRoundM3: 40,
        advanceLength: 3,
        // 现场尺度按计划的严格文献区间判定（大断面展示尺度只做参考）
        strictReference: true
    }
]

function median(arr) {
    if (!arr.length) return null
    const s = arr.slice().sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function fmt(v, digits = 2) {
    return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

async function runScenario(sc) {
    const bounds = sc.bounds || BOUNDS
    const face = sc.face || FACE
    const out = generateFragmentSpecs({
        kco: sc.kco,
        face,
        chargeKg: sc.chargeKg,
        targetCount: 700,
        countLimit: 900,
        shapeMix: sc.shapeMix,
        metrics: {
            volumeRoundM3: sc.volumeRoundM3 || 120,
            advanceLength: sc.advanceLength || 2.5,
            enableVolumeRestore: true,
            bulkFactor: 1.5
        },
        randomSeed: 2026
    })
    const shapeStats = getRockVariantShapeStats()
    const counts = { blocky: 0, rounded: 0, irregular: 0, columnar: 0, platy: 0, elongated: 0 }
    const flatness = []
    for (const s of out.specs) {
        const st = shapeStats[s.variantIndex]
        counts[st.family]++
        flatness.push(st.flatness)
    }

    const eng = new RapierPhysicsEngine({ rng: makeRng(7) })
    eng.setGeometryVertices(getRockVariantVertices())
    eng.setTunnelBounds(bounds)
    eng.init(out.specs, out.positions, out.velocities)
    eng.activateAll()
    for (let i = 0; i < 400; i++) eng.step(0.05)

    const metrics = computeMuckPileMetrics(
        eng.getBodyStates(),
        bounds,
        sc.strictReference
            ? {
                reference: {
                    reposeAngleDeg: [35, 42],
                    pileHeightRatio: [0.8, 1.2],
                    segregationRatio: [1.0, 4.0]
                }
            }
            : {}
    )
    const total = out.specs.length || 1

    return {
        key: sc.key,
        name: sc.name,
        fragmentCount: out.specs.length,
        flatnessMedian: median(flatness),
        shapePct: Object.fromEntries(
            Object.entries(counts).map(([k, v]) => [k, (v / total) * 100])
        ),
        kl: out.stats.sizeKLDivergence,
        landed: eng.landedFragmentCount,
        metrics
    }
}

function buildMarkdown(rows, stamp) {
    const ref = MUCK_PILE_REFERENCE
    const lines = []
    lines.push('# 爆破块体形态与爆堆相似性验收')
    lines.push('')
    lines.push(`> 生成时间：${stamp}　|　运行方式：\`node scripts/validate-fragmentation-shape.mjs\``)
    lines.push('')
    lines.push('## 一、块体形状分布（Zingg 分类）')
    lines.push('')
    lines.push('| 场景 | 碎片数 | 扁平度中位数 | 等轴块状 | 浑圆 | 不规则 | 柱状 | 板状 | 长条 | 块度 KL |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of rows) {
        lines.push(
            `| ${r.name} | ${r.fragmentCount} | ${fmt(r.flatnessMedian)} |` +
            ` ${fmt(r.shapePct.blocky, 1)}% | ${fmt(r.shapePct.rounded, 1)}% |` +
            ` ${fmt(r.shapePct.irregular, 1)}% | ${fmt(r.shapePct.columnar, 1)}% |` +
            ` ${fmt(r.shapePct.platy, 1)}% | ${fmt(r.shapePct.elongated, 1)}% | ${fmt(r.kl, 3)} |`
        )
    }
    lines.push('')
    lines.push('## 二、爆堆形态（文献三参数 + 堆高/安息角/偏析）')
    lines.push('')
    lines.push(
        '| 场景 | 堆高(m) | 堆高比 | 安息角(°) | 抛距P95(m) | 落差(m) | 横向展布(m) | 偏析比 | 落地率 |'
    )
    lines.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of rows) {
        const m = r.metrics
        lines.push(
            `| ${r.name} | ${fmt(m.pileHeight)} | ${fmt(m.pileHeightRatio)} |` +
            ` ${fmt(m.reposeAngleDeg, 1)} | ${fmt(m.throwP95)} | ${fmt(m.drop)} |` +
            ` ${fmt(m.lateralSpread)} | ${fmt(m.segregationRatio)} |` +
            ` ${fmt((r.landed / Math.max(1, r.fragmentCount)) * 100, 1)}% |`
        )
    }
    lines.push('')
    lines.push('## 三、文献区间对照')
    lines.push('')
    lines.push(
        `- 隧道爆堆坡角（诊断口径）：${ref.reposeAngleDeg[0]}°~${ref.reposeAngleDeg[1]}°；` +
        `自由堆积安息角上限（参考上限）：${ref.freeReposeAngleDeg[0]}°~${ref.freeReposeAngleDeg[1]}°`
    )
    lines.push(
        `- 堆高比：${ref.pileHeightRatio[0]}~${ref.pileHeightRatio[1]}` +
        `（大断面隧道爆堆受摊铺面积制约，峰高 1~3m）`
    )
    lines.push(
        `- 偏析比：${ref.segregationRatio[0]}~${ref.segregationRatio[1]}` +
        `（双向机制：>1 粗块滚向坡脚，<1 振动筛分使粗块上浮到堆顶）`
    )
    lines.push('')
    lines.push('| 场景 | 安息角判定 | 堆高比判定 | 偏析判定 |')
    lines.push('|---|---|---|---|')
    for (const r of rows) {
        const w = r.metrics.withinReference || {}
        const mark = v => (v ? '✅ 符合' : '⚠️ 偏离')
        lines.push(`| ${r.name} | ${mark(w.reposeAngle)} | ${mark(w.pileHeight)} | ${mark(w.segregation)} |`)
    }
    lines.push('')
    lines.push('## 四、结论')
    lines.push('')
    const flat = rows.map(r => r.flatnessMedian).filter(v => v != null)
    const flatMed = flat.length ? flat.reduce((s, v) => s + v, 0) / flat.length : null
    lines.push(
        `- 块体扁平度中位数 ${fmt(flatMed)}（≥0.45 即不再以片状为主）；` +
        `各场景板状占比 ${rows.map(r => fmt(r.shapePct.platy, 1) + '%').join(' / ')}。`
    )
    lines.push(
        '- 块度 KL 散度越小表示与 Swebrec 目标级配越接近（<0.1 为良好，<0.3 可接受）。'
    )
    lines.push(
        '- 隧道爆堆坡角低于自由堆积安息角（35°~42°）属预期：大断面内碎块被侧墙约束、' +
        '方量摊铺，整体坡角显著小于无侧限料堆；偏低时应结合堆高与抛距判断是否抛掷过度。'
    )
    lines.push('')
    return lines.join('\n')
}

async function main() {
    await RAPIER.init()
    const rows = []
    for (const sc of SCENARIOS) {
        const r = await runScenario(sc)
        rows.push(r)
        console.log(
            `[validate] ${sc.name}: fragments=${r.fragmentCount} ` +
            `flatness=${fmt(r.flatnessMedian)} platy=${fmt(r.shapePct.platy, 1)}% ` +
            `repose=${fmt(r.metrics.reposeAngleDeg, 1)}° heightRatio=${fmt(r.metrics.pileHeightRatio)} ` +
            `segregation=${fmt(r.metrics.segregationRatio)}`
        )
        console.log(`[validate] metrics=${JSON.stringify(r.metrics)}`)
    }
    const md = buildMarkdown(rows, new Date().toISOString())
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    fs.writeFileSync(OUT_FILE, md, 'utf8')
    console.log(`[validate] 报告已写入 ${OUT_FILE}`)
}

main().catch(err => {
    console.error('[validate] 失败:', err)
    process.exitCode = 1
})
