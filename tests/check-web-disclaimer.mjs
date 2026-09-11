/**
 * 回归：网页端免责声明的流式剥离。
 *
 * 背景（2026-09-11 用户实测）：回答中间冒出「本回答由 AI 生成，内容仅供参考，请仔细甄别---」。
 * 实测确认（27 个 DSH 会话里 43 处命中）：这是 DeepSeek 网页端在**每一轮回复末尾**自动追加的，
 * 以 SSE 增量到达，甚至被拆成「 AI」「 生成」「，」「内容」这种小包。
 *
 * 为什么必须剥掉：
 *   1. 自动续写的缝正好落在它后面 → 它卡在两条回答中间上屏；
 *   2. 结尾是「甄别」（汉字、无句末标点）→ `looksMidSentence` 恒为真 →
 *      **每一轮都被误判成「句中被截」** → 无限触发续写 → 回答越来越乱。
 *
 * 用法: node tests/check-web-disclaimer.mjs
 */
import assert from 'node:assert/strict'
import {
  BoilerplateFilter,
  ToolCallStreamFilter,
  TranscriptEchoGuard,
  drainTextPipeline,
} from '../src/protocol.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const DISCLAIMER = '本回答由 AI 生成，内容仅供参考，请仔细甄别'

/** 逐包喂进过滤器，返回每次上屏的文本拼接。 */
function feed(chunks) {
  const f = new BoilerplateFilter()
  let shown = ''
  for (const c of chunks) shown += f.push(c).text
  const tail = f.flush()
  return { shown: shown + tail.text, count: f.count }
}

await test('整段声明在一包里 → 整段剥掉，其余文本一字不动', () => {
  const { shown, count } = feed([`正文第一句。\n\n${DISCLAIMER}`])
  assert.equal(shown, '正文第一句。\n\n', `实际: ${JSON.stringify(shown)}`)
  assert.equal(count, 1)
})

await test('声明被 SSE 拆成小包 → 仍然剥掉，且**过程中不上屏半截**', () => {
  const chunks = ['正文。\n\n本回答', '由 ', 'AI', ' 生成', '，', '内容', '仅供参考', '，', '请', '仔细', '甄', '别', '\n后续正文。']
  const f = new BoilerplateFilter()
  let shown = ''
  for (const c of chunks) {
    const out = f.push(c).text
    shown += out
    assert.ok(!shown.includes('本回答'), `中途泄漏了半截声明: ${JSON.stringify(shown)}`)
    assert.ok(!shown.includes('甄别'), `中途泄漏了半截声明: ${JSON.stringify(shown)}`)
  }
  shown += f.flush().text
  assert.equal(shown, '正文。\n\n\n后续正文。', `实际: ${JSON.stringify(shown)}`)
})

await test('声明被从**中间**切开（切点不在声明开头）→ 仍能整段剥掉', () => {
  // 实测漏过的形态：切点落在声明中间，前半截已经不是「声明的前缀」
  const cases = [
    ['正文。本回答由 AI 生成，内容仅供参', '考，请仔细甄别'],
    ['正文。本回答', '由 AI 生成，内容仅供参考，请仔细甄别'],
    ['正文。本', '回答由 ', 'AI 生成，内容仅供参考，请仔细甄', '别'],
  ]
  for (const chunks of cases) {
    const { shown, count } = feed(chunks)
    assert.equal(shown, '正文。', `切法 ${JSON.stringify(chunks)} → ${JSON.stringify(shown)}`)
    assert.equal(count, 1)
  }
})

await test('短于扣留窗口的文本先扣住，flush 时原样放行（不是声明就别吞）', () => {
  const f = new BoilerplateFilter()
  assert.equal(f.push('解释一下「本回答').text, '', '扣留窗口内的文本先不上屏')
  const tail = f.flush()
  assert.equal(tail.text, '解释一下「本回答', 'flush 必须把扣住的还原放行')
  assert.equal(f.count, 0, '没剥到完整声明，不该计命中')
})

await test('同一轮里出现两处声明 → 都剥掉', () => {
  const { shown, count } = feed([`A。${DISCLAIMER}B。${DISCLAIMER}`])
  assert.equal(shown, 'A。B。', `实际: ${JSON.stringify(shown)}`)
  assert.equal(count, 2)
})

await test('普通文本（含「AI 生成」字样但不是声明）不受影响', () => {
  const text = '平台要求片头标注 AI 生成标识，并留存溯源材料。'
  const { shown, count } = feed([text])
  assert.equal(shown, text)
  assert.equal(count, 0)
})

// ── 轮末尾巴：只有「整条流水线 + drainTextPipeline」才能覆盖的漏点 ──
// 事故现场（会话 6c0dbc47）：模型先吐工具调用，最后才补一句声明，
// 声明整段落在滤波器的 24 字扣留窗口里，随轮末 flush 直接上屏 → 卡在工具调用后面。

/** 跑完整流水线（三层 + 轮末收尾），返回上屏文本与工具调用数。 */
function runPipeline(chunks) {
  const filter = new ToolCallStreamFilter(new Set(['write']))
  const boilerplate = new BoilerplateFilter()
  const guard = new TranscriptEchoGuard()
  let shown = ''
  const calls = []
  for (const chunk of chunks) {
    const a = filter.push(chunk)
    const b = boilerplate.push(a.text)
    shown += guard.push(b.text).text
    calls.push(...a.calls)
  }
  const drained = drainTextPipeline(filter, boilerplate, guard)
  shown += drained.text
  calls.push(...drained.calls)
  return { shown, calls, disclaimers: drained.disclaimers }
}

await test('声明落在轮末尾巴里（工具调用之后）→ 必须剥掉，工具调用仍收全', () => {
  const { shown, calls, disclaimers } = runPipeline([
    '好，我来写文件。\n',
    '{"tool_calls":[{"name":"write","arguments":{"file_path":"snake.html"}}]}',
    DISCLAIMER,
  ])
  assert.ok(!shown.includes('本回答由'), `尾巴里的声明漏出去了: ${JSON.stringify(shown)}`)
  assert.equal(shown, '好，我来写文件。\n', `实际: ${JSON.stringify(shown)}`)
  assert.equal(calls.length, 1, '工具调用不能被一起丢掉')
  assert.equal(calls[0].name, 'write')
  assert.ok(disclaimers >= 1, '应当记一次剥离')
})

await test('声明作为整轮最后一句话（无后续文本、无换行）→ 也从尾巴剥掉', () => {
  const { shown } = runPipeline(['正文一句。\n', '最后一句没写句号', DISCLAIMER])
  assert.ok(!shown.includes('本回答由'), `实际: ${JSON.stringify(shown)}`)
  assert.equal(shown, '正文一句。\n最后一句没写句号')
})

await test('尾巴不是声明时逐字保留（扣留窗口不能吞正文）', () => {
  const { shown } = runPipeline(['正文。\n', '结尾这四个字'])
  assert.equal(shown, '正文。\n结尾这四个字')
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
