# dsh-deepseek-web-login

把 **chat.deepseek.com 网页版**接进 DSH 的 LLM 服务：用浏览器登录态（而不是 API Key）
驱动 DSH 的 agent 能力。provider 路由：`deepseek-web`。

> ### ⚠️ 免责声明（请先读）
>
> - **非官方项目**：与 DeepSeek 无任何关联，未获其授权、认可或赞助。"DeepSeek" 为其权利人商标。
> - **使用风险自负**：本插件调用的是 chat.deepseek.com 的**网页端私有接口**（非官方 API），
>   这可能违反其服务条款，并可能导致你的账号被限流或封禁。请自行评估并遵守其条款，仅用于学习研究与个人使用。
> - **凭证安全**：本仓库不包含任何凭证。登录态由你在本机的 DSH 里登录后捕获，存放于
>   `~/.dsh/web-login/`（不在仓库内）。请在 issue / 截图里**不要**附带 token 或 cookie。
> - **按现状提供**：接口随时可能变更导致失效，作者不提供任何担保（见 Apache-2.0 §7）。

```
DSH agent loop ──▶ ctx.llm ──▶ [本插件适配器] ──▶ chat.deepseek.com
                                    │                  ├─ create_pow_challenge（SHA3 WASM 求解）
                                    │                  ├─ chat_session/create（每次调用临时会话）
                                    │                  └─ chat/completion（SSE patch 流）
                                    └─ 提示词 JSON 协议 ⇄ StreamChunk（含 tool-call 块）
```

## 当前网页端能力（按账号实测，2026-09）

权威来源：`GET /api/v0/client/settings?scope=model` 的 `model_configs`（实测 configVersion 81）：

| model_type | 名称 | enabled | switchable |
|---|---|---|---|
| `default` | 快速模式 | ✅ | ✅ |
| `expert` | 专家模式 | ❌ 已停用 | ❌ |
| `vision` | 识图模式 | ❌ 已停用 | ❌ |

即**专家/识图已被服务端停用并合并进「快速模式」**。下面的两条**不是两个模型**，
而是同一个「快速模式」的 `thinking_enabled` 开关两档预设（方便一键选；
也可在同一个档位上用推理强度切换）：

| 模型 id | thinking | 适用 |
|---|---|---|
| `deepseek-chat` | 关 | 工具调用、改写、检索类任务：直接作答、最快、最省免费额度 |
| `deepseek-reasoner` | 开 | 数学、多步调试、规划：先推理再作答（推理流作为思考块回传），更慢也更耗额度 |

历史选择里的 `deepseek-pro` / `deepseek-expert` / `deepseek-vision` 仍可用，
但会按别名回退到快速模式（不会报错，也不再出现在模型列表里）。

两个档位都**支持图片输入**（机制见「关键实现 → 图片」；实测上传左红右蓝 PNG 后模型答出「左=红色，右=蓝色」）。

服务端容量：`normal_history_and_file_token_limit = 890880`（= 1M 总量扣除输出预留后的可用预算）、
单请求 `input_character_limit = 2621440` 字符。本插件 contextWindow 声明 890880，
送出 prompt 的字符上限默认 1,200,000。

## 使用

1. **设置 → DeepSeek 网页登录**
2. 点「浏览器窗口登录」→ 在弹出的独立窗口里正常登录（插件不接触你的密码）
   - 已登录过的话窗口打开即自动捕获并自关；凭证丢了可点「从已登录窗口恢复」
   - 非 Electron 环境（纯 web profile）走「手动粘贴 Token」
3. **模型选择器**里选 provider `DeepSeek 网页版（免费）` + `DeepSeek 网页 · 快速模式`
4. 直接当普通模型用：agent 的工具调用、思考流都会正常工作

凭证存放：`${DSH_HOME:-~/.dsh}/web-login/deepseek-auth.json`（本插件自治，不进通用 settings/credentials 面）。

## 关键实现

| 环节 | 做法 |
|---|---|
| 登录捕获 | Electron `BrowserWindow` + `persist:dsh-deepseek-web-login` 分区；`webRequest.onBeforeSendHeaders` 旁路抓 `/api/*` 的真实 `Authorization`、Cookie、`x-hif-*`、`x-client-*` |
| token 形态 | ⚠️ 新版网页端 `localStorage.userToken` 是 **AppKit 包装 JSON** `{"value":"…"}`，必须解包；且未登录时该键是**游客 token**，必须持续刷新而非锁存 |
| 凭证策略 | **fail-open**：校验不通过也先落盘（校验端点可能不配合），真实判定交给「发送测试」；另提供「从已登录窗口恢复」 |
| PoW | `create_pow_challenge` → 用 DeepSeek 自己的 `sha3_wasm_bg.*.wasm` `wasm_solve` 求解 → `x-ds-pow-response`(base64 JSON)；WASM 地址支持**自动发现**（哈希随版本变） |
| SSE | 同时兼容两种格式：`response/fragments`（THINK/RESPONSE 片段）与直连 `thinking_content`/`content`，含 `{o:"APPEND"}` 与裸 `{v}` 续段；按逻辑流累积去重，快照重放不重复吐字 |
| 工具调用 | 网页端无原生 function calling → 提示词 JSON 协议（`{"tool_calls":[{"name":…,"arguments":{…}}]}`）+ 流式过滤器（跨包标记 hold-back、```围栏、多调用、假阳性回退）→ 合成 `tool-call` 块 + `finish: tool-calls` |
| 格式漂移兜底 | 思考模式下模型**偶发**改用 XML 标记（实测样本 `<tool_calls><invoke name="read"><parameter name="file_path">…</parameter></invoke></tool_calls>` 曾被当正文吐给用户）。双保险：① 指令显式禁止 XML/DSML 并说明后果（实测模型会主动拒绝该格式并改回 JSON）；② 解析器同时容忍 JSON 与 XML/DSML 两族（`\|DSML\|` 前缀、`dsml-` 连字符、裸 `<invoke>`、CDATA、围栏、跨包分片），解析不出才降级为正文 —— **绝不静默丢内容** |
| 会话卫生 | 每次调用新建临时会话，结束后尽力 `chat_session/delete` —— 实测调用前后网页端会话列表完全一致，不污染你的聊天记录 |
| **图片输入** | 网页端看图**不是**原生多模态入参，而是「上传成文件 + 引用」：`ctx.attachments.readImage(ref)` 取字节 → `POST /api/v0/file/upload_file`（PoW 场景 = 该路径）→ 拿 `file-xxxx`（`model_kind: VISION`）→ 完成请求带 `ref_file_ids`。模型声明 `inputModalities: ['text','image']`（否则运行时会先把图片投影成文字），上传结果按 `attachmentId` 缓存 2h 避免重复上传；上传失败则降级为文本标记（不阻断回答） |
| 历史序列化 | 单段 prompt：system → 工具协议与目录 → 转写（`User:` / `Assistant:` / `Assistant: {"tool_calls":…}` / `[Tool Result …]`），图片处留 `[image attached]` 定位标记，超长走中段截断 |
| 失败语义 | 自带 `failure`/`code` 自有属性（运行时按自有属性读取，跨 bundle 也保留 code）；错误码对齐 dsh-llm 默认可重试表（`TRANSPORT`/`TIMEOUT`/`RATE_LIMIT`/`SERVER`/`EMPTY_RESPONSE`），并识别网页端「HTTP 200 + 业务错误信封」（如 `40003 Authorization Failed` → `AUTH`） |

## 配置（插件 entry config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxPromptChars` | `1200000` | 送出的 prompt 字符上限（超出中段截断；服务器单请求上限 2621440 字符） |
| `idleTimeoutMs` | `120000` | SSE 空闲超时 |
| `deleteWebSessions` | `true` | 调用后删除临时网页端会话 |

## 已知限制

- **原生 tools 不存在**：工具调用靠提示词协议。模型偶发改用 XML 标记时已被解析器接住（见上），但格式漂移本质上是模型行为，无法 100% 保证
- **单次请求 60s 上限**（`completion_request_timeout_ms`）：网页端靠 `sse_auto_resume` 续接，**本插件不实现续接**；若流在没有 `FINISHED` 标记的情况下结束，会报 `max-tokens` 而不是假装正常完成
- **思考模式的推理过程不进上下文**：历史序列化只回放正文与工具调用/结果（推理块不回放），以省 token
- **图片**：走文件上传通道（见上）；历史里的旧图片每轮都会重新引用（靠 `attachmentId` 缓存避免重复上传）。上传失败时降级为 `[image attached]` 文本标记 —— 此时模型知道有图但看不到
- `describe_image` 是 DSH 侧的独立工具（调用外部视觉模型），与本插件无关；本插件的图片能力不依赖它
- `temperature` / `stop` / `max_tokens` 网页端无对应字段，会被忽略
- usage 是**估算值**（网页端不返回 token 计数）
- 免费额度有频控；`429` 会带上 `providerRetryAfterMs` 交给重试策略
- 走的是网页端私有接口，DeepSeek 改动即可能失效；请自担账号风险，遵守其服务条款

## 开发

```bash
node tests/logic-test.mjs          # 纯逻辑单测（序列化/工具过滤 JSON+XML/JSON 修复/SSE/token 解包/掩码）
node tests/probe-live.mjs          # 线上直连探针（原始事件流 + 时长；--big=N 验证长 prompt）
node tests/probe-xml-live.mjs      # 线上验证 XML 标记场景（指令劝阻 + 解析兜底）
node tests/probe-vision.mjs        # 线上验证图片通道（自造左红右蓝 PNG → 上传 → 提问）
node tests/check-bundle.mjs        # 产物核对（关键修复是否都进了 lib）
node tests/check-injector-guards.mjs   # 复核注入器注入前校验的正则
npx tsdown --config tsdown.config.ts   # 构建 host(lib/index.js) + client(lib/client.js)
bash scripts/build.sh                   # 同上（含 npx 兜底）
```

**迭代注意（实测坑）**：当前 DSH 版本（0.1.2-rc.1）移除了热重载所依赖的 loader API，
而 Node ESM 模块缓存以「解析后的文件路径」为键 —— 同一路径重新注入仍会命中旧模块实例。
因此改代码后需**换包名/换路径**注入：`node scripts/make-dev-copy.mjs <后缀>` 生成开发副本，
对副本注入（`DSW_PLUGIN_ID` 同步改 client 模块 id）。

## 装配

- 运行时注入（开发）：`dev_inject_plugin <dir>`
- 持久装配：profile `package.json` 加 `dependencies."dsh-deepseek-web-login": "link:<dir>"`
  并把它加入 `dsh.profile.bundles`；包内 `cordis.patch.yml` 会自注册 entry（**不要再手动 insert**，否则撞 `duplicate loader entry id`）
- ⚠️ 本机 DSH 跑的是 **desktop** profile；注入器的 junction 默认建在 `profiles/web/`，
  故 desktop profile 需自行建 junction（或 `dev_heal_links`）

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| 面板「未登录」且登录窗口里已登录 | 旧版 bug（把 AppKit 包装 JSON 当 token）已修；点「从已登录窗口恢复」 |
| `AUTH` / `40003 Authorization Failed` | 登录态过期 → 重新登录或「从已登录窗口恢复」 |
| `MISSING_CREDENTIAL` | 凭证文件不存在 |
| `EMPTY_RESPONSE` | 可能触发频控或长上下文截断，已计入默认可重试码 |
| `RATE_LIMIT` | 免费额度频控，稍后重试 |
| 工具调用不触发 | 换个说法或换 `deepseek-reasoner`；也可看「发送测试」输出确认链路 |
| 回复里出现 `{"tool_calls":…}` 或 `<tool_calls>` 标记文本 | 模型格式漂移（JSON 非法转义 / XML 标记）。解析器已两族兼容 + JSON 修复兜底；若仍出现请把原文贴进 issue（解析不出时按设计原样显示，不会静默丢内容） |

## 致谢（协议情报来源）

本插件的实现为**原创代码**，但网页端私有接口的行为（PoW 挑战与 WASM 求解约定、SSE patch 流结构、
文件上传与 `ref_file_ids` 引用、DSML/XML 工具标记变体等）是参考以下公开项目的文档与实现推断并实测验证的。
**这些项目的源码未包含在本仓库中**：

- [LLM-Red-Team/deepseek-free-api](https://github.com/LLM-Red-Team/deepseek-free-api)（最早的网页端逆向 API 实现）
- [Fly143/deepseek-free-api](https://github.com/Fly143/deepseek-free-api)（PoW 求解器、DSML 工具标记、SSE 格式注释）
- [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI)（浏览器登录捕获、PoW WASM 调用约定）

同时感谢 DeepSeek Harness 生态与 `dsh-super-injector`（运行时注入/侧挂开发链路）。

## 许可证

[Apache License 2.0](./LICENSE)（含专利授权与专利报复条款；**不授予**商标权，见 §6）。
版权与第三方说明见 [NOTICE](./NOTICE)。

再次强调：本项目是**非官方第三方插件**，与 DeepSeek 无关联；使用网页端私有接口的风险由使用者承担。
