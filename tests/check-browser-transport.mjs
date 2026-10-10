/**
 * 回归：浏览器代理传输层（官方 DSH 桌面端 fallback）。
 *
 * 当 Electron 的 `net.fetch` 不可用时，用系统 Edge/Chrome 进程代理请求，
 * 让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 用法: node tests/check-browser-transport.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-browser-transport-'))
process.env.DSH_HOME = HOME

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

async function main() {
  // 1. 默认（本机有浏览器时）systemBrowserAvailable 为 true
  await test('本机有 Edge/Chrome 时 systemBrowserAvailable 为 true', async () => {
    const { systemBrowserAvailable } = await import('../src/browser-transport.ts')
    assert.equal(typeof systemBrowserAvailable(), 'boolean')
  })

  // 2. DSH_NO_BROWSER_TRANSPORT=1 时强制关闭
  process.env.DSH_NO_BROWSER_TRANSPORT = '1'
  await test('DSH_NO_BROWSER_TRANSPORT=1 时 systemBrowserAvailable 为 false', async () => {
    const { systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?no-browser=' + Date.now()
    )
    assert.equal(systemBrowserAvailable(), false)
  })

  // 3. resolveTransportState 在浏览器可用时选择浏览器代理
  await test('浏览器可用时 resolveTransportState 走 viaBrowserProxy', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const [{ resolveTransportState }, { findSystemBrowser }] = await Promise.all([
      import('../src/transport.ts?with-browser=' + Date.now()),
      import('../src/browser-transport.ts?find=' + Date.now()),
    ])
    const browser = findSystemBrowser()
    const state = resolveTransportState('chromium')
    if (browser) {
      assert.equal(state.effective, 'chromium')
      assert.equal(state.viaBrowserProxy, true)
      assert.equal(state.degraded, false)
    } else {
      assert.equal(state.effective, 'node')
      assert.equal(state.degraded, true)
    }
  })

  // 4. 浏览器 fetch 能走真实 HTTP 请求（对本地 server 发 POST + 流响应）
  await test('浏览器 fetch 可发送 POST 并读取响应', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const { createBrowserFetch, shutdownBrowserTransport, systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?integration=' + Date.now()
    )
    if (!systemBrowserAvailable()) {
      console.log('    (skip: 本机无 Edge/Chrome)')
      return
    }
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, path: req.url, received: body }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((r) => setTimeout(r, 200))
    const port = server.address().port
    // 🔴 2026-10-10：这条是**第一个真拉浏览器**的用例（后面的 FormData 复用同一个实例），
    //   所以全部冷启动开销都压在这里。
    //   Ubuntu runner 上 Chrome 冷启动常超过 `waitForTransportDebugPort` 的 25s
    //   （2026-10-10 实测：ubuntu 失败「浏览器调试端口未就绪」，而 macOS / Windows 同commit 通过
    //   —— 同一份代码、同一份夹具，**纯粹是机器快慢**）。
    // ⇒ 按本项目既有约定（`check-devtools.mjs:132`）**重试两次**：首次失败先
    //   `shutdownBrowserTransport()` 复位再试；两次都失败才算它真的坏了。
    //   🔴 别把 `waitForTransportDebugPort` 的超时调大来"修"这个 —— 那是产品代码的真实上限，
    //   为了 CI 放宽它会掩盖真问题。
    let lastErr
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const fetch = createBrowserFetch()
          const response = await fetch(`http://localhost:${port}/api/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-custom': 'ok' },
            body: JSON.stringify({ key: 'value' }),
          })
          assert.equal(response.status, 200)
          const json = await response.json()
          assert.equal(json.method, 'POST')
          assert.equal(json.received, JSON.stringify({ key: 'value' }))
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          await shutdownBrowserTransport()
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1500)) // 给进程回收与下次启动留余量
        }
      }
      if (lastErr) throw lastErr
    } finally {
      // ⚠️ 成功与失败**都要**收尾（改造重试时最容易漏掉这个 finally ⇒ 端口与浏览器进程泄漏）
      await new Promise((resolve) => server.close(resolve))
      await shutdownBrowserTransport()
    }
  })

  // 5. ★ FormData（multipart）—— 图片上传走的就是这条路
  // 0.6.20 的浏览器代理传输层只支持 string/Uint8Array/ArrayBuffer，遇到 FormData 直接抛
  // "暂不支持"，于是"切到浏览器代理之后图片全传不上去"（2026-10-01 用户报）。
  await test('★ 浏览器 fetch 能上传 FormData（图片上传走这条路）', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const { createBrowserFetch, shutdownBrowserTransport, systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?formdata=' + Date.now()
    )
    if (!systemBrowserAvailable()) {
      console.log('    (skip: 本机无 Edge/Chrome)')
      return
    }
    // PNG 的 8 字节魔数 —— 用来确认**文件字节真的到了**，而不只是表单结构对
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const text = body.toString('latin1')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            contentType: req.headers['content-type'] ?? '',
            filename: /filename="([^"]*)"/.exec(text)?.[1] ?? '',
            fileType: /Content-Type: ([^\r\n]+)/.exec(text)?.[1] ?? '',
            gotMagic: body.includes(PNG_MAGIC),
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((r) => setTimeout(r, 200))
    const port = server.address().port
    try {
      const fetch = createBrowserFetch()
      const form = new FormData()
      // 200 KB —— 真实图片的量级。不能只用 11 字节：那样测不出 base64 搬运/CDP 消息大小的问题。
      const payload = new Uint8Array(200_000).fill(7)
      payload.set(PNG_MAGIC, 0)
      // ⚠️ 必须带 filename：服务端按**文件名后缀**判图片类型（见 protocol.ts）
      form.append('file', new Blob([payload], { type: 'image/png' }), 'sample.png')
      const response = await fetch(`http://localhost:${port}/api/v0/file/upload_file`, {
        method: 'POST',
        // ⚠️ 不带 content-type：multipart 的 boundary 由浏览器自己加（带了反而会坏）
        headers: { 'x-ds-pow-response': 'pow' },
        body: form,
      })
      assert.equal(response.status, 200)
      const json = await response.json()
      assert.match(json.contentType, /^multipart\/form-data; boundary=/, `实际 content-type：${json.contentType}`)
      assert.equal(json.filename, 'sample.png', '文件名必须保住（服务端按后缀判类型）')
      assert.equal(json.fileType, 'image/png')
      assert.equal(json.gotMagic, true, '文件字节必须原样到达')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await shutdownBrowserTransport()
    }
  })

  console.log()
  console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过 OK')
  for (const failure of failures) console.log('  ' + failure)
  if (failures.length) process.exitCode = 1
}

await main()
