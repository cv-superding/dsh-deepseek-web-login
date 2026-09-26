// 「自动换号」的回归用例。
//
// 这条链路还是四段式（**界面 → 路由 → gate.json → 宿主钩子**），所以落盘那几条断言照
// check-context-window.mjs 的规矩：**真 POST 一次 /gate，再读回 gate.json** ——
// 0.1.82 的 P0-1（maxRefImages 发不进去）就是死在路由白名单，而当时只有字符串断言在"守"。
//
// 挑选/决策那部分（auto-switch.ts）刻意做成纯函数，于是能直接喂字面量测边界：
// 失效的、受限未解除的、当前账号不可用的、可用不足两个的 …… 这些分支用真实账号库很难摆出来。
//
// ⚠️ 宿主钩子（maybeAutoSwitch 里探活 + setActiveAccount）**没有**在这里端到端跑：
// 它要真网络探活。这里守的是"决策对不对"与"设置存不存得进去"，
// 钩子与 adapter 的接线由产物断言 + 真机验证覆盖。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-autoswitch-'))
process.env.DSH_HOME = HOME

const { decideAutoSwitch, isSwitchDue, pickNextAccount } = await import('../src/auto-switch.ts')
const { AUTO_SWITCH_BOUNDS, DEFAULT_AUTO_SWITCH_MINUTES, clampAutoSwitchMinutes } = await import(
  '../src/gate.ts'
)

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

const MIN = 60_000
const NOW = 1_700_000_000_000

/** 一个"可用"的账号（不回退失效标记、不受限）。 */
const ok = (id) => ({ id })

// ── 纯逻辑：到点判定 ─────────────────────────────────────────────────

await test('关闭（0）时永远不到点', () => {
  assert.equal(isSwitchDue(0, NOW - 999 * MIN, NOW), false)
  assert.equal(isSwitchDue(-3, NOW - 999 * MIN, NOW), false)
  assert.equal(isSwitchDue(Number.NaN, NOW - 999 * MIN, NOW), false)
})

await test('到点判定看的是"距上次切换过了多久"', () => {
  assert.equal(isSwitchDue(30, NOW - 29 * MIN, NOW), false, '差一分钟不算到点')
  assert.equal(isSwitchDue(30, NOW - 30 * MIN, NOW), true, '正好到点就算')
  assert.equal(isSwitchDue(30, NOW - 31 * MIN, NOW), true)
})

await test('没有起点时不切（宁可不动，也不要在"不知道用了多久"时换号）', () => {
  assert.equal(isSwitchDue(30, 0, NOW), false)
  assert.equal(isSwitchDue(30, Number.NaN, NOW), false)
})

// ── 纯逻辑：挑下一个 ─────────────────────────────────────────────────

await test('取"当前账号之后的下一个"，走到末尾绕回开头', () => {
  const accounts = [ok('a'), ok('b'), ok('c')]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'b')
  assert.equal(pickNextAccount(accounts, 'b', NOW), 'c')
  assert.equal(pickNextAccount(accounts, 'c', NOW), 'a', '末尾要绕回，否则最后一个账号之后就没得切了')
})

await test('跳过登录态失效的账号', () => {
  const accounts = [ok('a'), { id: 'b', lastVerifyError: { at: '2026-09-26T00:00:00.000Z', message: '401' } }, ok('c')]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'c', '切到 b 必然失败 —— 白折腾一轮全量重发')
})

await test('跳过受限还没解除的账号', () => {
  const accounts = [
    ok('a'),
    { id: 'b', limit: { untilMs: NOW + 60 * MIN, observedAt: '2026-09-26T00:00:00.000Z' } },
    ok('c'),
  ]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'c')
})

await test('受限时间已过 ⇒ 又是可用账号了', () => {
  const accounts = [
    ok('a'),
    { id: 'b', limit: { untilMs: NOW - 1, observedAt: '2026-09-26T00:00:00.000Z' } },
  ]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'b')
})

await test('当前账号自己不可用 ⇒ 取第一个可用的（救急路径）', () => {
  const accounts = [ok('a'), ok('b'), ok('c')]
  assert.equal(pickNextAccount(accounts, 'zzz', NOW), 'a', '当前账号不在库里/不在可用集合里')
  assert.equal(pickNextAccount(accounts, undefined, NOW), 'a')
})

await test('可用的不足两个 ⇒ 不切（切了还是它，没意义）', () => {
  assert.equal(pickNextAccount([ok('a')], 'a', NOW), undefined)
  assert.equal(
    pickNextAccount([ok('a'), { id: 'b', lastVerifyError: { at: 'x', message: 'y' } }], 'a', NOW),
    undefined,
    '另一个失效了就只剩自己',
  )
  assert.equal(pickNextAccount([], 'a', NOW), undefined)
})

// ── 纯逻辑：合成决策 ─────────────────────────────────────────────────

await test('decideAutoSwitch：关闭 / 未到点 / 到点 三种主路径', () => {
  const accounts = [ok('a'), ok('b')]
  assert.deepEqual(
    decideAutoSwitch({ minutes: 0, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'a' }),
    { action: 'skip', reason: 'off' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 5 * MIN, now: NOW, accounts, currentId: 'a' }),
    { action: 'skip', reason: 'not-due' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 31 * MIN, now: NOW, accounts, currentId: 'a' }),
    { action: 'switch', nextId: 'b', reason: 'due' },
  )
})

await test('decideAutoSwitch：当前账号不可用 ⇒ 无视时间直接切走', () => {
  // 让用户在一个失效的账号上继续等满 30 分钟毫无意义 —— 那期间每个请求都会失败。
  const accounts = [{ id: 'a', lastVerifyError: { at: 'x', message: '401' } }, ok('b'), ok('c')]
  const decision = decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'a' })
  assert.equal(decision.action, 'switch')
  assert.equal(decision.reason, 'current-unusable', '理由要能区分"到点了"与"原账号坏了"')
  assert.equal(decision.nextId, 'b')
  // 对照：同一个库、同样"刚切过"的起点，当前账号若是好的就不会切
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'b' }),
    { action: 'skip', reason: 'not-due' },
  )
})

await test('decideAutoSwitch：没候选时如实说清是哪种没候选', () => {
  const allBad = [{ id: 'a', lastVerifyError: { at: 'x', message: 'y' } }]
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 60 * MIN, now: NOW, accounts: allBad, currentId: 'a' }),
    { action: 'skip', reason: 'no-candidate' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 60 * MIN, now: NOW, accounts: [ok('a')], currentId: 'a' }),
    { action: 'skip', reason: 'no-other-account' },
  )
})

// ── 落盘：真 POST 路由，再读回 gate.json ──────────────────────────────

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

// ⚠️ 两个踩过的坑（照抄，免得重犯）：
//  1) 路由挂在 `/deepseek-web-login/api` 前缀下 —— 少前缀一律 404，而 404 与"断言写错"长得一样；
//  2) `readJsonBody` 会调 `req.off(...)`，假 req 必须是**真 EventEmitter**，
//     否则 cleanup 抛在 promise 里 ⇒ promise 永不结算（表现为用例挂在 await 上）。
const API = '/deepseek-web-login/api'
const handler = await boot()

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

await test('POST /gate {autoSwitchMinutes} 被接受并写进 gate.json', async () => {
  const { status, data } = await post('/gate', { autoSwitchMinutes: 30 })
  assert.equal(
    status,
    200,
    `漏了白名单会必然 400「没有可更新的字段」，实际 status=${status} body=${JSON.stringify(data)}`,
  )
  assert.equal(data?.autoSwitchMinutes, 30, '响应里要回显生效后的值')
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.autoSwitchMinutes, 30, '**落盘**才是这条用例的重点')
})

await test('越界被夹到 0~120（含 0 = 关闭）', async () => {
  const high = await post('/gate', { autoSwitchMinutes: 9_999 })
  assert.equal(high.status, 200)
  assert.equal(high.data?.autoSwitchMinutes, AUTO_SWITCH_BOUNDS.max)
  const low = await post('/gate', { autoSwitchMinutes: -5 })
  assert.equal(low.data?.autoSwitchMinutes, AUTO_SWITCH_BOUNDS.min, '0 是合法值（关闭），别被当成非法')
})

await test('非数字仍然 400（白名单没变成"什么都收"）', async () => {
  const { status } = await post('/gate', { autoSwitchMinutes: 'abc' })
  assert.equal(status, 400)
})

await test('GET /gate 把边界与默认值给到界面（免得两边各写一套数字）', async () => {
  const { status, data } = await get('/gate')
  assert.equal(status, 200)
  assert.deepEqual(data?.autoSwitchBounds, { ...AUTO_SWITCH_BOUNDS }, '边界必须由后端给')
  assert.equal(data?.autoSwitchDefault, DEFAULT_AUTO_SWITCH_MINUTES, '默认必须是关闭（不动它的人行为不变）')
})

await test('clamp 与默认值自洽：0 是关闭而不是被兜成默认', () => {
  assert.equal(clampAutoSwitchMinutes(0), 0)
  assert.equal(clampAutoSwitchMinutes(Number.NaN), DEFAULT_AUTO_SWITCH_MINUTES)
  assert.equal(DEFAULT_AUTO_SWITCH_MINUTES, 0, '默认关闭 —— 否则老用户升级后会被悄悄换号')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
