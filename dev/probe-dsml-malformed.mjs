// 探针：畸形/截断的 DSML 变体能不能从过滤器漏出去。
// 已验证：完整配平的块（整块/逐字符/按行 × 正文/思考 共 6 种）全部拦得住。
// 这里只测**不配平**的形态 —— 那是 flush() 里"降级但可见"那条路。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const BAR = '｜｜' // 全角双竖线（分享页现场就是这个）
const CASES = {
  '完整配平（对照，应拦）': `${BAR}DSML${BAR} calls>\n${BAR}DSML${BAR} invoke name="pwsh">\n${BAR}DSML${BAR} parameter name="command" string="true">Get-Date</${BAR}DSML${BAR} parameter>\n</${BAR}DSML${BAR} invoke>\n</${BAR}DSML${BAR} calls>`,
  '缺 invoke 闭合': `${BAR}DSML${BAR} calls>\n${BAR}DSML${BAR} invoke name="pwsh">\n${BAR}DSML${BAR} parameter name="command">Get-Date</${BAR}DSML${BAR} parameter>\n</${BAR}DSML${BAR} calls>`,
  '缺 calls 闭合（流被截断）': `${BAR}DSML${BAR} calls>\n${BAR}DSML${BAR} invoke name="pwsh">\n${BAR}DSML${BAR} parameter name="command">Get-Date</${BAR}DSML${BAR} parameter>`,
  '只有包裹标签（无 invoke）': `${BAR}DSML${BAR} calls>\n${BAR}DSML${BAR} calls>`,
  'parameter 用了单竖线': `<|DSML| calls>\n<|DSML| invoke name="pwsh">\n<|DSML| parameter name="command">Get-Date</|DSML| parameter>\n</|DSML| invoke>\n</|DSML| calls>`,
  '半角竖线': `<|DSML|calls>\n<|DSML|invoke name="pwsh">\n<|DSML|parameter name="command">Get-Date</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|calls>`,
  'dsml- 连字符变体': `<dsml-calls>\n<dsml-invoke name="pwsh">\n<dsml-parameter name="command">Get-Date</dsml-parameter>\n</dsml-invoke>\n</dsml-calls>`,
  '无前缀裸标签': `<calls>\n<invoke name="pwsh">\n<parameter name="command">Get-Date</parameter>\n</invoke>\n</calls>`,
}

function probe(make, raw, whole) {
  const f = make()
  let text = ''
  const calls = []
  let rejected = null
  const chunks = whole ? [raw] : [...raw]
  for (const c of chunks) {
    const out = f.push(c)
    if (typeof out === 'string') {
      text += out
      continue
    }
    text += out.text
    calls.push(...out.calls)
    if (out.rejected) rejected = out.rejected
  }
  const t = f.flush()
  text += typeof t === 'string' ? t : t.text
  if (typeof t !== 'string') {
    calls.push(...t.calls)
    if (t.rejected) rejected = t.rejected
  }
  return { text, calls, rejected }
}

function leaks(text) {
  // 上屏文本里是否还留着**任何**工具调用标记的痕迹
  return /DSML|｜｜|<\|dsml/i.test(text) || /<\/?(calls|invoke|parameter)\b/i.test(text)
}

console.log('形态'.padEnd(26), '整块: 思考  正文 | 逐字符: 思考  正文')
console.log('─'.repeat(78))
let bad = 0
for (const [name, raw] of Object.entries(CASES)) {
  const cells = []
  for (const whole of [true, false]) {
    for (const mk of [() => new M.ReasoningSanitizer(), () => new M.ToolCallStreamFilter(new Set(['pwsh']))]) {
      const r = probe(mk, raw, whole)
      const l = leaks(r.text)
      if (l) bad++
      cells.push((l ? '🔴漏' : '✅净') + '(' + r.calls.length + ')')
    }
  }
  console.log(name.padEnd(24), cells.join('  '))
}
console.log('─'.repeat(78))
console.log(bad === 0 ? '全部拦得住' : `🔴 ${bad} 个组合泄漏`)
