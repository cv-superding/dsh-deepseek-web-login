/**
 * 账号分组：组定义落盘 + 列表按组分区。
 *
 * ── 为什么要单独一个文件，而不是把组名写进每条账号记录 ──
 *
 * 1. 组要能**改名** —— 写进账号记录的话，改一次要遍历所有账号文件；
 * 2. 组要能**排序** —— 否则"组之间"照样乱（这次要解决的正是"顺序不受控"）；
 * 3. 账号记录里只留一个 `groupId` 指针 ⇒ 删组不会留下散落的组名，也不会误删账号。
 *
 * 因此分工是：`groups.json` 存**组的定义**（id / name / order），
 * 账号记录里只存 `groupId`。**组不存在（被删了）或没设组的账号 ⇒ 一律归入「未分组」**，
 * 一个都不会从列表里消失。
 *
 * 纯函数（normalizeGroupList / createGroup / renameGroup / removeGroup / partitionByGroup）
 * 不碰磁盘，便于单测；读写只有 readGroups / writeGroups 两个口子。
 *
 * ⚠️ 分组的定位是**只影响显示**：切号、会话复用槽、会话清理一律不感知组。
 * 让分组参与调度会把"插件什么时候建会话/删会话"变得难以预测，收益却很小。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webLoginDir } from './paths.ts'

export interface AccountGroup {
  id: string
  name: string
  /** 组之间的显示顺序（越小越靠前）。当前账号所在的组会被提到最前，见 partitionByGroup。 */
  order: number
}

/** 分区结果。`key` 可直接当 DOM 的 key 用（`__ungrouped__` 表示未分组）。 */
export interface GroupSection<T> {
  key: string
  name: string
  /** null = 未分组（DSH 面板据此决定要不要画"移出组"之类的入口）。 */
  groupId: string | null
  accounts: T[]
}

/** 未分组的伪组 key（不会与真实组 id 冲突：真实 id 一律以 `g_` 开头）。 */
export const UNGROUPED_KEY = '__ungrouped__'
export const UNGROUPED_NAME = '未分组'

/** 组名上限（够写「工作号-主力」这种），也顺带挡住把整段话粘进来。 */
export const MAX_GROUP_NAME = 20
/** 组数量上限：分组是给人看的，超过这个数只会更难找。 */
export const MAX_GROUPS = 12

export function groupsFilePath(): string {
  return join(webLoginDir(), 'groups.json')
}

/**
 * 规整组名：去首尾空白、把连续空白折成一个空格、去掉换行与控制字符、截断到上限。
 *
 * 为什么要去掉换行：组名会进 `title` / `option` 这类文本节点，带换行的名字在界面上会撑破一行，
 * 而且用户从别处粘贴时很容易把换行一起带进来。
 */
export function normalizeGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GROUP_NAME)
}

/**
 * 读盘容错：只收形状正确的条目，丢掉的坏数据**不会**让整个分组表读不出来。
 *
 * 与账号记录的姿态一致（那边也是"形状不对的条目丢掉、不让整条记录失败"）：
 * 分组只是展示辅助，宁可少显示一个组，也不要因为一条脏数据让面板报错。
 * 读回后按 order 重排（顺序值可能是手改过的、重复的、非整数的）。
 */
export function normalizeGroupList(raw: unknown): AccountGroup[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AccountGroup[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof (item as any).id === 'string' ? (item as any).id.trim() : ''
    const name = normalizeGroupName((item as any).name)
    if (!id || !name || seen.has(id)) continue
    const orderRaw = (item as any).order
    const order = Number.isFinite(orderRaw) ? Number(orderRaw) : out.length
    seen.add(id)
    out.push({ id, name, order })
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return out.slice(0, MAX_GROUPS).map((group, index) => ({ ...group, order: index }))
}

export function readGroups(): AccountGroup[] {
  try {
    const file = groupsFilePath()
    if (!existsSync(file)) return []
    return normalizeGroupList(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

export function writeGroups(list: AccountGroup[]): void {
  const file = groupsFilePath()
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(normalizeGroupList(list), null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (error) {
    // rename 失败时清掉临时文件，**原文件保持完好**（不先删目标 —— 那是丢数据的风险点）
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清不掉就算了，下次写会覆盖 */
    }
    throw error
  }
}

export function newGroupId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let i = 0; i < 32; i += 1) {
    const id = `g_${randomBytes(4).toString('hex')}`
    if (!used.has(id)) return id
  }
  return `g_${randomBytes(6).toString('hex')}`
}

/**
 * 新建组。名字为空 / 重名 / 超过组数上限时返回 `error`（不改动 `list`）。
 *
 * 重名判定用**规整后的名字**：`" 工作 "` 与 `"工作"` 算同一个，免得界面上出现两个看起来一样的组。
 */
export function createGroup(list: AccountGroup[], rawName: unknown): { list: AccountGroup[]; group?: AccountGroup; error?: string } {
  const current = normalizeGroupList(list)
  const name = normalizeGroupName(rawName)
  if (!name) return { list: current, error: '组名不能为空' }
  if (current.length >= MAX_GROUPS) return { list: current, error: `最多 ${MAX_GROUPS} 个组` }
  if (current.some((group) => group.name === name)) return { list: current, error: `已经有一个叫「${name}」的组了` }
  const group: AccountGroup = { id: newGroupId(current.map((item) => item.id)), name, order: current.length }
  return { list: [...current, group], group }
}

export function renameGroup(list: AccountGroup[], id: string, rawName: unknown): { list: AccountGroup[]; error?: string } {
  const current = normalizeGroupList(list)
  const name = normalizeGroupName(rawName)
  if (!name) return { list: current, error: '组名不能为空' }
  if (!current.some((group) => group.id === id)) return { list: current, error: '组不存在' }
  if (current.some((group) => group.id !== id && group.name === name)) {
    return { list: current, error: `已经有一个叫「${name}」的组了` }
  }
  return { list: current.map((group) => (group.id === id ? { ...group, name } : group)) }
}

/**
 * 删除组定义。
 *
 * ⚠️ **只删组、不删账号**：账号记录里的 `groupId` 会变成一个"指向不存在组"的悬挂指针，
 * 而 `partitionByGroup` 对这种情况的处理就是把它归入「未分组」——
 * 所以调用方不需要（也不应该）去逐个改账号文件。
 */
export function removeGroup(list: AccountGroup[], id: string): AccountGroup[] {
  const current = normalizeGroupList(list)
  const kept = current.filter((group) => group.id !== id)
  return kept.map((group, index) => ({ ...group, order: index }))
}

export interface GroupableAccount {
  id: string
  groupId?: string
}

/**
 * 把账号切成「按组分区」的若干段，供面板直接渲染。
 *
 * 排序规则（用户 2026-09-16 明确要的）：
 *  1. **当前账号所在的组置顶** —— 常用号不因为新加账号而沉下去；
 *  2. 其余组按 `order`；
 *  3. **未分组垫底**（含 `groupId` 指向已删除组的账号）。
 *
 * 组内顺序**保持传入顺序**（`listAccounts()` 已按捕获时间倒序），不再排序 ——
 * 组的意义是"分类"，组内再按捕获时间排就是用户熟悉的既有行为。
 *
 * 空组**照样返回**：新建完组要能立刻看见它，否则"建了组却没反应"。
 * 未分组为空时**不返回**（没意义的一行）。
 */
export function partitionByGroup<T extends GroupableAccount>(
  accounts: T[],
  groups: AccountGroup[],
  activeId: string | null | undefined,
): GroupSection<T>[] {
  const normalized = normalizeGroupList(groups)
  const known = new Set(normalized.map((group) => group.id))
  const buckets = new Map<string, T[]>()
  const ungrouped: T[] = []
  for (const account of accounts) {
    const gid = account.groupId && known.has(account.groupId) ? account.groupId : ''
    if (!gid) {
      ungrouped.push(account)
      continue
    }
    const bucket = buckets.get(gid)
    if (bucket) bucket.push(account)
    else buckets.set(gid, [account])
  }

  const activeGroupId = accounts.find((account) => account.id === activeId)?.groupId ?? ''
  const pinned = activeGroupId && known.has(activeGroupId) ? activeGroupId : ''

  const sections: GroupSection<T>[] = []
  const ordered = pinned
    ? [...normalized.filter((group) => group.id === pinned), ...normalized.filter((group) => group.id !== pinned)]
    : normalized
  for (const group of ordered) {
    sections.push({ key: group.id, name: group.name, groupId: group.id, accounts: buckets.get(group.id) ?? [] })
  }
  if (ungrouped.length) {
    sections.push({ key: UNGROUPED_KEY, name: UNGROUPED_NAME, groupId: null, accounts: ungrouped })
  }
  return sections
}
