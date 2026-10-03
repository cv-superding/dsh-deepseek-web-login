// 用用户截图里的**一字未改**原文实测两条通道。
// 截图里那段在「已思考」块中 ⇒ 走思考通道；工具确实执行了 ⇒ 同一段既被执行又泄漏。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

// ↓↓↓ 截图原文（把换行保留：网页端按行宽折行显示，实际 SSE 里是一整行）
const RAW =
  '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-Date -Format \'yyyy-MM-dd HH:mm:ss zzz\'; (Get-Date).ToUniversalTime().ToString(\'yyyy-MM-dd HH:mm:ss\')+\' UTC\'","description":"Read current system time"}}]}'

console.log('=== 输入（截图原文）===')
console.log(RAW)
console.log('长度:', RAW.length)
console.log()

function run(label, mk) {
  const f = mk()
  let shown = ''
  let calls = 0
  const eat = (o) => {
    if (typeof o === 'string') {
      shown += o
      return
    }
    shown += o.text
    calls += o.calls.length
  }
  // 整块
  eat(f.push(RAW))
  eat(f.flush())
  const leak = /tool_calls|"name"|"arguments"|pwsh/.test(shown)
  console.log(`${label.padEnd(34)} ${leak ? '🔴 泄漏' : '✅ 干净'}  提取调用=${calls}`)
  if (leak) console.log('   上屏: ' + JSON.stringify(shown.slice(0, 200)))
  return { leak, calls, shown }
}

console.log('=== 整块 ===')
run('思考通道 ReasoningSanitizer', () => new M.ReasoningSanitizer())
run('正文通道 ToolCallStreamFilter', () => new M.ToolCallStreamFilter(new Set(['pwsh'])))

console.log('\n=== 逐字符（真实 SSE 分块）===')
function runChunks(label, mk) {
  const f = mk()
  let shown = ''
  let calls = 0
  const eat = (o) => {
    if (typeof o === 'string') {
      shown += o
      return
    }
    shown += o.text
    calls += o.calls.length
  }
  for (const ch of RAW) eat(f.push(ch))
  eat(f.flush())
  const leak = /tool_calls|"name"|"arguments"|pwsh/.test(shown)
  console.log(`${label.padEnd(34)} ${leak ? '🔴 泄漏' : '✅ 干净'}  提取调用=${calls}`)
  if (leak) console.log('   上屏: ' + JSON.stringify(shown.slice(0, 200)))
  return { leak, calls, shown }
}
runChunks('思考通道 ReasoningSanitizer', () => new M.ReasoningSanitizer())
runChunks('正文通道 ToolCallStreamFilter', () => new M.ToolCallStreamFilter(new Set(['pwsh'])))

console.log('\n=== 关键量 ===')
console.log('MARKER_RE 认得吗 →', /\{\s*"tool_calls?"\s*:/.test(RAW) ? '✅ 认得' : '❌ 认不得')
