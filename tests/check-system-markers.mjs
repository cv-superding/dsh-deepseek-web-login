/**
 * 回归：模型吐出的伪系统标记（<ds_system>/<system>）必须被剥掉，不能上屏。
 *
 * 现场（2026-09-11 实测，session-0e88c545）：模型在一条正文里连续输出 13 个
 *   <ds_system>Tool result for call_1a2b3c</ds_system>
 * 调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…）—— 这是模型在**模仿**系统消息格式，
 * 与「转写回声」同类（但形态是 XML 标签而不是 [Tool Result] 行）。
 *
 * 用法: node tests/check-system-markers.mjs
 */
import assert from 'node:assert/strict'
import { stripSystemMarkers } from '../src/protocol.ts'

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

test('真实事故：13 个编造的 ds_system 标记全被剥掉', () => {
  const marks = Array.from({ length: 13 }, (_, i) => {
    const ids = ['call_1a2b3c', 'call_4d5e6f', 'call_7a8b9c', 'call_0d1e2f', 'call_9f0a1b', 'call_c2d3e4']
    return `<ds_system>Tool result for ${ids[i % ids.length]}</ds_system>`
  }).join('\n')
  const input = `正常开头。\n\n${marks}\n\n正常结尾。`
  const result = stripSystemMarkers(input)
  assert.ok(result.stripped, '必须报告剥掉了')
  assert.ok(!result.text.includes('ds_system'), '正文里不能有 ds_system')
  assert.ok(result.text.includes('正常开头'), '开头要保留')
  assert.ok(result.text.includes('正常结尾'), '结尾要保留')
})

test('单个 ds_system 标记被剥掉', () => {
  const result = stripSystemMarkers('前文。<ds_system>Tool result for call_x</ds_system>后文。')
  assert.ok(result.stripped)
  assert.equal(result.text, '前文。后文。')
})

test('截断的半截标记也被剥掉（流在标记中间断掉）', () => {
  const result = stripSystemMarkers('前文。\n<ds_system>Tool call made.</ds_system')
  assert.ok(result.stripped)
  assert.ok(!result.text.includes('ds_system'))
  assert.ok(result.text.includes('前文。'))
})

test('<system> 标记同样被剥掉', () => {
  const result = stripSystemMarkers('前文。<system>Tool results are not shown</system>后文。')
  assert.ok(result.stripped)
  assert.equal(result.text, '前文。后文。')
})

test('围栏代码块里的标记**不**被剥掉（正常回答可能在讨论这些标记）', () => {
  const input = '说明：\n```\n<ds_system>这是示例</ds_system>\n```\n以上是代码示例。'
  const result = stripSystemMarkers(input)
  assert.ok(!result.stripped, '围栏内不该剥')
  assert.ok(result.text.includes('<ds_system>这是示例</ds_system>'), '围栏内的标记必须保留')
})

test('没有标记的文本原样通过', () => {
  const input = '正常回答，没有任何标记。\n\n第二段也正常。'
  const result = stripSystemMarkers(input)
  assert.ok(!result.stripped)
  assert.equal(result.text, input)
})

test('嵌套在其他文本中的标记只剥标记本身', () => {
  const input = '表格：| 工具 | 结果 |\n|---|---|\n| read | <ds_system>ok</ds_system> |'
  const result = stripSystemMarkers(input)
  assert.ok(result.stripped)
  assert.ok(result.text.includes('| read |'), '表格结构要保留')
  assert.ok(!result.text.includes('<ds_system>'), '标记要被剥掉')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
