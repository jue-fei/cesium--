const ALERT_PRIORITY = { high: 3, medium: 2, low: 1 }

function createAlertEntry(truck, type, level, message, timestamp) {
  return {
    key: `${truck.truckId}:${type}`,
    truckId: truck.truckId,
    truckName: truck.truckName || truck.name || truck.truckId,
    level,
    type,
    message,
    timestamp
  }
}

function buildTruckAlerts(truck, currentTimestamp) {
  const timestamp = truck.timestamp || currentTimestamp
  const alerts = []

  if ((truck.engineTemp || 0) >= 95) {
    alerts.push(
      createAlertEntry(
        truck,
        'engineTemp',
        'high',
        `发动机温度 ${Math.round(truck.engineTemp)}°C，建议立即检查冷却系统`,
        timestamp
      )
    )
  }

  if ((truck.fuelLevel || 0) <= 30) {
    alerts.push(
      createAlertEntry(
        truck,
        'fuelLevel',
        'medium',
        `燃油仅剩 ${Math.round(truck.fuelLevel)}%，建议尽快补能`,
        timestamp
      )
    )
  }

  if ((truck.speed || 0) >= (truck.vehicleInfo?.maxSpeed || 40) * 0.95) {
    alerts.push(
      createAlertEntry(
        truck,
        'speed',
        'medium',
        `当前速度 ${Math.round(truck.speed)} km/h，接近车辆上限`,
        timestamp
      )
    )
  }

  return alerts
}

export function buildAlertCandidates(trucks, currentTimestamp) {
  return trucks
    .flatMap(truck => buildTruckAlerts(truck, currentTimestamp))
    .sort((left, right) => ALERT_PRIORITY[right.level] - ALERT_PRIORITY[left.level])
}

export function deriveAlertState({
  trucks,
  currentTimestamp,
  activeAlertKeys,
  previousAlertHistory,
  alertHistoryLimit,
  activeAlertLimit
}) {
  const nextAlerts = buildAlertCandidates(trucks, currentTimestamp)
  const nextAlertKeys = new Set(nextAlerts.map(alert => alert.key))
  const nextAlertHistory = [...previousAlertHistory]

  nextAlerts.forEach(alert => {
    if (!activeAlertKeys.has(alert.key)) {
      nextAlertHistory.unshift({ ...alert })
    }
  })

  return {
    nextAlertKeys,
    nextAlertList: nextAlerts.slice(0, activeAlertLimit),
    nextAlertHistory: nextAlertHistory.slice(0, alertHistoryLimit)
  }
}
