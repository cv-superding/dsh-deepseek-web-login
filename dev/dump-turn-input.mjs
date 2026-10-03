#!/usr/bin/env node
import { listSessionDirs } from './session-locate.mjs'
/**
 * 一次性诊断：把某个会话里「每一轮发给模型的消息序列」原样打出来，
 * 用来回答「链式的严格前缀判据到底在哪一步被打破」。
 *
 * 用法: node dev/dump-turn-input.mjs <会话ID前缀>
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSION_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
      const nextEnd = offsets[i + 2] ?? buffer.length
      try {
        chunks.push(zlib.zstdDecompressSync(buffer.subarray(offsets[i], nextEnd)))
        i += 1
      } catch {}
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
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name) || entry.name === 'session.jsonl') yield full
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

const prefix = process.argv[2]
if (!prefix) {
  // 🔴 同 replay-turn-prompts：批跑不传参数，`exit(1)` 会被健康检查判成"探针起不来"（误报）。
  if (!listSessionDirs().length) {
    console.log('跳过：需要一个真机会话 ID 前缀，且当前环境没有真机会话（沙箱属正常）。')
    process.exit(0)
  }
  console.error('用法: node dev/dump-turn-input.mjs <会话ID前缀>')
  process.exit(1)
}

let target
for (const file of sessionLogs()) {
  if (file.includes(prefix)) target = file
}
if (!target) {
  console.error('没找到匹配的会话文件')
  process.exit(1)
}

const events = readEvents(target)
const clock = (t) => new Date(t ?? 0).toISOString().slice(11, 19)

/** 把一条 message 渲染成「相当于 adapter 会写进 entries 的那一行」。 */
function renderAsEntry(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  const role = message?.role
  if (role === 'assistant') {
    const calls = blocks.filter((b) => b?.type === 'tool-call')
    if (calls.length) return `Assistant: ${calls.map((c) => c.name ?? 'call').join(',')}`
    return `Assistant: ${text}`
  }
  if (role === 'user') {
    const results = blocks.filter((b) => b?.type === 'tool-result')
    const parts = []
    if (text.trim()) parts.push(`User: ${text}`)
    for (const r of results) parts.push(`[Tool Result for ${r.toolCallId ?? ''}]`)
    return parts.join(' | ')
  }
  return `${role}: ${text}`
}

let lastTurn, lastStep
for (const event of events) {
  const { type, data, time } = event
  if (type === 'tool/result' || type === 'tool/call') {
    // 🔴 2026-10-02：这里原先**没有这个分支**，于是"工具返回"在整个 dump 里看不见 ——
    // 我据此得出"DSH 的消息列表里根本没有工具返回"的**错误结论**，白绕了一圈。
    // 真机上工具返回就是这个事件：`message.role = "tool"`，带 `toolCallId` 与 `content`。
    const msg = data?.message ?? data
    const blocks = (msg?.content ?? []).map((b) => b?.type).filter(Boolean)
    console.log(`\n[${clock(time)}] ${type}  role=${msg?.role ?? '?'} 类型块=${JSON.stringify(blocks)}`)
    console.log(`    toolCallId=${msg?.toolCallId ?? '(无)'} isError=${msg?.isError ?? false}`)
    console.log(`    → 内容(前160): ${JSON.stringify(String(renderAsEntry(msg)).slice(0, 160))}`)
  } else if (type === 'user/message') {
    const msg = data?.message ?? data
    const role = msg?.role ?? 'user'
    const rendered = renderAsEntry({ role, content: msg?.content ?? data?.content })
    const blocks = (msg?.content ?? data?.content ?? []).map((b) => b?.type).filter(Boolean)
    console.log(`\n[${clock(time)}] user/message  类型块=${JSON.stringify(blocks)}`)
    console.log(`    → entries 行(前160): ${JSON.stringify(String(rendered).slice(0, 160))}`)
  } else if (type === 'assistant/message') {
    const msg = data?.message ?? data
    const rendered = renderAsEntry(msg)
    console.log(`\n[${clock(time)}] assistant/message`)
    console.log(`    → entries 行(前160): ${JSON.stringify(String(rendered).slice(0, 160))}`)
  } else if (type === 'turn/start') {
    console.log(`\n━━━━━━━━━━━━ turn ${data?.turn} ━━━━━━━━━━━━`)
  } else if (type === 'request/header') {
    console.log(`[${clock(time)}] request/header 原始: ${JSON.stringify(data).slice(0, 700)}`)
  } else if (type === 'step/end') {
    console.log(`[${clock(time)}] step/end ${JSON.stringify(data).slice(0, 120)}`)
  }
}
