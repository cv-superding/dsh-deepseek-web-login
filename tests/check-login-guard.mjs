/**
 * 登录熔断（`src/login-guard.ts`）。
 *
 * 现场：站点对**环境**做了限制（"由于违规次数过多，你的账户已被临时停用"），
 * 用户会一直点登录，每点一次都加重判定。这里守三件事：
 *  ① 阈值与时长（3 次→30 分钟，5 次→6 小时）；
 *  ② 成功清零；
 *  ③ 落盘 + 到期自动解锁（重启不忘、也不能永不解除）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-guard-'))

const { canAttemptLogin, loginGuardStatus, recordLoginFailure, recordLoginSuccess } = await import('../src/login-guard.ts')

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

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0)

await test('一开始允许登录', () => {
  recordLoginSuccess()
  assert.equal(canAttemptLogin(T0).allowed, true)
})

await test('连续失败 3 次 ⇒ 冷却 30 分钟，且文案说清"别再点"', () => {
  recordLoginSuccess()
  recordLoginFailure('x', T0)
  recordLoginFailure('x', T0)
  assert.equal(canAttemptLogin(T0).allowed, true, '第 2 次还没到阈值')
  const decision = recordLoginFailure('x', T0)
  assert.equal(decision.allowed, false, '第 3 次该进入冷却')
  assert.equal(decision.waitMinutes, 30)
  assert.match(decision.message ?? '', /冷却/, '必须告诉用户在冷却')
  assert.match(decision.message ?? '', /继续尝试只会加重/, '必须明确劝阻重试')
})

await test('冷却期内不允许；到期自动解锁', () => {
  assert.equal(canAttemptLogin(T0 + 10 * 60_000).allowed, false, '10 分钟后仍在冷却')
  assert.equal(canAttemptLogin(T0 + 31 * 60_000).allowed, true, '31 分钟后应解锁')
})

await test('失败累计到 5 次 ⇒ 冷却 6 小时', () => {
  recordLoginSuccess()
  for (let i = 0; i < 4; i += 1) recordLoginFailure('x', T0)
  const decision = recordLoginFailure('x', T0)
  assert.equal(decision.allowed, false)
  assert.equal(decision.waitMinutes, 360)
})

await test('成功一次 ⇒ 清零（不会带着旧计数继续累加）', () => {
  recordLoginSuccess()
  const status = loginGuardStatus(T0)
  assert.equal(status.failures, 0)
  assert.equal(status.cooling, false)
})

await test('状态落盘（重启后仍记得冷却）', () => {
  recordLoginSuccess()
  for (let i = 0; i < 3; i += 1) recordLoginFailure('x', T0)
  assert.equal(existsSync(join(process.env.DSH_HOME, 'web-login', 'login-guard.json')), true)
  // 同一个进程里"重新读文件"就是重启后的行为
  assert.equal(canAttemptLogin(T0 + 60_000).allowed, false, '重启后不该自动解锁')
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
