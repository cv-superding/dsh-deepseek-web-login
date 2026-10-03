// 定案探针 v2：覆盖「前缀变体 × 配平程度」两个维度。
// 设计原则：判为泄漏时必须打印上屏原文，避免"只报结论看不到证据"（前面两次探针都栽在这）。
//   1) push() 返回值类型两条通道不同（字符串 / FilterOutput）—— 之前混用导致假泄漏。
//   2) 现场形态是 <｜｜DSML｜｜ calls>（DSML 后有空格），不是 <｜｜DSML｜｜>。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const PREFIXES = {
  '全角双竖线（★现场）': '｜｜DSML｜｜',
  '半角单竖线': '|DSML|',
  '半角双竖线': '||DSML||',
  'dsml- 无空格': '@dsml-@',
  'dsml- 带空格': '@dsml- @',
  '无前缀': '',
}
// @ 只是个占位，让"标签名"能拼在后面；真实前缀里不含 @
const realPrefix = (p) => p.replace(/@/g, '')

const SHAPES = {
  配平: (p) =>
    [
      `<${p} calls>`,
      `<${p} invoke name="pwsh">`,
      `<${p} parameter name="command">Get-Date</${p} parameter>`,
      `</${p} invoke>`,
      `</${p} calls>`,
    ].join('\n'),
  '缺 invoke 闭合': (p) =>
    [`<${p} calls>`, `<${p} invoke name="pwsh">`, `<${p} parameter name="command">Get-Date</${p} parameter>`, `</${p} calls>`].join('\n'),
  '流被截断（无任何闭合）': (p) =>
    [`<${p} calls>`, `<${p} invoke name="pwsh">`, `<${p} parameter name="command">Get-Date`].join('\n'),
  '只有包裹标签': (p) => [`<${p} calls>`, `</${p} calls>`].join('\n'),
}

const LEAK = /DSML|｜｜|\|\||<\|dsml|<\/?\s*(calls|invoke|parameter)\b/i

function run(mk, chunks) {
  const f = mk()
  let shown = ''
  let calls = 0
  let rejected = null
  const eat = (o) => {
    if (typeof o === 'string') {
      shown += o
      return
    }
    shown += o.text
    calls += o.calls.length
    if (o.rejected) rejected = o.rejected
  }
  for (const c of chunks) eat(f.push(c))
  eat(f.flush())
  return { shown, calls, rejected }
}

const leaks = []
console.log('前缀'.padEnd(20), '形态'.padEnd(20), '思考(整块/逐字/按行)   正文(整块/逐字/按行)')
console.log('─'.repeat(96))
for (const [pn, pRaw] of Object.entries(PREFIXES)) {
  const p = realPrefix(pRaw)
  for (const [sn, make] of Object.entries(SHAPES)) {
    const raw = make(p)
    const chunksOf = (raw) => {
      const lines = raw.split(/(?<=\n)/)
      return { 整块: [raw], 逐字: [...raw], 按行: lines }
    }
    const cells = []
    for (const [tag, mk] of [
      ['思考', () => new M.ReasoningSanitizer()],
      ['正文', () => new M.ToolCallStreamFilter(new Set(['pwsh']))],
    ]) {
      const c3 = chunksOf(raw)
      for (const [how, chunks] of Object.entries(c3)) {
        const r = run(mk, chunks)
        const bad = LEAK.test(r.shown)
        if (bad) leaks.push({ pn, sn, tag, how, head: raw.slice(0, raw.indexOf('>') + 1), shown: r.shown, calls: r.calls })
        cells.push(`${bad ? '🔴' : '✅'}${r.calls}`)
      }
      if (tag === '思考') cells.push('  ')
    }
    console.log(pn.padEnd(18), sn.padEnd(18), cells.join(''))
  }
}
console.log('─'.repeat(96))
console.log(leaks.length ? `🔴 ${leaks.length} 个组合泄漏，证据：` : '✅ 全部拦得住（' + Object.keys(PREFIXES).length * Object.keys(SHAPES).length * 6 + ' 个组合）')
for (const l of leaks.slice(0, 6)) {
  console.log(`\n  [${l.tag}/${l.how}] 前缀=${l.pn} 形态=${l.sn} 首标签=${l.head} 提取调用=${l.calls}`)
  console.log('  上屏: ' + JSON.stringify(l.shown.slice(0, 200)))
}
if (leaks.length > 6) console.log(`\n  …另有 ${leaks.length - 6} 个组合`)
