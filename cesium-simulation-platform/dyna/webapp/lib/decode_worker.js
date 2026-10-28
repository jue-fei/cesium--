/* 帧解码工作线程（module worker）：zstd 解压 + u2→f32 换算全部移出主线程
 *
 * 解码器优先级：WASM zstd（zstddec，实测比纯 JS 快 2~4×）→ fzstd 兜底。
 *   airblast 2.9MB   fzstd 97ms → wasm 29ms
 *   smooth  10.9MB   fzstd 136ms → wasm 41ms
 *   sph1    28.7MB   fzstd 317ms → wasm 138ms
 * 放在主线程会让播放时的渲染循环被整段阻塞 → 动画一卡一卡；这里全程离线程。
 *
 * 协议（主线程 → 线程）：
 *   {id, buf: ArrayBuffer(压缩帧), codec: 'zstd'|'none', usize: 解压后字节,
 *    plan: [{id, off, dtype, count, scale, offset}]}
 * 协议（线程 → 主线程，transfer 移交所有权）：
 *   {id, buf: ArrayBuffer(解压后帧), conv: {fieldId: Float32Array}}
 *   conv 只含 u2 字段（需要换算）；其余字段主线程直接用 buf + off 建视图，零拷贝。
 *   失败：{id, error}
 */
import { ZSTDDecoder } from './zstddec.mjs';

let wasm = null;
let fallbackLoading = null;

const ready = (async () => {
  try {
    const d = new ZSTDDecoder();
    await d.init();
    wasm = d;
  } catch (e) {
    wasm = null;                       // WASM 不可用（CSP / 老浏览器）→ 走 fzstd
  }
})();

async function ensureFallback() {
  if (self.fzstd) return self.fzstd;
  if (!fallbackLoading) {
    fallbackLoading = import('./fzstd.js').then(() => {
      if (!self.fzstd) throw new Error('fzstd 加载失败');
      return self.fzstd;
    });
  }
  return fallbackLoading;
}

function decompress(src, usize) {
  if (wasm) {
    try { return wasm.decode(src, usize || 0); }
    catch (e) { /* 单帧异常 → 走兜底 */ }
  }
  if (self.fzstd) return self.fzstd.decompress(src);
  throw new Error('zstd 解码失败（WASM 与 fzstd 均不可用）');
}

self.onmessage = async function (e) {
  const msg = e.data || {};
  const id = msg.id;
  try {
    await ready;
    const src = new Uint8Array(msg.buf);
    let out;
    if (msg.codec === 'zstd') {
      if (!wasm) await ensureFallback();
      out = decompress(src, msg.usize);
    } else {
      out = src;
    }

    // 统一成「byteOffset 为 0 的独立 ArrayBuffer」：WASM 路径返回 heap.slice() 副本，
    // fzstd 通常也是独立缓冲；非独立时才复制一次。
    let buf = out.buffer;
    let base = out.byteOffset;
    if (base !== 0 || buf.byteLength !== out.byteLength) {
      buf = out.slice().buffer;
      base = 0;
    }

    const conv = {};
    const transfer = [buf];
    for (const p of (msg.plan || [])) {
      if (p.dtype !== 'u2') continue;                 // f4/i4/u1 主线程建视图，零拷贝
      const dst = new Float32Array(p.count);
      const sc = p.scale, of = p.offset;
      const start = base + p.off;
      if (start % 2 === 0) {                          // 对齐 → 直接建 Uint16 视图
        const raw = new Uint16Array(buf, start, p.count);
        for (let i = 0; i < p.count; i++) dst[i] = raw[i] * sc + of;
      } else {
        // 非 2 字节对齐（如 sph2：active_mask 为 u1 且字节数为奇数，其后字段偏移为奇数）
        // Uint16Array 构造会抛 "start offset should be a multiple of 2"，改用 DataView 逐元素读
        const dv = new DataView(buf);
        for (let i = 0; i < p.count; i++) dst[i] = dv.getUint16(start + i * 2, true) * sc + of;
      }
      conv[p.id] = dst;
      transfer.push(dst.buffer);
    }
    self.postMessage({ id: id, buf: buf, conv: conv }, transfer);
  } catch (err) {
    self.postMessage({ id: id, error: String((err && err.message) || err) });
  }
};
