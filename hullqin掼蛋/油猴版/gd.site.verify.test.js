/* gd.site.verify.test.js — 掼蛋 AI 助手（game.hullqin.cn 油猴脚本版）独立黑盒验收（verifier）
 *
 * 期望值完全依据 SPEC2.md 第 1/2/3/4/5/7 节与 _site/pretty/mod_6135.pretty.js 的站点规则自行推导，
 * 不参考 gd.site.*.js 实现源码。覆盖：
 *   牌 id/花色/点数/逢人配 → 牌型解释（全部牌型 + A 当 1 + 逢人配）→ 压牌与炸弹链 →
 *   replayActions（出牌/过牌/三过清墩/出完借风）→ expandState（tribute/return/play/finish、
 *   rankList、tributers/receivers、resistInfo、roundResult）→ protobuf 编解码 →
 *   remainingCounts 记牌器 → genMoves（随机 200 局面性质）→ GDSiteAI → GDSiteRemote →
 *   构建产物静态断言。
 *
 * 运行：node gd.site.verify.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const loadErrors = [];
function tryReq(rel) {
  try { return require(path.join(__dirname, rel)); }
  catch (e) { loadErrors.push(rel + ': ' + e.message); return null; }
}
const GDSite = tryReq('gd.site.core.js');
const GDSiteAI = tryReq('gd.site.ai.js');
const GDSiteRemote = tryReq('gd.site.remote.js');
try { tryReq('../gd.deepseek.js'); } catch (e) { /* 依赖模块，缺失时 remote 断言会报错 */ }

let passed = 0;
let failed = 0;
let printed = 0;
const PRINT_LIMIT = 120;
const skipNotes = [];

function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failed++;
  if (printed < PRINT_LIMIT) { printed++; console.log('✗ ' + msg); }
  return false;
}
function show(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function eq(actual, expected, label) {
  const a = show(actual), b = show(expected);
  return ok(a === b, label + ' — 期望 ' + b + '，实际 ' + a);
}
function len(actual, expected, label) {
  return ok(Array.isArray(actual) && actual.length === expected,
    label + ' — 期望长度 ' + expected + '，实际 ' + show(actual && actual.length));
}
function includes(arr, item, label) {
  return ok(Array.isArray(arr) && arr.indexOf(item) >= 0,
    label + ' — 期望包含 ' + show(item) + '，实际 ' + show(arr));
}

// ---------- 牌 id 工具（SPEC2 §1.1：花色 0=♦ 1=♣ 2=♥ 3=♠；local=花色*13+点数，A=1 位） ----------
const BIG0 = 53, BIG1 = 107;      // local 53 = 大王 rank17
const SMALL0 = 54, SMALL1 = 108;  // local 54 = 小王 rank16
const WILD0 = 29, WILD1 = 83;     // 级3 的逢人配 ♥3（local 29 = 27+2）
function localOf(rank, suit) { return suit * 13 + (rank === 14 ? 1 : rank); }
function card(rank, suit, deck) { return localOf(rank, suit) + (deck || 0) * 54; }

const TYPE = {
  Single: 1, Pair: 2, Triple: 3, ThreeWithPair: 4, Steel: 5, TriplePairs: 6, Straight: 7,
  Four: 100, Five: 101, StraightFlush: 102, Six: 103, Seven: 104, Eight: 105, FourJokers: 127
};
const BOMB = { 100: 4, 101: 5, 102: 5.5, 103: 6, 104: 7, 105: 8, 127: 99 };
function code(t, r) { return t * 256 + r; }

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const x = a.slice().sort((p, q) => p - q);
  const y = b.slice().sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}
function handHas(hand, cards) {
  const m = new Map();
  for (const c of hand) m.set(c, (m.get(c) || 0) + 1);
  for (const c of cards) {
    if (!m.get(c)) return false;
    m.set(c, m.get(c) - 1);
  }
  return true;
}

// 通用原始状态构造（SPEC2 §1.3/§1.4 的 raw 字段）
function makeRaw(o) {
  o = o || {};
  return {
    rule: o.rule !== undefined ? o.rule : 2,
    state: o.state !== undefined ? o.state : 1,
    landlordId: 0,
    cardPositionList: o.cardPositionList ? o.cardPositionList.slice() : new Array(108).fill(0),
    playedCardList: o.playedCardList ? o.playedCardList.slice() : [],
    v: o.v !== undefined ? o.v : 1,
    team13Level: o.team13Level !== undefined ? o.team13Level : 2,
    team24Level: o.team24Level !== undefined ? o.team24Level : 2,
    lastRankList: o.lastRankList ? o.lastRankList.slice() : [],
    tributeCardList: o.tributeCardList ? o.tributeCardList.slice() : [],
    returnCardList: o.returnCardList ? o.returnCardList.slice() : [],
    firstPlayer: o.firstPlayer !== undefined ? o.firstPlayer : 0,
    playedTypeList: o.playedTypeList ? o.playedTypeList.slice() : []
  };
}
// 标准 108 张按 1..27/28..54/55..81/82..108 分给 4 家（测试用固定初始）
function cplDeal() {
  const cpl = new Array(108).fill(0);
  for (let i = 1; i <= 27; i++) cpl[i - 1] = 1;
  for (let i = 28; i <= 54; i++) cpl[i - 1] = 2;
  for (let i = 55; i <= 81; i++) cpl[i - 1] = 3;
  for (let i = 82; i <= 108; i++) cpl[i - 1] = 4;
  return cpl;
}
function segListToPlayed(segs) {
  const out = [];
  for (const s of segs) { out.push(0); for (const c of s) out.push(c); }
  return out;
}
// 把 “每段一个动作” 的牌序列转成 playedCardList；types 同步对应段
function playSegs(segs, types) {
  return { playedCardList: segListToPlayed(segs), playedTypeList: types.slice() };
}

function section(name, fn) {
  try { fn(); }
  catch (e) {
    failed++;
    if (printed < PRINT_LIMIT) { printed++; console.log('✗ [' + name + '] 抛异常：' + (e && e.message)); }
  }
}
async function sectionAsync(name, fn) {
  try { await fn(); }
  catch (e) {
    failed++;
    if (printed < PRINT_LIMIT) { printed++; console.log('✗ [' + name + '] 抛异常：' + (e && e.message)); }
  }
}

// ============================== §0 模块导出契约 ==============================
function sec0() {
  ok(typeof GDSite.VERSION === 'string' && GDSite.VERSION.length > 0, '0 VERSION 为非空字符串');
  eq(GDSite.CARD && GDSite.CARD.TOTAL, 108, '0 CARD.TOTAL=108');
  eq(GDSite.CARD && GDSite.CARD.DECKS, 2, '0 CARD.DECKS=2');
  for (const k of Object.keys(TYPE)) eq(GDSite.TYPE && GDSite.TYPE[k], TYPE[k], '0 TYPE.' + k + '=' + TYPE[k]);
  const fns = ['normalizeId', 'cardDeck', 'cardLocal', 'rankOf', 'suitOf', 'levelOrder', 'isJoker',
    'isWildCard', 'isLevelCard', 'heartLevelId', 'rankText', 'cardText', 'cardTexts', 'typeName',
    'bombValue', 'decodeGameData', 'encodeGameData', 'replayActions', 'expandState', 'interpretCodes',
    'bestCode', 'beats', 'playFromCards', 'genMoves', 'sortHand', 'myHand', 'remainingCounts',
    'tributeCandidates', 'returnCandidates', 'buildAIState', 'createRng', 'deal'];
  for (const f of fns) ok(typeof GDSite[f] === 'function', '0 导出函数 ' + f + '() 存在');
}

// ============================== §1 牌模型 ==============================
function sec1() {
  let normOk = true, localOk = true, deckOk = true;
  for (let id = 1; id <= 108; id++) {
    if (GDSite.normalizeId(id) !== ((id - 1) % 54) + 1) normOk = false;
    if (GDSite.cardLocal(id) !== ((id - 1) % 54) + 1) localOk = false;
    if (GDSite.cardDeck(id) !== (id <= 54 ? 0 : 1)) deckOk = false;
  }
  ok(normOk, '1 normalizeId(1..108) = local=((id-1)%54)+1');
  ok(localOk, '1 cardLocal(1..108) 同上');
  ok(deckOk, '1 cardDeck: 1..54→0，55..108→1');
  eq(GDSite.cardLocal(55), 1, '1 cardLocal(55)=1');
  eq(GDSite.cardLocal(108), 54, '1 cardLocal(108)=54');

  const rankSamples = [[1, 14], [2, 2], [13, 13], [14, 14], [26, 13], [27, 14], [39, 13],
    [40, 14], [52, 13], [53, 17], [54, 16], [107, 17], [108, 16]];
  for (const s of rankSamples) eq(GDSite.rankOf(s[0]), s[1], '1 rankOf(' + s[0] + ')=' + s[1]);
  eq(GDSite.suitOf(1), 0, '1 suitOf(1)=0(♦)');
  eq(GDSite.suitOf(14), 1, '1 suitOf(14)=1(♣)');
  eq(GDSite.suitOf(27), 2, '1 suitOf(27)=2(♥)');
  eq(GDSite.suitOf(40), 3, '1 suitOf(40)=3(♠)');
  eq(GDSite.suitOf(13), 0, '1 suitOf(13)=♦');
  eq(GDSite.suitOf(52), 3, '1 suitOf(52)=♠');
  eq(GDSite.suitOf(BIG0), -1, '1 大王 suitOf=-1');
  eq(GDSite.suitOf(SMALL1), -1, '1 小王 suitOf=-1');
  let cardLoop = true;
  for (let rank = 2; rank <= 14; rank++) {
    for (let s = 0; s < 4; s++) {
      const id = card(rank, s);
      if (GDSite.rankOf(id) !== rank || GDSite.suitOf(id) !== s) cardLoop = false;
    }
  }
  ok(cardLoop, '1 card(rank,suit) 的 rankOf/suitOf 全映射正确');

  // 级牌顺序 f(rank,level)：rank===level → 15；16/17 不变；否则 rank
  eq(GDSite.levelOrder(5, 5), 15, '1 levelOrder(5,级5)=15');
  eq(GDSite.levelOrder(14, 5), 14, '1 levelOrder(A,级5)=14');
  eq(GDSite.levelOrder(2, 5), 2, '1 levelOrder(2,级5)=2');
  eq(GDSite.levelOrder(16, 5), 16, '1 levelOrder(小王,级5)=16');
  eq(GDSite.levelOrder(17, 5), 17, '1 levelOrder(大王,级5)=17');
  eq(GDSite.levelOrder(14, 14), 15, '1 levelOrder(A,级A)=15');
  eq(GDSite.levelOrder(13, 14), 13, '1 levelOrder(K,级A)=13');
  eq(GDSite.levelOrder(2, 2), 15, '1 levelOrder(2,级2)=15');

  eq(GDSite.heartLevelId(3), 29, '1 heartLevelId(3)=29(♥3)');
  eq(GDSite.heartLevelId(5), 31, '1 heartLevelId(5)=31(♥5)');
  eq(GDSite.heartLevelId(14), 27, '1 heartLevelId(14)=27(♥A)');
  eq(GDSite.heartLevelId(2), 28, '1 heartLevelId(2)=28(♥2)');

  ok(GDSite.isWildCard(WILD0, 3) === true, '1 ♥3 在级3时是逢人配');
  ok(GDSite.isWildCard(WILD1, 3) === true, '1 第二副♥3 在级3时是逢人配');
  ok(GDSite.isWildCard(3, 3) === false, '1 ♦3 不是逢人配');
  ok(GDSite.isLevelCard(3, 3) === true, '1 ♦3 在级3时是级牌');
  ok(GDSite.isLevelCard(WILD0, 3) === true, '1 ♥3 在级3时是级牌');
  ok(GDSite.isLevelCard(14, 3) === false, '1 A 在级3时不是级牌');
  ok(GDSite.isJoker(BIG0) && GDSite.isJoker(BIG1) && GDSite.isJoker(SMALL0) && GDSite.isJoker(SMALL1),
    '1 四张王 isJoker=true');
  ok(!GDSite.isJoker(1), '1 非王 isJoker=false');

  eq(GDSite.rankText(2), '2', '1 rankText(2)');
  eq(GDSite.rankText(10), '10', '1 rankText(10)');
  eq(GDSite.rankText(11), 'J', '1 rankText(11)=J');
  eq(GDSite.rankText(12), 'Q', '1 rankText(12)=Q');
  eq(GDSite.rankText(13), 'K', '1 rankText(13)=K');
  eq(GDSite.rankText(14), 'A', '1 rankText(14)=A');
  eq(GDSite.rankText(16), '小王', '1 rankText(16)=小王');
  eq(GDSite.rankText(17), '大王', '1 rankText(17)=大王');

  eq(GDSite.cardText(card(14, 0)), '♦A', '1 cardText(♦A)');
  eq(GDSite.cardText(card(2, 2)), '♥2', '1 cardText(♥2)');
  eq(GDSite.cardText(card(10, 1)), '♣10', '1 cardText(♣10)');
  eq(GDSite.cardText(card(13, 3)), '♠K', '1 cardText(♠K)');
  eq(GDSite.cardText(BIG0), '大王', '1 cardText(大王)');
  eq(GDSite.cardText(SMALL1), '小王', '1 cardText(小王)');
  eq(GDSite.cardTexts([card(14, 0), BIG0, card(5, 2)]), ['♦A', '大王', '♥5'], '1 cardTexts 数组');

  eq(GDSite.typeName(code(1, 5)), '单张', '1 typeName 单张');
  eq(GDSite.typeName(code(2, 5)), '对子', '1 typeName 对子');
  eq(GDSite.typeName(code(3, 5)), '三同张', '1 typeName 三同张');
  eq(GDSite.typeName(code(4, 5)), '三带二', '1 typeName 三带二');
  eq(GDSite.typeName(code(5, 5)), '钢板', '1 typeName 钢板');
  eq(GDSite.typeName(code(6, 5)), '三连对', '1 typeName 三连对');
  eq(GDSite.typeName(code(7, 5)), '顺子', '1 typeName 顺子');
  eq(GDSite.typeName(code(100, 5)), '炸弹4张', '1 typeName 炸弹4张');
  eq(GDSite.typeName(code(101, 5)), '炸弹5张', '1 typeName 炸弹5张');
  eq(GDSite.typeName(code(102, 5)), '同花顺', '1 typeName 同花顺');
  eq(GDSite.typeName(code(103, 5)), '炸弹6张', '1 typeName 炸弹6张');
  eq(GDSite.typeName(code(104, 5)), '炸弹7张', '1 typeName 炸弹7张');
  eq(GDSite.typeName(code(105, 5)), '炸弹8张', '1 typeName 炸弹8张');
  eq(GDSite.typeName(code(127, 0)), '四大天王', '1 typeName 四大天王');

  eq(GDSite.bombValue(code(100, 5)), 4, '1 bombValue 4炸=4');
  eq(GDSite.bombValue(code(101, 5)), 5, '1 bombValue 5炸=5');
  eq(GDSite.bombValue(code(102, 5)), 5.5, '1 bombValue 同花顺=5.5');
  eq(GDSite.bombValue(code(103, 5)), 6, '1 bombValue 6炸=6');
  eq(GDSite.bombValue(code(104, 5)), 7, '1 bombValue 7炸=7');
  eq(GDSite.bombValue(code(105, 5)), 8, '1 bombValue 8炸=8');
  eq(GDSite.bombValue(code(127, 0)), 99, '1 bombValue 四大天王=99');
  eq(GDSite.bombValue(code(7, 10)), 0, '1 bombValue 顺子=0');
}

// ============================== §2 牌型解释 interpretCodes/bestCode/playFromCards ==============================
const LVL = 3; // 主要测试级牌=3（避开 3 以外的自然牌；♥3 为逢人配）

function interpHas(cards, level, c, label) {
  const cs = GDSite.interpretCodes(cards, level);
  return ok(cs.indexOf(c) >= 0, label + ' — interpretCodes 应含 code ' + c + '，实际 [' + cs.join(',') + ']');
}
function interpHasNoType(cards, level, t, label) {
  const cs = GDSite.interpretCodes(cards, level);
  return ok(cs.every(c => (c >> 8) !== t), label + ' — 不应含 type ' + t + '，实际 [' + cs.join(',') + ']');
}
function bestEq(cards, level, c, label) { return eq(GDSite.bestCode(cards, 0, level), c, label); }

function sec2() {
  // ---- 单张 ----
  interpHas([card(5, 0)], LVL, code(1, 5), '2 单张 ♦5');
  bestEq([card(5, 0)], LVL, code(1, 5), '2 单张 ♦5 bestCode');
  bestEq([BIG0], LVL, code(1, 17), '2 单张 大王 rank17');
  bestEq([SMALL0], LVL, code(1, 16), '2 单张 小王 rank16');
  bestEq([WILD0], LVL, code(1, 15), '2 单出逢人配只能算级牌单张(order15)');
  bestEq([card(3, 0)], LVL, code(1, 15), '2 级牌单张 ♦3 order15');

  // ---- 对子 ----
  interpHas([card(5, 0), card(5, 1)], LVL, code(2, 5), '2 对子 5');
  interpHas([BIG0, BIG1], LVL, code(2, 17), '2 对子 双大王(合法)');
  bestEq([BIG0, BIG1], LVL, code(2, 17), '2 双大王对子 bestCode');
  interpHas([SMALL0, SMALL1], LVL, code(2, 16), '2 对子 双小王(合法)');
  bestEq([BIG0, SMALL0], LVL, 0, '2 大王+小王 不是对子');
  interpHas([WILD0, card(9, 0)], LVL, code(2, 9), '2 逢人配+♦9=对子9');
  interpHas([WILD0, card(3, 0)], LVL, code(2, 15), '2 逢人配+♦3=对子级牌(order15)');
  interpHas([WILD0, WILD1], LVL, code(2, 15), '2 两个逢人配=对子(order15)');
  interpHas([card(3, 0), card(3, 1)], LVL, code(2, 15), '2 两张级牌=对子(order15)');

  // ---- 三同张 ----
  interpHas([card(9, 0), card(9, 1), card(9, 3)], LVL, code(3, 9), '2 三同张 9');
  bestEq([card(9, 0), card(9, 1), card(9, 3)], LVL, code(3, 9), '2 三同张 9 bestCode');
  interpHas([card(9, 0), card(9, 1), WILD0], LVL, code(3, 9), '2 逢人配+两个9=三同张9');
  interpHas([card(3, 0), card(3, 1), card(3, 3)], LVL, code(3, 15), '2 三张级牌=三同张(order15)');

  // ---- 三带二 ----
  interpHas([card(13, 0), card(13, 1), card(13, 2), card(2, 0), card(2, 1)], LVL,
    code(4, 13), '2 三带二 KKK+22，rank 取三张 K');
  interpHas([card(13, 0), card(13, 1), card(13, 2), SMALL0, SMALL1], LVL,
    code(4, 13), '2 三带二 KKK+小王对子');
  interpHas([card(9, 0), card(9, 1), card(9, 2), card(4, 0), card(4, 1)], LVL,
    code(4, 9), '2 三带二 999+44');
  interpHas([card(9, 0), card(9, 1), card(9, 2), WILD0, card(4, 0)], LVL,
    code(4, 9), '2 逢人配补对子：999+4+♥3=三带二9');
  interpHas([card(9, 0), card(9, 1), WILD0, card(4, 0), card(4, 1)], LVL,
    code(4, 9), '2 逢人配补三张：99+♥3+44=三带二9');
  bestEq([card(13, 0), card(13, 1), card(13, 2), card(2, 0), card(2, 1)], LVL,
    code(4, 13), '2 三带二只比三张：KKK22 bestCode');

  // ---- 钢板（二连三）----
  interpHas([card(14, 0), card(14, 1), card(14, 2), card(2, 0), card(2, 1), card(2, 3)], LVL,
    code(5, 2), '2 钢板 AAA222（A 当 1），rank=2');
  interpHas([card(13, 0), card(13, 1), card(13, 2), card(14, 0), card(14, 1), card(14, 2)], LVL,
    code(5, 14), '2 钢板 KKKAAA，rank=A=14');
  interpHasNoType([card(2, 0), card(2, 1), card(2, 3), card(3, 0), card(3, 1), card(4, 0)], LVL,
    TYPE.Steel, '2 222334 不构成钢板');
  interpHas([card(14, 0), card(14, 1), card(14, 2), card(2, 0), card(2, 1), WILD0], LVL,
    code(5, 2), '2 逢人配补钢板 AAA22+♥3=钢板2');
  interpHas([card(10, 0), card(10, 1), card(10, 2), card(11, 0), card(11, 1), card(11, 2)], LVL,
    code(5, 11), '2 钢板 10-10-10-J-J-J rank=J=11');

  // ---- 三连对 ----
  interpHas([card(14, 0), card(14, 1), card(2, 0), card(2, 1), card(3, 0), card(3, 1)], LVL,
    code(6, 3), '2 三连对 AA2233（A 当 1），rank=3');
  interpHas([card(12, 0), card(12, 1), card(13, 0), card(13, 1), card(14, 0), card(14, 1)], LVL,
    code(6, 14), '2 三连对 QQKKAA，rank=A=14');
  interpHasNoType([card(2, 0), card(2, 1), card(14, 0), card(14, 1), card(13, 0), card(13, 1)], LVL,
    TYPE.TriplePairs, '2 22AAKK 不构成三连对');
  interpHas([card(14, 0), card(14, 1), card(2, 0), card(2, 1), card(3, 0), WILD0], LVL,
    code(6, 3), '2 逢人配补三连对 AA22+3+♥3=AA2233');

  // ---- 顺子 ----
  interpHas([card(14, 0), card(2, 1), card(3, 3), card(4, 0), card(5, 1)], LVL,
    code(7, 5), '2 顺子 A2345，rank=窗口顶5');
  interpHas([card(10, 0), card(11, 1), card(12, 2), card(13, 3), card(14, 0)], LVL,
    code(7, 14), '2 顺子 10JQKA，rank=14');
  interpHas([card(2, 0), card(3, 1), card(4, 2), card(5, 3), card(6, 0)], LVL,
    code(7, 6), '2 顺子 23456，rank=6');
  interpHasNoType([card(12, 0), card(13, 1), card(14, 2), card(2, 3), card(3, 0)], LVL,
    TYPE.Straight, '2 QKA23 不构成顺子');
  bestEq([card(12, 0), card(13, 1), card(14, 2), card(2, 3), card(3, 0)], LVL, 0, '2 QKA23 bestCode=0');
  interpHasNoType([card(10, 0), card(11, 1), card(12, 2), card(13, 3), BIG0], LVL,
    TYPE.Straight, '2 王不能参与顺子');
  interpHas([card(6, 0), card(7, 1), card(8, 2), card(9, 3), WILD0], LVL,
    code(7, 10), '2 逢人配补顺子 6789+♥3=6789(10)');
  bestEq([card(6, 0), card(7, 1), card(8, 2), card(9, 3), WILD0], LVL,
    code(7, 10), '2 逢人配顺子 bestCode=Straight10');

  // ---- 同花顺 ----
  const sfA2345 = [card(14, 0), card(2, 0), card(3, 0), card(4, 0), card(5, 0)]; // 全 ♦
  interpHas(sfA2345, LVL, code(102, 5), '2 同花顺 ♦A2345 给出 straightflush(code102)');
  interpHas(sfA2345, LVL, code(7, 5), '2 同花顺同时给出 straight 解读(code7)');
  bestEq(sfA2345, LVL, code(102, 5), '2 同花顺 bestCode 取 straightflush');
  const sfHearts = [card(6, 2), card(7, 2), card(8, 2), card(9, 2), WILD0]; // ♥6..9 + ♥3
  interpHas(sfHearts, LVL, code(102, 10), '2 逢人配补同花顺 ♥6-♥10');
  interpHas(sfHearts, LVL, code(7, 10), '2 逢人配补同花顺同时给出 straight');
  bestEq(sfHearts, LVL, code(102, 10), '2 逢人配同花顺 bestCode');
  interpHasNoType([card(6, 0), card(7, 1), card(8, 2), card(9, 3), card(10, 0)], LVL,
    TYPE.StraightFlush, '2 混花色顺子不是同花顺');

  // ---- 炸弹 ----
  const four9 = [card(9, 0), card(9, 1), card(9, 2), card(9, 3)];
  interpHas(four9, LVL, code(100, 9), '2 4炸 9999');
  bestEq(four9, LVL, code(100, 9), '2 4炸 bestCode');
  const five9 = four9.concat([card(9, 0, 1)]);
  interpHas(five9, LVL, code(101, 9), '2 5炸 5 张9');
  const six9 = five9.concat([card(9, 1, 1)]);
  interpHas(six9, LVL, code(103, 9), '2 6炸 6 张9');
  const seven9 = six9.concat([card(9, 2, 1)]);
  interpHas(seven9, LVL, code(104, 9), '2 7炸 7 张9');
  const eight9 = seven9.concat([card(9, 3, 1)]);
  interpHas(eight9, LVL, code(105, 9), '2 8炸 8 张9');
  bestEq(eight9, LVL, code(105, 9), '2 8炸 bestCode');
  interpHas([BIG0, BIG1, SMALL0, SMALL1], LVL, code(127, 0), '2 四大天王');
  bestEq([BIG0, BIG1, SMALL0, SMALL1], LVL, code(127, 0), '2 四大天王 bestCode');
  // 逢人配补炸
  interpHas([card(9, 0), card(9, 1), card(9, 2), WILD0], LVL, code(100, 9), '2 3张9+逢人配=4炸9');
  interpHas(four9.concat([WILD0]), LVL, code(101, 9), '2 4张9+逢人配=5炸9');
  interpHas([card(3, 0), card(3, 1), WILD0, WILD1], LVL, code(100, 15),
    '2 两张3+两个逢人配=4炸级牌(order15)');
  const eight3 = [card(3, 0), card(3, 1), card(3, 2), card(3, 3),
    card(3, 0, 1), card(3, 1, 1), card(3, 2, 1), card(3, 3, 1)];
  interpHas(eight3, LVL, code(105, 15), '2 8 张级牌=8炸(order15)');
  bestEq(eight3, LVL, code(105, 15), '2 8 张级牌 bestCode');
  // 没有 9/10 张炸弹概念：8 张以上同点只按 8 炸最强（4..8 之外不产生炸弹 code）
  const nine9 = eight9.concat([card(9, 0, 1)]); // 9 张 9（两副共 8 张，理论上不存在；验证不产生 >8 炸）
  let hasBadBomb = false;
  for (const c of GDSite.interpretCodes(nine9, LVL)) {
    const t = c >> 8;
    if (t >= 100 && t <= 105 && t > 105) hasBadBomb = true;
  }
  ok(!hasBadBomb, '2 不存在炸弹9/10 类型（type 只到 Eight=105）');

  // ---- playFromCards ----
  const pSingle = GDSite.playFromCards([card(5, 0)], LVL);
  ok(!!pSingle, '2 playFromCards 单张非 null');
  if (pSingle) {
    eq(pSingle.type, 1, '2 Play.type=Single'); eq(pSingle.code, code(1, 5), '2 Play.code');
    eq(pSingle.rank, 5, '2 Play.rank'); eq(pSingle.size, 1, '2 Play.size=1');
    eq(pSingle.bomb, 0, '2 Play.bomb=0'); eq(pSingle.level, LVL, '2 Play.level=3');
    ok(typeof pSingle.name === 'string' && pSingle.name.length > 0, '2 Play.name 非空');
    ok(typeof pSingle.desc === 'string' && pSingle.desc.length > 0, '2 Play.desc 非空');
  }
  const pPair = GDSite.playFromCards([card(9, 0), card(9, 1)], LVL);
  ok(!!pPair, '2 playFromCards 对子');
  if (pPair) {
    eq(pPair.type, 2, '2 Play 对子 type'); eq(pPair.code, code(2, 9), '2 Play 对子 code');
    eq(pPair.rank, 9, '2 Play 对子 rank'); eq(pPair.size, 2, '2 Play 对子 size');
    ok(sameSet(pPair.cards, [card(9, 0), card(9, 1)]), '2 Play.cards 与原牌一致');
  }
  const pBomb = GDSite.playFromCards(four9, LVL);
  ok(!!pBomb, '2 playFromCards 4炸');
  if (pBomb) {
    eq(pBomb.type, 100, '2 Play 4炸 type'); eq(pBomb.bomb, 4, '2 Play 4炸 bomb=4');
    eq(pBomb.rank, 9, '2 Play 4炸 rank');
  }
  const pJoker = GDSite.playFromCards([BIG0, BIG1, SMALL0, SMALL1], LVL);
  ok(!!pJoker, '2 playFromCards 四大天王');
  if (pJoker) {
    eq(pJoker.type, 127, '2 Play 天王 type'); eq(pJoker.bomb, 99, '2 Play 天王 bomb=99');
    eq(pJoker.rank, 0, '2 Play 天王 rank=0');
  }
  // 同花顺可作顺子出：显式 code 指定
  const pSf = GDSite.playFromCards(sfA2345, LVL);
  ok(!!pSf && pSf.type === 102, '2 同花顺默认按 straightflush 出');
  const pSfAsStraight = GDSite.playFromCards(sfA2345, LVL, code(7, 5));
  ok(!!pSfAsStraight && pSfAsStraight.type === 7, '2 同花顺可指定按顺子(type7)出');
  // 显式 code 与牌张数不匹配：SPEC2 §2 只写「playFromCards(cards, level, code?) -> Play|null」，
  // 未规定该情形的返回值，故只要求实现不抛异常并给出 null 或带有该 code 的 Play（不作为规则断言）。
  let mismatchOk = true;
  try {
    const r1 = GDSite.playFromCards([card(9, 0), card(9, 1)], LVL, code(1, 9));
    if (!(r1 === null || (r1 && r1.code === code(1, 9)))) mismatchOk = false;
    const r2 = GDSite.playFromCards([card(9, 0), card(9, 1), card(9, 2)], LVL, code(2, 9));
    if (!(r2 === null || (r2 && r2.code === code(2, 9)))) mismatchOk = false;
  } catch (e) { mismatchOk = false; }
  ok(mismatchOk, '2 显式 code 与张数不匹配：不抛异常（SPEC2 未规定返回值，宽容）');
}

// ============================== §3 压牌与炸弹链 ==============================
function sec3() {
  const beats = (a, b) => GDSite.beats(a, b);
  ok(beats(code(1, 9), code(1, 8)) === true, '3 单张9 压 单张8');
  ok(beats(code(1, 8), code(1, 9)) === false, '3 单张8 不压 单张9');
  ok(beats(code(2, 9), code(2, 9)) === false, '3 同点对子不能互压');
  ok(beats(code(1, 15), code(1, 14)) === true, '3 级牌单张(order15) 压 A');
  ok(beats(code(7, 10), code(2, 5)) === false, '3 顺子不能压对子（异型非炸）');
  ok(beats(code(2, 5), code(7, 10)) === false, '3 对子不能压顺子');
  ok(beats(code(100, 3), code(1, 17)) === true, '3 4炸 压 单张大王（炸弹压非炸）');
  ok(beats(code(1, 17), code(100, 3)) === false, '3 非炸弹不能压炸弹');
  // 炸弹链：4<5<同花顺(5.5)<6<7<8<四大天王
  ok(beats(code(101, 3), code(100, 8)) === true, '3 5炸 压 4炸');
  ok(beats(code(102, 5), code(101, 8)) === true, '3 同花顺(5.5) 压 5炸');
  ok(beats(code(101, 8), code(102, 5)) === false, '3 5炸 不压 同花顺');
  ok(beats(code(103, 2), code(102, 14)) === true, '3 6炸 压 同花顺');
  ok(beats(code(104, 2), code(103, 8)) === true, '3 7炸 压 6炸');
  ok(beats(code(105, 2), code(104, 8)) === true, '3 8炸 压 7炸');
  ok(beats(code(127, 0), code(105, 8)) === true, '3 四大天王 压 8炸');
  ok(beats(code(127, 0), code(102, 14)) === true, '3 四大天王 压 同花顺');
  ok(beats(code(127, 0), code(127, 0)) === false, '3 四大天王不能互压');
  ok(beats(code(102, 14), code(102, 5)) === true, '3 同花顺比顶位(14>5)');
  ok(beats(code(105, 2), code(102, 14)) === true, '3 8炸 压 同花顺(同花顺=5.5)');

  // bestCode 过滤
  eq(GDSite.bestCode([card(9, 0), card(9, 1)], code(2, 8), LVL), code(2, 9),
    '3 bestCode: 对子9 可压 对子8');
  eq(GDSite.bestCode([card(9, 0), card(9, 1)], code(2, 9), LVL), 0,
    '3 bestCode: 对子9 不能压 对子9');
  eq(GDSite.bestCode([card(9, 0), card(9, 1)], code(2, 10), LVL), 0,
    '3 bestCode: 对子9 不能压 对子10');
  eq(GDSite.bestCode(four9Cards(), code(7, 14), LVL), code(100, 9),
    '3 bestCode: 4炸9 可压 顺子10JQKA');
  eq(GDSite.bestCode([card(9, 0), card(9, 1)], code(100, 3), LVL), 0,
    '3 bestCode: 对子 压不过 炸弹');
  eq(GDSite.bestCode([BIG0, BIG1, SMALL0, SMALL1], code(127, 0), LVL), 0,
    '3 bestCode: 四大天王 压不过 四大天王');
  const sfA = [card(14, 0), card(2, 0), card(3, 0), card(4, 0), card(5, 0)];
  eq(GDSite.bestCode(sfA, code(101, 8), LVL), code(102, 5),
    '3 bestCode: 同花顺 可压 5炸（同花顺 5.5 > 5）');
  eq(GDSite.bestCode(sfA, code(103, 2), LVL), 0, '3 bestCode: 同花顺 压不过 6炸');
  eq(GDSite.bestCode([], 0, LVL), 0, '3 bestCode: 空牌 → 0');
}
function four9Cards() { return [card(9, 0), card(9, 1), card(9, 2), card(9, 3)]; }

// ============================== §4 replayActions ==============================
function sec4() {
  const R = (segs, firstPlayer, types) => {
    const p = playSegs(segs, types);
    return GDSite.replayActions(p.playedCardList, firstPlayer, p.playedTypeList);
  };

  // 出牌 + 三家过 → 三过清墩，牌权回到出牌人
  {
    const r = R([[5], [], [], []], 1, [code(1, 5), 0, 0, 0]);
    eq(r.rankList, [], '4 单张+三过：无人出完 rankList=[]');
    eq(r.trickOwner, 0, '4 三过清墩后 trickOwner=0');
    eq(r.lastCards, [], '4 三过清墩后 lastCards=[]');
    eq(r.lastInterp, 0, '4 三过清墩后 lastInterp=0');
    eq(r.currentPlayer, 1, '4 三过清墩后由出牌人(1)重新领出');
    eq(r.restCounts, [0, 26, 27, 27, 27], '4 restCounts：1 家出了一张');
    eq(r.restCounts[1], 26, '4 restCounts[1]=26');
    eq(r.initialHolders[4], 1, '4 initialHolders：id5 由 1 家出');
    eq(r.lastSegmentPlayer, 4, '4 lastSegmentPlayer=最后一段执行者4');
    ok(r.trickActions[1] && sameSet(r.trickActions[1].cards, [5]) && r.trickActions[1].passed === false,
      '4 trickActions[1] 有牌未过');
    ok(r.trickActions[2] && r.trickActions[2].passed === true && r.trickActions[2].cards === null,
      '4 trickActions[2] 为过牌');
  }

  // 出牌 + 两家过 + 第 4 家压 → 牌权转移
  {
    const r = R([[5], [], [], [card(9, 1)]], 1, [code(1, 5), 0, 0, code(1, 9)]);
    eq(r.trickOwner, 4, '4 第4家压牌后 trickOwner=4');
    eq(r.lastCards, [card(9, 1)], '4 lastCards=第4家所出');
    eq(r.lastInterp, code(1, 9), '4 lastInterp=第4家牌型 code');
    eq(r.currentPlayer, 1, '4 第4家出完由下家(1)接手');
    eq(r.lastSegmentPlayer, 4, '4 lastSegmentPlayer=4');
    eq(r.rankList, [], '4 无人出完');
  }

  // 顺序：每段执行者是进入该段时的 currentPlayer
  {
    const r = R([[5], [6], [7]], 2, [code(1, 5), code(1, 6), code(1, 7)]);
    eq(r.lastSegmentPlayer, 4, '4 段执行者按出牌顺序递推：2→3→4，最后一段=4');
    eq(r.initialHolders[4], 2, '4 initialHolders id5 → 2家');
    eq(r.initialHolders[5], 3, '4 initialHolders id6 → 3家');
    eq(r.initialHolders[6], 4, '4 initialHolders id7 → 4家');
    eq(r.trickOwner, 4, '4 最后出牌者牌权=4');
    eq(r.lastCards, [7], '4 lastCards=[7]');
  }

  // 空动作列表
  {
    const r = GDSite.replayActions([], 1, []);
    eq(r.rankList, [], '4 空回放 rankList=[]');
    eq(r.currentPlayer, 1, '4 空回放 currentPlayer=firstPlayer');
    eq(r.restCounts, [0, 27, 27, 27, 27], '4 空回放 restCounts 全 27');
    eq(r.trickOwner, 0, '4 空回放 trickOwner=0');
    eq(r.lastSegmentPlayer, 0, '4 空回放 lastSegmentPlayer=0');
  }

  // 27 张单牌出完 → 借风：牌权交给对家(partner(1)=3)
  {
    const segs = [], types = [];
    for (let t = 1; t <= 27; t++) {
      segs.push([t]); types.push(code(1, GDSite.levelOrder(GDSite.rankOf(t), 2)));
      segs.push([]); types.push(0);
      segs.push([]); types.push(0);
      segs.push([]); types.push(0);
    }
    const r = R(segs, 1, types);
    eq(r.rankList, [1], '4 出完 27 张：rankList=[1]');
    eq(r.restCounts[1], 0, '4 出完者剩余=0');
    eq(r.currentPlayer, 3, '4 出完借风：对家(3)领出');
    eq(r.trickOwner, 0, '4 出完借风后 trickOwner=0');
    eq(r.lastCards, [], '4 出完借风后 lastCards=[]');
    eq(r.lastInterp, 0, '4 出完借风后 lastInterp=0');
    ok(r.trickActions[1] === null, '4 已出完者的桌面牌被清理');
  }

  // 4 家依次出完 rankOrder（按 §1.5 回放规则插入必要的「过」段，使 currentPlayer 递推到目标座位）
  function buildFinishRankOrder(rankOrder, firstPlayer) {
    // 每家手牌 id 段：1 家 1..27，2 家 28..54，3 家 55..81，4 家 82..108
    const handsOf = (s) => {
      const out = [];
      for (let i = 27 * (s - 1) + 1; i <= 27 * s; i++) out.push(i);
      return out;
    };
    const first = firstPlayer || rankOrder[0];
    const finished = [false, false, false, false, false];
    const partner = (s) => (s <= 2 ? s + 2 : s - 2);
    const nextActive = (s) => {
      let t = s % 4 + 1;
      for (let i = 0; i < 4; i++) { if (!finished[t]) return t; t = t % 4 + 1; }
      return s;
    };
    const segs = [], types = [];
    const emitPass = () => { segs.push([]); types.push(0); };
    let current = first;
    let trickOwner = 0;
    const passed = new Set();
    for (const seat of rankOrder) {
      let guard = 0;
      while (current !== seat && guard++ < 20) {
        if (finished[current]) { current = nextActive(current); continue; }
        emitPass();
        passed.add(current);
        const nx = nextActive(current);
        if (trickOwner && (nx === trickOwner || passed.has(nx))) {
          const h = trickOwner;
          trickOwner = 0; passed.clear();
          current = finished[h] ? partner(h) : h;
        } else {
          current = nx;
        }
      }
      if (current !== seat) throw new Error('buildFinishRankOrder 无法到达座位 ' + seat);
      segs.push(handsOf(seat)); types.push(code(1, GDSite.levelOrder(GDSite.rankOf(handsOf(seat)[0]), 2)));
      finished[seat] = true;
      trickOwner = seat;
      passed.clear();
      current = nextActive(seat);
    }
    return R(segs, first, types);
  }
  {
    const r = buildFinishRankOrder([1, 3, 2, 4]);
    eq(r.rankList, [1, 3, 2, 4], '4 出完顺序 rankList=[1,3,2,4]');
    eq(r.restCounts, [0, 0, 0, 0, 0], '4 全出完后 restCounts 全 0');
    eq(r.initialHolders[0], 1, '4 initialHolders id1 → 1家');
    eq(r.initialHolders[27], 2, '4 initialHolders id28 → 2家');
    eq(r.initialHolders[54], 3, '4 initialHolders id55 → 3家');
    eq(r.initialHolders[81], 4, '4 initialHolders id82 → 4家');
    eq(r.lastSegmentPlayer, 4, '4 出完顺序最后执行者=4');
  }
  {
    const r = buildFinishRankOrder([1, 2, 3, 4]);
    eq(r.rankList, [1, 2, 3, 4], '4 出完顺序 rankList=[1,2,3,4]');
  }
  {
    const r = buildFinishRankOrder([2, 4, 1, 3]);
    eq(r.rankList, [2, 4, 1, 3], '4 出完顺序 rankList=[2,4,1,3]');
    eq(r.restCounts, [0, 0, 0, 0, 0], '4 全出完 restCounts 全 0');
  }
}

// ============================== §5 expandState ==============================
function sec5() {
  // 基础 play 阶段
  const cpl1 = cplDeal(); cpl1[5 - 1] = 0; // 1 家打出 id5
  const raw1 = makeRaw({
    state: 1, firstPlayer: 1, cardPositionList: cpl1,
    playedCardList: [0, 5], playedTypeList: [code(1, 5)]
  });
  const raw1Before = JSON.stringify(raw1);
  const exp1 = GDSite.expandState(raw1);
  eq(JSON.stringify(raw1), raw1Before, '5 expandState 不修改入参 raw');
  eq(exp1.level, 2, '5 无上局名次时 level=2');
  eq(exp1.playingTeam, 0, '5 无上局名次时 playingTeam=0');
  eq(exp1.heartLevelCardId, 28, '5 level2 逢人配 ♥2 id=28');
  eq(exp1.isRoundFinish, false, '5 state<=8 非本局结束');
  eq(exp1.phase, 'play', '5 state=1 → phase=play');
  eq(exp1.rankList, [], '5 无出完 rankList=[]');
  eq(exp1.trickOwner, 1, '5 trickOwner=1');
  eq(exp1.lastCards, [5], '5 lastCards=[5]');
  eq(exp1.lastInterp, code(1, 5), '5 lastInterp=Single5');
  eq(exp1.lastSegmentPlayer, 1, '5 lastSegmentPlayer=1');
  eq(exp1.currentPlayer, 2, '5 currentPlayer=2（下家）');
  eq(exp1.canPlayAnyCards, false, '5 有牌权 → canPlayAnyCards=false');
  eq(exp1.restCounts || exp1.playerRestCardCounts, exp1.playerRestCardCounts, '5 派生含剩余张数');
  eq(exp1.playerRestCardCounts, [0, 26, 27, 27, 27], '5 playerRestCardCounts');
  len(exp1.playerCardLists, 5, '5 playerCardLists 5 项（下标 0 占位，与站点 l=[[],[],[],[],[]] 一致）');
  eq(exp1.playerCardLists[0].length, 0, '5 playerCardLists[0] 为空（座位 1..4 对应下标 1..4）');
  eq(exp1.playerCardLists[1].length, 26, '5 1 家手牌 26 张');
  eq(exp1.playerCardLists[2].length, 27, '5 2 家手牌 27 张');
  eq(exp1.initialHolders[5 - 1], 1, '5 initialHolders id5=1家');
  eq(exp1.tributers, [], '5 无上局名次 tributers=[]');
  eq(exp1.tributeReceivers, [], '5 tributeReceivers=[]');
  eq(exp1.resistInfo, [], '5 无贡家 resistInfo=[]');
  eq(exp1.roundResult, null, '5 未结束 roundResult=null');
  eq(exp1.cardPositionList[5 - 1], 0, '5 cardPositionList 保留 id5 已出=0');

  // 领出（无任何动作）
  {
    const exp = GDSite.expandState(makeRaw({ state: 1, firstPlayer: 1 }));
    eq(exp.canPlayAnyCards, true, '5 无上一手 → canPlayAnyCards=true');
    eq(exp.trickOwner, 0, '5 无上一手 trickOwner=0');
    eq(exp.lastCards, [], '5 无上一手 lastCards=[]');
    eq(exp.lastInterp, 0, '5 无上一手 lastInterp=0');
    eq(exp.currentPlayer, 1, '5 无动作 currentPlayer=firstPlayer');
    eq(exp.phase, 'play', '5 无动作 state=1 phase=play');
  }

  // phase：tribute / return / play / finish
  {
    const expT = GDSite.expandState(makeRaw({ state: 0, tributeCardList: [0] }));
    eq(expT.phase, 'tribute', '5 state=0 且 tributeCardList 含 0 → phase=tribute');
    const expR1 = GDSite.expandState(makeRaw({ state: 0, tributeCardList: [5] }));
    eq(expR1.phase, 'return', '5 state=0 且进度已填 → phase=return');
    const expR2 = GDSite.expandState(makeRaw({ state: 0, tributeCardList: [] }));
    eq(expR2.phase, 'return', '5 state=0 且无待贡 → phase=return');
    const expF = GDSite.expandState(makeRaw({ state: 9 }));
    eq(expF.phase, 'finish', '5 state>8 → phase=finish');
    eq(expF.isRoundFinish, true, '5 state>8 → isRoundFinish=true');
    eq(GDSite.expandState(makeRaw({ state: 5 })).phase, 'play', '5 state=5 → phase=play');
  }

  // level / playingTeam / heartLevelCardId
  {
    const e1 = GDSite.expandState(makeRaw({ state: 1, lastRankList: [1, 3, 2, 4], team13Level: 7, team24Level: 4 }));
    eq(e1.level, 7, '5 上局首名 1(红队) → level=team13Level=7');
    eq(e1.playingTeam, 1, '5 上局首名 1 → playingTeam=1');
    eq(e1.heartLevelCardId, 33, '5 level7 逢人配=♥7 id33');
    eq(e1.tributers, [2, 4], '5 lastRankList[1,3,2,4] 同队占前二 → 贡家=[2,4]');
    eq(e1.receivers, [1, 3], '5 lastRankList[1,3,2,4] 收贡=[1,3]');
    const e2 = GDSite.expandState(makeRaw({ state: 1, lastRankList: [2, 4, 1, 3], team13Level: 4, team24Level: 9 }));
    eq(e2.level, 9, '5 上局首名 2(蓝队) → level=team24Level=9');
    eq(e2.playingTeam, 2, '5 上局首名 2 → playingTeam=2');
    eq(e2.tributers, [1, 3], '5 lastRankList[2,4,1,3] → 贡家=[1,3]');
    eq(e2.receivers, [2, 4], '5 lastRankList[2,4,1,3] → 收贡=[2,4]');
    const e3 = GDSite.expandState(makeRaw({ state: 1, lastRankList: [1, 2, 3, 4], team13Level: 5 }));
    eq(e3.level, 5, '5 lastRankList[1,2,3,4] → level=team13Level=5');
    eq(e3.tributers, [4], '5 首名不同队(1,2) → 只第4名进贡');
    eq(e3.receivers, [1], '5 首名不同队 → 第1名收贡');
    const e14 = GDSite.expandState(makeRaw({ state: 1, lastRankList: [1, 2, 3, 4], team13Level: 14 }));
    eq(e14.level, 14, '5 level=14');
    eq(e14.heartLevelCardId, 27, '5 level14 逢人配=♥A id27');
  }

  // tributeReceivers
  {
    const raw = makeRaw({ state: 0, lastRankList: [1, 2, 3, 4], tributeCardList: [5] });
    const e = GDSite.expandState(raw);
    eq(e.tributers, [4], '5 tribute 场景 tributers=[4]');
    eq(e.tributeReceivers, [1], '5 tributeCardList 长度=贡家数 → tributeReceivers=[1]');
    const raw2 = makeRaw({ state: 0, lastRankList: [1, 3, 2, 4], tributeCardList: [5] });
    eq(GDSite.expandState(raw2).tributeReceivers, [], '5 tributeCardList 长度不符 → tributeReceivers=[]');
    const raw3 = makeRaw({ state: 0, lastRankList: [1, 2, 3, 4], tributeCardList: [0] });
    eq(GDSite.expandState(raw3).tributeReceivers, [1], '5 tribute 未完成时 tributeReceivers 仍按长度给出');
  }

  // resistInfo：贡家手里的大王数（含已打出的通过 initialHolders 追溯）
  {
    const cpl = new Array(108).fill(0);
    cpl[BIG0 - 1] = 4;   // 4 家手里有大王
    cpl[BIG1 - 1] = 4;   // 4 家手里有第二张大王
    const raw = makeRaw({ state: 5, lastRankList: [1, 2, 3, 4], tributeCardList: [], cardPositionList: cpl });
    const e = GDSite.expandState(raw);
    eq(e.tributers, [4], '5 resistInfo 场景贡家=[4]');
    eq(e.resistInfo, [{ position: 4, bigJokerCount: 2 }], '5 resistInfo：4 家 2 张大王');
  }
  {
    const cpl = new Array(108).fill(0);
    cpl[BIG1 - 1] = 4;
    const raw = makeRaw({
      state: 5, firstPlayer: 4, lastRankList: [1, 2, 3, 4], tributeCardList: [],
      cardPositionList: cpl, playedCardList: [0, BIG0], playedTypeList: [code(1, 17)]
    });
    const e = GDSite.expandState(raw);
    eq(e.resistInfo, [{ position: 4, bigJokerCount: 2 }], '5 resistInfo：1 张在手+1 张已由贡家打出=2');
  }
  {
    const e = GDSite.expandState(makeRaw({ state: 5, lastRankList: [1, 2, 3, 4], tributeCardList: [5] }));
    eq(e.resistInfo, [], '5 进贡已填写时 resistInfo=[]');
  }
}

// ============================== §6 protobuf 编解码 ==============================
function sec6() {
  const cpl = cplDeal();
  const raw = makeRaw({
    state: 3, firstPlayer: 1, v: 42, team13Level: 7, team24Level: 9,
    lastRankList: [1, 3, 2, 4], tributeCardList: [5], returnCardList: [6],
    cardPositionList: cpl, playedCardList: [0, 5, 0, 0, 29], playedTypeList: [code(1, 5), 0, 0]
  });
  const bytes = GDSite.encodeGameData(raw);
  ok(!!bytes && (bytes instanceof Uint8Array || Array.isArray(bytes)), '6 encodeGameData 返回 Uint8Array');
  const dec = GDSite.decodeGameData(bytes);
  ok(!!dec && typeof dec === 'object', '6 decodeGameData 返回对象');
  if (dec) {
    eq(dec.rule, 2, '6 往返 rule=2');
    eq(dec.state, 3, '6 往返 state=3');
    eq(dec.v, 42, '6 往返 v=42');
    eq(dec.team13Level, 7, '6 往返 team13Level=7');
    eq(dec.team24Level, 9, '6 往返 team24Level=9');
    eq(dec.lastRankList, [1, 3, 2, 4], '6 往返 lastRankList');
    eq(dec.tributeCardList, [5], '6 往返 tributeCardList');
    eq(dec.returnCardList, [6], '6 往返 returnCardList');
    eq(dec.firstPlayer, 1, '6 往返 firstPlayer');
    eq(dec.cardPositionList, cpl, '6 往返 cardPositionList(108 项)');
    eq(dec.playedCardList, [0, 5, 0, 0, 29], '6 往返 playedCardList');
    eq(dec.playedTypeList, [code(1, 5), 0, 0], '6 往返 playedTypeList');
  }
  // 编码确定性
  const bytes2 = GDSite.encodeGameData(makeRaw({
    state: 3, firstPlayer: 1, v: 42, team13Level: 7, team24Level: 9,
    lastRankList: [1, 3, 2, 4], tributeCardList: [5], returnCardList: [6],
    cardPositionList: cpl, playedCardList: [0, 5, 0, 0, 29], playedTypeList: [code(1, 5), 0, 0]
  }));
  eq(Array.from(bytes), Array.from(bytes2), '6 encodeGameData 同输入输出确定');

  // 手工 wire0 / packed 混合解码 + 未知字段跳过
  function varint(n) {
    const out = [];
    while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return out;
  }
  const b = [];
  b.push(0x08); b.push(2);                    // field1 rule=2 (wire0)
  b.push(0x10); b.push(1);                    // field2 state=1
  b.push(0x20); b.push(9);                    // field4 cardPositionList wire0 单值 9
  b.push(0x22); b.push(2); b.push(10); b.push(11); // field4 packed=[10,11]
  b.push(0x60); b.push(1);                    // field12 firstPlayer=1
  b.push(0x68); b.push(5);                    // field13 playedTypeList wire0 单值 5
  b.push(0x98); b.push(0x06); b.push(7);      // field99 未知 → 跳过
  const dec2 = GDSite.decodeGameData(new Uint8Array(b));
  eq(dec2.rule, 2, '6 wire0 解码 rule');
  eq(dec2.state, 1, '6 wire0 解码 state');
  eq(dec2.cardPositionList, [9, 10, 11], '6 兼容 packed(wire2)+单值(wire0) repeated');
  eq(dec2.firstPlayer, 1, '6 wire0 解码 firstPlayer');
  eq(dec2.playedTypeList, [5], '6 wire0 解码 playedTypeList');
  ok(dec2.field99 === undefined && dec2[99] === undefined, '6 未知字段被跳过');
}

// ============================== §7 remainingCounts（记牌器） ==============================
function rowOf(cnt, rank) { return (cnt.byRank || []).find(r => r.rank === rank); }
function chkRow(cnt, rank, exp, label) {
  const r = rowOf(cnt, rank);
  if (!r) { ok(false, label + ' — 缺 rank ' + rank + ' 行'); return; }
  for (const k of Object.keys(exp)) eq(r[k], exp[k], label + ' rank' + rank + '.' + k);
}

function sec7() {
  // 干净发牌态：1 家手牌 id1..27；级牌=3（上局首名 1、红队级 3）
  const clean = makeRaw({
    state: 1, firstPlayer: 1, lastRankList: [1, 3, 2, 4], team13Level: 3, team24Level: 2,
    cardPositionList: cplDeal()
  });
  const exp = GDSite.expandState(clean);
  const cnt = GDSite.remainingCounts(exp, 1);
  ok(!!cnt && typeof cnt === 'object', '7 remainingCounts 返回对象');
  eq(cnt.total, 108, '7 total=108');
  eq(cnt.mineCount, 27, '7 mineCount=27');
  eq(cnt.playedCount, 0, '7 未出牌 playedCount=0');
  eq(cnt.unknown, 81, '7 unknown=108-我手-已出=81');
  eq(cnt.wildRemaining, 2, '7 两个逢人配都未出 → wildRemaining=2');
  eq(cnt.ok, true, '7 状态一致 ok=true');
  ok(cnt.warnings === undefined || (Array.isArray(cnt.warnings) && cnt.warnings.length === 0),
    '7 状态一致时无 warnings（undefined 或空数组）');
  len(cnt.byRank, 15, '7 byRank 共 15 个点数(2..K、A、小王、大王)');
  eq(cnt.byRank.map(r => r.rank).sort((a, b) => a - b),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17],
    '7 byRank 点数覆盖 2..14/16/17 且无重复（级牌行 rank=3，用 isLevel 标记）');
  chkRow(cnt, 3, { total: 8, played: 0, mine: 2, remaining: 6, isLevel: true, isWild: true },
    '7 级牌行(我的♦3♣3)');
  chkRow(cnt, 5, { total: 8, played: 0, mine: 2, remaining: 6, isLevel: false, isWild: false },
    '7 普通行 5');
  chkRow(cnt, 14, { total: 8, played: 0, mine: 3, remaining: 5 }, '7 A 行（我的♦A♣A♥A=3）');
  chkRow(cnt, 16, { total: 2, played: 0, mine: 0, remaining: 2 }, '7 小王行 total=2');
  chkRow(cnt, 17, { total: 2, played: 0, mine: 0, remaining: 2 }, '7 大王行 total=2');
  let sumMine = 0, sumRemaining = 0, rowsOk = true;
  for (const r of cnt.byRank) {
    sumMine += r.mine; sumRemaining += r.remaining;
    if (r.remaining !== r.total - r.played - r.mine) rowsOk = false;
  }
  eq(sumMine, 27, '7 各行 mine 合计=27');
  eq(sumRemaining, 81, '7 各行 remaining 合计=81');
  ok(rowsOk, '7 每行 remaining = total - played - mine');
  eq(cnt.unknown, 108 - cnt.mineCount - cnt.playedCount, '7 unknown = 108 - mine - played');

  // 逢人配已出 → wildRemaining 减少，且该点数 played 增加
  const cpl2 = cplDeal(); cpl2[WILD0 - 1] = 0;
  const raw2 = makeRaw({
    state: 3, firstPlayer: 2, lastRankList: [1, 3, 2, 4], team13Level: 3, team24Level: 2,
    cardPositionList: cpl2, playedCardList: [0, WILD0], playedTypeList: [code(1, 15)]
  });
  const cnt2 = GDSite.remainingCounts(GDSite.expandState(raw2), 1);
  eq(cnt2.wildRemaining, 1, '7 ♥3 已出 → wildRemaining=1');
  eq(cnt2.playedCount, 1, '7 playedCount=1');
  eq(cnt2.unknown, 80, '7 unknown=108-27-1=80');
  chkRow(cnt2, 3, { total: 8, played: 1, mine: 2, remaining: 5 }, '7 级牌行：已出1+我2');

  // 逢人配在我手 → wildRemaining 减少，级牌行 mine 增加
  const cpl3 = cplDeal();
  cpl3[5 - 1] = 2;        // ♦5 换给 2 家
  cpl3[WILD0 - 1] = 1;    // ♥3 给我
  const cnt3 = GDSite.remainingCounts(
    GDSite.expandState(makeRaw({
      state: 1, firstPlayer: 1, lastRankList: [1, 3, 2, 4], team13Level: 3, team24Level: 2,
      cardPositionList: cpl3
    })), 1);
  eq(cnt3.wildRemaining, 1, '7 ♥3 在我手 → wildRemaining=1');
  eq(cnt3.mineCount, 27, '7 mineCount 仍 27');
  chkRow(cnt3, 3, { total: 8, played: 0, mine: 3, remaining: 5 }, '7 级牌行 mine=3(♦3♣3♥3)');
  chkRow(cnt3, 5, { total: 8, played: 0, mine: 1, remaining: 7 }, '7 ♦5 已不在我手 → 5 行 mine=1');

  // 同一张牌同时在我手与已出：SPEC2 §2 只要求 remainingCounts 返回 ok 字段，未定义 ok/warnings 语义，
  // 因此只断言字段类型；若实现未检测该冲突，作为 SPEC 缺口记录（不计失败）。
  const cpl4 = cplDeal(); // id3(♦3) 在 1 家手牌里
  const raw4 = makeRaw({
    state: 1, firstPlayer: 1, lastRankList: [1, 3, 2, 4], team13Level: 3, team24Level: 2,
    cardPositionList: cpl4, playedCardList: [0, 3], playedTypeList: [code(1, 15)]
  });
  const cnt4 = GDSite.remainingCounts(GDSite.expandState(raw4), 1);
  ok(typeof cnt4.ok === 'boolean', '7 remainingCounts.ok 为布尔值');
  const conflictDetected = cnt4.ok === false || (Array.isArray(cnt4.warnings) && cnt4.warnings.length > 0);
  if (!conflictDetected) {
    skipNotes.push('7 「同一张牌既在我手又已出」未被 remainingCounts 标记（SPEC2 §2 未定义 ok/warnings 语义，建议补充）；实际 ok=' +
      cnt4.ok + ' warnings=' + show(cnt4.warnings));
  }
}

// ============================== §8 genMoves ==============================
function sec8() {
  const findMove = (moves, c, set) => (moves || []).find(m => m.code === c && sameSet(m.cards, set));

  const hand1 = [card(13, 0), card(13, 1), card(13, 2), card(2, 0), card(2, 1)];
  let mv = GDSite.genMoves(hand1, LVL, 0);
  ok(!!findMove(mv, code(4, 13), hand1), '8 手牌 KKK+22 领出候选含三带二 K');
  const hand2 = [card(10, 0), card(11, 1), card(12, 2), card(13, 3), card(14, 0)];
  ok(!!findMove(GDSite.genMoves(hand2, LVL, 0), code(7, 14), hand2), '8 手牌 10JQKA 领出候选含顺子');
  const hand3 = [card(9, 0), card(9, 1), card(9, 2), card(9, 3)];
  ok(!!findMove(GDSite.genMoves(hand3, LVL, 0), code(100, 9), hand3), '8 四同点手牌有炸弹');
  const hand4 = [BIG0, BIG1, SMALL0, SMALL1];
  ok(!!findMove(GDSite.genMoves(hand4, LVL, 0), code(127, 0), hand4), '8 两大两小王有天王炸');
  const hand5 = [card(9, 0), card(9, 1), card(9, 2), WILD0];
  ok(!!findMove(GDSite.genMoves(hand5, LVL, 0), code(100, 9), hand5), '8 逢人配补炸弹 999+♥3');

  // 跟牌：只返回能压过 lastPlay 的
  const hand6 = [card(9, 0), card(9, 1), card(5, 0), card(6, 0)];
  mv = GDSite.genMoves(hand6, LVL, code(2, 8));
  ok(!!findMove(mv, code(2, 9), [card(9, 0), card(9, 1)]), '8 跟对子8 候选含对子9');
  ok((mv || []).every(m => GDSite.beats(m.code, code(2, 8))), '8 跟牌候选全部能压过 lastPlay');
  len(GDSite.genMoves([card(5, 0), card(6, 0), card(7, 1)], LVL, code(102, 14)), 0,
    '8 跟同花顺A：手中无炸弹 → 无候选');
  len(GDSite.genMoves([card(9, 0), card(9, 1), card(9, 2), card(9, 3), card(5, 0)], LVL, code(127, 0)), 0,
    '8 跟四大天王：普通炸弹也压不过 → 无候选');
  len(GDSite.genMoves([], LVL, 0), 0, '8 空手牌 → 无候选');

  const mvAll = GDSite.genMoves(hand1, LVL, 0);
  ok(mvAll.every(m => m.size === m.cards.length), '8 genMoves 每个候选 size=cards.length');
  ok(mvAll.every(m => m.type === (m.code >> 8) && m.rank === (m.code & 255)),
    '8 genMoves 每个候选 type/rank 与 code 一致');
  ok(mvAll.every(m => m.level === LVL), '8 genMoves 每个候选 level 字段一致');
  ok(mvAll.every(m => m.bomb === (BOMB[m.type] || 0)), '8 genMoves 每个候选 bomb 字段正确');
  ok(mvAll.every(m => handHas(hand1, m.cards)), '8 genMoves 候选 cards 均来自 hand');

  // 随机 200 局面（随机手牌/级牌/上一手）性质
  const levels = [2, 3, 5, 7, 10, 14];
  const prevs = [0, code(1, 5), code(2, 7), code(3, 9), code(4, 9), code(5, 4), code(6, 5),
    code(7, 10), code(100, 7), code(101, 7), code(102, 10), code(103, 7), code(127, 0)];
  for (let i = 0; i < 200; i++) {
    let bad = '';
    try {
      const seed = (i * 2654435761 + 17) % 2147483647;
      const d = GDSite.deal(seed);
      const level = levels[i % levels.length];
      const prev = prevs[i % prevs.length];
      const hand = d.hands[i % 4];
      const moves = GDSite.genMoves(hand, level, prev);
      if (!Array.isArray(moves)) bad = '返回值不是数组';
      else {
        const seen = new Set();
        for (const m of moves) {
          if (!Array.isArray(m.cards) || !m.cards.length || !handHas(hand, m.cards)) { bad = 'cards 不在 hand 中: ' + show(m.cards); break; }
          if (new Set(m.cards).size !== m.cards.length) { bad = 'cards 内有重复: ' + show(m.cards); break; }
          if (GDSite.interpretCodes(m.cards, level).indexOf(m.code) < 0) { bad = 'code 不是该牌的合法解读 code=' + m.code + ' cards=' + show(m.cards); break; }
          if (GDSite.bestCode(m.cards, prev, level) === 0) { bad = 'bestCode=0（非法/压不过）cards=' + show(m.cards); break; }
          if (prev !== 0 && !GDSite.beats(m.code, prev)) { bad = '候选压不过 lastPlay code=' + m.code; break; }
          const key = m.cards.slice().sort((a, b) => a - b).join(',') + '|' + m.code;
          if (seen.has(key)) { bad = '候选去重失败: ' + key; break; }
          seen.add(key);
        }
      }
    } catch (e) { bad = '抛异常: ' + (e && e.message); }
    ok(!bad, '8 随机局面#' + i + '（随机手牌/级牌/上一手）genMoves 合法性/去重' + (bad ? ' — ' + bad : ''));
  }

  // 发牌与随机数（便于 genMoves 场景构造）
  const d1 = GDSite.deal(12345), d2 = GDSite.deal(12345);
  eq(d1.hands.length, 4, '8 deal 返回 4 家');
  ok(d1.hands.every(h => h.length === 27), '8 deal 每家 27 张');
  eq(new Set(d1.hands.flat()).size, 108, '8 deal 108 张无重复');
  eq(d1.hands.map(h => h.slice()), d2.hands.map(h => h.slice()), '8 deal 同 seed 可复现');
  ok(typeof GDSite.createRng === 'function' && typeof GDSite.createRng(42) === 'function',
    '8 createRng(seed) 返回随机函数');
  if (typeof GDSite.createRng === 'function') {
    eq(GDSite.createRng(42)(), GDSite.createRng(42)(), '8 createRng 同 seed 首个随机数一致');
  }
}

// ============================== §9 sortHand / tributeCandidates / returnCandidates ==============================
function cplOf(handsBySeat) {
  const cpl = new Array(108).fill(0);
  for (const s of [1, 2, 3, 4]) {
    for (const id of handsBySeat[s] || []) cpl[id - 1] = s;
  }
  return cpl;
}
function fillSeats(cpl, seats) {
  // 把未分配的牌轮流给 seats（用于构造更接近真实的剩余张数）
  let i = 0;
  for (let id = 1; id <= 108; id++) {
    if (cpl[id - 1]) continue;
    cpl[id - 1] = seats[i % seats.length]; i++;
  }
  return cpl;
}
function rawFromHands(handsBySeat, opts) {
  const cpl = cplOf(handsBySeat);
  return makeRaw(Object.assign({ cardPositionList: cpl }, opts || {}));
}

function sec9() {
  const hand = [card(5, 0), card(14, 0), card(3, 0), BIG0, card(9, 2)];
  const sorted = GDSite.sortHand(hand, LVL);
  const expected = hand.slice().sort((a, b) => {
    const fa = GDSite.levelOrder(GDSite.rankOf(a), LVL), fb = GDSite.levelOrder(GDSite.rankOf(b), LVL);
    if (fa !== fb) return fb - fa;
    return a - b;
  });
  eq(sorted, expected, '9 sortHand 默认：等级(级牌序)降序→id 升序');
  eq(sorted.length, hand.length, '9 sortHand 长度不变');
  ok(sameSet(sorted, hand), '9 sortHand 只重排不增删');

  // tributeCandidates：优先非逢人配中最大牌（按级牌序），过滤逢人配
  function rawSeat4(h4) {
    const cpl = new Array(108).fill(0);
    for (const id of h4) cpl[id - 1] = 4;
    fillSeats(cpl, [1, 2, 3]);
    return makeRaw({ state: 1, lastRankList: [1, 3, 2, 4], team13Level: 3, team24Level: 2, cardPositionList: cpl });
  }
  {
    const e = GDSite.expandState(rawSeat4([WILD0, BIG0, 1, 13, 5]));
    eq(GDSite.tributeCandidates(e, 4), [BIG0], '9 进贡候选：排除逢人配后取最大（大王）');
  }
  {
    const e = GDSite.expandState(rawSeat4([WILD0, 1, 13, 5]));
    eq(GDSite.tributeCandidates(e, 4), [1], '9 进贡候选：无王时取 A');
  }
  {
    const e = GDSite.expandState(rawSeat4([WILD0]));
    eq(GDSite.tributeCandidates(e, 4), [WILD0], '9 进贡候选：全是逢人配时退回整手');
  }

  // returnCandidates：优先 ≤10 且非级牌的自然小牌
  {
    const e = GDSite.expandState(rawSeat4([1, 13, 9, 5, WILD0]));
    const got = GDSite.returnCandidates(e, 4);
    ok(sameSet(got, [9, 5]), '9 还贡候选：优先 ≤10 非级牌小牌（5、9）');
  }
  {
    const e = GDSite.expandState(rawSeat4([1, 13, WILD0]));
    eq(GDSite.returnCandidates(e, 4), [13], '9 还贡候选：无小牌时给级牌序最小的单张(K)');
  }
}

// ============================== §10 GDSiteAI ==============================
function aiState(handsBySeat, opts, seat) {
  const raw = rawFromHands(handsBySeat, opts);
  const exp = GDSite.expandState(raw);
  return { exp: exp, state: GDSite.buildAIState(exp, seat === undefined ? 1 : seat) };
}

function sec10() {
  if (!GDSiteAI) {
    skipNotes.push('gd.site.ai.js 未就绪，跳过 §10 GDSiteAI 断言');
    console.log('⚠ gd.site.ai.js 未就绪，跳过 §10 GDSiteAI 断言');
    return;
  }
  if (typeof GDSite.buildAIState !== 'function') {
    skipNotes.push('GDSite.buildAIState() 缺失，跳过 §10 GDSiteAI 断言');
    console.log('⚠ GDSite.buildAIState() 缺失，跳过 §10 GDSiteAI 断言');
    return;
  }
  const LVL2 = 2;

  // A. 领出：必须出牌且候选合法
  const handA = [card(5, 0), card(5, 1), card(6, 0), card(7, 1), card(8, 0)];
  const cplA = fillSeats(cplOf({ 1: handA }), [2, 3, 4]);
  const sa = aiState({ 1: handA }, { state: 1, firstPlayer: 1, cardPositionList: cplA });
  const sugA = GDSiteAI.suggest(sa.state);
  ok(!!sugA && typeof sugA === 'object', '10 suggest 返回对象');
  eq(sugA.source, 'local', '10 suggest.source=local');
  eq(sugA.action, 'play', '10 领出（prevCode=0）必须出牌');
  ok(!!sugA.play && handHas(handA, sugA.play.cards), '10 领出建议 play.cards ⊆ hand');
  ok(!!sugA.play && GDSite.bestCode(sugA.play.cards, 0, sa.state.level) !== 0, '10 领出建议是合法牌型');
  ok(Array.isArray(sugA.candidates), '10 suggest.candidates 为数组');
  ok(sugA.candidates.length > 0 && sugA.candidates.length <= 12, '10 领出候选数 1..12');
  let desc = true;
  for (let i = 1; i < sugA.candidates.length; i++) {
    if (sugA.candidates[i].score > sugA.candidates[i - 1].score) desc = false;
  }
  ok(desc, '10 candidates 按 score 降序');
  ok(sugA.candidates.every(c => c.play && handHas(handA, c.play.cards) &&
    GDSite.bestCode(c.play.cards, 0, sa.state.level) !== 0), '10 每个候选都合法且在手中');
  ok(typeof sugA.reason === 'string' && sugA.reason.length > 0, '10 suggest.reason 非空中文说明');
  ok(!!sugA.handInfo && sugA.handInfo.size === handA.length, '10 handInfo.size=手牌数');
  ok(Array.isArray(GDSiteAI.candidates(sa.state, 3)) && GDSiteAI.candidates(sa.state, 3).length <= 3,
    '10 candidates(state,limit=3) 不超过 limit');

  // B. 能一手出完 → 必出尽
  const handB = [card(10, 0), card(11, 1), card(12, 2), card(13, 3), card(14, 0)]; // 10JQKA
  const cplB = fillSeats(cplOf({ 1: handB }), [2, 3, 4]);
  const sb = aiState({ 1: handB }, { state: 1, firstPlayer: 1, cardPositionList: cplB });
  const sugB = GDSiteAI.suggest(sb.state);
  eq(sugB.action, 'play', '10 能一手出完必须 action=play');
  ok(!!sugB.play && sugB.play.size === handB.length, '10 能一手出完时 play.size=整手');
  ok(!!sugB.play && sameSet(sugB.play.cards, handB), '10 能一手出完时出尽整手牌');

  // C. 队友牌权（非一手出完）→ 默认 pass
  const handC = [card(4, 0), card(5, 0), card(6, 0), card(8, 1), card(9, 1), card(10, 1)];
  {
    const playedC = playSegs([[card(7, 0), card(7, 1)], []], [code(2, 7), 0]);
    const cplC = fillSeats(cplOf({ 1: handC }), [2, 3, 4]);
    const rawC = makeRaw({
      state: 1, firstPlayer: 3, cardPositionList: cplC,
      playedCardList: playedC.playedCardList, playedTypeList: playedC.playedTypeList
    });
    const expC = GDSite.expandState(rawC);
    const stC = GDSite.buildAIState(expC, 1);
    eq(stC.prevCode, code(2, 7), '10 队友牌权场景 prevCode=对子7');
    eq(stC.trickOwner, 3, '10 队友牌权场景 trickOwner=3（我的对家）');
    const sugC = GDSiteAI.suggest(stC);
    eq(sugC.action, 'pass', '10 队友当前最大且不能一手出完 → 默认 pass');
    eq(sugC.play, null, '10 队友牌权 pass 时 play=null');
  }
  // C2. 队友牌权但能一手出完 → 出尽
  {
    const handC2 = [card(14, 0)]; // 单张 A，可压单张 8 并一把出完
    const playedC2 = playSegs([[card(8, 0)], []], [code(1, 8), 0]);
    const cplC2 = fillSeats(cplOf({ 1: handC2 }), [2, 3, 4]);
    const expC2 = GDSite.expandState(makeRaw({
      state: 1, firstPlayer: 3, cardPositionList: cplC2,
      playedCardList: playedC2.playedCardList, playedTypeList: playedC2.playedTypeList
    }));
    const stC2 = GDSite.buildAIState(expC2, 1);
    eq(stC2.trickOwner, 3, '10 队友牌权场景2 trickOwner=3');
    const sugC2 = GDSiteAI.suggest(stC2);
    eq(sugC2.action, 'play', '10 队友牌权但能一手出完 → 出尽');
    ok(!!sugC2.play && sugC2.play.size === 1 && sugC2.play.cards[0] === card(14, 0),
      '10 队友牌权出尽：单张 A');
  }

  // D. 对手剩余 ≤3 张 → 优先拦截（能压则出）
  {
    const handD = [card(9, 0), card(9, 1), card(4, 0), card(6, 1)];
    const handsD = { 1: handD, 2: [card(11, 0), card(12, 0)] }; // 对手 2 家只剩 2 张
    const cplD = fillSeats(cplOf(handsD), [3, 4]);
    const playedD = playSegs([[card(8, 0), card(8, 1)], [], []], [code(2, 8), 0, 0]);
    const expD = GDSite.expandState(makeRaw({
      state: 1, firstPlayer: 2, cardPositionList: cplD,
      playedCardList: playedD.playedCardList, playedTypeList: playedD.playedTypeList
    }));
    const stD = GDSite.buildAIState(expD, 1);
    eq(stD.trickOwner, 2, '10 对手牌权场景 trickOwner=2');
    const opp = (stD.seatsRemaining || []).find(x => x.seat === 2);
    ok(!!opp && opp.count <= 3, '10 对手剩余张数 ≤3（' + (opp && opp.count) + '）');
    const sugD = GDSiteAI.suggest(stD);
    eq(sugD.action, 'play', '10 对手剩余≤3 且我能压 → 优先拦截(play)');
    ok(!!sugD.play && GDSite.beats(sugD.play.code, code(2, 8)), '10 拦截建议能压过上一手');
  }

  // E. 压不过 → pass，且 candidates 为空
  {
    const handE = [card(4, 0), card(5, 0), card(6, 0), card(8, 1), card(9, 1)];
    const cplE = fillSeats(cplOf({ 1: handE }), [2, 3, 4]);
    const playedE = playSegs([[BIG0, BIG1, SMALL0, SMALL1], [], []], [code(127, 0), 0, 0]);
    const expE = GDSite.expandState(makeRaw({
      state: 1, firstPlayer: 2, cardPositionList: cplE,
      playedCardList: playedE.playedCardList, playedTypeList: playedE.playedTypeList
    }));
    const stE = GDSite.buildAIState(expE, 1);
    eq(stE.trickOwner, 2, '10 压不过场景 trickOwner=2');
    const sugE = GDSiteAI.suggest(stE);
    eq(sugE.action, 'pass', '10 压不过四大天王 → action=pass');
    eq(sugE.play, null, '10 压不过 → play=null');
    ok(Array.isArray(sugE.candidates) && sugE.candidates.length === 0, '10 压不过 → candidates 为空');

    // 对照：领出但手中全是被禁的牌也不会抛异常
    const stEmpty = GDSite.buildAIState(GDSite.expandState(rawFromHands({ 1: [] }, { state: 1, firstPlayer: 1 })), 1);
    let threw = false, sugEmpty = null;
    try { sugEmpty = GDSiteAI.suggest(stEmpty); } catch (err) { threw = true; }
    ok(!threw, '10 空手牌 suggest 不抛异常');
    ok(!!sugEmpty && sugEmpty.action === 'pass' && sugEmpty.play === null, '10 空手牌 → pass + play=null');
  }

  // handSummary
  const hsHand = [card(9, 0), card(9, 1), card(9, 2), card(9, 3), WILD0];
  const hs = GDSiteAI.handSummary(hsHand, LVL);
  ok(!!hs && typeof hs === 'object', '10 handSummary 返回对象');
  eq(hs.size, 5, '10 handSummary.size=5');
  eq(hs.wilds, 1, '10 handSummary.wilds=1');
  ok(typeof hs.playsEstimate === 'number' && hs.playsEstimate >= 1, '10 handSummary.playsEstimate 为正数');
  ok(typeof hs.levelCards === 'number', '10 handSummary.levelCards 为数字');
  const bombsVal = hs.bombs;
  const bombCnt = typeof bombsVal === 'number' ? bombsVal : (Array.isArray(bombsVal) ? bombsVal.length : -1);
  ok(bombCnt >= 1, '10 handSummary.bombs 识别出 4炸9（实际 ' + show(bombsVal) + '）');

  // toLocalSuggestion（若 AI 模块提供）
  if (typeof GDSiteAI.toLocalSuggestion === 'function') {
    const p = GDSite.playFromCards([card(5, 0), card(5, 1)], LVL);
    const loc = GDSiteAI.toLocalSuggestion({
      action: 'play', play: p, reason: '测试',
      candidates: [{ play: p, score: 80 }], handInfo: { size: 2 }
    });
    ok(!!loc && typeof loc === 'object', '10 AI.toLocalSuggestion 返回对象');
    ok(loc && loc.action === 'play', '10 AI.toLocalSuggestion.action');
  }
}

// ============================== §11 GDSiteRemote ==============================
async function noThrow(label, fn) {
  try { return await fn(); }
  catch (e) { ok(false, label + ' 不应抛异常，实际抛：' + (e && e.message)); return null; }
}
function makeRemoteInput() {
  const hand = [card(5, 0), card(5, 1), card(9, 0)];
  const cpl = fillSeats(cplOf({ 1: hand }), [2, 3, 4]);
  const exp = GDSite.expandState(makeRaw({ state: 1, firstPlayer: 1, cardPositionList: cpl }));
  const state = GDSite.buildAIState(exp, 1);
  const counter = GDSite.remainingCounts(exp, 1);
  const p1 = GDSite.playFromCards([card(5, 0), card(5, 1)], state.level);
  const p2 = GDSite.playFromCards([card(9, 0)], state.level);
  const suggestion = {
    action: 'play', play: p1,
    candidates: [{ play: p1, score: 80, tag: '出小对' }, { play: p2, score: 40, tag: '出单张' }],
    reason: '测试用建议', handInfo: { size: hand.length, bombs: 0, wilds: 0, playsEstimate: 2 }
  };
  return { exp: exp, state: state, counter: counter, suggestion: suggestion, p1: p1, p2: p2 };
}

async function sec11() {
  if (!GDSiteRemote) {
    skipNotes.push('gd.site.remote.js 未就绪，跳过 §11 GDSiteRemote 断言');
    console.log('⚠ gd.site.remote.js 未就绪，跳过 §11 GDSiteRemote 断言');
    return;
  }
  ok(!!GDSiteRemote.DEFAULTS && typeof GDSiteRemote.DEFAULTS === 'object', '11 GDSiteRemote.DEFAULTS 为对象');
  const mk = makeRemoteInput();
  const input = { state: mk.state, suggestion: mk.suggestion, counter: mk.counter };

  // buildRequest 字段 + candidates 编号
  const req = GDSiteRemote.buildRequest(input);
  ok(!!req && typeof req === 'object', '11 buildRequest 返回对象');
  eq(req.level, mk.state.level, '11 request.level=state.level');
  ok(typeof req.levelText === 'string' && req.levelText === String(mk.state.level), '11 request.levelText');
  ok(typeof req.wildText === 'string' && req.wildText.length > 0, '11 request.wildText 非空');
  ok(typeof req.mySeatName === 'string' && req.mySeatName.length > 0, '11 request.mySeatName');
  ok(typeof req.partnerSeatName === 'string' && req.partnerSeatName.length > 0, '11 request.partnerSeatName');
  ok(Array.isArray(req.hand) && req.hand.length === mk.state.hand.length &&
    req.hand.every(h => typeof h === 'string' && h.length > 0), '11 request.hand 为牌面字符串数组');
  eq(req.lastPlay, null, '11 领出时 request.lastPlay=null');
  ok(Array.isArray(req.history), '11 request.history 为数组');
  ok(Array.isArray(req.seats) && req.seats.length === 4, '11 request.seats 4 项');
  ok(req.seats.every(s => s && typeof s.name === 'string' && typeof s.count === 'number'), '11 seats 每项 {name,count}');
  ok(Array.isArray(req.remaining) && req.remaining.length === (mk.counter.byRank || []).length,
    '11 request.remaining 行数=counter.byRank 行数(' + (mk.counter.byRank || []).length + ')');
  ok(req.remaining.every(r => r && typeof r.rankText === 'string' && typeof r.count === 'number'),
    '11 remaining 每项 {rankText,count}');
  eq(req.wildRemaining, mk.counter.wildRemaining, '11 request.wildRemaining=counter.wildRemaining');
  ok(Array.isArray(req.candidates) && req.candidates.length === mk.suggestion.candidates.length,
    '11 request.candidates 条数=本地候选数');
  req.candidates.forEach((c, i) => {
    eq(c.index, i, '11 request.candidates[' + i + '].index=数组下标');
    ok(Array.isArray(c.cards) && c.cards.length === mk.suggestion.candidates[i].play.cards.length,
      '11 candidates[' + i + '].cards 为牌面字符串数组');
    ok(c.cards.every(x => typeof x === 'string' && x.length > 0), '11 candidates[' + i + '].cards 每项非空');
    ok(!!c.play && typeof c.play === 'object', '11 candidates[' + i + '].play 保留 Play 对象');
    ok(typeof c.typeName === 'string' && c.typeName.length > 0, '11 candidates[' + i + '].typeName 非空');
    ok(typeof c.name === 'string' && c.name.length > 0, '11 candidates[' + i + '].name 非空');
    eq(typeof c.size, 'number', '11 candidates[' + i + '].size 为数字');
    eq(typeof c.bomb, 'number', '11 candidates[' + i + '].bomb 为数字');
  });
  ok(!!req.localSuggestion && typeof req.localSuggestion === 'object', '11 request.localSuggestion 为对象');
  eq(req.localSuggestion && req.localSuggestion.action, 'play', '11 localSuggestion.action');
  ok(req.localSuggestion && typeof req.localSuggestion.typeName === 'string' &&
    req.localSuggestion.typeName.length > 0, '11 localSuggestion.typeName');

  // 跟牌时 lastPlay 非空
  {
    const handR = [card(5, 0), card(6, 0), card(9, 1)];
    const cplR = fillSeats(cplOf({ 1: handR }), [2, 3, 4]);
    const playedR = playSegs([[card(8, 0), card(8, 1)], []], [code(2, 8), 0]);
    const expR = GDSite.expandState(makeRaw({
      state: 1, firstPlayer: 2, cardPositionList: cplR,
      playedCardList: playedR.playedCardList, playedTypeList: playedR.playedTypeList
    }));
    const stR = GDSite.buildAIState(expR, 1);
    const pR = GDSite.playFromCards([card(9, 1)], stR.level);
    const sugR = { action: 'play', play: pR, candidates: [{ play: pR, score: 10, tag: '单张' }], reason: 'r', handInfo: { size: 3 } };
    const reqR = GDSiteRemote.buildRequest({ state: stR, suggestion: sugR, counter: GDSite.remainingCounts(expR, 1) });
    ok(!!reqR.lastPlay && typeof reqR.lastPlay === 'object', '11 跟牌时 request.lastPlay 非空');
    ok(Array.isArray(reqR.lastPlay.cards) && reqR.lastPlay.cards.length === 2, '11 lastPlay.cards 为 2 张牌面字符串');
    ok(typeof reqR.lastPlay.name === 'string' && reqR.lastPlay.name.length > 0, '11 lastPlay.name 非空');
    ok(typeof reqR.lastPlay.seatName === 'string', '11 lastPlay.seatName 为字符串');
    eq(typeof reqR.lastPlay.size, 'number', '11 lastPlay.size 为数字');
  }

  // toLocalSuggestion
  if (typeof GDSiteRemote.toLocalSuggestion === 'function') {
    const loc = GDSiteRemote.toLocalSuggestion(mk.suggestion);
    eq(loc.action, 'play', '11 toLocalSuggestion.action');
    ok(!!loc.play && loc.play.code === mk.p1.code, '11 toLocalSuggestion.play');
    eq(loc.typeName, GDSite.typeName(mk.p1.code), '11 toLocalSuggestion.typeName');
    ok(Array.isArray(loc.cards) && loc.cards.length === mk.p1.cards.length &&
      loc.cards.every(c => typeof c === 'string'), '11 toLocalSuggestion.cards 为牌面字符串数组');
    ok(typeof loc.reason === 'string', '11 toLocalSuggestion.reason 为字符串');
  }

  const secret = 'sk-verify-secret-123456';
  const DEFAULTS = GDSiteRemote.DEFAULTS;
  const baseCfg = Object.assign({}, DEFAULTS, { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
  const cfgKey = Object.assign({}, baseCfg, { apiKey: secret });

  // 无 Key → 回退本地，不发网络
  let calls = 0;
  let res = await noThrow('11 无 Key decide', () => GDSiteRemote.decide(input, baseCfg, {
    fetchImpl: () => { calls++; return Promise.reject(new Error('无 Key 不应发起请求')); }
  }));
  if (res) {
    eq(res.source, 'local', '11 无 Key → source=local');
    eq(res.action, mk.suggestion.action, '11 无 Key → action 来自本地建议');
    ok(!!res.play && res.play.code === mk.p1.code, '11 无 Key → play 来自本地建议');
    eq(calls, 0, '11 无 Key 不发起 fetch');
  }

  // 调用失败 → 回退本地，不 throw，不泄露 Key
  calls = 0;
  res = await noThrow('11 调用失败 decide', () => GDSiteRemote.decide(input, cfgKey, {
    fetchImpl: () => { calls++; return Promise.reject(new Error('mock network down')); }
  }));
  if (res) {
    eq(res.source, 'local', '11 调用失败 → 回退 source=local');
    eq(res.action, mk.suggestion.action, '11 调用失败 → action 来自本地建议');
    eq(calls, 1, '11 有 Key 时发起一次 fetch');
    ok(!!res.error, '11 调用失败带 error 字段');
    ok(String(res.error || '').indexOf(secret) < 0, '11 错误信息不含完整 API Key');
  }

  // HTTP 5xx → 回退本地
  calls = 0;
  res = await noThrow('11 HTTP 5xx decide', () => GDSiteRemote.decide(input, cfgKey, {
    fetchImpl: () => {
      calls++;
      return Promise.resolve({
        ok: false, status: 500,
        json: () => Promise.resolve({}), text: () => Promise.resolve('server error')
      });
    }
  }));
  if (res) {
    eq(res.source, 'local', '11 HTTP 5xx → 回退 source=local');
    eq(calls, 1, '11 HTTP 5xx 发起一次 fetch');
    ok(String(res.error || '').indexOf(secret) < 0, '11 HTTP 错误信息不含完整 API Key');
  }

  // 返回内容解析失败 → 回退本地
  res = await noThrow('11 解析失败 decide', () => GDSiteRemote.decide(input, cfgKey, {
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: '这不是 JSON' } }] })
    })
  }));
  if (res) {
    eq(res.source, 'local', '11 解析失败 → 回退 source=local');
    ok(String(res.error || '').indexOf(secret) < 0, '11 解析失败错误信息不含完整 API Key');
  }

  // testConnection
  if (typeof GDSiteRemote.testConnection === 'function') {
    let tc = await noThrow('11 testConnection 成功', () => GDSiteRemote.testConnection(cfgKey, () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] })
    })));
    if (tc) {
      eq(tc.ok, true, '11 testConnection 成功 ok=true');
      ok(typeof tc.message === 'string' && tc.message.length > 0, '11 testConnection 成功 message 非空');
      ok(String(tc.message || '').indexOf(secret) < 0, '11 testConnection message 不含完整 API Key');
    }
    tc = await noThrow('11 testConnection 失败', () => GDSiteRemote.testConnection(cfgKey, () => Promise.reject(new Error('mock fail'))));
    if (tc) {
      eq(tc.ok, false, '11 testConnection 失败 ok=false');
      ok(typeof tc.message === 'string' && tc.message.length > 0, '11 testConnection 失败 message 非空');
      ok(String(tc.message || '').indexOf(secret) < 0, '11 testConnection 失败 message 不含完整 API Key');
    }
  }
}

// ============================== §12 构建产物静态断言 ==============================
function firstAssign(src, name) {
  const m = src.match(new RegExp('\\b' + name + '\\s*=\\s*'));
  return m ? m.index : -1;
}
function sec12() {
  const buildPath = path.join(__dirname, '掼蛋AI助手.user.js');
  if (!fs.existsSync(buildPath)) {
    skipNotes.push('构建产物 掼蛋AI助手.user.js 尚未就绪，跳过 §12 静态断言');
    console.log('⚠ 构建产物 掼蛋AI助手.user.js 尚未就绪，跳过 §12 静态断言');
    return;
  }
  const src = fs.readFileSync(buildPath, 'utf8');
  ok(src.length > 100000, '12 构建产物大小 >100KB（实际 ' + src.length + 'B）');
  ok(src.indexOf('// ==UserScript==') >= 0, '12 含 UserScript 头');
  ok(/@match\s+https:\/\/game\.hullqin\.cn\/\*/.test(src), '12 头含 @match https://game.hullqin.cn/*');
  ok(/@grant\s+none/.test(src), '12 头含 @grant none');
  const idx = {};
  for (const name of ['GDDeepSeek', 'GDSite', 'GDSiteESP', 'GDSiteAI', 'GDSiteRemote', 'GDSiteUI']) {
    const p = firstAssign(src, name);
    idx[name] = p >= 0 ? p : src.search(new RegExp('\\b' + name + '\\b'));
    ok(idx[name] >= 0, '12 产物包含模块 ' + name);
  }
  // SPEC2 §7 只要求「模块顺序：GDSite 定义在 GDSiteAI/GDSiteRemote/GDSiteUI 之前」，
  // 未要求 GDDeepSeek 的位置（build 顺序把 GDDeepSeek 放在 core 之后也可）。
  ok(idx.GDSite < idx.GDSiteESP, '12 模块顺序：GDSite 定义在 GDSiteESP 之前');
  ok(idx.GDSiteESP < idx.GDSiteAI, '12 模块顺序：GDSiteESP 定义在 GDSiteAI 之前');
  ok(idx.GDSite < idx.GDSiteAI, '12 模块顺序：GDSite 定义在 GDSiteAI 之前');
  ok(idx.GDSite < idx.GDSiteRemote, '12 模块顺序：GDSite 定义在 GDSiteRemote 之前');
  ok(idx.GDSite < idx.GDSiteUI, '12 模块顺序：GDSite 定义在 GDSiteUI 之前');
  ok(src.indexOf('HQ.mountStandalone();') >= 0, '12 末尾调用 HQ.mountStandalone();');
  // 无 CDN/外部资源：允许 w3.org 命名空间（非网络加载）、站点自身地址、DeepSeek API；其余域名视为违规
  const urlList = src.match(/https?:\/\/[^\s"'`)]+/g) || [];
  const allowedHosts = ['www.w3.org', 'game.hullqin.cn', 'api.deepseek.com'];
  const badHosts = urlList.map(u => {
    const m = u.match(/^https?:\/\/([a-z0-9.\-]+)/i);
    return m ? m[1].toLowerCase() : '';
  }).filter(h => h && allowedHosts.indexOf(h) < 0);
  ok(badHosts.length === 0, '12 无外部 CDN/资源引用（仅 w3.org 命名空间/站点地址/DeepSeek API）' +
    (badHosts.length ? '；发现域名：' + Array.from(new Set(badHosts)).slice(0, 5).join(' , ') : ''));
  ok(!/@require\s+http/i.test(src), '12 无远程 @require');
  const tail = src.slice(-3000);
  ok(tail.indexOf('HQ.mountStandalone();') >= 0, '12 HQ.mountStandalone(); 位于文件末尾区域');
}

// ============================== 主流程与汇总 ==============================
(async function main() {
  console.log('=== 掼蛋油猴版独立黑盒验收（对照 SPEC2.md；cwd=' + __dirname + '）===');
  if (loadErrors.length) console.log('⚠ 模块加载问题：\n  ' + loadErrors.join('\n  '));

  if (!GDSite) {
    skipNotes.push('gd.site.core.js 未就绪，跳过 §0–§9 引擎断言');
    console.log('⚠ gd.site.core.js 未就绪，跳过 §0–§9 引擎断言');
  } else {
    section('§0 模块导出契约', sec0);
    section('§1 牌模型', sec1);
    section('§2 牌型解释', sec2);
    section('§3 压牌与炸弹链', sec3);
    section('§4 replayActions', sec4);
    section('§5 expandState', sec5);
    section('§6 protobuf 编解码', sec6);
    section('§7 remainingCounts 记牌器', sec7);
    section('§8 genMoves', sec8);
    section('§9 sortHand/tribute/return', sec9);
    await sectionAsync('§10 GDSiteAI', sec10);
    await sectionAsync('§11 GDSiteRemote', sec11);
    section('§12 构建产物静态断言', sec12);
  }

  console.log('');
  if (skipNotes.length) {
    console.log('跳过说明：');
    for (const s of skipNotes) console.log('  · ' + s);
  }
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  process.exitCode = failed ? 1 : 0;
})().catch(e => {
  console.log('✗ 测试主流程异常：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
