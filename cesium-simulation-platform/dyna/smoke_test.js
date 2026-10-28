// 冒烟测试（容器口径）
// 原脚本用 DOM/WebGL 桩执行 legacy 页面脚本（webapp/data/*.bin，已下线），现改为：
//   1) 7 个算例容器头 + 首帧解码冒烟；
//   2) 前端关键符号与新增控件存在性检查（防止重构丢失）。
// 用法: node smoke_test.js
const fs = require('fs');
const path = require('path');
const { listCases, checkCase } = require('./tests/validate_container');

const ROOT = path.join(__dirname, 'webapp');
const DIR = path.join(ROOT, 'data_v3');
let bad = 0;

const keys = listCases(DIR);
console.log(`容器算例 ${keys.length} 个: ${keys.join(', ')}`);
for (const key of keys) {
  const r = checkCase(DIR, key, { frames: [0] });
  if (!r.ok) {
    bad++;
    console.log(`[FAIL] ${key}: ${r.issues.length} 项`);
    r.issues.slice(0, 8).forEach(m => console.log('  - ' + m));
  } else {
    console.log(`[OK] ${key} nframes=${r.stats.nframes} fields=${r.stats.fields}`
      + ` frame=${(r.stats.frame_bytes / 1048576).toFixed(2)}MB`);
  }
}

// 前端关键符号（容器加载/渲染/新增交互）
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const symbols = [
  'v3Ensure', 'v3Frame', 'v3RenderFrame', 'v3ApplyFrame',
  'v3BuildFieldBtns', 'v3BuildPartList', 'v3BuildTimeMarks', 'v3SyncUrl',
  'v3DoPick', 'updatePickMarkers', 'exportPickCsv',
  'applyShade', 'setStyle',
];
const miss = symbols.filter(s => !html.includes(s));
if (miss.length) {
  bad++;
  console.log('[FAIL] 前端缺少符号: ' + miss.join(', '));
} else {
  console.log('[OK] 前端关键符号齐备');
}

// 新增控件（导出 / 时间轴标记）
const controls = ['id="btnShot"', 'id="sliderMarks"', 'id="pickCsv"', 'id="pickTools"',
  'id="btnReport"', 'id="impCancel"', 'id="clipNum"', 'id="probeTip"'];
const missCtl = controls.filter(s => !html.includes(s));
if (missCtl.length) {
  bad++;
  console.log('[FAIL] 前端缺少控件: ' + missCtl.join(', '));
} else {
  console.log('[OK] 导出/时间轴/取点控件存在');
}

if (bad) {
  process.exitCode = 1;
  console.log(`\n${bad} 项失败`);
} else {
  console.log('\n=== 冒烟测试通过（容器口径）===');
}
