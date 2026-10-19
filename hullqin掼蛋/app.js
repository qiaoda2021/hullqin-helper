/* ============================================================
   掼蛋 AI 助手 · 页面逻辑（app.js）
   依赖（按顺序在 index.html 中加载）：gd.core.js → gd.ai.js → gd.deepseek.js
   全部模块缺失时页面依然可打开、可录入记录（降级但不白屏）。
   接口契约见同目录 SPEC.md。
   ============================================================ */
(function () {
  'use strict';

  /* ========================= 常量 ========================= */

  var STORAGE_STATE = 'gdAI.state';
  var STORAGE_SETTINGS = 'gdAI.settings';

  var SEAT_LABELS = ['我', '下家', '对家', '上家']; // 相对座位（0=我，逆时针）
  var SEAT_ABS_LABELS = ['1号位', '2号位', '3号位', '4号位']; // 绝对座位
  var SUIT_SYMS = ['♠', '♥', '♣', '♦'];
  var TYPE_NAMES = {
    single: '单张', pair: '对子', triple: '三同张', fullhouse: '三带二',
    straight: '顺子', tube: '三连对', plate: '钢板', bomb: '炸弹',
    straightflush: '同花顺', jokerbomb: '四大天王'
  };
  var RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  var RENDER_ERROR_SEEN = {};

  /* ========================= 基础工具 ========================= */

  function $(id) { return document.getElementById(id); }

  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string' && e.message) return e.message;
    try { return String(e); } catch (x) { return '未知错误'; }
  }

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function clampNum(v, min, max, dflt) {
    var n = parseFloat(v);
    if (!isFinite(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function uniqueList(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
    return out;
  }

  function queryFlag(name) {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get(name);
    } catch (e) { return null; }
  }

  function closestWithAttr(node, attr) {
    var el = node;
    while (el && el !== document) {
      if (el.getAttribute && el.hasAttribute && el.hasAttribute(attr)) return el;
      el = el.parentNode;
    }
    return null;
  }

  /* ========================= 卡片模型（SPEC §1） ========================= */

  function cardLocal(id) { return ((id - 1) % 54) + 1; }
  function cardDeck(id) { return Math.floor((id - 1) / 54); }

  function cardInfo(id) {
    var local = cardLocal(id);
    if (local > 52) {
      return { joker: true, suit: -1, rank: local === 53 ? 16 : 17, red: false, local: local };
    }
    var suit = Math.floor((local - 1) / 13);
    var idx = (local - 1) % 13;
    var rank = idx === 0 ? 14 : idx + 1;
    return { joker: false, suit: suit, rank: rank, red: suit === 1 || suit === 3, local: local };
  }

  function cardRank(id) { return cardInfo(id).rank; }
  function cardSuit(id) { return cardInfo(id).suit; }

  function rankText(rank) {
    if (rank === 16) return '小王';
    if (rank === 17) return '大王';
    return RANK_NAMES[rank] || String(rank);
  }

  function cardText(id) {
    var info = cardInfo(id);
    if (info.joker) return info.rank === 16 ? '小王' : '大王';
    return SUIT_SYMS[info.suit] + rankText(info.rank);
  }

  function cardTexts(ids) { return (ids || []).map(cardText); }

  function formatCards(cards) { return cardTexts(localSort(cards)).join(' '); }

  function isWildCard(id, level) {
    var info = cardInfo(id);
    return !info.joker && info.suit === 1 && info.rank === level;
  }

  function isLevelCard(id, level) {
    var info = cardInfo(id);
    return !info.joker && info.rank === level;
  }

  function heartLevelIds(level) {
    var idx = level === 14 ? 0 : level - 1;
    return [14 + idx, 68 + idx];
  }

  function levelOrderLocal(rank, level) {
    if (rank === 17) return 17;
    if (rank === 16) return 16;
    if (rank === level) return 15;
    return rank;
  }

  function localSort(list) {
    return (Array.isArray(list) ? list : []).slice().sort(function (a, b) {
      var ra = cardRank(a), rb = cardRank(b);
      if (ra !== rb) return ra - rb;
      var sa = cardSuit(a), sb = cardSuit(b);
      if (sa !== sb) return sa - sb;
      return a - b;
    });
  }

  /* ========================= 规则引擎封装（缺失时降级） ========================= */

  var coreError = null;

  function core() {
    var g = (typeof window !== 'undefined') ? window.GDEngine : null;
    return (g && typeof g === 'object') ? g : null;
  }

  function hasCore() { return !!core(); }
  function hasAI() {
    var a = (typeof window !== 'undefined') ? window.GDAI : null;
    return !!(a && typeof a === 'object' && typeof a.suggest === 'function');
  }
  function hasDeepSeek() {
    var ds = (typeof window !== 'undefined') ? window.GDDeepSeek : null;
    return !!(ds && typeof ds === 'object' && typeof ds.decide === 'function');
  }

  function callCoreOr(name, args, fallback) {
    var g = core();
    if (g && typeof g[name] === 'function') {
      try {
        var r = g[name].apply(g, args);
        if (r !== undefined) return r;
      } catch (e) { coreError = e; }
    }
    if (fallback) {
      try { return fallback.apply(null, args); } catch (e2) { return undefined; }
    }
    return undefined;
  }

  function sortCards(list) {
    var r = callCoreOr('sortCards', [localSort(list)], function (arr) { return localSort(arr); });
    return Array.isArray(r) ? r.slice() : localSort(list);
  }

  function parseCards(cards, level) {
    var r = callCoreOr('parseCards', [localSort(cards), level], fallbackParseCards);
    return Array.isArray(r) ? r : [];
  }

  function parseAll(cards, level) {
    var r = callCoreOr('parseAll', [localSort(cards), level], fallbackParseCards);
    return Array.isArray(r) ? r : [];
  }

  function parseAs(cards, level, type, rank) {
    var r = callCoreOr('parseAs', [localSort(cards), level, type, rank], function (cs, lv, tp) {
      var list = fallbackParseCards(cs, lv);
      for (var i = 0; i < list.length; i++) if (list[i].type === tp) return list[i];
      return null;
    });
    return r || null;
  }

  function canBeat(prev, next) {
    var r = callCoreOr('canBeat', [prev, next], fallbackCanBeat);
    if (typeof r === 'boolean') return r;
    return fallbackCanBeat(prev, next);
  }

  function genMoves(hand, level, lastPlay, opts) {
    var r = callCoreOr('genMoves', [hand.slice(), level, lastPlay, opts || {}], function (h, lv, lp) {
      return fallbackGenMoves(h, lv, lp);
    });
    return Array.isArray(r) ? r : [];
  }

  function dealHands(seed) {
    var r = callCoreOr('deal', [seed], fallbackDeal);
    return (r && Array.isArray(r.hands)) ? r : fallbackDeal(seed);
  }

  function levelOrder(rank, level) {
    var r = callCoreOr('levelOrder', [rank, level], levelOrderLocal);
    return typeof r === 'number' ? r : levelOrderLocal(rank, level);
  }

  /* ---------- 降级实现（引擎缺失/抛错时保证页面可用） ---------- */

  function makeFallbackPlay(type, cards, rank, level, bomb) {
    var sorted = localSort(cards);
    return {
      type: type,
      name: TYPE_NAMES[type] || '出牌',
      cards: sorted,
      size: sorted.length,
      rank: rank,
      order: levelOrderLocal(rank, level),
      bomb: bomb || 0,
      level: level,
      wilds: [],
      desc: (TYPE_NAMES[type] || '出牌') + ' ' + cardTexts(sorted).join(' ')
    };
  }

  function fallbackParseCards(cards, level) {
    var cs = localSort(cards);
    var n = cs.length;
    if (!n) return [];
    var ranks = cs.map(cardRank);
    var allSame = true;
    for (var i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[0]) { allSame = false; break; }
    var out = [];
    if (n === 1) out.push(makeFallbackPlay('single', cs, ranks[0], level, 0));
    else if (allSame && n === 2) out.push(makeFallbackPlay('pair', cs, ranks[0], level, 0));
    else if (allSame && n === 3) out.push(makeFallbackPlay('triple', cs, ranks[0], level, 0));
    else if (n === 4 && ranks.filter(function (r) { return r === 16; }).length === 2 &&
             ranks.filter(function (r) { return r === 17; }).length === 2) {
      out.push(makeFallbackPlay('jokerbomb', cs, 0, level, 99));
    } else if (allSame && n >= 4 && n <= 10) {
      out.push(makeFallbackPlay('bomb', cs, ranks[0], level, n));
    }
    return out;
  }

  function fallbackCanBeat(prev, next) {
    if (!prev) return true;
    if (!next) return false;
    var pb = prev.bomb > 0 ? prev.bomb : 0;
    var nb = next.bomb > 0 ? next.bomb : 0;
    if (nb > 0 || pb > 0) {
      if (nb > 0 && pb === 0) return true;
      if (nb === 0) return false;
      if (nb !== pb) return nb > pb;
      return (next.order || 0) > (prev.order || 0);
    }
    if (prev.type !== next.type || prev.size !== next.size) return false;
    return (next.order || 0) > (prev.order || 0);
  }

  function fallbackCounter(opts) {
    opts = opts || {};
    var level = opts.level;
    var myHand = opts.myHand || [];
    var played = opts.played || [];
    var mine = {}, ply = {};
    myHand.forEach(function (id) { var r = cardRank(id); mine[r] = (mine[r] || 0) + 1; });
    played.forEach(function (id) { var r = cardRank(id); ply[r] = (ply[r] || 0) + 1; });
    var order = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17];
    var byRank = order.map(function (rk) {
      var total = rk >= 16 ? 2 : 8;
      var p = ply[rk] || 0;
      var m = mine[rk] || 0;
      var rem = total - p - m;
      if (rem < 0) rem = 0;
      return { rank: rk, text: rankText(rk), total: total, played: p, mine: m, remaining: rem, isLevel: rk === level, isWild: rk === level };
    });
    var wildIds = heartLevelIds(level);
    var wildMine = 0, wildPlayed = 0;
    wildIds.forEach(function (id) {
      if (myHand.indexOf(id) >= 0) wildMine++;
      if (played.indexOf(id) >= 0) wildPlayed++;
    });
    var wildRemaining = 2 - wildMine - wildPlayed;
    if (wildRemaining < 0) wildRemaining = 0;
    var playedCount = played.length;
    var mineCount = myHand.length;
    return {
      byRank: byRank,
      wildRemaining: wildRemaining,
      total: 108,
      playedCount: playedCount,
      mineCount: mineCount,
      unknown: Math.max(0, 108 - playedCount - mineCount),
      ok: true,
      warnings: []
    };
  }

  function createRngLocal(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fallbackDeal(seed) {
    var rng = createRngLocal(seed);
    var ids = [];
    for (var i = 1; i <= 108; i++) ids.push(i);
    for (var j = ids.length - 1; j > 0; j--) {
      var k = Math.floor(rng() * (j + 1));
      var tmp = ids[j]; ids[j] = ids[k]; ids[k] = tmp;
    }
    return { hands: [ids.slice(0, 27), ids.slice(27, 54), ids.slice(54, 81), ids.slice(81, 108)], seed: seed };
  }

  function fallbackGenMoves(hand, level, lastPlay) {
    var out = [];
    var played = {};
    function push(ids) {
      var p = fallbackParseCards(ids, level)[0];
      if (!p) return;
      if (!fallbackCanBeat(lastPlay, p)) return;
      var key = p.type + '|' + p.size + '|' + p.order;
      if (played[key]) return;
      played[key] = true;
      out.push(p);
    }
    var groups = {};
    (hand || []).forEach(function (id) {
      var r = cardRank(id);
      (groups[r] || (groups[r] = [])).push(id);
    });
    var ranks = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    ranks.forEach(function (r) {
      var ids = groups[r].slice().sort(function (a, b) { return a - b; });
      if (r === 16 || r === 17) {
        if (ids.length >= 1) push([ids[0]]);
        if (ids.length >= 2) push([ids[0], ids[1]]);
        return;
      }
      var i, j;
      for (i = 0; i < ids.length; i++) push([ids[i]]);
      for (i = 0; i < ids.length; i++) for (j = i + 1; j < ids.length; j++) push([ids[i], ids[j]]);
      if (ids.length >= 3) push(ids.slice(0, 3));
      if (ids.length >= 4) for (var k = 4; k <= Math.min(10, ids.length); k++) push(ids.slice(0, k));
    });
    // 三带二
    ranks.forEach(function (tr) {
      if (tr === 16 || tr === 17) return;
      if (!groups[tr] || groups[tr].length < 3) return;
      ranks.forEach(function (pr) {
        if (pr === tr || pr === 16 || pr === 17) return;
        if (!groups[pr] || groups[pr].length < 2) return;
        push(groups[tr].slice(0, 3).concat(groups[pr].slice(0, 2)));
      });
    });
    // 四大天王
    if (groups[16] && groups[16].length >= 2 && groups[17] && groups[17].length >= 2) {
      push(groups[16].slice(0, 2).concat(groups[17].slice(0, 2)));
    }
    out.sort(function (a, b) {
      var ab = a.bomb > 0 ? 1 : 0, bb = b.bomb > 0 ? 1 : 0;
      if (ab !== bb) return ab - bb;
      return (a.order || 0) - (b.order || 0);
    });
    return out.slice(0, 60);
  }

  /* ========================= Play 规范化 ========================= */

  function ensurePlayShape(p) {
    if (!p || typeof p !== 'object') return null;
    var cards = resolveCardList(p.cards);
    if (!cards.length) return null;
    cards = localSort(cards);
    var type = typeof p.type === 'string' ? p.type : '';
    var name = typeof p.name === 'string' && p.name ? p.name : (TYPE_NAMES[type] || '出牌');
    var size = typeof p.size === 'number' ? p.size : cards.length;
    var rank = typeof p.rank === 'number' ? p.rank : 0;
    var order = typeof p.order === 'number' ? p.order : levelOrder(rank, currentLevel());
    var bomb = typeof p.bomb === 'number' ? p.bomb : 0;
    var desc = typeof p.desc === 'string' && p.desc ? p.desc : (name + ' ' + cardTexts(cards).join(' '));
    var wilds = Array.isArray(p.wilds) ? p.wilds : [];
    return {
      type: type || 'unknown', name: name, cards: cards, size: size, rank: rank,
      order: order, bomb: bomb, level: currentLevel(), wilds: wilds, desc: desc
    };
  }

  function currentLevel() { return state && state.level ? state.level : 2; }

  function makePlay(cards, level) {
    var cs = localSort((cards || []).map(Number).filter(function (n) { return n >= 1 && n <= 108; }));
    if (!cs.length) return null;
    var parsed = parseCards(cs, level);
    if (parsed.length) return ensurePlayShape(parsed[0]);
    var all = parseAll(cs, level);
    if (all.length) return ensurePlayShape(all[0]);
    return {
      type: 'unknown', name: '未识别牌型', cards: cs, size: cs.length, rank: 0, order: 0,
      bomb: 0, level: level, wilds: [], desc: '未识别牌型 ' + cardTexts(cs).join(' ')
    };
  }

  function normalizePlay(p) {
    if (!p || typeof p !== 'object') return null;
    var cards = resolveCardList(p.cards);
    if (!cards.length) return null;
    var cs = localSort(cards);
    var level = currentLevel();
    var type = typeof p.type === 'string' ? p.type : '';
    if (type) {
      var re = parseAs(cs, level, type, typeof p.rank === 'number' ? p.rank : undefined);
      if (re) return ensurePlayShape(re);
    }
    var parsed = parseCards(cs, level);
    if (parsed.length) {
      if (type) {
        for (var i = 0; i < parsed.length; i++) if (parsed[i].type === type) return ensurePlayShape(parsed[i]);
      }
      return ensurePlayShape(parsed[0]);
    }
    return makePlay(cs, level);
  }

  /* 把 AI 返回的牌面文本（如 '♠K'）映射回真实牌 id；数字 id 直接保留 */
  function resolveCardList(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (v) {
      if (typeof v === 'number' && v >= 1 && v <= 108 && Math.floor(v) === v) { out.push(v); return; }
      var s = String(v == null ? '' : v).trim();
      if (!s) return;
      var m = /^([♠♥♣♦])(10|[2-9JQKA])$/.exec(s);
      if (m) {
        var suit = SUIT_SYMS.indexOf(m[1]);
        var rank;
        if (m[2] === '10') rank = 10;
        else if (m[2] === 'J') rank = 11;
        else if (m[2] === 'Q') rank = 12;
        else if (m[2] === 'K') rank = 13;
        else if (m[2] === 'A') rank = 14;
        else rank = Number(m[2]);
        var id = findCardId(suit, rank, out);
        if (id) out.push(id);
        return;
      }
      if (s === '小王' || s === '小Joker' || s === 'SJ' || s === 'joker') {
        var id2 = findCardId(-1, 16, out);
        if (id2) out.push(id2);
        return;
      }
      if (s === '大王' || s === '大Joker' || s === 'BJ' || s === 'JOKER') {
        var id3 = findCardId(-1, 17, out);
        if (id3) out.push(id3);
        return;
      }
    });
    return out;
  }

  function findCardId(suit, rank, used) {
    var i, id, info;
    // 优先从手牌里找（AI 建议的牌必然来自手牌）
    var hand = (state && state.hand) ? state.hand : [];
    for (i = 0; i < hand.length; i++) {
      id = hand[i];
      if (used.indexOf(id) >= 0) continue;
      info = cardInfo(id);
      if (info.joker) { if (suit === -1 && info.rank === rank) return id; }
      else if (info.suit === suit && info.rank === rank) return id;
    }
    for (id = 1; id <= 108; id++) {
      if (used.indexOf(id) >= 0) continue;
      info = cardInfo(id);
      if (info.joker) { if (suit === -1 && info.rank === rank) return id; }
      else if (info.suit === suit && info.rank === rank) return id;
    }
    return 0;
  }

  /* ========================= Toast ========================= */

  var storageWarned = false;
  var toastSeq = 0;
  var toastRecent = {};

  function toast(msg, type, ms) {
    msg = String(msg == null ? '' : msg);
    if (!msg) return;
    type = type || 'info';
    var now = Date.now();
    if (toastRecent[msg] && now - toastRecent[msg] < 900) return;
    toastRecent[msg] = now;
    var root = $('toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    var icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '⛔' };
    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || 'ℹ️';
    var body = document.createElement('span');
    body.className = 'toast-msg';
    body.textContent = msg;
    el.appendChild(icon);
    el.appendChild(body);
    root.appendChild(el);
    var id = ++toastSeq;
    el.setAttribute('data-toast-id', String(id));
    while (root.children.length > 4) root.removeChild(root.firstChild);
    var life = ms && ms > 0 ? ms : (type === 'error' ? 6500 : type === 'warn' ? 5000 : 3200);
    setTimeout(function () {
      try {
        el.classList.add('toast-out');
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 240);
      } catch (e) { /* ignore */ }
    }, life);
  }

  /* ========================= localStorage ========================= */

  function storageGet(key) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        toast('浏览器 localStorage 不可用，状态无法保存（刷新后会丢失）。', 'warn');
      }
      return false;
    }
  }

  /* ========================= 状态 ========================= */

  var state = null;          // {level, mySeat, hand, history}
  var settings = null;       // {apiKey, baseUrl, model, temperature, maxTokens, timeoutMs}
  var currentSuggestion = null;
  var recordSel = { seat: 0, cards: [], pass: false };
  var handSel = [];
  var activeModalId = null;
  var lastFocus = null;
  var deepseekBusy = false;
  var requestSeq = 0;
  var aiWarned = false;

  function defaultState() { return { level: 2, mySeat: 0, hand: [], history: [] }; }

  function sanitizeCards(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) {
      var id = Number(v);
      if (id >= 1 && id <= 108 && Math.floor(id) === id && !seen[id]) { seen[id] = true; out.push(id); }
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function isValidLevel(v) {
    return typeof v === 'number' && Math.floor(v) === v && v >= 2 && v <= 14;
  }

  function loadStateFromStorage() {
    state = defaultState();
    var saved = storageGet(STORAGE_STATE);
    if (!saved || typeof saved !== 'object') return;
    if (isValidLevel(saved.level)) state.level = saved.level;
    if (typeof saved.mySeat === 'number' && Math.floor(saved.mySeat) === saved.mySeat && saved.mySeat >= 0 && saved.mySeat <= 3) {
      state.mySeat = saved.mySeat;
    }
    if (Array.isArray(saved.hand)) state.hand = sanitizeCards(saved.hand);
    if (Array.isArray(saved.history)) {
      state.history = [];
      saved.history.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var seat = Number(e.seat);
        if (!(seat >= 0 && seat <= 3)) return;
        var action = e.action === 'pass' ? 'pass' : 'play';
        var cards = sanitizeCards(e.cards || []);
        if (action === 'play' && !cards.length) return;
        state.history.push({
          seat: seat,
          action: action,
          cards: action === 'play' ? cards : [],
          play: (action === 'play' && e.play && typeof e.play === 'object') ? e.play : null
        });
      });
    }
  }

  function saveState() {
    return storageSet(STORAGE_STATE, {
      level: state.level,
      mySeat: state.mySeat,
      hand: state.hand.slice(),
      history: state.history
    });
  }

  function reparseHistory() {
    (state.history || []).forEach(function (e) {
      if (e.action !== 'play') { e.cards = []; e.play = null; return; }
      e.cards = sanitizeCards(e.cards || []);
      e.play = makePlay(e.cards, state.level);
    });
  }

  function relOf(seat) { return ((seat - state.mySeat) % 4 + 4) % 4; }
  function relLabel(seat) { return SEAT_LABELS[relOf(seat)]; }
  function seatFullLabel(seat) { return relLabel(seat) + '（' + SEAT_ABS_LABELS[seat] + '）'; }

  function derive() {
    var played = [];
    var playedBySeat = [0, 0, 0, 0];
    var hist = state.history || [];
    hist.forEach(function (e) {
      if (e.action === 'play' && Array.isArray(e.cards)) {
        played = played.concat(e.cards);
        if (e.seat >= 0 && e.seat < 4) playedBySeat[e.seat] += e.cards.length;
      }
    });
    var playedSet = {};
    played.forEach(function (id) { playedSet[id] = true; });

    var lastIdx = -1;
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i].action === 'play') { lastIdx = i; break; }
    }
    var lastPlayEntry = lastIdx >= 0 ? hist[lastIdx] : null;
    var passesAfter = 0;
    for (var k = lastIdx + 1; k < hist.length; k++) {
      if (hist[k].action === 'pass') passesAfter++;
    }
    var newTrick = !!(lastPlayEntry && passesAfter >= 3);
    var lastPlay = (lastPlayEntry && !newTrick) ? lastPlayEntry.play : null;
    var lastPlaySeat = (lastPlayEntry && !newTrick) ? lastPlayEntry.seat : null;
    var seatsRemaining = {};
    for (var s = 0; s < 4; s++) seatsRemaining[s] = Math.max(0, 27 - playedBySeat[s]);

    return {
      played: played,
      playedSet: playedSet,
      playedBySeat: playedBySeat,
      lastPlayEntry: lastPlayEntry,
      lastPlay: lastPlay,
      lastPlaySeat: lastPlaySeat,
      newTrick: newTrick,
      trickLeader: newTrick && lastPlayEntry ? lastPlayEntry.seat : null,
      seatsRemaining: seatsRemaining,
      myHand: state.hand.slice()
    };
  }

  function buildAIState(d) {
    d = d || derive();
    var seats = {};
    for (var i = 0; i < 4; i++) seats[i] = d.seatsRemaining[i] || 0;
    return {
      level: state.level,
      mySeat: state.mySeat,
      hand: state.hand.slice(),
      lastPlay: d.lastPlay,
      lastPlaySeat: d.lastPlaySeat,
      seatsRemaining: seats
    };
  }

  function buildCounter() {
    var d = derive();
    var opts = { level: state.level, myHand: state.hand.slice(), played: d.played.slice() };
    var r = callCoreOr('counter', [opts], fallbackCounter);
    if (!r || !Array.isArray(r.byRank)) r = fallbackCounter(opts);
    r.total = 108;
    if (typeof r.playedCount !== 'number') r.playedCount = d.played.length;
    if (typeof r.mineCount !== 'number') r.mineCount = state.hand.length;
    if (typeof r.unknown !== 'number') r.unknown = Math.max(0, 108 - r.playedCount - r.mineCount);
    if (typeof r.wildRemaining !== 'number') r.wildRemaining = 0;
    if (!Array.isArray(r.warnings)) r.warnings = [];
    return r;
  }

  /* ========================= 弹窗 ========================= */

  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    if (activeModalId && activeModalId !== id) closeModal(activeModalId);
    lastFocus = document.activeElement;
    m.hidden = false;
    document.body.classList.add('modal-open');
    activeModalId = id;
    try {
      var first = m.querySelector('input, select, textarea, button');
      if (first && first.focus) first.focus();
    } catch (e) { /* ignore */ }
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = true;
    if (activeModalId === id) activeModalId = null;
    var any = false;
    var backs = document.querySelectorAll('.modal-backdrop');
    for (var i = 0; i < backs.length; i++) if (!backs[i].hidden) any = true;
    if (!any) document.body.classList.remove('modal-open');
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  /* ========================= 渲染：通用 ========================= */

  function cardEl(id, size) {
    var info = cardInfo(id);
    var el = document.createElement('span');
    el.className = 'card' + (size ? ' ' + size : '') + (info.joker ? ' joker' : (info.red ? ' red' : ' black'));
    if (isWildCard(id, state.level)) el.classList.add('wild');
    if (info.joker) {
      var rankSpan = document.createElement('span');
      rankSpan.className = 'card-rank';
      rankSpan.textContent = info.rank === 16 ? '小王' : '大王';
      el.appendChild(rankSpan);
    } else {
      var rankSpan2 = document.createElement('span');
      rankSpan2.className = 'card-rank';
      rankSpan2.textContent = rankText(info.rank);
      var suitSpan = document.createElement('span');
      suitSpan.className = 'card-suit';
      suitSpan.textContent = SUIT_SYMS[info.suit];
      el.appendChild(rankSpan2);
      el.appendChild(suitSpan);
    }
    el.title = cardText(id) + ' · 第' + (cardDeck(id) + 1) + '副';
    return el;
  }

  function safeRender(name, fn) {
    try {
      fn();
    } catch (e) {
      var key = name + '|' + errText(e);
      if (!RENDER_ERROR_SEEN[key]) {
        RENDER_ERROR_SEEN[key] = true;
        toast('界面渲染出错（' + name + '）：' + errText(e), 'error');
      }
    }
  }

  function renderAll() {
    safeRender('topbar', renderTopbar);
    safeRender('counter', renderCounter);
    safeRender('hand', renderHand);
    safeRender('ai', renderAI);
    safeRender('history', renderHistory);
  }

  function renderTopbar() {
    var levelSel = $('level-select');
    if (levelSel) levelSel.value = String(state.level);
    var seatSel = $('seat-select');
    if (seatSel) seatSel.value = String(state.mySeat);
  }

  /* ========================= 渲染：记牌器 ========================= */

  function renderCounter() {
    var counter = buildCounter();
    var grid = $('counter-grid');
    if (grid) {
      grid.innerHTML = '';
      var frag = document.createDocumentFragment();
      (counter.byRank || []).forEach(function (row) {
        var cell = document.createElement('div');
        cell.className = 'counter-cell' + (row.remaining === 0 ? ' zero' : '') + (row.isLevel ? ' is-level' : '');
        cell.title = row.text + '：总 ' + row.total + ' 张 · 已出 ' + row.played + ' 张 · 我手 ' + row.mine + ' 张 · 未知 ' + row.remaining + ' 张';
        var rankSpan = document.createElement('span');
        rankSpan.className = 'counter-rank' + (row.rank >= 16 ? ' joker-rank' : '');
        rankSpan.textContent = row.text;
        var countSpan = document.createElement('span');
        countSpan.className = 'counter-count';
        countSpan.textContent = '×' + row.remaining;
        cell.appendChild(rankSpan);
        cell.appendChild(countSpan);
        if (row.isLevel || row.isWild) {
          var badges = document.createElement('span');
          badges.className = 'counter-badges';
          if (row.isLevel) {
            var lv = document.createElement('span');
            lv.className = 'mini-badge level';
            lv.textContent = '级';
            badges.appendChild(lv);
          }
          if (row.isWild) {
            var wd = document.createElement('span');
            wd.className = 'mini-badge wild';
            wd.textContent = '配';
            badges.appendChild(wd);
          }
          cell.appendChild(badges);
        }
        frag.appendChild(cell);
      });
      grid.appendChild(frag);
    }
    var summary = $('counter-summary');
    if (summary) {
      summary.textContent = '未知 ' + counter.unknown + ' 张 · 已出 ' + counter.playedCount +
        ' 张 · 我手 ' + counter.mineCount + ' 张 · 逢人配 ♥' + rankText(state.level) + ' ×' + counter.wildRemaining;
    }
    var warn = $('counter-warnings');
    if (warn) {
      if (counter.warnings && counter.warnings.length) {
        warn.hidden = false;
        warn.textContent = '⚠️ ' + counter.warnings.join('；');
      } else {
        warn.hidden = true;
        warn.textContent = '';
      }
    }
  }

  /* ========================= 渲染：我的手牌 ========================= */

  function renderHand() {
    var n = state.hand.length;
    var countEl = $('hand-count');
    if (countEl) countEl.textContent = n + ' 张';

    var wrap = $('hand-cards');
    if (wrap) {
      wrap.innerHTML = '';
      sortCards(state.hand).forEach(function (id) { wrap.appendChild(cardEl(id, '')); });
    }
    var empty = $('hand-empty');
    if (empty) empty.hidden = n > 0;

    var stats = $('hand-stats');
    if (!stats) return;
    if (!n) { stats.textContent = ''; return; }
    var parts = ['共 ' + n + ' 张'];
    var wilds = state.hand.filter(function (id) { return isWildCard(id, state.level); }).length;
    if (wilds) parts.push('逢人配 ♥' + rankText(state.level) + ' ×' + wilds);
    try {
      var ai = window.GDAI;
      if (hasAI() && ai && typeof ai.handSummary === 'function') {
        var hs = ai.handSummary(state.hand.slice(), state.level);
        if (hs) {
          if (typeof hs.playsEstimate === 'number') parts.push('估计 ' + hs.playsEstimate + ' 手');
          if (Array.isArray(hs.bombs) && hs.bombs.length) parts.push('炸弹 ' + hs.bombs.length + ' 个');
        }
      }
    } catch (e) { /* 降级：不显示估算 */ }
    stats.textContent = parts.join(' · ');
  }

  /* ========================= 渲染：出牌记录 ========================= */

  function renderHistory() {
    var list = $('history-list');
    var countEl = $('history-count');
    if (countEl) countEl.textContent = state.history.length + ' 手';
    var empty = $('history-empty');
    if (empty) empty.hidden = state.history.length > 0;
    if (!list) return;
    list.innerHTML = '';
    var frag = document.createDocumentFragment();
    state.history.forEach(function (e, i) {
      var row = document.createElement('div');
      row.className = 'history-row';

      var idx = document.createElement('span');
      idx.className = 'hist-index';
      idx.textContent = '#' + (i + 1);

      var tag = document.createElement('span');
      tag.className = 'seat-tag rel-' + relOf(e.seat);
      tag.textContent = relLabel(e.seat);
      tag.title = seatFullLabel(e.seat);

      var body = document.createElement('div');
      body.className = 'hist-body';
      var line = document.createElement('div');
      line.className = 'hist-line';

      if (e.action === 'pass') {
        var passSpan = document.createElement('span');
        passSpan.className = 'hist-action pass';
        passSpan.textContent = '过';
        line.appendChild(passSpan);
      } else {
        var act = document.createElement('span');
        act.className = 'hist-action';
        act.textContent = '出牌';
        line.appendChild(act);
        if (e.play && e.play.name) {
          var nameSpan = document.createElement('span');
          nameSpan.className = 'hist-name';
          nameSpan.textContent = e.play.name;
          line.appendChild(nameSpan);
        }
        var cardsWrap = document.createElement('span');
        cardsWrap.className = 'hist-cards';
        sortCards(e.cards || []).forEach(function (id) { cardsWrap.appendChild(cardEl(id, 'small')); });
        line.appendChild(cardsWrap);
      }
      body.appendChild(line);

      if (e.action === 'play' && e.play) {
        var needDesc = (e.play.wilds && e.play.wilds.length) || e.play.type === 'unknown' ||
          (e.play.desc && e.play.desc.indexOf('配') >= 0);
        if (needDesc && e.play.desc) {
          var desc = document.createElement('div');
          desc.className = 'hist-desc';
          desc.textContent = e.play.desc;
          body.appendChild(desc);
        }
      }

      row.appendChild(idx);
      row.appendChild(tag);
      row.appendChild(body);
      frag.appendChild(row);
    });
    list.appendChild(frag);
    try { list.scrollTop = list.scrollHeight; } catch (e) { /* ignore */ }
  }

  /* ========================= 渲染：AI 面板 ========================= */

  function renderAI() {
    renderAIMeta();
    renderAIButtons();
    renderSuggestion(currentSuggestion);
  }

  function renderAIMeta() {
    var d = derive();
    var badge = $('ai-level-badge');
    if (badge) badge.textContent = '级牌 ' + rankText(state.level) + ' · 逢人配 ♥' + rankText(state.level);

    var lp = $('ai-lastplay');
    if (lp) {
      lp.innerHTML = '';
      function txt(t, cls) {
        var s = document.createElement('span');
        if (cls) s.className = cls;
        s.textContent = t;
        return s;
      }
      if (d.newTrick && d.trickLeader != null) {
        lp.appendChild(txt('上一手：', 'last-play-title'));
        lp.appendChild(txt('新一轮，由 ', 'last-play-seat'));
        lp.appendChild(txt(seatFullLabel(d.trickLeader), 'last-play-name'));
        lp.appendChild(txt(' 领出', 'last-play-seat'));
      } else if (d.lastPlayEntry) {
        var e = d.lastPlayEntry;
        lp.appendChild(txt('上一手：', 'last-play-title'));
        lp.appendChild(txt(seatFullLabel(e.seat) + ' ', 'last-play-name'));
        if (e.play && e.play.name) lp.appendChild(txt(e.play.name + ' ', 'last-play-seat'));
        var cardsWrap = document.createElement('span');
        cardsWrap.className = 'last-play-cards';
        sortCards(e.cards || []).forEach(function (id) { cardsWrap.appendChild(cardEl(id, 'small')); });
        lp.appendChild(cardsWrap);
        if (e.play && e.play.bomb > 0) lp.appendChild(txt(' 💣', 'last-play-seat'));
      } else {
        lp.appendChild(txt('上一手：', 'last-play-title'));
        lp.appendChild(txt('—（尚未记录出牌）', 'last-play-seat'));
      }
    }

    var seatsEl = $('ai-seats');
    if (seatsEl) {
      seatsEl.innerHTML = '';
      for (var rel = 0; rel < 4; rel++) {
        var abs = (state.mySeat + rel) % 4;
        var cnt = d.seatsRemaining[abs] || 0;
        var chip = document.createElement('span');
        chip.className = 'seat-chip' + (rel === 0 ? ' me' : '') + (rel !== 0 && cnt <= 3 ? ' danger' : '');
        chip.title = SEAT_ABS_LABELS[abs] + ' · 剩余 ' + cnt + ' 张';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'seat-name';
        nameSpan.textContent = SEAT_LABELS[rel];
        var cntSpan = document.createElement('span');
        cntSpan.className = 'seat-count';
        cntSpan.textContent = String(cnt);
        chip.appendChild(nameSpan);
        chip.appendChild(cntSpan);
        seatsEl.appendChild(chip);
      }
    }
  }

  function renderAIButtons() {
    var localBtn = $('btn-local-suggest');
    if (localBtn) {
      localBtn.disabled = deepseekBusy || (!hasAI() && !hasCore());
      localBtn.title = hasAI() ? '使用本地启发式引擎生成建议' :
        (hasCore() ? '本地 AI 未加载，将使用规则引擎兜底建议' : '缺少规则引擎与本地 AI，无法给出建议');
    }
    var dsBtn = $('btn-deepseek-suggest');
    if (dsBtn) {
      dsBtn.disabled = deepseekBusy || !hasDeepSeek();
      dsBtn.title = hasDeepSeek() ? '调用 DeepSeek API 生成建议' : 'gd.deepseek.js 未加载，DeepSeek 建议不可用';
    }
    var tip = $('ai-tip');
    if (tip) {
      if (!hasDeepSeek()) {
        tip.textContent = '⚠️ 缺少 gd.deepseek.js：DeepSeek 建议不可用，本地建议仍然可用。';
      } else if (!settings || !settings.apiKey) {
        tip.textContent = 'DeepSeek 建议需要先在「设置」中填写 API Key（本地建议无需配置）。';
      } else {
        tip.textContent = 'DeepSeek 建议会把当前手牌与局面发送到 DeepSeek 官方 API；失败时自动回退本地建议。';
      }
    }
    var loading = $('ai-loading');
    if (loading) loading.setAttribute('aria-busy', deepseekBusy ? 'true' : 'false');
  }

  function renderSuggestion(sug) {
    currentSuggestion = sug || null;
    var box = $('ai-result');
    if (!box) return;
    if (!sug) { box.hidden = true; return; }
    box.hidden = false;

    var badgeEl = $('ai-source-badge');
    if (badgeEl) {
      if (sug.source === 'deepseek') {
        badgeEl.className = 'source-badge deepseek';
        badgeEl.textContent = 'DeepSeek';
      } else if (sug.fallback) {
        badgeEl.className = 'source-badge fallback';
        badgeEl.textContent = '本地引擎（已回退）';
      } else {
        badgeEl.className = 'source-badge local';
        badgeEl.textContent = '本地引擎';
      }
    }

    var title = $('ai-result-title');
    if (title) {
      title.textContent = sug.action === 'pass'
        ? '建议：不出（过）'
        : '建议出牌：' + (sug.play && sug.play.name ? sug.play.name : '出牌');
    }

    var cardsBox = $('ai-result-cards');
    if (cardsBox) {
      cardsBox.innerHTML = '';
      if (sug.action === 'pass') {
        var pill = document.createElement('span');
        pill.className = 'pass-pill';
        pill.textContent = '不出';
        cardsBox.appendChild(pill);
      } else if (sug.play && sug.play.cards && sug.play.cards.length) {
        localSort(sug.play.cards).forEach(function (id) { cardsBox.appendChild(cardEl(id, 'big')); });
      } else {
        var none = document.createElement('span');
        none.className = 'muted';
        none.textContent = '（没有具体牌面）';
        cardsBox.appendChild(none);
      }
    }

    var reasonEl = $('ai-result-reason');
    if (reasonEl) reasonEl.textContent = sug.reason || '（无理由说明）';

    var errEl = $('ai-result-error');
    if (errEl) {
      var errs = [];
      if (sug.error) errs.push(sug.error);
      if (sug.displayError) errs.push(sug.displayError);
      if (errs.length) {
        errEl.hidden = false;
        errEl.textContent = '⚠️ ' + errs.join(' ');
      } else {
        errEl.hidden = true;
        errEl.textContent = '';
      }
    }

    var candWrap = $('ai-candidates');
    var candList = $('ai-cand-list');
    if (candWrap && candList) {
      candList.innerHTML = '';
      var cands = Array.isArray(sug.candidates) ? sug.candidates.filter(function (c) { return c && c.play; }) : [];
      if (cands.length) {
        candWrap.hidden = false;
        cands.forEach(function (c, i) {
          var row = document.createElement('div');
          row.className = 'cand-row';
          var score = document.createElement('span');
          score.className = 'cand-score';
          score.textContent = (typeof c.score === 'number' ? c.score.toFixed(1) : '-');
          var txt = document.createElement('span');
          txt.className = 'cand-play';
          txt.textContent = (i + 1) + '. ' + (c.play.name || '出牌') + ' ' + formatCards(c.play.cards || []);
          row.appendChild(score);
          row.appendChild(txt);
          candList.appendChild(row);
        });
      } else {
        candWrap.hidden = true;
      }
    }

    var rawWrap = $('ai-raw-wrap');
    var rawEl = $('ai-raw');
    if (rawWrap && rawEl) {
      if (sug.raw && sug.source === 'deepseek') {
        rawWrap.hidden = false;
        rawEl.textContent = String(sug.raw);
      } else {
        rawWrap.hidden = true;
        rawEl.textContent = '';
      }
    }

    var adoptBtn = $('btn-adopt');
    if (adoptBtn) {
      var canAdopt = !!sug.valid;
      if (sug.action === 'play' && (!sug.play || !sug.play.cards || !sug.play.cards.length)) canAdopt = false;
      adoptBtn.disabled = !canAdopt;
      adoptBtn.textContent = canAdopt ? '✅ 采用并记录' : '⚠️ 不可采用';
    }
    var copyBtn = $('btn-copy');
    if (copyBtn) {
      copyBtn.disabled = !(sug.action === 'play' && sug.play && sug.play.cards && sug.play.cards.length);
    }
  }

  /* ========================= 建议构造 ========================= */

  function buildSuggestion(source, action, play, reason, candidates, extra) {
    extra = extra || {};
    var sug = {
      source: source === 'deepseek' ? 'deepseek' : 'local',
      action: action === 'play' ? 'play' : 'pass',
      play: play || null,
      reason: reason || '',
      candidates: Array.isArray(candidates) ? candidates.filter(function (c) { return c && c.play; }) : [],
      raw: extra.raw || null,
      error: extra.error || null,
      fallback: !!extra.fallback,
      valid: true,
      displayError: null
    };
    if (sug.play) sug.play = normalizePlay(sug.play);
    if (sug.action === 'play') {
      if (!sug.play || !sug.play.cards || !sug.play.cards.length) {
        sug.valid = false;
        sug.displayError = '建议缺少具体出牌，无法采用。';
      } else {
        var handSet = {};
        state.hand.forEach(function (id) { handSet[id] = true; });
        var bad = sug.play.cards.filter(function (id) { return !handSet[id]; });
        if (bad.length) {
          sug.valid = false;
          sug.displayError = '建议中的牌不在你的手牌中：' + cardTexts(bad).join(' ') + '。请先更新手牌。';
        }
      }
    }
    if (sug.valid) {
      var d = derive();
      if (sug.action === 'pass') {
        if (!d.lastPlay) {
          sug.valid = false;
          sug.displayError = '当前是领出（没有需要压的上一手），不能「过」。';
        }
      } else if (d.lastPlay && sug.play) {
        if (!canBeat(d.lastPlay, sug.play)) {
          sug.valid = false;
          sug.displayError = '该建议压不过上一手（' + (d.lastPlay.name || '出牌') + '）。';
        }
      }
    }
    return sug;
  }

  function normalizeCandidates(list, limit) {
    var d = derive();
    var handSet = {};
    state.hand.forEach(function (id) { handSet[id] = true; });
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || !item.play) return;
      var p = normalizePlay(item.play);
      if (!p || !p.cards || !p.cards.length) return;
      var okCards = p.cards.every(function (id) { return handSet[id]; });
      if (!okCards) return;
      if (d.lastPlay && !canBeat(d.lastPlay, p)) return;
      out.push({ play: p, score: typeof item.score === 'number' ? item.score : 0 });
    });
    return out.slice(0, limit || 12);
  }

  function getLocalSuggestion() {
    if (!state.hand.length) return null;
    var d = derive();
    if (hasAI()) {
      try {
        var raw = window.GDAI.suggest(buildAIState(d));
        if (raw && typeof raw === 'object') return normalizeAISuggestion(raw, d);
      } catch (e) {
        coreError = e;
        if (!aiWarned) {
          aiWarned = true;
          toast('本地 AI 计算出错，已使用规则引擎兜底：' + errText(e), 'warn');
        }
      }
    }
    return engineSuggestion(d);
  }

  function normalizeAISuggestion(raw, d) {
    var action = (raw.action === 'play' || raw.action === 'pass') ? raw.action : (raw.play ? 'play' : 'pass');
    var play = raw.play ? normalizePlay(raw.play) : null;
    var cands = normalizeCandidates(raw.candidates, 12);
    if (action === 'play' && !play && cands.length) play = cands[0].play;
    if (action === 'play' && !play) return engineSuggestion(d);
    var reason = (typeof raw.reason === 'string' && raw.reason) ? raw.reason : '';
    return buildSuggestion('local', action, play, reason, cands, {});
  }

  function engineSuggestion(d) {
    d = d || derive();
    var moves;
    try {
      moves = genMoves(state.hand, state.level, d.lastPlay, {});
    } catch (e) {
      moves = fallbackGenMoves(state.hand, state.level, d.lastPlay);
    }
    if (!Array.isArray(moves) || !moves.length) {
      return buildSuggestion('local', 'pass', null,
        d.lastPlay ? '没有能压过上一手的牌，建议不出。' : '当前没有可出的牌。', []);
    }
    var sorted = moves.slice().sort(function (a, b) {
      var ab = a.bomb > 0 ? 1 : 0, bb = b.bomb > 0 ? 1 : 0;
      if (ab !== bb) return ab - bb;
      if (d.lastPlay) {
        if (a.size !== b.size) return a.size - b.size;
        return (a.order || 0) - (b.order || 0);
      }
      if (a.size !== b.size) return b.size - a.size;
      return (a.order || 0) - (b.order || 0);
    });
    var pick = sorted[0];
    var reason = (d.lastPlay ? '用较小的牌压过上一手' : '优先出掉张数更多的组合，减少手数') +
      '（本地 AI 模块未加载，使用规则引擎兜底）。';
    var cands = sorted.slice(0, 12).map(function (p) { return { play: p, score: 0 }; });
    return buildSuggestion('local', 'play', pick, reason, cands, {});
  }

  function getCandidates(limit) {
    limit = limit || 12;
    var d = derive();
    var list = [];
    if (hasAI()) {
      try {
        var raw = window.GDAI.candidates(buildAIState(d), limit);
        if (Array.isArray(raw)) list = raw;
      } catch (e) { coreError = e; }
    }
    if (!list.length) {
      try {
        var moves = genMoves(state.hand, state.level, d.lastPlay, { limit: limit });
        if (Array.isArray(moves)) list = moves.map(function (p) { return { play: p, score: 0 }; });
      } catch (e2) { list = []; }
    }
    return normalizeCandidates(list, limit);
  }

  function setLoading(on, text) {
    var box = $('ai-loading');
    if (box) box.hidden = !on;
    var label = $('ai-loading-text');
    if (label) label.textContent = text || '正在请求 DeepSeek…';
    if (on) {
      var lb = $('btn-local-suggest');
      if (lb) lb.disabled = true;
      var db = $('btn-deepseek-suggest');
      if (db) db.disabled = true;
    } else {
      renderAIButtons();
    }
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('请求超时（' + Math.round(ms / 1000) + ' 秒）')); }
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      }, function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  /* ---------- 本地建议 ---------- */

  function doLocalSuggest() {
    if (!state.hand.length) {
      toast('请先在「我的手牌」录入 27 张手牌，再获取出牌建议。', 'warn');
      return;
    }
    var sug = null;
    try { sug = getLocalSuggestion(); } catch (e) { sug = null; }
    if (!sug) {
      toast('本地建议生成失败：' + (hasAI() ? '本地 AI 模块异常。' : '缺少本地 AI 与规则引擎。'), 'error');
      return;
    }
    renderSuggestion(sug);
  }

  /* ---------- DeepSeek 建议 ---------- */

  function buildDeepSeekRequest(d, candidates, localPayload) {
    var hist = state.history.slice(-8).map(function (e) {
      return {
        seatName: relLabel(e.seat),
        action: e.action === 'pass' ? '过' : '出牌',
        name: e.action === 'pass' ? '' : (e.play && e.play.name ? e.play.name : ''),
        cards: e.action === 'play' ? cardTexts(sortCards(e.cards || [])) : []
      };
    });
    var lastPlay = null;
    if (d.lastPlayEntry && d.lastPlay) {
      var e = d.lastPlayEntry;
      lastPlay = {
        seatName: relLabel(e.seat),
        name: d.lastPlay.name || '出牌',
        size: d.lastPlay.size || (e.cards || []).length,
        bomb: d.lastPlay.bomb || 0,
        cards: cardTexts(sortCards(d.lastPlay.cards || e.cards || []))
      };
    }
    var counter = buildCounter();
    var seats = [];
    for (var rel = 0; rel < 4; rel++) {
      var abs = (state.mySeat + rel) % 4;
      seats.push({ name: SEAT_LABELS[rel], count: d.seatsRemaining[abs] || 0 });
    }
    return {
      level: state.level,
      levelText: rankText(state.level),
      wildText: '红桃' + rankText(state.level),
      mySeatName: '我',
      partnerSeatName: '对家',
      hand: cardTexts(sortCards(state.hand)),
      lastPlay: lastPlay,
      history: hist,
      seats: seats,
      remaining: (counter.byRank || []).map(function (r) { return { rankText: r.text, count: r.remaining }; }),
      candidates: (candidates || []).map(function (c, i) {
        return {
          index: i,
          typeName: c.play.name || '出牌',
          size: c.play.size || (c.play.cards || []).length,
          bomb: c.play.bomb || 0,
          cards: cardTexts(sortCards(c.play.cards)),
          note: '',
          // 以下为辅助字段：方便 gd.deepseek.js 把 choice 还原成 Play（SPEC 未禁止额外字段）
          cardIds: sortCards(c.play.cards),
          play: c.play
        };
      }),
      localSuggestion: localPayload
    };
  }

  function readChoiceIndex(res) {
    var keys = ['choice', 'candidateIndex', 'candidate', 'index', 'selected'];
    for (var i = 0; i < keys.length; i++) {
      var v = res[keys[i]];
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
    }
    return null;
  }

  function matchChoiceByReason(reason, candidates) {
    if (!reason || !candidates || !candidates.length) return null;
    var normalized = String(reason).replace(/\s+/g, '');
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i].play;
      if (!p || !p.cards) continue;
      var text = cardTexts(sortCards(p.cards)).join('').replace(/\s+/g, '');
      if (text && normalized.indexOf(text) >= 0) return i;
    }
    return null;
  }

  function interpretDecision(res, candidates, localSug) {
    var source = res.source === 'deepseek' ? 'deepseek' : 'local';
    var action = (res.action === 'play' || res.action === 'pass') ? res.action : null;
    var choice = readChoiceIndex(res);
    var reason = typeof res.reason === 'string' ? res.reason : '';
    var raw = typeof res.raw === 'string' ? res.raw : null;
    var error = typeof res.error === 'string' && res.error ? res.error : null;
    var play = res.play ? normalizePlay(res.play) : null;

    if (!action) {
      if (choice === -1) action = 'pass';
      else if (choice !== null && choice >= 0) action = 'play';
      else action = play ? 'play' : 'pass';
    }

    if (action === 'play' && !play) {
      var idx = null;
      if (choice !== null && choice >= 0) idx = choice;
      if (idx === null && source === 'deepseek') idx = matchChoiceByReason(reason, candidates);
      if (idx !== null && candidates && candidates[idx] && candidates[idx].play) {
        play = candidates[idx].play;
      } else if (localSug && localSug.play) {
        play = localSug.play;
        source = 'local';
        error = (error ? error + ' ' : '') + 'DeepSeek 返回的建议无法映射为具体牌，已回退本地建议。';
      } else {
        source = 'local';
        error = (error ? error + ' ' : '') + 'DeepSeek 返回的建议无法映射为具体牌。';
      }
    }
    if (action === 'pass') play = null;

    if (!reason && source === 'local' && localSug && localSug.reason) reason = localSug.reason;
    var cands = (Array.isArray(candidates) && candidates.length) ? candidates :
      (localSug && localSug.candidates) ? localSug.candidates : [];
    var fallbackFlag = source === 'local' && (!!error || res.source === 'local');
    var sug = buildSuggestion(source, action, play, reason, cands, {
      raw: raw, error: error, fallback: fallbackFlag
    });
    return sug;
  }

  function doDeepSeekSuggest() {
    if (deepseekBusy) return;
    var cfg = normalizeConfig(loadSettings());
    if (!cfg.apiKey) {
      toast('尚未配置 DeepSeek API Key，请先在「设置」中填写。', 'warn');
      openSettingsModal();
      try { var keyInput = $('setting-api-key'); if (keyInput) keyInput.focus(); } catch (e) { /* ignore */ }
      return;
    }
    if (!hasDeepSeek()) {
      toast('DeepSeek 模块（gd.deepseek.js）未加载，无法请求。', 'error');
      return;
    }
    if (!state.hand.length) {
      toast('请先在「我的手牌」录入 27 张手牌，再让 DeepSeek 出建议。', 'warn');
      return;
    }

    deepseekBusy = true;
    setLoading(true, '正在请求 DeepSeek（' + cfg.model + '）…');
    var seq = ++requestSeq;
    var localSug = null;
    try { localSug = getLocalSuggestion(); } catch (e) { localSug = null; }
    var payload = localSug ? {
      action: localSug.action,
      typeName: localSug.play ? (localSug.play.name || '出牌') : '不出',
      cards: localSug.play ? cardTexts(sortCards(localSug.play.cards)) : [],
      reason: localSug.reason || '',
      // 附加字段：DeepSeek 调用失败回退时可直接拿到真实 Play（gd.deepseek.js 的 buildLocalFallback 支持）
      play: localSug.play || null
    } : null;
    var candidates = [];
    try { candidates = getCandidates(12); } catch (e) { candidates = []; }
    var d = derive();
    var request = buildDeepSeekRequest(d, candidates, payload);
    var timeoutMs = Math.max(3000, Number(cfg.timeoutMs) || 30000);
    var promise;
    try {
      promise = window.GDDeepSeek.decide(request, cfg, { localSuggestion: payload });
    } catch (e) {
      promise = Promise.reject(e);
    }
    withTimeout(promise, timeoutMs + 8000).then(function (res) {
      if (seq !== requestSeq) return;
      if (!res || typeof res !== 'object') {
        throw new Error('DeepSeek 返回结果为空。');
      }
      var sug = interpretDecision(res, candidates, localSug);
      renderSuggestion(sug);
    }).catch(function (e) {
      if (seq !== requestSeq) return;
      var msg = errText(e);
      toast('DeepSeek 请求失败：' + msg, 'error');
      if (localSug) {
        var fb = buildSuggestion('local', localSug.action, localSug.play, localSug.reason, localSug.candidates, {
          fallback: true, error: 'DeepSeek 请求失败，已回退本地建议：' + msg
        });
        renderSuggestion(fb);
      }
    }).then(function () {
      deepseekBusy = false;
      setLoading(false, '');
    });
  }

  /* ---------- 采用 / 复制 ---------- */

  function adoptSuggestion() {
    var sug = currentSuggestion;
    if (!sug) { toast('当前没有可采用的建议。', 'warn'); return; }
    if (!sug.valid) { toast(sug.displayError || '这条建议不可采用。', 'warn'); return; }
    var d = derive();
    if (sug.action === 'pass') {
      if (!d.lastPlay) { toast('当前是领出，不能记为「过」。', 'warn'); return; }
      var rp = recordPass(state.mySeat);
      if (!rp.ok) { toast(rp.msg || '记录失败。', 'error'); return; }
      toast('已采用建议：我 过。' + (rp.warning ? ' ' + rp.warning : ''), 'success');
      return;
    }
    var play = sug.play;
    if (!play || !play.cards || !play.cards.length) { toast('建议中没有具体牌面。', 'error'); return; }
    var text = (play.name || '出牌') + ' ' + formatCards(play.cards);
    var r = recordPlay(state.mySeat, play.cards.slice(), true);
    if (!r.ok) {
      if (r.msg) toast(r.msg, r.silent ? 'warn' : 'error');
      return;
    }
    toast('已采用建议并记录：' + text, 'success');
  }

  function copyText(text) {
    function legacyCopy() {
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.top = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) resolve(); else reject(new Error('浏览器拒绝复制'));
        } catch (e) { reject(e); }
      });
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return Promise.race([
          navigator.clipboard.writeText(text),
          new Promise(function (resolve, reject) {
            setTimeout(function () { reject(new Error('剪贴板接口超时')); }, 1200);
          })
        ]).catch(legacyCopy);
      }
    } catch (e) { /* fallthrough */ }
    return legacyCopy();
  }

  function copySuggestion() {
    var sug = currentSuggestion;
    if (!sug) { toast('当前没有可复制的建议。', 'warn'); return; }
    var text;
    if (sug.action === 'pass') text = '不出';
    else if (sug.play && sug.play.cards && sug.play.cards.length) text = (sug.play.name || '出牌') + '：' + formatCards(sug.play.cards);
    else text = '';
    if (!text) { toast('没有可复制的牌面。', 'warn'); return; }
    copyText(text).then(function () {
      toast('已复制：' + text, 'success');
    }, function (e) {
      toast('复制失败：' + errText(e) + '（可手动选中牌面文本）', 'error');
    });
  }

  function clearSuggestion() {
    currentSuggestion = null;
    renderSuggestion(null);
  }

  /* ========================= 记录操作 ========================= */

  function afterStateChange() {
    reparseHistory();
    requestSeq++;
    deepseekBusy = false;
    setLoading(false, '');
    currentSuggestion = null;
    saveState();
    renderAll();
  }

  function recordPlay(seat, cards, skipConfirm) {
    var s = Number(seat);
    if (!(s >= 0 && s <= 3)) return { ok: false, msg: '座位无效。' };
    var list = localSort((cards || []).map(Number));
    if (!list.length) return { ok: false, msg: '没有选择任何牌。' };
    var seen = {}, dup = false;
    list.forEach(function (id) { if (seen[id]) dup = true; seen[id] = true; });
    if (dup) return { ok: false, msg: '同一张牌不能重复选择。' };
    var invalid = list.filter(function (id) { return !(id >= 1 && id <= 108 && Math.floor(id) === id); });
    if (invalid.length) return { ok: false, msg: '存在无效的牌。' };

    var d = derive();
    var handSet = {};
    state.hand.forEach(function (id) { handSet[id] = true; });
    if (s === state.mySeat) {
      var missing = list.filter(function (id) { return !handSet[id]; });
      if (missing.length) {
        return { ok: false, msg: '这些牌不在你的手牌中：' + cardTexts(missing).join(' ') + '。请先更新「我的手牌」。' };
      }
    } else {
      var inHand = list.filter(function (id) { return handSet[id]; });
      if (inHand.length) {
        return { ok: false, msg: '其他玩家的牌不能来自你的手牌：' + cardTexts(inHand).join(' ') + '。' };
      }
    }
    var dupPlayed = list.filter(function (id) { return d.playedSet[id]; });
    if (dupPlayed.length) {
      return { ok: false, msg: '这些牌已经记录出过了：' + cardTexts(dupPlayed).join(' ') + '。' };
    }

    var play = makePlay(list, state.level);
    if (!play) return { ok: false, msg: '所选牌不构成合法牌型。' };
    if (play.type === 'unknown' && !skipConfirm) {
      return {
        ok: false,
        msg: '所选牌不构成合法牌型（当前引擎无法识别），请检查选牌或级牌设置。'
      };
    }

    if (d.lastPlay && !canBeat(d.lastPlay, play) && !skipConfirm) {
      var prevText = (d.lastPlay.name || '出牌') + ' ' + formatCards(d.lastPlay.cards || []);
      var go = false;
      try {
        go = window.confirm('这手「' + (play.name || '出牌') + '」压不过上一手「' + prevText + '」。\n\n如果这是新一轮领出，请先记录其他三家的「过」。\n仍要记录吗？');
      } catch (e) { go = false; }
      if (!go) return { ok: false, msg: '已取消记录。' };
    }

    state.history.push({ seat: s, action: 'play', cards: list.slice(), play: play });
    if (s === state.mySeat) {
      state.hand = state.hand.filter(function (id) { return !seen[id]; });
      state.hand = sortCards(state.hand);
    }
    afterStateChange();
    return { ok: true, play: makePlay(list, state.level) };
  }

  function recordPass(seat) {
    var s = Number(seat);
    if (!(s >= 0 && s <= 3)) return { ok: false, msg: '座位无效。' };
    var d = derive();
    state.history.push({ seat: s, action: 'pass', cards: [], play: null });
    var warning = d.lastPlay ? '' : '（当前没有待压的上一手，领出时不应「过」）';
    afterStateChange();
    return { ok: true, warning: warning };
  }

  function undoLast() {
    if (!state.history.length) { toast('没有可撤销的记录。', 'warn'); return; }
    var entry = state.history.pop();
    if (entry.seat === state.mySeat && entry.action === 'play' && Array.isArray(entry.cards)) {
      var handSet = {};
      state.hand.forEach(function (id) { handSet[id] = true; });
      entry.cards.forEach(function (id) {
        if (!handSet[id]) { state.hand.push(id); handSet[id] = true; }
      });
      state.hand = sortCards(state.hand);
    }
    afterStateChange();
    toast('已撤销：' + relLabel(entry.seat) + (entry.action === 'pass' ? ' 过' : ' 出牌'), 'success');
  }

  function clearHistory() {
    if (!state.history.length) { toast('出牌记录已经是空的。', 'info'); return; }
    var go = false;
    try { go = window.confirm('确定清空全部 ' + state.history.length + ' 条出牌记录吗？（手牌不会改变）'); } catch (e) { go = false; }
    if (!go) return;
    state.history = [];
    afterStateChange();
    toast('已清空出牌记录。', 'success');
  }

  function newRound() {
    var go = false;
    try { go = window.confirm('开始新一局？\n将清空「我的手牌」与全部出牌记录，保留级牌、我的座位和设置。'); } catch (e) { go = false; }
    if (!go) return;
    state.hand = [];
    state.history = [];
    afterStateChange();
    toast('已开始新一局（级牌 ' + rankText(state.level) + '，保留设置）。', 'success');
  }

  function dealDemo(seedOverride) {
    var seed = (typeof seedOverride === 'number' && isFinite(seedOverride)) ? Math.floor(seedOverride) : Math.floor(Math.random() * 1000000);
    var result = null;
    try { result = dealHands(seed); } catch (e) { result = null; }
    if (!result || !Array.isArray(result.hands) || !result.hands.length) {
      toast('随机发牌失败：规则引擎不可用。', 'error');
      return;
    }
    var d = derive();
    var hand = (result.hands[state.mySeat] || result.hands[0] || []).map(Number);
    hand = hand.filter(function (id) { return !d.playedSet[id]; });
    if (!hand.length) {
      toast('随机发牌结果与已出牌全部冲突，请先清空出牌记录再试。', 'warn');
      return;
    }
    state.hand = sortCards(hand);
    afterStateChange();
    toast('已随机发一副手牌（seed ' + seed + '，共 ' + state.hand.length + ' 张）。', 'success');
  }

  /* ========================= 记录出牌弹窗 ========================= */

  function suggestNextSeat() {
    var hist = state.history;
    if (!hist.length) return state.mySeat;
    var d = derive();
    if (d.newTrick && d.trickLeader != null) return d.trickLeader;
    return (hist[hist.length - 1].seat + 1) % 4;
  }

  function seatOptionLabel(abs) {
    return (abs === state.mySeat ? '我' : SEAT_LABELS[(abs - state.mySeat + 4) % 4]) + '（' + SEAT_ABS_LABELS[abs] + '）';
  }

  function hintForRecordSeat() {
    if (recordSel.seat === state.mySeat) {
      return '只能选择你手牌中的牌；已出过的牌会置灰。';
    }
    return '选择该座位打出的牌（不能选择你手中的牌）。';
  }

  function openRecordModal(seat) {
    var s = (typeof seat === 'number' && seat >= 0 && seat <= 3) ? seat : suggestNextSeat();
    recordSel = { seat: s, cards: [], pass: false };
    var sel = $('record-seat');
    if (sel) {
      sel.innerHTML = '';
      for (var i = 0; i < 4; i++) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = seatOptionLabel(i);
        sel.appendChild(opt);
      }
      sel.value = String(s);
    }
    var passBox = $('record-pass');
    if (passBox) passBox.checked = false;
    var hint = $('record-hint');
    if (hint) hint.textContent = hintForRecordSeat();
    renderRecordPicker();
    updateRecordSummary();
    openModal('modal-record');
  }

  function renderRecordPicker() {
    var picker = $('record-picker');
    if (!picker) return;
    picker.innerHTML = '';
    var d = derive();
    var handSet = {};
    state.hand.forEach(function (id) { handSet[id] = true; });
    var isMe = recordSel.seat === state.mySeat;
    var ids = [];
    for (var i = 1; i <= 108; i++) ids.push(i);
    ids.sort(function (a, b) {
      var ra = cardRank(a), rb = cardRank(b);
      if (ra !== rb) return ra - rb;
      var sa = cardSuit(a), sb = cardSuit(b);
      if (sa !== sb) return sa - sb;
      return a - b;
    });
    var frag = document.createDocumentFragment();
    ids.forEach(function (id) {
      var played = !!d.playedSet[id];
      var mine = !!handSet[id];
      var info = cardInfo(id);
      var disabled = recordSel.pass || played || (isMe ? !mine : mine);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-card' + (info.joker ? ' joker' : (info.red ? ' red' : ' black'));
      btn.setAttribute('data-card-id', String(id));
      btn.disabled = disabled;
      if (isWildCard(id, state.level)) btn.classList.add('wild-card');
      if (played) btn.classList.add('is-played');
      if (recordSel.cards.indexOf(id) >= 0) btn.classList.add('selected');
      var deckSpan = document.createElement('span');
      deckSpan.className = 'pc-deck';
      deckSpan.textContent = String(cardDeck(id) + 1);
      var rankSpan = document.createElement('span');
      rankSpan.className = 'pc-rank';
      rankSpan.textContent = info.joker ? (info.rank === 16 ? '小王' : '大王') : rankText(info.rank);
      var suitSpan = document.createElement('span');
      suitSpan.className = 'pc-suit';
      suitSpan.textContent = info.joker ? '' : SUIT_SYMS[info.suit];
      btn.appendChild(deckSpan);
      btn.appendChild(rankSpan);
      btn.appendChild(suitSpan);
      btn.title = cardText(id) + ' · 第' + (cardDeck(id) + 1) + '副' +
        (played ? ' · 已出' : (mine ? ' · 我的牌' : ''));
      frag.appendChild(btn);
    });
    picker.appendChild(frag);
  }

  function toggleRecordCard(id) {
    if (recordSel.pass) return;
    var idx = recordSel.cards.indexOf(id);
    if (idx >= 0) recordSel.cards.splice(idx, 1);
    else recordSel.cards.push(id);
    recordSel.cards = sortCards(recordSel.cards);
    var btns = document.querySelectorAll('#record-picker button[data-card-id]');
    for (var i = 0; i < btns.length; i++) {
      var cid = Number(btns[i].getAttribute('data-card-id'));
      if (recordSel.cards.indexOf(cid) >= 0) btns[i].classList.add('selected');
      else btns[i].classList.remove('selected');
    }
    updateRecordSummary();
  }

  function parseTypeNames(cards) {
    if (!cards || !cards.length) return [];
    var plays = parseCards(cards, state.level);
    var names = [];
    plays.forEach(function (p) {
      if (p && p.name && names.indexOf(p.name) < 0) names.push(p.name);
    });
    return names;
  }

  function updateRecordSummary() {
    var selBox = $('record-selected-cards');
    if (selBox) {
      selBox.innerHTML = '';
      recordSel.cards.forEach(function (id) { selBox.appendChild(cardEl(id, 'small')); });
    }
    var info = $('record-selected-info');
    if (!info) return;
    if (recordSel.pass) { info.textContent = '已勾选「过」：本手不记录牌面。'; return; }
    var n = recordSel.cards.length;
    if (!n) { info.textContent = '已选 0 张：点上方牌面选牌，或勾选「过」。'; return; }
    var names = parseTypeNames(recordSel.cards);
    info.textContent = '已选 ' + n + ' 张' + (names.length
      ? ' · 识别为：' + names.join('、')
      : ' · 未识别为合法牌型（确定时会提示）');
  }

  function confirmRecord() {
    if (recordSel.pass) {
      var rp = recordPass(recordSel.seat);
      if (!rp.ok) { toast(rp.msg || '记录失败。', 'error'); return; }
      closeModal('modal-record');
      toast('已记录：' + relLabel(recordSel.seat) + ' 过' + (rp.warning ? ' ' + rp.warning : ''), 'success');
      return;
    }
    if (!recordSel.cards.length) {
      toast('请选择要记录的牌，或勾选「过」。', 'warn');
      return;
    }
    var res = recordPlay(recordSel.seat, recordSel.cards.slice());
    if (!res.ok) {
      if (res.msg) toast(res.msg, 'error');
      return;
    }
    closeModal('modal-record');
    toast('已记录：' + relLabel(recordSel.seat) + ' ' + (res.play ? res.play.name : '出牌') + ' ' + formatCards(res.play.cards), 'success');
  }

  /* ========================= 编辑手牌弹窗 ========================= */

  function openHandModal() {
    handSel = state.hand.slice();
    renderHandPicker();
    updateHandSummary();
    openModal('modal-hand');
  }

  function renderHandPicker() {
    var picker = $('hand-picker');
    if (!picker) return;
    picker.innerHTML = '';
    var d = derive();
    var ids = [];
    for (var i = 1; i <= 108; i++) ids.push(i);
    ids.sort(function (a, b) {
      var ra = cardRank(a), rb = cardRank(b);
      if (ra !== rb) return ra - rb;
      var sa = cardSuit(a), sb = cardSuit(b);
      if (sa !== sb) return sa - sb;
      return a - b;
    });
    var frag = document.createDocumentFragment();
    ids.forEach(function (id) {
      var played = !!d.playedSet[id];
      var info = cardInfo(id);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-card' + (info.joker ? ' joker' : (info.red ? ' red' : ' black'));
      btn.setAttribute('data-card-id', String(id));
      btn.disabled = played;
      if (isWildCard(id, state.level)) btn.classList.add('wild-card');
      if (played) btn.classList.add('is-played');
      if (handSel.indexOf(id) >= 0) btn.classList.add('selected');
      var deckSpan = document.createElement('span');
      deckSpan.className = 'pc-deck';
      deckSpan.textContent = String(cardDeck(id) + 1);
      var rankSpan = document.createElement('span');
      rankSpan.className = 'pc-rank';
      rankSpan.textContent = info.joker ? (info.rank === 16 ? '小王' : '大王') : rankText(info.rank);
      var suitSpan = document.createElement('span');
      suitSpan.className = 'pc-suit';
      suitSpan.textContent = info.joker ? '' : SUIT_SYMS[info.suit];
      btn.appendChild(deckSpan);
      btn.appendChild(rankSpan);
      btn.appendChild(suitSpan);
      btn.title = cardText(id) + ' · 第' + (cardDeck(id) + 1) + '副' + (played ? ' · 已出（不可选）' : '');
      frag.appendChild(btn);
    });
    picker.appendChild(frag);
  }

  function toggleHandCard(id) {
    var idx = handSel.indexOf(id);
    if (idx >= 0) handSel.splice(idx, 1);
    else handSel.push(id);
    handSel = sortCards(handSel);
    var btns = document.querySelectorAll('#hand-picker button[data-card-id]');
    for (var i = 0; i < btns.length; i++) {
      var cid = Number(btns[i].getAttribute('data-card-id'));
      if (handSel.indexOf(cid) >= 0) btns[i].classList.add('selected');
      else btns[i].classList.remove('selected');
    }
    updateHandSummary();
  }

  function updateHandSummary() {
    var selBox = $('hand-selected-cards');
    if (selBox) {
      selBox.innerHTML = '';
      handSel.forEach(function (id) { selBox.appendChild(cardEl(id, 'small')); });
    }
    var info = $('hand-selected-info');
    if (!info) return;
    var n = handSel.length;
    var names = parseTypeNames(handSel);
    info.textContent = '已选 ' + n + ' 张' + (n === 27 ? '（标准 27 张）' : '（标准为 27 张）') +
      (names.length ? ' · 可组成的牌型：' + names.join('、') : '');
  }

  function confirmHand() {
    var n = handSel.length;
    if (!n) {
      var go = false;
      try { go = window.confirm('手牌为空，确定保存空手牌吗？'); } catch (e) { go = false; }
      if (!go) return;
    }
    state.hand = sortCards(handSel.slice());
    afterStateChange();
    closeModal('modal-hand');
    toast(n === 27 ? '已保存 27 张手牌。' : '已保存 ' + n + ' 张手牌（标准为 27 张）。', n === 27 ? 'success' : 'warn');
  }

  /* ========================= 设置 ========================= */

  function engineDefaults() {
    var d = {};
    try {
      var ds = window.GDDeepSeek;
      if (ds && typeof ds === 'object' && ds.DEFAULTS && typeof ds.DEFAULTS === 'object') d = ds.DEFAULTS;
    } catch (e) { d = {}; }
    return {
      apiKey: '',
      baseUrl: typeof d.baseUrl === 'string' && d.baseUrl ? d.baseUrl : 'https://api.deepseek.com',
      model: d.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat',
      temperature: typeof d.temperature === 'number' ? d.temperature : 0.2,
      maxTokens: typeof d.maxTokens === 'number' ? d.maxTokens : 512,
      timeoutMs: typeof d.timeoutMs === 'number' ? d.timeoutMs : 30000
    };
  }

  function normalizeSettings(input) {
    input = (input && typeof input === 'object') ? input : {};
    var d = engineDefaults();
    var out = {
      apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
      baseUrl: (typeof input.baseUrl === 'string' && input.baseUrl.trim()) ? input.baseUrl.trim() : d.baseUrl,
      model: input.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat',
      temperature: clampNum(input.temperature, 0, 2, d.temperature),
      maxTokens: clampInt(input.maxTokens, 64, 8192, d.maxTokens),
      timeoutMs: clampInt(input.timeoutMs, 3000, 120000, d.timeoutMs)
    };
    out.baseUrl = out.baseUrl.replace(/\/+$/, '');
    return out;
  }

  function normalizeConfig(cfg) {
    var ds = window.GDDeepSeek;
    if (ds && typeof ds === 'object' && typeof ds.normalizeConfig === 'function') {
      try {
        var n = ds.normalizeConfig(cfg || {});
        if (n && typeof n === 'object') {
          var base = normalizeSettings(n);
          // 保留 GDDeepSeek 给出的其它字段（若有），但保证我们关心的字段正确
          for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) base[k] = n[k];
          base.maxTokens = clampInt(n.maxTokens, 64, 8192, base.maxTokens);
          base.timeoutMs = clampInt(n.timeoutMs, 3000, 120000, base.timeoutMs);
          return base;
        }
      } catch (e) { /* fallback */ }
    }
    return normalizeSettings(cfg);
  }

  function loadSettings() {
    var saved = storageGet(STORAGE_SETTINGS);
    return normalizeSettings(saved && typeof saved === 'object' ? saved : {});
  }

  function saveSettingsToStorage(cfg) {
    settings = cfg;
    var ok = storageSet(STORAGE_SETTINGS, cfg);
    renderAIButtons();
    return ok;
  }

  function openSettingsModal() {
    fillSettingsForm(settings || loadSettings());
    var st = $('settings-status');
    if (st) { st.className = 'settings-status'; st.textContent = ''; }
    openModal('modal-settings');
  }

  function fillSettingsForm(cfg) {
    var keyInput = $('setting-api-key');
    if (keyInput) { keyInput.value = cfg.apiKey || ''; keyInput.type = 'password'; }
    var toggle = $('btn-toggle-key');
    if (toggle) toggle.textContent = '👁';
    var baseInput = $('setting-base-url');
    if (baseInput) baseInput.value = cfg.baseUrl || engineDefaults().baseUrl;
    var modelSel = $('setting-model');
    if (modelSel) modelSel.value = cfg.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
    var tempInput = $('setting-temperature');
    if (tempInput) tempInput.value = String(cfg.temperature);
    var timeoutInput = $('setting-timeout');
    if (timeoutInput) timeoutInput.value = String(cfg.timeoutMs);
  }

  function readSettingsForm() {
    return {
      apiKey: (($('setting-api-key') || {}).value || '').trim(),
      baseUrl: (($('setting-base-url') || {}).value || '').trim(),
      model: ($('setting-model') || {}).value || 'deepseek-chat',
      temperature: parseFloat(($('setting-temperature') || {}).value),
      maxTokens: (settings && settings.maxTokens) || engineDefaults().maxTokens,
      timeoutMs: parseInt(($('setting-timeout') || {}).value, 10)
    };
  }

  function saveSettingsFromForm() {
    var cfg = readSettingsForm();
    if (cfg.baseUrl && !/^https?:\/\/\S+$/i.test(cfg.baseUrl)) {
      toast('Base URL 格式不正确，需以 http:// 或 https:// 开头。', 'error');
      return false;
    }
    var normalized = normalizeSettings(cfg);
    var stored = saveSettingsToStorage(normalized);
    if (stored) toast('设置已保存到本机。', 'success');
    return true;
  }

  function toggleKeyVisibility() {
    var input = $('setting-api-key');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    var btn = $('btn-toggle-key');
    if (btn) btn.textContent = show ? '🙈' : '👁';
  }

  function clearApiKey() {
    var cfg = normalizeSettings(loadSettings());
    cfg.apiKey = '';
    saveSettingsToStorage(cfg);
    var input = $('setting-api-key');
    if (input) input.value = '';
    var st = $('settings-status');
    if (st) {
      st.className = 'settings-status success';
      st.textContent = '已清除本机保存的 API Key（仅保存在浏览器 localStorage）。';
    }
    toast('已清除 API Key。', 'success');
  }

  function testConnection() {
    var st = $('settings-status');
    var btn = $('btn-test-connection');
    function status(cls, text) {
      if (st) { st.className = 'settings-status ' + cls; st.textContent = text; }
    }
    if (!hasDeepSeek() || typeof window.GDDeepSeek.testConnection !== 'function') {
      status('error', 'gd.deepseek.js 未加载或版本不支持测试连接，无法测试。');
      return;
    }
    var cfg = readSettingsForm();
    if (!cfg.apiKey) { status('error', '请先填写 API Key。'); return; }
    if (cfg.baseUrl && !/^https?:\/\/\S+$/i.test(cfg.baseUrl)) { status('error', 'Base URL 格式不正确。'); return; }
    status('pending', '正在测试连接…');
    if (btn) btn.disabled = true;
    var done = false;
    function finish(fn) { if (done) return; done = true; if (btn) btn.disabled = false; fn(); }
    var p;
    try {
      p = window.GDDeepSeek.testConnection(normalizeConfig(cfg));
    } catch (e) {
      p = Promise.reject(e);
    }
    withTimeout(p, Math.max(8000, cfg.timeoutMs || 30000) + 8000).then(function (res) {
      finish(function () {
        if (res && res.ok) {
          var okMsg = res.message || ('连接成功' + (res.model ? '（模型：' + res.model + '）' : ''));
          status('success', '✅ ' + okMsg);
        } else {
          status('error', '❌ 连接失败：' + (res && res.message ? res.message : '未知原因'));
        }
      });
    }, function (e) {
      finish(function () { status('error', '❌ 测试失败：' + errText(e)); });
    });
  }

  /* ========================= 模块横幅 ========================= */

  function renderModuleBanner() {
    var banner = $('module-banner');
    if (!banner) return;
    var missing = [];
    if (!hasCore()) missing.push('gd.core.js（规则引擎）');
    if (!hasAI()) missing.push('gd.ai.js（本地 AI）');
    if (!hasDeepSeek()) missing.push('gd.deepseek.js（DeepSeek 接入）');
    if (!missing.length) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    banner.textContent = '⚠️ 缺少模块：' + missing.join('、') +
      '。相关功能会降级或不可用；请确认这些文件与 index.html 在同一目录，然后刷新页面。';
  }

  /* ========================= 事件绑定 ========================= */

  function bindEvents() {
    function on(id, evt, fn) {
      var el = $(id);
      if (el) el.addEventListener(evt, fn);
    }

    on('level-select', 'change', function (e) {
      var v = Number(e.target.value);
      if (!isValidLevel(v)) return;
      state.level = v;
      afterStateChange();
      toast('级牌已切换为 ' + rankText(v) + '（逢人配：♥' + rankText(v) + '）。', 'info');
    });

    on('seat-select', 'change', function (e) {
      var v = Number(e.target.value);
      if (!(v >= 0 && v <= 3)) return;
      state.mySeat = v;
      afterStateChange();
      toast('我的座位：' + SEAT_ABS_LABELS[v] + '（下家为 ' + SEAT_ABS_LABELS[(v + 1) % 4] + '）。', 'info');
    });

    on('btn-new-round', 'click', newRound);
    on('btn-settings', 'click', openSettingsModal);
    on('btn-help', 'click', function () { openModal('modal-help'); });
    on('btn-edit-hand', 'click', openHandModal);
    on('btn-deal-demo', 'click', function () { dealDemo(); });
    on('btn-local-suggest', 'click', doLocalSuggest);
    on('btn-deepseek-suggest', 'click', doDeepSeekSuggest);
    on('btn-adopt', 'click', adoptSuggestion);
    on('btn-copy', 'click', copySuggestion);
    on('btn-record', 'click', function () { openRecordModal(); });
    on('btn-undo', 'click', undoLast);
    on('btn-clear', 'click', clearHistory);

    on('record-seat', 'change', function (e) {
      var v = Number(e.target.value);
      if (!(v >= 0 && v <= 3)) return;
      recordSel.seat = v;
      recordSel.cards = [];
      var hint = $('record-hint');
      if (hint) hint.textContent = hintForRecordSeat();
      renderRecordPicker();
      updateRecordSummary();
    });

    on('record-pass', 'change', function (e) {
      recordSel.pass = !!e.target.checked;
      if (recordSel.pass) recordSel.cards = [];
      renderRecordPicker();
      updateRecordSummary();
    });

    on('record-clear-sel', 'click', function () {
      recordSel.cards = [];
      var btns = document.querySelectorAll('#record-picker button[data-card-id]');
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove('selected');
      updateRecordSummary();
    });

    on('record-confirm', 'click', confirmRecord);

    var recordPicker = $('record-picker');
    if (recordPicker) {
      recordPicker.addEventListener('click', function (e) {
        var btn = closestWithAttr(e.target, 'data-card-id');
        if (!btn || btn.disabled) return;
        toggleRecordCard(Number(btn.getAttribute('data-card-id')));
      });
    }

    on('hand-clear-sel', 'click', function () {
      handSel = [];
      var btns = document.querySelectorAll('#hand-picker button[data-card-id]');
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove('selected');
      updateHandSummary();
    });
    on('hand-confirm', 'click', confirmHand);

    var handPicker = $('hand-picker');
    if (handPicker) {
      handPicker.addEventListener('click', function (e) {
        var btn = closestWithAttr(e.target, 'data-card-id');
        if (!btn || btn.disabled) return;
        toggleHandCard(Number(btn.getAttribute('data-card-id')));
      });
    }

    on('btn-save-settings', 'click', function () {
      if (saveSettingsFromForm()) closeModal('modal-settings');
    });
    on('btn-test-connection', 'click', testConnection);
    on('btn-clear-key', 'click', clearApiKey);
    on('btn-toggle-key', 'click', toggleKeyVisibility);

    // 弹窗关闭：data-close 按钮 + 点击遮罩空白处
    document.addEventListener('click', function (e) {
      var closer = closestWithAttr(e.target, 'data-close');
      if (closer) {
        var id = closer.getAttribute('data-close');
        if (id) closeModal(id);
        return;
      }
      var target = e.target;
      if (target && target.classList && target.classList.contains('modal-backdrop')) {
        closeModal(target.id);
      }
    });

    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && activeModalId) closeModal(activeModalId);
    });

    // 全局错误 → toast（不产生 console 报错）
    window.addEventListener('error', function (e) {
      var msg = e && e.message ? String(e.message) : '';
      if (!msg || msg === 'Script error.') return;
      toast('脚本错误：' + msg, 'error');
    });
    window.addEventListener('unhandledrejection', function (e) {
      var reason = e ? e.reason : null;
      toast('异步错误：' + errText(reason), 'error');
    });
  }

  /* ========================= 初始化 ========================= */

  function init() {
    try {
      settings = loadSettings();
      loadStateFromStorage();
      reparseHistory();

      var levelSel = $('level-select');
      if (levelSel) {
        levelSel.innerHTML = '';
        for (var r = 2; r <= 14; r++) {
          var opt = document.createElement('option');
          opt.value = String(r);
          opt.textContent = rankText(r);
          levelSel.appendChild(opt);
        }
        levelSel.value = String(state.level);
      }
      var seatSel = $('seat-select');
      if (seatSel) seatSel.value = String(state.mySeat);

      bindEvents();
      renderModuleBanner();
      renderAll();
      clearSuggestion();

      var demo = queryFlag('demo');
      if (demo === '1' && state.hand.length === 0) {
        var seedStr = queryFlag('seed');
        var seed = seedStr != null && /^\d+$/.test(seedStr) ? Number(seedStr) : 20240601;
        dealDemo(seed);
      }
      window.__gdReady = true;
    } catch (e) {
      window.__gdReady = false;
      toast('页面初始化失败：' + errText(e), 'error');
    }
  }

  /* ========================= 调试/自测接口（供 headless 冒烟测试用） ========================= */

  window.GDApp = {
    version: '1.0.0',
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    getDerived: function () {
      var d = derive();
      return {
        played: d.played.slice(),
        seatsRemaining: d.seatsRemaining,
        lastPlay: d.lastPlay,
        lastPlaySeat: d.lastPlaySeat,
        newTrick: d.newTrick,
        trickLeader: d.trickLeader
      };
    },
    getCounter: function () { return buildCounter(); },
    getSettings: function () { return JSON.parse(JSON.stringify(settings || {})); },
    getSuggestion: function () { return currentSuggestion; },
    modules: function () { return { core: hasCore(), ai: hasAI(), deepseek: hasDeepSeek() }; },
    setHand: function (ids) {
      state.hand = sortCards(sanitizeCards(ids));
      afterStateChange();
      return state.hand.slice();
    },
    setLevel: function (lv) {
      if (!isValidLevel(Number(lv))) return false;
      state.level = Number(lv);
      afterStateChange();
      return true;
    },
    setSeat: function (s) {
      var v = Number(s);
      if (!(v >= 0 && v <= 3)) return false;
      state.mySeat = v;
      afterStateChange();
      return true;
    },
    dealDemo: dealDemo,
    localSuggest: doLocalSuggest,
    deepseekSuggest: doDeepSeekSuggest,
    adopt: adoptSuggestion,
    record: recordPlay,
    recordPass: recordPass,
    undo: undoLast,
    clearHistory: clearHistory,
    openRecordModal: openRecordModal,
    openHandModal: openHandModal,
    openSettingsModal: openSettingsModal,
    renderAll: renderAll
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
