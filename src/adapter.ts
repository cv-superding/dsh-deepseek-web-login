/**
 * deepseek-web 适配器：把 DSH 的 LLM 调用翻译成 chat.deepseek.com 网页端对话。
 *
 * 与官方 dsh-llm-deepseek 的差异（受限于网页端能力）：
 *  - 网页接口只吃单段 `prompt` 字符串 → 由 protocol.ts 序列化整段转写
 *  - 无原生 function calling → 提示词 JSON 协议 + 流式解析（protocol.ts）
 *  - 无 temperature / stop / max_tokens 字段 → 忽略（不报错）
 *  - 每次调用新建 chat_session 并在结束后删除（保持无状态 + 不污染网页端列表）
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join as joinPath } from 'node:path'
import { webLoginDir } from './paths.ts'
import { AdapterLlmError, httpErrorCode, maskIdentifier, readAuth, hasUsableAuth, type WebAuth } from './auth.ts'
import { staleAuthMessage } from './probe.ts'
import { createRequestGate, DEFAULT_MAX_PROMPT_CHARS, DEFAULT_MAX_REF_IMAGES, DEFAULT_MIN_REQUEST_INTERVAL_MS, type RequestGate } from './gate.ts'
import { summarizeCookieLife, type CookieLifeSummary } from './cookies.ts'
import {
  scheduleDeleteSession,
  streamWebCompletion,
  uploadImageFile,
  type SessionCleaner,
} from './webapi.ts'
import { collectImageRefs, imageUploadName, looksLikeUnexecutedToolProgram, serializePromptParts, stripSystemMarkers, SystemMarkerStreamFilter, BoilerplateFilter, drainTextPipeline, ToolCallStreamFilter, TranscriptEchoGuard, type ToolSchemaLike } from './protocol.ts'

/**
 * 把「被丢弃的完整载荷」落盘，专供事后定位。
 *
 * 为什么必须这么做：日志里只留前 400 字符，而实测的坏点几乎总在后半段
 * （长 PowerShell 命令、批量多调用）。没有完整原文就只能靠猜——
 * 2026-09-10 已经因此多绕了好几轮：先误判成 DSML 双竖线，真实原因却是未转义双引号。
 * 落盘后可以直接把原文喂进解析器复现，从「猜」变成「验」。
 *
 * 失败必须无声（诊断代码绝不能影响主流程）。
 */
/**
 * 丢弃载荷的**诊断元信息**落盘。
 *
 * ⚠️ 默认**不落原文**（审计 F23）：被丢弃的是模型吐坏的工具调用参数，里面完全可能带着
 * 命令里的 token、文件内容、个人信息 —— 以前默认把整段 raw 写进 `~/.dsh/deepseek-web/rejected.jsonl`，
 * 等于给这些内容在磁盘上留了一份没人在看的副本。而且那个路径是**硬编码 homedir** 的，
 * 无视 `DSH_HOME`（我们自己的测试就是被它坑到的：写到了真实用户目录）。
 *
 * 现在只记「什么时候 / 哪种模式 / 什么原因 / 多长 / 摘要」：
 * 足够回答"是不是同一段坏输出反复出现"，又不需要保存原文。
 * 需要看完整内容时，应该走"用户显式开启 + 有效期 + 0600 + 清理策略"的独立诊断，
 * 而不是默认打开（本版没做）。
 *
 * ⚠️ 摘要（sha256）挡不住低熵内容被猜出来，它只是"不存原文"而非"内容不可还原"。
 */
export function dumpRejectedPayload(raw: string, mode: string, reason: string | undefined, logger?: any): void {
  try {
    const dir = joinPath(webLoginDir(), 'diagnostics')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = joinPath(dir, 'rejected-meta.jsonl')
    const knownMode = ['json', 'xml', 'dsml'].includes(mode) ? mode : 'other'
    const knownReason = ['unbalanced', 'unparsable', 'oversize', 'echo'].includes(reason ?? '') ? reason : 'other'
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        mode: knownMode,
        reason: knownReason,
        length: raw.length,
        sha256: createHash('sha256').update(raw).digest('hex'),
      }) + '\n'
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      /* 首次写入 */
    }
    if (size + Buffer.byteLength(line) > 4_000_000) return
    appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
  } catch {
    try {
      logger?.debug?.('deepseek-web: 诊断元信息写入失败')
    } catch {}
  }
}

/**
 * 图片上传缓存：`attachmentId → fileId`。
 *
 * ⚠️ 为什么必须按账号分作用域（审计 F06）：`fileId` 是**归属某个账号**的服务端对象。
 * 缓存原先只按 `attachmentId` 记，切到另一个账号后会把上一个账号的 `fileId` 复用出去 ——
 * 服务端是否接受是它的事（不能据此断言"跨账号能读到图"），但"把我们这边两个号的引用串了"
 * 本身就已经是错的。另外只检查"被查中的那一项"的 TTL 不叫淘汰：一直换新图、不换旧 key 时，
 * 旧项会永久滞留在内存里。
 *
 * 三条纪律：切账号（token 变）立刻整批清空；每次使用前清掉**所有**过期项；条数封顶。
 * `token` 只在本进程内存里当作用域，不写日志、不落盘。
 */
export class ImageUploadCache {
  private scope = ''
  private readonly entries = new Map<string, { fileId: string; at: number }>()
  // ⚠️ 不要写成「constructor 的参数属性」（`constructor(private readonly ttlMs: number)`）：
  // 测试是 `node src/xxx.ts` 直接跑的，而 Node 的类型剥离只支持「擦除型」语法 ——
  // 参数属性需要生成赋值代码，会被判为不支持的语法（实测报 ERR_INVALID_TYPESCRIPT_SYNTAX）。
  private readonly ttlMs: number
  private readonly maxEntries: number
  constructor(ttlMs = 2 * 60 * 60 * 1000, maxEntries = 256) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
  }

  /** 绑定当前账号：token 变了就整批清掉（上一个账号的 fileId 不能跨号复用）。 */
  useScope(token: string): void {
    if (this.scope !== token) {
      this.entries.clear()
      this.scope = token
    }
  }

  /** 当前作用域（`set` 前校验用：await 期间可能被别的账号切走）。 */
  currentScope(): string {
    return this.scope
  }

  /** 清掉**所有**过期项，返回清掉的条数（不只清理"这次要查的那一个"）。 */
  prune(now: number = Date.now()): number {
    let removed = 0
    for (const [key, value] of this.entries) {
      if (now - value.at >= this.ttlMs) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** 命中且未过期才返回；顺手清掉这一条过期项。 */
  get(key: string, now: number = Date.now(), expectScope?: string): string | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    // ⚠️ 0.1.82：与 `set` 的 `expectScope` 对称 —— 作用域不符一律当未命中。
    // 少了这一步，并发（allowConcurrent）时 B 账号上传的 file_id 会被 A 账号的请求
    // 拿去引用，正是 F06 要防的"两个号的引用串了"。
    if (expectScope !== undefined && expectScope !== this.scope) return undefined
    if (now - hit.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return hit.fileId
  }

  /**
   * 写入并封顶（超出时丢最早写入的项）。
   * `expectScope` 用于防"await 期间账号被切走"：作用域已变则拒绝写入。
   */
  set(key: string, fileId: string, now: number = Date.now(), expectScope?: string): boolean {
    if (expectScope !== undefined && expectScope !== this.scope) return false
    this.entries.delete(key)
    this.entries.set(key, { fileId, at: now })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  /** 当前条数（测试用）。 */
  get size(): number {
    return this.entries.size
  }

  /**
   * 定点删除指定的若干条（用于「这批 file_id 被服务端拒了」时的清理）。
   *
   * 为什么不做成全清（`reset()`）：一次请求可能只用到历史里的一小部分图，
   * 全清会让下一次请求把**所有**历史图重新传一遍 —— 白白多几十次上传请求，
   * 而上传本身也是要被风控看的。知道是哪几条被拒，就只清那几条。
   * 返回真正删掉的条数（便于测试与日志）。
   */
  invalidate(keys: Iterable<string>): number {
    let removed = 0
    for (const key of keys) {
      if (this.entries.delete(key)) removed += 1
    }
    return removed
  }

  /** 清空（测试隔离用）。 */
  reset(): void {
    this.entries.clear()
    this.scope = ''
  }
}

/**
 * 这次失败该不该走「重传 → 禁图」的降级重试。抽成纯函数是为了能直接测 ——
 * 尤其 `yielded` 那一支：用假的流很难构造「内容真的上屏过、然后又出错」的场景
 * （文本会被过滤器 hold 到轮末，而异常发生在轮末之前），只能这样钉住它。
 *
 * 三个条件缺一不可：
 *  · 错误是**请求侧的图片引用被拒**（上传侧的 code 9 是另一回事，见 isInvalidRefFileError）
 *  · 这次请求**一个字都还没吐给上层** —— generator 已 yield 的内容撤不回来，
 *    重试只会让用户看到重复输出
 *  · 还没用完两次机会
 */
export function canRetryImageReject(error: any, yielded: boolean, attempt: number): boolean {
  return error?.code === 'INVALID_REF_FILE' && !yielded && attempt < 2
}

/**
 * 被略过的图片份数至少要再多这么多，才值得再上屏一次截断提示。
 *
 * 为什么需要一个下限：首次提示时被略过的往往只有 1~2 份，若下一档就是"翻倍"，门槛会落在
 * 2→4 这种量级 ⇒ 每多读一两张图就又提示一次，等于没抑制。
 */
export const TRIM_NOTICE_FLOOR = 10

/**
 * 下一条截断提示的触发门槛（纯函数，可单测）。
 *
 * 语义（0.1.81）：**首次必说明；之后只有情况明显恶化才再说一次。**
 *  · 没提示过，或保留份数变了（用户改了 `maxRefImages`）⇒ 门槛 1（下一次就说明）
 *  · 否则 ⇒ `max(FLOOR, 上次的份数 × 2)`，即**翻倍**、且至少再多 `TRIM_NOTICE_FLOOR` 份
 *
 * 为什么不再用「总条数:保留数」那种精确签名（0.1.79 → 0.1.81 的修正）：
 * 「总条数」几乎每轮都在涨（模型每 `read_image` 一次就多一条内容）⇒ 签名天天变 ⇒
 * 提示照旧每轮上屏。**判据里只要含一个"单调增长且变化频繁"的量，抑制就等于没做。**
 */
export function nextTrimNoticeThreshold(
  previous: { kept: number; dropped: number } | undefined,
  keptCount: number,
): number {
  if (!previous || previous.kept !== keptCount) return 1
  return Math.max(TRIM_NOTICE_FLOOR, previous.dropped * 2)
}

export const PROVIDER = 'deepseek-web'

export interface ModelSpec {
  id: string
  name: string
  description: string
  /** 网页端路由字段：当前实际只有 default 可用（expert/vision 已被服务端停用）。 */
  modelType: 'default' | 'expert' | 'vision'
  /** 是否默认开启思考（thinking_enabled）。 */
  thinking: boolean
  /** 是否允许通过 reasoningEffort 开关思考。 */
  configurableThinking: boolean
  contextWindow: number
  maxOutputTokens: number
}

/**
 * 网页免费模型目录。
 *
 * 权威依据：`GET /api/v0/client/settings?scope=model` 的 `model_configs`
 * （服务器按账号返回，实测 configVersion 81）：
 *   default / 快速模式 → enabled=true,  switchable=true,  is_default=true
 *   expert  / 专家模式 → enabled=false, switchable=false
 *   vision  / 识图模式 → enabled=false, switchable=false
 * 即专家/识图已被服务端停用并合并进快速模式。**目录里的两条不是两个模型**，
 * 而是同一个「快速模式」的 `thinking_enabled` 开关两档预设（方便一键选）；
 * 也可以通过推理强度（reasoningEffort）在同一个档位上切换。
 * 旧档位选择由 LEGACY_ALIASES 回退承接。
 *
 * 容量（2026-09-11 直接抓服务端 `client/settings` 逐字段核对，configVersion 81）：
 *   `input_character_limit = 2621440`        —— **单请求输入字符数硬上限**（= 2.5 MiB 字符）
 *   `file_feature.token_limit = 890880`      —— 附件/文件的 token 预算（开不开思考都一样）
 *   `file_feature.token_limit_with_thinking = 890880`
 * ⚠️ 曾经的错误：把 `890880` 当成「模型上下文窗口」，还在文档里写成「1M 扣输出预留」。
 * 它是 **file_feature（附件）的 token 预算**，跟上下文窗口不是一回事；而且 890880 = 870×1024，
 * 面板按 ÷1024 显示就成了「870K」，于是看起来像「说好的 1M 变成了 870K」。
 * 服务端并没有给出「总上下文窗口」字段；可核对的硬约束只有上面那条字符上限。
 * 因此 contextWindow 按 DeepSeek 标称的 1M 取 1048576（1 Mi；服务端自己的数字也都是 1024 的整数倍：
 * 2621440 = 2.5×1048576、890880 = 870×1024），真正防越界的是 maxPromptChars（远低于字符硬上限）。
 */
export const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek 网页 · 快速模式（不思考）',
    description: '同一模型，thinking 关闭：直接作答、最快、最省免费额度。适合工具调用/改写/检索类任务',
    modelType: 'default',
    thinking: false,
    configurableThinking: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek 网页 · 快速模式（深度思考）',
    description: '同一模型，thinking 开启：先推理再作答（推理流作为思考块回传）。适合数学/多步调试/规划，更慢也更耗额度',
    modelType: 'default',
    thinking: true,
    configurableThinking: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
  },
]

/**
 * 旧档位兼容：expert/vision 被服务端停用后不再出现在 listModels 里，
 * 但历史会话/预设里若仍指向它们，这里做路由回退而不是直接报错。
 */
const LEGACY_ALIASES: Record<string, string> = {
  'deepseek-pro': 'deepseek-reasoner',
  'deepseek-expert': 'deepseek-reasoner',
  'deepseek-vision': 'deepseek-chat',
}

const EFFORT_OFF = 'off'
const EFFORT_LOW = 'low'
const EFFORT_HIGH = 'high'
const EFFORT_MAX = 'max'

const REASONING_EFFORTS = [
  { id: EFFORT_OFF, name: 'Off', description: '关闭思考（网页快速模式）' },
  { id: EFFORT_LOW, name: 'Low', description: '开启思考（网页只区分开/关，等同 High）' },
  { id: EFFORT_HIGH, name: 'High', description: '开启思考（默认）' },
  { id: EFFORT_MAX, name: 'Max', description: '开启思考（网页只区分开/关，等同 High）' },
]
const OFF_ONLY_EFFORTS = [{ id: EFFORT_OFF, name: 'Off', description: '该模型固定为非思考模式' }]

/** 估算 token 数（网页端不返回 usage；CJK/英文混合按 ~3.2 字符/token 粗估）。 */
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1
  }
  const ascii = text.length - cjk
  return Math.ceil(cjk / 1.5 + ascii / 4)
}

/** 上下文超限的文案识别（网页端返回的是自然语言错误）。 */
function isContextTooLong(message: string): boolean {
  return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|too\s+many\s+tokens|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)|содержани|контекст/i.test(
    message,
  )
}

export interface AdapterConfig {
  /** prompt 字符上限（超出走中段截断）。服务端硬上限是 2621440 字符，默认留 ~43% 余量。 */
  maxPromptChars?: number
  /**
   * 一次请求最多带多少张图片（`ref_file_ids` 的长度上限）。
   *
   * 为什么要加（0.1.77，群友实测）：图片是**请求级**的，网页端对一批引用的数量有上限 ——
   * 实测最后一次成功 40 张、第一次失败 52 张（真值落在 (40, 52]）。超长会话里不同图片数会一路涨
   * （内容寻址去重对"重新截图/重新渲染"无效），越过之后 `biz_code 10 / too many ref file`
   * 会让**该会话此后每一轮都失败**。所以按时间只带最近的 N 张。
   * `0` ＝ 不限制（逃生舱，但等于把这个故障放回来，别设）。
   */
  maxRefImages?: number
  /**
   * 对外声明的模型上下文窗口（token）。默认 1_048_576（1Mi —— 即原来的硬编码值）。
   *
   * 调小它 ⇒ DSH 更早压缩/截断历史 ⇒ 每轮重发的转写更短。与 maxRefImages 同一条路：
   * 由 gate.json 存、index.ts 注入，这里只负责把它塞进模型信息（见 resolvedModelInfo）。
   */
  contextWindow?: number
  /** SSE 空闲超时（毫秒）。 */
  idleTimeoutMs?: number
  /** 是否在调用结束后删除网页端会话（默认 true）。 */
  deleteWebSessions?: boolean
  /**
   * 回答在句中被截时自动发起新请求续写（默认开启）。
   * 续写内容无缝拼进同一条回答；无论续写是否补全，都不会再报 max-tokens
   * （应用户要求移除「已达到输出 token 上限」提示）。
   */
  autoContinue?: boolean
  /** 自动续写的最大轮数（默认 2；每轮是一次新的网页端请求）。 */
  maxContinuations?: number
  /**
   * 是否允许同一账号并发请求（默认 **false = 串行排队**）。
   *
   * 网页端同一账号同时只能生成一条：DSH 的**会话标题生成**（purpose=session-title）
   * 会和主回答撞在一起（实测 272 轮里有 16 对时间重叠），既会被拒、也会推高风控风险
   * （实测：双窗口并发生成不到 6 分钟即被限制 1 天）。只有明确知道自己在做什么时才打开。
   */
  allowConcurrent?: boolean
  /**
   * 最小间隔的**下限**（毫秒，默认 2000）。
   *
   * 实际等待时间在 [minRequestIntervalMs, maxRequestIntervalMs] 之间**随机**取值，
   * 按上一次调用的**结束**时刻计算。随机区间的意义：固定间隔方差≈0，是明显的「定时器特征」。
   */
  minRequestIntervalMs?: number
  /** 最小间隔的**上限**（毫秒，默认 4000）；与下限相等即退化为固定间隔。 */
  maxRequestIntervalMs?: number
  /**
   * 临时会话清理策略（默认 `deferred`）。
   *
   * - `immediate`：调用后 1.5s 删掉（老行为，每轮 1 个 DELETE 请求）
   * - `deferred`：攒够 N 个或等满 T 秒再清理，且优先尝试一个请求批量删
   * - `keep`：完全不删（请求最少，但网页端会留下临时会话）
   */
  sessionCleanup?: 'immediate' | 'deferred' | 'keep'
  /**
   * 同一网页端会话复用的轮次上限（默认 20）。
   *
   * 0 = 关闭复用，回到「每请求建一个会话、用完即删」。
   * 复用的安全性由实测判定：每次都发 `parent_message_id: null`，服务端不带会话历史。
   */
  sessionReuseTurns?: number
  /** deferred 模式的等待上限（毫秒，默认 90000）。 */
  sessionCleanupDelayMs?: number
  /** deferred 模式攒够多少个立即清理（默认 8）。 */
  sessionCleanupBatchSize?: number
  /** 日志器（cordis logger；缺省静默）。 */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
}

export interface AdapterDeps {
  getAuth: () => WebAuth | undefined
  config: AdapterConfig
  /**
   * 读取 DSH 附件服务的图片字节（ctx.attachments.readImage）。
   * 缺省时图片输入不可用（会退化成文本占位提示）。
   */
  readImage?: (ref: any, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType?: string; name?: string }>
  /**
   * 每次模型调用的结果上报（成功/失败、耗时、错误码、受限解除时间）。
   *
   * 宿主用它做两件事，所以只留**一个**钩子而不是两个：
   *  1. 把 `mutedUntilMs` 记到账号上 → 设置页显示"限制还剩多久"；
   *  2. 写本地调用台账 → 看请求密度与失败分类（判断节流是否真的有效）。
   * 上报失败不得影响调用本身（宿主内部自己吞异常）。
   */
  noteCall?: (info: {
    /** 调用用途（chat / session-title / compaction…）。 */
    purpose: string
    ok: boolean
    ms: number
    code?: string
    message?: string
    /** 账号级限制的解除时间（仅 user is muted）。 */
    mutedUntilMs?: number
    /** 是否属于"限流"（发太频繁）而非"账号被限制"。 */
    throttled?: boolean
    /**
     * **发起这次调用时**的账号 id。
     * ⚠️ 不能由宿主在收到上报时现取 —— 见 F05 的说明。
     */
    accountId?: string
  }) => void
  /**
   * 取"当前账号 id"。宿主注入；适配器在**发起请求前**调一次，
   * 结果随 noteCall 回传，避免请求飞行途中切号导致记错账号。
   */
  currentAccountId?: () => string | undefined
  /** 注入自定义流函数（单测用假流验证自动续写）；缺省用 streamWebCompletion。 */
  streamCompletion?: (auth: WebAuth, params: any) => AsyncGenerator<any>
  /**
   * 注入自定义图片上传（单测用假上传验证 ref_file_ids 的组装）；缺省用 uploadImageFile。
   *
   * 为什么要留这个缝：真实上传要 PoW（sha3 wasm）+ 一次真网络往返，单测跑不动，
   * 于是「同一张图在历史里出现两次时，ref_file_ids 会不会重复」这条**接线级**行为
   * 长期零覆盖（只有纯函数 collectImageRefs 被测过，它压根不管去重）。
   */
  uploadImage?: typeof uploadImageFile
  /**
   * 外部注入的请求闸门（宿主在设置页里要能改它的配置，所以由 index.ts 创建并共享）。
   * 缺省时按 config 自建一个。
   */
  gate?: RequestGate
  /**
   * 外部注入的临时会话清理器（策略由宿主配置：immediate / deferred / keep）。
   * 缺省时退回「调用后 1.5s 删除」的老行为。
   */
  sessionCleaner?: SessionCleaner
  /**
   * 请求开始前的**钩子**：宿主用它做自动轮换账号（见 `index.ts` 的 `maybeAutoSwitch`）。
   *
   * 位置很讲究 —— 必须在闸门 `acquire` **之前**：换号要落在"两个请求之间"，
   * 而不能插进一个已经起飞的请求里（那次请求的 `auth` 早就解析完了，中途换号只会自相矛盾）。
   * 钩子自己吞异常：换号失败最多是这一轮不换，绝不能让请求失败。
   */
  maybeAutoSwitch?: () => Promise<void>
}

function modelInfoFor(provider: string, spec: ModelSpec, requestedId?: string) {
  return {
    provider,
    id: requestedId ?? spec.id,
    name: spec.name,
    description: spec.description,
    // 图片输入走「上传成文件 + ref_file_ids」通道（网页端看图的实际机制），
    // 已实测：上传左红右蓝 PNG 后模型准确答出「左红色，右=蓝色」。
    inputModalities: ['text', 'image'] as const,
  }
}

/**
 * 组装模型信息。
 *
 * `contextWindowOverride` 来自设置页的「上下文范围」滑块（经 gate.json → index.ts → AdapterConfig）。
 * 传 undefined 就沿用 MODEL_SPECS 里的标称值（1Mi）—— 也就是不调这个开关时的原行为。
 *
 * ⚠️ 这个函数**每次请求都会被调用**（见下方 resolveModel / stream），所以滑块改完是即时生效的，
 * 不需要重启 DSH。
 */
function resolvedModelInfo(
  provider: string,
  spec: ModelSpec,
  requestedId?: string,
  contextWindowOverride?: number,
) {
  return {
    ...modelInfoFor(provider, spec, requestedId),
    context: { contextWindow: contextWindowOverride ?? spec.contextWindow },
    defaultMaxTokens: spec.maxOutputTokens,
    reasoning: spec.configurableThinking
      ? { efforts: REASONING_EFFORTS, defaultEffort: spec.thinking ? EFFORT_HIGH : EFFORT_OFF }
      : { efforts: OFF_ONLY_EFFORTS, defaultEffort: EFFORT_OFF },
  }
}

/**
 * 解析模型：命中目录直接用；命中旧档位（expert/vision）按别名回退到对应档位，
 * 但**保留请求时的 id** —— 运行时要求 resolveModel 返回的 id 必须与请求一致
 * （INVALID_MODEL_INFO），否则历史会话里的旧档位选择会直接报错。
 */
function resolveSpec(model: string): ModelSpec {
  const requested = String(model ?? '')
  const direct = MODEL_SPECS.find((spec) => spec.id === requested)
  if (direct) return direct
  const alias = LEGACY_ALIASES[requested]
  if (alias) {
    const mapped = MODEL_SPECS.find((spec) => spec.id === alias)
    if (mapped) return mapped
  }
  return MODEL_SPECS[0]
}

/** 解析本次请求的思考开关。 */
function resolveThinking(options: any, spec: ModelSpec): { thinkingEnabled: boolean } {
  // 辅助调用（会话标题/压缩）永远走非思考，省时省钱
  if (options?.purpose === 'session-title' || options?.purpose === 'compaction') return { thinkingEnabled: false }
  if (!spec.configurableThinking) return { thinkingEnabled: spec.thinking }
  const effort = options?.reasoningEffort
  if (effort === undefined) return { thinkingEnabled: spec.thinking }
  if (effort === EFFORT_OFF) return { thinkingEnabled: false }
  if (effort === EFFORT_LOW || effort === EFFORT_HIGH || effort === EFFORT_MAX) return { thinkingEnabled: true }
  throw new AdapterLlmError(`deepseek-web 不支持 reasoning effort "${String(effort)}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

/**
 * 自动续写的用户指令（流被截后，适配器自动发起新请求让模型接着写——
 * 等价于用户手动说「继续」，但无需用户参与、且文本无缝拼接进同一条回答）。
 */
const CONTINUE_INSTRUCTION =
  '继续：请从你上一条回复的结尾处无缝接着往下写——不要重复任何已输出的内容，' +
  '不要加「好的」「以下是」之类的开场白，不要重新组织语言；' +
  '如果上一条回复停在句子中间，就从那个断点直接把句子写完并继续。'

/**
 * 「把工具程序写成了正文」时的纠正指令（比自动续写更强的措辞 —— 续写是"接着写"，
 * 这个是"你刚才那一轮等于什么都没做，请重新发一次"）。
 *
 * 为什么需要（2026-09-17 11:00 现场，见 protocol.ts 里 looksLikeUnexecutedToolProgram 的说明）：
 * 染神 preset 注入了 PTC 说明（"所有动作必须通过 run_code 写 TypeScript 程序"），
 * 模型于是把 run_code 的 code 直接贴进正文；这一轮零工具调用 ⇒ agent loop 判定回合结束
 * ⇒ 界面上看起来"它停下来了"。加这一轮纠正后，模型有机会把同一段程序改发成工具调用。
 *
 * 措辞要点：① 点破"写出来 ≠ 执行了"；② 给出唯一被接受的形态；③ 明确对抗 PTC 措辞 ——
 * 否则模型会继续把系统提示里那句"写出 TypeScript 程序"当成"写进正文"的许可。
 */
const TOOL_CALL_RETRY_INSTRUCTION =
  '你刚才把要执行的程序写进了正文文本。写在正文里的代码不会被执行 —— 这一轮因此没有发生任何工具调用。\n' +
  '请把同一段程序作为工具调用重新发出：只输出一个 JSON 对象，前后不要有任何其它文字：\n' +
  '{"tool_calls":[{"name":"<工具名>","arguments":{...}}]}\n' +
  '即使系统提示要求你写 TypeScript 程序来完成动作，那个程序也必须放进工具调用的 arguments 里，' +
  '不能直接写在正文中 —— 只有作为工具调用发出，它才会真的被执行。'

/**
 * 出现在末尾即「明显还有下文」的标点：列举 / 分句写到一半停了。
 * 正常写完的回答**不可能**以这些收尾（它们是分隔符，不是终止符）。
 *
 * 0.1.66 补：`；`（全角分号）与 `、`（顿号）在旧实现里都落到了「非标点字符」那条兜底规则上，
 * 被判成完整 —— 而这两个恰恰是最强的「没写完」信号（列举到一半、分句列到一半）。
 * 实测（源码函数直接求值）旧行为：`；` → false、`、` → false，而 `，`/`：`/`;` → true，
 * 同一个文件里两套标准。
 */
const MID_SENTENCE_TAIL = new Set(['，', '、', '；', '：', ',', ';', ':'])

/**
 * 出现在末尾即视为「正常收尾」的标点。
 *
 * ⚠️ `…` 放在这里是**刻意的取舍**：省略号既可能是"话没说完"，也可能是作者有意的收束语气，
 * 两种都常见。判 true 会让一句正常收尾的话被要求"接着写"（模型容易重复一遍），
 * 感知上比偶发漏判更打扰，所以保守放行。真被服务端切断（无 FINISHED）时走 `cutByServer`，
 * 不依赖这条判据。
 */
const COMPLETE_TAIL = new Set(['。', '！', '？', '!', '?', '…', '）', ')', '】', '》', '」', '』', '"', '”', '’'])

/**
 * 启发式：正文是否「在句中被截」。
 * 判据（尾部最后一个非空白字符）：
 *  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
 *  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
 *  - 是逗号/顿号/分号/冒号 → 明显未完。
 *  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
 *
 * ⚠️ 这是启发式，**只在"明显没写完"时才敢返回 true**：误判 true 只是白发一次续写请求，
 * 误判 false 却是用户直接丢内容 —— 两种代价不同，所以判据本身要能读懂「分隔符 vs 终止符」。
 */
function looksMidSentence(text: string): boolean {
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return false
  // F29：短文本（< 40 字）不判「句中被截」——"我在""在吗"这类**完整短答**天然以汉字收尾，
  // 旧判据对它恒真，会白打 1~2 次续写请求。服务端真截断（cutByServer，无 FINISHED）不走
  // 这条判据、仍会续写，所以这里收窄只影响「有 FINISHED 但尾部是汉字」的场景。
  if (trimmed.length < 40) return false
  const last = trimmed[trimmed.length - 1]
  // markdown 标记收尾：`*` `_` `#` `~` `` ` `` 本身可能是「标记被截」，只有成对的一半才算
  if (last === '*' || last === '_' || last === '#' || last === '~' || last === '`') {
    return trimmed.endsWith('**') || trimmed.endsWith('__')
  }
  if (MID_SENTENCE_TAIL.has(last)) return true
  if (COMPLETE_TAIL.has(last)) return false
  // 字母/数字/汉字/其他非标点字符收尾 → 大概率被截
  return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last)
}

/**
 * 自动续写只对**用户可见的回答**（purpose === 'chat'）生效。
 *
 * F26（2026-09-14 实测）：标题生成 / 上下文压缩这类内部调用天然**不以标点收尾**
 * （标题就是"以汉字结尾"），于是 `looksMidSentence` 对它**恒为真** →
 * 每轮都被判成"句中被截" → 自动发起续写、要求模型"接着写" → 模型把标题重复一遍，
 * 直到续写额度用尽。结果标题变成重复垃圾：实测 13 个会话里 **11 个**中招 ——
 * `"在吗在吗在吗"`、`"AI助手的记忆功能"×3`、`"安装 archify skills"×3`、
 * `"TCP 三次握手原因解析"×3` …（只有走 fallback 的两个标题是正常的）。
 *
 * 续写的本意是"帮用户把被截断的回答写完整"，对内部短文本没有意义，所以按用途白名单收口：
 * 只有 `chat`（或未指定）才续写 —— 将来新增别的内部用途也不会再踩进来。
 */
function allowsAutoContinue(purpose: unknown): boolean {
  return purpose === undefined || purpose === null || purpose === '' || purpose === 'chat'
}

/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
export function createAdapter(deps: AdapterDeps) {
  const logger = deps.config.logger
  // 流函数可注入（单测用假流验证自动续写）；缺省走真实网页端实现
  const runStream = deps.streamCompletion ?? streamWebCompletion
  // 图片上传同理可注入（单测验证 ref_file_ids 组装 / 失败告知）；缺省走真实上传
  const uploadImage = deps.uploadImage ?? uploadImageFile

  // 请求闸门：串行 + 最小间隔，覆盖**每一次**模型调用（含 DSH 的会话标题/压缩等辅助调用）。
  // 宿主（index.ts）会注入一个共享实例，好让设置页改完立即生效；缺省自建。
  const gate =
    deps.gate ??
    createRequestGate({
      allowConcurrent: deps.config.allowConcurrent === true,
      minIntervalMs: deps.config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
      logger,
    })

  const adapter = {
    providerInfo(provider: string) {
      return { id: provider, name: 'DeepSeek 网页版（免费）' }
    },

    /** 未配置策略 → 走 dsh-llm 默认重试码表（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）。 */
    providerRetryPolicy(_provider: string) {
      return undefined
    },

    /**
     * 图片请求计价：本路由不声明 → undefined（消费者回落到自己的中性估算）。
     *
     * ⚠️ 这个方法**必须有**，不是可选装饰：dsh-llm 的适配器注册表在计量/压缩路径上**无条件**转调
     * `adapter.imageRequestPricing(provider, model)`（见 app.asar 内 LlmAdapterRegistry.imageRequestPricing）。
     * 而本适配器是鸭子类型的**普通对象**、不继承 `LlmAdapter` 基类，基类里那个「默认返回 undefined」的实现
     * 我们拿不到 → 缺了它就抛 `... .imageRequestPricing is not a function`，
     * 于是 basic-compaction-engine 每一步压缩都失败（实测 2026-09-10：69 次，压缩**静默失效**，
     * 长会话不再自动压缩，且只留一条 warn）。
     *
     * 契约：必须**同步、无 I/O**（token meter 每次测量都会调）。
     */
    imageRequestPricing(_provider: string, _model: string): undefined {
      return undefined
    },

    listModels(provider: string) {
      return Promise.resolve(MODEL_SPECS.map((spec) => modelInfoFor(provider, spec)))
    },

    resolveModel(provider: string, model: string) {
      return Promise.resolve(
        resolvedModelInfo(provider, resolveSpec(model), String(model ?? ''), deps.config.contextWindow),
      )
    },

    /**
     * 运行时契约（dsh-llm 0.1.2-rc.1）：dispatch 前先取「精确模型元数据 + 该次调用的 stream」。
     * 返回的 stream 接收运行时补齐后的 options。
     */
    prepareCall(provider: string, model: string, _signal?: AbortSignal) {
      const spec = resolveSpec(model)
      return Promise.resolve({
        model: resolvedModelInfo(provider, spec, String(model ?? ''), deps.config.contextWindow),
        stream: (options: any) => gatedStream(options),
      })
    },

    stream(options: any): AsyncGenerator<any> {
      return gatedStream(options)
    },
  }

  /** 图片上传缓存：按账号作用域 + TTL + 条数封顶（见 ImageUploadCache 的说明）。 */
  const uploadCache = new ImageUploadCache()

  /**
   * 上一次请求**实际引用**了哪几张图（attachmentId 集合）。
   * 用途只有一个：请求被服务端以 `code 9 / invalid ref file id` 拒掉时，
   * 知道该清掉缓存里哪几条，好让重试时重新上传（见 streamWithImageFallback）。
   */
  let lastImageKeys: Set<string> = new Set()

  /**
   * 上一次**已经上屏过**的截断规模（保留数 + 当时被略过的份数）。
   *
   * 为什么要它：只要历史里的图片内容超过上限，`uploadRequestImages` 每轮都会算出同一条提示 ——
   * 实测 19 分钟里连着上屏 **52 次**（2026-09-21 那个 drawio 配图会话），用户直接问
   * "为啥每次都这么多提示"。同一件事说一遍就够了，重复的只写日志。
   *
   * 🔴 0.1.81 修正了抑制的粒度。0.1.79 用的是 `总条数:保留数` 这个**精确签名**，
   * 而"总条数"几乎每轮都在涨 —— 模型每 `read_image` 一次就多一条内容 ⇒ 签名变了 ⇒
   * 提示照旧每轮上屏（2026-09-22 现场：29 份 → 30 份又来一遍，用户说"频率还是有点高"）。
   * 改成**阶梯**：首次必说明；之后只有"被略过的份数"比上次翻倍（且至少再多 `TRIM_NOTICE_FLOOR`
   * 份）才再说一次。这样一条会话里它是 O(log n) 次，而不是 O(n) 次。
   * 保留数变了（用户改了 `maxRefImages`）⇒ 情况本身变了，重新说明一次。
   */
  let lastTrimNotice: { kept: number; dropped: number } | undefined

  /**
   * 把请求里出现的图片全部上传到网页端并返回 file_id 列表。
   * 失败不致命：记日志后跳过该图（prompt 里仍有 [image attached] 标记，模型会知道有图但看不到）。
   * 但**取消**要照常传播 —— 用户点了停止就不该继续传图，也不该把它降级成"纯文本继续跑"。
   */
  async function uploadRequestImages(
    auth: WebAuth,
    messages: readonly any[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ ids: string[]; keys: string[]; keptKeys: Set<string>; notice?: string }> {
    signal?.throwIfAborted()
    uploadCache.useScope(auth.token)
    const scope = uploadCache.currentScope()
    const refs = collectImageRefs(messages)
    if (refs.length === 0) return { ids: [], keys: [], keptKeys: new Set() }
    // 去重（0.1.66）：同一张图可能在同一份历史里出现多次 —— 用户消息里一次、
    // `read_image` 的工具结果里又一次（工具结果内嵌图片本体），甚至模型对同一个文件
    // 连调两次 read_image。实测本机会话 `install-plugin/session-c1fb8208-*` 里就有
    // 两个 tool/result 各自内嵌同一张 `sha256:23c18a56…`（89962B JPEG）。
    //
    // 为什么必须去重：`attachmentId` 是**内容寻址**（sha256），同一张图必然是同一个 key，
    // 于是缓存命中时会把**同一个 file_id 再推一遍**，请求体变成 `ref_file_ids: [id, id]`。
    // 服务端不接受重复 id（biz_code 9 / invalid ref file id），一旦被拒，
    // 该会话**后续每一轮都会失败**（图留在历史里），只能新开对话。
    //
    // 每个 attachmentId 只产出一个 file id —— 这是最小、也最贴近语义的修法
    // （不同附件即使内容相同，也各有各的 id，不该在这里合并）。
    const seen = new Set<string>()
    const unique: any[] = []
    for (const ref of refs) {
      const key = String(ref?.attachmentId ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(ref)
    }
    if (unique.length === 0) return { ids: [], keys: [], keptKeys: new Set() }
    if (!deps.readImage) {
      logger?.warn?.('deepseek-web: 收到图片但附件服务不可用（ctx.attachments），图片被忽略')
      return {
        ids: [],
        keys: [],
        keptKeys: new Set(),
        notice: imageNotice(unique.length, '宿主没有提供附件读取能力（ctx.attachments）'),
      }
    }
    // ── 0.1.77：图片数量阀门 ──────────────────────────────────────────────
    // 图片是**请求级**的（一次请求用一个 `ref_file_ids` 带一批），而网页端对这一批有数量上限。
    // 群友实测报告（2026-09-19）：最后一次成功是 40 张、第一次失败是 52 张 ⇒ 真值在 (40, 52]。
    // 超长会话里这个数字会一路涨，且**去重救不了**：`attachmentId` 是内容寻址的，
    // 重新截图 / 重新渲染的预览图每次内容都变 ⇒ 新 id ⇒ 历史里只增不减。
    // 越过上限后 `biz_code 10 / too many ref file` 会让**该会话此后每一轮都失败** ——
    // 图留在历史里，每轮重发都超标，用户只能丢掉整个会话。所以按时间取最近的 N 张。
    //
    // ⚠️ 标记必须一起收敛（见 protocol.ts 的 classifyBlockImages）：只截 id 不截标记，
    // 模型会以为它收到了那些图，转而对着没送出去的图瞎猜。
    const maxRefImages = deps.config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES
    const overLimit = maxRefImages > 0 && unique.length > maxRefImages
    const kept = overLimit ? unique.slice(-maxRefImages) : unique
    // ⚠️ 0.1.82：keptKeys **不再**预先按裁剪结果算 —— 它会被当成"本轮真的带上的图"
    // 传给 `serializePromptParts`（后者据此写 `[image attached]` / `[earlier image omitted]`），
    // 而**上传失败**的图并没有进 `ref_file_ids` ⇒ 模型以为收到了，转而对着没送出去的图瞎猜。
    // 改成在上传循环里按"成功（含缓存命中）"累计，见下面的 sentKeys。
    // 提示按**阶梯**上屏（见 nextTrimNoticeThreshold）：首次必说明，之后只有被略过的份数
    // 翻倍（且至少再多 TRIM_NOTICE_FLOOR 份）才再说一次。日志照记不误，每轮的截断都能查。
    const dropped = unique.length - kept.length
    const trimNotice =
      overLimit && dropped >= nextTrimNoticeThreshold(lastTrimNotice, kept.length)
        ? imageTrimNotice(unique.length, dropped, kept.length)
        : undefined
    if (trimNotice) lastTrimNotice = { kept: kept.length, dropped }
    if (overLimit) {
      logger?.info?.(
        `deepseek-web: 本请求的图片共 ${unique.length} 张，超过上限 ${maxRefImages} ⇒ 只发最近的 ` +
          `${kept.length} 张（较早的 ${unique.length - kept.length} 张本轮略过）`,
      )
    }
    uploadCache.prune()
    const ids: string[] = []
    const failures: string[] = []
    // 0.1.80：`attempted` 数"真的发起过上传的张数"，`skippedByAuth` 记"因授权失效而放弃的张数"。
    // 只在授权失败时才有值 —— 那个数字要进用户可见的告知语（否则只报 1 张，看着像小事）。
    let attempted = 0
    let skippedByAuth = 0
    /** 真的进了 `ref_file_ids` 的那些 key —— 提示里的 `[image attached]` 只能写在这些图上。 */
    const sentKeys = new Set<string>()
    /** 与 `ids` **同序平行**的 key 数组 —— webapi 的 sentRefIds 按 key 记账需要这个对应关系。 */
    const sentKeyList: string[] = []
    for (const ref of kept) {
      signal?.throwIfAborted()
      const key = String(ref?.attachmentId ?? '')
      const cached = uploadCache.get(key, Date.now(), scope)
      if (cached) {
        ids.push(cached)
        sentKeys.add(key)
        sentKeyList.push(key)
        continue
      }
      attempted += 1
      try {
        const stored = await deps.readImage(ref, signal)
        const mediaType = stored.mediaType || String(ref.mediaType ?? 'image/png')
        const uploadedFile = await uploadImage(
          auth,
          {
            data: stored.data,
            mediaType,
            // 名字必须声明一个服务端支持的图片类型：宿主给 tool/result 内嵌图片的
            // `name` 是**纯 sha256（无后缀）**，实测会被以 code 9 拒（见 imageUploadName）。
            name: imageUploadName(stored.name ?? ref.name, mediaType),
          },
          signal,
        )
        uploadCache.set(key, uploadedFile.fileId, Date.now(), scope)
        ids.push(uploadedFile.fileId)
        sentKeys.add(key)
        sentKeyList.push(key)
      } catch (error: any) {
        if (signal?.aborted) throw error
        const message = String(error?.message ?? error)
        failures.push(message)
        logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${message}`)
        // 0.1.80：授权失效是**全局**的 —— 同一个 token 上传剩下的图必然同样被拒。
        // 继续往下试纯粹是白跑请求：每张图都要先求一次 POW、再发一次上传。
        // 实测（2026-09-21）：14 张图 ⇒ 28 次注定失败的请求，而且这些无效请求
        // 同样暴露在风控下。第一张撞 AUTH 就停，把结论交给接下来的 completion ——
        // 它才是判断"这次凭证到底能不能用"的地方（万一只是单张图的问题，
        // 剩下的图不该被无辜牺牲，所以是 break 而不是 throw）。
        if (error?.code === 'AUTH') {
          skippedByAuth = kept.length - attempted
          logger?.warn?.(`deepseek-web: 图片上传遭遇授权失败，剩余 ${skippedByAuth} 张不再尝试`)
          break
        }
      }
    }
    // 图丢了必须让**用户**看见，不能只写日志（见 imageNotice 的说明）
    const notices: string[] = []
    if (trimNotice) notices.push(trimNotice)
    if (failures.length > 0) notices.push(imageNotice(failures.length, failures[0], skippedByAuth))
    // 这里回传的是**真的带上了**的集合（不是"打算带"的），调用方据此写提示标记
    return { ids, keys: sentKeyList, keptKeys: sentKeys, ...(notices.length > 0 ? { notice: notices.join('') } : {}) }
  }

  /**
   * 图片没能送进模型时的用户可见告知。
   *
   * 为什么必须写进回答：旧实现只 `logger.warn` 然后降级成纯文本，**界面上一声不响** ——
   * 用户会以为「模型看不懂图」，而实际上是图根本没发出去（2026-09-15 实测：本机 09-14
   * 有 36 次上传被服务端以 code 9 unsupported file type 拒绝，当轮 completion 正常
   * FINISHED，界面上看不到任何异常）。模型对外的 `inputModalities` 声明了 image，
   * 丢了却不告知，等于让用户对着一个「假装收到了」的输入提问。
   *
   * 与 F28 同一个原则：只要是「本该处理、但被丢弃」的输入，就必须显式说出来。
   *
   * `skipped`（0.1.80）：授权失效导致中途放弃时，**必须把"剩下的根本没试"说出来**。
   * 否则文案只报 `count`（实际只有第一张），用户会以为"只丢了一张图"、继续等结果，
   * 而真实情况是这一轮的图几乎全废了、且凭证已经不能用。
   */
  function imageNotice(count: number, reason: string, skipped = 0): string {
    // 失败原因可能很长（授权失败那条带整段引导语），截断后再放进正文
    const brief = reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
    const tail =
      skipped > 0
        ? `；第一张被拒后即中止，剩余 ${skipped} 张未再尝试（授权失效是全局的，继续重试只是白跑请求）`
        : ''
    return `\n⚠️ [deepseek-web] 有 ${count} 张图片没能传给模型（${brief}）${tail}，本轮回答只基于文字内容。\n`
  }

  /**
   * 「本轮只带了最近 N 张图」的告知语。
   *
   * ⚠️ 措辞刻意**不带警告符号、也不用「没能」** —— 这是一次**正常的长度控制**，不是失败。
   * 用报错的口吻会让人以为出了问题，而在弄清原因之前，他很可能就把一个本可以继续用的会话丢掉了
   * （这正是 code 10 最恶劣的地方：会话看起来「坏了」，用户唯一出路是丢掉全部上下文）。
   * 所以这句里明确写了「不是错误」。
   *
   * 与上面那条的分工：那条讲「图发失败」（要警惕），这条讲「图按策略没发」（正常）。
   */
  function imageTrimNotice(total: number, dropped: number, kept: number): string {
    return (
      `\n[deepseek-web] 本轮只带了最近 ${kept} 份图片内容，更早的 ${dropped} 份未随请求发送` +
      `（历史累计 ${total} 份）。这里的「份」是**图片内容条目**、不是你贴的张数 ——` +
      '模型每读一次图就会多算一条，所以它远多于你亲手贴的张数。网页端对单次请求能引用的图片数有上限，' +
      '超了整轮都会被拒，因此按时间留最近的这些。正常的内容控制，不是错误。\n'
    )
  }

  /**
   * 图片引用被服务端拒绝时的降级重试（0.1.78）。
   *
   * `code 9 / invalid ref file id` 的恶劣之处是「**带上图就失败**」：图留在 DSH 的消息历史里，
   * 之后每一轮都会重新收集、重新引用、再撞一次 —— 用户除了丢掉整个会话没有别的出路。
   * 所以给它两级自救，每级各只做一次：
   *   ① 丢掉那几条上传缓存 → 重新上传拿新 file_id → 重发
   *   ② 仍被拒 → **不带任何图片**重发，至少让这一轮继续下去（正文里会告知）
   *
   * ⚠️ **只在一次都没吐出内容时才敢重试**：generator 一旦 yield 过，调用方已经收到那部分，
   * 撤回不了（会变成重复输出）。好在服务端的引用校验发生在生成之前，命中这条错误时
   * 一定还没有任何输出 —— `yielded` 守卫是第二道保险，不是判据本身。
   */
  async function* streamWithImageFallback(options: any): AsyncGenerator<any> {
    let attempt = 0
    let current = options
    while (true) {
      let yielded = false
      const inner = streamImpl(current)
      try {
        while (true) {
          const step = await inner.next()
          if (step.done === true) return
          yielded = true
          yield step.value
        }
      } catch (error: any) {
        if (!canRetryImageReject(error, yielded, attempt)) throw error
        attempt += 1
        current = attempt === 1 ? { ...options, __retryImages: true } : { ...options, __skipImages: true }
        logger?.warn?.(
          attempt === 1
            ? 'deepseek-web: 图片引用被服务端拒绝（code 9）—— 丢掉那几张的上传缓存，重新上传后重试一次'
            : 'deepseek-web: 重新上传后图片引用仍被拒（code 9）—— 本轮改为不带图片重发',
        )
      }
    }
  }

  /**
   * streamImpl 的闸门外壳：拿到许可后才真正开始请求，流结束（含被中断/抛错）才释放。
   *
   * ⚠️ 许可在 generator 体**内部**获取 —— 只有真正开始迭代（第一次 next()）才占位，
   * 消费者拿了 generator 却没迭代时不会泄漏名额；流被 abort 时 finally 一定会释放。
   */
  async function* gatedStream(options: any): AsyncGenerator<any> {
    const purpose = typeof options?.purpose === 'string' && options.purpose ? options.purpose : 'chat'
    // 自动轮换账号的检查点（宿主注入；不注入即无操作）。
    // ⚠️ 刻意放在 acquire **之前**：换号要落在"两个请求之间"，不能插进已经起飞的请求里。
    // 宿主侧已自己吞异常，这里再兜一层 —— 换号这种"顺带做的事"绝不该让请求失败。
    try {
      await deps.maybeAutoSwitch?.()
    } catch {}
    // F11：把调用方的取消信号交给闸门 —— 否则「点停止」之后，请求仍会在排队/
    // 等间隔里干等（间隔 2~4s、长休可达 180s），界面停了、闸门还在倒计时。
    const release = await gate.acquire(purpose, options?.signal)
    const startedAt = Date.now()
    // ⚠️ F05（2026-09-12 审计）：在**起飞前**就把账号 id 定下来。
    // 旧实现由宿主在上报时现取 `activeAccountId()`，而这次调用可能飞几十秒 ——
    // 期间用户若切了号，失败/限制就会被记到**切换后的账号**上：
    // 被限制的号反而清白，正在用的号却背了别人的处罚。
    const accountIdAtStart = deps.currentAccountId?.()
    let reported = false
    /** 上报一次结果。钩子是宿主给的，它自己负责不抛错；这里再兜一层，别让它影响调用。 */
    const report = (info: { ok: boolean; code?: string; message?: string; mutedUntilMs?: number; throttled?: boolean }): void => {
      if (reported) return
      reported = true
      try {
        deps.noteCall?.({ purpose, ms: Date.now() - startedAt, accountId: accountIdAtStart, ...info })
      } catch {}
    }
    try {
      yield* streamWithImageFallback(options)
      // 跑完没抛错 = 这次调用成功。宿主会用这个信号清理"已经过期的受限标记"。
      report({ ok: true })
    } catch (error: any) {
      report({
        ok: false,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(typeof error?.message === 'string' ? { message: error.message.slice(0, 300) } : {}),
        ...(Number.isFinite(error?.mutedUntilMs) ? { mutedUntilMs: error.mutedUntilMs } : {}),
        ...(error?.failure?.rateLimitKind === 'throttled' || error?.rateLimitKind === 'throttled' ? { throttled: true } : {}),
      })
      throw error
    } finally {
      release()
    }
  }

  async function* streamImpl(options: any): AsyncGenerator<any> {
    const auth = deps.getAuth()
    if (!hasUsableAuth(auth)) {
      throw new AdapterLlmError(
        '尚未登录 DeepSeek 网页版：请在「设置 → DeepSeek 网页登录」里用浏览器窗口登录，或手动粘贴 userToken。',
        'MISSING_CREDENTIAL',
      )
    }
    // 0.1.80：已知**授权失效**的账号，请求根本不发。
    //
    // 现场（2026-09-21）：探活在 22:42 就判定了 token 失效并在账号上留了标记，
    // 但请求路径没人看那块牌子 —— 22:50 仍拿它去跑，14 张图逐个走一次 POW + 一次上传
    // （28 次注定失败的请求）才撞上 AUTH。更要紧的是：**这些无效请求同样暴露在风控下**。
    // 判据本身早就写好了（probe.ts 的 lastProbeFailed），只是没人在请求前调用。
    //
    // ⚠️ 只拦**授权类**失败（见 auth.ts isAuthFailureMessage）：断网 / 超时 / 5xx 不拦，
    // 否则一次网络抖动就会把健康账号锁住。误拦的出口是明确的：重新登录，或点一次
    // 「校验全部」（只读探活，成功即清掉标记）—— 所以错误里要把两句都写上。
    const stale = staleAuthMessage(auth)
    if (stale) {
      logger?.warn?.(`deepseek-web: 跳过请求 —— 该账号登录态已被判定失效（${stale}）`)
      throw new AdapterLlmError(
        `这个账号的登录态已失效（${stale}），本次请求没有发出。` +
          '请在「设置 → DeepSeek 网页登录」用浏览器窗口重新登录该账号；' +
          '若确认它其实还能用，点账号行上的「校验全部」重新确认一次即可（只读探活，不消耗额度）。',
        'AUTH',
      )
    }
    const spec = resolveSpec(String(options?.model ?? ''))
    const { thinkingEnabled } = resolveThinking(options, spec)

    // 0.1.78：上一轮的图片引用被服务端拒了 ⇒ 先把缓存里那几条丢掉，本轮重新上传。
    // 缓存里的 file_id 可能因为凭证变化 / 服务端回收而失效，重传是最可能奏效的一步。
    if (options?.__retryImages === true && lastImageKeys.size > 0) {
      const removed = uploadCache.invalidate(lastImageKeys)
      lastImageKeys = new Set()
      logger?.warn?.(`deepseek-web: 已丢弃 ${removed} 条上传缓存（它们对应的 file_id 被服务端拒绝过）`)
    }

    // 图片：读取附件 → 上传到网页端 → 用 file_id 随请求引用（网页端看图的实际机制）
    // notice：有图没能送出去时给用户的一句告知（下面会作为正文首段吐出去）
    //
    // `__skipImages`（降级重试的第二级）：连着两次都不被认，就**不带图**再发一次。
    // 宁可这一轮没有图，也不能让会话卡在"每轮都失败"上 —— 那等于整个会话作废。
    const uploaded =
      options?.__skipImages === true
        ? { ids: [], keys: undefined, keptKeys: undefined, notice: undefined }
        : await uploadRequestImages(auth, options?.messages, options?.signal)
    // ⚠️ 0.1.82：`__skipImages`（不带图重发）**绝不能**更新 lastImageKeys ——
    // 它记的是"上一轮那批 key 的 file_id 被服务端拒过"，抹成空集就等于下一轮
    // 又从中毒缓存出发，重演"2 次注定被拒 + 1 次无图"。
    if (uploaded.keptKeys) lastImageKeys = uploaded.keptKeys
    const refFileIds = uploaded.ids

    // 链式投喂需要 prompt 的**结构**（固定头 + 未截断的历史条目）才能算增量，
    // 所以这里取 parts、下面的 params 一起把 entries 传下去（见 context-feed.ts）。
    let promptParts = serializePromptParts({
      system: options?.system,
      messages: options?.messages ?? [],
      tools: (options?.tools ?? []) as ToolSchemaLike[],
      maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      // 只对**首轮**传：它才是真正带 ref_file_ids 的那一次（续写轮 refFileIds 传空）。
      // 传了之后，被长度控制略过的图会写成 `[earlier image omitted]` 而不是 `[image attached]`
      // —— 标记与实发必须一致，否则模型会对着没送出去的图瞎猜。
      keptImageKeys: uploaded.keptKeys,
    })
    const prompt = promptParts.full

    const knownNames = new Set<string>((options?.tools ?? []).map((tool: any) => String(tool?.name ?? '')))
    // 自动续写的每一轮用全新的过滤器/守卫实例（上一轮的状态在轮次收尾时已吐净），
    // 否则跨请求的行缓冲会让续写内容与 hold 的尾部乱序。
    let filter = new ToolCallStreamFilter(knownNames)
    // 第二道网：模型会模仿 prompt 里的转写格式（`[Tool Result for …]` / `User:` / `Assistant:`…），
    // 把「对话转写」当回答吐出来。这与工具调用标记泄漏是两个独立来源，必须分开防。
    let echoGuard = new TranscriptEchoGuard()
    let systemMarkerFilter = new SystemMarkerStreamFilter()
    // 第四道网：网页端每轮末尾的免责声明（`本回答由 AI 生成…`）不是回答内容，必须剥掉。
    let boilerplate = new BoilerplateFilter()

    let nextIndex = 0
    let textBlock: { index: number; text: string } | null = null
    let textStarted = false
    let reasoningBlock: { index: number; text: string } | null = null
    let reasoningStarted = false
    let toolCallCount = 0
    let finishReason: string | undefined
  // 服务端上报的 token 总量（跨续写轮次累加）。>0 时才信它。
  const usageRounds: {prompt:string; outputChars:number; total?:number}[] = []
    let rejectedProtocol = ''
    let rejectedReason: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' | undefined
    let echoedTranscript = false
    /** 被回声守卫砍掉后半段时追加的告知字符数（从 usage 估算里扣掉，别当成模型的输出）。 */
    let echoNoticeChars = 0
    let systemMarkersStripped = false
    /** 本轮是否剥掉了网页端免责声明（`本回答由 AI 生成…`）。 */
    let disclaimerStripped = false

    const openText = (): { index: number; text: string } => {
      if (!textBlock) textBlock = { index: nextIndex++, text: '' }
      return textBlock
    }
    const openReasoning = (): { index: number; text: string } => {
      if (!reasoningBlock) reasoningBlock = { index: nextIndex++, text: '' }
      return reasoningBlock
    }

    const emitCalls = function* (calls: readonly { id: string; name: string; arguments: string }[]): Generator<any> {
      for (const call of calls) {
        const index = nextIndex++
        toolCallCount += 1
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        }
      }
    }

    try {
      // 图片丢失的告知放在最前面：它是**本次调用的输入状态**，不是回答的一部分，
      // 但界面只有"正文"这一个通道能保证被用户看到（设置页不会自动弹）。
      if (uploaded.notice) {
        const noticeBlock = openText()
        textStarted = true
        yield { type: 'block-start', index: noticeBlock.index, blockType: 'text' }
        noticeBlock.text += uploaded.notice
        yield { type: 'text-delta', index: noticeBlock.index, text: uploaded.notice }
      }
      // ── 自动续写循环 ──
      // 服务端会在句中截断生成（实测：两个窗口共用同一账号时，后来的请求会抢占在生成中的流，
      // 被抢占的流以 FINISHED 收尾）。截断发生时，这里自动发起新请求让模型「接着写」，
      // 并把续写内容无缝拼进同一条回答 —— 等价于用户手动说「继续」，但无需用户参与。
      let rounds = 0
      /** 本步已因「把工具程序写成正文」纠正过一次 —— 只给一次机会，别把请求密度打上去。 */
      let toolCallRetried = false
      let currentPrompt = prompt
      /** 本轮开始前已累计的正文长度（用来量出「这一轮到底吐了多少字」）。 */
      let textLenAtRoundStart = 0
      /** 本轮开始的时刻（用来量出「这一轮到底跑了多久」）。 */
      let roundStartedAt = Date.now()
      for (;;) {
        let roundError: AdapterLlmError | undefined
        const roundUsage: {prompt:string; outputChars:number; total?:number} = {prompt:currentPrompt,outputChars:0}
        usageRounds.push(roundUsage)
        // 每轮重置：finish 标记只反映**本轮**流，累积值会把上一轮的 FINISHED 带进来。
        finishReason = undefined
        textLenAtRoundStart = textBlock?.text?.length ?? 0
        roundStartedAt = Date.now()
        try {
      for await (const event of runStream(auth as WebAuth, {
        prompt: currentPrompt,
        // 链式投喂用：把结构与 prompt 一起传下去，webapi 才能算出"这一轮新增了哪几条"。
        // 漏传 = 链式模式静默退化成全量（有产物断言守着）。
        promptParts: {
          head: promptParts.head,
          entries: promptParts.entries,
          maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
        },
        // 链式投喂的决策回执（0.1.63）→ 一行日志。webapi 只在「原因变化」时回调，
        // 所以不会每轮刷屏，但"哪一轮开始不再发增量、为什么"一定看得见。
        onContextFeed: (report) => {
          logger?.info?.(
            report.reason === 'chained'
              ? `deepseek-web: 上下文投喂=链式：本轮只发增量 ${report.promptChars} 字（历史由服务端维护）`
              : report.reason === 'mode-full'
                ? 'deepseek-web: 上下文投喂=每轮全量：重发完整 prompt'
                : `deepseek-web: 链式投喂退回全量重发（原因=${report.reason}）`,
          )
        },
        thinkingEnabled,
        modelType: spec.modelType,
        refFileIds: rounds === 0 ? refFileIds : [],
        refKeys: rounds === 0 ? uploaded.keys : [],
        signal: options?.signal,
        idleTimeoutMs: deps.config.idleTimeoutMs ?? 120_000,
        // 会话复用：同一账号连续多个回合共用一个网页端会话（见 webapi.ts 的实测判定）
        ...(deps.config.sessionReuseTurns !== undefined ? { sessionReuseTurns: deps.config.sessionReuseTurns } : {}),
        onDeleteSession:
          deps.config.deleteWebSessions === false
            ? undefined
            : (sessionId: string) => {
                // 清理策略由宿主注入（攒批 / 立即 / 不删），缺省退回老行为
                if (deps.sessionCleaner) deps.sessionCleaner.schedule(auth as WebAuth, sessionId)
                else scheduleDeleteSession(auth as WebAuth, sessionId)
              },
      })) {
        if (event.kind === 'thinking' || event.kind === 'text') roundUsage.outputChars += event.text.length
        if (event.kind === 'thinking') {
          const block = openReasoning()
          if (!reasoningStarted) {
            reasoningStarted = true
            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
          }
          block.text += event.text
          yield { type: 'reasoning-delta', index: block.index, text: event.text }
          continue
        }
        if (event.kind === 'text') {
          const out = filter.push(event.text)
          // 第四道网：网页端每轮末尾自动追加的免责声明（不是模型回答）。
          // ⚠️ 必须排在回声守卫**之前**：守卫会扣住「最后一个换行之后」的整行（说明它常在那里），
          // 放到守卫后面就永远看不到被扣住的那行 —— 声明照旧上屏，还会让句中判据每轮误触发。
          const boiled = boilerplate.push(out.text)
          const guarded = echoGuard.push(boiled.text)
          if (guarded.echoed) echoedTranscript = true
          // 第三道网：模型偶尔吐出成串的伪系统标记（<ds_system>…</ds_system> / <system>…</system>），
          // 实测一条消息里出现过 13 个编造调用 ID 的 <ds_system>Tool result…，全是垃圾，必须剥掉
          const cleaned = systemMarkerFilter.push(guarded.text)
          if (cleaned.stripped) {
            systemMarkersStripped = true
            logger?.debug?.('deepseek-web: 已剥离伪系统标记（<ds_system>/<system>）')
          }
          if (cleaned.text) {
            const block = openText()
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += cleaned.text
            yield { type: 'text-delta', index: block.index, text: cleaned.text }
          }
          if (out.calls.length > 0) yield* emitCalls(out.calls)
          continue
        }
        if (event.kind === 'status') {
          logger?.debug?.(`deepseek-web: status=${event.value}`)
          continue
        }
        if (event.kind === 'error') {
          if (isContextTooLong(event.message)) {
            throw new AdapterLlmError(`DeepSeek 网页端上下文超限：${event.message}`, 'CONTEXT_WINDOW_EXCEEDED')
          }
          // webapi 层已按语义归类（并发生成 → RATE_LIMIT + retryAfterMs）：
          // 这类错误交给 dsh-llm-retry 自动重发，而不是让整轮直接失败。
          if (event.code === 'RATE_LIMIT') {
            // 两种 RATE_LIMIT 的成因不同，后缀别串台（曾经把「账号节流」说成「另一个窗口正在生成」）；
            // 但**前缀统一叫「网页版限流」** —— 用户只需要知道"被限了、会自动重试"，
            // 机制解释（登录态其实有效、建会话也正常、每轮工具调用都是一次请求……）留在代码注释里。
            const throttled = event.rateLimitKind === 'throttled'
            throw new AdapterLlmError(
              throttled
                ? '网页版限流：发得太频繁，稍后自动重试'
                : '网页版限流：同一账号同时只能生成一条消息，稍后自动重试',
              'RATE_LIMIT',
              {
                ...(event.retryAfterMs !== undefined ? { providerRetryAfterMs: event.retryAfterMs } : {}),
                ...(throttled ? { rateLimitKind: 'throttled' } : {}),
              },
            )
          }
          throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, 'PROVIDER_ERROR')
        }
        if (event.kind === 'finish') {
          finishReason = event.reason
          if (typeof event.totalTokens === 'number' && Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0) {
            roundUsage.total = event.totalTokens
          }
        }
      }
        } catch (error: any) {
          // 续写轮次失败：保留已上屏的部分并正常收尾（正文已经给用户看到一部分，
          // 此时让整轮失败只会更糟）。仅中止（用户取消）向上抛。
          if (rounds > 0) {
            if (options?.signal?.aborted) throw new AdapterLlmError('deepseek-web 请求被调用方取消', 'ABORTED', { cause: error })
            roundError = error instanceof AdapterLlmError
              ? error
              : new AdapterLlmError(`deepseek-web 自动续写失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
            logger?.warn?.(`deepseek-web: 自动续写第 ${rounds} 轮失败，保留已输出部分：${roundError.message}`)
          } else {
            throw error
          }
        }
        // ── 轮次收尾：把三层缓冲里 hold 的残余吐净（每轮都做，续写才有正确的拼接基准）──
        //
        // ⚠️ 只有「按流水线反序 flush」还不够：过滤器扣住的最后 ≤24 个字符**从没经过**声明剥离
        // 那一层，而免责声明恰好 23 字 —— 实测整段从尾巴漏出去（会话 6c0dbc47：它是一个只有单个
        // delta 的独立 text 块，跟在工具调用后面）。所以轮末统一走 drainTextPipeline：
        // 反序吐净 + 对残余做一次性剥声明 / 剥伪系统标记。
        const drained = drainTextPipeline(filter, boilerplate, echoGuard, false)
        if (drained.echoed) echoedTranscript = true
        if (drained.disclaimers > 0) disclaimerStripped = true
        const markerPending = systemMarkerFilter.push(drained.text)
        const markerEnd = systemMarkerFilter.flush()
        const tailText = markerPending.text + markerEnd.text
        if (markerPending.stripped || markerEnd.stripped) systemMarkersStripped = true
        if (tailText) {
          const block = openText()
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          block.text += tailText
          yield { type: 'text-delta', index: block.index, text: tailText }
        }
        if (drained.calls.length > 0) yield* emitCalls(drained.calls)
        if (drained.rejected) {
          // 协议块解析失败：**绝不**把原始 JSON/标记当正文（Web GUI 会把里面的 `$…$` 渲染成
          // KaTeX 行内公式，用户看到的是「一个字符一行」的乱码，且内容毫无意义）。
          // 只落**元信息**（长度 + 摘要，不落原文，见 dumpRejectedPayload 的说明）；
          // 下面这段截断内容只写进宿主日志、不写盘，方便当场看出"坏在哪一步"。
          dumpRejectedPayload(drained.rejected.raw, drained.rejected.mode, drained.rejected.reason ?? 'unparsable', logger)
          logger?.warn?.(
            `deepseek-web: 工具调用${drained.rejected.mode === 'xml' ? '（XML）' : ''}解析失败` +
              `[${drained.rejected.reason ?? 'unparsable'}]` +
              `，已丢弃 ${drained.rejected.raw.length} 字符（原文不落盘；以下片段仅写入宿主日志）：` +
              drained.rejected.raw.slice(0, 2000),
          )
          // 只有**首轮**的丢弃才触发整步重试；续写轮的丢弃记日志即可
          // （正文已上屏一部分，此时让整轮失败只会更糟）。
          if (rounds === 0) {
            rejectedProtocol = drained.rejected.raw
            rejectedReason = drained.rejected.reason ?? 'unparsable'
          } else {
            // F28：续写轮的丢弃不能全静默 —— 已上屏的正文保留（不整轮重试，原原则不变），
            // 但模型和用户都得知道「这次调用没执行」：否则模型下轮无从重发，
            // 用户只会在网页端看到一段没人处理的乱码（实测 14:29 / 14:52 的 DSML 变体）。
            const notice =
              `\n[deepseek-web] 本次输出的一个工具调用因格式无法解析（${drained.rejected.reason ?? 'unparsable'}）` +
              `被丢弃，该调用未执行；请改用约定的 JSON 格式重发。\n`
            const noticeBlock = openText()
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: noticeBlock.index, blockType: 'text' }
            }
            noticeBlock.text += notice
            yield { type: 'text-delta', index: noticeBlock.index, text: notice }
          }
        }
        // ── 一轮流结束：判断是否需要自动续写 ──
        const partial = textBlock?.text ?? ''
        const roundChars = partial.length - textLenAtRoundStart
        const maxRounds = deps.config.maxContinuations ?? 2
        // 没收到 `response/status: FINISHED` = 流被服务端切断（不是模型自己写完）。
        // 旧版靠这个信号报 max-tokens；现在用它触发续写 —— 否则截在标点/反引号处（判据看不出
        // 「没写完」）就会**静默**少一段，用户只看到回答末尾莫名其妙没了。
        const cutByServer = finishReason === undefined
        const midSentence = looksMidSentence(partial)
        logger?.info?.(
          `deepseek-web: 第 ${rounds + 1} 轮流结束：[本轮 ${roundChars} 字 / 累计 ${partial.length} 字 / ` +
            `耗时 ${Date.now() - roundStartedAt}ms] finish=${finishReason ?? '(无 FINISHED → 服务端截断)'}` +
            `${midSentence ? '，尾部是句中' : ''}` +
            // F27 诊断：正文 0 字而本轮确实有输出时，多半是内容全走了思考通道
            // （模型把回答写进思考 / 通道错位）。留一行显式提示，下次一眼可判。
            // 0.1.70：旧文案把"正文 0 字"一律说成"内容可能全在思考通道"，读日志的人（含另一个
            // 模型窗口）据此把**健康的调工具轮**当成了故障规模（实测把它们算成了 127 次/天）。
            // 工具调用是被工具过滤器从正文流里取走的 ⇒「正文 0 字 + 有工具调用」是正常形态，必须分开说。
            `${roundChars === 0 && rounds === 0 ? (toolCallCount > 0 ? '（本轮正文 0 字，但已提取到工具调用 —— 正常形态）' : '（本轮正文 0 字、且无工具调用 —— 内容可能全在思考通道）') : ''}`,
        )
        const eligible =
          // F26：只对用户可见的回答续写（见 allowsAutoContinue 的说明）。
          // 少了这一条，标题生成会被无尽续写、标题变成重复垃圾。
          allowsAutoContinue(options?.purpose) &&
          roundError === undefined &&
          deps.config.autoContinue !== false &&
          rounds < maxRounds &&
          toolCallCount === 0 &&
          !options?.signal?.aborted &&
          partial.length > 0 &&
          roundChars > 0 &&
          (midSentence || cutByServer)
        // 0.1.74：另一种「这一轮等于什么都没做」的形态 —— 模型把要执行的程序写进了正文
        // （判据见 protocol.ts 的 looksLikeUnexecutedToolProgram，现场见其注释）。
        // 它与续写**互斥**：续写是"话没说完"，这个是"话说完了、但该发的动作没发出去"，
        // 两者要发的指令完全不同，所以走两条分支。
        // 只给一次机会（toolCallRetried）：纠正不成就正常收尾，不把请求密度打上去。
        const unexecutedProgram =
          !eligible &&
          allowsAutoContinue(options?.purpose) &&
          roundError === undefined &&
          deps.config.autoContinue !== false &&
          rounds < maxRounds &&
          toolCallCount === 0 &&
          !toolCallRetried &&
          !options?.signal?.aborted &&
          partial.length > 0 &&
          looksLikeUnexecutedToolProgram(partial)
        if (!eligible && !unexecutedProgram) break
        rounds += 1
        if (unexecutedProgram) toolCallRetried = true
        logger?.info?.(
          unexecutedProgram
            ? `deepseek-web: 本轮把工具程序写进了正文（零工具调用），已要求它改发工具调用（第 ${rounds}/${maxRounds} 轮）……`
            : `deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）……`,
        )
        // 续写/纠正 prompt = 原对话 + 已输出的那一轮（作为 assistant 消息）+ 指令
        promptParts = serializePromptParts({
          system: options?.system,
          messages: [
            ...(options?.messages ?? []),
            { role: 'assistant', content: [{ type: 'text', text: partial }] },
            {
              role: 'user',
              content: [{ type: 'text', text: unexecutedProgram ? TOOL_CALL_RETRY_INSTRUCTION : CONTINUE_INSTRUCTION }],
            },
          ],
          tools: (options?.tools ?? []) as ToolSchemaLike[],
          maxChars: deps.config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
        })
        currentPrompt = promptParts.full
        // 上一轮的过滤器/守卫状态已在上面收尾时吐净；续写用全新实例
        filter = new ToolCallStreamFilter(knownNames)
        echoGuard = new TranscriptEchoGuard()
        systemMarkerFilter = new SystemMarkerStreamFilter()
        boilerplate = new BoilerplateFilter()
      }
    } catch (error: any) {
      if (error instanceof AdapterLlmError) throw error
      if (options?.signal?.aborted) throw new AdapterLlmError('deepseek-web 请求被调用方取消', 'ABORTED', { cause: error })
      throw new AdapterLlmError(`deepseek-web 流失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    // 0.1.71：回声守卫是「从命中行起砍到结尾」—— 所以「有正文 + 本轮有回声」意味着**后半段很可能被砍掉了**。
    // 不能静默：实测 2026-09-16 17:35（1ceshi 会话 e17f4ccf）两次都因此断在「问题项 4」处，
    // 丢的正是问题项 4、5 与结论，而 turn/end 却是 completed、界面上一个字都没有 ——
    // 用户只能以为"它没说完就停了"。这里补一句告知，让他知道是被过滤而不是模型罢工。
    // **不重试也不续写**：正文已有价值；回声意味着模型正在复读历史，续写大概率又是回声。
    if (echoedTranscript && toolCallCount === 0 && textBlock && textBlock.text.length > 0) {
      const echoNotice =
        '\n\n[deepseek-web] 本轮有一部分「历史回放格式」的内容被过滤（未上屏），回答可能因此不完整。\n'
      textBlock.text += echoNotice
      echoNoticeChars = echoNotice.length
      yield { type: 'text-delta', index: textBlock.index, text: echoNotice }
    }

    // 关闭未闭合的块
    if (reasoningBlock) {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    if (textBlock) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }

    const outputChars =
      (textBlock?.text?.length ?? 0) + (reasoningBlock?.text?.length ?? 0) - echoNoticeChars
    let inputTokens = 0, outputTokens = 0
    for (const round of usageRounds) {
      const estimateOutput = Math.ceil(round.outputChars / 3.2)
      if (round.total !== undefined) {
        const output = Math.min(round.total, estimateOutput)
        outputTokens += output
        inputTokens += round.total - output
      } else {
        outputTokens += estimateOutput
        inputTokens += estimateTokens(round.prompt)
      }
    }
    yield { type: 'usage', usage: { inputTokens, outputTokens,
      ...(reasoningBlock ? { reasoningTokens: Math.min(outputTokens, estimateTokens(reasoningBlock.text)) } : {}) } }

    if (toolCallCount > 0) {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }    const hasVisibleText = (textBlock?.text?.length ?? 0) > 0
    if (echoedTranscript) {
      // 已把回声段从可见正文里剔除；这里只留痕，方便事后定位。
      logger?.warn?.('deepseek-web: 模型回声了「对话转写格式」（[Tool Result for …] / User: / Assistant: 等），该段已丢弃、不上屏')
    }
    if (disclaimerStripped) {
      // 网页端在每轮末尾追加的免责声明已经剥掉（它本来会卡在两条回答中间，
      // 而且结尾的「甄别」是汉字 → 会让「句中截断」判据每轮误触发）。
      logger?.info?.('deepseek-web: 已剥离网页端免责声明（本回答由 AI 生成，内容仅供参考，请仔细甄别）')
    }
    if (echoedTranscript && !hasVisibleText && toolCallCount === 0) {
      // 整轮输出就是一段转写回声、没有任何真内容 → 当作空响应重试（与坏掉的调用同一处理）。
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'DeepSeek 网页端把「对话转写格式」当成回答输出了（已丢弃，未上屏），本次没有产生有效内容。',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
      return
    }
    if (rejectedProtocol) {
      // 调用被丢弃 → **必须报可重试错误**，不管有没有正文。
      //
      // ⚠️ 这里曾经分两种处理：无正文 → 报错重试；有正文 → 只补一句提示、然后**当作正常完成**。
      // 结果是一个很隐蔽的故障：模型先写了半句话、再吐出坏掉的调用 JSON，调用被丢弃后
      // 这一轮**没有任何工具调用** → agent loop 判定回合结束 → 用户看到「说半句就停了」，
      // 而且 turn/end 的 reason 是 `completed`，连报错都看不到（实测 2026-09-10 23:27:13，
      // 症状复现多次，用户反复重启也无法恢复）。
      //
      // EMPTY_RESPONSE 在 dsh-llm-retry 默认可重试集合里 → 自动重发这一步；
      // 重试仍失败时用户看到的是下面这句人话，而不是一段渲染成乱码的 JSON 或一次静默停止。
      //
      // 文案按失败原因分档：实测「回声」是最常见的一种，而它其实是**我们主动拒绝**了
      // 一段历史回放，不是故障——用「格式无法解析」来描述会让用户以为程序坏了。
      const reasonText =
        rejectedReason === 'echo'
          ? '网页端本次输出的是一段历史内容回放（不是真要执行调用），已丢弃并自动重试；无需处理。'
          : rejectedReason === 'unbalanced'
            ? '网页端本次输出被截断，调用没收全，已丢弃并自动重试；无需处理。'
            : '网页端本次的调用格式无法解析，已丢弃并自动重试；无需处理。'
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: reasonText, code: 'EMPTY_RESPONSE' },
        },
      }
      return
    }
    // 0.1.70：判据只看**正文**（`hasVisibleText` 在上面已声明）。
    // 旧写法用 `outputChars > 0`，而 `outputChars` 含思考通道 ⇒「思考写了一堆、正文与工具调用
    // 都没有」的轮次会跳过这里、一路落到下面的 stop（＝正常完成）；agent loop 收到"回合干完了、
    // 零个工具调用"就结束回合 —— 用户看到的是"模型莫名停住，只能手动说『继续』"。
    // 实测（2026-09-16）：该形态全局 3/885，但长思考的会话里 2/15；共同成因是**思考不收敛**
    // （实测那一轮思考 11 万字）→ 服务端始终没进入正文阶段 → 流被截断。
    // 报 EMPTY_RESPONSE 会被 dsh-llm-retry 自动重发，比静默停住强。
    // 注：走到这里 toolCallCount 必为 0（上面已对 >0 提前 return）⇒ 不会误伤健康的调工具轮。
    if (!hasVisibleText) {
      const onlyThinking = outputChars > 0
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: onlyThinking
              ? 'DeepSeek 网页端本轮没有正文、也没有工具调用（内容可能全落在思考通道 —— 通常是思考不收敛后被截断），已按可重试错误上报'
              : 'DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）',
            code: 'EMPTY_RESPONSE',
          },
        },
      }
      return
    }
    // 0.1.12：不再报 max-tokens（应用户要求移除「已达到输出 token 上限」提示）。
    // 截断由「自动续写」兜底（绝大多数被无声补全）；续写额度用尽仍被截时，
    // 按正常完成（stop）上报并留痕 —— 用户可手动说「继续」。
    if (textBlock?.text && looksMidSentence(textBlock.text)) {
      if (!allowsAutoContinue(options?.purpose)) {
        // F29：内部用途（标题 / 压缩）的回答天然以汉字收尾 —— 旧版在这里打
        // 「额度已用尽」会让人误判成"标题还在被无尽续写"（实际白名单早就拦住了，
        // 日志里根本没有续写动作行）。按事实分档打日志。
        logger?.info?.(
          `deepseek-web: 内部用途（purpose=${String(options?.purpose)}）的回答以非标点收尾，按约定不自动续写，正常收尾（尾部：${JSON.stringify(textBlock.text.slice(-40))}）`,
        )
      } else {
        logger?.warn?.(
          `deepseek-web: 回答在句中被截且自动续写额度已用尽，按正常完成上报（尾部：${JSON.stringify(textBlock.text.slice(-60))}）`,
        )
      }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  return adapter
}

/** 供 UI 展示的账号摘要。 */
export function describeAuth(auth: WebAuth | undefined): {
  loggedIn: boolean
  display?: string
  capturedAt?: string
  hasCookie: boolean
  hasFingerprint: boolean
  wasmHost?: string
  unverified?: boolean
  tokenLength?: number
  /**
   * cookie 的过期构成（捕获时记下的）。没有记录时为 `undefined`。
   *
   * ⚠️ 展示时务必说清它**不是登录态寿命**：实测真正鉴权用的是 `token`
   * （只发 token 不带 cookie 能通过，只发 cookie 不带 token 直接被拒），
   * 所以这里最晚的到期时间只是"浏览器侧的上界"。
   */
  cookieLife?: CookieLifeSummary
} {
  if (!hasUsableAuth(auth)) return { loggedIn: false, hasCookie: false, hasFingerprint: false }
  let wasmHost: string | undefined
  try {
    wasmHost = auth.wasmUrl ? new URL(auth.wasmUrl).host : undefined
  } catch {
    wasmHost = undefined
  }
  return {
    loggedIn: true,
    ...(auth.user?.display ? { display: maskIdentifier(auth.user.display) } : auth.user?.id ? { display: `id:${maskIdentifier(auth.user.id)}` } : {}),
    ...(auth.capturedAt ? { capturedAt: auth.capturedAt } : {}),
    hasCookie: !!auth.cookie,
    hasFingerprint: !!(auth.hifDliq || auth.hifLeim),
    ...(wasmHost ? { wasmHost } : {}),
    ...(auth.unverified ? { unverified: true } : {}),
    tokenLength: auth.token.length,
    ...(() => {
      const life = summarizeCookieLife(auth.cookieMeta)
      return life ? { cookieLife: life } : {}
    })(),
  }
}
