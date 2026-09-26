/**
 * 回归：会话生命周期 —— 删除时机 + 会话失效的透明恢复。
 *
 * 事故（2026-09-11，本会话内实测）：网页快速模式下某一轮直接失败：
 *   DeepSeek 网页端返回了非流式响应（content-type: application/json）：
 *   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id"}}
 *
 * 两个独立缺陷：
 *  ① `streamWebCompletion` 在建会话**之后立刻**调用 `onDeleteSession`，而它内部是
 *     「延迟 1.5s 删除」→ PoW 求解 + 建连一旦超过 1.5s，completion 发出时会话已被自己删掉；
 *     更隐蔽的是生成中途会话消失，服务端可能直接掐断流（表现为「说半句就停」/调用没收全）。
 *  ② `envelopeError` 只看外层 `code`，而网页端把真实错误放在 `data.biz_code`（外层是 0）
 *     → 真原因被吞掉，降级成不可重试的 MALFORMED_RESPONSE。
 *
 * 用法: node tests/check-session-lifecycle.mjs
 */
import assert from 'node:assert/strict'
import { envelopeError, isBusyGenerating, isInvalidSessionError, isMutedError, isThrottled, muteUntilMs, resetSessionReuse, streamWebCompletion } from '../src/webapi.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') throw new Error('测试不能是异步的（请用 run() 包一层）')
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

// ── 事实 ①：真实响应体里的错误在 data.biz_code，外层 code 是 0 ──
const REAL_INVALID_SESSION = '{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id","biz_data":null}}'

test('envelopeError: 认得 data.biz_code（外层 code 为 0）', () => {
  const biz = envelopeError(JSON.parse(REAL_INVALID_SESSION))
  assert.ok(biz, '必须识别出业务错误，否则真原因会被吞掉')
  assert.equal(biz.code, 1)
  assert.equal(biz.msg, 'invalid chat session id')
})

test('envelopeError: 外层 code 非 0 仍优先', () => {
  const biz = envelopeError({ code: 40003, msg: 'Authorization Failed' })
  assert.equal(biz.code, 40003)
})

test('envelopeError: 正常响应（两层都是 0）返回 undefined', () => {
  assert.equal(envelopeError({ code: 0, msg: '', data: { biz_code: 0, biz_data: {} } }), undefined)
  assert.equal(envelopeError(null), undefined)
})

test('isInvalidSessionError: 只认会话失效文案', () => {
  assert.equal(isInvalidSessionError({ code: 1, msg: 'invalid chat session id' }), true)
  assert.equal(isInvalidSessionError({ code: 1, msg: 'chat session not found' }), true)
  assert.equal(isInvalidSessionError({ code: 1, msg: 'chat_session_id 无效' }), true)
  assert.equal(isInvalidSessionError({ code: 429, msg: 'rate limit' }), false)
  assert.equal(isInvalidSessionError(undefined), false)
})

// ── 事实 ②：请求期间的时序（删除必须在流结束之后；失效要透明重试）──

const AUTH = {
  token: 't',
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
  capturedAt: '2026-09-11T00:00:00.000Z',
}

const SSE_OK = 'data: {"p":"response/content","v":"hello"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n'

function sseResponse(payload = SSE_OK) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(payload, status = 200) {
  return new Response(payload, { status, headers: { 'content-type': 'application/json' } })
}

/** 装上假的 fetch，跑一次完成请求，返回时序日志与产出。 */
async function scenario({ completionResponses, sessionReuseTurns = 0, canFailover }) {
  // 会话复用槽是**模块级**的（生产里一个进程就一个），跨场景必须清掉，
  // 否则本场景会复用上一个场景留下的会话，断言里的 S1/S2 就对不上了。
  resetSessionReuse()
  // 本文件测的是「每请求一个会话」的时序（建→请求→流结束→删），所以默认关掉复用；
  // 复用本身的行为（N 轮共用一个会话、轮换才回收）由 tests/check-session-reuse.mjs 覆盖。
  const log = []
  let sessionSeq = 0
  const transport = {
    createSession: async () => {
      sessionSeq += 1
      const id = `S${sessionSeq}`
      log.push(`create:${id}`)
      return id
    },
    powHeader: async () => {
      log.push('pow')
      return 'pow-header'
    },
  }
  const queue = [...completionResponses]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    log.push(`completion:${body.chat_session_id}`)
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra completion request')
    return typeof next === 'function' ? next() : next
  }
  let thrown
  const events = []
  try {
    for await (const event of streamWebCompletion(AUTH, {
      prompt: 'hi',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      sessionReuseTurns,
      onDeleteSession: (id) => log.push(`delete:${id}`),
      ...(canFailover !== undefined ? { canFailover } : {}),
    }, transport)) {
      events.push(event)
    }
  } catch (error) {
    thrown = error
  } finally {
    globalThis.fetch = realFetch
  }
  return { log, events, thrown }
}

await run('删除排在整个请求之后（旧实现是 create → delete → completion）', async () => {
  const { log, events, thrown } = await scenario({ completionResponses: [sseResponse()] })
  assert.equal(thrown, undefined, `不应抛错：${thrown?.message}`)
  assert.deepEqual(log, ['create:S1', 'pow', 'completion:S1', 'delete:S1'],
    `时序必须是「建会话 → 请求 → 流结束 → 删除」，实际：${log.join(' → ')}`)
  assert.ok(events.some((e) => e.kind === 'text' && e.text === 'hello'), '应产出正文')
})

await run('会话失效：透明换新会话重试一次，用户无感', async () => {
  const { log, events, thrown } = await scenario({
    completionResponses: [jsonResponse(REAL_INVALID_SESSION), sseResponse()],
  })
  assert.equal(thrown, undefined, `不该把失效暴露给用户：${thrown?.message}`)
  assert.deepEqual(log, ['create:S1', 'pow', 'completion:S1', 'delete:S1', 'create:S2', 'pow', 'completion:S2', 'delete:S2'],
    `应重建会话并重发，实际：${log.join(' → ')}`)
  assert.ok(events.some((e) => e.kind === 'text' && e.text === 'hello'))
})

await run('连续两次失效：抛可重试的 TRANSPORT，并说明真原因', async () => {
  const { log, thrown } = await scenario({
    completionResponses: [jsonResponse(REAL_INVALID_SESSION), jsonResponse(REAL_INVALID_SESSION)],
  })
  assert.ok(thrown, '两次都失效必须报错')
  assert.equal(thrown.code, 'TRANSPORT', '必须是可重试码（EMPTY_RESPONSE/TRANSPORT…），否则不会自动重试')
  assert.match(String(thrown.message), /invalid chat session id|会话/, `消息应带真原因：${thrown.message}`)
  assert.ok(log.includes('delete:S1') && log.includes('delete:S2'), '失败路径也要回收会话')
})

await run('其它业务错误照常抛出（不误判为会话失效）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse('{"code":0,"msg":"","data":{"biz_code":2,"biz_msg":"INVALID_PARAM"}}')],
  })
  assert.ok(thrown, '业务错误必须抛出')
  assert.match(String(thrown.message), /INVALID_PARAM|code 2/)
})

// ── 事实 ③：账号被服务端限制（muted）要说清楚，且不能空转重试 ──
// 现场抓到（2026-09-11）：{"code":0,"data":{"biz_code":5,"biz_msg":"user is muted",
//   "biz_data":{"is_muted":1,"mute_until":1789173841.894}}}
//
// ⚠️ `mute_until` 是**绝对**时间戳，写死在夹具里就是一颗时间炸弹：
//    写测试那天它是「明天」，第二天就变成「过去」，于是 Math.max(0, until - now) 恒为 0，
//    断言必然失败（2026-09-12 早上实测踩到：15 项通过 1 项失败）。
//    所以这里按「当前时间 + 12 小时」动态生成，信封形状与现场完全一致。
const MUTE_UNTIL_SECONDS = Math.floor(Date.now() / 1000) + 12 * 3600 + 0.894
const REAL_MUTED = JSON.stringify({
  code: 0,
  msg: '',
  data: { biz_code: 5, biz_msg: 'user is muted', biz_data: { is_muted: 1, mute_until: MUTE_UNTIL_SECONDS } },
})

test('isMutedError / muteUntilMs: 认得真实信封', () => {
  const json = JSON.parse(REAL_MUTED)
  const biz = envelopeError(json)
  assert.ok(biz, 'biz_code 5 必须被识别（否则只会显示 code 5 这种看不懂的话）')
  assert.equal(isMutedError(biz), true)
  assert.equal(muteUntilMs(json), Math.round(MUTE_UNTIL_SECONDS * 1000))
  assert.equal(isMutedError({ code: 2, msg: 'INVALID_PARAM' }), false)
})

await run('muted：报 RATE_LIMIT + 解除时间，并带上 providerRetryAfterMs', async () => {
  const { thrown, log } = await scenario({ completionResponses: [jsonResponse(REAL_MUTED)] })
  assert.ok(thrown, '必须抛出（不能假装成功）')
  assert.equal(thrown.code, 'RATE_LIMIT', '应归到「服务端让你慢一点」这一类')
  assert.match(String(thrown.message), /封禁|限制/, '文案要表明是账号被限制/封禁')
  assert.match(String(thrown.message), /解除/, `消息要带解除时间：${thrown.message}`)
  // 用户反馈过"封号报错太长" ⇒ 文案只说结论 + 解除时间，不准再写机制解释。
  // 用长度上限当阀门（比逐字断言稳，改措辞不会假红），80 字够写「已封禁本账号，X 解除（约 N 分钟）」还有富余。
  assert.ok(
    String(thrown.message).length < 80,
    `封禁文案要短，实际 ${String(thrown.message).length} 字：${thrown.message}`,
  )
  const retryAfter = thrown.failure?.providerRetryAfterMs ?? thrown.providerRetryAfterMs
  assert.ok(retryAfter > 60_000, `解除时间很远时必须给出 providerRetryAfterMs（>60s）让重试策略放弃空转，实际 ${retryAfter}`)
  assert.ok(log.includes('delete:S1'), '失败也要回收会话')
})

// ── 事实 ④：两个窗口共用同一账号 → 「同时只能生成一条」必须可重试而不是整轮失败 ──
// 用户实测（2026-09-11）：SSE 流里报
//   A message is being generated, please try again later.
// 旧实现一律抛 PROVIDER_ERROR（不可重试）→ 那一轮直接失败。
const REAL_BUSY = 'A message is being generated, please try again later.'

test('isBusyGenerating: 认得真实的并发生成拒绝文案', () => {
  assert.equal(isBusyGenerating(REAL_BUSY), true)
  assert.equal(isBusyGenerating('请稍后再试'), true)
  assert.equal(isBusyGenerating('user is muted'), false, 'mute 是另一回事，不能混为一谈')
  assert.equal(isBusyGenerating(''), false)
  assert.equal(isBusyGenerating(undefined), false)
})

// ── 事实 ⑤：账号级节流（「消息发送过于频繁，请稍后重试」）也要可重试 ──
// 用户实测（2026-09-11 16:11，SSE error 事件）：
//   DeepSeek 网页端返回错误：消息发送过于频繁，请稍后重试   → 旧版归 PROVIDER_ERROR，整轮失败
// 根因：并发那条文案是「请稍后再试」，节流是「请稍后**重**试」，差一个字没匹配上。
const REAL_THROTTLE = '消息发送过于频繁，请稍后重试'

test('isThrottled: 认得「请稍后重试」，且不误伤会话失效/mute', () => {
  assert.equal(isThrottled(REAL_THROTTLE), true)
  assert.equal(isThrottled('请求过于频繁'), true)
  assert.equal(isThrottled('Too many requests'), true)
  assert.equal(isThrottled(REAL_BUSY), false, '并发那条由 isBusyGenerating 管，两条判据别互相串')
  assert.equal(isThrottled('invalid chat session id'), false)
  assert.equal(isThrottled('user is muted'), false)
  assert.equal(isThrottled(''), false)
  assert.equal(isThrottled(undefined), false)
})

const SSE_THROTTLE = `data: ${JSON.stringify({ type: 'error', content: REAL_THROTTLE })}\n\n`

await run('账号节流：webapi 产出的事件必须带 RATE_LIMIT + throttled + 退避 ≥20s', async () => {
  const { events, thrown } = await scenario({ completionResponses: [sseResponse(SSE_THROTTLE)] })
  assert.equal(thrown, undefined, `webapi 层不抛错，只产出事件：${thrown?.message}`)
  const err = events.find((e) => e.kind === 'error')
  assert.ok(err, `应产出 error 事件，实际：${JSON.stringify(events)}`)
  assert.equal(err.code, 'RATE_LIMIT', '旧版这里没有 code → 适配器归成不可重试的 PROVIDER_ERROR → 整轮失败')
  assert.equal(err.rateLimitKind, 'throttled', '要与「并发生成」区分开（文案与退避都不同）')
  assert.ok(err.retryAfterMs >= 20_000, `节流退避要给足（≥20s），实际 ${err.retryAfterMs}`)
})

await run('连续被限时退避渐长（20s 起、翻倍、上限 90s + 抖动）', async () => {
  const one = await scenario({ completionResponses: [sseResponse(SSE_THROTTLE)] })
  const first = one.events.find((e) => e.kind === 'error')?.retryAfterMs ?? 0
  const two = await scenario({ completionResponses: [sseResponse(SSE_THROTTLE)] })
  const second = two.events.find((e) => e.kind === 'error')?.retryAfterMs ?? 0
  for (const v of [first, second]) {
    assert.ok(v >= 20_000, `退避至少 20s，实际 ${v}`)
    assert.ok(v <= 120_000, `退避不该超过 90s + 抖动，实际 ${v}`)
  }
  // 越被限越要等久一点（到 90s 上限后持平，抖动可能让后一次略小，所以加这个分支）
  assert.ok(second > first || second >= 90_000, `应递增：第一次 ${first} → 第二次 ${second}`)
})

await run('SSE 错误事件里的「并发生成」→ 归类为可重试的 RATE_LIMIT', async () => {
  const ssePayload = `data: ${JSON.stringify({ type: 'error', content: REAL_BUSY })}\n\n`
  const { events, thrown } = await scenario({ completionResponses: [sseResponse(ssePayload)] })
  assert.equal(thrown, undefined, 'streamWebCompletion 只产出事件，不抛错')
  const errorEvent = events.find((e) => e.kind === 'error')
  assert.ok(errorEvent, '应产出 error 事件')
  assert.equal(errorEvent.code, 'RATE_LIMIT', `应带语义归类，实际 ${JSON.stringify(errorEvent)}`)
  assert.equal(errorEvent.retryAfterMs, 5_000)
})

await run('信封里的「并发生成」同样归为可重试（RATE_LIMIT + 5s）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(`{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"${REAL_BUSY}"}}`)],
  })
  assert.ok(thrown, '必须抛出')
  assert.equal(thrown.code, 'RATE_LIMIT', `应可重试，实际 ${thrown.code}`)
  const retryAfter = thrown.failure?.providerRetryAfterMs ?? thrown.providerRetryAfterMs
  assert.equal(retryAfter, 5_000, '并发生成是短暂状态，重试间隔应该短')
  assert.match(String(thrown.message), /同时只能生成一条|being generated/i)
})

// ── 事实 ⑥：节流也会以「HTTP 200 + 信封」回来，而且它的业务码是 40029 ──
// 来源：cuckoo-code 0.6.1 的实测记录 ——「DeepSeek 返回"操作过于频繁"（HTTP 429 / 业务码 40029）」，
// 它为此专门加了 60 秒退避重试。
// 我们原先只认 HTTP 429（httpErrorCode）与 SSE error 事件的文案（isThrottled）⇒ 走信封的这一路
// 会落到 bizErrorCode(40029) = PROVIDER_ERROR（**不可重试**）⇒ 恰好在最该退避的时候整轮失败。
const throttleEnvelope = (code, msg) => `{"code":0,"msg":"","data":{"biz_code":${code},"biz_msg":"${msg}"}}`

await run('信封形式的 40029：归 RATE_LIMIT（可重试）+ 文案是「网页版限流」', async () => {
  // ⚠️ msg 故意用**不含「频繁」字样**的中性串 —— 这样这条守的是**码**，
  // 而不是被 isThrottled 的文案兜底接住（否则去掉 40029 也照样绿，就成了假绿）。
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(throttleEnvelope(40029, 'request rejected by policy'))],
  })
  assert.ok(thrown, '必须抛出')
  assert.equal(thrown.code, 'RATE_LIMIT', `40029 是限流码，不能落到不可重试的 PROVIDER_ERROR，实际 ${thrown.code}`)
  assert.match(String(thrown.message), /网页版限流/, `文案要短且统一，实际：${thrown.message}`)
  const retryAfter = thrown.failure?.providerRetryAfterMs ?? thrown.providerRetryAfterMs
  assert.ok(retryAfter >= 20_000, `节流退避要给足（≥20s），实际 ${retryAfter}`)
})

await run('信封形式的老话术（码不认识）：按文案也要归 RATE_LIMIT', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(throttleEnvelope(7, '消息发送过于频繁，请稍后重试'))],
  })
  assert.equal(thrown?.code, 'RATE_LIMIT', `话术变了也不能漏，实际 ${thrown?.code}`)
})

await run('普通业务错误不得被节流判据误伤（仍不可重试）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(throttleEnvelope(2, 'INVALID_PARAM'))],
  })
  assert.equal(thrown?.code, 'PROVIDER_ERROR', `不是限流就别重试，实际 ${thrown?.code}`)
})

// ── 事实 ⑦：当前账号被限时，"能不能换号接着干"决定退避长短 ──
// 背景：封禁（user is muted）过去把**解除时间**当退避 ⇒ 重试策略直接放弃 ⇒ 整轮停下来
// 等用户手动点「继续」。现在有了自动换号，只要**还有可用账号**，就该给一个短退避让重试立刻
// 发生 —— 重发时自动换号的检查点会换上可用账号，整轮任务自己就能接下去。
await run('muted + 能换号 ⇒ 给短退避（让重试立刻发生，而不是放弃）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(REAL_MUTED)],
    canFailover: () => true,
  })
  const retryAfter = thrown?.failure?.providerRetryAfterMs ?? thrown?.providerRetryAfterMs
  assert.ok(
    retryAfter > 0 && retryAfter < 10_000,
    `要秒级退避，实际 ${retryAfter}（给了解除时间就等于放弃重试，白等几小时）`,
  )
})

await run('muted + 不能换号 ⇒ 仍是解除时间（放弃重试，不做无用空转）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(REAL_MUTED)],
    canFailover: () => false,
  })
  const retryAfter = thrown?.failure?.providerRetryAfterMs ?? thrown?.providerRetryAfterMs
  assert.ok(retryAfter > 60_000, `没有别的账号可用时不该给短退避（会一直空转），实际 ${retryAfter}`)
})

await run('muted + 没注入 canFailover ⇒ 与旧行为完全一致', async () => {
  const { thrown } = await scenario({ completionResponses: [jsonResponse(REAL_MUTED)] })
  const retryAfter = thrown?.failure?.providerRetryAfterMs ?? thrown?.providerRetryAfterMs
  assert.ok(retryAfter > 60_000, `默认必须保持旧行为（不动这个开关的人无感），实际 ${retryAfter}`)
})

await run('muted + canFailover 抛错 ⇒ 按"不能"处理（问不出来就别赌）', async () => {
  const { thrown } = await scenario({
    completionResponses: [jsonResponse(REAL_MUTED)],
    canFailover: () => {
      throw new Error('boom')
    },
  })
  const retryAfter = thrown?.failure?.providerRetryAfterMs ?? thrown?.providerRetryAfterMs
  assert.ok(retryAfter > 60_000, `异常要保守处理，实际 ${retryAfter}`)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
