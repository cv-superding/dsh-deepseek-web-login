/**
 * 回归：导致「自动停止」的坏 JSON 形态必须能被救回来。
 *
 * 事故（2026-09-10 23:27:13，deepseek-web/deepseek-reasoner）：
 * 命令里带未转义双引号（PowerShell 常态）→ JSON.parse 报
 * `Expected ',' or '}' after property value` → 整条调用被丢弃 →
 * 那一轮没有工具调用 → agent loop 认为回合正常结束 → 用户看到「说半句就停了」。
 *
 * 另外钉住安全网：丢弃必须走可重试错误，不能静默结束（在 adapter 里，见 if (rejectedProtocol)）。
 *
 * 用法: node tests/check-badjson-recovery.mjs
 */
import assert from 'node:assert/strict'
import { ToolCallStreamFilter, parseToolCallJson } from '../src/protocol.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const NL = '\n'
const DQ = '"'
// 真实形态：命令里同时有未转义双引号与真实换行，路径是单反斜杠
const CMD_RAW = `$d='F:\\Code'\nSet-Location 'F:\\Code\\ceshi'\nGet-ChildItem ${DQ}$env:USERPROFILE\\.dsh${DQ} | Select-Object Name`

/** 把「模型原样吐出」的形态拼出来：引号不转义、换行是真的。 */
const rawPayload = (cmd, { closeOuter = true } = {}) =>
  `{"tool_calls":[{"name":"pwsh","arguments":{"command":"${cmd}","description":"check"}}]${closeOuter ? '}' : ''}`

function recoveredCommand(payload) {
  const calls = parseToolCallJson(payload)
  assert.ok(calls, '应解析出调用，实际 null（会被丢弃 → 静默停止）')
  return JSON.parse(calls[0].arguments).command
}

test('① 命令含未转义双引号 + 真实换行 → 能救回', () => {
  const cmd = recoveredCommand(rawPayload(CMD_RAW))
  assert.ok(cmd.includes('$env:USERPROFILE'), '命令内容应完整')
  assert.ok(cmd.includes('"$env:USERPROFILE\\.dsh"'), `内层引号应原样保留，实际: ${JSON.stringify(cmd)}`)
  assert.ok(cmd.includes('Select-Object Name'))
})

test('② 只有未转义双引号（无换行）→ 能救回', () => {
  const cmd = recoveredCommand(rawPayload(`Get-ChildItem ${DQ}$env:APPDATA\\.dsh${DQ} | Select-Object Name`))
  assert.ok(cmd.includes('"$env:APPDATA\\.dsh"'), `实际: ${JSON.stringify(cmd)}`)
})

test('③ 未转义双引号 + 缺最外层括号 → 能救回', () => {
  const cmd = recoveredCommand(rawPayload(CMD_RAW, { closeOuter: false }))
  assert.ok(cmd.includes('$env:USERPROFILE'))
})

test('④ 命令尾带反斜杠引号（合法转义）→ 不受影响', () => {
  const cmd = recoveredCommand(rawPayload(String.raw`Get-Content \"F:\logs\x.log\" -Tail 5`))
  assert.ok(cmd.includes('F:\\logs\\x.log'), `实际: ${JSON.stringify(cmd)}`)
})

test('⑤ 标准转义写法不被破坏（回归）', () => {
  const good = JSON.stringify({
    tool_calls: [{ name: 'pwsh', arguments: { command: 'Get-ChildItem "$env:APPDATA" | Select-Object Name' } }],
  })
  const cmd = recoveredCommand(good)
  assert.equal(cmd, 'Get-ChildItem "$env:APPDATA" | Select-Object Name')
})

test('⑥ 非调用形状的 JSON 仍返回 null（不误吞正文）', () => {
  assert.equal(parseToolCallJson('{"a":1,"b":"x"}'), null)
})

test('⑦ 流式：坏 JSON 也必须变成调用、正文零残留', () => {
  const payload = rawPayload(CMD_RAW)
  for (const chunk of [[payload], payload.match(/[\s\S]{1,7}/g) ?? [], [...payload]]) {
    const filter = new ToolCallStreamFilter(new Set(['pwsh']))
    let text = ''
    const calls = []
    for (const piece of chunk) {
      const out = filter.push(piece)
      text += out.text
      calls.push(...out.calls)
    }
    const tail = filter.flush()
    text += tail.text
    calls.push(...tail.calls)
    assert.equal(calls.length, 1, '应恰好解析出 1 个调用')
    assert.equal(text, '', `正文不应有残留，实际: ${JSON.stringify(text.slice(0, 160))}`)
    assert.equal(tail.rejected, undefined, '不该走丢弃路径')
  }
})

test('⑨ 命令内嵌 JSON（引号 + 冒号）不得误判', () => {
  // 引号后跟冒号只在「键的位置」才是结构符；值里必须当内容。
  // 第一版启发式在这里会误判 → 整条调用照样被丢弃。
  const cmd = recoveredCommand(rawPayload(`node -e ${DQ}const o={"a":1}; console.log(JSON.stringify(o))${DQ}`))
  assert.ok(cmd.includes('{"a":1}'), `内嵌 JSON 应原样保留，实际: ${JSON.stringify(cmd)}`)
  assert.ok(cmd.includes('JSON.stringify(o)'))
})

test('⑩ 嵌套引号极端用例：宁可拒绝，也绝不交出被改坏的命令', () => {
  // `node -e "console.log({"k":"v"})"` 里的 `"` 后跟 `}` 既可能是内容、也可能是字符串收尾，
  // 单字符前瞻在**原理上**分不开。此刻唯一安全的处置是拒绝（→ 上层重试），
  // 而不是用激进猜测凑出一个能解析、但命令已被改坏的结果去执行。
  const payload = rawPayload(`node -e ${DQ}console.log({"k":"v"})${DQ}`)
  const calls = parseToolCallJson(payload)
  if (calls) {
    // 若将来真能安全解析，则命令必须逐字还原
    const cmd = JSON.parse(calls[0].arguments).command
    assert.equal(cmd, `node -e "console.log({"k":"v"})"`, '解析出来就必须逐字正确，不许被改动')
  } else {
    // 拒绝也要保证：流式路径不能把它当正文吐出去
    const filter = new ToolCallStreamFilter(new Set(['pwsh']))
    const out = filter.push(payload)
    const tail = filter.flush()
    const text = out.text + tail.text
    assert.equal([...out.calls, ...tail.calls].length, 0)
    assert.equal(text, '', `拒绝时不许泄漏成正文，实际: ${JSON.stringify(text.slice(0, 160))}`)
    assert.ok(tail.rejected, '必须标记为 rejected，好让上层重试')
  }
})

test('⑪ PowerShell 哈希表字面量（单引号 + @{}）', () => {
  const cmd = recoveredCommand(
    rawPayload(`Invoke-WebRequest ('http://127.0.0.1:1/x') -Headers @{'User-Agent'='Mozilla/5.0'}`),
  )
  assert.ok(cmd.includes("@{'User-Agent'='Mozilla/5.0'}"), `实际: ${JSON.stringify(cmd)}`)
})

test('⑫ 大批量多行命令（模拟真实长命令）', () => {
  const long = `$d='F:\\Code\\DSH-Code\\create-browser-login\\dsh-deepseek-web-login'\nSet-Location 'F:\\Code\\DSH-Code\\ceshi'\nnode verify-real-leak.mjs 2>&1 | Select-Object -Last 1\nnode verify-protocol.mjs 2>&1 | Select-Object -Last 1\nWrite-Output ${DQ}done: $($?)${DQ}`
  const cmd = recoveredCommand(rawPayload(long))
  assert.ok(cmd.includes('verify-protocol.mjs'))
  assert.ok(cmd.includes('"done: $($?)"'), `实际: ${JSON.stringify(cmd.slice(-60))}`)
})

// ── 2026-09-11 真实事故：arguments 写成数组 + 闭合括号数错（原文逐字取自 rejected.jsonl）──
// 现场：模型发 \`{"tool_calls":[{"name":"pwsh","arguments":[{…}]}\` —— 少了收尾的 ]}
// 旧修复用 '}'.repeat(deficit) 盲补 '}'，但未闭合的其实是**数组** → 补出的候选仍是非法 JSON
// → 整个调用被丢弃（用户看到的正是「回复戛然而止、工具没执行」）。
const SAMPLE_ARGUMENTS_ARRAY = "{\"tool_calls\":[{\"name\":\"pwsh\",\"arguments\":[{\"command\":\"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $f='C:\\\\Users\\\\29436\\\\.dsh\\\\profiles\\\\desktop\\\\cordis.patch.yml'; Get-Content $f -Raw\",\"description\":\"读取 desktop profile 的 patch 文件全文\"}}]}"

test('真实事故：arguments 数组 + 少写闭合括号 → 修复并解包成真正参数', () => {
  assert.throws(() => JSON.parse(SAMPLE_ARGUMENTS_ARRAY), '前提：原文是非法 JSON（少写 ]}）')
  const calls = parseToolCallJson(SAMPLE_ARGUMENTS_ARRAY)
  assert.ok(calls && calls.length === 1, 'calls=' + JSON.stringify(calls))
  assert.equal(calls[0].name, 'pwsh')
  const args = JSON.parse(calls[0].arguments)
  assert.ok(args && typeof args === 'object' && !Array.isArray(args), 'arguments 必须解包成对象，不能是数组：' + calls[0].arguments)
  assert.ok(String(args.command).startsWith('[Console]::OutputEncoding'), args.command)
  assert.ok(String(args.command).includes('cordis.patch.yml'), args.command)
  assert.ok(String(args.description || '').length > 0, 'description 应保留')
})

test('arguments 写成数组（闭合完整）也要解包成对象', () => {
  const payload = '{"tool_calls":[{"name":"read","arguments":[{"file_path":"a.txt"}]}]}'
  const calls = parseToolCallJson(payload)
  assert.ok(calls && calls.length === 1, JSON.stringify(calls))
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a.txt' })
})

test('对照：合法调用不受解包逻辑影响', () => {
  const calls = parseToolCallJson('{"tool_calls":[{"name":"x","arguments":{"a":1}}]}')
  assert.deepEqual(JSON.parse(calls[0].arguments), { a: 1 })
})


console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
