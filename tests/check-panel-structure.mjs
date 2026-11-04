/**
 * 结构契约：设置页的**页签栏 + pane 挂载**必须真的存在。
 *
 * 🔴 为什么需要这条：2026-11-03 删「内置浏览器」时，通用页签栏构造紧跟在被删的
 * `browserPane` 块后面，被整段划进删除范围 —— 结果设置页只剩标题，7 个 pane 一个都没挂到
 * 页面上。而当时 `check-bundle` 的判据是 `client.includes('dsw-tabs')`，被**残留的 CSS 规则**
 * 满足 ⇒ 全量用例 73/73 全绿、CI 也绿，这个 P0 直接过了。
 *
 * 加强后的产物判据（`check-bundle` 里"dsw-tabs 出现 ≥2 次"）依然抓不到"创建了但没挂载"，
 * 所以这里对**源码**做结构断言：拼装步骤一步都不许少。
 *
 * 用法: node tests/check-panel-structure.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')

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

test('页签栏被创建（dsw-tabs + role=tablist）', () => {
  assert.ok(source.includes("el('div', 'dsw-tabs')"), '没有创建页签栏容器')
  assert.ok(/tabBar\.setAttribute\('role', 'tablist'\)/.test(source), '页签栏缺少 role=tablist')
})

test('每个页签都注册了点击与 pane 的 aria 角色', () => {
  assert.ok(source.includes('for (const key of TAB_KEYS)'), '没有遍历 TAB_KEYS 建按钮')
  assert.ok(/btn\.addEventListener\('click', \(\) => selectTab\(key\)\)/.test(source), '页签按钮没接切换')
  assert.ok(/tabButtons\[key\] = btn/.test(source), '页签按钮没登记（selectTab 会 TypeError）')
  assert.ok(/panes\[key\]\.setAttribute\('role', 'tabpanel'\)/.test(source), 'pane 缺少 role=tabpanel')
})

test('🔴 pane 必须真的挂到页面上（删了这步 ⇒ 整页空白）', () => {
  assert.ok(
    /page\.append\(tabBar, \.\.\.TAB_KEYS\.map\(\(key\) => panes\[key\]\)\)/.test(source),
    '没有把页签栏与 pane 挂到 page 上 —— 设置页会只剩标题',
  )
})

test('🔴 初始必须选中一页（否则 7 个 pane 全部同时显示）', () => {
  /**
   * ⚠️ 必须匹配**代码行的形状**：注释里也写了 `selectTab('account')`（解释"为什么要保留它"），
   * 用裸子串查会被自己的注释满足 —— 变异验证时已经踩过一次。
   */
  assert.ok(/^\s+selectTab\('account'\)\s*$/m.test(source), '缺少初始 selectTab(account)')
})

test('TAB_KEYS / TAB_LABELS / panes 三个映射的键集合一致', () => {
  const keys = /const TAB_KEYS = \[([^\]]+)\]/.exec(source)?.[1]
  assert.ok(keys, 'TAB_KEYS 未找到')
  const keyList = [...keys.matchAll(/'([a-z]+)'/g)].map((m) => m[1])

  const labelsBlock = /const TAB_LABELS: Record<string, string> = \{([\s\S]*?)\n {4}\}/.exec(source)?.[1]
  assert.ok(labelsBlock, 'TAB_LABELS 未找到')
  const labelKeys = [...labelsBlock.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1])

  const panesBlock = /const panes: Record<string, HTMLElement> = \{([\s\S]*?)\n {4}\}/.exec(source)?.[1]
  assert.ok(panesBlock, 'panes 未找到')
  const paneKeys = [...panesBlock.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1])

  assert.deepEqual(labelKeys, keyList, `TAB_LABELS 与 TAB_KEYS 不一致：${labelKeys} vs ${keyList}`)
  assert.deepEqual(paneKeys, keyList, `panes 与 TAB_KEYS 不一致：${paneKeys} vs ${keyList}`)
})

test('每个 pane 容器都被创建过（不是只声明了映射）', () => {
  const created = [...source.matchAll(/const (\w+Pane) = el\('div', 'dsw-pane'\)/g)].map((m) => m[1])
  for (const name of ['accountPane', 'modelPane', 'tokenPane', 'gatePane', 'transportPane', 'contextPane', 'aboutPane']) {
    assert.ok(created.includes(name), `${name} 没有创建`)
  }
})

test('🔴 每个 pane 都必须真的被填进内容（"建了不挂" = 整页空白）', () => {
  const required = [
    ['acctStatusPane', '登录状态子页'],
    ['acctLibraryPane', '账号库子页'],
    ['modelPane', '模型页'],
    ['tokenPane', 'Token 统计页'],
    ['gatePane', '防风控页'],
    ['transportPane', '传输层页'],
    ['contextPane', '上下文页'],
    ['aboutPane', '关于页'],
  ]
  for (const [pane, label] of required) {
    // ⚠️ 必须是**代码行形状**：注释里也会写同样的调用（解释为什么要有它），裸子串会被注释满足
    const re = new RegExp(`^\\s+${pane}\\.append\\s*\\(`, 'm')
    assert.ok(re.test(source), `${label}（${pane}）没有 append 任何内容 —— 会整页空白`)
  }
})

test('🔴 网页版按钮必须打开**传输层**分区（不是登录用的 browser-profile）', () => {
  // 2026-11-04 用户实测：点开的是 browser-profile，页面停在 sign_in —— 那个分区没登录过，
  // 而发请求、要过人机验证的是 transport-profile。开错分区等于给用户一个空白登录页。
  // 路由在**主机侧**（src/index.ts），不在客户端源码里
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const at = host.indexOf("route === '/open-web'")
  assert.ok(at > 0, '/open-web 路由不见了')
  const route = host.slice(at, at + 900)
  assert.ok(route.includes('transport-profile'), '必须用 transport-profile 开窗口')
  assert.ok(route.includes('shutdownBrowserTransport'), '必须先关掉无头传输，否则 URL 会被转发给无头实例（用户看不到）')
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
