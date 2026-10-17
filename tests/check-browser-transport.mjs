/**
 * 回归：浏览器代理传输层（官方 DSH 桌面端 fallback）。
 *
 * 当 Electron 的 `net.fetch` 不可用时，用系统 Edge/Chrome 进程代理请求，
 * 让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 用法: node tests/check-browser-transport.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-browser-transport-'))
process.env.DSH_HOME = HOME

/** `PROFILE_DIR` 是模块加载时按 `DSH_HOME` 定下的，所以本文件必须和产品算同一份。 */
const PROFILE_DIR = join(HOME, 'web-login', 'transport-profile')

/**
 * 是否允许本文件真启浏览器。
 *
 * 🔴 离线跑批（`scripts/test-offline.mjs`）会给每个子进程钉上 `DSH_NO_BROWSER_TRANSPORT=1`
 *   ⇒ 下面那些"真启浏览器"的用例会走各自的 skip 分支。要手动验证浏览器路径：
 *   `DSH_BROWSER_TESTS=1 node tests/check-browser-transport.mjs`（**别放进 CI**）。
 *
 * 为什么要这样分工（2026-10-14 实测）：
 *   - 跑批**不许**与"这台机器碰巧有没有 Edge/Chrome"有关。ubuntu runner 上
 *     `systemBrowserAvailable()` 为 false ⇒ 整套跳过；win/mac 上它为 true ⇒ 真启浏览器。
 *     同一个提交在两个平台跑的是**两件事**，而且真启那条在冷 runner 上轮流报红、
 *     失败时**零输出**（退出码 1、连一条 ✓ 都没有），无法归因。
 *   - ⚠️ 本文件最后一条用例断言的是**重载后**页面里的 `userToken`，而写进去的是**假 token**
 *     （`SESSION-TOKEN-TEST`）：站点自己的 JS 会把它归一化成未登录形态
 *     `{"value":null,"__version":"0"}` —— 读到的值与"站点鉴权请求的网络时序"赛跑，
 *     于是同一条用例时红时绿（本机与 CI 都复现过）。
 *     ⇒ 要真验"页面认得自己已登录"必须用**真账号**，不能用假 token。
 */
const allowBrowserLaunch = process.env.DSH_BROWSER_TESTS === '1'

/** 只有显式允许时才摘掉跑批钉上的开关。 */
function allowBrowserForThisCase() {
  if (allowBrowserLaunch) delete process.env.DSH_NO_BROWSER_TRANSPORT
}

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

  // 3. resolveTransportState 的选择规则
  await test('resolveTransportState 必须与 systemBrowserAvailable 同答', async () => {
    allowBrowserForThisCase()
    const [{ resolveTransportState }, { systemBrowserAvailable, findSystemBrowser }] = await Promise.all([
      import('../src/transport.ts?with-browser=' + Date.now()),
      import('../src/browser-transport.ts?find=' + Date.now()),
    ])
    // 🔴 判据必须与产品**同源**：`findSystemBrowser()` 只看"二进制文件在不在"，
    //   而产品走的是 `systemBrowserAvailable()`（还看平台能不能真跑、以及开关）。
    //   2026-10-14 实测：ubuntu runner 上"文件在"但"跑不起来"（非 root 起不来 headless），
    //   旧写法拿前者当条件去断言后者 ⇒ `'node' !== 'chromium'` 报红；
    //   同一个提交在 win/mac 上又是另一种形态（真启浏览器、与站点行为赛跑）。
    const usable = systemBrowserAvailable()
    const binary = findSystemBrowser()
    const state = resolveTransportState('chromium')
    if (usable) {
      assert.equal(state.effective, 'chromium', `可用时必须走浏览器代理（二进制探针=${binary ? '有' : '无'}）`)
      assert.equal(state.viaBrowserProxy, true)
      assert.equal(state.degraded, false)
    } else {
      assert.equal(state.effective, 'node', `不可用时必须走 node（二进制探针=${binary ? '有' : '无'}）`)
      assert.equal(state.degraded, true)
    }
  })

  // 4. 浏览器 fetch 能走真实 HTTP 请求（对本地 server 发 POST + 流响应）
  await test('浏览器 fetch 可发送 POST 并读取响应', async () => {
    allowBrowserForThisCase()
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
    allowBrowserForThisCase()
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

  // ── 2026-10-14：让传输层更像真浏览器（站对 origin + cookie 真的发出去）──────────

  // 6. 站点 origin 常量不许和 webapi 的 DS_BASE 漂移
  await test('TRANSPORT_SITE_ORIGIN 与 webapi 的 DS_BASE 一致（防漂移）', async () => {
    const [{ TRANSPORT_SITE_ORIGIN }, { DS_BASE }] = await Promise.all([
      import('../src/browser-transport.ts?origin=' + Date.now()),
      import('../src/webapi.ts?dsbase=' + Date.now()),
    ])
    // browser-transport 故意不 import webapi 的常量（会形成循环依赖），所以这里守相等
    assert.equal(TRANSPORT_SITE_ORIGIN, DS_BASE)
  })

  // 7. 启动参数：必须落在站点 origin 上，不能是 about:blank
  await test('传输层浏览器启动在站点 origin（不是 about:blank）', async () => {
    const { transportBrowserArgs, TRANSPORT_SITE_ORIGIN } = await import(
      '../src/browser-transport.ts?args=' + Date.now()
    )
    const profileDir = '/tmp/whatever-profile'
    const args = transportBrowserArgs(profileDir)
    assert.ok(
      args.includes(`${TRANSPORT_SITE_ORIGIN}/`),
      `启动 URL 必须是站点自己 —— Origin/Referer/Sec-Fetch-* 只能靠"页面站在那个 origin 上"才对。实际参数：${JSON.stringify(args)}`,
    )
    assert.ok(!args.includes('about:blank'), 'about:blank 会让每个请求的 Origin 都不是站点的')
    assert.ok(args.includes('--headless=new'), '仍是 headless 传输层')
    assert.ok(
      args.includes(`--user-data-dir=${profileDir}`),
      '启动参数里的 profile 必须就是传进来的那个目录',
    )
  })

  // 8. 🔴 页面 JS 眼里的环境不能是"自动化指纹"（2026-10-15 实测：站点弹「使用环境异常」，
  //    CDP 探针读到的三个实锤：UA=HeadlessChrome、webdriver=true、WebGL=软件渲染）
  await test('传输层页面的 UA / webdriver / WebGL 不许是自动化指纹', async () => {
    const { transportBrowserArgs } = await import(
      '../src/browser-transport.ts?args-fp=' + Date.now()
    )
    const realUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0'
    const args = transportBrowserArgs('/tmp/fp-profile', realUa)
    assert.ok(
      args.includes(`--user-agent=${realUa}`),
      `页面 UA 必须用账号捕获的那份真实 UA（与请求头一致）。实际：${JSON.stringify(args)}`,
    )
    assert.ok(
      args.includes('--disable-blink-features=AutomationControlled'),
      'navigator.webdriver 必须回到 false（headless 自己会把它置 true）',
    )
    assert.ok(
      !args.includes('--disable-gpu'),
      '--disable-gpu 会把 WebGL 逼成软件渲染（Basic Render Driver）—— 那是 headless 的经典指纹',
    )
    assert.ok(
      !args.some((a) => a.startsWith('--user-agent=') && /Headless/i.test(a)),
      'UA 里不许出现 Headless 字样',
    )
    // 没有真实 UA 就宁可不传 —— 编一个"看起来像 Edge"的比留空更假
    const bare = transportBrowserArgs('/tmp/fp-profile-2')
    assert.ok(
      !bare.some((a) => a.startsWith('--user-agent=')),
      '没有账号 UA 时不该传 --user-agent（不许编造）',
    )
  })

  // 8. 禁止头必须被剥掉（交给页面 fetch 会被静默丢弃）
  await test('禁止头被剥离：cookie/origin/referer 不交给页面 fetch', async () => {
    const { splitBrowserFetchHeaders } = await import('../src/browser-transport.ts?headers=' + Date.now())
    const result = splitBrowserFetchHeaders({
      authorization: 'Bearer t',
      'content-type': 'application/json',
      cookie: 'a=1; b=2',
      origin: 'https://example.com',
      referer: 'https://example.com/',
      host: 'chat.deepseek.com',
      'x-hif-dliq': 'hif',
      'x-ds-pow-response': 'pow',
      'user-agent': 'UA',
    })
    // 保留的
    assert.equal(result.headers.authorization, 'Bearer t')
    assert.equal(result.headers['content-type'], 'application/json')
    assert.equal(result.headers['x-hif-dliq'], 'hif')
    assert.equal(result.headers['x-ds-pow-response'], 'pow')
    assert.equal(result.headers['user-agent'], 'UA')
    // 剥掉的 —— 注意大小写不敏感
    assert.ok(!('cookie' in result.headers), 'cookie 是禁止头，交给页面 fetch 会被静默丢掉')
    assert.ok(!('origin' in result.headers), 'origin 是禁止头，脚本补不了')
    assert.ok(!('referer' in result.headers))
    assert.ok(!('host' in result.headers))
    // 原始值要带出来（改走 CDP 安装）
    assert.equal(result.cookieHeader, 'a=1; b=2')
    assert.deepEqual(result.stripped.sort(), ['cookie', 'host', 'origin', 'referer'])
  })

  // 9. cookie 头解析的边界
  await test('parseCookieHeader 的边界：值含 = / 无值 / 空格 / 空串', async () => {
    const { parseCookieHeader } = await import('../src/browser-transport.ts?cookie=' + Date.now())
    assert.deepEqual(parseCookieHeader(''), [])
    assert.deepEqual(parseCookieHeader('a=1'), [{ name: 'a', value: '1' }])
    assert.deepEqual(parseCookieHeader(' a = 1 ; b = 2 '), [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
    // 🔴 值里含 `=`（base64 padding 很常见）—— 必须用**第一个** `=` 切分
    assert.deepEqual(parseCookieHeader('t=YWJjZA=='), [{ name: 't', value: 'YWJjZA==' }])
    // 没有 `=` 的片段整条丢掉（不是产出空值）
    assert.deepEqual(parseCookieHeader('flag; a=1'), [{ name: 'a', value: '1' }])
    // 空名丢掉
    assert.deepEqual(parseCookieHeader('=1; a=2'), [{ name: 'a', value: '2' }])
  })

  // 10. 转成 CDP setCookie 参数
  await test('cookiesForCdp 按请求 origin 生成 setCookie 参数', async () => {
    const { cookiesForCdp } = await import('../src/browser-transport.ts?cdp=' + Date.now())
    assert.deepEqual(cookiesForCdp('a=1; b=2', 'https://chat.deepseek.com/'), [
      { name: 'a', value: '1', url: 'https://chat.deepseek.com/', path: '/' },
      { name: 'b', value: '2', url: 'https://chat.deepseek.com/', path: '/' },
    ])
    assert.deepEqual(cookiesForCdp('', 'https://chat.deepseek.com/'), [])
  })

  // 11. cookie 的**机制级**验证：必须走 CDP `Network.setCookie`，而不是交给页面 fetch
  //
  // 🔴 为什么不在这里做"服务端真的收到 cookie"的端到端断言（试过，做不到）：
  //    传输层的页面现在站在 `https://chat.deepseek.com`，而夹具服务在 `http://localhost:PORT`
  //    ⇒ 这是**跨站**请求，Chromium 默认的 `SameSite=Lax` 不会为跨站子资源附带 cookie；
  //    想绕过就得加 `sameSite=no_restriction`，而它**强制要求 `secure`**，
  //    于是 http 请求又不可能带上。两头堵死 —— **这是夹具的局限，不是产品缺陷**：
  //    生产里页面与 API 同源（都是 chat.deepseek.com），SameSite=Lax 照常发送。
  //    ⇒ 所以这里守"我们发出了什么 CDP 调用"，机制正确性由它保证；
  //      真机行为靠"重启后跑一轮真实对话"验证（见 _ref/webview-vs-transport-2026-10-14.md）。
  await test('★ cookie 走 CDP Network.setCookie（精确断言调用序列）', async () => {
    const { installCookiesViaCdp } = await import('../src/browser-transport.ts?instc=' + Date.now())
    const calls = []
    const fakeCdp = {
      send: async (method, params) => {
        calls.push([method, params])
        return method === 'Network.setCookie' ? { success: true } : {}
      },
    }
    const installed = await installCookiesViaCdp(
      fakeCdp,
      'a=1; t=YWJjZA==',
      'https://chat.deepseek.com/api/v0/chat/completion',
    )
    assert.equal(installed, 2)
    assert.equal(calls[0][0], 'Network.enable', '先 enable 再 setCookie')
    const setCookie = calls.filter(([method]) => method === 'Network.setCookie').map(([, params]) => params)
    assert.deepEqual(setCookie, [
      { name: 'a', value: '1', url: 'https://chat.deepseek.com/', path: '/' },
      { name: 't', value: 'YWJjZA==', url: 'https://chat.deepseek.com/', path: '/' },
    ])
  })

  await test('cookie 安装失败必须被计数（setCookie 返回 success:false 而不是抛错）', async () => {
    const { installCookiesViaCdp } = await import('../src/browser-transport.ts?instfail=' + Date.now())
    const fakeCdp = { send: async () => ({ success: false }) }
    assert.equal(
      await installCookiesViaCdp(fakeCdp, 'a=1', 'https://chat.deepseek.com/'),
      0,
      '看不看返回值决定"cookie 静默丢失"会不会再发生一次',
    )
    // 没有 cookie 时不该白发 CDP 调用
    const calls = []
    const recording = { send: async (m, p) => { calls.push([m, p]); return {} } }
    assert.equal(await installCookiesViaCdp(recording, '', 'https://chat.deepseek.com/'), 0)
    assert.equal(calls.length, 0)
    // URL 不合法时也不能炸
    assert.equal(await installCookiesViaCdp(recording, 'a=1', 'not-a-url'), 0)
  })

  // 12. 接线守卫：函数写对了但没被调用 = 假绿（本项目踩过多次的坑）
  //     判据打在**真实入口** `createBrowserFetch` 的函数体上，且先剥掉注释再匹配
  //     （否则一句注释里的函数名就能把这条守卫喂饱）。
  await test('createBrowserFetch 真的调用了剥头与 cookie 安装', async () => {
    const source = readFileSync(join(import.meta.dirname, '../src/browser-transport.ts'), 'utf8')
    const start = source.indexOf('export function createBrowserFetch')
    assert.ok(start > 0, '自证：找得到 createBrowserFetch')
    const rest = source.slice(start + 1)
    const end = rest.indexOf('\nexport function ')
    const body = (end < 0 ? rest : rest.slice(0, end))
      // 粗剥注释：行注释 + 块注释。注释里出现函数名不算调用。
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      body.includes('splitBrowserFetchHeaders('),
      'createBrowserFetch 必须把请求头过一遍剥头 —— 直接交给页面 fetch 会把 cookie 静默丢掉',
    )
    assert.ok(
      body.includes('installCookiesViaCdp('),
      'createBrowserFetch 必须真的安装 cookie —— 光有这个函数不算，得有人调它',
    )
    assert.ok(
      body.includes('installPageSessionViaCdp('),
      'createBrowserFetch 必须真的把登录态装进页面 —— 只装 cookie 的话页面仍是"未登录"',
    )
    assert.ok(
      body.includes('reinstallPageBindings('),
      '重载页面后必须重装回调通道 —— 绑定丢了请求会以"莫名其妙失败"的形态出现',
    )
  })

  // 13. ★ 行为级守卫：首次请求把登录态写进传输层**页面**的 localStorage。
  //     只装 cookie 不够 —— 网页端登录态读的是 `localStorage.userToken`；
  //     页面认为未登录 ⇒ 站点自己的 JS 不会跑（没有会话轮询/长连接）
  //     ⇒ 而我们的请求却带合法 Bearer = 真人身上不会出现的组合。
  //
  //     ⚠️ 这条要真启浏览器、真发请求，并需要能访问站点 origin
  //     （localStorage 在 about:blank 这种 opaque origin 上直接不可用）。
  await test('★ 首次请求把登录态写进传输层页面（页面不再是"未登录"）', async () => {
    const {
      createBrowserFetch,
      launchBrowserTransport,
      shutdownBrowserTransport,
      systemBrowserAvailable,
      TRANSPORT_SITE_ORIGIN,
    } = await import('../src/browser-transport.ts?session=' + Date.now())
    if (!systemBrowserAvailable()) {
      console.log('    （本机没有 Edge/Chrome，跳过）')
      return
    }
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const browserFetch = createBrowserFetch()
      const response = await browserFetch(`http://127.0.0.1:${port}/probe`, {
        method: 'POST',
        headers: { authorization: 'Bearer SESSION-TOKEN-TEST', 'x-hif-leim': 'LEIM-TEST' },
        body: '{}',
      })
      await response.text()

      const session = await launchBrowserTransport()
      const read = await session.cdp.send('Runtime.evaluate', {
        expression:
          'JSON.stringify((function(){try{' +
          'return {o: location.origin, r: document.readyState,' +
          ' t: localStorage.getItem("userToken"), l: localStorage.getItem("hif_leim_cached")};' +
          '}catch(e){return {o: location.origin, r: document.readyState, err: String(e)};}})())',
        returnByValue: true,
      })
      const seen = JSON.parse(read?.result?.value ?? 'null')
      assert.ok(
        seen,
        '自证：读得到传输层页面的状态。exceptionDetails=' +
          JSON.stringify(read?.exceptionDetails ?? null),
      )
      assert.equal(
        seen.o,
        TRANSPORT_SITE_ORIGIN,
        '前置条件失败：传输层页面没停在站点 origin（`ensureSiteOrigin` 超时 / 网络不通）—— ' +
          '此时 localStorage 是 opaque origin，登录态根本写不进去。**这不是凭证问题**。' +
          `实际 origin=${String(seen.o)}` +
          (seen.err ? `，localStorage 报错=${seen.err}` : ''),
      )
      assert.ok(
        seen.t && JSON.parse(seen.t).value === 'SESSION-TOKEN-TEST',
        `页面 localStorage 里必须是**解包后**的登录态（网页端就是这么读的）。实际：${String(seen.t)}`,
      )
      assert.equal(JSON.parse(seen.l ?? 'null'), 'LEIM-TEST')
      // 重载必须已经完成 —— 站点 JS 是在启动时读 userToken 的，没重载等于没装。
      assert.ok(
        seen.r === 'interactive' || seen.r === 'complete',
        `装完登录态后页面应当已重载完成，实际 readyState=${String(seen.r)}`,
      )
    } finally {
      await shutdownBrowserTransport()
      server.close()
    }
  })

  // 17. 🔴 Windows：上一次的浏览器还占着 profile 文件时，清 profile **不许**把启动卡死
  //
  //    2026-10-17 实测（Windows 11 + Edge 155）：headless 浏览器是多进程的，主进程死后
  //    仍有约 10 个 msedge.exe 持有 `--user-data-dir` 下文件的独占句柄。旧实现在这里
  //    直接 `rmSync` ⇒ `EPERM` ⇒ `清理 transport profile 失败：…` ⇒ **每次启动都失败**，
  //    而报错文本跟真实原因（"上一批进程还活着"）毫无关联。
  //
  //    这条用例用 PowerShell 的独占句柄模拟"上一次的浏览器还没走干净"：
  //    句柄挂在 profile 里的一个**普通文件**上（Edge 锁的正是这类文件）。
  //
  //    ⚠️ 判据是"启动没被清理卡死"，不是"干净删掉了"。补丁的价值在于**绝不阻断启动**，
  //    不是当一个万能清理器 —— 删不掉是允许的结果。
  //
  //    ⚠️ 故意锁一个**自造的小文件**、不锁 `Local State` 这类浏览器自己要写的文件：
  //    锁住真文件会把浏览器自己搞起不来，那时失败原因就不是清理逻辑了，用例会失去归因力。
  await test('★ Windows：profile 被占用时清理不许阻断启动（EPERM 回归）', async () => {
    if (process.platform !== 'win32') {
      console.log('    (skip: 本用例模拟的是 Windows 的独占句柄语义)')
      return
    }
    // 先用**正常路径**把 transport 跑起来，让插件自己写出一个真实的 profile，
    // 再关掉它 —— 这才是"上一次留下的 profile"。
    //
    // 🔴 不能自己 `mkdirSync(PROFILE_DIR)` 造一个空目录来省事：空目录在没有句柄时
    //   `rmSync` 是能成功的，用例会**在坏实现上也是绿的**（反向验证实测过）。
    //   必须让目录里装着真浏览器写出来的东西。
    const {
      launchBrowserTransport,
      shutdownBrowserTransport,
      systemBrowserAvailable,
    } = await import('../src/browser-transport.ts?ebusy=' + Date.now())
    if (!systemBrowserAvailable()) {
      console.log('    (skip: 本机无 Edge/Chrome，无法真启浏览器验证)')
      return
    }
    await launchBrowserTransport()
    await shutdownBrowserTransport()
    assert.ok(existsSync(PROFILE_DIR), '前置条件：正常跑过一次之后 profile 目录应当存在')
    // 让被 kill 的子进程把句柄放干净，否则这里已经是"占用中"了，测的就不是下一轮启动
    await new Promise((r) => setTimeout(r, 1_500))
    assert.ok(readdirSync(PROFILE_DIR).length > 0, '前置条件：profile 里得有真浏览器写的文件')

    const lockedFile = join(PROFILE_DIR, 'locked-by-previous-run.bin')
    writeFileSync(lockedFile, '占位')

    // 用独立进程持有句柄（本进程去开句柄会把自己的事件循环占住，没必要）。
    // FileShare.Read 是 Edge 的典型形态：别人能读，但删不掉、也搬不走整个目录。
    const holder = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `$f = [System.IO.File]::Open('${lockedFile}', 'Open', 'Read', 'Read')`,
          `Write-Output 'READY'`,
          `Start-Sleep -Milliseconds 6000`,
          `$f.Close()`,
        ].join('; '),
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    assert.ok(holder.includes('READY'), `前置条件：句柄持有进程没起来。实际输出=${holder}`)

    // 句柄已持有 ⇒ 现在跑真正的清理 + 启动。旧实现会在这里抛
    // `清理 transport profile 失败：EPERM …`，新实现必须走通。
    try {
      // ① 清理阶段不许抛 —— 这是本用例的主判据
      let session
      try {
        session = await launchBrowserTransport()
      } catch (error) {
        assert.fail(
          `profile 被占用时启动被清理卡死了（EPERM 回归）。真实原因应当是` +
            `"上一批浏览器进程还活着"，但用户看到的是：${error?.message ?? error}`,
        )
      }
      assert.ok(session?.child?.pid, '启动必须拿到一个真的浏览器进程')

      // ② 目录必须重新就位：浏览器要能在里面写自己的状态
      assert.ok(existsSync(PROFILE_DIR), '清理之后必须重建 profile 目录')
    } finally {
      await shutdownBrowserTransport()
    }
  })

  // 18. 收尾：残留的 `.stale-*` 不能无限堆积
  //
  //    "改名 + best-effort 删除"这条路径的代价是：句柄没放开时删不掉就等于多留一份
  //    几十 MB 的目录。允许留**一份**（留给下次启动再试），但不许每启动一次多一份。
  await test('★ 失败的清理不会让 .stale-* 目录无限堆积', async () => {
    const root = join(HOME, 'web-login')
    if (!existsSync(root)) {
      console.log('    (skip: 上一条用例没跑真启浏览器，没有产生 stale 目录)')
      return
    }
    const stale = readdirSync(root).filter((n) => basename(n).startsWith('transport-profile.stale-'))
    assert.ok(
      stale.length <= 1,
      `最多允许留一份待清理的旧 profile（留给下次启动重试），实际有 ${stale.length} 份：${stale.join(', ')}`,
    )
  })

  console.log()
  console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过 OK')
  for (const failure of failures) console.log('  ' + failure)
  if (failures.length) process.exitCode = 1
}

await main()
