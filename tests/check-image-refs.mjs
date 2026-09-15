/**
 * 回归：图片引用的组装与"图丢了要说出来"（0.1.66）。
 *
 * 覆盖两条此前**零覆盖**的接线（真实上传要 PoW sha3 wasm + 真网络，单测跑不动，
 * 所以 uploadImage 是注入的假实现 —— 与 streamCompletion 同一套办法）：
 *
 *  1) 同一张图在历史里出现多次时，`ref_file_ids` 必须去重。
 *     触发是真实存在的：`collectImageRefs` 会**有意**走进 tool-result 内嵌的图片，
 *     而模型读同一张图可能调两次 `read_image`。实测本机会话
 *     `install-plugin/session-c1fb8208-*` 里 seq=17 与 seq=23 两个 tool/result
 *     各自内嵌同一张 `sha256:23c18a56…`（89962 B JPEG）。
 *     `attachmentId` 是内容寻址（sha256），所以两次是同一个 key ⇒ 旧实现缓存命中时
 *     把**同一个 file_id 又推一遍** ⇒ `ref_file_ids: [id, id]`。
 *     服务端不接受重复 id（biz_code 9 / invalid ref file id），一旦被拒，
 *     该会话**后续每一轮都失败**（图留在历史里），只能新开对话。
 *
 *  2) 图片没能送出去时必须让**用户**看见。旧实现只 `logger.warn` 然后静默降级成
 *     纯文本，当轮 completion 正常 FINISHED，界面上毫无异常 ——
 *     用户只会以为"模型看不懂图"（2026-09-15 实测本机 09-14 有 36 次上传被
 *     服务端以 code 9 unsupported file type 拒绝，全程无声）。
 *
 * 用法: node tests/check-image-refs.mjs
 */
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const AUTH = {
  token: 't'.repeat(64),
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
  capturedAt: '2026-09-15T00:00:00.000Z',
}

/** 内容寻址的真实形态：attachmentId 就是 sha256（不代表真实哈希，只保证同图同 id）。 */
const IMG_A = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', name: 'a.png' }
const IMG_B = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/jpeg', name: 'b.jpg' }

/** 用户消息里带一张图。 */
const userWithImage = (img) => ({ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: img }] })
/** read_image 的工具结果：**内嵌图片本体**（这正是重复的第二个来源）。 */
const toolResultWithImage = (img) => ({
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }, { type: 'image', attachment: img }] }],
})

/**
 * 跑一次适配器流。
 * `readImage: null` = 完全不注入（模拟宿主没提供 ctx.attachments）；
 * `uploadImage: null` 同理。返回被捕获的请求参数、上传/读取记录、以及正文。
 */
async function run({ messages, uploadImage, readImage } = {}) {
  const calls = []
  const uploads = []
  const reads = []
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined },
    ...(readImage === null
      ? {}
      : {
          readImage:
            readImage ??
            (async (ref) => {
              reads.push(String(ref?.attachmentId ?? ''))
              return { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: String(ref?.mediaType ?? 'image/png') }
            }),
        }),
    ...(uploadImage === null
      ? {}
      : {
          uploadImage:
            uploadImage ??
            (async (_auth, input) => {
              uploads.push(input)
              return { fileId: `file-${uploads.length}` }
            }),
        }),
    streamCompletion: (_auth, params) => {
      calls.push(params)
      return (async function* () {
        yield { kind: 'text', text: '收到。' }
        yield { kind: 'finish', reason: 'stop' }
      })()
    },
  })
  const deltas = []
  for await (const event of adapter.stream({ messages })) {
    if (event.type === 'text-delta') deltas.push(event.text)
  }
  return { calls, uploads, reads, text: deltas.join('') }
}

// ── 1) 去重 ──────────────────────────────────────────────────────────────

await test('同一张图在「用户消息 + 工具结果」里各一次 → ref_file_ids 只 1 个（0.1.66 主诉）', async () => {
  const { calls, reads } = await run({
    messages: [userWithImage(IMG_A), { role: 'assistant', content: [{ type: 'tool-call', name: 'read_image' }] }, toolResultWithImage(IMG_A)],
  })
  assert.equal(calls.length, 1, '自证：确实发出了 1 次模型请求')
  assert.ok(Array.isArray(calls[0].refFileIds), `自证：请求参数里有 refFileIds，实际 ${JSON.stringify(calls[0].refFileIds)}`)
  assert.deepEqual(calls[0].refFileIds, ['file-1'], `重复 id 会被服务端拒（biz_code 9），实际 ${JSON.stringify(calls[0].refFileIds)}`)
  assert.equal(reads.length, 1, '自证：同一张图只读一次（去重发生在读附件之前）')
})

await test('同一张图出现三次 → 仍然只 1 个 id', async () => {
  const { calls } = await run({
    messages: [userWithImage(IMG_A), toolResultWithImage(IMG_A), toolResultWithImage(IMG_A)],
  })
  assert.deepEqual(calls[0].refFileIds, ['file-1'])
})

await test('两张不同的图 → 两个 id（去重不能把不同附件误合）', async () => {
  const { calls, reads } = await run({ messages: [userWithImage(IMG_A), toolResultWithImage(IMG_B)] })
  assert.deepEqual(calls[0].refFileIds, ['file-1', 'file-2'])
  assert.equal(reads.length, 2, '自证：两张图都要读')
})

await test('没有图片 → refFileIds 为空，且完全不碰附件服务', async () => {
  const { calls, reads, uploads } = await run({ messages: [{ role: 'user', content: [{ type: 'text', text: '纯文字' }] }] })
  assert.deepEqual(calls[0].refFileIds, [])
  assert.equal(reads.length, 0, '没有图就不该读附件')
  assert.equal(uploads.length, 0, '没有图就不该上传')
})

// ── 2) 图丢了要看得见 ────────────────────────────────────────────────────

await test('上传失败 → 正文里明确告知，且失败那张不进 ref_file_ids（成功那张照发）', async () => {
  const { calls, text } = await run({
    messages: [userWithImage(IMG_A), toolResultWithImage(IMG_B)],
    uploadImage: async (_auth, input) => {
      if (input.name === 'a.png') throw new Error('DeepSeek 图片上传被拒（code 9）：unsupported file type')
      return { fileId: 'file-b' }
    },
  })
  assert.deepEqual(calls[0].refFileIds, ['file-b'], '失败的图不该被引用，成功的照常')
  assert.ok(text.includes('没能传给模型'), `正文必须说明图丢了，实际正文：${JSON.stringify(text)}`)
  assert.ok(text.includes('unsupported file type'), '要把失败原因一起说清楚')
  assert.ok(text.includes('1 张'), `要说明丢了几张，实际正文：${JSON.stringify(text)}`)
})

await test('宿主没提供附件能力（readImage 缺失）→ 同样告知，不是无声忽略', async () => {
  const { calls, text } = await run({ messages: [userWithImage(IMG_A)], readImage: null })
  assert.deepEqual(calls[0].refFileIds, [], '拿不到字节就只能降级为纯文本')
  assert.ok(text.includes('没能传给模型'), `正文必须说明图丢了，实际正文：${JSON.stringify(text)}`)
  assert.ok(text.includes('ctx.attachments'), '原因要指向真实原因（宿主没接线）')
})

await test('全部上传成功 → 正文里不得出现这句提示（自证：不是无脑加提示）', async () => {
  const { calls, text } = await run({ messages: [userWithImage(IMG_A)] })
  assert.deepEqual(calls[0].refFileIds, ['file-1'])
  assert.ok(!text.includes('没能传给模型'), `正常情况不该提示，实际正文：${JSON.stringify(text)}`)
})

await test('超长失败原因会被截断，不把整段服务端文案塞进正文', async () => {
  const long = 'A'.repeat(400)
  const { text } = await run({
    messages: [userWithImage(IMG_A)],
    uploadImage: async () => {
      throw new Error(long)
    },
  })
  assert.ok(text.includes('没能传给模型'))
  assert.ok(!text.includes(long), '400 字的原因必须被截断')
  assert.ok(text.includes('A'.repeat(120) + '…'), '截断位置应当是 120 字 + 省略号')
})

console.log(failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const f of failures) console.log(`  - ${f}`)
if (failures.length > 0) process.exitCode = 1
