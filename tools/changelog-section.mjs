#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里取出指定版本的段落（发布说明复用 CHANGELOG，避免两处维护）。
 *
 *   node tools/changelog-section.mjs 0.1.3
 *
 * 找不到该版本时输出一行兜底说明并正常退出（不让发布流程挂掉）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = (process.argv[2] ?? '').replace(/^v/, '').trim()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (!version) {
  console.error('用法: node tools/changelog-section.mjs <版本号，如 0.1.3>')
  process.exit(1)
}

let changelog = ''
try {
  changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
} catch (error) {
  console.log(`CHANGELOG.md 读取失败：${error.message}`)
  process.exit(0)
}

const lines = changelog.split('\n')
const start = lines.findIndex((line) => new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`).test(line))
if (start === -1) {
  console.log(`详见 CHANGELOG.md。安装：\`dsh plugin add ./dsh-deepseek-web-login-${version}.tgz\``)
  process.exit(0)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}
console.log(lines.slice(start + 1, end).join('\n').trim())
