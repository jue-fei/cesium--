/**
 * deploymentContract.test.js —— 拖拽式设备部署前后端契约（前端侧）
 *
 * 锁定 3.2 部署/出矿工序的 API 路径、负载键与响应键与仓库根
 * shared-consistency-baseline.json 的 deploymentCmps 一致。
 * 后端对应用例为 backend-py/tests/test_deployment.py。任一端改动路径/键名
 * 而不同步基线与对端实现，对应测试即失败。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 由 services/__tests__ 向上 6 级回溯到仓库根
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.deploymentCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('拖拽式设备部署契约（deploymentCmps）', () => {
  it('baseline 存在 deploymentCmps 且结构完整', () => {
    expect(CMP.api.get).toContain('/api/deployment')
    expect(CMP.api.put).toContain('/api/deployment')
    for (const k of ['scenario', 'deployments', 'processOrder', 'baseRev', 'force']) {
      expect(CMP.payloadKeys).toContain(k)
    }
    expect(CMP.responseDataKeys).toContain('rev')
    expect(CMP.deploymentItemKeys).toEqual(['node', 'level'])
  })

  it('schedulingApi 的部署 API 路径与 baseline 契约一致', () => {
    const src = featureSrc('../schedulingApi.js')
    // GET：路径 + scenario 查询参数为运行时模板拼接（?scenario=${encodeURIComponent}）
    expect(CMP.api.get).toMatch(/^GET \/api\/deployment\?scenario=$/)
    expect(src).toContain('`/api/deployment${q}`')
    expect(src).toContain('?scenario=${encodeURIComponent(scenario)}')
    // PUT：路径 + 方法
    expect(src).toContain(CMP.api.put.split(' ')[1])
    expect(src).toContain("method: 'PUT'")
  })

  it('schedulingApi 负载键与 baseline 契约一致（deployments 增量合并 / processOrder 整体替换）', () => {
    const src = featureSrc('../schedulingApi.js')
    expect(src).toContain('deployments')
    expect(src).toContain('processOrder')
    expect(src).toContain('node')
    expect(src).toContain('level')
  })

  it('部署响应键被消费 UI 按契约读取', () => {
    const src = featureSrc('../../components/MultiObjectiveLhdView.vue')
    for (const k of CMP.responseDataKeys) {
      expect(src).toContain(`.${k}`)
    }
  })

  it('3.2.3 乐观并发：baseRev/force 与冲突码已接线（前端消费）', () => {
    const rev = BASELINE.collabCmps.revision
    expect(rev.conflictCode).toBe(2)
    const api = featureSrc('../schedulingApi.js')
    expect(api).toContain(rev.requestKey) // baseRev
    expect(api).toContain(rev.forceKey) // force
    const view = featureSrc('../../components/MultiObjectiveLhdView.vue')
    expect(view).toContain('baseRev')
    expect(view).toContain('=== 2') // code=2 冲突分支
    expect(view).toContain('conflictForce') // 强制覆盖
    expect(view).toContain('conflictRefreshAndRetry') // 刷新并重试
  })
})
