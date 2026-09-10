/**
 * DeepSeek 网页版 (chat.deepseek.com) API 客户端：
 * PoW SHA3 WASM 求解 + chat_session 生命周期 + /chat/completion SSE 流式解析。
 *
 * 协议依据（2026 年多个活跃逆向实现交叉验证）：
 *   POST /api/v0/chat/create_pow_challenge  {target_path} → data.biz_data.challenge
 *   POST /api/v0/chat_session/create        {}            → data.biz_data.chat_session.id
 *   POST /api/v0/chat_session/delete        {chat_session_id}
 *   POST /api/v0/chat/completion            {chat_session_id, parent_message_id:null, prompt,
 *                                            ref_file_ids:[], thinking_enabled, search_enabled,
 *                                            model_type, action:null, preempt:false}
 *   请求头：Authorization: Bearer <token>、Cookie、x-hif-*、x-ds-pow-response
 *   SSE 负载为 patch 流：
 *     {"v":{"response":{...}}}                  完整快照（fragments / content）
 *     {"p":"response/fragments","o":"APPEND","v":{type,content}}
 *     {"p":"response/fragments/-1/content","v":"…"}
 *     {"p":"response/thinking_content","v":"…"} 旧格式：思考直连
 *     {"p":"response/content","v":"…"}          旧格式：正文直连
 *     {"v":"…"} / {"o":"APPEND","v":"…"}        承接上一个 path 的续段
 *     {"p":"response/status","v":"FINISHED"}    状态
 */
import type { WebAuth } from './auth.ts'
import { AdapterLlmError, httpErrorCode, parseRetryAfterMs } from './auth.ts'

export const DS_BASE = 'https://chat.deepseek.com'

/** PoW 求解器 WASM 的已知默认地址（页面资源捕获失败时兜底）。 */
export const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'

/** 浏览器 UA 兜底（捕获失败时使用）。 */
export const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface DsHeaders {
  [key: string]: string
}

/**
 * 组装一次网页端请求的头。
 * 优先复用登录时捕获的浏览器真实头（extraHeaders），再用最新登录态覆盖
 * authorization/cookie/指纹；user-agent 采用浏览器值（网页端接口需要浏览器指纹），
 * DSH 归属信息通过 `x-deepseek-harness` 头显式声明。
 */
export function buildDsHeaders(auth: WebAuth, referer?: string): DsHeaders {
  const headers: DsHeaders = {
    'user-agent': auth.userAgent || FALLBACK_UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: DS_BASE,
    referer: referer || `${DS_BASE}/`,
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-app-version': '2.0.0',
    ...(auth.extraHeaders ?? {}),
  }
  headers.authorization = `Bearer ${auth.token}`
  headers['content-type'] = 'application/json'
  headers.origin = DS_BASE
  headers.referer = referer || `${DS_BASE}/`
  headers['user-agent'] = auth.userAgent || headers['user-agent'] || FALLBACK_UA
  headers['x-deepseek-harness'] = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web'
  // 这两个头由本插件按次生成/捕获，绝不复用快照里的旧值
  delete headers['x-ds-pow-response']
  if (auth.cookie) headers.cookie = auth.cookie
  else delete headers.cookie
  if (auth.hifDliq) headers['x-hif-dliq'] = auth.hifDliq
  if (auth.hifLeim) headers['x-hif-leim'] = auth.hifLeim
  return headers
}

// ── 响应信封（网页端常以 HTTP 200 + 业务错误码返回失败）────────

/** 网页端统一信封：code===0 为成功；非 0 时 msg 是给用户看的诊断。 */
export function envelopeError(json: any): { code: number; msg: string } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const code = (json as any).code
  if (typeof code === 'number' && code !== 0) {
    return { code, msg: String((json as any).msg ?? (json as any).message ?? 'unknown error') }
  }
  return undefined
}

/** 业务错误码 → 稳定错误码（40003/40001：授权失败）。 */
function bizErrorCode(code: number): string {
  if (code === 40003 || code === 40001) return 'AUTH'
  if (code === 429) return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}

function bizErrorMessage(code: number, msg: string): string {
  if (code === 40003 || code === 40001) {
    return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`
  }
  return `DeepSeek 网页端错误（code ${code}）：${msg}`
}

// ── PoW 求解 ──────────────────────────────────────────────

interface PoWChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: string | number
  expire_at: string | number
  signature: string
}

let wasmModuleCache: { url: string; promise: Promise<WebAssembly.Module> } | null = null
/** 已验证可用/已发现的 WASM 地址（按凭证里记录的原值缓存，避免每次请求都探测）。 */
let resolvedWasmUrl: { key: string; url: string } | null = null

async function isReachable(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const resp = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0' }, signal: signal ?? AbortSignal.timeout(10_000) })
    return resp.ok || resp.status === 206
  } catch {
    return false
  }
}

/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const html = await (await fetch(`${DS_BASE}/`, { signal: signal ?? AbortSignal.timeout(15_000) })).text()
    const direct = html.match(/https?:\/\/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i)
    if (direct) return direct[0]
    const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]).slice(0, 8)
    for (const src of scripts) {
      const url = src.startsWith('http') ? src : new URL(src, `${DS_BASE}/`).href
      try {
        const js = await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).text()
        const found = js.match(/[^"'\s]*sha3[_a-z0-9.]*\.wasm/i)
        if (found) return found[0].startsWith('http') ? found[0] : new URL(found[0], url).href
      } catch {}
    }
  } catch {}
  return undefined
}

/**
 * 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
 * 结果按凭证原值缓存一次，避免每个请求都做探测。
 */
export async function resolveWasmUrl(auth: WebAuth, signal?: AbortSignal): Promise<string> {
  const key = auth.wasmUrl || ''
  if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url
  const candidates = [auth.wasmUrl, DEFAULT_WASM_URL].filter((url): url is string => !!url)
  for (const url of candidates) {
    if (await isReachable(url, signal)) {
      resolvedWasmUrl = { key, url }
      return url
    }
  }
  const discovered = await discoverWasmUrl(signal)
  if (discovered) {
    resolvedWasmUrl = { key, url: discovered }
    return discovered
  }
  return auth.wasmUrl || DEFAULT_WASM_URL
}

async function loadWasmModule(wasmUrl: string): Promise<WebAssembly.Module> {
  if (wasmModuleCache?.url === wasmUrl) return wasmModuleCache.promise
  const promise = (async () => {
    const resp = await fetch(wasmUrl, { signal: AbortSignal.timeout(15_000) })
    if (!resp.ok) throw new Error(`PoW WASM fetch failed (HTTP ${resp.status})`)
    return WebAssembly.compile(await resp.arrayBuffer())
  })()
  wasmModuleCache = { url: wasmUrl, promise }
  promise.catch(() => {
    if (wasmModuleCache?.url === wasmUrl) wasmModuleCache = null
  })
  return promise
}

/**
 * 调用 DeepSeek 的 sha3_wasm_bg 求解 PoW。
 * wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)；
 * prefix = `${salt}_${expire_at}_`；返回 float64 答案（取整）。
 */
async function solvePoW(challenge: PoWChallenge, wasmUrl: string): Promise<number> {
  const module = await loadWasmModule(wasmUrl)
  const instance = await WebAssembly.instantiate(module, { wbg: {} })
  const e = instance.exports as any
  if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
    throw new Error('PoW WASM exports missing (wasm_solve / __wbindgen_export_0 / memory)')
  }
  const encoder = new TextEncoder()
  const cBytes = encoder.encode(challenge.challenge)
  const pBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`)
  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0
  new Uint8Array(e.memory.buffer).set(cBytes, cP)
  new Uint8Array(e.memory.buffer).set(pBytes, pP)
  const sp = e.__wbindgen_add_to_stack_pointer(-16)
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(challenge.difficulty))
  const dv = new DataView(e.memory.buffer)
  const code = dv.getInt32(sp, true)
  const answer = dv.getFloat64(sp + 8, true)
  e.__wbindgen_add_to_stack_pointer(16)
  if (code === 0 || !Number.isFinite(answer) || answer <= 0) throw new Error(`PoW solve failed (code=${code})`)
  return Math.floor(answer)
}

/** 取得一次完成请求的 PoW 响应头值（base64 JSON）。 */
export async function createPowHeader(auth: WebAuth, targetPath: string, signal?: AbortSignal): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: buildDsHeaders(auth),
      body: JSON.stringify({ target_path: targetPath }),
      signal,
    })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek PoW challenge request failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
    throw new AdapterLlmError(
      `DeepSeek PoW challenge failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}) },
    )
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new AdapterLlmError('DeepSeek PoW challenge returned non-JSON', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  const biz = envelopeError(json)
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status })
  }
  const challenge: PoWChallenge | undefined = json?.data?.biz_data?.challenge
  if (!challenge?.challenge || !challenge?.salt || !challenge?.signature) {
    throw new AdapterLlmError(
      'DeepSeek PoW challenge missing fields（登录态可能已过期，或被要求人机校验）',
      'MALFORMED_RESPONSE',
      { status: resp.status },
    )
  }
  const wasmUrl = await resolveWasmUrl(auth, signal)
  const answer = await solvePoW(challenge, wasmUrl)
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  })
  return Buffer.from(payload).toString('base64')
}

// ── 文件上传（图片输入）────────────────────────────────────
//
// 实测（2026-09）：网页端看图不是「模型原生多模态入参」，而是网页把图片
// 上传成文件（`/api/v0/file/upload_file`，PoW 场景 = 该路径），拿到
// `data.biz_data.id`（形如 file-xxxx，model_kind=VISION）后在完成请求里用
// `ref_file_ids` 引用。已验证：上传「左红右蓝」PNG 后模型准确回答「左红色，右=蓝色」。

export interface UploadedFile {
  fileId: string
  name?: string
}

/** 上传一张图片，返回 file_id。`data` 为原始编码字节（png/jpeg/webp/gif）。 */
export async function uploadImageFile(
  auth: WebAuth,
  input: { data: Uint8Array; mediaType: string; name?: string },
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const targetPath = '/api/v0/file/upload_file'
  const powHeader = await createPowHeader(auth, targetPath, signal)
  const headers: DsHeaders = { ...buildDsHeaders(auth) }
  // multipart 由 FormData 设定 boundary，必须去掉 content-type
  delete headers['content-type']
  headers['x-ds-pow-response'] = powHeader

  const form = new FormData()
  const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as any)
  form.append('file', new Blob([bytes], { type: input.mediaType || 'image/png' }), input.name || 'image.png')

  let resp: Response
  try {
    resp = await fetch(`${DS_BASE}${targetPath}`, { method: 'POST', headers, body: form, signal })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek 图片上传失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!resp.ok) {
    throw new AdapterLlmError(
      `DeepSeek 图片上传失败 (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status },
    )
  }
  const biz = envelopeError(json)
  if (biz) throw new AdapterLlmError(`DeepSeek 图片上传被拒（code ${biz.code}）：${biz.msg}`, bizErrorCode(biz.code), { status: resp.status })
  const fileId = json?.data?.biz_data?.id ?? json?.data?.id
  if (typeof fileId !== 'string' || !fileId) {
    throw new AdapterLlmError('DeepSeek 图片上传未返回 file_id', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  return { fileId, ...(input.name ? { name: input.name } : {}) }
}

// ── 会话 ──────────────────────────────────────────────────

/** 新建一个网页端聊天会话，返回 chat_session_id。 */
export async function createChatSession(auth: WebAuth, signal?: AbortSignal): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`${DS_BASE}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: buildDsHeaders(auth),
      body: '{}',
      signal,
    })
  } catch (error: any) {
    throw new AdapterLlmError(`DeepSeek session create failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }
  const text = await resp.text()
  if (!resp.ok) {
    const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
    throw new AdapterLlmError(
      `DeepSeek session create failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
      httpErrorCode(resp.status),
      { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}) },
    )
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new AdapterLlmError('DeepSeek session create returned non-JSON', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  const biz = envelopeError(json)
  if (biz) {
    throw new AdapterLlmError(bizErrorMessage(biz.code, biz.msg), bizErrorCode(biz.code), { status: resp.status })
  }
  const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id
  if (typeof id !== 'string' || !id) {
    throw new AdapterLlmError('DeepSeek session create missing id', 'MALFORMED_RESPONSE', { status: resp.status })
  }
  return id
}

/** 尽力删除一个网页端会话（避免污染用户网页端聊天列表）。失败静默。 */
export function scheduleDeleteSession(auth: WebAuth, sessionId: string, delayMs = 1_500): void {
  const timeout = setTimeout(() => {
    void (async () => {
      try {
        await fetch(`${DS_BASE}/api/v0/chat_session/delete`, {
          method: 'POST',
          headers: buildDsHeaders(auth),
          body: JSON.stringify({ chat_session_id: sessionId }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {}
    })()
  }, delayMs)
  ;(timeout as any).unref?.()
}

/** 验证登录态：优先 users/current，端点不存在时退回 PoW challenge 探活。 */
export async function validateAuth(
  auth: WebAuth,
  signal?: AbortSignal,
): Promise<{ ok: boolean; user?: { id?: string; display?: string }; error?: string }> {
  try {
    const resp = await fetch(`${DS_BASE}/api/v0/users/current`, { headers: buildDsHeaders(auth), signal })
    if (resp.ok) {
      let json: any
      try {
        json = await resp.json()
      } catch {
        json = undefined
      }
      const bizError = envelopeError(json)
      if (bizError) return { ok: false, error: bizError.msg }
      const payload = json?.data?.biz_data ?? json?.data
      const user = payload?.user ?? payload ?? {}
      const display = user?.email ?? user?.mobile ?? user?.phone ?? user?.username ?? user?.nickname ?? user?.name ?? ''
      return {
        ok: true,
        user: {
          ...(user?.id !== undefined ? { id: String(user.id) } : {}),
          ...(display ? { display: String(display) } : {}),
        },
      }
    }
    if (resp.status === 404) {
      await createPowHeader(auth, '/api/v0/chat/completion', signal)
      return { ok: true }
    }
    return { ok: false, error: `users/current HTTP ${resp.status}` }
  } catch (error: any) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── SSE 流式解析 ──────────────────────────────────────────

export type WebStreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'status'; value: string }
  | { kind: 'finish'; reason?: string }
  | { kind: 'error'; message: string; raw?: string }

interface Fragment {
  type: string
  content: string
  emitted: number
}

function isReasoningType(type: string): boolean {
  const t = type.toUpperCase()
  return t === 'THINK' || t === 'REASONING' || t === 'THINKING'
}

/** 把字节流切成行（SSE 帧以 \n 分隔）。 */
async function* iterateLines(body: any): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (): Generator<string> {
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
    }
  }
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        yield* drain()
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {}
    }
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      yield* drain()
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, '')
}

/**
 * 网页端 completion 负载的解析状态机（可单测：handle 返回待 yield 的事件）。
 *
 * ⚠️ 正确性模型（2026-09 事故修复）：
 *   真实事故：模型回答了完整一段，DSH 里只显示「，」「不上」「了一圈」这类 1~3 字碎片，
 *   并伴随 EMPTY_RESPONSE 重试。根因是旧实现用「只增不减的 emitted 计数器」做去重，
 *   而快照会把派生文本重置为更短的内容 —— 计数器被撑大后保持高位，后续只在文本长度
 *   超过它时才吐字，于是前面的全丢、只剩余数的尾巴；余数为空又触发重试。
 *
 *   现在的规则：
 *     ① **增量事件驱动发射**（fragment APPEND / -1/content / thinking_content / content / 裸 v）
 *     ② **快照只做对账**：仅当候选文本是「已发射内容的严格延伸」时补差；
 *        更短（过期快照）或分歧（服务端重排/回退）一律忽略，绝不重置已发射内容
 *     ③ 快照永远不会让已发射内容变小 → 不会丢字、不会因此触发假 EMPTY_RESPONSE
 */
export function createSseState() {
  const fragments: Fragment[] = []
  /** fragments 派生文本（仅用于快照对账候选）。 */
  let fragmentsText = ''
  let fragmentsThinking = ''
  /** 直连格式的派生文本（仅用于快照对账候选）。 */
  let directText = ''
  let directThinking = ''
  /** 已发射的规范流（只增不减）。 */
  let outText = ''
  let outThinking = ''
  let divergences = 0
  let sink: 'fragments' | 'thinking' | 'content' | null = null
  let pendingFinish: string | undefined
  let sawData = false

  const emit = (out: WebStreamEvent[], kind: 'text' | 'thinking', delta: string): void => {
    if (!delta) return
    if (kind === 'text') outText += delta
    else outThinking += delta
    out.push({ kind, text: delta })
  }
  const emitText = (out: WebStreamEvent[], delta: string): void => emit(out, 'text', delta)
  const emitThinking = (out: WebStreamEvent[], delta: string): void => emit(out, 'thinking', delta)

  /** 快照对账：只在候选是严格延伸时补差；过期/分歧忽略（宁可漏一次快照，也不吐乱码或丢字）。 */
  const reconcile = (out: WebStreamEvent[], kind: 'text' | 'thinking', candidate: string): void => {
    const current = kind === 'text' ? outText : outThinking
    if (!candidate || candidate === current) return
    if (candidate.startsWith(current)) {
      emit(out, kind, candidate.slice(current.length))
      return
    }
    if (current.startsWith(candidate)) return // 过期（更短）快照
    divergences += 1 // 分歧：忽略
  }

  /** 重建 fragments 派生文本（快照覆盖时用）。 */
  const rebuildFragmentText = (): void => {
    fragmentsText = ''
    fragmentsThinking = ''
    for (const fragment of fragments) {
      if (isReasoningType(fragment.type)) fragmentsThinking += fragment.content
      else fragmentsText += fragment.content
    }
  }
  /** 快照：整表替换 + 对账（不直接发射）。 */
  const replaceFragments = (list: any[]): void => {
    fragments.length = 0
    for (const f of list) {
      if (f && typeof f === 'object' && typeof f.content === 'string') {
        fragments.push({ type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 })
      }
    }
    rebuildFragmentText()
    sink = fragments.length > 0 ? 'fragments' : null
  }
  /** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
  const appendFragments = (incoming: any, out: WebStreamEvent[]): void => {
    const list = Array.isArray(incoming) ? incoming : incoming !== undefined ? [incoming] : []
    for (const f of list) {
      if (!f || typeof f !== 'object' || typeof f.content !== 'string') continue
      const fragment: Fragment = { type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 }
      fragments.push(fragment)
      if (isReasoningType(fragment.type)) {
        fragmentsThinking += fragment.content
        emitThinking(out, fragment.content)
      } else {
        fragmentsText += fragment.content
        emitText(out, fragment.content)
      }
    }
    sink = fragments.length > 0 ? 'fragments' : null
  }
  /** 增量：续写最后一个 fragment。 */
  const appendToLastFragment = (text: string, out: WebStreamEvent[]): void => {
    const fragment = fragments[fragments.length - 1]
    if (!fragment) {
      directText += text
      emitText(out, text)
      return
    }
    fragment.content += text
    if (isReasoningType(fragment.type)) {
      fragmentsThinking += text
      emitThinking(out, text)
    } else {
      fragmentsText += text
      emitText(out, text)
    }
  }
  /** 增量：裸续段按当前 sink 归属。 */
  const appendSink = (text: string, out: WebStreamEvent[]): void => {
    if (sink === 'thinking') {
      directThinking += text
      emitThinking(out, text)
    } else if (sink === 'content') {
      directText += text
      emitText(out, text)
    } else if (sink === 'fragments') {
      appendToLastFragment(text, out)
    }
  }

  return {
    /** 负载处理（增量直接发射；快照只对账）。 */
    handlePayload(d: any, eventName?: string): WebStreamEvent[] {
      const out: WebStreamEvent[] = []
      sawData = true
      // 1) 完整 response 快照
      if (d && typeof d === 'object' && d.v && typeof d.v === 'object' && d.v.response && typeof d.v.response === 'object') {
        const response = d.v.response
        if (Array.isArray(response.fragments)) {
          replaceFragments(response.fragments)
          // fragments 存在时以它为准；否则用 content
          if (fragments.length > 0) {
            reconcile(out, 'thinking', fragmentsThinking)
            reconcile(out, 'text', fragmentsText)
          }
        }
        if (typeof response.content === 'string') {
          directText = response.content
          sink = 'content'
          if (fragments.length === 0) reconcile(out, 'text', directText)
        }
        if (response.finish_reason !== undefined && response.finish_reason !== null) {
          pendingFinish = String(response.finish_reason)
        }
        return out
      }
      // 2) 模型错误事件
      if (d && typeof d === 'object' && d.type === 'error') {
        const message = typeof d.content === 'string' ? d.content : typeof d.message === 'string' ? d.message : 'model error'
        out.push({ kind: 'error', message, ...(d.finish_reason !== undefined ? { raw: String(d.finish_reason) } : {}) })
        return out
      }
      // 3) SSE 命名事件（title 忽略；toast 视为提示性错误）
      if (eventName === 'toast') {
        const message = d && typeof d === 'object' ? (d.content ?? d.message ?? JSON.stringify(d)) : String(d)
        out.push({ kind: 'error', message: `DeepSeek toast: ${String(message).slice(0, 200)}` })
        return out
      }
      if (eventName === 'title') return out
      // 4) 顶层 finish_reason
      if (d && typeof d === 'object' && d.finish_reason !== undefined && d.finish_reason !== null) {
        pendingFinish = String(d.finish_reason)
        return out
      }
      const path: string | undefined = d?.p
      const value = d?.v
      if (typeof path === 'string') {
        switch (path) {
          case 'response/fragments':
            appendFragments(value, out)
            return out
          case 'response/fragments/-1/content': {
            if (typeof value === 'string') {
              appendToLastFragment(value, out)
              sink = 'fragments'
            }
            return out
          }
          case 'response/thinking_content':
            if (typeof value === 'string') {
              directThinking += value
              emitThinking(out, value)
              sink = 'thinking'
            }
            return out
          case 'response/content':
            if (typeof value === 'string') {
              directText += value
              emitText(out, value)
              sink = 'content'
            }
            return out
          case 'response/finish_reason':
            if (typeof value === 'string') pendingFinish = value
            return out
          case 'response/status':
            if (typeof value === 'string') {
              out.push({ kind: 'status', value })
              if (value === 'FINISHED') pendingFinish = pendingFinish ?? 'FINISHED'
            }
            return out
          case 'response': {
            if (Array.isArray(value)) {
              for (const op of value) {
                if (op && typeof op === 'object' && op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
                  appendFragments(op.v, out)
                }
              }
            }
            return out
          }
          default:
            return out
        }
      }
      // 5) 无 path 的续段：承接当前 sink
      if (typeof value === 'string' && value.length > 0) appendSink(value, out)
      return out
    },
    /** 对外入口（负载已直接发射增量，这里只做兜底对账）。 */
    handle(d: any, eventName?: string): WebStreamEvent[] {
      return this.handlePayload(d, eventName)
    },
    /** 流结束：产出 finish（若确实收到过数据）。 */
    finish(): WebStreamEvent[] {
      return sawData ? [{ kind: 'finish', reason: pendingFinish }] : []
    },
    /** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
    stats(): { text: string; thinking: string; divergences: number } {
      return { text: outText, thinking: outThinking, divergences }
    },
  }
}

/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
export async function* parseWebSse(body: any): AsyncGenerator<WebStreamEvent> {
  const state = createSseState()
  let eventName = ''
  for await (const line of iterateLines(body)) {
    if (line.length === 0) {
      eventName = ''
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      for (const event of state.finish()) yield event
      return
    }
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    for (const event of state.handle(parsed, eventName)) yield event
    eventName = ''
  }
  for (const event of state.finish()) yield event
}

// ── 完成请求 ──────────────────────────────────────────────

export interface CompletionParams {
  prompt: string
  thinkingEnabled: boolean
  searchEnabled?: boolean
  modelType: 'default' | 'expert' | 'vision'
  /** 已上传文件的 file_id（图片输入：随请求引用，模型据此看图）。 */
  refFileIds?: readonly string[]
  signal?: AbortSignal
  idleTimeoutMs?: number
  onDeleteSession?: (sessionId: string) => void
}

/** 发起一次网页版完成请求并流式产出事件；会话在结束时尽力删除。 */
export async function* streamWebCompletion(auth: WebAuth, params: CompletionParams): AsyncGenerator<WebStreamEvent> {
  const idle = params.idleTimeoutMs ?? 120_000
  const controller = new AbortController()
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal

  const sessionId = await createChatSession(auth, signal)
  params.onDeleteSession?.(sessionId)

  const powHeader = await createPowHeader(auth, '/api/v0/chat/completion', signal)

  let resp: Response
  try {
    resp = await fetch(`${DS_BASE}/api/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
        accept: 'text/event-stream',
        'x-ds-pow-response': powHeader,
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt: params.prompt,
        ref_file_ids: params.refFileIds ?? [],
        thinking_enabled: params.thinkingEnabled,
        search_enabled: params.searchEnabled ?? false,
        model_type: params.modelType,
        action: null,
        preempt: false,
      }),
      signal,
    })
  } catch (error: any) {
    if (params.signal?.aborted) throw new AdapterLlmError('DeepSeek web request aborted by caller', 'ABORTED', { cause: error })
    throw new AdapterLlmError(`DeepSeek web request failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const code = httpErrorCode(resp.status)
    const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
    const hint =
      code === 'AUTH'
        ? ' —— 网页登录态可能已过期，请到「设置 → DeepSeek 网页登录」重新登录'
        : code === 'RATE_LIMIT'
          ? ' —— 网页端频控（免费额度），稍后重试即可'
          : ''
    throw new AdapterLlmError(
      `DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}${hint}`,
      code,
      { status: resp.status, ...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}), cause: new Error(text) },
    )
  }
  if (!resp.body) throw new AdapterLlmError('DeepSeek web completion returned no body', 'EMPTY_RESPONSE')

  // HTTP 200 也可能是「业务错误信封」或 HTML 挑战页 —— 非 SSE 一律先当错误处理
  const contentType = String(resp.headers.get('content-type') ?? '')
  if (!contentType.includes('text/event-stream')) {
    const text = await resp.text().catch(() => '')
    let biz: { code: number; msg: string } | undefined
    try {
      biz = envelopeError(JSON.parse(text))
    } catch {}
    throw new AdapterLlmError(
      biz
        ? bizErrorMessage(biz.code, biz.msg)
        : `DeepSeek 网页端返回了非流式响应（content-type: ${contentType || 'unknown'}）：${text.slice(0, 200)}`,
      biz ? bizErrorCode(biz.code) : 'MALFORMED_RESPONSE',
      { status: resp.status },
    )
  }

  // 空闲看门狗：SSE 事件间隔超过 idle 即判定超时
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  let fireIdle: (error: unknown) => void = () => {}
  const idlePromise = new Promise<never>((_, reject) => {
    fireIdle = reject
  })
  const armIdle = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (settled) return
      controller.abort('idle timeout')
      fireIdle(new AdapterLlmError(`DeepSeek web stream idle timeout after ${idle}ms`, 'TIMEOUT'))
    }, idle)
    ;(timer as any).unref?.()
  }
  armIdle()

  try {
    const iterator = parseWebSse(resp.body)[Symbol.asyncIterator]()
    while (true) {
      const result = await Promise.race([iterator.next(), idlePromise])
      armIdle()
      if (result.done) break
      yield result.value
    }
  } catch (error: any) {
    if (error instanceof AdapterLlmError) throw error
    if (params.signal?.aborted) throw new AdapterLlmError('DeepSeek web stream aborted by caller', 'ABORTED', { cause: error })
    throw new AdapterLlmError(`DeepSeek web stream failed: ${error?.message ?? error}`, 'TRANSPORT', { cause: error })
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
    try {
      controller.abort('stream consumer stopped')
    } catch {}
  }
}
