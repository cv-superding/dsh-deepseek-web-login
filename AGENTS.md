# AGENTS.md — 给 AI 编码助手的项目约定

本仓库是 **DSH（DeepSeek Harness）插件** `dsh-deepseek-web-login`：
用 chat.deepseek.com 的网页版登录态驱动 DSH agent，不依赖官方 API key。

给在本仓库工作的 AI 助手（以及新加入的人）：下面这些是**踩过坑之后固化下来的约定**，
不是风格偏好。违反它们通常不会立刻报错，而是"过一会儿才发现不对"。

---

## 1. 先读这几个文件，别急着改

| 想改什么 | 先读 |
|---|---|
| 任何东西 | `CHANGELOG.md` 最近几条 —— 大量设计决定的原因写在里面 |
| 界面样式 / 主题 | `src/client/index.ts` 顶部的样式表注释（为什么用 `--dsw-alias-*`） |
| 请求相关 | `src/gate.ts`（节流）、`src/webapi.ts`（协议）、`src/transport.ts`（传输层） |
| 账号 / 凭证 | `src/accounts.ts` 的模块注释（**含多账号轮换的风险说明**）、`src/auth.ts` |
| 测试怎么写 | `tests/check-accounts.mjs`（结构清晰）与 `tests/check-request-gate.mjs`（含反向验证） |

---

## 2. 硬性约定

### 2.1 界面颜色只能走宿主主题令牌

用 `--dsw-alias-*`（经样式表顶部的 `--fg` / `--bd` / `--accent` 等别名使用），
**绝不自己写死颜色**，也不要用 `--theme-*`（那套变量在 DSH 里**根本不存在**，
用了会让每个颜色都落到深色兜底值 → 浅色主题下整个面板是黑底）。

### 2.2 文案有"宽度预算"

副标题这类单行文案要控制在 **≲470px**（12px 字体下）。
超过宿主面板内容宽（约 560px）就会折行，而且会因为滚动条出现/消失而**在两个标签页之间表现不一致**
（0.1.25 修过这个）。量法：`white-space:nowrap` 的 span 取 `getBoundingClientRect().width`。

### 2.3 不要在模块加载时固化全局对象

```js
let activeFetch = fetch                    // ✗ 单测"加载后替换 globalThis.fetch"会失效
const activeFetch = (i, init) => (injected ?? fetch)(i, init)   // ✓ 每次现取
```

固化写法的后果是**请求绕过测试桩件真的出网**，而且**不会让任何功能报错** ——
只会让一批测试静默失去意义。参见 `tests/check-fetch-injection.mjs`。

### 2.4 测试要配反向验证

只测"正常路径通过"会得到永远绿灯的假判据。每条关键判据都要问：
**"如果实现坏了，这条测试会红吗？"** 拿不准就把坏实现临时改回去跑一遍。
（已有先例：`check-request-gate` 用"并发模式下必须真的复现重叠"证明串行断言不是白捡的绿灯。）

### 2.5 凭证类数据的安全底线

- 账号库/导出的备份都是**可完整登录的凭证**：**永不回传 HTTP 响应**（导出写文件、只回传路径）。
- "退出/移除账号" = **删除文件**，不做"改名归档"（`登出` 的语义就是这份凭证不该留在磁盘上）。
- 日志里绝不打印 token / cookie（已有 `maskIdentifier`）。

### 2.6 涉及"绕过风控"的功能要想清楚再动

本项目在传输层指纹、随机间隔、会话清理上做的努力，目标是**降低机器可识别性**。
任何"更激进"的想法（典型：检测到限流就自动换账号继续发）都会与它**直接冲突**，
而且同一服务商会关联多账号，处置可能更重。**只做手动切换，不做自动轮换** ——
原因写在 `src/accounts.ts` 的模块注释里，由 `check-bundle` 守着。

---

## 3. 开发流程

```bash
npm ci                         # 或 npm install（首次）
node scripts/build.mjs         # 构建 host(lib/index.js) + client(lib/client.js)
node scripts/test-offline.mjs  # 全量离线用例（tests/check-*.mjs + logic-test.mjs）
node tests/check-bundle.mjs    # 产物核对：关键改动有没有真的进 lib
```

`bash scripts/build.sh` 仍可用（它只是转调 `node scripts/build.mjs`）。
构建**不再**通过 npx 联网下载 tsdown：缺依赖时会直接报错并提示 `npm ci`。

**提交前必须做到**：全部测试文件退出码 0（`tests/probe-*.mjs` 会真的打网络，默认跳过）。

**发版流程**（一次一个 tag，别批量推 —— 批量推 tag 会整体不触发 workflow）：

```bash
# 1) 改 CHANGELOG.md（工具会从里面取 release 说明）
# 2) 同步 package.json 与 src/version.ts 的 FALLBACK_VERSION（check-smoke 会守住）
# 3) git tag vX.Y.Z && git push origin vX.Y.Z    ← 单独推这一个 tag，CI 自动建 Release
```

---

## 4. 本地验证界面（没有浏览器自动化环境时）

`agent-browser` 在本机没装（要拉 ~500MB）。轻量做法：

- **截图**：系统 Chrome 无头模式 + `--virtual-time-budget=4000`
  （不加这个参数常常截到白屏）。详见技能 `html-visual-check`。
- **量数字**：要判断"会不会折行 / 溢出"时，别靠看图 —— 用 `--dump-dom` 把
  `getBoundingClientRect` 的结果写进 DOM 再读出来，一次能量出"临界宽度"，还能写进提交信息当证据。

---

## 5. 与用户协作的注意

- 用户是**非金融/非脚本方向的开发者**，但技术不弱：讲解用大白话 + 类比，**结论先行**。
- **不要写"浓浓的 AI 味"的文案**（避免"核心逻辑是…""一句话总结…"这类套话堆砌，少用 emoji）。
- 用户明确要求过：**做"修改类"工具必须自带还原/回滚**；本机**禁止删除文件**时用改名代替。
- 改动界面这类"审美相关"的事，**先给 HTML 预览让用户挑**，确认后再动插件代码。
