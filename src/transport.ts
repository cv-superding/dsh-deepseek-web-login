/**
 * 传输层选择 —— 网页端请求到底是「从 Node 网络栈出去」还是「从 Chromium 网络栈出去」。
 *
 * 为什么在意（2026-09-12 实测，同一台机器同一天）：
 *
 * | | JA4 | cipher 列表哈希 | ALPN |
 * |---|---|---|---|
 * | Node fetch(undici) | `t13d5212h1_…` | — | **h1** |
 * | Chrome（本机 152） | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `8daaf6152771` | h2 |
 * | net.fetch（Electron 43） | `t13d1516h2_8daaf6152771_806a8c22fdea` | **`8daaf6152771`** | h2 |
 *
 * 也就是说 Node 的请求在 **TLS 层**就能被判定为「非浏览器客户端」（cipher 数量差 3 倍多、
 * 不走 HTTP/2、完全不带 GREASE），而这几项**调参修不了**。
 * 改用 Electron 的 `net.fetch` 后，走的是 Chromium 内置网络栈：
 * cipher 列表哈希与 Chrome **逐字节一致**，ALPN 与 cipher 数量也都对上，
 * 唯一差异是扩展数 16 vs 17（Electron 43 内置 Chromium 150，本机 Chrome 是 152，版本差异，属正常）。
 *
 * 集成方式：宿主（index.ts）在启动时按设置**一次性注入**，而不是让 webapi 去 require electron ——
 * webapi 保持与环境无关，单测里天然不会碰到 electron。
 *
 * ⚠️ 行为变更（必须知道）：Chromium 网络栈会走**系统代理**，而 Node fetch 完全无视代理。
 * 若系统代理指向未开启的梯子，切到 chromium 后请求会失败 —— 所以这项做成设置页可切换，
 * 并在失败时给出明确指引。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { resolveDshHome } from './auth.ts'
import { setFetchImpl } from './webapi.ts'

export type TransportKind = 'chromium' | 'node'

/** 默认走 Chromium 网络栈 —— 这才是本插件想要的"看起来像浏览器"。 */
export const DEFAULT_TRANSPORT: TransportKind = 'chromium'

export const TRANSPORT_HINT =
  'Chromium 网络栈会跟随**系统代理**（Node 则完全无视代理）。若梯子关闭时系统代理仍指向 ' +
  '127.0.0.1:7897，切到 Chromium 后请求会失败 —— 这时切回 Node 即可。'

/** 取 Electron 的 `net.fetch`；不可用（非 Electron 环境 / 未暴露 net）返回 undefined。 */
export function electronNetFetch(): typeof fetch | undefined {
  try {
    const electron: any = createRequire(import.meta.url)('electron')
    const impl = electron?.net?.fetch
    return typeof impl === 'function' ? impl : undefined
  } catch {
    return undefined
  }
}

export function transportSettingsPath(): string {
  return join(resolveDshHome(), 'web-login', 'transport.json')
}

export function readTransportSetting(): TransportKind | undefined {
  try {
    const file = transportSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.transport === 'node' || parsed?.transport === 'chromium' ? parsed.transport : undefined
  } catch {
    return undefined
  }
}

export function writeTransportSetting(kind: TransportKind): void {
  const file = transportSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ transport: kind }, null, 2) + '\n', 'utf8')
}

export interface TransportState {
  /** 用户/配置要求的那一个 */
  requested: TransportKind
  /** 实际生效的那一个 */
  effective: TransportKind
  /** 要求 chromium 但环境不支持，已降级到 Node */
  degraded: boolean
  /** 本环境是否具备 Chromium 网络栈（Electron utility 进程里才有） */
  chromiumAvailable: boolean
}

/**
 * 决定实际用哪个。
 *
 * 降级只在**启动时**按能力判定（拿不到 `electron.net.fetch` 就用 Node），
 * **不做「请求失败后自动换一条重试」** —— 完成请求一旦重发可能就是一次重复生成，
 * 代价比"切错了手动改回来"大得多。
 */
export function resolveTransportState(requested: TransportKind): TransportState {
  const chromiumAvailable = electronNetFetch() !== undefined
  if (requested === 'chromium' && chromiumAvailable) {
    return { requested, effective: 'chromium', degraded: false, chromiumAvailable }
  }
  if (requested === 'chromium') {
    return { requested, effective: 'node', degraded: true, chromiumAvailable }
  }
  return { requested, effective: 'node', degraded: false, chromiumAvailable }
}

/** 把状态落到 webapi 的注入层（`undefined` 即还原为 Node 全局 fetch）。 */
export function applyTransportState(state: TransportState): void {
  setFetchImpl(state.effective === 'chromium' ? electronNetFetch() : undefined)
}

/** 读设置 → 解析 → 应用，一步到位。 */
export function applyTransport(requested: TransportKind): TransportState {
  const state = resolveTransportState(requested)
  applyTransportState(state)
  return state
}
