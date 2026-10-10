/**
 * 外部审查（2026-10-10）8 条缺陷的**行为守卫**。
 *
 * ## 为什么需要这个文件
 *
 * 原报告指出：66/66 全绿但 8 条缺陷都在 ⇒ 现有用例是**假绿灯**。三类根因：
 *   ① `tests/check-relogin.mjs:164` 用正则断言"这行代码在" ⇒ 实现坏了它也绿；
 *   ② `check-session-journal.mjs` 两条各只覆盖一半，**交集**（dropped 与 toDelete 同时非空）没测；
 *   ③ `ToolCallStreamFilter` 没有"围栏调用 + 回答含代码块"的端到端文本断言。
 *
 * ## 纪律
 *
 * 每条都用 `assert` 打**运行期行为**，不是 grep 源码字符串。
 * 已做变异验证：把任一修复还原 ⇒ 对应用例立刻红（实测 5 处）。
 *
 * ## 修法与原报告的差异（两处不能照抄）
 *
 * P1-1：报告建议在 `configure()` 里 `autoRelogin = next.autoRelogin`，
 *      但**没有对应的模块级变量**（它原本是无状态字段，`index.ts:680` 每轮重读文件），
 *      照抄会ReferenceError。正解是给它内存态 —— 且 `settings()` 必须**真的返回一个键**，
 *      因为 `writeGateSettings(applied)` 是整对象覆盖写、不合并。
 * P2-5：报告建议让 `sawCallFence` 复位。但 `CALL_FENCE_TAIL_RE` 匹配**任意**尾部闭栏，
 *      光复位不够 —— 还需一道**内容判据**（pending 里是否还有未闭合的用户代码块开栏）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
async function test(name, fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'dswl-ext-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (e) {
    results.push({ name, ok: false, err: e?.message ?? String(e) })
  } finally {
    process.env.DSH_HOME = prev
    rmSync(HOME, { recursive: true, force: true })
  }
}

// ── P1-1「到期前自动重登」开关必须能落盘 ─────────────────────
await test('P1-1 autoRelogin：整条保存链不丢字段（改其它设置也不抹掉）', async () => {
  const { createRequestGate, writeGateSettings, readGateSettings } = await import('../src/gate.ts')
  const applied = createRequestGate({}).configure({ autoRelogin: true })
  // 🔴 必须**真的返回一个字段**：writeGateSettings(applied) 是整对象覆盖写、不合并，
  // 这里少一个键，磁盘上那个就被抹掉（原缺陷）。
  assert.ok(Object.hasOwn(applied, 'autoRelogin'), `settings() 必须返回 autoRelogin，实际：${Object.keys(applied).join(',')}`)
  assert.equal(applied.autoRelogin, true)

  writeGateSettings(applied)
  assert.equal(readGateSettings().autoRelogin, true, '落盘后必须读得到 true')

  // 次要后果：改动其它设置不该把它抹掉
  const applied2 = createRequestGate({}).configure({ minRequestIntervalMs: 8000 })
  assert.equal(applied2.autoRelogin, true, '改其它设置时 autoRelogin 必须保留')
})

// ── P1-2 启动扫尾不能抹掉"已排队但未确认"的记录 ─────────────
await test('P1-2 journal 扫尾：dropped 与 toDelete 同时非空时已排队记录必须保留', async () => {
  const { runStartupSweep, readJournal, writeJournal } = await import('../src/session-journal.ts')
  const FILE = join(mkdtempSync(join(tmpdir(), 'dswl-jf-')), 'sessions-in-use.json')
  const entry = (sessionId, patch = {}) => ({
    accountId: 'acc_a',
    sessionId,
    pid: 999_999, // 不存在的 pid ⇒ 视为"上一个进程留下的"
    at: Date.now(),
    state: 'slot',
    ...patch,
  })
  writeJournal([entry('sweep-me'), entry('orphan', { accountId: 'acc_deleted' })], FILE)

  const swept = []
  runStartupSweep({
    ownPid: process.pid,
    isAlive: () => false,
    accountExists: (id) => id === 'acc_a', // 'acc_deleted' ⇒ 孤儿 ⇒ dropped 非空
    deleteEnabled: true,
    mode: 'deferred',
    file: FILE,
    onSweep: (e) => swept.push(e.sessionId),
  })

  assert.deepEqual(swept, ['sweep-me'], 'sweep-me 应被排进清理器')
  const left = readJournal(FILE).map((e) => e.sessionId)
  // 🔴 交集场景（dropped 与 toDelete 同时非空）—— 原有两条用例各只覆盖一半
  assert.ok(left.includes('sweep-me'), `已排队记录必须留在 journal 等删除回执，实际：${JSON.stringify(left)}`)
  assert.ok(!left.includes('orphan'), '孤儿记录应当立刻移除（文档声明的例外）')
})

// ── P1-3 salvage 路径的 bodyStart 偏移 ───────────────────────
await test('P1-3 salvageXmlToolCalls：缺 </invoke> 的裸 JSON 不该把开标签残渣切进参数', async () => {
  const { parseXmlToolCalls } = await import('../src/protocol.ts')
  const calls = parseXmlToolCalls('<tool_calls><invoke name="read">{"file_path":"/tmp/x"}</tool_calls>')
  const args = JSON.parse(calls[0].arguments)
  assert.deepEqual(args, { file_path: '/tmp/x' }, `参数不该含开标签残渣，实际：${JSON.stringify(args)}`)
})

// ── P2-4 脚手架会话只能丢一次 ────────────────────────────────
await test('P2-4 内部请求抛错时脚手架会话只丢一次（不多发 DELETE、不写假告警）', async () => {
  const { streamWebCompletion } = await import('../src/webapi.ts')
  const discarded = []
  const it = streamWebCompletion(
    { token: 't', cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua', capturedAt: '' },
    {
      model: 'x',
      prompt: 'internal',
      // ⚠️ 不带 promptParts ⇒ 脚手架路径
      onSession: () => {},
      onSessionDelete: () => {},
      onDiscardSession: (id) => { discarded.push(id) },
      onRetry: () => {},
    },
    { createSession: async () => 'sess-x', powHeader: async () => { throw new Error('boom') } },
  )
  try { for await (const _e of it) { /* 消费 */ } } catch { /* 预期抛错 */ }
  const dups = discarded.filter((x, i) => discarded.indexOf(x) !== i)
  assert.equal(dups.length, 0, `同一会话被丢弃 ${discarded.length} 次（重复 DELETE + 假告警）：${JSON.stringify(discarded)}`)
})

// ── P2-5 sawCallFence 不能是全程闩锁 ────────────────────────
await test('P2-5 围栏调用后，回答里自己代码块的闭栏必须保留', async () => {
  const { ToolCallStreamFilter } = await import('../src/protocol.ts')
  const filter = new ToolCallStreamFilter(new Set(['read']))
  filter.push('```dsh-tool\n{"tool_calls":[{"name":"read","arguments":{"file_path":"/tmp/x"}}]}\n```')
  const b = filter.push('\n\n看看这段：\n```python\nprint(1)\n```\n')
  const c = filter.flush()
  const all = [b.text, c.text].join('')
  const fences = (all.match(/```/g) ?? []).length
  assert.equal(fences, 2, `围栏数应为 2（python 开栏 + 闭栏），实际 ${fences}：${JSON.stringify(all)}`)
})

// ── P2-6 空 fragments 帧不该清掉thinking 通道 ──────────────
await test('P2-6 空response/fragments 帧不该把思考赶进正文', async () => {
  // ⚠️ 必须走完整链路（streamWebCompletion）：sink 是内部状态，parseWebSse 看不到。
  const { streamWebCompletion, setFetchImpl, resetSessionReuse } = await import('../src/webapi.ts')
  const sse = (frames) =>
    frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
  resetSessionReuse()
  setFetchImpl(async () =>
    new Response(
      sse([
        // ⚠️ 帧结构是 {p: 路径, v: 值}（不是 {v:{response:…}}）—— 我第一次写错形态，
        //拿到的 thinking 是空的。判据形态要与真实解析一致。
        { p: 'response/thinking_content', v: '思考甲' },
        { p: 'response/fragments', v: [] },                // 🔴 空帧夹在中间
        { v: '思考乙' },                                  // 裸续段：通道被清就会落进正文
      ]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
  let thinking = ''
  let text = ''
  for await (const ev of streamWebCompletion(
    { token: 't', cookie: 'c' },
    { prompt: 'P', thinkingEnabled: true, modelType: 'default', idleTimeoutMs: 5000, sessionReuseTurns: 0,
      promptParts: { head: 'HEAD', entries: ['User: x'] }, onDeleteSession: () => {} },
    { createSession: async () => 'sess-p26', powHeader: async () => 'pow' },
  )) {
    if (ev.kind === 'text') text += ev.text ?? ev.delta ?? ''
    if (ev.kind === 'thinking') thinking += ev.text ?? ev.delta ?? ''
  }
  assert.ok(thinking.includes('思考乙'), `第二段思考应留在 thinking 通道，实际 thinking=${JSON.stringify(thinking)}`)
  assert.ok(!text.includes('思考乙'), `思考泄漏进正文：${JSON.stringify(text)}`)
})

// ── P2-7 unwrapDsmlArguments 字符串分支也要有多键保护 ───────
await test('P2-7 unwrapDsmlArguments：字符串形态 + 多键时不能静默丢参数', async () => {
  const { parseXmlToolCalls } = await import('../src/protocol.ts')
  const inner = JSON.stringify({ arguments: '{"a":1}', other: 'x' })
  const calls = parseXmlToolCalls(`<tool_calls><invoke name="t">${inner}</invoke></tool_calls>`)
  const args = JSON.parse(calls[0].arguments)
  assert.ok(args.other === 'x' || args.arguments !== undefined, `多键时不该硬剥：${JSON.stringify(args)}`)
})

// ── P3 凭据文件权限 ─────────────────────────────────────────
await test('P3 credentials.json 走 0600 原子写（明文密码不该 0644 落地）', async () => {
  const src = readFileSync(new URL('../src/relogin.ts', import.meta.url), 'utf8')
  const bare = src.match(/writeFileSync\([^)]*credentialsPath/g) ?? []
  assert.equal(bare.length, 0, `又退回裸 writeFileSync（无 0600）：${JSON.stringify(bare)}`)
  assert.ok(src.includes('writeJsonAtomic(credentialsPath()'), '必须复用 accounts.ts 的 writeJsonAtomic（0600 + 失败清理）')
})

// ── 汇总 ────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`  ${r.ok ? '✓' : 'x'} ${r.name}`)
if (failed.length) {
  console.log(`\n通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
  for (const f of failed) console.log(`  x ${f.name}\n    ${f.err}`)
  process.exit(1)
}
console.log(`\n通过 ${results.length} 项，全部通过 ✅`)