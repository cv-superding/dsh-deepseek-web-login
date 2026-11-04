// 末尾预填是发送时的装饰：本文件断言的 prompt 字面量都建立在没有预填上 ⇒ 显式关掉
// （预填本身由 check-context-feed 的 prime=true 用例守）。
process.env.DSH_WEB_LOGIN_PROTOCOL_PRIME = 'off'

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
async function runRound({ auth = authA, transport, entries, sse, sessionReuseTurns, breakAfter, omitParts } = {}) {
  const bodies = []
  const feeds = []
  const deleted = []
  setFetchImpl(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(typeof sse === 'function' ? sse(bodies.length) : sse ?? SSE_NO_ID, {
      status: 200,
      headers: SSE_HEADERS,
    })
  })
  const full = `${HEAD}\n\n---\n\n${entries.join('\n\n')}`
  const params = {
    prompt: full,
    // 决策回执（0.1.63）：webapi 只在「决策原因变化」时回调一次
    onContextFeed: (report) => feeds.push(report),
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    ...(sessionReuseTurns !== undefined ? { sessionReuseTurns } : {}),
    onDeleteSession: (id) => deleted.push(id),
  }
  if (!omitParts) params.promptParts = { head: HEAD, entries, maxChars: 1_500_000 }
  const gen = streamWebCompletion(auth, params, transport)
  let text = ''
  // `breakAfter` 模拟**消费方提前停止迭代**：DSH 读完终止事件（finish）就不再取值 ——
  // 这正是 0.6.16 修的 bug 的触发条件（`item.done` 永远取不到 ⇒ complete 恒 false）。
  for await (const ev of gen) {
    if (ev.kind === 'text') text += ev.text
    if (breakAfter === 'finish' && ev.kind === 'finish') break
    if (breakAfter === 'text' && ev.kind === 'text') break
  }
  return { body: bodies[0], bodies, text, full, feeds, deleted }
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

await test('★ 历史被改写（链尾变了）⇒ 只发从分歧点起的条目，仍挂链尾', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  const rewritten = await runRound({ transport, entries: ['User: 第一问（被压缩改写过）', E2], sse: sseWithId(4) })
  // ★ 0.6.23：不再退回根消息 —— 发 parent=null 会在网页端渲染成同层的另一条消息
  // （「修改 / 重新生成」+ `n / n`），用户明确要求"一个窗口一条对话线"。
  assert.equal(rewritten.body.parent_message_id, 2, '有链就挂链尾：根消息会让网页端分叉')
  // ★ 0.6.33：链还在 ⇒ 那条会话里固定头和历史都还在，只发服务端没见过的条目。
  //   0.6.32 之前这里发的是 `full`（整份固定头 + 整份历史），而历史里全是 `Assistant:` 条目
  //   ⇒ 模型被喂了自己刚说的话（用户 2026-10-02 的原话："相当于我发给网页版已知的答案"）。
  assert.equal(
    rewritten.body.prompt,
    'User: 第一问（被压缩改写过）\n\n[Tool Result for c1]\n结果一',
    '只发从分歧点（下标 0）起的条目',
  )
  assert.notEqual(rewritten.body.prompt, rewritten.full, '自证：没有退回整份')
  assert.ok(
    !rewritten.body.prompt.includes('SYSTEM+协议+工具目录'),
    '★ 固定头不许再发一遍（它在会话首条消息里给过了）',
  )
  assert.equal(contextChainInfo()?.parentId, 4, '这一轮的 id 成为下一轮的父消息')
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

await test('固定头变了（工具目录/系统提示变化）⇒ 重发全量，但仍挂链尾', async () => {
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
  // ★ 0.6.23：parent 不再是 null —— 头部变了要重发全量，但**不换会话、不发根消息**
  // （根消息会在网页端渲染成同层的另一条消息：用户看到的"分叉"）。
  assert.equal(bodies[0].parent_message_id, 2, '有链就挂链尾')
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

// ── 2026-10-01 用户现场：链式模式下一个窗口聊三句 ⇒ 网页端多出三个新会话（旧会话还被删）──
// 根因：收尾时"放过这个会话"的条件里有 `complete`，而 `complete` 只在「底层流的迭代器自然结束」
// 时才置真 —— 消费方（DSH）读到终止事件就停止取值，`item.done` 永远取不到 ⇒ 每一轮都被判成
// "没跑完" ⇒ 会话被退役+删除、链也记不上 ⇒ 下一轮只能新建会话。
// 修法：把服务端的**显式终态**（`kind:'finish'`）也算作"这一轮成了"。下面两条一正一反守着它。
await test('★ 消费方读完终止事件就停 ⇒ 会话必须保留、链必须记上（0.6.16 修的现场 bug）', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport, created } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2), breakAfter: 'finish' })
  assert.equal(a.text, 'ok', '自证：这一轮真的产出了正文')
  assert.deepEqual(created, ['sess-1'], '应该只建了一个会话')
  assert.deepEqual(a.deleted, [], `读完终止事件就停，不该回收会话（否则每轮都会新建一个）：${a.deleted}`)
  const chain = contextChainInfo()
  assert.ok(chain, '这一轮成功了 ⇒ 链必须记上（否则下一轮只能全量重发）')
  assert.equal(chain.parentId, 2)
})

await test('★ 消费方在终止事件之前就停 ⇒ 会话仍要退役（N04 的意图不能被削弱）', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  const a = await runRound({ transport, entries: [E1], sse: sseWithId(2), breakAfter: 'text' })
  assert.deepEqual(a.deleted, ['sess-1'], '没等到终态就断了 ⇒ 这个会话可能停在半路，必须退役')
  assert.equal(contextChainInfo(), undefined, '没跑完不该记链')
})

// 0.6.18：内部请求（如 session-title）不能抢 chat 的链，否则每个标题/压缩请求都会
// 因「历史不是严格追加」而重开链 + 强制换新会话，把当前窗口的网页端会话冲掉。
await test('★ 内部非 chat 请求用自己的会话：既不碰 chat 的链，也不占用对话的槽', async () => {
  resetSessionReuse()
  applyContextMode('chained')
  const { transport, created } = mkTransport()
  // 第一轮：正常的 chat，建立链
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  assert.equal(created.length, 1, 'chat 第一轮只建一个会话')
  assert.equal(contextChainInfo()?.parentId, 2, '链已建立')
  // 第二轮：模拟 session-title / compaction 等内部调用 —— 不传 promptParts
  const title = await runRound({ transport, entries: [E1], sse: sseWithId(3), omitParts: true })
  assert.equal(title.body.parent_message_id, null, '内部请求走全量，不发 parent')
  // ★ 0.6.26：内部请求拿**自己的**会话。让它复用对话的会话会造成：
  // 「内部请求先发一条根消息 → 对话复用该会话、因无链又发一条根消息」⇒ 网页端「修改」+ `2 / 2`。
  assert.equal(created.length, 2, '★ 内部请求必须有自己的会话（不许占用对话的槽）')
  assert.equal(contextChainInfo()?.parentId, 2, 'chat 的链不能被内部请求覆盖')
  // 第三轮：回到 chat，必须还能续上原来的链
  const chat2 = await runRound({ transport, entries: [E1, E2], sse: sseWithId(4) })
  assert.equal(chat2.body.parent_message_id, 2, 'chat 应续上被内部请求保护下来的链')
  assert.equal(chat2.body.prompt, E2, '只发 chat 新增的那一条')
  assert.equal(created.length, 2, 'chat 稳定复用自己那个；加上内部请求的，共两个')
})

// ── 0.6.25：投喂决策留痕（真机排查的唯一抓手）───────────────────────────────
// 判据只在"原因变化时"打宿主日志，而**宿主日志不落盘** ⇒ 真机上查不到"这一轮为什么没走增量"，
// 2026-10-01 两次排查都只能往产物里插桩。这条守住留痕真的会写、且写到点子上。
await test('★ 每轮决策落盘 feed-decisions.jsonl，并给出"链尾是否还在原位"', async () => {
  const { feedDecisionLogPath } = await import('../src/webapi.ts')
  const { readFileSync, existsSync, rmSync } = await import('node:fs')
  const file = feedDecisionLogPath()
  if (existsSync(file)) rmSync(file)

  resetSessionReuse()
  applyContextMode('chained')
  const { transport } = mkTransport()
  await runRound({ transport, entries: [E1], sse: sseWithId(2) })
  await runRound({ transport, entries: [E1, E2], sse: sseWithId(3) })
  await runRound({ transport, entries: ['User: 第一问（被改写）', E2], sse: sseWithId(4) })

  assert.ok(existsSync(file), '留痕文件必须被创建')
  const notes = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(notes.length, 3, `三轮应写三条，实际 ${notes.length}`)

  // 第一轮：还没有链 ⇒ 当链首
  assert.equal(notes[0].reason, 'new-session')
  assert.equal(notes[0].chainLen, null)
  assert.equal(notes[0].reused, false)

  // 第二轮：严格追加 ⇒ 走增量，且链尾仍在原位
  assert.equal(notes[1].reason, 'chained', `实际 ${notes[1].reason}`)
  assert.equal(notes[1].reused, true)
  assert.equal(notes[1].tailSame, true, 'chain 是 entries 的前缀时 tailSame 必须为 true')

  // 第三轮：历史被改写 ⇒ 不续链，tailSame=false —— 这是"为什么没续链"的直接答案
  assert.equal(notes[2].reason, 'not-appended')
  assert.equal(notes[2].tailSame, false, '链尾被改写时必须报 false，否则这条留痕没用')
  // ★ 0.6.33：`tailSame=false` 只说"变了"，不说"从哪儿变" —— firstDiff 才回答得了"是哪一条"。
  //   这一轮把链的第 0 条（`User: 第一问` → `User: 第一问（被改写）`）改了 ⇒ 分歧点在 0。
  assert.equal(notes[2].firstDiff, 0, `本轮应从下标 0 开始不同，实际 ${notes[2].firstDiff}`)
  // 体量：`promptChars` 必须小于整份 `full`（只发分歧点之后的条目）—— 这就是"5 个字发出去 4 万字符"的解药
  assert.ok(
    typeof notes[2].promptChars === 'number' && notes[2].promptChars > 0,
    '体量必须落盘（2026-10-02 之前没有它，只能靠读分享页去估）',
  )
  assert.ok(
    typeof notes[2].headChars === 'number' && notes[2].headChars > 0,
    '固定头大小也要落盘，否则"重发一大段"里的"一大段"有多大只能猜',
  )
  assert.ok(
    !notes[2].promptChars || notes[2].promptChars < notes[2].headChars + 1000,
    `这一轮只该发分歧点之后的条目（${notes[2].promptChars} 字符），不该把固定头（${notes[2].headChars}）再发一遍`,
  )
  // ★ 0.6.36：光有字符数回答不了"提示词里**有没有**模型的旧回答" —— 那正是用户反复问的那件事。
  //   结构计数把它变成可查的事实：`assistant > 0` 才是"把模型说过的话又发了一遍"。
  const stats = notes[2].stats
  assert.ok(stats && typeof stats === 'object', '每轮都要落结构计数')
  for (const key of ['assistant', 'user', 'toolResult', 'systemBlocks']) {
    assert.equal(typeof stats[key], 'number', `stats.${key} 必须是数字`)
  }
  assert.equal(
    stats.assistant,
    0,
    `这一轮是"只发分歧点之后的条目"，里面**不许**有 Assistant 条目（实际 ${stats.assistant}）`,
  )
  assert.ok(stats.user >= 1, '正向对照：至少要有用户那一条 —— 否则这个断言在"发了空串"时也会绿')
  assert.ok(
    notes[1].stats.assistant >= 0 && typeof notes[1].stats.user === 'number',
    '每一轮都要有结构计数（不是只给某一轮）',
  )
})

// 收尾：把全局模式还原成默认，避免影响同进程里的其它用例/后续跑批
applyContextMode('full')
resetSessionReuse()

console.log(
  failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`,
)
for (const f of failures) console.log(`   - ${f}`)
if (failures.length > 0) process.exitCode = 1
