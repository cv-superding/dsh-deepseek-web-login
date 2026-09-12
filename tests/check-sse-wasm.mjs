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
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
