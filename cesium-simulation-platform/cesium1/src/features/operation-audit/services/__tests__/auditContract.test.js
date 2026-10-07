/**
 * auditContract.test.js —— 操作审计前后端契约（前端侧）
 *
 * 锁定 3.3 审计时间线的 API 路径、查询参数、响应键与仓库根
 * shared-consistency-baseline.json 的 auditCmps 一致。
 * 后端对应用例为 backend-py/tests/test_audit.py。任一端改动
 * 路径/键名/动作枚举而不同步基线与对端实现，对应测试即失败。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 由 services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.auditCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('操作审计契约（auditCmps）', () => {
  it('baseline 存在 auditCmps 且结构完整', () => {
    expect(CMP.api.logs).toBe('GET /api/audit/logs')
    expect(CMP.api.actions).toBe('GET /api/audit/actions')
    expect(CMP.entryKeys).toEqual(['id', 'ts', 'actor', 'clientId', 'action', 'scenario', 'summary', 'detail', 'ok'])
    expect(CMP.logResponseDataKeys).toEqual(['entries', 'hasMore'])
    expect(CMP.actionItemKeys).toEqual(['id', 'label', 'domain'])
  })

  it('auditApi 的审计 API 路径与查询参数键与 baseline 契约一致', () => {
    const src = featureSrc('../auditApi.js')
    expect(src).toContain('/api/audit/logs')
    expect(src).toContain('/api/audit/actions')
    // 查询参数键与后端路由参数对齐（limit/action/scenario/before_id）
    expect(src).toContain("'limit'")
    expect(src).toContain("'action'")
    expect(src).toContain("'scenario'")
    expect(src).toContain("'before_id'")
  })

  it('AuditPanel 消费响应键且不自持动作标签表（新增审计点零前端发布）', () => {
    const src = featureSrc('../../components/AuditPanel.vue')
    // 响应键消费
    expect(src).toContain('.entries')
    expect(src).toContain('.hasMore')
    expect(src).toContain('.actions')
    // 域过滤 chips 覆盖 baseline 域
    for (const d of CMP.domains) expect(src).toContain(d)
    // 动作标签/域映射真源在后端：前端不得硬编码任何动作 id
    for (const aid of CMP.actionIds) expect(src).not.toContain(aid)
  })
})
