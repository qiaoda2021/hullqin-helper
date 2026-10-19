/* gd.verify.test.js — 掼蛋引擎/AI 独立黑盒验收测试（verifier）
 *
 * 期望值完全依据 SPEC.md 第 1/2/3/4/5 节与掼蛋规则自行推导，未参考任何实现源码。
 * 覆盖：牌 id 映射 / levelOrder / normalCounts / parseCards·parseAll·parseAs /
 *       canBeat·comparePlays / genMoves / counter / deal·createRng / GDAI 安全性质。
 *
 * 运行：node gd.verify.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let GDEngine = null;
let GDAI = null;
const loadErrors = [];
try { GDEngine = require('./gd.core.js'); } catch (e) { loadErrors.push('gd.core.js: ' + e.message); }
try { GDAI = require('./gd.ai.js'); } catch (e) { loadErrors.push('gd.ai.js: ' + e.message); }

let passed = 0;
let failed = 0;
let printed = 0;
let hidden = 0;
const PRINT_LIMIT = 150;

function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failed++;
  if (printed < PRINT_LIMIT) { printed++; console.log('✗ ' + msg); }
  else { hidden++; }
  return false;
}
function fmt(v) {
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
}
function eq(actual, expected, msg) {
  return ok(actual === expected, msg + ' —— 期望 ' + fmt(expected) + '，实际 ' + fmt(actual));
}
function deepEq(actual, expected, msg) {
  let a, b;
  try { a = JSON.stringify(actual); b = JSON.stringify(expected); } catch (e) { a = String(actual); b = String(expected); }
  return ok(a === b, msg + ' —— 期望 ' + b + '，实际 ' + a);
}
function section(title) { console.log('\n== ' + title + ' =='); }

/* ---------------- 通用工具（id 映射由 SPEC §1 自行推导） ---------------- */

function idFor(suit, rank, deck) {
  deck = deck || 0;
  if (rank === 16) return deck * 54 + 53;
  if (rank === 17) return deck * 54 + 54;
  const idx = rank === 14 ? 0 : rank - 1;
  return deck * 54 + suit * 13 + idx + 1;
}
function sortedNum(arr) { return (arr || []).slice().sort(function (a, b) { return a - b; }); }
function playsText(plays) {
  if (!plays || plays.length === 0) return '（空）';
  return plays.map(function (p) { return p ? p.type + '#' + p.rank + '/' + p.size : String(p); }).join(', ');
}
function findPlay(plays, type, rank, size) {
  return (plays || []).filter(function (p) {
    return p && p.type === type &&
      (rank === undefined || p.rank === rank) &&
      (size === undefined || p.size === size);
  })[0] || null;
}
function wantPlay(plays, type, rank, size, label) {
  const p = findPlay(plays, type, rank, size);
  ok(!!p, label + '：应包含 ' + type +
    (rank === undefined ? '' : ' rank=' + rank) +
    (size === undefined ? '' : ' size=' + size) +
    ' 的解读；实际解读：' + playsText(plays));
  return p;
}
function handContains(hand, cards) {
  const cnt = new Map();
  (hand || []).forEach(function (id) { cnt.set(id, (cnt.get(id) || 0) + 1); });
  let all = true;
  (cards || []).forEach(function (id) {
    const n = cnt.get(id) || 0;
    if (n <= 0) { all = false; return; }
    cnt.set(id, n - 1);
  });
  return all;
}
function wildCount(ids, level) {
  return (ids || []).filter(function (id) { return GDEngine.isWild(id, level); }).length;
}
function moveKey(p) {
  if (!p) return 'null';
  if (p.type === 'jokerbomb') return 'jokerbomb|' + p.size;
  return p.type + '|' + p.rank + '|' + p.size;
}
function reproduce(p, level) {
  if (!p || !Array.isArray(p.cards)) return null;
  try {
    if (p.type === 'jokerbomb') return GDEngine.parseAs(p.cards, level, p.type);
    return GDEngine.parseAs(p.cards, level, p.type, p.rank);
  } catch (e) { return null; }
}

/* 校验一个 Play 对象的通用形状（SPEC §3） */
function checkPlay(p, level, cards, label) {
  if (!ok(!!p && typeof p === 'object', label + '：应返回 Play 对象，实际 ' + fmt(p))) return false;
  const def = GDEngine.TYPES[p.type];
  ok(!!def, label + '：type 应合法（实际 ' + fmt(p.type) + '）');
  if (def) eq(p.name, def.name, label + '：name 应为「' + def.name + '」');
  ok(Array.isArray(p.cards), label + '：cards 应为数组');
  deepEq(sortedNum(p.cards), sortedNum(cards), label + '：cards 应为输入牌本身');
  eq(p.size, (cards || []).length, label + '：size 应等于张数');
  eq(p.level, level, label + '：level 字段应为解析时的级牌');
  ok(Array.isArray(p.wilds), label + '：wilds 应为数组');
  ok(typeof p.desc === 'string' && p.desc.length > 0, label + '：desc 应为非空字符串');
  ok(typeof p.bomb === 'number', label + '：bomb 应为数字');
  ok(typeof p.order === 'number', label + '：order 应为数字');
  if (p.type === 'jokerbomb') {
    eq(p.bomb, 99, label + '：四大天王 bomb 应为 99');
    eq(p.order, 0, label + '：四大天王 order 应为 0（SPEC §2）');
  } else {
    eq(p.order, GDEngine.levelOrder(p.rank, level), label + '：order 应等于 levelOrder(rank, level)');
  }
  return true;
}

/* parseAs 构造测试用 Play */
function mk(cards, level, type, rank, label) {
  let p = null;
  try {
    p = (rank === undefined)
      ? GDEngine.parseAs(cards, level, type)
      : GDEngine.parseAs(cards, level, type, rank);
  } catch (e) {
    ok(false, '构造测试牌「' + label + '」时 parseAs 抛异常：' + e.message);
    return null;
  }
  ok(!!p, '构造测试牌「' + label + '」失败：parseAs(' + fmt(cards) + ', 级' + level + ', \'' + type + '\'' +
    (rank === undefined ? '' : ', ' + rank) + ') 应返回 Play，实际 ' + fmt(p));
  return p;
}

/* 断言 a 与 b 的压制关系：expected=true 表示 a 压过 b */
function beats(a, b, expected, label) {
  if (!a || !b) { ok(false, label + '：测试牌构造失败，无法比较'); return; }
  let cmp = null, cb = null;
  try { cmp = GDEngine.comparePlays(a, b); } catch (e) { ok(false, label + '：comparePlays 抛异常 ' + e.message); return; }
  try { cb = GDEngine.canBeat(b, a); } catch (e) { ok(false, label + '：canBeat 抛异常 ' + e.message); return; }
  const good = expected ? (cmp > 0 && cb === true) : (!(cmp > 0) && cb === false);
  ok(good, label + ' —— 期望「' + (expected ? '能' : '不能') + '压过」；实际 comparePlays=' + fmt(cmp) + '，canBeat=' + fmt(cb));
}

/* 校验 genMoves 返回集合（SPEC §4） */
function checkMoves(hand, level, lastPlay, opts, label) {
  let moves = null;
  try { moves = GDEngine.genMoves(hand, level, lastPlay || null, opts); } catch (e) {
    ok(false, label + '：genMoves 抛异常：' + e.message);
    return [];
  }
  if (!ok(Array.isArray(moves), label + '：genMoves 应返回数组，实际 ' + fmt(moves))) return [];
  const seen = new Set();
  moves.forEach(function (p, i) {
    const tag = label + '[' + i + '](' + moveKey(p) + ')';
    if (!p || !Array.isArray(p.cards)) { ok(false, tag + '：返回项不是合法 Play'); return; }
    handContains(hand, p.cards);
    ok(handContains(hand, p.cards), tag + '：cards 必须全部来自手牌（cards=' + fmt(p.cards) + '）');
    eq(p.size, p.cards.length, tag + '：size 应等于 cards.length');
    const def = GDEngine.TYPES[p.type];
    ok(!!def, tag + '：type 合法');
    if (def && p.type !== 'bomb') eq(p.size, def.size, tag + '：' + p.type + ' 张数应为 ' + def.size);
    if (p.type === 'bomb') ok(p.cards.length >= 4 && p.cards.length <= 10, tag + '：炸弹张数应为 4..10');
    deepEq(sortedNum(p.cards), p.cards.slice().sort(function (a, b) { return a - b; }), tag + '：cards 应为升序');
    const re = reproduce(p, level);
    ok(!!re && re.type === p.type && re.size === p.size &&
      (p.type === 'jokerbomb' || re.rank === p.rank),
      tag + '：必须能被 parseAs 按同 type/rank 复现，实际 ' + (re ? re.type + '#' + re.rank + '/' + re.size : 'null'));
    eq(p.level, level, tag + '：level 字段');
    if (def) eq(p.name, def.name, tag + '：name 字段');
    if (lastPlay) ok(GDEngine.canBeat(lastPlay, p) === true, tag + '：跟牌时必须能压过上一手');
    ok(GDEngine.canBeat(null, p) === true, tag + '：canBeat(null, play) 应为 true');
    const key = moveKey(p);
    ok(!seen.has(key), tag + '：同 (type, rank, size) 只应保留一个代表');
    seen.add(key);
  });
  return moves;
}

/* AI suggest 返回结构 + 合法性校验（SPEC §5） */
function safeSuggest(st, label) {
  try {
    const r = GDAI.suggest(st);
    if (!ok(!!r && typeof r === 'object', label + '：suggest 应返回对象，实际 ' + fmt(r))) return null;
    return r;
  } catch (e) {
    ok(false, label + '：suggest 不应抛异常，实际抛出：' + e.message);
    return null;
  }
}
function checkSuggested(r, st, label) {
  if (!r) return;
  ok(r.action === 'play' || r.action === 'pass', label + '：action 应为 play/pass，实际 ' + fmt(r.action));
  ok(Array.isArray(r.candidates), label + '：candidates 应为数组');
  ok(typeof r.reason === 'string' && r.reason.length > 0, label + '：reason 应为非空中文说明');
  if (r.handInfo && typeof r.handInfo === 'object') {
    eq(r.handInfo.count, st.hand.length, label + '：handInfo.count 应等于手牌数');
    eq(r.handInfo.wilds, wildCount(st.hand, st.level), label + '：handInfo.wilds 应等于手牌中红桃级牌数');
    ok(typeof r.handInfo.playsEstimate === 'number' && r.handInfo.playsEstimate > 0, label + '：handInfo.playsEstimate 应为正数');
  } else {
    ok(false, label + '：应返回 handInfo');
  }
  if (r.action === 'pass') {
    eq(r.play, null, label + '：action=pass 时 play 应为 null');
  } else if (r.action === 'play') {
    const p = r.play;
    if (ok(!!p && typeof p === 'object', label + '：action=play 时应给出 play')) {
      ok(handContains(st.hand, p.cards), label + '：play.cards 必须都在手牌中');
      eq(p.size, p.cards.length, label + '：play.size 应等于张数');
      ok(!!reproduce(p, st.level), label + '：play 必须合法（parseAs 可复现 ' + p.type + '#' + p.rank + '）');
      if (st.lastPlay) ok(GDEngine.canBeat(st.lastPlay, p) === true, label + '：play 必须能压过上一手');
    }
  }
  if (Array.isArray(r.candidates)) {
    ok(r.candidates.length <= 12, label + '：candidates 默认应最多 12 个（实际 ' + r.candidates.length + '）');
    let prev = Infinity;
    r.candidates.forEach(function (cd, i) {
      const p = cd && cd.play;
      ok(!!p && typeof cd.score === 'number', label + '：candidates[' + i + '] 应为 {play, score}');
      if (!p) return;
      ok(handContains(st.hand, p.cards), label + '：candidates[' + i + '] 出牌必须在手牌中');
      ok(!!reproduce(p, st.level), label + '：candidates[' + i + '] 必须合法');
      if (st.lastPlay) ok(GDEngine.canBeat(st.lastPlay, p) === true, label + '：candidates[' + i + '] 必须能压过上一手');
      ok(cd.score <= prev + 1e-9, label + '：candidates 应按 score 降序');
      prev = cd.score;
    });
  }
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ================================ 主测试 ================================ */

function main() {
  const E = GDEngine;
  const AI = GDAI;
  const c = function (suit, rank, deck) { return idFor(suit, rank, deck); };
  const wild0 = idFor(1, 5, 0);   // ♥5（级牌 5 的逢人配）
  const wild1 = idFor(1, 5, 1);
  const sj0 = idFor(0, 16, 0), sj1 = idFor(0, 16, 1);  // 小王
  const bj0 = idFor(0, 17, 0), bj1 = idFor(0, 17, 1);  // 大王
  const allTwos = [];
  for (let deck = 0; deck < 2; deck++) for (let s = 0; s < 4; s++) allTwos.push(c(s, 2, deck));

  /* ---------------- 0. 模块导出契约 ---------------- */
  section('0. 模块导出契约');
  eq(E.VERSION, '1.0.0', 'GDEngine.VERSION 应为 1.0.0');
  deepEq(E.SUITS.map(function (s) { return s.key; }), ['S', 'H', 'C', 'D'], 'SUITS key 顺序应为 S/H/C/D');
  deepEq(E.SUITS.map(function (s) { return s.sym; }), ['♠', '♥', '♣', '♦'], 'SUITS 花色顺序应为 ♠♥♣♦');
  eq(E.JOKER_SMALL, 16, 'JOKER_SMALL 应为 16');
  eq(E.JOKER_BIG, 17, 'JOKER_BIG 应为 17');
  const typeSpec = {
    single: ['单张', 1], pair: ['对子', 2], triple: ['三同张', 3], fullhouse: ['三带二', 5],
    straight: ['顺子', 5], tube: ['三连对', 6], plate: ['钢板', 6], bomb: ['炸弹', 'n'],
    straightflush: ['同花顺', 5], jokerbomb: ['四大天王', 4]
  };
  Object.keys(typeSpec).forEach(function (t) {
    const def = E.TYPES && E.TYPES[t];
    ok(!!def, 'TYPES.' + t + ' 应存在');
    if (def) {
      eq(def.name, typeSpec[t][0], 'TYPES.' + t + '.name 应为「' + typeSpec[t][0] + '」');
      eq(def.size, typeSpec[t][1], 'TYPES.' + t + '.size');
    }
  });
  ok(typeof E.parseCards === 'function', 'parseCards 应为函数');
  ok(typeof E.parseAll === 'function', 'parseAll 应为函数');
  ok(typeof E.parseAs === 'function', 'parseAs 应为函数');
  ok(typeof E.canBeat === 'function', 'canBeat 应为函数');
  ok(typeof E.comparePlays === 'function', 'comparePlays 应为函数');
  ok(typeof E.genMoves === 'function', 'genMoves 应为函数');
  ok(typeof E.counter === 'function', 'counter 应为函数');
  ok(typeof E.deal === 'function', 'deal 应为函数');
  ok(typeof E.createRng === 'function', 'createRng 应为函数');
  if (AI) {
    ok(typeof AI.suggest === 'function', 'GDAI.suggest 应为函数');
    ok(typeof AI.candidates === 'function', 'GDAI.candidates 应为函数');
    ok(typeof AI.handSummary === 'function', 'GDAI.handSummary 应为函数');
  }

  /* ---------------- 1. 卡片模型 ---------------- */
  section('1. 卡片模型 / id 映射 / levelOrder / normalCounts / 排序');
  // cardDeck / cardLocal 对 1..108 全部符合公式
  let deckLocalOk = true;
  let deckLocalBad = '';
  for (let id = 1; id <= 108; id++) {
    const expDeck = Math.floor((id - 1) / 54);
    const expLocal = ((id - 1) % 54) + 1;
    if (E.cardDeck(id) !== expDeck || E.cardLocal(id) !== expLocal) {
      deckLocalOk = false;
      deckLocalBad = 'id=' + id + ' 期望 deck=' + expDeck + '/local=' + expLocal +
        ' 实际 ' + E.cardDeck(id) + '/' + E.cardLocal(id);
      break;
    }
  }
  ok(deckLocalOk, 'cardDeck/cardLocal 应对 1..108 全部符合 SPEC 公式' + (deckLocalBad ? '（' + deckLocalBad + '）' : ''));

  // cardRank 抽查
  [
    [1, 14], [2, 2], [13, 13], [14, 14], [15, 2], [26, 13], [27, 14], [39, 13],
    [40, 14], [52, 13], [53, 16], [54, 17], [55, 14], [68, 14], [107, 16], [108, 17]
  ].forEach(function (pair) { eq(E.cardRank(pair[0]), pair[1], 'cardRank(' + pair[0] + ')'); });

  // cardSuit 抽查：0=♠ 1=♥ 2=♣ 3=♦，王 -1
  [
    [1, 0], [2, 0], [13, 0], [14, 1], [26, 1], [27, 2], [39, 2],
    [40, 3], [52, 3], [53, -1], [54, -1], [55, 0], [68, 1], [108, -1]
  ].forEach(function (pair) { eq(E.cardSuit(pair[0]), pair[1], 'cardSuit(' + pair[0] + ')'); });

  // cardText 抽查
  [
    [1, '♠A'], [2, '♠2'], [10, '♠10'], [13, '♠K'], [14, '♥A'], [15, '♥2'],
    [18, '♥5'], [27, '♣A'], [40, '♦A'], [52, '♦K'], [53, '小王'], [54, '大王'],
    [68, '♥A'], [108, '大王']
  ].forEach(function (pair) { eq(E.cardText(pair[0]), pair[1], 'cardText(' + pair[0] + ')'); });
  deepEq(E.cardTexts([1, 53, 54]), ['♠A', '小王', '大王'], 'cardTexts 批量转换');
  deepEq(E.cardTexts([18, 72]), ['♥5', '♥5'], 'cardTexts 须保留重复张');

  // isJoker
  ok(E.isJoker(53) && E.isJoker(107) && E.isJoker(54) && E.isJoker(108), 'isJoker 应识别大小王');
  ok(!E.isJoker(52) && !E.isJoker(1), 'isJoker 对普通牌应为 false');

  // heartLevelIds：级牌 5 → [18,72]；级牌 A → [14,68]
  deepEq(E.heartLevelIds(5), [18, 72], 'heartLevelIds(5) 应为 [18,72]（♥5 两副）');
  deepEq(E.heartLevelIds(14), [14, 68], 'heartLevelIds(14) 应为 [14,68]（♥A 两副）');
  let heartOk = true, heartBad = '';
  for (let L = 2; L <= 14; L++) {
    const ids = E.heartLevelIds(L);
    if (!Array.isArray(ids) || ids.length !== 2 || E.cardRank(ids[0]) !== L || E.cardRank(ids[1]) !== L ||
      E.cardSuit(ids[0]) !== 1 || E.cardSuit(ids[1]) !== 1 ||
      E.cardDeck(ids[0]) !== 0 || E.cardDeck(ids[1]) !== 1) {
      heartOk = false; heartBad = '级牌 ' + L + ' → ' + fmt(ids);
      break;
    }
  }
  ok(heartOk, 'heartLevelIds(L) 对 L=2..14 应返回两张 ♥L（分属两副）' + (heartBad ? '（' + heartBad + '）' : ''));

  // isLevelCard / isWild
  let levelCardIds = [];
  for (let deck = 0; deck < 2; deck++) for (let s = 0; s < 4; s++) levelCardIds.push(c(s, 5, deck));
  ok(levelCardIds.every(function (id) { return E.isLevelCard(id, 5); }), '级牌 5 时 8 张 5 都应是级牌');
  ok(!E.isLevelCard(c(0, 6), 5) && !E.isLevelCard(sj0, 5), '非级牌 / 王不应算级牌');
  ok(E.isWild(18, 5) && E.isWild(72, 5), 'isWild：两张红桃 5 在级牌 5 时是逢人配');
  ok(!E.isWild(5, 5) && !E.isWild(31, 5) && !E.isWild(44, 5), 'isWild：非红桃级牌不是逢人配');
  ok(!E.isWild(15, 5), 'isWild：级牌 5 时 ♥2 不是逢人配');
  ok(E.isWild(14, 14) && E.isWild(68, 14), 'isWild：级牌 A 时两张 ♥A 是逢人配');
  ok(!E.isWild(1, 14), 'isWild：级牌 A 时 ♠A 不是逢人配');

  // levelOrder：大王17 > 小王16 > 级牌15 > A14 > K13 > ... > 2
  eq(E.levelOrder(17, 5), 17, 'levelOrder(大王, 级5)');
  eq(E.levelOrder(16, 5), 16, 'levelOrder(小王, 级5)');
  eq(E.levelOrder(5, 5), 15, 'levelOrder(级牌, 级5) 应为 15');
  eq(E.levelOrder(14, 5), 14, 'levelOrder(A, 级5)');
  eq(E.levelOrder(13, 5), 13, 'levelOrder(K, 级5)');
  eq(E.levelOrder(2, 5), 2, 'levelOrder(2, 级5)');
  eq(E.levelOrder(14, 14), 15, 'levelOrder(A, 级A) 应为 15');
  eq(E.levelOrder(13, 14), 13, 'levelOrder(K, 级A) 应为 13（级牌之外按自然点数）');
  eq(E.levelOrder(2, 14), 2, 'levelOrder(2, 级A)');
  eq(E.levelOrder(16, 14), 16, 'levelOrder(小王, 级A)');

  // normalCounts
  const nc = E.normalCounts();
  let ncSum = 0;
  for (let r = 2; r <= 14; r++) { eq(nc[r], 8, 'normalCounts[' + r + '] 应为 8'); ncSum += (nc[r] || 0); }
  eq(nc[16], 2, 'normalCounts[16] 应为 2');
  eq(nc[17], 2, 'normalCounts[17] 应为 2');
  ncSum += (nc[16] || 0) + (nc[17] || 0);
  eq(ncSum, 108, 'normalCounts 合计应为 108');

  // sortCards：自然点数升序，王在最后（小王、大王）
  deepEq(E.sortCards([54, 1, 15]), [15, 1, 54], 'sortCards：2 在 A 前，大王在最后');
  deepEq(E.sortCards([53, 54, 2, 1]), [2, 1, 53, 54], 'sortCards：普通牌在前，小王、大王在最后');
  deepEq(E.sortCards([108, 13, 2]), [2, 13, 108], 'sortCards：K 顺序');

  // rankText
  [[2, '2'], [10, '10'], [11, 'J'], [12, 'Q'], [13, 'K'], [14, 'A'], [16, '小王'], [17, '大王']]
    .forEach(function (pair) { eq(E.rankText(pair[0]), pair[1], 'rankText(' + pair[0] + ')'); });

  /* ---------------- 2. parseCards / parseAll / parseAs ---------------- */
  function parseCards(cards, level) {
    let r;
    try { r = E.parseCards(cards, level); } catch (e) {
      ok(false, 'parseCards(' + fmt(cards) + ', 级' + level + ') 抛异常：' + e.message);
      return [];
    }
    if (!ok(Array.isArray(r), 'parseCards(' + fmt(cards) + ', 级' + level + ') 应返回数组，实际 ' + fmt(r))) return [];
    return r;
  }
  function parseAll(cards, level) {
    let r;
    try { r = E.parseAll(cards, level); } catch (e) {
      ok(false, 'parseAll(' + fmt(cards) + ', 级' + level + ') 抛异常：' + e.message);
      return [];
    }
    if (!ok(Array.isArray(r), 'parseAll(' + fmt(cards) + ', 级' + level + ') 应返回数组，实际 ' + fmt(r))) return [];
    return r;
  }

  section('2a. 单张 / 对子 / 三同张');
  {
    const ps = parseCards([1], 2);
    const p = wantPlay(ps, 'single', 14, 1, '单张 ♠A');
    if (p) { checkPlay(p, 2, [1], '单张 ♠A'); eq(p.order, 14, '单张 ♠A order'); eq(p.bomb, 0, '单张 ♠A 非炸弹'); }

    const psL = parseCards([wild0], 5);
    const pl = wantPlay(psL, 'single', 5, 1, '级牌单张 ♥5');
    if (pl) { checkPlay(pl, 5, [wild0], '级牌单张 ♥5'); eq(pl.order, 15, '级牌单张 order 应为 15'); }

    const pairA = parseCards([c(0, 14), c(1, 14)], 2);
    const pa = wantPlay(pairA, 'pair', 14, 2, '对子 AA');
    if (pa) { checkPlay(pa, 2, [c(0, 14), c(1, 14)], '对子 AA'); eq(pa.bomb, 0, '对子 AA 非炸弹'); }

    const big = parseCards([bj0, bj1], 5);
    const pb = wantPlay(big, 'pair', 17, 2, '对子 大王大王');
    if (pb) { checkPlay(pb, 5, [bj0, bj1], '对子 大王大王'); eq(pb.order, 17, '双大王对子 order=17'); eq(pb.bomb, 0, '双大王对子非炸弹'); }

    const small = parseCards([sj0, sj1], 5);
    const psm = wantPlay(small, 'pair', 16, 2, '对子 小王小王');
    if (psm) { checkPlay(psm, 5, [sj0, sj1], '对子 小王小王'); eq(psm.order, 16, '双小王对子 order=16'); }

    eq(parseCards([sj0, bj0], 5).length, 0, '一大一小两张王：不能成对，应无任何解读');

    const lvlPair = parseCards([c(0, 5), wild0], 5);
    const pp5 = wantPlay(lvlPair, 'pair', 5, 2, '级牌对子 ♠5♥5');
    if (pp5) { checkPlay(pp5, 5, [c(0, 5), wild0], '级牌对子 ♠5♥5'); eq(pp5.order, 15, '级牌对子 order 应为 15'); }

    const triple = parseCards([c(0, 2), c(1, 2), c(2, 2)], 5);
    const pt = wantPlay(triple, 'triple', 2, 3, '三同张 222');
    if (pt) { checkPlay(pt, 5, [c(0, 2), c(1, 2), c(2, 2)], '三同张 222'); eq(pt.order, 2, '三同张 222 order'); }

    eq(parseCards([sj0, sj1, bj0], 5).length, 0, '三张王不能组成三同张，应无解读');

    // 逢人配：♥5 + ♠9 + ♣9 = 三张 9
    const wildTriple = parseCards([wild0, c(0, 9), c(2, 9)], 5);
    const pwt = wantPlay(wildTriple, 'triple', 9, 3, '逢人配 ♥5+♠9+♣9 应成三张 9');
    if (pwt) {
      checkPlay(pwt, 5, [wild0, c(0, 9), c(2, 9)], '逢人配三张 9');
      eq(pwt.order, 9, '逢人配三张 9 的 order');
      ok(Array.isArray(pwt.wilds) && pwt.wilds.length === 1 && pwt.wilds[0].card === wild0,
        '逢人配三张 9：wilds 应记录 ♥5 配牌，实际 ' + fmt(pwt.wilds));
    }
    // 两张逢人配补三同张
    const twoWildTriple = parseCards([wild0, wild1, c(0, 9)], 5);
    wantPlay(twoWildTriple, 'triple', 9, 3, '两张♥5+♠9 应成三张 9');
    // 逢人配 + 一张同点 = 对子
    const wildPair = parseCards([wild0, c(0, 9)], 5);
    wantPlay(wildPair, 'pair', 9, 2, '逢人配 ♥5+♠9 应成对子 9');
    // 两张♥5 单出 = 对子 5（级牌）
    const twoWildPair = parseCards([wild0, wild1], 5);
    const pwp = wantPlay(twoWildPair, 'pair', 5, 2, '两张♥5 应成对子 5（级牌）');
    if (pwp) { checkPlay(pwp, 5, [wild0, wild1], '两张♥5 对子'); eq(pwp.order, 15, '两张♥5 对子 order=15（级牌）'); }
    // 逢人配不能当王
    eq(parseCards([wild0, sj0, sj1], 5).length, 0, '逢人配不能当王：♥5+小王×2 应无解读');
  }

  section('2b. 三带二');
  {
    const fh = parseCards([c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 3)], 5);
    const pf = wantPlay(fh, 'fullhouse', 2, 5, '三带二 222+33');
    if (pf) { checkPlay(pf, 5, [c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 3)], '三带二 222+33'); eq(pf.order, 2, '三带二 order 应为三张点数'); }
    // 三带二的对子允许是两张王
    const fhJ = parseCards([c(0, 2), c(1, 2), c(2, 2), sj0, sj1], 5);
    const pfj = wantPlay(fhJ, 'fullhouse', 2, 5, '三带二 222+小王小王');
    if (pfj) checkPlay(pfj, 5, [c(0, 2), c(1, 2), c(2, 2), sj0, sj1], '三带二 222+小王小王');
    // 222+3+4 不是三带二
    const noFh = parseCards([c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 4)], 5);
    ok(noFh.filter(function (p) { return p.type === 'fullhouse'; }).length === 0,
      '222+3+4 不应解读为三带二；实际解读：' + playsText(noFh));
    // 逢人配三带二：取最大点数（配成三张 3 + 对 2）
    const fhW = parseCards([wild0, c(0, 2), c(1, 2), c(0, 3), c(1, 3)], 5);
    eq(fhW.filter(function (p) { return p.type === 'fullhouse'; }).length, 1,
      '逢人配三带二：parseCards 每种牌型只给一个最强解读；实际：' + playsText(fhW));
    const pfw = wantPlay(fhW, 'fullhouse', 3, 5, '逢人配三带二应默认配成最大点数（三张3+对2）');
    if (pfw) {
      checkPlay(pfw, 5, [wild0, c(0, 2), c(1, 2), c(0, 3), c(1, 3)], '逢人配三带二');
      ok(!findPlay(fhW, 'fullhouse', 2, 5), 'parseCards 只应返回最强解读（不应同时给三张2的解读）');
    }
  }

  section('2c. 顺子 / 同花顺');
  {
    // A2345（A 当 1，顶位 5）
    const a2345Cards = [c(0, 14), c(1, 2), c(2, 3), c(3, 4), c(0, 5)];
    const s1 = parseCards(a2345Cards, 2);
    const p1 = wantPlay(s1, 'straight', 5, 5, '顺子 A2345（A 当 1，顶位应为 5）');
    if (p1) { checkPlay(p1, 2, a2345Cards, '顺子 A2345'); eq(p1.order, 5, 'A2345 order=5'); eq(p1.bomb, 0, 'A2345 非炸弹'); }
    // 10JQKA（顶位 A=14）
    const tjqkaCards = [c(0, 10), c(1, 11), c(2, 12), c(3, 13), c(0, 14)];
    const s2 = parseCards(tjqkaCards, 2);
    const p2 = wantPlay(s2, 'straight', 14, 5, '顺子 10JQKA（顶位 A）');
    if (p2) { checkPlay(p2, 2, tjqkaCards, '顺子 10JQKA'); eq(p2.order, 14, '10JQKA order=14'); }
    // 23456
    const s23456 = [c(0, 2), c(1, 3), c(2, 4), c(3, 5), c(0, 6)];
    const s3 = parseCards(s23456, 2);
    const p3 = wantPlay(s3, 'straight', 6, 5, '顺子 23456（顶位 6）');
    if (p3) { checkPlay(p3, 2, s23456, '顺子 23456'); eq(p3.order, 6, '23456 order=6'); }
    // QKA23 非法
    const qka23 = [c(0, 12), c(0, 13), c(0, 14), c(0, 2), c(0, 3)];
    eq(parseCards(qka23, 2).length, 0, 'QKA23 不是合法顺子，应无任何解读');
    // 级牌在连牌里按自然点数参与：级牌 5 时 ♠5 在 5-9 顺子里算 5
    const lvlStraight = [c(0, 5), c(1, 6), c(2, 7), c(3, 8), c(0, 9)];
    const s4 = parseCards(lvlStraight, 5);
    const p4 = wantPlay(s4, 'straight', 9, 5, '级牌 5 参与顺子 5-9（按自然点数）');
    if (p4) { checkPlay(p4, 5, lvlStraight, '级牌参与的 5-9 顺子'); eq(p4.order, 9, '5-9 顺子 order=9'); }
    // 逢人配默认取最大：♥5+6+7+8+9（级牌5）应默认配成 6-10 顺子
    const wildStraightCards = [wild0, c(0, 6), c(1, 7), c(2, 8), c(3, 9)];
    const s5 = parseCards(wildStraightCards, 5);
    const p5 = wantPlay(s5, 'straight', 10, 5, '逢人配默认配成最大顺子（♥5+6+7+8+9 → 6-10）');
    if (p5) {
      checkPlay(p5, 5, wildStraightCards, '逢人配默认 6-10 顺子');
      eq(p5.order, 10, '逢人配 6-10 顺子 order=10');
      ok(!findPlay(s5, 'straightflush', undefined, 5), '不同花色的 ♥5+6+7+8+9 不应解读为同花顺');
      ok(Array.isArray(p5.wilds) && p5.wilds.length === 1 && p5.wilds[0].card === wild0 && p5.wilds[0].asRank === 10,
        '逢人配顺子：wilds 应为 [{card:' + wild0 + ', asRank:10, ...}]，实际 ' + fmt(p5.wilds));
    }
    // 两张逢人配补顺子：♥5×2 + 6,7,8 → 6-10
    const twoWildStraight = [wild0, wild1, c(0, 6), c(1, 7), c(2, 8)];
    wantPlay(parseCards(twoWildStraight, 5), 'straight', 10, 5, '两张逢人配 + 6,7,8 应配成 6-10 顺子');

    // 同花顺：♠A2345 同时给出 straightflush 与 straight 解读
    const sfCards = [c(0, 14), c(0, 2), c(0, 3), c(0, 4), c(0, 5)];
    const allSf = parseAll(sfCards, 2);
    ok(allSf.length >= 2, 'parseAll(♠A2345) 应至少给出 2 种解读（同花顺 + 顺子），实际：' + playsText(allSf));
    const sf = wantPlay(allSf, 'straightflush', 5, 5, 'parseAll(♠A2345) 应含同花顺（顶位 5）');
    if (sf) { checkPlay(sf, 2, sfCards, '同花顺 ♠A2345'); eq(sf.bomb, 5.5, '同花顺 bomb 应为 5.5'); eq(sf.order, 5, '同花顺 order 应为顶位 levelOrder'); }
    const stOfSf = wantPlay(allSf, 'straight', 5, 5, 'parseAll(♠A2345) 应含顺子（顶位 5）');
    if (stOfSf) { checkPlay(stOfSf, 2, sfCards, '♠A2345 的顺子解读'); eq(stOfSf.bomb, 0, '顺子解读 bomb=0'); }
    ok(allSf.length <= 48, 'parseAll 默认上限应为 48 个解读（实际 ' + allSf.length + '）');
    const sfKeys = allSf.map(function (p) { return p.type + '|' + p.rank; });
    ok(new Set(sfKeys).size === sfKeys.length, 'parseAll 结果应去重');

    const pcSf = parseCards(sfCards, 2);
    const pcSfIdx = pcSf.findIndex(function (p) { return p.type === 'straightflush'; });
    const pcStIdx = pcSf.findIndex(function (p) { return p.type === 'straight'; });
    ok(pcSfIdx >= 0, 'parseCards(♠A2345) 也应含同花顺解读（每种牌型给最强解读）；实际：' + playsText(pcSf));
    ok(pcStIdx >= 0, 'parseCards(♠A2345) 也应含顺子解读（同花顺可当顺子出）；实际：' + playsText(pcSf));
    ok(pcSfIdx >= 0 && pcStIdx >= 0 && pcSfIdx < pcStIdx, 'parseCards 应按强度降序（同花顺在顺子前）');

    // 10JQKA 同花顺
    const kSfCards = [c(0, 10), c(0, 11), c(0, 12), c(0, 13), c(0, 14)];
    const kSf = parseAll(kSfCards, 2);
    const kp = wantPlay(kSf, 'straightflush', 14, 5, '同花顺 ♠10JQKA 顶位应为 14');
    if (kp) { checkPlay(kp, 2, kSfCards, '同花顺 ♠10JQKA'); eq(kp.bomb, 5.5, '♠10JQKA 同花顺 bomb=5.5'); }

    // 逢人配补花色：♥5 + ♠6♠7♠8♠9（级牌 5）应能配成同花顺（♥5 当 ♠10 → 6-10）
    const patchCards = [wild0, c(0, 6), c(0, 7), c(0, 8), c(0, 9)];
    const patchAll = parseAll(patchCards, 5);
    const patchSf = wantPlay(patchAll, 'straightflush', 10, 5, '逢人配 ♥5 补花色：♥5+♠6♠7♠8♠9 应成同花顺（当 ♠10，6-10）');
    if (patchSf) { checkPlay(patchSf, 5, patchCards, '逢人配补花色的同花顺'); eq(patchSf.bomb, 5.5, '逢人配同花顺 bomb=5.5'); }
  }

  section('2d. 三连对 / 钢板');
  {
    // AA2233（A 当 1，顶位 3）
    const tubeCards = [c(0, 14), c(1, 14), c(0, 2), c(1, 2), c(0, 3), c(1, 3)];
    const t1 = parseCards(tubeCards, 5);
    eq(t1.length, 1, 'AA2233 应只有三连对 1 种解读；实际：' + playsText(t1));
    const pt1 = wantPlay(t1, 'tube', 3, 6, '三连对 AA2233（顶位 3）');
    if (pt1) { checkPlay(pt1, 5, tubeCards, '三连对 AA2233'); eq(pt1.order, 3, 'AA2233 order=3'); }
    // 22AAKK 非法
    const badTube = [c(0, 2), c(1, 2), c(0, 14), c(1, 14), c(0, 13), c(1, 13)];
    eq(parseCards(badTube, 5).length, 0, '22AAKK 不是三连对（2/A/K 不连续），应无任何解读');
    // QKA 顶位三连对
    const qkaTube = [c(0, 12), c(1, 12), c(0, 13), c(1, 13), c(0, 14), c(1, 14)];
    const ptq = wantPlay(parseCards(qkaTube, 2), 'tube', 14, 6, '三连对 QQKKAA（顶位 A=14）');
    if (ptq) checkPlay(ptq, 2, qkaTube, '三连对 QQKKAA');
    // 钢板 AAA222（A2 窗口，顶位 2）
    const plateA2 = [c(0, 14), c(1, 14), c(2, 14), c(0, 2), c(1, 2), c(2, 2)];
    const pl1 = parseCards(plateA2, 5);
    eq(pl1.length, 1, 'AAA222 应只有钢板 1 种解读；实际：' + playsText(pl1));
    const pp1 = wantPlay(pl1, 'plate', 2, 6, '钢板 AAA222（A2 窗口，顶位 2）');
    if (pp1) { checkPlay(pp1, 5, plateA2, '钢板 AAA222'); eq(pp1.order, 2, 'AAA222 钢板 order=2'); }
    // 钢板 KKKAAA（KA 窗口，顶位 A=14）
    const plateKA = [c(0, 13), c(1, 13), c(2, 13), c(0, 14), c(1, 14), c(2, 14)];
    const pp2 = wantPlay(parseCards(plateKA, 5), 'plate', 14, 6, '钢板 KKKAAA（顶位 A=14）');
    if (pp2) checkPlay(pp2, 5, plateKA, '钢板 KKKAAA');
    // 222334 非法
    const badPlate = [c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 3), c(0, 4)];
    eq(parseCards(badPlate, 5).length, 0, '222334 不是钢板（也不是其它牌型），应无任何解读');
    // 逢人配补钢板：222 + 33 + ♥5 → 钢板 22333
    const wildPlate = [c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 3), wild0];
    const ppw = wantPlay(parseCards(wildPlate, 5), 'plate', 3, 6, '逢人配补钢板：222+33+♥5 应成顶位 3 的钢板');
    if (ppw) checkPlay(ppw, 5, wildPlate, '逢人配补钢板');
  }

  section('2e. 炸弹 / 四大天王 / 逢人配补炸');
  {
    const b4 = parseCards(allTwos.slice(0, 4), 5);
    const p4 = wantPlay(b4, 'bomb', 2, 4, '4 张 2 炸弹');
    if (p4) { checkPlay(p4, 5, allTwos.slice(0, 4), '4 张 2 炸弹'); eq(p4.bomb, 4, '4 张炸 bomb=4'); eq(p4.order, 2, '4 张 2 炸 order=2'); }
    const p5 = wantPlay(parseCards(allTwos.slice(0, 5), 5), 'bomb', 2, 5, '5 张 2 炸弹');
    if (p5) { eq(p5.bomb, 5, '5 张炸 bomb=5'); checkPlay(p5, 5, allTwos.slice(0, 5), '5 张 2 炸弹'); }
    const p6 = wantPlay(parseCards(allTwos.slice(0, 6), 5), 'bomb', 2, 6, '6 张 2 炸弹');
    if (p6) eq(p6.bomb, 6, '6 张炸 bomb=6');
    const p8 = wantPlay(parseCards(allTwos.slice(0, 8), 5), 'bomb', 2, 8, '8 张 2 炸弹');
    if (p8) eq(p8.bomb, 8, '8 张炸 bomb=8');
    // 两张逢人配补到 10 张炸（8 张 2 + ♥5×2）
    const tenBomb = allTwos.concat([wild0, wild1]);
    const p10 = wantPlay(parseCards(tenBomb, 5), 'bomb', 2, 10, '8 张 2 + 两张♥5 应成 10 张 2 炸弹（最多 10 张）');
    if (p10) { eq(p10.bomb, 10, '10 张炸 bomb=10'); checkPlay(p10, 5, tenBomb, '10 张 2 炸弹'); }

    // 级牌炸弹在同张数炸弹里最大（order=15）
    const levelBombCards = [c(0, 5), c(1, 5), c(2, 5), c(3, 5)];
    const plb = wantPlay(parseCards(levelBombCards, 5), 'bomb', 5, 4, '级牌 5 的 4 张炸弹');
    if (plb) { eq(plb.bomb, 4, '级牌炸弹 bomb=4'); eq(plb.order, 15, '级牌炸弹 order 应为 15'); checkPlay(plb, 5, levelBombCards, '级牌 5 炸弹'); }

    // 逢人配补炸：3+3+♥5+♥5（级牌 5）= 3333
    const wildBombCards = [c(0, 3), c(1, 3), wild0, wild1];
    const pwb = wantPlay(parseCards(wildBombCards, 5), 'bomb', 3, 4, '逢人配补炸：3+3+♥5+♥5 应成 3333');
    if (pwb) { checkPlay(pwb, 5, wildBombCards, '逢人配 3333'); eq(pwb.bomb, 4, '逢人配 3333 bomb=4'); eq(pwb.order, 3, '逢人配 3333 order=3'); }
    // ♥5+♠5+♣5+♦5 = 4 张 5 轰炸（级牌炸弹）
    const fourFives = [c(0, 5), wild0, c(2, 5), c(3, 5)];
    const p45 = wantPlay(parseCards(fourFives, 5), 'bomb', 5, 4, '♥5+♠5+♣5+♦5 应成 4 张 5 炸弹');
    if (p45) { eq(p45.order, 15, '四张 5 炸弹 order=15（级牌）'); checkPlay(p45, 5, fourFives, '四张 5 炸弹'); }

    // 四大天王
    const jbCards = [sj0, bj0, sj1, bj1];
    const pjb = wantPlay(parseCards(jbCards, 5), 'jokerbomb', undefined, 4, '四大天王');
    if (pjb) { checkPlay(pjb, 5, jbCards, '四大天王'); eq(pjb.bomb, 99, '四大天王 bomb=99'); eq(pjb.order, 0, '四大天王 order=0'); }
    eq(parseCards(jbCards, 5).length, 1, '四大天王应只有 1 种解读；实际：' + playsText(parseCards(jbCards, 5)));
    // 三张王既非三同张也非四大天王
    eq(parseCards([sj0, sj1, bj0], 5).length, 0, '小王×2+大王×1 不能组牌，应无解读');
  }

  section('2f. parseAll / parseAs 细化');
  {
    // parseAll 返回逢人配的两种三带二解读
    const fhW = [wild0, c(0, 2), c(1, 2), c(0, 3), c(1, 3)];
    const allW = parseAll(fhW, 5);
    wantPlay(allW, 'fullhouse', 2, 5, 'parseAll 应含「三张2+对3」解读');
    wantPlay(allW, 'fullhouse', 3, 5, 'parseAll 应含「三张3+对2」解读');
    ok(allW.length >= 2, 'parseAll 逢人配三带二应返回全部解读（实际 ' + allW.length + ' 个）');

    // parseAs 指定牌型
    const sfCards = [c(0, 14), c(0, 2), c(0, 3), c(0, 4), c(0, 5)];
    const as1 = E.parseAs(sfCards, 2, 'straight');
    ok(!!as1 && as1.type === 'straight' && as1.rank === 5 && as1.bomb === 0,
      'parseAs(♠A2345, straight) 应为 rank5 顺子，实际 ' + fmt(as1 && { type: as1.type, rank: as1.rank, bomb: as1.bomb }));
    const as2 = E.parseAs(sfCards, 2, 'straightflush');
    ok(!!as2 && as2.type === 'straightflush' && as2.bomb === 5.5 && as2.rank === 5,
      'parseAs(♠A2345, straightflush) 应为 rank5 同花顺（bomb5.5），实际 ' + fmt(as2 && { type: as2.type, rank: as2.rank, bomb: as2.bomb }));
    eq(E.parseAs(sfCards, 2, 'straight', 14), null, 'parseAs(♠A2345, straight, rank14) 应为 null（A2345 顶位不是 A）');
    eq(E.parseAs(sfCards, 2, 'bomb'), null, 'parseAs(♠A2345, bomb) 应为 null（五张不同点不是炸弹）');
    eq(E.parseAs([c(0, 14), c(1, 2), c(2, 3), c(3, 4), c(0, 5)], 2, 'straightflush'), null,
      'parseAs(非同一花色的 A2345, straightflush) 应为 null');
    const as3 = E.parseAs([c(0, 10), c(0, 11), c(0, 12), c(0, 13), c(0, 14)], 2, 'straight', 14);
    ok(!!as3 && as3.type === 'straight' && as3.rank === 14, 'parseAs(♠10JQKA, straight, 14) 应非 null');
    const as4 = E.parseAs([wild0, c(0, 9)], 5, 'pair', 9);
    ok(!!as4 && as4.type === 'pair' && as4.rank === 9, 'parseAs(♥5+♠9, pair, 9) 应非 null（逢人配当 9）');
  }

  /* ---------------- 3. canBeat / comparePlays ---------------- */
  section('3. canBeat / comparePlays');
  {
    // 领出
    const leadSingle = mk([c(0, 14)], 5, 'single', 14, '单张 A');
    ok(E.canBeat(null, leadSingle) === true, 'canBeat(null, play) 应返回 true（prev=null 视为领出）');

    // 同型比较（级牌制顺序）
    const s2 = mk([c(0, 2)], 5, 'single', 2, '单张 2');
    const sA = mk([c(0, 14)], 5, 'single', 14, '单张 A');
    const s5 = mk([c(0, 5)], 5, 'single', 5, '级牌单张 5');
    const sJ = mk([sj0], 5, 'single', 16, '单张 小王');
    const sBJ = mk([bj0], 5, 'single', 17, '单张 大王');
    beats(sA, s2, true, '单张 A 压 单张 2');
    beats(s2, sA, false, '单张 2 不能压 单张 A');
    beats(s5, sA, true, '级牌单张 5 压 A（级牌 order=15）');
    beats(sA, s5, false, '单张 A 不能压 级牌 5');
    beats(sJ, s5, true, '小王压级牌');
    beats(sBJ, sJ, true, '大王压小王');
    beats(s5, sJ, false, '级牌 5 不能压小王');

    // 同 rank 不能互压
    const pairA1 = mk([c(0, 14), c(1, 14)], 2, 'pair', 14, '对子 A（第一副）');
    const pairA2 = mk([c(0, 14, 1), c(1, 14, 1)], 2, 'pair', 14, '对子 A（第二副）');
    beats(pairA1, pairA2, false, '同点数对子不能互相压');
    beats(pairA1, pairA1, false, '同一手牌不能压自己');

    // 异型不能互压
    const triple2 = mk([c(0, 2), c(1, 2), c(2, 2)], 5, 'triple', 2, '三同张 2');
    const pair2 = mk([c(0, 2), c(1, 2)], 5, 'pair', 2, '对子 2');
    beats(pairA1, triple2, false, '对子不能压三同张');
    beats(triple2, pairA1, false, '三同张不能压对子');
    beats(sA, pair2, false, '单张不能压对子');
    beats(pair2, sA, false, '对子不能压单张');

    // 炸弹压普通牌
    const b4_2 = mk(allTwos.slice(0, 4), 5, 'bomb', 2, '4 张 2 炸弹');
    const pairA = mk([c(0, 14), c(1, 14)], 5, 'pair', 14, '对子 A');
    beats(b4_2, pairA, true, '4 炸压对子 A');
    beats(pairA, b4_2, false, '对子不能压炸弹');

    // 炸弹体系：5炸 < 同花顺 < 6炸，7炸 < 四大天王
    const b5_2 = mk(allTwos.slice(0, 5), 5, 'bomb', 2, '5 张 2 炸弹');
    const b6_2 = mk(allTwos.slice(0, 6), 5, 'bomb', 2, '6 张 2 炸弹');
    const b7_2 = mk(allTwos.slice(0, 7), 5, 'bomb', 2, '7 张 2 炸弹');
    const b8_2 = mk(allTwos.slice(0, 8), 5, 'bomb', 2, '8 张 2 炸弹');
    const sf10 = mk([c(0, 6), c(0, 7), c(0, 8), c(0, 9), c(0, 10)], 5, 'straightflush', 10, '同花顺 ♠6-10');
    const jb = mk([sj0, bj0, sj1, bj1], 5, 'jokerbomb', undefined, '四大天王');
    beats(b5_2, b4_2, true, '5 炸压 4 炸');
    beats(b4_2, b5_2, false, '4 炸不能压 5 炸');
    beats(sf10, b5_2, true, '同花顺压 5 炸（bomb5.5 > bomb5）');
    beats(b5_2, sf10, false, '5 炸不能压同花顺');
    beats(b6_2, sf10, true, '6 炸压同花顺');
    beats(sf10, b6_2, false, '同花顺不能压 6 炸');
    beats(jb, b7_2, true, '四大天王压 7 炸');
    beats(b7_2, jb, false, '7 炸不能压四大天王');
    beats(jb, b8_2, true, '四大天王压 8 炸');
    beats(b8_2, jb, false, '8 炸不能压四大天王');
    // 同张数炸弹比 order；级牌炸弹最大
    const b4_A = mk([c(0, 14), c(1, 14), c(2, 14), c(3, 14)], 5, 'bomb', 14, '4 张 A 炸弹');
    const b4_3 = mk([c(0, 3), c(1, 3), c(2, 3), c(3, 3)], 5, 'bomb', 3, '4 张 3 炸弹');
    const b4_5 = mk([c(0, 5), c(1, 5), c(2, 5), c(3, 5)], 5, 'bomb', 5, '4 张 5 炸弹（级牌）');
    beats(b4_3, b4_2, true, '同张数炸弹比 order：4 张 3 压 4 张 2');
    beats(b4_A, b4_3, true, '4 张 A 压 4 张 3');
    beats(b4_5, b4_A, true, '级牌炸弹在同张数炸弹里最大（order=15 压 A 的 14）');
    beats(b4_A, b4_5, false, '4 张 A 不能压级牌炸弹');

    // 三带二只比三张
    const fhA = mk([c(0, 2), c(1, 2), c(2, 2), c(0, 14), c(1, 14)], 5, 'fullhouse', 2, '三带二 222+AA');
    const fhB = mk([c(0, 3), c(1, 3), c(2, 3), c(0, 2), c(1, 2)], 5, 'fullhouse', 3, '三带二 333+22');
    beats(fhB, fhA, true, '三带二只比三张：333+22 压 222+AA（尽管对子更小）');
    beats(fhA, fhB, false, '222+AA 不能压 333+22');

    // 三连对 / 钢板比顶位
    const tubeA = mk([c(0, 14), c(1, 14), c(0, 2), c(1, 2), c(0, 3), c(1, 3)], 2, 'tube', 3, '三连对 AA2233');
    const tube345 = mk([c(0, 3), c(1, 3), c(0, 4), c(1, 4), c(0, 5), c(1, 5)], 2, 'tube', 5, '三连对 334455');
    const tubeQKA = mk([c(0, 12), c(1, 12), c(0, 13), c(1, 13), c(0, 14), c(1, 14)], 2, 'tube', 14, '三连对 QQKKAA');
    beats(tube345, tubeA, true, '三连对比顶位：334455 压 AA2233');
    beats(tubeA, tube345, false, '三连对 AA2233 不能压 334455');
    beats(tubeQKA, tube345, true, '三连对顶位 A(14) 压顶位 5');

    const plateA2 = mk([c(0, 14), c(1, 14), c(2, 14), c(0, 2), c(1, 2), c(2, 2)], 5, 'plate', 2, '钢板 AAA222');
    const plate34 = mk([c(0, 3), c(1, 3), c(2, 3), c(0, 4), c(1, 4), c(2, 4)], 5, 'plate', 4, '钢板 333444');
    const plateQK = mk([c(0, 12), c(1, 12), c(2, 12), c(0, 13), c(1, 13), c(2, 13)], 5, 'plate', 13, '钢板 QQQKKK');
    beats(plate34, plateA2, true, '钢板比顶位：333444 压 AAA222');
    beats(plateA2, plate34, false, '钢板 AAA222 不能压 333444');
    beats(plateQK, plate34, true, '钢板顶位 K 压顶位 4');

    // A 顶顺 vs A 低顺
    const stHi = mk([c(0, 10), c(1, 11), c(2, 12), c(3, 13), c(0, 14)], 2, 'straight', 14, '顺子 10JQKA');
    const stLo = mk([c(0, 14), c(1, 2), c(2, 3), c(3, 4), c(0, 5)], 2, 'straight', 5, '顺子 A2345');
    beats(stHi, stLo, true, 'A 顶顺（10JQKA）压 A 低顺（A2345）');
    beats(stLo, stHi, false, 'A2345 不能压 10JQKA');

    // 异型：顺子 vs 三带二
    const fhC = mk([c(0, 2), c(1, 2), c(2, 2), c(0, 3), c(1, 3)], 5, 'fullhouse', 2, '三带二 222+33');
    beats(stHi, fhC, false, '顺子不能压三带二');
    beats(fhC, stHi, false, '三带二不能压顺子');

    // 同花顺按不同解读出牌
    const sfLo = mk([c(0, 14), c(0, 2), c(0, 3), c(0, 4), c(0, 5)], 2, 'straightflush', 5, '同花顺 ♠A2345');
    beats(sfLo, stHi, true, '同花顺（炸弹 5.5）压普通顺子（顶位 14）');
    beats(stHi, sfLo, false, '普通顺子不能压同花顺');
    const stLoAsStraight = mk([c(0, 14), c(0, 2), c(0, 3), c(0, 4), c(0, 5)], 2, 'straight', 5, '♠A2345 的顺子解读');
    beats(stHi, stLoAsStraight, true, '按顺子解读时，10JQKA 压 A2345');
    beats(stLoAsStraight, stHi, false, 'A2345（顺子解读）不能压 10JQKA');
  }

  /* ---------------- 4. genMoves ---------------- */
  section('4. genMoves 合法候选');
  {
    // 领出：KKK+22 必须有三带二
    const handKKK = [c(0, 13), c(1, 13), c(2, 13), c(0, 2), c(1, 2)];
    const moves1 = checkMoves(handKKK, 5, null, undefined, '领出 KKK+22');
    const fhMove = findPlay(moves1, 'fullhouse', 13, 5);
    ok(!!fhMove, '手牌 KKK+22 领出：genMoves 应给出三带二 KKK+22（rank13）；实际：' + playsText(moves1));

    // 领出：10JQKA 必须有顺子
    const handStraight = [c(0, 10), c(1, 11), c(2, 12), c(3, 13), c(0, 14)];
    const moves2 = checkMoves(handStraight, 2, null, undefined, '领出 10JQKA');
    ok(!!findPlay(moves2, 'straight', 14, 5), '手牌 10JQKA 领出：genMoves 应给出顶位 A 的顺子；实际：' + playsText(moves2));

    // 领出：4 同点必须有炸弹
    const moves3 = checkMoves(allTwos.slice(0, 4), 5, null, undefined, '领出 2222');
    ok(!!findPlay(moves3, 'bomb', 2, 4), '手牌 2222 领出：genMoves 应给出 4 张 2 炸弹；实际：' + playsText(moves3));

    // 领出：2 大 2 小必须有四大天王
    const moves4 = checkMoves([sj0, bj0, sj1, bj1], 5, null, undefined, '领出 四大天王');
    ok(!!findPlay(moves4, 'jokerbomb', undefined, 4), '手牌 大王×2+小王×2 领出：genMoves 应给出四大天王；实际：' + playsText(moves4));

    // 领出：逢人配补炸弹
    const moves5 = checkMoves([c(0, 3), c(1, 3), wild0, wild1], 5, null, undefined, '领出 3+3+♥5+♥5');
    ok(!!findPlay(moves5, 'bomb', 3, 4), '手牌 3+3+♥5+♥5 领出：genMoves 应给出 4 张 3 炸弹；实际：' + playsText(moves5));

    // 领出：逢人配补三带二（最大点数）
    const handWildFh = [wild0, c(0, 2), c(1, 2), c(0, 3), c(1, 3)];
    const moves6 = checkMoves(handWildFh, 5, null, undefined, '领出 逢人配三带二');
    ok(!!findPlay(moves6, 'fullhouse', 3, 5), '手牌 ♥5+22+33 领出：genMoves 应给出三张 3 的三带二；实际：' + playsText(moves6));

    // 跟牌：跟对子 K，只能给能压的
    const lastPairK = mk([c(0, 13), c(1, 13)], 5, 'pair', 13, '对子 K');
    const handFollow = [c(0, 14, 0), c(0, 14, 1), c(0, 2), c(1, 2)]; // 对 A + 对 2
    const moves7 = checkMoves(handFollow, 5, lastPairK, undefined, '跟对子 K');
    ok(!!findPlay(moves7, 'pair', 14, 2), '跟对子 K 时：genMoves 应给出对 A；实际：' + playsText(moves7));
    eq(moves7.length, 1, '跟对子 K 时手牌只有对 A 能压（对 2 order 不够），应恰有 1 个候选；实际：' + playsText(moves7));

    // 跟牌：压不过炸弹时不应给任何候选（不含过）
    const lastBomb4 = mk([c(0, 4), c(1, 4), c(2, 4), c(3, 4)], 5, 'bomb', 4, '4 张 4 炸弹');
    const handNoBomb = [c(0, 14), c(1, 14), c(0, 2), c(1, 2), c(0, 3), c(1, 3)];
    const moves8 = checkMoves(handNoBomb, 5, lastBomb4, undefined, '跟 4 炸');
    eq(moves8.length, 0, '手牌无炸弹时跟 4 炸：genMoves 应返回空（不含过）；实际：' + playsText(moves8));

    // 跟牌：逢人配补三同张压三张
    const lastTriple8 = mk([c(0, 8), c(1, 8), c(2, 8)], 5, 'triple', 8, '三同张 8');
    const handWildTriple = [wild0, c(0, 9), c(2, 9)];
    const moves9 = checkMoves(handWildTriple, 5, lastTriple8, undefined, '跟三同张 8（逢人配）');
    ok(!!findPlay(moves9, 'triple', 9, 3), '跟三同张 8 时：逢人配+♠9+♣9 应给出三张 9；实际：' + playsText(moves9));

    // opts.includeBombs = false：不应出现炸弹
    const movesNoBomb = checkMoves(allTwos.slice(0, 4), 5, null, { includeBombs: false }, '领出 2222 includeBombs=false');
    ok(movesNoBomb.length > 0, 'includeBombs=false 时仍应有非炸弹候选；实际为空');
    ok(movesNoBomb.every(function (p) { return p.bomb === 0; }), 'includeBombs=false 时不应出现炸弹；实际：' + playsText(movesNoBomb));
    ok(!!findPlay(movesNoBomb, 'triple', 2, 3), 'includeBombs=false 时仍应给出三同张 222（覆盖所有可成牌型）');
    ok(!!findPlay(movesNoBomb, 'pair', 2, 2), 'includeBombs=false 时仍应给出对子 22');

    // opts.limit：最多返回 limit 个
    const dealForLimit = E.deal(20240601);
    const movesLimit = checkMoves(dealForLimit.hands[0], 5, null, { limit: 5 }, 'limit=5');
    ok(movesLimit.length <= 5, 'opts.limit=5 时 genMoves 最多返回 5 个；实际 ' + movesLimit.length);
    ok(movesLimit.length > 0, 'opts.limit=5 时仍应返回候选');
  }

  /* ---------------- 5. counter ---------------- */
  section('5. counter 记牌器');
  {
    const c0 = E.counter({ level: 5, myHand: [], played: [] });
    ok(!!c0 && typeof c0 === 'object', 'counter 应返回对象');
    eq(c0.total, 108, 'counter.total 应为 108');
    eq(c0.playedCount, 0, '空局 playedCount=0');
    eq(c0.mineCount, 0, '空局 mineCount=0');
    eq(c0.unknown, 108, '空局 unknown=108');
    eq(c0.wildRemaining, 2, '空局 wildRemaining=2');
    ok(c0.ok === true, '空局 ok 应为 true');
    ok(Array.isArray(c0.warnings) && c0.warnings.length === 0, '空局 warnings 应为空数组');
    ok(Array.isArray(c0.byRank), 'byRank 应为数组');
    eq(c0.byRank.length, 15, 'byRank 应有 15 项（2..A、小王、大王）');
    deepEq(c0.byRank.map(function (r) { return r.rank; }), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], 'byRank rank 顺序应为 2..A、16、17');
    let sumTotal = 0;
    c0.byRank.forEach(function (row) {
      const expTotal = row.rank >= 16 ? 2 : 8;
      sumTotal += row.total;
      eq(row.total, expTotal, 'byRank[' + row.rank + '].total');
      eq(row.text, E.rankText(row.rank), 'byRank[' + row.rank + '].text');
      eq(row.played, 0, 'byRank[' + row.rank + '].played');
      eq(row.mine, 0, 'byRank[' + row.rank + '].mine');
      eq(row.remaining, row.total, 'byRank[' + row.rank + '].remaining');
      eq(row.isLevel, row.rank === 5, 'byRank[' + row.rank + '].isLevel 应仅在级牌点数为 true');
      eq(row.isWild, row.rank === 5, 'byRank[' + row.rank + '].isWild 应仅在级牌点数为 true');
    });
    eq(sumTotal, 108, 'byRank.total 合计应为 108');

    // 真实发牌：未知 = 108 - 我手 - 已出
    const d = E.deal(20240601);
    const myHand = d.hands[0];
    const played = d.hands[1].slice(0, 5);
    const c1 = E.counter({ level: 5, myHand: myHand, played: played });
    eq(c1.mineCount, 27, 'counter.mineCount 应为 27');
    eq(c1.playedCount, 5, 'counter.playedCount 应为 5');
    eq(c1.unknown, 76, 'counter.unknown 应为 108-27-5=76');
    eq(c1.total, 108, 'counter.total 应为 108');
    ok(c1.ok === true, '合法输入 counter.ok 应为 true');
    const expWild = 2 - (myHand.filter(function (id) { return E.isWild(id, 5); }).length +
      played.filter(function (id) { return E.isWild(id, 5); }).length);
    eq(c1.wildRemaining, expWild, 'wildRemaining = 2 - 我手/已出中的红桃级牌数');
    let sumMine = 0, sumPlayed = 0, sumRemaining = 0;
    c1.byRank.forEach(function (row) {
      const expPlayed2 = played.filter(function (id) { return E.cardRank(id) === row.rank; }).length;
      const expMine2 = myHand.filter(function (id) { return E.cardRank(id) === row.rank; }).length;
      sumMine += row.mine; sumPlayed += row.played; sumRemaining += row.remaining;
      eq(row.played, expPlayed2, '真实发牌 byRank[' + row.rank + '].played');
      eq(row.mine, expMine2, '真实发牌 byRank[' + row.rank + '].mine');
      eq(row.remaining, row.total - expPlayed2 - expMine2, '真实发牌 byRank[' + row.rank + '].remaining');
    });
    eq(sumMine, 27, 'byRank.mine 合计应为 27');
    eq(sumPlayed, 5, 'byRank.played 合计应为 5');
    eq(sumRemaining, 76, 'byRank.remaining 合计应为 76');

    // 已出含红桃级牌 → wildRemaining 变化
    const c2 = E.counter({ level: 5, myHand: [], played: [wild0] });
    eq(c2.wildRemaining, 1, '已出一张 ♥5 后 wildRemaining 应为 1');
    const row5 = c2.byRank.filter(function (r) { return r.rank === 5; })[0];
    if (row5) { eq(row5.played, 1, '已出 ♥5 后 rank5.played=1'); eq(row5.remaining, 7, '已出 ♥5 后 rank5.remaining=7'); }

    // 我手 + 已出各一张红桃级牌 → 0
    const c3 = E.counter({ level: 5, myHand: [wild0], played: [wild1] });
    eq(c3.wildRemaining, 0, '两张红桃级牌都在我手/已出时 wildRemaining 应为 0');
    eq(c3.mineCount, 1, 'c3.mineCount=1');
    eq(c3.playedCount, 1, 'c3.playedCount=1');
    eq(c3.unknown, 106, 'c3.unknown=106');

    // 冲突：同一张牌同时出现在我手与已出
    const conflictId = c(0, 2);
    const c4 = E.counter({ level: 5, myHand: [conflictId], played: [conflictId] });
    ok(c4.ok === false || (Array.isArray(c4.warnings) && c4.warnings.length > 0),
      '同一张牌同时在我手与已出：ok 应为 false 或 warnings 非空（实际 ok=' + fmt(c4.ok) + ', warnings=' + fmt(c4.warnings) + '）');
    const c5 = E.counter({ level: 5, myHand: [wild0, wild1], played: [wild0] });
    ok(c5.ok === false || (Array.isArray(c5.warnings) && c5.warnings.length > 0),
      '红桃级牌同时在我手与已出也应告警（ok=' + fmt(c5.ok) + ', warnings=' + fmt(c5.warnings) + '）');
  }

  /* ---------------- 6. deal / createRng ---------------- */
  section('6. deal(seed) / createRng');
  {
    const d1 = E.deal(20240601);
    ok(!!d1 && Array.isArray(d1.hands), 'deal 应返回 { hands: [...] }');
    eq(d1.hands.length, 4, 'deal 应发 4 家');
    d1.hands.forEach(function (h, i) {
      eq(h.length, 27, '第 ' + i + ' 家应 27 张');
      ok(h.every(function (id) { return Number.isInteger(id) && id >= 1 && id <= 108; }),
        '第 ' + i + ' 家的牌 id 应为 1..108 整数');
    });
    const flat = d1.hands[0].concat(d1.hands[1], d1.hands[2], d1.hands[3]);
    eq(flat.length, 108, '四家合计 108 张');
    eq(new Set(flat).size, 108, '四家之间不应有重复牌');
    deepEq(sortedNum(flat), Array.from({ length: 108 }, function (_, i) { return i + 1; }), '四家恰好覆盖 1..108');
    eq(d1.seed, 20240601, 'deal.seed 应回显 seed');
    const d1b = E.deal(20240601);
    deepEq(d1b.hands, d1.hands, '同 seed 两次发牌结果应完全一致');
    const d2 = E.deal(20240602);
    ok(JSON.stringify(d2.hands) !== JSON.stringify(d1.hands), '不同 seed 应产生不同发牌');

    const rngA = E.createRng(42);
    const rngB = E.createRng(42);
    let sameSeq = true, inRange = true;
    for (let i = 0; i < 20; i++) {
      const a = rngA(), b = rngB();
      if (a !== b) sameSeq = false;
      if (!(typeof a === 'number' && a >= 0 && a < 1)) inRange = false;
    }
    ok(sameSeq, 'createRng(42) 两次产生的序列应一致（确定性 mulberry32）');
    ok(inRange, 'createRng 输出应在 [0,1)');
  }

  /* ---------------- 7. GDAI ---------------- */
  if (!AI) console.log('\n== 7. GDAI ==\n（gd.ai.js 尚未就绪，跳过 GDAI 验收断言；引擎部分已完整执行）');
  if (AI) {
  section('7a. GDAI.handSummary / candidates / suggest 定向场景');
  {
    // handSummary
    const hs = AI.handSummary([c(0, 14), c(0, 14, 1), c(0, 2), c(1, 2), c(0, 3), c(1, 3)], 5);
    ok(!!hs && typeof hs === 'object', 'handSummary 应返回对象');
    eq(hs.count, 6, 'handSummary.count');
    eq(hs.wilds, 0, 'handSummary.wilds=0');
    ok(typeof hs.playsEstimate === 'number' && hs.playsEstimate > 0, 'handSummary.playsEstimate 应为正数');
    ok(Array.isArray(hs.bombs), 'handSummary.bombs 应为 Play[]（SPEC §5）');
    const hsW = AI.handSummary([wild0, wild1, c(0, 2), c(1, 2), c(0, 3), c(1, 3)], 5);
    eq(hsW.wilds, 2, 'handSummary.wilds 应统计两张红桃级牌');
    const hsB = AI.handSummary(allTwos.slice(0, 4), 5);
    ok(Array.isArray(hsB.bombs) && hsB.bombs.length >= 1, 'handSummary.bombs 应识别 4 张 2 炸弹');
    if (Array.isArray(hsB.bombs) && hsB.bombs.length > 0) {
      ok(hsB.bombs[0] && hsB.bombs[0].type === 'bomb' && hsB.bombs[0].bomb === 4,
        'handSummary.bombs[0] 应为 4 张炸弹 Play，实际 ' + fmt(hsB.bombs[0]));
    }

    function aiState(o) {
      const st = Object.assign({ level: 2, mySeat: 0, hand: [], lastPlay: null, lastPlaySeat: null }, o);
      st.seatsRemaining = Object.assign({ 0: 27, 1: 27, 2: 27, 3: 27 }, o.seatsRemaining || {});
      st.seatsRemaining[st.mySeat] = st.hand.length;
      return st;
    }

    // candidates：合法、降序、limit
    const candState = aiState({ level: 5, mySeat: 0, hand: [c(0, 14, 0), c(0, 14, 1), c(0, 2), c(1, 2)], seatsRemaining: { 0: 4, 1: 20, 2: 20, 3: 20 } });
    let cands = null;
    try { cands = AI.candidates(candState, 5); } catch (e) { ok(false, 'GDAI.candidates 不应抛异常：' + e.message); }
    if (Array.isArray(cands)) {
      ok(cands.length > 0, 'GDAI.candidates 领出时应有合法候选');
      ok(cands.length <= 5, 'GDAI.candidates(state, 5) 应不超过 5 个');
      let prevScore = Infinity;
      cands.forEach(function (cd, i) {
        const p = cd && cd.play;
        ok(!!p && typeof cd.score === 'number', 'candidates[' + i + '] 结构应为 {play, score}');
        if (!p) return;
        ok(handContains(candState.hand, p.cards), 'candidates[' + i + '] 出牌应在手牌中');
        ok(!!reproduce(p, 5), 'candidates[' + i + '] 应合法');
        ok(cd.score <= prevScore + 1e-9, 'candidates 应按 score 降序');
        prevScore = cd.score;
      });
    } else {
      ok(false, 'GDAI.candidates 应返回数组，实际 ' + fmt(cands));
    }

    // S1：能一次出完时必出尽（领出 23456 顺子，5 张手牌）
    const st1 = aiState({ level: 2, mySeat: 0, hand: [c(0, 2), c(1, 3), c(2, 4), c(3, 5), c(0, 6)], seatsRemaining: { 0: 5, 1: 20, 2: 20, 3: 20 } });
    const r1 = safeSuggest(st1, 'S1 一次出完');
    checkSuggested(r1, st1, 'S1 一次出完');
    if (r1) {
      eq(r1.action, 'play', 'S1：手牌可一次出完时必须出牌');
      if (r1.play) {
        eq(r1.play.size, 5, 'S1：应打光全部 5 张手牌');
        eq(r1.play.type, 'straight', 'S1：这手牌唯一出尽方式是顺子');
        eq(r1.play.rank, 6, 'S1：顺子顶位应为 6');
        if (r1.handInfo) { eq(r1.handInfo.count, 5, 'S1：handInfo.count'); }
      }
      ok(typeof r1.handInfo.bombs === 'number', 'S1：handInfo.bombs 应为数字（SPEC §5），实际 ' + fmt(r1.handInfo && r1.handInfo.bombs));
    }

    // S2：队友当前最大且不能一手出完 → 默认 pass
    const lastPairK = mk([c(0, 13), c(1, 13)], 5, 'pair', 13, '对子 K');
    const st2 = aiState({
      level: 5, mySeat: 0, hand: [c(0, 14), c(1, 14), c(0, 2), c(1, 2)],
      lastPlay: lastPairK, lastPlaySeat: 2, seatsRemaining: { 0: 4, 1: 12, 2: 12, 3: 12 }
    });
    const r2 = safeSuggest(st2, 'S2 让队友');
    checkSuggested(r2, st2, 'S2 让队友');
    if (r2) {
      eq(r2.action, 'pass', 'S2：队友（对家）当前最大、自己无法一手出完时应默认 pass');
      eq(r2.play, null, 'S2：pass 时 play 应为 null');
    }

    // S3：队友当前最大，但能一手出完 → 必须出尽
    const lastSingle3 = mk([c(0, 3)], 5, 'single', 3, '单张 3');
    const st3 = aiState({
      level: 5, mySeat: 0, hand: [sj0, bj0, sj1, bj1],
      lastPlay: lastSingle3, lastPlaySeat: 2, seatsRemaining: { 0: 4, 1: 12, 2: 12, 3: 12 }
    });
    const r3 = safeSuggest(st3, 'S3 一手出完');
    checkSuggested(r3, st3, 'S3 一手出完');
    if (r3) {
      eq(r3.action, 'play', 'S3：队友最大但自己能一手出完时不应 pass');
      if (r3.play) {
        eq(r3.play.type, 'jokerbomb', 'S3：应直接打出四大天王');
        eq(r3.play.size, 4, 'S3：四大天王应打光全部 4 张手牌');
      }
    }

    // S4：压不过时必须 pass，且 candidates 为空
    const jbPlay = mk([sj0, bj0, sj1, bj1], 5, 'jokerbomb', undefined, '四大天王');
    const st4 = aiState({
      level: 5, mySeat: 0, hand: allTwos.slice(0, 4),
      lastPlay: jbPlay, lastPlaySeat: 1, seatsRemaining: { 0: 4, 1: 10, 2: 10, 3: 10 }
    });
    const r4 = safeSuggest(st4, 'S4 压不过');
    checkSuggested(r4, st4, 'S4 压不过');
    if (r4) {
      eq(r4.action, 'pass', 'S4：任何牌都压不过四大天王，必须 pass');
      eq(r4.play, null, 'S4：pass 时 play 应为 null');
      ok(Array.isArray(r4.candidates) && r4.candidates.length === 0,
        'S4：压不过时 candidates 应为空（只有能压的才进 candidates）；实际 ' + fmt(r4.candidates && r4.candidates.length));
    }

    // S5：对手剩余 ≤3 张时优先拦截 → 应出牌
    const lastPair5 = mk([c(0, 5), c(1, 5)], 2, 'pair', 5, '对子 5');
    const st5 = aiState({
      level: 2, mySeat: 0, hand: [c(0, 14), c(1, 14), c(0, 2), c(1, 2), c(0, 3), c(1, 3)],
      lastPlay: lastPair5, lastPlaySeat: 1, seatsRemaining: { 0: 6, 1: 2, 2: 12, 3: 12 }
    });
    const r5 = safeSuggest(st5, 'S5 拦截对手');
    checkSuggested(r5, st5, 'S5 拦截对手');
    if (r5) eq(r5.action, 'play', 'S5：对手仅剩 2 张时应优先拦截（出牌）而非 pass');
  }

  section('7b. GDAI.suggest 随机 200 个局面安全性质');
  {
    const deckIds = [];
    for (let i = 1; i <= 108; i++) deckIds.push(i);
    const rng = E.createRng(20240607);
    for (let iter = 0; iter < 200; iter++) {
      try {
        const level = 2 + Math.floor(rng() * 13);
        const mySeat = Math.floor(rng() * 4);
        const handSize = 1 + Math.floor(rng() * 27);
        const sh = shuffle(deckIds, rng);
        const hand = sh.slice(0, handSize);
        const avail = sh.slice(handSize);

        let lastPlay = null;
        let lastPlaySeat = null;
        if (rng() < 0.6) {
          for (let t = 0; t < 40 && !lastPlay; t++) {
            const size = 1 + Math.floor(rng() * 6);
            if (avail.length < size) break;
            const pool = avail.slice();
            const pick = [];
            for (let k = 0; k < size; k++) pick.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
            let ps = [];
            try { ps = E.parseCards(pick, level) || []; } catch (e) { ps = []; }
            if (ps.length) lastPlay = ps[Math.floor(rng() * ps.length)];
          }
          if (lastPlay) {
            const others = [0, 1, 2, 3].filter(function (s) { return s !== mySeat; });
            lastPlaySeat = others[Math.floor(rng() * others.length)];
          }
        }
        const seatsRemaining = {};
        for (let s = 0; s < 4; s++) seatsRemaining[s] = (s === mySeat) ? hand.length : (1 + Math.floor(rng() * 27));
        const st = { level: level, mySeat: mySeat, hand: hand, lastPlay: lastPlay, lastPlaySeat: lastPlaySeat, seatsRemaining: seatsRemaining };
        const tag = '随机#' + iter + '(级' + level + ',我' + mySeat + ',手' + handSize + '张)';

        let r = null;
        try { r = AI.suggest(st); } catch (e) {
          ok(false, tag + '：suggest 不应抛异常，实际：' + e.message);
          continue;
        }
        if (!ok(!!r && typeof r === 'object', tag + '：suggest 应返回对象')) continue;
        checkSuggested(r, st, tag);

        let legal = [];
        try { legal = E.genMoves(hand, level, lastPlay, {}); } catch (e) { legal = []; }
        const legalKeys = new Set(legal.map(moveKey));
        if (lastPlay === null) {
          eq(r.action, 'play', tag + '：领出（lastPlay=null）时必须出牌，不能 pass');
        } else if (legal.length === 0) {
          eq(r.action, 'pass', tag + '：压不过上一手时必须 pass');
          ok(Array.isArray(r.candidates) && r.candidates.length === 0, tag + '：压不过时 candidates 应为空');
        }
        if (r.action === 'play' && r.play) {
          ok(legalKeys.has(moveKey(r.play)), tag + '：建议出牌应来自 genMoves 合法候选；play=' + moveKey(r.play));
        }
      } catch (e) {
        ok(false, '随机局面#' + iter + ' 生成/校验过程异常：' + e.message);
      }
    }
  }

  } // end if (AI)

  section('8. UI 静态验收（index.html，file:// 可开）');
  {
    const ROOT = __dirname;
    const htmlPath = path.join(ROOT, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      console.log('（index.html 尚未就绪，跳过 UI 静态验收）');
    } else {
      let html = '';
      try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { html = ''; }
      ok(!!html && html.length > 500, 'index.html 应存在且非空（>500 字符）；实际 ' + html.length);
      if (html) {
        ok(/<!DOCTYPE\s+html/i.test(html), 'index.html 应有 <!DOCTYPE html>');
        ok(/<html[^>]*\blang\s*=\s*["']zh/i.test(html), 'index.html 应声明 lang="zh*"');
        ok(/<meta\s+charset\s*=\s*["']?utf-8/i.test(html), 'index.html 应声明 UTF-8 charset');

        function collectAttr(tagRe, attrRe) {
          const out = [];
          let mm;
          tagRe.lastIndex = 0;
          while ((mm = tagRe.exec(html))) {
            const am = attrRe.exec(mm[1] || '');
            if (am) out.push(String(am[1]).trim());
          }
          return out;
        }
        const scriptSrcs = collectAttr(/<script\b([^>]*)>/gi, /\bsrc\s*=\s*["']([^"']+)["']/i);
        const linkHrefs = collectAttr(/<link\b([^>]*)>/gi, /\bhref\s*=\s*["']([^"']+)["']/i);
        const imgSrcs = collectAttr(/<img\b([^>]*)>/gi, /\bsrc\s*=\s*["']([^"']+)["']/i);

        function isRemote(s) { return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(s); }
        function isAbsolute(s) { return /^[\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s); }
        function refOk(s) { return !isRemote(s) && !isAbsolute(s); }
        function relName(s) { return String(s).replace(/^\.\//, '').split(/[?#]/)[0]; }
        function hasScript(name) { return scriptSrcs.some(function (s) { return relName(s) === name; }); }
        function idxOf(name) { for (let i = 0; i < scriptSrcs.length; i++) if (relName(scriptSrcs[i]) === name) return i; return -1; }

        ok(scriptSrcs.length > 0, 'index.html 应有 <script src> 引用本地脚本');
        const badScriptSrcs = scriptSrcs.filter(function (s) { return !refOk(s); });
        ok(badScriptSrcs.length === 0, '所有 <script src> 应为相对路径（file:// 可开，不用 CDN/绝对路径）；实际 ' + fmt(badScriptSrcs));
        ['gd.core.js', 'gd.ai.js', 'gd.deepseek.js'].forEach(function (name) {
          ok(hasScript(name), 'index.html 应通过相对 <script src> 引用 ' + name + '；实际脚本 ' + fmt(scriptSrcs));
        });
        const iCore = idxOf('gd.core.js');
        const iAi = idxOf('gd.ai.js');
        const iDs = idxOf('gd.deepseek.js');
        const iApp = idxOf('app.js');
        if (iCore >= 0 && iAi >= 0) ok(iCore < iAi, '脚本加载顺序应为 gd.core.js 先于 gd.ai.js');
        if (iAi >= 0 && iDs >= 0) ok(iAi < iDs, '脚本加载顺序应为 gd.ai.js 先于 gd.deepseek.js');
        if (iDs >= 0 && iApp >= 0) ok(iDs < iApp, '脚本加载顺序应为 gd.deepseek.js 先于 app.js');
        if (fs.existsSync(path.join(ROOT, 'app.js'))) {
          ok(iApp >= 0, 'index.html 应引用 app.js（app.js 存在时）；实际脚本 ' + fmt(scriptSrcs));
        }
        scriptSrcs.forEach(function (s) {
          if (!refOk(s)) return;
          ok(fs.existsSync(path.join(ROOT, relName(s))), 'index.html 引用的本地脚本应存在：' + s);
        });

        // 无 CDN / 外链资源（离线 file:// 可开）：script/link/img 资源属性都不得是远程或绝对路径
        const badLinks = linkHrefs.filter(function (s) { return isRemote(s) || isAbsolute(s); });
        ok(badLinks.length === 0, '所有 <link href> 应为相对本地路径（无 CDN）；实际 ' + fmt(badLinks));
        const badImgs = imgSrcs.filter(function (s) { return isRemote(s); });
        ok(badImgs.length === 0, '<img src> 不应指向 CDN/外链；实际 ' + fmt(badImgs));
        const extMatch = html.match(/\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/[^"']*["']/gi) || [];
        ok(extMatch.length === 0, 'index.html 的资源引用不应出现 http(s)/协议相对外链（无 CDN）；实际 ' + fmt(extMatch.slice(0, 5)));
        ok(!/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(html), 'index.html 内联样式不应 @import 远程资源');

        // 无 ES module（file:// 下 ES module/import 受限，SPEC 要求普通 script 相对加载）
        ok(!/\btype\s*=\s*["']module["']/i.test(html), 'index.html 不应使用 <script type="module">');
        ok(!/\bimport\s*\(/.test(html), 'index.html 不应使用动态 import()（不用 ES module）');

        // 样式表相对引用
        if (fs.existsSync(path.join(ROOT, 'style.css'))) {
          ok(linkHrefs.some(function (s) { return relName(s) === 'style.css'; }),
            'index.html 应通过 <link rel="stylesheet"> 相对引用 style.css；实际 link ' + fmt(linkHrefs));
        }
        const cssPath = path.join(ROOT, 'style.css');
        if (fs.existsSync(cssPath)) {
          let css = '';
          try { css = fs.readFileSync(cssPath, 'utf8'); } catch (e) { css = ''; }
          ok(css.length > 500, 'style.css 应存在且非空（>500 字符）；实际 ' + css.length);
          if (css) {
            const cssImp = css.match(/@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\/[^"'\s)]*/gi) || [];
            ok(cssImp.length === 0, 'style.css 不应 @import 远程样式（无 CDN）；实际 ' + fmt(cssImp.slice(0, 4)));
            const cssUrl = css.match(/url\(\s*["']?\s*(?:https?:)?\/\/[^"'\s)]*/gi) || [];
            ok(cssUrl.length === 0, 'style.css 的 url() 不应指向 http(s)/协议相对外链；实际 ' + fmt(cssUrl.slice(0, 4)));
          }
        }
      }
    }
  }

  section('8b. UI 关键 DOM 断言（设置 / 帮助 / 选牌器 / 记录弹窗与按钮 id）');
  {
    const ROOT = __dirname;
    const htmlPath = path.join(ROOT, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      console.log('（index.html 尚未就绪，跳过 UI DOM 断言）');
    } else {
      let html = '';
      try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { html = ''; }
      ok(!!html, 'index.html 应可读取');
      if (html) {
        function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        function idRe(id) { return new RegExp('\\sid\\s*=\\s*["\']' + escRe(id) + '["\']'); }
        function hasId(id) { return idRe(id).test(html); }
        function hasIdText(id, text) {
          return new RegExp('\\sid\\s*=\\s*["\']' + escRe(id) + '["\'][^>]*>[^<]*' + escRe(text)).test(html);
        }
        function tagOf(id) {
          const re = new RegExp('<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\sid\\s*=\\s*["\']' + escRe(id) + '["\'][^>]*>', 'i');
          const mm = html.match(re);
          return mm ? { tag: mm[1].toLowerCase(), attrs: mm[0] } : null;
        }

        // 1) 结构性完整性：id 无重复、data-close 与 label[for] 目标存在、弹窗默认 hidden
        const allIds = [];
        const idAllRe = /\sid\s*=\s*["']([^"']+)["']/gi;
        let im;
        while ((im = idAllRe.exec(html))) allIds.push(im[1]);
        const dupIds = [];
        for (let i = 0; i < allIds.length; i++) {
          if (allIds.indexOf(allIds[i]) !== allIds.lastIndexOf(allIds[i]) && dupIds.indexOf(allIds[i]) < 0) dupIds.push(allIds[i]);
        }
        ok(allIds.length > 20, 'index.html 应有足够数量的 DOM id（>20）；实际 ' + allIds.length);
        ok(dupIds.length === 0, 'index.html 的 id 不应重复；重复：' + fmt(dupIds));
        ['modal-record', 'modal-hand', 'modal-settings', 'modal-help'].forEach(function (id) {
          const t = tagOf(id);
          ok(!!t, 'index.html 应有弹窗容器 #' + id);
          if (t) {
            ok(/class\s*=\s*["'][^"']*modal-backdrop/.test(t.attrs), '#' + id + ' 应为 .modal-backdrop 遮罩；实际 ' + t.attrs.slice(0, 80));
            ok(/\bhidden\b/.test(t.attrs), '#' + id + ' 默认应 hidden（初始不展示）');
          }
        });
        ok((html.match(/\brole\s*=\s*["']dialog["']/gi) || []).length >= 4, '应有 4 个 role="dialog" 弹窗');
        ok((html.match(/\baria-modal\s*=\s*["']true["']/gi) || []).length >= 4, '弹窗应设置 aria-modal="true"');
        const closeTargets = [];
        const dcRe = /data-close\s*=\s*["']([^"']+)["']/gi;
        let dm;
        while ((dm = dcRe.exec(html))) closeTargets.push(dm[1]);
        ok(closeTargets.length >= 4, '弹窗应有可点击关闭控件（data-close）；实际 ' + closeTargets.length);
        const badClose = closeTargets.filter(function (v) { return !hasId(v); });
        ok(badClose.length === 0, 'data-close 指向的弹窗 id 都应存在；无效：' + fmt(badClose));
        const labelFors = [];
        const lfRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi;
        let lm;
        while ((lm = lfRe.exec(html))) labelFors.push(lm[1]);
        const badFor = labelFors.filter(function (v) { return !hasId(v); });
        ok(labelFors.length > 0 && badFor.length === 0, 'label[for] 应指向存在的控件 id；无效：' + fmt(badFor));
        const labelledBy = [];
        const lbRe = /aria-labelledby\s*=\s*["']([^"']+)["']/gi;
        let lbm;
        while ((lbm = lbRe.exec(html))) labelledBy.push(lbm[1]);
        const badLb = labelledBy.filter(function (v) { return !hasId(v); });
        ok(labelledBy.length >= 4 && badLb.length === 0, 'aria-labelledby 应指向存在的标题 id；无效：' + fmt(badLb));

        // 2) 顶栏：级牌 / 我座位 / 新一局·设置·规则帮助
        ok(hasId('level-select'), 'index.html 应有级牌选择 #level-select');
        ok(hasId('seat-select'), 'index.html 应有座位选择 #seat-select');
        const seatVals = (html.match(/<option\s+value\s*=\s*["']([0-3])["']/gi) || []).length;
        ok(seatVals >= 4, '座位选择应有 4 个选项 value 0..3；实际 ' + seatVals);
        ok(html.indexOf('我是1号位') >= 0 && html.indexOf('我是4号位') >= 0, '座位选项文案应含「我是1号位」…「我是4号位」');
        [['btn-new-round', '新一局'], ['btn-settings', '设置'], ['btn-help', '规则帮助']].forEach(function (it) {
          ok(hasId(it[0]), '顶栏应有按钮 #' + it[0]);
          ok(hasIdText(it[0], it[1]), '顶栏按钮 #' + it[0] + ' 文案应含「' + it[1] + '」');
        });
        ok(/<\/header>/.test(html), 'index.html 应有顶栏 <header>');
        ok(/<main\b[^>]*class\s*=\s*["'][^"']*layout/.test(html), 'index.html 主区域应为 .layout（3 列布局）');

        // 3) 四个面板关键容器 + 手牌/AI/记录按钮
        ['panel-counter', 'counter-grid', 'counter-summary', 'counter-warnings',
         'panel-hand', 'hand-cards', 'hand-count', 'hand-empty', 'btn-edit-hand', 'btn-deal-demo',
         'panel-ai', 'ai-level-badge', 'ai-lastplay', 'ai-seats', 'ai-result', 'ai-result-cards',
         'ai-result-reason', 'ai-source-badge', 'ai-candidates', 'ai-raw-wrap',
         'panel-history', 'history-list', 'history-count', 'history-empty'].forEach(function (id) {
          ok(hasId(id), 'index.html 应有面板/控件 #' + id);
        });
        [['btn-edit-hand', '编辑手牌'], ['btn-deal-demo', '随机示例'],
         ['btn-local-suggest', '本地建议'], ['btn-deepseek-suggest', 'DeepSeek 建议'],
         ['btn-adopt', '采用并记录'], ['btn-copy', '复制牌面'],
         ['btn-record', '记录出牌'], ['btn-undo', '撤销上一手'], ['btn-clear', '清空记录']].forEach(function (it) {
          ok(hasId(it[0]), 'index.html 应有按钮 #' + it[0]);
          ok(hasIdText(it[0], it[1]), '按钮 #' + it[0] + ' 文案应含「' + it[1] + '」');
        });

        // 4) 设置弹窗关键 DOM
        ok(hasId('setting-api-key'), '设置弹窗应有 API Key 输入 #setting-api-key');
        const keyInput = tagOf('setting-api-key');
        if (keyInput) {
          ok(/\btype\s*=\s*["']password["']/i.test(keyInput.attrs), 'API Key 输入应为 password 类型');
          ok(/\bautocomplete\s*=\s*["']off["']/i.test(keyInput.attrs), 'API Key 输入应 autocomplete="off"');
        }
        ok(hasId('setting-base-url'), '设置弹窗应有 Base URL 输入 #setting-base-url');
        ok(/placeholder\s*=\s*["']https:\/\/api\.deepseek\.com["']/.test(html), 'Base URL 默认提示应为 https://api.deepseek.com');
        ok(hasId('setting-model'), '设置弹窗应有模型选择 #setting-model');
        ok(/value\s*=\s*["']deepseek-chat["']/.test(html) && /value\s*=\s*["']deepseek-reasoner["']/.test(html),
          '模型选择应提供 deepseek-chat 与 deepseek-reasoner 两个选项');
        ok(hasId('setting-temperature'), '设置弹窗应有温度输入 #setting-temperature');
        ok(hasId('setting-timeout'), '设置弹窗应有超时输入 #setting-timeout');
        ok(/localStorage/.test(html), '设置弹窗应说明 Key 保存在本机 localStorage');
        ok(hasIdText('btn-save-settings', '保存'), '设置弹窗应有「保存」按钮 #btn-save-settings');
        ok(hasIdText('btn-test-connection', '测试连接'), '设置弹窗应有「测试连接」按钮 #btn-test-connection');
        ok(hasIdText('btn-clear-key', '清除 Key'), '设置弹窗应有「清除 Key」按钮 #btn-clear-key');

        // 5) 规则帮助弹窗关键 DOM
        ok(hasId('modal-help'), 'index.html 应有规则帮助弹窗 #modal-help');
        ok(hasId('help-title'), '规则帮助弹窗应有标题 #help-title');
        ['牌型', '大小顺序', '逢人配', '炸弹体系', '使用步骤'].forEach(function (kw) {
          ok(html.indexOf(kw) >= 0, '规则帮助应包含「' + kw + '」速查/说明');
        });
        ['单张', '对子', '三同张', '三带二', '顺子', '三连对', '钢板', '炸弹', '同花顺', '四大天王'].forEach(function (type) {
          ok(html.indexOf(type) >= 0, '规则帮助牌型表应包含「' + type + '」');
        });
        ok(/4 炸\s*(?:&lt;|<)\s*5 炸\s*(?:&lt;|<)\s*同花顺\s*(?:&lt;|<)\s*6 炸\s*(?:&lt;|<)\s*7 炸/.test(html),
          '规则帮助应给出炸弹体系大小链（4炸 < 5炸 < 同花顺 < 6炸 < 7炸…）');
        ok(hasIdText('modal-help', '知道') || /data-close\s*=\s*["']modal-help["'][^>]*>知道了/.test(html) || /知道了/.test(html),
          '规则帮助弹窗应有「知道了」关闭按钮');

        // 6) 选牌器（编辑手牌）与记录出牌弹窗
        ok(hasId('hand-picker'), '编辑手牌弹窗应有选牌器网格 #hand-picker');
        ok((html.match(/class\s*=\s*["'][^"']*\bpicker\b[^"']*["']/g) || []).length >= 2, '应有 2 个选牌器 .picker 网格（编辑手牌 + 记录出牌）');
        ok(hasId('hand-confirm'), '编辑手牌弹窗应有确认按钮 #hand-confirm');
        ok(hasIdText('hand-confirm', '确定'), '编辑手牌弹窗「确定」按钮文案应含「确定」');
        ok(hasId('record-seat'), '记录出牌弹窗应有座位选择 #record-seat');
        ok(hasId('record-pass'), '记录出牌弹窗应有「过」勾选 #record-pass');
        ok(/input\b[^>]*type\s*=\s*["']checkbox["'][^>]*\sid\s*=\s*["']record-pass["']/i.test(html) ||
           /id\s*=\s*["']record-pass["'][^>]*type\s*=\s*["']checkbox["']/i.test(html), '记录出牌「过」应为 checkbox 输入');
        ok(/本手「过」/.test(html), '记录出牌弹窗应提示「本手『过』（不出牌）」');
        ok(hasId('record-picker'), '记录出牌弹窗应有选牌网格 #record-picker');
        ok(hasId('record-selected-cards'), '记录出牌弹窗应显示已选牌 #record-selected-cards');
        ok(hasId('record-selected-info'), '记录出牌弹窗应显示已选张数 #record-selected-info');
        ok(hasId('record-confirm'), '记录出牌弹窗应有确认按钮 #record-confirm');
        ok(hasIdText('record-confirm', '确定记录'), '记录出牌弹窗「确定记录」按钮文案应含「确定记录」');
        ok(hasId('record-clear-sel') && hasIdText('record-clear-sel', '清空选择'), '记录出牌弹窗应有「清空选择」按钮 #record-clear-sel');
        ok(hasId('hand-clear-sel') && hasIdText('hand-clear-sel', '清空选择'), '编辑手牌弹窗应有「清空选择」按钮 #hand-clear-sel');
        ok(/108 张/.test(html), 'index.html 应提示选牌器为 108 张（两副牌）');
        ok(/置灰/.test(html), 'index.html 应提示已记录出的牌置灰不可选');
        ok(/(toast-root|toast)/.test(html), 'index.html 应有 toast 提示容器（异常用顶部 toast）');
      }
    }
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\nPASS ' + passed + ' / FAIL ' + failed + (hidden > 0 ? '（另有 ' + hidden + ' 条失败未打印）' : ''));
  process.exitCode = failed ? 1 : 0;
}

if (!GDEngine) {
  console.log('⏳ gd.core.js 未就绪，跳过验收测试：' + (loadErrors.join('；') || '未知原因'));
  process.exitCode = 2;
} else {
  main();
}
