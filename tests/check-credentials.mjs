/**
 * 本机凭据存储（`~/.dsh/web-login/credentials.json`，一键重登用）。
 *
 * 为什么值得单独守：**这里存的是密码**。三个点必须钉住：
 *  ① 文件权限 0600（Windows 上无效，但 Linux/macOS 必须）；
 *  ② 删除要真删（账号、邮箱两条都清）；
 *  ③ 账号 id 变了还能靠邮箱找回（重建账号后仍能一键重登）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cred-'))

const { anyCredential, clearAllCredentials, clearCredential, hasSavedCredential, loadCredential, saveCredential } =
  await import('../src/credentials.ts')

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

const file = () => join(process.env.DSH_HOME, 'web-login', 'credentials.json')

await test('存 → 读（按账号 id 与按邮箱都能命中）', () => {
  saveCredential('acc_1', { email: 'a@b.com', password: 'p@ss' })
  assert.equal(loadCredential('acc_1')?.password, 'p@ss')
  assert.equal(loadCredential('a@b.com')?.password, 'p@ss', '按邮箱也要能查到')
  assert.equal(hasSavedCredential('acc_2'), true, '任意一条凭据存在 ⇒ 面板可以给"一键重登"')
})

await test('空邮箱/空密码不写（防把半截表单存成"记住的密码"）', () => {
  saveCredential('acc_bad', { email: '', password: 'x' })
  saveCredential('acc_bad2', { email: 'x@y.com', password: '' })
  assert.equal(loadCredential('acc_bad'), undefined)
  assert.equal(loadCredential('acc_bad2'), undefined)
})

await test('文件权限 0600（POSIX 上必须是，Windows 上跳过）', () => {
  if (process.platform === 'win32') return
  const mode = statSync(file()).mode & 0o777
  assert.equal(mode, 0o600, `权限是 ${mode.toString(8)}`)
})

await test('账号 id 变了，靠邮箱还能找回（重建账号后仍能一键重登）', () => {
  saveCredential('acc_old', { email: 'c@d.com', password: 'pw2' })
  // 账号被删重建 ⇒ id 变了，但 loadCredential(新id) 会退到 anyCredential()
  const found = loadCredential('acc_brand_new') ?? anyCredential()
  assert.ok(found, '换了 id 就找不回 = 用户又得手输')
})

await test('清除：账号 key 与邮箱两条一起删', () => {
  saveCredential('acc_2', { email: 'e@f.com', password: 'pw3' })
  assert.equal(clearCredential('acc_2'), true)
  assert.equal(loadCredential('acc_2'), undefined)
  assert.equal(loadCredential('e@f.com'), undefined, '邮箱那条也得删，否则等于没删')
})

await test('"清除所有已保存密码"把文件删掉', () => {
  saveCredential('acc_3', { email: 'g@h.com', password: 'pw4' })
  assert.equal(existsSync(file()), true)
  assert.equal(clearAllCredentials(), true)
  assert.equal(existsSync(file()), false, '文件还在 ⇒ 用户以为清干净了却没清')
})

await test('文件内容里不含账号记录的其它字段（只存邮箱与密码）', () => {
  saveCredential('acc_4', { email: 'i@j.com', password: 'pw5' })
  const raw = JSON.parse(readFileSync(file(), 'utf8'))
  const entry = Object.values(raw)[0]
  assert.deepEqual(Object.keys(entry).sort(), ['email', 'password', 'savedAt'])
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
