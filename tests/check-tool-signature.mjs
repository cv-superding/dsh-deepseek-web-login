// 本文件测的是**详细渲染**（参数说明、3200 上限）：显式关掉紧凑模式。
// 紧凑模式的行为由 tests/check-compact-tools.mjs 单独守（默认开）。
process.env.DSH_WEB_LOGIN_COMPACT_TOOLS = '0'
// 长尾也用 full 档：这两个文件测的是**完整渲染**（含长尾描述）。
process.env.DSH_WEB_LOGIN_TAIL_TOOLS = 'full'

/**
 * 回归：工具参数必须以「紧凑类型签名」下发，而不是原样贴 JSON（0.6.0）。
 *
 * 为什么：原先直接贴 `JSON.stringify(parameters)`。那串文本里**结构性样板**占大头 ——
 * 每个参数都要套一层 `{"type":"…","description":"…"}`、键名与类型值全带引号，
 * 而模型写出 arguments 真正需要的只是**参数名、类型、必填性**。
 *
 * ⚠️ 形态取自**真实数据**（2026-09-27 从 `@deepseek-ai/dsh-tool-*` 的 lib/index.js 提取）：
 * DSH 自家工具清一色写**扁平**形态 —— 顶层键直接是参数名、`required: true` 挂在参数自己身上，
 * **没有 `properties` 包裹**。而 `dsh-tools` 的 `schemaOf()` 把它**原样透传**给 provider
 * （不规范化）。第一版实现只认标准包裹形态 ⇒ 会把**所有参数渲染成空**，这个文件就是防它的。
 *
 * 用法: node tests/check-tool-signature.mjs
 */
import assert from 'node:assert/strict'
import { buildToolSection, buildToolSignature } from '../src/protocol.ts'

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

/** 只取签名首行（参数列表那行），忽略下面的参数描述。 */
const head = (sig) => String(sig ?? '').split('\n')[0]

// ── 真实样本：DSH 扁平形态 ──────────────────────────────────────
const REAL = {
  bash: {
    name: 'bash',
    description: 'Run a bash command in the sandbox.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description:
          'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
      },
    },
  },
  read: {
    name: 'read',
    description: 'Read a file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Max lines to return.' },
    },
  },
  todo_write: {
    name: 'todo_write',
    description: 'Write the task list.',
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is.' },
            status: { type: 'string', required: true, description: 'One of pending/in_progress/completed.' },
          },
        },
      },
    },
  },
  str_replace_editor: {
    name: 'str_replace_editor',
    description: 'Edit a file.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['view', 'create', 'str_replace', 'insert'],
        description: 'The command to run.',
      },
      path: { type: 'string', required: true, description: 'Path to the file.' },
    },
  },
  read_goal: { name: 'read_goal', description: 'Read the current goal.', parameters: {} },
}
const ALL_REAL = Object.values(REAL)

// ── DSH 扁平形态 ────────────────────────────────────────────────

test('扁平形态：必填不带 ?、可选带 ?，描述缩进列在下面', () => {
  const sig = buildToolSignature(REAL.read)
  assert.equal(head(sig), 'read(file_path: string, offset?: number, limit?: number)')
  assert.ok(sig.includes('  file_path: Path to read, resolved by the filesystem backend.'))
  assert.ok(sig.includes('  offset: 1-based first line to return. Defaults to 1.'))
})

test('扁平形态：`required: true` 挂在参数自己身上也认', () => {
  assert.equal(head(buildToolSignature(REAL.bash)), 'bash(command: string, description: string)')
})

test('扁平形态：数组 + 嵌套对象', () => {
  assert.equal(head(buildToolSignature(REAL.todo_write)), 'todo_write(todos: {content: string, status: string}[])')
})

test('扁平形态：枚举是**值**联合，必须带引号', () => {
  assert.equal(
    head(buildToolSignature(REAL.str_replace_editor)),
    'str_replace_editor(command: "view" | "create" | "str_replace" | "insert", path: string)',
  )
})

test('扁平形态：无参数工具 / parameters 缺失 / 异常值都不炸', () => {
  assert.equal(buildToolSignature(REAL.read_goal), 'read_goal()')
  assert.equal(buildToolSignature({ name: 'x', description: '', parameters: undefined }), 'x()')
  assert.equal(buildToolSignature({ name: 'x', description: '', parameters: [] }), 'x()')
})

// ── 标准包裹形态（第三方工具可能按 OpenAI 惯例写）───────────────

test('标准包裹形态：properties + 顶层 required 数组', () => {
  const sig = buildToolSignature({
    name: 't',
    description: 'd',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The path.' }, limit: { type: 'number' } },
      required: ['path'],
    },
  })
  assert.equal(head(sig), 't(path: string, limit?: number)')
})

test('顶层只出现 schema 关键字时才当标准包裹（否则那些键是参数名）', () => {
  // 键 `properties` 之外的兄弟键 ⇒ 说明这是扁平形态，不是包裹
  const sig = buildToolSignature({
    name: 't',
    description: '',
    parameters: { properties: { type: 'string', required: true } },
  })
  assert.equal(head(sig), 't(properties: string)')
})

// ── 类型细节 ────────────────────────────────────────────────────

test('数组没给 items ⇒ any[]', () => {
  const sig = buildToolSignature({ name: 't', description: '', parameters: { xs: { type: 'array', required: true } } })
  assert.equal(head(sig), 't(xs: any[])')
})

test('联合类型的数组要加括号，不能读成 `string | number[]`', () => {
  const sig = buildToolSignature({
    name: 't',
    description: '',
    parameters: {
      xs: { type: 'array', required: true, items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    },
  })
  assert.equal(head(sig), 't(xs: (string | number)[])')
})

test('anyOf 去重（两个分支同类型不重复写）', () => {
  const sig = buildToolSignature({
    name: 't',
    description: '',
    parameters: { x: { required: true, anyOf: [{ type: 'string' }, { type: 'string' }] } },
  })
  assert.equal(head(sig), 't(x: string)')
})

test('嵌套过深退化成 any，不许无限展开', () => {
  let deep = { type: 'string' }
  for (let i = 0; i < 8; i += 1) deep = { type: 'object', required: true, properties: { nested: deep } }
  const sig = buildToolSignature({ name: 't', description: '', parameters: deep })
  assert.ok(sig.includes('any'), `深层应收敛成 any：${sig}`)
  assert.ok(sig.length < 200, `不许无限展开，实际 ${sig.length} 字符`)
})

test('自引用 schema 不会死循环', () => {
  const self = { type: 'object', properties: {} }
  self.properties.self = self
  const sig = buildToolSignature({ name: 't', description: '', parameters: self })
  assert.ok(typeof sig === 'string' && sig.length < 400, `实际 ${sig && sig.length}`)
})

test('additionalProperties 只在"有实质约束"时渲染', () => {
  const withSchema = buildToolSignature({
    name: 't',
    description: '',
    parameters: { extra: { type: 'object', additionalProperties: { type: 'number' } } },
  })
  assert.ok(withSchema.includes('[key: string]: number'), withSchema)
  const off = buildToolSignature({
    name: 't',
    description: '',
    parameters: { opts: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } } },
  })
  assert.ok(!off.includes('[key: string]'), `false 不该渲染：${off}`)
})

test('没有描述的参数不占额外行', () => {
  assert.equal(buildToolSignature({ name: 't', description: '', parameters: { a: { type: 'string' } } }), 't(a?: string)')
})

test('超长参数描述截断到 160 并带省略号', () => {
  const sig = buildToolSignature({
    name: 't',
    description: '',
    parameters: { a: { type: 'string', description: 'z'.repeat(500) } },
  })
  assert.ok(sig.includes('z'.repeat(157) + '...'), '应截到 160')
  assert.ok(!sig.includes('z'.repeat(161)), '不应超过 160')
})

test('参数描述里的换行被压平', () => {
  const sig = buildToolSignature({
    name: 't',
    description: '',
    parameters: { a: { type: 'string', description: 'line1\n\n  line2   line3' } },
  })
  assert.ok(sig.includes('  a: line1 line2 line3'), sig)
})

// ── 目录级：改动不能把别的性质弄坏 ──────────────────────────────

test('工具目录里不再出现 JSON 样板', () => {
  const section = buildToolSection(ALL_REAL)
  assert.ok(!section.includes('"type":'), '仍在贴 JSON 原文')
  assert.ok(!section.includes('"properties":'), '仍在贴 JSON 原文')
  assert.ok(!section.includes('Parameters (JSON Schema)'), '旧前缀还在')
})

test('每个真实工具的参数名都还在（不许静默丢参数）', () => {
  const section = buildToolSection(ALL_REAL)
  for (const name of ['command', 'description', 'file_path', 'offset', 'limit', 'todos', 'content', 'status', 'path']) {
    assert.ok(section.includes(name), `参数 ${name} 不见了`)
  }
})

test('核心工具的工具级描述不受影响（仍归 MAX_DESCRIPTION_CHARS=3200 管）', () => {
  const long = 'D'.repeat(3100)
  // ⚠️ 用核心工具名 —— 长尾工具的描述上限是 240（0.6.1 的分级）。
  const section = buildToolSection([{ name: 'pwsh', description: long, parameters: { a: { type: 'string' } } }])
  assert.ok(section.includes(long), '3100 字符的工具描述必须完整保留')
})

test('渲染是确定的：同一输入两次逐字节相同（head 不许抖）', () => {
  assert.equal(buildToolSection(ALL_REAL), buildToolSection(ALL_REAL))
})

test('紧凑签名显著短于原始 JSON', () => {
  const oldLen = ALL_REAL.reduce((sum, t) => sum + JSON.stringify(t.parameters ?? {}).length, 0)
  const newLen = ALL_REAL.reduce((sum, t) => sum + String(buildToolSignature(t) ?? '').length, 0)
  const saved = 1 - newLen / oldLen
  assert.ok(saved > 0.3, `参数段只省了 ${Math.round(saved * 100)}%，预期 > 30%`)
})

// ── 描述分级（0.6.1）：核心保留、长尾压缩，但**两级都能调用** ──────

const CORE_SAMPLE = {
  name: 'pwsh',
  description: 'P'.repeat(2000),
  parameters: { command: { type: 'string', required: true, description: 'The PowerShell command to execute.' } },
}
const TAIL_SAMPLE = {
  name: 'job_list',
  description: 'T'.repeat(1000),
  parameters: { limit: { type: 'number', description: 'Max rows to return.' } },
}

test('分级：核心工具的描述完整、且带参数说明', () => {
  const section = buildToolSection([CORE_SAMPLE])
  assert.ok(section.includes('P'.repeat(2000)), '核心工具的描述不该被压')
  assert.ok(section.includes('  command: The PowerShell command to execute.'), '核心工具应带参数说明')
})

test('分级：长尾工具压成**一行**（`签名` — 首句），不带参数说明', () => {
  const section = buildToolSection([TAIL_SAMPLE])
  assert.ok(section.includes('- `job_list(limit?: number)` —'), '长尾应是一行：`签名` — 首句')
  assert.ok(!section.includes('T'.repeat(200)), '首句该被截断（上限 160）')
  assert.ok(!section.includes('  limit: Max rows to return.'), '长尾工具不该带参数说明')
  assert.ok(!section.includes('### job_list'), '长尾工具不该再占一整个小节')
})

test('分级：长尾工具照样能调用（名字与参数签名一个字都不少）', () => {
  const section = buildToolSection([TAIL_SAMPLE])
  assert.ok(section.includes('## Other tools'), '长尾该有自己的小节标题')
  assert.ok(
    section.includes('job_list(limit?: number)'),
    '名字与参数签名必须都在 —— 否则模型不知道它存在、也不知道怎么传参',
  )
})

test('分组：核心在前、长尾在后，各自组内保持原序', () => {
  const tools = [CORE_SAMPLE, TAIL_SAMPLE, REAL.read]
  const section = buildToolSection(tools)
  const at = (n) => section.indexOf(n + '(')
  assert.ok(at('pwsh') < at('read'), '核心组内原序被打乱')
  assert.ok(at('read') < at('job_list'), '核心工具必须排在长尾之前（长尾在一行小节里）')
})

test('分级后 61 个工具全装得下（每个描述 2500 字符）', () => {
  const coreNames = [
    'pwsh', 'bash', 'run_code', 'read', 'write', 'edit', 'grep', 'glob', 'ls',
    'todo_write', 'skill', 'present', 'ask_user_question',
  ]
  const make = (name) => ({
    name,
    description: 'D'.repeat(2500),
    parameters: { a: { type: 'string', required: true, description: 'x'.repeat(150) } },
  })
  const tools = [
    ...coreNames.map(make),
    ...Array.from({ length: 48 }, (_, i) => make(`tail_${String(i).padStart(2, '0')}`)),
  ]
  assert.equal(tools.length, 61)
  const section = buildToolSection(tools)
  assert.ok(!section.includes('NOT described above'), '分级后不该再触发"省略工具"兜底')
  // ⚠️ 判据是 `name(`（名字 + 参数签名），不是 `### name` —— 长尾现在是一行格式，没有 `###`。
  const missing = tools.filter((t) => !section.includes(t.name + '('))
  assert.equal(missing.length, 0, `缺失：${missing.map((t) => t.name).join(', ')}`)
  assert.ok(section.length < 56_000, `目录 ${section.length} 字符，超上限`)
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
const oldLen = ALL_REAL.reduce((sum, t) => sum + JSON.stringify(t.parameters ?? {}).length, 0)
const newLen = ALL_REAL.reduce((sum, t) => sum + String(buildToolSignature(t) ?? '').length, 0)
console.log(`通过 ${passed} 项，失败 0 项（参数段 ${oldLen} → ${newLen} 字符，省 ${Math.round((1 - newLen / oldLen) * 100)}%）`)
