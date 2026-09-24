#!/usr/bin/env node
/**
 * 生成「开发副本」包：把当前 lib/ 复制成 ../<name>-dev<N>，并改写 package.json 的 name。
 *
 * 为什么需要：当前 DSH 版本（0.1.2-rc.1）移除了 loader 热重载所需的 API，
 * 且 Node ESM 模块缓存以「解析后的文件路径」为键 —— 同一路径重新注入仍会命中
 * 旧模块实例（实测：改了 lib/index.js 再注入，运行时仍是旧对象）。
 * 因此迭代时改用新包名/新路径注入，卸载即净；正式交付仍用本目录原名。
 *
 * 用法：node scripts/make-dev-copy.mjs [suffix]    → 输出副本目录绝对路径
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const suffix = process.argv[2] || `dev${Date.now().toString(36).slice(-4)}`
const name = `${base.name}-${suffix}`
const target = resolve(ROOT, '..', name)

// R9（0.2.0）：先**校验全部源产物**再动旧目录 —— 旧写法"先删后校"，
// 产物缺失时旧副本已经被删了才报错，留下"想回退也没得回退"的窗口。
for (const file of ['lib/index.js', 'lib/client.js']) {
  if (!existsSync(join(ROOT, file))) {
    console.error(`[dev-copy] 缺少构建产物 ${file} —— 先跑构建（旧副本未动）`)
    process.exit(1)
  }
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, 'lib'), { recursive: true })

for (const file of ['lib/index.js', 'lib/client.js']) {
  copyFileSync(join(ROOT, file), join(target, file))
}
copyFileSync(join(ROOT, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))

const pkg = { ...base, name }
delete pkg.scripts
delete pkg.devDependencies
pkg.description = `${base.description}（开发副本 ${suffix}）`
writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2))
writeFileSync(
  join(target, 'README.md'),
  `开发副本（${name}）—— 由 scripts/make-dev-copy.mjs 生成，用于绕过当前 DSH 版本的模块缓存热迭代。\n正式交付目录：${ROOT}\n`,
)

console.log(target)
