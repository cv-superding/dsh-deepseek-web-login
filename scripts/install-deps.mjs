#!/usr/bin/env node
/**
 * 安装开发依赖（审计 F20）：CI 与 release 共用这一个入口。
 *
 * 为什么不在 YAML 里直接写 `npm ci`：
 *   - 有 `package-lock.json` 时用 `npm ci --ignore-scripts`（按锁文件装，可复现）；
 *   - 还没有锁文件时 `npm ci` 会**直接失败**，所以要回退到 `npm install` ——
 *     并且把这件事打印出来，而不是静默降级（它意味着构建不完全可复现）。
 * 判断逻辑放在 Node 里而不是 YAML 里，是为了不依赖 Bash（Windows runner 也能跑）。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const hasLock = existsSync(join(ROOT, 'package-lock.json'))

if (!hasLock) {
  console.warn('[install-deps] 未找到 package-lock.json —— 回退到 npm install（构建不完全可复现）。')
  console.warn('[install-deps] 生成锁文件的命令：npm install --package-lock-only')
}

const args = hasLock
  ? ['ci', '--ignore-scripts']
  : ['install', '--ignore-scripts', '--no-audit', '--no-fund']

console.log(`[install-deps] npm ${args.join(' ')}`)
const result = spawnSync('npm', args, {
  cwd: ROOT,
  stdio: 'inherit',
  // npm 在 Windows 上是 npm.cmd，Node 不允许不带 shell 直接起 .cmd
  shell: process.platform === 'win32',
})
if (result.error) {
  console.error(`[install-deps] 失败：${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
