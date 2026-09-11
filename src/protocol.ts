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
   *
   * `reason` 区分失败形态，用于诊断（实测日志只留前 400 字符，看不到后半段的坏点）：
   *  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
   *  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义等）；
   *  - `echo`      ：载荷里裹着转写回声（`[Tool Result for …]` 等）—— 模型在**复述历史**，
   *                  不是真在调用。此类**必须丢弃**：实测抓到过一个 8152 字符、含 15 条
   *                  「调用」的载荷，全部是历史回放，执行它等于把旧命令重跑一遍；
   *  - `oversize`  ：超过捕获上限，放弃。
   */
  rejected?: { raw: string; mode: 'json' | 'xml'; reason?: 'unbalanced' | 'unparsable' | 'oversize' | 'echo' }
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
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Do NOT use XML/HTML-like markup such as <tool_calls>, <invoke>, <parameter>, <|DSML|>, or any fenced variant of them. The JSON object above is the ONLY accepted format; markup text would be shown to the user as broken output instead of running the tool.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry — measured case: a model emitted 15 replayed calls inside one 8152-char payload, and every one of them had to be thrown away.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`

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
 * 亦兼容 DeepSeek 自家的 DSML 前缀与 `dsml-` 连字符变体）。
 *
 * ⚠️ 2026-09-10 实测泄漏样本（真正的乱码来源）：模型把 DSML 前缀写成**重复的全角竖线**，
 * 且包裹标签名退化成 `calls`：
 *   `<` + `｜｜` + `DSML` + `｜｜` + ` ` + `calls>`
 * 旧写法只容忍单个竖线（`[|｜]`），于是 `<` 后吃掉一个 `｜` 就要求紧跟 `DSML`，
 * 却撞上第二个 `｜` → 整个标记认不出来 → 不进捕获态 → 原样进正文 → GUI 渲染成乱码。
 * 现在竖线按 `+` 容忍（含全角/半角混用），并把 `calls` 也列入包裹标签名。
 */
const DSML_PREFIX = '(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?'
const WRAPPER_NAMES = 'tool_calls|tool_call|function_calls|calls'
const XML_STARTER_RE = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES}|invoke)\\b`, 'i')
/** 代码围栏收尾（模型常把调用块放进 ``` 里）。 */
const FENCE_TAIL_RE = /\n?[ \t]*```[a-zA-Z0-9]*[ \t]*\n?$/
const FENCE_HEAD_RE = /^[ \t]*\n?```[ \t]*\n?/

/**
 * 开/收标签前缀（宽容写法）。严格解析与宽容解析**必须共用同一套**，否则会出现
 * 「findXmlToolCallEnd 认得出收尾、parseXmlToolCalls 认不出 invoke」→ 整块被降级成正文泄漏。
 * 覆盖：`< invoke`（标签名带空白）、单/重复竖线的 DSML 前缀（含全角）、`<dsml-invoke>`。
 */
const TAG_OPEN_PREFIX = `<\\s*${DSML_PREFIX}(?:dsml-)?`
const TAG_CLOSE_PREFIX = `<\\/\\s*${DSML_PREFIX}(?:dsml-)?`
const XML_CLOSE_NAMES = `parameter|invoke|${WRAPPER_NAMES}`

/**
 * 归一化 DSML 噪声 → 标准标签。
 * 竖线支持**重复与全角**（实测样本是双全角竖线），并连带吃掉其后的空白，
 * 让标签名紧跟在 `<` 之后（`<` + 前缀 + ` ` + `invoke` → `<invoke`）。
 */
function normalizeDsml(text: string): string {
  return text
    .replace(new RegExp(`<(/?)${DSML_PREFIX}`, 'gi'), '<$1')
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

/** XML 标记前缀（用于跨包 hold-back 判断）。`calls` 是实测出现的退化包裹名。 */
const XML_MARKER_STARTERS = ['<tool_calls', '<tool_call', '<function_calls', '<calls', '<invoke', '<dsml-tool_calls', '<dsml-invoke']

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
/**
 * 修复「**字符串值里出现未转义的双引号**」——实测最高频的坏法，也是「自动停止」的元凶。
 *
 * 实测（2026-09-10 23:27:13，deepseek-reasoner）：命令天然写作
 *   `Get-ChildItem "$env:USERPROFILE\.dsh" | Select-Object Name`
 * 模型把这串里的引号**原样**塞进 JSON 字符串 → `Expected ',' or '}' after property value`
 * → 整条调用被丢弃 → 那一轮没有工具调用 → agent loop 认为回合正常结束
 * → 用户看到的症状就是「说半句就停了」。
 *
 * 判据（对 JSON 语法是稳的）：在字符串内部遇到双引号时，向后跳过空白看一个字符 ——
 * 只有它还是 `,` `}` `]`（或文本结束）时才说明字符串真的结束；否则该引号是内容里的字面引号。
 *
 * ⚠️ 冒号必须**按位置**区别对待：`"` 后面跟 `:` 只在「键的位置」才是结构符。
 * 若把值里的 `"` + `:` 也当成结束，那么命令内嵌 JSON 时会误判，例如
 *   `node -e "const o={"a":1}"`
 * 里的 `"a"` 会被当成字符串收尾 → 后面全部错位 → 整条调用照样被丢弃（我第一版就踩了这个洞）。
 * 因此这里跟踪「进入字符串时是否处于键位置」（上一结构符是 `{` / `,` / `[`）。
 */
export function escapeInnerQuotes(text: string): string {
  let out = ''
  let inString = false
  let keyPosition = false
  let lastStructural = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') {
        inString = true
        keyPosition = lastStructural === '{' || lastStructural === ',' || lastStructural === '['
        out += ch
        continue
      }
      if (!' \t\n\r'.includes(ch)) lastStructural = ch
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '')
      i += 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && ' \t\n\r'.includes(text[j])) j++
      const next = text[j]
      // 冒号只有在键位置才是结构符；值里的引号 + 冒号属于内容（内嵌 JSON 的常态）
      const isStructural =
        next === ',' || next === '}' || next === ']' || next === undefined || (next === ':' && keyPosition)
      if (isStructural) {
        inString = false
        lastStructural = next === undefined ? '' : next
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

/**
 * ⚠️ 刻意**不提供**「更激进的猜测」候选（例如把 `"` 后跟 `}` 也一律当内容）。
 * 试过，结果是灾难：外层键的收尾引号也会被转义 → 整个载荷被搅坏；
 * 而且即使侥幸解析成功，也可能交出一条**被改坏的命令**并真的执行它。
 * 嵌套引号（`node -e "console.log({"k":"v"})"`）在原理上无法靠单字符前瞻消歧 ——
 * 这种极端用例的正确处置是**拒绝 + 重试**（重试后模型通常会改用更简单的写法），
 * 而不是猜。宁可拒绝，也绝不交出坏命令。
 */
export function* jsonRepairCandidates(text: string): Generator<string> {
  const pathTail = (value: string): string => value.replace(/([A-Za-z]:[^"]*?)\\"(?=[,}\]\s])/g, '$1\\\\"')
  // 依次尝试：原样 → 补未转义引号 → 结构性补括号；每种再各跑一遍字符串级修复。
  // 所有候选都由 JSON.parse 验证，取先成功的那个。
  for (const base of [text, ...structuralRepairCandidates(text)]) {
    for (const variant of [base, escapeInnerQuotes(base)]) {
      yield repairJsonText(pathTail(variant), { mode: 'smart' })
      yield repairJsonText(variant, { mode: 'smart' })
      yield repairJsonText(pathTail(variant), { mode: 'conservative' })
      yield repairJsonText(variant, { mode: 'conservative' })
    }
  }
}

/**
 * 结构性修复候选：模型写的 tool_calls JSON 常有**括号结构错误**（漏写闭合、数组/对象闭合顺序错乱）。
 *
 * 已覆盖的实测形态：
 *  - 每个调用对象少写一个 `}`（2026-09 事故 #4：批量 3 个调用各少一个）
 *  - arguments 写成数组、且 `]`/`}` 顺序错乱（2026-09-11 事故 #5：
 *    `{"tool_calls":[{"name":"pwsh","arguments":[{…}}]}`  ← args 数组没闭合就写了 `}`）
 *  - 外层对象少写收尾 `}`
 *
 * 做法（rebuildToolCallJson）：栈引导重排 —— 遇到不匹配的闭合符时，**插入缺失的容器闭合**
 * 使其匹配。只插入括号，绝不改写字符串内容。配合 parseToolCallJson 的
 * 「arguments 数组 → 取唯一元素」解包，这类调用可以完整恢复并执行。
 */
export function* structuralRepairCandidates(text: string): Generator<string> {
  const marker = /^\s*\{\s*"tool_calls?"\s*:\s*\[/.exec(text)
  if (!marker) return
  const rebuilt = rebuildToolCallJson(text)
  if (rebuilt && rebuilt !== text) yield rebuilt
}

/**
 * 栈引导的 tool_calls JSON 重排（只在严格解析失败后使用，**只插入括号、绝不改写字符串内容**）。
 *
 * 规则：
 *  1) 正常的开/闭符合配 → 原样输出并弹栈；
 *  2) 闭合符与栈顶不匹配 → 在其前**插入**能使它匹配的闭合序列（有上限保护），再正常闭合；
 *  3) `,` 出现在 tool_calls 数组的元素层级、而栈顶是未闭合的调用对象 → 先补 `}`
 *     （实测形态：批量调用每个元素都少写一个 `}`）；
 *  4) 收尾按栈补齐剩余闭合。
 *
 * ⚠️ 安全闸门：扫描结束时若**仍在字符串内**（流被服务端 60s 上限截断的典型特征）→ 返回 null。
 * 此时补括号会得到一条**被截断的命令**并真的执行它 —— 宁可拒绝（→ 重试），也不执行半条命令。
 */
export function rebuildToolCallJson(text: string): string | null {
  if (!/^\s*\{\s*"tool_calls?"\s*:\s*\[/.test(text)) return null
  let out = ''
  const stack: string[] = []
  let inString = false
  let escape = false
  let insertions = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      out += ch
      continue
    }
    if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '['
      while (stack.length > 0 && stack[stack.length - 1] !== want) {
        if (insertions >= 8) return null
        out += stack[stack.length - 1] === '{' ? '}' : ']'
        stack.pop()
        insertions += 1
      }
      if (stack.length === 0) return null
      stack.pop()
      out += ch
      continue
    }
    if (ch === ',') {
      // `,` 在 tool_calls 数组的**元素层级**（数组之上只有一层调用对象）而栈顶未闭合
      // → 模型忘了写这个元素的 `}`，补上（实测：批量调用每个都少一个 `}`）。
      // 数组之上超过一层 = 逗号在元素内部的合法位置（args 对象/数组里），不动。
      // ⚠️ 还必须带前瞻：调用对象内部的键分隔逗号（"name" 与 "arguments" 之间）在这一刻的
      // 深度同样是 1，但后面跟的是 `"arguments"` 而不是 `{"name"` —— 不带前瞻会把每个调用对象拦腰补坏。
      const bracketIndex = stack.indexOf('[')
      if (
        bracketIndex === 1 &&
        stack.length - bracketIndex - 1 === 1 &&
        stack[stack.length - 1] === '{' &&
        /^\s*\{\s*"name"\s*:/.test(text.slice(i + 1))
      ) {
        out += '}'
        stack.pop()
        insertions += 1
      }
      out += ch
      continue
    }
    out += ch
  }
  if (inString) return null // 安全闸门（见上）
  if (insertions > 8) return null
  while (stack.length > 0) {
    out += stack[stack.length - 1] === '{' ? '}' : ']'
    stack.pop()
  }
  return out
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
  const invokeRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}invoke\\s*>`, 'gi')
  const calls: ToolCallRequest[] = []
  let invoke: RegExpExecArray | null
  while ((invoke = invokeRe.exec(text)) !== null) {
    const name = readAttr(invoke[1], 'name')
    if (!name) continue
    const body = invoke[2]
    const args: Record<string, unknown> = {}
    let sawParam = false
    const paramRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)${TAG_CLOSE_PREFIX}parameter\\s*>`, 'gi')
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
  if (calls.length > 0) return calls
  return salvageXmlToolCalls(text)
}

/**
 * 宽容抢救：模型写出的 XML 调用块**收尾不全**时的最后一道网。
 *
 * 实测泄漏样本（2026-09，正是「一个字符一行」乱码的来源）：
 *   `<tool_calls><invoke name="pwsh"><parameter name="command">…</parameter>`
 * —— 参数值写完了，但**缺内层 `</invoke>`**（流被服务端上限截断时常见）。此时严格解析
 * 认不出 invoke（它的正则要求 `</invoke>` 收尾），于是整块被当正文吐给用户；
 * 而 Web GUI 把命令行里的 `$…$` 当 KaTeX 渲染 → 用户看到「一个字符一行 + 弯引号」的乱码。
 * （注：只缺最外层 `</tool_calls>` 的情形严格解析本来就能兜住，不是泄漏源。）
 *
 * 做法：不依赖任何闭合标签，只按「`<invoke name=…>` 开标签 → 下一个开标签或块尾」切段取值。
 * ⚠️ 只在**严格解析完全失败**时兜底，因此不会抢占正常路径。
 * 宁可能截断也不要泄漏 —— 截断的调用会在下一轮被模型自己纠正。
 */
function salvageXmlToolCalls(text: string): ToolCallRequest[] | null {
  const invokeStartRe = new RegExp(`${TAG_OPEN_PREFIX}invoke\\b([^>]*)>`, 'gi')
  const starts: { index: number; attrs: string }[] = []
  let match: RegExpExecArray | null
  while ((match = invokeStartRe.exec(text)) !== null) starts.push({ index: match.index, attrs: match[1] })
  if (starts.length === 0) return null

  const calls: ToolCallRequest[] = []
  for (let i = 0; i < starts.length; i++) {
    const name = readAttr(starts[i].attrs, 'name')
    if (!name) continue
    const bodyStart = starts[i].index + starts[i].attrs.length
    // 段落 = 到下一个 invoke 开标签为止；不能按闭合标签切，因为它们可能整段缺失。
    const nextStart = starts[i + 1]?.index ?? text.length
    const body = text.slice(bodyStart, nextStart)
    calls.push({
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name,
      arguments: JSON.stringify(salvageXmlParameters(body)),
    })
  }
  return calls.length > 0 ? calls : null
}

/** 从残缺的 invoke 内文里取出参数：按开标签切段，值取到下一个开标签或段尾。 */
function salvageXmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const paramStartRe = new RegExp(`${TAG_OPEN_PREFIX}parameter\\b([^>]*)>`, 'gi')
  const found: { start: number; end: number; key: string }[] = []
  let match: RegExpExecArray | null
  while ((match = paramStartRe.exec(body)) !== null) {
    const key = readAttr(match[1], 'name')
    if (key) found.push({ start: match.index, end: paramStartRe.lastIndex, key })
  }
  for (let i = 0; i < found.length; i++) {
    // 值 = 本参数开标签之后 → 下一个参数开标签之前（或段尾）
    // 按**开标签位置**切段而不是按 `</parameter>`：收尾标签可能整段缺失。
    const valueEnd = found[i + 1] ? found[i + 1].start : body.length
    // 值尾部残留的 `</parameter>` / `</invoke>` / `</tool_calls>` 一律剥掉
    args[found[i].key] = parseParameterValue(stripXmlClosers(body.slice(found[i].end, valueEnd)))
  }
  if (found.length === 0) {
    const inner = stripXmlClosers(body).trim()
    if (inner) {
      const parsed = parseJsonLenient(inner)
      if (parsed && typeof parsed === 'object') Object.assign(args, parsed as Record<string, unknown>)
      else args._raw = inner
    }
  }
  return args
}

/** 剥掉值尾部残留的收尾标签与空白。 */
function stripXmlClosers(value: string): string {
  const re = new RegExp(`(?:\\s*${TAG_CLOSE_PREFIX}(?:${XML_CLOSE_NAMES})\\s*>)+\\s*$`, 'i')
  return value.replace(re, '')
}

/**
 * 判断捕获到的协议块是否**确实是一次工具调用尝试**（而不是正文里恰好提到了 `<invoke>` 这类词）。
 * 只用于「解析失败时该丢弃还是该透出」的裁决：
 *  - 像调用 → 丢弃 + 告警（绝不泄漏成乱码，交给上层重试）
 *  - 不像调用 → 当普通正文透出（绝不吞掉模型正文）
 */
function looksLikeToolCallBlock(mode: 'json' | 'xml', raw: string): boolean {
  if (mode === 'json') return MARKER_RE.test(raw)
  const text = normalizeDsml(raw)
  // 带 name 属性的 invoke/parameter 开标签 = 真的在尝试调用。
  // 注意：系统提示词讲协议时只写 `<invoke>` / `<parameter>`（无 name=），因此不会被误判。
  return (
    new RegExp(`${TAG_OPEN_PREFIX}invoke\\b[^>]*\\bname\\s*=`, 'i').test(text) ||
    new RegExp(`${TAG_OPEN_PREFIX}parameter\\b[^>]*\\bname\\s*=`, 'i').test(text)
  )
}

/**
 * 分类失败形态，用于诊断 —— 日志只保留前 400 字符，看不到后半段的坏点，
 * 所以必须把「没收全」与「收全了但结构不对」分开，否则永远在猜。
 *
 *  - `unbalanced`：块没配平/没收全 —— 多半是流被服务端 60s 上限截断，不是模型写错；
 *  - `unparsable`：块是完整的，但结构不符（漏括号、引号没转义、形状不对）；
 *  - `echo`      ：载荷里裹着转写回声（模型在回放历史，不是在调用）。
 */
function classifyFailure(mode: 'json' | 'xml', raw: string): 'unbalanced' | 'unparsable' | 'echo' {
  // 最先判回声：实测抓到的 8152 字符载荷里有 15 条「调用」，命令串内裹着
  // `[Tool Result for call_…]` / `[Truncated]` —— 那是历史回放，执行它等于重跑旧命令。
  if (/\[\s*Tool Result\b/i.test(raw)) return 'echo'
  if (mode === 'json') return extractBalancedJson(raw.replace(FENCE_HEAD_RE, '')) ? 'unparsable' : 'unbalanced'
  return findXmlToolCallEnd(raw) === -1 ? 'unbalanced' : 'unparsable'
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
    // 模型偶尔把 arguments 写成**数组**（实测 2026-09-11：arguments:[{…}]，规范是对象）。
    // 只有一个对象元素时取该元素 —— 否则参数会被序列化成 "[{…}]"，工具拿到的是垃圾。
    if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      args = args[0]
    }
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
 * 流尾兜底的 JSON 抢救（比 parseToolCallJson 多退一步）。
 *
 * 捕获缓冲里可能带着捕获后残留的多余字符（围栏、正文），此时整段 `JSON.parse` 必然失败，
 * 但**配平的前缀本身是好的调用** —— 取前缀再解析，别把能救的调用整批丢掉。
 * 注意：不配平的截断仍由 structuralRepairCandidates 的安全闸门拒绝（宁可不执行半条命令）。
 */
function parseSalvagedToolCallJson(buffer: string): ToolCallRequest[] | null {
  const text = buffer.replace(FENCE_HEAD_RE, '')
  const direct = parseToolCallJson(text)
  if (direct) return direct
  const balanced = extractBalancedJson(text)
  if (balanced && balanced.end < text.length) return parseToolCallJson(balanced.json)
  return null
}

/**
 * 在捕获缓冲里找 XML 调用块的结束位置（含结束标签）。
 * - 包裹式（`<tool_calls>` / `<function_calls>`）：找对应闭合标签
 * - 裸 `<invoke>`：找到 `</invoke>` 后继续吞并紧随其后的 invoke 块（同一批调用）
 * 返回 -1 表示尚未收全（继续等流）。
 */
export function findXmlToolCallEnd(buffer: string): number {
  const text = buffer
  const wrapper = new RegExp(`<\\s*${DSML_PREFIX}(?:dsml-)?(${WRAPPER_NAMES})\\b`, 'i').exec(text)
  const startsWithWrapper = wrapper !== null && wrapper.index === 0
  const isInvokeStart = (value: string): boolean =>
    new RegExp(`^\\s*<\\s*${DSML_PREFIX}(?:dsml-)?invoke\\b`, 'i').test(value)

  if (startsWithWrapper) {
    const tag = wrapper![1].toLowerCase()
    const closeRe = new RegExp(`<\\/\\s*${DSML_PREFIX}(?:dsml-)?${tag}\\s*>`, 'i')
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
      // 流结束时仍未收全：先尝试宽容解析（转义修复 + 结构性补括号 + 缺闭合标签抢救）。
      const captured = this.capture
      const calls =
        captured.mode === 'xml' ? parseXmlToolCalls(captured.buffer) : parseSalvagedToolCallJson(captured.buffer)
      if (calls) out.calls.push(...calls)
      else if (looksLikeToolCallBlock(captured.mode, captured.buffer))
        this.abandoned ??= { raw: captured.buffer, mode: captured.mode, reason: classifyFailure(captured.mode, captured.buffer) }
      else out.text += captured.buffer // 不像调用（只是正文里提到 `<invoke>` 这类词）→ 照常透出
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
              // 超长仍未收全：是调用就丢弃（不吐乱码），只是正文提及则照常透出
              if (looksLikeToolCallBlock('xml', captured.buffer))
                this.abandoned ??= { raw: captured.buffer, mode: 'xml', reason: 'oversize' }
              else out.text += captured.buffer
              this.capture = null
              continue
            }
            return
          }
          const block = captured.buffer.slice(0, end)
          const calls = parseXmlToolCalls(block)
          if (calls) out.calls.push(...calls)
          else if (looksLikeToolCallBlock('xml', block)) this.abandoned ??= { raw: block, mode: 'xml', reason: 'unparsable' }
          else out.text += block
          this.capture = null
          this.pending = captured.buffer.slice(end).replace(FENCE_HEAD_RE, '') + this.pending
          continue
        }
        const balanced = extractBalancedJson(captured.buffer)
        if (!balanced) {
          if (captured.buffer.length > MAX_CAPTURE_CHARS) {
            // 超过上限仍没配平：放弃，但**不吐成正文**（那是乱码，不是回答）
            this.abandoned ??= { raw: captured.buffer, mode: 'json', reason: 'oversize' }
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
        // 形状不符：能进到捕获态就说明 MARKER_RE 命中过（`{"tool_calls":`），
        // 因此这是**坏掉的调用**而不是正文 → 丢弃 + 告警（泄漏成正文才是真正的乱码来源）。
        const head = captured.buffer.slice(0, balanced.end)
        if (looksLikeToolCallBlock('json', head)) this.abandoned ??= { raw: head, mode: 'json', reason: 'unparsable' }
        else out.text += head
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

// ── 转写回声守卫 ──────────────────────────────────────────

/**
 * 转写格式标记 —— 也就是 `serializePrompt` 写进 prompt 的那套行首标记。
 *
 * 模型会**照着 prompt 里的转写格式模仿**，把工具结果 / 系统标记当回答吐出来。
 * 这与「工具调用标记泄漏」是**两个独立的泄漏源**：`ToolCallStreamFilter` 只防后者。
 *
 * 实测（2026-09-10，deepseek-web / deepseek-reasoner）可见正文里出现：
 *   `[Tool Result for call_xxx]` + 真实工具输出 + `[status: running]`
 * 以及成串的 `User: …` / `Assistant: …` 转写行。
 */
const ECHO_SIGNATURES: readonly RegExp[] = [
  /^\[\s*Tool Result\b/i,
  /^\[\s*status\s*:\s*[a-z_]+\s*\]$/i,
  /^\[\s*(?:System|Assistant)\s*\]$/i,
]
/** 转写轮次行：单行可能只是正文，成串出现才是回声。 */
const ECHO_TURN_RE = /^(?:User|Assistant)\s*:/

/** 回声标记的**半截前缀**（流在行中间被截断时出现）——同样是垃圾，不能上屏。 */
const ECHO_PREFIXES = ['[tool result', '[status:', '[system]', '[assistant]']

/** 该行是否是某个回声标记的开头片段。 */
function looksLikeEchoPrefix(line: string): boolean {
  const t = line.trim().toLowerCase()
  return t.length > 0 && ECHO_PREFIXES.some((p) => p.startsWith(t))
}

/**
 * 逐行守卫：命中回声特征后，**从该行起全部丢弃**。
 *
 * 为什么这样设计：
 *  - 回声几乎总出现在末尾（模型在「续写转写」），前面才是真回答 → 截断比整段丢弃更保内容；
 *  - 围栏代码块内不判定 —— 正常回答里也可能引用这些标记（比如讨论本插件时）；
 *  - 逐行缓冲、保留末尾未完成的半行 → 流式下也不会先把垃圾推给用户再吞回去。
 */
export class TranscriptEchoGuard {
  private pending = ''
  private inFence = false
  /** 已扣住、尚未判定的一行转写轮次行（等下一行决定它是回声还是正文）。 */
  private turnCandidate: string | null = null
  private fired = false

  /**
   * @returns `text` = 可以安全上屏的部分；`echoed` = 本轮是否出现过回声（那部分已被丢弃）。
   */
  push(text: string): { text: string; echoed: boolean } {
    if (this.fired) return { text: '', echoed: true }
    this.pending += text
    let out = ''
    for (;;) {
      const nl = this.pending.indexOf('\n')
      if (nl === -1) break
      const line = this.pending.slice(0, nl + 1)
      this.pending = this.pending.slice(nl + 1)
      const verdict = this.classify(line)
      if (verdict === 'echo') {
        this.fired = true
        this.pending = ''
        this.turnCandidate = null
        return { text: out, echoed: true }
      }
      if (verdict === 'turn') {
        // 转写轮次行：单行可能是正常正文，**先扣住**，等下一行判定（否则第一行会先泄漏上屏）
        if (this.turnCandidate !== null) {
          this.fired = true
          this.pending = ''
          this.turnCandidate = null
          return { text: out, echoed: true }
        }
        this.turnCandidate = line
        continue
      }
      // 普通行/围栏行：只有在这一行**非空白**时，才说明扣住的那行只是正文里的 `User:` 字样 → 放行
      if (this.turnCandidate !== null && line.trim() !== '') {
        out += this.turnCandidate
        this.turnCandidate = null
      }
      out += line
    }
    return { text: out, echoed: false }
  }

  flush(): { text: string; echoed: boolean } {
    if (this.fired) return { text: '', echoed: true }
    let out = ''
    // 只有孤零零一行轮次行 → 判定为正文，放行
    if (this.turnCandidate !== null) {
      out += this.turnCandidate
      this.turnCandidate = null
    }
    const rest = this.pending
    this.pending = ''
    // 流在行中间断掉：完整的回声判不出来，但半截标记前缀同样是垃圾，一律丢弃
    if (rest && (this.classify(rest) === 'echo' || looksLikeEchoPrefix(rest))) {
      this.fired = true
      return { text: out, echoed: true }
    }
    return { text: out + rest, echoed: false }
  }

  private classify(line: string): 'echo' | 'turn' | 'fence' | 'plain' {
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      this.inFence = !this.inFence
      return 'fence'
    }
    if (this.inFence) return 'plain'
    for (const re of ECHO_SIGNATURES) if (re.test(t)) return 'echo'
    if (ECHO_TURN_RE.test(t)) return 'turn'
    return 'plain'
  }
}
