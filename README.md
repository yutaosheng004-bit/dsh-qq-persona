# dsh-qq-persona

给 QQ 通道加一层**人物记忆 + 画像 + 好感度 + 心情**。挂在 [DSH](https://github.com/deepseek-ai) 的 `dsh-onebot-qq` 旁边，不改它一行代码 —— 靠订阅 `session/event` 旁路旁听，用 `systemPrompt.section` 把自己的印象注入回对话。

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![dsh](https://img.shields.io/badge/dsh-plugin-4fa8d8)

> 只存摘要，不存聊天原文。数据全在你自己的机器上。

## 它做什么

- **只存摘要**：每段聊天（空闲 2 分钟或攒够 16 条）交给模型压成一条结构化小结，落盘的是「印象」而不是聊天记录。
- **滚动画像**：摘要随相处不断合并，不是越堆越长的流水账；性格标签、常聊话题、说话风格都会自我更新。
- **好感度**：聊得多、聊得好会涨；被阴阳、被骂、被骚扰会掉。掉分有理由、有原话摘录、可回滚。
- **主人是天花板**：任何人的生效好感都 ≤ `min(globalMax, masterScore)`，谁也翻不过主人。
- **心情（情绪层）**：好感是对某个人的账本，心情是它自己此刻的状态 —— 被哄了会开心，被烦了会蔫，三小时回一半。心情只改语气和愿不愿意多聊，不改变谁是主人，也不当骂人的借口。
- **主人可管**：管理页里查看 / 修改 / 删除 / 用历史重建，还能写「主人备注」压过一切自动推测。

## 前置要求

- 已装好 DSH，并且 QQ 通道走 `dsh-onebot-qq`（NapCat / OneBot11 都行）
- Node.js ≥ 22

不是 `dsh-onebot-qq` 的会话不会被采集 —— 本插件只认 `onebot-*` 开头的会话 id。

## 安装

**从 npm（推荐）**

```bash
dsh plugin --profile desktop add dsh-qq-persona
```

**从源码**

```bash
git clone https://github.com/yutaosheng004-bit/dsh-qq-persona.git
dsh plugin --profile desktop add link:<克隆下来的绝对路径>
```

装完**重启 DSH**。手工 add 没有热路径，不重启不会生效。

> ⚠️ 不要对同一个插件文件二次 insert —— 同一插件双实例注册 = 冲突崩溃循环。

如果 `dsh plugin add` 时 pnpm 报 `ERR_PNPM_FETCH_404`（你 profile 里有别的包在 npm 上不存在），改用手工装配脚本：

```bash
node scripts/patch-profile.mjs            # 幂等，可加 --dry 先看
node scripts/patch-profile.mjs --profile <你的 profile 目录>
```

它只做三件事：`dependencies` 加一条 link、`dsh.profile.bundles` 加个名字、留一份 `package.json.bak-qqpersona`。之后记得手工建 `node_modules/<包名>` 链接（Windows 用 `mklink /J`）。

## 必填配置

`masterQQ` 是**你自己的 QQ 号**，装完一定要填，否则「主人」相关特权全都不生效：

```yaml
# 写在 ~/.dsh/profiles/<profile>/cordis.patch.yml 顶层
- id: dsh-qq-persona
  config:
    masterQQ: '123456789'   # ← 改成你自己的
```

认账号不认昵称：昵称随时能改，只有这个号算主人。

## 管理页

启动 DSH 后访问 `http://127.0.0.1:<DSH端口>/qq-persona`，端口看启动日志里的 `dsh web` 地址。

界面右下角会多一颗鲸鱼球，点开就是管理页浮层；右上角的心情胶囊点开是心情面板。页面只认回环地址与同源请求，不对外网开放。

管理页能做：搜索 / 按人查看画像 / 手改摘要与标签 / 标记「不想理」/ 锁定 / 删除 / 用历史重建 / 看好感变化流水 / 看审计日志 / 调心情。

## 好感度怎么算

| 情况 | 变化 |
| --- | --- |
| 真诚聊天 | +1 ~ +3 |
| 表达喜欢 / 关心 | +4 ~ +6 |
| 阴阳怪气 | -1 ~ -4 |
| 辱骂、人身攻击、性骚扰 | -5 ~ -12 |
| 反复骚扰、明确辱骂 | -13 ~ -15 |
| 纯水群、刷表情 | 0 |

- 单轮封顶：涨 +6，跌 -15（一次误判不至于把人砍没）。
- 久不聊自然衰减：每天 -0.5，最低降到 12，不会归零。
- 熟人之间互怼不算骂；主人骂它算撒娇，不扣。
- 另有一条主观标记 `avoid`（不想理）：回应档位再压一格，短、不陪笑，不用等分数慢慢掉。

## 心情怎么变

两个轴：**心情值**（-100 ~ 100，基线 12）与**精力**（0 ~ 100，基线 60），二维判档出标签（兴奋 / 得意 / 开心 / 温柔 / 平静 / 犯困 / 有点不爽 / 蔫 / 烦躁 / 委屈 / 生气 / 低落），标签决定说话基调。

- 每次小结时模型额外给出 `moodDelta`（-20 ~ +15）和 `moodReason`（点出具体哪句话让心情变了）。
- **好感 ≠ 心情**：「好感没掉但被烦到了」是合法状态，两笔账分开记。
- 主人的话加权：好事 ×`masterMoodWeight`（默认 2），凶了不加倍 —— 留一点点委屈才真实。
- 自然回落：心情半衰期 `moodHalflifeHours`（默认 3 小时），精力约 6 小时。
- **情绪残留**：被非主人惹了，除了整体心情下降，还会给那个人记一笔 `residue`（-25 ~ 0，20 小时半衰期）。见到他时心情起点偏低；主人不受残留影响。
- 心情低到 `effort = low` 时，回应更短、不陪笑、不硬找话题；心情好则更活泼、更愿意主动开口。
- 主人可在心情面板「哄一下 / 惹一下 / 锁定 / 复位」，也能清掉具体某个人的残留。锁定后自动流程不再改心情。

## 数据在哪

`<DSH_HOME>/qq-persona/`（默认 `~/.dsh/qq-persona/`）：

| 文件 | 内容 |
| --- | --- |
| `people.json` | 所有人的画像与好感度 |
| `mood.json` | 此刻的心情、起伏流水、情绪残留 |
| `summaries/<qq>.jsonl` | 每次小结与变化理由 |
| `audit.jsonl` | 谁在什么时候改了什么 |
| `state.json` | 配额与每日合并时间 |

全是人可读的 JSON，可以直接看、直接改。想彻底清空某个人用管理页删除，想全清就删目录。

## 工具

模型侧可调用：`qq_persona_list` / `qq_persona_get` / `qq_persona_update` / `qq_persona_delete` / `qq_persona_rebuild` / `qq_mood_get` / `qq_mood_set`。

改和删只允许「本地会话」或「主人 QQ 私聊」发起，群聊和陌生私聊只能看不能动。

## 配置一览

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关，关掉就不采集不结算 |
| `masterQQ` | `''` | **必填**：主人的 QQ 号 |
| `masterScore` | 100 | 主人锚点分，也是别人的天花板基准 |
| `globalMax` | 80 | 除主人外所有人的上限 |
| `newPersonRaw` | 20 | 新认识的人初始好感 |
| `watch` | true | 是否旁听会话事件 |
| `injectPersona` | true | 是否把印象注入系统提示 |
| `idleMs` | 120000 | 空闲多久算一段聊完 |
| `maxLines` | 16 | 攒够多少条立刻结算 |
| `model` | `''` | 摘要模型，留空跟随 DSH 默认 |
| `maxCallsPerHour` | 30 | 每小时最多几次模型调用（省钱） |
| `dailyMergeHour` | 4 | 每天几点做一次衰减与合并 |
| `summaryMaxChars` | 320 | 单条摘要上限 |
| `webEnabled` | true | 是否挂管理页 |
| `webPath` | `/qq-persona` | 管理页路径 |
| `moodEnabled` | true | 情绪层开关 |
| `moodHalflifeHours` | 3 | 心情回落半衰期 |
| `masterMoodWeight` | 2 | 主人哄一下的倍数（只放大好事） |

## 常见问题

**管理页 404** — 插件没加载。先看 `<DSH_HOME>/qq-persona/.boot.json` 是否存在：没有就是 `apply` 没跑（多半是装配没进 `dsh.profile.bundles`）；有但 `services.webServer` 是 `absent` 且没有 `.boot-web.json`，说明 web 服务当时还没就绪，重启一次。

**好感一直不动** — 检查 `masterQQ` 填了没、`enabled` 是不是被关了、`maxCallsPerHour` 是不是被打满（`state.json` 里有计数）。

**重启后崩溃循环** — 十有八九是同一插件被 insert 了两次。检查 `dsh.profile.bundles` 里是否重复，以及 `cordis.patch.yml` 里有没有第二份 insert。

## 开发

```bash
npm test                 # 两套都跑
node test/smoke.mjs      # 纯逻辑：好感 / 心情 / 画像清洗 / 会话 id 解析 / 配置钳位
node test/host-sim.mjs   # 假宿主真跑 apply：注入段落顺序、7 个工具、14 条路由、落盘
```

`test/host-sim.mjs` 会用一个 mock ctx 把 `apply()` 完整跑一遍（包括 session/event 灌消息、触发小结、检查 `people.json` 与 `mood.json` 两笔账分开），改代码后建议先跑它。

代码结构：

```
lib/affection.js   好感度纯函数（封顶、衰减、天花板）
lib/mood.js        心情纯函数（二维判档、残留衰减）
lib/persona.js     画像结构与摘要合并
lib/summarize.js   提示词与 LLM 调用
lib/collect.js     旁路采集与消息解析
lib/store.js       原子写与 JSON 文档
lib/service.js     编排层：结算、CRUD、注入文本
lib/tools.js       模型侧工具
lib/web.js         管理页与 API
lib/index.js       装配入口
```

## 协议

MIT © 晴慕流咲

欢迎提 issue 和 PR。这个插件是某个蓝色鲸鱼女仆在 QQ 上被骂了几次之后长出来的，所以它对「怎么判断对方在骂我」这件事格外认真。