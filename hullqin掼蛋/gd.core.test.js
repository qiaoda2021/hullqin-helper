/*!
 * 掼蛋规则引擎 gd.core.test.js —— 纯 Node 单测，禁止联网。
 * 运行：node gd.core.test.js
 */
'use strict';

const E = require('./gd.core.js');

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

function neq(actual, expected, msg) {
  return ok(JSON.stringify(actual) !== JSON.stringify(expected), msg);
}

// ---- 便捷工具 ----
function parseAs(cards, level, type) { return E.parseAs(cards, level, type); }
function best(cards, level) { return E.parseCards(cards, level)[0] || null; }
function col(plays) { return plays.map(function (p) { return p.type + ':' + p.rank; }).sort(); }
function has(plays, type, rank) {
  return plays.some(function (p) { return p.type === type && (rank === undefined || p.rank === rank); });
}
// 期望 canBeat 结果；任一 Play 缺失则记失败
function eqCan(prev, next, expected, msg) {
  if (!prev || !next) {
    ok(false, msg + '：缺少可比较的 Play（prev=' + !!prev + ', next=' + !!next + '）');
    return;
  }
  eq(E.canBeat(prev, next), expected, msg);
}

// 牌 id 常量（便于阅读）
const S_A = 1, S_2 = 2, S_3 = 3, S_4 = 4, S_5 = 5, S_6 = 6, S_7 = 7, S_8 = 8, S_9 = 9, S_10 = 10,
  S_J = 11, S_Q = 12, S_K = 13;
const H_A = 14, H_2 = 15, H_3 = 16, H_4 = 17, H_5 = 18, H_6 = 19, H_7 = 20;
const H_10 = 23, H_J = 24, H_Q = 25, H_K = 26;
const C_A = 27, C_2 = 28, C_3 = 29, C_5 = 31, C_7 = 33, C_K = 39;
const D_A = 40, D_2 = 41, D_3 = 42, D_5 = 44, D_7 = 46;
const D2_S3 = 56, D2_H3 = 69;
// 第二副牌常用
const _2_S3 = 57, _2_S7 = 61, _2_H7 = 74, _2_C7 = 87, _2_D7 = 100;
const _2_H5 = 72;

// ============================================================
// A. 基础牌面 / id 映射
// ============================================================
console.log('\n== A. 基础牌面 ==');
eq(E.cardDeck(1), 0, 'cardDeck(1)=0');
eq(E.cardDeck(54), 0, 'cardDeck(54)=0');
eq(E.cardDeck(55), 1, 'cardDeck(55)=1');
eq(E.cardDeck(108), 1, 'cardDeck(108)=1');
eq(E.cardLocal(1), 1, 'cardLocal(1)=1');
eq(E.cardLocal(54), 54, 'cardLocal(54)=54');
eq(E.cardLocal(55), 1, 'cardLocal(55)=1');
eq(E.cardLocal(108), 54, 'cardLocal(108)=54');

eq(E.cardSuit(S_A), 0, '♠A suit=0');
eq(E.cardSuit(H_A), 1, '♥A suit=1');
eq(E.cardSuit(27), 2, '♣A suit=2');
eq(E.cardSuit(D_A), 3, '♦A suit=3');
eq(E.cardSuit(53), -1, '小王 suit=-1');
eq(E.cardSuit(54), -1, '大王 suit=-1');

eq(E.cardRank(S_A), 14, '♠A rank=14');
eq(E.cardRank(S_2), 2, '♠2 rank=2');
eq(E.cardRank(S_K), 13, '♠K rank=13');
eq(E.cardRank(53), 16, '小王 rank=16');
eq(E.cardRank(54), 17, '大王 rank=17');
eq(E.isJoker(53), true, 'isJoker(53)=true');
eq(E.isJoker(52), false, 'isJoker(52)=false');

eq(E.cardText(S_A), '♠A', 'cardText(1)=♠A');
eq(E.cardText(H_A), '♥A', 'cardText(14)=♥A');
eq(E.cardText(27), '♣A', 'cardText(27)=♣A');
eq(E.cardText(53), '小王', 'cardText(53)=小王');
eq(E.cardText(54), '大王', 'cardText(54)=大王');
eq(E.cardTexts([S_A, 53, 54]), ['♠A', '小王', '大王'], 'cardTexts([1,53,54])');

eq(E.rankText(2), '2', 'rankText(2)=2');
eq(E.rankText(10), '10', 'rankText(10)=10');
eq(E.rankText(11), 'J', 'rankText(11)=J');
eq(E.rankText(12), 'Q', 'rankText(12)=Q');
eq(E.rankText(13), 'K', 'rankText(13)=K');
eq(E.rankText(14), 'A', 'rankText(14)=A');
eq(E.rankText(16), '小王', 'rankText(16)=小王');
eq(E.rankText(17), '大王', 'rankText(17)=大王');

// 逢人配 id
eq(E.heartLevelIds(5), [18, 72], 'heartLevelIds(5)=[18,72]');
eq(E.heartLevelIds(14), [14, 68], 'heartLevelIds(14)=[14,68]');
eq(E.heartLevelIds(2), [15, 69], 'heartLevelIds(2)=[15,69]');
eq(E.isWild(18, 5), true, 'isWild(18,5)=true');
eq(E.isWild(72, 5), true, 'isWild(72,5)=true');
eq(E.isWild(31, 5), false, 'isWild(♣5,5)=false');
eq(E.isWild(53, 5), false, 'isWild(小王,5)=false');
eq(E.isLevelCard(31, 5), true, 'isLevelCard(♣5,5)=true');
eq(E.isLevelCard(18, 5), true, 'isLevelCard(♥5)=true');
eq(E.isLevelCard(14, 14), true, 'isLevelCard(♥A levelA)=true');
eq(E.isWild(H_A, 14), true, 'isWild(♥A, level14)=true');

// levelOrder
eq(E.levelOrder(17, 5), 17, 'levelOrder 大王=17');
eq(E.levelOrder(16, 5), 16, 'levelOrder 小王=16');
eq(E.levelOrder(5, 5), 15, 'levelOrder 级牌5=15');
eq(E.levelOrder(14, 5), 14, 'levelOrder A=14');
eq(E.levelOrder(13, 5), 13, 'levelOrder K=13');
eq(E.levelOrder(2, 5), 2, 'levelOrder 2=2');
eq(E.levelOrder(14, 14), 15, 'levelOrder A(级牌)=15');
eq(E.levelOrder(13, 14), 13, 'levelOrder K(级牌A时)=13');

// normalCounts
const nc = E.normalCounts();
eq(nc[2], 8, 'normalCounts[2]=8');
eq(nc[14], 8, 'normalCounts[14]=8');
eq(nc[16], 2, 'normalCounts[16]=2');
eq(nc[17], 2, 'normalCounts[17]=2');
eq(Object.keys(nc).reduce(function (s, k) { return s + nc[k]; }, 0), 108, 'normalCounts 总数=108');

// sortCards：自然点数升序、王在最后
eq(E.sortCards([54, S_2, H_A, 53, S_5]), [S_2, S_5, H_A, 53, 54], 'sortCards 升序且王最后');
eq(E.sortCards([]), [], 'sortCards([])=[]');

// 非法输入
eq(E.parseAll([], 5), [], 'parseAll([])=[]');
eq(E.parseAll([0], 5), [], 'parseAll([0])=[]（越界 id）');
eq(E.parseAll([109], 5), [], 'parseAll([109])=[]（越界 id）');
eq(E.parseAll([1, 1], 5), [], 'parseAll([1,1])=[]（重复 id）');
eq(E.genMoves([1, 1], 5, null), [], 'genMoves 重复 id 返回 []');
eq(E.parseCards([], 5), [], 'parseCards([])=[]');

// ============================================================
// B. 牌型解析
// ============================================================
console.log('\n== B. 牌型解析 ==');
{
  const ps = E.parseCards([S_A], 5);
  eq(ps.length, 1, '单张：1 种解读');
  eq([ps[0].type, ps[0].rank, ps[0].size, ps[0].bomb], ['single', 14, 1, 0], '单张 ♠A');
  ok(typeof ps[0].desc === 'string' && ps[0].desc.indexOf('单张') >= 0, '单张 desc 含「单张」');
  eq(E.playText(ps[0]), ps[0].desc, 'playText = desc');
}
{
  const wildSingle = E.parseCards([H_5], 5);
  eq(col(wildSingle), ['single:5'], '单出♥5只算级牌单张（不是 A/王）');
}
{
  const pairA = E.parseCards([S_A, H_A], 5);
  eq(col(pairA), ['pair:14'], '对子 ♠A♥A = pair A');
  eq(col(E.parseCards([53, 107], 5)), ['pair:16'], '两张小王=对子小王');
  eq(col(E.parseCards([54, 108], 5)), ['pair:17'], '两张大王=对子大王');
  eq(E.parseCards([53, 54], 5), [], '一小王一大王不能成对');
  eq(col(E.parseCards([H_5, _2_H5], 5)), ['pair:5'], '两张♥5=级牌对子（rank5）');
}
{
  eq(col(E.parseCards([S_A, H_A, 27], 5)), ['triple:14'], '三同张 AAA');
  eq(col(E.parseCards([H_5, S_2, H_2], 5)), ['triple:2'], '♥5+♠2+♥2=三张2（级牌5）');
  eq(col(E.parseCards([H_5, _2_H5, S_5], 5)), ['triple:5'], '♥5♥5♠5=三张级牌5');
}
{
  eq(col(E.parseCards([S_K, C_K, 26, S_2, H_2], 9)), ['fullhouse:13'], '三带二 KKK+22 = fullhouse K');
  eq(col(E.parseCards([S_K, C_K, 26, 53, 107], 9)), ['fullhouse:13'], '三带二 KKK+小王对');
  eq(E.parseCards([S_A, H_A, 27, S_2], 9), [], '三带一（4张）不合法');
  eq(E.parseCards([S_K, C_K, 26, 53, 54], 9), [], '一大一小王不能当对子');
  eq(col(E.parseCards([S_7, H_7, C_7, H_5, _2_H5], 5)), ['bomb:7', 'fullhouse:7'], '777+两张♥5 = 炸弹7 或 三带二7');
}
{
  // 顺子（混花色，避免同花顺）
  const straightMix = E.parseCards([S_A, H_2, S_3, H_4, S_5], 9);
  ok(straightMix.some(function (p) { return p.type === 'straight' && p.rank === 5; }), 'A2345 混花色 = 顺子 rank5');
  ok(!straightMix.some(function (p) { return p.type === 'straightflush'; }), 'A2345 混花色不是同花顺');
  ok(has(E.parseCards([S_2, S_3, S_4, S_5, S_6], 9), 'straight', 6), '23456 = 顺子 rank6');
  const qka23 = E.parseCards([S_Q, S_K, H_A, S_2, S_3], 7);
  eq(qka23, [], 'QKA23 不合法');
  const bigStraight = E.parseCards([S_10, S_J, S_Q, S_K, S_A], 5);
  ok(has(bigStraight, 'straight', 14), '10JQKA = 顺子 rank14');
  ok(has(bigStraight, 'straightflush', 14), '10JQKA 同花 = 同花顺 rank14');
  // 级牌参与连牌
  const levelSeq = E.parseCards([S_A, H_2, S_3, H_4, H_5], 5);
  ok(has(levelSeq, 'straight', 5), '♥5（级牌）参与 A2345 顺子');
}
{
  // 顺子 rank = 窗口顶位
  eq(has(E.parseCards([S_A, H_2, S_3, H_4, S_5], 9), 'straight', 5), true, 'A2345 的 rank=5');
  eq(E.canBeat(E.parseAs([S_A, H_2, S_3, H_4, S_5], 9, 'straight'),
    E.parseAs([S_2, H_3, S_4, H_5, S_6], 9, 'straight')), true, '23456 压 A2345');
}
{
  // 三连对
  eq(col(E.parseCards([S_A, H_A, S_2, H_2, S_3, H_3], 9)), ['tube:3'], 'AA2233 = 三连对 rank3');
  eq(col(E.parseCards([S_Q, H_Q, S_K, H_K, S_A, H_A], 9)), ['tube:14'], 'QQKKAA = 三连对 rank14');
  eq(E.parseCards([S_2, H_2, S_A, H_A, S_K, H_K], 9), [], '22AAKK 不连续，不合法');
  ok(has(E.parseCards([H_5, _2_H5, S_6, H_6, S_7, H_7], 5), 'tube', 7), '两张♥5补 567 三连对 = rank7');
}
{
  // 钢板
  eq(col(E.parseCards([S_A, H_A, 27, S_2, H_2, C_2], 9)), ['plate:2'], 'AAA222 = 钢板 rank2');
  eq(col(E.parseCards([S_K, H_K, C_K, S_A, H_A, 27], 9)), ['plate:14'], 'KKKAAA = 钢板 rank14');
  eq(col(E.parseCards([S_2, H_2, C_2, S_3, H_3, 29], 9)), ['plate:3'], '222333 = 钢板 rank3');
  eq(E.parseCards([S_2, H_2, C_2, S_4, H_4, 30], 9), [], '222444 不连续，不合法');
}
{
  // 炸弹
  const b4 = E.parseCards([S_3, H_3, C_3, D_3], 5);
  eq([b4.length, b4[0].type, b4[0].rank, b4[0].size, b4[0].bomb], [1, 'bomb', 3, 4, 4], '4张3=炸弹 rank3 bomb4');
  const b5 = E.parseCards([S_7, H_7, C_7, D_7, _2_S7], 5);
  eq([b5[0].type, b5[0].size, b5[0].bomb], ['bomb', 5, 5], '5张7=炸弹 size5 bomb5');
  const b6 = E.parseCards([S_7, H_7, C_7, D_7, _2_S7, _2_H7], 5);
  eq([b6[0].size, b6[0].bomb], [6, 6], '6张7=炸弹 size6 bomb6');
  const b10 = E.parseCards([S_7, H_7, C_7, D_7, _2_S7, _2_H7, _2_C7, _2_D7, H_5, _2_H5], 5);
  eq([b10[0].type, b10[0].size, b10[0].bomb], ['bomb', 10, 10], '8张7+两张♥5=10张炸弹 bomb10');
  const wildBomb = E.parseCards([S_3, H_3, H_5, _2_H5], 5);
  eq([wildBomb[0].type, wildBomb[0].rank, wildBomb[0].size], ['bomb', 3, 4], '33+两张♥5=3333 炸弹');
  eq(E.parseCards([S_3, H_3, C_3, H_5, _2_H5], 5).some(function (p) {
    return p.type === 'bomb' && p.rank === 3 && p.size === 5;
  }), true, '333+两张♥5=5张炸弹3');
}
{
  // 同花顺
  const sf = E.parseCards([S_6, S_7, S_8, S_9, S_10], 5);
  eq([sf[0].type, sf[0].rank, sf[0].bomb], ['straightflush', 10, 5.5], '♠6-10 = 同花顺 rank10 bomb5.5');
  ok(has(sf, 'straight', 10), '同花顺也可解读为顺子');
  const sfWild = E.parseCards([S_6, S_7, S_8, S_9, H_5], 5); // ♥5 配 ♠10 → 最大
  ok(has(sfWild, 'straightflush', 10), '♥5补同花顺取最大 rank10');
  eq(E.parseCards([S_6, H_7, S_8, S_9, S_10], 5).some(function (p) {
    return p.type === 'straightflush';
  }), false, '不同花色的 5 连不是同花顺');
}
{
  // 四大天王
  const jb = E.parseCards([53, 54, 107, 108], 5);
  eq([jb.length, jb[0].type, jb[0].bomb, jb[0].order], [1, 'jokerbomb', 99, 0], '四大天王 bomb99 order0');
  eq(E.parseCards([53, 107, 54, 107], 5), [], '重复牌不能组成四大天王');
  eq(E.parseCards([53, 54, 107, S_A], 5), [], '3王+1普通牌不合法');
}
{
  // 逢人配默认取最大解读
  const maxed = E.parseCards([H_5, S_6, S_7, S_8, S_9], 5);
  ok(has(maxed, 'straightflush', 10), '♥5+♠6-9 默认配成 6-10 同花顺（最大）');
  const all = E.parseAll([H_5, S_6, S_7, S_8, S_9], 5);
  ok(all.length >= 2, 'parseAll 返回多种解读');
  ok(all.some(function (p) { return p.type === 'straightflush' && p.rank === 9; }), 'parseAll 含 5-9 同花顺解读');
  ok(all.every(function (p) { return p.wilds && p.wilds.length <= 1; }), 'parseAll 的 wilds 使用数不超过 1');
}

// ============================================================
// C. 大小比较 canBeat / comparePlays
// ============================================================
console.log('\n== C. 大小比较 ==');
{
  const s2 = best([S_2], 9), s3 = best([S_3], 9), sa = best([S_A], 9), lv5 = best([C_5], 5);
  eqCan(s2, s3, true, '单张3压单张2');
  eqCan(s3, s2, false, '单张2不能压单张3');
  eqCan(sa, lv5, true, '单张级牌5压单张A');
  eqCan(lv5, sa, false, '单张A不能压级牌5');
  eqCan(best([53], 9), best([54], 9), true, '大王压小王');
  eqCan(best([54], 9), best([53], 9), false, '小王不能压大王');
  eqCan(s2, s3, true, '领出上一手为 null 时 canBeat 视为可出');
  eq(E.canBeat(null, s3), true, 'canBeat(null, play)=true');
  eq(E.canBeat(s3, null), false, 'canBeat(play, null)=false');
}
{
  const pair2 = best([S_2, H_2], 9), pair3 = best([S_3, H_3], 9);
  eqCan(pair2, pair3, true, '对子3压对子2');
  eqCan(pair3, pair2, false, '对子2不能压对子3');
  eqCan(best([S_A], 9), pair3, false, '不同牌型不能压');
  eqCan(best([S_2, H_2], 9), best([S_3, H_3, C_3], 9), false, '对子不能压三同张');
}
{
  // 炸弹体系
  const b4A = best([S_A, H_A, C_A, D_A], 9);
  const b4_2 = best([S_2, H_2, C_2, D_2], 9);
  const b5 = best([S_7, H_7, C_7, D_7, _2_S7], 9);
  const b6 = best([S_7, H_7, C_7, D_7, _2_S7, _2_H7], 9);
  const sf = best([S_6, S_7, S_8, S_9, S_10], 9);
  const jb = best([53, 54, 107, 108], 9);
  const straight = best([S_2, H_3, S_4, H_5, S_6], 9);
  eqCan(b4A, b4_2, false, '4炸2不能压4炸A');
  eqCan(b4_2, b4A, true, '4炸A压4炸2');
  eqCan(b4A, b5, true, '5炸压4炸（与点数无关）');
  eqCan(b5, sf, true, '同花顺压5炸');
  eqCan(sf, b5, false, '5炸不能压同花顺');
  eqCan(sf, b6, true, '6炸压同花顺');
  eqCan(b6, sf, false, '同花顺不能压6炸');
  eqCan(b6, jb, true, '四大天王压6炸');
  eqCan(jb, b6, false, '6炸不能压四大天王');
  eqCan(jb, jb, false, '四大天王同型不可互压');
  eqCan(b4_2, straight, false, '普通牌不能压炸弹');
  eqCan(straight, b4_2, true, '炸弹压普通牌');
  // 级牌炸弹在 4 炸里最大
  const lvBomb = best([S_5, C_5, D_5, H_5], 5); // ♥5 是逢人配，仍可作 5555
  eqCan(b4A, lvBomb, true, '级牌4炸压A的4炸');
  eqCan(lvBomb, b4A, false, 'A的4炸不能压级牌4炸');
}
{
  // 非炸弹比大小
  eqCan(best([S_A, H_A, S_2, H_2, S_3, H_3], 9), best([S_Q, H_Q, S_K, H_K, S_A, H_A], 9), true, 'QQKKAA 压 AA2233');
  eqCan(best([S_A, H_2, S_3, H_4, S_5], 9), best([S_2, H_3, S_4, H_5, S_6], 9), true, '23456 压 A2345');
  eqCan(best([S_2, H_3, S_4, H_5, S_6], 9), best([S_10, S_J, S_Q, S_K, S_A], 9), true, '10JQKA 压 23456');
}
{
  // 三带二只比三张
  const fhK = best([S_K, C_K, 26, S_2, H_2], 9);
  const fhA = best([S_A, C_A, H_A, S_3, H_3], 9);
  eqCan(fhK, fhA, true, '三带二：AAA+33 压 KKK+22（只比三张）');
  eqCan(fhA, fhK, false, '三带二：KKK+22 不能压 AAA+33');
}
{
  // comparePlays
  const s2 = best([S_2], 9), s3 = best([S_3], 9);
  ok(E.comparePlays(s3, s2) > 0, 'comparePlays(3,2) > 0');
  ok(E.comparePlays(s2, s3) < 0, 'comparePlays(2,3) < 0');
  eq(E.comparePlays(s2, s2), 0, 'comparePlays 同牌=0');
  eq(E.comparePlays(null, s2), -1, 'comparePlays(null, play) = -1');
  eq(E.comparePlays(s2, null), 1, 'comparePlays(play, null) = 1');
  const b4 = best([S_2, H_2, C_2, D_2], 9), b5 = best([S_3, H_3, C_3, D_3, _2_S3], 9);
  ok(E.comparePlays(b5, b4) > 0, 'comparePlays(5炸, 4炸) > 0');
}

// ============================================================
// D. genMoves 合法出牌
// ============================================================
console.log('\n== D. genMoves ==');
function assertMovesValid(moves, hand, level, msg) {
  const handSet = new Set(hand);
  let bad = null;
  for (let i = 0; i < moves.length; i++) {
    const p = moves[i];
    if (!p || !Array.isArray(p.cards) || !p.cards.length) { bad = '空 Play'; break; }
    if (new Set(p.cards).size !== p.cards.length) { bad = '重复牌 ' + p.desc; break; }
    for (let k = 0; k < p.cards.length; k++) {
      if (!handSet.has(p.cards[k])) { bad = '牌不在手牌中 ' + p.desc; break; }
    }
    if (bad) break;
    if (p.size !== p.cards.length) { bad = 'size 不一致 ' + p.desc; break; }
    const re = E.parseAs(p.cards, level, p.type, p.type === 'jokerbomb' ? undefined : p.rank);
    if (!re) { bad = 'parseAs 无法复现 ' + p.desc; break; }
  }
  ok(!bad, msg + (bad ? '：' + bad : ''));
}

{
  const hand = [S_K, C_K, 26, S_2, H_2, S_A, H_A, 53, 107, S_3, H_3];
  const moves = E.genMoves(hand, 9, null);
  ok(moves.length >= 12, '手牌(K K K,22,AA,小王小王,33)领出候选数 >= 12（实际 ' + moves.length + '）');
  const keys = moves.map(function (p) { return p.type + ':' + p.rank; });
  eq(new Set(keys).size, keys.length, 'genMoves 候选 key 无重复');
  ['single:13', 'pair:2', 'pair:13', 'pair:14', 'pair:16', 'triple:13', 'fullhouse:13', 'tube:3'].forEach(function (k) {
    ok(keys.indexOf(k) >= 0, 'genMoves 领出包含 ' + k);
  });
  assertMovesValid(moves, hand, 9, 'genMoves 领出候选全部合法且来自手牌');
}
{
  // 跟牌：上一手对 A
  const hand = [S_K, C_K, 26, S_A, H_A, 53, 107, S_2, H_2];
  const prev = E.parseAs([S_A, H_A], 9, 'pair');
  const moves = E.genMoves(hand, 9, prev);
  ok(moves.length > 0, '跟对 A 时有候选');
  ok(moves.every(function (p) { return E.canBeat(prev, p); }), '跟牌候选全部能压对 A');
  ok(moves.some(function (p) { return p.type === 'pair' && p.rank === 16; }), '跟对 A 出现对小王');
  assertMovesValid(moves, hand, 9, 'genMoves 跟牌候选合法');
}
{
  // 跟牌：上一手顺子 rank5，只能更高顺子/炸弹
  const hand = [S_2, H_3, S_4, H_5, S_6, S_10, S_J, S_Q, S_K, S_A];
  const prev = E.parseAs([S_A, H_2, S_3, H_4, S_5], 9, 'straight');
  const moves = E.genMoves(hand, 9, prev);
  assertMovesValid(moves, hand, 9, 'genMoves 跟顺子候选合法');
  ok(moves.every(function (p) { return E.canBeat(prev, p); }), '跟顺子候选全部能压 rank5 顺子');
  ok(!moves.some(function (p) { return p.type === 'straight' && p.rank <= 5; }), '跟顺子不生成更小顺子');
  ok(moves.some(function (p) { return p.type === 'straight'; }), '跟顺子生成更大顺子');
}
{
  // 压不过：手牌只有小单张，上一手是 A
  const moves = E.genMoves([S_3, H_4], 9, E.parseAs([S_A], 9, 'single'));
  eq(moves, [], '压不过上一手时 genMoves 返回 []（无强制出牌）');
}
{
  // 炸弹/同花顺/天王炸生成
  const hand = [S_7, H_7, C_7, D_7, _2_S7, H_5, _2_H5, 53, 54, 107, 108, S_6, S_8, S_9, S_10];
  const moves = E.genMoves(hand, 5, null);
  ok(moves.some(function (p) { return p.type === 'bomb' && p.size === 4; }), 'genMoves 生成 4 张炸弹');
  ok(moves.some(function (p) { return p.type === 'bomb' && p.size >= 5; }), 'genMoves 生成 5 张以上炸弹（含逢人配）');
  ok(moves.some(function (p) { return p.type === 'straightflush'; }), 'genMoves 生成同花顺 ♠6-10');
  ok(moves.some(function (p) { return p.type === 'jokerbomb'; }), 'genMoves 生成四大天王');
  assertMovesValid(moves, hand, 5, 'genMoves 炸弹类候选合法');
  const noBomb = E.genMoves(hand, 5, null, { includeBombs: false });
  ok(noBomb.every(function (p) { return !(p.bomb > 0); }), 'includeBombs:false 时不生成炸弹');
  const limited = E.genMoves(hand, 5, null, { limit: 5 });
  ok(limited.length <= 5, 'opts.limit 生效');
}
{
  // 领出优先减少手数（弱断言：手牌可直接出尽时包含整手牌型）
  const hand = [S_7, H_7, C_7, D_7];
  const moves = E.genMoves(hand, 5, null);
  ok(moves.some(function (p) { return p.type === 'bomb' && p.size === 4; }), '4 张同点手牌可直接出炸弹');
  const pairHand = [S_3, H_3];
  const pairMoves = E.genMoves(pairHand, 5, null);
  ok(pairMoves.some(function (p) { return p.type === 'pair'; }), '对子手牌生成对子');
  ok(pairMoves.some(function (p) { return p.type === 'bomb'; }) === false, '2 张手牌不生成炸弹');
}

// ============================================================
// E. 记牌器 counter
// ============================================================
console.log('\n== E. 记牌器 ==');
{
  const c = E.counter({ level: 5, myHand: [], played: [] });
  eq(c.total, 108, 'counter 总数 108');
  eq(c.unknown, 108, '空局未知 108');
  eq(c.mineCount, 0, '空局我手 0');
  eq(c.playedCount, 0, '空局已出 0');
  eq(c.byRank.length, 15, 'byRank 15 个点数');
  eq(c.byRank[0].rank, 2, 'byRank 第一个是 2');
  eq(c.byRank[c.byRank.length - 1].rank, 17, 'byRank 最后是 17（大王）');
  const r2 = c.byRank[0];
  eq([r2.total, r2.played, r2.mine, r2.remaining], [8, 0, 0, 8], '2 的统计 8/0/0/8');
  eq(r2.isLevel, false, '级牌不是 2');
  const r5 = c.byRank.filter(function (r) { return r.rank === 5; })[0];
  eq([r5.isLevel, r5.isWild], [true, true], '级牌 5 标记 isLevel/isWild');
  const jokerR = c.byRank.filter(function (r) { return r.rank === 16; })[0];
  eq([jokerR.total, jokerR.remaining, jokerR.isLevel], [2, 2, false], '小王统计');
  eq(c.wildRemaining, 2, '逢人配初始 2');
  eq(c.ok, true, '空局 ok=true');
}
{
  const dealRes = E.deal(12345);
  const myHand = dealRes.hands[0];
  const c = E.counter({ level: 7, myHand: myHand, played: [] });
  eq(c.mineCount, 27, '我手 27 张');
  eq(c.unknown, 81, '未知 81 张');
  const wildsInHand = myHand.filter(function (id) { return E.isWild(id, 7); }).length;
  eq(c.wildRemaining, 2 - wildsInHand, 'wildRemaining=2−我手红桃级牌数');
}
{
  const c = E.counter({ level: 5, myHand: [], played: [18] });
  eq(c.wildRemaining, 1, '已出 1 张♥5 后逢人配剩 1');
  eq(c.playedCount, 1, '已出 1');
  eq(c.unknown, 107, '未知 107');
  const r5 = c.byRank.filter(function (r) { return r.rank === 5; })[0];
  eq([r5.played, r5.remaining], [1, 7], '5 已出 1、剩 7');
}
{
  const c = E.counter({ level: 5, myHand: [S_A], played: [S_A] });
  eq(c.ok, false, '同一张牌同时在我手与已出 → ok=false');
  ok(c.warnings.length > 0, '同一张牌同时在我手与已出 → warnings 非空');
}
{
  const twoIds = [S_2, H_2, C_2, D_2, D2_S3, D2_H3, 82, 95]; // 8 张 2
  const c = E.counter({ level: 5, myHand: twoIds, played: [2] });
  eq(c.mineCount, 8, '8 张 2 全在我手');
  ok(c.warnings.some(function (w) { return w.indexOf('2') >= 0; }), '张数超上限时 warnings 提示点数为 2');
  eq(c.byRank.filter(function (r) { return r.rank === 2; })[0].remaining, 0, '超上限时 remaining 不为负');
}

// ============================================================
// F. 发牌 / 随机数
// ============================================================
console.log('\n== F. 发牌 ==');
{
  const r1 = E.createRng(42), r2 = E.createRng(42);
  const seq1 = [r1(), r1(), r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2(), r2(), r2()];
  eq(seq1, seq2, 'createRng(42) 两次序列一致');
  ok(seq1.every(function (v) { return v >= 0 && v < 1; }), 'createRng 输出在 [0,1)');
  const r3 = E.createRng(43);
  neq(r3(), seq1[0], '不同 seed 随机序列不同');
}
{
  const d1 = E.deal(777);
  eq(d1.hands.length, 4, 'deal 返回 4 手牌');
  d1.hands.forEach(function (h, i) { eq(h.length, 27, 'deal 第 ' + i + ' 手 27 张'); });
  const flat = [].concat.apply([], d1.hands).slice().sort(function (a, b) { return a - b; });
  eq(flat.length, 108, '发牌总张数 108');
  eq(flat[0], 1, '发牌包含 id 1');
  eq(flat[107], 108, '发牌包含 id 108');
  eq(new Set(flat).size, 108, '发牌无重复');
  const d2 = E.deal(777);
  eq(d2.hands, d1.hands, '同 seed 发牌结果一致');
  const d3 = E.deal(778);
  neq(d3.hands, d1.hands, '不同 seed 发牌结果不同');
  const d4 = E.deal();
  eq(d4.hands.length, 4, '无 seed 发牌 4 手');
  ok(Number.isInteger(d4.seed) && d4.seed >= 0, '无 seed 时返回整数 seed');
}

// ============================================================
// G. 导出完整性
// ============================================================
console.log('\n== G. 导出 API ==');
[
  'cardDeck', 'cardLocal', 'cardSuit', 'cardRank', 'cardText', 'cardTexts', 'isJoker',
  'isLevelCard', 'isWild', 'heartLevelIds', 'levelOrder', 'normalCounts', 'sortCards',
  'rankText', 'parseCards', 'parseAll', 'parseAs', 'canBeat', 'comparePlays', 'playText',
  'genMoves', 'counter', 'createRng', 'deal'
].forEach(function (k) {
  ok(typeof E[k] === 'function', '导出函数 ' + k);
});
eq(E.JOKER_SMALL, 16, 'JOKER_SMALL=16');
eq(E.JOKER_BIG, 17, 'JOKER_BIG=17');
eq(E.VERSION, '1.0.0', 'VERSION=1.0.0');
eq(Array.isArray(E.RANK_SEQ) ? E.RANK_SEQ.length : 0, 15, 'RANK_SEQ 15 个点数');

// ============================================================
// 汇总
// ============================================================
console.log('\n' + (failed === 0 ? '✅' : '❌') + ' gd.core.test.js: PASS ' + passed + ' / FAIL ' + failed);
if (failed) {
  console.log('失败清单：');
  failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
}
process.exitCode = failed ? 1 : 0;
