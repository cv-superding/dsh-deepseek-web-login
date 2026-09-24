/**
 * F1 + F2 行为用例（0.2.0）。
 *
 * F1：探活（probeOnce）解析 users/current 的 chat.is_muted / mute_until，
 *     写回账号记录的 limit 字段 —— 「被限到 X」提前出现在面板徽章上；
 *     is_muted=false 时清掉旧标记（提前看见解除）。
 *
 * F2：请求被判 AUTH 后，宿主先用同一份凭证做只读探活复核（index.ts recordCallOutcome）：
 *       复核也失败 ⇒ 照旧写 lastVerifyError（确认失效）
 *       复核通过   ⇒ **不标记**（端点级误判有出口，健康账号不会被 0.1.80 的拦截锁死）
 *       复核自身失败（网络）⇒ 不标记（误标代价远大于漏标）
 *
 * 用法: node tests/check-auth-recheck.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-recheck-'))
process.env.DSH_HOME = HOME

const { listAccounts, upsertAccount } = await import('../src/accounts.ts')
const { writeAuth } = await import('../src/auth.ts')
const { probeOnce } = await import('../src/probe.ts')
const { setFetchImpl } = await import('../src/webapi.ts')

// F2 用例的共享计数器：自证"复核探活确实发出过"——
// 第一版用 lastVerifiedAt 当等待条件，被 F1 的残留数据骗了（假绿）。
let currentHits = 0

const AUTH = {
  token: 'tok-recheck',
  cookie: 'c=1',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: 'https://chat.deepseek.com/sha3_wasm_bg.wasm',
  userAgent: 'ua',
  capturedAt: new Date().toISOString(),
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

// ── F1：probeOnce 解析限流状态 ──────────────────────────────

const mutedEnvelope = (untilSec) => ({
  code: 0,
  data: {
    biz_data: {
      id: 'u-1',
      email: 'a***@example.com',
      chat: { is_muted: true, ...(untilSec ? { mute_until: untilSec } : {}) },
    },
  },
})
const freeEnvelope = { code: 0, data: { biz_data: { id: 'u-1', email: 'a***@example.com', chat: { is_muted: false } } } }

await test('F1：探活发现 is_muted=true → limit 写进账号记录（含解除时间）', async () => {
  writeAuth(AUTH)
  upsertAccount({ ...AUTH, id: 'acc_F1' })
  const untilSec = Math.floor((Date.now() + 30 * 60_000) / 1000)
  setFetchImpl(async () => new Response(JSON.stringify(mutedEnvelope(untilSec)), { status: 200 }))
  const outcome = await probeOnce(AUTH)
  assert.equal(outcome?.ok, true, '自证：探活本身成功')
  const record = listAccounts().find((item) => item.token === AUTH.token)
  assert.ok(record?.limit, 'limit 必须写进记录')
  // mute_until 单位是秒 ⇒ 落库是毫秒（误差容忍 5s）
  assert.ok(Math.abs(record.limit.untilMs - untilSec * 1000) < 5000, `untilMs 应为 ${untilSec * 1000} 附近，实际 ${record.limit.untilMs}`)
})

await test('F1：is_muted=false → 清掉旧 limit 标记（提前看见解除）', async () => {
  setFetchImpl(async () => new Response(JSON.stringify(freeEnvelope), { status: 200 }))
  const outcome = await probeOnce(AUTH)
  assert.equal(outcome?.ok, true)
  const record = listAccounts().find((item) => item.token === AUTH.token)
  assert.equal(record?.limit, undefined, 'is_muted=false ⇒ 旧标记必须被清掉')
})

await test('F1：响应里没有 chat 字段 → 不动 limit（不猜）', async () => {
  // 先制造一个受限标记
  const untilSec = Math.floor((Date.now() + 30 * 60_000) / 1000)
  setFetchImpl(async () => new Response(JSON.stringify(mutedEnvelope(untilSec)), { status: 200 }))
  await probeOnce(AUTH)
  // 再来一次没有 chat 的响应（老版本服务端 / 字段改名）——limit 必须原样保留
  setFetchImpl(async () => new Response(JSON.stringify({ code: 0, data: { biz_data: { id: 'u-1' } } }), { status: 200 }))
  await probeOnce(AUTH)
  const record = listAccounts().find((item) => item.token === AUTH.token)
  assert.ok(record?.limit, 'chat 缺失时不得清空已有 limit（那是"没探到"，不是"没受限"）')
})

await test('F1：muted=true 但服务端没给 mute_until → 不写 limit（没有可展示的）', async () => {
  setFetchImpl(async () => new Response(JSON.stringify(mutedEnvelope(0)), { status: 200 }))
  await probeOnce(AUTH)
  const record = listAccounts().find((item) => item.token === AUTH.token)
  assert.equal(record?.limit, undefined, '无解除时间的受限不写 untilMs=0（徽章也不亮）')
})

// ── F2：AUTH 先复核再标记 ───────────────────────────────────

// 捕获宿主日志：F2a 的等待信号是「误判处理」这行日志 —— 不能用账号状态当信号
//（lastVerifiedAt/lastVerifyError 都会被前面 F1 的残留污染，第一版就因此假绿）。
const hostLogs = []
const logSink = { info: (m) => hostLogs.push(String(m)), warn: (m) => hostLogs.push(String(m)) }

async function bootAdapter() {
  const { apply } = await import('../src/index.ts')
  let adapter
  const ctx = {
    effect: (fn) => fn(),
    logger: logSink,
    llm: {
      registerAdapter: (providers, adapterInstance) => {
        adapter = adapterInstance
      },
      listProviders: () => [],
    },
    webServer: { register: () => {} },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.ok(adapter && typeof adapter.stream === 'function', '自证：捕获了注册给 DSH 的 adapter')
  return adapter
}

const CHALLENGE_URL = '/api/v0/chat/create_pow_challenge'
const CURRENT_URL = '/api/v0/users/current'

/** 驱动一次 stream：PoW challenge 返回 40003 ⇒ 整条流以 AUTH 失败。 */
async function driveOneAuthRound(adapter) {
  try {
    for await (const _event of adapter.stream({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] })) {
      // 不关心内容
    }
  } catch {
    // 预期：AUTH 失败
  }
}

async function waitFor(predicate, what, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${what}`)
}

await test('F2：请求 AUTH + 复核探活通过 ⇒ 不标记（端点级误判有出口）', async () => {
  writeAuth(AUTH)
  upsertAccount({ ...AUTH, id: 'acc_F2a' })
  currentHits = 0
  const adapter = await bootAdapter()
  setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('chat_session/create')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { id: 's-1' } } }), { status: 200 })
    }
    if (url.includes(CHALLENGE_URL)) {
      return new Response(JSON.stringify({ code: 40003, msg: 'Authorization Failed (invalid token)' }), { status: 200 })
    }
    if (url.includes(CURRENT_URL)) {
      currentHits += 1
      // 复核探活：通过
      return new Response(JSON.stringify(freeEnvelope), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  await driveOneAuthRound(adapter)
  // 自证：复核探活真的发出去了（异步 fire-and-forget，等它落地）。
  // ⚠️ 别用 lastVerifiedAt 当等待条件 —— F1 的残留数据会骗过你（第一版就假绿）。
  await waitFor(() => currentHits >= 1, '复核探活发出（currentHits>=1）')
  // 等待信号 = 宿主日志出现「误判处理」行（复核 .then 执行到成功分支的确定性证据）。
  await waitFor(() => hostLogs.some((line) => line.includes('按端点级误判处理')), '复核成功分支落地')
  const record = listAccounts().find((item) => item.token === AUTH.token)
  assert.equal(record?.lastVerifyError, undefined, '复核通过 ⇒ 绝不能写 lastVerifyError（否则 0.1.80 拦截会锁死健康账号）')
})

await test('F2：请求 AUTH + 复核探活也失败 ⇒ 确认失效，照旧标记', async () => {
  writeAuth(AUTH)
  upsertAccount({ ...AUTH, id: 'acc_F2b' })
  currentHits = 0
  const adapter = await bootAdapter()
  setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('chat_session/create')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { id: 's-1' } } }), { status: 200 })
    }
    if (url.includes(CHALLENGE_URL)) {
      return new Response(JSON.stringify({ code: 40003, msg: 'Authorization Failed (invalid token)' }), { status: 200 })
    }
    if (url.includes(CURRENT_URL)) {
      currentHits += 1
      // 复核探活：也失败
      return new Response('unauthorized', { status: 401 })
    }
    return new Response('not found', { status: 404 })
  })
  await driveOneAuthRound(adapter)
  await waitFor(() => currentHits >= 1, '复核探活发出（currentHits>=1）')
  await waitFor(() => {
    const r = listAccounts().find((item) => item.token === AUTH.token)
    return r?.lastVerifyError !== undefined
  }, '复核确认失效并标记')
})

console.log()
console.log(failures.length === 0 ? `通过 ${passed} 项，全部通过 ✅` : `通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
