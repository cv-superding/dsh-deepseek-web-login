/**
 * 本地调用台账 —— 记「每次调用发生了什么」，用来看**请求密度**与**失败分类**。
 *
 * 为什么要它（2026-09-12，借鉴 workbuddy-switch 的用量统计）：
 * 插件里已经有"请求节流"（串行 + 随机间隔），但**没有任何东西能证明它是否有效**。
 * 判断账号会不会被限流，靠感觉不行 —— 要看两个可量化的东西：
 *  1. **相邻调用的间隔分布**（p50 / p90 / 最短）：固定间隔的方差≈0 是"定时器特征"，
 *     真实节奏应该有抖动；最短间隔尤其说明问题 —— 它直接对应"有没有连环请求"。
 *  2. **失败分类**：限流 / 账号被限制 / 鉴权失效 / 网络错误，各自占比多少。
 *     只看到"失败了"没用，要知道是哪一类才谈得上对策。
 *
 * 存储：`<DSH_HOME>/web-login/ledger/YYYY-MM-DD.jsonl`（按天分文件，只保留近 N 天）。
 * 刻意用 JSONL 追加：崩溃最多丢最后一行，不需要读-改-写整个文件。
 * 每条都很小，且**只记元信息**（时间/账号 id/用途/耗时/错误码），不含任何对话内容与凭证。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

/** 台账保留天数。 */
export const LEDGER_KEEP_DAYS = 7

/** 单日文件软上限：超过就不再追加（避免异常情况下把磁盘写爆）。 */
const DAY_FILE_SOFT_LIMIT_BYTES = 2 * 1024 * 1024

export interface LedgerEntry {
  /** 时间戳（毫秒）。 */
  at: number
  /** 发生时的账号 id（`acc_xxx`，不是账号本身）。 */
  accountId?: string
  /** 调用用途：chat / session-title / compaction… */
  purpose: string
  ok: boolean
  /** 耗时（毫秒）。 */
  ms: number
  /** 失败时的语义错误码（RATE_LIMIT / AUTH / TRANSPORT…）。 */
  code?: string
  /** 是否属于「发得太频繁被限流」。 */
  throttled?: boolean
  /** 是否属于「账号被临时限制」。 */
  muted?: boolean
}

/** 汇总结果。 */
export interface LedgerSummary {
  hours: number
  /** 窗口内的调用总数。 */
  calls: number
  succeeded: number
  failed: number
  /** 失败分类计数（键是给人看的名字）。 */
  failures: Record<string, number>
  /** 相邻「对话类」调用的间隔（毫秒）分布；样本不足时为 null。 */
  gaps: { samples: number; min: number; p50: number; p90: number; max: number } | null
  /** 按小时分桶的调用数（长度 = hours，最后一个桶是最近一小时）。 */
  hourly: number[]
  /** 台账目录占用（便于发现异常膨胀）。 */
  footprint: { files: number; bytes: number }
}

export function ledgerDir(): string {
  return join(webLoginDir(), 'ledger')
}

function dayFile(at: number): string {
  const date = new Date(at)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return join(ledgerDir(), `${stamp}.jsonl`)
}

function listDayFiles(): string[] {
  try {
    return readdirSync(ledgerDir())
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 追加一条。**永不抛错** —— 台账是旁路设施，绝不能因为它写失败而影响调用。
 */
export function noteCall(entry: LedgerEntry): void {
  try {
    const file = dayFile(entry.at)
    mkdirSync(join(file, '..'), { recursive: true })
    try {
      if (statSync(file).size > DAY_FILE_SOFT_LIMIT_BYTES) return
    } catch {}
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
}

/** 删除超过保留期的台账文件（插件自己的数据，按天滚动清理）。 */
export function pruneLedger(keepDays = LEDGER_KEEP_DAYS): number {
  const cutoff = Date.now() - keepDays * 86_400_000
  let removed = 0
  for (const name of listDayFiles()) {
    const stamp = name.replace(/\.jsonl$/, '')
    const at = Date.parse(`${stamp}T00:00:00`)
    if (!Number.isFinite(at) || at >= cutoff) continue
    try {
      rmSync(join(ledgerDir(), name), { force: true })
      removed += 1
    } catch {}
  }
  return removed
}

function readEntries(sinceMs: number): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const name of listDayFiles()) {
    // 文件名前缀就是日期，能先跳过明显过期的文件
    const stamp = name.replace(/\.jsonl$/, '')
    const dayEnd = Date.parse(`${stamp}T23:59:59.999`)
    if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue
    let text = ''
    try {
      text = readFileSync(join(ledgerDir(), name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as LedgerEntry
        if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed)
      } catch {}
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

/** 失败分类：把语义错误码翻成"人话"，同类合并。 */
function failureBucket(entry: LedgerEntry): string {
  if (entry.muted) return '账号被限制'
  if (entry.throttled) return '限流（发太频繁）'
  if (entry.code === 'RATE_LIMIT') return '限流（未分类）'
  if (entry.code === 'AUTH' || entry.code === 'MISSING_CREDENTIAL') return '登录态问题'
  if (entry.code === 'TRANSPORT' || entry.code === 'TIMEOUT') return '网络 / 超时'
  if (entry.code === 'CONTEXT_WINDOW_EXCEEDED') return '上下文超限'
  if (entry.code === 'ABORTED') return '被取消'
  return entry.code ? `其它（${entry.code}）` : '其它'
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

/**
 * 汇总最近 `hours` 小时。
 *
 * 间隔只统计**对话类**调用（`purpose === 'chat'`）：会话标题生成是 DSH 自己发的旁路请求，
 * 把它算进去会让间隔分布失真（它常常紧跟在主回答后面）。
 */
export function summarizeLedger(hours = 24): LedgerSummary {
  const now = Date.now()
  const since = now - hours * 3_600_000
  const entries = readEntries(since)

  const failures: Record<string, number> = {}
  let succeeded = 0
  const hourly = new Array(hours).fill(0)
  const chatTimes: number[] = []

  for (const entry of entries) {
    const bucket = Math.floor((now - entry.at) / 3_600_000)
    if (bucket >= 0 && bucket < hours) hourly[hours - 1 - bucket] += 1
    if (entry.ok) succeeded += 1
    else failures[failureBucket(entry)] = (failures[failureBucket(entry)] ?? 0) + 1
    if (entry.purpose === 'chat' && entry.ok) chatTimes.push(entry.at)
  }

  const gaps: number[] = []
  for (let i = 1; i < chatTimes.length; i += 1) gaps.push(chatTimes[i] - chatTimes[i - 1])
  gaps.sort((a, b) => a - b)

  let files = 0
  let bytes = 0
  for (const name of listDayFiles()) {
    files += 1
    try {
      bytes += statSync(join(ledgerDir(), name)).size
    } catch {}
  }

  return {
    hours,
    calls: entries.length,
    succeeded,
    failed: entries.length - succeeded,
    failures,
    gaps:
      gaps.length > 0
        ? {
            samples: gaps.length,
            min: gaps[0],
            p50: percentile(gaps, 0.5),
            p90: percentile(gaps, 0.9),
            max: gaps[gaps.length - 1],
          }
        : null,
    hourly,
    footprint: { files, bytes },
  }
}

/** 台账文件是否存在（界面用来区分"还没跑过"与"跑了但没数据"）。 */
export function ledgerExists(): boolean {
  try {
    return existsSync(ledgerDir())
  } catch {
    return false
  }
}
