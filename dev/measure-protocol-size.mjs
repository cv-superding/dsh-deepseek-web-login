// 量：围栏示例让协议指令长了多少？在 maxChars=5000 的极小预算下会不会挤掉工具定义。
const M = await import('../src/protocol.ts')

const messages = []
for (let i = 0; i < 400; i += 1) messages.push({ role: 'user', content: [{ type: 'text', text: `消息 ${i} `.repeat(20) }] })
const p = M.serializePrompt({
  system: 'SYS',
  messages,
  tools: [{ name: 'pwsh', description: 'd', parameters: {} }],
  maxChars: 5000,
})
console.log('=== maxChars=5000 极小预算 ===')
console.log('  长度        :', p.length, '(上限 5000)')
console.log('  有协议头    :', p.includes('Tool Calling Protocol'))
console.log('  有工具定义  :', p.includes('pwsh('))
console.log('  有截断标记  :', p.includes('chars omitted'))
console.log('  协议头长度  :', p.indexOf('消息 0') > 0 ? p.slice(0, p.indexOf('消息 0')).length : '?')

console.log('\n=== 协议指令体积 ===')
console.log('  TOOL_PROTOCOL_INSTRUCTIONS   :', M.TOOL_PROTOCOL_INSTRUCTIONS.length, '字符')
console.log('  SERIAL_TOOL_PROTOCOL_INSTRUCTIONS:', M.SERIAL_TOOL_PROTOCOL_INSTRUCTIONS.length, '字符')

// 真实配置下的固定头有多大
const real = M.serializePrompt({
  system: 'SYS',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: [{ name: 'pwsh', description: 'd', parameters: {} }],
  maxChars: 400000,
})
console.log('  真实配置下固定头约:', real.length, '字符')
