/**
 * 浏览器代理传输层 —— 当官方 DSH 桌面端拿不到 `electron.net.fetch` 时，
 * 用系统里的 Edge/Chrome 进程当请求出口，让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 机制：启动一个 headless 浏览器（独立 profile），通过 CDP 在页面上下文里调用 `fetch()`，
 * 请求实际从浏览器网络栈发出。响应通过 `Runtime.addBinding` 建立的回调分块传回 Node，
 * 再包装成标准 `Response`（含 ReadableStream）交给插件。
 *
 * 为什么不用 electron.net.fetch：官方 DSH 把插件跑成 ELECTRON_RUN_AS_NODE=1 的 Node 子进程，
 * require('electron') 拿不到 net.fetch。本模块是绕过这个限制的后备方案。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildBrowserArgs,
  CdpClient,
  findSystemBrowser as findSystemBrowserImpl,
  parseDevToolsActivePort,
  type BrowserCandidate,
} from './browser-login.ts'

/** 暴露给测试/诊断：找系统浏览器。 */
export const findSystemBrowser = findSystemBrowserImpl

const BINDING_NAME = '__dshBrowserTransportCallback'
const PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login', 'transport-profile')

interface TransportRequestState {
  resolveHeaders: (status: number, statusText: string, headers: Record<string, string>) => void
  rejectHeaders: (err: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  streamStarted: boolean
}

interface BrowserTransportSession {
  browser: BrowserCandidate
  child: ChildProcess
  cdp: CdpClient
  cleanup: () => void
}

let activeSession: BrowserTransportSession | undefined
let launchPromise: Promise<BrowserTransportSession> | undefined
const requests = new Map<string, TransportRequestState>()

export function systemBrowserAvailable(): boolean {
  // 测试隔离：单测/CI 可以强制关闭浏览器代理，避免依赖本机浏览器。
  if (process.env.DSH_NO_BROWSER_TRANSPORT === '1') return false
  return findSystemBrowser() !== null
}

/** 等 profile 里的 DevToolsActivePort 出现并返回端口。 */
async function waitForTransportDebugPort(
  profileDir: string,
  child: ChildProcess,
  timeoutMs = 25_000,
): Promise<number | undefined> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined
    try {
      const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2_000),
            redirect: 'error',
          })
          if (res.ok) return port
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return undefined
}

/** 找一个可用的 page target（we use about:blank）。 */
async function findPageTarget(port: number, timeoutMs = 20_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = (await res.json()) as any[]
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

/**
 * 🔴 0.6.42：处理页面内 PoW 求解的回传（格式 `requestId + ':ok:' + 答案` 或 `':err:' + 原因`）。
 *
 * ⚠️ **用 `indexOf` 找分隔符、不是 split** —— 错误消息里可能含 `:`（如 "solve code=0"），
 * split 会把后半截丢掉；也**不能**用 `payload.split(':')` 后取 `[1]`。
 */
function handlePowBindingEvent(payload: string): void {
  const sep = payload.indexOf(':')
  if (sep < 0) return
  const requestId = payload.slice(0, sep)
  const rest = payload.slice(sep + 1)
  const state = powRequests.get(requestId)
  if (!state) return

  const kindSep = rest.indexOf(':')
  const kind = kindSep < 0 ? rest : rest.slice(0, kindSep)
  const value = kindSep < 0 ? '' : rest.slice(kindSep + 1)

  if (kind === 'ok') {
    state.onAnswer(Number(value))
  } else {
    state.onError(value || 'unknown')
  }
}

function handleBindingEvent(payload: string): void {
  let msg: any
  try {
    msg = JSON.parse(payload)
  } catch {
    return
  }
  const requestId = msg?.requestId
  if (!requestId) return
  const state = requests.get(requestId)
  if (!state) return

  switch (msg.type) {
    case 'headers': {
      if (state.streamStarted) return
      state.streamStarted = true
      state.resolveHeaders(msg.status ?? 200, msg.statusText ?? '', msg.headers ?? {})
      break
    }
    case 'chunk': {
      const arr = msg.chunk
      if (Array.isArray(arr) && state.controller) {
        try {
          state.controller.enqueue(new Uint8Array(arr))
        } catch {}
      }
      break
    }
    case 'done': {
      if (state.controller) {
        try {
          state.controller.close()
        } catch {}
      }
      requests.delete(requestId)
      break
    }
    case 'error': {
      if (state.controller) {
        try {
          state.controller.error(new Error(String(msg.error ?? '浏览器请求失败')))
        } catch {}
      }
      if (!state.streamStarted) {
        state.rejectHeaders(new Error(String(msg.error ?? '浏览器请求失败')))
      }
      requests.delete(requestId)
      break
    }
  }
}

export async function launchBrowserTransport(): Promise<BrowserTransportSession> {
  if (activeSession) return activeSession
  if (launchPromise) return launchPromise

  launchPromise = (async () => {
    const browser = findSystemBrowser()
    if (!browser) throw new Error('未找到 Edge/Chrome，无法启动浏览器代理传输层')

    try {
      if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
      mkdirSync(PROFILE_DIR, { recursive: true })
    } catch (error: any) {
      throw new Error(`清理 transport profile 失败：${error?.message ?? error}`)
    }

    const child = spawn(
      browser.path,
      [
        ...buildBrowserArgs(PROFILE_DIR, 'about:blank'),
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--allow-insecure-localhost',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      {
        stdio: 'ignore',
        detached: false,
      },
    )

    let spawnError: Error | undefined
    child.on('error', (err) => {
      spawnError = err
    })
    await new Promise((r) => setTimeout(r, 300))
    if (spawnError) {
      try {
        child.kill()
      } catch {}
      throw new Error(`启动浏览器失败：${spawnError.message}`)
    }

    const port = await waitForTransportDebugPort(PROFILE_DIR, child)
    if (!port) {
      try {
        child.kill()
      } catch {}
      throw new Error('浏览器调试端口未就绪')
    }

    const page = await findPageTarget(port)
    if (!page) {
      try {
        child.kill()
      } catch {}
      throw new Error('浏览器里没有可用页面')
    }

    const cdp = new CdpClient(page.webSocketDebuggerUrl)
    try {
      await cdp.connect()
    } catch (error: any) {
      try {
        child.kill()
      } catch {}
      throw new Error(`连接 CDP 失败：${error?.message ?? error}`)
    }

    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Runtime.addBinding', { name: BINDING_NAME }).catch((error: any) => {
      throw new Error(`addBinding 失败：${error?.message ?? error}`)
    })
    // 🔴 0.6.42：PoW 求解结果的通道（`solvePowInPage` 用）。
    // ⚠️ **必须与 BINDING_NAME 分开注册**：传输层的回调负载是 JSON（`{requestId,type,…}`），
    //   而 PoW 的是 `requestId + ':ok:' + 答案` 这种裸字符串 —— 混在一个通道里
    //   会让两边的解析器互相误判（传输层会把 PoW 的字符串当 JSON 解析失败）。
    await cdp.send('Runtime.addBinding', { name: POW_BINDING }).catch(() => {
      /* 已有会话可能注册过；失败不致命，真用到时会在 solvePoWInPage 里报错 */
    })

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.bindingCalled') {
        const name = String(params?.name ?? '')
        if (name === BINDING_NAME) {
          handleBindingEvent(String(params?.payload ?? ''))
        } else if (name === POW_BINDING) {
          handlePowBindingEvent(String(params?.payload ?? ''))
        }
      }
    })

    const cleanup = (): void => {
      try {
        cdp.close()
      } catch {}
      try {
        child.kill()
      } catch {}
      activeSession = undefined
      launchPromise = undefined
    }

    child.on('exit', cleanup)

    return { browser, child, cdp, cleanup }
  })()

  try {
    activeSession = await launchPromise
  } catch (error) {
    launchPromise = undefined
    throw error
  }
  launchPromise = undefined
  return activeSession
}

export async function shutdownBrowserTransport(): Promise<void> {
  activeSession?.cleanup()
  activeSession = undefined
  launchPromise = undefined
}

/** 页面上下文里的辅助函数名（把 base64 还原成字节）。 */
const B64_HELPER = '__dshB64ToBytes'
/** 页面上下文里的辅助函数名（把序列化过的 parts 重建成 FormData）。 */
const FORMDATA_HELPER = '__dshRebuildFormData'

/** 页面里用到的两个小工具（随每次 evaluate 一起注入，保持无状态）。 */
const PAGE_HELPERS = `
  const ${B64_HELPER} = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };
  const ${FORMDATA_HELPER} = (parts) => {
    const form = new FormData();
    for (const p of parts) {
      if (p.t === 'text') form.append(p.name, p.value);
      else form.append(p.name, new File([${B64_HELPER}(p.b64)], p.filename, { type: p.type }));
    }
    return form;
  };
`

/**
 * 把 Node 侧的请求体转成"能在页面里重建它"的表达式。
 *
 * 🔴 0.6.20 的第一版只支持 string / Uint8Array / ArrayBuffer，遇到 FormData 直接抛
 * "暂不支持" —— 而**图片上传走的就是 FormData（multipart）**（见 `webapi.uploadImageFile`），
 * 于是"切到浏览器代理传输层之后图片全传不上去"（2026-10-01 用户报，报错文案就来自这里）。
 *
 * 0.6.24：FormData / Blob 都按**字节**搬过去，在页面里重建。
 * 细节：
 *  - 用 **base64** 而不是 JSON 数组传字节（体积约为 1/2.4，CDP 消息不至于被图片撑爆）；
 *  - 用 `new File(...)` 而不是 `new Blob(...)` —— 必须保住 **filename**，
 *    服务端是按**文件名后缀**判图片类型的（见 protocol.ts 的说明）；
 *  - 语言无关地遍历 FormData 的 entry：`TextPart` 原样作为字段，其余一律当文件。
 */
async function bodyToPageInit(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) {
    return 'undefined'
  }
  if (typeof body === 'string') {
    return JSON.stringify(body)
  }
  if (body instanceof Uint8Array) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(body).toString('base64'))})`
  }
  if (body instanceof ArrayBuffer) {
    return `${B64_HELPER}(${JSON.stringify(Buffer.from(new Uint8Array(body)).toString('base64'))})`
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // ⚠️ 用 forEach 而不是 `entries()`：后者要 `DOM.Iterable` lib，本项目的 lib 里没有
    // （为一个遍历去动 tsconfig 影响面太大）。先收成数组，再逐个 await 读字节。
    const raw: Array<[string, FormDataEntryValue]> = []
    body.forEach((value, name) => {
      raw.push([name, value])
    })
    const parts: Array<Record<string, unknown>> = []
    for (const [name, value] of raw) {
      if (typeof value === 'string') {
        parts.push({ t: 'text', name, value })
        continue
      }
      // File / Blob（Node 20+ 两者都有 arrayBuffer()）
      const blob = value as Blob
      const b64 = Buffer.from(new Uint8Array(await blob.arrayBuffer())).toString('base64')
      parts.push({
        t: 'file',
        name,
        filename: (blob as File).name || name || 'blob',
        type: blob.type || 'application/octet-stream',
        b64,
      })
    }
    return `${FORMDATA_HELPER}(${JSON.stringify(parts)})`
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const b64 = Buffer.from(new Uint8Array(await body.arrayBuffer())).toString('base64')
    return `new Blob([${B64_HELPER}(${JSON.stringify(b64)})], { type: ${JSON.stringify(body.type || 'application/octet-stream')} })`
  }
  throw new Error(
    '浏览器代理传输层不支持的请求体类型（支持 string / Uint8Array / ArrayBuffer / FormData / Blob）',
  )
}

const POW_BINDING = '__dshPowSolveResult'

/**
 * 🔴 0.6.42：**在浏览器页面上下文里解 PoW**，而不是在 Node 里。
 *
 * ## 为什么必须挪
 *
 * DeepSeek 的 `/api/v0/chat/create_pow_challenge` 会返回一个 `sha3_wasm_bg.*.wasm`，
 * 客户端必须自己调用 `wasm_solve` 求出一个答案。**在 Node 里 `WebAssembly.instantiate`
 * 求这个答案，是整条链路上最容易被风控识别的特征** ——
 * `xiaoY233/DeepSeek-Free-API` 的 Disclaimers 把它列为明确的封号触发条件：
 * > Challenge Solving Patterns: Automated challenge solving detected
 *
 * 官方网页端自己是在**页面上下文**里解的（wasm 由页面脚本加载、答案随正常请求发出）。
 * 我们已经有 CDP 会话（`Runtime.addBinding` + `Runtime.evaluate`），
 * 于是可以让**官方自己的 wasm 在官方自己的页面里跑** ——
 * 发出的请求形态与真人在浏览器里完全一致。
 *
 * ## 为什么这条一定可行（不是猜测）
 *
 * ① 传输层本来就跑在真实页面里（`createBrowserFetch` 的每个请求都是 `Runtime.evaluate`）；
 * ② wasm 的地址有白名单（`checkedWasmUrl`：仅 `*.deepseek.com`、`.wasm` 结尾）
 *    ⇒ 在同源页面里 `fetch` 它必然同源、CORS 不会拦；
 * ③ 页面已经有我们的 binding 通道 ⇒ 答案回传不需要新机制。
 *
 * ## 判据
 *
 * 页面里必须真的**算出了有限数**才算成功 ——
 * 绝不接受"wasm 加载失败就退回 Node 侧悄悄算"（那等于这个改动没发生，
 * 却给了我们"已经改好了"的错觉）。
 */
export async function solvePowInPage(input: {
  wasmUrl: string
  challenge: string
  salt: string
  difficulty: string | number
  expireAt: string | number
}): Promise<number> {
  const session = await launchBrowserTransport()
  const requestId = `pow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const answer = await new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      powRequests.delete(requestId)
      fn()
    }

    powRequests.set(requestId, {
      onAnswer: (value) => {
        if (!Number.isFinite(value) || value <= 0) {
          finish(() => reject(new Error(`页面内 PoW 返回了非法答案：${String(value)}`)))
          return
        }
        finish(() => resolve(Math.floor(value)))
      },
      onError: (message) => finish(() => reject(new Error(`页面内 PoW 失败：${message}`))),
    })

    // ⚠️ prefix 的拼法必须与 Node 版**逐字一致**（`${salt}_${expire_at}_`），
    // 否则算出来的答案对不上。少一个下划线 ⇒ 服务端判失败 ⇒ 挑战重发。
    const expression = `
      (async () => {
        const report = (v) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':ok:' + String(v));
        const fail = (m) => ${POW_BINDING}(${JSON.stringify(requestId)} + ':err:' + String(m));
        try {
          const resp = await fetch(${JSON.stringify(input.wasmUrl)});
          if (!resp.ok) { fail('wasm HTTP ' + resp.status); return; }
          const bytes = await resp.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
          const e = instance.exports;
          if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
            fail('PoW WASM exports missing'); return;
          }
          const enc = new TextEncoder();
          const cBytes = enc.encode(${JSON.stringify(input.challenge)});
          const pBytes = enc.encode(${JSON.stringify(String(input.salt) + '_' + String(input.expireAt) + '_')});
          const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
          const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
          new Uint8Array(e.memory.buffer).set(cBytes, cP);
          new Uint8Array(e.memory.buffer).set(pBytes, pP);
          const sp = e.__wbindgen_add_to_stack_pointer(-16);
          e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(${JSON.stringify(String(input.difficulty))}));
          const dv = new DataView(e.memory.buffer);
          const code = dv.getInt32(sp, true);
          const answer = dv.getFloat64(sp + 8, true);
          e.__wbindgen_add_to_stack_pointer(16);
          if (code === 0 || !Number.isFinite(answer) || answer <= 0) { fail('solve code=' + code); return; }
          report(answer);
        } catch (err) { fail(err && err.message ? err.message : String(err)); }
      })()
    `
    session.cdp.send('Runtime.evaluate', { expression, awaitPromise: false, userGesture: true }).catch((error: any) => {
      const state = powRequests.get(requestId)
      if (state) state.onError(error?.message ?? String(error))
    })
  })

  return answer
}

interface PowSolveState {
  onAnswer: (value: number) => void
  onError: (message: string) => void
}

const powRequests = new Map<string, PowSolveState>()

export function createBrowserFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const session = await launchBrowserTransport()

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) headers[key] = value
      } else {
        for (const [key, value] of Object.entries(init.headers)) headers[key] = String(value)
      }
    }

    // ⚠️ 现在要 await：FormData/Blob 需要先读出字节才能序列化（图片上传就走这条路）。
    const bodyExpr = await bodyToPageInit(init?.body)
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    // 先注册状态，再 evaluate；binding 事件可能在 evaluate 还没返回时就到了。
    const headersPromise = new Promise<Response>((resolve, reject) => {
      const state: TransportRequestState = {
        resolveHeaders: (status, statusText, respHeaders) => {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              state.controller = controller
            },
            cancel: () => {
              requests.delete(requestId)
            },
          })
          const resp = new Response(stream, {
            status,
            statusText,
            headers: respHeaders,
          })
          resolve(resp)
        },
        rejectHeaders: reject,
        streamStarted: false,
      }
      requests.set(requestId, state)
    })

    const expression = `
      (async () => {
        ${PAGE_HELPERS}
        const requestId = ${JSON.stringify(requestId)};
        try {
          const init = {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(headers)},
            body: ${bodyExpr},
          };
          const requestInit = init.body === undefined
            ? { method: init.method, headers: init.headers }
            : init;
          const resp = await fetch(${JSON.stringify(url)}, requestInit);
          ${BINDING_NAME}(JSON.stringify({
            requestId,
            type: 'headers',
            status: resp.status,
            statusText: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
          }));
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ${BINDING_NAME}(JSON.stringify({ requestId, type: 'done' }));
              break;
            }
            ${BINDING_NAME}(JSON.stringify({ requestId, type: 'chunk', chunk: Array.from(value) }));
          }
        } catch (error) {
          ${BINDING_NAME}(JSON.stringify({ requestId, type: 'error', error: String(error) }));
        }
      })()
    `

    session.cdp.send('Runtime.evaluate', { expression, awaitPromise: false, userGesture: true }).catch((error: any) => {
      const state = requests.get(requestId)
      if (state && !state.streamStarted) {
        state.rejectHeaders(new Error(`evaluate 失败：${error?.message ?? error}`))
        requests.delete(requestId)
      }
    })

    return await headersPromise
  }
}
