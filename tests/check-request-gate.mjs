/**
 * 请求闸门回归测试 —— 串行 / 并发开关 / 最小间隔 / 排队顺序 / 异常与中断不漏名额。
 *
 * 背景（2026-09-12）：从插件日志反推 272 轮调用的起止时间，发现 16 对真重叠，
 * 重叠的一方总是「主回答」，另一方只有 8~17 字、耗时 1~3 秒 —— 那是 DSH 的会话标题生成。
 * 网页端同一账号同时只能生成一条，并发生成会被拒，且实测有账号级限制风险（双窗口 6 分钟被封 1 天）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRequestGate,
  readGateSettings,
  writeGateSettings,
  gateSettingsPath,
  clampInterval,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_MAX_REQUEST_INTERVAL_MS,
  DEFAULT_LONG_RUN_THRESHOLD,
  DEFAULT_LONG_RUN_BREAK_MS,
  LONG_RUN_THRESHOLD_BOUNDS,
  MAX_INTERVAL_MS,
  INTERVAL_PRESETS,
} from '../src/gate.ts'
import { homedir } from 'node:os'

/** 把 DSH_HOME 指到临时目录，避免碰用户真实的 gate.json；返回恢复函数。 */
function useTempDshHome() {
  const real = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-test-'))
  process.env.DSH_HOME = dir
  return {
    dir,
    restore: () => {
      if (real === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = real
    },
  }
}

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

await test('默认是随机区间 2~4 秒（切勿改成固定值：方差≈0 就是定时器特征）', () => {
  assert.equal(DEFAULT_MIN_REQUEST_INTERVAL_MS, 2_000)
  assert.equal(DEFAULT_MAX_REQUEST_INTERVAL_MS, 4_000)
  assert.ok(
    DEFAULT_MAX_REQUEST_INTERVAL_MS > DEFAULT_MIN_REQUEST_INTERVAL_MS,
    '默认必须是区间；上下限相等会退化成固定间隔',
  )
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

await test('configure：运行时改设置立即生效，且夹到合法范围', () => {
  const gate = createRequestGate({ minIntervalMs: 3_000, maxIntervalMs: 5_000 })
  assert.equal(gate.settings().allowConcurrent, false)
  assert.equal(gate.settings().minRequestIntervalMs, 3_000)
  assert.equal(gate.settings().maxRequestIntervalMs, 5_000)

  assert.deepEqual(gate.configure({ allowConcurrent: true }), {
    allowConcurrent: true,
    minRequestIntervalMs: 3_000,
    maxRequestIntervalMs: 5_000,
    longRunThreshold: DEFAULT_LONG_RUN_THRESHOLD,
  })
  assert.deepEqual(
    gate.configure({ minRequestIntervalMs: 999_999 }),
    {
      allowConcurrent: true,
      minRequestIntervalMs: MAX_INTERVAL_MS,
      maxRequestIntervalMs: MAX_INTERVAL_MS,
      longRunThreshold: DEFAULT_LONG_RUN_THRESHOLD,
    },
    '下限超上限应被夹住，且上限要跟着抬起来（不能留下负区间）',
  )
  assert.equal(gate.configure({ minRequestIntervalMs: -1 }).minRequestIntervalMs, 0, '负数应归 0')
  // 空 patch 不改任何东西
  assert.deepEqual(gate.configure({}), {
    allowConcurrent: true,
    minRequestIntervalMs: 0,
    maxRequestIntervalMs: MAX_INTERVAL_MS,
    longRunThreshold: DEFAULT_LONG_RUN_THRESHOLD,
  })
})

await test('clampInterval：非法输入回落默认值', () => {
  assert.equal(clampInterval(Number.NaN), DEFAULT_MIN_REQUEST_INTERVAL_MS)
  assert.equal(clampInterval(Number.POSITIVE_INFINITY), DEFAULT_MIN_REQUEST_INTERVAL_MS)
  assert.equal(clampInterval(-100), 0)
  assert.equal(clampInterval(1_500.7), 1_500, '应取整')
  assert.equal(clampInterval(MAX_INTERVAL_MS + 1), MAX_INTERVAL_MS)
})

await test('推荐档位里含默认区间（设置页的「推荐」按钮不会指错）', () => {
  const matched = INTERVAL_PRESETS.some(
    ([lo, hi]) => lo === DEFAULT_MIN_REQUEST_INTERVAL_MS && hi === DEFAULT_MAX_REQUEST_INTERVAL_MS,
  )
  assert.ok(
    matched,
    `档位 ${JSON.stringify(INTERVAL_PRESETS)} 里应含默认区间 ` +
      `${DEFAULT_MIN_REQUEST_INTERVAL_MS}~${DEFAULT_MAX_REQUEST_INTERVAL_MS}`,
  )
})

await test('间隔在区间内随机取值 —— 不同随机源得到不同等待（消除定时器特征）', async () => {
  const got = []
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const clock = fakeClock()
    const gate = createRequestGate({
      minIntervalMs: 2_000,
      maxIntervalMs: 4_000,
      now: clock.api.now,
      sleep: clock.api.sleep,
      random: () => r,
    })
    const r1 = await gate.acquire('a')
    r1()
    const r2 = await gate.acquire('b')
    r2()
    got.push(clock.sleeps[0])
  }
  assert.deepEqual(got, [2_000, 2_500, 3_000, 3_500, 4_000], `实际：${got.join(', ')}`)
  assert.equal(new Set(got).size, got.length, '每次等待都应不同（否则等于固定间隔）')
})

await test('上下限相等 → 退化为固定间隔（随机源不影响结果）', async () => {
  const clock = fakeClock()
  const gate = createRequestGate({
    minIntervalMs: 3_000,
    maxIntervalMs: 3_000,
    now: clock.api.now,
    sleep: clock.api.sleep,
    random: () => 0.99,
  })
  const r1 = await gate.acquire('a')
  r1()
  const r2 = await gate.acquire('b')
  r2()
  assert.deepEqual(clock.sleeps, [3_000])
})

await test('只给下限（0.1.20 的老配置）→ 上限跟随下限，行为不变', () => {
  const gate = createRequestGate({ minIntervalMs: 3_000 })
  assert.equal(gate.settings().minRequestIntervalMs, 3_000)
  assert.equal(gate.settings().maxRequestIntervalMs, 3_000, '老配置是固定间隔语义，升级后不该变成随机区间')
})

await test('上限小于下限 → 自动纠正，不会出现负区间', () => {
  const gate = createRequestGate({ minIntervalMs: 8_000, maxIntervalMs: 2_000 })
  assert.equal(gate.settings().maxRequestIntervalMs, 8_000)
})

await test('设置文件：写入后能读回（路径跟随 DSH_HOME）', () => {
  const tmp = useTempDshHome()
  try {
    assert.equal(readGateSettings(), undefined, '文件不存在时应返回 undefined（回落 config）')
    assert.ok(gateSettingsPath().includes(tmp.dir), `路径应落在临时 DSH_HOME 内：${gateSettingsPath()}`)

    writeGateSettings({ allowConcurrent: true, minRequestIntervalMs: 8_000, maxRequestIntervalMs: 12_000 })
    assert.deepEqual(readGateSettings(), {
      allowConcurrent: true,
      minRequestIntervalMs: 8_000,
      maxRequestIntervalMs: 12_000,
    })

    // 老文件（0.1.20 只存了 min）→ 上限跟随下限（固定间隔语义，升级后行为不变）
    mkdirSync(join(gateSettingsPath(), '..'), { recursive: true })
    writeFileSync(gateSettingsPath(), JSON.stringify({ minRequestIntervalMs: 1_500 }), 'utf8')
    assert.deepEqual(readGateSettings(), { minRequestIntervalMs: 1_500, maxRequestIntervalMs: 1_500 })
  } finally {
    tmp.restore()
  }
})

await test('设置文件损坏 / 字段非法时不炸，回落默认', () => {
  const tmp = useTempDshHome()
  try {
    mkdirSync(join(gateSettingsPath(), '..'), { recursive: true })
    writeFileSync(gateSettingsPath(), '{ 这不是 JSON', 'utf8')
    assert.equal(readGateSettings(), undefined, '损坏文件应返回 undefined')

    writeFileSync(gateSettingsPath(), JSON.stringify({ allowConcurrent: 'yes', minRequestIntervalMs: 'soon' }), 'utf8')
    assert.equal(readGateSettings(), undefined, '类型不对的字段应被忽略')

    writeFileSync(gateSettingsPath(), JSON.stringify({ allowConcurrent: false, minRequestIntervalMs: -5 }), 'utf8')
    const parsed = readGateSettings()
    assert.equal(parsed.minRequestIntervalMs, 0, '负数要夹到 0 而不是原样带回')
  } finally {
    tmp.restore()
  }
})

await test('落盘的值与 configure 结果一致（重启后行为不变）', () => {
  const tmp = useTempDshHome()
  try {
    const gate = createRequestGate({ minIntervalMs: 3_000, maxIntervalMs: 6_000 })
    const applied = gate.configure({ allowConcurrent: true, minRequestIntervalMs: 30_000, maxRequestIntervalMs: 30_000 })
    writeGateSettings(applied)
    // 模拟「重启」：新实例按文件值初始化
    const saved = readGateSettings()
    const reborn = createRequestGate({
      allowConcurrent: saved.allowConcurrent,
      minIntervalMs: saved.minRequestIntervalMs,
      maxIntervalMs: saved.maxRequestIntervalMs,
    })
    assert.deepEqual(reborn.settings(), applied)
  } finally {
    tmp.restore()
  }
})

test('语义：只传 minIntervalMs 时，max 会跟随 min（退化为固定间隔）', () => {
  // 这是 createRequestGate 的既有语义（兼容老配置里只写一个值 = 固定间隔）。
  // ⚠️ 但它意味着**调用方必须成对传**：漏传 max 就会静默得到固定间隔。
  const g = createRequestGate({ minIntervalMs: 2000 })
  assert.equal(g.settings().minRequestIntervalMs, 2000)
  assert.equal(
    g.settings().maxRequestIntervalMs,
    2000,
    '只传 min 时 max 跟随 min —— 不是默认的 4000。宿主启动时漏传 max 就会变成固定间隔',
  )
})

test('回归：设置页保存 2000~4000 后重启，恢复出来必须仍是 2000~4000', () => {
  // 2026-09-12 实测事故：宿主 index.ts 启动时只把 min 传给了 createRequestGate，
  // 于是保存好的 2000~4000 随机区间在每次重启后 silently 变成固定 2000ms ——
  // 固定间隔是最典型的机器特征，而用户从界面上看不出来（日志里只显示"区间 2000~2000"）。
  const saved = { allowConcurrent: false, minRequestIntervalMs: 2000, maxRequestIntervalMs: 4000 }
  const reborn = createRequestGate({
    allowConcurrent: saved.allowConcurrent,
    minIntervalMs: saved.minRequestIntervalMs,
    maxIntervalMs: saved.maxRequestIntervalMs,
  })
  assert.equal(reborn.settings().allowConcurrent, false)
  assert.equal(reborn.settings().minRequestIntervalMs, 2000)
  assert.equal(reborn.settings().maxRequestIntervalMs, 4000)
})

/** 造一个可控时钟的闸门：sleep 只记录不真等。 */
function makeClockGate(overrides = {}) {
  const waits = []
  const logs = []
  let t = 1_000
  const gate = createRequestGate({
    allowConcurrent: false,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    longRunThreshold: 3,
    longRunBreakMs: { min: 60_000, max: 60_000 },
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms)
      t += ms
    },
    logger: { info: (m) => logs.push(m), debug: () => {} },
    ...overrides,
  })
  return {
    gate,
    waits,
    logs,
    tick: (ms) => {
      t += ms
    },
  }
}

async function runBurst(ctx, times, gapMs = 100) {
  for (let i = 0; i < times; i += 1) {
    const release = await ctx.gate.acquire('chat')
    release()
    ctx.tick(gapMs)
  }
}

test('长任务保护：连续跑满阈值后强制长休（间隔管不了"连着不停跑"）', async () => {
  const ctx = makeClockGate()
  await runBurst(ctx, 10)
  const longBreaks = ctx.waits.filter((w) => w > 50_000)
  // 阈值 3、连跑 10 次 → 第 4、7、10 次之前各长休一次
  assert.equal(longBreaks.length, 3, `等待序列 ${JSON.stringify(ctx.waits)}`)
  assert.ok(
    ctx.logs.some((l) => l.includes('长休') && l.includes('长任务保护')),
    '长休应当写日志（否则用户不知道为什么卡住）',
  )
})

test('长任务保护：阈值 0 = 关闭（不引入意外的等待）', async () => {
  const ctx = makeClockGate({ longRunThreshold: 0 })
  await runBurst(ctx, 10)
  assert.equal(ctx.waits.length, 0, `不该有任何等待：${JSON.stringify(ctx.waits)}`)
})

test('长任务保护：中间歇够了 → 连续计数归零（"连续"指的是不停歇）', async () => {
  const ctx = makeClockGate()
  await runBurst(ctx, 3)
  ctx.tick(200_000) // 歇了 200 秒
  await runBurst(ctx, 3)
  assert.equal(ctx.waits.length, 0, `歇过了就不该再长休：${JSON.stringify(ctx.waits)}`)
})

test('长任务保护：长休时长在区间内随机（不是固定值）', async () => {
  const ctx = makeClockGate({ longRunBreakMs: { min: 60_000, max: 180_000 } })
  await runBurst(ctx, 10)
  const breaks = ctx.waits.filter((w) => w > 50_000)
  assert.equal(breaks.length, 3)
  for (const b of breaks) {
    assert.ok(b > 50_000 && b <= 180_000, `长休时长 ${b} 应落在 60~180s 区间`)
  }
})

test('长任务保护：设置可改（configure）并回显在 settings()', () => {
  const gate = createRequestGate({ minIntervalMs: 0, maxIntervalMs: 0 })
  assert.equal(gate.settings().longRunThreshold, DEFAULT_LONG_RUN_THRESHOLD, '默认应开启')
  gate.configure({ longRunThreshold: 8, longRunBreakMs: { min: 30_000, max: 90_000 } })
  assert.equal(gate.settings().longRunThreshold, 8)
  assert.deepEqual(gate.settings().longRunBreakMs, { min: 30_000, max: 90_000 })
  // 越界要被夹住，不是报错
  gate.configure({ longRunThreshold: 9999 })
  assert.equal(gate.settings().longRunThreshold, 100, '阈值上限 100')
  gate.configure({ longRunThreshold: -5 })
  assert.equal(gate.settings().longRunThreshold, 0, '负数夹到 0（= 关闭）')
})

await test('F11 闸门可取消：已取消的 signal 立刻抛 AbortError', async () => {
  const gate = createRequestGate({
    allowConcurrent: false,
    minIntervalMs: 5_000,
    maxIntervalMs: 5_000,
    longRunThreshold: 0,
    now: () => 0,
    sleep: async () => {},
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => gate.acquire('chat', controller.signal), (error) => error.name === 'AbortError')
})

await test('F11 闸门可取消：取消后闸门不锁死', async () => {
  const gate = createRequestGate({
    allowConcurrent: false,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    longRunThreshold: 0,
    now: () => 0,
    sleep: async () => {},
  })
  const controller = new AbortController()
  controller.abort()
  try {
    await gate.acquire('chat', controller.signal)
  } catch {}
  const release = await gate.acquire('chat')
  assert.equal(typeof release, 'function', '取消之后后续请求仍要能拿到许可')
  release()
})

await test('F11 闸门可取消：排队等待中取消 → 能退出且不放任队列卡死', async () => {
  const gate = createRequestGate({
    allowConcurrent: false,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    longRunThreshold: 0,
    now: () => 0,
    sleep: async () => {},
  })
  const hold = await gate.acquire('chat') // 占住不释放，让第二个进入排队
  const controller = new AbortController()
  let settled = false
  let caught
  const pending = gate.acquire('chat', controller.signal).then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      caught = error
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 5)) // 让它真正 await 在队列上
  controller.abort()
  await pending
  assert.ok(settled, '取消后必须 settle（不能永远悬着）')
  assert.equal(caught?.name, 'AbortError')

  // 关键：被取消的节点必须把自己摘出队列，否则后面排队的请求永久卡住
  hold()
  const raced = await Promise.race([
    gate.acquire('chat').then((release) => {
      release()
      return 'got'
    }),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 300)),
  ])
  assert.equal(raced, 'got', '取消之后队列必须还在流动（否则闸门被锁死）')
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
