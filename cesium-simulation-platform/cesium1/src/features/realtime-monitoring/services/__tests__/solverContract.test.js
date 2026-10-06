/**
 * solverContract.test.js —— 多目标调度求解后端可配置契约（前端侧）
 *
 * 锁定仓库根 shared-consistency-baseline.json 的 solverCmps 段与前端消费口径：
 * MultiObjectiveLhdView 只读后端下发的 optStats.label / source（展示标签真源在后端），
 * 前端不得硬编码任何求解器展示标签，切换求解后端零前端发布。
 * 后端对应用例为 backend-py/tests/test_solver_registry.py。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 由 services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.solverCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('多目标调度求解后端契约（solverCmps）', () => {
  it('baseline 存在 solverCmps 且结构完整', () => {
    expect(Array.isArray(CMP.backends)).toBe(true)
    expect(CMP.backends).toContain('nsga3')
    expect(CMP.backends).toContain('ml')
    expect(CMP.defaultBackend).toBe('nsga3')
    expect(Array.isArray(CMP.outputKeys)).toBe(true)
    expect(Array.isArray(CMP.optStatsKeys)).toBe(true)
  })

  it('后端配置文件的 backend 取值在契约枚举内', () => {
    const cfg = JSON.parse(readFileSync(ROOT + CMP.configPath, 'utf-8'))
    expect(CMP.backends).toContain(cfg.backend)
    // 出厂默认必须是内置 NSGA-III（保证默认路径行为不变）
    expect(cfg.backend).toBe(CMP.defaultBackend)
  })

  it('MultiObjectiveLhdView 只读后端下发的 optStats.label（不硬编码展示标签）', () => {
    const src = featureSrc('../../components/MultiObjectiveLhdView.vue')
    // 读后端标签真源
    expect(src).toContain('optStats?.label')
    // 展示标签真源在后端：前端源码不得出现任何后端标签字面量
    for (const label of Object.values(CMP.labels)) {
      expect(src).not.toContain(label)
    }
  })

  it('标题 kicker 随求解后端动态化', () => {
    const src = featureSrc('../../components/MultiObjectiveLhdView.vue')
    expect(src).toContain('{{ optKicker }}')
    expect(src).toContain('optKicker')
  })
})
