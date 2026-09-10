#!/usr/bin/env node
/**
 * DSH 会话日志诊断工具。
 *
 * 用途：当出现「回复异常」时（被截断、只剩碎片、工具调用泄漏成正文、莫名重试），
 * 直接从 DSH 的会话日志里读出**每一轮的原始事实**：用了哪个模型、模型消息里有哪些
 * 内容块（长度/首尾）、结束原因、以及流式分块的类型与字节数。
 *
 * 用法：
 *   node tools/inspect-session.mjs                      # 列出所有会话（时间/大小/消息数）
 *   node tools/inspect-session.mjs <会话ID前缀>          # 诊断该会话的每一轮
 *   node tools/inspect-session.mjs --search "关键词"     # 按关键词找会话（可多个关键词，逗号分隔）
 *   node tools/inspect-session.mjs <ID前缀> --blocks    # 额外打印内容块的真实事件（原始 JSON 片段）
 *
 * 会话目录：`${DSH_HOME:-~/.dsh}/sessions/<workspace>/session-<id>/session.jsonl.zstd`
 *
 * ⚠️ 实现要点（踩坑）：该日志是**逐条追加的独立 zstd 帧**拼接而成（一个几 MB 的文件里可能有上万个帧头），
 * `zlib.zstdDecompressSync` 与流式解压都只返回第一帧（约 200 字节的会话头）。
 * 因此必须按帧头 magic (0x28 0xB5 0x2F 0xFD) 切分、逐帧解压后拼接 —— 见 inflate()。
 *
 * 隐私：本脚本只读本机会话日志，不联网、不上传任何内容。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSION_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解压「多帧拼接」的 zstd 日志。 */
function inflate(buffer) {
  const offsets = []
  let index = -1
  while ((index = buffer.indexOf(ZSTD_MAGIC, index + 1)) !== -1) offsets.push(index)
  if (offsets.length === 0) return zlib.zstdDecompressSync(buffer).toString('utf8')
  const chunks = []
  for (let i = 0; i < offsets.length; i++) {
    const end = offsets[i + 1] ?? buffer.length
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {
      // magic 可能出现在压缩数据内部：与下一帧合并重试
      const nextEnd = offsets[i + 2] ?? buffer.length
      try {
        chunks.push(zlib.zstdDecompressSync(buffer.subarray(offsets[i], nextEnd)))
        i += 1
      } catch {
        /* 跳过该帧 */
      }
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function* sessionLogs(dir = SESSION_ROOT) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sessionLogs(full)
    else if (entry.name === 'session.jsonl.zstd' || entry.name === 'session.jsonl') yield full
  }
}

function readEvents(file) {
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd') ? inflate(raw) : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

const idOf = (file) => /session-([0-9a-f-]+)/.exec(file)?.[1] ?? file
const shortId = (file) => idOf(file).slice(0, 8)
const clock = (time) => new Date(time ?? 0).toISOString().slice(11, 19)

function blocksSummary(content, preview = 60) {
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return String(block)
      if (typeof block.text === 'string') {
        return `${block.type}(len=${block.text.length}) head=${JSON.stringify(block.text.slice(0, preview))} tail=${JSON.stringify(block.text.slice(-preview))}`
      }
      if (block.type === 'tool-call') return `tool-call(${block.name}) args=${String(block.arguments).slice(0, 80)}`
      if (block.type === 'tool-result') return `tool-result(${(block.content ?? []).length} blocks)`
      return String(block.type)
    })
    .join('\n        ')
}

function diagnose(file, showBlocks) {
  const events = readEvents(file)
  const stat = statSync(file)
  console.log(`=== ${shortId(file)}  ${stat.mtime.toISOString()}  ${(stat.size / 1024).toFixed(1)}KB(zstd)  事件 ${events.length} ===\n`)

  const chunkStats = new Map()
  for (const event of events) {
    const { type, data, time } = event
    if (!data) continue
    const at = clock(time)
    if (type === 'turn/start') console.log(`\n━━━ turn ${data.turn} ━━━`)
    else if (type === 'request/context') console.log(`[${at}] 模型: ${data.provider}/${data.model}  ctx=${data.contextWindow}`)
    else if (type === 'request/header') {
      const config = data.header?.config ?? {}
      console.log(`[${at}] 请求配置: ${JSON.stringify(config)}  adapterDefaults=${JSON.stringify(data.header?.adapterDefaults ?? {})}`)
    } else if (type === 'user/message') {
      const text = (data.content ?? []).map((b) => b.text ?? `<${b.type}>`).join('')
      if (text.trim()) console.log(`[${at}] 用户: ${JSON.stringify(text.slice(0, 90))}`)
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk ?? {}
      const key = `${data.turn}/${data.step}`
      const entry = chunkStats.get(key) ?? { kinds: new Map(), textChars: 0 }
      const kind = entry.kinds.get(chunk.type) ?? { count: 0, chars: 0 }
      kind.count += 1
      if (typeof chunk.text === 'string') kind.chars += chunk.text.length
      if (typeof chunk.argumentsDelta === 'string') kind.chars += chunk.argumentsDelta.length
      entry.kinds.set(chunk.type, kind)
      entry.textChars += typeof chunk.text === 'string' ? chunk.text.length : 0
      chunkStats.set(key, entry)
    } else if (type === 'text-chunks') {
      // DSH 会把这些增量合并记录：texts 是分块原文，dt 是与前一块的间隔(ms)
      console.log(`[${at}] 分块原文(文本): ${JSON.stringify(data.texts ?? []).slice(0, 300)}`)
    } else if (type === 'assistant/message') {
      const content = data.message?.content ?? data.content ?? []
      console.log(`[${at}] 助手消息（${content.length} 块）:\n        ${blocksSummary(content)}`)
      if (showBlocks) console.log(`        原始: ${JSON.stringify(data).slice(0, 600)}`)
    } else if (type === 'step/end') {
      console.log(`[${at}] step 结束: ${JSON.stringify(data).slice(0, 200)}`)
    } else if (type === 'turn/end') {
      console.log(`[${at}] turn 结束: ${JSON.stringify(data).slice(0, 200)}`)
    } else if (type === 'tool/call') {
      console.log(`[${at}] 工具调用: ${data.name ?? data.call?.name} args=${String(JSON.stringify(data.arguments ?? data.call?.arguments ?? '')).slice(0, 90)}`)
    } else if (type === 'tool/result') {
      console.log(`[${at}] 工具结果: ${String(JSON.stringify(data)).slice(0, 120)}`)
    } else if (type === 'error' || type === 'session/error') {
      console.log(`[${at}] ❌ 错误: ${JSON.stringify(data).slice(0, 300)}`)
    }
  }

  if (chunkStats.size > 0) {
    console.log('\n=== 流式分块统计（每 turn/step）===')
    for (const [key, entry] of chunkStats) {
      const kinds = [...entry.kinds.entries()].map(([k, v]) => `${k}×${v.count}(text ${v.chars}B)`).join('  ')
      const warn = entry.kinds.has('usage') && entry.kinds.get('usage').count > 1 ? '   ⚠ usage 出现多次 → 大概率发生了重试' : ''
      console.log(`  ${key}: ${kinds}${warn}`)
    }
    console.log('\n提示：若「助手消息」的文本长度远小于分块字节数，或文本里出现 {"tool_calls":…} / <tool_calls>，')
    console.log('      说明问题出在适配器的流式解析层；若 usage/finish 出现多次，说明触发了重试。')
  }
}

function search(keywords) {
  for (const file of sessionLogs()) {
    let events
    try {
      events = readEvents(file)
    } catch (error) {
      console.error(`  ! 读取失败 ${file}: ${error.message}`)
      continue
    }
    const text = JSON.stringify(events)
    const hits = keywords.filter((keyword) => text.includes(keyword))
    if (hits.length === 0) continue
    const stat = statSync(file)
    console.log(`${shortId(file)}  ${stat.mtime.toISOString()}  ${(stat.size / 1024).toFixed(1)}KB  命中: ${hits.join(', ')}`)
  }
}

function list() {
  const rows = []
  for (const file of sessionLogs()) {
    let events = []
    try {
      events = readEvents(file)
    } catch {}
    const titles = events.filter((e) => e.type === 'session/title').map((e) => e.data?.title).filter(Boolean)
    rows.push({ id: shortId(file), mtime: statSync(file).mtime, size: statSync(file).size, count: events.length, title: titles.at(-1) ?? '' })
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.id}  ${row.mtime.toISOString()}  ${(row.size / 1024).toFixed(1).padStart(8)}KB  事件 ${String(row.count).padStart(6)}  ${row.title}`)
  }
}

// ── CLI ──
const args = process.argv.slice(2)
if (!existsSync(SESSION_ROOT)) {
  console.error(`找不到会话目录：${SESSION_ROOT}（可通过 DSH_HOME 指定 DSH 主目录）`)
  process.exit(1)
}
const searchArg = args.indexOf('--search')
if (searchArg !== -1) {
  const keywords = (args[searchArg + 1] ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (keywords.length === 0) {
    console.error('用法: node tools/inspect-session.mjs --search "关键词1,关键词2"')
    process.exit(1)
  }
  search(keywords)
} else if (args[0] && !args[0].startsWith('--')) {
  const prefix = args[0]
  let found = false
  for (const file of sessionLogs()) {
    if (!file.includes(prefix)) continue
    found = true
    diagnose(file, args.includes('--blocks'))
  }
  if (!found) {
    console.error(`没有匹配 "${prefix}" 的会话。先不带参数运行以列出会话 ID。`)
    process.exit(1)
  }
} else {
  list()
}
