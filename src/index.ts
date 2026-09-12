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
import { browserLogin, findSystemBrowser } from './browser-login.ts'
import { canOpenElectronWindow, closeLoginWindow, captureFromPartition, getFingerprintReport, getLastLoginResult, getLoginProgress, isLoginWindowOpen, loginWithToken, logout, openExternalLogin, openLoginWindow } from './login.ts'
import {
  validateAuth,
  createSessionCleaner,
  DEFAULT_SESSION_CLEANUP,
  type SessionCleanupMode,
} from './webapi.ts'

export const name = 'dsh-deepseek-web-login'
export const inject = ['llm', 'webServer']

const API_PREFIX = '/deepseek-web-login/api'

export interface Config extends AdapterConfig {}

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

  // 节流设置：设置页保存过的值（gate.json）优先于 cordis config —— 设置页是用户的显式操作，
  // 不该被配置文件里的旧值盖回去。闸门在这里创建并共享给适配器，设置页改完即时生效。
  const savedGate = readGateSettings()
  const gate = createRequestGate({
    allowConcurrent: savedGate?.allowConcurrent ?? config.allowConcurrent === true,
    minIntervalMs: savedGate?.minRequestIntervalMs ?? config.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    logger,
  })
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
  // 附件服务（ctx.attachments）：图片输入所需。用 ctx.get 取（可选依赖，缺省则图片降级为文本）
  const adapter = createAdapter({
    getAuth,
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
            if (req.method === 'GET' && (route === '/status' || route === '/')) {
              const light = url.searchParams.get('light') === '1'
              const auth = getAuth()
              const summary = describeAuth(auth)
              let validation: { ok: boolean; error?: string } | undefined
              if (summary.loggedIn && !light) {
                const check = await validateAuth(auth as WebAuth, AbortSignal.timeout(15_000))
                validation = { ok: check.ok, ...(check.error ? { error: check.error } : {}) }
                if (check.ok && check.user && auth && (!auth.user || auth.user.display !== check.user.display)) {
                  // 补全账号展示信息
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
                auth: summary,
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
                },
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
                writeAuth(outcome.auth)
                const check = await validateAuth(outcome.auth).catch(() => undefined)
                const verified = !!check?.ok
                sendJson(res, 200, {
                  started: true,
                  mode: 'browser',
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
