/**
 * 诊断脚本共用：定位真机会话。
 *
 * 🔴 2026-10-03：这些脚本此前在**没有真机数据**的环境里直接崩（`readdirSync` 抛 ENOENT），
 * 于是「批跑」（`scripts/test-offline.mjs` 注入临时 `DSH_HOME`，CI 跑的也是批）必红。
 * 崩掉等于"这个探针没人维护了"却没人知道 —— 所以统一改成**优雅退出**。
 */
import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 会话根目录（`DSH_HOME` 优先）。 */
export function sessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/**
 * 全部真机会话目录（含 `session.v4.jsonl.zstd` 的才算）。
 * ⚠️ 目录不存在时返回**空数组**而不是抛错 —— 调用方据此优雅退出。
 */
export function listSessionDirs() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const g = join(root, group.name)
    for (const s of readdirSync(g, { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue
      if (existsSync(join(g, s.name, 'session.v4.jsonl.zstd'))) out.push(join(g, s.name))
    }
  }
  return out
}

/** 没数据时打印一句并正常退出（不当作失败）。 */
export function bailIfNoSessions(what = '这个检查需要真机会话日志') {
  const dirs = listSessionDirs()
  if (dirs.length === 0) {
    console.log(`跳过：${what}，但 ${sessionsRoot()} 下没有会话（沙箱环境属正常）。`)
    process.exit(0)
  }
  return dirs
}
