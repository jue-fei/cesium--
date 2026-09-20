/**
 * timeSeriesClient.js —— 时序化工况数据查询客户端（shared）
 *
 * 消费后端 GET /api/timeseries（历史 + 实时统一存储，写入点在业务模块；
 * MySQL/内存后端由后端配置选择，对前端透明）。downsample 枚举与点数
 * 上限契约见 shared-consistency-baseline.json#timeseriesCmps：
 *   raw 原始点（保 7 天）/ 1m 分钟聚合（保 90 天）/ 1h 小时聚合（保 2 年）。
 * 供后续回放时间总线（3.1）、设备健康趋势（2.3）等消费。
 */

/**
 * 查询时序指标。
 * @param {object} opts
 * @param {string} opts.metric 指标名（如 scheduling.muck_stock_t）
 * @param {number} [opts.start] 起始 Unix 秒
 * @param {number} [opts.end] 截止 Unix 秒
 * @param {'raw'|'1m'|'1h'} [opts.downsample] 聚合粒度（缺省 raw）
 * @param {string} [opts.tags] 序列过滤 "k1=v1,k2=v2"
 * @returns {Promise<{code:number, data:{metric, points:Array<{t:number,v:number}>, maxPoints:number, downsampleName:string}}>}
 */
export function fetchTimeseries({ metric, start, end, downsample = 'raw', tags } = {}) {
  const q = new URLSearchParams({ metric, downsample })
  if (start != null) q.set('start', String(start))
  if (end != null) q.set('end', String(end))
  if (tags) q.set('tags', tags)
  return fetch(`/api/timeseries?${q.toString()}`).then(r => r.json())
}

/**
 * 可查指标清单。
 * @returns {Promise<{code:number, data:{metrics:Array<{metric:string, seriesCount:number, pointCount:number, firstTs:number|null, lastTs:number|null, ageS:number|null}>}}>}
 */
export function fetchTimeseriesMetrics() {
  return fetch('/api/timeseries/metrics').then(r => r.json())
}
