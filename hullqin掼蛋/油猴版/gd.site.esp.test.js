/* ============================================================
 * 掼蛋 AI 助手（油猴版）· 透视模块 gd.site.esp.js 单测
 * ------------------------------------------------------------
 * 覆盖：牌 id 映射 / 排序 / 炸弹与逢人配识别 / buildXray 集成
 *       （用 gd.site.core.js 的 expandState 构造真实牌局）。
 * 运行：node gd.site.esp.test.js（不联网、无第三方依赖）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const E = require('./gd.site.esp.js');
const G = require('./gd.site.core.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? '\n    ' + extra : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, 'got ' + a + '，expected ' + b);
}
function includes(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) >= 0, '未找到：' + needle);
}

/* ============================ 1. 静态约束 ============================ */

const src = fs.readFileSync(path.join(__dirname, 'gd.site.esp.js'), 'utf8');
eq('静态：VERSION', E.VERSION, '1.0.0');
ok('静态：UMD 浏览器导出', src.indexOf('root.GDSiteESP = api') >= 0);
ok('静态：UMD Node 导出', src.indexOf('module.exports = api') >= 0);
['fetch(', 'XMLHttpRequest', 'WebSocket', 'document.', 'localStorage', 'innerHTML', 'console.'].forEach(function (bad) {
  ok('静态：不出现 ' + bad, src.indexOf(bad) < 0);
});

/* ============================ 2. 牌 id 映射 ============================ */

eq('rankOf A♦', E.rankOf(1), 14);
eq('rankOf K♦', E.rankOf(13), 13);
eq('rankOf A♣', E.rankOf(14), 14);
eq('rankOf A♥', E.rankOf(27), 14);
eq('rankOf A♠', E.rankOf(40), 14);
eq('rankOf 大王', E.rankOf(53), 17);
eq('rankOf 小王', E.rankOf(54), 16);
eq('rankOf 第二副大王', E.rankOf(107), 17);
eq('rankOf 第二副小王', E.rankOf(108), 16);
eq('suitOf ♦', E.suitOf(1), 0);
eq('suitOf ♣', E.suitOf(14), 1);
eq('suitOf ♥', E.suitOf(27), 2);
eq('suitOf ♠', E.suitOf(40), 3);
eq('suitOf 王', E.suitOf(53), -1);
eq('cardInfo(0) 非法', E.cardInfo(0), null);
eq('cardInfo(109) 非法', E.cardInfo(109), null);

const a1 = E.cardInfo(1, 2);
eq('cardInfo ♦A 文案', a1.text, '♦A');
eq('cardInfo ♦A 红色', a1.red, true);
eq('cardInfo ♦A 非级牌', a1.isLevel, false);
eq('cardInfo ♦A 非逢人配', a1.isWild, false);
eq('cardInfo ♦A 权重', a1.order, 14);

const h2 = E.cardInfo(28, 2);
eq('cardInfo ♥2 文案', h2.text, '♥2');
eq('cardInfo ♥2 是级牌', h2.isLevel, true);
eq('cardInfo ♥2 是逢人配', h2.isWild, true);
eq('cardInfo ♥2 权重 15', h2.order, 15);
eq('级牌外 ♦2 不是逢人配', E.isWildCard(2, 2), false);
eq('第二副 ♥2 也是逢人配', E.isWildCard(82, 2), true);
eq('级牌 A 时 ♥A 为逢人配', E.isWildCard(27, 14), true);
eq('levelOrder 级牌', E.levelOrder(2, 2), 15);
eq('levelOrder 大王', E.levelOrder(17, 2), 17);

const big = E.cardInfo(53, 2);
eq('cardInfo 大王文案', big.text, '大王');
eq('cardInfo 大王非红', big.red, false);
eq('cardInfo 大王 isJoker', big.isJoker, true);
eq('cardInfo 小王文案', E.cardInfo(54, 2).text, '小王');

/* 与引擎 cardText 全量一致（108 张） */
let textMismatch = 0;
for (let id = 1; id <= 108; id++) {
  if (E.cardInfo(id, 2).text !== G.cardText(id)) textMismatch++;
}
eq('cardInfo 文案与引擎 cardText 一致（108 张）', textMismatch, 0);

/* ============================ 3. 排序 ============================ */

const hand = [1, 14, 28, 53, 54, 13];
const sorted = E.sortCards(hand, 2);
eq('sortCards 级牌优先于 A', sorted, [53, 54, 28, 1, 14, 13]);
eq('sortCards 不修改入参', hand, [1, 14, 28, 53, 54, 13]);
eq('sortCards 过滤非法牌', E.sortCards([1, 0, 999, 54, 1], 2), [54, 1, 1]);
ok('sortCards 与引擎 sortHand 牌集合一致', (function () {
  const a = E.sortCards(G.deal(2024).hands[0], 3).slice().sort(function (x, y) { return x - y; });
  const b = G.sortHand(G.deal(2024).hands[0], 3, 1).slice().sort(function (x, y) { return x - y; });
  return JSON.stringify(a) === JSON.stringify(b);
})());

/* ============================ 4. 炸弹识别 ============================ */

function bombs(list, level) {
  return E.bombsOf(list, level).bombs;
}
function labels(list, level) {
  return bombs(list, level).map(function (b) { return b.label; });
}

const fourJokers = bombs([53, 54, 107, 108], 2);
eq('四大天王数量', fourJokers.length, 1);
eq('四大天王标签', fourJokers[0].label, '四大天王');
eq('四大天王强度', fourJokers[0].power, 99);

const fourA = bombs([1, 14, 27, 40], 2);
eq('四张 A 标签', fourA.length === 1 ? fourA[0].label : labels([1, 14, 27, 40], 2), '4张A');
eq('四张 A 强度', fourA[0].power, 4);

const fiveA = bombs([1, 14, 27, 40, 55], 2);
eq('五张 A 标签', fiveA[0].label, '5张A');

const wildA = bombs([1, 14, 27, 28], 2);
eq('三张 A + 逢人配 标签', wildA[0].label, '4张A（配）');
eq('三张 A + 逢人配 强度', wildA[0].power, 4);

const wildA2 = bombs([1, 14, 27, 28, 82], 2);
ok('三张 A + 两张逢人配', wildA2.some(function (b) { return b.label === '5张A（配）' && b.power === 5; }));

const sf = bombs([40, 49, 50, 51, 52], 2);
ok('同花顺 ♠A 识别', sf.some(function (b) { return b.kind === 'straightFlush' && b.label === '同花顺 ♠A' && b.power === 5.5; }));

const sfA5 = bombs([40, 41, 42, 43, 44], 2);
ok('同花顺 A2345 识别', sfA5.some(function (b) { return b.label === '同花顺 ♠5'; }));

const sfWild = bombs([49, 50, 51, 52, 28], 2);
ok('逢人配补同花顺', sfWild.some(function (b) { return b.label === '同花顺 ♠A（配）'; }));

const noBomb = bombs([1, 2, 3, 4, 5], 2);
ok('无炸弹不误报', noBomb.every(function (b) { return b.kind !== 'sameRank' && b.kind !== 'fourJokers'; }));
eq('bombsOf 返回逢人配数量', E.bombsOf([28, 82, 1], 2).wildCount, 2);
ok('bombsOf 不修改入参', (function () {
  const input = [1, 14, 27, 40];
  E.bombsOf(input, 2);
  return JSON.stringify(input) === JSON.stringify([1, 14, 27, 40]);
})());

/* ============================ 5. 座位关系 ============================ */

eq('relName 自己', E.relName(1, 1), '我');
eq('relName 下家', E.relName(2, 1), '下家');
eq('relName 对家', E.relName(3, 1), '对家');
eq('relName 上家', E.relName(4, 1), '上家');
eq('relName 非法', E.relName(0, 0), '');
eq('partnerOf 1', E.partnerOf(1), 3);
eq('partnerOf 2', E.partnerOf(2), 4);
eq('partnerOf 3', E.partnerOf(3), 1);
eq('partnerOf 4', E.partnerOf(4), 2);

/* ============================ 6. buildXray 集成 ============================ */

function makeRaw(cpl) {
  return {
    rule: 2,
    state: 1,
    landlordId: 0,
    v: 1,
    cardPositionList: cpl,
    playedCardList: [],
    lastRankList: [],
    tributeCardList: [],
    returnCardList: [],
    playedTypeList: [],
    firstPlayer: 2,
    team13Level: 2,
    team24Level: 2,
  };
}

/* 我坐 2 号位：1..27 给我，28..54 给 3，55..81 给 4，82..108 给 1 */
const cpl = new Array(108);
for (let i = 1; i <= 108; i++) {
  cpl[i - 1] = i <= 27 ? 2 : (i <= 54 ? 3 : (i <= 81 ? 4 : 1));
}
const raw = makeRaw(cpl);
const before = JSON.stringify(raw);
const exp = G.expandState(raw);
const x = E.buildXray(exp, 2);

eq('buildXray ok', x.ok, true);
eq('buildXray reason', x.reason, 'ok');
eq('buildXray 座位顺序（下家/对家/上家）', x.seats.map(function (s) { return s.seat; }), [3, 4, 1]);
eq('buildXray 座位名', x.seats.map(function (s) { return s.name; }), ['下家', '对家', '上家']);
eq('buildXray 队友标记', x.seats.map(function (s) { return s.isPartner; }), [false, true, false]);
eq('buildXray 三家各 27 张', x.seats.map(function (s) { return s.cards.length; }), [27, 27, 27]);
eq('buildXray 总张数', x.totalCards, 81);
eq('buildXray 逢人配数量', x.seats.map(function (s) { return s.wildCount; }), [1, 0, 1]);
eq('buildXray 牌面是对象', typeof x.seats[0].cards[0].text, 'string');
eq('buildXray 不修改入参', JSON.stringify(raw), before);
ok('buildXray 无重复牌', (function () {
  const seen = {};
  let dup = 0;
  x.seats.forEach(function (s) { s.cards.forEach(function (c) { if (seen[c.id]) dup++; seen[c.id] = 1; }); });
  return dup === 0;
})());

/* 未入座 / 观战 */
eq('buildXray 未入座 reason', E.buildXray(exp, 0).reason, 'not-seated');
eq('buildXray 未入座 ok=false', E.buildXray(exp, 0).ok, false);

/* 无数据 */
const emptyExp = { level: 2, playerCardLists: [[], [], [], [], []], playerRestCardCounts: [0, 0, 0, 0, 0] };
eq('buildXray 空牌局 reason', E.buildXray(emptyExp, 1).reason, 'no-cards');
const noDataExp = { level: 2, playerCardLists: [[], [], [], [], []], playerRestCardCounts: [0, 0, 27, 27, 27] };
eq('buildXray 有张数无牌 reason', E.buildXray(noDataExp, 1).reason, 'no-data');
ok('buildXray 有张数无牌 unavailable', E.buildXray(noDataExp, 1).seats.every(function (s) { return s.unavailable; }));

/* 部分座位缺牌 */
const partialExp = {
  level: 2,
  playerCardLists: [[], [], [1, 2, 3], [], []],
  playerRestCardCounts: [0, 0, 3, 27, 27],
};
const px = E.buildXray(partialExp, 1);
eq('buildXray 部分缺牌 reason', px.reason, 'partial');
eq('buildXray 部分缺牌 ok', px.ok, true);
eq('buildXray 部分缺牌张数', px.totalCards, 3);

/* 炸弹预警 */
const bombExp = {
  level: 2,
  playerCardLists: [[], [], [1, 14, 27, 40, 53, 54, 107, 108], [], []],
  playerRestCardCounts: [0, 0, 8, 0, 0],
};
const bx = E.buildXray(bombExp, 1);
eq('buildXray 炸弹总数', bx.bombCount, 2);
eq('buildXray 预警条数', bx.warnings.length, 1);
includes('buildXray 预警文本', bx.warnings[0], '下家 有 2 个炸弹');
includes('buildXray 预警含四大天王', bx.warnings[0], '四大天王');
eq('buildXray 下家张数', bx.seats[0].count, 8);

/* 汇总文案 */
includes('summaryOf 汇总', E.summaryOf(x), '可见 81 张');
includes('summaryOf 炸弹', E.summaryOf(bx), '炸弹 2 个');
eq('summaryOf 无数据', E.summaryOf(null), '暂无可透视的手牌');

/* ============================ 7. 引擎手牌排序对照 ============================ */

const dealt = G.deal(7);
const exp2 = G.expandState(makeRaw((function () {
  const c = new Array(108).fill(0);
  dealt.hands.forEach(function (h, i) { h.forEach(function (id) { c[id - 1] = i + 1; }); });
  return c;
})()));
const x2 = E.buildXray(exp2, 1);
eq('buildXray 引擎牌局座位数', x2.seats.length, 3);
ok('buildXray 引擎牌局全部有序', x2.seats.every(function (s) {
  const sortedIds = s.cards.map(function (c) { return c.id; });
  return JSON.stringify(sortedIds) === JSON.stringify(E.sortCards(sortedIds, x2.level));
}));
ok('buildXray 引擎牌局张数合计 81', x2.totalCards === 81);

/* ============================ 汇总 ============================ */

console.log((fail ? '失败明细：' : '') + (fail ? '' : ''));
if (fail) {
  failures.slice(0, 30).forEach(function (f, i) { console.log(' ' + (i + 1) + ') ' + f); });
  if (failures.length > 30) console.log('  … 其余 ' + (failures.length - 30) + ' 项省略');
}
console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
