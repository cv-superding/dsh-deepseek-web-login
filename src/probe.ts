/**
 * 登录态主动探活 —— 在任务跑到一半之前发现登录态失效。
 *
 * 借鉴 workbuddy-switch 的「Token 保活」。它的做法是"操作前不足阈值就刷新 + 每日无条件刷新一次"，
 * 但我们这边**没有 refresh token 可刷**：网页端 token 只能靠重新登录（浏览器捕获）拿新的。
 * 所以能做的只有**尽早发现失效**：
 *
 *  - 启动后延迟一小会儿探一次（覆盖"隔天打开 DSH"这个最常见的过期场景）；
 *  - 之后每 N 分钟探一次（默认 30 分钟，可关）；
 *  - 探活走**只读**的 `users/current`（零额度、实测 ~430ms），**不生成任何内容**；
 *    端点不可用时 `validateAuth` 自己会退回 PoW challenge 探活。
 *
 * 为什么值得：登录态过期现在的表现是"几十步的任务跑到一半突然失败"。
 * 一次只读探活的成本可以忽略，换来的是提前知道 —— 而且探活失败**只提示、不阻断**。
 *
 * ⚠️ 注意与"账号级限制"是两回事：受限期间 `users/current` 依然返回 200，
 * 所以探活**探不出**限制状态（那个只能从生成请求被拒里学到，见 accounts.ts 的 limit 字段）。
 */
import { hasUsableAuth, type WebAuth } from './auth.ts'
import { listAccounts, updateAccount } from './accounts.ts'
import { validateAuth } from './webapi.ts'

export interface ProbeOutcome {
  ok: boolean
  at: string
  error?: string
}

interface ProbeLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * 探一次。返回 `undefined` 表示"没什么可探的"（未登录）。
 *
 * 结果写回**发起探活时那个账号**（按 token 匹配）——
 * 探活期间用户可能已经切号，绝不能把结果写到新账号头上。
 */
export async function probeOnce(auth: WebAuth | undefined, logger?: ProbeLogger): Promise<ProbeOutcome | undefined> {
  if (!hasUsableAuth(auth)) return undefined
  const at = new Date().toISOString()
  const target = listAccounts().find((item) => item.token === auth.token)

  let outcome: ProbeOutcome
  try {
    const result = await validateAuth(auth, AbortSignal.timeout(20_000))
    outcome = result.ok ? { ok: true, at } : { ok: false, at, error: result.error ?? '校验未通过' }
  } catch (error: any) {
    outcome = { ok: false, at, error: error?.message ?? String(error) }
  }

  if (target) {
    if (outcome.ok) {
      // 成功：记录时间，并**清掉**上一次的失败（`undefined` 会被规范化为"字段不存在"）
      updateAccount(target.id, { lastVerifiedAt: at, lastVerifyError: undefined })
    } else {
      updateAccount(target.id, { lastVerifyError: { at, message: String(outcome.error ?? '') } })
    }
  }

  if (outcome.ok) {
    logger?.info?.(`deepseek-web: 登录态探活通过（${target?.id ?? '未知账号'}）`)
  } else {
    logger?.warn?.(`deepseek-web: 登录态探活失败 —— ${outcome.error}（可能已过期，建议重新登录）`)
  }
  return outcome
}

export interface ProbeLoopOptions {
  /** 间隔毫秒；<= 0 表示关闭（不创建任何定时器）。 */
  intervalMs: number
  /** 首次探活的延迟，默认 20 秒 —— 别和 DSH 启动时的其它工作抢时间。 */
  initialDelayMs?: number
  /** 提供一个"当前凭证"的取值函数（每次探活都重新取，切号后自动跟着变）。 */
  getAuth: () => WebAuth | undefined
  logger?: ProbeLogger
}

/**
 * 启动定时探活，返回停止函数。
 *
 * 用 setTimeout 串行链而不是 setInterval：探活本身要花几百毫秒，
 * setInterval 在网络慢时会堆叠出并发探活（而这些请求算在同一账号头上）。
 */
export function startProbeLoop(options: ProbeLoopOptions): () => void {
  if (!(options.intervalMs > 0)) return () => {}

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      await probeOnce(options.getAuth(), options.logger)
    } catch {
      // probeOnce 内部已经兜了；这里再兜一层，保证循环不会因为一次异常而停摆
    }
    if (stopped) return
    timer = setTimeout(tick, options.intervalMs)
    // 不阻止进程退出
    ;(timer as any)?.unref?.()
  }

  timer = setTimeout(tick, options.initialDelayMs ?? 20_000)
  ;(timer as any)?.unref?.()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/**
 * 最近一次探活是否失败。
 *
 * 不能只看"有没有 lastVerifyError" —— 成功时我们会清掉它，但反过来，
 * 一个较早的失败之后可能又有一次成功（lastVerifiedAt 更新、lastVerifyError 被清），
 * 所以**按时间比**：失败时间晚于成功时间才算"当前处于失败态"。
 */
export function lastProbeFailed(auth: WebAuth | undefined): boolean {
  if (!auth) return false
  const record = listAccounts().find((item) => item.token === auth.token)
  if (!record?.lastVerifyError) return false
  return String(record.lastVerifyError.at) > String(record.lastVerifiedAt ?? '')
}
