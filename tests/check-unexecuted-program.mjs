/**
 * 回归：looksLikeUnexecutedToolProgram —— 判「模型把要执行的程序写进了正文」。
 *
 * 为什么值得单独钉：这个判据接在"自动追加一轮纠正请求"的动作上。
 * 误判（把正常回答判成程序没发出去）的代价是白打一次网页端请求 —— 烧额度、涨请求密度；
 * 漏判的代价是那一轮等于什么都没做，用户看到的是"它停下来了"。
 * 两侧都要守，所以正反例都写足。
 *
 * 判据的现场来源与设计取舍见 src/protocol.ts 里该函数的注释。
 *
 * 用法: node tests/check-unexecuted-program.mjs
 */
import assert from 'node:assert/strict'
import { looksLikeUnexecutedToolProgram } from '../src/protocol.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`✗ ${name}: ${error?.message ?? error}`)
  }
}

/** 现场样本：照抄 2026-09-17 11:00 那次会话（`--F-Code-DSH-Code-gongji--`）的正文。 */
const PTC_PROGRAM = [
  '我先把现场摸清：目标站是否还活着、返回什么、本地有没有样本和逆向工具链。',
  '',
  '```ts',
  'const out = [];',
  'const run = async (label, command, workdir) => {',
  '  try {',
  '    const r = await tools.bash({ command, workdir });',
  '    out.push(r.text.slice(0, 4000));',
  '  } catch (e) {',
  '    out.push(String(e && e.message));',
  '  }',
  '};',
  '',
  "await run('cwd + files', 'pwd; ls -la');",
  "await run('node/python', 'node -v; python -V; which curl curl.exe 2>/dev/null');",
  '',
  'console.log(out.join("\\n"));',
  '```',
].join('\n')

// ── 正例 ─────────────────────────────────────────────────────────────
test('现场样本（围栏 + tools.bash 调用）⇒ 判真', () => {
  assert.ok(PTC_PROGRAM.includes('tools.bash('), '自证：样本确实含工具 API 调用')
  assert.equal(looksLikeUnexecutedToolProgram(PTC_PROGRAM), true)
})

test('没有围栏、但正文里直接写着 await tools.<name>( ⇒ 判真', () => {
  const text = '先跑这个试试：\nconst r = await tools.bash({ command: "pwd" });\nconsole.log(r.text)'
  // 这条分支**不看长度**，只认「await + tools. + 标识符 + 左括号」的形态 ——
  // 没有围栏时这是最强的信号（正常解释性文字很少这么写）。所以自证要证形态、不是证长度。
  assert.ok(/await\s+tools\./.test(text), '自证：样本确实带 await 形态')
  assert.equal(looksLikeUnexecutedToolProgram(text), true)
})

test('多个代码块，其中只有一块是程序 ⇒ 判真', () => {
  const text = [
    '先说明一下思路：',
    '',
    '```python',
    'print("hello")',
    '```',
    '',
    '然后这样执行：',
    '',
    '```js',
    'const r = await tools.str_replace_editor({ command: "view", path: "a.ts" });',
    'console.log(r.text);',
    '```',
  ].join('\n')
  assert.equal(looksLikeUnexecutedToolProgram(text), true)
})

test('围栏语言标记不是 ts（typescript / 空）也要认出来', () => {
  const body = 'const r = await tools.bash({ command: "ls -la" });\nconsole.log(r.text.slice(0, 100));'
  for (const tag of ['typescript', 'javascript', '']) {
    const text = ['```' + tag, body, '```'].join('\n')
    assert.equal(looksLikeUnexecutedToolProgram(text), true, `语言标记是「${tag}」时应判真`)
  }
})

// ── 反例（防误伤）────────────────────────────────────────────────────
test('普通回答（无代码块）⇒ 判假', () => {
  assert.equal(looksLikeUnexecutedToolProgram('这个是正常的回答，里面没有任何要执行的程序。'), false)
})

test('与工具 API 无关的普通代码块 ⇒ 判假', () => {
  const text = ['看下面的例子：', '', '```js', 'const a = 1;', 'console.log(a);', '```'].join('\n')
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
})

test('围栏块里只是"提到"这个 API、短于阈值 ⇒ 判假', () => {
  const text = ['```', 'tools.bash()', '```'].join('\n')
  assert.ok(text.length < 80, '自证：这是一个短样本')
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
})

test('正文里不带 await 地提到 tools.bash()（无围栏）⇒ 判假', () => {
  const text = '你可以在自己的程序里调用 tools.bash() 来执行命令，工具名就是它。这段是解释，不是程序。'
  assert.ok(!text.includes('await tools.'), '自证：样本确实没有 await 形态')
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
})

test('只出现 tools. 前缀但没有调用括号 ⇒ 判假', () => {
  const text = '系统里有个 tools 命名空间，平时写成 tools.bash 这样的形式来引用它，具体参数见文档说明。'
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
})

test('空串 / undefined / 纯空白 ⇒ 判假（不能抛）', () => {
  assert.equal(looksLikeUnexecutedToolProgram(''), false)
  assert.equal(looksLikeUnexecutedToolProgram('   \n\n  '), false)
  assert.equal(looksLikeUnexecutedToolProgram(undefined), false)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
