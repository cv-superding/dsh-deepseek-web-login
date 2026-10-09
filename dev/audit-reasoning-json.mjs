// 针对性审查：0.6.38 之后，**思考通道**里模型自己写 "tool_calls" 字面时，
// 我的净化器会不会把正常推理内容吞掉？
// 真机证据：reasoning 块里有 10 处含 tool_calls 字面（模型在复盘自己的调用）。
const M = await import('../src/protocol.ts')

// 从真机取一条含 tool_calls 的 reasoning 原文（用户提供过类似场景，这里用已知形态）
const REAL_REASONING = [
  'The tool call got mangled again (I probably wrote the JSON wrong the first time).',
  'Let me retry with a simpler structure: {"tool_calls":[{"name":"read","arguments":{...}}]}',
  'Actually I should NOT include the trailing brace twice.',
].join('\n')

console.log('=== 输入（模型复盘自己调用的 reasoning）===')
console.log(REAL_REASONING)
console.log()

for (const [label, mk] of [
  ['思考通道 ReasoningSanitizer', () => new M.ReasoningSanitizer()],
  ['正文通道 ToolCallStreamFilter', () => new M.ToolCallStreamFilter(new Set(['read']))],
]) {
  for (const [how, chunks] of [
    ['整块', [REAL_REASONING]],
    ['逐字符', [...REAL_REASONING]],
  ]) {
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
    for (const c of chunks) eat(f.push(c))
    eat(f.flush())
    const kept = shown.length
    const ratio = (kept / REAL_REASONING.length) * 100
    // 期望：这段 reasoning 全部保留（它是模型的思考，不是要执行的调用）
    const verdict = kept === REAL_REASONING.length ? '✅ 完整保留' : kept === 0 ? '🔴 全吞' : `⚠️ 部分吞（剩 ${ratio.toFixed(0)}%）`
    console.log(`${label.padEnd(30)} ${how.padEnd(4)} ${verdict.padEnd(20)} 调用=${calls}`)
    if (kept !== REAL_REASONING.length) console.log('  剩: ' + JSON.stringify(shown.slice(0, 200)))
  }
}

console.log('\n=== 关键判据：模型写的是"复盘里的 JSON 文字"，还是"真的要执行的调用"？===')
console.log('两者在**字节上无法区分** —— 所以我只能问：这条规则是"宁可漏也不误吞"还是反过来？')
console.log('当前行为：思考通道全吞（上面第一行若为 🔴 全吞，说明我选了"宁可吞"）。')
