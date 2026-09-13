#!/usr/bin/env node
/**
 * 跨平台构建入口（审计 F20）。
 *
 * 为什么不用原来的 `bash scripts/build.sh`：Windows 上只装了 Node/npm、没有 Bash 时
 * `npm run build` 会直接失败（构建脚本本身没毛病，问题是它要求一个 Unix shell）。
 * 这里用 Node 直接起本地 tsdown 的 CLI，全程不经过 shell。
 *
 * 为什么不再用「npx 兜底」取工具：
 *   - 缺依赖时会**联网下载** → 断网就构建不了；
 *   - 版本写的是范围，同一份源码在不同时间可能解析到不同的依赖树（不可复现）。
 * 现在只认本地已安装的 tsdown（`npm ci` 装的），缺了就明确报错并给出命令。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 从已安装的 tsdown 包里找出 CLI 入口（不依赖 .bin 软链，Windows 上更稳）。 */
function findTsdownBin() {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('tsdown/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsdown
  if (!bin) throw new Error('tsdown 的 package.json 里找不到 CLI 入口（bin.tsdown）')
  return { version: pkg.version, path: resolve(dirname(manifest), bin) }
}

const libDir = join(ROOT, 'lib')
try {
  const tsdown = findTsdownBin()
  const result = spawnSync(process.execPath, [tsdown.path, '--config', 'tsdown.config.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    // shell: false —— 不经过 cmd.exe / bash，路径里有空格也不会被拆开
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else {
    console.log(`[build] tsdown ${tsdown.version} 构建完成，产物：`)
    if (existsSync(libDir)) {
      for (const name of readdirSync(libDir).sort()) {
        if (!name.endsWith('.js')) continue
        const size = statSync(join(libDir, name)).size
        console.log(`  ${name.padEnd(12)} ${(size / 1024).toFixed(1)} KB`)
      }
    }
  }
} catch (error) {
  console.error('[build] 构建失败：找不到可用的本地 tsdown。')
  console.error('[build] 请先在包目录执行 npm ci 安装开发依赖（本脚本不会联网下载工具）。')
  console.error(`[build] 原因：${error?.message ?? error}`)
  process.exitCode = 1
}
