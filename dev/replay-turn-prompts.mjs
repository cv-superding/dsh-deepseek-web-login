import { listSessionDirs } from './session-locate.mjs'
/**
 * 一次性诊断：把某个 DSH 会话**每一轮真实发出去的提示词**重放出来，并给出结构统计。
 *
 * 目的：回答"提示词里到底有没有模型的旧回答" —— 这个问题的答案不该靠读分享页去估。
 *   Assistant > 0 ⇒ 把模型自己说过的话又发了一遍（那是缺陷）
 *   [Tool Result > 0 ⇒ 工具返回（那是**正常且必要**的：模型调用工具，结果必须回灌）
 *
 * 用法: node dev/replay-turn-prompts.mjs <会话ID前缀>
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const { serializePromptParts } = await import('../src/protocol.ts')

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function inflate(buffer) {
  const offsets = []
  let index = -1
  while ((index = buffer.indexOf(MAGIC, index + 1)) !== -1) offsets.push(index)
  const chunks = []
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8'))
    } catch {
      /* 单帧坏掉不影响其它帧 */
    }
  }
  return chunks.join('')
}

const prefix = process.argv[2]
if (!prefix) {
  // 🔴 批跑（`scripts/test-offline.mjs` 注入临时 DSH_HOME，CI 跑的也是批）不会传参数。
  // 原来这里 `exit(2)` ⇒ 健康检查判为"探针起不来"（误报）。改成正常退出并说明原因。
  if (!listSessionDirs().length) {
    console.log('跳过：需要一个真机会话 ID 前缀，且当前环境没有真机会话（沙箱属正常）。')
    process.exit(0)
  }
  console.error('用法: node dev/replay-turn-prompts.mjs <会话ID前缀>')
  process.exit(2)
}
const workspaces = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
const dir = workspaces
  .flatMap((d) =>
    readdirSync(join(ROOT, d.name), { withFileTypes: true })
      .filter((x) => x.isDirectory() && x.name.includes(prefix))
      .map((x) => join(ROOT, d.name, x.name)),
  )[0]
if (!dir) {
  console.error(`找不到会话 ${prefix}`)
  process.exit(2)
}

const events = inflate(readFileSync(join(dir, 'session.v4.jsonl.zstd')))
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const messages = []
let turn = 0
for (const event of events) {
  if (event.type === 'turn/start') turn = event.data?.turn ?? turn
  if (['user/message', 'assistant/message', 'tool/result'].includes(event.type)) {
    const message = event.data?.message ?? event.data
    if (message?.role) messages.push(message)
  }
  if (event.type !== 'turn/end') continue

  const parts = serializePromptParts({
    system: '（此处的系统提示不重放，只重放历史）',
    messages: messages.map((m) => ({ role: m.role, content: m.content ?? [] })),
    tools: [],
    maxChars: 400_000,
  })
  const count = (re) => (parts.transcript.match(re) ?? []).length
  console.log(`\n=== 第 ${turn} 轮（历史 ${messages.length} 条消息）===`)
  console.log(
    `  字符数 ${parts.full.length}（固定头 ${parts.head.length} + 历史 ${parts.transcript.length}）`,
  )
  console.log(
    `  结构  User=${count(/^User: /gm)}  Assistant=${count(/^Assistant: /gm)}  ` +
      `[Tool Result=${count(/^\[Tool Result/gm)}  [System]=${count(/^\[System\]/gm)}`,
  )
  for (const line of parts.transcript.split('\n')) {
    if (/^(User|Assistant|\[Tool Result|\[System\])/.test(line)) console.log('    | ' + line.slice(0, 76))
  }
}
