/**
 * 「登录新账号（添加）」的**添加模式**。
 *
 * 为什么需要这个标志：所有捕获路径最后都会走 `writeAuth()`，而它的语义是
 * "写入并**设为当前**"。但"往账号库里再加一个账号"的语义是
 * **入库、但不打扰当前正在用的那个号** —— 这两件事必须分开，
 * 否则用户每加一个账号，正在用的号就被顶掉了（添加完还得手动切回来）。
 *
 * 所以：点「登录新账号」→ `beginAddAccount()` → 下一次捕获走 `commitCapturedAuth()`，
 * 它只 `upsertAccount()`（入库），不 `setActiveAccount()`（不切换）。
 *
 * 两个安全约束：
 *  1. **一次有效**：无论成功失败，`commitCapturedAuth()` 都会消费掉这个标志，
 *     绝不让它泄漏到后面某个无关的捕获上去。
 *  2. **有期限**：登录窗口可能被用户丢在那儿不管，所以超过 TTL 自动失效
 *     （否则十分钟后你随手粘个 token，会莫名其妙变成"只入库不切换"）。
 *
 * ⚠️ 注意：`/status` 里那次"补全账号展示信息"的写回**不走这里**（见 index.ts 的注释）——
 * 那是对**当前账号**的元数据刷新，不是新捕获，让它消费掉添加模式会是个 bug。
 */
import { activeAccountId, listAccounts, setActiveAccount, upsertAccount } from './accounts.ts'
import { writeAuth, type WebAuth } from './auth.ts'

/** 添加模式的有效期：够用户走完一次登录窗口，又不至于久到误伤后续操作。 */
export const ADD_MODE_TTL_MS = 15 * 60_000

let startedAt: number | null = null

/** 进入添加模式（点「登录新账号」时调用）。 */
export function beginAddAccount(now: number = Date.now()): void {
  startedAt = now
}

/** 当前是否处于添加模式（超时即失效并自行清除）。 */
export function addModeActive(now: number = Date.now()): boolean {
  if (startedAt === null) return false
  if (now - startedAt > ADD_MODE_TTL_MS) {
    startedAt = null
    return false
  }
  return true
}

/** 退出添加模式（捕获完成 / 用户又点了退出或切换 —— 那些是明确的"改当前账号"动作）。 */
export function endAddAccount(): void {
  startedAt = null
}

export interface CommitResult {
  /** `add` = 只入库不切换；`switch` = 写入并设为当前（默认语义）。 */
  mode: 'add' | 'switch'
  /** 仅 add 模式：这次捕获的账号是不是**新**的（false = 库里本来就有）。 */
  created?: boolean
  /**
   * 这次凭证落到了哪条记录上。调用方拿到它就能把"校验回来的身份信息"补写回去 ——
   * 否则新加的账号在列表里只能显示内部 id（`acc_xxxxxxxx`），要等下一次探活才有名字。
   */
  recordId?: string
}

/**
 * 捕获到凭证后的统一落库动作。
 *
 * 默认（非添加模式）：`writeAuth()` —— 写入并设为当前，行为与以前完全一致。
 * 添加模式：`upsertAccount()` —— 只入库；当前账号**原样不动**。
 */
export function commitCapturedAuth(auth: WebAuth, now: number = Date.now()): CommitResult {
  if (!addModeActive(now)) {
    writeAuth(auth)
    const active = activeAccountId()
    return { mode: 'switch', ...(active ? { recordId: active } : {}) }
  }
  const before = new Set(listAccounts().map((item) => item.id))
  const hadActive = activeAccountId() !== undefined
  const record = upsertAccount(auth)
  // 边界：库里本来一个当前账号都没有（比如刚才退出过又直接点「登录新账号」）——
  // 这时没人会被"打扰"，不设当前反而会留下"库里有账号却没选中"的状态。
  // 这不违反"添加不自动切换"：那条规则针对的是**别顶掉正在用的号**。
  if (!hadActive) setActiveAccount(record.id)
  endAddAccount()
  return { mode: 'add', created: !before.has(record.id), recordId: record.id }
}
