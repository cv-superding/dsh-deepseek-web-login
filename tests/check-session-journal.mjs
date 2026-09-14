/**
 * 「欠删除的会话」日志回归（2026-09-14）。
 *
 * 事故：复用槽与待删队列只活在进程内存里，宿主一退出（尤其被强杀）就静默丢失 ——
 * 正在复用的那个会话**永远不会被删**，网页端侧栏于是堆出一批标题 = DSH 会话主题的对话。
 * 实测：09-12 起启动 DSH 58 次，残留量级与启动次数相符。
 *
 * 修复由三块组成，本文件分别验证：
 *   ① `session-journal.ts`：把"还欠一次删除"的会话按账号落盘，**确认删掉才销账**；
 *   ② 启动扫尾：上次遗留的（含被强杀的）按账号补删，进程还活着的/用户不允许删的保留；
 *   ③ webapi 的生命周期事件：进槽 / 进队列 / 确认删除 —— 销账只认删除回执。
 *
 * 用法: node tests/check-session-journal.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isProcessAlive,
  planStartupSweep,
  readJournal,
  removeJournalEntry,
  runStartupSweep,
  upsertJournalEntry,
  writeJournal,
} from '../src/session-journal.ts'
import { createSessionCleaner, disposeSessionReuse, resetSessionReuse, setSessionLifecycleHook, streamWebCompletion } from '../src/webapi.ts'

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

const TEST_FILE = join(tmpdir(), `wb-journal-${process.pid}.json`)
const reset = () => {
  try {
    if (existsSync(TEST_FILE)) rmSync(TEST_FILE)
  } catch {}
}
const entry = (sessionId, over = {}) => ({
  accountId: 'acc_a',
  sessionId,
  pid: 4242,
  at: 1,
  state: 'slot',
  ...over,
})

// ── ① 文件层：往返、容错 ──────────────────────────────────────
await test('落盘往返：upsert 能读回，remove 能摘掉', () => {
  reset()
  assert.deepEqual(readJournal(TEST_FILE), [], '文件不存在时读作空')
  upsertJournalEntry({ accountId: 'acc_a', sessionId: 's1' }, TEST_FILE)
  let entries = readJournal(TEST_FILE)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, 's1')
  assert.equal(entries[0].accountId, 'acc_a')
  assert.equal(entries[0].state, 'slot', '默认 state = slot')
  assert.equal(entries[0].pid, process.pid, '默认记当前进程号')
  upsertJournalEntry({ accountId: 'acc_a', sessionId: 's1', state: 'queued' }, TEST_FILE)
  entries = readJournal(TEST_FILE)
  assert.equal(entries.length, 1, '同一 sessionId 应覆盖而不是追加')
  assert.equal(entries[0].state, 'queued')
  removeJournalEntry('s1', TEST_FILE)
  assert.deepEqual(readJournal(TEST_FILE), [])
})

await test('文件损坏 / 结构不对 → 读作空，不抛错', () => {
  reset()
  writeFileSync(TEST_FILE, '{ this is not json', 'utf8')
  assert.deepEqual(readJournal(TEST_FILE), [])
  writeFileSync(TEST_FILE, JSON.stringify({ hello: 'world' }), 'utf8')
  assert.deepEqual(readJournal(TEST_FILE), [])
})

await test('单条坏记录被丢弃，好记录照常读出', () => {
  reset()
  writeJournal([entry('good'), { accountId: '', sessionId: 'x' }, { accountId: 'a' }], TEST_FILE)
  const entries = readJournal(TEST_FILE)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, 'good')
})

await test('isProcessAlive：本进程算活着，明显不存在的 pid 算死了', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
})

// ── ② 纯决策 planStartupSweep ────────────────────────────────
const baseOpts = {
  ownPid: process.pid,
  isAlive: () => false,
  accountExists: () => true,
  deleteEnabled: true,
  mode: 'deferred',
}

await test('扫尾决策：进程已不在 + 账号还在 → 补删', () => {
  const plan = planStartupSweep([entry('s1')], baseOpts)
  assert.equal(plan.toDelete.length, 1)
  assert.equal(plan.toDelete[0].sessionId, 's1')
  assert.equal(plan.kept.length, 0)
})

await test('扫尾决策：写记录的进程还活着 → 保留（多实例共用 DSH_HOME 时别去删别人的）', () => {
  const plan = planStartupSweep([entry('s1')], { ...baseOpts, isAlive: () => true })
  assert.equal(plan.toDelete.length, 0)
  assert.equal(plan.kept.length, 1)
})

await test('扫尾决策：当前进程自己刚写的记录 → 保留', () => {
  const plan = planStartupSweep([entry('s1', { pid: process.pid })], baseOpts)
  assert.equal(plan.toDelete.length, 0, 'pid 相同就不该删')
  assert.equal(plan.kept.length, 1)
})

await test('扫尾决策：用户不许删（keep / deleteWebSessions=false）→ 保留不删', () => {
  assert.equal(planStartupSweep([entry('s1')], { ...baseOpts, mode: 'keep' }).kept.length, 1)
  assert.equal(planStartupSweep([entry('s1')], { ...baseOpts, deleteEnabled: false }).kept.length, 1)
})

await test('扫尾决策：账号已被移除 → 放弃（没有凭证，留着也删不掉）', () => {
  const plan = planStartupSweep([entry('s1')], { ...baseOpts, accountExists: () => false })
  assert.equal(plan.toDelete.length, 0)
  assert.equal(plan.dropped.length, 1)
})

// ── ③ 启动扫尾 runStartupSweep ───────────────────────────────
await test('启动扫尾：遗留会话按账号排进清理器，并在日志里说明', async () => {
  reset()
  writeJournal([entry('leftover-1')], TEST_FILE)
  const swept = []
  const logs = []
  const result = runStartupSweep({
    ...baseOpts,
    file: TEST_FILE,
    onSweep: (e) => swept.push(e.sessionId),
    log: (m) => logs.push(m),
  })
  assert.deepEqual(swept, ['leftover-1'])
  assert.equal(result.scheduled, 1)
  assert.ok(logs.some((m) => m.includes('遗留')), `应当有日志说明，实际：${JSON.stringify(logs)}`)
})

await test('启动扫尾：删除回执没来之前记录不销账（onSweep 抛错 → 留到下次）', () => {
  reset()
  writeJournal([entry('leftover-2')], TEST_FILE)
  runStartupSweep({
    ...baseOpts,
    file: TEST_FILE,
    onSweep: () => {
      throw new Error('排不进去')
    },
  })
  const left = readJournal(TEST_FILE)
  assert.equal(left.length, 1, '排不进清理器时必须保留记录，否则会话就永久留着了')
  assert.equal(left[0].sessionId, 'leftover-2')
})

await test('启动扫尾：排进清理器的记录保留到"确认删掉"，自己的记录原样留着', () => {
  reset()
  writeJournal([entry('leftover'), entry('keepme', { pid: process.pid })], TEST_FILE)
  const swept = []
  runStartupSweep({
    ...baseOpts,
    file: TEST_FILE,
    accountExists: () => true,
    onSweep: (e) => swept.push(e.sessionId),
  })
  assert.deepEqual(swept, ['leftover'], '只补删"进程已不在"的那条')
  assert.deepEqual(
    readJournal(TEST_FILE).map((e) => e.sessionId).sort(),
    ['keepme', 'leftover'],
    '补删只是排队，删除回执还没来 → 两条都应还在文件里',
  )
  // 删除回执到达（webapi 的 deleted 事件）→ 销账
  removeJournalEntry('leftover', TEST_FILE)
  assert.deepEqual(readJournal(TEST_FILE).map((e) => e.sessionId), ['keepme'])
})

await test('启动扫尾：账号已被移除的记录被丢弃（没凭证，留着也删不掉）', () => {
  reset()
  writeJournal([entry('orphan', { accountId: 'acc_deleted' })], TEST_FILE)
  const result = runStartupSweep({
    ...baseOpts,
    file: TEST_FILE,
    accountExists: (id) => id === 'acc_a',
    onSweep: () => assert.fail('账号没了不该去删'),
  })
  assert.equal(result.dropped, 1)
  assert.deepEqual(readJournal(TEST_FILE), [], '删不掉的孤儿记录应当被清掉，不然永远躺在文件里')
})

await test('启动扫尾：文件为空时什么都不做', () => {
  reset()
  const result = runStartupSweep({ ...baseOpts, file: TEST_FILE, onSweep: () => assert.fail('不该被调用') })
  assert.deepEqual(result, { scheduled: 0, dropped: 0, kept: 0 })
})

// ── ④ 事件链：进队列 / 确认删除（销账只认删除回执）────────────
const AUTH = { token: 'tok', cookie: 'c=1', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua' }

function fakeFetch(results) {
  const plan = [...results]
  const impl = async () => {
    const next = plan.shift() ?? { ok: true }
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => next.text ?? JSON.stringify({ code: 0, msg: '', data: {} }),
    }
  }
  return impl
}

/** 立即触发的假定时器，避免用例依赖真实等待。 */
function makeTimers() {
  const pending = []
  return {
    set: (fn) => {
      pending.push(fn)
      return pending.length
    },
    clear: () => {},
    fire: () => {
      const all = pending.splice(0)
      for (const fn of all) fn()
    },
  }
}

await test('事件链：入队发 queued，删成功才发 deleted（销账）', async () => {
  const events = []
  setSessionLifecycleHook((e) => events.push(e))
  try {
    const timers = makeTimers()
    const cleaner = createSessionCleaner({
      policy: { mode: 'immediate', delayMs: 1_500, batchSize: 1 },
      fetchImpl: fakeFetch([{ ok: true }]),
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
    })
    cleaner.schedule(AUTH, 'S-del')
    assert.deepEqual(events.map((e) => e.kind), ['queued'], '入队要立刻落账')
    timers.fire()
    await cleaner.flush()
    assert.deepEqual(events.map((e) => e.kind), ['queued', 'deleted'], '删成功要销账')
    assert.equal(events[1].sessionId, 'S-del')
  } finally {
    setSessionLifecycleHook(undefined)
  }
})

await test('事件链：删除被服务端拒绝 → 不发 deleted（记录留着，下次启动补删）', async () => {
  const events = []
  setSessionLifecycleHook((e) => events.push(e))
  try {
    const cleaner = createSessionCleaner({
      policy: { mode: 'immediate', delayMs: 1, batchSize: 1 },
      // HTTP 200 但裹着业务错误信封 —— 网页端就是这么表达"其实没删掉"的
      fetchImpl: fakeFetch([{ ok: true, text: '{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"nope"}}' }]),
      setTimeoutImpl: () => 1,
      clearTimeoutImpl: () => {},
    })
    cleaner.schedule(AUTH, 'S-fail')
    await cleaner.flush()
    assert.deepEqual(events.map((e) => e.kind), ['queued'], '没删掉就不能销账')
  } finally {
    setSessionLifecycleHook(undefined)
  }
})

await test('事件链：会话进入复用槽时发 leased（否则强杀必留一个）', async () => {
  resetSessionReuse()
  const events = []
  setSessionLifecycleHook((e) => events.push(e))
  const realFetch = globalThis.fetch
  try {
    const transport = {
      createSession: async () => 'S-slot',
      powHeader: async () => 'pow',
    }
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"p":"response/content","v":"hi"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n'),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    for await (const _ of streamWebCompletion(
      AUTH,
      { prompt: 'hi', thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 5_000, sessionReuseTurns: 1 },
      transport,
    )) {
      /* 只关心事件 */
    }
    const leased = events.filter((e) => e.kind === 'leased')
    assert.equal(leased.length, 1, `应当恰好有一条 leased，实际：${JSON.stringify(events.map((e) => e.kind))}`)
    assert.equal(leased[0].sessionId, 'S-slot')
    assert.equal(leased[0].auth?.token, 'tok', '必须带上凭证，落盘时要据此判账号')
  } finally {
    globalThis.fetch = realFetch
    setSessionLifecycleHook(undefined)
    resetSessionReuse()
  }
})

// ── ⑤ 退出收尾：槽里的会话必须被交出去（这条就是事故本身）────────
await test('退出收尾：disposeSessionReuse 把槽里的会话交回清理回调（不再白丢一个）', async () => {
  resetSessionReuse()
  const wanted = []
  const realFetch = globalThis.fetch
  try {
    const transport = { createSession: async () => 'S-dispose', powHeader: async () => 'pow' }
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"p":"response/content","v":"hi"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n'),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    for await (const _ of streamWebCompletion(
      AUTH,
      {
        prompt: 'hi',
        thinkingEnabled: false,
        modelType: 'default',
        idleTimeoutMs: 5_000,
        sessionReuseTurns: 20,
        onDeleteSession: (id) => wanted.push(id),
      },
      transport,
    )) {
      /* 只关心收尾 */
    }
    assert.deepEqual(wanted, [], '请求正常跑完时槽里的会话还要复用，不该删')
    // 模拟宿主卸载/退出
    assert.equal(disposeSessionReuse(), 'S-dispose', '应当返回被退役的会话 id')
    assert.deepEqual(wanted, ['S-dispose'], '退出收尾必须把它交出去 —— 旧实现直接清槽，于是"每跑一次白留一个"')
    assert.equal(disposeSessionReuse(), undefined, '槽已空，再调无副作用')
  } finally {
    globalThis.fetch = realFetch
    resetSessionReuse()
  }
})

reset()
console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
