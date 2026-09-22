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
 * ⚠️ 更正（2026-09-12 实测）：本文档原先写"受限期间探不出限制状态"，**这是错的**。
 * `users/current` 的响应体里就带着 `chat: { is_muted, mute_until }` —— 受限期间这个字段是有效的，
 * 所以理论上探活**能**提前发现限制（目前尚未接上：限制状态仍由生成失败时的
 * `mute_until` 记入 accounts 的 limit 字段，见 webapi.ts 的 muteUntilMs）。
 */
import { hasUsableAuth, staleAuthRecord, type WebAuth } from './auth.ts'
import { listAccounts, updateAccount } from './accounts.ts'
import { validateAuth } from './webapi.ts'

export interface ProbeOutcome {
  ok: boolean
  at: string
  error?: string
  /** 探活成功时顺带带回来的账号身份（用来补全显示名，见下面的写回）。 */
  user?: { id?: string; display?: string }
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
    outcome = result.ok
      ? { ok: true, at, ...(result.user ? { user: result.user } : {}) }
      : { ok: false, at, error: result.error ?? '校验未通过' }
  } catch (error: any) {
    outcome = { ok: false, at, error: error?.message ?? String(error) }
  }

  if (target) {
    if (outcome.ok) {
      // 成功：记录时间、并**清掉**上一次的失败（`undefined` 会被规范化为"字段不存在"）。
      //
      // 顺带把身份信息写回：捕获那一刻可能还没校验过（比如刚"登录新账号"加进来的），
      // 于是列表只能显示内部 id。探活是零额度的只读调用，正好用来把显示名补上 ——
      // 这样库里闲置的账号也会自己"长出名字"，不用等用户手动刷新。
      // 用「旧值打底 + 新值覆盖」合并：新一次只有 id、没有 display 时，
      // 不要把原来已经拿到的好名字冲掉（pickUserDisplay 保证空值不会写进 key）。
      // 0.1.61：`unverified: false` 必须显式清 —— 否则这个"捕获时未校验"的标记会永久粘住
      // （normalizeRecord 只保留 `=== true` 的，传 false 就自然消失）。
      // 粘住的后果实测（2026-09-14）：账号库 5/5 全挂「未校验」，连"最近校验 6 分钟前"
      // 的那个也挂着 —— 标与数据自相矛盾、信息量归零，真出问题时反而看不出来。
      const patch: Record<string, unknown> = {
        lastVerifiedAt: at,
        lastVerifyError: undefined,
        unverified: false,
      }
      if (outcome.user) {
        patch.user = { ...(target.user ?? {}), ...outcome.user }
        // 审计 F04：探活走的也是**可信校验**（只读 users/current），
        // 拿到的 user.id 要落成去重键，否则同一账号重登时又会新增一条。
        const verifiedId = (outcome.user as { id?: unknown }).id
        if (typeof verifiedId === 'string' && verifiedId) patch.serverId = verifiedId
      }
      updateAccount(target.id, patch as any)
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

/**
 * 当前凭证是否处于「已知**授权**失效」状态；是则返回那条失败说明。
 *
 * 与 `lastProbeFailed` 的分工：那个回答"探活最近是不是失败过"（**只用于展示/日志**），
 * 这个回答"这份凭证现在还能不能用"（**用于请求前拦截**，见 adapter.ts）。
 * 差别就在**失败类型**：断网、超时、5xx 也是"探活失败"，但那种情况下凭证是好的，
 * 拦下来会误伤健康账号。纯判据在 `auth.ts` 的 `staleAuthRecord`（可单测），
 * 这里只负责按 token 找到对应的账号记录。
 */
export function staleAuthMessage(auth: WebAuth | undefined): string | undefined {
  if (!auth) return undefined
  const record = listAccounts().find((item) => item.token === auth.token)
  return staleAuthRecord(record)
}
