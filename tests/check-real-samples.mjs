// 用真实代码路径复核「用户实测泄漏样本」现在是否能解析成工具调用
import { parseToolCallJson, ToolCallStreamFilter } from '../src/protocol.ts'

// 样本 1：env 变量 + app.asar 结尾反斜杠（\" 是合法转义 → 字符串不终止）
const sample1 = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem env: | Where-Object { $_.Name -match \'DSH|API\' }","description":"List env vars"}},{"name":"grep","arguments":{"pattern":"baseURL|describe-image","path":"D:\\apps\\harness\\DSH Desktop\\resources\\app.asar\\","include":"*.json"}}]}'
// 样本 2：命令里含 \resources（\r 合法 → 只补非法转义会把路径变成回车）
const sample2 = '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem \'D:\\apps\\harness\\DSH Desktop\\resources\\app.asar\' | Select-Object Name, Length, Mode","description":"List app.asar checkout contents"}}]}'

for (const [label, sample] of [['样本1', sample1], ['样本2', sample2]]) {
  let rawFails = false
  try { JSON.parse(sample) } catch { rawFails = true }
  const calls = parseToolCallJson(sample)
  console.log(`${label}（原样 JSON.parse 失败=${rawFails}）→ 解析出 ${calls ? calls.length : 0} 个工具调用`)
  if (calls) for (const call of calls) console.log(`   ${call.name}: ${call.arguments.slice(0, 170)}`)
}

// 流式过滤器：确保不再把标记当正文吐给用户
for (const [label, sample] of [['样本1', sample1], ['样本2', sample2]]) {
  const filter = new ToolCallStreamFilter(new Set(['pwsh', 'grep']))
  const out = filter.push(sample.slice(0, 40))
  const out2 = filter.push(sample.slice(40))
  const tail = filter.flush()
  const text = out.text + out2.text + tail.text
  const calls = [...out.calls, ...out2.calls, ...tail.calls]
  console.log(`${label} 流式：调用=${calls.length}，正文泄漏=${text.includes('tool_calls')}`)
}

// 路径逐字还原（不得出现回车）
const command = JSON.parse(parseToolCallJson(sample2)[0].arguments).command
console.log('路径逐字还原:', command.includes('D:\\apps\\harness\\DSH Desktop\\resources\\app.asar'), '无回车:', !command.includes('\r'))
