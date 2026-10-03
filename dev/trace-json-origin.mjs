// 关键问题：截图「已思考」块里那段 {"tool_calls":...} 到底是谁渲染的？
// 用证据区分两种可能：
//   (A) 我们把模型的思考原样上屏（缺陷：净化器漏了）
//   (B) 那是**模型自己**在思考里写的（DeepSeek 网页端渲染思考区，不是我们的问题）
// 判据：DSH 侧的 assistant/message 记录了 "Assistant: pwsh"（只有工具名）。
// 若我们上屏的是那段 JSON，DSH 收到的事件里就应有它 —— 逐字段扫一遍。
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
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

const dir = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(ROOT, d.name), { withFileTypes: true })
      .filter((x) => x.isDirectory() && x.name.includes(process.argv[2]))
      .map((x) => join(ROOT, d.name, x.name)),
  )[0]
const events = inflate(readFileSync(join(dir, 'session.v4.jsonl.zstd')))
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

// 逐个 assistant/message，打印它**所有**文本字段
console.log('=== 每条 assistant/message 的全部文本 ===')
let n = 0
for (const e of events) {
  if (e.type !== 'assistant/message') continue
  n++
  const m = e.data?.message ?? e.data
  const blocks = Array.isArray(m?.content) ? m.content : []
  console.log(`\n[${n}] time=${e.time} blocks=${JSON.stringify(blocks.map((b) => b?.type))}`)
  for (const b of blocks) {
    const t = typeof b?.text === 'string' ? b.text : JSON.stringify(b)
    const hasJson = /"tool_calls"/.test(t)
    console.log(`    ${hasJson ? '🔴 含 tool_calls' : '  '} ${t.slice(0, 150).replace(/\n/g, ' ')}`)
  }
}
console.log(`\nassistant/message 共 ${n} 条`)
console.log(
  events.some((e) => JSON.stringify(e).includes('"tool_calls":[{'))
    ? '🔴 DSH 侧**有** {"tool_calls": ... 原文 ⇒ 那些字符确实是我们上屏的（情况 A）'
    : '✅ DSH 侧**没有** {"tool_calls": ... 原文 ⇒ 我们上屏的只有 "pwsh"，那段 JSON 是**模型思考区自带**的（情况 B）',
)
