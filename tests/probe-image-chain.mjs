/**
 * 真机实验（2026-09-23）：链式投喂的下一轮，**不带** `ref_file_ids` 时，
 * 模型还能不能看到**上一轮那张图**？
 *
 * 背景（用户从网页端观察到「同一张图重复很多次」）：
 *   adapter.ts:1141 → `refFileIds: rounds === 0 ? refFileIds : []`
 *   这个判据是随「自动续写」引入的（commit d36923b），本意是"续写的第 2 轮不重带图"；
 *   但**链式投喂的每一轮都是新的 streamImpl 调用 ⇒ rounds 恒为 0** ⇒ 顺带每轮都重带一遍。
 *   （上传本身有缓存、只有一次 —— 重复的是这个"引用"。）
 *
 * 未知点（本脚本要定论）：服务端按 parent 链回溯历史时，**历史消息的附件算不算进上下文**。
 *   算   ⇒ 每轮重带是纯冗余，可以省（请求体更小 / 网页端不刷屏 / 会话内引用不再累积）
 *   不算 ⇒ 必须每轮带（现状正确，这条就只当"网页端显示难看"处理）
 *
 * 设计：每张图跑一组 —— 轮1 带图、轮2 **不带图**（问四个角的颜色）。
 *   两组用**不同布局**的图（红蓝绿黄 / 绿黄蓝红）⇒ 单组蒙对 1/256、两组独立 1/65536。
 *   另有一组对照（轮2 带图），用来排除"链式投喂的下一轮本身看不到图"。
 *
 * ⚠️ 前两版翻车，三个陷阱记在这里：
 *   1) **必须显式 `applyContextMode('chained')`** —— 默认是 `full`，
 *      否则两轮都是"全量重发 + parent=null"，测的根本不是链式场景（现场：`模式=mode-full`、`parent=-`）。
 *   2) **答案绝不能出现在历史文本里**：第一版轮1 问「四角什么颜色」，回答明文写着"左上=红色…"
 *      ⇒ 轮2 只要能看到历史**文本**就能复述，答对**不能**证明看得到图。
 *      现在轮1 只问「由几种纯色组成」（答案是数字，不含颜色名）。
 *   3) **用 `disposeSessionReuse()` 而不是 `resetSessionReuse()`** —— 后者只清槽不排队删除，
 *      会把会话永久留在网页端（正是上一轮在查的那个泄漏）。
 *
 * 判读：
 *   不带图仍全对  ⇒ 历史附件会被回溯 ⇒ **可以省**
 *   不带图答不出、带图全对 ⇒ **必须每轮带**（现状正确）
 *
 * 用法：node tests/probe-image-chain.mjs
 */
import zlib from 'node:zlib'
import { hasUsableAuth, readAuth } from '../src/auth.ts'
import { applyContextMode } from '../src/context-feed.ts'
import {
  contextChainInfo,
  disposeSessionReuse,
  streamWebCompletion,
  uploadImageFile,
  validateAuth,
} from '../src/webapi.ts'

// ── 极简 PNG 编码器（照抄 tests/probe-vision.mjs）──
const crcTable = (() => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}
function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
// 四象限：TL/TR/BL/BR 各给一个 RGB
const quadrant = (tl, tr, bl, br) => (x, y) =>
  y < 64 ? (x < 64 ? tl : tr) : x < 64 ? bl : br

const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
const GREEN = [0, 255, 0]
const YELLOW = [255, 255, 0]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pad = (s, n) => String(s).padEnd(n)

// ── 0) 凭证 + 模式 ──
const auth = readAuth()
if (!hasUsableAuth(auth)) {
  console.log('X readAuth() 没有可用凭证（未选账号 / token 为空）')
  process.exit(1)
}
console.log('账号:', auth.user?.display ?? '(未识别)')
const probe = await validateAuth(auth)
console.log('探活:', probe.ok ? `OK（${probe.user?.display ?? '?'}）` : `失败 —— ${probe.error}`)
if (!probe.ok) {
  console.log('X 凭证不可用，实验终止（先重登这个账号）')
  process.exit(1)
}
// ⚠️ 陷阱 1：默认是 full，不设这一行测的就不是链式投喂
applyContextMode('chained')
console.log('上下文模式: chained（显式设置；默认是 full）')

// ── 提示词骨架 ──
const head = '<sys>实验助手：严格按要求的格式回答，不要解释。</sys>'
// ⚠️ 陷阱 2：轮1 的答案（数字）不含任何颜色名 ⇒ 轮2 不可能靠历史**文本**推出颜色
const Q1 = '这张图一共由几种纯色组成？只回答一个阿拉伯数字，不要其它内容。'
const Q2 =
  '上一轮那张图的左上、右上、左下、右下分别是什么颜色？只回答：左上=X，右上=Y，左下=Z，右下=W' +
  '（X/Y/Z/W 从红蓝绿黄里选）。如果你看不到那张图，就只回答：看不到。'
const e1 = `User: ${Q1}\n[image attached]`
const e2 = `User: ${Q2}\n[image attached]`
const e2NoImage = `User: ${Q2}`

const heads = { A: head, B: `${head}\n/* B */` }
const pendingDelete = new Set()

async function runTurn({ group, entries, refFileIds, label }) {
  const h = heads[group]
  const prompt = [h, ...entries].join('\n\n')
  let answer = ''
  let feedReason = '(未回调)'
  const errors = []
  for await (const ev of streamWebCompletion(auth, {
    prompt,
    promptParts: { head: h, entries },
    thinkingEnabled: false,
    modelType: 'default',
    ...(refFileIds ? { refFileIds } : {}),
    idleTimeoutMs: 120_000,
    onContextFeed: (r) => {
      feedReason = r.reason
    },
    onDeleteSession: (id) => pendingDelete.add(id),
  })) {
    if (ev.kind === 'text') answer += ev.text
    else if (ev.kind === 'error') errors.push(ev.message)
  }
  const chain = contextChainInfo()
  console.log(
    `  ${pad(label, 9)} 模式=${pad(feedReason, 11)} session=${pad(chain ? String(chain.sessionId).slice(0, 8) : '-', 9)}` +
      ` parent=${pad(chain ? chain.parentId : '-', 5)} turns=${chain ? chain.turns : '-'}` +
      (errors.length ? `  错误=${errors.join('|')}` : ''),
  )
  console.log(`    答: ${JSON.stringify(answer.trim().slice(0, 110))}`)
  return { answer: answer.trim(), feedReason, errors }
}

/** 数出四个角答对几个。 */
function grade4(answer, exp) {
  if (/看不到/.test(answer)) return { hit: '看不到', n: 0 }
  let n = 0
  for (const [corner, color] of Object.entries(exp)) {
    if (new RegExp(`${corner}\\s*=?\\s*${color}`).test(answer)) n += 1
  }
  return { hit: `${n}/4`, n }
}
const grade1 = (answer) => (/4/.test(answer) ? '4 OK' : `意外:${answer.slice(0, 16)}`)

const CN = { red: '红', blue: '蓝', green: '绿', yellow: '黄' }

/** 一组：上传该布局的图 → 轮1 带图 → 轮2 不带图。 */
async function trial({ tag, quad, expect }) {
  console.log(`\n=== ${tag} ===`)
  const png = makePng(128, 128, quad)
  const up = await uploadImageFile(auth, {
    data: new Uint8Array(png),
    mediaType: 'image/png',
    name: `quad-${tag.replace(/[^a-z0-9]/gi, '')}.png`,
  })
  console.log(`  上传: ${String(up.fileId).slice(0, 26)}...`)
  disposeSessionReuse()
  const r1 = await runTurn({ group: 'A', entries: [e1], refFileIds: [up.fileId], label: '轮1 带图' })
  await sleep(3000)
  const r2 = await runTurn({ group: 'A', entries: [e1, e2NoImage], refFileIds: null, label: '轮2 无图' })
  return { r1, r2, g1: grade1(r1.answer), g2: grade4(r2.answer, expect) }
}

// ── 两组不同布局（各自独立：蒙对 1/256）──
const T1 = await trial({
  tag: '布局1：左上红/右上蓝/左下绿/右下黄',
  quad: quadrant(RED, BLUE, GREEN, YELLOW),
  expect: { 左上: CN.red, 右上: CN.blue, 左下: CN.green, 右下: CN.yellow },
})
const T2 = await trial({
  tag: '布局2（换了位置）：左上绿/右上黄/左下蓝/右下红',
  quad: quadrant(GREEN, YELLOW, BLUE, RED),
  expect: { 左上: CN.green, 右上: CN.yellow, 左下: CN.blue, 右下: CN.red },
})

// ── 对照：轮2 **带图**（排除"链式下一轮本身看不到图"）──
console.log('\n=== 对照：轮2 带 ref_file_ids ===')
const ctrlPng = makePng(128, 128, quadrant(RED, BLUE, GREEN, YELLOW))
const ctrlUp = await uploadImageFile(auth, {
  data: new Uint8Array(ctrlPng),
  mediaType: 'image/png',
  name: 'quad-ctrl.png',
})
disposeSessionReuse()
const C1 = await runTurn({ group: 'B', entries: [e1], refFileIds: [ctrlUp.fileId], label: 'B1 带图' })
await sleep(3000)
const C2 = await runTurn({ group: 'B', entries: [e1, e2], refFileIds: [ctrlUp.fileId], label: 'B2 带图' })
const ctrlG2 = grade4(C2.answer, { 左上: CN.red, 右上: CN.blue, 左下: CN.green, 右下: CN.yellow })

// ── 汇总 ──
console.log('\n=== 汇总 ===')
console.log(`  ${pad('布局1 轮1（前提）', 20)} ${pad(T1.r1.feedReason, 12)} ${T1.g1}`)
console.log(`  ${pad('布局1 轮2 无图', 20)} ${pad(T1.r2.feedReason, 12)} 命中 ${T1.g2.hit}`)
console.log(`  ${pad('布局2 轮1（前提）', 20)} ${pad(T2.r1.feedReason, 12)} ${T2.g1}`)
console.log(`  ${pad('布局2 轮2 无图', 20)} ${pad(T2.r2.feedReason, 12)} 命中 ${T2.g2.hit}`)
console.log(`  ${pad('对照 轮2 带图', 20)} ${pad(C2.feedReason, 12)} 命中 ${ctrlG2.hit}`)

const valid =
  T1.r2.feedReason === 'chained' && T2.r2.feedReason === 'chained' && C2.feedReason === 'chained'
const premisesOk = T1.g1.startsWith('4') && T2.g1.startsWith('4')
console.log()
if (!valid) {
  console.log(`X 实验无效：有轮次没走 chained（${T1.r2.feedReason} / ${T2.r2.feedReason} / ${C2.feedReason}）`)
} else if (!premisesOk) {
  console.log('X 前提不成立：轮1 没认出"4 种纯色"，说明图片通道本身有问题')
} else if (T1.g2.n === 4 && T2.g2.n === 4) {
  console.log('=> 结论：**历史附件会被回溯** —— 链式投喂的下一轮可以省掉 ref_file_ids')
  console.log('   两张不同布局的图、都没带图、都答对四个角（单组蒙对 1/256）')
} else if (ctrlG2.n === 4) {
  console.log('=> 结论：**必须每轮带** —— 不带图时模型看不到（现状正确）')
} else {
  console.log('=> 两组都没答对：链式投喂的下一轮本身可能有问题，需要另查')
}

// ── 清理 ──
for (const id of pendingDelete) {
  try {
    await fetch('https://chat.deepseek.com/api/v0/chat_session/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.token}`,
        ...(auth.extraHeaders ?? {}),
      },
      body: JSON.stringify({ chat_session_id: id }),
    })
  } catch {
    /* 删不掉就留着 */
  }
}
console.log(`\n已清理实验会话: ${pendingDelete.size} 个`)
