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
} = await import('../src/context-feed.ts')

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
  const base = ENTRIES('User: 原始需求')
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 原始需求', 'Assistant: 半截回答', 'User: 请从中断处继续'),
      chainEntries: base,
      chainPatch: { entries: base, parentId: 77 },
    }),
  )
  assert.equal(d.reason, 'chained')
  assert.equal(d.prompt, 'Assistant: 半截回答\n\nUser: 请从中断处继续')
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

test('固定头变了（系统提示/工具目录）：重新起链，不拿旧 head 续', () => {
  const d = decideFeed(chainedInput({ input: { head: HEAD + '（工具变了）' } }))
  assert.equal(d.reason, 'head-changed')
  assert.equal(d.parentMessageId, null)
  assert.deepEqual(d.next?.entries, ENTRIES('User: 一', 'Assistant: 答一', '[Tool Result for c1]\n结果'))
})

test('历史不是严格追加（前一条被改写）：重新起链', () => {
  // 典型的"压缩/回退"：旧条目在新数组里变成了别的内容
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'Assistant: 答一（被压缩重写过）', '[Tool Result for c1]\n结果'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一'),
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.parentMessageId, null)
})

test('历史变短（回退）：也算非追加 → 重新起链', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一'),
      chainEntries: ENTRIES('User: 一', 'Assistant: 答一', 'User: 二'),
    }),
  )
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.parentMessageId, null)
})

test('条目数没变（同一步重试）：重新起链', () => {
  const same = ENTRIES('User: 一', 'Assistant: 答一')
  const d = decideFeed(chainedInput({ entries: same, chainEntries: same }))
  assert.equal(d.reason, 'not-appended')
  assert.equal(d.parentMessageId, null)
})

test('追加了条目但内容全空白：当作没有新增 → 重新起链', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', '   '),
      chainEntries: ENTRIES('User: 一'),
    }),
  )
  assert.equal(d.reason, 'empty-delta')
  assert.equal(d.parentMessageId, null)
})

test('增量本身超预算：不值当冒险 → 重新起链', () => {
  const d = decideFeed(
    chainedInput({
      entries: ENTRIES('User: 一', 'X'.repeat(500)),
      chainEntries: ENTRIES('User: 一'),
      input: { maxChars: 100 },
    }),
  )
  assert.equal(d.reason, 'delta-too-long')
  assert.equal(d.parentMessageId, null)
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

test('当前模式默认是 full，applyContextMode 立即改变它', () => {
  resetContextMode()
  assert.equal(DEFAULT_CONTEXT_MODE, 'full')
  assert.equal(currentContextMode(), 'full')
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

console.log(failed === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failed} 项 ❌`)
if (failed > 0) process.exitCode = 1
