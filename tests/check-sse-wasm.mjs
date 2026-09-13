/**
 * 回归测试：审计中危项 F12 / F13（2026-09-12）
 *
 * F13  SSE 多行 data：规范允许一个事件里多个 `data:` 行，须用 \n 拼接后整体解析。
 *      旧实现逐行 JSON.parse → 服务端拆行时每行都失败 → 被 catch 静默丢弃。
 * F12  PoW WASM 地址白名单：auth.wasmUrl 可来自导入的备份，须挡住 SSRF。
 */
import assert from 'node:assert/strict'
import { checkedWasmUrl } from '../src/webapi.ts'
import { parseWebSse } from '../src/webapi.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

/** 把 SSE 文本做成 body（iterateLines 接受 getReader 或异步可迭代）。 */
function sseBody(text) {
  const encoder = new TextEncoder()
  return (async function* () {
    // 一个 UTF-8 字符可能被切在中间，用 TextDecoder stream 模式拼回来；这里整块给即可
    yield encoder.encode(text)
  })()
}

/** 跑一遍流，返回拼起来的正文。 */
async function collectText(sse) {
  let text = ''
  for await (const event of parseWebSse(sseBody(sse))) {
    if (event?.kind === 'text') text += event.text
  }
  return text
}

console.log('F13 — SSE 多行 data')

await test('单行 data：正常解析（回归，不能改坏）', async () => {
  const sse = 'data: {"v":{"response":{"content":"你好"}}}\n\ndata: [DONE]\n\n'
  assert.equal(await collectText(sse), '你好')
})

await test('多行 data：拼接后整体解析（旧代码会整段丢弃）', async () => {
  // 同一个 JSON 被拆到两行（中间没有空行 = 仍是同一个事件）。
  // 逐行 JSON.parse 时两行都是坏 JSON → 旧实现整段静默丢弃。
  const multi =
    'data: {"v":{"response":\n' + 'data: {"content":"CD"}}}\n\n' + 'data: [DONE]\n\n'
  // 先自证：这个用例本身必须能拼出合法 JSON，否则测的是我自己的笔误
  const joined = ['{"v":{"response":', '{"content":"CD"}}}'].join('\n')
  assert.doesNotThrow(() => JSON.parse(joined), '测试用例本身必须拼出合法 JSON')
  const text = await collectText(multi)
  assert.ok(
    text.includes('CD'),
    `多行 data 应被拼接解析，实际得到 ${JSON.stringify(text)}（为空 = 事件被静默丢弃）`,
  )
})

await test('payload 自带换行（JSON 字符串里的 \\n）不被当成事件分隔', async () => {
  const payload = JSON.stringify({ v: { response: { content: '第一行\n第二行' } } })
  const sse = `data: ${payload}\n\ndata: [DONE]\n\n`
  const text = await collectText(sse)
  assert.ok(text.includes('第一行') && text.includes('第二行'), `实际：${JSON.stringify(text)}`)
})

await test('末尾没有空行时，攒下的 data 不能丢', async () => {
  const sse = 'data: {"v":{"response":{"content":"尾巴"}}}'
  const text = await collectText(sse)
  assert.equal(text, '尾巴')
})

await test('坏 JSON 不炸、不产出事件（保持静默丢弃语义）', async () => {
  const sse = 'data: {这不是 JSON\n\ndata: {"v":{"response":{"content":"OK"}}}\n\ndata: [DONE]\n\n'
  const text = await collectText(sse)
  assert.equal(text, 'OK')
})

await test('[DONE] 之后不再解析后续事件', async () => {
  const sse =
    'data: {"v":{"response":{"content":"前"}}}\n\ndata: [DONE]\n\ndata: {"v":{"response":{"content":"后"}}}\n\n'
  const text = await collectText(sse)
  assert.equal(text, '前')
})

console.log()
console.log('F12 — PoW WASM 地址白名单')

const allowed = [
  'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
  // 未来换 CDN / 换子域仍要能用（默认地址带内容哈希，官方一改就失效，必须留后路）
  'https://cdn.deepseek.com/x/sha3_wasm_bg.abc.wasm',
  'https://deepseek.com/a.wasm',
]
const denied = [
  ['云元数据（SSRF 经典目标）', 'http://169.254.169.254/latest/meta-data/'],
  ['https 版云元数据', 'https://169.254.169.254/latest/meta-data/iam.wasm'],
  ['localhost', 'http://localhost:8080/a.wasm'],
  ['file 协议', 'file:///C:/evil.wasm'],
  ['http 明文', 'http://fe-static.deepseek.com/a.wasm'],
  ['带凭据', 'https://user:pw@fe-static.deepseek.com/a.wasm'],
  ['非 .wasm 路径', 'https://fe-static.deepseek.com/chat/static/app.js'],
  ['第三方域名', 'https://evil.example.com/a.wasm'],
  // 双后缀绕过：看着像 deepseek，其实是攻击者域名
  ['伪装后缀', 'https://fe-static.deepseek.com.evil.example.com/a.wasm'],
  ['非法字符串', 'not a url'],
  ['空值', ''],
  ['非字符串', 42],
]

for (const url of allowed) {
  await test(`允许：${url.replace('https://', '')}`.slice(0, 74), async () => {
    const got = checkedWasmUrl(url)
    assert.ok(got, `应当允许，实际被拒：${url}`)
    assert.ok(got.startsWith('https://'), '规范化后仍是 https')
  })
}

for (const [label, url] of denied) {
  await test(`拒绝：${label}`, async () => {
    assert.equal(checkedWasmUrl(url), undefined, `不应当允许：${String(url)}`)
  })
}

console.log()
console.log('服务端真实 token 用量（accumulated_token_usage）')

// ⚠️ 夹具是 2026-09-13 抓到的**真实响应**，逐字照抄（含那个初始为 0 的快照字段）。
//    判定脚本的第一版就是因为取了末尾快照的 0，把「本消息」误判成「会话累计」——
//    这两条用例专门守住那个坑。
const NL = String.fromCharCode(10)
const REAL_TINY = [
  'event: ready',
  'data: {"request_message_id":3,"response_message_id":4,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1789262855.854146}',
  '',
  'data: {"v":{"response":{"message_id":4,"parent_id":3,"model":"","role":"ASSISTANT","thinking_enabled":false,"ban_edit":false,"ban_regenerate":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"feedback":null,"inserted_at":1789262855.8448339,"search_enabled":false,"fragments":[{"id":2,"type":"RESPONSE","content":"收到","references":[],"stage_id":1}],"conversation_mode":"DEFAULT","has_pending_fragment":false,"auto_continue":false,"search_triggered":false}}}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38},{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: update_session',
  'data: {"updated_at":1789262855.909791}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
].join(NL)

/** 跑一遍流，返回全部事件。 */
async function collectEvents(sse) {
  const out = []
  const encoder = new TextEncoder()
  const body = (async function* () {
    yield encoder.encode(sse)
  })()
  for await (const event of parseWebSse(body)) out.push(event)
  return out
}

await test('真实样本：finish 事件带出服务端上报的 totalTokens(=38)', async () => {
  const events = await collectEvents(REAL_TINY)
  const finish = events.find((e) => e.kind === 'finish')
  assert.ok(finish, '应当有 finish 事件（自证：流真的跑完了）')
  assert.equal(finish.totalTokens, 38, `应取 patch 里的 38，实际 ${finish.totalTokens}`)
})

await test('快照里的 0 不能当成结果：只有快照、没有 patch 时应报「拿不到」', async () => {
  // 「判定脚本第一版」就是翻在这个坑上：快照字段 accumulated_token_usage 初始恒为 0
  // （status 还是 WIP），真正的值在后面的 patch 里。取错位置 → 得到 0，结论整个反过来。
  //
  // ⚠️ 这条必须能区分：如果实现去哪读快照，就会得到 0 而不是 undefined → 变红。
  //    （早先写的「断言 notEqual 0」是假的守护——patch 在快照之后到达、照样覆盖成 38，
  //     把实现改坏也测不出来。反向验证第 D 条没红就是因为这个。）
  const snapshotOnly = [
    'data: {"v":{"response":{"message_id":4,"status":"WIP","accumulated_token_usage":0,"fragments":[{"id":2,"type":"RESPONSE","content":"收到"}]}}}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
  ].join(NL)
  const finish = (await collectEvents(snapshotOnly)).find((e) => e.kind === 'finish')
  assert.ok(finish, '应当有 finish（自证）')
  assert.equal(finish.totalTokens, undefined, '只有快照的 0 时应报「拿不到」，而不是 0')
})

await test('长 prompt 的真实样本：totalTokens(=6446)', async () => {
  const longSse =
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":6446},{"p":"quasi_status","v":"FINISHED"}]}' +
    NL + NL +
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}' + NL + NL
  const finish = (await collectEvents(longSse)).find((e) => e.kind === 'finish')
  assert.equal(finish.totalTokens, 6446)
})

await test('没有该字段时就不带 totalTokens（调用方退回估算）', async () => {
  const plain = 'data: {"v":{"response":{"content":"hi"}}}' + NL + NL + 'data: [DONE]' + NL + NL
  const finish = (await collectEvents(plain)).find((e) => e.kind === 'finish')
  assert.ok(finish, '应当有 finish（自证）')
  assert.equal(finish.totalTokens, undefined, '拿不到就别编一个数')
})

await test('非数字的脏值不采信', async () => {
  const dirty =
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":"??"}]}' + NL + NL +
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}' + NL + NL
  const finish = (await collectEvents(dirty)).find((e) => e.kind === 'finish')
  assert.equal(finish.totalTokens, undefined)
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
