// 统计某个会话里到底累积了多少「图片内容条目」。
//
// 存在的理由（2026-09-21 用户实测）：插件提示「本轮只带了最近 24 张图片，更早的 14 张未发送」，
// 用户反问"我顶多发了 6 张图" —— 数字本身没错（历史上确实有 40 份不同的图片内容），
// 错的是用「张」这个量词去描述「内容条目」。以后再遇到同类质疑，跑这个脚本就能数出来。
//
// 用法：
//   node tests/count-session-images.mjs                # 自动挑最近更新的会话
//   node tests/count-session-images.mjs <xxx.zstd>     # 指定会话文件
//
// ⚠️ `session.v3.jsonl.zstd` 是**多帧 zstd**：`zstdDecompressSync()` 与 `createZstdDecompress()`
// 都**只解第一帧**（只出 231 字节 ＝ session 头），极易误判成"这个会话没图片"或"文件坏了"。
// 必须按魔数 `28 B5 2F FD` 切帧、逐帧解，解不出来的段当假阳性跳过。
import z from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function findLatestSession() {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  let best
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const sid of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, sid, 'session.v3.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const at = fs.statSync(file).mtimeMs
      if (!best || at > best.at) best = { file, at, ws, sid }
    }
  }
  return best
}

function decompressAllFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const parts = []
  let ok = 0
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      parts.push(z.zstdDecompressSync(seg))
      ok += 1
    } catch {
      /* 假阳性魔数 */
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length, decoded: ok }
}

const target = process.argv[2] ? { file: path.resolve(process.argv[2]) } : findLatestSession()
if (!target) {
  console.error('没找到会话文件（~/.dsh/sessions/*/*/session.v3.jsonl.zstd）')
  process.exit(1)
}

const buf = fs.readFileSync(target.file)
const { text, frames, decoded } = decompressAllFrames(buf)
const lines = text.split('\n').filter((l) => l.trim())
console.log(`会话：${target.file}`)
console.log(`文件 ${buf.length} 字节 → 疑似帧 ${frames} 个 / 解出 ${decoded} 帧 / ${text.length} 字节 / ${lines.length} 行`)

const ids = new Map()
let blocks = 0
const collect = (v) => {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) {
    for (const item of v) collect(item)
    return
  }
  if (v.type === 'image') {
    blocks += 1
    const att = v.attachment ?? {}
    const id = String(att.attachmentId ?? '(无)')
    const rec = ids.get(id) ?? { n: 0, names: new Set() }
    rec.n += 1
    if (att.name) rec.names.add(String(att.name).slice(0, 72))
    ids.set(id, rec)
  }
  for (const key of Object.keys(v)) collect(v[key])
}
for (const line of lines) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    continue
  }
  collect(obj)
}

console.log(`\nimage 块出现次数：${blocks}`)
console.log(`唯一 attachmentId 数（＝插件提示里那个"内容条目"数）：${ids.size}`)
console.log('\n明细（下划线开头的多为模型自己 read_image 读进来的局部校验片段）：')
let i = 0
for (const [id, rec] of ids) {
  i += 1
  const names = [...rec.names].join(' | ') || '(无 name)'
  console.log(`  ${String(i).padStart(2)}. ${id.slice(0, 30)}… ×${rec.n}  ${names}`)
}
