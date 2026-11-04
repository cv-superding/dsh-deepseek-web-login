/**
 * 回归：请求前的两项自愈判定（2026-11-04）。
 *
 * ① `decideLiveToken`：页面里的 token 能不能采纳。
 *    现场 1：站点刷新了 `localStorage.userToken`，我们手里那份作废 ⇒ 必须采纳（否则重启就掉号）。
 *    现场 2：切号只改 `activeId`，页面还是**上一个号**的 token ⇒ 采纳它等于把 A 的凭证写进 B，
 *            并用 A 的身份发 B 的请求。这条必须拒绝。
 *
 * ② `freshAuthFailure`：`lastVerifyError` 还能不能用来快速失败。
 *    现场：手工粘贴 / 页面采纳都会换 token，但不会清 `lastVerifyError`（只有重登会清）⇒
 *    判定必须与**这份凭证的捕获时间**比，否则刚换好的号被「旧 token 的失败结论」误杀。
 *
 * 用法: node tests/check-live-token.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-live-token-'))

const {
  decideLiveToken,
  freshAuthFailure,
  liveTokenCacheTtl,
  liveTokenDiagnosticsPath,
  resetLiveTokenCacheForTest,
  withLiveToken,
} = await import('../src/webapi.ts')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

const STORED = 'a'.repeat(64)
const PAGE = 'b'.repeat(64)
const OTHER = 'c'.repeat(64)

console.log('页面 token 采纳')

test('页面 token 是新的（库里没有）⇒ 采纳（站点刷新后的自愈路径）', () => {
  assert.deepEqual(decideLiveToken({ storedToken: STORED, pageToken: PAGE }), { adopt: true })
})

test('页面 token 与手里那份相同 ⇒ 不采纳', () => {
  assert.deepEqual(decideLiveToken({ storedToken: STORED, pageToken: STORED }), {
    adopt: false,
    reason: 'same',
  })
})

test('页面读回空串/半截（<32）⇒ 不采纳（未登录页/读崩了）', () => {
  assert.equal(decideLiveToken({ storedToken: STORED, pageToken: '' }).adopt, false)
  assert.equal(decideLiveToken({ storedToken: STORED, pageToken: 'x'.repeat(31) }).adopt, false)
})

test('★ 页面里是**另一个号**的 token ⇒ 不采纳（切号后页面还没重装）', () => {
  const decision = decideLiveToken({
    storedToken: STORED,
    pageToken: OTHER,
    accounts: [
      { id: 'A', token: STORED },
      { id: 'B', token: OTHER },
    ],
  })
  assert.equal(decision.adopt, false, '把 A 的凭证写进 B 的记录是数据污染')
  assert.equal(decision.reason, 'other-account')
})

test('手里那份不在库里（认不出归属）⇒ 仍按形状采纳（不因缺记录丢掉自愈）', () => {
  const decision = decideLiveToken({
    storedToken: STORED,
    pageToken: OTHER,
    accounts: [{ id: 'B', token: OTHER }],
  })
  assert.equal(decision.adopt, true)
})

console.log('快速失败的时效')

const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

test('2 分钟内的失败结论（晚于凭证捕获）⇒ 采信', () => {
  const record = {
    capturedAt: iso(NOW - 60 * 60_000),
    lastVerifyError: { at: iso(NOW - 60_000), message: 'Authorization Failed (invalid token)' },
  }
  assert.equal(freshAuthFailure(record, NOW), 'Authorization Failed (invalid token)')
})

test('超过 2 分钟的旧结论 ⇒ 不采信（端点级误判不许把账号锁死）', () => {
  const record = {
    capturedAt: iso(NOW - 3 * 60 * 60_000),
    lastVerifyError: { at: iso(NOW - 10 * 60_000), message: 'Authorization Failed (invalid token)' },
  }
  assert.equal(freshAuthFailure(record, NOW), undefined)
})

test('★ 失败结论比这份凭证还早 ⇒ 不采信（手工粘贴 / 页面采纳换过 token）', () => {
  const record = {
    capturedAt: iso(NOW - 10_000),
    lastVerifyError: { at: iso(NOW - 60_000), message: 'Authorization Failed (invalid token)' },
  }
  assert.equal(freshAuthFailure(record, NOW), undefined, '旧 token 的结论不许用来拦新 token')
})

test('没有 lastVerifyError ⇒ 放行', () => {
  assert.equal(freshAuthFailure({ capturedAt: iso(NOW) }, NOW), undefined)
  assert.equal(freshAuthFailure(undefined, NOW), undefined)
})

test('宿主真的先自愈、再快速失败（顺序反了会把能自愈的号拦住）', () => {
  const src = readFileSync(new URL('../src/webapi.ts', import.meta.url), 'utf8')
  const healAt = src.indexOf('auth = await withLiveToken(auth)')
  const failAt = src.indexOf('freshAuthFailure(record)')
  assert.ok(healAt > 0, '没接 withLiveToken')
  assert.ok(failAt > healAt, 'withLiveToken 必须在快速失败之前')
})

// ── 2026-11-04：withLiveToken 的两个静默行为 ────────────────────────────────

console.log('页面 token 的缓存与留痕')

test('缓存时长：读到空 token 只缓存 2s，别的号干脆不缓存', () => {
  assert.ok(liveTokenCacheTtl({ adopt: false, reason: 'too-short' }) <= 2_000)
  assert.equal(liveTokenCacheTtl({ adopt: false, reason: 'other-account' }), 0)
  assert.ok(liveTokenCacheTtl({ adopt: true }) >= 30_000)
})

await testAsync('★ 页面还没就绪（空 token）⇒ 3 秒后必须重新读并自愈，别等 30 秒', async () => {
  resetLiveTokenCacheForTest()
  let now = 1_000_000
  let reads = 0
  const deps = {
    readPageToken: async () => (++reads === 1 ? '' : PAGE),
    listAccounts: () => [{ id: 'A', token: STORED }],
    updateAccount: () => {},
    now: () => now,
  }
  const first = await withLiveToken({ token: STORED }, deps)
  assert.equal(first.token, STORED, '第一次页面还没就绪，只能用手里那份')
  now += 1_000
  assert.equal((await withLiveToken({ token: STORED }, deps)).token, STORED, '2s 内仍用短缓存（别每个请求都读 CDP）')
  now += 2_000
  assert.equal(
    (await withLiveToken({ token: STORED }, deps)).token,
    PAGE,
    '★ 空 token 被缓存了 30s ⇒ 页面就绪后还得再等 27 秒才自愈',
  )
})

await testAsync('★ 采纳 token 落盘失败必须留痕（旧实现空 catch 吞掉）', async () => {
  resetLiveTokenCacheForTest()
  const file = liveTokenDiagnosticsPath()
  rmSync(file, { force: true })
  const out = await withLiveToken(
    { token: STORED },
    {
      readPageToken: async () => PAGE,
      listAccounts: () => [{ id: 'A', token: STORED }],
      updateAccount: () => {
        throw new Error('EACCES: read-only')
      },
      now: () => 2_000_000,
    },
  )
  assert.equal(out.token, PAGE, '落盘失败不影响本次请求')
  assert.ok(existsSync(file), '落盘失败没有留痕 ⇒ 下次启动仍用旧 token 且无从排查')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /persist-failed/)
  assert.match(text, /EACCES/)
})

await testAsync('★ readPageUserToken：CDP 先返回时要清掉超时定时器', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let target
  let cleared = false
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = realSetTimeout(fn, ms, ...rest)
    if (ms === 50) target = timer
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (timer === target) cleared = true
    return realClearTimeout(timer)
  }
  try {
    const { readPageUserToken } = await import('../src/browser-transport.ts')
    // 没有传输层会话 ⇒ readTransportPageState 立刻返回 null，走 Promise.race 的"CDP 先返回"分支
    assert.equal(await readPageUserToken(50), '')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  assert.ok(cleared, '★ CDP 先返回后没有 clearTimeout（旧实现只靠 unref 兜着）')
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
