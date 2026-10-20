// 拼装掼蛋 AI 油猴脚本：公共模块（hullqin-shared）+ 站点规则引擎 + 本地 AI + DeepSeek 适配 + 面板 UI + 桥接
'use strict';
const path = require('path');
const fs = require('fs');
const { buildUserScript } = require('../../hullqin-shared/build-lib.js');

const OUT_FILE = path.join(__dirname, '掼蛋AI助手.user.js');
const BODY_FILE = path.join(__dirname, 'userscript.body.js');

/** 读取源码里硬编码的 API Key（只匹配代码行，避免匹配到注释里的示例） */
function readHardcodedKey(text) {
  const m = /^\s{2}const HARDCODED_API_KEY = ['"]([^'"]*)['"]/m.exec(text || '');
  return m ? m[1] : '';
}

// 构建会覆盖产物：先记下上一次产物里的 Key，供构建后回填
const prevKey = fs.existsSync(OUT_FILE) ? readHardcodedKey(fs.readFileSync(OUT_FILE, 'utf8')) : '';

buildUserScript({
  name: '掼蛋 AI 助手（game.hullqin.cn）',
  namespace: 'guandan-ai-helper',
  version: '1.1.0',
  description: '桌游合集掼蛋的 AI 助手：📋记牌器 + 👁透视（可开关，查看三家手牌与炸弹预警）+ 💡出牌提示（本地启发式）+ 🌐DeepSeek 建议 + 🤖自动托管；牌型/回放/进贡还贡规则 1:1 逆向自游戏源码；仅在掼蛋玩法（rule=2）显示。朋友间娱乐使用。',
  connects: ['api.deepseek.com'],
  modules: [
    path.join(__dirname, '..', 'gd.deepseek.js'),
    path.join(__dirname, 'gd.site.core.js'),
    path.join(__dirname, 'gd.site.esp.js'),
    path.join(__dirname, 'gd.site.ai.js'),
    path.join(__dirname, 'gd.site.remote.js'),
    path.join(__dirname, 'gd.site.ui.js'),
  ],
  body: path.join(__dirname, 'userscript.body.js'),
  // 注意：不用 build-lib 的 epilogue 一次性挂载，改由 userscript.body.js 里的
  // watchRoute() 做 SPA 路由感知挂载（从首页点进房间时也能出现面板，且不会重复挂载）。
  outFile: OUT_FILE,
});

/* ------------------------------------------------------------------
 * 构建后处理：保留 HARDCODED_API_KEY
 * 如果你把 Key 直接填在上一次生成的 .user.js 里（而不是 userscript.body.js），
 * 重新构建时这里会自动沿用旧产物里的 Key，避免被空值冲掉。
 * 注意：Key 只在本地明文保存，请勿把填了 Key 的 .user.js 发给别人。
 * ------------------------------------------------------------------ */
const bodyKey = fs.existsSync(BODY_FILE) ? readHardcodedKey(fs.readFileSync(BODY_FILE, 'utf8')) : '';
if (!bodyKey && prevKey) {
  const out = fs.readFileSync(OUT_FILE, 'utf8');
  const patched = out.replace(/(^\s{2})const HARDCODED_API_KEY = '';/m, function (all, indent) {
    return indent + "const HARDCODED_API_KEY = '" + prevKey + "';";
  });
  if (patched !== out) {
    fs.writeFileSync(OUT_FILE, patched, 'utf8');
    console.log('（构建后处理）沿用上次产物里的 HARDCODED_API_KEY（长度 ' + prevKey.length + '）');
  }
}
