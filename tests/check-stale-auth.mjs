// 「已知授权失效的账号，请求根本不发」—— 判据 + 行为两侧都钉。
//
// 真实现场（2026-09-21）：
//   22:42:38  探活失败 —— Authorization Failed (invalid token)，写进账号的 lastVerifyError
//   22:50:01  用户又发消息 ⇒ **请求照常发出**，14 张图逐个走一次 POW + 一次上传
//   22:50:07  撞上 AUTH 才停下来并把账号标记为「需要重新登录」
// 也就是说：探活早就判定了 token 死了，但**请求路径没人看那块牌子** ——
// 28 次注定失败的请求（还都暴露在风控下）之后才知道。判据本身早就写好了
// （probe.ts 的 lastProbeFailed），只是没人调用。
//
// ⚠️ 这个改动会**拦住**请求，所以反例比正例更重要：网络抖动（断网 / 超时 / 5xx / 429）
// 也会写 lastVerifyError，但那种情况下凭证是好的 —— 拦下来就会把健康账号锁住。
// 用例里把这几类逐条钉成"必须放行"。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-stalea-'))
process.env.DSH_HOME = HOME

const { isAuthFailureMessage, staleAuthRecord } = await import('../src/auth.ts')
const { staleAuthMessage } = await import('../src/probe.ts')
const { accountsDir, updateAccount, upsertAccount } = await import('../src/accounts.ts')
const { createAdapter } = await import('../src/adapter.ts')

const TOKEN = 'tok-stale-0123456789'
const AUTH = {
  token: TOKEN,
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: 'https://example.invalid/w.wasm',
  userAgent: 'UA',
  capturedAt: '2026-09-21T00:00:00.000Z',
}

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 清空账号库，避免前后用例互相污染（每个用例都从"库里只有一条"开始）。 */
function resetAccounts() {
  rmSync(accountsDir(), { recursive: true, force: true })
  mkdirSync(accountsDir(), { recursive: true })
}

/**
 * 往库里放一条账号记录。
 * ⚠️ 直接写 JSON 而不是走 `upsertAccount`：这个用例要断的是**读盘之后怎么判**，
 * 所以落盘的样子要显式写出来（走写入口会把 `normalizeRecord` 的逻辑也算进来，
 * 一旦它在某天改动，这个用例就会默默测别的东西）。
 */
function putAccount({ token = TOKEN, lastVerifyError, lastVerifiedAt, id = 'acc_stale' } = {}) {
  mkdirSync(accountsDir(), { recursive: true })
  const record = {
    id,
    token,
    cookie: '',
    capturedAt: '2026-09-21T10:00:00.000Z',
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(lastVerifyError ? { lastVerifyError } : {}),
  }
  writeFileSync(join(accountsDir(), `${id}.json`), JSON.stringify(record, null, 2), 'utf8')
}

/** 跑一次适配器流，返回「发了几次请求」与错误。 */
async function runAdapter({ token = TOKEN } = {}) {
  const calls = []
  const adapter = createAdapter({
    getAuth: () => ({ ...AUTH, token }),
    config: { logger: undefined },
    streamCompletion: (_auth, params) => {
      calls.push(params)
      return (async function* () {
        yield { kind: 'text', text: '收到。' }
        yield { kind: 'finish', reason: 'stop' }
      })()
    },
  })
  const deltas = []
  let error
  try {
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }] })) {
      if (event.type === 'text-delta') deltas.push(event.text)
    }
  } catch (caught) {
    error = caught
  }
  return { calls, text: deltas.join(''), error }
}

// ── 1) 失败串的分类：授权类才拦 ──────────────────────────────────────────

await test('授权类失败串：英文 / 状态码 / 中文 三种形态都认得', () => {
  assert.equal(isAuthFailureMessage('Authorization Failed (invalid token)'), true)
  assert.equal(isAuthFailureMessage('users/current HTTP 401'), true)
  assert.equal(isAuthFailureMessage('users/current HTTP 403'), true)
  assert.equal(
    isAuthFailureMessage('DeepSeek 网页授权失败：Authorization Failed —— 登录态已过期或无效，请到…重新登录'),
    true,
  )
  assert.equal(isAuthFailureMessage('登录态无效，请重新登录'), true)
  assert.equal(isAuthFailureMessage('登录状态已失效'), true)
})

await test('🔴 网络类失败串必须**不**认（认了 = 一次断网锁死健康账号）', () => {
  assert.equal(isAuthFailureMessage('fetch failed'), false)
  assert.equal(isAuthFailureMessage('The operation was aborted due to timeout'), false)
  assert.equal(isAuthFailureMessage('users/current HTTP 500'), false)
  assert.equal(isAuthFailureMessage('users/current HTTP 429'), false)
  assert.equal(isAuthFailureMessage('connect ECONNREFUSED 127.0.0.1:7897'), false)
})

await test('裸数字不算授权失败（只认 HTTP 401/403 这个形态）', () => {
  assert.equal(isAuthFailureMessage('重试 403 次后放弃'), false)
  assert.equal(isAuthFailureMessage('已发出 401 个请求'), false)
  assert.equal(isAuthFailureMessage(''), false)
  assert.equal(isAuthFailureMessage(undefined), false)
  assert.equal(isAuthFailureMessage(null), false)
})

// ── 2) 时间比较：失败晚于成功才算「当前处于失败态」 ────────────────────────

await test('授权类失败 + 从没成功过 ⇒ 判失效（`lastVerifiedAt` 缺省时的比较方向要对）', () => {
  const reason = staleAuthRecord({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed' } })
  assert.ok(reason, '这是本机真实现场：探活失败时记录里往往没有 lastVerifiedAt')
  assert.match(reason, /Authorization Failed/)
})

await test('授权类失败晚于上次成功 ⇒ 判失效', () => {
  const reason = staleAuthRecord({
    lastVerifiedAt: '2026-09-21T10:00:00.000Z',
    lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'users/current HTTP 401' },
  })
  assert.ok(reason)
})

await test('失败之后又有一次成功 ⇒ **不判**（标记已过期，别锁住刚验证过的账号）', () => {
  assert.equal(
    staleAuthRecord({
      lastVerifiedAt: '2026-09-21T23:00:00.000Z',
      lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed' },
    }),
    undefined,
  )
})

await test('🔴 失败串是网络类 ⇒ **不判**（凭证是好的，不该拦）', () => {
  for (const message of ['fetch failed', 'users/current HTTP 500', 'users/current HTTP 429']) {
    assert.equal(staleAuthRecord({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message } }), undefined, message)
  }
})

await test('没有失败记录 ⇒ 不判', () => {
  assert.equal(staleAuthRecord(undefined), undefined)
  assert.equal(staleAuthRecord({}), undefined)
  assert.equal(staleAuthRecord({ lastVerifyError: null }), undefined)
})

// ── 3) 按 token 找到记录（真实路径） ─────────────────────────────────────

await test('staleAuthMessage：按 token 命中库里那条失效记录', () => {
  resetAccounts()
  putAccount({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed (invalid token)' } })
  assert.ok(staleAuthMessage(AUTH))
})

await test('staleAuthMessage：库里没有这个 token（手工粘贴的凭证）⇒ 不判', () => {
  resetAccounts()
  putAccount({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed' } })
  assert.equal(staleAuthMessage({ ...AUTH, token: 'tok-别的账号-9999' }), undefined)
})

// ── 4) 行为：请求到底发没发 ──────────────────────────────────────────────
// 前面几组断的是判据，这一组断的是**判据真的接上了**（判据写对了但没人调用，
// 正是这次现场的根本原因 —— 所以必须有一条用例断"请求次数"，不能只断纯函数）。

await test('🔴 账号已被标记授权失效 ⇒ **一次请求都不发**，且报 AUTH', async () => {
  resetAccounts()
  putAccount({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed (invalid token)' } })
  const { calls, error } = await runAdapter()
  assert.equal(calls.length, 0, '已知失效还发请求 = 现场那 28 次注定失败的请求')
  assert.equal(error?.code, 'AUTH')
  assert.match(String(error?.message), /本次请求没有发出/)
  // 错误里必须给出**两条**出路：重新登录（正解）+ 校验全部（误判时的出口）
  assert.match(String(error?.message), /重新登录/)
  assert.match(String(error?.message), /校验全部/)
})

await test('🔴 同样是"探活失败"，失败串是网络类 ⇒ 照常发（防误锁健康账号）', async () => {
  resetAccounts()
  putAccount({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'users/current HTTP 429' } })
  const { calls, text, error } = await runAdapter()
  assert.equal(error, undefined)
  assert.equal(calls.length, 1)
  assert.equal(text, '收到。')
})

await test('失败之后又成功过一次 ⇒ 照常发', async () => {
  resetAccounts()
  putAccount({
    lastVerifiedAt: '2026-09-21T23:00:00.000Z',
    lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed' },
  })
  const { calls, error } = await runAdapter()
  assert.equal(error, undefined)
  assert.equal(calls.length, 1)
})

await test('拦截随后解除：标记被清掉（重新登录 / 校验全部成功）⇒ 恢复发请求', async () => {
  resetAccounts()
  putAccount({ lastVerifyError: { at: '2026-09-21T22:42:38.000Z', message: 'Authorization Failed' } })
  assert.equal((await runAdapter()).calls.length, 0, '自证：前置条件是它确实被拦住了')
  // 模拟"重新登录/校验成功"把标记清掉（真实路径见 account-add.ts 与 probe.ts）
  const record = upsertAccount(AUTH, { label: '测试号' })
  updateAccount(record.id, { lastVerifyError: undefined, lastVerifiedAt: '2026-09-22T09:00:00.000Z', unverified: false })
  assert.equal(await staleAuthMessage(AUTH), undefined)
  assert.equal((await runAdapter()).calls.length, 1)
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项 ❌\n  ${failures.join('\n  ')}` : '，全部通过 ✅'}`)
if (failures.length) process.exitCode = 1
