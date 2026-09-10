/**
 * 提示词协议层：
 *  1) 把 DSH 的消息词汇（system / user / assistant / tool-result / reasoning / tool-call）
 *     序列化成网页端可吃的单段 prompt（网页 API 只有 `prompt` 字符串，无 tools 字段）。
 *  2) 工具调用桥：网页模型没有原生 function calling，改用「JSON 协议 + 流式解析」——
 *     指令要求模型只输出 {"tool_calls":[{"name":…,"arguments":{…}}]}，
 *     本模块在流式文本上做 hold-back 扫描，命中即转成 tool-call 块，不命中则原样透传正文。
 */
import { randomUUID } from 'node:crypto'

export interface ToolSchemaLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCallRequest {
  id: string
  name: string
  /** 原始 JSON 字符串（DSH ToolCallBlock.arguments 语义）。 */
  arguments: string
}

/** 单次 push/flush 的产出。 */
export interface FilterOutput {
  text: string
  calls: ToolCallRequest[]
  /**
   * 捕获到的协议块**无法解析**（raw = 原文，mode = 标记家族）。
   * ⚠️ 这个字段的意义：绝不再把这种残留当正文吐出去 —— 它既不是模型想说的话，
   * 又会被 Web GUI 的 markdown 渲染器当成垃圾（实测 2026-09：泄漏文本里的
   * `$ErrorActionPreference='…'` 被渲染成 KaTeX 行内公式 → 用户看到「一个字符一行 +
   * 弯引号」的乱码）。调用方据此决定「重试」或「给一句人话提示」。
   */
  rejected?: { raw: string; mode: 'json' | 'xml' }
}

const MAX_DESCRIPTION_CHARS = 400
const MAX_TOOLS_SECTION_CHARS = 24_000
const HOLD_BACK_CHARS = 24
const MAX_CAPTURE_CHARS = 256 * 1024

/** 工具调用协议指令（固定文本，进 prompt 前缀，保持前缀缓存友好）。 */
export const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output ONLY a single JSON object, with no other text before or after it:

{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after that JSON object. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
6. Do NOT use XML/HTML-like markup such as <tool_calls>, <invoke>, <parameter>, <|DSML|>, or any fenced variant of them. The JSON object above is the ONLY accepted format; markup text would be shown to the user as broken output instead of running the tool.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).`

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

/** 渲染工具目录（含 JSON Schema）。 */
export function buildToolSection(tools: readonly ToolSchemaLike[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  const parts: string[] = ['', '## Available tools']
  let budget = MAX_TOOLS_SECTION_CHARS
  for (const tool of tools) {
    let schemaText = ''
    try {
      schemaText = JSON.stringify(tool.parameters ?? {})
    } catch {
      schemaText = '{}'
    }
    const block = [
      '',
      `### ${tool.name}`,
      truncate(String(tool.description ?? '').replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION_CHARS),
      `Parameters (JSON Schema): ${schemaText}`,
    ].join('\n')
    if (budget - block.length < 0) {
      parts.push('\n(remaining tools omitted for length)')
      break
    }
    budget -= block.length
    parts.push(block)
  }
  return parts.join('\n')
}

function flattenText(blocks: readonly any[] | undefined, out: string[] = []): string[] {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) flattenText(block.content, out)
  }
  return out
}

function countImages(blocks: readonly any[] | undefined): number {
  let count = 0
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') count += 1
    else if (block.type === 'tool-result' && Array.isArray(block.content)) count += countImages(block.content)
  }
  return count
}

/** 按出现顺序收集消息里的图片附件引用（含 tool-result 内嵌图片）。 */
export function collectImageRefs(messages: readonly any[] | undefined): any[] {
  const refs: any[] = []
  const walk = (blocks: readonly any[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment) refs.push(block.attachment)
      else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content)
    }
  }
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    walk(Array.isArray(message.content) ? message.content : undefined)
  }
  return refs
}

/** 把一条 assistant 消息里的 tool-call 块渲染回协议 JSON（供历史学习格式）。 */
function renderToolCalls(blocks: readonly any[]): string | null {
  const calls = (blocks ?? []).filter((block) => block?.type === 'tool-call')
  if (calls.length === 0) return null
  const payload = {
    tool_calls: calls.map((call) => {
      let args: unknown = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        args = { _raw: String(call.arguments ?? '') }
      }
      return { name: String(call.name ?? ''), arguments: args }
    }),
  }
  return JSON.stringify(payload)
}

/** 中间截断：保留开头（任务/协议）与结尾（最近回合），并把省略标记计入预算。 */
function truncateMiddle(text: string, maxChars: number, tailRatio = 0.7): string {
  if (text.length <= maxChars) return text
  const RESERVE = 64 // 标记串预留（"...[N chars omitted]..." 远小于此）
  const budget = Math.max(0, maxChars - RESERVE)
  const tail = Math.floor(budget * tailRatio)
  const head = Math.max(0, budget - tail)
  const dropped = text.length - head - tail
  const marker = `\n\n...[${dropped} chars omitted]...\n\n`
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

export interface SerializeOptions {
  system?: string
  messages: readonly any[]
  tools?: readonly ToolSchemaLike[]
  maxChars?: number
}

/**
 * 序列化为网页端单段 prompt。
 * 结构：system → 工具协议与目录 → 对话转写（User:/Assistant:/[Tool Result]）。
 */
export function serializePrompt(options: SerializeOptions): string {
  const maxChars = options.maxChars ?? 120_000
  const system = String(options.system ?? '').trim()
  const toolSection = buildToolSection(options.tools)
  const protocol = toolSection ? `\n\n${TOOL_PROTOCOL_INSTRUCTIONS}${toolSection}` : ''

  const lines: string[] = []
  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const blocks: any[] = Array.isArray(message.content) ? message.content : []
    if (message.role === 'system') {
      const text = flattenText(blocks).join('')
      if (text.trim()) lines.push(`[System]\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(blocks).join('')
      const renderedCalls = renderToolCalls(blocks)
      if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`)
      else if (text.trim()) lines.push(`Assistant: ${text}`)
      continue
    }
    // user 角色：可能是纯文本，也可能携带 tool-result 块
    const toolResults = blocks.filter((block) => block?.type === 'tool-result')
    const text = flattenText(blocks.filter((block) => block?.type !== 'tool-result')).join('')
    const images = countImages(blocks)
    if (text.trim() || (toolResults.length === 0 && images === 0) || images > 0) {
      // 图片本体由调用方上传后经 ref_file_ids 附在请求上；这里只放可定位的占位标记，
      // 让模型知道「图几」对应哪条消息（顺序与 uploadedImages 收集顺序一致）。
      const imageNote = images > 0 ? `\n${Array.from({ length: images }, () => '[image attached]').join(' ')}` : ''
      lines.push(`User: ${text}${imageNote}`)
    }
    for (const result of toolResults) {
      const body = flattenText(result.content).join('') || '(no output)'
      const errorMark = result.isError ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? '')}]\n${body}`)
    }
  }

  const transcript = lines.join('\n\n')
  const head = system ? `${system}${protocol}` : protocol.trim()
  const merged = transcript ? `${head}\n\n---\n\n${transcript}` : head

  if (merged.length <= maxChars) return merged
  // 超长：system+协议单独限预算，转写中段截断
  const headBudget = Math.min(head.length, Math.floor(maxChars * 0.45))
  const boundedHead = head.length <= headBudget ? head : truncateMiddle(head, headBudget, 0.85)
  const transcriptBudget = Math.max(1_000, maxChars - boundedHead.length - 8)
  const boundedTranscript = truncateMiddle(transcript, transcriptBudget, 0.7)
  return `${boundedHead}\n\n---\n\n${boundedTranscript}`
}

// ── 流式工具调用过滤器 ────────────────────────────────────

/** 完整 JSON 调用标记：{"tool_calls": 或 {"tool_call": （允许空白）。 */
const MARKER_RE = /\{\s*"tool_calls?"\s*:/
/**
 * XML 风格调用标记（实测：思考模式下模型偶尔改用这套标记，形如
 * `<tool_calls><invoke name="read"><parameter name="file_path">…</parameter></invoke></tool_calls>`；
 * 亦兼容 DeepSeek 自家的 `|DSML|` 前缀与 `dsml-` 连字符变体）。
 */
const XML_STARTER_RE = /<(?:\|\s*DSML\s*\|)?(?:dsml-)?(tool_calls|function_calls|invoke)\b/i
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/

/** 归一化 DSML 噪声：`<|DSML|invoke>` / `</|DSML|invoke>` / `<｜DSML｜>` / `<dsml-invoke>` → 标准标签。 */
function normalizeDsml(text: string): string {
  return text
    // 开标签与前缀：<|DSML|invoke / <｜DSML｜>invoke / </|DSML|invoke
    .replace(/<(\/?)\s*[|｜]\s*DSML\s*[|｜]\s*(?=[a-zA-Z_])/gi, '<$1')
    .replace(/<\s*dsml-/gi, '<')
    .replace(/<\/\s*dsml-/gi, '</')
}

/**
 * JSON 调用标记前缀（用于跨包 hold-back 判断）。
 * ⚠️ 2026-09 事故：真实分块会把标记切成 `{"tool` + `_calls":[{"name":…` 两半。
 * 旧实现比较时多拼了一个引号（`{'{"' + body}`，而 body 已含前引号 → `{""tool`），
 * 于是「末尾是潜在前缀」永远判 false → 半截标记被当正文吐出去、后半个再也拼不回完整标记
 * → 整个 JSON 泄漏成正文。修复见 partialMarkerSuffixLength。
 */
const JSON_MARKER_STARTERS = ['{"tool_calls"', '{"tool_call"']

/** XML 标记前缀（用于跨包 hold-back 判断）。 */
const XML_MARKER_STARTERS = ['<tool_calls', '<tool_call', '<function_calls', '<invoke', '<|dsml|tool_calls', '<|dsml|invoke', '<dsml-tool_calls', '<dsml-invoke']

/**
 * 判断 text 末尾是否是（可能的）标记前缀 —— 决定是否 hold back。
 * @returns 需要保留在缓冲区里的尾部字符数（0 = 无需保留）
 */
function partialMarkerSuffixLength(text: string): number {
  const LIMIT = 32
  const from = Math.max(0, text.length - LIMIT)
  const raw = text.slice(from)
  // 候选起点：最后一个 `{` 或 `<`（在**原始**切片上定位，保证 held 长度与原文对齐）
  const braceAt = raw.lastIndexOf('{')
  const angleAt = raw.lastIndexOf('<')
  const startAt = Math.max(braceAt, angleAt)
  if (startAt === -1) return 0
  const held = raw.length - startAt
  const normalized = normalizeDsml(raw.slice(startAt))

  if (normalized.startsWith('{')) {
    if (MARKER_RE.test(normalized)) return 0 // 已是完整标记，交给捕获逻辑
    const body = normalized.replace(/^\{\s*/, '').replace(/\s+/g, '')
    // body 已含前引号（如 `"tool`）→ 与 starter 比较时应拼 `{` + body
    const ok = JSON_MARKER_STARTERS.some((starter) => starter.startsWith(`{${body}`))
    return ok ? held : 0
  }
  if (normalized.startsWith('<')) {
    if (XML_STARTER_RE.test(normalized)) return 0 // 已是完整标记
    const lower = normalized.toLowerCase().replace(/\s+/g, '')
    const ok = XML_MARKER_STARTERS.some((starter) => starter.startsWith(lower))
    return ok ? held : 0
  }
  return 0
}

/** 从 index 0 起抽取一个配平的 JSON 对象；不完整返回 null。 */
export function extractBalancedJson(text: string): { json: string; end: number } | null {
  if (text[0] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { json: text.slice(0, i + 1), end: i + 1 }
    }
  }
  return null
}

/** 读取一个 XML 属性值（支持双引号/单引号/裸值）。 */
function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i')
  const match = re.exec(attrs)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3]
}

/**
 * 宽容 JSON 解析。实测场景：模型把 Windows 路径写成 `"D:\apps\DSH"`（单个反斜杠，
 * 非法转义），JSON.parse 直接抛错 → 工具调用解析失败、整段标记被当正文吐给用户。
 * 先试原样；失败则修补：非法转义补成字面反斜杠、字符串内裸换行转义、去尾逗号。
 */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  for (const candidate of jsonRepairCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== undefined) return parsed
    } catch {}
  }
  return undefined
}

/**
 * 依次尝试的修复候选（只在原样解析失败时使用）。顺序有讲究：
 *
 * 先跑「路径尾反斜杠」启发式（`"…\app.asar\"` 里的 `\"` 是转义引号 → 字符串不终止，
 * 必须在切分字符串**之前**修，否则整个字符串范围都会错），再跑字符串级修复。
 *
 * 字符串级修复的智能规则：若某字符串里出现**非法转义**（如 `\A`），说明模型是「原样写出」
 * 未转义的反斜杠 —— 此时该字符串内所有反斜杠都按字面处理，否则 `\resources` 里的 `\r`
 * 会被 JSON 当成回车，路径被悄悄改坏（实测用户样本 #2）。
 * 若字符串里没有非法转义，则只做保守修补（保留 `\\`、`\"` 等合法转义）。
 */
export function* jsonRepairCandidates(text: string): Generator<string> {
  const pathTail = (value: string): string => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, '$1\\\\"')
  // 先跑转义修复（便宜、覆盖两个实测样本）；再跑结构性修复（少写闭合括号）。
  for (const base of [text, ...structuralRepairCandidates(text)]) {
    yield repairJsonText(pathTail(base), { mode: 'smart' })
    yield repairJsonText(base, { mode: 'smart' })
    yield repairJsonText(pathTail(base), { mode: 'conservative' })
    yield repairJsonText(base, { mode: 'conservative' })
  }
}

/**
 * 结构性修复候选：模型偶尔**漏写调用对象的闭合括号**。
 *
 * 实测（2026-09，deepseek-reasoner 一次批量 3 个调用）：每个 tool_call 都少写一个 `}`
 * （只闭合了 `arguments`，没闭合调用对象自己）。JSON.parse 报
 * `Expected double-quoted property name`，于是整段调用被降级成正文 → 泄漏。
 *
 * 做法：按元素边界切开 `tool_calls` 数组，给每个元素补齐它自身缺的 `}`。
 * 边界判定不能靠「嵌套深度回到 0」—— 恰恰因为元素没闭合，深度回不到 0；
 * 只能靠形状：逗号后紧跟 `{"name":`。
 * **只补括号，绝不改写内容**（不猜测引号语义，避免把命令改坏）。
 *
 * ⚠️ **安全闸门**：只修补「数组已经闭合」（以 `]` 收尾）的文本 —— 那是模型**写完了**的信号
 * （实测样本以 `]}` 收尾）。若连 `]` 都没有，多半是流被服务端 60s 上限截断/中断，
 * 此时补括号会得到一条**被截断的命令**并真的执行它；宁可拒绝（→ 重试），也不执行半条命令。
 */
export function* structuralRepairCandidates(text: string): Generator<string> {
  const marker = /^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text)
  if (!marker) return
  const scanned = splitToolCallArray(text, marker[0].length)
  if (!scanned) return
  // 安全闸门：只修补「数组已闭合」的文本（详见上方 JSDoc）
  if (!/^\][\s}\]`]*$/.test(scanned.tail)) return
  const deficits = scanned.chunks.map(braceDeficit)
  if (deficits.every((value) => value === 0)) return
  const fixed = scanned.chunks.map((chunk, index) =>
    deficits[index] > 0 ? `${chunk.replace(/[\s,]+$/, '')}${'}'.repeat(deficits[index])}` : chunk,
  )
  yield `${marker[0]}${fixed.join(',')}${scanned.tail}`
}

/** 按 `,{"name":` 形状把数组内容切成若干个调用元素（字符串感知）。 */
function splitToolCallArray(text: string, start: number): { chunks: string[]; tail: string } | null {
  const chunks: string[] = []
  let current = ''
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      current += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      current += ch
      continue
    }
    if (ch === ']') {
      chunks.push(current)
      return { chunks, tail: text.slice(i) }
    }
    if (ch === ',' && /^\s*\{\s*"name"\s*:/.test(text.slice(i + 1))) {
      chunks.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (!current.trim()) return null
  chunks.push(current)
  return { chunks, tail: '' }
}

/** 一个片段自身的括号亏空（字符串感知）：> 0 表示缺这么多闭合括号。 */
function braceDeficit(chunk: string): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  return depth
}

/**
 * 修复常见 JSON 语法问题。
 * @param options.mode - `smart`（默认）：字符串内出现非法转义时，把该字符串所有反斜杠按字面
 *   处理（模型原样写路径的常态，避免 `\r`/`\n`/`\t` 被误当转义）；
 *   `conservative`：只补非法转义，其余原样保留。
 */
export function repairJsonText(text: string, options: { mode?: 'smart' | 'conservative' } = {}): string {
  const mode = options.mode ?? 'smart'
  let out = ''
  let inString = false
  let buf = ''
  const flushString = (): void => {
    const raw = buf
    // smart：整串都是「原样写出」的反斜杠 → 全部按字面；否则只补非法转义
    const body =
      mode === 'smart' && hasInvalidEscape(raw)
        ? literalizeBackslashes(raw) // 整串按字面处理（模型原样写路径的常态）
        : escapeInvalidEscapes(raw)
    out += `"${body}"`
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') {
        inString = true
        buf = ''
        continue
      }
      out += ch
      continue
    }
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) {
        buf += '\\\\'
        continue
      }
      buf += ch + next
      i += 1
      continue
    }
    if (ch === '"') {
      flushString()
      inString = false
      continue
    }
    if (ch === '\n') {
      buf += '\\n'
      continue
    }
    if (ch === '\r') {
      buf += '\\r'
      continue
    }
    if (ch === '\t') {
      buf += '\\t'
      continue
    }
    buf += ch
  }
  if (inString) flushString()
  // 去掉对象/数组结尾的多余逗号
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** 字符串里是否存在「非法转义」（判断模型是否原样写出了未转义的反斜杠）。 */
function hasInvalidEscape(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') continue
    const next = body[i + 1]
    if (next === undefined) return true
    if (!'"\\/bfnrtu'.includes(next)) return true
    i += 1
  }
  return false
}

/**
 * 把「模型原样写出的字符串」按字面语义重新转义。
 * 逐字符处理以避免正则的重复加倍：`\\` 保留为一个字面反斜杠、`\"` 保留为转义引号，
 * 其余单个反斜杠一律补成 `\\`（关键：让 `\resources` 里的 `\r` 不再变成回车）。
 */
function literalizeBackslashes(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === '\\') {
      out += '\\\\'
      i += 1
      continue
    }
    if (next === '"') {
      out += '\\"'
      i += 1
      continue
    }
    out += '\\\\'
  }
  return out
}

/** 只把「非法转义」补成字面反斜杠，合法转义原样保留。 */
function escapeInvalidEscapes(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      out += '\\\\'
      continue
    }
    if ('"\\/bfnrtu'.includes(next)) {
      out += ch + next
      i += 1
      continue
    }
    out += '\\\\'
  }
  return out
}

/** 去掉 CDATA 包装并按 JSON 解析值（解析不出就当字符串）。 */
function parseParameterValue(raw: string): unknown {
  let text = raw.trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text)
  if (cdata) text = cdata[1]
  if (text === '') return ''
  const parsed = parseJsonLenient(text)
  return parsed === undefined ? text : parsed
}

/**
 * 解析 XML/DSML 风格的工具调用块（整块文本，可能含多个 invoke）。
 * 支持：`<tool_calls>`/`<function_calls>` 包裹、裸 `<invoke>`、`|DSML|` 前缀、
 * CDATA 值、属性任意顺序、围栏包裹。
 */
export function parseXmlToolCalls(block: string): ToolCallRequest[] | null {
  const text = normalizeDsml(block).replace(FENCE_HEAD_RE, '').replace(/```\s*$/, '')
  const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi
  const calls: ToolCallRequest[] = []
  let invoke: RegExpExecArray | null
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name = readAttr(invoke[1], 'name')
    if (!name) continue
    const body = invoke[2]
    const args: Record<string, unknown> = {}
    let sawParam = false
    const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi
    let param: RegExpExecArray | null
    while ((param = paramRe.exec(body)) !== null) {
      const key = readAttr(param[1], 'name')
      if (!key) continue
      sawParam = true
      args[key] = parseParameterValue(param[2])
    }
    if (!sawParam) {
      // 没有 parameter 子元素：尝试把内文当 JSON 参数，否则按 _raw 保留
      const inner = body.trim()
      if (inner) {
        try {
          const parsed = JSON.parse(inner)
          if (parsed && typeof parsed === 'object') Object.assign(args, parsed as Record<string, unknown>)
          else args._raw = parsed
        } catch {
          args._raw = inner
        }
      }
    }
    calls.push({
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name,
      arguments: JSON.stringify(args),
    })
  }
  return calls.length > 0 ? calls : null
}

/** 把解析出的 JSON 转成工具调用请求；非协议形状返回 null。 */
export function parseToolCallJson(json: string): ToolCallRequest[] | null {
  const parsed: any = parseJsonLenient(json)
  if (!parsed || typeof parsed !== 'object') return null
  const raw = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls
    : parsed.tool_call && typeof parsed.tool_call === 'object'
      ? [parsed.tool_call]
      : null
  if (!raw) return null
  const calls: ToolCallRequest[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.tool === 'string' ? entry.tool : ''
    if (!name) continue
    let args = entry.arguments ?? entry.parameters ?? entry.args ?? {}
    if (typeof args === 'string') {
      // 已经是字符串：能解析就原样透出（DSH 的 arguments 语义是原始 JSON 串），否则包装
      const reparsed = parseJsonLenient(args)
      if (reparsed === undefined) args = JSON.stringify({ _raw: args })
    } else {
      try {
        args = JSON.stringify(args ?? {})
      } catch {
        args = '{}'
      }
    }
    calls.push({ id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name, arguments: String(args) })
  }
  return calls.length > 0 ? calls : null
}

/**
 * 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
 * - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
 * - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
 * 返回 -1 表示尚未收全（继续等流）。
 */
export function findXmlToolCallEnd(buffer: string): number {
  const text = buffer
  const wrapper = /<\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?(tool_calls|function_calls)\b/i.exec(text)
  const startsWithWrapper = wrapper !== null && wrapper.index === 0
  const isInvokeStart = (value: string): boolean => /^\s*<\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\b/i.test(value)

  if (startsWithWrapper) {
    const tag = wrapper![1].toLowerCase()
    const closeRe = new RegExp(`</\\s*(?:\\|\\s*DSML\\s*\\|\\s*)?(?:dsml-)?${tag}\\s*>`, 'i')
    const match = closeRe.exec(text)
    return match ? match.index + match[0].length : -1
  }
  if (!isInvokeStart(text)) {
    // 可能是 `{"tool_calls":…` 之外的 XML 前缀（如仅 `<invoke` 尚未收全）
    return -1
  }
  let cursor = 0
  for (;;) {
    const slice = text.slice(cursor)
    if (!isInvokeStart(slice)) return cursor > 0 ? cursor : -1
    const closeRe = /<\/\s*(?:\|\s*DSML\s*\|\s*)?(?:dsml-)?invoke\s*>/i
    const match = closeRe.exec(slice)
    if (!match) return -1
    cursor += match.index + match[0].length
    // 后面的下一个非空白若是新的 invoke，则继续吞并
    if (!isInvokeStart(text.slice(cursor))) return cursor
  }
}

/**
 * 流式工具调用过滤器。
 * - 普通正文：立即透传（仅 hold back 末尾少量字符以观测跨包的调用标记）
 * - 命中调用标记（JSON 或 XML 两套）：进入捕获态，收全后转成 tool-call 请求，标记本身不外泄
 * - 解析失败：把捕获内容当普通正文吐出（降级但可见，绝不静默丢内容）
 * - 调用后面的剩余文本继续按普通正文处理（含围栏收尾清理）
 */
export class ToolCallStreamFilter {
  private pending = ''
  private capture: { mode: 'json' | 'xml'; buffer: string } | null = null
  private abandoned: { raw: string; mode: 'json' | 'xml' } | null = null
  private readonly knownTools?: ReadonlySet<string>

  constructor(knownTools?: ReadonlySet<string>) {
    this.knownTools = knownTools
  }

  push(text: string): FilterOutput {
    const out: FilterOutput = { text: '', calls: [] }
    if (text) {
      if (this.capture) this.capture.buffer += text
      else this.pending += text
    }
    this.drain(out)
    return out
  }

  flush(): FilterOutput {
    const out: FilterOutput = { text: '', calls: [] }
    if (this.capture) {
      // 流结束时仍未收全：先尝试宽容解析（转义修复 + 结构性补括号）。
      const captured = this.capture
      const calls = captured.mode === 'xml' ? parseXmlToolCalls(captured.buffer) : parseToolCallJson(captured.buffer.replace(FENCE_HEAD_RE, ''))
      if (calls) out.calls.push(...calls)
      else if (captured.mode === 'json') this.abandoned ??= { raw: captured.buffer, mode: 'json' }
      else out.text += captured.buffer // XML 兜底仍按正文透出（`<invoke>` 也可能只是正文里的一句话）
      this.capture = null
    }
    out.text += this.pending
    this.pending = ''
    if (this.abandoned) out.rejected = this.abandoned
    return out
  }

  private drain(out: FilterOutput): void {
    for (;;) {
      if (this.capture) {
        const captured = this.capture
        if (captured.mode === 'xml') {
          const end = findXmlToolCallEnd(captured.buffer)
          if (end === -1) {
            if (captured.buffer.length > MAX_CAPTURE_CHARS) {
              out.text += captured.buffer
              this.capture = null
              continue
            }
            return
          }
          const block = captured.buffer.slice(0, end)
          const calls = parseXmlToolCalls(block)
          if (calls) out.calls.push(...calls)
          else out.text += block
          this.capture = null
          this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, '') + this.pending
          continue
        }
        const balanced = extractBalancedJson(captured.buffer)
        if (!balanced) {
          if (captured.buffer.length > MAX_CAPTURE_CHARS) {
            // 超过上限仍没配平：放弃，但**不吐成正文**（那是乱码，不是回答）
            this.abandoned ??= { raw: captured.buffer, mode: 'json' }
            this.capture = null
            continue
          }
          return
        }
        const calls = parseToolCallJson(balanced.json)
        if (calls) {
          // 未知工具名也照常透出：由运行器给出「未知工具」结果，模型可自行纠正。
          out.calls.push(...calls)
          this.capture = null
          this.pending = captured.buffer.slice(balanced.end).replace(FENCE_HEAD_RE, '') + this.pending
          continue
        }
        // 形状不符：当普通正文（不吞掉模型正文）
        out.text += captured.buffer.slice(0, balanced.end)
        this.capture = null
        this.pending = captured.buffer.slice(balanced.end) + this.pending
        continue
      }

      // 找最早的完整标记（JSON 或 XML）
      const jsonMarker = MARKER_RE.exec(this.pending)
      const xmlMarker = XML_STARTER_RE.exec(this.pending)
      const jsonIndex = jsonMarker?.index ?? -1
      const xmlIndex = xmlMarker?.index ?? -1
      const useXml = xmlIndex !== -1 && (jsonIndex === -1 || xmlIndex < jsonIndex)
      const index = useXml ? xmlIndex : jsonIndex
      if (index !== -1) {
        let head = this.pending.slice(0, index)
        const fence = FENCE_TAIL_RE.exec(head)
        if (fence) head = head.slice(0, fence.index)
        out.text += head
        this.capture = { mode: useXml ? 'xml' : 'json', buffer: this.pending.slice(index) }
        this.pending = ''
        continue
      }

      // 未见完整标记：保留末尾可能的标记前缀，其余立即透传
      if (this.pending.length <= HOLD_BACK_CHARS) return
      const hold = partialMarkerSuffixLength(this.pending)
      if (hold > 0) {
        out.text += this.pending.slice(0, this.pending.length - hold)
        this.pending = this.pending.slice(this.pending.length - hold)
        return
      }
      out.text += this.pending
      this.pending = ''
      return
    }
  }
}
