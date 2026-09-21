/**
 * equipmentHealthContract.test.js —— 设备健康模型契约（前端侧）
 *
 * 锁定健康阈值与仓库根 shared-consistency-baseline.json#equipmentHealthCmps
 * 一致，并与前端 monitoringAlerts.js 的告警阈值同源（油温 95℃ / 油量 30% /
 * 速度 95%——同一数值只允许来自 baseline）。后端对应用例为
 * backend-py/tests/test_equipment_health.py（模型真源：equipment/health.py）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const BASELINE = JSON.parse(readFileSync(ROOT + 'shared-consistency-baseline.json', 'utf-8'))
const CMP = BASELINE.equipmentHealthCmps

function featureSrc(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
}

describe('设备健康契约（equipmentHealthCmps）', () => {
  it('baseline 结构完整', () => {
    expect(CMP.alarms).toEqual({ tempAlarmC: 95, fuelAlarmPct: 30, speedAlarmPct: 95 })
    expect(CMP.levels).toEqual({ normalMin: 80, watchMin: 60 })
    expect(CMP.weights.temp + CMP.weights.fuel + CMP.weights.speed).toBeCloseTo(1.0, 6)
    expect(CMP.healthMetric).toBe('equipment.health')
  })

  it('前端 monitoringAlerts.js 告警阈值与 baseline 同源', () => {
    const src = featureSrc('../../services/monitoringAlerts.js')
    expect(src).toContain(`${CMP.alarms.tempAlarmC}`) // 油温 95
    expect(src).toContain(`${CMP.alarms.fuelAlarmPct}`) // 油量 30
    expect(src).toContain(`${CMP.alarms.speedAlarmPct}`) // 速度 95
  })

  it('EquipmentHealthPanel 消费同一契约（API 路径/时序指标/分级标签）', () => {
    const src = featureSrc('../../components/EquipmentHealthPanel.vue')
    expect(src).toContain('/api/equipment/health')
    expect(src).toContain(CMP.healthMetric)
    expect(src).toContain('正常')
    expect(src).toContain('关注')
    expect(src).toContain('告警')
  })
})
