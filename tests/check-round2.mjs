/**
 * 第二轮审计（DSH-Round2-Audit.md）的回归测试。
 *
 * 编号与审计报告一一对应，便于将来对照。每条都写清"改坏哪一行会让它变红"。
 *
 * 用法: node tests/check-round2.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-round2-'))
process.env.DSH_HOME = HOME

const {
  accountsDir,
  activeAccountId,
  importAccounts,
  listAccounts,
  newAccountId,
  setActiveAccount,
  upsertAccount,
  MAX_IMPORT_ACCOUNTS,
} = await import('../src/accounts.ts')
const { setFetchImpl, resetSessionReuse, streamWebCompletion } = await import('../src/webapi.ts')
const { classifyAuthEnvelope } = await import('../src/webapi.ts')
const { createRequestGate } = await import('../src/gate.ts')

// N04 用的两个账号（token 不同 → 复用键不同）
const authA = { token: 'token-A', cookie: 'c=A' }
const authB = { token: 'token-B', cookie: 'c=B' }
const { openExternalLogin } = await import('../src/login.ts')

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

console.log('N01 导入不得相信备份自报的 id')

await test('两条不同 token、同一个 id → 必须都进库（不是互相覆盖）', () => {
  // 审计原话：原版列表长度为 1；修复后为 2。
  // ⚠️ 反向验证：把 `record = { ...candidate, id }` 改成 `id: candidate.id` → 这条变红。
  const r = importAccounts([
    { id: 'acc_audit01', token: 'token-one', cookie: 'c1', userAgent: 'ua' },
    { id: 'acc_audit01', token: 'token-two', cookie: 'c2', userAgent: 'ua' },
  ])
  assert.equal(r.imported, 2, `两条都该新增，实际 ${JSON.stringify(r)}`)
  assert.equal(listAccounts().length, 2, '库里必须有两份凭证')
  const tokens = listAccounts().map((a) => a.token).sort()
  assert.deepEqual(tokens, ['token-one', 'token-two'])
  assert.equal(new Set(listAccounts().map((a) => a.id)).size, 2, 'id 必须互不相同')
})

await test('同 token 重复导入 → 幂等（更新，不新增）', () => {
  const before = listAccounts().length
  const r = importAccounts([{ id: 'whatever', token: 'token-one', cookie: 'c1-新', userAgent: 'ua' }])
  assert.equal(r.imported, 0, '同 token 不该新增')
  assert.equal(r.updated, 1, '同 token 应更新')
  assert.equal(listAccounts().length, before, '库长度不变')
})

await test('导入自报的 serverId 不授权覆盖不同 token 的账号', () => {
  // serverId 是备份自报字段，不能当认证证据：不同 token 必须各自成条
  const r = importAccounts([
    { id: 'x', serverId: 'srv-dup', token: 'token-three', cookie: 'c3', userAgent: 'ua' },
    { id: 'y', serverId: 'srv-dup', token: 'token-four', cookie: 'c4', userAgent: 'ua' },
  ])
  assert.equal(r.imported, 2, '同一个 serverId 但不同 token → 两条都要留下')
})

await test('非法输入返回零条，不抛错', () => {
  assert.deepEqual(importAccounts(null), { imported: 0, updated: 0, skipped: 0 })
  assert.deepEqual(importAccounts({ accounts: 'nope' }), { imported: 0, updated: 0, skipped: 0 })
  const r = importAccounts([{ token: 123 }, null, {}])
  assert.equal(r.imported, 0, '形状不对的一条都不能进库')
  assert.equal(r.skipped, 3)
})

await test(`超过 ${MAX_IMPORT_ACCOUNTS} 条 → 明确拒绝（避免对全库重复扫描）`, () => {
  const many = Array.from({ length: MAX_IMPORT_ACCOUNTS + 1 }, (_, i) => ({
    token: `bulk-${i}`,
    cookie: 'c',
    userAgent: 'ua',
  }))
  assert.throws(() => importAccounts(many), RangeError)
})

console.log()
console.log('账号 id 唯一性（审计指出旧测试只断言了 Node API 的输出）')

await test('newAccountId 连续生成必须互不相同且形态合法', () => {
  // ⚠️ 旧测试写的是 `assert.match(randomUUID(), /-/)` —— 那只证明 Node 的 randomUUID 有横线，
  //    把 newAccountId 改成常量它也照样绿（审计原话："不能算作账号 id 唯一性证据"）。
  const ids = Array.from({ length: 200 }, () => newAccountId())
  assert.equal(new Set(ids).size, 200, '200 次生成不该有重复')
  for (const id of ids) assert.match(id, /^acc_[0-9a-f]{8,}$/, `形态不对：${id}`)
})

console.log()
console.log('N08 取消长休不得消耗休息债务')

await test('取消一次长休后，下一次仍必须长休', async () => {
  let fakeNow = 0
  const slept = []
  const releasers = []
  const fakeSleep = (ms) => {
    slept.push(ms)
    return new Promise((resolve) => releasers.push(resolve))
  }
  const gate = createRequestGate({
    longRunThreshold: 1,
    longRunBreakMs: { min: 60_000, max: 60_000 },
    minIntervalMs: 0,
    maxIntervalMs: 0,
    now: () => fakeNow,
    sleep: fakeSleep,
    random: () => 0.5,
    logger: {},
  })
  const settle = () => new Promise((r) => setImmediate(r))

  // 第 1 次：正常完成 → consecutive = 1
  const r1 = await gate.acquire('a')
  fakeNow += 1_000
  r1()
  assert.equal(slept.length, 0, '第一次不该等待（自证：闸门确实在跑）')

  // 第 2 次：进入长休 → 取消它
  const ac = new AbortController()
  const p2 = gate.acquire('b', ac.signal)
  await settle()
  assert.equal(slept.length, 1, '第二次必须真的进入长休（自证，否则这条用例没测到东西）')
  assert.equal(slept[0], 60_000, '长休应取区间值')
  const outcome = p2.then(
    () => 'resolved',
    (error) => error.name,
  )
  ac.abort()
  assert.equal(await outcome, 'AbortError', '取消时应抛 AbortError')

  // 第 3 次：关键断言 —— 债务没被勾销，仍要长休
  // ⚠️ 反向验证：把 `if (needsBreak) consecutive = 0` 挪回 sleep 之前 → 这里只会 sleep 1 次，变红。
  const p3 = gate.acquire('c')
  await settle()
  assert.equal(slept.length, 2, `取消不该勾销休息债务，实际只 sleep 了 ${slept.length} 次`)
  releasers[1]()
  const r3 = await p3
  r3()
})

console.log()
console.log('N09 认证信封必须能辨认出用户')

await test('空壳 / 错型信封一律判失败', () => {
  for (const bad of [{ code: 0 }, { data: null }, { code: '401', data: null }, { code: 0, data: {} }]) {
    const r = classifyAuthEnvelope(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该判成功：${JSON.stringify(r)}`)
  }
})

await test('有可辨认身份的真实形态仍判成功（别矫枉过正）', () => {
  assert.equal(classifyAuthEnvelope({ code: 0, msg: '', data: { biz_data: { user: { id: 'u1' } } } }).ok, true)
  assert.equal(classifyAuthEnvelope({ code: 0, msg: '', data: { biz_data: { user: { nickname: '丁' } } } }).ok, true)
})

console.log()
console.log('N10 外部浏览器兜底不得让宿主挂掉')

await test('spawn 异步 error → 返回 ok:false，而不是未处理错误', async () => {
  // ⚠️ 反向验证：去掉 login.ts 里的 child.once('error', …) → 下面 emit('error') 无人监听，
  //    Node 的 EventEmitter 会直接抛未捕获异常 → 整个测试进程非零退出 → 这条变红。
  const { EventEmitter } = await import('node:events')
  const fakeChild = new EventEmitter()
  fakeChild.unref = () => {}
  const { setSpawnImpl } = await import('../src/login.ts')
  setSpawnImpl(() => {
    setImmediate(() => fakeChild.emit('error', Object.assign(new Error('AUDIT_ENOENT'), { code: 'ENOENT' })))
    return fakeChild
  })
  try {
    const result = await openExternalLogin()
    assert.equal(result.ok, false, 'spawn 失败必须报 false')
    assert.match(String(result.message), /AUDIT_ENOENT/, '要把原因带出来')
  } finally {
    setSpawnImpl()
  }
})

await test('spawn 成功 → 返回 ok:true 并 unref', async () => {
  const { EventEmitter } = await import('node:events')
  const fakeChild = new EventEmitter()
  let unrefed = false
  fakeChild.unref = () => {
    unrefed = true
  }
  const { setSpawnImpl } = await import('../src/login.ts')
  setSpawnImpl(() => {
    setImmediate(() => fakeChild.emit('spawn'))
    return fakeChild
  })
  try {
    const result = await openExternalLogin()
    assert.equal(result.ok, true)
    assert.equal(unrefed, true, '成功路径要 unref，别把宿主拖住')
  } finally {
    setSpawnImpl()
  }
})

console.log()
console.log('N07 固定头不得被按比例静默截断')

const { serializePrompt } = await import('../src/protocol.ts')

/** 把 system 撑到指定长度，并在**中间**埋一个哨兵（被中段截断就先丢它）。 */
function longSystem(chars) {
  const half = Math.floor(chars / 2)
  return 'S'.repeat(half - 12) + 'UNIQUE_POLICY_SENTINEL' + 'S'.repeat(chars - half - 12)
}

await test('预算够放完整 system 时，system 必须一字不少', () => {
  // 审计构造：约 8 万字符 system + 15 万字符消息 + 12 万预算。
  // 旧代码 headBudget = min(head.length, 120000*0.62) = 74400 < head(约 8.3 万)
  //   → truncateMiddle 从**中间**挖掉一块 → 哨兵丢失。
  const system = longSystem(80_000)
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(150_000) }] }]
  const out = serializePrompt({ system, messages, tools: [], maxChars: 120_000 })
  assert.ok(out.includes('UNIQUE_POLICY_SENTINEL'), 'system 中段被截掉了（固定头必须完整）')
  assert.ok(out.includes(system), '完整 system 都必须出现')
  assert.ok(out.length <= 120_000, `输出必须不超预算，实际 ${out.length}`)
})

await test('固定头自己放不下 → 明确报错，而不是静默丢指令', () => {
  const system = 'S'.repeat(200_000)
  let thrown
  try {
    serializePrompt({ system, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxChars: 120_000 })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '应当抛错（自证：确实走到了这条路径）')
  assert.equal(thrown.code, 'CONTEXT_WINDOW_EXCEEDED', `错误码应为 CONTEXT_WINDOW_EXCEEDED，实际 ${thrown.code}`)
})

await test('maxChars 非法值明确拒绝（小数 / NaN / 过小）', () => {
  for (const bad of [Number.NaN, 0.5, 100, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => serializePrompt({ system: 's', messages: [], tools: [], maxChars: bad }),
      RangeError,
      `maxChars=${bad} 应被拒绝`,
    )
  }
})

await test('没超预算时原样返回（别把正常路径也改了）', () => {
  const out = serializePrompt({
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    maxChars: 120_000,
  })
  assert.ok(out.includes('sys') && out.includes('hello'))
  assert.ok(!out.includes('不超预算'))
})

console.log()
console.log('N04 复用槽：提前结束必须退役、在用不得被回收')

/** 假传输 + 假 SSE，专供 N04 的三条路径。 */
function mkReuseFixture() {
  const created = []
  const transport = {
    createSession: async () => {
      const id = `sess-${created.length + 1}`
      created.push(id)
      return id
    },
    powHeader: async () => 'pow',
  }
  const sse = 'data: {"v":{"response":{"content":"hi"}}}\n\ndata: [DONE]\n\n'
  setFetchImpl(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  return { created, transport }
}

await test('调用方取到正文就 return → 下一次必须换新会话', async () => {
  // ⚠️ 反向验证：去掉 finally 里的 `!complete` 判断（即只在正常结束时退役）→ 这条变红。
  //    旧实现只在 HTTP 失败分支退役，stream generator 被提前 return 时不退役。
  resetSessionReuse()
  const { created, transport } = mkReuseFixture()
  const params = () => ({
    prompt: 'P',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    onDeleteSession: () => {},
  })
  for await (const _ of streamWebCompletion(authA, params(), transport)) break
  for await (const _ of streamWebCompletion(authA, params(), transport)) void _
  assert.equal(created.length, 2, `提前 return 的会话不该被继续复用，实际建了 ${created.length} 个`)
})

await test('复用会话仍在消费中时，并发请求不得回收它', async () => {
  resetSessionReuse()
  const { created, transport } = mkReuseFixture()
  const deleted = []
  const mk = () => ({
    prompt: 'P',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    sessionReuseTurns: 1, // 第二次请求必然触发轮换
    onDeleteSession: (id) => deleted.push(id),
  })
  const it = streamWebCompletion(authA, mk(), transport)[Symbol.asyncIterator]()
  const first = await it.next()
  assert.equal(first.done, false, '自证：第一条流确实已经开始了')

  const it2 = streamWebCompletion(authA, mk(), transport)[Symbol.asyncIterator]()
  const pending = it2.next()
  pending.catch(() => {})
  await new Promise((r) => setImmediate(r))
  assert.equal(deleted.length, 0, '在用的会话不得被并发请求回收')
  assert.equal(created.length, 1, '第二个请求应当等第一个结束（复用互斥）')

  for (;;) {
    const r = await it.next()
    if (r.done) break
  }
  for (;;) {
    const r = await it2.next()
    if (r.done) break
  }
  assert.equal(created.length, 2, '第一个结束后，第二个才轮换出新会话')
  assert.deepEqual(deleted, ['sess-1'], '轮换掉的旧会话要归还')
})

await test('建流阶段已是 AdapterLlmError 时，不得被包成 TRANSPORT（会抹掉 AUTH/RATE_LIMIT）', async () => {
  // ⚠️ 反向验证：在 openCompletion 的 catch 里去掉 `if (error instanceof AdapterLlmError) throw error`
  //    → 这条变红（AUTH 被抹成 TRANSPORT，宿主会按"可重试的传输错误"去重试本该停下的情况）。
  resetSessionReuse()
  const { AdapterLlmError } = await import('../src/auth.ts')
  const transport = {
    createSession: async () => 'sess-auth',
    powHeader: async () => {
      throw new AdapterLlmError('登录态已失效', 'AUTH')
    },
  }
  setFetchImpl(async () => new Response('', { status: 200 }))
  let thrown
  try {
    for await (const _ of streamWebCompletion(
      authA,
      { prompt: 'P', thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 5_000, onDeleteSession: () => {} },
      transport,
    )) {
      void _
    }
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'powHeader 抛错时必须向上抛（自证：确实走到了这条路径）')
  assert.equal(thrown.code, 'AUTH', `结构化错误码必须保留，实际 ${thrown.code}`)
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
