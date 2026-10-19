/*!
 * gd.site.remote.js · 掼蛋 AI 助手（game.hullqin.cn 油猴版）DeepSeek 远端适配层
 * 全局名：GDSiteRemote（浏览器） / module.exports（Node 测试）
 *
 * 职责：把站点引擎派生的 AI 局面（GDSiteAI.buildAIState）与本地建议（GDSiteAI.suggest）
 *       转换成通用模块 GDDeepSeek 需要的 request，再委托 GDDeepSeek.decide 调用 DeepSeek；
 *       无 Key / 调用失败 / 解析失败时回退本地建议，绝不 throw。
 *
 * 依赖（不修改）：
 *   - 父目录 ../gd.deepseek.js：打包进用户脚本后为全局 GDDeepSeek；Node 测试 require('../gd.deepseek.js')
 *   - 可选 ./gd.site.core.js（全局 GDSite）：用于 cardTexts / typeName / bombValue / genMoves；
 *     缺失时使用本文件内置的回退格式化（规则按 SPEC2 §1.1/§1.2）。
 *
 * 契约（SPEC2 §4）：
 *   DEFAULTS
 *   buildRequest(input) -> GDDeepSeek request
 *   toLocalSuggestion(suggestion) -> {action, play, reason, typeName, cards:string[]}
 *   async decide(input, config, opts?) -> {source, action, play, reason, raw?, error?}
 *   async testConnection(config, fetchImpl?) -> {ok, message, model?}
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteRemote = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================ 全局环境 ============================ */

  // 浏览器：self；Node：globalThis（测试可通过 globalThis.GDSite 注入桩）
  const GLOBAL = typeof self !== 'undefined' ? self
    : (typeof globalThis !== 'undefined' ? globalThis
      : (typeof window !== 'undefined' ? window : {}));

  // GDDeepSeek.DEFAULTS 的兜底副本（正常情况下用 GDDeepSeek.DEFAULTS）
  const FALLBACK_DEFAULTS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 512,
    timeoutMs: 30000
  };

  const SUIT_TEXT = ['♦', '♣', '♥', '♠'];   // SPEC2 §1.1：suit 0=♦ 1=♣ 2=♥ 3=♠
  const REL_SEAT_NAMES = ['我', '下家', '对家', '上家'];
  // code -> 牌型名回退表（SPEC2 §1.2）；有 GDSite.typeName 时优先用引擎的
  const TYPE_NAME_MAP = {
    1: '单张', 2: '对子', 3: '三同张', 4: '三带二', 5: '钢板', 6: '三连对', 7: '顺子',
    100: '炸弹4张', 101: '炸弹5张', 102: '同花顺', 103: '炸弹6张',
    104: '炸弹7张', 105: '炸弹8张', 127: '四大天王'
  };
  const SAFE_LOCAL = { action: 'pass', play: null, reason: '本地建议不可用', typeName: '', cards: [] };

  /* ============================ 通用小工具 ============================ */

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function num(v, dflt) {
    // null/undefined/空串视为缺失（Number(null)===0 会误判）
    if (v === null || v === undefined || v === '') return dflt;
    const n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  function str(v, dflt) {
    return typeof v === 'string' && v ? v : (dflt === undefined ? '' : dflt);
  }

  /** 记牌器条目取“剩余张数”：remaining 优先，其次 count */
  function pickCount(item) {
    if (item.remaining !== undefined && item.remaining !== null) return num(item.remaining, 0);
    if (item.count !== undefined && item.count !== null) return num(item.count, 0);
    return 0;
  }

  function rankToText(rank) {
    const r = Number(rank);
    if (r === 16) return '小王';
    if (r === 17) return '大王';
    if (r >= 2 && r <= 10) return String(r);
    if (r === 11) return 'J';
    if (r === 12) return 'Q';
    if (r === 13) return 'K';
    if (r === 14) return 'A';
    return String(rank === null || rank === undefined ? '?' : rank);
  }

  /** 内置牌面文本：id 1..108 -> '♦A'/'♥5'/'大王'（SPEC2 §1.1） */
  function fallbackCardText(card) {
    if (typeof card === 'string') return card;
    if (card === null || card === undefined) return '?';
    const n = Number(card);
    if (!isFinite(n)) return String(card);
    const local = ((Math.floor(n) - 1) % 54 + 54) % 54 + 1;   // 1..54
    if (local === 53) return '大王';
    if (local === 54) return '小王';
    const suit = Math.floor((local - 1) / 13);                 // 0..3
    const mod = local % 13;
    const rank = mod === 1 ? 14 : (mod === 0 ? 13 : mod);      // 1->A(14), 0->K(13)
    return SUIT_TEXT[suit] + rankToText(rank);
  }

  /** 相对座位名：mySeat 视角下 seat 的称呼（我/下家/对家/上家） */
  function relSeatName(mySeat, seat) {
    const m = num(mySeat, 1);
    const s = num(seat, 0);
    if (!s) return '';
    const off = ((Math.floor(s) - Math.floor(m)) % 4 + 4) % 4;
    return REL_SEAT_NAMES[off];
  }

  /* ============================ 依赖解析 ============================ */

  let deepseekCache = null;

  /** 取 GDDeepSeek：浏览器全局优先；Node 里 require 父目录模块 */
  function getDeepseek() {
    if (deepseekCache && typeof deepseekCache.decide === 'function') return deepseekCache;
    if (GLOBAL && GLOBAL.GDDeepSeek && typeof GLOBAL.GDDeepSeek.decide === 'function') {
      deepseekCache = GLOBAL.GDDeepSeek;
      return deepseekCache;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        const m = require('../gd.deepseek.js');
        if (m && typeof m.decide === 'function') {
          deepseekCache = m;
          return deepseekCache;
        }
      } catch (e) {
        // 父目录模块缺失时保持 null，由调用方回退
      }
    }
    return null;
  }

  let siteCache = null;

  /** 取 GDSite（可选依赖）：浏览器全局优先；Node 里尝试 require 同目录 gd.site.core.js */
  function getSite() {
    if (GLOBAL && GLOBAL.GDSite && typeof GLOBAL.GDSite === 'object') return GLOBAL.GDSite;
    if (siteCache && typeof siteCache === 'object') return siteCache;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        const m = require('./gd.site.core.js');
        if (m && typeof m === 'object') {
          siteCache = m;
          return siteCache;
        }
      } catch (e) {
        // 引擎尚未落盘/缺失时用内置回退
      }
    }
    return null;
  }

  /** 单张牌面文本：优先 GDSite.cardText，缺失用内置格式化 */
  function oneCardText(card) {
    if (typeof card === 'string') return card;
    const site = getSite();
    if (site && typeof site.cardText === 'function') {
      try {
        const t = site.cardText(card);
        if (typeof t === 'string' && t) return t;
      } catch (e) {
        // 引擎异常时退回内置格式化
      }
    }
    return fallbackCardText(card);
  }

  /** 牌 id 数组 -> 牌面文本数组；输入已是文本时原样保留 */
  function cardsTextList(list) {
    if (!Array.isArray(list)) return [];
    const hasNumber = list.some(function (c) { return typeof c === 'number'; });
    if (!hasNumber) {
      return list.map(function (c) { return typeof c === 'string' ? c : oneCardText(c); });
    }
    const site = getSite();
    if (site && typeof site.cardTexts === 'function') {
      try {
        const out = site.cardTexts(list.slice());
        if (Array.isArray(out) && out.length === list.length) {
          return out.map(function (t) { return typeof t === 'string' ? t : oneCardText(t); });
        }
      } catch (e) {
        // 退回逐张格式化
      }
    }
    return list.map(oneCardText);
  }

  /** code 的牌型名：优先 GDSite.typeName，缺失用回退表 */
  function typeNameOf(code) {
    const c = num(code, 0);
    if (!c) return '';
    const site = getSite();
    if (site && typeof site.typeName === 'function') {
      try {
        const t = site.typeName(c);
        if (typeof t === 'string' && t) return t;
      } catch (e) {
        // 忽略，走回退表
      }
    }
    return TYPE_NAME_MAP[Math.floor(c / 256)] || '未知牌型';
  }

  /** code 的炸弹等级（SPEC2 §2 bombValue：0 | 4..8 | 5.5 | 99） */
  function bombValueOf(code) {
    const c = num(code, 0);
    if (!c) return 0;
    const site = getSite();
    if (site && typeof site.bombValue === 'function') {
      try {
        const b = site.bombValue(c);
        if (isFinite(Number(b))) return Number(b);
      } catch (e) {
        // 忽略，走回退表
      }
    }
    const t = Math.floor(c / 256);
    if (t === 100) return 4;
    if (t === 101) return 5;
    if (t === 102) return 5.5;
    if (t === 103) return 6;
    if (t === 104) return 7;
    if (t === 105) return 8;
    if (t === 127) return 99;
    return 0;
  }

  /* ============================ 本地建议转换 ============================ */

  /**
   * toLocalSuggestion(suggestion) -> {action, play, reason, typeName, cards:string[]}
   * 供 GDDeepSeek 回退使用；suggestion = GDSiteAI.suggest 结果。
   * 永远不会返回无 Play 的 action:'play'（避免 UI 采用时拿不到牌）。
   */
  function toLocalSuggestion(suggestion) {
    const s = isObj(suggestion) ? suggestion : null;
    if (!s) {
      return { action: 'pass', play: null, reason: '本地建议不可用', typeName: '', cards: [] };
    }
    const play = isObj(s.play) ? s.play : null;
    let action = s.action === 'play' ? 'play' : (s.action === 'pass' ? 'pass' : (play ? 'play' : 'pass'));
    if (action === 'play' && !play) {
      // 没有 Play 对象时不冒充出牌建议，安全地退化为不出
      return {
        action: 'pass',
        play: null,
        reason: str(s.reason, '本地建议缺少牌型信息，建议不出'),
        typeName: '',
        cards: []
      };
    }
    if (action === 'pass') {
      return {
        action: 'pass',
        play: null,
        reason: str(s.reason, '本地引擎建议不出'),
        typeName: '',
        cards: []
      };
    }
    const cards = play && Array.isArray(play.cards)
      ? cardsTextList(play.cards)
      : (Array.isArray(s.cards) ? cardsTextList(s.cards) : []);
    return {
      action: 'play',
      play: play,
      reason: str(s.reason, '本地引擎建议出牌'),
      typeName: str(s.typeName, play && play.name ? play.name : ''),
      cards: cards
    };
  }

  /* ============================ 候选转换 ============================ */

  /** 由 GDSite.genMoves 兜底生成候选（调用方没传 suggestion 时） */
  function deriveCandidatesFromSite(state) {
    const site = getSite();
    if (!site || typeof site.genMoves !== 'function') return [];
    if (!Array.isArray(state.hand) || !state.hand.length) return [];
    // 只对数字牌 id 数组调用引擎；若是牌面文本则放弃兜底
    if (typeof state.hand[0] !== 'number') return [];
    try {
      // prevCode=0 表示领出；否则只返回能压的牌
      const moves = site.genMoves(state.hand, state.level, num(state.prevCode, 0));
      if (!Array.isArray(moves)) return [];
      return moves.map(function (play) { return { play: play }; });
    } catch (e) {
      return [];
    }
  }

  /** 把 {play,score,tag} 转成 GDDeepSeek 候选（编号 = 数组下标） */
  function makeCandidate(item, index) {
    const c = isObj(item) ? item : {};
    // 兼容两种候选：{play,score,tag} 包装；或直接就是 Play 对象
    const play = isObj(c.play) ? c.play
      : (isObj(item) && typeof item.code === 'number' && Array.isArray(item.cards) ? item : null);
    const cardsIds = play && Array.isArray(play.cards) ? play.cards : (Array.isArray(c.cards) ? c.cards : []);
    const noteParts = [];
    if (typeof c.tag === 'string' && c.tag) noteParts.push(c.tag);
    if (typeof c.score === 'number' && isFinite(c.score)) noteParts.push('本地评分 ' + c.score);
    if (!noteParts.length && typeof c.note === 'string' && c.note) noteParts.push(c.note);
    return {
      index: index,                                                        // 编号 = 数组下标（parseDecision 语义一致）
      typeName: (play && typeof play.name === 'string' && play.name) || str(c.typeName, '未知牌型'),
      name: (play && typeof play.name === 'string' && play.name) || str(c.name, ''),
      size: play && typeof play.size === 'number' ? play.size : cardsIds.length,
      bomb: play && typeof play.bomb === 'number' ? play.bomb : 0,
      cards: cardsTextList(cardsIds),
      note: noteParts.join('，'),
      play: play                                                                // 关键：GDDeepSeek.decide 靠它拿到真实 Play
    };
  }

  /* ============================ buildRequest ============================ */

  /**
   * buildRequest(input) -> GDDeepSeek 所需 request（SPEC2 §4）
   * input = { state: GDSiteAI.buildAIState 结果, suggestion: GDSiteAI.suggest 结果, counter? }
   * 不修改入参；缺失字段用安全默认。
   */
  function buildRequest(input) {
    const inp = isObj(input) ? input : {};
    const state = isObj(inp.state) ? inp.state : {};
    const suggestion = isObj(inp.suggestion) ? inp.suggestion : null;
    const counter = isObj(inp.counter) ? inp.counter
      : (isObj(state.counter) ? state.counter : null);

    const mySeat = num(state.mySeat, 1);
    const level = num(state.level, 2);
    const levelText = str(state.levelText, rankToText(level));
    const wildText = str(state.wildText, '红桃' + levelText);
    const mySeatName = str(state.mySeatName, '我');
    const partnerSeatName = str(state.partnerSeatName, '对家');
    const prevCode = num(state.prevCode, 0);
    const trickOwner = num(state.trickOwner, 0);

    // 手牌（牌面文本）：state.hand 是牌 id 数组；也兼容引擎直接给的 handText
    const hand = Array.isArray(state.hand)
      ? cardsTextList(state.hand)
      : (Array.isArray(state.handText) ? cardsTextList(state.handText) : []);

    // 上一手：优先用 buildAIState 直接给的 lastPlay 对象（站点引擎真实结构），
    // 其次用 prevCode/trickOwner/lastCards 推导；领出时为 null。
    const coreLastPlay = isObj(state.lastPlay) ? state.lastPlay : null;
    let lastPlay = null;
    if (coreLastPlay) {
      const lpCards = Array.isArray(coreLastPlay.cards) ? coreLastPlay.cards : [];
      const lpCode = num(coreLastPlay.code !== undefined ? coreLastPlay.code : prevCode, 0);
      lastPlay = {
        seatName: str(coreLastPlay.seatName, relSeatName(mySeat, coreLastPlay.seat) || ('座位' + coreLastPlay.seat)),
        name: str(coreLastPlay.name, typeNameOf(lpCode)),
        size: lpCards.length || num(coreLastPlay.size, 0),
        bomb: typeof coreLastPlay.bomb === 'number' ? coreLastPlay.bomb : bombValueOf(lpCode),
        cards: cardsTextList(lpCards)
      };
    } else {
      const lastCards = Array.isArray(state.lastCards) ? state.lastCards : [];
      if (trickOwner && prevCode && lastCards.length) {
        lastPlay = {
          seatName: relSeatName(mySeat, trickOwner) || ('座位' + trickOwner),
          name: typeNameOf(prevCode),
          size: lastCards.length,
          bomb: bombValueOf(prevCode),
          cards: cardsTextList(lastCards)
        };
      }
    }

    // 最近出牌历史（≤12 条，越靠后越新）
    const rawHistory = Array.isArray(state.history) ? state.history : [];
    const history = rawHistory.slice(-12).map(function (item) {
      const h = isObj(item) ? item : {};
      const passed = !!h.passed;
      const cards = cardsTextList(Array.isArray(h.cards) ? h.cards : []);
      const name = passed ? '' : str(h.name, '出牌');
      const seatName = str(h.seatName, relSeatName(mySeat, h.seat) || ('座位' + h.seat));
      const text = passed ? '过' : (name + (cards.length ? ' ' + cards.join(' ') : ''));
      return { seatName: seatName, action: passed ? '过' : '出牌', name: name, cards: cards, text: text };
    });

    // 各家剩余张数
    const rawSeats = Array.isArray(state.seatsRemaining) ? state.seatsRemaining : [];
    const seats = rawSeats.map(function (s) {
      const it = isObj(s) ? s : {};
      return {
        name: str(it.name, relSeatName(mySeat, it.seat) || '?'),
        count: num(it.count, 0)
      };
    });

    // 记牌器剩余（按点数聚合；count=remaining 表示其他人手里未知张数）
    // 优先 counter.byRank；兼容 buildAIState 直接给的 state.remaining 数组。
    let remaining = [];
    if (counter && Array.isArray(counter.byRank)) {
      remaining = counter.byRank.map(function (r) {
        const it = isObj(r) ? r : {};
        return { rankText: str(it.text, rankToText(it.rank)), count: pickCount(it) };
      });
    } else if (Array.isArray(state.remaining)) {
      remaining = state.remaining.map(function (r) {
        const it = isObj(r) ? r : {};
        return {
          rankText: str(it.rankText, str(it.text, rankToText(it.rank))),
          count: pickCount(it)
        };
      });
    }
    let wildRemaining = counter && typeof counter.wildRemaining === 'number'
      ? counter.wildRemaining
      : (typeof state.wildRemaining === 'number' ? state.wildRemaining : null);

    // 候选：优先本地建议的候选列表；缺失时尝试 GDSite.genMoves 兜底
    let candSource = suggestion && Array.isArray(suggestion.candidates)
      ? suggestion.candidates
      : deriveCandidatesFromSite(state);
    const candidates = (Array.isArray(candSource) ? candSource : []).map(makeCandidate);

    return {
      level: level,
      levelText: levelText,
      wildText: wildText,
      mySeat: mySeat,
      mySeatName: mySeatName,
      partnerSeatName: partnerSeatName,
      hand: hand,
      lastPlay: lastPlay,
      history: history,
      seats: seats,
      remaining: remaining,
      wildRemaining: wildRemaining,
      candidates: candidates,
      localSuggestion: suggestion ? toLocalSuggestion(suggestion) : null
    };
  }

  /* ============================ 回退构造 ============================ */

  /** 本地回退结果：action/play/reason 来自本地建议，error 说明原因 */
  function localResult(localSuggestion, errorMessage, reasonOverride) {
    const ls = isObj(localSuggestion) ? localSuggestion : SAFE_LOCAL;
    const error = str(errorMessage, 'DeepSeek 不可用，已回退本地建议');
    const reason = str(reasonOverride, str(ls.reason, '本地建议不可用'));
    if (ls.action === 'play' && isObj(ls.play)) {
      return { source: 'local', action: 'play', play: ls.play, reason: reason, error: error };
    }
    return { source: 'local', action: 'pass', play: null, reason: reason, error: error };
  }

  /* ============================ decide ============================ */

  /**
   * decide(input, config, opts?) -> {source, action, play, reason, raw?, error?}
   * request = buildRequest(input) -> GDDeepSeek.decide(request, config, {fetchImpl, localSuggestion})
   * 无 Key / 调用失败 / 解析失败 -> source:'local' 且 action/play 来自本地建议；绝不 throw。
   */
  async function decide(input, config, opts) {
    const options = isObj(opts) ? opts : {};
    const suggestion = isObj(input) ? input.suggestion : null;

    let localSuggestion = SAFE_LOCAL;
    try {
      localSuggestion = toLocalSuggestion(suggestion);
    } catch (e) {
      localSuggestion = SAFE_LOCAL;
    }

    try {
      const ds = getDeepseek();
      if (!ds) {
        return localResult(localSuggestion, 'DeepSeek 模块未加载（GDDeepSeek 缺失），已回退本地建议');
      }

      const request = buildRequest(input);
      const result = await ds.decide(request, config, {
        fetchImpl: options.fetchImpl,
        localSuggestion: localSuggestion
      });

      if (result && result.source === 'deepseek') {
        if (result.action === 'pass') {
          return {
            source: 'deepseek',
            action: 'pass',
            play: null,
            reason: str(result.reason, 'DeepSeek 建议不出'),
            raw: result.raw
          };
        }
        const play = isObj(result.play) ? result.play : null;
        if (play) {
          return {
            source: 'deepseek',
            action: 'play',
            play: play,
            reason: str(result.reason, 'DeepSeek 建议出 ' + (play.name || '牌')),
            raw: result.raw
          };
        }
        // 理论上不会发生（buildRequest 的候选都带 play）：安全回退本地
        return localResult(localSuggestion, 'DeepSeek 选择了候选但没有取到 Play，已回退本地建议');
      }

      // source:'local' —— 透传 GDDeepSeek 的回退结果，保留本地 action/play
      const localError = str(result && result.error, 'DeepSeek 未给出有效决策，已回退本地建议');
      return localResult(localSuggestion, localError, result && result.reason);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return localResult(localSuggestion, 'DeepSeek 调用异常，已回退本地建议：' + msg);
    }
  }

  /* ============================ testConnection ============================ */

  /**
   * testConnection(config, fetchImpl?) -> {ok, message, model?}
   * 永远返回结果对象，不 throw。
   */
  async function testConnection(config, fetchImpl) {
    try {
      const ds = getDeepseek();
      if (!ds || typeof ds.testConnection !== 'function') {
        return { ok: false, message: 'DeepSeek 模块未加载（GDDeepSeek 缺失）' };
      }
      const res = await ds.testConnection(config, fetchImpl);
      if (!res || typeof res !== 'object') {
        return { ok: false, message: '连接测试返回异常' };
      }
      const out = {
        ok: !!res.ok,
        message: str(res.message, res.ok ? '连接成功' : '连接失败')
      };
      if (res.model !== undefined && res.model !== null) out.model = res.model;
      return out;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { ok: false, message: '连接测试异常：' + msg };
    }
  }

  /* ============================ 导出 ============================ */

  const DEFAULTS = (function () {
    const ds = getDeepseek();
    const src = ds && isObj(ds.DEFAULTS) ? ds.DEFAULTS : FALLBACK_DEFAULTS;
    return {
      baseUrl: src.baseUrl,
      model: src.model,
      temperature: src.temperature,
      maxTokens: src.maxTokens,
      timeoutMs: src.timeoutMs
    };
  })();

  return {
    DEFAULTS: DEFAULTS,
    buildRequest: buildRequest,
    toLocalSuggestion: toLocalSuggestion,
    decide: decide,
    testConnection: testConnection
  };
});
