// 构建产物核对：确认关键修复都进了 lib（避免「源码改了但产物没变」）
import { readFileSync } from 'node:fs'

const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')
// 源码（注释不会进 bundle，涉及"注释里必须写明风险"的断言只能读源文件）
const srcAccounts = readFileSync('src/accounts.ts', 'utf8')

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
  // ── 0.1.26：账号库 / 受限倒计时 / 探活 / 台账 / 检查更新 ──
  '账号库路由齐全（列表/切换/重命名/移除/导入/导出）': ['/accounts/switch', '/accounts/rename', '/accounts/remove', '/accounts/import', '/accounts/export'].every((route) => host.includes(route)),
  '账号库接口不回传凭证（只给元信息）': host.includes('accountsFootprint') && host.includes('isActive: record.id === activeId'),
  '账号库支持导入去重（serverId / token）': host.includes('serverId') && host.includes('upsertAccount'),
  '受限解除时间随错误结构化传递（不靠解析文案）': host.includes('mutedUntilMs'),
  '受限状态落到账号上（限流时记录、成功且过期后清除）': host.includes('recordCallOutcome') && host.includes('账号级限制已解除'),
  '登录态主动探活（只读、零额度、可关）': host.includes('startProbeLoop') && host.includes('probeIntervalMs'),
  '调用台账（间隔分布 + 失败分类）': host.includes('summarizeLedger') && host.includes('percentile') && host.includes('账号被限制') && host.includes('限流（发太频繁）'),
  '台账只统计对话类调用（标题生成会污染间隔分布）': /purpose\s*===\s*["']chat["']/.test(host),
  '检查更新（GitHub Releases + 优雅失败）': host.includes('releases/latest') && host.includes('isNewer') && host.includes('连接 GitHub 超时'),
  '版本号兜底常量（打包后读不到 package.json 也能显示）': host.includes('FALLBACK_VERSION'),
  'client 账号库卡片': client.includes('账号库') && client.includes('导出备份') && client.includes('确认移除？'),
  'client 受限倒计时（独立 30 秒定时器）': client.includes('dsw-limit') && client.includes('countdownTimer'),
  'client 台账小柱图（手写 SVG，不引依赖）': client.includes('dsw-spark') && client.includes('sparkSvg'),
  'client 导出走系统「另存为」（File System Access）': client.includes('showSaveFilePicker') && client.includes('createWritable'),
  'client 导入走系统「打开」框，且能取真实路径（只传路径给宿主）': client.includes('__DSH_DESKTOP_FILE_PATH__') && client.includes('application/json'),
  'client 不再让人手打备份文件路径': !client.includes('要导入的备份文件路径') && !client.includes('请先填写备份文件路径'),
  'host 提供「另存为」所需的 export-json 路由': host.includes('accounts/export-json'),
  'host 保留凭证不出宿主的导出回退路径': host.includes('accounts/export') && host.includes('exportAccountsToFile'),
  'client 账号页拆两个子页（分段胶囊 + 切换函数）': client.includes('dsw-subtabs') && client.includes('selectAcctTab'),
  'client 账号库有「登录新账号」入口（以前完全没有这条入口）': client.includes('登录新账号（添加）') && client.includes('/login/add'),
  'client 退出文案写明会从账号库移除（不是"只登出"）': client.includes('从账号库移除'),
  'host 新增 /login/add 路由 + 添加模式': host.includes('login/add') && host.includes('beginAddAccount'),
  'host 捕获落库统一走 commitCapturedAuth（添加模式只入库不切换）': host.includes('commitCapturedAuth'),
  'host 账号显示名走 pickUserDisplay（别退回 ?? 链：空字符串会把整条回退挡住）': host.includes('pickUserDisplay'),
  'host 显示名候选含 mobile_number（手机号注册的账号靠它才有名字）': host.includes('mobile_number'),
  'host 实在拿不到名字时用「未识别账号」而不是把内部 id 当名字': host.includes('未识别账号'),
  'host 会话清理的三个区间能落盘（sessionCleanup 之外还有 batch/delay/gap）':
    host.includes('cleanupBatch') && host.includes('cleanupDelayMs') && host.includes('cleanupGapMs'),
  'host 清理区间走 normalizeCleanupRange 做边界收敛（滑块越界也不会写出非法值）':
    host.includes('normalizeCleanupRange'),
  'client 清理模式旁提供三个区间滑块（攒够数量 / 最长等待 / 删除间隔）':
    client.includes('攒够数量') && client.includes('最长等待') && client.includes('删除间隔'),
  'client 三滑块初始隐藏（只有「延迟」模式才显示）': client.includes('cleanupRanges'),
  'client 说明了取值随机（防止删除时机有固定规律）': client.includes('每次在区间内随机抽'),
  'client 说明了删除间隔只作用于逐个删除': client.includes('一下子连发几十个删除请求'),
  'host 伪标记清单是数据驱动的（加名字不用改正则，改错也看得见）':
    host.includes('IMITATED_MARKER_TAGS'),
  'host 伪标记清单里含 ide_result_status（模型自造的那个，实测漏过一次）':
    host.includes('ide_result_status'),
  'host 仍保留原有伪标记 ds_system（老现场不能回退）': host.includes('ds_system'),
  'host 保留并规整 cookie 过期信息（老记录没有该字段也要能读出来）':
    host.includes('normalizeCookieMetaList') && host.includes('pickCookieMeta') && host.includes('cookieMeta'),
  'host /accounts 回传 cookieMeta（界面才知道该说"未记录"还是"全是会话级"）':
    host.includes('cookieMeta: record.cookieMeta'),
  'host 提供「重新登录这个账号」的路由': host.includes('login/relogin'),
  'host 探活结果里带 cookie 寿命摘要': host.includes('cookieLife'),
  'client 用 describeCookieLife 展示 cookie 寿命': client.includes('describeCookieLife'),
  'client 账号卡的失败徽章是行动指令「需要重新登录」（不是只写"校验失败"）':
    client.includes('需要重新登录'),
  'client 失败账号上有「重新登录这个账号」按钮，且走 relogin 路由':
    client.includes('重新登录这个账号') && client.includes('login/relogin'),
  'client 为失败那一行提供了样式': client.includes('dsw-account-fix'),
  'client 说明了 cookie 过期时间不是登录态寿命':
    client.includes('Cookie 过期') && client.includes('不是登录态寿命'),
  'client 关于页（检查更新 + 数据位置 + 风险说明）': client.includes('检查更新') && client.includes('数据位置') && client.includes('为什么没有「自动换号」'),
  '源码注释写明为何不做自动换号（风险可见）': srcAccounts.includes('刻意**不做自动轮换**') && srcAccounts.includes('关联'),
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
