/**
 * 上下文投喂方式 —— 每轮到底给网页端发什么。
 *
 * 两种模式（2026-09-14 加，用户可切换）：
 *
 *   full    每轮重发全量 prompt（默认）。
 *           webapi 每次 completion 都发 `parent_message_id: null`，每条消息都是会话里的
 *           根消息、没有父链 —— 服务端按消息树回溯上下文时回溯到空，**拿不到任何历史**。
 *           所以历史必须由我们自己每轮重发。DSH 的适配器契约本来就是无状态的
 *           （每轮把完整 messages 交给我们），这个模式最稳、行为和 0.1.61 及以前完全一致。
 *
 *   chained 链式投喂：只发**增量**，并把 `parent_message_id` 指向上一轮 assistant 的
 *           message_id，让服务端自己按链维护上下文。
 *           依据（读参考实现 + 抓真实帧，不是推理）：浏览器就是这么干的 ——
 *           参考实现里的 `nextParentMessageId = history?.parentMessageId ?? finalAssistantMessageId`
 *           `interceptor/request-augmentation.ts` 里 `isFirstMessage = parent_message_id === null`
 *           ⇒ 只有会话第一条的 parent 是 null，之后每轮都把上一条消息 id 当 parent 发上去。
 *           本轮 assistant 的 id 来自 SSE 首帧 `event: ready`
 *           （`{"request_message_id":1,"response_message_id":2,...}`，实测样本见
 *           `.workbuddy/tmp/shortq-r1-2026-09-14T04-17-41.sse`）。
 *
 * ⚠️ chained 的代价（必须知道，所以默认不开）：
 *   模型能看到的工具协议、系统提示、历史，全都在**链首那条消息**里；一旦服务端侧
 *   把早期上下文丢掉（长会话/超窗），模型就没有协议可依 —— 可能直接不按 JSON 发工具调用。
 *   本模块的对策是"能省则省、一有不确定就退回全量"：见 decideFeed 的判据。
 *
 * 本文件是**纯逻辑 + 一点设置读写**，不依赖 webapi，方便直接测（tests/check-context-feed.mjs）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from './auth.ts'

export type ContextMode = 'full' | 'chained'

/** 默认每轮重发全量 —— 与 0.1.61 及以前的行为一致，不改动既有用户。 */
/**
 * 默认投喂模式：**链式**（2026-11-03 改）。
 *
 * 为什么从 `full` 改过来：全量模式每轮都发 `parent_message_id: null` 的**根消息**；
 * 一旦它落进一个**已经有内容**的网页端会话里，网页端会把它渲染成「同一条消息的多个版本」
 * —— 界面上就是「修改 / 重新生成」+ `n / n` 翻页（用户实测截图：`4 / 7`）。
 * 而且 DSH 每轮都会替换式改写运行时快照 ⇒ 链经常要重开 ⇒ 全量模式下几乎**每轮**都长这样。
 * 链式模式只发增量 + 指向上一条 assistant，网页端看到的就是正常的一问一答。
 *
 * ⚠️ 全量仍然保留（面板可切）：它换来的是"服务端不留上下文"，代价就是上面那个分叉外观；
 * 现在 `needsFreshSession` 会把"根消息落进复用会话"这条也拦下来，见那里的注释。
 */
export const DEFAULT_CONTEXT_MODE: ContextMode = 'chained'

export function normalizeContextMode(value: unknown): ContextMode | undefined {
  return value === 'full' || value === 'chained' ? value : undefined
}

/** 设置页展示用（纯文本，别写 markdown 星号）。 */
export const CONTEXT_MODE_HINT =
  '链式投喂：之后每轮只发新增内容，并把上一条回答挂到父消息上，让服务端自己维护上下文 —— ' +
  '请求体小得多、也更像真人连续对话。代价是工具协议只存在于链首那条消息里，' +
  '一旦服务端把早期上下文丢掉，模型可能不按约定格式发工具调用；本插件遇到任何不确定会自动退回全量重发。' +
  '每轮全量：最稳，行为和以前完全一致（网页端会看到每条消息都带着完整提示词）。'

/** 链式投喂的链状态。只在「正在复用的那个会话」上有意义，会话轮换/失败即作废。 */
export interface ChainState {
  /** 链首发出去的固定头（系统 + 协议指令 + 工具目录）。头部变了就不能续链。 */
  head: string
  /** 已经发出去的历史条目（**完整**条目，不做过滤）——下一轮用它算增量。 */
  entries: readonly string[]
  /** 上一轮 assistant 的 message_id，作为下一轮的 `parent_message_id`。 */
  parentId: number
  /** 链所属的网页端会话。 */
  sessionId: string
  /** 链所属账号（凭证摘要）。切号后键不同，不能续链。 */
  accountKey: string
}

export type FeedReason =
  | 'chained' // 发了增量
  | 'mode-full' // 配置就是全量
  | 'no-parts' // 调用方没给结构化 prompt，算不出增量
  | 'no-chain' // 还没有链（本轮要当链首）
  | 'new-session' // 本轮是新会话（复用的旧链不适用）
  | 'session-changed'
  | 'account-changed'
  | 'head-changed' // 系统提示/工具目录变了 —— 链首那份已经过期
  | 'not-appended' // 历史不是严格追加（被压缩/改写/回退）
  | 'empty-delta' // 没有新增内容（例如同一步的重试）
  | 'delta-too-long' // 增量本身超出预算，不值得为它冒险

export interface FeedInput {
  mode: ContextMode
  /** 本轮结构化 prompt 的三段：head = 固定头，entries = 历史条目，full = 今天那份字符串。 */
  head?: string
  entries?: readonly string[]
  full: string
  /**
   * `full` 里**属于历史的那一段**（不含固定头）。见 `protocol.ts` 的 `PromptParts.transcript`。
   *
   * 用途只有一个：链还在、头也没变时的"退回全量重发"**不必重发固定头**（它已经在会话首条
   * 消息里给过了），只发这一段即可 —— 省下的就是那约 6.35 万字符。
   * 没传时退回旧行为（重发整份 `full`），所以这是一个**纯优化**、不改变正确性前提。
   */
  transcript?: string
  /** 本轮用的网页端会话，以及它是不是复用来的。 */
  sessionId: string
  accountKey: string
  reused: boolean
  /** 当前链（没有则 undefined）。 */
  chain?: ChainState
  /** serializePrompt 用的预算，用来给增量设一个上限。 */
  maxChars?: number
}

import { CONTINUE_INSTRUCTION, TOOL_CALL_RETRY_INSTRUCTION } from './protocol.ts'

export interface FeedDecision {
  /** 真正写进请求体的 prompt。 */
  prompt: string
  /** 真正写进请求体的 `parent_message_id`。 */
  parentMessageId: number | null
  /**
   * 本轮结束后（流正常跑完且拿到了 assistant message_id）应该建立/沿用的链。
   * `undefined` = 不建链（全量模式）。
   */
  next: Omit<ChainState, 'parentId'> | undefined
  /** 为什么这么决定 —— 只用于日志，排障时能一眼看出为什么没走上链式。 */
  reason: FeedReason
  /**
   * 这一轮从增量里剔掉了多少条「模型回声」（`Assistant: …`）。
   *
   * 回声指的是：主机把**服务端上一轮的回复**也放进了消息列表，于是它出现在"新追加的条目"里。
   * 那条回复本来就在链上（正是我们要挂的父消息），再当输入发一遍纯属浪费。
   */
  echoDropped?: number
}

/**
 * 这条条目是不是「续写/纠正轮」的指令。
 *
 * 续写轮（`adapter.ts` 在回答被截断或模型把工具程序写进正文时自动发起）是**故意**把
 * 上一轮的半截回答当输入再发一遍的：`Assistant: 半截回答` + `User: <续写指令>` ——
 * 模型据此从断点接着写。所以那种"回声"不能剔（剔了它就从零重写一遍）。
 * 判据用的是**插件自己的常量**（单一来源在 `protocol.ts`），不猜文案。
 */
export function isContinuationCue(entry: string): boolean {
  const text = String(entry ?? '').trim()
  return (
    text === `User: ${CONTINUE_INSTRUCTION}` ||
    text === `User: ${TOOL_CALL_RETRY_INSTRUCTION}`
  )
}

/**
 * 这条条目是不是「模型回声」。
 *
 * 主机的消息列表里既有用户消息也有**助手消息**（＝我们上一轮从服务端流下来的那段回复）；
 * `serializePromptParts` 把它们统一转写成 `Assistant: …` / `User: …` 这样的条目。
 * 增量投喂只需要发"服务端还没见过的"内容，而 `Assistant:` 那些条目服务端自己刚说过 ——
 * 2026-10-01 用户截图反馈：「总是把模型上一句回答的结果，加到下一句当提示词，完全没必要」。
 */
export function isAssistantTranscriptEntry(entry: string): boolean {
  return typeof entry === 'string' && /^\s*Assistant:/.test(entry)
}

/**
 * 两个条目序列**从哪个下标开始不一样**（完全相同则返回较短的公共长度）。
 *
 * 用途：链没续上时（`not-appended`）算"服务端还没见过的部分"从哪里开始。
 */
export function firstDifference(prev: readonly string[], next: readonly string[]): number {
  const shared = Math.min(prev.length, next.length)
  for (let i = 0; i < shared; i += 1) if (prev[i] !== next[i]) return i
  return shared
}

/**
 * 这一轮要不要**换一个干净会话**。
 *
 * 🔴 2026-09-30 实测的坑（用户报"换个窗口聊天就把上下文清理一次"）：
 * 重开链时发的是 `parent_message_id: null`（根消息）；如果那时用的还是**复用来的**会话，
 * 就等于往一个**已经有内容**的网页端会话里又塞了一个根 —— 网页端把它渲染成同一条消息的
 * 多个兄弟版本（带「修改 / 重新生成」入口和 `n / n` 翻页），而那条消息恰好是我们那份巨大的
 * 提示词 ⇒ 界面上看起来就是"同一段提示词被改了好几遍、上下文被清了一次"。
 * 触发重开链的原因很多（`FeedReason` 那几种：换窗口导致历史不是严格追加、head 变了、
 * 会话轮换、同一步重试……），日常使用里**经常**走到。
 *
 * 判据：**要发根消息 + 当前会话是复用来的 ⇒ 换新会话**。重开链的语义本来就是"从干净上下文
 * 重新开始"，那就该配一个干净会话（旧会话交回给它自己的清理）。
 * 本来就是新会话（`reused === false`）时**不重复换**，否则每轮都白建一个。
 */
export function needsFreshSession(
  feed: Pick<FeedDecision, 'parentMessageId'>,
  reused: boolean,
  mode: ContextMode,
  /** 本轮是否真的传了结构化 prompt（即真的想走链）。不传结构 = 内部请求走全量，不必强制换新会话。 */
  hasPromptParts = true,
  /** 是否允许"重开链时换新会话"。缺省取模块级设置（默认 **否**），见 `currentFreshSessionOnRestart`。 */
  allowRestartSwap: boolean = currentFreshSessionOnRestart(),
): boolean {
  /**
   * 🔴 2026-11-03 改：**全量模式也要拦**。
   *
   * 旧注释的理由是"全量模式每轮都是根消息，一律换会话会 +2 请求/轮"。但那个取舍换来的是
   * **用户直接可见的坏形态**：根消息落进已有内容的会话 ⇒ 网页端渲染成「修改 / 重新生成」+ `n / n`。
   * 正确性优先：宁可多建一个会话（会话清理会成批删），也不要把对话弄成分叉。
   *
   * 全量模式仍然保留（面板可切），只是它现在**每轮一个干净会话** —— 语义上也更对：
   * 我们的 prompt 本来就是全量，会话里不需要任何历史。
   */
  if (mode !== 'chained' && !(feed.parentMessageId === null && reused)) return false
  // 0.6.18：没有结构化 parts 的请求（session-title / compaction 等）在链式模式下也走全量，
  // 它们不是"重开链"，不需要干净会话；强制换新会让每个内部请求都退役当前会话，
  // 把 chat 的网页端会话活活冲掉。
  if (!hasPromptParts) return false
  // 🔴 0.6.22：重开链**默认不再换会话**。见 `currentFreshSessionOnRestart` 的长注释
  // （0.6.10 的假设"重开链是异常路径"在 DSH 下不成立 —— 宿主每轮都会刷新
  // `Current runtime context` 一类的注入，链几乎每个 turn 都要重开）。
  if (!allowRestartSwap) return false
  return feed.parentMessageId === null && reused
}

/**
 * 重开链时是否换一个**全新的网页端会话**（0.6.22 起默认 **否**）。
 *
 * ## 为什么默认关掉（2026-10-01 实测）
 *
 * 0.6.10 引入"重开链换新会话"时的假设是：**重开链是异常路径**（换窗口 / head 变了 /
 * 会话轮换），所以"多建一个会话 + 抛弃旧的"这点代价可以接受。
 *
 * 实测这个假设不成立。DSH 每一轮都会重新生成一份**替换式**的运行时注入
 * （原话：`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`），
 * 它一变，`chain.entries` 就不再是本轮 entries 的严格前缀 ⇒ `decideFeed` 必然
 * `restart('not-appended')` ⇒ 配上一个 parent=null 的根消息 ⇒ 这里换新会话。
 *
 * 用户实测（会话 `13fc4478`，一个窗口聊了两句）：
 *   12:50:36 新建会话 ①（turn 1）
 *   12:51:07 新建会话 ②（turn 2 step 1，重开链）
 *   12:51:13 新建会话 ③（turn 2 step 2，重开链）
 * 一个窗口 → 网页端三个会话，且旧的两个因为不再被复用而进了待删队列。
 *
 * 关掉之后：重开链**就在当前会话里发全量根消息**，会话数保持"一个窗口一个会话"。
 * 代价：那个会话里会多出一条同层的根消息（网页端可能显示「修改 / 重新生成」+ `n / n`），
 * 这是**刻意选择**的结果 —— 会话数失控比多一条分支严重得多，而且旧会话里的历史还在。
 * 想要 0.6.10 的行为（宁可多一个会话也要干净上下文）可以把面板开关打开。
 */
export const DEFAULT_FRESH_SESSION_ON_RESTART = false

/**
 * ⚠️ 默认值只有**这一个来源**：初始值、`resetFreshSessionOnRestart()` 都读它。
 *
 * 为什么强调（2026-10-01 自己踩的）：第一版把 `reset…()` 里的 `false` 写成了**字面量**，
 * 与声明处的默认值成了两个来源 —— 于是"把默认改成 true"这个变异**跑不出红**
 * （用例先 reset 就把变异抹掉了），守卫形同虚设。同义多源必须收敛成一处。
 */
let freshSessionOnRestart = DEFAULT_FRESH_SESSION_ON_RESTART

/** 取当前设置（即时生效，无需重启）。 */
export function currentFreshSessionOnRestart(): boolean {
  return freshSessionOnRestart
}

/** 设置（设置页保存时立刻生效，无需重启）。 */
export function applyFreshSessionOnRestart(value: boolean): boolean {
  freshSessionOnRestart = value === true
  return freshSessionOnRestart
}

/** 只给测试用：还原**默认值**（不是硬编码的 false —— 否则变异测试抓不到默认值改动）。 */
export function resetFreshSessionOnRestart(): void {
  freshSessionOnRestart = DEFAULT_FRESH_SESSION_ON_RESTART
}

/**
 * 会话复用上限：链式模式下**不按轮数轮换**。
 *
 * 🔴 2026-09-30 用户报"链式还没结束就已经清理了，当然网页版上面不会有上下文"：
 * 全量模式下按 `sessionReuseTurns`（默认 20）轮换是对的 —— 每轮都是根消息，会话只是"壳"，
 * 换一个不丢任何东西。但**链式模式下会话就是链的载体**：轮换 = 定期把上下文清掉，
 * 模型那边真的会断。所以链式模式下上限取 ∞，要清只有两条明路：
 * 面板的「立即清理」，或者链断了（换窗口/head 变了/失败退役）时自动换新。
 *
 * ⚠️ `maxTurns <= 0` 是用户**显式**关掉复用（每次新会话）⇒ 不改写他，链式下自然也用不上。
 */
export function effectiveReuseLimit(maxTurns: number, mode: ContextMode): number {
  if (!(maxTurns > 0)) return maxTurns
  return mode === 'chained' ? Number.POSITIVE_INFINITY : maxTurns
}

/**
 * 本轮能不能接着链往下发（替代旧的"严格前缀"判据，2026-10-01）。
 *
 * ## 旧判据为什么会毁掉整个链式投喂
 *
 * 旧实现要求**严格前缀**：`prev[i] === next[i]` 对全部 i 成立。只要有**一条**被改写，
 * 整条链就作废 ⇒ `parent=null` ⇒ 网页端出现同层根消息（「修改 / 重新生成」+ `n / n`），
 * 或者（0.6.10~0.6.21）直接换一个新会话。
 *
 * 而实测 DSH **每一轮**都会重写它自己注入的那条运行时快照，原话就在会话日志里：
 *   `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`
 * —— 它是**替换式**的（位置不变、内容每轮变），所以"严格前缀"在 DSH 下几乎每轮都失败。
 *
 * ## 新判据（够严，但不至于被一条注入打穿）
 *
 * 1. **必须真的变长** —— 长度没增长时说不清是"重发"还是"历史被截断/压缩"，保守退回；
 * 2. **链尾仍在原位**（`next[prev.length-1] === prev[prev.length-1]`）——
 *    这条同时挡住了两种真正危险的情况：整体重写、以及在中途**插入/删除**条目
 *    （那会让增量切错位置、漏掉内容）。
 *
 * 满足这两条时，中间的差异只可能是**原位替换**（就是那条运行时快照），
 * 而增量按 `next.slice(prev.length)` 切出来的正好是**真正的新内容** —— 长度对齐，
 * 被替换的那条不会挤进增量里。
 */
function canExtendChain(prev: readonly string[], next: readonly string[]): boolean {
  if (next.length <= prev.length) return false
  return next[prev.length - 1] === prev[prev.length - 1]
}

/**
 * 决定本轮发什么。**纯函数**：不读文件、不看时间、不改全局状态。
 *
 * 判据宁可保守：只要能续链就发增量，任何一处不确定就**重发全量**。
 *
 * ⚠️ 但"重发全量"**不等于**发根消息（0.6.23）：只要链还在（同一个网页端会话、同一个账号），
 * 重发的那条仍然挂在**链尾**（见 `replay`）—— 发 `parent=null` 会让网页端把它渲染成
 * 同层的另一条消息（「修改 / 重新生成」+ `n / n`），也就是"聊着聊着分叉了"。
 * 只有**真的没有链**时（新会话 / 换了会话 / 换了账号）才发根消息（见 `detach`）。
 */
export function decideFeed(input: FeedInput): FeedDecision {
  const full = input.full
  if (input.mode !== 'chained') return { prompt: full, parentMessageId: null, next: undefined, reason: 'mode-full' }

  const head = input.head
  const entries = input.entries
  if (typeof head !== 'string' || !Array.isArray(entries)) {
    return { prompt: full, parentMessageId: null, next: undefined, reason: 'no-parts' }
  }

  /** 没有可用的链（= 这个网页端会话的第一条消息）⇒ 只能发根消息，这是唯一合法的情况。 */
  const detach = (reason: FeedReason): FeedDecision => ({
    prompt: full,
    parentMessageId: null,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason,
  })

  /**
   * 「链还在，但这一轮不能只发增量」⇒ 重发全量，但仍**挂在链尾**。
   *
   * 🔴 这是 2026-10-01 用户明确要求的取舍：**宁可多发一次，也绝不发根消息**。
   * 旧实现这里一律 `parentMessageId: null` —— 网页端会把这条渲染成**同层的另一条消息**
   * （「修改 / 重新生成」+ `n / n` 翻页），用户看到的就是"聊着聊着分叉了"。
   * 挂在链尾的代价只是服务端上下文里多一段重复历史（多花一点 token），
   * 而分叉是**结构性**的坏：它会永久破坏"一个窗口一条对话线"这个形态。
   *
   * 🔴 2026-10-02 补：**头没变时不再重发固定头**。
   * 走到这里说明链还在（同一个网页端会话、同一个账号）⇒ 那条会话的**首条消息**里
   * 已经把固定头给过了，重发它是纯粹的重复。而它就是"重发一大段"里的**那一大段**
   * （system + 协议指令 + 工具目录，实测约 **6.35 万字符**）。
   * 用户在网页端看到的现象（同一段 Tool Calling Protocol 出现两次）就是它。
   * ⚠️ 只有 `head-changed` 必须重发头（新头没给过），所以那条路径**不**走这个优化。
   */
  const replay = (reason: FeedReason, options: { headUnchanged?: boolean; from?: number } = {}): FeedDecision => {
    const prompt = replayPrompt(options)
    return {
      prompt,
      parentMessageId: chain.parentId,
      next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
      reason,
    }
  }

  /**
   * 重发时到底发哪一段。**按代价从小到大试，第一个可用的就用**，全都不行才退回整份。
   *
   * 🔴 2026-10-02 第二轮的现场（用户报"我只说了『哇哦帅气』，发出去的提示词怎么这么长"）：
   *    `not-appended` 走这条路时发的是**整份历史**，而历史里全是 `Assistant: …` 条目 ——
   *    也就是**模型自己刚说过的那段回答**。于是：① 5 个字的输入发出去 40193 字符；
   *    ② 网页端的用户气泡里赫然是"上一句回答 + 我的新消息"，看着就像"我把答案喂给它让它复述"。
   *    增量路径**早就有**"剔掉模型回声"这条规则（0.6.17 为同样的投诉加的），**这条路没走它** ——
   *    当时注释还写着"只在增量里剔"，理由站在"全量是从零重述"那边；但 replay 根本不是从零重述：
   *    链还在（同会话、同账号），该会话里什么都有。所以这里必须按**同一套网**来。
   *
   * 四档（每档都要求"非空且不超预算"）：
   *   ① 从**第一个分歧点**起的条目（剔回声）—— 最小，通常就是这一句新消息；
   *   ② 整份条目（剔回声）—— 分歧点算不出来时退一步，至少不再把模型的话喂回去；
   *   ③ `transcript`（0.6.32：省掉固定头）；
   *   ④ 整份 `full` —— 什么都算不出来时的兜底。
   * ⚠️ 头**变了**时只有 ④ 合法（新头从没发过）。
   */
  const replayPrompt = ({ headUnchanged = false, from }: { headUnchanged?: boolean; from?: number }): string => {
    if (headUnchanged) {
      const budget = Number.isFinite(input.maxChars) ? (input.maxChars as number) : Number.POSITIVE_INFINITY
      const usable = (text: string): boolean => text.trim().length > 0 && text.length <= budget
      if (from !== undefined && from < entries.length) {
        const tail = entries.slice(from)
        const withoutEcho = tail.filter((line) => !isAssistantTranscriptEntry(line))
        const tailText = (withoutEcho.length > 0 ? withoutEcho : tail).join('\n\n')
        if (usable(tailText)) return tailText
      }
      const noEcho = entries.filter((line) => !isAssistantTranscriptEntry(line)).join('\n\n')
      if (usable(noEcho)) return noEcho
      if (typeof input.transcript === 'string' && usable(input.transcript)) return input.transcript
    }
    return full
  }

  if (!input.reused) return detach('new-session')
  const chain = input.chain
  if (!chain) return detach('no-chain')
  // 换了会话 / 换了账号 ⇒ 旧链的 message_id 在新会话里没有意义，只能当新会话的第一条。
  if (chain.sessionId !== input.sessionId) return detach('session-changed')
  if (chain.accountKey !== input.accountKey) return detach('account-changed')
  // 头变了 ⇒ 新头从没发过，必须整份重发（这条**不能**省头）
  if (chain.head !== head) return replay('head-changed')
  // ⚠️ 这里曾经是 `isStrictPrefix`。它会被**每条**被改写的运行时注入打穿（DSH 每轮都改），
  // 于是链式投喂在真机上"每轮都重开"—— 见 canExtendChain 的注释。
  // 头这一行已经确认两者相同 ⇒ 下面这条只可能是"历史没按预期追加"。
  // 既然链还在，就只发**从分歧点起**那些服务端没见过的条目（见 replayPrompt 的说明）。
  if (!canExtendChain(chain.entries, entries)) {
    return replay('not-appended', { headUnchanged: true, from: firstDifference(chain.entries, entries) })
  }

  // 🔴 剔除「模型回声」（0.6.17）：增量里 `Assistant: …` 那些条目是**服务端上一轮的输出**，
  // 它已经在链上了（就在我们要挂的父消息位置）。再当输入发一遍既白烧 token，
  // 又让模型看到自己在"自言自语"。
  // ⚠️ 只在增量里剔：全量 prompt 需要完整对话（那份是"从零重述"），剔了会丢上下文。
  const appended = entries.slice(chain.entries.length)
  // ⚠️ 续写/纠正轮整体跳过剔除：那一轮的"回声"是**故意**发的（半截回答 + 续写指令），
  // 剔掉模型就只能从零重写。判据用插件自己的指令常量（`isContinuationCue`），不猜文案。
  const continuation = appended.some((line) => isContinuationCue(line))
  const meaningful = continuation ? appended : appended.filter((line) => !isAssistantTranscriptEntry(line))
  const echoDropped = meaningful.length > 0 ? appended.length - meaningful.length : 0
  // 边界：尾巴上**只有**回声（没有新的用户/工具内容）时不做剔除 —— 宁可多发一段，
  // 也不要发空增量让这一轮退化成重开链（那会连带换掉会话，代价大得多）。
  const delta = (meaningful.length > 0 ? meaningful : appended).join('\n\n')
  if (delta.trim().length === 0) return replay('empty-delta')
  const cap = input.maxChars
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && delta.length > cap) {
    return replay('delta-too-long')
  }
  return {
    prompt: delta,
    parentMessageId: chain.parentId,
    next: { head, entries: entries.slice(), sessionId: input.sessionId, accountKey: input.accountKey },
    reason: 'chained',
    ...(echoDropped > 0 ? { echoDropped } : {}),
  }
}

// ── 设置：当前模式 + 落盘（照 transport.ts 那套）────────────────────────────

let currentMode: ContextMode = DEFAULT_CONTEXT_MODE

/** 取当前生效的模式（即时生效，无需重启）。 */
export function currentContextMode(): ContextMode {
  return currentMode
}

/** 设置当前模式（设置页保存时立刻生效，无需重启）。 */
export function applyContextMode(mode: ContextMode): ContextMode {
  currentMode = mode
  return currentMode
}

/** 只给测试用：还原默认。 */
export function resetContextMode(): void {
  currentMode = DEFAULT_CONTEXT_MODE
}

export function contextModeSettingsPath(): string {
  return join(resolveDshHome(), 'web-login', 'context-feed.json')
}

export function readContextModeSetting(): ContextMode | undefined {
  try {
    const file = contextModeSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeContextMode(parsed?.contextMode)
  } catch {
    return undefined
  }
}

export function writeContextModeSetting(mode: ContextMode): void {
  const file = contextModeSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ contextMode: mode }, null, 2) + '\n', 'utf8')
}
