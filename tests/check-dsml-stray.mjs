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
import {
  ToolCallStreamFilter,
  parseXmlToolCalls,
  serializePrompt,
  stripResidualDsml,
  stripStrayToolMarkup,
  findXmlToolCallEnd,
  TOOL_PROTOCOL_INSTRUCTIONS,
} from '../src/protocol.ts'

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

test('stripStrayToolMarkup：带前缀的 </parameter> 也要剥（流式阶段没有第二道补刀）', () => {
  // 现场：`LIDOW:{…}` 后面粘了三个闭标签。calls/invoke 这条函数本来就剥，
  // parameter 只由 flush 的 stripResidualDsml 兜 ⇒ 推送阶段就上屏了（用户能看见）。
  for (const tag of ['</|DSML|parameter>', '</｜｜DSML｜｜ parameter>', '<dsml-parameter>']) {
    assert.equal(stripStrayToolMarkup(`前面${tag}后面`), '前面后面', `没剥：${tag}`)
  }
  // 反向：无前缀的 parameter 是正文里可以讨论的普通 XML
  const keep = '正文里的 <parameter> 标签只是举例。'
  assert.equal(stripStrayToolMarkup(keep), keep)
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

// ── 0.6.37：前缀形态矩阵（2026-10-03 用户截图「DSML 漏到网页端」）──────────────
//
// 🔴 这批用例为什么必须存在：旧用例只测了 `<dsml-calls>`（**连字符后无空格**）这一种写法，
// 而模型还吐 `<dsml- calls>`（**有空格**）—— 那种整块原样上屏，两条通道都拦不住。
// 与「0.6.28 思考分支一句 continue 跳过全部四道网」是同一类错误：
// **判据只覆盖了一种规范写法，现场却是另一种。**
//
// 现场样本（用户分享页原文，DSML 前后是全角双竖线、标签名前有空格）：
//     <｜｜DSML｜｜ calls>
//     <｜｜DSML｜｜ invoke name="pwsh">
//     <｜｜DSML｜｜ parameter name="command" …>…</｜｜DSML｜｜ parameter>
//     </｜｜DSML｜｜ invoke>
//     </｜｜DSML｜｜ calls>

/** 按给定前缀拼一个完整的 DSML 调用块。 */
function dsmlBlock(prefix) {
  return [
    `<${prefix} calls>`,
    `<${prefix} invoke name="pwsh">`,
    `<${prefix} parameter name="command">Get-Date</${prefix} parameter>`,
    `</${prefix} invoke>`,
    `</${prefix} calls>`,
  ].join('\n')
}

/** 上屏文本里是否还留着标记痕迹（正文里正常讨论的代码片段不算，见下方独立用例）。 */
function hasMarkup(text) {
  return /DSML|｜｜|\|\||<|dsml|<\/?\s*(calls|invoke|parameter)\b/i.test(text)
}

for (const [label, prefix] of [
  ['全角双竖线（★现场形态）', '｜｜DSML｜｜'],
  ['全角双竖线 + 空格', '｜｜ DSML ｜｜'],
  ['半角单竖线', '|DSML|'],
  ['半角双竖线', '||DSML||'],
  ['dsml- 连字符（★旧用例只测这个）', 'dsml-'],
  ['dsml- 连字符 + 空格（★本次实测泄漏）', 'dsml- '],
  ['无前缀裸标签', ''],
]) {
  test(`前缀「${label}」：整块不许上屏，且必须提取出调用`, () => {
    const { text, calls } = runThrough([dsmlBlock(prefix)])
    assert.ok(!hasMarkup(text), `标记泄漏到正文: ${JSON.stringify(text.slice(0, 120))}`)
    assert.equal(calls.length, 1, '真调用必须被提取（否则这次修复是把调用也吞了）')
    assert.equal(calls[0].name, 'pwsh')
  })

  test(`前缀「${label}」：流被截断（无任何闭合）也不许上屏`, () => {
    const truncated = [`<${prefix} calls>`, `<${prefix} invoke name="pwsh">`, `<${prefix} parameter name="command">Get-Date`].join('\n')
    const { text } = runThrough([truncated])
    assert.ok(!hasMarkup(text), `截断的标记泄漏到正文: ${JSON.stringify(text.slice(0, 120))}`)
  })

  test(`前缀「${label}」：逐字符分块也不许上屏（跨包 hold-back）`, () => {
    const raw = dsmlBlock(prefix)
    const { text } = runThrough([...raw])
    assert.ok(!hasMarkup(text), `逐字符分块时泄漏: ${JSON.stringify(text.slice(0, 120))}`)
  })
}

test('★ 反向：正文里正常讨论 <invoke> 不会被误吞（`invoke` 与包裹标签区别对待）', () => {
  // ⚠️ 修带空格前缀时我一度把「无前缀」也放开，结果把这句话吃掉了（logic-test 抓到）。
  // 放宽前缀不得殃及正常回答 —— 判据放宽很容易，判据**收窄**才难。
  //
  // 只守 `invoke`：`calls` / `tool_calls` 是 DSML 的**私有包裹标签名**，正文里不会正常
  // 出现（模型讨论工具协议时说的是「tool calling protocol」而不是 `<calls>`），
  // 所以剥它是零风险；`invoke` 才是通用 XML 标签，必须留着。
  const line = '在 HTML 里 <invoke> 不是一个标准标签，它只是普通文字。'
  assert.equal(stripStrayToolMarkup(line), line, `被误吞了: ${JSON.stringify(stripStrayToolMarkup(line))}`)
})

// ── 2026-11-03：DSML 参数类型 + 可见正文里的残留标记 ──────────────

test('DSML：显式 string="true" 必须保持字符串（不许被 JSON 解码成数字）', () => {
  const build = (attr) =>
    `<｜｜DSML｜｜invoke name="t"><｜｜DSML｜｜parameter name="n"${attr}>123</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`
  const args = (attr) => JSON.parse(parseXmlToolCalls(build(attr))?.[0]?.arguments ?? '{}')
  assert.equal(args('').n, 123, '缺省仍是"能解析就解析"（既有行为）')
  assert.equal(args(' string="false"').n, 123, 'string="false" ⇒ 按 JSON 解')
  assert.equal(args(' string="true"').n, '123', 'string="true" ⇒ 原样字符串')
  assert.equal(args(" string='true'").n, '123', '单引号属性同样要认')
})

test('DSML：string="true" 在**截断抢救**那条路径上也要生效（漏一处就是后门）', () => {
  // 故意不给 </invoke>：走 salvageXmlParameters
  const truncated =
    '<｜｜DSML｜｜invoke name="t"><｜｜DSML｜｜parameter name="n" string="true">123'
  const args = JSON.parse(parseXmlToolCalls(truncated)?.[0]?.arguments ?? '{}')
  assert.equal(args.n, '123', `抢救路径也要尊重 string="true"，实际：${JSON.stringify(args)}`)
})

test('可见正文：未闭合的 DSML 残段切到结尾（模型被硬切断时的现场）', () => {
  const leaked = '好的，我来执行：\n<｜｜DSML｜｜invoke name="bash">\n<｜｜DSML｜｜parameter name="command">ls -la'
  const cleaned = stripResidualDsml(leaked)
  assert.ok(!/DSML|invoke|parameter/i.test(cleaned), `残段没切干净：${JSON.stringify(cleaned)}`)
  assert.ok(cleaned.startsWith('好的，我来执行'), '正文本身要保留')
})

test('可见正文：结尾的半截前缀也要切掉', () => {
  for (const tail of ['<｜DSML', '<｜｜DSML｜', '<|DSML']) {
    const cleaned = stripResidualDsml(`前面的话\n${tail}`)
    assert.ok(!cleaned.includes('<'), `半截前缀没切：${JSON.stringify(cleaned)}`)
  }
})

test('可见正文：完整块切掉后，**后面的正常文字必须留着**（曾误吞）', () => {
  const text =
    '引言\n<｜｜DSML｜｜invoke name="t"><｜｜DSML｜｜parameter name="a">1</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>\n结尾文字'
  const cleaned = stripResidualDsml(text)
  assert.ok(!/DSML|invoke|parameter/i.test(cleaned), `标记没清干净：${JSON.stringify(cleaned)}`)
  assert.ok(cleaned.includes('结尾文字'), `后面的正文被吞了：${JSON.stringify(cleaned)}`)
})

test('可见正文：正文里讨论 <invoke>（无前缀）不许动', () => {
  const line = '在 HTML 里 <invoke> 不是一个标准标签。'
  assert.equal(stripResidualDsml(line), line)
})

test('端到端：未闭合的 DSML 喂进流式过滤器，flush 后正文里不许出现 DSML', () => {
  const f = new ToolCallStreamFilter(TOOLS)
  const chunks = ['好的：\n', '<｜｜DSML｜｜invo', 'ke name="bash">\n', '<｜｜DSML｜｜parameter name="command">', 'ls']
  let text = ''
  for (const chunk of chunks) text += f.push(chunk).text
  text += f.flush().text
  assert.ok(!/DSML/i.test(text), `DSML 上屏了：${JSON.stringify(text)}`)
  assert.ok(!/invoke name/i.test(text), `invoke 标签上屏了：${JSON.stringify(text)}`)
})

// ── 2026-11-03：解析形态覆盖（与"另一份实现"对拍后锁定我们的口径）──────

test('DSML 形态覆盖：CDATA 解包 / arguments 包装层 / 参数值截断 / 未知工具 / 多调用', () => {
  const P = '｜'
  const wrap = (body) => `<${P}${P}DSML${P}${P}${body}>`
  const close = (name) => `</${P}${P}DSML${P}${P}${name}>`
  const one = (name, params) =>
    wrap(`invoke name="${name}"`) + params + close('invoke')

  // ① CDATA：剥掉语法包装，只留内容（不是把 <![CDATA[ 当正文）
  const cdata = one('t', wrap('parameter name="x"') + '<![CDATA[a<b&c]]>' + close('parameter'))
  assert.deepEqual(JSON.parse(parseXmlToolCalls(cdata)[0].arguments), { x: 'a<b&c' })

  // ② `parameter name="arguments"` 包装层要剥掉（否则执行器报 missing required property）
  const nested =
    one('bash', wrap('parameter name="arguments" string="false"') + '{"command":"node x.js"}' + close('parameter'))
  assert.deepEqual(JSON.parse(parseXmlToolCalls(nested)[0].arguments), { command: 'node x.js' })

  // ③ 参数值被硬切断（连 </parameter> 都没有）：仍要抢救出这个调用
  const cut = wrap('invoke name="bash"') + wrap('parameter name="command"') + 'uname -a'
  const salvaged = parseXmlToolCalls(cut)
  assert.equal(salvaged?.[0]?.name, 'bash')
  assert.deepEqual(JSON.parse(salvaged[0].arguments), { command: 'uname -a' })

  // ④ 未声明的工具名**不许过滤**（丢掉会让整轮输出变空）
  const unknown = one('not_a_real_tool', wrap('parameter name="x"') + '1' + close('parameter'))
  assert.equal(parseXmlToolCalls(unknown)?.[0]?.name, 'not_a_real_tool')

  // ⑤ 多调用顺序保持
  const many =
    wrap('calls') +
    one('a', wrap('parameter name="x"') + '1' + close('parameter')) +
    one('b', wrap('parameter name="y"') + '2' + close('parameter')) +
    close('calls')
  assert.deepEqual(
    parseXmlToolCalls(many).map((call) => call.name),
    ['a', 'b'],
  )
})

// ── 2026-11-03（审查后补）：6 处边界 ──────────────────────────

test('孤立的带前缀 </…parameter> 也要剥（旧名单只认包裹名与 invoke）', () => {
  const cleaned = stripResidualDsml('前面 </｜｜DSML｜｜parameter> 后面')
  assert.ok(!/DSML|parameter/i.test(cleaned), `没剥干净：${JSON.stringify(cleaned)}`)
  assert.ok(cleaned.includes('前面') && cleaned.includes('后面'), `正文被吃了：${JSON.stringify(cleaned)}`)
})

test('包裹名错配（tool_calls 开 / calls 闭）也当成闭合，不许把后面正文切掉', () => {
  const text =
    '前言 <｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read">p</｜｜DSML｜｜invoke></｜｜DSML｜｜calls> 后记'
  const cleaned = stripResidualDsml(text)
  assert.ok(cleaned.includes('后记'), `后面正文被切了：${JSON.stringify(cleaned)}`)
  assert.ok(!/DSML/i.test(cleaned), `标记没清：${JSON.stringify(cleaned)}`)
})

test('正文里解释 DSML（行内代码 / 围栏）不许把后面的内容切光', () => {
  const inline = 'DSML 写法示例：`<｜｜DSML｜｜invoke name="read">` 就这一句，后面是结论。'
  assert.ok(stripResidualDsml(inline).includes('后面是结论'), '行内代码把后文切了')

  const fenced = 'DSML 长这样：\n```xml\n<｜｜DSML｜｜invoke name="read">\n```\n然后是解释：这里很重要。'
  const out = stripResidualDsml(fenced)
  assert.ok(out.includes('这里很重要'), `围栏把解释切了：${JSON.stringify(out)}`)
})

test('严格路径的内文 JSON 用宽容解析（Windows 单反斜杠不许丢参数）', () => {
  const text = '<｜｜DSML｜｜invoke name="t">{"path":"D:////apps////DSH"}</｜｜DSML｜｜invoke>'
  const args = JSON.parse(parseXmlToolCalls(text)?.[0]?.arguments ?? '{}')
  assert.equal(args.path, 'D:////apps////DSH', `参数丢了：${JSON.stringify(args)}`)
})

test('抢救路径：</…parameter> 之后的正文不许塞进参数值', () => {
  const text =
    '<｜｜DSML｜｜invoke name="t"><｜｜DSML｜｜parameter name="a" string="true">x</｜｜DSML｜｜parameter>这里是正文'
  const args = JSON.parse(parseXmlToolCalls(text)?.[0]?.arguments ?? '{}')
  assert.equal(args.a, 'x', `参数值被污染：${JSON.stringify(args)}`)
})

test('半截前缀也覆盖 dsml- 变体与三四根竖线', () => {
  for (const tail of ['<dsml-', '<dsml-inv', '<｜｜｜DSML', '<|｜|DSML｜']) {
    const cleaned = stripResidualDsml(`前面\n${tail}`)
    assert.ok(!/[<｜|]/.test(cleaned.replace('前面', '')), `没切干净：${JSON.stringify(cleaned)}`)
  }
})

// ── 2026-11-03（第二轮）：中途注入 / 竖线带空格 / 块级未闭合 ────────

test('🔴 正文中途插一个 parameter 标签：标签要清掉，**两边的文字一个都不能丢**', () => {
  const f = new ToolCallStreamFilter(TOOLS)
  const out = f.push('第一段话 <｜｜DSML｜｜parameter name="a" string="true">42 第二段话')
  const tail = f.flush()
  const whole = out.text + tail.text
  assert.ok(!/DSML|parameter/i.test(whole), `标签漏上屏：${JSON.stringify(whole)}`)
  assert.ok(whole.includes('第一段话') && whole.includes('第二段话'), `文字丢了：${JSON.stringify(whole)}`)
  assert.ok(whole.includes('42'), `中间的值丢了：${JSON.stringify(whole)}`)
})

test('竖线之间带空格（<｜ ｜DSML）也要按完整标记处理', () => {
  const cleaned = stripResidualDsml('正文 <｜ ｜DSML｜｜invoke name="a">x</｜｜DSML｜｜invoke> 后文')
  assert.ok(!/DSML/i.test(cleaned), `没清掉：${JSON.stringify(cleaned)}`)
  assert.ok(cleaned.includes('正文') && cleaned.includes('后文'), `正文被吃：${JSON.stringify(cleaned)}`)
})

test('块级（invoke）未闭合仍然切到结尾（别把这条一并放过）', () => {
  const cleaned = stripResidualDsml('前言 <｜｜DSML｜｜invoke name="a">后面都属于块内')
  assert.ok(!cleaned.includes('后面都属于块内'), `块级未闭合没切：${JSON.stringify(cleaned)}`)
  assert.ok(cleaned.includes('前言'), '前言该保留')
})

test('🔴 回灌历史前剥 DSML（模型会照抄上一轮的泄漏）', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '前 <｜｜DSML｜｜invoke name="read">x</｜｜DSML｜｜invoke> 后' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const out = String(serializePrompt({ messages: msgs, tools: [] }))
  assert.ok(!/DSML/i.test(out), `历史里还有 DSML：${out.slice(0, 200)}`)
  assert.ok(out.includes('前 ') && out.includes(' 后'), '正文被吃掉了')
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
