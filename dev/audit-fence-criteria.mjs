// 0.6.38 判据的自我审查：用**真机日志里的原文**而不是我想象的形态来测。
// 目的：找出我自己判据里"只在想象形态成立、在真机形态失效"的地方。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { ToolCallStreamFilter, stripStrayToolMarkup, ReasoningSanitizer } from '../src/protocol.ts'
import { bailIfNoSessions } from './session-locate.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function inflate(buf) {
  const offs = []
  let i = -1
  while ((i = buf.indexOf(MAGIC, i + 1)) !== -1) offs.push(i)
  const out = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'))
    } catch {}
  }
  return out.join('')
}

// 扫今天所有会话，把**模型真实发出过的** assistant 文本块全收集起来
// 🔴 没有真机数据时优雅退出（批跑注入临时 DSH_HOME，见 `dev/session-locate.mjs`）
const dirs = bailIfNoSessions('判据审查需要真机会话日志')


const texts = []
let sessions = 0
for (const dir of dirs) {
  const f = join(dir, 'session.v4.jsonl.zstd')
  let raw
  try {
    raw = readFileSync(f)
  } catch {
    continue
  }
  let content
  try {
    content = inflate(raw)
  } catch {
    continue
  }
  if (!content.includes('tool_calls')) continue
  sessions++
  for (const line of content.split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'assistant/message') continue
    const m = e.data?.message ?? e.data
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (typeof b?.text === 'string' && b.text) texts.push({ text: b.text, kind: b.type })
    }
  }
}

console.log(`扫了 ${sessions} 个含 tool_calls 的会话，收集到 ${texts.length} 个 assistant 文本块\n`)

// 关键检查 1：真机文本里**我们自己合成**的内容，会不会又被判成残留剥掉？
// 这正是 0.6.38 最容易伤人的地方：用户答案里写 ``` 或 <calls> 时会被误吞。
const SUSPICIOUS = [
  { re: /```/, name: '含围栏' },
  { re: /<\/?\s*(calls|tool_calls|invoke|parameter|tool_call|function_calls)\b/i, name: '含标记类标签' },
  { re: /DSML/i, name: '含 DSML 字面' },
  { re: /\btool_calls\b/, name: '含 tool_calls 字面' },
]

const risky = []
for (const t of texts) {
  const hits = SUSPICIOUS.filter((s) => s.re.test(t.text)).map((s) => s.name)
  if (hits.length) risky.push({ ...t, hits })
}

console.log(`=== 真机文本里有"会被我们判成残留"的：${risky.length} / ${texts.length} ===`)
const byName = {}
for (const r of risky) for (const h of r.hits) byName[h] = (byName[h] || 0) + 1
for (const [k, v] of Object.entries(byName)) console.log(`  ${k}: ${v}`)

if (risky.length) {
  console.log('\n--- 逐条看剥除前后（这些是最可能误伤的）---')
  for (const r of risky.slice(0, 8)) {
    const after = stripStrayToolMarkup(r.text)
    const changed = after !== r.text
    console.log(`\n[${r.kind}] 命中=${r.hits.join('/')} 剥除改变=${changed ? '🔴 是' : '✅ 否'}`)
    console.log('  前: ' + JSON.stringify(r.text.slice(0, 160)))
    if (changed) console.log('  后: ' + JSON.stringify(after.slice(0, 160)))
  }
}

// 关键检查 2：真机文本里**带 fence 的调用**长什么样（0.6.38 之后模型若照做）
console.log('\n=== 真机里有没有"围栏包裹的调用"（0.6.38 之后模型若照做的形态）===')
const fencedCalls = texts.filter((t) => /```[a-zA-Z0-9_-]*\s*\n?\s*\{/.test(t.text))
console.log('  命中:', fencedCalls.length)
for (const f of fencedCalls.slice(0, 3)) console.log('  ' + JSON.stringify(f.text.slice(0, 120)))
