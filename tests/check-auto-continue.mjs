/**
 * 回归：自动续写 —— 回答在句中被截时，适配器自动发起新请求接着写，
 * 拼进同一条回答；并且**永远不再报 max-tokens**（应用户要求移除「已达到输出 token 上限」提示）。
 *
 * 背景（2026-09-11 用户实测）：两个窗口共用同一网页账号时，后来的请求会抢占在生成中的流，
 * 被抢占的流以 FINISHED 收尾但正文停在句中。用户明确要求：两种模式都不要出现截断提示。
 *
 * 用法: node tests/check-auto-continue.mjs
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
  capturedAt: '2026-09-11T00:00:00.000Z',
}

/** 构造一个假流：按顺序产出 text 片段 + finish */
function fakeStream(parts, finishKind = 'stop') {
  return async function* () {
    for (const text of parts) yield { kind: 'text', text }
    yield { kind: 'finish', reason: finishKind }
  }
}

/**
 * 假流：流结束了但**没有** FINISHED 标记 = 被服务端切断。
 * 生产里 webapi 的 finish 事件带的是 `reason: pendingFinish`，没收到 `response/status: FINISHED`
 * 时它就是 undefined —— 注意不能用 fakeStream(parts, undefined)，默认参数会补成 'stop'。
 */
function cutStream(parts) {
  return async function* () {
    for (const text of parts) yield { kind: 'text', text }
    yield { kind: 'finish' }
  }
}

/** 跑一次适配器流，收集输出块 */
async function run(depsOverrides, streams) {
  const calls = []
  let callIndex = 0
  const queue = [...streams]
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined, ...(depsOverrides?.config ?? {}) },
    ...(depsOverrides?.deps ?? {}),
    streamCompletion: (auth, params) => {
      calls.push({ prompt: String(params.prompt ?? '') })
      const next = queue[callIndex]
      callIndex += 1
      if (!next) throw new Error('意外的额外请求（第 ' + callIndex + ' 次）')
      return next()
    },
  })
  const blocks = []
  let finish = null
  for await (const event of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: '写个长回答' }] }] })) {
    if (event.type === 'block-end' && event.block?.type === 'text') blocks.push(event.block.text)
    if (event.type === 'finish') finish = event.reason
  }
  return { calls, blocks, finish, callCount: callIndex }
}

await test('截断在句中 → 自动续写并无缝拼接，finish=stop', async () => {
  const { calls, blocks, finish } = await run(
    {},
    [
      fakeStream(['让我先分析这个问题的']),
      fakeStream(['完整答案如下。']),
    ],
  )
  assert.equal(calls.length, 2, `应发起 2 次请求（原文 + 续写），实际 ${calls.length}`)
  assert.equal(blocks.length, 1, '续写内容应拼进同一条回答')
  assert.equal(blocks[0], '让我先分析这个问题的完整答案如下。', `拼接结果: ${JSON.stringify(blocks)}`)
  assert.equal(finish?.kind, 'stop', '必须报 stop（不再出现 max-tokens 提示）')
})

await test('续写请求的 prompt 必须包含半截回答与继续指令', async () => {
  const { calls } = await run(
    {},
    [fakeStream(['前半句']), fakeStream(['后半句。'])],
  )
  assert.ok(calls[1].prompt.includes('前半句'), '续写 prompt 应带上已输出的半截回答')
  assert.ok(/无缝|接着写|续/.test(calls[1].prompt), '续写 prompt 应带继续指令')
})

await test('正常结束（句号收尾）不触发续写', async () => {
  const { calls, blocks, finish } = await run(
    {},
    [fakeStream(['这是完整的回答。'])],
  )
  assert.equal(calls.length, 1, '不应发起续写')
  assert.equal(blocks[0], '这是完整的回答。')
  assert.equal(finish?.kind, 'stop')
})

await test('autoContinue: false → 不续写，也报 stop（无提示）', async () => {
  const { calls, blocks, finish } = await run(
    { config: { autoContinue: false } },
    [fakeStream(['被截的回答'])],
  )
  assert.equal(calls.length, 1, '不应续写')
  assert.equal(blocks[0], '被截的回答')
  assert.equal(finish?.kind, 'stop', '即使被截也报 stop —— 那条提示必须消失')
})

await test('maxContinuations: 0 → 不续写', async () => {
  const { calls } = await run(
    { config: { maxContinuations: 0 } },
    [fakeStream(['被截的'])],
  )
  assert.equal(calls.length, 1)
})

await test('续写仍被截 → 额度内继续补，额度用尽报 stop', async () => {
  const { calls, finish } = await run(
    { config: { maxContinuations: 2 } },
    [
      fakeStream(['第一段，']),
      fakeStream(['第二段，']),
      fakeStream(['第三段完。']),
    ],
  )
  assert.equal(calls.length, 3, '原文 + 2 轮续写')
  assert.equal(finish?.kind, 'stop')
})

await test('已发起工具调用的轮次不续写（等工具结果）', async () => {
  const toolCallStream = async function* () {
    yield { kind: 'text', text: '我来查一下。\n' }
    yield { kind: 'text', text: '{"tool_calls":[{"name":"read","arguments":{"file_path":"a.txt"}}]}' }
    yield { kind: 'finish', reason: 'FINISHED' }
  }
  const { calls, finish } = await run({}, [toolCallStream])
  assert.equal(calls.length, 1, '工具调用后不应续写')
  assert.equal(finish?.kind, 'tool-calls')
})

await test('续写轮次失败 → 保留已输出部分并报 stop（不让整轮失败）', async () => {
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: {},
    streamCompletion: (auth, params) => {
      void params
      if (!globalThis.__callCount) globalThis.__callCount = 0
      globalThis.__callCount += 1
      if (globalThis.__callCount === 1) {
        return (async function* () {
          yield { kind: 'text', text: '前半句' }
          yield { kind: 'finish', reason: 'FINISHED' }
        })()
      }
      return (async function* () {
        throw Object.assign(new Error('boom'), { code: 'TRANSPORT' })
      })()
    },
  })
  const blocks = []
  let finish = null
  let threw = null
  for await (const event of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {
    if (event.type === 'block-end' && event.block?.type === 'text') blocks.push(event.block.text)
    if (event.type === 'finish') finish = event.reason
  }
  assert.equal(threw, null, `续写失败不应让整轮失败：${threw?.message}`)
  assert.equal(blocks[0], '前半句', '已输出部分保留')
  assert.equal(finish?.kind, 'stop', '报 stop（不显示截断提示）')
  delete globalThis.__callCount
})

await test('流没收到 FINISHED（服务端切断）→ 即使尾部像收尾也续写', async () => {
  const { calls, blocks, finish } = await run(
    {},
    [
      cutStream(['这是被服务端切掉的一段，结尾正好是句号。']),
      fakeStream(['补上的后半段。'], 'FINISHED'),
    ],
  )
  assert.equal(calls.length, 2, '没收到 FINISHED = 被截断，必须继续写')
  assert.equal(blocks[0], '这是被服务端切掉的一段，结尾正好是句号。补上的后半段。')
  assert.equal(finish?.kind, 'stop')
})

await test('尾部是反引号（句末判据看不出的截断）也能续写 —— 否则静默少一段', async () => {
  const { calls } = await run(
    {},
    [
      cutStream(['要我直接开跑 `dev_plugin_status` 和 `']),
      fakeStream(['`dev_plugin_job_list`。'], 'FINISHED'),
    ],
  )
  assert.equal(calls.length, 2, '旧版这里判据返回 false → 静默截断，用户只看到「和 `」就没了')
})

await test('正常收尾（收到 FINISHED + 句号结尾）不续写 —— 别把正常轮当截断', async () => {
  const { calls, finish } = await run({}, [fakeStream(['完整回答。'], 'FINISHED')])
  assert.equal(calls.length, 1, '收到 FINISHED 且尾部是句末标点 → 不该多发请求')
  assert.equal(finish?.kind, 'stop')
})

await test('轮末带网页端免责声明 → 不算句中截断，不续写；声明也不上屏', async () => {
  const DISCLAIMER = '本回答由 AI 生成，内容仅供参考，请仔细甄别'
  const { calls, blocks, finish } = await run(
    {},
    [fakeStream([`这是完整回答。\n\n${DISCLAIMER}`], 'FINISHED')],
  )
  assert.equal(calls.length, 1, '声明以「甄别」结尾 → 旧版必然误判句中、白跑一轮（甚至两轮）')
  assert.ok(!blocks[0].includes('本回答由'), `声明必须剥掉: ${JSON.stringify(blocks[0])}`)
  assert.equal(blocks[0], '这是完整回答。\n\n')
  assert.equal(finish?.kind, 'stop')
})

await test('续写轮也带声明 → 两处都不上屏，最终正文干净', async () => {
  const DISCLAIMER = '本回答由 AI 生成，内容仅供参考，请仔细甄别'
  const { calls, blocks } = await run(
    {},
    [
      cutStream([`前半段没写完`, DISCLAIMER]),
      fakeStream(['后半段写完了。', DISCLAIMER], 'FINISHED'),
    ],
  )
  assert.equal(calls.length, 2)
  assert.ok(!blocks[0].includes('本回答由'), `实际: ${JSON.stringify(blocks[0])}`)
  assert.equal(blocks[0], '前半段没写完后半段写完了。')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1