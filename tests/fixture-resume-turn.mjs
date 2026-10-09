/**
 * 0.6.43 夹具：发一轮（或两轮）请求，把结果与落盘状态打成 JSON 交给 `check-resume-after-restart` 断言。
 *
 * 用法（**必须两个进程**，见 `check-resume-after-restart` 的说明）：
 *   DSH_RESUME_PHASE=writeDSH_RESUME_HOME=<dir> node tests/fixture-resume-turn.mjs
 *   DSH_RESUME_PHASE=verify DSH_RESUME_HOME=<dir> node tests/fixture-resume-turn.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HEAD = 'SYSTEM+协议+工具目录'
const DSH_SESSION = 'dsh-1'
const MODE = process.env.DSH_RESUME_PHASE
const HOME = process.env.DSH_RESUME_HOME
process.env.DSH_HOME = HOME
// 本夹具只验持久化，不该依赖浏览器与真 wasm（PoW 由假 transport 顶掉）
process.env.DSH_NO_BROWSER_TRANSPORT = '1'

// 🔴 夹具坑 ①：`currentContextMode` 是 context-feed.ts 的**模块级变量**，
//    只有 index.ts 启动时才 applyContextMode。直接 import webapi.ts 永远是默认 'full'
//    ⇒ 链式路径根本走不到（第一版探针就栽在这，表现为"第二轮 parent 仍是 null"）。
const cf = await import('../src/context-feed.ts')
cf.applyContextMode('chained')
const api = await import('../src/webapi.ts')

// 🔴 夹具坑 ②：assistant 帧必须是 `v.response.fragments` 结构。
//    写 `{type:'assistant',message_id:…}` 会被解析器静默丢弃 ⇒ 收不到 response_message_id
//    ⇒ parentId 拿不到 ⇒ 链建不起来（同上，症状一样）。
function sseWithId(id) {
  return (
    `event: ready\ndata: ${JSON.stringify({ request_message_id: id - 1, response_message_id: id, model_type: 'default' })}\n\n` +
    `data: ${JSON.stringify({ v: { response: { message_id: id, fragments: [{ type: 'RESPONSE', content: 'ok' }] } } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

let id = 901
const bodies = []
let created = 0
const transport = {
  createSession: async () => {
    created += 1
    return 'sess-1'
  },
  powHeader: async () => Buffer.from('{}').toString('base64'),
}

api.setFetchImpl(async (input, init) => {
  const url = String(input)
  if (url.includes('/completion')) {
    bodies.push(String(init?.body ?? ''))
    return new Response(sseWithId(id++), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  }
  return new Response('', { status: 404 })
})

async function turn(text) {
  const it = api.streamWebCompletion(
    { token: 't', cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua', capturedAt: '' },
    {
      model: 'x',
      prompt: `${HEAD}\n\nUser: ${text}`,
      promptParts: { head: HEAD, entries: [`User: ${text}`] },
      dshSessionId: DSH_SESSION,
      onSession: () => {},
      onSessionDelete: () => {},
      onRetry: () => {},
    },
    transport,
  )
  for await (const _e of it) {
    /* 消费干净 */
  }
}

if (MODE === 'write') {
  await turn('第一句')
  await turn('第二句')
} else {
  await turn('第三句')
}

const file = join(HOME, 'web-login', 'resume-state.json')
process.stdout.write(
  JSON.stringify({
    created,
    bodies,
    persisted: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
  }) + '\n',
)