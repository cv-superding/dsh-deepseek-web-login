/**
 * 回归：账号库（多账号并存 + 一键切换 + 导入导出 + 旧数据迁移）。
 *
 * 为什么值得单独守：这是"换号"这条路径的唯一事实来源。
 * 出错的方式都很隐蔽 —— 索引指向已删账号（悬空）、同一账号反复捕获后堆出一串重复条目、
 * 登出时只清了指针没删文件（"假登出"）、迁移把旧凭证弄丢。下面逐条钉住。
 *
 * 用法: node tests/check-accounts.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-accounts-'))
process.env.DSH_HOME = HOME

const {
  accountFilePath,
  accountsDir,
  activeAccount,
  activeAccountId,
  exportAccounts,
  importAccounts,
  listAccounts,
  migrateLegacyAuthIfNeeded,
  newAccountId,
  removeAccount,
  setActiveAccount,
  updateAccount,
  upsertAccount,
} = await import('../src/accounts.ts')
const { readAuth, writeAuth } = await import('../src/auth.ts')
const { legacyAuthFilePath } = await import('../src/paths.ts')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

function makeAuth(token, extra = {}) {
  return {
    token,
    cookie: `ds_session_id=${token.slice(0, 4)}`,
    hifDliq: '',
    hifLeim: '',
    wasmUrl: 'https://example.com/sha3.wasm',
    userAgent: 'ua',
    capturedAt: new Date().toISOString(),
    ...extra,
  }
}

/** 清空账号库（逐个删除 + 清指针），便于用例之间互不影响。 */
function resetLibrary() {
  for (const item of listAccounts()) removeAccount(item.id)
  assert.equal(listAccounts().length, 0)
}

test('空库：没有账号，也没有当前指针', () => {
  assert.equal(listAccounts().length, 0)
  assert.equal(activeAccount(), undefined)
  assert.equal(activeAccountId(), undefined)
  assert.equal(readAuth(), undefined)
})

test('writeAuth 写入一条 → 落盘 + 成为当前账号', () => {
  const record = upsertAccount(makeAuth('a'.repeat(64)))
  writeAuth(makeAuth('a'.repeat(64)))
  const all = listAccounts()
  assert.equal(all.length, 1)
  assert.equal(all[0].id, record.id, '同一 token 不该因为 upsert 又多出一条')
  assert.ok(existsSync(accountFilePath(all[0].id)), '账号文件应存在')
  assert.equal(activeAccountId(), all[0].id, 'writeAuth 应把它设为当前')
  assert.equal(readAuth().token, 'a'.repeat(64))
})

test('同一 token 重复写入 → 更新原记录而不是新增（幂等）', () => {
  const before = listAccounts()[0]
  writeAuth(makeAuth('a'.repeat(64), { userAgent: 'ua-2' }))
  const after = listAccounts()
  assert.equal(after.length, 1, '不该堆出重复条目')
  assert.equal(after[0].id, before.id, 'id 应保持不变')
  assert.equal(after[0].userAgent, 'ua-2', '凭证字段应被更新')
})

test('同一个 serverId 换了 token → 仍更新同一条（账号刷新 token 的场景）', () => {
  const id = listAccounts()[0].id
  updateAccount(id, { serverId: 'user-123' })
  writeAuth(makeAuth('b'.repeat(64), { serverId: 'user-123' }))
  const all = listAccounts()
  assert.equal(all.length, 1, 'serverId 相同应视为同一个账号')
  assert.equal(all[0].id, id)
  assert.equal(all[0].token, 'b'.repeat(64), 'token 应被替换')
})

test('不同账号 → 各自一条，且当前指向最新写入的那个', () => {
  writeAuth(makeAuth('c'.repeat(64), { serverId: 'user-456' }))
  const all = listAccounts()
  assert.equal(all.length, 2)
  assert.equal(readAuth().token, 'c'.repeat(64))
})

test('setActiveAccount 切换 → readAuth 跟着换', () => {
  const all = listAccounts()
  const other = all.find((item) => item.token.startsWith('b'))
  assert.equal(setActiveAccount(other.id), true)
  assert.equal(readAuth().token, 'b'.repeat(64), '切过去就该用这一条')
  assert.equal(setActiveAccount('acc_nonexistent'), false, '不存在的 id 不能被设为当前')
  assert.equal(readAuth().token, 'b'.repeat(64), '失败的切换不该改动当前')
})

test('updateAccount 只动元信息，不碰凭证', () => {
  const id = activeAccountId()
  const updated = updateAccount(id, {
    label: '工作号',
    limit: { untilMs: Date.now() + 3600_000, observedAt: new Date().toISOString() },
  })
  assert.equal(updated.label, '工作号')
  assert.ok(updated.limit.untilMs > Date.now())
  assert.equal(updated.token, 'b'.repeat(64), '凭证不该被改')
  assert.equal(updateAccount('acc_nonexistent', { label: 'x' }), undefined)
})

test('upsertAccount 不继承旧凭证字段：unverified 不会粘住', () => {
  writeAuth(makeAuth('d'.repeat(64), { serverId: 'user-789', unverified: true }))
  assert.equal(readAuth().unverified, true, '前提：先落一个 unverified')
  writeAuth(makeAuth('d'.repeat(64), { serverId: 'user-789' }))
  assert.equal(readAuth().unverified, undefined, '同账号重新校验成功后，unverified 必须能清掉')
  // 而元信息要跨次保留
  const id = activeAccountId()
  updateAccount(id, { label: '保留我' })
  writeAuth(makeAuth('d'.repeat(64), { serverId: 'user-789' }))
  assert.equal(readAuth().label, '保留我', '备注名属于元信息，重复写入应保留')
})

test('移除一个非当前账号 → 其它账号不受影响', () => {
  const all = listAccounts()
  const target = all.find((item) => item.id !== activeAccountId())
  assert.equal(removeAccount(target.id), true)
  assert.ok(!existsSync(accountFilePath(target.id)), '凭证文件必须被删除（登出就要真的登出）')
  assert.ok(readAuth()?.token, '当前账号不该被牵连')
  assert.equal(removeAccount(target.id), false, '重复移除应返回 false 而不是抛错')
})

test('移除当前账号 → 当前指针必须清空（不允许悬空）', () => {
  const id = activeAccountId()
  assert.equal(removeAccount(id), true)
  assert.equal(activeAccountId(), undefined)
  assert.equal(activeAccount(), undefined)
  assert.equal(readAuth(), undefined)
})

test('索引指向已删除的账号 → activeAccountId 返回 undefined 而不是悬空 id', () => {
  resetLibrary()
  writeAuth(makeAuth('e'.repeat(64)))
  const id = activeAccountId()
  // 绕过 removeAccount 直接删文件，模拟"手工删了账号文件但索引还在"
  rmSync(accountFilePath(id), { force: true })
  assert.equal(activeAccountId(), undefined, '悬空指针必须被识别为"未选择"')
  assert.equal(readAuth(), undefined, 'readAuth 绝不能返回悬空账号')
})

test('导出/导入往返：凭证与元信息都能带过去', () => {
  resetLibrary()
  writeAuth(makeAuth('f'.repeat(64), { serverId: 'user-abc' }))
  updateAccount(activeAccountId(), { label: '我的号' })
  const payload = exportAccounts()
  assert.equal(payload.accounts.length, 1)
  assert.match(payload.warning, /凭证/, '导出物必须自带风险说明')
  // 序列化一次，模拟真的导入一个外部文件
  const roundTrip = JSON.parse(JSON.stringify(payload))

  resetLibrary()
  const first = importAccounts(roundTrip)
  assert.equal(first.imported, 1)
  assert.equal(first.updated, 0)
  assert.equal(readAuth().token, 'f'.repeat(64), '导入后应自动选中（否则"导入了却未选择账号"很莫名）')
  assert.equal(readAuth().label, '我的号', '元信息应一起带过来')

  // 再导入一次：应按 serverId 命中同一条并更新，不新增
  const second = importAccounts(roundTrip)
  assert.equal(second.imported, 0)
  assert.equal(second.updated, 1)
  assert.equal(listAccounts().length, 1)
})

test('导入会跳过没有 token 的垃圾条目', () => {
  const result = importAccounts({ accounts: [{ label: '没有 token' }, { token: 'g'.repeat(64) }, null] })
  assert.equal(result.skipped, 2)
  assert.equal(result.imported + result.updated, 1)
  assert.equal(importAccounts(undefined).imported, 0, '非法输入不该抛错')
})

test('旧版单账号文件：一次性迁移进库，旧文件改名留档', () => {
  resetLibrary()
  assert.equal(activeAccountId(), undefined)
  const legacy = legacyAuthFilePath()
  mkdirSync(join(legacy, '..'), { recursive: true })
  writeFileSync(legacy, JSON.stringify(makeAuth('h'.repeat(64), { user: { display: 'h***@qq.com' } })), 'utf8')

  const migrated = migrateLegacyAuthIfNeeded()
  assert.ok(migrated, '应迁移出一个账号')
  assert.equal(readAuth().token, 'h'.repeat(64))
  assert.equal(activeAccountId(), migrated.id, '迁移出来的账号应成为当前')
  assert.ok(!existsSync(legacy), '旧文件应被改名（不留在原位，避免与账号库不一致）')
  const archived = readdirSync(join(HOME, 'web-login')).filter((name) => name.startsWith('deepseek-auth.json.migrated-'))
  assert.equal(archived.length, 1, `旧文件应改名留档，实际 ${JSON.stringify(archived)}`)
})

test('迁移不会重复跑（库非空时是 no-op）', () => {
  assert.equal(migrateLegacyAuthIfNeeded(), undefined)
  assert.equal(listAccounts().length, 1, '库内容不该变化')
})

test('账号文件里存的是完整凭证（读回来能直接当 WebAuth 用）', () => {
  const record = listAccounts()[0]
  const onDisk = JSON.parse(readFileSync(accountFilePath(record.id), 'utf8'))
  for (const key of ['token', 'cookie', 'userAgent', 'capturedAt']) {
    assert.equal(typeof onDisk[key], 'string', `落盘文件应含 ${key}`)
  }
  assert.ok(accountsDir().endsWith('accounts'))
  assert.equal(record.id, `acc_${record.id.split('_')[1]}`, 'id 前缀应是 acc_')
  assert.match(randomUUID(), /-/, '随机 id 来源可用（占位断言，确认 crypto 可用）')
})

test('F02：重复写入（覆盖）后文件仍在、内容已更新', () => {
  // 注意：去重键是 serverId，必须显式给，否则两次会落成两条不同记录
  const first = upsertAccount({ token: 't1', cookie: 'c1', userAgent: 'ua', serverId: 'srv-f02a' })
  const file = join(accountsDir(), `${first.id}.json`)
  assert.ok(existsSync(file))
  const second = upsertAccount({ token: 't2', cookie: 'c2', userAgent: 'ua', serverId: 'srv-f02a' })
  assert.equal(second.id, first.id, '同一 serverId 应落到同一条记录')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.token, 't2', '覆盖写入后内容应更新')
})

test('F02：写入失败时原文件必须保留（旧实现先 rmSync，凭证直接丢失）', () => {
  const rec = upsertAccount({ token: 'keep-me', cookie: 'c', userAgent: 'ua', serverId: 'srv-f02b' })
  const file = join(accountsDir(), `${rec.id}.json`)
  assert.ok(existsSync(file))
  // Windows 上 chmod 只读**挡不住** rename 覆盖（实测 rename 照样成功），
  // 改用"持有文件句柄"来让 rename 失败 —— 这是能可靠模拟的方式。
  const fd = openSync(file, 'r')
  let threw = false
  let errCode = ''
  try {
    upsertAccount({ token: 'new', cookie: 'c', userAgent: 'ua', serverId: 'srv-f02b' })
  } catch (error) {
    threw = true
    errCode = String(error?.code ?? error)
  } finally {
    try { closeSync(fd) } catch {}
  }
  assert.ok(threw, `占用目标文件时写入应当失败（错误码 ${errCode}）—— 否则这条用例没测到东西`)
  // 关键断言：失败了，原凭证还在
  assert.ok(existsSync(file), '写入失败后原文件不该消失')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.token, 'keep-me', '原凭证内容必须完好')
  // 也不该留下临时文件
  const leftovers = readdirSync(accountsDir()).filter((n) => n.includes('.tmp-'))
  assert.equal(leftovers.length, 0, `残留临时文件：${leftovers.join(', ')}`)
})

test('F01：账号 id 含路径分隔符/相对路径段一律拒绝（防越界读写）', () => {
  // 旧实现直接 join(accountsDir(), `${id}.json`)，而 importAccounts 会用备份文件里的 id
  for (const bad of ['../../../../Users/me/evil', 'a/b', 'C:/x', '..', '.', '', 'acc_x/../y']) {
    assert.throws(
      () => accountFilePath(bad),
      /账号 id 不合法/,
      `应当拒绝 ${JSON.stringify(bad)}`,
    )
  }
})

test('F01：正常 id 不受影响（别矫枉过正）', () => {
  const file = accountFilePath('acc_ab12cd34')
  assert.ok(file.endsWith(join('accounts', 'acc_ab12cd34.json')), file)
  // 生成的 id 也必须能过校验
  const fresh = newAccountId()
  assert.doesNotThrow(() => accountFilePath(fresh))
  assert.ok(accountFilePath(fresh).startsWith(accountsDir()))
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
rmSync(HOME, { recursive: true, force: true })
