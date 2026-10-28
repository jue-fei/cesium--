// 一键校验入口（CI 用）：容器 + 数据层 + 粒子 + 前端符号/控件
// 用法: node tests/run_all.js [--with-fixture]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const withFixture = process.argv.includes('--with-fixture');
const steps = [
    ['容器校验（data_v3 全部）', [path.join(__dirname, 'validate_container.js')]],
    ['数据层统计（smooth/presplit）', [path.join(ROOT, 'validate_datalayer.js')]],
    ['粒子链路（sph1/sph2）', [path.join(ROOT, 'validate_sph.js')]],
    ['冒烟（前端符号/控件）', [path.join(ROOT, 'smoke_test.js')]],
];
const fixtureDir = path.join(__dirname, 'fixtures', 'container_v2');
if (withFixture && fs.existsSync(fixtureDir)) {
    steps.push(['fixture 回归（container_v2）', [path.join(__dirname, 'validate_container.js'), fixtureDir]]);
}

let bad = 0;
for (const [name, args] of steps) {
    console.log(`\n=== ${name} ===`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
        bad++;
        console.log(`[FAIL] ${name} exit=${r.status === null ? r.signal : r.status}`);
    }
}
console.log(`\n=== ${bad ? `${bad} 项失败` : '全部通过'} ===`);
process.exitCode = bad ? 1 : 0;
