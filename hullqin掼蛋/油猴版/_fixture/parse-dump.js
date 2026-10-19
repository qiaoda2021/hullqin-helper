// 工具：解析 Edge --dump-dom 输出里 #fixture-result / #result 的文本并返回退出码
'use strict';
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, 'ddz', '_dump.html');
const s = fs.readFileSync(file, 'utf8');
const m = /<pre id="(?:fixture-)?result">([\s\S]*?)<\/pre>/.exec(s);
if (!m) {
  console.log('未找到 #result（页面可能未执行完成）');
  process.exit(2);
}
const text = m[1]
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');
console.log(text);
process.exit(/FAIL\s+0/.test(text) && /PASS\s+\d+/.test(text) ? 0 : 1);
