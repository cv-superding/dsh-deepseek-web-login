// 用分享页里那段**一字未改**的 DSML 喂进过滤器，看它从哪条路漏出去。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const LEAK =
  '用户问现在几点了。我需要执行命令获取当前时间。这是简单的单步任务，直接执行即可。\n' +
  '\n' +
  '<｜｜DSML｜｜ calls>\n' +
  '<｜｜DSML｜｜ invoke name="pwsh">\n' +
  '<｜｜DSML｜｜ parameter name="command" string="true">Get-Date -Format "yyyy-MM-dd HH:mm:ss dddd"</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="description" string="true">Get current local date and time</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>\n' +
  '</｜｜DSML｜｜ calls>\n'

function run(label, make, chunks, raw = false) {
  const f = make()
  let text = ''
  const calls = []
  let rejected = null
  for (const c of chunks) {
    // ReasoningSanitizer.push 返回**字符串**；ToolCallStreamFilter.push 返回 FilterOutput
    const out = f.push(c)
    if (raw) {
      text += out
      continue
    }
    text += out.text
    calls.push(...out.calls)
    if (out.rejected) rejected = out.rejected
  }
  const tail = f.flush()
  text += raw ? tail : tail.text
  if (!raw) {
    calls.push(...tail.calls)
    if (tail.rejected) rejected = tail.rejected
  }
  const leaked = /DSML|<｜｜|parameter name=/.test(text)
  console.log(`\n=== ${label} ===`)
  console.log(`  分块方式: ${chunks.length} 块 (${chunks.map((c) => c.length).join('/')})`)
  console.log(`  提取到调用: ${calls.length}  ${calls.map((c) => c.name).join(',')}`)
  console.log(`  rejected: ${rejected ? rejected.reason : '无'}`)
  console.log(`  ★ 上屏文本里还有 DSML 吗: ${leaked ? '🔴 有（泄漏）' : '✅ 没有'}`)
  if (leaked) {
    const i = Math.max(text.search(/DSML｜｜ calls/) >= 0 ? 0 : 0, text.search(/</))
    console.log('  --- 上屏文本 ---')
    console.log(
      text
        .split('\n')
        .map((l) => '    | ' + l.slice(0, 90))
        .join('\n'),
    )
  } else {
    console.log('  上屏文本: ' + JSON.stringify(text.slice(0, 120)))
  }
  return leaked
}

const TOOLS = new Set(['pwsh'])
const whole = [LEAK]
// 逐字符（最常见的真实分块形态之一）
const perChar = [...LEAK]
// 按行
const perLine = LEAK.split(/(?<=\n)/)

const a = run('正文通道 ToolCallStreamFilter / 整块', () => new M.ToolCallStreamFilter(TOOLS), whole)
const b = run('正文通道 ToolCallStreamFilter / 逐字符', () => new M.ToolCallStreamFilter(TOOLS), perChar)
const c = run('正文通道 ToolCallStreamFilter / 按行', () => new M.ToolCallStreamFilter(TOOLS), perLine)
const d = run('思考通道 ReasoningSanitizer / 整块', () => new M.ReasoningSanitizer(), whole, true)
const e = run('思考通道 ReasoningSanitizer / 逐字符', () => new M.ReasoningSanitizer(), perChar, true)
const f = run('思考通道 ReasoningSanitizer / 按行', () => new M.ReasoningSanitizer(), perLine, true)

console.log('\n================ 汇总 ================')
console.log('泄漏的组合:', [a, b, c, d, e, f].map((x, i) => `${'abcdef'[i]}=${x ? '漏' : '净'}`).join('  '))
