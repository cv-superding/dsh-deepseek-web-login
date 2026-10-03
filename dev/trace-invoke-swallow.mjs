// 二分：逐条停用 stripStrayToolMarkup 的规则，看哪条吃了行内 <invoke>。
// 直接从源文件里抽出真实的规则文本，避免手抄失真。
import { readFileSync } from 'node:fs'

const src = readFileSync(
  'F:/Code/Github-Self/dsh-fix/dsh-login-web/dsh-deepseek-web-login1/src/protocol.ts',
  'utf8',
)
const body = src.slice(
  src.indexOf('export function stripStrayToolMarkup'),
  src.indexOf('export function stripStrayToolMarkup') + 2200,
)
const S = '在 HTML 里 <invoke> 不是一个标准标签，它只是普通文字。'

const DSML_PREFIX = '(?:[|｜]+\\s*DSML\\s*[|｜]+\\s*)?'
const DSML_HYPHEN = '(?:\\s*dsml-\\s*)?'
const WRAPPER_NAMES = 'tool_calls|tool_call|function_calls|calls'

const candidates = {
  '0a 包裹标签(前缀可选)': new RegExp(
    `<\\/?\\s*(?:(?:${DSML_PREFIX})?${DSML_HYPHEN})?(?:${WRAPPER_NAMES})\\s*>` +
      `|<\\/?\\s*${DSML_PREFIX}${DSML_HYPHEN}invoke\\s*>`,
    'gi',
  ),
  '0a′ 只包裹标签(前缀可选)': new RegExp(
    `<\\/?\\s*(?:(?:${DSML_PREFIX})?${DSML_HYPHEN})?(?:${WRAPPER_NAMES})\\s*>`,
    'gi',
  ),
  '0b′ invoke 绑成一个可选组': new RegExp(
    `<\\/?\\s*(?:(?:${DSML_PREFIX})${DSML_HYPHEN})invoke\\s*>`,
    'gi',
  ),
  '0b″ invoke 两个独立可选(旧)': new RegExp(`<\\/?\\s*${DSML_PREFIX}${DSML_HYPHEN}invoke\\s*>`, 'gi'),
  '1 独占行退化(包裹)': new RegExp(
    `(^|\\n)[ \\t]*<\\/?[ \\t]+(?:${WRAPPER_NAMES})[ \\t]*>[ \\t]*(?=\\n|$)`,
    'gi',
  ),
  '2 孤立 voke>': /(^|\n)[ \t]*(?:in)?voke\s*>\s*(?=\n|$)/gi,
}

console.log('原文:', JSON.stringify(S), '\n')
for (const [name, re] of Object.entries(candidates)) {
  re.lastIndex = 0
  const hit = re.test(S)
  re.lastIndex = 0
  console.log(`  ${hit ? '🔴 命中（会吞）' : '✅ 不命中'}  ${name}`)
}
console.log('\n=== 源文件里 stripStrayToolMarkup 的替换链 ===')
for (const line of body.split('\n')) {
  if (line.includes('.replace(') || line.includes('RegExp(')) console.log('  ' + line.trim().slice(0, 150))
}
