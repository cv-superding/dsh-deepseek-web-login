/**
 * 临时会话清理策略回归 —— immediate / deferred / keep、攒批、批量删与回退。
 *
 * 背景：一次模型调用要发 4 个请求（建会话 → PoW → completion → 删会话）。
 * 「每轮新建一个临时会话、用完立刻删掉」是最强的机器行为特征之一（真人不会这样）。
 * 这里验证的是删除侧的三档策略与「优先一次批量删」的实现是否正确、失败是否安全回退。
 */
import assert from 'node:assert/strict'
import { createSessionCleaner, DEFAULT_SESSION_CLEANUP } from '../src/webapi.ts'

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
const tick = () => new Promise((r) => setTimeout(r, 0))

const AUTH = { token: 'tok', cookie: 'c=1', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua' }

/** 假 fetch：记录每次调用，按计划返回。 */
function fakeFetch(plan) {
  const calls = []
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url, body })
    const r = (plan ? plan(body, calls.length) : {}) ?? {}
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.text ?? JSON.stringify({ code: 0, msg: '', data: {} }),
    }
  }
  impl.calls = calls
  return impl
}

/** 假定时器：拿到回调后可手动触发（避免真等 90 秒）。 */
function fakeTimers() {
  const pending = []
  return {
    set: (fn, ms) => {
      const t = { fn, ms }
      pending.push(t)
      return t
    },
    clear: (t) => {
      const i = pending.indexOf(t)
      if (i >= 0) pending.splice(i, 1)
    },
    runAll: async () => {
      for (const t of pending.splice(0)) await t.fn()
    },
    pending: () => pending,
  }
}

/** 让 flush 的异步链跑完（逐个删是串行的，runAll 之后还要再让出一次事件循环）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

console.log('会话清理策略：')

await test('默认策略是 deferred（攒批延迟），不是每轮立即删', () => {
  assert.equal(DEFAULT_SESSION_CLEANUP.mode, 'deferred')
  assert.ok(DEFAULT_SESSION_CLEANUP.delayMs >= 30_000, '延迟应明显长于一次调用（否则等于没攒批）')
  assert.ok(DEFAULT_SESSION_CLEANUP.batchSize > 1, '批量阈值应大于 1')
})

await test('immediate：入队时不发请求，延迟到点后单删（老行为）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'immediate', delayMs: 1_500, batchSize: 1 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  assert.equal(f.calls.length, 0, '入队时不该立刻发请求（旧实现是延迟 1.5s）')
  assert.equal(cleaner.pendingCount(), 1)

  await t.runAll()
  await tick()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].body, { chat_session_id: 'S1' })
})

await test('deferred：没攒够阈值就不清理', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 3 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  await tick()
  assert.equal(f.calls.length, 0, '只攒了 2 个（阈值 3）不该清理')
  assert.equal(cleaner.pendingCount(), 2)
})

await test('deferred：一次批量删只花 1 个请求（攒批的核心收益）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 3 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  cleaner.schedule(AUTH, 'S3') // 达到阈值 → 触发清理
  await tick()
  await tick()

  assert.equal(f.calls.length, 1, `3 个会话应只花 1 个请求，实际 ${f.calls.length}`)
  assert.deepEqual(f.calls[0].body, { chat_session_ids: ['S1', 'S2', 'S3'] })
  assert.equal(cleaner.pendingCount(), 0)
})

await test('deferred：等满延迟也会清理（哪怕没攒够）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 8 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  assert.equal(t.pending().length, 1, '应排了一个定时器')
  await t.runAll()
  await tick()
  assert.equal(f.calls.length, 1, '只有 1 个 → 走单删')
  assert.deepEqual(f.calls[0].body, { chat_session_id: 'S1' })
})

await test('批量删遇到 5xx（瞬时）→ **不**永久关闭批量，下一批仍先试批量', async () => {
  // 0.1.82：旧实现把 5xx/429/网关 HTML 都算成"服务端不支持批量" ⇒ 一次抖动之后
  // 此后每批都退化成 N 个请求（等于自己把请求密度抬上去，而密度正是被风控看的那个量）。
  const f = fakeFetch((body, nth) => {
    if (body.chat_session_ids) {
      return nth === 1 ? { ok: false, status: 503, text: 'upstream down' } : { ok: true, text: '{"code":0,"data":{}}' }
    }
    return { ok: true, text: '{"code":0,"data":{}}' }
  })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 2 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  await tick()
  await tick()
  assert.ok(f.calls[0].body.chat_session_ids, '自证：第一批先试了批量')

  const before = f.calls.length
  cleaner.schedule(AUTH, 'S3')
  cleaner.schedule(AUTH, 'S4')
  await tick()
  await tick()
  assert.ok(
    f.calls[before]?.body?.chat_session_ids,
    `5xx 是瞬时问题 ⇒ 下一批仍应先试批量（旧实现会永久退化成逐个删，实际：${JSON.stringify(f.calls[before]?.body)}）`,
  )
  assert.equal(f.calls.length, before + 1, '第二批应只花 1 个请求（批量成功）')
})

await test('批量删被服务端拒绝（业务错误）→ 回退逐个删，且此后不再尝试批量', async () => {
  const f = fakeFetch((body) => {
    if (body.chat_session_ids) return { ok: true, text: JSON.stringify({ code: 1, msg: 'unknown field' }) }
    return { ok: true, text: JSON.stringify({ code: 0, data: {} }) }
  })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 2 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  await tick()
  await tick()
  // 1 次批量尝试（失败）+ 2 次单删
  assert.equal(f.calls.length, 3, `应回退逐个删，实际请求数 ${f.calls.length}`)
  assert.ok(f.calls[0].body.chat_session_ids, '第一次应是批量尝试')
  assert.deepEqual(f.calls.slice(1).map((c) => c.body.chat_session_id), ['S1', 'S2'])

  const before = f.calls.length
  cleaner.schedule(AUTH, 'S3')
  cleaner.schedule(AUTH, 'S4')
  await tick()
  await tick()
  assert.equal(f.calls.length - before, 2, '已知不支持批量后，应直接逐个删（不再浪费一次尝试）')
})

await test('网络异常不算「不支持批量」—— 下次仍可尝试', async () => {
  let first = true
  const calls = []
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ body })
    if (body.chat_session_ids && first) {
      first = false
      throw new Error('network down')
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
  }
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 90_000, batchSize: 2 },
    fetchImpl: impl,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  await tick()
  await tick()
  assert.equal(calls.length, 3, '异常后应回退逐个删（1 批量 + 2 单删）')

  const before = calls.length
  cleaner.schedule(AUTH, 'S3')
  cleaner.schedule(AUTH, 'S4')
  await tick()
  await tick()
  assert.ok(calls.slice(before).some((c) => c.body.chat_session_ids), '网络异常后下次仍应尝试批量')
})

await test('keep：完全不删、不入队', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'keep' },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  await t.runAll()
  await tick()
  assert.equal(f.calls.length, 0, 'keep 模式不该发出任何删除请求')
  assert.equal(cleaner.pendingCount(), 0)
})

await test('单删失败不抛错（清理失败不应影响主流程）', async () => {
  const impl = async () => {
    throw new Error('boom')
  }
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 1_000, batchSize: 8 },
    fetchImpl: impl,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  cleaner.schedule(AUTH, 'S1')
  await t.runAll() // 不应抛出
  assert.equal(cleaner.pendingCount(), 0, '失败也要把队列清空，避免堆积')
})

await test('policy() 如实返回当前策略（设置页要显示）', () => {
  const cleaner = createSessionCleaner({ policy: { mode: 'deferred', delayMs: 30_000, batchSize: 4 } })
  // gapMs 是 0.1.30 新增的字段（相邻两个删除请求之间的间隔）。
    // 这个 cleaner 没传 gapRange → 间隔为 0，即**不加额外间隔**，与旧行为一致。
    assert.deepEqual(cleaner.policy(), { mode: 'deferred', delayMs: 30_000, batchSize: 4, gapMs: 0 })
})

await test('F07：一批里混了不同账号时，不许拿其中一个凭证去批量删', async () => {
  // 批量删除只发一个 Authorization 头。混号时用 A 的凭证删 B 的会话 ——
  // 轻则整批被拒，重则 resp.ok 时被当成全部成功（旧代码 ok 就 return，不逐个校验）。
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 60_000, batchSize: 4, gapMs: 0 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  const authA = { ...AUTH, token: 'A'.repeat(64) }
  const authB = { ...AUTH, token: 'B'.repeat(64) }
  cleaner.schedule(authA, 'S1')
  cleaner.schedule(authB, 'S2')
  await t.runAll()
  await settle()
  // 关键：不能出现"一次请求删多个 id"的批量调用
  const batched = f.calls.filter((c) => Array.isArray(c.body?.chat_session_ids) && c.body.chat_session_ids.length > 1)
  assert.equal(batched.length, 0, `混号却发了批量删除：${JSON.stringify(batched[0]?.body)}`)
  // 应当退化为逐个删（各自用自己的 auth）
  assert.equal(f.calls.length, 2, `应当是 2 次逐个删除，实际 ${f.calls.length} 次`)
})

await test('F07：同一账号的一批仍然走批量（1 个请求删多个）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 60_000, batchSize: 3, gapMs: 0 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  cleaner.schedule(AUTH, 'S3')
  await t.runAll()
  await settle()
  const batched = f.calls.filter((c) => Array.isArray(c.body?.chat_session_ids) && c.body.chat_session_ids.length > 1)
  assert.equal(batched.length, 1, '同账号的一批应当合并成 1 个请求')
  assert.equal(batched[0].body.chat_session_ids.length, 3)
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
