<div align="center">

<img src="docs/assets/hero.svg" alt="dsh-deepseek-web-login — 用 chat.deepseek.com 网页版登录态驱动 DSH agent" width="900">

[**中文**](README.md) · [English](README.en.md)

<!-- badges -->
[![License](https://img.shields.io/badge/license-Apache--2.0-263146?style=flat-square&labelColor=0b1220)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5?style=flat-square&labelColor=0b1220)](https://github.com/deepseek-ai/deepseek-harness)
[![Provider](https://img.shields.io/badge/provider-deepseek--web-06b6d4?style=flat-square&labelColor=0b1220)](#模型档位)
[![Tests](https://img.shields.io/badge/tests-111%20assertions-10b981?style=flat-square&labelColor=0b1220)](#测试与验证)
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

设置页（**真实截图**）：当前账号 / 登录状态（适配器注册、凭证来源、PoW WASM、服务端校验）/ 三种登录方式（Microsoft Edge · 我的默认浏览器 · 从已登录窗口恢复）/ 手动粘贴 token。

<img src="docs/assets/screenshot-settings.png" alt="DSH 设置面板 · DeepSeek 网页登录（真实截图）" width="820">

DSH「使用统计」里看到的调用量 —— 免费网页通道，当日 1042.8 万 tokens / 164 次调用：

<img src="docs/assets/screenshot-usage-stats.png" alt="DSH 使用统计 · deepseek-web 免费通道调用量" width="820">

设置页**示意图**（标注各区块用途）：登录状态 / **当前账号（退出当前账号 · 退出并登录其它账号）** / 浏览器窗口登录 / 从已登录窗口恢复 / 手动 token / 连通性测试 / 模型列表。

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
登录窗口报的是**干净 Chrome UA**（不含 Electron 字样，UA-CH 品牌也清过）—— 否则网页端会判定
「使用环境异常」直接拒绝服务；若仍被拦，用同一行的 **用我的默认浏览器登录**，按提示用 F12 取 token 粘贴。
捕获成功后窗口自动关闭，面板显示**已登录**。

- 凭证只存在本机 `~/.dsh/web-login/deepseek-auth.json`，**不在仓库里**；面板「当前账号 → 退出当前账号」一键清除（同时清掉浏览器分区里的登录态，保证真退出、可换号）
- 凭证丢了或校验不通过：点 **从已登录窗口恢复**（复用上次登录的持久化分区，无需重新登录）
- 非 Electron 环境（纯 web profile）：用面板里的**手动粘贴 Token**通道

### 3. 选模型开跑

模型选择器 → provider **`DeepSeek 网页版（免费）`** → `DeepSeek 网页 · 快速模式`，
然后照常用 agent（工具调用、思考流、贴图都可用）。

> ⚠️ **一个账号同时只开一个聊天窗口**：多开并发会触发网页端临时封禁（1 天）——要开多个窗口就换账号，或把多余的窗口换到别的 provider。详见[已知限制](#已知限制)。

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
| `autoContinue` | `true` | 回答在句中被截时自动发起新请求续写（无缝拼进同一条回答）；截断提示从此不出现 |
| `maxContinuations` | `2` | 自动续写的最大轮数（每轮是一次新的网页端请求，调高消耗更多免费额度） |
| `minRequestIntervalMs` | **`2000`** | 请求间隔**区间下限**（毫秒），从上次调用**结束**时刻算起 |
| `maxRequestIntervalMs` | **`4000`** | 间隔**区间上限**；实际等待在 `[下限, 上限]` 内**随机**取值（上下限相等＝固定间隔） |
| `allowConcurrent` | **`false`** | 是否允许同一账号并发请求。默认串行，多个调用排队（FIFO） |
| `sessionCleanup` | **`deferred`** | 临时会话清理：`immediate`＝结束后 1.5s 删 / `deferred`＝攒批集中清理（默认）/ `keep`＝不删 |
| `sessionCleanupDelayMs` | `90000` | deferred：从第一个会话入队起最多等多久就清理 |
| `sessionCleanupBatchSize` | `8` | deferred：攒够多少个立即清理 |
| `transport` | **`chromium`** | 传输层：`chromium`＝Electron 的 `net.fetch`（指纹与真实浏览器一致）/ `node`＝Node 原生 fetch |

### 请求节流：为什么需要，值该给多少

网页端对**同一账号**同时只能生成一条，并发生成会被直接拒绝；实测更严重的是**账号级限制**：
两个窗口并发生成，不到 6 分钟就触发 **1 天**的临时限制（登录态没坏，但期间该账号所有请求被拒）。

而 DSH 本身会并发调用同一个账号 —— 从插件日志反推 272 轮调用的起止时间，发现 **16 对真重叠**：
重叠的一方是主回答，另一方只有 8~17 字、耗时 1~3 秒，那是 DSH 的**会话标题生成**
（`options.purpose === 'session-title'`）。也就是说你还在等回答时，另一个请求已经发往同一账号了。

所以插件默认做了两件事：**串行**（一次只放行一条，含标题这类辅助调用）+ **两次调用之间至少间隔 3 秒**。

| 场景 | 间隔区间（min~max） | `allowConcurrent` |
|---|---|---|
| **推荐（默认）** | `2000~4000` | `false` |
| 追速度、只跑短任务 | `1500~2500` | `false` |
| 已被限流过 / 高密度自动化（多步骤工具调用） | `5000~9000` | `false` |
| 完全关闭节流（**不建议**，会恢复并发重叠） | `0~0` | `false` |
| 实验：还原 DSH 原生并发 | 任意 | `true` ⚠️ |

**为什么是区间而不是固定值**：固定间隔的方差≈0，统计上就是明显的「定时器特征」；
同一场景的开源项目 cuckoo-code（从未被风控）用的正是 `2000~4000ms` 随机区间。

### 会话清理（为什么默认不是「立刻删」）

一次模型调用要发 4 个请求：建会话 → 取 PoW → completion → 删会话。其中
「**每轮新建一个临时会话、用完立刻删掉**」是最强的机器行为特征之一 —— 真人绝不会每 30 秒建删一次对话。

**为什么不能干脆复用会话**：DSH 每次把**全量历史**交给适配器，而网页端会话是**有状态**的，
复用会让服务端同时看到「会话自身的历史」和「我们重发的全量 prompt」两份上下文，很快撑爆窗口。
所以只能优化**删除侧**：`deferred`（默认）攒够 8 个或 90 秒后集中清理，
并且**优先用一个请求批量删**（服务端支持的话 N 个会话只花 1 个请求；不支持则自动回退为逐个删，
此后不再尝试）。想要彻底不留记录就选 `keep`（请求最少，但网页端会留下临时会话）。

> 间隔按「上一次调用**结束**」起算，所以长回答（几十秒）之后不会额外白等 —— 它只在
> 「结束 → 下一个开始」这段真正密集的空隙里起作用。
> **两种改法**：① 设置页最下方的「请求节流（防风控）」卡片里直接调 —— 开关 + 滑块 + 三个快捷档位，
> 改完**即时生效**并自动落盘；② 写在插件 entry config 里（改完需重启 DSH）。
> 优先级：**设置页保存的值 > entry config > 内置默认**（设置页是显式操作，不会被配置文件里的旧值盖回去），
> 落盘位置 `${DSH_HOME:-~/.dsh}/web-login/gate.json`。「登录状态」卡里也会显示当前生效值。

### 传输层（指纹）：默认走 Chromium 网络栈

网页端请求的网络栈决定了「在服务端眼里你是浏览器还是一个脚本」。实测三方对比（同机同日）：

| | JA4 | cipher 列表哈希 | ALPN |
|---|---|---|---|
| Node fetch(undici) | `t13d5212h1_…` | — | **h1** |
| Chrome（本机 152） | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `8daaf6152771` | h2 |
| **默认：net.fetch（Electron 43）** | `t13d1516h2_8daaf6152771_806a8c22fdea` | **`8daaf6152771`** | h2 |

Node 的请求在 **TLS 层**就能被判定为非浏览器（不走 HTTP/2、cipher 数量差 3 倍多、不带 GREASE），
而且这几项**调参修不了**。改用 Electron 的 `net.fetch` 后走 Chromium 内置网络栈，
cipher 列表哈希与 Chrome 逐字节一致 —— 且**零新依赖**（不用 uTLS / curl-impersonate）。
唯一残留差异是扩展数 16 vs 17（内置 Chromium 150 vs 本机 Chrome 152，版本差异，属正常）。

设置页「传输层（指纹）」卡可以直接切换，并带一个**零额度的一键测试**
（回显指纹 / 流式 / 鉴权三项结论）。

⚠️ **切到 Chromium 后请求会跟随系统代理**（Node 则完全无视代理）。
如果梯子关闭时系统代理仍指向 `127.0.0.1:7897`，请求会失败 —— 这时切回 `node` 即可。

## 已知限制

- **同账号同时只能开一个聊天窗口**：网页端按账号限制并发生成，多开会触发服务端的**临时封禁（1 天）**——登录态没坏，但期间该账号所有请求都会被拒。要多窗口就换账号，或把多余的窗口换到别的 provider
- **原生 tools 不存在**：工具调用靠提示词协议；模型偶发格式漂移已被解析器与指令双重兜住，但本质是模型行为，无法 100% 保证
- **单次请求 60s 上限**（`completion_request_timeout_ms`）：网页端靠 `sse_auto_resume` 续接，**本插件不实现续接**；流在没有 `FINISHED` 标记的情况下结束时报 `max-tokens`，而不是假装正常完成
- **思考模式的推理过程不进上下文**：历史序列化只回放正文与工具调用/结果，以省 token
- **图片**：走上传通道；上传失败时降级为 `[image attached]` 文本标记（模型知道有图但看不到）
- `temperature` / `stop` / `max_tokens` 网页端无对应字段，会被忽略；usage 为**估算值**（网页端不返回 token 计数）
- 免费额度有频控；`429` 会带上 `providerRetryAfterMs` 交给 DSH 的重试策略
- `describe_image` 是 DSH 侧另一个独立工具（调用外部视觉模型），与本插件无关；本插件的图片能力不依赖它
- **默认走 Chromium 网络栈**（Electron 的 `net.fetch`），TLS/HTTP2 指纹与真实浏览器一致；
  但它会跟随**系统代理**，梯子关着而系统代理仍指向它时会连不上 —— 设置页「传输层（指纹）」切回 Node 即可

## 测试与验证

```bash
node tests/logic-test.mjs            # 111 项断言（8 个测试文件）（序列化 / 工具过滤 JSON+XML / JSON 修复 / SSE / token 解包 / 掩码）
node tests/probe-live.mjs            # 线上直连探针：原始 SSE 事件流 + 时长（--big=N 验证长 prompt）
node tests/probe-xml-live.mjs        # 线上验证 XML 标记场景（指令劝阻 + 解析兜底）
node tests/probe-vision.mjs          # 线上验证图片通道（自造左红右蓝 PNG → 上传 → 提问）
node tests/probe-batch-live.mjs     # 线上复现事故 #4 的触发条件（深度思考 + 批量 3 条带 $env:/Windows 路径的命令）
node tools/changelog-section.mjs    # 从 CHANGELOG 取某版本段落（发布流程复用）
node tests/check-bundle.mjs          # 产物核对（关键修复是否都进了 lib）
node tests/check-injector-guards.mjs # 复核注入器注入前校验的正则
node tests/check-fetch-injection.mjs  # 传输层注入必须"每次现取"（防单测静默打到线上）
node tests/check-net-diagnostics.mjs  # net.fetch 诊断通道（标记文件生命周期 + 流式探针正反向）
node tests/check-transport.mjs       # 传输层选择（降级判定 + 注入层真的跟着变）
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
| 报错里带「临时限制」/ `user is muted` | **账号被网页端临时限制**（不是插件问题）：登录态有效、建会话也正常，只有发消息被拒。消息里会给出解除时间；等解除或改用其它账号/官方 API key |
| 「浏览器窗口登录」点了没反应，host 日志有 `fromPartition` 报错 | DSH 把插件宿主挪到了 **utility 进程**（没有窗口 API）→ 0.1.7 起改用**真实 Edge/Chrome + CDP** 登录：面板会显示「宿主进程」，按钮变成「用 Microsoft Edge 登录」。升级插件 + 重启 DSH 即可 |
| 面板显示「Cookie / 指纹头 未捕获」 | 说明你走的是**手动粘贴 token** 那条路（该路径本来就没有这两项）。实测仅凭 Bearer token 即可完成校验、PoW 求解与真实生成；若日后频繁遇到 `AUTH` / `40003`，改用「浏览器登录」获取更完整的凭证（token + cookie + 指纹头） |
| 报错 `A message is being generated, please try again later.` | **这个报错本身不是封号**：同一账号同时只能生成一条消息（另一个窗口/标签页正在生成），0.1.9 起自动重试。但别把多开当常态 —— 多窗口并发会触发服务端的**临时封禁（1 天）**，见[已知限制](#已知限制)；建议一个账号只保留一个窗口，多开请换账号或换 provider |
| 正文里出现 `<ds_system>…</ds_system>` / `<system>…</system>` | 模型在**模仿**系统消息格式（与转写回声同类）。0.1.11 起自动剥离，不上屏 |
| 回复在句中截断但没报错 | 服务端在句中截断却发了 FINISHED（12s 内即断，不是 60s 上限）。0.1.11 起启发式检测并报 `max-tokens`，让 UI 提示「可能被截断」 |
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

### 诊断：传输层（`net.fetch` / TLS 指纹）

网页端请求默认由 Node 的 `fetch`（undici）发出，指纹与真实浏览器**结构性不同**。
想确认「换成 Chromium 网络栈」是否可行时，跑一次探测 —— **默认零额度**，不生成、不发消息：

```bash
# 宿主进程的 HTTP 端点只有 DSH 自己的页面打得通（外部 curl 会撞同源守卫），所以走文件这条路：
echo '{"mode":"probe"}' > "$HOME/.dsh/web-login/probe-request.json"
# 重启 DSH，日志里会打出  deepseek-web: [net-fetch 探测] {...}
```

三步各看一个结论：

| 步骤 | 看什么 | 判定 |
|---|---|---|
| ① 指纹 | `ja4` / `http_version` / `http2_hash` | 变成 `t13d…h2…` 且带 GREASE ＝ 与 Chrome 一致 |
| ② 流式 | `hasBody` / `chunks` / `abortedEarly` | 三项都为真才能读 SSE（否则改造路线不成立） |
| ③ 鉴权 | `status` / `body` | 200 且能读出账号 ＝ header/cookie 原样透传 |

（设置页「传输层（指纹）」卡里也有**一键测试**，走的就是这个接口。）

想连 DeepSeek 的 SSE 一起端到端验证（**会消耗一点额度**）：把 `probe` 换成 `stream`。
文件被读取后会改名为 `probe-request.json.done-<时间戳>`，不会每次启动都重跑。


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

## 交流群

用法讨论、蹲更新，或者踩到坑想吐槽，欢迎加 QQ 群：

<p align="center">
  <img src="docs/assets/qq-group.jpg" alt="QQ 群二维码" width="300">
  <br>
  <sub>QQ 群号：<strong>1124773537</strong></sub>
</p>

<div align="center">
<sub>unofficial plugin · not affiliated with DeepSeek · use at your own risk</sub>
</div>
