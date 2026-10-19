// 掼蛋油猴版 · 站点规则引擎单测（gd.site.core.js）
// 直接运行：node gd.site.core.test.js（禁止联网）
'use strict';
const G = require('./gd.site.core.js');

let pass = 0, fail = 0;
const failures = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(name + '\n    got     ' + a + '\n    expected ' + e); }
}
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; failures.push(name); }
}

/* ============================ 1. 牌模型 ============================ */
eq('normLevel 9', G.normLevel(9), 9);
eq('normLevel clamp 1→2', G.normLevel(1), 2);
eq('normLevel clamp 15→14', G.normLevel(15), 14);
eq('normalizeId 55→1', G.normalizeId(55), 1);
eq('normalizeId 108→54', G.normalizeId(108), 54);
eq('cardDeck 55→1', G.cardDeck(55), 1);
eq('rankOf 1=A', G.rankOf(1), 14);
eq('rankOf 2', G.rankOf(2), 2);
eq('rankOf 13=K', G.rankOf(13), 13);
eq('rankOf 14=A', G.rankOf(14), 14);
eq('rankOf 27=♥A', G.rankOf(27), 14);
eq('rankOf 53=大王', G.rankOf(53), 17);
eq('rankOf 54=小王', G.rankOf(54), 16);
eq('suitOf 1=♦', G.suitOf(1), 0);
eq('suitOf 14=♣', G.suitOf(14), 1);
eq('suitOf 27=♥', G.suitOf(27), 2);
eq('suitOf 40=♠', G.suitOf(40), 3);
eq('suitOf 53=-1', G.suitOf(53), -1);
eq('cardText 1', G.cardText(1), '♦A');
eq('cardText 27', G.cardText(27), '♥A');
eq('cardText 53', G.cardText(53), '大王');
eq('cardText 54', G.cardText(54), '小王');
eq('cardTexts', G.cardTexts([53, 1]), ['大王', '♦A']);
eq('isJoker 53', G.isJoker(53), true);
eq('isJoker 52', G.isJoker(52), false);
eq('heartLevelId(9)', G.heartLevelId(9), 35);
eq('heartLevelId(14)', G.heartLevelId(14), 27);
eq('heartLevelId(2)', G.heartLevelId(2), 28);
eq('isWildCard lv9 ♥9', G.isWildCard(35, 9), true);
eq('isWildCard lv9 ♥9 deck2', G.isWildCard(89, 9), true);
eq('isWildCard lv9 ♠9', G.isWildCard(37, 9), false);
eq('isWildCard lv9 ♥8', G.isWildCard(34, 9), false);
eq('levelOrder lv9 级牌9', G.levelOrder(9, 9), 15);
eq('levelOrder lv9 A', G.levelOrder(14, 9), 14);
eq('levelOrder lv9 小王', G.levelOrder(16, 9), 16);
eq('levelOrder lv9 大王', G.levelOrder(17, 9), 17);
eq('levelOrder lv14 A', G.levelOrder(14, 14), 15);
eq('partnerOf 1', G.partnerOf(1), 3);
eq('partnerOf 2', G.partnerOf(2), 4);
eq('partnerOf 4', G.partnerOf(4), 2);
eq('sameTeam 1,3', G.sameTeam(1, 3), true);
eq('sameTeam 1,2', G.sameTeam(1, 2), false);
eq('rankText 14', G.rankText(14), 'A');
eq('rankText 17', G.rankText(17), '大王');
eq('CARD.TOTAL', G.CARD.TOTAL, 108);
eq('CARD.DECKS', G.CARD.DECKS, 2);
eq('TYPE 枚举', [G.TYPE.Single, G.TYPE.Pair, G.TYPE.Steel, G.TYPE.StraightFlush, G.TYPE.FourJokers], [1, 2, 5, 102, 127]);
eq('tributeRoles 双下', G.tributeRoles([1, 3, 2, 4]), { tributers: [2, 4], receivers: [1, 3] });
eq('tributeRoles 单贡', G.tributeRoles([1, 2, 3, 4]), { tributers: [4], receivers: [1] });
eq('tributeRoles 不足 4 人', G.tributeRoles([1, 2]), { tributers: [], receivers: [] });

/* ============================ 2. 牌型解释（级牌 9） ============================ */
const P = {};
(function () {
  for (let suit = 0; suit < 4; suit++) for (let r = 1; r <= 13; r++) P[suit + '-' + r] = suit * 13 + r;
})();
const d = (r) => P['0-' + r], c = (r) => P['1-' + r], h = (r) => P['2-' + r], s = (r) => P['3-' + r];
const BIG = 53, BIG2 = 107, SMALL = 54, SMALL2 = 108;
const W1 = 35, W1b = 89; // ♥9 ×2（级牌 9 的逢人配）
const LVL = 9;
const IV = G.interpretCodes;
const codes = (cards, level) => IV(cards, level || LVL);
const C = (t, r) => (t << 8) | r;
const T = G.TYPE;

eq('单张 A', codes([d(1)]), [C(1, 14)]);
eq('单张 级牌9', codes([d(9)]), [C(1, 15)]);
eq('对子 AA', codes([d(1), c(1)]), [C(2, 14)]);
eq('对子 级牌9', codes([d(9), h(9)]), [C(2, 15)]);
eq('大小王不是对子', codes([BIG, SMALL]), []);
eq('对子 小王小王', codes([SMALL, SMALL2]), [C(2, 16)]);
eq('对子 大王大王', codes([BIG, BIG2]), [C(2, 17)]);
eq('对子 双逢人配', codes([W1, W1b]), [C(2, 15)]);
eq('三同张 AAA', codes([d(1), c(1), h(1)]), [C(3, 14)]);
eq('三同张 9+逢人配', codes([d(9), s(9), W1]), [C(3, 15)]);
eq('三带二 AAA+22', codes([d(1), c(1), h(1), d(2), c(2)]), [C(4, 14)]);
eq('三带二 KKK+双逢人配 → 只能作 5 炸', codes([d(13), c(13), h(13), W1, W1b]), [C(T.Five, 13)]);
eq('钢板 AAA222', codes([d(1), c(1), h(1), d(2), c(2), h(2)]), [C(5, 2)]);
eq('钢板 333444', codes([d(3), c(3), h(3), d(4), c(4), h(4)]), [C(5, 4)]);
eq('钢板 KKKAAA', codes([d(13), c(13), h(13), d(1), c(1), h(1)]), [C(5, 14)]);
eq('钢板 222334 非法', codes([d(2), c(2), h(2), d(3), c(3), d(4)]), []);
eq('三连对 AA2233', codes([d(1), c(1), d(2), c(2), d(3), c(3)]), [C(6, 3)]);
eq('三连对 QQKKAA', codes([d(12), c(12), d(13), c(13), d(1), c(1)]), [C(6, 14)]);
eq('三连对 22AAKK 非法', codes([d(2), c(2), d(1), c(1), d(13), c(13)]), []);
eq('顺子 2-6', codes([d(2), c(3), h(4), s(5), d(6)]), [C(7, 6)]);
eq('顺子 A2345', codes([d(1), c(2), h(3), s(4), d(5)]), [C(7, 5)]);
eq('顺子 10JQKA', codes([d(10), c(11), h(12), s(13), d(1)]), [C(7, 14)]);
eq('顺子 QKA23 非法', codes([d(12), c(13), h(1), s(2), d(3)]), []);
eq('同花顺 2-6', codes([d(2), d(3), d(4), d(5), d(6)]), [C(7, 6), C(102, 6)]);
eq('同花顺 A2345', codes([d(1), d(2), d(3), d(4), d(5)]), [C(7, 5), C(102, 5)]);
eq('同花顺 10JQKA', codes([d(10), d(11), d(12), d(13), d(1)]), [C(7, 14), C(102, 14)]);
eq('炸弹 4 张 2', codes([d(2), c(2), h(2), s(2)]), [C(T.Four, 2)]);
eq('炸弹 5 张 9（含级牌）', codes([d(9), c(9), h(9), s(9), W1]), [C(T.Five, 15)]);
eq('炸弹 6 张 2（含逢人配）', codes([P['0-2'], P['1-2'], P['2-2'], P['3-2'], W1, W1b]), [C(T.Six, 2)]);
eq('四大天王', codes([BIG, BIG2, SMALL, SMALL2]), [C(T.FourJokers, 0)]);
eq('逢人配补顺子：可补 5-9 或 6-10', codes([d(6), c(7), h(8), s(9), W1]), [C(7, 9), C(7, 10)]);
eq('逢人配补同花顺：可补 ♦5-9 或 ♦6-10', codes([d(6), d(7), d(8), d(9), W1]), [C(7, 9), C(7, 10), C(102, 9), C(102, 10)]);
eq('逢人配 2 张补顺子 6,7,8', codes([d(6), c(7), s(8), W1, W1b]), [C(7, 8), C(7, 9), C(7, 10)]);
eq('5 张不搭', codes([d(1), c(2), h(3), s(4), d(6)]), []);
eq('6 张不搭', codes([d(1), c(2), h(3), s(4), d(5), d(7)]), []);

/* ============================ 3. 压牌 / 炸弹链 ============================ */
ok('顺子6 压 顺子5', G.beats(C(7, 6), C(7, 5)));
ok('同点不能互压', !G.beats(C(7, 6), C(7, 6)));
ok('炸弹压单张', G.beats(C(T.Four, 2), C(1, 14)));
ok('5炸压4炸', G.beats(C(T.Five, 2), C(T.Four, 14)));
ok('同花顺压5炸', G.beats(C(102, 14), C(T.Five, 14)));
ok('6炸压同花顺', G.beats(C(T.Six, 2), C(102, 14)));
ok('8炸压同花顺', G.beats(C(T.Eight, 2), C(102, 14)));
ok('四大天王压8炸', G.beats(C(T.FourJokers, 0), C(T.Eight, 14)));
ok('四大天王不能互压', !G.beats(C(T.FourJokers, 0), C(T.FourJokers, 0)));
ok('单张不能压对子', !G.beats(C(1, 14), C(2, 2)));
ok('小炸不能压大炸', !G.beats(C(T.Four, 14), C(T.Five, 2)));
eq('bestCode 无 prev 取最大', G.bestCode([d(1), d(2), d(3), d(4), d(5)], 0, LVL), C(102, 5));
eq('bestCode 压顺子', G.bestCode([d(2), c(3), h(4), s(5), d(6)], C(7, 5), LVL), C(7, 6));
eq('bestCode 压不过', G.bestCode([d(1), c(2), h(3), s(4), d(6)], C(7, 5), LVL), 0);
eq('typeName 同花顺', G.typeName(C(102, 5)), '同花顺');
eq('typeName 炸弹4张', G.typeName(C(T.Four, 2)), '炸弹4张');
eq('bombValue 同花顺', G.bombValue(C(102, 5)), 5.5);
eq('bombValue 四王', G.bombValue(C(T.FourJokers, 0)), 99);
eq('bombValue 普通牌', G.bombValue(C(7, 6)), 0);

/* ============================ 4. playFromCards ============================ */
const p = G.playFromCards([d(2), c(3), h(4), s(5), d(6)], LVL);
ok('playFromCards 非空', !!p);
eq('playFromCards name', p.name, '顺子');
eq('playFromCards code', p.code, C(7, 6));
eq('playFromCards size', p.size, 5);
eq('playFromCards rank', p.rank, 6);
eq('playFromCards level', p.level, LVL);
eq('playFromCards cards 集合一致', p.cards.slice().sort((a, b) => a - b), [d(2), c(3), h(4), s(5), d(6)].slice().sort((a, b) => a - b));
const sf = G.playFromCards([d(1), d(2), d(3), d(4), d(5)], LVL);
eq('playFromCards 同花顺默认', sf.code, C(102, 5));
const sfAsStraight = G.playFromCards([d(1), d(2), d(3), d(4), d(5)], LVL, C(7, 5));
ok('playFromCards 同花顺可按顺子出', !!sfAsStraight && sfAsStraight.type === 7);
eq('playFromCards 对子指定单张 → null', G.playFromCards([d(9), c(9)], LVL, C(1, 9)), null);
eq('playFromCards 三张指定对子 → null', G.playFromCards([d(9), c(9), h(9)], LVL, C(2, 9)), null);
eq('playFromCards 空数组 → null', G.playFromCards([], LVL), null);
eq('playFromCards 非法牌型 → null', G.playFromCards([d(1), c(2), h(4), s(7)], LVL), null);

/* ============================ 5. protobuf 编解码 ============================ */
const raw = {
  rule: 2, state: 1, landlordId: 0, cardPositionList: [], playedCardList: [0, 5], v: 3,
  team13Level: 2, team24Level: 5, lastRankList: [1, 3, 2, 4], tributeCardList: [0, 0],
  returnCardList: [], firstPlayer: 1, playedTypeList: [0]
};
const enc = G.encodeGameData(raw);
ok('encode 返回 Uint8Array', enc instanceof Uint8Array && enc.length > 0);
const dec = G.decodeGameData(enc);
eq('decode rule', dec.rule, 2);
eq('decode state', dec.state, 1);
eq('decode v', dec.v, 3);
eq('decode team24Level', dec.team24Level, 5);
eq('decode playedCardList', dec.playedCardList, [0, 5]);
eq('decode lastRankList', dec.lastRankList, [1, 3, 2, 4]);
eq('decode tributeCardList', dec.tributeCardList, [0, 0]);
eq('decode 空 data', G.decodeGameData(new Uint8Array(0)).rule, 0);
// 回归：连续 decode 不得污染共享默认数组
const dec1 = G.decodeGameData(enc);
const len1 = dec1.playedCardList.length;
dec1.playedCardList.push(999);
dec1.lastRankList.push(999);
const dec2 = G.decodeGameData(enc);
eq('decode 不污染默认数组（played）', dec2.playedCardList.length, len1);
eq('decode 不污染默认数组（lastRankList）', dec2.lastRankList, [1, 3, 2, 4]);

/* ============================ 6. 回放 replayActions ============================ */
// 1 号出 555，2/3/4 过 → 清墩回 1 号
const r1 = G.replayActions([0, 5, 18, 31, 0, 0, 0], 1, [C(3, 5), 0, 0, 0]);
eq('回放 restCounts[1]', r1.restCounts[1], 24);
eq('回放 restCounts[2]', r1.restCounts[2], 27);
eq('回放 清墩 trickOwner', r1.trickOwner, 0);
eq('回放 清墩 currentPlayer=1', r1.currentPlayer, 1);
eq('回放 actions 数', r1.actions.length, 4);
eq('回放 首手 code', r1.actions[0].code, C(3, 5));
eq('回放 lastSegmentPlayer', r1.lastSegmentPlayer, 4);
eq('回放 initialHolders id5', r1.initialHolders[4], 1);

// 1 出单张，2 压，3/4 过 → 牌权 2 号
const r2 = G.replayActions([0, 1, 0, 14, 0, 0], 1, [C(1, 14), C(1, 9), 0, 0]);
eq('回放 trickOwner=2', r2.trickOwner, 2);
eq('回放 lastCards', r2.lastCards, [14]);
eq('回放 currentPlayer=1', r2.currentPlayer, 1);

// 空
const r0 = G.replayActions([], 1, []);
eq('回放空 rankList', r0.rankList, []);
eq('回放空 currentPlayer', r0.currentPlayer, 1);
eq('回放空 restCounts', r0.restCounts, [0, 27, 27, 27, 27]);
eq('回放空 lastSegmentPlayer', r0.lastSegmentPlayer, 0);

// 一家出完 27 张 → 借风给对家
(function () {
  const segs = [], types = [];
  for (let t = 1; t <= 27; t++) {
    segs.push(0, t, 0, 0, 0);
    types.push(C(1, G.levelOrder(G.rankOf(t), 2)));
  }
  const r = G.replayActions(segs, 1, types);
  eq('出完 rankList=[1]', r.rankList, [1]);
  eq('出完 restCounts[1]=0', r.restCounts[1], 0);
  eq('出完借风 currentPlayer=对家3', r.currentPlayer, 3);
  eq('出完借风 trickOwner=0', r.trickOwner, 0);
  eq('出完清掉桌面牌', r.trickActions[1], null);
})();

/* ============================ 7. expandState ============================ */
const fullRaw = {
  rule: 2, state: 1, v: 3, team13Level: 2, team24Level: 2, firstPlayer: 1,
  lastRankList: [], tributeCardList: [], returnCardList: [], playedCardList: [], playedTypeList: [],
  cardPositionList: new Array(108).fill(0)
};
for (let i = 0; i < 108; i++) fullRaw.cardPositionList[i] = (i % 4) + 1;
const fullRawCopy = JSON.stringify(fullRaw);
const ex = G.expandState(fullRaw);
eq('expand 不修改入参', JSON.stringify(fullRaw), fullRawCopy);
eq('expand phase play', ex.phase, 'play');
eq('expand level 默认 2', ex.level, 2);
eq('expand playingTeam', ex.playingTeam, 0);
eq('expand heartLevelCardId', ex.heartLevelCardId, 28);
eq('expand currentPlayer', ex.currentPlayer, 1);
eq('expand canPlayAnyCards', ex.canPlayAnyCards, true);
eq('expand myHand 1 号 27 张', G.myHand(ex, 1).length, 27);
eq('expand playerCardLists 长度', ex.playerCardLists.length, 5);
eq('expand playerCardLists[0] 空', ex.playerCardLists[0].length, 0);
eq('expand playerCardLists 合计 108', ex.playerCardLists.slice(1).reduce((n, l) => n + l.length, 0), 108);
eq('expand playerRestCardCounts', ex.playerRestCardCounts.slice(1), [27, 27, 27, 27]);

// 进贡 / 还贡 / 结束
const tr = JSON.parse(JSON.stringify(fullRaw));
tr.lastRankList = [1, 3, 2, 4];
tr.state = 0;
tr.tributeCardList = [0, 0];
const exTribute = G.expandState(tr);
eq('expand 双下 tributers', exTribute.tributers, [2, 4]);
eq('expand 双下 receivers', exTribute.tributeReceivers, [1, 3]);
eq('expand phase tribute', exTribute.phase, 'tribute');
eq('expand tribute 时 level', exTribute.level, 2);

const ret = JSON.parse(JSON.stringify(fullRaw));
ret.lastRankList = [1, 3, 2, 4];
ret.state = 0;
ret.tributeCardList = [5, 6];
const exReturn = G.expandState(ret);
eq('expand phase return', exReturn.phase, 'return');
eq('expand return tributeReceivers', exReturn.tributeReceivers, [1, 3]);

const fin = JSON.parse(JSON.stringify(fullRaw));
fin.state = 0x0f;
fin.lastRankList = [1, 3, 2, 4];
const exFin = G.expandState(fin);
eq('expand phase finish', exFin.phase, 'finish');
eq('expand isRoundFinish', exFin.isRoundFinish, true);
eq('expand finish 无出完记录时 roundResult=null', exFin.roundResult, null);

// roundResultOf 升级口径（站点 C() 内部逻辑直接导出版）
const rr1 = G.roundResultOf([1, 3, 2, 4], 2, 2, 2, 1);
eq('roundResult 双上升 3 级', rr1.newTeam13Level, 5);
eq('roundResult winTeam', rr1.winTeam, 1);
eq('roundResult upLevels', rr1.upLevels, 3);
eq('roundResult fullRankList', rr1.fullRankList, [1, 3, 2, 4]);
eq('roundResult 头游+三游升 2 级', G.roundResultOf([1, 2, 3, 4], 2, 2, 2, 1).newTeam13Level, 4);
eq('roundResult 头游+末游升 1 级', G.roundResultOf([1, 2, 4, 3], 2, 2, 2, 1).newTeam13Level, 3);
eq('roundResult 蓝队双上升 3 级', G.roundResultOf([2, 4, 1, 3], 2, 2, 2, 2).newTeam24Level, 5);
eq('roundResult 升级封顶 14', G.roundResultOf([1, 3, 2, 4], 13, 2, 13, 1).newTeam13Level, 14);
eq('roundResult 非打级队不判定比赛结束', G.roundResultOf([1, 2, 3, 4], 14, 14, 14, 2).isMatchOver, false);
eq('roundResult 打级队过 A 且非末游结束', G.roundResultOf([1, 3, 2, 4], 14, 2, 14, 1).isMatchOver, true);

/* ============================ 8. 记牌器 remainingCounts ============================ */
const rc = G.remainingCounts(ex, 1);
eq('记牌器 byRank 15 个点数', rc.byRank.length, 15);
eq('记牌器 byRank[0]=大王', rc.byRank[0].rank, 17);
eq('记牌器 byRank[1]=小王', rc.byRank[1].rank, 16);
eq('记牌器 byRank[2]=A', rc.byRank[2].rank, 14);
eq('记牌器 byRank 末位=2', rc.byRank[14].rank, 2);
eq('记牌器 大王 total=2', rc.byRank[0].total, 2);
eq('记牌器 A total=8', rc.byRank[2].total, 8);
eq('记牌器 我手 27', rc.mineCount, 27);
eq('记牌器 已出 0', rc.playedCount, 0);
eq('记牌器 unknown 81', rc.unknown, 81);
eq('记牌器 ok', rc.ok, true);
eq('记牌器 warnings 空', rc.warnings, []);
eq('记牌器 逢人配剩余 2', rc.wildRemaining, 2);
ok('记牌器 byRank 含级牌标记', rc.byRank.some(r => r.rank === 2 && r.isLevel && r.isWild));

const bad = JSON.parse(JSON.stringify(fullRaw));
bad.playedCardList = [1]; // 1 号位的 ♦A 又出现在已出列表
const badEx = G.expandState(bad);
const rcBad = G.remainingCounts(badEx, 1);
eq('记牌器 冲突 ok=false', rcBad.ok, false);
ok('记牌器 冲突 warnings 非空', rcBad.warnings.length > 0);

/* ============================ 9. 发牌 / RNG ============================ */
const deal = G.deal(42);
eq('deal 4 家各 27 张', deal.hands.map(h => h.length), [27, 27, 27, 27]);
ok('deal 108 张不重复且 1..108', (() => {
  const all = deal.hands.flat();
  return new Set(all).size === 108 && Math.min(...all) === 1 && Math.max(...all) === 108;
})());
eq('deal 同 seed 一致', G.deal(42).hands, deal.hands);
eq('createRng 确定性', G.createRng(7)(), G.createRng(7)());
ok('createRng 取值 [0,1)', (() => { const r = G.createRng(1); return Array.from({ length: 20 }, () => r()).every(x => x >= 0 && x < 1); })());

/* ============================ 10. genMoves ============================ */
const hand = [d(2), c(2), h(2), s(2), d(3), c(3), h(3), s(3), d(4), c(4), W1, BIG, SMALL];
const lead = G.genMoves(hand, LVL, 0);
ok('genMoves 领出非空', lead.length > 0);
ok('genMoves ≤ 上限', lead.length <= 400);
ok('genMoves 每张牌都在手牌内', lead.every(m => m.cards.every(c => hand.indexOf(c) >= 0)));
ok('genMoves 无重复 cards', (() => { const set = new Set(lead.map(m => m.cards.slice().sort((a, b) => a - b).join(','))); return set.size === lead.length; })());
ok('genMoves 每种 code 与 cards 对应', lead.every(m => {
  const valid = G.interpretCodes(m.cards, LVL);
  return valid.indexOf(m.code) >= 0;
}));
ok('genMoves 含炸弹', lead.some(m => m.bomb >= 4));
ok('genMoves 含三连对', lead.some(m => m.type === T.TriplePairs));
ok('genMoves 含钢板', lead.some(m => m.type === T.Steel));
const follow = G.genMoves(hand, LVL, C(1, 4));
ok('genMoves 跟牌都能压', follow.every(m => G.beats(m.code, C(1, 4))));
const followBomb = G.genMoves(hand, LVL, C(T.Five, 14));
ok('genMoves 跟 5 炸：只剩更大炸弹', followBomb.every(m => m.bomb > 5));

/* ============================ 11. buildAIState / 贡牌候选 ============================ */
const st = G.buildAIState(ex, 1);
eq('AI state level', st.level, 2);
eq('AI state canPlayAny', st.canPlayAny, true);
eq('AI state hand', st.hand.length, 27);
eq('AI state seats', st.seatsRemaining.length, 4);
eq('AI state 座位顺序', st.seatsRemaining.map(x => x.seat), [1, 2, 3, 4]);
eq('AI state isMe', st.seatsRemaining[0].isMe, true);
eq('AI state partner', st.seatsRemaining[2].isPartner, true);
eq('AI state counter mineCount', st.counter.mineCount, 27);
eq('AI state isMyTurn', st.isMyTurn, true);
eq('AI state phase', st.phase, 'play');

const exHand = { ...ex, playerCardLists: [[], [d(1), d(2), W1], [d(3)], [d(4)], []] };
ok('tributeCandidates 排除逢人配', G.tributeCandidates(exHand, 1).every(x => !G.isWildCard(x, 2)));
eq('tributeCandidates 级牌 2 最大', G.tributeCandidates(exHand, 1), [d(2)]);
const exHand9 = { ...ex, level: 9, playerCardLists: [[], [d(1), d(2), W1], [d(3)], [d(4)], []] };
eq('tributeCandidates lv9 取 A 且排除 ♥9', G.tributeCandidates(exHand9, 1), [d(1)]);
const retHand = { ...ex, playerCardLists: [[], [d(9), d(10), d(1)], [d(3)], [d(4)], []] };
eq('returnCandidates 优先 ≤10 全取', G.returnCandidates(retHand, 1), [d(9), d(10)]);
const retHand2 = { ...ex, playerCardLists: [[], [d(11), d(12)], [d(3)], [d(4)], []] };
eq('returnCandidates 否则除级牌最小点', G.returnCandidates(retHand2, 1), [d(11)]);

/* ============================ 汇总 ============================ */
if (fail) {
  console.log('失败明细：');
  failures.forEach(function (f, i) { console.log(' ' + (i + 1) + ') ' + f); });
}
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exitCode = fail ? 1 : 0;
