/**
 * 0.6.38 围栏协议的**真机验证**（2026-10-04 加）。
 *
 * ## 为什么需要这个
 *
 * 0.6.38 把工具调用从裸 JSON 改成 ` ```dsh-tool ` 围栏。**但裸 JSON 走 fallback 路径
 * 同样能执行** ⇒ 「工具调用成功了」**不能**证明围栏生效。
 * 而"今天模型有没有真的在发围栏"这个判断本身有个陷阱：
 * **讨论围栏的会话会让 `dsh-tool` 这个词出现几十次**（模型在 reasoning 里复述、
 * 我们读源码、DSH 写分析报告……），全是自指噪声。
 *
 * 本脚本用**两层过滤**：
 *   1. 事件通道必须是 `assistant/message` 的**输出**块（不是 reasoning）
 *   2. 形态必须是"围栏开栏后紧跟 JSON"或"顶层裸 JSON"——**成对出现**才算一次调用
 *
 * ## ⚠️ 已知局限（2026-10-04 踩到）
 *
 * 本脚本**不按项目归因** —— 曾因此得出"0.6.38 已被真机验证"的**错误结论**：
 * 那 2 次围栏调用其实分属另外两个项目（`~/.dsh/sessions/` 按 cwd 分组）。
 *
 * 🔴 **更根本的问题**：**我们插件的轮次不落 `~/.dsh/sessions/`**（那是 DSH 自己的存储；
 * 我们走 插件 → DeepSeek 网页端），所以本脚本**对我们插件的会话恒为 0 命中**。
 * ⇒ 要真正验证围栏，得让解析器把"收到的是围栏还是裸 JSON"记进 `feed-decisions.jsonl`。
 *
 * ## 怎么看结果
 *
 * - `真围栏调用 > 0` ⇒ 模型在照新协议发，0.6.38 生效
 * - `裸 JSON > 0` ⇒ 模型**没听话**，走的是 fallback 路径（功能正常但没验证到围栏）
 * - 两者都是 0 ⇒ 今天没发过工具调用，需要重新触发
 *
 * 用法：node dev/verify-fence-on-machine.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
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

/**
 * 「真围栏调用」判据：**围栏内的 JSON 自己能解析成一个真调用**。
 *
 * 🔴 2026-10-04 实测踩到的坑（两次假阳性）：
 *   ① 只看 ```` ```dsh-tool ```` 出现过 ⇒ 命中 DSH 分析报告里**粘贴的示例块**；
 *   ② 加"开栏+闭栏成对" ⇒ 仍命中散文里**引用**这段协议（"我发了一个没套 ```dsh-tool
 *      围栏的裸 JSON 调用"—— 引号里就有完整围栏）。
 * ⇒ 唯一可靠的判据是**把围栏里的 JSON 抠出来真解析一次**，
 *   并且 `name` 得是已知工具名。
 */
const FENCED_BLOCK = /```dsh-tool[ \t]*\n([\s\S]*?)\n[ \t]*```/g

/** 从围栏内容里解出工具调用；解不出返回 null（= 散文引用/示例）。 */
function parseFencedCalls(code) {
  const open = code.indexOf('{')
  if (open < 0) return null
  // 括号配平（引号内的括号不计）
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const v = JSON.parse(code.slice(open, i + 1))
          return Array.isArray(v?.tool_calls) && v.tool_calls.length ? v.tool_calls : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 顶层裸 JSON：抠出来也能解析成真调用才算（排除散文里提到的 `{"tool_calls"` 字样）。 */
const BARE_BLOCK = /(^|\n)[ \t]*(?!```)(\{"tool_calls"[\s\S]*)/g

function parseBareCalls(text, fromIndex) {
  const open = text.indexOf('{', fromIndex)
  if (open < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(open, i + 1))
          return Array.isArray(v?.tool_calls) && v.tool_calls.length ? v.tool_calls : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const onlyToday = process.argv.includes('--today')
const since = onlyToday ? new Date().setHours(0, 0, 0, 0) : 0

if (!existsSync(ROOT)) {
  console.log(`跳过：${ROOT} 不存在（沙箱环境属正常）。`)
  process.exit(0)
}

const stats = { sessions: 0, fenced: 0, fenceQuoted: 0, bare: 0, reasonMentions: 0, toolCalls: 0 }
const samples = []

for (const g of readdirSync(ROOT, { withFileTypes: true })) {
  if (!g.isDirectory()) continue
  for (const s of readdirSync(join(ROOT, g.name), { withFileTypes: true })) {
    if (!s.isDirectory()) continue
    const f = join(ROOT, g.name, s.name, 'session.v4.jsonl.zstd')
    if (!existsSync(f)) continue
    if (since && statSync(f).mtimeMs < since) continue
    let content
    try {
      content = inflate(readFileSync(f))
    } catch {
      continue
    }
    if (!content.includes('tool-call') && !content.includes('tool/call')) continue
    stats.sessions += 1

    for (const line of content.split('\n')) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e.type === 'tool/call') stats.toolCalls += 1
      if (e.type !== 'assistant/message') continue
      const m = e.data?.message ?? e.data
      if (!Array.isArray(m?.content)) continue

      for (const b of m.content) {
        const t = b?.text
        if (typeof t !== 'string') continue
        // 🔴 只看 **text 输出块**，不看 reasoning —— 思考里复述协议是噪声
        if (b.type === 'reasoning') {
          if (t.includes('dsh-tool') || t.includes('tool_calls')) stats.reasonMentions += 1
          continue
        }
        // ① 围栏调用：抠出来真解析
        FENCED_BLOCK.lastIndex = 0
        let fm
        while ((fm = FENCED_BLOCK.exec(t)) !== null) {
          const calls = parseFencedCalls(fm[1])
          if (calls) {
            stats.fenced += 1
            if (samples.length < 4) {
              samples.push({ k: '围栏', t: `工具=${calls.map((c) => c?.name).join(',')} | ${fm[1].slice(0, 90)}` })
            }
          } else {
            stats.fenceQuoted += 1
          }
        }
        // ② 顶层裸 JSON
        // ⚠️ 必须先记下**围栏块覆盖的区间**并跳过 —— 否则同一个调用会被数两次
        //    （围栏内的 {"tool_calls" 同样匹配 BARE_BLOCK）。
        //    实测踩过：2 次围栏调用被同时报成"围栏 2 / 裸 JSON 2"。
        const fencedRanges = []
        FENCED_BLOCK.lastIndex = 0
        let fr
        while ((fr = FENCED_BLOCK.exec(t)) !== null) {
          const close = FENCED_BLOCK.lastIndex - 1
          const open = t.lastIndexOf('```dsh-tool', close)
          if (open >= 0) fencedRanges.push([open, close])
        }
        BARE_BLOCK.lastIndex = 0
        let bm
        while ((bm = BARE_BLOCK.exec(t)) !== null) {
          const at = bm.index + bm[1].length
          if (fencedRanges.some(([a, z]) => at >= a && at <= z)) continue
          const calls = parseBareCalls(t, at)
          if (calls) {
            stats.bare += 1
            if (samples.length < 6) {
              samples.push({ k: '裸JSON', t: `工具=${calls.map((c) => c?.name).join(',')} | ${bm[1].slice(0, 90)}` })
            }
          }
        }
      }
    }
  }
}

console.log(`扫了 ${stats.sessions} 个含工具调用的会话${onlyToday ? '（仅今天）' : '（全部）'}`)
console.log(`DSH 侧记录的工具调用: ${stats.toolCalls} 次\n`)

console.log('=== 模型实际发出的调用形态 ===')
console.log(`  ★ 真围栏调用（dsh-tool 围栏 + JSON + 闭栏）: ${stats.fenced}`)
console.log(`    裸 JSON（顶层，未包围栏）                  : ${stats.bare}`)
console.log(`    （仅 reasoning 里提到，不算）              : ${stats.reasonMentions}`)
  console.log(`    （围栏块但解析不出调用 = 散文引用/示例）  : ${stats.fenceQuoted}`)

console.log('\n=== 判定 ===')
if (stats.fenced > 0 && stats.bare === 0) {
  console.log('  ✅ 模型完全照新协议发围栏 —— 0.6.38 生效。')
} else if (stats.fenced > 0 && stats.bare > 0) {
  console.log(`  ⚠️ 混用：围栏 ${stats.fenced} 次 / 裸 JSON ${stats.bare} 次。`)
  console.log('     裸 JSON 走的是 fallback 路径（功能正常，但没验证到围栏）。')
} else if (stats.bare > 0) {
  console.log('  🔴 模型**没在用围栏**，全部走裸 JSON fallback ⇒ 0.6.38 未被真机验证。')
  console.log('     这不一定是 bug（fallback 是刻意保留的），但围栏方案等于没被测过。')
} else {
  console.log('  ⚪ 没有观测到任何工具调用文本 ⇒ 需要先触发一次工具调用再跑本脚本。')
}

if (samples.length) {
  console.log(`\n=== 样本（前 ${samples.length} 条）===\n`)
  for (const s of samples) console.log(`[${s.k}]\n  ${JSON.stringify(s.t)}\n`)
}
