/**
 * 回归：一次调用的成败/限制必须记到**发起时**那个账号上（F05）。
 *
 * 旧实现由宿主在上报时现取 `activeAccountId()`。而一次流式调用可能飞几十秒，
 * 期间用户完全可能切号 —— 于是"被限制的号反而清白，正在用的号背了别人的处罚"：
 * 台账与「限制还剩多久」全都指错了人。
 *
 * 修法：适配器在**起飞前**调一次 `currentAccountId()`，结果随 noteCall 回传；
 * 宿主只在拿不到时才回退到"此刻"的当前账号。
 *
 * 用法: node tests/check-call-attribution.mjs
 */
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const AUTH = {
  token: 't'.repeat(64),
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
}

/**
 * 跑一次调用。switchDuringFlight=true 时在流产出期间把"当前账号"改掉，
 * 模拟用户趁生成时切号。
 */
async function runOnce({ switchDuringFlight, fail = false }) {
  let current = 'acc_before'
  const noted = []
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: {},
    currentAccountId: () => current,
    noteCall: (info) => {
      noted.push(info)
    },
    streamCompletion: () => (async function* () {
      if (switchDuringFlight) current = 'acc_after'
      yield { kind: 'text', text: '一段回答' }
      if (fail) throw Object.assign(new Error('muted'), { code: 'MUTED' })
      yield { kind: 'finish', reason: 'FINISHED' }
    })(),
  })
  let threw = null
  try {
    for await (const _ of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) void _
  } catch (error) {
    threw = error
  }
  return { noted, threw, finalCurrent: current }
}

await test('F05：飞行途中切号 → 上报的必须是**发起时**的账号', async () => {
  const { noted, finalCurrent } = await runOnce({ switchDuringFlight: true })
  assert.equal(finalCurrent, 'acc_after', '这条用例应当真的切了号（否则没测到东西）')
  assert.equal(noted.length, 1, '应当上报一次')
  assert.equal(noted[0].accountId, 'acc_before', '应当记到发起时的账号，而不是切号后的')
})

await test('F05：失败路径也记到发起时的账号（限制状态同理）', async () => {
  const { noted } = await runOnce({ switchDuringFlight: true, fail: true })
  assert.ok(noted.length >= 1, '失败也应当上报')
  const last = noted[noted.length - 1]
  assert.equal(last.ok, false)
  assert.equal(last.accountId, 'acc_before')
})

await test('F05：没切号时上报的就是当前账号（别矫枉过正）', async () => {
  const { noted } = await runOnce({ switchDuringFlight: false })
  assert.equal(noted[0].accountId, 'acc_before')
})

await test('F05：宿主没注入 currentAccountId 时也能工作（可选依赖）', async () => {
  const noted = []
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: {},
    noteCall: (info) => noted.push(info),
    streamCompletion: () => (async function* () {
      yield { kind: 'text', text: 'x' }
      yield { kind: 'finish', reason: 'FINISHED' }
    })(),
  })
  for await (const _ of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) void _
  assert.equal(noted.length, 1)
  assert.equal(noted[0].accountId, undefined, '没注入时 accountId 为 undefined，宿主会回退到 activeAccountId()')
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
