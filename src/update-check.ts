/**
 * 检查更新 —— 比对自身版本与 GitHub Releases 的 latest。
 *
 * 借鉴 workbuddy-switch 的「自动更新」。它是 Tauri 桌面 App，能签名校验后**整包升级**；
 * 我们是 DSH 插件，**装不了包**，所以只做"检查 + 告诉你 + 给链接"这一段。
 *
 * ⚠️ 三个必须守住的点：
 *  1. **短超时 + 优雅失败**：GitHub API 在国内常常连不上（或要走代理）。
 *     查更新失败绝不能把设置页卡住或让它报错 —— 失败就如实说"没查到"。
 *  2. **走当前传输层**：用插件自己的 fetch（默认 Chromium 网络栈），
 *     这样"系统代理开着"时也能跟着走，和网页端请求的环境一致。
 *  3. **只读**：只 GET 一个 releases 接口，不带任何凭证。
 */

/** 仓库地址（发布源）。 */
export const RELEASE_REPO = 'cv-superding/dsh-deepseek-web-login'

export interface UpdateCheckResult {
  ok: boolean
  /** 当前版本（调用方传入）。 */
  current: string
  /** 远端最新 tag（去掉前缀 v），取不到时为空。 */
  latest?: string
  /** 是否有新版本（能取到 latest 且严格大于 current 时为 true）。 */
  hasUpdate: boolean
  /** Release 页面链接。 */
  url?: string
  publishedAt?: string
  /** Release 说明的前几行（够用户判断要不要升级）。 */
  notes?: string
  /** 失败原因（网络不通 / 超时 / 限流…）。 */
  error?: string
  checkedAt: string
}

/** 把 `v1.2.3` / `1.2.3-beta.1` 解析成可比较的数字数组（只取前三段数字）。 */
export function parseVersion(input: string): number[] | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(input ?? '').trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** a 是否严格大于 b（无法解析时返回 false —— 宁可说"没有更新"）。 */
export function isNewer(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return false
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i]
  }
  return false
}

/**
 * 查一次最新版本。
 *
 * @param current 当前版本
 * @param fetchImpl 注入的 fetch（默认由宿主传入当前传输层）
 */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString()
  const base: UpdateCheckResult = { ok: false, current, hasUpdate: false, checkedAt }
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `${RELEASE_REPO}-plugin` },
      // 8 秒：国内连 GitHub 往往卡住而不是立刻失败，等太久会让界面以为点了没反应
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) {
      return { ...base, error: `GitHub 返回 HTTP ${response.status}${response.status === 403 ? '（可能是接口限流，稍后再试）' : ''}` }
    }
    const payload: any = await response.json()
    const tag = String(payload?.tag_name ?? '')
    const latest = tag.replace(/^v/, '')
    if (!latest) return { ...base, error: 'Release 数据里没有版本号' }
    return {
      ok: true,
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      ...(typeof payload?.html_url === 'string' ? { url: payload.html_url } : {}),
      ...(typeof payload?.published_at === 'string' ? { publishedAt: payload.published_at } : {}),
      ...(typeof payload?.body === 'string' ? { notes: payload.body.split('\n').slice(0, 6).join('\n') } : {}),
      checkedAt,
    }
  } catch (error: any) {
    const message = error?.name === 'TimeoutError' || /timeout|aborted/i.test(String(error?.message))
      ? '连接 GitHub 超时（国内常见；梯子开着的话它会跟随系统代理）'
      : `连接 GitHub 失败：${error?.message ?? error}`
    return { ...base, error: message }
  }
}
