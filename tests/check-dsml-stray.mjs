/**
 * 回归：孤立的工具调用标记残片不许上屏。
 *
 * 现场（2026-09-12 实测，用户截图）：正文里冒出
 *     voke> </ calls>
 * 会话日志里对应的是 `assistant/message` 的 **text 块**（会显示给用户的那块）：
 *     "I'll finish the install: … variable.\n\n\n\nvoke>\n</ calls>"
 * 同一条消息里的 3 个工具调用**都解析成功了** —— 也就是说，抓到了调用，
 * 却把标记的残片当正文吐了出去。
 *
 * 离线复现（已确认）：连续两个裸 `<|DSML|invoke …></|DSML|invoke>` 之后
 * 跟一个 `</|DSML|calls>`，旧代码的输出是
 *     "…\n\n\n\n</|DSML|calls>"     ← 残片上屏
 *
 * 两条独立的成因，都要守：
 *   1. `findXmlToolCallEnd` 吞完 invoke 块后在孤立闭合标签处停下，把它留在缓冲里
 *   2. `flush()` 把 hold 住的尾巴无条件吐出（残片通常 < HOLD_BACK_CHARS，会被一直 hold 到流结束）
 *
 * 用法: node tests/check-dsml-stray.mjs
 */
import assert from 'node:assert/strict'
import { ToolCallStreamFilter, stripStrayToolMarkup, findXmlToolCallEnd } from '../src/protocol.ts'

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

const TOOLS = new Set(['read', 'write', 'edit'])

function feed(chunks) {
  const f = new ToolCallStreamFilter(TOOLS)
  let text = ''
  const calls = []
  for (const c of chunks) {
    const out = f.push(c)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = f.flush()
  text += tail.text
  calls.push(...tail.calls)
  return { text, calls }
}

const INVOKE = (name) =>
  `<|DSML|invoke name="${name}"><|DSML|parameter name="path">p</|DSML|parameter></|DSML|invoke>`

// ── 现场复现 ────────────────────────────────────────────────────

test('现场：裸 invoke × 2 之后跟孤立的 </|DSML|calls>，残片不许上屏', () => {
  const r = feed(['I finish the install.\n\n\n\n', INVOKE('read'), INVOKE('write'), '\n</|DSML|calls>'])
  assert.equal(r.calls.length, 2, '两个调用都应解析出来')
  assert.ok(!r.text.includes('calls>'), `正文里残留了闭合标签：${JSON.stringify(r.text)}`)
  assert.ok(!r.text.includes('DSML'), '正文里不该残留 DSML 字样')
  assert.ok(r.text.includes('I finish the install.'), '正文本身必须保留')
})

test('逐字符喂（最细的 chunk 边界）也不泄漏', () => {
  const all =
    'I finish the install.\n\n\n\n<|DSML|invoke name="read"><|DSML|parameter name="path">p</|DSML|parameter></|DSML|invoke>' +
    '<|DSML|invoke name="write"><|DSML|parameter name="path">p</|DSML|parameter></|DSML|invoke></|DSML|calls>'
  const r = feed(all.split(''))
  assert.equal(r.calls.length, 2)
  assert.ok(!r.text.includes('calls>'), `残留：${JSON.stringify(r.text)}`)
})

test('退化形态 </ calls>（DSML 前缀被吃光）也要剥掉', () => {
  const r = feed(['说明文字。\n\n\n\n', INVOKE('read'), '\n</ calls>'])
  assert.equal(r.calls.length, 1)
  assert.ok(!r.text.includes('calls>'), `残留：${JSON.stringify(r.text)}`)
})

test('截图里的后半截残片 voke> 不许上屏', () => {
  const r = feed(['说明文字。\n\n\n\n', INVOKE('read'), '\nvoke>\n</ calls>'])
  assert.equal(r.calls.length, 1)
  assert.ok(!r.text.includes('voke>'), `残留：${JSON.stringify(r.text)}`)
})

test('findXmlToolCallEnd 把尾随的孤立闭合标签一并算进块内', () => {
  const block =
    '<|DSML|invoke name="read"><|DSML|parameter name="path">p</|DSML|parameter></|DSML|invoke>\n</|DSML|calls>'
  assert.equal(findXmlToolCallEnd(block), block.length, '孤立闭合标签应被吞进块里')
})

test('带完整 wrapper 的块（开始标签也在）本来就不泄漏 —— 别改坏', () => {
  const r = feed([
    '说明。\n\n\n\n',
    '<|DSML|tool_calls>',
    INVOKE('read'),
    INVOKE('write'),
    '</|DSML|calls>',
  ])
  assert.equal(r.calls.length, 2)
  assert.ok(!r.text.includes('calls>'), `残留：${JSON.stringify(r.text)}`)
})

// ── 不能误伤正常内容 ────────────────────────────────────────────

test('普通英文里的 invoke 一词不受影响（必须有尖括号和 > 才算标记）', () => {
  const s = 'The plugin will invoke the tool when needed, and it may call other helpers.'
  assert.equal(stripStrayToolMarkup(s), s)
})

test('正文里的 <invoke> 讨论保持原样（开始形态不是残片）', () => {
  const s = '模型有时会写 <invoke name="x">，这不是我们要剥的残片。'
  assert.equal(stripStrayToolMarkup(s), s)
})

test('没有标记特征的文本原样返回（零开销快路径）', () => {
  for (const s of ['', '普通回答，没有任何标记。', 'a\nb\nc']) {
    assert.equal(stripStrayToolMarkup(s), s)
  }
})

test('刻意的取舍：正文里孤立出现的 </calls> 也会被剥（与残片无法区分）', () => {
  // 记录边界：这条不是"期望行为"，而是明确的取舍 —— 孤立闭合标签与残片形态完全一致，
  // 无法可靠区分。真实回答里几乎不会出现它，而残片泄漏是实打实的 bug。
  assert.equal(stripStrayToolMarkup('前面 </calls> 后面'), '前面  后面')
})

// ── 老行为不能破 ────────────────────────────────────────────────

test('纯正文仍然原样透传（含 flush 尾部）', () => {
  const f = new ToolCallStreamFilter(TOOLS)
  let text = ''
  for (const piece of ['你好', '，这是', '一段普通回答。']) text += f.push(piece).text
  text += f.flush().text
  assert.equal(text, '你好，这是一段普通回答。')
})

test('JSON 工具调用仍正常解析（XML 那条修了不许影响 JSON 路径）', () => {
  const f = new ToolCallStreamFilter(TOOLS)
  const out = f.push('{"tool_calls":[{"name":"read","arguments":{"path":"a"}}]}')
  const tail = f.flush()
  assert.equal(out.calls.length + tail.calls.length, 1)
  assert.equal(!out.text && !tail.text, true, 'JSON 调用不该漏成正文')
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
