/**
 * 回归：传输层（fetch）注入必须**每次现取**，不能在模块加载那一刻固化。
 *
 * 事故（2026-09-12，本会话内实测）：为把请求从 Node 网络栈切到 Chromium 网络栈
 * （`electron.net.fetch`），给 webapi.ts 加了可注入的 fetch。最初写法是：
 *
 *     let activeFetch: typeof fetch = fetch      // ← 在模块加载时就把全局 fetch 固化
 *
 * 后果很隐蔽：**单测用「模块加载之后再替换 globalThis.fetch」来打桩的路径全部失效** ——
 * 每个请求都绕过桩件、真的发到了 chat.deepseek.com。因为测试用的 token 是假的，
 * 拿回来的是一个 INVALID_TOKEN → 归类成 AUTH，于是：
 *
 *   x 信封里的「并发生成」同样归为可重试（RATE_LIMIT + 5s）: 应可重试，实际 AUTH
 *
 * 测试看起来在验证错误分类，实际上在打网络。这类回归**不会让任何功能报错**，
 * 只会让一批测试静默失去意义（还可能顺带消耗真实账号的额度），所以单独守一道。
 *
 * 用法: node tests/check-fetch-injection.mjs
 */
import assert from 'node:assert/strict'
import { fetchImplKind, setFetchImpl, streamWebCompletion } from '../src/webapi.ts'

let passed = 0
const failures = []
async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const AUTH = {
  token: 't',
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
  capturedAt: '2026-09-11T00:00:00.000Z',
}

/** 只桩掉「建会话 / PoW」，让完成态请求落到当前生效的 fetch 上（正是被测的那一层）。 */
const transport = {
  createSession: async () => 'S1',
  powHeader: async () => 'pow-header',
}

const BUSY = 'A message is being generated, please try again later.'

function busyEnvelope() {
  return new Response(
    `{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"${BUSY}"}}`,
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function complete() {
  const events = []
  let thrown
  try {
    for await (const event of streamWebCompletion(
      AUTH,
      { prompt: 'hi', thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 3_000 },
      transport,
    )) {
      events.push(event)
    }
  } catch (error) {
    thrown = error
  }
  return { events, thrown }
}

/** 每个用例都跑在「全局 fetch 被替换 → 复原」的沙箱里，避免互相污染。 */
async function withGlobalFetch(stub, fn) {
  const real = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

await run('默认走 Node 原生 fetch（未注入时标记为 node）', async () => {
  assert.equal(fetchImplKind(), 'node')
})

await run('注入后标记为 injected，还原后回到 node', async () => {
  const fake = async () => busyEnvelope()
  setFetchImpl(fake)
  assert.equal(fetchImplKind(), 'injected')
  setFetchImpl()
  assert.equal(fetchImplKind(), 'node', '传 undefined 必须还原')
})

await run('【防泄漏】模块加载之后替换 globalThis.fetch 必须仍然生效', async () => {
  let hits = 0
  const { thrown, events } = await withGlobalFetch(
    async () => {
      hits += 1
      throw new Error('LEAK-SENTINEL')
    },
    () => complete(),
  )
  assert.equal(
    hits,
    1,
    '晚替换的 globalThis.fetch 没有被调用 —— 说明 fetch 被固化在模块加载那一刻了，' +
      '测试的桩件会失效、请求会真的出网',
  )
  assert.ok(thrown, '桩件抛错必须冒出来，不能被吞掉')
  const seen = `${thrown?.message ?? ''} ${JSON.stringify(events)}`
  assert.ok(
    !/INVALID_TOKEN|授权失败/.test(seen),
    `不该拿到真实服务端的响应（说明请求真的出网了）：${seen.slice(0, 160)}`,
  )
})

await run('注入的实现优先于晚替换的 globalThis.fetch', async () => {
  let injectedHits = 0
  let globalHits = 0
  setFetchImpl(async () => {
    injectedHits += 1
    return busyEnvelope()
  })
  try {
    const { thrown } = await withGlobalFetch(
      async () => {
        globalHits += 1
        throw new Error('globalThis.fetch 不该被用到')
      },
      () => complete(),
    )
    assert.equal(injectedHits, 1, '注入的实现应被调用')
    assert.equal(globalHits, 0, '存在注入时不该退到 globalThis.fetch')
    assert.equal(thrown?.code, 'RATE_LIMIT', `分类应来自注入桩件的信封，实际 ${thrown?.code}`)
  } finally {
    setFetchImpl()
  }
})

await run('晚替换的桩件真的被拿来回放（分类与重试间隔都来自桩件而非网络）', async () => {
  const { thrown } = await withGlobalFetch(async () => busyEnvelope(), () => complete())
  assert.equal(thrown?.code, 'RATE_LIMIT', `实际 ${thrown?.code}`)
  const retryAfter = thrown?.failure?.providerRetryAfterMs ?? thrown?.providerRetryAfterMs
  assert.equal(retryAfter, 5_000, '并发生成是短暂状态，重试间隔应该短')
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
