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
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome, webLoginDir } from './paths.ts'
import type { WebAuth } from './auth.ts'
import { AdapterLlmError, describeError, httpErrorCode, parseRetryAfterMs } from './auth.ts'
// 默认区间来自 gate.ts —— 设置页的滑块边界与这里的默认值必须是**同一份**，否则界面显示的和实际跑的不是一回事。
import {
  DEFAULT_CLEANUP_BATCH,
  DEFAULT_CLEANUP_DELAY_MS,
  DEFAULT_CLEANUP_GAP_MS,
  type CleanupRange,
} from './gate.ts'
// 上下文投喂方式（全量 / 链式增量）——决策是纯函数，见 context-feed.ts 的模块注释。
import { currentContextMode, decideFeed, effectiveReuseLimit, firstDifference, needsFreshSession, type ChainState, type FeedDecision, type FeedReason } from './context-feed.ts'
// 🔴 0.6.42：PoW 改在浏览器页面内求解（见 `solvePow`）。
import { solvePowInPage, systemBrowserAvailable } from './browser-transport.ts'

export const DS_BASE = 'https://chat.deepseek.com'

/** PoW 求解器 WASM 的已知默认地址（页面资源捕获失败时兜底）。 */
export const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'

/** 浏览器 UA 兜底（捕获失败时使用）。 */
export const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 网页端 `x-client-version` 的兜底值（**抓取失败时**才用）。
 *
 * 🔴 这个值会随网页端发版过时，而且**没有任何自动机制会发现它过时** ——
 * 旧实现写死 `2.0.0`，到 2026-10-02 已经落后到 `2.5.0`（真实捕获值）。
 * 所以：① 优先永远用抓来的真值（`auth.extraHeaders`）；
 * ② 这里只保证"万一没有真值时，不至于差得离谱"；③ 每次核对捕获时顺手校准一次。
 */
export const FALLBACK_CLIENT_VERSION = '2.5.0'

export interface DsHeaders {
  [key: string]: string
}

/**
 * 组装一次网页端请求的头。
 *
 * 顺序与优先级（2026-10-02 重排，理由见下）：
 *   ① 先铺**登录时从真实浏览器抓来的指纹头**（`auth.extraHeaders`）——
 *      头的**顺序本身就是指纹**，浏览器给什么顺序就用什么顺序；
 *      而且它的值比我们写死的兜底更可信（`x-client-version` 随网页端版本走，写死必然过时）。
 *   ② 再补**兜底**，且只补浏览器没给的（写死值绝不能盖掉抓来的真值）。
 *   ③ 最后放**逐请求现算**的头（token / cookie / hif / pow / content-type / origin / referer）——
 *      这些必须用**当前**登录态，复用快照里的旧值会出错。
 */
export function buildDsHeaders(auth: WebAuth, referer?: string): DsHeaders {
  const headers: DsHeaders = { ...(auth.extraHeaders ?? {}) }
  const defaults: DsHeaders = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'x-client-platform': 'web',
    // ⚠️ 只是**兜底**：抓取成功时用的一定是浏览器的真实值（实测 2026-10-02 是 `2.5.0`）。
    // 写死值必然随网页端发版而过时 —— 过时的后果是功能降级（"更新到最新版才能用专家/识图"），
    // 不是鉴权失败。
    'x-client-version': FALLBACK_CLIENT_VERSION,
    // ⚠️ 真实浏览器**不发**这个头（2026-10-02 核对真实捕获：7 个 `x-*` 里没有它）。
    // 保留是为了不改变既有行为；想更贴近浏览器，删掉下面这行即可。
    'x-app-version': FALLBACK_CLIENT_VERSION,
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (!headers[key]) headers[key] = value
  }
  headers['user-agent'] = auth.userAgent || FALLBACK_UA
  headers['content-type'] = 'application/json'
  headers.origin = DS_BASE
  headers.referer = referer || `${DS_BASE}/`
  headers.authorization = `Bearer ${auth.token}`
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
  // ⚠️ 网页端把**真实业务错误**放在 data.biz_code 里，外层 code 依旧是 0。
  // 只认外层 code 的后果（实测 2026-09-11）：服务端明明说得很清楚
  //   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
  // 却被降级成人人看不懂、而且**不可重试**的
  //   `非流式响应（content-type: application/json）：{...}` + MALFORMED_RESPONSE。
  // 认了 biz_code 之后，既能给出真原因，也能按原因做定向恢复（重建会话重试）。
  const bizCode = (json as any).data?.biz_code
  if (typeof bizCode === 'number' && bizCode !== 0) {
    const bizMsg = (json as any).data?.biz_msg
    const text = bizMsg === undefined || bizMsg === null || bizMsg === '' ? 'unknown error' : String(bizMsg)
    return { code: bizCode, msg: text }
  }
  return undefined
}

/**
 * 账号被临时限制判定（实测 2026-09-11）：
 *   {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",
 *                     "biz_data":{"is_muted":1,"mute_until":1789173841.894}}}
 * 这是**服务端对账号的限制**（免费网页端对高频自动化调用的静默限流），不是插件 bug：
 * 登录态有效、建会话也成功，只有 completion 被拒。必须把解除时间明确告诉用户，
 * 并且**不要空转重试** —— 否则每一轮都白发请求，还可能延长限制。
 */
export function isMutedError(biz: { code?: number; msg?: string } | undefined): boolean {
  return biz?.code === 5 || /user\s+is\s+muted|account\s+is\s+muted/i.test(String(biz?.msg ?? ''))
}

/** 从响应信封里读出解除限制的时间（ms）；读不到返回 undefined。 */
export function muteUntilMs(json: any): number | undefined {
  const raw = (json as any)?.data?.biz_data?.mute_until
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

/**
 * 「能换号接着干」时给的重试退避。
 *
 * 为什么是 2 秒而不是 0：让 dsh-llm-retry 立刻重发，但仍留一点余量 ——
 * 重发进入适配器时，"自动换号"的检查点要先跑完（可能含一次探活）。
 * 它**不是**"等对面恢复"的退避，而是"我马上换个号再试一次"的信号。
 *
 * 导出是为了让 `adapter.ts` 声明重试策略时拿它当 `initialDelayMs`（单一来源）。
 */
export const FAILOVER_RETRY_MS = 2_000
/**
 * 限流但**没得换号**时的退避（HTTP 路径用的定值）。
 *
 * 为什么还留着 20 秒：限流是"发太快了"的反馈，同号立刻重试只会再撞一次。
 * ⚠️ 但它同时意味着"这一轮基本就断了" —— 台账实测限流后能自动重发的几次，间隔都落在
 * 27.8s ~ 60s 且那几次仍然失败。所以**能换号就一定走 `FAILOVER_RETRY_MS`**，
 * 别让用户在这里干等（那是"任务卡住、要手动重发"的根源）。
 *
 * ⚠️ 别拿它当"我们的最大退避"：SSE 路径走的是 `throttleBackoffMs`（渐长、上限更高），
 * 见 `MAX_THROTTLE_RETRY_MS`。
 */
const THROTTLE_RETRY_MS = 20_000

/**
 * 被限制时的用户可读文案。
 *
 * 只说结论与解除时间 —— **不解释原因**。原因（免费网页端对高频自动化的静默限流、
 * 登录态其实有效、只有 completion 被拒……）属于开发/排查信息，写在这里就够了：
 * 用户看到报错时只需要知道「是什么 + 到几点结束」，长篇解释只会淹没这两件事。
 */
function mutedMessage(untilMs: number | undefined): string {
  if (untilMs === undefined) {
    return 'DeepSeek 网页端已封禁本账号（未给出解除时间）'
  }
  const when = new Date(untilMs).toLocaleString('zh-CN', { hour12: false })
  const minutes = Math.max(1, Math.round((untilMs - Date.now()) / 60_000))
  return `DeepSeek 网页端已封禁本账号，${when} 解除（约 ${minutes} 分钟）`
}

/**
 * 「同一账号同时只能生成一条」的并发拒绝（实测 2026-09-11：两个 DSH 窗口共用同一网页账号，
 * 一个正在生成时另一个发请求即得此错：`A message is being generated, please try again later.`）。
 * 它**不是封号**（封号是 `user is muted`），但也无法立刻成功 ——
 * 归为可重试的 RATE_LIMIT，交由 dsh-llm-retry 稍后自动重发，而不是让整轮直接失败。
 */
export function isBusyGenerating(message: string): boolean {
  // R6（0.2.0）：剔除英文裸短语 "try again later" —— 它是**限流**文案的常见尾巴
  // （"too many requests, please try again later"），留着会把限流误判成"并发生成"，
  // 退避从 20s 渐长退化成 5s 固定，撞得更频。实测过的 busy 文案
  // （"A message is being generated, please try again later."）含 being generated，剔除安全。
  return /being generated|请稍后再试|稍后再试|正在生成/i.test(String(message ?? ''))
}

/**
 * 连续节流的状态：被限一次就退避久一点，别在限流窗口里反复撞。
 * （实测 2026-09-11 下午：同一个账号连续被限，5 次重试全落在窗口里 → 整轮失败。）
 */
/**
 * 当前使用的 fetch 实现。
 *
 * 默认是 Node 的全局 fetch（undici）。宿主可以注入 **Electron 的 `net.fetch`** ——
 * 后者走 Chromium 原生网络库，能带来与真实浏览器一致的 TLS / HTTP2 指纹。
 * 为什么在意：实测 Node fetch 与 Chrome 的指纹差异是**结构性**的
 * （JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同）。
 *
 * 注意：Electron 的 utility 进程里 `require('electron')` 只暴露 `net` 与 `systemPreferences`
 * （实测 2026-09-12），所以宿主只能注入 net.fetch，拿不到别的网络相关能力。
 */
let injectedFetch: typeof fetch | undefined

/**
 * 实际发请求用的 fetch —— 刻意做成**每次现取**（`injectedFetch ?? fetch`），
 * 而不是在模块加载那一刻把全局 fetch 固化下来。
 *
 * 原因（2026-09-12 实测踩到）：固化写法会让「模块加载之后再替换 globalThis.fetch」失效 ——
 * 单测正是用这种方式打桩，结果请求绕过了桩件、**真的发到了线上**
 * （拿回一个 INVALID_TOKEN，测试看着在验证错误分类，实际在打网络）。
 */
function activeFetch(input: any, init?: any): Promise<Response> {
  return (injectedFetch ?? fetch)(input, init)
}

/** 注入 fetch 实现；传 undefined 还原为 Node 全局 fetch。 */
export function setFetchImpl(impl?: typeof fetch): void {
  injectedFetch = impl
}

/**
 * 当前生效的 fetch（诊断/检查更新这类**旁路请求**用它，从而与网页端请求走同一个传输层）。
 * 注意它已经做了"每次现取"，直接当 fetch 用即可。
 */
export function currentFetch(input: any, init?: any): Promise<Response> {
  return activeFetch(input, init)
}

/** 当前用的是注入实现还是 Node 原生（诊断用）。 */
export function fetchImplKind(): 'injected' | 'node' {
  return injectedFetch ? 'injected' : 'node'
}

let throttleStreak = 0
let lastThrottleAt = 0

/** 限流退避：基数 20s、每次翻倍、封顶 90s，另加 0~30% 抖动。 */
const THROTTLE_BASE_MS = 20_000
const THROTTLE_MAX_MS = 90_000
const THROTTLE_JITTER_RATIO = 0.3

/**
 * 我们**可能**上报给调用方（`dsh-llm-retry`）的**最大**限流退避。
 *
 * 🔴 它必须 ≤ 适配器声明的 `providerRetryPolicy().maxDelayMs`（**扁平字段**，见 `adapter.ts`）：
 * dsh-llm 的重试策略在 normal 模式下，一旦「提供方要的延迟 > maxDelayMs」就**直接放弃重试**
 * （`return next()`），整轮随即以 error 结束 —— 表现就是"任务停在限流上，要用户手点继续"。
 *
 * 实测 2026-09-27 14:35:32（会话日志原文）：
 *   `failure: {code: "RATE_LIMIT", providerRetryAfterMs: 49208}` → 默认 maxDelayMs=10000
 *   ⇒ 一次都没重试，`turn/end` 直接是 error。所以**两边的数字必须一起看**，别只改一边。
 */
export const MAX_THROTTLE_RETRY_MS = Math.round(THROTTLE_MAX_MS * (1 + THROTTLE_JITTER_RATIO))

/**
 * AUTH 失败、**能换号**时给的重试间隔。
 *
 * 为什么要等（而不用 `FAILOVER_RETRY_MS` 的 2 秒）：宿主对"被服务端判 AUTH"的账号会先做一次
 * **只读复核探活**，复核确认失效才写 `lastVerifyError`（判据见 `index.ts` 的 AUTH 分支）。实测
 * 那一次探活 0.9~3.5 秒。重发太早 ⇒ 换号检查点还没看见标记 ⇒ 又拿同一个死号发一次，白跑一轮。
 *
 * ⚠️ 必须 ≤ 适配器声明的 `maxDelayMs`（`MAX_THROTTLE_RETRY_MS`，117s），否则重试直接被放弃。
 */
export const AUTH_FAILOVER_RETRY_MS = 5_000

/**
 * AUTH 失败、**没得换号**时给的退避 —— 故意给到 `maxDelayMs` 之上。
 *
 * 🔴 这是"条件式可重试"的实现方式：把 AUTH 放进 `retryableCodes` 之后，
 * **没有别的号可用时重试一个已失效的凭证只会白打请求**（还多暴露在风控下），
 * 所以不靠"码"来区分，而是靠这条**判据**：
 * "要的延迟 (600s) > maxDelayMs (117s) 且 normal ⇒ dsh-llm-retry 直接放弃重试"。
 * ⇒ 默认没开自动换号的用户，行为与加这个功能之前**完全一致**。
 *
 * 实测来源：这条判据第一次被踩到是 2026-09-27（限流退避 49208 > 10000 ⇒ 一次都没重试）。
 */
export const AUTH_GIVEUP_RETRY_MS = 600_000

/**
 * 取下一次节流退避（ms）。
 *
 * ⚠️ 实际的**首档是 40s，不是 20s**：`noteThrottled` 先把 `throttleStreak` 加一，
 * 再调本函数算 `20s × 2^streak`。注释与代码曾不一致（多处写"20s 起"），
 * 2026-09-27 按实测值（49208ms = 40000 + 23% 抖动）校正为 40s 起。
 * 保序：40s → 80s → 90s（封顶），每次都加 0~30% 抖动。
 */
export function throttleBackoffMs(now: number = Date.now()): number {
  // 超过 5 分钟没被限，认为窗口已过，重新开始计数
  if (now - lastThrottleAt > 5 * 60_000) throttleStreak = 0
  const base = Math.min(THROTTLE_BASE_MS * 2 ** throttleStreak, THROTTLE_MAX_MS)
  const jitter = Math.round(base * THROTTLE_JITTER_RATIO * Math.random())
  return base + jitter
}

/** 记录一次节流；返回本次应给的退避（ms）。 */
function noteThrottled(now: number = Date.now()): number {
  if (now - lastThrottleAt > 5 * 60_000) throttleStreak = 0
  throttleStreak += 1
  lastThrottleAt = now
  return throttleBackoffMs(now)
}

/**
 * 限流（SSE 路径）该向调用方要多久的退避。
 *
 * 能换号 ⇒ 短退避，让重试**立刻**发生（重发前的检查点会换上可用账号）；
 * 不能 ⇒ 给足渐长退避。问不出来（没注入 / 抛错）时按"不能换号"处理：保守方向 ——
 * 宁可多等一会儿，也不要给一个它其实接不上的短退避（那只会更快地撞同一个限流）。
 *
 * ⚠️ `noteThrottled()` 有副作用（推高 streak），所以**只在真要长退避时才调它** ——
 * 能换号时不烧档位。
 */
function throttleRetryAfterMs(canFailover?: (kind?: 'muted' | 'throttled') => boolean): number {
  try {
    if (canFailover?.('throttled') === true) return FAILOVER_RETRY_MS
  } catch {}
  return noteThrottled()
}

/**
 * 账号级节流：「发得太频繁」。
 *
 * 实测 2026-09-11 16:11（SSE error 事件，不是 HTTP 429）：
 *   `消息发送过于频繁，请稍后重试`
 * ⚠️ 注意它和上面那条**差一个字**：并发拒绝写的是「请稍后再**试**」，节流写的是「请稍后**重**试」。
 * 之前只匹配前者，于是这条落到 PROVIDER_ERROR（**不可重试**）→ 整轮直接失败、只能手点「继续」。
 *
 * 与 `user is muted`（有明确解除时间）也不是一回事：节流是短时的，退避够久就能过去。
 * 退避给 20s（并发那条只给 5s）：撞得越勤越可能延长限制。
 */
export function isThrottled(message: string): boolean {
  return /过于频繁|太频繁|操作频繁|too\s+many\s+requests|rate\s*limit|稍后重试|限流/i.test(
    String(message ?? ''),
  )
}

/**
 * 会话失效判定：服务端用 biz_msg 表达「这个 chat_session_id 不存在/无效」。
 * 触发场景（实测）：请求发出前会话已被删除（旧版把删除排在建会话之后 1.5s，
 * 而 PoW 求解 + 建连可能超过 1.5s），或服务端自行回收了闲置会话。
 * 这类失败**可以透明恢复**：本插件每次调用都是全新会话、不依赖服务端历史 → 换个会话重发即可。
 */
export function isInvalidSessionError(biz: { code?: number; msg?: string } | undefined): boolean {
  return /invalid\s+chat\s+session|chat\s+session\s+(?:not\s+found|expired|invalid)|chat_session_id[^\p{L}]{0,4}(?:无效|不存在|已过期|非法)|会话.{0,8}(?:无效|不存在|已过期)/iu.test(
    String(biz?.msg ?? ''),
  )
}

/** 业务错误码 → 稳定错误码（40003/40001：授权失败）。 */
function bizErrorCode(code: number): string {
  if (code === 40003 || code === 40001) return 'AUTH'
  // 429（HTTP 状态码）之外还要认 **40029**（业务码，HTTP 可能仍是 200 的 JSON 信封）：
  // 「操作过于频繁」在信封里的码就是它。只认 429 会漏掉走信封的这一路 ⇒ 落到 PROVIDER_ERROR
  // ⇒ 不可重试 ⇒ 整轮直接失败（而且是在被限流、最该退避的时候失败）。
  // 来源：cuckoo-code 0.6.1 的实测记录（它专门为这个码加了 60 秒退避重试）。
  if (code === 429 || code === 40029) return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}

/**
 * `code 9` 在本项目里有**两个不同含义**，只能靠 msg 区分 —— 别只看数字：
 *  · 上传文件时：`unsupported file type`（文件名后缀不被支持）⇒ 换个名字重传即可（见 imageUploadName）
 *  · 发请求时：`invalid ref file id`（引用了一批服务端不认的文件 id）⇒ 需要降级重试
 *
 * 把后者单独识别出来，是为了让适配器能自救。这条错误的特点很恶劣：**带上图就失败**，
 * 而图留在历史里，之后每一轮重发都会再撞一次 ⇒ 用户除了丢掉整个会话没有别的出路。
 * 实测触发（2026-09-21）：当前账号 `acc_2df7cf2f` 的凭证残缺（cookie 为空）时，
 * `new-session` 触发全量重发历史图 ⇒ code 9；而同一操作在另外两个 cookie 完整的账号上正常。
 */
export function isInvalidRefFileError(biz: { code: number; msg?: string } | undefined): boolean {
  return !!biz && biz.code === 9 && /ref\s*file/i.test(String(biz.msg ?? ''))
}

function bizErrorMessage(code: number, msg: string): string {
  if (code === 40003 || code === 40001) {
    return `DeepSeek 网页授权失败：${msg} —— 登录态已过期或无效，请到「设置 → DeepSeek 网页登录」重新登录`
  }
  // 防御：40029 已被信封路径的 throttled 判据接住，正常走不到这里 ——
  // 留着是怕将来有人只动了判据、忘同步文案，至少文案口径还是对的。
  if (code === 40029) return '网页版限流：发得太频繁，稍后自动重试'
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

async function readOfficialResource(url: string, max: number, outer?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') ||
      (parsed.hostname !== 'deepseek.com' && !parsed.hostname.endsWith('.deepseek.com'))) throw new Error('非官方资源地址')
  const signal=outer?AbortSignal.any([outer,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)
  const resp=await activeFetch(parsed.href,{signal,redirect:'error'})
  if(!resp.ok||!resp.body){await resp.body?.cancel();throw new Error(`资源请求失败 HTTP ${resp.status}`)}
  const reader=resp.body.getReader();const chunks:Uint8Array[]=[];let size=0
  try {
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength
      if(size>max)throw new Error('资源超过字节上限');chunks.push(item.value)}
  } finally {try{await reader.cancel()}catch{};reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return bytes
}

async function isReachable(url: string, outer?: AbortSignal): Promise<boolean> {
  if(!checkedWasmUrl(url))return false
  const signal=outer?AbortSignal.any([outer,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000)
  let resp:Response|undefined
  try {resp=await activeFetch(url,{method:'GET',headers:{range:'bytes=0-0'},signal,redirect:'error'});return resp.ok}
  catch {if(outer?.aborted)outer.throwIfAborted();return false}
  finally {try{await resp?.body?.cancel()}catch{}}
}

/** 从网页端首页/JS chunk 里发现当前构建的 sha3 wasm 地址（哈希随版本变化）。 */
async function discoverWasmUrl(signal?: AbortSignal): Promise<string | undefined> {
  const decode = (bytes:Uint8Array)=>new TextDecoder().decode(bytes)
  const find = (text:string,base:string):string|undefined=>{
    for(const match of text.matchAll(/[^"'\s<>]*sha3[_a-z0-9.]*\.wasm/gi)) {
      try{const url=checkedWasmUrl(new URL(match[0],base).href);if(url)return url}catch{}
    }
    return undefined
  }
  try {
    signal?.throwIfAborted()
    const html=decode(await readOfficialResource(`${DS_BASE}/`,2*1024*1024,signal))
    const direct=find(html,`${DS_BASE}/`);if(direct)return direct
    const scripts=[...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].slice(0,8)
    for(const match of scripts){
      signal?.throwIfAborted()
      try{const url=new URL(match[1],`${DS_BASE}/`).href
        const found=find(decode(await readOfficialResource(url,8*1024*1024,signal)),url)
        if(found)return found
      }catch{if(signal?.aborted)signal.throwIfAborted()}
    }
  }catch{if(signal?.aborted)signal.throwIfAborted()}
  return undefined
}

/**
 * 解析可用的 PoW WASM 地址：凭证记录值 → 已知默认值 → 页面发现。
 * 结果按凭证原值缓存一次，避免每个请求都做探测。
 */
export async function resolveWasmUrl(auth: WebAuth, signal?: AbortSignal): Promise<string> {
  const key = auth.wasmUrl || ''
  if (resolvedWasmUrl?.key === key) return resolvedWasmUrl.url
  // 凭证里的地址先过白名单：不合法就丢弃（并告警），绝不拿去发请求
  const fromAuth = checkedWasmUrl(auth.wasmUrl)
  if (auth.wasmUrl && !fromAuth) {
    lastWasmUrlRejection = auth.wasmUrl
  }
  const candidates = [fromAuth, checkedWasmUrl(DEFAULT_WASM_URL)].filter((url): url is string => !!url)
  for (const url of candidates) {
    if (await isReachable(url, signal)) {
      resolvedWasmUrl = { key, url }
      return url
    }
  }
  const discovered = checkedWasmUrl(await discoverWasmUrl(signal))
  if (discovered) {
    resolvedWasmUrl = { key, url: discovered }
    return discovered
  }
  // 全都拿不到：宁可带着「地址不合法/找不到」的明确报错失败，也不要退回未校验的地址
  return fromAuth ?? checkedWasmUrl(DEFAULT_WASM_URL) ?? DEFAULT_WASM_URL
}

/**
 * F12（2026-09-12 审计）：PoW WASM 地址的白名单校验。
 *
 * 为什么需要：`auth.wasmUrl` 主要来自**导入的账号备份**，可被构造成任意地址
 * （审计已复现：可打内网 / 云元数据 / file: 协议）。Electron 的 net.fetch 支持的
 * 协议比 Node fetch 更宽，不能把后者的协议限制当成统一边界。
 *
 * 为什么只限到 deepseek.com 而不是写死单个主机：默认地址里带内容哈希
 * （sha3_wasm_bg.7b9ca65ddd.wasm），官方一改就失效；而 `wasmUrl` 实际上**不是**
 * 浏览器抓来的（browser-login 里恒为空），页面发现（discoverWasmUrl）是唯一的
 * 兜底路径。所以保留发现能力，只把「能不能用」收白名单，既挡 SSRF 又留后路。
 */
const MAX_WASM_BYTES = 8 * 1024 * 1024

/** 最近一次被白名单拒绝的凭证 wasmUrl（诊断/单测用；本模块无日志器，留状态而不是打日志）。 */
export let lastWasmUrlRejection: string | undefined

/**
 * 清掉 wasm 地址缓存（单测用；生产里"失效即清"由 `loadWasmModule` 的失败回调负责）。
 *
 * 🔴 0.6.42 加这个出口的原因：`resolvedWasmUrl` 是**模块级**缓存，`n05Run` 那类
 * 用例在同一模块实例里跑两轮，第二轮会直接命中上一轮的缓存 ⇒
 * `probes=0`、看起来"探测没发生"。以前没暴露，是因为旧用例靠 Node 侧下载
 * 顺带把缓存清了；PoW 改到页面内之后 Node 侧不再下载 ⇒ 必须显式清。
 */
export function resetWasmUrlCache(): void {
  resolvedWasmUrl = null
  wasmModuleCache = null
}

/** 合法则返回规范化后的地址，否则返回 undefined（调用方负责回退并告警）。 */
export function checkedWasmUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  if (url.port && url.port !== '443') return undefined
  const host = url.hostname.toLowerCase()
  // 挡住 169.254.169.254 / localhost / 内网 / 任意第三方，同时容忍未来换 CDN
  if (host !== 'deepseek.com' && !host.endsWith('.deepseek.com')) return undefined
  if (!url.pathname.toLowerCase().endsWith('.wasm')) return undefined
  return url.href
}

async function loadWasmModule(wasmUrl: string): Promise<WebAssembly.Module> {
  const url=checkedWasmUrl(wasmUrl)
  if(!url)throw new Error('非法 WASM 地址')
  if(wasmModuleCache?.url===url)return wasmModuleCache.promise
  const promise=(async()=>WebAssembly.compile(await readOfficialResource(url,MAX_WASM_BYTES)))()
  wasmModuleCache={url,promise}
  promise.catch(()=>{
    if(wasmModuleCache?.promise===promise)wasmModuleCache=null
    if(resolvedWasmUrl?.url===url)resolvedWasmUrl=null
  })
  return promise
}

/**
 * 🔴 0.6.42：PoW 求解的**唯一入口** —— 优先在浏览器页面上下文里解。
 *
 * ## 为什么没有"Node 兜底"
 *
 * 封号风险的主要来源就是"在 Node 里 `WebAssembly.instantiate` 解官方挑战"这件事本身
 * （`xiaoY233/DeepSeek-Free-API` 的 Disclaimers 明列：
 * "Challenge Solving Patterns: Automated challenge solving detected"）。
 * **如果失败就悄悄退回 Node 侧算，这个改动等于没做** ——
 * 表面上"支持页面内求解"，实际上大多数请求还在走旧路径，还给了我们"已经改好了"的错觉。
 * ⇒ **浏览器不可用就显式报错**，让调用方与用户都看得见。
 *
 * ⚠️ 这条改动会**改变行为**：原来没有浏览器也能跑（Node 侧算），
 * 现在必须有浏览器。这是故意的 —— 但要知道自己正在换的是什么。
 */
async function solvePow(challenge: PoWChallenge, wasmUrl: string): Promise<number> {
  if (systemBrowserAvailable()) {
    return await solvePowInPage({
      wasmUrl,
      challenge: challenge.challenge,
      salt: challenge.salt,
      difficulty: challenge.difficulty,
      expireAt: challenge.expire_at,
    })
  }
  throw new AdapterLlmError(
    'PoW 必须在浏览器页面内求解（未找到 Edge/Chrome）—— 不再退回 Node 侧计算，因为那是主要的封号特征',
    'TRANSPORT',
  )
}

/**
 * ~~调用 DeepSeek 的 sha3_wasm_bg 求解 PoW。~~
 *
 * 🔴 0.6.42 已删除（Node 侧求解 = 主要封号特征，见 `solvePow` 的说明）。
 *    保留这段注释是为了让后来者知道**为什么这里空了**，
 *    以及**不要**因为"Node 侧也能算"就把它加回来。
 *    页面内实现在 `browser-transport.ts` 的 `solvePowInPage`。
 *
 * 原实现（留档，便于对照 prefix 的拼法）：
 * ```ts
 * wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)；
 * prefix = `${salt}_${expire_at}_`；返回 float64 答案（取整）。
 * ```
 */
async function solvePoW_removedForReference(challenge: PoWChallenge, wasmUrl: string): Promise<number> {
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
    resp = await activeFetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
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
  const answer = await solvePow(challenge, wasmUrl)
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
    resp = await activeFetch(`${DS_BASE}${targetPath}`, { method: 'POST', headers, body: form, signal })
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
    resp = await activeFetch(`${DS_BASE}/api/v0/chat_session/create`, {
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
// ── 会话清理：把「每轮建一个立刻删一个」的机器特征压下来 ──────────────
//
// 背景：一次模型调用要发 4 个请求 —— 建会话 → 取 PoW → completion → 删会话。
// 其中「每轮新建一个临时会话、用完立刻删掉」是最强的机器行为特征之一（真人绝不会这样）。
//
// 为什么不能直接复用会话：DSH 每次把**全量历史**交给我们，而网页端会话是**有状态**的，
// 复用会让服务端看到「历史 + 全量 prompt」两份上下文，迅速撑爆窗口。所以只能优化**删除侧**。
//
//   immediate = 老行为：调用结束后 1.5s 删掉（每轮 1 个 DELETE 请求）
//   deferred  = 默认：攒够 batchSize 个、或从第一个入队起等满 delayMs 才清理；
//               清理时**先尝试一个请求批量删**（服务端支持的话 N 个会话只花 1 个请求），
//               不支持则回退逐个删，并且此后不再尝试批量（只浪费一次）。
//   keep      = 完全不删：请求数最少，但网页端会留下临时会话。

export type SessionCleanupMode = 'immediate' | 'deferred' | 'keep'

export interface SessionCleanupPolicy {
  mode: SessionCleanupMode
  /** 当前生效值：有区间时是"这一轮抽到的"，没有区间时就是固定值（毫秒）。 */
  delayMs: number
  /** 当前生效值：攒够多少个立即清理（个）。 */
  batchSize: number
  /** 当前生效的删除间隔（毫秒）—— 相邻两个删除请求之间停多久。 */
  gapMs: number
  /**
   * 三对区间（可选）。给了就"每轮 / 每次重新随机抽"，没给就保持固定值语义 ——
   * 这样老调用方（传死 batchSize / delayMs 的）行为完全不变。
   *
   * 为什么要有：**固定值本身就是机器特征** —— 每次都攒到第 8 个就动手、每次都正好等 90 秒、
   * 逐个删除时请求连发（中间 0 间隔）。真人不会这么精确。
   */
  batchRange?: CleanupRange
  delayRange?: CleanupRange
  gapRange?: CleanupRange
}

export const DEFAULT_SESSION_CLEANUP: SessionCleanupPolicy = {
  mode: 'deferred',
  // 均值落在旧默认值上（90s / 8 个 / 1.5s），所以升级后行为没有突变，只是多了方差
  delayMs: Math.round((DEFAULT_CLEANUP_DELAY_MS.min + DEFAULT_CLEANUP_DELAY_MS.max) / 2),
  batchSize: Math.round((DEFAULT_CLEANUP_BATCH.min + DEFAULT_CLEANUP_BATCH.max) / 2),
  gapMs: Math.round((DEFAULT_CLEANUP_GAP_MS.min + DEFAULT_CLEANUP_GAP_MS.max) / 2),
  batchRange: DEFAULT_CLEANUP_BATCH,
  delayRange: DEFAULT_CLEANUP_DELAY_MS,
  gapRange: DEFAULT_CLEANUP_GAP_MS,
}

/**
 * 单个请求里最多塞多少个会话 id。
 *
 * 为什么要有：队列在"清理很慢"时可能积很多（比如你离开两小时后回来，一次 flush 要删几十个）。
 * 「一次请求删掉一大批」正是用户担心的事 —— 所以超过这个数就拆成多次，
 * 每次之间按随机间隔停一下。
 */
const MAX_IDS_PER_REQUEST = 20

/**
 * 会话生命周期事件（2026-09-14）。
 *
 * 宿主用它维护一份「**还欠一次删除**」的会话清单并落盘（见 `session-journal.ts`），
 * 于是进程退出/被强杀之后，下次启动还能把这些会话补删掉 —— 在此之前，
 * 复用槽和待删队列只活在内存里，进程一走就静默丢失，网页端就会一直堆。
 *
 * 四个事件对应四种账：
 *   - `leased`    会话进了复用槽（此刻**还没删**，所以是欠账）；
 *   - `queued`    会话进了待删队列（同样是欠账，只是排队了）；
 *   - `deleted`   **确认删掉**（服务端接受了）→ 销账信号；
 *   - `abandoned` **决定不删了**（用户切成「不删」）→ 也是销账信号。
 *
 * ⚠️ `abandoned` 必须存在（2026-10-01）：切到「不删」时要把 journal 里的欠账摘掉，
 * 否则下次启动在别的清理模式下补扫，又会把这些会话删掉 —— 用户明明选了"不删"。
 */
export type SessionLifecycleEvent =
  | { kind: 'leased'; auth: WebAuth; sessionId: string }
  | { kind: 'queued'; auth: WebAuth; sessionId: string }
  | { kind: 'deleted'; sessionId: string }
  | { kind: 'abandoned'; sessionId: string }

let sessionLifecycleHook: ((event: SessionLifecycleEvent) => void) | undefined

/** 注册生命周期钩子（宿主启动时调一次即可；传 `undefined` 取消）。 */
export function setSessionLifecycleHook(hook?: (event: SessionLifecycleEvent) => void): void {
  sessionLifecycleHook = hook
}

function emitSessionLifecycle(event: SessionLifecycleEvent): void {
  try {
    sessionLifecycleHook?.(event)
  } catch {
    /* 钩子出错不能影响请求主流程 */
  }
}

export interface SessionCleanerOptions {
  policy?: Partial<SessionCleanupPolicy>
  /** 一开始就只手动清理（宿主在链式模式下启动时传 true）。 */
  manualOnly?: boolean
  logger?: { info?: (msg: string) => void; debug?: (msg: string) => void }
  /** 单测注入。 */
  fetchImpl?: typeof fetch
  setTimeoutImpl?: (fn: () => void, ms: number) => any
  clearTimeoutImpl?: (t: any) => void
  /** 随机源。单测注入一个确定序列即可得到可重复的取值。默认 Math.random。 */
  randomImpl?: () => number
}

export interface SessionCleaner {
  schedule(auth: WebAuth, sessionId: string): void
  /**
   * 丢掉一个**我们自己的脚手架会话**（内部请求用的那个）—— 不受 keep / manualOnly 影响，
   * 也不 drain 队列。见实现处的长注释（2026-10-02「就发了一句话、网页端俩窗口」）。
   */
  discard(auth: WebAuth, sessionId: string): Promise<void>
  /** 立即清理队列（测试 / 面板「立即清理」/ 卸载时用）。**手动调用不受 manualOnly 限制**。 */
  flush(): Promise<void>
  pendingCount(): number
  policy(): SessionCleanupPolicy
  /** 运行时改策略（设置页保存后调用），返回改完后的值。 */
  configure(next: Partial<SessionCleanupPolicy>): SessionCleanupPolicy
  /**
   * 只手动清理：不再自动到点删队列（0.6.11）。
   *
   * 链式投喂下必须打开 —— 会话是链的载体，自动删就等于替用户清上下文。
   * 关掉它（全量模式）时回到原来的"延迟/立即"自动清理。
   * ⚠️ 它只拦**自动**那一路：`flush()` 是显式动作，任何时候照样执行。
   */
  setManualOnly(value: boolean): void
}

export function createSessionCleaner(options: SessionCleanerOptions = {}): SessionCleaner {
  const policy: SessionCleanupPolicy = {
    mode: options.policy?.mode ?? DEFAULT_SESSION_CLEANUP.mode,
    delayMs: Math.max(0, Math.floor(options.policy?.delayMs ?? DEFAULT_SESSION_CLEANUP.delayMs)),
    batchSize: Math.max(1, Math.floor(options.policy?.batchSize ?? DEFAULT_SESSION_CLEANUP.batchSize)),
    // 没给区间（老调用方 / 老配置）→ 间隔为 0，也就是**不加额外间隔**，保持老行为。
    // 只有显式配了 gapRange 才启用"删一个歇一下"。
    gapMs: Math.max(
      0,
      Math.floor(options.policy?.gapMs ?? (options.policy?.gapRange ? DEFAULT_SESSION_CLEANUP.gapMs : 0)),
    ),
    // 区间是**可选**的：老调用方只传死 batchSize / delayMs 时，这里保持"无区间"= 固定值语义
    // （否则它们传的 3 会被默认区间 6~10 顶掉，单测与旧行为全乱）。
    ...(options.policy?.batchRange ? { batchRange: options.policy.batchRange } : {}),
    ...(options.policy?.delayRange ? { delayRange: options.policy.delayRange } : {}),
    ...(options.policy?.gapRange ? { gapRange: options.policy.gapRange } : {}),
  }
  /** 策略切换时按模式给默认延迟/批量（immediate 用老参数）。 */
  function applyModeDefaults(): void {
    if (policy.mode === 'immediate') {
      policy.delayMs = 1_500
      policy.batchSize = 1
    } else if (policy.mode === 'deferred' && policy.batchSize <= 1) {
      // 从「不删 / 立即」切回「延迟」时给一组新的随机值（不是写死的默认值）
      policy.delayMs = policy.delayRange
        ? pickInt(policy.delayRange)
        : DEFAULT_SESSION_CLEANUP.delayMs
      policy.batchSize = policy.batchRange
        ? pickInt(policy.batchRange)
        : DEFAULT_SESSION_CLEANUP.batchSize
    }
  }
  const doFetch = options.fetchImpl ?? fetch
  const setT = options.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = options.clearTimeoutImpl ?? ((t: any) => clearTimeout(t))
  const logger = options.logger

  let queue: { auth: WebAuth; sessionId: string }[] = []
  let timer: any
  /** 只手动清理（链式投喂下由宿主打开）：见 `setManualOnly` 的说明。 */
  let manualOnly = options.manualOnly === true
  /** 探测到服务端不接受批量删除后置位 —— 之后一律逐个删，不再浪费请求。 */
  let batchUnsupported = false

  const random = options.randomImpl ?? Math.random

  /** 在 [min, max] 里取整数（闭区间）。random 可注入，单测因此可重复。 */
  function pickInt(range: CleanupRange): number {
    const lo = Math.min(range.min, range.max)
    const hi = Math.max(range.min, range.max)
    if (hi <= lo) return lo
    // 注入的假随机源有可能返回 1，夹一下保证不越界
    return Math.min(hi, lo + Math.floor(random() * (hi - lo + 1)))
  }

  /**
   * 新的一轮清理开始（队列由空变非空）时重新抽：这一轮攒几个、最多等多久。
   *
   * 为什么按"轮"抽而不是每次都抽：阈值与等待时间要在一轮里保持稳定，
   * 否则"攒够 6~10 个"会退化成"好像随时都在触发"。每轮换一组，既有方差又不失节奏。
   */
  function rollCycle(): void {
    if (policy.mode !== 'deferred') return
    if (policy.batchRange) policy.batchSize = Math.max(1, pickInt(policy.batchRange))
    if (policy.delayRange) policy.delayMs = Math.max(0, pickInt(policy.delayRange))
  }

  /** 每次要发一个删除请求之前抽一次间隔（顺带记下当前值，供设置页显示）。 */
  function rollGap(): number {
    policy.gapMs = policy.gapRange ? Math.max(0, pickInt(policy.gapRange)) : Math.max(0, policy.gapMs)
    return policy.gapMs
  }

  /** 用注入的定时器睡一会儿（单测里就是"等假表被触发"）。 */
  function sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const handle = setT(() => resolve(), ms)
      ;(handle as any)?.unref?.()
    })
  }

  /** 装一次「到点清理」的表（已经装了就不动）。 */
  function armTimer(): void {
    if (timer !== undefined) return
    if (policy.mode === 'keep') return
    // 手动模式（链式投喂）：只攒着，等面板上那一下「立即清理」。
    if (manualOnly) return
    timer = setT(() => {
      void flush()
    }, Math.max(0, policy.delayMs))
    ;(timer as any)?.unref?.()
  }

  /**
   * 服务端"看起来接受了"：HTTP ok 且响应体里没有业务错误信封。
   *
   * 网页端会在 HTTP 200 上裹一层 `{code, msg, data:{biz_code,biz_msg}}` ——
   * 只看 `resp.ok` 会把"其实没删掉"当成成功（F07 踩过这个坑）。
   */
  /**
   * 批量删除的响应该怎么定性（0.1.82）。
   *
   * 三态而不是两态，因为"失败"里混着两类完全不同的东西：
   *  · `unsupported` —— 服务端**听懂了但拒绝**（4xx，或 HTTP 200 里裹业务错误信封，F07 形态）
   *    ⇒ 可以永久关掉批量，之后逐个删；
   *  · `transient` —— 5xx / 429 / 网关 HTML（非 JSON 正文）⇒ **瞬时**问题，
   *    据此永久关掉批量就会让此后每批退化成 N 个请求（自己把请求密度抬上去）。
   */
  async function classifyDeleteResp(resp: Response): Promise<'ok' | 'unsupported' | 'transient'> {
    if (!resp.ok) return resp.status >= 500 || resp.status === 429 ? 'transient' : 'unsupported'
    const text = await resp.text().catch(() => '')
    try {
      const json = text ? JSON.parse(text) : undefined
      if (json && envelopeError(json)) return 'unsupported'
      return 'ok'
    } catch {
      return 'transient'
    }
  }

  async function respLooksOk(resp: Response): Promise<boolean> {
    let ok = resp.ok
    if (ok) {
      const text = await resp.text().catch(() => '')
      try {
        const json = text ? JSON.parse(text) : undefined
        if (json && envelopeError(json)) ok = false
      } catch {
        ok = false
      }
    }
    return ok
  }

  /**
   * 删一个，返回**是否确认删掉** —— 删除回执要用来摘掉"欠删除"日志里的记录
   * （见 session-journal.ts：只有确认删掉才移记录，否则下次启动还来补删）。
   */
  async function deleteOne(auth: WebAuth, sessionId: string): Promise<boolean> {
    try {
      const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
        method: 'POST',
        headers: buildDsHeaders(auth),
        body: JSON.stringify({ chat_session_id: sessionId }),
        signal: AbortSignal.timeout(10_000),
      })
      return await respLooksOk(resp)
    } catch {
      return false // 清理失败不影响主流程
    }
  }

  /**
   * 删一批：优先一个请求批量删；服务端不接受则**逐个删**。
   *
   * 逐个删时两个请求之间会停一个随机间隔 —— 原来这里是**连发**（一批 20 个就是 20 个连续请求），
   * 那是最像脚本的部分。
   */
  async function deleteChunk(batch: { auth: WebAuth; sessionId: string }[]): Promise<void> {
    if (batch.length === 0) return
    // ⚠️ F07（2026-09-12 审计）：批量删除**只发一个凭证**（HTTP 请求只有一个 Authorization 头），
    // 若这一批里混了不同账号的会话，就等于「拿 A 的凭证去删 B 的会话」——
    // 轻则整批被服务端拒绝，重则 resp.ok 时被当成全部成功（旧代码 ok 就直接 return，
    // 不校验每个 id 是否真的删掉）。混号时退化为逐个删，逐个删用的是各自的 auth。
    const firstToken = batch[0].auth?.token
    const sameAccount = batch.every((item) => item.auth?.token === firstToken)
    if (batch.length > 1 && !batchUnsupported && sameAccount) {
      try {
        const resp = await doFetch(`${DS_BASE}/api/v0/chat_session/delete`, {
          method: 'POST',
          headers: buildDsHeaders(batch[0].auth),
          body: JSON.stringify({ chat_session_ids: batch.map((b) => b.sessionId) }),
          signal: AbortSignal.timeout(15_000),
        })
        const verdict = await classifyDeleteResp(resp)
        if (verdict === 'ok') {
          // 批量删只发一个请求，服务端接受即认为这一批都删掉了（它不逐个回报）。
          // 所以只对"同账号 + 无业务错误"的批次这样处理 —— 见上面的 F07 说明。
          for (const item of batch) emitSessionLifecycle({ kind: 'deleted', sessionId: item.sessionId })
          logger?.debug?.(`deepseek-web: 已批量清理 ${batch.length} 个临时会话（只用了 1 个请求）`)
          return
        }
        // ⚠️ 0.1.82：只有"服务端明确说不行"才能永久关掉批量 ——
        // 5xx / 429 / 网关 HTML / 非 JSON 正文都是**瞬时**问题，按旧写法一次抖动就
        // 让此后每批退化成 N 个请求（等于自己把请求密度抬上去）。
        if (verdict === 'unsupported') {
          batchUnsupported = true
          logger?.debug?.('deepseek-web: 服务端不接受批量删除会话，之后改为逐个删除')
        } else {
          logger?.debug?.(`deepseek-web: 批量删除本次失败（HTTP ${resp.status}），按瞬时问题处理，下次仍试批量`)
        }
      } catch {
        // 网络异常 ≠ 不支持，下次仍可尝试
      }
    }

    for (let i = 0; i < batch.length; i += 1) {
      if (i > 0) await sleep(rollGap())
      if (await deleteOne(batch[i].auth, batch[i].sessionId)) {
        emitSessionLifecycle({ kind: 'deleted', sessionId: batch[i].sessionId })
      }
    }
    logger?.debug?.(`deepseek-web: 已清理 ${batch.length} 个临时会话`)
  }

  /** 真正干活的清理。分片：队列积很多时也不一口气删完（见 MAX_IDS_PER_REQUEST 的说明）。 */
  async function doFlush(): Promise<void> {
    if (timer !== undefined) {
      clearT(timer)
      timer = undefined
    }
    const batch = queue
    queue = []
    try {
      if (batch.length === 0) return
      for (let i = 0; i < batch.length; i += MAX_IDS_PER_REQUEST) {
        if (i > 0) await sleep(rollGap())
        await deleteChunk(batch.slice(i, i + MAX_IDS_PER_REQUEST))
      }
    } catch (error: any) {
      // 清理失败不影响主流程
      logger?.debug?.(`deepseek-web: 会话清理出错（已忽略）：${error?.message ?? error}`)
    } finally {
      // 清理期间可能又攒了新的：重新装表，否则它们会一直躺在队列里没人管（直到下次有会话入队）
      if (queue.length > 0) armTimer()
    }
  }

  /**
   * 立即清理队列。
   *
   * **串行化**：上一次还没删完时，这一次排在它后面等 —— 否则两轮 flush 的删除请求会交错发出，
   * 正是我们要避免的"连发"。排队的 flush 轮到自己时才取队列，所以能带上期间新攒的会话。
   */
  let chain: Promise<void> = Promise.resolve()
  function flush(): Promise<void> {
    chain = chain.then(doFlush, doFlush)
    return chain
  }

  function schedule(auth: WebAuth, sessionId: string): void {
    if (policy.mode === 'keep') return
    // 队列由空变非空 = 新的一轮开始 → 重新抽本轮的阈值与最长等待
    if (queue.length === 0) rollCycle()
    queue.push({ auth, sessionId })
    // 落账：这个会话此刻**还没删**（排着队）。宿主据此落盘，进程被强杀后下次启动补删。
    emitSessionLifecycle({ kind: 'queued', auth, sessionId })
    // 只有 deferred 才「攒够就立即清理」。immediate 始终走延迟 —— 保持老行为：
    // 调用结束后过一会儿才删，避免「流刚结束就紧跟一个 DELETE」这种过紧的节奏。
    if (policy.mode === 'deferred' && queue.length >= policy.batchSize) {
      void flush()
      return
    }
    armTimer()
  }

  /**
   * 放弃待删队列 —— 只是**不删了**，绝不去删。
   *
   * 🔴 2026-10-01 实测 bug（用户报「我明明设了不删，会话还是被删了」）：
   * 旧实现在 `configure()` 里对 `mode === 'keep'` 调用的是 `flush()`，而 `flush()`
   * 是**真的发 DELETE**（`doFlush` → `deleteChunk`）。
   * 于是"用户点『不删』"这个动作，反而**立刻触发了一次批量删除** —— 语义完全相反。
   *
   * 另外必须逐条发 `abandoned`：journal 里这几条是"欠一次删除"的账，
   * 不销账的话，下次启动只要清理模式不是 keep，补扫就会把它们删掉。
   */
  function abandonQueue(): void {
    if (timer !== undefined) {
      clearT(timer)
      timer = undefined
    }
    const dropped = queue
    queue = []
    for (const item of dropped) emitSessionLifecycle({ kind: 'abandoned', sessionId: item.sessionId })
  }

  /**
   * 立刻丢掉**一个我们自己的脚手架会话**（内部请求用的那个），**不受清理策略影响**。
   *
   * 为什么要单独一条路：`keep`（用户选的「不删」）与 `manualOnly`（链式模式下攒着等手动清）
   * 都让 `schedule()` 变成空操作 —— 那对**用户的对话**是对的，对**我们自己建的会话**是错的。
   * 内部请求（`session-title` / 压缩之类）必须有一条会话才能调 completion，而那条会话
   * 既不是用户建的、用户也不需要它 —— 留在网页端就是**凭空多出来的一个会话**。
   *
   * 🔴 2026-10-02 用户现场：「刚在 dsh 中新建一个窗口聊天，就发了一句话，网页版直接俩窗口」。
   * `feed-decisions.jsonl` 里对上了：12:55:54 `new-session`（对话，`04c63135`）＋
   * 12:56:00 `no-parts`（内部请求，`de6a8d4f`）—— 后者正是网页端多出来的那一个，
   * 而且它**连 ledger 都没有**（keep 模式下 `schedule()` 直接 return，从没安排过删除）。
   *
   * ⚠️ 只删**这一个**，**不去 drain 队列**：`manualOnly` 下队列里攒的是用户的会话，
   * 借这次机会顺手把它们删掉，就变成"用户没点按钮却被删了"（0.6.1x 修过的那个 bug）。
   * ⚠️ 仍然受 `deleteWebSessions === false`（总闸）约束 —— 那个开关的语义是"一个都不许删"，
   * 接线在 adapter.ts。所以**关掉总闸时这类会话仍会留在网页端**，这是已知代价。
   */
  function discard(auth: WebAuth, sessionId: string): Promise<void> {
    // ⚠️ `deleteChunk` 调用必须留在**函数开头**：`check-bundle` 有一条守卫按
    // `function discard(…) {` 之后 90 字符定位它（`host 的 discard 删的是**那一个**会话`），
    // 在这里插别的东西会把它推出去、那条守卫会红。留痕因此放在**后面**。
    const p = deleteChunk([{ auth, sessionId }])
    // 🔴 0.6.41：留痕「这条脚手架会话**真的**被丢了吗」。
    //
    // 为什么必须记：2026-10-04 之前 `ledger` 只记请求结果（`ok:true`）、**不记删除**，
    // 所以「发一句话网页端建俩窗口」历史上出现过 14 次却**一次都查不了** ——
    // 分不清是"没走到 discard"还是"discard 了但 DELETE 没成功"。判据缺失就永远只能靠用户报。
    //
    // ⚠️ **没有 `blocked` 分支**：总闸在 `adapter.ts` 接线时判过
    // （`deleteWebSessions === false` 时 `onDiscardSession` 传 `undefined`）
    // ⇒ 能走到这里就说明总闸开着，在这里再判一次是重复判断、且拿不到配置。
    const trace = (outcome: 'sent' | 'failed', detail?: string) => {
      try {
        const dir = join(webLoginDir(), 'diagnostics')
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const file = join(dir, 'scaffolding-discards.jsonl')
        const line = JSON.stringify({ at: new Date().toISOString(), session: sessionId.slice(0, 8), outcome, detail }) + '\n'
        let size = 0
        try {
          size = statSync(file).size
        } catch {
          /* 首次写入 */
        }
        if (size + Buffer.byteLength(line) > 4_000_000) return
        appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
      } catch {
        /* 留痕失败不影响主流程 */
      }
    }
    return p.then(
      () => trace('sent'),
      (err: any) => trace('failed', String(err?.message ?? err).slice(0, 120)),
    )
  }

  function configure(next: Partial<SessionCleanupPolicy>): SessionCleanupPolicy {
    const modeChanged = next.mode !== undefined && next.mode !== policy.mode
    if (next.mode !== undefined) policy.mode = next.mode
    if (next.delayMs !== undefined) policy.delayMs = Math.max(0, Math.floor(next.delayMs))
    if (next.batchSize !== undefined) policy.batchSize = Math.max(1, Math.floor(next.batchSize))
    if (next.gapMs !== undefined) policy.gapMs = Math.max(0, Math.floor(next.gapMs))
    // 区间：给了就换；没给就保持原样（"缺省 = 不随机"的语义不能丢）
    for (const key of ['batchRange', 'delayRange', 'gapRange'] as const) {
      const value = next[key]
      if (value && Number.isFinite(value.min) && Number.isFinite(value.max)) {
        policy[key] = { min: Math.floor(Math.min(value.min, value.max)), max: Math.floor(Math.max(value.min, value.max)) }
      }
    }
    if (modeChanged) applyModeDefaults()
    // 切到「不删」= **放弃**这批待删（不是"删掉它们"）。见 abandonQueue 的说明。
    if (policy.mode === 'keep') abandonQueue()
    logger?.info?.(
      `deepseek-web: 会话清理策略已更新 —— ${policy.mode}` +
        (policy.mode === 'deferred'
          ? `（攒 ${policy.batchSize} 个或 ${Math.round(policy.delayMs / 1000)}s 后清理` +
            (policy.gapRange ? `；批量删除不受支持时逐个删，间隔 ${policy.gapMs}ms` : '') +
            '）'
          : ''),
    )
    return { ...policy }
  }

  return {
    schedule,
    discard,
    flush,
    pendingCount: () => queue.length,
    policy: () => ({ ...policy }),
    configure,
    setManualOnly: (value: boolean) => {
      manualOnly = value === true
      // 从"自动"切到"手动"时把已经装好的定时器撤掉，否则它到点仍会删一轮。
      if (manualOnly && timer !== undefined) {
        clearT(timer)
        timer = undefined
      }
      // 从"手动"切回"自动"时把表重新装上（队列里可能已经攒着东西了）。
      if (!manualOnly) armTimer()
    },
  }
}

/** 默认清理器（immediate 语义，兼容旧调用方）。 */
const defaultCleaner = createSessionCleaner({
  policy: { mode: 'immediate', delayMs: 1_500, batchSize: 1 },
})

export function scheduleDeleteSession(auth: WebAuth, sessionId: string): void {
  defaultCleaner.schedule(auth, sessionId)
}

/**
 * 丢掉一个**脚手架会话**（内部请求用的那个）—— 没有注入清理器时的兜底路径。
 * 语义与 `SessionCleaner.discard` 完全一致（不受 keep 影响）。
 */
export function discardSession(auth: WebAuth, sessionId: string): void {
  void defaultCleaner.discard(auth, sessionId)
}

/**
 * 「立即清理」用：把**当前在用的**网页端会话连同投喂链一起退掉，返回被退的会话 id。
 *
 * 为什么要有它：链式模式下不自动清理（会话就是链的载体），但用户总得有个"我现在就要
 * 把网页端清干净"的动作 —— 那就是面板上那颗按钮。退掉之后下一轮会新建一个干净会话、
 * 重新当链首（全量发一次），从用户视角就是"上下文从这里重新开始"。
 *
 * 只**退**不**删**：删除交给清理器（`flush()`）去做，这样"删"这条路仍然只有一个出口，
 * 也便于失败重试与落盘台账。
 */
export function clearLiveSession(): string[] {
  const ids = [...reuseSlots.values()].map((slot) => slot.sessionId)
  for (const id of ids) retireSession(id)
  return ids
}

/** 验证登录态：优先 users/current，端点不存在时退回 PoW challenge 探活。 */
/**
 * 从 `users/current` 的 user 对象里挑一个**能看的账号标识**。
 *
 * 两个必须记住的坑（都是实测踩出来的，2026-09-12）：
 *
 *  1. **不能用 `??` 串起来。** 接口对"没设邮箱"的账号会返回 `email: ""`，
 *     而空字符串**不是** nullish —— `"" ?? x` 的结果就是 `""`，整条回退链当场被它挡住，
 *     display 永远是空，界面只好退回去显示内部 id（`acc_cd8e05ec`）。
 *     所以必须按"**有内容**"取，跳过 undefined / null / 空白。
 *
 *  2. **字段名要和响应对齐。** 手机号是 `mobile_number`（不是 `mobile`），
 *     而且服务端返回的**已经是脱敏形态**（如 `183******78`），可以直接展示。
 *
 * 实测响应形状（只列相关字段）：
 *   { id, token, email: "", mobile_number: "183******78", area_code: "+86", chat: {...} }
 */
export function pickUserDisplay(user: any): string {
  const candidates = [
    user?.email,
    user?.mobile_number,
    user?.mobile,
    user?.phone,
    user?.username,
    user?.nickname,
    user?.name,
  ]
  for (const value of candidates) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

/**
 * 判定 `users/current` 的响应体**形状**是否可信。
 *
 * ⚠️ F09（2026-09-12 审计）：旧代码在 `resp.json()` 抛错时把 json 置为 undefined，
 * 而 `envelopeError(undefined)` 返回 undefined，于是径直走到 `ok: true`，
 * 返回一个**空壳的 user({})**。也就是说：反爬页 / WAF 拦截页 / 空响应
 * —— 它们同样是 HTTP 200 —— 会被当成"验证通过"。
 *
 * 后果很实际：探活显示"通过"、账号看起来正常，
 * 0.1.31 加的「需要重新登录」按钮就永远不会触发；什么都没确认到，却说成功。
 * 只读零额度请求偶发失败的代价只是一次重试，远比"误报成功"划算。
 *
 * 抽成纯函数是为了能单测（validateAuth 要发网络请求，测不了这条分支）。
 */
/**
 * 校验 `users/current` 的信封。**必须能辨认出一个用户身份**才算成功。
 *
 * 2026-09-13 第二轮审计 N09：旧实现只拒绝"不是对象"和"data、code 都缺"，
 * 于是 `{code:0}`、`{data:null}`、`{code:"401",data:null}` 这类空壳/错型信封全部被判成功 ——
 * 而 `validateAuth` 之后又会回落空对象，导致"校验成功"与"拿到有效身份"脱节。
 * 现在：业务码必须是数值、data 必须是对象、且里面要能找到一个可辨认的用户字段。
 */
export function classifyAuthEnvelope(json: unknown): { ok: true } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return fail('users/current 响应不是 JSON 对象（可能是反爬页面或网关拦截）')
  }
  const obj = json as any
  // 业务码必须是**数值**：字符串 "401" 这种错型信封不能当成功
  if (typeof obj.code !== 'number') return fail('users/current 缺少数值业务码（形状不符）')
  const bizError = envelopeError(obj)
  if (bizError) return fail(bizError.msg)
  if (obj.code !== 0 || !obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    return fail('users/current 缺少用户数据（形状不符）')
  }
  if (obj.data.biz_code !== undefined && typeof obj.data.biz_code !== 'number') {
    return fail('users/current 内层业务码无效')
  }
  const payload = obj.data.biz_data ?? obj.data
  const user = payload?.user ?? payload
  if (!user || typeof user !== 'object' || Array.isArray(user)) return fail('users/current 用户形状无效')
  const hasId =
    (typeof user.id === 'string' && user.id.trim().length > 0) ||
    (typeof user.id === 'number' && Number.isFinite(user.id))
  const named = ['email', 'mobile_number', 'mobile', 'phone', 'username', 'nickname', 'name'].some(
    (k) => typeof user[k] === 'string' && user[k].trim(),
  )
  // 空壳信封（data 里什么都没有）不能算校验成功
  return hasId || named ? { ok: true } : fail('users/current 缺少可辨认的用户身份')
}

export async function validateAuth(
  auth: WebAuth,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  user?: { id?: string; display?: string }
  /** F1（0.2.0）：users/current 自带的限流状态（chat.is_muted / mute_until），探活顺手带回。 */
  limit?: { muted: boolean; untilMs?: number }
  error?: string
}> {
  try {
    const resp = await activeFetch(`${DS_BASE}/api/v0/users/current`, { headers: buildDsHeaders(auth), signal })
    if (resp.ok) {
      let json: any
      try {
        json = await resp.json()
      } catch {
        json = undefined
      }
      // 形状校验（纯函数，见 classifyAuthEnvelope 的注释）
      const verdict = classifyAuthEnvelope(json)
      if (!verdict.ok) return verdict
      const payload = json?.data?.biz_data ?? json?.data
      const user = payload?.user ?? payload ?? {}
      const display = pickUserDisplay(user)
      // F1（0.2.0）：限流状态本来就躺在 users/current 的响应体里（2026-09-12 实测：
      // 受限期间 chat.is_muted / mute_until 有效）——顺手解析，探活就能"提前看见被限"，
      // 而不是等生成请求撞 muted 才知道。chat 字段缺失时**不带** limit（不猜）。
      const chat = payload?.chat
      const untilRaw = chat?.mute_until ?? payload?.mute_until
      const untilSec = typeof untilRaw === 'number' ? untilRaw : Number(untilRaw)
      const untilMs = Number.isFinite(untilSec) && untilSec > 0 ? Math.round(untilSec * 1000) : undefined
      return {
        ok: true,
        ...(chat && typeof chat.is_muted === 'boolean'
          ? { limit: { muted: chat.is_muted === true, ...(untilMs ? { untilMs } : {}) } }
          : {}),
        user: {
          ...(user?.id !== undefined ? { id: String(user.id) } : {}),
          ...(display ? { display } : {}),
        },
      }
    }
    if (resp.status === 404) {
      await createPowHeader(auth, '/api/v0/chat/completion', signal)
      return { ok: true }
    }
    return { ok: false, error: `users/current HTTP ${resp.status}` }
  } catch (error: any) {
    // ⚠️ 必须走 describeError（沿 cause 链）而不是 `error.message`：fetch 失败时
    // 外层只有一句 `fetch failed`，真正的原因（`net::ERR_NETWORK_IO_SUSPENDED` /
    // `getaddrinfo ENOTFOUND` / `ECONNREFUSED`）在 `cause` 里。
    // 2026-09-29 现场：面板上一排账号写着「校验失败：fetch failed」，无从判断是休眠还是断网。
    return { ok: false, error: describeError(error) }
  }
}

// ── SSE 流式解析 ──────────────────────────────────────────

export type WebStreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'status'; value: string }
  | {
      kind: 'finish'
      reason?: string
      /**
       * 服务端上报的**本消息**总 token 数（含 prompt + 回复 + 服务端自身开销）。
       * 实测 2026-09-13：9 字符 prompt → 38；12,424 字符 prompt → 6446；
       * 且同一会话第二轮仍只报自己的 38 → 是「本消息」而不是「会话累计」。
       * 拿不到时缺省（此时调用方退回按字符估算）。
       */
      totalTokens?: number
    }
  | {
      kind: 'error'
      message: string
      raw?: string
      /** 语义归类（如并发生成 → RATE_LIMIT），调用方据此决定重试 */
      code?: string
      retryAfterMs?: number
      /** RATE_LIMIT 细分：并发抢占（等对面写完）还是账号节流（等限流解除）—— 文案与退避都不同 */
      rateLimitKind?: 'concurrent' | 'throttled'
    }

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
export interface SseStateOptions {
  /**
   * 本轮请求是否开启了思考（对应请求体里的 `thinking_enabled`）。
   *
   * F25（2026-09-14，用真实帧复现）：正常流的**首帧快照**一定带一个 `type: "THINK"`
   * 的 fragment（抓包实测 4 轮全如此），之后思考全部通过
   * `response/fragments/-1/content` 与「无 path 的裸续段」续写 —— 也就是说
   * **思考的归属完全依赖那份快照**。一旦快照没能进入状态机（整帧丢失，或服务端
   * 先发了 `fragments: []` 的快照），`fragments` 就一直是空的，而旧实现在
   * 「无 fragment 可续」时**无条件当正文发射** ⇒ 整段思考上屏。
   *
   * 实测后果：09-14 一轮 2062 字符、09-12 两轮 10526 / 4360 字符的全部进正文，
   * 且这些正文块开头都缺几个字（"回答中文…" 本该是 "我们需要回答中文…"，
   * 缺掉的正是被丢弃的那份快照里的片段）—— 一个根因同时解释「整段上屏」与「缺开头」。
   *
   * 现在：开了思考却还没 fragment 时先**缓冲**，等 fragment 出现再定归属。
   * 未开思考时不缓冲（没有歧义），保持旧行为。
   */
  thinkingEnabled?: boolean
  /**
   * 本轮 assistant 的 message_id（链式投喂用）。
   *
   * 来源是流的**首帧** `event: ready`：`{"request_message_id":1,"response_message_id":2,...}`
   * （真实样本 `.workbuddy/tmp/shortq-r1-*.sse`）。下一轮就把它当 `parent_message_id` 发上去，
   * 服务端据此把新消息挂到上一条回答下面，于是历史由服务端维护、我们只发增量。
   *
   * 用回调而不是往 WebStreamEvent 里加一种 kind：新 kind 会流到 adapter 的事件消费处，
   * 那里对未知 kind 的处理没人守（多一种事件就多一处可能被当成"未知"丢掉）。
   */
  onResponseMessageId?: (id: number) => void
  /**
   * 宿主给的「当前账号被限流时，还能不能换号接着干」。
   *
   * 🔴 SSE 这条路径**必须**问它，而且答案要与 HTTP 那条路径一致：
   * 能换号 ⇒ 给短退避（2s），让调用方（dsh-llm-retry）立刻重发，由重发前的检查点换上可用账号；
   * 不能 ⇒ 给足渐长退避（40~117s）。
   *
   * 缺了它会怎样（实测 2026-09-27 14:35:32）：SSE 节流直接抛 49.2 秒，而 dsh-llm 的默认策略
   * 上限是 10 秒 ⇒ **一次都不重试**、整轮以 error 结束 ⇒ 用户得手点「继续」；
   * 而"能换号"的那套逻辑当时只挂在 HTTP 路径上，SSE（节流最常见的形态）根本走不到。
   */
  canFailover?: (kind?: 'muted' | 'throttled' | 'auth') => boolean
}

/** F28：思考的标准包装标签。孤儿兜底用（见 finish 里的判据）。 */
const THINKING_WRAPPER_RE = /<\s*\/?\s*(analysis|summary|thinking|scratchpad|thought)\b/i

/**
 * F28 取证开关：把原始 SSE 逐行落盘，给「孤儿思考归正文」这类通道错位定论用。
 * 默认关；设环境变量 `DSH_WEB_LOGIN_DUMP_SSE=1` 开启（需重启 DSH 生效）。
 * 文件写到 `~/.dsh/deepseek-web/frames/<时间戳>-<序号>.sse`，逐行 append ——
 * 就算进程被强杀，已收到的帧也在盘上（F24 的教训：别用构造帧当证据，要抓真实帧）。
 */
function dumpSinkPath(): string | null {
  if (process.env.DSH_WEB_LOGIN_DUMP_SSE !== '1') return null
  try {
    // ⚠️ 走 resolveDshHome()，别自己拼 `~/.dsh` —— 否则 DSH_HOME 换过环境时
    // 这份取证会写到别处（同一类问题刚在 feedDecisionLogPath 上踩过）。
    const dir = join(resolveDshHome(), 'deepseek-web', 'frames')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return join(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.sse`)
  } catch {
    return null
  }
}

export function createSseState(options: SseStateOptions = {}) {
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
  /**
   * F25：通道未知的暂存文本。只在「请求开了思考、但还没出现任何 fragment」时使用
   * —— 正常流不会走到这里（首帧快照就带着 THINK fragment）。
   */
  let orphanBuffer = ''
  const thinkingEnabled = options.thinkingEnabled === true
  let pendingFinish: string | undefined
  let sawData = false
  /** 服务端上报的本消息 token 总量（见 WebStreamEvent 的 totalTokens 说明）。 */
  let totalTokens: number | undefined

  const emit = (out: WebStreamEvent[], kind: 'text' | 'thinking', delta: string): void => {
    if (!delta) return
    if (kind === 'text') outText += delta
    else outThinking += delta
    out.push({ kind, text: delta })
  }
  const emitText = (out: WebStreamEvent[], delta: string): void => emit(out, 'text', delta)
  const emitThinking = (out: WebStreamEvent[], delta: string): void => emit(out, 'thinking', delta)

  /**
   * F25：把暂存文本按**刚出现的 fragment 类型**归属并发射。
   *
   * 真实帧（2026-09-14 抓，4 轮同构）显示两条规律：
   *   1. 思考的 fragment 由**首帧快照**建立；正文的 fragment 由 `response/fragments`
   *      的 APPEND 建立（`fragments+1 [RESPONSE]`）；
   *   2. 第一个 RESPONSE fragment 出现之前，流上的内容**全是思考**。
   *
   * 所以无论先到的是 THINK 还是 RESPONSE fragment，暂存的那段都应归思考 ——
   * 正文不会"先于自己的 fragment"出现在流上。这样即使快照整帧丢失，
   * 思考仍会回到思考通道，而不是被当成正文顶到用户脸上。
   */
  const settleOrphans = (out: WebStreamEvent[], firstType: string): void => {
    if (!orphanBuffer) return
    const text = orphanBuffer
    orphanBuffer = ''
    if (!isReasoningType(firstType)) {
      // 正文 fragment：它之前的内容只可能是思考（见上面的规律 2），仍归思考。
    }
    directThinking += text
    emitThinking(out, text)
  }

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
  const replaceFragments = (list: any[], out: WebStreamEvent[]): void => {
    fragments.length = 0
    for (const f of list) {
      if (f && typeof f === 'object' && typeof f.content === 'string') {
        fragments.push({ type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 })
      }
    }
    rebuildFragmentText()
    sink = fragments.length > 0 ? 'fragments' : null
    // F25：快照迟到时（正常是流的第一帧），先把之前"无归属"的文本结算掉。
    if (fragments.length > 0) settleOrphans(out, fragments[0].type)
  }
  /** 增量：追加 fragment（其 content 属于新内容 → 直接发射）。 */
  const appendFragments = (incoming: any, out: WebStreamEvent[]): void => {
    const list = Array.isArray(incoming) ? incoming : incoming !== undefined ? [incoming] : []
    let settled = false
    for (const f of list) {
      if (!f || typeof f !== 'object' || typeof f.content !== 'string') continue
      const fragment: Fragment = { type: String(f.type ?? 'RESPONSE'), content: f.content, emitted: 0 }
      // F25：第一个 fragment 出现之前攒下的文本先定归属（必须在发射本 fragment 之前）。
      if (!settled) {
        settled = true
        settleOrphans(out, fragment.type)
      }
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
      // 没有 fragment 可续 → 这段文字不是"续写 fragment"，而是**当前通道的裸续段**，必须尊重 sink。
      //
      // F24（实测）：思考阶段服务端就是分两步下发的 —— 先 `response/thinking_content` 发开头
      // 一小段（建立 sink='thinking'），再用 `response/fragments/-1/content` 发**思考的其余全部**。
      // 旧实现在这里无条件当正文发射，于是一整段思考被上屏：268 条 assistant 消息里 7 条中招
      // （5016~14877 字符），且这些正文块开头都缺 2~4 个字符（" me analyze…" 本该是
      // "Let me analyze…"）—— 缺掉的正是先走 thinking 通道的那一小段，两处现象由这一分支同时解释。
      //
      // sink 未建立时**保持旧行为**（当正文）：服务端也可能首帧就发 -1/content，
      // 那种情况没有通道信息可用，当正文是唯一合理的兜底（不能为了修这个而丢字）。
      if (sink === 'thinking') {
        directThinking += text
        emitThinking(out, text)
        return
      }
      if (sink === 'content') {
        directText += text
        emitText(out, text)
        return
      }
      // F25：请求开了思考、却还没有任何 fragment 可续 —— 正常流里首帧快照一定带 THINK
      // fragment，走到这里说明那份快照没能进入状态机（丢失 / fragments 为空）。
      // 这段文字极可能是思考的尾巴，先攒着，等 fragment 出现再定归属（见 settleOrphans）。
      // 旧实现在这里无条件当正文发射，就是"整段思考上屏"的直接原因。
      if (thinkingEnabled) {
        orphanBuffer += text
        return
      }
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
    } else {
      // 0.1.82：`sink` 还没定（快照整帧丢失 / `fragments` 为空）时**不能丢字** ——
      // 与 `appendToLastFragment` 的兜底对齐。按本文件自己的纪律：
      // 两种错法代价不对等（当正文吐出去最多是难看，丢掉就是正文缺一段）。
      directText += text
      emitText(out, text)
    }
  }

  return {
    /** 负载处理（增量直接发射；快照只对账）。 */
    handlePayload(d: any, eventName?: string): WebStreamEvent[] {
      const out: WebStreamEvent[] = []
      sawData = true
      // 0) 首帧 `event: ready`：把本轮 assistant 的 message_id 交给调用方（链式投喂要用）。
      //    不 return：这里的判据只看字段本身，`ready` 的负载不会命中下面的任何分支，
      //    这样即使服务端某天不带 `event: ready` 那行，只要字段还在就照样能拿到。
      if (d && typeof d === 'object' && typeof (d as any).response_message_id === 'number') {
        options.onResponseMessageId?.((d as any).response_message_id)
      }
      // 1) 完整 response 快照
      if (d && typeof d === 'object' && d.v && typeof d.v === 'object' && d.v.response && typeof d.v.response === 'object') {
        const response = d.v.response
        if (Array.isArray(response.fragments)) {
          replaceFragments(response.fragments, out)
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
      // 2) 模型错误事件：按语义归类（并发生成 → 可重试的 RATE_LIMIT），调用方据此决定重试还是报错
      if (d && typeof d === 'object' && d.type === 'error') {
        const message = typeof d.content === 'string' ? d.content : typeof d.message === 'string' ? d.message : 'model error'
        const event: WebStreamEvent & { raw?: string } = {
          kind: 'error',
          message,
          ...(d.finish_reason !== undefined ? { raw: String(d.finish_reason) } : {}),
        }
        if (isBusyGenerating(message)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = 5_000
          event.rateLimitKind = 'concurrent'
        } else if (isThrottled(message)) {
          // 账号级节流（「消息发送过于频繁，请稍后重试」）：能换号就立刻重发（由重发前的
          // 检查点换号），不能换号才给渐长退避。
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = throttleRetryAfterMs(options.canFailover)
          event.rateLimitKind = 'throttled'
        }
        out.push(event)
        return out
      }
      // 3) SSE 命名事件（title 忽略；toast 视为提示性错误）
      if (eventName === 'toast') {
        const message = d && typeof d === 'object' ? (d.content ?? d.message ?? JSON.stringify(d)) : String(d)
        const full = `DeepSeek toast: ${String(message).slice(0, 200)}`
        const event: WebStreamEvent = { kind: 'error', message: full }
        if (isBusyGenerating(full)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = 5_000
          event.rateLimitKind = 'concurrent'
        } else if (isThrottled(full)) {
          event.code = 'RATE_LIMIT'
          event.retryAfterMs = throttleRetryAfterMs(options.canFailover)
          event.rateLimitKind = 'throttled'
        }
        out.push(event)
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
              // F24：只有**真的续到 fragment 上**才把 sink 切到 'fragments'。
              // fragments 为空但已建立 thinking/content 通道时必须保持原通道 ——
              // 否则紧接着的裸续段会因 sink='fragments' 又退回"当正文"，等于没修。
              const keepChannel = fragments.length === 0 && (sink === 'thinking' || sink === 'content')
              if (!keepChannel) sink = 'fragments'
            }
            return out
          }
          case 'response/fragments/-1/elapsed_secs': {
            // F27：这是「刚结束的是一段**思考**」的直接证据 —— 真实帧里它紧跟 THINK fragment
            // 出现、值就是该段思考的耗时（正文 fragment 上的这个字段是 null）。
            // 快照丢失时，它能告诉我们暂存的那段文本到底属于哪个通道。
            if (typeof value === 'number' && value > 0) settleOrphans(out, 'THINK')
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
          case 'accumulated_token_usage':
            // 兼容：万一服务端直接以顶层路径下发（真实样本是裹在 response/BATCH 里的，见上）。
            // ⚠️ 快照里的那个字段初始恒为 0（status 还是 WIP），**不要**拿它当结果 ——
            // 判定脚本第一版就是取了末尾快照的 0，结论整个反过来。
            if (typeof value === 'number' && Number.isFinite(value)) totalTokens = value
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
                // 真实形态（2026-09-13 抓包）：
                //   {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38}, …]}
                // 它在**内层 op** 里，不是顶层 case —— 第一版补丁插错层级，测试直接抓到。
                if (op && typeof op === 'object' && op.p === 'accumulated_token_usage') {
                  if (typeof op.v === 'number' && Number.isFinite(op.v)) totalTokens = op.v
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
      const out: WebStreamEvent[] = []
      // F27（2026-09-14，修订 F25 的兜底）：整轮都没等到任何 fragment 时**按正文收尾**。
      //
      // F25 当初按"开了思考就归思考"收尾，理由是"避免以正文的名义补发思考"。但那个方向
      // 有一个更糟的失败模式：**万一暂存里其实是正文，回答就从界面上消失了** ——
      // 用户只看到一段思考、正文空白，会以为模型没回答（实测反馈："正文的内容卡在思考里"）。
      // 两种错法的代价不对等：
      //   · 思考被显示到正文 → 内容都在，用户读得懂这是思考；
      //   · 正文被吞进思考 → 用户看不到回答，是明确的功能故障。
      // 所以无线索时一律归正文。有 fragment 的正常/异常路径不受影响（由 settleOrphans 结算）。
      if (sawData && orphanBuffer) {
        const text = orphanBuffer
        orphanBuffer = ''
        // F28（2026-09-14，第二次修订兜底）：兜底方向维持 F27 的"归正文"，但**加一条标签判据** ——
        // 孤儿文本以 <analysis>/<summary> 这类**思考的标准包装**为主体时归思考。
        // 依据（实测 [998]/[1091] 两条消息）：text 块 27397 字**整块**都是 analysis+summary 复盘、
        // 没有一句对用户说的话 —— 模型不会把整条回答写成纯复盘 ⇒ 那是思考。
        // 反过来，普通正文几乎不会以这些标签为主体，误伤面很小。
        // 其余无线索的孤儿仍按正文收尾（F27 的原则不变：看不到回答比看到思考更糟）。
        if (thinkingEnabled && THINKING_WRAPPER_RE.test(text)) {
          directThinking += text
          emitThinking(out, text)
        } else {
          directText += text
          emitText(out, text)
        }
      }
      if (!sawData) return out
      out.push({ kind: 'finish', reason: pendingFinish, ...(totalTokens !== undefined ? { totalTokens } : {}) })
      return out
    },
    /** 诊断：已发射正文/思考长度与快照分歧次数（单测与排查用）。 */
    stats(): { text: string; thinking: string; divergences: number; orphanLen?: number; totalTokens?: number } {
      return {
        text: outText,
        thinking: outThinking,
        divergences,
        ...(orphanBuffer ? { orphanLen: orphanBuffer.length } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      }
    },
  }
}

/** 解析 /chat/completion 的 SSE 字节流，产出增量文本/思考事件。 */
export async function* parseWebSse(body: any, options?: SseStateOptions): AsyncGenerator<WebStreamEvent> {
  const state = createSseState(options)
  let eventName = ''
  /**
   * F13（2026-09-12 审计）：SSE 规范允许一个事件里出现**多个** `data:` 行，
   * 收齐后要用 `\n` 拼接再整体解析。旧实现逐行 `JSON.parse`，一旦服务端把一个
   * JSON 拆到多行（或 payload 里本身含换行），每行都解析失败 → 被
   * `catch { continue }` 静默丢弃，表现为「流突然断了/少了一段」且无任何报错。
   */
  let dataLines: string[] = []
  const flushData = (): { events: WebStreamEvent[]; done: boolean } => {
    if (dataLines.length === 0) return { events: [], done: false }
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (data.length === 0) return { events: [], done: false }
    if (data === '[DONE]') return { events: Array.from(state.finish()), done: true }
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return { events: [], done: false }
    }
    return { events: Array.from(state.handle(parsed, eventName)), done: false }
  }

  // F28 取证：开关开着就把原始帧逐行落盘（见 dumpSinkPath 的说明），失败不影响主流程。
  const dumpPath = dumpSinkPath()
  for await (const line of iterateLines(body)) {
    if (dumpPath) {
      try {
        appendFileSync(dumpPath, line + '\n')
      } catch {
        /* 取证是尽力而为 */
      }
    }
    if (line.length === 0) {
      // 空行 = 事件结束
      const flushed = flushData()
      for (const event of flushed.events) yield event
      if (flushed.done) return
      eventName = ''
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      // 新事件名出现 = 上一个事件结束（有些实现不补空行，这里也要收口）
      const flushed = flushData()
      for (const event of flushed.events) yield event
      if (flushed.done) return
      eventName = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
      continue
    }
  }
  // 流结束：末尾可能没有空行，攒下的 data 不能丢
  const tail = flushData()
  for (const event of tail.events) yield event
  if (tail.done) return
  for (const event of state.finish()) yield event
}

// ── 完成请求 ──────────────────────────────────────────────

// ── 会话复用（2026-09-12 实测判定后新增）────────────────────

/**
 * 复用一个网页端会话最多发多少次请求，超过就换一个新的；0 = 关闭复用（回到「每请求一个会话」）。
 *
 * 为什么可以复用（**实测**，不是推理）：
 * 每次 completion 都发 `parent_message_id: null` → 每条消息都是会话里的**根消息**、没有父链，
 * 服务端按消息树回溯上下文时回溯到空。判定实验（2026-09-12）：同一会话先发
 * 「记住编号 ZC-7391-KX，只回 OK」→ 得到 `OK`；再问「编号是什么」→ 答 `不知道`。
 * 证明同会话历史**不会**进入上下文。
 * （0.1.21 注释里「复用会让上下文翻倍」的说法是未经实测的推理，已被这次实验推翻。）
 *
 * 收益：实测 2026-09-12 一天建了 182 个网页端会话（峰值 74 个/小时、最密 8 个/分钟），
 * 因为每个 DSH 回合 = 建一个会话、用完再删一个 —— 真人不会这样建删对话。
 * 复用后建会话数降到「轮次 / N」。
 */
export const DEFAULT_SESSION_REUSE_TURNS = 20

/** 复用槽：同一账号当前可复用的会话。key 是凭证摘要（不进日志、不拿明文当键）。 */
/**
 * 复用槽。`cleanup` 记录**这个会话归谁回收**（2026-09-13 审计 N04）：
 * 切号时旧槽要交回**原账号**的清理回调，不能用当前账号的去删别人的会话。
 *
 * 🔴 0.6.12：**按 DSH 会话来分**（不再是全局单槽）。宿主给适配器的 `GenerateOptions`
 * 里有 `sessionId`（宿主内核类型定义原话："Session identity stamped by the loop for
 * listener routing"）—— 一个 DSH 窗口/对话一个值。以前不区分 ⇒ 换窗口的请求会落进上一个
 * 窗口的网页端会话（用户报"换个窗口就把上下文清一次、网页端还长出一堆 n/n 分支"）。
 * 现在：**一个 DSH 会话 = 一个网页端会话 + 一条链**，切回来还能接着用自己那条。
 * 拿不到 sessionId 时（老版本宿主 / 手工构造的请求）退化成共用一个 `(unknown)` 槽。
 */
interface SessionSlot {
  /** 归属键（账号 + DSH 会话），换账号或换窗口都不会串。 */
  key: string
  sessionId: string
  turns: number
  /** 最近一次使用的时刻，用来淘汰最久没用的那条。 */
  at: number
  cleanup?: (id: string) => void
}
const reuseSlots = new Map<string, SessionSlot>()

/**
 * 同时最多养几条会话（＝几个 DSH 窗口）。
 * 超了只淘汰**最久没用**的那条**内存槽**（0.6.23 起不再删网页端会话，见 evictIdleSlots）。
 */
export const MAX_CONVERSATION_SLOTS = 6

/** 槽/链的归属键：账号 + DSH 会话 id。 */
function slotKeyFor(auth: WebAuth, dshSessionId?: string): string {
  const sid = typeof dshSessionId === 'string' && dshSessionId.trim() ? dshSessionId.trim() : '(unknown)'
  return `${accountKey(auth)}|${sid}`
}

/**
 * 这一次请求该落在哪个槽上。
 *
 * 🔴 **内部请求不占用对话的槽**（2026-10-01 用户截图实锤）。
 *
 * `session-title`（以及压缩之类的内部请求）**不带结构化 promptParts**，但它们和对话
 * 共用同一个 DSH sessionId。于是新开一个窗口、只发一句"在？"的时序是：
 *
 *   ① `session-title` 先到 → 建会话 → 发一条**根消息**（那段 `Create a concise title…`）
 *   ② 用户的真实消息随后到 → **复用**这个会话 → 但内部请求不传 parts、没有链
 *      ⇒ `decideFeed` 只能 `detach('no-chain')` ⇒ **又是根消息**
 *
 * 服务端把这两条看成**同一条用户消息的两个版本** ⇒ 网页端显示「修改」+ `2 / 2`，
 * 而且标题 prompt 直接暴露在用户的对话里。
 *
 * 分开之后：对话槽里的第一条消息**永远**是这个窗口真正发出的那一条，根消息只有一条。
 * 代价是内部请求自己占一个（按账号共享的）会话，它不出现在对话里。
 */
function requestSlotKey(auth: WebAuth, params: { dshSessionId?: string; promptParts?: unknown }): string {
  return params.promptParts ? slotKeyFor(auth, params.dshSessionId) : `internal|${accountKey(auth)}`
}

/**
 * 链式投喂的链状态（2026-09-14）。0.6.12 起**按 DSH 会话分开**（与复用槽同一把键）：
 * 每条链只跟随它自己那个网页端会话的复用；会话轮换、切号、请求失败/取消、流被污染，
 * 都会让**那一条**作废 —— 下一轮自动退回全量重发。
 * 判定逻辑在 context-feed.ts（纯函数），这里只负责"喂进去 + 按结果记下来"。
 */
const contextChains = new Map<string, ChainState>()
/** 最近用过的链归属键 —— 面板只展示"当前那条"，用它定位。 */
let lastChainKey: string | undefined
/**
 * 最近一次"收尾把会话退役"的原因（0.6.16）。
 *
 * 为什么要有它：2026-10-01 那次"每轮新建一个网页端会话（旧会话还被删了）"查了一整轮 ——
 * 判据只在"原因变化时"写宿主日志、而宿主日志不落盘，最后靠**往产物里插桩**才定位到。
 * 现在原因直接挂在 `/context-mode` 的 `chain` 上：`not-finished` 就是那条 bug 复发。
 */
let lastRetireReason: string | undefined

/**
 * 服务端**已知**的图片 file_id（0.1.83）：本会话内已经随请求发出去过的那批。
 *
 * 只用于链式投喂：走 `chained`（有父链）时服务端会回溯历史、那张图已经在它的上下文里，
 * 于是每轮重带整批是纯冗余 —— 真机实测见 tests/probe-image-chain.mjs。
 * 会话换掉就整批作废：新会话没有那份历史。
 *
 * 🔴 0.6.27：改成**按会话分别记账**（原来是「一个全局 Set + 一个 sentRefIdsSession 变量」）。
 *
 * 旧写法在**多窗口并发**下会互相覆盖，链条是：
 *   ① 窗口 A 的请求进来 → `sentRefIdsSession !== A` ⇒ `sentRefIds` **清空**、记成 A
 *   ② 窗口 B 的请求进来（A 还没回来）→ `sentRefIdsSession !== B` ⇒ **又清空**（A 的账没了）
 *   ③ A 的下一轮进来 → `sentRefIdsSession` 是 B ⇒ **再清一次**
 *   ⇒ A 里"早就发出去过"的图每轮都被当成没发过 ⇒ **反复重发**，
 *     网页端于是把那些图挂到了**后面的每一条消息**上。
 *
 * 用户现场（2026-10-02）：「我这轮没发图片，网页端却又有图片了」——
 * 那张图确实是他早先发的，但它被重复挂到了不含图的那几条消息上。
 */
const sentRefIdsBySession = new Map<string, Set<string>>()

/** 会话退役时连它的图片账一起销掉（否则 Map 会跟着开过的窗口一直涨）。 */
function dropSentRefIds(sessionId: string): void {
  sentRefIdsBySession.delete(sessionId)
}

/**
 * 上一次上报过的决策原因（0.1.63）。链式投喂的决策每轮都在做，
 * 但"原因"通常连续几百轮都不变 —— 只在**变化时**上报，日志才不会被刷满，
 * 同时"哪一轮开始退回全量、为什么"又一定能看见。
 */
let lastFeedReason: FeedReason | undefined

/**
 * 投喂决策留痕的路径（与 gate.json 同目录）。
 * ⚠️ 必须走 `webLoginDir()` —— 曾经这里自己拼了一遍 `DSH_HOME || ~/.dsh`，
 * 于是"测试隔离"只对走 webLoginDir 的模块生效，这一条照旧写进用户的真实目录
 * （2026-10-02：一次 `npm run test` 往用户的 `feed-decisions.jsonl` 灌了 695 条测试噪声，
 * 手工过滤才看得清真实数据）。路径只能有一个来源。
 */
export function feedDecisionLogPath(): string {
  return join(webLoginDir(), 'feed-decisions.jsonl')
}

/** 留痕保留多少条（环形）。 */
export const FEED_DECISION_KEEP = 300
/** 超过这个字节数就裁剪一次（`statSync` 很便宜，不必每次读全文件）。 */
const FEED_DECISION_MAX_BYTES = 256 * 1024

/** 一轮投喂决策的**结构性**事实（不记任何内容）。 */
export interface FeedDecisionNote {
  at: number
  /** `chained` = 真的只发了增量；其余都是"重发全量"的具体理由。 */
  reason: FeedReason
  /** 这一轮的网页端会话是不是复用来的。 */
  reused: boolean
  /** 网页端会话 id 前 8 位。 */
  session: string
  /** 账号键前 8 位（切号会让它变）。 */
  account: string
  /** 链里已发出的条目数（没有链时 null）。 */
  chainLen: number | null
  /** 本轮结构化条目的条数。 */
  entriesLen: number | null
  /**
   * 🔴 **链尾是否仍在本轮的同一位置** —— 这是 `canExtendChain` 第二条判据的直接答案，
   * 也是"这一轮为什么没续链"最有用的一条：`false` 说明 DSH 的历史被改写过，
   * `null` 说明这一轮压根没传结构化 prompt。
   */
  tailSame: boolean | null
  /**
   * 这一轮**实际发出去的**字符数（`feed.prompt.length`）。
   *
   * 🔴 为什么必须记（2026-10-02 用户报"每次调用工具就重发一大段"被发现查不了）：
   * 上面那几个字段只回答"**为什么**走了全量"，回答不了"**发了多大**"。
   * 而"发了多大"才是"是不是在烧额度 / 像不像脚本"的直接证据 ——
   * 没有它就只能靠读分享页去**估**，估出来的数字不能用来说服任何人（包括自己）。
   */
  promptChars: number
  /** 固定头（system + 协议指令 + 工具目录）的字符数；没有结构化 prompt 时 null。 */
  headChars: number | null
  /**
   * 🔴 **本轮和链从第几个条目开始不一样**（链不在或没传结构化 prompt 时为 null）。
   *
   * 为什么必须有（2026-10-02 第三次排查仍然卡在这）：`tailSame=false` 只说"链尾变了"，
   * 不说**是哪一条、从哪儿变的**。于是"为什么这一轮又断链"只能靠猜 ——
   * 而断链的代价是重发（实测过一次：5 个字的输入发出去 40193 字符）。
   * 有了它，一眼能看出是"DSH 原地改写的那条运行时注入（比如下标 3）"还是"尾部被改了"。
   */
  firstDiff: number | null
  /**
   * 这一轮**发出去的提示词的结构**（只记条数，不记内容）。
   *
   * 🔴 为什么要有（2026-10-02 用户反复问"是不是把答案直接告诉模型了"）：
   * 只看字符数回答不了"提示词里**有没有**模型的旧回答" —— 而这一条恰恰是用户最关心的。
   * 现在不用去读分享页**估**，直接查：`assistant` > 0 就是"把模型自己说过的话又发了一遍"，
   * `toolResult` > 0 才是工具返回（那是**正常且必要**的：模型调用工具，工具结果必须回灌）。
   * ⚠️ 两者看起来都像"答案在提示词里"，但一个是缺陷、另一个是机制 —— 必须能一眼分开。
   */
  stats: {
    assistant: number
    user: number
    toolResult: number
    systemBlocks: number
  }
}

/**
 * 记一轮投喂决策。
 *
 * 为什么必须有它（2026-10-01 两次排查都被它卡住）：
 * 判据只在**原因变化时**打 `链式投喂退回全量重发（原因=X）`，而**宿主日志不落盘** ——
 * 真机上根本查不到"这一轮为什么没走增量"，最后只能往已安装的产物里插桩。
 * 把决策要素落成 jsonl 之后，直接读文件就能回答，不必再占一个发版周期。
 *
 * ⚠️ 只记**结构性事实**（长度 / 原因 / 是否复用 / 链尾是否还在原位），不记内容。
 */
function noteFeedDecision(note: FeedDecisionNote): void {
  try {
    const file = feedDecisionLogPath()
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, `${JSON.stringify(note)}\n`, 'utf8')
    if (statSync(file).size > FEED_DECISION_MAX_BYTES) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      writeFileSync(file, `${lines.slice(-FEED_DECISION_KEEP).join('\n')}\n`, 'utf8')
    }
  } catch {
    /* 留痕失败不影响请求主流程 */
  }
}

/** 丢弃当前的链（会话退役/测试隔离用）。 */
export function resetContextChain(): void {
  contextChains.clear()
  lastChainKey = undefined
  lastFeedReason = undefined
}

/** 给状态页看：当前链式投喂是否真的在跑（没用链式就返回 undefined）。 */
export function contextChainInfo():
  | { sessionId: string; turns: number; parentId: number; slots: number }
  | undefined {
  const chain =
    (lastChainKey !== undefined ? contextChains.get(lastChainKey) : undefined) ??
    [...contextChains.values()].pop()
  if (!chain) return undefined
  return {
    sessionId: chain.sessionId,
    turns: chain.entries.length,
    parentId: chain.parentId,
    // 同时养着几条会话（＝几个 DSH 窗口各一条）
    slots: reuseSlots.size,
    // 上一次收尾为什么把会话退役了（`rotated` 是正常轮换；`not-finished` 是异常）。
    ...(lastRetireReason ? { lastRetire: lastRetireReason } : {}),
  }
}

/** 凭证摘要：只用来判断「是不是同一个账号」。不做安全用途、不落日志。
 *
 * 🔴 0.6.18：改用服务端返回的 `user.id` 当稳定身份。旧实现把 `token|cookie` 当身份，
 * 而 token 每 2 小时左右就会刷新（自动/手动重登）⇒ 刷新后插件认为是「换了账号」，
 * 旧网页端会话被退役删除、投喂链也断了，用户看到的就是「聊了几句会话就没了、下一句又建新会话」。
 * `user.id` 是账号在服务端的真实身份，稳定不变；没有时才回退到 token+cookie。
 */
function accountKey(auth: WebAuth): string {
  const userId = auth?.user?.id
  const raw = typeof userId === 'string' && userId ? `uid:${userId}` : `${auth?.token ?? ''}|${auth?.cookie ?? ''}`
  let hash = 2166136261
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

interface SessionLease {
  sessionId: string
  reused: boolean
}

async function leaseSession(
  auth: WebAuth,
  signal: AbortSignal,
  transport: CompletionTransport,
  maxTurns: number,
  cleanup?: (id: string) => void,
  /**
   * 强制换一个新会话（0.6.10）。给"重开链"用：那时要发根消息，必须在一个干净会话里发
   * （见 `context-feed.ts` 的 `needsFreshSession`）。走的是与"轮换"同一条路 ——
   * 建新会话 + 把它放进复用槽 + 把旧槽交回给它自己的 cleanup。
   */
  forceNew = false,
  /** 归属键（账号 + DSH 会话）。见 `slotKeyFor`。 */
  slotKey = '',
): Promise<SessionLease> {
  signal.throwIfAborted()
  const key = slotKey || accountKey(auth)
  const configured = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : DEFAULT_SESSION_REUSE_TURNS
  // 链式模式下不轮换（会话就是链的载体，轮换＝定期清上下文）—— 判据是纯函数，有用例。
  const limit = effectiveReuseLimit(configured, currentContextMode())
  // 关闭复用：每次都要新会话（调用方会自己回收）
  if (limit === 0) return { sessionId: await transport.createSession(auth, signal), reused: false }
  const slot = reuseSlots.get(key)
  if (!forceNew && slot && slot.turns < limit) {
    slot.turns += 1
    slot.at = Date.now()
    return { sessionId: slot.sessionId, reused: true }
  }
  // ⚠️ N04：轮换/切号时，旧槽必须交给**它自己的** cleanup 归还。
  // 旧实现只在"同账号轮换"时返回 retired、切号时直接覆盖旧槽 ——
  // 后者等于把旧会话的清理归属丢掉了（永远不会有人删它）。
  const previous = slot
  const sessionId = await transport.createSession(auth, signal)
  if (signal.aborted) {
    // 建会话期间被取消：这个会话还没人认领，就地回收，别留垃圾
    try {
      cleanup?.(sessionId)
    } catch {}
    signal.throwIfAborted()
  }
  reuseSlots.set(key, { key, sessionId, turns: 1, at: Date.now(), ...(cleanup ? { cleanup } : {}) })
  // 淘汰最久没用的那些窗口（连同它们的网页端会话一起删）—— 见 MAX_CONVERSATION_SLOTS。
  evictIdleSlots()
  // 落账：这个会话进了复用槽，此刻**还没删**。宿主据此落盘 —— 否则进程被强杀时
  // 槽里的会话（每次退出必留一个）永远没人回收。
  emitSessionLifecycle({ kind: 'leased', auth, sessionId })
  if (previous) {
    try {
      previous.cleanup?.(previous.sessionId)
    } catch {}
  }
  return { sessionId, reused: false }
}

/**
 * 槽数超过上限时，把**最久没用**的那些从内存里淘汰掉。
 *
 * 🔴 0.6.23：这里**不再删网页端会话**（旧实现做 `retireSession` + `cleanup`，也就是排队 DELETE）。
 *
 * 两个理由，都是用户明确提的：
 *  1. **"回到原来的窗口还要能接着聊"** —— 把会话删了，等于把他那个窗口的上下文扔了；
 *     他只能得到一个空白的新会话。槽是内存态、淘汰本来就不该有"销毁用户数据"的副作用。
 *  2. **"删"本身是最强的机器特征之一**：真人不会每开一个新窗口就顺手删掉一个旧对话。
 *     网页端留着的会话由用户自己管理（面板有「立即清理」，设置里也有清理策略）。
 *
 * 链一并清掉：槽没了的窗口下一轮会拿到**新会话**（`reused=false` ⇒ `detach('new-session')`），
 * 旧链再留着只会指向一个这个窗口已经不用的会话。
 */
function evictIdleSlots(): void {
  if (reuseSlots.size <= MAX_CONVERSATION_SLOTS) return
  const idle = [...reuseSlots.values()].sort((a, b) => a.at - b.at)
  for (const slot of idle.slice(0, reuseSlots.size - MAX_CONVERSATION_SLOTS)) {
    reuseSlots.delete(slot.key)
    contextChains.delete(slot.key)
    dropSentRefIds(slot.sessionId)
    if (lastChainKey === slot.key) lastChainKey = undefined
  }
}

/** 把某个会话从复用槽里摘掉（会话失效 / 请求失败时调用，下次会新建）。 */
export function retireSession(sessionId?: string): void {
  if (!sessionId) {
    reuseSlots.clear()
    contextChains.clear()
    sentRefIdsBySession.clear()
    lastChainKey = undefined
    return
  }
  dropSentRefIds(sessionId)
  for (const [key, slot] of [...reuseSlots]) {
    if (slot.sessionId === sessionId) reuseSlots.delete(key)
  }
  // 会话被退役 ⇒ 它的链也失效（留着会让下一轮"续"到一个已经不存在的父消息上）。
  for (const [key, chain] of [...contextChains]) {
    if (chain.sessionId === sessionId) contextChains.delete(key)
  }
  if (lastChainKey !== undefined && !contextChains.has(lastChainKey)) lastChainKey = undefined
}

/**
 * 卸载/退出时的收尾：把复用槽里的会话**交回它自己的清理回调**，然后清空槽。
 *
 * 为什么必须单独有这个函数（2026-09-14）：`retireSession()` 只是把槽清掉，
 * 排队删除是槽里那个 `cleanup` 干的活 —— 直接清槽等于把待删的会话一起丢了，
 * 它就会永远留在网页端（每次退出必留一个，实测就是这样堆起来的）。
 *
 * 返回被退役的 sessionId（没有则 `undefined`），调用方可以据此记账/打日志。
 * 注意它**只排队**、不等删除完成；删不掉的部分由 `session-journal.ts` 兜底，
 * 记录只在"确认删掉"时才被摘掉，所以强杀也能在下次启动补删。
 */
export function disposeSessionReuse(): string | undefined {
  const slots = [...reuseSlots.values()]
  reuseSlots.clear()
  contextChains.clear()
  lastChainKey = undefined
  // 0.1.83：图片的"服务端已知"集合同样归会话所有，会话退役就作废
  sentRefIdsBySession.clear()
  if (slots.length === 0) return undefined
  for (const slot of slots) {
    try {
      slot.cleanup?.(slot.sessionId)
    } catch {
      /* 排队失败不影响卸载 */
    }
  }
  return slots[slots.length - 1]?.sessionId
}

/** 只给测试用：清空复用槽。 */
export function resetSessionReuse(): void {
  reuseSlots.clear()
  contextChains.clear()
  lastChainKey = undefined
  // 决策回执的状态也是模块级的（见 lastFeedReason），一并清掉，测试之间才互不干扰
  lastFeedReason = undefined
  // 0.1.83：图片的"服务端已知"集合也是模块级的，一并清掉
  sentRefIdsBySession.clear()
}

/** 链式投喂的决策回执（见 CompletionParams.onContextFeed）。 */
export interface FeedReport {
  /** 决策原因 —— chained = 真的发了增量；其余都是"退回全量"的具体理由。 */
  reason: FeedReason
  /** true = 本轮只发了增量；false = 本轮重发了全量 prompt。 */
  chained: boolean
  /** 实际写进请求体的 prompt 长度（chained 时就是增量大小）。 */
  promptChars: number
  /** 本轮从增量里剔掉了多少条「模型回声」（`Assistant: …`，见 context-feed.ts）。 */
  echoDropped: number
}

export interface CompletionParams {
  prompt: string
  /**
   * 链式投喂用：`prompt` 的结构化拆分（`head` = 系统+协议+工具目录，`entries` = **未截断**的历史条目）。
   * 不传 = 算不出"新增了哪几条"，只能走全量 —— 适配器两条序列化路径都要传，
   * 漏传会让链式模式静默退化成全量（靠 tests/check-bundle.mjs 的产物断言守）。
   */
  promptParts?: { head: string; entries: readonly string[]; transcript?: string; maxChars?: number }
  /**
   * 链式投喂的决策回执（0.1.63）。**只在决策原因变化时**回调一次，
   * 用来回答"这一轮到底发了增量，还是退回全量、因为哪条判据"——
   * 没有它，0.1.62 的链式投喂在日志里是完全不可见的。
   */
  onContextFeed?: (report: FeedReport) => void
  thinkingEnabled: boolean
  searchEnabled?: boolean
  modelType: 'default' | 'expert' | 'vision'
  /** 已上传文件的 file_id（图片输入：随请求引用，模型据此看图）。 */
  refFileIds?: readonly string[]
  /** 与 refFileIds **一一对应**的内容寻址 key（attachmentId，sha256:…）。
   * 0.2.0：sentRefIds 改按 key 记账 —— uploadCache 驱逐重传会换 fileId，
   * 按 id 记账会把同一张图记成"两张"，重新打开每轮重发的口子。 */
  refKeys?: readonly string[]
  signal?: AbortSignal
  idleTimeoutMs?: number
  /**
   * 建连阶段（建会话 + PoW + 等到响应头）的整体期限，默认 45 秒。
   * 抽成可注入是为了能离线验证「建连挂住必须被中断」——这段原本没有统一限时，
   * 是审计 F10 指出的"可无限等待"（idle watchdog 要到响应头之后才启动）。
   */
  connectTimeoutMs?: number
  /** 同一会话复用的轮次上限（0 = 每请求一个会话，用完即删）。 */
  sessionReuseTurns?: number
  /**
   * 宿主给的 **DSH 会话身份**（`GenerateOptions.sessionId`，见宿主内核类型定义）。
   * 一个窗口/对话一个值；适配器本该忽略它，我们借它把"网页端会话 + 投喂链"按窗口分开。
   */
  dshSessionId?: string
  onDeleteSession?: (sessionId: string) => void
  /**
   * 丢掉一个**内部请求的脚手架会话** —— 与 `onDeleteSession` 的区别是**不受清理策略约束**。
   *
   * 为什么必须分开：`session-title` / 压缩这类内部请求（**不带结构化 `promptParts`**）
   * 也必须有一条网页端会话才能调 completion，而那条会话既不是用户建的、用户也不需要它。
   * 用户的 `sessionCleanup`（尤其 `keep`）与 `manualOnly` 都会让 `onDeleteSession` 变成空操作 ——
   * 那对**用户的对话**是对的，对**我们自己建的会话**是错的：留在网页端就是凭空多一个会话
   * （2026-10-02 用户报「就发了一句话，网页版直接俩窗口」）。
   *
   * ⚠️ 宿主仍应让 `deleteWebSessions === false`（"一个都不许删"总闸）把它接成 undefined。
   */
  onDiscardSession?: (sessionId: string) => void
  /**
   * 当前账号被限时问宿主：「换个账号还能不能接着干」。
   *
   * 用途只有一个 —— 决定这次失败给**长退避**还是**短退避**：
   *  - true（宿主开了自动换号、账号库里还有可用候选）⇒ 给短退避，让 dsh-llm-retry **立刻重发**；
   *    重发进入适配器时，自动换号的检查点会换上可用账号 ⇒ **整轮任务不用人插手就能接下去**。
   *  - false ⇒ 保持 0.4.0 之前的行为：把解除时间当退避（几小时）⇒ 重试策略直接放弃，不做无用的空转。
   *
   * ⚠️ 不注入 ⇒ 行为与以前完全一致。宿主返回异常时按 false 处理（保守）。
   *
   * 三种 `kind`：`'muted'`（封禁）／`'throttled'`（限流）／`'auth'`（凭证被服务端作废）。
   * `'auth'` 是 0.6.8 加的：死号比限流更该换 —— 限流等一下会自己好，死号等多久都没用。
   */
  canFailover?: (kind?: 'muted' | 'throttled' | 'auth') => boolean
}

/**
 * 会话/请求的可注入传输层（默认就是真实实现）。
 * 抽出来是为了能在单测里确定性地复现「会话失效 → 重建重试」与「删除时机」这两条路径，
 * 不必真的打网络（这两处正是反复出问题的地方）。
 */
export interface CompletionTransport {
  createSession: (auth: WebAuth, signal?: AbortSignal) => Promise<string>
  powHeader: (auth: WebAuth, targetPath: string, signal?: AbortSignal) => Promise<string>
}

const defaultTransport: CompletionTransport = { createSession: createChatSession, powHeader: createPowHeader }

/**
 * 打开一次 completion 请求（建会话 + PoW + 发送），返回可用的会话与响应。
 *
 * 非 SSE 响应（HTTP 200 上裹着业务错误信封）在这里统一裁决：
 *  - 会话失效（invalid chat session id）→ **换一个新会话透明重试一次**（用户无感）；
 *  - 其它业务错误 → 按业务码抛出（AUTH / RATE_LIMIT / PROVIDER_ERROR…）。
 */
/**
 * 宿主给的「当前账号被限时，还能不能换号接着干」。
 *
 * 🔴 **单一来源**：`openCompletion`（HTTP 路径）与 `streamWebCompletion`（SSE 路径）都必须走它 ——
 * 两条路径的答案不一致时会出现最难查的故障：SSE 给长退避放弃重试，而 HTTP 给短退避重发，
 * 用户看到的就是"有时自己接下去了、有时必须手点继续"。
 *
 * 问不出来（没注入 / 抛错）时按**不能**处理 —— 保守方向：宁可让用户多点一次「继续」，
 * 也不要给一个它其实接不上的短退避（那只会更快地撞同一个限流）。
 */
function makeCanFailover(params: CompletionParams): (kind?: 'muted' | 'throttled' | 'auth') => boolean {
  return (kind) => {
    try {
      return params.canFailover?.(kind) === true
    } catch {
      return false
    }
  }
}

async function openCompletion(
  auth: WebAuth,
  params: CompletionParams,
  signal: AbortSignal,
  transport: CompletionTransport,
  /**
   * 账号级失败（认证/限流）时把会话 id 记进来 —— 调用方的收尾逻辑据此**保住**它。
   * 为什么由这里判：外层不知道 `sessionId`（它在 `await` 之后才拿到），
   * 而"这次失败是不是账号级的"只有这里看得见（错误码 / 业务码）。见 `keepIds` 的说明。
   */
  keepIds?: Set<string>,
): Promise<{ sessionId: string; resp: Response; feed: FeedDecision }> {
  let lastFailure: AdapterLlmError | undefined
  const canFailover = makeCanFailover(params)
  // 归属键：这个窗口（DSH 会话）自己的网页端会话与链。见 slotKeyFor 的说明。
  //
  const slotKey = requestSlotKey(auth, params)
  for (let attempt = 0; attempt < 2; attempt++) {
    let lease = await leaseSession(
      auth,
      signal,
      transport,
      params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
      params.onDeleteSession,
      false,
      slotKey,
    )
    // 链式投喂：决定本轮发全量还是增量、parent 指向谁。判据在 context-feed.ts（纯函数）：
    // 模式=chained 且「复用了同一会话 + 条目严格追加 + 头部/账号都没变」才发增量，
    // 任何一条不满足都退回全量 + parent=null（= 0.1.61 及以前的行为）。
    const planFeed = (sessionId: string, reused: boolean) =>
      decideFeed({
        mode: currentContextMode(),
        ...(params.promptParts
          ? {
              head: params.promptParts.head,
              entries: params.promptParts.entries,
              // 重发时省掉固定头（约 6.35 万字符）—— 见 FeedInput.transcript
              ...(typeof params.promptParts.transcript === 'string' ? { transcript: params.promptParts.transcript } : {}),
              ...(params.promptParts.maxChars !== undefined ? { maxChars: params.promptParts.maxChars } : {}),
            }
          : {}),
        full: params.prompt,
        sessionId,
        accountKey: accountKey(auth),
        reused,
        ...(contextChains.get(slotKey) ? { chain: contextChains.get(slotKey)! } : {}),
      })
    let feed = planFeed(lease.sessionId, lease.reused)
    // 0.6.10：**重开链（parent=null）不能在"复用来的"会话里发根消息** —— 那会在同一个网页端
    // 会话里造出同一条消息的兄弟分支（网页端显示成「修改 / 重新生成」+ `n / n`），
    // 用户看到的就是"换个窗口聊天又把上下文清了一遍"。判据是纯函数，有用例守。
    if (needsFreshSession(feed, lease.reused, currentContextMode(), params.promptParts !== undefined)) {
      // ⚠️ 保留**原来那个** reason 再重算：重算时 `reused` 已是 false，会得到 'new-session'，
      // 那会把真正的原因（not-appended / head-changed / session-changed…）从日志里抹掉 ——
      // 而"这一轮为什么没走增量"正是这个回执存在的唯一理由。
      const reason = feed.reason
      lease = await leaseSession(
        auth,
        signal,
        transport,
        params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
        params.onDeleteSession,
        true,
        slotKey,
      )
      feed = { ...planFeed(lease.sessionId, lease.reused), reason }
    }
    const sessionId = lease.sessionId
    // 决策留痕（0.6.25）：把"这一轮为什么走/没走增量"落盘 —— 宿主日志不落盘，真机上查不到。
    {
      const chainForNote = contextChains.get(slotKey)
      const chainEntries = chainForNote?.entries
      const currentEntries = params.promptParts?.entries
      noteFeedDecision({
        at: Date.now(),
        reason: feed.reason,
        reused: lease.reused,
        session: String(sessionId).slice(0, 8),
        account: accountKey(auth),
        chainLen: chainEntries ? chainEntries.length : null,
        entriesLen: currentEntries ? currentEntries.length : null,
        // 体量：唯一权威来源（未截断的实际发送串）
        promptChars: feed.prompt.length,
        headChars: params.promptParts ? String(params.promptParts.head ?? '').length : null,
        firstDiff:
          !chainEntries || !currentEntries ? null : firstDifference(chainEntries, currentEntries),
        stats: {
          assistant: (feed.prompt.match(/^Assistant: /gm) ?? []).length,
          user: (feed.prompt.match(/^User: /gm) ?? []).length,
          toolResult: (feed.prompt.match(/^\[Tool Result/gm) ?? []).length,
          systemBlocks: (feed.prompt.match(/^\[System\]/gm) ?? []).length,
        },
        tailSame:
          !chainEntries || !currentEntries
            ? null
            : currentEntries.length <= chainEntries.length
              ? false
              : currentEntries[chainEntries.length - 1] === chainEntries[chainEntries.length - 1],
      })
    }
    // 决策回执（0.1.63）：只在原因变化时上报一次，让日志能回答"这一轮为什么没走增量"。
    if (feed.reason !== lastFeedReason) {
      lastFeedReason = feed.reason
      params.onContextFeed?.({
        reason: feed.reason,
        // 🔴 判据是 reason，**不是** `parentMessageId !== null`（0.6.23 修）。
        // 0.6.23 起"退回全量"也挂在链尾（parent != null），拿 parent 判会把
        // "这一轮其实重发了全量"报成 chained=true —— 日志会直接说谎。
        chained: feed.reason === 'chained',
        promptChars: feed.prompt.length,
        echoDropped: feed.echoDropped ?? 0,
      })
    }
    // ── 0.1.83：图片只发"服务端还没见过的" ────────────────────────────────
    // 旧行为每轮都带整批：`adapter.ts` 的 `refFileIds: rounds === 0 ? refFileIds : []`
    // 本是给「自动续写」用的判据（第 2 轮不重带），而**链式投喂每轮都是新的 streamImpl 调用**
    // ⇒ `rounds` 恒为 0 ⇒ 顺带每轮都重挂一遍（网页端每条新消息下都挂一批图、会话内引用单调累积）。
    //
    // 判据放在**决策点**（`decideFeed` 之后），而不是用"上一轮是什么"去预测：
    //   · 有父链 ⇒ 服务端手里已有 ⇒ 只发新增的那几张（多数轮是 0 张）
    //   · 全量重发（restart / 新会话 / 切号 / head 变了）⇒ 服务端手里没有 ⇒ 发全部
    // ⚠️ 不能写成"chained 就完全不带"：用户**这一轮新贴**的图只存在于增量里，漏了就是功能坏。
    // ⚠️ 取**本会话自己的**那本账（没有就是新的）。绝不能再写成"发现会话不同就清全局"——
    // 那会让并发的另一个窗口把账抹掉，见 sentRefIdsBySession 的注释。
    const sentRefIds = sentRefIdsBySession.get(sessionId) ?? new Set<string>()
    // 0.2.0：每项携带着与 id 一一对应的 key（缺省退回 id 本身，向后兼容）。
    // 按 **key** 记账：fileId 会随 uploadCache 驱逐重传而变，
    // key 是内容寻址的稳定身份 —— "服务端见没见过这张图"不该取决于这一次用哪个 fileId 引用。
    const askedRefItems = (params.refFileIds ?? []).map((id, index) => ({
      id,
      key: params.refKeys?.[index] ?? id,
    }))
    const refItemsToSend =
      feed.parentMessageId !== null ? askedRefItems.filter((item) => !sentRefIds.has(item.key)) : askedRefItems
    const refIdsToSend = refItemsToSend.map((item) => item.id)

    let resp: Response
    try {
      resp = await activeFetch(`${DS_BASE}/api/v0/chat/completion`, {
        method: 'POST',
        headers: {
          ...buildDsHeaders(auth, `${DS_BASE}/a/chat/s/${sessionId}`),
          accept: 'text/event-stream',
          'x-ds-pow-response': await transport.powHeader(auth, '/api/v0/chat/completion', signal),
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          // 链式投喂时是上一条 assistant 的 message_id；全量模式恒为 null（根消息、无父链）。
          parent_message_id: feed.parentMessageId,
          prompt: feed.prompt,
          ref_file_ids: refIdsToSend,
          thinking_enabled: params.thinkingEnabled,
          search_enabled: params.searchEnabled ?? false,
          model_type: params.modelType,
          action: null,
          preempt: false,
        }),
        signal,
      })
    } catch (error: any) {
      // ⚠️ 只有**网络层状态未知**（请求可能已经发出去一半）才退役。
      // AUTH / RATE_LIMIT 都是**请求被拒**（PoW 也在 completion 之前求），会话没被动过 ⇒
      // 退役它只会让用户重新登录后丢掉整段对话。
      // 2026-10-02 用户现场：登录态过期 ⇒ 401 ⇒ 会话被弃 ⇒ 重登后"网页端又新建一个窗口"、
      // 29 条历史全量重发（他要的恰恰是"回到原来那个会话接着聊"）。
      const rejected =
        error instanceof AdapterLlmError && (error.code === 'AUTH' || error.code === 'RATE_LIMIT')
      if (rejected) keepIds?.add(sessionId)
      else {
        retireSession(sessionId)
        params.onDeleteSession?.(sessionId)
      }
      // ⚠️ N04：**先放行已经是 AdapterLlmError 的错误**。
      // 旧写法无条件包成 TRANSPORT，会把 PoW/网络层带出来的 AUTH / RATE_LIMIT
      // 等结构化分类抹掉 —— 宿主于是按"可重试的传输错误"处理本该停止重试的情况。
      if (error instanceof AdapterLlmError) throw error
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
            ? ' —— 网页版限流'
            : ''
      // 🔴 认证/限流被拒时**不要**退役会话（旧写法是无条件 `retireSession() // 失败即弃`）。
      // 401/403 说的是**令牌**过期、429 说的是**账号级**限流 —— 跟"这个会话"毫无关系：
      // 换一个新会话账号照样被限，唯一的后果是把用户的对话丢掉（他重新登录后只能新建会话、
      // 把历史全量重发一遍）。2026-10-02 现场：登录态过期 ⇒ 401 ⇒ 会话被弃 ⇒
      // `feed-decisions` 里同账号冒出 `new-session`、网页端"又新建一个窗口"。
      // 会话真的废了会由**业务码**显式告知（`isInvalidSessionError`），那条路径照旧退役；
      // 5xx / 网络失败 / 取消也照旧退役（服务端可能已经开始生成，会话停在半路 —— N04 的意图）。
      if (code === 'AUTH' || code === 'RATE_LIMIT') keepIds?.add(sessionId)
      else {
        retireSession(sessionId)
        params.onDeleteSession?.(sessionId)
      }
      // 0.6.8：AUTH（HTTP 401/403）也走"能不能换号"这条判据 ——
      // 能换号 ⇒ 5s 后重发，由重发前的检查点换上可用账号，整轮自己接下去（用户不用手点「继续」）；
      // 不能 ⇒ 10 分钟（> maxDelayMs）⇒ 重试策略直接放弃，行为与加这个功能之前一致。
      const authRetryAfterMs =
        code === 'AUTH' ? (canFailover('auth') ? AUTH_FAILOVER_RETRY_MS : AUTH_GIVEUP_RETRY_MS) : undefined
      throw new AdapterLlmError(
        `DeepSeek web completion failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}${hint}`,
        code,
        {
          status: resp.status,
          // 服务端给了 Retry-After 就以它为准（那是它自己说的解除时间）；没给才用我们的两档。
          ...(retryAfter !== undefined
            ? { providerRetryAfterMs: retryAfter }
            : authRetryAfterMs !== undefined
              ? { providerRetryAfterMs: authRetryAfterMs }
              : {}),
          cause: new Error(text),
        },
      )
    }
    if (!resp.body) {
      retireSession(sessionId)
      params.onDeleteSession?.(sessionId)
      throw new AdapterLlmError('DeepSeek web completion returned no body', 'EMPTY_RESPONSE')
    }

    // HTTP 200 也可能是「业务错误信封」或 HTML 挑战页 —— 非 SSE 一律先当错误处理
    const contentType = String(resp.headers.get('content-type') ?? '')
    if (contentType.includes('text/event-stream')) {
      // 请求已被服务端接受 ⇒ 这批 file_id 进了它的上下文（下一轮起不必再带）。
      // ⚠️ 只在**接受之后**记：失败/被拒的请求不算，免得下一轮误以为服务端已经拿到了。
      for (const item of refItemsToSend) sentRefIds.add(item.key)
      sentRefIdsBySession.set(sessionId, sentRefIds)
      return { sessionId, resp, feed }
    }

    const text = await resp.text().catch(() => '')
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {}
    const biz = envelopeError(parsed)
    const muted = isMutedError(biz)
    const busy = !muted && !!biz && isBusyGenerating(biz.msg)
    // 账号级节流有**两个来源**，合到一个判据里：
    //   ① 码：40029（cuckoo-code 0.6.1 实测的「操作过于频繁」业务码）
    //   ② 文案族：isThrottled（「过于频繁 / 操作频繁 / 稍后重试 / 限流」…，话术变了也不会漏）
    // ⚠️ 必须合并 —— 分开写时我第一版就是「只给文案那条加了 20s 退避」，
    // 结果认了码却没带 providerRetryAfterMs（用例当场抓住）。两条来源的后续处理完全一样。
    const throttled = !muted && !busy && !!biz && (biz.code === 40029 || isThrottled(biz.msg))
    const untilMs = muteUntilMs(parsed)
    // 失败码先算出来 —— 下面 AUTH 那一档要用它判断"这次到底是不是授权失效"
    // （信封里的 40003/40001，HTTP 可能仍是 200）。0.6.8：AUTH 的退避改为条件式。
    const failureCode = !biz
      ? 'MALFORMED_RESPONSE'
      : muted || busy || throttled
        ? 'RATE_LIMIT'
        : isInvalidSessionError(biz)
          ? 'TRANSPORT'
          : isInvalidRefFileError(biz)
            ? 'INVALID_REF_FILE'
            : bizErrorCode(biz.code)
    const failure = biz
      ? new AdapterLlmError(
          muted
            ? mutedMessage(untilMs)
            : busy
              ? '网页版限流：同一账号同时只能生成一条消息，稍后自动重试'
              : throttled
                ? '网页版限流：发得太频繁，稍后自动重试'
                : bizErrorMessage(biz.code, biz.msg),
          failureCode,
          {
            status: resp.status,
            // 解除时间远大于重试策略的上限 → dsh-llm-retry 会直接放弃重试（而不是空转打请求）
            // ⚠️ 但如果**能换号**（宿主开了自动换号且还有可用候选），就不要放弃 —— 给短退避，
            // 让重试立刻发生；重发时自动换号的检查点会换上可用账号，整轮任务自己就能接下去。
            ...(muted && untilMs !== undefined
              ? {
                  providerRetryAfterMs: canFailover('muted') ? FAILOVER_RETRY_MS : Math.max(0, untilMs - Date.now()),
                }
              : {}),
            // 绝对值单独带一份：宿主会把它记到账号上，在设置页显示倒计时
            ...(muted && untilMs !== undefined ? { mutedUntilMs: untilMs } : {}),
            // 0.6.8 授权失效（信封里的 40003/40001）：与 HTTP 401 那条同样处理 ——
            // 能换号 ⇒ 5s 后重发（检查点换号接上）；不能 ⇒ 600s > maxDelayMs ⇒ 直接放弃重试。
            ...(failureCode === 'AUTH'
              ? { providerRetryAfterMs: canFailover('auth') ? AUTH_FAILOVER_RETRY_MS : AUTH_GIVEUP_RETRY_MS }
              : {}),
            ...(busy ? { providerRetryAfterMs: 5_000 } : {}),
            // 节流：能换号给 2s（让重试立刻发生），否则 20s（HTTP 路径的定值；
            // SSE 路径走渐长的 throttleRetryAfterMs，首档 40s —— 两条路都受同一个
            // "能不能换号"支配，值不同只是因为 SSE 那边还有"越撞越长"的语义）
            ...(throttled ? { rateLimitKind: 'throttled' as const, providerRetryAfterMs: canFailover('throttled') ? FAILOVER_RETRY_MS : THROTTLE_RETRY_MS } : {}),
          },
        )
      : new AdapterLlmError(
          `DeepSeek 网页端返回了非流式响应（content-type: ${contentType || 'unknown'}）：${text.slice(0, 200)}`,
          'MALFORMED_RESPONSE',
          { status: resp.status },
        )
    // 账号级失败（`muted`＝账号被限到某时刻 / `busy`＝账号同时在生成 / `throttled`＝发得太频繁 /
    // `AUTH`＝令牌失效）跟**这个会话**毫无关系 —— 换一个新会话账号照样被限，唯一的后果是把用户的
    // 对话丢掉。所以这里**保住**它，等用户重新登录/限流解除后接着聊。
    // 只有业务码明说"这个会话废了"（`invalid chat session id`）才退役。
    const accountLevel = !!biz && (muted || busy || throttled || failureCode === 'AUTH')
    const ruined = !!biz && isInvalidSessionError(biz)
    if (accountLevel) {
      keepIds?.add(sessionId)
    } else {
      retireSession(sessionId)
      params.onDeleteSession?.(sessionId)
    }
    if (attempt === 0 && ruined) {
      lastFailure = failure
      continue
    }
    throw failure
  }
  throw lastFailure ?? new AdapterLlmError('DeepSeek 网页端无法建立可用会话', 'PROVIDER_ERROR')
}

/**
 * 发起一次网页版完成请求并流式产出事件；会话在**流结束之后**尽力删除。
 *
 * ⚠️ 删除时机是这个模块最容易被写错的地方（2026-09-11 实测故障）：
 * 旧实现把 `onDeleteSession` 放在**建会话之后立刻**调用，而它内部是「延迟 1.5s 删除」，
 * 于是会话可能在 completion 请求发出之前就被自己删掉 —— 若 PoW 求解 + 建连超过 1.5s，
 * 服务端回
 *   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
 * 更隐蔽的是「生成进行到一半会话消失」，服务端可能直接掐断流 —— 表现就是回答说半句就停、
 * 工具调用没收全（正是我们一直在追的那类截断）。
 * 现在删除只发生在 finally（流正常结束、报错或调用方中止都算），会话在整个请求期间都活着。
 */
/** 复用模式下的"飞行互斥"：保证同一时刻只有一个复用请求在跑，避免轮换撞上并发。 */
let reuseFlightTail: Promise<void> = Promise.resolve()

export async function* streamWebCompletion(
  auth: WebAuth,
  params: CompletionParams,
  transport: CompletionTransport = defaultTransport,
): AsyncGenerator<WebStreamEvent> {
  const controller = new AbortController()
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal
  // 归属键：账号 + DSH 会话（窗口）。这条请求要用的网页端会话与投喂链都挂在它下面。
  // ⚠️ 必须与 openCompletion 用**同一个**函数算 —— 两处不一致会让链写在一个键、读另一个键。
  const slotKey = requestSlotKey(auth, params)
  /** 本轮真的按某条链发过吗（收尾时按它决定是"接上"还是"作废"）。 */
  let sentChainKey: string | undefined
  // SSE 路径也要问「还能不能换号」（与 openCompletion 同一个判据）：节流的退避长短由它决定。
  const canFailover = makeCanFailover(params)
  const rawLimit = params.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS
  // 与 leaseSession 同一判据（链式不轮换）：这里决定"跑完的那一轮要不要放过承载链的会话"，
  // 两边算法不一致的话会出现"租用说不轮换、收尾却把它删了"。
  const limit = effectiveReuseLimit(
    Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_SESSION_REUSE_TURNS,
    currentContextMode(),
  )

  let release: (() => void) | undefined
  let sessionId: string | undefined
  let iterator: AsyncGenerator<WebStreamEvent> | undefined
  let body: any
  let complete = false
  /**
   * 本轮见过服务端的**显式终态**（`kind:'finish'`）吗。
   *
   * 与 `complete` 的分工：`complete` 需要"底层流的迭代器自然结束"（消费方必须多取一次），
   * 而消费方读完终止事件就可能不取了 ⇒ 只认 `complete` 会把**成功的一轮**误判成没跑完，
   * 于是会话被退役+删除、链也记不上（2026-10-01 的"每轮新建会话"就是这条）。
   */
  let sawTerminal = false
  let poisoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 本轮实际发出去了什么（链式投喂据此记账；见 finally 里的链更新）。 */
  let sentFeed: FeedDecision | undefined
  /** 首帧 `event: ready` 给的 assistant message_id —— 就是下一轮的 parent_message_id。 */
  let responseMessageId: number | undefined
  /** 同一个会话只回收一次（复用/轮换/失败三条路径可能都想回收它）。 */
  const deleted = new Set<string>()
  const cleanup = (id: string): void => {
    if (deleted.has(id)) return
    deleted.add(id)
    try {
      params.onDeleteSession?.(id)
    } catch {}
  }
  /** 让等待可被取消：abort 时立刻 reject，不等定时器/对端。 */
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        promise.catch(() => {})
        reject(signal.reason)
        return
      }
      const abort = () => {
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
    })
  const arm = (ms: number, message: string): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new AdapterLlmError(message, 'TIMEOUT')), ms)
    ;(timer as any).unref?.()
  }

  /**
   * F10：外层拥有本次调用创建过的**全部**会话。
   *
   * 建连阶段没有统一限时时，`createSession` 之后、响应头之前的任何失败都会让
   * 「已建出来但还没人认领」的会话漏在服务端；`openCompletion` 内部的失败分支只覆盖
   * 它自己 catch 得到的错误。超时/取消会**放弃**进行中的 `openCompletion`（不再等它），
   * 所以必须在这里兜住它后续才返回的那些会话。
   */
  const owned = new Set<string>()
  /**
   * 本轮**账号级失败**（认证/限流）时不该被退役的会话（0.6.29）。
   *
   * 为什么不能放在 `finally` 里靠错误码判：建连阶段失败时外层 `sessionId` **还是 undefined**
   * （它在 `await openCompletion(...)` 之后才赋值），`id === sessionId` 恒假 ⇒ 会连
   * "本轮真正在用的那个会话"一起退役。必须先把它记下来 —— 只有 `openCompletion` 知道。
   *
   * 判据（在那里判，这里只消费）：`AUTH`（HTTP 401/403、信封 40003/40001）与
   * `RATE_LIMIT`（HTTP 429、`user is muted`、`busy generating`、`throttled` 文案族）
   * 说的都是**账号级**状态 —— 令牌过期、账号被限到某时刻、账号同时在生成。
   * 换一个新网页端会话一点用都没有（账号照样被限），唯一的效果是把用户的对话丢掉：
   * 他重新登录后只能新建会话、把整段历史全量重发一遍。
   * 2026-10-02 现场：登录态过期 ⇒ 401 ⇒ 会话被弃 ⇒ `feed-decisions` 里同账号冒出
   * `new-session`、网页端"又新建一个窗口"、29 条历史全量重发。
   *
   * ⚠️ 5xx / 网络失败 / 取消 / 空响应 **不在此列** —— 那些情况下服务端可能已经开始生成、
   * 会话停在半路，照旧退役（N04 的意图不能削弱）；会话真的废了则由业务码
   * `invalid chat session id` 显式告知。
   */
  const keepIds = new Set<string>()
  let finalized = false
  const tracked: CompletionTransport = {
    ...transport,
    createSession: async (value, sig) => {
      const id = await transport.createSession(value, sig)
      if (finalized) {
        // 已经收尾了才建出来（超时之后仍在跑的建连）→ 立刻归还，别留给下一次请求
        retireSession(id)
        cleanup(id)
      } else {
        owned.add(id)
      }
      return id
    },
  }

  try {
    signal.throwIfAborted()
    // N04：复用开启时全程串行（含跨账号）—— 共享槽位要一致的并发状态；
    // 关闭复用时保持原并发模式（每次自己建会话，彼此独立）。
    if (limit > 0) {
      const previous = reuseFlightTail
      const mine = new Promise<void>((resolve) => {
        release = resolve
      })
      reuseFlightTail = previous.then(
        () => mine,
        () => mine,
      )
      await wait(previous)
    }
    const connectMs =
      Number.isFinite(params.connectTimeoutMs) && (params.connectTimeoutMs as number) > 0
        ? Math.min(params.connectTimeoutMs as number, 600_000)
        : 45_000
    arm(connectMs, `DeepSeek 建立流超时（${connectMs}ms）`)
    // F10：**用 wait() 包住** —— 建连期限靠 controller.abort 生效，而 abort 只对
    // 「肯配合 signal 的传输」立即生效。包一层之后，即使底层 promise 永远不结算，
    // 等待也会在 abort 的瞬间结束（否则「限时」形同虚设，会一直挂在 await 上）。
    const opened = await wait(
      openCompletion(
        auth,
        { ...params, sessionReuseTurns: limit, onDeleteSession: cleanup },
        signal,
        tracked,
        keepIds,
      ),
    )
    sessionId = opened.sessionId
    sentFeed = opened.feed
    sentChainKey = slotKey
    body = opened.resp.body
    if (timer) clearTimeout(timer)
    iterator = parseWebSse(body, {
      thinkingEnabled: params.thinkingEnabled,
      // 🔴 必须传下去：SSE 节流的退避取决于"还能不能换号"。少了它，节流会抛 40~117s，
      // 超过 dsh-llm 策略上限 ⇒ 一次都不重试、整轮失败（实测 2026-09-27 14:35:32）。
      canFailover,
      onResponseMessageId: (id) => {
        responseMessageId = id
      },
    })
    const idle =
      Number.isFinite(params.idleTimeoutMs) && (params.idleTimeoutMs as number) > 0
        ? Math.min(params.idleTimeoutMs as number, 600_000)
        : 120_000
    for (;;) {
      arm(idle, `DeepSeek 流等待超时（${idle}ms）`)
      const item = await wait(iterator.next())
      if (timer) clearTimeout(timer)
      if (item.done) {
        complete = true
        break
      }      if (item.value.kind === 'error') poisoned = true
      // 🔴 服务端给**显式终态**就算这一轮成功（`[DONE]` 时解析器补发的 `kind:'finish'`）。
      //
      // 为什么不能只等 `item.done`（2026-10-01 实测的严重 bug）：消费方（DSH）读完终止事件
      // 就**停止迭代**，于是我们的 `finally` 先跑 —— 此时 `item.done` 从没被取到，`complete`
      // 永远是 false ⇒ 收尾把会话 `retireSession + cleanup`（**弃用并删除**）、链也记不上
      // ⇒ 下一轮只能再新建一个会话。用户看到的就是"链式模式下一个窗口聊三句 = 网页端多出三个
      // 新会话，而且旧会话被删掉"。
      // 两个都是服务端给的**显式终态**，任一出现就算这一轮成功：
      // `kind:'finish'` 是 `[DONE]` 时解析器补发的收尾事件；`status=FINISHED` 是
      // `response/status` 那一帧。多认一个是为了防"消费方在 finish 之前就停"的残余情形。
      if (item.value.kind === 'finish' || (item.value.kind === 'status' && item.value.value === 'FINISHED')) {
        sawTerminal = true
      }
      yield item.value
    }
  } catch (error: any) {
    // 🔴 0.6.41：**内部请求（不带 `promptParts`）的脚手架会话，在**抛错前**就要丢。
    //
    // 为什么（2026-10-04 实测复现「发一句话网页端建俩窗口」）：下面三个 `throw` 全部
    // **绕过**收尾路径里的 `params.onDiscardSession`（那个在 `for (const id of owned)` 那段里，
    // 只有正常走完才会到）⇒ `session-title` 这类**短请求一旦出错**（限流/网络抖动/上游 5xx），
    // 它的脚手架会话就**永远留在网页端**。
    //
    // ⚠️ 为什么只在 `promptParts === undefined` 时做：用户的对话会话**绝不能**在这里被丢 ——
    // 出错后用户还要重登/重试接着聊（0.6.29 的约定）。判据与收尾路径同一处。
    if (params.promptParts === undefined) {
      const scaffolding = new Set<string>(owned)
      if (sessionId) scaffolding.add(sessionId)
      for (const id of scaffolding) {
        retireSession(id)
        try {
          params.onDiscardSession?.(id)
        } catch {
          /* 丢弃失败不影响错误上抛 */
        }
      }
    }
    if (params.signal?.aborted) throw new AdapterLlmError('请求已取消', 'ABORTED', { cause: error })
    if (controller.signal.aborted && controller.signal.reason instanceof AdapterLlmError) throw controller.signal.reason
    if (error instanceof AdapterLlmError) throw error
    throw new AdapterLlmError('DeepSeek 流请求失败', 'TRANSPORT', { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    // 主链不等待不合作的假/自定义流（否则仍会阻塞所有复用请求）
    if (iterator) {
      void iterator
        .return(undefined)
        .catch(() => {})
        .finally(() => {
          if (body && !body.locked) void body.cancel().catch(() => {})
        })
    }
    // N04：**提前结束（调用方 return / 取消）也必须退役会话**。
    // 旧实现只在 HTTP 失败分支退役，stream generator 被提前 return 时不退役 ——
    // 于是下一次请求会接着用一个"上一条流还没消费完"的会话。
    // F10：改成遍历本次创建过的**全部**会话；唯一放过的只有「正常跑完且仍在复用」的那个。
    finalized = true
    // 「这一轮成了吗」= 底层流自然结束 **或** 我们已经把服务端的显式终态交给了消费方。
    // 判据必须取并集（理由见 `sawTerminal` 的注释）—— 只认前者会把成功的一轮判成没跑完。
    const roundOk = complete || sawTerminal
    lastRetireReason = undefined
    // ── 内部请求（不带结构化 promptParts）的会话是**我们自己的脚手架** ──────────
    // 它们**不进用户的清理策略**（keep / manualOnly 都管不着），一律就地丢掉。
    // 判据与 `requestSlotKey` 同一处：`promptParts` 有没有传。见 `discard` 的长注释。
    if (params.promptParts === undefined) {
      const scaffolding = new Set<string>(owned)
      // ⚠️ 复用来的会话**不在 `owned` 里**（这一轮没调 createSession），但同样是脚手架 ⇒ 必须一起丢
      if (sessionId) scaffolding.add(sessionId)
      for (const id of scaffolding) {
        retireSession(id)
        params.onDiscardSession?.(id)
      }
    } else {
      for (const id of owned) {
        // 账号级失败（认证/限流）：这个会话**没被动过** ⇒ 一次都不许碰它 —— 用户重新登录后
        // 要能接着原会话聊。见 keepIds 的说明。
        if (limit > 0 && keepIds.has(id) && !poisoned) continue
        // N04 的意图保留：提前结束/取消（没见到显式终态）仍然要退役 —— 那个会话可能停在半路。
        if (id === sessionId && roundOk && !poisoned && limit > 0) continue
        // 记下"为什么退役"，下次这类"每轮新建会话"的排查不用再插桩（0.6.16 加的可见性）。
        lastRetireReason =
          id !== sessionId ? 'extra-session' : poisoned ? 'poisoned' : !roundOk ? 'not-finished' : 'rotated'
        retireSession(id)
        cleanup(id)
      }
    }
    // 链式投喂的记账（2026-09-14）：只有「流正常跑完 + 没被污染 + 拿到了本轮的
    // assistant message_id」才把这链接上；其余（报错/取消/提前 return/没收到 ready）
    // 一律作废 —— 下一轮 decideFeed 会看到"没有链"，自动退回全量重发。
    // 注意这里按**每一次请求**记账（一轮里可能有首轮 + 续写轮多次调用），不是按 DSH 回合：
    // 续写轮的增量与 parent 正是靠这次记账才对得上。
    if (sentFeed?.next && roundOk && !poisoned && typeof responseMessageId === 'number') {
      contextChains.set(slotKey, { ...sentFeed.next, parentId: responseMessageId })
      lastChainKey = slotKey
    } else if (sentChainKey !== undefined && params.promptParts !== undefined) {
      // 0.6.18：没有 promptParts 的请求（session-title / compaction 等内部调用）
      // 不是链式请求，失败/没 ready 也不该把 chat 的链删掉。
      contextChains.delete(sentChainKey)
      if (lastChainKey === sentChainKey) lastChainKey = undefined
    }
    release?.()
  }
}
