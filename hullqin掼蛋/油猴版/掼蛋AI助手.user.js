// ==UserScript==
// @name         掼蛋 AI 助手（game.hullqin.cn）
// @namespace    guandan-ai-helper
// @version      1.1.0
// @description  桌游合集掼蛋的 AI 助手：📋记牌器 + 👁透视（可开关，查看三家手牌与炸弹预警）+ 💡出牌提示（本地启发式）+ 🌐DeepSeek 建议 + 🤖自动托管；牌型/回放/进贡还贡规则 1:1 逆向自游戏源码；仅在掼蛋玩法（rule=2）显示。朋友间娱乐使用。
// @author       Eve
// @match        https://game.hullqin.cn/*
// @run-at       document-idle
// @grant        none
// @connect      api.deepseek.com
// @license      MIT
// ==/UserScript==
(function () {
/* ============================================================
 * hullqin-shared · React Fiber 工具
 * game.hullqin.cn 是 React SPA，游戏状态挂在各组件的 fiber memoizedProps 上。
 * 用法：HQ.findProps(el, p => typeof p.pos === 'number', 4)
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  HQ.getFiber = function (el) {
    for (const k in el) if (k.indexOf('__reactFiber') === 0) return el[k];
    return null;
  };

  /**
   * 从元素出发沿 fiber.return 向上找第一个满足 test 的 memoizedProps
   * @param {Element} el 页面元素
   * @param {(p: object) => boolean} test
   * @param {number} [maxHop=6] 最多向上跳几层
   */
  HQ.findProps = function (el, test, maxHop) {
    let f = HQ.getFiber(el);
    for (let h = 0; f && h <= (maxHop || 6); h++) {
      const p = f.memoizedProps;
      if (p && test(p)) return p;
      f = f.return;
    }
    return null;
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 页面操作通用件：模拟点击 / 等待 / 提示浮层
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  /** 对元素派发一个真实 bubbles 的 click（React 的 onClick 能收到） */
  HQ.clickEl = function (el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };

  HQ.sleep = ms => new Promise(r => setTimeout(r, ms));

  /** DOM 就绪后执行 fn（站点为 SPA，脚本可能在任意时机注入） */
  HQ.onReady = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  };

  /**
   * 顶部居中提示浮层（2.6s 后淡出）
   * @param {string} msg 文案
   * @param {string} [cls] class 名（每个助手用自己的，避免互相复用同一个节点）
   */
  HQ.toast = function (msg, cls) {
    cls = cls || 'hq-ai-toast';
    let t = document.querySelector('.' + cls);
    if (!t) {
      t = document.createElement('div');
      t.className = cls;
      t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;background:rgba(15,23,42,.92);color:#e2e8f0;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 棋盘高亮覆盖层
 * 独立 svg，fixed 定位盖在游戏棋盘上，pointer-events:none 不挡操作；
 * scroll/resize 自动重新贴合棋盘位置。
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};
  const SVGNS = 'http://www.w3.org/2000/svg';
  const live = new Set();
  let listening = false;

  function listen() {
    if (listening) return;
    listening = true;
    const refitAll = () => { for (const ov of live) if (ov.__fit) ov.__fit(); };
    window.addEventListener('scroll', refitAll, { passive: true });
    window.addEventListener('resize', refitAll, { passive: true });
  }

  /**
   * 创建一个与目标 svg 对齐的覆盖层
   * @param {SVGSVGElement} svg 游戏棋盘 svg
   * @param {string} viewBox 覆盖层使用的坐标系（通常与棋盘一致）
   */
  HQ.createOverlay = function (svg, viewBox) {
    listen();
    const ov = document.createElementNS(SVGNS, 'svg');
    ov.setAttribute('viewBox', viewBox);
    ov.style.cssText = 'position:fixed;pointer-events:none;z-index:9998;';
    ov.__fit = () => {
      const r = svg.getBoundingClientRect();
      ov.style.left = r.left + 'px';
      ov.style.top = r.top + 'px';
      ov.style.width = r.width + 'px';
      ov.style.height = r.height + 'px';
    };
    ov.__fit();
    document.body.appendChild(ov);
    live.add(ov);
    return ov;
  };

  /** 清空覆盖层内容（保留元素，下次可直接复用） */
  HQ.clearOverlay = function (ov) {
    if (ov) while (ov.firstChild) ov.removeChild(ov.firstChild);
  };

  /** 彻底移除覆盖层并解除跟踪 */
  HQ.removeOverlay = function (ov) {
    if (!ov) return;
    live.delete(ov);
    ov.remove();
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 设置存取 + 面板拖动
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  /** 从 localStorage 读取设置（JSON），与 defaults 合并，解析失败静默回退 */
  HQ.loadSettings = function (key, defaults) {
    const s = { ...defaults };
    try { Object.assign(s, JSON.parse(localStorage.getItem(key) || '{}')); } catch (e) { }
    return s;
  };

  HQ.saveSettings = function (key, settings) {
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch (e) { }
  };

  /**
   * 让面板可被按住标题栏拖动
   * @param {HTMLElement} panelEl 面板根元素（移动其 left/top，right 置 auto）
   * @param {Element} handleEl 拖动手柄（如标题栏）
   * @param {string} [ignoreClass] 手柄内带此 class 的子元素不触发拖动（如收起按钮）
   */
  HQ.makeDraggable = function (panelEl, handleEl, ignoreClass) {
    let dragging = null;
    handleEl.addEventListener('mousedown', e => {
      if (ignoreClass && e.target.classList.contains(ignoreClass)) return;
      const r = panelEl.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      panelEl.style.left = Math.max(0, e.clientX - dragging.dx) + 'px';
      panelEl.style.top = Math.max(0, e.clientY - dragging.dy) + 'px';
      panelEl.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = null; });
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 游戏注册表 + 独立版壳
 *
 * 每个游戏桥接文件通过 HQ.registerGame 注册自己：
 *   HQ.registerGame({
 *     id: 'wzq', name: '五子棋', icon: '⚫',
 *     route: /\/wzq/,              // 路由门禁（SPA pathname）
 *     interval: 450,               // tick 间隔 ms（可选，默认 450）
 *     dragIgnore: 'x',             // 标题栏内拖动忽略的元素 class（可选）
 *     canShow: () => bool,         // 可选：面板显示条件（如斗兽棋需检测到棋盘）
 *     mount(container) {...},      // 把面板渲染进 container，返回标题栏元素（供拖动）
 *     tick() {...},                // 主循环一步
 *   });
 *
 * 两种壳二选一：
 *   - 独立版：build 时在末尾追加 `HQ.mountStandalone();`
 *   - 整合版：统一 GUI 壳遍历 HQ.games 按路由挂载
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  HQ.games = HQ.games || [];
  HQ.registerGame = function (mod) { HQ.games.push(mod); };

  /** 独立版壳：把当前路由对应的游戏面板挂到固定位置容器（右上角） */
  HQ.mountStandalone = function () {
    HQ.onReady(function () {
      const g = HQ.games.find(x => x.route && x.route.test(location.pathname));
      if (!g) return;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;';
      document.body.appendChild(wrap);
      const hd = g.mount(wrap);
      if (hd && HQ.makeDraggable) HQ.makeDraggable(wrap, hd, g.dragIgnore);
      const sync = () => { if (g.canShow) wrap.style.display = g.canShow() ? '' : 'none'; };
      sync();
      setInterval(function () { sync(); g.tick(); }, g.interval || 450);
      console.log('[HQ助手] ' + g.name + ' 已加载 ✓');
    });
  };
})(typeof self !== 'undefined' ? self : globalThis);

/*!
 * gd.deepseek.js — 掼蛋 AI 助手 · DeepSeek API 接入模块
 *
 * 契约见 SPEC.md 第 6 节：prompt 构造 / OpenAI 兼容调用 / 决策解析 / 失败回退本地建议。
 * 纯逻辑、无 DOM 依赖、不联网（网络只通过注入的 fetchImpl），
 * 浏览器（全局 GDDeepSeek）与 Node（module.exports）通用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDDeepSeek = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================ 常量 ============================ */

  const DEFAULTS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 512,
    timeoutMs: 30000
  };

  const RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王' };

  /* ============================ 通用小工具 ============================ */

  function str(value, fallback) {
    if (value === null || value === undefined) return fallback === undefined ? '' : fallback;
    if (typeof value === 'string') return value.trim();
    return String(value).trim();
  }

  function rankText(rank) {
    if (typeof rank === 'string' && rank) return rank;
    const n = Number(rank);
    if (RANK_TEXT[n]) return RANK_TEXT[n];
    if (isFinite(n)) return String(n);
    return str(rank) || '?';
  }

  function toFiniteNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : NaN;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value.trim());
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  /** API Key 掩码：最多保留前 4 位 + ****，绝不输出完整 Key */
  function maskKey(apiKey) {
    const key = str(apiKey);
    if (!key) return '（未配置）';
    return key.slice(0, Math.min(4, key.length)) + '****';
  }

  /** 清理错误文案，避免泄露完整 API Key */
  function sanitize(text, apiKey) {
    let out = text === null || text === undefined ? '' : String(text);
    const key = str(apiKey);
    if (key && key.length >= 4) out = out.split(key).join(maskKey(key));
    // 兜底：形如 sk-xxxxxxxx 的疑似 Key 长串一律打码
    out = out.replace(/sk-[A-Za-z0-9_\-]{8,}/g, function (m) {
      return m.slice(0, 4) + '****';
    });
    return out;
  }

  /* ============================ 配置归一化 ============================ */

  /**
   * normalizeConfig(settings) -> {apiKey, baseUrl, model, temperature, maxTokens, timeoutMs}
   * 去空格 / 去尾部斜杠 / 缺省值回填；apiKey 为空字符串表示未配置。
   */
  function normalizeConfig(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};

    let baseUrl = str(s.baseUrl).replace(/\s+/g, '');
    baseUrl = baseUrl.replace(/\/+$/, '');
    baseUrl = baseUrl.replace(/\/chat\/completions$/i, '');
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (!baseUrl) baseUrl = DEFAULTS.baseUrl;
    if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl.replace(/^\/+/, '');

    const apiKey = str(s.apiKey);
    const model = str(s.model) || DEFAULTS.model;

    // 温度：0..2，非法回退默认值
    let temperature = toFiniteNumber(s.temperature);
    if (!isFinite(temperature)) temperature = DEFAULTS.temperature;
    temperature = Math.min(2, Math.max(0, temperature));

    // 最大输出 token：正整数，默认 512，上限 8192
    let maxTokens = toFiniteNumber(s.maxTokens);
    if (!isFinite(maxTokens) || maxTokens <= 0) maxTokens = DEFAULTS.maxTokens;
    maxTokens = Math.min(8192, Math.floor(maxTokens));

    // 请求超时：正数毫秒，默认 30000
    let timeoutMs = toFiniteNumber(s.timeoutMs);
    if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULTS.timeoutMs;
    timeoutMs = Math.min(600000, Math.floor(timeoutMs));

    return {
      apiKey: apiKey,
      baseUrl: baseUrl,
      model: model,
      temperature: temperature,
      maxTokens: maxTokens,
      timeoutMs: timeoutMs
    };
  }

  /* ============================ 官方 system prompt ============================ */

  const SYSTEM_PROMPT = [
    '你是一名掼蛋（Guandan）高手，担任玩家的出牌军师。请根据当前局面，从给定的候选出牌中选出最优的一手；',
    '如果应当让牌或不应出牌，则选择“过”（choice = -1）。',
    '',
    '【掼蛋规则摘要】',
    '1. 牌型：单张、对子、三同张（三不带）、三带二（三张+对子）、顺子（5 张连续单牌）、三连对（3 个连续对子）、钢板（2 个连续三张）、炸弹（4~10 张同点数）、同花顺（5 张同花色的顺子，属炸弹）、四大天王（2 大王 + 2 小王，最大）。',
    '2. 大小顺序（级牌制）：大王 > 小王 > 级牌 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3 > 2。级牌按当前打几决定，比 A 大。',
    '3. 级牌：当前打几，该点数四张为级牌；顺子/三连对/钢板里 A 可当 1 用，级牌在这些连牌里按自然点数参与。',
    '4. 逢人配：红桃级牌是万能牌，可当任意非王的牌使用（可配成对子、顺子、炸弹等）；单出时只算级牌单张；炸弹最多可到 10 张。',
    '5. 炸弹体系（由弱到强）：4炸(4) < 5炸(5) < 同花顺(5.5) < 6炸(6) < 7炸(7) < 8炸(8) < 9炸(9) < 10炸(10) < 四大天王(99)。炸弹可压任何非炸弹；非炸弹不能压炸弹；炸弹之间先比等级、同等级再比点数，级牌炸弹在同张数炸弹里最大。',
    '6. 压牌规则：非炸弹必须同牌型、同张数且点数更大（三带二只比三张的点数；顺子/同花顺比窗口顶位点数）；没有能压过的牌或不想压时可以“过”。',
    '',
    '【队友配合】',
    '- 四人分两队：我 + 对家是队友，上家 + 下家是对手。目标是我或对家先出完手牌，因此要帮助对家、拦截对手。',
    '- 队友（对家）当前是最大出牌者时，默认不要压队友；只有能一次出完手牌、或明显能扩大优势时才抢。',
    '- 对手（上家/下家）剩余牌很少（1~3 张）时要积极拦截，必要时使用炸弹；否则炸弹与逢人配留到关键轮次。',
    '',
    '【领出原则】',
    '- 领出（没有上一手需要压）时优先出小牌、少拆牌、减少剩余手数的组合，避免拆散炸弹与连牌。',
    '- 能一次出完手牌时优先出完；同等条件下选择点数更小、更安全的候选。',
    '- 需要压牌时，优先用刚好能压过的最小牌，把大牌、炸弹留到关键轮次。',
    '',
    '【输出契约】（必须严格遵守）',
    '只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或任何多余文字：',
    '{"choice": <整数编号>, "reason": "<简短中文理由>"}',
    '- choice：只能从用户消息给出的候选出牌编号中选择；0 表示第 1 个候选；-1 表示不出（过）。',
    '- 不要自创候选列表以外的出牌，也不要把候选里的牌换成别的牌。',
    '- reason：一句简短中文说明（不超过 40 字）。'
  ].join('\n');

  /* ============================ user prompt 构造 ============================ */

  function formatLastPlay(lastPlay) {
    if (!lastPlay || typeof lastPlay !== 'object') {
      return '无（本轮由我领出，没有需要压的牌）';
    }
    const parts = [];
    const seat = str(lastPlay.seatName);
    if (seat) parts.push('「' + seat + '」');
    parts.push(str(lastPlay.name) || '未知牌型');
    if (lastPlay.size !== null && lastPlay.size !== undefined) parts.push('（' + lastPlay.size + ' 张）');
    const cards = Array.isArray(lastPlay.cards) ? lastPlay.cards : [];
    if (cards.length) parts.push('牌面：' + cards.map(function (c) { return str(c); }).join(' '));
    const bomb = Number(lastPlay.bomb);
    if (isFinite(bomb) && bomb > 0) parts.push('炸弹等级：' + bomb);
    return parts.join(' ') || '无（本轮由我领出）';
  }

  function formatHistory(history) {
    const list = Array.isArray(history) ? history.slice(-12) : [];
    if (!list.length) return '（暂无出牌记录）';
    return list.map(function (item, i) {
      const no = i + 1;
      if (!item || typeof item !== 'object') return no + '. （无效记录）';
      const seat = str(item.seatName) || (item.seat !== undefined ? '座位' + item.seat : '?');
      const action = str(item.action) || '出牌';
      const name = str(item.name) ? ' ' + str(item.name) : '';
      const cards = Array.isArray(item.cards) && item.cards.length
        ? ' ' + item.cards.map(function (c) { return str(c); }).join(' ')
        : '';
      return no + '. ' + seat + ' ' + action + name + cards;
    }).join('\n');
  }

  function formatSeats(request) {
    const seats = Array.isArray(request.seats) ? request.seats : [];
    if (seats.length) {
      return seats.map(function (s) {
        const name = str(s && s.name) || '?';
        const count = s && s.count !== null && s.count !== undefined ? s.count : '?';
        return name + '：' + count + ' 张';
      }).join('；');
    }
    const seatsRemaining = request.seatsRemaining && typeof request.seatsRemaining === 'object'
      ? request.seatsRemaining
      : null;
    if (seatsRemaining) {
      const names = ['我', '下家', '对家', '上家'];
      return Object.keys(seatsRemaining).map(function (k) {
        const idx = Number(k);
        return (names[idx] || '座位' + k) + '：' + seatsRemaining[k] + ' 张';
      }).join('；');
    }
    return '（未提供）';
  }

  function formatRemaining(request) {
    const list = Array.isArray(request.remaining) ? request.remaining : [];
    const parts = [];
    list.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const text = str(item.rankText) || rankText(item.rank);
      const count = item.count === null || item.count === undefined ? '?' : item.count;
      parts.push(text + '×' + count);
    });
    let out = parts.length ? parts.join(' ') : '（未提供）';
    if (request.wildRemaining !== null && request.wildRemaining !== undefined) {
      out += '；逢人配剩余 ' + request.wildRemaining + ' 张';
    }
    return out;
  }

  function formatCandidate(candidate, index) {
    if (!candidate || typeof candidate !== 'object') return '[' + index + '] （无效候选）';
    const parts = ['[' + index + ']'];
    parts.push(str(candidate.typeName) || str(candidate.name) || '未知牌型');
    let size = candidate.size;
    if (size === null || size === undefined) {
      size = Array.isArray(candidate.cards) ? candidate.cards.length : null;
    }
    if (size !== null && size !== undefined) parts.push('（' + size + ' 张）');
    const cards = Array.isArray(candidate.cards) ? candidate.cards : [];
    if (cards.length) parts.push('牌面：' + cards.map(function (c) { return str(c); }).join(' '));
    const bomb = Number(candidate.bomb);
    if (isFinite(bomb) && bomb > 0) parts.push('【炸弹 ' + bomb + '】');
    if (str(candidate.note)) parts.push('备注：' + str(candidate.note));
    return parts.join(' ');
  }

  function formatLocalSuggestion(localSuggestion) {
    const ls = localSuggestion;
    if (!ls || typeof ls !== 'object') return '无（本地引擎没有给出建议）';
    const action = str(ls.action) || 'pass';
    if (action === 'pass') {
      return '不出' + (str(ls.reason) ? '（理由：' + str(ls.reason) + '）' : '');
    }
    const play = ls.play && typeof ls.play === 'object' ? ls.play : null;
    const typeName = str(ls.typeName) || (play ? str(play.name) : '') || '出牌';
    let cardsText = '';
    if (Array.isArray(ls.cards) && ls.cards.length) {
      cardsText = ls.cards.map(function (c) { return str(c); }).join(' ');
    } else if (play && str(play.desc)) {
      cardsText = str(play.desc);
    } else if (play && Array.isArray(play.cards) && play.cards.length) {
      cardsText = play.cards.map(function (c) { return str(c); }).join(' ');
    }
    let out = '出 ' + typeName + (cardsText ? '：' + cardsText : '');
    if (str(ls.reason)) out += '（理由：' + str(ls.reason) + '）';
    return out;
  }

  function buildUserPrompt(request) {
    const r = request && typeof request === 'object' ? request : {};
    const levelText = str(r.levelText) || (r.level !== null && r.level !== undefined ? rankText(r.level) : '?');
    const wildText = str(r.wildText) || ('红桃' + levelText);
    const mySeatName = str(r.mySeatName) || '我';
    const partnerSeatName = str(r.partnerSeatName) || '对家';
    const hand = Array.isArray(r.hand) ? r.hand : (r.hand ? [r.hand] : []);
    const candidates = Array.isArray(r.candidates) ? r.candidates : [];

    const lines = [];
    lines.push('【当前局面】');
    lines.push('- 级牌：' + levelText + '；逢人配：' + wildText + '（可当任意非王牌使用）。');
    lines.push('- 我的身份：' + mySeatName + '；我的队友（对家）：' + partnerSeatName + '。');

    lines.push('');
    lines.push('【我的手牌】（共 ' + hand.length + ' 张）');
    lines.push(hand.length ? hand.map(function (c) { return str(c); }).join(' ') : '（无手牌）');

    lines.push('');
    lines.push('【上一手】');
    lines.push(formatLastPlay(r.lastPlay));

    lines.push('');
    lines.push('【最近出牌历史】（越靠后越新）');
    lines.push(formatHistory(r.history));

    lines.push('');
    lines.push('【各家剩余张数】');
    lines.push(formatSeats(r));

    lines.push('');
    lines.push('【记牌器剩余】（其他人手中未知的牌，用于判断大小牌与炸弹分布）');
    lines.push(formatRemaining(r));

    lines.push('');
    lines.push('【候选出牌】（只能从下面的编号中选择）');
    if (!candidates.length) {
      lines.push('（当前没有可出的候选牌，只能选择过：choice = -1）');
    } else {
      candidates.forEach(function (candidate, i) { lines.push(formatCandidate(candidate, i)); });
    }

    lines.push('');
    lines.push('【本地引擎建议】（仅供参考，可以采纳也可以不采纳）');
    lines.push(formatLocalSuggestion(r.localSuggestion));

    lines.push('');
    lines.push('【要求】请结合掼蛋规则与当前局面，从上面候选编号中选择最优的一手；若应过则 choice = -1。');
    lines.push('只输出 JSON：{"choice": <编号>, "reason": "<简短中文理由>"}');
    return lines.join('\n');
  }

  /**
   * buildMessages(request) -> [{role:'system', content}, {role:'user', content}]
   * system：掼蛋规则摘要 + 决策原则 + 严格 JSON 输出契约；
   * user：局面 / 手牌 / 上一手 / 历史 / 各家剩余 / 记牌器 / 带编号候选 / 本地建议。
   */
  function buildMessages(request) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(request) }
    ];
  }

  /* ============================ HTTP 调用 ============================ */

  async function readJson(res) {
    if (res && typeof res.json === 'function') {
      try {
        return await res.json();
      } catch (e) {
        // 部分 mock/异常响应只能读 text，继续尝试
      }
    }
    if (res && typeof res.text === 'function') {
      const text = await res.text();
      return JSON.parse(text);
    }
    if (res && typeof res === 'object' && Array.isArray(res.choices)) return res;
    throw new Error('响应对象缺少 json()/text() 方法');
  }

  async function readErrorDetail(res) {
    try {
      if (res && typeof res.text === 'function') {
        const text = await res.text();
        return typeof text === 'string' ? text : String(text);
      }
      if (res && typeof res.json === 'function') {
        const data = await res.json();
        return typeof data === 'string' ? data : JSON.stringify(data);
      }
      if (res && typeof res === 'object') return JSON.stringify(res);
    } catch (e) {
      // 读取错误详情失败时忽略，不影响主错误文案
    }
    return '';
  }

  function httpErrorMessage(status, detail) {
    let base;
    if (status === 400) base = '请求参数错误（400）';
    else if (status === 401) base = 'API Key 无效或已过期（401）';
    else if (status === 402) base = '账户余额不足（402）';
    else if (status === 403) base = '无权限访问（403）';
    else if (status === 404) base = '接口不存在（404），请检查 Base URL 是否正确';
    else if (status === 408) base = 'DeepSeek 服务端请求超时（408）';
    else if (status === 429) base = '请求过于频繁（429 限流），请稍后重试';
    else if (status >= 500) base = 'DeepSeek 服务异常（' + status + '），请稍后重试';
    else base = '请求失败（HTTP ' + status + '）';
    const d = str(detail).replace(/\s+/g, ' ').slice(0, 300);
    return d ? base + '：' + d : base;
  }

  /**
   * callAPI(config, messages, fetchImpl) -> Promise<{content, model, usage}>
   * POST {baseUrl}/chat/completions（OpenAI 兼容），带超时与中文错误。
   */
  async function callAPI(config, messages, fetchImpl) {
    const cfg = normalizeConfig(config);
    const apiKey = cfg.apiKey;
    if (!apiKey) throw new Error('未配置 API Key，请在设置中填写 DeepSeek API Key');

    const f = typeof fetchImpl === 'function'
      ? fetchImpl
      : (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('当前环境不支持 fetch，请提供 fetchImpl');

    const msgList = Array.isArray(messages) ? messages : [];
    const url = cfg.baseUrl + '/chat/completions';
    const body = {
      model: cfg.model,
      messages: msgList,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      response_format: { type: 'json_object' },
      stream: false
    };
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body)
    };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) init.signal = controller.signal;

    let timedOut = false;
    let timer = null;
    const timeoutPromise = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        timedOut = true;
        if (controller) {
          try { controller.abort(); } catch (e) { /* 忽略 abort 异常 */ }
        }
        reject(new Error('请求超时（' + cfg.timeoutMs + 'ms），请检查网络后重试'));
      }, cfg.timeoutMs);
    });

    let res;
    try {
      const fetchPromise = Promise.resolve().then(function () { return f(url, init); });
      res = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut || (err && err.name === 'AbortError')) {
        throw new Error('请求超时（' + cfg.timeoutMs + 'ms），请检查网络后重试');
      }
      const reason = sanitize((err && err.message) || String(err), apiKey);
      throw new Error('网络请求失败：' + reason);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = res && typeof res.status === 'number' ? res.status : 200;
    const okFlag = res && typeof res.ok === 'boolean' ? res.ok : (status >= 200 && status < 300);
    if (!okFlag) {
      const detail = sanitize(await readErrorDetail(res), apiKey);
      throw new Error(httpErrorMessage(status, detail));
    }

    let data;
    try {
      data = await readJson(res);
    } catch (e) {
      throw new Error('DeepSeek 返回内容不是合法 JSON，无法解析');
    }

    let content = '';
    const firstChoice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    if (firstChoice) {
      if (firstChoice.message && typeof firstChoice.message.content === 'string') {
        content = firstChoice.message.content;
      } else if (typeof firstChoice.text === 'string') {
        content = firstChoice.text;
      } else if (firstChoice.message && Array.isArray(firstChoice.message.content)) {
        content = firstChoice.message.content.map(function (part) {
          return typeof part === 'string' ? part : str(part && part.text);
        }).join('');
      }
    }
    if (!content || !content.trim()) {
      throw new Error('DeepSeek 返回内容为空（可能被内容策略拦截或额度不足）');
    }

    return {
      content: content,
      model: (data && typeof data.model === 'string' && data.model) || cfg.model,
      usage: (data && data.usage) || null
    };
  }

  /* ============================ 决策解析 ============================ */

  function tryParseJsonObject(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    try {
      const value = JSON.parse(t);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (e) { /* 解析失败 */ }
    return null;
  }

  function extractBalancedJson(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    const end = text.lastIndexOf('}');
    if (end > start) return text.slice(start, end + 1);
    return null;
  }

  /** 从模型返回文本里尽力抽出 JSON 决策对象（容错围栏/废话/全角引号） */
  function extractDecisionObject(text) {
    const raw = text === null || text === undefined ? '' : String(text);
    if (!raw.trim()) return null;

    const variants = [raw];
    const repaired = raw
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, '"')
      .replace(/：/g, ':')
      .replace(/，/g, ',');
    if (repaired !== raw) variants.push(repaired);

    for (let v = 0; v < variants.length; v++) {
      const textVariant = variants[v];
      // 1) 直接就是 JSON
      const direct = tryParseJsonObject(textVariant);
      if (direct) return direct;
      // 2) ```json ... ``` 围栏
      const fenced = textVariant.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
      if (fenced) {
        const fromFence = tryParseJsonObject(fenced[1]);
        if (fromFence) return fromFence;
      }
      // 3) 前后有废话：截取第一个平衡的 {...}
      const balanced = extractBalancedJson(textVariant);
      if (balanced) {
        const fromBalanced = tryParseJsonObject(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
    return null;
  }

  function coerceChoice(raw) {
    if (typeof raw === 'number') {
      return isFinite(raw) && Math.floor(raw) === raw ? raw : null;
    }
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return null;
      if (/^-?\d+$/.test(t)) return parseInt(t, 10);
      if (/^-?\d+\.0+$/.test(t)) return parseInt(t, 10);
      const m = t.match(/-?\d+/);
      if (m) return parseInt(m[0], 10);
    }
    return null;
  }

  function normalizeReason(raw) {
    if (typeof raw === 'string') return raw.trim();
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'object') {
      try { return JSON.stringify(raw); } catch (e) { return ''; }
    }
    return String(raw).trim();
  }

  /**
   * parseDecision(text, candidates) -> {ok, choice, reason, error?}
   * 容错：```json 围栏、前后废话、全角引号、choice 为字符串数字、reason 缺失。
   * 越界 / 无法解析 -> ok:false。
   */
  function parseDecision(text, candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    const obj = extractDecisionObject(text);
    if (!obj) {
      return { ok: false, choice: -1, reason: '', error: '无法从返回内容中解析出 JSON 决策' };
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'choice')) {
      return { ok: false, choice: -1, reason: '', error: '返回 JSON 缺少 choice 字段' };
    }
    const choice = coerceChoice(obj.choice);
    const reason = normalizeReason(obj.reason);
    if (choice === null) {
      return {
        ok: false, choice: -1, reason: reason,
        error: 'choice 字段不是合法整数：' + String(obj.choice).slice(0, 40)
      };
    }
    if (choice === -1) {
      return { ok: true, choice: -1, reason: reason };
    }
    if (choice < -1) {
      return { ok: false, choice: choice, reason: reason, error: 'choice 取值不合法：' + choice };
    }
    if (!list.length) {
      return {
        ok: false, choice: choice, reason: reason,
        error: '模型选择了出牌（编号 ' + choice + '），但没有提供候选列表'
      };
    }
    if (choice >= list.length) {
      return {
        ok: false, choice: choice, reason: reason,
        error: 'choice 越界：' + choice + '（合法范围 0..' + (list.length - 1) + ' 或 -1）'
      };
    }
    return { ok: true, choice: choice, reason: reason };
  }

  /* ============================ 决策（含回退） ============================ */

  /**
   * 从候选对象里取出 Play：优先 candidate.play；
   * 其次 opts.candidates[choice]（Play 或 {play}）；
   * 最后若候选自带数字卡片 id，则组装一个最小 Play。
   */
  function resolveCandidatePlay(candidate, choice, request, opts) {
    if (candidate && typeof candidate === 'object' && candidate.play && typeof candidate.play === 'object') {
      return candidate.play;
    }
    if (opts && Array.isArray(opts.candidates)) {
      const extra = opts.candidates[choice];
      if (extra && typeof extra === 'object') {
        if (extra.play && typeof extra.play === 'object') return extra.play;
        if (Array.isArray(extra.cards)) return extra;
      }
    }
    if (candidate && typeof candidate === 'object'
      && Array.isArray(candidate.cards) && candidate.cards.length
      && candidate.cards.every(function (c) { return typeof c === 'number'; })) {
      const level = request && typeof request === 'object' && typeof request.level === 'number'
        ? request.level
        : null;
      return {
        type: str(candidate.type) || '',
        name: str(candidate.typeName) || str(candidate.name) || '',
        cards: candidate.cards.slice(),
        size: typeof candidate.size === 'number' ? candidate.size : candidate.cards.length,
        rank: candidate.rank !== null && candidate.rank !== undefined ? candidate.rank : 0,
        order: candidate.order !== null && candidate.order !== undefined ? candidate.order : 0,
        bomb: candidate.bomb !== null && candidate.bomb !== undefined ? candidate.bomb : 0,
        level: level,
        wilds: [],
        desc: str(candidate.note) || str(candidate.typeName) || ''
      };
    }
    return null;
  }

  /** 回退本地建议；localSuggestion 缺失时用安全默认（不出） */
  function buildLocalFallback(localSuggestion, errorMessage) {
    const error = str(errorMessage) || '未知错误';
    const ls = localSuggestion && typeof localSuggestion === 'object' ? localSuggestion : null;
    if (ls && ls.action === 'pass') {
      return {
        source: 'local',
        action: 'pass',
        play: null,
        reason: str(ls.reason) || '采用本地引擎建议：不出',
        error: error
      };
    }
    if (ls && (ls.action === 'play' || ls.play)) {
      const play = ls.play && typeof ls.play === 'object' ? ls.play : null;
      return {
        source: 'local',
        action: 'play',
        play: play,
        reason: str(ls.reason) || '采用本地引擎建议出牌',
        error: error
      };
    }
    return {
      source: 'local',
      action: 'pass',
      play: null,
      reason: '本地建议不可用',
      error: error
    };
  }

  /**
   * decide(request, config, opts) -> Promise<{source, action, play, reason, raw?, error?}>
   * opts = { fetchImpl, localSuggestion }。
   * 无 apiKey / 调用失败 / 解析失败 -> 回退 localSuggestion（source:'local'，error 说明原因）。
   * 本函数永不 throw。
   */
  async function decide(request, config, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const localSuggestion = options.localSuggestion;

    try {
      const cfg = normalizeConfig(config);
      if (!cfg.apiKey) {
        return buildLocalFallback(localSuggestion, '未配置 API Key，已回退本地建议');
      }

      const messages = buildMessages(request);
      const response = await callAPI(cfg, messages, options.fetchImpl);
      const raw = response && typeof response.content === 'string' ? response.content : '';
      const candidates = request && Array.isArray(request.candidates) ? request.candidates : [];

      const parsed = parseDecision(raw, candidates);
      if (!parsed.ok) {
        return buildLocalFallback(localSuggestion, '无法解析 DeepSeek 返回：' + (parsed.error || '未知错误'));
      }

      if (parsed.choice === -1) {
        return {
          source: 'deepseek',
          action: 'pass',
          play: null,
          reason: parsed.reason || 'DeepSeek 建议不出',
          raw: raw
        };
      }

      const candidate = candidates[parsed.choice];
      const play = resolveCandidatePlay(candidate, parsed.choice, request, options);
      let reason = parsed.reason;
      if (!reason) {
        const typeName = candidate && typeof candidate === 'object'
          ? (str(candidate.typeName) || str(candidate.name))
          : '';
        reason = typeName ? 'DeepSeek 建议出 ' + typeName : 'DeepSeek 建议出牌';
      }
      return {
        source: 'deepseek',
        action: 'play',
        play: play,
        reason: reason,
        raw: raw
      };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      return buildLocalFallback(localSuggestion, '调用 DeepSeek 失败：' + reason);
    }
  }

  /* ============================ 连接测试 ============================ */

  /**
   * testConnection(config, fetchImpl) -> Promise<{ok, message, model?}>
   * 永远返回结果对象，不 throw。
   */
  async function testConnection(config, fetchImpl) {
    let cfg;
    try {
      cfg = normalizeConfig(config);
    } catch (err) {
      return { ok: false, message: '配置格式错误：' + (err && err.message ? err.message : String(err)) };
    }
    if (!cfg.apiKey) {
      return { ok: false, message: '未配置 API Key，请先在设置中填写 DeepSeek API Key' };
    }
    try {
      const messages = [
        { role: 'system', content: '你是连接测试助手。请严格输出一个 JSON 对象：{"ok": true}' },
        { role: 'user', content: '连接测试：请只回复 JSON {"ok": true}' }
      ];
      const response = await callAPI(cfg, messages, fetchImpl);
      return {
        ok: true,
        message: '连接成功（模型：' + response.model + '）',
        model: response.model
      };
    } catch (err) {
      return { ok: false, message: (err && err.message) || '连接失败：未知错误' };
    }
  }

  /* ============================ 导出 ============================ */

  const api = {
    DEFAULTS: DEFAULTS,
    normalizeConfig: normalizeConfig,
    buildMessages: buildMessages,
    callAPI: callAPI,
    parseDecision: parseDecision,
    decide: decide,
    testConnection: testConnection
  };

  return api;
});

/*!
 * gd.site.core.js — 掼蛋 AI 助手（game.hullqin.cn 油猴版）· 站点规则引擎
 *
 * 规则 1:1 复刻站点掼蛋（rule=2）逻辑（逆向自 ddz chunk module 6135/9474），契约见 SPEC2.md。
 * 纯逻辑、无 DOM 依赖、不联网；浏览器（全局 GDSite）与 Node（module.exports）通用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSite = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const TOTAL = 108;
  const DECKS = 2;

  const SUIT_SYMBOLS = ['♦', '♣', '♥', '♠'];

  const TYPE = {
    Single: 1,
    Pair: 2,
    Triple: 3,
    ThreeWithPair: 4,
    Steel: 5,
    TriplePairs: 6,
    Straight: 7,
    Four: 100,
    Five: 101,
    StraightFlush: 102,
    Six: 103,
    Seven: 104,
    Eight: 105,
    FourJokers: 127
  };

  const TYPE_NAME = {
    1: '单张', 2: '对子', 3: '三同张', 4: '三带二', 5: '钢板', 6: '三连对', 7: '顺子',
    100: '炸弹4张', 101: '炸弹5张', 102: '同花顺', 103: '炸弹6张', 104: '炸弹7张', 105: '炸弹8张', 127: '四大天王'
  };

  const RANK_TEXT = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '级牌', 16: '小王', 17: '大王'
  };

  /* ============================ 牌模型 ============================ */

  function normLevel(level) {
    const n = Number(level);
    if (!isFinite(n)) return 2;
    return Math.min(14, Math.max(2, Math.floor(n)));
  }

  /** 归一化到 1..54（第一副内的 local id） */
  function normalizeId(id) {
    const n = Number(id);
    if (!isFinite(n)) return 0;
    return ((Math.floor(n) - 1) % 54 + 54) % 54 + 1;
  }

  function cardDeck(id) {
    const n = Number(id);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor((Math.floor(n) - 1) / 54);
  }

  function cardLocal(id) {
    return normalizeId(id);
  }

  /** 自然点数：2..14，小王16，大王17 */
  function rankOf(id) {
    const t = normalizeId(id);
    if (t === 53) return 17;
    if (t === 54) return 16;
    const r = t % 13;
    return r === 1 ? 14 : (r === 0 ? 13 : r);
  }

  /** 花色 0=♦ 1=♣ 2=♥ 3=♠；王返回 -1 */
  function suitOf(id) {
    const t = normalizeId(id);
    if (t >= 53) return -1;
    return Math.floor((t - 1) / 13);
  }

  function isJoker(id) {
    return suitOf(id) === -1;
  }

  function levelOrder(rank, level) {
    const lv = normLevel(level);
    return rank === lv ? 15 : rank;
  }

  function isLevelCard(id, level) {
    return rankOf(id) === normLevel(level);
  }

  /** 逢人配：红桃级牌（local 27..39 且自然点数=级牌） */
  function isWildCard(id, level) {
    const t = normalizeId(id);
    return t >= 27 && t <= 39 && rankOf(id) === normLevel(level);
  }

  function heartLevelId(level) {
    const lv = normLevel(level);
    return lv === 14 ? 27 : lv + 26;
  }

  function rankText(rank) {
    const n = Number(rank);
    if (RANK_TEXT[n]) return RANK_TEXT[n];
    if (isFinite(n)) return String(n);
    return '?';
  }

  function cardText(id) {
    if (isJoker(id)) return rankText(rankOf(id));
    return SUIT_SYMBOLS[suitOf(id)] + rankText(rankOf(id));
  }

  function cardTexts(ids) {
    return (ids || []).map(cardText);
  }

  /* ============================ 牌型解释 ============================ */

  function countsBy(arr, fn) {
    const m = new Map();
    (arr || []).forEach(function (c) {
      const k = fn(c);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  }

  function uniqNumbers(arr) {
    const out = [];
    const seen = {};
    (arr || []).forEach(function (v) {
      const n = Number(v);
      if (!isFinite(n) || seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    return out;
  }

  /**
   * 解释一组牌的候选牌型 code（等价于站点 module 6135 的 x()）。
   * @returns {number[]} 去重升序的 code 列表
   */
  function interpretCodes(cards, level) {
    const lv = normLevel(level);
    const cs = (cards || []).map(Number).filter(function (c) { return c > 0; });
    const size = cs.length;
    const out = [];
    const push = function (code) { out.push(code); };
    if (!size) return [];

    const wilds = cs.filter(function (c) { return isWildCard(c, lv); });
    const others = cs.filter(function (c) { return !isWildCard(c, lv); });
    const u = wilds.length;
    const cnt = countsBy(others, function (c) { return levelOrder(rankOf(c), lv); });
    const nat = countsBy(others, function (c) { return rankOf(c); });
    const keys = Array.from(cnt.keys());

    if (size === 1) {
      push((TYPE.Single << 8) | (u ? 15 : levelOrder(rankOf(cs[0]), lv)));
    }

    if (size === 2) {
      if (u === 2) {
        push((TYPE.Pair << 8) | 15);
      } else {
        keys.forEach(function (e) {
          if ((u && e >= 16)) return;
          if (cnt.get(e) === 2 - u) push((TYPE.Pair << 8) | e);
        });
      }
    }

    if (size === 3) {
      keys.forEach(function (e) {
        if ((u && e >= 16)) return;
        if (cnt.get(e) === 3 - u) push((TYPE.Triple << 8) | e);
      });
    }

    if (size === 4 && !u && others.every(function (c) { return isJoker(c); })) {
      push((TYPE.FourJokers << 8) | 0);
    }

    if (cnt.size <= 1) {
      const y = others.length ? levelOrder(rankOf(others[0]), lv) : 0;
      if (!u || y < 16) {
        for (let x = 4; x <= 8; x++) {
          if (x - u >= 1 && x - u === others.length) {
            const t = x <= 5 ? TYPE.Four + x - 4 : x + 97;
            push((t << 8) | y);
          }
        }
      }
    }

    if (size === 5) {
      const g = new Set(others.map(function (c) { return rankOf(c); }));
      const allDistinct = g.size === others.length;
      const firstSuit = others.length ? suitOf(others[0]) : -1;
      const sameSuit = allDistinct && others.length > 0 && others.every(function (c) { return suitOf(c) === firstSuit; });
      for (let b = 5; b <= 14; b++) {
        let miss = 0;
        for (let P = b - 4; P <= b; P++) {
          if (!g.has(P) && !(P === 1 && b === 5 && g.has(14))) miss += 1;
        }
        if (miss === u) {
          if (allDistinct) push((TYPE.Straight << 8) | b);
          if (sameSuit) push((TYPE.StraightFlush << 8) | b);
        }
      }
    }

    if (size === 5) {
      keys.forEach(function (e) {
        if (u && e >= 16) return;
        const t = cnt.get(e);
        keys.forEach(function (i) {
          if (i === e || t > 3 || cnt.get(i) > 2) return;
          if (t + cnt.get(i) + u !== 5) return;
          if (u && i >= 16) return;
          push((TYPE.ThreeWithPair << 8) | e);
        });
      });
    }

    if (size === 6) {
      const natKeys = Array.from(nat.keys());

      // 三连对：窗口 [e-2,e-1,e]，e=3 时 A(14) 当 1
      for (let e = 3; e <= 14; e++) {
        const win = [e - 2, e - 1, e];
        const ok = natKeys.every(function (r) {
          return win.indexOf(r) >= 0 || (r === 14 && e === 3);
        });
        if (!ok) continue;
        let sum = 0;
        let bad = false;
        for (let idx = 0; idx < win.length; idx++) {
          const l = win[idx];
          const o = nat.get(l) || (l === 1 && e === 3 && nat.get(14)) || 0;
          if (o > 2) { bad = true; break; }
          sum += 2 - o;
        }
        if (!bad && sum === u) push((TYPE.TriplePairs << 8) | e);
      }

      // 钢板：窗口 [e-1,e]，e=2 时 A(14) 当 1
      for (let e = 2; e <= 14; e++) {
        const win = [e - 1, e];
        const ok = natKeys.every(function (r) {
          return win.indexOf(r) >= 0 || (r === 14 && e === 2);
        });
        if (!ok) continue;
        let sum = 0;
        let bad = false;
        for (let idx = 0; idx < win.length; idx++) {
          const l = win[idx];
          const o = nat.get(l) || (l === 1 && e === 2 && nat.get(14)) || 0;
          if (o > 3) { bad = true; break; }
          sum += 3 - o;
        }
        if (!bad && sum === u) push((TYPE.Steel << 8) | e);
      }
    }

    return uniqNumbers(out).sort(function (a, b) { return a - b; });
  }

  /** next 能否压 prev（prev=0 表示无上一手） */
  function beats(nextCode, prevCode) {
    const n = Number(nextCode) || 0;
    const p = Number(prevCode) || 0;
    if (!n) return false;
    if (!p) return true;
    const nt = n >> 8;
    const pt = p >> 8;
    if (nt === pt) return (n & 255) > (p & 255);
    return nt >= TYPE.Four && nt > pt;
  }

  /** 从候选解释中选出最优 code（能压 prevCode 的最大 code；prevCode=0 取最大） */
  function bestCode(cards, prevCode, level) {
    const codes = interpretCodes(cards, level);
    if (!codes.length) return 0;
    const prev = Number(prevCode) || 0;
    let best = 0;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (prev && !beats(c, prev)) continue;
      if (c > best) best = c;
    }
    return best;
  }

  function bombValue(code) {
    const t = (Number(code) || 0) >> 8;
    if (t === TYPE.FourJokers) return 99;
    if (t === TYPE.StraightFlush) return 5.5;
    if (t === TYPE.Four) return 4;
    if (t === TYPE.Five) return 5;
    if (t === TYPE.Six) return 6;
    if (t === TYPE.Seven) return 7;
    if (t === TYPE.Eight) return 8;
    return 0;
  }

  function typeName(code) {
    const t = (Number(code) || 0) >> 8;
    return TYPE_NAME[t] || '未知牌型';
  }

  /** 站点同款排序：等级降序 → 相对花色（seat 视角）→ id 升序 */
  function sortHand(cards, level, seat) {
    const lv = normLevel(level);
    const mySeat = (seat === undefined || seat === null || seat < 0) ? -1 : seat;
    return (cards || []).slice().sort(function (a, b) {
      const d1 = levelOrder(rankOf(a), lv);
      const d2 = levelOrder(rankOf(b), lv);
      if (d1 !== d2) return d2 - d1;
      if (mySeat >= 0) {
        const s1 = suitOf(a);
        const s2 = suitOf(b);
        const r1 = s1 === -1 ? 4 : (s1 - mySeat + 4) % 4;
        const r2 = s2 === -1 ? 4 : (s2 - mySeat + 4) % 4;
        if (r1 !== r2) return r1 - r2;
      }
      return a - b;
    });
  }

  /**
   * 用一组牌构造 Play；code 缺省时取最大解释（领出）或自动最优。
   * @returns {object|null} Play
   */
  function playFromCards(cards, level, code) {
    const lv = normLevel(level);
    const cs = (cards || []).map(Number).filter(function (c) { return c > 0; });
    if (!cs.length) return null;
    const validCodes = interpretCodes(cs, lv);
    if (!validCodes.length) return null;
    let c = (code === undefined || code === null) ? 0 : Number(code);
    if (c) {
      // 显式指定解读时必须与这组牌的真实解读一致，否则视为非法
      if (validCodes.indexOf(c) < 0) return null;
    } else {
      c = bestCode(cs, 0, lv);
    }
    if (!c) return null;
    const sorted = sortHand(cs, lv);
    const wilds = sorted.filter(function (x) { return isWildCard(x, lv); })
      .map(function (x) { return { card: x, asRank: null, asSuit: null }; });
    return {
      type: c >> 8,
      code: c,
      name: typeName(c),
      cards: sorted,
      size: sorted.length,
      rank: c & 255,
      bomb: bombValue(c),
      level: lv,
      wilds: wilds,
      desc: typeName(c) + ' ' + cardTexts(sorted).join('')
    };
  }

  /* ============================ protobuf DDZGameData ============================ */

  const PROTO_FIELDS = {
    rule: 1, state: 2, landlordId: 3, cardPositionList: 4, playedCardList: 5, v: 6,
    team13Level: 7, team24Level: 8, lastRankList: 9, tributeCardList: 10,
    returnCardList: 11, firstPlayer: 12, playedTypeList: 13
  };

  const PROTO_DEFAULTS = {
    rule: 0, state: 0, landlordId: 0, cardPositionList: [], playedCardList: [], v: 0,
    team13Level: 0, team24Level: 0, lastRankList: [], tributeCardList: [],
    returnCardList: [], firstPlayer: 0, playedTypeList: []
  };

  function toBytes(input) {
    if (!input) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (typeof input === 'string') {
      try {
        const bin = (typeof atob === 'function') ? atob(input) : '';
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      } catch (e) { return new Uint8Array(0); }
    }
    if (typeof input === 'object' && typeof input.length === 'number') {
      return Uint8Array.from(input);
    }
    return new Uint8Array(0);
  }

  /** 解码 protobuf DDZGameData（兼容 packed 与单值 repeated） */
  function decodeGameData(input) {
    const bytes = toBytes(input);
    const out = {};
    Object.keys(PROTO_DEFAULTS).forEach(function (k) {
      const v = PROTO_DEFAULTS[k];
      out[k] = Array.isArray(v) ? v.slice() : v;
    });
    let pos = 0;
    const len = bytes.length;

    function readVarint() {
      let value = 0;
      let shift = 0;
      while (pos < len) {
        const b = bytes[pos++];
        value += (b & 0x7f) * Math.pow(2, shift);
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 56) break;
      }
      return value >>> 0;
    }
    function skipField(wire) {
      if (wire === 0) { readVarint(); return; }
      if (wire === 1) { pos += 8; return; }
      if (wire === 2) { const l = readVarint(); pos += l; return; }
      if (wire === 5) { pos += 4; return; }
      pos = len;
    }
    function pushRepeated(field, wire) {
      if (wire === 2) {
        const l = readVarint();
        const end = pos + l;
        while (pos < end) out[field].push(readVarint());
      } else {
        out[field].push(readVarint());
      }
    }

    while (pos < len) {
      const tag = readVarint();
      if (!tag) break;
      const field = tag >>> 3;
      const wire = tag & 7;
      switch (field) {
        case 1: out.rule = readVarint(); break;
        case 2: out.state = readVarint(); break;
        case 3: out.landlordId = readVarint(); break;
        case 4: pushRepeated('cardPositionList', wire); break;
        case 5: pushRepeated('playedCardList', wire); break;
        case 6: out.v = readVarint(); break;
        case 7: out.team13Level = readVarint(); break;
        case 8: out.team24Level = readVarint(); break;
        case 9: pushRepeated('lastRankList', wire); break;
        case 10: pushRepeated('tributeCardList', wire); break;
        case 11: pushRepeated('returnCardList', wire); break;
        case 12: out.firstPlayer = readVarint(); break;
        case 13: pushRepeated('playedTypeList', wire); break;
        default: skipField(wire); break;
      }
    }
    return out;
  }

  /** 编码为 Uint8Array（测试/夹具用） */
  function encodeGameData(raw) {
    const src = raw || {};
    const buf = [];
    function writeVarint(v) {
      let n = Number(v) >>> 0;
      while (n > 0x7f) {
        buf.push((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      buf.push(n);
    }
    function writeUint(field, v) {
      if (v === undefined || v === null) return;
      writeVarint((field << 3) | 0);
      writeVarint(v);
    }
    function writeRepeated(field, arr) {
      if (!arr || !arr.length) return;
      writeVarint((field << 3) | 2);
      const tmp = [];
      for (let i = 0; i < arr.length; i++) {
        let n = Number(arr[i]) >>> 0;
        while (n > 0x7f) { tmp.push((n & 0x7f) | 0x80); n >>>= 7; }
        tmp.push(n);
      }
      writeVarint(tmp.length);
      for (let i = 0; i < tmp.length; i++) buf.push(tmp[i]);
    }
    writeUint(PROTO_FIELDS.rule, src.rule || 0);
    writeUint(PROTO_FIELDS.state, src.state || 0);
    writeUint(PROTO_FIELDS.landlordId, src.landlordId || 0);
    writeRepeated(PROTO_FIELDS.cardPositionList, src.cardPositionList);
    writeRepeated(PROTO_FIELDS.playedCardList, src.playedCardList);
    writeUint(PROTO_FIELDS.v, src.v || 0);
    writeUint(PROTO_FIELDS.team13Level, src.team13Level || 0);
    writeUint(PROTO_FIELDS.team24Level, src.team24Level || 0);
    writeRepeated(PROTO_FIELDS.lastRankList, src.lastRankList);
    writeRepeated(PROTO_FIELDS.tributeCardList, src.tributeCardList);
    writeRepeated(PROTO_FIELDS.returnCardList, src.returnCardList);
    writeUint(PROTO_FIELDS.firstPlayer, src.firstPlayer || 0);
    writeRepeated(PROTO_FIELDS.playedTypeList, src.playedTypeList);
    return Uint8Array.from(buf);
  }

  /* ============================ 回放 ============================ */

  function partnerOf(seat) {
    return seat <= 2 ? seat + 2 : seat - 2;
  }

  function sameTeam(a, b) {
    return (Number(a) % 2) === (Number(b) % 2);
  }

  /**
   * 回放 playedCardList（站点 module 6135 的 g()）。
   * playedCardList 中每个「动作」以 0 开头：出牌 [0,...cards]，过牌 [0]。
   * @returns {object} {rankList,trickOwner,lastCards,lastInterp,lastSegmentPlayer,currentPlayer,trickActions,initialHolders,restCounts,actions}
   */
  function replayActions(playedCardList, firstPlayer, playedTypeList) {
    const e = Array.isArray(playedCardList) ? playedCardList : [];
    const r = Array.isArray(playedTypeList) ? playedTypeList : [];
    const initialHolders = new Array(TOTAL).fill(0);
    const restCounts = [0, 27, 27, 27, 27];
    const finished = [false, false, false, false, false];
    const rankList = [];
    const passedSet = new Set();
    const trickActions = [null, null, null, null, null];
    const actions = [];

    let trickOwner = 0;
    let lastCards = [];
    let lastInterp = 0;
    let lastSegmentPlayer = 0;

    // 每个动作以 0 开始：动作 k 的 cards = e[zeros[k]+1 .. zeros[k+1]-1]（末尾可无 0）
    const zeros = [];
    for (let i = 0; i < e.length; i++) if (!e[i]) zeros.push(i);

    let current = Number(firstPlayer) || 1;
    if (current < 1 || current > 4) current = 1;

    function nextActive(seat) {
      let t = seat % 4 + 1;
      for (let k = 0; k < 4; k++) {
        if (!finished[t]) return t;
        t = t % 4 + 1;
      }
      return t;
    }

    for (let seg = 0; seg < zeros.length; seg++) {
      const start = zeros[seg] + 1;
      const end = (seg + 1 < zeros.length) ? zeros[seg + 1] : e.length;
      const cards = e.slice(start, end);
      const seat = current;
      lastSegmentPlayer = seat;

      if (cards.length) {
        cards.forEach(function (c) {
          const id = Number(c);
          if (id >= 1 && id <= TOTAL) initialHolders[id - 1] = seat;
        });
        restCounts[seat] -= cards.length;
        if (restCounts[seat] <= 0 && !finished[seat]) {
          finished[seat] = true;
          rankList.push(seat);
        }
        trickOwner = seat;
        lastCards = cards.slice();
        lastInterp = Number(r[seg]) || 0;
        passedSet.clear();
        for (let L = 1; L <= 4; L++) {
          if (L !== seat && finished[L] && trickActions[L] && trickActions[L].cards) trickActions[L] = null;
        }
        trickActions[seat] = { cards: cards.slice(), passed: false };
        actions.push({ seat: seat, cards: cards.slice(), code: lastInterp, passed: false });
        current = nextActive(seat);
      } else {
        passedSet.add(seat);
        const nx = nextActive(seat);
        if (trickOwner && (nx === trickOwner || passedSet.has(nx))) {
          const h = trickOwner;
          trickActions[seat] = { cards: null, passed: true };
          for (let w = 1; w <= 4; w++) {
            if (finished[w] && trickActions[w] && trickActions[w].cards) trickActions[w] = null;
          }
          trickOwner = 0;
          lastCards = [];
          lastInterp = 0;
          passedSet.clear();
          actions.push({ seat: seat, cards: [], code: 0, passed: true });
          current = finished[h] ? partnerOf(h) : h;
        } else {
          trickActions[seat] = { cards: null, passed: true };
          actions.push({ seat: seat, cards: [], code: 0, passed: true });
          current = nx;
        }
      }
    }

    return {
      rankList: rankList,
      trickOwner: trickOwner,
      lastCards: lastCards,
      lastInterp: lastInterp,
      lastSegmentPlayer: lastSegmentPlayer,
      currentPlayer: current,
      trickActions: trickActions,
      initialHolders: initialHolders,
      restCounts: restCounts,
      actions: actions
    };
  }

  /* ============================ expandState ============================ */

  function tributeRoles(lastRankList) {
    const l = Array.isArray(lastRankList) ? lastRankList : [];
    if (l.length !== 4) return { tributers: [], receivers: [] };
    const t = l[0];
    const r = l[1];
    const n = l[2];
    const i = l[3];
    if (sameTeam(t, r)) return { tributers: [n, i], receivers: [t, r] };
    return { tributers: [i], receivers: [t] };
  }

  function roundResultOf(rankList, team13Level, team24Level, level, playingTeam) {
    const list = Array.isArray(rankList) ? rankList : [];
    if (!list.length) return null;
    const winTeam = list[0] % 2 === 1 ? 1 : 2;
    const full = list.slice();
    [1, 2, 3, 4].forEach(function (s) { if (list.indexOf(s) < 0) full.push(s); });
    let o = -1;
    for (let i = 1; i < full.length; i++) {
      if (sameTeam(full[i], full[0])) { o = i; break; }
    }
    const up = o === 1 ? 3 : (o === 2 ? 2 : 1);
    const t13 = Number(team13Level) || 2;
    const t24 = Number(team24Level) || 2;
    return {
      winTeam: winTeam,
      playingTeam: playingTeam,
      upLevels: up,
      newTeam13Level: winTeam === 1 ? Math.min(14, t13 + up) : t13,
      newTeam24Level: winTeam === 2 ? Math.min(14, t24 + up) : t24,
      isMatchOver: level === 14 && winTeam === playingTeam && o !== 3,
      fullRankList: full
    };
  }

  /**
   * 从原始 protobuf 对象展开派生状态（站点 module 6135 的 C() 等价实现）。
   * 不修改入参。
   */
  function expandState(raw) {
    const src = raw || {};
    const e = {};
    ['rule', 'state', 'landlordId', 'v', 'team13Level', 'team24Level', 'firstPlayer'].forEach(function (k) {
      e[k] = Number(src[k]) || 0;
    });
    ['cardPositionList', 'playedCardList', 'lastRankList', 'tributeCardList', 'returnCardList', 'playedTypeList'].forEach(function (k) {
      e[k] = Array.isArray(src[k]) ? src[k].slice() : [];
    });

    const lvList = e.lastRankList;
    e.level = lvList.length === 4 ? (lvList[0] % 2 === 1 ? (e.team13Level || 2) : (e.team24Level || 2)) : 2;
    e.playingTeam = lvList.length === 4 ? (lvList[0] % 2 === 1 ? 1 : 2) : 0;
    e.heartLevelCardId = e.level === 14 ? 27 : e.level + 26;

    const roles = tributeRoles(lvList);
    e.tributers = roles.tributers;
    e.receivers = roles.receivers;
    e.tributeReceivers = (e.tributeCardList.length === roles.tributers.length && roles.tributers.length)
      ? roles.receivers.slice() : [];

    e.isRoundFinish = e.state > 8;
    e.phase = e.isRoundFinish ? 'finish'
      : (e.state === 0 ? (e.tributeCardList.some(function (x) { return !x; }) ? 'tribute' : 'return') : 'play');

    const rep = replayActions(e.playedCardList, e.firstPlayer || 1, e.playedTypeList);
    e.rankList = rep.rankList;
    e.trickOwner = rep.trickOwner;
    e.lastCards = rep.lastCards;
    e.lastInterp = rep.lastInterp;
    e.lastSegmentPlayer = rep.lastSegmentPlayer;
    e.currentPlayer = rep.currentPlayer;
    e.trickActions = rep.trickActions;
    e.initialHolders = rep.initialHolders;
    e.actions = rep.actions;
    e.canPlayAnyCards = !rep.trickOwner;

    const lists = [[], [], [], [], []];
    const cpl = e.cardPositionList;
    for (let i = 0; i < TOTAL; i++) {
      const v = Number(cpl[i]) || 0;
      const owner = v & 7;
      if (owner >= 1 && owner <= 4) lists[owner].push(i + 1);
    }
    e.playerCardLists = lists;
    e.playerRestCardCounts = [0, lists[1].length, lists[2].length, lists[3].length, lists[4].length];

    e.resistInfo = (roles.tributers.length && e.state > 0 && !e.tributeCardList.length)
      ? roles.tributers.map(function (pos) {
        let cnt = 0;
        for (let n = 0; n < TOTAL; n++) {
          const owner = rep.initialHolders[n] || (Number(cpl[n]) & 7);
          if (owner === pos && normalizeId(n + 1) === 53) cnt += 1;
        }
        return { position: pos, bigJokerCount: cnt };
      }) : [];

    e.roundResult = e.isRoundFinish
      ? roundResultOf(rep.rankList, e.team13Level, e.team24Level, e.level, e.playingTeam)
      : null;

    return e;
  }

  /* ============================ 辅助查询 ============================ */

  function myHand(expanded, seat) {
    if (!expanded || !expanded.playerCardLists) return [];
    return (expanded.playerCardLists[seat] || []).slice();
  }

  function relativeSeatName(seat, mySeat) {
    const s = Number(seat);
    const me = Number(mySeat);
    if (s === me) return '我';
    if (s === partnerOf(me)) return '对家';
    if (s === (me % 4 + 1)) return '下家';
    return '上家';
  }

  /** 记牌器：其他玩家手中未知的牌 */
  function remainingCounts(expanded, seat) {
    const level = normLevel(expanded && expanded.level);
    const played = {};
    const mine = {};
    let playedWild = 0;
    let mineWild = 0;
    const pl = (expanded && expanded.playedCardList) || [];
    const playedIds = new Set();
    let dupPlayed = false;
    pl.forEach(function (v) {
      if (!v) return;
      const id = Number(v);
      if (playedIds.has(id)) dupPlayed = true;
      playedIds.add(id);
      const r = rankOf(v);
      played[r] = (played[r] || 0) + 1;
      if (isWildCard(v, level)) playedWild += 1;
    });
    const hand = myHand(expanded, seat);
    const mineIds = new Set(hand.map(Number));
    let overlap = 0;
    mineIds.forEach(function (id) { if (playedIds.has(id)) overlap += 1; });
    hand.forEach(function (v) {
      const r = rankOf(v);
      mine[r] = (mine[r] || 0) + 1;
      if (isWildCard(v, level)) mineWild += 1;
    });
    let wildTotal = 0;
    for (let i = 1; i <= TOTAL; i++) if (isWildCard(i, level)) wildTotal += 1;
    const order = [17, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    const warnings = [];
    if (dupPlayed) warnings.push('已出牌列表出现重复牌');
    if (overlap > 0) warnings.push('同一张牌既在已出记录又在我的手牌（' + overlap + ' 张）');
    let overflow = 0;
    const byRank = order.map(function (rank) {
      const total = rank >= 16 ? 2 : 8;
      const p = played[rank] || 0;
      const m = mine[rank] || 0;
      if (p + m > total) overflow += p + m - total;
      return {
        rank: rank,
        text: rankText(rank),
        total: total,
        played: p,
        mine: m,
        remaining: Math.max(0, total - p - m),
        isLevel: rank === level,
        isWild: rank === level
      };
    });
    if (overflow > 0) warnings.push('已出+我手超过该点数总张数（' + overflow + ' 张）');
    const playedCount = pl.filter(function (v) { return v > 0; }).length;
    const unknown = TOTAL - playedCount - hand.length;
    if (unknown < 0) warnings.push('已出+我手超过全副牌总数');
    return {
      byRank: byRank,
      wildRemaining: Math.max(0, wildTotal - playedWild - mineWild),
      total: TOTAL,
      playedCount: playedCount,
      mineCount: hand.length,
      unknown: unknown,
      ok: warnings.length === 0,
      warnings: warnings
    };
  }

  /** 进贡候选：排除逢人配后取最大同点牌 */
  function tributeCandidates(expanded, seat) {
    const level = normLevel(expanded && expanded.level);
    const hand = myHand(expanded, seat);
    const list = hand.filter(function (c) { return !isWildCard(c, level); });
    const pool = list.length ? list : hand.slice();
    if (!pool.length) return [];
    let max = -1;
    pool.forEach(function (c) {
      const o = levelOrder(rankOf(c), level);
      if (o > max) max = o;
    });
    return pool.filter(function (c) { return levelOrder(rankOf(c), level) === max; })
      .sort(function (a, b) { return a - b; });
  }

  /** 还贡候选：优先自然点数<=10 且非级牌；否则除级牌外最小点数 */
  function returnCandidates(expanded, seat) {
    const level = normLevel(expanded && expanded.level);
    const hand = myHand(expanded, seat);
    const first = hand.filter(function (c) {
      return rankOf(c) <= 10 && rankOf(c) !== level && !isWildCard(c, level);
    });
    if (first.length) return first.slice().sort(function (a, b) { return a - b; });
    const rest = hand.filter(function (c) { return rankOf(c) !== level && !isWildCard(c, level); });
    const pool = rest.length ? rest : hand.slice();
    if (!pool.length) return [];
    let min = Infinity;
    pool.forEach(function (c) {
      const o = levelOrder(rankOf(c), level);
      if (o < min) min = o;
    });
    return pool.filter(function (c) { return levelOrder(rankOf(c), level) === min; })
      .sort(function (a, b) { return a - b; });
  }

  /* ============================ 走法生成 ============================ */

  const MOVE_LIMIT = 400;

  /**
   * 生成走法（prevCode=0 领出，否则只保留能压 prevCode 的）。
   * @returns {object[]} Play[]
   */
  function genMoves(hand, level, prevCode) {
    const lv = normLevel(level);
    const prev = Number(prevCode) || 0;
    const h = uniqNumbers(hand).filter(function (c) { return c >= 1 && c <= TOTAL; }).sort(function (a, b) { return a - b; });
    if (!h.length) return [];

    const wilds = h.filter(function (c) { return isWildCard(c, lv); });
    const others = h.filter(function (c) { return !isWildCard(c, lv); });
    const groups = {};
    others.forEach(function (c) {
      const r = levelOrder(rankOf(c), lv);
      (groups[r] || (groups[r] = [])).push(c);
    });
    const rankKeys = Object.keys(groups).map(Number);

    const out = [];
    const seen = {};

    function add(cards) {
      if (!cards || !cards.length) return;
      const cs = cards.slice().sort(function (a, b) { return a - b; });
      const key = cs.join(',');
      if (seen[key]) return;
      seen[key] = 1;
      const code = bestCode(cs, prev, lv);
      if (!code) return;
      const play = playFromCards(cs, lv, code);
      if (play) out.push(play);
    }
    function pick(arr, n) {
      return arr.slice(0, Math.max(0, n));
    }

    // 单张
    h.forEach(function (c) { add([c]); });

    // 对子 / 三同张 / 炸弹（同点组 + 逢人配补位）
    rankKeys.forEach(function (r) {
      const g = groups[r];
      const n = g.length;
      const maxW = Math.min(wilds.length, 2);
      for (let w = 0; w <= maxW; w++) {
        const take = 2 - w;
        if (take >= 1 && take <= n && !(w > 0 && r >= 16)) add(pick(g, take).concat(pick(wilds, w)));
      }
      for (let w = 0; w <= maxW; w++) {
        const take = 3 - w;
        if (take >= 1 && take <= n && !(w > 0 && r >= 16)) add(pick(g, take).concat(pick(wilds, w)));
      }
      for (let size = 4; size <= 8; size++) {
        for (let w = 0; w <= Math.min(wilds.length, size - 1); w++) {
          const take = size - w;
          if (take >= 1 && take <= n && !(w > 0 && r >= 16)) add(pick(g, take).concat(pick(wilds, w)));
        }
      }
    });
    // 两张逢人配组成的级牌对子
    if (wilds.length >= 2) add(pick(wilds, 2));

    // 三带二
    rankKeys.forEach(function (e) {
      const ge = groups[e];
      rankKeys.forEach(function (i) {
        if (i === e) return;
        const gi = groups[i];
        const maxWe = Math.min(wilds.length, 2);
        for (let we = 0; we <= maxWe; we++) {
          if (we > 0 && e >= 16) continue;
          const takeE = 3 - we;
          if (takeE < 1 || takeE > ge.length) continue;
          const leftW = wilds.length - we;
          for (let wi = 0; wi <= Math.min(leftW, 2); wi++) {
            if (wi > 0 && i >= 16) continue;
            const takeI = 2 - wi;
            if (takeI < 1 || takeI > gi.length) continue;
            add(pick(ge, takeE).concat(pick(gi, takeI)).concat(pick(wilds, we + wi)));
          }
        }
      });
    });

    function rankCards(target, suit) {
      return others.filter(function (c) {
        return rankOf(c) === target && (suit === undefined || suitOf(c) === suit);
      });
    }

    // 顺子 / 同花顺
    for (let b = 5; b <= 14; b++) {
      const win = [];
      for (let P = b - 4; P <= b; P++) win.push((P === 1 && b === 5) ? 14 : P);
      const builds = [];
      for (let s = -1; s < 4; s++) {
        const picked = [];
        let miss = 0;
        win.forEach(function (target) {
          const cand = rankCards(target, s === -1 ? undefined : s);
          if (cand.length) picked.push(cand[0]);
          else miss += 1;
        });
        builds.push({ picked: picked, miss: miss });
      }
      builds.forEach(function (bd) {
        if (bd.miss <= wilds.length) add(bd.picked.concat(pick(wilds, bd.miss)));
      });
    }

    // 钢板（二连三）
    for (let e = 2; e <= 14; e++) {
      const win = [e - 1, e];
      let picked = [];
      let miss = 0;
      win.forEach(function (P) {
        const target = (P === 1 && e === 2) ? 14 : P;
        const cand = rankCards(target);
        const take = Math.min(3, cand.length);
        picked = picked.concat(cand.slice(0, take));
        miss += 3 - take;
      });
      if (miss <= wilds.length) add(picked.concat(pick(wilds, miss)));
    }

    // 三连对
    for (let e = 3; e <= 14; e++) {
      const win = [e - 2, e - 1, e];
      let picked = [];
      let miss = 0;
      win.forEach(function (P) {
        const target = (P === 1 && e === 3) ? 14 : P;
        const cand = rankCards(target);
        const take = Math.min(2, cand.length);
        picked = picked.concat(cand.slice(0, take));
        miss += 2 - take;
      });
      if (miss <= wilds.length) add(picked.concat(pick(wilds, miss)));
    }

    // 四大天王
    const bigs = others.filter(function (c) { return rankOf(c) === 17; });
    const smalls = others.filter(function (c) { return rankOf(c) === 16; });
    if (bigs.length >= 2 && smalls.length >= 2) add(bigs.slice(0, 2).concat(smalls.slice(0, 2)));

    if (out.length > MOVE_LIMIT) out.length = MOVE_LIMIT;
    return out;
  }

  /* ============================ AI state ============================ */

  function buildAIState(expanded, seat) {
    const mySeat = Number(seat) || 1;
    const level = normLevel(expanded && expanded.level);
    const hand = myHand(expanded, mySeat);
    const partner = partnerOf(mySeat);
    const tributers = (expanded && expanded.tributers) || [];
    const receivers = (expanded && expanded.tributeReceivers) || [];
    const tributeSlots = (expanded && expanded.tributeCardList) || [];
    const myTributeIdx = tributers.indexOf(mySeat);
    const mustTribute = expanded && expanded.phase === 'tribute' && myTributeIdx >= 0 && !tributeSlots[myTributeIdx];
    const mustReturn = expanded && expanded.phase === 'return' && receivers.indexOf(mySeat) >= 0;

    const seats = [];
    for (let s = 1; s <= 4; s++) {
      seats.push({
        seat: s,
        name: relativeSeatName(s, mySeat),
        count: (expanded && expanded.playerCardLists && expanded.playerCardLists[s]) ? expanded.playerCardLists[s].length : 0,
        isMe: s === mySeat,
        isPartner: s === partner,
        isTributer: tributers.indexOf(s) >= 0,
        rankBadge: (expanded && expanded.rankList && expanded.rankList.indexOf(s) >= 0) ? expanded.rankList.indexOf(s) + 1 : null
      });
    }

    const history = ((expanded && expanded.actions) || []).slice(-6).map(function (a) {
      return {
        seat: a.seat,
        seatName: relativeSeatName(a.seat, mySeat),
        cards: a.cards && a.cards.length ? cardTexts(a.cards) : [],
        passed: !!a.passed,
        name: a.code ? typeName(a.code) : ''
      };
    });

    const lastPlay = (expanded && expanded.trickOwner)
      ? {
        seat: expanded.trickOwner,
        seatName: relativeSeatName(expanded.trickOwner, mySeat),
        isPartner: expanded.trickOwner === partner,
        name: expanded.lastInterp ? typeName(expanded.lastInterp) : '',
        code: expanded.lastInterp || 0,
        cards: (expanded.lastCards || []).slice(),
        cardsText: cardTexts(expanded.lastCards || []).join('')
      }
      : null;

    return {
      level: level,
      levelText: rankText(level),
      heartLevelCardId: heartLevelId(level),
      wildText: '♥' + rankText(level),
      mySeat: mySeat,
      mySeatName: '我',
      partnerSeat: partner,
      partnerSeatName: '对家',
      hand: hand,
      handText: cardTexts(hand),
      prevCode: (expanded && expanded.trickOwner) ? (expanded.lastInterp || 0) : 0,
      lastPlay: lastPlay,
      trickOwner: expanded ? expanded.trickOwner : 0,
      canPlayAny: !(expanded && expanded.trickOwner),
      isMyTurn: expanded
        ? (expanded.phase === 'play' ? expanded.currentPlayer === mySeat : (mustTribute || mustReturn))
        : false,
      phase: expanded ? expanded.phase : '',
      seatsRemaining: seats,
      history: history,
      counter: remainingCounts(expanded, mySeat),
      remaining: remainingCounts(expanded, mySeat).byRank,
      wildRemaining: remainingCounts(expanded, mySeat).wildRemaining,
      tributers: tributers,
      tributeReceivers: receivers,
      mustTribute: !!mustTribute,
      mustReturn: !!mustReturn,
      roundResult: expanded ? expanded.roundResult : null,
      rankList: expanded ? expanded.rankList : []
    };
  }

  /* ============================ 发牌（测试/演示用） ============================ */

  function createRng(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function deal(seed) {
    const rng = createRng(seed);
    const deck = [];
    for (let i = 1; i <= TOTAL; i++) deck.push(i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    const hands = [[], [], [], []];
    for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
    hands.forEach(function (h) { h.sort(function (a, b) { return a - b; }); });
    return { hands: hands, seed: seed };
  }

  /* ============================ 导出 ============================ */

  return {
    VERSION: VERSION,
    CARD: { TOTAL: TOTAL, DECKS: DECKS },
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    SUITS: SUIT_SYMBOLS,

    normLevel: normLevel,
    normalizeId: normalizeId,
    cardDeck: cardDeck,
    cardLocal: cardLocal,
    rankOf: rankOf,
    suitOf: suitOf,
    isJoker: isJoker,
    levelOrder: levelOrder,
    isLevelCard: isLevelCard,
    isWildCard: isWildCard,
    heartLevelId: heartLevelId,
    rankText: rankText,
    cardText: cardText,
    cardTexts: cardTexts,
    typeName: typeName,
    bombValue: bombValue,
    partnerOf: partnerOf,
    sameTeam: sameTeam,
    relativeSeatName: relativeSeatName,

    interpretCodes: interpretCodes,
    bestCode: bestCode,
    beats: beats,
    playFromCards: playFromCards,
    sortHand: sortHand,

    decodeGameData: decodeGameData,
    encodeGameData: encodeGameData,
    replayActions: replayActions,
    expandState: expandState,
    tributeRoles: tributeRoles,
    roundResultOf: roundResultOf,

    myHand: myHand,
    remainingCounts: remainingCounts,
    tributeCandidates: tributeCandidates,
    returnCandidates: returnCandidates,
    genMoves: genMoves,
    buildAIState: buildAIState,

    createRng: createRng,
    deal: deal
  };
});

/* ============================================================
 * 掼蛋油猴版 · 透视（X-ray）模块
 * ------------------------------------------------------------
 * 用途：读取本机页面已经收到的「本局牌局状态」，把其他三家的手牌、
 *       张数、炸弹与逢人配整理成可直接渲染的结构，供面板展示。
 *
 * 原理（与斗地主透视脚本 hullqin-ddz-esp-script 同一思路，但数据源更稳）：
 *   站点把服务端广播的 DDZGameData 原文（protobuf，rule=2 为掼蛋）放进
 *   React props.game.data。cardPositionList 的 108 个值以 7&v 表示归属
 *   玩家（1..4），服务端没有按玩家裁剪字段，客户端自己也要靠它算四家
 *   剩余张数与抗贡大王数，因此本机解码即可看到全部 108 张牌的归属。
 *   所以这里**不需要劫持网络连接**，只解码现有状态即可，兼容性更好。
 *
 * 本模块是纯函数（无 DOM、无网络、无存储、无 console），可单独 Node 测试。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteESP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  const TOTAL = 108;
  const SUIT_TEXT = ['♦', '♣', '♥', '♠'];
  const BIG_JOKER = 53;   // 大王 rank 17
  const SMALL_JOKER = 54; // 小王 rank 16
  const RANK_TEXT = {
    17: '大王', 16: '小王', 15: '级', 14: 'A', 13: 'K', 12: 'Q', 11: 'J',
    10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
  };

  function num(v, dft) {
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : dft;
  }

  function normLevel(level) {
    const lv = num(level, 2);
    return lv >= 2 && lv <= 14 ? lv : 2;
  }

  function normalizeId(id) {
    const n = num(id, 0);
    return n >= 1 && n <= TOTAL ? Math.floor(n) : 0;
  }

  function cardLocal(id) {
    const n = normalizeId(id);
    return n ? (n - 1) % 54 + 1 : 0;
  }

  function cardDeck(id) {
    const n = normalizeId(id);
    return n ? Math.floor((n - 1) / 54) + 1 : 0;
  }

  function rankOf(id) {
    const local = cardLocal(id);
    if (!local) return 0;
    if (local === BIG_JOKER) return 17;
    if (local === SMALL_JOKER) return 16;
    const t = local % 13;
    return t === 1 ? 14 : (t === 0 ? 13 : t);
  }

  /** 花色：0 ♦ / 1 ♣ / 2 ♥ / 3 ♠；王返回 -1 */
  function suitOf(id) {
    const local = cardLocal(id);
    if (!local || local >= BIG_JOKER) return -1;
    return Math.floor((local - 1) / 13);
  }

  function rankText(rank) {
    return RANK_TEXT[rank] || String(rank || '');
  }

  /** 排序权重：级牌排在 A 之上；大王 17、小王 16 */
  function levelOrder(rank, level) {
    const lv = normLevel(level);
    return rank === lv ? 15 : rank;
  }

  /** 逢人配：红桃级牌（local 27..39 且点数等于级牌） */
  function isWildCard(id, level) {
    const local = cardLocal(id);
    return local >= 27 && local <= 39 && rankOf(id) === normLevel(level);
  }

  /** 单张牌的展示信息（不修改入参） */
  function cardInfo(id, level) {
    const n = normalizeId(id);
    if (!n) return null;
    const lv = normLevel(level);
    const rank = rankOf(n);
    const suit = suitOf(n);
    const joker = rank >= 16;
    return {
      id: n,
      local: cardLocal(n),
      deck: cardDeck(n),
      rank: rank,
      suit: suit,
      suitText: joker ? '' : SUIT_TEXT[suit],
      text: joker ? (rank === 17 ? '大王' : '小王') : SUIT_TEXT[suit] + rankText(rank),
      red: !joker && (suit === 0 || suit === 2),
      isLevel: !joker && rank === lv,
      isWild: isWildCard(n, lv),
      isJoker: joker,
      order: levelOrder(rank, lv),
    };
  }

  /** 按「级牌优先、同点按花色」排序，便于肉眼核对 */
  function sortCards(cards, level) {
    const lv = normLevel(level);
    const list = (Array.isArray(cards) ? cards : []).map(normalizeId).filter(Boolean);
    list.sort(function (a, b) {
      const ia = cardInfo(a, lv);
      const ib = cardInfo(b, lv);
      if (ib.order !== ia.order) return ib.order - ia.order;
      if (ia.suit !== ib.suit) return ia.suit - ib.suit;
      return ia.id - ib.id;
    });
    return list;
  }

  /**
   * 识别手牌里「潜在能打出的炸弹」（自然炸弹 + 用逢人配凑出的）。
   * 只做保守统计：同点≥4、四大天王、同花顺（含 A2345），配牌只补缺张。
   * 返回 {bombs, wildCount}；bombs 每项 {kind, size, rank, label, power}。
   */
  function bombsOf(cards, level) {
    const lv = normLevel(level);
    const list = sortCards(cards, lv);
    const wilds = [];
    const others = [];
    for (let i = 0; i < list.length; i++) {
      if (isWildCard(list[i], lv)) wilds.push(list[i]);
      else others.push(list[i]);
    }
    const u = wilds.length;
    const out = [];

    // 1) 四大天王（两副牌：两张大 + 两张小，id 可能是 53/107、54/108）
    let big = 0;
    let small = 0;
    for (let i = 0; i < others.length; i++) {
      const r = rankOf(others[i]);
      if (r === 17) big++;
      else if (r === 16) small++;
    }
    if (big >= 2 && small >= 2) {
      out.push({ kind: 'fourJokers', size: 4, rank: 0, label: '四大天王', power: 99 });
    }

    // 2) 同点炸弹（自然 / 配牌）
    const groups = {};
    for (let i = 0; i < others.length; i++) {
      const c = others[i];
      if (rankOf(c) >= 16) continue;
      const r = rankOf(c);
      const ord = levelOrder(r, lv);
      const g = groups[ord] || (groups[ord] = { rank: r, order: ord, size: 0 });
      g.size++;
    }
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      if (g.size >= 4 && g.size <= 8) {
        out.push({ kind: 'sameRank', size: g.size, rank: g.rank, label: g.size + '张' + rankText(g.rank), power: g.size });
      } else if (u > 0) {
        const size = g.size + u;
        if (size >= 4 && size <= 8) {
          out.push({ kind: 'sameRank', size: size, rank: g.rank, label: size + '张' + rankText(g.rank) + '（配）', power: size });
        }
      }
    });

    // 3) 同花顺（自然 / 配牌；A 可作 1 组成 A2345）
    for (let suit = 0; suit < 4; suit++) {
      const ranks = {};
      for (let i = 0; i < others.length; i++) {
        const c = others[i];
        if (rankOf(c) >= 16) continue;
        if (suitOf(c) !== suit) continue;
        ranks[rankOf(c)] = true;
      }
      for (let b = 5; b <= 14; b++) {
        let need = 0;
        let present = 0;
        for (let p = b - 4; p <= b; p++) {
          const r = (b === 5 && p === 1) ? 14 : p; // b=5 即 A2345，1 代表 A
          if (ranks[r]) present++;
          else need++;
        }
        if (present < 1) continue;
        if (need === 0) {
          out.push({ kind: 'straightFlush', size: 5, rank: b, label: '同花顺 ' + SUIT_TEXT[suit] + rankText(b), power: 5.5 });
        } else if (u > 0 && need <= u) {
          out.push({ kind: 'straightFlush', size: 5, rank: b, label: '同花顺 ' + SUIT_TEXT[suit] + rankText(b) + '（配）', power: 5.5 });
        }
      }
    }

    out.sort(function (a, b) {
      if (b.power !== a.power) return b.power - a.power;
      return b.size - a.size;
    });
    return { bombs: out, wildCount: u };
  }

  function partnerOf(seat) {
    const s = num(seat, 0);
    return s <= 2 ? s + 2 : (s >= 3 ? s - 2 : 0);
  }

  function relName(seat, mySeat) {
    const s = num(seat, 0);
    const me = num(mySeat, 0);
    if (!s || !me) return '';
    if (s === me) return '我';
    if (s === partnerOf(me)) return '对家';
    if (s === (me % 4) + 1) return '下家';
    return '上家';
  }

  /**
   * 透视主入口：expanded 为 GDSite.expandState() 的结果。
   * 只读取 playerCardLists / playerRestCardCounts / level，不修改入参。
   */
  function buildXray(expanded, mySeat) {
    const e = expanded && typeof expanded === 'object' ? expanded : {};
    const seat = num(mySeat, 0);
    const lv = normLevel(e.level);
    const base = {
      ok: false,
      reason: 'no-data',
      level: lv,
      levelText: rankText(lv),
      wildText: '♥' + rankText(lv),
      mySeat: seat,
      partnerSeat: partnerOf(seat),
      seats: [],
      warnings: [],
      totalCards: 0,
      bombCount: 0,
    };
    if (!seat || seat < 1 || seat > 4) {
      base.reason = 'not-seated';
      return base;
    }

    const lists = Array.isArray(e.playerCardLists) ? e.playerCardLists : [];
    const rests = Array.isArray(e.playerRestCardCounts) ? e.playerRestCardCounts : [];
    const order = [seat % 4 + 1, partnerOf(seat), seat === 1 ? 4 : seat - 1];
    const seats = [];
    let totalCards = 0;
    let bombCount = 0;
    let unavailableCount = 0;

    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      const raw = Array.isArray(lists[s]) ? lists[s] : [];
      const cards = sortCards(raw, lv);
      const rest = num(rests[s], cards.length);
      const bombsInfo = bombsOf(cards, lv);
      const unavailable = cards.length === 0 && rest > 0;
      if (unavailable) unavailableCount++;
      totalCards += cards.length;
      bombCount += bombsInfo.bombs.length;
      const seatInfo = {
        seat: s,
        name: relName(s, seat),
        isPartner: s === partnerOf(seat),
        count: rest > 0 ? rest : cards.length,
        cards: cards.map(function (id) { return cardInfo(id, lv); }),
        bombs: bombsInfo.bombs,
        wildCount: bombsInfo.wildCount,
        unavailable: unavailable,
      };
      seats.push(seatInfo);
      if (seatInfo.bombs.length) {
        base.warnings.push(seatInfo.name + ' 有 ' + seatInfo.bombs.length + ' 个炸弹（' +
          seatInfo.bombs.map(function (b) { return b.label; }).join('、') + '）');
      }
    }

    base.seats = seats;
    base.totalCards = totalCards;
    base.bombCount = bombCount;
    if (!totalCards) base.reason = unavailableCount ? 'no-data' : 'no-cards';
    else if (unavailableCount) base.reason = 'partial';
    else base.reason = 'ok';
    base.ok = totalCards > 0;
    return base;
  }

  /** 面板底部的一句话汇总 */
  function summaryOf(xray) {
    if (!xray || !xray.seats || !xray.seats.length || !xray.totalCards) return '暂无可透视的手牌';
    let wilds = 0;
    for (let i = 0; i < xray.seats.length; i++) wilds += xray.seats[i].wildCount || 0;
    return '可见 ' + xray.totalCards + ' 张 · 炸弹 ' + xray.bombCount + ' 个' + (wilds ? ' · 逢人配 ' + wilds + ' 张' : '');
  }

  return {
    VERSION: VERSION,
    TOTAL: TOTAL,
    SUIT_TEXT: SUIT_TEXT.slice(),
    buildXray: buildXray,
    bombsOf: bombsOf,
    sortCards: sortCards,
    cardInfo: cardInfo,
    rankOf: rankOf,
    suitOf: suitOf,
    rankText: rankText,
    levelOrder: levelOrder,
    isWildCard: isWildCard,
    relName: relName,
    partnerOf: partnerOf,
    summaryOf: summaryOf,
    _internals: {
      VERSION: VERSION,
      TOTAL: TOTAL,
      BIG_JOKER: BIG_JOKER,
      SMALL_JOKER: SMALL_JOKER,
      RANK_TEXT: RANK_TEXT,
      normalizeId: normalizeId,
      cardLocal: cardLocal,
      cardDeck: cardDeck,
      normLevel: normLevel,
    },
  };
});

/*!
 * gd.site.ai.js — 掼蛋 AI 助手（油猴版）· 本地启发式出牌
 *
 * 依赖全局 `GDSite`（浏览器）/ `require('./gd.site.core.js')`（Node）；契约见 SPEC2.md §3。
 * 纯逻辑、无 DOM、不联网。
 */
(function (root, factory) {
  const G = (typeof module !== 'undefined' && module.exports)
    ? require('./gd.site.core.js')
    : root.GDSite;
  const api = factory(G);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteAI = api;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const BOMB_TYPES = {};
  BOMB_TYPES[G.TYPE.Four] = true;
  BOMB_TYPES[G.TYPE.Five] = true;
  BOMB_TYPES[G.TYPE.StraightFlush] = true;
  BOMB_TYPES[G.TYPE.Six] = true;
  BOMB_TYPES[G.TYPE.Seven] = true;
  BOMB_TYPES[G.TYPE.Eight] = true;
  BOMB_TYPES[G.TYPE.FourJokers] = true;

  function isBombType(type) {
    return !!BOMB_TYPES[type];
  }

  function countByRank(hand, level) {
    const lv = G.normLevel(level);
    const cnt = {};
    let wilds = 0;
    let levelCards = 0;
    (hand || []).forEach(function (c) {
      if (G.isWildCard(c, lv)) wilds += 1;
      const r = G.rankOf(c);
      if (r === lv) levelCards += 1;
      cnt[r] = (cnt[r] || 0) + 1;
    });
    return { cnt: cnt, wilds: wilds, levelCards: levelCards };
  }

  /**
   * 贪心估计「这手牌最少还要出几手」（用于比较出牌收益）。
   */
  function playsEstimate(hand, level) {
    const lv = G.normLevel(level);
    const cs = (hand || []).map(Number).filter(function (c) { return c >= 1 && c <= 108; });
    if (!cs.length) return 0;
    const info = countByRank(cs, lv);
    const cnt = info.cnt;
    const wildCount = info.wilds;
    let plays = 0;

    function take(r, n) {
      cnt[r] = Math.max(0, (cnt[r] || 0) - n);
    }

    // 王对子
    [17, 16].forEach(function (r) {
      if ((cnt[r] || 0) >= 2) { plays += 1; take(r, 2); }
    });

    // 炸弹（同点 4 张以上，一次出完）
    Object.keys(cnt).map(Number).forEach(function (r) {
      if (r < 16 && cnt[r] >= 4) { plays += 1; take(r, cnt[r]); }
    });

    // 顺子（只贪心自然牌，A 可当 1 或 14）
    let guard = 0;
    while (guard < 6) {
      guard += 1;
      let found = false;
      for (let b = 14; b >= 5 && !found; b--) {
        const pos = [];
        for (let P = b - 4; P <= b; P++) pos.push((P === 1 && b === 5) ? 14 : P);
        if (pos.every(function (r) { return (cnt[r] || 0) >= 1; })) {
          pos.forEach(function (r) { take(r, 1); });
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 钢板（连续两组三张）
    guard = 0;
    while (guard < 4) {
      guard += 1;
      let found = false;
      for (let e = 14; e >= 2 && !found; e--) {
        const a = (e === 2) ? 14 : e - 1;
        if ((cnt[a] || 0) >= 3 && (cnt[e] || 0) >= 3) {
          take(a, 3); take(e, 3);
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 三连对
    guard = 0;
    while (guard < 4) {
      guard += 1;
      let found = false;
      for (let e = 14; e >= 3 && !found; e--) {
        const win = [(e === 3) ? 14 : e - 2, e - 1, e];
        if (win.every(function (r) { return (cnt[r] || 0) >= 2; })) {
          win.forEach(function (r) { take(r, 2); });
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 三带二：一组三张 + 一副对子合并为 1 手（比分出少 1 手）
    const triRanks = [], pairRanks = [];
    for (let r = 15; r >= 2; r--) if ((cnt[r] || 0) >= 3) triRanks.push(r);
    for (let r = 15; r >= 2; r--) if ((cnt[r] || 0) === 2) pairRanks.push(r);
    while (triRanks.length && pairRanks.length) {
      const tr = triRanks.shift();
      const pr = pairRanks.shift();
      take(tr, 3); take(pr, 2);
      plays += 1;
    }

    // 三张 / 对子 / 单张
    [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].forEach(function (r) {
      let left = cnt[r] || 0;
      while (left >= 3) { plays += 1; left -= 3; }
      if (left >= 2) { plays += 1; left = 0; }
      if (left === 1) { plays += 1; }
      cnt[r] = 0;
    });

    // 逢人配：优先并入现有的单张/对子减少手数，剩下一对算 1 手
    if (wildCount > 0) {
      const merged = Math.min(wildCount, plays);
      plays -= merged;
      const rest = wildCount - merged;
      if (rest > 0) plays += Math.ceil(rest / 2);
    }

    return Math.max(1, plays);
  }

  function countBombs(hand, level) {
    const lv = G.normLevel(level);
    const info = countByRank(hand, lv);
    const cnt = info.cnt;
    let bombs = 0;
    Object.keys(cnt).map(Number).forEach(function (r) {
      if (r < 16 && cnt[r] >= 4) bombs += 1;
    });
    if ((cnt[17] || 0) >= 2 && (cnt[16] || 0) >= 2) bombs += 1;
    return bombs;
  }

  function handSummary(hand, level) {
    const lv = G.normLevel(level);
    const cs = hand || [];
    const info = countByRank(cs, lv);
    return {
      size: cs.length,
      bombs: countBombs(cs, lv),
      wilds: info.wilds,
      levelCards: info.levelCards,
      playsEstimate: playsEstimate(cs, lv)
    };
  }

  function opponentThreat(state) {
    const partner = state.partnerSeat;
    const seats = state.seatsRemaining || [];
    let min = Infinity;
    let who = 0;
    seats.forEach(function (s) {
      if (s.isMe || s.isPartner || s.seat === partner) return;
      if (s.count > 0 && s.count < min) { min = s.count; who = s.seat; }
    });
    return { isThreat: min <= 3, count: min, seat: who };
  }

  /** 是否拆掉了手里的炸弹（单张/对子/三张从 4 张同点里抽牌） */
  function breaksBomb(play, hand, level) {
    if (play.bomb) return false;
    const lv = G.normLevel(level);
    const info = countByRank(hand, lv);
    const used = countByRank(play.cards, lv).cnt;
    let broke = false;
    Object.keys(used).forEach(function (key) {
      const r = Number(key);
      if (r < 16 && (info.cnt[r] || 0) >= 4) broke = true;
    });
    return broke;
  }

  /**
   * 给单个候选打分（越高越推荐）。
   * - 一手出完：10000
   * - 领出看重「减少手数」，跟牌看重「用最小代价压住」
   * - 逢人配、炸弹有保留成本；队友牌权时大幅降分
   */
  function scorePlay(play, state) {
    const lv = G.normLevel(state.level);
    const hand = state.hand || [];
    const prev = state.prevCode || 0;
    if (!play || !play.cards || !play.cards.length) return -1e9;
    if (play.size === hand.length) return 10000;

    const info = handSummary(hand, lv);
    const after = hand.filter(function (c) { return play.cards.indexOf(c) < 0; });
    const estAfter = playsEstimate(after, lv);
    const reduction = Math.max(0, info.playsEstimate - estAfter);
    const wildsUsed = play.cards.filter(function (c) { return G.isWildCard(c, lv); }).length;
    const rank = play.rank || 0;

    let score = 0;
    if (!prev) {
      score = reduction * 12 + play.size * 4 - rank * 0.3;
      if (play.bomb) score -= 20 + play.bomb * 2;
    } else {
      score = (14 - rank) * 0.4 + reduction * 8;
      if (play.bomb) score -= 30 + play.bomb * 2;
      const owner = state.trickOwner || 0;
      if (owner && G.sameTeam(owner, state.mySeat)) score -= 100;
      const threat = opponentThreat(state);
      if (threat.isThreat) score += 45 + play.size * 2 + (play.bomb ? 20 : 0);
    }
    score -= wildsUsed * 10;
    if (breaksBomb(play, hand, lv)) score -= 8;
    if (play.bomb && !prev && play.size >= 4) score -= 4;
    return Math.round(score * 100) / 100;
  }

  function tagOf(play, state) {
    if (play.size === (state.hand || []).length) return '一手出完';
    if (play.bomb) return '炸弹';
    if (!state.prevCode) return '领出';
    const threat = opponentThreat(state);
    if (threat.isThreat) return '拦截';
    return '跟牌';
  }

  function dedupeScored(list, limit) {
    const out = [];
    const seen = {};
    for (let i = 0; i < list.length && out.length < limit; i++) {
      const item = list[i];
      const key = item.play.type + '|' + item.play.rank + '|' + item.play.size;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(item);
    }
    return out;
  }

  function candidates(state, limit) {
    const lim = Math.max(1, Math.floor(Number(limit) || 12));
    const hand = state.hand || [];
    if (!hand.length) return [];
    const prev = state.prevCode || 0;
    const moves = G.genMoves(hand, state.level, prev);
    const scored = moves.map(function (play) {
      return { play: play, score: scorePlay(play, state), tag: tagOf(play, state) };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.play.cards.length !== b.play.cards.length) return a.play.cards.length - b.play.cards.length;
      return (a.play.rank || 0) - (b.play.rank || 0);
    });
    return dedupeScored(scored, lim);
  }

  function suggest(state) {
    const hand = state.hand || [];
    const handInfo = handSummary(hand, state.level);
    const empty = { source: 'local', action: 'pass', play: null, reason: '', candidates: [], handInfo: handInfo };

    if (!hand.length) { empty.reason = '手里没有牌'; return empty; }
    if (!state.isMyTurn) { empty.reason = '还没轮到我'; return empty; }
    if (state.phase === 'tribute' || state.phase === 'return') {
      empty.reason = '当前是进贡/还贡阶段';
      return empty;
    }

    const cands = candidates(state, 12);
    const partner = state.partnerSeat;
    const owner = state.trickOwner || 0;

    // 1) 能一手出完：无论牌权在谁，直接出完
    const finish = cands.filter(function (c) { return c.play.size === hand.length; })
      .sort(function (a, b) { return (a.play.rank || 0) - (b.play.rank || 0); })[0];
    if (finish) {
      return {
        source: 'local', action: 'play', play: finish.play,
        reason: '一手出完（' + finish.play.name + '），本局结束',
        candidates: cands, handInfo: handInfo
      };
    }

    // 2) 队友牌权：默认让过
    if (owner && (owner === partner || G.sameTeam(owner, state.mySeat))) {
      return {
        source: 'local', action: 'pass', play: null,
        reason: '队友当前最大，让过（除非能一手出完）',
        candidates: cands, handInfo: handInfo
      };
    }

    // 3) 没有能压过的牌
    if (!cands.length) {
      return {
        source: 'local', action: 'pass', play: null,
        reason: state.prevCode ? '没有能压过的牌，过' : '没有可出的牌',
        candidates: [], handInfo: handInfo
      };
    }

    // 4) 取最优
    const best = cands[0];
    let reason;
    if (!state.prevCode) {
      reason = '领出 ' + best.play.name + ' ' + G.cardTexts(best.play.cards).join('')
        + '，减少手数（预计还需 ' + handInfo.playsEstimate + ' 手）';
    } else {
      const threat = opponentThreat(state);
      if (threat.isThreat && best.play.bomb) {
        reason = '对手只剩 ' + threat.count + ' 张，用' + best.play.name + '拦截';
      } else {
        reason = '跟牌：用' + best.play.name + ' ' + G.cardTexts(best.play.cards).join('')
          + ' 压住（预计还需 ' + handInfo.playsEstimate + ' 手）';
      }
    }
    return {
      source: 'local', action: 'play', play: best.play,
      reason: reason, candidates: cands, handInfo: handInfo
    };
  }

  /** 转成 GDDeepSeek 的 localSuggestion 结构（回退用） */
  function toLocalSuggestion(suggestion) {
    const s = suggestion || {};
    const play = s.play || null;
    return {
      action: s.action || 'pass',
      play: play,
      reason: s.reason || '',
      typeName: play ? play.name : '过',
      cards: play ? G.cardTexts(play.cards) : []
    };
  }

  return {
    VERSION: '1.0.0',
    isBombType: isBombType,
    playsEstimate: playsEstimate,
    countBombs: countBombs,
    handSummary: handSummary,
    opponentThreat: opponentThreat,
    scorePlay: scorePlay,
    candidates: candidates,
    suggest: suggest,
    toLocalSuggestion: toLocalSuggestion
  };
});

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

/* ============================================================
 * 掼蛋 AI 助手（game.hullqin.cn 油猴版）· 面板 UI
 * ------------------------------------------------------------
 * 职责：纯 UI。按 SPEC2 §5 的 snapshot 全量渲染面板；
 *       不读 React fiber、不调用 GDSite / GDSiteAI / GDSiteRemote 等引擎逻辑，
 *       所有动作只通过 opts 回调交给 body 处理。
 *
 * 用法（body 中）：
 *   const ui = GDSiteUI.create(container, {
 *     onLocalSuggest(){...}, onDeepSeekSuggest(){...}, onAdopt(snapshot){...},
 *     onPass(){...}, onTribute(){...}, onReturn(){...}, onUndo?(){...},
 *     onNextRound?(){...}, onToggleAuto?(auto){...},
 *     onSaveSettings(settings){...}, onTestConnection(settings){ return Promise<{ok,message}> },
 *     onOpenHelp?(){...}
 *   });
 *   HQ.makeDraggable(container, ui.handle);
 *   ui.update(snapshot);           // 每 tick 调用
 *   ui.setSettings({hasKey, model, baseUrl, temperature, timeoutMs, auto});
 *
 * UMD：浏览器挂 window.GDSiteUI；Node 下 module.exports（供纯函数测试）。
 * 无 CDN、无外部依赖、文案全中文、class 前缀 hqgd-。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteUI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const PREFIX = 'hqgd-';
  const STYLE_ID = 'hqgd-style';
  const PANEL_ID = 'hqgd-panel';

  /** 记牌器展示顺序：大王 / 小王 / A K Q J 10 9 8 7 6 5 4 3 2 */
  const COUNTER_ORDER = [17, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const COUNTER_INDEX = (function () {
    const m = {};
    for (let i = 0; i < COUNTER_ORDER.length; i++) m[COUNTER_ORDER[i]] = i;
    return m;
  })();

  const DEFAULT_SETTINGS = {
    hasKey: false,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.2,
    timeoutMs: 30000,
    auto: false,
    xray: false,
  };

  const MODEL_OPTIONS = ['deepseek-chat', 'deepseek-reasoner'];
  const SEAT_FALLBACK = ['我', '下家', '对家', '上家'];

  /* ============================================================
   * 纯函数（也通过 _internals 暴露，便于 Node 测试）
   * ============================================================ */

  function num(v, dft) {
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : dft;
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

  /** 点数文本：2..10/J/Q/K/A/小王/大王 */
  function rankLabel(rank) {
    const r = num(rank, 0);
    if (r === 17) return '大王';
    if (r === 16) return '小王';
    if (r === 14) return 'A';
    if (r === 13) return 'K';
    if (r === 12) return 'Q';
    if (r === 11) return 'J';
    if (r >= 2 && r <= 10) return String(r);
    return String(rank == null ? '' : rank);
  }

  /** Key 掩码：只留前缀标识与后 4 位，绝不返回完整 Key */
  function maskKey(key) {
    const s = str(key);
    if (!s) return '';
    if (s.length <= 8) return '****';
    const head = /^sk-/i.test(s) ? 'sk-' : '';
    return head + '****' + s.slice(-4);
  }

  /** 按记牌器顺序排序（不修改入参；未知 rank 排在最后） */
  function orderCounter(items) {
    const arr = Array.isArray(items) ? items.slice() : [];
    return arr
      .map(function (it, i) {
        const rank = num(it && it.rank, 0);
        return { it: it, i: i, key: COUNTER_INDEX[rank] == null ? 99 : COUNTER_INDEX[rank] };
      })
      .sort(function (a, b) { return a.key - b.key || a.i - b.i; })
      .map(function (x) { return x.it; });
  }

  /** 记牌器汇总文案 */
  function formatCounterSummary(counter) {
    const c = counter && typeof counter === 'object' ? counter : {};
    const unknown = num(c.unknown, null);
    const played = num(c.playedCount, null);
    const wild = num(c.wildRemaining, null);
    if (unknown == null && played == null && wild == null) return '';
    const parts = [];
    if (unknown != null) parts.push('未知 ' + unknown);
    if (played != null) parts.push('已出 ' + played);
    if (wild != null) parts.push('逢人配 ' + wild);
    return parts.join(' · ');
  }

  /** 我的手牌信息文案 */
  function formatHandInfo(info) {
    if (!info || typeof info !== 'object') return '';
    const size = num(info.size, null);
    if (size == null) return '';
    const parts = [size + ' 张'];
    if (num(info.bombs, 0) > 0) parts.push('炸弹 ' + num(info.bombs, 0));
    if (num(info.wilds, 0) > 0) parts.push('逢人配 ' + num(info.wilds, 0));
    if (num(info.playsEstimate, null) != null) parts.push('预计 ' + num(info.playsEstimate, 0) + ' 手');
    return parts.join(' · ');
  }

  const PHASE_TEXT = {
    tribute: '进贡阶段',
    return: '还贡阶段',
    play: '出牌阶段',
    finish: '本局结束',
  };

  function phaseText(phase) {
    return PHASE_TEXT[phase] || '';
  }

  function errText(e) {
    if (e == null) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    try { return String(e); } catch (_) { return '未知错误'; }
  }

  /* ---------------- snapshot 归一化（防御站点/body 给缺失字段） ---------------- */

  function normCounter(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
      byRank: Array.isArray(c.byRank) ? c.byRank : [],
      wildRemaining: num(c.wildRemaining, null),
      playedCount: num(c.playedCount, null),
      unknown: num(c.unknown, null),
    };
  }

  function normSeat(raw, i) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      seat: num(s.seat, 0),
      name: str(s.name) || SEAT_FALLBACK[i] || '',
      count: num(s.count, 0),
      isMe: !!s.isMe,
      isPartner: !!s.isPartner,
      tribute: !!s.tribute,
      rankBadge: s.rankBadge == null ? null : num(s.rankBadge, null),
    };
  }

  function normSuggestion(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const action = raw.action === 'pass' ? 'pass' : 'play';
    const candidates = Array.isArray(raw.candidatesText)
      ? raw.candidatesText.map(function (c) { return typeof c === 'string' ? c : str(c); }).filter(Boolean)
      : [];
    return {
      source: raw.source === 'deepseek' ? 'deepseek' : 'local',
      action: action,
      name: str(raw.name),
      cardsText: str(raw.cardsText),
      desc: str(raw.desc),
      reason: str(raw.reason),
      error: str(raw.error),
      candidatesText: candidates,
    };
  }

  function normLastPlay(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      seatName: str(raw.seatName),
      name: str(raw.name),
      cardsText: str(raw.cardsText),
    };
  }

  function normTribute(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      mode: raw.mode === 'return' ? 'return' : 'tribute',
      fromName: str(raw.fromName),
      toName: str(raw.toName),
      candidatesText: str(raw.candidatesText),
      suggestText: str(raw.suggestText),
    };
  }

  function normSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      hasKey: !!s.hasKey,
      model: str(s.model) || DEFAULT_SETTINGS.model,
      baseUrl: str(s.baseUrl) || DEFAULT_SETTINGS.baseUrl,
      xray: !!s.xray,
    };
  }

  function normXrayCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: num(raw.id, 0),
      text: str(raw.text),
      red: !!raw.red,
      isLevel: !!raw.isLevel,
      isWild: !!raw.isWild,
      isJoker: !!raw.isJoker,
    };
  }

  function normXrayBomb(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      kind: str(raw.kind),
      size: num(raw.size, 0),
      label: str(raw.label) || '炸弹',
      power: num(raw.power, 0),
    };
  }

  function normXraySeat(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      seat: num(s.seat, 0),
      name: str(s.name),
      isPartner: !!s.isPartner,
      count: num(s.count, 0),
      cards: Array.isArray(s.cards) ? s.cards.map(normXrayCard).filter(Boolean) : [],
      bombs: Array.isArray(s.bombs) ? s.bombs.map(normXrayBomb).filter(Boolean) : [],
      wildCount: num(s.wildCount, 0),
      unavailable: !!s.unavailable,
    };
  }

  function normXray(raw) {
    const x = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: !!x.enabled,
      seats: Array.isArray(x.seats) ? x.seats.map(normXraySeat) : [],
      warnings: Array.isArray(x.warnings)
        ? x.warnings.filter(function (t) { return typeof t === 'string' && t; })
        : [],
      note: str(x.note),
      totalCards: num(x.totalCards, 0),
      bombCount: num(x.bombCount, 0),
    };
  }

  /** 把外部 snapshot 归一化成渲染用的安全结构（缺失字段有默认值，不修改入参） */
  function normalizeSnapshot(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const seats = Array.isArray(s.seats) ? s.seats.map(normSeat) : [];
    return {
      visible: s.visible !== false,
      isGuandan: s.isGuandan !== false,
      mySeat: num(s.mySeat, 0),
      phase: typeof s.phase === 'string' ? s.phase : '',
      level: num(s.level, 0),
      levelText: str(s.levelText),
      wildText: str(s.wildText),
      turn: !!s.turn,
      seats: seats,
      counter: normCounter(s.counter),
      handInfo: s.handInfo && typeof s.handInfo === 'object' ? s.handInfo : null,
      lastPlay: normLastPlay(s.lastPlay),
      history: Array.isArray(s.history) ? s.history : [],
      suggestion: normSuggestion(s.suggestion),
      tribute: normTribute(s.tribute),
      xray: normXray(s.xray),
      busy: !!s.busy,
      auto: s.auto === undefined ? undefined : !!s.auto,
      settings: normSettings(s.settings),
    };
  }

  /* ============================================================
   * 样式（注入到 document.head，只注入一次；destroy 后按引用计数移除）
   * ============================================================ */

  const CSS = [
    '.hqgd-panel{position:relative;width:260px;max-height:80vh;overflow:auto;overflow-x:hidden;',
    'background:rgba(15,23,42,.94);color:#e2e8f0;border:1px solid #334155;border-radius:12px;',
    'box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(6px);',
    "font:12px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;",
    'user-select:none;box-sizing:border-box;text-align:left}',
    '.hqgd-panel *{box-sizing:border-box}',
    '.hqgd-panel .hqgd-head{display:flex;align-items:center;gap:5px;padding:7px 8px 6px;cursor:move;',
    'background:linear-gradient(180deg,#1e293b,#0f172a);border-bottom:1px solid #334155;border-radius:12px 12px 0 0}',
    '.hqgd-panel .hqgd-title{font-size:13px;font-weight:700;color:#f1f5f9;white-space:nowrap}',
    '.hqgd-panel .hqgd-badge{font-size:9.5px;color:#7dd3fc;background:rgba(56,189,248,.12);',
    'border:1px solid rgba(56,189,248,.35);border-radius:6px;padding:1px 4px;white-space:nowrap;',
    'overflow:hidden;text-overflow:ellipsis;max-width:104px}',
    '.hqgd-panel .hqgd-head-btns{margin-left:auto;display:flex;align-items:center;gap:1px}',
    '.hqgd-panel .hqgd-icon-btn{background:transparent;border:none;color:#94a3b8;cursor:pointer;',
    'font:inherit;font-size:12px;line-height:1;padding:2px 3px;border-radius:5px}',
    '.hqgd-panel .hqgd-icon-btn:hover{color:#e2e8f0;background:#334155}',
    '.hqgd-panel .hqgd-icon-btn.hqgd-on{color:#0f172a;background:#38bdf8;font-weight:700}',
    '.hqgd-panel .hqgd-body{padding:7px 8px 8px;display:flex;flex-direction:column;gap:6px}',
    '.hqgd-panel .hqgd-sec{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:6px 7px}',
    '.hqgd-panel .hqgd-sec-title{font-size:10px;color:#94a3b8;letter-spacing:.5px;margin-bottom:4px}',
    '.hqgd-panel .hqgd-counter-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:3px}',
    '.hqgd-panel .hqgd-cc{position:relative;display:flex;flex-direction:column;align-items:center;',
    'background:#0f172a;border:1px solid #334155;border-radius:5px;padding:2px 0 1px;line-height:1.15}',
    '.hqgd-panel .hqgd-cc i{font-style:normal;font-size:9.5px;color:#94a3b8;white-space:nowrap}',
    '.hqgd-panel .hqgd-cc b{font-size:12.5px;font-weight:700;color:#f1f5f9}',
    '.hqgd-panel .hqgd-cc-zero{opacity:.3}',
    '.hqgd-panel .hqgd-cc-level{border-color:#eab308;box-shadow:inset 0 0 0 1px rgba(234,179,8,.35)}',
    '.hqgd-panel .hqgd-cc-level b{color:#facc15}',
    '.hqgd-panel .hqgd-cc-wild{border-color:#f472b6}',
    '.hqgd-panel .hqgd-cc-wild i,.hqgd-panel .hqgd-cc-wild b{color:#f9a8d4}',
    '.hqgd-panel .hqgd-cc-mark{position:absolute;top:-5px;right:-3px;font-style:normal;font-size:8px;',
    'font-weight:700;line-height:1;padding:1px 2px;border-radius:4px;background:#eab308;color:#0f172a}',
    '.hqgd-panel .hqgd-cc-mark-wild{background:#f472b6}',
    '.hqgd-panel .hqgd-counter-sum{margin-top:4px;font-size:9.5px;color:#94a3b8;text-align:center}',
    '.hqgd-panel .hqgd-notice{background:rgba(56,189,248,.08);border:1px dashed rgba(56,189,248,.35);',
    'border-radius:8px;padding:6px 8px;font-size:10.5px;color:#7dd3fc;text-align:center;line-height:1.5}',
    '.hqgd-panel .hqgd-myinfo{font-size:11px;color:#cbd5e1;text-align:center}',
    '.hqgd-panel .hqgd-seat-row{display:flex;align-items:center;gap:4px;padding:1.5px 0;font-size:11px}',
    '.hqgd-panel .hqgd-seat-name{min-width:32px;color:#cbd5e1;white-space:nowrap}',
    '.hqgd-panel .hqgd-seat-me .hqgd-seat-name{color:#7dd3fc;font-weight:700}',
    '.hqgd-panel .hqgd-seat-partner .hqgd-seat-name{color:#86efac}',
    '.hqgd-panel .hqgd-seat-count{margin-left:auto;font-weight:700;color:#f1f5f9;white-space:nowrap}',
    '.hqgd-panel .hqgd-seat-tag{font-size:8.5px;line-height:1.2;padding:0 3px;border-radius:4px;',
    'background:#334155;color:#94a3b8;font-weight:400;white-space:nowrap}',
    '.hqgd-panel .hqgd-seat-tag-tribute{background:rgba(234,179,8,.2);color:#facc15}',
    '.hqgd-panel .hqgd-seat-tag-rank{background:rgba(168,85,247,.22);color:#d8b4fe}',
    '.hqgd-panel .hqgd-lastplay{margin-top:4px;padding-top:4px;border-top:1px dashed #334155;',
    'font-size:10px;color:#94a3b8;word-break:break-all;line-height:1.45}',
    '.hqgd-panel .hqgd-hist{margin-top:3px;font-size:9.5px;color:#64748b;word-break:break-all;line-height:1.5}',
    '.hqgd-panel .hqgd-suggest-head{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
    '.hqgd-panel .hqgd-source{font-size:9px;font-weight:700;padding:0 4px;border-radius:4px;white-space:nowrap}',
    '.hqgd-panel .hqgd-source-local{background:rgba(56,189,248,.16);color:#7dd3fc;border:1px solid rgba(56,189,248,.4)}',
    '.hqgd-panel .hqgd-source-deepseek{background:rgba(168,85,247,.18);color:#d8b4fe;border:1px solid rgba(168,85,247,.45)}',
    '.hqgd-panel .hqgd-suggest-name{font-size:12px;font-weight:700;color:#f1f5f9}',
    '.hqgd-panel .hqgd-suggest-cards{font-size:11px;color:#e2e8f0;word-break:break-all;margin-top:2px}',
    '.hqgd-panel .hqgd-suggest-reason{font-size:10px;color:#94a3b8;margin-top:3px;line-height:1.45;word-break:break-all}',
    '.hqgd-panel .hqgd-suggest-error{color:#fca5a5}',
    '.hqgd-panel .hqgd-cand-toggle{display:block;background:none;border:none;padding:0;margin-top:4px;',
    'color:#7dd3fc;font:inherit;font-size:10px;cursor:pointer;text-align:left}',
    '.hqgd-panel .hqgd-cand-list{margin:4px 0 0;padding-left:15px;font-size:9.5px;color:#94a3b8;line-height:1.55}',
    '.hqgd-panel .hqgd-tribute-info{font-size:10.5px;color:#cbd5e1;line-height:1.5;word-break:break-all}',
    '.hqgd-panel .hqgd-tribute-row{margin-top:2px;color:#94a3b8}',
    '.hqgd-panel .hqgd-empty{font-size:10.5px;color:#64748b;text-align:center;padding:3px 0;line-height:1.5}',
    '.hqgd-panel .hqgd-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:1px}',
    '.hqgd-panel .hqgd-btn{cursor:pointer;border:1px solid transparent;border-radius:7px;padding:5px 3px;',
    'font:inherit;font-size:11px;line-height:1.35;background:#334155;color:#cbd5e1;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s}',
    '.hqgd-panel .hqgd-btn:hover:not(:disabled){background:#475569;color:#f1f5f9}',
    '.hqgd-panel .hqgd-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.hqgd-panel .hqgd-btn-primary{background:#0ea5e9;border-color:#38bdf8;color:#f0f9ff;font-weight:700}',
    '.hqgd-panel .hqgd-btn-primary:hover:not(:disabled){background:#38bdf8;color:#082f49}',
    '.hqgd-panel .hqgd-btn-deepseek{background:#7c3aed;border-color:#a78bfa;color:#f5f3ff;font-weight:700}',
    '.hqgd-panel .hqgd-btn-deepseek:hover:not(:disabled){background:#8b5cf6;color:#fff}',
    '.hqgd-panel .hqgd-btn-ghost{background:#1e293b;border-color:#334155;color:#94a3b8}',
    '.hqgd-panel .hqgd-btn-warn{background:#7f1d1d;border-color:#b91c1c;color:#fecaca}',
    '.hqgd-panel .hqgd-status{font-size:9.5px;color:#94a3b8;text-align:center;min-height:14px}',
    '.hqgd-panel .hqgd-status-turn{color:#67e8f9}',
    '.hqgd-panel .hqgd-toast{position:absolute;left:8px;right:8px;bottom:8px;z-index:5;pointer-events:none;',
    'background:rgba(2,6,23,.96);border:1px solid #334155;border-radius:7px;padding:5px 8px;',
    'font-size:10.5px;color:#e2e8f0;text-align:center;line-height:1.45;word-break:break-all;',
    'opacity:0;transform:translateY(6px);transition:opacity .16s,transform .16s}',
    '.hqgd-panel .hqgd-toast-on{opacity:1;transform:none}',
    '.hqgd-panel .hqgd-toast-error{border-color:#b91c1c;color:#fca5a5}',
    '.hqgd-panel .hqgd-toast-success{border-color:#15803d;color:#bbf7d0}',
    '.hqgd-panel.hqgd-min .hqgd-body{display:none}',
    '.hqgd-overlay{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;',
    'align-items:center;justify-content:center;background:rgba(2,6,23,.62);',
    "font:12px/1.55 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}",
    '.hqgd-overlay .hqgd-modal{width:300px;max-width:calc(100vw - 24px);max-height:86vh;overflow:auto;',
    'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;',
    'box-shadow:0 18px 60px rgba(0,0,0,.6);text-align:left}',
    '.hqgd-overlay .hqgd-modal-head{display:flex;align-items:center;gap:6px;padding:9px 12px;',
    'font-size:13px;font-weight:700;color:#f1f5f9;border-bottom:1px solid #1e293b;border-radius:12px 12px 0 0;',
    'background:linear-gradient(180deg,#1e293b,#0f172a)}',
    '.hqgd-overlay .hqgd-modal-head .hqgd-modal-close{margin-left:auto;background:transparent;border:none;',
    'color:#94a3b8;font:inherit;font-size:15px;line-height:1;cursor:pointer;padding:1px 3px;border-radius:5px}',
    '.hqgd-overlay .hqgd-modal-head .hqgd-modal-close:hover{color:#f1f5f9;background:#334155}',
    '.hqgd-overlay .hqgd-modal-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
    '.hqgd-overlay .hqgd-field{display:flex;flex-direction:column;gap:3px}',
    '.hqgd-overlay .hqgd-field>label{font-size:10.5px;color:#94a3b8}',
    '.hqgd-overlay .hqgd-field input,.hqgd-overlay .hqgd-field select{background:#1e293b;',
    'border:1px solid #334155;border-radius:6px;color:#e2e8f0;font:inherit;font-size:11.5px;',
    'padding:4px 6px;outline:none;min-width:0}',
    '.hqgd-overlay .hqgd-field input:focus,.hqgd-overlay .hqgd-field select:focus{border-color:#38bdf8}',
    '.hqgd-overlay .hqgd-field-row{display:flex;gap:8px}',
    '.hqgd-overlay .hqgd-field-row .hqgd-field{flex:1}',
    '.hqgd-overlay .hqgd-field-hint{font-size:9.5px;color:#64748b;line-height:1.45}',
    '.hqgd-overlay .hqgd-modal-status{font-size:10.5px;min-height:16px;line-height:1.45;word-break:break-all}',
    '.hqgd-overlay .hqgd-status-pending{color:#fbbf24}',
    '.hqgd-overlay .hqgd-status-success{color:#86efac}',
    '.hqgd-overlay .hqgd-status-error{color:#fca5a5}',
    '.hqgd-overlay .hqgd-modal-foot{display:flex;gap:6px;padding:9px 12px;border-top:1px solid #1e293b;flex-wrap:wrap}',
    '.hqgd-overlay .hqgd-modal-foot .hqgd-btn{flex:1;min-width:60px}',
    '.hqgd-overlay .hqgd-btn{cursor:pointer;border:1px solid transparent;border-radius:7px;padding:5px 4px;',
    'font:inherit;font-size:11px;line-height:1.4;background:#334155;color:#cbd5e1;white-space:nowrap;',
    'overflow:hidden;text-overflow:ellipsis;transition:background .12s}',
    '.hqgd-overlay .hqgd-btn:hover:not(:disabled){background:#475569;color:#f1f5f9}',
    '.hqgd-overlay .hqgd-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.hqgd-overlay .hqgd-btn-primary{background:#0ea5e9;border-color:#38bdf8;color:#f0f9ff;font-weight:700}',
    '.hqgd-overlay .hqgd-btn-primary:hover:not(:disabled){background:#38bdf8;color:#082f49}',
    '.hqgd-overlay .hqgd-btn-ghost{background:#1e293b;border-color:#334155;color:#94a3b8}',
    '.hqgd-overlay .hqgd-btn-warn{background:#7f1d1d;border-color:#b91c1c;color:#fecaca}',
    '.hqgd-overlay .hqgd-modal-foot .hqgd-btn{flex:1;min-width:58px;text-align:center}',
    '.hqgd-overlay .hqgd-help-sec{font-size:11px;font-weight:700;color:#7dd3fc;margin:2px 0 1px}',
    '.hqgd-overlay .hqgd-help-list{margin:0;padding-left:16px;font-size:10.5px;color:#94a3b8;line-height:1.6}',
    '.hqgd-overlay .hqgd-help-note{font-size:10px;color:#64748b;line-height:1.5;margin-top:2px}',
    '.hqgd-overlay .hqgd-kbd{display:inline-block;background:#1e293b;border:1px solid #334155;',
    'border-radius:4px;padding:0 3px;font-size:10px;color:#cbd5e1}',
    /* ---- 透视（仅本机可见） ---- */
    '#hqgd-panel .hqgd-xray-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}',
    '#hqgd-panel .hqgd-xray-toggle{cursor:pointer;border:1px solid #334155;border-radius:6px;',
    'padding:2px 7px;font:inherit;font-size:10px;line-height:1.5;background:#1e293b;color:#94a3b8;',
    'white-space:nowrap;transition:background .12s,color .12s}',
    '#hqgd-panel .hqgd-xray-toggle:hover{background:#334155;color:#e2e8f0}',
    '#hqgd-panel .hqgd-xray-toggle.hqgd-on{background:#7c2d12;border-color:#ea580c;color:#fed7aa;font-weight:700}',
    '#hqgd-panel .hqgd-xray-note{font-size:9.5px;line-height:1.5;color:#7c8ba1;margin-bottom:4px}',
    '#hqgd-panel .hqgd-xray-seat{border:1px solid #1e293b;border-radius:7px;padding:4px 6px;',
    'margin-bottom:4px;background:#111c30}',
    '#hqgd-panel .hqgd-xray-seat.hqgd-xray-partner{border-color:#155e75}',
    '#hqgd-panel .hqgd-xray-seat-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
    '#hqgd-panel .hqgd-xray-seat-name{font-size:10.5px;font-weight:700;color:#cbd5e1}',
    '#hqgd-panel .hqgd-xray-seat-count{font-size:10px;color:#94a3b8;margin-left:auto}',
    '#hqgd-panel .hqgd-xray-tag{font-size:9px;line-height:1.4;padding:0 3px;border-radius:4px;',
    'background:#083344;border:1px solid #155e75;color:#67e8f9}',
    '#hqgd-panel .hqgd-xray-chip{display:inline-block;font-size:10px;line-height:1.45;padding:0 3px;',
    'margin:1px 2px 1px 0;border-radius:4px;background:#1e293b;border:1px solid #334155;color:#e2e8f0}',
    '#hqgd-panel .hqgd-xray-chip.hqgd-xray-red{color:#f87171}',
    '#hqgd-panel .hqgd-xray-chip.hqgd-xray-level{background:#3b2f0b;border-color:#a16207;color:#fde68a}',
    '#hqgd-panel .hqgd-xray-chip.hqgd-xray-wild{background:#3b0f3a;border-color:#c026d3;color:#f5d0fe;font-weight:700}',
    '#hqgd-panel .hqgd-xray-chip.hqgd-xray-joker{background:#1e1b4b;border-color:#6366f1;color:#c7d2fe}',
    '#hqgd-panel .hqgd-xray-bomb{font-size:9.5px;line-height:1.45;padding:0 4px;border-radius:4px;',
    'background:#7f1d1d;border:1px solid #b91c1c;color:#fecaca}',
    '#hqgd-panel .hqgd-xray-empty{font-size:10px;color:#64748b;line-height:1.5;padding:2px 1px}',
    '#hqgd-panel .hqgd-xray-sum{font-size:9.5px;color:#64748b;line-height:1.5;margin-top:2px;word-break:break-all}',
  ].join('');

  /* ============================================================
   * GDSiteUI.create
   * ============================================================ */

  // 全局样式引用计数（同一文档多个面板共用一份 <style>）
  const styleDocs = [];
  const styleRefs = [];

  function ensureStyle(doc) {
    let idx = styleDocs.indexOf(doc);
    if (idx >= 0) { styleRefs[idx]++; return; }
    let styleEl = null;
    try { styleEl = doc.getElementById ? doc.getElementById(STYLE_ID) : null; } catch (_) { styleEl = null; }
    const created = !styleEl;
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = CSS;
      const head = doc.head || doc.body;
      if (head) head.appendChild(styleEl);
    }
    styleDocs.push(doc);
    styleRefs.push(created ? 1 : 0);
  }

  function releaseStyle(doc) {
    const idx = styleDocs.indexOf(doc);
    if (idx < 0) return;
    styleRefs[idx]--;
    if (styleRefs[idx] > 0) return;
    const styleEl = doc.getElementById ? doc.getElementById(STYLE_ID) : null;
    if (styleEl && styleEl.parentNode && styleRefs[idx] <= 0) {
      // 只有本模块创建的 style（ref 计数从 0 起）才移除；外部已有同名 style 时不动
      try { styleEl.parentNode.removeChild(styleEl); } catch (_) { /* ignore */ }
    }
    styleDocs.splice(idx, 1);
    styleRefs.splice(idx, 1);
  }

  function create(container, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    const doc = (container && container.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('GDSiteUI.create 需要 DOM 环境（container.ownerDocument 不可用）');
    }
    const host = container || doc.body;
    ensureStyle(doc);

    let destroyed = false;
    let minified = false;
    let candOpen = false;
    let toastTimer = null;
    let lastSnapshot = null;
    let lastSuggestion = null;
    let autoPending = null; // 本地先反馈自动托管开关，下一次 snapshot 到达后以 body 为准
    let xrayPending = null; // 本地先反馈透视开关，下一次 snapshot 到达后以 body 为准
    let settings = mergeSettings(DEFAULT_SETTINGS, opts.settings);
    let settingsUi = null; // {overlay, keyInput, ...}
    let helpUi = null;

    /* ---------- 小工具 ---------- */

    function el(tag, cls, text) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function on(node, type, fn) {
      if (node && typeof node.addEventListener === 'function') node.addEventListener(type, fn);
    }

    function btn(label, cls, handler) {
      const b = el('button', PREFIX + 'btn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      if (typeof handler === 'function') on(b, 'click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); handler(); });
      return b;
    }

    function callCb(name, arg) {
      const fn = opts[name];
      if (typeof fn !== 'function') return undefined;
      try {
        return fn(arg);
      } catch (e) {
        toast('回调执行失败：' + errText(e), 'error');
        return undefined;
      }
    }

    function toast(msg, type) {
      if (destroyed) return;
      toastEl.textContent = str(msg);
      toastEl.className = PREFIX + 'toast ' + PREFIX + 'toast-on' + (type ? ' ' + PREFIX + 'toast-' + type : '');
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      toastTimer = setTimeout(function () {
        toastTimer = null;
        if (!destroyed) toastEl.className = PREFIX + 'toast';
      }, 2600);
    }

    function mergeSettings(base, extra) {
      const out = {};
      const b = base || {};
      for (const k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
      const x = extra && typeof extra === 'object' ? extra : {};
      if (x.hasKey !== undefined) out.hasKey = !!x.hasKey;
      if (x.apiKey) out.hasKey = true;
      if (x.keyMask !== undefined) out.keyMask = str(x.keyMask);
      if (x.baseUrl !== undefined) out.baseUrl = str(x.baseUrl) || DEFAULT_SETTINGS.baseUrl;
      if (x.model !== undefined) out.model = str(x.model) || DEFAULT_SETTINGS.model;
      if (x.temperature !== undefined) out.temperature = num(x.temperature, DEFAULT_SETTINGS.temperature);
      if (x.timeoutMs !== undefined) out.timeoutMs = num(x.timeoutMs, DEFAULT_SETTINGS.timeoutMs);
      if (x.timeout !== undefined) out.timeoutMs = num(x.timeout, out.timeoutMs);
      if (x.auto !== undefined) out.auto = !!x.auto;
      if (x.xray !== undefined) out.xray = !!x.xray;
      return out;
    }

    /* ---------- 骨架 ---------- */

    const root = el('div', PREFIX + 'panel');
    root.id = PANEL_ID;

    const head = el('div', PREFIX + 'head');
    const titleEl = el('span', PREFIX + 'title', '🃏 掼蛋 AI 助手');
    const badgeEl = el('span', PREFIX + 'badge', '');
    const headBtns = el('div', PREFIX + 'head-btns');
    const autoBtn = btn('🤖', PREFIX + 'icon-btn', function () { toggleAuto(); });
    autoBtn.title = '自动托管：开/关';
    const settingsBtn = btn('⚙', PREFIX + 'icon-btn', function () { openSettings(); });
    settingsBtn.title = '设置';
    const helpBtn = btn('❓', PREFIX + 'icon-btn', function () { if (typeof opts.onOpenHelp === 'function') { callCb('onOpenHelp'); } openHelp(); });
    helpBtn.title = '帮助';
    const minBtn = btn('—', PREFIX + 'icon-btn', function () {
      minified = !minified;
      root.className = PREFIX + 'panel' + (minified ? ' ' + PREFIX + 'min' : '');
      minBtn.textContent = minified ? '▸' : '—';
      minBtn.title = minified ? '展开' : '收起';
    });
    minBtn.title = '收起';
    headBtns.appendChild(autoBtn);
    headBtns.appendChild(settingsBtn);
    headBtns.appendChild(helpBtn);
    headBtns.appendChild(minBtn);
    head.appendChild(titleEl);
    head.appendChild(badgeEl);
    head.appendChild(headBtns);

    const bodyEl = el('div', PREFIX + 'body');
    const noticeEl = el('div', PREFIX + 'notice', '');
    noticeEl.style.display = 'none';

    const secCounter = el('div', PREFIX + 'sec');
    const counterTitle = el('div', PREFIX + 'sec-title', '📋 记牌器');
    const counterGrid = el('div', PREFIX + 'counter-grid');
    const counterSum = el('div', PREFIX + 'counter-sum');
    secCounter.appendChild(counterTitle);
    secCounter.appendChild(counterGrid);
    secCounter.appendChild(counterSum);

    const secXray = el('div', PREFIX + 'sec');
    const xrayHead = el('div', PREFIX + 'xray-head');
    const xrayTitle = el('span', PREFIX + 'sec-title', '👁 透视 · 对手手牌');
    const xrayToggle = btn('透视：关', PREFIX + 'xray-toggle', function () { toggleXray(); });
    xrayToggle.title = '透视：点击开启（仅本机可见）';
    xrayHead.appendChild(xrayTitle);
    xrayHead.appendChild(xrayToggle);
    const xrayNote = el('div', PREFIX + 'xray-note', '开启后可查看其他三家手牌与炸弹预警（仅本机可见）。');
    const xrayList = el('div', PREFIX + 'xray-list');
    const xraySum = el('div', PREFIX + 'xray-sum', '');
    secXray.appendChild(xrayHead);
    secXray.appendChild(xrayNote);
    secXray.appendChild(xrayList);
    secXray.appendChild(xraySum);

    const secMy = el('div', PREFIX + 'sec');
    const myTitle = el('div', PREFIX + 'sec-title', '🙋 我的信息');
    const myInfo = el('div', PREFIX + 'myinfo', '');
    secMy.appendChild(myTitle);
    secMy.appendChild(myInfo);

    const secTable = el('div', PREFIX + 'sec');
    const tableTitle = el('div', PREFIX + 'sec-title', '🪑 牌桌');
    const seatsEl = el('div', PREFIX + 'seats');
    const lastPlayEl = el('div', PREFIX + 'lastplay', '');
    const histEl = el('div', PREFIX + 'hist', '');
    secTable.appendChild(tableTitle);
    secTable.appendChild(seatsEl);
    secTable.appendChild(lastPlayEl);
    secTable.appendChild(histEl);

    const secTribute = el('div', PREFIX + 'sec');
    const tributeTitle = el('div', PREFIX + 'sec-title', '🎁 进贡 / 还贡');
    const tributeInfo = el('div', PREFIX + 'tribute-info', '');
    secTribute.appendChild(tributeTitle);
    secTribute.appendChild(tributeInfo);
    secTribute.style.display = 'none';

    const secSuggest = el('div', PREFIX + 'sec');
    const suggestTitle = el('div', PREFIX + 'sec-title', '💡 出牌建议');
    const suggestEl = el('div', PREFIX + 'suggest');
    secSuggest.appendChild(suggestTitle);
    secSuggest.appendChild(suggestEl);

    const actionsEl = el('div', PREFIX + 'actions');
    const statusEl = el('div', PREFIX + 'status', '');
    const toastEl = el('div', PREFIX + 'toast', '');

    bodyEl.appendChild(noticeEl);
    bodyEl.appendChild(secCounter);
    bodyEl.appendChild(secXray);
    bodyEl.appendChild(secMy);
    bodyEl.appendChild(secTable);
    bodyEl.appendChild(secTribute);
    bodyEl.appendChild(secSuggest);
    bodyEl.appendChild(actionsEl);
    bodyEl.appendChild(statusEl);
    root.appendChild(head);
    root.appendChild(bodyEl);
    root.appendChild(toastEl);
    if (host && typeof host.appendChild === 'function') host.appendChild(root);

    /* ---------- 自动托管 ---------- */

    function toggleAuto() {
      const next = !effectiveAuto();
      settings.auto = next;
      autoPending = next;
      refreshAutoBtn();
      if (typeof opts.onToggleAuto === 'function') callCb('onToggleAuto', next);
      else if (typeof opts.onAutoToggle === 'function') callCb('onAutoToggle', next);
      else if (typeof opts.onSaveSettings === 'function') {
        callCb('onSaveSettings', buildSettingsPayload({ auto: next }));
      }
      toast(next ? '自动托管已开启' : '自动托管已关闭');
    }

    function effectiveAuto() {
      if (autoPending !== null) return !!autoPending;
      if (lastSnapshot && lastSnapshot.auto !== undefined) return !!lastSnapshot.auto;
      return !!settings.auto;
    }

    function refreshAutoBtn() {
      const on_ = effectiveAuto();
      autoBtn.className = PREFIX + 'icon-btn' + (on_ ? ' ' + PREFIX + 'on' : '');
      autoBtn.title = on_ ? '自动托管：已开启（点击关闭）' : '自动托管：已关闭（点击开启）';
    }

    /* ---------- 透视（对手手牌，仅本机可见） ---------- */

    function toggleXray() {
      const next = !effectiveXray();
      settings.xray = next;
      xrayPending = next;
      renderXray(lastSnapshot || normalizeSnapshot(null));
      if (typeof opts.onToggleXray === 'function') callCb('onToggleXray', next);
      else if (typeof opts.onSaveSettings === 'function') {
        callCb('onSaveSettings', buildSettingsPayload({ xray: next }));
      }
      toast(next ? '透视已开启（仅本机可见）' : '透视已关闭');
    }

    function effectiveXray() {
      if (xrayPending !== null) return !!xrayPending;
      if (lastSnapshot && lastSnapshot.xray && lastSnapshot.xray.enabled !== undefined) {
        return !!lastSnapshot.xray.enabled;
      }
      return !!settings.xray;
    }

    function xrayChip(c) {
      let cls = PREFIX + 'xray-chip';
      if (c.red) cls += ' ' + PREFIX + 'xray-red';
      if (c.isLevel) cls += ' ' + PREFIX + 'xray-level';
      if (c.isWild) cls += ' ' + PREFIX + 'xray-wild';
      if (c.isJoker) cls += ' ' + PREFIX + 'xray-joker';
      const chip = el('span', cls, c.text || '?');
      if (c.isWild) chip.title = '逢人配（红桃级牌）';
      else if (c.isLevel) chip.title = '级牌';
      else if (c.isJoker) chip.title = '王';
      return chip;
    }

    function xraySeatBlock(seat) {
      const block = el('div', PREFIX + 'xray-seat' + (seat.isPartner ? ' ' + PREFIX + 'xray-partner' : ''));
      const head2 = el('div', PREFIX + 'xray-seat-head');
      head2.appendChild(el('span', PREFIX + 'xray-seat-name', (seat.name || '?') + ' · ' + seat.seat + '号位'));
      if (seat.isPartner) head2.appendChild(el('span', PREFIX + 'xray-tag', '队友'));
      head2.appendChild(el('span', PREFIX + 'xray-seat-count', seat.count + ' 张'));
      for (let i = 0; i < seat.bombs.length; i++) {
        head2.appendChild(el('span', PREFIX + 'xray-bomb', '💣 ' + (seat.bombs[i].label || '炸弹')));
      }
      block.appendChild(head2);
      if (seat.unavailable) {
        block.appendChild(el('div', PREFIX + 'xray-empty', '该家手牌未就绪（可能尚未发牌）'));
        return block;
      }
      if (!seat.cards.length) {
        block.appendChild(el('div', PREFIX + 'xray-empty', '已出完 / 无手牌'));
        return block;
      }
      const cardsEl = el('div', PREFIX + 'xray-cards');
      for (let j = 0; j < seat.cards.length; j++) cardsEl.appendChild(xrayChip(seat.cards[j]));
      block.appendChild(cardsEl);
      return block;
    }

    function renderXray(snap) {
      const x = (snap && snap.xray) || normXray(null);
      const on_ = effectiveXray();
      xrayToggle.textContent = on_ ? '透视：开' : '透视：关';
      xrayToggle.className = PREFIX + 'xray-toggle' + (on_ ? ' ' + PREFIX + 'on' : '');
      xrayToggle.title = on_ ? '透视：已开启（点击关闭，仅本机可见）' : '透视：已关闭（点击开启）';
      xrayList.textContent = '';
      xraySum.textContent = '';
      if (!on_) {
        xrayNote.textContent = '透视已关闭。开启后可查看其他三家手牌与炸弹预警（仅本机可见）。';
        return;
      }
      xrayNote.textContent = '⚠ 透视会破坏游戏公平性：仅本机可见，请只与朋友娱乐使用，切勿用于比赛或赌博。';
      if (!x.seats.length) {
        xrayList.appendChild(el('div', PREFIX + 'xray-empty', x.note || '等待发牌 / 牌局数据…'));
        return;
      }
      for (let i = 0; i < x.seats.length; i++) xrayList.appendChild(xraySeatBlock(x.seats[i]));
      const parts = ['可见 ' + (x.totalCards || 0) + ' 张'];
      if (x.bombCount) parts.push('炸弹 ' + x.bombCount + ' 个');
      xraySum.textContent = parts.join(' · ');
    }

    /* ---------- 渲染：记牌器 ---------- */

    function renderCounter(counter) {
      counterGrid.textContent = '';
      const items = orderCounter(counter && counter.byRank);
      if (!items.length) {
        counterGrid.appendChild(el('div', PREFIX + 'empty', '等待对局…'));
      } else {
        for (let i = 0; i < items.length; i++) counterGrid.appendChild(counterCell(items[i]));
      }
      counterSum.textContent = formatCounterSummary(counter) || '等待对局…';
    }

    function counterCell(item) {
      const it = item && typeof item === 'object' ? item : {};
      const rank = num(it.rank, 0);
      const label = str(it.text) || rankLabel(rank);
      const count = (typeof it.remaining === 'number' && !isNaN(it.remaining)) ? it.remaining : num(it.count, 0);
      const cell = el('span', PREFIX + 'cc');
      cell.appendChild(el('i', null, label));
      cell.appendChild(el('b', null, String(count)));
      if (count === 0) cell.classList.add(PREFIX + 'cc-zero');
      if (it.isLevel) {
        cell.classList.add(PREFIX + 'cc-level');
        cell.appendChild(el('em', PREFIX + 'cc-mark', '级'));
      }
      if (it.isWild) {
        cell.classList.add(PREFIX + 'cc-wild');
        cell.appendChild(el('em', PREFIX + 'cc-mark ' + PREFIX + 'cc-mark-wild', '配'));
      }
      cell.title = label + '：剩余 ' + count + ' 张';
      return cell;
    }

    /* ---------- 渲染：我的手牌信息 ---------- */

    function renderHandInfo(info) {
      const txt = formatHandInfo(info);
      myInfo.textContent = txt || '尚未检测到手牌';
    }

    /* ---------- 渲染：牌桌 ---------- */

    function renderTable(snap) {
      seatsEl.textContent = '';
      const seats = snap.seats || [];
      if (!seats.length) {
        seatsEl.appendChild(el('div', PREFIX + 'empty', '等待座位信息…'));
      } else {
        for (let i = 0; i < seats.length; i++) seatsEl.appendChild(seatRow(seats[i], i));
      }
      const lp = snap.lastPlay;
      if (lp) {
        const name = lp.name || (lp.cardsText ? '' : '');
        const cards = lp.cardsText || '';
        lastPlayEl.textContent = '上一手：' + (lp.seatName || '?') + (name ? ' · ' + name : '') + (cards ? ' ' + cards : '');
      } else {
        lastPlayEl.textContent = '上一手：—（当前领出）';
      }
      if (snap.history && snap.history.length) {
        const recent = snap.history.slice(-3).map(function (h) {
          const x = h && typeof h === 'object' ? h : {};
          return str(x.seatName) + ' ' + str(x.text);
        });
        histEl.textContent = '最近：' + recent.join(' · ');
      } else {
        histEl.textContent = '';
      }
    }

    function seatRow(seat, index) {
      const s = seat || {};
      const row = el('div', PREFIX + 'seat-row');
      if (s.isMe) row.classList.add(PREFIX + 'seat-me');
      if (s.isPartner) row.classList.add(PREFIX + 'seat-partner');
      const name = str(s.name) || SEAT_FALLBACK[index] || '';
      row.appendChild(el('span', PREFIX + 'seat-name', name));
      if (s.isMe) row.appendChild(el('span', PREFIX + 'seat-tag', '我'));
      if (s.isPartner && !s.isMe) row.appendChild(el('span', PREFIX + 'seat-tag', '队友'));
      if (s.tribute) row.appendChild(el('span', PREFIX + 'seat-tag ' + PREFIX + 'seat-tag-tribute', '进贡'));
      if (s.rankBadge != null) row.appendChild(el('span', PREFIX + 'seat-tag ' + PREFIX + 'seat-tag-rank', '#' + s.rankBadge));
      row.appendChild(el('span', PREFIX + 'seat-count', num(s.count, 0) + ' 张'));
      return row;
    }

    /* ---------- 渲染：进贡 / 还贡 ---------- */

    function renderTribute(tribute) {
      if (!tribute) {
        secTribute.style.display = 'none';
        tributeInfo.textContent = '';
        return;
      }
      secTribute.style.display = '';
      tributeInfo.textContent = '';
      const modeText = tribute.mode === 'return' ? '还贡' : '进贡';
      const from = tribute.fromName || '?';
      const to = tribute.toName || '?';
      tributeInfo.appendChild(el('div', null, '当前：' + modeText + ' ' + from + ' → ' + to));
      if (tribute.candidatesText) {
        tributeInfo.appendChild(el('div', PREFIX + 'tribute-row', '候选：' + tribute.candidatesText));
      }
      if (tribute.suggestText) {
        tributeInfo.appendChild(el('div', PREFIX + 'tribute-row', '建议：' + tribute.suggestText));
      }
    }

    /* ---------- 渲染：建议区 ---------- */

    function renderSuggestion(sug) {
      lastSuggestion = sug;
      suggestEl.textContent = '';
      if (!sug) {
        suggestEl.appendChild(el('div', PREFIX + 'empty', '点击下方按钮生成出牌建议'));
        return;
      }
      const headRow = el('div', PREFIX + 'suggest-head');
      headRow.appendChild(el('span', PREFIX + 'source ' + PREFIX + 'source-' + sug.source, sug.source === 'deepseek' ? 'DeepSeek' : '本地'));
      if (sug.action === 'pass') {
        headRow.appendChild(el('span', PREFIX + 'suggest-name', '不出（过牌）'));
      } else {
        headRow.appendChild(el('span', PREFIX + 'suggest-name', sug.name ? '建议：' + sug.name : '建议出牌'));
      }
      suggestEl.appendChild(headRow);
      if (sug.action === 'play' && (sug.cardsText || sug.desc)) {
        suggestEl.appendChild(el('div', PREFIX + 'suggest-cards', sug.cardsText || sug.desc));
      }
      if (sug.reason) suggestEl.appendChild(el('div', PREFIX + 'suggest-reason', sug.reason));
      if (sug.error) suggestEl.appendChild(el('div', PREFIX + 'suggest-reason ' + PREFIX + 'suggest-error', '⚠ ' + sug.error));
      if (sug.candidatesText && sug.candidatesText.length) {
        const toggle = btn((candOpen ? '▾ ' : '▸ ') + '候选出牌（' + sug.candidatesText.length + '）', PREFIX + 'cand-toggle', function () {
          candOpen = !candOpen;
          renderSuggestion(lastSuggestion);
        });
        suggestEl.appendChild(toggle);
        if (candOpen) {
          const ol = el('ol', PREFIX + 'cand-list');
          sug.candidatesText.forEach(function (t) { ol.appendChild(el('li', null, t)); });
          suggestEl.appendChild(ol);
        }
      }
    }

    /* ---------- 渲染：操作按钮 ---------- */

    function renderActions(snap) {
      actionsEl.textContent = '';
      const phase = snap.phase;
      const busy = !!snap.busy;
      if (!snap.isGuandan) {
        actionsEl.style.display = 'none';
        return;
      }
      actionsEl.style.display = '';
      const add = function (b) { actionsEl.appendChild(b); };

      if (phase === 'tribute') {
        const primary = btn('📤 采纳进贡', PREFIX + 'btn-primary', function () { callCb('onTribute'); });
        primary.disabled = busy;
        add(primary);
        const confirm = btn('确认进贡', PREFIX + 'btn-ghost', function () { callCb('onTribute'); });
        confirm.disabled = busy;
        add(confirm);
      } else if (phase === 'return') {
        const primary = btn('📤 采纳还贡', PREFIX + 'btn-primary', function () { callCb('onReturn'); });
        primary.disabled = busy;
        add(primary);
        const confirm = btn('确认还贡', PREFIX + 'btn-ghost', function () { callCb('onReturn'); });
        confirm.disabled = busy;
        add(confirm);
      } else if (phase === 'finish') {
        if (typeof opts.onNextRound === 'function') {
          const next = btn('🔄 下一局', PREFIX + 'btn-primary', function () { callCb('onNextRound'); });
          add(next);
        }
        const local = btn('💡 本地建议', PREFIX + 'btn-ghost', function () { callCb('onLocalSuggest'); });
        local.disabled = busy;
        add(local);
      } else {
        const local = btn('💡 本地建议', PREFIX + 'btn-ghost', function () { callCb('onLocalSuggest'); });
        local.disabled = busy;
        add(local);
        const ds = btn('🌐 DeepSeek 建议', PREFIX + 'btn-deepseek', function () { callCb('onDeepSeekSuggest'); });
        ds.disabled = busy;
        add(ds);
        const adopt = btn('⚡ 采用并出牌', PREFIX + 'btn-primary', function () { callCb('onAdopt', lastSnapshot); });
        adopt.disabled = busy || !(snap.suggestion && snap.suggestion.action === 'play');
        add(adopt);
        const pass = btn('🃏 不出', PREFIX + 'btn-ghost', function () { callCb('onPass'); });
        pass.disabled = busy;
        add(pass);
        if (typeof opts.onUndo === 'function') {
          const undo = btn('↩️ 撤销', PREFIX + 'btn-warn', function () { callCb('onUndo'); });
          undo.disabled = busy;
          add(undo);
        }
      }
    }

    /* ---------- 渲染：状态行 / 徽标 ---------- */

    function renderStatus(snap) {
      let txt;
      if (!snap.isGuandan) txt = '当前页面不是掼蛋玩法';
      else if (snap.busy) txt = '⏳ 正在处理…';
      else if (snap.phase === 'finish') txt = '🏁 本局结束';
      else if (snap.turn) txt = '✅ 轮到我出牌';
      else txt = '⏳ 等待其他玩家';
      const ph = phaseText(snap.phase);
      if (ph && snap.isGuandan && !snap.busy) txt += ' · ' + ph;
      statusEl.textContent = txt;
      statusEl.className = PREFIX + 'status' + (snap.turn ? ' ' + PREFIX + 'status-turn' : '');
    }

    function renderBadge(snap) {
      const parts = [];
      if (snap.levelText) parts.push('级牌 ' + snap.levelText);
      else if (snap.level) parts.push('级牌 ' + rankLabel(snap.level));
      if (snap.wildText) parts.push('逢人配 ' + snap.wildText);
      badgeEl.textContent = parts.join(' · ');
      badgeEl.title = badgeEl.textContent;
    }

    /* ---------- 主渲染 ---------- */

    function render(snapRaw) {
      const snap = normalizeSnapshot(snapRaw);
      lastSnapshot = snap;
      // body 明确给出了 auto/xray 字段时，以 body 为准确认开关状态
      if (snapRaw && typeof snapRaw === 'object' && snapRaw.auto !== undefined) autoPending = null;
      if (snapRaw && typeof snapRaw === 'object' && snapRaw.xray !== undefined) xrayPending = null;
      root.style.display = snap.visible ? '' : 'none';
      renderBadge(snap);
      refreshAutoBtn();
      const guandan = snap.isGuandan;
      const hideSections = !guandan;
      secCounter.style.display = hideSections ? 'none' : '';
      secXray.style.display = hideSections ? 'none' : '';
      secMy.style.display = hideSections ? 'none' : '';
      secTable.style.display = hideSections ? 'none' : '';
      secSuggest.style.display = hideSections ? 'none' : '';
      statusEl.style.display = hideSections ? 'none' : '';
      if (!guandan) {
        noticeEl.textContent = '⚠ 当前不是掼蛋玩法（本面板仅支持掼蛋房间）';
        noticeEl.style.display = '';
      } else {
        noticeEl.style.display = 'none';
        noticeEl.textContent = '';
        renderCounter(snap.counter);
        renderXray(snap);
        renderHandInfo(snap.handInfo);
        renderTable(snap);
        renderTribute(snap.tribute);
        renderSuggestion(snap.suggestion);
        renderStatus(snap);
      }
      renderActions(snap);
    }

    function update(snapshot) {
      if (destroyed) return;
      try {
        render(snapshot);
      } catch (e) {
        // 渲染异常绝不让页面白屏/抛到站点
        try {
          noticeEl.textContent = '⚠ 面板渲染异常：' + errText(e);
          noticeEl.style.display = '';
        } catch (_) { /* ignore */ }
      }
    }

    /* ---------- 设置 ---------- */

    function keyPlaceholder() {
      if (!settings.hasKey) return 'sk-...';
      if (settings.keyMask) return '已保存 ' + maskKey(settings.keyMask) + '（不回显；输入新 Key 可替换）';
      return '已保存（不回显；输入新 Key 可替换）';
    }

    function buildSettingsPayload(over) {
      const out = {
        hasKey: !!settings.hasKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        temperature: settings.temperature,
        timeoutMs: settings.timeoutMs,
        auto: !!settings.auto,
        xray: !!settings.xray,
      };
      const o = over && typeof over === 'object' ? over : {};
      for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
      return out;
    }

    function readSettingsForm() {
      if (!settingsUi) return buildSettingsPayload();
      return buildSettingsPayload({
        apiKey: settingsUi.keyInput.value == null ? '' : String(settingsUi.keyInput.value),
        baseUrl: String(settingsUi.baseInput.value || ''),
        model: String(settingsUi.modelInput.value || ''),
        temperature: num(settingsUi.tempInput.value, DEFAULT_SETTINGS.temperature),
        timeoutMs: num(settingsUi.timeoutInput.value, DEFAULT_SETTINGS.timeoutMs),
      });
    }

    function setSettings(next) {
      if (destroyed) return;
      settings = mergeSettings(settings, next);
      if (settingsUi) {
        settingsUi.keyInput.value = '';
        settingsUi.keyInput.placeholder = keyPlaceholder();
        settingsUi.baseInput.value = settings.baseUrl;
        settingsUi.modelInput.value = settings.model;
        settingsUi.tempInput.value = String(settings.temperature);
        settingsUi.timeoutInput.value = String(settings.timeoutMs);
        settingsUi.hasKeyHint.textContent = settings.hasKey
          ? '已保存 API Key（仅本机 localStorage，不回显）'
          : '未保存 API Key：DeepSeek 建议会回退到本地建议';
      }
      refreshAutoBtn();
      if (lastSnapshot) renderActions(lastSnapshot);
    }

    function openSettings() {
      if (destroyed) return;
      if (settingsUi) { settingsUi.overlay.style.display = 'flex'; return; }
      const overlay = el('div', PREFIX + 'overlay');
      overlay.id = 'hqgd-settings-overlay';
      const modal = el('div', PREFIX + 'modal');
      const mHead = el('div', PREFIX + 'modal-head');
      mHead.appendChild(el('span', null, '⚙ 设置'));
      const closeBtn = btn('×', PREFIX + 'modal-close', function () { overlay.style.display = 'none'; });
      mHead.appendChild(closeBtn);
      const mBody = el('div', PREFIX + 'modal-body');

      // API Key
      const fKey = el('div', PREFIX + 'field');
      fKey.appendChild(el('label', null, 'API Key（仅保存在本机 localStorage，不回显）'));
      const keyInput = doc.createElement('input');
      keyInput.type = 'password';
      keyInput.value = '';
      keyInput.placeholder = keyPlaceholder();
      keyInput.setAttribute('data-field', 'apiKey');
      keyInput.setAttribute('autocomplete', 'off');
      fKey.appendChild(keyInput);
      const keyHint = el('div', PREFIX + 'field-hint', '');
      fKey.appendChild(keyHint);
      mBody.appendChild(fKey);

      // Base URL
      const fBase = el('div', PREFIX + 'field');
      fBase.appendChild(el('label', null, 'Base URL'));
      const baseInput = doc.createElement('input');
      baseInput.type = 'text';
      baseInput.value = settings.baseUrl;
      baseInput.placeholder = DEFAULT_SETTINGS.baseUrl;
      baseInput.setAttribute('data-field', 'baseUrl');
      fBase.appendChild(baseInput);
      fBase.appendChild(el('div', PREFIX + 'field-hint', '默认 https://api.deepseek.com（OpenAI 兼容 /chat/completions）'));
      mBody.appendChild(fBase);

      // 模型
      const fModel = el('div', PREFIX + 'field');
      fModel.appendChild(el('label', null, '模型'));
      const modelInput = doc.createElement('input');
      modelInput.type = 'text';
      modelInput.value = settings.model;
      modelInput.placeholder = 'deepseek-chat';
      modelInput.setAttribute('data-field', 'model');
      modelInput.setAttribute('list', 'hqgd-model-list');
      fModel.appendChild(modelInput);
      const datalist = doc.createElement('datalist');
      datalist.id = 'hqgd-model-list';
      MODEL_OPTIONS.forEach(function (m) {
        const o = doc.createElement('option');
        o.value = m;
        datalist.appendChild(o);
      });
      fModel.appendChild(datalist);
      fModel.appendChild(el('div', PREFIX + 'field-hint', 'deepseek-chat（快）或 deepseek-reasoner（推理更强、更慢）'));
      mBody.appendChild(fModel);

      // 温度 / 超时
      const fRow = el('div', PREFIX + 'field-row');
      const fTemp = el('div', PREFIX + 'field');
      fTemp.appendChild(el('label', null, '温度'));
      const tempInput = doc.createElement('input');
      tempInput.type = 'number';
      tempInput.step = '0.1';
      tempInput.min = '0';
      tempInput.max = '2';
      tempInput.value = String(settings.temperature);
      tempInput.setAttribute('data-field', 'temperature');
      fTemp.appendChild(tempInput);
      const fTimeout = el('div', PREFIX + 'field');
      fTimeout.appendChild(el('label', null, '超时（毫秒）'));
      const timeoutInput = doc.createElement('input');
      timeoutInput.type = 'number';
      timeoutInput.step = '1000';
      timeoutInput.min = '3000';
      timeoutInput.value = String(settings.timeoutMs);
      timeoutInput.setAttribute('data-field', 'timeoutMs');
      fTimeout.appendChild(timeoutInput);
      fRow.appendChild(fTemp);
      fRow.appendChild(fTimeout);
      mBody.appendChild(fRow);

      const statusLine = el('div', PREFIX + 'modal-status', '');

      const mFoot = el('div', PREFIX + 'modal-foot');
      const saveBtn = btn('保存', PREFIX + 'btn-primary', function () { saveSettingsFromForm(); });
      const testBtn = btn('测试连接', PREFIX + 'btn-ghost', function () { testConnectionFromForm(); });
      const clearBtn = btn('清除 Key', PREFIX + 'btn-warn', function () { clearKey(); });
      const closeFoot = btn('关闭', PREFIX + 'btn-ghost', function () { overlay.style.display = 'none'; });
      mFoot.appendChild(saveBtn);
      mFoot.appendChild(testBtn);
      mFoot.appendChild(clearBtn);
      mFoot.appendChild(closeFoot);

      modal.appendChild(mHead);
      modal.appendChild(mBody);
      modal.appendChild(statusLine);
      modal.appendChild(mFoot);
      overlay.appendChild(modal);
      const hostDoc = doc.body || doc.documentElement;
      if (hostDoc && typeof hostDoc.appendChild === 'function') hostDoc.appendChild(overlay);
      on(overlay, 'click', function (ev) {
        if (ev && ev.target === overlay) overlay.style.display = 'none';
      });

      settingsUi = {
        overlay: overlay,
        keyInput: keyInput,
        baseInput: baseInput,
        modelInput: modelInput,
        tempInput: tempInput,
        timeoutInput: timeoutInput,
        statusLine: statusLine,
        hasKeyHint: keyHint,
        saveBtn: saveBtn,
        testBtn: testBtn,
      };

      function setStatus(cls, text) {
        statusLine.className = PREFIX + 'modal-status' + (cls ? ' ' + PREFIX + 'status-' + cls : '');
        statusLine.textContent = text || '';
      }

      function saveSettingsFromForm() {
        const form = readSettingsForm();
        if (form.baseUrl && !/^https?:\/\/\S+$/i.test(form.baseUrl)) {
          setStatus('error', 'Base URL 格式不正确（需以 http:// 或 https:// 开头）');
          return;
        }
        if (form.apiKey) {
          settings.hasKey = true;
          settings.keyMask = ''; // 新 Key 只保存不明文，旧的掩码也一并作废
        }
        settings.baseUrl = form.baseUrl || DEFAULT_SETTINGS.baseUrl;
        settings.model = form.model || DEFAULT_SETTINGS.model;
        settings.temperature = form.temperature;
        settings.timeoutMs = form.timeoutMs;
        keyInput.value = '';
        keyInput.placeholder = keyPlaceholder();
        keyHint.textContent = settings.hasKey
          ? '已保存 API Key（仅本机 localStorage，不回显）'
          : '未保存 API Key：DeepSeek 建议会回退到本地建议';
        callCb('onSaveSettings', form);
        setStatus('success', '✅ 设置已保存' + (form.apiKey ? '（API Key 已更新）' : ''));
        toast('设置已保存');
      }

      function testConnectionFromForm() {
        if (typeof opts.onTestConnection !== 'function') {
          setStatus('error', '当前版本未提供测试连接回调');
          return;
        }
        const form = readSettingsForm();
        if (!form.apiKey && !settings.hasKey) {
          setStatus('error', '请先填写 API Key 再测试连接');
          return;
        }
        setStatus('pending', '正在测试连接…');
        testBtn.disabled = true;
        Promise.resolve()
          .then(function () { return opts.onTestConnection(form); })
          .then(function (res) {
            testBtn.disabled = false;
            if (res && res.ok) {
              setStatus('success', '✅ ' + (res.message || ('连接成功' + (res.model ? '（模型：' + res.model + '）' : ''))));
            } else {
              setStatus('error', '❌ ' + (res && res.message ? res.message : '连接失败（未知原因）'));
            }
          }, function (e) {
            testBtn.disabled = false;
            setStatus('error', '❌ 测试失败：' + errText(e));
          });
      }

      function clearKey() {
        settings.hasKey = false;
        settings.keyMask = '';
        keyInput.value = '';
        keyInput.placeholder = keyPlaceholder();
        keyHint.textContent = '已清除本机保存的 API Key';
        setStatus('success', '✅ 已清除 API Key（仅本机 localStorage）');
        callCb('onSaveSettings', buildSettingsPayload({ apiKey: '', hasKey: false, clearKey: true }));
        toast('已清除 API Key');
      }

      // 打开时同步一次
      setSettings({});
    }

    function openHelp() {
      if (destroyed) return;
      if (helpUi) { helpUi.overlay.style.display = 'flex'; return; }
      const overlay = el('div', PREFIX + 'overlay');
      overlay.id = 'hqgd-help-overlay';
      const modal = el('div', PREFIX + 'modal');
      const mHead = el('div', PREFIX + 'modal-head');
      mHead.appendChild(el('span', null, '❓ 掼蛋 AI 助手 · 帮助'));
      const closeBtn = btn('×', PREFIX + 'modal-close', function () { overlay.style.display = 'none'; });
      mHead.appendChild(closeBtn);
      const mBody = el('div', PREFIX + 'modal-body');

      const sections = [
        ['功能', [
          '📋 记牌器：统计除我之外三家的剩余牌（未知/已出/逢人配）。',
          '👁 透视：可开关查看其他三家手牌与炸弹预警（默认关闭，仅本机可见）。',
          '💡 本地建议：纯前端启发式，不联网也能用。',
          '🌐 DeepSeek 建议：调用 DeepSeek 官方 API，失败自动回退本地建议。',
          '⚡ 采用并出牌 / 🃏 不出：由脚本自动点击站点牌面与按钮。',
        ]],
        ['使用步骤', [
          '1. 进入掼蛋房间并开局，面板会自动识别我的手牌与牌桌。',
          '2. 轮到我时点「本地建议」或「DeepSeek 建议」。',
          '3. 满意后点「采用并出牌」；不想出就点「不出」。',
          '4. 需要托管可打开右上角 🤖 自动托管开关。',
        ]],
        ['进贡 / 还贡', [
          '进贡阶段：站点会自动预选建议贡牌，点「采纳进贡」或「确认进贡」即可。',
          '还贡阶段：需在站点允许的候选牌中选中 1 张，再点「确认还贡」。',
        ]],
        ['👁 透视（默认关闭）', [
          '面板「👁 透视 · 对手手牌」右侧的「透视：关」按钮即开关；设置保存在本机 localStorage，下次自动沿用。',
          '开启后显示其他三家手牌、剩余张数，以及炸弹预警（4 张及以上、同花顺、四大天王）。',
          '数据来自本局页面状态的只读解码，不修改网络请求，也不影响正常出牌。',
          '透视会破坏游戏公平性：内容仅本机显示，建议只与朋友娱乐时使用，切勿用于比赛或赌博。',
        ]],
        ['规则口径', [
          '级牌点数排 A 之上；红桃级牌为「逢人配」，可当任意牌（王除外）。',
          '炸弹链：4 张 < 5 张 < 同花顺 < 6 张 < 7 张 < 8 张 < 四大天王。',
          '连续三家过牌即清墩，由最后出牌者（或其对家）重新领出。',
        ]],
        ['隐私说明', [
          'API Key 只保存在本机浏览器 localStorage，面板与代码不打印完整 Key。',
          '只有在你主动点「DeepSeek 建议」时，才把当前牌局信息发送到 DeepSeek 官方 API。',
          '不会向任何其他第三方发送数据。',
        ]],
        ['快捷键', [
          '站点无全局快捷键；所有操作都可直接点击面板按钮完成。',
          '拖拽标题栏（🃏 掼蛋 AI 助手）可移动面板，点「—」可收起。',
        ]],
      ];
      sections.forEach(function (sec) {
        mBody.appendChild(el('div', PREFIX + 'help-sec', sec[0]));
        const ul = el('ul', PREFIX + 'help-list');
        sec[1].forEach(function (t) { ul.appendChild(el('li', null, t)); });
        mBody.appendChild(ul);
      });
      mBody.appendChild(el('div', PREFIX + 'help-note', '本脚本仅为娱乐辅助，请遵守站点规则并注意账号安全。'));

      const mFoot = el('div', PREFIX + 'modal-foot');
      mFoot.appendChild(btn('知道了', PREFIX + 'btn-primary', function () { overlay.style.display = 'none'; }));
      modal.appendChild(mHead);
      modal.appendChild(mBody);
      modal.appendChild(mFoot);
      overlay.appendChild(modal);
      const hostDoc = doc.body || doc.documentElement;
      if (hostDoc && typeof hostDoc.appendChild === 'function') hostDoc.appendChild(overlay);
      on(overlay, 'click', function (ev) {
        if (ev && ev.target === overlay) overlay.style.display = 'none';
      });
      helpUi = { overlay: overlay };
    }

    /* ---------- 销毁 ---------- */

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      try {
        if (root.parentNode) root.parentNode.removeChild(root);
      } catch (_) { /* ignore */ }
      [settingsUi, helpUi].forEach(function (ui) {
        if (!ui || !ui.overlay) return;
        try {
          if (ui.overlay.parentNode) ui.overlay.parentNode.removeChild(ui.overlay);
        } catch (_) { /* ignore */ }
      });
      settingsUi = null;
      helpUi = null;
      try { releaseStyle(doc); } catch (_) { /* ignore */ }
    }

    /* ---------- 对外句柄 ---------- */

    const handle = {
      root: root,
      handle: head,
      update: update,
      setSettings: setSettings,
      toast: toast,
      openSettings: openSettings,
      openHelp: openHelp,
      destroy: destroy,
      /** 只读：当前设置快照（不含明文 Key） */
      getSettings: function () {
        return buildSettingsPayload({ keyMask: settings.keyMask || '' });
      },
      isDestroyed: function () { return destroyed; },
    };

    render({ visible: true, isGuandan: true });
    return handle;
  }

  /* ============================================================ */

  return {
    VERSION: VERSION,
    create: create,
    _internals: {
      VERSION: VERSION,
      PREFIX: PREFIX,
      COUNTER_ORDER: COUNTER_ORDER.slice(),
      DEFAULT_SETTINGS: (function () { const o = {}; for (const k in DEFAULT_SETTINGS) o[k] = DEFAULT_SETTINGS[k]; return o; })(),
      MODEL_OPTIONS: MODEL_OPTIONS.slice(),
      rankLabel: rankLabel,
      maskKey: maskKey,
      orderCounter: orderCounter,
      formatCounterSummary: formatCounterSummary,
      formatHandInfo: formatHandInfo,
      phaseText: phaseText,
      normalizeSnapshot: normalizeSnapshot,
      normXray: normXray,
      normXraySeat: normXraySeat,
      normXrayCard: normXrayCard,
      normXrayBomb: normXrayBomb,
      errText: errText,
    },
  };
});

/* ============================================================
 * 掼蛋 AI 助手（game.hullqin.cn 油猴版）· body 桥接
 * ------------------------------------------------------------
 * 职责（SPEC2 §6）：
 *   1. 从 React fiber 读 game.data（protobuf）→ GDSite.decodeGameData → GDSite.expandState
 *   2. 每 tick 生成 snapshot 交给 GDSiteUI 渲染
 *   3. 处理「本地建议 / DeepSeek 建议 / 采用并出牌 / 不出 / 进贡 / 还贡 / 下一局 / 设置 / 透视开关」
 *   4. 模拟真实点击：手牌选中 + 站点按钮；建议高亮；自动托管
 *   5. 透视：把 GDSiteESP.buildXray 的结果塞进 snapshot（默认关闭，仅本机可见）
 *   6. window.__gdAI 调试接口
 *
 * 依赖（打包顺序在前）：HQ / GDSite / GDSiteAI / GDDeepSeek / GDSiteRemote / GDSiteESP / GDSiteUI
 * 不读网络、不写日志（API Key 只在 localStorage，绝不打印）。
 * ============================================================ */
(function () {
  'use strict';

  const G = (typeof GDSite !== 'undefined' && GDSite) || self.GDSite;
  const AI = (typeof GDSiteAI !== 'undefined' && GDSiteAI) || self.GDSiteAI;
  const Remote = (typeof GDSiteRemote !== 'undefined' && GDSiteRemote) || self.GDSiteRemote;
  const ESP = (typeof GDSiteESP !== 'undefined' && GDSiteESP) || self.GDSiteESP;
  const UI = (typeof GDSiteUI !== 'undefined' && GDSiteUI) || self.GDSiteUI;
  const DS = (typeof GDDeepSeek !== 'undefined' && GDDeepSeek) || self.GDDeepSeek;
  const HQ = self.HQ;

  const VERSION = '1.1.0';
  const SETTINGS_KEY = 'gdSiteAI.settings';
  const DEFAULTS_SETTINGS = (function () {
    const d = (Remote && Remote.DEFAULTS) || (DS && DS.DEFAULTS) || {};
    return {
      apiKey: '',
      baseUrl: d.baseUrl || 'https://api.deepseek.com',
      model: d.model || 'deepseek-chat',
      temperature: typeof d.temperature === 'number' ? d.temperature : 0.2,
      timeoutMs: typeof d.timeoutMs === 'number' ? d.timeoutMs : 30000,
      auto: false,
      xray: false,
    };
  })();

  /* ════════════════════════════════════════════════════════════════
   * ★★★ 在这里填入你的 DeepSeek API Key ★★★
   * ------------------------------------------------------------
   * 把下面单引号 '' 之间的内容换成你的 Key（到 platform.deepseek.com 的
   * 「API Keys」页复制，形如 sk- 开头的一串），例如：
   *     const HARDCODED_API_KEY = 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
   *
   * 填了之后：脚本默认用它（「自动托管」和「DeepSeek 建议」都会用），
   * 不用再到面板 ⚙ 里填；留空 '' 则只用面板设置里保存的 Key（只存本机，更安全）。
   * 若两者都有：面板里填的 Key 优先，方便你在界面上直接纠正/更换 Key。
   *
   * ⚠️ 注意：硬编码的 Key 会明文写进脚本源码，谁拿到脚本谁就能看到并花你的钱。
   *    请只在你自己的电脑上用，不要把这个脚本发给别人、不要上传。
   * ════════════════════════════════════════════════════════════════ */
  const HARDCODED_API_KEY = '';   // ← 把 Key 贴在这里，例如 'sk-xxxxxxxx...'

  /** 取实际生效的 API Key：面板设置里填的优先，其次硬编码 */
  function effectiveApiKey(settings) {
    const s = settings || {};
    const fromSettings = (typeof s.apiKey === 'string') ? s.apiKey.replace(/\s/g, '') : '';
    if (fromSettings) return fromSettings;
    return String(HARDCODED_API_KEY || '').replace(/\s/g, '');
  }

  if (!G || !AI || !Remote || !UI || !HQ) {
    if (typeof console !== 'undefined') {
      console.warn('[掼蛋助手] 模块缺失，脚本未启动',
        { engine: !!G, ai: !!AI, remote: !!Remote, ui: !!UI, HQ: !!HQ });
    }
    return;
  }
  if (self.__gdAIInjected) return;
  self.__gdAIInjected = true;
  if (typeof console !== 'undefined' && console.info) {
    console.info('[掼蛋助手] v' + VERSION + ' 已加载（面板稍后出现在页面右上角；控制台输入 __gdAI 可调试）');
  }

  /* ============================ 状态 ============================ */

  const st = {
    panel: null,       // {root, handle, update, setSettings, toast, openSettings, destroy}
    settings: null,    // localStorage 设置（含 apiKey 明文，绝不外传）
    game: null,        // readGame 结果
    expanded: null,
    mySeat: 0,
    aiState: null,
    snapshot: null,
    result: null,      // 当前展示的建议 {source, action, play, reason, error, candidates, handInfo, key}
    resultKey: '',
    busy: false,
    autoTimer: null,
    autoKey: '',
    dsPending: '',     // 正在进行的「默认 DeepSeek 建议」局面 key
    dsTried: '',       // 已为该局面 key 请求过 DeepSeek（防重复/防失败重试风暴）
    hlEl: null,
    lastTickError: '',
    mounted: false,
    lastTurnSig: '',
  };

  /* ============================ 设置 ============================ */

  function loadSettings() {
    st.settings = HQ.loadSettings(SETTINGS_KEY, DEFAULTS_SETTINGS);
    if (!st.settings || typeof st.settings !== 'object') st.settings = { ...DEFAULTS_SETTINGS };
    return st.settings;
  }

  function saveSettings(patch) {
    const s = st.settings;
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.clearKey) s.apiKey = '';
    else if (typeof p.apiKey === 'string' && p.apiKey.replace(/\s/g, '')) s.apiKey = p.apiKey.replace(/\s/g, '');
    if (typeof p.baseUrl === 'string' && p.baseUrl.trim()) s.baseUrl = p.baseUrl.trim();
    if (typeof p.model === 'string' && p.model.trim()) s.model = p.model.trim();
    if (p.temperature !== undefined && p.temperature !== null && p.temperature !== '') {
      const t = Number(p.temperature);
      if (isFinite(t)) s.temperature = Math.max(0, Math.min(2, t));
    }
    if (p.timeoutMs !== undefined && p.timeoutMs !== null && p.timeoutMs !== '') {
      const t = Number(p.timeoutMs);
      if (isFinite(t)) s.timeoutMs = Math.max(3000, Math.min(120000, Math.round(t)));
    }
    if (p.auto !== undefined) s.auto = !!p.auto;
    if (p.xray !== undefined) s.xray = !!p.xray;
    HQ.saveSettings(SETTINGS_KEY, s);
    if (st.panel) st.panel.setSettings(uiSettings());
  }

  function maskKey(key) {
    const k = String(key || '');
    if (!k) return '';
    if (k.length <= 8) return '****';
    return k.slice(0, 4) + '****' + k.slice(-4);
  }

  function uiSettings() {
    const s = st.settings || DEFAULTS_SETTINGS;
    const ek = effectiveApiKey(s);
    return {
      hasKey: !!ek,
      keyMask: maskKey(ek),
      baseUrl: s.baseUrl,
      model: s.model,
      temperature: s.temperature,
      timeoutMs: s.timeoutMs,
      auto: !!s.auto,
      xray: !!s.xray,
    };
  }

  function apiConfig(over) {
    const s = st.settings || DEFAULTS_SETTINGS;
    const o = over && typeof over === 'object' ? over : {};
    const key = typeof o.apiKey === 'string' && o.apiKey.replace(/\s/g, '') ? o.apiKey.replace(/\s/g, '') : effectiveApiKey(s);
    return {
      apiKey: key,
      baseUrl: (typeof o.baseUrl === 'string' && o.baseUrl.trim()) || s.baseUrl,
      model: (typeof o.model === 'string' && o.model.trim()) || s.model,
      temperature: o.temperature !== undefined && o.temperature !== '' && o.temperature !== null && isFinite(Number(o.temperature))
        ? Number(o.temperature) : s.temperature,
      timeoutMs: o.timeoutMs !== undefined && o.timeoutMs !== '' && o.timeoutMs !== null && isFinite(Number(o.timeoutMs))
        ? Number(o.timeoutMs) : s.timeoutMs,
    };
  }

  /* ============================ 读页面状态 ============================ */

  function isGameProps(p) {
    return !!(p && p.room && p.game && typeof p.send === 'function');
  }

  function findGameProps() {
    const cards = document.querySelectorAll('.ddz-poker, .ddz-my-poker');
    for (let i = 0; i < cards.length && i < 12; i++) {
      const p = HQ.findProps(cards[i], isGameProps, 24);
      if (p) return p;
    }
    const zones = document.querySelectorAll('[class*="ddz"], [class*="game"], main, #root, #app');
    for (let i = 0; i < zones.length && i < 40; i++) {
      const p = HQ.findProps(zones[i], isGameProps, 40);
      if (p) return p;
    }
    return null;
  }

  function readGame() {
    let props;
    try {
      props = findGameProps();
    } catch (e) {
      return { guandan: false, reason: 'props-error', error: errText(e) };
    }
    if (!props) return { guandan: false, reason: 'no-props' };

    let raw = null;
    try {
      raw = G.decodeGameData(props.game.data);
    } catch (e) {
      return { guandan: false, reason: 'decode-error', error: errText(e) };
    }
    if (!raw) return { guandan: false, reason: 'empty-data' };
    if (Number(raw.rule) !== 2) return { guandan: false, reason: 'not-guandan', rule: raw.rule };

    let expanded;
    try {
      expanded = G.expandState(raw);
    } catch (e) {
      return { guandan: false, reason: 'expand-error', error: errText(e) };
    }
    const mySeat = Number(props.room && props.room.position) || 0;
    return { guandan: true, raw: raw, expanded: expanded, mySeat: mySeat, props: props };
  }

  function relIndex(seat, mySeat) {
    if (!seat || !mySeat) return 0;
    return (seat - mySeat + 4) % 4;
  }

  const REL_NAMES = ['我', '下家', '对家', '上家'];

  function seatName(seat, mySeat) {
    if (!seat) return '';
    return REL_NAMES[relIndex(seat, mySeat)] || ('玩家' + seat);
  }

  const RANK_BADGE = ['头游', '二游', '三游', '末游'];

  function errText(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    return e.message ? String(e.message) : String(e);
  }

  /* ============================ 生成 snapshot ============================ */

  function decisionKey(game) {
    const e = game.expanded || {};
    const hand = (st.aiState && st.aiState.hand) || [];
    return [
      (e.playedCardList || []).length,
      e.currentPlayer || 0,
      e.trickOwner || 0,
      e.lastInterp || 0,
      e.phase || '',
      (e.rankList || []).join(','),
      hand.join(','),
    ].join('|');
  }

  function suggestionView(result) {
    if (!result) return null;
    const play = result.play || null;
    const out = {
      source: result.source,
      action: result.action,
      name: play ? play.name : (result.action === 'pass' ? '不出（过牌）' : ''),
      cardsText: play ? G.cardTexts(play.cards).join(' ') : '',
      desc: play ? play.desc || '' : '',
      reason: result.reason || '',
      error: result.error || '',
      candidatesText: [],
    };
    if (Array.isArray(result.candidates)) {
      out.candidatesText = result.candidates.slice(0, 8).map(function (c) {
        const p = c && c.play ? c.play : c;
        if (!p || !p.cards) return '';
        const tag = c && c.tag ? '（' + c.tag + '）' : '';
        return p.name + ' ' + G.cardTexts(p.cards).join('') + tag;
      }).filter(Boolean);
    }
    return out;
  }

  function tributeView(game) {
    const exp = game.expanded || {};
    const phase = exp.phase;
    if (phase !== 'tribute' && phase !== 'return') return null;
    const mySeat = game.mySeat;
    if (!mySeat) return null;

    let roles = { tributers: [], receivers: [] };
    try { roles = G.tributeRoles(exp.lastRankList || []) || roles; } catch (e) { roles = { tributers: [], receivers: [] }; }
    const tributers = roles.tributers || [];
    const receivers = roles.receivers || [];
    const myIdx = tributers.indexOf(mySeat);
    const myRecvIdx = receivers.indexOf(mySeat);

    if (phase === 'tribute') {
      if (myIdx < 0) return null;
      const candidates = G.tributeCandidates(exp, mySeat);
      const toSeat = receivers[myIdx] || receivers[0] || 0;
      return {
        mode: 'tribute',
        fromName: '我',
        toName: toSeat ? seatName(toSeat, mySeat) : '收贡者',
        candidatesText: G.cardTexts(candidates).join(' '),
        suggestText: candidates.length ? G.cardTexts([candidates[0]]).join('') + '（' + G.cardText(candidates[0]) + '）' : '无可进贡',
      };
    }

    if (myRecvIdx < 0) return null;
    const candidates = G.returnCandidates(exp, mySeat);
    const toSeat = tributers[myRecvIdx] || tributers[0] || 0;
    return {
      mode: 'return',
      fromName: '我',
      toName: toSeat ? seatName(toSeat, mySeat) : '进贡者',
      candidatesText: G.cardTexts(candidates).join(' '),
      suggestText: candidates.length ? G.cardTexts([candidates[0]]).join('') + '（' + G.cardText(candidates[0]) + '）' : '无可还贡',
    };
  }

  /* ============================ 透视数据 ============================ */

  /**
   * 透视视图：数据源是页面 fiber 里 props.game.data 解码出的 expanded
   * （服务端下发的 cardPositionList 含四家全部牌归属，见 SPEC2 §1）。
   * 只读，不修改网络/页面状态；关闭时不下发任何手牌数据。
   */
  function xrayView(game) {
    const enabled = !!(st.settings && st.settings.xray);
    if (!enabled) {
      return { enabled: false, seats: [], warnings: [], note: '', totalCards: 0, bombCount: 0 };
    }
    const exp = game && game.expanded;
    const mySeat = (game && game.mySeat) || 0;
    if (!exp || !mySeat) {
      return { enabled: true, seats: [], warnings: [], note: '未入座或尚未读到牌局数据', totalCards: 0, bombCount: 0 };
    }
    let x;
    try {
      x = (ESP && typeof ESP.buildXray === 'function') ? ESP.buildXray(exp, mySeat) : null;
    } catch (e) {
      return { enabled: true, seats: [], warnings: [], note: '透视数据异常：' + errText(e), totalCards: 0, bombCount: 0 };
    }
    if (!x || !x.ok) {
      return { enabled: true, seats: [], warnings: [], note: (x && x.note) || '等待发牌…', totalCards: 0, bombCount: 0 };
    }
    return {
      enabled: true,
      seats: x.seats || [],
      warnings: x.warnings || [],
      note: '',
      totalCards: x.totalCards || 0,
      bombCount: x.bombCount || 0,
    };
  }

  function buildSnapshot(game) {
    const exp = game.expanded || {};
    const mySeat = game.mySeat || 1;
    const aiState = st.aiState || G.buildAIState(exp, mySeat);
    const level = aiState.level || 2;
    const phase = exp.phase || '';

    const seats = [];
    const relSeats = [mySeat, mySeat % 4 + 1, mySeat <= 2 ? mySeat + 2 : mySeat - 2, mySeat === 1 ? 4 : mySeat - 1];
    relSeats.forEach(function (seat) {
      const s = (aiState.seatsRemaining || []).filter(function (x) { return x.seat === seat; })[0] || { count: 0, rankBadge: null };
      seats.push({
        seat: seat,
        name: seatName(seat, mySeat),
        count: s.count || 0,
        isMe: seat === mySeat,
        isPartner: seat === S_partner(mySeat),
        tribute: (exp.tributers || []).indexOf(seat) >= 0,
        rankBadge: s.rankBadge != null ? s.rankBadge : null,
      });
    });

    const turn = phase === 'play' && exp.currentPlayer === mySeat;
    const counter = aiState.counter || { byRank: [] };
    const snapshot = {
      visible: true,
      isGuandan: true,
      mySeat: mySeat,
      phase: phase,
      level: level,
      levelText: aiState.levelText || G.rankText(level),
      wildText: aiState.wildText || ('♥' + G.rankText(level)),
      turn: turn,
      seats: seats,
      counter: {
        byRank: counter.byRank || [],
        wildRemaining: counter.wildRemaining,
        playedCount: counter.playedCount,
        unknown: counter.unknown,
      },
      handInfo: aiState.handInfo || AI.handSummary(aiState.hand || [], level),
      lastPlay: aiState.lastPlay ? {
        seatName: seatName(aiState.lastPlay.seat, mySeat),
        name: aiState.lastPlay.name,
        cardsText: aiState.lastPlay.cardsText,
      } : null,
      history: (aiState.history || []).slice(-3).map(function (h) {
        let text;
        if (h.passed) text = '过';
        else text = (h.name || '出牌') + ' ' + (h.cards || []).join('');
        return { seatName: h.seatName || seatName(h.seat, mySeat), text: text };
      }),
      suggestion: suggestionView(st.result),
      tribute: tributeView(game),
      xray: xrayView(game),
      busy: !!st.busy,
      auto: !!(st.settings && st.settings.auto),
      settings: {
        hasKey: !!effectiveApiKey(st.settings || DEFAULTS_SETTINGS),
        model: (st.settings && st.settings.model) || '',
        xray: !!(st.settings && st.settings.xray),
      },
    };
    return snapshot;
  }

  function S_partner(seat) {
    const s = Number(seat) || 0;
    return s <= 2 ? s + 2 : s - 2;
  }

  /* ============================ 建议计算 ============================ */

  function ensureAIState(game) {
    const mySeat = game.mySeat || 1;
    st.aiState = G.buildAIState(game.expanded, mySeat);
    return st.aiState;
  }

  function computeLocal(game) {
    const aiState = ensureAIState(game);
    let suggestion;
    try {
      suggestion = AI.suggest(aiState);
    } catch (e) {
      return { source: 'local', action: 'pass', play: null, reason: '本地建议异常，已按不出处理', error: errText(e), candidates: [], handInfo: null };
    }
    suggestion.source = 'local';
    if (!suggestion.handInfo) suggestion.handInfo = AI.handSummary(aiState.hand || [], aiState.level);
    return suggestion;
  }

  function sameDecisionState(game, key) {
    return st.resultKey === key && st.result;
  }

  /** 每 tick 维护建议：轮到我出牌时自动算本地建议；局面变化则失效 */
  function refreshSuggestion(game) {
    const exp = game.expanded || {};
    const key = decisionKey(game);
    const phase = exp.phase;
    const myTurn = phase === 'play' && exp.currentPlayer === game.mySeat;
    const needTribute = phase === 'tribute' && st.aiState && st.aiState.mustTribute;
    const needReturn = phase === 'return' && st.aiState && st.aiState.mustReturn;

    if (phase !== 'play' || !myTurn) {
      // 不是我的出牌回合：清空建议（进贡/还贡由 tribute 区块单独提示）
      if (st.result && phase !== 'play') { st.result = null; st.resultKey = ''; }
      if (st.result && !myTurn) { st.result = null; st.resultKey = ''; }
      return;
    }
    if (sameDecisionState(game, key)) {
      // 局面未变：若刚才的 DeepSeek 请求因局面切换被丢弃，这里补一次（dsTried 防重复）
      if (st.result && st.result.source === 'local' && st.dsTried !== key) {
        autoDeepSeekSuggestion(game, st.result, key);
      }
      return;
    }
    const localSug = computeLocal(game);
    st.result = localSug;
    st.resultKey = key;
    clearHighlight();
    highlightSuggestion(game);
    // 默认用 DeepSeek 建议：有 Key 且未开托管时，自动后台请求并替换本地建议
    autoDeepSeekSuggestion(game, localSug, key);
  }

  /** 默认 DeepSeek 建议：本地建议先显示，DeepSeek 返回后替换；失败/超时保留本地 */
  function autoDeepSeekSuggestion(game, localSug, key) {
    const s = st.settings || DEFAULTS_SETTINGS;
    if (!effectiveApiKey(s)) return;   // 没配 Key：只用本地
    if (s.auto) return;                // 托管模式由 autoTick 自己请求，避免重复
    if (st.busy || st.dsPending) return;
    if (st.dsTried === key) return;
    st.dsTried = key;
    st.dsPending = key;
    const aiState = ensureAIState(game);
    Remote.decide({ state: aiState, suggestion: localSug, counter: aiState.counter }, apiConfig())
      .then(function (res) {
        st.dsPending = '';
        if (!res || res.source !== 'deepseek') return;   // 回退本地，保留本地展示
        if (st.resultKey !== key) return;                // 局面已变，丢弃
        st.result = {
          source: 'deepseek',
          action: res.action === 'pass' ? 'pass' : 'play',
          play: res.play || null,
          reason: res.reason || '',
          error: '',
          candidates: localSug.candidates || [],
          handInfo: localSug.handInfo || null,
        };
        highlightSuggestion(game);
        renderTick();
      })
      .catch(function () { st.dsPending = ''; });
  }

  /* ============================ 高亮 ============================ */

  function ensureHighlightRoot() {
    if (st.hlEl && st.hlEl.parentNode) return st.hlEl;
    const el = document.createElement('div');
    el.id = 'hqgd-highlight';
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99998;';
    document.body.appendChild(el);
    st.hlEl = el;
    return el;
  }

  function clearHighlight() {
    if (st.hlEl) st.hlEl.textContent = '';
  }

  function highlightCards(cards) {
    const root = ensureHighlightRoot();
    root.textContent = '';
    let n = 0;
    (cards || []).forEach(function (id) {
      const el = cardEl(id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return;
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;pointer-events:none;border:2px solid #38bdf8;border-radius:4px;box-shadow:0 0 8px rgba(56,189,248,.8);';
      box.style.left = (r.left - 2) + 'px';
      box.style.top = (r.top - 2) + 'px';
      box.style.width = (r.width + 4) + 'px';
      box.style.height = (r.height + 4) + 'px';
      root.appendChild(box);
      n++;
    });
    if (!n) clearHighlight();
  }

  function highlightSuggestion(game) {
    // 按用户要求：不再在牌桌上画蓝色提示框（建议牌面已在面板文字中展示）
    clearHighlight();
  }

  /* ============================ 页面点击 ============================ */

  function normText(t) {
    return String(t || '').replace(/\s+/g, '');
  }

  function findClickable(re, maxLen) {
    const len = maxLen || 14;
    const btns = document.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const t = normText(btns[i].textContent);
      if (t && t.length <= len && re.test(t) && !btns[i].disabled) return btns[i];
    }
    const all = document.querySelectorAll('*');
    let fallback = null;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.children && el.children.length) continue;
      const t = normText(el.textContent);
      if (t && t.length <= len && re.test(t)) { fallback = el; }
    }
    return fallback;
  }

  function cardEl(id) {
    const el = document.getElementById(String(id));
    if (el && el.classList && (el.classList.contains('ddz-poker') || el.classList.contains('ddz-my-poker'))) return el;
    return null;
  }

  function isCardSelected(el) {
    if (!el) return false;
    const f = (el.style && el.style.filter) || '';
    if (f.indexOf('brightness') >= 0) return true;
    try {
      const cs = self.getComputedStyle(el);
      if (cs && cs.filter && cs.filter !== 'none' && cs.filter.indexOf('brightness') >= 0) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function myCardEls() {
    return Array.prototype.slice.call(document.querySelectorAll('.ddz-my-poker'));
  }

  function ensureNoSelection() {
    myCardEls().forEach(function (el) {
      if (isCardSelected(el)) HQ.clickEl(el);
    });
  }

  function clickCard(el) {
    if (!el) return false;
    if (!isCardSelected(el)) HQ.clickEl(el);
    return true;
  }

  async function clickButton(re, name) {
    const el = findClickable(re);
    if (!el) throw new Error('未找到「' + (name || re) + '」按钮');
    HQ.clickEl(el);
    return el;
  }

  /* ---------- 动作：出牌 / 不出 / 进贡 / 还贡 / 下一局 ---------- */

  async function playCards(cards) {
    if (!Array.isArray(cards) || !cards.length) throw new Error('没有可出的牌');
    ensureNoSelection();
    let need = 0;
    cards.forEach(function (id) { if (!isCardSelected(cardEl(id))) need++; });
    for (let i = 0; i < cards.length; i++) {
      const el = cardEl(cards[i]);
      if (!el) throw new Error('页面上找不到牌 ' + G.cardText(cards[i]) + '（' + cards[i] + '），可能状态已过期');
      if (!isCardSelected(el)) {
        HQ.clickEl(el);
        await HQ.sleep(35);
      }
    }
    await HQ.sleep(120);
    await clickButton(/出牌/, '出牌');
    await HQ.sleep(320);
  }

  async function passTurn() {
    await clickButton(/不出/, '不出');
    await HQ.sleep(260);
  }

  async function doTribute() {
    // 站点进贡阶段会自动预选第一张建议贡牌，直接确认即可
    await clickButton(/确认进贡/, '确认进贡');
    await HQ.sleep(320);
  }

  async function doReturn() {
    const game = st.game;
    if (!game) throw new Error('未读到对局');
    const cands = G.returnCandidates(game.expanded, game.mySeat);
    if (!cands.length) throw new Error('没有可还贡的牌');
    ensureNoSelection();
    const el = cardEl(cands[0]);
    if (!el) throw new Error('页面上找不到还贡牌 ' + G.cardText(cands[0]));
    HQ.clickEl(el);
    await HQ.sleep(120);
    await clickButton(/确认还贡/, '确认还贡');
    await HQ.sleep(320);
  }

  async function nextRound() {
    await clickButton(/下一局/, '下一局');
    await HQ.sleep(400);
  }

  async function runBusy(fn) {
    if (st.busy) return null;
    st.busy = true;
    try {
      return await fn();
    } catch (e) {
      toast('操作失败：' + errText(e), 'error');
      return null;
    } finally {
      st.busy = false;
    }
  }

  function toast(msg, type) {
    if (st.panel && st.panel.toast) st.panel.toast(msg, type);
    else if (HQ.toast) HQ.toast(msg, 'hqgd-toast');
  }

  /* ============================ 回调 ============================ */

  const callbacks = {
    onLocalSuggest: function () {
      const game = st.game;
      if (!game || !game.guandan) { toast('未检测到掼蛋对局', 'error'); return; }
      ensureAIState(game);
      const exp = game.expanded || {};
      if (exp.phase !== 'play' || exp.currentPlayer !== game.mySeat) {
        toast('还没轮到你出牌', 'error');
        return;
      }
      st.result = computeLocal(game);
      st.resultKey = decisionKey(game);
      highlightSuggestion(game);
      renderTick();
      if (st.result.action === 'play') toast('本地建议：' + st.result.play.name);
      else toast('本地建议：不出');
    },

    onDeepSeekSuggest: function () {
      const game = st.game;
      if (!game || !game.guandan) { toast('未检测到掼蛋对局', 'error'); return; }
      const s = st.settings || DEFAULTS_SETTINGS;
      if (!effectiveApiKey(s)) {
        toast('请先在设置里填写 DeepSeek API Key');
        if (st.panel) st.panel.openSettings();
        return;
      }
      const exp = game.expanded || {};
      if (exp.phase !== 'play' || exp.currentPlayer !== game.mySeat) {
        toast('还没轮到你出牌', 'error');
        return;
      }
      const aiState = ensureAIState(game);
      const localSug = computeLocal(game);
      const key = decisionKey(game);
      st.result = localSug;
      st.resultKey = key;
      renderTick();
      st.busy = true;
      renderTick();
      toast('正在请求 DeepSeek…');
      Remote.decide({ state: aiState, suggestion: localSug, counter: aiState.counter }, apiConfig())
        .then(function (res) {
          st.busy = false;
          if (!res) { renderTick(); return; }
          st.result = {
            source: res.source || 'local',
            action: res.action === 'pass' ? 'pass' : 'play',
            play: res.play || null,
            reason: res.reason || '',
            error: res.error || '',
            candidates: localSug.candidates || [],
            handInfo: localSug.handInfo || null,
          };
          st.resultKey = decisionKey(st.game || game);
          highlightSuggestion(st.game || game);
          renderTick();
          if (res.source === 'deepseek') toast(res.action === 'pass' ? 'DeepSeek 建议：不出' : 'DeepSeek 建议：' + (res.play ? res.play.name : '出牌'));
          else toast('DeepSeek 不可用，已回退本地建议：' + (res.error || ''));
        })
        .catch(function (e) {
          st.busy = false;
          renderTick();
          toast('DeepSeek 调用异常，已保留本地建议：' + errText(e), 'error');
        });
    },

    onAdopt: function () {
      const game = st.game;
      if (!game || !game.guandan) { toast('未检测到掼蛋对局', 'error'); return; }
      const exp = game.expanded || {};
      if (exp.phase === 'play' && exp.currentPlayer !== game.mySeat) {
        toast('还没轮到你出牌', 'error');
        return;
      }
      if (!st.result) {
        st.result = computeLocal(game);
        st.resultKey = decisionKey(game);
      }
      const res = st.result;
      if (res.action === 'play' && res.play) {
        runBusy(function () { return playCards(res.play.cards); }).then(function () { st.result = null; st.resultKey = ''; });
      } else {
        runBusy(function () { return passTurn(); }).then(function () { st.result = null; st.resultKey = ''; });
      }
    },

    onPass: function () {
      const game = st.game;
      if (!game || !game.guandan) { toast('未检测到掼蛋对局', 'error'); return; }
      const exp = game.expanded || {};
      if (exp.phase !== 'play' || exp.currentPlayer !== game.mySeat) {
        toast('还没轮到你出牌', 'error');
        return;
      }
      runBusy(function () { return passTurn(); }).then(function () { st.result = null; st.resultKey = ''; });
    },

    onTribute: function () {
      const game = st.game;
      if (!game || !game.guandan) { toast('未检测到对局', 'error'); return; }
      const exp = game.expanded || {};
      if (exp.phase === 'tribute') {
        runBusy(doTribute).then(function () { st.result = null; st.resultKey = ''; });
      } else if (exp.phase === 'return') {
        runBusy(doReturn).then(function () { st.result = null; st.resultKey = ''; });
      } else {
        toast('当前不是进贡/还贡阶段', 'error');
      }
    },

    onReturn: function () { callbacks.onTribute(); },

    onNextRound: function () {
      runBusy(nextRound).then(function () { st.result = null; st.resultKey = ''; });
    },

    onToggleAuto: function (auto) {
      saveSettings({ auto: !!auto });
      if (!auto) { clearAutoTimer(); clearHighlight(); }
      renderTick();
    },

    onToggleXray: function (on_) {
      saveSettings({ xray: !!on_ });
      renderTick();
    },

    onSaveSettings: function (form) {
      saveSettings(form || {});
      toast('设置已保存（本机）');
      renderTick();
    },

    onTestConnection: function (form) {
      const cfg = apiConfig(form || {});
      if (!cfg.apiKey) return Promise.resolve({ ok: false, message: '请先填写 API Key' });
      return Remote.testConnection(cfg).then(function (r) {
        return r && typeof r === 'object' ? r : { ok: false, message: '测试返回异常' };
      });
    },
  };

  /* ============================ 自动托管 ============================ */

  function clearAutoTimer() {
    if (st.autoTimer) {
      clearTimeout(st.autoTimer);
      st.autoTimer = null;
    }
  }

  function autoTick(game) {
    if (!st.settings || !st.settings.auto) return;
    if (st.busy || !game || !game.guandan) return;
    const exp = game.expanded || {};
    const mySeat = game.mySeat;
    const sig = decisionKey(game) + '|' + (exp.phase || '');
    if (sig === st.autoKey) return;
    st.autoKey = sig;

    const act = function (fn) {
      clearAutoTimer();
      st.autoTimer = setTimeout(function () {
        st.autoTimer = null;
        if (!st.settings || !st.settings.auto) return;
        runBusy(fn);
      }, 900);
    };

    if (exp.phase === 'play' && exp.currentPlayer === mySeat) {
      const localSug = computeLocal(game);
      st.result = localSug;
      st.resultKey = decisionKey(game);
      if (!effectiveApiKey(st.settings || DEFAULTS_SETTINGS)) {
        // 无 Key：直接按本地建议托管
        if (localSug.action === 'play' && localSug.play) act(function () { return playCards(localSug.play.cards); });
        else act(passTurn);
      } else {
        // 有 Key：托管交给 DeepSeek 决策，失败/超时回退本地
        const aiState = ensureAIState(game);
        st.busy = true;
        renderTick();
        Remote.decide({ state: aiState, suggestion: localSug, counter: aiState.counter }, apiConfig())
          .then(function (res) {
            st.busy = false;
            if (!st.settings || !st.settings.auto) { renderTick(); return; }
            const nowGame = st.game;
            const nowExp = (nowGame && nowGame.expanded) || {};
            const stillMyTurn = !!nowGame && nowGame.guandan && nowExp.phase === 'play' && nowExp.currentPlayer === nowGame.mySeat;
            if (!stillMyTurn) { renderTick(); return; }   // 等待期间回合已变，放弃本次
            let chosen = localSug;
            if (res && res.source === 'deepseek' && (res.action === 'pass' || (res.action === 'play' && res.play && Array.isArray(res.play.cards) && res.play.cards.length))) {
              chosen = {
                source: 'deepseek',
                action: res.action === 'pass' ? 'pass' : 'play',
                play: res.play || null,
                reason: res.reason || '',
                error: '',
                candidates: localSug.candidates || [],
                handInfo: localSug.handInfo || null,
              };
            }
            st.result = chosen;
            st.resultKey = decisionKey(nowGame || game);
            renderTick();
            act(function () {
              if (chosen.action === 'play' && chosen.play) return playCards(chosen.play.cards);
              return passTurn();
            });
          })
          .catch(function (e) {
            st.busy = false;
            if (!st.settings || !st.settings.auto) { renderTick(); return; }
            st.result = localSug;
            renderTick();
            act(function () {
              if (localSug.action === 'play' && localSug.play) return playCards(localSug.play.cards);
              return passTurn();
            });
          });
      }
      return;
    }
    if (exp.phase === 'tribute') {
      const aiState = ensureAIState(game);
      if (aiState.mustTribute) act(doTribute);
      return;
    }
    if (exp.phase === 'return') {
      const aiState = ensureAIState(game);
      if (aiState.mustReturn) act(doReturn);
    }
  }

  /* ============================ mount / tick ============================ */

  function mount(container) {
    loadSettings();
    st.panel = UI.create(container, Object.assign({ settings: uiSettings() }, callbacks));
    st.mounted = true;
    renderTick();
    return st.panel.handle;
  }

  function renderTick() {
    if (!st.panel) return;
    try {
      const snap = st.snapshot || { visible: false, isGuandan: false };
      st.panel.update(snap);
    } catch (e) {
      st.lastTickError = errText(e);
    }
  }

  function buildVisibleSnapshot() {
    const game = st.game;
    if (!game) return { visible: false, isGuandan: false };
    if (!game.guandan) {
      return { visible: true, isGuandan: false, reason: game.reason || '' };
    }
    if (!game.mySeat) {
      // 观战 / 未入座：面板照常展示，但只读
      const exp = game.expanded || {};
      return {
        visible: true,
        isGuandan: true,
        phase: exp.phase || '',
        level: exp.level || 2,
        levelText: G.rankText(exp.level || 2),
        wildText: '♥' + G.rankText(exp.level || 2),
        seats: [],
        counter: { byRank: [] },
        handInfo: null,
        lastPlay: null,
        history: [],
        suggestion: null,
        tribute: null,
        xray: xrayView(game),
        busy: !!st.busy,
        auto: !!(st.settings && st.settings.auto),
        settings: {
          hasKey: !!effectiveApiKey(st.settings || DEFAULTS_SETTINGS),
          model: (st.settings && st.settings.model) || '',
          xray: !!(st.settings && st.settings.xray),
        },
      };
    }
    return buildSnapshot(game);
  }

  function tick() {
    if (!st.panel) return;
    if (!/\/ddz/.test(location.pathname)) {
      st.snapshot = { visible: false, isGuandan: false };
      renderTick();
      return;
    }
    let game;
    try {
      game = readGame();
    } catch (e) {
      game = { guandan: false, reason: 'read-error', error: errText(e) };
    }
    const prevSig = st.lastTurnSig;
    st.game = game;
    if (game.guandan) {
      try {
        ensureAIState(game);
      } catch (e) {
        st.aiState = null;
      }
      refreshSuggestion(game);
      highlightSuggestion(game);
    } else {
      st.aiState = null;
      st.result = null;
      st.resultKey = '';
      clearHighlight();
    }
    st.snapshot = buildVisibleSnapshot();
    st.lastTurnSig = (st.snapshot.level || 0) + '|' + st.snapshot.phase + '|' + (st.snapshot.turn ? 1 : 0) + '|' + st.mySeat;
    renderTick();
    if (game.guandan) {
      const p = game.expanded && game.expanded.currentPlayer;
      if (p !== prevSig) { /* 回合切换时重画高亮已由 tick 完成 */ }
      autoTick(game);
    } else {
      clearAutoTimer();
    }
  }

  /* ============================ 调试接口 ============================ */

  self.__gdAI = {
    version: VERSION,
    dump: function () {
      return {
        version: VERSION,
        mounted: st.mounted,
        settings: {
          hasKey: !!effectiveApiKey(st.settings || DEFAULTS_SETTINGS),
          keyMask: maskKey(effectiveApiKey(st.settings || DEFAULTS_SETTINGS)),
          baseUrl: st.settings && st.settings.baseUrl,
          model: st.settings && st.settings.model,
          auto: !!(st.settings && st.settings.auto),
          xray: !!(st.settings && st.settings.xray),
        },
        game: st.game ? { guandan: st.game.guandan, reason: st.game.reason, mySeat: st.game.mySeat } : null,
        snapshot: st.snapshot,
        result: st.result,
        busy: st.busy,
        lastTickError: st.lastTickError,
      };
    },
    read: function () { return readGame(); },
    suggest: function () {
      const game = st.game && st.game.guandan ? st.game : readGame();
      if (!game || !game.guandan) return null;
      return computeLocal(game);
    },
    deepseek: function () {
      const game = st.game && st.game.guandan ? st.game : readGame();
      if (!game || !game.guandan) return Promise.resolve(null);
      const aiState = ensureAIState(game);
      const localSug = computeLocal(game);
      return Remote.decide({ state: aiState, suggestion: localSug, counter: aiState.counter }, apiConfig());
    },
    play: function (cards) { return playCards(cards); },
    pass: function () { return passTurn(); },
    tribute: function () { return doTribute(); },
    returnCard: function () { return doReturn(); },
    nextRound: function () { return nextRound(); },
    settings: {
      get: function () { return st.settings; },
      set: function (patch) { saveSettings(patch || {}); return st.settings; },
    },
    decode: function (bytes) { return G.decodeGameData(bytes); },
    expand: function (raw) { return G.expandState(raw); },
    encode: function (raw) { return G.encodeGameData(raw); },
    xray: function () { return xrayView(st.game); },
    tick: tick,
  };

  /* ============================ 注册 ============================ */

  HQ.registerGame({
    id: 'ddz',
    name: '掼蛋 AI 助手',
    icon: '🃏',
    route: /\/ddz/,
    interval: 550,
    dragIgnore: 'hqgd-icon-btn',
    mount: mount,
    tick: tick,
  });

  /* ---------- SPA 路由感知挂载 ----------
   * 站点是单页应用：从首页点进房间时页面不会重新加载，而用户脚本只在页面加载时注入。
   * 所以这里自己轮询路由：一旦路径变成 /ddz 就挂面板（只挂一次，避免重复）。
   * （原先只靠 build 的 epilogue 一次性挂载，从首页导航进入时面板不会出现。）
   */
  (function watchRoute() {
    function tryMount() {
      if (st.mounted) return;
      if (!/\/ddz/.test(location.pathname)) return;
      if (HQ.mountStandalone) HQ.mountStandalone();
    }
    tryMount();
    setInterval(tryMount, 500);
  })();
})();

})();
