/**
 * `/accounts` 返回的 `sections` 里必须是**可直接渲染的视图**，不能是原始记录。
 *
 * 为什么单独一个文件（2026-09-16，0.1.71 的真实回归）：
 * 0.1.71 把「按组分区」放到宿主算（`partitionByGroup`），但喂进去的是
 * **原始 AccountRecord 数组**。它返回的 `accounts` 会原样交给客户端渲染 ——
 * 于是 `title` / `display` / `isActive` 这些**响应加工字段**全都不在数组里：
 * 面板标题退化成 `acc_97768033`、显示名与「✅ 当前」徽章一起消失。
 *
 * ⚠️ 为什么 `check-account-groups.mjs` 的 17 条抓不到它：
 * 那些是**纯函数**用例，`partitionByGroup` 对"喂原始记录还是喂视图"一视同仁
 * （两者都有 id + groupId）—— 差别只在**接线层**由谁喂。跨层接线只能靠
 * 「真实 apply + 调路由」或产物断言守。
 *
 * 用法: node tests/check-accounts-view.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-acctview-'))
process.env.DSH_HOME = HOME

const { writeAuth } = await import('../src/auth.ts')
const { updateAccount, activeAccountId } = await import('../src/accounts.ts')
const { createGroup, writeGroups, UNGROUPED_KEY } = await import('../src/account-groups.ts')

const API_ACCOUNTS = '/deepseek-web-login/api/accounts'

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

// ── 造数据：两个账号（display 是网页端给的**屏蔽值**，与真实记录同形）+ 一个组 ──
// ⚠️ `writeAuth` 返回 void（它的语义是"写入并设为当前"）⇒ id 只能从 activeAccountId() 取。
writeAuth({ token: 'tk-view-A', cookie: 'c=A', user: { display: '183******78', id: 'u-A' } })
const idA = activeAccountId()
writeAuth({ token: 'tk-view-B', cookie: 'c=B', user: { display: 'lidi*********+mn1@gmail.com', id: 'u-B' } })
const idB = activeAccountId()
assert.ok(idA && idB && idA !== idB, `自证：两个账号都写进了库（${idA} / ${idB}）`)
const created = createGroup([], '工作')
assert.ok(created.group, '自证：建组成功')
writeGroups(created.list)
const GID = created.group.id
updateAccount(idB, { groupId: GID })

/** 起一次 apply，捕获 HTTP handler（probeIntervalMs=0 → 零定时器）。 */
async function boot() {
  const { apply } = await import('../src/index.ts')
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')
  return handler
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(text) { res.body = text ?? '' },
  }
  return res
}

const handler = await boot()

/** 调一次 GET /accounts，返回解析后的载荷。 */
async function getAccounts() {
  const res = fakeRes()
  await handler({ method: 'GET', url: API_ACCOUNTS }, res)
  assert.equal(res.statusCode, 200, `自证：GET /accounts 真的返回了（status=${res.statusCode} body=${res.body.slice(0, 160)}）`)
  const data = JSON.parse(res.body)
  assert.ok(
    Array.isArray(data.accounts),
    `自证：载荷里有 accounts 数组（实际 keys=${Object.keys(data).join(',')}；body=${res.body.slice(0, 240)}）`,
  )
  assert.ok(
    Array.isArray(data.sections),
    `自证：载荷里有 sections 数组（实际 keys=${Object.keys(data).join(',')}）`,
  )
  return data
}

const data = await getAccounts()
const flat = data.sections.flatMap((s) => (Array.isArray(s.accounts) ? s.accounts : []))

console.log('① 顶层 accounts 是"可直接渲染的视图"')

await test('每个账号都有 title，且不等于内部 id', () => {
  assert.equal(data.accounts.length, 2)
  for (const a of data.accounts) {
    assert.ok(a.title, `${a.id} 的 title 为空`)
    // 这一条就是回归的哨兵：客户端是 `item.title || item.id`，
    // title 一空就退化成 acc_xxxxxxx（用户看到的就是这个）。
    assert.notEqual(a.title, a.id, `${a.id} 的 title 退化成了内部 id`)
    assert.ok(a.title.includes('***'), `${a.id} 的 title 应是掩码后的账号标识，实际 ${JSON.stringify(a.title)}`)
  }
})

await test('每个账号都有非空 display（面板 meta 首段要用它）', () => {
  for (const a of data.accounts) {
    assert.equal(typeof a.display, 'string')
    assert.ok(a.display.length > 0, `${a.id} 的 display 为空`)
  }
})

console.log('② sections 里的账号必须是同一批视图（回归点）')

await test('sections 摊平后账号数一致', () => {
  assert.equal(flat.length, 2, `sections 里只有 ${flat.length} 个账号`)
})

await test('★ sections 里的账号也带 title（不能退化成 id）', () => {
  assert.ok(flat.length > 0, '自证：sections 非空，这条断言才有意义')
  for (const a of flat) {
    assert.ok(a.title, `sections 里的 ${a.id} 没有 title —— 面板标题会退化成 acc_xxxxxxx（0.1.71 的回归）`)
    assert.notEqual(a.title, a.id, `sections 里的 ${a.id} 标题退化成了内部 id`)
    assert.ok(a.title.includes('***'), `sections 里的 ${a.id} title 未经过掩码：${JSON.stringify(a.title)}`)
  }
})

await test('★ sections 里的账号也带 isActive（否则「✅ 当前」徽章消失）', () => {
  const actives = flat.filter((a) => a.isActive === true)
  assert.equal(actives.length, 1, `期望恰好一个当前账号，实际 ${actives.length}`)
  assert.equal(actives[0].id, activeAccountId(), '当前账号标记与 activeAccountId() 不一致')
})

await test('sections 里的账号保留 display / label / cookieMeta 等渲染字段', () => {
  for (const a of flat) {
    assert.equal(typeof a.display, 'string', `${a.id} 缺 display`)
    assert.equal(typeof a.label, 'string', `${a.id} 缺 label`)
    assert.ok(Array.isArray(a.cookieMeta), `${a.id} 缺 cookieMeta`)
    assert.ok('lastVerifiedAt' in a, `${a.id} 缺 lastVerifiedAt`)
  }
})

console.log('③ 分组本身仍然工作（别为了修上面而砍掉分区）')

await test('归组的账号落进对应 section（组名/组 id 都对）', () => {
  const work = data.sections.find((s) => s.groupId === GID)
  assert.ok(work, '找不到「工作」段')
  assert.equal(work.name, '工作')
  assert.ok(work.accounts.some((a) => a.id === idB), 'B 没进「工作」段')
  assert.ok(!work.accounts.some((a) => a.id === idA), 'A 不该在「工作」段')
})

await test('未归组的账号落进「未分组」段', () => {
  const un = data.sections.find((s) => s.key === UNGROUPED_KEY)
  assert.ok(un, '找不到「未分组」段')
  assert.deepEqual(un.accounts.map((a) => a.id), [idA])
})

await test('当前账号所在组被置顶（排序规则没被这轮修改破坏）', () => {
  // 当前账号是 B（后写的），它在「工作」组 ⇒ 「工作」应排在「未分组」前面
  assert.equal(data.sections[0].groupId, GID, '当前账号所在的组没有置顶')
})

console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败：`)
  for (const f of failures) console.log('   - ' + f)
  process.exitCode = 1
} else {
  console.log(`通过 ${passed} 项，全部通过 ✅`)
}
