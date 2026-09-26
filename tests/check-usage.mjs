/**
 * 回归：「Token 统计」页的数据链路。
 *
 * 链路是四段式的：**adapter 算出 token → 落盘 usage/*.jsonl → 路由聚合 → 界面**。
 * 0.1.82 那条 P0（maxRefImages 发不进去）就是死在中段，所以这里每一段都真跑：
 *  ① 纯聚合（喂字面量测边界，不碰 fs）
 *  ② 落盘 + 读回（真写文件、真 summarizeUsage）
 *  ③ **adapter 真产出 usage 事件，并且 noteCall 真的收到 token**（这一段最容易假绿：
 *     只断言"事件发出来了"是抓不到"宿主没接到"的）
 *  ④ 真 GET 一次 /usage
 *
 * 另外守两个已经踩过的坑：
 *  - `Number(null) === 0`，而 0 在这里的含义是"全部" ⇒ 不带 days 参数的请求必须仍是 30 天；
 *  - 日期分桶必须用**本地时区**（`toISOString` 是 UTC，晚上 8 点后会把记录算到明天）。
 *
 * 用法: node tests/check-usage.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-usage-'))
process.env.DSH_HOME = HOME

const { aggregateUsage, clampUsageDays, localDateKey, noteUsage, summarizeUsage, usageDir, usageEntryFrom, USAGE_MAX_DAYS } =
  await import('../src/usage.ts')
const { createAdapter } = await import('../src/adapter.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const DAY = 86_400_000
/** 固定"现在"= 2026-09-26 21:00（本地）。全部时间计算都相对它，用例才可复现。 */
const NOW = new Date(2026, 8, 26, 21, 0, 0).getTime()
const entry = (at, over = {}) => ({ at, purpose: 'chat', ok: true, in: 0, out: 0, ...over })

// ── ① 纯聚合 ──────────────────────────────────────────────────────────
await test('空数据：时间轴照样补齐，不出现 NaN', () => {
  const out = aggregateUsage([], { days: 7, now: NOW })
  assert.equal(out.series.length, 7, '7 天要有 7 格（没有调用的日子补 0，否则趋势图会把日期挤在一起）')
  assert.ok(
    out.series.every((d) => d.calls === 0 && d.in === 0 && d.out === 0),
    '空格子必须全是 0',
  )
  assert.equal(out.totals.calls, 0)
  assert.equal(out.totals.total, 0)
  assert.equal(out.totals.avgPerCall, 0, '没有调用时平均值必须是 0，不能是 NaN')
  assert.deepEqual(out.byModel, [])
  assert.equal(out.coverage.from, null)
})

await test('窗口外的条目被丢掉：总计与图上画出来的必须一致', () => {
  const out = aggregateUsage(
    [
      entry(NOW - 2 * DAY, { in: 100, out: 20, server: true, model: 'deepseek-chat' }),
      entry(NOW - 2 * DAY, { ok: false, in: 0, out: 0, model: 'deepseek-chat' }),
      entry(NOW, { in: 50, out: 10, model: 'deepseek-reasoner' }),
    ],
    { days: 2, now: NOW },
  )
  assert.equal(out.series.length, 2)
  assert.equal(out.series[0].date, localDateKey(NOW - DAY), '第一格是昨天')
  assert.equal(out.series[0].calls, 0, '昨天没有调用')
  assert.equal(out.series[1].calls, 1)
  // 前天那两条在 2 天窗口之外 ⇒ 总计也不算它们，否则"总计 3 次"而图里只有 1 次
  assert.equal(out.totals.calls, 1)
  assert.equal(out.totals.in, 50)
  assert.equal(out.coverage.from, localDateKey(NOW), '覆盖范围也只能报窗口内的')
})

await test('总计与平均：含失败调用，服务端口径单独计数', () => {
  const out = aggregateUsage(
    [
      entry(NOW, { in: 100, out: 20, server: true }),
      entry(NOW, { in: 300, out: 60 }),
      entry(NOW, { ok: false }),
    ],
    { days: 1, now: NOW },
  )
  assert.equal(out.totals.calls, 3)
  assert.equal(out.totals.ok, 2)
  assert.equal(out.totals.failed, 1)
  assert.equal(out.totals.in, 400)
  assert.equal(out.totals.out, 80)
  assert.equal(out.totals.total, 480)
  assert.equal(out.totals.serverCalls, 1, '只有一条带 server 标记')
  assert.equal(out.totals.avgPerCall, 160)
})

await test('分组：按总量降序，缺模型名兜底成 (未标注)', () => {
  const out = aggregateUsage(
    [
      entry(NOW, { in: 10, out: 0, model: 'a' }),
      entry(NOW, { in: 900, out: 0, model: 'b' }),
      entry(NOW, { in: 5, out: 0 }),
    ],
    { days: 1, now: NOW },
  )
  assert.deepEqual(out.byModel.map((g) => g.key), ['b', 'a', '(未标注)'])
  assert.equal(out.byModel[0].in, 900)
  assert.deepEqual(out.byAccount.map((g) => g.key), ['(未知账号)'])
})

await test('days=0：时间轴从最早那条数据开始（总计视图）', () => {
  const out = aggregateUsage([entry(NOW - 3 * DAY, { in: 1 })], { days: 0, now: NOW })
  assert.equal(out.series.length, 4, '最早那天到今天 = 4 格')
  assert.equal(out.series[0].date, localDateKey(NOW - 3 * DAY))
  assert.equal(out.series[3].date, localDateKey(NOW))
})

await test('clampUsageDays：字符串能认、越界夹住、必须取整', () => {
  assert.equal(clampUsageDays('7'), 7, '路由把查询串直接透传进来，别在调用处各转一次')
  assert.equal(clampUsageDays(1000), USAGE_MAX_DAYS, '上限是保留期')
  assert.equal(clampUsageDays(-5), 0)
  assert.equal(clampUsageDays(3.7), 3, '不取整会喂给循环产生小数步长')
  assert.equal(clampUsageDays('abc'), 30, '认不出就用默认值')
  assert.equal(clampUsageDays(null), 0, '⚠️ Number(null)===0 —— 判空必须在路由层做（见下面的路由用例）')
})

await test('日期分桶用本地时区（UTC 会把晚上的记录算到明天）', () => {
  const d = new Date(2026, 8, 26, 7, 0, 0) // 本地 07:00
  const expected = `${d.getFullYear()}-09-26`
  assert.equal(localDateKey(d.getTime()), expected)
  assert.equal(localDateKey(new Date(2026, 8, 26, 23, 59, 0).getTime()), expected)
})

// ── ② 落盘 + 读回 ─────────────────────────────────────────────────────
await test('usageEntryFrom：整理上报（含"别把估算说成服务端口径"这条）', () => {
  const withServer = usageEntryFrom(
    { purpose: 'chat', accountId: 'acc_1', model: 'm', ok: true, tokens: { inputTokens: 10.6, outputTokens: -3, serverTotal: true } },
    1000,
  )
  assert.equal(withServer.at, 1000)
  assert.equal(withServer.in, 11, '小数要四舍五入')
  assert.equal(withServer.out, 0, '负数按 0 处理，不能记成负用量')
  assert.equal(withServer.server, true)
  assert.equal(withServer.accountId, 'acc_1')
  assert.equal(withServer.model, 'm')

  const estimated = usageEntryFrom({ purpose: 'chat', ok: true, tokens: { inputTokens: 5, outputTokens: 5 } }, 1)
  assert.equal(estimated.server, false, 'serverTotal 缺失时必须是 false —— 这是最容易写错的一处')

  const noTokens = usageEntryFrom({ purpose: 'session-title', ok: false }, 2)
  assert.equal(noTokens.in, 0)
  assert.equal(noTokens.out, 0)
  assert.equal('server' in noTokens, false, '压根没有 token 数据时不要写 server 字段（免得被误读成"服务端口径为 false 的有效样本"）')
  assert.equal('model' in noTokens, false, '没模型名就别塞空串')
})

await test('noteUsage 落到 usage/<日期>.jsonl，summarizeUsage 能读回来', () => {
  const at = Date.now()
  noteUsage({ at, purpose: 'chat', ok: true, in: 1234, out: 56, server: true, model: 'deepseek-chat' })
  noteUsage({ at, purpose: 'session-title', ok: true, in: 10, out: 2, model: 'deepseek-chat' })
  const files = readdirSync(usageDir()).filter((name) => name.endsWith('.jsonl'))
  assert.ok(files.length >= 1, `usage 目录里应该有文件：${usageDir()}`)
  const raw = readFileSync(join(usageDir(), files[0]), 'utf8').trim().split('\n')
  assert.equal(raw.length, 2, '两条调用写两行（JSONL 追加式）')
  const parsed = JSON.parse(raw[0])
  assert.equal(parsed.in, 1234, '落盘的就是适配器给的那组数')
  assert.equal(parsed.server, true)

  const summary = summarizeUsage(7)
  assert.equal(summary.series.length, 7)
  assert.equal(summary.totals.calls, 2, '刚落的两条必须出现在近 7 天里')
  assert.equal(summary.totals.in, 1244)
  assert.equal(summary.totals.serverCalls, 1, '只有一条是服务端口径')
  assert.equal(summary.coverage.to, localDateKey(at))
})

// ── ③ adapter 真的把 token 交出来了 ───────────────────────────────────
const AUTH = { token: 't'.repeat(64), cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'test-ua', capturedAt: '2026-09-11T00:00:00.000Z' }

async function runAdapter(stream, options = {}) {
  const noted = []
  const events = []
  let error = null
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: {},
    noteCall: (info) => noted.push(info),
    streamCompletion: () => stream(),
  })
  try {
    for await (const event of adapter.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...options,
    })) {
      events.push(event)
    }
  } catch (thrown) {
    error = thrown
  }
  return { noted, events, error }
}

// ⚠️ 假流的正文**必须以句号收尾**：否则「句中被截」判据会触发自动续写，
// 同一段文本被送 3 轮（maxContinuations=2），token 数跟着叠成 3 倍 ——
// 我第一版就是这么写错的（期望 100、实际 300）。
const PROMPT_TEXT = `${'x'.repeat(319)}.`

await test('adapter：noteCall 拿到 token，且与 usage 事件同源（不能被吞、也不能两处各算一遍）', async () => {
  const { noted, events } = await runAdapter(async function* () {
    yield { kind: 'text', text: PROMPT_TEXT }
    yield { kind: 'finish', reason: 'FINISHED' }
  })
  const usage = events.find((e) => e.type === 'usage')
  assert.ok(usage, 'usage 事件必须继续往上传 —— 捕获时顺手漏了 yield 就会静默少一项')
  assert.equal(noted.length, 1, '每次调用上报一次')
  const tokens = noted[0].tokens
  assert.ok(tokens, 'noteCall 必须带上 tokens')
  assert.equal(tokens.inputTokens, usage.usage.inputTokens, '本地统计与上报给宿主的必须是同一组数')
  assert.equal(tokens.outputTokens, usage.usage.outputTokens)
  assert.equal(tokens.serverTotal, false, '没拿到服务端总量 ⇒ 不能声称是服务端口径')
  assert.equal(noted[0].purpose, 'chat')
  assert.equal(noted[0].model, undefined, '没传 model 时不要瞎编一个')
})

await test('adapter：传了 model 就照原样带上（按模型分布要用）', async () => {
  const { noted } = await runAdapter(
    async function* () {
      yield { kind: 'text', text: PROMPT_TEXT }
      yield { kind: 'finish', reason: 'FINISHED' }
    },
    { model: 'deepseek-reasoner' },
  )
  assert.equal(noted[0].model, 'deepseek-reasoner')
})

await test('adapter：服务端给了 total ⇒ serverTotal 为真，且输入取余下部分', async () => {
  const { noted } = await runAdapter(async function* () {
    yield { kind: 'text', text: PROMPT_TEXT }
    yield { kind: 'finish', reason: 'FINISHED', totalTokens: 1000 }
  })
  const tokens = noted[0].tokens
  assert.equal(tokens.serverTotal, true)
  assert.equal(tokens.inputTokens + tokens.outputTokens, 1000, '服务端总量应当被拆成输入 + 输出，不要丢数')
  assert.ok(tokens.outputTokens <= 1000, '输出不能超过总量')
})

await test('adapter：流失败时也上报（调用次数要完整），但可以没有 tokens', async () => {
  const { noted, error, events } = await runAdapter(async function* () {
    throw Object.assign(new Error('boom'), { code: 'TRANSPORT' })
  })
  assert.ok(error, '自证：这次流确实失败了（用例别在"其实没失败"的情况下假装通过）')
  assert.equal(events.length, 0, '失败时不该产出一堆半成品事件')
  assert.equal(noted.length, 1)
  assert.equal(noted[0].ok, false)
  assert.equal(noted[0].code, 'TRANSPORT')
})

// ── ④ 真 GET 一次 /usage ──────────────────────────────────────────────
async function boot() {
  const { apply } = await import('../src/index.ts')
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')
  return handler
}

const API = '/deepseek-web-login/api'

function fakeReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  setImmediate(() => req.emit('end'))
  return req
}

function fakeRes() {
  const res = { statusCode: 0, body: '', writeHead(status) { res.statusCode = status }, end(text) { res.body = text ?? '' } }
  return res
}

const handler = await boot()

async function get(path) {
  const res = fakeRes()
  await handler(fakeReq('GET', API + path), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

await test('GET /usage?days=7：返回界面需要的字段', async () => {
  const before = Date.now()
  noteUsage({ at: before, purpose: 'chat', ok: true, in: 777, out: 33, server: true, model: 'deepseek-reasoner' })
  const { status, json } = await get('/usage?days=7')
  assert.equal(status, 200)
  assert.equal(json.days, 7)
  assert.equal(json.series.length, 7)
  assert.equal(json.keepDays, 90, '界面页脚要显示保留期')
  assert.ok(Array.isArray(json.byModel) && Array.isArray(json.byAccount) && Array.isArray(json.byPurpose))
  assert.ok(json.totals.in >= 777, `刚落的那条要算进去（实际 ${json.totals.in}）`)
  assert.ok(json.byModel.some((g) => g.key === 'deepseek-reasoner'))
})

await test('GET /usage（不带参数）仍是 30 天，不会因为 Number(null)===0 变成"全部"', async () => {
  const { json } = await get('/usage')
  assert.equal(json.days, 30, '漏了判空的话这里会是 0 ＝ 全量查询')
  assert.equal(json.series.length, 30)
})

await test('GET /usage?days=abc：认不出就退回默认 30 天', async () => {
  const { json } = await get('/usage?days=abc')
  assert.equal(json.days, 30)
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
if (failures.length) {
  for (const line of failures) console.log(`  ${line}`)
  process.exitCode = 1
}
