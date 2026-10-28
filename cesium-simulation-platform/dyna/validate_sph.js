// SPH / PBM 粒子链路校验（容器口径）
// 校验：粒子节点块、pos0 与 coords 一致性、末帧粒子字段峰值、PBM 可见掩膜。
// 用法: node validate_sph.js
const path = require('path');
const { readContainer, readBlock, readNestedBlock, decodeFrame, checkCase } = require('./tests/validate_container');

const DIR = path.join(__dirname, 'webapp', 'data_v3');
const KEYS = ['sph1', 'sph2'];
let bad = 0;

for (const key of KEYS) {
  const r = checkCase(DIR, key, { frames: [0, -1] });
  if (!r.ok) {
    bad++;
    console.log(`[FAIL] ${key}: ${r.issues.length} 项`);
    r.issues.slice(0, 10).forEach(m => console.log('  - ' + m));
    continue;
  }
  const c = readContainer(DIR, key);
  const mh = c.mesh.header, fh = c.frames.header;
  const sph = (mh.particles || []).find(p => p.kind === 'sph');
  const pbm = (mh.particles || []).find(p => p.kind === 'pbm');

  // 粒子节点块（D9 修复后的权威来源）+ pos0 ↔ coords 抽样核对
  const coords = readBlock(c, 'coords');
  const sphNodes = sph ? readNestedBlock(c, sph.nodes) : null;
  let maxDiff = 0;
  if (sph && sphNodes && sph.pos0) {
    const pos0 = readNestedBlock(c, sph.pos0);
    const step = Math.max(1, Math.floor(sph.n / 200));
    for (let i = 0; i < sph.n; i += step) {
      const nd = sphNodes[i] * 3, b = i * 3;
      maxDiff = Math.max(maxDiff,
        Math.abs(pos0[b] - coords[nd]),
        Math.abs(pos0[b + 1] - coords[nd + 1]),
        Math.abs(pos0[b + 2] - coords[nd + 2]));
    }
  }

  // 首/末帧粒子字段峰值 + PBM 可见数
  const idx = fh.nframes - 1;
  const { vals } = decodeFrame(fh, c.fb, idx);
  const spec = Object.fromEntries(fh.fields.map(f => [f.id, f]));
  const peak = id => {
    const sp = spec[id], a = vals[id];
    if (!sp || !a) return null;
    let mx = 0;
    for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && a[i] > mx) mx = a[i];
    return sp.dtype === 'u2' ? mx * sp.scale + sp.offset : mx;
  };
  const countBits = (mask, n) => {
    if (!mask || !n) return null;
    let s = 0;
    for (let i = 0; i < n; i++) if ((mask[i >> 3] >> (i & 7)) & 1) s++;
    return s;
  };
  const fmt = v => (v == null ? '—' : (Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toFixed(3)));
  const nPbm = pbm ? pbm.n : 0;

  console.log(`${key}: SPH=${sph ? sph.n : 0} PBM=${nPbm} | nodes块=${sphNodes ? sphNodes.length : '无'}`
    + ` | pos0↔coords maxdiff=${maxDiff.toExponential(1)}`
    + ` | 末帧 sphDensity=${fmt(peak('sph_density'))} sphDamage=${fmt(peak('sph_damage'))}`
    + ` pbmP=${fmt(peak('pbm_pressure'))} pbm可见=${countBits(vals.pbm_active, nPbm)}/${nPbm}`);
  if (maxDiff > 1e-3) {
    bad++;
    console.log('  - pos0 与 coords 不一致（节点块映射可能有误）');
  }
  if (sph && !sphNodes) console.log('  注: 无 particles[].nodes 块（旧容器）；前端会回退 node_start');
}

if (bad) process.exitCode = 1;
else console.log('\n=== 粒子链路校验通过（容器口径）===');
