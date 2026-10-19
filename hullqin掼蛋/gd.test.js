#!/usr/bin/env node
/*!
 * 掼蛋助手聚合测试入口 gd.test.js
 * 依次运行各测试文件，汇总 PASS/FAIL，全部通过退出码 0。
 * 运行：node gd.test.js
 * 只跑某个：node gd.test.js core   （core / ai / deepseek / verify / all）
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SUITES = [
  { key: 'core', file: 'gd.core.test.js', title: '引擎 gd.core.js' },
  { key: 'ai', file: 'gd.ai.test.js', title: '本地 AI gd.ai.js' },
  { key: 'deepseek', file: 'gd.deepseek.test.js', title: 'DeepSeek 接入 gd.deepseek.js' },
  { key: 'verify', file: 'gd.verify.test.js', title: '独立黑盒验收 gd.verify.test.js' }
];

const arg = (process.argv[2] || 'all').toLowerCase();
let suites = SUITES;
if (arg !== 'all') {
  suites = SUITES.filter(function (s) { return s.key === arg || s.file === arg; });
  if (!suites.length) {
    console.error('未知测试套件：' + arg + '（可选 core / ai / deepseek / verify / all）');
    process.exit(2);
  }
}

const results = [];
let totalPassed = 0;
let totalFailed = 0;
let failedSuites = 0;

console.log('掼蛋助手 · 聚合测试');
console.log('node ' + process.version + ' · ' + path.basename(__filename));
console.log('='.repeat(48));

suites.forEach(function (suite, i) {
  const file = path.join(ROOT, suite.file);
  console.log('\n▶ [' + (i + 1) + '/' + suites.length + '] ' + suite.title + '（' + suite.file + '）');
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: Object.assign({}, process.env, { GD_TEST_NO_NETWORK: '1' })
  });
  const cost = Date.now() - started;
  const stdout = (res.stdout || '').trimEnd();
  const stderr = (res.stderr || '').trimEnd();
  if (stdout) console.log(stdout);
  if (stderr) console.log(stderr);

  // 从输出里解析 PASS/FAIL 计数（各测试文件都打印 `PASS <n> / FAIL <n>`）
  const m = /PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(stdout) || /PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(stderr);
  const pass = m ? parseInt(m[1], 10) : 0;
  const fail = m ? parseInt(m[2], 10) : 0;
  const exitCode = typeof res.status === 'number' ? res.status : 1;
  const okSuite = exitCode === 0 && fail === 0 && pass > 0;

  totalPassed += pass;
  totalFailed += fail;
  if (!okSuite) failedSuites++;

  results.push({
    key: suite.key,
    title: suite.title,
    file: suite.file,
    pass: pass,
    fail: fail,
    exitCode: exitCode,
    cost: cost,
    ok: okSuite,
    timedOut: res.error && res.error.code === 'ETIMEDOUT'
  });

  console.log('  结果：' + (okSuite ? '✅ PASS' : '❌ FAIL') + ' · 断言 ' + pass + ' 通过 / ' + fail + ' 失败 · exitCode ' + exitCode + ' · ' + cost + 'ms');
});

console.log('\n' + '='.repeat(48));
console.log('汇总：');
results.forEach(function (r) {
  console.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.title + '：PASS ' + r.pass + ' / FAIL ' + r.fail + (r.timedOut ? '（超时）' : '') + '（exitCode ' + r.exitCode + '）');
});
console.log('  ' + '-'.repeat(44));
console.log('  合计断言：' + (totalPassed + totalFailed) + ' 条 · PASS ' + totalPassed + ' / FAIL ' + totalFailed);
console.log('  套件：' + (suites.length - failedSuites) + '/' + suites.length + ' 通过');

if (failedSuites === 0) {
  console.log('\n✅ 全部测试通过');
  process.exitCode = 0;
} else {
  console.log('\n❌ 存在失败套件，见上方输出');
  process.exitCode = 1;
}
