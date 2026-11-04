// 本文件测的是**详细渲染**（参数说明、3200 上限）：显式关掉紧凑模式。
// 紧凑模式的行为由 tests/check-compact-tools.mjs 单独守（默认开）。
process.env.DSH_WEB_LOGIN_COMPACT_TOOLS = '0'

/**
 * 回归：工具目录（buildToolSection）必须把 DSH 下发的**全部**工具告诉模型。
 *
 * 现场（2026-09-12 实测，session-15ac4c56 的 `request/header`）：
 *   DSH 下发 **61 个工具**，不截描述时共需 **50,942 字符**
 *   而插件 `MAX_TOOLS_SECTION_CHARS = 24_000` → **只装下 35 个，26 个完全没告知模型**
 *
 *   ⚠️ 更糟的是截断按**字母序**发生（工具按名排序），于是
 *      write(w) / web_search / web_fetch / subagent / subagent_fork / todo_write / skill /
 *      read_image / 全部 ssh_* / sftp_* / tunnel_start / tunnel_stop / update_goal 被砍，
 *      而极少用的 db_tx_rollback / db_list_connections / job_list 反而留下。
 *      **write 恰恰是 ~/.dsh/deepseek-web/rejected.jsonl 里失败最多的工具**
 *      （27616 字符 unbalanced、13480 字符 echo）。
 *
 *   另一头：`MAX_DESCRIPTION_CHARS = 400` 把 **17 个**工具的描述砍了：
 *      `pwsh` 3010→400（丢 87%）、`workflow` 2500→400（丢 84%）。
 *      而丢掉的正是**遇错该怎么办**的指引 —— 沙箱拒绝不是命令的 bug 别换方式重试、
 *      命名管道不可用会让 stdio:'pipe' 的 spawn 报 EPERM、只读沙箱下 .NET 静态调用会失败。
 *      workflow 丢掉的是 agent()/pipeline()/parallel() 的钩子签名。
 *
 * 用法: node tests/check-tools-section.mjs
 */
import assert from 'node:assert/strict'
import { buildToolSection, serializePrompt } from '../src/protocol.ts'

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

/**
 * 工具是否出现在目录里。
 *
 * ⚠️ 判据是 `name(`（工具名 + 参数签名），**不是** `### name`：
 * 0.6.2 起长尾工具改成**一行格式**（`- \`name(签名)\` — 首句`），不再有 `###` 前缀。
 * 用 `### name` 判会把 48 个长尾工具全判成"丢失"。
 */
const hasTool = (text, name) => text.includes(name + '(')

/** 造一个工具；descLen 控制描述长度，用于逼近预算边界。 */
const mkTool = (name, descLen = 60) => ({
  name,
  description: 'D'.repeat(descLen),
  parameters: { type: 'object', properties: { a: { type: 'string' } } },
})

// ── 数量：一个都不能少 ──────────────────────────────────────────

test('61 个工具（贴近实测规模）必须全部出现在目录里', () => {
  const tools = Array.from({ length: 61 }, (_, i) => mkTool(`tool_${String(i).padStart(2, '0')}`, 400))
  const section = buildToolSection(tools)
  const missing = tools.filter((t) => !hasTool(section, t.name))
  assert.equal(missing.length, 0, `缺失：${missing.map((t) => t.name).join(', ')}`)
  assert.ok(!section.includes('NOT described above'), '不该触发"省略"提示')
})

test('规模与实测一致时也不触发省略（61 个工具，每个约 800 字符描述）', () => {
  const tools = Array.from({ length: 61 }, (_, i) => mkTool(`t${String(i).padStart(2, '0')}`, 800))
  const section = buildToolSection(tools)
  const missing = tools.filter((t) => !hasTool(section, t.name))
  assert.equal(missing.length, 0, `缺失 ${missing.length} 个：${missing.slice(0, 6).map((t) => t.name).join(', ')}…`)
})

test('旧 bug 再现防护：名字以 w 开头、排序靠后的工具不会被砍（write 那类）', () => {
  // 旧实现按数组顺序吃预算，字母序里 w 开头的工具最先被牺牲
  const tools = [
    ...Array.from({ length: 40 }, (_, i) => mkTool(`a${String(i).padStart(2, '0')}`, 100)),
    mkTool('write', 200),
    mkTool('web_search', 200),
    mkTool('web_fetch', 200),
  ]
  const section = buildToolSection(tools)
  for (const name of ['write', 'web_search', 'web_fetch']) {
    assert.ok(hasTool(section, name), `${name} 被截断了`)
  }
})

// ── 描述长度：不许砍掉"遇错该怎么办" ──────────────────────────

test('3010 字符的长描述（pwsh 那类）必须完整保留', () => {
  const long = 'Execute a shell command. ' + 'When the sandbox denies a file operation, that is a policy denial, not a bug. '.repeat(40)
  assert.ok(long.length > 3010, `样本长度 ${long.length} 应 > 3010`)
  const section = buildToolSection([mkTool('pwsh', 0), { name: 'pwsh', description: long, parameters: {} }])
  assert.ok(section.includes('policy denial, not a bug'), '长描述里的关键指引被砍了')
  assert.ok(section.includes(long.slice(0, long.length - 1)), '描述未完整保留')
})

test('3200 是**核心工具**的描述上限，不是 400', () => {
  const d = 'x'.repeat(3100)
  // ⚠️ 必须用核心工具名：0.6.1 起长尾工具的描述上限是 240 字符（分级见 check-tool-signature）。
  const section = buildToolSection([{ name: 'pwsh', description: d, parameters: {} }])
  assert.ok(section.includes(d), '3100 字符的描述应当完整保留（旧上限 400 会截掉 87%）')
})

test('核心工具描述超过 3200 才截断，且带省略号', () => {
  const section = buildToolSection([{ name: 'pwsh', description: 'y'.repeat(5000), parameters: {} }])
  assert.ok(section.includes('y'.repeat(3197) + '...'), '应截到 3200 并带省略号')
  assert.ok(!section.includes('y'.repeat(3201)), '不应超过 3200')
})

// ── 兜底：真装不下时必须"说出名字"，不许静默丢弃 ───────────────

test('超出预算时必须列出被省略的工具名（旧实现只写一句 remaining tools omitted）', () => {
  // ⚠️ 长尾工具的体积一路在降：0.6.1 描述压到 240、0.6.2 更是**一行**（首句 ≤160）⇒
  // 原来 90 个、后来 250 个都已撑不爆预算，得加到 400 个。
  const tools = Array.from({ length: 400 }, (_, i) => mkTool(`tool_${String(i).padStart(3, '0')}`, 1300))
  const section = buildToolSection(tools)
  assert.ok(/NOT described above/.test(section), '必须明确告知有工具未被描述')
  assert.ok(section.includes('tool_399'), '最后一个被省略的工具名必须列出来')
  assert.ok(/omitted for length/.test(section), '应说明省略原因')
})

test('兜底文案必须要求"别猜参数"（否则模型会照半截定义瞎编）', () => {
  const tools = Array.from({ length: 400 }, (_, i) => mkTool(`tool_${String(i).padStart(3, '0')}`, 1300))
  const section = buildToolSection(tools)
  assert.ok(/do NOT guess/i.test(section) || /not guess them/i.test(section), '缺少"别猜参数"的指令')
})

test('兜底只在真超预算时出现：刚好装得下时不该有任何省略提示', () => {
  const tools = Array.from({ length: 30 }, (_, i) => mkTool(`t${i}`, 200))
  const section = buildToolSection(tools)
  assert.ok(!/omitted/.test(section), '未超预算却出现了省略提示')
})

// ── head 不被"中间挖空"（第二道闸）────────────────────────────

test('head 预算足够：工具目录不被 truncateMiddle 从中间挖掉', () => {
  const tools = Array.from({ length: 61 }, (_, i) => mkTool(`tool_${String(i).padStart(2, '0')}`, 800))
  // ⚠️ 关键：必须把转写也撑长，让 merged 真的超过 maxChars —— 否则**根本不会进截断分支**，
  // 这条用例就测不到 headBudget 的比例（第一版就是这么写的，反向验证把 0.62 改回 0.45 时
  // 居然没变红，才发现它压根没走到那段逻辑）。
  const messages = []
  for (let i = 0; i < 700; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `历史消息第 ${i} 条，用来把转写撑到超长。`.repeat(8) }] })
  }
  const prompt = serializePrompt({
    system: 'S'.repeat(10_000),
    messages,
    tools,
  })
  const missing = tools.filter((t) => !hasTool(prompt, t.name))
  assert.equal(missing.length, 0, `head 被截后丢了 ${missing.length} 个工具：${missing.slice(0, 6).map((t) => t.name).join(', ')}`)
  // 转写确实被截了（证明这条用例真的走到了截断分支，而不是"因为没超长所以什么都没发生"）
  assert.ok(prompt.includes('chars omitted'), '转写未超长 → 这条用例没测到 head 预算，请加长 messages')
})

test('转写超长时仍会中段截断（历史可截，工具定义不可截）', () => {
  const messages = []
  for (let i = 0; i < 400; i += 1) messages.push({ role: 'user', content: [{ type: 'text', text: `消息 ${i} `.repeat(20) }] })
  const prompt = serializePrompt({
    system: 'SYS',
    messages,
    // ⚠️ 用**核心工具**（`pwsh`）而不是长尾：0.6.2 起长尾工具要先出一个约 95 字符的小节表头，
    // 在 maxChars=5000 这种极小预算下（工具额度只剩 ~82）反而装不下，会走"列名兜底"。
    // 核心工具没有表头开销，才测得到"工具定义必须保留"这件事本身。
    tools: [{ name: 'pwsh', description: 'd', parameters: {} }],
    maxChars: 5000,
  })
  assert.ok(prompt.length <= 5000, `长度 ${prompt.length}`)
  assert.ok(prompt.includes('Tool Calling Protocol'), '协议头必须保留')
  assert.ok(prompt.includes('pwsh('), '工具定义必须保留')
  assert.ok(prompt.includes('chars omitted'), '超长转写应当被截断')
})

// ── 老行为不能破 ────────────────────────────────────────────────

test('没有工具时返回空串（老行为）', () => {
  assert.equal(buildToolSection(undefined), '')
  assert.equal(buildToolSection([]), '')
})

test('分组：核心在前、长尾在后，且各自组内保持 DSH 原序', () => {
  // ⚠️ 0.6.2 起是**分组**渲染（核心一段一个、长尾一行一个）⇒ 不再要求"全局原序"；
  // 但**组内**的原序必须保住。
  const names = ['zeta', 'pwsh', 'alpha', 'read', 'mid']
  const section = buildToolSection(names.map((n) => mkTool(n)))
  const at = (n) => section.indexOf(n + '(')
  assert.ok(at('pwsh') < at('read'), '核心工具之间的原序被打乱')
  assert.ok(at('zeta') < at('alpha') && at('alpha') < at('mid'), '长尾工具之间的原序被打乱')
  assert.ok(at('read') < at('zeta'), '核心工具必须排在长尾之前')
})

test('描述里的换行与多余空白被压平（一块工具占的行数可控）', () => {
  const section = buildToolSection([{ name: 'a', description: 'line1\n\n  line2   line3', parameters: {} }])
  assert.ok(section.includes('line1 line2 line3'), '描述应压成一行')
})

test('F18：maxChars 很小时 head 必须完整（工具目录收缩，而不是被中间挖空）', () => {
  // 旧做法：先渲染满 5.6 万字符的工具目录，再发现 head 超预算，
  // 于是 truncateMiddle 从**中间**挖掉一块 → 留下残缺的 JSON Schema。
  const tools = Array.from({ length: 61 }, (_, i) => mkTool(`tool_${String(i).padStart(2, '0')}`, 800))
  for (const maxChars of [20_000, 50_000]) {
    const prompt = serializePrompt({
      system: 'S'.repeat(9_000),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools,
      maxChars,
    })
    const head = prompt.split('\n\n---\n\n')[0]
    assert.ok(
      !head.includes('chars omitted'),
      `maxChars=${maxChars} 时 head 被中段截断了 —— 会留下残缺的工具定义`,
    )
    assert.ok(head.includes('Tool Calling Protocol'), '协议头必须完整')
  }
})

test('F18：预算充足时仍能装下全部工具（收缩不能矫枉过正）', () => {
  const tools = Array.from({ length: 61 }, (_, i) => mkTool(`tool_${String(i).padStart(2, '0')}`, 400))
  const prompt = serializePrompt({
    system: 'S'.repeat(9_000),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools,
  })
  const missing = tools.filter((t) => !hasTool(prompt, t.name))
  assert.equal(missing.length, 0, `默认预算下不该缺失：${missing.slice(0, 5).map((t) => t.name).join(', ')}`)
})

if (failures.length) {
  for (const f of failures) console.log('  ' + f)
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  process.exit(1)
}
console.log(`通过 ${passed} 项，失败 0 项`)
