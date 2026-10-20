# 掼蛋 AI 助手（油猴版）

[game.hullqin.cn/ddz](https://game.hullqin.cn/ddz) 掼蛋玩法（房间设置里「玩法」选 **掼蛋**）的油猴脚本：
📋 记牌器 + 👁 透视（可开关，查看其他三家手牌与炸弹预警）+ 💡 本地出牌提示 + ⚡ 一键出牌 + 🤖 自动托管 + 🌐 DeepSeek 建议 + 进贡 / 还贡辅助。

规则全部 **1:1 逆向自游戏前端源码**（ddz chunk 的掼蛋规则模块 / 状态模块 / protobuf 定义），不猜规则、不拦截网络：
只读取页面 React fiber 里的本局状态（透视同样只用这份已解码状态，不 hook WebSocket、不改任何请求），需要时模拟点击站点的「出牌 / 不出 / 确认进贡 / 确认还贡」按钮，服务器视角与真人操作一致。
**朋友间娱乐使用，请勿用于破坏他人体验。**

## 功能

| 功能 | 说明 |
|---|---|
| 📋 记牌器 | 108 张按点数（2..A、小王、大王）统计「未知 / 已出 / 我手」张数；金色标级牌，♥ 标逢人配（红桃级牌）；顶部汇总本局已出、我手、逢人配剩余 |
| 👁 透视（可开关） | 面板开关（`透视：关` / `透视：开`，默认 **关**，状态存本机）打开后显示其他三家手牌（点数降序、级牌 / 逢人配 / 红牌高亮）与每家炸弹 / 同花顺 / 四大天王预警，底部汇总可见张数与炸弹数；数据只来自本局 fiber 已解码状态，不上传、不写日志 |
| 💡 本地建议 | 本地启发式从合法走法中挑最优（能一手出完必出、队友牌权让过、对手剩牌少时拦截、尽量不拆炸弹 / 不浪费逢人配），显示建议牌 + 理由（不再在牌桌上画高亮框） |
| ⚡ 采用并出牌 | 自动点选建议的那些手牌，再点站点「😎 出牌」；也可一键「🃏 不出」 |
| 🌐 DeepSeek 建议（默认） | **配了 Key 时默认走 DeepSeek**：轮到我时面板先显示本地建议，后台同时把局面 + 最多 12 个合法候选交给 DeepSeek 选一个（JSON 契约），返回后自动替换成 DeepSeek 建议；**无 Key / 请求失败 / 解析失败 / 超时自动保留本地建议**，不打断对局；也可手动点按钮强制再问一次 |
| 🤖 自动托管 | 轮到我就自动出牌 / 过牌：**配了 DeepSeek Key 时用 DeepSeek 决策，无 Key 时用本地建议**（可随时关闭）；出完 / 结束自动停止 |
| 进贡 / 还贡 / 抗贡 | 自动识别阶段并给出贡牌建议（进贡排除红桃级牌取最大、还贡优先 ≤10 非级牌），可一键选中并确认 |
| 下一局 / 反悔 | 面板提供「下一局」；识别站点反悔状态（仅提示，不自动操作） |
| 设置 | API Key（密码框、掩码显示，仅存本机 localStorage）、Base URL、模型（deepseek-chat / deepseek-reasoner）、temperature、超时、测试连接、清除 Key |

只在**掼蛋玩法（rule=2）**显示；斗地主 / 无规则房间面板会提示「当前不是掼蛋玩法」并隐藏操作。透视默认关闭，需要手动点开；观战（未入座）时没有「其他三家」视角，只显示提示。

## 安装

**推荐用「导入文件」/ 拖拽安装，不要从聊天窗口或预览里复制文本**——大文件预览会被截断，粘贴进编辑器会缺行、语法不完整，油猴脚本不会执行，面板也就不出现。

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 任选一种安装方式：
   - **从 GitHub 一键安装**：打开
     `https://raw.githubusercontent.com/qiaoda2021/hullqin-helper/main/hullqin掼蛋/油猴版/掼蛋AI助手.user.js`
     Tampermonkey 会弹出安装页 → 点「安装」（项目主页见 [qiaoda2021/hullqin-helper](https://github.com/qiaoda2021/hullqin-helper)）；
   - **拖拽**：把本目录的 `掼蛋AI助手.user.js` 直接拖进浏览器窗口 → Tampermonkey 跳到安装页 → 点「安装」；
   - **从文件导入**：Tampermonkey 图标 → 管理面板 → 实用工具（Utilities）→「从文件导入」→ 选 `掼蛋AI助手.user.js`；
   - **地址栏**：新标签打开 `file:///D:/下载/hullqin-helper-main/hullqin掼蛋/油猴版/掼蛋AI助手.user.js`。
3. 打开 [game.hullqin.cn/ddz](https://game.hullqin.cn/ddz)，房间设置选「4 人 + 玩法：掼蛋」，开始游戏后面板自动出现在右上角（可拖动标题栏）。

脚本 header：`@match https://game.hullqin.cn/*`、`@grant none`、`@connect api.deepseek.com`，无外部 CDN / 依赖。

### 装好后没看到面板？按顺序检查

1. **装完要刷新游戏页**（F5 / Ctrl+F5）：油猴脚本只在页面加载时注入，安装前就打开的页面不会自动生效。装好后从首页点进掼蛋房间也能自动出现面板（脚本有 SPA 路由感知挂载），但「安装脚本」这个动作本身需要一次刷新才生效。
2. F12 打开控制台，应有一行 `[掼蛋助手] v1.1.0 已加载（…）`；再输入 `__gdAI` 应返回对象、`document.getElementById('hqgd-panel')` 应拿到面板元素。
3. 控制台里完全没有「掼蛋助手」字样 → 脚本没执行：检查 Tampermonkey 里脚本是否启用、`@match` 是否被改、以及**手动粘贴时内容是否完整**（编辑器底部行数应约 6000+ 行，最后一行应为 `})();`；若出现 `Parsing error` 说明粘贴缺行 / 串行，请改用上面的导入文件方式）。
4. 控制台提示「模块缺失，脚本未启动」→ 粘贴内容被破坏或构建不完整，重新导入 `.user.js`。
5. 当前房间是「斗地主规则 / 无规则」时，面板只显示提示「当前不是掼蛋玩法」；请把房间设置成 **4 人 + 掼蛋**。
6. 面板固定在页面右上角，可能被页面元素暂时遮挡；刷新页面会复位到右上角（拖动位置不持久化）。

## 使用

1. **记牌器**始终显示；「未知」= 其他三家手里尚未出现的张数（= 全副 108 − 已出 − 我手），鼠标悬停可看总张数 / 已出 / 我手明细。
2. **透视**默认关闭：点记牌器下方的 `透视：关` 按钮打开，面板立即列出下家 / 对家 / 上家的全部手牌（牌面按级牌顺序排序，级牌金底、逢人配紫底、红牌红字、王靛底），并标出每家的炸弹 / 同花顺 / 四大天王与剩余张数；再点 `透视：开` 关闭。开关状态自动保存到本机，下次打开游戏沿用。
3. 轮到我时：面板立刻显示**本地建议**；若已配 Key，后台同时问 DeepSeek，返回后自动替换成 **DeepSeek 建议**（标记来源）。也可随时点 **💡 本地建议** / **🌐 DeepSeek 建议** 手动刷新。
4. 点 **⚡ 采用并出牌** → 自动点选牌并点站点「出牌」；若建议是「过」则点「🃏 不出」。
5. 想用 AI：在 **⚙ 设置** 填 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com) 获取）；配好后默认就由 DeepSeek 给建议，无需每次点按钮。
6. 点 **🤖 托管** 开启自动出牌：**配了 Key 时由 DeepSeek 思考后自动出牌**（失败自动回退本地），无 Key 时用本地建议；再点一次关闭。
7. 进贡 / 还贡阶段：面板出现「确认进贡 / 确认还贡」建议与一键按钮（站点本身对进贡有自动预选，脚本只帮你确认 / 选中还贡牌）。

### DeepSeek 配置

| 项 | 默认值 | 说明 |
|---|---|---|
| API Key | 空 | 只存 `localStorage['gdSiteAI.settings']`，仅本机；面板与日志都只显示前 4 位 + `****`。**也可硬编码**：打开脚本源码，找到顶部 `const HARDCODED_API_KEY = '';`（注释块写着「★★★ 在这里填入你的 DeepSeek API Key ★★★」），把 Key 填进单引号里即可（面板里填的 Key 优先级更高，便于随时纠正；硬编码会明文留在源码里，别发给别人） |
| Base URL | `https://api.deepseek.com` | OpenAI 兼容 `/chat/completions`；api.deepseek.com 已允许浏览器跨域 |
| 模型 | `deepseek-chat` | 也可填 `deepseek-reasoner` |
| temperature | `0.2` | 越小越稳定 |
| 超时 | `30000` ms | 超时自动回退本地建议 |

请求只包含本局牌面 / 候选，不含账号信息；Key 只在浏览器直连 DeepSeek，不经过任何中间服务器。

> 如果你把 Key 直接填在**上一次生成的** `掼蛋AI助手.user.js` 里，`node build.js` 会先读旧产物里的 Key、构建后再回填（`build.js` 里有对应注释），所以重新构建不会把 Key 冲掉；Key 填在 `userscript.body.js` 里同样生效。构建产物里出现明文 Key 后请勿分享该文件。

## 工作原理（逆向结论）

- 页面根组件 fiber props 为 `{room, game, send}`：`room.position` 是我的座位（1..4，0=观战），`game.data` 是 protobuf `DDZGameData`（rule/state/cardPositionList/playedCardList/team13Level/team24Level/lastRankList/tributeCardList/firstPlayer/playedTypeList 等字段）。
- 手牌 / 牌桌 DOM：`div.ddz-poker.ddz-my-poker`（我的手牌，牌 id 1..108）与 `.ddz-poker-list`；按钮文案「😎 出牌」「😭 不出」「确认进贡」「确认还贡」「我反悔了」「下一局」。
- 引擎把站点源码里的牌型解释、压牌比较、回放、`expandState`（进贡 / 还贡 / 抗贡 / 升级规则）逐函数移植，protobuf 编解码手写；本地 AI 与 DeepSeek 只消费展开后的状态。
- 透视（👁）只消费同一个 `expandState` 的结果：`cardPositionList` 里每张牌的归属 `owner = v & 7`（1..4）本来就由服务端广播，`GDSiteESP.buildXray` 把 `playerCardLists[1..4]` 转成下家 / 对家 / 上家手牌与炸弹预警；**没有** hook WebSocket、没有改请求、没有截图识别。开关关闭时透视数据不会进入快照，面板拿不到别家牌面。
- DeepSeek 只负责「从本地生成的合法候选里选一个」，不生成牌——所以即使模型返回不合法内容也会被校验 / 回退，绝不会点错牌。

## 文件结构

| 文件 | 说明 |
|---|---|
| `掼蛋AI助手.user.js` | **构建产物**（安装这个） |
| `build.js` | 拼装脚本（hullqin-shared 公共模块 + 以下模块 + body） |
| `gd.site.core.js` | 站点规则引擎：牌模型 / 牌型解释 / 压牌 / 回放 / protobuf / expandState / 走法生成 / 记牌器 / 贡牌候选（全局 `GDSite`） |
| `gd.site.esp.js` | 透视数据（纯函数）：三家手牌排序、炸弹 / 同花顺 / 四大天王预警、透视汇总（全局 `GDSiteESP`；不联网、不读 DOM） |
| `gd.site.ai.js` | 本地启发式：`handSummary / candidates / suggest`（全局 `GDSiteAI`） |
| `gd.site.remote.js` | DeepSeek 适配：组装 request、调用父目录通用模块、回退本地（全局 `GDSiteRemote`） |
| `gd.site.ui.js` | 面板 UI：记牌器 / 透视 / 建议区 / 操作按钮 / 设置与帮助弹窗（全局 `GDSiteUI`，纯渲染） |
| `userscript.body.js` | 桥接层：读 fiber → 解码 → 展开 → 渲染 / 回调 / 模拟点击 / 托管 / `window.__gdAI` 调试接口 |
| `gd.site.core.test.js` / `gd.site.esp.test.js` / `gd.site.ai.test.js` / `gd.site.remote.test.js` / `gd.site.ui.test.js` / `gd.site.verify.test.js` | Node 测试（禁联网） |
| `gd.test.js` | 聚合测试入口，解析各套件 PASS / FAIL 汇总 |
| `_fixture.html` / `_fixture.setup.js` / `_fixture.test.js` | 假 React fiber + 假站点 DOM 的端到端验收夹具（88 项，配合 Edge headless 使用）；`_fixture/parse-dump.js` 为 dump 结果解析工具 |
| `SPEC2.md` | 接口契约与逆向结论（维护者文档） |

父目录 `../` 是同一游戏的**独立离线网页版**（不需要站点 / 油猴）；两版共享 `../gd.deepseek.js` 通用模块。

## 构建 / 测试

```bash
# 构建（生成/更新 掼蛋AI助手.user.js）
node build.js

# 聚合测试：引擎 / 透视 / 本地 AI / DeepSeek 适配 / 面板 UI / 独立黑盒验收
node gd.test.js              # 全部
node gd.test.js core         # 只跑某个：core / esp / ai / remote / ui / verify / all
```

当前结果：**6/6 套件全绿，合计 2564 断言**
（引擎 225 · 透视 103 · 本地 AI 902 · DeepSeek 适配 293 · 面板 UI 256 · 独立黑盒 785；全部 Node 测试 mock 网络，禁联网）。

端到端夹具（可选，需要 Edge；脚本里路由校验要求路径含 `/ddz`，用目录联接绕过）：

```powershell
New-Item -ItemType Junction -Path .\ddz -Target .
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new --disable-gpu `
  --hide-scrollbars --window-size=1500,1100 --virtual-time-budget=25000 `
  --user-data-dir="$env:TEMP\gd-fx" --dump-dom `
  "file:///D:/下载/hullqin-helper-main/hullqin掼蛋/油猴版/ddz/_fixture.html" > _verify-dump.html
node _fixture/parse-dump.js _verify-dump.html   # 解析结果：PASS 88 / FAIL 0
cmd /c rmdir .\ddz                             # 只删目录联接，不动本目录文件
```

夹具模拟「我的手牌 / 站点按钮 / react fiber 状态 / 离线 fetch」，覆盖：掼蛋局面识别、记牌器 15 格逐格数字、透视默认关闭 / 开关 / 三家 81 张手牌与 localStorage 持久化 / 关闭后不再渲染、本地建议与一键出牌点中对应牌 + 出牌按钮、无 Key 时 DeepSeek 回退本地、设置保存、进贡 / 还贡 / 托管 / 非掼蛋房间提示、无未捕获错误。

> 夹具假定构建产物**未填** `HARDCODED_API_KEY`（部分断言检查「无 Key 时回退本地」）。如果产物已填 Key，请先临时清空、重建、跑夹具，再恢复。

### 调试

页面控制台可用 `window.__gdAI`：`dump()` 查看当前解码状态 / 快照、`xray()` 查看透视数据、`suggest()` 本地建议、`decode()` 原始 protobuf、`settings` 设置等。

## 已知限制

- 依赖站点前端结构（fiber props、DOM class、按钮文案）；站点改版后可能需要同步更新（调试时先看 `__gdAI.dump()` 里 `tickErr` / `snapshot`）。
- 托管是「轮到我时点一次」：配了 Key 走 DeepSeek 决策（失败/超时自动回退本地），无 Key 走本地建议；不做多步博弈策略。
- 浏览器直连 api.deepseek.com，有效 Key 会产生你自己的 API 费用；无 Key 时全部功能（除 DeepSeek 建议）可用。
- 仅覆盖掼蛋单局玩法内的记牌 / 透视 / 提示 / 托管；不修改任何游戏数据、不代打多桌。
- 透视只是把服务端本就广播给客户端、页面未渲染的牌面解码显示出来：不改变对局数据、不绕过服务器校验、不影响其他玩家操作；开关默认关闭，观战（未入座）时不可用。请仅用于学习 / 朋友间娱乐，勿用于损害他人体验或违反站点规则。

## 免责声明

本项目仅用于学习前端逆向与 AI 辅助，仅供朋友间娱乐；使用产生的一切后果自负，请遵守站点规则与当地法律法规。

## License

MIT
