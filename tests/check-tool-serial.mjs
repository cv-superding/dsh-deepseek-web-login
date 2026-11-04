/**
 * 回归：「允许并行调用工具」开关（关掉 = 一次只发一个工具调用）。
 *
 * 链路是四段式的：**界面 → 路由 → gate.json → adapter 换协议指令**。
 * 0.1.82 那条 P0（maxRefImages 发不进去）就是死在第 2 段，所以这里真 POST 一次再读回文件。
 *
 * ⚠️ 但这条链路真正的"末段"不是落盘 —— 是**协议文本真的换成了另一份**。
 * 只验证"设置存进去了"等于没验证（滑块好看但没用）。所以最后一段用 adapter 跑一遍，
 * 从 `streamCompletion` 抓**真正发出去的那份 prompt**，断言它用的是哪一版指令。
 *
 * 刻意的设计取舍（写下来免得后人以为漏了）：
 *  - **不做"与改动前逐字节相同"的守卫**。写法上是 `git show HEAD:src/protocol.ts` 比常量，
 *    但那在 CI 里 **恒真**（HEAD 本身就含改动）—— 典型的假绿，比不写更危险。
 *    "这次改动没动批量版原文"由开发时的 `git diff -U0` 人工确认（该常量不在删除行里）。
 *  - 也不做哈希守卫：值填的是"当前"哈希，守不住"这次有没有改坏"，
 *    只会变成每次改指令都顺手更新哈希的空转。
 *  ⇒ 这里守的是**语义性质**（默认走批量版 / 两版确实不同 / 共享段不许漂），改坏了都会红。
 *
 * 用法: node tests/check-tool-serial.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-serial-'))
process.env.DSH_HOME = HOME

const { TOOL_PROTOCOL_INSTRUCTIONS, SERIAL_TOOL_PROTOCOL_INSTRUCTIONS, toolProtocolInstructions } =
  await import('../src/protocol.ts')
const { createAdapter } = await import('../src/adapter.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

// ── ① 两版指令本身 ────────────────────────────────────────────────────

/** 取"rule 3 起、rule 9 之前"这一段 —— 它是 JSON 正确性的防线，两版必须逐字相同。 */
function sharedRules(text) {
  const from = text.indexOf('3. Never fabricate')
  const to = text.indexOf('9. ')
  assert.ok(from > 0 && to > from, '自证：能在两版里都找到 rule 3 与 rule 9 的边界')
  return text.slice(from, to)
}

await test('函数层：明确传值时按传的来（true=串行 / false=批量）', () => {
  assert.equal(toolProtocolInstructions(true), SERIAL_TOOL_PROTOCOL_INSTRUCTIONS)
  assert.equal(toolProtocolInstructions(false), TOOL_PROTOCOL_INSTRUCTIONS)
})

await test('两版必须真的不同（否则开关是个摆设）', () => {
  assert.notEqual(
    TOOL_PROTOCOL_INSTRUCTIONS,
    SERIAL_TOOL_PROTOCOL_INSTRUCTIONS,
    '两份一模一样 ⇒ 开关点了没反应，而这种"沉默失效"最难被发现',
  )
})

await test('rule 3~8 在两版里逐字相同（JSON 正确性防线不许漂移）', () => {
  const a = sharedRules(TOOL_PROTOCOL_INSTRUCTIONS)
  const b = sharedRules(SERIAL_TOOL_PROTOCOL_INSTRUCTIONS)
  assert.equal(
    a,
    b,
    'rule 3~8 是转义/换行/不许复述转写那几条 —— 与批量无关，改一处忘另一处就会让其中一版丢掉防线',
  )
})

await test('两版各含自己的语义标志，且不互相串台', () => {
  assert.match(TOOL_PROTOCOL_INSTRUCTIONS, /a batch is allowed/, '批量版必须明确允许批量')
  assert.match(SERIAL_TOOL_PROTOCOL_INSTRUCTIONS, /Exactly ONE LIDOW: line/, '串行版必须明确"一条消息只有一个 DO: 行"')
  assert.doesNotMatch(
    SERIAL_TOOL_PROTOCOL_INSTRUCTIONS,
    /a batch is allowed/,
    '串行版里还留着"允许批量"的句子 ⇒ 模型收到自相矛盾的指令',
  )
  assert.doesNotMatch(
    TOOL_PROTOCOL_INSTRUCTIONS,
    /Do NOT batch/,
    '批量版里不该出现"禁止批量"',
  )
})

// ── ② 路由：真 POST 落盘 ──────────────────────────────────────────────

async function boot() {
  const { apply } = await import('../src/index.ts')
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')
  return handler
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(text) { res.body = text ?? '' },
  }
  return res
}

const handler = await boot()

// ⚠️ 路由挂在 `/deepseek-web-login/api` 前缀下（少了前缀一律 404，而 404 与"断言写错"长得一样）；
//    假 req 必须是真 EventEmitter —— `readJsonBody` 会调 `req.off(...)`，
//    否则 cleanup 抛在 promise 里 ⇒ promise 永不结算（表现为用例挂在 await 上）。
const API = '/deepseek-web-login/api'

function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function post(route, payload) {
  const res = fakeRes()
  await handler(fakeReq('POST', API + route, payload), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

async function get(route) {
  const res = fakeRes()
  await handler(fakeReq('GET', API + route), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

const gateFile = join(HOME, 'web-login', 'gate.json')

await test('POST /gate {serialToolCalls:true} 被接受并写进 gate.json', async () => {
  const { status, data } = await post('/gate', { serialToolCalls: true })
  assert.equal(
    status,
    200,
    `漏了白名单就会必然 400「没有可更新的字段」，实际 status=${status} body=${JSON.stringify(data)}`,
  )
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.serialToolCalls, true, '**落盘**才是这一段的意义')
})

await test('POST {serialToolCalls:false} 也能落盘（关回去要有效）', async () => {
  const { status } = await post('/gate', { serialToolCalls: false })
  assert.equal(status, 200)
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.serialToolCalls, false, 'false 必须真的写下去 —— 只写 true 的话关不掉')
})

await test("非布尔一律 400（挡住字符串 'false' 这种「看着关了实际开着」）", async () => {
  for (const bad of ['false', 0, 1, 'true', null]) {
    const { status } = await post('/gate', { serialToolCalls: bad })
    assert.equal(status, 400, `${JSON.stringify(bad)} 应被拒 —— 字符串 'false' 是真值，静默当开最坑`)
  }
})

await test('GET /gate 回显当前值（而不是只在为 true 时才出现）', async () => {
  await post('/gate', { serialToolCalls: true })
  const on = await get('/gate')
  assert.equal(on.data?.serialToolCalls, true)
  await post('/gate', { serialToolCalls: false })
  const off = await get('/gate')
  assert.equal(
    off.data?.serialToolCalls,
    false,
    '关掉之后必须能读到 false —— 靠"字段缺失"表示关闭，界面会把它当成旧宿主而没有默认值可回落',
  )
})

// ── ③ 末段：adapter 真正发出去的 prompt 用的是哪一版 ──────────────────

const AUTH = { token: 't'.repeat(64), cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'test-ua', capturedAt: '2026-09-11T00:00:00.000Z' }

/** 跑一遍 adapter，从 streamCompletion 抓真正发出去的那份 prompt。 */
async function capturePrompt(config) {
  let prompt = null
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config,
    noteCall: () => {},
    streamCompletion: (_auth, params) => {
      if (prompt === null) prompt = params?.prompt
      return (async function* () {
        // ⚠️ 正文必须以句号收尾：否则「句中被截」判据会触发自动续写，
        //    同一个 streamCompletion 被调第二轮（那时 prompt 已经变了）。
        yield { kind: 'text', text: `${'x'.repeat(39)}.` }
        yield { kind: 'finish', reason: 'FINISHED' }
      })()
    },
  })
  for await (const _event of adapter.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    // ⚠️ 必须给工具：`serializePromptParts` 只在**有工具目录**时才拼协议段
    //    （`toolSection ? protocol + toolSection : ''`）—— 不传就整段没有，
    //    于是"断言 prompt 里含哪一版指令"会全部落到"两版都不含"上。
    tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }],
  })) {
    // 只为把 generator 跑完
  }
  assert.ok(prompt, '自证：拿到了真正发出去的 prompt')
  return prompt
}

await test('默认（什么都没设）⇒ 发出去的就是串行版 —— 0.5.0 起改的默认', async () => {
  const prompt = await capturePrompt({})
  assert.match(
    prompt,
    /Exactly ONE LIDOW: line/,
    '默认必须是"一次只发一个工具调用"。要改回默认批量，先把这条用例连同 CHANGELOG 一起改。',
  )
  assert.doesNotMatch(prompt, /a batch is allowed/, '默认路径不该出现批量版那句')
  assert.ok(prompt.includes(SERIAL_TOOL_PROTOCOL_INSTRUCTIONS), '整段串行版指令要原样出现')
})

await test('显式 serialToolCalls:false ⇒ 才用批量版', async () => {
  const prompt = await capturePrompt({ serialToolCalls: false })
  assert.match(prompt, /a batch is allowed/, '显式允许并行时才该是批量版')
  assert.doesNotMatch(prompt, /Exactly ONE LIDOW: line/)
  assert.ok(
    prompt.includes(TOOL_PROTOCOL_INSTRUCTIONS),
    '整段批量版指令要原样出现（不是被改过几个字的变体）',
  )
})

await test('两版在 prompt 里的差异只在协议段，它之后的每一字都相同', async () => {
  const on = await capturePrompt({})                          // 默认 = 串行
  const off = await capturePrompt({ serialToolCalls: false })  // 显式 = 批量
  assert.notEqual(on, off, '开关必须真的改变发出去的文本')
  /** 取协议段**之后**的部分 = 工具目录 + 转写。 */
  const afterProtocol = (text) => {
    const marker = text.includes(SERIAL_TOOL_PROTOCOL_INSTRUCTIONS)
      ? SERIAL_TOOL_PROTOCOL_INSTRUCTIONS
      : TOOL_PROTOCOL_INSTRUCTIONS
    const at = text.indexOf(marker)
    assert.ok(at >= 0, '自证：prompt 里能找到那段协议')
    return text.slice(at + marker.length)
  }
  assert.equal(
    afterProtocol(on),
    afterProtocol(off),
    '协议段之后的每一字都必须相同 —— 不同就说明这次改动溢出了"只换指令"这个范围',
  )
  // 反过来：协议段**之前**（system）也要一致
  const beforeProtocol = (text) => text.slice(0, text.indexOf('# Tool Calling Protocol'))
  assert.equal(beforeProtocol(on), beforeProtocol(off), '协议段之前的 system 部分同样不该受影响')
})

await test('续写轮也用同一版指令（只改首轮⇒同一会话里指令来回变，head 会抖）', async () => {
  const prompts = []
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: {}, // 默认（串行）—— 顺带覆盖新默认
    noteCall: () => {},
    streamCompletion: (_auth, params) => {
      prompts.push(params?.prompt)
      return (async function* () {
        // ⚠️ 刻意**不以句号收尾** —— 触发「句中被截」判据，adapter 会发起续写轮，
        //    于是 streamCompletion 被再调一次。这正是"两处调用点都要传"里最容易漏的那处。
        yield { kind: 'text', text: 'x'.repeat(40) }
        yield { kind: 'finish', reason: 'FINISHED' }
      })()
    },
  })
  for await (const _event of adapter.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }],
  })) {
    // 跑到收尾
  }
  assert.ok(
    prompts.length >= 2,
    `自证：这一轮要真的触发续写，否则本用例什么都没测到（实际只调了 ${prompts.length} 次）`,
  )
  prompts.forEach((prompt, index) => {
    assert.match(
      prompt,
      /Exactly ONE LIDOW: line/,
      `第 ${index + 1}/${prompts.length} 次调用（续写轮）也必须用串行版 —— 只改首轮的话续写那轮回退批量版`,
    )
  })
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项 ❌\n  ${failures.join('\n  ')}` : '，全部通过 ✅'}`)
process.exit(failures.length === 0 ? 0 : 1)
