/**
 * 回答那个一直没法回答的问题：**0.6.38 的围栏协议，模型到底听没听话？**
 *
 * ## 为什么需要这个脚本
 *
 * 0.6.38 把工具调用从裸 JSON 改成 ` ```dsh-tool ` 围栏，但**无法从别处验证**：
 *  - 裸 JSON 走 fallback 路径**同样能执行成功** ⇒ "工具调用成功了"**不能**证明围栏生效；
 *  - 我们的轮次**不落 DSH 会话日志**（走插件 → 网页端）⇒ `~/.dsh/sessions/` 里没有原文。
 *
 * 所以 0.6.39 在 adapter 里加了一行留痕（`noteCallShape` → `diagnostics/call-shapes.jsonl`），
 * 本脚本读它。**这是唯一可靠的来源** —— 之前那个版本去扫 `~/.dsh/sessions/`，
 * 结果扫到的是**别的项目**的会话（它按 cwd 分组，我们的不在那里），
 * 并因此得出过"0.6.38 已被验证"的**错误结论**。
 *
 * ## 怎么读结果
 *
 *   fenced  为主 ⇒ ✅ 模型照新协议发，围栏生效
 *   bare    为主 ⇒ 🔴 模型没听话（**功能仍正常**，但围栏等于没被测过）
 *   混在一起 ⇒ ⚠️ 不稳定（可能与任务类型/上下文长度有关，值得看分布）
 *
 * ⚠️ **只记形态、不记内容** —— 与 `dumpRejectedPayload` 同一纪律。
 *
 * 用法：
 *   node dev/verify-fence-on-machine.mjs           # 全部历史
 *   node dev/verify-fence-on-machine.mjs --today   # 只看今天
 *   node dev/verify-fence-on-machine.mjs --recent 20
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const file = join(home, 'web-login', 'diagnostics', 'call-shapes.jsonl')

if (!existsSync(file)) {
  console.log(`还没有留痕：${file}`)
  console.log('说明 0.6.39 还没跑过 —— 装上后正常用几轮（要会调工具的任务）就会有了。')
  process.exit(0)
}

const args = process.argv.slice(2)
const todayOnly = args.includes('--today')
const recentIdx = args.indexOf('--recent')
const limit = recentIdx >= 0 ? Number(args[recentIdx + 1]) : Infinity

let rows = []
try {
  rows = readFileSync(file, 'utf8')
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
} catch (e) {
  console.log(`读不出来（${e.message}）—— 诊断文件被清理掉了是正常的。`)
  process.exit(0)
}

if (todayOnly) {
  const start = new Date().setHours(0, 0, 0, 0)
  rows = rows.filter((r) => Date.parse(r.at) >= start)
}
if (Number.isFinite(limit)) rows = rows.slice(-limit)

if (!rows.length) {
  console.log('（这个范围内没有记录）')
  process.exit(0)
}

const tally = { fenced: 0, bare: 0, none: 0 }
for (const r of rows) if (tally[r.shape] !== undefined) tally[r.shape] += 1

const withCalls = tally.fenced + tally.bare
console.log(`来源：${file}`)
console.log(`记录：${rows.length} 条（文件 ${(statSync(file).size / 1024).toFixed(1)} KB）\n`)

console.log('=== 模型发出的调用形态 ===')
console.log(`  fenced（照 0.6.38 围栏）: ${tally.fenced}`)
console.log(`  bare  （裸 JSON/XML）    : ${tally.bare}`)
console.log(`  none  （本轮无调用）    : ${tally.none}`)

console.log('\n=== 判定 ===')
if (withCalls === 0) {
  console.log('  ⚪ 还没有"带调用"的轮次 ⇒ 无法判定。用几轮会调工具的任务再来。')
} else {
  const ratio = (tally.fenced / withCalls) * 100
  console.log(`  fenced 占比 ${ratio.toFixed(1)}%（${tally.fenced}/${withCalls} 轮有调用）`)
  if (tally.fenced === 0) {
    console.log('  🔴 迄今**没有一次**围栏调用 ⇒ 模型完全没照 0.6.38 发（走的是 fallback，功能正常）。')
  } else if (tally.bare === 0) {
    console.log('  ✅ 全部照新协议发围栏 ⇒ 0.6.38 生效。')
  } else {
    console.log('  ⚠️ 混用。围栏生效但不稳定 —— 值得按任务类型/上下文长度再看分布。')
  }
}

console.log(`\n=== 最近 ${Math.min(8, rows.length)} 条（证明落盘的是真数据）===`)
for (const r of rows.slice(-8)) {
  console.log(`  ${r.at}  ${r.shape}`)
}
