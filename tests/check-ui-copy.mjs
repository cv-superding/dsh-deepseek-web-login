/**
 * 回归：给用户看的文案与「醒目度」（2026-09-15，用户反馈）。
 *
 * 起因：用户截图指出「账号切换失败」那行报错和旁边的说明文字长得一模一样（都是灰色小字），
 * 根本注意不到；同时要求重要提示要有标注（emoji 可以）。
 *
 * 本文件守三件事：
 *  1. **界面是纯文本 —— 文案里不许出现 markdown 星号**。写 `**凭证**` 会在界面上原样显示成
 *     `**凭证**`。这条规矩我踩过不止一次（skill 里专门记着），所以做成自动检查。
 *     注：`src/adapter.ts` 里 `endsWith('**')` 是**故意**的（识别模型输出的 markdown 粗体），
 *     所以只扫"界面文案所在的那几个文件"，不做全仓扫描。
 *  2. 反馈节点必须**自动选样式**（失败→红框），而不是靠每个调用点传 kind（40+ 个点，迟早漏）。
 *  3. 关键徽章带 emoji，一眼能分出"能用 / 要修 / 被限"。
 *
 * 用法: node tests/check-ui-copy.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CLIENT = readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8')
const COOKIES = readFileSync(join(ROOT, 'src/cookies.ts'), 'utf8')
// 0.1.66：host 侧也有会显示在面板上的文案 —— 原来只扫 client/cookies，
// 于是 transport.ts 里一处 `**系统代理**` 一直漏着（界面把它原样显示成带星号）。
const TRANSPORT = readFileSync(join(ROOT, 'src/transport.ts'), 'utf8')
const CONTEXT_FEED = readFileSync(join(ROOT, 'src/context-feed.ts'), 'utf8')

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(` ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(` ✗ ${name}\n   ${error?.message ?? error}`)
  }
}

/** 找「单引号字符串里出现 **」的行（同一行内、同一个引号对）。 */
function markdownAsteriskLines(source) {
  return source
    .split('\n')
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => /'[^'\n]*\*\*/.test(line))
}

test('界面文案里没有 markdown 星号（会被原样显示成 **xxx**）', () => {
  const hits = markdownAsteriskLines(CLIENT)
  assert.deepEqual(
    hits.map(([n, line]) => `${n}: ${line.trim().slice(0, 60)}`),
    [],
    '改成 emoji 或去掉星号；界面是纯文本，不解析 markdown',
  )
})

test('cookies 的说明文案同样没有 markdown 星号', () => {
  const hits = markdownAsteriskLines(COOKIES)
  assert.deepEqual(hits.map(([n]) => n), [])
})

test('host 侧的面板文案也没有 markdown 星号（0.1.66 补上这半边）', () => {
  // 自证：这两个文件里确实有会显示在面板上的提示文案，不是空扫
  assert.ok(/TRANSPORT_HINT/.test(TRANSPORT), '自证：transport.ts 确实有面板提示常量')
  assert.ok(/CONTEXT_MODE_HINT/.test(CONTEXT_FEED), '自证：context-feed.ts 确实有面板提示常量')
  for (const [label, src] of [['transport.ts', TRANSPORT], ['context-feed.ts', CONTEXT_FEED]]) {
    const hits = markdownAsteriskLines(src)
    assert.deepEqual(
      hits.map(([n, line]) => `${label}:${n}: ${line.trim().slice(0, 60)}`),
      [],
      '界面是纯文本，`**xxx**` 会原样显示',
    )
  }
})

test('反馈节点自动选样式：失败红框、成功绿框、其余灰色', () => {
  assert.ok(/const createMsgNode = \(\)/.test(CLIENT), 'createMsgNode 必须存在')
  assert.ok(
    /\/失败\|错误\|无法\|不对(\|⚠️)?\/\.test\(text\)\s*\?\s*'dsw-msg err'/.test(CLIENT),
    '失败类消息必须挂 dsw-msg err（红框红字）',
  )
  assert.ok(/\?\s*'dsw-msg ok'/.test(CLIENT), '成功类消息挂 dsw-msg ok')
  assert.ok(/'dsw-hint dsw-gate-msg'/.test(CLIENT), '其余保持灰色小字')
})

test('三张卡都用自动醒目节点（且 append 的是 .node）', () => {
  for (const name of ['accountsMsg', 'transportMsg', 'contextMsg']) {
    assert.ok(new RegExp(`const ${name} = createMsgNode\\(\\)`).test(CLIENT), `${name} 应改用 createMsgNode()`)
    assert.ok(
      new RegExp(`append\\(${name}\\.node\\)`).test(CLIENT),
      `${name} 必须 append 它的 .node（append 包装对象会挂不上 DOM）`,
    )
  }
})

test('关键徽章带 emoji（能用 / 要修 / 被限 一眼可分）', () => {
  for (const marker of ['✅ 当前', '❔ 未校验', '⏳ 受限至', '❌ 需要重新登录', '❌ 登录态校验失败']) {
    assert.ok(CLIENT.includes(marker), `缺少徽章标记 ${marker}`)
  }
  assert.ok(COOKIES.includes('⚠️ 未记录'), 'cookie 未记录那条要带 ⚠️')
})

test('凭证风险提示带 ⚠️（这是最需要被看见的一条）', () => {
  assert.ok(CLIENT.includes('⚠️ 导出的备份文件就是可完整登录的凭证'), '导出备份的风险提示')
  assert.ok(CLIENT.includes('⚠️ 账号库里每个文件都是可完整登录的凭证'), '关于页的数据位置提示')
})

// ── 0.1.65：重新登录按钮的位置 + ⚠️ 也算醒目 ──────────────────────────────

test('「重新登录」按钮在右侧动作列里（不再独占一行）', () => {
  const actionsIdx = CLIENT.indexOf("const actions = el('div', 'dsw-account-actions')")
  const reloginIdx = CLIENT.indexOf('reloginAccount(item.id')
  assert.ok(actionsIdx > 0, '找不到动作列')
  assert.ok(reloginIdx > actionsIdx, 'relogin 按钮必须建在动作列之后 —— 即属于那一列（用户反馈：别单独占一行）')
})

test('失败说明那块里不再放按钮（用户反馈太占空间）', () => {
  const start = CLIENT.indexOf("'dsw-account-fix'")
  const end = CLIENT.indexOf("const actions = el('div', 'dsw-account-actions')")
  assert.ok(start > 0 && end > start, '定位失败说明块失败')
  const block = CLIENT.slice(start, end)
  assert.ok(!/dsw-btn/.test(block), '失败说明块只能放文字，按钮要挪到动作列')
})

test('醒目样式也认 ⚠️ 前缀（重要提醒不该是灰字）', () => {
  assert.ok(/\|⚠️\/\.test\(text\)/.test(CLIENT), '自动样式判定要包含 ⚠️')
})

console.log(failed === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failed} 项 ❌`)
if (failed > 0) process.exitCode = 1
