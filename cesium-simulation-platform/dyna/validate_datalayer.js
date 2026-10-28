// 数据层校验（容器口径）：smooth / presplit
// 原脚本按 legacy webapp/data/*.bin 手拆字节；现改为读 data_v3 自描述容器（与前端同口径）。
// 用法: node validate_datalayer.js
const path = require('path');
const { readContainer, readBlock, decodeFrame, checkCase } = require('./tests/validate_container');

const DIR = path.join(__dirname, 'webapp', 'data_v3');
const KEYS = ['smooth', 'presplit'];
let bad = 0;

for (const key of KEYS) {
  const r = checkCase(DIR, key, { frames: [5] });
  if (!r.ok) {
    bad++;
    console.log(`[FAIL] ${key}: ${r.issues.length} 项`);
    r.issues.slice(0, 10).forEach(m => console.log('  - ' + m));
    continue;
  }
  const c = readContainer(DIR, key);
  const mh = c.mesh.header, fh = c.frames.header;
  const nel = mh.counts.nel;

  // 岩石单元 = part.roles 含 structure 的单元
  const cp = readBlock(c, 'conn_part');
  const rockPids = new Set((mh.parts || [])
    .filter(p => (p.roles || []).includes('structure')).map(p => p.pid));
  let nRock = 0;
  for (let i = 0; i < nel; i++) if (rockPids.has(cp[i])) nRock++;

  const fi = Math.min(5, fh.nframes - 1);
  const { vals } = decodeFrame(fh, c.fb, fi);
  const spec = Object.fromEntries(fh.fields.map(f => [f.id, f]));
  const val = (id, i) => {
    const sp = spec[id];
    if (!sp || !vals[id]) return NaN;
    return sp.dtype === 'u2' ? vals[id][i] * sp.scale + sp.offset : vals[id][i];
  };

  let nD = 0, maxD = 0, maxE = 0, maxP = 0;
  const elemLoc = spec.damage && spec.damage.location === 'element';
  for (let i = 0; i < nel; i++) {
    if (!rockPids.has(cp[i]) || !elemLoc) continue;
    const d = val('damage', i);
    if (d > 0.5) nD++;
    if (d > maxD) maxD = d;
    if (spec.eps) maxE = Math.max(maxE, val('eps', i));
    if (spec.pressure) maxP = Math.max(maxP, Math.abs(val('pressure', i)));
  }
  const usys = mh.units_system || '?';
  console.log(`${key}: 岩石单元 ${nRock}/${nel} | 帧${fi} t=${fh.times[fi]}（原始单位）`
    + ` | D>0.5=${nD} (${(nD / Math.max(nRock, 1) * 100).toFixed(1)}%) maxD=${maxD.toFixed(3)}`
    + ` maxEps=${maxE.toFixed(4)} |p|max=${maxP.toFixed(3)} (${usys})`);
  if (!elemLoc) console.log('  注: 本容器 damage 为 node 级，未做单元统计（重转请加 --field-location element）');
}

if (bad) process.exitCode = 1;
else console.log('\n=== 数据层校验通过（容器口径）===');
