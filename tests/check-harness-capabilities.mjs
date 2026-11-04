/**
 * 回归：DSH 路由能力声明（`systemPromptUpdate` / `toolUpdate`）与配套的工具延迟加载。
 *
 * ## 为什么要有这个文件
 *
 * 官方 harness 让**路由自己声明**两项能力（`LlmResolvedModelInfo`：
 * `systemPromptUpdate: 'in-history'` / `toolUpdate: 'in-history' | 'addition-only'`）。
 * 不声明时 harness 的默认行为对我们最不利：
 *  - 系统提示词一变，`SystemPromptProjection.project()` 就 **replace 会话首节点**
 *    （`inHistory=false` 分支）⇒ 历史前缀变了 ⇒ 本地投喂链判据失败 ⇒ 全量重发；
 *  - 工具集一变，被单独判为"必须开新请求序列"（`agent.ts`：
 *    `preparedCall?.toolUpdate === undefined && this.toolsChanged(...)`）⇒ 同理。
 *
 * 真机证据（2026-10-14 解 82 个真机会话日志）：`role:"developer"` 17 处、
 * `tool-addition` 181、`tool-removal` 78；其中一条会话一次中途新增了 **10 个工具**。
 * ⇒ 这个默认行为在真实使用里**每一条都会打断投喂链**。
 *
 * ## 三项改动是一个整体，缺一即产生新缺陷
 *  ① `src/adapter.ts` 的 `resolvedModelInfo()` 声明两项能力；
 *  ② `src/protocol.ts` 的 `role === 'developer'` 分支渲染工具变更块
 *     （漏了它 ⇒ developer 消息掉进 user 分支，渲染成 `User: {"type":"tool-addition"…}`，
 *      与 2026-10-02 那个 `role:'tool'` 的缺陷完全同类）；
 *  ③ `buildToolSection()` 把 `deferLoading` 的工具挡在固定头之外
 *     （漏了它 ⇒ 新增工具就改一次 head ⇒ 链照旧断，白改）。
 *
 * ## 已做变异验证（每一处都实测变红，不是"我认为会红"）
 *  - 把 `resolvedModelInfo` 的两个字段删掉 ⇒ 「声明」那条红；
 *  - 把值改成 `'addition-only'` ⇒ 「非法/不同模式」那条红（且 harness 会抛异常，比不写更糟）；
 *  - 把 `developer` 分支删掉 ⇒ 「渲染」那条红；
 *  - 把 `buildToolSection` 的 `immediate` 过滤去掉 ⇒ 「head 稳定」那条红。
 *
 * 用法: node tests/check-harness-capabilities.mjs
 */

// 本文件断言的是**完整渲染**（deferLoading 之外一律列出、head 逐字节稳定）：
// 长尾的 `hide` 档会故意不列实验性工具 ⇒ 这里固定 full。
process.env.DSH_WEB_LOGIN_TAIL_TOOLS = 'full'

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-harness-cap-'))
process.env.DSH_HOME = HOME

const { buildToolSection, renderDeveloperUpdates, serializePromptParts } = await import('../src/protocol.ts')
const { createAdapter, PROVIDER } = await import('../src/adapter.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 官方契约允许的取值（`packages/llm/llm/src/types.ts`）。拼错会被 harness 直接抛错。 */
const LEGAL_SYSTEM_PROMPT_UPDATE = new Set(['in-history'])
const LEGAL_TOOL_UPDATE = new Set(['in-history', 'addition-only'])

const AUTH = {
  token: 't'.repeat(64), cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '',
  userAgent: 'test-ua', capturedAt: '2026-09-11T00:00:00.000Z',
}

const readTool = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}
/** 中途新增的工具：**必须**带 `deferLoading`，这是 harness 对新增项打的标记。 */
const lateTool = {
  name: 'multi_search',
  description: 'Search many places at once.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  deferLoading: true,
}

// ── ① 路由能力声明 ──────────────────────────────────────────────────

await test('resolveModel 声明了 systemPromptUpdate / toolUpdate（缺了 harness 就走最不利的默认）', async () => {
  const adapter = createAdapter({ getAuth: () => AUTH, config: {}, noteCall: () => {} })
  const info = await adapter.resolveModel(PROVIDER, 'deepseek-chat')
  assert.ok(
    info.systemPromptUpdate !== undefined,
    'systemPromptUpdate 必须是 ' + JSON.stringify([...LEGAL_SYSTEM_PROMPT_UPDATE]) + '，实际是 undefined',
  )
  assert.ok(info.toolUpdate !== undefined, 'toolUpdate 未声明 ⇒ 工具集一变就开新请求序列 ⇒ 投喂链断')
  assert.ok(
    LEGAL_SYSTEM_PROMPT_UPDATE.has(info.systemPromptUpdate),
    `systemPromptUpdate 取值非法：${String(info.systemPromptUpdate)}（harness 会抛 adapter returned invalid …）`,
  )
  assert.ok(
    LEGAL_TOOL_UPDATE.has(info.toolUpdate),
    `toolUpdate 取值非法：${String(info.toolUpdate)}`,
  )
})

await test('prepareCall 的 model 上同样带着两项声明（运行时读的是这一份）', async () => {
  const adapter = createAdapter({ getAuth: () => AUTH, config: {}, noteCall: () => {} })
  const prepared = await adapter.prepareCall(PROVIDER, 'deepseek-chat')
  assert.equal(prepared.model.systemPromptUpdate, 'in-history')
  assert.equal(prepared.model.toolUpdate, 'in-history')
})

await test('toolUpdate 必须是 in-history 而不是 addition-only（后者会在移除时删条目 ⇒ head 仍会变）', async () => {
  const adapter = createAdapter({ getAuth: () => AUTH, config: {}, noteCall: () => {} })
  const info = await adapter.resolveModel(PROVIDER, 'deepseek-chat')
  // 依据：harness `content.ts` 的 `toolDeclarations()` —— `in-history` 分支直接返回
  // `declarations`（只增不减）；`addition-only` 分支会 delete 掉不在当前活动集里的名字。
  assert.equal(
    info.toolUpdate,
    'in-history',
    'addition-only 在工具被移除时会把声明从列表里删掉 ⇒ 我们的目录仍会变 ⇒ 这次的修复失效',
  )
})

// ── ② 固定头稳定性（本改动的全部意义）──────────────────────────────

const BASE_TOOLS = [readTool]

await test('新增一个延迟加载的工具，固定头 head 必须逐字节不变', () => {
  const a = serializePromptParts({ messages: [], tools: BASE_TOOLS })
  const b = serializePromptParts({ messages: [], tools: [...BASE_TOOLS, lateTool] })
  assert.ok(a.head.includes('read_file'), '自证：基线头的确渲染了工具目录')
  assert.equal(
    b.head,
    a.head,
    '多了一个 deferLoading 工具就改了 head ⇒ 投喂链必然断，这次改动没起作用',
  )
  assert.ok(!b.head.includes('multi_search'), '延迟加载的工具不该出现在固定头里')
})

await test('反证：不带 deferLoading 的新工具必须改 head（否则上面那条是恒真的虚守卫）', () => {
  const a = serializePromptParts({ messages: [], tools: BASE_TOOLS })
  const { deferLoading: _drop, ...nonDeferred } = lateTool
  const b = serializePromptParts({ messages: [], tools: [...BASE_TOOLS, nonDeferred] })
  assert.notEqual(
    b.head,
    a.head,
    '不带 deferLoading 也该不进目录 ⇒ 过滤条件写成了"一律过滤"，延迟加载语义被抹掉了',
  )
})

await test('buildToolSection 直接调用：只过滤 deferLoading，其余原样渲染', () => {
  const text = buildToolSection([readTool, lateTool], 100_000)
  assert.ok(text.includes('read_file'))
  assert.ok(!text.includes('multi_search'))
})

await test('失效保护：全部工具都带 deferLoading 时回退渲染全部（目录为空 = agent 不能用工具）', () => {
  // 触发条件：harness 的 `toolDeclarations()` 以 `history.tools` 为基线，只给之后新增的
  // 补 `deferLoading`；基线为空而当前工具全算"新增"时就会全部带标记。
  // 这里的取舍是刻意的：宁可 head 抖一次，也不能发一份没有工具目录的提示词。
  const allDeferred = [
    { ...readTool, deferLoading: true },
    { ...lateTool, deferLoading: true },
  ]
  const text = buildToolSection(allDeferred, 100_000)
  assert.ok(text.includes('read_file'), '全部延迟时目录不能为空 —— 那样模型一个工具都调不了')
  assert.ok(text.includes('multi_search'))
})

await test('只有 deferLoading 被过滤，其他字段不影响渲染', () => {
  // 自证：过滤条件确实只认 deferLoading —— 不能顺手把 `deferLoading: false` 也当延迟项。
  const text = buildToolSection([{ ...readTool, deferLoading: false }], 100_000)
  assert.ok(text.includes('read_file'))
})

// ── ③ developer 消息渲染（形态用真机原文）──────────────────────────

/** 真机日志原文形态（`tool-addition` + `toolName`），2026-10-14 从会话日志抽取。 */
const realDeveloperMessage = {
  role: 'developer',
  source: { kind: 'tool-registry' },
  content: [{ type: 'tool-addition', toolName: 'multi_search' }],
}

await test('developer 的 tool-addition 被渲染成 [Tool added: …]，并带上该工具的 schema', () => {
  const parts = serializePromptParts({
    messages: [realDeveloperMessage],
    tools: [...BASE_TOOLS, lateTool],
  })
  assert.ok(
    parts.full.includes('[Tool added: multi_search]'),
    'developer 消息没被渲染 —— 模型不知道新工具存在。prompt 结尾：' +
      JSON.stringify(parts.full.slice(-240)),
  )
  assert.ok(
    parts.full.includes('multi_search(') || parts.full.includes('multi_search(query'),
    '新增工具的参数签名缺失 —— 它被挡在固定头之外，schema 只能在这里给',
  )
})

await test('developer 消息不许掉进 user 分支（那正是 2026-10-02 那个缺陷的同类）', () => {
  const parts = serializePromptParts({
    messages: [realDeveloperMessage],
    tools: [...BASE_TOOLS, lateTool],
  })
  assert.ok(
    !/\bUser:\s*[\{\[]/.test(parts.full),
    'developer 消息被渲染成 “User: {…}” ⇒ 模型会以为"用户告诉了我有这些工具"' +
      JSON.stringify(parts.full.slice(-240)),
  )
})

await test('tool-removal 也被渲染（否则模型会继续调已经不存在的工具）', () => {
  const parts = serializePromptParts({
    messages: [{ role: 'developer', content: [{ type: 'tool-removal', toolName: 'multi_search' }] }],
    tools: [...BASE_TOOLS, lateTool],
  })
  assert.ok(parts.full.includes('[Tool removed: multi_search]'), parts.full.slice(-200))
})

await test('renderDeveloperUpdates：字段别名 name / 空名 / 未知类型 / 纯文本都按预期处理', () => {
  assert.deepEqual(renderDeveloperUpdates([], []), [])
  // 官方字段是 toolName；name 只作防御性别名
  assert.match(renderDeveloperUpdates([{ type: 'tool-addition', name: 'x' }], []).join('\n'), /\[Tool added: x\]/)
  // 只有 name 缺失才跳过
  assert.deepEqual(renderDeveloperUpdates([{ type: 'tool-addition' }], []), [])
  assert.deepEqual(renderDeveloperUpdates([{ type: 'tool-addition', toolName: '   ' }], []), [])
  // 未知块类型静默忽略（向前兼容：官方以后会加新块）
  assert.deepEqual(renderDeveloperUpdates([{ type: 'unknown-future-block' }], []), [])
  assert.deepEqual(renderDeveloperUpdates([null, 42, 'x'], []), [])
  // 纯文本块原样透传（官方让 developer 里也能放 text）
  assert.deepEqual(renderDeveloperUpdates([{ type: 'text', text: 'hello' }], []), ['hello'])
})

await test('未知块类型抛不出异常、且工具名取不到时也不炸（诊断不能影响主流程）', () => {
  const parts = serializePromptParts({
    messages: [{ role: 'developer', content: [{ type: 'tool-addition', toolName: 'not_in_list' }] }],
    tools: BASE_TOOLS,
  })
  assert.ok(parts.full.includes('[Tool added: not_in_list]'), '名字仍要报出来，schema 拿不到就退化成 JSON')
  assert.ok(parts.full.includes('Parameters (JSON Schema)') || parts.full.includes('not_in_list'))
})

// ── 汇总 ────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failures.length} 通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
