/**
 * 本地用量台账 —— 记「每次调用烧了多少 token」，供设置页的「Token 统计」页用。
 *
 * 与 `ledger.ts` 的分工（**刻意分成两份存储，别合并**）：
 *  - `ledger`：**请求密度与失败分类**，只要近 7 天（细粒度、每天一个文件、按小时看）；
 *  - `usage` ：**token 用量**，要长期趋势（近 30 天起），保留 90 天。
 * 两者的保留期相差一个数量级，塞进一张表会让两边都别扭。
 *
 * 数据口径（界面必须如实标注，别让用户以为是精确计费值）：
 *  - 网页端**只在小部分响应里**上报 `accumulated_token_usage`（见 webapi.ts 的解析）。
 *    拿得到时：输出取"服务端总量与本地估算的较小值"，输入取余下部分；
 *  - 拿不到时：两个数**都是本地估算**（输入按 prompt 字数估、输出按正文+思考字数 / 3.2）。
 *  - `server: true/false` 逐条存下来，界面据此显示「服务端口径占比」而不是硬说成精确值。
 *
 * 存储：`<DSH_HOME>/web-login/usage/YYYY-MM-DD.jsonl`，沿用 ledger 的追加式写法
 * （崩溃最多丢最后一行、不需要读-改-写整个文件）。每条都很小，且**只记元信息**
 * （时间 / 模型 / 用途 / token 数），**不含任何对话内容**。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

/** 保留天数。90 天足够看"最近一个月"的趋势与季度对比。 */
export const USAGE_KEEP_DAYS = 90

/** 单日文件软上限：超过就不再追加（异常情况下别把磁盘写爆）。 */
const DAY_FILE_SOFT_LIMIT_BYTES = 2 * 1024 * 1024

/** 界面可请求的最大天数（同时受保留期约束）。 */
export const USAGE_MAX_DAYS = 90

export interface UsageEntry {
  /** 时间戳（毫秒）。 */
  at: number
  /** 发生时的账号 id（`acc_xxx`，不是账号本身）。 */
  accountId?: string
  /** 调用用途：chat / session-title / compaction… */
  purpose: string
  /** 本轮用到的模型 id。 */
  model?: string
  ok: boolean
  /** 输入 token。 */
  in: number
  /** 输出 token。 */
  out: number
  /** 其中思考通道的 token（估算）。 */
  reasoning?: number
  /** 本次是否拿到服务端上报的总量（false ＝ 两个数都是本地估算）。 */
  server?: boolean
}

/** 按天聚合出的一格。 */
export interface UsageDay {
  /** `YYYY-MM-DD`（本地时区）。 */
  date: string
  calls: number
  ok: number
  in: number
  out: number
  /** 该天里有多少次拿到了服务端口径。 */
  serverCalls: number
}

/** 分组统计（按模型 / 账号 / 用途）。 */
export interface UsageGroup {
  key: string
  calls: number
  in: number
  out: number
}

export interface UsageSummary {
  /** 实际生效的天数（0 ＝ 全部）。 */
  days: number
  totals: {
    calls: number
    ok: number
    failed: number
    in: number
    out: number
    /** in + out（界面上的「总 Token」）。 */
    total: number
    /** 拿到服务端口径的次数。 */
    serverCalls: number
    /** 平均每次调用的 token（无调用时为 0）。 */
    avgPerCall: number
  }
  /** 按天升序，**连续补齐**：没有调用的那天也要占一格（否则趋势图会把日期挤在一起）。 */
  series: UsageDay[]
  byModel: UsageGroup[]
  byAccount: UsageGroup[]
  byPurpose: UsageGroup[]
  /** 数据覆盖范围（界面页脚显示"数据覆盖至 X"）。 */
  coverage: { from: string | null; to: string | null; files: number; bytes: number }
}

/**
 * 把适配器的一次上报整理成一条记录。宿主 `recordCallOutcome` 直接调它。
 *
 * 抽成纯函数是因为**它是唯一一段"没人守"的胶水**：适配器那边有用例（noteCall 收到了 token）、
 * 存储这边也有（noteUsage 读得回来），中间这几行一旦写错（比如把 `server` 恒写成 true，
 * 界面就会把估算值说成服务端口径）没有任何断言会响。
 */
export function usageEntryFrom(
  info: {
    purpose: string
    accountId?: string
    model?: string
    ok: boolean
    tokens?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; serverTotal?: boolean }
  },
  at: number,
): UsageEntry {
  const safe = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  }
  return {
    at,
    ...(info.accountId ? { accountId: info.accountId } : {}),
    purpose: info.purpose,
    ...(info.model ? { model: info.model } : {}),
    ok: info.ok,
    in: safe(info.tokens?.inputTokens),
    out: safe(info.tokens?.outputTokens),
    ...(Number.isFinite(info.tokens?.reasoningTokens) ? { reasoning: safe(info.tokens?.reasoningTokens) } : {}),
    // ⚠️ 只有真的拿到服务端总量才标 true。缺这一步，界面会把估算值说成服务端口径 ——
    // "看起来精确的错数"比不显示更糟。
    ...(info.tokens ? { server: info.tokens.serverTotal === true } : {}),
  }
}

export function usageDir(): string {
  return join(webLoginDir(), 'usage')
}

/** 本地时区的 `YYYY-MM-DD`。**不能用 toISOString**（那是 UTC，晚上 8 点后会把日期算到明天）。 */
export function localDateKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayFile(at: number): string {
  return join(usageDir(), `${localDateKey(at)}.jsonl`)
}

function listDayFiles(): string[] {
  try {
    return readdirSync(usageDir())
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 追加一条。**永不抛错** —— 用量是旁路设施，绝不能因为它写失败而影响调用。
 */
export function noteUsage(entry: UsageEntry): void {
  try {
    const file = dayFile(entry.at)
    mkdirSync(usageDir(), { recursive: true })
    try {
      if (statSync(file).size > DAY_FILE_SOFT_LIMIT_BYTES) return
    } catch {}
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
}

/** 删除超过保留期的文件（插件自己的数据，按天滚动清理）。 */
export function pruneUsage(keepDays = USAGE_KEEP_DAYS): number {
  const cutoff = Date.now() - keepDays * 86_400_000
  let removed = 0
  for (const name of listDayFiles()) {
    const stamp = name.replace(/\.jsonl$/, '')
    const at = Date.parse(`${stamp}T00:00:00`)
    if (!Number.isFinite(at) || at >= cutoff) continue
    try {
      rmSync(join(usageDir(), name), { force: true })
      removed += 1
    } catch {}
  }
  return removed
}

/** 规整天数参数：非数 → 默认 30；越界 → 夹到 0~USAGE_MAX_DAYS；**必须取整**。 */
export function clampUsageDays(value: unknown, fallback = 30): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(USAGE_MAX_DAYS, Math.floor(n)))
}

function readEntries(sinceMs: number): UsageEntry[] {
  const out: UsageEntry[] = []
  for (const name of listDayFiles()) {
    const stamp = name.replace(/\.jsonl$/, '')
    const dayEnd = Date.parse(`${stamp}T23:59:59.999`)
    if (Number.isFinite(dayEnd) && dayEnd < sinceMs) continue
    let text = ''
    try {
      text = readFileSync(join(usageDir(), name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as UsageEntry
        if (Number.isFinite(parsed?.at) && parsed.at >= sinceMs) out.push(parsed)
      } catch {}
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

function emptyDay(date: string): UsageDay {
  return { date, calls: 0, ok: 0, in: 0, out: 0, serverCalls: 0 }
}

function bumpGroup(map: Map<string, UsageGroup>, key: string, entry: UsageEntry): void {
  const item = map.get(key) ?? { key, calls: 0, in: 0, out: 0 }
  item.calls += 1
  item.in += entry.in
  item.out += entry.out
  map.set(key, item)
}

/** 分组结果按 token 总量降序（界面直接照顺序画横条，不用再排）。 */
function sortedGroups(map: Map<string, UsageGroup>): UsageGroup[] {
  return Array.from(map.values()).sort((a, b) => b.in + b.out - (a.in + a.out) || b.calls - a.calls)
}

/**
 * 纯聚合：喂条目数组出汇总。**刻意不碰 fs** —— 这样用例可以直接喂字面量测边界
 * （空数据、跨天、只有失败、没有服务端口径…），不用造临时目录。
 *
 * `days` = 0 表示"全部（受保留期约束）"；否则从"今天"往前数 `days` 天，
 * **并把没有调用的日子补齐成 0**（趋势图需要等距时间轴）。
 *
 * 🔴 **只聚合落在时间轴内的条目**：窗口外的条目直接丢掉，而不是只从柱子里漏掉。
 * 否则「总计」和图上画出来的会不一致 —— 那种"数字对不上"的现象最难排查。
 */
export function aggregateUsage(entries: UsageEntry[], options: { days?: number; now?: number } = {}): UsageSummary {
  const now = options.now ?? Date.now()
  const days = clampUsageDays(options.days ?? 30)
  // 时间轴：从"今天"往前 days-1 天（days=0 ⇒ 从数据最早那天开始）。
  // ⚠️ 逐格推进按**正午**为基准：取 0 点会在夏令时切换那天把同一日期推两次（多一格）。
  // 本机无夏令时，但这段逻辑不该依赖时区。
  const DAY = 86_400_000
  const earliest = entries.reduce<string | null>((min, item) => {
    const key = localDateKey(item.at)
    return min === null || key < min ? key : min
  }, null)
  const axisStart = days > 0 ? localDateKey(now - (days - 1) * DAY) : (earliest ?? localDateKey(now))
  const axisEnd = localDateKey(now)

  const byModel = new Map<string, UsageGroup>()
  const byAccount = new Map<string, UsageGroup>()
  const byPurpose = new Map<string, UsageGroup>()
  const byDate = new Map<string, UsageDay>()

  let calls = 0
  let ok = 0
  let inSum = 0
  let outSum = 0
  let serverCalls = 0
  let from: string | null = null
  let to: string | null = null

  for (const entry of entries) {
    const date = localDateKey(entry.at)
    if (date < axisStart || date > axisEnd) continue
    calls += 1
    if (entry.ok) ok += 1
    inSum += entry.in
    outSum += entry.out
    if (entry.server) serverCalls += 1
    if (from === null || date < from) from = date
    if (to === null || date > to) to = date
    const day = byDate.get(date) ?? emptyDay(date)
    day.calls += 1
    if (entry.ok) day.ok += 1
    day.in += entry.in
    day.out += entry.out
    if (entry.server) day.serverCalls += 1
    byDate.set(date, day)
    bumpGroup(byModel, entry.model || '(未标注)', entry)
    bumpGroup(byAccount, entry.accountId ?? '(未知账号)', entry)
    bumpGroup(byPurpose, entry.purpose, entry)
  }

  const series: UsageDay[] = []
  const startNoon = Date.parse(`${axisStart}T12:00:00`)
  const endNoon = Date.parse(`${axisEnd}T12:00:00`)
  const steps = Math.max(0, Math.min(USAGE_MAX_DAYS + 1, Math.round((endNoon - startNoon) / DAY)))
  for (let i = 0; i <= steps; i++) {
    const key = localDateKey(startNoon + i * DAY)
    series.push(byDate.get(key) ?? emptyDay(key))
  }

  let files = 0
  let bytes = 0
  for (const name of listDayFiles()) {
    files += 1
    try {
      bytes += statSync(join(usageDir(), name)).size
    } catch {}
  }

  return {
    days,
    totals: {
      calls,
      ok,
      failed: calls - ok,
      in: inSum,
      out: outSum,
      total: inSum + outSum,
      serverCalls,
      avgPerCall: calls > 0 ? Math.round((inSum + outSum) / calls) : 0,
    },
    series,
    byModel: sortedGroups(byModel),
    byAccount: sortedGroups(byAccount),
    byPurpose: sortedGroups(byPurpose),
    coverage: { from, to, files, bytes },
  }
}

/** 读盘 + 聚合。入参可以是查询串里拿到的字符串（路由直接透传 URL 参数，别在调用处各转一次）。 */
export function summarizeUsage(input: number | string = 30): UsageSummary {
  const days = clampUsageDays(input)
  const now = Date.now()
  // 起点取"今天 0 点再往前 days-1 天"⇒ 与 aggregateUsage 的时间轴对齐，
  // 不然会漏掉"今天凌晨"的条目（初版就漏了：按 now - (days-1)*DAY 会把今天 0 点~现在截掉）。
  const sinceMs =
    days > 0 ? new Date(now - (days - 1) * 86_400_000).setHours(0, 0, 0, 0) : 0
  return aggregateUsage(readEntries(sinceMs), { days, now })
}

/** 目录是否存在（界面用来区分"还没跑过"与"跑了但没数据"）。 */
export function usageExists(): boolean {
  try {
    return existsSync(usageDir())
  } catch {
    return false
  }
}
