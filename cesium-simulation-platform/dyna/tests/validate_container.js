// 容器口径校验器（Node，零依赖；zstd 复用前端 lib/fzstd.js）
// 用途：替代 legacy webapp/data/*.bin 的校验方式，直接校验 data_v3 的自描述容器。
// 用法:
//   node tests/validate_container.js [容器目录] [--key K] [--frames 0,-1] [--quiet]
// 退出码: 0 = 全部通过, 1 = 有失败项
const fs = require('fs');
const path = require('path');
const fzstd = require('../webapp/lib/fzstd.js');

const BPE = { f4: 4, u2: 2, u1: 1, i4: 4 };
const DTYPES = new Set(['f4', 'u2', 'u1']);
const LOCS = new Set(['node', 'element', 'sph', 'pbm']);
const ROLES = new Set(['field', 'mask', 'aux']);
const POP8 = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP8[i] = POP8[i >> 1] + (i & 1);

function parseHeader(buf, magic, magicLen) {
    if (buf.toString('ascii', 0, 4) !== magic.slice(0, 4)) {
        throw new Error(`magic 不符: 期望 ${magic}, 实际 ${JSON.stringify(buf.toString('ascii', 0, 5))}`);
    }
    if (magicLen === 5 && buf.toString('ascii', 4, 5) !== 'F') {
        throw new Error('frames magic 第 5 字节应为 F');
    }
    const len = buf.readUInt32LE(magicLen);
    const start = magicLen + 4;
    if (start + len > buf.length) throw new Error(`header_len 越界: ${len}`);
    const header = JSON.parse(buf.toString('utf8', start, start + len));
    return { header, headerLen: len, base: start + len };
}

function readContainer(dir, key, cache) {
    cache = cache || {};
    if (cache[key]) return cache[key];
    const meshPath = path.join(dir, key + '.mesh.bin');
    const frPath = path.join(dir, key + '.frames.bin');
    for (const p of [meshPath, frPath]) {
        if (!fs.existsSync(p)) throw new Error('缺少文件: ' + p);
    }
    const mb = fs.readFileSync(meshPath);
    const fb = fs.readFileSync(frPath);
    const mesh = parseHeader(mb, 'D2W3', 4);
    const frames = parseHeader(fb, 'D2W3F', 5);
    const c = { dir, key, mb, fb, mesh, frames };
    cache[key] = c;
    return c;
}

function readTyped(buf, base, b) {
    const n = b.len * BPE[b.dtype];
    const o = base + b.offset;
    const seg = buf.subarray(o, o + n);
    if (seg.length !== n) throw new Error('块越界');
    const ab = seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength);
    if (b.dtype === 'f4') return new Float32Array(ab);
    if (b.dtype === 'u2') return new Uint16Array(ab);
    if (b.dtype === 'u1') return new Uint8Array(ab);
    if (b.dtype === 'i4') return new Int32Array(ab);
    return new Uint8Array(ab);
}

function readBlock(container, blockName) {
    const b = container.mesh.header[blockName];
    if (!b) return null;
    try { return readTyped(container.mb, container.mesh.base, b); }
    catch (e) { throw new Error(`mesh.${blockName}: ${e.message}`); }
}

// 读取嵌套块（如 particles[0].nodes / surf_groups[].faces）
function readNestedBlock(container, b) {
    if (!b) return null;
    return readTyped(container.mb, container.mesh.base, b);
}

function decodeFrame(fh, fbuf, idx) {
    const fr = fh.frames[idx];
    if (!fr) throw new Error('帧索引越界: ' + idx);
    if (fh.frames_base == null) throw new Error('缺 frames_base（旧容器不支持）');
    const o = fr.offset;                 // 新容器 frames[].offset 为绝对字节（前端同口径）
    const seg = fbuf.subarray(o, o + fr.len);
    if (seg.length !== fr.len) throw new Error(`帧 ${idx} 越界`);
    const raw = fh.codec === 'zstd' ? Buffer.from(fzstd.decompress(seg)) : Buffer.from(seg);
    if (raw.length !== fh.frame_bytes) {
        throw new Error(`帧 ${idx} 解压长度 ${raw.length} != frame_bytes ${fh.frame_bytes}`);
    }
    const vals = {};
    let off = 0;
    for (const f of fh.fields) {
        const n = f.count * BPE[f.dtype];
        const s = raw.subarray(off, off + n);
        if (s.length !== n) throw new Error(`字段 ${f.id} 长度不足`);
        const ab = s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
        if (f.dtype === 'f4') vals[f.id] = new Float32Array(ab);
        else if (f.dtype === 'u2') vals[f.id] = new Uint16Array(ab);
        else vals[f.id] = new Uint8Array(ab);
        off += n;
    }
    return { vals, raw };
}

function expectedCount(f, counts) {
    const comps = f.comps || 1;
    if (f.role === 'mask') {
        const n = f.location === 'pbm' ? counts.pbm : counts.nel;
        return Math.ceil(n / 8);
    }
    if (f.location === 'node') return counts.numnp * comps;
    if (f.location === 'element') return counts.nel * comps;
    if (f.location === 'sph') return counts.sph * comps;
    if (f.location === 'pbm') return counts.pbm * comps;
    return -1;
}

function checkExpected(dir, key, c) {
    // fixture 目录可带 expected.json（gen_fixtures.py 生成），用于回归比对
    const p = path.join(dir, 'expected.json');
    if (!fs.existsSync(p)) return [];
    let exp;
    try { exp = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return ['expected.json 解析失败: ' + e.message]; }
    if (exp.key && exp.key !== key) return [];
    const issues = [];
    const mh = c.mesh.header, fh = c.frames.header;
    if (exp.counts) {
        for (const k of Object.keys(exp.counts)) {
            const got = (mh.counts || {})[k];
            if (got !== exp.counts[k]) issues.push(`expected.counts.${k}=${got}（应 ${exp.counts[k]}）`);
        }
    }
    if (exp.nframes != null && fh.nframes !== exp.nframes) issues.push(`expected.nframes=${fh.nframes}（应 ${exp.nframes}）`);
    if (exp.frame_bytes != null && fh.frame_bytes !== exp.frame_bytes) issues.push(`expected.frame_bytes=${fh.frame_bytes}（应 ${exp.frame_bytes}）`);
    if (Array.isArray(exp.fields)) {
        const got = new Map(fh.fields.map(f => [f.id, f]));
        for (const e of exp.fields) {
            const g = got.get(e.id);
            if (!g) { issues.push(`expected 字段缺失: ${e.id}`); continue; }
            for (const k of ['dtype', 'location', 'count']) {
                if (e[k] != null && g[k] !== e[k]) issues.push(`expected.${e.id}.${k}=${g[k]}（应 ${e[k]}）`);
            }
        }
    }
    return issues;
}

function checkCase(dir, key, opt) {
    opt = opt || {};
    const issues = [];
    const err = m => issues.push(m);
    const c = readContainer(dir, key);
    const mh = c.mesh.header, fh = c.frames.header;
    const fileMB = c.mb.length, fileFB = c.fb.length;

    // ---- 版本 / 基本头 ----
    if ((mh.schema_version || 1) < 2) err(`mesh.schema_version=${mh.schema_version}（应 ≥2）`);
    if ((fh.schema_version || 1) < 2) err(`frames.schema_version=${fh.schema_version}（应 ≥2）`);
    if (mh.key !== key) err(`mesh.key=${mh.key} 与文件名 ${key} 不一致`);
    const numnp = mh.counts && mh.counts.numnp, nel = mh.counts && mh.counts.nel;
    if (!(numnp > 0) || !(nel > 0)) err('counts.numnp / counts.nel 缺失');
    const parts = mh.particles || [];
    const nSph = parts.filter(p => p.kind === 'sph').reduce((a, p) => a + (p.n || 0), 0);
    const nPbm = parts.filter(p => p.kind === 'pbm').reduce((a, p) => a + (p.n || 0), 0);
    const counts = { numnp, nel, sph: nSph, pbm: nPbm };

    // ---- mesh 块 ----
    const need = (name, len, dt) => {
        const b = mh[name];
        if (!b) return err(`mesh 缺块 ${name}`);
        if (dt && b.dtype !== dt) err(`mesh.${name}.dtype=${b.dtype}（应 ${dt}）`);
        if (len != null && b.len !== len) err(`mesh.${name}.len=${b.len}（应 ${len}）`);
        if (c.mesh.base + b.offset + b.len * BPE[b.dtype] > fileMB) err(`mesh.${name} 越界`);
    };
    need('coords', numnp * 3, 'f4');
    need('node_ids', numnp, 'i4');
    need('elem_ids', nel, 'i4');
    need('conn', nel * 8, 'i4');
    need('conn_part', nel, 'i4');
    for (const g of (mh.surf_groups || [])) {
        const q = g.quads || 0;
        if (!g.faces || g.faces.len !== q * 4) err(`surf_groups[${g.partId}].faces.len 应为 quads*4`);
        if (g.owner_elem && g.owner_elem.len !== q) err(`surf_groups[${g.partId}].owner_elem.len 应为 quads`);
        if (g.ecent && g.ecent.len !== q * 2) err(`surf_groups[${g.partId}].ecent.len 应为 quads*2`);
        for (const k of ['faces', 'owner_elem', 'ecent']) {
            const b = g[k];
            if (b && c.mesh.base + b.offset + b.len * BPE[b.dtype] > fileMB) err(`surf_groups[${g.partId}].${k} 越界`);
        }
    }
    for (const p of parts) {
        if (!p.n) err(`particle ${p.kind} 缺少 n`);
        if (p.nodes && p.nodes.len !== p.n) err(`particle ${p.kind}.nodes.len=${p.nodes.len}（应 ${p.n}）`);
        if (p.pos0 && p.pos0.len !== p.n * 3) err(`particle ${p.kind}.pos0.len 应为 n*3`);
    }

    // ---- frames 头 ----
    if (fh.key !== key) err(`frames.key=${fh.key} 与文件名 ${key} 不一致`);
    if (!Array.isArray(fh.times) || fh.times.length !== fh.nframes) err('times 长度 != nframes');
    if (!(fh.nframes > 0)) err('nframes 非正');
    if (fh.frames_base !== 5 + 4 + fh.header_reserve) err(`frames_base=${fh.frames_base}（应 9+header_reserve）`);
    if (!Array.isArray(fh.frames) || fh.frames.length !== fh.nframes) err('frames[] 长度 != nframes');
    let sumBytes = 0;
    for (const f of fh.fields) {
        if (!DTYPES.has(f.dtype)) err(`字段 ${f.id}.dtype=${f.dtype} 非法`);
        if (!LOCS.has(f.location)) err(`字段 ${f.id}.location=${f.location} 非法`);
        if (f.role && !ROLES.has(f.role)) err(`字段 ${f.id}.role=${f.role} 非法`);
        if (!(f.count > 0)) err(`字段 ${f.id}.count 非正`);
        const exp = expectedCount(f, counts);
        if (exp >= 0 && f.count !== exp) err(`字段 ${f.id}.count=${f.count}（应 ${exp}）`);
        if (f.dtype === 'u2' && !(f.scale > 0)) err(`字段 ${f.id} 为 u2 但 scale=${f.scale}`);
        sumBytes += f.count * BPE[f.dtype];
    }
    if (sumBytes !== fh.frame_bytes) err(`字段总字节 ${sumBytes} != frame_bytes ${fh.frame_bytes}`);
    for (let i = 0; i < fh.frames.length; i++) {
        const fr = fh.frames[i];
        if (fr.usize !== fh.frame_bytes) err(`frames[${i}].usize=${fr.usize} != frame_bytes`);
        if (!(fr.len > 0)) err(`frames[${i}].len 非正`);
        if (fr.offset < fh.frames_base) err(`frames[${i}].offset=${fr.offset} 落在头部区（应 ≥ frames_base）`);
        if (fr.offset + fr.len > fileFB) err(`frames[${i}] 越界`);
    }
    if (fh.globals_all) {
        const g = fh.globals_all;
        if (g.len !== fh.nframes * fh.globals_words) err(`globals_all.len=${g.len}（应 nframes*words）`);
        if (fh.frames_base + g.offset + g.len * 8 > fileFB) err('globals_all 越界');
    } else {
        err('缺 globals_all 块');
    }
    const energy = fh.energy;
    if (energy) {
        for (const k of ['ke', 'ie', 'te']) {
            if (!Array.isArray(energy[k]) || energy[k].length !== fh.nframes) err(`energy.${k} 长度 != nframes`);
        }
    }
    if (fh.damage_frac && fh.damage_frac.length !== fh.nframes) err('damage_frac 长度 != nframes');

    // ---- 抽样解码 ----
    const frames = (opt.frames && opt.frames.length) ? opt.frames.map(i => (i < 0 ? fh.nframes + i : i)) : [0, fh.nframes >> 1, fh.nframes - 1];
    const uniq = [...new Set(frames.filter(i => i >= 0 && i < fh.nframes))];
    const stats = { key, nframes: fh.nframes, fields: fh.fields.length, frame_bytes: fh.frame_bytes, samples: [] };
    for (const idx of uniq) {
        try {
            const { vals } = decodeFrame(fh, c.fb, idx);
            let alive = null;
            const mf = fh.fields.find(f => f.id === 'active_mask');
            if (mf && vals.active_mask) {
                alive = 0;
                for (let i = 0; i < vals.active_mask.length; i++) alive += POP8[vals.active_mask[i]];
                if (alive === 0) err(`帧 ${idx} active_mask 全 0`);
                if (alive > nel) err(`帧 ${idx} active=${alive} > nel=${nel}`);
            }
            for (const [fid, arr] of Object.entries(vals)) {
                if (fid === 'active_mask' || fid === 'pbm_active') continue;
                for (let i = 0; i < arr.length; i++) {
                    if (!Number.isFinite(arr[i])) { err(`帧 ${idx} 字段 ${fid} 含非有限值`); break; }
                }
            }
            stats.samples.push({ idx, alive });
        } catch (e) {
            err(`帧 ${idx} 解码失败: ${e.message}`);
        }
    }
    for (const m of checkExpected(dir, key, c)) issues.push(m);
    return { ok: issues.length === 0, key, issues, stats, header: { mesh: mh, frames: fh } };
}

function listCases(dir) {
    const p = path.join(dir, 'cases.json');
    if (!fs.existsSync(p)) throw new Error('缺少 cases.json: ' + p);
    const cj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.keys(cj).filter(k => cj[k] && cj[k].nframes);
}

function main() {
    const args = process.argv.slice(2);
    let dir = path.join(__dirname, '..', 'webapp', 'data_v3');
    let only = null, quiet = false;
    const framesArg = args.find(a => a === '--frames' || a.startsWith('--frames='));
    let frames = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--key') only = args[++i];
        else if (a === '--frames') frames = args[++i].split(',').map(Number);
        else if (a.startsWith('--frames=')) frames = a.split('=')[1].split(',').map(Number);
        else if (a === '--quiet') quiet = true;
        else if (!a.startsWith('--') && fs.existsSync(a)) dir = a;
    }
    const keys = only ? [only] : listCases(dir);
    let bad = 0;
    console.log(`校验目录: ${dir}  (${keys.length} 例)`);
    for (const key of keys) {
        let r;
        try { r = checkCase(dir, key, { frames }); }
        catch (e) {
            bad++; console.log(`[FAIL] ${key}: ${e.message}`); continue;
        }
        if (r.ok) {
            if (!quiet) {
                const s = r.stats;
                console.log(`[OK] ${key}: nframes=${s.nframes} fields=${s.fields} frame=${(s.frame_bytes / 1048576).toFixed(2)}MB`
                    + s.samples.map(x => ` | f${x.idx}${x.alive != null ? ` active=${x.alive}` : ''}`).join(''));
            }
        } else {
            bad++;
            console.log(`[FAIL] ${key}: ${r.issues.length} 项`);
            r.issues.slice(0, 12).forEach(m => console.log('   - ' + m));
            if (r.issues.length > 12) console.log(`   ... 其余 ${r.issues.length - 12} 项省略`);
        }
    }
    if (bad) { console.log(`\n${bad} 个算例未通过`); process.exitCode = 1; }
    else console.log('\n=== 容器校验通过 ===');
}

module.exports = { readContainer, readBlock, readNestedBlock, decodeFrame, checkCase, listCases, BPE };
if (require.main === module) {
    try { main(); } catch (e) { console.log('[FATAL] ' + e.message); process.exitCode = 1; }
}
