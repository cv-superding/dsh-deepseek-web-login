/**
 * 持久化的**生命周期边界**守卫（0.7.5）。
 *
 * ## 为什么需要这个文件
 *
 * 0.6.43 给会话槽与链加了 `resume-state.json` 落盘，好让"重启后仍能续上同一会话"。
 * 但 `disposeSessionReuse()` 是**卸载钩子**（`index.ts` 的 `ctx.effect(() => () => …）`），
 * 它 `clear()` 内存之后**紧接着 `persistResumeState()`** ⇒ **把空态写回文件**
 * ⇒ **每次退出 DSH，持久化状态都被自己抹掉**。
 *
 * ## 为什么之前一直是绿的
 *
 * - `check-resume-after-restart` 只测**「进程 → 进程」**，**不经过卸载钩子**；
 * - `check-bundle` 守的是"落盘点存在"，**不守"落盘的内容对不对"**。
 *
 * ⚠️ **加了持久化就必须测「退出 → 启动」这个边界** —— 这是本文件唯一的目的。
 *
 * ## 判据
 *
 * 每条都断言**落盘文件里的内容**，不是断源码里有没有那行调用。
 * 已做变异验证：把任一 `persist: false` 改回 `persistResumeState()` ⇒ 对应用例立刻红。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
async function test(name, fn) {
  const HOME = mkdtempSync(join(tmpdir(), 'dswl-persist-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    await fn(HOME)
    results.push({ name, ok: true })
  } catch (e) {
    results.push({ name, ok: false, err: e?.message ?? String(e) })
  } finally {
    process.env.DSH_HOME = prev
    rmSync(HOME, { recursive: true, force: true })
  }
}

const statePath = (home) => join(home, 'web-login', 'resume-state.json')
const readState = (home) => JSON.parse(readFileSync(statePath(home), 'utf8'))

/** 让内存里有内容：借 leaseSession 走一次真实流程（读 src，不猜API）。 */
async function seed(home) {
  process.env.DSH_HOME = home
  const mod = await import('../src/webapi.ts?seed=' + Math.random())
  return mod
}

// ── 1. 退出钩子不许抹掉落盘 ────────────────────────────────
await test('disposeSessionReuse（退出钩子）不许把空态写回 resume-state.json', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'dswl-p1-'))
  process.env.DSH_HOME = HOME
  try {
    const mod = await import('../src/webapi.ts?p1=' + Math.random())
    // 先落一份**非空**状态（复用槽 + 链），模拟"聊了一会儿"
    const { writeResumeStateForTest } = mod
    assert.ok(typeof writeResumeStateForTest === 'function', '需要一个测试入口来写非空落盘态')
    writeResumeStateForTest({
      slots: [{ key: 'k1', sessionId: 'sess-1', turns: 3, at: Date.now() }],
      chains: [
        {
          key: 'k1',
          state: { head: 'HEAD', entries: ['User: 问', 'Assistant: 答'], parentId: 11, sessionId: 'sess-1', accountKey: 'a' },
        },
      ],
    })
    const before = readState(HOME)
    assert.equal(before.slots.length, 1, '前置：落盘里应有 1 个槽')
    assert.equal(before.chains.length, 1, '前置：落盘里应有 1 条链')

    // 🔴 这一步就是"退出 DSH"会走的路
    mod.disposeSessionReuse()

    assert.ok(existsSync(statePath(HOME)), '文件不该被删（那是另一种修法，这里只要求不被写空）')
    const after = readState(HOME)
    assert.equal(after.slots.length, 1, `退出后槽不该被抹掉，实际 ${JSON.stringify(after.slots)}`)
    assert.equal(after.chains.length, 1, `退出后链不该被抹掉，实际 ${JSON.stringify(after.chains)}`)
    assert.equal(after.chains[0].state.entries.length, 2, '链的条目不该丢')
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
})

// ── 2. resetSessionReuse 同理 ──────────────────────────────
await test('resetSessionReuse 也不许把空态写回', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'dswl-p2-'))
  process.env.DSH_HOME = HOME
  try {
    const mod = await import('../src/webapi.ts?p2=' + Math.random())
    mod.writeResumeStateForTest({
      slots: [{ key: 'k1', sessionId: 'sess-1', turns: 2, at: Date.now() }],
      chains: [],
    })
    mod.resetSessionReuse()
    const after = readState(HOME)
    assert.equal(after.slots.length, 1, `reset 后槽不该被抹掉，实际 ${JSON.stringify(after.slots)}`)
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
})

// ── 3. resetContextChain 同理 ──────────────────────────────
await test('resetContextChain 也不许把空态写回', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'dswl-p3-'))
  process.env.DSH_HOME = HOME
  try {
    const mod = await import('../src/webapi.ts?p3=' + Math.random())
    mod.writeResumeStateForTest({
      slots: [],
      chains: [{ key: 'k1', state: { head: 'H', entries: ['User: x'], parentId: 1, sessionId: 's1', accountKey: 'a' } }],
    })
    mod.resetContextChain()
    const after = readState(HOME)
    assert.equal(after.chains.length, 1, `reset 后链不该被抹掉，实际 ${JSON.stringify(after.chains)}`)
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
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