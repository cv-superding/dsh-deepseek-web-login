#!/usr/bin/env node
// git/path 安装时的 prepare 兜底：lib/ 缺失则用 tsdown 构建（同 build.sh）。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

if (existsSync(join(ROOT, 'lib', 'index.js')) && existsSync(join(ROOT, 'lib', 'client.js'))) {
  console.log('[prepare] lib/ already built — skipping')
  process.exit(0)
}

const localBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
const result = existsSync(localBin)
  ? spawnSync(localBin, ['--config', 'tsdown.config.ts'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  : spawnSync('npx', ['--yes', 'tsdown@^0.22.14', '--config', 'tsdown.config.ts'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(result.status ?? 1)
