/**
 * 回归：登录窗口必须报「干净 Chrome 指纹」，否则网页端直接判「使用环境异常」。
 *
 * 事故（2026-09-11 用户实测）：点「浏览器窗口登录」后，DeepSeek 页面显示
 *   「使用环境异常 —— 当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，
 *     建议您使用我们的官方产品。」
 * 原因：Electron 的默认 UA 里带应用名与 `Electron/<版本>` 字样，网页端一眼识别。
 * 注意：**只改 UA 字符串不够** —— Chromium 还会通过 UA-CH（Sec-CH-UA*）发品牌列表，
 * 里面同样带着非浏览器品牌，所以两处都要清。本用例把这两条都钉住。
 *
 * 用法: node tests/check-login-fingerprint.mjs
 */
import assert from 'node:assert/strict'
import { buildLoginUserAgent, sanitizeClientHints } from '../src/login.ts'

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

test('UA 里绝不能出现 Electron / 应用名', () => {
  const ua = buildLoginUserAgent('131.0.6778.85')
  assert.ok(!/electron/i.test(ua), `UA 里仍有 Electron：${ua}`)
  assert.ok(!/dsh/i.test(ua), `UA 里出现了应用名：${ua}`)
  assert.ok(ua.includes('Chrome/131.0.0.0'), `应报 Chromium 真实大版本：${ua}`)
  assert.ok(ua.includes('AppleWebKit/537.36'), ua)
  assert.ok(ua.includes('Safari/537.36'), ua)
  // 平台串必须与真实平台一致，否则「UA 说 Mac、能力是 Windows」更可疑
  if (process.platform === 'win32') assert.ok(ua.includes('Windows NT 10.0'), ua)
})

test('UA 的 Chromium 版本取自运行时而非常量', () => {
  const a = buildLoginUserAgent('120.0.0.0')
  const b = buildLoginUserAgent('132.9.9.9')
  assert.ok(a.includes('Chrome/120.0.0.0'), a)
  assert.ok(b.includes('Chrome/132.0.0.0'), b)
})

test('UA 缺版本时不崩（回退到默认大版本）', () => {
  const ua = buildLoginUserAgent(undefined)
  assert.match(ua, /Chrome\/\d+\.0\.0\.0/)
  assert.ok(!/undefined/.test(ua), ua)
})

test('清理 UA-CH 品牌列表里的 Electron', () => {
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 DSH Desktop/1.0.0 Chrome/131.0.0.0 Electron/33.0.0 Safari/537.36',
    'sec-ch-ua': '"Electron";v="33", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-full-version-list': '"Electron";v="33.0.0.0", "Chromium";v="131.0.6778.85", "Not_A Brand";v="24.0.0.0"',
  }
  const out = sanitizeClientHints(headers)
  assert.ok(!/electron/i.test(out['user-agent']), out['user-agent'])
  assert.ok(!/dsh/i.test(out['user-agent']), out['user-agent'])
  assert.ok(out['user-agent'].includes('Chrome/'), out['user-agent'])
  assert.ok(!/electron/i.test(out['sec-ch-ua']), out['sec-ch-ua'])
  assert.ok(out['sec-ch-ua'].includes('Chromium'), out['sec-ch-ua'])
  assert.ok(!/electron/i.test(out['sec-ch-ua-full-version-list']), out['sec-ch-ua-full-version-list'])
  assert.ok(out['sec-ch-ua-full-version-list'].includes('Chromium'), out['sec-ch-ua-full-version-list'])
})

test('干净的 UA 原样保留（不做无谓改写）', () => {
  const clean = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const out = sanitizeClientHints({ 'user-agent': clean, 'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"' })
  assert.equal(out['user-agent'], clean)
  assert.equal(out['sec-ch-ua'], '"Chromium";v="131", "Not_A Brand";v="24"')
})

test('品牌列表被清空时给出兜底品牌（不能留空串）', () => {
  const out = sanitizeClientHints({ 'sec-ch-ua': '"Electron";v="33"' })
  assert.ok(out['sec-ch-ua'].length > 0, '清空后必须给兜底品牌')
  assert.ok(!/electron/i.test(out['sec-ch-ua']), out['sec-ch-ua'])
})

test('不改动无关请求头', () => {
  const out = sanitizeClientHints({ cookie: 'a=b', 'x-hif-leim': 'x', accept: '*/*' })
  assert.deepEqual(out, { cookie: 'a=b', 'x-hif-leim': 'x', accept: '*/*' })
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
