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
import { createRequire } from 'node:module'
import { clearAuth, maskIdentifier, readAuth, writeAuth, type WebAuth } from './auth.ts'
import { DS_BASE, DEFAULT_WASM_URL, FALLBACK_UA, validateAuth } from './webapi.ts'

const PARTITION = 'persist:dsh-deepseek-web-login'
const LOGIN_URL = `${DS_BASE}/`

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

export function getLoginProgress(): LoginProgress {
  return progress
}

export function getLastLoginResult(): { ok: boolean; message: string; at: string } | undefined {
  return lastResult
}

/** 当前进程是否跑在 Electron 主进程里（DSH Desktop 是；纯 web profile 不是）。 */
export function electronAvailable(): boolean {
  if (!process.versions?.electron) return false
  try {
    createRequire(import.meta.url)('electron')
    return true
  } catch {
    return false
  }
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

/** 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。 */
export function unwrapStoredToken(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed?.value === 'string' ? parsed.value : ''
    } catch {
      return ''
    }
  }
  return text
}

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
    if (relevant.length > 0) buffer.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
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

/** 在 session 上挂请求头捕获钩子。 */
function hookHeaders(ses: any, buffer: CaptureBuffer): void {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://chat.deepseek.com/*', 'https://*.deepseek.com/*'] }, (details: any, callback: any) => {
    const headers = { ...(details?.requestHeaders ?? {}) }
    const lower: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = String(value)
    if (String(details?.url ?? '').includes('/api/')) {
      if (!buffer.userAgent && lower['user-agent']) buffer.userAgent = lower['user-agent']
      const authHeader = lower['authorization']
      if (authHeader?.toLowerCase().startsWith('bearer ')) buffer.headerToken = authHeader.slice(7).trim()
      if (lower['cookie']) buffer.cookie = lower['cookie']
      if (lower['x-hif-dliq']) buffer.hifDliq = lower['x-hif-dliq']
      if (lower['x-hif-leim']) buffer.hifLeim = lower['x-hif-leim']
      if (!buffer.extraHeaders['x-client-version']) {
        const snapshot: Record<string, string> = {}
        for (const [key, value] of Object.entries(lower)) {
          if (!/^x-/.test(key)) continue
          if (key === 'x-ds-pow-response' || key === 'x-hif-dliq' || key === 'x-hif-leim') continue
          snapshot[key] = value
        }
        if (lower['accept-language']) snapshot['accept-language'] = lower['accept-language']
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
  progress = { open: true, startedAt: new Date().toISOString(), captured: progressFrom(buffer) }
  const ses = session.fromPartition(PARTITION)

  try {
    hookHeaders(ses, buffer)
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

  try {
    await win.loadURL(LOGIN_URL)
  } catch (error: any) {
    logger?.warn?.(`deepseek-web login: load failed: ${error?.message ?? error}`)
  }

  const finish = async (auth: WebAuth, verified: boolean): Promise<void> => {
    writeAuth(auth)
    lastResult = {
      ok: true,
      message: verified
        ? `登录成功${auth.user?.display ? `（${maskIdentifier(auth.user.display)}）` : ''}，凭证已保存并校验通过`
        : '已捕获并保存凭证，但服务端校验未通过（可用「发送测试」做真实判定）',
      at: new Date().toISOString(),
    }
    logger?.info?.(`deepseek-web login: credentials saved (verified=${verified})`)
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
          await finish({ ...auth, ...(check.user ? { user: { ...auth.user, ...check.user } } : {}) }, true)
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
      writeAuth({ ...auth, ...(check.user ? { user: { ...auth.user, ...check.user } } : {}) })
      lastResult = { ok: true, message: '已从已登录窗口恢复凭证（校验通过）', at: new Date().toISOString() }
      logger?.info?.('deepseek-web login: recovered credentials from partition (verified)')
      return { ok: true, verified: true, message: '已从已登录窗口恢复凭证（校验通过）' }
    }
  }
  writeAuth(buildAuth(buffer, candidates[0], true))
  lastResult = { ok: true, message: '已从已登录窗口恢复凭证（未通过服务端校验）', at: new Date().toISOString() }
  logger?.info?.('deepseek-web login: recovered credentials from partition (unverified)')
  return { ok: true, verified: false, message: '已恢复凭证，但服务端校验未通过（可用「发送测试」验证）' }
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
    writeAuth({ ...auth, unverified: true })
    lastResult = { ok: true, message: `凭证已保存，但服务端校验未通过：${check.error ?? ''}`, at: new Date().toISOString() }
    logger?.info?.('deepseek-web login: token saved (unverified)')
    return { ok: true, error: `已保存（未通过校验：${check.error ?? 'unknown'}）` }
  }
  writeAuth({ ...auth, ...(check.user ? { user: check.user } : {}) })
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
  // ⚠️ 必须 await：调用方（面板的「退出并登录其它账号」）紧接着就会打开登录窗口，
  // 分区没清完的话新窗口会带着旧账号的 cookie 打开 → 又登录回同一个账号。
  const cleared = await clearLoginPartition().catch(() => false)
  lastResult = {
    ok: true,
    message: cleared
      ? '已退出登录：本地凭证与浏览器登录态都已清除'
      : '已退出登录：本地凭证已清除（浏览器登录态未能清理——非 Electron 环境或清理失败，登录窗口可能仍是旧账号，请手动退出网页端）',
    at: new Date().toISOString(),
  }
  return cleared
}
