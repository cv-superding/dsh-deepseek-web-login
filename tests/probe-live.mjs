/**
 * 线上直连探针（开发用）：不经过 DSH 运行时，直接用插件源码模块调网页端完成接口，
 * 打印原始事件流与关键时间点，用于验证：
 *   - SSE 两种格式的事件形态
 *   - 长回答是否被服务端 60s 超时截断（completion_request_timeout_ms=60000）
 *   - 是否出现显式 status FINISHED（决定 finish 归一策略）
 *
 * 用法：node tests/probe-live.mjs ["自定义提示词"] [modelType] [thinking]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { streamWebCompletion } from '../src/webapi.ts'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const auth = JSON.parse(readFileSync(join(home, 'web-login', 'deepseek-auth.json'), 'utf8'))

const rawPrompt = process.argv[2] || '请写一篇 3000 字的中文散文，主题是雨夜的城市。'
// --big=N：生成 N 字符的填充上文，用于验证长 prompt（agent 会话常见量级）是否被接受
const bigMatch = /^--big=(\d+)$/.exec(rawPrompt)
const prompt = bigMatch
  ? `${'这是一段用于占位的上下文文本，用来验证长 prompt 是否被网页端接受。'.repeat(Math.ceil(Number(bigMatch[1]) / 26))}\n\n请用一句话回答：以上内容是什么语言？`
  : rawPrompt
const modelType = process.argv[3] || 'default'
const thinking = process.argv[4] === 'true'

const started = Date.now()
let firstByte = null
const counts = { thinking: 0, text: 0, status: [], finish: null, error: null }
const statuses = []
let textLen = 0

console.log(`[probe] prompt=${prompt.slice(0, 40)}… modelType=${modelType} thinking=${thinking}`)

try {
  for await (const event of streamWebCompletion(auth, {
    prompt,
    thinkingEnabled: thinking,
    modelType,
    idleTimeoutMs: 180_000,
  })) {
    const at = Date.now() - started
    if (firstByte === null && (event.kind === 'text' || event.kind === 'thinking')) firstByte = at
    if (event.kind === 'thinking') counts.thinking += event.text.length
    else if (event.kind === 'text') {
      counts.text += event.text.length
      textLen += event.text.length
    } else if (event.kind === 'status') {
      statuses.push(`${event.value}@${at}ms`)
    } else if (event.kind === 'finish') {
      counts.finish = { reason: event.reason, atMs: at }
    } else if (event.kind === 'error') {
      counts.error = { message: event.message, raw: event.raw, atMs: at }
    }
  }
} catch (error) {
  counts.error = { thrown: String(error?.message ?? error), code: error?.code }
}

console.log(
  JSON.stringify(
    {
      totalMs: Date.now() - started,
      firstTokenMs: firstByte,
      thinkingChars: counts.thinking,
      textChars: counts.text,
      statuses,
      finish: counts.finish,
      error: counts.error,
      explicitFinished: statuses.some((s) => s.startsWith('FINISHED')),
    },
    null,
    2,
  ),
)
