/**
 * 线上验证：复现 2026-09 事故 #4 的触发条件 —— 一次批量 3 个 pwsh 调用，命令里带
 * `$env:` 变量与 Windows 路径（真实事故里模型正是这样漏写了调用对象的闭合括号）。
 *
 * 关心三件事：
 *   1) 真实模型在深度思考下是否还会漏写括号；
 *   2) 若漏写，结构性修复是否接住（producedCalls > 0）且**正文零泄漏**；
 *   3) 修复不了时是否走 rejected（而不是把 JSON 吐成正文）。
 *
 * 用法：node tests/probe-batch-live.mjs [model]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serializePrompt, ToolCallStreamFilter } from '../src/protocol.ts'
import { streamWebCompletion } from '../src/webapi.ts'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const auth = JSON.parse(readFileSync(join(home, 'web-login', 'deepseek-auth.json'), 'utf8'))
const model = process.argv[2] || 'deepseek-reasoner'

const tools = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] },
  },
]

const prompt = serializePrompt({
  system: 'You are a DSH coding assistant.',
  tools,
  messages: [
    {
      id: 'b1',
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '请用 pwsh 工具**一次性**并行执行三条命令（必须放进同一个 tool_calls 数组，每条都要 command 和 description）：',
          '1. 用 $ErrorActionPreference=\'SilentlyContinue\' 遍历 @("$env:APPDATA\\DSH Desktop","$env:LOCALAPPDATA\\DSH Desktop") 列出最近 25 个文件；',
          '2. 读取 "$env:USERPROFILE\\.dsh\\super-injector\\self-heal.log" 的尾部；',
          '3. 用 Invoke-WebRequest 探测 http://127.0.0.1:43120/api/modules 并输出状态码。',
          '只输出 tool_calls JSON，不要任何解释文字。',
        ].join('\n'),
      }],
      source: { kind: 'user' },
    },
  ],
})

const filter = new ToolCallStreamFilter(new Set(tools.map((t) => t.name)))
const calls = []
let text = ''
let reasoningChars = 0
let rawTail = ''
let finish = null
let rejected = null

for await (const event of streamWebCompletion(auth, { prompt, thinkingEnabled: true, modelType: 'default', idleTimeoutMs: 120_000 })) {
  if (event.kind === 'text') {
    rawTail = (rawTail + event.text).slice(-600)
    const out = filter.push(event.text)
    text += out.text
    calls.push(...out.calls)
  } else if (event.kind === 'thinking') {
    reasoningChars += event.text.length
  } else if (event.kind === 'finish') {
    finish = event.reason
  } else if (event.kind === 'error') {
    console.log('ERROR:', event.message)
  }
}
const tail = filter.flush()
text += tail.text
calls.push(...tail.calls)
if (tail.rejected) rejected = { mode: tail.rejected.mode, chars: tail.rejected.raw.length }

const braces = (rawTail.match(/\{/g) ?? []).length
const closes = (rawTail.match(/\}/g) ?? []).length
console.log(JSON.stringify({
  model,
  finish,
  reasoningChars,
  producedCalls: calls.length,
  calls: calls.map((c) => {
    const args = JSON.parse(c.arguments)
    return { name: c.name, commandHead: String(args.command ?? '').slice(0, 80), commandChars: String(args.command ?? '').length, description: args.description }
  }),
  leakedIntoText: /"tool_calls"|\$env:|Invoke-WebRequest/.test(text),
  rejected,
  visibleText: text.slice(0, 200),
  rawTailBraceDiff: braces - closes, // 原始流里未闭合的花括号差值（0 表示模型写全了）
  rawModelTail: rawTail.slice(-200),
}, null, 2))
