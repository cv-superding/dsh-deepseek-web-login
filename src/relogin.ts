/**
 * 邮箱密码凭证库（自动重登用）—— 存储、与账号记录的匹配、以及"哪些号该重登"的判据。
 *
 * ## 为什么要这个
 *
 * 实测（2026-09-30）网页端凭证的寿命只有 **≈2 小时**（三个号分别活 88 / 119 / 120 分钟），
 * 到期后服务端回 `40003 invalid token`，面板显示"需要重新登录"——**账号本身没问题**。
 * 而官方桌面端里插件是纯 Node 子进程（拿不到 Electron / 浏览器分区），
 * 「从已登录窗口恢复」那条路直接返回"当前环境不是 Electron 桌面端"。
 *
 * 于是唯一可行的免人工路径是：**驱动本机真实浏览器**跑一次登录（见 `browser-login.ts`），
 * 那需要邮箱 + 密码 —— 就是这个文件存的东西。
 *
 * ## 存放位置与安全边界（都是刻意的）
 *
 * - 单独文件 `~/.dsh/web-login/credentials.json`，**不写进账号记录** ⇒
 *   账号导出/导入（`exportAccounts` / `importAccounts`）不会把密码带出去。
 * - **明文**存放。没有做任何"看起来安全"的加密：密钥就在同一台机器上，那种加密只是障眼法。
 *   本模块只保证：不写日志、不打除 `chat.deepseek.com` 以外的任何地方。
 * - 匹配用服务端的**脱敏规则**（见 `maskLocalPart`）而不是猜，匹配不上就明说匹配不上。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { webLoginDir } from './paths.ts'
import { writeJsonAtomic } from './accounts.ts'

export interface CredentialEntry {
  /** 完整邮箱（服务端只给我们脱敏串，这里是我们自己存的原文）。 */
  email: string
  password: string
}

export interface CredentialFile {
  version: number
  note?: string
  entries: CredentialEntry[]
}

/** 凭证文件的绝对路径。 */
export function credentialsPath(): string {
  return join(webLoginDir(), 'credentials.json')
}

/**
 * 按服务端的规则把邮箱本地部分脱敏，用来跟 `user.display` 对齐。
 *
 * 实测规则（2026-09-30，两条真实样本）：
 *   `davidciwu33+w4` → `davi*******+w4`   （首 4 + 7 星 + 末 3）
 *   `zanaphiwu69+w68` → `zana********w68` （首 4 + 8 星 + 末 3）
 * 两端固定留 4 / 3，中间一律星号 ⇒ 中间长度 = len - 7。
 * 短于 8 个字符的本地部分服务端另有一套规则，我们**不猜**：返回 undefined，调用方按"匹配不上"处理。
 */
export function maskLocalPart(email: string): string | undefined {
  const at = email.lastIndexOf('@')
  if (at <= 0) return undefined
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length < 8) return undefined
  return `${local.slice(0, 4)}${'*'.repeat(local.length - 7)}${local.slice(-3)}${domain}`
}

/** 容忍坏文件的读取：解析不了、结构不对都当"没有凭证"（不许因此崩掉面板）。 */
export function readCredentialEntries(): CredentialEntry[] {
  const file = credentialsPath()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CredentialFile
    if (!Array.isArray(parsed?.entries)) return []
    return parsed.entries
      .filter((e) => e && typeof e.email === 'string' && typeof e.password === 'string')
      .map((e) => ({ email: e.email.trim(), password: e.password }))
      .filter((e) => e.email.length > 0 && e.password.length > 0)
  } catch {
    return []
  }
}

/** 原子写（先写临时文件再 rename）—— 半截文件会让下一次启动读不到任何凭证。 */
export function writeCredentialEntries(entries: readonly CredentialEntry[], note?: string): void {
  const dir = webLoginDir()
  mkdirSync(dir, { recursive: true })
  const payload: CredentialFile = {
    version: 1,
    note:
      note ??
      '自动重登用的邮箱密码（本机明文存放）。不参与账号导出/导入，不写日志、不打接口以外的任何地方。',
    entries: entries.map((e) => ({ email: e.email.trim(), password: e.password })),
  }
  // 🔴 2026-10-10 外部审查 P3：原来 `writeFileSync(tmp, …, 'utf8')` **不带 mode**
//   ⇒ 临时文件按 umask 落地（POSIX 上通常 0644，同机其它用户可读），
//   而本文件装的是**邮箱 + 明文密码**（敏感度高于 token 文件），
//   却没有享受 `accounts.ts:writeJsonAtomic` 的「创建即 0600 + rename 失败清理」。
// ⇒ 复用那个成熟实现（它也是「原子写 + 0600 + 失败清理」，注释里写了为什么不能事后 chmod）。
writeJsonAtomic(credentialsPath(), payload)
}

/** 新增/更新一条（按邮箱大小写不敏感去重）。 */
export function saveCredential(email: string, password: string): CredentialEntry[] {
  const key = email.trim().toLowerCase()
  if (!key || !password) return readCredentialEntries()
  const entries = readCredentialEntries().filter((e) => e.email.toLowerCase() !== key)
  entries.push({ email: email.trim(), password })
  writeCredentialEntries(entries)
  return entries
}

/** 删除一条。返回是否真的删掉了。 */
export function removeCredential(email: string): boolean {
  const key = email.trim().toLowerCase()
  const before = readCredentialEntries()
  const after = before.filter((e) => e.email.toLowerCase() !== key)
  if (after.length === before.length) return false
  writeCredentialEntries(after)
  return true
}

/**
 * 用账号记录里的脱敏 display 找对应的凭证。
 * 只按"脱敏后完全相等"匹配（含域名），匹配不上就 undefined —— 不猜前缀、不猜后缀。
 */
export function credentialForDisplay(
  display: string | undefined,
  entries: readonly CredentialEntry[] = readCredentialEntries(),
): CredentialEntry | undefined {
  const needle = (display ?? '').trim()
  if (!needle) return undefined
  return entries.find((e) => maskLocalPart(e.email) === needle)
}

/** 账号侧需要的最小信息（只取判据用得到的字段，方便单测构造）。 */
export interface ReloginAccountLike {
  id: string
  capturedAt?: string
  lastVerifyError?: { at?: string } | null
  user?: { display?: string } | null
}

export interface ReloginTarget {
  accountId: string
  email: string
  display: string
  /** 为什么挑中它：`expired` = 已经失效；`expiring` = 快到期（按捕获时间估）；`manual` = 手动一键全刷。 */
  reason: 'expired' | 'expiring' | 'manual'
}

/** 凭证寿命 ≈2 小时（实测 88~120 分钟）；提前 20 分钟就算"快到期"。 */
export const TOKEN_TTL_MS = 120 * 60 * 1000
export const TOKEN_RENEW_AFTER_MS = 100 * 60 * 1000

/**
 * 挑出该重登的账号。
 *
 * `onlyStale = true`（自动续期）只挑**已失效**或**捕获超过 100 分钟**的；
 * `onlyStale = false`（手动「一键重登」）把所有能匹配到凭证的号都挑出来 ——
 * 用户按的是"全刷一遍"，这时候"还没到期"不是跳过它的理由。
 *
 * 挑不出凭证的账号**不会**出现在结果里（调用方据此回一句"没有可用的密码凭证"，
 * 而不是静默什么都不做）。
 */
export function selectReloginTargets(input: {
  accounts: readonly ReloginAccountLike[]
  entries: readonly CredentialEntry[]
  now?: number
  onlyStale?: boolean
}): ReloginTarget[] {
  const now = input.now ?? Date.now()
  const out: ReloginTarget[] = []
  for (const account of input.accounts) {
    const entry = credentialForDisplay(account.user?.display, input.entries)
    if (!entry) continue
    const expired = Boolean(account.lastVerifyError)
    const born = account.capturedAt ? Date.parse(account.capturedAt) : Number.NaN
    const age = Number.isFinite(born) ? now - born : Number.NaN
    const expiring = Number.isFinite(age) && age >= TOKEN_RENEW_AFTER_MS
    if (input.onlyStale && !expired && !expiring) continue
    out.push({
      accountId: account.id,
      email: entry.email,
      display: account.user?.display ?? entry.email,
      reason: expired ? 'expired' : expiring ? 'expiring' : 'manual',
    })
  }
  return out
}

/**
 * 这次重登是"接着用原来那条记录"还是"要新增一条"。
 *
 * 有 accountId ⇒ 重登（写回同一条，`commitCapturedAuth` 会按 id 落库）；
 * 没有 ⇒ 这是一组新凭证（日志里常见的场景：用户直接粘一批密码给我），
 * 登录成功后按服务端返回的 account id 找记录、找不到才新增。
 */
export function reloginMode(target: { accountId?: string }): 'relogin' | 'discover' {
  return target.accountId ? 'relogin' : 'discover'
}
