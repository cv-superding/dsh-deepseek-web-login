/**
 * 风控对齐（2026-11-15）：把社区方案里**真正能降低封号风险**的那几条落到我们自己身上。
 *
 * 背景：站点对**环境/设备**做了判定（「由于违规次数过多，你的账户已被临时停用」），
 * 换 IP、换账号都无效。调研 `NIyueeE/ds-free-api` 的抓包记录后确认两处结构性偏差：
 *   ① `x-hif-leim` 是 600 秒短期令牌，真实客户端按 `x-hif-ttl` 续取；我们只在登录时抓一次；
 *   ② 传输层 profile 每次启动都被清空重建 ⇒ 每次重启都换一台「新设备」。
 *
 * 这个用例守四件事：
 *  ① 封禁（10）与设备风控（11）**各自可识别**，且不互相误伤；
 *  ② 传输层 profile 按账号分目录（且路径不再等于旧的固定目录）；
 *  ③ 页面脚本真的能把过期的 hif 令牌换成页面里最新的那份（**真求值**，不是断文本）；
 *  ④ 「重建设备身份」的请求幂等、不会抛。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-risk-'))
// 离线用例：绝不允许真去启动系统浏览器（见 check-test-isolation）。
process.env.DSH_NO_BROWSER_TRANSPORT = '1'

const { isBannedError, isMutedError, isRiskDeviceError } = await import('../src/webapi.ts')
const { buildFreshHifScript, requestTransportProfileReset, transportProfileDir } = await import(
  '../src/browser-transport.ts'
)

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

// ── ① 错误码分级 ──────────────────────────────────────────────

await test('biz_code=10 判为永久封禁', () => {
  assert.equal(isBannedError({ code: 10, msg: 'USER_IS_BANNED' }), true)
})

await test('biz_code=5（临时禁言）不算永久封禁', () => {
  assert.equal(isBannedError({ code: 5, msg: 'user is muted' }), false)
  assert.equal(isMutedError({ code: 5, msg: 'user is muted' }), true)
})

await test('biz_code=11 判为设备风控，且不算封禁/禁言', () => {
  assert.equal(isRiskDeviceError({ code: 11, msg: 'RISK_DEVICE_DETECTED' }), true)
  assert.equal(isBannedError({ code: 11 }), false)
  assert.equal(isMutedError({ code: 11 }), false)
})

await test('文案兜底：中文「账户已被临时停用」判为封禁', () => {
  // 现场原文（2026-11）：站点在 HTTP 200 上回这句，且不一定是 biz_code=10。
  assert.equal(isBannedError({ msg: '由于违规次数过多，你的账户已被临时停用' }), true)
})

await test('文案兜底：英文 violation of user policies 判为封禁', () => {
  assert.equal(
    isBannedError({
      msg: 'Due to violation of user policies, your account has been suspended until October 18, 2026 00:21.',
    }),
    true,
  )
})

await test('普通错误不会被误判成封禁/设备风控', () => {
  for (const msg of ['invalid chat session id', 'too many requests, please try again later', '']) {
    assert.equal(isBannedError({ code: 1, msg }), false, `误判封禁：${msg}`)
    assert.equal(isRiskDeviceError({ code: 1, msg }), false, `误判设备风控：${msg}`)
  }
})

// ── ② profile 按账号分 ────────────────────────────────────────

await test('profile 目录按账号分（不同账号不共用一台"设备"）', () => {
  const a = transportProfileDir('alice@example.com')
  const b = transportProfileDir('bob@example.com')
  assert.notEqual(a, b, '两个账号必须落在不同 profile')
  // 用 dirname 而不是切 '/'：Windows 上是反斜杠（这条用例最初就是这么错的）。
  assert.equal(dirname(a), dirname(b), '应在同一个根目录下')
})

await test('profile 目录名被 sanitize（邮箱的 @ 不能把目录写到别处）', () => {
  const dir = transportProfileDir('../../etc/passwd')
  assert.equal(dir.includes('..'), false, '不能出现 ..')
  assert.equal(/[\\/]etc[\\/]passwd$/.test(dir), false, '不能真的落到 /etc/passwd')
  assert.equal(dir.includes('@'), false, '不能带 @')
})

await test('拿不到账号 id 时落到一个稳定的兜底目录（而不是随机）', () => {
  const a = transportProfileDir(undefined)
  const b = transportProfileDir('')
  assert.equal(a, b)
  assert.equal(a.endsWith('_anonymous'), true)
})

// ── ③ 页面脚本：真求值 ────────────────────────────────────────

/** 用 `new Function` 把产物跑起来 —— 断言的是**行为**，不是字符串形状。 */
function runScript(headers, storageValue) {
  const hdr = { ...headers }
  const localStorage = {
    getItem(key) {
      return key === 'hif_leim_cached' ? storageValue : null
    },
  }
  const run = new Function('hdr', 'localStorage', `${buildFreshHifScript('hdr')};return hdr;`)
  return run(hdr, localStorage)
}

await test('页面里的新令牌会覆盖登录快照（JSON 串形态）', () => {
  const out = runScript({ 'x-hif-leim': 'STALE_SNAPSHOT' }, JSON.stringify('FRESH_FROM_PAGE'))
  assert.equal(out['x-hif-leim'], 'FRESH_FROM_PAGE')
})

await test('页面里的新令牌会覆盖登录快照（裸串形态）', () => {
  const out = runScript({ 'x-hif-leim': 'STALE_SNAPSHOT' }, 'FRESH_RAW')
  assert.equal(out['x-hif-leim'], 'FRESH_RAW')
})

await test('头名大小写不同也改得到（真实链路键大小写不保证）', () => {
  const out = runScript({ 'X-Hif-Leim': 'STALE' }, JSON.stringify('FRESH'))
  assert.equal(out['X-Hif-Leim'], 'FRESH')
})

await test('原请求里没有这个头时也能补上', () => {
  const out = runScript({ accept: '*/*' }, JSON.stringify('FRESH'))
  assert.equal(out['x-hif-leim'], 'FRESH')
})

await test('页面里读不到 ⇒ 一个字节都不改（沿用快照）', () => {
  for (const empty of [null, undefined, '', '""']) {
    const out = runScript({ 'x-hif-leim': 'STALE' }, empty)
    assert.equal(out['x-hif-leim'], 'STALE', `readable=${JSON.stringify(empty)} 时不该改动`)
  }
})

await test('JSON 解析失败 ⇒ 不改、也不抛（这段脚本不许让请求失败）', () => {
  const out = runScript({ 'x-hif-leim': 'STALE' }, '"broken json')
  assert.equal(out['x-hif-leim'], 'STALE')
})

await test('产物里没有反引号（它会被嵌进模板字符串）', () => {
  assert.equal(buildFreshHifScript('hdr').includes('`'), false)
})

// ── ④ 重建设备身份 ────────────────────────────────────────────

await test('请求重建设备身份：幂等、不抛', () => {
  assert.equal(requestTransportProfileReset('单测触发'), true)
  assert.equal(requestTransportProfileReset('单测触发（重复）'), true)
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
