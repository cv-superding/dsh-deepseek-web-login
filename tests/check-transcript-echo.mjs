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

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
