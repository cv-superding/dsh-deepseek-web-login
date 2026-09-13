#!/usr/bin/env node
/**
 * 全量离线用例（审计 F20）。
 *
 * 只跑**不需要网络与账号**的用例（清单见 scripts/test-files.mjs）。
 * 明确排除 `probe-*.mjs` —— 那几个会打真实接口、需要有效账号，属于人工诊断工具。
 *
 * 为什么要有这个入口：CI 之前只写了 7 个测试文件名，手工维护容易漏；
 * 而"漏跑"的代价在这一轮审计里已经出现过多次（改了源码但没跑全量，回归晚几天才发现）。
 * 这里按文件名扫全量，新增用例自动纳入。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickOfflineTests } from './test-files.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(ROOT, 'tests')
const files = pickOfflineTests(testsDir)

const failed = []
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [join(testsDir, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    // 单个文件的上限：超过说明有东西挂住了（而不是"慢"）
    timeout: 180_000,
  })
  if (result.error || result.status !== 0) {
    failed.push(file)
    console.error(`FAIL ${file}${result.error ? `：${result.error.message}` : ''}`)
  }
}

console.log(`\n[test] ${files.length - failed.length}/${files.length} 个用例文件通过`)
if (failed.length) {
  for (const file of failed) console.log(`  FAIL ${file}`)
  process.exitCode = 1
}
