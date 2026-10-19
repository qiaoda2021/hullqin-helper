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
