/**
 * 振动场计算 Web Worker 客户端（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * VibrationComputeClient：把最重的逐帧计算卸载到 Worker 线程（Transferable 零拷贝）。
 * 注：本文件位于 vibration/ 子目录，Worker 相对路径相应由
 * './vibrationComputeWorker.js' 调整为 '../vibrationComputeWorker.js'，
 * 解析结果与拆分前为同一文件。
 */

/**
 * 振动场计算 Web Worker 客户端
 *
 * 把 LocalVibrationSimulator 中最重的逐帧计算（多源矢量叠加 PPV/应力/损伤场）
 * 卸载到 Worker 线程，避免主线程因"网格点数×源数×幂/指数"计算卡死动画。
 * 使用 Transferable 零拷贝取回结果；同一时刻只允许一个 compute 请求在途，
 * requestId 用于识别并丢弃过期的中途结果。
 */
export class VibrationComputeClient {
  constructor() {
    this._worker = null
    this._simKey = null // 绑定的 sim 实例引用（识别是否需要重新 config）
    this._configSig = null // 已下发 Worker 的物理参数签名（K/α/网格/源数），变化时重配
  }

  get isWorkerAvailable() {
    return this._worker != null
  }

  /** 计算已下发配置的参数签名（K/α/介质/网格/源数；setSadoskyParams 原地改参后据此重配） */
  _signature(sim) {
    const p = sim.params
    return [
      sim.gridXyz ? sim.gridXyz.length : 0,
      Number(p.K),
      Number(p.alpha),
      Number(p.beta),
      Number(p.visualBeta),
      Number(p.visualCp),
      sim.chargeKg,
      Array.isArray(p.sources) ? p.sources.length : 0,
      Number(p.influenceRadius) || 0,
      Array.isArray(p.reflections)
        ? p.reflections
            .map(r => `${r.axis}:${Number(r.value).toFixed(3)}:${Number(r.coeff).toFixed(3)}`)
            .join(',')
        : 'none'
    ].join('|')
  }

  /**
   * 确保 Worker 已启动并为本 sim 配备好网格/参数（只在 sim 或参数变化时重新 config）。
   * @param {LocalVibrationSimulator} sim
   * @returns {boolean} Worker 是否就绪（不可用时返回 false，供调用方回退同步计算）
   */
  ensure(sim) {
    if (!sim || !sim.gridXyz) return false
    const sig = this._signature(sim)
    if (this._worker && this._simKey === sim && this._configSig === sig) return true
    if (!this._worker) {
      try {
        this._worker = new Worker(new URL('../vibrationComputeWorker.js', import.meta.url), {
          type: 'module'
        })
      } catch (err) {
        this._worker = null
        console.warn('[VibrationComputeClient] Worker 启动失败，回退主线程计算', err)
        return false
      }
    }
    this._simKey = sim
    this._configSig = sig
    this._postConfig(sim)
    return true
  }

  _postConfig(sim) {
    // params 深拷贝一份发给 Worker（worker 侧不可变）；含 sources（多装药源）与萨道夫斯基参数
    const params = {
      ...sim.params,
      sources: Array.isArray(sim.params.sources) ? sim.params.sources.map(s => ({ ...s })) : null,
      origin: sim.params.origin ? sim.params.origin.slice() : null
    }
    this._worker.postMessage({
      type: 'config',
      gridXyz: sim.gridXyz,
      params,
      chargeKg: sim.chargeKg
    })
    // 注意：gridXyz 故意不进行 Transferable 转移——主线程 sim 仍需自身 gridXyz
    // 做同步回退计算(computeAtTime)，转移会 detach 主线程侧缓冲。仅每次 sim 变化
    // config 一次，结构化克隆 3D 坐标（~数 MB）开销可忽略。
  }

  /**
   * 请求计算某时刻三场数据（异步）。
   * @param {number} t - 模拟时间(s)
   * @param {number} requestId - 调用方自增 id，用于在回调中丢弃过期结果
   * @returns {Promise<{ppv:Float32Array,sigmaVm:Float32Array,zones:Int8Array,t:number,requestId:number}> | null}
   */
  compute(t, requestId) {
    if (!this._worker) return null
    return new Promise(resolve => {
      const handler = e => {
        const d = e.data
        if (!d || d.type !== 'result') return
        if (d.requestId !== requestId) return // 过期结果，丢弃
        this._worker.removeEventListener('message', handler)
        this._worker.removeEventListener('error', handler)
        resolve({ ppv: d.ppv, sigmaVm: d.sigmaVm, zones: d.zones, t: d.t, requestId: d.requestId })
      }
      const error = err => {
        this._worker.removeEventListener('message', handler)
        resolve(null) // 计算失败回退：调用方应自行兜底
        console.warn('[VibrationComputeClient] Worker 计算错误', err)
      }
      this._worker.addEventListener('message', handler)
      this._worker.addEventListener('error', error)
      this._worker.postMessage({ type: 'compute', t, requestId })
    })
  }

  /**
   * 下发岩面顶点集与洞身整形参数（等值线峰值场数据源）。
   * 表面坐标应为 grid 局部系（与世界→局部的换算在 sceneBuilder 侧完成）。
   * @param {Float32Array} surfaceXyz - 表面顶点 (N×3, grid 局部系)
   * @param {Object} shaping - { holeRadius, holeLen, lateralAttn, origin }
   */
  contourConfig(surfaceXyz, shaping) {
    if (!this._worker) return
    this._worker.postMessage({
      type: 'contourConfig',
      surfaceXyz,
      shaping: shaping || null
    })
  }

  /**
   * 请求岩面顶点峰值场 + 到达时刻（异步；结果与 t 无关，Worker 内缓存）。
   * @param {number} requestId - 调用方自增 id，过期结果在回调中丢弃
   * @returns {Promise<{peak:Float32Array,arrival:Float32Array,requestId:number}> | null}
   */
  computeContour(requestId) {
    if (!this._worker) return null
    return new Promise(resolve => {
      const handler = e => {
        const d = e.data
        if (!d || d.type !== 'contourData') return
        if (d.requestId !== requestId) return
        this._worker.removeEventListener('message', handler)
        this._worker.removeEventListener('error', handler)
        resolve({ peak: d.peak, arrival: d.arrival, requestId: d.requestId })
      }
      const error = () => {
        this._worker.removeEventListener('message', handler)
        resolve(null)
      }
      this._worker.addEventListener('message', handler)
      this._worker.addEventListener('error', error)
      this._worker.postMessage({ type: 'contourCompute', requestId })
    })
  }

  /** 丢弃未决结果并断开 Worker（场景重建/销毁时调用） */
  dispose() {
    if (this._worker) {
      this._worker.terminate()
      this._worker = null
    }
    this._simKey = null
  }
}
