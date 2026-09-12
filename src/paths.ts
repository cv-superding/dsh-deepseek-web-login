/**
 * 路径解析 —— 单独成文件，避免 auth.ts ↔ accounts.ts 互相 import 形成环。
 *
 * 约定：插件的所有本地状态都放在 `${DSH_HOME || ~/.dsh}/web-login/` 下，
 * **不进 settings/credentials 缝合口** —— 那里是通用配置面，不适合放网页端凭证。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 主目录（与生态一致的解析顺序）。 */
export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件自己的状态目录。 */
export function webLoginDir(): string {
  return join(resolveDshHome(), 'web-login')
}

/**
 * 旧版单账号凭证文件（0.1.25 及以前只有这一个账号）。
 * 现在改为账号库，但**这个路径仍然要认得** —— 用来做一次性迁移。
 */
export function legacyAuthFilePath(): string {
  return join(webLoginDir(), 'deepseek-auth.json')
}
