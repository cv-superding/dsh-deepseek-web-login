/**
 * 浏览器登录（CDP 版）—— 用**系统里真实的 Edge/Chrome** 当登录窗口。
 *
 * 为什么需要它（2026-09-11 DSH 更新后的架构变化）：
 *   DSH 把插件宿主从 Electron **主进程**挪到了 **utility 进程**（实测 `process.type === 'utility'`）。
 *   utility 进程里 `require('electron')` 拿不到 `BrowserWindow` / `session`（那是主进程专属 API），
 *   于是原来「插件自己开一个 BrowserWindow 登录」的做法直接炸在 `session.fromPartition` 上。
 *   而且新架构也没有给插件暴露任何「开窗口 / 开外部 URL」的通用服务
 *   （`desktopRuntime` 只有 openTerminal / pickDirectory / openProfileCreateWindow 这类专用接口）。
 *
 * 做法：拉起一个**可见的真实浏览器**（独立 profile 目录 + 远程调试端口），用 CDP 读：
 *   - `localStorage.userToken`（网页端的真实 token，AppKit 包装 `{"value":"…"}` → 解包）
 *   - `Storage.getCookies`（cookie 串，免去 DPAPI 解密）
 *   - `Network.*` 事件里的 `/api/*` 真实请求头（authorization / x-hif-* / x-client-*）
 *   - `navigator.userAgent`（后续 API 请求要用同一个 UA）
 * 优点：真实浏览器不会被网页端判「使用环境异常」；也不依赖任何 Electron API。
 *
 * 踩坑记录（都已在代码里规避）：
 *   1) **必须用 `--remote-debugging-port=0`**：Windows 保留了大量端口区间
 *      （实测 8792-9897、10001-10100… 全被排除），硬编码端口会 `bind()` 失败（WSAEACCES 10013），
 *      Chromium 报 "Cannot start http server for devtools"。端口 0 由系统分配，然后把真实端口
 *      写进 `<profile>/DevToolsActivePort`（第一行端口、第二行 ws 路径）。
 *   2) 未登录时 `localStorage.userToken` 是 `{"value":null,"__version":"0"}` ——
 *      解包必须把 null 当空值，不能把字符串 "null" 当 token。
 *   3) 用**独立 profile**（`<DSH_HOME>/web-login/browser-profile`）：既避免和用户正在用的浏览器
 *      抢单实例（同 user-data-dir 会转发给已有实例、调试端口根本不起来），也让登录态可复用。
 */
import { pickCookieMeta, type CookieMeta } from './cookies.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { unwrapStoredToken, type WebAuth } from './auth.ts'
import { DS_BASE } from './webapi.ts'

export interface BrowserCandidate {
  name: string
  path: string
}

/** 找系统里可用的 Chromium 系浏览器（Edge 优先：Windows 必装）。 */
export function findSystemBrowser(): BrowserCandidate | null {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const candidates: BrowserCandidate[] =
    process.platform === 'win32'
      ? [
          { name: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
          { name: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
          { name: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
          { name: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
          { name: 'Google Chrome', path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        ]
      : process.platform === 'darwin'
        ? [
            { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
            { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
          ]
        : [
            { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
            { name: 'Chromium', path: '/usr/bin/chromium' },
            { name: 'Chromium', path: '/usr/bin/chromium-browser' },
            { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
          ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate.path)) return candidate
    } catch {}
  }
  return null
}

/** 启动参数（纯函数，便于单测）：**必须**带 `--remote-debugging-port=0`。 */
export function buildBrowserArgs(profileDir: string, url: string): string[] {
  return [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // 别把用户的默认浏览器设置/会话搅进来
    '--no-service-autorun',
    '--disable-background-mode',
    // 🔴 2026-10-10：headless Chrome 在 **Linux** 上默认要 sandbox，
    //   而 Linux 上跑浏览器的人只有两种：root（容器 / CI runner）或
    //   没有 user namespace 权限的普通用户 —— 两种都起不来，
    //   表现为「浏览器调试端口未就绪」（等满25s 拿不到 DevToolsActivePort）。
    //   2026-10-10 实测：CI 的 ubuntu-latest 挂在这条，macOS / Windows 同 commit 通过。
    //   Windows / macOS 上这个 flag 无害（会被忽略），所以无条件带上。
    //   ⚠️ 它降低的是**本机**的进程隔离强度；本插件本来就用自己的 profile 目录跑
    //   headless 浏览器、不加载用户日常 profile，攻击面不因此变大。
    '--no-sandbox',
    url,
  ]
}

/** 解析 `<profile>/DevToolsActivePort`：第一行是端口；容忍 CRLF 与附带内容。 */
export function parseDevToolsActivePort(text: string): number | undefined {
  const first = String(text ?? '').split(/\r?\n/)[0]?.trim()
  if (!first) return undefined
  const port = Number(first)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/** 从 CDP 的 cookie 列表拼出请求用的 cookie 串（只取 deepseek 域）。纯函数。 */
export function buildCookieHeader(cookies: readonly any[]): string {
  return (cookies ?? [])
    .filter((cookie) => cookie && typeof cookie.name === 'string' && String(cookie.domain ?? '').includes('deepseek'))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

/**
 * 浏览器**指纹头**的名字判据 —— 只有"浏览器行为的一部分、且可跨请求复用"的才收。
 *
 * 这个判据**只能有一处**：原先它在 `browser-login.ts`（CDP 路径）和 `login.ts`
 * （旧的 webRequest 路径）各写了一遍，收的还只有 `x-*`。两份一旦漂移，
 * "同一账号用不同路径登录、指纹就不一样"，而且不会有任何报错。
 */
const FINGERPRINT_HEADER_RE = /^(?:x-|sec-ch-ua|sec-fetch-)/
const FINGERPRINT_HEADER_EXACT = new Set(['priority', 'accept', 'accept-language'])

/**
 * 逐请求**现算**的头 —— 收进快照就是 bug：下一轮用旧值会把当前登录态盖掉。
 *
 * ⚠️ `accept-encoding` 是**故意**收在外面的，理由不是"不该收"而是"收了会坏"：
 * 它是浏览器的解压能力声明，服务端可能据此回 `zstd`，而 Node 侧的 `fetch`（undici）
 * 不保证能解 —— 一旦解不开，SSE 会**静默变成乱码**（不是报错，是内容全错）。
 * 宁可少一个头，也不要静默坏掉。将来若要收，必须先验证整条解压链。
 */
const PER_REQUEST_HEADERS = new Set([
  'x-ds-pow-response',
  'x-hif-dliq',
  'x-hif-leim',
  'authorization',
  'cookie',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'origin',
  'referer',
  'user-agent', // 单独存 auth.userAgent（它要参与请求头，但需要单独的字段）
])

/**
 * 从浏览器请求头里挑出可复用的**指纹头**（纯函数，便于单测）。
 *
 * 为什么重要（2026-10-02 核对真实捕获）：
 * 旧规则只留 `x-*`，于是浏览器**自动加**的那一批全被丢掉 ——
 * `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform`、`sec-fetch-dest/mode/site`、
 * `priority`。这些是"是不是真浏览器"最表层、最容易被看到的一批信号，
 * 而丢掉它们的代价是零成本就能避免的。
 *
 * ⚠️ 顺序必须保留：**头的顺序本身就是指纹**。`Object.entries` 按插入顺序遍历，
 * 而调用方是按浏览器给的顺序建这个对象的 ⇒ 收出来的 `out` 就是浏览器的相对顺序。
 */
export function pickExtraHeaders(headers: Record<string, any> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase()
    if (PER_REQUEST_HEADERS.has(lower)) continue
    if (!FINGERPRINT_HEADER_RE.test(lower) && !FINGERPRINT_HEADER_EXACT.has(lower)) continue
    out[lower] = String(value)
  }
  return out
}

/** 极简 CDP 客户端：只需 send + 事件监听。 */
export class CdpClient {
  private socket: any
  private nextId = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private listeners: ((method: string, params: any) => void)[] = []
  private opened = false
  private readonly url: string

  // ⚠️ 不用 TS 的「参数属性」写法（constructor(private readonly url: string)）：
  // 那是需要**转换**的语法，Node 的 strip-only 类型剥离不支持（测试直接跑源码会报
  // "TypeScript parameter property is not supported in strip-only mode"）。
  constructor(url: string) {
    this.url = url
  }

  /**
   * 建连（审计 F15）。
   *
   * 三处旧问题：① 只监听 open/error，**close 不结算** → 建连时对端关闭会一直等到超时；
   * ② 超时后 socket 仍可能在之后 open —— 成为一条**没人持有的孤立连接**；
   * ③ error/超时后没有主动释放 socket。现在统一走 `finish()`：只结算一次、清掉定时器与监听，
   * 失败时顺便 `this.close()` 把 socket 收掉。
   */
  async connect(timeoutMs = 10_000): Promise<void> {
    const WebSocketCtor = (globalThis as any).WebSocket
    if (typeof WebSocketCtor !== 'function') throw new Error('当前 Node 没有全局 WebSocket，无法使用 CDP')
    const socket = new WebSocketCtor(this.url)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onFail)
        socket.removeEventListener('close', onClosed)
        if (error) {
          this.close()
          reject(error)
        } else {
          this.opened = true
          resolve()
        }
      }
      const onOpen = () => finish()
      const onFail = () => finish(new Error('CDP 连接失败'))
      const onClosed = () => finish(new Error('CDP 建连时连接被关闭'))
      const timer = setTimeout(() => finish(new Error('CDP 连接超时')), timeoutMs)
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onFail)
      socket.addEventListener('close', onClosed)
    })
    // 连接建立后的任何关闭/错误 → 立刻结算所有在途命令（不再等到各自超时）
    socket.addEventListener('close', () => this.close())
    socket.addEventListener('error', () => this.close())
    socket.addEventListener('message', (event: any) => {
      let message: any
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        const item = this.pending.get(message.id)
        if (!item) return
        this.pending.delete(message.id)
        clearTimeout(item.timer)
        // ⚠️ 协议层错误（`{id, error}`）必须 reject（审计 F15）：旧实现把它当 result=undefined 的成功，
        // 调用方会拿着 undefined 继续跑，报错信息完全丢失。
        // 注意与 Runtime.evaluate 的 exceptionDetails 区分：后者是**执行结果**，由调用方自己检查。
        if (message.error) {
          item.reject(new Error(`CDP 错误 ${message.error.code ?? ''}: ${message.error.message ?? ''}`))
        } else {
          item.resolve(message.result)
        }
        return
      }
      if (message.method) {
        for (const listener of this.listeners) {
          try {
            listener(message.method, message.params)
          } catch {}
        }
      }
    })
  }

  onEvent(listener: (method: string, params: any) => void): void {
    this.listeners.push(listener)
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (!this.opened) return Promise.reject(new Error('CDP 未连接'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        // send 同步抛错时不能留一个永远不结算的 pending（旧实现会挂到超时）
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    this.opened = false
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('CDP 已关闭'))
    }
    this.pending.clear()
    this.listeners = []
    const socket = this.socket
    this.socket = undefined
    try {
      if (socket && socket.readyState < 2) socket.close()
    } catch {}
  }
}

export interface BrowserLoginOutcome {
  ok: boolean
  auth?: WebAuth
  message: string
  /** 失败分类，便于面板给出针对性提示。 */
  reason?:
    | 'no-browser'
    | 'spawn-failed'
    | 'no-debug-port'
    | 'no-page'
    | 'cdp-failed'
    | 'timeout'
    | 'aborted'
    | 'no-token'
    | 'browser-closed'
  /** 浏览器窗口是否仍然开着（超时时保留，用户可继续登录后重试）。 */
  browserLeftOpen?: boolean
  /** 自动登录没成功时的原因（此时已退回等待手动登录，流程本身没坏）。 */
  autoLoginError?: string
}

export interface BrowserLoginOptions {
  /** 总的等待时限（含用户手动登录的时间）。 */
  timeoutMs?: number
  /** 持久化 profile 目录（默认 `<DSH_HOME>/web-login/browser-profile`）。 */
  profileDir?: string
  /** 进度回调（给面板看）。 */
  onProgress?: (message: string) => void
  /** 用于取消（卸载插件/用户取消）。 */
  signal?: AbortSignal
  /** 轮询间隔（测试用）。 */
  pollIntervalMs?: number
  /**
   * 邮箱密码（0.6.14）：给了就**自动登录**，不再等用户手动操作。
   *
   * 为什么必须在页面里做：密码登录接口 `POST /api/v0/users/login` 直连会被风控判
   * `RISK_DEVICE_DETECTED` —— `device_id` 只由数美设备指纹 SDK（`window.SMSdk.getDeviceId()`）
   * 产出。页面上下文里发请求则指纹/WAF cookie 全是真的（2026-09-30 实测 `biz_code: 0`）。
   *
   * ⚠️ 自动登录失败**不会**终止整个流程：退回"等用户手动登录"，并把原因写进
   * `autoLoginError`（自动化不该让原本可用的手动路径失效）。
   */
  credentials?: { email: string; password: string }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login', 'browser-profile')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 探一次 CDP 的 HTTP 端点。
 *
 * ⚠️ 每次请求都要有**自己的**超时（审计 F15）：旧写法只有外层循环的 deadline，
 * 一次请求挂住就再也回不到循环条件上，"deadline"形同虚设。
 */
async function cdpJson(port: number, endpoint: '/json/version' | '/json/list', signal?: AbortSignal): Promise<any> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000)
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: bounded, redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error('CDP HTTP 请求失败')
  }
  return await res.json()
}

/**
 * 这个 target 是不是 chat.deepseek.com 的页面。
 *
 * 用 `origin` **严格相等**，不用 `includes`（审计 F15）：`includes('deepseek.com')` 会命中
 * `chat.deepseek.com.evil.example` 这类域名，也会命中深链页/其它子域，可能选错 target。
 */
/** R7：本插件最近一次拉起的浏览器子进程（clearBrowserLoginProfile 清理失败时杀它重试）。 */
let lastSpawnedChild: ChildProcess | undefined

export function isDeepSeekPage(target: any): boolean {
  try {
    return target?.type === 'page' && new URL(String(target.url)).origin === DS_BASE
  } catch {
    return false
  }
}

/** 等 CDP 的 HTTP 端点可用，返回调试端口。 */
async function waitForDebugPort(
  profileDir: string,
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return undefined
    if (child.exitCode !== null) return undefined
    try {
      const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      if (port) {
        // 端口文件出现不代表 HTTP 已就绪，探一下（自身带 2s 超时）
        try {
          await cdpJson(port, '/json/version', signal)
          return port
        } catch {}
      }
    } catch {}
    await sleep(300)
  }
  return undefined
}

/** 找到 chat.deepseek.com 的页面 target（等 SPA 起来）。 */
async function findPageTarget(port: number, timeoutMs: number, signal?: AbortSignal): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    try {
      const targets = (await cdpJson(port, '/json/list', signal)) as any[]
      const page = Array.isArray(targets) ? targets.find((t) => isDeepSeekPage(t)) : undefined
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await sleep(400)
  }
  return null
}

/**
 * 完整流程：拉起真实浏览器 → CDP 抓凭证。
 * 成功时返回可直接落盘的 WebAuth；失败时给出分类原因。
 */
/**
 * 页面里执行的自动登录脚本（0.6.14）。
 *
 * 它是**字符串**：要在页面上下文里跑，不能引用本文件的任何符号。
 * 必须等数美 SDK 就绪再取 `deviceId`（拿不到就明说），拿到后直接 POST 登录接口。
 * 成功后顺手把 token 按网页端的格式写回 `localStorage.userToken` ——
 * 这样主流程原有的"轮询 localStorage → 抓 cookie/指纹头"那段**一行都不用改**。
 */
export function buildAutoLoginExpression(email: string, password: string): string {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let deviceId = null;
    try {
      if (window.SMSdk && window.SMSdk.ready) {
        deviceId = await Promise.race([
          new Promise((res) => window.SMSdk.ready(() => res(window.SMSdk.getDeviceId ? window.SMSdk.getDeviceId() : null))),
          wait(15000).then(() => null),
        ]);
      }
    } catch (e) { deviceId = null; }
    if (!deviceId) return { ok: false, stage: 'sdk', error: '数美设备指纹 SDK 没就绪，拿不到 device_id' };
    let resp, text;
    try {
      resp = await fetch('/api/v0/users/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: ${JSON.stringify(email)},
          mobile: '',
          password: ${JSON.stringify(password)},
          area_code: '',
          device_id: deviceId,
          os: 'web',
        }),
      });
      text = await resp.text();
    } catch (e) {
      return { ok: false, stage: 'request', error: '登录请求发不出去：' + String(e) };
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    const data = (json && json.data) || {};
    const user = (data.biz_data && data.biz_data.user) || null;
    if (!user || !user.token) {
      const code = data.biz_code;
      const msg = data.biz_msg || '';
      const why = code === 11 || msg === 'RISK_DEVICE_DETECTED' ? '被风控判定为可疑设备' : msg || '服务端没返回 token';
      return { ok: false, stage: 'login', bizCode: code, bizMsg: msg, error: '登录没成功：' + why };
    }
    try {
      localStorage.setItem('userToken', JSON.stringify({ value: user.token, __version: '0' }));
    } catch (e) {}
    return { ok: true, stage: 'ok', bizCode: data.biz_code, bizMsg: data.biz_msg || '' };
  })()`
}

/**
 * 自动登录一步（在页面里跑脚本，成功与否都返回结果，不抛）。
 * 失败时**只记录原因**，调用方退回"等用户手动登录"。
 */
async function tryAutoLogin(
  cdp: CdpClient,
  credentials: { email: string; password: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const value = await cdp.send('Runtime.evaluate', {
      expression: buildAutoLoginExpression(credentials.email, credentials.password),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (value?.exceptionDetails) {
      return { ok: false, error: `页面里报错：${value.exceptionDetails.text ?? ''}` }
    }
    const result = value?.result?.value as { ok?: boolean; error?: string } | undefined
    if (!result) return { ok: false, error: '页面没有返回结果' }
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '登录没成功' }
  } catch (error: any) {
    return { ok: false, error: `自动登录调用失败：${error?.message ?? error}` }
  }
}

export async function browserLogin(options: BrowserLoginOptions = {}): Promise<BrowserLoginOutcome> {
  const browser = findSystemBrowser()
  if (!browser) {
    return {
      ok: false,
      reason: 'no-browser',
      message: '没有找到 Edge/Chrome。请改用「用我的默认浏览器登录」+ 手动粘贴 Token。',
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR
  const pollIntervalMs = options.pollIntervalMs ?? 1_200
  const progress = options.onProgress ?? (() => {})

  try {
    mkdirSync(profileDir, { recursive: true })
  } catch {}

  progress(`正在启动 ${browser.name}（独立 profile，不会影响你日常浏览器的登录态）……`)
  let child: ChildProcess
  try {
    child = spawn(browser.path, buildBrowserArgs(profileDir, `${DS_BASE}/`), {
      stdio: 'ignore',
      detached: false,
    })
    // R7：模块级留一份引用 —— clearBrowserLoginProfile（模块级函数）清理失败时要能杀掉它重试。
    lastSpawnedChild = child
  } catch (error: any) {
    return { ok: false, reason: 'spawn-failed', message: `启动 ${browser.name} 失败：${error?.message ?? error}` }
  }

  // ⚠️ F14（2026-09-12 审计）：spawn 的失败有**一大部分是异步**的
  // （ENOENT / EACCES / 被安全软件拦截，都以 'error' 事件异步到达）。
  // 上面那个 try/catch 只接得住**同步**抛错；不监听 'error' 的话，
  // 异步失败会变成未捕获异常 —— 后果是把**整个 DSH 宿主进程**带崩，
  // 而这里真实语义只是"登录窗口没起来"，完全不该有这个量级的破坏力。
  let spawnError: Error | undefined
  child.on('error', (error: Error) => {
    spawnError = error
    progress(`${browser.name} 启动失败（异步错误）：${error?.message ?? error}`)
  })
  // 给异步错误一个冒头的机会：ENOENT/EACCES 都是立刻触发，300ms 足够，
  // 不必让用户干等 waitForDebugPort 的 25 秒才看到原因。
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (spawnError) {
    try {
      child.kill()
    } catch {}
    return {
      ok: false,
      reason: 'spawn-failed',
      message: `启动 ${browser.name} 失败：${spawnError.message}`,
    }
  }

  const cleanupBrowser = (): void => {
    try {
      child.kill()
    } catch {}
  }

  const port = await waitForDebugPort(profileDir, child, 25_000, options.signal)
  if (!port) {
    cleanupBrowser()
    return {
      ok: false,
      reason: 'no-debug-port',
      message: `${browser.name} 起来了但调试端口不可用（可能被安全软件拦截）。请改用「用我的默认浏览器登录」+ 手动粘贴 Token。`,
    }
  }

  const page = await findPageTarget(port, 20_000, options.signal)
  if (!page) {
    cleanupBrowser()
    return { ok: false, reason: 'no-page', message: `${browser.name} 里没找到 chat.deepseek.com 页面。` }
  }

  const cdp = new CdpClient(page.webSocketDebuggerUrl)
  try {
    await cdp.connect()
  } catch (error: any) {
    cleanupBrowser()
    return { ok: false, reason: 'cdp-failed', message: `连接浏览器调试接口失败：${error?.message ?? error}` }
  }

  // 从 /api/* 的真实请求里捡指纹头（x-hif-* / x-client-*）与 UA
  let extraHeaders: Record<string, string> = {}
  let apiUserAgent = ''
  cdp.onEvent((method, params) => {
    if (method !== 'Network.requestWillBeSent' && method !== 'Network.requestWillBeSentExtraInfo') return
    const url = String(params?.request?.url ?? '')
    const headers = (method === 'Network.requestWillBeSentExtraInfo' ? params?.headers : params?.request?.headers) ?? {}
    if (!url.includes('/api/')) return
    const lower: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value)
    if (lower['user-agent']) apiUserAgent = lower['user-agent']
    if (Object.keys(extraHeaders).length === 0) extraHeaders = pickExtraHeaders(lower)
  })
  await cdp.send('Runtime.enable').catch(() => {})

  // ── 自动重登（0.6.14）：给了邮箱密码就不再等用户手动操作 ─────────────────────
  // 在**页面上下文**里发登录请求（指纹/WAF cookie 都是真的），成功后脚本会把 token
  // 按网页端格式写回 localStorage —— 于是下面原有的轮询与 cookie/指纹捕获**一行都不用改**。
  // 失败**不终止**：退回等待手动登录，只把原因带出去。
  let autoLoginError: string | undefined
  if (options.credentials) {
    progress('正在用已保存的邮箱密码自动登录…')
    const auto = await tryAutoLogin(cdp, options.credentials)
    if (auto.ok) progress('自动登录成功，正在读取 cookie 与指纹头……')
    else {
      autoLoginError = auto.error
      progress(`自动登录没成功（${auto.error}），请在窗口里手动登录…`)
    }
  }
  await cdp.send('Network.enable').catch(() => {})

  progress('浏览器已打开：请在其中登录 DeepSeek（手机号/邮箱/扫码均可）。登录成功后会自动捕获，无需复制粘贴。')

  const deadline = Date.now() + timeoutMs
  let lastNotice = 0
  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        cdp.close()
        cleanupBrowser()
        return { ok: false, reason: 'aborted', message: '已取消登录。' }
      }
      // R7（0.1.84）：用户关掉浏览器后，CDP 调用会一直抛错被内层 catch 吞掉，
      // 循环要空转到 deadline 才退。看子进程退出码，提前结束。
      if (child.exitCode !== null || child.killed) {
        cleanupBrowser()
        return { ok: false, reason: 'browser-closed', message: '浏览器已关闭，登录已取消。需要的话再点一次「浏览器窗口登录」即可。' }
      }
      let token = ''
      let pageUserAgent = ''
      try {
        const value = await cdp.send('Runtime.evaluate', {
          expression: "String(localStorage.getItem('userToken') || '')",
          returnByValue: true,
        })
        token = unwrapStoredToken(String(value?.result?.value ?? ''))
        const ua = await cdp.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
        pageUserAgent = String(ua?.result?.value ?? '')
      } catch {
        // 页面可能在跳转，下一轮再试
      }

      if (token) {
        progress('已捕获 token，正在读取 cookie 与指纹头……')
        let cookie = ''
        let cookieMeta: CookieMeta[] = []
        try {
          const cookies = await cdp.send('Storage.getCookies', {})
          const raw = cookies?.cookies ?? []
          cookie = buildCookieHeader(raw)
          // 过滤条件与 buildCookieHeader 内**逐字一致**（都是 `includes('deepseek')`）——
          // 元信息要描述的正是请求头上实际带的那批 cookie，不能多也不能少。
          cookieMeta = pickCookieMeta(raw, (domain) => String(domain ?? '').includes('deepseek'))
        } catch {}
        const auth: WebAuth = {
          token,
          cookie,
          hifDliq: String((extraHeaders as any)['x-hif-dliq'] ?? ''),
          hifLeim: String((extraHeaders as any)['x-hif-leim'] ?? ''),
          wasmUrl: '',
          userAgent: apiUserAgent || pageUserAgent,
          ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
          ...(cookieMeta.length > 0 ? { cookieMeta } : {}),
          capturedAt: new Date().toISOString(),
          unverified: true,
        }
        cdp.close()
        cleanupBrowser()
        return {
          ok: true,
          auth,
          message: `已从 ${browser.name} 捕获登录态（token + ${cookie ? 'cookie + ' : ''}指纹头）`,
          ...(autoLoginError ? { autoLoginError } : {}),
        }
      }

      if (Date.now() - lastNotice > 30_000) {
        lastNotice = Date.now()
        const left = Math.ceil((deadline - Date.now()) / 60_000)
        progress(`等待登录中……（还剩约 ${left} 分钟；已在浏览器里登录的话下一步就会自动读取）`)
      }
      await sleep(pollIntervalMs)
    }
    // 超时：浏览器留着不关，用户下次点按钮可以直接继续
    cdp.close()
    return {
      ok: false,
      reason: 'timeout',
      browserLeftOpen: true,
      ...(autoLoginError ? { autoLoginError } : {}),
      message: `等了 ${Math.round(timeoutMs / 60_000)} 分钟没读到登录态。浏览器窗口保留着，登录完成后可以再点一次「浏览器窗口登录」（profile 复用，不用重新登录）。`,
    }
  } finally {
    cdp.close()
  }
}

/** 清掉浏览器登录用的独立 profile（退出账号时调用：连浏览器端的登录态一起清）。 */
export function clearBrowserLoginProfile(profileDir = DEFAULT_PROFILE_DIR): boolean {
  try {
    rmSync(profileDir, { recursive: true, force: true })
    return true
  } catch {
    // R7（0.1.84）：Windows 上浏览器进程还占着 profile 目录的文件锁 ⇒ rmSync 必 EBUSY。
    // 旧实现直接吞掉返回 false，调用方再用 || 掩盖 ⇒ 「先清登录态」静默失效。
    // 先杀掉本插件拉起的残留浏览器再试一次；还不行就返回 false 让调用方如实上报。
    try {
      lastSpawnedChild?.kill()
    } catch {
      /* 没有可杀的进程就算了 */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}
