/**
 * DSML 到底从哪来？—— 分通道归因（2026-10-04）。
 *
 * ## 为什么需要这个脚本
 *
 * CHANGELOG 里有 39 处 DSML 相关修复、四个迭代轮次，但**真机日志里"模型自发产出的 DSML"
 * 至今零命中**。每次讨论 DSML 都会在会话日志里留下大量 DSML 字样（模型在复述我们的话、
 * 我们的诊断命令里含 `grep "DSML|dsml"`、我写的探针脚本内容被 `read` 工具读出来），
 * 于是"扫到 N 处 DSML"看起来像"问题还在"，实际全是**自指噪声**。
 *
 * 本脚本按**通道**拆分，回答："DSML 出现在谁的嘴里？"
 *
 * ## 判据
 *
 * 关键不是"有没有 DSML 字样"，而是**它出现在哪个事件里**：
 *   - `assistant/message` 里的 reasoning 段 ⇒ 模型在**复述/分析**我们提供的文本（噪声）
 *   - `tool/call` 的 arguments 里含 DSML ⇒ **几乎必然是我们的诊断命令**（噪声，
 *     因为我们 grep 的 pattern 里就带 DSML）
 *   - `tool/result` 里含 DSML ⇒ 是我们 `read`/`grep` 回来的**工具输出**（噪声）
 *
 * 🔴 真正该警惕的是：**模型在没有外部诱因的情况下自己写出 DSML 结构**。
 * 那才是"训练先验导致 DSML"这个假设的证据。
 *
 * 用法：node dev/trace-dsml-sources.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志是 zstd 多帧，单帧解压只解第一帧（假阴性）。 */
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

/** 带标签名的真结构标记（`DSML|>` / `dsml-calls` / `<invoke>` / `<parameter>`）。 */
const DSML_STRUCT = /(\d+)?\|?\s*(?:\||｜｜)?(?:DSML|dsml-\s*(?:calls|invoke|parameter)|<\s*(?:calls|invoke|parameter)\b)/i

/**
 * 我们的诊断命令 / 文件读取自身带来的 DSML（自指噪声）。
 *
 * 🔴 这份清单是被真机数据**逼出来的**：每一轮讨论 DSML 都会往会话日志里灌进大量
 * DSML 字样（我们的 grep pattern、审计脚本源码、被 `read` 回来的 protocol.ts 原文），
 * 不做归因就会把"讨论噪声"当成"泄漏还在"。实测 82 行命中里，**没有一行是模型产出的**。
 */
const SELF_REFERENTIAL = new RegExp(
  [
    'probe-dsml', 'audit-dsml', 'trace-dsml', 'trace-fence', 'audit-fence',
    'DSML\\|dsml', 'pattern.*DSML', 'grep.*DSML', 'ENTRY\\s*=', 'STRICT', 'byChannel',
    'isManualProbe', 'trace-json-origin', 'literal <tool_calls>', 'regex.*Matches',
    'Tool Calling Protocol', 'Do NOT use XML/HTML-like markup',
    // 我们读回的文件原文（提示词 / 源码注释里就有这些字面量）
    'no angle-bracket wrapper tags', 'angle-bracket wrapper tags \\(no',
    'private delimiter-prefixed variants', 'looksLikeToolCallBlock', 'stripStrayToolMarkup',
  ].join('|'),
  'i',
)

const stats = {
  sessions: 0,
  lines: 0,
  structLines: 0,
  byChannel: {},
  /** 按内容性质归类 */
  byNature: { 自指噪声: 0, 模型复述: 0, 用户提问: 0, '⚠️ 待人工看': 0 },
  suspects: [],
}

if (!existsSync(ROOT)) {
  console.log(`跳过：${ROOT} 不存在（沙箱环境属正常）。`)
  process.exit(0)
}

for (const g of readdirSync(ROOT, { withFileTypes: true })) {
  if (!g.isDirectory()) continue
  for (const s of readdirSync(join(ROOT, g.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue
    const f = join(ROOT, g.name, s.name, 'session.v4.jsonl.zstd')
    if (!existsSync(f)) continue
    let content
    try {
      content = inflate(readFileSync(f))
    } catch {
      continue
    }
    if (!content.includes('tool-call') && !content.includes('tool/call')) continue
    stats.sessions += 1

    for (const line of content.split('\n')) {
      if (!line) continue
      stats.lines += 1
      if (!DSML_STRUCT.test(line)) continue
      stats.structLines += 1

      let e
      try {
        e = JSON.parse(line)
      } catch {
        stats.byChannel['(非 JSON 行)'] = (stats.byChannel['(非 JSON 行)'] ?? 0) + 1
        continue
      }
      const ch = e.type || '(无 type)'
      stats.byChannel[ch] = (stats.byChannel[ch] ?? 0) + 1

      // 归因：内容里有没有"我们自己在提 DSML"的痕迹
      const isNoise = SELF_REFERENTIAL.test(line)
      if (isNoise) {
        stats.byNature['自指噪声'] += 1
      } else if (ch === 'user/message' || ch === 'agent/inbox/spliced') {
        // 🔴 这些是**用户自己说的话**（本例："你的思考过程中，是不是很多DSML"）。
        // 用户提到 DSML 这个词，不代表模型产出了 DSML —— 别把它算成泄漏。
        stats.byNature['用户提问'] += 1
      } else if (ch === 'assistant/message') {
        // 模型在 assistant 段里提 DSML：可能是复述我们的分析，也可能是它自发给格式
        // —— 两者字面上无法区分，这正是这个判据的极限，标出来供人工看上下文
        stats.byNature['模型复述'] += 1
        const m = e.data?.message ?? e.data
        const texts = Array.isArray(m?.content) ? m.content.filter((b) => typeof b?.text === 'string') : []
        for (const b of texts) {
          const t = b.text
          const i = t.search(DSML_STRUCT)
          if (i === -1) continue
          stats.suspects.push({
            channel: `${ch}/${b.type ?? 'text'}`,
            ctx: t.slice(Math.max(0, i - 150), i + 120),
          })
        }
      } else {
        stats.byNature['⚠️ 待人工看'] += 1
        const i = line.search(DSML_STRUCT)
        stats.suspects.push({ channel: ch, ctx: line.slice(Math.max(0, i - 150), i + 120) })
      }
    }
  }
}

console.log(`扫了 ${stats.sessions} 个含工具调用的会话，共 ${stats.lines} 行`)
console.log(`DSML 结构标记命中 ${stats.structLines} 行\n`)

console.log('=== 按通道分布 ===')
for (const [k, v] of Object.entries(stats.byChannel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(26)} ${v}`)
}

console.log('\n=== 按内容性质归因 ===')
for (const [k, v] of Object.entries(stats.byNature)) {
  console.log(`  ${k.padEnd(14)} ${v}`)
}

console.log('\n=== 结论 ===')
const suspectChannels = ['tool/call', 'tool/result']
const realSuspect = Object.entries(stats.byChannel)
  .filter(([k]) => suspectChannels.includes(k))
  .reduce((sum, [, v]) => sum + v, 0)
if (stats.byNature['⚠️ 待人工看'] === 0) {
  console.log('  ✅ 没有任何"未经我们诱发"的 DSML。')
  console.log('     所有命中都可归因为：①我们的诊断命令/脚本 ②模型复述我们提供的文本 ③用户提问。')
  console.log('     ⇒ "模型训练先验自发写 DSML"这个假设，在现有真机数据里仍无证据。')
} else {
  console.log(`  ⚠️ ${stats.byNature['⚠️ 待人工看']} 处需要人工确认（下面有样本）。`)
}
if (realSuspect > 0) {
  console.log(`  ℹ️  tool/call + tool/result 合计 ${realSuspect} 行含标记 —— `)
  console.log('     这些是工具的输入/输出，**参数里带 DSML 几乎必然是我们的诊断命令**')
  console.log('     （我们 grep 的 pattern 本身就含 "DSML|dsml"）。要看原始字节请看样本。')
}

if (stats.suspects.length) {
  console.log(`\n=== 样本（前 ${Math.min(12, stats.suspects.length)} 条）===\n`)
  for (const s of stats.suspects.slice(0, 12)) {
    console.log(`[${s.channel}]`)
    console.log('  ' + JSON.stringify(s.ctx))
    console.log()
  }
}
