/**
 * 本机保存的登录凭据（**仅用于一键重登**）。
 *
 * 为什么需要：网页版的会话 cookie 里有三项是**会话级**的 —— 浏览器进程一退出就没了，
 * 而站点刷新令牌/换登录都会让插件手里那份失效。于是"重登"成了高频动作，每敲一次手机号+密码
 * 都很烦（用户 2026-11-04 明确要求）。
 *
 * 🔴 安全边界（必须让用户知道，不玩"伪加密"）：
 *  - 文件是 **明文** `~/.dsh/web-login/credentials.json`，权限 `0600`；
 *  - 只在本机、只在用户**显式勾选"记住密码"**时写入；
 *  - 不写进账号记录（那是会被导出/备份的），单独一个文件，删它一个就清干净；
 *  - 登录仍在**页面上下文**里做（`browserLogin({credentials})`），不在 Node 侧发密码 ——
 *    直连会被判 `RISK_DEVICE_DETECTED`。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

export interface SavedCredentials {
  email: string
  password: string
  /** 最后一次使用/保存的时间（ISO）。仅展示用。 */
  savedAt?: string
}

type Store = Record<string, SavedCredentials>

function filePath(): string {
  return join(webLoginDir(), 'credentials.json')
}

function readStore(): Store {
  try {
    const raw = readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  const path = filePath()
  const dir = webLoginDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // 原子写：先写临时文件再改名（半截文件会让下次读成空 ⇒ "记住的密码没了"）
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 基本无效；权限靠用户目录本身
  }
}

/** 读某个 key（账号 id 或邮箱）的凭据。 */
export function loadCredential(key: string | undefined): SavedCredentials | undefined {
  if (!key) return undefined
  const store = readStore()
  const hit = store[key]
  if (hit && typeof hit.email === 'string' && typeof hit.password === 'string') return hit
  // 退一步按邮箱找（账号被删了重建时 id 会变，但人还是那个人）
  const byEmail = Object.values(store).find((item) => item?.email === key)
  return byEmail
}

/** 任意一条可用凭据（重登时账户 id 可能对不上，用它兜底）。 */
export function anyCredential(): SavedCredentials | undefined {
  return Object.values(readStore()).find((item) => item?.email && item?.password)
}

/** 保存/更新。key 建议用账号 id；同时按邮箱存一份，便于换 key 后仍能找回。 */
export function saveCredential(key: string, credentials: { email: string; password: string }): void {
  const email = String(credentials.email ?? '').trim()
  const password = String(credentials.password ?? '')
  if (!email || !password) return
  const store = readStore()
  const entry: SavedCredentials = { email, password, savedAt: new Date().toISOString() }
  if (key) store[key] = entry
  store[email] = entry
  writeStore(store)
}

/** 删除（key 与对应邮箱两条都删）。 */
export function clearCredential(key: string | undefined): boolean {
  if (!key) return false
  const store = readStore()
  let removed = false
  // ⚠️ 邮箱必须在**删除之前**取出来 —— 先删 key 再读，拿到的永远是 undefined，
  // 于是"按邮箱存的那一条"留了下来（用例当场抓到：删了等于没删）。
  const email = store[key]?.email
  if (store[key]) {
    delete store[key]
    removed = true
  }
  if (email && store[email]) {
    delete store[email]
    removed = true
  }
  if (removed) writeStore(store)
  return removed
}

/** 有没有保存过（只报布尔，不吐密码）。 */
export function hasSavedCredential(key: string | undefined): boolean {
  return Boolean(loadCredential(key) || anyCredential())
}

/** 彻底删掉整个文件（"清除所有已保存密码"）。 */
export function clearAllCredentials(): boolean {
  try {
    if (!existsSync(filePath())) return false
    rmSync(filePath(), { force: true })
    return true
  } catch {
    return false
  }
}
