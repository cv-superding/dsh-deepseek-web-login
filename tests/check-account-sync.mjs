/**
 * 回归：账号库的自动同步节拍与内容签名（0.1.67）。
 *
 * 背景：用户反馈「新登录一个账号后，账号库列表不会自己更新，要关掉设置页再打开才看到」。
 * 根因是列表**不在 `/status` 里**，只有 `loadAccounts()` 被显式调用时才重读；
 * 而登录捕获是异步落地的（CDP 那条路要等用户在浏览器里登录完），
 * 捕获晚一步列表就停在旧快照上 —— 客户端里那句"万一捕获是异步落地的也能及时刷出来"
 * 的注释说明作者本来就想靠轮询兜住，但轮询只读 `/status`，兜底从未生效。
 *
 * 本文件守两件纯逻辑：
 *  1) 什么时候该重读（登录流程中要快、空闲可以慢）；
 *  2) 什么算"内容变了"（变了才重建 DOM —— 每 3 秒无脑重建会把用户正在点的按钮换掉）。
 * 接线由 check-bundle.mjs 的产物断言守。
 *
 * 用法: node tests/check-account-sync.mjs
 */
import assert from 'node:assert/strict'
import {
  ACCOUNTS_SYNC_ACTIVE_MS,
  ACCOUNTS_SYNC_IDLE_MS,
  accountsSignature,
  shouldSyncAccounts,
} from '../src/account-sync.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const acc = (id, extra = {}) => ({
  id,
  title: `title-${id}`,
  display: `d***${id}`,
  label: '',
  unverified: false,
  capturedAt: '2026-09-15T07:44:00.783Z',
  lastVerifiedAt: '2026-09-15T08:21:11.000Z',
  lastVerifyError: null,
  limit: null,
  cookieMeta: [],
  isActive: false,
  ...extra,
})

const payload = (accounts, activeId = 'a') => ({ activeId, accounts, footprint: { count: accounts.length, bytes: 1234 } })

// ── 节拍 ────────────────────────────────────────────────────────────────

test('登录流程进行中：3 秒一次（捕获一落地就能看见）', () => {
  assert.equal(shouldSyncAccounts(1_000, 0, true), false, '距上次不足 3 秒不该重读')
  assert.equal(shouldSyncAccounts(ACCOUNTS_SYNC_ACTIVE_MS - 1, 0, true), false)
  assert.equal(shouldSyncAccounts(ACCOUNTS_SYNC_ACTIVE_MS, 0, true), true, '刚好到点就该读')
  assert.equal(shouldSyncAccounts(ACCOUNTS_SYNC_ACTIVE_MS + 1, 0, true), true)
})

test('空闲时：30 秒一次（够让探活补上的账号名自己出现，又不必一直读盘）', () => {
  let count = 0
  for (let n = 1; n < ACCOUNTS_SYNC_IDLE_MS; n *= 2) {
    if (shouldSyncAccounts(n, 0, false)) count += 1
  }
  assert.equal(count, 0, '30 秒内一次都不该读')
  assert.equal(shouldSyncAccounts(ACCOUNTS_SYNC_IDLE_MS, 0, false), true)
})

test('空闲节拍明显慢于登录节拍（别把兜底变成每 2 秒读盘）', () => {
  assert.ok(ACCOUNTS_SYNC_IDLE_MS > ACCOUNTS_SYNC_ACTIVE_MS * 5, '空闲间隔应远大于登录中')
})

test('从未同步过（lastSyncedAt=0）且时间已过门槛 → 该读', () => {
  assert.equal(shouldSyncAccounts(ACCOUNTS_SYNC_IDLE_MS, 0, false), true)
})

// ── 签名 ────────────────────────────────────────────────────────────────

test('同一份内容 → 同一签名（否则会每轮无脑重建列表）', () => {
  const data = payload([acc('a'), acc('b')])
  assert.equal(accountsSignature(data), accountsSignature(payload([acc('a'), acc('b')])))
  assert.ok(accountsSignature(data).length > 0, '自证：签名不是空串')
})

test('新增账号 → 签名变化（这是本次要修的主场景）', () => {
  const before = accountsSignature(payload([acc('a')]))
  const after = accountsSignature(payload([acc('a'), acc('b')]))
  assert.notEqual(before, after)
})

test('探活补上的字段（账号名 / 限制 / 失败标记）都算变化', () => {
  const base = payload([acc('a')])
  const renamed = payload([acc('a', { title: '192******27' })])
  const limited = payload([acc('a', { limit: { untilMs: 1789000000000 } })])
  const failed = payload([acc('a', { lastVerifyError: { at: 1, message: 'Authorization Failed' } })])
  const neverVerified = payload([acc('a', { lastVerifiedAt: null })])
  for (const [label, other] of [
    ['账号名', renamed],
    ['限制状态', limited],
    ['失败标记', failed],
    ['校验时间', neverVerified],
  ]) {
    assert.notEqual(accountsSignature(base), accountsSignature(other), `${label}变了，签名必须跟着变`)
  }
})

test('切换当前账号 → 签名变化（否则「当前」徽章不会挪）', () => {
  const accounts = [acc('a'), acc('b')]
  assert.notEqual(
    accountsSignature(payload(accounts, 'a')),
    accountsSignature(payload(accounts, 'b')),
  )
})

test('顺序变化 → 签名变化（列表顺序就是显示顺序）', () => {
  assert.notEqual(
    accountsSignature(payload([acc('a'), acc('b')])),
    accountsSignature(payload([acc('b'), acc('a')])),
  )
})

test('footprint 不算内容 —— 它是台账页的统计，不该触发列表重建', () => {
  const accounts = [acc('a')]
  const a = accountsSignature({ activeId: 'a', accounts, footprint: { count: 1, bytes: 100 } })
  const b = accountsSignature({ activeId: 'a', accounts, footprint: { count: 9, bytes: 999_999 } })
  assert.equal(a, b, '自证：footprint 确实被排除了（改了它签名不变）')
})

test('响应畸形时给空串（调用方约定：空签名 = 每次都重建，宁可重建也别卡住不更新）', () => {
  assert.equal(accountsSignature(undefined), accountsSignature({ activeId: null, accounts: [] }))
  assert.equal(accountsSignature({ accounts: 'not-an-array' }), accountsSignature({ activeId: null, accounts: [] }))
})

test('循环引用不抛错（返回空串而不是把面板搞崩）', () => {
  const cyc = { activeId: 'a', accounts: [] }
  cyc.self = cyc
  assert.doesNotThrow(() => accountsSignature(cyc))
})

console.log(failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const f of failures) console.log(`  - ${f}`)
if (failures.length > 0) process.exitCode = 1
