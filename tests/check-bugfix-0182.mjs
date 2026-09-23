// 0.1.82 修掉的缺陷的回归用例。
//
// 这一版的共同点是：**bug 都不在"纯逻辑"里，而在"接线"上** ——
// 界面发了字段但路由不认、重登换了 token 导致继承源解析不到、缓存作用域只守了一半。
// 所以这里刻意多写"端到端 / 真实入口"的用例，少写纯函数断言。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-0182-'))
process.env.DSH_HOME = HOME

const { accountsDir, listAccounts, readAccount, setActiveAccount, upsertAccount } = await import('../src/accounts.ts')
const { beginRelogin, commitCapturedAuth, endRelogin, pendingReloginTarget } = await import('../src/account-add.ts')
const { ImageUploadCache } = await import('../src/adapter.ts')
const { xmlToolCallTail, ToolCallStreamFilter } = await import('../src/protocol.ts')

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

// 宿主路由装置（照 check-accounts-view 的配方；probeIntervalMs=0 → 零定时器）
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

// ⚠️ 两个踩过的坑，都记在这里免得重犯：
//  1) 路由挂在 `/deepseek-web-login/api` 前缀下（见 index.ts 的 API_PREFIX）——
//     少了前缀一律 404，而 404 与"断言写错"长得一模一样；
//  2) `readJsonBody` 会调 `req.off(...)`，所以假 req 必须是真 EventEmitter，
//     否则 cleanup 抛在 promise 里 ⇒ **promise 永不结算**（表现为用例挂在 await 上）。
const API = '/deepseek-web-login/api'

function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function post(route, payload) {
  const res = fakeRes()
  await handler(fakeReq('POST', API + route, payload), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

const gateFile = join(HOME, 'web-login', 'gate.json')

// ── P0-1：图片上限必须真的存下来（"界面 → 路由 → 落盘"三段式，断言打在最后一段）──

await test('P0-1 POST /gate {maxRefImages} 不再是 400，且真的写进了 gate.json', async () => {
  const { status, data } = await post('/gate', { maxRefImages: 30 })
  assert.equal(status, 200, `此前必然 400「没有可更新的字段」，实际 status=${status} body=${JSON.stringify(data)}`)
  assert.equal(data?.maxRefImages, 30, '响应里要回显生效后的值')
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.maxRefImages, 30, '**落盘**才是这条用例的重点（此前连路由都不认这个字段）')
})

await test('P0-1 越界被夹到区间内（不是原样写进去）', async () => {
  const { status, data } = await post('/gate', { maxRefImages: 9999 })
  assert.equal(status, 200)
  assert.equal(data?.maxRefImages, 100, 'MAX_REF_IMAGES_BOUNDS.max = 100')
})

await test('P0-1 非数字仍然 400（白名单没有变成"什么都收"）', async () => {
  const { status } = await post('/gate', { maxRefImages: 'abc' })
  assert.equal(status, 400)
})

await test('P0-1 未知字段仍然 400（守住白名单本身）', async () => {
  const { status } = await post('/gate', { somethingElse: 1 })
  assert.equal(status, 400)
})

// ── P0-2：重登必须保住备注名 / 分组 / 身份 ──

await test('P0-2 重登（换 token、捕获不带身份）后，label / groupId / serverId / user 全都还在', () => {
  const old = upsertAccount(
    { token: 'tk-relogin-old', cookie: 'c=1', capturedAt: '2026-09-20T00:00:00.000Z' },
    { serverId: 'srv-X', label: '工作号', groupId: 'g_1', user: { display: '137******78', id: 'srv-X' } },
  )
  setActiveAccount(old.id)
  beginRelogin(old.id)
  assert.equal(pendingReloginTarget(), old.id, '自证：重登意图已登记')

  // 重登抓回来的是**全新 token**，而且 CDP 路径不带任何身份 —— 这正是现场形态
  const result = commitCapturedAuth({ token: 'tk-relogin-new', cookie: 'c=2', capturedAt: '2026-09-23T00:00:00.000Z' })
  assert.equal(result.mode, 'relogin', '自证：走的确实是重登分支')
  assert.equal(result.recordId, old.id, '原地更新，不新增')

  const after = readAccount(old.id)
  assert.ok(after, '记录还在')
  assert.equal(after.token, 'tk-relogin-new', 'token 换成了新的')
  assert.equal(after.label, '工作号', '备注名不能被清掉')
  assert.equal(after.groupId, 'g_1', '分组指针不能被清掉')
  assert.equal(after.serverId, 'srv-X', '身份键不能被清掉（它还是后续的去重键）')
  assert.equal(after.user?.display, '137******78', '显示名不能被清掉')
})

await test('P0-2 重登意图会被消费掉（不残留到下一次无关捕获）', () => {
  beginRelogin('acc_whatever')
  assert.ok(pendingReloginTarget(), '自证：先登记')
  endRelogin()
  assert.equal(pendingReloginTarget(), undefined)
})

// ── P0-3：其他入口必须清掉重登意图 ──

await test('P0-3 POST /login/add 会清掉残留的重登意图', async () => {
  beginRelogin('acc_stale_intent')
  assert.ok(pendingReloginTarget(), '自证：先制造残留')
  await post('/login/add', {})
  assert.equal(pendingReloginTarget(), undefined, '否则 60 分钟内登另一个号会被写进上次那条记录')
})

// ── P2-8：账号目录里混入非法文件名，不能让整个库读不出来 ──

await test('P2-8 目录里有 `.json` / `..json` 这类文件名时，其余账号照常读出来', () => {
  mkdirSync(accountsDir(), { recursive: true })
  const before = listAccounts().length
  writeFileSync(join(accountsDir(), '.json'), '{}', 'utf8')
  writeFileSync(join(accountsDir(), '..json'), '{}', 'utf8')
  writeFileSync(join(accountsDir(), 'ok.json'), JSON.stringify({ token: 'tk-ok', capturedAt: '2026-09-23T00:00:00.000Z' }), 'utf8')
  const after = listAccounts()
  assert.equal(after.length, before + 1, `只该多出 ok 那条，实际 ${after.length}（此前整库读不出来）`)
  assert.ok(after.some((item) => item.token === 'tk-ok'))
})

// ── R1：上传缓存的作用域校验必须与 set 对称 ──

await test('R1 缓存 get 带作用域校验：切了作用域后读不到旧账号的 file_id', () => {
  const cache = new ImageUploadCache()
  cache.useScope('token-A')
  assert.equal(cache.set('k1', 'file-A', Date.now(), 'token-A'), true)
  assert.equal(cache.get('k1', Date.now(), 'token-A'), 'file-A', '自证：同作用域命中')
  // 并发/切号时，调用方手里的 scope 已经变成 B，而缓存里那条是 A 写的 ——
  // 旧实现会把这个 file_id 交给 B 的请求去引用（F06 的另一半）
  assert.equal(cache.get('k1', Date.now(), 'token-B'), undefined, '作用域不符必须当未命中')
  assert.equal(cache.get('k1'), 'file-A', '不带作用域参数时保留旧行为（向后兼容）')
})

// ── P2-1：XML 捕获态下"调用之后的正文"不能凭空消失 ──

const LT = '<'
const CLOSE_INVOKE = LT + '/invoke>'
const CLOSE_CALLS = LT + '/calls>'

await test('P2-1 xmlToolCallTail 只回吐最后一个闭合调用块之后的部分', () => {
  const block = [
    LT + 'invoke name="bash">',
    LT + 'parameter name="command">pwd' + LT + '/parameter>',
    CLOSE_INVOKE,
    CLOSE_CALLS,
    '',
    '上面那条命令的结果是 /f/x。',
  ].join('\n')
  const tail = xmlToolCallTail(block)
  assert.ok(tail.includes('上面那条命令的结果是 /f/x。'), `调用之后的正文必须能捞回来，实际 ${JSON.stringify(tail)}`)
  assert.equal(tail.includes('pwd'), false, '调用块本身不该混进来')
})

await test('P2-1 找不到收尾标签时返回空串（不猜、保持旧行为）', () => {
  const block = LT + 'invoke name="bash">' + LT + 'parameter name="command">pwd'
  assert.equal(xmlToolCallTail(block), '')
})

await test('P2-1 flush 在抢救出调用之后，仍把调用之后的正文透出去', () => {
  const filter = new ToolCallStreamFilter()
  const frames = [
    // 关键：**包裹开标签给了、收尾故意不给** —— 只有这样，调用之后的正文才会留在
    // 捕获缓冲里直到 flush。第一版用例每条帧都推完，正文在 push 阶段就透出去了，
    // 于是"改坏了也不报红"（反向验证当场把这个假绿抓了出来）。
    LT + 'calls>',
    LT + 'invoke name="bash">',
    LT + 'parameter name="command">pwd' + LT + '/parameter>',
    CLOSE_INVOKE,
    '\n收工了，结果如上。',
  ]
  let text = ''
  let calls = 0
  for (const piece of frames) {
    const out = filter.push(piece)
    text += out.text
    calls += out.calls.length
  }
  const tail = filter.flush()
  text += tail.text
  calls += tail.calls.length
  assert.equal(calls, 1, `自证：确实抢救出了 1 个调用（实际 ${calls}）`)
  assert.ok(text.includes('收工了，结果如上。'), `调用之后的正文不能被吞掉，实际 ${JSON.stringify(text)}`)
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项 ❌\n  ${failures.join('\n  ')}` : '，全部通过 ✅'}`)
process.exit(failures.length === 0 ? 0 : 1)
