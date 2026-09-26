// 「上下文范围」滑块的回归用例。
//
// 这条链路是四段式的：**界面 → 路由 → gate.json → adapter**。
// 0.1.82 的 P0-1（maxRefImages 发不进去）正是死在第 2 段 —— 界面发了字段、路由白名单不认，
// 于是必然 400 而只有字符串断言在"守"。所以这里的断言一律打在**真实入口**：
// 真 POST 一次 /gate，再读回 gate.json；最后再守一段最容易漏的 —— **adapter 真的用上了这个值**
// （否则就是"滑块好看但没用"，纯函数用例抓不到）。
//
// 另外，这条链路有个与 maxRefImages 不同的地方：它**不是**请求级切片，而是模型能力声明，
// 所以必须同时验证 `context.contextWindow` 真的变了，不能只验证存下来。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-ctxwin-'))
process.env.DSH_HOME = HOME

const {
  CONTEXT_WINDOW_BOUNDS,
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_CONTEXT_WINDOW,
  clampContextWindow,
} = await import('../src/gate.ts')

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

// 宿主路由装置（照 check-bugfix-0182 的配方；probeIntervalMs=0 → 零定时器）
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

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(text) { res.body = text ?? '' },
  }
  return res
}

const handler = await boot()

// ⚠️ 两个踩过的坑（照抄注释免得重犯）：
//  1) 路由挂在 `/deepseek-web-login/api` 前缀下 —— 少了前缀一律 404，而 404 与"断言写错"长得一样；
//  2) `readJsonBody` 会调 `req.off(...)`，所以假 req 必须是真 EventEmitter，
//     否则 cleanup 抛在 promise 里 ⇒ **promise 永不结算**（表现为用例挂在 await 上）。
const API = '/deepseek-web-login/api'

function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function post(route, payload) {
  const res = fakeRes()
  await handler(fakeReq('POST', API + route, payload), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

async function get(route) {
  const res = fakeRes()
  await handler(fakeReq('GET', API + route), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

const gateFile = join(HOME, 'web-login', 'gate.json')

// ── 第二、三段：路由认这个字段，而且真的落盘 ──────────────────────────

await test('POST /gate {contextWindow} 被接受并写进 gate.json', async () => {
  const { status, data } = await post('/gate', { contextWindow: 131_072 })
  assert.equal(
    status,
    200,
    `此前若漏了白名单会必然 400「没有可更新的字段」，实际 status=${status} body=${JSON.stringify(data)}`,
  )
  assert.equal(data?.contextWindow, 131_072, '响应里要回显生效后的值')
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.contextWindow, 131_072, '**落盘**才是这条用例的重点')
})

await test('越界被夹到区间内（不是原样写进去）', async () => {
  const low = await post('/gate', { contextWindow: 1 })
  assert.equal(low.status, 200)
  assert.equal(low.data?.contextWindow, CONTEXT_WINDOW_BOUNDS.min, `下限 ${CONTEXT_WINDOW_BOUNDS.min}`)
  const high = await post('/gate', { contextWindow: 99_999_999 })
  assert.equal(high.data?.contextWindow, CONTEXT_WINDOW_BOUNDS.max, `上限 ${CONTEXT_WINDOW_BOUNDS.max}`)
})

await test('非数字仍然 400（白名单没有变成"什么都收"）', async () => {
  const { status } = await post('/gate', { contextWindow: 'abc' })
  assert.equal(status, 400)
})

await test('GET /gate 把档位表与默认值给到界面（免得两边各写一套数字）', async () => {
  const { status, data } = await get('/gate')
  assert.equal(status, 200)
  assert.deepEqual(
    data?.contextWindowOptions,
    [...CONTEXT_WINDOW_OPTIONS],
    '档位表必须由后端给 —— 界面自己写死就会与 clamp 的边界漂开',
  )
  assert.equal(data?.contextWindowDefault, DEFAULT_CONTEXT_WINDOW)
  assert.deepEqual(data?.contextWindowBounds, { ...CONTEXT_WINDOW_BOUNDS })
})

// ── 默认值与边界语义 ────────────────────────────────────────────────

await test('默认值就是原来的硬编码 1Mi —— 不碰滑块的用户行为完全不变', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 1_048_576, '改默认值等于偷偷改变所有人的上下文行为')
  assert.equal(clampContextWindow(Number.NaN), 1_048_576, '非数回落默认')
  assert.equal(clampContextWindow(65_536), 65_536, '区间内的值原样保留（只有界面才做档位吸附）')
})

// ── 第四段：adapter 真的用上了它（否则就是"滑块好看但没用"）──────────

await test('adapter 的 resolveModel 把覆盖值塞进 context.contextWindow', async () => {
  const { createAdapter } = await import('../src/adapter.ts')
  const adapter = createAdapter({ config: { contextWindow: 131_072, logger: {} } })
  const info = await adapter.resolveModel('deepseek-web', 'deepseek-chat')
  assert.equal(
    info?.context?.contextWindow,
    131_072,
    '模型信息里的 contextWindow 才是 DSH 实际读的那个 —— 只存进 gate.json 不算接线成功',
  )
})

await test('没传覆盖值时沿用 MODEL_SPECS 的标称 1Mi', async () => {
  const { createAdapter, MODEL_SPECS } = await import('../src/adapter.ts')
  const adapter = createAdapter({ config: { logger: {} } })
  const info = await adapter.resolveModel('deepseek-web', 'deepseek-chat')
  assert.equal(info?.context?.contextWindow, MODEL_SPECS[0].contextWindow)
  assert.equal(MODEL_SPECS[0].contextWindow, 1_048_576, '标称值本身不许被顺手改掉')
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项 ❌\n  ${failures.join('\n  ')}` : '，全部通过 ✅'}`)
process.exit(failures.length === 0 ? 0 : 1)
