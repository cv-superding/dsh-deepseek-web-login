/**
 * dsh-deepseek-web-login — client 设置页（slots: settings.section）。
 *
 * 与 host 通过同源 fetch 通信：/deepseek-web-login/api/*
 * 渲染契约（沿用生态实测结论）：槽位 register 必须带 name 字段，
 * 渲染函数返回 React 元素（createElement），React #130 的坑即来自返回非元素。
 */
import { createElement, useEffect, useRef, useState } from 'react'

type ClientContext = {
  slots: any
}

export const inject = ['slots']

const API = '/deepseek-web-login/api'

interface StatusPayload {
  provider: string
  registeredProviders?: string[]
  electron: boolean
  loginCapability?: { processType: string; canOpenWindow: boolean; browser: string | null }
  loginWindowOpen: boolean
  loginProgress: { open: boolean; startedAt?: string; captured?: { token: boolean; cookie: boolean; fingerprint: boolean; wasm: boolean }; lastError?: string; finished?: boolean }
  fingerprint?: { at: string; url: string; stripped: string[]; pageUa?: string; pageBrands?: string[]; pageWebdriver?: boolean }
  lastLoginResult?: { ok: boolean; message: string; at: string }
  auth: { loggedIn: boolean; display?: string; capturedAt?: string; hasCookie: boolean; hasFingerprint: boolean; wasmHost?: string; unverified?: boolean; tokenLength?: number }
  validation?: { ok: boolean; error?: string }
  models: { id: string; name: string; description: string; modelType: string; thinking: boolean; contextWindow: number }[]
  config: {
    maxPromptChars: number
    idleTimeoutMs: number
    deleteWebSessions: boolean
    allowConcurrent?: boolean
    minRequestIntervalMs?: number
  }
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return await response.json()
}

/**
 * 样式表 —— 全部走宿主的主题令牌（`--dsw-alias-*`）。
 *
 * 历史坑（2026-09-12 用户实测）：以前用的是 `var(--theme-text, #ddd)` 这套**并不存在**的变量名，
 * 于是每个颜色都落到兜底值上；兜底又全是深色 → 浅色主题下整个面板仍是黑底，
 * 灰色文字贴在深底上几乎读不出来。
 *
 * 现在的做法：
 *  1. 颜色优先取宿主令牌（`--dsw-alias-label-primary` / `bg-layer-*` / `border-l*` / `state-*` …），
 *     这些令牌由 DSH 按当前主题（浅 / 深 / 皮肤）重定义，插件无需自己判断主题；
 *  2. 令牌缺失时（老宿主 / 令牌改名）退回 `--fb-*`，而 `--fb-*` 由 `prefers-color-scheme` 切换，
 *     保证「浅色主题不会出现黑界面」这条底线永远成立；
 *  3. 正文改用系统无衬线字体（原来是等宽字体铺满全屏，观感像终端日志），等宽只留给命令与代码。
 */
const styles = `
.dsw-page{
/* 兜底色：令牌缺失时才用到，随系统主题切换 */
--fb-fg:#1f2329;--fb-fg2:#545b66;--fb-fg3:#8b93a3;
--fb-bg1:#f6f7f9;--fb-bg2:#ffffff;--fb-bd:#e8eaee;--fb-bd2:#d7dae0;
--fb-hover:#0000000f;--fb-code:#f3f4f6;
/* 语义层 */
--fg:var(--dsw-alias-label-primary,var(--fb-fg));
--fg2:var(--dsw-alias-label-secondary,var(--fb-fg2));
--fg3:var(--dsw-alias-label-tertiary,var(--fb-fg3));
--bg1:var(--dsw-alias-bg-layer-1,var(--fb-bg1));
--bg2:var(--dsw-alias-bg-layer-2,var(--fb-bg2));
--bd:var(--dsw-alias-border-l1,var(--fb-bd));
--bd2:var(--dsw-alias-border-l2,var(--fb-bd2));
--hover:var(--dsw-alias-interactive-bg-hover,var(--fb-hover));
--code-bg:var(--dsw-alias-markdown-code-block,var(--fb-code));
--accent:var(--dsw-alias-brand-primary,#3b6ef0);
--on-accent:var(--dsw-alias-label-primary-foreground,#ffffff);
--ok:var(--dsw-alias-state-success-primary,#1a9f5a);
--warn:var(--dsw-alias-state-warn-label,#9a6a00);
--err:var(--dsw-alias-state-error-primary,#d93025);
--mono:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
font-size:13px;line-height:1.6;color:var(--fg);max-width:760px;padding:2px 0 12px;
-webkit-font-smoothing:antialiased;
}
@media (prefers-color-scheme:dark){
.dsw-page{--fb-fg:#ededed;--fb-fg2:#b6bcc6;--fb-fg3:#858c99;
--fb-bg1:#212121;--fb-bg2:#2a2a2a;--fb-bd:#333333;--fb-bd2:#3d3d3d;
--fb-hover:#ffffff14;--fb-code:#1c1c1c}
}
.dsw-title{margin:0 0 3px;font-size:14px;font-weight:500;color:var(--fg)}
.dsw-sub{margin:0 0 14px;font-size:12px;line-height:1.55;color:var(--fg3)}
/* provider 名带连字符，万一折行会断成 deepseek- / web（看着像故障）—— 整词不拆 */
.dsw-nobreak{white-space:nowrap}
.dsw-card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.dsw-cardhead{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:500;color:var(--fg)}
.dsw-card > .name{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--fg)}
.dsw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsw-badge{font-size:11px;font-weight:500;line-height:1.7;padding:1px 9px;border-radius:999px;white-space:nowrap}
.dsw-badge.on{color:var(--ok);background:rgba(26,159,90,.15)}
.dsw-badge.off{color:var(--warn);background:rgba(200,140,20,.16)}
.dsw-badge.err{color:var(--err);background:rgba(217,48,37,.15)}
.dsw-btn{font:inherit;font-size:12px;font-weight:500;line-height:1.5;padding:6px 13px;border-radius:8px;
border:1px solid transparent;background:var(--accent);color:var(--on-accent);cursor:pointer;
transition:background-color .15s ease,border-color .15s ease,opacity .15s ease}
.dsw-btn:hover:not(:disabled){opacity:.88}
.dsw-btn:active:not(:disabled){opacity:.72}
.dsw-btn:disabled{opacity:.4;cursor:not-allowed}
.dsw-btn.ghost{background:transparent;border-color:var(--bd2);color:var(--fg)}
.dsw-btn.ghost:hover:not(:disabled){background:var(--hover);opacity:1}
.dsw-btn.danger{background:transparent;border-color:var(--bd2);color:var(--err)}
.dsw-btn.danger:hover:not(:disabled){background:rgba(217,48,37,.1);border-color:var(--err);opacity:1}
.dsw-btn.armed{background:var(--err);border-color:var(--err);color:#ffffff}
.dsw-btn.armed:hover:not(:disabled){opacity:.9}
.dsw-input,.dsw-area{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;
background:var(--bg1);color:var(--fg);border:1px solid var(--bd2);border-radius:8px;padding:7px 10px;
outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dsw-input:focus,.dsw-area:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--hover)}
.dsw-area{min-height:68px;resize:vertical;font-family:var(--mono);font-size:12px;line-height:1.5}
.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:0 12px;margin:2px 0 0;align-items:baseline}
.dsw-kv > *{padding:5px 0;border-top:1px solid var(--bd);min-width:0}
.dsw-kv > :nth-child(1),.dsw-kv > :nth-child(2){border-top:none}
.dsw-kv .k{color:var(--fg3);font-size:12px;white-space:nowrap}
.dsw-kv > *:not(.k){color:var(--fg);word-break:break-word}
.dsw-msg{margin-top:10px;padding:9px 12px;border-radius:8px;background:var(--bg1);border:1px solid var(--bd);
border-left:3px solid var(--fg3);white-space:pre-wrap;max-height:240px;overflow:auto;
font-size:12px;line-height:1.6;color:var(--fg)}
.dsw-msg.err{border-left-color:var(--err);color:var(--err)}
.dsw-msg.ok{border-left-color:var(--ok)}
.dsw-models{list-style:none;margin:2px 0 0;padding:0}
.dsw-models li{padding:9px 0;border-top:1px solid var(--bd)}
.dsw-models li:first-child{border-top:none;padding-top:2px}
.dsw-models .name{font-size:13px;font-weight:500;color:var(--fg)}
.dsw-models .id{color:var(--fg3);font-size:12px;margin-top:1px;word-break:break-word}
.dsw-hint{color:var(--fg3);font-size:12px;line-height:1.6;margin:8px 0 0}
.dsw-gate-row{display:flex;align-items:center;gap:10px;margin:10px 0;flex-wrap:wrap}
.dsw-gate-label{color:var(--fg3);font-size:12px;min-width:52px;flex:0 0 auto}
.dsw-gate-value{font-size:12px;color:var(--fg);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
.dsw-switch{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:var(--fg);cursor:pointer;user-select:none}
.dsw-switch input{position:absolute;opacity:0;width:0;height:0}
.dsw-switch-track{width:34px;height:20px;border-radius:999px;background:var(--bd2);position:relative;transition:background-color .15s ease;flex:0 0 auto}
.dsw-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}
.dsw-switch input:checked + .dsw-switch-track{background:var(--err)}
.dsw-switch input:checked + .dsw-switch-track::after{transform:translateX(14px)}
.dsw-range{-webkit-appearance:none;appearance:none;flex:1 1 160px;height:4px;border-radius:999px;background:var(--bd2);outline:none;cursor:pointer}
.dsw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.dsw-preset{padding:4px 10px;font-size:12px}
.dsw-preset.active{background:var(--accent);border-color:transparent;color:var(--on-accent)}
.dsw-gate-msg{color:var(--fg3);min-height:1.6em}
.dsw-code{display:block;margin:6px 0;padding:7px 10px;background:var(--code-bg);border:1px solid var(--bd);
border-radius:8px;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--fg);
overflow-x:auto;white-space:pre}
.dsw-msg::-webkit-scrollbar,.dsw-code::-webkit-scrollbar,.dsw-area::-webkit-scrollbar{width:8px;height:8px}
.dsw-msg::-webkit-scrollbar-thumb,.dsw-code::-webkit-scrollbar-thumb,.dsw-area::-webkit-scrollbar-thumb{
background:var(--bd2);border-radius:4px}
/* ── 标签页：把原来一页到底的 7 张卡拆成 4 页 ────────────────────────
   标签栏做成带边框的圆角容器；未选中 70% 透明度 + 下划线指示当前页。
   颜色全部走设计令牌，浅色/深色自动跟随，不用写第二份。 */
.dsw-tabs{display:inline-flex;gap:4px;border:1px solid var(--bd);border-radius:8px;
padding:0 10px;margin:4px 0 14px;background:var(--bg1)}
.dsw-tab{appearance:none;background:transparent;border:none;border-bottom:2px solid transparent;
padding:8px 14px;font:inherit;font-size:13px;color:var(--fg2);opacity:.7;cursor:pointer;
transition:opacity .15s ease,border-color .15s ease}
.dsw-tab:hover{opacity:1}
.dsw-tab.active{opacity:1;color:var(--fg);border-bottom-color:var(--fg)}
.dsw-pane[hidden]{display:none}
/* 操作反馈：不归属任何一页，常驻在标签栏之上 */
.dsw-alert{margin:0 0 12px;padding:8px 10px;border-radius:8px;border:1px solid var(--bd);
background:var(--bg1);white-space:pre-wrap;font-size:12px}
.dsw-alert.ok{border-left:3px solid var(--ok);color:var(--ok)}
.dsw-alert.err{border-left:3px solid var(--err);color:var(--err)}
`

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 面板本体：命令式 DOM（生态既有插件同款做法），挂在 React 容器里。 */
function Panel(): any {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = hostRef.current
    if (!root) return
    let disposed = false
    let timer: number | undefined

    const style = document.createElement('style')
    style.textContent = styles

    const page = el('div', 'dsw-page')
    const title = el('h3', 'dsw-title', 'DeepSeek 网页登录（免费模型）')
    // 副标题的宽度是"预算"问题，不是随便写的：
    // 上一版（78 字）单行要 558px，而宿主面板的内容宽约 560px —— 正好压在折行边界上。
    // 「账号」页比「模型」页高，面板因此出现纵向滚动条，内容宽度少十几像素，
    // 最后一个词就掉到第二行，还断在 `deepseek-web` 的连字符处（看着像故障）。
    // 现在这版约 467px，留 ~90px 余量，切标签/缩放窗口都不会再翻行。
    // ⚠️ 以后改这句话，请保持单行宽度 ≲ 470px（量法：white-space:nowrap 的 span 取 getBoundingClientRect）。
    const sub = el('p', 'dsw-sub')
    sub.append('用 chat.deepseek.com 的登录态驱动 DSH，不需要 API Key（provider：')
    sub.append(el('span', 'dsw-nobreak', 'deepseek-web'))
    sub.append('）')
    page.append(style, title, sub)

    // ── 操作反馈：常驻在标签栏之上 ──────────────────────────────
    // 拆成标签页后，在「账号」页点按钮的反馈若落在别的页里就等于看不见，所以它不归属任何一页。
    const message = el('div', 'dsw-alert')
    message.style.display = 'none'
    page.append(message)

    const showMessage = (text: string, kind: 'ok' | 'err' | '' = ''): void => {
      message.textContent = text
      message.className = `dsw-alert${kind ? ` ${kind}` : ''}`
      message.style.display = 'block'
    }

    // ── 标签栏 + 四个页 ────────────────────────────────────────
    // 原来 7 张卡堆在一页，「找某一项」要滚很久。分组按"什么时候会用它"：
    //   账号（登录/换号）· 模型（查阅与测试）· 防风控（限流与清理）· 传输层（指纹）
    const TAB_KEYS = ['account', 'model', 'gate', 'transport'] as const
    const TAB_LABELS: Record<string, string> = {
      account: '账号',
      model: '模型',
      gate: '防风控',
      transport: '传输层',
    }
    const accountPane = el('div', 'dsw-pane')
    const modelPane = el('div', 'dsw-pane')
    const gatePane = el('div', 'dsw-pane')
    const transportPane = el('div', 'dsw-pane')
    const panes: Record<string, HTMLElement> = {
      account: accountPane,
      model: modelPane,
      gate: gatePane,
      transport: transportPane,
    }
    const tabButtons: Record<string, HTMLButtonElement> = {}
    const selectTab = (key: string): void => {
      for (const each of TAB_KEYS) {
        const on = each === key
        panes[each].hidden = !on
        tabButtons[each].classList.toggle('active', on)
        tabButtons[each].setAttribute('aria-selected', String(on))
      }
    }
    const tabBar = el('div', 'dsw-tabs')
    tabBar.setAttribute('role', 'tablist')
    for (const key of TAB_KEYS) {
      const btn = el('button', 'dsw-tab', TAB_LABELS[key]) as HTMLButtonElement
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.addEventListener('click', () => selectTab(key))
      tabButtons[key] = btn
      tabBar.append(btn)
      panes[key].setAttribute('role', 'tabpanel')
    }
    page.append(tabBar, ...TAB_KEYS.map((key) => panes[key]))
    selectTab('account')

    // ── 登录卡 ──
    const loginCard = el('div', 'dsw-card')
    const loginHead = el('div', 'dsw-cardhead')
    const loginTitle = el('div')
    loginTitle.append(el('span', 'name', '登录状态'))
    const badge = el('span', 'dsw-badge off', '未登录')
    loginTitle.append(badge)
    loginHead.append(loginTitle)
    loginCard.append(loginHead)

    const statusKv = el('div', 'dsw-kv')
    loginCard.append(statusKv)

    // ── 账号卡（退出 / 换号）──
    // 为什么要单独一张卡：退出登录以前只作为一个按钮塞在「手动粘贴 Token」那张卡的角落里，
    // 用户根本找不到（实测反馈）。退出账号是高频操作，必须显眼、且要能换号。
    const accountCard = el('div', 'dsw-card')
    accountCard.append(el('div', 'dsw-cardhead', '当前账号'))
    const accountLine = el('div', 'dsw-kv')
    accountCard.append(accountLine)
    const accountActions = el('div', 'dsw-row')
    accountActions.style.marginTop = '8px'
    const logoutBtn = el('button', 'dsw-btn danger', '退出当前账号') as HTMLButtonElement
    const switchBtn = el('button', 'dsw-btn ghost', '退出并登录其它账号') as HTMLButtonElement
    accountActions.append(logoutBtn, switchBtn)
    accountCard.append(accountActions)
    const accountHint = el(
      'p',
      'dsw-hint',
      '退出会同时清除本地凭证与浏览器分区里的 chat.deepseek.com 登录态（否则「从已登录窗口恢复」会把同一个账号原样抓回来，也无法换号）。',
    )
    accountCard.append(accountHint)

    const loginActions = el('div', 'dsw-row')
    loginActions.style.marginTop = '10px'
    const browserBtn = el('button', 'dsw-btn', '浏览器窗口登录') as HTMLButtonElement
    const externalBtn = el('button', 'dsw-btn ghost', '用我的默认浏览器登录') as HTMLButtonElement
    const recoverBtn = el('button', 'dsw-btn ghost', '从已登录窗口恢复') as HTMLButtonElement
    const refreshBtn = el('button', 'dsw-btn ghost', '刷新状态') as HTMLButtonElement
    loginActions.append(browserBtn, externalBtn, recoverBtn, refreshBtn)
    loginCard.append(loginActions)
    loginCard.append(
      el(
        'p',
        'dsw-hint',
        '「用我的默认浏览器登录」= 用系统浏览器打开 chat.deepseek.com（网页端若提示「使用环境异常」，走这条）。' +
          '外部浏览器的登录态插件抓不到，所以要用 F12 控制台取 token 粘到下面那张卡（命令已备好）。',
      ),
    )
    loginCard.append(
      el(
        'p',
        'dsw-hint',
        '「从已登录窗口恢复」= 复用上次登录过的窗口分区直接取凭证（免重新登录），凭证丢失时用它救急。',
      ),
    )
    accountPane.append(loginCard, accountCard)

    // ── 手动 token 卡 ──
    const tokenCard = el('div', 'dsw-card')
    tokenCard.append(el('div', 'dsw-cardhead', '手动粘贴 Token（可选路径）'))
    tokenCard.append(
      el(
        'p',
        'dsw-hint',
        '在浏览器打开 chat.deepseek.com 并登录 → F12 控制台执行下面一行 → 把结果粘贴到输入框：',
      ),
    )
    const snippet = el('code', 'dsw-code', "JSON.parse(localStorage.getItem('userToken')).value")
    tokenCard.append(snippet)
    tokenCard.append(
      el(
        'p',
        'dsw-hint',
        '（新版网页端 token 存在 {"value": …} 包装里；若上面那行报错，改成 localStorage.getItem(\'userToken\') 直接复制整串，插件会自动解包）',
      ),
    )
    const tokenInput = el('textarea', 'dsw-area') as HTMLTextAreaElement
    tokenInput.placeholder = '粘贴 token（包装 JSON 或裸 token 都行；可选：下一行粘贴 Cookie，格式 name=value; name2=value2）'
    tokenCard.append(tokenInput)
    const tokenActions = el('div', 'dsw-row')
    tokenActions.style.marginTop = '8px'
    const tokenBtn = el('button', 'dsw-btn', '保存并验证') as HTMLButtonElement
    tokenActions.append(tokenBtn)
    tokenCard.append(tokenActions)
    accountPane.append(tokenCard)

    // ── 测试卡 ──
    const testCard = el('div', 'dsw-card')
    testCard.append(el('div', 'dsw-cardhead', '连通性测试'))
    testCard.append(el('p', 'dsw-hint', '直接经适配器发一次最小请求（会消耗一点网页端额度）：'))
    const testActions = el('div', 'dsw-row')
    testActions.style.marginTop = '6px'
    const modelSelect = el('select', 'dsw-input') as HTMLSelectElement
    modelSelect.style.maxWidth = '220px'
    const testBtn = el('button', 'dsw-btn', '发送测试') as HTMLButtonElement
    testActions.append(modelSelect, testBtn)
    testCard.append(testActions)
    const testOut = el('div', 'dsw-msg')
    testOut.style.display = 'none'
    testCard.append(testOut)

    // ── 模型卡 ──
    const modelsCard = el('div', 'dsw-card')
    modelsCard.append(el('div', 'dsw-cardhead', '可用模型（网页免费）'))
    const modelsList = el('ul', 'dsw-models')
    modelsCard.append(modelsList)
    const modelsHint = el('p', 'dsw-hint', '')
    modelsCard.append(modelsHint)
    modelPane.append(modelsCard, testCard)

    // （操作反馈条与 showMessage 已提到页头、标签栏之上）

    let loggedIn = false
    let electron = false
    let windowOpen = false

    const renderKv = (rows: [string, string][]): void => {
      statusKv.textContent = ''
      for (const [key, value] of rows) {
        statusKv.append(el('div', 'k', key), el('div', undefined, value))
      }
    }

    const applyStatus = (status: StatusPayload): void => {
      loggedIn = !!status.auth?.loggedIn
      electron = !!status.electron
      windowOpen = !!status.loginWindowOpen

      badge.textContent = loggedIn ? (status.auth.unverified ? '已捕获（未校验）' : '已登录') : '未登录'
      badge.className = `dsw-badge ${loggedIn ? (status.auth.unverified ? 'off' : 'on') : 'off'}`
      if (loggedIn && !status.auth.unverified) {
        const valid = status.validation
        if (valid && !valid.ok) {
          badge.textContent = '登录态校验失败'
          badge.className = 'dsw-badge err'
        }
      }

      const rows: [string, string][] = []
      rows.push(['适配器注册', (status.registeredProviders ?? []).includes(status.provider) ? `✅ ${status.provider} 已注册到 llm` : `⚠️ 未在 llm 中找到 ${status.provider}`])
      if (loggedIn) {
        rows.push(['账号', status.auth.display || '（未获取到账号信息）'])
        rows.push(['捕获时间', status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : '未知'])
        // 凭证来源与完整度：以前这里对缺失项写「未捕获（可能仍可用）」，读起来像风险提示，
        // 实际含义只是「你走的是手动粘贴 token 那条路」。实测（2026-09-11）：
        // 只有 Bearer token、没有 cookie / x-hif-* 时，校验、PoW、真实生成全部通过 ——
        // 所以这里如实说明「缺什么」以及「已证实不影响使用」，而不是留一句模糊的警告。
        const manualTokenMode = !status.auth.hasCookie && !status.auth.hasFingerprint
        if (manualTokenMode) {
          rows.push(['凭证来源', '手动粘贴 token（实测：仅凭 Bearer token 即可完成校验/求解/生成）'])
        } else {
          rows.push(['凭证来源', '浏览器登录捕获（token + cookie + 指纹头，登录态通常更耐久）'])
        }
        rows.push([
          'Cookie',
          status.auth.hasCookie
            ? '✅ 已捕获'
            : '未捕获 —— 手动 token 模式本就没有（已验证不影响请求；若日后频繁遇到 AUTH/40003，改用「浏览器登录」）',
        ])
        rows.push(['指纹头', status.auth.hasFingerprint ? '✅ 已捕获（x-hif-* / x-client-*）' : '未捕获 —— 同上，已实测可用'])
        rows.push(['PoW WASM', status.auth.wasmHost || '默认地址'])
        rows.push(['token 长度', `${status.auth.tokenLength ?? 0} 字符`])
        if (status.validation) rows.push(['服务端校验', status.validation.ok ? '通过' : `失败：${status.validation.error ?? ''}`])
        // 让用户能确认「防风控」到底生效成什么样（值来自配置，改配置后重启生效）
        const interval = status.config?.minRequestIntervalMs
        if (interval !== undefined) {
          rows.push([
            '请求节流',
            status.config?.allowConcurrent
              ? `⚠️ 允许并发 · 间隔 ${interval}ms（并发生成有账号级限制风险，不建议）`
              : `串行（一次只发一条）· 间隔 ${interval}ms`,
          ])
        }
      } else {
        // 未登录时说明「能用哪条路登录」（不要笼统写成「非 Electron 环境」：
        // 2026-09-11 起宿主是 utility 进程，但真实浏览器登录是可用的）
        const available = status.loginCapability
        rows.push([
          '登录方式',
          available
            ? available.canOpenWindow
              ? '插件自开窗口（Electron 主进程，带指纹伪装）'
              : available.browser
                ? `用真实浏览器登录（${available.browser} + 调试协议，自动读取凭证）`
                : '未找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 token'
            : electron
              ? '可开浏览器窗口'
              : '请用「用我的默认浏览器登录」+ 手动粘贴 token',
        ])
      }
      if (status.lastLoginResult) {
        rows.push(['最近结果', `${status.lastLoginResult.message} · ${new Date(status.lastLoginResult.at).toLocaleTimeString()}`])
      }
      if (status.loginWindowOpen && status.loginProgress?.captured) {
        const captured = status.loginProgress.captured
        rows.push([
          '捕获进度',
          `token ${captured.token ? '✓' : '…'} / cookie ${captured.cookie ? '✓' : '…'} / 指纹 ${captured.fingerprint ? '✓' : '…'}`,
        ])
      }
      if (status.loginProgress?.lastError && status.loginWindowOpen) {
        rows.push(['窗口提示', status.loginProgress.lastError])
      }
      if (status.fingerprint && status.fingerprint.stripped.length > 0) {
        rows.push(['指纹清理', `已剔除 ${status.fingerprint.stripped.length} 个 Electron 头：${status.fingerprint.stripped.join(', ')}`])
      } else if (status.loginWindowOpen) {
        rows.push(['指纹清理', '窗口已打开（尚未命中需要清理的头）'])
      }
      if (status.fingerprint?.pageUa) {
        const bad = /electron/i.test(status.fingerprint.pageUa)
        rows.push(['页面看到 UA', `${bad ? '⚠️ 仍含 Electron：' : '✅ '}${status.fingerprint.pageUa}`])
      }
      if (status.fingerprint?.pageBrands?.length) {
        const dirty = status.fingerprint.pageBrands.filter((b) => /electron|dsh/i.test(b))
        rows.push(['页面品牌', `${dirty.length ? `⚠️ ${dirty.join(', ')}` : '✅ '}${status.fingerprint.pageBrands.join(', ')}`])
      }
      if (status.fingerprint?.pageWebdriver !== undefined) {
        rows.push(['webdriver', status.fingerprint.pageWebdriver ? '⚠️ true（自动化痕迹）' : '✅ false'])
      }
      renderKv(rows)

      browserBtn.disabled = false
      // 登录能力自检（2026-09-11 事故：DSH 把插件宿主挪到 utility 进程后，窗口 API 没了）
      const capability = status.loginCapability
      if (capability) {
        const mode = capability.canOpenWindow
          ? '可开 Electron 窗口'
          : capability.browser
            ? `无窗口 API（${capability.processType} 进程）→ 用真实浏览器`
            : `无窗口 API（${capability.processType} 进程）且未找到 Edge/Chrome`
        rows.push(['宿主进程', `${capability.processType} · ${mode}`])
        browserBtn.textContent = capability.canOpenWindow ? '浏览器窗口登录' : capability.browser ? `用 ${capability.browser} 登录` : '浏览器窗口登录'
        browserBtn.disabled = !capability.canOpenWindow && !capability.browser
        browserBtn.title = capability.canOpenWindow
          ? '插件自己开窗口（带指纹伪装）'
          : capability.browser
            ? `拉起真实的 ${capability.browser}（独立 profile）完成登录，插件通过调试协议读取登录态`
            : '既不能开窗口也没找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token'
      } else {
        browserBtn.disabled = !electron
        browserBtn.textContent = windowOpen ? '登录窗口已打开' : '浏览器窗口登录'
        browserBtn.title = electron ? '' : '当前宿主无法开窗：请用「用我的默认浏览器登录」+ 手动粘贴 Token'
      }

      // 账号卡：显示当前账号 + 退出按钮可用性
      accountLine.textContent = ''
      if (loggedIn) {
        accountLine.append(el('div', 'k', '账号'), el('div', undefined, status.auth.display || '（未获取到账号信息）'))
        accountLine.append(
          el('div', 'k', '登录时间'),
          el('div', undefined, status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : '未知'),
        )
      } else {
        accountLine.append(el('div', 'k', '状态'), el('div', undefined, '未登录（没有可退出的账号）'))
      }
      logoutBtn.disabled = !loggedIn
      switchBtn.disabled = !loggedIn || !electron
      switchBtn.title = electron ? '' : '当前不是 Electron 桌面端：请先「退出当前账号」，再手动粘贴另一个账号的 token'

      // 模型下拉
      if (modelSelect.options.length !== status.models.length) {
        modelSelect.textContent = ''
        for (const model of status.models) {
          const option = document.createElement('option')
          option.value = model.id
          option.textContent = model.name
          modelSelect.append(option)
        }
      }
      // 模型列表
      modelsList.textContent = ''
      for (const model of status.models) {
        const item = el('li')
        item.append(el('div', 'name', model.name))
        const ctxLabel = model.contextWindow >= 1_048_576
          ? `${(model.contextWindow / 1_048_576).toFixed(0)}M`
          : `${Math.round(model.contextWindow / 1024)}K`
        item.append(el('div', 'id', `${model.id} · thinking ${model.thinking ? '开' : '关'} · 上下文 ${ctxLabel} token（标称）`))
        item.append(el('div', 'id', model.description))
        modelsList.append(item)
      }
      modelsHint.textContent =
        `两条是同一个「快速模式」的思考开关两档预设（也可在模型选择器的推理强度里切换）。` +
        `图片输入直接可用（走网页端文件上传通道）。每次调用会新建并删除临时会话；` +
        `prompt 字符上限 ${status.config?.maxPromptChars ?? 0}（服务端硬上限 2621440 字符，` +
        `另附件 token 预算 890880 —— 后者常被误读成「上下文窗口」）。`
    }

    const refresh = async (light = true): Promise<void> => {
      try {
        const status = await api(`/status${light ? '?light=1' : ''}`)
        if (disposed) return
        applyStatus(status)
      } catch (error: any) {
        showMessage(`状态读取失败：${error?.message ?? error}`, 'err')
      }
    }

    // ── 请求节流卡：并发开关 + 间隔区间 + 会话清理 ──
    // 这三项直接决定会不会被账号级限流（实测双窗口并发 6 分钟内被限制 1 天），
    // 所以不该只藏在配置文件里 —— 界面上直接可调，改完即时生效并落盘。
    const gateCard = el('div', 'dsw-card')
    gateCard.append(el('div', 'dsw-cardhead', '请求节流（防风控）'))

    const rangeInput = (): HTMLInputElement => {
      const input = el('input', 'dsw-range') as HTMLInputElement
      input.type = 'range'
      input.min = '0'
      input.max = '30000'
      input.step = '500'
      return input
    }

    const concRow = el('div', 'dsw-gate-row')
    const concLabel = el('label', 'dsw-switch')
    const concInput = el('input') as HTMLInputElement
    concInput.type = 'checkbox'
    const concTrack = el('span', 'dsw-switch-track')
    concLabel.append(concInput, concTrack, el('span', undefined, '允许并发（同一账号同时发两条）'))
    concRow.append(concLabel)
    gateCard.append(concRow)

    const minRow = el('div', 'dsw-gate-row')
    minRow.append(el('span', 'dsw-gate-label', '间隔下限'))
    const minRange = rangeInput()
    const minValue = el('span', 'dsw-gate-value', '—')
    minRow.append(minRange, minValue)
    gateCard.append(minRow)

    const maxRow = el('div', 'dsw-gate-row')
    maxRow.append(el('span', 'dsw-gate-label', '间隔上限'))
    const maxRange = rangeInput()
    const maxValue = el('span', 'dsw-gate-value', '—')
    maxRow.append(maxRange, maxValue)
    gateCard.append(maxRow)

    const intervalHint = el('p', 'dsw-hint', '')
    gateCard.append(intervalHint)

    const presetRow = el('div', 'dsw-gate-row')
    gateCard.append(presetRow)

    const cleanupRow = el('div', 'dsw-gate-row')
    cleanupRow.append(el('span', 'dsw-gate-label', '会话清理'))
    const cleanupBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['immediate', '立即'],
      ['deferred', '延迟（推荐）'],
      ['keep', '不删'],
    ] as const) {
      const key = pair[0]
      const btn = el('button', 'dsw-btn ghost dsw-preset', pair[1]) as HTMLButtonElement
      btn.addEventListener('click', () => void saveGate({ sessionCleanup: key }))
      cleanupBtns[key] = btn
      cleanupRow.append(btn)
    }
    gateCard.append(cleanupRow)
    const cleanupHint = el('p', 'dsw-hint', '')
    gateCard.append(cleanupHint)

    gateCard.append(
      el(
        'p',
        'dsw-hint',
        '并发默认关闭：DSH 的会话标题生成会与主回答同时发往同一账号，网页端同一账号同时只能生成一条，' +
          '实测双窗口并发不到 6 分钟即触发账号级限制（1 天）。',
      ),
    )
    const gateMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    gateCard.append(gateMsg)
    gatePane.append(gateCard)

    // ── 传输层卡：请求从哪个网络栈出去（决定 TLS/HTTP2 指纹像不像浏览器）──
    // 实测：Node fetch 的 JA4 是 `t13d…h1`（不走 HTTP/2、cipher 数量差 3 倍多、不带 GREASE）；
    // 换成 Chromium 网络栈后 cipher 列表哈希与 Chrome **逐字节一致**。所以默认走 Chromium。
    // 但要留开关：Chromium 会跟随**系统代理**（Node 完全无视代理），梯子关着时可能反而连不上。
    const transportCard = el('div', 'dsw-card')
    transportCard.append(el('div', 'dsw-cardhead', '传输层（指纹）'))

    const transportRow = el('div', 'dsw-gate-row')
    transportRow.append(el('span', 'dsw-gate-label', '请求从哪出去'))
    const transportBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['chromium', 'Chromium 网络栈（推荐）'],
      ['node', 'Node'],
    ] as const) {
      const key = pair[0]
      const btn = el('button', 'dsw-btn ghost dsw-preset', pair[1]) as HTMLButtonElement
      btn.addEventListener('click', () => void saveTransport(key))
      transportBtns[key] = btn
      transportRow.append(btn)
    }
    transportCard.append(transportRow)

    const transportHint = el('p', 'dsw-hint', '')
    transportCard.append(transportHint)
    const transportProxyHint = el('p', 'dsw-hint', '')
    transportCard.append(transportProxyHint)

    const testRow = el('div', 'dsw-gate-row')
    const transportTestBtn = el('button', 'dsw-btn ghost', '测试传输层（零额度）') as HTMLButtonElement
    testRow.append(transportTestBtn)
    transportCard.append(testRow)

    const transportTestOut = el('div', 'dsw-msg', '')
    transportTestOut.style.display = 'none'
    transportCard.append(transportTestOut)

    const transportMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    transportCard.append(transportMsg)
    transportPane.append(transportCard)

    const applyTransportCard = (info: any): void => {
      if (!info) return
      const requested = String(info.requested ?? info.effective ?? 'chromium')
      const effective = String(info.effective ?? requested)
      for (const key of Object.keys(transportBtns)) {
        transportBtns[key].classList.toggle('active', key === requested)
      }
      // 环境不支持时把 Chromium 选项禁掉，别让人选了没反应
      const available = info.chromiumAvailable !== false
      transportBtns.chromium.disabled = !available
      transportBtns.chromium.title = available
        ? ''
        : '本环境拿不到 electron.net.fetch（只有 Electron 的 utility 进程里有）'

      const parts = [
        effective === 'chromium' ? '实际生效：Chromium 网络栈' : '实际生效：Node fetch',
      ]
      if (info.degraded) parts.push('配置要求 Chromium，但本环境不支持，已降级为 Node')
      if (effective === 'chromium') parts.push('cipher 列表哈希与 Chrome 一致、ALPN 走 h2')
      transportHint.textContent = parts.join(' · ')
      transportProxyHint.textContent = String(info.hint ?? '')
    }

    const saveTransport = async (kind: 'chromium' | 'node'): Promise<void> => {
      transportMsg.textContent = '切换中……'
      try {
        const result = await api('/transport', { method: 'POST', body: JSON.stringify({ transport: kind }) })
        if (result?.ok) {
          applyTransportCard(result)
          transportMsg.textContent =
            `已切换到 ${result.effective === 'chromium' ? 'Chromium 网络栈' : 'Node fetch'}，即时生效` +
            (result.persisted === false
              ? '（未能写入配置，重启后会回到上次保存的值）'
              : '（已写入配置，重启后仍生效）')
        } else {
          transportMsg.textContent = `切换失败：${result?.error ?? '未知原因'}`
        }
      } catch (error: any) {
        transportMsg.textContent = `切换失败：${error?.message ?? error}`
      }
    }

    transportTestBtn.addEventListener('click', () => {
      void (async () => {
        transportTestBtn.disabled = true
        transportTestOut.style.display = ''
        transportTestOut.textContent = '正在探测（指纹 / 流式 / 鉴权）……'
        try {
          const result = await api('/diagnostics/net-fetch', {
            method: 'POST',
            body: JSON.stringify({ mode: 'probe' }),
          })
          const lines: string[] = []
          for (const step of result?.results ?? []) {
            const title = String(step.step ?? '')
            if (title.startsWith('①')) {
              lines.push(`① 指纹  ja4=${step.ja4 ?? '-'}  HTTP=${step.http_version ?? '-'}`)
            } else if (title.startsWith('②')) {
              lines.push(
                `② 流式  ${step.ok ? '支持' : '不支持'}  分片=${step.chunks ?? 0}  abort=${step.abortedEarly ? '生效' : '未生效'}`,
              )
            } else if (title.startsWith('③')) {
              lines.push(`③ 鉴权  HTTP ${step.status ?? '-'}  ${step.ok ? '通过' : (step.error ?? '未通过')}`)
            }
          }
          transportTestOut.textContent = lines.length ? lines.join('\n') : JSON.stringify(result)
        } catch (error: any) {
          transportTestOut.textContent = `探测失败：${error?.message ?? error}`
        } finally {
          transportTestBtn.disabled = false
        }
      })()
    })

    void (async () => {
      try {
        applyTransportCard(await api('/transport'))
      } catch {
        transportMsg.textContent = '传输层设置读取失败（宿主未响应）'
      }
    })()

    /** 渲染宿主返回的节流设置（含可选档位与清理策略）。 */
    const applyGate = (g: any): void => {
      if (!g) return
      concInput.checked = !!g.allowConcurrent

      const cap = String(g.maxIntervalMs ?? 30000)
      minRange.max = cap
      maxRange.max = cap
      const lo = Number(g.minRequestIntervalMs ?? 2000)
      const hi = Number(g.maxRequestIntervalMs ?? lo)
      minRange.value = String(lo)
      maxRange.value = String(hi)
      minValue.textContent = `${lo}ms`
      maxValue.textContent = `${hi}ms`
      intervalHint.textContent =
        lo === hi
          ? `固定间隔 ${lo}ms（上下限相等）。建议拉开成区间 —— 固定值方差≈0，是明显的「定时器特征」。`
          : `实际等待在 ${lo}~${hi}ms 之间随机取值（均值约 ${Math.round((lo + hi) / 2)}ms）。`

      presetRow.textContent = ''
      presetRow.append(el('span', 'dsw-gate-label', '快捷'))
      const presets: { min: number; max: number }[] =
        g.presets ?? [{ min: 1_500, max: 2_500 }, { min: 2_000, max: 4_000 }, { min: 5_000, max: 9_000 }]
      for (const preset of presets) {
        const isDefault =
          preset.min === (g.defaultMinIntervalMs ?? 2_000) && preset.max === (g.defaultMaxIntervalMs ?? 4_000)
        const btn = el(
          'button',
          'dsw-btn ghost dsw-preset',
          `${preset.min}~${preset.max}ms${isDefault ? '（推荐）' : ''}`,
        ) as HTMLButtonElement
        btn.addEventListener('click', () =>
          void saveGate({ minRequestIntervalMs: preset.min, maxRequestIntervalMs: preset.max }),
        )
        if (isDefault && g.minRequestIntervalMs === preset.min && g.maxRequestIntervalMs === preset.max) {
          btn.classList.add('active')
        }
        presetRow.append(btn)
      }

      const mode = g.cleanup?.mode ?? 'deferred'
      for (const key of Object.keys(cleanupBtns)) {
        cleanupBtns[key].classList.toggle('active', key === mode)
      }
      cleanupHint.textContent =
        mode === 'keep'
          ? '不删：请求最少，但网页端会留下临时会话记录。'
          : mode === 'immediate'
            ? '立即：调用结束后 1.5 秒删掉（老行为，每轮多一个删除请求）。'
            : `延迟：攒够 ${g.cleanup?.batchSize ?? 8} 个、或 ${Math.round((g.cleanup?.delayMs ?? 90_000) / 1000)} 秒后集中清理，` +
              '并优先用一个请求批量删 —— 减少「每轮建一个立刻删一个」的机器特征。'
    }

    const saveGate = async (patch: {
      allowConcurrent?: boolean
      minRequestIntervalMs?: number
      maxRequestIntervalMs?: number
      sessionCleanup?: string
    }): Promise<void> => {
      gateMsg.textContent = '保存中……'
      try {
        const result = await api('/gate', { method: 'POST', body: JSON.stringify(patch) })
        if (result?.ok) {
          applyGate(result)
          gateMsg.textContent =
            `已生效：${result.allowConcurrent ? '允许并发（不推荐）' : '串行'} · ` +
            `间隔 ${result.minRequestIntervalMs}~${result.maxRequestIntervalMs}ms · ` +
            `清理 ${result.sessionCleanup ?? result.cleanup?.mode ?? '-'}` +
            (result.persisted === false ? ` ⚠️ ${result.warning ?? '未能写入配置'}` : '（已写入配置，重启后仍生效）')
        } else {
          gateMsg.textContent = `保存失败：${result?.error ?? '未知原因'}`
        }
      } catch (error: any) {
        gateMsg.textContent = `保存失败：${error?.message ?? error}`
      }
    }

    concInput.addEventListener('change', () => void saveGate({ allowConcurrent: concInput.checked }))
    // 拖动中只更新数字，松手（change）才提交，避免一路发请求
    minRange.addEventListener('input', () => {
      minValue.textContent = `${minRange.value}ms`
    })
    maxRange.addEventListener('input', () => {
      maxValue.textContent = `${maxRange.value}ms`
    })
    minRange.addEventListener('change', () => void saveGate({ minRequestIntervalMs: Number(minRange.value) }))
    maxRange.addEventListener('change', () => void saveGate({ maxRequestIntervalMs: Number(maxRange.value) }))

    void (async () => {
      try {
        applyGate(await api('/gate'))
      } catch {
        gateMsg.textContent = '节流设置读取失败（宿主未响应）'
      }
    })()

    let boostUntil = 0

    recoverBtn.addEventListener('click', () => {
      void (async () => {
        recoverBtn.disabled = true
        showMessage('正在从已登录窗口分区读取凭证……（复用上次登录态，不需要重新登录）')
        try {
          const result = await api('/login/recover', { method: 'POST', body: '{}' })
          if (result?.ok) {
            showMessage(`${result.verified ? '✅' : '⚠️'} ${result.message}`, result.verified ? 'ok' : '')
          } else {
            showMessage(`❌ ${result?.message ?? '恢复失败'}`, 'err')
          }
        } catch (error: any) {
          showMessage(`恢复失败：${error?.message ?? error}`, 'err')
        }
        recoverBtn.disabled = false
        await refresh(false)
      })()
    })

    externalBtn.addEventListener('click', () => {
      void (async () => {
        externalBtn.disabled = true
        try {
          const result = await api('/login/external', { method: 'POST', body: '{}' })
          if (result?.ok) {
            showMessage(
              `已用系统默认浏览器打开 ${result.url}\n` +
                '① 在浏览器里正常登录；②按 F12 → Console，粘贴下方「手动粘贴 Token」卡里的那行命令；' +
                '③ 把打印出来的结果粘到那张卡的输入框 → 点「保存并验证」。',
            )
          } else {
            showMessage(`打开失败：${result?.message ?? '未知原因'}；请手动在浏览器访问 ${result?.url ?? 'https://chat.deepseek.com'}`, 'err')
          }
        } catch (error: any) {
          showMessage(`打开失败：${error?.message ?? error}`, 'err')
        }
        externalBtn.disabled = false
      })()
    })

    browserBtn.addEventListener('click', () => {
      void (async () => {
        browserBtn.disabled = true
        showMessage('正在启动浏览器……若是真实浏览器，请在其中登录 DeepSeek（登录成功后会自动捕获，不用复制粘贴）。')
        try {
          const result = await api('/login/browser', { method: 'POST', body: '{}' })
          if (result?.mode === 'browser') {
            // 真实浏览器 + CDP：成功即已抓完 token/cookie/指纹头
            if (result.ok) {
              showMessage(`${result.verified ? '✅' : '⚠️'} ${result.message}${result.display ? `（${result.display}）` : ''}`, result.verified ? 'ok' : '')
            } else {
              showMessage(`❌ ${result.message ?? `登录未完成（${result.reason ?? '未知'}）`}`, 'err')
            }
          } else if (!result?.started) {
            showMessage(
              result?.reason === 'not-electron'
                ? '当前宿主进程无法开 Electron 窗口，且没找到可用的 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token。'
                : `打开失败：${result?.reason ?? '未知原因'}`,
              'err',
            )
          } else {
            showMessage('登录窗口已打开，正在旁路捕获登录凭证……')
          }
        } catch (error: any) {
          showMessage(`打开登录窗口失败：${error?.message ?? error}`, 'err')
        }
        boostUntil = Date.now() + 5 * 60_000
        await refresh(false)
      })()
    })

    tokenBtn.addEventListener('click', () => {
      void (async () => {
        const raw = tokenInput.value.trim()
        if (!raw) {
          showMessage('请先粘贴 userToken', 'err')
          return
        }
        const [tokenLine, ...rest] = raw.split('\n')
        const token = tokenLine.trim()
        const cookie = rest.join(' ').trim()
        tokenBtn.disabled = true
        showMessage('正在校验 token……')
        try {
          const result = await api('/login/token', { method: 'POST', body: JSON.stringify({ token, cookie }) })
          if (result?.ok) {
            if (result.error) {
              showMessage(`⚠️ ${result.error}`, '')
            } else {
              showMessage(`✅ ${result.display ? `账号 ${result.display} · ` : ''}token 校验通过，已保存`, 'ok')
            }
            tokenInput.value = ''
          } else {
            showMessage(`❌ 校验失败：${result?.error ?? '未知原因'}`, 'err')
          }
        } catch (error: any) {
          showMessage(`保存失败：${error?.message ?? error}`, 'err')
        }
        tokenBtn.disabled = false
        await refresh(false)
      })()
    })

    /**
     * 二次确认：退出账号是不可逆操作（凭证 + 浏览器登录态都会被清），
     * 所以第一次点击只把按钮变成「确认退出？」，3 秒内再点一次才真的执行。
     * 不用 window.confirm（插件面板里被宿主拦截的风险，且样式不可控）。
     */
    const armConfirm = (button: HTMLButtonElement, label: string, confirmLabel: string, run: () => void): void => {
      let armed = false
      let timer: number | undefined
      const reset = (): void => {
        armed = false
        if (timer !== undefined) window.clearTimeout(timer)
        button.textContent = label
        button.classList.remove('armed')
      }
      button.textContent = label
      button.addEventListener('click', () => {
        if (!armed) {
          armed = true
          button.textContent = confirmLabel
          button.classList.add('armed')
          timer = window.setTimeout(reset, 3_000)
          return
        }
        reset()
        run()
      })
    }

    const doLogout = (thenLogin: boolean): void => {
      void (async () => {
        logoutBtn.disabled = true
        switchBtn.disabled = true
        try {
          await api('/logout', { method: 'POST', body: '{}' })
          // 视觉上把 token 输入框也清掉，避免误以为「还是那个账号」
          tokenInput.value = ''
          showMessage(thenLogin ? '已退出当前账号，正在打开登录窗口……' : '已退出当前账号：本地凭证与浏览器登录态都已清除。')
          await refresh(false)
          if (thenLogin) {
            const result = await api('/login/browser', { method: 'POST', body: '{}' })
            if (result?.started === false) {
              showMessage(`已退出账号；打开登录窗口失败：${result?.reason ?? '未知原因'}（可改用手动粘贴 token）`, 'err')
            } else {
              boostUntil = Date.now() + 180_000
              showMessage('已退出账号，登录窗口已打开：请在窗口里登录**其它账号**，凭证会自动捕获。')
            }
          }
        } catch (error: any) {
          showMessage(`退出失败：${error?.message ?? error}`, 'err')
        } finally {
          await refresh(false)
        }
      })()
    }

    armConfirm(logoutBtn, '退出当前账号', '确认退出？', () => doLogout(false))
    armConfirm(switchBtn, '退出并登录其它账号', '确认退出并换号？', () => doLogout(true))

    testBtn.addEventListener('click', () => {
      void (async () => {
        testBtn.disabled = true
        testOut.style.display = 'block'
        testOut.className = 'dsw-msg'
        testOut.textContent = '请求中……（首次调用要解 PoW，可能需要几秒）'
        try {
          const result = await api('/test', { method: 'POST', body: JSON.stringify({ model: modelSelect.value }) })
          if (result?.ok) {
            testOut.className = 'dsw-msg ok'
            testOut.textContent = `✅ ${result.ms}ms · ${result.model}\n${result.text || '(空响应)'}${result.reasoning ? `\n\n[思考] ${result.reasoning}` : ''}`
          } else {
            testOut.className = 'dsw-msg err'
            testOut.textContent = `❌ ${result?.code ? `[${result.code}] ` : ''}${result?.error ?? '失败'}`
          }
        } catch (error: any) {
          testOut.className = 'dsw-msg err'
          testOut.textContent = `❌ ${error?.message ?? error}`
        }
        testBtn.disabled = false
      })()
    })

    refreshBtn.addEventListener('click', () => void refresh(false))

    root.append(page)
    void refresh(false)
    timer = window.setInterval(() => {
      const active = windowOpen || Date.now() < boostUntil
      if (active) {
        void refresh(true)
        return
      }
      // 空闲态：低频全量刷新（含服务端校验）
      if (Math.random() < 0.15) void refresh(false)
    }, 2000)

    return () => {
      disposed = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [])

  return createElement('div', { ref: hostRef })
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'deepseek-web-login', order: 46, label: () => 'DeepSeek 网页登录' }, () =>
          createElement(Panel),
        ),
      ),
    'deepseek-web-login: settings page',
  )
}
