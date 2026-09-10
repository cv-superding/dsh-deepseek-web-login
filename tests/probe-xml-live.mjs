/**
 * 线上验证：XML 风格工具调用是否被流式过滤器正确接住（用户实测漂移场景）。
 *
 * 现实里模型是「偶发」改用 XML 标记，难以稳定复现；这里通过指令显式要求它用 XML
 * 标记，从而在真实流式输出上验证解析器（跨包、真实分片、真实模型分词）。
 *
 * 用法：node tests/probe-xml-live.mjs [model]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serializePrompt, ToolCallStreamFilter } from '../src/protocol.ts'
import { streamWebCompletion } from '../src/webapi.ts'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const auth = JSON.parse(readFileSync(join(home, 'web-login', 'deepseek-auth.json'), 'utf8'))
const model = process.argv[2] || 'deepseek-chat'

const tools = [
  { name: 'read', description: 'Read a file from disk.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'pwsh', description: 'Run a PowerShell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
]

// 故意引导模型使用 XML 标记（模拟漂移），从而验证解析器而非指令遵从
const prompt = serializePrompt({
  system: 'You are a DSH coding assistant.',
  tools,
  messages: [
    {
      id: 'x1',
      role: 'user',
      content: [{
        type: 'text',
        text: '请用下面这种 XML 标记格式调用工具（不要用 JSON），读取 C:\\Users\\me\\.dsh\\settings.yaml：\n<tool_calls>\n<invoke name="read">\n<parameter name="file_path">路径</parameter>\n</invoke>\n</tool_calls>\n只输出这段标记，不要输出别的解释。',
      }],
      source: { kind: 'user' },
    },
  ],
})

const filter = new ToolCallStreamFilter(new Set(tools.map((t) => t.name)))
const calls = []
let text = ''
let reasoning = ''
let rawTail = ''
let finish = null

for await (const event of streamWebCompletion(auth, { prompt, thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 120_000 })) {
  if (event.kind === 'text') {
    rawTail = (rawTail + event.text).slice(-400)
    const out = filter.push(event.text)
    text += out.text
    calls.push(...out.calls)
  } else if (event.kind === 'thinking') {
    reasoning += event.text
  } else if (event.kind === 'finish') {
    finish = event.reason
  } else if (event.kind === 'error') {
    console.log('ERROR:', event.message)
  }
}
const tail = filter.flush()
text += tail.text
calls.push(...tail.calls)

const leaked = /<tool_calls|<invoke\s+name=|<parameter\s+name=/i.test(text)
console.log(JSON.stringify({
  model,
  finish,
  producedCalls: calls.length,
  calls: calls.map((c) => ({ name: c.name, args: c.arguments })),
  leakedMarkupIntoText: leaked,
  visibleText: text.slice(0, 300),
  rawModelTail: rawTail.slice(-260),
}, null, 2))
