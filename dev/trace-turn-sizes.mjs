// 13:25:54 那轮发了 49973 字符（firstDiff=17）。看它到底发了什么。
// 用会话日志重放，并把每条 entry 的长度列出来 —— 定位"大"在哪一条。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { bailIfNoSessions, listSessionDirs } from './session-locate.mjs'
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

bailIfNoSessions('这个追溯需要真机会话日志')
const dir = listSessionDirs()
  .filter((p) => p.includes(process.argv[2] ?? ' '))
  .sort()
  .pop()
if (!dir) {
  console.log('没找到含 "' + process.argv[2] + '" 的会话。')
  process.exit(0)
}
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

// 按 turn 切分，统计每轮内新增消息的体量
let turn = 0
const perTurn = new Map()
for (const e of events) {
  if (e.type === 'turn/start') {
    turn = e.data?.turn ?? turn
    if (!perTurn.has(turn)) perTurn.set(turn, [])
  }
  if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
  const m = e.data?.message ?? e.data
  if (!m?.role) continue
  const size = JSON.stringify(m).length
  perTurn.get(turn)?.push({ role: m.role, size, preview: JSON.stringify(m).slice(0, 90) })
}

for (const [t, list] of [...perTurn].sort((a, b) => a[0] - b[0])) {
  const total = list.reduce((s, x) => s + x.size, 0)
  const biggest = [...list].sort((a, b) => b.size - a.size)[0]
  console.log(`\n=== turn ${t} ===  ${list.length} 条消息，合计 ${total} 字符`)
  console.log(`  最大一条: ${biggest.role} ${biggest.size} 字符`)
  for (const m of list) {
    const flag = m.size > 5000 ? '🔴' : '  '
    console.log(`  ${flag} ${m.role.padEnd(10)} ${String(m.size).padStart(7)}  ${m.preview.slice(0, 78)}`)
  }
}
