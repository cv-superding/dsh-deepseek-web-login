/**
 * 回归：「登录新账号（添加）」的添加模式（account-add.ts）。
 *
 * 为什么值得单独守：这个功能的**全部风险**都集中在两个状态机上，而它们出错时不会报错、
 * 只会"行为不对"，非常难查：
 *
 *  1) **必须一次有效**。添加模式若泄漏到后面某次无关的捕获上，用户下次正常登录会
 *     莫名其妙"进了库却没切换"，而且没有任何提示能指向这里。
 *  2) **必须不切换当前账号**。这是用户明确要的行为（"不要自动切到新账号"）。
 *     一旦退化成 writeAuth()，正在用的号就被顶掉了 —— 功能看着"能用"，但完全违背意图。
 *  3) **有期限**。登录窗口可能被丢在那儿不管；十几年后随手粘个 token 不该被这个标志影响。
 *  4) **边界**：库里本来没有当前账号时，反而**应该**设为当前 —— 否则留下
 *     "库里有账号却没选中"的僵局，用户点哪儿都不对。
 *
 * 用法: node tests/check-account-add.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-addacct-'))
process.env.DSH_HOME = HOME

const { activeAccountId, activeAccount, listAccounts, readAccount, removeAccount, updateAccount } =
  await import('../src/accounts.ts')
const { readAuth } = await import('../src/auth.ts')
const {
  ADD_MODE_TTL_MS,
  RELOGIN_TTL_MS,
  addModeActive,
  beginAddAccount,
  beginRelogin,
  commitCapturedAuth,
  endAddAccount,
  endRelogin,
  pendingReloginTarget,
} = await import('../src/account-add.ts')

let passed = 0
const failures = []
function run(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const makeAuth = (token) => ({
  token,
  cookie: `ds_session_id=${token.slice(0, 4)}`,
  hifDliq: '',
  hifLeim: '',
  wasmUrl: 'https://example.com/sha3.wasm',
  userAgent: 'ua',
  capturedAt: new Date().toISOString(),
})

/** 每个用例都从干净状态开始：清空账号库。 */
function reset() {
  for (const item of listAccounts()) removeAccount(item.id)
  endAddAccount()
  endRelogin()
}
reset()

// ── 标志本身 ────────────────────────────────────────────────────────────
run('默认不在添加模式', () => {
  reset()
  assert.equal(addModeActive(), false)
})

run('beginAddAccount 之后进入添加模式', () => {
  reset()
  beginAddAccount()
  assert.equal(addModeActive(), true)
})

run('超过 TTL 自动失效（登录窗口被丢着不管的情况）', () => {
  reset()
  const t0 = 1_000_000
  beginAddAccount(t0)
  assert.equal(addModeActive(t0 + ADD_MODE_TTL_MS), true, '刚好到期限仍算有效')
  assert.equal(addModeActive(t0 + ADD_MODE_TTL_MS + 1), false, '超过一秒就该失效')
  assert.equal(addModeActive(t0 + ADD_MODE_TTL_MS + 1), false, '失效是稳定状态，不会又变回 true')
})

run('endAddAccount 立刻清掉', () => {
  reset()
  beginAddAccount()
  endAddAccount()
  assert.equal(addModeActive(), false)
})

// ── 默认语义：写入并设为当前（不能因为加了新功能就改坏老行为）────────────
run('非添加模式：写入并设为当前（老行为不变）', () => {
  reset()
  const result = commitCapturedAuth(makeAuth('tok-a'))
  assert.equal(result.mode, 'switch')
  assert.equal(result.created, undefined, 'switch 模式不该有 created 字段')
  assert.equal(activeAccount()?.token, 'tok-a')
  assert.equal(listAccounts().length, 1)
})

run('非添加模式连续写两个：第二个成为当前，两个都在库里', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-a'))
  commitCapturedAuth(makeAuth('tok-b'))
  assert.equal(activeAccount()?.token, 'tok-b')
  assert.equal(listAccounts().length, 2)
})

// ── 添加模式：入库但不切换 ──────────────────────────────────────────────
run('添加模式：新账号入库，但当前账号原样不动', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))
  const before = activeAccountId()

  beginAddAccount()
  const result = commitCapturedAuth(makeAuth('tok-new'))
  assert.equal(result.mode, 'add')
  assert.equal(result.created, true, '这是个新账号')
  assert.equal(activeAccountId(), before, '当前账号绝不能被动过')
  assert.equal(activeAccount()?.token, 'tok-current', '当前账号仍是原来那个')
  assert.deepEqual(
    listAccounts().map((item) => item.token).sort(),
    ['tok-current', 'tok-new'],
    '新账号确实进了库',
  )
})

run('添加模式里读到的是"入库后的库"（readAuth 仍指向当前账号）', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))
  beginAddAccount()
  commitCapturedAuth(makeAuth('tok-new'))
  assert.equal(readAuth()?.token, 'tok-current', 'readAuth() 是"当前生效"的口子，不该被添加模式改到')
})

run('添加模式：库里已有的账号 → created=false，且依然不切换', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))
  beginAddAccount()
  const again = commitCapturedAuth(makeAuth('tok-current'))
  assert.equal(again.mode, 'add')
  assert.equal(again.created, false, '库里本来就有，不算新增')
  assert.equal(listAccounts().length, 1, '不该多出一条')
  assert.equal(activeAccount()?.token, 'tok-current')
})

run('添加模式：往空库里加（没有任何当前账号）→ 反而应该设为当前', () => {
  reset()
  assert.equal(activeAccountId(), undefined, '前置：库里没有当前账号')
  beginAddAccount()
  commitCapturedAuth(makeAuth('tok-first'))
  assert.equal(activeAccountId(), activeAccount()?.id, '不该留下"有账号却没选中"的僵局')
  assert.equal(activeAccount()?.token, 'tok-first')
})

// ── 一次有效（最容易踩的坑）──────────────────────────────────────────────
run('添加模式只生效一次：紧接着的第二次捕获回到"切换"语义', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))

  beginAddAccount()
  const first = commitCapturedAuth(makeAuth('tok-new'))
  const second = commitCapturedAuth(makeAuth('tok-third'))

  assert.equal(first.mode, 'add', '第一次是添加')
  assert.equal(second.mode, 'switch', '第二次必须回到默认语义 —— 标志没被消费掉就会漏到别处')
  assert.equal(addModeActive(), false, '用掉之后标志必须清掉')
  assert.equal(activeAccount()?.token, 'tok-third')
})

run('失败/取消也要消费掉标志（否则会泄漏到后面某次登录）', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))
  beginAddAccount()
  // 模拟"用户点了登录新账号，但登录窗口里啥也没干就关了"：
  // 调用方至少要能显式清掉它（面板在退出/切换时也会清）
  endAddAccount()
  assert.equal(addModeActive(), false)
  const next = commitCapturedAuth(makeAuth('tok-next'))
  assert.equal(next.mode, 'switch', '之后那次登录必须是正常切换')
  assert.equal(activeAccount()?.token, 'tok-next')
})

run('反复进出添加模式不会串味', () => {
  reset()
  commitCapturedAuth(makeAuth('tok-current'))
  for (let i = 0; i < 3; i += 1) {
    beginAddAccount()
    assert.equal(commitCapturedAuth(makeAuth(`tok-add-${i}`)).mode, 'add')
    assert.equal(activeAccount()?.token, 'tok-current', `第 ${i} 轮后当前账号不该变`)
  }
  assert.equal(listAccounts().length, 4, '当前 1 个 + 添加 3 个')
})

// ── 重新登录：原地更新（0.1.65，用户实测反馈）────────────────────────────
// 用户点「重新登录这个账号」→ 重登成功 → 库里**多出一条同名账号**、旧那条还挂着
// 「需要重新登录」。根因两层：① relogin 没记住"要更新哪条记录"；
// ② 捕获时只有 token/cookie、没有身份，靠 serverId/token 去重都命中不了（重登必然换 token）。

run('重新登录：凭证原地写回同一条记录，不新增、不切换当前账号', () => {
  reset()
  const current = commitCapturedAuth(makeAuth('tok-current'))
  beginAddAccount()
  const other = commitCapturedAuth(makeAuth('tok-other'))
  assert.equal(activeAccount()?.token, 'tok-current', '自证：当前账号是 current')
  const before = listAccounts().length

  updateAccount(other.recordId, {
    lastVerifyError: { at: new Date().toISOString(), message: 'Authorization Failed (invalid token)' },
  })
  assert.ok(readAccount(other.recordId).lastVerifyError, '自证：那条记录确实处于失败态')

  beginRelogin(other.recordId)
  const commit = commitCapturedAuth(makeAuth('tok-reborn'))

  assert.equal(commit.mode, 'relogin')
  assert.equal(commit.recordId, other.recordId, '必须写回同一条记录')
  assert.equal(listAccounts().length, before, '不能新增记录 —— 这就是用户看到"俩137"的原因')
  assert.equal(readAccount(other.recordId).token, 'tok-reborn', '凭证要更新成新的')
  assert.equal(readAccount(other.recordId).lastVerifyError, undefined, '旧失败标记必须清掉，否则会一直显示"需要重新登录"')
  assert.equal(activeAccount()?.token, 'tok-current', '当前账号不能变')
})

run('重新登录：认得出是另一个号 → 不覆盖，放行成普通捕获', () => {
  reset()
  const target = commitCapturedAuth(makeAuth('tok-a'))
  updateAccount(target.recordId, { serverId: 'user-1' })
  beginRelogin(target.recordId)
  const commit = commitCapturedAuth({ ...makeAuth('tok-b'), serverId: 'user-2' })
  assert.notEqual(commit.mode, 'relogin', '明确是另一个号，不能原地覆盖')
  assert.equal(readAccount(target.recordId).token, 'tok-a', '被指向的那条不能被改')
})

run('重新登录：认不出身份时按"就是它"处理（捕获只有 token/cookie 的常态）', () => {
  reset()
  const target = commitCapturedAuth(makeAuth('tok-a'))
  beginRelogin(target.recordId)
  const commit = commitCapturedAuth(makeAuth('tok-a-new'))
  assert.equal(commit.mode, 'relogin')
  assert.equal(readAccount(target.recordId).token, 'tok-a-new')
})

run('重新登录：浏览器沿用原会话（token 没变）时，旧的失败标记同样要清掉', () => {
  // 这条专门盯"清失败标记"那一步（反向验证发现：token 变了的话，upsertAccount 找不到 existing、
  // 压根不会把 lastVerifyError 带过来 —— 于是那条用例对"清除"这一步是没有牙齿的）。
  // token 没变时它会按 token 命中已有记录，把 lastVerifyError 一起 inherit 过来；
  // 没有显式清除的话，这条记录会一直挂着「需要重新登录」（用户实测："重登了怎么还报错"）。
  reset()
  const target = commitCapturedAuth(makeAuth('tok-same'))
  updateAccount(target.recordId, {
    lastVerifyError: { at: new Date().toISOString(), message: 'Authorization Failed (invalid token)' },
  })
  assert.ok(readAccount(target.recordId).lastVerifyError, '自证：先让它处于失败态')
  beginRelogin(target.recordId)
  const commit = commitCapturedAuth(makeAuth('tok-same'))
  assert.equal(commit.mode, 'relogin')
  assert.equal(readAccount(target.recordId).lastVerifyError, undefined, 'token 没变也必须清掉旧的失败标记')
})

run('重新登录：意图有期限（超时就不生效）', () => {
  reset()
  const target = commitCapturedAuth(makeAuth('tok-a'))
  const t0 = Date.now()
  beginRelogin(target.recordId, t0)
  assert.equal(pendingReloginTarget(t0 + RELOGIN_TTL_MS - 1), target.recordId, 'TTL 内有效')
  const commit = commitCapturedAuth(makeAuth('tok-a2'), t0 + RELOGIN_TTL_MS + 1)
  assert.notEqual(commit.mode, 'relogin')
  assert.equal(pendingReloginTarget(t0 + RELOGIN_TTL_MS + 1), undefined, '超时后自行清除')
})

run('重新登录：意图只用一次', () => {
  reset()
  const target = commitCapturedAuth(makeAuth('tok-a'))
  beginRelogin(target.recordId)
  assert.equal(commitCapturedAuth(makeAuth('tok-a2')).mode, 'relogin')
  assert.equal(pendingReloginTarget(), undefined, '用掉就该没了')
  assert.notEqual(commitCapturedAuth(makeAuth('tok-a3')).mode, 'relogin', '第二次捕获不该再原地更新')
})

run('重新登录：目标记录已被移除 → 放行成普通捕获（不凭空写回）', () => {
  reset()
  const target = commitCapturedAuth(makeAuth('tok-a'))
  const id = target.recordId
  beginRelogin(id)
  removeAccount(id)
  const commit = commitCapturedAuth(makeAuth('tok-a2'))
  assert.notEqual(commit.mode, 'relogin')
  assert.equal(readAccount(id), undefined)
})

run('重新登录意图与添加模式互不干扰（同时挂着时，重新登录优先）', () => {
  reset()
  const current = commitCapturedAuth(makeAuth('tok-current'))
  beginAddAccount()
  const other = commitCapturedAuth(makeAuth('tok-other'))
  beginAddAccount()
  beginRelogin(other.recordId)
  const commit = commitCapturedAuth(makeAuth('tok-reborn'))
  assert.equal(commit.mode, 'relogin', '重新登录意图优先于添加模式')
  assert.equal(activeAccount()?.token, 'tok-current')
  assert.equal(listAccounts().length, 2, '不该多出记录')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
rmSync(HOME, { recursive: true, force: true })
