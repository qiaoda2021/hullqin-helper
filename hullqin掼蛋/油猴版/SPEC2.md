# SPEC2 · 掼蛋 AI 助手（game.hullqin.cn 油猴脚本版）

> 目标：给 [桌游合集](https://game.hullqin.cn/ddz) 的「掼蛋」玩法（rule=2，4 人 2 队、两副 108 张、每人 27 张）提供
> 🃏 **记牌器** + 💡 **出牌建议（本地启发式）** + 🌐 **DeepSeek 出牌建议（API 可配置、失败回退本地）** + ⚡ **一键出牌/不出/进贡/还贡**。
> 本目录所有文件均为新建，**不改动** 父目录 `hullqin掼蛋/`（离线网页版）已交付的 `gd.core.js` / `gd.ai.js` / `gd.deepseek.js` / `index.html` 等。

## 0. 文件与负责人（写 scope 互不重叠）

| 文件 | 全局名（浏览器） | 负责人 | 说明 |
|---|---|---|---|
| `gd.site.core.js` | `GDSite` | Lead | 站点规则引擎：牌 id/牌型/压牌/回放/expandState/protobuf/记牌器/走法生成/贡牌 |
| `gd.site.ai.js` | `GDSiteAI` | Lead | 本地启发式：候选评分 + suggest |
| `gd.site.remote.js` | `GDSiteRemote` | deepseek-dev | DeepSeek 请求构造 + 调用适配（复用父目录 `../gd.deepseek.js`） |
| `gd.site.ui.js` | `GDSiteUI` | ui-dev | 面板 DOM + 设置弹窗 + 帮助（纯 UI，不碰 fiber/引擎） |
| `userscript.body.js` | —（`HQ.registerGame`） | Lead | 页面桥接：读 fiber → 解码 → 渲染 → 点击出牌；`window.__gdAI` 调试接口 |
| `build.js` / `README.md` / `gd.test.js` / `gd.site.core.test.js` / `gd.site.ai.test.js` | — | Lead | 打包/文档/聚合测试/单测 |
| `gd.site.remote.test.js` | — | deepseek-dev | 远端模块单测（mock fetch，禁联网） |
| `gd.site.ui.test.js`（可选） | — | ui-dev | UI 纯函数/静态断言 |
| `gd.site.verify.test.js` + `_fixture*.{html,js}` | — | verifier | 独立黑盒验收（引擎性质 + 假 DOM/假 fiber 端到端） |

所有引擎/模块文件用 UMD：
```js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSite = api;
})(typeof self !== 'undefined' ? self : this, function () { 'use strict'; ... return api; });
```
打包顺序（`build.js` 的 modules 数组）：`../gd.deepseek.js`（全局 `GDDeepSeek`）→ `gd.site.core.js` → `gd.site.ai.js` → `gd.site.remote.js` → `gd.site.ui.js`，body=`userscript.body.js`，epilogue=`HQ.mountStandalone();`，输出 `掼蛋AI助手.user.js`（build-lib 固定 `@match https://game.hullqin.cn/*`、`@grant none`、`@author Eve`）。

## 1. 站点数据模型（逆向结论，权威）

### 1.1 牌 id（1..108）
- `local = (id-1) % 54 + 1`（1..54 第一副，55..108 第二副）。
- `local 53 = 大王（rank 17）`，`local 54 = 小王（rank 16）`。
- 花色 `suit = floor((local-1)/13)`：**0=♦、1=♣、2=♥、3=♠**（1..52 牌）。
- 自然点数：`local%13 === 1 → 14(A)`；`=== 0 → 13(K)`；其余 = `local%13`。即 local 1=♦A、2=♦2 … 13=♦K、14=♣A、27=♥A、40=♠A。
- **级牌顺序** `f(rank, level) = rank === level ? 15 : rank`（2..14 中 level 排 A 之上；16/17 不变）。
- **逢人配**：`local ∈ [27,39] && rank === level`（红桃级牌）；`heartLevelCardId = level===14 ? 27 : level+26`。
- 花色符号 `['♦','♣','♥','♠']`；牌面文本：普通牌 `花色+点数`（如 `♥A`、`♠K`），`大王/小王`；点数文本 `2..10,J,Q,K,A`。

### 1.2 牌型 code（`type<<8 | rank`）
| type | 值 | 名称（中文） | 张数 | rank 含义 |
|---|---|---|---|---|
| Single | 1 | 单张 | 1 | 级牌制点数 |
| Pair | 2 | 对子 | 2 | 同上 |
| Triple | 3 | 三同张 | 3 | 同上 |
| ThreeWithPair | 4 | 三带二 | 5 | 三张的点数 |
| Steel | 5 | 钢板（二连三） | 6 | 高组点数（AAA222→2，KKKAAA→14） |
| TriplePairs | 6 | 三连对 | 6 | 高对点数（AA2233→3，QQKKAA→14） |
| Straight | 7 | 顺子 | 5 | 窗口顶点（A2345→5，10JQKA→14） |
| Four | 100 | 炸弹 4 张 | 4 | 点数 |
| Five | 101 | 炸弹 5 张 | 5 | 点数 |
| StraightFlush | 102 | 同花顺 | 5 | 窗口顶点 |
| Six/Seven/Eight | 103/104/105 | 炸弹 6/7/8 张 | 6/7/8 | 点数 |
| FourJokers | 127 | 四大天王 | 4 | 0 |

- 只有 4..8 张炸弹 + 同花顺 + 四大天王；**没有 9/10 张炸弹**。
- 大小/压牌：同 type 比 rank；炸弹（type>=100）压非炸弹；炸弹之间比 type 数值（Four<Five<StraightFlush<Six<…<Eight<FourJokers），即 `fourJokers` 最强；同型同 rank 不能互压（含四大天王之间）。
- 顺子/同花顺窗口 `pos=1..14`（1=A 当 1，14=A 当 14），rank=窗口顶 pos；三连对窗口顶 pos 3..14；钢板顶 pos 2..14。A 当 1 时：三连对 AAA222... 不合法（三连对窗口 [1,2,3] 即 AA2233 合法），钢板 AAA222 合法（窗口 [1,2]）。
- 三带二 rank 只取三张；王对子可当三带二的对子。

### 1.3 protobuf `DDZGameData`（mod 9474，不用 protobufjs，自己写最小读写）
| 字段号 | 名称 | 类型 | 备注 |
|---|---|---|---|
| 1 | rule | uint32 | 掼蛋 = 2 |
| 2 | state | uint32 | 见 §1.4 |
| 3 | landlordId | uint32 | 掼蛋无用（=0） |
| 4 | cardPositionList | repeated uint32 | 108 项；`7 & value` = 归属玩家（1..4；0=已打出/无主）；packed(wire2) |
| 5 | playedCardList | repeated uint32 | 每个动作前加 0 分隔：出牌 `[0, ...cards]`，过牌 `[0]` |
| 6 | v | uint32 | 状态版本号（非人数） |
| 7 | team13Level | uint32 | 红队(1/3) 等级 2..14 |
| 8 | team24Level | uint32 | 蓝队(2/4) 等级 |
| 9 | lastRankList | repeated uint32 | 本局名次（座位号，1..4） |
| 10 | tributeCardList | repeated uint32 | 进贡牌（每位贡家一张；未进贡为 0 占位） |
| 11 | returnCardList | repeated uint32 | 还贡牌 |
| 12 | firstPlayer | uint32 | 首出座位（1..4；0 时回放回退 1） |
| 13 | playedTypeList | repeated uint32 | 与 playedCardList 的「动作段」一一对应的 code（0=过/非法） |

decode 必须同时兼容 packed(wire 2) 与单值(wire 0)，跳过未知字段。

### 1.4 expandState 派生（mod 6135 `C`，等价实现即可）
输入 raw（解码后的对象，**不得修改入参**），输出派生对象：
- `level`：`lastRankList.length===4 ? (lastRankList[0]%2===1 ? team13Level : team24Level) : 2`
- `playingTeam`：同上但 1/2，否则 0
- `heartLevelCardId = level===14 ? 27 : level+26`
- `tributers`/`receivers`（函数 `j`）：lastRankList 长度≠4 → 均为 []；否则若 `parity(rank1)===parity(rank2)`（`e%2` 相同）→ 贡家=[第3,第4]、收贡=[第1,第2]；否则 贡家=[第4]、收贡=[第1]。
- `tributeReceivers = (tributeCardList.length===tributers.length && tributers.length) ? receivers : []`
- `isRoundFinish = state > 8`；`phase = isRoundFinish ? 'finish' : (state===0 ? (tributeCardList.some(x=>!x) ? 'tribute' : 'return') : 'play')`
- 回放（§1.5）得到 `rankList/trickOwner/lastCards/lastInterp/lastSegmentPlayer/currentPlayer/trickActions/initialHolders/restCounts`；`canPlayAnyCards = !trickOwner`
- `playerCardLists[1..4]`：遍历 cardPositionList，`owner=7&v`，1..4 → push `idx+1`；`playerRestCardCounts = [0, len1..4]`
- `resistInfo`：`tributers.length && state>0 && !tributeCardList.length` 时，每位贡家统计 `initialHolders` 或 cardPositionList 归属为该家且 local===53（大王）的张数 → `[{position, bigJokerCount}]`；否则 []
- `roundResult`（isRoundFinish 时，否则 null）：`winTeam = rankList[0]%2===1 ? 1 : 2`；`fullRankList = rankList + 未出完座位补齐(1..4)`；`o = fullRankList.findIndex((t,i)=> i>0 && parity(t, fullRankList[0]))`；`upLevels = o===1?3:(o===2?2:1)`；`newTeam13Level = winTeam===1 ? min(14, team13Level+upLevels) : team13Level`；24 同理；`isMatchOver = level===14 && winTeam===playingTeam && o!==3`

### 1.5 回放算法 `replayActions(playedCardList, firstPlayer, playedTypeList)`
```
initialHolders = Array(108).fill(0); restCounts=[0,27,27,27,27]; finished=Array(5).fill(false)
rankList=[]; trickOwner=0; lastCards=[]; lastInterp=0; lastSegmentPlayer=0
trickActions=[null,null,null,null,null]; passedSet=new Set()
nextActive(seat): t = seat%4+1; while finished[t] → t=t%4+1（最多 4 次）; return t
// 动作分段：zeros = playedCardList 中值为 0 的下标; zeros.push(len)
// 第 i 段 = playedCardList.slice(zeros[i-1]+1, zeros[i])，由当前 currentPlayer 执行
currentPlayer = firstPlayer || 1
对每段 i：
  actionCards = slice(...); lastSegmentPlayer = currentPlayer // 每段开始即记录
  if 有牌：
    每张卡: initialHolders[card-1] = currentPlayer
    restCounts[currentPlayer] -= n; 若变为 0 → finished[currentPlayer]=true; rankList.push(currentPlayer)
    trickOwner = currentPlayer; lastCards = actionCards; lastInterp = playedTypeList[i] || 0
    passedSet.clear()
    // 清理已出完玩家的桌面显示
    for L=1..4: if L!==currentPlayer && finished[L] && trickActions[L] && trickActions[L].cards → trickActions[L]=null
    trickActions[currentPlayer] = {cards: actionCards, passed:false}
    currentPlayer = nextActive(currentPlayer)
  else: // 过牌
    passedSet.add(currentPlayer); nx = nextActive(currentPlayer)
    if (trickOwner && (nx===trickOwner || passedSet.has(nx))):
         // 本墩结束，trickOwner 重新领出（若已出完则其对家 c(trickOwner) 领出）
         h=trickOwner; trickActions[currentPlayer]={cards:null,passed:true}
         for w=1..4: if finished[w] && trickActions[w] && trickActions[w].cards → trickActions[w]=null
         trickOwner=0; lastCards=[]; lastInterp=0; passedSet.clear()
         currentPlayer = finished[h] ? partner(h) : h        // partner(e) = e<=2 ? e+2 : e-2
    else: trickActions[currentPlayer] = {cards:null, passed:true}; currentPlayer = nx
```
注意：每段动作的「执行者」是**进入该段时的 currentPlayer**（`lastSegmentPlayer`=该值）。

### 1.6 牌型解释 `interpretCodes(cards, level) -> number[]`（等价实现，最多 48 个即可）
记 wilds（逢人配，u 张）、others=非配牌（o）、`cntLevelOrder`（按 §1.1 f 计数 Map）、`cntNatural`（按自然点数计数 Map）。规则：
- size1: `Single<<8 | (u?15:f(card))`
- size2: u===2 → `Pair<<8|15`；否则遍历 cntLevelOrder 的 key e：`!(u && e>=16) && cnt.get(e)===2-u` → `Pair<<8|e`
- size3: 类似 `triple`：`!(u && e>=16) && cnt.get(e)===3-u` → `Triple<<8|e`
- size4 且 u===0 且全部为大小王 → `FourJokers<<8|0`
- 炸弹（`cnt.size<=1`）：`y = o.length ? f(o[0]) : 0`；`(!u || y<16)` 时对 x=4..8：`x-u>=1 && x-u===o.length` → code = (x<=5 ? Four+x-4 : x+97) <<8 | y
- size5 顺子/同花顺：`g = Set(自然点数 of o)`；`j = g.size===o.length`；`C = suitOf(o[0])`；`w = j && o.every(card => suitOf(card)===C)`；对 b=5..14：`k=0; for P=b-4..b: if(!g.has(P) && !(P===1 && b===5 && g.has(14))) k++`；`k===u` 时：j → `Straight<<8|b`；w → `StraightFlush<<8|b`
- size5 三带二：遍历 cnt key e（三张）：跳过 `(u && e>=16)`；`t=cnt.get(e)`；遍历 cnt key i（对）：跳 `i===e || t>3 || cnt.get(i)>2 || t+cnt.get(i)+u!==5 || (u && i>=16)` → `ThreeWithPair<<8|e`
- size6 三连对：`N = keys(cntNatural)`；e=3..14：窗口 `[e-2,e-1,e]`，`N.every(r => window.includes(r) || (r===14 && e===3))`；否则跳过；`i=0`；对每个 l of window：`o2 = cntNatural.get(l) || (l===1 && e===3 && cntNatural.get(14)) || 0`；`o2>2 → 非法`；`i += 2-o2`；`i===u` → `TriplePairs<<8|e`
- size6 钢板：e=2..14：窗口 `[e-1,e]`，`N.every(r => window.includes(r) || (r===14 && e===2))`；否则跳过；`i=0`；每个 l：`o2 = cntNatural.get(l) || (l===1 && e===2 && cntNatural.get(14)) || 0`；`o2>3 → 非法`；`i += 3-o2`；`i===u` → `Steel<<8|e`
- 结果去重（可保留重复，但 `bestCode` 取 max）。

`bestCode(cards, prevCode, level)`：codes=interpretCodes；空→0；prevCode 为 0 → max(codes)；否则过滤 `beats(next, prev)`：同 type（`next>>8===prev>>8`）→ `(next&255) > (prev&255)`；否则 `nextType>=100 && nextType > prevType`；取 max，无则 0。
`beats(next, prev)`：`prev===0 → true`；同 type 比 rank；不同 type 则 `nextType>=100 && nextType>prevType`。

### 1.7 页面 DOM / 交互事实（mod 6544）
- 牌元素：`<div id="{rawId}" class="ddz-poker ddz-poker-{localId}">`；我的手牌额外带 `ddz-my-poker`；手牌容器 `.ddz-poker-list`；点击牌元素切换选中（站点用自身 state 记录选中 id-1；选中时该牌 style 里 `filter: brightness(0.8)`）。
- 按钮（用 `textContent.includes` 匹配，注意按钮可能是 div）：`😎 出牌`、`😭 不出`、`确认进贡`、`确认还贡`、`我反悔了`、`下一局`、`整理手牌…`。
- 进贡阶段（phase==='tribute'）：只有贡家可操作，站点会**自动预选第一张建议贡牌**，点「确认进贡」即可；还贡阶段需手动选中 1 张 `returnCandidates` 内的牌再点「确认还贡」。
- 根组件 fiber props：`{ room, game, send }`，其中 `room.position`=我的座位（1 基，0=观战）、`room.playerList`、`game.data`=protobuf 二进制（Uint8Array/Array/Buffer）。**展开态不在 props 里**（掼蛋组件内部自行解码+expandState），所以脚本必须自己解码。
- 读状态：从任意 `.ddz-poker`/`.ddz-my-poker` 元素做 `HQ.findProps(el, p => p && p.room && p.game && typeof p.send==='function', 20)`；再 `GDSite.decodeGameData(p.game.data)` → `GDSite.expandState(raw)`。
- 路由：`location.pathname` 匹配 `/\/ddz/`；只有 `raw.rule===2` 才是掼蛋，否则面板显示「当前不是掼蛋玩法」。

### 1.8 贡牌候选（mod 6135 `R`/`Z`）
- `tributeCandidates(hand, level)`：过滤掉逢人配（红桃级牌）；按级牌制顺序取**最大的同点牌**（同点数全部返回）；若过滤后没牌则整手返回。
- `returnCandidates(hand, level)`：优先取「自然点数 ≤10 且自然点数 !== level」的牌，全部返回；否则取除级牌外最小点数的牌（同点全部返回）。

## 2. 引擎 `GDSite`（Lead 实现，其他模块可依赖）

导出（浏览器全局 `GDSite` / Node `module.exports`）：
```
VERSION: string
CARD: {TOTAL:108, DECKS:2}
TYPE: {Single:1, Pair:2, Triple:3, ThreeWithPair:4, Steel:5, TriplePairs:6, Straight:7, Four:100, Five:101, StraightFlush:102, Six:103, Seven:104, Eight:105, FourJokers:127}
normalizeId(id) -> 1..54          cardDeck(id) -> 0|1        cardLocal(id) -> 1..54
rankOf(id) -> 2..14/16/17         suitOf(id) -> 0..3 | -1(王)
levelOrder(rank, level) -> 2..17（level→15）
isJoker(id) / isWildCard(id, level) / isLevelCard(id, level)
heartLevelId(level)
rankText(rank) -> '2'..'A'/'小王'/'大王'
cardText(id) -> '♥A'/'大王'…      cardTexts(ids) -> string[]
typeName(code) -> '单张'/'炸弹4张'…    bombValue(code) -> 0 | 4..8 | 5.5 | 99（同花顺 5.5）
decodeGameData(bytes) -> raw        encodeGameData(raw) -> Uint8Array（测试/夹具用）
replayActions(playedCardList, firstPlayer, playedTypeList) -> {rankList,trickOwner,lastCards,lastInterp,lastSegmentPlayer,currentPlayer,trickActions,initialHolders,restCounts}
expandState(raw) -> derived（§1.4；含 raw 原始字段副本，不修改入参）
interpretCodes(cards, level) -> number[]
bestCode(cards, prevCode, level) -> number
beats(nextCode, prevCode) -> boolean
playFromCards(cards, level, code?) -> Play|null   // code 缺省=bestCode(cards,0,level)
genMoves(hand, level, prevCode) -> Play[]          // prevCode=0 领出，否则只返回能压的
sortHand(cards, level, seat?) -> number[]          // 站点同款排序（等级降序→相对花色→id）
myHand(expanded, seat) -> number[]
remainingCounts(expanded, seat) -> {byRank:[{rank,text,total,played,mine,remaining,isLevel,isWild}], wildRemaining, total, playedCount, mineCount, unknown, ok, warnings:string[]}
tributeCandidates(expanded, seat) -> number[]      // 该家手牌
returnCandidates(expanded, seat) -> number[]
buildAIState(expanded, seat) -> 见 §3
createRng(seed)（mulberry32）/ deal(seed) -> {hands:[[27],[27],[27],[27]], seed}
```

Play 对象（所有模块统一）：
```
{ type:number, code:number, name:string, cards:number[], size:number,
  rank:number, bomb:number, level:number, desc:string, wilds?:[{card,asRank,asSuit}] }
```
`name` 例：`单张`、`对子`、`三同张`、`三带二`、`钢板`、`三连对`、`顺子`、`炸弹4张`…`炸弹8张`、`同花顺`、`四大天王`；`desc` 例：`顺子 10JQKA`、`炸弹4张 ♠7♠7♣7♦7`。

`buildAIState(expanded, seat)` 返回：
```
{ level, levelText, heartLevelCardId, wildText, mySeat, mySeatName, partnerSeat, partnerSeatName,
  hand:number[27], prevCode:number /*0=领出*/, lastCards:number[], trickOwner:number /*0=无*/,
  canPlayAny:boolean, isMyTurn:boolean, seatsRemaining:[{seat,name,count,isMe,isPartner}],
  history:[{seat, seatName, cards:string[], passed:boolean, name:string}],
  counter:{...remainingCounts 结果}, phase, tributers, tributeReceivers, mustTribute:boolean, mustReturn:boolean }
```
座位名（相对）：`我=mySeat`、`下家=mySeat%4+1`、`对家=mySeat<=2?mySeat+2:mySeat-2`、`上家=mySeat+3-4*(mySeat>1?...)` 用取模统一实现；队友 = 同奇偶。

## 3. 本地 AI `GDSiteAI`（Lead 实现）
```
handSummary(hand, level) -> {size, bombs, wilds, levelCards, playsEstimate}
candidates(state, limit=12) -> [{play, score, tag}]   // 评分降序
suggest(state) -> {source:'local', action:'play'|'pass', play:Play|null, reason:string, candidates:[{play,score,tag}], handInfo}
toLocalSuggestion(suggestion) -> {action, play, reason, typeName, cards:string[]}  // 给 GDDeepSeek 回退用
```
启发式硬要求：
1. 能一手出完（`play.size===hand.length`）优先；队友牌权时默认让过（除���能一次出完）。
2. 领出：优先「减少手数」；不拆炸弹/同花顺/钢板等大牌；优先出小牌、保留逢人配与大牌；手数估计用贪心。
3. 跟牌：能压则用最小代价（同 type 最小可压，非必要不用炸弹；对手剩余 ≤3 张时优先拦截，必要时炸弹；队友牌权时让过）。
4. `state.canPlayAny` 或 `state.prevCode===0` 视为领出；跟牌时 `prevCode` 由 `expandState.lastInterp` 给出（0 表示无上一手）。
5. 候选 cards 必须都在 `state.hand` 里，且 `GDSite.bestCode(cards, prevCode, level) !== 0`；压不过就 `action:'pass'`。

## 4. 远端适配 `GDSiteRemote`（deepseek-dev 实现）
复用父目录 `../gd.deepseek.js`（打包进脚本后为全局 `GDDeepSeek`；Node 测试 `require('../gd.deepseek.js')`）。
```
DEFAULTS                       // 同 GDDeepSeek.DEFAULTS
buildRequest(input) -> request // input={state:buildAIState 结果, suggestion:GDSiteAI.suggest 结果, counter?:remainingCounts}
toLocalSuggestion(suggestion) -> {action, play, reason, typeName, cards:string[]}
async decide(input, config, opts?) -> {source:'deepseek'|'local', action, play:Play|null, reason, raw?, error?}
async testConnection(config, fetchImpl?) -> {ok, message, model?}
```
- `buildRequest` 必须产出 `GDDeepSeek.buildMessages` 所需字段：`level, levelText, wildText, mySeatName, partnerSeatName, hand:[string], lastPlay:{seatName,name,size,bomb,cards:[string]}|null, history:[{seatName,text}], seats:[{name,count}], remaining:[{rankText,count}], wildRemaining, candidates:[{typeName,name,size,cards:[string],bomb,note,play}], localSuggestion`；`candidates` 编号 = 数组下标（0..n-1）。
- `decide` 内部：request=buildRequest(input)；`GDDeepSeek.decide(request, config, {fetchImpl, localSuggestion})`；把返回的 `play` 原样返回（`candidate.play` 即 Play）。无 Key / 调用失败 / 解析失败时返回 `source:'local'` 且 action/play 来自本地建议，**绝不 throw**。
- 测试全部 mock fetch，禁联网；错误文案不得含完整 API Key（GDDeepSeek 已处理）。

## 5. 面板 UI `GDSiteUI`（ui-dev 实现）
`GDSiteUI.create(container, opts) -> {root, handle, update(snapshot), setSettings(settings), toast(msg), openSettings(), destroy()}`
`container` 是 body 创建的 fixed 容器；`handle` 返回标题栏元素（供 `HQ.makeDraggable`）。

`opts` 回调（body 提供）：`{onLocalSuggest, onDeepSeekSuggest, onAdopt, onPass, onTribute, onReturn, onUndo?, onNextRound?, onSaveSettings(settings), onTestConnection(settings)->Promise<{ok,message}>, onOpenHelp?}`。

`update(snapshot)`，snapshot 结构（body 每 tick 生成）：
```
{ visible:boolean, isGuandan:boolean, mySeat:0..4, phase:'tribute'|'return'|'play'|'finish'|'',
  level:number, levelText:string, wildText:string, turn:boolean,
  seats:[{seat,name,count,isMe,isPartner,tribute:boolean,rankBadge:number|null}],   // 4 项，按 我/下家/对家/上家 顺序
  counter:{ byRank:[{rank,text,count,isLevel,isWild}], wildRemaining, playedCount, unknown },
  handInfo:{ size, bombs, wilds, playsEstimate },
  lastPlay:null | { seatName, name, cardsText },
  history:[{seatName, text}],   // 最近 3 条
  suggestion:null | { source:'local'|'deepseek', action:'play'|'pass', name, cardsText, desc, reason, error?, candidatesText?:string[] },
  tribute:null | { mode:'tribute'|'return', fromName, toName, candidatesText, suggestText },
  busy:boolean, auto:boolean, settings:{hasKey:boolean, model:string} }
```
UI 要求：
- 宽度约 260px，深色圆角面板，与 `hullqin斗地主/userscript.body.js` 面板风格一致；标题栏 `🃏 掼蛋 AI 助手`（可加 `级牌 X · 逢人配 ♥X` 徽标）。
- 分区：① 记牌器（大王/小王/A/K/Q/J/10/9/8/7/6/5/4/3/2 网格，显示剩余张数；级牌、逢人配高亮；0 张变灰）② 我的信息（27 张 / 炸弹 / 逢人配 / 预计手数）③ 牌桌（我/下家/对家/上家剩余张数、当前牌权、上一手）④ 建议区（来源徽标 本地/DeepSeek、建议牌型+牌面、理由、候选列表可折叠）⑤ 操作按钮：`💡 本地建议`、`🌐 DeepSeek 建议`、`⚡ 采用并出牌`、`🃏 不出`；进贡/还贡阶段改为 `📤 采纳进贡` / `确认进贡`（按钮行为回调 body 处理）⑥ 设置/帮助按钮 + 自动托管开关。
- 设置弹窗（可用 `position:fixed` overlay 或面板内联展开，二选一，自包含）：API Key（type=password）、Base URL（默认 `https://api.deepseek.com`）、模型（`deepseek-chat`/`deepseek-reasoner`，可用 input+datalist）、temperature（0.2）、超时 ms（30000）、`保存`、`测试连接`、`清除 Key`；`onSaveSettings` 保存后回读 `setSettings`。**绝不显示完整 Key 明文**（已填则 placeholder 显示掩码）。
- 帮助：快捷键/功能/规则口径/隐私说明（Key 只存本机 localStorage，不写日志）。
- 文案全部中文；无 CDN、无外部字体；不污染站点全局（class 前缀 `hqgd-`）。
- UI 自身不读 fiber、不调用引擎业务逻辑；只根据 snapshot 渲染、把点击转给 opts 回调。

## 6. body 桥接（Lead 实现）
- `readGame()`：按 §1.7 读 props → decode → `raw.rule!==2` 返回 `{guandan:false}`；否则 `expandState(raw)` → `{guandan:true, expanded, send, room}`。
- tick（`HQ.registerGame({id:'ddz', name:'掼蛋', icon:'🃏', route:/\/ddz/, interval:550, mount, tick})`，注意 `mountStandalone` 会按 route 挂载；**必须兼容斗地主页面**：非掼蛋时面板显示提示）。
- 出牌动作：`playCards(cards)`：先反选已选中的牌（遍历 `.ddz-my-poker`，点击 `style.filter` 含 `brightness(0.8)` 的）→ 逐张点击目标牌（`HQ.clickEl`，间隔 30ms）→ sleep 150ms → 点「出牌」按钮（`textContent` 含 `出牌`，排除「不出」）→ sleep 300ms → 校验 tick 状态变化。
- 不出：点「不出」按钮。进贡：点「确认进贡」（站点已自动预选）；还贡：先点击候选牌，再点「确认还贡」。
- 建议高亮：在牌元素上叠 fixed div 蓝框（`pointer-events:none`），tick 重算位置。
- `window.__gdAI` 调试接口：`{version, dump(), read(), suggest(), deepseek(), play(cards), pass(), tribute(), returnCard(), settings:get/set, decode(bytes), expand(raw)}`。
- 设置存储：`HQ.loadSettings('gdSiteAI.settings', DEFAULTS_SETTINGS)` / `HQ.saveSettings`。

## 7. 测试与验收
- Node：`node gd.test.js` 依次 spawn 跑 `gd.site.core.test.js`、`gd.site.ai.test.js`、`gd.site.remote.test.js`、`gd.site.verify.test.js`，解析 `PASS n / FAIL m`，汇总，失败 exit 1；环境 node 绝对路径 `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（无 npm；cwd 中文路径）。
- 所有测试**禁止联网**（远端模块用注入 fetchImpl/mock）。
- 引擎测试必须覆盖：牌 id/花色/点数/逢人配、全部牌型解释（含逢人配、A 当 1）、大小与炸弹链、回放（出牌/过牌/三过清墩/出完同伴领出）、expandState（tribute/return/play/finish、rankList、resistInfo、roundResult、队友#风）、protobuf encode/decode 往返、记牌器、genMoves 合法性（随机 200 局面：每个候选 cards⊆hand、bestCode 合法/能压、去重）。
- 端到端夹具（verifier）：`_fixture.html` + `_fixture.setup.js` + `_fixture.test.js`：构造假 React fiber（元素属性 `__reactFiber$test` 指向 `{memoizedProps:{room:{position:2,playerList:[...]}, game:{data:GDSite.encodeGameData(rawState)}, send:fn}, return:{memoizedProps:{...同}, return:null}}`）+ 手牌 DOM + 按钮 DOM（记录点击）；先加载 `gd.site.core.js` 用于编码，再加载构建产物 `掼蛋AI助手.user.js`，断言：面板渲染、记牌器数字、本地建议合法、点击「采用并出牌」确实点中了对应牌与出牌按钮、DeepSeek 无 Key 回退本地、设置保存 localStorage、控制台无未捕获错误。用 Edge headless `--headless=new --disable-gpu --virtual-time-budget=20000 --dump-dom` 跑，解析 `<pre id="fixture-result">` 的 `PASS n / FAIL m`。
- 完成后 build 产物静态断言：header 含 `@match https://game.hullqin.cn/*`，模块顺序（GDSite 定义在 GDSiteAI/GDSiteRemote/GDSiteUI 之前）、末尾 `HQ.mountStandalone();`、无 `http://` CDN 引用。

## 8. 约束
- 纯前端、无构建依赖（只用 node 内置模块）；不引入 npm 包。
- 中文 UTF-8、代码注释中文；文件新建，勿改父目录已交付文件（`gd.deepseek.js` 仅引用不修改）。
- API Key 只存 localStorage；日志/错误/UI 不打印完整 Key；不向任何第三方发送数据（只有 DeepSeek 官方 API，且用户主动点「DeepSeek 建议」时）。
- 娱乐辅助，遵守站点规则与用户自身账号安全；不自动参与真实对局以外的用途。
