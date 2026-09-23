/**
 * net.fetch 诊断 —— 验证「把网页端请求从 Node 网络栈切到 Chromium 网络栈」是否可行。
 *
 * 背景（2026-09-12 实测）：
 *  - 用 Node 的 fetch（undici）与 Chrome 分别请求 tls.peet.ws，指纹差异是**结构性**的：
 *    JA4 的 h1 vs h2、Node 无 GREASE、cipher 55 个 vs 15 个、扩展集合完全不同。
 *    也就是说请求在 TLS 层就能被判定为「非浏览器客户端」。
 *  - 参考项目 cuckoo-code / deepseek-pp 都**不让 Node 发请求**（前者内嵌浏览器、后者 hook 用户浏览器），
 *    从未被风控 —— 印证了"请求从哪出去"才是关键差异。
 *  - DSH 本体是 Electron，插件宿主是 **utility 进程**。官方文档：`net` 模块适用 Main + Utility，
 *    且 utility 的网络请求默认走 Chromium 的 system network context。
 *  - 实测能力探测（2026-09-12）确认：utility 进程里 `require('electron')` 只暴露
 *    `net` 与 `systemPreferences`，其中 **`net.fetch` 是 function** ✅
 *
 * 所以理论上不必引入 uTLS / curl-impersonate，换一处传输层就能拿到浏览器指纹。
 * 但动主路径之前必须先坐实三件事，本模块就是干这个的：
 *  ① TLS/HTTP2 指纹是否真的变成浏览器（请求第三方检测站，零额度）
 *  ② **能否读流式响应**（`response.body` + AbortSignal）—— 这是成败点：
 *     拿不到 body 就没法读 SSE，整条改造路线直接作废。用**本地分块服务**测，
 *     确定性、零外部依赖、零额度。
 *  ③ 鉴权是否照常（header / cookie 原样透传：请求 DeepSeek 的 users/current，只读不生成）
 *
 * 另有一个可选档 `stream`：再跑一次迷你 completion（**会消耗一点额度**），
 * 端到端验证 DeepSeek 的 SSE 流。默认不跑。
 *
 * 触发方式（两种共用同一份实现）：
 *  - 接口：`POST /deepseek-web-login/api/diagnostics/net-fetch`，body `{"mode":"probe"|"stream"}`
 *  - 启动时：往 `<DSH_HOME>/web-login/probe-request.json` 写 `{"mode":"probe"}` 后重启 DSH
 *    （宿主进程的 HTTP 端点只有 DSH 自己的同源页面打得通，从外部 curl 会撞同源守卫；
 *    读完会把文件改名为 `*.done-<时间>`，不删文件）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { resolveDshHome, type WebAuth } from './auth.ts'
import { buildDsHeaders, fetchImplKind, scheduleDeleteSession, setFetchImpl, streamWebCompletion } from './webapi.ts'
import { electronNetFetch } from './transport.ts'

export type NetFetchMode = 'probe' | 'stream'

/**
 * 用一次本地分块响应，验证指定 fetch 能否**增量读流**并支持 AbortSignal。
 * 导出是为了单测 —— 这条判据本身必须可被正/反向验证（见 tests/check-net-diagnostics.mjs）。
 *
 * 为什么不直接打远程：这一步只关心传输实现的流式能力，本地服务是确定性的 ——
 * 不受外网抖动/代理影响，也不会产生任何真实请求。服务器写满 50 个分片才算完，
 * 我们读到 3 个就 abort，同时观察服务端是否看到连接被断开。
 */
export async function probeStreamingSupport(fetchImpl: typeof fetch) {
  const evidence: any = { chunks: 0, abortedEarly: false }
  let server: ReturnType<typeof createServer> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let aborted = false

  try {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let n = 0
      timer = setInterval(() => {
        n += 1
        res.write(`data: chunk-${n}\n\n`)
        if (n >= 50) {
          if (timer) clearInterval(timer)
          res.end()
        }
      }, 20)
      req.on('close', () => {
        aborted = true
        if (timer) clearInterval(timer)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    // 别让这个探测用的监听端口把宿主进程吊住
    server.unref()

    const port = (server.address() as any)?.port
    evidence.url = `http://127.0.0.1:${port}/`
    const controller = new AbortController()
    const response = await fetchImpl(evidence.url, { signal: controller.signal })
    evidence.status = response.status
    evidence.hasBody = !!response.body
    if (!response.body) {
      evidence.ok = false
      evidence.error = 'response.body 为空 —— 无法读 SSE，改造路线不成立'
      return evidence
    }

    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (evidence.chunks < 3) {
      const { value, done } = await reader.read()
      if (done) break
      evidence.chunks += 1
      text += decoder.decode(value, { stream: true })
    }
    evidence.sample = text.slice(0, 60)

    // 验证 AbortSignal：abort 之后服务端应当看到连接断开
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 150))
    evidence.abortedEarly = aborted

    evidence.ok = evidence.chunks >= 3 && evidence.abortedEarly
    if (evidence.chunks < 3) evidence.error = `只读到 ${evidence.chunks} 个分片，疑似被整体缓冲`
    else if (!evidence.abortedEarly) evidence.error = 'abort 之后服务端仍认为连接开着，AbortSignal 可能未生效'
    return evidence
  } catch (error: any) {
    evidence.ok = false
    evidence.error = error?.message ?? String(error)
    return evidence
  } finally {
    try {
      await reader?.cancel()
    } catch {}
    if (timer) clearInterval(timer)
    try {
      ;(server as any)?.closeAllConnections?.()
      server?.close()
    } catch {}
  }
}

/**
 * 跑一轮诊断。
 *
 * `probe`（默认，**零额度**）：指纹 + 流式能力 + 鉴权，三步都不产生生成请求。
 * `stream`：在 probe 之上再跑一次迷你 completion（**会消耗一点额度**），端到端验证 DeepSeek 的 SSE。
 *
 * 整个过程**不改变主请求路径** —— 注入的传输层用完即还原（finally 保证）。
 */
export async function runNetFetchDiagnostics(auth: WebAuth | undefined, mode: NetFetchMode = 'probe') {
  const netFetch = electronNetFetch()
  if (!netFetch) {
    return { ok: false, error: 'electron.net.fetch 不可用（宿主未暴露 net）' } as const
  }

  const transportBefore = fetchImplKind()
  const results: any[] = []

  // ① TLS / HTTP2 指纹（零额度，直击"指纹是否变成浏览器"这个核心问题）
  try {
    const response = await netFetch('https://tls.peet.ws/api/all')
    const payload: any = await response.json()
    results.push({
      step: '① netFetch → tls.peet.ws（指纹）',
      ok: true,
      status: response.status,
      ja3_hash: payload?.tls?.ja3_hash,
      ja4: payload?.tls?.ja4,
      http2_hash: payload?.http2?.akamai_fingerprint_hash,
      http_version: payload?.http_version,
      ua: String(payload?.user_agent ?? '').slice(0, 70),
    })
  } catch (error: any) {
    results.push({ step: '① netFetch → tls.peet.ws（指纹）', ok: false, error: error?.message ?? String(error) })
  }

  // ② 流式能力（零额度、零外部依赖）：拿不到 response.body 就没法读 SSE，成败点
  results.push({ step: '② netFetch 本地分块流（response.body + AbortSignal）', ...(await probeStreamingSupport(netFetch)) })

  // ③ 鉴权（只读 users/current，不生成）
  if (!auth) {
    results.push({ step: '③ netFetch → users/current（鉴权）', ok: false, error: '尚未登录' })
  } else {
    try {
      const started = Date.now()
      const response = await netFetch('https://chat.deepseek.com/api/v0/users/current', {
        headers: buildDsHeaders(auth),
        signal: AbortSignal.timeout(20_000),
      })
      const text = await response.text()
      results.push({
        step: '③ netFetch → users/current（鉴权）',
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
        body: text.slice(0, 240),
      })
    } catch (error: any) {
      results.push({ step: '③ netFetch → users/current（鉴权）', ok: false, error: error?.message ?? String(error) })
    }
  }

  // ④ 端到端 SSE —— 只有显式要求才跑，会消耗一点额度
  if (mode === 'stream' && auth) {
    setFetchImpl(netFetch)
    try {
      const started = Date.now()
      let chunks = 0
      let sample = ''
      for await (const event of streamWebCompletion(auth, {
        // 参数形态必须与适配器真实调用一致：thinkingEnabled / modelType 是必填，
        // 缺了会发出残缺请求体（JSON.stringify 丢掉 undefined 字段）而被服务端拒。
        prompt: '只回复两个字：好的',
        thinkingEnabled: false,
        modelType: 'default',
        refFileIds: [],
        idleTimeoutMs: 30_000,
        onDeleteSession: (sessionId: string) => scheduleDeleteSession(auth, sessionId),
      })) {
        if (event?.kind === 'text') {
          chunks += 1
          sample += String(event.text ?? '')
          if (chunks >= 6) break
        }
      }
      results.push({
        step: '④ netFetch → DeepSeek 流式 completion（端到端）',
        ok: true,
        text_chunks: chunks,
        ms: Date.now() - started,
        sample: sample.slice(0, 80),
      })
    } catch (error: any) {
      results.push({
        step: '④ netFetch → DeepSeek 流式 completion（端到端）',
        ok: false,
        code: error?.code,
        error: error?.message ?? String(error),
      })
    } finally {
      // ⚠️ 0.1.82：必须还原成**进来时那一个**，不能无参调用 ——
      // `setFetchImpl()` 的语义是"还原为 Node 全局 fetch"，而默认配置是 Chromium 网络栈，
      // 于是跑一次诊断就把指纹能力悄悄关掉（设置页仍显示 chromium），直到重启才恢复。
      if (transportBefore === 'injected') setFetchImpl(netFetch)
      else setFetchImpl()
      const now = fetchImplKind()
      results.push({
        step: '传输层已还原',
        ok: now === transportBefore,
        was: transportBefore,
        now,
        ...(now === transportBefore ? {} : { error: '还原后与诊断前不一致，请重启 DSH' }),
      })
    }
  }

  return { ok: true, mode, transportBefore, transportAfter: fetchImplKind(), results } as const
}

/** 启动探测的标记文件路径（与 gate.json 同目录，沿用 DSH_HOME 约定）。 */
export function probeRequestPath(): string {
  return join(resolveDshHome(), 'web-login', 'probe-request.json')
}

/** 写一个启动探测请求（写完后重启 DSH 即会执行）。 */
export function writeProbeRequest(mode: NetFetchMode = 'probe'): string {
  const file = probeRequestPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ mode, requestedAt: new Date().toISOString() }, null, 2), 'utf8')
  return file
}

/**
 * 读并"消费"启动探测请求。读到就返回 mode，并把文件改名为 `*.done-<时间戳>`
 * （本机禁止删除文件，用改名表示已执行；也留作历史记录）。
 */
export function consumeProbeRequest(): NetFetchMode | undefined {
  const file = probeRequestPath()
  try {
    if (!existsSync(file)) return undefined
    let mode: NetFetchMode = 'probe'
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw?.mode === 'stream') mode = 'stream'
    } catch {
      // 内容损坏也照跑一次 probe —— 比静默跳过有用（多半是手写这个文件时格式写错）
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(file, `${file}.done-${stamp}`)
    return mode
  } catch {
    return undefined
  }
}
