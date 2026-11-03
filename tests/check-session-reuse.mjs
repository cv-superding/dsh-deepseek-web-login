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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离：不设的话留痕会写进用户真实的 ~/.dsh/web-login/（见 test-offline.mjs 的说明）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-session-reuse-'))

const { applyContextMode } = await import('../src/context-feed.ts')
const {
  streamWebCompletion,
  setFetchImpl,
  resetSessionReuse,
  disposeSessionReuse,
  DEFAULT_SESSION_REUSE_TURNS,
  MAX_CONVERSATION_SLOTS,
} = await import('../src/webapi.ts')

// 2026-11-03：默认投喂模式改成 chained 后，这里显式钉在 full —— 本文件测的是**会话轮换**，与投喂模式无关。
applyContextMode('full')

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

/**
 * 跑一次 complete 并收集正文 + 被回收的会话 id。
 *
 * ⚠️ 默认按**真实 chat 请求**构造：带 `promptParts`。0.6.26 起"不带 promptParts 的请求"
 * （session-title / 压缩等内部请求）会用**独立的槽**，不再占用对话的会话 —— 见 webapi 的
 * `requestSlotKey`。所以想测"窗口 ↔ 网页端会话"的对应关系，就必须传 parts，
 * 否则所有请求都会被当成内部请求而共用一个槽（那是另一条用例专门测的行为）。
 */
async function runOnce({ auth = authA, transport, fetched, sessionReuseTurns, promptParts, dshSessionId } = {}) {
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
      promptParts: promptParts ?? { head: 'HEAD', entries: ['User: x'] },
      ...(dshSessionId !== undefined ? { dshSessionId } : {}),
      ...(sessionReuseTurns !== undefined ? { sessionReuseTurns } : {}),
      onDeleteSession: (id) => deleted.push(id),
    },
    transport,
  )
  let text = ''
  /** 失败也把 `deleted` 交出来 —— 用例要断言"没把会话交给宿主去删"。 */
  let error
  try {
    for await (const ev of gen) if (ev.kind === 'text') text += ev.text
  } catch (raised) {
    error = raised
  }
  collected.push(text)
  return { text, deleted, seen, error }
}

const okFetch = async () => new Response(SSE_OK, { status: 200, headers: SSE_HEADERS })

/**
 * ⚠️ 模拟**真实 chat 请求**的夹具**必须**带 `promptParts`。
 *
 * 0.6.31 起这条从"注意事项"升级成**硬约束**：不带 `promptParts` 的请求被当作**内部请求**
 * （`session-title` / 压缩），它们的网页端会话是**脚手架** —— 收尾时**直接丢掉、不进用户的
 * 清理策略**（见 webapi 里 `discard` 的长注释）。
 * 于是拿裸 `params` 去测"chat 会话的轮换 / 回收 / 归属"，测到的是**另一条路径**，成批变红。
 * 生产链路本身就是这么分的：adapter 只给 `chatLike`（用户可见的对话）传 `promptParts`。
 */
const CHAT_PARTS = { head: 'HEAD', entries: ['User: x'] }

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
        promptParts: CHAT_PARTS,
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
        promptParts: CHAT_PARTS,
        onDeleteSession: (id) => deleted.push(id),
      },
      transport,
    )
    for await (const _ of gen) void _
  }
  assert.equal(created.length, 3, '关闭复用时每次都要新建')
  assert.equal(deleted.length, 3, `关闭复用时每次都要回收，实际 ${deleted.length}`)
})

// 范围（0.6.29 收窄）：**只有**"服务端可能已经开始生成、会话停在半路"的失败才弃会话。
// 5xx / 网络失败 / 取消 / 空响应属于这一类；认证与限流**不属于**（见下面那条用例）。
await test('服务端 5xx（会话可能停在半路）⇒ 不复用那个会话', async () => {
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
      promptParts: CHAT_PARTS,
      onDeleteSession: (id) => deleted.push([owner, id]),
    }
    for await (const _ of streamWebCompletion(auth, params, transport)) void _
  }
  assert.equal(created.length, 2, '换账号必须建新会话')
  // ⚠️ 0.6.12 改按 DSH 会话分槽之后，这里断言的**意图没变、时机变了**：
  //    A 的槽不再被 B"覆盖"（保留下来，切回 A 还能接着用自己那条会话），
  //    所以此刻谁都不该被删；"归属"这件事要改成**退役时看**——
  //    每个会话必须由**它自己那个账号**的回调回收（不能用 B 的回调删 A）。
  assert.deepEqual(deleted, [], '两个账号各自的槽都还在，此刻不该有人被删')
  disposeSessionReuse()
  const pairs = deleted.map(([owner, id]) => `${owner}:${id}`).sort()
  assert.deepEqual(pairs, ['A:sess-1', 'B:sess-2'].sort(), '每个会话必须由它自己那个账号的回调回收')
})

// ── 0.6.12：按 DSH 会话（窗口）分槽 ────────────────────────────────────────
// 用户要求："每个窗口各用自己那个网页端会话"。宿主在 `GenerateOptions.sessionId` 里给了身份，
// 于是这里守三件事：换窗口建新会话、回到旧窗口**复用回自己那条**、两个窗口互不干扰。
await test('按 DSH 会话分槽：换窗口各用各的会话，切回去复用回自己那条', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  setFetchImpl(okFetch)
  const once = async (dshSessionId) => {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      promptParts: { head: 'HEAD', entries: ['User: x'] },
      dshSessionId,
      onDeleteSession: () => {},
    }
    for await (const _ of streamWebCompletion(authA, params, transport)) void _
  }
  await once('win-A')
  const afterA = created.length
  await once('win-B')
  assert.equal(created.length, afterA + 1, '换窗口必须建自己的会话（不能占用上一个窗口的）')
  await once('win-A')
  assert.equal(created.length, afterA + 1, '切回旧窗口时必须复用回它自己那条会话，不再新建')
  await once('win-B')
  assert.equal(created.length, afterA + 1, '两个窗口各自稳定复用，互不新建')
})

await test('没给 dshSessionId（老宿主）⇒ 退化成共用一个槽，行为与以前一致', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  setFetchImpl(okFetch)
  const once = async () => {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      promptParts: CHAT_PARTS,
    }
    for await (const _ of streamWebCompletion(authA, params, transport)) void _
  }
  await once()
  await once()
  assert.equal(created.length, 1, '没有身份信息时可复用同一个会话（老行为）')
})

// 0.6.18：token 刷新后仍要认出是同一个账号，不能因此退役当前会话、破坏链。
await test('同一账号 token 刷新（有 user.id）⇒ 仍复用原会话，不新建', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  setFetchImpl(okFetch)
  const authOld = { token: 'token-A-old', cookie: 'c=A', user: { id: 'user-123', display: '192***27' } }
  const authNew = { token: 'token-A-new', cookie: 'c=A', user: { id: 'user-123', display: '192***27' } }
  const once = async (auth) => {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      promptParts: { head: 'HEAD', entries: ['User: x'] },
    }
    for await (const _ of streamWebCompletion(auth, params, transport)) void _
  }
  await once(authOld)
  assert.equal(created.length, 1)
  await once(authNew)
  assert.equal(created.length, 1, 'token 刷新后仍应复用同一个网页端会话')
})

await test('没有 user.id 时 token 刷新 ⇒ 按旧行为新建会话（有测试防退化）', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  setFetchImpl(okFetch)
  const authOld = { token: 'token-A-old', cookie: 'c=A' }
  const authNew = { token: 'token-A-new', cookie: 'c=A' }
  const once = async (auth) => {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      promptParts: { head: 'HEAD', entries: ['User: x'] },
    }
    for await (const _ of streamWebCompletion(auth, params, transport)) void _
  }
  await once(authOld)
  assert.equal(created.length, 1)
  await once(authNew)
  assert.equal(created.length, 2, '没有 user.id 时 token 不同只能按旧行为新建')
})

// ── 0.6.23：槽位超限只清内存，不碰网页端会话 ────────────────────────────────
// 用户诉求原话：「换 dsh 会话的时候网页端换新会话，回到原来窗口还要接着之前那个聊」。
// 旧实现在槽位超限时会 `retireSession + cleanup`（= 排队 DELETE）—— 那等于把用户
// 那个窗口的上下文扔了，而且"删会话"本身是最强的机器特征之一。
await test('★ 槽位超限：只淘汰内存槽，绝不删网页端会话', async () => {
  resetSessionReuse()
  const deleted = []
  const { created, transport } = mkTransport()
  setFetchImpl(async () => new Response(SSE_OK, { status: 200, headers: SSE_HEADERS }))
  // 造 maxSlots + 1 个不同窗口，必然触发淘汰
  for (let i = 0; i <= MAX_CONVERSATION_SLOTS; i += 1) {
    const params = {
      prompt: 'P',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      promptParts: { head: 'HEAD', entries: ['User: x'] },
      dshSessionId: `win-${i}`,
      onDeleteSession: (id) => deleted.push(id),
    }
    for await (const _ of streamWebCompletion(authA, params, transport)) void _
  }
  assert.equal(
    created.length,
    MAX_CONVERSATION_SLOTS + 1,
    `每个窗口各建一个会话，实际 ${created.length}`,
  )
  assert.deepEqual(deleted, [], '★ 一个都不许删 —— 淘汰只清内存槽（删了就等于扔掉那个窗口的上下文）')
})

// ── 0.6.26：内部请求不许占用对话的会话槽 ────────────────────────────────────
// 用户现场（2026-10-01 截图）：新开一个窗口、只发一句「在？」，网页端却显示「修改」+ `2 / 2`。
// 时序是：`session-title`（不带 promptParts 的内部请求）先到 → 建会话、发**根消息**
// （那段 `Create a concise title…` 还直接显示在用户对话里）；随后用户的真实消息复用这个会话，
// 又因为没有链而再发一条**根消息** ⇒ 服务端把两条当成同一条用户消息的两个版本。
await test('★ 内部请求（session-title）用自己的会话，不占用对话的槽', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  setFetchImpl(async () => new Response(SSE_OK, { status: 200, headers: SSE_HEADERS }))
  const run = async (params) => {
    for await (const _ of streamWebCompletion(authA, params, transport)) void _
  }
  const base = { prompt: 'P', thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 5_000 }
  const chat = { ...base, promptParts: { head: 'HEAD', entries: ['User: 在'] }, dshSessionId: 'win-1' }
  const title = { ...base, dshSessionId: 'win-1' } // 内部请求：同一个窗口，但不带 parts

  await run(title) // ① 标题请求先到
  assert.equal(created.length, 1, '内部请求自建一个会话')
  await run(chat) // ② 用户的真实消息
  assert.equal(created.length, 2, '★ 对话必须拿自己的会话，不能复用内部请求那个（否则对话里会多一条同层根消息）')
  await run(chat) // ③ 同一窗口继续说
  assert.equal(created.length, 2, '对话自己稳定复用')
})

// ── 0.6.29：账号级失败不许把会话丢掉 ─────────────────────────────────────
// 旧实现对所有 `!resp.ok` 无条件 `retireSession()`（"失败即弃"）。后果（2026-10-02 用户现场）：
// 登录态过期 ⇒ HTTP 401 ⇒ 会话被弃 ⇒ 他重新登录后槽是空的 ⇒ **新建网页端会话 +
// 29 条历史全量重发**，网页端看起来就是"又新建一个窗口"。
// 401 说的是**令牌**、429 说的是**账号**限流 —— 会话本身好好的，而且**换新会话也照样被限**，
// 退役它没有任何好处，唯一的效果是把用户的对话丢掉。
const JSON_ENVELOPE = (bizMsg) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 0, msg: '', data: { biz_code: 1, biz_msg: bizMsg } }),
})

for (const [label, makeResponse] of [
  ['登录态过期（HTTP 401）', () => new Response('invalid token', { status: 401 })],
  ['账号级限流（HTTP 429）', () => new Response('too many requests', { status: 429 })],
  [
    '账号被停用到某时刻（业务码 user is muted）',
    () => new Response(JSON_ENVELOPE('user is muted until 2026-10-03 00:00:00').body, JSON_ENVELOPE('').headers),
  ],
  [
    '发得太频繁（业务码 throttled 文案族）',
    () => new Response(JSON_ENVELOPE('too many requests, please try again later').body, JSON_ENVELOPE('').headers),
  ],
]) {
  await test(`★ ${label} ⇒ 会话必须保住（重新登录/解除后接着原会话聊）`, async () => {
    resetSessionReuse()
    const { transport, created } = mkTransport()
    const parts = (entries) => ({ head: 'HEAD', entries })

    // ① 先正常聊一轮，建立会话
    await runOnce({ transport, fetched: okFetch, dshSessionId: 'win-A', promptParts: parts(['User: 一']) })
    assert.equal(created.length, 1, '第一轮建一个会话')

    // ② 账号级失败
    const failed = await runOnce({
      transport,
      dshSessionId: 'win-A',
      promptParts: parts(['User: 一', 'Assistant: 答一']),
      fetched: async () => makeResponse(),
    })
    assert.ok(failed.error, '自证：这一轮真的失败了（否则这条用例什么都没测到）')
    assert.deepEqual(
      failed.deleted,
      [],
      '账号级失败之后不许把会话交给宿主去删（那等于扔掉用户整段对话）',
    )

    // ③ 恢复后必须**接回原会话**，而不是新建
    await runOnce({
      transport,
      fetched: okFetch,
      dshSessionId: 'win-A',
      promptParts: parts(['User: 一', 'Assistant: 答一', 'User: 二']),
    })
    assert.equal(created.length, 1, `账号级失败后必须接回原会话；实际新建了 ${created.length} 个`)
  })
}

// 另一条路径：**新建的**会话当轮就撞上账号级失败。
// 这时它已经在收尾逻辑的 `owned` 集合里（上面那条用的是复用来的会话，不在集合里 ⇒ 走的是
// 另一处内联跳过）。两处都得守，否则"新窗口第一句话就登录态过期"会白建一个会话。
await test('★ 新窗口第一轮就登录态过期 ⇒ 这个会话也不许被回收（重登后直接接着用）', async () => {
  resetSessionReuse()
  const { transport, created } = mkTransport()
  const failed = await runOnce({
    transport,
    dshSessionId: 'win-fresh',
    promptParts: { head: 'HEAD', entries: ['User: 一'] },
    fetched: async () => new Response('invalid token', { status: 401 }),
  })
  assert.ok(failed.error, '自证：这一轮真的失败了')
  assert.equal(created.length, 1, '自证：这一轮真的建了一个会话')
  assert.deepEqual(failed.deleted, [], '新建的会话撞上 401 也不许被回收')

  // 重登后：必须直接接着用那个会话，不再新建
  await runOnce({
    transport,
    fetched: okFetch,
    dshSessionId: 'win-fresh',
    promptParts: { head: 'HEAD', entries: ['User: 一'] },
  })
  assert.equal(created.length, 1, `重登后必须接回那个会话；实际总共建了 ${created.length} 个`)
})

// 复位，别把注入层留给别的测试
setFetchImpl()

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
