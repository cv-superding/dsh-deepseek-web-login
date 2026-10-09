/**
 * dsh-deepseek-web-login — 插件入口（host）。
 *
 * 做三件事：
 *  1) 把 deepseek-web 适配器注册进 ctx.llm（注册即绑定本插件 fiber，热重载即净）
 *  2) 挂 webServer 前缀 API /deepseek-web-login/api/*（client 面板消费）
 *  3) 提供设置页（client 侧 slots: settings.section）所需的状态/登录/测试接口
 *
 * 设计约束：宿主自包含打包（除 node: 与 electron 外全部 bundle），
 * 不依赖 DSH 内部包的可解析性 —— 任何装配路径（注入 / bundle / patch）都能加载。
 */
import { maskIdentifier, readAuth, refreshVerifiedIdentity, withVerifiedIdentity, writeAuth, type WebAuth } from './auth.ts'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { PROVIDER, createAdapter, describeAuth, MODEL_SPECS, type AdapterConfig } from './adapter.ts'
import {
  createRequestGate,
  readGateSettings,
  writeGateSettings,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_MAX_REQUEST_INTERVAL_MS,
  DEFAULT_LONG_RUN_THRESHOLD,
  MAX_PROMPT_CHARS_BOUNDS,
  DEFAULT_MAX_PROMPT_CHARS,
  MAX_REF_IMAGES_BOUNDS,
  DEFAULT_MAX_REF_IMAGES,
  clampMaxPromptChars,
  INTERVAL_PRESETS,
  MAX_INTERVAL_MS,
  CLEANUP_BATCH_BOUNDS,
  CLEANUP_DELAY_BOUNDS_MS,
  CLEANUP_GAP_BOUNDS_MS,
  DEFAULT_CLEANUP_BATCH,
  DEFAULT_CLEANUP_DELAY_MS,
  DEFAULT_CLEANUP_GAP_MS,
  normalizeCleanupRange,
  clampMaxRefImages,
  clampContextWindow,
  CONTEXT_WINDOW_BOUNDS,
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_CONTEXT_WINDOW,
  clampAutoSwitchMinutes,
  AUTO_SWITCH_BOUNDS,
  DEFAULT_AUTO_SWITCH_MINUTES,
  type GateSettings,
} from './gate.ts'
import { setHostLanguage } from './ui-language.ts'
import { decideAutoSwitch, freshThrottledIds, hasFailoverCandidate, isThrottleSwitchAllowed, type SwitchableAccount } from './auto-switch.ts'
import { browserLogin, clearBrowserLoginProfile, findSystemBrowser } from './browser-login.ts'
import { canOpenElectronWindow, clearLoginPartition, clearLoginState, closeLoginWindow, captureFromPartition, getFingerprintReport, getLastLoginResult, getLoginProgress, isLoginWindowOpen, loginWithToken, logout, openExternalLogin, openLoginWindow } from './login.ts'
import { beginAddAccount, beginRelogin, commitCapturedAuth, endAddAccount, endRelogin } from './account-add.ts'
// 自动重登（0.6.14）：凭证库 + "哪些号该重登"的判据都在 relogin.ts（纯逻辑，有离线用例）
import { credentialForDisplay, readCredentialEntries, saveCredential, selectReloginTargets } from './relogin.ts'
import {
  validateAuth,
  createSessionCleaner,
  clearLiveSession,
  currentFetch,
  contextChainInfo,
  resetContextChain,
  DEFAULT_SESSION_CLEANUP,
  DEFAULT_SESSION_REUSE_TURNS,
  disposeSessionReuse,
  setSessionLifecycleHook,
  type SessionCleanupMode,
} from './webapi.ts'
import { consumeProbeRequest, runNetFetchDiagnostics, type NetFetchMode } from './net-diagnostics.ts'
import { noteCall as writeLedgerEntry, pruneLedger, summarizeLedger, ledgerDir, LEDGER_KEEP_DAYS } from './ledger.ts'
import {
  noteUsage as writeUsageEntry,
  pruneUsage,
  summarizeUsage,
  usageDir,
  usageEntryFrom,
  usageExists,
  USAGE_KEEP_DAYS,
} from './usage.ts'
import {
  planRelogin,
  probeOnce,
  startProbeLoop,
  SWITCH_PROBE_TIMEOUT_MS,
  switchGateFromProbe,
} from './probe.ts'
import { checkForUpdate, RELEASE_REPO } from './update-check.ts'
import { pluginVersion } from './version.ts'
import { webLoginDir } from './paths.ts'
import { removeJournalEntry, runStartupSweep, upsertJournalEntry } from './session-journal.ts'
import {
  accountsDir,
  accountsFootprint,
  accountTitle,
  activeAccountId,
  exportAccounts,
  exportAccountsToFile,
  importAccounts,
  legacyMigrationError,
  listAccounts,
  migrateLegacyAuthIfNeeded,
  identifierKindOf,
  readAccount,
  removeAccount,
  setActiveAccount,
  updateAccount,
} from './accounts.ts'
import {
  createGroup,
  partitionByGroup,
  readGroups,
  removeGroup,
  renameGroup,
  writeGroups,
} from './account-groups.ts'
import {
  applyTransport,
  readTransportSetting,
  transportSettingsPath,
  writeTransportSetting,
  DEFAULT_TRANSPORT,
  TRANSPORT_HINT,
  type TransportKind,
  shutdownBrowserTransport,
} from './transport.ts'
import {
  applyContextMode,
  applyFreshSessionOnRestart,
  contextModeSettingsPath,
  readContextModeSetting,
  writeContextModeSetting,
  CONTEXT_MODE_HINT,
  DEFAULT_CONTEXT_MODE,
  type ContextMode,
} from './context-feed.ts'

export const name = 'dsh-deepseek-web-login'
export const inject = ['llm', 'webServer']

/** 账号备份导入的大小上限 —— 与前端 `IMPORT_FILE_LIMIT_BYTES` 保持一致（实测单账号
 *  ~1.7 KB、账号数上限 500 → ~850 KB，取 2 MiB 留 2 倍余量）。 */
const IMPORT_FILE_LIMIT_BYTES = 2 * 1024 * 1024

const API_PREFIX = '/deepseek-web-login/api'

export interface Config extends AdapterConfig {
  /**
   * 传输层：网页端请求从哪个网络栈出去。
   * `chromium`（默认）＝ Electron 的 `net.fetch`，指纹与真实浏览器一致；`node` ＝ 原来的 undici。
   * 设置页保存的值优先于这里；环境不支持 chromium 时自动降级为 node。详见 transport.ts。
   */
  transport?: TransportKind
  /**
   * 上下文投喂方式：`full`（默认）＝每轮重发全量 prompt；`chained`＝只发增量、把上一条回答
   * 当父消息链接上去，让服务端维护上下文。设置页保存的值优先于这里，改动即时生效。
   * 取舍与回退条件见 context-feed.ts 的模块注释。
   */
  contextMode?: ContextMode
  /**
   * 登录态主动探活的间隔（毫秒），默认 30 分钟；设 0 关闭。
   *
   * 探活走**只读**的 `users/current`（零额度），目的是在任务跑到一半之前发现登录态失效。
   * 关掉它的代价就是"过期只能靠一次失败的调用才发现"。
   */
  probeIntervalMs?: number
}

interface Logger {
  info?: (message: string) => void
  warn?: (message: string) => void
  debug?: (message: string) => void
}

function normalizeLogger(logger: any): Logger {
  if (!logger) return {}
  return {
    info: typeof logger.info === 'function' ? (message: string) => logger.info(message) : undefined,
    warn: typeof logger.warn === 'function' ? (message: string) => logger.warn(message) : undefined,
    debug: typeof logger.debug === 'function' ? (message: string) => logger.debug(message) : undefined,
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * ⚠️ 审计 F16 修的三件事：
 *  - **生命周期**：客户端只触发 `close`/`aborted`（不发 `end`/`error`）时，旧实现会**永不结算**，
 *    那个 Promise 连同它的监听器一起挂着；现在把 close/aborted 也当"结束"，并且**每种结局都清监听**。
 *  - **应用层超时**：慢速上传没有 deadline，一个连接可以永远占着；现在 10 秒截止。
 *  - **结构化错误**：超限旧实现是 `destroy()` 后 resolve(undefined)，调用方只能报"缺少 payload"，
 *    客户端更可能只看到断连。现在抛带状态码的 BodyError，由 handler 统一回 413/400/408。
 */
export class BodyError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readJsonBody(req: any, limitBytes = 256 * 1024): Promise<any> {
  return await new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      req.off('close', onClose)
    }
    const done = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        // 主动把剩余请求体丢掉，避免连接卡在"客户端还在写、我们已不读"的状态
        try {
          req.resume?.()
        } catch {}
        reject(error)
      } else {
        resolve(value)
      }
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > limitBytes) {
        done(new BodyError(413, `请求体过大（上限 ${Math.floor(limitBytes / 1024)} KiB）`))
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => {
      if (chunks.length === 0) {
        done(undefined, {})
        return
      }
      try {
        done(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        done(new BodyError(400, '请求体不是合法 JSON'))
      }
    }
    const onError = () => done(new BodyError(400, '读取请求体失败'))
    const onAborted = () => done(new BodyError(400, '请求已中止'))
    const onClose = () => {
      // `close` 在正常结束之后也会触发 —— 只有"还没收完就关了"才算中止
      if (!req.complete) onAborted()
    }
    const timer = setTimeout(() => done(new BodyError(408, '读取请求体超时')), 10_000)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}

function sendJson(res: any, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** `/accounts/refresh` 的互斥：手动刷新是串行探活，狂点按钮不该叠起来打。 */
let accountsRefreshInFlight = false

export function apply(ctx: any, config: Config = {}): void {
  const logger = normalizeLogger(ctx.logger)

  // ── 运行时能力探测（每次启动打印一次）──────────────────────────────
  // 为什么需要：插件宿主是 Electron 的 **utility 进程**，能拿到的 API 与主进程不同
  // （已知 shell 可用；session / BrowserWindow 属主进程专属，不可用）。
  // 最关心 `electron.net`：官方文档写明 net 模块适用于 Main + Utility 两个进程，
  // 且 utility 的网络请求默认走 Chromium 的 system network context —— 若 net.fetch 可用，
  // 就能把网页端请求从 Node 网络栈换成 **Chromium 网络栈**，从而获得与真实浏览器一致的
  // TLS / HTTP2 指纹（实测 Node fetch 的 JA3/JA4 与 Chrome 是结构性差异：h1 vs h2、无 GREASE 等）。
  try {
    const electron: any = createRequire(import.meta.url)('electron')
    const net = electron?.net
    const keys = electron && typeof electron === 'object' ? Object.keys(electron).sort() : []
    logger.info?.(
      `deepseek-web: [能力探测] process.type=${(process as any).type ?? '-'}` +
        ` electron=${process.versions?.electron ?? '-'}` +
        ` | electron:${typeof electron} keys=[${keys.join(',')}]` +
        ` | net=${typeof net} net.fetch=${typeof net?.fetch} net.request=${typeof net?.request}` +
        ` | shell=${typeof electron?.shell} session=${typeof electron?.session}` +
        ` BrowserWindow=${typeof electron?.BrowserWindow}`,
    )
  } catch (error: any) {
    logger.info?.(`deepseek-web: [能力探测] require('electron') 失败：${error?.message ?? error}`)
  }

  // 启动时的一次性 net.fetch 诊断：往 <DSH_HOME>/web-login/probe-request.json 写
  // {"mode":"probe"} 或 {"mode":"stream"} 后重启 DSH 即会执行（宿主进程不接受 HTTP 时走这条路）。
  // 平时这个文件不存在 → 零开销；执行完会改名为 *.done-<时间戳>，不删文件。
  const startupProbe = consumeProbeRequest()
  if (startupProbe) {
    void (async () => {
      try {
        const result = await runNetFetchDiagnostics(readAuth(), startupProbe)
        logger.info?.(`deepseek-web: [net-fetch 探测] ${JSON.stringify(result)}`)
      } catch (error: any) {
        logger.info?.(`deepseek-web: [net-fetch 探测] 失败：${error?.message ?? error}`)
      }
    })()
  }

  // 节流设置：设置页保存过的值（gate.json）优先于 cordis config —— 设置页是用户的显式操作，
  // 不该被配置文件里的旧值盖回去。闸门在这里创建并共享给适配器，设置页改完即时生效。
  const savedGate = readGateSettings()

  // 临时会话清理策略：默认「攒批 + 延迟」，减少「每轮建一个立刻删一个」的机器特征。
  // immediate 用老参数（1.5s / 每次一个）；deferred 用可配的延迟与批量阈值。
  // 在闸门之前算：闸门不执行它，但要**存下来**（否则保存设置页时会把它冲掉，见下面那几行）。
  const cleanupMode: SessionCleanupMode =
    savedGate?.sessionCleanup ?? config.sessionCleanup ?? DEFAULT_SESSION_CLEANUP.mode
  // 三个"区间"参数：设置页保存过就用保存的，否则用内置默认（均值都落在原来的固定值上）。
  // 只在 deferred 模式生效 —— immediate 是"老行为"，固定 1.5s / 每次一个，不掺随机。
  const cleanupBatchRange = savedGate?.cleanupBatch ?? DEFAULT_CLEANUP_BATCH
  const cleanupDelayRange = savedGate?.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS
  const cleanupGapRange = savedGate?.cleanupGapMs ?? DEFAULT_CLEANUP_GAP_MS

  const gate = createRequestGate({
    allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
    // ⚠️ min / max 必须**成对**传：createRequestGate 在只收到 `minIntervalMs` 时，
    // 会把 `maxIntervalMs` 兜底成 min（见 gate.ts），也就是**随机区间退化成固定间隔**。
    // 2026-09-12 实测：设置页保存的 2000~4000，重启 DSH 后就变成固定 2000ms；
    // 而固定间隔恰恰是最典型的机器特征，用户完全不知情（日志里只会显示"区间 2000~2000"）。
    minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxIntervalMs: savedGate?.maxRequestIntervalMs ?? config.maxRequestIntervalMs ?? DEFAULT_MAX_REQUEST_INTERVAL_MS,
    // 长任务保护：连续 N 次请求后强制长休一次（0 = 关闭）。
    longRunThreshold: savedGate?.longRunThreshold ?? DEFAULT_LONG_RUN_THRESHOLD,
    maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES,
    contextWindow: savedGate?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    autoSwitchMinutes: savedGate?.autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES,
    // 工具调用是否允批量（**缺省＝串行**）。adapter 每轮序列化 prompt 时现读 ⇒ 改完即时生效。
    serialToolCalls: savedGate?.serialToolCalls !== false,
    // 到期前自动重登（0.6.14）：**缺省关闭**（`=== true` 而不是 `!== false`）——
    // 打开它会每约 2 小时静默起一次无头浏览器，这种事必须是用户明确点开的。
    autoRelogin: savedGate?.autoRelogin === true,
    // 重开链是否换新会话（0.6.22）：**缺省关闭**（`=== true`）—— 见 GateSettings 的说明。
    freshSessionOnRestart: savedGate?.freshSessionOnRestart === true,
    longRunBreakMs: savedGate?.longRunBreakMs,
    // ⚠️ 会话清理这几个字段必须**一起传**（2026-09-14 修）：设置页保存时写的是
    // `gate.settings()` 的返回值 —— 没存进闸门的字段会被**静默抹掉**，
    // 于是用户只调了下请求间隔，清理设置（模式 + 三个区间）就在下次重启时回到内置默认。
    sessionCleanup: cleanupMode,
    cleanupBatch: cleanupBatchRange,
    cleanupDelayMs: cleanupDelayRange,
    cleanupGapMs: cleanupGapRange,
    logger,
  })

  // 重开链是否换新会话（0.6.22）：把设置同步到 context-feed 的模块级开关。
  // ⚠️ 必须在**任何请求之前**执行 —— 它影响链的决策（见 needsFreshSession）。
  applyFreshSessionOnRestart(gate.settings().freshSessionOnRestart === true)

  // 旧版（≤0.1.25）只有一份 deepseek-auth.json；首次启动时迁进账号库。
  // 只在「库为空 且 旧文件在」时跑一次；成功迁移后**删掉旧文件**（审计 F21：
  // 留 `.migrated-*` 明文副本会让"退出清凭证"变成谎话）。
  const migratedAccount = migrateLegacyAuthIfNeeded()
  if (migratedAccount) {
    logger.info?.(`deepseek-web: 已把旧的单账号凭证迁移进账号库（${migratedAccount.id}）`)
  } else {
    // ⚠️ 迁移失败不能静默：旧凭证可能还明文躺在磁盘上、照样能登录，用户有权知道
    const migrationError = legacyMigrationError()
    if (migrationError) logger.warn?.(`deepseek-web: ${migrationError}`)
  }

  // 传输层：默认走 Chromium 网络栈（TLS/HTTP2 指纹与真实浏览器一致，见 transport.ts 的模块注释）。
  // 优先级：设置页保存的值 > cordis config > 内置默认；环境拿不到 electron.net.fetch 时降级为 Node。
  let transportState = applyTransport(
    readTransportSetting() ?? (config.transport === 'node' ? 'node' : DEFAULT_TRANSPORT),
  )
  logger.info?.(
    `deepseek-web: 传输层=${transportState.effective}` +
      (transportState.degraded
        ? '（配置要求 Chrome，但本环境没有 electron.net.fetch 也没有系统浏览器，已降级为 Node）'
        : transportState.viaBrowserProxy
          ? '（通过系统 Edge/Chrome 进程代理）'
          : ''),
  )

  // ── 自动切换账号（**检查点式**，刻意不用定时器）────────────────────────
  // 为什么不用 setInterval：本项目对定时器有过教训（见 gate.ts 里"unref 有前科"那段）——
  // 宿主关停时定时器会拖住进程，要正确清理又得管一套生命周期。改成**请求进入时的检查点**：
  // 每次有请求要发（闸门放行之前）顺带判断一次"该不该换号"。
  // 语义上也更准：没有请求就没有风控暴露，本来也不需要换号。
  //
  // ⚠️ 它**只看时间**，不看限流状态：定时均衡轮换是把单账号密度摊薄（分散），
  // 而"一被限流就换号"会让同一出口 IP 上多号交替活跃（更像有组织的规避）。两者的区别见
  // auto-switch.ts 的模块注释。唯一的例外是**当前账号自己不可用**（失效 / 受限未解除）——
  // 那种情况下等满 N 分钟没有意义，立刻切走。
  let lastAutoSwitchAt = Date.now()
  /**
   * 上一次**真正换过号**的时刻（自动或手动），0 = 本次启动还没换过。
   *
   * 🔴 为什么不能用上面那个 `lastAutoSwitchAt` 代替：它在启动时被初始化成"启动时刻"
   * （`isSwitchDue` 要的是"从启动算起过了多久"）。而限流换号有自己的**冷却**（距上次换号
   * 至少 3 分钟），若拿"启动时刻"当"上次换号"，就会**每次重启后都开出一段"限流也不换号"
   * 的窗口** —— 实测 2026-09-27：插件 10:56:30 启动、10:57:54 撞限流，距启动只有 73 秒
   * ⇒ 被自己的冷却挡掉，用户看到的是"依旧没有自动切换账号"。
   * 用它之后语义才对：**没换过号 ⇒ 不套冷却**（限流是明确的坏状态，值得立刻换走）。
   *
   * 只在**换号成功**（含手动切号）时更新；探活失败、换号抛错都不算换过号。
   */
  let lastSwitchedAt = 0
  /**
   * 最近一次**自动**换号的记录（只给界面显示用，不落盘）。
   *
   * 只记自动换号：手动切号是用户自己的操作，界面不需要"提示"他刚做过什么。
   * 刻意只放内存 —— 换号是运行时的行为，重启后从"还没有记录"开始，比留一份过期时间更诚实。
   */
  let lastAutoSwitch: { at: number; from: string; to: string; reason: string } | undefined
  let autoSwitching = false
  /** 本轮探活失败过的账号 —— 不选它们，避免在同一个坏号上反复试。进程重启即清空。 */
  const autoSwitchSkip = new Set<string>()
  /**
   * 各账号最近一次**被限流**（throttled，不是封禁）的时刻 —— 只放内存，进程重启即清空。
   *
   * 为什么不写进账号记录：限流是**瞬时**反馈（窗口几十秒到十几分钟），而账号记录里的 `limit`
   * 表达的是"服务端给了明确解除时间的账号级限制"。混在一起会让界面把"刚才发太快了"
   * 显示成"账号受限"，而且那记录会一直留在库里。
   *
   * 两个用途：① 判断当前账号是不是"刚被限流"（该不该为它提前换号）
   * ② 作为**排除项**（`freshThrottledIds`）—— 别切到另一个同样刚被限流的号上，那是白换一轮。
   */
  const throttleAt = new Map<string, number>()

  async function maybeAutoSwitch(): Promise<void> {
    if (autoSwitching) return // 上一次还在探活，别叠加
    const minutes = gate.settings().autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES
    if (!Number.isFinite(minutes) || minutes <= 0) return
    const accounts = listAccounts().filter((account) => !autoSwitchSkip.has(account.id))
    const decision = decideAutoSwitch({
      minutes,
      lastSwitchAt: lastAutoSwitchAt,
      now: Date.now(),
      accounts: accounts as SwitchableAccount[],
      currentId: activeAccountId(),
      // 内存里的限流时刻：既决定"当前账号该不该提前切走"，也用来排除同样刚被限流的号。
      throttledAt: throttleAt,
      // 限流那条的冷却用"上次**真的换过号**"的时刻 —— 不能传 lastAutoSwitchAt（它在启动时
      // 就等于启动时刻，会让每次重启后的一段时间里"限流也不换号"）。见 lastSwitchedAt 的注释。
      lastSwitchedAt,
    })
    if (decision.action !== 'switch') return
    autoSwitching = true
    try {
      const target = readAccount(decision.nextId)
      if (!target) return
      // 切之前先探活（照 /accounts/switch 的既有做法）：切到一个已失效的号，
      // 下一个请求必然 AUTH 失败 —— 等于白折腾一轮全量重发。
      const probed = await probeOnce(target, {
        info: (message) => logger.info?.(message),
        warn: (message) => logger.warn?.(message),
      })
      if (probed && !probed.ok) {
        autoSwitchSkip.add(decision.nextId)
        // 计时要推进：否则每个请求都会重挑一次，探活成了高频动作。
        lastAutoSwitchAt = Date.now()
        logger.warn?.(
          `deepseek-web: 自动切号跳过 ${decision.nextId}（探活未通过：${probed.error ?? '未知原因'}）`,
        )
        return
      }
      // ⚠️ 切换前的账号 id 必须在 setActiveAccount **之前**取 —— 之后 activeAccountId() 已经是新的了
      const fromId = activeAccountId()
      if (!setActiveAccount(decision.nextId)) return
      lastAutoSwitchAt = Date.now()
      // 「真的换过号了」—— 只有这里与"手动切号"两处推进它，限流那条的冷却据此计算。
      lastSwitchedAt = Date.now()
      // 记下来给界面：换号那一轮会全量重发（体感是"任务突然变慢"），
      // 面板上摆出时间与两端，用户能把那次卡顿对上原因。
      const fromRecord = fromId ? readAccount(fromId) : undefined
      lastAutoSwitch = {
        at: lastAutoSwitchAt,
        from: fromRecord ? accountTitle(fromRecord, maskIdentifier) : '（未知）',
        to: accountTitle(target, maskIdentifier),
        reason: decision.reason,
      }
      logger.info?.(
        `deepseek-web: 已自动切换账号到 ${decision.nextId}（每 ${minutes} 分钟轮换` +
          (decision.reason === 'current-unusable'
            ? '；原账号不可用，提前切走'
            : decision.reason === 'recently-throttled'
              ? '；原账号刚被限流，提前切走'
              : '') +
          '）—— 换号会让投喂链断掉，下一轮会全量重发',
      )
    } catch (error: any) {
      lastAutoSwitchAt = Date.now()
      logger.warn?.(`deepseek-web: 自动切换账号失败（不影响本次请求）：${error?.message ?? error}`)
    } finally {
      autoSwitching = false
    }
  }

  /**
   * 「当前账号被限时，换个号还能不能接着干」—— 只决定失败该给长退避还是短退避。
   *
   * ⚠️ 只在用户**明确开了**自动换号（间隔 > 0）时才为真。默认关闭 ⇒ 保持原行为
   * （长退避 ⇒ 重试策略放弃），免得把一个没打算换号的用户悄悄换到别的账号上。
   *
   * `kind` 区分成因：封禁（'muted'）是"这个号暂时废了"，换了就走；限流（'throttled'）
   * 则要过窗口与冷却（见 `isThrottleSwitchAllowed`）—— 否则"每个号都被限流"时会一路换下去。
   */
  const canFailover = (kind?: 'muted' | 'throttled' | 'auth'): boolean => {
    const minutes = gate.settings().autoSwitchMinutes ?? DEFAULT_AUTO_SWITCH_MINUTES
    const now = Date.now()
    // 限流这条路径要过**窗口 + 冷却**（与 decideAutoSwitch 共用同一个判据）。
    // ⚠️ 这里拿 `now` 当"被限流的时刻"：调用方传 `'throttled'` 就等于告诉我们这次失败就是限流，
    //    而真正的记录（throttleAt）要等错误上报之后才写 —— 比这里晚。
    //    两边必须给出同一个答案，否则会出现最难查的那类故障：
    //    给了短退避让重试快点发生，而重发时其实并不换号 ⇒ 更快地撞同一个限流，比不给还糟。
    if (kind === 'throttled' && !isThrottleSwitchAllowed({ throttledAt: now, lastSwitchAt: lastSwitchedAt, now })) {
      return false
    }
    // 'auth'（凭证被服务端作废）**刻意不过**窗口 / 冷却：那是永久性坏状态，等多久都不会自己好，
    // 与"限流"（等一下会好）语义正好相反。死号越早换掉越好。
    const candidate = hasFailoverCandidate({
      minutes,
      switching: autoSwitching,
      accounts: listAccounts().filter((account) => !autoSwitchSkip.has(account.id)) as SwitchableAccount[],
      currentId: activeAccountId(),
      now,
      excludeIds: freshThrottledIds(throttleAt, now),
    })
    if (!candidate) {
      // 把"为什么没换"写清楚 —— 用户报的正是"这个报错不会自动切换账号"，
      // 而原因有三种（关着 / 正在切 / 没有别的可用号），日志里必须能分开，别让人再猜一次。
      logger.info?.(
        `deepseek-web: 本次 ${kind ?? '未知'} 失败无法换号（自动换号=${
          Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : '关闭'
        }${autoSwitching ? '，正在切换中' : ''}）—— 不重试，交给用户处理`,
      )
    }
    return candidate
  }

  // 上下文投喂方式（2026-09-14）：设置页保存的值优先于 cordis config，即时生效无需重启。
  // 默认 full（每轮重发全量）—— 与 0.1.61 及以前的行为完全一致。
  let contextMode = applyContextMode(
    readContextModeSetting() ?? (config.contextMode === 'chained' ? 'chained' : DEFAULT_CONTEXT_MODE),
  )
  logger.info?.(
    `deepseek-web: 上下文投喂=${contextMode}` +
      (contextMode === 'chained' ? '（只发增量 + parent 指向上一条回答）' : '（每轮重发全量 prompt）'),
  )

  const adapterConfig: AdapterConfig = {
    maxPromptChars: savedGate?.maxPromptChars ?? config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    maxRefImages: savedGate?.maxRefImages ?? config.maxRefImages ?? DEFAULT_MAX_REF_IMAGES,
    contextWindow: savedGate?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    idleTimeoutMs: config.idleTimeoutMs ?? 120_000,
    deleteWebSessions: config.deleteWebSessions !== false,
    // 会话复用：默认 20 轮共用一个网页端会话。0 = 关闭（回到每请求一个会话）
    sessionReuseTurns: config.sessionReuseTurns ?? DEFAULT_SESSION_REUSE_TURNS,
    autoContinue: config.autoContinue !== false,
    maxContinuations: config.maxContinuations ?? 2,
    // 防风控：默认串行 + 每次调用之间至少 3 秒（见 README「配置」）。
    // 取闸门的实际生效值（可能来自设置页保存的 gate.json）。
    allowConcurrent: gate.settings().allowConcurrent,
    minRequestIntervalMs: gate.settings().minRequestIntervalMs,
    // 同上：必须与 min 成对传，否则这里也退化成固定间隔
    maxRequestIntervalMs: gate.settings().maxRequestIntervalMs,
    logger,
  }

  // 清理参数在上面（闸门之前）已经算好并传进闸门了，这里直接用。
  const sessionCleaner = createSessionCleaner({
    // 链式投喂下**只手动清理**（0.6.11）：会话是链的载体，自动删就等于替用户清上下文。
    // 全量模式保持原来的自动清理（每轮都是根消息，会话只是壳）。
    manualOnly: contextMode === 'chained',
    policy: {
      mode: cleanupMode,
      delayMs: cleanupMode === 'immediate' ? 1_500 : (config.sessionCleanupDelayMs ?? DEFAULT_SESSION_CLEANUP.delayMs),
      batchSize: cleanupMode === 'immediate' ? 1 : (config.sessionCleanupBatchSize ?? DEFAULT_SESSION_CLEANUP.batchSize),
      ...(cleanupMode === 'immediate'
        ? {}
        : { batchRange: cleanupBatchRange, delayRange: cleanupDelayRange, gapRange: cleanupGapRange }),
    },
    logger,
  })

  // ── 自动重登（0.6.14）：把"浏览器登录捕获到的凭证"校验并落库 ────────────────
  //
  // 与 `/login/browser` 那条路走**同一套**序列（0.1.82 的顺序不能颠倒）：
  // 先 validate 拿身份 → 再 commit；校验通过才摘掉 unverified、才写 serverId（去重键）。
  // 抽成函数是因为现在有三个入口要用它：浏览器登录、单条重登、批量重登。
  async function commitBrowserAuth(
    auth: WebAuth,
    log: { info?: (m: string) => void; warn?: (m: string) => void },
  ): Promise<{ recordId?: string; display?: string; verified: boolean; error?: string }> {
    const check = await validateAuth(auth).catch(() => undefined)
    const verified = !!check?.ok
    const commitAuth = verified ? withVerifiedIdentity(auth, check?.user) : auth
    const commit = commitCapturedAuth(commitAuth)
    if (verified && check?.user && commit.recordId) {
      const record = listAccounts().find((item) => item.id === commit.recordId)
      const verifiedId =
        typeof (check.user as { id?: unknown }).id === 'string' ? String((check.user as { id?: unknown }).id) : ''
      updateAccount(commit.recordId, {
        user: { ...(record?.user ?? {}), ...check.user },
        ...(verifiedId ? { serverId: verifiedId } : {}),
      })
    }
    if (!verified) log.warn?.(`deepseek-web: 捕获到的凭证未通过校验（${check?.error ?? '未知'}）`)
    return {
      ...(commit.recordId ? { recordId: commit.recordId } : {}),
      ...(check?.user?.display ? { display: check.user.display } : {}),
      verified,
    }
  }

  /**
   * 用存的邮箱密码自动重登**一条**账号（0.6.14）。
   *
   * 返回结构化结果而不是抛异常；失败时把原因写清楚，交给调用方决定话术
   * （面板上"密码不对"和"被风控"要能区分开）。
   */
  async function autoReloginOne(
    targetId: string,
    log: { info?: (m: string) => void; warn?: (m: string) => void },
  ): Promise<{ ok: boolean; message: string; display?: string; verified?: boolean; error?: string }> {
    const target = readAccount(targetId)
    if (!target) return { ok: false, message: '账号不存在（可能已被移除）', error: 'missing-account' }
    const entry = credentialForDisplay(target.user?.display)
    if (!entry) {
      return {
        ok: false,
        message: `没有这条账号的邮箱密码凭证（${maskIdentifier(target.user?.display ?? target.id)}）——请用「登录新账号」补一次，或把密码加进凭证库`,
        error: 'no-credential',
      }
    }
    log.info?.(`deepseek-web: 自动重登 ${maskIdentifier(target.user?.display ?? target.id)} …`)
    // 重登：先登记目标，捕获成功后由 commitCapturedAuth 写回**这一条**（不新增、不切换）
    beginRelogin(targetId)
    try {
      const outcome = await browserLogin({
        credentials: entry,
        timeoutMs: 120_000,
        onProgress: (message) => log.info?.(`deepseek-web auto-relogin: ${message}`),
      })
      if (!outcome.ok || !outcome.auth) {
        endRelogin()
        return {
          ok: false,
          message: outcome.message,
          error: outcome.autoLoginError ?? outcome.reason ?? 'login-failed',
        }
      }
      const committed = await commitBrowserAuth(outcome.auth, log)
      return {
        ok: true,
        verified: committed.verified,
        ...(committed.display ? { display: maskIdentifier(committed.display) } : {}),
        message: committed.verified
          ? `已自动重登${committed.display ? `（${maskIdentifier(committed.display)}）` : ''}`
          : '已自动重登，但服务端校验未通过（可用「发送测试」再确认）',
      }
    } finally {
      endRelogin()
    }
  }

  // ── 到期前自动重登的定时检查（0.6.14，默认关闭）─────────────────────────────
  //
  // 每 10 分钟看一眼：设置里 autoRelogin 是否为 true（**每轮重读文件** ⇒ 面板一改就生效，
  // 不用重启）；是的话挑出"已失效或快到期"的账号，串行自动重登一遍。
  // ⚠️ 用 `.unref()`：这个定时器不该拖着进程不退出。
  // ⚠️ 串行 + 忙标记：并行开多个浏览器只会让风控看着更像机器。
  let autoRenewBusy = false
  const autoRenewTimer = setInterval(() => {
    void (async () => {
      if (autoRenewBusy) return
      if (readGateSettings()?.autoRelogin !== true) return
      const targets = selectReloginTargets({
        accounts: listAccounts().map((record) => ({
          id: record.id,
          ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
          lastVerifyError: record.lastVerifyError ?? null,
          ...(record.user ? { user: record.user } : {}),
        })),
        entries: readCredentialEntries(),
        onlyStale: true,
      })
      if (targets.length === 0) return
      autoRenewBusy = true
      logger.info?.(`deepseek-web: 自动重登开始（${targets.length} 个账号到期/将到期）`)
      try {
        for (const item of targets) {
          const auto = await autoReloginOne(item.accountId, logger)
          logger.info?.(`deepseek-web: 自动重登 ${item.display} → ${auto.ok ? '成功' : `失败（${auto.message}）`}`)
        }
      } finally {
        autoRenewBusy = false
      }
    })()
  }, 10 * 60_000)
  autoRenewTimer.unref?.()

  // ── 「欠删除的会话」落盘 + 启动补删（2026-09-14）────────────────────────────
  //
  // 复用槽与待删队列都只活在进程内存里，宿主一退出（尤其被强杀）就静默丢失，
  // 正在复用的那个会话于是**永远留在网页端**。实测：09-12 起启动 58 次 DSH，
  // 网页端侧栏就堆出同等量级、标题 = DSH 会话主题的对话（与 sessions 里的
  // session/title 一一对应）。
  //
  // 做法：webapi 每发生一次「进槽 / 进队列 / 确认删除」就通知这里，
  // 这里把"还欠一次删除"的会话按账号落盘；**确认删掉才销账**。
  // 于是强杀、删失败都能在下次启动补删（见 session-journal.ts）。
  const journalEnabled = adapterConfig.deleteWebSessions !== false && cleanupMode !== 'keep'
  /** 会话所属账号 —— 删除必须用它自己的凭证（拿 A 的凭证删 B 的会话会被服务端拒，见 F07）。 */
  const accountIdOfAuth = (auth?: WebAuth): string | undefined => {
    const token = auth?.token
    if (!token) return activeAccountId()
    return listAccounts().find((account) => account.token === token)?.id
  }
  setSessionLifecycleHook((event) => {
    // ⚠️ 销账（deleted / abandoned）必须放在 journalEnabled 判断**之前**：
    // keep 模式下 journalEnabled 为 false（不再记新账），但用户切成「不删」时
    // 要把**既有**的欠账摘掉 —— 否则下次启动在别的模式下补扫，又会删掉这些会话。
    if (event.kind === 'deleted' || event.kind === 'abandoned') {
      removeJournalEntry(event.sessionId)
      return
    }
    if (!journalEnabled) return
    const accountId = accountIdOfAuth(event.auth)
    if (!accountId) return
    upsertJournalEntry({
      accountId,
      sessionId: event.sessionId,
      state: event.kind === 'queued' ? 'queued' : 'slot',
    })
  })

  // 启动补删：上次退出遗留的（含被强杀的）会话，按账号排进清理器。
  if (journalEnabled) {
    try {
      runStartupSweep({
        ownPid: process.pid,
        accountExists: (id) => readAccount(id) !== undefined,
        deleteEnabled: adapterConfig.deleteWebSessions !== false,
        mode: cleanupMode,
        onSweep: (entry) => {
          const account = readAccount(entry.accountId)
          if (!account) throw new Error('账号已不在账号库里')
          sessionCleaner.schedule(account, entry.sessionId)
        },
        log: (message) => logger.info?.(message),
      })
    } catch (error: any) {
      logger.warn?.(`deepseek-web: 启动补删失败（不影响使用）：${error?.message ?? error}`)
    }
  }

  const getAuth = (): WebAuth | undefined => readAuth()

  // 台账与用量都按天滚动清理（分别保留 LEDGER_KEEP_DAYS / USAGE_KEEP_DAYS 天），启动时各做一次就够。
  try {
    const pruned = pruneLedger(LEDGER_KEEP_DAYS)
    if (pruned > 0) logger.info?.(`deepseek-web: 已清理 ${pruned} 个过期台账文件`)
  } catch {}
  try {
    const pruned = pruneUsage(USAGE_KEEP_DAYS)
    if (pruned > 0) logger.info?.(`deepseek-web: 已清理 ${pruned} 个过期用量文件`)
  } catch {}

  /**
   * 每次模型调用的结果上报（adapter 的 noteCall 钩子）。做三件事：
   *
   *  1. **把"账号级限制"学到账号上**。这个状态只能在生成请求被拒时学到
   *     （受限期间 `users/current` 依然 200），所以必须在这里记；成功一次且已过解除时间就清掉。
   *  2. 写本地台账，供设置页看请求密度与失败分类（保留 7 天）。
   *  3. 写本地用量，供设置页的「Token 统计」页看长期趋势（保留 90 天）。
   *
   * 全程 try/catch：旁路设施绝不能影响调用本身。
   */
  const recordCallOutcome = (info: {
    purpose: string
    ok: boolean
    ms: number
    code?: string
    message?: string
    mutedUntilMs?: number
    throttled?: boolean
    /** 发起调用那一刻的账号 id（由适配器在起飞前捕获）。 */
    accountId?: string
    /** 本次用到的模型 id。 */
    model?: string
    /** 本轮 token（与适配器上报给宿主的 `usage` 事件同源）。 */
    tokens?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; serverTotal?: boolean }
  }): void => {
    try {
      // 优先用**发起时**捕获的 id；只在拿不到时才回退到"此刻"的当前账号。
      const accountId = info.accountId ?? activeAccountId()
      // 限流（`throttled`）与封禁（`muted`）刻意分开：限流只记内存时刻，不落盘（见 throttleAt 的注释）。
      // ⚠️ 这一笔比 `canFailover('throttled')` **更晚**发生（那个在错误抛出的过程中就问了），
      // 所以宿主那边是拿"当下时刻"当限流时刻来判断的 —— 两边必须同答，见 canFailover 的注释。
      if (!info.ok && info.throttled && accountId) throttleAt.set(accountId, Date.now())
      const muted = Number.isFinite(info.mutedUntilMs)
      if (!info.ok && muted && accountId) {
        updateAccount(accountId, {
          limit: { untilMs: Number(info.mutedUntilMs), observedAt: new Date().toISOString() },
        })
        logger.warn?.(
          `deepseek-web: 账号被临时限制，已记录解除时间 ${new Date(Number(info.mutedUntilMs)).toLocaleString()}`,
        )
      }
      // 0.1.61：AUTH 失败（服务端判 token 无效 / HTTP 401·403）立刻回写账号状态 ——
      // 之前 `lastVerifyError` 只由 30 分钟一次的探活写入，刚切到死号时界面完全静默：
      // 用户只看到一条报错，不知道是哪个账号的登录态死了（实测 2026-09-14 切号后的空窗）。
      // 回写之后账号库会立刻出现红标「需要重新登录」。
      if (!info.ok && info.code === 'AUTH' && accountId) {
        // F2（0.2.0）：AUTH 不再一票制标记 —— 0.1.80 的请求前拦截只看这个标记，
        // 一次端点级误判就会把健康账号锁死（实测 2026-09-22：94ms 被拒，而同 token
        // 2 秒前刚成功跑完一轮）。先用**同一份凭证**做只读探活复核：
        //   复核也失败 ⇒ 确认失效，照旧标记；
        //   复核通过 ⇒ 不标记（账号保持可用，本轮仍按失败计、用户重发即可），日志留痕；
        //   复核自身失败（网络）⇒ 无法定论，不标记 —— 误标（功能锁死）代价远大于漏标（白跑一轮）。
        const record = listAccounts().find((item) => item.id === accountId)
        if (record) {
          validateAuth(record, AbortSignal.timeout(20_000))
            .then((verdict) => {
              if (verdict.ok) {
                // 复核通过 ⇒ 顺手清掉上一次的失败标记：端点级误判之后，如果更早之前
                // 被标过失效，这次复核证明账号活着，应当解锁（与 probeOnce 成功清标记同一语义）。
                updateAccount(accountId, { lastVerifyError: undefined })
                logger.info?.(
                  `deepseek-web: 账号 ${accountId} 请求被判 AUTH，但只读探活通过 —— 按端点级误判处理，不标记失效（本轮仍按失败计，重发即可）`,
                )
                return
              }
              updateAccount(accountId, {
                lastVerifyError: {
                  at: new Date().toISOString(),
                  message: String(info.message ?? '登录态无效，请重新登录'),
                },
              })
              logger.warn?.(
                `deepseek-web: 账号 ${accountId} AUTH 复核确认失效（${verdict.error ?? '探活未通过'}），已标记为「需要重新登录」`,
              )
            })
            .catch((error) => {
              logger.warn?.(
                `deepseek-web: 账号 ${accountId} AUTH 复核未完成（${String((error as Error)?.message ?? error)}），暂不标记`,
              )
            })
        }
      }
      if (info.ok && accountId) {
        const record = listAccounts().find((item) => item.id === accountId)
        // 限制时间已过 + 这次生成成功 → 确实解除了，清掉标记（不靠猜）
        if (record?.limit && Date.now() >= record.limit.untilMs) {
          updateAccount(accountId, { limit: undefined })
          logger.info?.('deepseek-web: 账号级限制已解除，已清除本地的限制标记')
        }
      }
      writeLedgerEntry({
        at: Date.now(),
        ...(accountId ? { accountId } : {}),
        purpose: info.purpose,
        ok: info.ok,
        ms: info.ms,
        ...(info.code ? { code: info.code } : {}),
        ...(muted ? { muted: true } : {}),
        ...(info.throttled ? { throttled: true } : {}),
      })
      // 用量比台账宽一档：**每次调用都记**（含失败与"没拿到 token"的调用），
      // 这样界面上的「调用次数」才是完整的；token 那两栏在缺数据时记 0。
      // 记录怎么拼交给 usage.ts 的纯函数（那几行没人守，抽出来才测得到）。
      writeUsageEntry(usageEntryFrom(info, Date.now()))
    } catch {}
  }

  // 登录态主动探活：启动后 20 秒探一次，之后每 probeIntervalMs 一次（0 = 关闭）。
  const probeIntervalMs = config.probeIntervalMs ?? 30 * 60_000
  ctx.effect(() =>
    startProbeLoop({
      intervalMs: probeIntervalMs,
      getAuth: () => readAuth(),
      logger,
    }),
  )
  logger.info?.(
    probeIntervalMs > 0
      ? `deepseek-web: 登录态探活已开启，每 ${Math.round(probeIntervalMs / 60_000)} 分钟一次（只读、零额度）`
      : 'deepseek-web: 登录态探活已关闭（probeIntervalMs=0）',
  )
  // 附件服务（ctx.attachments）：图片输入所需。用 ctx.get 取（可选依赖，缺省则图片降级为文本）
  const adapter = createAdapter({
    getAuth,
    noteCall: recordCallOutcome,
    currentAccountId: activeAccountId,
    gate,
    // 自动轮换账号的检查点：adapter 在闸门放行之前 await 一下（见 maybeAutoSwitch 的注释）。
    maybeAutoSwitch,
    // 账号被限时"还能不能换号接着干" —— 决定那次失败给长退避还是短退避（见 canFailover）。
    canFailover,
    sessionCleaner,
    config: adapterConfig,
    readImage: async (ref: any, signal?: AbortSignal) => {
      const attachments = ctx.get?.('attachments')
      if (!attachments || typeof attachments.readImage !== 'function') {
        throw new Error('attachment service unavailable (ctx.attachments)')
      }
      const stored = await attachments.readImage(ref, signal)
      return {
        data: stored.data,
        ...(stored.ref?.mediaType ? { mediaType: String(stored.ref.mediaType) } : {}),
        ...(stored.ref?.name ? { name: String(stored.ref.name) } : {}),
      }
    },
  })

  // 1) LLM 适配器：registerAdapter 内部走 ctx.effect（traceable 代理把副作用绑到本 fiber）
  ctx.llm.registerAdapter([PROVIDER], adapter)
  logger.info?.(`deepseek-web: 已注册 provider "${PROVIDER}"（模型：${MODEL_SPECS.map((spec) => spec.id).join(', ')}）`)

  // 2) host API
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req: any, res: any) => {
          const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
          const route = url.pathname.slice(API_PREFIX.length) || '/'

          try {
            // Язык интерфейса: панель хранит выбор в localStorage, но имена моделей
            // и имя провайдера отдаёт **хост** в штатный селектор DSH. Без этого
            // запроса названия моделей там остались бы китайскими (0.7.2).
            if (req.method === 'POST' && route === '/ui') {
              const body = await readJsonBody(req)
              const applied = setHostLanguage(body?.language)
              logger.info?.(`deepseek-web: язык интерфейса переключён на "${applied}"`)
              sendJson(res, 200, { ok: true, language: applied })
              return
            }

            // 请求节流设置（设置页的开关与滑块）——读写都即时生效，并持久化到 gate.json
            if (req.method === 'GET' && route === '/gate') {
              sendJson(res, 200, {
                ...gate.settings(),
                presets: INTERVAL_PRESETS.map(([lo, hi]) => ({ min: lo, max: hi })),
                maxIntervalMs: MAX_INTERVAL_MS,
                defaultMinIntervalMs: DEFAULT_MIN_REQUEST_INTERVAL_MS,
                defaultMaxIntervalMs: DEFAULT_MAX_REQUEST_INTERVAL_MS,
                maxPromptCharsBounds: MAX_PROMPT_CHARS_BOUNDS,
                maxPromptCharsDefault: DEFAULT_MAX_PROMPT_CHARS,
                maxRefImagesBounds: MAX_REF_IMAGES_BOUNDS,
                maxRefImagesDefault: DEFAULT_MAX_REF_IMAGES,
                // 上下文窗口用「档位数组」而不是 bounds：面板是索引滑块（32K→1M 是 32 倍跨度，
                // 线性拖动前四分之三的行程都挤在低档，手感很差）。档位同样由后端给。
                contextWindowBounds: CONTEXT_WINDOW_BOUNDS,
                contextWindowDefault: DEFAULT_CONTEXT_WINDOW,
                contextWindowOptions: CONTEXT_WINDOW_OPTIONS,
                autoSwitchBounds: AUTO_SWITCH_BOUNDS,
                autoSwitchDefault: DEFAULT_AUTO_SWITCH_MINUTES,
                // 最近一次自动换号（没换过就是 null）。界面靠它显示"上次换号：X（A → B）"——
                // 换号那轮会全量重发，用户看到变慢时能对上原因。
                lastAutoSwitch: lastAutoSwitch ?? null,
                cleanup: sessionCleaner.policy(),
                // 界面的滑块边界/默认值由后端给 —— 免得两边各写一套数字、改了一边忘另一边
                cleanupBounds: {
                  batch: CLEANUP_BATCH_BOUNDS,
                  delayMs: CLEANUP_DELAY_BOUNDS_MS,
                  gapMs: CLEANUP_GAP_BOUNDS_MS,
                },
                cleanupDefaults: {
                  batch: DEFAULT_CLEANUP_BATCH,
                  delayMs: DEFAULT_CLEANUP_DELAY_MS,
                  gapMs: DEFAULT_CLEANUP_GAP_MS,
                },
              })
              return
            }
            if (req.method === 'POST' && route === '/gate') {
              const body = await readJsonBody(req)
              if (!body || typeof body !== 'object') {
                sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
                return
              }
              const patch: Partial<GateSettings> = {}
              if (typeof body.allowConcurrent === 'boolean') patch.allowConcurrent = body.allowConcurrent
              for (const field of ['minRequestIntervalMs', 'maxRequestIntervalMs']) {
                if (body[field] === undefined) continue
                const ms = Number(body[field])
                if (!Number.isFinite(ms)) {
                  sendJson(res, 400, { ok: false, error: `${field} 必须是数字` })
                  return
                }
                patch[field] = ms
              }
              if (body.maxPromptChars !== undefined) {
                const chars = Number(body.maxPromptChars)
                if (!Number.isFinite(chars)) {
                  sendJson(res, 400, { ok: false, error: 'maxPromptChars 必须是数字' })
                  return
                }
                const clamped = clampMaxPromptChars(chars)
                if (clamped !== chars) {
                  // 越界不静默：直接告诉用户被夹到了哪里，否则"拖到底没反应"很难查
                  logger.warn?.(`deepseek-web: maxPromptChars ${chars} 越界，夹到 ${clamped}`)
                }
                patch.maxPromptChars = clamped
              }
              if (body.sessionCleanup !== undefined) {
                if (!['immediate', 'deferred', 'keep'].includes(body.sessionCleanup)) {
                  sendJson(res, 400, { ok: false, error: 'sessionCleanup 只能是 immediate / deferred / keep' })
                  return
                }
                patch.sessionCleanup = body.sessionCleanup
              }
              // 会话清理的三个区间（上下限）。非法输入直接报错，不静默吞掉 ——
              // 用户拖了滑块却"没生效"，是最难查的一类问题。
              for (const [field, bounds] of [
                ['cleanupBatch', CLEANUP_BATCH_BOUNDS],
                ['cleanupDelayMs', CLEANUP_DELAY_BOUNDS_MS],
                ['cleanupGapMs', CLEANUP_GAP_BOUNDS_MS],
              ] as const) {
                if (body[field] === undefined) continue
                const range = normalizeCleanupRange(body[field], bounds)
                if (!range) {
                  sendJson(res, 400, { ok: false, error: `${field} 需要 { min, max } 两个数字` })
                  return
                }
                patch[field] = range
              }
              // 0.1.82：图片上限也是「界面 → 路由 → 落盘」的一段，此前只接了显示层 ——
              // 前端确实 POST 这个字段，而白名单里没有它 ⇒ patch 为空 ⇒ 直接 400「没有可更新的字段」，
              // 滑块拖完弹回默认值（0.1.77 起一直如此，测试断的是字符串出现与否，守不住接线）。
              if (body.maxRefImages !== undefined) {
                const count = Number(body.maxRefImages)
                if (!Number.isFinite(count)) {
                  sendJson(res, 400, { ok: false, error: 'maxRefImages 必须是数字' })
                  return
                }
                patch.maxRefImages = clampMaxRefImages(count)
              }
              if (body.contextWindow !== undefined) {
                const window = Number(body.contextWindow)
                if (!Number.isFinite(window)) {
                  sendJson(res, 400, { ok: false, error: 'contextWindow 必须是数字' })
                  return
                }
                patch.contextWindow = clampContextWindow(window)
              }
              if (body.autoSwitchMinutes !== undefined) {
                const minutes = Number(body.autoSwitchMinutes)
                if (!Number.isFinite(minutes)) {
                  sendJson(res, 400, { ok: false, error: 'autoSwitchMinutes 必须是数字' })
                  return
                }
                // 0 = 关闭（默认）。宿主在每次请求前现读 gate.settings()，所以改完即时生效。
                patch.autoSwitchMinutes = clampAutoSwitchMinutes(minutes)
              }
              if (body.serialToolCalls !== undefined) {
                // 只收真正的布尔值：`'false'` / 0 / 1 这类一律拒绝，
                // 免得"看着关了实际开着"（字符串 'false' 是真值，最坑）。
                if (typeof body.serialToolCalls !== 'boolean') {
                  sendJson(res, 400, { ok: false, error: 'serialToolCalls 必须是布尔值' })
                  return
                }
                patch.serialToolCalls = body.serialToolCalls
              }
              // 重开链是否换新会话（0.6.22）：只收布尔值，缺省关闭。
              if (body.freshSessionOnRestart !== undefined) {
                if (typeof body.freshSessionOnRestart !== 'boolean') {
                  sendJson(res, 400, { ok: false, error: 'freshSessionOnRestart 必须是布尔值' })
                  return
                }
                patch.freshSessionOnRestart = body.freshSessionOnRestart
              }
              // 到期前自动重登（0.6.14）：只收布尔值，缺省关闭。
              // 定时检查每轮都重读设置文件 ⇒ 存下去就即时生效，不用重启。
              if (body.autoRelogin !== undefined) {
                if (typeof body.autoRelogin !== 'boolean') {
                  sendJson(res, 400, { ok: false, error: 'autoRelogin 必须是布尔值' })
                  return
                }
                patch.autoRelogin = body.autoRelogin
              }
              if (Object.keys(patch).length === 0) {
                sendJson(res, 400, { ok: false, error: '没有可更新的字段' })
                return
              }
              const applied = gate.configure(patch)
              // prompt 上限是 adapter 每次调用现读的 → 改这里即时生效，不必重启
              if (applied.maxPromptChars !== undefined) adapterConfig.maxPromptChars = applied.maxPromptChars
              // 图片上限同样是 adapter 每轮现读的 ⇒ 必须一起同步，否则保存成功但要等重启
              if (applied.maxRefImages !== undefined) adapterConfig.maxRefImages = applied.maxRefImages
              // 上下文窗口走同一条路：resolvedModelInfo 每次请求都会重算 ⇒ 改完立刻生效
              if (applied.contextWindow !== undefined) adapterConfig.contextWindow = applied.contextWindow
              // 工具调用方式同样每轮现读。⚠️ 它改的是**协议文本**，而协议文本进 head，
              // head 又是 decideFeed 的判据之一 ⇒ 切换会让投喂链断一次（下一轮全量重发 + 新会话），
              // 之后稳定。界面上写了这句。
              if (applied.serialToolCalls !== undefined) adapterConfig.serialToolCalls = applied.serialToolCalls
              // 重开链是否换新会话：context-feed 每轮现读 ⇒ 改完即时生效（不用重启）。
              if (applied.freshSessionOnRestart !== undefined) {
                applyFreshSessionOnRestart(applied.freshSessionOnRestart)
              }
              // 清理策略由 cleaner 执行 → 同步生效
              if (patch.sessionCleanup) sessionCleaner.configure({ mode: patch.sessionCleanup })
              // 三个区间即时作用到清理器（它会用新区间重新随机取值）
              const rangePatch: Record<string, { min: number; max: number }> = {}
              if (patch.cleanupBatch) rangePatch.batchRange = patch.cleanupBatch
              if (patch.cleanupDelayMs) rangePatch.delayRange = patch.cleanupDelayMs
              if (patch.cleanupGapMs) rangePatch.gapRange = patch.cleanupGapMs
              if (Object.keys(rangePatch).length > 0) sessionCleaner.configure(rangePatch)
              try {
                writeGateSettings(applied)
              } catch (error: any) {
                // 落盘失败不影响本次生效，但要说清楚（重启后会回到旧值）
                logger.warn?.(`deepseek-web: 节流设置落盘失败：${error?.message ?? error}`)
                sendJson(res, 200, { ok: true, ...applied, persisted: false, warning: '已即时生效，但写入 gate.json 失败，重启后会回到旧值' })
                return
              }
              // ⚠️ `cleanup` 必须一起返回：前端保存后立刻重画界面，读不到就回落成默认的
              // 「延迟」档（GET /status 里是有的，两边形状必须一致）。
              sendJson(res, 200, { ok: true, ...applied, persisted: true, cleanup: sessionCleaner.policy() })
              return
            }
            // 本地调用台账：请求密度 + 失败分类（用来判断节流到底有没有效）
            if (req.method === 'GET' && route === '/ledger') {
              const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 24))
              sendJson(res, 200, summarizeLedger(hours))
              return
            }
            // Token 统计（「Token 统计」页）。与 /ledger 是**两份数据**：这里保留 90 天、只关心用量，
            // 台账只有 7 天且在管请求密度与失败分类。
            // ⚠️ `Number(null)` 是 0，而 0 在 clampUsageDays 里意味着"全部" —— 漏了下面的判空，
            //    不带参数访问会静默变成全量查询（数据一多就是慢查询）。
            if (req.method === 'GET' && route === '/usage') {
              const raw = url.searchParams.get('days')
              const days = raw === null || raw === '' ? 30 : raw
              sendJson(res, 200, {
                ...summarizeUsage(days),
                keepDays: USAGE_KEEP_DAYS,
                dir: usageDir(),
                hasData: usageExists(),
              })
              return
            }
            // 检查更新：读自身版本 → 比对 GitHub Releases latest。
            // 走当前传输层；8 秒超时；失败如实返回原因（国内连不上 GitHub 很正常）。
            if (req.method === 'POST' && route === '/update-check') {
              const result = await checkForUpdate(pluginVersion(), currentFetch)
              sendJson(res, 200, { ...result, repo: RELEASE_REPO })
              return
            }

            // ── 账号库：多账号并存 + 一键切换 ─────────────────────────────
            // ⚠️ 返回给界面的**只有元信息**（掩码账号、时间、限制状态等），**永不回传凭证**：
            // 设置页跑在渲染层，把它能触及的敏感面收窄没有坏处。
            if (req.method === 'GET' && route === '/accounts') {
              const activeId = activeAccountId()
              const list = listAccounts()
              const groups = readGroups()
              // ⚠️ 先把记录加工成「可直接渲染的视图」，**再**拿去分区。
              // partitionByGroup 只按 id / groupId 归组，但它返回的 accounts 会**原样**
              // 交给客户端渲染 —— 喂原始记录的话，title / display / isActive 这些
              // 「响应加工字段」就不在数组里：标题退化成 acc_xxxxxxx、显示名与「当前」
              // 徽章一起消失（0.1.71 的真实回归，由端到端用例 + 产物断言守）。
              const accounts = list.map((record) => ({
                id: record.id,
                title: accountTitle(record, maskIdentifier),
                display: record.user?.display ? maskIdentifier(record.user.display) : '',
                label: record.label ?? '',
                groupId: record.groupId ?? '',
                unverified: record.unverified === true,
                // 「邮箱 / 手机号」标志（0.6.13）。判据是纯函数（`identifierKindOf`），
                // 老记录只有脱敏 display 也能判；判不出来就是 unknown，界面不显示。
                identifierKind: identifierKindOf(record.user),
                capturedAt: record.capturedAt,
                lastVerifiedAt: record.lastVerifiedAt ?? null,
                lastVerifyError: record.lastVerifyError ?? null,
                // 网络类的校验失败单传一个字段：界面据此显示"未能校验"，
                // **不能**和 lastVerifyError 混着看（那会让"需要重新登录"变成误报）。
                lastCheckError: record.lastCheckError ?? null,
                limit: record.limit ?? null,
                // cookie 的过期构成（捕获时记下）。老记录 / 手动粘 token 的账号是空数组，
                // 界面据此区分"没记录"和"记录到全是会话级"—— 这两种含义完全不同。
                cookieMeta: record.cookieMeta ?? [],
                isActive: record.id === activeId,
              }))
              sendJson(res, 200, {
                activeId: activeId ?? null,
                // 分组定义单独存 groups.json；账号记录里只有 groupId 指针。
                // ⚠️ 客户端的重建签名按 `{activeId, accounts, groups}` 整包算 ——
                // 顶层字段不列进签名，新建/改名组后面板就不会自己刷新（0.1.63/0.1.67 那类坑）。
                groups,
                // 「按组分区」在宿主侧算好：客户端只负责画。
                // 这样分区规则（当前账号所在组置顶 → 其余按 order → 未分组垫底）只有一份实现，
                // 也就只有一处要测 —— 放进客户端会因为 node 依赖而不得不复制一份。
                sections: partitionByGroup(accounts, groups, activeId),
                // 顶层 `accounts` 必须继续返回：客户端有"没有 sections 就平铺"的兜底路径，
                // 而且重建签名是 `{activeId, accounts, groups, sections}` 整包算的。
                accounts,
                footprint: accountsFootprint(),
              })
              return
            }
            if (req.method === 'POST' && route === '/accounts/switch') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              endAddAccount()
              endRelogin()
              // 0.1.61：切号前先对目标账号做一次零额度探活（只读 users/current）。
              // 死号当场拦下 —— 否则用户切过去、发消息、看到 AUTH 才知道，白折腾一轮
              // （实测 2026-09-14：切到一个一天多没用过的号，凭证早已过期）。
              const target = id ? readAccount(id) : undefined
              if (!target) {
                sendJson(res, 404, { ok: false, error: '账号不存在（可能已被移除）' })
                return
              }
              const probed = await probeOnce(
                target,
                {
                  info: (message) => logger.info?.(message),
                  warn: (message) => logger.warn?.(message),
                },
                // 交互式点击：10 秒而不是 20 秒。超了也只当"没能校验"，不拦（见下面的分类）。
                { timeoutMs: SWITCH_PROBE_TIMEOUT_MS },
              )
              // 🔴 探活结论**按失败类型分别处置**（2026-09-30）：只有授权失效才拦下来；
              // 网络类失败（超时/断网）放行 —— 凭证未必坏，把用户挡在门外什么也解决不了。
              const gate = switchGateFromProbe(probed)
              if (gate === 'relogin') {
                sendJson(res, 200, {
                  ok: false,
                  needsRelogin: true,
                  error: `这个号的登录态已失效（${probed?.error ?? '未知原因'}），需要重新登录一次才能切换`,
                })
                return
              }
              const warning =
                gate === 'warn'
                  ? `已切换，但没能校验这个号（网络问题：${probed?.error ?? '未知原因'}）—— 登录态未必失效，网络恢复后可再点「校验全部」确认`
                  : undefined
              if (!setActiveAccount(id)) {
                sendJson(res, 404, { ok: false, error: '账号不存在（可能已被移除）' })
                return
              }
              logger.info?.(`deepseek-web: 当前账号已切换为 ${id}`)
              // 手动切号也要重置自动轮换的计时 —— 否则用户刚切完，1 分钟后又被自动切走
              lastAutoSwitchAt = Date.now()
              // 手动切号也算"真的换过号" ⇒ 限流冷却开始计（刚切到新号又被限流时，别立刻再换）
              lastSwitchedAt = Date.now()
              sendJson(res, 200, { ok: true, activeId: id, ...(warning ? { warning } : {}) })
              return
            }
            if (req.method === 'POST' && route === '/accounts/rename') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              const label = String(body?.label ?? '').slice(0, 40)
              if (!updateAccount(id, { label })) {
                sendJson(res, 404, { ok: false, error: '账号不存在' })
                return
              }
              sendJson(res, 200, { ok: true, id, label })
              return
            }
            if (req.method === 'POST' && route === '/accounts/remove') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              if (!removeAccount(id)) {
                sendJson(res, 404, { ok: false, error: '账号不存在' })
                return
              }
              logger.info?.(`deepseek-web: 已从账号库移除 ${id}`)
              sendJson(res, 200, { ok: true, removed: id, activeId: activeAccountId() ?? null })
              return
            }
            // ── 分组：组定义存 groups.json，账号记录里只留 groupId 指针 ──
            // 组**只影响显示**（分区 / 折叠），不参与切号、会话复用与清理 —— 让调度逻辑保持可预期。
            if (req.method === 'POST' && route === '/accounts/group/create') {
              const body = await readJsonBody(req)
              const result = createGroup(readGroups(), body?.name)
              if (result.error || !result.group) {
                sendJson(res, 400, { ok: false, error: result.error ?? '创建失败' })
                return
              }
              writeGroups(result.list)
              sendJson(res, 200, { ok: true, group: result.group, groups: result.list })
              return
            }
            if (req.method === 'POST' && route === '/accounts/group/rename') {
              const body = await readJsonBody(req)
              const result = renameGroup(readGroups(), String(body?.id ?? ''), body?.name)
              if (result.error) {
                sendJson(res, 400, { ok: false, error: result.error })
                return
              }
              writeGroups(result.list)
              sendJson(res, 200, { ok: true, groups: result.list })
              return
            }
            if (req.method === 'POST' && route === '/accounts/group/delete') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              const next = removeGroup(readGroups(), id)
              writeGroups(next)
              // 组内账号的 groupId 会变成悬挂指针 ⇒ 界面上按「未分组」显示。
              // 所以这里**故意不去改账号文件**：删一个组不该逐个重写凭证文件。
              logger.info?.(`deepseek-web: 已删除分组 ${id}（组内账号回到「未分组」，账号本身未动）`)
              sendJson(res, 200, { ok: true, groups: next })
              return
            }
            if (req.method === 'POST' && route === '/accounts/group/assign') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              const groupId = String(body?.groupId ?? '')
              // 只接受已知组 id（空串 = 移出组）；传了不存在的组就当场拒绝，
              // 免得界面看起来"归组成功"而列表里并没有它
              if (groupId && !readGroups().some((group) => group.id === groupId)) {
                sendJson(res, 400, { ok: false, error: '分组不存在' })
                return
              }
              if (!updateAccount(id, { groupId })) {
                sendJson(res, 404, { ok: false, error: '账号不存在' })
                return
              }
              sendJson(res, 200, { ok: true, id, groupId })
              return
            }
            /**
             * 手动刷新账号状态：对库里每个账号做一次**只读探活**（`users/current`，零额度），
             * 顺带把补上的显示名、清掉的失败标记写回记录（那是 probeOnce 自己干的）。
             *
             * 为什么需要它：自动探活 30 分钟才一次，而"我刚在浏览器里动过这个号，它现在到底还行不行"
             * 是随时会冒出来的问题 —— 以前只能等，或者切过去试（那要发一次生成请求，烧额度）。
             * 串行 + 互斥：单次探活虽轻，一口气并发 7 个也会像脚本；狂点按钮更不该叠起来打。
             */
            if (req.method === 'POST' && route === '/accounts/refresh') {
              if (accountsRefreshInFlight) {
                sendJson(res, 200, { ok: false, error: '正在刷新，请稍候' })
                return
              }
              accountsRefreshInFlight = true
              try {
                let passed = 0
                let failed = 0
                // 失败还要分类计数：界面要能说清"几个真要重登、几个只是网络没通"
                // （0.6.6，2026-09-29：以前统称"需要重登"，一次休眠就把整库说成失效）。
                let authFailed = 0
                let transportFailed = 0
                for (const account of listAccounts()) {
                  const outcome = await probeOnce(account, {
                    info: (message) => logger.info?.(message),
                    warn: (message) => logger.warn?.(message),
                  })
                  if (outcome?.ok) passed += 1
                  else if (outcome) {
                    failed += 1
                    if (outcome.errorKind === 'auth') authFailed += 1
                    else transportFailed += 1
                  }
                }
                logger.info?.(
                  `deepseek-web: 手动刷新账号状态完成 —— 通过 ${passed}、授权失效 ${authFailed}、` +
                    `网络未能校验 ${transportFailed}`,
                )
                sendJson(res, 200, {
                  ok: true,
                  checked: passed + failed,
                  passed,
                  failed,
                  authFailed,
                  transportFailed,
                })
              } finally {
                accountsRefreshInFlight = false
              }
              return
            }
            // 回退路径：宿主自己写到插件目录，只回传**路径**（明文 token 不进 HTTP）。
            if (req.method === 'POST' && route === '/accounts/export') {
              try {
                const result = exportAccountsToFile()
                sendJson(res, 200, { ok: true, ...result, warning: '导出文件含可完整登录的凭证，请妥善保管、勿分享' })
              } catch (error: any) {
                sendJson(res, 500, { ok: false, error: `导出失败：${error?.message ?? error}` })
              }
              return
            }
            // 首选路径：界面弹系统「另存为」让用户自己选位置与文件名，然后把内容写进去。
            //
            // ⚠️ 这一条会把**明文凭证**交给渲染进程（本机回环 + DSH 同源守卫）。
            // 为什么躲不开：要"让用户选保存位置"，只有渲染进程能弹系统对话框；
            // 而写盘必须由拿到那份数据的一方做。反过来"宿主只收一个路径"做不到 ——
            // File System Access 只给 FileSystemFileHandle、不暴露路径，宿主无从代写。
            // 权衡后接受：能读到这个响应的，本来就以本机同用户进程为主，
            // 而插件宿主自身有完整 fs 权限、直接读账号文件更省事，边际风险接近于零。
            // 不接受的场景也有出口：/accounts/export（上面那条）始终保留，凭证不出宿主。
            if (req.method === 'POST' && route === '/accounts/export-json') {
              try {
                sendJson(res, 200, { ok: true, ...exportAccounts() })
              } catch (error: any) {
                sendJson(res, 500, { ok: false, error: `导出失败：${error?.message ?? error}` })
              }
              return
            }
            if (req.method === 'POST' && route === '/accounts/import') {
              const body = await readJsonBody(req, IMPORT_FILE_LIMIT_BYTES)
              if (!body || typeof body !== 'object') {
                sendJson(res, 400, { ok: false, error: '请提供备份内容（payload）或文件路径' })
                return
              }
              let payload: unknown = (body as any).payload
              const path = typeof (body as any).path === 'string' ? (body as any).path.trim() : ''
              if (payload === undefined && path) {
                // 路径导入：**由宿主自己读**，明文凭证不进 HTTP（见 client 侧 readImportSource 的注释）。
                // ⚠️ 但路径来自渲染进程，不能因为"前端有文件选择框"就当它可信（审计 F16）：
                // 只接受**普通文件**（挡掉目录 / FIFO / 设备这类会阻塞或异常的东西），并限定大小。
                // 更进一步的做法是"宿主批准的一次性句柄/令牌"，需要新的宿主 API，本版没做。
                try {
                  const info = statSync(path)
                  if (!info.isFile()) throw new Error('不是普通文件')
                  if (info.size > IMPORT_FILE_LIMIT_BYTES) {
                    throw new Error(`文件 ${Math.ceil(info.size / 1024)} KiB，超过上限 ${Math.floor(IMPORT_FILE_LIMIT_BYTES / 1024 / 1024)} MiB`)
                  }
                  payload = JSON.parse(readFileSync(path, 'utf8'))
                } catch (error: any) {
                  sendJson(res, 400, { ok: false, error: `读取导入文件失败：${error?.message ?? error}` })
                  return
                }
              }
              if (payload === undefined || payload === null) {
                sendJson(res, 400, { ok: false, error: '请提供要导入的内容或文件路径' })
                return
              }
              try {
                const result = importAccounts(payload)
                logger.info?.(`deepseek-web: 账号库导入完成（新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}）`)
                sendJson(res, 200, { ok: true, ...result, activeId: activeAccountId() ?? null })
              } catch (error: any) {
                // 内容不合格（形状/数量/类型）算客户端错误，别报 500 让人以为是插件坏了
                if (error instanceof TypeError || error instanceof RangeError) {
                  sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
                  return
                }
                throw error
              }
              return
            }

            // 传输层：网页端请求从哪个网络栈出去（Chromium / Node）。见 transport.ts。
            if (req.method === 'GET' && route === '/transport') {
              sendJson(res, 200, { ...transportState, hint: TRANSPORT_HINT, settingsPath: transportSettingsPath() })
              return
            }
            if (req.method === 'POST' && route === '/transport') {
              const body = await readJsonBody(req)
              const wanted = body?.transport
              if (wanted !== 'chromium' && wanted !== 'node') {
                sendJson(res, 400, { ok: false, error: "transport 必须是 'chromium' 或 'node'" })
                return
              }
              // 先即时生效（无需重启），再落盘；落盘失败如实回报，不假装成功
              transportState = applyTransport(wanted)
              let persisted = true
              try {
                writeTransportSetting(wanted)
              } catch {
                persisted = false
              }
              logger.info?.(
                `deepseek-web: 传输层切换为 ${transportState.effective}` +
                  (transportState.degraded
                    ? '（要求 Chrome 但本环境不可用，已降级 Node）'
                    : transportState.viaBrowserProxy
                      ? '（通过系统 Edge/Chrome 进程代理）'
                      : ''),
              )
              sendJson(res, 200, {
                ok: true,
                ...transportState,
                persisted,
                hint: TRANSPORT_HINT,
                settingsPath: transportSettingsPath(),
              })
              return
            }

            // 上下文投喂方式：每轮重发全量 prompt，还是只发增量 + parent 链（见 context-feed.ts）。
            if (req.method === 'GET' && route === '/context-mode') {
              sendJson(res, 200, {
                mode: contextMode,
                hint: CONTEXT_MODE_HINT,
                settingsPath: contextModeSettingsPath(),
                // 只在链式模式下回链状态（0.1.63）：全量模式下链已经作废，
                // 回它会让界面出现「每轮全量 + 链式投喂正在跑」这种自相矛盾的组合。
                chain: contextMode === 'chained' ? (contextChainInfo() ?? null) : null,
              })
              return
            }
            if (req.method === 'POST' && route === '/context-mode') {
              const body = await readJsonBody(req)
              const wanted = body?.mode
              if (wanted !== 'full' && wanted !== 'chained') {
                sendJson(res, 400, { ok: false, error: "mode 必须是 'full' 或 'chained'" })
                return
              }
              // 同 /transport：先即时生效（无需重启），再落盘；落盘失败如实回报，不假装成功
              contextMode = applyContextMode(wanted)
              // 切到全量 ⇒ 链立刻作废（0.1.63）：全量下每轮都是根消息，链的父消息早就不是最新的了，
              // 留着它既会让界面自相矛盾，也会在以后切回链式时从一个过期节点续链、让上下文错位。
              if (contextMode === 'full') resetContextChain()
              let persisted = true
              try {
                writeContextModeSetting(wanted)
              } catch {
                persisted = false
              }
              logger.info?.(`deepseek-web: 上下文投喂切换为 ${contextMode}`)
              // 清理策略跟着模式走：链式 ⇒ 只手动清（自动删会顺手清掉链的上下文）。
              sessionCleaner.setManualOnly(contextMode === 'chained')
              sendJson(res, 200, {
                ok: true,
                mode: contextMode,
                persisted,
                hint: CONTEXT_MODE_HINT,
                settingsPath: contextModeSettingsPath(),
                chain: contextMode === 'chained' ? (contextChainInfo() ?? null) : null,
                pendingCleanup: sessionCleaner.pendingCount(),
              })
              return
            }

            // 手动清理（0.6.11）：退掉当前在用的会话 + 立刻把待删队列清干净。
            // 链式模式下自动清理是关的，用户想"现在就把网页端弄干净"就点面板那颗按钮。
            if (req.method === 'POST' && route === '/cleanup') {
              // 手动清理 = 把**所有**窗口的网页端会话都退掉（按会话分槽之后就是多个），
              // 然后立刻把待删队列清空。链式模式下这是唯一的清理出口。
              const live = clearLiveSession()
              const auth = getAuth()
              if (auth) for (const id of live) sessionCleaner.schedule(auth as WebAuth, id)
              await sessionCleaner.flush()
              logger.info?.(`deepseek-web: 手动清理完成（退出 ${live.length} 个会话，队列已清空）`)
              sendJson(res, 200, {
                ok: true,
                cleared: live.length,
                pending: sessionCleaner.pendingCount(),
                mode: contextMode,
              })
              return
            }

            // 诊断：用 Electron 的 net.fetch（Chromium 网络栈）对比指纹与连通性。
            // 实现与取舍见 src/net-diagnostics.ts 的模块注释。
            if (req.method === 'POST' && route === '/diagnostics/net-fetch') {
              const body = await readJsonBody(req)
              const mode: NetFetchMode = body?.mode === 'stream' ? 'stream' : 'probe'
              const result = await runNetFetchDiagnostics(getAuth(), mode)
              sendJson(res, result.ok ? 200 : 500, result)
              return
            }
            if (req.method === 'GET' && (route === '/status' || route === '/')) {
              const light = url.searchParams.get('light') === '1'
              const auth = getAuth()
              const summary = describeAuth(auth)
              let validation: { ok: boolean; error?: string } | undefined
              if (summary.loggedIn && !light) {
                const check = await validateAuth(auth as WebAuth, AbortSignal.timeout(15_000))
                validation = { ok: check.ok, ...(check.error ? { error: check.error } : {}) }
                if (check.ok && check.user && auth && (!auth.user || auth.user.display !== check.user.display)) {
                  // 补全**当前账号**的展示信息。
                  // ⚠️ 这里刻意不走 commitCapturedAuth：它不是"新捕获"，而是对当前账号的
                  // 元数据刷新。若让它消费掉添加模式，用户点了「登录新账号」后一刷新面板，
                  // 添加模式就没了 —— 那会是个很难查的 bug。
                  //
                  // ⚠️ 也不能走 writeAuth（审计 N02）：它的语义是「写入并**设为当前账号**」。
                  // `/status` 的校验请求是异步的，等待期间用户可能已经切到别的账号、甚至把
                  // 这个账号删掉了 —— 迟到的结果一旦走 writeAuth，就会把账号**切回去**、
                  // 或者把已删除的凭证**复活**。刷新元信息不该有这两个副作用。
                  // 所以只更新「仍存在、且 token 匹配」的那条记录。
                  const target = listAccounts().find((item) => item.token === auth.token)
                  if (target) refreshVerifiedIdentity(target.id, target.token, check.user)
                }
              }
              let registeredProviders: string[] = []
              try {
                registeredProviders = (ctx.llm.listProviders() ?? []).map((provider: any) => String(provider?.id ?? provider))
              } catch {}
              sendJson(res, 200, {
                provider: PROVIDER,
                registeredProviders,
                electron: canOpenElectronWindow(),
                loginWindowOpen: isLoginWindowOpen(),
                loginProgress: getLoginProgress(),
                fingerprint: getFingerprintReport(),
                lastLoginResult: getLastLoginResult(),
                // 登录能力自检：宿主进程类型 + 能否开 Electron 窗口 + 有没有真实浏览器可用。
                // 这三项是「窗口登录打不开」这类问题的第一现场证据（2026-09-11 就栽在这里）。
                loginCapability: {
                  processType: (process as any).type ?? 'node',
                  canOpenWindow: canOpenElectronWindow(),
                  browser: findSystemBrowser()?.name ?? null,
                },
                // 账号元信息（限制解除时间 / 探活结果）跟着 auth 一起给界面。
                // 注意 limit 目前仍只从"生成被拒"里学到 —— 虽然 users/current 的响应体里
                // 也带着 chat.mute_until（2026-09-12 实测），但还没接上，见 accounts.ts 的说明。
                // 本地状态位置（「关于」页展示）
                paths: {
                  webLogin: webLoginDir(),
                  accounts: accountsDir(),
                  ledger: ledgerDir(),
                },
                auth: {
                  ...summary,
                  limitUntilMs: Number.isFinite((auth as any)?.limit?.untilMs) ? (auth as any).limit.untilMs : null,
                  limitObservedAt: (auth as any)?.limit?.observedAt ?? null,
                  lastVerifiedAt: (auth as any)?.lastVerifiedAt ?? null,
                  lastVerifyError: (auth as any)?.lastVerifyError ?? null,
                },
                validation,
                models: MODEL_SPECS.map((spec) => ({
                  id: spec.id,
                  name: spec.name,
                  description: spec.description,
                  modelType: spec.modelType,
                  thinking: spec.thinking,
                  contextWindow: spec.contextWindow,
                })),
                config: {
                  maxPromptChars: adapterConfig.maxPromptChars,
                  idleTimeoutMs: adapterConfig.idleTimeoutMs,
                  deleteWebSessions: adapterConfig.deleteWebSessions !== false,
                  allowConcurrent: adapterConfig.allowConcurrent === true,
                  minRequestIntervalMs: adapterConfig.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
                  maxRequestIntervalMs: adapterConfig.maxRequestIntervalMs ?? DEFAULT_MAX_REQUEST_INTERVAL_MS,
                  sessionCleanup: cleanupMode,
                  sessionCleanupPending: sessionCleaner.pendingCount(),
                  transport: transportState.effective,
                  contextMode,
                  contextChain: contextChainInfo() ?? null,
                  version: pluginVersion(),
                  probeIntervalMs,
                },
              })
              return
            }

            // 「登录新账号（添加）」：往账号库里**再加一个号**，但不顶掉当前正在用的。
            // 为什么必须先清"登录态存放处"：登录窗口/独立浏览器 profile 里还留着当前账号
            // 的会话，不清的话新窗口一打开就是旧账号，抓回来还是它（等于没加）。
            // 注意这里**不动账号库里的任何账号** —— 与 /logout 的区别就在这。
            if (req.method === 'POST' && route === '/login/add') {
              // ⚠️ 必须同时清掉「重登意图」：它在 commitCapturedAuth 里**优先于**添加模式，
              // 残留期 60 分钟 ⇒ 这段时间内登另一个号会被写进上次那条旧记录（0.1.82 修）。
              endRelogin()
              beginAddAccount()
              const { profileCleared, partitionCleared } = await clearLoginState()
              logger.info?.(
                `deepseek-web: 准备添加新账号（profile=${profileCleared} partition=${partitionCleared}）—— 接下来捕获到的凭证只入库、不切换`,
              )
              sendJson(res, 200, {
                ok: true,
                profileCleared,
                partitionCleared,
                hint: '登录窗口里登录另一个账号；它会加入账号库，但不会自动切换',
              })
              return
            }

            // 「重新登录这个账号」：给**凭证失效**（探活失败）的账号用。
            //
            // 与 /login/add 的唯一区别：**不清浏览器登录态**。
            // 为什么：add 的目的是"加一个**别的**号"，所以要先把登录态清干净，否则新窗口
            // 一打开就是旧账号、抓回来还是它；而这里是"**修好同一个**号" —— 正是要复用
            // 浏览器里可能还在的登录态（还在的话一打开就能捕获，用户一个密码都不用敲）。
            // 真掉了也没关系：窗口里重新登录一次即可，那条路和 add 完全相同。
            //
            // 落库仍然走「添加模式」（commitCapturedAuth → 只入库、不切换）：
            // 修好它，但不顶掉你正在用的账号。若它本来就是当前账号，当前账号不会变、
            // 只是凭证被换成新的 —— 这正是期望行为。
            if (req.method === 'POST' && route === '/login/relogin') {
              // 必须记住**要更新哪一条记录**：旧实现只调 beginAddAccount()、把传进来的 id 扔了，
              // 而 beginAddAccount 只保证"别切换当前账号"，不保证更新同一条 —— 于是重登成功后
              // 库里新增一条同名记录、旧那条还挂着「需要重新登录」（用户实测，0.1.65 修）。
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              const target = id ? readAccount(id) : undefined
              if (!target) {
                sendJson(res, 404, { ok: false, error: '账号不存在（可能已被移除），请刷新后重试' })
                return
              }
              // 0.6.6：**先只读探一次，再决定怎么走**。
              //
              // 为什么（2026-09-29 用户申诉「不能一键重登吗？点了又让我重输账号密码」）：
              // 旧实现一进门就 `const stale = !!target.lastVerifyError`，只要标记还在就
              // **先清掉 profile + 登录分区**再开窗口。而那个标记多半来自**网络类失败**
              // （实测 9 个账号同时被写成 `fetch failed`，宿主日志里是
              //  `net::ERR_NETWORK_IO_SUSPENDED` —— 机器休眠、网络被挂起），凭证本身是好的；
              // 清完之后浏览器里空空的，于是必然要重新登录一遍 —— 用户被迫重敲手机号 + 验证码。
              //
              // 现在的顺序（判据是纯函数 `planRelogin`，有用例守）：
              //   already-valid ⇒ 探活了，账号本来就是好的：清掉标记，**什么都不打开**，一键结束；
              //   network       ⇒ 网络不通：不清登录态、不开窗口（这时候重登必然白敲），让网络恢复后重试；
              //   fresh-login   ⇒ 授权真的失效：走原流程，清登录态 + 手动登录一次。
              const probe = await probeOnce(target, {
                info: (message) => logger.info?.(message),
                warn: (message) => logger.warn?.(message),
              }).catch(() => undefined)
              const plan = planRelogin(probe)
              if (plan === 'already-valid') {
                logger.info?.(
                  `deepseek-web: 重登前探活通过（${target.id}）—— 凭证本来就可用，不打开登录窗口、不清任何东西`,
                )
                sendJson(res, 200, {
                  ok: true,
                  targetId: id,
                  alreadyValid: true,
                  hint: '这条账号校验通过 —— 它本来就是好的（失败的标记已清掉），不需要重新登录',
                })
                return
              }
              if (plan === 'network') {
                logger.warn?.(
                  `deepseek-web: 重登前探活失败（网络类）—— ${probe?.error}（不清登录态、不打开窗口）`,
                )
                sendJson(res, 200, {
                  ok: false,
                  network: true,
                  error:
                    `网络暂时不通，没能校验这条账号：${probe?.error ?? '未知原因'}。` +
                    '它的凭证没有被改动过 —— 网络恢复后再点一次即可，不需要重新登录',
                })
                return
              }
              // fresh-login：授权类失败（或压根探不了）⇒ 复用浏览器登录态无解，
              // 那份登录态正是让它失效的那一份（见上面的 0.1.75 说明）。
              const cleared = await clearLoginState()
              logger.info?.(
                `deepseek-web: 账号「${target.label || target.id}」授权已失效，重登不再复用登录态，` +
                  `先清掉（profile=${cleared.profileCleared} partition=${cleared.partitionCleared}）`,
              )
              beginRelogin(id)
              logger.info?.(
                `deepseek-web: 准备重新登录「${target.label || target.id}」（登录态已失效，本次不复用）` +
                  '—— 捕获后原地更新这条记录，不新增、也不切换当前账号',
              )
              // ── 0.6.14：有邮箱密码凭证就**直接自动重登**，不再要求用户手敲 ──────────
              // 用户原话："我点击重登之后又是让我重新输入账号密码，就不能直接点个重登按钮
              // 就登录上去不就行了？" —— 现在这条路是：无头真实浏览器 + 页面内登录（过数美指纹）。
              if (credentialForDisplay(target.user?.display)) {
                const auto = await autoReloginOne(id, logger)
                sendJson(res, 200, {
                  ok: auto.ok,
                  targetId: id,
                  autoRelogin: true,
                  verified: auto.verified ?? false,
                  ...(auto.display ? { display: auto.display } : {}),
                  ...(auto.ok ? { hint: auto.message } : { error: auto.message, code: auto.error }),
                })
                return
              }
              sendJson(res, 200, {
                ok: true,
                targetId: id,
                keptBrowserSession: false,
                hint:
                  '这条账号的授权确实失效了（登录态已清掉），请在打开的窗口里重新登录一次',
              })
              return
            }

            // 一键重登：把所有"能匹配到邮箱密码凭证"的账号依次自动重登（0.6.14）。
            // 体量上就是"每个号跑一次无头浏览器"，所以是**串行**执行、逐个回报结果 ——
            // 并行开 6 个浏览器只会让风控看着更像机器。
            if (req.method === 'POST' && route === '/login/relogin-all') {
              const entries = readCredentialEntries()
              const targets = selectReloginTargets({
                accounts: listAccounts().map((record) => ({
                  id: record.id,
                  ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
                  lastVerifyError: record.lastVerifyError ?? null,
                  ...(record.user ? { user: record.user } : {}),
                })),
                entries,
              })
              if (targets.length === 0) {
                sendJson(res, 200, {
                  ok: false,
                  results: [],
                  error:
                    entries.length === 0
                      ? '本机还没有邮箱密码凭证，无法自动重登'
                      : '现有账号都匹配不到邮箱密码凭证（脱敏名对不上）——可以用「登录新账号」手动补一条',
                })
                return
              }
              const results: { targetId: string; display: string; reason: string; ok: boolean; message: string }[] = []
              for (const item of targets) {
                const auto = await autoReloginOne(item.accountId, logger)
                results.push({
                  targetId: item.accountId,
                  display: item.display,
                  reason: item.reason,
                  ok: auto.ok,
                  message: auto.message,
                })
              }
              const okCount = results.filter((r) => r.ok).length
              logger.info?.(`deepseek-web: 一键重登完成 ${okCount}/${results.length}`)
              sendJson(res, 200, { ok: okCount > 0, results, okCount, total: results.length })
              return
            }

            if (req.method === 'POST' && route === '/login/browser') {
              // 主按钮（「用 Microsoft Edge 登录」）带 `fresh: true` 过来：**登录前先清登录态**。
              // 它此前是唯一**没有任何前置清理**的登录入口 —— 独立 profile 里若还留着上次那个
              // 账号，窗口一打开就是已登录，用户以为在登录、抓回来的却是旧号。
              // （「重登」那条路有意不清，所以这里做成按需，而不是路由的默认行为。）
              const freshBody = await readJsonBody(req).catch(() => undefined)
              if (freshBody?.fresh === true) {
                const { profileCleared, partitionCleared } = await clearLoginState()
                logger.info?.(
                  `deepseek-web: 登录前清理登录态（profile=${profileCleared} partition=${partitionCleared}）`,
                )
              }
              // 两条路：
              //  1) 宿主在主进程（旧架构）→ 插件自己开 Electron 窗口（带指纹伪装，见 login.ts）
              //  2) 宿主在 utility 进程（2026-09-11 起的架构）→ 没有窗口 API，
              //     改为拉起**真实 Edge/Chrome**（独立 profile + CDP）读取登录态
              if (canOpenElectronWindow()) {
                const result = await openLoginWindow(logger)
                sendJson(res, 200, { ...result, mode: 'window' })
                return
              }
              const outcome = await browserLogin({
                onProgress: (message) => logger?.info?.(`deepseek-web login(browser): ${message}`),
                signal: undefined,
              })
              if (outcome.ok && outcome.auth) {
                // 0.1.82：**先校验拿到身份，再落库**。此前是先 commit 再 validate ——
                // 而捕获出来的凭证不带身份（unverified），只能按 token 去重、而重登必然换 token
                // ⇒ 每次都新增一条账号记录，`serverId` 这条去重键也永远补不上。
                const check = await validateAuth(outcome.auth).catch(() => undefined)
                const verified = !!check?.ok
                // 校验通过才敢把 unverified 摘掉（没通过时 withVerifiedIdentity 会误清该标记）
                const commitAuth = verified ? withVerifiedIdentity(outcome.auth, check?.user) : outcome.auth
                // 添加模式下只入库（见 account-add.ts）；默认仍是"写入并设为当前"
                const commit = commitCapturedAuth(commitAuth)
                // 把这个账号的身份写回记录。
                // 为什么必须在这里补：捕获本身只拿到 token/cookie，**不含账号名**；
                // 不补的话列表只能显示内部 id（`acc_xxxxxxxx`），要等下一次探活（最长 30 分钟）
                // 才有名字 —— 实测用户加完账号一刷新就看到了那串 hex，会以为是 bug。
                // 身份来自刚才这次零额度的只读校验，顺手就拿到了。
                if (verified && check?.user && commit.recordId) {
                  const record = listAccounts().find((item) => item.id === commit.recordId)
                  const verifiedId = typeof (check.user as { id?: unknown }).id === 'string' ? String((check.user as { id?: unknown }).id) : ''
                  updateAccount(commit.recordId, {
                    user: { ...(record?.user ?? {}), ...check.user },
                    // ⚠️ `serverId` 是**去重键**：只回写 user 而不写它，下次同一个号还会被当成新账号
                    ...(verifiedId ? { serverId: verifiedId } : {}),
                    lastVerifiedAt: new Date().toISOString(),
                    lastVerifyError: undefined,
                  } as any)
                }
                sendJson(res, 200, {
                  started: true,
                  mode: 'browser',
                  added: commit.mode === 'add',
                  relogin: commit.mode === 'relogin',
                  created: commit.created === true,
                  activeId: activeAccountId() ?? null,
                  ok: true,
                  verified,
                  message: verified
                    ? `${outcome.message}，服务端校验通过`
                    : `${outcome.message}；服务端校验未通过（${check?.error ?? '未知原因'}）——可用「发送测试」再确认`,
                  display: check?.user?.display ? maskIdentifier(check.user.display) : undefined,
                })
                return
              }
              logger?.warn?.(`deepseek-web api /login/browser(browser) failed: ${outcome.reason} ${outcome.message}`)
              sendJson(res, 200, {
                started: false,
                mode: 'browser',
                ok: false,
                reason: outcome.reason ?? 'unknown',
                browserLeftOpen: !!outcome.browserLeftOpen,
                message: outcome.message,
              })
              return
            }

            if (req.method === 'POST' && route === '/login/external') {
              // 兜底：网页端连干净指纹的 Electron 窗口也拦时，用系统默认浏览器打开
              const result = await openExternalLogin()
              sendJson(res, 200, result)
              return
            }

            if (req.method === 'POST' && route === '/login/token') {
              const body = await readJsonBody(req)
              if (!body || typeof body.token !== 'string') {
                sendJson(res, 400, { ok: false, error: '请求体需要 { token: string, cookie?: string }' })
                return
              }
              const result = await loginWithToken(body.token, typeof body.cookie === 'string' ? body.cookie : undefined, logger)
              sendJson(res, 200, result)
              return
            }

            // 从已登录的持久化分区恢复凭证（免重新登录；凭证丢失/未落盘时的救急通道）
            if (req.method === 'POST' && route === '/login/recover') {
              const result = await captureFromPartition(logger)
              sendJson(res, 200, result)
              return
            }

            if (req.method === 'POST' && route === '/logout') {
              // 退出/换号是明确的"改当前账号"动作 —— 顺手清掉添加模式，
              // 免得它一直挂着、影响后面某次无关的捕获。
              endAddAccount()
              endRelogin()
              // await：面板会在退出后立刻打开登录窗口（换号），必须等分区清理完成
              const cleared = await logout()
              sendJson(res, 200, { ok: true, partitionCleared: cleared })
              return
            }

            if (req.method === 'POST' && route === '/test') {
              const body = await readJsonBody(req)
              const model = typeof body?.model === 'string' ? body.model : 'deepseek-chat'
              const prompt = typeof body?.prompt === 'string' && body.prompt.trim() ? body.prompt : '请用一句话确认你已连通。'
              const started = Date.now()
              const text: string[] = []
              const reasoning: string[] = []
              const toolCalls: string[] = []
              let finish: any
              try {
                const options = {
                  provider: PROVIDER,
                  model,
                  system: '你是连通性测试探针，回答保持简短。',
                  messages: [
                    {
                      id: 'dsw-test-1',
                      role: 'user',
                      content: [{ type: 'text', text: prompt }],
                      source: { kind: 'user' },
                    },
                  ],
                  signal: AbortSignal.timeout(90_000),
                }
                for await (const chunk of adapter.stream(options)) {
                  if (chunk?.type === 'text-delta') text.push(chunk.text)
                  else if (chunk?.type === 'reasoning-delta') reasoning.push(chunk.text)
                  else if (chunk?.type === 'tool-call-delta') toolCalls.push(`${chunk.name ?? '?'}(${chunk.argumentsDelta ?? ''})`)
                  else if (chunk?.type === 'finish') finish = chunk.reason
                }
              } catch (error: any) {
                sendJson(res, 200, {
                  ok: false,
                  ms: Date.now() - started,
                  error: error?.message ?? String(error),
                  code: error?.code ?? error?.failure?.code,
                })
                return
              }
              sendJson(res, 200, {
                ok: finish?.kind !== 'error',
                ms: Date.now() - started,
                model,
                text: text.join(''),
                ...(reasoning.length > 0 ? { reasoning: reasoning.join('').slice(0, 800) } : {}),
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
                finish,
              })
              return
            }

            if (req.method === 'POST' && route === '/models') {
              sendJson(res, 200, { models: await adapter.listModels(PROVIDER) })
              return
            }

            sendJson(res, 404, { error: `unknown route ${route}` })
          } catch (error: any) {
            if (error instanceof BodyError) {
              // 请求体问题不是"插件坏了"：给出结构化状态码，并关掉 keep-alive
              // —— 否则超大的请求会继续占着这条连接（审计 F16）。
              logger.warn?.(`deepseek-web api ${route} 请求体被拒：${error.message}`)
              try {
                res.shouldKeepAlive = false
              } catch {}
              if (!res.destroyed && !res.headersSent) sendJson(res, error.status, { ok: false, error: error.message })
              return
            }
            logger.warn?.(`deepseek-web api ${route} failed: ${error?.message ?? error}`)
            sendJson(res, 500, { error: error?.message ?? String(error) })
          }
        },
      }),
    'dsh-deepseek-web-login: api',
  )

  // 3) 卸载即净：关登录窗口与定时器；**退出时把欠删的会话交出去**。不清理凭证 ——
  //    卸载/热重载插件不等于登出。
  ctx.effect(() => () => {
    try {
      if (isLoginWindowOpen()) closeLoginWindow()
    } catch {}
    // 2026-09-14：退出收尾。顺序很重要 ——
    //   ① `disposeSessionReuse()` 把复用槽里的会话**交回它自己的清理回调**（排队待删）。
    //      只清槽不排队 = 每次退出白丢一个会话（实测就是这么堆起来的）。
    //   ② `flush()` 尽力把队列里的删掉（同步返回，不等网络完成 —— 宿主的卸载流程
    //      不会为一个网络请求停留）。
    // 于是删不掉的仍会留在 `session-journal` 的记录里（记录只在**确认删掉**时摘除），
    // 下次启动的补删会接上。被强杀时同理。
    try {
      disposeSessionReuse()
    } catch {}
    try {
      void sessionCleaner.flush()
    } catch {}
    try {
      void shutdownBrowserTransport()
    } catch {}
  }, 'dsh-deepseek-web-login: teardown')
}
