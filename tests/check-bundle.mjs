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
  'host 工具目录超预算时必须列出被省略的工具名（不许静默丢弃）': host.includes('NOT described above'),
  'host 工具目录省略时明确要求「别猜参数」': host.includes('do NOT guess'),
  'host 老的那句「remaining tools omitted for length」已不再出现': !host.includes('remaining tools omitted for length'),
  'host 启动闸门时 min/max 成对传入（漏传 max 会让随机区间变成固定间隔）':
    /maxIntervalMs:\s*\w+\?\.maxRequestIntervalMs/.test(host),
  'host 适配器配置也带上 maxRequestIntervalMs': host.includes('maxRequestIntervalMs: gate.settings().maxRequestIntervalMs'),
  'host 状态回传也带上 maxRequestIntervalMs': /maxRequestIntervalMs:\s*adapterConfig\.maxRequestIntervalMs/.test(host),
  'host 会剥掉孤立的工具调用标记残片（`</|DSML|calls>` 那类漏上屏过）': host.includes('stripStrayToolMarkup'),
  'host 认证响应有形状校验（反爬页不会被当成验证通过）': host.includes('classifyAuthEnvelope'),
  'host 写凭证不再先删目标文件（Windows rename 可直接覆盖）': !/rmSync\(file,\s*\{\s*force:\s*true\s*\}\)\s*\n\s*renameSync/.test(host),
  'host 账号路径拼装带 id 安全校验（防路径穿越）': host.includes('assertSafeAccountId'),
  'host 调用上报带「发起时的账号 id」（防飞行途中切号记错人）': /accountId:\s*accountIdAtStart/.test(host),
  'host 批量清理只在同账号下用（混号退化为逐个删）': host.includes('sameAccount'),
  'host 有长任务保护（连续跑满阈值强制长休）': host.includes('长任务保护') && host.includes('longRunThreshold'),
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
  // F14：spawn 的异步错误必须有监听 —— 否则 ENOENT/EACCES 会变成未捕获异常带崩宿主
  'host 监听浏览器启动的异步错误': host.includes('spawnError'),
  // 会话复用：常量会被打包内联，断言会存活的行为标记（见 grep 实测 2 处）
  'host 有会话复用（同一会话多轮共用）': host.includes('reuseSlot') && host.includes('retireSession'),
  // 提示词卫生：不再写出私有标记的字面量。
  // ⚠️ 断言「产物里没有某串」前先 grep 确认基线：`DSML|>` 在产物里实测 0 处（只出现在旧提示词里），
  //    而 `DSML|` 仍有若干处（正则源码里就是那样写的），所以不能拿它做否定断言。
  'host 提示词不再写出私有标记字面量': !host.includes('DSML|>') && host.includes('the private delimiter-prefixed variants'),
  // prompt 上限既可调、也真的被 adapter 读取（别只做了界面）
  'host 的 prompt 上限可调且落到 adapter': host.includes('maxPromptCharsBounds') && host.includes('clampMaxPromptChars'),
  // 真实用量的**调用点**（断言调用点，别只断言字段名）：审计 N06 改成逐轮记账 ——
  // 有 total 的轮次用真值并减掉输出估算，没上报的轮次退回按字符估算。
  // 旧实现是「整次调用二选一」，只要一轮有值，其它轮的输入就从账本消失了。
  // 注意：`round.total !== undefined` 会被打包器改写成 `!== void 0`，所以断言的是
  // 「无上报轮次仍退回估算」这个行为标记 —— 旧实现里 `estimateTokens` 只吃整次的 prompt。
  'host 逐轮记账真实 token（无值轮次仍计入估算）':
    host.includes('usageRounds.push(roundUsage)') && host.includes('estimateTokens(round.prompt)'),
  // 审计 N03：伪系统标记的剥离必须是**有状态**的流式过滤器（跨 push 维持标签/围栏状态），
  // 无状态纯函数在「开始标签、正文、结束标签落在不同 push」时会失效。
  'host 用有状态过滤器剥伪标记（流内 + 轮末残余）':
    host.includes('systemMarkerFilter.push(guarded.text)') &&
    host.includes('systemMarkerFilter.push(drained.text)') &&
    host.includes('systemMarkerFilter.flush()'),
  // 审计 N05：官方资源下载统一白名单 + 拒绝重定向 + 分块限字节
  'host 官方资源下载有白名单/拒绝重定向/限字节':
    host.includes('readOfficialResource') &&
    host.includes('redirect: "error"') &&
    host.includes('资源超过字节上限'),
  // 审计 N05 的核心：下载/编译失败必须连「已解析的地址」一起清，
  // 否则会一直对着坏地址打，"保留 discovery 能力"等于没用
  'host WASM 失效时连地址缓存一起清':
    host.includes('resolvedWasmUrl?.url === url') && host.includes('resolvedWasmUrl = null'),
  // 审计 N02：迟到的 /status 校验只能刷元信息，不能切号/复活已删账号。
  // 断言调用点特征 —— 注意 `item.token === auth.token` 这类比较在产物里有 3 处
  // （upsertAccount 内部也有），只拿它做断言会被库内部代码骗过；
  // `unverified: void 0` 只出现在这一处（探活模块用的是 lastVerifyError）。
  'host 迟到的 /status 校验只刷元信息、不切号':
    host.includes('listAccounts().find((item) => item.token === auth.token)') &&
    host.includes('unverified: void 0'),
  // 审计 F04：可信校验拿到的 user.id 必须落成去重键，否则同账号重登会堆重复。
  // 三个调用点：凭证落库前（withVerifiedIdentity）、记录已在库里（refreshVerifiedIdentity）、
  // 去重时兼容旧记录（只有 user.id 没有 serverId）。
  'host 可信校验后的身份归一（user.id → serverId）':
    host.includes('withVerifiedIdentity(auth, check.user)') &&
    host.includes('refreshVerifiedIdentity(target.id, target.token, check.user)') &&
    host.includes('!item.serverId && item.user?.id === serverId'),
  // 审计 F06：图片缓存要有账号作用域（切号清空）、真的淘汰过期项、写入时校验作用域
  'host 图片缓存按账号隔离并淘汰过期项':
    host.includes('uploadCache.useScope(auth.token)') &&
    host.includes('uploadCache.prune()') &&
    // 守的是"写缓存时带上 scope"（账号隔离）这个行为，不绑内部变量名：
    // 0.1.66 把局部变量改名成 uploadedFile（避免与调用方那个同名结果混淆），
    // 用 \w+\.fileId 就不必为了改名去动断言。
    /uploadCache\.set\(key,\s*\w+\.fileId,\s*Date\.now\(\),\s*scope\)/.test(host),
  // 审计 F10：建连阶段必须有整体期限，而且**等待本身要可取消** ——
  // abort 只对"肯配合 signal 的传输"立即生效，所以 openCompletion 也被包进了 wait()。
  // 断言调用点：`params.connectTimeoutMs`（3 处读取）+ `await wait(openCompletion(`
  // （拿掉 wait 包装这条立刻红 —— 那正是"限时形同虚设"的形态）。
  'host 建连期限可注入且等待可取消（wait 包住 openCompletion）':
    host.includes('params.connectTimeoutMs') && host.includes('await wait(openCompletion('),
  // 审计 F10：收尾要归还**本次创建过的全部会话** —— 超时/取消会放弃进行中的建连，
  // 它之后才返回的会话必须有人认领（旧实现只管最后那一个 sessionId）。
  'host 收尾归还本次创建的全部会话':
    host.includes('finalized = true') && host.includes('for (const id of owned)'),
  // 审计 F08：登录轮询必须是 startCapturePoll（串行 + 至多提交一次）。
  // `committed = true;` 在产物里有 2 处（成功路径 + fail-open 路径），正是"先占位再提交"。
  'host 登录轮询串行且至多提交一次':
    host.includes('function startCapturePoll(') &&
    host.includes('stopPolling = startCapturePoll(') &&
    host.includes('committed = true;'),
  // 审计 F23：诊断只落元信息（长度 + sha256），且写在 DSH_HOME 下
  'host 丢弃载荷只记元信息（不落原文）':
    host.includes('rejected-meta.jsonl') && host.includes('sha256: createHash'),
  // 审计 F21：迁移成功后删掉旧凭证（不再留 .migrated-* 明文副本），失败可查
  'host 迁移成功后删掉旧凭证':
    host.includes('rmSync(legacy)') && host.includes('legacyMigrationError'),
  // 审计 F19：hours 取整；间隔按「本次开始 − 上次结束」算
  'host 台账 hours 取整且间隔按结束时刻算':
    host.includes('Math.floor(input)') && host.includes('entry.at - entry.ms - lastEnd'),
  // 审计 F22：另存为失败必须 abort（否则留下未提交的临时文件/句柄）。file-picker 进 client bundle。
  'client 另存为失败要 abort writable': client.includes('abort(error)'),
  // 审计 F16：请求体超限给结构化错误；路径导入只接受普通文件
  'host 请求体超限给结构化错误': host.includes('请求体过大（上限'),
  'host 路径导入只接受普通文件': host.includes('不是普通文件'),
  // 审计 F15：CDP 协议错误要 reject；页面筛选按 origin 严格比较
  'host CDP 协议错误要 reject': host.includes('CDP 错误'),
  // 注意：DS_BASE 会被打包器**内联**成字面量，所以这里断的是内联后的形态 ——
  // 它比断 DS_BASE 更强：同时验证了「用 origin 比较」和「比的是正确的域名」。
  'host CDP 页面筛选按 origin 严格比较':
    host.includes('new URL(String(target.url)).origin === "https://chat.deepseek.com"'),
  'client 有 prompt 上限旋钮': client.includes('prompt 上限') && client.includes('maxPromptChars'),
  // 断言「调用点」而不是字段名（改完要重启才生效 = 白做；只断言字段名会被库内部代码骗过）
  'host 保存后即时推给 adapter（不必重启）': host.includes('adapterConfig.maxPromptChars = applied.maxPromptChars'),
  // 跨行伪标记（模型复述的工具结果）要被剥掉
  'host 会剥掉跨行的伪标记': host.includes('LONG_MARKER_TAGS') && host.includes('insideFence'),
  // 退化块（开标签+闭合标签、无 invoke）不再当正文透出
  'host 会剥掉 DSML 裸包裹标签': host.includes('stripStrayToolMarkup') && /\|dsml-\)\(\?:dsml-\)\?/.test(host),
  // F24：思考续段不得被当成正文（`response/fragments/-1/content` 在 fragments 为空时要跟随 sink）。
  // 断言两处修改的**调用点形态**：① 无 fragment 的分支里先判 sink；
  // ② `sink` 不被无条件覆盖成 'fragments'（否则第一处修复会被紧接着的续段抵消）。
  // 注：产物里 `keepChannel` 常量已被 esbuild 内联，必须按内联后的形态匹配。
  'host 思考续段的通道归属（F24）':
    /if \(!fragment\) \{\s*if \(sink === ["']thinking["']\)/.test(host) &&
    /fragments\.length === 0 && \(sink === ["']thinking["']/.test(host),

  // 2026-09-14：退出时会泄漏「正在复用的那个会话」（每次运行必留一个，实测堆了几十个）。
  // 三块缺一不可：① 退出时退役复用槽（按**调用点**匹配，不是函数定义）；
  // ② 欠删会话落盘；③ 启动补删（调用点）。删成功才销账由 deleted 事件承担。
  'host 退出收尾 + 欠删落盘 + 启动补删（防退出泄漏）':
    host.includes('disposeSessionReuse();') &&
    host.includes('sessions-in-use.json') &&
    /runStartupSweep\(\{/.test(host) &&
    // 注：打包器会把字符串字面量统一成双引号，所以别写死单引号
    /kind:\s*["']deleted["']/.test(host),

  // 2026-09-14：清理设置曾被设置页的下一次保存静默抹掉（闸门没初始化这几个字段）。
  'host 把清理设置一起存进闸门（不再被保存冲掉）':
    /sessionCleanup:\s*cleanupMode,\s*cleanupBatch:\s*cleanupBatchRange/.test(host) &&
    /cleanupDelayMs:\s*cleanupDelayRange/.test(host),

  // F25（2026-09-14）：首帧快照丢失时整段思考上屏。
  // 断言按**调用点**写，不是只匹配字段名 —— 库里出现 `orphanBuffer` 只说明变量在，
  // 真正要保证的是「生产链路把思考开关传进了状态机」以及「两处结算点都在」。
  'host 思考续段的暂存与结算（F25）':
    // ⚠️ 这处是整条修复的开关：测试里是自己传的，覆盖不到生产调用点，
    //    所以必须由产物断言守住 —— 漏传了，F25 在生产里等于没修。
    //    0.1.62 起这里还多传了 onResponseMessageId（链式投喂要首帧的 message_id），
    //    所以锁「调用点前缀 + thinkingEnabled 仍在」，不再要求整对象只有这一个键。
    /parseWebSse\(body, \{[\s\S]{0,160}?thinkingEnabled:\s*params\.thinkingEnabled/.test(host) &&
    // 两处结算点：快照（迟到快照）+ APPEND（第一个 fragment 出现）
    /settleOrphans\(out, fragments\[0\]\.type\)/.test(host) &&
    /settleOrphans\(out, fragment\.type\)/.test(host) &&
    host.includes('orphanBuffer'),

  // F26（2026-09-14）：内部用途（标题生成 / 上下文压缩）不得触发自动续写。
  // 实测 13 个会话里 11 个标题是重复垃圾（"在吗在吗在吗"、"安装 archify skills"×3 …）。
  // 同样按**调用点**写：eligible 判定里必须真的带上用途白名单。
  'host 内部用途不得触发自动续写（F26）':
    /allowsAutoContinue\(options\?\.purpose\)\s*&&/.test(host) &&
    /allowsAutoContinue\(purpose\)[\s\S]{0,140}?chat/.test(host),

  // F27（2026-09-14）：收尾兜底归正文（避免把回答吞进思考）+ 思考耗时作为通道证据。
  'host 收尾兜底归正文 + 思考耗时作证据（F27）':
    /settleOrphans\(out, ["']THINK["']\)/.test(host) &&
    /sawData && orphanBuffer[\s\S]{0,500}?directText \+= text[\s\S]{0,40}?emitText\(out, text\)/.test(host),

  // F28（2026-09-14）：兜底加思考包装判据 —— <analysis>/<summary> 等标签的孤儿归思考
  // （实测 [998]：27397 字整块是 analysis+summary 复盘）；帧落盘取证开关默认关、env 控制。
  // 断言仍按**调用点**：标签判据必须出现在 finish 兜底的分支里，而不是仅存在常量。
  'host 孤儿思考包装判据 + 帧落盘取证开关（F28）':
    /sawData && orphanBuffer[\s\S]{0,500}?THINKING_WRAPPER_RE\.test\(text\)[\s\S]{0,120}?emitThinking\(out, text\)/.test(host) &&
    /DSH_WEB_LOGIN_DUMP_SSE/.test(host) &&
    /appendFileSync\(dumpPath/.test(host),

  // F29（2026-09-14）：短回答（<40 字）不判句中被截；内部用途收尾日志分档
  // （旧文案"额度已用尽"在白名单拦截时也打，误导排查）；续写轮丢弃给可见提示。
  'host 短回答下限 + 日志分档 + 丢弃可见提示（F29）':
    /trimmed\.length < 40\) return false/.test(host) &&
    /purpose=\$\{String\(options\?\.purpose\)\}/.test(host) &&
    /被丢弃，该调用未执行/.test(host),

  // 0.1.61（2026-09-14）：账号「能不能用」的可见性 —— 三处都按**调用点**断言。
  // ① 探活成功显式清 unverified（否则"未校验"标永久粘住：实测 5/5 全挂、
  //    连刚校验过的那个也挂着，信息量归零）；② AUTH 失败立刻回写 lastVerifyError
  //    （否则切到死号时界面完全静默，用户只看到一条报错）；
  // ③ 切号前先探活，失败带 needsRelogin 拦下（别让用户白切一轮）。
  'host 账号登录态可见性三处接线（0.1.61）':
    /lastVerifiedAt:\s*at[\s\S]{0,80}?unverified:\s*false/.test(host) &&
    /info\.code\s*===\s*["']AUTH["'][\s\S]{0,240}?lastVerifyError:\s*\{/.test(host) &&
    /probeOnce\(target[\s\S]{0,700}?needsRelogin/.test(host),

  // 0.1.62（2026-09-14）：链式投喂 —— 这四条都是**接线**，纯函数测试守不住。
  // ① 请求体的 parent 与 prompt 必须来自决策结果（写死 null 就退化成永远全量）；
  // ② 决策必须带上当前模式与结构化 prompt（promptParts 漏传 = 静默退化成全量）；
  // ③ 首帧 ready 里的 response_message_id 要真的被交出去（拿不到就没有 parent 可指）；
  // ④ 只有「跑完 + 未污染 + 拿到 id」才把链接上（否则下一轮会续到不存在的父消息上）。
  'host 链式投喂的四处接线（0.1.62）':
    /parent_message_id:\s*feed\.parentMessageId/.test(host) &&
    /prompt:\s*feed\.prompt/.test(host) &&
    /mode:\s*currentContextMode\(\)/.test(host) &&
    /promptParts:\s*\{[\s\S]{0,160}?entries:\s*promptParts\.entries/.test(host) &&
    /typeof d\.response_message_id === ["']number["'][\s\S]{0,80}?onResponseMessageId/.test(host) &&
    /sentFeed\?\.next && complete && !poisoned[\s\S]{0,160}?contextChain = \{[\s\S]{0,80}?parentId: responseMessageId/.test(host) &&
    host.includes('context-feed.json'),

  // 0.1.62：设置开关要真的接上（宿主路由 + 客户端按钮都在），否则用户点不到。
  'client/host 上下文投喂设置可切换（0.1.62）':
    /route === ["']\/context-mode["']/.test(host) &&
    /writeContextModeSetting\(wanted\)/.test(host) &&
    /applyContextMode\(/.test(host) &&
    client.includes('链式投喂（只发增量）') &&
    // 打包器把字符串字面量统一成双引号，别写死引号形式（老坑）
    /api\(["']\/context-mode["']/.test(client) &&
    /renderContextStatus = \(/.test(client),

  // 0.1.63（2026-09-15）：三处修正，都是"看不见但会让人误判"的那类。
  // ① 客户端读的层级必须与宿主返回一致（`/status` 的字段在 `config` 里；0.1.62 读顶层 = 死代码）；
  // ② 链状态只在链式模式下回（否则界面会出现「每轮全量 + 链式正在跑」）；
  // ③ 切到全量时链立刻作废（否则以后切回链式会从一个过期父消息续链）；
  // ④ 决策原因要真的上报一次（无它则链式在日志里完全不可见）。
  'host/client 链式投喂可诊断性与状态一致性（0.1.63）':
    /const cfg = status\.config/.test(client) &&
    /cfg\?\.contextMode/.test(client) &&
    !/status\.contextMode/.test(client) &&
    /contextMode === ["']chained["'] \? contextChainInfo\(\) \?\? null : null/.test(host) &&
    /contextMode === ["']full["']\) resetContextChain\(\)/.test(host) &&
    /feed\.reason !== lastFeedReason/.test(host) &&
    /params\.onContextFeed\?\.\(\{[\s\S]{0,160}?chained: feed\.parentMessageId !== null/.test(host) &&
    /onContextFeed: \(report\)/.test(host) &&
    host.includes('链式投喂退回全量重发（原因='),

  // 0.1.64（2026-09-15）：界面可读性 —— 报错要醒目、重要提示要有标注、
  // 文案里不许有 markdown 星号（界面是纯文本，会原样显示成 **xxx**）。
  // 断言打在**产物**上：样式判定与 append 接线都在 client.js 里，纯源码检查守不住打包后的形态。
  'client 反馈节点自动醒目 + 徽章标注 + 无 markdown 星号（0.1.64）':
    /createMsgNode/.test(client) &&
    /失败\|错误\|无法\|不对(\|⚠️)?\/\.test\(text\)/.test(client) &&
    /dsw-msg err/.test(client) &&
    /append\(accountsMsg\.node\)/.test(client) &&
    client.includes('✅ 当前') &&
    client.includes('❔ 未校验') &&
    client.includes('⏳ 受限至') &&
    client.includes('❌ 需要重新登录') &&
    client.includes('⚠️ 导出的备份文件就是可完整登录的凭证') &&
    !/\*\*可完整登录的凭证\*\*/.test(client) &&
    !/\*\*按字符估算\*\*/.test(client),

  // 0.1.65（2026-09-15）：重新登录必须**原地更新那一条记录**。
  // 用户实测：点「重新登录这个账号」→ 重登成功 → 库里多出一条同名账号、旧那条还挂着
  // 「需要重新登录」。四处接线缺一不可，故按调用点断言。
  // 0.1.66（2026-09-15）：图片引用去重 + 图丢了要可见。
  // 三条都是接线级行为，纯函数测不到（真实上传要 PoW+网络），按**调用点**断言。
  // 0.1.68：上传文件名必须声明受支持的图片类型
  // （服务端按**后缀**判类型；宿主给 tool/result 的 name 是纯 sha256）
  'host 上传文件名归一为 imageUploadName（按调用点匹配）':
    // 守调用点：归一后的名字要真的传进上传参数，且入参来自宿主给的 ref.name
    /name:\s*imageUploadName\([^)]*ref\.name/.test(host) &&
    // 两张表进了产物才算函数体真的在（否则上面那句可能只是"看起来对了"）
    host.includes('IMAGE_EXT_BY_MEDIA_TYPE') &&
    host.includes('KNOWN_IMAGE_EXT'),

  'host 图片引用去重 + 失败回传 + 上传可注入（0.1.66）':
    // 去重必须发生在遍历 refs 的循环里（而不是别处的同名字段）
    /for \(const ref of refs\) \{[\s\S]{0,140}?seen\.has\(key\)\) continue;[\s\S]{0,80}?unique\.push\(ref\)/.test(host) &&
    // 上传失败要随 ids 一起回传原因（否则调用方无从告知）
    /notice:\s*imageNotice\(failures\.length,\s*failures\[0\]\)/.test(host) &&
    // 注入点：缺省才走真实上传（生产调用点必须真的读这个 dep）
    /deps\.uploadImage\s*\?\?\s*uploadImageFile/.test(host),

  // 0.1.66：面板文案是纯文本 —— `**系统代理**` 会被原样显示成带星号。
  // 0.1.64 只扫了 client/cookies，host 侧这处一直漏着（界面截图上看不出，得读源码才发现）。
  'host 传输层提示没有 markdown 星号（0.1.66）':
    host.includes('Chromium 网络栈会跟随「系统代理」') &&
    !/跟随\*\*系统代理\*\*/.test(host),

  'host 图片丢失要写进正文（0.1.66）':
    // 提示必须在流开始处作为正文首段吐出去（设置页不会自动弹，正文是唯一保证可见的通道）
    /if \(uploaded\.notice\) \{[\s\S]{0,160}?blockType:\s*["']text["']/.test(host) &&
    /没能传给模型/.test(host) &&
    /本轮回答只基于文字内容/.test(host),

  // 0.1.66：续写判据补漏 —— 「；」与「、」都是**分隔符**（列举/分句写到一半），
  // 旧实现把它们落到"非标点字符 → false"兜底上判成已写完；而服务端会在句中截断却照发
  // FINISHED，此时 cutByServer 为 false、这条判据是唯一防线 ⇒ 静默少一段。
  'host 续写判据把「；」「、」算作未写完（0.1.66）':
    /MID_SENTENCE_TAIL = \/\* @__PURE__ \*\/ new Set\(\[[\s\S]*?"、",[\s\S]*?"；",[\s\S]*?\]\)/.test(host) &&
    /if \(MID_SENTENCE_TAIL\.has\(last\)\) return true/.test(host) &&
    // 顺带守住"没把句末标点也放宽" —— 否则变成逢标点就续写
    /COMPLETE_TAIL = \/\* @__PURE__ \*\/ new Set\(\[[\s\S]*?"。"[\s\S]*?\]\)/.test(host),

  // 0.1.67（2026-09-15，用户反馈）：账号库列表要**跟着轮询自己更新**。
  // 现象「新登一个号，账号库不刷新，退出一下才看到」的根因：列表不在 /status 里，
  // 只有显式 loadAccounts() 才重读，而登录捕获是异步落地的（CDP 那条路要等用户在
  // 浏览器里登录完；能开 Electron 窗口那条路"开窗即返回"）⇒ 捕获晚一步就永远不显示。
  // 客户端里那句"万一捕获是异步落地的也能及时刷出来"的注释说明作者本来就想靠轮询兜住，
  // 但轮询只读 /status，那个兜底从未生效。四处缺一不可，故按调用点断言。
  'client 账号库跟着轮询自动同步（0.1.67）':
    // ① 轮询里按节拍真的去同步 —— 这一句就是"让原来那句注释成真"
    /if \(shouldSyncAccounts\(Date\.now\(\), accountsSyncedAt, active\)\) syncAccounts\(\)/.test(client) &&
    // ② 内容没变就不重建 DOM（否则每 3 秒会把用户正在悬停/要点的按钮换掉）
    /if \(signature && signature === accountsSignatureCache\) return;/.test(client) &&
    // ③ 显式读取与后台同步共用同一个渲染入口
    /const applyAccounts = \(data\) => \{[\s\S]{0,140}?accountsSignature\(data\)/.test(client) &&
    // ④ 后台同步必须**静默**（catch 体为空）—— 轮询的偶发失败不该覆盖用户正在看的那条消息
    /const syncAccounts = async \(\) => \{[\s\S]{0,260}?catch \{\s*\}/.test(client) &&
    // ⑤ 纯判据模块必须真的被打进产物（不是只写在源码里）
    /function shouldSyncAccounts\(now, lastSyncedAt, active\)/.test(client),

  'host/client 重新登录原地更新（0.1.65）':
    /beginRelogin\(id\)/.test(host) &&
    /relogin:\s*commit\.mode\s*===\s*["']relogin["']/.test(host) &&
    /upsertAccount\(auth,\s*\{\s*id:\s*target\s*\}\)/.test(host) &&
    /updateAccount\(target,\s*\{\s*lastVerifyError:\s*void 0\s*\}\)/.test(host) &&
    /sameAccount\(existing, auth\)/.test(host) &&
    client.includes('凭证已原地更新') &&
    // ⚠️ 这里原来写的是 `/dsw-account-actions[\s\S]{0,320}?"重新登录"/` —— 一个脆弱的巧合：
    // 它匹配到的其实是 **CSS 里**那次 `dsw-account-actions`，靠 320 字符的窗口罩住了后面的文案。
    // 于是"把按钮文案从「重新登录」缩成「重登」"这种纯文案改动就会让它假红（实测 2026-09-16）。
    // 改成绑函数名：真正要守的是「动作列里的入口调的是 reloginAccount（那条不清浏览器登录态的路）」。
    /reloginAccount\(item\.id/.test(client),
  // 0.1.69：账号显示名不再二次屏蔽（幂等守卫必须真的进了产物）
  'host 账号显示名不再二次屏蔽（maskIdentifier 幂等）':
    /function maskIdentifier[\s\S]{0,260}?includes\(["']\*\*\*["']\)/.test(host),
  // 0.1.70：日志必须区分「正文 0 字 + 已提取到工具调用」（健康形态，实测占 30%）与
  // 「正文 0 字 + 无工具调用」（异常）。旧文案一律说"内容可能全在思考通道"，
  // 实测把读日志的另一个模型窗口带偏成"每天上百次故障"。
  'host 日志区分「工具调用轮」与「真空转」':
    /已提取到工具调用[\s\S]{0,80}?且无工具调用/.test(host) &&
    host.includes('全落在思考通道'),
  // 0.1.71（A）：回声守卫是「从命中行起砍到结尾」⇒「有正文 + 有回声」必须**告知用户**，
  // 不能静默丢掉后半段（实测 2026-09-16 17:35 两次断在「问题项 4」处，丢的正是 4/5 项与结论）。
  'host 回声过滤后必须告知用户（不静默丢内容）':
    /echoedTranscript\s*&&\s*toolCallCount\s*===\s*0[\s\S]{0,200}?历史回放格式/.test(host) &&
    host.includes('回答可能因此不完整'),
  // 0.1.71（C）：行内转写特征分强弱两档 —— 弱档（正文里引用一次 `[Tool Result …]`）只扣住、等后文再判；
  // 强档（prompt 的截断占位符）照旧立即判回声。
  'host 行内转写特征分强弱两档（弱档不再一律砍）':
    /ECHO_INLINE_WEAK_SIGNATURES\s*=\s*\[/.test(host) &&
    /ECHO_INLINE_STRONG_SIGNATURES\s*=\s*\[/.test(host) &&
    /WEAK_HOLD_LINES\s*=\s*2/.test(host),
  // 弱特征行扣住期间，后续行也必须缓冲 —— 否则它们会抢在被扣的行之前上屏（正文顺序错乱）。
  'host 扣住期间缓冲后续行（保正文顺序）':
    /heldTail\.push\(line\)/.test(host) &&
    /for \(const held of this\.heldTail\)\s*out \+= held/.test(host),
  // 0.1.71：账号分组（组定义单独落盘、分区在宿主算、删组不碰账号文件）+ 备注改名 + 手动校验。
  // 断言一律按**打包后的真实形态**写（打包器统一双引号、纯逻辑常量会被内联掉）。
  // ⚠️ 断言要写「**意图**」，不能照抄当时的代码 —— 下面这条曾经写成 `partitionByGroup(list, …)`，
  // 等于把 0.1.71 的回归（sections 里喂原始记录 ⇒ 标题退化成 acc_xxxxxxx）固化成了期望值。
  'host 分组：sections 里喂的是「可直接渲染的视图」':
    /sections: partitionByGroup\(accounts, groups, activeId\)/.test(host) &&
    /const accounts = list\.map\(/.test(host) &&
    /^\s*accounts,$/m.test(host),
  'host 分组：sections 不得喂原始记录（0.1.71 回归的哨兵）':
    !/partitionByGroup\(list, groups/.test(host),
  'host 分组：组定义单独落盘 + 读盘容错':
    host.includes('groups.json') &&
    /function normalizeGroupList/.test(host) &&
    /function writeGroups/.test(host) &&
    /MAX_GROUPS|最多/.test(host),
  'host 分组：删组只删定义（不动账号文件）':
    /removeGroup\(readGroups\(\), id\)/.test(host),
  'host 校验全部：串行探活 + 互斥开关 + 只读路由':
    host.includes('/accounts/refresh') &&
    /accountsRefreshInFlight = true/.test(host) &&
    /accountsRefreshInFlight = false/.test(host),
  'client 分组：分区渲染 + 折叠 + 归组下拉都在':
    client.includes('dsw-grouphead') &&
    client.includes('dsw-groupsel') &&
    client.includes('dsw-accounts-collapsed-groups') &&
    client.includes('new Option("未分组", "")'),
  'client 按钮文案：重登 / 备注 / 校验全部 / 新建分组':
    client.includes('"重登"') &&
    client.includes('"备注"') &&
    client.includes('"校验全部"') &&
    client.includes('"新建分组"') &&
    !/dsw-btn dsw-preset",\s*"重新登录"/.test(client),
  'client 重建签名必须覆盖 groups 与 sections（否则新建组不刷新）':
    /JSON\.stringify\(\{\s*activeId: data\.activeId \?\? null,\s*accounts,\s*groups,\s*sections\s*\}\)/.test(client),
}

let failed = 0
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) failed += 1
  console.log(` ${ok ? '✓' : '✗'} ${name}`)
}
console.log(failed === 0 ? '\n产物核对全部通过 ✅' : `\n产物核对失败 ${failed} 项 ❌`)
process.exitCode = failed === 0 ? 0 : 1
