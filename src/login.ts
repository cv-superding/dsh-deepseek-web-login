/**
 * 网页登录：Electron 独立分区窗口（persist:dsh-deepseek-web-login）。
 *
 * 为什么用 Electron 窗口而不是外部浏览器 + 扩展/CDP：
 *   DSH Desktop 本身就是 Electron 主进程，插件直接开窗口即可 ——
 *   窗口内用户正常完成手机号/密码/验证码登录，插件旁路捕获：
 *     1) webRequest.onBeforeSendHeaders 抓 /api/* 的真实 Authorization（权威 token）、
 *        Cookie、x-hif-* 指纹头、x-client-* 版本头
 *     2) 读 localStorage —— ⚠️ 实测（2026-09）新版网页端的 userToken 是 AppKit 包装的
 *        JSON：`{"value":"<token>",...}`，必须解包；早期版本才是裸字符串。
 *        把包装 JSON 原文当 token 会被服务端判 40003 Authorization Failed。
 *     3) 校验通过即落盘；**校验不通过也先落盘（fail-open）**，避免出现
 *        「用户已登录成功、但校验端点不配合 → 凭证永远拿不到」的死局。
 * 非 Electron 环境（纯 web profile）自动降级为「手动粘贴 token」。
 */
import { pickCookieMeta, type CookieMeta } from './cookies.ts'
import { createRequire } from 'node:module'
import { clearAuth, maskIdentifier, readAuth, unwrapStoredToken, withVerifiedIdentity, type WebAuth } from './auth.ts'
import { commitCapturedAuth } from './account-add.ts'
import { clearBrowserLoginProfile } from './browser-login.ts'
import { DS_BASE, DEFAULT_WASM_URL, FALLBACK_UA, validateAuth } from './webapi.ts'

const PARTITION = 'persist:dsh-deepseek-web-login'
const LOGIN_URL = `${DS_BASE}/`

// ── 浏览器指纹伪装 ────────────────────────────────────────
// 事故（2026-09-11 用户实测）：点「浏览器窗口登录」后网页端直接显示
//   「使用环境异常 —— 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，
//     建议您使用我们的官方产品。」
// 原因：Electron 的默认 UA 里带应用名与 `Electron/<版本>` 字样，网页端一眼识别出
// 「这不是普通浏览器」就拒绝服务。所以登录窗口必须报**干净的 Chrome UA**。
// 顺带一个好处：捕获到的 UA 会用于后续 API 请求（auth.userAgent），干净的 UA 与网页端一致。

/** 当前运行环境对应的平台串（与 Chromium 的取值一致）。 */
function platformToken(): string {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  return 'X11; Linux x86_64'
}

/**
 * 构造干净的 Chrome UA（剔除 Electron/应用名）。
 * Chromium 大版本取当前运行时真实版本，避免出现「UA 版本与能力不符」这类更明显的矛盾。
 */
export function buildLoginUserAgent(chromiumVersion = process.versions.chrome): string {
  const major = String(chromiumVersion ?? '').split('.')[0] || '131'
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/**
 * 清掉 UA-CH（Sec-CH-UA*）里的 Electron/应用品牌 —— 只改 UA 字符串是不够的：
 * Chromium 还会通过 client hints 把品牌列表发出去，里面同样带着非浏览器品牌。
 * 纯函数，便于单测。
 */
export function sanitizeClientHints(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...headers }
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase()
    if (lower !== 'sec-ch-ua' && lower !== 'sec-ch-ua-full-version-list' && lower !== 'user-agent') continue
    const value = String(out[key])
    if (lower === 'user-agent') {
      // UA 里出现 Electron / 应用名 → 换成干净 Chrome UA
      if (/electron/i.test(value)) out[key] = buildLoginUserAgent()
      continue
    }
    // 品牌列表：只保留 Chromium（丢弃 Electron 等非浏览器品牌）
    const brands = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part && !/electron/i.test(part))
    out[key] = brands.length > 0 ? brands.join(', ') : '"Chromium";v="131", "Not_A Brand";v="24"'
  }
  return out
}

/** 把干净指纹应用到分区与窗口（session 管网络，webContents 管页面里的 navigator.userAgent）。 */
function applyBrowserFingerprint(ses: any, win: any): void {
  const ua = buildLoginUserAgent()
  try {
    ses.setUserAgent(ua)
  } catch {}
  try {
    win.webContents.setUserAgent(ua)
  } catch {}
}

/**
 * 页面内归一化 + 回读「网页端实际看到的指纹」。
 *
 * 为什么要回读：服务端对两种 UA 返回的 HTML 完全一样（实测 2026-09-11 探针），
 * 说明「使用环境异常」是**页面内 JS**判定的。既然如此，就必须能看到**页面到底看到了什么**，
 * 否则永远只能猜（UA 改没改对、品牌列表脏不脏、webdriver 是不是 true）。
 *
 * 归一化只动「非浏览器品牌」与 webdriver 这两个明确属于自动化痕迹的字段；
 * 没有 Electron 痕迹时不做任何改写。
 */
function observePageFingerprint(win: any, report: { pageUa?: string; pageBrands?: string[]; pageWebdriver?: boolean }): void {
  const script = `(() => {
    const bad = /electron|dsh|deepseek-harness/i
    let patchedBrands = null
    try {
      const data = navigator.userAgentData
      if (data && Array.isArray(data.brands)) {
        const dirty = data.brands.filter((b) => bad.test(String(b.brand)))
        if (dirty.length > 0) {
          const clean = data.brands.filter((b) => !bad.test(String(b.brand)))
          try {
            Object.defineProperty(Object.getPrototypeOf(data), 'brands', { get: () => clean, configurable: true })
          } catch {}
        }
      }
    } catch {}
    try {
      if (navigator.webdriver) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => false, configurable: true })
      }
    } catch {}
    try {
      const data = navigator.userAgentData
      patchedBrands = data && Array.isArray(data.brands) ? data.brands.map((b) => b.brand + '/' + b.version) : null
    } catch {}
    return JSON.stringify({
      ua: navigator.userAgent,
      brands: patchedBrands,
      webdriver: !!navigator.webdriver,
    })
  })()`
  const read = (): void => {
    try {
      const promise = win.webContents.executeJavaScript(script, true)
      void Promise.resolve(promise)
        .then((raw: any) => {
          try {
            const info = JSON.parse(String(raw))
            report.pageUa = String(info.ua ?? '')
            report.pageBrands = Array.isArray(info.brands) ? info.brands.map(String) : undefined
            report.pageWebdriver = !!info.webdriver
            fingerprintReport = { ...(fingerprintReport ?? { at: new Date().toISOString(), url: LOGIN_URL, stripped: [] }), ...report }
          } catch {}
        })
        .catch(() => {})
    } catch {}
  }
  try {
    win.webContents.on('dom-ready', read)
    win.webContents.on('did-finish-load', read)
  } catch {}
}

let loginWindow: any = null
let pollTimer: ReturnType<typeof setInterval> | null = null

export interface LoginProgress {
  open: boolean
  startedAt?: string
  /** 已捕获的中间态（用于 UI 提示），不含完整 token。 */
  captured?: { token: boolean; cookie: boolean; fingerprint: boolean; wasm: boolean }
  lastError?: string
  finished?: boolean
}

let progress: LoginProgress = { open: false }
let lastResult: { ok: boolean; message: string; at: string } | undefined

/**
 * 最近一次「剔除 Electron 指纹」的记录。
 * 留这个是为了让面板能如实展示「到底改了哪些头、页面实际看到了什么」——
 * 否则用户没法判断环境异常是已经被处理掉了，还是压根没生效。
 */
export interface FingerprintReport {
  at: string
  url: string
  /** 被改写的请求头名（空数组 = 本次没发现 Electron 痕迹） */
  stripped: string[]
  /** 页面里回读到的 UA —— 网页端实际看到的就是它 */
  pageUa?: string
  /** 页面里回读到的品牌列表（navigator.userAgentData.brands） */
  pageBrands?: string[]
  /** 页面里的 navigator.webdriver（自动化痕迹，正常浏览器为 false） */
  pageWebdriver?: boolean
}

let fingerprintReport: FingerprintReport | undefined

export function getFingerprintReport(): FingerprintReport | undefined {
  return fingerprintReport
}

/**
 * 用**系统默认浏览器**打开 chat.deepseek.com（兜底路径）。
 *
 * 适用场景：网页端连干净指纹的窗口也拦、或者用户就是想用自己的日常浏览器。
 * 注意：外部浏览器里的登录态插件抓不到（没有 webRequest 钩子），
 * 所以这条路径要和「手动粘贴 token」配合 —— 面板里给了现成的控制台命令。
 *
 * ⚠️ 2026-09-11：插件宿主在 **utility 进程**里没有 `shell`（主进程专属），所以加了
 * 纯 Node 的打开方式（Windows `start` / macOS `open` / Linux `xdg-open`），保证任何宿主都能用。
 */
/** 单测注入：替换 spawn（默认用 node:child_process 的真身）。 */
let spawnImpl: typeof import('node:child_process').spawn | undefined
export function setSpawnImpl(impl?: typeof import('node:child_process').spawn): void {
  spawnImpl = impl
}

/**
 * 用系统浏览器打开登录页。
 *
 * ⚠️ 2026-09-13 第二轮审计 N10：旧实现在 `spawn(...)` 之后立刻 `return {ok:true}`，
 * 外面那层 try/catch **只能接同步异常**；`error` 是 EventEmitter 在下一个事件循环异步发出的，
 * 没有监听就意味着**未处理错误 → 宿主进程直接退出**（同一类问题在 browser-login.ts 修过，
 * 这条路径漏了）。现在等 `spawn`/`error` 之一落地再返回。
 */
export async function openExternalLogin(): Promise<{ ok: boolean; url: string; message?: string; via?: string }> {
  // 主进程：用 Electron 的 shell（最干净）
  if (canOpenElectronWindow()) {
    try {
      const electron = createRequire(import.meta.url)('electron')
      await electron.shell.openExternal(LOGIN_URL)
      return { ok: true, url: LOGIN_URL, via: 'electron-shell' }
    } catch {
      // 继续走下面的纯 Node 兜底
    }
  }
  const failed = (error: unknown) => ({
    ok: false,
    url: LOGIN_URL,
    message: `${error instanceof Error ? error.message : String(error)} —— 请手动在浏览器打开 ${LOGIN_URL}`,
  })
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', LOGIN_URL] : [LOGIN_URL]
    return await new Promise((resolve) => {
      const child = (spawnImpl ?? createRequire(import.meta.url)('node:child_process').spawn)(command, args, {
        stdio: 'ignore',
        detached: true,
      })
      // 必须监听：不监听的话这里会在下一个事件循环把宿主整个带走
      child.once('error', (error: Error) => resolve(failed(error)))
      child.once('spawn', () => {
        child.unref?.()
        resolve({ ok: true, url: LOGIN_URL, via: command })
      })
    })
  } catch (error) {
    return failed(error)
  }
}

export function getLoginProgress(): LoginProgress {
  return progress
}

export function getLastLoginResult(): { ok: boolean; message: string; at: string } | undefined {
  return lastResult
}

/**
 * 本进程能否**真的开 Electron 窗口**（= Electron 主进程，且 electron 模块带 session/BrowserWindow）。
 *
 * ⚠️ 旧实现只检查 `process.versions.electron`，在 DSH 把插件宿主挪到 **utility 进程**之后成了**假阳性**：
 * `process.versions.electron` 依然有值，但 utility 进程里 `require('electron')` 拿不到
 * `BrowserWindow` / `session`（它们是主进程专属 API）→ 检查通过、随后炸在 `session.fromPartition`
 * （实测：`Cannot read properties of undefined (reading 'fromPartition')`，面板表现是「窗口登录打不开」）。
 */
export function canOpenElectronWindow(): boolean {
  return canOpenElectronWindowWith({
    versions: process.versions,
    processType: (process as any).type,
    loadElectron: () => createRequire(import.meta.url)('electron'),
  })
}

/**
 * canOpenElectronWindow 的纯函数内核（便于用真实事故参数做单测）。
 * 判定条件三条缺一不可：① 是 Electron 运行时；② 进程类型是主进程；③ electron 模块真的带窗口 API。
 */
export function canOpenElectronWindowWith(deps: {
  versions?: { electron?: string } | undefined
  processType?: string | undefined
  loadElectron: () => any
}): boolean {
  if (!deps.versions?.electron) return false
  // 'browser' = Electron 主进程；utility / renderer 都没有窗口 API
  if (deps.processType && deps.processType !== 'browser') return false
  try {
    const electron = deps.loadElectron()
    if (!electron || typeof electron === 'string') return false
    return !!(electron.session && electron.BrowserWindow)
  } catch {
    return false
  }
}

/** 兼容旧调用点：语义即「能否使用 Electron 能力」，因此等同于 canOpenElectronWindow。 */
export function electronAvailable(): boolean {
  return canOpenElectronWindow()
}

export function isLoginWindowOpen(): boolean {
  return !!loginWindow
}

export function hasStoredAuth(): boolean {
  return !!readAuth()?.token
}

function cleanup(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  loginWindow = null
  progress = { ...progress, open: false }
}

/** 页面内取值脚本：处理 AppKit 包装（{"value":...}）与裸值两种形态。 */
const PAGE_READ_SCRIPT = `JSON.stringify({
  userToken: (function () {
    try {
      var raw = localStorage.getItem('userToken')
      if (!raw) return ''
      if (raw.charAt(0) === '{') {
        var parsed = JSON.parse(raw)
        return typeof parsed.value === 'string' ? parsed.value : ''
      }
      return raw
    } catch (e) { return '' }
  })(),
  userInfo: (function () {
    try {
      var raw = localStorage.getItem('__appKit_userInfo')
      if (!raw) return ''
      var parsed = JSON.parse(raw)
      var value = parsed && parsed.value ? parsed.value : parsed
      return JSON.stringify({ id: value && value.id, name: value && (value.name || value.nickname) })
    } catch (e) { return '' }
  })(),
  hifLeim: (function () {
    try {
      var raw = localStorage.getItem('hif_leim_cached')
      if (!raw) return ''
      if (raw.charAt(0) === '"') return JSON.parse(raw)
      return raw
    } catch (e) { return '' }
  })(),
  wasm: (function () {
    try {
      return performance.getEntriesByType('resource').map(function (r) { return r.name })
        .find(function (n) { return /sha3[^\\s]*\\.wasm/.test(n) }) || ''
    } catch (e) { return '' }
  })()
})`

// unwrapStoredToken 已移到 auth.ts（浏览器登录与 Electron 登录都要用它，
// 放在 auth.ts 可避免 browser-login ↔ login 的循环 import）。
export { unwrapStoredToken } from './auth.ts'

function successPage(message: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>DSH · 登录成功</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 .card{text-align:center;padding:36px 48px;border:1px solid #2a2f3a;border-radius:14px;background:#151922}
 .ok{font-size:44px;margin-bottom:10px}
 .sub{color:#8b93a3;font-size:13px;margin-top:8px}
</style>
<div class="card"><div class="ok">✅</div><div>${message}</div>
<div class="sub">此窗口将自动关闭，可回到 DSH 继续使用</div></div>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

interface CaptureBuffer {
  /** 来自 /api/* 请求头的 Bearer（权威） */
  headerToken: string
  /** 来自 localStorage.userToken（解包后） */
  localToken: string
  cookie: string
  cookieMeta: CookieMeta[]
  hifDliq: string
  hifLeim: string
  wasmUrl: string
  userAgent: string
  extraHeaders: Record<string, string>
  user: { id?: string; display?: string }
}

function newBuffer(): CaptureBuffer {
  return {
    headerToken: '',
    localToken: '',
    cookie: '',
    cookieMeta: [],
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: '',
    extraHeaders: {},
    user: {},
  }
}

/** 候选 token：请求头里的（服务端实际在用，权威）优先，其次 localStorage。 */
function tokenCandidates(buffer: CaptureBuffer): string[] {
  return [...new Set([buffer.headerToken, buffer.localToken].filter((token) => !!token && token.length > 8))]
}

function buildAuth(buffer: CaptureBuffer, token: string, unverified: boolean): WebAuth {
  return {
    token,
    cookie: buffer.cookie,
    cookieMeta: buffer.cookieMeta,
    hifDliq: buffer.hifDliq,
    hifLeim: buffer.hifLeim,
    wasmUrl: buffer.wasmUrl || DEFAULT_WASM_URL,
    userAgent: buffer.userAgent || FALLBACK_UA,
    ...(Object.keys(buffer.extraHeaders).length > 0 ? { extraHeaders: buffer.extraHeaders } : {}),
    capturedAt: new Date().toISOString(),
    ...(unverified ? { unverified: true } : {}),
    ...(Object.keys(buffer.user).length > 0 ? { user: buffer.user } : {}),
  }
}

function progressFrom(buffer: CaptureBuffer): LoginProgress['captured'] {
  return {
    token: tokenCandidates(buffer).length > 0,
    cookie: !!buffer.cookie,
    fingerprint: !!(buffer.hifDliq || buffer.hifLeim),
    wasm: !!buffer.wasmUrl,
  }
}

async function readCookies(ses: any, buffer: CaptureBuffer): Promise<void> {
  try {
    const cookies: any[] = await ses.cookies.get({})
    const relevant = cookies.filter((cookie) => String(cookie?.domain ?? '').includes('deepseek.com'))
    if (relevant.length > 0) {
      buffer.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      // 过滤条件与上面拼 cookie 头时**逐字一致**（同一批 relevant）。
      // Electron 的 cookie 对象用 `expirationDate`（秒），会话级不出现该字段。
      buffer.cookieMeta = pickCookieMeta(relevant, (domain) =>
        String(domain ?? '').includes('deepseek.com'),
      )
    }
  } catch {}
}

async function readPage(win: any, buffer: CaptureBuffer): Promise<void> {
  try {
    const raw = await win.webContents.executeJavaScript(PAGE_READ_SCRIPT, true)
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw
    const token = unwrapStoredToken(info?.userToken)
    if (token) buffer.localToken = token
    if (info?.hifLeim) buffer.hifLeim = String(info.hifLeim)
    if (info?.wasm) buffer.wasmUrl = String(info.wasm)
    if (info?.userInfo) {
      try {
        const parsed = JSON.parse(String(info.userInfo))
        if (parsed?.id) buffer.user.id = String(parsed.id)
        if (parsed?.name) buffer.user.display = String(parsed.name)
      } catch {}
    }
  } catch {
    // 页面导航中 executeJavaScript 可能失败：下一轮重试
  }
}

/**
 * 在 session 上挂请求头捕获钩子（同时负责剔除 Electron 指纹）。
 * ⚠️ 一个 session 只能注册一个 onBeforeSendHeaders 处理器（后注册会覆盖先注册），
 * 所以「清理指纹」必须合并在同一个回调里，不能另开一个。
 */
function hookHeaders(ses: any, buffer: CaptureBuffer, onRewrite?: (info: { url: string; stripped: string[] }) => void): void {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://chat.deepseek.com/*', 'https://*.deepseek.com/*'] }, (details: any, callback: any) => {
    const headers = { ...(details?.requestHeaders ?? {}) }
    const lower: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value)
    // 先剔除 Electron 品牌（UA 字符串 + UA-CH）；否则网页端会判定「使用环境异常」
    const sanitized = sanitizeClientHints(headers)
    const stripped: string[] = []
    for (const key of Object.keys(headers)) {
      if (String(headers[key]) !== String(sanitized[key])) stripped.push(key.toLowerCase())
    }
    for (const key of Object.keys(headers)) delete headers[key]
    Object.assign(headers, sanitized)
    if (stripped.length > 0) onRewrite?.({ url: String(details?.url ?? ''), stripped })
    // 捕获用**清理后**的头（捕获到的 UA 之后会用于 API 请求，必须是干净的那个）
    const cleanLower: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) cleanLower[key.toLowerCase()] = String(value)
    if (String(details?.url ?? '').includes('/api/')) {
      if (!buffer.userAgent && cleanLower['user-agent']) buffer.userAgent = cleanLower['user-agent']
      const authHeader = cleanLower['authorization']
      if (authHeader?.toLowerCase().startsWith('bearer ')) buffer.headerToken = authHeader.slice(7).trim()
      if (cleanLower['cookie']) buffer.cookie = cleanLower['cookie']
      if (cleanLower['x-hif-dliq']) buffer.hifDliq = cleanLower['x-hif-dliq']
      if (cleanLower['x-hif-leim']) buffer.hifLeim = cleanLower['x-hif-leim']
      if (!buffer.extraHeaders['x-client-version']) {
        const snapshot: Record<string, string> = {}
        for (const [key, value] of Object.entries(cleanLower)) {
          if (!/^x-/.test(key)) continue
          if (key === 'x-ds-pow-response' || key === 'x-hif-dliq' || key === 'x-hif-leim') continue
          snapshot[key] = value
        }
        if (cleanLower['accept-language']) snapshot['accept-language'] = cleanLower['accept-language']
        buffer.extraHeaders = snapshot
      }
    }
    callback({ requestHeaders: headers })
  })
}

/**
 * 打开登录窗口并开始捕获（分区已登录时几乎是瞬间完成）。
 */
export async function openLoginWindow(logger?: { info?: (m: string) => void; warn?: (m: string) => void }): Promise<{ started: boolean; reason?: string }> {
  if (!electronAvailable()) return { started: false, reason: 'not-electron' }
  if (loginWindow) {
    try {
      loginWindow.focus()
    } catch {}
    return { started: true, reason: 'already-open' }
  }

  const electron = createRequire(import.meta.url)('electron')
  const { BrowserWindow, session } = electron

  const buffer = newBuffer()
  fingerprintReport = undefined
  progress = { open: true, startedAt: new Date().toISOString(), captured: progressFrom(buffer) }
  const ses = session.fromPartition(PARTITION)

  try {
    hookHeaders(ses, buffer, (info) => {
      // 只记第一次命中（避免刷屏），但要保留后面回读到的页面指纹
      if (!fingerprintReport) {
        fingerprintReport = { at: new Date().toISOString(), url: info.url, stripped: info.stripped }
        logger?.info?.(`deepseek-web login: 已剔除 Electron 指纹头 [${info.stripped.join(', ')}]`)
      } else {
        fingerprintReport = { ...fingerprintReport, stripped: info.stripped }
      }
    })
  } catch (error: any) {
    logger?.warn?.(`deepseek-web login: header capture unavailable: ${error?.message ?? error}`)
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    title: 'DSH · 登录 DeepSeek 网页版（登录后自动捕获）',
    autoHideMenuBar: true,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
  })
  loginWindow = win
  win.on('closed', () => cleanup())
  // ⚠️ 必须在 loadURL 之前应用：网页端第一次请求就带 UA，晚一步就来不及了
  applyBrowserFingerprint(ses, win)
  // 页面加载后回读「网页端实际看到的指纹」，并顺手抹掉 JS 侧的品牌/webdriver 痕迹
  observePageFingerprint(win, {})

  try {
    await win.loadURL(LOGIN_URL)
  } catch (error: any) {
    logger?.warn?.(`deepseek-web login: load failed: ${error?.message ?? error}`)
  }

  const finish = async (auth: WebAuth, verified: boolean): Promise<void> => {
    // 走统一的落库动作：添加模式（点了「登录新账号」）下只入库、不切换当前账号，
    // 否则每加一个号就把正在用的号顶掉了。见 account-add.ts。
    const commit = commitCapturedAuth(auth)
    const tail = commit.mode === 'add' ? '（已加入账号库，当前账号未改动）' : ''
    lastResult = {
      ok: true,
      message:
        (verified
          ? `登录成功${auth.user?.display ? `（${maskIdentifier(auth.user.display)}）` : ''}，凭证已保存并校验通过`
          : '已捕获并保存凭证，但服务端校验未通过（可用「发送测试」做真实判定）') + tail,
      at: new Date().toISOString(),
    }
    logger?.info?.(`deepseek-web login: credentials saved (verified=${verified}, mode=${commit.mode})`)
    progress = { ...progress, finished: true }
    if (!verified) {
      try {
        win.setTitle('DSH · 已捕获凭证（未通过服务端校验，可直接关闭此窗口）')
      } catch {}
      return
    }
    try {
      await win.loadURL(successPage('已捕获 DeepSeek 网页端登录状态'))
    } catch {}
    setTimeout(() => {
      try {
        win.close()
      } catch {}
    }, 3500)
  }

  let attempts = 0
  pollTimer = setInterval(() => {
    void (async () => {
      if (!loginWindow) return
      await readPage(win, buffer)
      await readCookies(ses, buffer)
      progress.captured = progressFrom(buffer)

      const candidates = tokenCandidates(buffer)
      if (candidates.length === 0) return
      attempts += 1

      let lastError = ''
      for (const token of candidates) {
        const auth = buildAuth(buffer, token, false)
        const check = await validateAuth(auth)
        if (check.ok) {
          await finish(withVerifiedIdentity(auth, check.user), true)
          return
        }
        lastError = check.error ?? 'validation failed'
      }
      progress = { ...progress, lastError }

      // fail-open：连续 3 轮校验不通过也落盘，避免凭证彻底丢失
      if (attempts >= 3) await finish(buildAuth(buffer, candidates[0], true), false)
    })()
  }, 2000)
  ;(pollTimer as any).unref?.()

  return { started: true }
}

/**
 * 从已登录的持久化分区恢复凭证（免重新登录）。
 * 用于凭证文件被删/未落盘、或重启后快速恢复。
 */
export async function captureFromPartition(logger?: { info?: (m: string) => void; warn?: (m: string) => void }): Promise<{ ok: boolean; verified: boolean; message: string }> {
  if (!electronAvailable()) return { ok: false, verified: false, message: '当前环境不是 Electron 桌面端' }
  const electron = createRequire(import.meta.url)('electron')
  const { BrowserWindow, session } = electron
  const ses = session.fromPartition(PARTITION)
  const buffer = newBuffer()
  let win: any
  try {
    win = new BrowserWindow({ show: false, width: 1000, height: 720, webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true } })
    try {
      hookHeaders(ses, buffer)
    } catch {}
    await win.loadURL(LOGIN_URL)
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await readPage(win, buffer)
      if (buffer.headerToken || buffer.localToken) break
    }
    await readCookies(ses, buffer)
  } catch (error: any) {
    try {
      if (win && !win.isDestroyed()) win.close()
    } catch {}
    return { ok: false, verified: false, message: `打开分区失败：${error?.message ?? error}` }
  }
  try {
    if (win && !win.isDestroyed()) win.close()
  } catch {}

  const candidates = tokenCandidates(buffer)
  if (candidates.length === 0) {
    return { ok: false, verified: false, message: '分区里没有登录态：请先用「浏览器窗口登录」登录一次' }
  }
  for (const token of candidates) {
    const auth = buildAuth(buffer, token, false)
    const check = await validateAuth(auth)
    if (check.ok) {
      const commit = commitCapturedAuth(withVerifiedIdentity(auth, check.user))
      const tail = commit.mode === 'add' ? '（已加入账号库，当前账号未改动）' : ''
      lastResult = { ok: true, message: '已从已登录窗口恢复凭证（校验通过）' + tail, at: new Date().toISOString() }
      logger?.info?.(`deepseek-web login: recovered credentials from partition (verified, mode=${commit.mode})`)
      return { ok: true, verified: true, message: '已从已登录窗口恢复凭证（校验通过）' + tail }
    }
  }
  const fallback = commitCapturedAuth(buildAuth(buffer, candidates[0], true))
  const tail = fallback.mode === 'add' ? '（已加入账号库，当前账号未改动）' : ''
  lastResult = { ok: true, message: '已从已登录窗口恢复凭证（未通过服务端校验）' + tail, at: new Date().toISOString() }
  logger?.info?.(`deepseek-web login: recovered credentials from partition (unverified, mode=${fallback.mode})`)
  return { ok: true, verified: false, message: '已恢复凭证，但服务端校验未通过（可用「发送测试」验证）' + tail }
}

/** 手动粘贴 token 登录（非 Electron 环境 / 用户偏好）。 */
export async function loginWithToken(
  token: string,
  cookie?: string,
  logger?: { info?: (m: string) => void },
): Promise<{ ok: boolean; error?: string; display?: string }> {
  const trimmed = unwrapStoredToken(token) || String(token ?? '').trim()
  if (trimmed.length < 8) return { ok: false, error: 'token 太短，请确认复制的是 chat.deepseek.com 的登录 token' }
  const auth: WebAuth = {
    token: trimmed,
    cookie: String(cookie ?? '').trim(),
    hifDliq: '',
    hifLeim: '',
    wasmUrl: DEFAULT_WASM_URL,
    userAgent: FALLBACK_UA,
    capturedAt: new Date().toISOString(),
  }
  const check = await validateAuth(auth)
  if (!check.ok) {
    // fail-open：手工粘贴的凭证也落盘（校验端点可能不配合），真实判定交给「发送测试」
    // 手动粘 token 也尊重添加模式：用户点的是「登录新账号」，只是换了条路
    commitCapturedAuth({ ...auth, unverified: true })
    lastResult = { ok: true, message: `凭证已保存，但服务端校验未通过：${check.error ?? ''}`, at: new Date().toISOString() }
    logger?.info?.('deepseek-web login: token saved (unverified)')
    return { ok: true, error: `已保存（未通过校验：${check.error ?? 'unknown'}）` }
  }
  commitCapturedAuth(withVerifiedIdentity(auth, check.user))
  lastResult = {
    ok: true,
    message: `token 校验通过，凭证已保存${check.user?.display ? `（${maskIdentifier(check.user.display)}）` : ''}`,
    at: new Date().toISOString(),
  }
  logger?.info?.('deepseek-web login: token saved')
  return { ok: true, ...(check.user?.display ? { display: maskIdentifier(check.user.display) } : {}) }
}

/**
 * 清掉登录窗口所在 Electron 分区里的 **chat.deepseek.com 站点数据**（cookie / localStorage）。
 *
 * 为什么必须做：只删本地凭证文件的话，浏览器分区里仍是同一个账号的登录态 ——
 * 于是「退出当前账号」之后：
 *   1) 再点「从已登录窗口恢复」会把**同一个账号**原样抓回来（用户以为退不掉）；
 *   2) 点「浏览器窗口登录」打开的是已登录页面，根本没法换号。
 * 只清 deepseek 域，不动分区里的其它数据；失败静默（退出登录本身必须成功）。
 */
export async function clearLoginPartition(): Promise<boolean> {
  if (!electronAvailable()) return false
  try {
    const electron = createRequire(import.meta.url)('electron')
    const ses = electron.session.fromPartition(PARTITION)
    await ses.clearStorageData({
      origin: 'https://chat.deepseek.com',
      storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 退出登录：关闭登录窗口 → 清除本地凭证 → **清除浏览器分区里的站点登录态**。
 *
 * 最后一步是 2026-09-11 补的：此前只有前两步，导致「退出」在网页端看来根本没退出
 * （同一个账号随时能被恢复回来，也无法切换到另一个账号）。
 */
/**
 * 只关闭登录窗口（不动凭证）。
 * 卸载/热重载插件时用它 —— 卸载插件不应该把用户登出（这是旧实现的一个隐患：
 * 卸载时它调用的是 logout()，会把凭证一起删掉）。
 */
export function closeLoginWindow(): void {
  if (loginWindow) {
    try {
      loginWindow.close()
    } catch {}
  }
  cleanup()
}

export async function logout(): Promise<boolean> {
  closeLoginWindow()
  clearAuth()
  // 浏览器登录用的独立 profile 也是一个「登录态存放处」，退出要一起清 ——
  // 否则再点登录会直接复用里面的登录态，等于没退出。
  const browserProfileCleared = clearBrowserLoginProfile()
  // ⚠️ 必须 await：调用方（面板的「退出并登录其它账号」）紧接着就会打开登录窗口，
  // 分区没清完的话新窗口会带着旧账号的 cookie 打开 → 又登录回同一个账号。
  const partitionCleared = await clearLoginPartition().catch(() => false)
  const cleared = partitionCleared || browserProfileCleared
  lastResult = {
    ok: true,
    message: cleared
      ? '已退出登录：本地凭证与浏览器登录态都已清除'
      : '已退出登录：本地凭证已清除（浏览器登录态未能清理——非主进程环境或清理失败，登录窗口可能仍是旧账号，请手动退出网页端）',
    at: new Date().toISOString(),
  }
  return cleared
}
