/**
 * dsh-deepseek-web-login — 凭证存储与结构化错误。
 *
 * 登录凭证来自 chat.deepseek.com 网页端（浏览器窗口捕获或手动粘贴）：
 * Bearer token + cookie + 反爬指纹头（x-hif-*）+ PoW WASM 地址。
 * 存放于 `${DSH_HOME || ~/.dsh}/web-login/deepseek-auth.json`（插件自治，
 * 不进 settings/credentials 缝合口，避免敏感凭据落入通用配置面）。
 */
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/** DSH 主目录（与生态一致的解析顺序）。 */
export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function authFilePath(): string {
  return join(resolveDshHome(), 'web-login', 'deepseek-auth.json')
}

/** 一份已捕获的网页端登录凭证。 */
export interface WebAuth {
  /** chat.deepseek.com 的 Bearer token（网页端 localStorage userToken）。 */
  token: string
  /** deepseek.com 域 cookie 串（name=value; ...）。 */
  cookie: string
  /** 反爬指纹头（捕获自浏览器请求；缺省为空串）。 */
  hifDliq: string
  hifLeim: string
  /** PoW 求解器 WASM 地址（来自页面资源；缺省用已知默认）。 */
  wasmUrl: string
  /** 登录会话的浏览器 UA（补齐请求指纹）。 */
  userAgent: string
  /**
   * 浏览器真实请求头快照（accept-language / x-client-version 等，随网页端版本走）。
   * 复用它可让插件请求与网页端保持一致，避免硬编码版本号随 DeepSeek 升级失效。
   */
  extraHeaders?: Record<string, string>
  /** 捕获时间（ISO）。 */
  capturedAt: string
  /** 是否未经服务端校验（fail-open 落盘的凭证）。 */
  unverified?: boolean
  /** 已掩码的账号展示信息（可选）。 */
  user?: { id?: string; display?: string }
}

export function readAuth(): WebAuth | undefined {
  try {
    const raw = readFileSync(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token === 'string' && parsed.token.length > 0) {
      return {
        token: parsed.token,
        cookie: typeof parsed.cookie === 'string' ? parsed.cookie : '',
        hifDliq: typeof parsed.hifDliq === 'string' ? parsed.hifDliq : '',
        hifLeim: typeof parsed.hifLeim === 'string' ? parsed.hifLeim : '',
        wasmUrl: typeof parsed.wasmUrl === 'string' ? parsed.wasmUrl : '',
        userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent : '',
        ...(parsed.extraHeaders && typeof parsed.extraHeaders === 'object' ? { extraHeaders: parsed.extraHeaders } : {}),
        capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
        ...(parsed.unverified === true ? { unverified: true } : {}),
        ...(parsed.user && typeof parsed.user === 'object' ? { user: parsed.user } : {}),
      }
    }
  } catch {}
  return undefined
}

export function writeAuth(auth: WebAuth): void {
  const file = authFilePath()
  mkdirSync(join(file, '..'), { recursive: true })
  // 先写临时文件再原子替换，避免半截 JSON 毒化读取。
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8')
  try {
    rmSync(file, { force: true })
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw error
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
    } catch {}
  }
}

export function clearAuth(): void {
  try {
    rmSync(authFilePath(), { force: true })
  } catch {}
}

export function hasUsableAuth(auth: WebAuth | undefined): auth is WebAuth {
  return !!auth && typeof auth.token === 'string' && auth.token.length > 8
}

/**
 * 解包页面读回的 token（兼容裸字符串与 AppKit 包装 JSON）。
 *
 * ⚠️ 两个必须守住的边界（都是实测形态）：
 *  - 未登录时网页端返回的是 `{"value":null,"__version":"0"}` → 必须得到**空串**，
 *    绝不能把字符串 "null" 当 token（否则会拿垃圾 token 去请求，报 40003 让人一头雾水）。
 *  - 旧版本网页端存的是裸 token 字符串 → 原样返回。
 */
export function unwrapStoredToken(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed?.value === 'string' ? parsed.value.trim() : ''
    } catch {
      return ''
    }
  }
  // 兜底：字面量 "null"/"undefined" 一律视为空
  return text === 'null' || text === 'undefined' ? '' : text
}

/** 掩码账号标识（保留可辨识部分，足以确认「是哪个号」而不泄露全量）。 */
export function maskIdentifier(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  const at = value.indexOf('@')
  if (at > 0) {
    const local = value.slice(0, at)
    const keep = Math.min(3, Math.max(1, local.length - 1))
    return `${local.slice(0, keep)}***${value.slice(at)}`
  }
  if (/^\d{6,}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`
  if (value.length <= 4) return `${value[0]}***`
  return `${value.slice(0, 3)}***${value.slice(-2)}`
}

/**
 * 适配器边界错误。自带 `failure` 与 `code` 自有数据属性 ——
 * LlmRuntime.normalizeLlmFailure 通过自有属性（而非 instanceof）读取结构化
 * 失败信息，因此跨模块边界的自包含打包也能携带 code/status/retryAfter。
 */
export class AdapterLlmError extends Error {
  readonly failure: { message: string; code: string; status?: number; providerRetryAfterMs?: number }
  readonly code: string

  constructor(message: string, code: string, options: { status?: number; providerRetryAfterMs?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}),
    }
    // 原型链上设置 cause（Node 22 支持 options.cause，但为稳妥手动挂）
    if (options.cause !== undefined) (this as any).cause = options.cause
  }
}

/** 把 HTTP 状态映射为稳定错误码（对齐 dsh-llm 默认可重试码表：SERVER/RATE_LIMIT/TIMEOUT/TRANSPORT）。 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 402) return 'QUOTA'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_ERROR'
}

/** 解析 Retry-After（秒数或 HTTP-date），返回毫秒。 */
export function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Math.max(1000, Number(text) * 1000)
  const parsed = Date.parse(text)
  if (!Number.isNaN(parsed)) return Math.max(1000, parsed - Date.now())
  return undefined
}

export function existsFile(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}
