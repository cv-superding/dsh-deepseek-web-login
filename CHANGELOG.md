# Changelog

本项目遵循大致语义化版本；日期为本地时间。

## 0.1.16 — 2026-09-11

### 修复

- **模型复读 prompt 里的截断占位符**（用户实测 17:2x，会话 1.2M tok 已超模型 1M 窗口，
  中段历史必然被截）：正文里出现 `truncated]` / `[Assistant truncated]`，并被模型接着往下写。
  这些占位符来自 DSH 核心的压缩标记与 serializePrompt 的省略标记（`[N chars omitted]`），
  会话超长后就躺在 prompt 里，模型照抄。
  - `ECHO_INLINE_SIGNATURES` 增补：`[truncated]` / `assistant truncated` / `[N chars omitted]`。
  - 行级新增：单独一行 `truncated]`（占位符被拦腰切开的残片）也判回声。
  - 围栏代码块内不判（讨论截断机制的正常回答不受影响）。

### 测试

- `check-transcript-echo` 13 → **16 项**：占位符复读（正文保留）、`[N chars omitted]`、分块到达。

## 0.1.15 — 2026-09-11

### 修复

- **转写回声换了个前缀就绕过了守卫**（用户实测 17:07，install-plugin 工作区）：
  模型输出的不再是以 `[Tool Result` 开头的行，而是
  ```
  Assistant: [Tool Result for call_7b1a7d39a2e54bc0b8f1]
  direct ERR fetch failed
  ```
  加了 `Assistant: ` 前缀后，行首不再匹配回声特征 → 被当成「正文里偶尔出现的
  `User:` 字样」放行，还把后面那行也一起带出来。
  - 新增 **行内任意位置** 的转写特征判据（`ECHO_INLINE_SIGNATURES`）：
    `[Tool Result` / `[status:` / `[Truncated]` / `[System]` / `[Assistant]`
    —— 只要一行里含有这些标记就判回声，不再要求行首。
  - 光秃秃的 `Assistant:` / `User:`（冒号后没有内容）视为模型在起一行假转写，直接拦下
    （以前它会被扣住，然后在 flush 时当作正文放行）。

### 测试

- `check-transcript-echo` 10 → **13 项**：带头像前缀的回声（整段 / 分块到达）、
  裸 `Assistant:`、以及原有判据不回归。

## 0.1.14 — 2026-09-11

### 修复

- **账号级节流被误判成不可重试，整轮直接失败**（用户实测 16:11，SSE error 事件）：
  服务端说 `消息发送过于频繁，请稍后重试`，而并发那条判据匹配的是 `请稍后再试` —— **差一个字**，
  于是落到 `PROVIDER_ERROR`（不可重试），只能手点「继续」。
  - 新增 `isThrottled()`：`过于频繁` / `太频繁` / `too many requests` / `rate limit` / `稍后重试` / `限流`。
  - 归为可重试的 `RATE_LIMIT`，退避 **20s**（并发那条只给 5s：撞得越勤越可能延长限制）。
- **两种 RATE_LIMIT 的文案不再串台**：事件新增 `rateLimitKind: 'concurrent' | 'throttled'`，
  适配器据此给准确说明 —— 节流不再被说成「另一个窗口正在用同一账号生成」，
  并明确告诉用户「这不是封号，登录态有效，等几分钟或降低步骤密度」。

### 测试

- `check-session-lifecycle` 13 → **15 项**：`isThrottled` 判据（且不误伤会话失效/mute）、
  节流 SSE 事件必须带 `RATE_LIMIT` + `rateLimitKind=throttled` + 退避 ≥20s。
- `check-auto-continue` 13 → **14 项**：节流文案必须说「限流」、不得出现「另一个窗口」，且透出退避时间。

## 0.1.13 — 2026-09-11

用户实测反馈串起来的几个问题（回答错位、静默少一段、网页端声明上屏、莫名反复续写），
根因都在「流式文本管线的收尾」这一段，本版一并修掉。

### 修复

- **轮末吐净顺序反了 → 正文最后一段前后颠倒**（实测：正文停在「…原来的 `pelican.svg` 保持」，
  而下一段却以「不动，」开头）。三层缓冲的吐净顺序改为流水线**反序**（回声守卫 → 声明剥离 → 工具调用过滤器）：
  每层扣住的是「它收到的尾部」，所以越深的层扣住的文本越早。错位文本此前还会作为「半截回答」
  进续写 prompt，让后续几轮越滚越乱。
- **剥离网页端免责声明**：DeepSeek 网页端在**每一轮**回复末尾自动追加
  `本回答由 AI 生成，内容仅供参考，请仔细甄别`。它有两个后果：① 自动续写的缝正好落在它后面，
  于是它卡在两条回答中间上屏；② 它以「甄别」（汉字、无标点）结尾 → 句中截断判据**每轮恒为真**
  → 明明正常收尾也被判成「被截」→ 反复续写（实测一轮 5901 字的完整回答被续写到 14326 字）。
  - 新增 `BoilerplateFilter`：流式剥离，**恒定扣留 len-1 个字符**。声明会被 SSE 切成任意小包
    （实测有「 AI」「 生成」「，」「内容」），只扣「声明前缀」时切点落在中间就会漏。
- **轮末尾巴必须也走完下游各层**：新增 `drainTextPipeline()` —— 三层按反序吐净后，
  对残余补跑「剥声明 / 剥伪系统标记」。此前声明恰好 23 字 ≈ 滤波器 24 字扣留窗口，
  整段从轮末尾巴漏出去（会话 `6c0dbc47` 实测：它作为只有单个 delta 的独立 text 块，跟在工具调用后面）。
  - `boilerplate` 必须排在回声守卫**之前**：守卫会扣住「最后一个换行之后的整行」，
    而声明常待在那里，放在它后面就永远看不到。
- **没收到 `response/status: FINISHED` 也按截断处理**：截断判据原来只看句末标点，
  截在标点 / 反引号 / 代码块收尾处会**静默**少一段（实测 `要我直接开跑 \`dev_plugin_status\` 和 \`` 到此为止）。
- **每轮诊断日志**：`第 N 轮流结束：[本轮 X 字 / 累计 Y 字 / 耗时 Zms] finish=…`，
  区分「服务端截断（无 FINISHED）」与「判据认为没写完」；剥掉声明时另打一行。

### 测试

- 新增 `tests/check-flush-order.mjs`（3 项）：三层反序吐净 = 与原文逐字一致；正序**必然**错位。
- 新增 `tests/check-web-disclaimer.mjs`（9 项）：整段剥离、**从中间切开**、小包拼接、
  前缀扣留后 flush 放行、两处声明、正常文本不受影响、**声明落在轮末尾巴（工具调用后）**、
  **声明是整轮最后一句话**、尾巴非声明时逐字保留。
- `check-auto-continue` 8 → **13 项**：补「无 FINISHED 也续写」「反引号结尾也续写」
  「FINISHED + 句号不续写」「轮末带声明不算截断且不上屏」「续写轮带声明两处都剥」。
- 六个文件断言 39 → **56 项**；产物核对 45 → **48 项**；全部测试文件通过。
- 真实数据验证（直连网页端跑完整流水线）：原始流含声明时，输出与「原文去掉声明」**逐字相等**。

## 0.1.12 — 2026-09-11

### 新增

- **自动续写**（应用户要求：两种模式都不再出现「已达到输出 token 上限」提示）
  - 回答在句中被截时，适配器**自动**发起新请求让模型接着写（等价于用户手动说「继续」，
    但无需用户参与），并把续写内容**无缝拼进同一条回答**。绝大多数截断被无声补全。
  - 每一轮的过滤器/回声守卫在轮次收尾时吐净、续写轮用全新实例 ——
    否则跨请求的行缓冲会让续写内容与 hold 的尾部乱序。
  - 续写 prompt = 原对话 + 已输出的半截回答（作为 assistant 消息）+ 明确的继续指令
    （从断点直接续写、不重复、不加开场白）。
  - 续写轮次失败（网络/频控）→ 保留已上屏部分并正常收尾，不让整轮失败。
  - 已发起工具调用的轮次不续写（等工具结果）。
  - 配置：`autoContinue`（默认开）、`maxContinuations`（默认 2，每轮是一次新的网页端请求；
    调高会消耗更多免费额度）。
- **永远不再报 max-tokens**：续写额度用尽仍被截时，按正常完成（stop）上报 + 日志留痕。
  用户可手动说「继续」。「已达到输出 token 上限」提示从此不会出现。

### 测试

- 新增 `tests/check-auto-continue.mjs`（8 项）：句中截断→续写拼接、
  续写 prompt 带半截回答与指令、正常结束不触发、autoContinue/maxContinuations 关闭、
  多轮续写、工具调用后不续写、续写失败保留已输出部分。
- 断言总数 117 → **125**；产物核对 44 项。

## 0.1.11 — 2026-09-11

### 修复

- **模型吐出成串的伪系统标记，全部上屏**（用户实测"回答过程中出现 `<ds_system>Tool call made.</ds_system>` 正常吗"）
  - 现场：一条正文里连续 **13 个** `<ds_system>Tool result for call_1a2b3c</ds_system>`，
    调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…）。这是模型在**模仿**系统消息格式
    —— 与「转写回声」同类问题，但形态是 XML 标签而不是 `[Tool Result]` 行。
  - 修复：新增 `stripSystemMarkers`（第三道网，在工具调用过滤器与转写回声守卫之后）——
    剥掉正文中的 `<ds_system>…</ds_system>` / `<system>…</system>` / 半截标记，
    围栏代码块内不剥（正常回答可能讨论这些标记）。
- **服务端在句中截断却报 FINISHED → 适配器假装正常完成**（用户实测"最后回复总是回复不完"）
  - 现场：以 FINISHED 收笔但正文停在 `…用官方模型`、`…read-re` 等句中，
    最后一个 text-delta 与 finish 事件间隔仅 5-7ms（流是真的结束了，不是解析器丢字）。
  - 修复：`mapFinish` 新增启发式 —— FINISHED 但正文**在句中被截**（尾部无句末标点、
    或 `**` 粗体标记未闭合、或逗号/冒号/分号收尾）→ 报 `max-tokens` 而非 `stop`，
    让 UI 至少提示「可能被截断」。
  - 注：截断本身是**服务端行为**（12s 内即断，不是 60s 上限；可能是网页端单条回复的
    输出 token 静默限制或内容过滤），客户端无法恢复，只能如实标记。

### 已知问题（记录在案，暂不修）

- **思考碎片化**：实测会话日志中思考内容只有 25-27 字符的碎片
  （`" duplicate"`、`" adapter"`、`" classified"` 等孤立词汇），
  而模型实际输出了大段推理。说明 SSE 解析器对思考流的某个新格式不兼容，需要账号解除后
  用线上探针定位具体协议变化。当前表现为「思考过程看起来断断续续」。
- 思考里反复出现的单独「写」字是模型的**自身行为**（思维链里的"现在开始写"标记），不是 bug。

### 测试

- 新增 `tests/check-system-markers.mjs`（7 项）：真实事故 13 个标记全剥、单个/半截/<system> 剥掉、
  围栏内不剥、无标记原样通过、嵌套在其他文本中只剥标记本身。
- 断言总数 117 → **124**；产物核对 44 项。

## 0.1.10 — 2026-09-11

### 修复

- **模型把 arguments 写成数组时，整个调用被静默丢弃**（严重，现场实测：
  `~/.dsh/deepseek-web/rejected.jsonl` 抓到 249 字符的完整现场）
  - 现场：`{"tool_calls":[{"name":"pwsh","arguments":[{…}}]}` —— 两个错误叠加：
    ① `arguments` 写成了**数组**（规范是对象）；② args 数组没闭合就写了 `}`
    （`}}` 里缺一个 `]`）。
  - 旧的结构性修复用 `( braced-deficit ) 个 `}` 盲补 —— 但未闭合的是**数组**，
    `}` 闭不上它 → 补出的候选仍是非法 JSON → 整个调用被丢掉。
  - 修复 ①：`rebuildToolCallJson` —— **栈引导重排**：扫描时维护容器栈，
    遇到不匹配的闭合符就**插入缺失的容器闭合**使其匹配（有 8 次上限保护）。
    一个算法同时覆盖：每个元素少写 `}`（事故 #4）、数组/对象闭合顺序错乱（本次）、
    外层少写收尾 `}`。
  - 修复 ②：`parseToolCallJson` 把 `arguments: [{…}]`（单元素数组）解包成真正的参数对象
    —— 否则即使结构修好，参数也会被序列化成 `"[{…}]"`，工具拿到的是垃圾。
  - 重排的逗号规则必须带**前瞻**（后面紧跟 `{"name":` 才是元素边界）：
    调用对象内部的键分隔逗号（`"name"` 与 `"arguments"` 之间）在栈上深度相同，
    不带前瞻会把每个调用对象拦腰补坏（第一版就踩了这个洞）。
  - 安全闸门保持：扫描结束时**仍在字符串内**（流被 60s 上限截断的典型特征）→ 拒绝修补。

### 测试

- 真实事故原文（249 字符，逐字取自 rejected.jsonl）固化为回归：
  必须解析出 1 个 `pwsh` 调用、`command` 逐字还原（含 `$env:` 与 Windows 路径）。
- `arguments` 数组解包（闭合完整版）+ 合法调用不受影响的对照。
- 断言总数 114 → **117**；产物核对 44 项。

## 0.1.9 — 2026-09-11

### 修复

- **两个窗口共用同一网页账号时，第二个窗口整轮失败**（用户实测）
  - 现象：`DeepSeek 网页端返回错误：A message is being generated, please try again later.（PROVIDER_ERROR）`
  - 含义：网页端**同一账号同时只能生成一条消息**。这不是封号（封号是 `user is muted`），
    但旧实现把这类 SSE 错误事件一律抛成**不可重试**的 `PROVIDER_ERROR` → 那一轮直接失败。
  - 修复：新增 `isBusyGenerating` 语义归类 —— SSE 错误事件与业务信封里的
    「being generated / try again later / 请稍后再试」统一映射为**可重试**的 `RATE_LIMIT`
    （`providerRetryAfterMs = 5s`），交给 dsh-llm-retry 自动重发；短暂碰撞可以自愈。
    错误文案也改成人话：说明是并发占用、建议另一窗口换 provider 或换账号。

### 说明（实测账号状态）

- 本次用户的新账号在登录后约 **6 分钟**即被 mute（两个窗口并发跑）—— 免费网页端对
  自动化调用的限流阈值远比想象低。**并发会加速 mute**：两个 agent 同时跑 = 请求量翻倍。
- muted 与「同时只能生成一条」是两回事：前者要等解除（错误信息带解除时间），
  后者等几秒重试即可。

### 测试

- `check-session-lifecycle` 新增 3 项（10 → 13）：真实并发拒绝文案的分类、
  SSE 错误事件带 `RATE_LIMIT` + 5s 重试间隔、业务信封里的同款映射。
- 断言总数 111 → **114**；产物核对 44 项。

## 0.1.8 — 2026-09-11

### 变更

- **面板文案如实化**（用户反馈：缺失项读起来像风险提示）
  - 旧文案把「未捕获 cookie / 指纹头」写成「（可能仍可用）」，含义模糊；实际含义只是
    「你走的是手动粘贴 token 那条路」——该路径本来就没有这两项。
  - 新增「**凭证来源**」一行，明确区分两条路径（手动粘贴 token / 浏览器登录捕获）；
    缺失项后直接说明「已验证不影响请求」，并给出「若频繁遇到 AUTH/40003 就改用浏览器登录」的建议。
  - 未登录时的「登录方式」改为按**实际能力**显示（插件自开窗口 / 真实浏览器 + 调试协议 /
    手动 token），不再笼统写成「非 Electron 环境」。
  - 依据：端到端实测（2026-09-11）——仅凭 64 字符 Bearer token（无 cookie、无 x-hif-*）时，
    登录态校验、PoW 求解、真实生成、会话回收**全部通过**。

### 测试

- 产物核对新增 2 项：client 必须出现「凭证来源」且**不得**再出现「可能仍可用」；
  未登录时必须说明可用的登录路径。
- 断言总数仍为 111（本次是展示层改动，逻辑未变）；产物核对 42 → **44** 项。

## 0.1.7 — 2026-09-11

### 修复

- **DSH 更新后「浏览器窗口登录」打不开**（严重，用户实测：升级 DSH 后按钮点了没反应）
  - 现场证据（host 日志）：
    `deepseek-web api /login/browser failed: Cannot read properties of undefined (reading 'fromPartition')`
  - 根因：**DSH 把插件宿主从 Electron 主进程挪到了 utility 进程**。探针实测
    `process.type === 'utility'`、Electron 43.3.0、`process.parentPort` 存在；
    utility 进程里 `require('electron')` 拿不到 `BrowserWindow` / `session`（主进程专属 API）。
    而旧的 `electronAvailable()` **只检查 `process.versions.electron`** → 假阳性通过 →
    随后炸在 `session.fromPartition`。
  - 另外：新架构**没有**给插件暴露任何「开窗口 / 开外部 URL」的通用服务
    （`desktopRuntime` 只有 openTerminal / pickDirectory / openProfileCreateWindow 这类专用接口），
    所以窗口式登录在新宿主里无法实现。

### 新增

- **真实浏览器 + CDP 登录**（取代无法使用的 Electron 窗口）
  - 拉起系统里真实的 **Edge / Chrome**（独立 profile `<DSH_HOME>/web-login/browser-profile`，
    不碰你日常浏览器的登录态），用 Chrome DevTools 协议读取：
    `localStorage.userToken`（AppKit 包装自动解包）、`Storage.getCookies`（cookie 串，
    免去 DPAPI 解密）、`Network.*` 里 `/api/*` 的**真实请求头**（x-hif-* / x-client-*）、
    `navigator.userAgent`。你只需在弹出的浏览器里正常登录，其余全自动。
  - 真实浏览器不会被网页端判「使用环境异常」（实测：无头 Edge 打开 chat.deepseek.com
    正文正常、无该提示）。
  - **必须用 `--remote-debugging-port=0`**：Windows 保留了大量端口区间
    （实测 8792-9897、10001-10100、50000-50059 等），硬编码端口会 `bind()` 失败
    （WSAEACCES 10013，Chromium 报 "Cannot start http server for devtools"）；
    端口 0 由系统分配，真实端口写在 `<profile>/DevToolsActivePort`。
- **登录能力自检 + 面板展示**：`/status` 新增 `loginCapability`（宿主进程类型 / 能否开窗口 /
  有无可用浏览器），面板「登录状态」区直接显示「宿主进程」与当前登录方式。
  按钮文案随之自适应（「浏览器窗口登录」/「用 Microsoft Edge 登录」/ 禁用并提示走手动 token）。
- `openExternalLogin`（用默认浏览器打开）不再依赖 Electron `shell`：
  非主进程时回退到 `cmd /c start`、`open`、`xdg-open`，任何宿主都能用。
- 退出账号时**连带清掉浏览器登录 profile**（否则换号会复用旧登录态）。

### 变更

- `unwrapStoredToken` 移到 `auth.ts`（浏览器登录与 Electron 登录共用，避免循环 import），
  并显式处理实测形态 `{"value":null,"__version":"0"}` → 空串（绝不能把字符串 "null" 当 token）。
- `electronAvailable()` 语义收紧为「真的能开窗口」；新增纯函数 `canOpenElectronWindowWith()`
  便于用事故现场参数做单测。

### 测试

- 新增 `tests/check-browser-login.mjs`（15 项）：utility 进程必须判为不能开窗口（事故现场参数）、
  主进程/renderer/字符串模块/非 Electron/加载抛错五类判定、端口必须为 0、
  启动参数（独立 profile、不带 --headless）、`DevToolsActivePort` 解析（CRLF/越界/非法）、
  `{"value":null}` 解包、cookie 串拼装、真实请求头挑选、浏览器可执行文件存在性。
- 断言总数 96 → **111**；产物核对 38 → **42** 项。

## 0.1.6 — 2026-09-11

### 修复

- **点「浏览器窗口登录」被网页端判为「使用环境异常」**（严重，本次用户实测）
  - 现象：登录窗口里显示
    「使用环境异常 —— 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，
      建议您使用我们的官方产品。」
  - 根因：Electron 的默认 UA 里带**应用名与 `Electron/<版本>`** 字样，网页端一眼识别出
    「这不是普通浏览器」就拒绝服务。
    （探针证实：服务端对 Electron UA 与干净 Chrome UA 返回**完全相同的 HTML**，
    说明判定发生在**页面内 JS**，所以两处都要清。）
  - 修复：
    1. 登录窗口报**干净 Chrome UA**（`buildLoginUserAgent`，Chromium 大版本取运行时真实值），
       在 `session.setUserAgent` 与 `webContents.setUserAgent` 上同时设置，且**必须在 loadURL 之前**；
    2. 清 **UA-CH**（`sec-ch-ua` / `sec-ch-ua-full-version-list`）里的非浏览器品牌 ——
       只改 UA 字符串不够，Chromium 还会通过 client hints 把品牌列表发出去；
    3. 页面主世界里抹掉 `navigator.userAgentData.brands` 的非浏览器品牌与 `navigator.webdriver`；
    4. 捕获到的 UA 现在也是干净的（它会用于后续 API 请求，与网页端保持一致）。

### 新增

- **「用我的默认浏览器登录」兜底入口**（`POST /login/external`）
  - 网页端连干净指纹的 Electron 窗口也拦、或者用户就是想用自己的日常浏览器时用它：
    用系统默认浏览器打开 chat.deepseek.com，配合已有的「手动粘贴 Token」卡完成登录。
  - 说明：外部浏览器里的登录态插件抓不到（没有 webRequest 钩子），所以这条路径必须配合手动 token。
- **指纹可观测**：面板新增「指纹清理 / 页面看到 UA / 页面品牌 / webdriver」四项。
  服务端不区分 UA，判定在页面内 —— 看不到「页面实际看到了什么」就只能靠猜，所以把它读出来展示。

### 测试

- 新增 `tests/check-login-fingerprint.mjs`（7 项）：UA 不得含 Electron/应用名、版本取自运行时、
  缺版本不崩、UA-CH 品牌清理、干净 UA 原样保留、品牌被清空时的兜底、无关头不被改动。
- 断言总数 89 → **96**；产物核对 34 → **38** 项。

## 0.1.5 — 2026-09-11

### 新增

- **退出当前账号 / 退出并登录其它账号**（用户反馈「怎么没有退出当前账号功能」）
  - 退出功能其实一直存在，但按钮只塞在「手动粘贴 Token」那张卡的角落里 → 实际上找不到。
    现在独立成一张 **「当前账号」卡**（在登录状态卡下方）：显示当前账号与登录时间，
    提供 **退出当前账号** 与 **退出并登录其它账号** 两个按钮。
  - 退出需**二次确认**（首次点击变「确认退出？」，3 秒内再点一次才执行）——按钮不再可能被误触。
  - 未登录时按钮自动禁用；非 Electron 环境下「换号」按钮禁用并给出改用 token 的提示。

### 修复

- **退出账号其实没有真退出**（严重）
  - 旧实现只删本地凭证文件，**不清浏览器分区**里的 chat.deepseek.com 站点数据。后果：
    1) 退出后点「从已登录窗口恢复」会把**同一个账号**原样抓回来，看起来像「退不掉」；
    2) 点「浏览器窗口登录」打开的是已登录页面，**根本没法换号**。
  - 现在 `logout()` 会 `clearStorageData({ origin: 'https://chat.deepseek.com' })`（cookie/localStorage/
    IndexedDB/CacheStorage/ServiceWorker），并且**等清理完成再返回** —— 否则紧接着打开的登录窗口
    会带着旧 cookie 开起来，又登录回同一个账号。
- **卸载/热重载插件会把用户登出**（隐患）
  - 卸载钩子里调的是 `logout()`（连带删除凭证）。改为只关登录窗口（`closeLoginWindow()`）：
    卸载插件不等于登出。

### 测试

- 新增 `tests/check-logout.mjs`（6 项）：凭证写入/读回、非 Electron 下分区清理返回 false 不抛错、
  `closeLoginWindow` 不删凭证（卸载即净的回归）、`logout` 真删文件且留下可读结果、幂等、退出后
  `readAuth()` 必须为 undefined（无从恢复旧账号）。
- 断言总数 83 → **89**；产物核对 34 项（新增退出/换号相关 5 项）。

## 0.1.4 — 2026-09-11

### 修复

- **会话被自己提前删掉，导致整轮失败**（严重，本次用户实测）
  - 现象：网页快速模式下某一轮直接失败
    `DeepSeek 网页端返回了非流式响应（content-type: application/json）：
     {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}`
  - 根因：`streamWebCompletion` 在建会话**之后立刻**调用 `onDeleteSession`，而它内部是
    「延迟 1.5s 删除」——只要 PoW 求解 + 建连超过 1.5s，completion 发出时会话已被自己删掉。
    更隐蔽的是**生成进行到一半会话消失**，服务端可能直接掐断流 —— 正是我们一直在追的
    「说半句就停 / 工具调用没收全」那类截断的一个来源。
  - 修复：删除只发生在 `finally`（流正常结束 / 报错 / 调用方中止都算），会话在整个请求期间保持存活。
  - 反证：同一场景下旧时序为 `create → delete → pow → completion`（删除早于请求，故障成因成立），
    新时序为 `create → pow → completion → delete`。已固化为断言。
- **服务端的真实错误被吞掉**（严重）
  - 根因：`envelopeError` 只看外层 `code`，而网页端把真实错误放在 `data.biz_code`（外层恒为 0）
    → 真正的 `biz_msg` 丢失，统一降级成不可重试、无法诊断的
    `非流式响应（content-type: application/json）` + `MALFORMED_RESPONSE`。
  - 修复：识别 `data.biz_code` / `data.biz_msg`；并把「会话失效」映射成可重试的 `TRANSPORT`
    ——**换一个新会话透明重试一次**，用户无感（本插件每次都是全新会话、不依赖服务端历史）。
- **账号被服务端限制时给不出人话**（由上面那条修复才暴露出来）
  - 实测信封：`{"biz_code":5,"biz_msg":"user is muted","biz_data":{"is_muted":1,"mute_until":…}}`
  - 现在会明确报出**解除时间**，并带上 `providerRetryAfterMs`（远超重试上限）→ 重试策略直接放弃，
    不再空转打请求（免费网页端对高频自动化调用会静默限流，空转只会更糟）。
- **上下文容量数字写错了**（用户指出）
  - 旧文档/代码把 `file_feature.token_limit = 890880` 当成「模型上下文窗口」，还写成「1M 扣输出预留」。
    实际它是**附件（file_feature）的 token 预算**；890880 = 870×1024，面板按 ÷1024 显示就成了「870K」，
    看起来像「说好的 1M 变成了 870K」。
  - 现场逐字段核对（`GET /api/v0/client/settings?scope=model`，configVersion 81）后改为：
    `contextWindow = 1048576`（标称 1M），`maxPromptChars` 默认 `1200000 → 1500000`
    （服务端单请求输入硬上限是 `input_character_limit = 2621440` 字符，留 ~43% 余量给 CJK 的字符/token 比）。
  - 面板文案同步改为「上下文 1M token（标称）」，并注明 890880 是附件预算、不是上下文窗口。

### 测试

- 新增 `tests/check-session-lifecycle.mjs`（10 项）：删除时机、会话失效透明重试、
  连续失效报可重试码、`data.biz_code` 识别、`user is muted` 文案与 `providerRetryAfterMs`、
  以及「非会话类业务错误不得被误判」。
- 断言总数 46 → **83**（logic 46 / badjson 11 / dsml 6 / echo 10 / lifecycle 10），产物核对 25 项。

## 0.1.3 — 2026-09-10

### 修复

- **模型漏写调用对象的闭合括号时，整段工具调用 JSON 泄漏成正文**（严重）
  - 现象：回复里出现一大段 `{"tool_calls":[…}`，且界面把它渲染成「一个字符一行 + 弯引号」的乱码。
  - 根因有两层：
    1. 模型侧：一次批量 3 个 `pwsh` 调用时，**每个调用对象都少写一个 `}`**（只闭合了自己的
       `arguments`）→ `JSON.parse` 报 `Expected double-quoted property name in JSON at position 519`；
    2. 适配器侧：解析失败后按「绝不静默丢内容」的旧约定把残留**原样当正文吐出**。
       而泄漏文本里的 `$ErrorActionPreference='…'; foreach($p in …)` 被 Web GUI 的 markdown
       当成 `$…$` 行内公式交给 KaTeX → 用户看到的是逐字符排版的乱码（`'` 还被渲染成 `′`）。
  - 修复：
    1. 新增**结构性修复**：按元素边界切开 `tool_calls` 数组，给每个元素补齐它自身缺的 `}`
       （只补括号，绝不改写内容）；
    2. **安全闸门**：只在数组已闭合（`]` 收尾，说明模型写完了）时才补 —— 流被 60s 上限截断时
       补括号会造出一条被截断的命令并真的执行它，宁可拒绝；
    3. 解析仍失败时**不再吐成正文**：本轮没有别的正文 → 报 `EMPTY_RESPONSE`（默认可重试码，
       自动重发这一步）；已有正文 → 补一句人话提示，原文只进日志。
  - 反证：真实原文 `JSON.parse` 必失败（position 519），修补后解析出 3 个调用、命令逐字不变
    （含 `$env:USERPROFILE\.dsh\super-injector\self-heal.log` 全程无反斜杠丢失、无 `\r`）；
    去掉 `]` 的截断版本必须**拒绝修补**（不得执行半条命令）。
  - 新增 4 条断言（含 1650 字符真实原文的端到端回归）。

## 0.1.2 — 2026-09-10

### 修复

- **跨包工具调用标记的 hold-back 判断失效，导致合法 JSON 泄漏成正文**（严重）
  - 现象：模型把工具调用拆成多个分块流式输出时，完整合法的
    `{"tool_calls":[{"name":"find_dsh_plugin",…}]}` 直接显示在回复里，工具没有被执行。
  - 根因：判断「缓冲区末尾是否可能是标记前缀」时，比较串**多拼了一个引号**
    （`` `{"${body}` ``，而 `body` 已含前引号 → 实际比较 `{""tool`），于是永远判 `false`。
    正文较长（超过 hold-back 窗口）时，半截标记 `{"tool` 被当正文吐出去，后半个分块再也拼不回
    完整标记 —— 整个 JSON 泄漏。会话日志原文：
    `" GUI's capabilities.\n\n{\"tool"` + `"_calls\":[{\"name\":\"find_dsh"`
  - 修复：前缀拼接改为 `{` + body；并用**真实会话日志的分块序列**固化为回归断言。
  - 反证：`{"tool` / `{"tool_` / `{"too` / `{"tool_call` 在旧判断下全为 `false`（不保留 → 泄漏），新判断全为 `true`。
  - 新增 2 条断言：真实分块序列（长正文 + JSON 拆成两半）、XML 标记同样拆两半。

## 0.1.1 — 2026-09-10

### 修复

- **SSE 去重模型错误导致回答被大量丢失**（严重）
  - 现象：完整回答在 DSH 里只显示 1~3 字碎片（如「，」「不上」「了一圈」），
    并伴随 `EMPTY_RESPONSE` 重试（会话日志中可见同一 step 出现 `usage×2 / finish×2`）。
  - 根因：旧实现用「只增不减的已发射计数器」做快照去重，而网页端的**快照会把派生文本重置为更短内容**
    （例如只含 THINK 片段的快照）。计数器被撑大后保持高位，后续仅在文本长度超过它时才吐字 ——
    前面全丢、只剩余数的尾巴；余数为空则被判定为空响应，触发重试。
  - 修复：改为「**增量事件驱动发射，快照只做严格延伸对账**」。已发射内容只增不减，
    过期（更短）快照与分歧快照一律忽略，绝不重置、绝不吐碎片。
  - 反证：同一事件序列下旧算法只输出 `"抱歉，我把生态找没有现成插件。"`（中间丢失）；
    连续缩水快照的极端形态下 6 段内容只活下来 6 个字符。新算法输出完整文本。
  - 新增 5 条回归断言覆盖：缩水快照丢字、假空回复、快照延伸补差、分歧快照忽略、直连格式穿插快照。

### 新增

- `CHANGELOG.md`（本文件）
- README 徽章、架构/流程示意图、界面预览、英文版 `README.en.md`

## 0.1.0 — 2026-09-10

首个可用版本。

- LLM 适配器（provider `deepseek-web`）：PoW（SHA3 WASM 求解）、会话创建与清理、
  SSE 双格式流式解析、图片上传通道（`file/upload_file` + `ref_file_ids`）
- 提示词工具协议桥：JSON 协议 + XML/DSML 兜底 + 非法 JSON 宽容修复（Windows 路径逐字还原）
- Electron 登录窗口旁路捕获凭证：AppKit token 解包、游客 token 持续刷新、fail-open 落盘、
  从已登录分区恢复
- 设置面板：状态 / 浏览器登录 / 手动 token / 连通性测试
- Apache-2.0（`LICENSE` / `NOTICE`）、非官方声明与风险提示
