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

// ── 现场样本二（issue #14）：把 shell 命令写进正文 ──────────────────

/** 照抄 issue #14 的正文（`session-bcee8d6a`，2026-10-05 17:44），只把接口地址缩短。 */
const SHELL_PROGRAM = [
  '那小糯先干一件事：**用刚学会的方法，看看自己现在跑在哪条路上。**',
  '',
  '```pwsh',
  'curl.exe -s -m 10 "http://127.0.0.1:19387/deepseek-web-login/api/status"',
  '```',
  '顺手也看一眼台账有没有记上小糯这一轮。',
].join('\n')

test('现场样本二（围栏语言是 pwsh + shell 命令）⇒ 判真', () => {
  assert.ok(!SHELL_PROGRAM.includes('tools.'), '自证：样本里没有任何 tools.xxx( 形态')
  assert.ok(SHELL_PROGRAM.includes('curl.exe'), '自证：样本确实是要执行的命令')
  assert.equal(looksLikeUnexecutedToolProgram(SHELL_PROGRAM), true)
})

test('各种 shell 语言标记都要认（含 language- 前缀）⇒ 判真', () => {
  for (const tag of ['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'cmd', 'bat', 'language-bash']) {
    const text = ['```' + tag, 'mkdir -p build && cd build', '```'].join('\n')
    assert.equal(looksLikeUnexecutedToolProgram(text), true, `语言标记是「${tag}」时应判真`)
  }
})

test('短 shell 命令也要认（自证：总长不足 PTC 那条 80 字符的门槛）⇒ 判真', () => {
  const text = ['```bash', 'ls -la', '```'].join('\n')
  assert.ok(text.length < 80, '自证：这条样本比 MIN_TOOL_PROGRAM_CHARS 短')
  assert.equal(looksLikeUnexecutedToolProgram(text), true)
})

test('shell 块里是函数定义而不是一行命令 ⇒ 判真', () => {
  const text = ['```pwsh', 'function Get-Status {', '  param($Url)', '  curl.exe -s -m 10 $Url', '}', '```'].join('\n')
  assert.equal(looksLikeUnexecutedToolProgram(text), true)
})

test('输出记录类标记不算「要执行的命令」⇒ 判假', () => {
  // `console` / `terminal` / `shell-session` 标的是**输出**，不是要跑的程序；
  // 把它们当命令会诱导调用方去执行一段本来只是回显的内容。
  const transcripts = [
    ['```console', '$ npm test', '> all tests passed', '```'].join('\n'),
    ['```terminal', 'root@host:~# ls -la', 'total 0', '```'].join('\n'),
    ['```shell-session', 'user@host % git status', 'clean', '```'].join('\n'),
  ]
  for (const text of transcripts) {
    assert.equal(looksLikeUnexecutedToolProgram(text), false, '应判假：' + text.split('\n')[0])
  }
})

test('标记大小写不敏感（BASH / PWSH / Language-Bash）⇒ 判真', () => {
  for (const tag of ['BASH', 'Sh', 'PWSH', 'Language-Bash', 'Language-BASH']) {
    const text = ['```' + tag, 'mkdir -p build', '```'].join('\n')
    assert.equal(looksLikeUnexecutedToolProgram(text), true, `语言标记是「${tag}」时应判真`)
  }
})

test('单字符 shell 块低于长度门槛 ⇒ 判假', () => {
  assert.equal(looksLikeUnexecutedToolProgram(['```bash', 'x', '```'].join('\n')), false)
  assert.equal(looksLikeUnexecutedToolProgram(['```bash', '-', '```'].join('\n')), false)
  // 两个字符就是命令了（`ls`），门槛就在这里。
  assert.equal(looksLikeUnexecutedToolProgram(['```bash', 'ls', '```'].join('\n')), true)
})

test('PowerShell 块注释（<# … #>）也算注释 ⇒ 判假', () => {
  const text = ['```pwsh', '<# 先说明一下', '   这里还是注释 #>', '```'].join('\n')
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
  // 块注释之后跟一条真命令，还是要判真。
  const withCommand = ['```pwsh', '<# 说明 #>', 'Get-ChildItem -Recurse', '```'].join('\n')
  assert.equal(looksLikeUnexecutedToolProgram(withCommand), true)
})

test('cmd/bat 的注释写法（:: 与 rem）也算注释 ⇒ 判假', () => {
  assert.equal(looksLikeUnexecutedToolProgram(['```cmd', ':: 只是注释', ':: 又一行', '```'].join('\n')), false)
  assert.equal(looksLikeUnexecutedToolProgram(['```bat', 'rem 说明', 'rem 再来一行', '```'].join('\n')), false)
  // 但注释后面跟着真命令就不一样了。
  assert.equal(looksLikeUnexecutedToolProgram(['```cmd', ':: 先说明', 'dir /b', '```'].join('\n')), true)
})

test('shell 块里只有注释 / 只有空行 ⇒ 判假（没有要执行的命令）', () => {
  assert.equal(looksLikeUnexecutedToolProgram(['```bash', '# 说明一下这个接口', '# 再看一行', '```'].join('\n')), false)
  assert.equal(looksLikeUnexecutedToolProgram(['```bash', '', '```'].join('\n')), false)
})

test('非 shell 标记的块（python / json / text）⇒ 判假', () => {
  for (const tag of ['python', 'json', 'text', 'md']) {
    const text = ['```' + tag, 'mkdir -p build && cd build', '```'].join('\n')
    assert.equal(looksLikeUnexecutedToolProgram(text), false, `语言标记是「${tag}」时应判假`)
  }
})

test('正文行内提到一条命令、但没有围栏 ⇒ 判假', () => {
  const text = '你可以用 curl.exe 访问那个接口看看返回值，这条是说明不是命令。'
  assert.ok(!text.includes('```'), '自证：样本没有围栏')
  assert.equal(looksLikeUnexecutedToolProgram(text), false)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
