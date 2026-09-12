/**
 * 回归：net.fetch 诊断的"启动触发"通道。
 *
 * 为什么需要这条路：宿主进程是 Electron 的 utility 进程，插件挂的 HTTP 端点
 * （`/deepseek-web-login/api/*`）只有从 DSH 自己的同源页面才打得通 ——
 * 从外部 curl 会撞上 DSH 的同源守卫（实测：任何路径都 403 forbidden，
 * 守卫要求 `Host` 与 `Origin` 严格等于它配置的 loopback origin）。
 * 所以留了一条不依赖 HTTP 的触发方式：往 `<DSH_HOME>/web-login/probe-request.json`
 * 写一个请求，重启 DSH 后插件在启动时读走并执行。
 *
 * 本文件守的就是这条路：路径约定、读取即消费（改名而非删除）、幂等、损坏容错，
 * 以及"不在 Electron 里跑也不能炸"（否则一个诊断功能能把插件启动搞挂）。
 *
 * 用法: node tests/check-net-diagnostics.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 业务模块之前把 DSH_HOME 指向临时目录：测试不许碰真实的 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'dsh-netdiag-'))
process.env.DSH_HOME = HOME

const { consumeProbeRequest, electronNetFetch, probeRequestPath, probeStreamingSupport, runNetFetchDiagnostics, writeProbeRequest } =
  await import('../src/net-diagnostics.ts')

let passed = 0
const failures = []
async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const FILE = join(HOME, 'web-login', 'probe-request.json')

await run('标记文件路径跟随 DSH_HOME（不落回真实 ~/.dsh）', async () => {
  assert.equal(probeRequestPath(), FILE)
  assert.ok(HOME.startsWith(tmpdir()), 'DSH_HOME 应指向临时目录')
})

await run('没有标记文件时返回 undefined（默认零开销）', async () => {
  assert.equal(existsSync(FILE), false)
  assert.equal(consumeProbeRequest(), undefined)
})

await run('写入后能被读到，且原文件已消失（被改名而非删除）', async () => {
  writeProbeRequest('stream')
  assert.ok(existsSync(FILE), '写入后文件应存在')
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).mode, 'stream')

  assert.equal(consumeProbeRequest(), 'stream', '应读到请求的 mode')

  assert.equal(existsSync(FILE), false, '消费后原文件应已消失')
  const done = readdirSync(join(HOME, 'web-login')).filter((f) => f.startsWith('probe-request.json.done-'))
  assert.equal(done.length, 1, `应留下一个 .done-<时间戳> 存档，实际 ${JSON.stringify(done)}`)
})

await run('幂等：消费过就不再重复触发', async () => {
  assert.equal(consumeProbeRequest(), undefined)
  assert.equal(consumeProbeRequest(), undefined)
})

await run('内容损坏时仍是 probe（不因为格式写错就静默跳过）', async () => {
  writeFileSync(FILE, '这不是 JSON {', 'utf8')
  assert.equal(consumeProbeRequest(), 'probe')
  assert.equal(existsSync(FILE), false, '损坏的文件也应被消费掉，避免每次启动都重跑')
})

await run('未知 mode 一律降级为 probe（写错不会意外跑流式、白耗额度）', async () => {
  writeFileSync(FILE, JSON.stringify({ mode: 'stream-please' }), 'utf8')
  assert.equal(consumeProbeRequest(), 'probe')
})

await run('非 Electron 环境：electronNetFetch() 返回 undefined 而不是抛错', async () => {
  const impl = electronNetFetch()
  assert.equal(impl, undefined, `当前不在 Electron 里，应拿不到 net.fetch，实际 ${typeof impl}`)
})

await run('非 Electron 环境：诊断返回 ok:false 并说明原因，不抛错', async () => {
  const result = await runNetFetchDiagnostics(undefined, 'probe')
  assert.equal(result.ok, false)
  assert.match(String(result.error), /net\.fetch 不可用/)
})

await run('非 Electron 环境：即使 auth 缺失 + 要求 stream 也不会崩', async () => {
  const result = await runNetFetchDiagnostics(undefined, 'stream')
  assert.equal(result.ok, false, '拿不到 net.fetch 时应在第一步就返回')
})

// ── 流式探针本身必须可信：正反两向都验，避免"永远绿灯" ──────────────

await run('流式探针：Node 原生 fetch 应判定为支持流式（读满 3 片 + abort 生效）', async () => {
  const evidence = await probeStreamingSupport(globalThis.fetch)
  assert.equal(evidence.ok, true, `应判定为支持，实际 ${JSON.stringify(evidence)}`)
  assert.ok(evidence.hasBody, 'response.body 应存在')
  assert.ok(evidence.chunks >= 3, `应增量读到 ≥3 个分片，实际 ${evidence.chunks}`)
  assert.equal(evidence.abortedEarly, true, 'abort 后服务端应看到连接断开')
  assert.match(String(evidence.sample), /chunk-1/)
})

await run('流式探针【反向】整体缓冲的响应必须被判为不可用（防假绿灯）', async () => {
  // 模拟"一口气把 body 全给你、读完就结束"的行为：只会有 1 个分片
  const buffering = async () => new Response('data: a\n\ndata: b\n\n', { status: 200 })
  const evidence = await probeStreamingSupport(buffering)
  assert.equal(evidence.ok, false, `应判定为不支持，实际 ${JSON.stringify(evidence)}`)
  assert.match(String(evidence.error), /整体缓冲/)
})

await run('流式探针【反向】没有 response.body 时必须明确指出整改路线不成立', async () => {
  const noBody = async () => new Response(null, { status: 204 })
  const evidence = await probeStreamingSupport(noBody)
  assert.equal(evidence.ok, false)
  assert.match(String(evidence.error), /response\.body 为空/)
})

await run('流式探针不会把监听端口留在进程里（可反复调用）', async () => {
  for (let i = 0; i < 2; i += 1) {
    const evidence = await probeStreamingSupport(globalThis.fetch)
    assert.equal(evidence.ok, true, `第 ${i + 1} 轮应仍成功：${JSON.stringify(evidence)}`)
  }
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
