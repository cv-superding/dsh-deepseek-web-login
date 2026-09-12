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
import { ToolCallStreamFilter, stripStrayToolMarkup, findXmlToolCallEnd, TOOL_PROTOCOL_INSTRUCTIONS } from '../src/protocol.ts'

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

// ── 现场 ②（2026-09-12 晚，用户截图 + 会话日志 [1354]）────────────────
// 形态与现场 ① 不同：这次是**完整的开标签** + 两个闭合标签，中间没有任何 invoke。
//   正文 + 4 个换行 + "<|DSML|calls>" + 换行 + "</|DSML|invoke>" + 换行 + "</|DSML|calls>"
// 机制一：`<|DSML|calls>` 命中 XML_STARTER_RE → 进捕获态 → 里面没有 invoke →
//         `looksLikeToolCallBlock` 判否 → 捕获内容被当正文透出（那条路径原本没剥残片）。
// 机制二（只在流式下出现）：hold-back 判定不认「半截 DSML 前缀」——
//         pending 停在 `<|DSML`（少最后一个竖线）时被判成"没有待补前缀"，半截标记直接当正文吐出去。
const NL = String.fromCharCode(10)
// ⚠️ 前缀必须够长：hold-back 只在 pending 超过 HOLD_BACK_CHARS(24) 时才切分，
//    前缀太短会让整段留在 pending 里、被 drain 开头那次 stripStray 顺手清掉 ——
//    那样就测不到「半截前缀被切出去」这条真路径（第一版样本太短，反向验证没红就是这个原因）。
const APOS = String.fromCharCode(8217) // ’ —— 会话日志里是弯引号，逐字保留
const leakedSample =
  'Continuing. Two things I left in a bad state: `validate-preset.mjs` has a mid-file import ' +
  'with `require$`-prefixed aliases, and the new scripts aren' + APOS + 't wired into `package.json`. Fixing both.' +
  NL + NL + NL + NL +
  '<|DSML|calls>' + NL + '</|DSML|invoke>' + NL + '</|DSML|calls>'

function runThrough(chunks) {
  const filter = new ToolCallStreamFilter()
  let text = ''
  const calls = []
  for (const chunk of chunks) {
    const out = filter.push(chunk)
    text += out.text
    calls.push(...(out.calls ?? []))
  }
  const last = filter.flush()
  text += last.text
  calls.push(...(last.calls ?? []))
  return { text, calls }
}

test('现场② 退化块（开标签+闭合标签、无 invoke）：一次喂入不上屏', () => {
  const { text, calls } = runThrough([leakedSample])
  assert.ok(text.includes('Fixing both.'), '正常正文不能被吃掉（自证：确实走过了这段逻辑）')
  assert.equal(calls.length, 0, '这里没有真正的调用')
  assert.ok(!/DSML/i.test(text), `正文里不该有 DSML：${JSON.stringify(text.slice(-60))}`)
})

test('现场② 逐字符流式（hold-back 边界）：半截 DSML 前缀不许漏出去', () => {
  assert.ok(leakedSample.length > 200, '样本必须够长才会触发 hold-back 切分（否则这条用例没测到东西）')
  // 这条是真回归点：逐字符喂时 pending 会停在 `<|DSML`，
  // 旧代码的 hold 判定给 0 → 半截标记被当正文吐出 → 后面补成完整标记就成了乱码。
  const { text } = runThrough([...leakedSample])
  assert.ok(text.includes('Fixing both.'), '正常正文不能被吃掉（自证）')
  assert.ok(!/DSML/i.test(text), `流式下也不该有 DSML：${JSON.stringify(text.slice(-60))}`)
})

test('stripStrayToolMarkup：DSML 前缀的裸包裹标签（开/闭、空格、全角竖线）', () => {
  const cases = [
    '<|DSML|calls>',
    '</|DSML|calls>',
    '</|DSML|invoke>',
    '<|DSML|tool_calls>',
    '< | DSML | calls>',
    '<｜DSML｜calls>',
    '<dsml-calls>',
  ]
  for (const c of cases) assert.equal(stripStrayToolMarkup(c), '', `应剥掉：${c}`)
})

test('stripStrayToolMarkup：正常提到尖括号的文本不许乱剥（对照）', () => {
  const keep = 'a < b and c > d, 用 <div> 标签'
  assert.equal(stripStrayToolMarkup(keep), keep, '普通尖括号文本必须原样保留')
})

test('对照组：正常的 DSML invoke 调用必须仍被解析出来', () => {
  const good = '<|DSML|invoke name="read"><|DSML|parameter name="path">a.ts</|DSML|parameter></|DSML|invoke>'
  const { text, calls } = runThrough([good])
  assert.equal(calls.length, 1, '真调用不能被这次修复误伤')
  assert.equal(calls[0].name, 'read')
  assert.ok(!/DSML/i.test(text), '调用块本身不该出现在正文里')
})

test('工具协议提示词里不再出现私有标记的字面量', () => {
  // 实测：那段文字会随每次请求进到网页端会话里，用户在网页上就能看到它；
  // 而且「点名某个 token」本身有诱发模型吐它的风险。
  for (const bad of ['DSML|>', '|DSML|']) {
    assert.ok(!TOOL_PROTOCOL_INSTRUCTIONS.includes(bad), `提示词里不该出现 ${bad}`)
  }
  assert.ok(TOOL_PROTOCOL_INSTRUCTIONS.includes('Do NOT use XML/HTML-like markup'), '禁令本身要保留')
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
