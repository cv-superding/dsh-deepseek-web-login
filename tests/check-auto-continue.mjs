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
  const deltas = []
  let finish = null
  let usage = null
  for await (const event of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: '写个长回答' }] }] })) {
    if (event.type === 'block-end' && event.block?.type === 'text') blocks.push(event.block.text)
    if (event.type === 'text-delta') deltas.push(event.text)
    if (event.type === 'finish') finish = event.reason
    if (event.type === 'usage') usage = event.usage
  }
  return { calls, blocks, deltas, finish, usage, callCount: callIndex }
}

/** 假流：可带上服务端上报的本消息 token 总量（`totalTokens`）。 */
function fakeStreamUsage(parts, total, finishKind = 'stop') {
  return async function* () {
    for (const text of parts) yield { kind: 'text', text }
    yield { kind: 'finish', reason: finishKind, ...(total === undefined ? {} : { totalTokens: total }) }
  }
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

await test('账号节流（RATE_LIMIT/throttled）→ 文案说限流，别说成「另一个窗口正在生成」', async () => {
  // 现场（2026-09-11 16:11）：SSE error「消息发送过于频繁，请稍后重试」
  const throttleStream = async function* () {
    yield {
      kind: 'error',
      message: '消息发送过于频繁，请稍后重试',
      code: 'RATE_LIMIT',
      retryAfterMs: 20_000,
      rateLimitKind: 'throttled',
    }
  }
  const adapter = createAdapter({ getAuth: () => AUTH, config: {}, streamCompletion: () => throttleStream() })
  let thrown = null
  try {
    for await (const _ of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) void _
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '必须抛出（不能假装成功）')
  assert.equal(thrown.code, 'RATE_LIMIT', '要归到可自动退避重试的那一类')
  assert.match(String(thrown.message), /限流|频繁/, `文案应说明是限流：${thrown.message}`)
  assert.ok(!/另一个窗口/.test(String(thrown.message)), '两种 RATE_LIMIT 成因不同，文案不能串台')
  assert.ok(
    (thrown.failure?.providerRetryAfterMs ?? 0) >= 20_000,
    '必须把退避时间透给重试策略',
  )
})

// ── 第二轮审计 N06（中）：自动续写只部分上报 usage 时，未上报轮次成本被漏记 ──────
// 触发条件：一个逻辑调用发生续写，部分请求 finish 带 totalTokens、另一些没有。
// 旧实现是「整次调用二选一」(`reportedTokens > 0 ? ... : estimateTokens(prompt)`)，只要一轮
// 有值，其它轮的输入就从账本消失 —— 复现时第一轮上报 1000、第二轮不上报，总量恰好还是 1000。
const NL = String.fromCharCode(10)

await test('N06：部分轮次上报 totalTokens 时，未上报轮次的成本仍要计入', async () => {
  const { calls, usage } = await run(
    {},
    [
      fakeStreamUsage(['让我先分析这个问题的'], 1000), // 第一轮：上报 1000
      fakeStreamUsage(['完整答案如下。'], undefined), // 第二轮：不上报
    ],
  )
  // 自证：必须真的发生了两轮（否则下面的断言会因为"少了一轮"而静默通过）
  assert.equal(calls.length, 2, `必须发生两次真实请求，实际 ${calls.length}`)
  assert.ok(usage, '必须上报 usage')
  const total = usage.inputTokens + usage.outputTokens
  // 旧实现这里恰好等于 1000（= max(0, 1000 - 输出估算) + 输出估算）；
  // 新实现要把第二轮 prompt 与输出的估算也算进去 → 必须 > 1000。
  assert.ok(
    total > 1000,
    `未上报轮次不能被漏记：总量 ${total} 应大于第一轮上报的 1000` +
      `（input=${usage.inputTokens} / output=${usage.outputTokens}）`,
  )
})

await test('N06：两轮都上报时，总量等于上报值之和', async () => {
  const { calls, usage } = await run(
    {},
    [fakeStreamUsage(['半截'], 1000), fakeStreamUsage(['收尾。'], 2000)],
  )
  assert.equal(calls.length, 2, `必须发生两次真实请求，实际 ${calls.length}`)
  assert.equal(usage.inputTokens + usage.outputTokens, 3000, '两轮都上报时应精确相加')
})

// ── 第二轮审计 N03（高）：已知 tool_result 跨流片段仍泄漏到正文 ────────────────
// 根因：adapter 原本对 `guarded.text` 调**无状态**的 stripSystemMarkers ——
// 完整字符串上的跨行正则正确，不代表跨 push 有效：开始标签、正文、结束标签落在
// 不同调用里就失去共同上下文。现在改走有状态的 SystemMarkerStreamFilter。
const SECRET = 'SECRET-TOKEN-DO-NOT-LEAK'
const secretBody = Array.from({ length: 4 }, (_, i) => `${i + 1}: ${SECRET}-${'x'.repeat(24)}`).join(NL)
const LEAKY = [
  '开始说话。',
  '下面是要点。',
  '',
  '<tool_result>',
  '<path>F:/x/y.ts</path>',
  '<type>file</type>',
  '<content>',
  secretBody,
  '</content>',
  '</tool_result>',
  '',
  '就这样。',
].join(NL)

function assertNoLeak(text, label) {
  assert.ok(!text.includes(SECRET), `${label}：正文里不该出现 SECRET（尾部 ${JSON.stringify(text.slice(-70))}）`)
  assert.ok(!text.includes('tool_result'), `${label}：正文里不该出现 tool_result 标签`)
  // 自证：真的走过了剥离逻辑，而不是「整段被吞掉」或「压根没输出」
  assert.ok(text.includes('开始说话'), `${label}：正文开头必须保留（实际 ${JSON.stringify(text.slice(0, 60))}）`)
  assert.ok(text.includes('就这样'), `${label}：正文结尾必须保留（实际 ${JSON.stringify(text.slice(-60))}）`)
}

await test('N03：一包送入时，长 tool_result 回声不上屏、正文两端保留', async () => {
  const { calls, blocks } = await run({}, [fakeStream([LEAKY])])
  assert.equal(calls.length, 1, '不应触发续写')
  assertNoLeak(blocks.join(''), '一包')
})

await test('N03：逐字符送入时与一包严格相同（这是原版真正失败的那条）', async () => {
  const single = await run({}, [fakeStream([LEAKY])])
  const perChar = await run({}, [fakeStream([...LEAKY])])
  assert.equal(perChar.calls.length, 1, '不应触发续写')
  assertNoLeak(perChar.blocks.join(''), '逐字符')
  assert.equal(perChar.blocks.join(''), single.blocks.join(''), '逐字符与一包必须产出完全相同的正文')
})

await test('N03：任意单切分点都必须安全（遍历全部切分位置）', async () => {
  const baseline = (await run({}, [fakeStream([LEAKY])])).blocks.join('')
  let checked = 0
  for (let cut = 1; cut < LEAKY.length; cut += 1) {
    const parts = [LEAKY.slice(0, cut), LEAKY.slice(cut)].filter((s) => s.length > 0)
    const { blocks } = await run({}, [fakeStream(parts)])
    const text = blocks.join('')
    assert.equal(text, baseline, `切分点 ${cut} 的正文与一包不一致`)
    assertNoLeak(text, `切分点 ${cut}`)
    checked += 1
  }
  // 自证：真的遍历了（避免循环没跑起来却"通过"）
  assert.ok(checked > 200, `应遍历全部切分点，实际只有 ${checked} 个`)
})

await test('N03：围栏代码块里的示例要保留（不能误剥）', async () => {
  const fenced = [
    '看这个例子：',
    '```xml',
    '<tool_result>',
    '<content>',
    secretBody,
    '</content>',
    '</tool_result>',
    '```',
    '以上。',
  ].join(NL)
  const single = await run({}, [fakeStream([fenced])])
  const perChar = await run({}, [fakeStream([...fenced])])
  for (const [label, blocks] of [
    ['一包', single.blocks],
    ['逐字符', perChar.blocks],
  ]) {
    const text = blocks.join('')
    assert.ok(text.includes('tool_result'), `${label}：围栏内的示例是给人看的，不该剥掉`)
    assert.ok(text.includes(SECRET), `${label}：围栏内的示例内容不该被剥掉`)
  }
  assert.equal(perChar.blocks.join(''), single.blocks.join(''), '围栏用例也要分包不变')
})

await test('N03：无换行回答的上屏节奏（记录现状：轮末一次上屏）', async () => {
  // ⚠️ 这是**既存行为**，不是本轮引入：上游 TranscriptEchoGuard 逐行分类（只按换行符切行），
  // 没有换行时它把整段扣在 pending 里直到 flush —— adapter 于是只在轮末拿到一段。
  // 实测：60 字符、全程无换行的回答，流内一个 text-delta 都不会有。
  // 要真正逐字上屏，需要给 echoGuard 也加"安全前缀"（还要保证行内回声判据的前缀不被误放），
  // 风险较高，本轮**未**处理。这条用例用来记录现状：哪天改了，它会提醒同步更新。
  const noNl = '这是一段全程没有换行的回答，用户应当像打字机一样看到它逐步出现。'
  const { blocks, deltas } = await run({}, [fakeStream([...noNl])])
  assert.equal(blocks.join(''), noNl, '内容必须完整（自证：确实走完了这段逻辑）')
  assert.equal(deltas.length, 1, '现状：整段在轮末一次上屏')
})

await test('N03：SystemMarkerStreamFilter 自身对无换行文本立即吐字（安全前缀）', async () => {
  const { SystemMarkerStreamFilter } = await import('../src/protocol.ts')
  const f = new SystemMarkerStreamFilter()
  // 无 '<'、非围栏候选 → 可以立刻上屏（否则整段会缓冲到轮末）
  assert.equal(f.push('这是一段没有换行的文字').text, '这是一段没有换行的文字', '安全前缀应立刻输出')
  const g = new SystemMarkerStreamFilter()
  // 含 '<' 时必须停住 —— 它可能是某个标记的开头（半截标记吐出去就是泄漏）
  assert.equal(g.push('前面正常 <').text, '', '含尖括号时必须缓冲')
  assert.equal(g.flush().text, '前面正常 <', '轮末兜底要把它吐回来（不能吞正文）')
  const h = new SystemMarkerStreamFilter()
  // 围栏候选开头也必须停住（否则围栏状态会丢）
  assert.equal(h.push('``').text, '', '围栏候选开头必须缓冲')
})

await test('N03：无换行回答里出现尖括号时要退回缓冲（不能提前吐出半截标记）', async () => {
  // 安全前提是「剩余部分不含任何标记起始字符」。含 '<' 时必须停下等换行，
  // 否则可能把 `<tool_result>` 的前半截提前放出去。
  const text = '先写一段普通文字' + NL + '<tool_result>' + NL + '<content>' + NL + secretBody + NL + '</content>' + NL + '</tool_result>'
  const single = await run({}, [fakeStream([text])])
  const perChar = await run({}, [fakeStream([...text])])
  for (const [label, blocks] of [['一包', single.blocks], ['逐字符', perChar.blocks]]) {
    assert.ok(!blocks.join('').includes('tool_result'), `${label}：不该泄漏 tool_result`)
    assert.ok(!blocks.join('').includes(SECRET), `${label}：不该泄漏 SECRET`)
    assert.ok(blocks.join('').includes('先写一段普通文字'), `${label}：正文必须保留`)
  }
  assert.equal(perChar.blocks.join(''), single.blocks.join(''), '分包不变性')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1