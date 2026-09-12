/**
 * 回归：会话清理的三个「区间」（上下限 + 随机取值）与删除间隔。
 *
 * 背景：这三个参数原来是**死值** —— 攒到第 8 个就动手、正好等 90 秒、逐个删除时请求连发。
 * 固定值方差≈0，本身就是机器特征。改成"每次在区间内随机抽"之后，
 * 出错方式全是**静默的行为退化**（不报错，只是又变回固定 / 又连发），所以逐条钉住。
 *
 * 用法: node tests/check-cleanup-ranges.mjs
 */
import assert from 'node:assert/strict'
import { createSessionCleaner } from '../src/webapi.ts'
import {
  CLEANUP_BATCH_BOUNDS,
  CLEANUP_GAP_BOUNDS_MS,
  normalizeCleanupRange,
} from '../src/gate.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
/**
 * 让 flush 的异步链跑完，但**不碰**任何定时器。
 *
 * 阈值类用例必须用它而不是 drain()：drain() 会把"最多等 N 秒"的表也触发掉，
 * 于是"攒够才清理"就变成"等到了就清理" —— 测的完全不是一回事。
 */
const settle = async () => {
  await tick()
  await tick()
}

const AUTH = { token: 'tok', cookie: 'c=1', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua' }

/** 假 fetch：记录每次调用，按 plan 决定"批量删"是否被服务端接受。 */
function fakeFetch({ rejectBatch = false } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url, body })
    if (rejectBatch && body?.chat_session_ids) {
      // 业务错误：模拟"服务端不接受批量删"→ 触发逐个删回退
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 40003, msg: 'batch not supported' }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: '', data: {} }) }
  }
  impl.calls = calls
  return impl
}

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
    /** 一直跑到没有待触发的定时器为止（逐个删除会一个接一个注册 sleep）。 */
    drain: async (max = 200) => {
      let i = 0
      while (pending.length && i < max) {
        await (async () => {
          for (const t of pending.splice(0)) await t.fn()
        })()
        await tick()
        i += 1
      }
    },
    pending: () => pending,
  }
}

/** 按给定序列返回的假随机源（用完了就重复最后一个）。 */
function fakeRandom(sequence) {
  let i = 0
  return () => {
    const value = sequence[Math.min(i, sequence.length - 1)]
    i += 1
    return value
  }
}

// ── normalizeCleanupRange（gate.ts 里的输入规整）────────────────────────
await test('区间：上下限拖反了自动交换（不报错）', () => {
  assert.deepEqual(normalizeCleanupRange({ min: 9, max: 3 }, CLEANUP_BATCH_BOUNDS), { min: 3, max: 9 })
})

await test('区间：超出允许范围被夹住', () => {
  assert.deepEqual(normalizeCleanupRange({ min: -5, max: 999 }, CLEANUP_BATCH_BOUNDS), {
    min: CLEANUP_BATCH_BOUNDS.min,
    max: CLEANUP_BATCH_BOUNDS.max,
  })
})

await test('区间：非数/缺字段/非对象 → undefined（当"没给"，不覆盖已有值）', () => {
  for (const bad of [undefined, null, 3, 'x', {}, { min: 1 }, { min: 'a', max: 2 }]) {
    assert.equal(normalizeCleanupRange(bad, CLEANUP_BATCH_BOUNDS), undefined, `坏值 ${JSON.stringify(bad)}`)
  }
})

await test('区间：小数被取整', () => {
  assert.deepEqual(normalizeCleanupRange({ min: 1.9, max: 4.2 }, CLEANUP_BATCH_BOUNDS), { min: 1, max: 4 })
})

// ── 向后兼容：不传区间 = 老行为 ─────────────────────────────────────────
await test('不传区间：沿用传入的死值，且不加删除间隔（老行为不变）', async () => {
  const f = fakeFetch({ rejectBatch: true })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 30_000, batchSize: 2 },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  const policy = cleaner.policy()
  assert.equal(policy.batchSize, 2)
  assert.equal(policy.delayMs, 30_000)
  assert.equal(policy.gapMs, 0, '没配区间就不该凭空多出间隔')
})

await test('immediate 模式忽略区间：固定 1.5s / 每次一个（老行为）', async () => {
  const cleaner = createSessionCleaner({
    policy: {
      mode: 'immediate',
      delayMs: 1_500,
      batchSize: 1,
      batchRange: { min: 6, max: 10 },
      delayRange: { min: 60_000, max: 120_000 },
      gapRange: { min: 800, max: 2_500 },
    },
    fetchImpl: fakeFetch(),
    setTimeoutImpl: fakeTimers().set,
    clearTimeoutImpl: () => {},
  })
  cleaner.schedule(AUTH, 'S1')
  const policy = cleaner.policy()
  assert.equal(policy.batchSize, 1, 'immediate 不该被区间改掉')
  assert.equal(policy.delayMs, 1_500)
})

// ── 每轮重新抽 ──────────────────────────────────────────────────────────
await test('攒批阈值每轮重抽：两轮用到的阈值不同（随机源可控）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    // 随机序列：第一轮抽 0（→下限 2），第二轮抽 0.99（→上限 4）
    policy: { mode: 'deferred', delayMs: 60_000, batchSize: 2, batchRange: { min: 2, max: 4 } },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
    randomImpl: fakeRandom([0, 0.99, 0, 0.99, 0, 0.99]),
  })

  // ⚠️ 每入队一个都要 await（让 flush 的串行链真的跑完）：
  // 如果连着入队不等，队列会在同一次 flush 里被一起取走 —— 那样"批次=4"会**碰巧成立**，
  // 根本验证不到"阈值被重抽成了 4"。这个坑是反向验证抓出来的（详见 CHANGELOG）。
  const batchSizes = () =>
    f.calls.filter((c) => c.body.chat_session_ids).map((c) => c.body.chat_session_ids.length)

  cleaner.schedule(AUTH, 'A1')
  await settle()
  cleaner.schedule(AUTH, 'A2')
  await settle()
  assert.deepEqual(batchSizes(), [2], '第一轮阈值应为 2（随机源抽到下限）')

  // 第二轮：阈值应被重抽成 4
  for (const id of ['B1', 'B2', 'B3']) {
    cleaner.schedule(AUTH, id)
    await settle()
  }
  assert.deepEqual(batchSizes(), [2], '阈值是 4 时，攒到 3 个不该动手')
  cleaner.schedule(AUTH, 'B4')
  await settle()
  assert.deepEqual(batchSizes(), [2, 4], '第二轮阈值应为 4（抽到上限）—— 说明每轮确实重抽了')
})

await test('上下限相等 = 固定值（想锁死某个值也支持）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 60_000, batchSize: 3, batchRange: { min: 3, max: 3 } },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
    randomImpl: fakeRandom([0.5]),
  })
  cleaner.schedule(AUTH, 'A1')
  await settle()
  cleaner.schedule(AUTH, 'A2')
  await settle()
  assert.equal(f.calls.length, 0, '没到 3 个不该动手')
  cleaner.schedule(AUTH, 'A3')
  await settle()
  assert.equal(f.calls.at(-1).body.chat_session_ids.length, 3)
})

// ── 删除间隔 ────────────────────────────────────────────────────────────
await test('删除间隔：批量删被拒后逐个删，两个请求之间确实会等（不是连发）', async () => {
  const f = fakeFetch({ rejectBatch: true })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: {
      mode: 'deferred',
      delayMs: 60_000,
      batchSize: 3,
      batchRange: { min: 3, max: 3 },
      gapRange: { min: 1_000, max: 2_000 },
    },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
    randomImpl: fakeRandom([0.5]),
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  cleaner.schedule(AUTH, 'S3')
  void cleaner.flush()
  await tick()
  // 到这里应该是：1 次批量尝试（被拒） + 第 1 个单删 = 2 个请求
  assert.equal(f.calls.length, 2, `实际 ${f.calls.length}`)
  const waiting = t.pending()
  assert.ok(waiting.length > 0, '第 2 个单删之前应该注册了一个"等待"定时器')
  const gap = waiting[waiting.length - 1].ms
  assert.ok(gap >= 1_000 && gap <= 2_000, `间隔应落在 [1000,2000]，实际 ${gap}`)

  await t.drain()
  const singles = f.calls.filter((c) => c.body.chat_session_id).map((c) => c.body.chat_session_id)
  assert.deepEqual(singles, ['S1', 'S2', 'S3'], '三个应逐个删完')
})

await test('删除间隔为 0（上下限都是 0）时不等待，直接删（可关）', async () => {
  const f = fakeFetch({ rejectBatch: true })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: {
      mode: 'deferred',
      delayMs: 60_000,
      batchSize: 2,
      batchRange: { min: 2, max: 2 },
      gapRange: { min: 0, max: 0 },
    },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  void cleaner.flush()
  await tick()
  await tick()
  const singles = f.calls.filter((c) => c.body.chat_session_id).length
  assert.equal(singles, 2, '间隔为 0 就该连着删完')
})

// ── 串行化（避免两轮删除交错发出）────────────────────────────────────────
await test('串行化：上一轮没删完时，下一次 flush 不会插进来发请求', async () => {
  const f = fakeFetch({ rejectBatch: true })
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: {
      mode: 'deferred',
      delayMs: 60_000,
      batchSize: 2,
      batchRange: { min: 2, max: 2 },
      gapRange: { min: 5_000, max: 5_000 },
    },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })

  cleaner.schedule(AUTH, 'S1')
  cleaner.schedule(AUTH, 'S2')
  void cleaner.flush() // 第一轮：批量尝试 + S1，然后卡在 5 秒的间隔上
  await tick()
  const afterFirst = f.calls.length
  assert.equal(afterFirst, 2, `实际 ${afterFirst}`)

  // 第二轮：此时第一轮还卡在间隔里 —— 它绝不该现在发请求
  cleaner.schedule(AUTH, 'S3')
  cleaner.schedule(AUTH, 'S4')
  void cleaner.flush()
  await tick()
  await tick()
  assert.equal(f.calls.length, afterFirst, '第二轮必须排队等，不能插进来发请求')

  await t.drain()
  const singles = f.calls.filter((c) => c.body.chat_session_id).map((c) => c.body.chat_session_id)
  assert.deepEqual(singles, ['S1', 'S2', 'S3', 'S4'], '最终按队列顺序删完，两轮不交错')
})

await test('单批超过上限会拆成多次（不一口气删一大批）', async () => {
  const f = fakeFetch()
  const t = fakeTimers()
  const cleaner = createSessionCleaner({
    policy: { mode: 'deferred', delayMs: 60_000, batchSize: 25, batchRange: { min: 25, max: 25 }, gapRange: { min: 0, max: 0 } },
    fetchImpl: f,
    setTimeoutImpl: t.set,
    clearTimeoutImpl: t.clear,
  })
  for (let i = 1; i <= 25; i += 1) cleaner.schedule(AUTH, `S${i}`)
  await t.drain()
  const batches = f.calls.filter((c) => c.body.chat_session_ids).map((c) => c.body.chat_session_ids.length)
  assert.deepEqual(batches, [20, 5], `应拆成 20 + 5，实际 ${JSON.stringify(batches)}`)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
