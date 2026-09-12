// 构建产物核对：确认关键修复都进了 lib（避免「源码改了但产物没变」）
import { readFileSync } from 'node:fs'

const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')

const checks = {
  'XML 工具调用解析器': host.includes('function_calls') && host.includes('<parameter'),
  'DSML 归一化': host.includes('DSML'),
  '指令禁止 XML': host.includes('Do NOT use XML'),
  // 0.1.12 起截断改由「自动续写」兜底，产物必须含续写逻辑、且再无 max-tokens 上报。
  // （旧断言查的是 mapFinish 里的 sse_auto_resume 注释 —— 该函数已删除，断言会永久失败）
  '自动续写（截断提示不再出现）': host.includes('自动续写') && host.includes('maxContinuations'),
  '产物不再上报 max-tokens（截断提示的触发源）': !host.includes('max-tokens'),
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
  '结构性修复（栈引导重排）': host.includes('rebuildToolCallJson'),
  '解析失败不再吐成正文（rejected 通道）': host.includes('rejected') && host.includes('无法解析'),
  '安全闸门（截断在字符串中间不修补）': host.includes('仍在字符串内'),
  'arguments 数组解包': host.includes('Array.isArray(args) && args.length === 1'),
  '转写回声守卫（TranscriptEchoGuard）': host.includes('TranscriptEchoGuard'),
  '网页端免责声明剥离（BoilerplateFilter）': host.includes('BoilerplateFilter') && host.includes('本回答由 AI 生成'),
  '三层缓冲按流水线反序吐净 + 轮末补剥声明（drainTextPipeline）': host.includes('drainTextPipeline') && host.includes('tailGuarded.text + tailBoiled.text + tail.text'),
  'DSML 重复/全角竖线': host.includes('DSML_PREFIX'),
  '会话删除排在流结束之后': host.includes('流结束之后') && host.includes('onDeleteSession'),
  '会话失效透明重试': host.includes('isInvalidSessionError'),
  '业务错误读 data.biz_code': host.includes('biz_msg'),
  'imageRequestPricing（否则压缩静默失效）': host.includes('imageRequestPricing'),
  '丢弃载荷落盘（rejected.jsonl）': host.includes('rejected.jsonl'),
  '会话清理开关': host.includes('deleteWebSessions'),
  '请求闸门（串行 + 最小间隔，防风控）': host.includes('createRequestGate') && host.includes('gatedStream'),
  '闸门覆盖会话标题等辅助调用': host.includes('session-title'),
  'client 显示当前节流策略': client.includes('请求节流'),
  '间隔是随机区间（非固定值）': host.includes('maxRequestIntervalMs') && host.includes('nextGap'),
  '会话清理策略（攒批/立即/不删）': host.includes('createSessionCleaner') && host.includes('sessionCleanup'),
  'client 会话清理选择器': client.includes('会话清理') && client.includes('deferred'),
  '退出账号：清浏览器分区': host.includes('clearLoginPartition'),
  '卸载插件不等于登出': host.includes('closeLoginWindow'),
  'client 独立「当前账号」卡': client.includes('当前账号'),
  'client 退出按钮': client.includes('退出当前账号'),
  'client 换号入口': client.includes('退出并登录其它账号'),
  'client 退出二次确认': client.includes('确认退出？'),
  '登录窗口报干净 Chrome UA': host.includes('buildLoginUserAgent') && host.includes('sanitizeClientHints'),
  'UA-CH 品牌清理': host.includes('sec-ch-ua'),
  '默认浏览器兜底入口': host.includes('/login/external') && client.includes('用我的默认浏览器登录'),
  '页面指纹回读（可观测）': host.includes('pageBrands') && client.includes('页面看到 UA'),
  '宿主进程能力自检（utility 不开窗）': host.includes('canOpenElectronWindowWith') && host.includes('loginCapability'),
  '真实浏览器登录（CDP + 端口 0）': host.includes('remote-debugging-port=0') && host.includes('DevToolsActivePort'),
  'CDP 读 cookie 与真实请求头': host.includes('Storage.getCookies') && host.includes('requestWillBeSentExtraInfo'),
  'client 显示宿主进程/登录方式': client.includes('宿主进程') && client.includes('loginCapability'),
  'client 如实说明凭证来源（不再写「可能仍可用」）': client.includes('凭证来源') && !client.includes('可能仍可用'),
  'client 标签页骨架（页签栏 + 页容器 + 切换函数）': client.includes('dsw-tabs') && client.includes('dsw-pane') && client.includes('selectTab'),
  'client 四个页签齐全（账号/模型/防风控/传输层）': ['账号', '模型', '防风控', '传输层'].every((label) => client.includes(label)),
  'client 操作反馈常驻标签栏之上（dsw-alert）': client.includes('dsw-alert'),
  'client 副标题整词不拆（deepseek-web 不会被断在连字符）': client.includes('dsw-nobreak'),
  'client 传输层卡（切换 + 一键测试）': client.includes('/transport') && client.includes('测试传输层'),
  'client 未登录时说明可用登录路径': client.includes('调试协议，自动读取凭证'),
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
