/**
 * scenarioConfig.js —— 现场调度场景配置获取（前端单一事实来源）
 *
 * 巷道/装载点/设备/分层/布局等全部"可替换内容"由后端 config/scenario_<名>.json 统一维护，
 * 通过 GET /api/scheduling/config?scenario=<名> 下发。前端据此自动构建巷道图布局与渲染，
 * NSGA-III 算法按快照候选自动适配——新增巷道只需新增场景 JSON，无需改前端代码。
 */

let _cache = null
let _inflight = null

/**
 * 拉取（并缓存）场景配置。同一会话内重复调用直接命中缓存。
 * @param {string} scenario 场景名（对应后端 config/scenario_<名>.json，缺省 ashale）
 * @returns {Promise<object|null>} 完整场景配置；请求失败返回 null（不抛出，避免阻塞渲染）
 */
export function fetchScenarioConfig(scenario = 'ashale') {
  const url = `/api/scheduling/config?scenario=${encodeURIComponent(scenario)}`
  if (_cache) return Promise.resolve(_cache)
  if (_inflight) return _inflight
  _inflight = fetch(url)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(json => {
      _cache = json && json.code === 0 ? json.data : null
      return _cache
    })
    .catch(err => {
      console.warn('[scenarioConfig] 获取场景配置失败，巷道图将使用空布局:', err)
      _cache = null
      return null
    })
    .finally(() => {
      _inflight = null
    })
  return _inflight
}

/** 同步读取已缓存的场景配置（未拉取或失败返回 null）。 */
export function getScenarioConfig() {
  return _cache
}
