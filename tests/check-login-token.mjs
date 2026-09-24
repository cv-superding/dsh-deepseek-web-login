/**
 * 手动粘贴 token 的 fail-closed 判据（R8，0.1.84）。
 *
 * 背景：旧写法 `unwrapStoredToken(token) || String(token).trim()` 是 fail-open ——
 * 用户把 localStorage 原文（包装 JSON）粘进来、unwrap 解出空时，**整段 JSON 被当 token**：
 * 一个 >8 字符的 JSON 文本轻松过长度检查，垃圾凭证入库（标着 unverified，界面显示一个永远
 * 校验不过的"账号"）。
 *
 * 现在：输入是包装 JSON（以 `{` 开头）但 unwrap 解出空 ⇒ 明确拒绝，提示怎么改。
 * 裸 token 行为完全不变。
 *
 * ⚠️ 这三个用例都**不会发出网络请求**：fail-closed 与长度检查都在 validateAuth 之前返回。
 *
 * 用法: node tests/check-login-token.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-token-'))
process.env.DSH_HOME = HOME

const { loginWithToken } = await import('../src/login.ts')

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

console.log('手动粘贴 token（R8 fail-closed）：')

await test('包装 JSON 但 value 为 null ⇒ 拒绝（不把 JSON 当 token 落盘）', async () => {
  const r = await loginWithToken('{"value":null,"expires":1234567890}')
  assert.equal(r.ok, false, '必须拒绝')
  assert.ok(String(r.error).includes('包装 JSON'), `error 应提示包装 JSON，实际: ${r.error}`)
})

await test('坏 JSON（截断的包装）⇒ 同样拒绝', async () => {
  const r = await loginWithToken('{"value":"abc')
  assert.equal(r.ok, false, '必须拒绝')
  assert.ok(String(r.error).includes('包装 JSON'), `error 应提示包装 JSON，实际: ${r.error}`)
})

await test('裸短串（非 JSON）⇒ 走原路径报「太短」，不 fail-closed', async () => {
  const r = await loginWithToken('short')
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('太短'), `裸 token 应报「太短」，实际: ${r.error}`)
})

await test('包装 JSON 且 value 非空 ⇒ unwrap 出真 token（fail-closed 只拦解出空的）', async () => {
  // unwrap 语义本身不变：解得出值的包装 JSON 与裸 token 走同一条旧路径。
  const { unwrapStoredToken } = await import('../src/auth.ts')
  assert.equal(unwrapStoredToken('{"value":"real-token-123","x":1}'), 'real-token-123')
  assert.equal(unwrapStoredToken('bare-token-abc'), 'bare-token-abc')
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
