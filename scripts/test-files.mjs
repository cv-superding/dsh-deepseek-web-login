/**
 * 全量离线用例清单（审计 F20）。
 *
 * 单独放一个模块是为了**能被测试**：`probe-*.mjs` 会打真实接口、需要有效账号，
 * 一旦被误纳入自动化，就要拿真账号去跑 —— 这条边界值得有一条断言守着。
 * `scripts/test-offline.mjs` 与 tests/check-round2.mjs 共用这里的实现。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 返回该目录下应当由自动化执行的用例文件名（已排序）。
 * 只认 `check-*.mjs` 与 `logic-test.mjs`。
 */
export function pickOfflineTests(testsDir) {
  const names = readdirSync(testsDir)
  const files = names.filter((name) => /^check-.*\.mjs$/.test(name)).sort()
  if (names.includes('logic-test.mjs')) files.push('logic-test.mjs')
  return files
}

/** 是否为"需要真实网络/账号"的人工诊断脚本（自动化必须排除）。 */
export function isManualProbe(name) {
  return /^probe-.*\.mjs$/.test(name) || /probe/i.test(name)
}

export function resolveTestPaths(root, files) {
  return files.map((name) => join(root, 'tests', name))
}
