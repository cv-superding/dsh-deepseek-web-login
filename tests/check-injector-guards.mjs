// 复刻注入器注入前校验的正则，确认本插件 client 产物能通过（避免 PowerShell 引号地狱）
import { readFileSync } from 'node:fs'

const KNOWN_SLOTS = ['conversation.view', 'settings.plugin.item', 'settings.plugins.tab', 'settings.section', 'settings.general.item', 'conversation.session.header.actions', 'conversation.session.header.utilities', 'conversation.input.dock', 'conversation.composer.dock', 'sidebar.footer.action', 'shell.overlay']
const SLOT_ALT = KNOWN_SLOTS.map((s) => s.replace(/\./g, '\\.')).join('|')
const REGISTER_NAME = new RegExp(`register\\(\\{[\\s\\S]*?name:\\s*['"](${SLOT_ALT})['"]`)

const checks = [
  ['lib/client.js', 'lib/client.js'],
  ['src/client/index.ts', 'src/client/index.ts'],
]
for (const [label, file] of checks) {
  const text = readFileSync(file, 'utf8')
  const injectOk = /export const inject\s*=\s*\[[^\]]*['"]slots['"]/.test(text) || /inject\s*=\s*\[[^\]]*['"]slots['"]/.test(text)
  const registerOk = REGISTER_NAME.test(text)
  console.log(`${label}: inject=${injectOk} registerName=${registerOk}`)
}
const lib = readFileSync('lib/client.js', 'utf8')
console.log('ModuleLoader 特征:', lib.includes('__ModuleLoader__'))
console.log('register 片段:', (lib.match(/register\(\{.{0,90}/s) ?? ['(未找到)'])[0].replace(/\s+/g, ' '))
