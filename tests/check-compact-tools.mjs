/**
 * 紧凑工具目录（默认开，2026-11-04）。
 *
 * 为什么要有这个文件：`check-tools-section` / `check-tool-signature` 测的是**详细渲染**
 * （参数说明、3200 上限），它们把 `DSH_WEB_LOGIN_COMPACT_TOOLS=0` 写死了 ⇒ **默认档没人守**。
 * 这里专门守默认档：宿主给的超长描述必须被截短，参数只留名字与类型。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-compact-tools-'))
delete process.env.DSH_WEB_LOGIN_COMPACT_TOOLS

const { buildToolSection } = await import('../src/protocol.ts')

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

const LONG = 'Sandbox rules and mode details. '.repeat(120).trim()

const tools = [
  {
    name: 'edit',
    description: LONG,
    parameters: {
      file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend.', required: true },
      old_string: { type: 'string', description: 'Literal text to replace.', required: true },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
    },
  },
  { name: 'read', description: 'Read a UTF-8 text file.', parameters: { file_path: { type: 'string', required: true } } },
]

await test('工具描述被截到 ~220（宿主原文能到两千字符）', () => {
  const section = buildToolSection(tools, 56000)
  assert.ok(section.length < 2_000, `目录还是太长：${section.length}`)
  const shellBlock = section.slice(section.indexOf('### edit'), section.indexOf('### read'))
  assert.ok(shellBlock.length < 600, `单个工具的块太长：${shellBlock.length}`)
  assert.ok(/\.\.\./.test(shellBlock), '截断没有省略号（模型会以为描述到此为止）')
})

await test('参数只留名字与类型，不发行说明', () => {
  const section = buildToolSection(tools, 56000)
  assert.ok(section.includes('edit(file_path: string, old_string: string, timeoutMs?: number)'), `签名丢了：${section.slice(0, 200)}`)
  assert.ok(!section.includes('Path to edit, resolved by the filesystem backend'), '参数说明还在')
  assert.ok(!section.includes('Timeout in milliseconds'), '参数说明还在')
})

await test('必填/可选的 ? 标记仍然准确（压缩不能把语义压没了）', () => {
  const section = buildToolSection(tools, 56000)
  assert.ok(/edit\(file_path: string, old_string: string, timeoutMs\?: number\)/.test(section), '可选参数没带 ?')
  assert.ok(/read\(file_path: string\)/.test(section), '必填参数不该带 ?')
})

await test('工具名与"这工具干什么"的那句话必须留着', () => {
  const section = buildToolSection(tools, 56000)
  assert.ok(section.includes('### read'), '工具名丢了')
  assert.ok(section.includes('Read a UTF-8 text file.'), '工具用途描述丢了')
})

// ── 长尾策略（2026-11-04）：默认 `hide`，只留白名单 + 一句"还有 N 个但没写" ──
const tailTools = [
  ...['read_image', 'web_search', 'web_fetch'].map((n) => ({ name: n, description: 'useful', parameters: { q: { type: 'string' } } })),
  ...['team_task_create', 'session_search', 'terminal_open', 'ralph', 'workflow', 'create_worktree'].map((n) => ({
    name: n,
    description: 'A long explanation the model rarely needs. '.repeat(3).trim(),
    parameters: { p: { type: 'string' } },
  })),
]

await test('长尾默认 hide：只留白名单，且明确说"其余工具没写、参数不可猜"', () => {
  delete process.env.DSH_WEB_LOGIN_TAIL_TOOLS
  const section = buildToolSection([...tools, ...tailTools], 56000)
  assert.ok(section.includes('web_search'), '白名单工具该留')
  assert.ok(!section.includes('team_task_create'), '实验性工具该被藏起来')
  assert.ok(!section.includes('session_search'), '实验性工具该被藏起来')
  assert.ok(section.includes('more tools exist'), '必须告诉模型"还有别的工具但没写"（否则它会瞎猜参数）')
  assert.ok(section.includes('NOT guessable'), '必须明确禁止猜参数')
})

await test('长尾 names 档：全部都列（签名），但只列签名', () => {
  process.env.DSH_WEB_LOGIN_TAIL_TOOLS = 'names'
  try {
    const section = buildToolSection([...tools, ...tailTools], 56000)
    assert.ok(section.includes('team_task_create'), 'names 档该列出全部')
    assert.ok(!section.includes('A long explanation'), 'names 档不该带描述')
  } finally {
    delete process.env.DSH_WEB_LOGIN_TAIL_TOOLS
  }
})

await test('长尾 full 档：签名 + 描述（老行为）', () => {
  process.env.DSH_WEB_LOGIN_TAIL_TOOLS = 'full'
  try {
    const section = buildToolSection([...tools, ...tailTools], 56000)
    assert.ok(section.includes('team_task_create'), 'full 档该列出全部')
    assert.ok(section.includes('A long explanation'), 'full 档该带描述')
  } finally {
    delete process.env.DSH_WEB_LOGIN_TAIL_TOOLS
  }
})

if (failures.length) {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`\n通过 ${passed} 项，全部通过 ✅`)
