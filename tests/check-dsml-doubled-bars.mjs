/**
 * 回归：DSML 前缀写成**重复全角竖线**时必须仍被识别（2026-09-10 实测泄漏）。
 *
 * 事故：模型把标记写成「小于号 + 双全角竖线 + DSML + 双全角竖线 + 空格 + 退化包裹名 calls」，
 * 而旧正则只容忍单个竖线 → 吃掉一个竖线后就要求紧跟 DSML，却撞上第二个 → 标记认不出来
 * → 不进捕获态 → 原样进正文 → Web GUI 把命令里的美元符号对当 KaTeX 渲染 → 用户看到
 * 「一个字符一行」的乱码。本用例钉住：双全角竖线 + 退化包裹名 + 参数带额外属性。
 *
 * 用法: node tests/check-dsml-doubled-bars.mjs
 */
import assert from 'node:assert/strict'
import { ToolCallStreamFilter, parseXmlToolCalls } from '../src/protocol.ts'

// 标签字符串全部由片段拼出来，避免源码里出现完整的标签序列
const BAR = '\uFF5C' // 全角竖线
const P = `${BAR}${BAR}DSML${BAR}${BAR}` // 双全角竖线的 DSML 前缀体
const LT = String.fromCharCode(60) // 小于号
const GT = String.fromCharCode(62) // 大于号
const END = LT + '/' // 收尾标签起始
const WRAP = 'calls' // 实测退化的包裹名
const INV = 'invoke'
const PARAM = 'parameter'
const CMD = 'Get-Content F:/logs/x.log -Tail 5'

const payload = [
  `${LT}${P} ${WRAP}${GT}`,
  `${LT}${P} ${INV} name="pwsh"${GT}`,
  `${LT}${P} ${PARAM} name="command" string="true"${GT}${CMD}${END}${P} ${PARAM}${GT}`,
  `${END}${P} ${INV}${GT}`,
  `${END}${P} ${WRAP}${GT}`,
].join('\n')

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

test('parseXmlToolCalls 认得双全角竖线的 DSML 前缀', () => {
  const calls = parseXmlToolCalls(payload)
  assert.ok(calls, '应解析出调用，实际 null')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'pwsh')
  assert.equal(JSON.parse(calls[0].arguments).command, CMD)
})

test('流式整段：调用出、正文零泄漏', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  const out = filter.push(payload)
  const tail = filter.flush()
  const text = out.text + tail.text
  const calls = [...out.calls, ...tail.calls]
  assert.equal(calls.length, 1)
  assert.equal(text, '', `正文不应有任何残留，实际: ${JSON.stringify(text.slice(0, 200))}`)
})

test('流式逐字符：调用出、正文零泄漏', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  let text = ''
  const calls = []
  for (const ch of payload) {
    const out = filter.push(ch)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = filter.flush()
  text += tail.text
  calls.push(...tail.calls)
  assert.equal(calls.length, 1)
  assert.equal(text, '', `正文不应有任何残留，实际: ${JSON.stringify(text.slice(0, 200))}`)
})

test('半角重复竖线同样认得', () => {
  const half = payload.replaceAll(`${BAR}${BAR}`, '||')
  const calls = parseXmlToolCalls(half)
  assert.ok(calls, '应解析出调用，实际 null')
  assert.equal(JSON.parse(calls[0].arguments).command, CMD)
})

test('单竖线经典写法不被回归破坏', () => {
  const single = payload.replaceAll(`${BAR}${BAR}`, BAR)
  const calls = parseXmlToolCalls(single)
  assert.ok(calls, '应解析出调用，实际 null')
  assert.equal(calls[0].name, 'pwsh')
})

test('正文提及标记时不吞正文', () => {
  const filter = new ToolCallStreamFilter(new Set(['pwsh']))
  const out = filter.push('协议禁止使用标记，例如 DSML 前缀这种写法。')
  const tail = filter.flush()
  assert.equal(out.calls.length + tail.calls.length, 0)
  assert.ok((out.text + tail.text).includes('协议禁止使用标记'))
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
