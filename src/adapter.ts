/**
 * deepseek-web 适配器：把 DSH 的 LLM 调用翻译成 chat.deepseek.com 网页端对话。
 *
 * 与官方 dsh-llm-deepseek 的差异（受限于网页端能力）：
 *  - 网页接口只吃单段 `prompt` 字符串 → 由 protocol.ts 序列化整段转写
 *  - 无原生 function calling → 提示词 JSON 协议 + 流式解析（protocol.ts）
 *  - 无 temperature / stop / max_tokens 字段 → 忽略（不报错）
 *  - 每次调用新建 chat_session 并在结束后删除（保持无状态 + 不污染网页端列表）
 */
import { AdapterLlmError, httpErrorCode, maskIdentifier, readAuth, hasUsableAuth, type WebAuth } from './auth.ts'
import { scheduleDeleteSession, streamWebCompletion, uploadImageFile } from './webapi.ts'
import { collectImageRefs, serializePrompt, ToolCallStreamFilter, type ToolSchemaLike } from './protocol.ts'

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
 * 容量：服务器声明 `normal_history_and_file_token_limit = 890880`
 * （1M 总量扣除输出预留后的可用预算）、单请求 `input_character_limit = 2621440` 字符。
 * 因此 contextWindow 取 890880，送出的 prompt 字符上限由 maxPromptChars 控制。
 */
export const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek 网页 · 快速模式（不思考）',
    description: '同一模型，thinking 关闭：直接作答、最快、最省免费额度。适合工具调用/改写/检索类任务',
    modelType: 'default',
    thinking: false,
    configurableThinking: true,
    contextWindow: 890_880,
    maxOutputTokens: 16_384,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek 网页 · 快速模式（深度思考）',
    description: '同一模型，thinking 开启：先推理再作答（推理流作为思考块回传）。适合数学/多步调试/规划，更慢也更耗额度',
    modelType: 'default',
    thinking: true,
    configurableThinking: true,
    contextWindow: 890_880,
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
  /** prompt 字符上限（超出走中段截断）。 */
  maxPromptChars?: number
  /** SSE 空闲超时（毫秒）。 */
  idleTimeoutMs?: number
  /** 是否在调用结束后删除网页端会话（默认 true）。 */
  deleteWebSessions?: boolean
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
 * 网页端 finish 归一。
 * 实测：正常完成必定带 `response/status: FINISHED`；若流在没有该标记的情况下结束，
 * 说明被服务端上限打断（`completion_request_timeout_ms = 60000`，网页端靠
 * sse_auto_resume 续接，本适配器不实现续接）→ 报 max-tokens 而不是假装 stop，
 * 让上层知道回答被截断。
 */
function mapFinish(reason: string | undefined): { kind: 'stop' } | { kind: 'max-tokens' } {
  if (reason === undefined) return { kind: 'max-tokens' }
  const text = String(reason).toUpperCase()
  if (text.includes('LENGTH') || text.includes('MAX_TOKEN')) return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** 构造 deepseek-web 适配器（鸭子类型满足 LlmAdapter 契约，无需继承）。 */
export function createAdapter(deps: AdapterDeps) {
  const logger = deps.config.logger

  const adapter = {
    providerInfo(provider: string) {
      return { id: provider, name: 'DeepSeek 网页版（免费）' }
    },

    /** 未配置策略 → 走 dsh-llm 默认重试码表（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）。 */
    providerRetryPolicy(_provider: string) {
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
        stream: (options: any) => streamImpl(options),
      })
    },

    stream(options: any): AsyncGenerator<any> {
      return streamImpl(options)
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
      maxChars: deps.config.maxPromptChars ?? 1_200_000,
    })

    const knownNames = new Set<string>((options?.tools ?? []).map((tool: any) => String(tool?.name ?? '')))
    const filter = new ToolCallStreamFilter(knownNames)

    let nextIndex = 0
    let textBlock: { index: number; text: string } | null = null
    let textStarted = false
    let reasoningBlock: { index: number; text: string } | null = null
    let reasoningStarted = false
    let toolCallCount = 0
    let finishReason: string | undefined

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
      for await (const event of streamWebCompletion(auth as WebAuth, {
        prompt,
        thinkingEnabled,
        modelType: spec.modelType,
        refFileIds,
        signal: options?.signal,
        idleTimeoutMs: deps.config.idleTimeoutMs ?? 120_000,
        onDeleteSession: deps.config.deleteWebSessions === false ? undefined : (sessionId: string) => {
          scheduleDeleteSession(auth as WebAuth, sessionId)
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
          if (out.text) {
            const block = openText()
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += out.text
            yield { type: 'text-delta', index: block.index, text: out.text }
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
          throw new AdapterLlmError(`DeepSeek 网页端返回错误：${event.message}`, 'PROVIDER_ERROR')
        }
        if (event.kind === 'finish') {
          finishReason = event.reason
        }
      }

      // 流尾：把过滤器里 hold-back / 未配平的残余吐出来
      const tail = filter.flush()
      if (tail.text) {
        const block = openText()
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += tail.text
        yield { type: 'text-delta', index: block.index, text: tail.text }
      }
      if (tail.calls.length > 0) yield* emitCalls(tail.calls)
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
    yield { type: 'finish', reason: mapFinish(finishReason) }
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
