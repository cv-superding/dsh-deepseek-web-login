/**
 * 回归：链式投喂的**接线与生命周期**（0.1.62）。
 *
 * context-feed.ts 的判据是纯函数、已经单测过；这里用假 transport + 假 fetch
 * 验证真正容易错的那一层：
 *  - 请求体里的 `prompt` / `parent_message_id` 是不是真的来自决策；
 *  - 上一轮的 assistant message_id（来自首帧 ready）有没有真的被用作下一轮的 parent；
 *  - 会话轮换 / 切号 / 流失败 / 历史被改写 之后，链有没有**乖乖作废**（退回全量）。
 *
 * 不打真实请求。
 *
 * 用法: node tests/check-context-chain.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-context-chain-'))
process.env.DSH_HOME = HOME

const {
  streamWebCompletion,
  setFetchImpl,
  resetSessionReuse,
  resetContextChain,
  contextChainInfo,
} = await import('../src/webapi.ts')
const { applyContextMode } = await import('../src/context-feed.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' }
const HEAD = 'SYSTEM+协议+工具目录'

/** 带 `event: ready` 的真实形态响应（首帧就给出本轮 assistant 的 message_id）。 */
function sseWithId(id, text = 'ok') {
  return (
    `event: ready\ndata: ${JSON.stringify({ request_message_id: id - 1, response_message_id: id, model_type: 'default' })}\n\n` +
    `data: {"v":{"response":{"message_id":${id},"fragments":[{"type":"RESPONSE","content":"${text}"}]}}}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** 没有 ready 帧的响应（拿不到 message_id ⇒ 链必须作废）。 */
const SSE_NO_ID = 'data: {"v":{"response":{"content":"hi"}}}\n\ndata: [DONE]\n\n'

function mkTransport() {
  const created = []
  return {
    created,
    transport: {
      createSession: async () => {
        const id = `sess-${created.length + 1}`
        created.push(id)
        return id
      },
      powHeader: async () => 'pow',
    },
  }
}

const authA = { token: 'token-A', cookie: 'c=A' }
const authB = { token: 'token-B', cookie: 'c=B' }

/**
 * 跑一轮：把 entries 拼成 prompt（和 adapter 一样：head + --- + 条目），
 * 同时把结构化 parts 传下去 —— 正是生产调用点的形状。
 */
async function runRound({ auth = authA, transport, entries, sse, sessionReuseTurns } = {}) {
  const bodies = []
  const feeds = []
  setFetchImpl(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(typeof sse === 'function' ? sse(bodies.length) : sse ?? SSE_NO_ID, {
      status: 200,
      headers: SSE_HEADERS,
    })
  })
  const full = `${HEAD}\n\n---\n\n${entries.join('\n\n')}`
  const gen = streamWebCompletion(
    auth,
    {
      prompt: full,
      promptParts: { head: HEAD, entries, maxChars: 1_500_000 },
      // 决策回执（0.1.63）：webapi 只在「决策原因变化」时回调一次
      onContextFeed: (report) => feeds.push(report),
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      ...(sessionReuseTurns !== undefined ? { sessionReuseTurns } : {}),
      onDeleteSession: () => {},
    },
    transport,
  )
  let text = ''
  for await (const ev of gen) if (ev.kind === 'text') text += ev.text
  return { body: bodies[0], bodies, text, full, feeds }
}

const E1 = 'User: 第一问'
const E2 = '[Tool Result for c1]\n结果一'
const E3 = 'User: 第二问'

console.log('链式投喂接线')

await test('默认 full 模式：即使传了 parts，也照旧发全量 + parent=null', async () => {
  resetSessionReuse()
  applyContextMode('full')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.equal(a.body.parent_message_id, null)
  assert.equal(b.body.parent_message_id, null, 'full 模式不许出现父消息')
  assert.equal(b.body.prompt, b.full, 'full 模式必须重发全量')
  assert.equal(contextChainInfo(), undefined, 'full 模式不该记链')
})

await test('chained 模式第一轮：起链（全量 + parent=null）', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  assert.equal(a.body.parent_message_id, null)
  assert.equal(a.body.prompt, a.full)
  assert.equal(a.text, 'ok', '自证：这一轮必须真的跑完，否则链不会建立')
  const chain = contextChainInfo()
  assert.ok(chain, '跑完之后应该记下一条链')
  assert.equal(chain.parentId, 2, 'parent 必须是本轮 assistant 的 message_id')
  assert.equal(chain.turns, 1)
})

await test('chained 模式第二轮：只发增量，parent 指上一轮的 message_id', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.equal(b.body.parent_message_id, 2)
  assert.equal(b.body.prompt, E2, '只发新增的那一条')
  assert.ok(!b.body.prompt.includes(HEAD), '增量里不该再出现固定头')
  assert.equal(contextChainInfo()?.parentId, 3, '链要推进到本轮的 message_id')
})

await test('chained 模式连续三轮：每轮 parent 都是上一轮的 message_id', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(11) })
  await runRound({ transport, entries: [E1, E2], sse: sseWithId(12) })
  const c = await runRound({ transport, entries: [E1, E2, E3], sse: sseWithId(13) })
  assert.equal(c.body.parent_message_id, 12)
  assert.equal(c.body.prompt, E3)
})

await test('历史被改写（非严格追加）⇒ 退回全量并重新起链', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  const rewritten = await runRound({ transport, entries: ['User: 第一问（被压缩改写过）', E2], sse: sseWithId(4) })
  assert.equal(rewritten.body.parent_message_id, null, '不确定就必须退回根消息')
  assert.equal(rewritten.body.prompt, rewritten.full)
  assert.equal(contextChainInfo()?.parentId, 4, '退回之后要以这一轮为新链首')
})

await test('拿不到 ready（没有 message_id）⇒ 链作废，下一轮退回全量', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  const bad = await runRound({ transport, entries: [E1], sse: SSE_NO_ID })
  assert.equal(bad.text, 'hi', '自证：这一轮确实跑完了，只是没有 id')
  assert.equal(contextChainInfo(), undefined, '没有 id 就不能留链 —— 否则下一轮会续到不存在的父消息上')
  const next = await runRound({ transport, entries: [E1, E2], sse: sseWithId(9) })
  assert.equal(next.body.parent_message_id, null)
  assert.equal(next.body.prompt, next.full, '丢链之后必须重发全量（上下文不能缺）')
})

await test('会话轮换（用完即删模式）⇒ 不复用旧链', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  assert.equal(a.body.parent_message_id, null)
  // sessionReuseTurns=0 ⇒ 每轮一个新会话；新会话上不能拿旧链的 parent
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3), sessionReuseTurns: 0 })
  assert.equal(b.body.parent_message_id, null)
  assert.equal(b.body.prompt, b.full)
})

await test('切号 ⇒ 不复用旧链', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ auth: authA, transport, entries: [E1], sse: sseWithId(2) })
  const other = await runRound({ auth: authB, transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.equal(other.body.parent_message_id, null, '切号后必须重新起链')
  assert.equal(other.body.prompt, other.full)
})

await test('从 chained 切回 full ⇒ 立刻回到全量，且不记链', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  applyContextMode('full')
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.equal(b.body.parent_message_id, null)
  assert.equal(b.body.prompt, b.full)
  assert.equal(contextChainInfo(), undefined)
})

await test('固定头变了（工具目录/系统提示变化）⇒ 重新起链', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  // 第二轮把 head 换掉：prompt 仍是"全量"，但 parts.head 不同
  const bodies = []
  setFetchImpl(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(sseWithId(6), { status: 200, headers: SSE_HEADERS })
  })
  const gen = streamWebCompletion(
    authA,
    {
      prompt: 'NEW-HEAD\n\n---\n\n' + E2,
      promptParts: { head: 'NEW-HEAD', entries: [E1, E2], maxChars: 1_500_000 },
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      onDeleteSession: () => {},
    },
    transport,
  )
  for await (const _ of gen) {
    /* 只关心请求体 */
  }
  assert.equal(bodies[0].parent_message_id, null)
  assert.equal(bodies[0].prompt, 'NEW-HEAD\n\n---\n\n' + E2, '头部变了就不能只发增量')
})

// ── 决策回执（0.1.63）：没有它，链式投喂在日志里完全不可见 ──────────────────

await test('决策回执：第一轮报 new-session，第二轮报 chained 且长度为增量', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  // resetSessionReuse 之后第一轮必然是新会话 ⇒ 老实报 new-session（不是 no-chain）
  assert.deepEqual(a.feeds.map((f) => f.reason), ['new-session'])
  assert.equal(a.feeds[0].chained, false)
  assert.equal(a.feeds[0].promptChars, a.full.length, '退回全量时上报的是全量长度')

  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.deepEqual(b.feeds.map((f) => f.reason), ['chained'])
  assert.equal(b.feeds[0].chained, true)
  assert.equal(b.feeds[0].promptChars, E2.length, '发增量时上报的是增量长度')
})

await test('决策回执：原因连续不变时不再回调（避免把日志刷满）', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  const second = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.equal(second.feeds.length, 1, '自证：原因从 no-chain 变 chained，这一轮必须上报')
  const third = await runRound({ transport, entries: [E1, E2, E3], sse: sseWithId(4) })
  assert.deepEqual(third.feeds, [], '第三轮原因仍是 chained → 不该再回调')
  const fourth = await runRound({ transport, entries: [E1, E2, E3, 'User: 第四问'], sse: sseWithId(5) })
  assert.deepEqual(fourth.feeds, [])
})

await test('决策回执：历史被改写 → 报 not-appended 且 chained=false', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  const rewritten = await runRound({ transport, entries: ['User: 第一问（被改写）', E2], sse: sseWithId(4) })
  assert.deepEqual(rewritten.feeds.map((f) => f.reason), ['not-appended'])
  assert.equal(rewritten.feeds[0].chained, false)
})

await test('决策回执：全量模式下报 mode-full（一条就够）', async () => {
  resetSessionReuse()
  applyContextMode('full')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  assert.deepEqual(a.feeds.map((f) => f.reason), ['mode-full'])
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.deepEqual(b.feeds, [], '全量模式下不该反复上报')
})

await test('resetContextChain 一并清掉「上次上报过的原因」（复盘/调试才看得到）', async () => {
  resetSessionReuse()
  applyContextMode('full')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  assert.deepEqual(a.feeds.map((f) => f.reason), ['mode-full'])
  const b = await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  assert.deepEqual(b.feeds, [], '自证：同原因连续调用确实不上报')
  resetContextChain()
  const c = await runRound({ transport, entries: [E1, E2, E3], sse: sseWithId(4) })
  assert.deepEqual(c.feeds.map((f) => f.reason), ['mode-full'], 'reset 之后必须能重新看到决策原因')
})

// 收尾：把全局模式还原成默认，避免影响同进程里的其它用例/后续跑批
applyContextMode('full')
resetSessionReuse()

console.log(
  failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`,
)
for (const f of failures) console.log(`   - ${f}`)
if (failures.length > 0) process.exitCode = 1
