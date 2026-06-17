/**
 * 矿卡行驶模拟器 — 按 phase（0→1）沿路径循环行驶
 * 模拟速度、载重、发动机温度、燃油等动态数据
 */
export class TruckSimulator {
  constructor(options = {}) {
    this._trucks = new Map()
    this._config = {
      updateIntervalMs: 1000,
      cycleTimeMs: 360000,
      phaseRatio: { loading: 0.15, loadedTransport: 0.35, unloading: 0.15, emptyReturn: 0.35 },
      speedProfile: {
        loading: { min: 4, max: 6 },
        loadedTransport: { min: 23, max: 30 },
        unloading: { min: 4, max: 6 },
        emptyReturn: { min: 30, max: 38 }
      },
      vehicleStatus: {
        engineTemp: { min: 80, max: 100 },
        fuelLevel: { min: 60, max: 90 }
      },
      locationMap: {
        装载中: '采场1装载区',
        重载运输: '采场1→采场2运输线',
        卸载中: '采场2卸载区',
        空载返程: '采场2→采场1返程线'
      },
      ...options
    }
    this._timer = null
    this._onUpdate = null
    this._lastTick = 0
    this._fuelLevels = new Map()
    this._cycleCounts = new Map()
  }

  applySimConfig(config) {
    if (config?.simulation) {
      if (config.simulation.updateIntervalMs)
        this._config.updateIntervalMs = config.simulation.updateIntervalMs
      if (config.simulation.cycleTimeMs) this._config.cycleTimeMs = config.simulation.cycleTimeMs
    }
    if (config?.speedProfile) Object.assign(this._config.speedProfile, config.speedProfile)
    if (config?.phaseRatio) Object.assign(this._config.phaseRatio, config.phaseRatio)
    if (config?.vehicleStatus) Object.assign(this._config.vehicleStatus, config.vehicleStatus)
    if (config?.locationMap) Object.assign(this._config.locationMap, config.locationMap)
  }

  _buildTruckState(existing, truck) {
    return {
      ...existing,
      ...truck,
      phase: existing ? existing.phase : (truck.phase ?? 0),
      speed: truck.speed ?? 0,
      payload: truck.payload ?? 0,
      engineTemp: truck.engineTemp ?? this._randomInRange(this._config.vehicleStatus.engineTemp),
      fuelLevel: truck.fuelLevel ?? this._randomInRange(this._config.vehicleStatus.fuelLevel),
      cycleCount: existing ? existing.cycleCount : (truck.cycleCount ?? 0)
    }
  }

  _initializeTruckRuntimeState(truck) {
    if (!this._fuelLevels.has(truck.truckId)) {
      this._fuelLevels.set(
        truck.truckId,
        truck.fuelLevel ?? this._randomInRange(this._config.vehicleStatus.fuelLevel)
      )
    }
    if (!this._cycleCounts.has(truck.truckId)) {
      this._cycleCounts.set(truck.truckId, truck.cycleCount ?? 0)
    }
  }

  setTrucks(trucks) {
    const currentIds = new Set(trucks.map(t => t.truckId))
    for (const id of this._trucks.keys()) {
      if (!currentIds.has(id)) this._trucks.delete(id)
    }
    for (const t of trucks) {
      const existing = this._trucks.get(t.truckId)
      this._trucks.set(t.truckId, this._buildTruckState(existing, t))
      this._initializeTruckRuntimeState(t)
    }
  }

  start(onUpdate) {
    this._onUpdate = onUpdate
    this._lastTick = performance.now()
    this._tick()
    this._timer = setInterval(() => this._tick(), this._config.updateIntervalMs)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._onUpdate = null
  }

  destroy() {
    this.stop()
    this._trucks.clear()
    this._fuelLevels.clear()
    this._cycleCounts.clear()
  }

  _tick() {
    const now = performance.now()
    const elapsed = this._lastTick ? now - this._lastTick : this._config.updateIntervalMs
    this._lastTick = now
    const phaseDelta = elapsed / this._config.cycleTimeMs

    const updates = []
    for (const truck of this._trucks.values()) {
      let phase = truck.phase + phaseDelta
      let cycleCompleted = false
      if (phase >= 1) {
        phase -= 1
        cycleCompleted = true
      }

      const status = this._phaseToStatus(phase)
      const speed = this._randomInRange(this._config.speedProfile[this._statusKey(status)])
      const payload = this._calcPayload(phase, truck.capacity || 72)
      const engineTemp = this._calcEngineTemp(truck.engineTemp, status)
      const location = this._config.locationMap[status] || '未知'

      let fuelLevel = this._fuelLevels.get(truck.truckId) ?? truck.fuelLevel ?? 80
      fuelLevel = Math.max(0, fuelLevel - (elapsed / 60000) * 0.08)
      this._fuelLevels.set(truck.truckId, fuelLevel)

      let cycleCount = this._cycleCounts.get(truck.truckId) ?? truck.cycleCount ?? 0
      if (cycleCompleted) {
        cycleCount++
        this._cycleCounts.set(truck.truckId, cycleCount)
      }

      truck.phase = phase
      truck.status = status
      truck.speed = speed
      truck.payload = payload
      truck.engineTemp = engineTemp
      truck.fuelLevel = fuelLevel
      truck.location = location
      truck.cycleCount = cycleCount
      truck.heading = this._calcHeading(phase)

      // 排除旧 position，强制 processData 从最新 phase 重新计算
      const updateData = { ...truck }
      delete updateData.position
      updates.push(updateData)
    }

    if (this._onUpdate && updates.length > 0) {
      this._onUpdate(updates)
    }
  }

  _phaseToStatus(phase) {
    const r = this._config.phaseRatio
    if (phase < r.loading) return '装载中'
    if (phase < r.loading + r.loadedTransport) return '重载运输'
    if (phase < r.loading + r.loadedTransport + r.unloading) return '卸载中'
    return '空载返程'
  }

  _statusKey(status) {
    const map = {
      装载中: 'loading',
      重载运输: 'loadedTransport',
      卸载中: 'unloading',
      空载返程: 'emptyReturn'
    }
    return map[status] || 'emptyReturn'
  }

  _randomInRange(range) {
    if (!range) return 0
    const v = range.min + Math.random() * (range.max - range.min)
    return Math.round(v * 10) / 10
  }

  _calcPayload(phase, capacity) {
    const r = this._config.phaseRatio
    if (phase < r.loading) {
      return Math.round(capacity * (phase / r.loading))
    }
    if (phase < r.loading + r.loadedTransport) {
      return capacity
    }
    if (phase < r.loading + r.loadedTransport + r.unloading) {
      const unloadProgress = (phase - r.loading - r.loadedTransport) / r.unloading
      return Math.round(capacity * (1 - unloadProgress))
    }
    return 0
  }

  _calcEngineTemp(prevTemp, status) {
    const range = this._config.vehicleStatus.engineTemp
    const target = status === '重载运输' ? range.max : (range.min + range.max) / 2
    const drift = (target - (prevTemp || target)) * 0.3 + (Math.random() - 0.5) * 2
    return Math.round((prevTemp + drift) * 10) / 10
  }

  _calcHeading(phase) {
    if (phase < 0.5) return 90
    return 270
  }
}

export default TruckSimulator
