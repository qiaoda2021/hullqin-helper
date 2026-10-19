/* _fixture.setup.js — 端到端夹具环境搭建（假 DOM / 假 fiber / 假站点桥接）
 *
 * 由 _fixture.html 在 gd.site.core.js 之后、构建产物「掼蛋AI助手.user.js」之前加载：
 *   1) 用 GDSite.encodeGameData 生成合法 raw 对局：我在 2 号位、轮到我领出、手牌 = 牌 id 1..27；
 *   2) 构造站点 DOM：.ddz-poker.ddz-my-poker 手牌（id = 牌 id）+ 出牌/不出/确认进贡/确认还贡按钮（点击计数）；
 *   3) 给手牌元素挂 __reactFiber$fixture 假 fiber 链（牌 props → 牌桌 props{room,game,send}），
 *      让 userscript.body.js 的 HQ.findProps 能读到 {room:{position}, game:{data}, send}；
 *   4) 用 window.fetch 离线桩（计数 + 一律 reject）替代真实网络；收集未捕获错误与 console.error。
 *
 * 运行前置：页面路径必须包含 /ddz（userscript.body.js tick 与 HQ.mountStandalone 的路由门槛）。
 * 在 油猴版 目录下建立目录联接后访问：
 *   New-Item -ItemType Junction -Path .\ddz -Target . | Out-Null
 *   msedge --headless=new --disable-gpu --virtual-time-budget=25000 --dump-dom \
 *     "file:///D:/下载/hullqin-helper-main/hullqin掼蛋/油猴版/ddz/_fixture.html" > _fixture.dump.html
 *   node _fixture.parse-dump.js _fixture.dump.html      （见报告中的解析方式；结果在 <pre id="fixture-result">）
 */
(function () {
  'use strict';

  var setupErrors = window.__fixtureSetupErrors = [];
  function setupFail(msg) { setupErrors.push(msg); }

  var G = window.GDSite;
  if (!G || typeof G.encodeGameData !== 'function' || typeof G.rankOf !== 'function') {
    setupFail('gd.site.core.js 未加载或缺少 encodeGameData/rankOf');
    return;
  }

  var TOTAL = 108;
  var MY_SEAT = 2;
  var LEVEL = 2;
  var MY_HAND_SIZE = 27;

  /* ---------- 1) raw 对局：2 号位（我）持 id 1..27，其余三家各 27 张，轮到我领出 ---------- */
  var cardPositionList = [];
  for (var i = 1; i <= TOTAL; i++) {
    cardPositionList.push(i <= 27 ? 2 : (i <= 54 ? 3 : (i <= 81 ? 4 : 1)));
  }
  var raw = {
    rule: 2,                    // 掼蛋
    state: 1,                   // 出牌阶段
    landlordId: 0,
    v: 1,
    cardPositionList: cardPositionList,   // 下标 0 对应牌 id 1
    playedCardList: [],
    lastRankList: [],           // 空 → 本局级牌 = team13Level = 2
    tributeCardList: [],
    returnCardList: [],
    playedTypeList: [],
    firstPlayer: MY_SEAT,
    team13Level: LEVEL,
    team24Level: LEVEL
  };
  var myHand = [];
  for (var id = 1; id <= MY_HAND_SIZE; id++) myHand.push(id);

  /* ---------- 2) 假站点 DOM：手牌 + 出牌/不出/确认进贡/确认还贡按钮 ---------- */
  var clicks = { play: 0, pass: 0, tribute: 0, returnCard: 0, cardSelect: 0, send: 0 };
  var cardClicks = {};
  var cardEls = {};

  var handEl = document.getElementById('fixture-hand');
  if (!handEl) { setupFail('缺少 #fixture-hand 容器'); return; }

  var cardStyle = 'display:inline-block;width:34px;height:46px;line-height:46px;text-align:center;' +
    'border:1px solid #999;border-radius:4px;margin:2px;font:11px/46px sans-serif;' +
    'cursor:pointer;background:#fff;vertical-align:top;';

  myHand.forEach(function (cardId) {
    var el = document.createElement('div');
    el.id = String(cardId);
    el.className = 'ddz-poker ddz-my-poker';
    el.textContent = G.cardText(cardId);
    el.style.cssText = cardStyle;
    el.addEventListener('click', function () {
      var selected = String(el.style.filter || '').indexOf('brightness') >= 0;
      if (selected) {
        el.style.filter = '';
      } else {
        el.style.filter = 'brightness(0.8)';   // 与真实站点「选中变暗」约定一致，body.isCardSelected 依赖它
        clicks.cardSelect += 1;
        cardClicks[cardId] = (cardClicks[cardId] || 0) + 1;
      }
    });
    handEl.appendChild(el);
    cardEls[cardId] = el;
  });

  var buttonIds = {
    'fixture-btn-play': 'play',
    'fixture-btn-pass': 'pass',
    'fixture-btn-tribute': 'tribute',
    'fixture-btn-return': 'returnCard'
  };
  Object.keys(buttonIds).forEach(function (btnId) {
    var b = document.getElementById(btnId);
    if (!b) { setupFail('缺少按钮 #' + btnId); return; }
    b.addEventListener('click', function () { clicks[buttonIds[btnId]] += 1; });
  });

  /* ---------- 3) 假 fiber 链：牌元素 → 牌桌 props（room/game/send） ---------- */
  var props = {
    room: {
      position: MY_SEAT,
      owner: 0,
      playerList: [
        { position: 1, name: '玩家1' },
        { position: 2, name: '玩家2' },
        { position: 3, name: '玩家3' },
        { position: 4, name: '玩家4' }
      ]
    },
    game: { data: G.encodeGameData(raw) },
    send: function () { clicks.send += 1; }
  };
  var tableFiber = { memoizedProps: props, return: null };
  myHand.forEach(function (cardId) {
    cardEls[cardId].__reactFiber$fixture = {
      memoizedProps: { id: cardId, card: cardId },
      return: tableFiber
    };
  });

  /* ---------- 4) 离线 fetch 桩 + 错误收集 ---------- */
  var fetchCalls = 0;
  var fetchUrls = [];
  window.fetch = function (url) {
    fetchCalls += 1;
    fetchUrls.push(String(url));
    return Promise.reject(new Error('fixture：离线验收环境不联网（mock fetch reject）'));
  };

  var errors = window.__fixtureErrors = [];
  window.addEventListener('error', function (e) {
    errors.push('error: ' + ((e && (e.message || e.type)) || 'unknown'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    errors.push('unhandledrejection: ' + ((r && (r.message || r)) || 'unknown'));
  });
  if (window.console && typeof console.error === 'function') {
    var origError = console.error;
    console.error = function () {
      errors.push('console.error: ' + Array.prototype.slice.call(arguments).join(' '));
      origError.apply(console, arguments);
    };
  }

  var localStorageOk = false;
  try {
    window.localStorage.setItem('__fixtureProbe', '1');
    localStorageOk = window.localStorage.getItem('__fixtureProbe') === '1';
    window.localStorage.removeItem('__fixtureProbe');
  } catch (e) {
    localStorageOk = false;
  }

  /* ---------- 暴露给 _fixture.test.js ---------- */
  window.__fixture = {
    raw: raw,
    myHand: myHand,
    mySeat: MY_SEAT,
    level: LEVEL,
    props: props,
    clicks: clicks,
    cardClicks: cardClicks,
    cardEls: cardEls,
    localStorageOk: localStorageOk,
    setupErrors: setupErrors,
    fetch: function () { return { calls: fetchCalls, urls: fetchUrls.slice() }; },
    errors: errors
  };
})();
