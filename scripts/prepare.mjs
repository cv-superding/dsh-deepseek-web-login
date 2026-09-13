#!/usr/bin/env node
// git/path 安装时的 prepare 兜底：lib/ 缺失则构建一次。
//
// 审计 F20：这里原来在缺依赖时走 npx 兜底（联网下载 + 版本范围），
// 改成调用同一个跨平台构建脚本 —— 只有一份实现，也只有在装好开发依赖时才会成功。
// 注意：真正的 npm 安装路径上 `prepare` 会被 npm 以 --ignore-scripts 跳过（CI 里就是），
// 这里主要服务"从 git/path 直接装"的场景。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

if (existsSync(join(ROOT, 'lib', 'index.js')) && existsSync(join(ROOT, 'lib', 'client.js'))) {
  console.log('[prepare] lib/ already built — skipping')
  process.exit(0)
}

const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
})
process.exit(result.status ?? 1)
