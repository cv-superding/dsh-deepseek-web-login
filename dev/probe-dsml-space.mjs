// 定案探针：只用分享页的**现场形态**（<｜｜DSML｜｜ calls>，DSML 后有空格），
// 遍历前缀变体；一旦判为泄漏就把上屏内容原样打出来，避免"只报结论不看证据"。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const P = (prefix) => [
  `<${prefix} calls>`,
  `<${prefix} invoke name="pwsh">`,
  `<${prefix} parameter name="command">Get-Date</${prefix} parameter>`,
  `</${prefix} invoke>`,
  `</${prefix} calls>`,
].join('\n')

const PREFIXES = {
  '★现场：全角双竖线+空格': '｜｜DSML｜｜',
  '全角双竖线（无空格）': '｜｜DSML｜｜'.replace('｜｜ calls', '｜｜calls'),
  '半角单竖线': '|DSML|',
  '半角双竖线': '||DSML||',
  'dsml- 连字符': 'dsml-',
  '无前缀裸标签': '',
}

// 上屏文本里是否还留着标记痕迹（只看 DSML/竖线/三类标签，足够灵敏）
const LEAK = /DSML|｜｜|\|\||<|dsml/i

function probeText(f, raw) {
  let shown = ''
  let calls = 0
  const o = f.push(raw)
  if (typeof o === 'string') shown += o
  else {
    shown += o.text
    calls += o.calls.length
  }
  const t = f.flush()
  if (typeof t === 'string') shown += t
  else {
    shown += t.text
    calls += t.calls.length
  }
  return { shown, calls }
}

console.log('形态'.padEnd(24), '思考通道          正文通道')
console.log('─'.repeat(70))
const leaks = []
for (const [name, p] of Object.entries(PREFIXES)) {
  const raw = P(p)
  const head = raw.slice(0, raw.indexOf('>') + 1)
  const cells = []
  for (const [tag, mk] of [
    ['思考', () => new M.ReasoningSanitizer()],
    ['正文', () => new M.ToolCallStreamFilter(new Set(['pwsh']))],
  ]) {
    const r = probeText(mk(), raw)
    const bad = LEAK.test(r.shown)
    if (bad) leaks.push({ name, tag, head, shown: r.shown })
    cells.push(`${bad ? '🔴漏' : '✅净'}/调用${r.calls}`)
  }
  console.log(name.padEnd(22), head.padEnd(20), cells.join('   '))
}
console.log('─'.repeat(70))
if (!leaks.length) {
  console.log('结论：全部拦得住 —— 净化器没有泄漏路径')
} else {
  console.log(`🔴 ${leaks.length} 个组合泄漏，证据：`)
  for (const l of leaks) {
    console.log(`\n  [${l.tag}] ${l.name}  首标签 ${l.head}`)
    console.log('  上屏内容: ' + JSON.stringify(l.shown.slice(0, 220)))
  }
}
