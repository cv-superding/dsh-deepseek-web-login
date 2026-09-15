/**
 * dsh-deepseek-web-login — client 设置页（slots: settings.section）。
 *
 * 与 host 通过同源 fetch 通信：/deepseek-web-login/api/*
 * 渲染契约（沿用生态实测结论）：槽位 register 必须带 name 字段，
 * 渲染函数返回 React 元素（createElement），React #130 的坑即来自返回非元素。
 */
import { createElement, useEffect, useRef, useState } from 'react'
import {
  pickJsonFile,
  readImportSource,
  saveWithPicker,
  suggestedExportName,
} from '../file-picker.ts'
import { describeCookieLife, summarizeCookieLife } from '../cookies.ts'

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
  auth: {
    loggedIn: boolean
    display?: string
    capturedAt?: string
    hasCookie: boolean
    hasFingerprint: boolean
    wasmHost?: string
    unverified?: boolean
    tokenLength?: number
    /** 观测到的账号级限制解除时间（毫秒时间戳）。只在**生成请求被拒**时才学到。 */
    limitUntilMs?: number | null
    limitObservedAt?: string | null
    /** 最近一次主动探活成功的时间（ISO）。 */
    lastVerifiedAt?: string | null
    /** 最近一次主动探活失败。 */
    lastVerifyError?: { at: string; message: string } | null
    /** cookie 的过期构成（捕获时记下）。老记录 / 手动粘 token 时不存在。 */
    cookieLife?: {
      total: number
      sessionCount: number
      persistentCount: number
      latest?: { name: string; expiresAt: number; daysLeft: number }
    }
  }
  validation?: { ok: boolean; error?: string }
  /** 插件的本地状态目录（「关于」页展示用）。 */
  paths?: { webLogin?: string; accounts?: string; ledger?: string }
  models: { id: string; name: string; description: string; modelType: string; thinking: boolean; contextWindow: number }[]
  config: {
    maxPromptChars: number
    idleTimeoutMs: number
    deleteWebSessions: boolean
    allowConcurrent?: boolean
    minRequestIntervalMs?: number
    version?: string
    probeIntervalMs?: number
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
/* 「上下限」成对的一行：两个滑块并排，右边一个合成值（如「6~10 个」）。
   —— 比"每个边界各占一行"省一半高度，而且两个边界的相对位置一眼能比出来。 */
.dsw-range-pair{flex:1 1 240px;display:flex;gap:8px;align-items:center;min-width:190px}
.dsw-gate-pair-value{font-size:12px;color:var(--fg);min-width:78px;text-align:right;font-variant-numeric:tabular-nums}
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
/* 二级（子页面）标签：**分段胶囊**。
   刻意和一级标签长得不一样（一级是"下划线 + 大字号"），这样一眼能看出自己在第几层；
   否则两层长得一样、用户会以为回到了同一层。 */
.dsw-subtabs{display:inline-flex;gap:2px;padding:3px;margin:0 0 14px;border-radius:999px;
  background:var(--bg1);border:1px solid var(--bd)}
.dsw-subtab{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;
  font-weight:500;color:var(--fg2);padding:4px 14px;border-radius:999px;cursor:pointer;
  transition:color .15s ease,background-color .15s ease}
.dsw-subtab:hover{color:var(--fg)}
/* 选中态：底色用 bg2 铺在 bg1 上，深色主题里这两档只差一点点，
   所以必须再加一圈描边（bd2 比 bd 明显）才立得住 —— 实测深色下不加就跟没选中一样。 */
.dsw-subtab.active{background:var(--bg2);color:var(--fg);font-weight:600;
  box-shadow:inset 0 0 0 1px var(--bd2)}
/* 调用台账 */
.dsw-spark{display:block;width:100%;height:40px;margin:8px 0 2px}
.dsw-spark rect{fill:var(--bd2)}
.dsw-spark rect.on{fill:var(--accent)}
.dsw-spark rect.bad{fill:var(--err)}
.dsw-path{font-family:var(--mono);font-size:11px;color:var(--fg2);word-break:break-all}
/* 账号库 */
.dsw-accounts{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.dsw-account{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--bd);
border-radius:10px;padding:9px 11px;background:var(--bg1)}
.dsw-account.active{border-color:var(--accent)}
.dsw-account-main{flex:1 1 200px;min-width:0}
.dsw-account-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:500}
.dsw-account-meta{font-size:11px;color:var(--fg3);margin-top:3px;word-break:break-all}
.dsw-account-fix{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.dsw-account-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsw-labelinput{font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid var(--bd2);
background:var(--bg2);color:var(--fg);width:150px;margin-top:4px}
.dsw-limit{color:var(--warn)}
/* 操作反馈：不归属任何一页，常驻在标签栏之上 */
.dsw-alert{margin:0 0 12px;padding:8px 10px;border-radius:8px;border:1px solid var(--bd);
background:var(--bg1);white-space:pre-wrap;font-size:12px}
.dsw-alert.ok{border-left:3px solid var(--ok);color:var(--ok)}
.dsw-alert.err{border-left:3px solid var(--err);color:var(--err)}
`

/** 短时间：今天只显示时分，其它显示月/日 时:分。 */
function shortTime(input?: string | number | null): string {
  if (input === undefined || input === null || input === '') return ''
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function relTime(input?: string | null): string {
  if (!input) return ''
  const at = new Date(input).getTime()
  if (!Number.isFinite(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 倒计时：还剩 2 小时 13 分 / 已解除。 */
function countdown(untilMs?: number | null): string {
  if (!untilMs || !Number.isFinite(untilMs)) return ''
  const left = untilMs - Date.now()
  if (left <= 0) return '已解除'
  const totalMinutes = Math.ceil(left / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `剩余 ${hours} 小时 ${minutes} 分`
  return `剩余 ${minutes} 分`
}

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
    const TAB_KEYS = ['account', 'model', 'gate', 'transport', 'context', 'about'] as const
    const TAB_LABELS: Record<string, string> = {
      account: '账号',
      model: '模型',
      gate: '防风控',
      transport: '传输层',
      context: '上下文',
      about: '关于',
    }
    const accountPane = el('div', 'dsw-pane')
    const modelPane = el('div', 'dsw-pane')
    const gatePane = el('div', 'dsw-pane')
    const transportPane = el('div', 'dsw-pane')
    const contextPane = el('div', 'dsw-pane')
    const aboutPane = el('div', 'dsw-pane')
    const panes: Record<string, HTMLElement> = {
      account: accountPane,
      model: modelPane,
      gate: gatePane,
      transport: transportPane,
      context: contextPane,
      about: aboutPane,
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

    // ── 账号页内部再分两个子页 ──────────────────────────────────────
    // 4 张卡堆在一页还是太长。按"你是来看状态、还是来管账号"分：
    //   登录状态  这个号现在能不能用 / 怎么再登一次
    //   账号库    我有哪些号 / 怎么加、切、删、导入导出
    // 子页签用**分段胶囊**，与一级的下划线标签在视觉上分层。
    const ACCT_KEYS = ['status', 'library'] as const
    const ACCT_LABELS: Record<string, string> = { status: '登录状态', library: '账号库' }
    const acctStatusPane = el('div', 'dsw-pane')
    const acctLibraryPane = el('div', 'dsw-pane')
    const acctPanes: Record<string, HTMLElement> = { status: acctStatusPane, library: acctLibraryPane }
    const acctButtons: Record<string, HTMLButtonElement> = {}
    const selectAcctTab = (key: string): void => {
      for (const each of ACCT_KEYS) {
        const on = each === key
        acctPanes[each].hidden = !on
        acctButtons[each].classList.toggle('active', on)
        acctButtons[each].setAttribute('aria-selected', String(on))
      }
    }
    const acctTabBar = el('div', 'dsw-subtabs')
    acctTabBar.setAttribute('role', 'tablist')
    for (const key of ACCT_KEYS) {
      const btn = el('button', 'dsw-subtab', ACCT_LABELS[key]) as HTMLButtonElement
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.addEventListener('click', () => selectAcctTab(key))
      acctButtons[key] = btn
      acctTabBar.append(btn)
      acctPanes[key].setAttribute('role', 'tabpanel')
    }
    accountPane.append(acctTabBar, acctStatusPane, acctLibraryPane)
    // 和一级标签同一个原则：用 hidden 属性切，不靠 CSS 类 ——
    // 万一样式没加载，退化成"两页都显示"（难看但能用），而不是"除了一页全空白"。
    selectAcctTab('status')

    // ── 登录卡 ──
    const loginCard = el('div', 'dsw-card')
    const loginHead = el('div', 'dsw-cardhead')
    const loginTitle = el('div')
    loginTitle.append(el('span', 'name', '登录状态'))
    const badge = el('span', 'dsw-badge off', '⚪ 未登录')
    loginTitle.append(badge)
    loginHead.append(loginTitle)
    loginCard.append(loginHead)

    const statusKv = el('div', 'dsw-kv')
    loginCard.append(statusKv)

    // 账号级限制单独占一行 + 自己的倒计时。
    // 为什么要单独一行、还要挂定时器：这个状态**只在生成请求被拒时才能学到**
    // （受限期间 users/current 依然返回 200），所以不能指望"刷新时顺便更新"，
    // 要让"还剩多久"一直显示着。
    let activeLimitUntilMs: number | null = null
    const limitRow = el('p', 'dsw-hint dsw-limit')
    limitRow.style.display = 'none'
    limitRow.style.marginTop = '8px'
    loginCard.append(limitRow)
    const paintLimit = (): void => {
      if (!activeLimitUntilMs) {
        limitRow.style.display = 'none'
        return
      }
      const text = countdown(activeLimitUntilMs)
      limitRow.style.display = ''
      limitRow.textContent =
        text === '已解除'
          ? `账号级限制已解除（${shortTime(activeLimitUntilMs)}）。`
          : `⚠️ 账号级限制：${text}（${shortTime(activeLimitUntilMs)} 解除）—— 期间生成会被拒；只读调用（校验 / 探活）不受影响。`
    }

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
      '⚠️ 「退出」= 把该账号从账号库移除，不是"只登出"：本地凭证与浏览器登录态会一起清掉。' +
        '想留住它就先「导出备份」；只是想换个号用，去「账号库 → 登录新账号」。',
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
    acctStatusPane.append(loginCard, accountCard)

    // ── 账号库：多账号并存 + 一键切换 ────────────────────────────────
    // 为什么值得有：以前换号的代价是「退出 → 清浏览器分区 → 重新登录 → 等捕获」，
    // 期间原来的号也回不去了。现在保存过的账号都在库里，切换即时生效。
    //
    // ⚠️ 风险已在 src/accounts.ts 的模块注释里写明，这里再对使用者说一遍：
    // 用多账号轮换规避单账号限流，会被服务商把账号关联起来，处置通常更重。
    // 所以刻意**只提供手动切换、不做自动轮换** —— 真人不会几分钟换一个号接着发。
    /**
     * 一句话反馈节点：给它的 `textContent` 赋值时**自动选样式** ——
     * 命中「失败/错误/无法」→ 红框红字（醒目），以「已…」开头 → 绿框，其余 → 灰色小字。
     *
     * 为什么自动判定、而不是让每个调用点传 kind（2026-09-15 用户反馈）：
     * 「账号切换失败」原来和旁边的说明文字长得一模一样（都是灰色小字），根本注意不到。
     * 这三个节点加起来 40 多个赋值点，靠人手传 kind 迟早会漏 —— 而漏掉的那个往往正是报错。
     */
    const createMsgNode = (): { node: HTMLElement; textContent: string } => {
      const node = el('p', 'dsw-hint dsw-gate-msg', '')
      let text = ''
      return {
        node,
        get textContent(): string {
          return text
        },
        set textContent(value: string) {
          text = value ?? ''
          node.textContent = text
          node.className = /失败|错误|无法|不对|⚠️/.test(text)
            ? 'dsw-msg err'
            : /^(✅|已切换|已移除|已捕获|已保存|已原地)/.test(text)
              ? 'dsw-msg ok'
              : 'dsw-hint dsw-gate-msg'
        },
      }
    }

    const accountsCard = el('div', 'dsw-card')
    const accountsHead = el('div', 'dsw-cardhead')
    accountsHead.append(el('span', 'name', '账号库'))
    const accountsBadge = el('span', 'dsw-badge off', '—')
    accountsHead.append(accountsBadge)
    accountsCard.append(accountsHead)
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        '💡 保存过的账号都在本机，点「切换」即时生效、不用重新登录 —— 切换后从下一次请求开始生效。',
      ),
    )

    const accountsList = el('ul', 'dsw-accounts')
    accountsCard.append(accountsList)
    const accountsEmpty = el('p', 'dsw-hint', '账号库是空的 —— 用上面的「登录」或「手动粘贴 Token」添加一个。')
    accountsCard.append(accountsEmpty)

    const accountsIOPanel = el('div', 'dsw-row')
    accountsIOPanel.style.marginTop = '10px'
    // 「登录新账号」：以前账号库**根本没有"再加一个号"的入口** ——
    // 两个退出按钮都会先把这个号从库里删掉，所以库永远攒不到第二个账号。
    const addAccountBtn = el('button', 'dsw-btn', '登录新账号（添加）') as HTMLButtonElement
    const exportBtn = el('button', 'dsw-btn ghost', '导出备份…') as HTMLButtonElement
    const importBtn = el('button', 'dsw-btn ghost', '导入备份…') as HTMLButtonElement
    accountsIOPanel.append(addAccountBtn, exportBtn, importBtn)
    accountsCard.append(accountsIOPanel)
    // 以前这里是个"要导入的备份文件路径"输入框 —— 让人手打路径本来就别扭。
    // 现在两个按钮都弹**系统对话框**（另存为 / 打开），位置和文件名由用户自己选。
    // 实现见 src/file-picker.ts（宿主是 utility 进程，拿不到 Electron 的 dialog，
    // 只能由渲染进程用 Chromium 自己的能力做）。
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        '💡 「登录新账号」会先清掉上次的浏览器登录态（库里已有的账号不受影响），登录后新账号只入库、不切换当前账号 ——' +
          '加完在列表里点「切换」即可使用。某个账号标着「需要重新登录」时，用它自己那行上的按钮修 ——' +
          '那条路不清浏览器登录态，能复用就直接复用。导出/导入会弹系统对话框，自己选位置和文件。',
      ),
    )
    const accountsMsg = createMsgNode()
    accountsCard.append(accountsMsg.node)
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        '⚠️ 导出的备份文件就是可完整登录的凭证（等同于账号本身）—— 别分享、别提交到仓库。',
      ),
    )
    acctLibraryPane.append(accountsCard)

    const renderAccounts = (data: any): void => {
      const items: any[] = Array.isArray(data?.accounts) ? data.accounts : []
      accountsBadge.textContent = `${items.length} 个`
      accountsBadge.className = `dsw-badge ${items.length ? 'on' : 'off'}`
      accountsEmpty.hidden = items.length > 0
      accountsList.textContent = ''
      for (const item of items) accountsList.append(accountRow(item))
    }

    /**
     * 「重新登录这个账号」：给凭证失效（探活失败）的账号用。
     *
     * 与「登录新账号」的唯一区别是**不清浏览器登录态**：后者要先清干净才能加到别的号，
     * 而修同一个号正相反 —— 留着才可能一打开就复用上。落库仍走添加模式（只入库、不切换），
     * 所以修好它也不会顶掉你正在用的账号；若它本来就是当前账号，那正是你要的效果。
     */
    const reloginAccount = (id: string, title: string): void => {
      void (async () => {
        accountsMsg.textContent = `正在为「${title}」打开登录窗口（不清理浏览器登录态，能复用就直接复用）……`
        try {
          const prep = await api('/login/relogin', { method: 'POST', body: JSON.stringify({ id }) })
          if (prep?.ok === false) {
            accountsMsg.textContent = `准备失败：${prep?.error ?? '未知原因'}`
            return
          }
          boostUntil = Date.now() + 300_000
          accountsMsg.textContent =
            '登录窗口已打开：浏览器里若还留着这个账号的登录态会立刻复用；否则在里面重新登录一次……'
          const result = await api('/login/browser', { method: 'POST', body: '{}' })
          if (result?.started === false) {
            accountsMsg.textContent = `打开登录窗口失败：${result?.reason ?? '未知原因'}（可改用「手动粘贴 Token」）`
            return
          }
          accountsMsg.textContent = result?.relogin
            ? `「${title}」的凭证已原地更新（同一条记录、当前账号未变），旧的失败标记也清掉了。`
            : result?.added
              ? `「${title}」已加入账号库 —— 当前使用的账号没有改变。`
              : '已捕获并保存凭证。'
          await loadAccounts()
        } catch (error: any) {
          accountsMsg.textContent = `重新登录失败：${error?.message ?? error}`
        } finally {
          await refresh(false).catch(() => undefined)
        }
      })()
    }

    const accountRow = (item: any): HTMLElement => {
      const row = el('li', `dsw-account${item.isActive ? ' active' : ''}`)
      const main = el('div', 'dsw-account-main')
      const title = el('div', 'dsw-account-title')
      title.append(el('span', undefined, item.title || item.id))
      if (item.isActive) title.append(el('span', 'dsw-badge on', '✅ 当前'))
      if (item.unverified) title.append(el('span', 'dsw-badge off', '❔ 未校验'))
      const limited = item.limit && Number.isFinite(item.limit.untilMs) && item.limit.untilMs > Date.now()
      if (limited) {
        title.append(el('span', 'dsw-badge off', `⏳ 受限至 ${shortTime(item.limit.untilMs)}`))
      }
      // 徽章从「校验失败」改成**明确的行动指令**：原来只写"失败"，用户不知道该干嘛，
      // 也看不出这号还能不能用。探活失败基本只有一种可能 —— 凭证失效，要重新登录。
      if (item.lastVerifyError) title.append(el('span', 'dsw-badge err', '❌ 需要重新登录'))
      main.append(title)

      const meta: string[] = []
      if (item.display) meta.push(item.display)
      if (item.capturedAt) meta.push(`${shortTime(item.capturedAt)} 捕获`)
      meta.push(item.lastVerifiedAt ? `最近校验 ${relTime(item.lastVerifiedAt)}` : '尚未校验')
      const cookieMeta: any[] = Array.isArray(item.cookieMeta) ? item.cookieMeta : []
      meta.push(`cookie：${describeCookieLife(summarizeCookieLife(cookieMeta))}`)
      main.append(el('div', 'dsw-account-meta', meta.join(' · ')))

      // 探活失败 → 不只报状态，给一条可执行的路径。
      // 为什么这里用「重新登录」而不是让用户自己点「登录新账号」：后者会**先清掉浏览器
      // 登录态**（因为它的目标是加一个*别的*号），而修同一个号正相反 —— 浏览器里可能还
      // 留着登录态，不清就能一打开直接复用，一个密码都不用敲。见宿主 /login/relogin。
      if (item.lastVerifyError) {
        // 只留一行说明（短、留在行内）；修复按钮挪到右侧动作列 ——
        // 原来它独占一整行、又长又占地方（用户反馈：放到 切换/重命名/移除 那一列去）。
        main.append(
          el(
            'div',
            'dsw-account-fix',
            `⚠️ ${relTime(item.lastVerifyError.at)}校验失败：${item.lastVerifyError.message}`,
          ),
        )
      }
      row.append(main)

      const actions = el('div', 'dsw-account-actions')
      // 失效的账号：「重新登录」放动作列最前面 —— 它是这行最该点的按钮
      if (item.lastVerifyError) {
        const reloginBtn = el('button', 'dsw-btn dsw-preset', '重新登录') as HTMLButtonElement
        reloginBtn.title = '不清理浏览器登录态（能复用就直接复用）；捕获后原地更新这条记录，不新增、也不切换当前账号'
        reloginBtn.addEventListener('click', () => reloginAccount(item.id, item.title || item.id))
        actions.append(reloginBtn)
      }
      if (item.isActive) {
        actions.append(el('span', 'dsw-hint', '使用中'))
      } else {
        const useBtn = el('button', 'dsw-btn ghost dsw-preset', '切换') as HTMLButtonElement
        useBtn.addEventListener('click', () => void switchToAccount(item.id))
        actions.append(useBtn)
      }

      const renameBtn = el('button', 'dsw-btn ghost dsw-preset', '重命名') as HTMLButtonElement
      let editing = false
      renameBtn.addEventListener('click', () => {
        if (editing) return
        editing = true
        const input = el('input', 'dsw-labelinput') as HTMLInputElement
        input.value = item.label || ''
        input.placeholder = '备注名，如「工作号」'
        main.append(input)
        input.focus()
        let settled = false
        const commit = (): void => {
          if (settled) return
          settled = true
          void saveAccountLabel(item.id, input.value)
        }
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            settled = true
            void loadAccounts()
          }
        })
        input.addEventListener('blur', commit)
      })
      actions.append(renameBtn)

      // 移除要二次确认：凭证一旦删掉就找不回来了（不保留明文归档，见 accounts.ts）
      const removeBtn = el('button', 'dsw-btn danger dsw-preset', '移除') as HTMLButtonElement
      let armed = false
      removeBtn.addEventListener('click', () => {
        if (!armed) {
          armed = true
          removeBtn.textContent = '确认移除？'
          removeBtn.classList.add('armed')
          window.setTimeout(() => {
            armed = false
            removeBtn.textContent = '移除'
            removeBtn.classList.remove('armed')
          }, 4_000)
          return
        }
        void removeAccountById(item.id)
      })
      actions.append(removeBtn)
      row.append(actions)
      return row
    }

    const loadAccounts = async (): Promise<void> => {
      try {
        renderAccounts(await api('/accounts'))
      } catch (error: any) {
        accountsMsg.textContent = `账号库读取失败：${error?.message ?? error}`
      }
    }

    const switchToAccount = async (id: string): Promise<void> => {
      accountsMsg.textContent = '切换中……'
      try {
        const result = await api('/accounts/switch', { method: 'POST', body: JSON.stringify({ id }) })
        if (!result?.ok) {
          accountsMsg.textContent = `切换失败：${result?.error ?? '未知原因'}`
          return
        }
        accountsMsg.textContent = '已切换（下一次请求生效）。正在刷新登录状态……'
        await loadAccounts()
        await refresh(false)
        accountsMsg.textContent = '已切换（下一次请求生效）'
      } catch (error: any) {
        accountsMsg.textContent = `切换失败：${error?.message ?? error}`
      }
    }

    const removeAccountById = async (id: string): Promise<void> => {
      try {
        const result = await api('/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) })
        if (!result?.ok) {
          accountsMsg.textContent = `移除失败：${result?.error ?? '未知原因'}`
          return
        }
        accountsMsg.textContent = '已移除该账号（凭证已删除）'
        await loadAccounts()
        await refresh(true)
      } catch (error: any) {
        accountsMsg.textContent = `移除失败：${error?.message ?? error}`
      }
    }

    const saveAccountLabel = async (id: string, label: string): Promise<void> => {
      try {
        await api('/accounts/rename', { method: 'POST', body: JSON.stringify({ id, label }) })
      } catch {}
      await loadAccounts()
    }

    addAccountBtn.addEventListener('click', () => {
      void (async () => {
        addAccountBtn.disabled = true
        accountsMsg.textContent = '正在准备登录窗口（会清掉上次的浏览器登录态，不影响账号库里的账号）……'
        try {
          const prep = await api('/login/add', { method: 'POST', body: '{}' })
          if (prep?.ok === false) {
            accountsMsg.textContent = `准备失败：${prep?.error ?? '未知原因'}`
            return
          }
          // 登录窗口是"打开后等用户操作"的，这里会一直等到捕获到凭证或超时；
          // 期间保持轮询更密一点，万一捕获是异步落地的也能及时刷出来。
          boostUntil = Date.now() + 300_000
          accountsMsg.textContent = '登录窗口已打开：请在窗口里登录另一个账号（不要登当前这个，否则只是刷新凭证）……'
          const result = await api('/login/browser', { method: 'POST', body: '{}' })
          if (result?.started === false) {
            accountsMsg.textContent = `打开登录窗口失败：${result?.reason ?? '未知原因'}（可改用「手动粘贴 Token」）`
            return
          }
          if (result?.added) {
            accountsMsg.textContent = result.created
              ? '已把新账号加入账号库 —— 当前账号没有改动，点列表里的「切换」才会用它。'
              : '这个账号本来就在库里（凭证已更新）—— 当前账号未改动。'
          } else {
            accountsMsg.textContent = '已捕获并保存凭证。'
          }
          await loadAccounts()
        } catch (error: any) {
          accountsMsg.textContent = `添加账号失败：${error?.message ?? error}`
        } finally {
          addAccountBtn.disabled = false
          await refresh(false).catch(() => undefined)
        }
      })()
    })

    exportBtn.addEventListener('click', () => {
      void (async () => {
        exportBtn.disabled = true
        accountsMsg.textContent = '导出中……'
        try {
          // 先弹系统「另存为」，内容在用户选完位置后再取（顺序见 file-picker.ts 的注释）。
          const outcome = await saveWithPicker(suggestedExportName(), async () => {
            const data = await api('/accounts/export-json', { method: 'POST', body: '{}' })
            if (!data?.ok) throw new Error(data?.error ?? '读取备份内容失败')
            const { ok: _ok, ...backup } = data
            return JSON.stringify(backup, null, 2)
          })

          if (outcome.kind === 'saved') {
            accountsMsg.textContent = `已保存：${outcome.name}（含明文凭证，请妥善保管）`
          } else if (outcome.kind === 'cancelled') {
            accountsMsg.textContent = '已取消导出。'
          } else {
            // 系统「另存为」不可用 → 回退到宿主写插件目录（功能不因此失效，只是不能选位置）
            const result = await api('/accounts/export', { method: 'POST', body: '{}' })
            const why = outcome.kind === 'unsupported' ? '当前环境不支持系统另存为' : `系统另存为失败（${outcome.reason}）`
            accountsMsg.textContent = result?.ok
              ? `${why}，已改为保存到插件目录：${result.path}`
              : `导出失败：${result?.error ?? '未知原因'}`
          }
        } catch (error: any) {
          accountsMsg.textContent = `导出失败：${error?.message ?? error}`
        } finally {
          exportBtn.disabled = false
        }
      })()
    })

    importBtn.addEventListener('click', () => {
      void (async () => {
        importBtn.disabled = true
        accountsMsg.textContent = '请选择备份文件……'
        try {
          const file = await pickJsonFile()
          if (!file) {
            accountsMsg.textContent = '已取消导入。'
            return
          }
          accountsMsg.textContent = `正在读取 ${file.name}……`
          const source = await readImportSource(file)
          if (source.kind === 'unreadable') {
            accountsMsg.textContent = `读取失败：${source.name} 不是有效的 JSON 备份（${source.reason}）`
            return
          }
          // 拿到真实路径时只把**路径**交给宿主（宿主自己读文件，凭证不进 HTTP）；
          // 拿不到才退回传内容 —— 兜底，免得宿主没注入路径桥时功能整体失效。
          const body = source.kind === 'path' ? { path: source.path } : { payload: source.payload }
          const result = await api('/accounts/import', { method: 'POST', body: JSON.stringify(body) })
          accountsMsg.textContent = result?.ok
            ? `导入完成（${source.name}）：新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}`
            : `导入失败：${result?.error ?? '未知原因'}`
          if (result?.ok) await loadAccounts()
        } catch (error: any) {
          accountsMsg.textContent = `导入失败：${error?.message ?? error}`
        } finally {
          importBtn.disabled = false
        }
      })()
    })

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
    acctLibraryPane.append(tokenCard)

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
    let probeIntervalMs = 0

    const renderKv = (rows: [string, string][]): void => {
      statusKv.textContent = ''
      for (const [key, value] of rows) {
        statusKv.append(el('div', 'k', key), el('div', undefined, value))
      }
    }

    /**
     * 上下文页的状态渲染。卡片在下面才建，这里用"先声明后赋值"的方式接上 ——
     * 直接引用下面的 const 会在时序上踩 TDZ（applyStatus 早于卡片构造）。
     */
    let renderContextStatus: ((mode: string, chain: any) => void) | undefined

    const applyStatus = (status: StatusPayload): void => {
      loggedIn = !!status.auth?.loggedIn
      electron = !!status.electron
      windowOpen = !!status.loginWindowOpen
      // 上下文投喂的实际状态（模式 + 链是否真的在跑）跟着状态轮询刷新。
      // ⚠️ 这两个字段在 /status 的 **config** 里 —— 0.1.62 写成了顶层，等于这段从来没生效
      //    （面板不重开就永远停在打开那一刻的段数），0.1.63 修正。
      const cfg = status.config as { contextMode?: string; contextChain?: unknown } | undefined
      if (cfg?.contextMode) {
        renderContextStatus?.(String(cfg.contextMode), cfg.contextChain)
      }

      badge.textContent = loggedIn ? (status.auth.unverified ? '❔ 已捕获（未校验）' : '✅ 已登录') : '⚪ 未登录'
      badge.className = `dsw-badge ${loggedIn ? (status.auth.unverified ? 'off' : 'on') : 'off'}`
      if (loggedIn && !status.auth.unverified) {
        const valid = status.validation
        if (valid && !valid.ok) {
          badge.textContent = '❌ 登录态校验失败'
          badge.className = 'dsw-badge err'
        }
      }

      const rows: [string, string][] = []
      activeLimitUntilMs = Number.isFinite(status.auth?.limitUntilMs) ? Number(status.auth?.limitUntilMs) : null
      paintLimit()
      probeIntervalMs = Number(status.config?.probeIntervalMs ?? 0)
      renderVersion({ current: status.config?.version, probeIntervalMs })
      renderPaths(status.paths)
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
        if (status.auth.hasCookie) {
          // 把"登录态到底还能撑多久"从完全不可观察变成至少能看一半。
          // ⚠️ 措辞必须诚实：实测真正鉴权用的是 token（只发 token 不带 cookie 能通过，
          // 只发 cookie 不带 token 直接被拒 40002），所以这里只是**浏览器侧的上界**，
          // 不能让人读成"到这天就掉线"。
          rows.push([
            'Cookie 过期',
            `${describeCookieLife(status.auth.cookieLife)}（会话级 = 浏览器关掉就没了；这是浏览器侧的上界，不是登录态寿命）`,
          ])
        }
        rows.push(['指纹头', status.auth.hasFingerprint ? '✅ 已捕获（x-hif-* / x-client-*）' : '未捕获 —— 同上，已实测可用'])
        rows.push(['PoW WASM', status.auth.wasmHost || '默认地址'])
        rows.push(['token 长度', `${status.auth.tokenLength ?? 0} 字符`])
        if (status.validation) rows.push(['服务端校验', status.validation.ok ? '通过' : `失败：${status.validation.error ?? ''}`])

        // 主动探活（后台定时做的，与上面这次"按需校验"是两件事）：
        // 目的就是**在任务跑到一半之前**发现登录态失效。
        const verifiedAt = status.auth?.lastVerifiedAt
        const verifyError = status.auth?.lastVerifyError
        if (verifyError) {
          rows.push([
            '登录态探活',
            `❌ ${relTime(verifyError.at)}失败：${verifyError.message}（可能已过期，建议重新登录）`,
          ])
        } else if (verifiedAt) {
          rows.push(['登录态探活', `✅ ${relTime(verifiedAt)}通过（后台定时校验，零额度）`])
        }
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

    // ── prompt 上限（token 体量的总阀门）──────────────────────────
    // 为什么它比"间隔"更值得调：网页 API 无状态 → **每一轮都要把整段转写重发**，
    // 转写越长、单次请求越贵。实测同一个会话里单次输入估算从 9.7k token 涨到 293k
    // （180 轮累计约 2900 万），随后账号被限流。间隔只影响"多久发一次"，这个才影响"每次发多少"。
    const promptRow = el('div', 'dsw-gate-row')
    promptRow.append(el('span', 'dsw-gate-label', 'prompt 上限'))
    const promptRange = el('input', 'dsw-range') as HTMLInputElement
    promptRange.type = 'range'
    promptRange.setAttribute('aria-label', 'prompt 字符上限')
    promptRange.title = '每次请求最多发送多少字符（含工具目录与全部历史）'
    const promptValue = el('span', 'dsw-gate-value', '—')
    promptRow.append(promptRange, promptValue)
    gateCard.append(promptRow)
    const promptHint = el('p', 'dsw-hint', '')
    gateCard.append(promptHint)

    /** 字符数 → 「万字符」。界面上出现一长串 0 没人看得出差别。 */
    const fmtChars = (n: number): string => `${Number.isFinite(n) ? (n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1) : '—'} 万字符`

    const paintPromptCap = (): void => {
      const chars = Number(promptRange.value)
      promptValue.textContent = fmtChars(chars)
      const level = chars >= 1_200_000 ? '偏高' : chars >= 600_000 ? '中等' : '省 token'
      promptHint.textContent =
        `每次请求最多发送 ${fmtChars(chars)}（${level}）。` +
        '网页端是无状态的，每一轮都会把整段对话历史重新发一遍：' +
        '上限越大，模型越不容易「忘事」，但单次消耗的 token 也越多。' +
        '长任务建议调小，或拆成多个会话（新会话从零开始，单次最省）。'
    }
    // 把「底部那两个数字到底怎么来的」直接写在界面上：
    // 否则「缓存命中 0%」会被当成"真的没命中"，而它其实只是我们没有上报。
    const tokenNote = el('p', 'dsw-hint', '')
    tokenNote.textContent =
      '💡 说明：DSH 底部的 token 数目前是按字符估算的（网页端只回一个「本消息累计 token」，' +
      '我们还没接进来）；「缓存命中 0%」是因为网页端不提供缓存信息、我们也就没有上报 —— ' +
      '不代表真的没命中。'
    gateCard.append(tokenNote)

    promptRange.addEventListener('input', paintPromptCap)
    promptRange.addEventListener('change', () => {
      paintPromptCap()
      void saveGate({ maxPromptChars: Number(promptRange.value) })
    })

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

    // ── 会话清理的三个区间（只在「延迟」模式显示）──────────────────────
    // 为什么这三个参数也要"上下限 + 随机"：它们原来都是**死值** —— 攒到第 8 个就动手、
    // 正好等 90 秒、逐个删除时请求连发。固定值方差≈0，本身就是机器特征；真人不会这么精确。
    // 所以每个参数给一对上下限，实际取值在区间内**随机抽**（阈值/等待每轮重抽，删除间隔每次重抽）。
    const cleanupRanges = el('div')
    cleanupRanges.style.display = 'none'
    gateCard.append(cleanupRanges)

    /** 一对「上下限」滑块：一行两个 range + 右侧合成值。拖动中只更新数字，松手才提交。 */
    const rangePair = (
      label: string,
      bounds: { min: number; max: number },
      step: string,
      format: (lo: number, hi: number) => string,
      commit: (lo: number, hi: number) => void,
    ): { row: HTMLElement; set: (lo: number, hi: number) => void } => {
      const row = el('div', 'dsw-gate-row')
      row.append(el('span', 'dsw-gate-label', label))
      const lo = el('input', 'dsw-range') as HTMLInputElement
      const hi = el('input', 'dsw-range') as HTMLInputElement
      for (const [input, which] of [[lo, '下限'], [hi, '上限']] as const) {
        input.type = 'range'
        input.min = String(bounds.min)
        input.max = String(bounds.max)
        input.step = step
        input.setAttribute('aria-label', `${label}${which}`)
        input.title = `${label}${which}`
      }
      const value = el('span', 'dsw-gate-pair-value', '—')
      const paint = (): void => {
        value.textContent = format(Number(lo.value), Number(hi.value))
      }
      const onInput = (): void => {
        // 两个滑块允许被拖反 —— 当场收紧成「下限 <= 上限」。
        // 后端也会纠正，但界面先纠更直观：总比"拖完看着不对、过一会儿自己跳回去"好。
        if (Number(lo.value) > Number(hi.value)) {
          const swap = lo.value
          lo.value = hi.value
          hi.value = swap
        }
        paint()
      }
      const onCommit = (): void => commit(Number(lo.value), Number(hi.value))
      lo.addEventListener('input', onInput)
      hi.addEventListener('input', onInput)
      lo.addEventListener('change', onCommit)
      hi.addEventListener('change', onCommit)
      const pair = el('div', 'dsw-range-pair')
      pair.append(lo, hi)
      row.append(pair, value)
      return {
        row,
        set: (lo2, hi2) => {
          lo.value = String(lo2)
          hi.value = String(hi2)
          paint()
        },
      }
    }

    const batchPair = rangePair(
      '攒够数量',
      { min: 1, max: 50 },
      '1',
      (lo, hi) => `${lo}~${hi} 个`,
      (lo, hi) => void saveGate({ cleanupBatch: { min: lo, max: hi } }),
    )
    const delayPair = rangePair(
      '最长等待',
      { min: 5, max: 600 },
      '5',
      (lo, hi) => `${lo}~${hi} 秒`,
      (lo, hi) => void saveGate({ cleanupDelayMs: { min: Math.round(lo * 1000), max: Math.round(hi * 1000) } }),
    )
    const gapPair = rangePair(
      '删除间隔',
      { min: 0, max: 60 },
      '0.1',
      (lo, hi) => (hi <= 0 ? '不等待' : `${lo.toFixed(1)}~${hi.toFixed(1)} 秒`),
      (lo, hi) => void saveGate({ cleanupGapMs: { min: Math.round(lo * 1000), max: Math.round(hi * 1000) } }),
    )
    cleanupRanges.append(batchPair.row, delayPair.row, gapPair.row)
    cleanupRanges.append(
      el(
        'p',
        'dsw-hint',
        '上面三个都是「下限 ~ 上限」：实际取值每次在区间内随机抽 —— 攒批阈值与最长等待每轮清理重抽、' +
          '删除间隔每删一个重抽。这样"什么时候动手删"就没有固定规律了。',
      ),
    )
    cleanupRanges.append(
      el(
        'p',
        'dsw-hint',
        '「删除间隔」只在逐个删除时起作用：优先走一个请求批量删；若服务端不接受批量删（会自动退化为逐个删），' +
          '相邻两个删除请求之间就按这个间隔停一下 —— 避免"一下子连发几十个删除请求"。',
      ),
    )

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

    // ── 调用台账：请求密度 + 失败分类 ──────────────────────────────
    // 节流"到底有没有生效"不能靠感觉 —— 看两个数：相邻对话的间隔分布（最短间隔说明有没有连环请求）、
    // 以及失败分类（限流 / 账号被限制 / 鉴权 / 网络各占多少）。
    const ledgerCard = el('div', 'dsw-card')
    const ledgerHead = el('div', 'dsw-cardhead')
    ledgerHead.append(el('span', 'name', '调用台账'))
    const ledgerBadge = el('span', 'dsw-badge off', '近 24 小时')
    ledgerHead.append(ledgerBadge)
    ledgerCard.append(ledgerHead)
    ledgerCard.append(
      el('p', 'dsw-hint', '本地记录每次调用的结果（不含任何对话内容与凭证）。用来判断节流是否真的在起作用。'),
    )
    const ledgerKv = el('div', 'dsw-kv')
    ledgerCard.append(ledgerKv)
    const ledgerSparkBox = el('div')
    ledgerCard.append(ledgerSparkBox)
    const ledgerRow = el('div', 'dsw-row')
    const ledgerRefreshBtn = el('button', 'dsw-btn ghost', '刷新台账') as HTMLButtonElement
    ledgerRow.append(ledgerRefreshBtn)
    ledgerCard.append(ledgerRow)
    const ledgerMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    ledgerCard.append(ledgerMsg)
    gatePane.append(ledgerCard)

    /** 24 根小柱：每小时调用量。高度按最大值归一，失败多的时段用红色。 */
    const sparkSvg = (hourly: number[], failedHours: Set<number>): string => {
      const values = hourly.length ? hourly : [0]
      const max = Math.max(1, ...values)
      const barW = 100 / values.length
      let out = '<svg class="dsw-spark" viewBox="0 0 100 100" preserveAspectRatio="none">'
      values.forEach((value, index) => {
        const height = (value / max) * 100
        // 基础填充由 .dsw-spark rect 给；只有"有失败"的时段才额外挂 class（CSS 里 .bad 覆盖填充色）
        const cls = failedHours.has(index) ? ' class="bad"' : ''
        out += `<rect${cls} x="${(index * barW).toFixed(2)}" y="${(100 - height).toFixed(2)}" width="${(barW * 0.7).toFixed(2)}" height="${Math.max(height, value > 0 ? 3 : 0.6).toFixed(2)}" rx="1"></rect>`
      })
      out += '</svg>'
      return out
    }

    const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`)

    const renderLedger = (data: any): void => {
      const calls = Number(data?.calls ?? 0)
      ledgerBadge.textContent = `近 ${data?.hours ?? 24} 小时`
      ledgerBadge.className = `dsw-badge ${calls > 0 ? 'on' : 'off'}`
      ledgerKv.textContent = ''
      ledgerSparkBox.textContent = ''
      if (calls === 0) {
        ledgerMsg.textContent = '还没有记录 —— 跑一次对话后回来看。'
        return
      }
      const push = (key: string, value: string): void => {
        ledgerKv.append(el('div', 'k', key), el('div', undefined, value))
      }
      push('调用次数', `${calls}（成功 ${data.succeeded ?? 0} / 失败 ${data.failed ?? 0}）`)
      const gaps = data.gaps
      push(
        '相邻对话间隔',
        gaps
          ? `中位 ${fmtMs(gaps.p50)} · p90 ${fmtMs(gaps.p90)} · 最短 ${fmtMs(gaps.min)}（样本 ${gaps.samples}）`
          : '样本不足',
      )
      if (gaps && gaps.min < 1_500) {
        ledgerMsg.textContent = `⚠️ 出现过 ${fmtMs(gaps.min)} 的极短间隔 —— 检查一下节流是否被关掉了。`
      }
      const failures = data.failures ?? {}
      push(
        '失败分类',
        Object.keys(failures).length ? Object.entries(failures).map(([key, count]) => `${key} ${count}`).join(' · ') : '无',
      )
      push('台账占用', `${data.footprint?.files ?? 0} 个文件 · ${Math.round((data.footprint?.bytes ?? 0) / 1024)} KB`)
      const hourly: number[] = Array.isArray(data.hourly) ? data.hourly : []
      ledgerSparkBox.innerHTML = sparkSvg(hourly, new Set())
      ledgerSparkBox.append(el('p', 'dsw-hint', `每小时调用量（最近 1 小时在最右，峰值 ${Math.max(0, ...hourly)} 次）`))
    }

    const loadLedger = async (): Promise<void> => {
      try {
        renderLedger(await api('/ledger?hours=24'))
      } catch (error: any) {
        ledgerMsg.textContent = `台账读取失败：${error?.message ?? error}`
      }
    }
    ledgerRefreshBtn.addEventListener('click', () => void loadLedger())

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

    const transportMsg = createMsgNode()
    transportCard.append(transportMsg.node)
    transportPane.append(transportCard)

    // ── 上下文页：每轮发全量 prompt，还是只发增量 + 父消息链 ────────────
    // 背景（2026-09-14，读参考实现 + 抓真实帧得出）：插件一直发 parent_message_id:null，
    // 每条消息都是会话里的根消息、没有父链，服务端回溯上下文到空 —— 所以历史只能每轮重发。
    // 浏览器不是这么干的（只有会话第一条 parent 是 null），链式投喂就是照它做：
    // 只发增量、把上一条回答挂成父消息。代价是工具协议只存在于链首那条消息里，
    // 一旦服务端把早期上下文丢掉，模型可能不按约定格式发工具调用 —— 所以默认仍是全量。
    const contextCard = el('div', 'dsw-card')
    contextCard.append(el('div', 'dsw-cardhead', '上下文投喂方式'))
    const contextRow = el('div', 'dsw-gate-row')
    contextRow.append(el('span', 'dsw-gate-label', '每轮发什么'))
    const contextBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['full', '每轮全量（默认）'],
      ['chained', '链式投喂（只发增量）'],
    ] as const) {
      const key = pair[0]
      const btn = el('button', 'dsw-btn ghost dsw-preset', pair[1]) as HTMLButtonElement
      btn.addEventListener('click', () => void saveContextMode(key))
      contextBtns[key] = btn
      contextRow.append(btn)
    }
    contextCard.append(contextRow)
    const contextStatus = el('p', 'dsw-hint', '')
    contextCard.append(contextStatus)
    const contextHintText = el('p', 'dsw-hint', '')
    contextCard.append(contextHintText)
    const contextMsg = createMsgNode()
    contextCard.append(contextMsg.node)
    contextPane.append(contextCard)

    renderContextStatus = (rawMode: string, chain: any): void => {
      const mode = rawMode === 'chained' ? 'chained' : 'full'
      for (const key of Object.keys(contextBtns)) {
        contextBtns[key].classList.toggle('active', key === mode)
      }
      if (chain) {
        contextStatus.textContent =
          `链式投喂正在跑：网页端会话 ${String(chain.sessionId ?? '').slice(0, 8)}，` +
          `链上已发 ${chain.turns} 段，父消息 ${chain.parentId}`
      } else {
        contextStatus.textContent =
          mode === 'chained'
            ? '链式投喂：下一条消息会重新起链（当前没有可续的链，或还没开始用）'
            : '当前：每轮重发全量 prompt（和以前完全一致）'
      }
    }

    const applyContextCard = (info: any): void => {
      renderContextStatus?.(String(info?.mode ?? 'full'), info?.chain)
      const hint = String(info?.hint ?? '')
      // 设置文件路径单独一行 —— 想手工改配置的人需要它
      const path = String(info?.settingsPath ?? '')
      contextHintText.textContent = path ? `${hint}\n配置文件：${path}` : hint
    }

    const saveContextMode = async (mode: 'full' | 'chained'): Promise<void> => {
      contextMsg.textContent = '切换中……'
      try {
        const result = await api('/context-mode', { method: 'POST', body: JSON.stringify({ mode }) })
        if (result?.ok) {
          applyContextCard(result)
          contextMsg.textContent =
            `已切到${result.mode === 'chained' ? '链式投喂' : '每轮全量'}，即时生效` +
            (result.persisted === false
              ? '（未能写入配置，重启后会回到上次保存的值）'
              : '（已写入配置，重启后仍生效）')
        } else {
          contextMsg.textContent = `切换失败：${result?.error ?? '未知原因'}`
        }
      } catch (error: any) {
        contextMsg.textContent = `切换失败：${error?.message ?? error}`
      }
    }

    // ── 关于页：版本与更新 / 数据位置 / 风险提示 ────────────────────
    // 单独一个标签而不是塞进别的页：这三块都是"偶尔看一眼"的信息，
    // 混进日常操作的页里只会稀释注意力。
    const aboutCard = el('div', 'dsw-card')
    aboutCard.append(el('div', 'dsw-cardhead', '版本与更新'))
    const versionKv = el('div', 'dsw-kv')
    aboutCard.append(versionKv)
    const updateRow = el('div', 'dsw-row')
    updateRow.style.marginTop = '8px'
    const updateBtn = el('button', 'dsw-btn ghost', '检查更新') as HTMLButtonElement
    updateRow.append(updateBtn)
    aboutCard.append(updateRow)
    const updateMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    aboutCard.append(updateMsg)
    aboutCard.append(
      el('p', 'dsw-hint', '插件装不了包，所以这里只做"检查 + 给链接"。GitHub 在国内可能连不上，检查失败是正常的。'),
    )
    aboutPane.append(aboutCard)

    const renderVersion = (info: any): void => {
      versionKv.textContent = ''
      versionKv.append(el('div', 'k', '当前版本'), el('div', undefined, info?.current || '未知'))
      versionKv.append(
        el('div', 'k', '登录态探活'),
        el(
          'div',
          undefined,
          info?.probeIntervalMs > 0
            ? `每 ${Math.round(info.probeIntervalMs / 60_000)} 分钟一次（只读、零额度）`
            : '已关闭',
        ),
      )
    }

    updateBtn.addEventListener('click', () => {
      void (async () => {
        updateBtn.disabled = true
        updateMsg.textContent = '正在检查……'
        try {
          const result = await api('/update-check', { method: 'POST', body: '{}' })
          if (!result?.ok) {
            updateMsg.textContent = `检查失败：${result?.error ?? '未知原因'}`
            return
          }
          const current = result.current
          renderVersion({ current, probeIntervalMs })
          if (result.hasUpdate) {
            updateMsg.textContent = `发现新版本 ${result.latest}（当前 ${current}）${
              result.publishedAt ? ` · ${shortTime(result.publishedAt)} 发布` : ''
            }${result.url ? ` · ${result.url}` : ''}`
          } else {
            updateMsg.textContent = `已是最新版本（${current}）。`
          }
        } catch (error: any) {
          updateMsg.textContent = `检查失败：${error?.message ?? error}`
        } finally {
          updateBtn.disabled = false
        }
      })()
    })

    const pathsCard = el('div', 'dsw-card')
    pathsCard.append(el('div', 'dsw-cardhead', '数据位置'))
    pathsCard.append(
      el('p', 'dsw-hint', '插件的本地状态都在 DSH 主目录下，不进通用配置面（避免凭证混进 settings/credentials）。'),
    )
    const pathsKv = el('div', 'dsw-kv')
    pathsCard.append(pathsKv)
    pathsCard.append(
      el('p', 'dsw-hint', '⚠️ 账号库里每个文件都是可完整登录的凭证；导出的备份同样是明文 —— 账号库卡片里的提示请当真。'),
    )
    aboutPane.append(pathsCard)

    const renderPaths = (paths: any): void => {
      pathsKv.textContent = ''
      const rows: [string, string][] = [
        ['账号库', paths?.accounts || '（未知）'],
        ['账号索引', paths?.webLogin ? `${paths.webLogin}/accounts.json` : '（未知）'],
        ['调用台账', paths?.ledger || '（未知）'],
        ['导出备份', paths?.webLogin ? `${paths.webLogin}/exports/` : '（未知）'],
      ]
      for (const [key, value] of rows) {
        pathsKv.append(el('div', 'k', key), el('div', 'dsw-path', value))
      }
    }

    const riskCard = el('div', 'dsw-card')
    riskCard.append(el('div', 'dsw-cardhead', '为什么没有「自动换号」'))
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        '💡 账号库支持一键手动切换，但刻意不做自动轮换（检测到限流就自动换一个号继续发）。原因不是保守：',
      ),
    )
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        '参考项目切的是「CLI 下次启动用哪个账号」——服务端看不到；而我们每次对话都实时发请求。' +
          '真人不会在几分钟内换一个账号接着发消息，自动换号是极强的机器行为特征，' +
          '与本插件在传输层指纹、随机间隔、会话清理上「降低机器可识别性」的努力直接冲突。',
      ),
    )
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        '另外：同一服务商会把多账号关联起来（同设备 / 同 IP / 同指纹 / 相近的行为模式）。' +
          '一旦被判定为同一人的多开小号，处置通常比单账号超频更重，而且可能波及全部关联账号。' +
          '所以账号库的目标是「在自己的多个正常账号之间切换更省事」，不是「靠轮换把限流绕过去」。',
      ),
    )
    aboutPane.append(riskCard)

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
      try {
        applyContextCard(await api('/context-mode'))
      } catch {
        contextMsg.textContent = '上下文设置读取失败（宿主未响应）'
      }
    })()

    // 账号库首次加载（此时 refresh 已经定义好了）
    void loadAccounts()
    // 台账首次加载
    void loadLedger()
    // 版本 / 数据位置来自 /status，这里主动拉一次让它别等到第一次轮询
    void refresh(true)

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

      const capBounds = g.maxPromptCharsBounds ?? { min: 120_000, max: 1_500_000 }
      promptRange.min = String(capBounds.min)
      promptRange.max = String(capBounds.max)
      promptRange.step = '20000'
      promptRange.value = String(g.maxPromptChars ?? g.maxPromptCharsDefault ?? capBounds.max)
      paintPromptCap()

      const mode = g.cleanup?.mode ?? 'deferred'
      for (const key of Object.keys(cleanupBtns)) {
        cleanupBtns[key].classList.toggle('active', key === mode)
      }
      // 三个区间只在「延迟」模式下有意义（立即 = 固定 1.5s/每次一个；不删 = 不清理）
      const showRanges = mode === 'deferred'
      cleanupRanges.style.display = showRanges ? '' : 'none'
      if (showRanges) {
        const batchRange = g.cleanup?.batchRange ?? g.cleanupDefaults?.batch
        if (batchRange) batchPair.set(batchRange.min, batchRange.max)
        const delayRange = g.cleanup?.delayRange ?? g.cleanupDefaults?.delayMs
        if (delayRange) delayPair.set(Math.round(delayRange.min / 1000), Math.round(delayRange.max / 1000))
        const gapRange = g.cleanup?.gapRange ?? g.cleanupDefaults?.gapMs
        if (gapRange) gapPair.set(+(gapRange.min / 1000).toFixed(1), +(gapRange.max / 1000).toFixed(1))
      }
      cleanupHint.textContent =
        mode === 'keep'
          ? '不删：请求最少，但网页端会留下临时会话记录。'
          : mode === 'immediate'
            ? '立即：调用结束后 1.5 秒删掉（老行为，每轮多一个删除请求）。'
            : `延迟：这一轮攒够 ${g.cleanup?.batchSize ?? 8} 个、或最多等 ` +
              `${Math.round((g.cleanup?.delayMs ?? 90_000) / 1000)} 秒就集中清理，并优先用一个请求批量删 ——` +
              '减少「每轮建一个立刻删一个」的机器特征。上面三个区间决定"这一轮具体攒几个 / 等多久"。'
    }

    const saveGate = async (patch: {
      allowConcurrent?: boolean
      minRequestIntervalMs?: number
      maxRequestIntervalMs?: number
      sessionCleanup?: string
      maxPromptChars?: number
      cleanupBatch?: { min: number; max: number }
      cleanupDelayMs?: { min: number; max: number }
      cleanupGapMs?: { min: number; max: number }
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
            (result.cleanup?.batchRange
              ? `（阈值 ${result.cleanup.batchRange.min}~${result.cleanup.batchRange.max} 个 · ` +
                `等待 ${Math.round((result.cleanup.delayRange?.min ?? 0) / 1000)}~` +
                `${Math.round((result.cleanup.delayRange?.max ?? 0) / 1000)}s · ` +
                (result.cleanup.gapRange
                  ? `删除间隔 ${(result.cleanup.gapRange.min / 1000).toFixed(1)}~${(result.cleanup.gapRange.max / 1000).toFixed(1)}s`
                  : '删除间隔关') +
                '）'
              : '') +
            ` · prompt 上限 ${fmtChars(Number(result.maxPromptChars ?? 0))}` +
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
              showMessage('已退出账号，登录窗口已打开：请在窗口里登录其它账号，凭证会自动捕获。')
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
    // 倒计时独立走一个 30 秒的定时器：不产生任何请求，只把"还剩多久"重新算一遍。
    const countdownTimer = window.setInterval(paintLimit, 30_000)

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
      window.clearInterval(countdownTimer)
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
