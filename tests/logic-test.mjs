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

// ── F24：思考续段不得上屏（2026-09-13 实测）──────────────────────
// 思考阶段服务端分两步下发：先 `response/thinking_content` 发开头一小段（建立 sink='thinking'），
// 再用 `response/fragments/-1/content` 发**思考的其余全部**。旧实现在 fragments 为空时把这条
// 路径无条件当正文发射 → 整段思考上屏（该会话 268 条消息里 7 条中招，最长 14877 字符），
// 且这些正文块开头都缺 2~4 个字符（" me analyze…" 本该是 "Let me analyze…"）。
test('sse: fragments 为空时 -1/content 必须跟随 sink=thinking（F24）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ p: 'response/thinking_content', v: 'Let' }],
    [{ p: 'response/fragments/-1/content', v: ' me analyze the situation.' }],
    // 后续续段也要跟对 —— sink 不能被这条路径改掉，否则下面这条会退回正文
    [{ p: 'response/fragments/-1/content', v: ' The user wants a plugin.' }],
    // 裸续段走 appendSink，同样必须留在思考通道
    [{ v: ' 结论：可行。' }],
    [{ p: 'response/content', v: '正文开始' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), 'Let me analyze the situation. The user wants a plugin. 结论：可行。')
  assert.equal(textOf(events, 'text'), '正文开始')
})

test('sse: fragments 非空时 -1/content 仍续在最后一个 fragment 上（F24 不回归）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'THINK', content: '思考甲' } }],
    [{ p: 'response/fragments/-1/content', v: '思考乙' }],
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '正文甲' } }],
    [{ p: 'response/fragments/-1/content', v: '正文乙' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '思考甲思考乙')
  assert.equal(textOf(events, 'text'), '正文甲正文乙')
})

// 守"修 bug 别引入丢字"：首帧就是 -1/content 时没有通道信息可用，当正文是唯一合理兜底。
test('sse: 首帧就是 -1/content 时不得丢字（F24 不回归）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ p: 'response/fragments/-1/content', v: '内容甲' }],
    [{ v: '内容乙' }], // 裸续段：sink 已被置为 'fragments' → 应当继续按正文发
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'text'), '内容甲内容乙')
})

test('sse: sink=content 时 -1/content 仍归正文（F24 不回归）', () => {
  const state = createSseState()
  const events = drain(state, [
    [{ p: 'response/content', v: '正文甲' }],
    [{ p: 'response/fragments/-1/content', v: '正文乙' }],
    [{ v: '正文丙' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'text'), '正文甲正文乙正文丙')
})

// ── F25：首帧快照丢失时，思考不得上屏（2026-09-14 用真实帧复现）──────────
// 抓包实测（4 轮同构）的真实形态：
//   快照(fragments=[{type:"THINK", content:…}]) → -1/content → 380× 裸续段
//   → fragments+1 [RESPONSE] → -1/content → 110× 裸续段 → BATCH/status
// 即：思考的归属**完全依赖首帧快照里的 THINK fragment**，之后全走 -1/content 与裸续段；
// `response/thinking_content` 一次都不出现。所以快照整帧丢失（或服务端先发
// `fragments: []` 的快照）时，旧实现会在「无 fragment 可续」的分支里无条件当正文发射
// → **整段思考上屏**。用真实帧删掉快照后回放：thinking=0 / text=818（思考 661 字全在里面）。
// 现在：开了思考却还没有 fragment 时先把文本暂存，等 fragment 出现再定归属。
test('sse: 首帧快照丢失时思考仍须归位（F25）', () => {
  const state = createSseState({ thinkingEnabled: true })
  // 自证：开了思考又没有 fragment 时，第一段必须进暂存、不得立刻发射
  assert.deepEqual(state.handle({ p: 'response/fragments/-1/content', v: '我们需要回答' }), [])
  assert.equal(state.stats().orphanLen, 6, '自证：文本确实进了暂存缓冲')
  const events = drain(state, [
    [{ v: '中文，约150字。' }],
    // 正文开始：服务端 APPEND 一个 RESPONSE fragment（真实帧的顺序就是这样）
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '两次不够：' } }],
    [{ p: 'response/fragments/-1/content', v: '服务器只能确认客户端能发。' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '我们需要回答中文，约150字。')
  assert.equal(textOf(events, 'text'), '两次不够：服务器只能确认客户端能发。')
  // 顺序断言：思考必须在**正文 fragment 出现的那一刻**就结算发射，而不是拖到流结束。
  // 少了这条，把结算点从 appendFragments 挪到 finish() 也能"通过内容断言" ——
  // 但 UI 上会变成「先出正文、最后才补思考」，方向就错了。
  const order = events.filter((e) => e.kind === 'thinking' || e.kind === 'text').map((e) => e.kind)
  assert.deepEqual(order, ['thinking', 'text', 'text'], '思考段必须在正文之前结算并发射')
})

test('sse: 整轮没有 fragment 时暂存文本按思考收尾（F25）', () => {
  const state = createSseState({ thinkingEnabled: true })
  const events = drain(state, [
    [{ p: 'response/fragments/-1/content', v: '思考甲' }],
    [{ v: '思考乙' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '思考甲思考乙', '结束前必须把暂存交出去，不能静默丢字')
  assert.equal(textOf(events, 'text'), '')
})

test('sse: 迟到快照也能把暂存文本认回思考（F25）', () => {
  const state = createSseState({ thinkingEnabled: true })
  const events = drain(state, [
    [{ p: 'response/fragments/-1/content', v: '思考甲' }], // 快照还没到
    [{ v: { response: { fragments: [{ type: 'THINK', content: '思考甲' }] } } }], // 快照迟到
    [{ p: 'response/fragments/-1/content', v: '思考乙' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '思考甲思考乙', '暂存段与快照对账不得重复')
  assert.equal(textOf(events, 'text'), '')
})

test('sse: 未开思考时不缓冲（F25 不回归）', () => {
  const state = createSseState({ thinkingEnabled: false })
  const events = drain(state, [
    [{ p: 'response/fragments/-1/content', v: '正文甲' }],
    [{ v: '正文乙' }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'text'), '正文甲正文乙', '没开思考就没有歧义，必须即时发射')
  assert.equal(textOf(events, 'thinking'), '')
})

test('sse: 快照正常时缓冲逻辑不介入（F25 不回归）', () => {
  const state = createSseState({ thinkingEnabled: true })
  const events = drain(state, [
    [{ v: { response: { fragments: [{ type: 'THINK', content: '思考甲' }] } } }],
    [{ p: 'response/fragments/-1/content', v: '思考乙' }],
    [{ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '正文' } }],
    [{ p: 'response/status', v: 'FINISHED' }],
  ])
  assert.equal(textOf(events, 'thinking'), '思考甲思考乙')
  assert.equal(textOf(events, 'text'), '正文')
  assert.equal(state.stats().orphanLen, undefined, '自证：正常路径下从未用过暂存')
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

// ── SSE 增量/快照对账（2026-09 事故回归）────────────────────────
// 现场：模型「找了一圈，结论是…」在 DSH 里只显示「了一圈」，并伴随 EMPTY_RESPONSE 重试。
// 根因：旧实现用只增不减的「已发射计数器」去重，而快照会把派生文本重置得更短 →
// 计数器保持高位，只在文本长度超过它时才吐字，于是前面全丢、只剩余数尾巴。
test('sse 回归: 缩水快照后继续增量，不得丢字', () => {
  const state = createSseState()
  const events = []
  events.push(...state.handle({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '抱歉，我把生态找' } }))
  // 一份「只含思考、丢掉正文」的缩水快照（现场就是这种）
  events.push(...state.handle({ v: { response: { fragments: [{ type: 'THINK', content: '让我想想' }] } } }))
  events.push(...state.handle({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '了一圈，结论是…' } }))
  events.push(...state.handle({ p: 'response/fragments/-1/content', v: '没有现成插件。' }))
  events.push(...state.finish())

  const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
  assert.equal(text, '抱歉，我把生态找了一圈，结论是…没有现成插件。', `实际=${JSON.stringify(text)}`)
  assert.ok(!/^了一圈/.test(text), '不得只吐出「了一圈」这类尾巴')
  assert.ok(state.stats().text.endsWith('没有现成插件。'))
})

test('sse 回归: 缩水快照不得造成假空回复（否则触发 EMPTY_RESPONSE 重试）', () => {
  const state = createSseState()
  const events = []
  events.push(...state.handle({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '完整回答' } }))
  events.push(...state.handle({ v: { response: { fragments: [] } } }))
  const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
  assert.equal(text, '完整回答', `实际=${JSON.stringify(text)}`)
  assert.equal(state.stats().text, '完整回答')
})

test('sse 回归: 快照严格延伸时只补差（不重复吐字）', () => {
  const state = createSseState()
  const events = []
  events.push(...state.handle({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '前半' } }))
  events.push(...state.handle({ v: { response: { fragments: [{ type: 'RESPONSE', content: '前半后半' }] } } }))
  const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
  assert.equal(text, '前半后半', `实际=${JSON.stringify(text)}`)
  const again = state.handle({ v: { response: { fragments: [{ type: 'RESPONSE', content: '前半后半' }] } } })
  assert.equal(again.filter((e) => e.kind === 'text').length, 0, '同样的快照不应重复发射')
  assert.equal(state.stats().divergences, 0)
})

test('sse 回归: 快照分歧（服务端回退/重排）被忽略而非吐乱码', () => {
  const state = createSseState()
  const events = []
  events.push(...state.handle({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'ABCDEF' } }))
  const divergent = state.handle({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'XYZ' }] } } })
  assert.equal(divergent.filter((e) => e.kind === 'text').length, 0, '分歧快照不应发射')
  assert.equal(state.stats().divergences, 1)
  assert.equal(state.stats().text, 'ABCDEF')
})

test('sse 回归: 直连格式在快照穿插下也不丢字', () => {
  const state = createSseState()
  const events = []
  events.push(...state.handle({ p: 'response/thinking_content', v: '推理A' }))
  events.push(...state.handle({ p: 'response/content', v: '正文1' }))
  events.push(...state.handle({ v: { response: { content: '正文1正文2' } } }))
  events.push(...state.handle({ o: 'APPEND', v: '正文3' }))
  const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
  const thinking = events.filter((e) => e.kind === 'thinking').map((e) => e.text).join('')
  assert.equal(text, '正文1正文2正文3', `实际=${JSON.stringify(text)}`)
  assert.equal(thinking, '推理A')
})

// ── 跨包标记 hold-back（2026-09 事故 #3：合法 JSON 也被泄漏）──────────────
// 现场（会话日志中的真实分块）：标记被切成 `{"tool` + `_calls":[{"name":"find_dsh` …
// 旧实现的 hold-back 前缀比较多拼了一个引号 → 半截标记被当正文吐出 → 后半个拼不回完整标记。
// 关键：前面的正文必须超过 hold-back 窗口（24 字符）才会暴露此 bug。
const LIVE_CHUNKS = [
  "I'll check what plugins exist",
  ' for this in the DSH ecosystem',
  ', and also look at the current',
  " GUI's capabilities.\n\n{\"tool",
  '_calls":[{"name":"find_dsh',
  '_plugin","arguments":{"query',
  '":"open file explorer folder',
  ' reveal in system file manager',
  '","limit":15,"lang":"zh"}}',
  ']}',
]

test('filter: 真实分块序列（长正文 + 拆成两半的标记）不得泄漏 JSON', () => {
  const filter = new ToolCallStreamFilter(new Set(['find_dsh_plugin']))
  let text = ''
  const calls = []
  for (const chunk of LIVE_CHUNKS) {
    const out = filter.push(chunk)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = filter.flush()
  text += tail.text
  calls.push(...tail.calls)
  assert.equal(calls.length, 1, `calls=${JSON.stringify(calls)} text=${JSON.stringify(text)}`)
  assert.equal(calls[0].name, 'find_dsh_plugin')
  assert.deepEqual(JSON.parse(calls[0].arguments), { query: 'open file explorer folder reveal in system file manager', limit: 15, lang: 'zh' })
  assert.ok(!text.includes('tool_calls'), `正文泄漏：${JSON.stringify(text)}`)
  assert.ok(text.includes("I'll check what plugins exist"), '正文应保留')
})

test('filter: 长正文 + 拆成两半的 XML 标记同样不得泄漏', () => {
  const filter = new ToolCallStreamFilter(new Set(['read']))
  const prefix = '先说明一下背景，这段正文要足够长以超过 hold-back 窗口，否则测不出问题。'.repeat(2)
  let text = ''
  const calls = []
  const chunks = [prefix + '\n<tool', '_calls><invoke name="read"><para', 'meter name="file_path">a.txt</parameter></invoke></tool_calls>']
  for (const chunk of chunks) {
    const out = filter.push(chunk)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = filter.flush()
  text += tail.text
  calls.push(...tail.calls)
  assert.equal(calls.length, 1, `calls=${JSON.stringify(calls)}`)
  assert.equal(calls[0].name, 'read')
  assert.ok(!/<tool|_calls/.test(text), `正文泄漏：${JSON.stringify(text.slice(-120))}`)
})

// ── 结构性修复（2026-09 事故 #4：模型漏写调用对象的闭合括号）──────────────
// 原文从会话日志 4c5e1e59 逐字节导出（deepseek-reasoner，一次批量 3 个 pwsh 调用）：
// 每个调用对象都少写了一个右花括号（只闭合了自己的 arguments）→ JSON.parse 报
// 「Expected double-quoted property name in JSON at position 519」→ 旧实现解析失败 →
// 整段 JSON 被当正文吐出 → Web GUI 又把命令里的美元变量当 KaTeX 行内公式渲染
// → 用户看到的是「一个字符一行 + 弯引号」的乱码。
const SAMPLE_LEAK_JSON = "{\"tool_calls\":[{\"name\":\"pwsh\",\"arguments\":{\"command\":\"$ErrorActionPreference='SilentlyContinue'; foreach($p in @(\\\"$env:APPDATA\\\\DSH Desktop\\\",\\\"$env:LOCALAPPDATA\\\\DSH Desktop\\\",\\\"$env:APPDATA\\\\dsh-desktop\\\",\\\"$env:APPDATA\\\\dsh\\\")){ if(Test-Path $p){ Write-Output \\\"### $p\\\"; Get-ChildItem $p -Recurse -File | Select-Object FullName,Length,LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 25 | Format-Table -AutoSize | Out-String -Width 200 } }\",\"description\":\"Locate DSH Desktop app logs\"},{\"name\":\"pwsh\",\"arguments\":{\"command\":\"Get-Content \\\"$env:USERPROFILE\\\\.dsh\\\\super-injector\\\\self-heal.log\\\" -Raw; Write-Output '--- super-injector dir ---'; Get-ChildItem \\\"$env:USERPROFILE\\\\.dsh\\\\super-injector\\\" -Recurse | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize | Out-String -Width 200\",\"description\":\"Read injector self-heal log and dir\"},{\"name\":\"pwsh\",\"arguments\":{\"command\":\"$ErrorActionPreference='Continue'; try { $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:43120/api/client-modules' -Headers @{Origin='http://127.0.0.1:43120'; Referer='http://127.0.0.1:43120/'} -TimeoutSec 10; Write-Output \\\"status=$($r.StatusCode) len=$($r.Content.Length)\\\" } catch { Write-Output \\\"ERR: $($_.Exception.Message)\\\" }; try { $r2=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:43120/' -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' -TimeoutSec 10; Write-Output \\\"root status=$($r2.StatusCode) len=$($r2.Content.Length)\\\" } catch { Write-Output \\\"root ERR: $($_.Exception.Message)\\\" }\",\"description\":\"Probe DSH webserver HTTP endpoints\"}]}"

test('structural: 真实泄漏样本（每个调用对象少一个 }）修复为 3 个调用', () => {
  assert.throws(() => JSON.parse(SAMPLE_LEAK_JSON), '前提：原文确实是非法的 JSON')
  const calls = parseToolCallJson(SAMPLE_LEAK_JSON)
  assert.ok(calls && calls.length === 3, 'calls=' + JSON.stringify(calls))
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'pwsh', 'pwsh'])
  const args = calls.map((c) => JSON.parse(c.arguments))
  assert.deepEqual(args.map((a) => a.description), [
    'Locate DSH Desktop app logs',
    'Read injector self-heal log and dir',
    'Probe DSH webserver HTTP endpoints',
  ])
  // 补括号不得改写内容：命令要逐字保留
  assert.ok(args[0].command.startsWith("$ErrorActionPreference='SilentlyContinue'; foreach($p in @("), args[0].command)
  assert.ok(args[1].command.includes('$env:USERPROFILE\\.dsh\\super-injector\\self-heal.log'), args[1].command)
  assert.ok(!args[1].command.includes('\r'), '路径里不应出现回车')
})

test('structural: 没有闭合方括号的调用（疑似被截断）绝不修补执行', () => {
  // 安全闸门：流被服务端 60s 上限截断时，补括号会造出一条被截断的命令并真的执行它
  const truncated = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Remove-Item F:\\\\Code'
  assert.equal(parseToolCallJson(truncated), null, '没有闭合方括号就不该修补')
})

test('filter: 真实泄漏样本 → 3 个调用、正文零泄漏、不触发 rejected', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  const out = filter.push(SAMPLE_LEAK_JSON)
  const tail = filter.flush()
  const calls = [...out.calls, ...tail.calls]
  const text = out.text + tail.text
  assert.equal(calls.length, 3, 'calls=' + calls.length + ' text=' + JSON.stringify(text.slice(0, 80)))
  assert.equal(text, '', '不得有任何正文泄漏：' + JSON.stringify(text.slice(0, 120)))
  assert.equal(tail.rejected, undefined)
})

test('filter: 修不好的协议块 → rejected（绝不吐成正文）', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  const broken = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"echo $env:US'
  const out = filter.push(broken)
  const tail = filter.flush()
  assert.equal(out.text + tail.text, '', '坏掉的协议块不得进入正文')
  assert.equal(out.calls.length + tail.calls.length, 0)
  assert.ok(tail.rejected, 'rejected 必须置位，供上层决定重试')
  assert.equal(tail.rejected.raw, broken, '原文要留给日志')
})


console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：` : '，全部通过 ✅'}`)
if (failures.length) {
  for (const failure of failures) console.log(failure)
  process.exitCode = 1
}
