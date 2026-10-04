/**
 * 开发诊断脚本健康检查（2026-10-03 加）。
 *
 * 🔴 为什么需要：0.6.37 / 0.6.38 的排查**全靠** `dev/probe-*.mjs`，但它们**不被任何测试引用**
 * ⇒ 改坏了也不会有人知道（探针自己会静默地报"全绿"或直接崩在 import 上）。
 * 这条用例只做一件事：**每个探针都还能跑，且不抛异常**。
 *
 * ⚠️ 它**不**判断探针结论对不对（那是探针自己的事），只保证"能跑"。
 * 判"探针结论对不对"的规矩见 MEMORY：**探针判为异常时必须打印上屏原文**。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEV = join(ROOT, 'dev')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

/** 只查"能不能跑"，不查退出码（部分探针发现问题时故意非零退出）。 */
const PROBES = [
  'probe-dsml-matrix.mjs',
  'probe-fenced-protocol.mjs',
  'probe-json-leak.mjs',
  'audit-fence-criteria.mjs',
  'audit-reasoning-json.mjs',
  'audit-reasoning-both-ways.mjs',
  'trace-dsml-sources.mjs',
  'measure-protocol-size.mjs',
  'trace-json-origin.mjs',
  'trace-turn-sizes.mjs',
  'replay-turn-prompts.mjs',
  'dump-turn-input.mjs',
]

test('dev/ 下所有探针脚本都在（别被清理掉）', () => {
  const missing = PROBES.filter((p) => !existsSync(join(DEV, p)))
  assert.equal(missing.length, 0, `这些探针不见了: ${missing.join(', ')}`)
})

/**
 * 扫一个真机会话 id 出来（给需要参数的探针用）。
 *
 * ⚠️ **不写用户真实目录** —— 只 `readdir` 目录名，不写任何文件。
 * 找不到就返回 null（让断言失败并说明原因），不硬编一个 id。
 */
function findRealSessionId() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const g = join(root, group.name)
    for (const s of readdirSync(g, { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue
      if (existsSync(join(g, s.name, 'session.v4.jsonl.zstd'))) return s.name.slice('session-'.length)
    }
  }
  return null
}

/**
 * 需要 `<会话id前缀>` 参数的探针：不硬编一个 id（会随运行失效），
 * 而是自己扫一个真实会话出来喂给它 —— 顺带验证"能从真机日志里捞出会话"这条链路没断。
 */
const NEEDS_SESSION_ARG = new Set([
  'trace-json-origin.mjs',
  'trace-turn-sizes.mjs',
  'replay-turn-prompts.mjs',
  'dump-turn-input.mjs',
])

/** 非零退出也算过：这些探针发现问题时会故意非零退出（这里只关心"能启动"）。 */
function runProbe(name, args = []) {
  const out = runOnce(name, args)
  if (out === null) return null
  // 🔴 本机 spawn 子进程**会随机失败**（EBUSY：文件被别的进程占着），表现为
  // `node:fs:1590` 这类无意义的错误。批里跑时更容易触发（并发更高）。
  // ⇒ 同一个探针重试两次；两次都失败才算它真的坏了。
  if (/EBUSY|node:fs:\d+|EPERM|ENOENT.*\.mjs/i.test(out.err)) {
    const retry = runOnce(name, args)
    if (retry === null) return null
    return retry.err ? `重试后仍失败: ${retry.err}` : null
  }
  return out.err
}

function runOnce(name, args) {
  try {
    execFileSync('node', [join('dev', name), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { err: null }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    // 有正常输出 = 探针跑起来了，只是它发现了问题 ⇒ 算通过
    if (out.trim().length > 0 && !/Error:|SyntaxError|Cannot find|ERR_|EBUSY/.test(out)) return { err: null }
    return { err: (out.split('\n').find((l) => l.trim()) || '(无输出)').slice(0, 120) }
  }
}

/**
 * 需要**真机会话数据**的探针（会读 `~/.dsh/sessions`）。
 *
 * 🔴 批跑（`scripts/test-offline.mjs`）把 `DSH_HOME` 指向**临时沙箱** ⇒ 里面没有会话
 * ⇒ 这些探针必然失败。那正是沙箱的目的（不许用真实数据），所以此环境下**跳过**它们 ——
 * 否则这条用例自己就成了"用真实数据"的漏洞。
 */
const NEEDS_REAL_SESSIONS = new Set([
  'audit-fence-criteria.mjs',
  'trace-json-origin.mjs',
  'trace-turn-sizes.mjs',
  'replay-turn-prompts.mjs',
  'dump-turn-input.mjs',
])

/**
 * 批跑时 DSH_HOME 是临时沙箱（`scripts/test-offline.mjs` 注入）。
 *
 * ⚠️ 沙箱里没有真机会话 ⇒ 那些探针**跑不起来**。整条跳过会在 CI 里留下盲区
 * （CI 跑的正是批）⇒ 所以分开处理：
 *   沙箱下：只验证**能加载**（import 不炸、语法对、顶层代码不崩）——
 *          探针内部找不到会话时应当**优雅退出**（不是崩），这也正是要验的。
 *   非沙箱：完整跑一遍。
 */
const inSandbox = !!process.env.DSH_HOME && !/[/\\]\.dsh[/\\]?$/.test(process.env.DSH_HOME)

/**
 * 批跑时 DSH_HOME 是临时沙箱（`scripts/test-offline.mjs` 注入），里面**没有真机会话**。
 *
 * ⇒ 那些探针仍然要**真跑**，但它们必须"没数据就优雅退出"。
 * 这正是要验的行为：批跑（CI 也是批）不能因为没有真机数据就崩。
 * ⚠️ 试过用 `node --check` 只验语法 —— 不行：那不算"探针可用"，
 * 而且探针在无数据时崩掉这件事本身就被漏掉了。
 */
for (const probe of PROBES) {
  test(`探针能启动: ${probe}`, () => {
    if (inSandbox && NEEDS_REAL_SESSIONS.has(probe)) {
      // 沙箱：没有会话 id 可传，但探针应当"扫到 0 个"而不是崩
      const err = runProbe(probe)
      assert.equal(err, null, `${probe} 在无真机数据的环境里起不来（应当优雅退出）: ${err}`)
      return
    }
    if (NEEDS_SESSION_ARG.has(probe)) {
      const id = findRealSessionId()
      assert.ok(id, `扫不到任何真机会话（${probe} 需要一个 <会话id前缀>）`)
      const err = runProbe(probe, [id])
      assert.equal(err, null, `${probe} 传参 ${id} 仍起不来: ${err}`)
      return
    }
    const err = runProbe(probe)
    assert.equal(err, null, `${probe} 起不来: ${err}`)
  })
}

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，全部通过 OK${inSandbox ? '（沙箱下：需要真机数据的探针验证的是"能优雅退出"）' : ''}`)
