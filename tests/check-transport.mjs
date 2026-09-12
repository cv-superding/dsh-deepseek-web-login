/**
 * 回归：传输层选择（网页端请求从 Chromium 网络栈还是 Node 出去）。
 *
 * 这条选择是"指纹像不像浏览器"的总开关 —— 实测 Node fetch 的 JA4 是 `t13d…h1`，
 * Chromium 网络栈则与 Chrome 的 cipher 列表哈希逐字节一致。选错了整套改造白做，
 * 所以几个易错点必须守住：
 *  - 环境不支持 Chromium 时必须**降级**而不是让请求发不出去（且要如实标记 degraded）；
 *  - 降级判定只看"能力"，**不是"失败后换一条重试"** —— 完成请求重发可能就是一次重复生成；
 *  - 设置文件损坏/值非法 → 回落到默认，不许崩；
 *  - 切换后 webapi 的注入层必须真的跟着变（否则界面显示切了、实际没切）。
 *
 * 用法: node tests/check-transport.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先钉住 DSH_HOME，测试不许碰真实的 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'dsh-transport-'))
process.env.DSH_HOME = HOME

const {
  DEFAULT_TRANSPORT,
  applyTransport,
  electronNetFetch,
  readTransportSetting,
  resolveTransportState,
  transportSettingsPath,
  writeTransportSetting,
} = await import('../src/transport.ts')
const { fetchImplKind, setFetchImpl } = await import('../src/webapi.ts')

let passed = 0
const failures = []
function run(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const FILE = join(HOME, 'web-login', 'transport.json')

run('默认走 Chromium 网络栈（这才是"看起来像浏览器"的那个）', () => {
  assert.equal(DEFAULT_TRANSPORT, 'chromium')
})

run('设置文件路径跟随 DSH_HOME', () => {
  assert.equal(transportSettingsPath(), FILE)
  assert.ok(HOME.startsWith(tmpdir()), 'DSH_HOME 应指向临时目录')
})

run('没有设置文件时返回 undefined（回落到默认）', () => {
  assert.equal(existsSync(FILE), false)
  assert.equal(readTransportSetting(), undefined)
})

run('写入后能读回（node / chromium 两种）', () => {
  writeTransportSetting('node')
  assert.equal(readTransportSetting(), 'node')
  writeTransportSetting('chromium')
  assert.equal(readTransportSetting(), 'chromium')
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).transport, 'chromium')
})

run('设置文件损坏 / 值非法 → 返回 undefined 而不是崩', () => {
  writeFileSync(FILE, '这不是 JSON {', 'utf8')
  assert.equal(readTransportSetting(), undefined)
  writeFileSync(FILE, JSON.stringify({ transport: 'quantum' }), 'utf8')
  assert.equal(readTransportSetting(), undefined)
})

run('非 Electron 环境：要求 chromium 时降级为 node 并如实标记 degraded', () => {
  assert.equal(electronNetFetch(), undefined, '当前不在 Electron 里')
  const state = resolveTransportState('chromium')
  assert.equal(state.requested, 'chromium')
  assert.equal(state.effective, 'node', '拿不到 electron.net.fetch 时必须降级')
  assert.equal(state.degraded, true, '降级必须如实标记，不能假装在用 Chromium')
  assert.equal(state.chromiumAvailable, false)
})

run('非 Electron 环境：要求 node 是正常路径，不算降级', () => {
  const state = resolveTransportState('node')
  assert.equal(state.effective, 'node')
  assert.equal(state.degraded, false, '用户本来就选 Node，不该报"降级"')
})

run('切换 node 后注入层确实回到 Node 原生', () => {
  applyTransport('node')
  assert.equal(fetchImplKind(), 'node')
})

run('要求 chromium 但环境不支持时，注入层必须保持可用（不许把 fetch 弄丢）', () => {
  const state = applyTransport('chromium')
  assert.equal(state.effective, 'node')
  assert.equal(fetchImplKind(), 'node', '降级后仍应是 Node 原生 fetch —— 绝不能变成 undefined')
})

run('反复切换都稳定（模拟用户在设置页来回点）', () => {
  for (const kind of ['node', 'chromium', 'node', 'chromium', 'node']) {
    const state = applyTransport(kind)
    assert.equal(state.effective, 'node')
    assert.equal(fetchImplKind(), 'node')
  }
})

run('注入层被外部改动后，重新 apply 能纠正回来（单一事实来源）', () => {
  applyTransport('node')
  const fake = async () => new Response('x')
  setFetchImpl(fake)
  assert.equal(fetchImplKind(), 'injected')
  applyTransport('node')
  assert.equal(fetchImplKind(), 'node', 'applyTransport 应把注入层重置成它自己的判定结果')
  setFetchImpl()
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
