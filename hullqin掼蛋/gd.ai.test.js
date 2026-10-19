/*!
 * 掼蛋本地启发式 AI gd.ai.test.js —— 纯 Node 单测，禁止联网。
 * 运行：node gd.ai.test.js
 */
'use strict';

const E = require('./gd.core.js');
const A = require('./gd.ai.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push(msg);
  console.log('✗ ' + msg);
  return false;
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return true; }
  failed++;
  failures.push(msg + '（期望 ' + b + '，实际 ' + a + '）');
  console.log('✗ ' + msg + '（期望 ' + b + '，实际 ' + a + '）');
  return false;
}
function cardSet(cards) { return new Set(cards); }
function isSubset(cards, hand) {
  const hs = cardSet(hand);
  return cards.every(function (c) { return hs.has(c); });
}
function playLegal(play, hand, level) {
  if (!play || !Array.isArray(play.cards) || !play.cards.length) return false;
  if (!isSubset(play.cards, hand)) return false;
  if (new Set(play.cards).size !== play.cards.length) return false;
  if (play.size !== play.cards.length) return false;
  return !!E.parseAs(play.cards, level, play.type, play.type === 'jokerbomb' ? undefined : play.rank);
}
function rngOf(seed) { return E.createRng(seed); }
function randInt(rng, n) { return Math.floor(rng() * n); }

const S_A = 1, S_2 = 2, S_3 = 3, S_4 = 4, S_5 = 5, S_6 = 6, S_7 = 7, S_8 = 8, S_9 = 9, S_10 = 10, S_J = 11, S_Q = 12, S_K = 13;
const C_A = 27, C_K = 39, C_2 = 28;
const H_A = 14, H_2 = 15, H_3 = 16, H_5 = 18;

// ============================================================
// A. handSummary
// ============================================================
console.log('\n== A. handSummary ==');
{
  const s = A.handSummary([], 5);
  eq([s.count, s.playsEstimate, s.bombs.length, s.wilds], [0, 0, 0, 0], '空手牌摘要');
}
{
  const s = A.handSummary([S_7, 20, 33, 46], 5); // 7777
  eq(s.count, 4, '4 张同点 handSummary.count=4');
  eq(s.playsEstimate, 1, '4 张同点 playsEstimate=1');
  eq(s.bombs.length, 1, '4 张同点 detected 1 个炸弹');
  eq([s.bombs[0].type, s.bombs[0].rank, s.bombs[0].size, s.bombs[0].bomb], ['bomb', 7, 4, 4], '炸弹摘要字段');
}
{
  const s = A.handSummary([S_7, 20, 33, 46, S_6, 19, 32, 45, S_5, 18], 5); // 7777 + 666 + wild
  ok(s.bombs.length >= 2, '含两个炸弹（7777 + 666+♥5）时 bombs>=2（实际 ' + s.bombs.length + '）');
  const s2 = A.handSummary([S_7, 20, 33, 46, S_4], 5);
  ok(s2.bombs.length >= 1 && s2.bombs[0].size === 4, '5 张手牌中炸弹取 4 张');
}
{
  const wildsHand = [H_5, H_2, S_6, S_7, S_8, S_9];
  const s = A.handSummary(wildsHand, 5);
  eq(s.wilds, 1, 'handSummary 正确统计逢人配张数');
  eq(s.count, 6, 'handSummary.count 正确');
  ok(typeof s.playsEstimate === 'number' && s.playsEstimate >= 1, 'playsEstimate 为正数');
}
{
  // playsEstimate 边界：整手一条 5 连顺子算 1 手，散牌按点数算手数，且 1 <= estimate <= count
  const straight = A.handSummary([1, 2, 3, 4, 5], 5); // ♠A2345 同花顺
  eq(straight.playsEstimate, 1, '整手一条同花顺 playsEstimate=1');
  const scatter = A.handSummary([S_2, S_5, S_8, S_J], 5);
  eq(scatter.playsEstimate, 4, '四张无关联散牌 playsEstimate=4');
  [A.handSummary([1, 2, 3], 5), A.handSummary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)].forEach(function (s, i) {
    ok(s.playsEstimate >= 1 && s.playsEstimate <= s.count, 'playsEstimate 在 1..count 内（案例 ' + i + '）');
  });
}

// ============================================================
// B. candidates
// ============================================================
console.log('\n== B. candidates ==');
{
  const hand = [S_K, 26, 39, S_2, H_2, S_A, H_A, 53, 107, S_3, H_3];
  const state = { level: 9, mySeat: 0, hand: hand, lastPlay: null, lastPlaySeat: null, seatsRemaining: { 0: 11, 1: 27, 2: 27, 3: 27 } };
  const list = A.candidates(state);
  ok(list.length > 0 && list.length <= 12, 'candidates 领出返回 1..12 个（实际 ' + list.length + '）');
  ok(list.every(function (c, i) {
    if (i === 0) return true;
    return list[i - 1].score >= c.score;
  }), 'candidates score 降序');
  ok(list.every(function (c) { return !!c.play && playLegal(c.play, hand, 9); }), 'candidates 每个 play 合法且在手中');
  eq(A.candidates(state, 3).length, 3, 'candidates(state,3) 最多 3 个');
  eq(A.candidates({ level: 9, hand: [] }).length, 0, '空手牌 candidates=[]');
  eq(A.candidates(null).length, 0, 'candidates(null)=[] 不抛异常');
}
{
  // 跟牌：上一手对 A，候选只含能压的
  const prev = E.parseAs([S_A, H_A], 9, 'pair');
  const hand = [S_K, 26, 39, S_A, H_A, 53, 107, S_2, H_2];
  const state = { level: 9, mySeat: 0, hand: hand, lastPlay: prev, lastPlaySeat: 1, seatsRemaining: { 0: 9, 1: 20, 2: 20, 3: 20 } };
  const list = A.candidates(state);
  ok(list.length > 0, '能压时 candidates 非空');
  ok(list.every(function (c) { return E.canBeat(prev, c.play); }), 'candidates 全部能压上一手');
}
{
  // 压不过：上一手是大王单张，手里只有小牌
  const prev = E.parseCards([54], 9)[0];
  const state = { level: 9, mySeat: 0, hand: [S_2, H_3], lastPlay: prev, lastPlaySeat: 1, seatsRemaining: { 0: 2, 1: 20, 2: 20, 3: 20 } };
  eq(A.candidates(state), [], '压不过时 candidates=[]');
}

// ============================================================
// C. suggest 定向场景
// ============================================================
console.log('\n== C. suggest 定向场景 ==');
{
  const r = A.suggest(null);
  eq([r.action, r.play, r.candidates.length], ['pass', null, 0], 'suggest(null) 安全返回 pass');
  ok(typeof r.reason === 'string' && r.reason.length > 0, 'suggest(null) 有 reason');
  ok(r.handInfo && typeof r.handInfo.count === 'number', 'suggest(null) 有 handInfo');
}
{
  const state = { level: 5, mySeat: 0, hand: [S_2, H_3, S_4], seatsRemaining: { 0: 3, 1: 27, 2: 27, 3: 27 } };
  const r = A.suggest(state);
  eq(r.action, 'play', '领出时有牌必出');
  ok(r.play && playLegal(r.play, state.hand, 5), '领出建议合法');
  ok(r.reason.indexOf('领出') >= 0, '领出 reason 含「领出」');
  ok(r.candidates.length > 0 && r.candidates[0].play === r.play, '建议与候选首位一致');
}
{
  // 一次出完
  const state = { level: 5, mySeat: 0, hand: [S_7, 20, 33, 46], seatsRemaining: { 0: 4, 1: 27, 2: 27, 3: 27 } };
  const r = A.suggest(state);
  eq(r.action, 'play', '可一次出完时出牌');
  eq(r.play.cards.length, 4, '出完 4 张炸弹');
  ok(r.reason.indexOf('走完') >= 0 || r.reason.indexOf('出完') >= 0, '出完 reason 文案');
}
{
  // 压不过 → pass
  const prev = E.parseCards([54], 9)[0];
  const state = { level: 9, mySeat: 0, hand: [S_3, S_4], lastPlay: prev, lastPlaySeat: 1, seatsRemaining: { 0: 2, 1: 20, 2: 20, 3: 20 } };
  const r = A.suggest(state);
  eq([r.action, r.play, r.candidates.length], ['pass', null, 0], '压不过时 pass 且 candidates 为空');
  ok(r.reason.indexOf('压不过') >= 0 || r.reason.indexOf('过牌') >= 0, 'pass reason 文案');
}
{
  // 队友当前最大 → 让过
  const partnerPlay = E.parseCards([S_3], 9)[0];
  const state = {
    level: 9, mySeat: 0, hand: [S_K, 26, S_A, H_A, 53],
    lastPlay: partnerPlay, lastPlaySeat: 2,
    seatsRemaining: { 0: 5, 1: 20, 2: 20, 3: 20 }
  };
  const r = A.suggest(state);
  eq([r.action, r.play], ['pass', null], '队友最大时默认让过');
  ok(r.reason.indexOf('对家') >= 0, '让过 reason 含「对家」');
  ok(Array.isArray(r.candidates) && r.candidates.length <= 12, '让过时 candidates 仍为合法数组（≤12）');
}
{
  // 队友最大但能一次出完 → 出尽
  const partnerPlay = E.parseCards([S_3], 9)[0];
  const state = {
    level: 9, mySeat: 0, hand: [S_7, 20, 33, 46], // 7777 可以压单张
    lastPlay: partnerPlay, lastPlaySeat: 2,
    seatsRemaining: { 0: 4, 1: 20, 2: 20, 3: 20 }
  };
  const r = A.suggest(state);
  eq(r.action, 'play', '队友最大但能一次出完 → 出牌');
  eq(r.play.cards.length, 4, '队友最大时一次出完 4 张');
}
{
  // 对手 ≤3 张 → 拦截（级牌取 9，避免上一手 3 恰好是级牌而压不过）
  const prev = E.parseCards([S_3], 9)[0];
  const state = {
    level: 9, mySeat: 0, hand: [S_4, H_5, S_6],
    lastPlay: prev, lastPlaySeat: 1,
    seatsRemaining: { 0: 3, 1: 2, 2: 20, 3: 20 }
  };
  const r = A.suggest(state);
  eq(r.action, 'play', '对手仅剩 2 张时出牌拦截');
  ok(r.reason.indexOf('拦截') >= 0, '拦截 reason 含「拦截」');
  ok(r.play && E.canBeat(prev, r.play), '拦截候选能压上一手');
}
{
  // 逢人配不应浪费：有普通牌可压时优先普通牌
  const prev = E.parseCards([S_4], 5)[0];
  const state = {
    level: 5, mySeat: 0, hand: [S_6, H_5], // ♥5 是逢人配，但 ♠6 已可压
    lastPlay: prev, lastPlaySeat: 1,
    seatsRemaining: { 0: 2, 1: 20, 2: 20, 3: 20 }
  };
  const r = A.suggest(state);
  eq(r.action, 'play', '有普通牌可压时出牌');
  eq(r.play.cards, [S_6], '优先用普通牌 ♠6，不浪费逢人配');
}

// ============================================================
// D. 随机状态安全性质（200 个）
// ============================================================
console.log('\n== D. 随机状态性质 ==');
{
  const rng = rngOf(20241017);
  let checked = 0;
  let problems = [];
  for (let t = 0; t < 200; t++) {
    const level = 2 + randInt(rng, 13);
    const dealRes = E.deal(1000 + t);
    const mySeat = randInt(rng, 4);
    const hand = dealRes.hands[randInt(rng, 4)].slice();
    if (rng() < 0.2) hand.length = randInt(rng, hand.length + 1); // 有时截断
    const seatsRemaining = {};
    for (let s = 0; s < 4; s++) seatsRemaining[s] = s === mySeat ? hand.length : (randInt(rng, 4) === 0 ? randInt(rng, 3) : 10 + randInt(rng, 18));
    let lastPlay = null;
    let lastPlaySeat = null;
    if (rng() < 0.75 && hand.length > 0) {
      const otherHand = dealRes.hands[(mySeat + 1 + randInt(rng, 3)) % 4];
      const moves = E.genMoves(otherHand, level, null);
      if (moves.length) {
        lastPlay = moves[randInt(rng, moves.length)];
        lastPlaySeat = (mySeat + 1 + randInt(rng, 3)) % 4;
      }
    }
    const state = { level: level, mySeat: mySeat, hand: hand, lastPlay: lastPlay, lastPlaySeat: lastPlaySeat, seatsRemaining: seatsRemaining };
    let sug = null;
    try { sug = A.suggest(state); } catch (err) { problems.push('t' + t + ' suggest 抛异常: ' + err.message); continue; }
    checked++;
    if (!sug || typeof sug !== 'object') { problems.push('t' + t + ' suggest 返回非对象'); continue; }
    if (sug.action !== 'play' && sug.action !== 'pass') problems.push('t' + t + ' action 非法 ' + sug.action);
    if (sug.action === 'pass' && sug.play !== null) problems.push('t' + t + ' pass 时 play 非 null');
    if (sug.action === 'play' && !sug.play) problems.push('t' + t + ' play 时 play 为 null');
    if (!Array.isArray(sug.candidates)) problems.push('t' + t + ' candidates 非数组');
    if (sug.candidates && sug.candidates.length > 12) problems.push('t' + t + ' candidates >12');
    if (!sug.handInfo || typeof sug.handInfo.count !== 'number') problems.push('t' + t + ' handInfo 缺失');
    if (typeof sug.reason !== 'string' || !sug.reason) problems.push('t' + t + ' reason 为空');
    if (sug.action === 'play') {
      if (!playLegal(sug.play, hand, level)) problems.push('t' + t + ' 建议出牌不合法: ' + JSON.stringify(sug.play && sug.play.cards));
      if (lastPlay && !E.canBeat(lastPlay, sug.play)) problems.push('t' + t + ' 建议出牌压不过上一手');
      if (!hand.length) problems.push('t' + t + ' 空手牌却出牌');
      if (lastPlaySeat !== null && lastPlaySeat === (mySeat + 2) % 4 && sug.play.cards.length !== hand.length) {
        problems.push('t' + t + ' 队友最大却未让过且非一次出完');
      }
    }
    if (sug.action === 'pass' && lastPlay && sug.candidates && sug.candidates.length > 0) {
      const allCanBeat = sug.candidates.every(function (c) { return E.canBeat(lastPlay, c.play); });
      if (!allCanBeat && sug.candidates.length) problems.push('t' + t + ' candidates 含压不过的牌');
    }
    if (sug.action === 'pass' && lastPlay) {
      const canBeatAny = A.candidates(state).length > 0;
      const isPartner = lastPlaySeat !== null && lastPlaySeat === (mySeat + 2) % 4;
      if (!canBeatAny && !isPartner) {
        // 压不过 → 正常 pass；检查 candidates 为空
        if (sug.candidates.length) problems.push('t' + t + ' 压不过但 candidates 非空');
      }
    }
    // 领出必出
    const isLead = !lastPlay || lastPlaySeat === mySeat;
    if (isLead && hand.length > 0 && sug.action !== 'play') {
      const canAny = A.candidates(state).length > 0;
      if (canAny) problems.push('t' + t + ' 领出却不主动出牌');
    }
    if (problems.length > 8) break;
  }
  ok(checked >= 195, '随机状态已检查 ' + checked + ' / 200');
  ok(problems.length === 0, '随机状态性质全部满足' + (problems.length ? '：' + problems.slice(0, 8).join('；') : ''));
}
{
  // 能一次性出完的随机构造：随机发牌 → 取某个合法候选的出牌整手作为手牌
  const rng = rngOf(777);
  let tested = 0;
  for (let t = 0; t < 80 && tested < 10; t++) {
    const level = 2 + randInt(rng, 13);
    const dealRes = E.deal(5000 + t);
    const full = dealRes.hands[randInt(rng, 4)].slice();
    const moves = E.genMoves(full, level, null);
    if (!moves.length) continue;
    const move = moves[randInt(rng, moves.length)];
    const hand = move.cards.slice();
    const whole = E.parseCards(hand, level)[0];
    if (!whole) continue;
    tested++;
    const state = { level: level, mySeat: 0, hand: hand, seatsRemaining: { 0: hand.length, 1: 20, 2: 20, 3: 20 } };
    const r = A.suggest(state);
    eq(r.action, 'play', 't' + t + ' 整手可成立时出牌');
    if (r.action === 'play') eq(r.play.cards.length, hand.length, 't' + t + ' 整手出尽');
  }
  ok(tested >= 5, '找到 ' + tested + ' 个整手成立的随机手牌用于验证');
}

// ============================================================
// E. 导出与健壮性
// ============================================================
console.log('\n== E. 导出与健壮性 ==');
['suggest', 'candidates', 'handSummary'].forEach(function (k) {
  ok(typeof A[k] === 'function', '导出函数 ' + k);
});
ok(typeof A.VERSION === 'string', '导出 VERSION');
{
  let threw = false;
  try {
    A.suggest({});
    A.suggest({ hand: 'oops', level: 'x' });
    A.candidates({ hand: [999, -1, 0], level: 5 });
    A.handSummary('nope', 5);
  } catch (err) { threw = true; }
  ok(!threw, '非法输入不抛异常');
  const r = A.suggest({ hand: 'oops', level: 'x' });
  eq([r.action, r.play], ['pass', null], '非法输入返回安全 pass');
  eq(A.handSummary('nope', 5).count, 0, 'handSummary 非法输入 count=0');
}
{
  // 各座位都可用：相对座位命名
  const hand = [S_2, S_3, S_4];
  for (let seat = 0; seat < 4; seat++) {
    const r = A.suggest({ level: 5, mySeat: seat, hand: hand, seatsRemaining: { 0: 27, 1: 27, 2: 27, 3: 27 } });
    eq(r.action, 'play', '座位 ' + seat + ' 领出可出牌');
  }
}

// ============================================================
// 汇总
// ============================================================
console.log('\n' + (failed === 0 ? '✅' : '❌') + ' gd.ai.test.js: PASS ' + passed + ' / FAIL ' + failed);
if (failed) {
  console.log('失败清单：');
  failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
}
process.exitCode = failed ? 1 : 0;
