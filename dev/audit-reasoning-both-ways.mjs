// 改 `onlyStandaloneCalls` 之后必须**双向**验证：
//   正向：句中复盘的 JSON 不许被吞（已验）
//   🔴 反向：真正要执行的调用（独立成段）**必须仍被拦住**，否则标记会漏到网页端 ——
//   那正是 0.6.28 建立这道网要防的事，不能为了"别误吞"把它拆了。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const CALL = '{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}'
const MARKUP = /```|tool_calls|DSML|<\/?\s*(calls|invoke|parameter)/i

const CASES = [
  { name: '独立成段（前面是换行）', raw: '我先看看文件。\n\n' + CALL, wantStrip: true },
  { name: '独立成段（整条消息只有它）', raw: CALL, wantStrip: true },
  { name: '围栏包裹的独立成段', raw: '看看文件。\n\n```dsh-tool\n' + CALL + '\n```', wantStrip: true },
  { name: 'DSML 独立成段', raw: '先读。\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n</｜｜DSML｜｜ calls>', wantStrip: true },
  { name: '★句中复盘（不该吞）', raw: 'The call got mangled; retry with ' + CALL + ' instead', wantStrip: false },
  { name: '★句中带占位符（不该吞）', raw: 'I wrote {"tool_calls":[{"name":"read","arguments":{...}}]} by mistake', wantStrip: false },
]

console.log('=== 思考通道：stripped 标记（true = 剥掉了标记）===')
let ok = true
for (const c of CASES) {
  for (const [how, chunks] of [
    ['整块', [c.raw]],
    ['逐字符', [...c.raw]],
  ]) {
    const f = new M.ReasoningSanitizer()
    let shown = ''
    for (const ch of chunks) shown += f.push(ch)
    shown += f.flush()
    const stripped = f.stripped
    const hasMarkup = MARKUP.test(shown)
    // 期望：要么剥掉了标记（stripped 且无残留），要么完整保留（!stripped 且有标记）
    const pass = c.wantStrip ? !hasMarkup : !stripped && hasMarkup
    if (!pass) ok = false
    const verdict = c.wantStrip ? (hasMarkup ? '🔴 标记还在' : '✅ 已剥') : stripped ? '🔴 被误吞' : '✅ 保留'
    console.log(`${pass ? '  ' : '  ← '}${verdict.padEnd(12)} ${c.name}（${how}）`)
    if (!pass) console.log('      剩: ' + JSON.stringify(shown.slice(0, 120)))
  }
}

console.log('\n=== 对照：正文通道（句中复盘也吞 —— 那里"宁可多吞"是对的）===')
for (const c of CASES.filter((x) => !x.wantStrip)) {
  const f = new M.ToolCallStreamFilter(new Set(['read']))
  let shown = ''
  for (const ch of [...c.raw]) {
    const o = f.push(ch)
    shown += o.text
  }
  shown += f.flush().text
  console.log(`  ${MARKUP.test(shown) ? '✅ 保留' : '已剥'}  ${c.name}`)
}

console.log('\n' + (ok ? '✅ 全部符合预期' : '🔴 有不符合预期的项'))
process.exit(ok ? 0 : 1)
