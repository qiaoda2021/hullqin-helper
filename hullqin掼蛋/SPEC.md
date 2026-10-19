# 掼蛋 AI 助手 · 设计规范（开发用）

> 本文件是 `hullqin掼蛋/` 所有模块唯一的接口契约。所有实现必须严格按本文件命名/签名/返回结构，
> 这样 `gd.core.js` / `gd.ai.js` / `gd.deepseek.js` / `app.js` 才能互相对接。
> 交付形态：**可离线打开的独立网页工具**（`index.html`），不是挂在某个游戏页上的油猴脚本。

## 0. 文件清单与归属

| 文件 | 内容 | 归属 |
|---|---|---|
| `SPEC.md` | 本规范 | Lead |
| `gd.core.js` | 掼蛋规则引擎：卡片模型、牌型解析、大小比较、合法出牌生成、记牌器、发牌 | Lead |
| `gd.ai.js` | 本地启发式 AI（压牌/领出/配合/炸弹时机） | Lead |
| `gd.deepseek.js` | DeepSeek API 接入：prompt 构造、调用、响应解析、失败回退本地建议 | deepseek-dev |
| `gd.core.test.js` | 引擎单测 | Lead |
| `gd.ai.test.js` | AI 单测 | Lead |
| `gd.deepseek.test.js` | DeepSeek 模块单测（mock fetch，**禁止真实联网**） | deepseek-dev |
| `gd.verify.test.js` | 独立黑盒验收测试（只看 SPEC 不抄实现） | verifier |
| `gd.test.js` | 聚合入口：require 以上所有 test 文件 | Lead |
| `index.html` `app.js` `style.css` | 网页界面（记牌器 + 手牌 + 出牌记录 + AI 建议 + 设置） | ui-dev |
| `README.md` | 中文使用/开发文档 | Lead |

所有 `.js` 采用 **自包含 UMD** 包装（浏览器挂全局、Node 走 `module.exports`），与 `hullqin斗地主/ddz.core.js` 一致：

```js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDEngine = api;
})(typeof self !== 'undefined' ? self : this, function () { 'use strict'; /* ... */ return api; });
```

浏览器里不出现 `require`；`index.html` 用普通 `<script src>` 顺序加载 `gd.core.js` → `gd.ai.js` → `gd.deepseek.js` → `app.js`（不用 ES module，保证 `file://` 双击可开）。

## 1. 卡片模型

- 两副牌共 **108 张**，id 取 `1..108`：`deck = Math.floor((id-1)/54)`（0 或 1），
  `local = (id-1)%54 + 1`。
- `local 1..52`：`suit = Math.floor((local-1)/13)`，花色顺序 `0=♠ 1=♥ 2=♣ 3=♦`；
  `idx = (local-1)%13`，点数映射：`idx 0 = A(14)，idx 1..12 = 2..13(K)`。
  即 local 1=♠A, 2=♠2, ..., 13=♠K, 14=♥A, 15=♥2, ..., 26=♥K, 27..39=♣, 40..52=♦。
- `local 53 = 小王`（rank 16），`local 54 = 大王`（rank 17）。
- 红桃级牌（逢人配）id：level=L（2..14）时 `idx = (L===14 ? 0 : L-1)`，
  deck0 的 id = `14+idx`，deck1 的 id = `68+idx`。例：级牌 5 → id 18、72；级牌 A → id 14、68。
- **自然点数 rank**：2..14（14=A）、16=小王、17=大王。
- **大小顺序（级牌制）**：大王17 > 小王16 > **级牌15** > A14 > K13 > ... > 2。
  函数 `levelOrder(rank, level)`：`rank===17→17；rank===16→16；rank===level→15；否则 rank`。
- 顺子/同花顺/三连对/钢板里 A 可当 1 用；级牌在这些连牌里按自然点数参与。
- 顺子窗口（5 连）：连牌序号 pos 1..14（1=A, 2=2, ..., 13=K, 14=A），窗口起点 1..10，
  即 A2345 ... 10JQKA。`pos→自然 rank`：`pos===1 ? 14 : pos`，**牌型 rank = 窗口顶位的自然 rank**。
- 三连对窗口（3 连对）：起点 1..12（A23 对 ... QKA 对）。
- 钢板窗口（2 连三张）：起点 1..13（A2 ... KA）。
- 王：小王 rank16、大王 rank17；王不能参与顺子/连对/钢板/三张；对子允许「两张大王」「两张小王」，混搭无效。

## 2. 牌型与规则（本引擎采用的口径）

牌型 type 字符串与中文名：

| type | 名称 | size | 说明 |
|---|---|---|---|
| `single` | 单张 | 1 | |
| `pair` | 对子 | 2 | 含两张大王/两张小王 |
| `triple` | 三同张 | 3 | 三不带 |
| `fullhouse` | 三带二 | 5 | 三张+对子（对子允许是两张王；但逢人配不能当王） |
| `straight` | 顺子 | 5 | 5 连单张，A 可作 1 或 14 |
| `tube` | 三连对 | 6 | 3 个连续对子 |
| `plate` | 钢板 | 6 | 2 个连续三张 |
| `bomb` | 炸弹 | 4..10 | 4 张及以上同点数 |
| `straightflush` | 同花顺 | 5 | 同花色顺子，属炸弹 |
| `jokerbomb` | 四大天王 | 4 | 2 大王 + 2 小王，最大 |

**逢人配（红桃级牌）规则**

- 红桃级牌可在多张牌组合中当任意**非王**的牌（任意点数、任意花色）使用；不能当王。
- 单出红桃级牌时只能算「级牌单张」。
- 多张牌有多种配法时默认取**最大牌型/最大点数**（如级牌 5：♥5+6+7+8+9 默认配成 6-10 顺子）。
  引擎 `parseCards` 只返回「每种牌型下最强的那一种解读」，另提供 `parseAll` 返回全部解读供 UI 选。
- 炸弹可由逢人配补足：如 3+3+♥5+♥5（级牌 5）= 3333；同点数最多 10 张炸弹。

**炸弹体系（`bomb` 字段，0 表示非炸弹）**

```
4炸=4, 5炸=5, 同花顺=5.5, 6炸=6, 7炸=7, 8炸=8, 9炸=9, 10炸=10, 四大天王=99
```
- `bomb > 0` 的牌型可压任何非炸弹；非炸弹不能压炸弹。
- 两个炸弹：先比 `bomb` 大小，相同再比 `order`（自然 rank 的 `levelOrder`；同花顺比顶位 natural rank 的 levelOrder；四大天王 order=0）。
- 级牌组成的炸弹，在同张数炸弹里最大（order=15）。
- 非炸弹只能「同 type 同 size 且 order 更大」才能压。

**其他约定**

- 三带二只比三张的点数（order）。
- 同花顺同时也可以作为「顺子」出（`parseAll` 会给出两种解读）；压牌逻辑按所选解读。
- 记牌器口径：`剩余 = 全副牌 − 我手 − 已出`（即其他玩家手里的未知牌）。

## 3. Play 对象（所有模块之间传递的出牌结构）

```js
{
  type: 'straight',            // 见上表
  name: '顺子',                // 中文名
  cards: [3,15,16,17,18],      // 实际使用的牌 id（升序即可，必须来自手牌/被记录的牌）
  size: 5,                     // 牌张数
  rank: 7,                     // 比较用「自然 rank」：单/对/三=该点数；三带二=三张点数；
                               // 顺子/三连对/钢板/同花顺=窗口顶位自然 rank（A 顶=14）
  order: 7,                    // levelOrder(rank, level)，比较时直接用
  bomb: 0,                     // 0 非炸弹；4..10 炸弹张数；5.5 同花顺；99 四大天王
  level: 5,                    // 解析时的级牌（便于 UI 展示与调试）
  wilds: [],                   // 逢人配使用说明：[{card:18, asRank:6, asSuit:0}]
  desc: '顺子 ♠3♠4♥5♠6♠7'     // 人类可读文案（含配牌说明，如「（♥5配♠9）」）
}
```

`pass` 不生成 Play 对象，由 `action:'pass'` 表达。

## 4. `gd.core.js`（全局 `GDEngine`）API

```js
GDEngine = {
  VERSION: '1.0.0',
  SUITS: [{key:'S',sym:'♠'},{key:'H',sym:'♥'},{key:'C',sym:'♣'},{key:'D',sym:'♦'}],
  JOKER_SMALL: 16, JOKER_BIG: 17,
  TYPES: { single:{name:'单张',size:1}, pair:{name:'对子',size:2}, triple:{name:'三同张',size:3},
           fullhouse:{name:'三带二',size:5}, straight:{name:'顺子',size:5}, tube:{name:'三连对',size:6},
           plate:{name:'钢板',size:6}, bomb:{name:'炸弹',size:'n'}, straightflush:{name:'同花顺',size:5},
           jokerbomb:{name:'四大天王',size:4} },

  cardDeck(id) -> 0|1,
  cardLocal(id) -> 1..54,
  cardSuit(id) -> 0..3 | -1,           // 王返回 -1
  cardRank(id) -> 2..14|16|17,          // 自然 rank
  cardText(id) -> '♠A' | '小王' | '大王',
  cardTexts(ids) -> ['♠A', ...],
  isJoker(id) -> bool,
  isLevelCard(id, level) -> bool,
  isWild(id, level) -> bool,            // 红桃级牌
  heartLevelIds(level) -> [id, id],     // 两副牌的红桃级牌 id
  levelOrder(rank, level) -> number,    // 见上
  normalCounts() -> {2:8,3:8,...,14:8,16:2,17:2},

  sortCards(ids) -> ids,                // 展示排序：自然点数升序，王在最后（小王、大王）
  rankText(rank) -> '2'..'A'|'小王'|'大王',

  parseCards(cards, level) -> Play[],   // 每种可成立牌型给一个「最强解读」，按强度降序；无解 []
  parseAll(cards, level, opts) -> Play[], // 全部解读（去重后按强度降序，默认上限 48 个）
  parseAs(cards, level, type, rank?) -> Play|null, // 指定牌型解析；rank 省略=该牌型最强
  canBeat(prev, next) -> bool,          // prev 为 null 视为领出，返回 true
  comparePlays(a, b) -> number,         // >0 表示 a 压过 b
  playText(play) -> string,

  genMoves(hand, level, lastPlay, opts) -> Play[],
  // 合法候选出牌（不含过）。lastPlay 非空时只返回能压过它的牌（含炸弹/同花顺/天王炸）。
  // 覆盖要求：所有可成立的 (type, rank, size) 组合至少给一个代表；同 key 只保留一个代表。
  // opts: {limit?: number, includeBombs?: bool=true}
  // 代表牌的挑选要尽量不破坏手牌结构（不拆炸弹/连牌优先），但合法性 > 美观。

  counter({level, myHand, played}) -> {
    byRank: [{rank, text, total, played, mine, remaining, isLevel, isWild}], // rank 顺序 2..14,16,17
    wildRemaining: number,        // 2 − 我手/已出中的红桃级牌数
    total: 108, playedCount, mineCount, unknown,   // unknown = 108 - mine - playedCount
    ok: boolean, warnings: string[]   // 同一张牌同时出现在 myHand/played、张数超上限等
  },

  createRng(seed) -> () => 0..1,        // mulberry32，确定性
  deal(seed) -> { hands: [number[], number[], number[], number[]], seed }, // 4×27 张
}
```

实现细节要求：

- `parseCards`/`parseAll`/`parseAs` 必须能处理 0/1/2 张逢人配、A 作 1、级牌参与连牌、王对子、同花顺等。
- `genMoves` 内部用 `parseAs(cards, level, type, rank)` 自检合法性；宁可少给也不能给非法牌。
- 纯函数、不依赖 DOM/网络、可在 Node 中直接 `require` 测试。
- 表演性 `desc` 文案要稳定（测试不校验细节，但 UI 用它显示）。

## 5. `gd.ai.js`（全局 `GDAI`）API

```js
GDAI.suggest(state, opts) -> {
  action: 'play' | 'pass',
  play: Play | null,
  reason: string,                     // 中文，说明为什么这么打
  candidates: [{ play: Play, score: number }],  // 合法候选（不含过），score 降序，默认最多 12 个
  handInfo: { count: number, playsEstimate: number, bombs: number, wilds: number }
}

GDAI.candidates(state, limit) -> [{ play, score }]
// state = {
//   level, mySeat: 0..3,             // 0=我，座位逆时针 1=下家 2=对家 3=上家（UI 约定）
//   hand: number[],
//   lastPlay: Play|null,
//   lastPlaySeat: number|null,       // 上一手是谁出的
//   seatsRemaining: {0:27,1:27,2:27,3:27}  // 各家剩余张数（UI 由出牌记录推算）
// }
GDAI.handSummary(hand, level) -> { count, playsEstimate, bombs: Play[], wilds: number }
```

启发式必须满足：

1. 返回的 `play.cards` 一定在 `hand` 里、张数正确；`genMoves` 的合法候选里挑选；
2. 压不过上一手时 `action:'pass'` 且 `candidates` 为空（或只含能用的炸弹？——统一：能压的才进 candidates）；
3. 队友（`lastPlaySeat === (mySeat+2)%4`）是当前最大出牌者时默认让过，除非能一次出完手牌；
4. 对手剩余 ≤3 张时优先拦截，必要时用炸弹；否则炸弹克制使用；
5. 领出优先「减少手数」的组合，避免拆炸弹；
6. 文案含场景（领出/压牌/让队友/拦截/炸弹），便于 UI 展示。

## 6. `gd.deepseek.js`（全局 `GDDeepSeek`）API

```js
GDDeepSeek = {
  DEFAULTS: { baseUrl:'https://api.deepseek.com', model:'deepseek-chat',
              temperature:0.2, maxTokens:512, timeoutMs:30000 },

  normalizeConfig(settings) -> {apiKey, baseUrl, model, temperature, maxTokens, timeoutMs},
  // 去空格/斜杠；apiKey 为空字符串时视为未配置

  buildMessages(request) -> [{role:'system',content}, {role:'user',content}],
  // request = {
  //   level: 5, levelText:'5', wildText:'红桃5',
  //   mySeatName:'我', partnerSeatName:'对家',
  //   hand: ['♠A','♥5',...],            // 已格式化的牌面文本（含重复张）
  //   lastPlay: null | { seatName, name, size, bomb, cards:['♠K','♥K'] },
  //   history: [{seatName, action:'出牌'|'过', name, cards:[]}],   // 最近若干手（≤12）
  //   seats: [{name, count}],           // 各家剩余张数
  //   remaining: [{rankText:'2', count:6}, ...],   // 记牌器剩余
  //   candidates: [{ index:0, typeName, size, bomb, cards:['♠K','♥K'], note:'',
  //                  play: Play }]  // play 为必带扩展字段，便于 decide 返回真实 Play
  //   localSuggestion: null | { action, typeName, cards, reason }
  // }
  // system prompt：掼蛋规则摘要 + 决策原则 + 严格 JSON 输出契约
  // user prompt：当前局面 + 候选列表（带编号）+ 要求

  async callAPI(config, messages, fetchImpl) -> { content, model, usage }
  // POST {baseUrl}/chat/completions，Authorization: Bearer <apiKey>，
  // body {model, messages, temperature, max_tokens, response_format:{type:'json_object'}, stream:false}
  // fetchImpl 缺省用全局 fetch（Node18+/浏览器均可）。失败抛 Error（中文：401 Key 无效、429 限流、超时…）

  parseDecision(text, candidates) -> {
    ok: boolean, choice: number,      // -1 = 过；0..n-1 = 候选下标
    reason: string, error?: string
  }
  // 容错：```json 围栏、前后废话、全角引号、choice 为字符串数字、reason 缺失；
  // 越界/无法解析 → ok:false（由 decide 回退）

  async decide(request, config, opts) -> {
    source: 'deepseek'|'local',
    action: 'play'|'pass',
    play: Play|null,
    reason: string,
    raw?: string,                     // DeepSeek 原始返回（UI 可折叠展示）
    error?: string                    // 回退原因（如「API Key 无效」）
  }
  // opts = { fetchImpl, localSuggestion }；无 apiKey / 调用失败 / 解析失败 → 回退 localSuggestion
  // （回退时 source:'local'，error 说明原因；绝不 throw）

  async testConnection(config, fetchImpl) -> { ok: boolean, message: string, model?: string }
}
```

注意：

- **绝不硬编码 API Key**；Key 只从参数传入；错误信息里不打印完整 Key（可打前 4 位 + `****`）。
- Node 测试用 mock `fetchImpl`：验证 URL/请求头/body/prompt 包含手牌与候选、`parseDecision` 各种脏格式、
  401/超时/坏 JSON 时 `decide` 正确回退 localSuggestion。
- 浏览器端直接 `fetch` 调 `https://api.deepseek.com`（已确认 CORS 允许，`file://` 的 `Origin: null` 也放行）。

## 7. 网页界面（`index.html` + `app.js` + `style.css`）

单页、中文、深色主题（参考仓库其它助手：slate-900 背景 + sky-400 强调色），双击 `index.html` 离线可用。
不使用框架、不用 ES module、不用外部 CDN。

布局（桌面 3 列，窄屏单列）：

1. **顶栏**：`🃏 掼蛋 AI 助手 · 记牌器` / 级牌选择（2..A） / 我的座位（我是1号位/2号位/3号位/4号位，映射 0..3） /
   按钮：`新一局` `设置` `规则帮助`。
2. **记牌器面板**：按 rank 网格（2 3 4 5 6 7 8 9 10 J Q K A 小王 大王），每格显示 `×剩余`；
   剩余 0 置灰；级牌金色描边 + 「级」；红桃级牌在本列显示 ♥「配」标记；顶部汇总
   `未知 x 张 · 已出 y 张 · 我手 z 张 · 逢人配 ♥5 ×2`；鼠标悬浮显示 总/已出/我手。
3. **我的手牌面板**：牌面卡片渲染（红桃/方块红、黑桃/梅花黑），显示 `27 张`；
   按钮 `编辑手牌`（弹出 108 张选牌器）、`随机示例`（发牌演示用，填我手）；空手牌时提示。
4. **AI 出牌面板**：
   - 显示级牌、上一手（谁/牌型/牌面）、各家剩余张数；
   - 按钮：`💡 本地建议`、`🤖 DeepSeek 建议`；
   - 结果区：建议出牌牌面 / 「不出」、理由、来源徽章（本地引擎 / DeepSeek）、错误提示（如未配置 Key）；
   - `采用并记录` 按钮：把建议作为「我」的出牌写入记录并从手牌扣除；`复制牌面` 可选。
5. **出牌记录面板**：按时间列出（座位名、出牌/过、牌型、牌面、配牌说明）；
   按钮 `记录出牌`（弹选牌器：选座位 + 选牌或勾选「过」）、`撤销上一手`、`清空记录`。
   记录会自动维护记牌器、各家剩余张数、AI 的 lastPlay。
6. **设置弹窗**：DeepSeek API Key（password 输入，本地 localStorage 保存，提示只存本机）、
   Base URL（默认 `https://api.deepseek.com`）、模型（`deepseek-chat` / `deepseek-reasoner`）、
   温度、超时；`保存` / `测试连接`；`清除 Key`。
7. **规则帮助弹窗**：牌型/大小/逢人配/炸弹体系速查 + 使用步骤。

`app.js` 约定：

- 状态 `state = { level: 2, mySeat: 0, hand: number[], history: [{ seat, action:'play'|'pass', cards:[], play:Play|null }] }`，
  序列化到 `localStorage['gdAI.state']`；设置存 `localStorage['gdAI.settings']`。
- 从 history 派生：`played`（所有出牌卡 id 平铺）、`lastPlay`（最近 play 条目）、`seatsRemaining`
  （27 − 该座位已出张数）、`myHand`。
- 选牌器：108 张牌网格，已被记录出的牌置灰不可选；点选切换；显示当前已选牌型（`GDEngine.parseCards`）；
  `确定`。
- 本地建议：`GDAI.suggest(state)`；DeepSeek：`GDAI.candidates` → 组装 request → `GDDeepSeek.decide`。
- 任何异常（引擎缺失、API 失败）用顶部 toast 提示，不抛未捕获异常。
- 记录「我」的出牌时：若牌不在手牌里，提示并拒绝；`过` 不改手牌。
- 页面刷新后恢复状态；`新一局` 重置状态并保留设置。
- 无 console 报错；`file://` 下 localStorage 可用（写 try/catch）。

## 8. 测试

- 所有测试文件用 Node 直接跑：`node gd.test.js`（聚合入口 require 其它 test 文件）。
- 每个 test 文件内部 `let passed=0, failed=0; function ok(cond, msg){...}` 风格，
  失败打印 `✗ msg`，最后打印 `PASS n / FAIL m`，`process.exitCode = failed ? 1 : 0`。
- 只允许 `require('./gd.core.js')` 等本地模块；**不允许联网**（DeepSeek 测试用 mock fetch）。
- 覆盖重点见各模块要求；`gd.verify.test.js` 由 verifier 独立按 SPEC 出题，不得阅读实现代码。

## 9. 完成标准

1. `node gd.test.js` 全绿；
2. `index.html` 用 Edge headless 截图无白屏/无报错（Lead 验收）；
3. 无 API Key 时本地建议可用；填 Key 后 DeepSeek 建议可用（错误时优雅回退）；
4. `README.md` 有使用说明、规则口径、架构与测试结论；
5. 根 `README.md` 助手一览加入掼蛋一行。
