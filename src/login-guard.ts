/**
 * 登录熔断：**别让用户在"环境已被站点限制"的时候一直点登录**。
 *
 * 现场（2026-11-04 用户截图）：`chat.deepseek.com/sign_in` 弹出
 * 「由于违规次数过多，你的账户已被临时停用」—— 换任何账号都一样。
 * 这是**环境级**（IP / 设备指纹）判定，重试只会加重；而面板上"登录"按钮
 * 每点一次都是一次新的登录尝试，用户自然会一直点。
 *
 * 策略（简单、可解释）：
 *  - 连续失败 3 次 ⇒ 冷却 **30 分钟**；
 *  - 连续失败 5 次 ⇒ 冷却 **6 小时**（基本就是"这台机器今天别试了"）；
 *  - 成功一次 ⇒ 计数清零。
 * 状态落盘在 `~/.dsh/web-login/login-guard.json`（重启也记得住，否则重启即"解锁"）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

interface GuardState {
  /** 连续失败次数 */
  failures: number
  /** 冷却截止时间（ms since epoch，0 = 未冷却） */
  blockedUntil: number
  /** 上一次失败时间 */
  lastFailureAt: number
  /** 上次记录的原因（展示用） */
  lastReason?: string
}

const COOLDOWN_STEPS: ReadonlyArray<{ failures: number; ms: number; hint: string }> = [
  { failures: 5, ms: 6 * 60 * 60 * 1000, hint: '连续失败太多，冷却 6 小时' },
  { failures: 3, ms: 30 * 60 * 1000, hint: '连续失败，冷却 30 分钟' },
]

function filePath(): string {
  return join(webLoginDir(), 'login-guard.json')
}

function read(): GuardState {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8'))
    return {
      failures: Number(parsed?.failures) || 0,
      blockedUntil: Number(parsed?.blockedUntil) || 0,
      lastFailureAt: Number(parsed?.lastFailureAt) || 0,
      lastReason: typeof parsed?.lastReason === 'string' ? parsed.lastReason : undefined,
    }
  } catch {
    return { failures: 0, blockedUntil: 0, lastFailureAt: 0 }
  }
}

function write(state: GuardState): void {
  try {
    const dir = webLoginDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = filePath()
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // 落盘失败不影响本次判断（只是重启后忘了冷却）
  }
}

export interface LoginGuardDecision {
  allowed: boolean
  /** 还要等多久（分钟，向上取整） */
  waitMinutes?: number
  message?: string
}

/** 现在能不能发起登录。 */
export function canAttemptLogin(now = Date.now()): LoginGuardDecision {
  const state = read()
  if (state.blockedUntil > now) {
    const waitMinutes = Math.max(1, Math.ceil((state.blockedUntil - now) / 60_000))
    return {
      allowed: false,
      waitMinutes,
      message:
        `登录冷却中（还需 ${waitMinutes} 分钟）—— 站点可能已对这台机器/这个网络做了限制` +
        `（常见提示："由于违规次数过多，你的账户已被临时停用"）。` +
        `冷却期内继续尝试只会加重判定：请换网络（手机热点/另一条宽带）或等冷却结束再试。`,
    }
  }
  return { allowed: true }
}

/** 记一次失败；到阈值就进入冷却。 */
export function recordLoginFailure(reason?: string, now = Date.now()): LoginGuardDecision {
  const state = read()
  state.failures += 1
  state.lastFailureAt = now
  state.lastReason = reason
  const step = COOLDOWN_STEPS.find((item) => state.failures >= item.failures)
  if (step) {
    state.blockedUntil = now + step.ms
    write(state)
    return canAttemptLogin(now)
  }
  write(state)
  return { allowed: true }
}

/** 记一次成功：清零。 */
export function recordLoginSuccess(): void {
  write({ failures: 0, blockedUntil: 0, lastFailureAt: 0 })
}

/** 面板展示用（不改状态）。 */
export function loginGuardStatus(now = Date.now()): GuardState & { cooling: boolean } {
  const state = read()
  return { ...state, cooling: state.blockedUntil > now }
}
