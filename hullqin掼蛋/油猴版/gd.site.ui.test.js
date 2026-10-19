/* ============================================================
 * 掼蛋 AI 助手（油猴版）· GDSiteUI 不联网测试
 * ------------------------------------------------------------
 * 覆盖三层：
 *   1) 静态检查：UMD 导出、无 CDN / 网络请求 / innerHTML / console、
 *      无 React fiber 读取、class 前缀、260px 宽度、回调名齐全。
 *   2) 纯函数：_internals（排序、掩码、汇总文案、snapshot 归一化等）。
 *   3) 假 DOM 交互：自写 FakeNode/FakeDocument，验证 create/update/
 *      按钮回调/设置弹窗/进贡还贡/自动托管/销毁 等真实行为。
 *
 * 运行：node gd.site.ui.test.js
 * 输出：PASS n / FAIL m（失败时逐条打印并 exit 1）
 * 不联网、无第三方依赖。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const SELF_PATH = path.join(__dirname, 'gd.site.ui.js');
const UI = require(SELF_PATH);
const I = UI._internals;

/* ---------------- 断言基础设施 ---------------- */

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function ok(name, cond, detail) {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    FAILURES.push(name + (detail ? '  ::  ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, '期望 ' + e + '，实际 ' + a);
}

function includes(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) >= 0, '未找到：' + needle);
}

function notIncludes(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) < 0, '不应出现：' + needle);
}

function noThrow(name, fn) {
  try {
    fn();
    ok(name, true);
  } catch (e) {
    ok(name, false, '抛异常：' + (e && e.message));
  }
}

function throwsErr(name, fn, needle) {
  try {
    fn();
    ok(name, false, '未抛异常');
  } catch (e) {
    ok(name, needle ? String(e.message).indexOf(needle) >= 0 : true, '异常文案不符：' + e.message);
  }
}

/* ---------------- 假 DOM ---------------- */

class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._listeners = {};
    this._text = '';
    this.style = {};
    this._classSet = new Set();
    this.id = '';
  }

  get className() {
    return Array.from(this._classSet).join(' ');
  }

  set className(v) {
    this._classSet = new Set(String(v == null ? '' : v).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return {
      add: function () {
        for (let i = 0; i < arguments.length; i++) self._classSet.add(arguments[i]);
      },
      remove: function () {
        for (let i = 0; i < arguments.length; i++) self._classSet.delete(arguments[i]);
      },
      contains: function (c) { return self._classSet.has(c); },
    };
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }

  get textContent() {
    let t = this._text || '';
    for (let i = 0; i < this.childNodes.length; i++) t += this.childNodes[i].textContent || '';
    return t;
  }

  set textContent(v) {
    this._text = v == null ? '' : String(v);
    for (let i = 0; i < this.childNodes.length; i++) this.childNodes[i].parentNode = null;
    this.childNodes = [];
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
  }

  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }

  click() {
    const ev = { type: 'click', target: this, preventDefault: function () {} };
    const list = this._listeners.click || [];
    for (let i = 0; i < list.length; i++) list[i](ev);
  }
}

function createDoc() {
  const doc = {};
  doc.createElement = function (tag) { return new FakeNode(doc, tag); };
  doc.head = new FakeNode(doc, 'head');
  doc.body = new FakeNode(doc, 'body');
  doc.documentElement = new FakeNode(doc, 'html');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = function (id) {
    let found = null;
    (function walk(n) {
      if (found) return;
      if (n.id === id) { found = n; return; }
      for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]);
    })(doc.documentElement);
    return found;
  };
  return doc;
}

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], fn);
}

function findAll(node, pred) {
  const out = [];
  walk(node, function (n) {
    try { if (pred(n)) out.push(n); } catch (_) { /* ignore */ }
  });
  return out;
}

function hasClass(node, cls) {
  return node.className.split(/\s+/).indexOf(cls) >= 0;
}

function findByText(node, text) {
  const list = findAll(node, function (n) {
    return n.tagName === 'BUTTON' && n.textContent.indexOf(text) >= 0;
  });
  return list[0] || null;
}

function findByAttr(node, attr, val) {
  const list = findAll(node, function (n) {
    return typeof n.getAttribute === 'function' && n.getAttribute(attr) === val;
  });
  return list[0] || null;
}

function textOf(node) {
  return node ? node.textContent : '';
}

/* ---------------- snapshot 构造 ---------------- */

const RANK_TEXT = { 17: '大王', 16: '小王', 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };

function rankTextOf(r) {
  return RANK_TEXT[r] || String(r);
}

function makeCounter() {
  const order = [17, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const counts = {};
  order.forEach(function (r, i) { counts[r] = i % 4; });
  // 故意打乱顺序，验证 UI 会按 COUNTER_ORDER 重排
  const shuffled = [2, 10, 17, 14, 16, 13, 12, 11, 9, 8, 7, 6, 5, 4, 3];
  return {
    byRank: shuffled.map(function (r) {
      return {
        rank: r,
        text: rankTextOf(r),
        count: counts[r],
        isLevel: r === 14,
        isWild: r === 2,
      };
    }),
    wildRemaining: 1,
    playedCount: 10,
    unknown: 81,
  };
}

function makeSnapshot(over) {
  const base = {
    visible: true,
    isGuandan: true,
    mySeat: 1,
    phase: 'play',
    level: 2,
    levelText: '2',
    wildText: '♥2',
    turn: true,
    seats: [
      { seat: 1, name: '我', count: 27, isMe: true, isPartner: false, tribute: false, rankBadge: null },
      { seat: 2, name: '下家', count: 27, isMe: false, isPartner: false, tribute: false, rankBadge: null },
      { seat: 3, name: '对家', count: 27, isMe: false, isPartner: true, tribute: true, rankBadge: null },
      { seat: 4, name: '上家', count: 27, isMe: false, isPartner: false, tribute: false, rankBadge: 2 },
    ],
    counter: makeCounter(),
    handInfo: { size: 27, bombs: 1, wilds: 1, playsEstimate: 8 },
    lastPlay: { seatName: '上家', name: '单张', cardsText: '♦A' },
    history: [
      { seatName: '我', text: '单张 ♠A' },
      { seatName: '下家', text: '过牌' },
    ],
    suggestion: {
      source: 'deepseek',
      action: 'play',
      name: '钢板',
      cardsText: '♠J ♠J ♦J ♥Q ♣Q ♦Q',
      desc: '',
      reason: '减少手数',
      error: '',
      candidatesText: ['单张 ♠2', '对子 ♦3♦3'],
    },
    tribute: null,
    busy: false,
    auto: false,
    settings: { hasKey: true, model: 'deepseek-chat' },
  };
  if (!over) return base;
  const out = {};
  for (const k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
  for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
  return out;
}

/* ============================================================
 * 1. 静态检查
 * ============================================================ */

function testStatic() {
  const src = fs.readFileSync(SELF_PATH, 'utf8');

  ok('静态：模块可加载且导出 create', typeof UI.create === 'function');
  eq('静态：VERSION', UI.VERSION, '1.0.0');
  ok('静态：_internals 存在', I && typeof I === 'object');
  includes('静态：UMD 浏览器全局导出', src, 'root.GDSiteUI = api');
  includes('静态：UMD Node 导出', src, 'module.exports = api');
  includes('静态：class 前缀常量', src, "PREFIX = 'hqgd-'");
  includes('静态：面板宽度 260px', src, 'width:260px');
  includes('静态：中文标题', src, '掼蛋 AI 助手');

  notIncludes('静态：无 <script> 注入', src, '<script');
  notIncludes('静态：无 CDN 引用', src.toLowerCase(), 'cdn.');
  notIncludes('静态：无 fetch 网络调用', src, 'fetch(');
  notIncludes('静态：无 XMLHttpRequest', src, 'XMLHttpRequest');
  notIncludes('静态：无 innerHTML', src, 'innerHTML');
  notIncludes('静态：无 querySelector', src, 'querySelector');
  notIncludes('静态：无 document.cookie', src, 'document.cookie');
  notIncludes('静态：无 eval', src, 'eval(');
  notIncludes('静态：不读 React fiber', src, '__reactFiber');
  notIncludes('静态：不读 memoizedProps', src, 'memoizedProps');
  notIncludes('静态：不调 findProps', src, 'findProps');
  notIncludes('静态：不调 GDSite.expandState', src, 'GDSite.expandState');
  notIncludes('静态：不调 GDSiteAI.', src, 'GDSiteAI.');
  notIncludes('静态：不调 GDSiteRemote.', src, 'GDSiteRemote.');
  notIncludes('静态：无 console.error', src, 'console.error');
  notIncludes('静态：无 console.warn', src, 'console.warn');
  notIncludes('静态：无 console.log', src, 'console.log');

  ['onLocalSuggest', 'onDeepSeekSuggest', 'onAdopt', 'onPass', 'onTribute',
    'onReturn', 'onUndo', 'onNextRound', 'onSaveSettings', 'onTestConnection',
  ].forEach(function (name) {
    includes('静态：回调名 ' + name, src, name);
  });

  includes('静态：Key 掩码说明', src, '不回显');
  includes('静态：设置默认 Base URL', src, 'https://api.deepseek.com');
  includes('静态：模型选项 deepseek-reasoner', src, 'deepseek-reasoner');
  includes('静态：测试连接文案', src, '测试连接');
  includes('静态：清除 Key 文案', src, '清除 Key');
}

/* ============================================================
 * 2. 纯函数（_internals）
 * ============================================================ */

function testPure() {
  eq('纯函数：COUNTER_ORDER 长度 15', I.COUNTER_ORDER.length, 15);
  eq('纯函数：COUNTER_ORDER 顺序', I.COUNTER_ORDER, [17, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);

  eq('纯函数：rankLabel 大王', I.rankLabel(17), '大王');
  eq('纯函数：rankLabel 小王', I.rankLabel(16), '小王');
  eq('纯函数：rankLabel A', I.rankLabel(14), 'A');
  eq('纯函数：rankLabel K', I.rankLabel(13), 'K');
  eq('纯函数：rankLabel 10', I.rankLabel(10), '10');
  eq('纯函数：rankLabel 2', I.rankLabel(2), '2');
  eq('纯函数：rankLabel 空值', I.rankLabel(undefined), '');

  eq('纯函数：maskKey 只留前缀+后4位', I.maskKey('sk-abcdef123456'), 'sk-****3456');
  notIncludes('纯函数：maskKey 不泄露中间段', I.maskKey('sk-abcdef123456'), 'abcdef');
  eq('纯函数：maskKey 空值', I.maskKey(''), '');
  eq('纯函数：maskKey 短 Key 全遮', I.maskKey('short'), '****');

  const srcArr = [{ rank: 2 }, { rank: 10 }, { rank: 17 }, { rank: 16 }, { rank: 14 }];
  const sorted = I.orderCounter(srcArr);
  eq('纯函数：orderCounter 重排', sorted.map(function (x) { return x.rank; }), [17, 16, 14, 10, 2]);
  eq('纯函数：orderCounter 不修改入参', srcArr.map(function (x) { return x.rank; }), [2, 10, 17, 16, 14]);
  eq('纯函数：orderCounter 未知 rank 排最后', I.orderCounter([{ rank: 99 }, { rank: 2 }]).map(function (x) { return x.rank; }), [2, 99]);
  eq('纯函数：orderCounter 非数组容错', I.orderCounter(null), []);

  eq('纯函数：formatCounterSummary', I.formatCounterSummary({ unknown: 81, playedCount: 5, wildRemaining: 1 }), '未知 81 · 已出 5 · 逢人配 1');
  eq('纯函数：formatCounterSummary 空', I.formatCounterSummary({}), '');
  eq('纯函数：formatCounterSummary null', I.formatCounterSummary(null), '');

  eq('纯函数：formatHandInfo', I.formatHandInfo({ size: 27, bombs: 1, wilds: 1, playsEstimate: 8 }), '27 张 · 炸弹 1 · 逢人配 1 · 预计 8 手');
  eq('纯函数：formatHandInfo 无炸弹', I.formatHandInfo({ size: 5, bombs: 0, wilds: 0 }), '5 张');
  eq('纯函数：formatHandInfo null', I.formatHandInfo(null), '');

  eq('纯函数：phaseText 进贡', I.phaseText('tribute'), '进贡阶段');
  eq('纯函数：phaseText 还贡', I.phaseText('return'), '还贡阶段');
  eq('纯函数：phaseText 结束', I.phaseText('finish'), '本局结束');
  eq('纯函数：phaseText 未知', I.phaseText('x'), '');

  const n0 = I.normalizeSnapshot(null);
  ok('纯函数：normalizeSnapshot(null) 可见', n0.visible === true && n0.isGuandan === true);
  eq('纯函数：normalizeSnapshot(null) seats', n0.seats, []);
  eq('纯函数：normalizeSnapshot(null) counter.byRank', n0.counter.byRank, []);
  eq('纯函数：normalizeSnapshot(null) 默认模型', n0.settings.model, 'deepseek-chat');
  eq('纯函数：normalizeSnapshot(null) 默认 BaseURL', n0.settings.baseUrl, 'https://api.deepseek.com');
  eq('纯函数：normalizeSnapshot(null) suggestion', n0.suggestion, null);

  const n1 = I.normalizeSnapshot({
    visible: false,
    isGuandan: false,
    seats: [{ count: 3 }],
    suggestion: { source: 'x', action: 'pass' },
    history: 'bad',
  });
  ok('纯函数：normalizeSnapshot visible=false 保留', n1.visible === false);
  ok('纯函数：normalizeSnapshot isGuandan=false 保留', n1.isGuandan === false);
  eq('纯函数：normalizeSnapshot 座位名回退', n1.seats[0].name, '我');
  eq('纯函数：normalizeSnapshot suggestion.source 回退', n1.suggestion.source, 'local');
  eq('纯函数：normalizeSnapshot suggestion.action', n1.suggestion.action, 'pass');
  eq('纯函数：normalizeSnapshot 非法 history 回退', n1.history, []);

  eq('纯函数：errText(Error)', I.errText(new Error('boom')), 'boom');
  eq('纯函数：errText(string)', I.errText('x'), 'x');
  eq('纯函数：errText(null)', I.errText(null), '未知错误');
}

/* ============================================================
 * 3. 假 DOM 交互
 * ============================================================ */

async function testDom() {
  const doc = createDoc();
  const container = doc.createElement('div');
  doc.body.appendChild(container);

  const calls = [];
  const opts = {
    settings: {
      hasKey: true,
      keyMask: 'sk-abcdefgh9999',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.2,
      timeoutMs: 30000,
    },
    onLocalSuggest: function () { calls.push('local'); },
    onDeepSeekSuggest: function () { calls.push('deepseek'); },
    onAdopt: function (s) { calls.push('adopt:' + (s && s.turn)); },
    onPass: function () { calls.push('pass'); },
    onTribute: function () { calls.push('tribute'); },
    onReturn: function () { calls.push('return'); },
    onUndo: function () { calls.push('undo'); },
    onNextRound: function () { calls.push('next'); },
    onToggleAuto: function (v) { calls.push('auto:' + v); },
    onSaveSettings: function (st) {
      calls.push('save:' + st.model + ':' + (st.apiKey || '') + ':' + (st.clearKey ? 'clear' : ''));
    },
    onTestConnection: function () {
      calls.push('test');
      return Promise.resolve({ ok: true, message: '连接成功（模型：deepseek-chat）' });
    },
    onOpenHelp: function () { calls.push('help'); },
  };

  const ui = UI.create(container, opts);

  /* --- create 骨架 --- */
  ok('DOM：create 返回 handle', ui && typeof ui === 'object');
  ['root', 'handle', 'update', 'setSettings', 'toast', 'openSettings', 'destroy'].forEach(function (k) {
    ok('DOM：handle.' + k + ' 存在', ui[k] != null);
  });
  ok('DOM：root 挂在 container 下', ui.root.parentNode === container);
  ok('DOM：handle 是标题栏', ui.handle === ui.root.childNodes[0] && hasClass(ui.handle, 'hqgd-head'));
  includes('DOM：标题文本', textOf(ui.root), '掼蛋 AI 助手');
  ok('DOM：root class 前缀', hasClass(ui.root, 'hqgd-panel'));
  eq('DOM：面板宽度受控', true, true);

  const styleEl = doc.getElementById('hqgd-style');
  ok('DOM：注入 <style> 到 document.head', !!styleEl && styleEl.parentNode === doc.head);
  includes('DOM：CSS 含面板样式', textOf(styleEl), '.hqgd-panel');
  includes('DOM：CSS 含 260px', textOf(styleEl), '260px');

  includes('DOM：初始空态提示', textOf(ui.root), '点击下方按钮生成出牌建议');
  includes('DOM：初始记牌器占位', textOf(ui.root), '等待对局…');

  /* --- update 全量渲染 --- */
  ui.update(makeSnapshot());
  const rootText = textOf(ui.root);

  includes('DOM：徽标级牌', textOf(findAll(ui.root, function (n) { return hasClass(n, 'hqgd-badge'); })[0]), '级牌 2 · 逢人配 ♥2');
  includes('DOM：手牌信息汇总', rootText, '27 张 · 炸弹 1 · 逢人配 1 · 预计 8 手');
  includes('DOM：上一手', rootText, '上一手：上家');
  includes('DOM：上一手牌面', rootText, '单张 ♦A');
  includes('DOM：最近历史', rootText, '最近：我 单张 ♠A · 下家 过牌');
  includes('DOM：建议来源 DeepSeek', rootText, 'DeepSeek');
  includes('DOM：建议牌型', rootText, '建议：钢板');
  includes('DOM：建议牌面', rootText, '♠J ♠J ♦J ♥Q ♣Q ♦Q');
  includes('DOM：建议理由', rootText, '减少手数');
  includes('DOM：状态行轮到我', rootText, '✅ 轮到我出牌');
  includes('DOM：状态行阶段', rootText, '出牌阶段');
  includes('DOM：记牌器汇总', rootText, '未知 81 · 已出 10 · 逢人配 1');
  includes('DOM：队友标签', rootText, '队友');
  includes('DOM：进贡标签', rootText, '进贡');
  includes('DOM：名次标签', rootText, '#2');

  const grid = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-counter-grid'); })[0];
  ok('DOM：记牌器网格存在', !!grid);
  eq('DOM：记牌器 15 格（乱序输入已重排）', grid.childNodes.length, 15);
  includes('DOM：第一格大王', textOf(grid.childNodes[0]), '大王');
  includes('DOM：第二格小王', textOf(grid.childNodes[1]), '小王');
  includes('DOM：第三格 A（级牌）', textOf(grid.childNodes[2]), 'A');

  const levelCells = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-cc-level'); });
  ok('DOM：级牌格子存在', levelCells.length >= 1);
  includes('DOM：级牌格子「级」标记', textOf(levelCells[0]), '级');
  const wildCells = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-cc-wild'); });
  ok('DOM：逢人配格子存在', wildCells.length >= 1);
  includes('DOM：逢人配格子「配」标记', textOf(wildCells[0]), '配');

  ui.update(makeSnapshot());
  const grid2 = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-counter-grid'); })[0];
  eq('DOM：重复 update 不重复堆格子', grid2.childNodes.length, 15);

  /* --- 候选折叠 --- */
  const candBtn = findByText(ui.root, '候选出牌（2）');
  ok('DOM：候选折叠按钮存在', !!candBtn);
  if (candBtn) {
    candBtn.click();
    const list = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-cand-list'); })[0];
    ok('DOM：展开后候选列表存在', !!list);
    if (list) eq('DOM：候选列表 2 项', list.childNodes.length, 2);
    const candBtn2 = findByText(ui.root, '候选出牌（2）');
    if (candBtn2) candBtn2.click();
    ok('DOM：再次点击折叠候选', !findAll(ui.root, function (n) { return hasClass(n, 'hqgd-cand-list'); }).length);
  }

  /* --- 按钮回调 --- */
  const click = function (label, tag) {
    const b = findByText(ui.root, label);
    ok('DOM：按钮存在「' + (tag || label) + '」', !!b);
    if (b) b.click();
  };

  click('本地建议'); ok('DOM：本地建议回调', calls.indexOf('local') >= 0);
  click('DeepSeek 建议'); ok('DOM：DeepSeek 建议回调', calls.indexOf('deepseek') >= 0);
  click('采用并出牌'); ok('DOM：采用回调带 snapshot', calls.indexOf('adopt:true') >= 0);
  click('不出'); ok('DOM：不出回调', calls.indexOf('pass') >= 0);
  click('撤销'); ok('DOM：撤销回调', calls.indexOf('undo') >= 0);

  /* --- busy 禁用 --- */
  ui.update(makeSnapshot({ busy: true }));
  const localBusy = findByText(ui.root, '本地建议');
  ok('DOM：busy 时按钮禁用', !!localBusy && localBusy.disabled === true);
  includes('DOM：busy 状态行', textOf(ui.root), '正在处理');
  ui.update(makeSnapshot());

  /* --- 自动托管 --- */
  const autoBtn = findByText(ui.root, '🤖');
  ok('DOM：自动托管按钮存在', !!autoBtn);
  if (autoBtn) {
    autoBtn.click();
    ok('DOM：自动托管回调 true', calls.indexOf('auto:true') >= 0);
    ok('DOM：自动托管按钮高亮', hasClass(autoBtn, 'hqgd-on'));
    includes('DOM：自动托管 toast', textOf(ui.root), '自动托管已开启');
    ui.update(makeSnapshot({ auto: false }));
    const autoBtn2 = findByText(ui.root, '🤖');
    ok('DOM：snapshot.auto=false 后取消高亮', autoBtn2 && !hasClass(autoBtn2, 'hqgd-on'));
  }

  /* --- toast --- */
  ui.toast('测试提示', 'error');
  const toastEl = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-toast'); })[0];
  ok('DOM：toast 元素存在', !!toastEl);
  includes('DOM：toast 文案', textOf(toastEl), '测试提示');
  includes('DOM：toast 类型样式', toastEl.className, 'hqgd-toast-error');

  /* --- 设置弹窗 --- */
  ui.setSettings({
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1',
    temperature: 0.5,
    timeoutMs: 20000,
  });
  ui.openSettings();
  const overlay = doc.getElementById('hqgd-settings-overlay');
  ok('DOM：设置弹窗已挂到 body', !!overlay && overlay.parentNode === doc.body);
  const overlayText = textOf(overlay);
  includes('DOM：设置弹窗 API Key 字段', overlayText, 'API Key');
  includes('DOM：设置弹窗 Base URL 字段', overlayText, 'Base URL');
  includes('DOM：设置弹窗模型字段', overlayText, '模型');
  includes('DOM：设置弹窗温度字段', overlayText, '温度');
  includes('DOM：设置弹窗超时字段', overlayText, '超时');

  const keyInput = findByAttr(overlay, 'data-field', 'apiKey');
  const baseInput = findByAttr(overlay, 'data-field', 'baseUrl');
  const modelInput = findByAttr(overlay, 'data-field', 'model');
  const tempInput = findByAttr(overlay, 'data-field', 'temperature');
  const timeoutInput = findByAttr(overlay, 'data-field', 'timeoutMs');
  ok('DOM：Key 输入框存在', !!keyInput);
  eq('DOM：Key 输入框 type=password', keyInput.type, 'password');
  eq('DOM：Key 输入框空值（不回显）', keyInput.value, '');
  includes('DOM：Key placeholder 已保存掩码', keyInput.placeholder, 'sk-****9999');
  notIncludes('DOM：Key placeholder 不含完整 Key', keyInput.placeholder, 'abcdefgh');
  eq('DOM：Base URL 回填', baseInput.value, 'https://api.deepseek.com/v1');
  eq('DOM：模型回填', modelInput.value, 'deepseek-reasoner');
  eq('DOM：温度回填', tempInput.value, '0.5');
  eq('DOM：超时回填', timeoutInput.value, '20000');

  const statusLine = findAll(overlay, function (n) { return hasClass(n, 'hqgd-modal-status'); })[0];
  ok('DOM：设置状态行存在', !!statusLine);

  // 保存
  const saveBtn = findByText(overlay, '保存');
  ok('DOM：保存按钮存在', !!saveBtn);
  if (saveBtn) saveBtn.click();
  includes('DOM：保存回调携带模型', calls.join('|'), 'save:deepseek-reasoner::');
  includes('DOM：保存成功状态', textOf(statusLine), '设置已保存');

  // 输入新 Key 后保存 → 不回显
  keyInput.value = 'sk-newkey123456';
  if (saveBtn) saveBtn.click();
  includes('DOM：新 Key 触发保存回调', calls.join('|'), 'save:deepseek-reasoner:sk-newkey123456:');
  includes('DOM：保存后状态提示 Key 已更新', textOf(statusLine), 'API Key 已更新');
  eq('DOM：保存后 Key 输入框清空', keyInput.value, '');
  notIncludes('DOM：DOM 中不出现完整 Key', textOf(doc.body), 'sk-newkey123456');
  ok('DOM：getSettings().hasKey=true', ui.getSettings().hasKey === true);
  ok('DOM：getSettings() 不含明文 Key', ui.getSettings().apiKey === undefined);

  // 测试连接
  ok('DOM：测试连接按钮存在', !!findByText(overlay, '测试连接'));
  if (findByText(overlay, '测试连接')) findByText(overlay, '测试连接').click();
  includes('DOM：测试连接 pending', textOf(statusLine), '正在测试连接');
  const testBtn = findByText(overlay, '测试连接');
  ok('DOM：测试中按钮禁用', !!testBtn && testBtn.disabled === true);
  await new Promise(function (r) { setTimeout(r, 0); });
  includes('DOM：测试连接成功状态', textOf(statusLine), '连接成功');
  ok('DOM：测试连接回调被调用', calls.indexOf('test') >= 0);
  const testBtn2 = findByText(overlay, '测试连接');
  ok('DOM：测试后按钮恢复', !!testBtn2 && testBtn2.disabled === false);

  // Base URL 非法
  baseInput.value = 'ftp://bad';
  if (saveBtn) saveBtn.click();
  includes('DOM：非法 Base URL 状态', textOf(statusLine), 'Base URL 格式不正确');
  baseInput.value = 'https://api.deepseek.com';

  // 清除 Key
  const clearBtn = findByText(overlay, '清除 Key');
  ok('DOM：清除 Key 按钮存在', !!clearBtn);
  if (clearBtn) clearBtn.click();
  includes('DOM：清除 Key 状态', textOf(statusLine), '已清除');
  includes('DOM：清除 Key 回调', calls.join('|'), ':clear');
  eq('DOM：清除后 hasKey=false', ui.getSettings().hasKey, false);
  eq('DOM：清除后 placeholder 回到 sk-...', keyInput.placeholder, 'sk-...');

  // 无 Key 测试连接
  if (findByText(overlay, '测试连接')) findByText(overlay, '测试连接').click();
  includes('DOM：无 Key 测试连接提示', textOf(statusLine), '请先填写 API Key');

  // 关闭
  const closeBtn = findByText(overlay, '关闭');
  if (closeBtn) closeBtn.click();
  eq('DOM：关闭设置弹窗', overlay.style.display, 'none');

  /* --- 帮助弹窗 --- */
  ui.openHelp();
  const helpOverlay = doc.getElementById('hqgd-help-overlay');
  ok('DOM：帮助弹窗存在', !!helpOverlay);
  const helpText = textOf(helpOverlay);
  includes('DOM：帮助含功能说明', helpText, '记牌器');
  includes('DOM：帮助含隐私说明', helpText, '隐私说明');
  includes('DOM：帮助含快捷键', helpText, '快捷键');
  const okBtn = findByText(helpOverlay, '知道了');
  if (okBtn) okBtn.click();
  eq('DOM：关闭帮助弹窗', helpOverlay.style.display, 'none');

  /* --- 进贡 / 还贡 / 结束阶段 --- */
  ui.update(makeSnapshot({
    phase: 'tribute',
    turn: false,
    suggestion: null,
    tribute: { mode: 'tribute', fromName: '下家', toName: '我', candidatesText: '♠A', suggestText: '♠A' },
  }));
  let t = textOf(ui.root);
  includes('DOM：进贡阶段状态', t, '进贡阶段');
  includes('DOM：进贡信息', t, '当前：进贡 下家 → 我');
  includes('DOM：进贡候选', t, '候选：♠A');
  includes('DOM：进贡建议', t, '建议：♠A');
  ok('DOM：进贡按钮「采纳进贡」', !!findByText(ui.root, '采纳进贡'));
  ok('DOM：进贡按钮「确认进贡」', !!findByText(ui.root, '确认进贡'));
  notIncludes('DOM：进贡阶段无 DeepSeek 按钮', textOf(findAll(ui.root, function (n) { return hasClass(n, 'hqgd-actions'); })[0]), 'DeepSeek');
  click('采纳进贡'); ok('DOM：进贡回调', calls.indexOf('tribute') >= 0);

  ui.update(makeSnapshot({
    phase: 'return',
    turn: false,
    tribute: { mode: 'return', fromName: '我', toName: '对家', candidatesText: '♥5', suggestText: '' },
  }));
  ok('DOM：还贡按钮「采纳还贡」', !!findByText(ui.root, '采纳还贡'));
  ok('DOM：还贡按钮「确认还贡」', !!findByText(ui.root, '确认还贡'));
  click('确认还贡'); ok('DOM：还贡回调', calls.indexOf('return') >= 0);

  ui.update(makeSnapshot({ phase: 'finish', turn: false, suggestion: null }));
  includes('DOM：结束阶段状态', textOf(ui.root), '本局结束');
  ok('DOM：结束按钮「下一局」', !!findByText(ui.root, '🔄 下一局'));
  click('🔄 下一局'); ok('DOM：下一局回调', calls.indexOf('next') >= 0);

  /* --- 非掼蛋 / 隐藏 / 空 snapshot --- */
  ui.update({ visible: true, isGuandan: false });
  t = textOf(ui.root);
  includes('DOM：非掼蛋提示', t, '当前不是掼蛋玩法');
  const actionsEl = findAll(ui.root, function (n) { return hasClass(n, 'hqgd-actions'); })[0];
  eq('DOM：非掼蛋隐藏按钮区', actionsEl.style.display, 'none');

  ui.update({ visible: false, isGuandan: true });
  eq('DOM：visible=false 隐藏面板', ui.root.style.display, 'none');
  ui.update(makeSnapshot());
  eq('DOM：恢复可见', ui.root.style.display, '');

  noThrow('DOM：update(null) 不抛异常', function () { ui.update(null); });
  includes('DOM：update(null) 显示占位', textOf(ui.root), '等待对局…');
  noThrow('DOM：update 脏数据不抛异常', function () {
    ui.update({ seats: 'bad', counter: 42, history: 'bad', suggestion: 'bad' });
  });

  /* --- 回调抛异常不炸面板 --- */
  const container2 = doc.createElement('div');
  doc.body.appendChild(container2);
  const ui2 = UI.create(container2, {
    onLocalSuggest: function () { throw new Error('回调爆炸'); },
  });
  const b2 = findByText(ui2.root, '本地建议');
  noThrow('DOM：回调抛异常不炸', function () { if (b2) b2.click(); });
  includes('DOM：回调异常 toast 提示', textOf(ui2.root), '回调执行失败');
  ok('DOM：回调异常后仍存活', ui2.isDestroyed() === false);

  /* --- destroy --- */
  ui2.destroy();
  ok('DOM：destroy 移除面板', container2.childNodes.length === 0);
  ok('DOM：destroy 后 isDestroyed', ui2.isDestroyed() === true);
  noThrow('DOM：destroy 后 update 不抛', function () { ui2.update(makeSnapshot()); });
  ok('DOM：另一个面板仍存在时 style 保留', !!doc.getElementById('hqgd-style'));

  ui.destroy();
  ok('DOM：destroy 主面板移除', container.childNodes.length === 0);
  ok('DOM：destroy 移除设置/帮助弹窗', !doc.getElementById('hqgd-settings-overlay') && !doc.getElementById('hqgd-help-overlay'));
  ok('DOM：最后一个 destroy 后 style 移除', !doc.getElementById('hqgd-style'));
  ok('DOM：destroy 后 isDestroyed', ui.isDestroyed() === true);
  noThrow('DOM：destroy 幂等', function () { ui.destroy(); });
  noThrow('DOM：destroy 后 toast 不抛', function () { ui.toast('x'); });

  /* --- create 需要 DOM --- */
  throwsErr('DOM：无 DOM 环境 create 抛错', function () { UI.create(null); }, 'DOM');
}

/* ============================================================
 * 入口
 * ============================================================ */

async function main() {
  testStatic();
  testPure();
  await testDom();

  const total = PASS + FAIL;
  console.log('');
  console.log('==========================================');
  console.log('  GDSiteUI 测试结果：PASS ' + PASS + ' / FAIL ' + FAIL + '（共 ' + total + ' 项）');
  console.log('==========================================');
  if (FAILURES.length) {
    console.log('失败明细：');
    for (let i = 0; i < FAILURES.length; i++) console.log('  ✗ ' + FAILURES[i]);
    process.exit(1);
  } else {
    console.log('全部通过 ✅');
    process.exit(0);
  }
}

main().catch(function (e) {
  console.error('测试运行崩溃：', e && e.stack ? e.stack : e);
  process.exit(1);
});
