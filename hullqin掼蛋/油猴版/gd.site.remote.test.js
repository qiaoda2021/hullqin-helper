/**
 * gd.site.remote.test.js · GDSiteRemote（掼蛋油猴版 DeepSeek 适配层）单测
 *
 * 全部用 mock fetchImpl，绝不联网；Node 直接运行：
 *   node gd.site.remote.test.js   （cwd = hullqin掼蛋\油猴版）
 *
 * 测试风格与仓库其它测试一致：passed/failed 计数，失败打印 ✗，最后打印 PASS n / FAIL m，
 * 并设置 process.exitCode = failed ? 1 : 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GDDeepSeek = require('../gd.deepseek.js');   // 被复用的通用 DeepSeek 模块
const Remote = require('./gd.site.remote.js');     // 被测模块

// 可选依赖：Lead 的站点引擎（可能尚未落盘）；缺失时用内置公式做期望值
const CORE = (function () {
  try { return require('./gd.site.core.js'); } catch (e) { return null; }
})();

/* ============================ 测试工具 ============================ */

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('✗ ' + msg);
  }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

function deepEq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

async function test(name, fn) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log('✗ ' + name + ' 抛异常：' + (err && err.stack ? err.stack : err));
  }
}

function jsonResponse(obj, status) {
  const st = status || 200;
  return {
    ok: st >= 200 && st < 300,
    status: st,
    json: async function () { return obj; },
    text: async function () { return typeof obj === 'string' ? obj : JSON.stringify(obj); }
  };
}

/** 返回成功 chat.completions 响应的 mock，同时记录每次调用 */
function chatMock(content, extra) {
  const calls = [];
  function fn(url, init) {
    calls.push({ url: url, init: init, body: JSON.parse(init.body) });
    const payload = Object.assign({
      model: 'deepseek-chat',
      choices: [{ message: { content: content } }],
      usage: { total_tokens: 12 }
    }, extra || {});
    return Promise.resolve(jsonResponse(payload, 200));
  }
  fn.calls = calls;
  return fn;
}

/** 返回 HTTP 错误的 mock */
function errorMock(status, bodyText) {
  const calls = [];
  function fn(url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({
      ok: false,
      status: status,
      json: async function () { throw new Error('响应不是 JSON'); },
      text: async function () { return bodyText === undefined ? '' : bodyText; }
    });
  }
  fn.calls = calls;
  return fn;
}

/* ============================ 测试数据（SPEC2 §1/§2） ============================ */

const P_SINGLE = {
  type: 1, code: (1 << 8) | 14, name: '单张', cards: [40], size: 1, rank: 14,
  bomb: 0, level: 5, desc: '单张 ♠A', wilds: []
};
const P_STRAIGHT = {
  type: 7, code: (7 << 8) | 14, name: '顺子', cards: [1, 2, 3, 4, 5], size: 5, rank: 14,
  bomb: 0, level: 5, desc: '顺子 10JQKA', wilds: []
};
const P_BOMB4 = {
  type: 100, code: (100 << 8) | 7, name: '炸弹4张', cards: [6, 7, 8, 9], size: 4, rank: 7,
  bomb: 4, level: 5, desc: '炸弹4张 ♦6♦7♦8♦9', wilds: []
};

function makeState(over) {
  const base = {
    level: 5,
    levelText: '5',
    heartLevelCardId: 31,
    wildText: '红桃5',
    mySeat: 2,
    mySeatName: '我',
    partnerSeat: 4,
    partnerSeatName: '对家',
    hand: [1, 2, 3, 4, 40],
    prevCode: (7 << 8) | 10,                     // 顺子 rank10
    lastCards: [1, 2, 3, 4, 5],
    trickOwner: 3,                               // 下家（mySeat=2）
    canPlayAny: false,
    isMyTurn: true,
    seatsRemaining: [
      { seat: 2, name: '我', count: 5, isMe: true, isPartner: false },
      { seat: 3, name: '下家', count: 10, isMe: false, isPartner: false },
      { seat: 4, name: '对家', count: 7, isMe: false, isPartner: true },
      { seat: 1, name: '上家', count: 9, isMe: false, isPartner: false }
    ],
    history: [
      { seat: 3, seatName: '下家', cards: ['♠K', '♥K', '♦K', '♣K', '♠A'], passed: false, name: '顺子' }
    ],
    counter: {
      byRank: [
        { rank: 14, text: 'A', total: 8, played: 4, mine: 1, remaining: 3, isLevel: false, isWild: false },
        { rank: 16, text: '小王', total: 2, played: 0, mine: 0, remaining: 2, isLevel: false, isWild: false }
      ],
      wildRemaining: 1,
      playedCount: 5,
      mineCount: 5,
      unknown: 95,
      ok: true
    },
    phase: 'play',
    tributers: [],
    tributeReceivers: [],
    mustTribute: false,
    mustReturn: false
  };
  return Object.assign(base, over || {});
}

const SUGGESTION = {
  source: 'local',
  action: 'play',
  play: P_SINGLE,
  reason: '用单张 A 压住下家的顺子',
  candidates: [
    { play: P_SINGLE, score: 9.5, tag: '最小可压' },
    { play: P_BOMB4, score: 3, tag: '炸弹拦截' }
  ],
  handInfo: { size: 5, bombs: 1, wilds: 0, playsEstimate: 3 }
};

function makeInput(over) {
  return Object.assign({ state: makeState(), suggestion: SUGGESTION }, over || {});
}

const PASS_SUGGESTION = {
  source: 'local', action: 'pass', play: null, reason: '队友牌权，让对家走牌', candidates: []
};

const CFG = { apiKey: 'sk-test-key-1234' };

/* ---- 牌面文本期望：优先用真实引擎，缺失时用 SPEC2 §1.1 公式 ---- */

const TEST_SUITS = ['♦', '♣', '♥', '♠'];

function hostRankText(rank) {
  if (rank === 16) return '小王';
  if (rank === 17) return '大王';
  if (rank >= 2 && rank <= 10) return String(rank);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] || String(rank);
}

function hostFallbackText(id) {
  const n = Number(id);
  const local = ((Math.floor(n) - 1) % 54 + 54) % 54 + 1;
  if (local === 53) return '大王';
  if (local === 54) return '小王';
  const suit = Math.floor((local - 1) / 13);
  const mod = local % 13;
  const rank = mod === 1 ? 14 : (mod === 0 ? 13 : mod);
  return TEST_SUITS[suit] + hostRankText(rank);
}

function expectedTexts(ids) {
  if (CORE && typeof CORE.cardTexts === 'function') {
    try {
      const out = CORE.cardTexts(ids.slice());
      if (Array.isArray(out) && out.length === ids.length) return out;
    } catch (e) { /* 引擎异常时用公式 */ }
  }
  return ids.map(hostFallbackText);
}

/** 临时注入 globalThis.GDSite 桩（用于强制走内置回退 / 模拟引擎） */
function withSiteStub(stub, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'GDSite');
  const old = globalThis.GDSite;
  globalThis.GDSite = stub;
  try {
    return fn();
  } finally {
    if (had) globalThis.GDSite = old;
    else delete globalThis.GDSite;
  }
}

/* ============================ 用例 ============================ */

(async function main() {
  section('导出与默认值');

  await test('导出对象只有 SPEC2 §4 的 5 个 API', async function () {
    deepEq(Object.keys(Remote).sort(),
      ['DEFAULTS', 'buildRequest', 'decide', 'testConnection', 'toLocalSuggestion'],
      '导出键集合');
    eq(typeof Remote.buildRequest, 'function', 'buildRequest 是函数');
    eq(typeof Remote.toLocalSuggestion, 'function', 'toLocalSuggestion 是函数');
    eq(typeof Remote.decide, 'function', 'decide 是函数');
    eq(typeof Remote.testConnection, 'function', 'testConnection 是函数');
  });

  await test('DEFAULTS 与 GDDeepSeek.DEFAULTS 一致', async function () {
    deepEq(Remote.DEFAULTS, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 30000
    }, 'DEFAULTS 内容');
    eq(Remote.DEFAULTS.baseUrl, GDDeepSeek.DEFAULTS.baseUrl, 'baseUrl 与 GDDeepSeek 一致');
    eq(Remote.DEFAULTS.model, GDDeepSeek.DEFAULTS.model, 'model 与 GDDeepSeek 一致');
    eq(Remote.DEFAULTS.timeoutMs, GDDeepSeek.DEFAULTS.timeoutMs, 'timeoutMs 与 GDDeepSeek 一致');
  });

  section('牌面文本（内置回退与引擎优先）');

  await test('内置回退：牌 id -> 牌面文本（SPEC2 §1.1）', async function () {
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ hand: [1, 40, 53, 54, 27] }), suggestion: null });
    });
    deepEq(r.hand, ['♦A', '♠A', '大王', '小王', '♥A'], '手牌文本（强制内置回退）');
    const r2 = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ hand: [13, 52, 107, 108] }), suggestion: null });
    });
    deepEq(r2.hand, ['♦K', '♠K', '大王', '小王'], '♦K/♠K/两副大小王');
  });

  await test('牌面文本保留重复张与已有文本', async function () {
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ hand: [1, 1, 1] }), suggestion: null });
    });
    deepEq(r.hand, ['♦A', '♦A', '♦A'], '重复张保留');
    const r2 = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ hand: ['♠A', '♥5'] }), suggestion: null });
    });
    deepEq(r2.hand, ['♠A', '♥5'], '已是文本时原样保留');
  });

  await test('有引擎时优先用 GDSite.cardTexts', async function () {
    const r = withSiteStub({
      cardTexts: function (ids) { return ids.map(function (id) { return 'Z' + id; }); }
    }, function () {
      return Remote.buildRequest({ state: makeState({ hand: [1, 40] }), suggestion: null });
    });
    deepEq(r.hand, ['Z1', 'Z40'], 'cardTexts 优先');
  });

  await test('引擎只有 cardText 时逐张使用', async function () {
    const r = withSiteStub({
      cardText: function (id) { return 'K' + id; }
    }, function () {
      return Remote.buildRequest({ state: makeState({ hand: [1, 40] }), suggestion: null });
    });
    deepEq(r.hand, ['K1', 'K40'], 'cardText 逐张');
  });

  await test('兼容 buildAIState 直接给的 handText（无 hand 时）', async function () {
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({
        state: makeState({ hand: undefined, handText: ['♠A', '♥5'] }),
        suggestion: SUGGESTION
      });
    });
    deepEq(r.hand, ['♠A', '♥5'], 'hand 缺失时用 handText');
  });

  await test('与真实引擎 cardTexts 输出一致（引擎存在时）', async function () {
    if (!CORE || typeof CORE.cardTexts !== 'function') {
      console.log('  · 跳过：gd.site.core.js 尚未落盘');
      return;
    }
    const ids = [1, 27, 40, 52, 53, 54, 107, 108];
    const r = Remote.buildRequest({ state: makeState({ hand: ids }), suggestion: null });
    deepEq(r.hand, CORE.cardTexts(ids.slice()), '手牌文本与 GDSite.cardTexts 一致');
  });

  section('buildRequest 局面字段');

  await test('基础字段映射（级牌/身份/手牌）', async function () {
    const r = Remote.buildRequest(makeInput());
    eq(r.level, 5, 'level');
    eq(r.levelText, '5', 'levelText');
    eq(r.wildText, '红桃5', 'wildText');
    eq(r.mySeatName, '我', 'mySeatName');
    eq(r.partnerSeatName, '对家', 'partnerSeatName');
    deepEq(r.hand, expectedTexts([1, 2, 3, 4, 40]), 'hand 文本数组');
    eq(r.hand.length, 5, 'hand 张数');
  });

  await test('上一手：正常映射', async function () {
    const r = Remote.buildRequest(makeInput());
    ok(r.lastPlay && typeof r.lastPlay === 'object', 'lastPlay 不为 null');
    eq(r.lastPlay.seatName, '下家', 'lastPlay.seatName（mySeat=2, trickOwner=3）');
    eq(r.lastPlay.name, '顺子', 'lastPlay.name');
    eq(r.lastPlay.size, 5, 'lastPlay.size');
    eq(r.lastPlay.bomb, 0, 'lastPlay.bomb=0');
    deepEq(r.lastPlay.cards, expectedTexts([1, 2, 3, 4, 5]), 'lastPlay.cards 文本');
  });

  await test('上一手：领出/无牌权时为 null', async function () {
    const lead = Remote.buildRequest(makeInput({ state: makeState({ prevCode: 0, lastCards: [], trickOwner: 0 }) }));
    eq(lead.lastPlay, null, '领出时 lastPlay=null');
    const trickNoCards = Remote.buildRequest(makeInput({ state: makeState({ lastCards: [] }) }));
    eq(trickNoCards.lastPlay, null, '无 lastCards 时 lastPlay=null');
    const noOwner = Remote.buildRequest(makeInput({ state: makeState({ trickOwner: 0 }) }));
    eq(noOwner.lastPlay, null, '无 trickOwner 时 lastPlay=null');
  });

  await test('上一手：兼容 buildAIState 直接给的 lastPlay 对象', async function () {
    const state = makeState({
      lastCards: undefined,
      lastPlay: {
        seat: 3, seatName: '下家', isPartner: false, name: '单张',
        code: (1 << 8) | 14, cards: [40], cardsText: '♠A'
      }
    });
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: state, suggestion: SUGGESTION });
    });
    ok(r.lastPlay && typeof r.lastPlay === 'object', 'lastPlay 非空');
    eq(r.lastPlay.seatName, '下家', 'lastPlay.seatName');
    eq(r.lastPlay.name, '单张', 'lastPlay.name');
    eq(r.lastPlay.size, 1, 'lastPlay.size');
    eq(r.lastPlay.bomb, 0, 'lastPlay.bomb');
    deepEq(r.lastPlay.cards, ['♠A'], 'lastPlay.cards 文本');

    const noLastPlay = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ lastPlay: null, lastCards: [] }), suggestion: SUGGESTION });
    });
    eq(noLastPlay.lastPlay, null, 'lastPlay=null 时保持 null');
  });

  await test('上一手：炸弹等级映射（bombValue）', async function () {
    const cases = [
      { code: (6 << 8) | 3, bomb: 0, name: '三连对' },
      { code: (100 << 8) | 7, bomb: 4, name: '炸弹4张' },
      { code: (101 << 8) | 7, bomb: 5, name: '炸弹5张' },
      { code: (102 << 8) | 10, bomb: 5.5, name: '同花顺' },
      { code: (103 << 8) | 7, bomb: 6, name: '炸弹6张' },
      { code: (104 << 8) | 7, bomb: 7, name: '炸弹7张' },
      { code: (105 << 8) | 7, bomb: 8, name: '炸弹8张' },
      { code: (127 << 8) | 0, bomb: 99, name: '四大天王' }
    ];
    cases.forEach(function (c) {
      const r = withSiteStub({}, function () {
        return Remote.buildRequest(makeInput({
          state: makeState({ prevCode: c.code, lastCards: [6, 7], trickOwner: 3 })
        }));
      });
      eq(r.lastPlay && r.lastPlay.name, c.name, 'typeName(' + c.code + ')');
      eq(r.lastPlay && r.lastPlay.bomb, c.bomb, 'bombValue(' + c.code + ')');
    });
  });

  await test('出牌历史映射（出牌/过/牌面/座位名）', async function () {
    const state = makeState({
      history: [
        { seat: 3, seatName: '下家', cards: ['♠K', '♥K'], passed: false, name: '对子' },
        { seat: 4, seatName: '对家', cards: [], passed: true, name: '' },
        { seat: 1, cards: ['♦A'], passed: false, name: '单张' }   // 故意缺 seatName
      ]
    });
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: state, suggestion: SUGGESTION });
    });
    eq(r.history.length, 3, '历史条数');
    eq(r.history[0].seatName, '下家', '历史[0].seatName');
    eq(r.history[0].action, '出牌', '历史[0].action');
    eq(r.history[0].name, '对子', '历史[0].name');
    deepEq(r.history[0].cards, ['♠K', '♥K'], '历史[0].cards');
    eq(r.history[1].action, '过', '历史[1].action=过');
    eq(r.history[1].text, '过', '历史[1].text=过');
    deepEq(r.history[1].cards, [], '过的 cards 为空');
    eq(r.history[2].seatName, '上家', '缺 seatName 时按相对座位推导（mySeat=2, seat=1）');
  });

  await test('出牌历史最多保留最近 12 条', async function () {
    const many = [];
    for (let i = 0; i < 15; i++) {
      many.push({ seat: (i % 4) + 1, seatName: '座位' + ((i % 4) + 1), cards: [], passed: true, name: '' });
    }
    const last = { seat: 2, seatName: '我', cards: ['♠A'], passed: false, name: '单张' };
    many.push(last);
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState({ history: many }), suggestion: SUGGESTION });
    });
    eq(r.history.length, 12, '历史截断为 12');
    deepEq(r.history[11].cards, ['♠A'], '保留的是最后一条');
  });

  await test('各家剩余张数映射', async function () {
    const r = Remote.buildRequest(makeInput());
    deepEq(r.seats, [
      { name: '我', count: 5 },
      { name: '下家', count: 10 },
      { name: '对家', count: 7 },
      { name: '上家', count: 9 }
    ], 'seats 映射');
  });

  await test('记牌器剩余映射与逢人配剩余', async function () {
    const r = Remote.buildRequest(makeInput());
    eq(r.remaining.length, 2, 'remaining 条数');
    deepEq(r.remaining[0], { rankText: 'A', count: 3 }, 'A 剩余 3');
    deepEq(r.remaining[1], { rankText: '小王', count: 2 }, '小王剩余 2');
    eq(r.wildRemaining, 1, 'wildRemaining');
  });

  await test('记牌器：缺 text 时按 rank 推导；无 counter 时安全默认', async function () {
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({
        state: makeState({ counter: { byRank: [{ rank: 14, remaining: 4 }] } }),
        suggestion: SUGGESTION
      });
    });
    deepEq(r.remaining[0], { rankText: 'A', count: 4 }, 'rank 推导 rankText');
    const r2 = Remote.buildRequest({ state: makeState({ counter: undefined }), suggestion: SUGGESTION });
    deepEq(r2.remaining, [], '无 counter -> remaining=[]');
    eq(r2.wildRemaining, null, '无 counter -> wildRemaining=null');
  });

  await test('记牌器：兼容 buildAIState 直接给的 state.remaining / wildRemaining', async function () {
    const state = makeState({
      counter: undefined,
      remaining: [
        { rank: 14, text: 'A', remaining: 3 },
        { rank: 17, text: '大王', remaining: 1 }
      ],
      wildRemaining: 2
    });
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: state, suggestion: SUGGESTION });
    });
    deepEq(r.remaining, [{ rankText: 'A', count: 3 }, { rankText: '大王', count: 1 }], 'state.remaining 兜底');
    eq(r.wildRemaining, 2, 'state.wildRemaining 兜底');
  });

  await test('input.counter 覆盖 state.counter', async function () {
    const r = Remote.buildRequest(makeInput({
      counter: { byRank: [{ rank: 17, text: '大王', remaining: 0 }], wildRemaining: 0 }
    }));
    deepEq(r.remaining, [{ rankText: '大王', count: 0 }], '使用 input.counter');
    eq(r.wildRemaining, 0, 'input.counter.wildRemaining');
  });

  section('buildRequest 候选（编号 = 数组下标，带 play）');

  await test('候选字段与 play 对象', async function () {
    const r = Remote.buildRequest(makeInput());
    eq(r.candidates.length, 2, '候选数量');
    eq(r.candidates[0].index, 0, '候选[0].index=0');
    eq(r.candidates[1].index, 1, '候选[1].index=1');
    eq(r.candidates[0].typeName, '单张', '候选[0].typeName');
    eq(r.candidates[0].name, '单张', '候选[0].name');
    eq(r.candidates[0].size, 1, '候选[0].size');
    eq(r.candidates[0].bomb, 0, '候选[0].bomb');
    deepEq(r.candidates[0].cards, expectedTexts([40]), '候选[0].cards 文本');
    ok(r.candidates[0].play === P_SINGLE, '候选[0].play 是原 Play 对象');
    eq(r.candidates[1].typeName, '炸弹4张', '候选[1].typeName');
    eq(r.candidates[1].bomb, 4, '候选[1].bomb=4');
    ok(r.candidates[1].play === P_BOMB4, '候选[1].play 是原 Play 对象');
    ok(r.candidates[0].note.indexOf('最小可压') >= 0, '候选[0].note 含 tag');
    ok(r.candidates[0].note.indexOf('本地评分 9.5') >= 0, '候选[0].note 含评分');
  });

  await test('候选直接是 Play 对象时也能识别', async function () {
    const r = Remote.buildRequest(makeInput({
      suggestion: { source: 'local', action: 'play', play: P_SINGLE, reason: '直接 Play 候选', candidates: [P_SINGLE, P_BOMB4] }
    }));
    eq(r.candidates.length, 2, '裸 Play 候选数');
    ok(r.candidates[0].play === P_SINGLE, '裸 Play 识别为候选 play');
    ok(r.candidates[1].play === P_BOMB4, '第二个裸 Play');
    eq(r.candidates[0].typeName, '单张', 'typeName 取自 Play.name');
    deepEq(r.candidates[0].cards, expectedTexts([40]), 'cards 文本');
  });

  await test('候选编号与 GDDeepSeek prompt 中的编号一致', async function () {
    const r = Remote.buildRequest(makeInput());
    const messages = GDDeepSeek.buildMessages(r);
    eq(messages.length, 2, 'buildMessages 返回 2 条消息');
    eq(messages[0].role, 'system', 'system 消息');
    eq(messages[1].role, 'user', 'user 消息');
    const user = messages[1].content;
    ok(user.indexOf('[0]') >= 0, 'prompt 含候选编号 [0]');
    ok(user.indexOf('[1]') >= 0, 'prompt 含候选编号 [1]');
    ok(user.indexOf('单张') >= 0, 'prompt 含候选牌型');
    ok(user.indexOf(expectedTexts([40])[0]) >= 0, 'prompt 含手牌牌面');
    ok(user.indexOf('顺子') >= 0, 'prompt 含上一手牌型');
    ok(user.indexOf('A×3') >= 0, 'prompt 含记牌器剩余');
    ok(user.indexOf('逢人配剩余 1 张') >= 0, 'prompt 含逢人配剩余');
    ok(messages[0].content.indexOf('掼蛋规则摘要') >= 0, 'system 含规则摘要');
    ok(messages[0].content.indexOf('choice') >= 0, 'system 含 JSON 输出契约');
  });

  await test('suggestion 缺失时候选为空、localSuggestion=null', async function () {
    const r = withSiteStub({}, function () {
      return Remote.buildRequest({ state: makeState(), suggestion: null });
    });
    deepEq(r.candidates, [], '无 GDSite 且无 suggestion -> 候选为空');
    eq(r.localSuggestion, null, 'localSuggestion=null');
  });

  await test('候选为空数组时保持为空', async function () {
    const r = Remote.buildRequest(makeInput({
      suggestion: { source: 'local', action: 'pass', play: null, reason: '让过', candidates: [] }
    }));
    deepEq(r.candidates, [], '空候选用数组');
    ok(r.localSuggestion && r.localSuggestion.action === 'pass', 'localSuggestion.action=pass');
  });

  await test('suggestion 缺失时用 GDSite.genMoves 兜底组候选', async function () {
    const r = withSiteStub({
      genMoves: function (hand, level, prevCode) {
        ok(Array.isArray(hand) && hand.length === 5, 'genMoves 收到手牌');
        eq(level, 5, 'genMoves 收到级牌');
        eq(prevCode, (7 << 8) | 10, 'genMoves 收到 prevCode');
        return [P_SINGLE, P_BOMB4];
      },
      cardTexts: function (ids) { return ids.map(function (id) { return 'G' + id; }); }
    }, function () {
      return Remote.buildRequest({ state: makeState(), suggestion: null });
    });
    eq(r.candidates.length, 2, 'genMoves 兜底候选数');
    ok(r.candidates[0].play === P_SINGLE, '兜底候选[0].play');
    deepEq(r.hand, ['G1', 'G2', 'G3', 'G4', 'G40'], '兜底时牌面文本用引擎 cardTexts');
  });

  await test('genMoves 抛异常时安全降级为空候选', async function () {
    const r = withSiteStub({
      genMoves: function () { throw new Error('引擎内部错误'); }
    }, function () {
      return Remote.buildRequest({ state: makeState(), suggestion: null });
    });
    deepEq(r.candidates, [], 'genMoves 异常 -> 候选为空');
  });

  section('toLocalSuggestion');

  await test('出牌建议转换', async function () {
    const ls = Remote.toLocalSuggestion(SUGGESTION);
    eq(ls.action, 'play', 'action=play');
    ok(ls.play === P_SINGLE, 'play 原对象');
    eq(ls.reason, '用单张 A 压住下家的顺子', 'reason');
    eq(ls.typeName, '单张', 'typeName');
    deepEq(ls.cards, expectedTexts([40]), 'cards 文本');
  });

  await test('不出建议转换', async function () {
    const ls = Remote.toLocalSuggestion(PASS_SUGGESTION);
    eq(ls.action, 'pass', 'action=pass');
    eq(ls.play, null, 'play=null');
    eq(ls.reason, '队友牌权，让对家走牌', 'reason');
    deepEq(ls.cards, [], 'cards=[]');
  });

  await test('null/异常建议 -> 安全不出', async function () {
    const a = Remote.toLocalSuggestion(null);
    eq(a.action, 'pass', 'null -> pass');
    eq(a.play, null, 'null -> play=null');
    eq(a.reason, '本地建议不可用', 'null -> reason');
    deepEq(a.cards, [], 'null -> cards=[]');
    const b = Remote.toLocalSuggestion('bad input');
    eq(b.action, 'pass', '字符串输入 -> pass');
    const c = Remote.toLocalSuggestion({ action: 'play', play: null, cards: ['♠A'], reason: '缺 Play' });
    eq(c.action, 'pass', 'action:play 但无 Play 时安全退化为 pass');
    eq(c.play, null, '退化后 play=null');
  });

  await test('action 缺失但带 play 时视为出牌', async function () {
    const ls = Remote.toLocalSuggestion({ play: P_BOMB4, reason: '炸' });
    eq(ls.action, 'play', '有 play -> play');
    ok(ls.play === P_BOMB4, 'play 原对象');
    eq(ls.typeName, '炸弹4张', 'typeName 取自 play.name');
  });

  section('buildRequest 健壮性（不修改入参 / 容错）');

  await test('buildRequest 不修改入参', async function () {
    const state = makeState();
    const suggestion = SUGGESTION;
    const before = JSON.stringify({ state: state, suggestion: suggestion });
    Remote.buildRequest({ state: state, suggestion: suggestion });
    const after = JSON.stringify({ state: state, suggestion: suggestion });
    eq(after, before, '入参未被修改');
  });

  await test('无参 / null / 空对象不抛异常且字段安全', async function () {
    const cases = [undefined, null, {}, { state: null, suggestion: null }];
    cases.forEach(function (input, i) {
      let r = null;
      let threw = false;
      try {
        r = Remote.buildRequest(input);
      } catch (e) {
        threw = true;
        console.log('  ✗ buildRequest(' + i + ') 抛异常：' + e.message);
      }
      ok(!threw, 'buildRequest(' + i + ') 不抛异常');
      ok(r && r.level === 2, 'buildRequest(' + i + ').level=2');
      deepEq(r && r.hand, [], 'buildRequest(' + i + ').hand=[]');
      eq(r && r.lastPlay, null, 'buildRequest(' + i + ').lastPlay=null');
      deepEq(r && r.history, [], 'buildRequest(' + i + ').history=[]');
      deepEq(r && r.seats, [], 'buildRequest(' + i + ').seats=[]');
      deepEq(r && r.candidates, [], 'buildRequest(' + i + ').candidates=[]');
      eq(r && r.localSuggestion, null, 'buildRequest(' + i + ').localSuggestion=null');
    });
  });

  await test('异常类型字段安全降级', async function () {
    let r = null;
    let threw = false;
    try {
      r = Remote.buildRequest({
        state: { hand: 'oops', history: 'bad', seatsRemaining: 42, counter: [], level: 'x', mySeat: null },
        suggestion: 'bad'
      });
    } catch (e) {
      threw = true;
    }
    ok(!threw, '异常类型字段不抛异常');
    deepEq(r && r.hand, [], '非法 hand -> []');
    eq(r && r.level, 2, '非法 level -> DEFAULTS 2');
    eq(r && r.mySeat, 1, '非法 mySeat -> 1');
    eq(r && r.levelText, '2', 'levelText 随 level 兜底');
    eq(r && r.wildText, '红桃2', 'wildText 随 levelText 兜底');
  });

  section('decide 成功（mock fetch）');

  await test('choice=1 -> source deepseek + 对应候选的 Play', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('{"choice":1,"reason":"用炸弹压住下家"}') });
    eq(res.source, 'deepseek', 'source=deepseek');
    eq(res.action, 'play', 'action=play');
    ok(res.play === P_BOMB4, 'play 是候选[1]的 Play 对象');
    eq(res.reason, '用炸弹压住下家', 'reason');
    ok(typeof res.raw === 'string' && res.raw.indexOf('choice') >= 0, 'raw 为原始返回');
    eq(res.error, undefined, '成功时无 error');
  });

  await test('choice=0 -> 候选[0] 的 Play', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('{"choice":0,"reason":"出单张A"}') });
    eq(res.source, 'deepseek', 'source=deepseek');
    ok(res.play === P_SINGLE, 'play 是候选[0]的 Play');
  });

  await test('choice=-1 -> pass，play=null', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('{"choice":-1,"reason":"不压队友"}') });
    eq(res.source, 'deepseek', 'source=deepseek');
    eq(res.action, 'pass', 'action=pass');
    eq(res.play, null, 'play=null');
    eq(res.reason, '不压队友', 'reason');
  });

  await test('请求 URL / 请求头 / body 符合 OpenAI 兼容格式', async function () {
    const mock = chatMock('{"choice":0,"reason":"ok"}');
    await Remote.decide(makeInput(), CFG, { fetchImpl: mock });
    eq(mock.calls.length, 1, '调用一次 fetch');
    const call = mock.calls[0];
    eq(call.url, 'https://api.deepseek.com/chat/completions', 'URL 为 {baseUrl}/chat/completions');
    eq(call.init.method, 'POST', 'method=POST');
    eq(call.init.headers.Authorization, 'Bearer sk-test-key-1234', 'Authorization Bearer');
    eq(call.body.model, 'deepseek-chat', 'body.model');
    eq(call.body.temperature, 0.2, 'body.temperature');
    eq(call.body.max_tokens, 512, 'body.max_tokens');
    eq(call.body.stream, false, 'body.stream=false');
    deepEq(call.body.response_format, { type: 'json_object' }, 'body.response_format');
    eq(call.body.messages.length, 2, 'body.messages 两条');
    const user = call.body.messages[1].content;
    ok(user.indexOf('[0]') >= 0 && user.indexOf('[1]') >= 0, 'prompt 含候选编号');
    ok(user.indexOf(expectedTexts([40])[0]) >= 0, 'prompt 含手牌牌面');
  });

  await test('自定义 baseUrl/model/temperature/timeout 生效', async function () {
    const mock = chatMock('{"choice":0,"reason":"ok"}');
    await Remote.decide(makeInput(), {
      apiKey: 'sk-test-key-1234',
      baseUrl: 'https://api.example.com/',
      model: 'deepseek-reasoner',
      temperature: 0.7,
      timeoutMs: 5000
    }, { fetchImpl: mock });
    eq(mock.calls[0].url, 'https://api.example.com/chat/completions', 'baseUrl 规范化（去尾斜杠）');
    eq(mock.calls[0].body.model, 'deepseek-reasoner', 'model 生效');
    eq(mock.calls[0].body.temperature, 0.7, 'temperature 生效');
  });

  section('decide 回退（无 Key / HTTP 失败 / 解析失败，绝不 throw）');

  await test('无 API Key -> 回退本地建议（出牌）', async function () {
    const res = await Remote.decide(makeInput(), {}, { fetchImpl: chatMock('{"choice":0}') });
    eq(res.source, 'local', 'source=local');
    eq(res.action, 'play', 'action 来自本地建议');
    ok(res.play === P_SINGLE, 'play 来自本地建议');
    eq(res.reason, '用单张 A 压住下家的顺子', 'reason 来自本地建议');
    ok(typeof res.error === 'string' && res.error.indexOf('API Key') >= 0, 'error 说明缺少 Key');
  });

  await test('无 API Key + 本地建议不出 -> pass', async function () {
    const res = await Remote.decide(makeInput({ suggestion: PASS_SUGGESTION }), {}, {});
    eq(res.source, 'local', 'source=local');
    eq(res.action, 'pass', 'action=pass');
    eq(res.play, null, 'play=null');
    eq(res.reason, '队友牌权，让对家走牌', 'reason 来自本地建议');
  });

  await test('HTTP 401 -> 回退本地并携带错误', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: errorMock(401, '{"error":"invalid key"}') });
    eq(res.source, 'local', 'source=local');
    eq(res.action, 'play', 'action 来自本地建议');
    ok(res.play === P_SINGLE, 'play 来自本地建议');
    ok(typeof res.error === 'string' && res.error.indexOf('401') >= 0, 'error 含 401');
  });

  await test('HTTP 429 -> 回退本地并提示限流', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: errorMock(429, 'rate limited') });
    eq(res.source, 'local', 'source=local');
    ok(/429|限流/.test(res.error || ''), 'error 含 429/限流');
    eq(res.action, 'play', 'action 来自本地建议');
  });

  await test('HTTP 500 -> 回退本地', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: errorMock(500, 'server error') });
    eq(res.source, 'local', 'source=local');
    ok(/500/.test(res.error || ''), 'error 含 500');
  });

  await test('网络错误（fetch reject）-> 回退本地', async function () {
    const mock = function () { return Promise.reject(new Error('network down')); };
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: mock });
    eq(res.source, 'local', 'source=local');
    ok(/网络/.test(res.error || ''), 'error 含“网络”');
    eq(res.action, 'play', 'action 来自本地建议');
  });

  await test('超时 -> 回退本地并提示超时', async function () {
    const mock = function () { return new Promise(function () { /* 永不 resolve */ }); };
    const res = await Remote.decide(makeInput(), { apiKey: 'sk-test-key-1234', timeoutMs: 25 }, { fetchImpl: mock });
    eq(res.source, 'local', 'source=local');
    ok(/超时/.test(res.error || ''), 'error 含“超时”');
  });

  await test('返回坏 JSON -> 回退本地', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('这不是 JSON') });
    eq(res.source, 'local', 'source=local');
    ok(/解析|JSON/.test(res.error || ''), 'error 说明解析失败');
  });

  await test('choice 越界 -> 回退本地', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('{"choice":99,"reason":"乱选"}') });
    eq(res.source, 'local', 'source=local');
    ok(/越界/.test(res.error || ''), 'error 含“越界”');
  });

  await test('返回空内容 -> 回退本地', async function () {
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('   ') });
    eq(res.source, 'local', 'source=local');
    ok(/空/.test(res.error || ''), 'error 说明内容为空');
  });

  await test('fetchImpl 同步抛错 -> 回退本地', async function () {
    const mock = function () { throw new Error('sync boom'); };
    const res = await Remote.decide(makeInput(), CFG, { fetchImpl: mock });
    eq(res.source, 'local', 'source=local');
    ok(/sync boom|失败/.test(res.error || ''), 'error 含失败原因');
  });

  await test('input 为 null/异常时仍安全回退', async function () {
    const r1 = await Remote.decide(null, {}, {});
    eq(r1.source, 'local', 'input=null -> source=local');
    eq(r1.action, 'pass', 'input=null -> pass');
    eq(r1.play, null, 'input=null -> play=null');
    ok(typeof r1.error === 'string' && r1.error.length > 0, 'input=null -> 有 error');

    const r2 = await Remote.decide({ state: 'bad', suggestion: 'bad' }, {}, {});
    eq(r2.source, 'local', 'garbage input -> source=local');
    eq(r2.action, 'pass', 'garbage input -> pass');
  });

  await test('config 为 null 时不抛异常', async function () {
    const res = await Remote.decide(makeInput(), null, {});
    eq(res.source, 'local', 'source=local');
    eq(res.action, 'play', 'action 来自本地建议');
    ok(typeof res.error === 'string', '有 error 说明');
  });

  await test('错误文案不泄露完整 API Key（HTTP 错误）', async function () {
    const key = 'sk-verysecret-abcdef123456';
    const res = await Remote.decide(makeInput(), { apiKey: key }, {
      fetchImpl: errorMock(401, 'invalid api key: ' + key)
    });
    eq(res.source, 'local', 'source=local');
    eq((res.error || '').indexOf(key), -1, 'error 不含完整 Key');
    ok((res.error || '').indexOf('****') >= 0, 'error 中含掩码 ****');
  });

  await test('错误文案不泄露完整 API Key（网络异常）', async function () {
    const key = 'sk-verysecret-abcdef123456';
    const res = await Remote.decide(makeInput(), { apiKey: key }, {
      fetchImpl: function () { return Promise.reject(new Error('boom ' + key)); }
    });
    eq((res.error || '').indexOf(key), -1, 'error 不含完整 Key');
  });

  await test('decide 返回值结构契约', async function () {
    const success = await Remote.decide(makeInput(), CFG, { fetchImpl: chatMock('{"choice":0,"reason":"ok"}') });
    const fallback = await Remote.decide(makeInput(), {}, {});
    [success, fallback].forEach(function (r, i) {
      ok(r && typeof r === 'object', '结果[' + i + '] 是对象');
      ok(r.source === 'deepseek' || r.source === 'local', '结果[' + i + '].source 合法');
      ok(r.action === 'play' || r.action === 'pass', '结果[' + i + '].action 合法');
      ok(typeof r.reason === 'string', '结果[' + i + '].reason 是字符串');
      if (r.action === 'pass') eq(r.play, null, '结果[' + i + '] pass 时 play=null');
      else ok(r.play && typeof r.play === 'object', '结果[' + i + '] play 时 play 是对象');
    });
  });

  section('decide 与 GDDeepSeek 的集成（候选编号 / play 回传）');

  await test('多候选时 DeepSeek 选择任意编号都映射到对应 Play', async function () {
    for (let i = 0; i < SUGGESTION.candidates.length; i++) {
      const res = await Remote.decide(makeInput(), CFG, {
        fetchImpl: chatMock('{"choice":' + i + ',"reason":"选第' + i + '个"}')
      });
      eq(res.source, 'deepseek', 'choice=' + i + ' -> deepseek');
      ok(res.play === SUGGESTION.candidates[i].play, 'choice=' + i + ' 映射到候选[' + i + ']的 Play');
    }
  });

  await test('本地建议同时进入 request.localSuggestion 与 opts（回退可用）', async function () {
    const request = Remote.buildRequest(makeInput());
    ok(request.localSuggestion && request.localSuggestion.action === 'play', 'request.localSuggestion.action=play');
    ok(request.localSuggestion.play === P_SINGLE, 'request.localSuggestion.play');
    const res = await Remote.decide(makeInput(), {}, {});
    ok(res.play === P_SINGLE, 'GDDeepSeek 用 opts.localSuggestion 回退了同一 Play');
  });

  section('testConnection');

  await test('连接成功', async function () {
    const mock = chatMock('{"ok":true}');
    const res = await Remote.testConnection(CFG, mock);
    eq(res.ok, true, 'ok=true');
    ok(res.message.indexOf('连接成功') >= 0, 'message 含连接成功');
    ok(res.message.indexOf('deepseek-chat') >= 0, 'message 含模型名');
    eq(res.model, 'deepseek-chat', 'model 字段');
    eq(mock.calls.length, 1, '发起一次请求');
    ok(mock.calls[0].url.indexOf('/chat/completions') >= 0, '请求 chat/completions');
  });

  await test('未配置 Key -> ok=false，不发起请求', async function () {
    const mock = chatMock('{"ok":true}');
    const res = await Remote.testConnection({}, mock);
    eq(res.ok, false, 'ok=false');
    ok(res.message.indexOf('API Key') >= 0, 'message 提示未配置 Key');
    eq(mock.calls.length, 0, '未发起请求');
  });

  await test('401 -> ok=false', async function () {
    const res = await Remote.testConnection(CFG, errorMock(401, 'invalid key'));
    eq(res.ok, false, 'ok=false');
    ok(/401|Key/.test(res.message || ''), 'message 含 401/Key');
  });

  await test('网络错误 -> ok=false 且不 throw', async function () {
    const res = await Remote.testConnection(CFG, function () { return Promise.reject(new Error('offline')); });
    eq(res.ok, false, 'ok=false');
    ok(/offline|网络|失败/.test(res.message || ''), 'message 含失败原因');
  });

  await test('config 为 null -> ok=false 且不 throw', async function () {
    const res = await Remote.testConnection(null, chatMock('{"ok":true}'));
    eq(res.ok, false, 'ok=false');
    eq(typeof res.message, 'string', 'message 是字符串');
  });

  await test('fetchImpl 同步抛错 -> ok=false', async function () {
    const res = await Remote.testConnection(CFG, function () { throw new Error('sync boom'); });
    eq(res.ok, false, 'ok=false');
    ok(/sync boom|失败/.test(res.message || ''), 'message 含失败原因');
  });

  await test('测试连接错误不泄露完整 Key', async function () {
    const key = 'sk-verysecret-abcdef123456';
    const res = await Remote.testConnection({ apiKey: key }, errorMock(401, 'bad key ' + key));
    eq(res.ok, false, 'ok=false');
    eq((res.message || '').indexOf(key), -1, 'message 不含完整 Key');
  });

  section('UMD（浏览器全局 GDSiteRemote）');

  await test('无 module 环境下暴露全局 GDSiteRemote，且可正常 buildRequest/decide', async function () {
    const src = fs.readFileSync(path.join(__dirname, 'gd.site.remote.js'), 'utf8');
    const sandbox = { GDDeepSeek: GDDeepSeek };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'gd.site.remote.js' });

    const G = sandbox.GDSiteRemote;
    ok(!!G && typeof G === 'object', '浏览器全局 GDSiteRemote 存在');
    deepEq(Object.keys(G).sort(),
      ['DEFAULTS', 'buildRequest', 'decide', 'testConnection', 'toLocalSuggestion'],
      '浏览器全局导出 5 个 API');
    deepEq(G.DEFAULTS, Remote.DEFAULTS, '浏览器 DEFAULTS 与 Node 一致');

    const req = G.buildRequest({ state: makeState({ hand: [1, 40] }), suggestion: SUGGESTION });
    deepEq(req.hand, ['♦A', '♠A'], '浏览器内 buildRequest 牌面文本');
    eq(req.candidates.length, 2, '浏览器内候选数量');

    const res = await G.decide(
      { state: makeState(), suggestion: SUGGESTION },
      CFG,
      { fetchImpl: chatMock('{"choice":0,"reason":"浏览器 ok"}') }
    );
    eq(res.source, 'deepseek', '浏览器内 decide 成功');
    ok(res.play === P_SINGLE, '浏览器内 decide 返回 Play');
  });

  /* ============================ 汇总 ============================ */

  console.log('\nPASS ' + passed + ' / FAIL ' + failed);
  process.exitCode = failed ? 1 : 0;
})();
