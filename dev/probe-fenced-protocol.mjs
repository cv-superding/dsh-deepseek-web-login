// 决定性实验：把「裸 JSON」改成「围栏包裹的 JSON」，解析器能不能照样提取出调用？
// 关键：FENCE_HEAD_RE / FENCE_TAIL_RE 已存在 ⇒ 解析器本来就剥围栏。
// 这一步只验证"改动是否可行"，不改正文。
const M = await import('file:///F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts')

const fenced = [
  '我先查一下当前时间。',
  '',
  '```dsh-tool',
  '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-Date","description":"now"}}]}',
  '```',
].join('\n')

const bare = ['我先查一下当前时间。', '', '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-Date","description":"now"}}]}'].join('\n')

// 模型有时会在围栏前后多说两句 —— 一并测，模拟"不听话"的现实
const messy = [
  '先查时间。',
  '```dsh-tool',
  '{"tool_calls":[{"name":"pwsh","arguments":{"command":"Get-Date","description":"now"}}]}',
  '```',
  '调用完成后我会告诉你结果。',
].join('\n')

function probe(label, raw, whole = true) {
  const f = new M.ToolCallStreamFilter(new Set(['pwsh']))
  let shown = ''
  let calls = []
  let rejected = null
  const eat = (o) => {
    shown += o.text
    calls.push(...o.calls)
    if (o.rejected) rejected = o.rejected
  }
  const chunks = whole ? [raw] : [...raw]
  for (const c of chunks) eat(f.push(c))
  const t = f.flush()
  shown += t.text
  calls.push(...t.calls)
  if (t.rejected) rejected = t.rejected
  const leak = /tool_calls|dsh-tool/.test(shown)
  console.log(`\n=== ${label}（${whole ? '整块' : '逐字符'}）===`)
  console.log(`  提取调用: ${calls.length} ${calls.map((c) => c.name).join(',')}`)
  console.log(`  rejected: ${rejected ? rejected.reason : '无'}`)
  console.log(`  上屏: ${leak ? '🔴 有残留' : '✅ 干净'}  ${JSON.stringify(shown.slice(0, 120))}`)
  return { calls: calls.length, leak }
}

console.log('════ 基线：裸 JSON（现状）════')
probe('裸 JSON', bare)
probe('裸 JSON', bare, false)

console.log('\n════ 提案：围栏包裹 ════')
probe('围栏 dsh-tool', fenced)
probe('围栏 dsh-tool', fenced, false)
probe('围栏 + 后续废话', messy)
probe('围栏 + 后续废话', messy, false)

console.log('\n════ 对照：DSML 块在围栏方案下会怎样 ════')
probe('围栏里放 DSML（模型跑偏）', '```dsh-tool\n<｜｜DSML｜｜ calls>\n</｜｜DSML｜｜ calls>\n```')
