/**
 * 回归：链式投喂的图片**只发服务端还没见过的**（0.1.83）。
 *
 * 背景：用户从网页端发现"同一批图被反复挂到每条新消息下"。查下来是
 * `adapter.ts` 的 `refFileIds: rounds === 0 ? refFileIds : []` —— 那个判据本是给
 * 「自动续写」用的（第 2 轮不重带），而**链式投喂每轮都是新的 streamImpl 调用**
 * ⇒ `rounds` 恒为 0 ⇒ 顺带每轮都把整批图重挂一遍。
 *
 * 真机实测（tests/probe-image-chain.mjs，2026-09-23）证明这一批是纯冗余：
 * 服务端按 parent 链回溯时，**历史消息的附件也在上下文里**（两张不同布局的图、
 * 第二轮都不带 ref_file_ids，仍都答对四个角 4/4）。
 *
 * 本用例守的是**接线**（判据写对但没接上，正是这个项目反复出现的那类事故）：
 *  - new-session / restart / 换号 / 会话退役 ⇒ 必须发**全部**
 *  - chained ⇒ 只发**新增的**；⭐ 而且本轮新贴的图**绝不能丢**
 *  - 每条 chained 断言都先自证 `parent_message_id !== null`
 *    （否则测的其实是 restart —— 那就是"测错场景"的假绿）
 *
 * 不打真实请求（假 transport + 假 fetch）。
 *
 * 用法: node tests/check-image-chain-send.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-image-chain-send-'))
process.env.DSH_HOME = HOME

const { streamWebCompletion, setFetchImpl, resetSessionReuse, retireSession } = await import(
  '../src/webapi.ts'
)
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

/** 带 `event: ready` 的真实形态响应（首帧给出本轮 assistant 的 message_id ⇒ 供下一轮当 parent）。 */
function sseWithId(id) {
  return (
    `event: ready\ndata: ${JSON.stringify({ request_message_id: id - 1, response_message_id: id, model_type: 'default' })}\n\n` +
    `data: {"v":{"response":{"message_id":${id},"fragments":[{"type":"RESPONSE","content":"ok"}]}}}\n\n` +
    'data: [DONE]\n\n'
  )
}

function mkTransport() {
  let n = 0
  return {
    createSession: async () => `sess-${++n}`,
    powHeader: async () => 'pow',
  }
}

const authA = { token: 'token-A', cookie: 'c=A' }
const authB = { token: 'token-B', cookie: 'c=B' }

const E1 = 'User: 第一问'
const E2 = '[Tool Result for c1]\n结果一'
const E3 = 'User: 第二问'

/** 跑一轮，返回**真正发出去的那个请求体**。 */
async function runRound({ auth = authA, transport, head = HEAD, entries, refFileIds, id }) {
  const bodies = []
  setFetchImpl(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(sseWithId(id), { status: 200, headers: SSE_HEADERS })
  })
  const full = `${head}\n\n---\n\n${entries.join('\n\n')}`
  const gen = streamWebCompletion(
    auth,
    {
      prompt: full,
      promptParts: { head, entries, maxChars: 1_500_000 },
      ...(refFileIds ? { refFileIds } : {}),
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      onDeleteSession: () => {},
    },
    transport,
  )
  for await (const _ of gen) {
    /* 只需要请求体 */
  }
  assert.equal(bodies.length, 1, `自证：本轮应当恰好发出 1 个请求，实际 ${bodies.length}`)
  return bodies[0]
}

applyContextMode('chained')
console.log('链式投喂的图片发送（0.1.83）')

await test('首轮（new-session）：图必须**全部**发出去（服务端手里没有）', async () => {
  resetSessionReuse()
  const body = await runRound({
    transport: mkTransport(),
    entries: [E1],
    refFileIds: ['f1', 'f2'],
    id: 2,
  })
  assert.equal(body.parent_message_id, null, '自证：首轮是根消息')
  assert.deepEqual(body.ref_file_ids, ['f1', 'f2'])
})

await test('链式轮 + 同一批图：**一个都不发**（服务端历史里已有，这正是本版要修的）', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1', 'f2'], id: 2 })
  const body = await runRound({ transport: t, entries: [E1, E2], refFileIds: ['f1', 'f2'], id: 4 })
  assert.equal(body.parent_message_id, 2, '自证：这一轮真的走了链式（否则下面测的是 restart）')
  assert.deepEqual(body.ref_file_ids, [], '链式轮不该重带已经在历史里的图')
})

await test('⭐ 链式轮 + 本轮新贴的图：**只发新的那张**（老图省、新图绝不能丢）', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1', 'f2'], id: 2 })
  // 第三轮用户又贴了一张 f3（内容寻址 ⇒ 新 attachmentId）
  const body = await runRound({
    transport: t,
    entries: [E1, E2, E3],
    refFileIds: ['f1', 'f2', 'f3'],
    id: 4,
  })
  assert.equal(body.parent_message_id, 2, '自证：链式')
  assert.deepEqual(body.ref_file_ids, ['f3'], '漏了新图 ＝ 模型看不到用户刚贴的图（功能坏）')
})

await test('链式轮之后再来一张新图：增量式累计（f4 之外不再重复发）', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1'], id: 2 })
  const b2 = await runRound({ transport: t, entries: [E1, E2], refFileIds: ['f1', 'f2'], id: 4 })
  assert.deepEqual(b2.ref_file_ids, ['f2'])
  const b3 = await runRound({ transport: t, entries: [E1, E2, E3], refFileIds: ['f1', 'f2', 'f3'], id: 6 })
  assert.equal(b3.parent_message_id, 4, '自证：链式')
  assert.deepEqual(b3.ref_file_ids, ['f3'])
})

await test('head 变了 ⇒ 退回全量重发 ⇒ 图必须**全部**重发', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1', 'f2'], id: 2 })
  const body = await runRound({
    transport: t,
    head: `${HEAD}（工具目录变了）`,
    entries: [E1, E2],
    refFileIds: ['f1', 'f2'],
    id: 4,
  })
  assert.equal(body.parent_message_id, null, '自证：head 变了 ⇒ 不是链式')
  assert.deepEqual(body.ref_file_ids, ['f1', 'f2'], '全量重发时服务端手里没有历史 ⇒ 必须全发')
})

await test('换账号 ⇒ 新会话 ⇒ 图必须**全部**重发（新账号那份历史不存在）', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1', 'f2'], id: 2 })
  const body = await runRound({
    auth: authB,
    transport: t,
    entries: [E1],
    refFileIds: ['f1', 'f2'],
    id: 4,
  })
  assert.deepEqual(body.ref_file_ids, ['f1', 'f2'])
})

await test('会话被退役 ⇒ 下一轮是新会话 ⇒ 图必须**全部**重发', async () => {
  resetSessionReuse()
  const t = mkTransport()
  await runRound({ transport: t, entries: [E1], refFileIds: ['f1', 'f2'], id: 2 })
  retireSession()
  const body = await runRound({ transport: t, entries: [E1, E2], refFileIds: ['f1', 'f2'], id: 6 })
  assert.deepEqual(body.ref_file_ids, ['f1', 'f2'])
})

await test('full 模式（默认）不受影响：每轮都发全部', async () => {
  resetSessionReuse()
  applyContextMode('full')
  const t = mkTransport()
  const b1 = await runRound({ transport: t, entries: [E1], refFileIds: ['f1'], id: 2 })
  const b2 = await runRound({ transport: t, entries: [E1, E2], refFileIds: ['f1'], id: 4 })
  applyContextMode('chained') // 后面还有用例
  assert.equal(b1.parent_message_id, null)
  assert.equal(b2.parent_message_id, null, 'full 模式恒为根消息')
  assert.deepEqual(b1.ref_file_ids, ['f1'])
  assert.deepEqual(b2.ref_file_ids, ['f1'], 'full 模式不参与"只发新增"的优化')
})

console.log(
  failures.length === 0
    ? `\n通过 ${passed} 项，全部通过 ✅`
    : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌\n${failures.join('\n')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
