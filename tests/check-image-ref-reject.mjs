// 图片引用被服务端拒绝（`code 9 / invalid ref file id`）的识别与降级重试。
//
// 真实现场（2026-09-21 19:36）：`new-session` 触发全量重发历史图，服务端回
// `DeepSeek 网页端错误（code 9）：invalid ref file id` —— 整轮失败，而且因为图留在
// DSH 的消息历史里、之后每轮都会重新引用，该会话此后**每轮都失败**，用户除了丢掉
// 整个会话没有别的出路。这个用例守的就是"不许再卡死"。
//
// ⚠️ `code 9` 在本项目里有**两个**含义，必须靠 msg 区分：
//   上传时 = `unsupported file type`（换名字重传即可）
//   请求时 = `invalid ref file id`（要降级重试）
// 用例里特意把前者钉成 false —— 认错了会把"传文件失败"当成"引用被拒"去重试。

import assert from 'node:assert/strict'
import { canRetryImageReject, createAdapter, ImageUploadCache } from '../src/adapter.ts'
import { AdapterLlmError } from '../src/auth.ts'
import { isInvalidRefFileError } from '../src/webapi.ts'
import { captureDefect } from '../src/auth.ts'

const AUTH = {
  token: 'tok-test-0123456789',
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: 'https://example.invalid/w.wasm',
  userAgent: 'UA',
  capturedAt: '2026-09-21T00:00:00.000Z',
}

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const IMG_A = { attachmentId: 'sha256:aaaa', mediaType: 'image/png' }
const userWithImage = (img) => ({ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: img }] })
const userOnlyText = { role: 'user', content: [{ type: 'text', text: '没有图' }] }

/**
 * ⚠️ 必须用 `AdapterLlmError`，不能拿 `new Error()` 手写 code：
 * `streamImpl` 的外层 catch 只原样放行 `AdapterLlmError`，别的会被统一包装成 `TRANSPORT`
 * （这就是第一版用例踩的坑 —— 重试判断永远看不到 `INVALID_REF_FILE`）。
 * 真实路径抛的也正是它：`webapi.ts` 里 `new AdapterLlmError(..., 'INVALID_REF_FILE')`。
 */
function rejectError() {
  return new AdapterLlmError('DeepSeek 网页端错误（code 9）：invalid ref file id', 'INVALID_REF_FILE')
}

/**
 * 跑一次适配器流。`script[i]` 描述第 i 次模型请求的行为：
 * 'ok' 正常 / 'reject' 直接抛引用被拒 / 'reject-after-text' 先吐一段正文再抛 / 'other' 抛别的错。
 */
async function run({ script, messages }) {
  let n = 0
  const calls = []
  let uploadCount = 0
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined },
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    uploadImage: async () => {
      uploadCount += 1
      return { fileId: `file-${uploadCount}` }
    },
    streamCompletion: (_auth, params) => {
      const index = n
      n += 1
      calls.push(params)
      return (async function* () {
        const step = script[index] ?? 'ok'
        if (step === 'other') throw new AdapterLlmError('用户已被限流', 'RATE_LIMIT')
        if (step === 'reject-after-text') {
          // 先吐一大段（短文本会被过滤器 hold 住、根本不上屏），再抛 —— 模拟
          // 「用户已经看到一部分内容了」这种撤不回来的情形。
          yield { kind: 'text', text: '这是一段已经上屏的正文。'.repeat(20) }
          throw rejectError()
        }
        if (step === 'reject') throw rejectError()
        yield { kind: 'text', text: '收到。' }
        yield { kind: 'finish', reason: 'stop' }
      })()
    },
  })
  const deltas = []
  let error
  try {
    for await (const event of adapter.stream({ messages })) {
      if (event.type === 'text-delta') deltas.push(event.text)
    }
  } catch (caught) {
    error = caught
  }
  return { calls, text: deltas.join(''), error, uploads: uploadCount }
}

// ── 1) code 9 的两个含义必须分得开 ─────────────────────────────────────────

await test('code 9 + invalid ref file id → 判为「图片引用被拒」', () => {
  assert.equal(isInvalidRefFileError({ code: 9, msg: 'invalid ref file id' }), true)
})

await test('code 9 + unsupported file type → **不**判（那是上传错误，认错会去白白重试）', () => {
  assert.equal(isInvalidRefFileError({ code: 9, msg: 'unsupported file type' }), false)
})

await test('其他业务码 → 不判', () => {
  assert.equal(isInvalidRefFileError({ code: 10, msg: 'too many ref file' }), false)
  assert.equal(isInvalidRefFileError({ code: 40003, msg: 'Authorization Failed' }), false)
  assert.equal(isInvalidRefFileError(undefined), false)
})

// ── 2) 上传缓存的定点清理 ────────────────────────────────────────────────

await test('invalidate 只删指定的那几条，其余原样保留', () => {
  const cache = new ImageUploadCache()
  cache.useScope('t')
  cache.set('a', 'f1')
  cache.set('b', 'f2')
  cache.set('c', 'f3')
  assert.equal(cache.invalidate(['a', 'c']), 2, '自证：返回真正删掉的条数')
  assert.equal(cache.get('b'), 'f2', '没被点名的必须留着（否则下一轮会把无关的图全重传一遍）')
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size, 1)
})

// ── 3) 降级重试（核心）──────────────────────────────────────────────────

await test('被拒一次 → 清掉那几张的缓存、重新上传拿到新 id 再试，共 2 次请求', async () => {
  const { calls, text, error, uploads } = await run({ script: ['reject', 'ok'], messages: [userWithImage(IMG_A)] })
  assert.equal(error, undefined, '自证：重试成功后不该把错误抛给上层')
  assert.equal(calls.length, 2, `自证：应有 2 次模型请求，实际 ${calls.length}`)
  assert.deepEqual(calls[0].refFileIds, ['file-1'], '自证：第一次带的是首次上传的 id')
  assert.deepEqual(calls[1].refFileIds, ['file-2'], '重试必须**重新上传**拿新 id，而不是复用被拒的那个')
  assert.equal(uploads, 2, '自证：确实重新传了一次')
  assert.equal(text, '收到。')
})

await test('连着被拒两次 → 第 3 次不带任何图片重发，不让会话卡死', async () => {
  const { calls, error } = await run({ script: ['reject', 'reject', 'ok'], messages: [userWithImage(IMG_A)] })
  assert.equal(error, undefined, '兜底生效后必须能正常拿到回答')
  assert.equal(calls.length, 3, `自证：应有 3 次模型请求，实际 ${calls.length}`)
  assert.deepEqual(calls[2].refFileIds, [], '最后一级降级就是**不带图** —— 宁可这轮没图，也不能整个会话报废')
})

await test('重试上限是 2 次：第三次仍被拒就如实抛错，不无限重试', async () => {
  const { calls, error } = await run({ script: ['reject', 'reject', 'reject'], messages: [userWithImage(IMG_A)] })
  assert.ok(error, '自证：兜底都用完了，必须把错误抛出去')
  assert.equal(error.code, 'INVALID_REF_FILE')
  assert.equal(calls.length, 3, '两次重试之后不再追加请求（请求密度也是要被风控看的）')
})

// ⚠️ 「内容已经上屏、然后才出错」这个场景用假的流**构造不出来** —— 文本会被过滤器 hold 到轮末，
// 而异常发生在轮末之前。所以这里直接测判据本身：它是重试逻辑里唯一会带来副作用的那个条件。
await test('判据：已经上屏过（yielded）就绝不重试 —— 否则用户会看到重复输出', () => {
  assert.equal(canRetryImageReject(rejectError(), true, 0), false)
})

await test('判据：只对「请求侧图片引用被拒」重试，别的错误不重试', () => {
  assert.equal(canRetryImageReject(rejectError(), false, 0), true)
  assert.equal(canRetryImageReject(new AdapterLlmError('限流', 'RATE_LIMIT'), false, 0), false)
  assert.equal(canRetryImageReject(new AdapterLlmError('授权失败', 'AUTH'), false, 0), false)
  assert.equal(canRetryImageReject(undefined, false, 0), false)
})

await test('判据：最多两次机会，用完了就如实抛错、不再追加请求', () => {
  assert.equal(canRetryImageReject(rejectError(), false, 1), true)
  assert.equal(canRetryImageReject(rejectError(), false, 2), false)
})

await test('重试路径下，最终回答里不会出现重复内容', async () => {
  const { calls, text } = await run({ script: ['reject-after-text', 'ok'], messages: [userWithImage(IMG_A)] })
  const marker = '这是一段已经上屏的正文。'
  assert.equal(text.split(marker).length - 1, 0, '重复输出是这个兜底最危险的副作用，这里钉住它')
  assert.equal(calls.length, 2, '自证：确实走的是重试路径（否则这条用例没意义）')
})

await test('别的错误（如限流）不触发重试', async () => {
  const { calls, error } = await run({ script: ['other'], messages: [userWithImage(IMG_A)] })
  assert.equal(error?.code, 'RATE_LIMIT')
  assert.equal(calls.length, 1, '只有 INVALID_REF_FILE 才走这条路')
})

await test('请求里没有图片时，压根不该走上传（自证重试路径不会被无图请求误触发）', async () => {
  const { calls, uploads } = await run({ script: ['ok'], messages: [userOnlyText] })
  assert.equal(calls.length, 1)
  assert.equal(uploads, 0, '自证：没有图片就没有上传')
  assert.deepEqual(calls[0].refFileIds, [])
})

// ── 4) 捕获完整性的判据（只记事实，不拦截）────────────────────────────────

await test('cookie 与 extraHeaders 双空 → 判为「捕获信息偏少」', () => {
  const reason = captureDefect({ token: 'tok', cookie: '', extraHeaders: undefined })
  assert.ok(reason, '双空是这次现场的形态（acc_2df7cf2f）')
})

await test('只有 cookie 为空 → **不**判（鉴权只用 token，手工粘 token 就是没 cookie）', () => {
  assert.equal(captureDefect({ token: 'tok', cookie: '', extraHeaders: { 'x-client-version': '1' } }), undefined)
})

await test('只有请求头为空 → 不判', () => {
  assert.equal(captureDefect({ token: 'tok', cookie: 'ds_session_id=x', extraHeaders: undefined }), undefined)
})

await test('两者都在 → 不判', () => {
  assert.equal(captureDefect({ token: 'tok', cookie: 'ds_session_id=x', extraHeaders: { a: 'b' } }), undefined)
})

await test('根本没有 token（不是捕获场景）→ 不判', () => {
  assert.equal(captureDefect({ token: '', cookie: '', extraHeaders: undefined }), undefined)
})

console.log(failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
