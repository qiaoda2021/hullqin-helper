/*!
 * gd.deepseek.test.js — gd.deepseek.js 单元测试
 * 全部使用 mock fetchImpl，禁止真实联网。
 * 运行：node gd.deepseek.test.js（工作目录 hullqin掼蛋/）
 */
'use strict';

const GDDeepSeek = require('./gd.deepseek.js');

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
  ok(
    actual === expected,
    msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）'
  );
}

function includes(haystack, needle, msg) {
  ok(
    typeof haystack === 'string' && haystack.indexOf(needle) >= 0,
    msg + '（未找到 ' + JSON.stringify(needle) + '）'
  );
}

function notIncludes(haystack, needle, msg) {
  ok(
    typeof haystack === 'string' && haystack.indexOf(needle) < 0,
    msg + '（不应包含 ' + JSON.stringify(needle) + '）'
  );
}

/* ---------------- mock 工具 ---------------- */

function captureFetch(responder) {
  const calls = [];
  const fn = function (url, init) {
    calls.push({ url: url, init: init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function responseOf(payload, status) {
  const code = status === undefined ? 200 : status;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: function () { return Promise.resolve(payload); },
    text: function () { return Promise.resolve(text); }
  };
}

function chatPayload(content) {
  return {
    choices: [{ message: { role: 'assistant', content: content } }],
    model: 'deepseek-chat',
    usage: { prompt_tokens: 800, completion_tokens: 20, total_tokens: 820 }
  };
}

function okChatFetch(content) {
  return captureFetch(function () {
    return Promise.resolve(responseOf(chatPayload(content)));
  });
}

function httpErrorFetch(status, body) {
  return captureFetch(function () {
    return Promise.resolve(responseOf(body === undefined ? { error: { message: 'mock error' } } : body, status));
  });
}

function networkErrorFetch(message) {
  return captureFetch(function () {
    return Promise.reject(new Error(message));
  });
}

/** 模拟真实 fetch 的超时：不主动 resolve，只在 signal abort 时 reject(AbortError) */
function abortableFetch() {
  return captureFetch(function (url, init) {
    return new Promise(function (resolve, reject) {
      const signal = init && init.signal;
      if (!signal) return; // 永不 settle，但 callAPI 的 Promise.race 超时仍会兜底
      const onAbort = function () {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
      else setTimeout(onAbort, 5);
    });
  });
}

/* ---------------- 测试数据 ---------------- */

function sampleRequest() {
  return {
    level: 5,
    levelText: '5',
    wildText: '红桃5',
    mySeatName: '我',
    partnerSeatName: '对家',
    hand: ['♠A', '♥5', '♣K', '♦10', '小王'],
    lastPlay: { seatName: '上家', name: '对子', size: 2, bomb: 0, cards: ['♠Q', '♥Q'] },
    history: [
      { seatName: '我', action: '出牌', name: '单张', cards: ['♠3'] },
      { seatName: '下家', action: '过', name: '', cards: [] }
    ],
    seats: [
      { name: '我', count: 5 },
      { name: '下家', count: 26 },
      { name: '对家', count: 27 },
      { name: '上家', count: 25 }
    ],
    remaining: [
      { rankText: '2', count: 6 },
      { rankText: 'K', count: 2 },
      { rankText: '小王', count: 1 }
    ],
    candidates: [
      { index: 0, typeName: '单张', size: 1, bomb: 0, cards: ['♠A'], note: '' },
      { index: 1, typeName: '对子', size: 2, bomb: 0, cards: ['♣K', '♦K'], note: '压上家对子' }
    ],
    localSuggestion: { action: 'play', typeName: '单张', cards: ['♠A'], reason: '先走小牌' }
  };
}

function decisionRequest() {
  return {
    level: 5,
    levelText: '5',
    wildText: '红桃5',
    mySeatName: '我',
    partnerSeatName: '对家',
    hand: ['♠K', '♥K', '♠A'],
    lastPlay: { seatName: '上家', name: '对子', size: 2, bomb: 0, cards: ['♠Q', '♥Q'] },
    history: [{ seatName: '上家', action: '出牌', name: '对子', cards: ['♠Q', '♥Q'] }],
    seats: [
      { name: '我', count: 3 },
      { name: '下家', count: 10 },
      { name: '对家', count: 12 },
      { name: '上家', count: 8 }
    ],
    remaining: [{ rankText: 'Q', count: 2 }],
    candidates: [
      {
        index: 0,
        typeName: '单张',
        size: 1,
        bomb: 0,
        cards: ['♠A'],
        note: '',
        play: { type: 'single', name: '单张', cards: [5], size: 1, rank: 14, order: 14, bomb: 0, level: 5, wilds: [], desc: '单张 ♠A' }
      },
      {
        index: 1,
        typeName: '对子',
        size: 2,
        bomb: 0,
        cards: ['♠K', '♥K'],
        note: '压上家对子',
        play: { type: 'pair', name: '对子', cards: [7, 8], size: 2, rank: 13, order: 13, bomb: 0, level: 5, wilds: [], desc: '对子 ♠K♥K' }
      }
    ],
    localSuggestion: { action: 'play', typeName: '对子', cards: ['♠K', '♥K'], reason: '本地建议出对子' }
  };
}

function localPlaySuggestion() {
  return {
    action: 'play',
    play: { type: 'pair', name: '对子', cards: [7, 8], size: 2, rank: 13, order: 13, bomb: 0, level: 5, wilds: [], desc: '对子 ♠K♥K' },
    reason: '本地建议出对子'
  };
}

/* ---------------- 主测试 ---------------- */

(async function main() {

  /* ========== 1. 模块导出 ========== */
  ok(GDDeepSeek && typeof GDDeepSeek === 'object', '模块导出为对象（UMD / module.exports）');
  ok(!!GDDeepSeek.DEFAULTS && typeof GDDeepSeek.DEFAULTS === 'object', 'DEFAULTS 存在');
  eq(GDDeepSeek.DEFAULTS.baseUrl, 'https://api.deepseek.com', 'DEFAULTS.baseUrl 正确');
  eq(GDDeepSeek.DEFAULTS.model, 'deepseek-chat', 'DEFAULTS.model 正确');
  eq(GDDeepSeek.DEFAULTS.temperature, 0.2, 'DEFAULTS.temperature 正确');
  eq(GDDeepSeek.DEFAULTS.maxTokens, 512, 'DEFAULTS.maxTokens 正确');
  eq(GDDeepSeek.DEFAULTS.timeoutMs, 30000, 'DEFAULTS.timeoutMs 正确');
  ['normalizeConfig', 'buildMessages', 'callAPI', 'parseDecision', 'decide', 'testConnection'].forEach(function (name) {
    eq(typeof GDDeepSeek[name], 'function', '导出函数 ' + name);
  });

  /* ========== 2. normalizeConfig ========== */
  const cfg1 = GDDeepSeek.normalizeConfig({
    apiKey: '  sk-test1234  ',
    baseUrl: ' https://api.deepseek.com/// ',
    model: ' deepseek-reasoner ',
    temperature: '0.7',
    maxTokens: '1024',
    timeoutMs: '15000'
  });
  eq(cfg1.apiKey, 'sk-test1234', 'normalizeConfig 去除 apiKey 首尾空格');
  eq(cfg1.baseUrl, 'https://api.deepseek.com', 'normalizeConfig 去除 baseUrl 尾部斜杠');
  eq(cfg1.model, 'deepseek-reasoner', 'normalizeConfig 保留自定义 model');
  eq(cfg1.temperature, 0.7, 'normalizeConfig 支持字符串温度');
  eq(cfg1.maxTokens, 1024, 'normalizeConfig 支持字符串 maxTokens');
  eq(cfg1.timeoutMs, 15000, 'normalizeConfig 支持字符串 timeoutMs');
  eq(Object.keys(cfg1).sort().join(','), 'apiKey,baseUrl,maxTokens,model,temperature,timeoutMs', 'normalizeConfig 返回 6 个约定字段');

  const cfg2 = GDDeepSeek.normalizeConfig({});
  eq(cfg2.apiKey, '', '空配置 apiKey 为空字符串（视为未配置）');
  eq(cfg2.baseUrl, GDDeepSeek.DEFAULTS.baseUrl, '空配置 baseUrl 回退默认值');
  eq(cfg2.model, GDDeepSeek.DEFAULTS.model, '空配置 model 回退默认值');
  eq(cfg2.temperature, 0.2, '空配置 temperature 回退默认值');
  eq(cfg2.maxTokens, 512, '空配置 maxTokens 回退默认值');
  eq(cfg2.timeoutMs, 30000, '空配置 timeoutMs 回退默认值');

  const cfg3 = GDDeepSeek.normalizeConfig(null);
  eq(cfg3.apiKey, '', 'null 设置不报错，apiKey 为空');
  eq(cfg3.baseUrl, 'https://api.deepseek.com', 'null 设置 baseUrl 回退默认值');

  const cfg4 = GDDeepSeek.normalizeConfig({ baseUrl: 'api.example.com/v1/', temperature: 'abc', maxTokens: -5, timeoutMs: 0 });
  eq(cfg4.baseUrl, 'https://api.example.com/v1', 'baseUrl 缺少协议时自动补 https:// 并去尾斜杠');
  eq(cfg4.temperature, 0.2, '非法 temperature 回退默认值');
  eq(cfg4.maxTokens, 512, '非法 maxTokens（负数）回退默认值');
  eq(cfg4.timeoutMs, 30000, '非法 timeoutMs（0）回退默认值');

  const cfg5 = GDDeepSeek.normalizeConfig({ temperature: 5 });
  eq(cfg5.temperature, 2, 'temperature 超上限被截断到 2');

  /* ========== 3. buildMessages ========== */
  const messages = GDDeepSeek.buildMessages(sampleRequest());
  eq(Array.isArray(messages), true, 'buildMessages 返回数组');
  eq(messages.length, 2, 'buildMessages 返回 2 条消息');
  eq(messages[0].role, 'system', '第 1 条是 system');
  eq(messages[1].role, 'user', '第 2 条是 user');

  const system = messages[0].content;
  const user = messages[1].content;
  includes(system, '掼蛋', 'system prompt 含“掼蛋”');
  includes(system, '牌型', 'system prompt 含牌型说明');
  includes(system, '大小顺序', 'system prompt 含大小顺序');
  includes(system, '级牌', 'system prompt 含级牌规则');
  includes(system, '逢人配', 'system prompt 含逢人配规则');
  includes(system, '同花顺', 'system prompt 含同花顺');
  includes(system, '炸弹', 'system prompt 含炸弹体系');
  includes(system, '队友', 'system prompt 含队友配合');
  includes(system, '领出', 'system prompt 含领出原则');
  includes(system, 'JSON', 'system prompt 含 JSON 输出契约');
  includes(system, 'choice', 'system prompt 含 choice 字段');
  includes(system, 'reason', 'system prompt 含 reason 字段');
  includes(system, '-1', 'system prompt 说明 -1 表示过');

  includes(user, '【当前局面】', 'user prompt 含局面');
  includes(user, '【我的手牌】', 'user prompt 含手牌区');
  includes(user, '♠A', 'user prompt 含手牌 ♠A');
  includes(user, '♥5', 'user prompt 含手牌 ♥5');
  includes(user, '【上一手】', 'user prompt 含上一手');
  includes(user, '上家', 'user prompt 含上一手座位名');
  includes(user, '♠Q', 'user prompt 含上一手牌面');
  includes(user, '【最近出牌历史】', 'user prompt 含历史');
  includes(user, '【各家剩余张数】', 'user prompt 含各家剩余');
  includes(user, '25 张', 'user prompt 含上家剩余张数');
  includes(user, '【记牌器剩余】', 'user prompt 含记牌器');
  includes(user, '2×6', 'user prompt 含记牌器剩余数量');
  includes(user, '【候选出牌】', 'user prompt 含候选列表');
  includes(user, '[0] 单张', '候选 0 带编号与牌型');
  includes(user, '[1] 对子', '候选 1 带编号与牌型');
  includes(user, '♣K', '候选列表含候选牌面');
  includes(user, '【本地引擎建议】', 'user prompt 含本地建议');
  includes(user, '先走小牌', 'user prompt 含本地建议理由');
  includes(user, '5', 'user prompt 含级牌数字');
  includes(user, '红桃5', 'user prompt 含逢人配文案');

  const edgeMessages = GDDeepSeek.buildMessages({});
  eq(edgeMessages.length, 2, 'buildMessages({}) 不抛错且返回 2 条消息');
  includes(edgeMessages[1].content, '无（本轮由我领出', '无 lastPlay 时说明由我领出');
  includes(edgeMessages[1].content, '只能选择过', '无候选时提示只能过');
  includes(edgeMessages[1].content, '本地引擎没有给出建议', '无本地建议时给出提示');

  const nullMessages = GDDeepSeek.buildMessages(null);
  eq(nullMessages.length, 2, 'buildMessages(null) 不抛错');
  includes(nullMessages[1].content, '【我的手牌】', 'buildMessages(null) 仍有手牌区');

  const noLocalRequest = sampleRequest();
  noLocalRequest.localSuggestion = null;
  noLocalRequest.lastPlay = null;
  const noLocalMessages = GDDeepSeek.buildMessages(noLocalRequest);
  includes(noLocalMessages[1].content, '本轮由我领出', 'lastPlay=null 时提示我领出');

  /* ========== 4. callAPI ========== */
  const callFetch = okChatFetch('{"choice":1,"reason":"压一手"}');
  const callMessages = [
    { role: 'system', content: 'test-system' },
    { role: 'user', content: 'test-user' }
  ];
  const callRes = await GDDeepSeek.callAPI({ apiKey: 'sk-test12345678', baseUrl: 'https://api.deepseek.com/' }, callMessages, callFetch);
  eq(callFetch.calls.length, 1, 'callAPI 只调用一次 fetchImpl');
  eq(callFetch.calls[0].url, 'https://api.deepseek.com/chat/completions', 'callAPI URL 正确（baseUrl 去尾斜杠 + /chat/completions）');
  eq(callFetch.calls[0].init.method, 'POST', 'callAPI 使用 POST');
  eq(callFetch.calls[0].init.headers.Authorization, 'Bearer sk-test12345678', 'Authorization 头正确');
  eq(callFetch.calls[0].init.headers['Content-Type'], 'application/json', 'Content-Type 头正确');
  const callBody = JSON.parse(callFetch.calls[0].init.body);
  eq(callBody.model, 'deepseek-chat', 'body.model 正确');
  eq(callBody.messages.length, 2, 'body.messages 正确传递');
  eq(callBody.messages[1].content, 'test-user', 'body.messages 内容正确');
  eq(callBody.temperature, 0.2, 'body.temperature 正确');
  eq(callBody.max_tokens, 512, 'body.max_tokens 正确');
  eq(callBody.response_format.type, 'json_object', 'body.response_format 为 json_object');
  eq(callBody.stream, false, 'body.stream 为 false');
  ok(callFetch.calls[0].init.signal !== undefined, 'callAPI 传入 AbortController signal');
  eq(callRes.content, '{"choice":1,"reason":"压一手"}', 'callAPI 返回 content');
  eq(callRes.model, 'deepseek-chat', 'callAPI 返回 model');
  ok(callRes.usage && callRes.usage.total_tokens === 820, 'callAPI 返回 usage');

  const customBaseFetch = okChatFetch('{"choice":-1}');
  await GDDeepSeek.callAPI({ apiKey: 'sk-x', baseUrl: 'https://example.com/v1/' }, callMessages, customBaseFetch);
  eq(customBaseFetch.calls[0].url, 'https://example.com/v1/chat/completions', '自定义 baseUrl 路径正确拼接');

  // 未配置 Key
  let err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: '' }, callMessages, okChatFetch('{}'));
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, '未配置 apiKey 时 callAPI 抛 Error');
  includes(err && err.message, 'API Key', '未配置 apiKey 的错误文案含「API Key」');

  // 401
  const key401 = 'sk-secret-abcdef123456';
  const f401 = httpErrorFetch(401, { error: { message: 'Authentication Fails: Invalid key ' + key401 } });
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: key401 }, callMessages, f401);
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, '401 时 callAPI 抛 Error');
  includes(err && err.message, 'Key 无效', '401 错误文案说明 Key 无效');
  includes(err && err.message, '401', '401 错误文案含状态码');
  notIncludes(err && err.message, key401, '401 错误文案不泄露完整 API Key');
  includes(err && err.message, 'sk-s****', '401 错误文案对 Key 打码（前 4 位 + ****）');

  // 429
  const f429 = httpErrorFetch(429, { error: { message: 'Rate limit reached' } });
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234' }, callMessages, f429);
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, '429 时 callAPI 抛 Error');
  includes(err && err.message, '429', '429 错误文案含状态码');
  includes(err && err.message, '频繁', '429 错误文案说明限流');

  // 5xx
  const f500 = httpErrorFetch(500, { error: { message: 'internal error' } });
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234' }, callMessages, f500);
  } catch (e) {
    err = e;
  }
  includes(err && err.message, '服务异常', '5xx 错误文案说明服务异常');

  // 超时
  const fTimeout = abortableFetch();
  const timeoutStart = Date.now();
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234', timeoutMs: 30 }, callMessages, fTimeout);
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, '超时后 callAPI 抛 Error（不挂起）');
  includes(err && err.message, '超时', '超时错误文案含「超时」');
  ok(Date.now() - timeoutStart < 2000, '超时逻辑及时返回（<2s）');

  // 网络错误
  const fNetwork = networkErrorFetch('fetch failed: getaddrinfo ENOTFOUND api.deepseek.com');
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234' }, callMessages, fNetwork);
  } catch (e) {
    err = e;
  }
  includes(err && err.message, '网络', '网络错误文案含「网络」');
  includes(err && err.message, 'ENOTFOUND', '网络错误文案保留底层原因');

  // 网络错误文案里带 Key 也要打码
  const keyLeak = 'sk-leak-zyxwvu987654';
  const fLeak = networkErrorFetch('boom key=' + keyLeak);
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: keyLeak }, callMessages, fLeak);
  } catch (e) {
    err = e;
  }
  notIncludes(err && err.message, keyLeak, '网络错误文案不泄露完整 API Key');
  includes(err && err.message, 'sk-l****', '网络错误文案对 Key 打码');

  // 返回非法 JSON
  const fBadJson = captureFetch(function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.reject(new Error('Unexpected token < in JSON')); },
      text: function () { return Promise.resolve('<html>error</html>'); }
    });
  });
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234' }, callMessages, fBadJson);
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, '返回非法 JSON 时 callAPI 抛 Error');
  includes(err && err.message, 'JSON', '非法 JSON 错误文案含「JSON」');

  // 返回空内容
  const fEmpty = captureFetch(function () {
    return Promise.resolve(responseOf({ choices: [{ message: { content: '   ' } }], model: 'deepseek-chat' }));
  });
  err = null;
  try {
    await GDDeepSeek.callAPI({ apiKey: 'sk-test1234' }, callMessages, fEmpty);
  } catch (e) {
    err = e;
  }
  includes(err && err.message, '返回内容为空', '空返回内容的错误文案正确');

  /* ========== 5. parseDecision ========== */
  const cands = [{ index: 0 }, { index: 1 }, { index: 2 }];

  let p = GDDeepSeek.parseDecision('{"choice": 1, "reason": "出对子压牌"}', cands);
  eq(p.ok, true, 'parseDecision 标准 JSON 解析成功');
  eq(p.choice, 1, 'parseDecision choice 正确');
  eq(p.reason, '出对子压牌', 'parseDecision reason 正确');

  p = GDDeepSeek.parseDecision('```json\n{"choice": 0, "reason": "先走小牌"}\n```', cands);
  eq(p.ok, true, 'parseDecision 支持 ```json 围栏');
  eq(p.choice, 0, '围栏格式 choice 正确');
  eq(p.reason, '先走小牌', '围栏格式 reason 正确');

  p = GDDeepSeek.parseDecision('好的，我的建议如下：{"choice": 2, "reason": "用炸弹拦截"}。以上，请参考。', cands);
  eq(p.ok, true, 'parseDecision 支持前后废话');
  eq(p.choice, 2, '前后废话时 choice 正确');
  eq(p.reason, '用炸弹拦截', '前后废话时 reason 正确');

  p = GDDeepSeek.parseDecision('```json\n{\n  "choice": 1,\n  "reason": "压一手"\n}\n```\n希望有帮助', cands);
  eq(p.ok, true, 'parseDecision 支持围栏 + 尾部废话');

  p = GDDeepSeek.parseDecision('{“choice”：“0”，“reason”：“用对子压”}', cands);
  eq(p.ok, true, 'parseDecision 支持全角引号/冒号/逗号');
  eq(p.choice, 0, '全角格式 choice 解析正确');
  eq(p.reason, '用对子压', '全角格式 reason 解析正确');

  p = GDDeepSeek.parseDecision('{"choice": "2", "reason": "字符串编号"}', cands);
  eq(p.ok, true, 'parseDecision 支持 choice 为字符串数字');
  eq(p.choice, 2, '字符串 choice 转为数字 2');

  p = GDDeepSeek.parseDecision('{"choice": 0}', cands);
  eq(p.ok, true, 'parseDecision 容忍 reason 缺失');
  eq(p.choice, 0, 'reason 缺失时 choice 仍正确');
  eq(typeof p.reason, 'string', 'reason 缺失时返回空字符串（类型安全）');

  p = GDDeepSeek.parseDecision('{"choice": -1, "reason": "让队友走"}', cands);
  eq(p.ok, true, 'parseDecision 支持 -1（过）');
  eq(p.choice, -1, 'choice=-1 解析正确');
  eq(p.reason, '让队友走', '-1 时 reason 正确');

  p = GDDeepSeek.parseDecision('{"choice": 3, "reason": "越界"}', cands);
  eq(p.ok, false, 'parseDecision choice 越界时 ok:false');
  eq(p.choice, 3, '越界时仍返回解析到的 choice 便于排查');
  includes(p.error, '越界', '越界 error 文案含「越界」');

  p = GDDeepSeek.parseDecision('{"choice": -2}', cands);
  eq(p.ok, false, 'parseDecision 非法负数 choice 时 ok:false');

  p = GDDeepSeek.parseDecision('{"choice": 1.5}', cands);
  eq(p.ok, false, 'parseDecision 非整数 choice 时 ok:false');

  p = GDDeepSeek.parseDecision('抱歉，我无法判断这手牌。', cands);
  eq(p.ok, false, 'parseDecision 坏 JSON（无 JSON）时 ok:false');
  ok(typeof p.error === 'string' && p.error.length > 0, '解析失败时 error 非空');

  p = GDDeepSeek.parseDecision('', cands);
  eq(p.ok, false, 'parseDecision 空文本时 ok:false');

  p = GDDeepSeek.parseDecision(null, cands);
  eq(p.ok, false, 'parseDecision null 文本时 ok:false');

  p = GDDeepSeek.parseDecision('[0, 1, 2]', cands);
  eq(p.ok, false, 'parseDecision 返回数组（非对象）时 ok:false');

  p = GDDeepSeek.parseDecision('{"reason": "缺少 choice"}', cands);
  eq(p.ok, false, 'parseDecision 缺少 choice 字段时 ok:false');

  p = GDDeepSeek.parseDecision('{"choice": 0, "reason": "但没有候选"}', []);
  eq(p.ok, false, 'parseDecision 选择了出牌但没有候选时 ok:false');

  p = GDDeepSeek.parseDecision('{"choice": -1, "reason": "过"}', []);
  eq(p.ok, true, 'parseDecision 无候选时仍允许 -1');

  p = GDDeepSeek.parseDecision('{"choice": "1"} 补充说明 {"foo": 1}', cands);
  eq(p.ok, true, 'parseDecision 容忍 JSON 后的额外内容');
  eq(p.choice, 1, 'JSON 后额外内容时 choice 正确');

  /* ========== 6. decide：成功路径 ========== */
  const req6 = decisionRequest();
  const f6 = okChatFetch('{"choice": 1, "reason": "用对子压上家"}');
  const d6 = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, { fetchImpl: f6, localSuggestion: localPlaySuggestion() });
  eq(d6.source, 'deepseek', 'decide 成功时 source=deepseek');
  eq(d6.action, 'play', 'decide 成功选择候选时 action=play');
  ok(d6.play && typeof d6.play === 'object', 'decide 成功时返回 Play 对象');
  eq(d6.play && d6.play.type, 'pair', 'decide 返回选中候选的 Play（对子）');
  eq(d6.play && d6.play.cards.join(','), '7,8', 'decide 返回的 Play 牌 id 正确');
  eq(d6.reason, '用对子压上家', 'decide 成功时使用模型理由');
  ok(typeof d6.raw === 'string' && d6.raw.indexOf('choice') >= 0, 'decide 成功时返回 raw 原始内容');
  eq(d6.error, undefined, 'decide 成功时没有 error 字段');
  eq(f6.calls.length, 1, 'decide 成功时调用了一次 API');
  const d6Body = JSON.parse(f6.calls[0].init.body);
  includes(d6Body.messages[0].content, '掼蛋', 'decide 发送的 system prompt 含掼蛋规则');
  includes(d6Body.messages[1].content, '♠K', 'decide 发送的 user prompt 含我的手牌');
  includes(d6Body.messages[1].content, '[1] 对子', 'decide 发送的 user prompt 含带编号候选');
  eq(f6.calls[0].init.headers.Authorization, 'Bearer sk-test1234', 'decide 调用携带正确 Authorization');

  const f6b = okChatFetch('{"choice": 0, "reason": "先出 A"}');
  const d6b = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, { fetchImpl: f6b, localSuggestion: localPlaySuggestion() });
  eq(d6b.source, 'deepseek', 'decide 选择候选 0 时 source=deepseek');
  eq(d6b.play && d6b.play.type, 'single', 'decide 选择候选 0 返回单张 Play');

  // 成功选择 -1 -> pass
  const f7 = okChatFetch('{"choice": -1, "reason": "让队友走"}');
  const d7 = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, { fetchImpl: f7, localSuggestion: localPlaySuggestion() });
  eq(d7.source, 'deepseek', 'decide 选择 -1 时 source=deepseek');
  eq(d7.action, 'pass', 'decide 选择 -1 时 action=pass');
  eq(d7.play, null, 'decide 选择 -1 时 play=null');
  eq(d7.reason, '让队友走', 'decide 选择 -1 时使用模型理由');
  ok(typeof d7.raw === 'string', 'decide 选择 -1 时返回 raw');

  // 候选没有 play 字段时，仍返回 action=play，play 允许为 null
  const reqNoPlay = decisionRequest();
  reqNoPlay.candidates = [{ index: 0, typeName: '单张', size: 1, bomb: 0, cards: ['♠A'], note: '' }];
  const fNoPlay = okChatFetch('{"choice": 0, "reason": "出 A"}');
  const dNoPlay = await GDDeepSeek.decide(reqNoPlay, { apiKey: 'sk-test1234' }, { fetchImpl: fNoPlay });
  eq(dNoPlay.source, 'deepseek', '候选缺少 play 字段时仍为 deepseek');
  eq(dNoPlay.action, 'play', '候选缺少 play 字段时 action=play');
  eq(dNoPlay.play, null, '候选缺少 play 字段时 play=null（由 UI 自行映射）');

  /* ========== 7. decide：回退路径（绝不 throw） ========== */
  // 未配置 Key
  const dNoKey = await GDDeepSeek.decide(req6, { apiKey: '' }, { localSuggestion: localPlaySuggestion() });
  eq(dNoKey.source, 'local', '无 API Key 时回退 source=local');
  eq(dNoKey.action, 'play', '回退时 action 取自 localSuggestion');
  ok(dNoKey.play && dNoKey.play.type === 'pair', '回退时 play 取自 localSuggestion');
  eq(dNoKey.reason, '本地建议出对子', '回退时 reason 取自 localSuggestion');
  includes(dNoKey.error, 'API Key', '回退时 error 说明未配置 Key');

  // 401
  const d401 = await GDDeepSeek.decide(req6, { apiKey: 'sk-bad-111122223333' }, {
    fetchImpl: httpErrorFetch(401, { error: { message: 'invalid key' } }),
    localSuggestion: localPlaySuggestion()
  });
  eq(d401.source, 'local', '401 时回退 source=local');
  eq(d401.action, 'play', '401 回退时 action 来自本地建议');
  includes(d401.error, 'Key 无效', '401 回退时 error 说明 Key 无效');

  // 429
  const d429 = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
    fetchImpl: httpErrorFetch(429, { error: { message: 'rate limited' } }),
    localSuggestion: localPlaySuggestion()
  });
  eq(d429.source, 'local', '429 时回退 source=local');
  includes(d429.error, '限流', '429 回退时 error 说明限流');

  // 超时
  const dTimeout = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234', timeoutMs: 30 }, {
    fetchImpl: abortableFetch(),
    localSuggestion: localPlaySuggestion()
  });
  eq(dTimeout.source, 'local', '超时时回退 source=local');
  includes(dTimeout.error, '超时', '超时回退时 error 说明超时');
  eq(dTimeout.action, 'play', '超时回退时 action 来自本地建议');

  // 坏 JSON 返回
  const dBad = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
    fetchImpl: okChatFetch('这不是 JSON，我不知道怎么出。'),
    localSuggestion: localPlaySuggestion()
  });
  eq(dBad.source, 'local', '模型返回非 JSON 时回退 source=local');
  includes(dBad.error, '解析', '解析失败回退时 error 说明解析失败');

  // choice 越界
  const dOut = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
    fetchImpl: okChatFetch('{"choice": 9, "reason": "乱来"}'),
    localSuggestion: localPlaySuggestion()
  });
  eq(dOut.source, 'local', 'choice 越界时回退 source=local');
  includes(dOut.error, '越界', 'choice 越界回退时 error 说明越界');

  // 网络错误
  const dNet = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
    fetchImpl: networkErrorFetch('fetch failed'),
    localSuggestion: localPlaySuggestion()
  });
  eq(dNet.source, 'local', '网络错误时回退 source=local');
  includes(dNet.error, '网络', '网络错误回退时 error 说明网络问题');

  // fetchImpl 同步抛错也不允许 throw
  let decideThrew = false;
  let dSync = null;
  try {
    dSync = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
      fetchImpl: function () { throw new Error('同步爆炸'); },
      localSuggestion: localPlaySuggestion()
    });
  } catch (e) {
    decideThrew = true;
  }
  eq(decideThrew, false, 'decide 遇到同步异常也不会 throw');
  eq(dSync && dSync.source, 'local', 'decide 同步异常时回退 local');

  // 没有 localSuggestion -> 安全默认（不出）
  const fNoLocal = okChatFetch('{"choice": 1}');
  const dNoLocal = await GDDeepSeek.decide(req6, { apiKey: '' }, { fetchImpl: fNoLocal });
  eq(dNoLocal.source, 'local', '无本地建议时 source=local');
  eq(dNoLocal.action, 'pass', '无本地建议时安全默认 action=pass');
  eq(dNoLocal.play, null, '无本地建议时安全默认 play=null');
  eq(dNoLocal.reason, '本地建议不可用', '无本地建议时 reason=「本地建议不可用」');
  ok(typeof dNoLocal.error === 'string' && dNoLocal.error.length > 0, '无本地建议时仍有 error 说明');

  // localSuggestion 为 pass -> 回退 pass
  const dLocalPass = await GDDeepSeek.decide(req6, { apiKey: '' }, {
    localSuggestion: { action: 'pass', play: null, reason: '队友最大，让过' }
  });
  eq(dLocalPass.action, 'pass', '回退时尊重 localSuggestion 的 pass');
  eq(dLocalPass.play, null, '回退 pass 时 play=null');
  eq(dLocalPass.reason, '队友最大，让过', '回退 pass 时 reason 来自本地建议');

  // request 为 null 也不能 throw
  let dNullRequest = null;
  let nullReqThrew = false;
  try {
    dNullRequest = await GDDeepSeek.decide(null, { apiKey: 'sk-test1234' }, {
      fetchImpl: okChatFetch('{"choice": 0}'),
      localSuggestion: localPlaySuggestion()
    });
  } catch (e) {
    nullReqThrew = true;
  }
  eq(nullReqThrew, false, 'decide(request=null) 不 throw');
  eq(dNullRequest && dNullRequest.source, 'local', 'decide(request=null) 回退 local');

  // 越界 choice 但本地建议是 pass 时，回退 pass
  const dOutPass = await GDDeepSeek.decide(req6, { apiKey: 'sk-test1234' }, {
    fetchImpl: okChatFetch('{"choice": 8}'),
    localSuggestion: { action: 'pass', play: null, reason: '本地不出' }
  });
  eq(dOutPass.action, 'pass', '越界回退时尊重本地 pass 建议');

  /* ========== 8. testConnection ========== */
  const pingFetch = okChatFetch('{"ok": true}');
  const tc = await GDDeepSeek.testConnection({ apiKey: 'sk-test1234' }, pingFetch);
  eq(tc.ok, true, 'testConnection 成功时 ok:true');
  includes(tc.message, '连接成功', 'testConnection 成功文案含「连接成功」');
  eq(tc.model, 'deepseek-chat', 'testConnection 返回 model');
  eq(pingFetch.calls.length, 1, 'testConnection 发起了一次请求');
  eq(pingFetch.calls[0].url, 'https://api.deepseek.com/chat/completions', 'testConnection URL 正确');
  const pingBody = JSON.parse(pingFetch.calls[0].init.body);
  eq(pingBody.response_format.type, 'json_object', 'testConnection 同样使用 json_object');
  includes(pingBody.messages[0].content + pingBody.messages[1].content, 'JSON', 'testConnection prompt 提示输出 JSON');

  let pingCalled = false;
  const tcNoKey = await GDDeepSeek.testConnection({ apiKey: '' }, function () {
    pingCalled = true;
    return Promise.resolve(responseOf(chatPayload('{"ok":true}')));
  });
  eq(tcNoKey.ok, false, 'testConnection 无 Key 时 ok:false');
  includes(tcNoKey.message, 'API Key', 'testConnection 无 Key 时提示配置 Key');
  eq(pingCalled, false, 'testConnection 无 Key 时不发起请求');

  const tc401 = await GDDeepSeek.testConnection({ apiKey: 'sk-bad-key-9999' }, httpErrorFetch(401, { error: { message: 'invalid key' } }));
  eq(tc401.ok, false, 'testConnection 401 时 ok:false');
  includes(tc401.message, 'Key 无效', 'testConnection 401 的 message 说明 Key 无效');

  const tcNet = await GDDeepSeek.testConnection({ apiKey: 'sk-test1234' }, networkErrorFetch('fetch failed'));
  eq(tcNet.ok, false, 'testConnection 网络错误时 ok:false');
  includes(tcNet.message, '网络', 'testConnection 网络错误 message 含「网络」');
  notIncludes(tcNet.message, 'sk-test1234', 'testConnection 错误信息不泄露完整 Key');

  const tcTimeout = await GDDeepSeek.testConnection({ apiKey: 'sk-test1234', timeoutMs: 30 }, abortableFetch());
  eq(tcTimeout.ok, false, 'testConnection 超时时 ok:false');
  includes(tcTimeout.message, '超时', 'testConnection 超时 message 含「超时」');

  // testConnection 永不 throw
  let tcThrew = false;
  let tcNull = null;
  try {
    tcNull = await GDDeepSeek.testConnection(null, null);
  } catch (e) {
    tcThrew = true;
  }
  eq(tcThrew, false, 'testConnection(null) 不 throw');
  eq(tcNull && tcNull.ok, false, 'testConnection(null) 返回 ok:false');

  /* ========== 汇总 ========== */
  console.log('');
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  process.exitCode = failed ? 1 : 0;
})().catch(function (err) {
  failed++;
  console.log('✗ 测试运行异常：' + (err && err.stack ? err.stack : err));
  console.log('');
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  process.exitCode = 1;
});
