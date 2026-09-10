/**
 * 纯逻辑自测（不依赖 DSH 运行时）：node tests/logic-test.mjs
 * 覆盖：prompt 序列化、工具调用流式过滤器（跨包/围栏/假阳性/多调用）、SSE 状态机。
 */
import assert from 'node:assert/strict'
import { serializePrompt, ToolCallStreamFilter, parseToolCallJson, parseXmlToolCalls, extractBalancedJson, findXmlToolCallEnd, parseJsonLenient, collectImageRefs } from '../src/protocol.ts'
import { createSseState } from '../src/webapi.ts'
import { unwrapStoredToken } from '../src/login.ts'
import { maskIdentifier } from '../src/auth.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`✗ ${name}: ${error?.message ?? error}`)
  }
}

// ── 序列化 ────────────────────────────────────────────────
test('serializePrompt: system + 工具协议 + 转写', () => {
  const prompt = serializePrompt({
    system: 'SYS-MARKER',
    tools: [{ name: 'bash', description: 'run shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  })
  assert.ok(prompt.includes('SYS-MARKER'))
  assert.ok(prompt.includes('Tool Calling Protocol'))
  assert.ok(prompt.includes('### bash'))
  assert.ok(prompt.includes('User: hello'))
  assert.ok(prompt.includes('Assistant: ok'))
  assert.ok(prompt.includes('Assistant: {"tool_calls":[{"name":"bash","arguments":{"cmd":"ls"}}]}'))
  assert.ok(prompt.includes('[Tool Result for c1]'))
  assert.ok(prompt.includes('User: 继续'))
})

test('serializePrompt: 超长时中段截断且保留协议头', () => {
  const messages = []
  for (let i = 0; i < 400; i++) messages.push({ role: 'user', content: [{ type: 'text', text: `消息 ${i} `.repeat(20) }] })
  const prompt = serializePrompt({ system: 'SYS', messages, tools: [{ name: 't', description: 'd', parameters: {} }], maxChars: 5000 })
  assert.ok(prompt.length <= 5000, `长度 ${prompt.length}`)
  assert.ok(prompt.includes('SYS'))
  assert.ok(prompt.includes('Tool Calling Protocol'))
  assert.ok(prompt.includes('chars omitted'))
})

// ── 工具调用过滤 ──────────────────────────────────────────
test('filter: 纯正文透传（含 flush 尾部）', () => {
  const filter = new ToolCallStreamFilter(new Set(['bash']))
  let text = ''
  for (const piece of ['你好', '，这是', '一段普通回答。']) {
    text += filter.push(piece).text
  }
  text += filter.flush().text
  assert.equal(text, '你好，这是一段普通回答。')
})

test('filter: 调用 JSON 跨包 + flush', () => {
  const filter = new ToolCallStreamFilter(new Set(['bash']))
  const chunks = ['我先看一', '下目录。\n{"tool_ca', 'lls":[{"name":"bash","argu', 'ments":{"cmd":"ls -la"}}]}']
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
  assert.equal(calls.length, 1, `calls=${JSON.stringify(calls)} text=${text}`)
  assert.equal(calls[0].name, 'bash')
  assert.deepEqual(JSON.parse(calls[0].arguments), { cmd: 'ls -la' })
  assert.ok(!text.includes('tool_calls'), `正文不应泄露协议 JSON：${text}`)
  assert.ok(text.includes('我先看一下目录。'))
})

test('filter: 围栏代码块包裹的调用', () => {
  const filter = new ToolCallStreamFilter(new Set(['read']))
  const out1 = filter.push('```json\n{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}\n```')
  const tail = filter.flush()
  const calls = [...out1.calls, ...tail.calls]
  const text = out1.text + tail.text
  assert.equal(calls.length, 1, `text=${JSON.stringify(text)}`)
  assert.equal(calls[0].name, 'read')
  assert.equal(text.trim(), '')
})

test('filter: 多个工具调用', () => {
  const filter = new ToolCallStreamFilter(new Set(['a', 'b']))
  const out = filter.push('{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{"x":1}}]}')
  const tail = filter.flush()
  const calls = [...out.calls, ...tail.calls]
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.name), ['a', 'b'])
})

test('filter: 非协议 JSON（假阳性）按正文吐出', () => {
  const filter = new ToolCallStreamFilter(new Set(['bash']))
  const out = filter.push('配置如下：{"name":"demo","arguments":{"a":1}}')
  const tail = filter.flush()
  const text = out.text + tail.text
  assert.equal((out.calls.length + tail.calls.length), 0)
  assert.ok(text.includes('{"name":"demo"'))
})

test('filter: 调用后的剩余文本继续透传', () => {
  const filter = new ToolCallStreamFilter(new Set(['bash']))
  const out = filter.push('{"tool_calls":[{"name":"bash","arguments":{"cmd":"pwd"}}]}\n\n补充说明。')
  const tail = filter.flush()
  const text = out.text + tail.text
  assert.equal(out.calls.length + tail.calls.length, 1)
  assert.ok(text.includes('补充说明。'), text)
})

test('extractBalancedJson: 字符串内的花括号不破坏配平', () => {
  const result = extractBalancedJson('{"tool_calls":[{"name":"bash","arguments":{"cmd":"echo {a}"}}]}{"x":1}')
  assert.ok(result)
  assert.deepEqual(JSON.parse(result.json).tool_calls[0].name, 'bash')
  assert.equal(result.end, 63)
})

test('parseToolCallJson: 单数与字符串参数容错', () => {
  const single = parseToolCallJson('{"tool_call":{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}')
  assert.equal(single.length, 1)
  assert.deepEqual(JSON.parse(single[0].arguments), { cmd: 'ls' })
  assert.equal(parseToolCallJson('{"foo":1}'), null)
})

// ── SSE 状态机 ────────────────────────────────────────────
function drain(state, payloads) {
  const events = []
  for (const [payload, eventName] of payloads) events.push(...state.handle(payload, eventName))
  events.push(...state.finish())
  return events
}
function textOf(events, kind) {
  return events.filter((event) => event.kind === kind).map((event) => event.text).join('')
}

test('sse: fragments 格式（思考 + 正文）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ v: { response: { message_id: 'm1' } } }],
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'THINK', content: '让我想' } }],
    [{ v: '想一下' }],
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '答案是' } }],
    [{ p: 'response/fragments/-1/content', v: ' 42' }],
    [{ v: '。' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '让我想想一下')
  assert.equal(textOf(events, 'text'), '答案是 42。')
  assert.equal(events.at(-1).kind, 'finish')
})

test('sse: 直连 thinking_content / content（含 APPEND 续段）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ p: 'response/thinking_content', v: '思考A' }],
    [{ o: 'APPEND', v: '思考B' }],
    [{ v: '思考C' }],
    [{ p: 'response/content', o: 'APPEND', v: '正文1' }],
    [{ v: '正文2' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '思考A思考B思考C')
  assert.equal(textOf(events, 'text'), '正文1正文2')
})

test('sse: 快照覆盖 + JSON patch 形态', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ v: { response: { fragments: [{ type: 'RESPONSE', content: '第一段' }] } } }],
    [{ p: 'response', v: [{ p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '第二段' } }] }],
    [{ v: { response: { fragments: [{ type: 'RESPONSE', content: '第一段第二段' }] } } }],
  ])
  assert.equal(textOf(events, 'text'), '第一段第二段')
})

test('sse: 错误事件与 toast', () => {
  const state = createSseState()
  const events = drain(state, [[{ type: 'error', content: '内容过长', finish_reason: 'content_length' }]])
  const error = events.find((event) => event.kind === 'error')
  assert.ok(error, JSON.stringify(events))
  assert.equal(error.message, '内容过长')

  const toastState = createSseState()
  const toastEvents = drain(toastState, [[{ content: '版本过低' }, 'toast']])
  assert.ok(toastEvents.some((event) => event.kind === 'error' && event.message.includes('版本过低')))
})

test('sse: 未收到数据时不产出 finish', () => {
  const state = createSseState()
  assert.deepEqual(state.finish(), [])
})

// ── 凭证解包（实测踩坑回归）─────────────────────────────
// 2026-09 网页端把 userToken 存成 AppKit 包装 JSON：{"value":"<token>","__version":...}。
// 早期实现把包装 JSON 原文当 token 用 → 服务端 40003 Authorization Failed →
// 校验永远失败 → 凭证从不落盘（用户已登录成功却报错）。
test('unwrapStoredToken: 解包 AppKit 包装 JSON', () => {
  const wrapped = JSON.stringify({ value: 'dfbDggo/X9dmpyTOKENVALUE', __version: '1.0.0' })
  assert.equal(unwrapStoredToken(wrapped), 'dfbDggo/X9dmpyTOKENVALUE')
})

test('unwrapStoredToken: 兼容裸 token 与空值', () => {
  assert.equal(unwrapStoredToken('dfbDggo/X9dmpyBARE'), 'dfbDggo/X9dmpyBARE')
  assert.equal(unwrapStoredToken(''), '')
  assert.equal(unwrapStoredToken(undefined), '')
  assert.equal(unwrapStoredToken('{"value":123}'), '')
  assert.equal(unwrapStoredToken('{bad json'), '')
})

test('maskIdentifier: 邮箱/手机号/通用', () => {
  assert.equal(maskIdentifier('user1234567@example.com'), 'use***@example.com')
  assert.equal(maskIdentifier('13812345678'), '138****5678')
  assert.equal(maskIdentifier('abcdefgh'), 'abc***gh')
  assert.equal(maskIdentifier(''), '')
  assert.equal(maskIdentifier('ab'), 'a***')
})

// ── XML 风格工具调用（实测漂移：思考模式下模型偶发改用 XML 标记）──────
// 用户实测样本（原实现会把标记当正文吐给用户 —— 必须被识别成真正的工具调用）：
// <tool_calls>
//   <invoke name="read"><parameter name="file_path">C:\...\settings.yaml</parameter></invoke>
//   <invoke name="pwsh"><parameter name="command">python -c "..."</parameter></invoke>
// </tool_calls>

const XML_SAMPLE = `<tool_calls>
<invoke name="read">
<parameter name="file_path">C:\\Users\\me\\.dsh\\settings.yaml</parameter>
</invoke>
<invoke name="pwsh">
<parameter name="command">python -c "import PIL, sys; print('PIL', PIL.__version__)"</parameter>
</invoke>
</tool_calls>`

test('xml: 用户实测样本被解析为两个工具调用', () => {
  const calls = parseXmlToolCalls(XML_SAMPLE)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.name), ['read', 'pwsh'])
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'C:\\Users\\me\\.dsh\\settings.yaml' })
  assert.ok(JSON.parse(calls[1].arguments).command.includes('import PIL'))
})

test('filter: XML 调用跨包流入 → 转成 calls，不泄漏标记', () => {
  const filter = new ToolCallStreamFilter(new Set(['read', 'pwsh']))
  const chunks = ['先看一下配置。\n<tool_ca', 'lls>\n<invoke name="read">\n<parameter name="file_path">C:\\a.yaml</parameter>\n</inv', 'oke>\n</tool_calls>']
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
  assert.equal(calls.length, 1, `calls=${JSON.stringify(calls)} text=${text}`)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'C:\\a.yaml' })
  assert.ok(!/<tool_calls|<invoke/.test(text), `标记泄漏：${text}`)
  assert.ok(text.includes('先看一下配置。'))
})

test('xml: 裸 invoke（无包裹）+ CDATA + 单引号属性', () => {
  const calls = parseXmlToolCalls(`<invoke name='pwsh'><parameter name="command"><![CDATA[echo "hi" && ls]]></parameter></invoke>`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'pwsh')
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'echo "hi" && ls' })
})

test('xml: DSML 前缀与连字符变体', () => {
  const calls = parseXmlToolCalls(`<|DSML|tool_calls><|DSML|invoke name="read"><|DSML|parameter name="file_path">a.txt</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a.txt' })

  const hyphen = parseXmlToolCalls(`<dsml-tool_calls><dsml-invoke name="x"><dsml-parameter name="y">1</dsml-parameter></dsml-invoke></dsml-tool_calls>`)
  assert.equal(hyphen.length, 1)
  assert.deepEqual(JSON.parse(hyphen[0].arguments), { y: 1 })
})

test('xml: 参数值按 JSON 解析（数字/对象/布尔）', () => {
  const calls = parseXmlToolCalls(`<invoke name="t"><parameter name="n">42</parameter><parameter name="o">{"a":1}</parameter><parameter name="b">true</parameter><parameter name="s">plain</parameter></invoke>`)
  assert.deepEqual(JSON.parse(calls[0].arguments), { n: 42, o: { a: 1 }, b: true, s: 'plain' })
})

test('xml: 围栏包裹与后续正文分离', () => {
  const filter = new ToolCallStreamFilter(new Set(['read']))
  const out = filter.push('```xml\n<tool_calls><invoke name="read"><parameter name="file_path">b.txt</parameter></invoke></tool_calls>\n```\n以上就是我要做的。')
  const tail = filter.flush()
  const text = out.text + tail.text
  const calls = [...out.calls, ...tail.calls]
  assert.equal(calls.length, 1)
  assert.ok(text.includes('以上就是我要做的。'), text)
  assert.ok(!text.includes('<invoke'), text)
})

test('xml: 未闭合的调用在 flush 时降级（内容不消失）', () => {
  const filter = new ToolCallStreamFilter(new Set(['read']))
  const out = filter.push('<tool_calls><invoke name="read"><parameter name="file_path">c.txt</parameter>')
  const tail = filter.flush()
  const text = out.text + tail.text
  const calls = [...out.calls, ...tail.calls]
  assert.ok(calls.length > 0 || text.includes('<tool_calls'), `calls=${calls.length} text=${text}`)
})

test('xml: 正文里讨论 <invoke> 不被误吞', () => {
  const filter = new ToolCallStreamFilter(new Set(['read']))
  const out = filter.push('在 HTML 里 <invoke> 不是一个标准标签，它只是普通文字。')
  const tail = filter.flush()
  const text = out.text + tail.text
  const calls = [...out.calls, ...tail.calls]
  assert.equal(calls.length, 0)
  assert.ok(text.includes('<invoke>'), text)
})

// ── JSON 宽容解析（实测：模型发 Windows 路径用单反斜杠 → JSON.parse 抛错 →
//    工具调用解析失败、整段标记被当正文吐给用户，见用户实测回复）────────────
test('repair: 未转义的 Windows 路径仍能解析出工具调用', () => {
  const malformed = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem D:\\apps\\DSH Desktop","description":"list"}}]}'
  assert.throws(() => JSON.parse(malformed), '前提：原文确实是非法 JSON')
  const calls = parseToolCallJson(malformed)
  assert.ok(calls && calls.length === 1, `calls=${JSON.stringify(calls)}`)
  assert.equal(calls[0].name, 'pwsh')
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.command, 'Get-ChildItem D:\\apps\\DSH Desktop')
  assert.equal(args.description, 'list')
})

test('repair: 尾逗号与字符串内裸换行', () => {
  const trailing = parseJsonLenient('{"a":1,"b":[1,2,],}')
  assert.deepEqual(trailing, { a: 1, b: [1, 2] })
  const newline = parseJsonLenient('{"s":"line1\nline2"}')
  assert.deepEqual(newline, { s: 'line1\nline2' })
})

test('repair: 合法 JSON 不受影响（含转义反斜杠/引号/unicode）', () => {
  const good = '{"p":"C:\\\\Users\\\\a","q":"say \\"hi\\"","u":"\\u4e2d"}'
  assert.deepEqual(parseJsonLenient(good), JSON.parse(good))
})

test('filter: 用户实测的非法 JSON 工具调用不再泄漏为正文', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh', 'grep']))
  const leaked = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem env: | Where-Object { $_.Name -match \'DSH|API\' }","description":"List env vars"}},{"name":"grep","arguments":{"pattern":"baseURL|describe-image","path":"D:\\apps\\harness\\DSH Desktop\\resources\\app.asar\\","include":"*.json"}}]}'
  const out = filter.push(leaked)
  const tail = filter.flush()
  const calls = [...out.calls, ...tail.calls]
  const text = out.text + tail.text
  assert.equal(calls.length, 2, `calls=${JSON.stringify(calls)} text=${text}`)
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'grep'])
  const grepArgs = JSON.parse(calls[1].arguments)
  // 路径必须逐字还原：\A/\D 不丢反斜杠、\r 不得变成回车、结尾 \ 保持单个
  assert.equal(grepArgs.path, 'D:\\apps\\harness\\DSH Desktop\\resources\\app.asar\\')
  assert.ok(!grepArgs.path.includes('\r'), '路径里不应出现回车字符')
  assert.ok(!text.includes('tool_calls'), `正文泄漏：${text}`)
})

test('serializePrompt: 图片输出可定位占位标记（本体走 ref_file_ids）', () => {
  const prompt = serializePrompt({
    system: 'S',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { attachmentId: 'a1' } }] }],
  })
  assert.ok(prompt.includes('看这张图'))
  assert.ok(prompt.includes('[image attached]'), prompt)
  assert.ok(!prompt.includes('text-only'), '不应再声称纯文本')
})

test('collectImageRefs: 收集正文与工具结果里的图片引用', () => {
  const refs = collectImageRefs([
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: { attachmentId: 'b' } }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
  ])
  assert.deepEqual(refs.map((r) => r.attachmentId), ['a', 'b'])
})

// 用户实测样本 #2（2026-09）：命令里带 app.asar 路径，单反斜杠
// （\A 非法；而 \r 在 JSON 里合法 → 只补非法转义会把 \resources 变成回车，路径被改坏）
const SAMPLE_2 = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem \'D:\\apps\\harness\\DSH Desktop\\resources\\app.asar\' | Select-Object Name, Length, Mode","description":"List app.asar checkout contents"}}]}'

test('repair: 样本#2 解析成功且 \\resources 不被当成回车', () => {
  assert.throws(() => JSON.parse(SAMPLE_2), '前提：原文非法 JSON')
  const calls = parseToolCallJson(SAMPLE_2)
  assert.ok(calls && calls.length === 1, `calls=${JSON.stringify(calls)}`)
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.description, 'List app.asar checkout contents')
  // 关键：路径必须逐字还原（\A 不丢反斜杠、\r 不得变成回车）
  assert.ok(args.command.includes('D:\\apps\\harness\\DSH Desktop\\resources\\app.asar'), args.command)
  assert.ok(!args.command.includes('\r'), '路径里不应出现回车字符')
})

test('repair: 合法转义与非法转义混在一条命令里也还原正确', () => {
  const mixed = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"cd \\"F:\\Code\\DSH-Code\\" ; echo ok"}}]}'
  assert.throws(() => JSON.parse(mixed))
  const calls = parseToolCallJson(mixed)
  assert.ok(calls && calls.length === 1, JSON.stringify(calls))
  const command = JSON.parse(calls[0].arguments).command
  assert.equal(command, 'cd "F:\\Code\\DSH-Code" ; echo ok')
})

test('filter: 样本#2 不再把工具调用泄漏成正文', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  const out = filter.push(SAMPLE_2)
  const tail = filter.flush()
  const calls = [...out.calls, ...tail.calls]
  const text = out.text + tail.text
  assert.equal(calls.length, 1, `text=${text}`)
  assert.equal(calls[0].name, 'pwsh')
  assert.ok(!text.includes('tool_calls'), `正文泄漏：${text}`)
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：` : '，全部通过 ✅'}`)
if (failures.length) {
  for (const failure of failures) console.log(failure)
  process.exitCode = 1
}
