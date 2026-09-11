// 构建产物核对：确认关键修复都进了 lib（避免「源码改了但产物没变」）
import { readFileSync } from 'node:fs'

const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')

const checks = {
  'XML 工具调用解析器': host.includes('function_calls') && host.includes('<parameter'),
  'DSML 归一化': host.includes('DSML'),
  '指令禁止 XML': host.includes('Do NOT use XML'),
  '截断判定（无 FINISHED → max-tokens）': host.includes('sse_auto_resume'),
  '登录恢复路由': host.includes('/login/recover'),
  'AppKit token 解包': host.includes('__appKit_userInfo'),
  '新档位（快速模式）': host.includes('快速模式'),
  '旧档位别名回退': host.includes('deepseek-pro'),
  'prompt 上限 1.5M 字符（服务端硬上限 2.62M）': host.includes('15e5') || host.includes('1500000'),
  '上下文 1M（不再误用附件预算 890880）': (host.includes('1_048_576') || host.includes('1048576') || host.includes('104857e1')),
  '附件预算只作说明、不当上下文窗口': host.includes('890880') && !host.includes('contextWindow: 890_880') && !host.includes('890_880'),
  '图片上传通道（upload_file）': host.includes('upload_file'),
  'ref_file_ids 引用': host.includes('ref_file_ids'),
  'JSON 宽容修复（非法转义）': host.includes('非法转义'),
  '未转义双引号修复（escapeInnerQuotes）': host.includes('escapeInnerQuotes'),
  '结构性补括号（少写 } 的调用）': host.includes('splitToolCallArray') || host.includes('structuralRepairCandidates') || host.includes('braceDeficit'),
  '解析失败不再吐成正文（rejected 通道）': host.includes('rejected') && host.includes('无法解析'),
  '安全闸门（截断的流不修补）': host.includes(']*$/.test(scanned.tail)'),
  '转写回声守卫（TranscriptEchoGuard）': host.includes('TranscriptEchoGuard'),
  'DSML 重复/全角竖线': host.includes('DSML_PREFIX'),
  '会话删除排在流结束之后': host.includes('流结束之后') && host.includes('onDeleteSession'),
  '会话失效透明重试': host.includes('isInvalidSessionError'),
  '业务错误读 data.biz_code': host.includes('biz_msg'),
  'imageRequestPricing（否则压缩静默失效）': host.includes('imageRequestPricing'),
  '丢弃载荷落盘（rejected.jsonl）': host.includes('rejected.jsonl'),
  '会话清理开关': host.includes('deleteWebSessions'),
  'client 模块 id 正确': client.includes('id: "dsh-deepseek-web-login"'),
  'client 槽位名合法': client.includes('settings.section'),
}

let failed = 0
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) failed += 1
  console.log(` ${ok ? '✓' : '✗'} ${name}`)
}
console.log(failed === 0 ? '\n产物核对全部通过 ✅' : `\n产物核对失败 ${failed} 项 ❌`)
process.exitCode = failed === 0 ? 0 : 1
