/* _fixture.test.js — 端到端夹具断言（假 DOM/假 fiber → 构建产物「掼蛋AI助手.user.js」）
 *
 * 由 _fixture.html 在构建产物之后加载，轮询等待面板挂载与 tick，逐项断言：
 *   面板/记牌器数字/我的信息/座位/本地建议合法性/点「本地建议」/点「采用并出牌」
 *   （逐张手牌点击 + 站点出牌按钮 1 次）/点「不出」/无 Key 点 DeepSeek 打开设置且不联网/
 *   设置保存到 localStorage/有 Key 且网络失败 → 回退 local/全程无未捕获错误。
 * 结果写入 <pre id="fixture-result">：首行 `PASS n / FAIL m`，其后为失败明细。
 */
(function () {
  'use strict';

  var pass = 0;
  var fail = 0;
  var fails = [];
  var resultEl = document.getElementById('fixture-result');
  var logEl = document.getElementById('fixture-log');

  function log(msg) {
    if (logEl) logEl.textContent += String(msg) + '\n';
  }
  function ok(cond, msg) {
    if (cond) { pass++; log('PASS ' + msg); return true; }
    fail++;
    fails.push('✗ ' + msg);
    log('FAIL ' + msg);
    return false;
  }
  function eq(actual, expected, msg) {
    return ok(actual === expected, msg + ' — 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
  function text(el) { return el ? String(el.textContent || '') : ''; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
  function panel() { return document.getElementById('hqgd-panel'); }
  function dump() { return (window.__gdAI && typeof window.__gdAI.dump === 'function') ? window.__gdAI.dump() : null; }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function until(fn, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function poll() {
        var value = null;
        try { value = fn(); } catch (e) { value = null; }
        if (value) { resolve(value); return; }
        if (Date.now() - start > timeoutMs) { reject(new Error('等待超时：' + label)); return; }
        setTimeout(poll, 80);
      })();
    });
  }

  function findButton(root, needle) {
    var list = (root || document).querySelectorAll('button');
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].textContent || '').indexOf(needle) >= 0) return list[i];
    }
    return null;
  }
  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function clickPanel(needle) {
    var b = findButton(panel(), needle);
    if (!b) throw new Error('面板中找不到按钮：' + needle);
    click(b);
    return b;
  }
  function clickPanelNth(needle) {
    var list = panel().querySelectorAll('button');
    for (var i = 0; i < list.length; i++) if (String(list[i].textContent || '').indexOf(needle) >= 0) { click(list[i]); return list[i]; }
    throw new Error('面板中找不到按钮：' + needle);
  }
  function counterCells() {
    var grid = document.querySelector('.hqgd-counter-grid');
    return grid ? Array.prototype.slice.call(grid.querySelectorAll('.hqgd-cc')) : [];
  }
  function cellByLabel(label) {
    var cells = counterCells();
    for (var i = 0; i < cells.length; i++) {
      if (text(cells[i].querySelector('i')) === label) return cells[i];
    }
    return null;
  }
  function expectedCounter(G, F) {
    var totals = {};
    for (var r = 2; r <= 14; r++) totals[r] = 8;
    totals[16] = 2;
    totals[17] = 2;
    var mine = {};
    F.raw.cardPositionList.forEach(function (owner, idx) {
      if (owner !== 2) return;
      var rank = G.rankOf(idx + 1);
      mine[rank] = (mine[rank] || 0) + 1;
    });
    return [17, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map(function (rank) {
      return { rank: rank, label: G.rankText(rank), mine: mine[rank] || 0, remaining: totals[rank] - (mine[rank] || 0) };
    });
  }
  function cardKey(list) {
    return list.slice().sort(function (a, b) { return a - b; }).join(',');
  }

  function finish() {
    var lines = ['PASS ' + pass + ' / FAIL ' + fail];
    if (fails.length) lines = lines.concat(fails);
    if (resultEl) resultEl.textContent = lines.join('\n');
    window.__fixtureDone = true;
  }

  async function main() {
    /* ---------- 0) 环境 ---------- */
    var F = window.__fixture;
    var G = window.GDSite;
    ok(!!F, '夹具环境已就绪（window.__fixture）');
    if (!F) return;
    ok(F.setupErrors.length === 0, 'setup 阶段无错误' + (F.setupErrors.length ? '：' + F.setupErrors.join('；') : ''));
    ok(!!G && typeof G.encodeGameData === 'function', 'gd.site.core.js 正常加载（GDSite.encodeGameData 存在）');
    if (!G) return;

    /* ---------- 1) 面板挂载 ---------- */
    var p = await until(panel, 8000, '面板 #hqgd-panel 挂载');
    ok(!!p, '构建产物自动挂载面板 #hqgd-panel');
    ok(text(p).indexOf('掼蛋 AI 助手') >= 0, '面板含标题「掼蛋 AI 助手」');
    ok(!!document.getElementById('hqgd-style'), '面板样式已注入（#hqgd-style）');

    /* ---------- 2) __gdAI 就绪 + 首个 tick 快照 ---------- */
    var ready = await until(function () {
      var d = dump();
      return (d && d.mounted && d.snapshot) ? d : null;
    }, 8000, '__gdAI 就绪且首个 tick 完成');
    ok(!!ready, 'window.__gdAI 就绪（mounted=true，snapshot 已生成）');
    var snap = ready.snapshot;
    ok(!!snap, 'dump().snapshot 可读');
    if (snap) {
      eq(snap.visible, true, 'snapshot.visible=true');
      eq(snap.isGuandan, true, 'snapshot.isGuandan=true（识别为掼蛋房间）');
      eq(snap.mySeat, 2, 'mySeat=2（room.position=2）');
      eq(snap.phase, 'play', 'phase=play');
      eq(snap.level, 2, 'level=2（lastRankList 空 → team13Level=2）');
      eq(snap.turn, true, 'turn=true（轮到我领出）');
    }
    // 首个 tick 识别到掼蛋房间后才应显示面板（mount 时为 visible:false，属预期行为）
    ok(panel().style.display !== 'none', '首个 tick 识别掼蛋后面板可见（display=' + JSON.stringify(panel().style.display) + '）');

    /* ---------- 3) 记牌器：数字必须等于按手牌/对局推导出的剩余张数 ---------- */
    var expected = expectedCounter(G, F);
    var cells = counterCells();
    eq(cells.length, 15, '记牌器 15 格（大王、小王、A、K…2）');
    var badCells = [];
    expected.forEach(function (e) {
      var cell = cellByLabel(e.label);
      if (!cell) { badCells.push(e.label + '(缺格)'); return; }
      var got = text(cell.querySelector('b')).trim();
      if (got !== String(e.remaining)) badCells.push(e.label + ' 显示' + got + '·应' + e.remaining);
    });
    ok(badCells.length === 0,
      '记牌器每格数字=理论剩余张数（' + badCells.length + ' 处不符' + (badCells.length ? '：' + badCells.slice(0, 8).join('；') : '') + '）');
    var levelCell = cellByLabel(G.rankText(2));
    ok(!!levelCell && levelCell.className.indexOf('hqgd-cc-level') >= 0, '级牌格带 hqgd-cc-level 高亮样式');
    ok(!!levelCell && /级/.test(text(levelCell)), '级牌格有「级」标记');
    var sumText = text(document.querySelector('.hqgd-counter-sum'));
    ok(sumText.indexOf('未知 81') >= 0, '记牌器汇总含「未知 81」（实际：' + norm(sumText) + '）');
    ok(/已出\s*0/.test(sumText), '记牌器汇总含「已出 0」（实际：' + norm(sumText) + '）');
    ok(/逢人配\s*2/.test(sumText), '记牌器汇总含「逢人配 2」（实际：' + norm(sumText) + '）');

    /* ---------- 4) 我的信息 / 座位 ---------- */
    var myinfo = document.querySelector('.hqgd-myinfo');
    ok(/27\s*张/.test(norm(text(myinfo))), '我的信息显示 27 张（实际：' + norm(text(myinfo)) + '）');
    var seatRows = Array.prototype.slice.call(document.querySelectorAll('.hqgd-seat-row'));
    eq(seatRows.length, 4, '牌桌 4 个座位');
    var badSeats = [];
    seatRows.forEach(function (row, i) {
      if (!/27\s*张/.test(norm(text(row)))) badSeats.push('第' + (i + 1) + '行：' + norm(text(row)));
    });
    ok(badSeats.length === 0, '四个座位都显示 27 张' + (badSeats.length ? '（不符：' + badSeats.join('；') + '）' : ''));
    ok(seatRows.length > 0 && /我/.test(text(seatRows[0])), '第一个座位行标「我」');
    ok(seatRows.length > 2 && /队友/.test(text(seatRows[2])), '对家座位行标「队友」');

    /* ---------- 4.5) 透视：默认关闭 → 开 → 三家手牌/预警/持久化 → 关 ---------- */
    var xrayToggle = findButton(panel(), '透视：关');
    ok(!!xrayToggle, '面板含透视开关且默认关闭（「透视：关」）');
    ok(!dump().snapshot.xray.enabled, '默认 snapshot.xray.enabled=false（不渲染别家手牌）');
    eq(document.querySelectorAll('.hqgd-xray-seat').length, 0, '关闭时不渲染透视座位块');
    if (xrayToggle) {
      click(xrayToggle);
      var xOn = await until(function () { return findButton(panel(), '透视：开'); }, 5000, '透视开关打开');
      ok(!!xOn, '点击后开关变为「透视：开」');
      var xdata = await until(function () {
        var d = dump();
        return (d && d.snapshot && d.snapshot.xray && d.snapshot.xray.enabled && d.snapshot.xray.seats.length === 3)
          ? d.snapshot.xray : null;
      }, 8000, '透视数据生成');
      ok(!!xdata, '开启后 snapshot.xray 含其他三家数据');
      if (xdata) {
        ok(xdata.seats.every(function (s) { return s.seat !== 2; }), '透视数据不含我（座位 2）');
        var xseat3 = xdata.seats.filter(function (s) { return s.seat === 3; })[0];
        ok(!!xseat3 && xseat3.count === 27, '下家（座位 3）显示 27 张');
        ok(!!xseat3 && xseat3.cards.length === 27, '下家 27 张牌面全部可读（透视成功）');
        eq(xdata.totalCards, 81, '透视总可见 81 张（三家 × 27）');
        eq(document.querySelectorAll('.hqgd-xray-seat').length, 3, '面板渲染 3 个透视座位块');
        eq(document.querySelectorAll('.hqgd-xray-chip').length, 81, '面板渲染 81 张透视牌');
        var storedXray = null;
        try { storedXray = JSON.parse(window.localStorage.getItem('gdSiteAI.settings')); } catch (e) { storedXray = null; }
        eq(storedXray && storedXray.xray, true, '透视开关写入 localStorage（xray=true）');
      }
      click(findButton(panel(), '透视：开'));
      await until(function () { return findButton(panel(), '透视：关'); }, 5000, '透视开关关闭');
      var offX = dump().snapshot.xray;
      ok(offX && offX.enabled === false && offX.seats.length === 0, '关闭后 snapshot.xray 清空（不再下发手牌数据）');
      eq(document.querySelectorAll('.hqgd-xray-seat').length, 0, '关闭后面板不再渲染透视座位块');
      var storedOff = null;
      try { storedOff = JSON.parse(window.localStorage.getItem('gdSiteAI.settings')); } catch (e) { storedOff = null; }
      eq(storedOff && storedOff.xray, false, '关闭写入 localStorage（xray=false）');
    }

    /* ---------- 5) 自动本地建议：合法、⊆手牌、出自 genMoves ---------- */
    var sugReady = await until(function () {
      var d = dump();
      return (d && d.result && d.result.action === 'play') ? d : null;
    }, 8000, '自动生成本地建议');
    ok(!!sugReady, 'tick 自动生成本地建议并渲染');
    var d1 = dump();
    ok(!!d1.result, 'dump().result 存在');
    if (d1.result) {
      eq(d1.result.source, 'local', '自动建议来源=local');
      eq(d1.result.action, 'play', '领出时建议 action=play');
      var play = d1.result.play;
      ok(!!play, '建议携带 play 对象');
      if (play) {
        var handSet = {};
        F.myHand.forEach(function (cid) { handSet[cid] = 1; });
        var notInHand = play.cards.filter(function (cid) { return !handSet[cid]; });
        ok(notInHand.length === 0, '建议 cards 全部 ⊆ 我的手牌（越界：' + notInHand.join(',') + '）');
        ok(G.bestCode(play.cards, 0, F.level) !== 0, '建议牌型合法（bestCode(cards,0,level=2)!=0）');
        var moves = G.genMoves(F.myHand, F.level, 0);
        var key = cardKey(play.cards);
        var hit = moves.some(function (m) { return cardKey(m.cards) === key && m.code === play.code; });
        ok(hit, '建议来自 genMoves(hand, level=2, prevCode=0)（同 cards 同 code）');
        window.__fixtureSuggested = play.cards.slice();
      }
    }
    var domSug = document.querySelector('.hqgd-suggest');
    ok(!!domSug && text(domSug).indexOf('本地') >= 0, '建议区来源徽标显示「本地」');

    /* ---------- 6) 点「本地建议」按钮 ---------- */
    clickPanel('本地建议');
    var localResult = await until(function () {
      var d = dump();
      return (d && d.result && d.result.action === 'play') ? d : null;
    }, 5000, '点击「本地建议」后仍有可出建议');
    ok(!!localResult, '点击「💡 本地建议」后仍有可出建议');
    ok(!!localResult && localResult.result.source === 'local', '点击后建议来源仍为 local');

    /* ---------- 7) 采用并出牌：逐张点手牌 + 站点「出牌」按钮 1 次 ---------- */
    await until(function () { var d = dump(); return d && !d.busy; }, 6000, '空闲（busy=false）');
    var suggestCards = window.__fixtureSuggested || ((dump().result && dump().result.play) ? dump().result.play.cards.slice() : []);
    ok(suggestCards.length > 0, '有可采用的建议牌（' + suggestCards.join(',') + '）');
    var beforePlay = F.clicks.play;
    clickPanel('采用并出牌');
    await until(function () { return F.clicks.play > beforePlay; }, 8000, '站点「出牌」按钮被点击');
    eq(F.clicks.play - beforePlay, 1, '点「⚡ 采用并出牌」→ 站点「出牌」按钮恰好点击 1 次');
    var missedCard = suggestCards.filter(function (cid) { return !F.cardClicks[cid]; });
    ok(missedCard.length === 0, '建议的每张手牌都被逐张点击（漏：' + missedCard.join(',') + '）');
    var unselected = suggestCards.filter(function (cid) {
      var el = F.cardEls[cid];
      return !(el && String(el.style.filter || '').indexOf('brightness') >= 0);
    });
    ok(unselected.length === 0, '被采用的手牌呈选中态（未选中：' + unselected.join(',') + '）');
    eq(F.clicks.pass, 0, '采用出牌未误点站点「不出」');
    await until(function () { var d = dump(); return d && !d.busy; }, 8000, '出牌动作结束');

    /* ---------- 8) 点面板「不出」→ 站点「不出」按钮被点 1 次 ---------- */
    var beforePass = F.clicks.pass;
    clickPanel('不出');
    await until(function () { return F.clicks.pass > beforePass; }, 6000, '站点「不出」按钮被点击');
    eq(F.clicks.pass - beforePass, 1, '点面板「🃏 不出」→ 站点「不出」按钮点击 1 次');

    /* ---------- 9) 无 Key 点 DeepSeek：打开设置弹窗、不联网、直接调用回退 local ---------- */
    await sleep(1200);
    eq(dump().settings.hasKey, false, '初始无 Key（dump().settings.hasKey=false）');
    var beforeFetch = F.fetch().calls;
    clickPanel('DeepSeek 建议');
    var overlay = await until(function () { return document.getElementById('hqgd-settings-overlay'); }, 5000, '设置弹窗出现');
    ok(!!overlay, '无 Key 点「🌐 DeepSeek 建议」→ 打开设置弹窗');
    ok(getComputedStyle(overlay).display !== 'none', '设置弹窗可见（computed display=' + getComputedStyle(overlay).display + '）');
    eq(F.fetch().calls, beforeFetch, '无 Key 时不发起网络请求（fetch 调用计数不变）');
    var keyInput = overlay.querySelector('input[data-field="apiKey"]');
    ok(!!keyInput, '设置弹窗含 API Key 输入框');
    eq(keyInput && keyInput.type, 'password', 'API Key 输入框 type=password（不回显）');
    eq(keyInput && keyInput.getAttribute('autocomplete'), 'off', 'API Key 输入框 autocomplete=off');
    eq(keyInput && keyInput.value, '', 'API Key 输入框默认不回显明文');
    var dsNoKey = await window.__gdAI.deepseek();
    eq(dsNoKey && dsNoKey.source, 'local', '直接调用 __gdAI.deepseek()（无 Key）→ 回退 local');
    eq(F.fetch().calls, beforeFetch, '无 Key 回退过程中不联网（fetch 计数不变）');

    /* ---------- 10) 设置保存：写入 localStorage、hasKey、Key 不泄露 ---------- */
    var TEST_KEY = 'sk-fixture-e2e-0123456789abcdef';
    ok(F.localStorageOk, 'file:// 下 localStorage 可用（setup 探测）');
    keyInput.value = TEST_KEY;
    var saveBtn = findButton(overlay, '保存');
    ok(!!saveBtn, '设置弹窗含「保存」按钮');
    click(saveBtn);
    await sleep(300);
    var storedRaw = null;
    try { storedRaw = window.localStorage.getItem('gdSiteAI.settings'); } catch (e) { storedRaw = null; }
    var stored = null;
    try { stored = storedRaw ? JSON.parse(storedRaw) : null; } catch (e) { stored = null; }
    ok(!!stored, '保存设置 → localStorage[gdSiteAI.settings] 有数据（实际：' + String(storedRaw).slice(0, 100) + '）');
    eq(stored && stored.apiKey, TEST_KEY, 'localStorage 中 apiKey 正确');
    eq(stored && stored.model, 'deepseek-chat', '默认 model=deepseek-chat');
    eq(stored && stored.baseUrl, 'https://api.deepseek.com', '默认 baseUrl=https://api.deepseek.com');
    eq(dump().settings.hasKey, true, '保存后 dump().settings.hasKey=true');
    ok(String(dump().settings.keyMask || '').indexOf(TEST_KEY) < 0, 'dump 不泄露完整 Key（keyMask=' + dump().settings.keyMask + '）');
    var visibleText = text(panel()) + text(overlay);
    ok(visibleText.indexOf(TEST_KEY) < 0, '面板/设置弹窗文本不含完整 Key');
    eq(keyInput.value, '', '保存后 API Key 输入框清空（不回显明文）');
    var statusEl = overlay.querySelector('.hqgd-modal-status');
    ok(/保存|成功/.test(text(statusEl)), '保存后弹窗有状态提示（实际：' + norm(text(statusEl)) + '）');
    var closeBtn = findButton(overlay, '关闭');
    if (closeBtn) click(closeBtn);
    await sleep(150);

    /* ---------- 11) 有 Key + 网络失败 → 回退 local 且带 error ---------- */
    await until(function () { var d = dump(); return d && !d.busy; }, 6000, '空闲（busy=false）');
    var beforeFetch2 = F.fetch().calls;
    clickPanel('DeepSeek 建议');
    await until(function () { return F.fetch().calls > beforeFetch2; }, 8000, 'DeepSeek 请求已发出');
    ok(F.fetch().calls > beforeFetch2, '有 Key 点「DeepSeek 建议」→ 发起请求（mock fetch 计数增加）');
    var fallback = await until(function () {
      var d = dump();
      return (d && d.result && d.result.source === 'local' && d.result.error) ? d.result : null;
    }, 10000, '网络失败后回退本地');
    ok(!!fallback, '网络失败 → 回退本地建议');
    eq(fallback && fallback.source, 'local', '回退结果 source=local');
    ok(!!(fallback && fallback.error), '回退结果携带 error 说明（' + ((fallback && fallback.error) || '') + '）');
    ok(!!fallback && (fallback.action === 'play' || fallback.action === 'pass'), '回退建议 action 合法');
    ok(/回退/.test(text(panel())), '面板显示回退提示');

    /* ---------- 12) 全程无未捕获错误 ---------- */
    eq(F.errors.length, 0, '无未捕获错误 / console.error' + (F.errors.length ? '：' + F.errors.slice(0, 3).join(' | ') : ''));
    ok(!dump().lastTickError, 'lastTickError 为空' + (dump().lastTickError ? '（' + dump().lastTickError + '）' : ''));
  }

  main()
    .catch(function (e) {
      ok(false, '夹具执行异常：' + ((e && (e.message || e.stack)) || e));
    })
    .then(finish);
})();
