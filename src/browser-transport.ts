/**
 * 浏览器代理传输层 —— 当官方 DSH 桌面端拿不到 `electron.net.fetch` 时，
 * 用系统里的 Edge/Chrome 进程当请求出口，让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 机制：启动一个 headless 浏览器（独立 profile），通过 CDP 在页面上下文里调用 `fetch()`，
 * 请求实际从浏览器网络栈发出。响应通过 `Runtime.addBinding` 建立的回调分块传回 Node，
 * 再包装成标准 `Response`（含 ReadableStream）交给插件。
 *
 * 为什么不用 electron.net.fetch：官方 DSH 把插件跑成 ELECTRON_RUN_AS_NODE=1 的 Node 子进程，
 * require('electron') 拿不到 net.fetch。本模块是绕过这个限制的后备方案。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildBrowserArgs,
  transportExtraArgs,
  CdpClient,
  findSystemBrowser as findSystemBrowserImpl,
  parseDevToolsActivePort,
  type BrowserCandidate,
} from './browser-login.ts'
import {
  installPageSessionViaCdp,
  pageSessionFromHeaders,
  runPageSessionInstall,
  type PageSessionSlot,
} from './page-session.ts'
import { activeAccountId, listAccounts } from './accounts.ts'
import type { PageObservation } from './transport-heartbeat.ts'

/** 暴露给测试/诊断：找系统浏览器。 */
export const findSystemBrowser = findSystemBrowserImpl

const BINDING_NAME = '__dshBrowserTransportCallback'
const PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login', 'transport-profile')

/**
 * 传输层页面应该站在的 origin。**故意不 import `webapi.ts` 的 `DS_BASE`**：
 * 依赖方向是 `webapi → browser-transport`，反向 import 会形成循环
 * （`browser-login.ts` 里那种写法能跑，是因为只在函数内用；这里为了不给自己埋雷就本地定义）。
 * ⚠️ 两者必须相等 —— 由 `tests/check-browser-transport.mjs` 的一条用例守着。
 */
export const TRANSPORT_SITE_ORIGIN = 'https://chat.deepseek.com'

/**
 * 🔴 **禁止头名 —— 在页面里 `fetch()` 时浏览器会静默忽略它们。**
 *
 * 这不是"我们发得不好"，是 Fetch 规范写死的：这些头由浏览器自己决定，
 * 脚本设了也**不报错、直接丢**（`Cookie` / `Origin` / `Referer` / `Host` /
 * `Content-Length` / `Connection` 都在名单里）。
 *
 * ## 为什么必须知道这件事（2026-10-14 发现）
 *
 * `webapi.ts` 把 cookie 塞进 `headers.cookie`，而传输层是把 headers **原样交给页面里的
 * `fetch`** ⇒ 走浏览器传输层时 **cookie 一个都没发出去**，一直只靠 `Authorization`。
 * 同一个插件在 undici 回退路径上是**能发 cookie 的**（那是 Node，不受禁止头约束）
 * ⇒ 两条传输路径的行为不一致，而浏览器路径是 0.7.0 起的默认路径。
 *
 * 正确做法见 `cookiesForCdp()`：走 CDP 的 `Network.setCookie`（它不受禁止头约束，
 * 而且**支持 httpOnly** —— 页面 JS 自己也写不了那几个真正决定登录态的 cookie）。
 */
const FORBIDDEN_PAGE_HEADERS = new Set([
  'cookie', 'origin', 'referer', 'host', 'connection', 'content-length', 'transfer-encoding',
])

/** 一次页面内 fetch 的头：真正交给 `fetch()` 的 + 需要另行安装的 cookie。 */
export interface PageFetchHeaders {
  /** 剥掉禁止头之后、可以安全交给页面 `fetch()` 的那些。 */
  headers: Record<string, string>
  /** 被剥掉的头名（原样保留大小写），供诊断/日志用。 */
  stripped: string[]
  /** 原始 `cookie` 头的值（没有则为空串）。 */
  cookieHeader: string
}

/**
 * 把请求头拆成"页面能发的"与"必须另行安装的"。
 *
 * `Origin` / `Referer` **不在这里补** —— 它们同样是禁止头，唯一正确的做法是
 * **让页面站在目标站点自己的 origin 上**（见 `ensureSiteOrigin()`）。
 * 这也是 2026-10-14 之前最实在的一个"不像真浏览器"的点：
 * 传输层启动在 `about:blank`，于是每个请求的 `Origin` 都不是站点的。
 */
export function splitBrowserFetchHeaders(input: Record<string, string>): PageFetchHeaders {
  const headers: Record<string, string> = {}
  const stripped: string[] = []
  let cookieHeader = ''
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase()
    if (!FORBIDDEN_PAGE_HEADERS.has(lower)) {
      headers[key] = value
      continue
    }
    stripped.push(key)
    if (lower === 'cookie') cookieHeader = value
  }
  return { headers, stripped, cookieHeader }
}

/** 按 `;` 拆 cookie 头。**用第一个 `=` 切分**：值里可能含 `=`（base64 padding 很常见）。 */
export function parseCookieHeader(cookieHeader: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  for (const part of String(cookieHeader ?? '').split(';')) {
    const sep = part.indexOf('=')
    if (sep < 0) continue
    const name = part.slice(0, sep).trim()
    const value = part.slice(sep + 1).trim()
    if (!name) continue
    out.push({ name, value })
  }
  return out
}

/**
 * 转成 CDP `Network.setCookie` 的参数。用 `url` 而不是 `domain`：
 * Chromium 会据此推导 domain/path/secure，少一处自己猜错的机会。
 */
export function cookiesForCdp(
  cookieHeader: string,
  url: string,
): { name: string; value: string; url: string; path: string }[] {
  return parseCookieHeader(cookieHeader).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    url,
    path: '/',
  }))
}

interface TransportRequestState {
  resolveHeaders: (status: number, statusText: string, headers: Record<string, string>) => void
  rejectHeaders: (err: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  streamStarted: boolean
}

interface BrowserTransportSession {
  browser: BrowserCandidate
  child: ChildProcess
  cdp: CdpClient
  cleanup: () => void
  /**
   * 页面登录态安装的两个槽位（`signature` / `installing`，语义见 `page-session.ts`）。
   *
   * 🔴 用**签名**而不是一个 boolean：多账号下换了号，页面还停在旧账号的登录态上，
   * 就变成"页面是 A、请求带 B"—— 比不装更假。签名变了就重装一次。
   * 放在独立字段里而不是摊平到本接口上，是为了能整体交给 `runPageSessionInstall`
   * （顺序语义由那个被测函数持有）。
   */
  pageSession: PageSessionSlot
}

let activeSession: BrowserTransportSession | undefined
let launchPromise: Promise<BrowserTransportSession> | undefined
const requests = new Map<string, TransportRequestState>()

/**
 * 上一个 transport 浏览器是否真的退出了。
 *
 * 不靠"谁调了 cleanup"记账，而是直接订阅 `exit` 事件：进程退出是**唯一**能保证
 * 文件句柄已放开的事件。`cleanup` 只是顺手把这里复位，好让下一次 `kill` 不被提前
 * 判定为"已经在退出了"。
 */
let exitState: 'none' | 'exiting' | 'exited' = 'none'
let settleExit: () => void = () => {}

/**
 * 等到上一个浏览器退出为止（有上限）。
 *
 * 超时不算失败：调用方接着尝试改名，最坏情形是改名也失败、保留旧目录继续启动 ——
 * 那仍然比"整个传输层起不来"好。这里不抛错是刻意的，别改成 throw。
 */
async function waitForPreviousTransportExit(): Promise<void> {
  if (exitState !== 'exiting') return
  await Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TRANSPORT_EXIT_GRACE_MS)
      const done = settleExit
      settleExit = () => {
        clearTimeout(timer)
        done()
      }
    }),
    new Promise<void>((resolve) => setTimeout(resolve, TRANSPORT_RECLAIM_TIMEOUT_MS)),
  ])
}

export function systemBrowserAvailable(): boolean {
  // 测试隔离：单测/CI 可以强制关闭浏览器代理，避免依赖本机浏览器。
  if (process.env.DSH_NO_BROWSER_TRANSPORT === '1') return false
  return findSystemBrowser() !== null
}

const TRANSPORT_EXIT_GRACE_MS = 3_000
/**
 * 回收旧传输层浏览器的总等待预算。
 *
 * 卡住的情形是 Windows 上"目录里还有被占用的文件"：`taskkill` 给出了强杀信号，
 * 但浏览器要逐个进程退出，句柄才真的放开。3 秒够用完整体退出的浏览器走完，
 * 又不至于把每次冷启动拖慢到用户能察觉。
 */
const TRANSPORT_RECLAIM_TIMEOUT_MS = 3_000

/**
 * 结束一个 transport 浏览器进程**连同它的子进程**。
 *
 * 🔴 为什么不能只 `child.kill()`（2026-10-17，Windows 实测）：
 *   headless 浏览器是多进程的（主进程 + GPU/renderer/utility/network 若干），
 *   Windows 的 `TerminateProcess` **不级联**后代进程。主进程一死，剩下的子进程就
 *   成了孤儿 —— 它们仍持有 `--user-data-dir` 下文件的独占句柄，于是下一次启动时
 *   "删旧 profile"必然 `EPERM`/`EBUSY`。Linux/macOS 上退出信号能走到整棵进程树，
 *   这个问题不显形，所以只有 Windows 要单独走 `taskkill /T`。
 *
 * 同步执行：调用点都在 `cleanup()` 这类不允许 await 的地方。`taskkill` 找不到进程
 * 时会返回非 0，忽略即可（进程本来就已经没了）。
 */
function killTransportTree(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform !== 'win32') return
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch {}
}

/**
 * 清空 transport profile 并重建。
 *
 * 🔴 为什么不是一句 `rmSync(PROFILE_DIR, { recursive: true, force: true })`：
 *   Windows 上删除目录要求**目录本身和目录里每一个文件**都能被删除。只要上一次的
 *   浏览器还活着（哪怕只是残留的 GPU 进程），`rmSync` 就会抛 `EPERM`，而它的
 *   `force: true` 只吞"文件不存在"，不吞 `EPERM`。插件因此**每次启动都失败**，
 *   而失败原因（"上一次的进程还在"）跟现象（"清理失败"）看起来毫无关系。
 *
 * 改成"先改名、再删旧名"：改名只要求父目录可写，不碰被占用的文件，所以在
 * "文件被锁"这种最常见的卡点上仍然能成功；旧目录改名后用 `best-effort` 删除，
 * 删不掉就随它去（下次启动还会再试）。
 *
 * 连改名都做不到（父目录本身被锁）时**保留旧目录继续启动**：浏览器启动时会复用
 * 已有的 user-data-dir，虽然带上了上一次的残渣，但比"整个传输层起不来"好得多 ——
 * 后者会让所有依赖它的请求一起失败。
 */
async function prepareTransportProfile(
  profileDir: string,
  waitForReclaim: () => Promise<void>,
): Promise<void> {
  if (existsSync(profileDir)) {
    // 先收掉仍占着这个目录的旧浏览器，否则改名也会失败（Windows 上"
    // 目录里有打开的文件"时 rename 同样被拒）。
    await waitForReclaim()
    let retired: string | undefined
    try {
      retired = `${profileDir}.stale-${Date.now()}`
      renameSync(profileDir, retired)
    } catch {
      retired = undefined
    }
    if (retired) {
      try {
        rmSync(retired, { recursive: true, force: true })
      } catch {
        // 删不掉就留着：占几十 MB，下次启动会再试，不影响功能。
      }
    }
  }
  try {
    mkdirSync(profileDir, { recursive: true })
  } catch (error: any) {
    throw new Error(`创建 transport profile 失败：${error?.message ?? error}`)
  }
}

/** 等 profile 里的 DevToolsActivePort 出现并返回端口。 */
async function waitForTransportDebugPort(
  profileDir: string,
  child: ChildProcess,
  timeoutMs = 25_000,
): Promise<number | undefined> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined
    try {
      const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2_000),
            redirect: 'error',
          })
          if (res.ok) return port
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return undefined
}

/** 找一个可用的 page target（启动时就带着站点 URL，见 `transportBrowserArgs`）。 */
async function findPageTarget(port: number, timeoutMs = 20_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = (await res.json()) as any[]
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

/**
 * 🔴 0.6.42：处理页面内 PoW 求解的回传（格式 `requestId + ':ok:' + 答案` 或 `':err:' + 原因`）。
 *
 * ⚠️ **用 `indexOf` 找分隔符、不是 split** —— 错误消息里可能含 `:`（如 "solve code=0"），
 * split 会把后半截丢掉；也**不能**用 `payload.split(':')` 后取 `[1]`。
 */
function handlePowBindingEvent(payload: string): void {
  const sep = payload.indexOf(':')
  if (sep < 0) return
  const requestId = payload.slice(0, sep)
  const rest = payload.slice(sep + 1)
  const state = powRequests.get(requestId)
  if (!state) return

  const kindSep = rest.indexOf(':')
  const kind = kindSep < 0 ? rest : rest.slice(0, kindSep)
  const value = kindSep < 0 ? '' : rest.slice(kindSep + 1)

  if (kind === 'ok') {
    state.onAnswer(Number(value))
  } else {
    state.onError(value || 'unknown')
  }
}

function handleBindingEvent(payload: string): void {
  let msg: any
  try {
    msg = JSON.parse(payload)
  } catch {
    return
  }
  const requestId = msg?.requestId
  if (!requestId) return
  const state = requests.get(requestId)
  if (!state) return

  switch (msg.type) {
    case 'headers': {
      if (state.streamStarted) return
      state.streamStarted = true
      state.resolveHeaders(msg.status ?? 200, msg.statusText ?? '', msg.headers ?? {})
      break
    }
    case 'chunk': {
      const arr = msg.chunk
      if (Array.isArray(arr) && state.controller) {
        try {
          state.controller.enqueue(new Uint8Array(arr))
        } catch {}
      }
      break
    }
    case 'done': {
      if (state.controller) {
        try {
          state.controller.close()
        } catch {}
      }
      requests.delete(requestId)
      break
    }
    case 'error': {
      if (state.controller) {
        try {
          state.controller.error(new Error(String(msg.error ?? '浏览器请求失败')))
        } catch {}
      }
      if (!state.streamStarted) {
        state.rejectHeaders(new Error(String(msg.error ?? '浏览器请求失败')))
      }
      requests.delete(requestId)
      break
    }
  }
}

/**
 * 等页面站到目标站点 origin 上；不对就导航过去。
 *
 * ## 为什么这件事是必须的（2026-10-14）
 *
 * 2026-10-14 之前传输层启动在 **`about:blank`**（`buildBrowserArgs(PROFILE_DIR, 'about:blank')`），
 * 于是每个请求都是"从 `about:blank` 发出、打到 chat.deepseek.com 的跨源请求"：
 *  - `Origin` 不是站点 origin（`Origin` 是**禁止头**，脚本补不了，只能靠页面自己在那个 origin 上）；
 *  - `Referer` 缺失；
 *  - `Sec-Fetch-Site` 是 `cross-site` 而不是同源的 `same-origin`。
 *
 * 这三样都是站点风控能直接看到的东西，而**真实浏览器里发这个请求的页面就站在
 * chat.deepseek.com 上**。所以"更像真浏览器"最实在的一步，就是让页面站过去。
 *
 * ⚠️ 用轮询 `location.origin` 而不是监听 `Page.loadEventFired`：
 * 事件可能在我们挂上监听器之前就发完了（CDP 事件没有重放），轮询没有这个竞态。
 * 超时**不抛错** —— 拿不到站点 origin 时退回旧行为，总比整个传输层起不来好。
 */
async function ensureSiteOrigin(cdp: CdpClient, timeoutMs = 20_000): Promise<boolean> {
  const wanted = new URL(TRANSPORT_SITE_ORIGIN).origin
  const deadline = Date.now() + timeoutMs
  let navigated = false
  while (Date.now() < deadline) {
    try {
      const result: any = await cdp.send('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      })
      const origin = String(result?.result?.value ?? '')
      if (origin === wanted) return true
      if (!navigated) {
        navigated = true
        await cdp.send('Page.enable').catch(() => {})
        await cdp.send('Page.navigate', { url: `${TRANSPORT_SITE_ORIGIN}/` }).catch(() => {})
      }
    } catch {
      /* 导航过程中 evaluate 可能短暂失败，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * 重载后等页面重新可执行（`document.readyState` 到 interactive/complete）。
 *
 * 为什么必须等：装完登录态要**重载页面**才能生效（站点 JS 是在**启动时**
 * 读 `localStorage.userToken` 的，不重载它不会发现自己已登录），
 * 而重载期间执行上下文会被销毁 —— 这时代 `Runtime.evaluate` 发请求
 * 会拿到 "Cannot find context with specified id" 这类错。
 *
 * ⚠️ 不抛错、返回 boolean：等不到也让请求照常发出去（卡住不动的代价更大）。
 */
async function waitForPageReady(cdp: CdpClient, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result: any = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      })
      const state = String(result?.result?.value ?? '')
      if (state === 'interactive' || state === 'complete') return true
    } catch {
      /* 重载途中 evaluate 会失败，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * 页面重载后**重新注册**绑定通道，并验证它在新文档里真的可用。
 *
 * 🔴 为什么不能省：`Runtime.addBinding` 注册的绑定在**导航之后是否自动重现**，
 * 取决于 Chrome 版本 —— 这件事不能假定。绑定丢了的话，页面脚本会以
 * `__dshBrowserTransportCallback is not defined` 直接抛错，
 * 而调用方只会看到"请求莫名其妙失败"，极难归因。
 *
 * 所以这里注册完还要**问一次 `typeof`**，而不是假定成功
 * （重复注册在部分版本会报错 —— 已被 `catch` 吃掉，不影响结果）。
 */
async function reinstallPageBindings(cdp: CdpClient): Promise<boolean> {
  await cdp.send('Runtime.enable').catch(() => {})
  await cdp.send('Runtime.addBinding', { name: BINDING_NAME }).catch(() => {})
  await cdp.send('Runtime.addBinding', { name: POW_BINDING }).catch(() => {})
  try {
    const expression =
      'JSON.stringify([' +
      `typeof globalThis[${JSON.stringify(BINDING_NAME)}],` +
      `typeof globalThis[${JSON.stringify(POW_BINDING)}]` +
      '])'
    const result: any = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    const kinds = JSON.parse(String(result?.result?.value ?? 'null'))
    return Array.isArray(kinds) && kinds.every((kind) => kind === 'function')
  } catch {
    return false
  }
}

/**
 * 用 CDP 装 cookie —— 这是唯一**真的能发出去**的通道。
 *
 * `Network.setCookie` 不受"禁止头"约束，而且能写 **httpOnly** cookie
 * （那几个往往才是真正决定登录态的）。单条失败不致命：cookie 与
 * `Authorization` 是两条独立的凭证，缺一条不该把整轮打掉。
 */
export async function installCookiesViaCdp(
  cdp: Pick<CdpClient, 'send'>,
  cookieHeader: string,
  requestUrl: string,
): Promise<number> {
  if (!cookieHeader) return 0
  // 按**请求自己的 origin** 安装（生产里这些请求就是打到 chat.deepseek.com 的）。
  // 不写死站点 origin：写死的话，任何非站点的请求（比如诊断/用例里的本地服务）
  // 拿到的 cookie 都会被装到别的域上 —— 而且那样这一处**没法端到端验证**。
  let origin: string
  try {
    origin = new URL(requestUrl).origin
  } catch {
    return 0
  }
  const cookies = cookiesForCdp(cookieHeader, `${origin}/`)
  if (cookies.length === 0) return 0
  await cdp.send('Network.enable').catch(() => {})
  let installed = 0
  for (const cookie of cookies) {
    try {
      // 🔴 `Network.setCookie` 失败时**返回 `{success: false}` 而不抛错** ——
      // 不看返回值就等于把"cookie 又没装上"变成又一次静默失败（这正是这次要修的毛病）。
      const result: any = await cdp.send('Network.setCookie', cookie)
      if (result === undefined || result?.success !== false) installed += 1
    } catch {
      /* 单条失败继续装下一条 */
    }
  }
  return installed
}

/**
 * 传输层浏览器的启动参数（**纯函数**，所以用例可以直接断言它，而不用去断源码位置）。
 *
 * 两个不能省的要点：
 *  1. **启动 URL 是站点自己**（`TRANSPORT_SITE_ORIGIN`），不是 `about:blank`。
 *     这是"Origin/Referer/Sec-Fetch-* 像不像真浏览器"的唯一正解 ——
 *     `Origin` 是禁止头，脚本补不了，只能靠页面真的站在那个 origin 上。
 *  2. `--no-sandbox` 只在这里加（来自 `transportExtraArgs()`）。
 *     Linux 上 headless Chrome 要 sandbox，而 CI runner / 容器是 root ⇒ 起不来。
 *     ⚠️ **绝不能**加进 `buildBrowserArgs` —— 那个函数登录窗口也在用，
 *     登录窗口要加载真实页面、用户在里面手动输密码，关它的 sandbox 才是真的扩大攻击面。
 *     理由详见 `browser-login.ts: transportExtraArgs()` 的注释。
 */
export function transportBrowserArgs(profileDir: string, userAgent?: string): string[] {
  return [
    ...buildBrowserArgs(profileDir, `${TRANSPORT_SITE_ORIGIN}/`),
    ...transportExtraArgs(),
    '--headless=new',
    '--disable-dev-shm-usage',
    '--allow-insecure-localhost',
    /**
     * 🔴 2026-10-15 实测（CDP 探针读**页面 JS 眼里**的环境，站点弹「使用环境异常」），
     * 三个实锤与对策：
     *
     *  ① UA 是 `HeadlessChrome/…`，而请求头带的是账号那份真实 Edge UA —— 自相矛盾
     *     ⇒ `--user-agent` 用**账号捕获的那份真实 UA**（见 `launchBrowserTransport`）；
     *  ② `navigator.webdriver === true`（headless 自己带来的）
     *     ⇒ `--disable-blink-features=AutomationControlled`；
     *  ③ WebGL 渲染器是 `Microsoft Basic Render Driver`（`--disable-gpu` 逼出来的软件渲染）
     *     ⇒ **拿掉 `--disable-gpu`**（headless=new 在有 GPU 的机器上会用真 GPU；
     *        没 GPU 的环境 Chrome 会自己回退，不需要我们替它决定）。
     *
     * 仓库其实早知道这个病：`check-browser-login.mjs` 对登录窗口的断言原文就是
     * 「否则 UA 是 HeadlessChrome 且 webdriver=true」—— 传输层得了同样的病没人管。
     * ⚠️ `--disable-web-security` 先留着 —— 见下面注释（拿掉有打不开站点的风险，单独评估）。
     */
    '--disable-blink-features=AutomationControlled',
    // ⚠️ 这一条在"页面站对 origin"之后已经不是必需（同源请求本就不触发 CORS），
    // 但它**不改变 JS 可见的指纹**，而拿掉它有打不开站点的风险 ⇒ 暂时留着、单独评估。
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
  ]
}

/**
 * 传输层页面的 UA：**当前账号捕获的那份真实 UA**（与请求头里的完全一致）。
 *
 * 为什么不给兜底值：编一个"看起来像 Edge"的 UA 比留空更假 —— 留空时页面还是 Headless UA
 * （会被站点看见），但那种状态本来就发不出请求（没有账号就没有请求）。
 */
function transportPageUserAgent(): string | undefined {
  try {
    const id = activeAccountId()
    const account = id ? listAccounts().find((item) => item.id === id) : undefined
    const ua = String(account?.userAgent ?? '').trim()
    return ua || undefined
  } catch {
    return undefined
  }
}

export async function launchBrowserTransport(): Promise<BrowserTransportSession> {
  if (activeSession) return activeSession
  if (launchPromise) return launchPromise

  launchPromise = (async () => {
    const browser = findSystemBrowser()
    if (!browser) throw new Error('未找到 Edge/Chrome，无法启动浏览器代理传输层')

    await prepareTransportProfile(PROFILE_DIR, waitForPreviousTransportExit)

    const child = spawn(
      browser.path,
      transportBrowserArgs(PROFILE_DIR, transportPageUserAgent()),
      {
        stdio: 'ignore',
        detached: false,
      },
    )

    let spawnError: Error | undefined
    child.on('error', (err) => {
      spawnError = err
    })
    await new Promise((r) => setTimeout(r, 300))
    // 启动失败的三条出口也要收整棵进程树：半死的浏览器同样占着 profile。
    const abortLaunch = (): void => {
      killTransportTree(child.pid)
      try {
        child.kill()
      } catch {}
    }
    if (spawnError) {
      abortLaunch()
      throw new Error(`启动浏览器失败：${spawnError.message}`)
    }

    const port = await waitForTransportDebugPort(PROFILE_DIR, child)
    if (!port) {
      abortLaunch()
      throw new Error('浏览器调试端口未就绪')
    }

    const page = await findPageTarget(port)
    if (!page) {
      abortLaunch()
      throw new Error('浏览器里没有可用页面')
    }

    const cdp = new CdpClient(page.webSocketDebuggerUrl)
    try {
      await cdp.connect()
    } catch (error: any) {
      abortLaunch()
      throw new Error(`连接 CDP 失败：${error?.message ?? error}`)
    }

    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Runtime.addBinding', { name: BINDING_NAME }).catch((error: any) => {
      throw new Error(`addBinding 失败：${error?.message ?? error}`)
    })
    // 🔴 0.6.42：PoW 求解结果的通道（`solvePowInPage` 用）。
    // ⚠️ **必须与 BINDING_NAME 分开注册**：传输层的回调负载是 JSON（`{requestId,type,…}`），
    //   而 PoW 的是 `requestId + ':ok:' + 答案` 这种裸字符串 —— 混在一个通道里
    //   会让两边的解析器互相误判（传输层会把 PoW 的字符串当 JSON 解析失败）。
    await cdp.send('Runtime.addBinding', { name: POW_BINDING }).catch(() => {
      /* 已有会话可能注册过；失败不致命，真用到时会在 solvePoWInPage 里报错 */
    })

    // 🔴 让页面站到站点自己的 origin 上（否则 `Origin`/`Referer`/`Sec-Fetch-*` 都不是真浏览器的样子）。
    // 失败只记一笔、不抛：退回旧行为也比整个传输层起不来强。
    const onSite = await ensureSiteOrigin(cdp).catch(() => false)
    if (!onSite) {
      console.warn(
        `[deepseek-web] 传输层页面没能停在 ${TRANSPORT_SITE_ORIGIN} 的 origin 上，` +
        '本次请求的 Origin/Referer 会与真实浏览器不一致',
      )
    }

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.bindingCalled') {
        const name = String(params?.name ?? '')
        if (name === BINDING_NAME) {
          handleBindingEvent(String(params?.payload ?? ''))
        } else if (name === POW_BINDING) {
          handlePowBindingEvent(String(params?.payload ?? ''))
        }
      }
    })

    const cleanup = (): void => {
      try {
        cdp.close()
      } catch {}
      // 只 kill 主进程会留下持有 profile 文件句柄的孤儿子进程（见 killTransportTree）。
      killTransportTree(child.pid)
      try {
        child.kill()
      } catch {}
      activeSession = undefined
      launchPromise = undefined
      if (exitState === 'exiting') {
        exitState = 'exited'
        settleExit()
      }
    }

    child.on('exit', cleanup)

    // 登记"这个进程还没退"。必须在 spawn 之后立刻做：`exit` 来得比这里早时
    // 上面的 cleanup 已经把 exitState 复位成 none，不会留下一个永远等不到的 exiting。
    exitState = 'exiting'
    settleExit = () => {}

    return { browser, child, cdp, cleanup, pageSession: {} }
  })()

  try {
    activeSession = await launchPromise
  } catch (error) {
    launchPromise = undefined
    throw error
  }
  launchPromise = undefined
  return activeSession
}

/** 会话失效：收掉它，下一次请求会重新拉起（关停与"坏掉了"走同一条路，避免两份实现）。 */
export function invalidateTransportSession(): void {
  activeSession?.cleanup()
  activeSession = undefined
  launchPromise = undefined
}

export async function shutdownBrowserTransport(): Promise<void> {
  invalidateTransportSession()
}

/**
 * 探针：读传输层页面此刻的**本地**状态（`location` / `readyState` / `localStorage.userToken`）。
 *
 * 🔴 只走本机 CDP，**不发任何网络请求** —— 保活心跳绝不能自己造出"对站点的固定周期流量"。
 * 没有会话、或探测失败，一律返回 `null`（调用方按"不可用"处理）。
 */
export async function readTransportPageState(): Promise<PageObservation | null> {
  const session = activeSession
  if (!session) return null
  try {
    const result: any = await session.cdp.send('Runtime.evaluate', {
      expression:
        'JSON.stringify((function(){try{' +
        "var raw=localStorage.getItem('userToken');" +
        'var t=raw;' +
        "try{var p=JSON.parse(raw);if(p&&typeof p==='object')t=p.value;}catch(e){}" +
        'return {url:location.href,readyState:document.readyState,' +
        "userToken:(t===null||t===undefined)?'':String(t)};" +
        "}catch(e){return {url:location.href,readyState:'',userToken:''};}})())",
      returnByValue: true,
    })
    const parsed = JSON.parse(result?.result?.value ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    return {
      url: String(parsed.url ?? ''),
      readyState: String(parsed.readyState ?? ''),
      userToken: String(parsed.userToken ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * 页面未登录时用：把登录态槽的**签名作废**，让下一次请求按既有流程重装。
 *
 * 为什么不在心跳里直接重装：重装需要凭据，而凭据来自"那一次请求自己"
 * （`pageSessionFromHeaders(rawHeaders)`）。心跳里再去取账号等于多开一条凭据通路，
 * 还得处理"取到的是哪个号"。作废签名最省、也最不容易写错。
 */
export function markTransportPageSessionStale(): void {
  const session = activeSession
  if (!session) return
  session.pageSession.signature = undefined
}

/** 页面被导航走时用：把页面带回站点 origin（本地动作，不发业务请求）。 */
export async function navigateTransportToSite(): Promise<boolean> {
  const session = activeSession
  if (!session) return false
  return ensureSiteOrigin(session.cdp).catch(() => false)
}

/** 页面上下文里的辅助函数名（把 base64 还原成字节）。 */
const B64_HELPER = '__dshB64ToBytes'
/** 页面上下文里的辅助函数名（把序列化过的 parts 重建成 FormData）。 */
const FORMDATA_HELPER = '__dshRebuildFormData'

/** 页面里用到的两个小工具（随每次 evaluate 一起注入，保持无状态）。 */
const PAGE_HELPERS = `
  const ${B64_HELPER} = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };
  const ${FORMDATA_HELPER} = (parts) => {
    const form = new FormData();
    for (const p of parts) {
      if (p.t === 'text') form.append(p.name, p.value);
      else form.append(p.name, new File([${B64_HELPER}(p.b64)], p.filename, { type: p.type }));
    }
    return form;
  };
`

/**
 * 把 Node 侧的请求体转成"能在页面里重建它"的表达式。
 *
 * 🔴 0.6.20 的第一版只支持 string / Uint8Array / ArrayBuffer，遇到 FormData 直接抛
 * "暂不支持" —— 而**图片上传走的就是 FormData（multipart）**（见 `webapi.uploadImageFile`），
 * 于是"切到浏览器代理传输层之后图片全传不上去"（2026-10-01 用户报，报错文案就来自这里）。
 *
 * 0.6.24：FormData / Blob 都按**字节**搬过去，在页面里重建。
 * 细节：
 *  - 用 **base64** 而不是 JSON 数组传字节（体积约为 1/2.4，CDP 消息不至于被图片撑爆）；
 *  - 用 `new File(...)` 而不是 `new Blob(...)` —— 必须保住 **filename**，
 *    服务端是按**文件名后缀**判图片类型的（见 protocol.ts 的说明）；
 *  - 语言无关地遍历 FormData 的 entry：`TextPart` 原样作为字段，其余一律当文件。
 */
async function bodyToPageInit(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) {
    return 'undefined'
  }
  if (typeof body === 'string') {
    return JSON.stringify(body)
  }
  if (body instanceof Uint8Array) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(body).toString('base64'))})`
  }
  if (body instanceof ArrayBuffer) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(new Uint8Array(body)).toString('base64'))})`
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // ⚠️ 用 forEach 而不是 `entries()`：后者要 `DOM.Iterable` lib，本项目的 lib 里没有
    // （为一个遍历去动 tsconfig 影响面太大）。先收成数组，再逐个 await 读字节。
    const raw: Array<[string, FormDataEntryValue]> = []
    body.forEach((value, name) => {
      raw.push([name, value])
    })
    const parts: Array<Record<string, unknown>> = []
    for (const [name, value] of raw) {
      if (typeof value === 'string') {
        parts.push({ t: 'text', name, value })
        continue
      }
      // File / Blob（Node 20+ 两者都有 arrayBuffer()）
      const blob = value as Blob
      const b64 = Buffer.from(new Uint8Array(await blob.arrayBuffer())).toString('base64')
      parts.push({
        t: 'file',
        name,
        filename: (blob as File).name || name || 'blob',
        type: blob.type || 'application/octet-stream',
        b64,
      })
    }
    return `${FORMDATA_HELPER}(${JSON.stringify(parts)})`
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const b64 = Buffer.from(new Uint8Array(await body.arrayBuffer())).toString('base64')
    return `new Blob([${B64_HELPER}(${JSON.stringify(b64)})], { type: ${JSON.stringify(body.type || 'application/octet-stream')} })`
  }
  throw new Error(
    '浏览器代理传输层不支持的请求体类型（支持 string / Uint8Array / ArrayBuffer / FormData / Blob）',
  )
}

const POW_BINDING = '__dshPowSolveResult'

/**
 * 🔴 0.6.42：**在浏览器页面上下文里解 PoW**，而不是在 Node 里。
 *
 * ## 为什么必须挪
 *
 * DeepSeek 的 `/api/v0/chat/create_pow_challenge` 会返回一个 `sha3_wasm_bg.*.wasm`，
 * 客户端必须自己调用 `wasm_solve` 求出一个答案。**在 Node 里 `WebAssembly.instantiate`
 * 求这个答案，是整条链路上最容易被风控识别的特征** ——
 * `xiaoY233/DeepSeek-Free-API` 的 Disclaimers 把它列为明确的封号触发条件：
 * > Challenge Solving Patterns: Automated challenge solving detected
 *
 * 官方网页端自己是在**页面上下文**里解的（wasm 由页面脚本加载、答案随正常请求发出）。
 * 我们已经有 CDP 会话（`Runtime.addBinding` + `Runtime.evaluate`），
 * 于是可以让**官方自己的 wasm 在官方自己的页面里跑** ——
 * 发出的请求形态与真人在浏览器里完全一致。
 *
 * ## 为什么这条一定可行（不是猜测）
 *
 * ① 传输层本来就跑在真实页面里（`createBrowserFetch` 的每个请求都是 `Runtime.evaluate`）；
 * ② wasm 的地址有白名单（`checkedWasmUrl`：仅 `*.deepseek.com`、`.wasm` 结尾）
 *    ⇒ 在同源页面里 `fetch` 它必然同源、CORS 不会拦；
 * ③ 页面已经有我们的 binding 通道 ⇒ 答案回传不需要新机制。
 *
 * ## 判据
 *
 * 页面里必须真的**算出了有限数**才算成功 ——
 * 绝不接受"wasm 加载失败就退回 Node 侧悄悄算"（那等于这个改动没发生，
 * 却给了我们"已经改好了"的错觉）。
 */
export async function solvePowInPage(input: {
  wasmUrl: string
  challenge: string
  salt: string
  difficulty: string | number
  expireAt: string | number
}): Promise<number> {
  const session = await launchBrowserTransport()
  const requestId = `pow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const answer = await new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      powRequests.delete(requestId)
      fn()
    }

    powRequests.set(requestId, {
      onAnswer: (value) => {
        if (!Number.isFinite(value) || value <= 0) {
          finish(() => reject(new Error(`页面内 PoW 返回了非法答案：${String(value)}`)))
          return
        }
        finish(() => resolve(Math.floor(value)))
      },
      onError: (message) => finish(() => reject(new Error(`页面内 PoW 失败：${message}`))),
    })

    // ⚠️ prefix 的拼法必须与 Node 版**逐字一致**（`${salt}_${expire_at}_`），
    // 否则算出来的答案对不上。少一个下划线 ⇒ 服务端判失败 ⇒ 挑战重发。
    const expression = `
      (async () => {
        const report = (v) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':ok:' + String(v));
        const fail = (m) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':err:' + String(m));
        try {
          const resp = await fetch(${JSON.stringify(input.wasmUrl)});
          if (!resp.ok) { fail('wasm HTTP ' + resp.status); return; }
          const bytes = await resp.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
          const e = instance.exports;
          if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
            fail('PoW WASM exports missing'); return;
          }
          const enc = new TextEncoder();
          const cBytes = enc.encode(${JSON.stringify(input.challenge)});
          const pBytes = enc.encode(${JSON.stringify(String(input.salt) + '_' + String(input.expireAt) + '_')});
          const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
          const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
          new Uint8Array(e.memory.buffer).set(cBytes, cP);
          new Uint8Array(e.memory.buffer).set(pBytes, pP);
          const sp = e.__wbindgen_add_to_stack_pointer(-16);
          e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(${JSON.stringify(String(input.difficulty))}));
          const dv = new DataView(e.memory.buffer);
          const code = dv.getInt32(sp, true);
          const answer = dv.getFloat64(sp + 8, true);
          e.__wbindgen_add_to_stack_pointer(16);
          if (code === 0 || !Number.isFinite(answer) || answer <= 0) { fail('solve code=' + code); return; }
          report(answer);
        } catch (err) { fail(err && err.message ? err.message : String(err)); }
      })()
    `
    session.cdp.send('Runtime.evaluate', { expression, awaitPromise: false, userGesture: true }).catch((error: any) => {
      const state = powRequests.get(requestId)
      if (state) state.onError(error?.message ?? String(error))
    })
  })

  return answer
}

interface PowSolveState {
  onAnswer: (value: number) => void
  onError: (message: string) => void
}

const powRequests = new Map<string, PowSolveState>()

export function createBrowserFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const session = await launchBrowserTransport()

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const rawHeaders: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          rawHeaders[key] = value
        })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) rawHeaders[key] = value
      } else {
        for (const [key, value] of Object.entries(init.headers)) rawHeaders[key] = String(value)
      }
    }

    // 🔴 禁止头**不能**交给页面里的 `fetch` —— 浏览器会不报错地直接丢掉（`Cookie` 就在名单里）。
    // 2026-10-14 之前 cookie 走的就是这条路 ⇒ 浏览器传输层一直没发过 cookie，只靠 `Authorization`。
    // 现在 cookie 改走 CDP 的 `Network.setCookie`（不受禁止头约束、且能写 httpOnly）。
    // `Origin`/`Referer` 同理不能手写 —— 由 `ensureSiteOrigin()` 让页面站对 origin 来保证。
    const { headers, cookieHeader } = splitBrowserFetchHeaders(rawHeaders)
    // 装了 0 条但本来是有 cookie 的 ⇒ 又是一次静默失败，必须说出来（以前就是这么丢的）。
    if (cookieHeader) {
      const installed = await installCookiesViaCdp(session.cdp, cookieHeader, url)
      if (installed === 0) {
        console.warn('[deepseek-web] cookie 一条都没装进传输层浏览器，本次请求会缺少 cookie 凭证')
      }
    }

    // ── 让页面**自己知道已登录**（站点心跳的来源）──────────────────────────
    // 只装 cookie 不够：网页端的登录态读的是 `localStorage.userToken`。
    // 不装 ⇒ 页面渲染登录页、站点自己的 JS 从不发起会话轮询/长连接，
    // 而我们的请求却带着合法 Bearer —— 真人身上不会出现的组合。
    // 装完重载 ⇒ 站点应用真的跑起来，心跳由**站点自己**产生
    // （**不自己造定时 ping**：固定周期本身就是一种模式）。
    //
    // 顺序与置位语义都在 `runPageSessionInstall` 里（已被用例守着）：
    // 签名**只在装成功后**写入 ⇒ 瞬时失败下次仍会重试。
    await runPageSessionInstall(session.pageSession, pageSessionFromHeaders(rawHeaders), {
      install: (writes) => installPageSessionViaCdp(session.cdp, writes),
      afterInstall: async () => {
        await session.cdp.send('Page.reload', {}).catch(() => {})
        await waitForPageReady(session.cdp)
        return await reinstallPageBindings(session.cdp)
      },
      warn: (message) => console.warn(`[deepseek-web] ${message}`),
    })

    // ⚠️ 现在要 await：FormData/Blob 需要先读出字节才能序列化（图片上传就走这条路）。
    const bodyExpr = await bodyToPageInit(init?.body)
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    // 先注册状态，再 evaluate；binding 事件可能在 evaluate 还没返回时就到了。
    const headersPromise = new Promise<Response>((resolve, reject) => {
      const state: TransportRequestState = {
        resolveHeaders: (status, statusText, respHeaders) => {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              state.controller = controller
            },
            cancel: () => {
              requests.delete(requestId)
            },
          })
          const resp = new Response(stream, {
            status,
            statusText,
            headers: respHeaders,
          })
          resolve(resp)
        },
        rejectHeaders: reject,
        streamStarted: false,
      }
      requests.set(requestId, state)
    })

    const expression = `
      (async () => {
        ${PAGE_HELPERS}
        const requestId = ${JSON.stringify(requestId)};
        try {
          const init = {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(headers)},
            // 🔴 cookie 已经由 CDP 的 Network.setCookie 装进这个 profile 了；
            // same-origin 是同源默认值，生产里页面就在站点 origin 上、本来就会带上。
            // 显式写 include 是为了不让"页面 origin 变了"这类改动悄悄把 cookie 弄丢。
            // ⚠️ 这段注释在**模板字符串内部**，所以一个反引号都不能有（会提前终止字符串）。
            credentials: 'include',
            body: ${bodyExpr},
          };
          const requestInit = init.body === undefined
            ? { method: init.method, headers: init.headers, credentials: init.credentials }
            : init;
          const resp = await fetch(${JSON.stringify(url)}, requestInit);
          ${BINDING_NAME}(JSON.stringify({
            requestId,
            type: 'headers',
            status: resp.status,
            statusText: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
          }));
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ${BINDING_NAME}(JSON.stringify({ requestId, type: 'done' }));
              break;
            }
            ${BINDING_NAME}(JSON.stringify({ requestId, type: 'chunk', chunk: Array.from(value) }));
          }
        } catch (error) {
          ${BINDING_NAME}(JSON.stringify({ requestId, type: 'error', error: String(error) }));
        }
      })()
    `

    session.cdp.send('Runtime.evaluate', { expression, awaitPromise: false, userGesture: true }).catch((error: any) => {
      const state = requests.get(requestId)
      if (state && !state.streamStarted) {
        state.rejectHeaders(new Error(`evaluate 失败：${error?.message ?? error}`))
        requests.delete(requestId)
      }
    })

    return await headersPromise
  }
}
