/**
 * 账号库的「什么时候该重读」判据 + 内容签名（纯函数，无依赖，便于单测）。
 *
 * ── 为什么要单独有这么一个模块（2026-09-15 用户反馈）──
 *
 * 现象：**新登录一个账号后，账号库列表不会自己更新**，要关掉设置页再打开才看得到。
 *
 * 根因：账号库列表**不在状态轮询（`/status`）里**。面板每 2 秒轮询一次，但只读
 * `/status` 并渲染**当前账号**的信息；列表本身只有 `loadAccounts()` 被显式调用的那几个
 * 时刻才重读（面板初始化 / 切号 / 移除 / 重命名 / 重新登录 / 添加 / 导入）。
 *
 * 而登录捕获**是异步落地的**：
 *  - CDP 那条路（宿主在 utility 进程时的常态）要等用户在浏览器里登录完；
 *  - 能开 Electron 窗口那条路更直接 —— `openLoginWindow()` 是"开窗即返回"，
 *    捕获发生在响应之后。
 * ⇒ 「加完账号」的捕获很可能晚于那次 `loadAccounts()`，列表就停在旧快照上，
 *   而且**此后不会再更新**（轮询不碰账号库）。
 *
 * 最直接的证据是代码里一句注释（client 的「登录新账号」处理里）：
 *   「期间保持轮询更密一点，万一捕获是异步落地的也能及时刷出来」
 * —— 作者本来就指望轮询兜住这件事，但轮询只读 `/status`，那个兜底**从未生效**。
 *
 * 同源的第二个缺口：探活会更新记录（补上账号名、限制状态、失败标记），
 * 而**账号名是捕获之后由校验拿到的**（见 index.ts 里那段回写），
 * 所以"列表里只有一串 `acc_xxxxxxxx`"这件事也要等下一次刷新才消失。
 *
 * 所以修法是：把轮询的兜底做成真的 —— 按下面的节拍重读 `/accounts`，
 * 并用 `accountsSignature()` 判断内容是否真的变了（没变就不重建 DOM，
 * 免得每几秒把用户正在点的按钮换掉）。
 */

/** 登录流程进行中（窗口开着 / 刚操作过）的重读间隔：够快，用户看不到"没更新"。 */
export const ACCOUNTS_SYNC_ACTIVE_MS = 3_000

/** 空闲时的重读间隔：只为让探活补上的账号名 / 限制状态 / 失败标记自己出现，不必太快。 */
export const ACCOUNTS_SYNC_IDLE_MS = 30_000

/**
 * 现在该不该重读账号库。
 *
 * @param now 当前时间戳
 * @param lastSyncedAt 上次重读的时刻（从未读过传 0）
 * @param active 登录流程是否进行中（窗口开着，或在操作后的加速窗口内）
 */
export function shouldSyncAccounts(now: number, lastSyncedAt: number, active: boolean): boolean {
  const gap = active ? ACCOUNTS_SYNC_ACTIVE_MS : ACCOUNTS_SYNC_IDLE_MS
  return now - lastSyncedAt >= gap
}

/**
 * 账号库响应的内容签名 —— 变了才重建列表。
 *
 * 只取**界面真正渲染的东西**（账号数组 + 分组定义 + 分组分区 + 当前账号 id），不取 `footprint`：
 * 后者是给台账页用的文件统计，跟列表无关，把它算进来只会平白触发重建。
 *
 * ⚠️ `groups` / `sections` 必须是**顶层字段显式列进来**：整包 stringify 只覆盖这里写出的键，
 * 漏一个就会出现"新建了组、列表却不刷新"—— 与 0.1.63（读错字段名）和 0.1.67（数据压根不在
 * `/status` 里）是同一类坑：**界面渲染什么，签名就得覆盖什么。**
 *
 * 整包 `JSON.stringify` 而不是逐个字段挑：**按构造就是完整的** ——
 * 将来 `/accounts` 多返回一个会被渲染的字段，这里不用改也不会漏。
 * （代价：若哪天往 accounts 里塞了每调用一次都不同的值，会变成每轮都重建；
 *  真出现那种字段，应该在这里显式排除。）
 */
export function accountsSignature(payload: unknown): string {
  const data = (payload ?? {}) as { activeId?: unknown; accounts?: unknown; groups?: unknown; sections?: unknown }
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  const groups = Array.isArray(data.groups) ? data.groups : []
  const sections = Array.isArray(data.sections) ? data.sections : []
  try {
    return JSON.stringify({ activeId: data.activeId ?? null, accounts, groups, sections })
  } catch {
    // 序列化失败时给空串：调用方约定"空签名 = 每次都重建"，宁可重建也别卡住不更新
    return ''
  }
}
