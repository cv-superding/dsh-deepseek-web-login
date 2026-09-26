/**
 * 自动切换账号 —— **纯逻辑**（不碰 fs、不碰网络，便于单测）。
 *
 * 定位：按时间把当前账号轮换到下一个，让每个账号分到的请求都变少（摊薄单账号密度）。
 *
 * ⚠️ 它不是"一被限流就自动换号"。两者的差别是方向性的：
 *   - 定时均衡轮换 ⇒ 每个号的密度都斜下来，是**分散**；
 *   - 遇限流就换   ⇒ 同一个出口 IP 上多号交替活跃，反而更像"有组织的规避"，是**加剧**。
 * 所以这里**只看时间**；受限的账号会被跳过（它本来就用不了），但不会因为它受限就提前切。
 *
 * 真正的执行在宿主（`index.ts` 的切号钩子）：它才有探活与 `setActiveAccount`。
 * 本模块只回答两个问题：**该不该切**、**切给谁**。
 */

/**
 * 本模块只描述它关心的字段 —— 刻意**不 import `accounts.ts`**。
 *
 * 理由：那边依赖 `node:fs`，而本项目有过"浏览器产物被 node 模块带崩"的前科
 * （见账号分组那段的注释）。用最小结构类型（鸭子类型）既避开这个坑，
 * 也让本模块在单测里可以纯粹用字面量构造输入。
 */
export interface SwitchableAccount {
  id: string
  /** 登录态失效标记（探活失败留下的）。有值 ⇒ 切过去必然失败，不选它。 */
  lastVerifyError?: { at: string; message: string }
  /** 观测到的账号级限制。`untilMs > now` 表示还在受限窗口里。 */
  limit?: { untilMs: number; observedAt: string }
}

/** 这个账号**现在**能用吗（未失效、未受限）。 */
export function isUsable(account: SwitchableAccount, now: number): boolean {
  if (account.lastVerifyError) return false
  const until = Number(account.limit?.untilMs)
  if (Number.isFinite(until) && until > now) return false
  return true
}

/**
 * 到点了吗。
 *
 * `lastSwitchAt` 由调用方负责给一个有意义的起点（插件启动时刻、或用户上次手动切号的时刻），
 * 并**每次成功切换后刷新** —— 否则用户刚手动切完，1 分钟后又被自动切走。
 * 没有起点（≤ 0）时**不切**：宁可不动，也不要在不知道"已经用了多久"的情况下贸然换号。
 */
export function isSwitchDue(minutes: number, lastSwitchAt: number, now: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  if (!Number.isFinite(lastSwitchAt) || lastSwitchAt <= 0) return false
  return now - lastSwitchAt >= minutes * 60_000
}

/**
 * 挑下一个可切换的账号。
 *
 * 规则：先滤掉不可用的，再取**当前账号之后的第一个**（走到末尾绕回开头）。
 *
 * 为什么是"当前账号的下一个"而不是"每次都取第一个可用的"：
 *   后者会让列表里的第二个账号成为唯一被切到的目标，其余永远不动 —— 那还是集中，不是分散。
 *
 * 边界：
 *   - 一个可用的都没有 ⇒ undefined（不切）
 *   - 当前账号自己不可用（失效/受限）⇒ 取第一个可用的（这是"救急"路径，本来就该切走）
 *   - 可用的只有当前这一个 ⇒ undefined（切了还是它，没意义）
 */
export function pickNextAccount(
  accounts: readonly SwitchableAccount[],
  currentId: string | undefined,
  now: number,
): string | undefined {
  const usable = accounts.filter((account) => isUsable(account, now))
  if (usable.length === 0) return undefined
  const index = usable.findIndex((account) => account.id === currentId)
  if (index < 0) return usable[0]?.id
  if (usable.length === 1) return undefined
  return usable[(index + 1) % usable.length]?.id
}

/** 决策结果 —— 带 reason 是为了让日志能说清"这次为什么没切"。 */
export type AutoSwitchDecision =
  | { action: 'switch'; nextId: string; reason: 'due' | 'current-unusable' }
  | {
      action: 'skip'
      reason: 'off' | 'not-due' | 'no-candidate' | 'no-other-account'
    }

/**
 * 把上面两个函数合成一次决策。
 *
 * 「当前账号不可用」是**例外优先**的：哪怕没到点也要切走 —— 让用户在一个失效的账号上
 * 继续等满 N 分钟是没有意义的（每个请求都会失败）。这也正好把"自动切号"和
 * "失效账号自动救急"合并成一条路径，不用两套逻辑。
 */
export function decideAutoSwitch(params: {
  minutes: number
  lastSwitchAt: number
  now: number
  accounts: readonly SwitchableAccount[]
  currentId: string | undefined
}): AutoSwitchDecision {
  const { minutes, lastSwitchAt, now, accounts, currentId } = params
  if (!Number.isFinite(minutes) || minutes <= 0) return { action: 'skip', reason: 'off' }

  const current = accounts.find((account) => account.id === currentId)
  const currentUnusable = current !== undefined && !isUsable(current, now)
  // 注意：当前账号**不在库里**（可能刚被移除）时不算 unusable —— 那种情况下
  // 让既有的"无账号 ⇒ 报错提示登录"路径去处理，别在这里悄悄换号。
  if (!currentUnusable && !isSwitchDue(minutes, lastSwitchAt, now)) {
    return { action: 'skip', reason: 'not-due' }
  }

  const nextId = pickNextAccount(accounts, currentId, now)
  if (!nextId) {
    return {
      action: 'skip',
      reason: accounts.filter((account) => isUsable(account, now)).length === 0 ? 'no-candidate' : 'no-other-account',
    }
  }
  return { action: 'switch', nextId, reason: currentUnusable ? 'current-unusable' : 'due' }
}
