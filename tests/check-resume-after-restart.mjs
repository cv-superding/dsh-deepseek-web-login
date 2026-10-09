/**
 * 0.6.43：DSH 重启后必须**续上同一对话线**。
 *
 * ## 为什么要有这条
 *
 * 2026-10-09 用户实锤：「我就只聊了一个会话窗口」，网页端却多出第二个窗口、
 * 且对话线上出现「修改 / 重新生成」+ `n / n`。现场：
 *   15:08:56 会话A `entries=138` →（重启）→ 15:15:32 会话B `entries=140`
 * **entriesLen 连续** = 同一条对话线被迫换了会话。
 *
 * 根因：`reuseSlots` 与 `contextChains` 都是**纯内存 `Map`、零持久化**
 * ⇒ 重启即空 ⇒ 复用槽命中不到（建新会话）+ 链为空（全量重发）。
 *
 * ## 判据（两条，缺一条都不算修好）
 *
 * ① 重启后**不新建**网页会话 —— 新建 ⇒ 网页端多一个窗口；
 * ② 重启后那一轮**带 `parent_message_id`** —— 为 null ⇒ 发的是根消息 ⇒ 网页端出「修改」分叉。
 *
 * ## 为什么必须起两个进程（第一版探针就栽在这）
 *
 * ESM 里一个模块在同一进程内**只求值一次** ⇒ 在同一进程里 import 两次拿到的还是同一个实例，
 * 内存 Map 没清空 ⇒ 测出来的"续上了"是**假的**。
 * 真重启 = 新进程 = 模块顶层重新执行（那里调 `restoreResumeState()`）。
 *
 * 🔴 反向验证：把 `restoreResumeState` 的函数体开头加 `if (1) return` ⇒ 本文件会红，
 *   且 `created > 0` / `parent=null` —— **正是用户现场看到的那两个现象**。已实测。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-resume-home-'))
const self = 'tests/fixture-resume-turn.mjs'
process.env.DSH_NO_BROWSER_TRANSPORT = '1'

/**
 * 🔴 为什么用**异步 spawn** 而不是 `spawnSync`：
 * 本机（Windows）`spawnSync` **一律返回 `EBUSY`**（连 `node -e "console.log(1)"` 都是），
 * `status=null` + `stdout` 空 ⇒ 用它写的任何用例都会"失败或全绿"，判据是假的。
 * 这是老熟人（记忆里有），这里必须绕开。
 */
function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self], {
      env: { ...process.env, DSH_RESUME_PHASE: phase, DSH_RESUME_HOME: process.env.DSH_HOME },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', (e) => reject(new Error(`阶段 ${phase} spawn 失败：${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`阶段 ${phase} 退出码 ${code}：${err.slice(-600)}`))
      const line = out.trim().split('\n').pop()
      try {
        resolve(JSON.parse(line))
      } catch {
        reject(new Error(`阶段 ${phase} 输出不是 JSON：${out.slice(0, 300)}`))
      }
    })
  })
}

try {
  // ── 阶段 1：首次启动，发两轮
  const first = await runPhase('write')
  assert.strictEqual(first.created, 1, '首次启动只应建 1 个会话（第二轮要复用）')
  assert.ok(first.persisted, '阶段1 应落盘 resume-state.json')
  assert.ok(first.persisted.slots?.length >= 1, '落盘里应有会话槽')
  assert.ok(first.persisted.chains?.length >= 1, '落盘里应有投喂链')
  // 第二轮必须已经走增量（parent 非 null）—— 否则"链落盘了"也毫无意义
  const second = first.bodies[1] ?? ''
  assert.ok(
    !second.includes('"parent_message_id":null'),
    `同进程内第二轮就应是增量（parent 非 null），实测：${second.slice(0, 120)}`,
  )

  // ── 阶段 2：新进程 = 真重启，再发一轮
  const afterRestart = await runPhase('verify')

  assert.strictEqual(
    afterRestart.created,
    0,
    `重启后不得新建网页会话（新建 ⇒ 网页端多一个窗口）。实测 created=${afterRestart.created}`,
  )

  const body = afterRestart.bodies[0] ?? ''
  assert.ok(
    !body.includes('"parent_message_id":null'),
    `重启后这一轮必须带 parent_message_id（为 null ⇒ 网页端出现「修改 / 重新生成」+ n/n 分叉）。` +
      `实测 body：${body.slice(0, 140)}`,
  )
  assert.ok(
    body.includes('"prompt":"User: 第三句"'),
    `重启后应只发增量（prompt 不含固定头）。实测：${body.slice(0, 140)}`,
  )

  console.log('  ✓ 0.6.43：重启后同一对话线续上了（会话不新建 + 链带parent 走增量）')
} finally {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
}