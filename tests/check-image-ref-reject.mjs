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
import { canRetryImageReject, createAdapter, ImageUploadCache, nextTrimNoticeThreshold } from '../src/adapter.ts'
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
 * `uploadScript[i]` 描述第 i 张图片上传的行为：'ok' / 'auth'（授权失效）/ 'server'（上游 5xx）。
 */
async function run({ script, messages, uploadScript } = {}) {
  let n = 0
  const calls = []
  let uploadCount = 0
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined },
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    uploadImage: async () => {
      const index = uploadCount
      uploadCount += 1
      const step = uploadScript?.[index] ?? 'ok'
      // 错误码必须跟真实路径一致（webapi.ts 用 httpErrorCode / bizErrorCode 生成）：
      // 401 ⇒ 'AUTH'，5xx ⇒ 'SERVER'。短路只看 'AUTH'，所以这里钉准了才有意义。
      if (step === 'auth') {
        throw new AdapterLlmError(
          'DeepSeek 图片上传失败 (HTTP 401): {"code":40003,"msg":"Authorization Failed (invalid token)"}',
          'AUTH',
        )
      }
      if (step === 'server') throw new AdapterLlmError('DeepSeek 图片上传失败 (HTTP 500): boom', 'SERVER')
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

// ── 5) 截断提示：量词要说对，且不重复刷屏（0.1.79）──────────────────────
// 现场：19 分钟里同一句提示上屏 52 次，用户反问"为啥每次都这么多提示"；
// 而且它写"24 张图片"，用户读成"我发了 24 张"。这两件事都要钉住。

const manyImages = (n) => ({
  role: 'user',
  content: [
    { type: 'text', text: '一堆图' },
    ...Array.from({ length: n }, (_, i) => ({
      type: 'image',
      attachment: { attachmentId: `sha256:bulk${i}`, mediaType: 'image/png' },
    })),
  ],
})

/**
 * 用**同一个 adapter 实例**连续跑多组消息。
 * 抑制重复靠的是实例内的闭包状态 —— 每组都新建实例就永远测不到它（第一版最容易漏的点）。
 */
async function runSets(sets) {
  let n = 0
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined },
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    uploadImage: async () => ({ fileId: `file-${(n += 1)}` }),
    streamCompletion: () =>
      (async function* () {
        yield { kind: 'text', text: '收到。' }
        yield { kind: 'finish', reason: 'stop' }
      })(),
  })
  const outs = []
  for (const messages of sets) {
    const deltas = []
    for await (const event of adapter.stream({ messages })) {
      if (event.type === 'text-delta') deltas.push(event.text)
    }
    outs.push(deltas.join(''))
  }
  return outs
}

await test('截断提示改说「图片内容条目」，并点明不等于你贴的张数（0.1.79）', async () => {
  const [first] = await runSets([[manyImages(26)]])
  assert.ok(first.includes('份图片内容'), `"张"这个量词必须换掉，实际：${JSON.stringify(first.slice(0, 160))}`)
  assert.ok(first.includes('不是你贴的张数'), '要说清"这是内容条目"，否则用户会以为是自己发的')
})

await test('同样规模的截断只上屏一次 —— 不再每轮刷屏（0.1.79）', async () => {
  const outs = await runSets([[manyImages(26)], [manyImages(26)], [manyImages(26)]])
  const hits = outs.filter((t) => t.includes('份图片内容')).length
  assert.equal(hits, 1, `3 轮只该提示 1 次，实际 ${hits} 次（旧版实测 19 分钟刷了 52 次）`)
})

await test('🔴 规模在缓慢增长时也不刷屏（0.1.81 修的真问题）', async () => {
  // 现场：0.1.79 用的签名是「总条数:保留数」，而模型每 read_image 一次总条数就 +1 ⇒
  // 29 份 → 30 份就又提示一遍（用户截图为证，说"频率还是有点高"）。
  const outs = await runSets([[manyImages(26)], [manyImages(27)], [manyImages(28)], [manyImages(29)]])
  const hits = outs.filter((t) => t.includes('份图片内容')).length
  assert.equal(hits, 1, `4 轮缓慢增长只该提示 1 次（首轮），实际 ${hits} 次`)
})

await test('被略过的份数明显变大（≥ 下限）才再说一次', async () => {
  // 26 → 被略过 2；40 → 被略过 16，越过 floor(10)
  const outs = await runSets([[manyImages(26)], [manyImages(40)]])
  assert.equal(outs.filter((t) => t.includes('份图片内容')).length, 2, '情况确实恶化了，值得再说一次')
})

await test('阶梯逐级抬升：说了 40 之后，下次要到被略过 32 份以上', async () => {
  // 40 → dropped 16 ⇒ 下一档 max(10, 32) = 32 ⇒ 56 份（dropped 32）才再提示
  const outs = await runSets([[manyImages(26)], [manyImages(40)], [manyImages(50)], [manyImages(56)]])
  const hits = outs.filter((t) => t.includes('份图片内容')).length
  assert.equal(hits, 3, `应为 首轮 + 40 + 56 共 3 次，实际 ${hits} 次`)
})

await test('判据：阶梯门槛（首次 / 保留数变了 / 翻倍且不低于下限）', () => {
  assert.equal(nextTrimNoticeThreshold(undefined, 24), 1, '首次必说明')
  assert.equal(nextTrimNoticeThreshold({ kept: 24, dropped: 2 }, 24), 10, '小值时受下限保护，不按翻倍算')
  assert.equal(nextTrimNoticeThreshold({ kept: 24, dropped: 20 }, 24), 40, '翻倍')
  assert.equal(nextTrimNoticeThreshold({ kept: 24, dropped: 40 }, 24), 80, '继续翻倍')
  assert.equal(nextTrimNoticeThreshold({ kept: 24, dropped: 16 }, 12), 1, '保留数变了（改了上限）⇒ 重新说明一次')
})

await test('没超上限时不提示（自证：上面几条测的确实是截断路径）', async () => {
  const [text] = await runSets([[manyImages(3)]])
  assert.equal(text.includes('份图片内容'), false)
})

// ── 6) 授权失效时中止剩余上传（0.1.80）─────────────────────────────────
// 现场（2026-09-21 22:50）：token 早已失效，14 张图却逐张重试 —— 每张都要先求一次 POW、
// 再发一次上传，共 28 次注定失败的请求。浪费只是次要的：**这些无效请求同样暴露在风控下**。
// 授权失效是全局的，第一张被拒后剩下的必然一样，所以停。

await test('🔴 第 2 张上传被拒为授权失效 ⇒ 剩余的不再尝试，且如实告知还剩几张', async () => {
  const { calls, uploads, text } = await run({
    script: ['ok'],
    messages: [manyImages(5)],
    uploadScript: ['ok', 'auth', 'ok', 'ok', 'ok'],
  })
  assert.equal(uploads, 2, `只该尝试前两张，实际 ${uploads} 次（现场是 14 张全试一遍）`)
  assert.ok(text.includes('没能传给模型'), `自证：失败告知仍要出现，实际 ${JSON.stringify(text.slice(-200))}`)
  assert.ok(text.includes('剩余 3 张未再尝试'), '必须说清"剩下的根本没试" —— 否则用户以为只丢了一张')
  assert.equal(calls.length, 1, '只中止上传，请求本身照发：凭证还能不能用由 completion 定论')
})

await test('只有 1 张图时被拒 ⇒ 不出现「剩余」字样（不该写"剩余 0 张"）', async () => {
  const { uploads, text } = await run({ script: ['ok'], messages: [manyImages(1)], uploadScript: ['auth'] })
  assert.equal(uploads, 1)
  assert.ok(text.includes('没能传给模型'))
  assert.equal(text.includes('未再尝试'), false)
})

await test('🔴 网络类失败（5xx）⇒ **不**短路，剩下的照常试（别把偶发故障当成凭证失效）', async () => {
  const { uploads, text } = await run({
    script: ['ok'],
    messages: [manyImages(3)],
    uploadScript: ['server', 'ok', 'ok'],
  })
  assert.equal(uploads, 3, '一次 5xx 不代表剩下的也会失败；短路只看 AUTH')
  assert.equal(text.includes('未再尝试'), false)
})

await test('判据：只有 AUTH 值得短路（码认错了会把偶发失败放大成"整批放弃"）', async () => {
  const auth = new AdapterLlmError('图片上传失败 (HTTP 401)', 'AUTH')
  const server = new AdapterLlmError('图片上传失败 (HTTP 500)', 'SERVER')
  const transport = new AdapterLlmError('图片上传失败：fetch failed', 'TRANSPORT')
  assert.equal(auth.code === 'AUTH', true)
  assert.equal(server.code === 'AUTH', false)
  assert.equal(transport.code === 'AUTH', false)
})

console.log(failures.length === 0 ? `\n通过 ${passed} 项，全部通过 ✅` : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
