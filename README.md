<div align="center">

<img src="docs/assets/hero.svg" alt="dsh-deepseek-web-login — 用 chat.deepseek.com 网页版登录态驱动 DSH agent" width="900">

[**中文**](README.md) · [English](README.en.md)

<!-- badges -->
[![License](https://img.shields.io/badge/license-Apache--2.0-263146?style=flat-square&labelColor=0b1220)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5?style=flat-square&labelColor=0b1220)](https://github.com/deepseek-ai/deepseek-harness)
[![Provider](https://img.shields.io/badge/provider-deepseek--web-06b6d4?style=flat-square&labelColor=0b1220)](#模型档位)
[![Tests](https://img.shields.io/badge/tests-89%20assertions-10b981?style=flat-square&labelColor=0b1220)](#测试与验证)
[![CI](https://github.com/cv-superding/dsh-deepseek-web-login/actions/workflows/ci.yml/badge.svg)](https://github.com/cv-superding/dsh-deepseek-web-login/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cv-superding/dsh-deepseek-web-login?style=flat-square&labelColor=0b1220&color=f59e0b)](https://github.com/cv-superding/dsh-deepseek-web-login/releases)
[![Status](https://img.shields.io/badge/status-unofficial%20%C2%B7%20use%20at%20your%20own%20risk-ef4444?style=flat-square&labelColor=0b1220)](#免责声明)
[![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square&labelColor=0b1220)](#贡献)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&labelColor=0b1220&logo=node.js&logoColor=white)](#开发)

**把 chat.deepseek.com 网页版接进 DSH：用浏览器登录态（不是 API Key）驱动 agent 的工具调用、思考流与图片理解。**

</div>

---

## 这是什么

DSH（DeepSeek Harness）通过 `ctx.llm` 的 **provider 适配器**接入模型。本项目实现了 `deepseek-web`
这个 provider —— 它不调用官方 API，而是复用你**已登录的网页版**：PoW 挑战、会话、SSE 流式、
文件上传，全部走网页端私有接口。

于是：**在模型选择器里选 `DeepSeek 网页 · 快速模式`，就能用网页版免费额度跑 DSH 的 agent**。

```text
DSH agent loop ──▶ ctx.llm ──▶ [deepseek-web 适配器] ──▶ chat.deepseek.com
                                     │  ├─ PoW（SHA3 WASM 求解）
                                     │  ├─ chat_session（每次调用临时会话，用完即删）
                                     │  ├─ chat/completion（SSE patch 流）
                                     │  └─ file/upload_file（图片输入）
                                     └─ 提示词工具协议 ⇄ tool-call 块
```

<img src="docs/assets/architecture.svg" alt="架构与数据流" width="1000">

## 界面预览

设置页（**示意图**，非截图）：登录状态 / **当前账号（退出当前账号 · 退出并登录其它账号）** / 浏览器窗口登录 / 从已登录窗口恢复 / 手动 token / 连通性测试 / 模型列表。

<img src="docs/assets/panel-preview.svg" alt="DSH 设置面板 · DeepSeek 网页登录" width="820">

## 核心能力

| 能力 | 说明 |
|---|---|
| 🔐 **网页登录（无 API Key）** | Electron 独立分区窗口里正常登录，插件**旁路捕获**真实 `Authorization`、cookie、`x-hif-*` 指纹头与客户端版本头 |
| 🧩 **PoW 求解** | `create_pow_challenge` + DeepSeek 自家 `sha3_wasm_bg.*.wasm` 的 `wasm_solve`；WASM 地址**自动发现**（哈希随部署变化），失败自动回退 |
| 🌊 **流式** | 同时兼容 `response/fragments`（THINK/RESPONSE 片段）与直连 `thinking_content`/`content` 两套 SSE 格式，含 `{o:"APPEND"}` 与裸 `{v}` 续段；按逻辑流去重，快照重放不重复吐字 |
| 🛠 **工具调用** | 网页端没有原生 function calling → 提示词 JSON 协议 + 流式过滤器（跨包标记、围栏、多调用、假阳性回退）→ 合成 `tool-call` 块并给出 `finish: tool-calls` |
| 🛡 **格式漂移双保险** | ① 指令层显式禁止 XML/DSML 标记并说明后果（实测模型会主动拒绝该格式）；② 解析层同时容忍 JSON 与 XML/DSML 两族（`\|DSML\|` 前缀、`dsml-` 连字符、裸 `<invoke>`、CDATA） |
| 🩹 **非法 JSON 宽容修复** | 模型常把 Windows 路径写成单反斜杠：`\A` 是非法转义，而 `\r` **合法**却会把 `\resources` 静默变成回车。多候选修复链逐字还原路径，解析不出才降级为正文（**绝不静默丢内容**） |
| 🖼 **图片输入** | 走网页端文件上传通道（`/api/v0/file/upload_file` → `ref_file_ids`）。实测：上传自造的「左红右蓝」PNG，模型答出「左=红色，右=蓝色」 |
| 🧹 **会话卫生** | 每次调用新建临时会话并在结束后删除 —— 实测调用前后网页端会话列表**完全一致**，不污染你的聊天记录 |
| 🎛 **设置面板** | 状态展示、**退出当前账号 / 退出并登录其它账号**（连带清除浏览器分区登录态）、浏览器登录、从已登录窗口恢复、手动粘贴 token、连通性测试（host HTTP API：`/deepseek-web-login/api/*`） |

<img src="docs/assets/tool-bridge.svg" alt="工具调用协议桥" width="1000">

<details>
<summary><b>登录与凭证捕获流程（点击展开）</b></summary>

<img src="docs/assets/login-flow.svg" alt="登录与凭证捕获流程" width="1000">

</details>

## 快速开始

### 1. 安装

```bash
# 方式 A：从 Release 的 tgz 装配（推荐，免构建；版本号以最新 Release 为准）
dsh plugin --profile desktop add ./dsh-deepseek-web-login-0.1.3.tgz

# 方式 B：git 装配（本机需可访问 github.com）
dsh plugin --profile desktop add github:cv-superding/dsh-deepseek-web-login
```

> `--profile desktop` 是 DSH Desktop（Electron 应用）使用的 profile。若你跑的是 web profile，换成 `--profile web`。
> 重启 DSH 后生效（本插件是 bundle 装配，重启即自动加载）。

### 2. 登录一次

**设置 → DeepSeek 网页登录 → 浏览器窗口登录**，在弹出的窗口里正常登录（手机号 / 邮箱 / 验证码均可）。
捕获成功后窗口自动关闭，面板显示**已登录**。

- 凭证只存在本机 `~/.dsh/web-login/deepseek-auth.json`，**不在仓库里**；面板「当前账号 → 退出当前账号」一键清除（同时清掉浏览器分区里的登录态，保证真退出、可换号）
- 凭证丢了或校验不通过：点 **从已登录窗口恢复**（复用上次登录的持久化分区，无需重新登录）
- 非 Electron 环境（纯 web profile）：用面板里的**手动粘贴 Token**通道

### 3. 选模型开跑

模型选择器 → provider **`DeepSeek 网页版（免费）`** → `DeepSeek 网页 · 快速模式`，
然后照常用 agent（工具调用、思考流、贴图都可用）。

## 模型档位

权威依据：`GET /api/v0/client/settings?scope=model` 的 `model_configs`（按账号返回，实测 configVersion 81）

| model_type | 名称 | enabled | switchable |
|---|---|---|---|
| `default` | 快速模式 | ✅ | ✅ |
| `expert` | 专家模式 | ❌ 已停用 | ❌ |
| `vision` | 识图模式 | ❌ 已停用 | ❌ |

即**专家 / 识图已被服务端停用并合并进「快速模式」**。因此本插件只暴露两条 —— 它们
**不是两个模型**，而是同一个「快速模式」的 `thinking_enabled` 开关两档预设：

| 模型 id | thinking | 适合 |
|---|---|---|
| `deepseek-chat` | 关 | 工具调用、改写、检索：直接作答，最快、最省额度 |
| `deepseek-reasoner` | 开 | 数学、多步调试、规划：先推理再作答（推理流作为思考块回传） |

同一档位内也可用**推理强度**（Off/High）切换；历史里的 `deepseek-pro` / `deepseek-expert` / `deepseek-vision`
会按别名回退到快速模式，不报错。

**容量**（2026-09-11 逐字段核对 `GET /api/v0/client/settings?scope=model`，configVersion 81）：

- 单请求输入**硬上限**：`input_character_limit = 2621440` 字符（≈2.5 MiB 字符）
- 附件（file_feature）token 预算：`token_limit = 890880`（开不开思考都一样）
  —— ⚠️ 这个数字**不是上下文窗口**。曾经把它当上下文窗口写进代码与文档（还写成「1M 扣输出预留」），
  而 890880 = 870×1024，面板一按 ÷1024 显示就成了「870K」，看起来像「说好的 1M 缩水成 870K」。
- 上下文窗口：服务端没有这个字段，按 DeepSeek 标称的 **1M** 取 `1048576`（服务端自己的数字都是 1024 的整数倍）

本插件 contextWindow 声明 1048576，
prompt 字符上限默认 1,200,000（可配）。

## 配置

插件 entry config（`cordis.patch.yml` / profile bundles 装配时的 `config`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxPromptChars` | `1500000` | 送出 prompt 的字符上限（超出走中段截断：保系统提示+工具协议与最近回合） |
| `idleTimeoutMs` | `120000` | SSE 空闲超时 |
| `deleteWebSessions` | `true` | 调用后删除临时网页端会话 |

## 已知限制

- **原生 tools 不存在**：工具调用靠提示词协议；模型偶发格式漂移已被解析器与指令双重兜住，但本质是模型行为，无法 100% 保证
- **单次请求 60s 上限**（`completion_request_timeout_ms`）：网页端靠 `sse_auto_resume` 续接，**本插件不实现续接**；流在没有 `FINISHED` 标记的情况下结束时报 `max-tokens`，而不是假装正常完成
- **思考模式的推理过程不进上下文**：历史序列化只回放正文与工具调用/结果，以省 token
- **图片**：走上传通道；上传失败时降级为 `[image attached]` 文本标记（模型知道有图但看不到）
- `temperature` / `stop` / `max_tokens` 网页端无对应字段，会被忽略；usage 为**估算值**（网页端不返回 token 计数）
- 免费额度有频控；`429` 会带上 `providerRetryAfterMs` 交给 DSH 的重试策略
- `describe_image` 是 DSH 侧另一个独立工具（调用外部视觉模型），与本插件无关；本插件的图片能力不依赖它

## 测试与验证

```bash
node tests/logic-test.mjs            # 89 项断言（6 个测试文件）（序列化 / 工具过滤 JSON+XML / JSON 修复 / SSE / token 解包 / 掩码）
node tests/probe-live.mjs            # 线上直连探针：原始 SSE 事件流 + 时长（--big=N 验证长 prompt）
node tests/probe-xml-live.mjs        # 线上验证 XML 标记场景（指令劝阻 + 解析兜底）
node tests/probe-vision.mjs          # 线上验证图片通道（自造左红右蓝 PNG → 上传 → 提问）
node tests/probe-batch-live.mjs     # 线上复现事故 #4 的触发条件（深度思考 + 批量 3 条带 $env:/Windows 路径的命令）
node tools/changelog-section.mjs    # 从 CHANGELOG 取某版本段落（发布流程复用）
node tests/check-bundle.mjs          # 产物核对（关键修复是否都进了 lib）
node tests/check-injector-guards.mjs # 复核注入器注入前校验的正则
```

CI（`.github/workflows/ci.yml`）在每次推送到 `main` 与每个 PR 上跑上面两条命令；
打 `v*` tag 由 `.github/workflows/release.yml` 自动创建 Release 并附上 tgz（用仓库自带的 token，维护者无需持有个人令牌）。

多条断言直接固化自**真实事故现场**：

- 工具调用里含未转义 Windows 路径，曾导致解析失败、标记泄漏成正文 → 现在必须解析成功且**路径逐字还原**
- SSE 去重模型错误，曾把完整回答丢成「，」「不上」「了一圈」这类 1~3 字碎片（并触发 EMPTY_RESPONSE 重试）
  → 现在「缩水快照」与「分歧快照」都必须被忽略，回答**一字不丢**（见 CHANGELOG.md 0.1.1）
- 跨包工具调用标记的 hold-back 判断失效，曾让**合法 JSON** 泄漏成正文（分块把 `{"tool` 与 `_calls":…` 切开时）
  → 现在用**真实会话日志的分块序列**回归（见 `CHANGELOG.md` 0.1.2）
- 模型漏写调用对象的闭合括号（批量调用时每个少一个 `}`），曾让整段调用 JSON 泄漏成正文
  → 现在结构性补括号（**仅当数组已闭合**，被截断的流绝不补）+ 解析失败不再吐成正文（见 `CHANGELOG.md` 0.1.3）
- 会话被自己提前删除（建会话后立刻排定 1.5s 后删除 → PoW+建连超时就删掉了正在用的会话）
  → 现在删除只发生在流结束之后；会话失效还会换新会话透明重试（见 `CHANGELOG.md` 0.1.4）
- `envelopeError` 只看外层 `code`，把 `data.biz_code` 里的真实错误吞掉（`invalid chat session id` / `user is muted` 都被降级成看不懂的「非流式响应」）
  → 现在识别 `biz_code`，并区分「可恢复」「需等待」「重试没用」三类（见 `CHANGELOG.md` 0.1.4）

## 故障排查

| 现象 | 处理 |
|---|---|
| 面板「未登录」但登录窗口里已登录 | 点「从已登录窗口恢复」；或看 `loginProgress.lastError` |
| `AUTH` / `40003 Authorization Failed` | 登录态过期 → 重新登录或恢复 |
| `MISSING_CREDENTIAL` | 凭证文件不存在（`~/.dsh/web-login/`） |
| `EMPTY_RESPONSE` | 可能触发频控或长上下文截断，属于默认可重试码 |
| `RATE_LIMIT` | 免费额度频控，稍后重试 |
| 回复里出现 `{"tool_calls":…}` 或 `<tool_calls>` 标记 | 模型格式漂移。解析器已两族兼容 + 修复兜底；若仍出现请把原文贴进 issue（解析不出时不再把 JSON 吐进正文：本轮无其他正文则自动重试，已有正文则给一句提示） |
| 工具调用不触发 | 换说法或换 `deepseek-reasoner`；也可用面板「发送测试」确认链路 |

### 诊断工具：`tools/inspect-session.mjs`

怀疑「回复不对」时，不用猜 —— 直接读 DSH 的会话日志，看**每一轮的原始事实**：
用了哪个模型、内容块的真实长度与首尾、结束原因、以及流式分块的类型与字节数。

```bash
node tools/inspect-session.mjs                  # 列出会话（时间 / 大小 / 事件数 / 标题）
node tools/inspect-session.mjs <会话ID前缀>      # 诊断该会话的每一轮
node tools/inspect-session.mjs --search "关键词" # 按关键词找会话
```

它只读本机会话日志（不联网、不上传）。典型输出：

```text
[14:04:01] 模型: deepseek-web/deepseek-chat  ctx=1048576
[14:04:01] 分块原文(文本): ["I'll check what plugins exist"," for this in the DSH ecosystem",
                           ", and also look at the current"," GUI's capabilities.\n\n{\"tool",
                           "_calls\":[{\"name\":\"find_dsh", ...]
[14:04:03] 助手消息（1 块）: text(len=257) head="..." tail="...\"lang\":\"zh\"}}]}"
```

三条经验判据：

- 文本长度 **远小于** 分块字节数 → 解析层丢字
- 文本里出现 `{"tool_calls":…}` / `<tool_calls>` → 工具调用没被接住（格式漂移或 hold-back 失效）
- 同一 step 出现 **多次** `usage` / `finish` → 触发了重试（通常是空响应）

> **报 bug 时请附这段输出**（它不含凭证；如有敏感内容请先自行删减）。
> 上面三个真实事故（工具调用 JSON 泄漏、回答丢成碎片、合法 JSON 泄漏）都是靠它定位的。

## 开发

```bash
npx tsdown --config tsdown.config.ts   # 构建 host(lib/index.js) + client(lib/client.js)
bash scripts/build.sh                  # 同上（含 npx 兜底）
node scripts/make-dev-copy.mjs <后缀>   # 生成开发副本（见下）
```

**迭代注意（实测坑）**：当前 DSH 版本移除了热重载所依赖的 loader API，而 Node ESM 模块缓存以
「解析后的文件路径」为键 —— 同一路径重新注入仍会命中旧模块实例。改代码后需**换包名/换路径**注入：
`node scripts/make-dev-copy.mjs a1` 生成副本，配合 `DSW_PLUGIN_ID` 同步改 client 模块 id。

**装配要点**：包内 `cordis.patch.yml` 会自注册 entry，**不要再手动 insert**（会撞 `duplicate loader entry id`）；
DSH Desktop 用的是 `desktop` profile，而注入器的 junction 默认建在 `profiles/web/`，必要时手动补 junction。

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.en.md](README.en.md) | English README |
| [LICENSE](LICENSE) · [NOTICE](NOTICE) | Apache-2.0 全文 · 版权与第三方声明 |
| [docs/assets/](docs/assets) | 本文所有示意图（SVG 源文件，可自行改） |
| `src/protocol.ts` | 工具协议与流式过滤器（含每条修复策略的注释与实测案例） |
| `src/webapi.ts` | PoW / 会话 / SSE / 文件上传（含协议字段与端点注释） |
| `src/login.ts` | Electron 登录窗口与凭证捕获（含 AppKit token 解包等踩坑注释） |

## 贡献

欢迎 Issue / PR。提交前请先跑一遍上面的测试命令。**请注意**：

- 不要在 issue、日志或截图里附带 **token / cookie** 等凭证
- 报告工具调用格式问题时，请贴**模型原始输出**（含标点与反斜杠），那是最有价值的线索

## 致谢（协议情报来源）

本插件实现为**原创代码**，但网页端私有接口的行为（PoW 与 WASM 求解约定、SSE patch 流结构、
文件上传与 `ref_file_ids`、DSML/XML 工具标记变体）参考了以下公开项目的文档与实现，并逐项实测验证。
**这些项目的源码未包含在本仓库中**：

- [LLM-Red-Team/deepseek-free-api](https://github.com/LLM-Red-Team/deepseek-free-api) —— 最早的网页端逆向 API 实现
- [Fly143/deepseek-free-api](https://github.com/Fly143/deepseek-free-api) —— PoW 求解器、DSML 工具标记、SSE 格式注释
- [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) —— 浏览器登录捕获、PoW WASM 调用约定

同时感谢 DeepSeek Harness 生态与 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)（运行时注入 / 侧挂开发链路）。

## 免责声明

> ⚠️ **非官方项目**：与 DeepSeek 无任何关联，未获其授权、认可或赞助。"DeepSeek" 为其权利人商标。
>
> ⚠️ **使用风险自负**：本插件调用 chat.deepseek.com 的**网页端私有接口**（非官方 API），
> 可能违反其服务条款，并可能导致账号被限流或封禁。请自行评估、遵守其条款，仅供学习研究与个人使用。
>
> ⚠️ **凭证安全**：本仓库不含任何凭证；登录态由你在本机登录后捕获，存放于 `~/.dsh/web-login/`。
>
> ⚠️ **按现状提供**：接口随时可能变更导致失效，作者不提供任何担保（见 Apache-2.0 §7）。

## 许可证

[Apache License 2.0](LICENSE) —— 含专利授权与专利报复条款；**不授予**商标权（§6）。版权与第三方说明见 [NOTICE](NOTICE)。

<div align="center">
<sub>unofficial plugin · not affiliated with DeepSeek · use at your own risk</sub>
</div>
