/**
 * 请求闸门（request gate）—— 限制「同一账号上同时在飞的网页端请求」。
 *
 * 为什么需要它（2026-09-12 实测）：
 *  从插件日志反推每次调用的起止时间，272 轮里发现 **16 对时间重叠**，
 *  特征非常清楚：一方是主回答（数百字、6~40 秒），另一方**只有 8~17 个字、耗时 1~3 秒**
 *  —— 那是 DSH 的**会话标题生成**（`options.purpose === 'session-title'`）。
 *  也就是说，你还在等回答的时候，DSH 已经又往同一个账号发了一个短请求。
 *
 *  网页端同一账号**同时只能生成一条**，并发生成会被拒（`A message is being generated…`），
 *  更严重的是实测：双窗口并发生成不到 6 分钟就触发账号级限制（mute 1 天）。
 *  所以「并发」不是能白拿的吞吐，而是要主动规避的风险源。
 *
 * 两道约束：
 *  1. `allowConcurrent === false`（默认）：**串行**，同一时刻只放行一个调用，其余排队（FIFO）。
 *  2. `minIntervalMs`：两次调用**之间**至少间隔这么久（按上一次「结束」时间算），
 *     把请求密度压下来 —— 这是防风控真正起作用的那一项。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 推荐的调用间隔：**随机区间 2~4 秒**（下限 / 上限）。
 *
 * 为什么是区间而不是固定值：固定间隔的方差≈0，在统计上就是「定时器特征」；
 * 人的操作间隔是有方差的。同类项目 cuckoo-code（从未被风控）用的正是 2000~4000ms 随机区间。
 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 2_000
export const DEFAULT_MAX_REQUEST_INTERVAL_MS = 4_000

/** 间隔可选的推荐档位（设置页的快捷按钮用）：[下限, 上限]。 */
export const INTERVAL_PRESETS = [
  [1_500, 2_500],
  [2_000, 4_000],
  [5_000, 9_000],
] as const
/** 设置页滑块的取值上限。 */
export const MAX_INTERVAL_MS = 30_000

// ── 会话清理的三个区间 ────────────────────────────────────────────────────
//
// 为什么这三个参数也要"上下限 + 随机"：它们原来都是**固定值**（攒 8 个 / 等 90 秒 /
// 逐个删时中间没有间隔）。固定值本身就是一种机器特征 —— 每次都攒到第 8 个就动手、
// 每次都等 90 秒、删除请求像连发。真人不会这么精确。
//
// 默认值都围绕原来的固定值取一个区间（均值≈旧值），所以行为上没有突变，
// 只是把"精确"换成了"有方差"。
/** 一个可随机取值的区间（闭区间，单位由字段决定）。 */
export interface CleanupRange {
  min: number
  max: number
}

/** 攒够几个：默认 6~10（均值 8，等于旧默认）。 */
export const DEFAULT_CLEANUP_BATCH: CleanupRange = { min: 6, max: 10 }
/** 从第一个会话入队起最多等多久：默认 60~120 秒（均值 90s，等于旧默认）。 */
export const DEFAULT_CLEANUP_DELAY_MS: CleanupRange = { min: 60_000, max: 120_000 }
/** 两次删除之间的间隔：默认 0.8~2.5 秒。
 *  新增项 —— 批量删除不被服务端接受时会退化成"逐个删"，原来那串请求中间**没有间隔**。 */
export const DEFAULT_CLEANUP_GAP_MS: CleanupRange = { min: 800, max: 2_500 }

/** 各区间允许被设置到的范围（设置页滑块也按这个画）。 */
export const CLEANUP_BATCH_BOUNDS = { min: 1, max: 50 }
export const CLEANUP_DELAY_BOUNDS_MS = { min: 5_000, max: 600_000 }
export const CLEANUP_GAP_BOUNDS_MS = { min: 0, max: 60_000 }

/**
 * 把任意输入规整成一个合法区间：非数忽略、按 bounds 夹住、**上下限颠倒时自动交换**。
 * 返回 undefined 表示"这个字段不合法、当没给"（调用方回落到默认）。
 */
export function normalizeCleanupRange(
  value: unknown,
  bounds: { min: number; max: number },
): CleanupRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { min?: unknown; max?: unknown }
  const lo = Number(raw.min)
  const hi = Number(raw.max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined
  const clamp = (n: number) => Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)))
  // 用户把两个滑块拖反了不该报错，也不该让"下限 > 上限"这种状态活下去
  return { min: clamp(Math.min(lo, hi)), max: clamp(Math.max(lo, hi)) }
}

export interface GateSettings {
  allowConcurrent: boolean
  /** 间隔下限（毫秒）。与上限相等时退化为固定间隔。 */
  minRequestIntervalMs: number
  /** 间隔上限（毫秒）。实际等待在 [下限, 上限] 之间**随机**取值。 */
  maxRequestIntervalMs: number
  /**
   * 临时会话清理策略。它不参与节流逻辑，只是**搭同一份设置文件与同一个设置页**存储，
   * 实际执行在 webapi.ts 的 createSessionCleaner（类型放宽为字面量，避免循环依赖）。
   */
  sessionCleanup?: 'immediate' | 'deferred' | 'keep'
  /** deferred：攒够几个（个）。实际阈值**每轮清理重新随机抽**。 */
  cleanupBatch?: CleanupRange
  /** deferred：从第一个会话入队起最多等多久（毫秒）。每轮重新随机抽。 */
  cleanupDelayMs?: CleanupRange
  /** 两次删除之间的间隔（毫秒）。每次删除前重新随机抽。 */
  cleanupGapMs?: CleanupRange
}

/** 节流设置文件：`${DSH_HOME || ~/.dsh}/web-login/gate.json`（插件自治，与凭证同目录）。 */
export function gateSettingsPath(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'web-login', 'gate.json')
}

/**
 * 读设置页保存过的值。文件不存在/损坏都返回 undefined（回落到 cordis config）。
 * 优先级：**设置页（文件）> cordis config > 内置默认** —— 设置页是用户的显式操作，
 * 不该被配置文件里的旧值盖掉。
 */
export function readGateSettings(): Partial<GateSettings> | undefined {
  try {
    const file = gateSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const out: Partial<GateSettings> = {}
    if (typeof parsed?.allowConcurrent === 'boolean') out.allowConcurrent = parsed.allowConcurrent
    if (Number.isFinite(parsed?.minRequestIntervalMs)) {
      out.minRequestIntervalMs = clampInterval(Number(parsed.minRequestIntervalMs))
    }
    if (Number.isFinite(parsed?.maxRequestIntervalMs)) {
      out.maxRequestIntervalMs = clampInterval(Number(parsed.maxRequestIntervalMs))
    }
    // 老配置（0.1.20 只存了 min）= 固定间隔语义：上限跟随下限
    if (out.minRequestIntervalMs !== undefined && out.maxRequestIntervalMs === undefined) {
      out.maxRequestIntervalMs = out.minRequestIntervalMs
    }
    const cleanup = parsed?.sessionCleanup
    if (cleanup === 'immediate' || cleanup === 'deferred' || cleanup === 'keep') {
      out.sessionCleanup = cleanup
    }
    const batch = normalizeCleanupRange(parsed?.cleanupBatch, CLEANUP_BATCH_BOUNDS)
    if (batch) out.cleanupBatch = batch
    const delay = normalizeCleanupRange(parsed?.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS)
    if (delay) out.cleanupDelayMs = delay
    const gap = normalizeCleanupRange(parsed?.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS)
    if (gap) out.cleanupGapMs = gap
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export function writeGateSettings(settings: GateSettings): void {
  const file = gateSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

/** 把任意输入规整成合法间隔：非数 → 默认，负 → 0，超上限 → 上限。 */
export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_REQUEST_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.floor(value)))
}

export interface RequestGateOptions {
  /** 允许同一账号并发（默认 false）。开启会恢复「标题与主回答同时发」的高风险行为。 */
  allowConcurrent?: boolean
  /** 两次调用之间的最小间隔（毫秒）。0 = 不限。 */
  minIntervalMs?: number
  /** 间隔上限（毫秒）。缺省且未给 minIntervalMs 时用默认上限；给了 minIntervalMs 则取同值（保持「固定间隔」老语义）。 */
  maxIntervalMs?: number
  /** 随机源（单测注入用）。 */
  random?: () => number
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
  /** 便于单测注入。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RequestGate {
  /** 取得放行许可；返回的函数必须调用一次（幂等）以释放并让出队首。 */
  acquire(label?: string): Promise<() => void>
  /** 当前状态（诊断/测试用）。 */
  stats(): { running: number; waiting: number; lastFinishedAt: number }
  /** 读取当前生效的节流设置。 */
  settings(): GateSettings
  /** 运行时改设置（设置页保存后调用）；返回改完后的值。 */
  configure(next: Partial<GateSettings>): GateSettings
}

export function createRequestGate(options: RequestGateOptions = {}): RequestGate {
  // 可运行时修改（设置页保存后立即生效，不必重启）
  let allowConcurrent = options.allowConcurrent === true
  let minIntervalMs = clampInterval(
    options.minIntervalMs ?? (options.maxIntervalMs !== undefined ? options.maxIntervalMs : DEFAULT_MIN_REQUEST_INTERVAL_MS),
  )
  let maxIntervalMs = clampInterval(
    options.maxIntervalMs ?? (options.minIntervalMs !== undefined ? options.minIntervalMs : DEFAULT_MAX_REQUEST_INTERVAL_MS),
  )
  if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs
  const random = options.random ?? Math.random
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const logger = options.logger

  /** 队尾：每个调用完成后才 resolve，保证 FIFO 且「上一个没结束就不放行下一个」。 */
  let tail: Promise<void> = Promise.resolve()
  let running = 0
  let waiting = 0
  let lastFinishedAt = 0
  /** 是否已经有调用结束过 —— 首次调用不该被间隔规则拖住。 */
  let hasFinished = false

  async function acquire(label = 'call'): Promise<() => void> {
    let releaseMine!: () => void
    const mine = new Promise<void>((resolve) => {
      releaseMine = resolve
    })
    const prev = tail
    tail = prev.then(() => mine)

    waiting += 1
    try {
      // 串行：等前面所有调用结束。并发模式跳过这一步（间隔仍然生效）。
      if (!allowConcurrent) {
        if (running > 0 || waiting > 1) {
          logger?.debug?.(`deepseek-web: 「${label}」排队等待（前面还有 ${running} 个在跑 / ${waiting - 1} 个在等）`)
        }
        await prev
      }
    } finally {
      waiting -= 1
    }

    // 间隔：在 [下限, 上限] 之间**随机**取值，按「上一次结束」时刻算
    // （不是上一次开始 —— 否则长回答之后的连环请求仍然很密）。每一次的等待都不同，避免定时器特征。
    if (maxIntervalMs > 0 && hasFinished) {
      const gap = nextGap()
      const waitMs = lastFinishedAt + gap - now()
      if (waitMs > 0) {
        logger?.info?.(
          `deepseek-web: 距上次请求不足 ${gap}ms（区间 ${minIntervalMs}~${maxIntervalMs}），` +
            `等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`,
        )
        await sleep(waitMs)
      }
    }

    running += 1
    let released = false
    return () => {
      if (released) return
      released = true
      running -= 1
      lastFinishedAt = now()
      hasFinished = true
      releaseMine()
    }
  }

  /** 本次实际使用的间隔：区间内随机；上下限相等则固定。 */
  function nextGap(): number {
    if (maxIntervalMs <= minIntervalMs) return minIntervalMs
    return Math.round(minIntervalMs + random() * (maxIntervalMs - minIntervalMs))
  }

  /** 会话清理策略不在本模块实现，只借用设置文件存储（由宿主读取后交给 cleaner）。 */
  let cleanupMode: GateSettings['sessionCleanup']
  // 会话清理的三个区间（同样不参与节流逻辑）。存在这里是为了**能落盘**：
  // writeGateSettings 写的是 settings() 的返回值，不存就丢。
  let cleanupBatch: CleanupRange | undefined
  let cleanupDelayMs: CleanupRange | undefined
  let cleanupGapMs: CleanupRange | undefined

  function settings(): GateSettings {
    return {
      allowConcurrent,
      minRequestIntervalMs: minIntervalMs,
      maxRequestIntervalMs: maxIntervalMs,
      ...(cleanupMode ? { sessionCleanup: cleanupMode } : {}),
      ...(cleanupBatch ? { cleanupBatch } : {}),
      ...(cleanupDelayMs ? { cleanupDelayMs } : {}),
      ...(cleanupGapMs ? { cleanupGapMs } : {}),
    }
  }

  function configure(next: Partial<GateSettings>): GateSettings {
    if (typeof next.allowConcurrent === 'boolean') allowConcurrent = next.allowConcurrent
    if (next.minRequestIntervalMs !== undefined) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs))
    if (next.maxRequestIntervalMs !== undefined) maxIntervalMs = clampInterval(Number(next.maxRequestIntervalMs))
    if (next.sessionCleanup !== undefined) cleanupMode = next.sessionCleanup
    // 三个区间：非法的输入直接当"没给"（不报错、也不覆盖已有的有效值）
    if (next.cleanupBatch !== undefined) {
      const value = normalizeCleanupRange(next.cleanupBatch, CLEANUP_BATCH_BOUNDS)
      if (value) cleanupBatch = value
    }
    if (next.cleanupDelayMs !== undefined) {
      const value = normalizeCleanupRange(next.cleanupDelayMs, CLEANUP_DELAY_BOUNDS_MS)
      if (value) cleanupDelayMs = value
    }
    if (next.cleanupGapMs !== undefined) {
      const value = normalizeCleanupRange(next.cleanupGapMs, CLEANUP_GAP_BOUNDS_MS)
      if (value) cleanupGapMs = value
    }
    // 设置页两个滑块可能拖出「上限 < 下限」，这里纠正（不报错，直接夹住）
    if (maxIntervalMs < minIntervalMs) maxIntervalMs = minIntervalMs
    logger?.info?.(
      `deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? '允许并发（不推荐）' : '串行'} · ` +
        `间隔 ${minIntervalMs}~${maxIntervalMs}ms（随机）` +
        (cleanupBatch ? ` · 清理阈值 ${cleanupBatch.min}~${cleanupBatch.max} 个` : '') +
        (cleanupDelayMs
          ? ` · 最长等待 ${Math.round(cleanupDelayMs.min / 1000)}~${Math.round(cleanupDelayMs.max / 1000)}s`
          : '') +
        (cleanupGapMs ? ` · 删除间隔 ${cleanupGapMs.min}~${cleanupGapMs.max}ms` : ''),
    )
    return settings()
  }

  return {
    acquire,
    stats: () => ({ running, waiting, lastFinishedAt }),
    settings,
    configure,
  }
}
