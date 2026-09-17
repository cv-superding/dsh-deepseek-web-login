/**
 * 「登录前按需清理登录态」的用例（A 方案）。
 *
 * 背景：四个登录入口里，客户端那个「用 Microsoft Edge 登录」主按钮此前是**裸的** ——
 * 独立 profile（`<DSH_HOME>/web-login/browser-profile`）里若还留着上次那个账号的登录态，
 * Edge 一打开就是已登录，用户以为在登录、抓回来的却是旧号。
 * 现在它带 `fresh: true`，由 `/login/browser` 先清。
 *
 * ⚠️⚠️ **必须先把 `DSH_HOME` 指到临时目录、再 import** —— `DEFAULT_PROFILE_DIR` 是在模块
 * 加载时求值的，而本文件会**不带参数**调一次 `clearLoginState()`（那正是要测的默认路径）。
 * 指错了就等于删掉真实的登录态。
 *
 * ⚠️ 本机（WorkBuddy 沙箱）对"批量删除"有拦截器，但这里只删 1~2 个文件的小目录，
 * 不触发批量阈值 —— 所以能真实断言"目录真的没了"。
 *
 * 用法: node tests/check-login-fresh.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-fresh-'))
process.env.DSH_HOME = HOME

const { clearLoginState } = await import('../src/login.ts')

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

/** 造一个"像登录 profile"的小目录（1 个文件，不触发本机批量删除拦截）。 */
function makeProfileDir(dir, marker = 'Cookies') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, marker), 'x')
  return dir
}

const DEFAULT_DIR = join(HOME, 'web-login', 'browser-profile')

console.log('① 自证：默认目录确实落在临时 DSH_HOME 下')

await test('DEFAULT_PROFILE_DIR 跟着 DSH_HOME 走（不然会删到真实登录态）', () => {
  // 造在默认位置 → 证明它确实在临时 HOME 里，而不是真实 ~/.dsh
  const dir = makeProfileDir(DEFAULT_DIR)
  assert.ok(existsSync(dir), '自证：默认 profile 目录造出来了')
  assert.ok(
    dir.startsWith(HOME),
    `默认目录必须在临时 HOME 下，实际 ${dir}（HOME=${HOME}）—— 否则下面那条会删到真实登录态`,
  )
})

console.log('② 不带参数调用 = 清默认目录（主按钮与「登录新账号」走的都是这条）')

await test('clearLoginState() 删掉默认 profile 目录', async () => {
  assert.ok(existsSync(DEFAULT_DIR), '自证：调用前目录在（否则这条断言没有意义）')
  const result = await clearLoginState()
  assert.equal(result.profileCleared, true, '应当报告"已清掉 profile"')
  assert.equal(existsSync(DEFAULT_DIR), false, '调用后目录必须消失')
})

await test('返回值结构固定为两个 boolean', async () => {
  const result = await clearLoginState()
  assert.equal(typeof result.profileCleared, 'boolean')
  assert.equal(typeof result.partitionCleared, 'boolean')
  // 非 Electron 主进程环境拿不到 session ⇒ 只可能是 false，不该抛
  assert.equal(result.partitionCleared, false, '测试环境没有 electron session，应为 false')
})

console.log('③ 目录不存在时：幂等（force:true 语义），不抛')

await test('未登录过（目录不存在）→ 不抛，且报 true（"已经干净"也算清好了）', async () => {
  const dir = join(HOME, 'never-created-profile')
  assert.equal(existsSync(dir), false, '自证：这个目录确实不存在')
  // ⚠️ 这里刻意断言 true —— 实现用的是 `rmSync(..., {force:true})`：目录不存在**也不抛**，
  // 于是报"已清"。语义是"清干净了"（不在 = 已经干净），不是"这次真的删了东西"。
  // （第一版我按"没删到就该报 false"写，跑出来才回头读实现 —— 断言要跟着语义走。）
  const result = await clearLoginState({ profileDir: dir })
  assert.equal(result.profileCleared, true, 'force:true ⇒ 目录不在也视为清好了')
})

console.log('④ 显式 profileDir（可注入，便于测试与将来复用）')

await test('传 profileDir 时只清那一个目录', async () => {
  const other = makeProfileDir(join(HOME, 'another-profile'), 'Login Data')
  const result = await clearLoginState({ profileDir: other })
  assert.equal(result.profileCleared, true)
  assert.equal(existsSync(other), false, '指定目录应当被清掉')
})

console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败：`)
  for (const f of failures) console.log('   - ' + f)
  process.exitCode = 1
} else {
  console.log(`通过 ${passed} 项，全部通过 ✅`)
}
