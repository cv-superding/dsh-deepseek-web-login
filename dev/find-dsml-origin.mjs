// 定位 DSML 出现在 assistant 消息的哪个字段/哪个块 —— 决定该修哪条路。
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

const prefix = process.argv[2]
const ws = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
const dir = ws
  .flatMap((d) =>
    readdirSync(join(ROOT, d.name), { withFileTypes: true })
      .filter((x) => x.isDirectory() && x.name.includes(prefix))
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

console.log('=== 事件类型 ===')
const counts = {}
for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(26), v)

console.log('\n=== 含 DSML / ｜｜ 的事件（逐个字段定位）===')
// 深度遍历，报告"路径 → 命中"
function walk(node, path, hits) {
  if (typeof node === 'string') {
    if (/DSML|｜｜/.test(node)) hits.push({ path, sample: node.slice(0, 120) })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, hits))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, hits)
  }
}
let n = 0
for (const e of events) {
  const hits = []
  walk(e, '', hits)
  if (!hits.length) continue
  n++
  console.log(`\n--- 事件 #${n}  type=${e.type}  time=${e.time ?? '?'}`)
  for (const h of hits) {
    console.log(`    路径: ${h.path || '(根)'}`)
    console.log(`    内容: ${JSON.stringify(h.sample)}`)
  }
  if (n >= 6) {
    console.log('\n(只列前 6 个含 DSML 的事件)')
    break
  }
}
if (!n) console.log('(没有任何事件含 DSML / ｜｜ ⇒ 泄漏不是 DSH 侧记录的内容)')
