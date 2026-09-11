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
import { envelopeError, isInvalidSessionError, isMutedError, muteUntilMs, streamWebCompletion } from '../src/webapi.ts'

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
async function scenario({ completionResponses }) {
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
      onDeleteSession: (id) => log.push(`delete:${id}`),
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
const REAL_MUTED = '{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted","biz_data":{"is_muted":1,"mute_until":1789173841.894}}}'

test('isMutedError / muteUntilMs: 认得真实信封', () => {
  const json = JSON.parse(REAL_MUTED)
  const biz = envelopeError(json)
  assert.ok(biz, 'biz_code 5 必须被识别（否则只会显示 code 5 这种看不懂的话）')
  assert.equal(isMutedError(biz), true)
  assert.equal(muteUntilMs(json), 1789173841894)
  assert.equal(isMutedError({ code: 2, msg: 'INVALID_PARAM' }), false)
})

await run('muted：报 RATE_LIMIT + 解除时间，并带上 providerRetryAfterMs', async () => {
  const { thrown, log } = await scenario({ completionResponses: [jsonResponse(REAL_MUTED)] })
  assert.ok(thrown, '必须抛出（不能假装成功）')
  assert.equal(thrown.code, 'RATE_LIMIT', '应归到「服务端让你慢一点」这一类')
  assert.match(String(thrown.message), /临时限制|muted/i)
  assert.match(String(thrown.message), /2026|解除/, `消息要带解除时间：${thrown.message}`)
  const retryAfter = thrown.failure?.providerRetryAfterMs ?? thrown.providerRetryAfterMs
  assert.ok(retryAfter > 60_000, `解除时间很远时必须给出 providerRetryAfterMs（>60s）让重试策略放弃空转，实际 ${retryAfter}`)
  assert.ok(log.includes('delete:S1'), '失败也要回收会话')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
