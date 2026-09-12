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
import { maskIdentifier, readAuth, writeAuth, type WebAuth } from './auth.ts'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { PROVIDER, createAdapter, describeAuth, MODEL_SPECS, type AdapterConfig } from './adapter.ts'
import {
  createRequestGate,
  readGateSettings,
  writeGateSettings,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_MAX_REQUEST_INTERVAL_MS,
  INTERVAL_PRESETS,
  MAX_INTERVAL_MS,
  type GateSettings,
} from './gate.ts'
import { browserLogin, clearBrowserLoginProfile, findSystemBrowser } from './browser-login.ts'
import { canOpenElectronWindow, clearLoginPartition, closeLoginWindow, captureFromPartition, getFingerprintReport, getLastLoginResult, getLoginProgress, isLoginWindowOpen, loginWithToken, logout, openExternalLogin, openLoginWindow } from './login.ts'
import { beginAddAccount, commitCapturedAuth, endAddAccount } from './account-add.ts'
import {
  validateAuth,
  createSessionCleaner,
  currentFetch,
  DEFAULT_SESSION_CLEANUP,
  type SessionCleanupMode,
} from './webapi.ts'
import { consumeProbeRequest, runNetFetchDiagnostics, type NetFetchMode } from './net-diagnostics.ts'
import { noteCall as writeLedgerEntry, pruneLedger, summarizeLedger, ledgerDir, LEDGER_KEEP_DAYS } from './ledger.ts'
import { startProbeLoop } from './probe.ts'
import { checkForUpdate, RELEASE_REPO } from './update-check.ts'
import { pluginVersion } from './version.ts'
import { webLoginDir } from './paths.ts'
import {
  accountsDir,
  accountsFootprint,
  accountTitle,
  activeAccountId,
  exportAccounts,
  exportAccountsToFile,
  importAccounts,
  listAccounts,
  migrateLegacyAuthIfNeeded,
  removeAccount,
  setActiveAccount,
  updateAccount,
} from './accounts.ts'
import {
  applyTransport,
  readTransportSetting,
  transportSettingsPath,
  writeTransportSetting,
  DEFAULT_TRANSPORT,
  TRANSPORT_HINT,
  type TransportKind,
} from './transport.ts'

export const name = 'dsh-deepseek-web-login'
export const inject = ['llm', 'webServer']

const API_PREFIX = '/deepseek-web-login/api'

export interface Config extends AdapterConfig {
  /**
   * 传输层：网页端请求从哪个网络栈出去。
   * `chromium`（默认）＝ Electron 的 `net.fetch`，指纹与真实浏览器一致；`node` ＝ 原来的 undici。
   * 设置页保存的值优先于这里；环境不支持 chromium 时自动降级为 node。详见 transport.ts。
   */
  transport?: TransportKind
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

async function readJsonBody(req: any, limitBytes = 256 * 1024): Promise<any> {
  return await new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        resolve(undefined)
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function sendJson(res: any, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

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
  const gate = createRequestGate({
    allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
    minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    logger,
  })
  // 旧版（≤0.1.25）只有一份 deepseek-auth.json；首次启动时迁进账号库。
  // 只在「库为空 且 旧文件在」时跑一次，旧文件改名留档（不删），所以不会重复导入。
  const migratedAccount = migrateLegacyAuthIfNeeded()
  if (migratedAccount) {
    logger.info?.(`deepseek-web: 已把旧的单账号凭证迁移进账号库（${migratedAccount.id}）`)
  }

  // 传输层：默认走 Chromium 网络栈（TLS/HTTP2 指纹与真实浏览器一致，见 transport.ts 的模块注释）。
  // 优先级：设置页保存的值 > cordis config > 内置默认；环境拿不到 electron.net.fetch 时降级为 Node。
  let transportState = applyTransport(
    readTransportSetting() ?? (config.transport === 'node' ? 'node' : DEFAULT_TRANSPORT),
  )
  logger.info?.(
    `deepseek-web: 传输层=${transportState.effective}` +
      (transportState.degraded
        ? '（配置要求 Chromium，但本环境没有 electron.net.fetch，已降级为 Node）'
        : ''),
  )

  const adapterConfig: AdapterConfig = {
    maxPromptChars: config.maxPromptChars ?? 1_500_000,
    idleTimeoutMs: config.idleTimeoutMs ?? 120_000,
    deleteWebSessions: config.deleteWebSessions !== false,
    autoContinue: config.autoContinue !== false,
    maxContinuations: config.maxContinuations ?? 2,
    // 防风控：默认串行 + 每次调用之间至少 3 秒（见 README「配置」）。
    // 取闸门的实际生效值（可能来自设置页保存的 gate.json）。
    allowConcurrent: gate.settings().allowConcurrent,
    minRequestIntervalMs: gate.settings().minRequestIntervalMs,
    logger,
  }

  // 临时会话清理策略：默认「攒批 + 延迟」，减少「每轮建一个立刻删一个」的机器特征。
  // immediate 用老参数（1.5s / 每次一个）；deferred 用可配的延迟与批量阈值。
  const cleanupMode: SessionCleanupMode =
    savedGate?.sessionCleanup ?? config.sessionCleanup ?? DEFAULT_SESSION_CLEANUP.mode
  const sessionCleaner = createSessionCleaner({
    policy: {
      mode: cleanupMode,
      delayMs: cleanupMode === 'immediate' ? 1_500 : (config.sessionCleanupDelayMs ?? DEFAULT_SESSION_CLEANUP.delayMs),
      batchSize: cleanupMode === 'immediate' ? 1 : (config.sessionCleanupBatchSize ?? DEFAULT_SESSION_CLEANUP.batchSize),
    },
    logger,
  })

  const getAuth = (): WebAuth | undefined => readAuth()

  // 台账按天滚动清理（保留 LEDGER_KEEP_DAYS 天），启动时做一次就够。
  try {
    const pruned = pruneLedger(LEDGER_KEEP_DAYS)
    if (pruned > 0) logger.info?.(`deepseek-web: 已清理 ${pruned} 个过期台账文件`)
  } catch {}

  /**
   * 每次模型调用的结果上报（adapter 的 noteCall 钩子）。做两件事：
   *
   *  1. **把"账号级限制"学到账号上**。这个状态只能在生成请求被拒时学到
   *     （受限期间 `users/current` 依然 200），所以必须在这里记；成功一次且已过解除时间就清掉。
   *  2. 写本地台账，供设置页看请求密度与失败分类。
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
  }): void => {
    try {
      const accountId = activeAccountId()
      const muted = Number.isFinite(info.mutedUntilMs)
      if (!info.ok && muted && accountId) {
        updateAccount(accountId, {
          limit: { untilMs: Number(info.mutedUntilMs), observedAt: new Date().toISOString() },
        })
        logger.warn?.(
          `deepseek-web: 账号被临时限制，已记录解除时间 ${new Date(Number(info.mutedUntilMs)).toLocaleString()}`,
        )
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
    gate,
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
            // 请求节流设置（设置页的开关与滑块）——读写都即时生效，并持久化到 gate.json
            if (req.method === 'GET' && route === '/gate') {
              sendJson(res, 200, {
                ...gate.settings(),
                presets: INTERVAL_PRESETS.map(([lo, hi]) => ({ min: lo, max: hi })),
                maxIntervalMs: MAX_INTERVAL_MS,
                defaultMinIntervalMs: DEFAULT_MIN_REQUEST_INTERVAL_MS,
                defaultMaxIntervalMs: DEFAULT_MAX_REQUEST_INTERVAL_MS,
                cleanup: sessionCleaner.policy(),
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
              if (body.sessionCleanup !== undefined) {
                if (!['immediate', 'deferred', 'keep'].includes(body.sessionCleanup)) {
                  sendJson(res, 400, { ok: false, error: 'sessionCleanup 只能是 immediate / deferred / keep' })
                  return
                }
                patch.sessionCleanup = body.sessionCleanup
              }
              if (Object.keys(patch).length === 0) {
                sendJson(res, 400, { ok: false, error: '没有可更新的字段' })
                return
              }
              const applied = gate.configure(patch)
              // 清理策略由 cleaner 执行 → 同步生效
              if (patch.sessionCleanup) sessionCleaner.configure({ mode: patch.sessionCleanup })
              try {
                writeGateSettings(applied)
              } catch (error: any) {
                // 落盘失败不影响本次生效，但要说清楚（重启后会回到旧值）
                logger.warn?.(`deepseek-web: 节流设置落盘失败：${error?.message ?? error}`)
                sendJson(res, 200, { ok: true, ...applied, persisted: false, warning: '已即时生效，但写入 gate.json 失败，重启后会回到旧值' })
                return
              }
              sendJson(res, 200, { ok: true, ...applied, persisted: true })
              return
            }
            // 本地调用台账：请求密度 + 失败分类（用来判断节流到底有没有效）
            if (req.method === 'GET' && route === '/ledger') {
              const hours = Math.min(72, Math.max(1, Number(url.searchParams.get('hours')) || 24))
              sendJson(res, 200, summarizeLedger(hours))
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
              sendJson(res, 200, {
                activeId: activeId ?? null,
                accounts: listAccounts().map((record) => ({
                  id: record.id,
                  title: accountTitle(record, maskIdentifier),
                  display: record.user?.display ? maskIdentifier(record.user.display) : '',
                  label: record.label ?? '',
                  unverified: record.unverified === true,
                  capturedAt: record.capturedAt,
                  lastVerifiedAt: record.lastVerifiedAt ?? null,
                  lastVerifyError: record.lastVerifyError ?? null,
                  limit: record.limit ?? null,
                  isActive: record.id === activeId,
                })),
                footprint: accountsFootprint(),
              })
              return
            }
            if (req.method === 'POST' && route === '/accounts/switch') {
              const body = await readJsonBody(req)
              const id = String(body?.id ?? '')
              endAddAccount()
              if (!setActiveAccount(id)) {
                sendJson(res, 404, { ok: false, error: '账号不存在（可能已被移除）' })
                return
              }
              logger.info?.(`deepseek-web: 当前账号已切换为 ${id}`)
              sendJson(res, 200, { ok: true, activeId: id })
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
              const body = await readJsonBody(req)
              const path = typeof body?.path === 'string' ? body.path.trim() : ''
              let payload: unknown = body?.payload
              if (!payload && path) {
                try {
                  payload = JSON.parse(readFileSync(path, 'utf8'))
                } catch (error: any) {
                  sendJson(res, 400, { ok: false, error: `读取导入文件失败：${error?.message ?? error}` })
                  return
                }
              }
              if (!payload) {
                sendJson(res, 400, { ok: false, error: '请提供要导入的文件路径（或 payload）' })
                return
              }
              const result = importAccounts(payload)
              logger.info?.(`deepseek-web: 账号库导入完成（新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}）`)
              sendJson(res, 200, { ok: true, ...result, activeId: activeAccountId() ?? null })
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
                  (transportState.degraded ? '（要求 Chromium 但本环境不可用，已降级 Node）' : ''),
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
                  writeAuth({ ...auth, user: check.user })
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
                // 注意 limit 只能从"生成被拒"里学到 —— 受限期间 users/current 依然 200。
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
                  sessionCleanup: cleanupMode,
                  sessionCleanupPending: sessionCleaner.pendingCount(),
                  transport: transportState.effective,
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
              beginAddAccount()
              const profileCleared = clearBrowserLoginProfile()
              const partitionCleared = await clearLoginPartition().catch(() => false)
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

            if (req.method === 'POST' && route === '/login/browser') {
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
                // 添加模式下只入库（见 account-add.ts）；默认仍是"写入并设为当前"
                const commit = commitCapturedAuth(outcome.auth)
                const check = await validateAuth(outcome.auth).catch(() => undefined)
                const verified = !!check?.ok
                sendJson(res, 200, {
                  started: true,
                  mode: 'browser',
                  added: commit.mode === 'add',
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
            logger.warn?.(`deepseek-web api ${route} failed: ${error?.message ?? error}`)
            sendJson(res, 500, { error: error?.message ?? String(error) })
          }
        },
      }),
    'dsh-deepseek-web-login: api',
  )

  // 3) 卸载即净：只关掉登录窗口与定时器。**不清理凭证** —— 卸载/热重载插件不等于登出。
  ctx.effect(() => () => {
    try {
      if (isLoginWindowOpen()) closeLoginWindow()
    } catch {}
  }, 'dsh-deepseek-web-login: teardown')
}
