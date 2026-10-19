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
      // body 明确给出了 auto 字段时，以 body 为准确认开关状态
      if (snapRaw && typeof snapRaw === 'object' && snapRaw.auto !== undefined) autoPending = null;
      root.style.display = snap.visible ? '' : 'none';
      renderBadge(snap);
      refreshAutoBtn();
      const guandan = snap.isGuandan;
      const hideSections = !guandan;
      secCounter.style.display = hideSections ? 'none' : '';
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
      errText: errText,
    },
  };
});
