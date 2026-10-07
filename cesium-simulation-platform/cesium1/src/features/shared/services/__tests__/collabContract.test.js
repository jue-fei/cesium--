/**
 * collabContract.test.js —— 跨终端协作身份契约（前端侧 · 3.2.1）
 *
 * 锁定 features/shared/services/collabIdentity.js 的常量/请求头与仓库根
 * shared-consistency-baseline.json 的 collabCmps 一致，并校验各写接口确实注入了
 * 协作身份头。后端对应用例为 backend-py/tests/test_collab.py。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_ID_MAX_LEN,
  OPERATOR_MAX_LEN,
  DEFAULT_OPERATOR,
  identityHeaders,
  withIdentity
} from '../collabIdentity.js'

// 由 features/shared/services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.collabCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('跨终端协作身份契约（collabCmps）', () => {
  it('baseline 存在 collabCmps 且结构完整', () => {
    expect(CMP.identityHeaders.clientId).toBe('X-Client-Id')
    expect(CMP.identityHeaders.operator).toBe('X-Operator')
    expect(CMP.defaultOperator).toBe('操作员')
    expect(CMP.actorFormat).toBe('{operator}@{clientId:8}')
  })

  it('collabIdentity 常量与 baseline 一致（真源后端，前端同值）', () => {
    expect(DEFAULT_OPERATOR).toBe(CMP.defaultOperator)
    expect(CLIENT_ID_MAX_LEN).toBe(CMP.clientIdMaxLen)
    expect(OPERATOR_MAX_LEN).toBe(CMP.operatorMaxLen)
  })

  it('identityHeaders 输出契约请求头且操作员缺省「操作员」', () => {
    const h = identityHeaders()
    const keys = Object.keys(h).map(k => k.toLowerCase())
    expect(keys).toContain(CMP.identityHeaders.clientId.toLowerCase())
    expect(keys).toContain(CMP.identityHeaders.operator.toLowerCase())
    expect(h['X-Operator']).toBe(CMP.defaultOperator)
    // clientId 归一后仅 URL 安全字符且不超上限
    expect(h['X-Client-Id']).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(h['X-Client-Id'].length).toBeLessThanOrEqual(CMP.clientIdMaxLen)
  })

  it('withIdentity 合并身份头且不覆盖调用方显式头', () => {
    const init = withIdentity({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['X-Client-Id']).toBeTruthy()
    // 显式同名头优先
    const overridden = withIdentity({ headers: { 'X-Operator': '张三' } })
    expect(overridden.headers['X-Operator']).toBe('张三')
  })

  it('各写接口已注入协作身份头', () => {
    expect(featureSrc('../../../realtime-monitoring/services/schedulingApi.js')).toContain('withIdentity')
    expect(featureSrc('../../../realtime-monitoring/services/useScheduling.js')).toContain('withIdentity')
    expect(featureSrc('../../../blasting-simulation/services/blastingApi.js')).toContain('identityHeaders')
    // 审计面板消费 clientId 标出「本机」
    expect(featureSrc('../../../operation-audit/components/AuditPanel.vue')).toContain('getClientId')
  })
})
