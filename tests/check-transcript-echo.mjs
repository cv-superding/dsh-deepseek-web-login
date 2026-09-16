/**
 * 回归：模型把「对话转写格式」当回答吐出来时必须被拦下。
 *
 * 事故（2026-09-10，deepseek-web/deepseek-reasoner，重启后仍出现）：
 * 可见正文里出现 `[Tool Result for call_xxx]` + 真实工具输出 + `[status: running]`，
 * 以及成串的 `User: …` / `Assistant: …`。根因是 serializePrompt 把这些标记写进了 prompt，
 * 模型照着模仿——与「工具调用标记泄漏」是两个独立来源。
 *
 * 用法: node tests/check-transcript-echo.mjs
 */
import assert from 'node:assert/strict'
import { TranscriptEchoGuard } from '../src/protocol.ts'

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

/** 按分块喂进去，返回上屏文本与「是否命中回声」。 */
function run(chunks) {
  const guard = new TranscriptEchoGuard()
  let text = ''
  let echoed = false
  for (const c of chunks) {
    const out = guard.push(c)
    text += out.text
    echoed = echoed || out.echoed
  }
  const tail = guard.flush()
  text += tail.text
  echoed = echoed || tail.echoed
  return { text, echoed }
}

const TR = '[Tool Result for '
const ST = '[status: '
const BR = ']'

// ① 真实事故形态：正文 + 回声段
const realCase =
  '重启+切模型收到。让我确认新代码是否真的进了内存。\n\n' +
  `${TR}call_00_pFhXQe3Vsg3N4aEfEf1D3527${BR}\n` +
  '启动次数=8  总行=1191\n' +
  '=== 最近一次启动之后的行 ===\n\n' +
  `${TR}call_00_ET_CPtVzHMxvzYAzMlFuB9342${BR}\n` +
  '=== 最近一次启动之后的行 ===\n\n' +
  `${ST}running${BR}\n`

test('真实事故形态：保留正文、丢弃回声（整段）', () => {
  const { text, echoed } = run([realCase])
  assert.equal(echoed, true)
  assert.ok(text.includes('重启+切模型收到'), '正文应保留')
  assert.ok(!text.includes('Tool Result'), '回声不应上屏')
  assert.ok(!text.includes('启动次数=8'), '回声内容不应上屏')
  assert.ok(!text.includes('status:'), 'status 标记不应上屏')
})

test('真实事故形态：逐字符分块同样拦住', () => {
  const { text, echoed } = run([...realCase])
  assert.equal(echoed, true)
  assert.ok(text.includes('重启+切模型收到'))
  assert.ok(!text.includes('Tool Result'))
  assert.ok(!text.includes('启动次数=8'))
})

test('真实事故形态：3 字符分块', () => {
  const chunks = realCase.match(/[\s\S]{1,3}/g) ?? []
  const { text, echoed } = run(chunks)
  assert.equal(echoed, true)
  assert.ok(!text.includes('Tool Result'))
  assert.ok(!text.includes('启动次数=8'))
})

// ② 转写轮次行成串出现
test('成串 User:/Assistant: 被拦下', () => {
  const { echoed, text } = run(['看起来没问题。\n\nUser: 继续\n\nAssistant: 好的\n'])
  assert.equal(echoed, true)
  assert.ok(text.includes('看起来没问题'))
  assert.ok(!text.includes('User: 继续'))
})

test('单行 User: 属正常正文，不误伤', () => {
  const { echoed, text } = run(['配置文件里 User: admin 这一行需要改。\n'])
  assert.equal(echoed, false)
  assert.ok(text.includes('User: admin'))
})

// ③ 围栏代码块内引用这些标记 = 正常讨论，不该拦
const fenced = ['讨论本插件时会引用这些标记：\n\n```\n', `${TR}call_x${BR} 是工具结果标记\n`, '```\n\n以上是说明。\n'].join('')

test('围栏内引用标记不误伤', () => {
  const { echoed, text } = run([fenced])
  assert.equal(echoed, false)
  assert.ok(text.includes('以上是说明'))
  assert.ok(text.includes('是工具结果标记'))
})

test('围栏内引用标记不误伤（逐字符）', () => {
  const { echoed, text } = run([...fenced])
  assert.equal(echoed, false)
  assert.ok(text.includes('以上是说明'))
})

// ④ 单独出现的 [status: xxx]
test('单独 status 标记被拦下', () => {
  const { echoed, text } = run([`干完了。\n${ST}running${BR}\n`])
  assert.equal(echoed, true)
  assert.ok(text.includes('干完了'))
  assert.ok(!text.includes('status:'))
})

// ⑤ 干净回答原样通过
test('干净回答原样通过', () => {
  const clean = '# 结论\n\n- 插件都装上了\n- 压缩仍失效\n\n耗时 3 分钟。\n'
  const { text, echoed } = run([clean])
  assert.equal(echoed, false)
  assert.equal(text, clean)
})

// ⑥ 半行不得提前上屏（防止先吐垃圾再收回）
test('行未完成时不上屏', () => {
  const guard = new TranscriptEchoGuard()
  const out = guard.push('正常正文\n[Tool Resu')
  assert.equal(out.text, '正常正文\n', '未完成的半行必须被扣住')
  const rest = guard.flush()
  assert.equal(rest.echoed, true, 'flush 时半行也应被判为回声')
  assert.equal(rest.text, '')
})

// ⑦ 2026-09-11 新形态：给回声行加 `Assistant: ` 前缀（转写标记不在行首）
// 现场（install-plugin 工作区会话 54628c96，模型原样输出）：
const REAL_PREFIXED_ECHO =
  '\n\nAssistant: [Tool Result for call_7b1a7d39a2e54bc0b8f1]\ndirect ERR fetch failed\n\n\ntablished\n\nAssistant: '

test('带头像前缀的回声（`Assistant: [Tool Result …]`）也必须整段拦下', () => {
  const { text, echoed } = run([REAL_PREFIXED_ECHO])
  assert.equal(echoed, true, '必须判定为回声')
  assert.ok(!text.includes('Tool Result'), `回声漏出去了：${JSON.stringify(text)}`)
  assert.ok(!text.includes('fetch failed'), `回声正文也漏了：${JSON.stringify(text)}`)
  assert.ok(!text.includes('tablished'), `回声尾巴漏了：${JSON.stringify(text)}`)
  assert.equal(text, '\n\n', `只应保留回声之前的空行：${JSON.stringify(text)}`)
})

test('分块到达时同样拦得住（转写标记被切开）', () => {
  const chunks = [
    '\n\nAssistant: [Tool Resu',
    'lt for call_7b1a7d39a2e54bc0b8f1]\ndirect ERR fetch fai',
    'led\n\n\ntablished\n\nAssistant: ',
  ]
  const { text, echoed } = run(chunks)
  assert.equal(echoed, true)
  assert.ok(!text.includes('Tool Result'), `分块时漏了：${JSON.stringify(text)}`)
  assert.equal(text, '\n\n')
})

test('裸的 `Assistant:`（冒号后无内容）视为起一行假转写 → 拦下', () => {
  const { text, echoed } = run(['正常回答。\n', 'Assistant: '])
  assert.equal(echoed, true, '光秃秃的 Assistant: 不是正常回答')
  assert.equal(text, '正常回答。\n', `实际：${JSON.stringify(text)}`)
})

// ⑧ 2026-09-11 17:2x：会话超长后，模型复读 prompt 里的截断占位符
// 现场（install-plugin 工作区会话 54628c96，模型原样输出）：
const REAL_TRUNC_ECHO =
  '重启后的状态我已经查到了——插件确实挂上了，再做最后一步验证。\n\n\n\ntruncated]\n\n[Assistant truncated]'

test('复读截断占位符（`truncated]` / `[Assistant truncated]`）拦下，正文保留', () => {
  const { text, echoed } = run([REAL_TRUNC_ECHO])
  assert.equal(echoed, true, '必须判定为回声')
  assert.ok(text.includes('重启后的状态我已经查到了'), `回声之前的正文要保留：${JSON.stringify(text)}`)
  assert.ok(!text.includes('truncated'), `占位符漏了：${JSON.stringify(text)}`)
})

test('插件的省略标记（`[N chars omitted]`）被复读也拦下', () => {
  const { text, echoed } = run(['前文。\n', '...[12345 chars omitted]...\n', '后面没了。'])
  assert.equal(echoed, true)
  assert.equal(text, '前文。\n', `实际：${JSON.stringify(text)}`)
})

test('分块到达时同样拦得住', () => {
  const chunks = ['正文。\n\n\n\ntruncat', 'ed]\n\n[Assistan', 't truncated]']
  const { text, echoed } = run(chunks)
  assert.equal(echoed, true)
  assert.ok(!text.includes('truncated'), `分块时漏了：${JSON.stringify(text)}`)
  // 回声之前的空行属于正文，保留是正常的
  assert.equal(text, '正文。\n\n\n\n')
})

// ⑨ 2026-09-16 17:35 新形态：模型在**正文里引用一次**工具结果当证据（行内、单行）
// 现场（1ceshi 工作区会话 e17f4ccf）：它要证明 `subagent_fork` 的继承范围与文档不符，
// 于是正文里出现 `[Tool Result for call_…]`。旧判据「行内命中即从该行起砍到结尾」
// 把整段回答（问题项 4、5 + 结论）一起吞了，用户只看到「话说到一半就停了」。
const INLINE_QUOTE =
  '## ⚠️ 确实有问题\n\n' +
  '4. **`subagent_fork` 的继承范围与文档不符**（重点）\n\n' +
  '- 实测：`[Tool Result for call_abc123]` 返回 `FORK-OK`，但文档写的是会继承全部上下文。\n' +
  '- 影响：子代理读不到父会话历史，需要显式传参。\n\n' +
  '5. **`workflow` 的并发上限没写进文档**。\n'

test('正文里引用一次工具结果（行内、单行）不误伤', () => {
  const { text, echoed } = run([INLINE_QUOTE])
  assert.equal(echoed, false, `不该判回声：${JSON.stringify(text)}`)
  assert.equal(text, INLINE_QUOTE, '整段应原样上屏')
})

test('引用行在流式分块下同样不误伤（且顺序不乱）', () => {
  const chunks = INLINE_QUOTE.match(/[\s\S]{1,7}/g) ?? []
  const { text, echoed } = run(chunks)
  assert.equal(echoed, false)
  assert.equal(text, INLINE_QUOTE, `分块后顺序/内容不一致：${JSON.stringify(text)}`)
})

test('行内引用 + 空行 + 正文：仍属正文（放行）', () => {
  const src = '开头。\n引用：`[Tool Result for call_a]`\n\n\n继续写正文。\n'
  const { text, echoed } = run([src])
  assert.equal(echoed, false)
  assert.equal(text, src)
})

test('连续两行都在贴工具结果 → 判回声（防漏）', () => {
  const { text, echoed } = run(['正文。\n', '- `[Tool Result for call_a]`\n', '- `[Tool Result for call_b]`\n'])
  assert.equal(echoed, true)
  assert.equal(text, '正文。\n')
})

test('行内引用之后紧跟行首标记 → 整段拦下（防漏）', () => {
  const { text, echoed } = run(['开头。\n', '引用：`[Tool Result for call_a]`\n', '[status: running]\n'])
  assert.equal(echoed, true)
  assert.equal(text, '开头。\n')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
