# HullQin 游戏助手

[game.hullqin.cn（桌游合集）](https://game.hullqin.cn) 的六个油猴 AI 助手 + 整合版，外加一个独立离线的掼蛋离线版。
所有助手只读取页面状态、模拟点击，不拦截网络——服务器视角等同正常人类操作。朋友间娱乐使用。

> 仓库地址：[github.com/qiaoda2021/hullqin-helper](https://github.com/qiaoda2021/hullqin-helper) · 各助手脚本也可直接从 GitHub 安装（见各目录 README）

## 助手一览

| 目录 | 游戏 | 功能亮点 | 引擎 |
|---|---|---|---|
| `hullqin斗兽棋` | [斗兽棋 /dsq](https://game.hullqin.cn/dsq) | 💡提示 / 🤖代走；防死局三层机制 | negamax + 静态搜索 + 置换表（规则 1:1 逆向站点源码） |
| `hullqin国际象棋` | [国际象棋 /gjxq](https://game.hullqin.cn/gjxq) | 双引擎 + 1-10 难度 + 评估条 | Stockfish WASM（CDN）/ 自研 negamax |
| `hullqin五子棋` | [五子棋 /wzq](https://game.hullqin.cn/wzq) | 💡提示 / 🤖代走；思考深度 1-10 层 | negamax + 完整禁手判定（8 种规则全支持） |
| `hullqin斗地主` | [斗地主 /ddz](https://game.hullqin.cn/ddz) | 📋记牌器 / 💡出牌提示 / 🤖托管（含叫抢地主） | 牌型判定 1:1 复刻站点 + 启发式决策 |
| `hullqin跳棋` | [跳棋 /tq](https://game.hullqin.cn/tq) | 💡提示 / 🤖托管；2-6 人全布局 | negamax + 梯队评估 + 防死循环 |
| `hullqin掼蛋/油猴版` | [掼蛋 /ddz（玩法选「掼蛋」）](https://game.hullqin.cn/ddz) | 📋记牌器 / 💡本地提示 / ⚡一键出牌 / 🤖托管 / 🌐DeepSeek 建议 / 进贡·还贡辅助 | 站点规则 1:1 逆向（牌型/回放/进贡/protobuf）+ 启发式评分 + DeepSeek API（可选） |
| `hullqin掼蛋`（离线版） | —（独立离线网页，非站点脚本） | 📋记牌器 / 🃏手牌编辑 / 📝出牌记录 / 💡本地建议 / 🌐DeepSeek AI 建议（失败回退本地） | 规则引擎 + 启发式评分 + DeepSeek API（可选） |
| `hullqin-all` | **全部** | **整合版**：一个文件，按页面自动切换，统一 GUI | — |

## 使用

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 安装想要的脚本（各目录的 `*.user.js`，或整合版 `hullqin-all/HullQin游戏助手.user.js`）
3. 打开对应游戏页面，面板自动出现；进入本地对战或联机开局即可使用

> 掼蛋有两个版本：
> - **油猴版**（`hullqin掼蛋/油猴版/掼蛋AI助手.user.js`）：装进 Tampermonkey，打开 [game.hullqin.cn/ddz](https://game.hullqin.cn/ddz)，房间「玩法」选 **掼蛋**、4 人开局后面板自动出现；只读取本局状态，按需点「💡本地建议 / ⚡采用并出牌 / 🌐DeepSeek建议 / 🤖托管」。非掼蛋房间会提示「当前不是掼蛋玩法」。
> - **离线版**（`hullqin掼蛋/`）：不依赖油猴和站点，双击 `hullqin掼蛋/index.html` 即可使用。
>
> 两个版本的 DeepSeek AI 建议都需要在「设置」里填自己的 API Key（无 Key / 调用失败时自动回退本地建议）。

## 开发

```bash
cd hullqin五子棋 && node build.js   # 构建单个脚本
node xxx.test.js                    # 各目录内置引擎测试（共 195 项）
cd hullqin掼蛋 && node gd.test.js   # 掼蛋离线版：聚合测试（引擎 / 本地 AI / DeepSeek / 独立黑盒）
cd hullqin掼蛋/油猴版 && node build.js && node gd.test.js   # 掼蛋油猴版：构建 + 聚合测试（5 个套件）
```

- `hullqin-shared/` 公共模块：React fiber 状态读取、面板、覆盖层、构建库、注册壳
- 各游戏目录的 `*.core.js` 引擎不依赖 DOM，可在 Node 中测试（`node xxx.test.js`）
- 页面逆向结论写在各目录 README（ fiber props 结构、状态编码、交互方式）

## 测试结论摘要

- 斗兽棋：新旧引擎 A/B 新引擎 74% 胜率；500 局自对弈无显著先后手优势（详见其 README）
- 跳棋：搜索 75% 胜贪心基线，对局 100% 收敛
- 斗地主：52 项测试全过，真实联机局全流程验证
- 掼蛋离线版：引擎 256 + 本地 AI 79 + DeepSeek 模块 225 + 独立黑盒验收 8753 断言全过（聚合 `gd.test.js` 共 9313 断言），Edge headless 交互冒烟 75 项全过
- 掼蛋油猴版：站点规则 1:1 逆向（含进贡/还贡/抗贡/升级）；引擎 225 + 本地 AI 902 + DeepSeek 适配 293 + 面板 UI 231 + 独立黑盒 782 = 2433 断言全过（聚合 `gd.test.js`），假 fiber 端到端夹具（Edge headless）73 项全过

## License

MIT
