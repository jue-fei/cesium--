/**
 * collabIdentity.js —— 跨终端协作身份（前端真源 · 3.2.1）
 *
 * 平台无登录体系：终端 id 由前端生成并持久化到 localStorage，操作员名本地可编辑；
 * 写接口统一经 identityHeaders()/withIdentity() 注入 X-Client-Id / X-Operator，
 * 后端只解析清洗（未带头等价匿名，向后兼容）。契约见
 * shared-consistency-baseline.json#collabCmps（前端 collabContract.test.js 锁定）。
 */
const CLIENT_ID_KEY = 'trae:collab:clientId'
const OPERATOR_KEY = 'trae:collab:operator'

// 与后端 collab/identity.py 一致（契约 collabCmps 锁定）
export const CLIENT_ID_MAX_LEN = 32
export const OPERATOR_MAX_LEN = 24
export const DEFAULT_OPERATOR = '操作员'
const CLIENT_ID_ALLOWED = /[^A-Za-z0-9_-]/g

let _clientId = ''
let _operator = ''

function _store() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

/** 终端 id：优先 localStorage，缺失则生成并持久化（URL 安全字符）。 */
export function getClientId() {
  if (_clientId) return _clientId
  const st = _store()
  let v = st ? st.getItem(CLIENT_ID_KEY) : ''
  if (!v) {
    const rnd =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    v = String(rnd).replace(/-/g, '').slice(0, 12)
    if (st) st.setItem(CLIENT_ID_KEY, v)
  }
  _clientId = String(v).replace(CLIENT_ID_ALLOWED, '').slice(0, CLIENT_ID_MAX_LEN)
  return _clientId
}

/** 操作员显示名：本地可编辑，缺省「操作员」。 */
export function getOperator() {
  if (_operator) return _operator
  const st = _store()
  const v = st ? st.getItem(OPERATOR_KEY) : ''
  _operator = (v || DEFAULT_OPERATOR).slice(0, OPERATOR_MAX_LEN)
  return _operator
}

/** 设置操作员显示名（持久化）；空值回退默认。 */
export function setOperator(name) {
  const v = (String(name ?? '').trim() || DEFAULT_OPERATOR).slice(0, OPERATOR_MAX_LEN)
  _operator = v
  const st = _store()
  if (st) st.setItem(OPERATOR_KEY, v)
  return v
}

/** 身份请求头（终端 id + 操作员名）。 */
export function identityHeaders() {
  return {
    'X-Client-Id': getClientId(),
    // 头部值必须是 ISO-8859-1：操作员名可能含中文 → percent-encode，
    // 后端 identity.parse_identity 用 urllib.parse.unquote 还原（否则 fetch 抛
    // "String contains non ISO-8859-1 code point"）
    'X-Operator': encodeURIComponent(getOperator())
  }
}

/** 在 fetch init 上合并身份头（已有同名头优先，不覆盖调用方显式设置）。 */
export function withIdentity(init = {}) {
  return { ...init, headers: { ...identityHeaders(), ...(init.headers || {}) } }
}
