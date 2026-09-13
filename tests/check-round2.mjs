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
  removeAccount,
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
const { existsSync } = await import('node:fs')
// N02：造当前账号要走 writeAuth（它的语义是「写入并设为当前」）
// F04：可信校验后的身份归一（user.id → serverId）
const { writeAuth, withVerifiedIdentity, refreshVerifiedIdentity } = await import('../src/auth.ts')

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

// ── 第二轮审计 N05（高）：WASM 下载失败只清编译缓存，失效地址阻断 discovery 恢复 ──
// 触发现场：已缓存成功的官方地址后来下载失败 / 编译失败，进程继续运行并重试。
// 旧实现：resolveWasmUrl 命中 key 就直接返回；loadWasmModule 的 rejection 只清
// wasmModuleCache，**没清 resolvedWasmUrl** —— 于是「保留了 discovery 能力」并不等于
// 「失效后真的会再进 discovery」，请求会一直对着一个坏地址打。
const N05_MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const n05Json = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })

/**
 * 跑两轮 PoW：第一轮「探测通过（地址进缓存）+ 下载按 makeDownload 失败」，
 * 第二轮把探测也变成 404（= 资源整体失效），看会不会重新请求首页走 discovery。
 */
async function n05Run(makeDownload) {
  const { createPowHeader, DS_BASE } = await import('../src/webapi.ts')
  let homeHits = 0
  let probes = 0
  let downloads = 0
  let broken = false
  setFetchImpl(async (input, init) => {
    const url = String(input)
    if (url.includes('/api/v0/chat/create_pow_challenge')) {
      return n05Json({
        code: 0,
        data: {
          biz_data: {
            challenge: {
              algorithm: 'sha3',
              challenge: 'abc',
              salt: 'salt',
              signature: 'sig',
              difficulty: 1,
              expire_at: 1700000000,
            },
          },
        },
      })
    }
    // 首页 discovery 走的是 DS_BASE（https://chat.deepseek.com），不是裸域名
    if (url === DS_BASE + '/') {
      homeHits += 1
      return new Response('<!doctype html><html><body>no scripts here</body></html>', { status: 200 })
    }
    if (url.endsWith('.wasm')) {
      // isReachable 用 `range: bytes=0-0` 探测；readOfficialResource 才是真的下载
      const isProbe = !!(init?.headers && init.headers.range)
      if (isProbe) {
        probes += 1
        return broken ? new Response('', { status: 404 }) : new Response(N05_MINIMAL_WASM, { status: 200 })
      }
      downloads += 1
      return makeDownload()
    }
    return new Response('', { status: 404 })
  })
  const auth = {
    token: 'tok',
    cookie: '',
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: 'ua',
    capturedAt: '2026-09-13T00:00:00.000Z',
  }
  const tryOne = async () => {
    try {
      await createPowHeader(auth, '/api/v0/chat/completion')
      return false
    } catch {
      return true
    }
  }
  const firstFailed = await tryOne()
  const homeAfterFirst = homeHits
  broken = true // 资源整体失效：探测与下载都拿不到
  const secondFailed = await tryOne()
  const homeAfterSecond = homeHits
  setFetchImpl(undefined)
  return { firstFailed, secondFailed, homeAfterFirst, homeAfterSecond, probes, downloads }
}

function assertN05(r, label) {
  assert.ok(r.firstFailed, `${label}：第一轮必须失败（下载/编译坏了）——自证确实走到了这条路径`)
  assert.ok(r.probes >= 1, `${label}：自证探测发生过（probes=${r.probes}）`)
  assert.ok(r.downloads >= 1, `${label}：自证下载发生过（downloads=${r.downloads}）`)
  assert.equal(r.homeAfterFirst, 0, `${label}：第一轮探测通过，不该走 discovery（说明地址真的进了缓存）`)
  assert.ok(r.secondFailed, `${label}：第二轮也必须失败（地址仍然坏）`)
  assert.ok(
    r.homeAfterSecond > r.homeAfterFirst,
    `${label}：失效地址必须被清掉、重新请求首页做 discovery，实际 homeHits=${r.homeAfterSecond}（基线 ${r.homeAfterFirst}）`,
  )
}

await test('N05：WASM 下载 404 后必须重新走 discovery（不能卡在坏地址上）', async () => {
  assertN05(await n05Run(() => new Response('gone', { status: 404 })), '下载 404')
})

await test('N05：WASM 编译失败后同样要清地址缓存', async () => {
  // HTTP 200 但字节不是合法 wasm → WebAssembly.compile reject（走的是同一条清理回调）
  assertN05(await n05Run(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })), '编译失败')
})

// ── 第二轮审计 N02（高）：迟到的 /status 校验仍会把当前账号切回去 ────────────────
// 根因：`const check = await validateAuth(auth)` 之后走的是 `writeAuth({ ...auth, user: check.user })`，
// 而 writeAuth 的语义包含 upsert + **切换当前账号** —— 刷新元信息不该有这种副作用：
// 校验是异步的，等待期间用户可能已经切到别的账号、甚至把那个账号删掉，
// 迟到的结果就会把账号切回去 / 把已删除的凭证复活。
const API_STATUS = '/deepseek-web-login/api/status'

/** 起一次 apply，捕获 /status 的 HTTP handler（probeIntervalMs=0 → 零定时器）。 */
async function bootStatusHandler() {
  const { apply } = await import('../src/index.ts')
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 /status 的 HTTP handler')
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

/** 触发一次 GET /status，返回「等校验发出去了」的句柄 + 释放函数。 */
async function statusRequestWhileValidating(handler, userPayload) {
  let release
  const held = new Promise((resolve) => { release = resolve })
  let validatorHits = 0
  setFetchImpl(async (input) => {
    const url = String(input)
    if (url.includes('/api/v0/users/current')) {
      validatorHits += 1
      await held
      return new Response(
        JSON.stringify({ code: 0, data: { biz_data: { id: 'u-A', email: userPayload } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('', { status: 404 })
  })
  const res = fakeRes()
  const pending = handler({ method: 'GET', url: API_STATUS }, res)
  for (let i = 0; i < 400 && validatorHits === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(validatorHits, 1, '自证：校验请求确实发出并挂起了（否则下面断言的是没开始的状态）')
  return { release, pending, res }
}

await test('N02：等待校验期间切到别的账号 → 迟到的结果不得把账号切回去', async () => {
  writeAuth({
    token: 'tok-N02-A',
    cookie: 'c=A',
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: 'ua',
    capturedAt: '2026-09-13T00:00:00.000Z',
    user: { display: 'A 旧名' },
  })
  const a = listAccounts().find((item) => item.token === 'tok-N02-A')
  assert.ok(a, '自证：A 已经写进账号库')
  assert.equal(activeAccountId(), a.id, '前提：A 是当前账号')

  const b = upsertAccount({
    token: 'tok-N02-B',
    cookie: 'c=B',
    userAgent: 'ua',
    capturedAt: '2026-09-13T00:00:00.000Z',
  })
  assert.notEqual(b.id, a.id)

  const handler = await bootStatusHandler()
  const { release, pending } = await statusRequestWhileValidating(handler, 'a-new@example.com')

  // 用户在这期间切到 B
  setActiveAccount(b.id)
  assert.equal(activeAccountId(), b.id, '前提：已切到 B')

  release()
  await pending

  assert.equal(activeAccountId(), b.id, '迟到的校验结果不得把当前账号切回 A')
  const aAfter = listAccounts().find((item) => item.token === 'tok-N02-A')
  assert.ok(aAfter, 'A 的记录仍应在库里')
  assert.equal(aAfter.user?.display, 'a-new@example.com', '元信息仍要被刷新（自证这条路径真的走到了）')
  assert.ok(typeof aAfter.lastVerifiedAt === 'string', '应记录校验时间')
  assert.equal(aAfter.unverified, undefined, '校验成功后未验证标记要被清掉')
  setFetchImpl(undefined)
})

await test('N02：等待校验期间删掉该账号 → 迟到的结果不得复活它', async () => {
  writeAuth({
    token: 'tok-N02-C',
    cookie: 'c=C',
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: 'ua',
    capturedAt: '2026-09-13T00:00:00.000Z',
    user: { display: 'C 旧名' },
  })
  const c = listAccounts().find((item) => item.token === 'tok-N02-C')
  assert.ok(c, '自证：C 已经写进账号库')

  const handler = await bootStatusHandler()
  const { release, pending } = await statusRequestWhileValidating(handler, 'c-new@example.com')

  // 用户在这期间把这个账号删了
  assert.equal(removeAccount(c.id), true, '前提：删除成功')
  assert.ok(!listAccounts().some((item) => item.token === 'tok-N02-C'), '前提：C 已不在库里')

  release()
  await pending

  assert.ok(
    !listAccounts().some((item) => item.token === 'tok-N02-C'),
    '迟到的校验结果不得把已删除的账号复活（旧实现走 writeAuth 会 upsert 回来）',
  )
  setFetchImpl(undefined)
})

// ── 第一轮审计 F04（中）／第二轮复核：user.id 未进入去重键，重登产生重复账号 ──────
// 现象：库里按 serverId 去重，但真实登录路径把服务端返回的 user.id 只塞进 `user` 字段、
// **从没写进 serverId** → token 一刷新（同账号重登）去重键就失效，同一个号在库里堆好几条。
// 既有测试是**手工传 serverId** 才通过的 —— 那条链在生产上根本没接通（本轮补的就是它）。
const F04_BASE = {
  cookie: 'c',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'ua',
  capturedAt: '2026-09-13T00:00:00.000Z',
}

await test('F04：同一账号 token 刷新后重登，库里仍只有一条（且 token 已更新）', async () => {
  // 第一次登录：可信校验返回服务端 id = srv-f04-1
  const first = upsertAccount(
    withVerifiedIdentity({ ...F04_BASE, token: 'tok-f04-first' }, { id: 'srv-f04-1', display: '甲' }),
  )
  assert.equal(first.serverId, 'srv-f04-1', '可信校验拿到的 user.id 必须落成 serverId')
  assert.equal(listAccounts().filter((x) => x.serverId === 'srv-f04-1').length, 1, '自证：第一条已入库')

  // 同账号重登：token 刷新成另一个值，服务端 id 不变
  const second = upsertAccount(
    withVerifiedIdentity({ ...F04_BASE, token: 'tok-f04-second' }, { id: 'srv-f04-1', display: '甲' }),
  )

  const same = listAccounts().filter((x) => x.serverId === 'srv-f04-1')
  assert.equal(same.length, 1, `同一账号重登不得新增（实际 ${same.length} 条）`)
  assert.equal(second.id, first.id, '应该是同一条记录被更新')
  assert.equal(second.token, 'tok-f04-second', 'token 要更新成最新那次')
})

await test('F04：旧记录（只有 user.id、没有 serverId）也必须能被认出来', async () => {
  // 造一条「老库」记录：serverId 是后加的字段，老记录里没有，只有 user.id
  upsertAccount({ ...F04_BASE, token: 'tok-f04-legacy', user: { id: 'srv-f04-legacy', display: '乙' } })
  const legacy = listAccounts().find((x) => x.token === 'tok-f04-legacy')
  assert.ok(legacy, '自证：旧记录已入库')
  assert.equal(legacy.serverId, undefined, '自证：这条旧记录确实没有 serverId')

  // 该账号重新登录（token 变了），服务端仍返回同一个 id
  upsertAccount(
    withVerifiedIdentity({ ...F04_BASE, token: 'tok-f04-legacy-new' }, { id: 'srv-f04-legacy', display: '乙' }),
  )

  const hits = listAccounts().filter((x) => x.token === 'tok-f04-legacy' || x.token === 'tok-f04-legacy-new')
  assert.equal(hits.length, 1, `旧记录应被认出来并更新，而不是新增（实际 ${hits.length} 条）`)
  assert.equal(hits[0].serverId, 'srv-f04-legacy', '更新后应补上 serverId')
})

await test('F04：/status 的迟到校验也要把 user.id 落成 serverId', async () => {
  writeAuth({ ...F04_BASE, token: 'tok-f04-status', user: { display: '丙' }, hifDliq: '', hifLeim: '' })
  const before = listAccounts().find((x) => x.token === 'tok-f04-status')
  assert.ok(before, '自证：当前账号已入库')
  assert.equal(before.serverId, undefined, '自证：入库时还没有 serverId（这正是重登会重复的原因）')

  const handler = await bootStatusHandler()
  const { release, pending } = await statusRequestWhileValidating(handler, 'bing@example.com')
  release()
  await pending

  const after = listAccounts().find((x) => x.token === 'tok-f04-status')
  assert.equal(after.serverId, 'u-A', '校验成功后要把服务端 user.id 落成 serverId（与 N02 同一处代码）')
  assert.equal(after.user?.display, 'bing@example.com', '展示名也要刷新（自证这条路径走到了）')
  assert.equal(refreshVerifiedIdentity('acc_不存在', 'x', { id: 'y' }), false, '记录不存在时不得凭空新建')
  setFetchImpl(undefined)
})

// ── 第一轮审计 F06（高）：图片缓存跨账号复用且过期项不淘汰 ────────────────────
// 现象：缓存只按 attachmentId 记 → 切到另一个账号后会把上一个账号的 fileId 复用出去；
// 而且只检查"被查中的那一项"的 TTL，一直换新图不换旧 key 时旧项会永久滞留。
await test('F06：图片上传缓存必须按账号隔离（换号不得复用上一个账号的 fileId）', async () => {
  const { ImageUploadCache } = await import('../src/adapter.ts')
  const cache = new ImageUploadCache(60_000, 8)
  cache.useScope('tok-A')
  cache.set('att-1', 'file-A', 0)
  assert.equal(cache.get('att-1', 0), 'file-A', '自证：同一账号内可命中')
  cache.useScope('tok-B')
  assert.equal(cache.get('att-1', 0), undefined, '换账号后不得复用上一个账号的 fileId')
  assert.equal(cache.size, 0, '换账号时应整批清空')
})

await test('F06：过期项要被整体淘汰，条数要有上限', async () => {
  const { ImageUploadCache } = await import('../src/adapter.ts')
  const cache = new ImageUploadCache(1_000, 8)
  cache.useScope('t')
  cache.set('a', 'f-a', 0)
  cache.set('b', 'f-b', 500)
  // t=1200：a 过期（1200-0 ≥ 1000），b 还新
  assert.equal(cache.prune(1200), 1, 'prune 要清掉**所有**过期项，而不只是"这次要查的那一个"')
  assert.equal(cache.get('b', 1200), 'f-b', '没过期的必须留着')
  assert.equal(cache.get('a', 1200), undefined, '过期项不得命中')

  const small = new ImageUploadCache(60_000, 2)
  small.useScope('t')
  small.set('1', 'x1', 0)
  small.set('2', 'x2', 0)
  small.set('3', 'x3', 0)
  assert.equal(small.size, 2, '条数必须封顶（否则一直换图会无限涨）')
  assert.equal(small.get('1', 0), undefined, '超出上限时丢最早写入的')
  assert.equal(small.get('3', 0), 'x3')
})

await test('F06：await 期间账号被切走 → 拒绝写入（防串号）', async () => {
  const { ImageUploadCache } = await import('../src/adapter.ts')
  const cache = new ImageUploadCache()
  cache.useScope('tok-A')
  const scope = cache.currentScope()
  cache.useScope('tok-B') // 上传 await 期间，用户切了账号
  assert.equal(cache.set('att', 'file-A', Date.now(), scope), false, '作用域已变时必须拒绝写入')
  assert.equal(cache.size, 0, '不能把 A 的 fileId 写进 B 的作用域')
})

// ── 第一轮审计 F19（中）：hours 小数抛 RangeError + 间隔口径 ────────────────────
await test('F19：hours 传小数 / 负数 / Infinity 都不能抛错', async () => {
  const { summarizeLedger } = await import('../src/ledger.ts')
  for (const input of [1.5, -3, 0, 999, Infinity, -Infinity, NaN]) {
    const summary = summarizeLedger(input)
    assert.ok(Number.isInteger(summary.hours), `hours 必须是整数，实际 ${summary.hours}（输入 ${input}）`)
    assert.ok(summary.hours >= 1 && summary.hours <= 72, `hours 应夹在 1–72，实际 ${summary.hours}`)
    assert.equal(summary.hourly.length, summary.hours, 'hourly 分桶要跟着取整后的 hours')
  }
})

// ── 第一轮审计 F23（中）：拒绝载荷默认明文落盘 + 忽略 DSH_HOME ──────────────────
await test('F23：丢弃载荷只记元信息（不落原文），且写在 DSH_HOME 下', async () => {
  const { dumpRejectedPayload } = await import('../src/adapter.ts')
  const secret = 'SECRET-PASSWORD-abc123'
  const raw = secret + 'x'.repeat(200)
  dumpRejectedPayload(raw, 'json', 'unparsable')
  const file = join(HOME, 'web-login', 'diagnostics', 'rejected-meta.jsonl')
  assert.ok(existsSync(file), '诊断元信息应写在 DSH_HOME 下（旧实现硬编码 homedir，无视 DSH_HOME）')
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes(secret), '不得把原文写进诊断文件（里面可能有命令里的 token / 文件内容）')
  const line = JSON.parse(text.trim().split('\n').pop())
  assert.equal(line.length, raw.length, '长度要记下来（够判断"是不是同一段坏输出反复出现"）')
  assert.equal(line.mode, 'json')
  assert.equal(line.reason, 'unparsable')
  assert.equal(typeof line.sha256, 'string')
  assert.equal(line.sha256.length, 64, '摘要用 sha256')
  // 未知取值要归一到 'other'（不把任意字符串写进诊断文件）
  dumpRejectedPayload('x', 'weird-mode', 'weird-reason')
  const last = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop())
  assert.equal(last.mode, 'other')
  assert.equal(last.reason, 'other')
})

// ── 第一轮审计 F22（中）：另存为失败不释放 writable ───────────────────────────
// 触发：createWritable 成功，但 write 或 close 抛错；catch 直接返回 failed、**没有 abort**
// → 遗留未提交的临时文件与句柄（模拟磁盘写满时实测 abort 从未被调用）。
await test('F22：写盘失败必须 abort（否则留下未提交的临时文件/句柄）', async () => {
  const { saveWithPicker } = await import('../src/file-picker.ts')
  const seen = []
  const fakeWin = {
    showSaveFilePicker: async () => ({
      name: 'backup.json',
      createWritable: async () => ({
        write: async () => {
          throw new Error('磁盘空间不足')
        },
        close: async () => {},
        abort: async (reason) => {
          seen.push(reason)
        },
      }),
    }),
  }
  const outcome = await saveWithPicker('backup.json', async () => '{"a":1}', fakeWin)
  assert.equal(outcome.kind, 'failed', `写盘失败应返回 failed，实际 ${outcome.kind}`)
  assert.equal(seen.length, 1, '自证：write 失败后必须调用一次 abort（旧实现一次都没有）')

  // 成功路径不该误调 abort
  const seen2 = []
  const okWin = {
    showSaveFilePicker: async () => ({
      name: 'ok.json',
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
        abort: async (reason) => {
          seen2.push(reason)
        },
      }),
    }),
  }
  const ok = await saveWithPicker('ok.json', async () => '{}', okWin)
  assert.equal(ok.kind, 'saved')
  assert.equal(seen2.length, 0, '成功路径不得 abort')
})

// ── 第一轮审计 F16（中）：请求体与文件导入边界 ────────────────────────────────
// 旧实现只监听 data/end/error：客户端只 close/aborted 就**永不结算**，监听器与 Promise 一起挂着。
await test('F16：请求体只关闭不 end 时必须结算（不能永远挂着）', async () => {
  const { readJsonBody } = await import('../src/index.ts')
  const { EventEmitter } = await import('node:events')
  const req = new EventEmitter()
  req.complete = false
  req.resume = () => {}
  const pending = readJsonBody(req)
  req.emit('close')
  await assert.rejects(() => pending, /中止|失败/, '只 close 也要结算，而不是挂到天荒地老')
  assert.equal(req.listenerCount('data'), 0, '结算后必须把监听器摘干净')
  assert.equal(req.listenerCount('close'), 0)
})

await test('F16：超限要抛带状态码的错误（不能静默 resolve(undefined)）', async () => {
  const { readJsonBody, BodyError } = await import('../src/index.ts')
  const { EventEmitter } = await import('node:events')
  const req = new EventEmitter()
  req.complete = false
  req.resume = () => {}
  const pending = readJsonBody(req, 100)
  req.emit('data', Buffer.alloc(200))
  await assert.rejects(
    () => pending,
    (error) => error instanceof BodyError && error.status === 413,
    '超限应报 413，调用方才能回结构化错误（旧实现 destroy 后 resolve(undefined)，客户端只看到断连）',
  )
})

await test('F16：正常请求体照旧能解析', async () => {
  const { readJsonBody } = await import('../src/index.ts')
  const { EventEmitter } = await import('node:events')
  const req = new EventEmitter()
  req.complete = false
  req.resume = () => {}
  const pending = readJsonBody(req)
  req.emit('data', Buffer.from('{"payload":{"accounts":[]}}'))
  req.emit('end')
  const body = await pending
  assert.ok(body?.payload, `应解析出 payload，实际 ${JSON.stringify(body)}`)
})

// ── 第一轮审计 F15（中）：CDP 错误与连接关闭未结算请求 ─────────────────────────
class FakeWebSocket {
  constructor() {
    this.listeners = new Map()
    this.readyState = 1
    this.sent = []
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
}

function withFakeWebSocket() {
  const original = globalThis.WebSocket
  let socket
  class Recording extends FakeWebSocket {
    constructor(url) {
      super()
      this.url = url
      socket = this
    }
  }
  globalThis.WebSocket = Recording
  return { get: () => socket, restore: () => { globalThis.WebSocket = original } }
}

await test('F15：CDP 协议错误必须 reject（旧实现当成 result=undefined 的成功）', async () => {
  const { CdpClient } = await import('../src/browser-login.ts')
  const ws = withFakeWebSocket()
  try {
    const cdp = new CdpClient('ws://127.0.0.1:1/devtools/page/x')
    const connecting = cdp.connect(1_000)
    ws.get().emit('open')
    await connecting
    const pending = cdp.send('Runtime.evaluate', { expression: '1' })
    const id = JSON.parse(ws.get().sent.at(-1)).id
    ws.get().emit('message', { data: JSON.stringify({ id, error: { code: -32000, message: 'boom' } }) })
    await assert.rejects(() => pending, /boom/, '协议错误必须 reject，不能把 message.result(undefined) 当成功')
    cdp.close()
  } finally {
    ws.restore()
  }
})

await test('F15：连接关闭要立刻结算所有在途命令（不能各自等到超时）', async () => {
  const { CdpClient } = await import('../src/browser-login.ts')
  const ws = withFakeWebSocket()
  try {
    const cdp = new CdpClient('ws://127.0.0.1:1/devtools/page/x')
    const connecting = cdp.connect(1_000)
    ws.get().emit('open')
    await connecting
    const a = cdp.send('A', {}, 60_000)
    const b = cdp.send('B', {}, 60_000)
    ws.get().emit('close')
    await assert.rejects(() => a, /已关闭/, '关连接后 A 应立刻被拒')
    await assert.rejects(() => b, /已关闭/, '关连接后 B 应立刻被拒')
  } finally {
    ws.restore()
  }
})

await test('F15：send 同步抛错时不留 pending（旧实现会挂到超时）', async () => {
  const { CdpClient } = await import('../src/browser-login.ts')
  const ws = withFakeWebSocket()
  try {
    const cdp = new CdpClient('ws://127.0.0.1:1/devtools/page/x')
    const connecting = cdp.connect(1_000)
    ws.get().emit('open')
    await connecting
    ws.get().send = () => {
      throw new Error('socket 已坏')
    }
    await assert.rejects(() => cdp.send('C', {}, 60_000), /socket 已坏/)
    // 自证：不留 pending —— close() 时不该再有任何在途命令
    let rejected = 0
    const probe = cdp.send('D', {}, 60_000).catch(() => {
      rejected += 1
    })
    cdp.close()
    await probe
    assert.equal(rejected, 1, '坏掉的 socket 上发的命令也要结算')
  } finally {
    ws.restore()
  }
})

await test('F15：页面筛选按 origin 严格比较（不能 includes 命中伪造域名）', async () => {
  const { isDeepSeekPage } = await import('../src/browser-login.ts')
  assert.equal(isDeepSeekPage({ type: 'page', url: 'https://chat.deepseek.com/a/chat/s/1' }), true)
  assert.equal(isDeepSeekPage({ type: 'page', url: 'https://chat.deepseek.com.evil.example/x' }), false, 'includes 写法会在这里放行')
  assert.equal(isDeepSeekPage({ type: 'page', url: 'https://evil.example/?u=deepseek.com' }), false)
  assert.equal(isDeepSeekPage({ type: 'iframe', url: 'https://chat.deepseek.com/' }), false)
  assert.equal(isDeepSeekPage(null), false)
})

// ── 第一轮审计 F10（高）：建连阶段无限等待 + 创建会话后失败无人回收 ──
// 触发现场：createSession 成功之后、拿到响应头之前（PoW / 网络 / 建连挂住）出错。
// 旧实现的 idle watchdog 要等响应头之后才启动，所以这一段完全没有限时；
// 而失败分支又只有 openCompletion 自己 catch 得到的那部分会回收会话。
// 现状核对（2026-09-13）：N04 重写时已经落了「建立阶段限时 / 只等 next 时计 idle /
// 失败即退役 / 放行 AdapterLlmError」，但**这两条路径一条断言都没有**，所以补在这里。

await test('F10：PoW 抛错时必须回收刚建出来的会话（不能漏在服务端）', async () => {
  // ⚠️ 这条断言由**两层**保证，互为兜底：
  //    ① openCompletion 的 fetch catch（失败即退役 + 通知）；
  //    ② streamWebCompletion 收尾时遍历「本次创建过的全部会话」（F10 新增的兜底）。
  //    反向验证必须**两层一起改掉**才会红 —— 只改 ① 时 ② 会兜住，只改 ② 时 ① 会兜住。
  resetSessionReuse()
  const { AdapterLlmError } = await import('../src/auth.ts')
  const deleted = []
  const transport = {
    createSession: async () => 'sess-f10-pow',
    powHeader: async () => {
      throw new AdapterLlmError('PoW 失败', 'PROVIDER_ERROR')
    },
  }
  setFetchImpl(async () => new Response('', { status: 200 }))
  let thrown
  try {
    for await (const _ of streamWebCompletion(
      authA,
      {
        prompt: 'P',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        onDeleteSession: (id) => deleted.push(id),
      },
      transport,
    )) {
      void _
    }
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '自证：PoW 抛错必须向上抛（否则这条用例没走到被测路径）')
  assert.deepEqual(deleted, ['sess-f10-pow'], `建出来又失败的会话必须归还，实际 ${JSON.stringify(deleted)}`)
})

await test('F10：建连阶段挂住时必须被中断（不能无限 await）', async () => {
  // ⚠️ 反向验证：去掉 `wait(openCompletion(...))` 的包装（直接 await openCompletion）
  //    → 这条变红：下面这个 createSession 永不结算，等待永远不会结束（测试会超时）。
  //    注：abort 只对"肯配合 signal 的传输"立即生效，包一层 wait() 才能保证限时真的有效。
  resetSessionReuse()
  let sessionResolve
  // ⚠️ 这里必须留一个 **ref 的** 句柄占住事件循环：
  // arm() 里的超时定时器是 `unref()` 的（刻意不为了超时把进程吊住），
  // 而建连挂住时事件循环里没有别的 ref 句柄 → Node 会直接退出，
  // 表现为 "unsettled top-level await"，看起来像实现挂了。
  // 真实运行环境里 DSH 自己就有活的事件循环，所以 unref 是对的，问题只在测试夹具。
  const hold = setTimeout(() => sessionResolve?.("sess-f10-hang"), 8_000)
  const transport = {
    // 永不主动结算：模拟对端不接受连接 / 不响应
    createSession: () =>
      new Promise((resolve) => {
        sessionResolve = (value) => {
          clearTimeout(hold)
          resolve(value)
        }
      }),
    powHeader: async () => 'pow',
  }
  setFetchImpl(async () => new Response('', { status: 200 }))
  const started = Date.now()
  let thrown
  try {
    for await (const _ of streamWebCompletion(
      authA,
      {
        prompt: 'P',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        connectTimeoutMs: 250, // 注入缝：把 45 秒压到 250ms 才能离线验证
        onDeleteSession: () => {},
      },
      transport,
    )) {
      void _
    }
  } catch (error) {
    thrown = error
  }
  const elapsed = Date.now() - started
  assert.ok(thrown, '自证：挂住的建连必须抛错，而不是一直等')
  assert.equal(thrown.code, 'TIMEOUT', `必须是建连超时，实际 ${thrown.code}`)
  assert.ok(elapsed < 5_000, `必须在注入的限期附近结束，实际耗时 ${elapsed}ms`)
  // 收尾：把那次永不结算的建连放掉，免得留下挂起的 promise
  sessionResolve?.('sess-f10-hang')
})

await test('F10：超时之后才建出来的会话也要归还（放弃建连不等于放弃会话）', async () => {
  // ⚠️ 这条断言同样由**两层**保证：
  //    ① tracked.createSession 里「已收尾 → 就地归还」的分支（F10 新增）；
  //    ② leaseSession 里「建会话期间被取消 → 就地回收」的分支（N04 原有）。
  //    反向验证要两层一起改才会红。两者都指向同一件事：没人认领的会话不许留在服务端。
  resetSessionReuse()
  const deleted = []
  const transport = {
    // 比建连期限（200ms）晚 300ms 才返回 —— 那时外层已经收尾了
    createSession: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve('sess-f10-late'), 300)
      }),
    powHeader: async () => 'pow',
  }
  setFetchImpl(async () => new Response('', { status: 200 }))
  let thrown
  try {
    for await (const _ of streamWebCompletion(
      authA,
      {
        prompt: 'P',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        connectTimeoutMs: 200,
        onDeleteSession: (id) => deleted.push(id),
      },
      transport,
    )) {
      void _
    }
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown?.code, 'TIMEOUT', '自证：这次超时确实发生了（否则没走到收尾后的路径）')
  for (let i = 0; i < 40 && !deleted.includes('sess-f10-late'); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(
    deleted.includes('sess-f10-late'),
    `超时后迟到的会话必须被归还，实际归还了 ${JSON.stringify(deleted)}`,
  )
})

// ── 第一轮审计 F08（高）：登录轮询重叠 / 重复提交 / 关闭后迟到写回 ──
// 触发现场：用户点「登录新账号」→ 窗口里登录 → 校验耗时超过轮询周期 / 中途关窗。
// 旧写法是 `setInterval(() => void (async () => {...})())`：多轮可同时在跑、
// 没有"完成"守卫、也没有 catch；而且 `finish` 的落库动作没有串行保护，
// 于是"添加模式"会被消费两次（第二次退化成普通切换）。
// 修法：轮询抽成 startCapturePoll（串行 + 至多提交一次 + 停止后丢弃迟到结果），
// 并让 commitCapturedAuth 的 add 分支 try/finally 消费添加模式。

const { startCapturePoll } = await import('../src/login.ts')
const { beginAddAccount, addModeActive, commitCapturedAuth } = await import('../src/account-add.ts')

await test('F08：轮询必须串行（一轮没跑完不许开始下一轮）', async () => {
  // ⚠️ 反向验证：把轮询改回 `setInterval(() => void round(), intervalMs)`
  //    → 这条变红（并发轮次 > 1）。
  let live = 0
  let maxLive = 0
  let rounds = 0
  const commits = []
  const stop = startCapturePoll({
    intervalMs: 20,
    capture: async () => {
      live += 1
      maxLive = Math.max(maxLive, live)
      rounds += 1
      await new Promise((r) => setTimeout(r, 60)) // 一轮比周期长 3 倍
      live -= 1
      return []
    },
    verify: async () => ({ ok: false }),
    commit: async (token) => {
      commits.push(token)
    },
  })
  await new Promise((r) => setTimeout(r, 260))
  stop()
  assert.equal(maxLive, 1, `同一时刻只允许一轮在跑，实际 ${maxLive} 轮并发`)
  assert.ok(rounds >= 2, `自证：确实跑了多轮（否则这条测不到重叠），实际 ${rounds} 轮`)
  assert.deepEqual(commits, [], '没有候选时不该提交')
})

await test('F08：校验通过时"提交"至多一次，且提交后停止轮询', async () => {
  // ⚠️ 反向验证：去掉 committed 占位（只靠 stop()）→ 这条变红（会提交多次）。
  let captures = 0
  const commits = []
  const stop = startCapturePoll({
    intervalMs: 10,
    capture: async () => {
      captures += 1
      return ['tok-1']
    },
    verify: async () => {
      await new Promise((r) => setTimeout(r, 50)) // 比周期长：旧写法这里会重叠
      return { ok: true }
    },
    commit: async (token, verified) => {
      commits.push([token, verified])
      await new Promise((r) => setTimeout(r, 30))
    },
  })
  await new Promise((r) => setTimeout(r, 300))
  stop()
  assert.deepEqual(commits, [['tok-1', true]], `提交必须恰好一次，实际 ${JSON.stringify(commits)}`)
  assert.ok(captures >= 1, '自证：采集确实发生过')
})

await test('F08：连续校验失败时按 fail-open 落盘，也只提交一次', async () => {
  let attempts = 0
  const commits = []
  const errors = []
  const stop = startCapturePoll({
    intervalMs: 10,
    maxAttempts: 3,
    capture: async () => {
      attempts += 1
      return ['tok-fail']
    },
    verify: async () => ({ ok: false, error: '校验没过' }),
    commit: async (token, verified) => {
      commits.push([token, verified])
    },
    onError: (m) => errors.push(m),
  })
  await new Promise((r) => setTimeout(r, 400))
  stop()
  assert.ok(attempts >= 3, `自证：确实跑满 3 轮，实际 ${attempts}`)
  assert.deepEqual(commits, [['tok-fail', false]], `fail-open 落盘必须恰好一次，实际 ${JSON.stringify(commits)}`)
  assert.ok(errors.length >= 1, '失败文案要报给 UI')
})

await test('F08：stop() 之后迟到的校验结果必须丢弃（关窗后不许写回）', async () => {
  // ⚠️ 反向验证：去掉两处 `if (stopped || committed) return` → 这条变红
  //    （关掉窗口之后，还在 await 里的那次校验会把凭证写回来）。
  const commits = []
  let verifyStarted = false
  const stop = startCapturePoll({
    intervalMs: 10,
    capture: async () => ['tok-late'],
    verify: async () => {
      verifyStarted = true
      await new Promise((r) => setTimeout(r, 120))
      return { ok: true } // 校验"通过"了，但此时窗口已经关了
    },
    commit: async (token, verified) => {
      commits.push([token, verified])
    },
  })
  for (let i = 0; i < 40 && !verifyStarted; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(verifyStarted, '自证：校验确实已经开始（否则没走到"迟到"这条路径）')
  stop() // = 关窗
  await new Promise((r) => setTimeout(r, 250))
  assert.deepEqual(commits, [], `关闭之后不许写回，实际写了 ${JSON.stringify(commits)}`)
})

await test('F08：提交本身抛错时不重试（至多一次），但要报出来', async () => {
  const commits = []
  const errors = []
  const warns = []
  const stop = startCapturePoll({
    intervalMs: 10,
    capture: async () => ['tok-boom'],
    verify: async () => ({ ok: true }),
    commit: async (token) => {
      commits.push(token)
      throw new Error('disk full')
    },
    onError: (m) => errors.push(m),
    logger: { warn: (m) => warns.push(m) },
  })
  await new Promise((r) => setTimeout(r, 250))
  stop()
  assert.equal(commits.length, 1, `提交只尝试一次，实际 ${commits.length} 次`)
  assert.ok(errors.some((m) => m.includes('重新发起登录')), '必须告诉用户可以重新发起登录')
  assert.ok(warns.some((m) => m.includes('disk full')), '失败原因要落日志（旧写法这里是未处理拒绝）')
})

await test('F08：落库抛错时也必须消费「添加模式」（否则下一次提交会退化成切换）', async () => {
  // ⚠️ 反向验证：去掉 commitCapturedAuth add 分支的 try/finally（把 endAddAccount()
  //    放回 return 之前）→ 这条变红：模式一直挂着。
  const fsDefault = (await import('node:fs')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const originalRename = fsDefault.renameSync
  beginAddAccount()
  assert.equal(addModeActive(), true, '自证：确实进入了添加模式')
  fsDefault.renameSync = () => {
    throw Object.assign(new Error('AUDIT_F08_WRITE_FAILURE'), { code: 'EACCES' })
  }
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => commitCapturedAuth({ token: 'tok-f08', cookie: 'c' }),
      /AUDIT_F08_WRITE_FAILURE/,
      '自证：落库确实失败了（否则测的是成功路径）',
    )
    assert.equal(addModeActive(), false, '落库失败也必须消费添加模式')
  } finally {
    fsDefault.renameSync = originalRename
    syncBuiltinESMExports()
  }
})

// ── 第一轮审计 F20（中）：构建/依赖与平台契约不完整 ──
// 触发点：Windows 上只有 Node/npm、没有 Bash 时 `npm run build` 直接失败；
// 缺依赖时 `npx --yes tsdown@^0.22.14` 会联网下载，断了网就构建不了，
// 而且 `^` 是范围，同一份源码在不同时间可能解析到不同的依赖树；
// CI 只列了 7 个测试文件名（会漏跑），也没有构建。
// 这几条都是**契约**（文件里写了什么），所以直接断言文件内容 —— 改坏了立刻红。

const { readFileSync: readText } = await import('node:fs')
const { pickOfflineTests, isManualProbe } = await import('../scripts/test-files.mjs')

const PKG_ROOT = process.cwd()
const readRepoFile = (rel) => readText(join(PKG_ROOT, ...rel.split('/')), 'utf-8')

await test('F20：npm run build 必须是 Node 入口（Windows 无 Bash 也能构建）', async () => {
  // ⚠️ 反向验证：把 scripts.build 改回 `bash scripts/build.sh` → 这条变红。
  const pkg = JSON.parse(readRepoFile('package.json'))
  assert.ok(pkg.scripts.build.startsWith('node '), `build 必须是 node 入口，实际：${pkg.scripts.build}`)
  assert.ok(!/\bbash\b/.test(pkg.scripts.build), 'build 不得依赖 Bash')
  assert.ok(existsSync(join(PKG_ROOT, 'scripts', 'build.mjs')), 'scripts/build.mjs 必须存在')
  // 自证：真去读一下这个文件（否则"存在"可能只是个空壳）
  const buildScript = readRepoFile('scripts/build.mjs')
  assert.ok(buildScript.includes("from 'node:child_process'"), '自证：构建脚本应当真的起子进程')
  assert.ok(buildScript.includes('spawnSync'), '自证：用 spawnSync 调本地 tsdown')
  // 正向契约：用「当前 Node + 本地 tsdown 的 bin」，而不是让 shell 去找命令
  assert.ok(buildScript.includes('process.execPath'), 'build.mjs 必须用当前 Node 进程执行本地 tsdown')
  assert.ok(buildScript.includes("require.resolve('tsdown/package.json')"), 'build.mjs 必须解析本地 tsdown 的位置')
})

await test('F20：构建链路不得联网下载工具（去掉 npx 兜底）', async () => {
  // ⚠️ 反向验证：在 build.mjs / build.sh / prepare.mjs 里加回 `spawnSync('npx', ...)` → 变红。
  for (const rel of ['scripts/build.mjs', 'scripts/build.sh', 'scripts/prepare.mjs']) {
    const text = readRepoFile(rel)
    // 只认「把 npx 当命令调用」的形态 —— 注释里解释"为什么不用 npx"是允许的
    assert.ok(!/['"`]npx['"`]/.test(text), `${rel} 不得把 npx 当命令调用（断网就构建不了）`)
    assert.ok(!/npx\s+--yes/.test(text), `${rel} 不得出现"联网下载工具"的调用形式`)
  }
  // build.sh 只能是薄包装，实现在 build.mjs（两份实现会漂移）
  assert.ok(readRepoFile('scripts/build.sh').includes('node scripts/build.mjs'), 'build.sh 必须转调 build.mjs')
  assert.ok(readRepoFile('scripts/prepare.mjs').includes('build.mjs'), 'prepare 也必须转调 build.mjs')
})

await test('F20：开发依赖固定精确版本 + 声明 engines（有锁文件则校验同源）', async () => {
  // ⚠️ 反向验证：把 devDependencies 的版本改回 `^0.22.14` / 删掉 engines → 变红。
  const pkg = JSON.parse(readRepoFile('package.json'))
  for (const [name, range] of Object.entries(pkg.devDependencies)) {
    assert.ok(/^\d+\.\d+\.\d+$/.test(range), `${name} 必须固定精确版本，实际 ${range}`)
  }
  assert.ok(
    pkg.engines && /22\.18|24\.11/.test(pkg.engines.node),
    `必须声明 engines.node（跑 .ts 源码与 tsdown 的下限），实际 ${JSON.stringify(pkg.engines)}`,
  )
  // 锁文件与"用 npm ci 还是 npm install"必须**同时**成立，不允许自相矛盾：
  // 有锁文件 → CI 走 npm ci（可复现）；没有锁文件 → CI 必须走 npm install（npm ci 会直接失败）。
  if (existsSync(join(PKG_ROOT, 'package-lock.json'))) {
    const lock = JSON.parse(readRepoFile('package-lock.json'))
    assert.equal(lock.name, pkg.name, 'lockfile 必须与 package.json 同源')
    // 断的是 `npm ci` **真正校验**的东西：根条目的依赖要与 package.json 完全一致，
    // 否则 npm ci 会报 "can only install packages when your package.json and
    // package-lock.json are in sync" 并让整个 CI 失败。
    // ⚠️ 刻意**不**断 `lock.version === pkg.version`：npm ci 并不看这个字段，
    //    断它等于要求每次升版本都重新生成本表 —— 在这台机器上（npm 元数据很慢）
    //    会给每次发版加一道无关的摩擦。
    assert.deepEqual(
      lock.packages?.['']?.devDependencies,
      pkg.devDependencies,
      'lockfile 根条目的 devDependencies 必须与 package.json 完全一致',
    )
  } else {
    const install = readRepoFile('scripts/install-deps.mjs')
    assert.ok(install.includes('npm install'), '没有锁文件时安装脚本必须回退到 npm install')
    assert.ok(install.includes('npm ci'), '有锁文件时必须用 npm ci（这条断言保证回退不是永久的）')
  }
})

await test('F20：离线用例清单排除 probe-*（会打真实账号），且覆盖全部 check-*', async () => {
  // ⚠️ 反向验证：把 pickOfflineTests 的正则放宽成 /.*\.mjs$/ → 这条变红。
  const testsDir = join(PKG_ROOT, 'tests')
  const picked = pickOfflineTests(testsDir)
  const all = readdirSync(testsDir)
  assert.ok(picked.includes('logic-test.mjs'), '纯逻辑断言必须在清单里')
  assert.ok(picked.includes('check-round2.mjs'), '本轮用例必须在清单里')
  for (const name of picked) {
    assert.ok(!isManualProbe(name), `人工诊断脚本不许进自动化：${name}`)
  }
  // 自证：目录里**确实**有 probe-*，所以"排除"不是因为不存在
  assert.ok(all.some((n) => n.startsWith('probe-')), '自证：目录里应当有 probe-*.mjs')
  assert.equal(picked.length, all.filter((n) => /^check-.*\.mjs$/.test(n)).length + 1, 'check-* 一个都不能漏')
})

await test('F20：CI 三平台都装依赖、构建、跑全量用例，并固定 Node 小版本', async () => {
  // ⚠️ 反向验证：把 ci.yml 的 node-version 改回 `24`（范围）或删掉构建步骤 → 变红。
  const ci = readRepoFile('.github/workflows/ci.yml')
  assert.ok(ci.includes('node scripts/install-deps.mjs'), 'CI 必须装依赖（脚本内部按有无锁文件选 npm ci / npm install）')
  assert.ok(ci.includes('node scripts/build.mjs'), 'CI 必须构建（否则产物可能过期）')
  assert.ok(ci.includes('node scripts/test-offline.mjs'), 'CI 必须跑全量离线用例')
  assert.ok(
    /node-version:\s*'?\d+\.\d+\.\d+'?/.test(ci),
    'Node 版本必须固定到小版本（tsdown 要求 ^22.18.0 || >=24.11.0）',
  )
  assert.ok(ci.includes('windows-latest'), '必须覆盖 Windows（这正是「依赖 Bash」那类问题的现场）')
  // 自相矛盾检查 —— 0.1.53 的 CI/Release 就是被这条坑掉的：
  // setup-node 的 npm 缓存要求仓库里有 package-lock.json；没有锁文件时会**直接失败**
  // （"Dependencies lock file is not found"），连"装依赖"都轮不到，三个平台全红。
  // 所以"有没有锁文件"和"有没有开缓存"必须同时成立。
  // ⚠️ 正则只认 YAML 键（行首缩进后的那段）—— 别让注释里的同名文本把它喂饱：
  //    这个坑同一天踩过两次（注释里写着"不能写 npx"/"不能开缓存"，断言就命中了注释）。
  const hasLock = existsSync(join(PKG_ROOT, 'package-lock.json'))
  for (const rel of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    assert.ok(
      hasLock || !/(?:^|\n)[ \t]*cache:[ \t]*npm/m.test(readRepoFile(rel)),
      `${rel} 在没有 package-lock.json 时不能开 npm 缓存（setup-node 会直接失败）`,
    )
  }
})

await test('F20：release.yml 也用同一套工具链（发布产物与 CI 同源）', async () => {
  const rel = readRepoFile('.github/workflows/release.yml')
  assert.ok(rel.includes('node scripts/install-deps.mjs'), '发布也必须走同一个安装入口')
  assert.ok(rel.includes('node scripts/build.mjs'), '发布必须显式构建')
  assert.ok(rel.includes('node scripts/test-offline.mjs'), '发布前必须跑全量离线用例')
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
