/**
 * 爆破音效合成器
 *
 * 使用 Web Audio API 基于物理参数实时合成爆破音效。
 * 无外部音频文件依赖，全部实时生成。
 *
 * 音效分层（4 层）：
 * 1. 爆轰脉冲（Detonation Click）：0-5ms，噪声脉冲 → 对应爆轰波
 * 2. 低频轰鸣（Rumble）：10-200ms，过滤噪声 → 对应爆生气膨胀
 * 3. 岩石碎裂声（Crackle）：5-100ms，颗粒噪声 → 对应碎片形成
 * 4. 碎片撞击声（Impacts）：50-2000ms，离散脉冲 → 对应碎片落地
 *
 * 注：原方案"次声波尾音"层（5-15Hz）已删除，因人耳听不到 < 20Hz 的声音。
 *     低频轰鸣层已覆盖 30-80Hz 的可听低频段，无需次声层补充。
 */
export class BlastAudioSynth {
  constructor() {
    this.ctx = null  // 延迟初始化（需用户交互后才能创建 AudioContext）
    this.masterGain = null
    this.active = false

    // ── 撞击音效限流状态 ──
    // 避免数百碎片同时落地触发数百次音效合成导致爆音
    this._lastImpactTime = 0
    this._impactAccumulator = 0       // 限流窗口内的撞击累计能量
    this._impactMergeWindowMs = 50    // 50ms 内的撞击合并为一次播放
    this._maxImpactRate = 15          // 每秒最多播放 15 次撞击音效
  }

  /** 初始化 AudioContext（在首次用户点击时调用） */
  init() {
    if (this.ctx) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return  // 浏览器不支持 Web Audio API
    this.ctx = new Ctx()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = 0.7
    this.masterGain.connect(this.ctx.destination)
  }

  /**
   * 播放爆破音效
   * @param {Object} params
   * @param {number} params.chargeKg - 装药量(kg)，影响音量和低频分量
   * @param {number} params.distance - 听者距爆心距离(m)，影响延迟和高频衰减
   * @param {string} params.explosiveType - 炸药类型，影响爆轰频谱
   */
  playBlastSound(params = {}) {
    if (!this.ctx) return
    const { chargeKg = 100, distance = 50, explosiveType = 'emulsion' } = params
    const now = this.ctx.currentTime

    // 声传播延迟（声速 340 m/s）
    const delay = distance / 340

    // 音量基准（装药量越大越响，距离越远越轻）
    const chargeNormalized = Math.sqrt(chargeKg / 100)
    const distanceAttenuation = 1 / Math.max(1, distance / 10)
    const baseVolume = Math.min(1.0, chargeNormalized * distanceAttenuation * 0.8)

    // 1. 爆轰脉冲（Detonation Click）
    this._playDetonationClick(now + delay, baseVolume, explosiveType)

    // 2. 低频轰鸣（Rumble）
    this._playRumble(now + delay, 0.15 + delay, baseVolume, chargeKg)

    // 3. 岩石碎裂声（Crackle）
    this._playCrackle(now + delay, 0.01, 0.08, baseVolume * 0.6)
  }

  /**
   * 播放碎片撞击音效（带限流与合并）
   *
   * 限流策略：
   * - 50ms 窗口内的撞击合并为一次播放，音量按累计能量放大
   * - 每秒最多 15 次撞击音效，超出部分丢弃
   * - 防止 200 碎片同时落地导致爆音
   *
   * @param {Object} params
   * @param {number} params.impactSpeed - 撞击速度(m/s)
   * @param {number} params.fragmentSize - 碎片尺寸(m)
   */
  playFragmentImpact(params = {}) {
    if (!this.ctx) return
    const { impactSpeed = 5, fragmentSize = 0.2 } = params
    const nowMs = performance.now()
    const now = this.ctx.currentTime

    // 累计本次撞击能量（½mv² ∝ r³v²）
    const energy = Math.pow(fragmentSize, 3) * impactSpeed * impactSpeed
    this._impactAccumulator += energy

    // 限流：距上次播放 < 50ms → 累积，不立即播放
    if (nowMs - this._lastImpactTime < this._impactMergeWindowMs) {
      return
    }
    // 限流：每秒最多 15 次
    if (nowMs - this._lastImpactTime < 1000 / this._maxImpactRate) {
      return
    }

    // 计算合并后的音量（多碎片叠加时音量放大，上限 0.4）
    const mergedEnergy = this._impactAccumulator
    const volume = Math.min(0.4, 0.02 + mergedEnergy * 0.005)

    // 大块低沉，小块尖锐
    const freqBase = 200 + 2000 * Math.exp(-fragmentSize * 5)

    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    const filter = this.ctx.createBiquadFilter()

    osc.type = 'sine'
    osc.frequency.value = freqBase * (0.8 + Math.random() * 0.4)
    filter.type = 'bandpass'
    filter.frequency.value = freqBase
    filter.Q.value = 2

    gain.gain.setValueAtTime(volume, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)

    osc.start(now)
    osc.stop(now + 0.06)

    // 重置限流状态
    this._lastImpactTime = nowMs
    this._impactAccumulator = 0
  }

  // ─── 内部音效层 ───────────────────────────────────────

  _playDetonationClick(startTime, volume, type) {
    const duration = 0.005
    const bufferSize = Math.floor(this.ctx.sampleRate * duration)
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
    const data = buffer.getChannelData(0)

    // 白噪声脉冲 + 指数衰减
    // 不同炸药类型对应不同衰减速率：emulsion 高频更丰富，anfo 更闷
    const decayRate = type === 'anfo' ? 600 : 800
    for (let i = 0; i < bufferSize; i++) {
      const t = i / this.ctx.sampleRate
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t * decayRate)
    }

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(volume * 0.9, startTime)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
    source.connect(gain)
    gain.connect(this.masterGain)
    source.start(startTime)
  }

  _playRumble(startTime, duration, volume, chargeKg) {
    // 过滤白噪声模拟低频轰鸣
    const bufferSize = Math.floor(this.ctx.sampleRate * duration)
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
    const data = buffer.getChannelData(0)

    const rumbleFreq = 30 + 50 * (chargeKg / 500)  // 装药越大频率越低
    for (let i = 0; i < bufferSize; i++) {
      const t = i / this.ctx.sampleRate
      const envelope = Math.exp(-t * 12)
      data[i] = (Math.random() * 2 - 1) * envelope
        * (0.5 + 0.5 * Math.sin(2 * Math.PI * rumbleFreq * t))
    }

    // 低通滤波（<200Hz）
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 200
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(volume, startTime)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)
    source.start(startTime)
  }

  _playCrackle(startTime, crackleStart, crackleDur, volume) {
    // 高频颗粒噪声 → 岩石碎裂声
    const duration = crackleDur
    const bufferSize = Math.floor(this.ctx.sampleRate * duration)
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
    const data = buffer.getChannelData(0)

    // 稀疏泊松脉冲（高频颗粒）
    // 提高脉冲密度到 3000/s（原 800/s 在 44100Hz 下期望脉冲仅 2.8 个/3.5ms，过稀疏）
    const pulseRate = 3000
    for (let i = 0; i < bufferSize; i++) {
      const t = i / this.ctx.sampleRate
      if (Math.random() < pulseRate / this.ctx.sampleRate) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 50)
      }
    }

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 2000
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(volume, startTime + crackleStart)
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + crackleStart + duration)
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)
    source.start(startTime + crackleStart)
  }

  /** 释放音频资源 */
  dispose() {
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
      this.masterGain = null
    }
  }
}
