/**
 * 回归测试：网页端**会话复用**（2026-09-12）
 *
 * 背景：实测一天建了 182 个网页端会话（峰值 74 个/小时、8 个/分钟）—— 因为每个 DSH 回合
 * 都建一个新会话、用完再删一个。真人不会这样建删对话，这是很强的机器特征。
 *
 * 判定实验（真实请求，2026-09-12）证明可以复用：
 *   同一会话内先发「记住编号 ZC-7391-KX，只回 OK」→ 得到 `OK`；
 *   再问「编号是什么」→ 答 `不知道`。
 *   因为每次都发 `parent_message_id: null`，每条消息都是会话里的**根**，服务端不带历史。
 *
 * 本文件用假 transport + 假 fetch 覆盖这些行为（不打真实请求）。
 */
import assert from 'node:assert/strict'

const {
  streamWebCompletion,
  setFetchImpl,
  resetSessionReuse,
  DEFAULT_SESSION_REUSE_TURNS,
} = await import('../src/webapi.ts')

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

const SSE_OK = 'data: {"v":{"response":{"content":"hi"}}}\n\ndata: [DONE]\n\n'
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' }

/** 假 transport：记录建了几个会话。 */
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

/** 跑一次 complete 并收集正文 + 被回收的会话 id。 */
async function runOnce({ auth = authA, transport, fetched, sessionReuseTurns } = {}) {
  const collected = []
  const deleted = []
  const seen = []
  setFetchImpl(async (url) => {
    seen.push(String(url))
    return fetched()
  })
  const gen = streamWebCompletion(
    auth,
    {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      ...(sessionReuseTurns !== undefined ? { sessionReuseTurns } : {}),
      onDeleteSession: (id) => deleted.push(id),
    },
    transport,
  )
  let text = ''
  for await (const ev of gen) if (ev.kind === 'text') text += ev.text
  collected.push(text)
  return { text, deleted, seen }
}

const okFetch = async () => new Response(SSE_OK, { status: 200, headers: SSE_HEADERS })

console.log('会话复用')

await test('默认开启复用：连发 3 次只用 1 个会话，且结束后不删', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  for (let i = 0; i < 3; i += 1) await runOnce({ transport, fetched: okFetch })
  assert.equal(created.length, 1, `应只建 1 个会话，实际建了 ${created.length} 个`)
  assert.equal(DEFAULT_SESSION_REUSE_TURNS, 20, '默认上限 20 轮')
})

await test('复用时不产生删除请求（旧行为是每轮建一个立刻删一个）', async () => {
  resetSessionReuse()
  const { transport } = mkTransport()
  const r = await runOnce({ transport, fetched: okFetch })
  // 自证：必须真的跑通并产出正文，否则"没删"只是因为压根没执行
  assert.equal(r.text, 'hi', '用例必须真的走到流结束（自证）')
  assert.deepEqual(r.deleted, [], `复用模式下不该回收当前会话，实际: ${JSON.stringify(r.deleted)}`)
})

await test('到达轮次上限后轮换：建新会话，并把旧的交出来回收', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const deleted = []
  setFetchImpl(okFetch)
  for (let i = 0; i < 3; i += 1) {
    const gen = streamWebCompletion(
      authA,
      {
        prompt: 'P',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        sessionReuseTurns: 2,
        onDeleteSession: (id) => deleted.push(id),
      },
      transport,
    )
    for await (const _ of gen) void _
  }
  assert.equal(created.length, 2, `上限 2 轮 → 3 次请求应建 2 个会话，实际 ${created.length}`)
  assert.deepEqual(created, ['sess-1', 'sess-2'])
  assert.deepEqual(deleted, ['sess-1'], `轮换掉的旧会话要回收，实际回收 ${JSON.stringify(deleted)}`)
})

await test('关闭复用（0）：回到每请求一个会话，且用完即删', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const deleted = []
  setFetchImpl(okFetch)
  for (let i = 0; i < 3; i += 1) {
    const gen = streamWebCompletion(
      authA,
      {
        prompt: 'P',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        sessionReuseTurns: 0,
        onDeleteSession: (id) => deleted.push(id),
      },
      transport,
    )
    for await (const _ of gen) void _
  }
  assert.equal(created.length, 3, '关闭复用时每次都要新建')
  assert.equal(deleted.length, 3, `关闭复用时每次都要回收，实际 ${deleted.length}`)
})

await test('失败即弃：请求失败后不复用那个坏会话', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  let boom = true
  setFetchImpl(async () => {
    if (boom) {
      boom = false
      return new Response('server busy', { status: 500 })
    }
    return new Response(SSE_OK, { status: 200, headers: SSE_HEADERS })
  })
  const params = (onDelete) => ({
    prompt: 'P',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    onDeleteSession: onDelete,
  })
  // 自证：第一次必须真的失败，否则这条用例没测到东西
  await assert.rejects(async () => {
    for await (const _ of streamWebCompletion(authA, params(() => {}), transport)) void _
  }, /HTTP 500|completion failed/)
  for await (const _ of streamWebCompletion(authA, params(() => {}), transport)) void _
  assert.equal(created.length, 2, `失败后应换新会话，建会话数应为 2，实际 ${created.length}`)
})

await test('会话失效（invalid chat session id）→ 换新会话透明重试并回收坏的', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const deleted = []
  let first = true
  setFetchImpl(async () => {
    if (first) {
      first = false
      return new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'invalid chat session id' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(SSE_OK, { status: 200, headers: SSE_HEADERS })
  })
  let text = ''
  for await (const ev of streamWebCompletion(
    authA,
    {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      onDeleteSession: (id) => deleted.push(id),
    },
    transport,
  )) {
    if (ev.kind === 'text') text += ev.text
  }
  assert.equal(text, 'hi', '重试后必须真的成功（自证）')
  assert.equal(created.length, 2, '失效会话要换新重试')
  assert.deepEqual(deleted, ['sess-1'], '失效的会话要回收')
})

await test('换账号不复用，旧会话交还原账号的回调', async () => {
  // ⚠️ 2026-09-13 第二轮审计 N04 指出**原期望写错了**：
  //    原断言是"不能回收上一个账号的会话"→ `deleted` 必须为空。
  //    但正确设计不是"永不回收"，而是**用原账号的回调回收**——
  //    "不能用 B 的回调去删 A"，不等于"永远不应回收 A"。
  //    原用例两个账号共用同一个回调，所以断言不到"归属"这件事。
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const deleted = []
  setFetchImpl(okFetch)
  for (const [owner, auth] of [
    ['A', authA],
    ['B', authB],
  ]) {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      onDeleteSession: (id) => deleted.push([owner, id]),
    }
    for await (const _ of streamWebCompletion(auth, params, transport)) void _
  }
  assert.equal(created.length, 2, '换账号必须建新会话')
  assert.deepEqual(deleted, [['A', 'sess-1']], '不得用 B 的回调回收 A，也不得静默丢弃旧槽')
})

// 复位，别把注入层留给别的测试
setFetchImpl()

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
