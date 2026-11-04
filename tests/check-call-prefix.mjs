/**
 * `LIDOW:{…}` 主协议前缀（2026-11-04）。
 *
 * 为什么是这个形状：网页版模型在**思考链**里就是用 `LIDOW:` 写工具调用的。让它用同一套写法，
 * 它不必在两套语法之间切换 —— 之前要求的 ```dsh-tool 围栏对它来说是另一种方言，
 * 它时不时退回原生标记（DSML），我们只好一路擦泄漏。
 *
 * 这里守四件事：
 *  1. **解析**：`LIDOW:{"name":…}` 单调用形状（以及 `tool`/`args` 别名）能被认出来；
 *  2. **不上屏**：`LIDOW:` 那一行（含逐字符分块、含半截 `D` / `DO` / `LIDOW:`）绝不进正文；
 *  3. **兜底不退化**：围栏 / 裸 JSON / XML 仍然照旧可用（模型旧习惯不该直接失败）；
 *  4. **历史不回灌**：上一轮残留的 `LIDOW:` 行会被剥掉（否则模型照抄，与 DSML 同一个坑）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-do-protocol-'))

const { ToolCallStreamFilter, parseToolCallJson, stripDoCalls, serializePrompt, TOOL_PROTOCOL_INSTRUCTIONS } =
  await import('../src/protocol.ts')

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

/** 把分块推过过滤器，返回最终可见正文与调用。 */
function run(chunks) {
  const filter = new ToolCallStreamFilter()
  let text = ''
  const calls = []
  for (const chunk of chunks) {
    const out = filter.push(chunk)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = filter.flush()
  text += tail.text
  calls.push(...tail.calls)
  return { text, calls }
}

await test('LIDOW: 单调用一次性到达 ⇒ 解析出调用，正文里没有 LIDOW:', () => {
  const { text, calls } = run(['答案第一段\nLIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}\n'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a.txt' })
  assert.equal(text, '答案第一段\n', `正文不该含标记：${JSON.stringify(text)}`)
})

await test('LIDOW: 逐字符到达也不漏标记（半截 D / DO / LIDOW: 要扣留）', () => {
  const raw = '答答答\nLIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}'
  const { text, calls } = run(raw.split(''))
  assert.equal(calls.length, 1, '逐字符分块下也要解析出调用')
  assert.equal(text, '答答答\n')
  assert.ok(!/LIDOW:/.test(text), '正文里出现了 LIDOW:')
})

await test('两条 DO 行 ⇒ 两条调用，中间正文保留', () => {
  const { text, calls } = run(['x\nLIDOW:{"name":"a","arguments":{}}\n中间\nLIDOW:{"name":"b","arguments":{"n":1}}\n尾巴'])
  assert.deepEqual(
    calls.map((call) => call.name),
    ['a', 'b'],
  )
  assert.equal(text, 'x\n中间\n尾巴')
})

await test('别名形状 {"tool":…,"args":…} 也认', () => {
  const calls = parseToolCallJson('{"tool":"read","args":{"p":1}}')
  assert.equal(calls?.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { p: 1 })
})

await test('非行首的 "LIDOW:" 是正文，不是调用', () => {
  const { text, calls } = run(['我说 LIDOW: 这个是协议标记，不动它'])
  assert.equal(calls.length, 0)
  assert.equal(text, '我说 LIDOW: 这个是协议标记，不动它')
})

await test('围栏兜底仍可用（模型旧习惯不该直接失败）', () => {
  const { text, calls } = run(['```dsh-tool\n{"tool_calls":[{"name":"read","arguments":{"p":"b"}}]}\n```'])
  assert.equal(calls.length, 1)
  // 围栏形态本来就会在正文里留下一个换行（历史行为，不是缺陷）—— 这里只要求"没有可见内容"
  assert.equal(text.trim(), '')
})

await test('stripDoCalls：围栏外切掉、围栏内的示例不动', () => {
  assert.equal(stripDoCalls('前\nLIDOW:{"name":"read","arguments":{}}\n后'), '前\n后')
  const fenced = '```\nLIDOW:{"name":"read","arguments":{}}\n```'
  assert.equal(stripDoCalls(fenced), fenced)
})

await test('历史回灌剥掉上一轮残留的 LIDOW: 行', () => {
  const prompt = String(
    serializePrompt({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '上一轮\nLIDOW:{"name":"read","arguments":{}}\n结束' }] },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
      tools: [],
    }),
  )
  assert.ok(!/LIDOW:\{/.test(prompt), `历史里还有调用行：${prompt.slice(0, 160)}`)
  assert.ok(prompt.includes('上一轮') && prompt.includes('结束'), '正文被吃掉了')
})

await test('协议指令：主形态是 LIDOW:，且仍点名禁止 DSML', () => {
  assert.ok(TOOL_PROTOCOL_INSTRUCTIONS.includes('LIDOW:{"name"'), '指令里没有 DO 示例')
  assert.ok(/never emit DSML/.test(TOOL_PROTOCOL_INSTRUCTIONS), 'DSML 禁令被删了')
  assert.ok(
    TOOL_PROTOCOL_INSTRUCTIONS.length < 3000,
    `指令 ${TOOL_PROTOCOL_INSTRUCTIONS.length} 字符，超预算会挤掉工具定义`,
  )
})

await test('预填续写形态：行首裸 {"name":…} 也算调用（不带 LIDOW: 前缀）', () => {
  const { text, calls } = run(['说明\n{"name":"read","arguments":{"p":"c"}}\n'])
  assert.equal(calls.length, 1, '预填之后模型只续写 JSON，必须认')
  assert.equal(calls[0].name, 'read')
  assert.equal(text, '说明\n', `正文里出现了调用对象：${JSON.stringify(text)}`)
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
