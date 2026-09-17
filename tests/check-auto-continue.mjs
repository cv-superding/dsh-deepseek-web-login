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
async function run(depsOverrides, streams, streamOptions = {}) {
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
  for await (const event of adapter.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: '写个长回答' }] }],
    ...streamOptions,
  })) {
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
      fakeStream(['让我先分析这个问题的来龙去脉，先把已知的约束条件逐条摆出来，再顺着线索往下推导结论的']),
      fakeStream(['完整答案如下。']),
    ],
  )
  assert.equal(calls.length, 2, `应发起 2 次请求（原文 + 续写），实际 ${calls.length}`)
  assert.equal(blocks.length, 1, '续写内容应拼进同一条回答')
  assert.equal(blocks[0], '让我先分析这个问题的来龙去脉，先把已知的约束条件逐条摆出来，再顺着线索往下推导结论的完整答案如下。', `拼接结果: ${JSON.stringify(blocks)}`)
  assert.equal(finish?.kind, 'stop', '必须报 stop（不再出现 max-tokens 提示）')
})

await test('续写请求的 prompt 必须包含半截回答与继续指令', async () => {
  const { calls } = await run(
    {},
    [fakeStream(['这是被服务端截断在句中的前半段回答文本，写到这里戛然而止，后面还没有给出任何结论的']), fakeStream(['后半句。'])],
  )
  assert.ok(calls[1].prompt.includes('前半段回答文本'), '续写 prompt 应带上已输出的半截回答')
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
      fakeStream(['第一段先摆出问题的背景与已知约束条件，然后逐步推进推导，目前只写到这里还没有结论的']),
      fakeStream(['第二段，']),
      fakeStream(['第三段完。']),
    ],
  )
  assert.equal(calls.length, 3, '原文 + 2 轮续写')
  assert.equal(finish?.kind, 'stop')
})

// ── F26：内部短文本调用（标题生成 / 上下文压缩）不得触发自动续写 ──────────
// 2026-09-14 实测：13 个会话里 **11 个**标题是重复垃圾 ——
//   "在吗在吗在吗"、"AI助手的记忆功能"×3、"安装 archify skills"×3、
//   "TCP 三次握手原因解析"×3、"鹈鹕骑自行车 HTML 页面"×2 …
// 根因：标题天然**以汉字结尾** ⇒ looksMidSentence 恒为真 ⇒ 每轮都被判成"句中被截"
// ⇒ 自动续写要求模型"接着写" ⇒ 模型把标题重复一遍（每轮一次，直到额度用尽）。
// 续写本意是"帮用户把被截断的回答写完整"，对内部短文本没有意义。
await test('purpose=session-title 不得续写（标题天然"句中被截"）—— F26', async () => {
  const logs = []
  const { blocks, callCount } = await run(
    { config: { logger: { info: (m) => logs.push(m), warn: () => {}, debug: () => {}, error: () => {} } } },
    [fakeStream(['TCP 三次握手的原因解析与实际抓包验证完整步骤总结归纳以及常见面试追问要点梳理归纳']), fakeStream(['TCP 三次握手的原因解析与实际抓包验证完整步骤总结归纳以及常见面试追问要点梳理归纳'])],
    { purpose: 'session-title' },
  )
  assert.equal(callCount, 1, '标题生成只能发一次请求')
  assert.equal(blocks.join(''), 'TCP 三次握手的原因解析与实际抓包验证完整步骤总结归纳以及常见面试追问要点梳理归纳')
  // 自证：标题确实被判成"句中被截"—— 否则这条用例可能没走到点子上
  // （若哪天判据变了、标题不再满足 midSentence，这条自证会先红，提醒我们重审用例）
  assert.ok(
    logs.some((l) => l.includes('尾部是句中')),
    '自证：标题在这一轮里确实满足"句中被截"的条件，才会被误续写',
  )
})

await test('purpose=compaction 同样不续写 —— F26', async () => {
  const { callCount } = await run(
    {},
    [fakeStream(['压缩后的摘要']), fakeStream(['压缩后的摘要'])],
    { purpose: 'compaction' },
  )
  assert.equal(callCount, 1, '上下文压缩不是"给用户看的回答"，不该续写')
})

await test('purpose=chat 仍照旧续写（修复不得扩大到正常路径）—— F26 不回归', async () => {
  const { blocks, callCount } = await run(
    {},
    [fakeStream(['这是被服务端截断在句中的半截回答，后面还有结论和对应的示例代码没有写完，需要接着往下输出的']), fakeStream(['，接着写完。'])],
    { purpose: 'chat' },
  )
  assert.equal(callCount, 2)
  assert.equal(blocks.join(''), '这是被服务端截断在句中的半截回答，后面还有结论和对应的示例代码没有写完，需要接着往下输出的，接着写完。')
})

await test('不传 purpose（默认 chat）仍续写 —— F26 不回归', async () => {
  const { callCount } = await run({}, [fakeStream(['这是被服务端截断在句中的半截回答，后面还有结论和对应的示例代码没有写完，需要接着往下输出的']), fakeStream(['，接着写完。'])])
  assert.equal(callCount, 2, '没带用途的调用按 chat 处理')
})

// ── F29：短回答不判「句中被截」─────────────────────────────────────────────
// "我在""在吗"这类完整短答天然以汉字收尾，旧判据（尾部是汉字 ⇒ 被截）对它恒真，
// 会白打 1~2 次续写请求（host 日志 12:34/14:45 等"额度已用尽"全是这种）。服务端真截断
// （无 FINISHED）走的是另一条判据（cutByServer），不受此下限影响。
await test('短回答（<40 字）以汉字收尾 → 不续写 —— F29', async () => {
  const { calls, blocks, finish } = await run(
    {},
    [fakeStream(['我在'])],
  )
  assert.equal(calls.length, 1, '短回答不该触发续写')
  assert.equal(blocks[0], '我在')
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

await test('只有思考、无正文无工具调用 → 必须报可重试错误，不能静默 stop（0.1.70）', async () => {
  // 现场（2026-09-16 dsh-Pet 会话）：思考写了 11 万字、正文与工具调用都没有，
  // 旧实现按 stop 上报 ⇒ agent loop 认为回合正常结束 ⇒ 用户看到"模型停住了"。
  const thinkingOnly = async function* () {
    yield { kind: 'thinking', text: '我先把这个问题的来龙去脉想一遍……' }
    yield { kind: 'finish', reason: 'FINISHED' }
  }
  const { calls, blocks, finish } = await run({}, [thinkingOnly])
  assert.equal(calls.length, 1, '适配器自己不重试（重发交给 dsh-llm-retry）')
  assert.equal(blocks.length, 0, '不该产出正文块')
  assert.equal(finish?.kind, 'error', `必须报错，实际 ${JSON.stringify(finish)}`)
  assert.equal(finish?.failure?.code, 'EMPTY_RESPONSE', '必须是可重试码，否则 DSH 不会自动重发')
})

await test('防误伤：正文 0 字但有工具调用 → 照常收尾（0.1.70）', async () => {
  // 这是**健康形态**（实测占 30%）：工具调用被 ToolCallStreamFilter 从正文流里取走，
  // 所以此刻正文必然为空。绝不能因为"正文 0 字"就报错。
  const toolCallOnly = async function* () {
    yield { kind: 'thinking', text: '先查一下这个文件。' }
    yield { kind: 'text', text: '{"tool_calls":[{"name":"read","arguments":{"file_path":"a.txt"}}]}' }
    yield { kind: 'finish', reason: 'FINISHED' }
  }
  const { finish } = await run({}, [toolCallOnly])
  assert.equal(finish?.kind, 'tool-calls', `工具调用轮必须照常收尾，实际 ${JSON.stringify(finish)}`)
})

await test('防误伤：有思考也有正文 → 正常 stop（0.1.70）', async () => {
  const both = async function* () {
    yield { kind: 'thinking', text: '想一下。' }
    yield { kind: 'text', text: '答案在这里。' }
    yield { kind: 'finish', reason: 'FINISHED' }
  }
  const { finish } = await run({}, [both])
  assert.equal(finish?.kind, 'stop', `有正文就该正常收尾，实际 ${JSON.stringify(finish)}`)
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
      fakeStreamUsage(['让我先分析这个问题的来龙去脉，先把已知的约束条件逐条摆出来，再顺着线索往下推导结论的'], 1000), // 第一轮：上报 1000
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
    [fakeStreamUsage(['这是被服务端截断在句中的半截回答，后面还有结论和对应的示例代码没有写完，需要接着往下输出的'], 1000), fakeStreamUsage(['收尾。'], 2000)],
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

// ── 0.1.66：尾字符判据补漏（「；」「、」是分隔符，不是终止符）──────────────
// 实测旧实现（把源码函数体切出来直接求值）：`；`（全角分号）与 `、`（顿号）都落到
// "字母/数字/汉字以外的字符 → false" 那条兜底上，被判成"已写完"。
// 而服务端**会在句中截断却照发 FINISHED**（README 有记录）—— 此时 cutByServer 为 false，
// looksMidSentence 是唯一防线 ⇒ 截断点落在分号/顿号后就会**静默少一段**。
// 这两个恰恰是最强的"还没写完"信号：列举到一半、分句列到一半。
// ⚠️ 样本必须 > 40 字，否则会被 F29 的短文本门槛吃掉、用例等于什么都没测。
const FILLER = '先把已知条件逐条摆出来，把边界划清楚，再把推导过程一步步写完整，最后给出结论与对应的示例代码'

await test('结尾是「；」→ 判为句中被截，自动续写（0.1.66）', async () => {
  const head = FILLER + '；'
  const { calls, blocks } = await run({}, [fakeStream([head]), fakeStream(['补齐后半段。'])])
  assert.ok(head.length > 40, `自证：样本要超过 40 字门槛，实际 ${head.length}`)
  assert.equal(calls.length, 2, '分号收尾 = 还有下文，应续写')
  assert.ok(blocks[0].endsWith('补齐后半段。'), `续写要拼进同一条回答：${JSON.stringify(blocks)}`)
})

await test('结尾是「、」→ 判为句中被截，自动续写（0.1.66）', async () => {
  const head = FILLER + '、'
  const { calls } = await run({}, [fakeStream([head]), fakeStream(['还有最后一项。'])])
  assert.ok(head.length > 40, `自证：样本要超过 40 字门槛，实际 ${head.length}`)
  assert.equal(calls.length, 2, '顿号收尾 = 列举没列完，应续写')
})

await test('结尾是「。」的长回答 → 不续写（防止判据被放宽成"逢标点就续写"）', async () => {
  const head = FILLER + '。'
  const { calls } = await run({}, [fakeStream([head])])
  assert.ok(head.length > 40, `自证：样本要超过 40 字门槛，实际 ${head.length}`)
  assert.equal(calls.length, 1, '句号收尾是正常结束，不该续写')
})

await test('结尾是「…」→ 视为正常收尾（刻意取舍：省略号也可能是有意的收束语气）', async () => {
  const head = FILLER + '…'
  const { calls } = await run({}, [fakeStream([head])])
  assert.ok(head.length > 40, `自证：样本要超过 40 字门槛，实际 ${head.length}`)
  assert.equal(calls.length, 1, '省略号收尾不续写（详见 COMPLETE_TAIL 的取舍注释）')
})

// ── 0.1.74：模型把「要执行的程序」写进了正文，而不是作为工具调用发出 ──────────
// 现场（2026-09-17 11:00，`--F-Code-DSH-Code-gongji--` 会话）：第三方 preset（染神）的
// tool-bootstrap.mjs 注入了一条 PTC 说明（"所有动作必须通过 run_code 写 TypeScript 程序"），
// 模型于是把 run_code 的 code 参数**原样贴进正文** —— 三轮里一次工具调用都没发出，
// agent loop 判定回合结束，用户看到的是"它停下来了"；模型自己在 reasoning 里也承认了。
// 修法：识别这种形态后追加一轮**纠正**请求（与"续写"互斥，且只给一次机会）。
// ⚠️ 样本照抄现场，别凭记忆重写 —— 长度与形态都是判据的一部分。
const PTC_PROGRAM = [
  '我先把现场摸清：目标站是否还活着、返回什么、本地有没有样本和逆向工具链。',
  '',
  '```ts',
  'const out = [];',
  'const run = async (label, command, workdir) => {',
  '  try {',
  '    const r = await tools.bash({ command, workdir });',
  '    out.push(r.text.slice(0, 4000));',
  '  } catch (e) {',
  '    out.push(String(e && e.message));',
  '  }',
  '};',
  '',
  "await run('cwd + files', 'pwd; ls -la');",
  "await run('node/python', 'node -v; python -V; which curl curl.exe 2>/dev/null');",
  '',
  'console.log(out.join("\\n"));',
  '```',
].join('\n')

await test('正文里是未执行的工具程序 ⇒ 追加一轮纠正请求（0.1.74）', async () => {
  assert.ok(PTC_PROGRAM.includes('tools.bash('), '自证：样本必须含工具 API 调用形态')
  assert.ok(PTC_PROGRAM.includes('```ts'), '自证：样本必须真的带围栏')
  const { calls, blocks } = await run({}, [fakeStream([PTC_PROGRAM]), fakeStream(['好，现在发。'])])
  assert.equal(calls.length, 2, '零工具调用 + 正文含程序 ⇒ 应该再发一次')
  assert.ok(calls[1].prompt.includes('写在正文里的代码不会被执行'), '纠正指令必须进 prompt')
  assert.ok(
    !calls[1].prompt.includes('无缝接着往下写'),
    '走的应该是纠正分支、不是续写分支（两者互斥）',
  )
  assert.ok(calls[1].prompt.includes('我先把现场摸清'), '上一轮的输出要作为 assistant 消息回放给它')
  assert.ok(blocks.join('').startsWith('我先把现场摸清'), '已上屏的内容不能因为纠正而丢失')
})

await test('这种纠正只给一次机会（第二次仍写程序时不再追加请求）', async () => {
  const { calls } = await run({}, [fakeStream([PTC_PROGRAM]), fakeStream([PTC_PROGRAM])])
  assert.equal(calls.length, 2, '纠正过一轮就收手，别把请求密度打上去')
})

await test('防误伤：普通正文不触发纠正', async () => {
  const { calls } = await run({}, [fakeStream(['这个是正常的回答，里面没有任何要执行的程序。'])])
  assert.equal(calls.length, 1, '普通回答不该多发一次请求')
})

await test('防误伤：与工具 API 无关的普通代码块不触发纠正', async () => {
  const plain = ['看下面的例子：', '', '```js', 'const a = 1;', 'console.log(a);', '```'].join('\n')
  const { calls } = await run({}, [fakeStream([plain])])
  assert.equal(calls.length, 1, '单纯贴一段示例代码不是"程序没发出去"')
})

await test('防误伤：本轮已拿到工具调用 → 正文里再有同类代码块也不纠正', async () => {
  const mixed = async function* () {
    yield { kind: 'text', text: PTC_PROGRAM + '\n' }
    yield {
      kind: 'text',
      text: '{"tool_calls":[{"name":"run_code","arguments":{"code":"return 1","description":"x"}}]}',
    }
    yield { kind: 'finish', reason: 'stop' }
  }
  const { calls } = await run({}, [mixed])
  assert.equal(calls.length, 1, '有工具调用的轮次是健康形态，不该再纠正')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1