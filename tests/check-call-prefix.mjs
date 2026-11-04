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

const {
  ToolCallStreamFilter,
  parseToolCallJson,
  parseXmlToolCalls,
  stripResidualDsml,
  stripDoCalls,
  serializePrompt,
  collectToolParamNames,
  TOOL_PROTOCOL_INSTRUCTIONS,
} =
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
function run(chunks, toolParams) {
  const filter = new ToolCallStreamFilter(undefined, toolParams)
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

// ── 2026-11-04：围栏里的「举例」不许被当成调用执行 ────────────────────────────
// 现场：模型在 ```js 代码块里写一遍 `LIDOW:{"name":…}` 解释协议，
// 旧实现与围栏无关 ⇒ 照抓照执行（用户看到工具被莫名其妙地调用）。

await test('⚠️ 已知限制：围栏里的"举例调用"照旧会被执行（举例保护已关闭）', () => {
  // 试过"带语言名的围栏 + 前文举例语气 ⇒ 不执行"，但它和**既有的围栏兜底**直接冲突：
  // 模型非常爱用 ```json 包**真调用**，任何"像举例"的判据都会把真调用吞掉（静默不执行、白跑一轮）。
  // 取舍：**宁可执行一次举例，也不要让真调用静默失效**。判据函数与围栏追踪器都留在
  // protocol.ts 里（`inNonCallFence`），等有足够真机样本再定阈值。
  const raw = '看这个例子：\n```js\nLIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}\n```\n以上是协议。'
  const { calls, text } = run([raw])
  assert.equal(calls.length, 1, '当前行为：围栏里的调用照旧执行（见注释与 CHANGELOG）')
  assert.ok(!text.includes('LIDOW:{"name"'), `调用原文不该上屏：${JSON.stringify(text)}`)
})

await test('★ 裸 ``` 围栏仍按调用处理（它是"模型不听话"的兜底路径）', () => {
  // 与"带语言名的围栏算示例"是**两种意图**：
  //  · ```json / ```js 之类的围栏 ⇒ 说明式举例，不执行；
  //  · 裸 ```（没语言名）⇒ 多半是模型拿围栏包真调用（我们协议明确要求不用围栏，它仍会包），
  //    这条兜底不能关，否则真调用静默失效、白跑一轮。
  const raw = '```\nLIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}\n```'
  const { calls } = run([raw])
  assert.equal(calls.length, 1, '裸围栏里的调用必须照常执行')
})

await test('代码块**闭合之后**的真调用照常执行（围栏状态不许闩死）', () => {
  const raw = '```js\nconst a = 1\n```\nLIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}\n'
  const { text, calls } = run([raw])
  assert.equal(calls.length, 1, '代码块之后的调用必须照旧执行')
  assert.equal(calls[0].name, 'read')
  assert.ok(text.includes('const a = 1'), '代码块本身要保留')
  assert.ok(!/LIDOW:/.test(text), '真调用不该上屏')
})

await test('```lidow 围栏也是调用围栏（照旧执行）', () => {
  const raw = '```lidow\n{"name":"read","arguments":{"file_path":"a.txt"}}\n```'
  const { text, calls } = run([raw])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.ok(!/"name"\s*:/.test(text), `调用对象不该上屏：${JSON.stringify(text)}`)
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

await test('★ 扁平参数形态：{"name":"write","file_path":…} 直接当参数（分享链接实证）', () => {
  // 模型按协议写的就是扁平形态 —— 参数不包在 arguments 里。
  // 旧解析只认 arguments/parameters/args ⇒ 拿到 {} ⇒ write 被执行并报 missing property（假失败）。
  const calls = parseToolCallJson(
    JSON.stringify({ name: 'write', file_path: 'F:////a////b.html', content: '<html></html>' }),
  )
  assert.equal(calls?.length, 1)
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.file_path, 'F:////a////b.html')
  assert.equal(args.content, '<html></html>')
  assert.ok(!('name' in args), 'name 不该混进参数里')
})

// ── 2026-11-04：扁平形态只接受**本轮 schema 声明过的键** ─────────────────────
// 现场：`{"name":"x","meta":{…}}` 的 `meta` 是信封字段，旧实现"除 name/tool 之外全当参数"
// ⇒ 被塞进 arguments，工具报 unexpected property。
// ⚠️ schema 缺失 / 未知工具名时**必须保持宽松**（未知工具要照实执行，让运行器报 unknown tool）。

const SCHEMAS = collectToolParamNames([
  { name: 'write', description: '', parameters: { file_path: { type: 'string' }, content: { type: 'string' } } },
  { name: 'shell', description: '', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
])

await test('★ 扁平参数：schema 没声明的键（meta）不许进 arguments', () => {
  const calls = parseToolCallJson(
    JSON.stringify({ name: 'write', file_path: 'a.html', content: '<html/>', meta: { trace: 1 } }),
    SCHEMAS,
  )
  assert.equal(calls?.length, 1)
  const args = JSON.parse(calls[0].arguments)
  assert.deepEqual(args, { file_path: 'a.html', content: '<html/>' }, `信封字段混进参数了：${calls[0].arguments}`)
})

await test('★ 标准 JSON Schema 包裹形态也按 properties 收键', () => {
  const calls = parseToolCallJson(
    JSON.stringify({ name: 'shell', command: 'ls', meta: { x: 1 } }),
    SCHEMAS,
  )
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' })
})

await test('★ 未知工具名保持宽松（不许因为没 schema 就丢参数）', () => {
  const calls = parseToolCallJson(JSON.stringify({ name: 'unknown_tool', foo: 1, meta: 2 }), SCHEMAS)
  assert.equal(calls?.length, 1, '未知工具必须照实执行，让运行器报 unknown tool')
  assert.deepEqual(JSON.parse(calls[0].arguments), { foo: 1, meta: 2 })
})

await test('★ 完全不传 schema 时保持旧行为（宽松）', () => {
  const calls = parseToolCallJson(JSON.stringify({ name: 'write', file_path: 'a', meta: 1 }))
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a', meta: 1 })
})

await test('★ 过滤器把 schema 一路带到解析处（LIDOW 扁平调用）', () => {
  const { calls } = run(['LIDOW:{"name":"write","file_path":"a","meta":{"x":1}}\n'], SCHEMAS)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a' })
})

await test('★ 长正文 + 分块边界落在半截 LIDOW 上：整条调用不许漏上屏（DO→LIDOW 改名时漏掉的那条）', () => {
  /**
   * 现场机制：hold-back 的半截前缀表只写了 `D/DO/DO:`。当 pending 已经**超过 24 字符**
   * （长正文）时，尾部停在 `LIDOW` / `LIDOW:` 不会被扣留 ⇒ 前缀被当正文推出去，
   * 随后补上的 `:{"name":…}` 再也拼不回标记 ⇒ 调用既不上屏也不执行。
   * 每个前缀都单独跑：`L` / `LI` / `LID` 走的是同一条判据。
   */
  const pad = '这是一段足够长的正文内容用来把 pending 撑过二十四个字符\n'
  const full = 'LIDOW:{"name":"read","arguments":{"file_path":"a.txt"}}'
  for (const head of ['L', 'LI', 'LID', 'LIDO', 'LIDOW', 'LIDOW:', 'lidow', 'lIDOW:']) {
    const { text, calls } = run([pad + head, full.slice(head.length)])
    assert.equal(calls.length, 1, `分块边界在 ${JSON.stringify(head)} 时调用丢了`)
    assert.equal(calls[0].name, 'read')
    assert.equal(text, pad, `分块边界在 ${JSON.stringify(head)} 时前缀/调用漏上屏：${JSON.stringify(text)}`)
  }
})

await test('★ 调用后紧跟的三个 DSML 闭标签：push 阶段就不许上屏（flush 的补刀收不回来）', () => {
  const raw =
    '答案\nLIDOW:{"name":"write","file_path":"a.txt"}</｜｜DSML｜｜ parameter>\n' +
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n尾'
  const filter = new ToolCallStreamFilter()
  let text = ''
  const calls = []
  for (const out of [filter.push(raw)]) {
    text += out.text
    calls.push(...out.calls)
  }
  // 关键在 **push**：用户看到的是逐块交出去的那份，flush 再清也收不回
  assert.ok(!/DSML/i.test(text), `流式过程中闭标签已经上屏：${JSON.stringify(text)}`)
  const tail = filter.flush()
  text += tail.text
  calls.push(...tail.calls)
  assert.equal(calls.length, 1)
  assert.ok(!/DSML/i.test(text), `流结束后仍有标记：${JSON.stringify(text)}`)
  assert.ok(text.includes('尾'), '正文被吃了')
})

await test('★ 正文里的 "DO: {...}"（举例，不是调用）不许被吞掉前缀', () => {
  const prose = '解释一下\nDO: {"foo": 1} 是一个例子\n后续'
  const { text, calls } = run([prose])
  assert.equal(calls.length, 0, '举例不该被当成调用')
  assert.equal(text, prose, `正文被改了：${JSON.stringify(text)}`)
  // 历史回灌走的是 stripDoCalls，同一判据（否则正文里的例子会在下一轮被删掉）
  assert.equal(stripDoCalls(prose), prose, `stripDoCalls 吞了正文：${JSON.stringify(stripDoCalls(prose))}`)
})

await test('★ 孤立 DSML 闭标签（没有开标签）也要剥掉', () => {
  const text = '正文</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  const out = stripResidualDsml(text)
  assert.ok(!/DSML/.test(out), `闭标签还在：${JSON.stringify(out)}`)
  assert.ok(out.startsWith('正文'), '正文被吃了')
})

await test('★ 坏掉的 DSML 块（有 parameter 标签但解析不出参数）不许当 {} 执行', () => {
  const bad =
    '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="write">' +
    '<｜｜DSML｜｜parameter>内容</｜｜DSML｜｜parameter>' +
    '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>'
  const calls = parseXmlToolCalls(bad)
  const write = calls?.find((call) => call.name === 'write')
  assert.ok(
    !write || JSON.parse(write.arguments ?? '{}').file_path !== undefined || Object.keys(JSON.parse(write.arguments ?? '{}')).length > 0,
    '不该用空参数执行 —— 这次会报 missing required property',
  )
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
