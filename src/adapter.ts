/**
 * deepseek-web 适配器：把 DSH 的 LLM 调用翻译成 chat.deepseek.com 网页端对话。
 *
 * 与官方 dsh-llm-deepseek 的差异（受限于网页端能力）：
 *  - 网页接口只吃单段 `prompt` 字符串 → 由 protocol.ts 序列化整段转写
 *  - 无原生 function calling → 提示词 JSON 协议 + 流式解析（protocol.ts）
 *  - 无 temperature / stop / max_tokens 字段 → 忽略（不报错）
 *  - 每次调用新建 chat_session 并在结束后删除（保持无状态 + 不污染网页端列表）
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { AdapterLlmError, httpErrorCode, maskIdentifier, readAuth, hasUsableAuth, type WebAuth } from './auth.ts'
import { createRequestGate, DEFAULT_MIN_REQUEST_INTERVAL_MS, type RequestGate } from './gate.ts'
import {
  scheduleDeleteSession,
  streamWebCompletion,
  uploadImageFile,
  type SessionCleaner,
} from './webapi.ts'
import { collectImageRefs, serializePrompt, stripSystemMarkers, BoilerplateFilter, drainTextPipeline, ToolCallStreamFilter, TranscriptEchoGuard, type ToolSchemaLike } from './protocol.ts'

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
function dumpRejectedPayload(raw: string, mode: string, reason: string | undefined, logger?: any): void {
  try {
    const dir = joinPath(homedir(), '.dsh', 'deepseek-web')
    mkdirSync(dir, { recursive: true })
    const file = joinPath(dir, 'rejected.jsonl')
    try {
      if (statSync(file).size > 4_000_000) writeFileSync(file, '')
    } catch {
      /* 首次写入或读大小失败都无所谓 */
    }
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), mode, reason, length: raw.length, raw })}\n`,
      'utf8',
    )
  } catch (error: any) {
    logger?.debug?.(`deepseek-web: 落盘被丢弃载荷失败：${error?.message ?? error}`)
  }
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
  /** 注入自定义流函数（单测用假流验证自动续写）；缺省用 streamWebCompletion。 */
  streamCompletion?: (auth: WebAuth, params: any) => AsyncGenerator<any>
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

function resolvedModelInfo(provider: string, spec: ModelSpec, requestedId?: string) {
  return {
    ...modelInfoFor(provider, spec, requestedId),
    context: { contextWindow: spec.contextWindow },
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
 * 启发式：正文是否「在句中被截」。
 * 判据（尾部最后一个非空白字符）：
 *  - 是 CJK 汉字/字母/数字（没有任何标点收尾）→ 大概率被截；
 *  - 是 markdown 强调标记（`**` / `__`）→ 被截在标记中间；
 *  - 是逗号/顿号/冒号/开引号/开括号 → 明显未完。
 *  正常结束的正文几乎总以句号/问号/感叹号/右引号/右括号/代码块收尾/表格行结尾出现。
 */
function looksMidSentence(text: string): boolean {
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return false
  const last = trimmed[trimmed.length - 1]
  if ('。，？！；：,?!;:…）】》」』"\'`*_#~'.includes(last)) {
    // 标点收尾 → 但 `` ` `` 和 `*` `_` `#` `~` 可能是 markdown 标记被截，单独判
    if (last === '*' || last === '_' || last === '#' || last === '~' || last === '`') {
      // `**` 结尾 = 粗体标记没闭合 → 被截
      return trimmed.endsWith('**') || trimmed.endsWith('__')
    }
    // 逗号/冒号/分号 → 未完
    return '，：,;：：'.includes(last) || last === '，' || last === ',' || last === ':' || last === '：' || last === ';'
  }
  // 字母/数字/汉字/其他非标点字符收尾 → 大概率被截
  return /[a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/.test(last)
}

/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
export function createAdapter(deps: AdapterDeps) {
  const logger = deps.config.logger
  // 流函数可注入（单测用假流验证自动续写）；缺省走真实网页端实现
  const runStream = deps.streamCompletion ?? streamWebCompletion

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
      return Promise.resolve(resolvedModelInfo(provider, resolveSpec(model), String(model ?? '')))
    },

    /**
     * 运行时契约（dsh-llm 0.1.2-rc.1）：dispatch 前先取「精确模型元数据 + 该次调用的 stream」。
     * 返回的 stream 接收运行时补齐后的 options。
     */
    prepareCall(provider: string, model: string, _signal?: AbortSignal) {
      const spec = resolveSpec(model)
      return Promise.resolve({
        model: resolvedModelInfo(provider, spec, String(model ?? '')),
        stream: (options: any) => gatedStream(options),
      })
    },

    stream(options: any): AsyncGenerator<any> {
      return gatedStream(options)
    },
  }

  /** 上传缓存：attachmentId → fileId（内容寻址，跨轮次复用，避免重复上传同一张图）。 */
  const uploadCache = new Map<string, { fileId: string; at: number }>()
  const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000

  /**
   * 把请求里出现的图片全部上传到网页端并返回 file_id 列表。
   * 失败不致命：记日志后跳过该图（prompt 里仍有 [image attached] 标记，模型会知道有图但看不到）。
   */
  async function uploadRequestImages(auth: WebAuth, messages: readonly any[] | undefined, signal?: AbortSignal): Promise<string[]> {
    const refs = collectImageRefs(messages)
    if (refs.length === 0) return []
    if (!deps.readImage) {
      logger?.warn?.('deepseek-web: 收到图片但附件服务不可用（ctx.attachments），图片被忽略')
      return []
    }
    const ids: string[] = []
    const now = Date.now()
    for (const ref of refs) {
      const key = String(ref?.attachmentId ?? '')
      if (!key) continue
      const cached = uploadCache.get(key)
      if (cached && now - cached.at < UPLOAD_TTL_MS) {
        ids.push(cached.fileId)
        continue
      }
      try {
        const stored = await deps.readImage(ref, signal)
        const uploaded = await uploadImageFile(
          auth,
          {
            data: stored.data,
            mediaType: stored.mediaType || String(ref.mediaType ?? 'image/png'),
            ...(stored.name || ref.name ? { name: String(stored.name ?? ref.name) } : {}),
          },
          signal,
        )
        uploadCache.set(key, { fileId: uploaded.fileId, at: Date.now() })
        ids.push(uploaded.fileId)
      } catch (error: any) {
        logger?.warn?.(`deepseek-web: 图片上传失败（已降级为纯文本）：${error?.message ?? error}`)
      }
    }
    return ids
  }

  /**
   * streamImpl 的闸门外壳：拿到许可后才真正开始请求，流结束（含被中断/抛错）才释放。
   *
   * ⚠️ 许可在 generator 体**内部**获取 —— 只有真正开始迭代（第一次 next()）才占位，
   * 消费者拿了 generator 却没迭代时不会泄漏名额；流被 abort 时 finally 一定会释放。
   */
  async function* gatedStream(options: any): AsyncGenerator<any> {
    const purpose = typeof options?.purpose === 'string' && options.purpose ? options.purpose : 'chat'
    const release = await gate.acquire(purpose)
    try {
      yield* streamImpl(options)
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
    const spec = resolveSpec(String(options?.model ?? ''))
    const { thinkingEnabled } = resolveThinking(options, spec)

    // 图片：读取附件 → 上传到网页端 → 用 file_id 随请求引用（网页端看图的实际机制）
    const refFileIds = await uploadRequestImages(auth, options?.messages, options?.signal)

    const prompt = serializePrompt({
      system: options?.system,
      messages: options?.messages ?? [],
      tools: (options?.tools ?? []) as ToolSchemaLike[],
      maxChars: deps.config.maxPromptChars ?? 1_500_000,
    })

    const knownNames = new Set<string>((options?.tools ?? []).map((tool: any) => String(tool?.name ?? '')))
    // 自动续写的每一轮用全新的过滤器/守卫实例（上一轮的状态在轮次收尾时已吐净），
    // 否则跨请求的行缓冲会让续写内容与 hold 的尾部乱序。
    let filter = new ToolCallStreamFilter(knownNames)
    // 第二道网：模型会模仿 prompt 里的转写格式（`[Tool Result for …]` / `User:` / `Assistant:`…），
    // 把「对话转写」当回答吐出来。这与工具调用标记泄漏是两个独立来源，必须分开防。
    let echoGuard = new TranscriptEchoGuard()
    // 第四道网：网页端每轮末尾的免责声明（`本回答由 AI 生成…`）不是回答内容，必须剥掉。
    let boilerplate = new BoilerplateFilter()

    let nextIndex = 0
    let textBlock: { index: number; text: string } | null = null
    let textStarted = false
    let reasoningBlock: { index: number; text: string } | null = null
    let reasoningStarted = false
    let toolCallCount = 0
    let finishReason: string | undefined
    let rejectedProtocol = ''
    let rejectedReason: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' | undefined
    let echoedTranscript = false
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
      // ── 自动续写循环 ──
      // 服务端会在句中截断生成（实测：两个窗口共用同一账号时，后来的请求会抢占在生成中的流，
      // 被抢占的流以 FINISHED 收尾）。截断发生时，这里自动发起新请求让模型「接着写」，
      // 并把续写内容无缝拼进同一条回答 —— 等价于用户手动说「继续」，但无需用户参与。
      let rounds = 0
      let currentPrompt = prompt
      /** 本轮开始前已累计的正文长度（用来量出「这一轮到底吐了多少字」）。 */
      let textLenAtRoundStart = 0
      /** 本轮开始的时刻（用来量出「这一轮到底跑了多久」）。 */
      let roundStartedAt = Date.now()
      for (;;) {
        let roundError: AdapterLlmError | undefined
        // 每轮重置：finish 标记只反映**本轮**流，累积值会把上一轮的 FINISHED 带进来。
        finishReason = undefined
        textLenAtRoundStart = textBlock?.text?.length ?? 0
        roundStartedAt = Date.now()
        try {
      for await (const event of runStream(auth as WebAuth, {
        prompt: currentPrompt,
        thinkingEnabled,
        modelType: spec.modelType,
        refFileIds: rounds === 0 ? refFileIds : [],
        signal: options?.signal,
        idleTimeoutMs: deps.config.idleTimeoutMs ?? 120_000,
        onDeleteSession:
          deps.config.deleteWebSessions === false
            ? undefined
            : (sessionId: string) => {
                // 清理策略由宿主注入（攒批 / 立即 / 不删），缺省退回老行为
                if (deps.sessionCleaner) deps.sessionCleaner.schedule(auth as WebAuth, sessionId)
                else scheduleDeleteSession(auth as WebAuth, sessionId)
              },
      })) {
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
          const cleaned = stripSystemMarkers(guarded.text)
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
            // 两种 RATE_LIMIT 的成因完全不同，文案别串台（曾经把「账号节流」说成「另一个窗口正在生成」）
            const throttled = event.rateLimitKind === 'throttled'
            throw new AdapterLlmError(
              throttled
                ? `DeepSeek 网页端对这个账号限流了（发得太频繁）。这不是封号：登录态有效、建会话也正常，只有发消息被拒。这一步会自动退避重试；若一直不过，请等几分钟再继续，或降低自动化步骤密度（每一轮工具调用都是一次网页端请求）。`
                : `DeepSeek 网页端同一账号同时只能生成一条消息（另一个窗口/标签页正在用同一账号生成）。这一步会自动重试；若两个窗口都要用网页模型，建议其中一个换 provider 或换账号。`,
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
        const drained = drainTextPipeline(filter, boilerplate, echoGuard)
        if (drained.echoed) echoedTranscript = true
        if (drained.disclaimers > 0) disclaimerStripped = true
        const tailText = drained.text
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
          // 完整载荷落盘：日志的 400 字符截断看不到后半段的坏点（见 dumpRejectedPayload 说明）
          dumpRejectedPayload(drained.rejected.raw, drained.rejected.mode, drained.rejected.reason ?? 'unparsable', logger)
          logger?.warn?.(
            `deepseek-web: 工具调用${drained.rejected.mode === 'xml' ? '（XML）' : ''}解析失败` +
              `[${drained.rejected.reason ?? 'unparsable'}]` +
              `，已丢弃 ${drained.rejected.raw.length} 字符（完整原文见 ~/.dsh/deepseek-web/rejected.jsonl）：` +
              drained.rejected.raw.slice(0, 2000),
          )
          // 只有**首轮**的丢弃才触发整步重试；续写轮的丢弃记日志即可
          // （正文已上屏一部分，此时让整轮失败只会更糟）。
          if (rounds === 0) {
            rejectedProtocol = drained.rejected.raw
            rejectedReason = drained.rejected.reason ?? 'unparsable'
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
            `${midSentence ? '，尾部是句中' : ''}`,
        )
        const eligible =
          roundError === undefined &&
          deps.config.autoContinue !== false &&
          rounds < maxRounds &&
          toolCallCount === 0 &&
          !options?.signal?.aborted &&
          partial.length > 0 &&
          roundChars > 0 &&
          (midSentence || cutByServer)
        if (!eligible) break
        rounds += 1
        logger?.info?.(`deepseek-web: 回答疑似在句中被截，自动续写（第 ${rounds}/${maxRounds} 轮）……`)
        // 续写 prompt = 原对话 + 已输出的半截回答（作为 assistant 消息）+ 继续指令
        currentPrompt = serializePrompt({
          system: options?.system,
          messages: [
            ...(options?.messages ?? []),
            { role: 'assistant', content: [{ type: 'text', text: partial }] },
            { role: 'user', content: [{ type: 'text', text: CONTINUE_INSTRUCTION }] },
          ],
          tools: (options?.tools ?? []) as ToolSchemaLike[],
          maxChars: deps.config.maxPromptChars ?? 1_500_000,
        })
        // 上一轮的过滤器/守卫状态已在上面收尾时吐净；续写用全新实例
        filter = new ToolCallStreamFilter(knownNames)
        echoGuard = new TranscriptEchoGuard()
        boilerplate = new BoilerplateFilter()
      }
    } catch (error: any) {
      if (error instanceof AdapterLlmError) throw error
      if (options?.signal?.aborted) throw new AdapterLlmError('deepseek-web 请求被调用方取消', 'ABORTED', { cause: error })
      throw new AdapterLlmError(`deepseek-web 流失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    // 关闭未闭合的块
    if (reasoningBlock) {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    if (textBlock) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }

    const outputChars = (textBlock?.text?.length ?? 0) + (reasoningBlock?.text?.length ?? 0)
    yield {
      type: 'usage',
      usage: {
        inputTokens: estimateTokens(prompt),
        outputTokens: Math.ceil(outputChars / 3.2),
        ...(reasoningBlock ? { reasoningTokens: estimateTokens(reasoningBlock.text) } : {}),
      },
    }

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
    const hasVisible = outputChars > 0
    if (!hasVisible) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'DeepSeek 网页端返回了空响应（可能触发频控或长上下文截断）', code: 'EMPTY_RESPONSE' },
        },
      }
      return
    }
    // 0.1.12：不再报 max-tokens（应用户要求移除「已达到输出 token 上限」提示）。
    // 截断由「自动续写」兜底（绝大多数被无声补全）；续写额度用尽仍被截时，
    // 按正常完成（stop）上报并留痕 —— 用户可手动说「继续」。
    if (looksMidSentence(textBlock?.text ?? '')) {
      logger?.warn?.(
        `deepseek-web: 回答在句中被截且自动续写额度已用尽，按正常完成上报（尾部：${JSON.stringify((textBlock?.text ?? '').slice(-60))}）`,
      )
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
  }
}
