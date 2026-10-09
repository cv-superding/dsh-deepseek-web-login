/**
 * 守卫：**测试不许写进用户真实的 `~/.dsh`**。
 *
 * 背景（2026-10-02 实测）：一次 `npm run test` 往用户真实的
 * `~/.dsh/web-login/feed-decisions.jsonl` 灌了 695 条测试噪声（`sess-1..7`、同一毫秒），
 * 排查真实问题时得先手工把噪声滤掉。诊断数据被污染比没有数据更糟。
 *
 * 成因是**两层都漏**：
 *  ① 4 个用例（fetch-injection / session-lifecycle / session-reuse / sse-wasm）没设 DSH_HOME
 *     ⇒ 落回 `~/.dsh`；别的用例早就用 `process.env.DSH_HOME = mkdtempSync(...)` 隔离了；
 *  ② 跑批脚本 `test-offline.mjs` 没有兜底 —— 任何一个新用例忘了隔离就再次污染。
 *
 * 所以本文件守两条，缺一条都会复发：
 *  A. 兜底：跑批脚本必须给子进程注入临时 DSH_HOME；
 *  B. 逐个：凡是会走 `streamWebCompletion`（唯一写投喂留痕的入口）的用例，自己也得隔离
 *     —— 单独 `node tests/xxx.mjs` 直接跑时，兜底是不生效的。
 *
 * ⚠️ 刻意断言"存在性"而不是写死名单：新用例自动纳入，不用维护。
 *
 * 用法: node tests/check-test-isolation.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(ROOT, 'tests')

const testFiles = readdirSync(testsDir).filter((n) => /^check-.*\.mjs$/.test(n))
/**
 * 会写投喂留痕的用例（`streamWebCompletion` 是唯一入口）。
 * ⚠️ 判据要求**真的 import 了 src** —— 只看"文件里出现过这个词"会把
 * `check-bundle.mjs` 一起算进来（它只在注释里提到这个名字，读的是 lib/，不碰状态）。
 * 误报会让这条守卫迟早被人当噪音关掉。
 */
const stateful = testFiles.filter((n) => {
  const s = readFileSync(join(testsDir, n), 'utf8')
  const importsSrc = /from\s*['"]\.\.\/src\//.test(s) || /import\(\s*['"]\.\.\/src\//.test(s)
  return importsSrc && /\bstreamWebCompletion\b/.test(s)
})

test('★ 扫描本身有效（找不到任何会写状态的用例 ⇒ 判据失效，必须报红）', () => {
  assert.ok(
    stateful.length >= 5,
    `只扫到 ${stateful.length} 个会写状态的用例，明显不对（判据失效会让本文件变成永远通过）`,
  )
  assert.ok(testFiles.length >= 40, `只扫到 ${testFiles.length} 个用例文件，目录解析可能错了`)
})

test('★ 每个会写状态的用例都必须自己钉住 DSH_HOME（直接单跑也不能污染真实目录）', () => {
  const offenders = stateful.filter((n) => {
    const s = readFileSync(join(testsDir, n), 'utf8')
    // 认「先赋值 + 真的用了 mkdtempSync」——只写个空串不算隔离
    return !(/process\.env\.DSH_HOME\s*=/.test(s) && s.includes('mkdtempSync'))
  })
  assert.deepEqual(
    offenders,
    [],
    `这些用例会把留痕写进用户真实的 ~/.dsh：${offenders.join(', ')}\n` +
      `修法：在文件顶部加 process.env.DSH_HOME = mkdtempSync(join(tmpdir(), '<名字>-'))`,
  )
})

// ── 0.6.42：第二条隔离维度 = 「会不会真启浏览器」──────────────────────────────
//
// 为什么加这条：PoW 改到**浏览器页面内**求解（`solvePowInPage`）之后，它会
// `launchBrowserTransport()` —— 真开一个 Edge/Chrome 进程。实测后果：
// `check-round2` 从 **4 秒变成 300 秒超时挂住**（它只该跑离线断言）。
//
// 🔴 本仓库之前只有 `DSH_NO_BROWSER_TRANSPORT` 一个开关，且**只有
// `check-browser-transport.mjs` 自己在用** —— 没有任何守卫防止"新增的用例会启浏览器"。
// 这就是"新增一类副作用后，每个消费点都要跟着改"的第 N 次。
test('★ 会触发浏览器传输的用例必须钉住 DSH_NO_BROWSER_TRANSPORT（离线套件不许真启浏览器）', () => {
  // 🔴 这条守卫改了**四次**才不误报，全是同一个毛病：判据没对准"**真的会发生什么**"。
  //  ① "碰了传输层 API"             ⇒ 误报 9 个（它们都注入了假 fetch）
  //  ② "注入了 fetch 就豁免"         ⇒ 漏 check-round2（它也注入了，但会走浏览器 PoW）
  //  ③ "离线 check-* 全都要"         ⇒ 仍误报 9 个
  //  ④ **最终判据：只算"会走到浏览器"的那条路径** ——
  //     `createPowHeader` → `solvePow` → `solvePowInPage` → `launchBrowserTransport`。
  //     `streamWebCompletion` 在这些用例里**全走注入的 fetch**，不会启浏览器
  //     （实测那 9 个命中文件里 `createPowHeader` 出现 **0** 次）。
  //
  // 教训：**判据必须落在"那个真会发生的副作用"上**，不是"沾了这个模块"。
  //
  // ⚠️ **本守卫的能力边界**（实测，别误以为它能抓住已有回归）：
  // 它只守"**将来**新增的用例"，对已经写好的用例无能为力 ——
  // 变异验证时我把 `check-round2` 的开关全删掉，它**没有报红**，
  // 因为该文件在删掉 N05 那两条用例后已经不调 `createPowHeader` 了
  // ⇒ 判据扫不到"曾经会启浏览器、现在不会"这种状态变化。
  // 它的价值是**防止新用例再犯**，不是回溯历史。
  const inSuite = testFiles.filter((n) => n.startsWith('check-'))
  const reallyLaunches = inSuite.filter((n) => {
    const s = readFileSync(join(testsDir, n), 'utf8')
    return (
      /createPowHeader\s*\(/.test(s) ||
      /resolveTransportState\s*\(/.test(s) ||
      /launchBrowserTransport\s*\(/.test(s) ||
      /createBrowserFetch\s*\(/.test(s)
    )
  })
  assert.ok(
    reallyLaunches.length >= 1,
    `只扫到 ${reallyLaunches.length} 个会真启浏览器的用例，判据可能失效了（会让本条永远通过）`,
  )
  const offenders = reallyLaunches.filter((n) => {
    const s = readFileSync(join(testsDir, n), 'utf8')
    // 自带开关 = 这条明确表示"我主动关掉了"（或它就是要测浏览器那条）
    return !/DSH_NO_BROWSER_TRANSPORT\s*=/.test(s)
  })
  assert.deepEqual(
    offenders,
    [],
    `这些用例会真启浏览器（离线跑批里最慢的一类，check-round2 曾因此 4s → 300s 超时）：\n` +
      `${offenders.join(', ')}\n修法：在调用前设 process.env.DSH_NO_BROWSER_TRANSPORT = '1'（finally 还原）`,
  )
})

test('★ 跑批脚本必须给子进程注入临时 DSH_HOME（兜底，防新用例忘了隔离）', () => {
  const runner = readFileSync(join(ROOT, 'scripts', 'test-offline.mjs'), 'utf8')
  assert.ok(
    /env:\s*\{[^}]*DSH_HOME:/.test(runner),
    'scripts/test-offline.mjs 没给子进程注入 DSH_HOME ⇒ 任何一个忘了隔离的新用例都会污染用户真实数据',
  )
  assert.ok(
    runner.includes('mkdtempSync') && runner.includes('tmpdir'),
    '兜底的 DSH_HOME 必须指向临时目录（要有 mkdtempSync + tmpdir）',
  )
})

console.log(
  failures.length === 0
    ? `\n通过 ${passed} 项，全部通过 ✅（已守 ${stateful.length} 个写状态的用例）`
    : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌\n${failures.join('\n')}`,
)
if (failures.length > 0) process.exitCode = 1
