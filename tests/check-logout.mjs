/**
 * 回归：退出当前账号（面板「退出当前账号」/「退出并登录其它账号」背后的行为）。
 *
 * 背景（2026-09-11 用户反馈「怎么没有退出当前账号功能」）：
 *  1) 退出按钮以前只塞在「手动粘贴 Token」卡的角落里 → 找不到（已提到独立的「当前账号」卡）；
 *  2) 旧实现只删本地凭证，**不清浏览器分区** → 点「从已登录窗口恢复」会把同一个账号原样抓回来，
 *     「浏览器窗口登录」打开的也是已登录页面，根本换不了号；
 *  3) 旧实现卸载插件时调用 logout() → 热重载一下就被登出了（现在改为只关窗口）。
 *
 * 0.1.26 起：存储层从「单文件 deepseek-auth.json」换成「账号库 accounts/<id>.json」，
 * 本测试同步改为断言"账号文件被删掉 + 当前指针被清掉"，语义不变（登出就要真的登出）。
 *
 * 用法: node tests/check-logout.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dswl-logout-'))
process.env.DSH_HOME = home

const { readAuth, writeAuth } = await import('../src/auth.ts')
// 存储层已从「单文件」换成「账号库」，所以这里查的是账号文件而不是固定的 authFilePath
const { accountFilePath, activeAccountId, listAccounts } = await import('../src/accounts.ts')
const { closeLoginWindow, clearLoginPartition, getLastLoginResult, logout } = await import('../src/login.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

function seedAuth() {
  writeAuth({
    token: 't'.repeat(64),
    cookie: 'ds_session_id=abc',
    hifDliq: '',
    hifLeim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
    userAgent: 'ua',
    capturedAt: new Date().toISOString(),
  })
}

await test('前提：凭证能写入并能读回（且进入账号库）', async () => {
  seedAuth()
  assert.equal(readAuth()?.token, 't'.repeat(64))
  const stored = listAccounts()
  assert.equal(stored.length, 1, '写入后账号库应恰好有一条')
  assert.ok(existsSync(accountFilePath(stored[0].id)), '账号文件应落盘')
})

await test('非 Electron 环境：分区清理返回 false（不抛错）', async () => {
  assert.equal(await clearLoginPartition(), false)
})

await test('关闭登录窗口不得删除凭证（卸载/热重载不等于登出）', async () => {
  closeLoginWindow()
  assert.equal(readAuth()?.token, 't'.repeat(64), 'closeLoginWindow 只关窗口')
})

await test('logout()：删凭证 + 清浏览器登录 profile，并留下可读的最近结果', async () => {
  seedAuth()
  // 浏览器登录用的独立 profile 也是一个「登录态存放处」：
  // 退出必须一起清，否则再点登录会直接复用里面的登录态（等于没退出、也没法换号）。
  const profileDir = join(home, 'web-login', 'browser-profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'marker.txt'), 'fake-login-state')

  const doomedId = listAccounts()[0].id
  const cleared = await logout()
  assert.equal(cleared, true, '本环境没有 Electron 分区，但浏览器 profile 应被清掉 → true')
  assert.ok(!readAuth()?.token, '凭证必须被删除')
  assert.ok(!existsSync(accountFilePath(doomedId)), '账号文件必须被删除，而不只是清空内容')
  assert.equal(listAccounts().length, 0, '账号库里不该再残留这条')
  assert.equal(activeAccountId(), undefined, '当前指针必须清掉（否则会指向悬空账号）')
  assert.ok(!existsSync(profileDir), '浏览器登录 profile 必须被删除（否则换号会复用旧登录态）')
  const result = getLastLoginResult()
  assert.ok(result && /退出/.test(result.message), `最近结果应说明已退出：${JSON.stringify(result)}`)
})

await test('logout() 幂等：没登录时调用也不得抛错', async () => {
  const first = await logout()
  const second = await logout()
  assert.equal(typeof first, 'boolean')
  assert.equal(typeof second, 'boolean')
  assert.ok(!readAuth()?.token)
})

await test('logout() 后「账号」维度确实是空的（无从恢复旧账号）', async () => {
  assert.equal(readAuth(), undefined, 'readAuth 必须返回 undefined，而不是残留对象')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
rmSync(home, { recursive: true, force: true })
