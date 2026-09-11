/**
 * 回归：一轮流结束时，三层缓冲的「吐净顺序」必须保持文本顺序。
 *
 * 背景（2026-09-11 用户实测）：「答案读起来是断的 / 半个词跑到下一段开头」——
 *   …互不覆盖——原来的 `pelican.svg` **保持**   ← 正文到这里就没了
 *   而下一段却以 **不动，** 开头（本该接在「保持」后面）
 *
 * 成因：文本流向是 ToolCallStreamFilter → TranscriptEchoGuard → (stripSystemMarkers) → BoilerplateFilter，
 * 每层都会扣住它收到的**尾部**。所以越深的层扣住的文本越早 —— 吐净顺序必须是流水线的**反序**
 * （boilerplate → echoGuard → filter）。按正序吐，最后几段文字就会前后颠倒。
 * 上一轮被颠倒的文本还会作为「半截回答」进续写 prompt → 越滚越乱。
 *
 * 用法: node tests/check-flush-order.mjs
 */
import assert from 'node:assert/strict'
import { BoilerplateFilter, ToolCallStreamFilter, TranscriptEchoGuard } from '../src/protocol.ts'

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

/**
 * 复刻适配器的每包流水线，并按指定顺序吐净三层缓冲。
 * 流水线：filter → boilerplate（剥声明）→ echoGuard
 * @param order 'reverse'（正确：深→浅）| 'pipeline'（错误：浅→深，即 2026-09-11 之前的写法）
 */
function replay(chunks, order) {
  const filter = new ToolCallStreamFilter()
  const boilerplate = new BoilerplateFilter()
  const guard = new TranscriptEchoGuard()
  let shown = ''
  for (const chunk of chunks) {
    const filtered = filter.push(chunk)
    const boiled = boilerplate.push(filtered.text)
    shown += guard.push(boiled.text).text
  }
  const f = filter.flush().text
  const b = boilerplate.flush().text
  const g = guard.flush().text
  const tail = order === 'reverse' ? g + b + f : f + b + g
  return { shown: shown + tail, f, g, b }
}

const CASES = [
  // 普通短尾
  ['第一段。\n', '最后一段' + '很长'.repeat(20) + '，接着写', '不动，'],
  // 尾部是网页端免责声明的前缀（会同时被三层扣住）
  ['前言。\n', '正文' + '内容'.repeat(20), '本回答由'],
  // 只有一个尾包
  ['句首。\n', '行内未完'],
  // 无尾包（全部以换行收尾）
  ['一段。\n', '两段。\n'],
]

await test('吐净顺序 = 流水线反序（深→浅）→ 输出与原文逐字一致', () => {
  for (const chunks of CASES) {
    const want = chunks.join('')
    const { shown, f, g, b } = replay(chunks, 'reverse')
    assert.equal(
      shown,
      want,
      `文本被改序：\n  期望 ${JSON.stringify(want)}\n  实际 ${JSON.stringify(shown)}\n` +
        `  (filter=${JSON.stringify(f)} guard=${JSON.stringify(g)} boilerplate=${JSON.stringify(b)})`,
    )
  }
})

await test('按流水线正序吐（旧写法）→ 有尾包时必然错位 —— 这就是事故现场', () => {
  const chunks = CASES[0]
  const want = chunks.join('')
  const { shown, f, b, g } = replay(chunks, 'pipeline')
  assert.ok(f.length > 0 && g.length > 0, '两层都应扣着文字，才构成错位条件')
  assert.notEqual(shown, want, '旧顺序应当复现错位（若这里相等，说明用例没触发到 bug）')
  // 错位形态：最新尾巴（filter）被吐在更早的正文（boilerplate/guard）前面
  assert.ok(
    shown.endsWith(f + b + g),
    `错位形态不符：\n  shown 尾 ${JSON.stringify(shown.slice(-90))}\n  期望尾 ${JSON.stringify(f + b + g)}`,
  )
})

await test('没有尾包时两种顺序等价 —— 修完不影响常规路径', () => {
  const chunks = CASES[3]
  const want = chunks.join('')
  assert.equal(replay(chunks, 'reverse').shown, want)
  assert.equal(replay(chunks, 'pipeline').shown, want)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
