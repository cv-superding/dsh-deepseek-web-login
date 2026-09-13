/**
 * 浏览器侧的文件「打开 / 另存为」封装。
 *
 * 为什么需要单独一个模块：插件宿主跑在 Electron 的 **utility 进程**里，
 * 那里 `require('electron')` 只暴露 `net` 与 `systemPreferences`（见 net-diagnostics
 * 的能力探测），而 `dialog` 是**主进程**模块 —— 插件够不到。
 * 也就是说"弹一个系统文件框让人选"这件事，宿主侧做不到，
 * 只能由**渲染进程**（插件界面所在的地方）用 Chromium 自己的能力完成：
 *
 *   打开文件：`<input type="file">`  —— 任何 Chromium 都支持，最稳
 *   另存为：  `window.showSaveFilePicker()` —— File System Access API，Electron 有实现
 *   拿真实路径：`window.__DSH_DESKTOP_FILE_PATH__` —— DSH 注入的 preload 桥
 *              （`webUtils.getPathForFile`，注释写明"只解析操作者选中的、真实落盘的 File"）
 *
 * 三者都做**能力探测 + 优雅回退**，绝不把功能锁死：拿不到就走宿主侧写文件（旧行为），
 * 并如实说明回退原因。
 *
 * 关于「凭证要不要经过 HTTP」这件事的取舍，见 accounts.ts 里
 * `exportAccountsToFile` 与 `exportAccounts` 的注释 —— 那里有完整理由。
 */

/** DSH 注入的 preload 桥（宿主未注入时整个对象不存在）。 */
interface DesktopFilePathBridgeWindow {
  __DSH_DESKTOP_FILE_PATH__?: {
    /** 把用户**选中的** File 还原成真实磁盘路径；非磁盘来源的 File 会抛错。 */
    getPathForFile(file: File): string
  }
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<{
    name?: string
    createWritable: () => Promise<{ write: (data: Blob | string) => Promise<void>; close: () => Promise<void> }>
  }>
}

type Win = DesktopFilePathBridgeWindow & Record<string, any>

const win = (): Win => globalThis as unknown as Win

/**
 * 把界面选中的 File 还原成**真实磁盘路径**。
 *
 * 这一步的价值：拿到路径后，宿主可以**自己去读那个文件**，
 * 于是导入的凭证明文根本不经过 HTTP 请求体 —— 只是把"文件在哪"告诉宿主。
 * 桥不可用（宿主没注入 / 非磁盘来源的 File）就返回 undefined，调用方改用内容导入。
 */
export function resolvePickedPath(file: File | undefined | null, w: Win = win()): string | undefined {
  if (!file) return undefined
  try {
    const resolved = w.__DSH_DESKTOP_FILE_PATH__?.getPathForFile?.(file)
    return typeof resolved === 'string' && resolved.trim() ? resolved : undefined
  } catch {
    // 桥在、但这个 File 不是磁盘来源（比如拖进来的字符串）：不该因此把导入弄崩
    return undefined
  }
}

/** 渲染进程是否支持 File System Access 的「另存为」。 */
export function canSaveWithPicker(w: Win = win()): boolean {
  return typeof w?.showSaveFilePicker === 'function'
}

/**
 * 备份文件建议名。
 *
 * 刻意只用 **数字 / 字母 / 短横线 / 点**：这个字符串会进系统另存为框的
 * `suggestedName`，冒号、斜杠在 Windows 上是非法文件名字符（`toISOString()` 恰好
 * 带冒号，直接拿来当文件名会踩坑）。
 */
export function suggestedExportName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `deepseek-accounts-${stamp}.json`
}

export type SaveOutcome =
  | { kind: 'saved'; name: string }
  | { kind: 'cancelled' }
  /** 渲染进程没有 File System Access；调用方回退到宿主写文件。 */
  | { kind: 'unsupported' }
  /** 弹框过程本身失败（权限/平台差异等）；调用方回退并说明原因。 */
  | { kind: 'failed'; reason: string }

/** 用户取消选择时 Chromium 抛的是 AbortError，要和其他失败区分开（取消不是错误）。 */
export function isPickerCancel(error: unknown): boolean {
  return (error as any)?.name === 'AbortError'
}

/**
 * 弹系统「另存为」，并把 `produce()` 产出的文本写进用户选定的位置。
 *
 * ⚠️ 为什么收一个回调而不是直接收文本：**必须先弹框、再取内容**。
 * Chromium 的瞬时用户激活是有时限的，若调用方先 `await` 一次网络请求
 * （取备份内容）再弹框，很可能被判成"没有用户手势"而直接抛错。
 * 把取数包成回调，顺序就锁在这个函数里，调用方想写错都难。
 */
export async function saveWithPicker(
  suggestedName: string,
  produce: () => Promise<string>,
  w: Win = win(),
): Promise<SaveOutcome> {
  if (!canSaveWithPicker(w)) return { kind: 'unsupported' }
  // ⚠️ 要留住 writable 的引用（审计 F22）：`write`/`close` 失败时如果不 `abort`，
  // Chromium 会留下一个**未提交的临时文件与句柄**（模拟磁盘写满时实测 abort 从未被调用）。
  // 成功路径走完就把引用清掉，免得 catch 里对已关闭的 writable 再动手。
  let writable:
    | { write(data: Blob | string): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }
    | undefined
  try {
    const handle = await w.showSaveFilePicker!({
      suggestedName,
      types: [{ description: 'JSON 备份', accept: { 'application/json': ['.json'] } }],
    })
    const text = await produce()
    writable = await handle.createWritable()
    await writable.write(new Blob([text], { type: 'application/json' }))
    await writable.close()
    writable = undefined
    return { kind: 'saved', name: typeof handle?.name === 'string' && handle.name ? handle.name : suggestedName }
  } catch (error: any) {
    if (writable) {
      try {
        await writable.abort(error)
      } catch {}
    }
    if (isPickerCancel(error)) return { kind: 'cancelled' }
    return { kind: 'failed', reason: `${error?.name ?? ''} ${error?.message ?? error}`.trim() }
  }
}

/**
 * 弹系统「打开」框选一个 JSON。返回 undefined 表示用户取消。
 *
 * 用 `<input type="file">` 而不是 `showOpenFilePicker`：前者在**任何** Chromium
 * 环境里都可用（包括跨域 iframe，Chromium 150 起第三方 iframe 是被禁止弹
 * File System Access 文件框的），是我们最可靠的"让人选文件"手段。
 */
export function pickJsonFile(doc: Document = document): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = doc.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | undefined) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0]))
    // Chromium 113+ 在用户关掉选择框时会发 cancel；没这个事件的环境就靠它挂着
    input.addEventListener('cancel', () => finish(undefined))
    doc.body.appendChild(input)
    input.click()
  })
}

/** 导入文件的大小上限：与宿主侧一致（实测单账号 ~1.7 KB、账号数上限 500 → ~850 KB，
 *  取 2 MiB 留 2 倍余量）。两边都要有 —— 前端挡是为了不白传，宿主挡才是真边界。 */
export const IMPORT_FILE_LIMIT_BYTES = 2 * 1024 * 1024

export type ImportSource =
  /** 拿到了真实路径：宿主自己读文件，内容不进 HTTP。 */
  | { kind: 'path'; path: string; name: string }
  /** 没拿到路径：退回"界面读内容再交给宿主"。 */
  | { kind: 'content'; payload: unknown; name: string }
  | { kind: 'unreadable'; name: string; reason: string }

/**
 * 把用户选中的文件变成"宿主能用的东西"。
 *
 * 优先走路径（凭证不进 HTTP），拿不到路径才退回内容 —— 后者是必要的兜底：
 * 宿主没注入路径桥时功能不该整体失效。
 */
export async function readImportSource(file: File, w: Win = win()): Promise<ImportSource> {
  const name = file.name || '备份文件'
  // 前端先按大小挡一道（审计 F16）：与宿主侧的上限保持一致，避免白传一次才发现太大。
  if (typeof file.size === 'number' && file.size > IMPORT_FILE_LIMIT_BYTES) {
    return {
      kind: 'unreadable',
      name,
      reason: `文件 ${Math.ceil(file.size / 1024)} KiB，超过上限 ${Math.floor(IMPORT_FILE_LIMIT_BYTES / 1024 / 1024)} MiB`,
    }
  }
  const path = resolvePickedPath(file, w)
  if (path) return { kind: 'path', path, name }
  try {
    return { kind: 'content', payload: JSON.parse(await file.text()), name }
  } catch (error: any) {
    return { kind: 'unreadable', name, reason: `${error?.message ?? error}` }
  }
}
