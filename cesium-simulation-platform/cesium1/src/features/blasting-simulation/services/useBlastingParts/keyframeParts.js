/**
 * 关键帧回放域工厂（全速预计算就绪监听）
 *
 * 从 useBlasting() 拆出的"关键帧回放就绪监听"职责区：预计算（Worker 全速烘焙
 * 整段物理）完成后轮询置位 replayReady，期间若用户点了播放则等待完成后自动开始
 * （保证首播即关键帧回放）。
 *
 * 状态归属：replayReady/replayPrecompute 为模块级响应式单例（直接共享），
 * precomputePollTimer 与 pendingAutoStart 为 let 重绑定句柄，仍驻留
 * useBlasting.js 模块作用域，经 ctx 存取器读写。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.playback.startPlayback （预计算就绪且用户在等待期间点了播放时自动开播）
 */
export function createKeyframeParts(ctx) {
  const {
    replayReady,
    replayPrecompute,
    getManager,
    getPrecomputePollTimer,
    setPrecomputePollTimer,
    getPendingAutoStart,
    setPendingAutoStart
  } = ctx

  // ─── 关键帧回放就绪监听（全速预计算） ──────────────
  // 预计算（Worker 全速烘焙整段物理）完成后轮询置位 replayReady，
  // 期间若用户点了播放则等待完成后自动开始（保证首播即关键帧回放）。
  // precomputePollTimer 为模块级单例（见文件头部"单例可变状态"块）。

  const _pollPrecompute = () => {
    const mgr = getManager()
    if (!mgr) return
    const ready = !!mgr.isBlastReplayReady?.()
    const prog = mgr.getReplayProgress?.() || { active: false, pct: 0 }
    replayReady.value = ready
    if (prog.active !== replayPrecompute.value.active || prog.pct !== replayPrecompute.value.pct) {
      replayPrecompute.value = { active: prog.active, pct: prog.pct }
    }
    if (ready) {
      if (getPendingAutoStart()) {
        setPendingAutoStart(false)
        ctx.playback.startPlayback()
      }
      stopPrecomputeWatch()
    }
  }

  const startPrecomputeWatch = () => {
    stopPrecomputeWatch()
    const mgr = getManager()
    if (!mgr) return
    const ready = !!mgr.isBlastReplayReady?.()
    replayReady.value = ready
    replayPrecompute.value = mgr.getReplayProgress?.() || { active: false, pct: 0 }
    if (!ready) {
      setPrecomputePollTimer(setInterval(_pollPrecompute, 500))
    }
  }

  const stopPrecomputeWatch = () => {
    const timer = getPrecomputePollTimer()
    if (timer) {
      clearInterval(timer)
      setPrecomputePollTimer(null)
    }
  }

  return {
    startPrecomputeWatch,
    stopPrecomputeWatch
  }
}
