/**
 * 回归：模型吐出的伪系统标记（<ds_system>/<system>）必须被剥掉，不能上屏。
 *
 * 现场 A（2026-09-11 实测，session-0e88c545）：模型在一条正文里连续输出 13 个
 *   <ds_system>Tool result for call_1a2b3c</ds_system>
 * 调用 ID 还是字母递增编造的（1a2b3c→4d5e6f→7a8b9c…）—— 这是模型在**模仿**系统消息格式，
 * 与「转写回声」同类（但形态是 XML 标签而不是 [Tool Result] 行）。
 *
 * 现场 B（2026-09-12，session-15ac4c56）：正文里冒出
 *   <ide_result_status>Tool ran without output or errors</ide_result_status>
 * ⚠️ 这个串在 **DSH 的 app.asar、全部已装插件、`~/.dsh` 全树**里都搜不到（原始字节搜索 0 处），
 * 而且会话日志里**只出现在模型的输出字段**（212 条 tool/result、用户消息、系统消息里一处都没有）
 * → 判定是模型自己编的，不是 DSH 喂给它的。所以它属于同一类：**剥离，不要当成真实协议**。
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

test('现场 B：编造的 ide_result_status 标记被剥掉，上下文文字保留', () => {
  const input =
    'Core backend written. Now I need to verify the module-resolution question before claiming it works.\n\n\n\n' +
    '<ide_result_status>Tool ran without output or errors</ide_result_status>'
  const result = stripSystemMarkers(input)
  assert.ok(result.stripped, '必须报告剥掉了')
  assert.ok(!result.text.includes('ide_result_status'), '正文里不能出现这个标记')
  assert.ok(!result.text.includes('Tool ran without output'), '标记的内容也是垃圾，一起剥')
  assert.ok(result.text.includes('Core backend written.'), '标记之前的正文要保留')
})

test('ide_result_status 夹在正文中间也只剥标记', () => {
  const result = stripSystemMarkers('前文。<ide_result_status>Tool ran without output or errors</ide_result_status>后文。')
  assert.ok(result.stripped)
  assert.equal(result.text, '前文。后文。')
})

test('截断的半截 ide_result_status 同样被剥掉', () => {
  const result = stripSystemMarkers('前文。\n<ide_result_status>Tool ran without output or erro')
  assert.ok(result.stripped)
  assert.ok(!result.text.includes('ide_result_status'))
  assert.ok(result.text.includes('前文。'))
})

test('⚠️ 清单外的标签不动：<tool_call> 是**真协议**，剥了会把工具调用吃掉', () => {
  const input = '好的，我来读文件。\n<tool_call>\n{"name":"read_file"}\n</tool_call>'
  const result = stripSystemMarkers(input)
  assert.ok(!result.stripped, '不能误报剥掉了')
  assert.equal(result.text, input, '必须原样通过')
})

test('围栏代码块里的 ide_result_status 也保留（讨论这些标记时不该被吃掉）', () => {
  const input = '说明：\n```\n<ide_result_status>示例</ide_result_status>\n```\n以上是示例。'
  const result = stripSystemMarkers(input)
  assert.ok(!result.stripped, '围栏内不该剥')
  assert.ok(result.text.includes('<ide_result_status>示例</ide_result_status>'))
})

test('三种标记混在一起也能全部剥掉，且不碰上下文', () => {
  const input = [
    '开头。',
    '<ds_system>Tool result for call_1a2b3c</ds_system>',
    '<system>Tool results are not shown</system>',
    '<ide_result_status>Tool ran without output or errors</ide_result_status>',
    '结尾。',
  ].join('\n')
  const result = stripSystemMarkers(input)
  assert.ok(result.stripped)
  for (const tag of ['ds_system', 'system', 'ide_result_status']) {
    assert.ok(!result.text.includes('<' + tag), '不该残留 ' + tag)
  }
  assert.ok(result.text.includes('开头。'))
  assert.ok(result.text.includes('结尾。'))
})

// ── 现场 ④（2026-09-13，会话 15ac4c56 记录 [1480]）──────────────────
// 模型把 SSH 插件一次读取工具的结果**整段复述**进正文，且是**跨行**的：
//   "Found a real gap: … Fixing that, then doing the final pass." + 换行x4 +
//   "<tool_result>Path: …" + 换行 + "<path>…</path>" + 换行 + "<type>file</type>" + 换行 + "<content>" …
// 逐行处理匹配不到跨行的闭合标签，所以单独加了「跨行长标记」这一遍。
// 这个标签比 ds_system 那批更「可讨论」（用户正在开发产出它的插件），
// 于是要求正文 >= 120 字才剥 —— 真实回声是整份文件，随口举例不会那么长。
const NL = String.fromCharCode(10)
const longBody = Array.from({ length: 12 }, (_, i) => `${i + 1}: { "k": ${i} }`).join(NL)
const echoedToolResult =
  'Found a real gap: the patch file is documented but missing from files. Fixing that.' +
  NL + NL + NL + NL +
  '<tool_result>Path: F:/x/package.json' + NL +
  '<path>F:/x/package.json</path>' + NL +
  '<type>file</type>' + NL +
  '<content>' + NL + longBody + NL + '</content>' + NL +
  '</tool_result>'

test('跨行 tool_result 回声：整段剥掉，正文保留', () => {
  const r = stripSystemMarkers(echoedToolResult)
  assert.equal(r.stripped, true, '自证：必须真的剥掉了东西')
  assert.ok(r.text.includes('Fixing that.'), '模型真正说的话要留下')
  assert.ok(!/tool_result/i.test(r.text), `不该残留标记：${JSON.stringify(r.text.slice(-80))}`)
  assert.ok(!r.text.includes('package.json'), '回声里的工具结果内容也不该留下')
})

test('跨行 tool_result：回声在中间时，只剥块本身，后面的正文不能丢', () => {
  // ⚠️ 这条是为了区分「闭合形态」与「未闭合形态」两条规则：
  //    上面那条用例里回声正好在**末尾**，未闭合规则也能兜住 → 两条规则互为备份，
  //    于是"把闭合规则改坏"也测不出来（反向验证假绿）。回声后面接正文才能区分。
  const middle =
    '前言。' +
    NL + NL + NL + NL +
    '<tool_result>Path: F:/x/package.json' + NL +
    '<path>F:/x/package.json</path>' + NL +
    '<type>file</type>' + NL +
    '<content>' + NL + longBody + NL + '</content>' + NL +
    '</tool_result>' +
    NL + NL + '后记：接下来还要跑一遍测试。'
  const r = stripSystemMarkers(middle)
  assert.equal(r.stripped, true, '自证：必须真的剥掉了东西')
  assert.ok(r.text.includes('前言。'), '回声前的正文要留下')
  assert.ok(r.text.includes('后记：接下来还要跑一遍测试。'), `回声后的正文不能被一起吃掉：${JSON.stringify(r.text.slice(-80))}`)
  assert.ok(!/tool_result/i.test(r.text), '回声块本身要剥掉')
})

test('跨行 tool_result：短示例保留（别把「讨论格式」的正常回答吃掉）', () => {
  const short = '示例：<tool_result>short</tool_result> 就是那个格式'
  const r = stripSystemMarkers(short)
  assert.equal(r.stripped, false, '不到 120 字的示例不该剥')
  assert.equal(r.text, short)
})

test('跨行 tool_result：围栏代码块内保留', () => {
  const fenced = ['```xml', '<tool_result>Path: a', '<content>', 'x'.repeat(200), '</content>', '</tool_result>', '```'].join(NL)
  const r = stripSystemMarkers(fenced)
  assert.equal(r.stripped, false, '围栏内是正常文档内容')
  assert.equal(r.text, fenced)
})

test('跨行 tool_result：未闭合（流被截断）同样剥掉', () => {
  const truncated = '说明。' + NL + NL + '<tool_result>Path: a' + NL + '<content>' + NL + longBody
  const r = stripSystemMarkers(truncated)
  assert.ok(r.text.includes('说明。'), '正文要留下（自证）')
  assert.ok(!/tool_result/i.test(r.text), '半截标记也是垃圾')
})

test('回归：单行 ds_system 仍照旧剥（新逻辑别改坏旧的）', () => {
  const r = stripSystemMarkers('前 <ds_system>Tool result for call_1a2b3c</ds_system> 后')
  assert.equal(r.stripped, true)
  assert.ok(r.text.includes('前') && r.text.includes('后'))
  assert.ok(!/ds_system/i.test(r.text))
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
