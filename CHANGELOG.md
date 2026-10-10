# Changelog

本项目大致遵循语义化版本；日期为本地时间。

## 0.7.4 — 2026-10-10

**修好外部审查报出的 8 条缺陷**（P1×3 / P2×4 / P3×1）。审查给了行号、复现脚本与置信度标注，
7 个复现脚本全部实跑复现、无一条夸大。**其中两处修法不能照抄**，详见下文。

### P1-1「到期前自动重登」开关无法落盘 ⇒ 功能一次都不会跑

`gate.ts` 的 `settings()` 返回对象与 `configure()` 都漏了 `autoRelogin`，而保存链是
`configure(patch)` → `applied = settings()` → `writeGateSettings(applied)`，
后者是**整对象覆盖写、不合并** ⇒ 面板开关存不下去，定时检查永不触发。
改动其它设置也会顺手把它抹掉。

⚠️ **审查给的修法不能照抄**：它在 `configure()` 里写 `autoRelogin = next.autoRelogin`，
但**没有对应的模块级变量**（`autoRelogin` 原本是无状态字段，`index.ts:680` 每轮
`readGateSettings()` 重读文件）⇒ 照抄会 ReferenceError。实测踩过。
正解是给它内存态，并让 `settings()` **真的返回一个键**。

### P1-2 启动扫尾误删「已排队但尚未确认删除」的记录

`session-journal.ts` 的 `writeJournal(plan.kept)` 漏了 `plan.toDelete`，与模块自身文档
（"记录要留到确认删掉"）直接冲突。触发条件是组合式的：同一批里**同时**有孤儿记录
（`dropped` 非空）与已排队记录 ⇒ 后者被一并抹掉；若进程在删除回执到达前又被强杀，
就**永远补删不到**。修法：`[...plan.kept, ...plan.toDelete]`。

### P1-3 `salvageXmlToolCalls` 的 `bodyStart` 偏移算错

`attrs` 是捕获组 `([^>]*)`，**不含** `TAG_OPEN_PREFIX` 与结尾的 `>`，用
`index + attrs.length` 会从开标签内部开始切 ⇒ 参数变成
`{"_raw":"=\"read\">{...}"}`。改用 `invokeStartRe.lastIndex`。

### P2-4 内部请求抛错时同一会话被丢弃两次

`catch` 与 `finally` 两处做完全相同的事（同一判据 / 同一集合 / 同一动作），而 JS 语义下
`catch` 里 `throw` 之后 `finally` **仍会执行** ⇒ 两个可避免的 DELETE（与"降低请求密度"
的目标冲突）+ `scaffolding-discorders.jsonl` 多写一条假告警。删掉 `catch` 那份。

🔴 连带修了一条**过时的守卫**：`check-bundle` 原判据是"扫 `catch` 块里那段清理"，
**实现修好了它反而会红**（判据断的是源码位置，不是行为）。已改成守 `finally` 那层，
并新增一条反向守卫（catch 区间里**不许**再有那段）。变异实测：放回 catch 立刻红。

### P2-5 `sawCallFence` 单向闩锁 ⇒ 吃掉回答结尾的代码块闭栏

`grep sawCallFence\s*=` 只有 3 处、全是 `= true`，**没有任何复位点** ⇒ 调用之后用户回答里的
任意尾随闭栏都被 `CALL_FENCE_TAIL_RE` 剥掉（回答以代码块结尾时闭栏消失）。

⚠️ **光复位不够**：`CALL_FENCE_TAIL_RE`（`protocol.ts:967`）匹配的是**任意**尾部闭栏
（含 ` ```python ` 这种带语言名的）。"闭栏一定是配对的另一半"这个论断**只对紧邻调用块的
那一次**成立。所以除了复位，还加了内容判据：pending 里若还有未闭合的用户代码块开栏，
这个闭栏就不是残留，放它出去。

### P2-6 空 `response/fragments` 帧清掉已建立的 thinking 通道

`appendFragments` 在**没追加任何 fragment** 时也改写 `sink`，把
`response/thinking_content` 建立的 `sink='thinking'` 清成 `null` ⇒ 紧接着的裸续段被当成
正文上屏（同文件的 `fragments/-1/content` 分支已有守卫，漏了这道）。已对齐。

### P2-7 `unwrapDsmlArguments` 字符串分支缺多键保护

函数头注释声明"只剥只有一个 `arguments` 键的情况"，对象分支实现了，字符串分支
无条件 `return reparsed` ⇒ 静默丢参数。把 `Object.keys(args).length === 1` 提到两条分支共用。

### P3 `credentials.json` 落盘权限比账号文件更松（仅 POSIX）

装的是**邮箱 + 明文密码**（敏感度高于 token 文件），却用裸 `writeFileSync`（按 umask 落地，
通常 0644）。复用 `accounts.ts` 的 `writeJsonAtomic`（创建即 0600 + rename 失败清理）。

### 三处"假绿灯"也已堵上

新增 `tests/check-external-review-fixes.mjs`（8 条**行为**断言，不是 grep 源码）：

| 原问题 | 处置 |
|---|---|
| `check-relogin.mjs:164` 用正则断言"这行代码在" | 改成走真实配置链（`configure` → `settings` → `writeGateSettings` → `readGateSettings`） |
| `check-session-journal.mjs` 两条各覆盖一半，**交集**没测 | 新增 dropped 与 toDelete 同时非空的场景 |
| `ToolCallStreamFilter` 没有"围栏调用 + 回答含代码块"的端到端文本断言 | 新增围栏计数断言 |

⚠️ **变异验证**（这是本项目的既有纪律）：8 条里抽 5 条做变异，把修复还原 ⇒ 对应用例立刻红。
其中 P2-6/P2-7 一次变异命中两条。

### 验证

`tsc --noEmit` / `build` / `check-bundle` / `check-test-isolation` / 逻辑测试 81 /
新守卫 8 / **67/67** 全过。

⚠️ 一个测试方法上的教训（记在这里以免再犯）：本机 `shell` 里写文件再 `cp` 还原的
"变异 → 跑守卫"会出现**假阴性**（守卫其实抓得住，但那次跑出来是绿的）。
可靠做法是**在同一个进程里做「变异 → execFileSync 跑守卫 → 还原」**，已实测如此。
## 0.7.3 — 2026-10-10

**修好 Linux/CI 上浏览器起不来的问题**（0.7.2 只在 ubuntu-latest 上挂，macOS / Windows 同 commit 通过）。

### 根因：启动参数缺 `--no-sandbox`

`buildBrowserArgs`（`browser-login.ts:75`）没有 `--no-sandbox`。
而**在 Linux 上跑浏览器的人只有两种**：root（容器 / CI runner）
或没有 user namespace 权限的普通用户 —— **两种都起不来**。

症状极具误导性：

```
x 浏览器 fetch 可发送 POST 并读取响应: 浏览器调试端口未就绪
```

看起来像超时，实际是**启动失败** —— `waitForTransportDebugPort` 等满 25s 拿不到
`DevToolsActivePort`。⚠️ **调大那个超时只会掩盖真问题**（本次就没那样做）。

该 flag 在 Windows / macOS 上无害（会被忽略），所以无条件带上。

⚠️ 它降低的是**本机**进程隔离强度；本插件本来就用自己的 profile 跑 headless 浏览器、
不加载用户日常 profile，攻击面不因此变大。

### 顺带：那条用例加了重试（双保险）

`check-browser-transport.mjs` 的第 4 条是**第一个真拉浏览器**的用例（后面的 FormData 复用同一实例），
冷启动开销全压在这里。按项目既有约定（`check-devtools.mjs:132`）加了「重试两次、两次都失败才算坏」，
并在改造时**漏掉了 `finally` 收尾**（⇒ 端口与浏览器进程泄漏），已补回 try/finally。

### 验证

`buildBrowserArgs` 新增行为断言（变异验证：拿掉 `--no-sandbox` 立刻红）。
`tsc` / build / 产物 / 隔离 / **67/67** 全过。

## 0.7.2 — 2026-10-10

**俄语本地化（分支 rebase 到上游 0.7.3）+ 三处只有俄语才会暴露的界面缺陷。**

### 起因

上游只有中文界面，而设置面板里全是需要读懂的旋钮（间隔、阈值、清理策略）。
本次给面板与宿主两侧都加了 ru 词典（539 条，覆盖 454/454 客户端串 + 63/63 宿主串），
语言默认跟随宿主、也可在面板右上角手选 ZH/RU/EN。

### 三个真 bug（都不是"翻译不好看"，而是功能坏了）

1. **数字从「Token 统计」里消失。** 词典里 `'{0} 万': '{0}0 тыс.'` 编译成
   `$1` + 紧跟的 `0` ⇒ `$10` ⇒ 引用第 10 个捕获组（不存在）⇒ `String.replace`
   插入空串。界面上只剩「 тыс.」。修法：占位符展开时补一个不参与替换的边界，
   并加回归用例（`142.5 万` → `142.50 тыс.`，`1.23 亿` → `1.2300 млн`）。
   ⚠️ 这类错误**只在带插值的条目上出现**，纯文案条目完全正常 —— 所以肉眼校对抓不到。

2. **设置页横向溢出。** 中文页签是 2 个字，俄语是 9~18 个字符；七个页签一行放不下，
   而 `.dsw-tabs` 是 `inline-flex` 且不换行 ⇒ 内容顶出面板右边界（实测 `scrollWidth`
   ≈ 700px 而面板只有 ~560px）。改成 `flex-wrap` + `max-width:100%`，实测
   `scrollWidth == clientWidth == 560`。

3. **模型名在 DSH 自带的模型选择器里仍是中文。** 那份列表由**宿主**
   （`adapter.listModels`）提供，面板的 localStorage 它读不到。新增
   `POST /ui` + `src/ui-language.ts`（存 `ui.json`，原子写入），宿主侧
   `hostT()` 负责翻译模型名 / 描述 / 供应商名。
   ⚠️ 语言**不能**存进 `gate.json`：那个文件在保存任何「防风控」设置时会被
   `gate.settings()` 整份重写，语言会跟着被冲掉。`check-ui-language.mjs` 守着这条。

### 顺带

- `optionalService()`：cordis 的 ctx 是 Proxy，读**未在 `inject` 声明**的服务会
  **抛异常**（不是返回 undefined），`?.` 挡不住。这曾让整个插件激活失败
  （`web boot: 1 entry did not activate`），DSH 起不来。改用 try/catch，
  `check-client-activation.mjs` 复刻 cordis 语义守住它，并用变异测试证明它真的会红。
- 「万字符」译文从「десятков тысяч символов」（字面直译，读着像错的）改成
  「тыс. символов」。

## 0.7.1 — 2026-10-09

**修好 CI：从 2026-10-02 起一直红的发布链路**（根因是探针里硬编码了本机绝对路径）。

### 根因

七个 `dev/*.mjs` 探针把本机路径写进了源码：

```js
await import('file:///F:/Code/Github-Self/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')
```

Windows 上跑得通（文件就在那儿）⇒ **本地怎么测都绿**；
CI runner 上那个路径不存在 ⇒ 6 个探针全部 `ERR_MODULE_NOT_FOUND` ⇒
`check-devtools` 8 过 6 失败 ⇒ 跑批 exit 1 ⇒ CI 与 Release 全红。

### 为什么拖了这么久才定位

拿到 job 日志（`actions/runs/{id}/logs` 需要 token）后一眼看见：

```
[test] 65/66 个用例文件通过
  FAIL check-devtools.mjs
```

🔴 **在此之前我花了两轮（40+30 分钟）在本地复现，全是白费**：
干净克隆 66/66 全绿、最后一次绿（0.6.36）与第一个红（0.6.37）在本地都通过。
差异只在 Linux/macOS runner 上，**本机根本复现不了**。
⇒ 教训：**「CI 红但本地绿」第一件事是要日志，不是本地重造那一步。**

### 改动

- 7 个探针改用相对路径（`../src/protocol.ts`）。`trace-invoke-swallow.mjs` 读文件用
  `new URL(…, import.meta.url)`，Windows / Linux 都认。
- `check-devtools` 新增守卫「探针里不许硬编码本机绝对路径」，扫 `dev/*.mjs` 的
  `file:///<盘符>/…` 与裸 `X:/…` 字面量。变异验证：把探针改回绝对路径 ⇒ 打红。

`tsc` / 产物 / 隔离 / **66/66** 全过。

## 0.7.0 — 2026-10-09

**要求系统 Edge / Chrome**（唯一的破坏性变更），并按「更不容易被限流」重做四处：PoW 在页面内求解、会话跨重启复用、链式增量，以及把 README 里已经过时的实现描述同步为现状。

### ⚠️ 破坏性变更：必须有可用的 Edge / Chrome

PoW 挑战改为**在真实页面上下文里**求解。找不到浏览器时**明确报错，不退回 Node 侧**
（Node 侧解 PoW 是被公开列为的封号触发条件，退回去等于这个改动没做、只是看着像做完了）。
已经设了 `DSH_NO_BROWSER_TRANSPORT=1` 的环境需要撤销。

### 为什么这样更不容易被限流

公开的同类项目文档列出了封号触发条件，本版本按其中最可识别的四条做了调整：

| 原本 | 问题 | 现在 |
|---|---|---|
| Node 里 `WebAssembly.instantiate` 求 PoW | 「自动解挑战」触发条件 | **在真实页面里**用官方自己的 wasm 求 |
| 每次调用临时建会话、用完即删 | 真人不会这样建删（实测曾一天建 182 个） | **按 DSH 会话复用**，跨重启续上 |
| 每轮全量重发 | 体量与节奏都不像真人 | **链式投喂**：只发增量，`parent_message_id` 挂在上一条回答下 |
| 固定请求间隔 | 真人打字不等距 | 间隔可配随机区间 |

⚠️ **这降低被识别的概率，不构成「不会被封」的保证**：逆向网页端本身违反服务条款，
风险是「判罚多严」而不是「会不会被抓到」。稳定性优先请用官方 API 或付费订阅走 OAuth。

### 修复

- **0.6.43**：DSH 重启后会话槽与链丢失（纯内存 `Map`）⇒ 同一条对话线被迫建新会话 +
  全量重发（实测 27 万字符）⇒ 网页端**多窗口 + 「修改 / 重新生成」分叉**。现在落盘
  `resume-state.json`（原子写），并新增 `check-resume-after-restart.mjs`（**两个进程**：
  ESM 同进程只求值一次，同进程测「续上了」是假的）。
- **0.6.42**：PoW 改在页面内解（同上）。
- **0.6.41**：内部请求（`session-title`）的脚手架会话在**抛错路径**上没被丢弃 ⇒
  「发一句话网页端建俩窗口」。
- **0.6.40**：`unwrapDsmlArguments` —— `<parameter name="arguments">` 包一层会让参数变嵌套。
- **0.6.39**：记录调用形态，让 0.6.38 的围栏终于可被验证。

### 文档

README 里三处**已经过时且会骗人**的描述已按现状改写：传输层（不再是 Electron `net.fetch`，
而是系统浏览器进程代理）、架构图里的「每次调用临时会话」（现在是复用 + 跨重启续上），
以及新增「为什么这样更不容易被限流」一节。

### 已知问题

**CI / Release 从 2026-10-02（0.6.36 之后）起持续失败，本地无法复现**：
Windows 上干净克隆跑 `scripts/test-offline.mjs` 全绿（66/66，132s），
0.6.36 与 0.6.37 两个 commit 在本地也都通过 ⇒ **差异只在 Linux/macOS runner 上**。
定位需要该次 job 的日志（Actions API 读日志要 token，本机没有）。

## 0.6.43 — 2026-10-09

**DSH 重启后能续上同一对话线**（会话槽与链落盘）—— 修「只聊了一个窗口，网页端却多出第二个 + 出现『修改』」。

### 起因：用户实锤

> 「我今天 dsh 就只聊了一个会话窗口，然后发现网页版有俩会话窗口，同时有个窗口又用了『修改』」
> 「不管是重启 dsh，那也应该要续上」

现场（feed-decisions.jsonl）：

```
15:08:56  chained      d6327951  entries=138   ← 对话进行到第 138 条
   ↓ 7 分钟空档（DSH 重启）
15:15:32  new-session  84b66924  entries=140   ← 接着第 140 条
```

**`entriesLen` 连续** = 同一条对话线被迫换了会话；旧会话因 `sessionCleanup: keep` 留在网页端侧栏。
换会话必须发根消息⇒ 网页端出现「修改 / 重新生成」+ `n / n`（截图里的 `2/2` 分叉标记）。

### 根因：槽与链都是**纯内存 Map，零持久化**

```
webapi.ts:2107const reuseSlots   = new Map()   ← 会话复用槽
webapi.ts:2149  const contextChains = new Map()   ← 投喂链
```

`grep -E 'read|write|persist'` ⇒空；`grep '重启|restart'` ⇒只有环境变量说明，**压根没考虑过重启**。
⇒ 重启后① 复用槽命中不到（建新会话）② 链为空（全量重发，实测 promptChars=270954）③ 发根消息（网页端分叉）。

**这不是配置问题**：三个开关（`chained` / `freshSessionOnRestart:false` / `keep`）
都是「最小封号风险」设的，**没有任何开关能解决重启丢槽**。

### 关于「重命名会不会换掉ID」（用户提问，已核实）

实测 DSH 会话目录 `~/.dsh/sessions/<工作区>/` 里，同一 ID 曾以两个名字共存：
`session-8ea338bc-…` 与 `8ea338bc-…` ⇒ **重命名只改目录名、ID 恒定**（DSH 用 `randomUUID` 生成）。
⇒ 槽键 `账号|dsh会话ID` 在重命名前后一致，能续上。

### 改动

- 新增 `resume-state.json`（"原子写：临时文件 + renameSync"，半截文件会把状态搞坏）。
  - 落 `SessionSlot` 的 `sessionId/turns/at/key` 与 `ChainState` 全部字段。
  - ⚠️ **`cleanup` 是函数、不恢复** ⇒ 重启前建、没到轮换次数的会话没有删除回调，
    交给 `sessions-in-use.json` 那条路兜底。**有意取舍：宁可少删也不误删。**
- 落盘时机：**10 处**变更点（入栈/ 命中 / 链更新 / 五处删除与清空）。
  ⚠️ 清空类**也必须落盘** —— 否则重启后旧状态又被读回来。
- 启动时 `restoreResumeState()` 读回。**不做网络请求**（慢且可能失败）；
  网页端会话真没了会在用的时候拿到 `invalid chat session id`，届时清记录。

### 验证（变异）

新增 `check-resume-after-restart.mjs`：**两个进程**（ESM 同进程只求值一次 ⇒ 同进程测「续上了」是假的），
判据两条：①重启后不新建会话 ② 重启那一轮带 `parent_message_id`（为 null ⇒ 网页端出「修改」）。
变异「把 `restoreResumeState` 短路」⇒ 红，报错信息即现场现象（`created=1`）。已实测。

🔴 **三个夹具坑**（都踩过，已写进注释）：
① `currentContextMode` 是 context-feed.ts 的模块级变量，只有 index.ts 启动时才 apply
   ⇒ 直接 import webapi.ts 永远是 `full`、链式走不到；
② assistant 帧必须 `v.response.fragments`，写 `{type:'assistant'}` 会被静默丢弃 ⇒ 拿不到 response_message_id；
③ 本机 `spawnSync` **一律 EBUSY**（连 `node -e` 都是）⇒ 用例必须用**异步 spawn**。

`tsc` / smoke / 产物 / 隔离 / logic-test 81 / **66/66** 全过。

## 0.6.42 — 2026-10-09

**PoW 改在浏览器页面上下文里求解** —— 消掉整条链路上最容易被风控识别的特征。

### 起因：封号风险调研

`xiaoY233/DeepSeek-Free-API` 的 Disclaimers 把封号触发条件列得很明确，其中一条直接命中本项目：

> Challenge Solving Patterns: Automated challenge solving detected

本项目此前在 **Node 侧** `WebAssembly.instantiate()` 加载 DeepSeek 的
`sha3_wasm_bg.*.wasm` 并调用 `wasm_solve` 求答案（`webapi.ts` 的 `solvePoW`），
再用 `activeFetch` 自己发 `POST /api/v0/chat/create_pow_challenge`。

**官方网页端是在页面上下文里解的。** 而本项目本来就已经把请求跑在真实浏览器里
（CDP `Runtime.evaluate` + `Runtime.addBinding`）⇒ 让官方自己的 wasm 在官方自己的
页面里跑，是可行且改动不大的。

### 改动

**`browser-transport.ts`**
- `solvePowInPage()`：`Runtime.evaluate` 在页面里 `fetch` + `WebAssembly.instantiate`
  + 调 `wasm_solve`，答案经**新增的独立 binding**（`__dshPowSolveResult`）回传。
- `handlePowBindingEvent()`：解析 `requestId + ':ok:' + 答案`。
  ⚠️ 用 `indexOf` 找分隔符而不是 `split` —— 错误消息里可能含 `:`（如 `solve code=0`）。
- `POW_BINDING` 与传输层的 `BINDING_NAME` **分开注册**：后者负载是 JSON，
  混在一个通道里会让两边的解析器互相误判。

**`webapi.ts`**
- 新增 `solvePow()` 作为**唯一入口**：浏览器可用 ⇒ 走页面内；不可用 ⇒ **显式报错**。
- 旧的 Node 侧实现保留为 `solvePoW_removedForReference`（**注释块形式**），
  留档 prefix 拼法 `${salt}_${expire_at}_`（少一个下划线 ⇒ 服务端判失败），
  并明确写「不要因为 Node 侧也能算就加回来」。
- 新增 `resetWasmUrlCache()`（单测用：`resolvedWasmUrl` 是模块级缓存）。

### 为什么没有「失败就退回 Node 侧」

那等于这个改动没做，却给了「已经改好了」的错觉。**浏览器不可用就报错**，
让调用方与用户都看得见。⚠️ **这是有意的行为变更**：原来没有浏览器也能跑，现在必须有。

### 测试：删掉两条、改掉四条、新增三条

**删除 `check-round2` 的两条 N05** —— 它们守「失效地址被清掉并重新 discovery」，
触发者是 Node 侧下载失败；PoW 改到页面内后那条链在 Node 侧**不可观测**。
硬留会变成「看着绿、其实不测东西」的虚守卫。我试过三种写法来保住它，**全部失败**：
① 断言 `homeHits` 增长 → 永远红（第二轮在 `solvePow` 就先抛错了）；
② 断言 `probes` 增长 → 正常版也红（第一轮探测成功就缓存，第二轮命中缓存是**正确行为**）；
③ 断言 `probesAfterSecond >= 1` → 能过但**几乎恒真** = 虚守卫。
⇒ 如实记为缺口，等浏览器集成用例来验。

**新增一条真能测的**（替身）：无浏览器时 `createPowHeader` 必须抛错，
且报错要说清「没有浏览器」。判据是**行为**不是文本 ——
变异「把报错文案换掉」⇒ 打红，且报错信息直接复现了变异文案。

**新增 `check-test-isolation` 的第二条守卫**：会走浏览器传输的用例必须钉
`DSH_NO_BROWSER_TRANSPORT`。⚠️ 这条守卫改了**四次**才不误报，全是同一个毛病：
判据没对准「真的会发生什么」（详见代码注释里的四轮记录）。
⚠️ 且已写明它的**能力边界**：只守将来的新用例，**对已有用例无能为力**
（变异删掉 `check-round2` 的开关它没报红，因为该文件已不再调 `createPowHeader`）。

### 已知影响

`check-round2` 从 **300s 超时挂住** 回到 **5s** —— 之前是我的改动让它去真启浏览器。

### 验证

- `check-bundle` 新增三条产物守卫；变异验证时被守卫**自身的两个漏洞**打到：
  ① 方向错（查「报错文案之后」而真实风险在 `if` 之前）；
  ② 词边界不足（`/await solvePoW\(/` 匹配不到 `solvePoW_removedForReference(`）⇒ 改成扫整个函数体。
- `tsc` / smoke / 产物 / 隔离 / 诊断 / logic-test 81 / **65/65** 全过。

## 0.6.41 — 2026-10-04

修「发一句话网页端建俩窗口」在**出错路径**上漏掉的那个窗口，并补上缺失的判据。

### 起因

用户新开一个 DSH 对话、只发一句话，网页端出现**两个**窗口（同标题、不同 URL）。
`feed-decisions.jsonl` 里对上了：

```
21:37:15  new-session  a3c3b79b   ← 真对话
21:37:33  no-parts     1705d934   ← 🔴 多出来的那个
```

`reason: 'no-parts'` = **内部请求**，`promptChars: 477` 与那段 "Create a concise title…"
完全吻合 ⇒ 是 `session-title` 的**脚手架会话**，本该被丢掉。

**先证伪了"PR 引入"**：`git diff d24d5f3 HEAD --stat -- src/webapi.ts` 为空 ——
今天两个提交（含 PR #11 合并）一个字都没碰 `webapi.ts`，而这段逻辑来自 0.6.31。

### 根因：抛错路径绕过了丢弃

`openCompletion` 的收尾路径里有 `params.onDiscardSession?.(id)`，
但**它前面有 `catch` 里的三个 `throw`**（`ABORTED` / 上游 `AdapterLlmError` / `TRANSPORT`）
⇒ 内部请求一旦出错（限流、网络抖动、5xx），**这三个 `throw` 直接跳过收尾**，
`finally` 只清 timer/abort，**不丢会话** ⇒ 脚手架会话永远留在网页端。

### 改动

**`catch` 里、第一个 `throw` 之前**就把脚手架会话丢掉。
⚠️ 只在 `params.promptParts === undefined` 时做 —— 用户的对话会话**绝不能**在出错时丢
（0.6.29 的约定：出错后还要重登/重试接着聊）。

**新增留痕 `diagnostics/scaffolding-discards.jsonl`**（`sent` / `failed` 两态）。
🔴 之前 `ledger` 只记 `ok`、**不记删除** ⇒ 这个 bug 历史上出现过 **14 次**却一次都查不了
（分不清"没走到 discard"还是"discard 了但 DELETE 失败"）。**判据缺失就永远只能靠用户报。**

### 验证（两处都做了变异，且都踩了一次坑）

- 变异 A（删掉 catch 里的丢弃块）→ **1 条红**；变异 B（把 `deleteChunk([{auth,sessionId}])`
  改成 `deleteChunk(queue)`）→ 那条"不 drain 队列"守卫红，**还原后全绿**。
- ⚠️ **变异 B 第一次测"红 0 项"**：守卫读的是**产物**，我改的是 `src` 又忘了 `build` ⇒
  产物没变。**"跑过了"不等于"测到了"**（今天第五次踩同一类）。
- ⚠️ 新守卫首版用 `indexOf('} catch (error: any) {')` 匹配到**第一个** catch
  （`webapi.ts` 里有 **7 个**）⇒ 判据恒假。改成**扫全部**、只认"含丢弃逻辑的那个"。
- ⚠️ 把 `trace` 插在 `discard` 函数开头会**顶出一条已有守卫**（它按"开头 90 字符内"
  定位 `deleteChunk`，而 tsdown 还会把这个调用拆成多行）⇒ 守卫窗口放宽到 240，并补了
  "不许把 queue/owned 整个传进去"的反向判据。
- `tsc` / smoke / 产物 / 隔离 / 诊断脚本 / logic-test 81 / **65/65** 全过。

### 仍需你验证

**判据只证明"逻辑在"，不证明"窗口真的没了"** —— 后者要真机：
重启 DSH → 新开对话发一句话 → 看网页端**是不是只有一个窗口**，
再看 `diagnostics/scaffolding-discards.jsonl` 里有没有 `outcome:"sent"`。

## 0.6.40 — 2026-10-04

修 **DSML 被当成合法调用执行**时参数结构错报。**这是 0.6.39 首次拿到真机数据后查出的第一个真缺陷。**

### 起因：一张截图

用户在网页端"已思考"里看到完整的 DSML 结构，而且**它被执行了**：

```
<｜｜DSML｜｜invoke name="pwsh">
  <｜｜DSML｜｜parameter name="arguments" string="false">
    {"command":"node audit-tool-args.mjs","description":"Classify DSML hits"}
  </parameter>
</｜｜DSML｜｜invoke>
[Tool Result [ERROR] for call_26ef892b8db934a0c8a05]
Error: invalid arguments: missing required property "command"
```

0.6.39 加的 `diagnostics/call-shapes.jsonl` 同时给出了三行留痕：

```
12:03:28  fenced   ← 模型照 0.6.38 发了围栏
12:03:32  bare     ← 下一轮退回裸 DSML，并且被执行
12:03:40  none
```

⚠️ `rejected-meta.jsonl` **没有**新记录 ⇒ 那个 DSML **没被丢弃**，
走 `parseXmlToolCalls` 被当成合法调用执行了。

### 根因

`parseParameterValue` 会把 `{"command":…}` **解析成对象**，然后塞进 `args["arguments"]`
⇒ 参数表变成 `{arguments: {command: …}}`，而 DSH 要的是 `{command: …}` 顶层
⇒ 执行器报 `missing required property "command"`。

**模型看不懂这条报错**（它并不知道参数被包了一层），所以下一轮继续写错的 ——
截图里那句"它跑到了执行器，返回的是 invalid arguments…"正是它自己的困惑。

### 改动

**`unwrapDsmlArguments()`**（新函数，`protocol.ts`）——
剥掉 DSML 的 `<parameter name="arguments">` **包装层**。两种形态都处理：

- **对象**：`parseParameterValue` 已把内文解析成对象（上面那种，最常见）
- **字符串**：整份 JSON 被当字符串塞进来 ⇒ 补一次解析

⚠️ **只在"只有一个 `arguments` 键"时剥** —— 多个键时那不是包装层
（某个工具真的有名为 `arguments` 的参数），硬剥会把参数丢掉。

**两条解析路径都接上**：`parseXmlToolCalls` 与 `salvageXmlToolCalls`。
salvage 是"收尾不全"的兜底路径，遇到坏形态的概率**更高**（DSML 变体常缺闭栏）；
只修一条等于给另一条留后门。

### 验证

- `logic-test` 74 → **78**，四条新用例：
  - 真机样本（**逐字用现场形态**：全角 `｜｜` + `string="false"` 属性）
  - 正常形态不被破坏（反向用例）
  - **salvage 路径单独一条**（同一语义两个来源，各守一条）
  - 多键时**不许**剥（防"无脑剥一层"）
- **两个变异分别验证**：断对象分支 → 2 条红；只断 salvage → 恰好 1 条红
  （证明两条用例真的各守一条路径，不是同一条在重复报）
- `tsc` / smoke / 产物 / 隔离 / 诊断脚本 / **65/65** 全过

### 尚未解决：围栏触发率

3 轮里只有 1 轮照围栏（`fenced` 50%）。**这次修的是"错结构被执行"，
不是"模型不听话"。** 提高触发率要改载荷形态（避开 `tool_calls` 这个撞形键名），
是独立的一件事，见 0.6.39 的 cuckoo / ToolBridge 对照分析。

## 0.6.39 — 2026-10-04

让 0.6.38 的围栏协议**能被验证**。这是一个纯观测能力的变更 —— 上一版改完协议之后，
我们**没有任何办法确认模型到底听没听话**。

### 起因

0.6.38 把工具调用从裸 JSON 改成 ` ```dsh-tool ` 围栏，但"改完就完事"是**不够的**：

1. **裸 JSON 走 fallback 路径同样能执行成功** ⇒ "工具调用成功了"**不能**证明围栏生效。
2. **我们的轮次不落 DSH 会话日志**（走插件 → DeepSeek 网页端，逆向 fetch）
   ⇒ `~/.dsh/sessions/` 里**根本没有我们的原文**可查。

结果就是：0.6.38 至今**零真机验证**，谁也说不清模型有没有照做。
期间还被自己坑了两次 —— 先信了一个扫 `~/.dsh/sessions/` 的探针，
得出"2 次围栏调用、0.6.38 已验证"，**后来发现那两条属于另外两个项目**
（那个目录按 cwd 分组，我们的不在里面）。

### 改动

**`protocol.ts`** —— `FilterOutput` 增 `fenced?: boolean`。

判据直接用已有的 `sawCallFence` 标志 —— 它本来就是"这次调用是围栏裹着的"的**权威信号**，
而且**天然跨 `push`**：围栏开栏与 JSON 经常不在同一个分块里（逐字符分块是极端情况）。
JSON 与 XML 两条捕获路径都置位；`drainTextPipeline` 转发，轮末收尾那条路径也拿得到。

**`adapter.ts`** —— 新增 `noteCallShape()`，每轮追加一行到
`web-login/diagnostics/call-shapes.jsonl`。

照抄同文件里已有的 `dumpRejectedPayload` 模式：同一个 `diagnostics/` 目录、
同样的 `0700` 目录 + `0600` 文件权限、同样的 4MB 上限、**只记结构化事实不记内容**。
三态：`fenced`（照新协议）/ `bare`（没听话，但功能正常）/ `none`（本轮无调用）。
⚠️ 没有调用的轮次**也要记 `none`** —— 否则"日志里没这一轮"与"这轮没调用"分不开。

**为什么不塞进 `feed-decisions.jsonl`**（先试过，又退回来了）：
那份记录在**请求发出前**写，而形态要等**响应回来**才知道 ⇒ 只能记成"上一轮的"，
字段名会骗人。分开写没有这个歧义。

**`dev/verify-fence-on-machine.mjs`** —— 改成读上面那个文件。
旧版去扫 `~/.dsh/sessions/`，那里**没有我们的轮次**，所以它报的数字一律不可信。

### 验证

- `logic-test` 67 → **74**：围栏/裸 × 整块/逐字符/按行六条，外加一条反向用例
  （正文里普通的 ` ```json ` 代码块既不算调用也不算围栏）。
- **变异验证**：把两处 `if (this.sawCallFence)` 改成 `if (false)` ⇒ **3 条打红**，还原 74/74。
  ⚠️ 第一次变异"没打红"是**脚本没打全**（XML 那行尾部有注释，`replace` 只替换了第一处）——
  **不确认变异是否落地就报"全绿"是假的**。
- `tsc` / smoke / 产物 / 隔离 / 诊断脚本 / **65/65** 全过，真实留痕未污染。

### 顺带更正两条昨天的判断

- DSH 引用的 `rejected-meta.jsonl`「1 条、`mode:"json"`、22 字符」**是准确的** ——
  我昨天说"该文件不存在"是只查了 `web-login/` 顶层，漏了 `diagnostics/` 子目录。
- 但它引用的 `call_2ad277619424417f975c` **仍然不成立**：那个 call 读的是
  `Documents\deepseek-harness\default-workspace\pelican-bicycle.html`，**另一个项目**。

## 0.6.38 — 2026-10-03

工具调用协议从**裸 JSON** 改成**围栏包裹**（` ```dsh-tool `），根治"标记漏到正文"这一类问题。

### 起因：用户拿 cuckoo 的分享页来对比

用户问「为什么 cuckoo 不会出现 DSML 等内容，他不也是工具调用」。取它的分享页逐项统计：

| | cuckoo | 我们（改之前） |
|---|---|---|
| 调用格式 | ` ```cuckoo ` **围栏代码块** | `{"tool_calls":[…]}` **裸 JSON** |
| 页面里 `DSML` | **0** | 出现过 |
| 页面里 `tool_calls` | **0** | 出现过 |
| 页面里 `invoke` / `parameters` | **0** | 出现过 |

**根因就在格式本身**：围栏**自带语法边界**，模型即使在围栏外多写一句废话也进不了正文；
裸 JSON 没有边界 —— 模型在思考里写 JSON、或者在 JSON 前后多写一个字，整段直接成为正文。
这也是为什么我们的规则 6 早就写着"禁止 XML 标记"却仍然漏：**禁令能约束内容，约束不了边界。**

DSH 那侧**不用改**：我们把调用转成 `tool-call` 事件交给它，它只看事件、不看文本。

### 改动

**提示词**（两份，`TOOL_PROTOCOL_INSTRUCTIONS` 与串行版必须逐字一致）：

- 示例与开头句改成 ` ```dsh-tool ` 包裹
- rule 6 改为「必须用围栏包裹；不包裹的 JSON 与 XML 标记都会泄漏」

**解析器**（`protocol.ts`）：

- `stripCallFence()`：调用块前后**无条件**剥掉所有围栏（含 ```json 这类模型自选语言名）。
  进入该函数的文本都已确定属于调用块，所以放宽是安全的。
- `CALL_FENCE_OPEN_RE` + `sawCallFence`：在 `drain()` 里对**普通正文**判围栏。
  ⚠️ 只认带 `dsh-tool` 的开栏，且**不**加"后面不是闭栏"的负向断言 ——
  逐字符分块时开栏先到（JSON 还没来），那条断言会把它误判成闭栏而放行出去。
- 闭栏只在本流见过开栏时才剥（`sawCallFence` 门控）。

**没有动**：`extractBalancedJson` 要求 `{` 在开头这件事（靠捕获时先剥 head 解决）、
DSH 侧的调用解析、裸 JSON 的支持路径（模型不听话时的兜底必须留着）。

### 期间踩到的两个坑

**① 放宽判据吃掉正常内容（真实回归）。** 一度无条件剥所有 ``` ⇒ `check-auto-continue` N03
（正文里的 ```xml 示例）与 `check-tools-section` 各变红。曾试图用"独占一行的裸闭栏"补救，
逐字符分块时闭栏还没成行、照样漏 user 的代码块。最终形态：**普通正文只认带 `dsh-tool` 的开栏**，
闭栏靠 `sawCallFence` 配对。

**② 围栏示例有体积成本。** `maxChars=5000` 的极小预算下，协议头占 3304/5000（66%），
新增的围栏示例把工具定义挤掉了（`check-tools-section` 变红）。压掉 rule 6 与 rule 8 的冗余措辞后
协议头 **2869 字符**（比改动前只多 55），工具定义恢复。`logic-test` 里加了一条上限断言
（`< 3000`）防它悄悄涨回去。

### 复审（同日第二轮）发现并处理的两件事

**① 一个真调用会漏的过度吞咽。** 用真机 reasoning 原文（模型**复盘自己写坏的调用**，
`The tool call got mangled again… {"tool_calls":…{...}}`）实测，发现思考通道把那段吞了
（78% 被吞）⇒ 用户看不到模型正在纠错。**试了三种判据、三次失败后决定不修**：
①"独立成段" ⇒ 前面说过一句话的**真调用**被误判成复盘，标记整块漏进正文 ——
那正是 0.6.28 建这道网要防的，等于把它拆了；②"紧邻 8 字符" ⇒ `slice(-8)` 把紧邻的 `\n\n` 截掉；
③"配平能否解析"（判据本身对）⇒ 流未收全时配平必然失败，逐字符下把真调用整块放行（更糟）。
**理由**：这段 JSON 出现在思考区不影响功能，而三次尝试都在真实调用路径上引入了新风险 ——
净负收益。取舍与三次失败已写进 `ReasoningSanitizer` 的类注释，避免后人重走。

**② 诊断脚本没有任何用例守着。** `dev/probe-*.mjs` 是 0.6.37/0.6.38 排查的主力，但**不被任何测试引用**
⇒ 改坏了不会有人知道（探针自己还会静默报"全绿"）。新增 `tests/check-devtools.mjs`（12 项）：

- 每个探针都必须**能启动**（变异验证：把某个探针改成语法错误 → 11/12 变红）
- 探针在**无真机数据**的环境里必须**优雅退出**而不是崩 —— 批跑（`scripts/test-offline.mjs`
  注入临时 `DSH_HOME`，**CI 跑的也是批**）里没有会话，原先 5 个探针直接抛 ENOENT
- 提取 `dev/session-locate.mjs` 统一处理"找会话"，5 个探针共用
- ⚠️ 文件名不能含 `probe`：`scripts/test-files.mjs` 的 `isManualProbe` 用 `/probe/i`
  匹配，把 `check-probes.mjs` 判成"人工诊断脚本不许进自动化" ⇒ 定名 `check-devtools.mjs`

### 验证

- `logic-test` 62 → **67 项**（5 条新围栏用例：整块/逐字符/按行三种分块 × 带散文、
  正常代码块不许被剥、裸 JSON 兜底仍可用、协议指令必须要求围栏 + 体积上限）
- `dev/probe-fenced-protocol.mjs`：7 种形态全部"调用提取成功 + 零泄漏"
- DSML 矩阵 144/144 仍全拦得住
- **四处变异手工确认打红**（脚本里的 `execFileSync` 在本机不可靠，变异写不进去 ⇒ 假"全绿"）：
  开栏不扣留 → 2 红、flush 不剥闭栏 → 2 红、head 不剥围栏 → 1 红、`stripCallFence` 恒等 → 2 红
- 又抓到一次**虚守卫**：提示词退回裸 JSON 时用例仍全绿（只查了 `includes('dsh-tool')`，
  而围栏示例行里也有这个词）。补上"必须出现 `inside a fenced code block`"后变异正确打红
- `tsc` / smoke / 产物 / 隔离 / **65/65** 全过，单跑与批跑两种模式都对，真实留痕未污染

## 0.6.37 — 2026-10-03

修 DSML 标记泄漏：`dsml-` 连字符变体**带空格**时整块原样上屏（用户分享页现场）。

### 现场

用户对比 cuckoo（干净）与本插件的分享页，报告 DSML 漏到网页端。分享页原文：

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="pwsh">
<｜｜DSML｜｜ parameter name="command" string="true">Get-Date -Format …</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

同时工具调用**确实执行了**（下一轮有 `[Tool Result for call_68d163…]`）—— 同一段标记
既被执行、又漏到正文，所以不是"认不出"，是"没走进捕获态"。

### 根因

`DSML_PREFIX`（竖线段，可选）与 `(?:dsml-)?`（连字符段，可选）是**两个各自独立**的可选片段。
`<dsml- calls>`（连字符后带一个空格）两边都匹配不上 ⇒ 不进捕获态 ⇒ 整块当正文。

144 组合矩阵（前缀 6 种 × 形态 4 种 × 分块 3 种 × 通道 2 条）实测：修复前 **54 个组合泄漏**，
其中 `dsml-` 两个变体**全部 24 个组合**整块上屏，正文与思考通道都一样。

### 为什么一直没暴露

现有用例只写了**无空格**形态（`check-dsml-stray.mjs` / `logic-test.mjs` 都是 `<dsml-calls>`）——
**测的形态和现场形态不是同一个**。与「0.6.28 思考分支一句 `continue` 跳过全部四道网」同类：
判据只覆盖了一种规范写法，现场是另一种。

### 修法

- 前缀两种变体合并成**一个可选组** `DSML_PREFIX_BODY`，`dsml-` 后面**允许空白**。
- `normalizeDsml` 的两个 `dsml-` 替换同样吃空白（否则归一化后仍剩 `< calls>`，后面全失败）。
- `XML_MARKER_STARTERS` 补 `dsml- tool_calls` / `dsml- invoke` / `dsml- calls`
  （hold-back 判据是逐字符比对 starter 前缀，少列一种跨包就判不出）。
- `findXmlToolCallEnd` 里那条闭合正则**只认半角单竖线** `(?:\|\s*DSML\s*\|\s*)?`，
  而现场是全角 `｜｜` ⇒ 裸 invoke 块的收尾会落到"当正文吐出"分支。改用共用片段。
- `stripStrayToolMarkup` 的包裹标签前缀改为**可选**（裸 `<calls>` / `</calls>` 此前只剥闭合，
  开启标签整行残留）。

### 踩到并修掉的第二个坑：可选性不能写在片段里

修完第一处，`logic-test` 立刻红：`在 HTML 里 <invoke> 不是一个标准标签` 被吞。

原因是我把"前缀可选"实现成 `(?:${DSML_PREFIX})?${DSML_HYPHEN}` —— 两个**各自**可选的片段串起来，
整组仍可为空 ⇒ "无前缀也匹配 invoke" ⇒ 正文里正常讨论的标签被吞。**连踩两次**才想清楚：
可选性只能写在**整个片段的外层**，两个变体必须放进同一个交替里。

所以引入了 `DSML_PREFIX_ONLY`（不带 `?`）专供 `invoke` 使用：包裹标签是 DSML 私有标记，
剥它零风险；`invoke` 是通用 XML 标签，正文里真的会被讨论，必须要求带前缀。

### 用例

- `check-dsml-stray` 18 → **40 项**：前缀矩阵（7 种前缀 × 配平/截断/逐字符）+ 一条**反向**用例
  （正文里正常讨论 `<invoke>` 不被误吞）。
- `dev/probe-dsml-matrix.mjs`：144 组合探针，判为泄漏时**打印上屏原文**。
  ⚠️ 写探针时我连栽两次假结论（把 `ReasoningSanitizer.push` 的字符串返回值当对象用；
  模板拼接出错造出双份后缀），两次都是"只报结论不打证据"。**探针必须能自证。**
- 变异验证：①去掉 `dsml-` 的空白容忍 → 7 条红；②`invoke` 前缀改回可选 → 新用例 +
  `logic-test` 各 1 条红。两个方向都有守卫。
- 产物断言修了一条：原正则绑死了旧的双可选结构（正是本次修掉的错误结构），改成守意图。

`tsc` / smoke / 产物 / **64/64** 全过，矩阵 144 组合全拦得住，真实留痕未污染。

## 0.6.36 — 2026-10-02

**把"提示词里到底有什么"变成可查的事实（诊断），并顺带给出这次现场的完整核对结论。**

用户反复问「是不是把答案直接告诉模型了」—— 这个问题**只靠字符数回答不了**：一个 25k 的提示词
既可能是"把模型的旧回答又发了一遍"（缺陷），也可能是"工具返回"（**正常且必要**）。
两者在网页端看起来一模一样，但一个是 bug、另一个是机制。所以每轮额外落盘**结构计数**：

```
"stats": { "assistant": 0, "user": 1, "toolResult": 1, "systemBlocks": 0 }
```

`assistant > 0` 才是"把模型自己说过的话又发了一遍"。以后不用读分享页**估**，直接查这个文件。

**本次现场的核对结论**（`dev/replay-turn-prompts.mjs` 新增，用会话日志重放**真实发出去的**提示词）：

| 轮次 | 实发字符 | 里面有什么 |
|---|---|---|
| "现在几点了" | **11** | 只有 `User: 现在几点了` |
| 下一轮 | **12** | 只有新增那一条 |
| 天气那轮的搜索返回 | 25491 | `[Tool Result for call_…]`（工具返回，必须回灌） |

**真实发送里 `Assistant:` 是 0 条** —— 模型的旧回答没有被发回去。
分享页里能看到的 `[Tool Result for call_055551695bfc4f82b3e9] 2026-10-02 19:34:10 星期五`
**正是 0.6.35 生效的证据**（改之前这里会是 `User: 2026-10-02 19:34:10 星期五`）；
`Assistant: ` 前缀 0 次、`Tool Calling Protocol` 只出现 1 次（没有重复的固定头）。

> ⚠️ 说明一件事，免得再被误读：**"网页端的提示词里出现了时间/天气"本身不是 bug** ——
> 那是 agent 自己调了 `Get-Date` / `web_fetch`，工具输出必须回灌，否则模型无从得知。
> 判断标准只有一条：**它是 `[Tool Result for …]`（正常）还是 `User: …`（缺陷）**。

**新增** `dev/replay-turn-prompts.mjs`：把某会话每一轮真实发出去的提示词重放出来并给出结构统计。
以后再遇到"提示词里有什么"的疑问，一条命令即可，不必依赖分享页的二手转述。

## 0.6.35 — 2026-10-02

**纠正 0.6.34：真正的原因是 DSH 的工具返回是 `role: "tool"`，而我们没有这个分支。**

0.6.34 我按"工具返回被折进一条普通 user 文本"去修的（判据是"assistant 发过工具调用 ⇒ 紧随的
user 文本就是返回"）。**那个推断是猜的，而且我的证据本身是错的** —— 我用的
`dev/dump-turn-input.mjs` 只打了 `user/message` / `assistant/message` / `request/header` / `step/end`
**四种事件**，而工具返回记在第五种里：

```
type=tool/result  {"message":{"role":"tool",
  "toolCallId":"call_c2cf288c12734112b11e",
  "content":[{"type":"text","text":"2026-10-02 18:54:28 星期五\r\n"}],"isError":false}}
```

**`role: "tool"`** —— 不是 `role:'user'`，也不是 `tool-result` 块（测试夹具里长的是后者，真机不是）。
我们原来**没有 `tool` 这个分支**，于是它掉进 user 分支 ⇒ 渲染成
`User: 2026-10-02 18:54:28 星期五` ⇒ 模型以为"用户告诉了我时间"（它的思考原话：
「**我没拿到工具结果，用户直接给了时间**。那就接受。」）⇒ 回答变成「收到，…」。

**改法（这次是有证据的）**：`serializePromptParts` 增加 `role === 'tool'` 分支，
用消息**自带的** `toolCallId` 与 `isError` 标成 `[Tool Result for <id>]`，
并清掉 0.6.34 那条"预期下一个 user 文本是工具返回"的待办。
0.6.34 的推断**保留为次要防线**（注释已改写，明确它不是主要依据），因为两种形状的期望输出一致、
留着能覆盖我没能证伪的那种形状；且主分支会先清掉待办，它不会再误触发。

**顺带修掉那个把我带偏的工具**：`dev/dump-turn-input.mjs` 增加 `tool/call` / `tool/result` 分支 ——
**看不见工具返回的诊断，比没有诊断更危险**（它让我在错误前提上写了一版修复）。

**用例 69 项**（新增 4 条，直接用手机会话日志里的确切形状）。
⚠️ 写这 4 条时踩了一次**虚守卫**：第一版把 assistant 侧的调用 id 与 `toolCallId` 写成**同一个值**，
于是关掉主分支时次要防线给出同样结果、用例**照样全绿**（变异只红 2 条而不是 4 条）。
把两边的 id 改成不同值后，变异才真正红 4 条 —— 又一次"两个来源同一个值就测不出真伪"。

## 0.6.34 — 2026-10-02

**修复：工具返回被当成「用户说的话」发给模型 —— 所以它回「收到，…」而不是回答问题。**

用户现场（原话）：「提示词还是把答案直接告诉模型了，难怪最后模型的回答有『收到，…』」
（附分享页 + 截图：问「你知道现在几点嘛」→ 答「**收到**，2026-10-02 星期五 18:54，傍晚快七点了。」）

先排除掉已修的那一半：0.6.33 确实在跑（日志已有 `firstDiff`），而且**增量已经正常** ——
`18:51:37 chars=17` / `18:54:09 chars=11` / `18:54:26 chars=14` / `18:54:30 chars=31`，
对比修之前的 **40193**。所以这次的「答案在提示词里」不是回声。

**证据链**（`dev/dump-turn-input.mjs` 读 DSH 自己的会话日志 + 分享页逐行核对）：

```
turn 3  step 1:  user      「你知道现在几点嘛」
                 assistant 「pwsh」            ← 工具调用
         step 2:  assistant 「收到，2026-10-02 星期五 18:54，傍晚快七点了。」
```

**中间那条工具返回，在 DSH 的消息列表里根本不存在**（不是 `tool-result` 块）。
而分享页里渲染出来的是 `User: 2026-10-02 18:54:28 星期五` ——
**`User: ` 前缀只可能由我们的"纯文本分支"产生** ⇒ DSH 把 pwsh 的输出当成一条**普通 user 文本**交给我们。

于是模型读到的是"用户告诉了我时间"。它自己的思考原话（分享页里看得到）：

> 「用户告诉我时间。不需要工具。」
> 「不过我应该核对一下——**我没拿到工具结果，用户直接给了时间**。那就接受。」

⇒ 回答从"回答几点"变成"收到，…"。**用户看到的"答案被喂进去"是真的，但它的根因不是重发，是错标。**

**修法**：`serializePromptParts` 认出这种形状 —— **assistant 发过工具调用 ⇒ 紧随其后的那条 user 文本
按构造只能是工具返回**（agent 循环里必须先有工具返回才轮到下一条用户输入），于是标成
`[Tool Result for <id>]`，不再渲染成 `User: …`。
一对多时逐个配对（一个调用一条返回）；数量对不齐就合并成一条（宁可少一层对应关系，
也不能让它看起来像用户说的话）；**带图片的 user 消息不误标**（那是用户真的发的）。

**新增 5 条用例**（`check-context-feed` 65 项）：必须标成工具返回 / 没有工具调用时不许误标 /
多调用多返回逐个配对 / 数量不齐时合并 / 带图消息不误标。**一处变异确认变红**（关掉这条判据 → 3 红）。

## 0.6.33 — 2026-10-02

**修复：断链重发时把模型自己刚说的话又喂了回去 —— 一句话走掉 4 万字符。**

用户现场（原话）：「我就说了个『哇哦帅气』，结果网页版发送的提示词怎么这么长？？？
以及我问他天气怎么样，结果我看提示词，相当于我发给网页版已知的答案，然后模型在回复我！」

日志一条就够（`feed-decisions.jsonl`）：

```
18:33:09  not-appended  chain=15  ent=15  tail=false  chars=40193  head=14594
```

**5 个字的输入，发出去 40193 字符。** 网页端的用户气泡里赫然是"上一句天气回答 + 哇哦帅气"。

**根因**：`replay`（链还在、但不能只发增量）发的是**整份历史**，而历史里全是 `Assistant: …` 条目
—— 也就是模型自己刚说过的那段回答。**增量路径早就有"剔掉模型回声"这条规则**（0.6.17 为同一个
投诉加的，原话也是"完全没必要"），**但 `replay` 这条路没走它** —— 当时注释写的是"只在增量里剔，
全量需要完整对话（从零重述）"。**这个理由在 replay 上不成立**：走到 replay 说明链还在
（同会话、同账号），那条会话里固定头和历史都还在，根本不是"从零重述"。

**改法**：`replay` 按**代价从小到大**挑，第一个可用的就用：

1. **从第一个分歧点起的条目**（剔回声）—— 通常就是这一句新消息；
2. 整份条目（剔回声）—— 分歧点算不出来时退一步；
3. `transcript`（0.6.32：至少省掉固定头）；
4. 整份 `full` —— 什么都算不出来时的兜底。

每档都要求"非空且不超预算"；头**变了**时只有第 4 档合法（新头从没发过）。
上方那次的 40193 字符，在新逻辑下是 **`User: 哇哦帅气`**。

**顺带把"为什么断链"变成一个可读的事实**：以前只有 `tailSame=false`，它只说"链尾变了"，
不说**是哪一条、从哪儿变的** —— 于是每次排查都只能猜。现在每轮多记 **`firstDiff`**
（和链从第几个条目开始不一样）。这一轮假如早就有它，一眼就能看到是哪一条被改了。

**用例**：`check-context-feed` 60 项（新增 7 条：最小档 / 回声必须剔 / 头变了必须整份 /
退到整份剔回声 / 不许发空串 / 四档都不行时兜底 / 历史变短也走最小档），
`check-context-chain` 19 项（端到端断言"只发分歧点之后的条目、且**不许含固定头**"，
并守 `firstDiff` / `promptChars` / `headChars` 三个留痕字段）。
**两处变异确认变红**：把 replay 改回总是发 full（9 红）、去掉回声过滤（4 红）。

**顺带修的**：三条**绑语法形态**的产物断言与两条老用例，在行为变更后失配 —— 按"改测同一意图"
重写（例如"历史被改写 ⇒ 退回全量"改成"⇒ 只发分歧点之后的条目"），没有把行为改回去。

## 0.6.32 — 2026-10-02

**修复：链式投喂"退回全量重发"时会重发整份固定头（约 6.35 万字符）—— 那一段是纯重复。**

起因是用户对比了 cuckoo 与自己的分享链接：同一段 `Tool Calling Protocol` 在网页端**出现了两次**。

**先看数据，不猜**（`feed-decisions.jsonl`，25 条真实记录）：

| reason | 次数 | 含义 |
|---|---|---|
| `chained`（增量） | 14（56%） | 正常 |
| `new-session` | 6（24%） | **新窗口的第一句** —— 新会话必须全量，天经地义 |
| `no-parts` | 4（16%） | 内部标题请求 |
| `not-appended`（链断） | **1（4%）** | 只有这一次真的退了全量 |

所以"每次调用工具就重发"**与日志不符**（1/25）。但那次重发里有一件**确实该改**的事：

**根因**：`replay`（"链还在但不能只发增量"）一律发整份 `full` = 固定头 + 历史。
而走到 `replay` 就说明**链还在**（同一个网页端会话、同一个账号）——
**那条会话的首条消息里已经把固定头给过了**，重发它是纯重复。
固定头 = system + 协议指令 + 工具目录，实测约 **6.35 万字符**，占一轮的大头；
网页端看到"同一大段又出现一次"就是它。

**改法**：`PromptParts` 新增 `transcript`（`full` 里**属于历史的那一段**，超预算时是截断后那份），
`replay` 在**头没变**时只发 `transcript`：

- `not-appended`（头已确认相同）⇒ **省掉固定头**，省下的就是那 6.35 万字符。
- `head-changed` ⇒ **必须整份重发**（新头从没发过，省了模型手里就是旧头）。
- 没传 `transcript` ⇒ 退回旧行为。所以这是一条**纯优化**：漏传只少省一点，不会错。
- ⚠️ `transcript` 交出去的必须是**截断后**那份 —— 否则"只发历史"会比原来的全量还长，把优化做成事故。有用例钉死。

**顺带补上体量诊断**：`feed-decisions.jsonl` 此前只有"**为什么**走全量"，没有"**发了多大**"。
正是这个缺口让我今天只能去读分享页**估**字符数 —— 估出来的数字不能用来下任何结论。
现在每轮多记 `promptChars`（实发字符数）与 `headChars`（固定头字符数），体量从此可测。

**新增 6 条用例**：省头路径（两种触发都要省）/ `head-changed` 必须重发头 / 没传 `transcript` 退回旧行为 /
`transcript` 恒等于 `full` 里属于历史的那一段 / **截断时 `transcript` 也必须是截断后那份**。
**三处变异确认变红**：把 `replay` 改回总是发 `full`（2 红）、把 `transcript` 交成未截断那份（1 红）、
以及重建后的产物断言。

> ⚠️ 顺带修掉一条**绑语法形态的产物断言**：它写死 `const replay = (reason)` + 120 字窗口，
> 于是这次**无害的形态改动**（箭头+对象字面量 → 块体）把它打红了。已放宽窗口并注明理由 ——
> 产物断言要守**意图**，别守签名长什么样。

## 0.6.31 — 2026-10-02

**修复：新建一个窗口、只发一句话，网页端会多出一个会话（那个是"生成标题"用的脚手架）。**

现场（用户原话）：「刚在 dsh 中新建一个窗口聊天，就发了一句话，网页版直接俩窗口」。
`feed-decisions.jsonl` 里两条对得整整齐齐：

```
12:55:54  new-session   sess=04c63135   ← 对话那条
12:56:00  no-parts      sess=de6a8d4f   ← 网页端多出来的那个
```

`de6a8d4f` 正是用户在网页端看到的那条（标题请求的 prompt 直接显示在里面）。

**根因**：`session-title` 这类内部请求**必须有一条自己的网页端会话**才能调 completion
（0.6.26 为了修「`n/n` 分叉」特意把它们和对话分开，见 `requestSlotKey` 的注释）。
当时的注释写的是「代价是内部请求自己占一个会话，**它不出现在对话里**」——
**判断漏了一半**：它确实不在*对话*里，但它**出现在侧边栏里**。

而它**从来不会被删**：用户设的是 `sessionCleanup: keep`，而清理器的 `schedule()` 在 keep 下
第一行就 `return` —— 于是这条会话**连 ledger 都没有**（从没安排过删除），永远留在网页端。

**改法**：把「内部请求的会话」与「用户的对话会话」在**收尾时彻底分开**。

- 收尾时按 `promptParts` 有没有传来分（与 `requestSlotKey`、adapter 的 `chatLike` 同一处判据）：
  **不带** = 内部请求 ⇒ 会话是**脚手架**，一律走新的 `onDiscardSession` 通道丢掉，
  **不进用户的清理队列**。
- ⚠️ **复用来的会话也要丢** —— 它不在收尾逻辑的 `owned` 集合里（那一轮没调 `createSession`），
  这正是最容易漏掉的一半。
- 清理器新增 `discard(auth, sessionId)`：**不受 `keep` / `manualOnly` 影响** ——
  那两道开关的语义是「别删**我的对话**」，而脚手架会话不是用户的对话。
- ⚠️ `discard` **只删那一个**，**不 drain 队列**：`manualOnly`（链式模式）下队列里攒的是
  **用户的**会话，借这次机会顺手删掉就变成"用户没点按钮却被删了"（0.6.1x 修过的那个 bug）。
- ⚠️ 仍然受 `deleteWebSessions === false`（"一个都不许删"总闸）约束 —— 那个开关不能破。
  所以**关掉总闸时这类会话仍会留在网页端**，这是已知代价。

**顺带把一条"注意事项"升级成硬约束：测试 fixture 模拟真实 chat 时必须传 `promptParts`。**
改了收尾判据之后，4 个用例文件成批变红 —— 全是拿裸 `params`（不带 `promptParts`）去测
"chat 会话的轮换 / 回收 / 归属"的。这不是 bug，是夹具没按生产链路的形态构造
（adapter 只给 `chatLike` 传 `promptParts`）。已给 6 处夹具补上，并在文件里写清为什么。

**新增 6 条用例**（`check-internal-session-discard.mjs`）：内部请求走「丢掉」通道且不进用户队列 /
复用的会话也要丢 / 对话请求**不**走丢弃通道（防过度清理）/ `keep` 与 `manualOnly` 下都必须删 /
`discard` 不许顺手清空用户的队列。**三处变异确认变红**：关掉内部请求分支（2 红）、
把 `discard` 改成 drain 队列（2 红）、以及重建后的产物断言。

> ⚠️ 又记一条**产物断言的坑**：打包器除了会去掉单语句的花括号，还会把 `undefined` 改写成 `void 0`
> —— 断言里写 `=== undefined` 必然假红（这次踩了）。

## 0.6.30 — 2026-10-02

**补齐请求头：把浏览器**自动加**的那批指纹头收回来，并修掉一个过时的写死版本号。**

起因是调研"能不能不打开浏览器也像真浏览器发消息"（报告见工作区 `浏览器指纹伪装可行性调研.md`）。
调研的结论之一是：**在改 TLS 之前，头部这一层就有零成本的差距可以补**。

对着**真实登录捕获**（`accounts/acc_9be659e4.json`，2026-10-02T03:42Z）核对出两处：

1. **收头的规则只认 `x-*`，于是浏览器自动加的那批全被丢掉**：
   `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform`、
   `sec-fetch-dest` / `sec-fetch-mode` / `sec-fetch-site`、`priority`、`accept`。
   这批是"是不是真浏览器"最表层的信号 —— 真实 Chrome/Edge 发 fetch 请求时一定会带，
   而我们一条都没发。现在收进来，并且**保留浏览器给头的顺序**（顺序本身就是指纹）。

2. **`x-client-version` 写死 `2.0.0`，而真实捕获是 `2.5.0`** —— 落后两个小版本，而且
   **没有任何机制会发现它过时**。真实值一直走的是抓取那条路（所以线上没暴露），
   但抓取失败时就会发这个陈旧值。现在：抓来的真值永远优先，写死的只做兜底并标注要定期校准。

**顺带（同一批证据的两件事）：**

- `pickExtraHeaders` 的规则原先在 `browser-login.ts`（CDP 路径）和 `login.ts`（旧 webRequest 路径）
  **各写了一遍** —— 两份一旦漂移，"同一账号换个登录方式指纹就不一样"，且不会有任何报错。
  现在只有一处，两边都调它。
- `captureDefect()` 增加一条判据：**抓到了头、但里面没有 `x-device-id`** 也算捕获缺陷。
  依据：真实捕获里 `x-device-id` 是数美设备指纹（UUID），而上游对"缺少浏览器设备指纹"
  会直接返回 `biz_code=11 / RISK_DEVICE_DETECTED` —— 缺了它不是"信息少一点"，是**会被风控判定**。
  ⚠️ 只覆盖"有头但缺这一项"；`extraHeaders` 整个为空的手工粘 token 路径**故意不碰**（既有设计）。

**刻意不做的一件事：不收 `accept-encoding`。**
它是浏览器的解压能力声明，服务端可能据此回 `zstd`，而 Node 侧的 `fetch`（undici）不保证能解 ——
一旦解不开，SSE 会**静默变成乱码**（不是报错，是内容全错）。这是"宁可少一个头，也不要静默坏掉"的取舍，
代码里写了理由，用例里也钉住了（防止有人"顺手补上"）。

⚠️ **一处保留的偏差**：真实浏览器**不发** `x-app-version`（7 个 `x-*` 里没有它），我们仍在发。
保留是为了不改变既有行为，代码里标了注释 —— 想更贴近浏览器，删掉那一行即可。

**新增 11 条用例**（`check-request-headers.mjs`，此前 `pickExtraHeaders` 只有 1 条、`buildDsHeaders` 零覆盖）：
该收的收进来 / 不该收的别收（逐请求头 + `accept-encoding`）/ 顺序保留 / 抓来的真值赢过兜底 /
逐请求头必须用当前值（旧 token 旧 cookie 不许漏出去）。
四处变异确认变红：白名单改回 `x-`（3 条红）、兜底覆盖抓取值（1 条红）、关掉 `x-device-id` 判据（1 条红）、
以及重建后的一处产物断言。

> ⚠️ 写用例时踩了一次**虚断言**：第一版把"抓来的值"和兜底都写成 `2.5.0`，于是
> "兜底覆盖抓取值"这个变异体照样通过（两者无法区分）。改用 `88.8.8` 之后才真的能打红。
> 这正是"先自问这条用例在改之前是不是也绿"那条铁律的又一次实证。

## 0.6.29 — 2026-10-02

**修复：登录态过期（或账号被限流）之后，重新登录会"又新建一个网页端会话"、整段历史全量重发。**

现场：用户在旧窗口发了一条消息，网页端凭空多出一个会话；DSH 日志里那一轮是
`API 密钥无效`（AUTH）→ 重试 1795ms。他随后重新登录了**同一个账号**，但会话没能接回去。
`feed-decisions.jsonl` 对上了：那次是 `new-session`，而 `account` 前后**完全一样** ——
账号没变，是**会话槽被退役了**。

**根因**：`retireSession()` 被当成"失败即弃"用在了三处失败分支（`webapi.ts`）：
建连抛错、`!resp.ok`、业务错误信封。401/403 说的是**令牌**过期、429 说的是**账号级**限流
—— 这些跟"这个会话"毫无关系，而且**换一个新会话账号照样被限**：退役它没有任何好处，
唯一的效果是把用户整段对话丢掉（重登后只能新建会话 + 把历史全量重发一遍）。

**改法**：只有**服务端明说"这个会话废了"**（业务码 `invalid chat session id`）才退役；
认证与限流这类**账号级**失败改为记进 `keepIds`，由收尾逻辑保住。

- 判定发生在 `openCompletion`（只有它看得见错误码/业务码），消费发生在
  `streamWebCompletion` 的 finally —— 因为建连阶段失败时外层 `sessionId` **还是 undefined**
  （它在 `await` 之后才赋值），`id === sessionId` 恒假，靠错误码在外层判会连"本轮真正在用的
  那个会话"一起退役。
- ⚠️ 5xx / 网络失败 / 取消 / 空响应**不在**保留之列：那些情况下服务端可能已经开始生成、
  会话停在半路，照旧退役（N04 的意图不削弱）。原「失败即弃」用例改用 500 并改名为
  「服务端 5xx（会话可能停在半路）⇒ 不复用那个会话」，意图不变、范围收窄。

**新增 5 条用例**：401 / 429 / `user is muted` / `throttled` 四种账号级失败后必须**接回原会话**、
且不得把会话交给宿主去删；外加"新窗口第一轮就 401"（走的是收尾逻辑那条路径 ——
复用来的会话不在 `owned` 里，两条路径必须各守一条）。
四处变异全部确认变红：内联跳过、信封分支、收尾闸门，以及重建后的产物断言。

## 0.6.28 — 2026-10-02

**修复：思考通道的垃圾（DSML 等工具调用标记）会显示在网页端、并且一直留在转写里。**

起因是用户拿另一个项目（cuckoo-code）对照，说"用它从来没在网页端见过 DSML，一个项目就是一个会话"。
读数之后确认真凶不在会话管理（0.6.22~0.6.26 已经修好，实机 `feed-decisions.jsonl` 里连续 6 轮
`chained / tailSame=true` 为证），而在**思考通道**：

- **思考通道此前一道网都没有**。正文通道有四道网（工具调用捕获 / 残片剥离 / 伪系统标记 /
  免责声明 / 回声守卫），而 `adapter.ts` 里思考分支一句 `continue` 把网全跳过了。
  模型在思考里起草工具调用（JSON 或 XML/DSML）或伪造 `<ds_system>` 块时，标记会：
  ① 原样显示在网页端的思考区；② 进 DSH 历史 ⇒ 下一轮被当增量**重发** ⇒
  变成网页端可见的正文垃圾，并且**一直留着**，每轮重复。
- **新增 `ReasoningSanitizer`**（protocol.ts）：复用 `ToolCallStreamFilter` 那套久经考验的捕获逻辑，
  但**不提取调用、不报拒绝** —— 思考里出现标记时模型还在推理，执行它是语义错误；报拒绝则会
  把一次本来正常的续写打断。只把标记本身抹掉，思考的其余部分一个字都不许少。
  轮末必须 `flush()`，否则被跨包 hold 住的尾巴会静默少一截。

**顺带修一个把诊断数据搞脏的缺陷：**

- 跑一次 `npm run test` 会往**用户真实的** `~/.dsh/web-login/feed-decisions.jsonl` 灌 695 条
  测试噪声（`sess-1..7`、同一毫秒）。诊断数据被污染比没有数据更糟 —— 排查真实问题前得先手工
  滤掉噪声。两层都漏：① 4 个用例（fetch-injection / session-lifecycle / session-reuse /
  session-journal）没设 `DSH_HOME`；② 跑批脚本 `test-offline.mjs` 没有兜底。
  现在跑批给每个子进程注入临时 `DSH_HOME`，另加 `check-test-isolation.mjs` 守"会写状态的用例
  必须自己隔离"，新用例自动纳入。
- `feedDecisionLogPath()` 改为走 `webLoginDir()`（原先自己拼了一遍 `DSH_HOME || ~/.dsh`，
  是路径的第二份来源）；`dumpSinkPath()` 同理改走 `resolveDshHome()`。

**新增：** `dev/scan-dsml.mjs`（扫会话日志里有没有工具调用标记，含多帧 zstd 解压）、
`dev/scan-session-images.mjs`、`dev/dump-image-messages.mjs`、`dev/trace-session-images.mjs`。

## 0.6.27 — 2026-10-02

**修复：早先发过的图片被反复重挂在后面的每条消息上（"我这轮没发图，网页端却又有图"）。**

### 取证过程（这次没有猜）

1. 用户截图：那条 `哈哈哈哈` 消息上挂着两个图片框，但 DSH 里它**没有**图。
2. 先确认"图是不是真实存在"：写工具解 DSH 会话日志（`dev/scan-session-images.mjs`）——
   `session.v4.jsonl.zstd` 是 **zstd 多帧**（一个 70KB 文件 34 帧），而 `zstdDecompressSync()`
   **只解第一帧**，只拿到 session header ⇒ "含 image 的行数"永远是 0（**假阴性**）。
   逐帧解压后确认：会话里确实有 **2 条带图的用户消息**（"还不错哎"、"这个能看见了吧"）。
3. 既然图是真的，问题就变成"**为什么它出现在不含图的那一轮**"—— 于是回到代码。

### 根因

`sentRefIds`（"服务端已见过哪些图"的账本）原本是**一个全局 Set + 一个 `sentRefIdsSession` 变量**：

```js
if (sentRefIdsSession !== sessionId) { sentRefIds = new Set(); sentRefIdsSession = sessionId }
```

两个窗口交错时它们会互相覆盖：

1. 窗口 A 的请求进来 → 记成 A
2. 窗口 B 的请求进来（A 还没返回）→ **清空**，记成 B（A 的账没了）
3. A 的下一轮进来 → 发现 `sentRefIdsSession` 不是自己 → **再清一次**

⇒ A 里**早就发出去过**的图，每轮都被当成"没发过"⇒ 反复重发 ⇒ 网页端把它们挂到了后面每条消息上。

### 修法

账本改成 **`Map<sessionId, Set<key>>`**：每个会话各记各的，并发的窗口互不影响。
会话退役（`retireSession`）与全量清理（`disposeSessionReuse`）时销掉对应条目，避免 Map 跟着开过的窗口一直涨。

### 验证

- 新增用例：**两个窗口交错**（A 首轮 → B 首轮 → A 续轮 → B 续轮），
  断言各自的图都只发一次、续轮不再重发
- 变异反向验证：把账本改回"会话一变就清空" ⇒ 用例变红、`rc=1`
- 另修两条产物断言（它们引用的是已被替换的旧变量形态；意图不变）
- `tsc --noEmit`、`npm run test`（60/60）、`check-smoke`、`check-bundle` 全通过

### 新增诊断工具

- `dev/scan-session-images.mjs`：扫一个会话日志，报"历史里到底有没有图片"
- `dev/dump-image-messages.mjs`：把带图的消息连同文本一起打出来（判断图该挂在哪一轮）
- `dev/trace-session-images.mjs`：列出图片出现在日志的第几行

## 0.6.26 — 2026-10-01

**修复：新开一个窗口、只发一句话，网页端却显示「修改」+ `2 / 2`。**

### 根因：内部请求占用了对话的会话槽

时序（新窗口的第一句话）：

1. DSH 先发一次 `session-title`（**内部请求，不带结构化 promptParts**）
2. 它与对话共用同一个 DSH sessionId ⇒ 此前共用同一个 slotKey
3. 于是 `session-title` 先建会话、发出一条**根消息**（`parent=null`，内容就是那段
   `Create a concise title…`）；用户的真实消息随后**复用**这个会话，但内部请求不传 parts、
   没有链 ⇒ `decideFeed` 只能 `detach('no-chain')` ⇒ **又是一条根消息**
4. 服务端把这两条看成**同一条用户消息的两个版本** ⇒ 网页端渲染成 `1 / 2`、`2 / 2` + 「修改」，
   而且标题 prompt 直接暴露在用户的对话里

### 修法

新增 `requestSlotKey(auth, params)`，**两个调用点（`openCompletion` / `streamWebCompletion`）
统一使用**（键必须同源，否则链会写在一个键、读另一个键）：

| 请求 | 归属键 |
|---|---|
| 带 `promptParts`（真正的对话） | `账号\|DSH会话` |
| 不带 `promptParts`（`session-title` / 压缩等） | `internal\|账号` |

分开之后，对话槽里的第一条消息**永远**是这个窗口真正发出的那一条 —— 根消息只有一条。

### 顺带

「自动换号」的提示补上一句：**每换一次号，网页端就会多出一个新会话**（旧会话属于旧账号）。
用户两次被"同一个窗口又多一个会话"搞懵，都是因为不知道中间换过号。

### 验证

- 新增 2 条用例（端到端 + 会话分槽），并修正 4 处 fixture —— 真实 chat 请求必须带 `promptParts`，
  否则会被当成内部请求（这本身就是修复要引入的区分）
- 变异反向验证：把 `requestSlotKey` 改回"共用槽" ⇒ 两条用例都变红、`rc=1`
- `tsc --noEmit`、`npm run test`（60/60）、`check-smoke`、`check-bundle` 全通过

## 0.6.25 — 2026-10-01

**新增：投喂决策留痕（`feed-decisions.jsonl`）—— 把"这一轮为什么没走增量"变成可查的事实。**

### 为什么要有

判据只在**原因变化时**打 `链式投喂退回全量重发（原因=X）`，而**宿主日志不落盘**。
2026-10-01 两次排查（"每轮都发全量"、"同一个窗口又多一个会话"）都被这一点卡住，
最后只能往**已安装的产物**里插桩 —— 那是能查，但每次都要占一个发版周期。

### 做了什么

每一轮决策追加一行到 `~/.dsh/web-login/feed-decisions.jsonl`（环形保留 300 条，超 256 KB 自动裁剪）：

| 字段 | 含义 |
|---|---|
| `reason` | `chained`（真的只发增量）或退回全量的具体原因 |
| `reused` | 这一轮的网页端会话是不是复用来的 |
| `session` / `account` | 会话与账号键前 8 位 —— **切号会让 `account` 变**，一眼看出"多出来的会话"是不是换号造成的 |
| `chainLen` / `entriesLen` | 链里已发的条目数 / 本轮条目数 |
| `tailSame` | **链尾是否仍在本轮的同一位置** —— `canExtendChain` 第二条判据的直接答案，`false` 就是"DSH 改写了历史"的实锤 |

⚠️ 只记**结构性事实**（长度 / 原因 / 是否复用），不记任何内容。

### 验证

- 新增一条端到端用例：跑三轮（起链 → 严格追加 → 历史被改写），
  断言落盘三条、`reason` 依次为 `new-session` / `chained` / `not-appended`，
  且 `tailSame` 为 `null` / `true` / `false`
- 变异反向验证：把 `tailSame` 写死成 `null` ⇒ 用例变红、`rc=1`
- `tsc --noEmit`、`npm run test`（60/60）、`check-smoke`、`check-bundle` 全通过

## 0.6.24 — 2026-10-01

**修复：浏览器代理传输层不支持 `FormData` ⇒ 图片全部上传失败。**

### 现象

切到浏览器代理传输层（0.6.20 起，官方 DSH 桌面端拿不到 `electron.net.fetch` 时的默认路径）后，
粘贴图片会得到：

```
有 1 张图片没能传给模型（DeepSeek 图片上传失败：浏览器代理传输层暂不支持
Blob/FormData/ReadableStream 请求体），本轮回答只基于文字内容。
```

### 根因

0.6.20 的 `bodyToPageInit()` 只把 `string` / `Uint8Array` / `ArrayBuffer` 转成页面侧可重建的表达式，
遇到别的类型直接抛错。而**图片上传走的正是 `FormData`（multipart）**
（`webapi.uploadImageFile` 里 `form.append('file', new Blob(...), name)`）。

### 修法

`bodyToPageInit()` 现在支持 `FormData` 与 `Blob`，做法是把内容按**字节**搬到页面里重建：

- 字节用 **base64** 传（而非 JSON 数组）—— 体积约为 1/2.4，CDP 消息不会被大图撑爆；
- 页面侧注入两个小工具：`__dshB64ToBytes`（base64 → Uint8Array）与
  `__dshRebuildFormData`（按 parts 重建 `FormData`）；
- 文件部分用 **`new File(...)`** 而不是 `new Blob(...)` —— 必须保住 **filename**，
  因为服务端按**文件名后缀**判图片类型（见 `protocol.ts`）；
- 语言无关地遍历 `FormData`（用 `forEach`，不用 `entries()` —— 后者要 `DOM.Iterable` lib）。

### 验证

- 新增一条**真实往返**用例：启本地 HTTP 服务，用 200 KB 的假 PNG 走 `FormData` 上传，
  断言 `content-type` 带 boundary、`filename` 保住、PNG 魔数（8 字节）原样到达
- 变异反向验证：把 `FormData` 分支禁用 ⇒ 用例变红、`rc=1`，报错信息与用户截图**逐字一致**
- `tsc --noEmit`、`npm run test`（60/60）、`check-smoke`、`check-bundle` 全通过

## 0.6.23 — 2026-10-01

**一个窗口 = 一条对话线：不再断链、不再分叉、不再删会话。**

0.6.22 只堵住了"每轮换新会话"，但**链仍然每轮断**——`parent_message_id` 一变成 `null`，
网页端就把那条渲染成**同层消息**（「修改 / 重新生成」+ `n / n` 翻页）。这次治的是断链本身。

### ① 续链判据：从"严格前缀"改成"容得下运行时注入被原地替换"

旧判据要求 `prev[i] === next[i]` 对全部 i 成立；而 DSH **每一轮**都会重写它自己注入的那条
运行时快照（原话：`Current runtime context. This snapshot supersedes earlier runtime-context
snapshots.`）——**替换式**，位置不变、内容每轮变。于是链几乎每轮都作废。

新判据 `canExtendChain` 两条：
1. 本轮条目必须**真的变长**（没变长说不清是重发还是历史被截断，保守退回）；
2. **链尾仍在原位**（`next[prev.length-1] === prev[prev.length-1]`）——同时挡住
   "整体重写"和"中途插入/删除"（那会让增量切错位置）。
满足时中间差异只可能是原位替换，`entries.slice(prev.length)` 切出来的正好是真正的新内容。

### ② 退回全量时**不再发根消息**（这是"分叉"的直接来源）

`decideFeed` 里把收尾拆成两条路：
- `detach`（`parent: null`）——**只有真的没有链**时才走：新会话 / 换了 DSH 会话 / 换了账号；
- `replay`（`parent:` 链尾）——头部变了、历史被改写、增量空/超预算等，**重发全量但仍挂链尾**。

代价只是服务端上下文里多一段重复历史，而分叉是**结构性**的坏。

### ③ 槽位淘汰不再删网页端会话

超限时旧实现 `retireSession + cleanup`（= 排队 DELETE）。现在只清内存槽与链：
会话留着，回到那个窗口还能接着用；而且"删会话"本身是最强的机器特征之一。

### ④ 顺带修正：投喂回执里的 `chained` 改按 `reason` 判

旧写法 `chained: feed.parentMessageId !== null`，而 ② 之后"重发全量"也挂在链尾 ⇒
会把"这一轮其实重发了全量"报成 `chained=true`，日志直接说谎。

### 验证

- `tsc --noEmit`、`npm run test`（60/60）、`check-smoke`、`check-bundle` 全通过
- 新增 4 条用例（2 条 ★ 在 `decideFeed` 层、1 条 ★ 端到端、1 条 ★ 槽位淘汰）
- 三条修复各自**变异反向验证**：改回旧实现 ⇒ 对应用例变红、`rc=1`

## 0.6.22 — 2026-10-01

**修复：一个窗口聊两句、网页端多出三个会话；以及选「不删」反而触发一次批量删除。**

两个独立 bug。这次不再是推测——判据来自实机证据：会话 `13fc4478` 的原始事件日志
（哪一轮发了什么、有几个 step）＋ `~/.dsh/web-login/sessions-in-use.json` 的实际内容
（11 条记录：8 条 `queued` / 3 条 `slot`，时间点与前者的 turn/step 逐一对应）。

### ① 重开链强制换新会话 ⇒ 每个回合多一个网页端会话

- `needsFreshSession` 的旧判据：链式模式下「要发根消息 + 会话是复用来的」就**换一个新会话**
  （0.6.10 引入，当时的假设是"重开链是异常路径，代价可接受"）。
- 实测该假设不成立：DSH 每一轮都会重新生成**替换式**的运行时注入
  （原话：`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`），
  链的 entries 于是不再是本轮 entries 的严格前缀 ⇒ `decideFeed` 必然 `restart('not-appended')`
  ⇒ parent=null ⇒ 换新会话、旧会话交回清理。实测时间线：12:50:36 建会话①、12:51:07 建②、
  12:51:13 建③ —— 一个窗口、两句对话。
- 现在**默认不换**：重开链就在当前会话里发根消息，一个窗口始终只用一个网页端会话。
- 保留开关：面板「上下文」页 →「重开链时换新会话」，或 `gate.json` 的
  `freshSessionOnRestart`（缺省 `false`）。打开即恢复 0.6.10 的行为。

### ② 在设置页选「不删」，反而立刻触发一次批量删除

- `createSessionCleaner().configure()` 对 `mode === 'keep'` 调用的是 `flush()`，
  而 `flush()` → `doFlush()` → `deleteChunk()` 是**真的发 DELETE 请求**——
  用户的意图与执行结果完全相反。
- 改为「放弃队列」：清空待删队列、撤掉定时器，并**逐条发 `abandoned`** 让宿主把
  `session-journal` 里的欠账销掉。少了销账这一步，下次启动只要清理模式不是 `keep`，
  补扫又会把这些会话删掉（等于"不删"只生效到本次进程结束）。
- 宿主的销账分支（`deleted` / `abandoned`）移到 `journalEnabled` 判断**之前** ——
  `keep` 模式下 `journalEnabled` 为 `false`，否则记录根本摘不掉。

### 验证

- `tsc --noEmit`、`npm run test`（60/60 用例文件）、`check-smoke`、`check-bundle` 全部通过
- 新增 5 条用例，其中 2 条是**行为断言**（★：切成「不删」后一个 `DELETE` 都不许发出；
  放弃删除必须逐条报 `abandoned`）
- 两条修复各自做了**变异反向验证**：把源码改回 bug ⇒ 对应用例变红、`rc=1`
- 首版用例的默认值断言曾与常量脱钩（`reset` 里写死 `false`），导致"改默认值"的变异跑不出红；
  已把默认值收敛成单一来源 `DEFAULT_FRESH_SESSION_ON_RESTART`

## 0.6.21 — 2026-10-01

**修复：传输层诊断测试未跟随浏览器代理。**

- 面板显示「通过系统 Edge/Chrome 进程代理」时，「测试传输层」按钮仍只检查 `electron.net.fetch`，
  导致实际已生效的浏览器代理被误判为不可用。
- `transport.ts` 新增 `currentEffectiveFetch()`，记录并暴露当前实际生效的 fetch 种类
  (`node` / `electron` / `browser`)。
- `net-diagnostics.ts` 改为用当前生效的 fetch 做探测，测试结果区分 `electron.net.fetch` 与
  `浏览器代理`。
- 当实际生效为 Node fetch 时，错误提示改为「未启用 Chrome 网络栈」。

## 0.6.20 — 2026-10-01

**浏览器代理传输层：官方 DSH 桌面端也能走真实 Chrome 指纹。**

- 新增 `src/browser-transport.ts`：当 `electron.net.fetch` 不可用时，启动系统里的 Edge/Chrome 进程
  （headless + 独立 profile），通过 CDP `Runtime.addBinding` 把请求代理给浏览器的 `fetch()`。
- 请求实际从浏览器网络栈发出，TLS/HTTP2 指纹与真实浏览器一致；响应通过 binding 分块传回 Node，
  再包装成标准 `Response`（含 ReadableStream）。
- `transport.ts` 自动 fallback：electron.net.fetch → 系统浏览器代理 → Node fetch。
- 设置页提示更新：走浏览器代理时显示「通过系统 Edge/Chrome 进程代理」；无浏览器时才降级 Node。
- 新增回归用例 `tests/check-browser-transport.mjs`；保留 `DSH_NO_BROWSER_TRANSPORT=1` 测试开关。
- 传输层文案保持「Chrome 网络栈」（0.6.19）。

## 0.6.19 — 2026-10-01

**面板文案：传输层统一称为 Chrome 网络栈。**

- 设置页按钮、状态提示、切换反馈、降级提示、tooltip 中的「Chromium 网络栈」全部改为「Chrome 网络栈」，
  与实际要模仿的指纹（Chrome）保持一致。
- tooltip 增加原因说明：官方 DSH 桌面端把插件跑成 `ELECTRON_RUN_AS_NODE=1` 的 Node 子进程，
  拿不到 `electron.net.fetch`，因此不支持 Chrome 网络栈，只能降级为 Node fetch。
- 内部实现、传输层类型、默认值仍保持 `chromium` 不变（底层就是 Chromium 网络库，指纹与 Chrome 一致）。

## 0.6.18 — 2026-10-01

**修会话爆炸：token 刷新/内部请求不再冲掉 chat 的网页端会话。**

用户现场：链式投喂下，一个窗口聊了几句后网页端突然多出几个新会话，上一句的会话也没了；
刷新后只剩一个。根因有两个，合在一起触发：

1. **`accountKey` 用 `token|cookie` 当账号身份** —— token 每 2 小时左右就会刷新（自动/手动重登），
   刷新后插件认为"换了账号"，旧网页端会话被退役，投喂链也断了。
2. **内部请求（`session-title`、`compaction` 等）也传 `promptParts` 走链式** —— 这些请求的条目
   和 chat 的链不匹配，触发了「历史不是严格追加 → 重开链 → 强制换新会话」，于是每个标题/压缩
   请求都把当前 chat 会话冲掉，旧的删、新的建。

### 改动

- `webapi.ts`：`accountKey` 优先用服务端返回的 `user.id` 当稳定身份；没有 `user.id` 时才回退到
  `token|cookie`（兼容手动粘 token 的老记录）。
- `adapter.ts`：只有用户可见的 `chat` 才把 `promptParts` 传下去；`session-title` / `compaction`
  等内部调用走全量，不再抢 chat 的链。
- `context-feed.ts` / `webapi.ts`：没有 `promptParts` 的请求不触发「强制换新会话」，也不会因为
  没 ready 而把 chat 的链删掉。
- 回归用例：`check-session-reuse` +2（token 刷新稳定性/回退）、`check-context-chain` +1、
  `check-context-feed` +1，全部反向验证。

## 0.6.17 — 2026-10-01

**增量投喂不再重发「模型上一句回答」（用户反馈：完全没必要）。**

用户原话：「为啥网页版的聊天我看到了，还总是把模型上一句回答的结果，加到下一句当提示词！
完全没必要啊！！！！」（附截图：增量气泡里赫然是 `Assistant: <上一句整段回答>` + `User: 嘟嘟嘟!`）

原因：主机的消息列表里既有用户消息、也有**助手消息**（＝我们上一轮从服务端流下来的那段回复）；
`serializePromptParts` 把它们统一转写成 `Assistant: …` / `User: …` 条目，而增量投喂原样把
"新追加的条目"整段发出去 ⇒ 那条回答被当成下一句的输入重发。**它本来就是服务端的上一轮输出
（就在我们要挂的父消息位置），重发纯属白烧 token，还让模型看到自己在"自言自语"。**

改动：

1. `context-feed.ts` 新增 `isAssistantTranscriptEntry()`：增量里 `Assistant: …` 条目一律剔除。
   ⚠️ **只剔增量**：全量 prompt 是"从零重述"，必须保留完整对话（有用例钉着）。
2. 🔴 **续写/纠正轮必须跳过剔除** —— 那两轮（`adapter.ts` 在回答被截断 / 模型把工具程序写进正文时
   自动发起）是**故意**把半截回答再发一遍的（`Assistant: 半截` + `User: <续写指令>`），
   剔了模型就只能从零重写。判据用**插件自己的指令常量**（`isContinuationCue`），不猜文案 ——
   为此把 `CONTINUE_INSTRUCTION` / `TOOL_CALL_RETRY_INSTRUCTION` 从 `adapter.ts` 挪到
   `protocol.ts`（单一来源，适配器与判据共用）。
   ⚠️ 这条是**既有用例逼出来的**：一刀切的实现让「链式 + 续写轮」那条用例立刻变红，
   说明它守的是真语义差异，不是过时的断言。
3. 边界：尾巴上**只有**回声（没有新用户/工具内容）时不做剔除 —— 宁可多发一段，
   也不要发空增量让这一轮退化成重开链（那会连带换掉会话）。
4. 可见性：剔了几条进日志（`另略过 N 条模型回声`）并进决策回执（`echoDropped`）。

用例：`check-context-feed` +4（剔回声 / 工具调用回声也剔 / 尾巴只有回声时不剔 / 全量不受影响），
并把「续写轮」那条改成用**真实常量**构造（原来用自造文案）＋断言"续写轮不剔"。
反向验证：退回一刀切的实现 ⇒ 新用例立刻变红。59/59 用例文件通过。

## 0.6.16 — 2026-10-01

**修严重的现场 bug：链式模式下"一个窗口聊三句 ⇒ 网页端多出三个新会话，旧会话还被删掉"。**

### 根因（全程靠插桩定位，没有猜）

收尾"放过这个会话"的条件是：

```ts
if (id === sessionId && complete && !poisoned && limit > 0) continue   // 放过
retireSession(id); cleanup(id)                                        // 否则退役 + 删除
```

链式模式只保证了 `limit > 0`（不轮换），但**还有 `complete && !poisoned` 这道门** ——
而 `complete` 只在一个地方置真：底层流的迭代器自然结束（`item.done`）。
**消费方（DSH）读到终止事件就停止取值**，我们拿不到 `item.done`，`complete` 永远是 `false`，
于是每一轮结束时这个会话都被 `retireSession + cleanup`（**弃用并删除**）、链也记不上
⇒ 下一轮只能再新建一个会话。用户看到的就是"每轮一个新会话 + 旧会话在网页端消失"。

插桩记录（`~/.dsh/web-login/diag-feed.jsonl`）是决定性证据：同一个归属键下
`命中旧槽=false → NEW session=…` 连着三轮，而中间那一轮 `命中旧槽=true → feed chained chars=133`
—— 同一份代码里两种结果都有，说明不是"永远连不上"，而是成功的那一轮也被判成没跑完。

### 修法

1. **认服务端的显式终态**：`kind:'finish'`（`[DONE]` 时解析器补发的收尾事件）或
   `response/status: FINISHED` 一到，`sawTerminal = true`；收尾判据改成
   `roundOk = complete || sawTerminal`（会话保留 + 链记账都用它）。
   这与项目既有纪律一致（"SSE 判卡住要用显式终态，不看有没有字节"）。
2. **N04 的意图不变**：真的提前中断（没等到终态）仍要退役会话 —— 那个会话可能停在半路。
   用例一正一反把这个边界钉住了。
3. **加持久可见性**：收尾退役时记下原因（`extra-session` / `poisoned` / `not-finished` / `rotated`），
   挂在 `GET /context-mode` 的 `chain.lastRetire` 上 —— 这类"每轮新建会话"下次不用再插桩。

用例：`check-context-chain` 新增两条（消费方读完终态就停 ⇒ 会话保留+链记上；终止前就停 ⇒ 仍退役），
**并做了反向验证**：把修复退回去（`roundOk = complete`）第一条立刻变红，改回来即绿。

### 排查过程留下的工具

`dev/patch-diag.mjs`：往**已安装产物**里插 6 处只读诊断（不用发版/不占装机周期就能拿到
"每轮决策原因、租用键、是否新建会话、head 从第几个字符开始不同"）。两个坑已写在脚本注释里：
对象最后一个属性没有尾逗号（逗号要放开头）、备份源不能拿目标文件自己。

## 0.6.15 — 2026-10-01

**界面两处修正（用户反馈）：「一键重登」搬到账号库；删掉一堆误导性的"注释"。**

用户原话：「首先我没有看到『一键重登』的按钮，其次有很多注释完全不需要，什么 cookie 剩余多少天
过期，完全没必要显示，不照样还是几个小时就需要重登嘛！这些注释写的真多余，导致界面不美观。」

1. **「一键重登」位置错了**：0.6.14 把它 append 到了 `gateCard`（防风控页的设置卡），
   而用户是在「账号库」子标签里找 —— 自然找不到。现在挪到**账号库的按钮行**，紧跟
   「登录新账号（添加）」（两者是同一类动作：弄到可用凭证），按钮文案统一成「一键重登」，
   结果走**全局提示条**（常驻标签栏之上，切子标签也看得见）。
2. **删掉 cookie 的"还剩多少天"**：原来报的是持久级 cookie 的到期日（实测
   `thumbcache_*` 还剩 399 天），而真正鉴权的 token 只有 **87~370 分钟**寿命 ——
   两个数量级摆在一起只会让人读成"这号还能用 399 天"，然后发现几小时就得重登。
   `describeCookieLife` 现在只报构成（`5 项 · 3 会话级 · 2 持久级`），名字与天数都不再出现。
3. **合并/精简状态行**：「Cookie 过期」并进「Cookie」一行；「凭证来源」去掉长括号；
   「指纹头」/「Cookie 未捕获」的长解释改成短句；删掉信息量为零的「PoW WASM」行。
4. **账号行元信息瘦身**：从
   `davi***+w5@gmail.com · 9/30 17:34 捕获 · 最近校验 21 小时前 · cookie：5 项 · 3 会话级 · 2 持久级 · .thumbcache_… 还剩 399 天`
   缩到 `9/30 17:34 捕获 · 最近校验 21 小时前`（账号名标题里已经有了，不再重复）。

用例：`check-cookie-meta` 改成守新意图（**并且新增一条"不许再出现天数/cookie 名"的牙齿**）；
`check-ui-copy` 新增两条点名守卫 ——「一键重登必须在账号库按钮行里」与「cookie 摘要不许出现天数」，
两条都做过反向验证（把按钮挪回去 / 把天数加回来 ⇒ 立刻变红）。

## 0.6.14 — 2026-09-30

**邮箱密码自动重登：「重登」一键点下去就上，另加「一键重登全部」+ 到期前自动续（开关，默认关）。**

用户诉求（原话）：「我点击重登之后又是让我重新输入账号密码，就不能直接点个重登按钮就登录上去
不就行了？然后再加个一键重登的按钮」——因为凭证实测寿命只有 ≈2 小时（88 / 119 / 120 分钟），
于是一天要重登好几次，每次都手敲邮箱密码。

### 怎么做到免人工（这条是靠实测打通的）

1. 密码登录接口：**`POST /api/v0/users/login`**，body `{email, mobile, password, area_code, device_id, os:'web'}`，
   **不需要 token**，成功时 token 就在响应体的 `data.biz_data.user.token`。
   ⚠️ 它**不在 `/users/` 前缀下**（网页端是 `baseUrl + "/login"` 拼的）—— 按完整路径 grep 找不到。
2. Node 直接打会被风控挡：`{"biz_code":11,"biz_msg":"RISK_DEVICE_DETECTED"}`
   —— `device_id` 只由**数美设备指纹 SDK** 产出（页面里 `window.SMSdk.getDeviceId()`）。
3. 所以走**真实浏览器**：复用已有的 `browserLogin`（系统 Edge/Chrome + CDP + 独立 profile），
   新增 `credentials` 选项 —— 在**页面上下文**里发登录请求，指纹/WAF cookie/数美 SDK 全是真的。
   实测 `biz_code: 0` 登录成功。
4. 成功后脚本把 token 按网页端格式写回 `localStorage.userToken` ⇒ 原来那套
   「轮询 localStorage → 抓 cookie + 指纹头」**一行都不用改**。
5. **自动登录失败不会掐死手动路径**：退回"等用户手动登录"，原因写进 `autoLoginError`。

### 新增能力

- **「重登」一键**：`POST /login/relogin` 在"授权确实失效"那条路上，若能按账号的脱敏名匹配到
  邮箱密码凭证，就直接自动重登（不再只是弹一句提示让你手敲）。匹配不上才回退到原流程。
- **「一键重登全部」**：`POST /login/relogin-all`（面板按钮「用存的密码重登全部」）。
  串行执行、逐个回报 ✅/❌ —— 并行开 6 个浏览器只会让风控看着更像机器。
- **「到期前自动重登」开关**：存 `gate.json` 的 `autoRelogin`，**默认关闭**。
  打开后每 10 分钟检查一次（每轮重读设置文件 ⇒ 改了即时生效，不用重启），
  凭证失效或捕获超过 100 分钟就静默跑一次无头浏览器把凭证换新。
- 凭证库：`~/.dsh/web-login/credentials.json`。**单独文件、不写进账号记录** ⇒
  账号导出/导入不会把密码带出去；原子写；坏文件当"没有凭证"（不许因此崩面板）。
- 匹配规则：按**服务端的脱敏规则**本地重算比对（`davi*******+w4@gmail.com` 这种），
  对不上就返回"没有凭证"——**绝不模糊匹配**（否则会拿 +w5 的密码去登 +w6）。

### 关于"开浏览器"这件事（用户专门问过，写在这里免得再误解）

用的是系统里已装好的 Edge/Chrome，`--headless=new` **没有窗口**、`--user-data-dir=<临时目录>`
是**一次性干净 profile**（不碰用户平时的浏览器数据，跑完连目录一起删），跑完即杀。
代价：约每 2 小时一次（自动续开启时）或每次点击一次（手动），各几百毫秒到几秒。

用例：新增 `check-relogin` 13 项（脱敏匹配含真实样本 + 逐条反例 / 凭证读写去重 /
挑号判据三种 reason / 页面脚本的接口与特殊字符转义 / 三处接线守卫）。

## 0.6.13 — 2026-09-30

**账号列表加「邮箱 / 手机号」标志。**

用户要求："给每个账号后面加个（邮箱）（手机号）等这样的标志呗"（多号并存时列表里只有一串脱敏
标识，看不出这号是用什么注册的）。

判据 `identifierKindOf()`（纯函数，`accounts.ts`）：

1. 记录里带了显式 `email` / `mobile_number` 字段 ⇒ 直接用（最准）。
2. 老记录只有服务端给的脱敏 `display` ⇒ 按形态判：含 `@` = 邮箱；数字形态 = 手机号。
   ⚠️ 门槛不能按"至少 6 位数字"—— 脱敏串 `183******78` 去掉星号**只剩 5 位**数字，
   第一版就是这么判错的（被自己的用例抓出来）。最终判据：「带掩码星号且 ≥5 位数字」
   或「纯数字且 ≥7 位」。
3. 判不出来就是 `unknown`，界面**不显示**标志（不瞎猜）。

判据在**主机侧**算好（`/accounts` 的 `identifierKind`），客户端只负责画 —— 免得两边各写一套。
另加一枚中性色徽章样式（不占用红/黄/绿这些状态色）。

已知边界：服务端只给**一个** `display`（`pickUserDisplay` 优先邮箱），所以"邮箱和手机都绑了"的
账号会被标成邮箱 —— 手上没有足够信息区分时，如实只标能确定的那个。

用例：`check-accounts` +6 条（显式字段优先 / 邮箱形态 / 手机号形态 / 判不出就不猜 / 短数字不算手机号 /
标志文字）；`check-accounts-view` +1 条端到端（夹具就是真实的"脱敏手机号 + 邮箱"两种形态）。

## 0.6.12 — 2026-09-30

**按 DSH 会话（窗口）分槽：一个窗口一个网页端会话 + 一条链。**

用户要求「每个窗口各用自己那个网页端会话，而不是占用之前的窗口」。上一版我判断"做不到"是
**查错了地方** —— 我看的是宿主日志里的 `request/header` 事件（那里只有 config / adapterDefaults / tools），
而适配器实际收到的 `GenerateOptions` 里**有 `sessionId`**。宿主内核
（`@deepseek-ai/dsh-llm` 的 `types.d.ts`，npm 上公开）原文：

```ts
/** Session identity stamped by the loop for listener routing. Adapters ignore
 *  it; replay uses it to keep concurrent parent and child cursors independent. */
sessionId?: Branded<'SessionId'>;
```

改动：

1. `adapter.ts` 把 `options.sessionId` 透传成 `dshSessionId`。
2. `webapi.ts` 的复用槽与投喂链从**全局单槽**改成**按 `账号 + DSH 会话` 分槽的 Map**
   （`slotKeyFor`）：窗口 A 与窗口 B 各拿一个网页端会话、各挂一条链，**切回来还复用自己那条**。
3. 上限 `MAX_CONVERSATION_SLOTS = 6`：超过就淘汰**最久没用**的那条（连同它的网页端会话一起删），
   免得开过的窗口越多、服务端残留的会话越多。
4. 拿不到 `sessionId` 时（老宿主 / 手工构造的请求）退化成共用一个 `(unknown)` 槽，行为与以前一致。
5. 面板「立即清理」相应改成清**所有**窗口的会话（`clearLiveSession` 返回列表）；
   `GET /context-mode` 的 `chain` 多回一个 `slots`（当前养着几条会话）。

用例：`check-session-reuse` 新增两条（换窗口各用各的 / 切回复用自己那条 / 无身份时退化）；
原有"换账号"那条按新设计改了断言 —— **意图不变、时机变了**（槽不再被覆盖，于是改成
"退役时每个会话必须由它自己那个账号的回调回收"）。`check-bundle` 的链式接线守卫同步到新写法。

## 0.6.11 — 2026-09-30

**清理策略按投喂模式分开：链式模式不自动清理、改为手动；链式下也不再按轮数轮换会话。**

用户的原话：「全量模式跟链式模式的清理应该分开来算……全量模式下可以自动清理，但是链式模式
应该来个选项自己手动清理。不然以后链式还没结束，就已经清理了，当然在网页版上面不会有上下文。」

三条改动：

1. **链式模式下不按轮数轮换会话**（`effectiveReuseLimit`）。原来 `sessionReuseTurns` 默认 20 ——
   全量模式下轮换是对的（每轮都是根消息，会话只是"壳"），但**链式下会话就是链的载体**：
   轮换 = 每 20 轮定期把上下文清掉，模型那边真的会断。现在链式下上限取 ∞；
   用户显式设成 0（每次新会话）时不改写他。
2. **链式模式下清理只手动**（`SessionCleaner.setManualOnly`）。自动到点删队列这条路在链式下关闭，
   队列只攒着；全量模式保持原来的「延迟 / 立即 / 不删」三档。
   ⚠️ 只拦**自动**那一路：`flush()` 是显式动作，任何时候照样执行。
3. **面板新增「立即清理」**（`POST /cleanup`：`清掉当前网页端会话` + 立刻清空待删队列）。
   链式模式下没有自动清理，所以必须给一个"现在就把网页端弄干净"的动作；清完之后下一轮会
   重新当链首（全量发一次）。

另外：切换投喂模式时会**同步**清理策略（链式 ⇒ 手动；全量 ⇒ 自动），不用重启。

⚠️ 仍未解决（需要先确认能力）："每个 DSH 会话各用一个网页端会话"。DSH 目前没有把会话身份交给
适配器（请求头只有 `config / adapterDefaults / tools`；会话日志里 `sessionId` / `conversationId`
出现 0 次），所以现在只能做到"不污染、不造分支"，做不到"按窗口各用各的会话"。

## 0.6.10 — 2026-09-30

**修「换个窗口聊天就把上下文清一次」：重开链时不再往复用来的会话里塞根消息。**

现场（用户截图 + 网页端界面）：DeepSeek 网页端里，同一个用户消息气泡（内容就是我们那份
`# Tool Calling Protocol` 提示词）下面出现 **`5 / 5` 的版本翻页 + 「修改 / 重新生成」入口** ——
也就是插件在那条消息下反复造了兄弟分支；用户那边的观感是"换个窗口它就把上下文清了一遍，
还老是去调网页端的『修改』"。

根因（代码 + 实机状态双证）：

1. 网页端会话槽与投喂链都是**账号级单槽**（`reuseSlot` / `contextChain`），不区分 DSH 会话 ——
   这是既有设计，不是本次引入的。所以"换窗口"时，新窗口的请求会**落进上一个窗口的网页端会话**。
2. 落进去之后，链判据必然不满足（历史不是严格追加 / head 变了 / 会话轮换 / 同一步重试），
   于是走 `decideFeed` 的 `restart` 分支：**发全量 prompt + `parent_message_id: null`**。
   `null` 是「根消息」语义，而那个会话**已经有内容** ⇒ 网页端把这条根渲染成同一位置的
   又一个兄弟版本（`n / n`），分叉的对象恰好是我们那份巨大的提示词。实机当时是
   `entries=46`（该会话里已经挂着一段 46 条的链）而 `parentId=6` 的错位状态。

改法：**要发根消息 + 当前会话是复用来的 ⇒ 换一个干净会话**（旧会话交回给它自己的清理）。
判据抽成纯函数 `needsFreshSession(feed, reused, mode)`，有用例守，并守住"宿主真的调用了它"。

⚠️ 刻意**只在链式模式下生效**：全量模式里"每轮都是根消息"本来就是常态，若也一律换会话，
就变成**每轮多建 + 多删一个会话**（+2 个请求/轮）—— 请求密度本身就是风控关注点，
不能为只有链式模式才有的问题付这个代价（这一条也被用例钉住了）。

⚠️ 已知边界（本版**没**解决，需要先确认能力）：真正做到"每个 DSH 会话各用一个网页端会话"
需要 DSH 把会话身份交给适配器；目前查到的请求头里只有 `config / adapterDefaults / tools`，
没有会话 id。本版的效果是"不再污染别人的会话、不再造兄弟分支"，代价是切换窗口时该窗口会
新开一个网页端会话（旧的会被回收）。

## 0.6.9 — 2026-09-30

**补丁版：修好诊断工具（`tools/inspect-session.mjs`）在官方桌面端上的静默失效。**

不涉及运行时行为变化，装上它不会改变任何请求行为。

- 🔴 `tools/inspect-session.mjs` 原来只认 `session.jsonl.zstd`，而官方桌面端 0.2.x 已经
  把会话日志改成 **`session.v4.jsonl.zstd`** ⇒ 会话列表与 `--search` **全都无输出**，
  看起来像"日志被清了"。现在按 `/^session\.v\d+\.jsonl(\.zstd)?$/` 认，新旧版本都覆盖。
  （README 里推荐用这个工具排查"回复被截断 / 工具调用泄漏"这类问题，所以它坏掉会直接卡住排查。）
- 更正 `src/client/index.ts` 里一段**过期注释**：原文写"刻意只提供手动切换、不做自动轮换"，
  但「自动换号」滑块（默认关闭）早就存在，0.6.8 又加了"凭证失效即换"。注释与实现不一致
  会把排查引到错方向（README 里同款那句话今天刚修过）。

## 0.6.8 — 2026-09-30

**修「凭证被服务端作废之后不自动换号、只能手动切」+ 把 AUTH 做成条件式可重试。**

现场（用户截图 + 本机台账原文）：

```
15:49:43  acc_de90f63b  {ok:false, code:"AUTH", ms:7}   ← 7ms＝本地拦下，请求根本没发出去
15:49:45  同上（会话标题）  {ok:false, code:"AUTH", ms:5}
15:49:58  ← 用户手动切到 acc_ec650e63，之后 12 次全部成功
```

界面显示「本轮运行失败 · API 密钥无效」，任务停在那里 —— 用户的期待是**它自己换号接下去**。

两个根因：

1. `auth`（凭证作废）**不在** `retryableCodes` 里 ⇒ 重试器一次都不重试。而换号检查点是
   **请求前**检查点：没有下一次请求，就永远等不到它。所以"能换号"这件事在 AUTH 上从来没发生。
2. 「AUTH 一票制标记」被 0.2.0 改成"先只读复核探活、确认失效才标记"是对的（防端点级误判），
   但**标记写完之后的下一步没人接** —— 之前只有"限流/封禁"两条路会触发换号。

改法（让"能不能换号"成为 AUTH 唯一的开关）：

- `canFailover` 增加第三种 `kind`：`'auth'`。判据抽成纯函数
  `hasFailoverCandidate`（自动换号开着 + 没在切 + 账号库里还有**别的**可用号）；
  AUTH 刻意**不过**限流那条"窗口 + 冷却" —— 死号是永久性坏状态，等多久都不会自己好。
- 三个 AUTH 抛出点（HTTP 401/403、信封 40003/40001、"已知失效就不发请求"的拦截）
  都按它给退避：**能换号 ⇒ 5 秒**（留出复核探活那 0.9~3.5 秒）**重发一次，检查点换号接上**；
  **不能换号 ⇒ 600 秒**（> `maxDelayMs`）⇒ 重试器直接放弃。
  ⚠️ 这就是"条件式可重试"：AUTH 进 `retryableCodes` 是为了让那条 5 秒有路可走，
  **"不能换号就别重试"靠的是退避值**，不是码 —— 所以两档常量各自有用例守，只改一边必红。
- 默认没开自动换号的用户**行为完全不变**（走 600 秒那档，与加这个功能之前一致）。
- 「已知失效就不发请求」那条错误的文案跟着分流：能换号时说"正在自动换到另一个账号重试"，
  不能换号时才引导去「切换」/「重登」/「校验全部」。

⚠️ 另一个同源问题（不在本版代码里）：官方桌面端装在**新环境**时，旧环境的
`~/.dsh/web-login/gate.json` 不会跟着过来 ⇒ `autoSwitchMinutes` 落回默认 **0（关闭）**
⇒ 整条自动换号链不工作。若你也是从旧环境迁过来的，请检查
「设置 → DeepSeek 网页登录 → 防风控 → 自动换号」是不是被重置成关闭了。

用例 `tests/check-auth-failover.mjs`（14 项）：两档退避跨在 `maxDelayMs` 两侧 + 纯判据六种边界
+ 三个抛出点的接线守卫。反向验证：把 GIVEUP 退避改小、把宿主签名里的 `'auth'` 删掉，
两个变异体都变红。

## 0.6.7 — 2026-09-30

**修「点切换像没反应、报错在列表底部看不见」+「探活超时被当成登录态失效」。**

现场（用户截图）：点一个**正常**账号的「切换」，界面上像什么都没发生；过一会儿列表底部才冒出
一行红字 —— `切换失败：该账号登录态校验未通过（The operation was aborted due to timeout），
请重新登录后再切换`。用户的原话是"这样一点也不明显"。

两件事叠在一起：

- **失败分类又漏了一处**。0.6.6 给探活分了「授权类 / 网络类」，但**切换前那次探活没跟上**：
  不管哪一类失败都拦下来、都建议"重新登录"。而那次真因只是超时（网络抖了一下），凭证完全可用。
- **反馈位置不对**。切换的反馈只写卡片底部那一条消息，而用户的视线还停在他点的那颗按钮上；
  探活最长 20 秒，这段时间里按钮毫无变化 ⇒ 体感就是"点了没反应"。

改法：

1. **切换前探活按类型分流**（新纯函数 `switchGateFromProbe`，有专门用例守）：
   - 授权失效 ⇒ 拦下，说清「这个号的登录态已失效，需要重新登录一次才能切换」；
   - 网络类（超时/断网） ⇒ **放行**，只提示「已切换，但没能校验（网络问题）—— 登录态未必失效」；
   - 探活通过 ⇒ 直接切。
   与 `staleAuthRecord` 同一取舍：**网络问题不该冒充授权结论**。
   （判据本身还是纯函数，宿主真的会调用它 —— 用例里连这条也守着，防"判据写好了没人调用"。）
2. **交互路径的探活超时 20s → 10s**（`SWITCH_PROBE_TIMEOUT_MS`）。后台定时探活仍是 20s。
3. **反馈落在那一行**：新增行内提示条（`.dsw-rowmsg`），切换的结果直接写在账号行里；
   按钮自身进入「切换中…」禁用态。列表重建后按账号 id 把结果写回新行（顺序反了会被冲掉）。
4. **「重登」同样落到行内** —— 它是同一类"慢操作 + 只在底部说话"的问题。

## 0.6.6 — 2026-09-29

**修「网络一抖，整库账号被标成需要重新登录，点重登还得重敲密码」。**

起因是用户申诉：面板上一排账号全写着「校验失败：fetch failed」，点「重登」之后浏览器
打开的是**登录页**，得重新填手机号 + 验证码。查下来是两件事叠在一起：

- **探活失败的两种性质没分开**：`fetch failed`（本次真因在 cause 里：
  `net::ERR_NETWORK_IO_SUSPENDED`，机器休眠、网络挂起）与「token 失效」被写进**同一个字段**，
  而这个字段的语义是"这个号必须重新登录" —— 徽章、账号轮换、重登是否清登录态全都读它。
  一次休眠就把 9 个账号同时标红，凭证其实全是好的。
- **重登一进门就清登录态**：`!!lastVerifyError ⇒ 先清 profile + 登录分区`。
  清除之后浏览器里什么都没有，于是必然要重新登录一遍 —— 这就是"点了还要我输密码"。

改法：

1. **写入点就分类**。只有授权类失败（401 / 403 / invalid token / 过期）写 `lastVerifyError`；
   网络类（断网、超时、5xx、网络挂起）写新的 `lastCheckError`，且**不覆盖**已有的授权类结论
   （否则真死号会被网络抖动洗白）。成功时两个标记一起清。
2. **重登先做一次只读探活**，按结果分三条路（判据是纯函数 `planRelogin`）：
   - 探活通过 ⇒ 账号本来就是好的：清掉标记，**不打开浏览器、不清任何东西**，一键结束；
   - 网络类失败 ⇒ 只报网络问题，**不清登录态、不开窗口**（这时候重登必然白敲）；
   - 授权类失败 ⇒ 才清登录态 + 手动登录一次（原行为）。
3. **错误串保留原因链**：`fetch failed ← net::ERR_NETWORK_IO_SUSPENDED`。
   以前只留最外层一句 `fetch failed`，既看不出是休眠还是 DNS，也没法判断该等网络还是该重登。
4. **面板**：徽章只在授权失效时显示「❌ 需要重新登录」，网络类显示中性的
   「⚠️ 未能校验（网络）」；「校验全部」的汇总分开报"登录态已失效"与"网络没通、未能校验"。
5. **老数据自愈**：读账号时把历史上写错位置的网络类失败自动迁到 `lastCheckError`，
   老库不必等下一次探活，也不会再被它误导。

用例：`check-relogin-integrity`（三条分支 + 不清登录态 + cause 保留）、
`check-account-add`（两个标记一起清、`carried` 白名单不漏新字段）、
`check-accounts`（读路径迁移）、`check-bundle`（产物里 `planRelogin` 三态**真求值** +
`describeError` 真的沿 cause 链）。反向验证 5/5 + 产物层 3/3 如期红。

## 0.6.5 — 2026-09-27

> 修复 0.6.3 的重试策略**形状**错误：它会让「按本地退避重试」算出 `NaN`，把整轮打成 UNKNOWN 错误。

### 修复

- **`providerRetryPolicy` 的返回值改成扁平字段**（0.6.3 包了一层 `backoff`）。dsh-llm 的取法是
  `adapter.providerRetryPolicy(p) ?? resolveRetryPolicy(…)` —— 我们一返回对象，右侧那个"会把 `backoff`
  展开成扁平字段"的规范化就**不会执行**，而运行期的消费方读的正是扁平字段
  （`policy.initialDelayMs / maxDelayMs / jitterRatio`）。实测 DSH 会话日志里 `llm/retry` 事件的

  ```
  "policyKey":"[\"normal\",5,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",…],null,null,null]"
  ```

  后三项是 `null` = `undefined` —— 两个后果，第二个是致命的：

  1. `providerRetryAfterMs > maxDelayMs` 变成 `X > undefined` = **恒 false** ⇒「要等太久就放弃」失效
     （连封禁一天的解除时间也会被照单等下去）；
  2. 失败**不带** provider 延迟时（例如 `EMPTY_RESPONSE`）走本地退避 `initialDelayMs * 2**n`，
     `undefined` ⇒ **`NaN`** ⇒ DSH 写会话事件时拒收非有限数 ⇒ 整轮以
     `UNKNOWN: session event "llm/retry" carries non-JSON-serializable data` 结束。

     实测 2026-09-27 17:33:51：一轮里第一次重试（限流，带 2s）正常成功；第二次重试
     （`EMPTY_RESPONSE`，无 provider 延迟）触发该错误 ⇒ 现象就是"任务突然自己停了"。

### 测试

- `check-llm-retry.mjs` 补四条**意图级**断言：策略扁平键齐全且**无 `backoff` 嵌套**、
  **回放 DSH 的 `retryPolicyKey` 不许出现 `null`**、**回放 `localDelay` 必须算出有限正数**、
  超长解除时间仍须被判「等太久」而放弃。
- 反向验证 3 步全部如期红：改回嵌套 → 6 条红；`maxDelayMs` 调小到 10s → 2 条；抽掉 `initialDelayMs` → 4 条。

## 0.6.4 — 2026-09-27

> 文档版本：把「封号归因」那一节带到 npm 包页面上（纯文档，**无代码改动**）。

### 文档

- README（中/英）新增 **「关于『装了这个插件之后封号了』」**，放在「免责声明」之前：
  把上下文里各部分的量级摆出来，再给自查顺序。

  | 来源 | 量级 | 由谁决定 |
  |---|---|---|
  | 本插件协议指令 | **3,045 字符 ≈ 950 token** | 本插件（多个版本未变） |
  | 工具目录 | 0.6.2 起长尾压成一行，同口径 **-50%** | 你装了多少工具插件 |
  | `~/.dsh/prompt-inject.md` + `AGENTS.md` | **49,185 字节 ≈ 1.2 万 token（协议的 16 倍）** | 你的全局注入 |

  另附维护者实测：连续 5 天无封禁；单日 178 次请求中 6 次限流、全部在退避后自动恢复。

### 说明

- 仅为让 npm 包页面的 README 与仓库同步；代码与产物逻辑与 0.6.3 一致。

## 0.6.3 — 2026-09-27

> 限流之后**任务自己接下去**，不用再手点「继续」。

### 修复

- **限流不再让整轮直接结束**：适配器现在**显式声明重试策略**
  （`providerRetryPolicy`，上限 `maxDelayMs` 与我们的最大限流退避对齐）。
  此前返回 `undefined` ⇒ 落到 dsh-llm 的默认上限 **10 秒**，而我们的限流退避是 **40~117 秒**
  ⇒ 策略判定"提供方要的等太久"**直接放弃重试**，`turn/end` 变成 error、界面显示
  「本轮运行失败」，必须用户手点「继续」。现场证据（会话日志原文）：
  `failure:{code:"RATE_LIMIT", providerRetryAfterMs:49208}`。
- 🔴 **SSE 路径现在也会问「还能不能换号」**：此前只有 HTTP 路径走 `canFailover`，
  而**节流最常见的形态正是 SSE**（`event: error` / `event: toast`）⇒ "能换号就给 2s 短退避、
  让重试立刻发生并由检查点换号"这套逻辑在真实场景里从未生效过。
- `canFailover` 提成**单一来源**（`makeCanFailover`）：HTTP 与 SSE 两条路径必须同答，
  否则会出现"有时自己接下去、有时必须手点"。

### 修正

- `throttleBackoffMs` 的注释与代码不一致：多处写"20s 起"，而实现是**先推档再计算**
  ⇒ 实际首档 **40s**。按实测值（49208ms = 40000 + 23% 抖动）校正注释，**不动行为**。

### 说明

- 重试是**有界**的（normal 模式、最多 5 次），避免账号真被封时无限打请求；
  想要"绝不放弃"可把 `RETRY_POLICY.maxRetries` 调大或改 `mode: 'always'`（默认不开）。
- 封禁（`user is muted`）不受影响：解除时间远大于上限时仍按"放弃重试 + 显示解除时间"处理；
  但**短封禁**（< 上限）现在也能自己等过去。

## 0.6.2 — 2026-09-27

> 长尾工具压成**一行**：`` `签名` — 首句 ``。目录再瘦一圈，能力依然一个不少。

### 改进

- **长尾工具改成一行格式**，并拆出独立的 `## Other tools` 小节：

  ```
  ## Available tools
  ### pwsh
  <完整描述>
  pwsh(command: string, description: string)
    command: …
    description: …

  ## Other tools

  Call these the same way. Parameter names and types are in the parentheses.

  - `job_list(limit?: number)` — 列出后台任务
  - `web_search(queries: string[])` — 联网搜索
  ```

  这是抄 cuckoo 的（它的 `getFormattedJsApiForPrompt` 对每个工具就是 `` 1. `read(path)` — 读取文件 ``）：
  **名字 / 签名 / 一句话三样都在，但只占一行** —— 长尾工具的价值就是"让模型知道它存在、怎么传参"。
- 那句话取**首句**（到第一个句末点）而不是开头若干字，上限 160 字符：描述的第一句才是"这工具干什么"。

### 实测收益（13 个真实 DSH 工具定义）

| 版本 | 目录长度 | 累计省 |
|---|---|---|
| 0.5.3（JSON + 完整描述） | 18,217 | — |
| 0.6.0（签名 + 完整描述） | 14,815 | 19% |
| 0.6.1（分级：长尾 240 字） | 11,000+ | 42% |
| **0.6.2（长尾一行）** | **9,024** | **50%** |

按 61 个工具（50,942 字符）外推，约 **省 2.5 万字符 ≈ 6,000 token / 每轮上下文**，
**零额外请求**、**工具一个不少**。

### 说明

- ⚠️ **这是 head 的变化**：重启 DSH 后**第一个任务会全量重发一次**，之后照常。
- 🔴 **渲染顺序变了**：以前是"按 DSH 下发的原序"，现在是**分组**（核心在前、长尾在后），
  各组**内部**仍保持原序。所以目录里工具的排列与之前不同。
- 长尾工具丢的是「遇错怎么办」那类长指引；核心工具（真正常用的）一个字没动。
- 调整名单：改 `src/protocol.ts` 的 `CORE_TOOLS` 集合 —— 那是唯一的开关。

## 0.6.1 — 2026-09-27

> 工具目录按「用不用得上」分级：常用的给完整说明，长尾的只留一句话。**能力一个不少。**

### 改进

- **工具描述分两级下发**。0.6.0 把参数从 JSON 换成签名之后，目录里最大的一块变成了
  **工具级描述**（13 个真实工具实测：描述 10,369 字符 vs 参数段 7,588）。现在：
  - **核心工具** —— `pwsh` / `bash` / `run_code` / `read` / `write` / `edit` / `grep` / `glob` /
    `ls` / `todo_write` / `skill` / `present` / `ask_user_question`：描述按 3200 字符完整保留，参数说明也在；
  - **长尾工具** —— 描述压到 240 字符，且**不输出参数说明**。
- ⚠️ **两级都保留工具名与参数签名** ⇒ 模型照样能调用长尾工具，只是看不到长篇说明。
  **这不是「禁用工具」**，不会出现「要用的工具看不见」。

### 为什么这么分（实测依据）

扫最近 8 个会话的 **826 次真实工具调用**：

| 工具 | 次数 | 占比 |
|---|---|---|
| pwsh | 230 | 27.8% |
| run_code | 206 | 24.9% |
| edit | 140 | 16.9% |
| read | 80 | 9.7% |
| write | 66 | 8.0% |
| bash | 46 | 5.6% |
| 其余（grep/glob/present/skill/todo_write…） | 58 | 7.1% |

**覆盖 90% 的调用只需要 6 个工具**，而 DSH 每轮下发 **61 个**。剩下的那些
（jobs / goal / ralph / workflow / web / subagent 系列…）在这 8 个会话里**一次都没被调用过**，
却每个都在每一轮的上下文里占几百字符。

### 实测收益（13 个真实 DSH 工具定义）

| 版本 | 目录长度 | 累计省 |
|---|---|---|
| 0.5.3（JSON + 完整描述） | 18,217 | — |
| 0.6.0（签名 + 完整描述） | 14,815 | 19% |
| **0.6.1（分级）** | **10,544** | **42%** |

按 61 个工具（50,942 字符）外推，约 **省 2.1 万字符 ≈ 5,000 token / 每轮上下文**，
而且**零额外请求**。

### 说明

- ⚠️ **这是 head 的变化**：重启 DSH 后**第一个任务会全量重发一次**，之后照常。
- 长尾工具丢的是「遇错怎么办」那类长指引；**真正常用的工具一个字没动**。
- 想调整名单：改 `src/protocol.ts` 里的 `CORE_TOOLS` 集合 —— 那是唯一的开关。
  哪天真觉得某个工具"看不懂了"，把它加进去重新构建即可。

## 0.6.0 — 2026-09-27

> 工具目录改用**紧凑类型签名**下发，不再给模型贴原始 JSON。

### 改进

- **每个工具的参数不再原样贴 JSON**。原先那行是
  `Parameters (JSON Schema): {"type":"object","properties":{…}}`，现在渲染成类型签名：

  ```
  ### read_file
  Read a file.
  read_file(file_path: string, offset?: number, limit?: number)
    file_path: Path to read, resolved by the filesystem backend.
    offset: 1-based first line to return. Defaults to 1.
  ```

  模型要写出 `arguments`，真正需要的只是**参数名、类型、必填性**；那串 JSON 里
  `"type":"…"`、键名的引号、每个参数各套一层对象，全是结构性样板。
- **两种参数形态都认**。DSH 自家工具是**扁平**写法（顶层键直接是参数名、`required: true`
  挂在参数自己身上），而 `@deepseek-ai/dsh-tools` 的 `schemaOf()` 把它**原样透传**、不做规范化；
  标准 JSON Schema 包裹形态（`{type:'object',properties:{…}}`）一并支持。
- 嵌套对象/数组/枚举/`anyOf` 都能渲染：`{content: string, status: string}[]`、
  `"view" | "create" | "str_replace" | "insert"`。

### 实测（2026-09-27，取自 13 个真实 DSH 工具定义）

- 参数段 **7,588 → 4,186 字符（省 45%）**，`required` 与参数描述全部保留、零回退。
- 折算到**整个工具目录约省 18%** —— 目录里更大的一块是工具级描述（同批样本 10,369 字符），
  那块**没动**：它藏的是"遇错怎么办"的指引，不许砍。
- 按 61 个工具 / 50,942 字符的目录估，约 **省 9,500 字符 ≈ 2,400 token**，占单轮输入 **3%** 左右。
  ⇒ 别指望它解决"提示词太长"：真正的大头是消息历史与环境注入，不在工具目录。

### 说明 / 风险

- ⚠️ **这是 head 的变化**：升级后**第一个任务会全量重发一次**（投喂链断），之后照常。
- ⚠️ 模型看到的参数形态变了（JSON → 类型签名）。签名是模型最熟的形态，预期更好读；
  但**首次实测若发现参数写错，请立刻反馈** —— 回退只改一处：`buildToolSection` 里不用
  `buildToolSignature` 即退回原始 JSON（回退分支与"认不出就不许发空参数"由
  `tests/check-tool-signature.mjs` 守着）。
- 参数描述超过 160 字符会被截断；**工具级描述仍是 3200 上限，不受影响**。

## 0.5.3 — 2026-09-27

> 修掉一个"重启后前 3 分钟里限流不换号"的窗口 —— 0.5.2 的漏洞。

### 修复

- **限流换号的冷却用错了基准**：0.5.2 里冷却要求「距上次换号 ≥ 3 分钟」，而"上次换号"
  实际上取的是**插件启动时刻**（它同时还要给"按时间轮换"当计时起点）。两件事的语义不同 ——
  一个是"从启动算起过了多久"，一个是"上次真的换过号是什么时候" —— 在"启动后还没换过号"
  这段区间里，它们给出**相反**的答案。
  后果：**每次重启之后的 3 分钟内撞上限流，都不会换号**。而那恰好是最容易撞上的窗口
  （重启往往就是为了接着跑任务）。
  现在冷却改用独立的"上次真的换过号"时刻（只在换号成功与手动切号时推进）：
  **本次启动还没换过号 ⇒ 不套冷却**，限流立刻可换。

### 说明

- 只影响"限流换号"这条路径的时间判定；按时间轮换、封禁换号、退避分流都不变。
- ⚠️ **升级后需要重启 DSH 才生效**（`link:` 安装方式不热重载）。

## 0.5.2 — 2026-09-27

> 限流时也能自动换号接下去，不用再手动重发。

### 改进

- **限流也能自动换号接下去**：以前限流是「20 秒退避 + **同一个账号**重试」——
  多半还是失败，整轮停下要你手动重发；而封禁早就有「短退避 + 换号」的救急路径，两者不对称。
  现在限流同样走这条路：**能换号 ⇒ 2 秒**退避，重发时自动换上别的账号继续跑。
- 面板的「上次自动换号」会说明**原因**（`，原账号刚被限流` / `，原账号不可用`）——
  按时间轮换与"原账号出问题提前换走"在观感上都是"任务突然变慢"，后者还解释了为什么没等满间隔。

### 说明

- 换号有两条约束，缺一不可：**窗口 3 分钟**（限流发生在 3 分钟以外就不再为它换号 ——
  那时多半早恢复了，不值得付全量重发的代价）与**冷却 3 分钟**（距上次换号不足 3 分钟不换）。
  冷却防的是最坏情况：万一多个账号接力被限流，没有它就会在几分钟内把账号库轮一遍。
- 换号时会**跳过同样刚被限流的账号**（切过去只会白搭一轮全量重发）。
- 限流时刻只记在**内存**里、不写进账号记录 —— 写进去会让界面把"刚才发太快了"
  显示成"账号受限"，而且那记录会一直留着。
- **没开自动换号的用户行为完全不变**（依旧 20 秒退避）。

## 0.5.1 — 2026-09-27

> 面板能看见「上次自动换号」了；另修两处与现状矛盾的说明。

### 新增

- **「上次自动换号」显示**：自动换号之后，「防风控」页的自动换号说明里会多出一句
  `上次自动换号：09:12（工作号 → xxx@gmail.com）`。
  换号那一轮会全量重发（体感是任务突然变慢），有了这行就能对上原因。
  - 只记**自动**换号；手动切号不记（那是你自己的操作，不需要提示）。
  - 只记录在内存里：重启后从"还没有记录"开始 —— 换号是运行时行为，留一份过期时间反而误导。
  - 账号两端按账号库里的展示名显示（备注名优先，其次掩码账号，不泄露完整凭证信息）。

### 修复

- 纠正两处**与现状矛盾**的说明：关于页那张卡片的标题原为「为什么没有「自动换号」」，
  `src/accounts.ts` 的模块注释也写着"刻意不做自动轮换" —— 而「自动换号」从 0.4.0 起就有了。
  两处都改成"默认关闭"的表述，原有论据（机器行为特征 / 多号关联风险）全部保留。

## 0.5.0 — 2026-09-27

> 新增「允许并行调用工具」开关，并把默认改成**一次只发一个工具调用**。

### 新增

- **「允许并行调用工具」开关**（「防风控」页 → 请求节流）：关掉后模型一轮只发一个工具调用、
  等结果回来再决定下一步；打开则允许一轮最多 3 个，由 DSH 并行执行。
  - 它改变的是**模型看到的协议指令** —— 属于「引导」而不是「强制」，不拦截也不改写模型发出的调用。
  - ⚠️ 切换后**第一轮会全量重发一次**（协议文本变了，投喂链要重建），之后恢复正常。

### 变更（**破坏性语义变化**）

- 🔴 **默认改为「一次只发一个工具调用」**（即开关默认不勾）。0.4.2 及以前默认允许批量。
  - 升级后**第一个任务的协议文本即变化** ⇒ 投喂链断一次（下一轮全量重发 + 新建网页端会话）。
  - 之后每个任务**总耗时变长**：每个工具各占一轮请求（3 个工具约从 2 轮变 4 轮）。
  - 想保留旧行为：设置页把「允许并行调用工具」勾上即可（= 显式 `serialToolCalls: false`）。

### 说明

- 工具在 DSH 侧执行（读文件、跑命令），**不产生任何 DeepSeek 请求** ⇒ 对网页端不可见。
  别和「允许并发生成」混淆：后者是**同时对 DeepSeek 发两条请求**（实测会触发账号级限制），
  前者只影响模型一轮里发几个工具调用。
- **请求密度本身基本不变**：闸门间隔按「上一次结束」时刻计算，而工具执行发生在其后
  ⇒ 工具耗时本就盖住了那段间隔。实测 827 个相邻请求间隔里 **99% 都 > 4s**（中位 18.3s）。
  真正变化的是**总请求数**与**总耗时**。

## 0.4.2 — 2026-09-26

> 新增「Token 统计」页：本地的用量趋势与分布。以前 token 数只在上报途中被算一次就丢了。

### 新增

- **「Token 统计」页**（标签栏在「模型」之后）：把每次调用的 token 用量落到本地
  （`<数据目录>/web-login/usage/`，按天分文件、保留 90 天），并在设置页看趋势与分布。
  - **范围切换**：今天 / 近 7 天 / 近 30 天 / 总计
  - **四格总览**：总 Token / 输入 Token / 输出 Token / 调用次数（副行给出服务端口径占比与成功失败数）
  - **按天用量**：堆叠柱（输入 + 输出）+ 虚线（当天调用次数，右轴），鼠标停在柱上可看具体数字
  - **用量分布**：按账号 / 按模型切换，横条排行带占比与次数

### 说明

- **口径**：网页端只在**部分**响应里上报总量，其余是按字符估算的 ⇒ 界面显示「服务端口径 N/M 次」，
  不把估算值说成精确值。`server` 标记只认服务端真的给了总量那一次。
- **与「防风控」页的调用台账是两份存储**：台账保留 7 天、管请求密度与失败分类；
  用量保留 90 天、只看用量。保留期差一个数量级，合并会让两边互相迁就。
- **懒加载**：切到这一页才读盘，不为没打开它的用户扫描历史文件。
- ⚠️ **历史数据是空的**：这个存储从本版才开始记，所以趋势图从升级当天开始长。

## 0.4.1 — 2026-09-26

> 被限流/封禁时能自己接下去。0.4.0 的自动换号，从这个版本起才是真正的兜底。

### 改进

- **封禁后不再需要手动点「继续」**：账号被封（`user is muted`）时，此前把**解除时间**（可能几小时）
  当作重试间隔交给重试策略 ⇒ 它直接放弃重试 ⇒ 整轮停住、等人手动点「继续」。
  现在只要**还能换号**（自动换号开着、且账号库里还有可用账号），就给 2 秒的短退避 ——
  重试立刻发生，重发时自动换到可用账号，**整轮任务自己接下去**。
  - 没有别的账号可用时仍保持原行为（长退避 ⇒ 放弃重试），不做无用空转
  - 候选账号换完即止 ⇒ **不会无限换号重试**
  - ⚠️ 只在自动换号**开着**时生效（滑块默认 0 = 关闭 ⇒ 行为与 0.4.0 完全一致）

### 说明

- 限流（`操作过于频繁` / HTTP 429 / 业务码 40029）本来就是自动退避重发、不需要手动干预 —— 这次没动它。

## 0.4.0 — 2026-09-26

> 两件事：一个「自动换号」滑块，以及一条会把限流误判成"不可重试"的修复。

### 新增

- **「自动换号」滑块**（设置页 → 请求节流，紧邻「上下文」）：**0~120 分钟，0 = 关闭**（默认关闭）。
  每满 N 分钟，换到账号库里的下一个可用账号。
  它的语义是**按时间均衡轮换** —— 让每个账号分到的请求都变少，把单账号密度摊薄。
  ⚠️ 这跟"一被限流就换号"方向相反：后者会让同一个出口 IP 上多个账号交替活跃，更像有组织的规避。
  所以判据**只看时间**：失效或正在受限的账号会被跳过，但不会因为它们受限就提前切。
  - 换号发生在**两个请求之间**（不会打断正在进行的生成）
  - 切之前先探活（切到一个失效账号 = 白费一轮全量重发）；探活失败的号本轮不再试
  - 当前账号自己失效/受限时**立刻**切走，不必等满间隔
  - 可用账号不足两个就不切；**手动切号后计时重置**
  - ⚠️ 代价：换号会让投喂链断掉 —— 下一轮要全量重发、历史图重新上传。**间隔越短越频繁**。

### 修复

- **信封形式的限流不再被误判为"不可重试"**：「操作过于频繁」除了 HTTP 429 与 SSE 错误事件，
  还可能以 **HTTP 200 + 业务码 40029** 的信封形式返回。此前只认前两条路，走信封的这一路会落到
  `PROVIDER_ERROR`（不可重试）—— **恰好在最该退避的时候让整轮直接失败**。
  现在把「码 40029」与「文案族」合并成同一个判据，统一按限流退避重试。
  （线索来自同类项目 cuckoo-code 0.6.1 的实测记录：它为此加了 60 秒退避重试。）

### 工程

- 新增 `src/auto-switch.ts`（纯逻辑，可单测：`isUsable` / `isSwitchDue` / `pickNextAccount` /
  `decideAutoSwitch`）与 `tests/check-auto-switch.mjs`（17 项：纯逻辑边界 + 真 POST 路由再读回 `gate.json`）。

## 0.3.1 — 2026-09-26

> 报错文案瘦身。功能没变，但限流与封禁的提示不再长篇解释。

### 改进

- **封禁提示只说到几时结束**：改为「DeepSeek 网页端已封禁本账号，X 解除（约 N 分钟）」。
  原来那段 150 字的解释（登录态其实有效、建会话也正常、建议改用 API key、
  刚跑过大量工具步骤的会话尤其容易被限……）全部移到代码注释 —— 用户看报错时只需要
  「是什么 + 到几时结束」，解释会把这两件事淹没。
- **限流统一叫「网页版限流」**：账号节流（`发得太频繁`）与「同一账号同时只能生成一条消息」
  两种情况共用这个前缀，后缀只保留成因 + 会自动重试。HTTP 限流的提示同样是这三个字。
- 设置页上的账号级限制提示同步收紧（去掉「只读调用不受影响」等补充）。

### 说明

- 结构化字段一个没动：`RATE_LIMIT` 分类、`providerRetryAfterMs`（解除时间很远时让重试策略
  放弃空转）、`rateLimitKind` 均照旧 —— 只有文案层变短，重试行为与账号级限制记录不受影响。

### 工程

- `check-session-lifecycle` 的封禁文案断言原本绑死旧措辞（`/临时限制|muted/i`），
  改为断意图（含「封禁/限制」+ 含「解除」），并新增**长度上限 80 字**阀门防止回退。

## 0.3.0 — 2026-09-26

> 上下文范围可调。原来硬编码 1M，现在能按需调小。

### 新增

- **「上下文范围」滑块**（设置页 → 请求节流，紧邻「图片上限」）。档位：32K / 64K / 128K / 256K / 512K / 1M。
  它声明的是**模型能装多少**（`contextWindow`）—— DSH 据此决定何时压缩或截断历史。
  声明 1M 时，DSH 长期认为"还装得下"而迟迟不压，于是每轮都把整段转写重发；
  对只跑短任务的人，这部分体量是白烧的。调小后 DSH 会更早动手。
  ⚠️ 它与「prompt 上限」是**两道独立阀门**：前者管"插件一次发多少字符"，后者管"DSH 认为能装多少"。
  两个都调小，请求体量才真的降下来。
  改动**即时生效**，不需要重启 DSH。

### 说明

- 默认值仍是 1Mi（DeepSeek 网页端标称值）—— 不动这个开关的人，行为与之前完全一致。

## 0.2.2 — 2026-09-24

> 面板视觉重构。功能没变，但设置页整个翻新了一遍。

### 改进

- **去掉"卡片盒子"**：原来七个区块都是同一种描边圆角卡片，连堆在一起时盒子本身不表达任何层级，
  只贡献视觉噪音 —— 现在改用「分区标题 + 负空间」分组，行分隔交给键值表自带的细线。
  副产品：页面上唯一有实底的块只剩账号库，重要度自然凸显。
- **统一尺度**：字号从 5 档收敛、圆角从 6 档收敛到 3 档、间距改用统一的 5 档变量（`--r-*` / `--sp-*`）。
  页面标题原来和正文只差 1px（14 vs 13），整页没有"起点"，现在标题提到 15px/600 并加了轻负字距。
- **补齐交互状态**：按钮 hover 从"整体调透明度"（看着像被禁用）改成背景色变化 + 按下 1px 位移；
  账号行补 hover 与「当前账号」主色淡底；全站补 `:focus-visible`（键盘可达）与 `prefers-reduced-motion` 保护。
- **开关打开态改用主色**：原来是红色 —— 一排红色开关看着像在报错。红色留给真正破坏性的动作。
- **徽章与警示底色不再写死 rgba**：改用 `color-mix` 从语义色现算，深浅两套主题都不会发脏。
- 说明文字限宽 64ch，长行不再拖满整张卡。

### 工程

- 新增 `tools/panel-preview.mjs`：从源码**现读**样式表 + 静态 DOM 快照，生成浅色/深色双栏预览 ——
  改面板 UI 时不必启动 DSH 就能对照，且样式不会与源码漂移。

## 0.2.1 — 2026-09-24

> 工程版本，无功能改动。用途是把包发到 npm、并把发布流程从「本机手动」换成
> 「打 tag 全自动」，为随后的版本腾出干净的发布链路。

### 工程

- **发布到 npm**：`dsh-deepseek-web-login` 已可在 registry.npmjs.org 上获取
  （`npm install dsh-deepseek-web-login`）。插件市场（`awesome-dsh-plugin`）对 npm 的探测
  会在次日自动生效并切到 npm 安装路径 —— 此前只能走 `github:` 前缀，而 git 路径失败时
  市场无法表达「更新前精确提交」，回滚不可用。
- **打 tag 即全自动发布**：`release.yml` 改用 **Trusted Publishing (OIDC)** —— 仓库里不存
  任何长期 token，也不再需要每次手动输一次性验证码；每个 tag 由 GitHub Actions 直接发布，
  并自动附带 provenance 来源证明。
- **发布流程幂等**：npm 上已有该版本则跳过发布、GitHub Release 已存在则覆盖上传 tgz，
  所以重跑（含 `workflow_dispatch`）是安全的。0.2.0 曾出现「GitHub 有 Release、npm 没有」
  的错位，本版把两件事合并进同一个 job 并固定顺序解决。
- **新增 tag 与 `package.json` 版本一致性校验**：不一致直接让 workflow 失败 —— 否则会发出
  一个「npm 上叫 A、git 里标 B」且 npm 不允许覆盖的包。

## 0.2.0 — 2026-09-24

> 定位（见 `0.2.0-规划.md`）：账号健康与可用性 —— 让多账号「看得见（限流/用量）、信得过
> （AUTH 不再一票制锁死）、切得动」。0.2.0-a 修复批已作为 0.1.84 先行发布。

### 新功能

- **F1 限流状态进探活与面板**：`users/current` 的响应体本来就带 `chat.is_muted / mute_until`
  （probe.ts 注释 2026-09-12 实测有效，只是从没接过）。探活现在顺手解析并写回账号记录的
  `limit` 字段 —— 「被限到 X 点解除」**提前**出现在账号徽章上，不用等生成请求撞 muted 才知道；
  `is_muted=false` 时**清掉**旧标记（提前看见解除）；响应里没有 chat 字段时不动（没探到 ≠ 没受限）。
- **F2 AUTH 失效先复核再标记**：0.1.80 起「已知失效的账号请求前拦截」的标记是**一票制** ——
  一次端点级误判就把健康账号锁死（实测 2026-09-22：94ms 被拒、同 token 2 秒前刚成功）。
  现在收到 AUTH 先用**同一份凭证**做只读探活复核：复核也失败才标记（确认失效）；
  复核通过不标记（本轮仍按失败计、用户重发即可，日志留痕）+ 顺手清掉更早的失败标记（解锁）；
  复核自身网络失败不标记（误标锁死 ≫ 漏标白跑）。
- **F3 按账号用量面板**：台账卡片新增「按账号」行（近 24h 各账号调用次数/失败数，
  按调用量排序、显示备注名）。数据本来就在台账里，此前只用于 gap 计算，没返回。

### 修复

- **R6** busy 判据剔除英文裸短语 `try again later`：它是**限流**文案的常见尾巴，
  留着会把限流误判成「并发生成」、退避从 20s 渐长退化成 5s 固定。实测过的 busy 文案
  （"A message is being generated, please try again later."）含 being generated，剔除安全。
- **R9a** `pickJsonFile` 加 10 分钟兜底超时：没有 cancel 事件的旧环境里用户关掉选择框后
  promise 永远挂着。
- **R9b** `make-dev-copy.mjs` 改为先校验全部构建产物再删旧目录（旧写法先删后校，
  产物缺失时旧副本已经被删才报错，想回退也没得回退）。
- **图片引用按内容 key 记账**：`sentRefIds` 从按 fileId 改成按内容寻址的 attachmentId
  （adapter 新增与 `refFileIds` 平行的 `refKeys` 入参）。uploadCache 因 TTL/条数封顶驱逐后
  重传会拿到**新 fileId**，按 id 记账会把同一张图记成「两张」，重新打开每轮重发的口子。

### 未做（及理由）

- **R2**（updateAccount 并发守卫）：回读确认 `writeJsonAtomic` 全链同步
  （writeFileSync + renameSync），Node 单线程下 read-modify-write 天然原子 —— **判据不成立**，
  复核代理的「成立」结论被推翻。
- **R5**（throttleStreak 全局不按账号分桶）：`noteThrottled` 调用点在纯字节流的 SSE 解析层，
  拿不到认证上下文；要分桶得给解析函数穿透 auth，改动面与收益（退避时长估错，方向保守）不成比例。

### 工程

- `LedgerSummary` 补齐 `byAccount` 字段（tsc --noEmit 进 CI 后类型面收紧，新增返回字段必须进接口）。

### 验证

- 新增 `tests/check-auth-recheck.mjs` 6 条行为用例（F1 ×4 + F2 ×2，apply 级驱动真实 adapter）。
- `check-bundle` 产物断言 +6（F1 解析/写回、F2 复核顺序与出口、R6 双向、refKeys 接线、F3 客户端渲染），
  4 条老断言按意图重写（0.1.61/0.1.83 的形态被新实现打破）。
- 反向验证 **6/6 精确命中**（含一条先假绿后修真的：F2a 原等待信号被 F1 残留数据污染，
  改坏也不红 —— 换成「宿主日志信号」后有了牙齿，并顺带给复核成功分支补了清旧标记的产品行为）。
- 全量离线回归 **50/50**；`tsc --noEmit` 0 错误。

## 0.1.84 — 2026-09-24

**0.2.0-a 修复批**（依据 `BUG-审查-2026-09-23.md` 第六节 R2~R9 逐行复核结论）+ 全库首次接入类型检查。

修复
- **R3 闸门看门狗（中高）**：宿主丢弃 generator（不再驱动也不 return）时许可永不释放，
  tail 永久卡死、此后所有请求排队不响应，只能重启 DSH。现在许可持有超 15 分钟（可配），
  下一次 acquire 会强制回收 + 告警日志。检查点放在 acquire 进入时（无需定时器）；
  **只在串行模式生效** —— 并发模式同时活着的许可可能不止一个，全局跟踪会误杀。
- **R7 Windows「先清登录态」静默失效**：浏览器进程还占着 profile 目录时 rmSync 必 EBUSY，
  旧实现吞掉后又被 `partitionCleared || browserProfileCleared` 掩盖成"已清"。
  现在：清 profile 失败先杀残留浏览器进程重试；logout 的判定从 `||` 改为分区维度按环境能力考核
  （桌面外环境没有分区可清，不该拖后腿），profile 没清就如实说"相当于没退出"。
- **R7 登录主循环**：只看 `signal.aborted` 不看子进程退出码 —— 用户关掉浏览器后空转到超时。
  现在看 `child.exitCode` 提前退出并提示。
- **relogin 分支添加模式泄漏**：`endAddAccount()` 在落库之后，落库抛错会泄漏到下一次无关捕获。
  挪进 finally（F08 同款保护，relogin 分支此前漏了）。
- **R8 手动粘贴 token fail-open**：粘贴 localStorage 包装 JSON（value 为 null / 坏 JSON）时，
  旧写法把整段 JSON 当 token 落盘。现在解出空 ⇒ 明确拒绝并提示怎么改；裸 token 行为不变。

工程
- **CI 接入 `tsc --noEmit`**：tsdown 只转译不查类型（0.1.82 的 P0-1 就是这么漏的）。
  全库 2026-09-24 首次清零（71 个存量错误：59 个 `.ts` 导入扩展名由 tsconfig 开关统一解决，
  12 个真错误逐个修：writeIndex 参数、浏览器 reason 联合类型、ClientContext、
  writable 断言、process.versions 边界、abandoned 类型、@types/react）。

验证
- 新增看门狗行为用例 3 条（强制回收+告警 / 正常释放不误判 / 并发模式不误杀）、
  R8 用例 4 条（check-login-token.mjs，全部零网络）
- 反向验证 8/8 精确命中（S1/S2 改坏后表现为「下一个 acquire 永久挂起」的 unsettled 警告 ——
  这正是 R3 锁死症状的直接复现）
- tsc --noEmit = 0 错误；全量离线回归 49/49

## 0.1.83 — 2026-09-23

**修**：链式投喂的后续轮不再重复引用历史图片（此前每轮都把最近 24 张重挂一遍）。

- 现象（用户从网页端发现）：同一批图被挂到每一条新消息下，重复很多次。上传本身有缓存、只有一次，
  重复的是**引用**（`ref_file_ids`）。根因：`adapter.ts` 的 `refFileIds: rounds === 0 ? refFileIds : []`
  本是给「自动续写」用的判据（第 2 轮不重带），而**链式投喂每轮都是新的 adapter 调用** ⇒ `rounds` 恒为 0
  ⇒ 顺带每轮都带。
- **真机实测**（新增 `tests/probe-image-chain.mjs`）证明这批是纯冗余：服务端按 parent 链回溯时，
  **历史消息的附件也在上下文里** —— 两张不同布局的图、第二轮都不带 `ref_file_ids`，仍都答对四个角
  （4/4，单组蒙对 1/256）。
- 改法：判据从「第几轮」改成「**服务端手里有没有**」，位置移到 `webapi.ts` 的决策点（`decideFeed` 之后）——
  有父链（`chained`）时只发"服务端还没见过的"（按会话维护 `sentRefIds`，**请求被接受之后**才记账）；
  `restart` / 换号 / 新会话 ⇒ 发全部。⚠️ 是**差集**而不是清空：本轮新贴的图只存在于增量里，漏了就是功能坏。
- 附带效果：请求体不再带一批重复 id，网页端不再重复挂图；会话内图片引用也不再单调累积
  （这曾是 `code 10 / too many ref file` 的一个可疑上游因素，未单独验证）。

验证：新增 `tests/check-image-chain-send.mjs` 8 条（含「新贴的图不能丢」与「restart 必须全发」两侧）；
`check-bundle` +6 条产物断言；反向验证 7/7 精确命中；全量离线回归 48/48。

## 0.1.82 — 2026-09-23

全库审查（25 个模块 / 14653 行）确认的缺陷一次性修完。**三条 P0 里有两条是"功能一直不可用但没人发现"**。

**P0**
- **设置页的「图片上限」滑块从来就没生效过**：前端 POST 了 `maxRefImages`，而宿主 `/gate` 的
  patch 白名单里没有它 ⇒ `patch` 为空 ⇒ 直接返回 400「没有可更新的字段」，滑块弹回默认值。
  这正是防 `code 10 / too many ref file` 把整个会话打死的那道阀门（0.1.77 引入它时只接了显示层）。
- **每次「重登」都会清空账号元数据**（备注名 / 分组 / 显示名 / `serverId`）：重登只传
  `{ id: target }`，而 `carried` 的取值源 `existing` 是靠 **serverId 或 token 相等**解析的 ——
  重登**必然换 token**、CDP 捕获又**不带身份** ⇒ `existing` 恒为 `undefined` ⇒ 白名单全部落空。
  0.1.75 修的是"去重命中"那条路径，而用例恰好也测的是那条，两边一起错位。现在 `upsertAccount`
  **优先认 `patch.id` 指向的记录**。
- **「重登意图」会劫持下一次无关的登录**：`endRelogin()` 全库只有 1 个调用点，而重登意图在
  `commitCapturedAuth` 里**优先于**添加模式、TTL 60 分钟。点了「重登」又关掉窗口，这一小时内
  用「登录新账号」登另一个号 ⇒ 新号凭证被写进旧记录（旧身份还留着）。
  现在 `/login/add`、`/accounts/switch`、`/logout` 都会清掉它，重登分支也会一并消费添加模式。

**P1**
- **浏览器登录（CDP）先落库、后校验身份** ⇒ 每次登录都给同一个账号新增一条记录，`serverId`
  这条去重键永远补不上。改为**先 `validateAuth` 拿身份 → `withVerifiedIdentity` → 再落库**，
  身份回写补上 `serverId`。
- **跑一次网络诊断会把传输层悄悄退回 Node**：`finally` 里写的是无参 `setFetchImpl()`
  （语义是"还原为 Node 全局 fetch"），而默认配置是 Chromium 网络栈 ⇒ 一次性丢掉 TLS 指纹，
  设置页却仍显示 `chromium`，直到重启。现在按进来时那一个还原，不一致还会标红。
- **图片提示标记与"真的发出去了"不一致**：`keptKeys` 此前按**裁剪列表**预先算，上传失败的图
  仍留在集合里 ⇒ prompt 写 `[image attached]`，而 `ref_file_ids` 里没有它，模型对着没送出去的
  图瞎猜。现在按**上传成功（含缓存命中）**累计。
- **`__skipImages`（不带图重发）会清空 `lastImageKeys`** ⇒ "这批 key 被拒过"的知识被抹掉，
  下一轮又从中毒缓存出发，重演"2 次注定被拒 + 1 次无图"。

**P2**
- 上传缓存的 `get` 补上作用域校验（与 `set` 的 `expectScope` 对称，防并发时 A/B 账号引用串号）。
- XML 捕获态下**调用块之后的正文不再凭空消失**（此前 `flush` 只回吐 calls，那段既不回吐也不
  计入 rejected ⇒ 回答"凭空中断"且日志零线索）。
- `appendSink` 补 `else` 兜底：`sink` 未定时按正文发射，不再静默丢字（与 `appendToLastFragment` 对齐）。
- 批量删会话的失败分三态：5xx / 429 / 网关 HTML 不再被当成"服务端不支持批量"永久关掉（那会让
  此后每批退化成 N 个请求，把请求密度抬上去）。
- 账号目录里混入 `.json` / `..json` 这类非法文件名时，不再让**整个账号库读不出来**。
- 闸门等待的计时器改为"可取消"（不是 `unref` —— 被 `await` 的 promise 一旦失去 ref，
  事件循环可能空转退出，表现为进程挂在 `await` 上永不结算；这个错法是用例当场抓出来的）。
- 界面：`renderKv` 挪到「宿主进程」那行 push 之后（此前那行**永远不显示**，而它正是"窗口打不开"
  时唯一能说明原因的证据）；登录按钮在轮询期间保持禁用（防等待中再点一次开第二个窗口）；
  台账迷你图真的把失败时段标出来（此前恒传空集）。

**还没做（建议下一步，本次刻意不动）**：构建链路（tsdown）**不做类型检查**，P0-1 里
`saveGate({ maxRefImages })` 与声明的参数类型不符却一路构建通过、发到线上 —— 给 CI 加一步
`tsc --noEmit` 能拦住这一整类"字段名/类型对不上"的问题，但它需要新增 devDependency 并改锁文件，
不适合和这批修复混在一起发。

## 0.1.81 — 2026-09-22

**截断提示改成「阶梯」上屏**（修 0.1.79 没修干净的地方）。
0.1.79 的抑制用的是 `总条数:保留数` 这个**精确签名**，而「总条数」几乎每轮都在涨 ——
模型每 `read_image` 一次就多一条内容 ⇒ 签名变了 ⇒ 提示照旧每轮上屏
（现场：29 份 → 30 份又来一遍，用户说「这句话的频率还是有点高」）。

- 新的判据：**首次必说明；之后只有「被略过的份数」比上次翻倍、且至少再多 10 份时才再说一次。**
  一条会话里它是 **O(log n)** 次而不是 O(n) 次（按 100 份估算：约 5~6 次）。
- 保留份数变了（用户改了 `maxRefImages`）⇒ 情况本身变了，重新说明一次。
- 文案顺手压短（去掉一句重复的铺陈），日志照旧每轮都记。
- ⇒ **通用判据：抑制重复的"签名"里只要含一个单调增长、且变化频繁的量，抑制就等于没做。**

## 0.1.80 — 2026-09-22

**已知授权失效的账号，请求不再发出。** 现场（09-21）：探活在 22:42 就判定了 token 失效并写进
账号记录，但**请求路径没人看那块牌子** —— 22:50 仍拿它去跑，14 张图逐个走一次 POW + 一次上传
（**28 次注定失败的请求**；而且这些无效请求同样暴露在风控下），直到撞上 AUTH 才停。
判据本身早就写好了（`probe.ts` 的 `lastProbeFailed`），只是从来没有被调用。

- 现在在**发起请求前**检查：命中即抛 `AUTH`，**一个请求都不发**，并给出两条出路 ——
  重新登录（正解），或点「校验全部」重新确认（用于"其实还能用"的误判情形）。
- 判据只认**授权类**失败（`Authorization Failed` / `invalid token` / `HTTP 401·403` /
  中文「登录态已失效」）。断网、超时、5xx、**429** 一律放行 —— 否则一次网络抖动就会把健康账号
  锁住。代价不对等：漏拦只是白跑一轮（后面还有 AUTH 兜底），误拦是功能坏了。
- 标记被清掉（重新登录成功 / 探活通过）后自动恢复发请求，用例里钉了这条。

**图片上传遇授权失败时中止剩余。** 同一个 token 上传剩下的图必然同样被拒，继续试纯粹是白跑
请求（每张一次 POW + 一次上传）。第一张撞 `AUTH` 就停，并把这句写进告知语
（「剩余 N 张未再尝试」）—— 否则文案只报 1 张，看着像小事。
⚠️ 只对 `AUTH` 短路：5xx 之类的偶发失败照常试完，不把偶发放大成"整批放弃"。

## 0.1.79 — 2026-09-21

### 修：图片截断提示每轮刷屏、且量词误导

**症状**（用户实测，drawio 配图会话）：同一句「本轮只带了最近的 24 张图片，更早的 14 张没有随请求发送」
在 **19 分钟里上屏 52 次**；用户反问"我顶多发了 6 张图" —— 量词「张」让他以为是在说自己贴的图。

**实测**（新增排查工具 `tests/count-session-images.mjs`）：读会话历史数出来 **40 个唯一图片内容**
（插件日志里 38 → 末轮 40，吻合）。这 40 份里用户手贴的只有个位数，
**其余绝大多数是模型自己 `read_image` 读进来的局部校验片段**
（`_chk_1.png` / `_probe_top.png` / `_zoom_midcap.png` / `_docx_fig4_top.png` …），
再加上迭代产生的新版本（同一个 `zh_compare.png` 挂着两个不同 hash）。
⇒ **数字没错，错的是叫法**：它是「图片**内容条目**」，不是「图片张数」。

**修法**：

1. **换量词 + 说清来源**：改说「N **份图片内容**」，并点明"这个数字指的是图片内容条目、
   不是你贴的张数：模型每读一次图、或同一张图被重新渲染/裁剪出新内容，都会多算一条"。
2. **同样规模只上屏一次**：新增 `lastTrimSignature`（`总条数:保留数`），规模没变就只写日志；
   规模**变了**才再提示一次（说明情况在恶化）。日志仍每轮都记，排查不受影响。

**新增排查工具** `tests/count-session-images.mjs`。
⚠️ 顺带记一个坑：`session.v3.jsonl.zstd` 是**多帧 zstd**，`zstdDecompressSync()` 与
`createZstdDecompress()` **都只解第一帧**（只出 231 字节 ＝ session 头），极易误判成"这个会话没图片"。
必须按魔数 `28 B5 2F FD` 切帧、逐帧解，解不出的段当假阳性跳过。

**⚠️ 没改的**：截断本身不能去掉 —— 服务端对单次请求能引用的图片数有硬上限（实测 40~52），
40 份内容已贴着线，不截断整轮会被拒（`code 10` 的形态）。

## 0.1.78 — 2026-09-21

### 修：`code 9 / invalid ref file id` 会让整个会话卡死 → 两级降级自救

**症状**：从某一轮起整轮失败，报 `DeepSeek 网页端错误（code 9）：invalid ref file id`，
而且**此后每一轮都失败** —— 图留在 DSH 的消息历史里，每轮重新收集、重新引用、再撞一次，
用户除了丢掉整个会话没有别的出路。

**根因不在「重复 id」上**（那是 0.1.66 修过的另一种形态）。本次现场：同样的操作在另一个账号上正常，
出问题的那个账号 `capturedAt` 刚刷新过 —— 但**因果并未证实**。所以本版不去猜「哪份凭证有问题」，
而是让这条错误**可自愈**。

**修法**：

1. **`code 9` 的两个含义分开了**（`src/webapi.ts`）：上传时是 `unsupported file type`（换名字重传即可），
   发请求时才是 `invalid ref file id`。后者单独给稳定错误码 `INVALID_REF_FILE`。
2. **闸门外包一层降级重试**（`src/adapter.ts`），每级各一次：
   - 被拒 → 丢掉那几张的上传缓存、**重新上传**拿新 `file_id` 再试
   - 仍被拒 → **不带任何图片**重发，至少让这一轮继续下去
3. **只在「一个字都还没吐给上层」时才重试** —— generator 已 yield 的内容撤不回来，
   重试会让用户看到重复输出。
4. **缓存是定点清理**（只清被拒的那几条），不是全清 —— 全清会让下一轮把所有历史图重传一遍。

### 顺带：捕获凭证时留痕（`src/auth.ts` / `src/login.ts`）

捕获时若发现「只拿到 token、cookie 与请求头都为空」，给凭证记一条 `captureWarning` 并写进日志。
**只记录、不拦截** —— 实测鉴权只用 token，缺 cookie 本身是合法的（手工粘 token 的账号就是这样），
拿它拦人会把正常路径一起误伤。留痕是为了下次再遇到这类问题时，能立刻定位到「这份凭证可疑」。

## 0.1.77 — 2026-09-19

### 修：一次请求能带的图片数没有上限 → `code 10 / too many ref file` 会让整个会话作废

（问题由群友的实测报告定位，本版按它给的方向修复；报告内容已逐条核对代码，属实。）

**现象**：长会话里反复读图（`read_image` / 截图迭代），从某一步起**每一轮都失败**：

```
本轮运行失败
DeepSeek 网页端错误（code 10）：too many ref file
```

**根因**：图片是**请求级**的 —— 一次请求用一个 `ref_file_ids` 带一批，网页端对这一批的数量有上限。
而插件把整段历史里去重后的图片**全量**塞进去，**一个长度阀门都没有**。去重救不了它：
`attachmentId` 是内容寻址的，重新截图 / 重新渲染的预览图每次内容都变 ⇒ 新 id ⇒ 历史里只增不减。
越过上限后服务端拒收**整轮**，而图还留在历史里 ⇒ **该会话此后每一轮都失败**，用户只能丢掉全部上下文。

**定量边界**（来自群友实测；那份日志在对方机器上，我们无法独立复核，但它主动标注了不确定性）：
最后一次成功 40 张、第一次失败 52 张 ⇒ 真值落在 **(40, 52]**。

**修法**：

- 按时间只带**最近的 N 张**。新增配置 `maxRefImages`：默认 **24**、区间 `[0, 100]`，`0` = 不限制
  —— 24 给已知安全线留了 16 张余量。
- **标记同步收敛**：被略过的图不再写 `[image attached]`，改写 `[earlier image omitted]`。
  只截 id 不截标记的话，模型会以为它收到了那些图，转而对着没送出去的图瞎猜。
  标记**按图片在消息里的实际顺序**逐张给出（不能写成一堆 attached 再一堆 omitted，
  否则模型搞不清被省略的是哪几张）。
- **告知用户，而且措辞不是报警**：

  > `[deepseek-web] 本轮只带了最近的 24 张图片，更早的 36 张没有随请求发送。网页端对一次请求能引用的图片数量有上限（实测 40~52 之间），超了整轮都会被拒，所以按时间留最近的几张 —— 这是正常的长度控制，不是错误。`

  用报错口吻会让人以为出了问题，而在弄清原因之前，他很可能就把一个本可以继续用的会话丢掉了。
- 设置页新增「图片上限」滑块（`0` 那一档明确标成"不限制（不推荐）"）。

**覆盖**：`check-image-refs` +7 条（截断取最近几张、标记与实发严格一致且按顺序、
提示不是报警口吻、不超限时行为与改动前一致、恰好等于上限不触发、可配、`0` = 不限制）；
`check-bundle` +4 条产物断言；反向验证 **7/7 精确命中**；全量离线回归 **44/44**。

> 顺带修掉一条被本次改动打破的老断言（0.1.66 那条断的是 `notice: imageNotice(...)` 的固定形态，
> 现在改成先收集 notices 再一次性回传）—— 按意图重写而不是跟着代码改。

## 0.1.76 — 2026-09-17

### 改：prompt 上限默认值 150 万 → 40 万（它其实是风控阀门）

`maxPromptChars` 决定**每次请求最多带多少字符的转写**。而网页端是**无状态**的 —— 每一轮都要
把整段对话重新发一遍 —— 所以这个数字直接等于**单次请求的体量**，它不只是"能记多长的对话"。

把它默认顶在 150 万字符（纯中文 ≈100 万 token），等于默认就允许"一次顶满 1M 上下文"。
实测同一个会话里单次输入从 9.7k token 涨到 **293k**；我们自己的四个账号在两天内陆续被限制，
体量是主要嫌疑。

所以默认降到 **40 万**（≈27 万 token，长任务够用）。**可调范围不变**（仍是 `[12 万, 150 万]`）。

> ⚠️ 确实需要更长的转写，仍可以自己往上调，但请把它理解为「**拿账号稳定换更长的记忆**」：
> 真要长上下文，更划算的是把「上下文投喂」切成 `chained`（只发增量、历史交给服务端维护），
> 而不是抬高这个天花板 —— 后者是**每一轮**都要多付的成本。

改动落在：`src/gate.ts` 的 `DEFAULT_MAX_PROMPT_CHARS`；`src/adapter.ts` 里三处兜底改成引用同一个
常量（原先各自硬编码 `1_500_000` —— "同一个默认值散在三处"本身就是隐患）。README 中英在配置表
和「配置」一节都写明了这层取舍，面板上那个旋钮的初始位置也随之落在区间中部、不再顶格。

顺带把 `tests/check-request-gate.mjs` 里一条**把默认值写死成 `1_500_000`** 的断言按意图重写：
改为断言"默认值必须落在可调区间内、且**不等于上限**"（顶格 ＝ 默认就把阀门开到最大，正是本版要改掉的）。
写死数值等于把"当时恰好取了这个数"当成期望值 —— 与 0.1.72 那条把 bug 固化下来的断言同族。

## 0.1.75 — 2026-09-17

### 修：重登把账号"弄没了"—— 两个独立的真 bug

用户实测："点了重登，账号变成未识别账号；再发个消息显示 API 密钥无效，账号也退出了。"查下来是两件事。

**① 重登把显示名抹掉了**（这才是"账号看起来退出了"的原因）

库里三个账号对照：

| 账号 | user 字段 |
| --- | --- |
| `acc_cdc0000f` | `{"display": "137******78"}` |
| `acc_ec650e63` | `{"display": "lidi*********+mn1@gmail.com"}` |
| `acc_d14996c7` | `null` —— 但 `serverId` 还在，说明它本来是有身份的 ← 就是它 |

`upsertAccount()` 在带"用户附加的元数据"时用的白名单里**没有 `user`**。而重登抓回来的凭证是
`unverified` 状态 —— **服务端还没校验，拿不到账号信息** ⇒ 合并时 `user` 为空 ⇒
**把原记录里可辨识的显示名覆盖没了**：界面从「137\*\*\*\*\*\*78」退化成「未识别账号 (acc_xxxx)」。

修法：`user` **单独做深合并**（新值优先、缺的字段沿用旧值），不再走那条 `??` 链。
这与之前那句"重登一次，账号从分组里掉出来"是**同一个疏漏的另一半** —— 那次给白名单补了 `groupId`。

> `user.display` 是服务端在**校验通过**时才给的一次性信息，被抹掉后要等下次校验成功才补得回来 ——
> 也就是说这个 bug 能自愈，但要等。

**② 「重登」在浏览器登录态已失效时是个死循环**（这是点了没反应的原因）

「重登」的设计是**复用浏览器 profile 里的登录态**（卖点：不敲密码）。但那份登录态**已经失效**时，
复用等于把同一个坏 token 再抓一遍。日志实证（连点两次完全一样）：

```
14:53:20 点「重登」
14:53:22 1 秒内「已捕获 token」    ← 复用来的，人不可能 1 秒登完
14:53:27 校验 → invalid token
14:54:05 再点一次 → 14:54:07 又是同一个坏凭证
```

修法：**账号已被标记失效时，重登不再复用** —— 先清掉 profile 与登录分区，让浏览器窗口从零打开、
你真正登录一次；账号健康时的复用行为**完全不变**。界面上的按钮提示与进度文案改为跟随宿主返回，
不再写死"不清理登录态"。

> 不是 bug 的部分：DSH 界面上的「API 密钥无效」是它对 `AUTH` 类错误的统一文案（服务端确实回了
> `Authorization Failed (invalid token)`）；账号**没有被删除**，那个红标是 0.1.61 有意加的提示
> （否则切到死号时界面完全静默，你不知道是哪个账号出问题）。

新增 `tests/check-relogin-integrity.mjs`（7 条）；`check-bundle` 加 4 条产物断言，并把一条老断言按
**意图**重写（它数的是"`clearLoginState()` 恰好出现 2 次"，多一个入口就假红 —— 等于把"当时有几处"
当成了期望值）；反向验证 **7/7 精确命中**；全量离线回归 **44/44**。

## 0.1.74 — 2026-09-17

### 修：模型把 `run_code` 的代码写成正文 → 那一轮零工具调用 → 会话"停下来了"

现场（11:00 那次会话）：连续三轮里模型都在 reasoning 里写着"现在真正发出工具调用"，
输出的却是一段带围栏的 `ts` 裸代码块 —— **正文里连协议标记都没有**，整会话 `tool_calls`
零命中。没有工具调用 ⇒ agent loop 判定回合结束 ⇒ 你看到的是"它停下来了"。
模型自己在 reasoning 里也承认了：「我把 TypeScript 代码写成了正文文本，而不是作为工具调用发出」。

**根因不在适配器**：同一个 preset、同一个插件、同一个模型，另一个长会话里 `run_code`
被正常调用了 **178 次**。差别在于那个是长会话（历史里全是正确的调用形态可以模仿），
这次是新建会话、冷启动第一轮就选错了方向。

真正的原因是**第三方 preset 注入的框架与工具调用协议冲突**：染神 preset 的
`tool-bootstrap.mjs` 往系统提示里加了一句 PTC 说明 ——「你在 Programmatic Tool Calling 模式，
所有动作必须通过 `run_code` 写 TypeScript 程序完成」；同 preset 的 persona 里还写着
`One complete deliverable per turn: numbered steps or code blocks` 与
`When rules conflict, choose the reading that still produces the deliverable`。
模型于是把"写出程序"当成了"执行程序"。

**这一版加运行时兜底**：识别出这种形态后，自动追加**一轮纠正**请求。

- 判据 `looksLikeUnexecutedToolProgram()`（`src/protocol.ts`）：正文里出现围栏代码块、
  且块内含 `tools.<名字>(…)` 形态的调用（那是程序体的特征）；没有围栏时只认带 `await` 的形态。
  围栏块还要过 80 字符的长度门槛 —— 短于这个多半只是"提到某个 API"而不是写程序。
- 触发条件（全部满足才动手）：本轮**零工具调用** + 正文命中判据 + `purpose === 'chat'` +
  没被中止。**只给一次机会**，纠正不成就正常收尾 —— 不把请求密度打上去。
- 纠正指令直接对抗那句 PTC 措辞：*即使系统提示要求你写 TypeScript 程序，那个程序也必须
  放进工具调用的 arguments 里 —— 只有作为工具调用发出，它才会真的被执行。*
- 与「自动续写」是**互斥的两条分支**：续写管"话没说完"，这个管"话说完了、但该发的动作没发出去"，
  两者要发的内容完全不同。它同样挂在 `autoContinue` 开关下，关掉续写就一并关掉。

新增 `tests/check-unexecuted-program.mjs`（10 条，正反两侧都钉）；
`check-auto-continue` 加 5 条行为用例（其中 3 条是防误伤：普通正文 / 无关代码块 /
**本轮已拿到工具调用**时的健康形态）；`check-bundle` 加 3 条产物断言；
反向验证 **8/8 精确命中**；全量离线回归 **43/43**。

## 0.1.73 — 2026-09-17

### 修：「浏览器窗口登录」主按钮不清登录态（四个登录入口里唯一的疏漏）

四个登录入口里**三个都做了前置清理**，只有客户端那个主按钮是"裸"的 —— 它直接调
`/login/browser`，没有任何清理。而登录用的是**独立 profile**
（`<DSH_HOME>/web-login/browser-profile`，**跨次保留**）⇒ 里面若还留着上次那个账号的登录态，
Edge 一打开就是已登录：**你以为在登录，抓回来的却是旧号**。

- 客户端主按钮改为带 `fresh: true`；`/login/browser` 在该标志下先清登录态
  （**按需**，不是路由的默认行为）。
- 把「清 profile + 清登录分区」收口成 `src/login.ts` 的 `clearLoginState()` ——
  `/login/add` 原先自己写那两行，**这次的疏漏正是这种重复代码漂移出来的**，一并收口。
- 「重登」**仍然有意不清**：留着登录态才能"一打开就复用、一个密码都不用敲"，
  这是当初特意做的取舍 —— 想省输入的场景走它。

新增 `tests/check-login-fresh.mjs`（5 条）+ `check-bundle` 4 条产物断言；
反向验证 4/4 精确命中；全量离线回归 42/42。

> 💡 顺带澄清：登录用的那只 Edge **一直**是独立 profile（`--user-data-dir` / `--disable-sync` /
> `--no-service-autorun`），**不读也不写你日常 Edge 的 cookie 与历史** —— 隐私上早就隔离了，
> 这次修的只是"那个 profile 里残留的登录态没被清"。

## 0.1.72 — 2026-09-16

### 修：账号库标题退化成 `acc_97768033`（0.1.71 的回归）

0.1.71 把「按组分区」挪到宿主算时，喂给 `partitionByGroup` 的是**原始账号记录**，
而它返回的 `accounts` 会**原样**交给客户端渲染 —— 而 `title` / `display` / `isActive`
都是**响应加工字段**，原始记录里没有。于是面板上：

- 标题退化成内部 id（`acc_97768033`），显示名与「✅ 当前」徽章一起消失；
- 分区本身是好的（排序、置顶、未分组兜底都正常）—— 坏的只是"渲染字段"这一层。

修法：先 map 出「可直接渲染的视图」，再把**视图数组**喂给 `partitionByGroup`
（它是泛型 `T extends GroupableAccount`，只要求 `id` + `groupId`，视图满足）。
顶层 `accounts` 继续返回 —— 客户端有"没有 sections 就平铺"的兜底路径，且重建签名覆盖它。

**为什么原来的测试没抓住**：

- `check-account-groups.mjs` 的 17 条是**纯函数**用例，而 `partitionByGroup` 对
  "喂原始记录还是喂视图"一视同仁（两者都有 `id` + `groupId`）—— 差别只在**接线层由谁喂**；
- 更糟的是那条产物断言当时写成 `sections: partitionByGroup(list, groups, activeId)`，
  **把 bug 固化成了期望值**。

新增 `tests/check-accounts-view.mjs`（9 条，用真实 `apply()` 调 `/accounts`）：

- `title` 非空、不等于内部 id、且是掩码后的标识；`display` 非空；
- `sections` 里的账号同样带 `title` / `isActive` / `cookieMeta` / `lastVerifiedAt`
  （回归的哨兵：标题退化与「当前」徽章消失都在这里抓）；
- 同时守住「分区 / 置顶 / 未分组兜底仍然工作」，免得修这个把那个砍了。

产物断言改成表达**意图**：`sections` 必须喂视图数组 + 不得再出现
`partitionByGroup(list, …)`。反向验证 4/4 精确命中。

## 0.1.71 — 2026-09-16

### 新增：账号库分组、备注与状态刷新；按钮文案名实相符

账号多起来之后列表固定按**捕获时间倒序**排（新号永远插最前、常用的那个一路往下沉），
也没法把「工作号 / 备用号」分开看。这一版补齐。

- **分组**：新建 / 改名 / 删除，账号归组（每行一个下拉），列表按组分区、组可折叠
  （折叠状态记在本地，重建列表不会丢），未分组的落进「未分组」兜底。
- **当前账号所在的组自动置顶** —— 正在用的号不会沉到看不见的地方。组内仍是捕获时间倒序。
- **组定义单独存** `~/.dsh/web-login/groups.json`，账号记录里只有一个 `groupId` 指针。
  因此**删组不删账号**：删组只删定义、不遍历账号文件；组被删后指针悬空的账号一律落进
  「未分组」，一个都不会从列表里消失。
- **「校验全部」**：对库里每个账号跑一次只读探活（`users/current`，**零额度**），
  串行执行并有并发互斥；用来刷新登录态、补上账号名、清掉已恢复的失败标记。
- 「重命名」→「**备注**」（它写的一直是备注名，改的只是名字，不是功能）、
  「重新登录」→「**重登**」。

**分组只影响显示，不影响行为**：切号、会话复用槽、会话清理策略一律不看它 ——
分组是你的文件夹，插件的调度逻辑保持简单可预期。

⚠️ 面板上「校验全部」（本版新增）与「刷新状态」（原有，刷 `/status` 那张卡）是两回事，别混。

## 0.1.70 — 2026-09-16

### 修：回答「说了一半就停了」的两种成因（都属于静默丢内容）

同一类症状、两个不同根因 —— 都是「模型其实说了，但内容没到用户眼前」。

**① 思考跑飞：整轮只有思考、没有正文也没有工具调用 → 被当成「正常完成」**

- 现象：模型停在半路，只能手动敲「继续」才动。实测某个会话 16:12–16:36 的 15 轮里中了 **2 轮**。
- 根因：`outputChars` 把**思考通道的字数也算作「有输出」** ⇒ 跳过空响应分支、直接报 `stop`
  （正常完成）⇒ agent loop 认为这回合干完了。
- 修法：判据只看**正文**。思考写了一堆、正文与工具调用都没有时，报 `EMPTY_RESPONSE`（**可重试**）
  ⇒ DSH 自动重发；重发仍失败时你会看到明确的失败提示，而不是静默停住。
- 顺带把一行会误导人的日志分档：`toolCallCount > 0` → 「正常形态」；否则 → 「内容可能全在思考通道」。
  （旧文案一律说「内容可能全在思考通道」，实测把读日志的人带偏成「每天上百次故障」；
  真实比例是 885 条助手消息里 **3 条**真空转，另有 **266 条**是健康的调工具轮 ——
  工具调用是被工具过滤器从正文流里取走的，所以「正文 0 字 + 有工具调用」是正常形态。）

**② 回声守卫砍掉后半段 → 现在会告诉你**

- 现象：回答写到一半断掉（实测断在「问题项 4」处），界面无任何提示，`turn/end` 还是「正常完成」。
- 根因：转写回声守卫的设计是「**命中一行就从该行起砍到结尾**」，而判据过宽 ——
  模型在**正文里正常引用一次**工具结果当证据（`[Tool Result for call_…]`）也会命中，
  于是整段回答（问题项 4、5 与结论）被一起丢掉。
- 修法两条：
  - **收窄判据**：行内转写特征拆「强 / 弱」两档。弱档（`[Tool Result` / `[status:` / `[System]`）
    不再一律砍，改为**先扣住、再看后文**：后面 2 行普通内容仍无回声 ⇒ 判为正文、放行；
    相邻两行都是转写特征 ⇒ 才判回声。强档（`truncated]` / `Assistant truncated` /
    `[N chars omitted]`）是 prompt 自己的截断占位符，正常回答不会引用 ⇒ 照旧立即判回声。
  - **不静默**：真被砍掉时，回答末尾追加一行
    `[deepseek-web] 本轮有一部分「历史回放格式」的内容被过滤（未上屏），回答可能因此不完整。`
- **局限（写清楚）**：单独放在**行首**的引用与真回声在字节层面无法区分，仍会被砍 ——
  但你会看到上面那行提示，不会再对着一个断掉的回答不知道发生了什么。
  想彻底避免：提问时说一句「不要贴工具返回原文」。
- 用例：`check-transcript-echo.mjs` 16 → **21 条**（新增：单行引用不误伤、分块下内容与顺序不变、
  引用 + 空行 + 正文仍放行、连续两行仍判回声、引用后紧跟行首标记仍判回声）；
  `check-bundle.mjs` 新增 3 条产物断言。

## 0.1.69 — 2026-09-16

### 修：账号库里两个不同账号显示成同一个（二次屏蔽把可辨识部分抹掉了）

- **根因**：网页端返回的 `user.display` **本身就是屏蔽过的**（形如 `192******27`、
  `lidi*********+mn1@gmail.com`），插件存盘存的就是它；面板又调了一次 `maskIdentifier`，
  而它对邮箱只保留本地部分前 3 个字符 ⇒ 两个 Gmail 账号都变成 `lid***@gmail.com`，
  看起来像同一个号。**这恰好违背该函数自身「保留可辨识部分」的目的。**
- **修法**：`maskIdentifier` 改为**幂等** —— 值里已经含 `***` 就原样返回。
  一处改动同时修好三个调用点（面板标题 / 列表 display / 校验结果 display）。
  **未屏蔽过的原始值照旧屏蔽**，安全网不丢。
- **说清楚一件事**：**"把账号显示全"做不到** —— 原始邮箱/手机号压根不经过插件
  （接口只给屏蔽值）。这版修的是"重名"，不是"显示全"。
- 实测（本机 7 个账号）：修前只有 5 个互不相同的显示名，修后 **7 个全不同**。
- 用例：`logic-test.mjs` 新增一组幂等断言（含"两个 Gmail 不能相等"的回归）。

## 0.1.68 — 2026-09-15

### 修：经 read_image 等工具返回的图片一律传不上去（服务端按文件名后缀判类型）

用户看到界面上反复出现「有 2 张图片没能传给模型（code 9：unsupported file type）」，
但那些图本身是完好的 PNG。真机 A/B 定位到：**服务端按 multipart 里的文件名后缀判类型**，
`content-type` 说了不算 —— 同一份 PNG 字节，只改文件名：

| 文件名 | 结果 |
| --- | --- |
| `image.png` | 成功 |
| 纯 64 位 hex（无后缀） | 被拒：`code 9 unsupported file type` |
| `<64位hex>.png` | 成功 |
| 不传 name（走缺省） | 成功 |

而宿主给图的 `name` 是两套的：`user/message` 与 `agent/inbox` 给的是 `image.png`，
`tool/result`（`read_image` 之类工具返回）给的是**纯 sha256、没有扩展名**。
旧实现把 `ref.name` 原样透传 ⇒ **凡是经工具返回的图，一律被拒**
（本机 09-14 有 36 次、09-15 有 6 次，全部静默降级成纯文本）。

修法：新增纯函数 `imageUploadName(name, mediaType)`（`src/protocol.ts`）——
只保留受支持的图片后缀（png / jpg / jpeg / webp / gif），其余按 `mediaType` 重建为
`image.<ext>`；并只取基名（宿主若给的是路径，别把目录带进 multipart 的文件名）。
`uploadRequestImages` 改用它，不再透传 `ref.name`。

测试：`check-image-refs.mjs` 13 项（新增 5 项：纯 hex 名 / 缺 name / jpeg / `.bmp` / 带路径）；
`check-bundle.mjs` 新增一组产物断言（按调用点匹配，三条子句各自做过"改坏必红"的反向验证）。
真机复现脚本：`tests/probe-upload-name.mjs`（需已登录凭证；只上传、不建会话）。

注意：这与 0.1.66 的「同一张图在历史里重复出现 → `ref_file_ids` 去重」是**两个不同**的
失败形态（那个修的是 `biz_code 9 / invalid ref file id`），两条修复都在，别删任何一条。

### 文档

- README 两版补上两条已知问题：上传文件名必须带受支持后缀；DSH 前端把单个 `$` 当行内公式。

## 0.1.67 — 2026-09-15

### 修：新登录的账号不会自己出现在账号库里，要关掉设置页再打开

用户反馈：加完一个账号，账号库列表还是旧的，"退出一下才能刷新"。

根因是**账号库列表不在状态轮询里**。面板每 2 秒轮询一次，但只读 `/status` 并渲染
**当前账号**的信息；列表本身只有 `loadAccounts()` 被显式调用的那几个时刻才重读
（初始化 / 切号 / 移除 / 重命名 / 重新登录 / 添加 / 导入）。而登录捕获**是异步落地的**：

- CDP 那条路（宿主在 utility 进程时的常态）要等用户在浏览器里登录完；
- 能开 Electron 窗口那条路更直接 —— `openLoginWindow()` 是"开窗即返回"，
  捕获发生在响应之后。

于是"加完账号"的捕获很可能晚于那次 `loadAccounts()`，列表就停在旧快照上，
**而且此后不会再更新**（轮询不碰账号库）。

最直接的证据是代码里原有的一句注释（「登录新账号」的处理里）：
「期间保持轮询更密一点，万一捕获是异步落地的也能及时刷出来」——
作者本来就指望轮询兜住这件事，但轮询只读 `/status`，**那个兜底从未生效**。
本次修的就是"让它成真"。

**修法**：轮询里按节拍重读 `/accounts`。

| 时机 | 间隔 | 为什么 |
|---|---|---|
| 登录流程进行中（窗口开着 / 刚操作过 5 分钟内） | **3 秒** | 捕获一落地就能看见 |
| 空闲 | **30 秒** | 够让探活补上的账号名 / 限制状态 / 失败标记自己出现，又不必一直读盘 |

配套（`src/account-sync.ts`，纯函数）：

- **内容签名守卫**：`accountsSignature()` 只取界面真正渲染的东西（账号数组 + 当前账号 id），
  内容没变就**不重建 DOM** —— 否则每 3 秒会把用户正在悬停的按钮、正在输入的
  重命名框换掉。整包 `JSON.stringify` 而不是逐字段挑，**按构造就是完整的**：
  将来 `/accounts` 多返回一个会被渲染的字段，这里不用改也不会漏。
- **后台同步静默**：轮询的偶发失败不写进 `accountsMsg`（那是给用户操作反馈用的，
  被后台失败覆盖会更困惑；下一次成功就自然好了）。

### 同源的第二个缺口（一并覆盖）

探活会更新记录（补上账号名、限制状态、失败标记），而**账号名是捕获之后由校验拿到的**
（见 `index.ts` 里那段回写）。此前若面板一直开着，那个名字永远不会出现；
现在 30 秒内会自己补上，不用再重开面板。

### 测试与验证

- 新增 `tests/check-account-sync.mjs`（12 项）：重读节拍（登录中 / 空闲 / 从未同步过 /
  空闲必须明显更慢）、签名（同内容同签名、新增账号、切换当前账号、顺序变化、
  探活补上的四个字段、`footprint` 必须被排除、畸形响应、循环引用不炸）。
- `check-bundle` 新增一组产物断言（轮询调用点 / 签名守卫 / 共用渲染入口 /
  后台同步的 catch 必须为空 / 判据函数真的进了产物）。
- 反向验证 **12 处 12 中**（源码 5 + 产物 5 + 复原 2）：把轮询那句去掉、
  把签名守卫去掉、让后台同步不再静默、让渲染入口不算签名、把判据模块从产物里改名 ——
  每一处都精确只红对应那一条。
- 全量回归 **39/39 个用例文件**通过。

## 0.1.66 — 2026-09-15

### 修：同一张图被引用两次 → `ref_file_ids` 出现重复 id（图会永久卡死整条会话）

外部提交了一份三条 bug 的审计，逐条核实后**只有这一条属代码缺陷**（另两条见下），
但它的触发条件是真实的：`collectImageRefs()` 会**有意**走进 `tool-result` 内嵌的图片
（网页端不看图，模型得调 `read_image`，而工具结果里带着图片本体），
于是同一张 `attachmentId` 会在同一份历史里出现多次。
实测本机会话 `install-plugin/session-c1fb8208-*` 里 seq=17 与 seq=23
两个 `tool/result` 各自内嵌同一张 `sha256:23c18a56…`（89962 B JPEG）。

`attachmentId` 是**内容寻址**（sha256）⇒ 两次是同一个缓存 key ⇒ 旧实现在缓存命中时
把**同一个 file_id 又推一遍**，请求体变成 `ref_file_ids: [id, id]`。
服务端不接受重复 id（`biz_code 9 / invalid ref file id`），被拒后**该会话后续每一轮都失败**
（图留在历史里），只能新开对话。

**修法**：`uploadRequestImages()` 里按 `attachmentId` 去重（每个附件只产出一个 file id）。
去重按 attachmentId 而不是 fileId —— 不同附件即使内容相同也各有各的 id，不该在这里合并。

### 修：图片没能送出去时，界面上什么都看不到

上传失败时旧实现只写一行 `logger.warn` 然后降级成纯文本，当轮 completion 正常 `FINISHED`
—— **用户只会以为「模型看不懂图」**。实测本机 09-14 有 36 次上传被服务端以
`code 9 unsupported file type` 拒绝，全程无声。
（注意同一个数字在两个端点含义不同：上传端 code 9 = `unsupported file type`，
completion 端 code 9 = `invalid ref file id`。）

**修法**：`uploadRequestImages()` 把失败原因随结果回传，适配器在**回答开头**插一句
`⚠️ [deepseek-web] 有 N 张图片没能传给模型（原因），本轮回答只基于文字内容。`
与 F28「工具调用被丢弃要告知模型」同一原则：本该处理的输入丢了，就必须说出来。

### 修：续写判据漏掉「；」「、」—— 截断点落在它们后面会静默少一段

`looksMidSentence()` 只在尾部是「，」「：」等少数分隔符时才判"未写完"，
而 **`；`（全角分号）与 `、`（顿号）落到了「字母/数字/汉字以外的字符 → false」那条兜底上**，
被判成已写完。实测（把源码函数体切出来直接求值）：`；` → false、`、` → false，
而 `，`/`：`/`;` → true —— 同一个文件里两套标准。

为什么这次要紧：服务端**会在句中截断却照发 FINISHED**（README 有记录），
此时 `cutByServer` 为 false，这条判据是**唯一**防线 ⇒ 截断点落在分号/顿号后就是静默丢内容。
两个恰恰是最强的"还没写完"信号（列举到一半、分句列到一半）。

**修法**：把尾部标点拆成两个显式集合 —— `MID_SENTENCE_TAIL`（分隔符，判未完）
与 `COMPLETE_TAIL`（终止符，判已完），不再靠字符串 includes 混在一起。
`…` 有意留在"已完"里：省略号既可能是没说完、也可能是有意的收束语气，
误判 true 会让一句正常收尾的话被要求"接着写"，感知上比偶发漏判更打扰。

### 测试与验证

- 新增 `tests/check-image-refs.mjs`（8 项）：去重（同图 ×2 / ×3）、不同图不误合、
  无图不碰附件服务、上传失败要告知、宿主没接线也要告知、正常情况**不得**出现提示、超长原因截断。
  这条路径此前**零覆盖** —— 真实上传要 PoW(sha3 wasm) + 真网络，所以按本文件已有的
  `streamCompletion` 惯例，把上传做成可注入依赖（`deps.uploadImage`）。
- `tests/check-auto-continue.mjs` +4 项：`；`、`、`、`。`（长回答不续写）、`…`（刻意不续写），
  且每条都带"样本必须 > 40 字"的自证断言（短样本会被 F29 门槛吃掉、用例等于没测）。
- `check-bundle.mjs` +3 组产物断言（去重循环 / 失败回传 / 注入缝 / 提示进正文 / 两个集合的内容），
  全部按**调用点**写。
- 反向验证 **18 处 18 中**（源码 8 + 产物 7 + 复原 3）：去重失效精确红 2 条、
  失败不回传精确红 2 条、`；` 精确红 1 条、`、` 精确红 1 条；把 `。` 也放进 MID 会让
  9 条老用例同时报警（说明"放宽过头"拦得住）。
- 全量回归 **38/38 个用例文件**通过。

### 核实结论：外部审计的另两条

- **「服务端句中截断 + FINISHED 无法区分」** —— 代码描述属实（且比它说的更宽，见上），
  但属于**启发式固有局限**，代码注释里早就承认了，不是新发现的缺陷。
- **「更新检查无退避」** —— 描述属实但**定性不对**：`/update-check` 是**手动按钮**
  （`client/index.ts` 的 click），没有任何自动轮询 ⇒ 不存在放大限流的风险；
  「短超时 + 优雅失败、不卡设置页」是 `update-check.ts` 明写的设计目标。不改。
- 顺带修正一处：`randomUUID` 那条结论对、依据可以更硬 —— `protocol.ts:9` 是
  `import { randomUUID } from 'node:crypto'`，**显式 Node 实现**，压根不经过浏览器
  `crypto`，与"安全上下文"无关。

### 说明

本机调用台账 1123 条里 `PROVIDER_ERROR` 只有 1 条（且非图片轮次），
所以「completion 端 code 9」这个失败形态**在本机从未出现过** ——
去重修的是"迟早会中"的隐患，不是你已经踩到的那个坑。
真正影响本机的是上传端那个 `unsupported file type`（成因未定位，需要真机复现）。

## 0.1.65 — 2026-09-15

### 修：「重新登录这个账号」会新增一条同名记录，旧那条还一直报错

用户实测：点「重新登录这个账号」→ 重登成功 → 账号库里**多出一条同名账号**，
旧那条仍然挂着「❌ 需要重新登录」，同时当前账号也被顶到了新记录上。

两层根因，缺一不可：

1. **`/login/relogin` 完全没用到传进来的 `id`** —— 它只调了 `beginAddAccount()`，而那个函数
   的语义只是"别切换当前账号"，**不保证更新同一条记录**。更糟的是添加模式有 15 分钟 TTL，
   而用户从点按钮到真正登录完成隔了 34 分钟（实测）⇒ 意图早过期，捕获退回"写入并设为当前"，
   于是既多了一条记录、又换掉了当前账号。
2. **捕获时拿不到身份，去重无从下手** —— 捕获只有 token/cookie，没有 `serverId`；
   而重新登录必然换新 token（旧 token 匹配不上）⇒ `upsertAccount` 只能新增一条。
   身份是**捕获之后**校验才拿到的，那时已经晚了一步。

**修法**：新增"重新登录意图"（`beginRelogin(id)` / `pendingReloginTarget()`）：

- 记住**要更新哪一条记录**，捕获时按 `patch.id` 落库（优先于 serverId / token 去重），
  所以不会再新增，也不切换当前账号；
- 成功捕获时显式清掉旧的 `lastVerifyError` —— 否则那条记录会一直显示「需要重新登录」
  （`upsertAccount` 的字段继承用 `??`，传 `undefined` 清不掉，所以用 `updateAccount` 单独清）；
- 意图 TTL 放宽到 **60 分钟**（用户可能开着登录窗口去干别的）；
- 认得出"这次捕获是另一个号"时**放行成普通捕获**，绝不覆盖别人的记录；
- 目标记录已被移除时同样放行，不凭空把它写回来。

### 改：「重新登录」按钮挪进右侧动作列

原来它跟在失败说明后面、**独占一整行**，占地方又不整齐（用户反馈）。
现在失败说明只留一行短文字，按钮挪到 切换/重命名/移除 那一列的最前面（它是这行最该点的）。

测试：`check-account-add` 13 → 21 项（新增 8 条重新登录用例：原地更新、身份不符放行、
token 未变时清失败标记、TTL 过期、意图只用一次、目标已移除、与添加模式并存）；
`check-ui-copy` 6 → 9 项（按钮位置、失败块不许放按钮、⚠️ 也算醒目）；`check-bundle` 新增一组产物断言。
反向验证 8 发 8 中（源码 5 处 + 产物 3 处）。全量 37/37 用例文件通过。

> ⚠️ 已经产生的重复记录不会自动消失：请在账号库里把**旧的那条**（捕获时间早、标着
> ❌ 需要重新登录）手动「移除」。本版之后重新登录只会原地更新。

## 0.1.64 — 2026-09-15

### 改：报错要醒目、重要提示要有标注（界面可读性）

用户原话：「账号切换失败的时候，报错应该明显一点，还有一些重要的注释什么的，也要标注，可以有 emoji」。

1. **失败/成功消息自动变醒目**。新增 `createMsgNode()`：给它的 `textContent` 赋值时按内容自动选样式 ——
   命中「失败 / 错误 / 无法」→ **红框红字**（`.dsw-msg.err`），以「已…」开头 → 绿框，其余保持灰色小字。
   为什么自动判定、而不是每个调用点传 kind：账号库 / 传输层 / 上下文三张卡加起来 40 多个赋值点，
   靠人手传迟早会漏 —— 而漏掉的那个往往正是报错（这次就是"账号切换失败"混在灰字里没人看见）。
2. **去掉用户可见文案里的 markdown 星号**。界面是纯文本，写 `**可完整登录的凭证**` 会**原样显示**出星号
   （你这次截图里就是）。6 处改成 emoji + 纯文本，顺带修掉一条 host 日志里的同类写法；
   并新增 `tests/check-ui-copy.mjs` 把这条规矩做成自动检查（我在这条上栽过不止一次）。
3. **重要标注加 emoji**：徽章 `✅ 当前` / `❔ 未校验` / `⏳ 受限至 X` / `❌ 需要重新登录` /
   `❌ 登录态校验失败` / `⚪ 未登录`；cookie「未记录」、导出备份的凭证风险等关键注释前加 `⚠️`。

测试：新增 `check-ui-copy.mjs`（6 项：星号扫描、自动醒目接线、`.node` 接线、徽章标注、凭证警告）；
`check-bundle` 新增一组产物断言（样式判定、`.node` 接线、emoji 标记，并要求旧的星号形态必须消失）；
`check-cookie-meta` 里那条 cookie 文案断言同步更新（行为未变，只是多了一个 ⚠️ 前缀）。
全量 37/37 用例文件通过。

## 0.1.63 — 2026-09-15

### 修：链式投喂三处「看不见但会让人误判」的缺陷

起因：设置页「上下文」卡的状态行写着"链式投喂正在跑…链上已发 168 段"，
我据此怀疑按钮状态不对（**结论是我看错了图，按钮没问题**），
但顺着这条线翻出三处真缺陷 —— 都属于"没有报错、但会让你和我判断错"的那一类：

1. **`/status` 的字段读错了层级（0.1.62 引入）**。宿主把 `contextMode` / `contextChain`
   放在 `status.config` 里，客户端却写成了 `status.contextMode` ——
   于是"跟着状态轮询刷新"这段**从来没生效过**：面板不重开、不切换模式，
   链的段数就永远停在打开那一刻。现在读 `status.config?.contextMode`。
2. **链状态没按模式过滤**。`/context-mode` 的响应无条件回 `contextChainInfo()`，刚切到
   「每轮全量」时会短暂出现"每轮全量 + 链式投喂正在跑"的自相矛盾组合。现在只在链式模式下回；
   并且**切到全量时立刻丢弃当前链** —— 否则以后切回链式会从一个已经过期的父消息续链，
   模型上下文会错位（这点比界面难看更严重）。
3. **决策原因没有日志（可诊断性）**。0.1.62 里 `decideFeed` 返回的 `reason` 只写在类型注释里、
   没接进 logger ⇒ 链式投喂在生产日志中**完全不可见**，出问题时无法回答
   "这一轮到底发了增量，还是退回全量、因为哪条判据"。现在 webapi 在**决策原因变化时**
   回调一次（避免每轮刷屏），adapter 打一行：

   ```
   deepseek-web: 上下文投喂=链式：本轮只发增量 152 字（历史由服务端维护）
   deepseek-web: 链式投喂退回全量重发（原因=not-appended）
   deepseek-web: 上下文投喂=每轮全量：重发完整 prompt
   ```

测试：`check-context-chain` 10 → 15 项（决策回执四条：首轮原因、原因不变不重复上报、
历史改写后退回、`resetContextChain` 后重新可见）；`check-bundle` 新增一组产物断言
（客户端读取层级、链按模式过滤、切全量清链、回执接线、adapter 日志文案）。
反向验证 8 发 8 中（源码三处 + 产物五处，各自改坏都精确变红）。

## 0.1.62 — 2026-09-14

### 新：上下文投喂方式可切换（设置页「上下文」标签）

起因是用户的两个问题：网页端每条消息都重发一大段提示词、以及"上下文到底有没有带过去"。
查代码后事实是这样：插件一直把 `parent_message_id` 写成 `null`（`webapi.ts`），
**每条消息都是会话里的根消息、没有父链**，服务端按消息树回溯上下文时回溯到空 ——
所以历史只能由我们每轮重发。浏览器不是这么干的：参考实现里
`nextParentMessageId = history?.parentMessageId ?? finalAssistantMessageId`、
`isFirstMessage = parent_message_id === null`，**只有会话第一条的 parent 是 null**。

新增 `contextMode` 设置（设置页「上下文」标签，两个按钮，即时生效 + 落盘）：

- **`full`（默认）**：每轮重发全量 prompt。与 0.1.61 及以前**行为完全一致**，不改变任何既有用户。
- **`chained`**：后续轮只发**增量**，`parent_message_id` 指向上一条回答的 `message_id`
  （取自 SSE 首帧 `event: ready` 的 `response_message_id`，真实样本形如
  `{"request_message_id":1,"response_message_id":2,"model_type":"default"}`）。历史由服务端维护。

代价说清楚：链式投喂下**工具协议只存在于链首那条消息里**，一旦服务端丢掉早期上下文，
模型可能不按 JSON 约定发工具调用。所以判据是"能省则省、一有不确定就退回全量"，
以下任一情形都**重新起链**（发全量 + `parent=null`，只是多花点 token，不会上下文错位）：
新会话 / 会话轮换 / 切号 / 固定头（系统提示+工具目录）变化 / 历史非严格追加（压缩、改写、回退）/
本轮无新增 / 增量超预算 / 上一轮流失败·取消·没拿到 `message_id`。

实现：新增纯逻辑模块 `src/context-feed.ts`（判据 + 设置读写）；`protocol.ts` 拆出
`serializePromptParts()`（交出 `head` + **未截断**的 `entries` + `full`，`serializePrompt` 变为它的包装，
两者逐字节一致）；`webapi.ts` 的 `parent_message_id`/`prompt` 改由决策结果提供，链状态与复用会话同生命周期
（退役/切号/失败即作废）；`adapter.ts` 把 `promptParts` 随请求传下去。

测试：`tests/check-context-feed.mjs`（判据 28 项）、`tests/check-context-chain.mjs`
（接线与生命周期 10 项，假 transport + 假 SSE）、`logic-test.mjs` +3（ready 帧取 `response_message_id`）、
`check-bundle.mjs` +2 组产物断言（四条接线 + 设置可切换）。反向验证 10 发 10 中。

## 0.1.61 — 2026-09-14

### 修：切到失效账号后「API 密钥无效」却毫无提示（三处接线）

反馈：切换到一个一天多没用过的账号后每轮都报「API 密钥无效」（AUTH），切回另一个号就正常；
用户质问"保存好的账号为什么要重新登录、不能用为什么不给提示"。

**机制**：账号库存的是**捕获那一刻的 token 快照**，有效期由服务端控制、本机无法续期，
过期只能重新登录换新。但下面三处接线缺失，让人完全无从判断哪个号还能用：

1. **AUTH 失败不回写账号状态** —— `lastVerifyError` 只由 30 分钟一次的探活写入，
   而探活只扫当前活跃账号；刚切到死号、探活还没轮到它时界面完全静默。
   ⇒ 现在 `recordCallOutcome` 收到 `code === 'AUTH'` 立刻回写 `lastVerifyError`，
   账号库马上出现红标「需要重新登录」。
2. **「未校验」标记永久粘住** —— `unverified` 在"捕获但未校验"时置位，而探活成功只更新
   `lastVerifiedAt`、从不清它。实测账号库 **5/5 全挂「未校验」**，连"最近校验 6 分钟前"
   的那个也挂着 —— 标与数据自相矛盾、信息量归零，真出问题时反而看不出来。
   ⇒ 探活成功时显式写 `unverified: false`（`normalizeRecord` 只保留 `=== true`，标记自然消失）。
3. **切换账号不校验** —— 死号要等下一轮请求才暴露。⇒ 切号前先对目标账号做一次零额度探活
   （只读 `users/current`），失败则**不切换**并返回「该账号登录态校验未通过…请重新登录后再切换」。

测试：check-accounts 新增"`updateAccount` 能清 unverified"用例（22 项）；check-bundle 新增
0.1.61 产物断言（三处接线按调用点写，`unverified: false` 钉在探活 patch 内部）；
反向验证四发四中（探活清标记 / AUTH 回写 / 切号探活 / unverified 归一化语义）。

## 0.1.60 — 2026-09-14

### 修：暂存兜底方向的反面代价 —— 思考被归进正文（F28）

0.1.59 把"无线索暂存"的兜底方向改成一律归正文（F27，防止回答被吞进思考）。
当天实测反例：同一个"孤儿未结算"场景下，方向一改，错法就翻了个面 ——
两条消息的 text 块里塞着**整段 `<analysis>…<summary>…</summary>` 复盘**
（其中一条 27397 字全是复盘、没有一句对用户说的话 —— 模型不会把整条回答写成纯复盘），
用户在界面上看到"思考内容当正文输出"。

**改法**：兜底方向不变（原则仍是"看不到回答比看到思考更糟"），但加一条**标签判据** ——
暂存文本以 `<analysis>` / `<summary>` / `<thinking>` 等思考的标准包装为主体时归思考；
不含标签的孤儿仍按正文收尾（0.1.59 修的场景不受影响）。

**顺带加取证开关**：设环境变量 `DSH_WEB_LOGIN_DUMP_SSE=1`（需重启 DSH 生效），
把原始 SSE 逐行落盘到 `~/.dsh/deepseek-web/frames/`，给通道错位类问题定论用
（统计与日志只能看到结果，只有原始帧能看到服务端到底怎么标的）。

### 修：短回答被误判「句中被截」（F29）

`looksMidSentence` 的判据是"尾部是汉字/字母/数字 ⇒ 被截"，对**完整的短答**
（"我在""在吗"—— 天然以汉字收尾）恒为真，会白打 1~2 次续写请求。
host 日志里整天都有"回答在句中被截且自动续写额度已用尽（尾部："在吗"）"就是它。
现在短于 40 字的回答不再走这条判据；服务端真截断（无 FINISHED）不受影响、仍会续写。

### 修：收尾日志误导 + 续写轮丢弃静默

1. 「回答在句中被截且自动续写额度已用尽」这行打在收尾检查处，**不看用途白名单、
   也不管续写是否真的发生过** —— 标题/压缩这类内部调用（白名单本就拦住、从未续写）也会打，
   排查时会被它骗（实测同一天 8 条，全部是"第 1 轮就结束"）。现在按事实分档：
   内部用途打 info「按约定不自动续写」，真用尽额度才打 warn。
2. 续写轮里工具调用解析失败被丢弃时，原先只记宿主日志 —— 模型和用户都不知道
   "这次调用发生过但没执行"（用户只能在网页端看到乱码）。现在补一行可见提示进正文，
   模型下轮能据此重发。首轮丢弃的整步重试链路不变。

## 0.1.59 — 2026-09-14

### 修：收尾兜底可能把「正文」吞进思考（F27，修订 0.1.57 的兜底方向）

反馈：DSH 里问"在吗？"，回答"在的，YG。有什么需要我做的？"**整段显示在「思考」里、正文空白**
（host 日志：`第 1 轮流结束：[本轮 0 字 / 累计 0 字 / 耗时 1359ms] finish=FINISHED`）。

**排查**：抓 6 轮"在吗？"的真实帧，**6/6 全部正常**（快照都带 `THINK` fragment，
思考 50~286 字 + 正文 11~24 字，从未出现"正文 0 字"）。所以正常路径没问题 ——
这个现象要么是模型这轮把回答写进了思考，要么是 0.1.57 那个**暂存兜底**选了错的方向。

**不管哪种，兜底方向都得改**。0.1.57 的兜底是"开了思考就归思考"，理由是"避免以正文本名
补发思考"。但两种错法的代价不对等：

| 错法 | 后果 |
|---|---|
| 思考被显示到正文 | 内容都在，用户读得出这是思考 |
| **正文被吞进思考** | **用户看不到回答 —— 明确的功能故障** |

**改法**：

1. `finish()` 的暂存兜底改为**一律归正文**（无线索时，宁可思考上屏也不让回答消失）；
2. 把 `response/fragments/-1/elapsed_secs`（真实帧里紧跟 THINK fragment、值=思考耗时）
   作为**"刚结束的是一段思考"的直接证据** —— 快照丢失时靠它把暂存认回思考通道，
   所以 0.1.57 修好的那个场景不受影响；
3. host 日志新增诊断：本轮正文 0 字时点名（`⚠️ 本轮正文 0 字 —— 内容可能全在思考通道`），
   下次一眼可判。

### 测试
- `logic-test.mjs` 55 → **57 项**（新增 2 条 + 修订 1 条语义）
- 反向验证 **2/2**（源码）；F25 的真实帧实验 6 个变体仍全绿（改动没有让 F25 回归）
- 产物断言 +1；全量 **34/34** 个用例文件通过

## 0.1.58 — 2026-09-14

### 修：会话标题变成重复垃圾（F26）

侧栏里的会话标题长这样：

```
在吗在吗在吗
AI助手的记忆功能AI助手的记忆功能AI助手的记忆功能
安装 archify skills安装 archify skills安装 archify skills
TCP 三次握手原因解析TCP 三次握手原因解析TCP 三次握手原因
```

实测 **13 个会话里 11 个中招**，而且清一色是 `deepseek-web` 生成的
（两个走 fallback 的标题是正常的）。

**根因**：自动续写（本是为"回答在句中被截"设计的）**没有区分调用用途**。
标题天然**以汉字结尾**（"…原因解析"的"析"），而 `looksMidSentence` 的判据正是
"尾部是汉字/字母/数字 → 大概率被截" ⇒ **对标题恒为真** ⇒ 每轮都被判成"句中被截" ⇒
适配器自动发起续写、要求模型"接着写" ⇒ 模型把标题**重复一遍** —— 每轮一次，
直到续写额度（默认 2 轮）用尽。host 日志里能直接看到这个三段式：

```
第 1 轮流结束：[本轮 12 字 / 累计 12 字] finish=FINISHED，尾部是句中
回答疑似在句中被截，自动续写（第 1/2 轮）……
第 2 轮 …（第 2/2 轮）……
第 3 轮 … 自动续写额度已用尽，按正常完成上报（尾部："TCP 三次握手原因解析"×3）
```

**附带代价**：每次标题生成多发 1~2 个请求（多消耗额度、也抬高请求密度）——
按这 11 个会话算，白发了约 22 个请求。

**修法**：新增 `allowsAutoContinue(purpose)` 白名单，**只有 `chat`（或未指定用途）才续写**；
`session-title` / `compaction` 这类内部调用不再续写，标题回到"只生成一次"。

### 测试
- `check-auto-continue.mjs` 23 → **27 项**，含一条**自证断言**（确认标题确实满足
  "句中被截"的判据 —— 否则这条用例可能没测到点子上）
- 反向验证 **3/3**（源码：去掉白名单 / 放宽松 / 收过紧）+ **2/2**（产物）
- 产物断言新增 1 条（按调用点匹配：`eligible` 里必须真的带上用途白名单）
- 全量 **34/34** 个用例文件通过

## 0.1.57 — 2026-09-14

### 修：首帧快照丢失时整段思考上屏（F25，用真实帧复现并修掉）

现象：新建会话后第一条回答里，**整段思考被当正文发出去**（实测一轮 2062 字符）。
09-13 修过一次（F24），但那次修的是 `response/thinking_content` 那条路径 ——
**抓真实帧后发现服务端根本不发这个事件**，所以那次改动对线上没有效果。

**真实帧**（2026-09-14 抓包，连续 4 轮完全同构）：

```
快照(fragments=[{type:"THINK", content:…}])   ← 思考的归属只靠这一帧
-1/content → 380× 裸续段                       ← 思考
response/fragments APPEND [{type:"RESPONSE"}]  ← 正文从这里开始
-1/content → 110× 裸续段                       ← 正文
```

也就是说，**思考完全依赖「首帧快照里的 THINK fragment」**。一旦那份快照没能进入状态机
（整帧丢失，或服务端先发了 `fragments: []` 的快照），`fragments` 就一直是空的，
而旧实现在「无 fragment 可续」的分支里**无条件当正文发射** ⇒ 整段思考上屏。
同一个根因还解释了「正文块开头缺几个字」（缺掉的正是随快照丢掉的片段）。

**验证方式**：把抓到的真实帧里的快照帧删掉再回放 —— 修复前 `thinking=0 / text=818`
（思考 661 字全在 text 里），修复后 `thinking=657 / text=161`。三处反向验证
（删快照 / 快照 fragments 清空 / 只丢快照）修复前全部复现、修复后全部归位。

**修法**（`createSseState({ thinkingEnabled })`）：

1. 请求开了思考、却还没有任何 fragment 可续时，文本先进**暂存**，不再直接当正文发射；
2. 一旦出现 fragment（快照或 APPEND），按它结算暂存 —— 真实帧证明「第一个 RESPONSE
   fragment 之前的内容必是思考」，所以这段归思考；
3. 流结束时仍没等到 fragment（被中止/掐断）→ 开了思考就按思考收尾，不静默丢字；
4. **未开思考时行为完全不变**（没有歧义，仍即时发射，快速模式不受影响）。

### 测试
- `logic-test.mjs` 50 → **55 项**（4 条 F25 用例 + 1 条顺序断言，含「暂存确实生效」的自证）
- 反向验证 **6/6** 处精确命中；其中一处（结算点从 APPEND 挪到 finish）**只靠内容断言看不出来**
  —— 是「思考必须先于正文到达」这条顺序断言把它逼出来的。
- 产物断言新增 1 条（按调用点匹配，验证生产链路真的把思考开关传进了状态机）。

## 0.1.56 — 2026-09-14

### 修：退出时泄漏网页端会话（每次运行必留一个，实测堆了几十个）

**现象**：DeepSeek 网页端侧栏堆出一批标题 = DSH 会话主题的对话（如「SSH插件开发讨论」
「彻底删除会话插件」「在吗」）。

**证据**：
- 残留标题与 `~/.dsh/sessions/<id>/` 里的 `session/title` 记录**一一对应** ⇒ 确认是本插件建的；
- 启动次数与残留量级相符：09-11 = 40 次、09-12 = 33、09-13 = 20、09-14 = 5；
- 残留**分散在多个账号**上（09-12 那天用了 5 个账号），网页端只显示当前登录账号的会话，
  所以肉眼看到的还只是其中一份。

**根因**：复用槽（`reuseSlot`）与待删队列都只活在进程内存里，而卸载时的 teardown 只关登录窗口 ——
进程一退出（尤其被强杀），槽里那个会话与队列里排着的会话全部静默丢失，**永远不会被删**。
由于会话是 20 轮复用、槽位始终有一个"在用"会话，所以**每次运行至少留一个**。

**修法**（三块，缺一不可）：

1. **退出收尾**：teardown 新增 `disposeSessionReuse()` —— 把槽里的会话**交回它自己的清理回调**
   （排队待删），再 `flush()` 尽力清空队列。此前只清槽不排队，等于白丢。
2. **「欠删除」落盘**：新增 `src/session-journal.ts`，把"还欠一次删除"的会话按账号记到
   `~/.dsh/web-login/sessions-in-use.json`（进槽记一条、进队列记一条、**确认删掉才销账**）。
3. **启动补删**：下次启动读这份记录，把上次遗留的会话按账号排进清理器。
   进程还活着的（多实例共用 DSH_HOME）、账号已被移除的、以及 `keep`/`deleteWebSessions: false`
   这几种情况都**不动**；账号没了的记录直接丢弃（没凭证，留着也删不掉）。

删除回执才有销账：`deleteOne` / 批量删现在都返回"服务端是否真的接受"（不再只看 `resp.ok`，
而是同时检查 HTTP 200 上裹的业务错误信封），**删失败就留着记录，下次启动再补**。

### 修：清理设置会被设置页的下一次保存冲掉

`sessionCleanup` / `cleanupBatch` / `cleanupDelayMs` / `cleanupGapMs` 这几个字段
**从没被初始化进请求闸门**，而设置页保存时写的是 `gate.settings()` 的返回值 ——
于是用户只是调了下「请求间隔」，清理设置就被从 `gate.json` 里**静默抹掉**，
重启后回到内置默认（用户视角：「我明明拖过滑块，过两天又变回去了」）。
现在这几个字段随闸门一起创建、一起落盘（`createRequestGate` 新增对应选项）。

### 测试

- 新增 `tests/check-session-journal.mjs`（**18 项**）：落盘往返与容错、扫尾决策的四种分支、
  「删除回执没来之前不销账」、事件链（`queued` / `deleted` / `leased`）、
  退出收尾确实把槽里的会话交了出去。
- `tests/check-request-gate.mjs` +1：清理设置必须随闸门落盘（改间隔不能把它抹掉）。
- **反向验证 8 处**：每处实现分别改坏 → 恰好红掉对应断言（含"多进程共享 DSH_HOME 时不乱删"
  与"删失败也要留着记录"两条容易写假的地方）。

### 仍然存在的边界（写清楚，不假装没有）

强杀时**队列里排着的那批**仍会随进程丢失（退出时的 `flush()` 只是尽力而为）；
但它们的记录还在 `sessions-in-use.json` 里，**下次启动会补删**。
真删不掉（例如账号已从账号库里移除）的会话，插件无能为力。

内置默认值**未变**（清理延迟仍是 1~2 分钟、批量 6~10 个）；要放慢/加快在设置页调区间即可
（延迟允许 5 秒 ~ 10 分钟）。

## 0.1.55 — 2026-09-13

### 修：思考内容被当成正文上屏（真实会话 7/268 条中招）

**现象**：跑 `deepseek-reasoner` 时偶发**整段思考直接显示成回答内容**（用户看到大段英文内心
独白，如 `me analyze the situation. The user wants to…`）。一次真实会话（268 条 assistant
消息）里 **7 条**中招，最长的一段 **14877 字符**。

**根因**（`src/webapi.ts`）：思考阶段服务端是**分两步**下发的 —— 先 `response/thinking_content`
发开头一小段（建立当前通道 `sink = 'thinking'`），接着用 `response/fragments/-1/content`
发**思考的其余全部**。而这条路径走的 `appendToLastFragment()` 在 `fragments` 为空时无条件
"当正文发射"，**完全没有使用 `sink`** —— 于是整段思考进了正文通道。

旁证：这些上屏的正文块**开头都缺 2~4 个字符**（日志原文是 `" me analyze the situation…"`，
本该是 `"Let me analyze the situation…"`）—— 缺掉的正是先走 `thinking_content` 的那一小段。
两处现象由同一个分支同时解释。

**修法**（两处，缺一不可）：
1. `appendToLastFragment()` 在 `fragments` 为空时改为**按 `sink` 归属**；`sink` 未建立时
   **保持旧行为**（当正文）—— 服务端也可能首帧就发 `-1/content`，那种情况没有通道信息可用，
   当正文是唯一能避免丢字的兜底。
2. `case` 分支里**只有真的续到 fragment 上**才把 `sink` 切成 `'fragments'`；否则紧接着的
   裸续段会又退回正文，等于没修。

**验证**：`tests/logic-test.mjs` 新增 4 条（核心 1 条 + 防回归 3 条），**46 → 50 项全过**；
两处修法**分别**回退，都精确地只让那 1 条变红（说明两处都必要）；离线回放 6 组候选帧序列，
修复前复刻出与线上日志**逐字符同构**的形态（`thinking="Let"` / `text=" me analyze…"`），
修复后整段回到思考通道。

（同一会话里还出现过 4 次 `user is muted` 账号限流，但**没有证据**表明两者相关 ——
限流只影响稳定性。）

## 0.1.54 — 2026-09-13

### 修：CI / Release 被 `setup-node` 的 npm 缓存卡死（0.1.53 因此没能发布）

**现象**：v0.1.53 的 CI 与 Release **全部失败**，三个平台都一样，且都停在同一步 ——
`actions/setup-node@v4`，连"装依赖"都没轮到。

**原因**：审计 F20 我给 CI 固定了 Node 小版本，顺手加了 npm 缓存开关。
但 `setup-node` 的 npm 缓存**要求仓库里有 `package-lock.json`**，没有就报
`Dependencies lock file is not found` 并让整个 job 失败 —— 而锁文件恰好还没生成
（本机 registry 慢到每个 packument 要 5 分钟，跑不完完整依赖树）。

**修法**：两个工作流都去掉缓存开关，并保留注释说明"锁文件就绪后再打开"。

**顺带加了一条自相矛盾的守卫**（`check-round2`）：没有 `package-lock.json` 时，
`ci.yml` / `release.yml` 都不许出现真的 npm 缓存键 —— 这条断言能直接拦住这次的错误。
反向验证有个细节值得记：正则必须只认 **YAML 键**（行首缩进后的那一段），
否则注释里那句"不能开 npm 缓存"会把断言喂饱而假红。**同一类坑今天踩了两次**
（上午是注释里的 `npx` 字面量），两处都已按"断言只认调用点／键形态"修正。

**本版无行为改动**：源码与 0.1.53 完全一致，只有版本号与两个工作流文件；
`lib/` 因为版本号会被内联进产物所以重新构建过。

## 0.1.53 — 2026-09-13

### 第二批收尾三条：F10（建连无限等待）、F08（登录轮询重叠）、F20（构建/平台契约）

**F10（高）建连阶段限时 + 「创建过的会话」全部归还**

先核对发现：N04 重写 `streamWebCompletion` 时已经落了审计要求的三件事（建立阶段 45 秒限时、
只在等 `next()` 期间计 idle、失败即退役、放行结构化 `AdapterLlmError`），
但**这两条路径一条断言都没有** —— 所以本轮先补齐缺口，另外补了两处真正的收口：

- 建连期限抽成可注入的 `connectTimeoutMs`（默认仍是 45 秒）。原来硬编码，
  没法离线验证「挂住必须被中断」。
- **`wait()` 也包住 `openCompletion`**：建连期限靠 `abort` 生效，而 `abort` 只对
  「肯配合 signal 的传输」立即生效。包一层之后，即使底层 promise 永远不结算，
  等待也会在 abort 的瞬间结束 —— 否则「限时」形同虚设，会一直挂在 `await` 上。
- **外层记录本次调用创建过的全部会话**（`owned` 集合 + 收尾遍历）：超时/取消会
  *放弃*进行中的 `openCompletion`，它之后才返回的会话必须有人认领。
  收尾之后才建出来的（`finalized` 分支）立即归还。

**F08（高）登录轮询：串行、至多提交一次、关窗后不写回**

旧写法是 `setInterval(() => void (async () => {…})())`：

- 一轮超过 2 秒时会有**多轮同时在跑**（校验是网络请求，很容易超）；
- 没有"完成"守卫，也没有 `catch`（写盘失败＝未处理拒绝）；
- 落库动作没有串行保护 →「添加新账号」模式会被**消费两次**，
  第二次退化成普通切换（把你正在用的号顶掉）；
- 窗口关闭只 `clearInterval`，拦不住**已经在 `await` 里**的那一轮 → 关窗后照样写回。

现在抽成 `startCapturePoll`（可离线验证），三条不变量都在里面：
串行（上一轮跑完才排下一轮）、至多提交一次（`committed` 先占位再提交，
即便 commit 自身抛错也不重试，但会报给 UI 和日志）、停止后丢弃迟到的校验结果；
校验另加 15 秒超时（旧写法一次挂住的校验会一直占着这一轮）。

顺带：`commitCapturedAuth` 的 add 分支改成 `try/finally` 消费添加模式 ——
旧写法把 `endAddAccount()` 放在 `upsertAccount` 之后，落库抛错时模式会一直挂着，
与模块注释承诺的"只消费一次"相反。

**F20（中）构建/依赖与平台契约**

- **`scripts/build.mjs` 取代 Bash 入口**：Windows 上只有 Node/npm、没有 Bash 时
  `npm run build` 会直接失败。现在 `npm run build` = `node scripts/build.mjs`，
  用当前 Node 执行本地 tsdown 的 CLI（不经过 shell）。`scripts/build.sh` 保留为薄包装。
- **不再用 npx 兜底**：缺依赖时会联网下载，断网就构建不了；版本还是范围，
  同一份源码在不同时间可能解析到不同的依赖树。现在缺依赖就明确报错并提示 `npm ci`。
- **依赖固定精确版本**（`@types/node` 24.13.3 / `tsdown` 0.22.14 / `typescript` 5.9.3，
  均已核验 registry 可解析），并声明 `engines.node = ^22.18.0 || >=24.11.0`
  （跑 `.ts` 源码与 tsdown 0.22.14 的共同下限）。顺手删掉了没人用、且缺本地依赖必失败的
  `build:client` 脚本。
- **`scripts/test-offline.mjs` + `scripts/test-files.mjs`**：按文件名扫全量离线用例
  （`tests/check-*.mjs` + `logic-test.mjs`），新增用例自动纳入；
  明确排除 `probe-*.mjs`（那几个会打真实接口、需要有效账号）。
- **CI 改为三平台矩阵**（ubuntu / windows / macos），固定 Node 小版本（`24.21.0`，
  因为 tsdown 要求 `>=24.11.0`，写 `24` 可能装到构建不了的早期版本），
  跑「装依赖 → 构建 → 全量离线用例 → 产物核对」；release 也走同一套工具链。

**遗留（明确未做）**：`package-lock.json` 尚未生成 —— 本机对 registry 的访问
慢到每个 packument 要 5 分钟左右，完整依赖树跑不完。CI 因此暂时用
`node scripts/install-deps.mjs`（内部按有无锁文件选 `npm ci` / `npm install`，
回退时会打印警告）。生成命令：`npm install --package-lock-only`。

### 测试

`check-round2.mjs` 38 → **53 项**（F10 ×3、F08 ×6、F20 ×6）。
反向验证 F10 3 处、F08 5 处、F20 6 处（其中 4 处一次批量改坏，另 1 处此前真实变红过）。

两处「改坏后仍然绿」的发现值得记下：

1. **同一个清理动作在两个层级各有一份**（`openCompletion` 的失败分支 / 生成器收尾遍历；
   `tracked` 的迟到分支 / `leaseSession` 的取消分支），互相兜底 ——
   反向验证必须**两层一起改**才会红，测试注释已写明。
2. 建连超时的测试夹具需要**留一个 ref 的句柄**占住事件循环：
   `arm()` 的超时定时器是 `unref()` 的（刻意不为了超时吊住进程），
   夹具里没有其它 ref 句柄时 Node 会直接退出，表现为 "unsettled top-level await"，
   看起来像实现挂了（真实运行环境里 DSH 自己就有活的事件循环，所以 unref 是对的）。

## 0.1.52 — 2026-09-13

### 老账三条：F22（写盘失败不释放）、F16（请求体边界）、F15（CDP 未结算）

**F22（中）另存为失败要 abort**

`createWritable()` 成功之后，`write`/`close` 抛错时旧实现直接返回 failed、**没有 `abort`** ——
Chromium 会留下未提交的临时文件与句柄（模拟磁盘写满时实测 `abort` 一次都没被调用）。
现在留住 writable 引用、失败即 abort；成功路径走完清掉引用（不对已关闭的 writable 再动手）。

**F16（中）请求体：生命周期、超时、结构化错误 + 路径导入的边界**

`readJsonBody` 三处：

- 旧实现只监听 `data`/`end`/`error` —— 客户端只 `close`/`aborted`（不发 `end`）时 **Promise 永不结算**，
  监听器一起挂着。现在 `close`/`aborted` 也算结束，并且每种结局都清监听。
- 没有应用层 deadline：一个慢连接可以永远占着。现在 10 秒。
- 超限旧实现是 `destroy()` 后 `resolve(undefined)`，调用方只能报"缺少 payload"，客户端更可能只看到断连。
  现在抛带状态码的 `BodyError`，handler 统一回 413/400/408，并把 `shouldKeepAlive` 置 false。

**关于路径导入，这里没有按审计建议删掉它**：客户端在**优先用** path 路线，理由是
"明文凭证不进 HTTP"（`/accounts/export-json` 那段也确认过同样的取舍）。删掉会让凭证回到渲染进程 ——
那比审计担心的"渲染进程可让宿主读任意文件"更严重。所以**保留 path、自己加边界**：
只接受**普通文件**（挡掉目录 / FIFO / 设备这类会阻塞或异常的东西），并限定大小。
上限取 **2 MiB**：实测单个账号 1.1–1.8 KB、账号数上限 500 → ≈850 KB，2 MiB 留 2 倍余量
（审计建议的 120 KiB 会挡住正常备份）。前端同样检查一道是为了不白传。
更彻底的做法是"宿主批准的一次性句柄/令牌"，需要新的宿主 API，本版没做（代码里留了说明）。

**F15（中）CDP：协议错误与连接关闭都要结算**

- `{id, error:{…}}` 旧实现把 `message.result`（undefined）当成功 resolve → 调用方拿着 undefined
  继续跑、真正的错误信息全丢。现在 reject。
  （与 `Runtime.evaluate` 的 `exceptionDetails` 区分：那是**执行结果**，由调用方检查。）
- 连接 `close` 旧实现不清 pending → 每个在途命令各自等到超时；建连阶段也不监听 `close`。
  现在连接关闭立刻拒绝全部在途命令并清定时器；建连失败/超时主动收掉 socket
  （不再留下"晚到的 open"造成的孤立连接）。
- `send` 同步抛错时也不再留一个永远不结算的 pending。
- HTTP 探测（`/json/version`、`/json/list`）收口成统一 helper：**每次请求各自 2 秒超时**
  （旧写法只有外层循环的 deadline，一次请求挂住就再也回不到循环条件）；轮询开头检查 `signal`，
  并从 `browserLogin` 一路传入。
- 页面筛选改成 `new URL(url).origin === DS_BASE` **严格相等**：`includes('deepseek.com')`
  会命中 `chat.deepseek.com.evil.example` 这类域名。

### 测试

- `check-round2.mjs` 30 → **38 项**：F22 一条、F16 三条（只 close 也结算 / 超限 413 / 正常解析）、
  F15 四条（协议错误 reject / 关连接立刻结算 / send 抛错不留 pending / origin 严格比较）。
  为可测性导出 `readJsonBody`、`BodyError`、`CdpClient`、`isDeepSeekPage`（与 `checkedWasmUrl` 同类做法）。
- 反向验证 **6 处全红**，复原后全绿。
- 33 个测试文件全绿。

### 未处理

F20（构建脚本的平台依赖）、F10（建流缺整体期限）、F08（登录轮询的 in-flight/代际约束）。

## 0.1.51 — 2026-09-13

### 老账四条：F06（图片缓存跨账号）、F19（台账口径）、F21（迁移留明文）、F23（诊断落原文）

**F06（高）图片上传缓存：按账号隔离 + 真的淘汰**

缓存是 `attachmentId → fileId`，两个独立问题：

- **没有账号维度**：`fileId` 是**归属某个账号**的服务端对象。切号之后旧缓存还在，
  会把上一个账号的 `fileId` 复用出去。（服务端是否接受是它的事 —— 不能据此断言"跨账号能读到图"，
  但"把我们这边两个号的引用串了"本身就已经是错的。）
- **TTL ≠ 淘汰**：只检查"被查中的那一项"是否过期；一直换新图、不换旧 key 时，旧项永久滞留。

缓存逻辑抽成 `ImageUploadCache`（**导出以便单测** —— 图片上传要过真实 PoW，端到端测不了）：
切号整批清空；每次使用前清掉**所有**过期项；条数封顶（默认 256）；
`set` 带作用域校验，防"上传 await 期间账号被切走"造成的串号。
另外把「取消」从"降级为纯文本继续跑"改成**照常传播**。

**F19（中）台账：hours 取整 + 间隔口径**

`?hours=1.5` 直接 `RangeError`（路由只 clamp 没取整，`new Array(1.5)` 抛错）。
现在先 `Number.isFinite` 判断、再 `Math.floor` 并夹到 1–72。

间隔口径修正（原来两处都不对）：`at` 是**结束**时刻，所以"这次等了多久" = `本次开始 − 上次结束`；
直接拿相邻 `at` 相减，会把上一轮的生成耗时算进"等待"里。另外**失败的调用也要计入**
（失败同样占用了等待窗口），并按**账号分组**（两个号的节奏互不相干，混在一起只会把分布拉平）。

**F21（中）迁移不再留明文副本**

旧版把凭证文件 `rename` 成 `.migrated-<时间戳>` **留档** —— 那是明文、可登录的凭证，
于是"退出登录"删掉账号库记录之后它还在磁盘上照样能用，"已登出"就成了谎话。
现在**确认新记录落盘后删掉源文件**；写入校验失败会抛错，`migrateLegacyAuthIfNeeded` 记下原因、
启动时写进日志（`legacyMigrationError()`），不再静默。
**选择删源文件而不是留档**：误删的保护交给账号库的导出备份 —— 与 `removeAccount` 已有策略一致。

**F23（中）丢弃载荷默认只记元信息**

模型吐坏的工具调用参数，里面完全可能带命令里的 token、文件内容、个人信息。以前默认把整段原文写进
`~/.dsh/deepseek-web/rejected.jsonl`，而那个路径**硬编码 homedir、无视 `DSH_HOME`**
（我们自己的测试就被它坑过：写到了真实用户目录）。
现在只记「时间 / 模式 / 原因 / 长度 / sha256」，写在 `<DSH_HOME>/web-login/diagnostics/rejected-meta.jsonl`，
目录 0700、文件 0600、上限 4 MB。要采集完整内容应另做"用户显式开启 + 有效期 + 清理策略"的独立诊断，
不能默认打开（本版没做）。⚠️ 摘要挡不住低熵内容被猜出来 —— 它只是"不存原文"，不是"内容不可还原"。

### 测试

- `check-round2.mjs` 25 → **30 项**：F06 三条（按账号隔离 / 淘汰与封顶 / await 期间切号拒绝写入）、
  F19 一条（小数、负数、0、999、±Infinity、NaN 都不抛错）、F23 一条（只记元信息 + 写在 DSH_HOME 下）。
- `check-accounts.mjs` 20 → **21 项**：F21 一条（迁移写入失败时必须留下原因，且**不能删**旧凭证）。
- 两条既有断言写的是**旧行为**，按新行为改了期望（不是放松实现）：
  「旧文件改名留档」→「旧文件被删除、无任何明文副本」；
  「间隔只统计 chat 成功调用」→「含失败调用 + 按结束时刻算等待」（`samples` 1→2，`min` 30_000→19_800）。
- 反向验证 **9 处全红**（F06 三处、F19 两处、F21 两处、F23 两处），复原后全绿。
- 33 个测试文件全绿。

### 未处理

F08 / F10 / F15 / F16 / F20 / F22。

## 0.1.50 — 2026-09-13

### 第一轮审计 F04（第二轮复核：**声称修了但生产身份链未接通**）：user.id 没进去重键

库里是**两级去重**：先按 `serverId` 匹配同一个账号，再按 `token` 匹配。但真实登录路径
（浏览器捕获 / 分区恢复 / 手动 token）拿到的 `user.id` **只被塞进 `user` 字段**、
**从来没写进 `serverId`** —— 于是 token 一刷新，第一级去重就失效，同一个号在库里堆成好几条。
既有测试是**手工传 `serverId`** 才通过的：那条链在生产上根本没接上，测试把它绕过去了。

**身份归一**（`auth.ts` 新增两个 helper）：

- `withVerifiedIdentity(auth, user)` —— 凭证**落库前**用：带上 `serverId: user.id`、清 `unverified`；
- `refreshVerifiedIdentity(id, token, user)` —— 记录**已在库里**时用（`/status` 迟到校验、探活）：
  记录不存在或 token 已变 → 什么都不做，**绝不新建、绝不切号**（与 F05/N02 同一条纪律）。

接入点共五处：浏览器窗口登录、分区恢复、手动粘贴 token、`/status`（与 N02 同一处代码，顺带补 serverId）、
探活成功分支。

**兼容旧记录**：`serverId` 是后加的字段，老库里可能只有 `user.id`。去重时加一层
「只认**没有 serverId**、且 `user.id` 相同」的匹配 —— 否则老用户重登一次就会多出一条。
（备份文件自报的 id 仍然不参与授权，那条路径由 N01 的 `importAccounts` 单独把关。）

### 测试

- `check-round2.mjs` 22 → **25 项**：三条 F04 用例 —— 同账号 token 刷新后重登库里仍只有一条
  （且 token 已更新）、旧记录（只有 `user.id`）能被认出来、`/status` 的迟到校验也要落 `serverId`。
  输入用的是**真实登录形状**（而不是手工塞 `serverId`），正是原来被绕过的那条链。
- `check-bundle.mjs` 新增一条产物断言（三个调用点特征）。
- 反向验证 **3 处全红**：`withVerifiedIdentity` 不写 serverId / 去重不兼容旧记录 /
  `refreshVerifiedIdentity` 不写 serverId；复原后全绿。
- 33 个测试文件全绿。

### 未处理

旧项 F06 / F08 / F10 / F15 / F16 / F19 / F20 / F21 / F22 / F23。

## 0.1.49 — 2026-09-13

### 第二轮审计第五批：N02（迟到的 /status 校验把当前账号切回去）

`GET /status` 会顺带做一次登录态校验，返回后用 `writeAuth({ ...auth, user: check.user })`
补全账号的展示信息。问题在于 **`writeAuth` 的语义是「写入并设为当前账号」**，
而这个校验请求是异步的（超时 15s），等待期间用户完全可能：

- **切到另一个账号** → 迟到的结果把当前账号**切回去**（"我明明切了 B，面板又跳回 A"）；
- **把该账号删掉** → `writeAuth` 内部 upsert，把已删除的凭证**复活**。

刷新元信息不该有这两个副作用。现在只在「仍存在、且 token 匹配」的记录上更新元数据：

```ts
const target = listAccounts().find((item) => item.token === auth.token)
if (target) {
  updateAccount(target.id, {
    user: { ...target.user, ...check.user },
    unverified: undefined,
    lastVerifiedAt: new Date().toISOString(),
  })
}
```

顺带记录 `lastVerifiedAt`、并清掉 `unverified` 标记（`normalizeRecord` 只在
`unverified === true` 时才保留该字段，所以传 `undefined` 等于清除）。
探活模块 `probe.ts` 早就是「按 target 更新、不切号」的写法 —— 这次是让 `/status` 这条路径与它一致。

**关于「整块替换」**：审计给的是完整的 `apply()`（786 行）。我先把它与当前实现**逐行 diff**，
发现**只有这一处差异（+3/−1）**，于是只改这一处 —— 等价，但把引入意外变化的风险降到最低。

### 测试

- `check-round2.mjs` 20 → **22 项**：两条 N02 用例，都通过真实 `apply()` 注册 `/status` handler，
  再用注入的 fetch 把校验请求**悬挂住**，然后分别「切到 B」「删掉 A」，最后释放响应。
  含三处自证：拿到了 handler、校验请求确实发出并挂起、元信息确实被刷新（证明这条路径真的走到了）。
- `check-bundle.mjs` 新增一条产物断言。注意断言的写法：`item.token === auth.token` 这类比较
  在产物里有 **3 处**（`upsertAccount` 内部也有），只拿它做断言会被库内部代码骗过；
  `unverified: void 0` 只出现在**这一个调用点**（探活模块用的是 `lastVerifyError`）。
- 反向验证：恢复成 `writeAuth({ ...auth, user: check.user })`（命中数强制 = 1）→ 两条断言变红，复原后绿。
- 33 个测试文件全绿。

### 未处理

F04（`serverId` 的生产身份链是断的），以及旧项 F06 / F08 / F10 / F15 / F16 / F19 / F20 / F21 / F22 / F23。

## 0.1.48 — 2026-09-13

### 第二轮审计第四批：N05（失效 WASM 地址阻断 discovery 恢复）

**N05（高）资源下载收口到统一实现；失效时连「已解析的地址」一起清**

`resolveWasmUrl` 命中 key 就直接返回缓存地址，而 `loadWasmModule` 的 rejection 只清
`wasmModuleCache`、**没清 `resolvedWasmUrl`**。于是「保留了 discovery 能力」并不等于
「失效后真的会再进 discovery」：地址已经 404 了，请求还会一直对着它打 ——
唯一的兜底（页面发现）永远走不到。

- 新增 `readOfficialResource(url, max, signal)`，把三处下载收口成一个实现：
  **只走官方 HTTPS 域**（`deepseek.com` / `*.deepseek.com`，无凭据、标准端口）；
  **`redirect: 'error'` 拒绝全部重定向**；**分块累计字节上限**（首页 2 MiB / 脚本 8 MiB /
  WASM `MAX_WASM_BYTES`），超限抛错并 `reader.cancel()`，不再先读完 `arrayBuffer()` 再检查大小；
  独立超时（下载 15s、探测 10s）。
- `loadWasmModule` 的失败回调现在**同时清编译缓存与已解析地址**；`isReachable` 也先过白名单。

**关于「拒绝重定向」的可用性代价 —— 已实测（不只静态推理）**

直接跟随重定向会被当成"任意跳转都放行"，所以这里选择拒绝。代价是若官方某天需要 CDN 跳转，
就会拒掉合法请求。**用真实资源实测过（不发任何账号请求）**：

| 检查项 | 结果 |
| --- | --- |
| 默认 WASM 地址（`fe-static.deepseek.com`…） | HTTP 206（range 探测）、**无重定向** |
| 完整下载 | 200、`redirected: false`、26612 字节、魔数 `00 61 73 6d` |
| `WebAssembly.compile` | 通过 |
| `resolveWasmUrl` 解析耗时 | 257ms（命中默认地址，未进 discovery） |

结论：**当前部署完全满足「无跳转」约束** —— 默认地址与首页（discovery 起点）都无重定向。

**本节初稿有一处描述已更正（2026-09-13 当日内）**：初稿写「首页在不带浏览器 UA 时返回 429」，
那是把**一次偶发限流**当成了「UA 相关」的稳定行为 —— 典型的「一次观测当结论」。
随后用 Node 默认 UA（也就是 `activeFetch` 的真实行为）连测**两次都是 HTTP 200 / 无重定向**，
带浏览器 UA 也是 200 → 结论是**与 UA 无关**，不需要给 discovery 补 UA。
（那次 429 出现在短时间内连续发多个探测请求之后，属临时限流，不是稳定特征。）

### 测试

- `check-round2.mjs` 18 → **20 项**：两条 N05 用例（下载 404 / 编译失败），走真实 `createPowHeader`
  链路 + 注入 fetch，并用 `range` 头区分「探测」与「下载」。断言链含三处自证：
  第一轮必须真的失败、探测与下载都真的发生过、第一轮探测通过（说明地址确实进了缓存）。
- `check-bundle.mjs` 新增两条产物断言（下载统一入口 + 限字节；失效时清地址缓存）。
- 反向验证：只移除 `if (resolvedWasmUrl?.url === url) resolvedWasmUrl = null` 一句
  （命中数强制 = 1）→ 两条新断言变红，而 `check-sse-wasm` **仍全绿** ——
  这是覆盖空洞，不是"原用例没用"。复原后全绿。
- 33 个测试文件全绿。

### 未处理

N02（迟到的 `/status` 校验把当前账号切回去）、F04（`serverId` 的生产身份链是断的）。

## 0.1.47 — 2026-09-13

### 第二轮审计第三批：N03（tool_result 跨流残片泄漏）+ N06（续写漏记 usage）

这两条改的是**同一处 `streamImpl`**，按审计要求用组合后的代码块**一次应用** ——
分两次打补丁会互相覆盖。

**N03（高）伪系统标记的剥离改成「有状态」流式过滤器**

旧写法对正文每一包调用**无状态**的 `stripSystemMarkers(guarded.text)`。
完整字符串上的跨行正则正确，**不代表跨 push 有效**：开始标签、正文、结束标签落在
不同的 push 里就失去共同上下文。用真实 createAdapter 流链实测：

| 送入方式 | 结果 |
| --- | --- |
| 整段一次 | 能剥 |
| 只有开标签（未闭合） | 能剥 |
| **逐字符** | **泄漏 —— 正文里出现完整的 `<tool_result>…</tool_result>` 及其内容** |

新增 `SystemMarkerStreamFilter`，跨 push 维持「正在捕获的标签 / 围栏状态 / 尾部缓冲」；
流内与**轮末残余**（`drainTextPipeline(..., false)` 之后）都交给它。
围栏代码块内的示例仍然保留（那是给人看的，不剥）。

顺带在反向验证时看清一个事实：真实流链上**一包送入也会泄漏** —— 因为 `echoGuard`
会先把整段扣住，残余到**轮末**才放行，而轮末那句 drain 原本不做标记剥离。
所以「流内 + 轮末」两处**都要**换成有状态过滤器，只改一处仍然漏。

**N06（中）逐轮记账服务端真实 token**

旧写法整次调用二选一：`reportedTokens > 0 ? max(0, reportedTokens - 输出估算) : estimateTokens(prompt)`。
只要**任何一轮**上报过 `totalTokens`，其它轮次的输入成本就从账本里消失 ——
审计复现：第一轮上报 100、第二轮不上报，总量恰好还是 100。

现在按轮记账（`usageRounds`）：有上报的轮次用真值并减掉**该轮**的输出估算，
没上报的轮次仍按字符估算；两轮都上报时总量精确等于上报值之和。

**SystemMarkerStreamFilter 的「安全前缀」（自查发现，非审计条目）**

逐行过滤在没有换行时会一直缓冲到轮末 —— 实测一段 60 字符、全程无换行的文本
**一个字都不上屏**，直到 flush 才整段吐出；前面若有 200 字符无换行，首字要等到第 201 个字符。
现在：不在围栏内、不在捕获中、且剩余部分既无 `<` 也不是围栏候选开头时，直接吐出去
（所有被识别的标记都以 `<` 开头，这样不可能漏掉标记，也不影响围栏状态判定）。

⚠️ **效果边界要说清**：真正决定上屏节奏的是上游 `TranscriptEchoGuard` ——
它同样逐行分类（只按换行符切行），**整段没有换行**时会把内容先扣到轮末。
这是**既存行为**（0.1.47 之前就是这样，不是本轮引入）。要改成逐字上屏，需要放宽 echoGuard
的逐行 hold，并保证「行内回声判据的前缀」不被误放 —— 风险较高，**本轮未处理**。
`tests/check-auto-continue.mjs` 里有一条用例**记录这个现状**，将来若改了它会提醒同步更新。

### 测试

- `check-auto-continue.mjs` 14 → **23 项**：N06 两条（部分上报 / 全部上报）、
  N03 六条（一包 / 逐字符 / **遍历全部切分点** / 围栏保留 / 无换行现状 / 尖括号必须缓冲）、
  安全前缀单测一条。
- `check-bundle.mjs` 的产物断言同步更新：原来断言的 `reportedTokens > 0` 已被 N06 删除；
  新断言改的是**调用点** —— `usageRounds.push(roundUsage)` + `estimateTokens(round.prompt)`，
  以及 `systemMarkerFilter` 在流内与轮末的两处 push + flush。
  注意 `round.total !== undefined` 会被打包器改写成 `!== void 0`，所以不拿它做断言。
- 反向验证 **6 处全部变红**：流内退回无状态剥离、轮末残余不剥、围栏保护失效、
  安全前缀失效、去掉「含 `<` 必须缓冲」、usage 退回整次二选一。
- 33 个测试文件全绿。

### 未处理

N05（WASM 下载失败只清编译缓存，失效地址会阻断 discovery 恢复）、
N02（迟到的 `/status` 校验把当前账号切回去）、F04（`serverId` 的生产身份链是断的）。

## 0.1.46 — 2026-09-13

### 第二轮审计第二批：N07（长历史静默截掉系统指令）+ N04（复用槽三处）

**N07（高）固定头不再按比例裁剪**

旧写法最终用 `headBudget = min(head.length, floor(maxChars * 0.62))` 兜底 ——
只要 system 长到超过预算的 **62%**，就会从**中间**被 `truncateMiddle` 挖掉一块：
**预算明明够放完整 system，也会静默丢掉系统指令**，模型照着残缺策略干活。

现在：固定头（system + 协议 + 工具目录）**独占它的长度**，剩余预算全给历史；
固定头自己放不下就抛 `AdapterLlmError(..., 'CONTEXT_WINDOW_EXCEEDED')`。
代价：以前"静默丢指令还能生成"的请求现在会明确失败 —— 这是有意的。
另加 `maxChars` 校验（非安全整数或 < 128 直接 `RangeError`），免得小数一路漂到后面的算术里。

**N04（高）复用槽：缺在用保护 / 提前中断不退役 / 切号丢失清理归属**

三处独立问题，审计各自复现过：

1. **提前结束不退役**：`openCompletion` 只在 HTTP 失败分支退役；调用方拿到正文就 `return`
   （或取消）时，stream generator 的 `finally` 不管 —— 于是下一次请求会接着用一个
   "上一条流还没消费完"的会话。现在 `finally` 里 `!complete || poisoned || limit === 0` 就退役。
2. **没有在用保护**：复用开启时新增**飞行互斥**（`reuseFlightTail`），同一时刻只有一个复用请求在跑，
   避免"轮换撞上并发请求正在消费的会话"。关闭复用（`sessionReuseTurns: 0`）保持原并发模式。
3. **切号丢失清理归属**：槽位新增 `cleanup`，记录**这个会话归谁回收**。
   旧实现只在同账号轮换时返回 `retired`，跨账号切换直接覆盖旧槽 → 旧会话永远不会有人删。
   现在旧槽一律交回**它自己的** cleanup。

顺带修掉一处：`openCompletion` 的 catch 原本**无条件**把错误包成 `TRANSPORT`，
会把 PoW/网络层带出来的 `AUTH` / `RATE_LIMIT` 结构化分类抹掉 —— 宿主于是按"可重试的传输错误"
处理本该停下的情况。现在 `AdapterLlmError` 原样放行。

**并发代价（明确记录）**：复用开启（默认 20）时全程串行，含跨账号。
默认 adapter 本来就串行，常规体验不变；若同时主动开启 `allowConcurrent`，吞吐会降低。
关闭复用则完全不受影响。

### 测试

- `check-round2.mjs` 18 项（+7）：N07 四条、N04 三条、以及"已是 AdapterLlmError 不得被包成 TRANSPORT"。
- **按审计的 T-N04 改掉我那条期望写错的用例**：原断言是"不能回收上一个账号的会话"→ `deleted` 必须为空。
  但正确设计不是"永不回收"，而是**用原账号的回调回收** ——
  「不能用 B 的回调删 A」不等于「永远不应回收 A」。原用例两个账号共用一个回调，所以断言不到"归属"。
- 反向验证 **9 处全部变红**（N07 一处、N04 五处 + 早前的 N01/N08/N09/N10 四处）。

⚠️ 其中 N04e（catch 分类）**第一轮没红**——因为**没有任何用例覆盖它**。补了
"powHeader 抛 AUTH，必须原样传出"这条才真的能区分。又一次印证：没红先问"用例真的存在吗"。

### 尚未处理

N03（tool_result 跨流残片）、N05（WASM 下载失败不失效缓存）、N02（迟到 /status 切回账号）、
N06（续写漏记 usage）。⚠️ 审计明确指出 **N03 与 N06 修改同一个 `streamImpl`，必须用组合函数**，
不能分两次互相覆盖。以及旧项 F06/F08/F10/F15/F16/F19/F20/F21/F22/F23 与 F04 的生产身份链。

## 0.1.45 — 2026-09-13

### 第二轮审计（N01–N10）第一批：N01 / N08 / N09 / N10

审计报告：`DSH-Round2-Audit.md`（10 项确认，7 项"高"）。本版处理 4 条，其余见文末。

**N01（高）导入仍相信备份自报的 id —— 我上一轮声称修了 F03，其实没修**

- 根因：`normalizeRecord` 内部是 `raw.id ?? fallbackId ?? newAccountId()`，所以
  "调用时不传 fallbackId"**完全没有效果**；备份里写同一个 `id` 的两条**不同 token** 账号会互相覆盖
  （不需要路径穿越）。审计在原版上复现：连续导入两条，列表长度只有 1。
- 改法：导入一律**生成本地主键**（`do { id = newAccountId() } while (ids.has(id))`），
  只有 token 命中才更新已有账号；`serverId` 也不再用于匹配 —— 它是备份自报字段，
  不能拿它授权覆盖不同 token 的账号。另加 500 条上限。
- 代价：同账号刷新 token 的备份会多出一条，需要用户手动确认合并（但旧凭证安全）。

**N08（中）取消长休会白吃休息债务**

`if (needsBreak) { consecutive = 0; ... }` 原本发生在 `await sleep(...)` **之前**，
于是"取消一次长休"等于把休息债务一笔勾销，下一次请求直接绕过长休
（把"闸门可取消"的正确修复和长任务保护组合出了旁路）。现在清计数移到长休**真正走完且未被取消**之后。

**N09（中）认证信封接受空壳与错型**

`{code:0}`、`{data:null}`、`{code:"401",data:null}` 原本全部被判成功 ——
"校验成功"与"拿到有效身份"脱节。现在要求：业务码必须是**数值**、`data` 必须是对象、
且里面要能辨认出一个用户（id 或已知名称字段）。

⚠️ 这次**改了既存测试的期望**（不是放松实现）：`check-user-display.mjs` 里原本断言
`{code:0,data:{}}` 判成功 —— 那正是 N09 指出的空壳信封。已在用例里注明原因。

**N10（高）外部浏览器兜底能让宿主直接退出**

`login.ts` 的 `openExternalLogin` 在 `spawn()` 后立刻 `return {ok:true}`，
外层 try/catch **只能接同步异常**；`error` 是 EventEmitter 在下一个事件循环异步发出的，
没监听就是未处理错误 → 宿主进程退出（同类问题在 `browser-login.ts` 修过，这条路径漏了）。
现在等 `spawn`/`error` 之一落地再返回；并加了 `setSpawnImpl` 测试缝（与闸门的 `now`/`sleep` 同一套做法）。

### 测试

- **新增 `tests/check-round2.mjs`**（11 项，按审计编号组织）：
  N01 五条（含"同 token 幂等""非法输入零条""超 500 条拒绝"）、
  `newAccountId` 唯一性、N08（取消后仍要长休）、N09 两条、N10 两条（error / spawn 两个分支）。
- **按审计建议修了两处"假守护"**：
  - `check-accounts.mjs` 的 F02 用例原本用"持有文件句柄让 rename 失败"——那是**平台假设**
    （Linux 上打开 r 句柄不阻止 rename，夹具无效）。改成**注入确定的 rename 失败**并断言
    `injected === 1`（自证真的命中了目标 rename）。
  - `check-accounts.mjs:233` 原本只断言 `randomUUID()` 有横线 —— 那只证明 Node API 的输出。
    改成 200 次 `newAccountId()` 互不相同 + 形态合法。
- 反向验证 4 处全部变红；`check-round2` 共 11 项、全量 33 个测试文件全绿。

### 尚未处理（下一批）

N02（迟到 /status 把账号切回去）、N03（tool_result 跨流残片）、N04（复用槽在用保护 + 回收归属，
含审计给的 T-N04 测试替换）、N05（WASM 下载失败不失效缓存）、N06（续写漏记 usage）、
N07（长历史固定比例裁剪截掉系统指令）；以及旧项 F06/F08/F10/F15/F16/F19/F20/F22/F23/F21、F04
（审计指出 `serverId` 的生产身份链**没接通**：`login.ts` 填的是 `user.id`，没有归一化到 `serverId`）。

## 0.1.44 — 2026-09-13

### 变更：token 统计改用**服务端上报的真实值**（不再纯靠字符估算）

上一版抓到 `accumulated_token_usage` 但没接入，因为不知道它是「本消息」还是「会话累计」。
本次用**同一会话发两回合**的对照实验把它钉死了（真实请求，已落盘）：

| 回合 | prompt | 服务端上报 |
| --- | --- | --- |
| 1 | 12,424 字符 | **6446** |
| 2 | 9 字符 | **38** |

第 2 回合只报自己的 38（和独立跑同一 prompt 的结果完全一致）→ **是「本消息」总量**
（含我们发的 prompt + 回复 + 服务端自身开销），不是会话累计。

**改法**：`parseWebSse` 把 patch 通道里的 `accumulated_token_usage` 记下来，
通过 `finish` 事件的 `totalTokens` 带给适配器；适配器优先用它上报
`inputTokens = max(0, 总量 - 我们对输出的估算)`——这样**总量恰好等于服务端给的数**，
底部统计不再是估算。拿不到（协议变了/老请求）才退回按字符估算。

⚠️ **踩到的坑**：真实形态是 `{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38}]}`
—— 它在 **response/BATCH 的内层 op** 里，第一版补丁插在顶层 case，测试立刻抓到（全 undefined）。
另外**快照里的同名字段初始恒为 0**（status 还是 WIP），绝不能用它当结果；
判定脚本的第一版就是取了这个 0，把结论整个判反了。

### 提示词上限：本机已调到 40 万字符

`~/.dsh/web-login/gate.json` 的 `maxPromptChars` 已从 150 万改为 **40 万**（可用设置页随时改回）。
这意味着单次请求最多带约 33 万字符的历史 —— 长任务里模型会更早"忘事"，
但不需要的历史不再重发。**重启 DSH 后生效。**

### 测试

- `check-sse-wasm.mjs` +5：用**真实抓到的响应逐字当夹具**（含那个初始为 0 的快照），
  覆盖 38 / 6446 / 无字段 / 脏值 / 只有快照时必须报「拿不到」。
- `check-bundle.mjs` +1（上报真实值的调用点）。
- 反向验证 5 处全部变红。

⚠️ 反向验证第 D 条第一轮没红，两个原因叠在一起：① 我的"改坏"是 `void value` 这种空操作；
② 更要紧的是**那条用例本身写的断言（notEqual 0）根本区分不了任何东西**——
patch 在快照之后到达、照样覆盖成 38，把实现改坏也测不出来。已重写成
「只有快照、没有 patch 时必须报 undefined」，这才是能区分的形态。

## 0.1.43 — 2026-09-13

### 新增：设置页可调 **prompt 上限**（token 体量的总阀门）

**为什么它比"间隔"更值得调**：网页 API 是无状态的，**每一轮都要把整段对话历史重发一遍**，
所以转写越长、单次请求越贵。同一个会话里实测单次输入估算从 9.7k token 涨到 **293k**，
180 次请求累计约 2900 万。间隔只影响"多久发一次"，这个才影响"每次发多少"。

- 设置页新增滑块（**12 万 ~ 150 万字符**，步长 2 万），改动即时生效并写入 `gate.json`。
- 边界取值理由：上限就取原来的默认值（再大就有撑爆 1M 上下文的风险，纯中文 150 万字符 ≈ 100 万 token）；
  下限取更早的默认值 12 万（长期在用，说明这个量级还能干活，工具目录占约 5.6 万）。
- 界面上直接给取舍：调大 → 模型不容易"忘事"、但单次更贵；调小 → 省 token、长任务会丢早期上下文。

### 新增：界面上的「数字说明」

用户问过"缓存命中 0% 正常吗"。事实是：**网页端不提供缓存信息，所以我们从没上报过这个字段**
——DSH 只能显示 0，它**不代表真的没命中**。这句话现在直接写在设置页上，
免得以后反复困惑（同时说明底部 token 数目前是按字符估算的）。

### 调查结论：网页端**是**给用量数据的（尚未接入）

抓了一次真实 SSE 落盘（`/api/v0/chat/completion`），结论：

- ✅ 有用量字段：`{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38}, …]}`
  —— 一个 9 字符 prompt 的请求服务端报 **38**，而我们按字符只估出 3。目前我们**没有解析它**。
- ❌ **没有任何缓存字段**（把响应里所有键名穷举了一遍）→ 「缓存命中率」在网页端拿不到，
  这个指标永远只能是"未提供"，除非改用官方 API。
- ⚠️ 未定：`accumulated_token_usage` 是**本消息**的总量还是**整个会话**的累计（样本只有一个回合，
  两种情况数值相同）。这决定接入时能不能直接当 inputTokens 上报，需要再花 2 个请求确认。

### 测试

- `check-request-gate.mjs` +3（默认值 / 越界夹紧 / 落盘读回），并把 3 处整对象 `deepEqual`
  改成**取子集比对**（`pick(..., GATE_CORE)`）——`settings()` 每加一个字段就碎一次，已踩两次。
- `check-bundle.mjs` +3（host 可调、client 有旋钮、**保存后即时推给 adapter 的调用点**）。
- 反向验证 5 处全部变红。

## 0.1.42 — 2026-09-13

### 修复：模型复述的**跨行**工具结果被当正文显示

现场（会话 `15ac4c56` 记录 `[1480]`）：正文里出现

```
Found a real gap: … Fixing that, then doing the final pass.
<tool_result>Path: F:/…/package.json
<path>F:/…/package.json</path>
<type>file</type>
<content>
1: { "name": "dsh-ssh-workspace", …
</content>
</tool_result>
```

即模型把 SSH 插件一次读取工具的结果**整段复述**进了回答。已有的伪标记剥离器
（`stripSystemMarkers`）**逐行**处理，匹配不到跨行的闭合标签，所以漏了出去。

改法：新增「跨行长标记」这一遍，在逐行循环之前对全文做一次（`[\s\S]` 而不是行内匹配）。
围栏区间先算好再判断命中点是否落在代码块里，与逐行那遍的保护策略保持一致。

⚠️ `tool_result` 比 `ds_system` 那批更「可讨论」——用户正在开发**产出它**的那个插件，
正常回答里可能出现简短示例。所以要求**正文 ≥ 120 字才剥**：真实回声是整份文件
（实测那处上千字），随口举例不会有那么长。

### 测试

- `check-system-markers.mjs` +5（跨行回声剥离 / 短示例保留 / 围栏内保留 /
  未闭合形态 / 回声后面还有正文时不能连后面一起吃掉）
- `check-bundle.mjs` +1（跨行伪标记的产物断言）
- 反向验证 4 处全部变红

⚠️ 反向验证第一轮 A 没红：上面那条"回声在末尾"的用例里，**闭合规则与未闭合规则互为备份**，
把闭合规则改坏也测不出来。补一条「回声后面还有正文」的用例才真正区分开，
并顺带守住一个真实风险：**别把回声后面的正文一起吃掉**。

## 0.1.41 — 2026-09-12

### 修复：DSML 标记再次漏上屏；提示词不再写出私有标记字面量

用户两次报同一类问题。第二次的形态与 0.1.35 修过的**不是同一个**：

现场（会话日志记录 `[1354]`，`assistant/message` 的 text 块）：
```
"Continuing. … Fixing both." + \n×4 + "<|DSML|calls>" + \n + "</|DSML|invoke>" + \n + "</|DSML|calls>"
```
即**完整的开标签 + 两个闭合标签，中间没有任何 invoke**。

**两个独立成因**：

1. `<|DSML|calls>` 命中 `XML_STARTER_RE` → 进捕获态 → 里面没有 invoke →
   `looksLikeToolCallBlock` 判否 → 捕获内容被当正文透出。而那条**降级透出路径原本没剥残片**
   （只有 `pending` 和 `flush` 两条路径剥）。现在三条透出路径都先过 `stripStrayToolMarkup`。
2. **只在流式下出现**：hold-back 判定不认「半截 DSML 前缀」。`DSML_PREFIX` 要求
   「竖线 + DSML + 竖线」，而流到一半的 `<|DSML` 少最后一个竖线 → 归一化认不出 →
   `partialMarkerSuffixLength` 给 0 → **半截标记被当正文切出去**，后面几个字符补上就成了完整标记。
   已加兜底：把候选里的竖线与 `dsml` 擦掉再比对 starter 前缀。

顺带补上 `dsml-` 连字符变体（`<dsml-calls>`）——本文件其它地方早已声明兼容该变体。

### 提示词卫生：不再写出私有标记的字面量

`TOOL_PROTOCOL_INSTRUCTIONS` 的规则 6 原文里有 `<|DSML|>` **这个字面量**，而这段文字
**每次请求都会随 prompt 进到网页端会话**（用户在 chat.deepseek.com 上就能看到它）。
除了暴露给用户，点名一个 token 本身也有诱发模型吐它的风险。已改为描述性表述
（"the private delimiter-prefixed variants some DeepSeek surfaces use"），禁令强度不变。

⚠️ **网页端出现的 DSML 有一部分是我们改不了的**：服务端存的是模型的原始输出，
客户端过滤只影响 DSH 这一侧的显示。另外 0.1.40 起同一会话复用 20 轮，
这些内容会在**同一个对话里累积**（以前每轮一个会话、很快删掉），所以更容易被看到。

### 测试

- `check-dsml-stray.mjs` +6（退化块一次喂入 / 逐字符流式 / 裸包裹标签 / 尖括号对照 /
  真调用不被误伤 / 提示词不含私有标记）
- `check-bundle.mjs` +2（提示词卫生 + 剥 DSML 裸包裹标签）
- 反向验证 4 处全部变红

⚠️ 反向验证第一轮 A 没红：测试样本是我自己简写的，**分片边界挪了位**，没走到 hold 那条路径。
换成与会话日志**逐字一致**的样本（含反引号与弯引号）后才真的覆盖到 —— 这也是本次的教训：
分片相关的用例，样本必须逐字照抄现场。

## 0.1.40 — 2026-09-12

### 变更：网页端会话改为**多轮复用**（实测判定后推翻旧结论）

**问题**（用户在自己浏览器里发现的）：DSH 里跑一个 agent 任务，chat.deepseek.com 的对话列表
会不停冒出新对话、过一会儿又被删掉。查台账确认：**2026-09-12 一天建了 182 个网页端会话**，
18 点那一小时 74 个，最密 8 个/分钟 —— 因为**每个 DSH 回合 = 建一个新会话，用完再删一个**。
真人不会这样建删对话，这是比"间隔太小"强得多的机器特征。

**旧结论错在哪**：代码注释和 0.1.21 的提交说明里写着「不能复用会话：DSH 每次都交全量历史，
复用会让服务端看到两份上下文、迅速撑爆窗口」——**这是一条推理，从来没有实测过**。

**实测判定**（真实请求，2026-09-12，同一会话内）：
- 先发「记住这个编号：ZC-7391-KX。只回复 OK。」→ 模型答 `OK`
- 再发「刚才我让你记住的编号是什么？」→ 模型答 `不知道`

→ 服务端**没有**把同会话历史带进上下文。原因是每次 completion 都发 `parent_message_id: null`，
每条消息都是会话里的**根消息**、没有父链，服务端按消息树回溯上下文时回溯到空。
**复用是安全的。**

（另：判定实验第一版差点得出反向的假结论——账号被封时接口返回 `user is muted`、正文为空，
脚本把"没复述出编号"当成了"没带历史"。已加自证断言：A 步必须真的答出内容，否则整轮判无效。）

**改法**：新增 `sessionReuseTurns`（默认 **20**）。同一账号连续 20 个回合共用一个网页端会话；
达到上限或换账号才轮换，轮换时把旧会话交给清理器回收。失败的会话立即摘出复用槽（失败即弃），
"会话失效 → 换新会话透明重试"的路径保持有效。`sessionReuseTurns: 0` 可回到旧行为。

按今天的数据估算：建会话数从 **182/天** 降到 **约 10/天**。

### 测试

- 新增 `tests/check-session-reuse.mjs`（7 项：复用/不删/轮换回收/关闭复用/失败即弃/失效重试/跨账号隔离）
- `check-bundle.mjs` +1（会话复用的产物断言）
- 反向验证 5 处全部变红

## 0.1.39 — 2026-09-12

### 修复：审计中危项 F11 / F12 / F13 / F14

**F11 闸门不可取消（中）**
`gate.acquire()` 的两处等待（排队等前序、等间隔）此前都是死等，调用方的 `AbortSignal`
根本没传进去。表现是：用户点「停止」之后，请求仍可能在闸门里干等 —— 普通间隔 2~4 秒，
触发长任务保护后甚至是 60~180 秒。界面停了、闸门还在倒计时。

现在 `acquire(label, signal)` 接受信号，两处等待都可中断；被取消时会把自己**从队列里摘掉**
（`releaseMine()`），否则后续排队的请求会在队尾上永久卡住 —— 闸门直接锁死。
适配器已把 `options.signal` 传下去（这是宿主原本就有、只是没接的那根线）。

**F12 PoW WASM 地址无限制（高）**
`auth.wasmUrl` 主要来自**导入的账号备份**，可被构造成任意地址 —— 审计已复现可打内网 /
云元数据（169.254.169.254）/ `file:` 协议。Electron 的 `net.fetch` 支持比 Node fetch 更宽的
协议，不能把后者的协议限制当成统一边界。

新增 `checkedWasmUrl()`：限 https + `*.deepseek.com` + `.wasm` 路径 + 无凭据 + 无显式端口，
凭证地址、默认地址、页面发现到的地址**三处都过校验**；下载加 8MB 上限再编译。

⚠️ 这里**没有**照搬审计的「删掉 discovery」建议：实测 `wasmUrl` 其实**不是**浏览器抓来的
（`browser-login.ts` 里恒为空），默认地址又带内容哈希（`sha3_wasm_bg.7b9ca65ddd.wasm`），
官方一改就失效。discovery 是唯一的兜底路径，删了就没有恢复手段。所以保留发现能力，
只把「能不能用」收白名单 —— 既挡 SSRF 又留后路。

**F13 SSE 多行 data 丢失（中）**
SSE 规范允许一个事件里出现多个 `data:` 行，收齐后用 `\n` 拼接再整体解析。旧实现逐行
`JSON.parse`，一旦服务端把一个 JSON 拆到多行，每行都解析失败 → 被 `catch { continue }`
**静默丢弃**，表现为「流突然断了/少了一段」且没有任何报错。现在改为攒齐再解析，
事件边界（空行 / 新 event 名 / 流末尾）都会收口；末尾没有空行也不丢。

**F14 spawn 异步错误未监听（高）**
启动登录浏览器时只 catch 了同步异常；异步失败（`ENOENT` 程序不在、`EACCES` 没权限、
被安全软件拦截）会变成**未捕获异常直接带崩宿主进程** —— 而这只是「登录窗口起不来」。
现在监听 `child.on('error')`，并给 300ms 让它冒头（不必让用户干等 25 秒的调试端口超时）。

### 测试

- 新增 `tests/check-sse-wasm.mjs`（F12 白名单 15 例 + F13 解析 6 例）
- `check-request-gate.mjs` +3（F11：已取消 / 取消后不锁死 / 排队中取消且队列仍流动）
- `check-bundle.mjs` +1（F14 产物断言；该处无注入点，暂无单元测试）
- 反向验证 5 处全部变红

## 0.1.38 — 2026-09-12

### 新增：长任务保护（连续跑满阈值后强制长休）

起因是实测到的一个形态：2026-09-12 一个 SSH 插件开发任务，**12 分钟里发了约 70 次请求**，
其中大部分是"只调工具、不说话"的轮次（会话日志里 89 个 0 正文消息中有 88 个都产出了工具调用，
属正常行为）。间隔设到 2~4 秒仍全程零停顿 —— 当天该账号两次被临时限制，第二次长达 3 天。

根子在于：间隔只管"两次之间空多久"，**管不了一刻不停跑了多久**。
把间隔从 2 秒调到 8 秒，请求还是均匀铺满整条时间轴，只是稀一点 ——
它造不出真人那种"跑几轮 → 停下来看结果 → 再跑"的大段空白。

现在闸门会数连续请求：

  连续 DEFAULT_LONG_RUN_THRESHOLD(15) 次 → 强制长休 60~180 秒（区间随机）→ 计数归零
  距上次请求超过 120 秒 → 视为"歇过了"，计数归零（"连续"指的是不停歇）
  longRunThreshold = 0 → 关闭

长休时会打日志（`已连续 15 次请求 —— 长休 87s 再继续`），免得用户以为卡住。
设置落盘在 gate.json，重启后保留；设置页的节流日志也会显示当前配置。

测试：check-request-gate +5（触发长休 / 阈值 0 关闭 / 歇够归零 / 长休时长随机 / configure 与越界夹取）。
反向验证三处全部变红。

⚠️ 两件值得记的事：
1. 中途有一步补丁**断言失败没写进文件**，导致 gate.ts 引用了不存在的常量 ——
   于是那一轮反向验证的"变红"其实是 **import 报错造成的假红**。补丁脚本必须确认写入成功，
   反向验证前也要先确认基线是绿的。
2. `settings()` 多了字段后，既有测试里 6 处 `deepEqual(settings(), {...})` 全碎了。
   其中 3 处改成**逐字段断言**（只断言这条用例真正关心的字段，以后再加字段也不会碎），
   另外 3 处（`configure()` 的返回值）必须补全字段。

## 0.1.37 — 2026-09-12

继续采纳审计：F01 / F05 / F07。

### 修 F01：账号 id 未校验，可路径穿越

`accountFilePath(id)` 直接 `join(accountsDir(), `${id}.json`)`，**没有任何校验**；
而 `importAccounts` 会把**备份文件里的 id 原样当主键**，HTTP 路由也直接吃调用方传的 id。
于是 id 写成 `../../../../Users/me/evil` 就能越界读、写、删账号目录之外的 JSON。

新增 `assertSafeAccountId()`：只挡"能跑出目录"的字符（路径分隔符、`..`、空、`\0`），
**不强求格式** —— 历史 id 形态不止一种，按白名单收紧会误伤老账号。
另外 `activeAccountId()` 加了 try/catch：索引文件若被外部改坏，当"未选择"而不是让异常炸穿。

### 修 F05：异步期间切号 → 限制/台账记到错误的账号

`recordCallOutcome` 在上报时**现取** `activeAccountId()`，而一次流式调用可能飞几十秒，
期间用户完全可能切号 —— 结果是「被限制的号反而清白，正在用的号背了别人的处罚」，
台账与设置页的「限制还剩多久」全都指错了人。

改为：适配器在**起飞前**（拿到闸门许可之后、开流之前）调一次 `currentAccountId()`，
结果随 `noteCall` 回传；宿主优先用它，只在拿不到时才回退到"此刻"的当前账号。
`currentAccountId` 是可选依赖，不注入也能工作（回退到旧行为）。

### 修 F07：批量清理会拿 A 的凭证去删 B 的会话

批量删除只发**一个** Authorization 头（`buildDsHeaders(batch[0].auth)`），
却删除了**整批**的 sessionId。若一批里混了不同账号的会话：
轻则整批被服务端拒绝；重则 `resp.ok` 时被当成全部成功 ——
旧代码在 ok 时直接 `return`，不逐个校验每个 id 是否真被删掉。

改为：只有 `batch` 内 token 全部相同时才走批量，混号则退化为逐个删（逐个删用的是各自的 auth）。
实测：混号 2 个 → 2 次逐个删；同号 3 个 → 仍合并成 1 个请求。

测试：check-accounts +2（F01）、新建 check-call-attribution 4 项（F05）、
check-session-cleaner +2（F07）、check-bundle +3。反向验证三处全部变红。

⚠️ 测 F07 时的一个坑：逐个删是**异步串行**的，`fakeTimers.runAll()` 之后还要再
让出一次事件循环（`settle()`）才能断言，否则会看到"只发了 1 次请求"的假象。
## 0.1.36 — 2026-09-12

采纳用户提供的第三方审计（GPT6，23 项）里的三条，都是小而明确、证据齐的。

### 修 F09：认证响应未校验形状，HTML 200 被当成验证成功

`validateAuth` 里 `resp.json()` 抛错时把 json 置为 undefined，而 `envelopeError(undefined)`
返回 undefined，于是径直走到 `ok: true` 并返回一个**空壳的 user({})**。
也就是说：反爬页 / WAF 拦截页 / 空响应 —— 它们同样是 HTTP 200 —— 会被判为"验证通过"。

后果很实际：探活显示"通过"、账号看起来正常，0.1.31 加的「需要重新登录」按钮**永远不会触发**；
什么都没确认到，却说成功。只读零额度请求偶发失败的代价只是一次重试，远比"误报成功"划算。

抽出纯函数 `classifyAuthEnvelope(json)`（validateAuth 要发网络请求，测不了这条分支）：
非对象 / 数组 / 业务错误码 / 既无 data 也无 code → 一律判失败。

### 修 F02：写凭证先删目标文件 —— 失败即丢凭证

`writeJsonAtomic` 旧写法是「先 `rmSync(file)` 再 `renameSync(tmp, file)`」。
一旦 rename 失败（磁盘满 / 占用 / 权限），**原文件已经没了**，凭证直接丢失。
实测 win32 + Node 22：`fs.renameSync` **本来就能直接覆盖已存在的目标文件**，
所以那句 rmSync 既没必要、也是唯一的丢数据风险点。
另外临时文件改为创建时就是 0600（旧写法先按默认权限落地、事后再 chmod，中间有暴露窗口）。

### 修 F18：head 超预算时被从中间挖空（残缺的 JSON Schema）

旧做法：先把工具目录渲染到 5.6 万字符，再发现 head 超过 `maxChars × 比例`，
于是 `truncateMiddle` 从**中间**挖掉一块 —— 留下残缺的工具定义，
模型会照着半截定义猜参数，比"干脆不列这个工具"更糟；而且 maxChars 越小时越容易触发。
（0.1.33 只把比例从 0.45 提到 0.62，属于"把坑挪远"，没解决根因。）

改为**反过来算**：先扣掉 system 与协议指令的固定开销，剩下的才是工具目录能用的额度，
装不下就走 buildToolSection 自己的兜底（列出被省略的工具名），**head 永远完整**。
实测：maxChars=2 万时 head 12,525 字符、无截断；maxChars=12 万时 61 个工具全在。

测试：check-user-display +4（F09）、check-accounts +2（F02）、check-tools-section +2（F18）。
反向验证三处全部变红。

⚠️ 反向验证里 F18 **第一轮没红**，原因值得记：我把新测试插在了测试文件末尾
`if (failures.length) { … process.exit(1) }` **之后**，于是失败被前面的报告块"吞掉"，
退出码仍是 0。**新测试必须插在报告/退出块之前**，否则测了也白测。

## 0.1.35 — 2026-09-12

### 修：工具调用标记的残片上屏（`voke> </|DSML|calls>`）

用户在使用中发现正文里冒出 `voke> </ | DSML | calls>` 这样的残留，手动停止了生成。
会话日志里对应的是 `assistant/message` 的 **text 块**（会显示给用户的那块）：

    "I'll finish the install: … variable.\n\n\n\nvoke>\n</ calls>"

而同一条消息里的 **3 个工具调用全部解析成功** —— 也就是说：**调用抓到了，标记的残片却当正文吐了出去**。

模型经常**把包裹开始标签写丢、只留闭合标签**（`</|DSML|calls>`），或者只留下标签的后半截
（`voke>` 是 `invoke>` 掉了头）。这些残片绕过了捕获逻辑（识别器只认 `<…invoke` / `<…calls>`
这类**开始**形态），落进正文缓冲。

离线复现确认了**两条独立成因**，都修：

1. `findXmlToolCallEnd` 吞完裸 `invoke` 块后，遇到后面的孤立闭合标签**停下返回**，
   把它留在缓冲里 → 现在会把它一并吞进块内（收不全则继续等，由 `flush()` 兜底）。
2. **`flush()` 把 hold 住的尾巴无条件吐出**。残片通常很短（`</|DSML|calls>` 只有 16 字符），
   小于 `HOLD_BACK_CHARS`(24) 就会被一直 hold 到流结束，然后原样上屏 → 现在吐出前先清理。

新增 `stripStrayToolMarkup()`（导出，便于单测），三道规则从明确到宽松：
带 DSML 前缀的孤立闭合标签 / 前缀被吃光的 `</ calls>` / 只剩后半截的 `voke>`。
主循环透传前与 `flush()` 各调一次 —— **两处互为备份**：反向验证里单独取消任一处都不会变红，
同时取消才复现泄漏（已用这一点确认清理真的在起作用，而不是假绿）。

⚠️ 一个**刻意的取舍**（已写进测试注释）：正文里孤立出现的 `</calls>` 也会被剥。
它与残片形态完全一致、无法可靠区分；真实回答里几乎不会出现，而残片泄漏是实打实的 bug。

测试：新增 `check-dsml-stray` 12 项（现场复现 / 逐字符喂 / 退化 `</ calls>` / 截图的 `voke>` /
`findXmlToolCallEnd` 的吞并 / 带 wrapper 的不回归 / **不误伤**普通英文里的 invoke 与正文里的 `<invoke>` /
刻意的取舍 / 纯正文透传 / JSON 路径不受影响）。
反向验证：C、D、E 三处变红（取消吞并 / 清理失效 / 两处同时取消），A、B 单独取消不变红是**预期**
（互为备份），已用 E 确认。

## 0.1.34 — 2026-09-12

### 修：设置页保存的间隔上限，每次重启都丢（随机区间变固定间隔）

用户重启 DSH 后继续用，日志里打出：

    deepseek-web: 距上次请求不足 2000ms（区间 2000~2000），等 908ms 再发「chat」

而 `gate.json` 里明明是 `2000~4000`。查下去是宿主启动时**漏传了 max**：

    // src/index.ts（修复前）
    const gate = createRequestGate({
      minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
      // ← 没有 maxIntervalMs
    })

而 `createRequestGate` 的既有语义是「只收到 min 时，max 跟随 min」（为了兼容老配置里
只写一个值 = 固定间隔）。于是**设置页保存的 2000~4000 随机区间，每次重启都变成固定 2000ms**，
直到用户再去设置页动一下才恢复。

固定间隔正是最典型的机器特征 —— 用户以为自己开着随机区间，实际每次重启后都在用固定值跑，
而且从界面上看不出来（"已生效"读的是 `gate.settings()`，它显示的就是退化后的值）。

三处漏传一起补：启动闸门 / `adapterConfig` / 状态回传。
（对照：0.1.30 加的三个**清理区间**在启动时是正确的，只有间隔这一对漏了。）

测试：`check-request-gate` 加 2 条 —— 一条**记录语义**（只传 min 时 max 跟随 min，
不是默认 4000），一条守「保存 2000~4000 后重启仍是 2000~4000」。
`check-bundle` 加 3 条产物断言。

⚠️ 反向验证又是**第一版没红**：我最初写的是 `/maxIntervalMs:/`，
但 gate.ts 内部也有 `options.maxIntervalMs ?? …`，被一起打进产物，所以宿主漏传照样通过。
改成匹配**调用点**（`/maxIntervalMs:\s*\w+\?\.maxRequestIntervalMs/`）才真的守住。
→ **产物断言要精确到调用点，别只匹配字段名。**

## 0.1.33 — 2026-09-12

### 修：DSH 的 61 个工具里，有 26 个从没告诉过模型

DSH 下发给插件的 `tools` 数组共 **61 个工具**，而我们把它写进 prompt 时有两道砍：

- `MAX_TOOLS_SECTION_CHARS = 24_000` → 只装下 **35 个**，剩下 **26 个完全没告知模型**。
  ⚠️ 截断是**按字母序**发生的（工具按名排序），所以被砍的是
  `write`(w)、`web_search`、`web_fetch`、`subagent`、`subagent_fork`、`todo_write`、`skill`、
  `read_image`、全部 `ssh_*`/`sftp_*`、`tunnel_start/stop`、`update_goal`；
  而极少用的 `db_tx_rollback`、`db_list_connections`、`job_list` 反而留下。
  **`write` 恰恰是 `~/.dsh/deepseek-web/rejected.jsonl` 里失败最多的工具**
  （27,616 字符 unbalanced、13,480 字符 echo）。模型看不到它的参数定义，只能猜。
- `MAX_DESCRIPTION_CHARS = 400` → **17 个工具的描述被砍**，`pwsh` 3010→400（丢 87%）、
  `workflow` 2500→400（丢 84%）。**丢掉的正是「遇错该怎么办」的指引**：沙箱拒绝不是命令的 bug
  （别换方式重试）、命名管道不可用时 `stdio:'pipe'` 的 spawn 会报 EPERM、只读沙箱下
  .NET 静态调用/Add-Type/COM/反射会失败；`workflow` 丢的是 `agent()`/`pipeline()`/`parallel()` 的钩子签名。

改三处（**必须联动，单改一处会更糟**）：

  MAX_DESCRIPTION_CHARS   400     → 3_200    （长描述基本不再砍）
  MAX_TOOLS_SECTION_CHARS 24_000  → 56_000   （实测需 50,942，留约一成余量）
  head 占比               0.45    → 0.62     （见下）

⚠️ **第二道闸**：`serializePrompt` 里 `headBudget = maxChars * 0.45 = 54,000`。
只把工具段预算调大会让 head（system + 协议 + 工具段 ≈ 63.5k）超过它，
被 `truncateMiddle` **从中间挖空** —— 比原来的尾部省略更糟，留下的是残缺的 JSON Schema。
所以 head 占比同时提到 0.62（转写仍余约 5.6 万字符，历史可截，工具定义不可截）。

兜底改为**不再静默**：真超预算时列出被省略的工具名，并要求模型"别猜参数，向用户确认"。

验证（用 DSH 真实下发的 61 个工具离线跑）：工具段 51,022 字符、**缺失 0 个**、
17 个长描述全部完整保留、prompt 合计 63,771 字符且**没有触发中段截断**。
代价：prompt 头部从约 3.7 万字符涨到约 6.3 万字符；工具段在最前且固定，前缀缓存友好。

测试：新增 `check-tools-section` 14 项（这个模块此前**零覆盖**，所以这个 bug 一直没被发现）。
反向验证四处全部变红：描述上限改回 400 / 预算改回 24_000 / 兜底改回静默 / head 占比改回 0.45。
⚠️ 第一轮反向验证里 D **没变红** —— 因为那条用例的 `merged` 根本没超过 `maxChars`，
压根没走到截断分支。已改为把转写撑长，并反转断言（必须出现 `chars omitted`，
以证明"真的走到了那段逻辑"，否则就是无效用例）。

## 0.1.32 — 2026-09-12

### 修：模型自造的伪标记 `<ide_result_status>` 漏上了屏

用户在会话里看到正文中间夹着一段：

    Core backend written. Now I need to verify the module-resolution question…
    <ide_result_status>Tool ran without output or errors</ide_result_status>

**先穷搜确认它不来自任何一方**（都是原始字节搜索，不是 grep）：

| 搜哪儿 | 结果 |
| --- | --- |
| DSH 的 `app.asar`（168 MB） | **0 处** |
| 全部已装插件（`node_modules`） | **0 处** |
| `~/.dsh` 全树 | **0 处** |
| 连那句话本身（`Tool ran without output`） | **0 处** |
| 会话日志（757 条记录）里的位置 | **只在 assistant 的输出字段**；212 条 `tool/result`、用户消息、系统消息里一处都没有 |

→ 结论：**这是模型自己编的**（模仿它见过的协议格式），与 0.1.11 处理过的
`<ds_system>Tool result for call_1a2b3c</ds_system>` 是同一类。所以修法就是把它加进剥离清单。

顺带把这一层从「硬编码两个正则」改成**数据驱动的标签清单**：

    const IMITATED_MARKER_TAGS = ['ds_system', 'system', 'ide_result_status'] as const

- 闭合形态用**反向引用**（`<(tag…)>…</\1>`）要求首尾同名，避免 `<a>…</b>` 错配被连内容吃掉。
- 刻意**不做通配**（`<[a-z_]+>`）：用户的正常回答可能就在讨论这些标签，通配会把它们一起吃掉。
  **清单只收有现场证据的名字**，每加一个都要有现场 + 穷搜证据。
- 快速退出改为 `hasImitatedMarker()`，语义与原来的 `includes` 串联一致。

### 顺带记下一个 10 分钟的教训（方法层面）

排查过程中我一度"复现"出缺字（正文少了开头的 `<tool_call`），**但那是我探针脚本自己的 bug**：
我手写了一遍 SSE 解析逻辑去"复现"，结果复现的是我写的 bug。

**正确做法**：`createSseState()` 本来就是导出的，直接拿**插件自己的解析器**离线回放抓到的原始帧。
用它回放 56 帧真实数据的结果是：正文 114 字完整、思考 14 字、**分歧 0 次** —— 解析完全正确。
→ 教训：**验证"是不是适配器的 bug"时，必须用适配器自己的代码，不能另写一份逻辑去模拟。**

### 测试

- `check-system-markers` 从 7 项扩到 **13 项**：新增现场 B（剥掉 + 保留上下文文字）、夹在正文中间、
  半截截断、**清单外标签 `<tool_call>` 必须原样通过**（剥了会把真工具调用吃掉）、
  围栏内保留、三种标记混排。
- **反向验证三处，全部变红 ✅**：去掉 `ide_result_status`／把真协议 `tool_call` 也加进清单／
  让快速退出永远跳过剥离。
  ⚠️ 第一轮我把"反向验证"写错了方向（把 `if (!hasImitatedMarker)` 改成 `if (false)` ——
  那只是关掉快路径、**行为不变**，测试绿是对的）。改成 `if (hasImitatedMarker(text)) return`
  才真正模拟"永远不剥"，立刻变红。**反向验证本身也要核对方向。**
- `check-bundle` 加 3 条产物断言（清单是数据驱动的 / 含新标记 / 老的 `ds_system` 不回退）。

## 0.1.31 — 2026-09-12

### 把"登录态还能撑多久"从完全不可观察变成至少能看一半

起因：讨论"账号长期不用会不会掉、要不要加心跳"。查证后**不加心跳**（实测没有任何东西可以刷新：
只读端点全部 `set-cookie: 0`、token 也不轮换），改为做两件**不需要多发任何请求**的事。

**① 捕获时记下 cookie 的过期构成**

新增 `src/cookies.ts`（纯函数，21 项单测）。两条捕获路径的形状不同，都认：

| 来源 | 字段 | 会话级 |
| --- | --- | --- |
| CDP `Storage.getCookies`（真实 Edge/Chrome） | `expires`（秒） | `-1` |
| Electron `session.cookies.get()`（插件自开窗口） | `expirationDate`（秒） | 字段缺失 |

- `0` / 非数 / 负值**一律当会话级** —— `0` 会被算成 1970 年，界面显示"已过期"会让人以为号坏了。
- 界面上写成 `5 项 · 1 会话级 · 4 持久级 · smidV2 还剩 399 天`。
- ⚠️ 文案里明确写了它**不是登录态寿命**：实测真正鉴权的是 `token`（只发 token 不带 cookie 能通过，
  只发 cookie 不带 token 直接被拒 `40002 Missing Token`），所以这只是浏览器侧的上界。
- 没有记录时 `summarizeCookieLife` 返回 `undefined` 而**不是全 0 对象** ——
  界面必须区分"没记录"（老记录 / 手动粘 token）和"记到了、全是会话级"，两者文案完全不同。

**② 探活失败从"报状态"改成"给动作"**

- 徽章 `校验失败` → **`需要重新登录`**（原来只写失败，用户不知道要干嘛、也看不出这号还能不能用）。
- 那一行直接出**「重新登录这个账号」**按钮，并写明失败原因与时间。
- 新增 `POST /login/relogin`：与 `/login/add` 的**唯一区别是不清浏览器登录态**。
  加新号必须先清干净（否则窗口一打开就是旧账号、抓回来还是它）；修同一个号正相反 ——
  留着才可能一打开就复用上，一个密码都不用敲。真掉了也没关系，窗口里重新登录一次即可。
- 落库仍走**添加模式**（只入库、不切换）：修好它但不顶掉你正在用的账号；若它本来就是当前账号，
  当前账号不变、只是凭证被换成新的 —— 这正是期望行为。

### 测试

- 新增 `check-cookie-meta` **21 项**：两种来源形状 / `session: true` 优先 / `0` 与非数当会话级 /
  过滤与 `buildCookieHeader` **产物逐个对齐**（两边过滤条件不许漂移）/ 读写磁盘时的规整 /
  "没记录"与"全会话级"的区别 / 剩余时间的天·小时·已过期。
- **反向验证四处，全部变红 ✅**：只认 `expires`（丢 Electron 那条路径）/ 把 `0` 当有效时间 /
  没记录时返回全 0 对象 / `pickCookieMeta` 忽略过滤条件。
- `check-bundle` 加 **9 条产物断言**（含"失败徽章必须是行动指令""必须说明不是登录态寿命"）。

## 0.1.30 — 2026-09-12

### 会话清理：三个参数改成「上下限 + 随机」（防"删除时机有固定规律"）

用户提的：会话清理也该有滑块 —— 攒够几个删、几秒后删、删多快（间隔），并且上下限都要能调、
取值要随机（一下子删一大批会出问题）。

原来是三个**死值**：正好攒到第 8 个动手、正好等 90 秒、批量删被拒后逐个删**连发不等待**。
固定值方差≈0 本身就是最明显的机器特征。现在：

| 参数 | 默认区间 | 谁在重抽 |
|---|---|---|
| `cleanupBatch` 攒够几个 | `6~10` 个 | **每轮清理**重抽 |
| `cleanupDelayMs` 最长等多久 | `60~120` 秒 | **每轮清理**重抽 |
| `cleanupGapMs` 删除间隔 | `0.8~2.5` 秒 | **每删一个**重抽 |

- 默认区间的**均值刻意落在原来的固定值上**（8 / 90s / 1.65s），所以行为不会有突然的跳变。
- 三个区间都**复用 `gate.ts` 的常量**（单一事实来源），不在 webapi 里重复定义一遍默认值。
- 边界收敛走 `normalizeCleanupRange`：非数忽略、按 bounds 夹住、**上下限颠倒时自动交换**。
- 区间只在 `deferred` 模式显示与生效（`immediate` 是"老行为"：固定 1.5s / 每次一个；`keep` 不清理）。

### 「删除间隔」是这次最要紧的一个

批量删是首选（N 个会话 1 个请求），但服务端**不接受批量删时会永久退化为逐个删** ——
那时如果连发，几十个删除请求会瞬间打过去，比"攒批"本身更像脚本。所以：
相邻两个删除请求之间按 `cleanupGapMs` 停一下，上限设 0 = 不等待（老行为）。
顺便把**批量删与逐个删都串行化**：上一轮没删完时，下一次 flush 只会排队，不会插进来并发发请求。

⚠️ 兼容性：**没给区间**（老调用方 / 老配置 / `immediate` 模式）→ 间隔为 0、不加额外等待，
老行为一字不变。这个约束是现有测试逼出来的（`check-session-cleaner` 的旧用例传死值、不传区间，
我第一版给它们加上了间隔 → 两处失败 → 改成"没给区间就不加间隔"）。

### 界面

「防风控」页在会话清理模式下面多三行，每行是一对上下限滑块 + 右侧合成值（如 `6~10 个`）：
拖动中只更新数字、松手才提交（与既有的间隔滑块一致）；只在「延迟」模式显示。
两条说明分别解释"取值随机"和"删除间隔只作用于逐个删"。

### 测试

- 新增 `check-cleanup-ranges` 12 项：区间重抽 / 上下限相等=固定值 / 批量删被拒后退化为逐个删**且中间确实会等**
  （不是连发）/ 串行化（上一轮没删完时下一次 flush 不插进来）/ 单批超上限会拆成多次 / 间隔为 0 时退回老行为。
- **反向验证抓到一处真缺口**：第一版测试用 `t.drain()`（把延迟清理的定时器也一起触发），
  于是"第二轮批次=4"是**碰巧成立**的，"阈值被重抽"根本没被验证到 —— 反向验证（把重抽去掉）
  没有变红才发现。改成每入队一步都只等异步链跑完（不触发定时器）、并断言**批次大小的确切序列**
  `[2] → [2, 4]`；重做反向验证三处（不重抽 / 间隔恒 0 / 去掉串行化）**全部变红 ✅**。
  教训：**"没变红"不等于"补丁没生效"，可能是测试用错了方式** —— 必须查到底。
- `check-bundle` 加 6 条产物断言（三个区间能落盘 / 走 normalizeCleanupRange / 三滑块存在 /
  初始隐藏 / 两条说明文案）。

## 0.1.29 — 2026-09-12

### 修：账号名显示成一串 id（两个叠在一起的取值 bug）

用户实测反馈：手机号注册的账号在账号库里显示成 `9d6***13`（其实是被掩码的**用户 id**），
刚「登录新账号」加进来的那个更是直接显示内部 id `acc_cd8e05ec`。

接口 `GET /api/v0/users/current` 其实**返回了手机号**：

    { id, token, email: "", mobile_number: "183******78", area_code: "+86", chat: { is_muted, mute_until } }

是我们的取值代码有两个 bug，而且它们叠在一起、单看任一个都"像是好的"：

1. **用 `??` 串回退链，而 `??` 不跳过空字符串。** 这个账号没设邮箱，接口给的是 `email: ""`，
   于是 `"" ?? mobile ?? …` 的结果就是 `""` —— 整条链当场被挡住，`display` 永远是空。
   必须改成**按"有内容"取**（跳过 undefined / null / 空白）。新增 `pickUserDisplay()`。
2. **字段名找错了**：手机号是 `mobile_number`，我们找的是 `mobile`。
   所以即使修好第 1 点，还是拿不到。

顺带修的两处：

- **捕获时就把身份写回记录。** `/login/browser` 本来就会做一次零额度的只读校验，
  顺手把结果存下来即可。否则新加的账号要等下一次探活（最长 30 分钟）才有名字 ——
  用户加完账号一刷新，看到的就是那串 hex。
- **探活成功时也写回身份**，库里闲置的账号会自己长出名字。
  用"旧值打底 + 新值覆盖"合并：新一次只带回 id、没带回 display 时，
  不会把已经拿到的好名字冲掉。

兜底也改了：**一个名字都拿不到时，不再把内部 id（`acc_cd8e05ec`）当名字摆出来**
（用户看到一串 hex 只会以为是 bug），改成 `未识别账号（cd8e05ec）`，留一小截后缀，
多个未识别账号之间仍然能区分。

⚠️ 顺带更正一处**我们之前写错的结论**：0.1.26 的注释写"受限期间 `users/current` 依然 200，
所以探活探不出限制"。返回 200 是对的，但**响应体里就带着 `chat: { is_muted, mute_until }`**
—— 也就是说探活其实探得出来，只是还没接上。三处注释已更正（probe.ts / accounts.ts / index.ts）。
接上之后就不必"等一次失败的生成"才能显示倒计时（留给 0.1.30）。

测试：新增 `check-user-display` 14 项（空串必须继续往后找 / 空白跳过 / 实测响应形状 /
优先级顺序 / 非字符串值 / 全空返回空串 / title 的三档回退与「未识别」）。
反向验证：把 `mobile_number` 从候选里删掉 → 5 项立刻变红。
⚠️ 另一轮反向验证（把**调用点**改回 `??` 链）**没有变红** —— 因为测试直接测函数、绕过了调用点，
这是个真缺口；已用产物断言补上（产物里必须出现 `pickUserDisplay` / `mobile_number` / `未识别账号`）。

## 0.1.28 — 2026-09-12

### 修：账号库根本没有「再加一个账号」的入口；并把过长的「账号」页拆成两个子页

用户反馈两件事，第一件追下去是真 bug。

**① 账号库缺入口（而且两个退出按钮都会顺手删库）**

```
退出当前账号 / 退出并登录其它账号
  → POST /logout → logout() → clearAuth() → removeAccount(active.id)
```

也就是说「退出」= **把该账号从账号库删掉**（0.1.26 刻意的设计：登出的语义就是凭证不该留在磁盘上），
但**界面从没说清这一点**；而账号库卡里只有列表 / 切换 / 重命名 / 移除 / 导出 / 导入 ——
**没有任何"加一个账号"的入口**。合起来的后果：这个"账号库"其实攒不到第二个号，
只能靠手动粘贴 Token 或导入备份，更像"一个账号 + 备份恢复"。

改动：
- 账号库卡新增「**登录新账号（添加）**」，配套新增 `POST /login/add`。
  它只清"登录态存放处"（独立浏览器 profile + 登录分区），**不动账号库里的任何账号**
  —— 这正是它与 `/logout` 的区别。不清的话新窗口一打开就是旧账号，抓回来还是它，等于没加。
- 新增 `src/account-add.ts`：**添加模式**。捕获到凭证后统一走 `commitCapturedAuth()`：
  默认仍是 `writeAuth()`（写入并设为当前，老行为一字不变）；添加模式下只 `upsertAccount()`
  （入库），**当前账号原样不动**。两条硬约束：
  - **一次有效**：无论成败都消费掉标志，绝不泄漏到后面某次无关的捕获上；
  - **15 分钟 TTL**：登录窗口可能被丢在那儿不管，过期自动失效。
- 边界：库里本来没有当前账号时（比如刚退过又直接点添加），反而**会**设为当前 ——
  否则会留下"库里有账号却没选中"的僵局。这不违反"不自动切换"：那条规则针对的是**别顶掉正在用的号**。
- `login.ts` 里 **5 处**捕获写回全部改走 `commitCapturedAuth`；
  但 `/status` 里那次"补全账号展示信息"的写回**故意保留 `writeAuth()`** ——
  它是对当前账号的元数据刷新、不是新捕获，让它消费掉添加模式会是个极难查的 bug（源码里留了注释）。
- 「退出」的文案改成明说"= 把该账号从账号库移除，不是只登出"，并指向「登录新账号」。

**② 「账号」页拆成两个子页：登录状态 / 账号库**

- 二级页签用**分段胶囊**（一级是下划线大标签）—— 两层长得不一样，一眼能看出自己在第几层；
  两层长得一样的话，用户会以为回到了同一层。
- 分组：登录状态 = 登录状态卡 + 当前账号卡；账号库 = 账号库卡 + 手动粘贴 Token
  （手动贴 token 是"再加一个号"的另一条路，与「登录新账号」并列）。
- 与一级标签同一原则：用 `hidden` 属性切换，不靠 CSS 类 —— 万一样式没加载，
  退化成"两页都显示"（难看但能用），而不是"除了一页全空白"。
- 深色主题的坑：选中态用 `--bg2` 铺在 `--bg1` 上，而深色里这两档只差 7 级、几乎看不出，
  必须再补一圈 `--bd2` 描边才立得住（实测不加就跟没选中一样）。

测试：新增 `check-account-add` 13 项（标志语义 / TTL 失效 / 默认语义不变 / 添加模式不切换 /
`created` 判定 / 空库边界 / **只生效一次** / 反复进出不串味），并做了**两轮反向验证**：
把"不切换"与"一次有效"分别改坏，测试立刻变红（3 项 / 1 项）。
`check-bundle` 加 5 条产物断言。

## 0.1.27 — 2026-09-12

### 改：导出/导入备份改成弹**系统文件对话框**（不再让人手打路径）

用户反馈：导入要在一个输入框里手打备份文件路径；导出只能落到插件目录、不能自己选位置。
两者都应该弹一个系统对话框让人选。

**先得解决一个架构限制**：插件宿主跑在 Electron 的 **utility 进程**里，那里
`require('electron')` 只暴露 `net` 与 `systemPreferences`（0.1.22 的能力探测实测），
而 `dialog` 是**主进程**模块 —— 也就是说"弹系统文件框"宿主侧根本做不到，
只能由**渲染进程**（插件界面所在之处）用 Chromium 自己的能力完成：

| 场景 | 机制 | 为什么用它 |
|---|---|---|
| 打开文件 | `<input type="file">` | 任何 Chromium 都支持。Chromium 150 起跨域 iframe 被禁止弹 File System Access 文件框，这个不受影响，是最可靠的手段 |
| 另存为 | `showSaveFilePicker()` | File System Access API，Electron 有实现（Electron 30+ 那个已知问题只是对话框里多一行提示文案，不是不可用） |
| 取真实路径 | `window.__DSH_DESKTOP_FILE_PATH__` | DSH 注入的 preload 桥（`webUtils.getPathForFile`），注释写明"只解析操作者选中的、真实落盘的 File" |

**改动**

- 新增 `src/file-picker.ts`：三项能力各自做**探测 + 优雅回退**，都能缺失。
- **导出**：先弹系统「另存为」，位置和文件名由用户定；内容在用户选完之后才去取。
  拿不到系统对话框（宿主未注入 / 平台拒绝）时**回退**到原来的"宿主写 `exports/` 并回显路径"，
  功能不失效、只是不能选位置 —— 回退时界面会说明原因。
- **导入**：点按钮弹系统「打开」框选文件，**删掉**"请填写备份文件路径"输入框。
  拿得到真实路径时**只把路径交给宿主**（宿主自己读文件，凭证明文不进 HTTP）；
  拿不到才退回"界面读内容再交给宿主"。
- 新增 `POST /accounts/export-json`：供界面「另存为」取内容。
  ⚠️ 这条路会把明文凭证交给渲染进程 —— 是在"让用户自己选位置"与"凭证不出宿主"
  之间的**显式取舍**（本机回环 + DSH 同源守卫），理由写在路由与 `exportAccounts()` 的注释里。
  凭证不出宿主的那条 `/accounts/export` **始终保留**作为回退。
- 备份文件名改为 `deepseek-accounts-YYYYMMDD-HHMMSS.json`。
  不能直接拿 `toISOString()` 当文件名 —— 它带冒号，在 Windows 上是非法文件名字符。

**两个不显眼但会踩的点（都写进注释、并由测试守住）**

1. **必须"先弹框、再取内容"。** Chromium 的瞬时用户激活有时限，反过来
   （先 `await` 取备份再弹框）在真机上会被判成"没有用户手势"而直接抛错。
   所以 `saveWithPicker()` 收的是**回调**而不是现成的文本 —— 顺序锁在函数里，调用方想写错都难。
   测试断言的是**调用顺序本身**（`picker → produce → write → close`），并做了反向验证：
   把顺序改反，这条测试立刻变红（实测报了 `实际顺序 produce → picker → write → close`）。
2. **取消不是错误，且取消时不该去取内容。** 用户点了取消却仍然把明文凭证从宿主拉进界面，
   是无谓的多暴露一次。`AbortError` 被单独识别成 `cancelled`，与真失败分开处理。

测试：新增 `check-file-picker` 23 项（建议文件名的非法字符、路径桥各种坏值容错、
另存为四种结果分类、顺序断言、取消时不取内容、打开框的 DOM 清理与取消、
导入来源的 path / content / unreadable 三分支）；`check-bundle` 加 5 条产物断言，
其中一条是**负向**的：产物里不许再出现"要导入的备份文件路径"。

## 0.1.26 — 2026-09-12

### 把账号当一等公民管理（借鉴 workbuddy-switch 的 5 项 + 1 项检查更新）

参考项目 <https://github.com/changexbc/workbuddy-switch>（MIT，227★）管理 WorkBuddy /
CodeBuddy CLI / CodeBuddy CN IDE 三个目标的账号切换、积分到期、签到、Token 保活、自动更新。
逐条判断后，**只搬适用的部分**：

**① 账号库（多账号并存 + 一键切换 + 导入导出）**

以前只有一份凭证文件，换号的代价是「退出 → 清浏览器分区 → 重新登录 → 等捕获」，
期间原来的号也回不去。现在：

- `accounts/<id>.json` 一账号一文件 + `accounts.json` 索引（当前指针）；原子写 + 0600。
- **旧单账号文件自动迁移**（只在库为空且旧文件存在时跑一次，旧文件改名留档）。
- 去重按 `serverId` → token：同一个号重复捕获是**更新**而不是新增。
- 移除 = **删除凭证文件**（不做"改名归档"）：「登出」的语义就是这份凭证不该再留在磁盘上。
- 导入/导出：导出**写到本机文件并只回传路径**，不把明文 token 塞进 HTTP 响应。

**② 受限状态可视化 + 恢复倒计时**

`isMutedError` / `muteUntilMs` 早就在解析 `mute_until` 了，但只在**失败那一刻**拼进错误消息。
现在把它记到账号上（`limit.untilMs`），设置页常驻显示「还剩 X 小时 Y 分（MM/DD HH:mm 解除）」，
30 秒粒度自己走定时器刷新（不产生请求）。

> ⚠️ 这个状态**只能从"生成被拒"里学到** —— 账号受限期间 `users/current` 依然返回 200。
> 所以探活探不出限制，两者是两件事。

**③ 登录态主动探活（只读、零额度、可关）**

参考项目是"操作前不足阈值就刷新 token"；我们这边没有 refresh token 可刷（网页端 token
只能靠重新登录拿新的），所以做的是**尽早发现失效**：启动后 20 秒探一次、之后每 30 分钟一次
（`probeIntervalMs`，0 = 关闭），走只读的 `users/current`。失败**只提示、不阻断**。
结果写回**发起探活时那个账号**（按 token 匹配）—— 探活期间切了号也不会记到新账号头上。

**④ 本地调用台账（请求密度 + 失败分类）**

节流"到底有没有效"不能靠感觉。台账按天记 JSONL（只留近 7 天、只记元信息，不含对话内容与凭证），
设置页看两个数：**相邻对话间隔**（中位/p90/最短 —— 最短间隔直接对应"有没有连环请求"）
与**失败分类**（限流 / 账号被限制 / 鉴权 / 网络）。间隔只统计 `purpose === 'chat'`：
会话标题生成是 DSH 自己发的旁路请求，算进去会让分布失真。

**⑤ 检查更新（比对 GitHub Releases）**

插件装不了包，所以只做"检查 + 给链接"。8 秒超时 + 优雅失败（GitHub 在国内常连不上，
失败要如实说"没查到"，不能把设置页卡住）。走当前传输层。

**⑥ 新增第 5 个标签「关于」**

版本与更新 / 数据位置 / **为什么没有自动换号**。
最后一条是刻意放给使用者看的：风险说明只写在代码注释里等于没写。

### 刻意**没做**的（各有原因，不是遗漏）

| 项 | 为什么不做 |
|---|---|
| **自动轮换换号** | 参考项目切的是"CLI 下次启动用哪个账号"，服务端看不到；我们每次对话都实时发请求 —— 自动换号是极强的机器行为特征，与本插件在传输层指纹 / 随机间隔 / 会话清理上"降低机器可识别性"的努力**直接冲突**。且同一服务商会关联多账号，处置可能更重。**只做手动切换。** |
| 会话复制 | 我们的对话存在 DSH 本地、每轮全量重发、网页端不留会话 —— **架构上不需要**（换账号对话本来就跟着走） |
| 自动签到 | DeepSeek 网页端没有签到机制 |
| Token 多维统计图表 | 免费网页端不返回 token 计数，数据支撑不住 |

上述判断同时写在 `src/accounts.ts` 的模块注释里（带 ⚠️ 风险小节），由 `check-bundle` 守住。

### 其它

- `auth.ts` 退化成"账号库门面"（`readAuth` / `writeAuth` / `clearAuth`），
  适配器、登录流程、诊断等**所有调用点一行未改**。
- `paths.ts` 单独拆出（避开 auth ↔ accounts 的 import 环）。
- adapter 新增**一个**统一钩子 `noteCall`（受限记录与台账共用，不是两个钩子）。
- `AdapterLlmError` 带上 `mutedUntilMs` 绝对值 —— 不让调用方去解析错误文案里的时间。

测试：新增 `check-accounts`（16 项）、`check-smoke`（8 项），`check-logout` 适配账号库；
`check-bundle` 加 15 条产物断言（含"源码注释里必须写明为何不做自动换号"）。

## 0.1.25 — 2026-09-12

### 修：副标题在切换标签时突然折成两行（并断在连字符处）

用户实测：切到「账号」页时副标题变两行、切到「模型」页又变回一行。

**根因不是样式写错，是这行文字正好压在折行边界上**：

- 原副标题 78 字，单行需要 **558px**；而宿主设置面板的内容宽约 **560px**。
- 「账号」页（3 张卡）比「模型」页高 → 面板出现纵向滚动条 → 内容宽度少十几像素
  → 最后一个词掉到第二行，而且断在 `deepseek-web` 的**连字符**处，看着像故障。

实测复现（同一字体栈，量 `getBoundingClientRect` 的高度）：

| 容器宽 | 旧版 | 新版 |
|---|---|---|
| 560px | 1 行 | 1 行 |
| **545px** | **2 行** | 1 行 |
| 520px | 2 行 | 1 行 |
| 480px | 2 行 | 1 行 |

**改动**

- 副标题缩到约 **467px**（58 字），留 ~90px 余量 —— 切标签、缩放窗口都不会再翻行；
  provider 信息保留，只是不再单列一段。
- 给 `deepseek-web` 套 `.dsw-nobreak{white-space:nowrap}`：万一将来更窄，
  也只会整词换行，不会再断成 `deepseek-` / `web`。
- 源码里留了宽度预算注释（"以后改这句话保持单行 ≲470px"）与量法。

测试：`check-bundle` 新增 1 条产物断言（`.dsw-nobreak` 存在）。

## 0.1.24 — 2026-09-12

### 设置页拆成标签页：一次只显示一页，不再一页到底

7 张卡堆在一页，「找某一项」要滚很久。按「什么时候会用到它」拆成 4 页：

| 标签 | 内容 |
|---|---|
| 账号 | 登录状态 · 当前账号（退出 / 换号）· 手动粘贴 Token |
| 模型 | 可用模型 · 连通性测试 |
| 防风控 | 请求节流（并发开关 · 间隔区间 · 会话清理） |
| 传输层 | 传输层（指纹）+ 一键测试 |

- 标签栏样式取自同类插件（下划线指示 + 未选中 70% 透明度），装进**带边框的圆角容器**；
  颜色全部走 `--dsw-alias-*` 令牌，浅色/深色自动跟随，不写第二份样式。
- **操作反馈条提到标签栏之上常驻** —— 拆页之后，在「账号」页点按钮的反馈若落在别的页里
  就等于看不见，所以它不归属任何一页。
- 顺手调了两处顺序：**「登录状态」排在「当前账号」之前**（先结论、后细节）；
  **「可用模型」排在「连通性测试」之前**（测试卡的模型下拉正是来自这张列表）。
- 无障碍：`role=tablist / tab / tabpanel` + `aria-selected`；页容器用 `hidden` 属性切换
  （不靠 CSS 类，避免样式缺失时所有页同时显示）。

测试：`check-bundle` 新增 4 条产物断言（页签骨架、四个页签齐全、反馈条、传输层卡），
防止以后重构把标签页弄丢。

> 注：README 里的设置页截图是拆页之前拍的，重启后可以换新的。

## 0.1.23 — 2026-09-12

### 传输层可切换：默认改走 Chromium 网络栈（消除「非浏览器客户端」特征）

0.1.22 的 net.fetch 诊断三项全绿后，把主请求路径接上。三方指纹对比（同机同日实测）：

| | JA4 | cipher 列表哈希 | ALPN |
|---|---|---|---|
| Node fetch(undici) | `t13d5212h1_…` | — | **h1** |
| Chrome（本机 152） | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `8daaf6152771` | h2 |
| **net.fetch（Electron 43）** | `t13d1516h2_8daaf6152771_806a8c22fdea` | **`8daaf6152771`** | h2 |

cipher 列表哈希与 Chrome **逐字节一致**，ALPN 与 cipher 数量（15）也都对上；
唯一差异是扩展数 16 vs 17 —— Electron 43 内置 Chromium 150、本机 Chrome 是 152，
差两个大版本，属正常。流式（`response.body` + AbortSignal）与鉴权（只读 `users/current` 200）均通过。

**改动**

- 新增 `src/transport.ts`：`chromium` / `node` 二选一 + 设置持久化
  （`<DSH_HOME>/web-login/transport.json`）+ 环境降级判定。
  降级只看**能力**（拿不到 `electron.net.fetch`），**不做「请求失败后换一条重试」** ——
  完成请求重发可能就是一次重复生成，代价比"切错了手动改回来"大得多。
- 宿主启动时按设置**一次性注入**；webapi 保持与环境无关（不 require electron，单测天然不碰）。
- 设置页新增「传输层（指纹）」卡：切换即时生效，外加**一键测试**（调诊断端点，零额度，
  直接回显 ①指纹 ②流式 ③鉴权 三项结论）。环境不支持 Chromium 时该选项自动禁用并说明原因。
- 新增接口 `GET/POST /deepseek-web-login/api/transport`；`/status` 的 config 带上 `transport`。
- 启动日志打印 `传输层=chromium|node`，降级时显式标注。

⚠️ **行为变更**：Chromium 网络栈会跟随**系统代理**，而 Node fetch 完全无视代理。
若梯子关闭时系统代理仍指向 `127.0.0.1:7897`，切到 Chromium 后请求会失败 —— 设置页切回 Node 即可。
这条提示常驻在卡片说明里。

测试：新增 `check-transport` 11 项 —— 默认值、路径跟随 DSH_HOME、读写往返、损坏/非法值容错、
非 Electron 环境降级且**如实标记 degraded**、切换后注入层真的跟着变、降级后 fetch 不能丢、
反复切换稳定、`apply` 能纠正外部对注入层的改动。

## 0.1.22 — 2026-09-12

### 新增：可注入传输层 + `net.fetch` 诊断（为「请求从哪出去」做验证）

**为什么**：实测 Node 的 `fetch`（undici）与 Chrome 的 TLS / HTTP2 指纹是**结构性差异** ——
JA4 的 `h1` vs `h2`、Node 完全不带 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同。
也就是说请求在 **TLS 层**就能被判定为「非浏览器客户端」，而这几项**调参修不了**。
参考项目 cuckoo-code（106★）与 deepseek-pp（1849★）都**不让 Node 发请求**（前者内嵌浏览器、
后者 hook 用户浏览器），从未被风控 —— 印证「请求从哪出去」才是关键差异。

**发现**：DSH 本体是 Electron，插件宿主是 **utility 进程**。官方文档写明 `net` 模块适用
Main + Utility，且 utility 的网络请求默认走 Chromium 的 system network context。
实测能力探测确认：utility 进程里 `require('electron')` 只暴露 `net` 与 `systemPreferences`，
其中 **`net.fetch` 是 function** —— 于是不必引入 uTLS / curl-impersonate，换一处传输层即可。

本次只做**验证**，不动主请求路径：

- `src/webapi.ts`：新增 `setFetchImpl()` / `fetchImplKind()`，9 处请求统一改走可注入的 `activeFetch`。
  ⚠️ 它是**每次现取**（`injectedFetch ?? fetch`），而不是在模块加载那一刻固化 —— 固化写法会让
  「模块加载后再替换 `globalThis.fetch`」失效（单测正是这么打桩的），请求会绕过桩件**真的出网**；
  这类回归**不会让任何功能报错**，只会让一批测试静默失去意义。已单独加测试守住。
- `src/net-diagnostics.ts`（新）：三步**零额度**探测 ——
  ① TLS/HTTP2 指纹 ② **能否读流式响应**（`response.body` + AbortSignal，用本地分块服务确定性验证；
  拿不到 body 就等于整条改造路线不成立）③ 鉴权（只读 `users/current`，不生成内容）。
  另有一档 `stream`：额外来一次迷你 completion，端到端验证 DeepSeek 的 SSE（会消耗一点额度）。
- 触发方式：`POST /deepseek-web-login/api/diagnostics/net-fetch`（body `{"mode":"probe"|"stream"}`）；
  或往 `<DSH_HOME>/web-login/probe-request.json` 写 `{"mode":"probe"}` 后重启 DSH ——
  宿主进程的 HTTP 端点只有 DSH 自己的同源页面打得通（从外部 curl 会撞同源守卫，实测任何路径都 403），
  这条路不依赖 HTTP。读完把文件改名为 `*.done-<时间戳>`（不删文件）。
- 启动时打印一次能力清单（`process.type` / Electron 版本 / `require('electron')` 暴露了哪些 API），
  排查环境问题时一眼可见。

测试：新增 `check-fetch-injection`（5 项）与 `check-net-diagnostics`（13 项）。
后者对流式探针做了**正反两向**验证（"整体缓冲的响应必须被判为不可用"），避免出现永远绿灯的假判据。

**主请求路径仍未改动** —— 是否切到 `net.fetch`，等诊断结果确认后再决定。

## 0.1.21 — 2026-09-12

### 改进：把「机器特征」压下去（行为侧）

参考同类项目 cuckoo-code（同场景、从未被风控，分析见仓库外文档 `cuckoo-code 借鉴分析.md`）后做的两处行为优化。

- **请求间隔：固定值 → 随机区间**（默认 `2000~4000ms`）。
  固定间隔的方差≈0，在统计上就是明显的「定时器特征」；cuckoo-code 用的正是 2000~4000 随机区间。
  - 设置页改为**两个滑块**（下限 / 上限）+ 三个区间档位（1500~2500 / 2000~4000 推荐 / 5000~9000）。
  - **老配置兼容**：只设了 `minRequestIntervalMs`（0.1.20 的写法）时，上限自动跟随下限
    —— 语义仍是「固定间隔」，升级后行为不变。
  - 上下限被拖成非法组合（上限 < 下限）时自动纠正，不会出现负区间。
- **临时会话：每轮建+删 → 攒批集中清理**（默认 `sessionCleanup: 'deferred'`）。
  「每轮新建一个临时会话、用完立刻删掉」是最强的机器行为特征之一（真人不会每 30 秒建删一次对话）。
  - `deferred`：攒够 `sessionCleanupBatchSize`（默认 8）个、或等满 `sessionCleanupDelayMs`
    （默认 90 秒）后集中清理；清理时**优先用一个请求批量删**
    （服务端支持的话 N 个会话只花 1 个请求），不支持则自动回退逐个删且此后不再尝试。
  - `immediate`（老行为，1.5s 后逐个删）/ `keep`（不删，请求最少但网页端会留下临时会话）。
  - 设置页新增「会话清理」三选一。
  - **为什么不直接复用会话**：DSH 每次交全量历史，而网页端会话有状态，复用会让上下文翻倍撑爆窗口，
    所以只能优化删除侧（原因写在代码注释里）。

### 测试

- `check-request-gate` 19 → **23 项**：区间随机性（不同随机源得到不同等待，证明不是固定值）、
  上下限相等退化为固定、老配置兼容、非法组合自动纠正。
- 新增 `check-session-cleaner` **10 项**：三档策略、攒批阈值不提前触发、延迟触发、
  **批量删 3 个只花 1 个请求**、业务错误回退逐个删且此后不再尝试批量、网络异常仍可重试批量、
  keep 不发任何请求、清理失败不抛错。
- `check-bundle` 补 3 条产物断言。


## 0.1.20 — 2026-09-12

### 新增：设置页直接可调（开关 + 滑块）

- 新增「**请求节流（防风控）**」卡片：**允许并发**开关、**最小间隔**滑块（0~30 秒，步长 500ms）、
  三个快捷档位（1500 / 3000 推荐 / 8000）。开关打开时轨道显示为**红色**（风险提示）。
- 改完**即时生效**（闸门新增运行时 `configure`，不必重启），并自动落盘到
  `${DSH_HOME:-~/.dsh}/web-login/gate.json`。
- 优先级：**设置页保存的值 > cordis config > 内置默认** —— 设置页是用户的显式操作，
  不该被配置文件里的旧值盖回去。
- 新增 host API：`GET /deepseek-web-login/api/gate`（读，含档位与上限）、
  `POST`（写：校验 → 应用 → 落盘）。落盘失败时如实返回 `persisted: false` 并注明「重启后会回到旧值」，
  而不是假装成功。
- 适配器改为接受外部注入的闸门实例（宿主与设置页共享同一个，改完立即作用于后续请求）；
  缺省仍可自建，单测不受影响。

### 测试

- `check-request-gate` 13 → **19 项**：`configure` 运行时改设置与范围夹取、`clampInterval` 边界、
  推荐档位必须包含默认值（防止「推荐」按钮指到别的值）、设置文件写入读回、
  损坏与非法字段容错、**落盘值与 configure 结果一致**（模拟重启后行为不变）。

## 0.1.19 — 2026-09-12

### 新增：请求节流与并发开关（防风控）

- **`minRequestIntervalMs`（默认 `3000`）**：两次网页端调用之间的最小间隔，
  按上一次调用**结束**时刻计算（不是开始 —— 长回答之后不会白等）。
- **`allowConcurrent`（默认 `false`）**：是否允许同一账号并发请求；默认**串行**，多个调用按 FIFO 排队。
- 新增 `src/gate.ts`（`createRequestGate`），闸门包在**每一次**模型调用外层（`gatedStream`），
  因此 DSH 的会话标题生成（`options.purpose === 'session-title'`）与压缩等辅助调用**一并受控**。
- 设置页「登录状态」卡新增「请求节流」一行，显示当前生效值；`/status` 同步返回这两项配置。

### 为什么要默认开启（实测证据）

- 从插件日志反推 272 轮调用的起止时间，发现 **16 对真重叠**：重叠的一方总是主回答
  （数百字 / 6~40 秒），另一方只有 **8~17 字 / 1~3 秒** —— 那正是 **DSH 的会话标题生成**。
  也就是说，主回答还在跑的时候，同一个账号上已经又发出一个请求了。
- 网页端同一账号同时只能生成一条，并发生成会被拒（`A message is being generated…`）；
  更严重的是**账号级限制** —— 实测双窗口并发生成不到 6 分钟即触发 **1 天**的临时封禁。
- 默认值取 3000ms 的依据：272 轮里非重叠情况下的相邻调用间隔**中位数为 3.9s**，
  3s 的下限既压住密集连发，又不会让正常步骤明显变慢。
  调值建议见 README「请求节流」一节（1500 / 3000 / 8000 三档）。

### 测试

- 新增 `check-request-gate` **13 项**：串行与并发开关、首次调用不等待、间隔从「结束」起算、
  间隔设 0、FIFO 顺序、release 幂等、**流抛错与消费者中断都不漏名额**、
  未迭代的 generator 不占位，以及一组对照实验（串行下标题必须等主回答结束 /
  并发模式下确实复现重叠 —— 防止「假绿灯」）。
- `check-bundle` 补 3 条产物断言（闸门进了产物、覆盖 session-title、设置页显示节流策略）。

## 0.1.18 — 2026-09-12

### 修复（界面）

- **浅色主题下设置页仍是黑底**（用户实测）：样式表全程引用 `var(--theme-text, #ddd)` 这套**宿主并不存在**
  的变量名 → 每个颜色都落到兜底值，而兜底全是深色（`#151922` / `#0f1115` / `#2a2f3a`），
  于是切任何主题都是黑底 + 灰字，几乎读不出来。
  - 改为宿主真实令牌 **`--dsw-alias-*`**（共 90 个，值由 DSH 按当前主题重定义，插件继承即自动跟随）。
  - 再加一层兜底：`var(--dsw-alias-xxx, var(--fb-xxx))`，`--fb-*` 由 `prefers-color-scheme` 切换 ——
    即使令牌改名/缺失，也不会再出现「浅色主题里的黑界面」。

### 改进（观感）

- 正文由 `ui-monospace`（等宽铺满，观感像终端日志）改为系统无衬线栈；等宽只留给命令、代码与输入框。
- 卡片：圆角 12px + 主题描边；信息表按行细分隔线；徽章改胶囊形并用半透明语义色。
- 按钮：主按钮改用 `brand-primary` + `label-primary-foreground`（浅色下黑底白字、深色下白底黑字，自动反色），
  并区分默认 / 幽灵 / 危险 / 二次确认四态，带 hover 过渡；输入框聚焦有描边。
- 连通性测试输出改为左侧 3px 语义色条；模型列表去掉虚线分隔；滚动条轻量美化。

### 测试

- 用到的 15 个 `--dsw-alias-*` 变量名逐个与宿主令牌清单比对 → 缺失 0；
  产物核对与全部用例继续通过。

## 0.1.17 — 2026-09-11

### 改进（限流）

- **连续被限流时退避渐长**：原来是固定 20s，重试全落在限流窗口里 → 反复失败。
  现在按连续次数递增：20s → 40s → 80s…（上限 90s，再叠 0~30% 抖动避免多请求扎堆），
  5 分钟没再被限就重新计数。
- 节流退避与并发退避（5s）继续分开：节流是账号级，等太短等于白撞。

### 测试

- `check-session-lifecycle` 15 → **16 项**：连续两次节流的退避必须递增（且落在 20s~90s+抖动区间）。

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
