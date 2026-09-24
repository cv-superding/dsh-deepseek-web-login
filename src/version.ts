/**
 * 本插件版本号 —— 单一事实来源是 `package.json`，这里做一层运行时读取 + 兜底常量。
 *
 * 为什么要兜底常量：`package.json` 相对 `lib/index.js` 在上一级目录，
 * 正常安装（作为 npm 包）一定在；但 bunder/注入式装配不一定。
 * 兜底常量与 package.json 的一致性由 `tests/check-smoke.mjs` 守着，不会漂。
 */
import { readFileSync } from 'node:fs'

/** 与 package.json 保持一致的兜底版本（由测试保证不会漂）。 */
export const FALLBACK_VERSION = '0.2.2'

let cached: string | undefined

/** 本插件版本（如 `0.1.26`）。 */
export function pluginVersion(): string {
  if (cached) return cached
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.version === 'string' && parsed.version) {
      cached = parsed.version
      return cached
    }
  } catch {}
  cached = FALLBACK_VERSION
  return cached
}
