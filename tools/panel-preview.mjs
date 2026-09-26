#!/usr/bin/env node
/**
 * 面板预览 —— 从 `src/client/index.ts` 抽出样式表，套进一份静态 DOM 快照，
 * 生成可直接用浏览器打开的「浅色 / 深色」双栏预览。
 *
 * 用途：改面板 UI 时不必启动 DSH 就能看到真实效果。样式**每次从源码现读**，
 * 所以预览不会跟源码漂移（不存在"两份真相"）。
 *
 *   node tools/panel-preview.mjs [输出路径]
 *
 * 默认输出到系统临时目录，打印出绝对路径。
 * 注意：DOM 快照是手写的**结构代表**（覆盖面板里出现的每一类元素），
 * 不是真实渲染结果 —— 它服务于"看排版/间距/状态"，不负责验证功能。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const src = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

const styleMatch = src.match(/const styles = `([\s\S]*?)`/)
if (!styleMatch) {
  console.error('未能从 src/client/index.ts 抽出 styles 常量（正则没匹配上，检查它是否被改名/改写成非模板字符串）')
  process.exit(1)
}
const styles = styleMatch[1]

// 暗色兜底变量藏在 prefers-color-scheme 里；预览需要手动应用到右栏，所以提出来复用。
const darkMatch = styles.match(/@media \(prefers-color-scheme:dark\)\{\s*\.dsw-page\{([^}]*)\}\s*\}/)
if (!darkMatch) {
  console.error('未找到 prefers-color-scheme 的暗色兜底段')
  process.exit(1)
}
const darkVars = darkMatch[1].trim()

/** 模拟宿主令牌 —— 预览用。真实值由 DSH 注入，这里只求观感接近。 */
const hostLight = `
--dsw-alias-label-primary:#1f2329;--dsw-alias-label-secondary:#5c636e;--dsw-alias-label-tertiary:#8f96a3;
--dsw-alias-bg-layer-1:#f4f5f7;--dsw-alias-bg-layer-2:#ffffff;
--dsw-alias-border-l1:#e7e9ed;--dsw-alias-border-l2:#d5d8de;
--dsw-alias-interactive-bg-hover:rgba(15,23,42,.055);
--dsw-alias-markdown-code-block:#f2f3f5;
--dsw-alias-brand-primary:#4a6cf7;--dsw-alias-state-success-primary:#159a55;
--dsw-alias-state-warn-label:#a06a00;--dsw-alias-state-error-primary:#d93a2b;`

const hostDark = `
--dsw-alias-label-primary:#e9eaec;--dsw-alias-label-secondary:#a8aeb8;--dsw-alias-label-tertiary:#767d88;
--dsw-alias-bg-layer-1:#1d1d1f;--dsw-alias-bg-layer-2:#262628;
--dsw-alias-border-l1:#333438;--dsw-alias-border-l2:#424347;
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);
--dsw-alias-markdown-code-block:#1a1a1c;
--dsw-alias-brand-primary:#5b7cfa;--dsw-alias-state-success-primary:#3fbf76;
--dsw-alias-state-warn-label:#d8a13a;--dsw-alias-state-error-primary:#f0665a;`

const kv = (...pairs) =>
  `<div class="dsw-kv">${pairs.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join('')}</div>`

const spark = `<svg class="dsw-spark" viewBox="0 0 320 40" preserveAspectRatio="none">${Array.from(
  { length: 40 },
  (_, i) => `<rect x="${i * 8}" y="${40 - (8 + ((i * 7) % 26))}" width="5" height="${8 + ((i * 7) % 26)}"${i % 11 === 3 ? ' class="bad"' : i % 5 === 0 ? ' class="on"' : ''}></rect>`
).join('')}</svg>`

/** DOM 快照 —— 覆盖面板里出现的每一类元素，顺序贴近真实页面。 */
const demo = `
<div class="dsw-page">
  <h1 class="dsw-title">DeepSeek 网页登录（免费模型）</h1>
  <p class="dsw-sub">用 <span class="dsw-nobreak">chat.deepseek.com</span> 网页版登录态驱动 DSH agent —— 不需要 API Key。provider 路由：<span class="dsw-nobreak">deepseek-web</span></p>

  <div class="dsw-alert ok">已保存「请求间隔」设置</div>

  <div class="dsw-tabs">
    <button class="dsw-tab active">账号</button><button class="dsw-tab">模型</button>
    <button class="dsw-tab">防风控</button><button class="dsw-tab">传输层</button>
    <button class="dsw-tab">上下文</button><button class="dsw-tab">关于</button>
  </div>

  <div class="dsw-subtabs">
    <button class="dsw-subtab active">登录</button><button class="dsw-subtab">账号库</button>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">登录状态 <span class="dsw-badge on">已捕获（未校验）</span></div>
    ${kv(
      ['适配器注册', '✅ deepseek-web 已注册到 llm'],
      ['账号', '143******@qq.com'],
      ['捕获时间', '2026/9/11 11:08:35'],
      ['凭证来源', '浏览器登录捕获（token + cookie + 指纹头，登录态通常更耐久）'],
      ['Cookie', '✅ 已捕获'],
      ['指纹头', '未捕获 —— 同上，已实测可用'],
      ['token 长度', '64 字符'],
      ['服务端校验', '通过']
    )}
    <div class="dsw-row" style="margin-top:10px">
      <button class="dsw-btn">用 Microsoft Edge 登录</button>
      <button class="dsw-btn ghost">用我的默认浏览器登录</button>
      <button class="dsw-btn ghost">从已登录窗口恢复</button>
    </div>
    <div class="dsw-row" style="margin-top:8px"><button class="dsw-btn ghost">刷新状态</button></div>
    <p class="dsw-hint">「用我的默认浏览器登录」= 用系统浏览器打开 chat.deepseek.com（网页端若提示「使用环境异常」，走这条）。外部浏览器的登录态插件抓不到，要用 F12 控制台取 token 粘到下面那张卡。</p>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">当前账号</div>
    ${kv(['账号', '143******@qq.com'], ['登录时间', '2026/9/11 11:08:35'])}
    <div class="dsw-row" style="margin-top:10px">
      <button class="dsw-btn danger armed">确认退出？</button>
      <button class="dsw-btn ghost" disabled>退出并登录其它账号</button>
    </div>
    <p class="dsw-hint">退出会同时清除本地凭证与浏览器分区里的 chat.deepseek.com 登录态。</p>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">账号库 <span class="dsw-badge off">3 个账号</span></div>
    <div class="dsw-grouphead">
      <span class="gtoggle">▾</span><span class="gname">工作</span><span class="gcount">2</span>
      <span class="gspacer"></span><button class="dsw-btn ghost">改名</button><button class="dsw-btn ghost">删除组</button>
    </div>
    <div class="dsw-accounts">
      <div class="dsw-account active">
        <div class="dsw-account-main">
          <div class="dsw-account-title">143******@qq.com <span class="dsw-badge on">当前</span><span class="dsw-badge off">限流至 21:30</span></div>
          <div class="dsw-account-meta">捕获于 2026/9/11 11:08 · 今日 164 次调用</div>
        </div>
        <div class="dsw-account-actions">
          <button class="dsw-btn ghost">重登</button><button class="dsw-btn ghost">校验</button>
          <select class="dsw-groupsel"><option>工作</option><option>未分组</option></select>
          <button class="dsw-btn danger">删除</button>
        </div>
      </div>
      <div class="dsw-account grouped">
        <div class="dsw-account-main">
          <div class="dsw-account-title">199******@163.com <span class="dsw-badge err">已失效</span></div>
          <div class="dsw-account-meta">捕获于 2026/9/10 22:41 · 未校验</div>
          <div class="dsw-account-fix">
            <input class="dsw-labelinput" placeholder="备注名（如：备用号）">
            <button class="dsw-btn ghost">保存备注</button>
          </div>
        </div>
      </div>
    </div>
    <div class="dsw-row" style="margin-top:10px">
      <button class="dsw-btn ghost">导出账号库</button><button class="dsw-btn ghost">导入账号库</button>
    </div>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">请求节流</div>
    <div class="dsw-gate-row">
      <label class="dsw-switch"><input type="checkbox"><span class="dsw-switch-track"></span><span>允许并发生成</span></label>
      <label class="dsw-switch"><input type="checkbox" checked><span class="dsw-switch-track"></span><span>退出时清理网页端会话</span></label>
    </div>
    <div class="dsw-gate-row">
      <span class="dsw-gate-label">请求间隔</span>
      <div class="dsw-range-pair">
        <input type="range" class="dsw-range" value="30"><input type="range" class="dsw-range" value="60">
      </div>
      <span class="dsw-gate-pair-value">2~4 秒</span>
    </div>
    <div class="dsw-gate-row">
      <span class="dsw-gate-label">长休阈值</span>
      <input type="range" class="dsw-range" value="15"><span class="dsw-gate-value">15 次</span>
    </div>
    <div class="dsw-gate-row">
      <span class="dsw-gate-label">图片上限</span>
      <input type="range" class="dsw-range" value="24"><span class="dsw-gate-value">24 份</span>
    </div>
    <div class="dsw-gate-row">
      <span class="dsw-gate-label">上下文</span>
      <input type="range" class="dsw-range" min="0" max="5" step="1" value="2"><span class="dsw-gate-value">128K</span>
    </div>
    <p class="dsw-hint">声明 128K：DSH 会更早压缩/截断历史，每轮重发的转写因此更短。这只是声明值，不改模型真实能力；想彻底压住单次体量，上面的「prompt 上限」也要一起调。</p>
    <div class="dsw-gate-row">
      <span class="dsw-gate-label">自动换号</span>
      <input type="range" class="dsw-range" min="0" max="120" step="1" value="30"><span class="dsw-gate-pair-value">30 分钟</span>
    </div>
    <p class="dsw-hint">每 30 分钟换到账号库里的下一个可用账号（失效或正在受限的会跳过；可用的不足两个就不换）。换号会让投喂链断掉：下一轮要全量重发，历史图也要重新上传 —— 间隔越短，这个代价出现得越频繁。</p>
    <div class="dsw-row">
      <button class="dsw-btn ghost dsw-preset active">保守</button>
      <button class="dsw-btn ghost dsw-preset">均衡</button>
      <button class="dsw-btn ghost dsw-preset">激进</button>
    </div>
    <p class="dsw-gate-msg">当前：每 2~4 秒发一个请求，连续 15 次后休息 30~90 秒。</p>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">调用台账</div>
    ${spark}
    ${kv(['今日调用', '164 次'], ['今日 tokens', '1042.8 万'], ['失败', '3 次'])}
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">手动粘贴 Token（可选路径）</div>
    <textarea class="dsw-area" placeholder="粘贴 token（纯字符串或 JSON 均可）"></textarea>
    <div class="dsw-row" style="margin-top:8px">
      <button class="dsw-btn">校验并保存</button><button class="dsw-btn ghost">清空</button>
    </div>
    <div class="dsw-msg err">凭证校验失败：invalid token（HTTP 401）</div>
  </div>

  <div class="dsw-card">
    <div class="dsw-cardhead">数据位置</div>
    <div class="dsw-kv">
      <div class="k">配置</div><div class="dsw-path">C:\\Users\\29436\\.dsh\\web-login\\gate.json</div>
      <div class="k">账号库</div><div class="dsw-path">C:\\Users\\29436\\.dsh\\web-login\\accounts.json</div>
    </div>
    <code class="dsw-code">dsh plugin add ./dsh-deepseek-web-login-0.2.1.tgz</code>
  </div>
</div>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 面板预览 · 浅色 / 深色</title>
<style>
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{display:grid;grid-template-columns:1fr 1fr;min-height:100vh}
.col{padding:20px 26px 80px}
.col.light{background:#eceef2}
.col.dark{background:#141416}
.col > .tag{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;margin:0 0 14px;color:#8b93a3}
${styles}
.col.light .dsw-page{${hostLight}}
.col.dark .dsw-page{${hostDark}${darkVars}}
.col.dark .dsw-title,.col.dark .dsw-cardhead{color:var(--fg)}
</style>
</head>
<body>
<div class="wrap">
  <section class="col light"><p class="tag">Light</p>${demo}</section>
  <section class="col dark"><p class="tag">Dark</p>${demo}</section>
</div>
</body>
</html>`

const out = resolve(process.argv[2] ?? join(tmpdir(), 'dsh-panel-preview.html'))
writeFileSync(out, html, 'utf8')
console.log(out)
