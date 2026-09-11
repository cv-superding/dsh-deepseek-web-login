/**
 * 回归：DSH 更新后「浏览器窗口登录打不开」。
 *
 * 事实链（2026-09-11 实测，全部来自现场）：
 *  1) DSH 把插件宿主从 Electron **主进程**挪到了 **utility 进程**
 *     （探针实测：`process.type === 'utility'`、Electron 43.3.0、`process.parentPort` 存在）。
 *  2) utility 进程里 `require('electron')` 拿不到 `BrowserWindow`/`session`（主进程专属 API），
 *     而旧的 `electronAvailable()` 只看 `process.versions.electron` → **假阳性通过**，
 *     随后炸在 `session.fromPartition`（host 日志原文：
 *     `api /login/browser failed: Cannot read properties of undefined (reading 'fromPartition')`）。
 *  3) 新架构也没有给插件暴露任何「开窗口 / 开外部 URL」的通用服务
 *     （`desktopRuntime` 只有 openTerminal / pickDirectory / openProfileCreateWindow 等专用接口）
 *     → 只能改为拉起**真实 Edge/Chrome** + CDP 读登录态。
 *  4) 硬编码调试端口会失败：Windows 保留了大量端口区间（8792-9897、10001-10100…），
 *     `bind()` 直接 WSAEACCES 10013 → 必须用 `--remote-debugging-port=0` 并从
 *     `<profile>/DevToolsActivePort` 读真实端口。
 *
 * 用法: node tests/check-browser-login.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { buildBrowserArgs, buildCookieHeader, findSystemBrowser, parseDevToolsActivePort, pickExtraHeaders } from '../src/browser-login.ts'
import { canOpenElectronWindowWith } from '../src/login.ts'
import { unwrapStoredToken } from '../src/auth.ts'

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

// ── 事故 ①：宿主进程能力判定（这是「打不开窗口」的直接根因）──

test('utility 进程：即便有 electron 版本号也必须判为「不能开窗口」', () => {
  // 复现事故现场参数：utility + Electron 43 + 模块里没有 session/BrowserWindow
  const ok = canOpenElectronWindowWith({
    versions: { electron: '43.3.0' },
    processType: 'utility',
    loadElectron: () => ({}),
  })
  assert.equal(ok, false, 'utility 进程不能开窗口 —— 旧实现正是在这里假阳性通过')
})

test('主进程 + 有窗口 API：判为可以开窗口', () => {
  assert.equal(
    canOpenElectronWindowWith({
      versions: { electron: '43.3.0' },
      processType: 'browser',
      loadElectron: () => ({ session: {}, BrowserWindow: class {} }),
    }),
    true,
  )
})

test('renderer 进程：不能开窗口', () => {
  assert.equal(
    canOpenElectronWindowWith({ versions: { electron: '43.3.0' }, processType: 'renderer', loadElectron: () => ({ ipcRenderer: {} }) }),
    false,
  )
})

test('require("electron") 返回 npm 包路径字符串时不能开窗口', () => {
  // 纯 Node 里 require('electron') 返回的是二进制路径字符串（不是对象）
  assert.equal(
    canOpenElectronWindowWith({ versions: { electron: '43.3.0' }, processType: 'browser', loadElectron: () => 'C:\\path\\electron.exe' }),
    false,
  )
})

test('非 Electron 运行时（纯 node / web profile）不能开窗口', () => {
  assert.equal(canOpenElectronWindowWith({ versions: { node: '24.18.1' }, processType: undefined, loadElectron: () => ({}) }), false)
})

test('加载 electron 抛错时安全返回 false', () => {
  assert.equal(
    canOpenElectronWindowWith({
      versions: { electron: '43.3.0' },
      processType: 'browser',
      loadElectron: () => {
        throw new Error('MODULE_NOT_FOUND')
      },
    }),
    false,
  )
})

// ── 事故 ②：调试端口 ──

test('必须用 --remote-debugging-port=0（硬编码端口会撞 Windows 保留区间）', () => {
  const args = buildBrowserArgs('C:\\tmp\\profile', 'https://chat.deepseek.com/')
  const portArgs = args.filter((a) => a.startsWith('--remote-debugging-port='))
  assert.deepEqual(portArgs, ['--remote-debugging-port=0'], `端口参数只能是 0（由系统分配），实际 ${JSON.stringify(portArgs)}`)
})

test('启动参数：独立 profile + 不打扰用户日常浏览器 + 目标 URL', () => {
  const args = buildBrowserArgs('C:\\tmp\\p', 'https://chat.deepseek.com/')
  assert.ok(args.includes('--user-data-dir=C:\\tmp\\p'))
  assert.ok(args.includes('--no-first-run'))
  assert.ok(args.includes('--no-default-browser-check'))
  assert.ok(args.includes('https://chat.deepseek.com/'))
  assert.ok(!args.includes('--headless'), '登录窗口必须是可见的真实浏览器（否则 UA 是 HeadlessChrome 且 webdriver=true）')
})

test('parseDevToolsActivePort：取第一行端口，容忍 CRLF / 附带的 ws 路径', () => {
  assert.equal(parseDevToolsActivePort('6719\n/devtools/browser/abc'), 6719)
  assert.equal(parseDevToolsActivePort('6719\r\n/devtools/browser/abc\r\n'), 6719)
  assert.equal(parseDevToolsActivePort('  6719  \n'), 6719)
})

test('parseDevToolsActivePort：非法/越界值返回 undefined', () => {
  assert.equal(parseDevToolsActivePort(''), undefined)
  assert.equal(parseDevToolsActivePort('not-a-port'), undefined)
  assert.equal(parseDevToolsActivePort('0'), undefined)
  assert.equal(parseDevToolsActivePort('70000'), undefined)
  assert.equal(parseDevToolsActivePort(undefined), undefined)
})

// ── 凭证提取 ──

test('未登录时的真实形态 {"value":null,"__version":"0"} 必须解出空串', () => {
  // 这是实测抓到的原文（无头 Edge 打开 chat.deepseek.com 时 localStorage 的值）
  assert.equal(unwrapStoredToken('{"value":null,"__version":"0"}'), '')
  assert.equal(unwrapStoredToken('null'), '')
  assert.equal(unwrapStoredToken('undefined'), '')
})

test('AppKit 包装与裸 token 都能解出', () => {
  assert.equal(unwrapStoredToken('{"value":"dfbDggo_TOKEN","__version":"1.0.0"}'), 'dfbDggo_TOKEN')
  assert.equal(unwrapStoredToken('dfbDggo_BARE'), 'dfbDggo_BARE')
  assert.equal(unwrapStoredToken('{"value":123}'), '')
  assert.equal(unwrapStoredToken('{bad json'), '')
})

test('buildCookieHeader：只取 deepseek 域并拼成请求头', () => {
  const header = buildCookieHeader([
    { name: 'ds_session_id', value: 'abc', domain: '.deepseek.com' },
    { name: 'smidV2', value: 'xyz', domain: 'chat.deepseek.com' },
    { name: 'other', value: 'nope', domain: '.example.com' },
    { name: 2, value: 'bad' },
    null,
  ])
  assert.equal(header, 'ds_session_id=abc; smidV2=xyz')
})

test('pickExtraHeaders：收 x-* 指纹/版本头，排除每次请求新生成的头', () => {
  const picked = pickExtraHeaders({
    'X-Client-Version': '2.4.0',
    'x-client-platform': 'web',
    'accept-language': 'zh-CN',
    'x-ds-pow-response': 'should-not-keep',
    'x-hif-leim': 'should-not-keep-either',
    'content-type': 'application/json',
  })
  assert.deepEqual(picked, { 'x-client-version': '2.4.0', 'x-client-platform': 'web', 'accept-language': 'zh-CN' })
})

test('findSystemBrowser：返回可执行文件确实存在（或明确为 null）', () => {
  const browser = findSystemBrowser()
  if (browser === null) return // 允许机器上确实没装
  assert.ok(browser.name && browser.path, JSON.stringify(browser))
  assert.ok(existsSync(browser.path), `返回的路径必须存在：${browser.path}`)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
