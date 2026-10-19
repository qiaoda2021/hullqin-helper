// 掼蛋油猴版 · 本地 AI 出牌建议单测（gd.site.ai.js）
// 直接运行：node gd.site.ai.test.js（禁止联网）
'use strict';
const G = require('./gd.site.core.js');
const AI = require('./gd.site.ai.js');

let pass = 0, fail = 0;
const failures = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(name + '\n    got     ' + a + '\n    expected ' + e); }
}
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? '\n    ' + extra : '')); }
}

/* ---------- 牌 id 常量（与 gd.site.core.test.js 同口径） ---------- */
const P = {};
for (let suit = 0; suit < 4; suit++) for (let r = 1; r <= 13; r++) P[suit + '-' + r] = suit * 13 + r;
const d = (r) => P['0-' + r], c = (r) => P['1-' + r], h = (r) => P['2-' + r], s = (r) => P['3-' + r];
const BIG = 53, BIG2 = 107, SMALL = 54, SMALL2 = 108;
const W1 = 35, W1b = 89; // 级牌 9 的两张逢人配 ♥9
const LVL = 9;
const C = (t, r) => (t << 8) | r;
const T = G.TYPE;

/* ---------- 造一个完整 AI state ---------- */
function mkState(over) {
  const base = {
    level: LVL, levelText: '9', wildText: '♥9', heartLevelCardId: W1,
    mySeat: 1, mySeatName: '我', partnerSeat: 3, partnerSeatName: '对家',
    hand: [], handText: [], prevCode: 0, lastPlay: null, trickOwner: 0,
    canPlayAny: true, isMyTurn: true, phase: 'play',
    seatsRemaining: [
      { seat: 1, count: 5, isMe: true, isPartner: false },
      { seat: 2, count: 5, isMe: false, isPartner: false },
      { seat: 3, count: 5, isMe: false, isPartner: true },
      { seat: 4, count: 5, isMe: false, isPartner: false }
    ],
    history: [],
    counter: { byRank: [], wildRemaining: 2, ok: true, warnings: [], mineCount: 5, playedCount: 0, unknown: 103, total: 108 },
    remaining: [], wildRemaining: 2,
    tributers: [], tributeReceivers: [],
    mustTribute: false, mustReturn: false, roundResult: null, rankList: []
  };
  return Object.assign(base, over || {});
}
// 用真引擎构造 state（4 家真实手牌 + 座位归属）
function stateFromHands(hands, level, mySeat) {
  const cpl = new Array(108).fill(0);
  hands.forEach(function (hand, i) { hand.forEach(function (id) { cpl[id - 1] = i + 1; }); });
  const raw = {
    rule: 2, state: 1, v: 3, team13Level: 2, team24Level: 2, firstPlayer: 1,
    lastRankList: [], tributeCardList: [], returnCardList: [],
    playedCardList: [], playedTypeList: [], cardPositionList: cpl
  };
  return G.buildAIState(G.expandState(raw), mySeat);
}

/* ============================ 1. 手牌评估 ============================ */
eq('playsEstimate 空手牌', AI.playsEstimate([], LVL), 0);
eq('playsEstimate 单张', AI.playsEstimate([d(2)], LVL), 1);
eq('playsEstimate 对子', AI.playsEstimate([d(2), c(2)], LVL), 1);
eq('playsEstimate 两张散牌', AI.playsEstimate([d(2), c(3)], LVL), 2);
eq('playsEstimate 顺子', AI.playsEstimate([d(2), c(3), h(4), s(5), d(6)], LVL), 1);
eq('playsEstimate 三带二', AI.playsEstimate([d(13), c(13), h(13), d(2), c(2)], LVL), 1);
eq('playsEstimate 钢板', AI.playsEstimate([d(1), c(1), h(1), d(2), c(2), h(2)], LVL), 1);
eq('playsEstimate 炸弹+单张', AI.playsEstimate([d(2), c(2), h(2), s(2), d(5)], LVL), 2);
eq('playsEstimate 逢人配可并牌', AI.playsEstimate([d(2), c(2), W1], LVL), 1);

const sumHand = [d(2), c(2), h(2), s(2), BIG, BIG2, SMALL, SMALL2, W1];
const hs = AI.handSummary(sumHand, LVL);
eq('handSummary size', hs.size, 9);
eq('handSummary 炸弹数（4×2 + 四王）', hs.bombs, 2);
eq('handSummary wilds', hs.wilds, 1);
eq('handSummary levelCards', hs.levelCards, 1);
ok('handSummary playsEstimate 为正整数', hs.playsEstimate >= 1 && hs.playsEstimate <= 9);
eq('countBombs 4×2 一炸', AI.countBombs([d(2), c(2), h(2), s(2)], LVL), 1);
eq('countBombs 3×2 非炸', AI.countBombs([d(2), c(2), h(2)], LVL), 0);
eq('countBombs 四王', AI.countBombs([BIG, BIG2, SMALL, SMALL2], LVL), 1);
eq('countBombs 4×9 级牌算炸', AI.countBombs([d(9), c(9), h(9), s(9)], LVL), 1);

/* ============================ 2. 威胁判断 ============================ */
eq('opponentThreat 对手剩 2 张', AI.opponentThreat(mkState({
  seatsRemaining: [
    { seat: 1, count: 10, isMe: true, isPartner: false },
    { seat: 2, count: 2, isMe: false, isPartner: false },
    { seat: 3, count: 10, isMe: false, isPartner: true },
    { seat: 4, count: 10, isMe: false, isPartner: false }
  ]
})), { isThreat: true, count: 2, seat: 2 });
eq('opponentThreat 队友剩 1 张不算威胁', AI.opponentThreat(mkState({
  seatsRemaining: [
    { seat: 1, count: 10, isMe: true, isPartner: false },
    { seat: 2, count: 10, isMe: false, isPartner: false },
    { seat: 3, count: 1, isMe: false, isPartner: true },
    { seat: 4, count: 10, isMe: false, isPartner: false }
  ]
})).isThreat, false);
eq('opponentThreat 对手剩 4 张不算威胁', AI.opponentThreat(mkState()).isThreat, false);

/* ============================ 3. 候选生成 ============================ */
const leadState = mkState({ hand: [d(2), c(2), h(2), s(2), d(3), c(3), h(3), s(3), d(4), c(4), W1, BIG, SMALL] });
const cands = AI.candidates(leadState, 12);
ok('candidates 非空', cands.length > 0);
ok('candidates ≤ limit', cands.length <= 12);
ok('candidates 每张牌都在手牌', cands.every(function (x) { return x.play.cards.every(function (id) { return leadState.hand.indexOf(id) >= 0; }); }));
ok('candidates 牌型合法', cands.every(function (x) { return G.playFromCards(x.play.cards, LVL, x.play.code) !== null; }));
ok('candidates 带 score/tag', cands.every(function (x) { return typeof x.score === 'number' && typeof x.tag === 'string'; }));
ok('candidates 按分数降序', (function () {
  for (let i = 1; i < cands.length; i++) if (cands[i - 1].score < cands[i].score) return false;
  return true;
})());
ok('candidates 无重复 type|rank|size', (function () {
  const keys = cands.map(function (x) { return x.play.type + '|' + x.play.rank + '|' + x.play.size; });
  return new Set(keys).size === keys.length;
})());
eq('candidates limit=1', AI.candidates(leadState, 1).length, 1);
eq('candidates 空手牌', AI.candidates(mkState({ hand: [] }), 12), []);
const followState = mkState({ hand: [d(2), c(4), h(6)], prevCode: C(1, 3), trickOwner: 2, canPlayAny: false });
ok('candidates 跟牌只保留能压的', AI.candidates(followState).every(function (x) { return G.beats(x.play.code, C(1, 3)); }));
eq('candidates 跟牌无解时为空', AI.candidates(mkState({ hand: [d(2)], prevCode: C(102, 14) })), []);

/* ============================ 4. suggest 分支 ============================ */
function sug(over) { return AI.suggest(mkState(over)); }
let r = sug({ hand: [d(2)], isMyTurn: false });
eq('非我回合 → pass', [r.action, r.source], ['pass', 'local']);
ok('非我回合 reason 非空', r.reason.length > 0);
r = sug({ hand: [d(2)], phase: 'tribute', mustTribute: true });
eq('进贡阶段 → pass', r.action, 'pass');
ok('进贡阶段 reason 提示进贡', r.reason.indexOf('进贡') >= 0);
r = sug({ hand: [] });
eq('空手牌 → pass', r.action, 'pass');
eq('空手牌 reason', r.reason, '手里没有牌');

// 一手出完（领出顺子）
const finishHand = [d(2), c(3), h(4), s(5), d(6)];
r = sug({ hand: finishHand });
eq('一手出完 action', r.action, 'play');
eq('一手出完 play 用光手牌', r.play.size, finishHand.length);
eq('一手出完 play 牌全在手', r.play.cards.slice().sort((a, b) => a - b), finishHand.slice().sort((a, b) => a - b));
ok('一手出完 reason', r.reason.indexOf('一手出完') >= 0);
ok('一手出完 candidates 有内容', r.candidates.length > 0);

// 队友牌权 → 让过（手牌 2 张，不能一手出完）
r = sug({ hand: [d(6), c(7)], prevCode: C(1, 5), trickOwner: 3, canPlayAny: false });
eq('队友牌权 → pass', r.action, 'pass');
ok('队友牌权 reason', r.reason.indexOf('队友') >= 0);

// 领出：应出牌
r = sug({ hand: [d(2), c(2), h(3)] });
eq('领出 → play', r.action, 'play');
ok('领出 reason 含领出', r.reason.indexOf('领出') >= 0);
ok('领出 play 合法', G.playFromCards(r.play.cards, LVL, r.play.code) !== null);

// 对手威胁 + 炸弹拦截
r = sug({
  hand: [d(2), c(2), h(2), s(2), d(6)],
  prevCode: C(1, 14), trickOwner: 2, canPlayAny: false,
  seatsRemaining: [
    { seat: 1, count: 5, isMe: true, isPartner: false },
    { seat: 2, count: 2, isMe: false, isPartner: false },
    { seat: 3, count: 10, isMe: false, isPartner: true },
    { seat: 4, count: 10, isMe: false, isPartner: false }
  ]
});
eq('威胁拦截 → play', r.action, 'play');
ok('威胁拦截用炸弹', r.play.bomb >= 4, JSON.stringify(r.play));
ok('威胁拦截 reason 含对手', r.reason.indexOf('对手') >= 0 || r.reason.indexOf('拦截') >= 0);

// 压不过 → pass
r = sug({ hand: [d(2), c(3)], prevCode: C(102, 14), trickOwner: 2, canPlayAny: false });
eq('压不过 → pass', r.action, 'pass');
eq('压不过 reason', r.reason, '没有能压过的牌，过');

// 跟牌：用最小代价压住
r = sug({ hand: [d(6), c(7)], prevCode: C(1, 5), trickOwner: 2, canPlayAny: false });
eq('跟牌 → play', r.action, 'play');
ok('跟牌能压住', G.beats(r.play.code, C(1, 5)));
ok('跟牌 reason 含跟牌', r.reason.indexOf('跟牌') >= 0);

/* ============================ 5. toLocalSuggestion ============================ */
const ls = AI.toLocalSuggestion(r);
eq('toLocalSuggestion action', ls.action, 'play');
eq('toLocalSuggestion typeName', ls.typeName, r.play.name);
ok('toLocalSuggestion cards 文本化', Array.isArray(ls.cards) && ls.cards.length === r.play.size);
const lsPass = AI.toLocalSuggestion({ action: 'pass', play: null, reason: 'x' });
eq('toLocalSuggestion pass 无牌', [lsPass.action, lsPass.typeName, lsPass.cards.length], ['pass', '过', 0]);

/* ============================ 6. 打分为 10000 的一手出完 ============================ */
const finState = mkState({ hand: [d(2), c(3), h(4), s(5), d(6)] });
const finPlay = G.genMoves(finState.hand, LVL, 0).filter(function (m) { return m.size === 5; })[0];
ok('scorePlay 一手出完 = 10000', AI.scorePlay(finPlay, finState) === 10000);
const bombHand = [d(2), c(2), h(2), s(2), d(6)];
ok('拆炸弹的单张得分低于普通单张', (function () {
  const st = mkState({ hand: bombHand });
  const breakOne = G.playFromCards([d(2)], LVL, C(1, 2));
  const normal = G.playFromCards([d(6)], LVL, C(1, 6));
  return AI.scorePlay(breakOne, st) < AI.scorePlay(normal, st);
})());

/* ============================ 7. 真实牌局随机性质测试 ============================ */
for (let seed = 1; seed <= 120; seed++) {
  const hands = G.deal(seed * 7919).hands;
  const st = stateFromHands(hands, LVL, 1);
  const lv = st.level;
  const sug2 = AI.suggest(st);
  const cands2 = AI.candidates(st, 12);
  ok('随机#' + seed + ' 建议字段齐全', ['action', 'source', 'reason'].every(function (k) { return k in sug2; }) && sug2.handInfo && sug2.handInfo.size === 27);
  ok('随机#' + seed + ' candidates ≤12', cands2.length <= 12);
  if (sug2.action === 'play') {
    ok('随机#' + seed + ' play 非空', !!sug2.play && sug2.play.cards.length > 0);
    ok('随机#' + seed + ' play 在手牌内', sug2.play.cards.every(function (id) { return st.hand.indexOf(id) >= 0; }));
    ok('随机#' + seed + ' play 牌型合法', G.playFromCards(sug2.play.cards, lv, sug2.play.code) !== null);
  } else {
    ok('随机#' + seed + ' pass 时 reason 非空', sug2.reason.length > 0);
  }
  ok('随机#' + seed + ' 候选全部合法', cands2.every(function (x) { return G.playFromCards(x.play.cards, lv, x.play.code) !== null; }));
}

// 跟牌场景随机：对手牌权时若存在候选须出牌，且必须能压过
for (let seed = 1; seed <= 60; seed++) {
  const hands = G.deal(seed * 104729).hands;
  const st = stateFromHands(hands, LVL, 1);
  const prev = G.playFromCards([d(1)], LVL, C(1, 14)); // 上一手：单张 A
  const followSt = Object.assign({}, st, {
    prevCode: prev.code, lastPlay: null, trickOwner: 2, canPlayAny: false,
    seatsRemaining: st.seatsRemaining.map(function (x) { return Object.assign({}, x); })
  });
  const sug3 = AI.suggest(followSt);
  const cands3 = AI.candidates(followSt, 12);
  if (sug3.action === 'play') {
    ok('跟牌随机#' + seed + ' 能压过', G.beats(sug3.play.code, prev.code));
    ok('跟牌随机#' + seed + ' 牌在手牌内', sug3.play.cards.every(function (id) { return followSt.hand.indexOf(id) >= 0; }));
  } else {
    // 只有「没有能压过的牌」时才允许在对手牌权下过
    ok('跟牌随机#' + seed + ' 过牌仅因无解', cands3.length === 0 || sug3.reason.indexOf('没有能压过') >= 0);
  }
}

/* ============================ 汇总 ============================ */
if (fail) {
  console.log('失败明细：');
  failures.slice(0, 30).forEach(function (f, i) { console.log(' ' + (i + 1) + ') ' + f); });
  if (failures.length > 30) console.log(' … 其余 ' + (failures.length - 30) + ' 项省略');
}
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
