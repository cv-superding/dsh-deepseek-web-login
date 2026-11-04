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
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-live-token-'))

const { decideLiveToken, freshAuthFailure } = await import('../src/webapi.ts')

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

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
