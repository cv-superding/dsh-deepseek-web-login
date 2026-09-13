/**
 * 冒烟：新模块能否被独立加载、基本行为是否正确。
 *
 * 这里不测业务细节（各有专测），只回答两个问题：
 *  1. **模块能不能加载** —— 新的 paths/accounts/probe/ledger/update-check/version 一起
 *     被 import 时有没有循环依赖、缺导出、初始化期抛错；
 *  2. 纯函数的基本行为对不对（版本比较、台账汇总空库不炸、探活不做无凭证请求）。
 *
 * 用法: node tests/check-smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-smoke-'))
process.env.DSH_HOME = HOME

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

await test('宿主入口可加载，且导出约定的 name / inject / apply', async () => {
  const host = await import('../src/index.ts')
  assert.equal(host.name, 'dsh-deepseek-web-login')
  assert.deepEqual(host.inject, ['llm', 'webServer'])
  assert.equal(typeof host.apply, 'function')
})

await test('版本号：运行时读到 package.json，且与兜底常量一致（防漂）', async () => {
  const { pluginVersion, FALLBACK_VERSION } = await import('../src/version.ts')
  const pkg = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8'))
  assert.equal(pluginVersion(), pkg.version, '运行时应读到 package.json 的版本')
  assert.equal(FALLBACK_VERSION, pkg.version, '兜底常量漂了 —— 发版时忘了同步 version.ts')
})

await test('版本比较：只看前三段数字，解析不了就当作"没有更新"', async () => {
  const { isNewer, parseVersion } = await import('../src/update-check.ts')
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('0.1.26-beta.1'), [0, 1, 26])
  assert.equal(isNewer('0.1.27', '0.1.26'), true)
  assert.equal(isNewer('0.2.0', '0.1.99'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('0.1.26', '0.1.26'), false, '相同版本不算有更新')
  assert.equal(isNewer('0.1.25', '0.1.26'), false, '更旧不算有更新')
  assert.equal(isNewer('乱七八糟', '0.1.26'), false, '解析不了要保守地返回 false')
})

await test('台账：空库汇总不炸，结构完整', async () => {
  const { summarizeLedger, ledgerExists } = await import('../src/ledger.ts')
  assert.equal(ledgerExists(), false, '还没写过任何调用')
  const summary = summarizeLedger(24)
  assert.equal(summary.calls, 0)
  assert.equal(summary.failed, 0)
  assert.equal(summary.gaps, null, '没有样本时 gaps 必须是 null（而不是 0，否则界面会显示"最小间隔 0ms"误导）')
  assert.equal(summary.hourly.length, 24)
  assert.deepEqual(summary.failures, {})
})

await test('台账：写入后能汇总，且失败分类是人话', async () => {
  const { noteCall, summarizeLedger, pruneLedger } = await import('../src/ledger.ts')
  const now = Date.now()
  noteCall({ at: now - 60_000, purpose: 'chat', ok: true, ms: 1200, accountId: 'acc_test' })
  noteCall({ at: now - 30_000, purpose: 'chat', ok: true, ms: 900, accountId: 'acc_test' })
  noteCall({ at: now - 20_000, purpose: 'session-title', ok: true, ms: 300, accountId: 'acc_test' })
  noteCall({ at: now - 10_000, purpose: 'chat', ok: false, ms: 200, code: 'RATE_LIMIT', throttled: true, accountId: 'acc_test' })

  const summary = summarizeLedger(1)
  assert.equal(summary.calls, 4)
  assert.equal(summary.succeeded, 3)
  assert.equal(summary.failed, 1)
  assert.equal(summary.failures['限流（发太频繁）'], 1)
  assert.ok(summary.gaps, 'chat 调用之间应能算出间隔')
  // 口径（审计 F19）：session-title 仍不算（DSH 自己发的旁路请求，会把分布拉平），
  // 但**失败调用要算**（它同样占用了等待窗口，跳过只会把间隔拉大）。
  // `at` 是结束时刻，所以"这次等了多久" = 本次开始 − 上次结束：
  //   chat 三次（含一次失败）→ 两个间隔：29_100 与 19_800（排序后 min = 19_800）
  assert.equal(summary.gaps.samples, 2, '失败调用也要计入间隔（它同样占用了等待窗口）')
  assert.equal(summary.gaps.min, 19_800, '本次开始 − 上次结束（旧算法会把上一轮生成耗时算进等待）')
  assert.equal(summary.gaps.max, 29_100)
  assert.equal(pruneLedger(7), 0, '刚写的文件不该被清理')
})

await test('探活：未登录时直接返回 undefined，不发任何请求', async () => {
  const { probeOnce } = await import('../src/probe.ts')
  assert.equal(await probeOnce(undefined), undefined)
  assert.equal(await probeOnce({ token: 'short' }), undefined, 'token 太短视为不可用')
})

await test('检查更新：网络不可用时也必须返回结果对象（不抛错）', async () => {
  const { checkForUpdate } = await import('../src/update-check.ts')
  const failing = async () => {
    throw Object.assign(new Error('fetch failed'), { name: 'TimeoutError' })
  }
  const result = await checkForUpdate('0.1.26', failing)
  assert.equal(result.ok, false)
  assert.equal(result.hasUpdate, false)
  assert.match(String(result.error), /超时|失败/)
  // 非 200 也要给出可读原因
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const second = await checkForUpdate('0.1.26', http500)
  assert.equal(second.ok, false)
  assert.match(String(second.error), /HTTP 500/)
})

await test('路径解析：全部落在 DSH_HOME 下，且不越界到真实 ~/.dsh', async () => {
  const { webLoginDir, legacyAuthFilePath, resolveDshHome } = await import('../src/paths.ts')
  const { accountsDir, accountsIndexPath } = await import('../src/accounts.ts')
  const { ledgerDir } = await import('../src/ledger.ts')
  const { transportSettingsPath } = await import('../src/transport.ts')
  assert.equal(resolveDshHome(), HOME)
  for (const path of [webLoginDir(), accountsDir(), accountsIndexPath(), ledgerDir(), legacyAuthFilePath(), transportSettingsPath()]) {
    assert.ok(path.startsWith(HOME), `${path} 应落在 DSH_HOME 下`)
  }
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
rmSync(HOME, { recursive: true, force: true })
