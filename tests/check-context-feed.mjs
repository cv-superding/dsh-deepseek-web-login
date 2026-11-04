/**
 * 回归：上下文投喂方式（每轮全量 vs 链式增量）。
 *
 * 这是"往网页端发什么"的开关，判据错了代价不对称：
 *  - 该发全量却发了增量 → 模型上下文缺一段、还可能续到一个不存在的父消息上；
 *  - 该发增量却发了全量 → 只是多花点 token（和以前行为一致）。
 * 所以每一条"不确定"都必须落到全量，本文件重点守这些**回退**路径。
 *
 * 另外守住设置读写：文件损坏/值非法要回落默认、不许崩。
 *
 * 用法: node tests/check-context-feed.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先钉住 DSH_HOME，测试不许碰真实的 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'dsh-context-feed-'))
process.env.DSH_HOME = HOME

const {
  DEFAULT_CONTEXT_MODE,
  applyContextMode,
  contextModeSettingsPath,
  currentContextMode,
  decideFeed,
  normalizeContextMode,
  readContextModeSetting,
  resetContextMode,
  writeContextModeSetting,
  needsFreshSession,
  effectiveReuseLimit,
  applyFreshSessionOnRestart,
  currentFreshSessionOnRestart,
  resetFreshSessionOnRestart,
  DEFAULT_FRESH_SESSION_ON_RESTART,
} = await import('../src/context-feed.ts')
// 续写指令的**单一来源**（0.6.17 从 adapter.ts 挪到 protocol.ts）—— 用例也不自造文案
const { CONTINUE_INSTRUCTION } = await import('../src/protocol.ts')
// 清理器：用来守"切到不删不许真的删"（0.6.22）—— 那是行为断言，比扫源码强
const { createSessionCleaner, setSessionLifecycleHook } = await import('../src/webapi.ts')

let failed = 0
let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(` ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(` ✗ ${name}\n   ${error?.message ?? error}`)
  }
}

const HEAD = 'SYSTEM+协议+工具目录'
const ENTRIES = (...items) => items

// ── 0.6.22：默认值本身必须是「不换会话」────────────────────────────────────
// ⚠️ 这条必须**放在所有 apply/reset 之前** —— 它断言的是"模块刚加载、还没被任何
// 设置改过"的初始状态。放到后面就只能测到 reset 的返回值，测不到真实默认值。
test('模块初始状态：重开链不换会话（新装的人一个窗口就一个会话）', () => {
  assert.equal(currentFreshSessionOnRestart(), false)
})
// 默认值只有一个来源（声明 + reset 都读它）。这条守的是"改默认值会被发现"：
// 第一版把 reset 里写成字面量 false，导致"默认改成 true"这个变异跑不出红。
test('默认值常量是 false，且 reset 回到的是它（单一来源）', () => {
  assert.equal(DEFAULT_FRESH_SESSION_ON_RESTART, false)
  applyFreshSessionOnRestart(true)
  assert.equal(currentFreshSessionOnRestart(), true)
  resetFreshSessionOnRestart()
  assert.equal(
    currentFreshSessionOnRestart(),
    DEFAULT_FRESH_SESSION_ON_RESTART,
    'reset 必须回到默认值本身，不能硬编码',
  )
})

/**
 * 续写轮的真实条目形状（照 `adapter.ts` 拼续写 prompt 的写法）：
 * 原对话 + 已输出的半截回答（作为 assistant）+ 续写指令。
 */
const continuationEntries = (partial) => ENTRIES('User: 原始需求', `Assistant: ${partial}`, `User: ${CONTINUE_INSTRUCTION}`)

/** 基础输入：链式模式、复用同一会话、头部一致、已有一条链。 */
function chainedInput(overrides = {}) {
  const entries = overrides.entries ?? ENTRIES('User: 一', 'Assistant: 答一', '[Tool Result for c1]\n结果')
  const chainEntries = overrides.chainEntries ?? entries.slice(0, entries.length - 1)
  return {
    mode: 'chained',
    head: HEAD,
    entries,
    full: 'FULL-PROMPT',
    sessionId: 'sess-1',
    accountKey: 'acc-1',
    reused: true,
    chain: {
      head: HEAD,
      entries: chainEntries,
      parentId: 42,
      sessionId: 'sess-1',
      accountKey: 'acc-1',
      ...(overrides.chainPatch ?? {}),
    },
    ...(overrides.input ?? {}),
  }
}

// ── 全量模式：什么都不变（必须和 0.1.61 及以前完全一致）────────────────────

test('full 模式：永远发全量、parent 为 null、不建链', () => {
  const d = decideFeed({
    ...chainedInput(),
    mode: 'full',
  })
  assert.equal(d.prompt, 'FULL-PROMPT')
  assert.equal(d.parentMessageId, null)
  assert.equal(d.next, undefined)
  assert.equal(d.reason, 'mode-full')
})

test('full 模式：即使没有结构化 prompt 也不受影响', () => {
  const d = decideFeed({ mode: 'full', full: 'X', sessionId: 's', accountKey: 'a', reused: true })
  assert.equal(d.prompt, 'X')
  assert.equal(d.parentMessageId, null)
  assert.equal(d.reason, 'mode-full')
})

// ── 链式：能续就发增量 ──────────────────────────────────────────────────

test('链式 + 严格追加：只发新增条目，parent 指上一轮 assistant', () => {
  const d = decideFeed(chainedInput())
  assert.equal(d.reason, 'chained')
  assert.equal(d.prompt, '[Tool Result for c1]\n结果')
  assert.equal(d.parentMessageId, 42)
  assert.deepEqual(d.next?.entries, ENTRIES('User: 一', 'Assistant: 答一', '[Tool Result for c1]\n结果'))
})

test('链式 + 一次追加多条：用空行拼接（与 transcript 的分隔一致）', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'User: 二', 'User: 三'),
      chainEntries: ENTRIES('User: 一'),
    }),
  )
  assert.equal(d.reason, 'chained')
  assert.equal(d.prompt, 'User: 二\n\nUser: 三')
})

test('链式 + 续写轮（原对话 + 半截回答 + 继续指令）：增量只含新增那两条', () => {
  // 0.6.17：这里改用**真实的**续写指令常量（原来用的是自造文案）。
  // 续写轮的"回声"是故意发的 —— 剔掉它模型就只能从零重写，所以那两轮必须跳过剔除。
  // `continuationEntries` 就是 adapter.ts 拼续写 prompt 时的真实形状。
  const base = ENTRIES('User: 原始需求')
  const d = decideFeed(
    chainedInput({
      entries: continuationEntries('用户原始需求的那一轮半截回答'),
      chainEntries: base,
      chainPatch: { entries: base, parentId: 77 },
    }),
  )
  assert.equal(d.reason, 'chained')
  assert.equal(
    d.prompt,
    `Assistant: 用户原始需求的那一轮半截回答\n\nUser: ${CONTINUE_INSTRUCTION}`,
    '续写轮必须把半截回答带上，否则模型会重写一遍',
  )
  assert.equal(d.echoDropped, undefined, '续写轮不剔回声')
  assert.equal(d.parentMessageId, 77)
})

// ── 链式：任何一处不确定都必须退回全量 ──────────────────────────────────

test('没有链：起链（发全量 + parent null），并把这轮当作链首', () => {
  const d = decideFeed({
    mode: 'chained',
    head: HEAD,
    entries: ENTRIES('User: 一'),
    full: 'FULL',
    sessionId: 'sess-1',
    accountKey: 'acc-1',
    reused: true,
  })
  assert.equal(d.reason, 'no-chain')
  assert.equal(d.prompt, 'FULL')
  assert.equal(d.parentMessageId, null)
  assert.deepEqual(d.next?.entries, ENTRIES('User: 一'))
})

test('本轮是新会话（reused=false）：不复用旧链，重新起链', () => {
  const d = decideFeed(chainedInput({ input: { reused: false } }))
  assert.equal(d.reason, 'new-session')
  assert.equal(d.parentMessageId, null)
  assert.equal(d.prompt, 'FULL-PROMPT')
})

test('会话换了：重新起链', () => {
  const d = decideFeed(chainedInput({ input: { sessionId: 'sess-2' } }))
  assert.equal(d.reason, 'session-changed')
  assert.equal(d.parentMessageId, null)
})

test('账号换了（切号）：重新起链', () => {
  const d = decideFeed(chainedInput({ input: { accountKey: 'acc-2' } }))
  assert.equal(d.reason, 'account-changed')
  assert.equal(d.parentMessageId, null)
})

test('固定头变了（系统提示/工具目录）：重发全量，但仍挂链尾（不发根消息）', () => {
  const d = decideFeed(chainedInput({ input: { head: HEAD + '（工具变了）' } }))
  assert.equal(d.reason, 'head-changed')
  assert.equal(d.prompt, 'FULL-PROMPT', '头部变了 ⇒ 这一轮必须重发全量')
  // ★ 0.6.23：parent 不再是 null —— 见 decideFeed 里 `replay` 的说明
  assert.equal(d.parentMessageId, 42, '★ 有链就挂链尾：发根消息会让网页端分叉')
  assert.deepEqual(d.next?.entries, ENTRIES('User: 一', 'Assistant: 答一', '[Tool Result for c1]\n结果'))
})

test('★ 链尾那条被改写（不是纯追加）：只发**从分歧点起**的条目，不再重发整份历史', () => {
  // 2026-10-02 用户现场的核心：他只说了 5 个字，发出去 40193 字符，
  // 而网页端的用户气泡里是"上一句回答 + 新消息" —— 等于把模型自己刚说的话又喂回去。
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'Assistant: 答一（被压缩重写过）', '[Tool Result for c1]\n结果'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一'),
    }),
  )
  assert.equal(d.reason, 'not-appended')
  // 分歧在下标 1 ⇒ 发 [1..]；其中 `Assistant:` 是模型自己刚说的 ⇒ 剔掉（与增量路径同一条网）
  assert.equal(d.prompt, '[Tool Result for c1]\n结果', '只发服务端还没见过的部分')
  assert.notEqual(d.prompt, 'FULL-PROMPT', '自证：不再重发整份历史')
  assert.equal(d.parentMessageId, 42, '★ 挂链尾，不发根消息')
})

test('★ 历史变短（回退）⇒ 发剩下的条目（剔回声），仍挂链尾', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一', 'User: 二'),
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'User: 一', '链还在 ⇒ 不重发固定头、也不重发历史；分歧点之后无条目 ⇒ 退到"整份剔回声"')
  assert.equal(d.parentMessageId, 42, '★ 挂链尾，不发根消息')
})

test('条目数没变（同一步重试）：重发全量但挂链尾', () => {
  const same = ENTRIES('User: 一', 'Assistant: 答一')
  const d = decideFeed(chainedInput({ entries: same, chainEntries: same }))
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.parentMessageId, 42, '★ 挂链尾，不发根消息')
})

// ── 0.6.33：重发时**只发服务端没见过的部分**（并剔掉模型回声）─────────────────
// 走到 `replay` 说明链还在（同一网页端会话、同一账号）⇒ 那条会话里**固定头和历史都还在**，
// 重发它们纯属重复。2026-10-02 第二次现场（用户："我只说了『哇哦帅气』，
// 发出去的提示词怎么这么长"）：历史里有全部 `Assistant:` 条目 ⇒ 模型被喂了它自己刚说的话，
// 网页端的用户气泡里就是"上一句回答 + 新消息"。

test('★ 链尾被改写 + 头没变 ⇒ 只发分歧点之后的条目（4 档里最小的那档）', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'Assistant: 答一（被压缩重写过）', '[Tool Result for c1]\n结果'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一'),
      input: { transcript: 'TRANSCRIPT-ONLY' },
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, '[Tool Result for c1]\n结果', '有更小的档就用它 —— 不该退到整份 transcript')
  assert.notEqual(d.prompt, 'TRANSCRIPT-ONLY', '自证：确实没停在 0.6.32 那一档')
  assert.notEqual(d.prompt, 'FULL-PROMPT', '自证：也没退回旧的全量行为')
  assert.equal(d.parentMessageId, 42, '★ 仍然挂链尾，不发根消息')
  assert.deepEqual(
    d.next?.entries,
    ENTRIES('User: 一', 'Assistant: 答一（被压缩重写过）', '[Tool Result for c1]\n结果'),
    '链的记账不受"发什么"影响',
  )
})

test('★ 模型回声必须剔掉（这正是用户看到"答案被喂回去"的那一半）', () => {
  // ⚠️ 必须构造成**非追加**：链尾那条被改写过（`答一` vs `旧回答`），否则走的是 chained（第一版就踩了）
  const chainEntries = ENTRIES('User: 一', 'Assistant: 旧回答（被压缩改写）')
  const entries = ENTRIES('User: 一', 'Assistant: 答一', 'User: 二')
  const d = decideFeed(chainedInput({ entries, chainEntries, chainPatch: { entries: chainEntries } }))
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'User: 二', '分歧点在 1 ⇒ 发 [1..]，其中 Assistant 那条要剔掉')
  assert.doesNotMatch(d.prompt, /Assistant:/, '不许把模型自己刚说的话当输入发回去')
})

test('★ 头变了 ⇒ 即使有更小的档也必须**整份重发**（新头从没发过）', () => {
  const d = decideFeed(
    chainedInput({ input: { head: `${HEAD}（工具目录变了）`, transcript: 'TRANSCRIPT-ONLY' } }),
  )
  assert.equal(d.reason, 'head-changed')
  assert.equal(d.prompt, 'FULL-PROMPT', '新头没给过 ⇒ 必须连头一起发，否则模型手里是旧头')
})

test('★ 算不出更小的档 ⇒ 退到"整份剔回声"（仍不发固定头、不发模型回声）', () => {
  const same = ENTRIES('User: 一', 'Assistant: 答一')
  const d = decideFeed(chainedInput({ entries: same, chainEntries: same }))
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'User: 一', '条目没变 ⇒ 分歧点之后无内容 ⇒ 退一档：整份剔回声')
})

test('★ 全是被剔掉的内容时不许发空串（退回原样，宁可多发一段）', () => {
  // 同样必须构造成**非追加**（链尾那条被改写），否则走 chained 而不是 replay
  const chainEntries = ENTRIES('User: 一', 'Assistant: 旧回答')
  const entries = ENTRIES('User: 一', 'Assistant: 答一')
  const d = decideFeed(chainedInput({ entries, chainEntries, chainPatch: { entries: chainEntries } }))
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'Assistant: 答一', '尾巴上只有回声 ⇒ 原样发它（发空串会让这一轮没法进行）')
  assert.ok(d.prompt.trim().length > 0, '★ 永远不许给出空 prompt')
})

test('★ 四档都算不出来时退回整份（兜底仍在，且挂链尾）', () => {
  // 条目为空 ⇒ 算不出任何更小的档 ⇒ 只能发 full
  const chainEntries = ENTRIES('User: 一')
  const d = decideFeed(
    chainedInput({ entries: [], chainEntries, chainPatch: { entries: chainEntries } }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'FULL-PROMPT', '兜底：什么都不会算时还是发整份')
  assert.equal(d.parentMessageId, 42, '★ 即使发整份也挂链尾')
})

test('★ 历史变短（回退）+ 给了 transcript ⇒ 也走更小的档', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一', 'User: 二'),
      input: { transcript: 'TRANSCRIPT-ONLY' },
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'User: 一')
})

test('★ 历史变短（回退）+ 给了 transcript ⇒ 同样只发更小的那档', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一', 'User: 二'),
      input: { transcript: 'TRANSCRIPT-ONLY' },
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.prompt, 'User: 一', '有更小的档就别用整份 transcript')
})

test('追加了条目但内容全空白：当作没有新增 → 重发全量但挂链尾', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', '   '),
      chainEntries: ENTRIES('User: 一'),
    }),
  )
  assert.equal(d.reason, 'empty-delta')
  assert.equal(d.parentMessageId, 42, '★ 挂链尾，不发根消息')
})

test('增量本身超预算：不值当冒险 → 重发全量但挂链尾', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'X'.repeat(500)),
      chainEntries: ENTRIES('User: 一'),
      input: { maxChars: 100 },
    }),
  )
  assert.equal(d.reason, 'delta-too-long')
  assert.equal(d.parentMessageId, 42, '★ 挂链尾，不发根消息')
})

// ── 0.6.23：DSH 每轮改写"运行时注入" ⇒ 必须续链，不许断 ──────────────────────
// 现场（2026-10-01，会话 13fc4478 的原始事件）：DSH 每轮都重写它注入的运行时快照
//   `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`
// —— **替换式**：位置不变、内容每轮变。旧的"严格前缀"判据因此几乎每轮都失败
// ⇒ `parent` 变 null ⇒ 网页端出现同层根消息（0.6.21 及以前还会直接换一个新会话）。
// 用户看到的正是"聊着聊着就分叉 / 会话变多"。
test('★ 运行时注入被原地替换（DSH 每轮都这样）⇒ 仍然续链，parent 保持链尾', () => {
  const chainEntries = ENTRIES('User: 一', 'User: <runtime ctx: 12:50>', 'Assistant: 答一')
  const entries = ENTRIES('User: 一', 'User: <runtime ctx: 12:51>', 'Assistant: 答一', 'User: 二')
  const d = decideFeed(
    chainedInput({ entries, chainEntries, chainPatch: { entries: chainEntries, parentId: 9 } }),
  )
  assert.equal(d.reason, 'chained', '注入被替换不该打断链')
  assert.equal(d.prompt, 'User: 二', '增量必须只是真正的新内容（被替换那条不该挤进来）')
  assert.equal(d.parentMessageId, 9)
})

test('★ 中途插入条目（不是原位替换）⇒ 不续链，但只发**分歧点之后**的条目，且仍挂链尾', () => {
  const chainEntries = ENTRIES('User: 一', 'Assistant: 答一')
  // 在中间插了一条 —— 就地算增量会切错位置，所以不能续链；
  // 但链还在（同会话同账号）⇒ 只发 [1..] 即可，不必重发固定头与整份历史。
  const entries = ENTRIES('User: 一', 'User: <新注入>', 'Assistant: 答一', 'User: 二')
  const d = decideFeed(
    chainedInput({ entries, chainEntries, chainPatch: { entries: chainEntries, parentId: 9 } }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(
    d.prompt,
    'User: <新注入>\n\nUser: 二',
    '从分歧点（下标 1）起发；`Assistant: 答一` 是模型自己刚说的 ⇒ 剔掉',
  )
  assert.equal(d.parentMessageId, 9, '★ 仍挂链尾 —— 发根消息会在网页端产生分叉')
})

test('增量刚好不超预算：仍然走增量（边界）', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'X'.repeat(100)),
      chainEntries: ENTRIES('User: 一'),
      input: { maxChars: 100 },
    }),
  )
  assert.equal(d.reason, 'chained')
  assert.equal(d.prompt.length, 100)
})

test('调用方没给结构化 prompt（只有字符串）：退回全量且不建链', () => {
  const d = decideFeed({ mode: 'chained', full: 'FULL', sessionId: 's', accountKey: 'a', reused: true })
  assert.equal(d.reason, 'no-parts')
  assert.equal(d.prompt, 'FULL')
  assert.equal(d.parentMessageId, null)
  assert.equal(d.next, undefined)
})

test('entries 传成非数组（调用方写错）：不抛异常，退回全量', () => {
  const d = decideFeed({
    mode: 'chained',
    head: HEAD,
    entries: 'not-an-array',
    full: 'FULL',
    sessionId: 's',
    accountKey: 'a',
    reused: true,
  })
  assert.equal(d.reason, 'no-parts')
  assert.equal(d.prompt, 'FULL')
})

// ── 纯函数性质：不改入参 ────────────────────────────────────────────────

test('decideFeed 不改动传进来的 entries/chain（纯函数）', () => {
  const entries = ENTRIES('User: 一', 'Assistant: 答一', 'User: 二')
  const chainEntries = ENTRIES('User: 一', 'Assistant: 答一')
  const input = chainedInput({ entries, chainEntries })
  const before = JSON.stringify(input)
  const d = decideFeed(input)
  assert.equal(JSON.stringify(input), before)
  assert.notEqual(d.next?.entries, entries, 'next.entries 必须是副本，不能是同一个数组引用')
})

// ── 当前模式（即时生效）────────────────────────────────────────────────

test('当前模式默认是 chained，applyContextMode 立即改变它', () => {
  resetContextMode()
  // 2026-11-03：默认从 full 改成 chained（全量模式每轮发根消息 ⇒ 网页端显示成「修改/重新生成」分叉）
  assert.equal(DEFAULT_CONTEXT_MODE, 'chained')
  assert.equal(currentContextMode(), 'chained')
  applyContextMode('chained')
  assert.equal(currentContextMode(), 'chained')
  // 复原，免得影响别的用例
  resetContextMode()
})

test('normalizeContextMode 只认两个合法值', () => {
  assert.equal(normalizeContextMode('chained'), 'chained')
  assert.equal(normalizeContextMode('full'), 'full')
  assert.equal(normalizeContextMode('CHAINED'), undefined)
  assert.equal(normalizeContextMode(undefined), undefined)
  assert.equal(normalizeContextMode(1), undefined)
})

// ── 设置文件读写 ───────────────────────────────────────────────────────

test('写进去再读出来是同一个值', () => {
  writeContextModeSetting('chained')
  assert.equal(readContextModeSetting(), 'chained')
  const raw = JSON.parse(readFileSync(contextModeSettingsPath(), 'utf8'))
  assert.equal(raw.contextMode, 'chained')
  assert.ok(existsSync(join(HOME, 'web-login')))
})

test('文件里是非法值时回落 undefined（不崩）', () => {
  writeFileSync(contextModeSettingsPath(), JSON.stringify({ contextMode: 'nope' }), 'utf8')
  assert.equal(readContextModeSetting(), undefined)
})

test('文件损坏（不是 JSON）时回落 undefined（不崩）', () => {
  writeFileSync(contextModeSettingsPath(), '{ 这不是 json', 'utf8')
  assert.equal(readContextModeSetting(), undefined)
})

test('文件不存在时返回 undefined（走默认）', () => {
  writeFileSync(contextModeSettingsPath(), '{}', 'utf8')
  assert.equal(readContextModeSetting(), undefined)
})

// ── serializePromptParts：与 serializePrompt 同源，且能还原出 full ─────────
// （0.1.62 把 serializePrompt 拆成"返回结构 + full"，所有既有调用点都走包装函数，
//   所以这里必须证明两边逐字节一致，且 head/entries 能拼回 full。）

const { serializePrompt, serializePromptParts } = await import('../src/protocol.ts')

const partsOptions = {
  system: '你是助手。',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }] }] },
  ],
  tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
  maxChars: 100_000,
}

test('serializePromptParts().full 与 serializePrompt() 逐字节一致', () => {
  const parts = serializePromptParts(partsOptions)
  assert.equal(parts.full, serializePrompt(partsOptions))
})

test('未超预算时 head + --- + entries 能拼回 full（增量才有意义）', () => {
  const parts = serializePromptParts(partsOptions)
  assert.equal(`${parts.head}\n\n---\n\n${parts.entries.join('\n\n')}`, parts.full)
  assert.ok(parts.entries.length >= 3, '转写条目要真的被拆出来')
})

// ── transcript：重发路径靠它省掉固定头，错了就会发错内容 ────────────────────
// 0.6.32：`replay` 在"头没变"时只发 `transcript`（固定头已在会话首条消息里给过）。
// 所以 `transcript` 必须**恒等于** full 里属于历史的那一段。
test('★ transcript 恒等于 full 里"属于历史的那一段"（未超预算）', () => {
  const parts = serializePromptParts(partsOptions)
  assert.equal(parts.full, `${parts.head}\n\n---\n\n${parts.transcript}`, 'full = 头 + 分隔 + 历史')
  assert.equal(parts.transcript, parts.entries.join('\n\n'), '未截断时它与条目拼出来的那份一致')
})

// ── ★ 工具返回被 DSH 塞成普通 user 文本 ⇒ 必须认出来并标注 ─────────────────────
// 2026-10-02 现场：用户问"现在几点"，DSH 跑了 pwsh，然后把输出当成一条**普通 user 文本**交给我们
// （而不是 `tool-result` 块）。我们照实渲染成 `User: 2026-10-02 18:54:28 星期五`，
// 模型读到的是"用户告诉了我时间"，它自己的思考原话：「我没拿到工具结果，用户直接给了时间」，
// 回答于是变成「收到，…」。判据：assistant 发过工具调用 ⇒ 紧随的那条 user 文本就是工具返回。

const withCallThenText = (resultText) => ({
  system: 'SYS',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '现在几点' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下。' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'pwsh', arguments: '{"command":"Get-Date"}' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: resultText }] },
  ],
  tools: [{ name: 'pwsh', description: '跑命令', parameters: { type: 'object', properties: {} } }],
  maxChars: 100_000,
})

// ── ★★ 主路径：DSH 的工具返回是 `role: 'tool'`（不是 user + tool-result 块）────────
// 形状取自真机会话日志的 `tool/result` 事件（session-2986baba，turn 3）：
//   {"role":"tool","toolCallId":"call_c2cf288c12734112b11e",
//    "content":[{"type":"text","text":"2026-10-02 18:54:28 星期五\r\n"}],"isError":false}
// 原先**没有这个分支** ⇒ 它掉进 user 分支 ⇒ 渲染成 `User: 2026-10-02 18:54:28 星期五`
// ⇒ 模型以为"用户告诉了我时间"（实测思考原话：「我没拿到工具结果，用户直接给了时间」）。
const REAL_TOOL_RESULT = {
  role: 'tool',
  source: { kind: 'tool', callId: 'call_c2cf288c12734112b11e' },
  toolCallId: 'call_c2cf288c12734112b11e',
  content: [{ type: 'text', text: '2026-10-02 18:54:28 星期五\r\n' }],
  isError: false,
}

test('★★ role:"tool" ⇒ 标成 [Tool Result for toolCallId]，不许掉进 user 分支', () => {
  // ⚠️ assistant 那侧的 id 与本条 `toolCallId` **故意不同**：
  //    两条路（主分支用消息自带的 `toolCallId`、次防线用 assistant 的调用 id）产出的文本才可区分。
  //    第一版我把两边写成同一个 id ⇒ 关掉主分支时次防线照样给出同样结果、测试**仍然全绿**
  //    —— 典型的"两个来源同一个值就测不出真伪"（今天已经踩过一次）。
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你知道现在几点嘛' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_FROM_ASSISTANT', toolName: 'pwsh', arguments: '{}' }],
      },
      REAL_TOOL_RESULT,
      { role: 'assistant', content: [{ type: 'text', text: '收到，…' }] },
    ],
    tools: [{ name: 'pwsh', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(
    parts.transcript,
    /\[Tool Result for call_c2cf288c12734112b11e\]\n2026-10-02 18:54:28 星期五/,
    '★ 必须用 `role:"tool"` 消息自带的 toolCallId（走主分支）；用 assistant 侧的 id 说明是次防线在兜',
  )
  assert.doesNotMatch(parts.transcript, /call_FROM_ASSISTANT/, '不该出现 assistant 侧的 id')
  assert.doesNotMatch(
    parts.transcript,
    /User: 2026-10-02 18:54:28 星期五/,
    '★ 掉进 user 分支就会让模型以为这是用户说的 —— 这就是"收到，…"的来源',
  )
  assert.match(parts.transcript, /User: 你知道现在几点嘛/, '正向对照：真正的用户发言仍是 User')
})

test('role:"tool" 带 isError ⇒ 标 [ERROR]', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [{ ...REAL_TOOL_RESULT, isError: true }],
    tools: [{ name: 'pwsh', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /\[Tool Result \[ERROR\] for call_c2cf288c12734112b11e\]/)
})

test('★ role:"tool" 之后的**真正用户消息**仍必须是 User（主/次防线都不许误标）', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_FROM_ASSISTANT', toolName: 'pwsh', arguments: '{}' }],
      },
      REAL_TOOL_RESULT,
      { role: 'user', content: [{ type: 'text', text: '再查一次' }] },
    ],
    tools: [{ name: 'pwsh', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /User: 再查一次/, '工具返回已经把"预期"清掉了 ⇒ 这句是用户说的')
  assert.match(
    parts.transcript,
    /\[Tool Result for call_c2cf288c12734112b11e\]/,
    '工具返回走的是主分支（用消息自带的 id）',
  )
  assert.equal(
    (parts.transcript.match(/\[Tool Result/g) || []).length,
    1,
    '只该有一条工具返回，不许把用户消息也算进去',
  )
})

test('role:"tool" 没有 toolCallId 时也要标（至少别让它看起来像用户发言）', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      { role: 'tool', content: [{ type: 'text', text: '输出' }] },
    ],
    tools: [{ name: 'pwsh', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /\[Tool Result for \]\n输出/)
  assert.doesNotMatch(parts.transcript, /User: 输出/)
})
test('★ 次要防线：工具返回若被折进普通 user 文本 ⇒ 也要标成 [Tool Result]', () => {
  const parts = serializePromptParts(withCallThenText('2026-10-02 18:54:28 星期五'))
  assert.match(parts.transcript, /\[Tool Result for tc-1\]\n2026-10-02 18:54:28 星期五/, '必须标成工具返回并带上 id')
  assert.doesNotMatch(
    parts.transcript,
    /User: 2026-10-02 18:54:28 星期五/,
    '★ 渲染成 `User: …` 会让模型以为这是用户说的（实测它就是这么以为的）',
  )
  // 正向对照：用户真正说的那条仍必须是 User
  assert.match(parts.transcript, /User: 现在几点/, '真正的用户发言不许被误标')
})

test('assistant 没发工具调用 ⇒ 下一条 user 文本照旧是 User（防误标）', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在' }] },
      { role: 'user', content: [{ type: 'text', text: '现在几点' }] },
    ],
    tools: [{ name: 'pwsh', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /User: 现在几点/)
  assert.doesNotMatch(parts.transcript, /\[Tool Result for/, '没有工具调用就不该凭空长出工具返回')
})

test('★ 多个工具调用 + 多个文本块 ⇒ 逐个配对', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 't', arguments: '{}' },
          { type: 'tool-call', toolCallId: 'b', toolName: 't', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '结果一' },
          { type: 'text', text: '结果二' },
        ],
      },
    ],
    tools: [{ name: 't', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /\[Tool Result for a\]\n结果一/)
  assert.match(parts.transcript, /\[Tool Result for b\]\n结果二/)
})

test('★ 数量对不齐 ⇒ 合并成一条（宁可少一层对应，也不能看起来像用户发言）', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 't', arguments: '{}' },
          { type: 'tool-call', toolCallId: 'b', toolName: 't', arguments: '{}' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '只有一个块' }] },
    ],
    tools: [{ name: 't', description: 'x', parameters: { type: 'object', properties: {} } }],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /\[Tool Result for a, b\]\n只有一个块/)
  assert.doesNotMatch(parts.transcript, /User: 只有一个块/)
})

test('★ 工具调用后紧跟**带图片**的 user 消息 ⇒ 不误标（图片消息是用户发的）', () => {
  const parts = serializePromptParts({
    system: 'SYS',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'a', toolName: 't', arguments: '{}' }],
      },
      { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image', id: 'img-1' }] },
    ],
    tools: [{ name: 't', description: 'x', parameters: { type: 'object', properties: {} } }],
    keptImageKeys: ['img-1'],
    maxChars: 100_000,
  })
  assert.match(parts.transcript, /User: 看这张/, '带图的那条是用户发言，不该被当成工具返回')
  assert.doesNotMatch(parts.transcript, /\[Tool Result for a\]/)
})

test('★ 超预算被截断时 transcript 也必须是**截断后**那份（否则"只发历史"会超出上限）', () => {
  const huge = {
    ...partsOptions,
    maxChars: 12_000,
    messages: [
      ...partsOptions.messages,
      { role: 'user', content: [{ type: 'text', text: '很长的历史。'.repeat(5_000) }] },
    ],
  }
  const parts = serializePromptParts(huge)
  assert.equal(parts.full, `${parts.head}\n\n---\n\n${parts.transcript}`, 'full = 头 + 分隔 + 历史（截断后）')
  assert.notEqual(
    parts.transcript,
    parts.entries.join('\n\n'),
    '自证：这份输入确实触发了截断（否则这条用例什么都没测到）',
  )
  assert.ok(
    parts.transcript.length < parts.full.length,
    '只发历史必须比发整份更短 —— 否则这个优化等于没做',
  )
  assert.ok(
    parts.full.length <= huge.maxChars,
    '整份要在预算内（自证：不是截断逻辑本身坏了）',
  )
})

test('超预算被截断时：entries 仍是**未截断**的那份，full 才是截断后的', () => {
  const huge = {
    ...partsOptions,
    maxChars: 12_000,
    messages: [
      ...partsOptions.messages,
      { role: 'user', content: [{ type: 'text', text: '很长的历史。'.repeat(5_000) }] },
    ],
  }
  const parts = serializePromptParts(huge)
  const untruncated = `${parts.head}\n\n---\n\n${parts.entries.join('\n\n')}`
  // 自证：样本必须真的超过预算，否则这条用例压根没走到截断分支
  assert.ok(untruncated.length > 12_000, `样本不够长（${untruncated.length}），这条用例会静默失效`)
  assert.notEqual(parts.full, untruncated, 'full 必须是被截过的')
  assert.ok(parts.full.startsWith(parts.head), '固定头必须完整保留')
  assert.equal(parts.full, serializePrompt(huge))
  // 链式投喂要的就是这份未截断的条目（截断点在中间，切字符串会把位置算错）
  assert.ok(parts.entries.join('\n\n').length > parts.full.length)
})

// ── 0.6.10：重开链要不要换新会话 ──────────────────────────────────────────
// 现场（2026-09-30，用户报"换个窗口聊天就把上下文清理一次"）：重开链发的是根消息
// （parent=null），而那时用的还是**复用来的**会话 ⇒ 往一个有内容的会话里又塞一个根，
// 网页端渲染成同一条消息的多个兄弟版本（「修改 / 重新生成」+ n/n 翻页）。
// ── 0.6.22：重开链**默认不再换新会话** ─────────────────────────────────────
// 现场（2026-10-01，会话 `13fc4478`）：一个 DSH 窗口聊了两句，网页端出现**三个**会话。
// 根因不是判据写错，而是 0.6.10 的前提不成立 —— 那时假定"重开链是异常路径"，
// 实测 DSH 每轮都会重新生成**替换式**的运行时注入
// （`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`），
// 链的 entries 于是不再是本轮 entries 的严格前缀 ⇒ `decideFeed` 走 restart ⇒ parent=null
// ⇒ "重开链换新会话"**几乎每个 turn 都生效**，旧的还被交回清理。
// 现在默认**不换**（宁可让那个会话多一条根消息，也不要会话数失控）；
// 0.6.10 的行为保留成开关 —— 下面第二条守着它还活着。
test('默认：要发根消息 + 会话是复用来的 ⇒ **不**换新会话（会话数优先）', () => {
  resetFreshSessionOnRestart()
  assert.equal(needsFreshSession({ parentMessageId: null }, true, 'chained'), false)
})

test('设置项默认是关的（新装的人不该莫名其妙多出会话）', () => {
  resetFreshSessionOnRestart()
  assert.equal(currentFreshSessionOnRestart(), false)
})

test('打开开关 ⇒ 恢复 0.6.10 的行为：重开链换新会话', () => {
  applyFreshSessionOnRestart(true)
  try {
    assert.equal(needsFreshSession({ parentMessageId: null }, true, 'chained'), true)
    // 续链时一律不换（换了父链就断）—— 开关不该把这条也带歪
    assert.equal(needsFreshSession({ parentMessageId: 42 }, true, 'chained'), false)
    // 本来就是新会话 ⇒ 也不重复换
    assert.equal(needsFreshSession({ parentMessageId: null }, false, 'chained'), false)
  } finally {
    resetFreshSessionOnRestart()
  }
})
test('要发根消息但本来就是新会话 ⇒ 不重复换（否则每轮白建一个）', () => {
  assert.equal(needsFreshSession({ parentMessageId: null }, false, 'chained'), false)
})
test('续链（有父消息）⇒ 不能换会话，换了父链就断了', () => {
  assert.equal(needsFreshSession({ parentMessageId: 42 }, true, 'chained'), false)
  assert.equal(needsFreshSession({ parentMessageId: 42 }, false, 'chained'), false)
})
test('父消息 id 为 0 也算"有父"（别用 truthy 判）', () => {
  assert.equal(needsFreshSession({ parentMessageId: 0 }, true, 'chained'), false)
})
test('链式模式下不按轮数轮换会话（轮换＝定期清上下文）', () => {
  assert.equal(effectiveReuseLimit(20, 'chained'), Number.POSITIVE_INFINITY)
  assert.equal(effectiveReuseLimit(20, 'full'), 20)
})
test('用户显式关掉复用（0）时不改写他 —— 链式下也一样', () => {
  assert.equal(effectiveReuseLimit(0, 'chained'), 0)
  assert.equal(effectiveReuseLimit(0, 'full'), 0)
})
test('全量模式：即使要发根消息也不换会话（否则每轮多建+多删一个会话）', () => {
  assert.equal(needsFreshSession({ parentMessageId: null }, true, 'full'), false)
})
// 「宿主真的调用了它」——判据写好了没人调，这个项目已经犯过两次。
test('没有 promptParts 的内部请求：即使 parent=null + reused，也不强制换新会话', () => {
  assert.equal(needsFreshSession({ parentMessageId: null }, true, 'chained', false), false)
})
test('webapi 真的把这条判据接在重开链路径上（且用的是强制新会话那条租用）', () => {
  const src = readFileSync(new URL('../src/webapi.ts', import.meta.url), 'utf8')
  assert.ok(
    /needsFreshSession\(\s*feed,\s*lease\.reused,\s*currentContextMode\(\),\s*params\.promptParts !== undefined\s*\)/.test(src),
    'webapi 必须调用 needsFreshSession（并把当前模式和是否有结构化 parts 传进去）',
  )
  assert.ok(
    /needsFreshSession\([\s\S]{0,500}?leaseSession\([\s\S]{0,300}?true,/.test(src),
    '判定要换会话后，必须用 forceNew=true 重新租一个（否则只是原地打转）',
  )
})

// ── 0.6.17：增量里不许再出现「模型回声」（Assistant: …）──────────────────────
// 用户现场（2026-10-01 截图）：上一句回答被整段当成下一句的提示词发出去 ——
// 那条回答本来就是服务端的上一轮输出（就在父消息位置），重发纯属白烧 token。
test('增量剔掉模型回声：只发用户/工具结果，不发上一句回答', () => {
  const entries = ENTRIES('User: 一', 'Assistant: 答一', 'User: 二')
  const d = decideFeed(chainedInput({ entries, chainEntries: entries.slice(0, 1) }))
  assert.equal(d.reason, 'chained')
  assert.equal(d.prompt, 'User: 二', `不该把上一句回答当提示词：${JSON.stringify(d.prompt)}`)
  assert.equal(d.echoDropped, 1, '要报出剔了几条，日志里才看得见')
})

test('工具调用的回声也剔：Assistant(工具调用) + 工具结果 ⇒ 只发工具结果', () => {
  const entries = ENTRIES('User: 一', 'Assistant: 调用 read_file', '[Tool Result for c1]\n内容')
  const d = decideFeed(chainedInput({ entries, chainEntries: entries.slice(0, 1) }))
  assert.equal(d.prompt, '[Tool Result for c1]\n内容')
  assert.equal(d.echoDropped, 1)
})

test('尾巴上只有回声时不剔（宁可多发，也不要退化成重开链而换掉会话）', () => {
  const entries = ENTRIES('User: 一', 'Assistant: 答一')
  const d = decideFeed(chainedInput({ entries, chainEntries: entries.slice(0, 1) }))
  assert.equal(d.reason, 'chained', '不能因为"剔完就空了"而退回重开链')
  assert.equal(d.prompt, 'Assistant: 答一')
  assert.equal(d.echoDropped, undefined, '没剔就不报')
})

test('全量模式不受影响：回声照旧留在完整 prompt 里', () => {
  const entries = ENTRIES('User: 一', 'Assistant: 答一', 'User: 二')
  const d = decideFeed({ ...chainedInput({ entries }), mode: 'full' })
  assert.equal(d.prompt, 'FULL-PROMPT', '全量是"从零重述"，必须保留完整对话')
  assert.equal(d.echoDropped, undefined)
})

// ── 0.6.22：切到「不删」只能"放弃删除"，绝不能真的删 ─────────────────────────
// 用户现场（2026-10-01）：明明在设置页选了「不删」，网页端的会话还是被删了。
// 根因：`configure()` 对 `mode === 'keep'` 调的是 `flush()`，而 `flush()` → `doFlush()`
// → `deleteChunk()` 是**真的发 DELETE** —— 用户的意图与执行结果完全相反。
//
// 这条用**真调用**守（不扫源码）：装一个假的 fetch，断言一个 DELETE 都没发出去。
test('★ 切到「不删」必须放弃待删队列，且一个 DELETE 都不许发', () => {
  const calls = []
  const cleaner = createSessionCleaner({
    // 延迟设得极长、批量设得极大 ⇒ 队列只会"躺着"，不会自己触发清理
    policy: { mode: 'deferred', delayMs: 3_600_000, batchSize: 50 },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method ?? 'GET') })
      return new Response('{}', { status: 200 })
    },
  })
  const auth = { token: 't', cookie: 'c', userAgent: 'ua' }
  cleaner.schedule(auth, 'sess-a')
  cleaner.schedule(auth, 'sess-b')
  assert.equal(cleaner.pendingCount(), 2, '两条应先躺在队列里等着（延迟很长，不会自动清）')

  cleaner.configure({ mode: 'keep' })

  assert.equal(cleaner.pendingCount(), 0, '切成「不删」后队列必须清空')
  assert.equal(
    calls.filter((call) => call.method === 'DELETE').length,
    0,
    `★ 切到「不删」绝不能真的删会话，实际发出了：${JSON.stringify(calls)}`,
  )
})

// 「队列清空」还不够 —— 那些会话的欠账要能从 journal 销掉，否则下次启动在别的
// 清理模式下补扫，又会把它们删掉（相当于"用户说不删"只生效到本次进程结束）。
test('★ 放弃删除时要把欠账销掉（否则下次启动补扫又会删）', () => {
  const events = []
  setSessionLifecycleHook((event) => events.push(event))
  try {
    const cleaner = createSessionCleaner({
      policy: { mode: 'deferred', delayMs: 3_600_000, batchSize: 50 },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    const auth = { token: 't', cookie: 'c', userAgent: 'ua' }
    cleaner.schedule(auth, 'sess-x')
    cleaner.configure({ mode: 'keep' })
    const abandoned = events.filter((e) => e.kind === 'abandoned').map((e) => e.sessionId)
    assert.deepEqual(abandoned, ['sess-x'], '必须逐条报 abandoned，宿主才能把它从 journal 摘掉')
  } finally {
    setSessionLifecycleHook(undefined)
  }
})

test('★ 诊断留痕的路径必须跟着 DSH_HOME 走（否则跑批会污染用户的真实日志）', async () => {
  const { feedDecisionLogPath } = await import('../src/webapi.ts')
  const path = feedDecisionLogPath()
  assert.ok(
    path.startsWith(HOME),
    `留痕路径没落在被测的临时目录里 ⇒ 会写进用户真实数据。实际：${path}`,
  )
  assert.ok(
    path.includes('web-login'),
    `留痕必须落在 web-login/ 下（与账号库、gate.json 同处）。实际：${path}`,
  )
})

test('★ 末尾预填：prime=true 时 prompt 末尾是 LIDOW:，且**不进链**', () => {
  // 预填是"发送时的装饰"：只影响这一次发出去的 prompt。
  // 一旦进了 entries，下一轮那条变成中间条目、内容与链里存的不一致 ⇒ 前缀断裂 ⇒ 每轮全量重发。
  const decision = decideFeed({
    mode: 'chained',
    full: 'HEAD\n\nUser: 你好',
    head: 'HEAD',
    entries: ['User: 你好'],
    sessionId: 's1',
    accountKey: 'a1',
    reused: false,
    prime: true,
  })
  assert.ok(decision.prompt.endsWith('LIDOW:'), `prompt 末尾没有预填：${JSON.stringify(decision.prompt.slice(-40))}`)
  assert.ok(
    decision.next && !decision.next.entries.some((entry) => entry.includes('LIDOW:')),
    '预填不许写进链（entries）',
  )
  // 默认（不传 prime）不加 —— 纯函数那几十条字面量断言都建立在这个前提上
  const plain = decideFeed({
    mode: 'chained',
    full: 'HEAD\n\nUser: 你好',
    head: 'HEAD',
    entries: ['User: 你好'],
    sessionId: 's1',
    accountKey: 'a1',
    reused: false,
  })
  assert.ok(!plain.prompt.endsWith('LIDOW:'), '默认不该预填')
})

console.log(failed === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failed} 项 ❌`)
if (failed > 0) process.exitCode = 1
