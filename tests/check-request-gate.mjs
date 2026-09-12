/**
 * 请求闸门回归测试 —— 串行 / 并发开关 / 最小间隔 / 排队顺序 / 异常与中断不漏名额。
 *
 * 背景（2026-09-12）：从插件日志反推 272 轮调用的起止时间，发现 16 对真重叠，
 * 重叠的一方总是「主回答」，另一方只有 8~17 字、耗时 1~3 秒 —— 那是 DSH 的会话标题生成。
 * 网页端同一账号同时只能生成一条，并发生成会被拒，且实测有账号级限制风险（双窗口 6 分钟被封 1 天）。
 */
import assert from 'node:assert/strict'
import { createRequestGate, DEFAULT_MIN_REQUEST_INTERVAL_MS } from '../src/gate.ts'

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
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

/** 假时钟：now() 读虚拟时间，sleep() 推进虚拟时间并记账 —— 让时序断言完全确定。 */
function fakeClock() {
  const c = { now: 0, sleeps: [] }
  return {
    ...c,
    get now() {
      return c.now
    },
    get sleeps() {
      return c.sleeps
    },
    api: {
      now: () => c.now,
      sleep: async (ms) => {
        c.sleeps.push(ms)
        c.now += ms
      },
    },
    advance: (ms) => {
      c.now += ms
    },
  }
}

console.log('请求闸门：')

await test('默认间隔是 3 秒（README 推荐值，勿随意改动）', () => {
  assert.equal(DEFAULT_MIN_REQUEST_INTERVAL_MS, 3_000)
})

await test('串行（默认）：上一个没释放，下一个拿不到许可', async () => {
  const gate = createRequestGate({ allowConcurrent: false, minIntervalMs: 0 })
  const r1 = await gate.acquire('chat')
  let got2 = false
  const p2 = gate.acquire('session-title').then((rel) => {
    got2 = true
    return rel
  })
  await flush()
  assert.equal(got2, false, '标题请求不该在主回答还在跑时就拿到许可')
  assert.equal(gate.stats().running, 1)
  assert.equal(gate.stats().waiting, 1, '等待中的应当计为 1')

  r1()
  const r2 = await p2
  assert.equal(got2, true, '主回答结束后标题才能开始')
  r2()
  assert.equal(gate.stats().running, 0)
})

await test('allowConcurrent=true：两个调用可以真的同时在跑', async () => {
  const gate = createRequestGate({ allowConcurrent: true, minIntervalMs: 0 })
  const r1 = await gate.acquire('chat')
  const r2 = await gate.acquire('session-title')
  assert.equal(gate.stats().running, 2, '并发模式下应同时在跑')
  r1()
  r2()
  assert.equal(gate.stats().running, 0)
})

await test('最小间隔：首次调用不等待，第二次补足差额', async () => {
  const clock = fakeClock()
  const gate = createRequestGate({ minIntervalMs: 3_000, now: clock.api.now, sleep: clock.api.sleep })

  const r1 = await gate.acquire('chat')
  assert.deepEqual(clock.sleeps, [], '首次调用不该被间隔拖住')
  r1()

  const r2 = await gate.acquire('session-title')
  assert.deepEqual(clock.sleeps, [3_000], '第二次应等满 3000ms')
  r2()
})

await test('间隔从「上一次结束」起算，而不是开始（长回答不会白等）', async () => {
  const clock = fakeClock()
  const gate = createRequestGate({ minIntervalMs: 3_000, now: clock.api.now, sleep: clock.api.sleep })

  const r1 = await gate.acquire('chat')
  clock.advance(40_000) // 这次调用跑了 40 秒
  r1()

  await gate.acquire('after')
  assert.deepEqual(clock.sleeps, [3_000], '应从 40000 起算，仍需等 3000')
})

await test('间隔设 0 = 完全不限速', async () => {
  const clock = fakeClock()
  const gate = createRequestGate({ minIntervalMs: 0, now: clock.api.now, sleep: clock.api.sleep })
  const r1 = await gate.acquire('a')
  r1()
  await gate.acquire('b')
  assert.deepEqual(clock.sleeps, [])
})

await test('排队是 FIFO，后来的不会插队', async () => {
  const gate = createRequestGate({ minIntervalMs: 0 })
  const order = []
  const r1 = await gate.acquire('1')
  const p2 = gate.acquire('2').then((r) => (order.push('2'), r))
  const p3 = gate.acquire('3').then((r) => (order.push('3'), r))
  await flush()
  assert.deepEqual(order, [], '谁都不能越过第 1 个')

  r1()
  const r2 = await p2
  await flush()
  assert.deepEqual(order, ['2'], '第 3 个必须等第 2 个结束')
  r2()
  const r3 = await p3
  r3()
  assert.deepEqual(order, ['2', '3'])
})

await test('重复调用 release 不会重复让位（幂等）', async () => {
  const gate = createRequestGate({ minIntervalMs: 0 })
  const r1 = await gate.acquire('a')
  r1()
  r1()
  r1()
  assert.equal(gate.stats().running, 0, '不能出现负数或多次释放')
  const r2 = await gate.acquire('b') // 不该卡住
  r2()
})

await test('流抛错也要释放名额 —— 否则后续调用全被卡死', async () => {
  const gate = createRequestGate({ minIntervalMs: 0 })
  async function* gated(broken) {
    const release = await gate.acquire('x')
    try {
      yield 1
      if (broken) throw new Error('boom')
    } finally {
      release()
    }
  }

  const it = gated(true)
  await it.next()
  assert.equal(gate.stats().running, 1)
  await assert.rejects(() => it.next(), /boom/)
  assert.equal(gate.stats().running, 0, '抛错后必须归零')

  const r = await gate.acquire('after')
  r()
})

await test('消费者提前中断（return）也要释放', async () => {
  const gate = createRequestGate({ minIntervalMs: 0 })
  async function* gated() {
    const release = await gate.acquire('x')
    try {
      yield 1
      yield 2
    } finally {
      release()
    }
  }

  const it = gated()
  await it.next()
  assert.equal(gate.stats().running, 1)
  await it.return()
  assert.equal(gate.stats().running, 0, '中断后必须归零')
})

await test('只创建 generator 不迭代 → 不占名额（许可在首次 next 才取）', async () => {
  const gate = createRequestGate({ minIntervalMs: 0 })
  async function* gated() {
    const release = await gate.acquire('x')
    try {
      yield 1
    } finally {
      release()
    }
  }

  const it = gated()
  await flush()
  assert.equal(gate.stats().running, 0, '没开始迭代就不该占位')
  assert.equal(gate.stats().waiting, 0)

  await it.next()
  assert.equal(gate.stats().running, 1)
  await it.return()
})

await test('真实并发场景：主回答 + 标题在串行下不再重叠', async () => {
  const gate = createRequestGate({ allowConcurrent: false, minIntervalMs: 1_000 })
  const events = []
  const run = (name, ms) =>
    (async () => {
      const release = await gate.acquire(name)
      events.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      events.push(`${name}:end`)
      release()
    })()

  // 主回答 60ms，回答进行中 DSH 又发起标题请求（旧行为下这会重叠）
  const a = run('chat', 60)
  await new Promise((r) => setTimeout(r, 10))
  const b = run('title', 5)
  await Promise.all([a, b])

  const chatEnd = events.indexOf('chat:end')
  const titleStart = events.indexOf('title:start')
  assert.ok(chatEnd !== -1 && titleStart !== -1)
  assert.ok(titleStart > chatEnd, `标题必须在主回答结束后才开始，实际顺序：${events.join(' → ')}`)
})

await test('反向验证：allowConcurrent=true 时标题确实会与主回答重叠（证明上一项不是假绿灯）', async () => {
  const gate = createRequestGate({ allowConcurrent: true, minIntervalMs: 0 })
  const events = []
  const run = (name, ms) =>
    (async () => {
      const release = await gate.acquire(name)
      events.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      events.push(`${name}:end`)
      release()
    })()

  const a = run('chat', 60)
  await new Promise((r) => setTimeout(r, 10))
  const b = run('title', 5)
  await Promise.all([a, b])

  const chatEnd = events.indexOf('chat:end')
  const titleStart = events.indexOf('title:start')
  assert.ok(
    titleStart < chatEnd,
    `并发模式下必须复现重叠（这就是要规避的旧行为），实际顺序：${events.join(' → ')}`,
  )
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
