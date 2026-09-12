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

/** 推荐的调用间隔：3 秒。依据见 README 的「配置」一节。 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 3_000

/** 间隔可选的推荐档位（设置页的快捷按钮用）。 */
export const INTERVAL_PRESETS = [1_500, 3_000, 8_000] as const
/** 设置页滑块的取值上限。 */
export const MAX_INTERVAL_MS = 30_000

export interface GateSettings {
  allowConcurrent: boolean
  minRequestIntervalMs: number
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
  let minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? 0))
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

    // 最小间隔：按「上一次结束」时刻算，而不是上一次开始 —— 否则长回答之后的连环请求仍然很密。
    if (minIntervalMs > 0 && hasFinished) {
      const waitMs = lastFinishedAt + minIntervalMs - now()
      if (waitMs > 0) {
        logger?.info?.(
          `deepseek-web: 距上次请求不足 ${minIntervalMs}ms，等 ${Math.round(waitMs)}ms 再发「${label}」（防账号级限流）`,
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

  function settings(): GateSettings {
    return { allowConcurrent, minRequestIntervalMs: minIntervalMs }
  }

  function configure(next: Partial<GateSettings>): GateSettings {
    if (typeof next.allowConcurrent === 'boolean') allowConcurrent = next.allowConcurrent
    if (next.minRequestIntervalMs !== undefined) minIntervalMs = clampInterval(Number(next.minRequestIntervalMs))
    logger?.info?.(
      `deepseek-web: 请求节流设置已更新 —— ${allowConcurrent ? '允许并发（不推荐）' : '串行'} · 间隔 ${minIntervalMs}ms`,
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
