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
import {
  CollabWsConnector,
  buildCollabUrl,
  isCollabEvent
} from '../../realtime/collabWsConnector.js'
import { ACTIVE_SCENARIO } from '../activeScenario.js'

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

  it('identityHeaders 值均为 ISO-8859-1 安全且操作员可还原（缺省「操作员」）', () => {
    const h = identityHeaders()
    const keys = Object.keys(h).map(k => k.toLowerCase())
    expect(keys).toContain(CMP.identityHeaders.clientId.toLowerCase())
    expect(keys).toContain(CMP.identityHeaders.operator.toLowerCase())
    // 回归：HTTP 头部值必须是 ISO-8859-1——含中文的原始值会让 fetch 抛
    // "String contains non ISO-8859-1 code point"，故操作员名须 percent-encode
    for (const v of Object.values(h)) {
      expect([...v].every(ch => ch.codePointAt(0) <= 0xff)).toBe(true)
    }
    expect(decodeURIComponent(h['X-Operator'])).toBe(CMP.defaultOperator)
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
    expect(featureSrc('../../../realtime-monitoring/services/schedulingApi.js')).toContain(
      'withIdentity'
    )
    expect(featureSrc('../../../realtime-monitoring/services/useScheduling.js')).toContain(
      'withIdentity'
    )
    expect(featureSrc('../../../blasting-simulation/services/blastingApi.js')).toContain(
      'identityHeaders'
    )
    // 审计面板消费 clientId 标出「本机」
    expect(featureSrc('../../../operation-audit/components/AuditPanel.vue')).toContain(
      'getClientId'
    )
  })
})

describe('协作事件广播契约（collabCmps · 3.2.2）', () => {
  it('baseline 广播字段结构完整', () => {
    expect(CMP.wsUrl).toBe('/ws/collab')
    expect(CMP.clientFrames).toEqual(['ping', 'hello'])
    expect(CMP.serverFrames).toEqual(['hello', 'collab_event', 'pong', 'error'])
    expect(CMP.eventKeys).toEqual([
      'id',
      'ts',
      'actor',
      'clientId',
      'action',
      'scenario',
      'summary',
      'ok'
    ])
    expect(CMP.heartbeatTimeoutMs).toBe(60000)
  })

  it('buildCollabUrl 与契约 wsUrl 一致且携带 scenario/clientId', () => {
    const url = buildCollabUrl('ashale', 'term-1')
    expect(url.startsWith(CMP.wsUrl + '?')).toBe(true)
    expect(url).toContain('scenario=ashale')
    expect(url).toContain('clientId=term-1')
  })

  it('isCollabEvent 只接受 collab_event 且含 data 对象', () => {
    expect(isCollabEvent({ type: 'collab_event', data: {} })).toBe(true)
    expect(isCollabEvent({ type: 'hello' })).toBe(false)
    expect(isCollabEvent({ type: 'collab_event' })).toBe(false)
    expect(isCollabEvent(null)).toBe(false)
    expect(typeof CollabWsConnector).toBe('function')
  })

  it('运行场景单一真源：协作订阅与调度面板必须同源（真机验收回归）', () => {
    // 契约：平台运行场景单一真源（activeScenario.js）。
    // 回归背景：协作订阅曾固定 'ashale' 而调度面板运行 'large'，后端按场景分频道的
    // 协作广播无人订阅 → 跨终端操作在真机上不可见、面板 opt-in 刷新被场景守卫跳过。
    expect(CMP.activeScenario).toBe(ACTIVE_SCENARIO)
    // 协作订阅（连接器默认 / useCollab 默认）取真源，不得硬编码场景字面量
    expect(featureSrc('../../realtime/collabWsConnector.js')).toContain('ACTIVE_SCENARIO')
    expect(featureSrc('../useCollab.js')).toContain('ACTIVE_SCENARIO')
    // App 启动订阅、以及运行场景的拥有者（调度面板）同样取真源
    expect(featureSrc('../../../../App.vue')).toContain('collab.start(ACTIVE_SCENARIO)')
    const panel = featureSrc(
      '../../../realtime-monitoring/components/scheduling/LhdSchedulingPanel.vue'
    )
    expect(panel).toContain('ACTIVE_SCENARIO')
    expect(panel).not.toContain("ref('large')")
    expect(panel).not.toContain("ref('ashale')")
  })

  it('无场景事件为全局广播（契约 globalBroadcastScenario=null）', () => {
    expect(CMP.globalBroadcastScenario).toBeNull()
  })

  it('连接器与 useCollab 已接线（心跳/退避/回声抑制/融合总线）', () => {
    const conn = featureSrc('../../realtime/collabWsConnector.js')
    expect(conn).toContain('computeBackoffMs') // 退避复用
    expect(conn).toContain("type: 'ping'") // 心跳
    const use = featureSrc('../useCollab.js')
    expect(use).toContain('getClientId') // 回声抑制
    expect(use).toContain('COLLAB_OPERATION') // 跨面板联动
    expect(use).toContain('subscribe')
  })

  it('3.2.2 面板 opt-in 刷新已接线（部署重拉 / 爆破事件列表重拉）', () => {
    const deployView = featureSrc(
      '../../../realtime-monitoring/components/MultiObjectiveLhdView.vue'
    )
    expect(deployView).toContain('COLLAB_OPERATION')
    expect(deployView).toContain('deployment.save')
    const blastPanel = featureSrc('../../../blasting-simulation/components/BlastingPanel.vue')
    expect(blastPanel).toContain('COLLAB_OPERATION')
    expect(blastPanel).toContain('loadDbEvents')
  })

  it('3.2.3 乐观并发契约：rev / baseRev / force / conflictCode', () => {
    const rev = CMP.revision
    expect(rev.responseKey).toBe('rev')
    expect(rev.requestKey).toBe('baseRev')
    expect(rev.forceKey).toBe('force')
    expect(rev.conflictCode).toBe(2)
  })
})
