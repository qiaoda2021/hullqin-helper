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
