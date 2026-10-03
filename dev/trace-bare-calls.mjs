// 逐步追踪：裸 <calls> 块到底是什么走向。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const raw = [
  '<calls>',
  '<invoke name="pwsh">',
  '<parameter name="command">Get-Date</parameter>',
  '</invoke>',
  '</calls>',
].join('\n')

console.log('=== 输入 ===')
console.log(raw)
console.log()

const f = new M.ToolCallStreamFilter(new Set(['pwsh']))
const o = f.push(raw)
console.log('push().text    =', JSON.stringify(o.text))
console.log('push().calls   =', o.calls.length, JSON.stringify(o.calls))
const t = f.flush()
console.log('flush().text   =', JSON.stringify(t.text))
console.log('flush().calls  =', t.calls.length, JSON.stringify(t.calls))
console.log('flush().rejected =', JSON.stringify(t.rejected))

console.log('\n=== 关键量 ===')
console.log('XML_STARTER_RE 认得 <calls> 吗 →', '（不可见，改测行为）')
console.log('stripStrayToolMarkup(整块) =', JSON.stringify(M.stripStrayToolMarkup(raw)))
console.log('parseXmlToolCalls(整块)   =', JSON.stringify(M.parseXmlToolCalls ? M.parseXmlToolCalls(raw) : '(未导出)'))
