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
import { accountsSignature, shouldSyncAccounts } from '../account-sync.ts'
import {
  T,
  getLanguage,
  setLanguage,
  subscribeLanguage,
  storedLanguage,
  rememberLanguage,
  type Language,
} from '../i18n/index.ts'

type ClientContext = {
  slots: any
  effect: any
  /** 宿主 locale 服务（`@deepseek-ai/dsh-client-locale` 提供）。可选：拿不到就退回中文。 */
  locale?: {
    getSnapshot: () => { active?: string }
    subscribe?: (listener: () => void) => () => void
  }
  on?: (event: string, listener: (...args: any[]) => void) => void
}

/**
 * `slots` обязателен: без него панель некуда вешать.
 *
 * ⚠️ `locale` здесь **нет и не должно быть**. cordis отдаёт сервисы через Proxy
 * и на чтение **необъявленного** сервиса бросает
 * `cannot get property "locale" without inject`; объявление в `inject` превратило
 * бы необязательную зависимость в обязательную (плагин ждал бы регистрации
 * сервиса, которого на странице настроек может не быть). Поэтому язык хоста
 * читается через `optionalService()` — см. ниже.
 */
export const inject = ['slots']

/**
 * Прочитать сервис, которого может не быть.
 *
 * Почему не `ctx.locale?.…`: `?.` защищает от `undefined`, но не от исключения,
 * а cordis **бросает** прямо на чтении свойства — trap срабатывает раньше, чем
 * `?.`. Именно это и уронило активацию целиком (`web boot: 1 entry did not
 * activate / dsh-deepseek-web-login: failed`): панель не монтировалась вообще,
 * хотя отсутствие языка хоста должно было лишь оставить её на китайском.
 *
 * `try/catch` — не «перестраховка», а единственный корректный способ спросить
 * у cordis необязательный сервис, не делая его обязательным.
 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as Record<string, T>)[name]
  } catch {
    return undefined
  }
}

/**
 * 语言跟随宿主：`locale` 服务的 active 值（zh / en / ru …）直接喂给插件自己的
 * 极简 i18n 运行时。为什么不走 `ctx.slots.installLocale`：本面板是命令式 DOM
 * （`document.createElement` + `textContent`），不是 slot 渲染的 React 树，
 * 拿不到框架注入的 `t`。这里只借宿主的"当前语言"这一个事实，字典仍是插件自己的。
 *
 * `locale` 是可选依赖：宿主没提供时保持中文，界面不会因此坏掉。
 */
function bindLanguage(ctx: ClientContext): void {
  // Читаем через optionalService: сервиса может не быть, и обращение к нему
  // обязано вернуть undefined, а не бросить (см. комментарий у `inject`).
  const locale = optionalService<NonNullable<ClientContext['locale']>>(ctx, 'locale')

  /**
   * Ручной выбор пользователя важнее языка хоста.
   *
   * Встроенный набор языков DSH — только `zh` и `en`, поэтому `locale.active`
   * никогда не станет `ru`. Без этого приоритета переключатель в панели
   * затирался бы при каждом событии `locale/change`.
   */
  const read = (): void => {
    const stored = storedLanguage()
    if (stored !== undefined) {
      setLanguage(stored)
      return
    }
    try {
      setLanguage(locale?.getSnapshot?.().active)
    } catch {
      setLanguage(undefined)
    }
  }
  read()
  // Синхронизируем host: он отдаёт названия моделей в штатный селектор DSH.
  pushLanguage(getLanguage())
  locale?.subscribe?.(read)
  // `on` — тоже через optionalService: это миксин cordis, он есть всегда, но
  // если его вдруг не окажется, падение на чтении уронит всю панель. Событие
  // необязательное: без него язык просто не переключится на лету.
  const on = optionalService<(event: string, listener: () => void) => void>(ctx, 'on')
  on?.('locale/change', read)
}

/**
 * Переключатель языка в шапке панели.
 *
 * Почему свой, а не языковой пункт DSH: встроенный набор языков хоста — только
 * `zh` и `en` (`BUILT_IN_LOCALE_METADATA` в `dsh-client-locale`), поэтому выбрать
 * русский через настройки DSH нельзя. Кнопки живут прямо в панели, выбор
 * запоминается в localStorage и переживает перезапуск.
 */
function buildLanguageSwitch(): HTMLElement {
  const box = el('div', 'dsw-lang')
  const options: { id: Language; label: string; title: string }[] = [
    { id: 'zh', label: 'ZH', title: '中文（原文）' },
    { id: 'ru', label: 'RU', title: 'Русский' },
    { id: 'en', label: 'EN', title: 'English' },
  ]
  for (const option of options) {
    const btn = el('button', undefined, option.label) as HTMLButtonElement
    btn.type = 'button'
    btn.title = option.title
    btn.setAttribute('aria-pressed', String(getLanguage() === option.id))
    btn.addEventListener('click', () => {
      rememberLanguage(option.id)
      // Хост должен узнать о смене языка сразу: иначе названия моделей
      // в штатном селекторе поменяются только после перезапуска DSH.
      pushLanguage(option.id)
    })
    box.append(btn)
  }
  return box
}

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
    /** 登录标识类型（主机侧算好）：email / mobile / unknown。只用于打标志。 */
    identifierKind?: 'email' | 'mobile' | 'unknown'
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
 * Сообщить хосту выбранный язык интерфейса.
 *
 * Зачем это вообще нужно: список моделей для **штатного** окна выбора модели
 * в DSH формирует host (`adapter.listModels`), а не наша панель. Хост про
 * localStorage рендерера ничего не знает, поэтому без этого запроса названия
 * моделей там остались бы китайскими.
 *
 * Ошибку глушим: язык — не та вещь, ради которой стоит показывать сбой
 * (панель в худшем случае останется с китайскими названиями моделей).
 */
function pushLanguage(lang: string): void {
  void fetch(`${API}/ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: lang }),
  }).catch(() => {})
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
/* ── 尺度层 ──────────────────────────────────────────────────────────
   改造前的问题：fontSize 有 5 档（11/12/12.5/13/14）、圆角 6 档（6/8/10/12/999）、
   间距散落 7 种值（2/4/6/8/9/10/12）。同一个界面里数字一多，眼睛就觉得"乱"却
   说不出哪乱 —— 所以先把尺度收敛，下面所有组件只能引用这里的变量。 */
--r-lg:12px;   /* 卡片等容器 */
--r-md:8px;    /* 按钮 / 输入框 */
--r-sm:6px;    /* 小组件（备注输入、归组下拉） */
--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;

/* 状态底色：从语义色现算，不再写死 rgba。
   写死的 rgba 只对其中一档主题成立 —— 按浅色底调出来的那组绿/橙/红贴到深色底上会发脏。 */
--ok-weak:color-mix(in srgb,var(--ok) 15%,transparent);
--warn-weak:color-mix(in srgb,var(--warn) 16%,transparent);
--err-weak:color-mix(in srgb,var(--err) 14%,transparent);
--accent-weak:color-mix(in srgb,var(--accent) 12%,transparent);
--accent-hover:color-mix(in srgb,var(--accent) 88%,var(--fg));

font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
font-size:13px;line-height:1.6;color:var(--fg);max-width:760px;padding:2px 0 12px;
-webkit-font-smoothing:antialiased;
}
@media (prefers-color-scheme:dark){
.dsw-page{--fb-fg:#ededed;--fb-fg2:#b6bcc6;--fb-fg3:#858c99;
--fb-bg1:#212121;--fb-bg2:#2a2a2a;--fb-bd:#333333;--fb-bd2:#3d3d3d;
--fb-hover:#ffffff14;--fb-code:#1c1c1c}
}
/* 页面标题：整页唯一的 display 级文字。字重 600 + 轻微负字距 ——
   原来是 14px/500，跟 13px 的正文只差 1px，整页因此没有"起点"。 */
.dsw-title{margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.4;letter-spacing:-.01em;color:var(--fg)}
.dsw-sub{margin:0 0 var(--sp-5);font-size:12px;line-height:1.65;color:var(--fg2);max-width:64ch}
/* provider 名带连字符，万一折行会断成 deepseek- / web（看着像故障）—— 整词不拆 */
.dsw-nobreak{white-space:nowrap}
/* Переключатель языка: прижат вправо от заголовка. Сделан «тише» заголовка
   (fg2 + прозрачный фон), потому что это редкое действие, а не основной вход. */
.dsw-lang{display:flex;gap:2px;margin-left:auto;padding:2px;border-radius:999px;background:var(--code-bg)}
.dsw-lang button{font:inherit;font-size:11px;font-weight:500;line-height:1.5;padding:2px 10px;
  border:0;border-radius:999px;background:transparent;color:var(--fg2);cursor:pointer}
.dsw-lang button:hover{color:var(--fg)}
.dsw-lang button[aria-pressed="true"]{background:var(--bg2);color:var(--fg);box-shadow:0 0 0 1px var(--bd2)}
.dsw-head{display:flex;align-items:flex-start;gap:var(--sp-2);flex-wrap:wrap}
/* 分组不再用"七个一模一样的描边盒子"。
   盒子本身不表达任何层级，连堆七张就是 AI 默认长相 —— 按 redesign 技能的判据，
   card 只在 elevation 真的表达层级时才用（我们这里没有那种层级）。
   数据密集面板的正解是「分区标题 + 负空间」：标题吃字重，分组吃间距，
   行与行之间的细线交给 .dsw-kv 自己承担。这样页面上唯一有实底的块
   就只剩账号行和反馈条，它们的重要度反而被衬出来了。 */
.dsw-card{background:transparent;border:0;border-radius:0;padding:0;margin:0 0 var(--sp-5)}
/* 分区标题：字重整 600。 */
.dsw-cardhead{display:flex;align-items:center;gap:var(--sp-2);margin:0 0 var(--sp-2);
  font-size:13px;font-weight:600;letter-spacing:-.005em;color:var(--fg)}
.dsw-card > .name{margin:0 0 var(--sp-2);font-size:13px;font-weight:600;color:var(--fg)}
.dsw-row{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.dsw-badge{font-size:11px;font-weight:500;line-height:1.7;padding:1px 9px;border-radius:999px;
  white-space:nowrap;font-variant-numeric:tabular-nums}
.dsw-badge.on{color:var(--ok);background:rgba(26,159,90,.15);background:var(--ok-weak)}
.dsw-badge.off{color:var(--warn);background:rgba(200,140,20,.16);background:var(--warn-weak)}
.dsw-badge.err{color:var(--err);background:rgba(217,48,37,.15);background:var(--err-weak)}
/* 中性信息标志（邮箱 / 手机号）：不属于状态，别用红黄绿去干扰状态色 */
.dsw-badge.kind{color:var(--fg);background:var(--code-bg);opacity:.85}
/* 按钮：hover 不再整体调 opacity —— 那会把文字一起变淡，看着像被禁用了。
   改成背景微调 + 按下时 1px 位移（物理感）；focus-visible 补上键盘可达性。 */
.dsw-btn{font:inherit;font-size:12px;font-weight:500;line-height:1.5;padding:6px 13px;
border-radius:var(--r-md);border:1px solid transparent;background:var(--accent);color:var(--on-accent);
cursor:pointer;transition:background-color .15s ease,border-color .15s ease,transform .1s ease}
.dsw-btn:hover:not(:disabled){background:var(--accent-hover)}
.dsw-btn:active:not(:disabled){transform:translateY(1px)}
.dsw-btn:disabled{opacity:.45;cursor:not-allowed}
.dsw-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dsw-btn.ghost{background:transparent;border-color:var(--bd2);color:var(--fg)}
.dsw-btn.ghost:hover:not(:disabled){background:var(--hover);border-color:var(--bd)}
.dsw-btn.danger{background:transparent;border-color:var(--bd2);color:var(--err)}
.dsw-btn.danger:hover:not(:disabled){background:var(--err-weak);border-color:var(--err)}
.dsw-btn.armed{background:var(--err);border-color:var(--err);color:var(--on-accent)}
.dsw-btn.armed:hover:not(:disabled){background:color-mix(in srgb,var(--err) 88%,var(--fg))}
.dsw-input,.dsw-area{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;
background:var(--bg1);color:var(--fg);border:1px solid var(--bd2);border-radius:var(--r-md);padding:7px 10px;
outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dsw-input:focus,.dsw-area:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
.dsw-area{min-height:68px;resize:vertical;font-family:var(--mono);font-size:12px;line-height:1.5}
/* 键值表：标签提一档到次级色 —— 原来用三级色，深色主题下几乎读不出来。
   行距 5→6px；分隔线只做分组暗示，不做表格线。 */
.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:0 var(--sp-3);margin:0;align-items:baseline}
.dsw-kv > *{padding:6px 0;border-top:1px solid var(--bd);min-width:0}
.dsw-kv > :nth-child(1),.dsw-kv > :nth-child(2){border-top:none;padding-top:2px}
.dsw-kv .k{color:var(--fg2);font-size:12px;white-space:nowrap}
.dsw-kv > *:not(.k){color:var(--fg);word-break:break-word}
.dsw-msg{margin-top:var(--sp-3);padding:10px 12px;border-radius:var(--r-md);background:var(--bg2);
border:1px solid var(--bd);border-left:3px solid var(--fg3);white-space:pre-wrap;max-height:240px;
overflow:auto;font-size:12px;line-height:1.6;color:var(--fg)}
.dsw-msg.err{border-left-color:var(--err);color:color-mix(in srgb,var(--err) 78%,var(--fg))}
.dsw-msg.ok{border-left-color:var(--ok)}
.dsw-msg.warn{border-left-color:var(--warn);color:color-mix(in srgb,var(--warn) 80%,var(--fg))}
/* 行内结果条：由**某一行上的按钮**触发的操作（切换 / 重登），结果必须留在那一行。
   为什么（2026-09-30 用户反馈「点切换没反应，报错在下面显示，一点也不明显」）：
   反馈原先只写卡片底部那条消息，用户点完按钮视线还在原处 —— 列表一长，等于没反馈。 */
.dsw-rowmsg{margin-top:6px;padding:6px 10px;border-radius:var(--r-sm);background:var(--bg2);
border-left:3px solid var(--fg3);color:var(--fg2);font-size:12px;line-height:1.55;
white-space:pre-wrap;word-break:break-word}
.dsw-rowmsg:empty{display:none}
.dsw-rowmsg.err{border-left-color:var(--err);color:color-mix(in srgb,var(--err) 78%,var(--fg))}
.dsw-rowmsg.ok{border-left-color:var(--ok)}
.dsw-rowmsg.warn{border-left-color:var(--warn);color:color-mix(in srgb,var(--warn) 80%,var(--fg))}
.dsw-models{list-style:none;margin:0;padding:0}
.dsw-models li{padding:10px 0;border-top:1px solid var(--bd)}
.dsw-models li:first-child{border-top:none;padding-top:2px}
.dsw-models .name{font-size:13px;font-weight:500;color:var(--fg)}
.dsw-models .id{color:var(--fg3);font-size:12px;margin-top:2px;word-break:break-word}
/* 说明文字：限宽 64ch —— 满宽的一行小字读起来很累，且会拖长整张卡。 */
.dsw-hint{color:var(--fg3);font-size:12px;line-height:1.7;margin:var(--sp-3) 0 0;max-width:64ch}
.dsw-gate-row{display:flex;align-items:center;gap:10px;margin:var(--sp-3) 0;flex-wrap:wrap}
.dsw-gate-label{color:var(--fg2);font-size:12px;min-width:52px;flex:0 0 auto}
.dsw-gate-value{font-size:12px;color:var(--fg);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
/* 「上下限」成对的一行：两个滑块并排，右边一个合成值（如「6~10 个」）。
   —— 比"每个边界各占一行"省一半高度，而且两个边界的相对位置一眼能比出来。 */
.dsw-range-pair{flex:1 1 240px;display:flex;gap:var(--sp-2);align-items:center;min-width:190px}
.dsw-gate-pair-value{font-size:12px;color:var(--fg);min-width:78px;text-align:right;font-variant-numeric:tabular-nums}
.dsw-switch{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:var(--fg);cursor:pointer;user-select:none}
.dsw-switch input{position:absolute;opacity:0;width:0;height:0}
.dsw-switch-track{width:34px;height:20px;border-radius:999px;background:var(--bd2);position:relative;transition:background-color .18s ease;flex:0 0 auto}
.dsw-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s ease}
/* 打开态用主色 —— 改造前是 --err（红）。开关的"开"表达的是**状态**不是危险，
   整排红色开关看着像报错。危险色留给真正会造成破坏的动作（armed 按钮）。 */
.dsw-switch input:checked + .dsw-switch-track{background:var(--accent)}
.dsw-switch input:checked + .dsw-switch-track::after{transform:translateX(14px)}
.dsw-switch input:focus-visible + .dsw-switch-track{outline:2px solid var(--accent);outline-offset:2px}
.dsw-range{-webkit-appearance:none;appearance:none;flex:1 1 160px;height:4px;border-radius:999px;background:var(--bd2);outline:none;cursor:pointer}
.dsw-range:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.dsw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.dsw-preset{padding:4px 10px;font-size:12px}
.dsw-preset.active{background:var(--accent);border-color:transparent;color:var(--on-accent)}
.dsw-preset.active:hover{background:var(--accent-hover)}
.dsw-gate-msg{color:var(--fg3);font-size:12px;min-height:1.6em;margin:var(--sp-3) 0 0}
.dsw-code{display:block;margin:var(--sp-2) 0;padding:8px 10px;background:var(--code-bg);border:1px solid var(--bd);
border-radius:var(--r-sm);font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--fg);
overflow-x:auto;white-space:pre}
.dsw-msg::-webkit-scrollbar,.dsw-code::-webkit-scrollbar,.dsw-area::-webkit-scrollbar{width:8px;height:8px}
.dsw-msg::-webkit-scrollbar-thumb,.dsw-code::-webkit-scrollbar-thumb,.dsw-area::-webkit-scrollbar-thumb{
background:var(--bd2);border-radius:4px}
/* ── 标签页：把原来一页到底的 7 张卡拆成 4 页 ────────────────────────
   标签栏做成带边框的圆角容器。未选中态改用**颜色**表达（原来是 opacity .7 —— 
   透明度既压暗了文字又让 hover 没有明确的落点），当前页用下划线。 */
/* Переполнение по горизонтали (2026-10-10, RU): русские подписи вкладок длиннее
   китайских, семь вкладок в одну строку не влезали в панель (~560px) и уезжали
   за правый край. flex-wrap переносит их на вторую строку вместо обрезки.
   ⚠️ Внутри этого комментария НЕЛЬЗЯ ставить обратные кавычки: стили лежат
   в template literal, и первая же кавычка обрывает строку (сборка падает
   с PARSE_ERROR, а не с внятным сообщением о комментарии). */
.dsw-tabs{display:flex;flex-wrap:wrap;gap:2px;border:1px solid var(--bd);border-radius:var(--r-md);
padding:0 var(--sp-2);margin:var(--sp-1) 0 var(--sp-4);background:var(--bg1);max-width:100%}
.dsw-tab{appearance:none;background:transparent;border:none;border-bottom:2px solid transparent;
padding:8px 14px;font:inherit;font-size:13px;color:var(--fg2);cursor:pointer;
transition:color .15s ease,border-color .15s ease}
.dsw-tab:hover{color:var(--fg)}
.dsw-tab.active{color:var(--fg);font-weight:500;border-bottom-color:var(--fg)}
.dsw-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;border-radius:4px}
.dsw-pane[hidden]{display:none}
/* 二级（子页面）标签：**分段胶囊**。
   刻意和一级标签长得不一样（一级是"下划线 + 大字号"），这样一眼能看出自己在第几层；
   否则两层长得一样、用户会以为回到了同一层。 */
.dsw-subtabs{display:flex;flex-wrap:wrap;gap:2px;padding:3px;margin:0 0 var(--sp-4);border-radius:var(--r-md);
  background:var(--bg1);border:1px solid var(--bd);max-width:100%}
.dsw-subtab{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;
  font-weight:500;color:var(--fg2);padding:4px 14px;border-radius:999px;cursor:pointer;
  transition:color .15s ease,background-color .15s ease}
.dsw-subtab:hover{color:var(--fg)}
.dsw-subtab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* 选中态：底色用 bg2 铺在 bg1 上，深色主题里这两档只差一点点，
   所以必须再加一圈描边（bd2 比 bd 明显）才立得住 —— 实测深色下不加就跟没选中一样。 */
.dsw-subtab.active{background:var(--bg2);color:var(--fg);font-weight:600;
  box-shadow:inset 0 0 0 1px var(--bd2)}
/* 调用台账 */
.dsw-spark{display:block;width:100%;height:40px;margin:var(--sp-2) 0 2px}
.dsw-spark rect{fill:var(--bd2)}
.dsw-spark rect.on{fill:var(--accent)}
.dsw-spark rect.bad{fill:var(--err)}
/* ── Token 统计页 ────────────────────────────────────────────────────
   图全是手写 SVG：插件不引第三方图表库（多一个依赖就多一份与宿主版本的耦合）。
   高度写 auto 而不是固定值 —— viewBox 自带比例，固定高度会把图拉变形或留白。 */
.dsw-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--sp-3);
padding:var(--sp-3) 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd)}
.dsw-stat{min-width:0}
.dsw-stat .k{font-size:12px;color:var(--fg3);margin:0 0 2px}
.dsw-stat .v{font-size:20px;font-weight:600;line-height:1.25;letter-spacing:-.01em;
color:var(--fg);font-variant-numeric:tabular-nums}
.dsw-stat .n{font-size:11px;color:var(--fg3);margin-top:2px;line-height:1.45}
@media (max-width:560px){.dsw-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.dsw-trend{display:block;width:100%;height:auto;margin:var(--sp-3) 0 0;overflow:visible}
.dsw-trend .grid{stroke:var(--bd);stroke-width:.5}
.dsw-trend .axis{fill:var(--fg3);font-size:10px}
.dsw-trend .bar-in{fill:var(--accent)}
.dsw-trend .bar-out{fill:color-mix(in srgb,var(--accent) 45%,transparent)}
.dsw-trend .line{fill:none;stroke:var(--fg2);stroke-width:1.2;stroke-dasharray:3 2}
.dsw-legend{display:flex;gap:var(--sp-3);flex-wrap:wrap;font-size:11px;color:var(--fg2);
margin:var(--sp-2) 0 0}
.dsw-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;
vertical-align:-1px}
/* 分布排行：一行 = 名称 + 数值 + 占比 + 横条。条宽按**最大值**归一（不是按总量），
   否则只有第一名看得见，其余全是一根短刺。 */
.dsw-ranks{display:flex;flex-direction:column;gap:var(--sp-3);margin-top:var(--sp-3)}
.dsw-rank{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px var(--sp-3);
align-items:baseline}
.dsw-rank .rk-name{font-size:12px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.dsw-rank .rk-val{font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums;
white-space:nowrap}
.dsw-rank .rk-track{grid-column:1/-1;height:6px;border-radius:999px;background:var(--bd);
overflow:hidden}
.dsw-rank .rk-fill{height:100%;border-radius:999px;background:var(--accent)}
.dsw-path{font-family:var(--mono);font-size:11px;color:var(--fg2);word-break:break-all}
/* 账号库 */
.dsw-accounts{list-style:none;margin:var(--sp-2) 0 0;padding:0;display:flex;flex-direction:column;gap:var(--sp-2)}
/* 账号行是可交互的整块 —— 必须给 hover 反馈。改造前它完全静态，鼠标扫过去没有任何回应。
   当前账号再叠一层主色淡底，跟"只是鼠标划过"区分开。 */
/* 账号行：从"bg2 卡片里的凹陷块"改成"页面上的凸起块"。
   卡片没了之后 bg1 跟页面同色看不见，必须换成 bg2 —— 顺带让账号库成为
   页面上唯一有实底的一组，重要度自然凸显。 */
.dsw-account{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--bd);
border-radius:var(--r-md);padding:10px 12px;background:var(--bg2);
transition:background-color .15s ease,border-color .15s ease}
.dsw-account:hover{background:var(--hover)}
.dsw-account.active{border-color:var(--accent);background:var(--accent-weak)}
.dsw-account.active:hover{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.dsw-account-main{flex:1 1 200px;min-width:0}
.dsw-account-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:500}
.dsw-account-meta{font-size:11px;color:var(--fg3);margin-top:3px;word-break:break-all;font-variant-numeric:tabular-nums}
.dsw-account-fix{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;margin-top:6px}
.dsw-account-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsw-labelinput{font:inherit;font-size:12px;padding:3px 7px;border-radius:var(--r-sm);border:1px solid var(--bd2);
background:var(--bg2);color:var(--fg);width:150px;margin-top:4px}
.dsw-labelinput:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.dsw-limit{color:var(--warn)}
/* 分组：组标题行 + 组内缩进 + 归组下拉 */
.dsw-grouphead{display:flex;align-items:center;gap:var(--sp-2);margin:var(--sp-3) 0 0;font-size:12px}
.dsw-grouphead .gname{font-weight:600}
.dsw-grouphead .gcount{color:var(--fg3);font-size:11px;font-variant-numeric:tabular-nums}
.dsw-grouphead .gtoggle{cursor:pointer;user-select:none;color:var(--fg2);width:12px;display:inline-block;text-align:center}
.dsw-grouphead .gtoggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.dsw-grouphead .gspacer{flex:1 1 auto}
.dsw-grouphead .dsw-btn{font-size:11px;padding:1px 7px}
.dsw-account.grouped{margin-left:14px}
.dsw-groupsel{font:inherit;font-size:11px;padding:2px 4px;border-radius:var(--r-sm);border:1px solid var(--bd2);
background:var(--bg2);color:var(--fg);max-width:110px}
.dsw-groupsel:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
/* 操作反馈：不归属任何一页，常驻在标签栏之上 */
.dsw-alert{margin:0 0 var(--sp-3);padding:9px 12px;border-radius:var(--r-md);border:1px solid var(--bd);
background:var(--bg2);white-space:pre-wrap;font-size:12px}
/* 整行染成纯错误色在深色底上会刺眼且发暗；混一点正文色压回来，色条仍然说明性质。 */
.dsw-alert.ok{border-left:3px solid var(--ok);color:color-mix(in srgb,var(--ok) 72%,var(--fg))}
.dsw-alert.err{border-left:3px solid var(--err);color:color-mix(in srgb,var(--err) 78%,var(--fg))}
/* 用户开了"减少动态效果"就别再让元素滑来滑去。 */
@media (prefers-reduced-motion:reduce){
.dsw-page *{transition-duration:.01ms !important}
}
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
  if (diff < 60_000) return T('刚刚')
  if (diff < 3_600_000) return T(`${Math.floor(diff / 60_000)} 分钟前`)
  if (diff < 86_400_000) return T(`${Math.floor(diff / 3_600_000)} 小时前`)
  return T(`${Math.floor(diff / 86_400_000)} 天前`)
}

/** 倒计时：还剩 2 小时 13 分 / 已解除。 */
function countdown(untilMs?: number | null): string {
  if (!untilMs || !Number.isFinite(untilMs)) return ''
  const left = untilMs - Date.now()
  if (left <= 0) return T('已解除')
  const totalMinutes = Math.ceil(left / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return T(`剩余 ${hours} 小时 ${minutes} 分`)
  return T(`剩余 ${minutes} 分`)
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
  /**
   * Смена языка = полная пересборка панели.
   *
   * Панель строит DOM императивно и подставляет `T(...)` в момент сборки, поэтому
   * «поменять текст на месте» нельзя, не обойдя всё дерево вручную. Пересборка
   * дешевле и не оставляет рассинхрона: какой-то узел забыли бы обновить.
   */
  const [langRev, setLangRev] = useState(0)

  useEffect(() => subscribeLanguage(() => setLangRev((n) => n + 1)), [])

  useEffect(() => {
    const root = hostRef.current
    if (!root) return
    // Без этого при смене языка к старому DOM добавился бы второй.
    root.replaceChildren()
    let disposed = false
    let timer: number | undefined

    const style = document.createElement('style')
    style.textContent = styles

    const page = el('div', 'dsw-page')
    const head = el('div', 'dsw-head')
    const title = el('h3', 'dsw-title', T('DeepSeek 网页登录（免费模型）'))
    head.append(title, buildLanguageSwitch())
    // 副标题的宽度是"预算"问题，不是随便写的：
    // 上一版（78 字）单行要 558px，而宿主面板的内容宽约 560px —— 正好压在折行边界上。
    // 「账号」页比「模型」页高，面板因此出现纵向滚动条，内容宽度少十几像素，
    // 最后一个词就掉到第二行，还断在 `deepseek-web` 的连字符处（看着像故障）。
    // 现在这版约 467px，留 ~90px 余量，切标签/缩放窗口都不会再翻行。
    // ⚠️ 以后改这句话，请保持单行宽度 ≲ 470px（量法：white-space:nowrap 的 span 取 getBoundingClientRect）。
    const sub = el('p', 'dsw-sub')
    sub.append(T('用 chat.deepseek.com 的登录态驱动 DSH，不需要 API Key（provider：'))
    sub.append(el('span', 'dsw-nobreak', 'deepseek-web'))
    sub.append('）')

    page.append(style, head, sub)

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
    const TAB_KEYS = ['account', 'model', 'token', 'gate', 'transport', 'context', 'about'] as const
    const TAB_LABELS: Record<string, string> = {
      account: T('账号'),
      model: T('模型'),
      token: T('Token 统计'),
      gate: T('防风控'),
      transport: T('传输层'),
      context: T('上下文'),
      about: T('关于'),
    }
    const accountPane = el('div', 'dsw-pane')
    const modelPane = el('div', 'dsw-pane')
    const tokenPane = el('div', 'dsw-pane')
    const gatePane = el('div', 'dsw-pane')
    const transportPane = el('div', 'dsw-pane')
    const contextPane = el('div', 'dsw-pane')
    const aboutPane = el('div', 'dsw-pane')
    const panes: Record<string, HTMLElement> = {
      account: accountPane,
      model: modelPane,
      token: tokenPane,
      gate: gatePane,
      transport: transportPane,
      context: contextPane,
      about: aboutPane,
    }
    const tabButtons: Record<string, HTMLButtonElement> = {}
    /**
     * 首次切到某页时才拉的数据。**不做成"启动时全拉"**：Token 统计要扫最多 90 天的
     * jsonl，而多数人根本不打开这一页 —— 不为没看的页付代价。
     */
    const paneFirstShow: Record<string, (() => void) | undefined> = {}
    const selectTab = (key: string): void => {
      for (const each of TAB_KEYS) {
        const on = each === key
        panes[each].hidden = !on
        tabButtons[each].classList.toggle('active', on)
        tabButtons[each].setAttribute('aria-selected', String(on))
        if (on) paneFirstShow[each]?.()
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
    const ACCT_LABELS: Record<string, string> = { status: T('登录状态'), library: T('账号库') }
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
    loginTitle.append(el('span', 'name', T('登录状态')))
    const badge = el('span', 'dsw-badge off', T('⚪ 未登录'))
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
          ? T(`账号级限制已解除（${shortTime(activeLimitUntilMs)}）。`)
          : T(`⚠️ 账号级限制：${text}（${shortTime(activeLimitUntilMs)} 解除，期间生成会被拒）`)
    }

    // ── 账号卡（退出 / 换号）──
    // 为什么要单独一张卡：退出登录以前只作为一个按钮塞在「手动粘贴 Token」那张卡的角落里，
    // 用户根本找不到（实测反馈）。退出账号是高频操作，必须显眼、且要能换号。
    const accountCard = el('div', 'dsw-card')
    accountCard.append(el('div', 'dsw-cardhead', T('当前账号')))
    const accountLine = el('div', 'dsw-kv')
    accountCard.append(accountLine)
    const accountActions = el('div', 'dsw-row')
    accountActions.style.marginTop = '8px'
    const logoutBtn = el('button', 'dsw-btn danger', T('退出当前账号')) as HTMLButtonElement
    const switchBtn = el('button', 'dsw-btn ghost', T('退出并登录其它账号')) as HTMLButtonElement
    accountActions.append(logoutBtn, switchBtn)
    accountCard.append(accountActions)
    const accountHint = el(
      'p',
      'dsw-hint',
      T('⚠️ 「退出」= 把该账号从账号库移除，不是"只登出"：本地凭证与浏览器登录态会一起清掉。') +
        T('想留住它就先「导出备份」；只是想换个号用，去「账号库 → 登录新账号」。'),
    )
    accountCard.append(accountHint)

    const loginActions = el('div', 'dsw-row')
    loginActions.style.marginTop = '10px'
    const browserBtn = el('button', 'dsw-btn', T('浏览器窗口登录')) as HTMLButtonElement
    const externalBtn = el('button', 'dsw-btn ghost', T('用我的默认浏览器登录')) as HTMLButtonElement
    const recoverBtn = el('button', 'dsw-btn ghost', T('从已登录窗口恢复')) as HTMLButtonElement
    const refreshBtn = el('button', 'dsw-btn ghost', T('刷新状态')) as HTMLButtonElement
    loginActions.append(browserBtn, externalBtn, recoverBtn, refreshBtn)
    loginCard.append(loginActions)
    loginCard.append(
      el(
        'p',
        'dsw-hint',
        T('「用我的默认浏览器登录」= 用系统浏览器打开 chat.deepseek.com（网页端若提示「使用环境异常」，走这条）。') +
          T('外部浏览器的登录态插件抓不到，所以要用 F12 控制台取 token 粘到下面那张卡（命令已备好）。'),
      ),
    )
    loginCard.append(
      el(
        'p',
        'dsw-hint',
        T('「从已登录窗口恢复」= 复用上次登录过的窗口分区直接取凭证（免重新登录），凭证丢失时用它救急。'),
      ),
    )
    acctStatusPane.append(loginCard, accountCard)

    // ── 账号库：多账号并存 + 一键切换 ────────────────────────────────
    // 为什么值得有：以前换号的代价是「退出 → 清浏览器分区 → 重新登录 → 等捕获」，
    // 期间原来的号也回不去了。现在保存过的账号都在库里，切换即时生效。
    //
    // ⚠️ 风险已在 src/accounts.ts 的模块注释里写明，这里再对使用者说一遍：
    // 用多账号轮换规避单账号限流，会被服务商把账号关联起来，处置通常更重。
    //
    // ⚠️ 这段注释 0.6.8 更正过一次：原文写"刻意只提供手动切换、不做自动轮换"，
    // 但「自动换号」滑块（`autoSwitchMinutes`，默认 **0＝关闭**）早就有了，0.6.8 又加了
    // "凭证失效即换"那一档 —— 注释与实现不一致会直接把排查带到错的方向（README 里同款
    // 那句话就是把这次的问题引到"插件 bug"上的元凶）。现状：按时间轮换默认关（理由见上），
    // 失效即换只在用户自己把滑块拉起来之后才生效。
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
    accountsHead.append(el('span', 'name', T('账号库')))
    const accountsBadge = el('span', 'dsw-badge off', '—')
    accountsHead.append(accountsBadge)
    accountsCard.append(accountsHead)
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        T('💡 保存过的账号都在本机，点「切换」即时生效、不用重新登录 —— 切换后从下一次请求开始生效。'),
      ),
    )

    const accountsList = el('ul', 'dsw-accounts')
    accountsCard.append(accountsList)
    const accountsEmpty = el('p', 'dsw-hint', T('账号库是空的 —— 用上面的「登录」或「手动粘贴 Token」添加一个。'))
    accountsCard.append(accountsEmpty)

    const accountsIOPanel = el('div', 'dsw-row')
    accountsIOPanel.style.marginTop = '10px'
    // 「登录新账号」：以前账号库**根本没有"再加一个号"的入口** ——
    // 两个退出按钮都会先把这个号从库里删掉，所以库永远攒不到第二个账号。
    const addAccountBtn = el('button', 'dsw-btn', T('登录新账号（添加）')) as HTMLButtonElement
    const exportBtn = el('button', 'dsw-btn ghost', T('导出备份…')) as HTMLButtonElement
    const importBtn = el('button', 'dsw-btn ghost', T('导入备份…')) as HTMLButtonElement
    // 「校验全部」：对库里每个账号做一次**只读探活**（零额度）—— 自动探活 30 分钟才一次，
    // 而"我刚在浏览器里动过这个号，它现在到底还行不行"是随时会冒出来的问题。
    // 以前只能等，或者切过去试（那要发一次生成请求、烧额度）。
    //
    // ⚠️ 命名避开「刷新状态」：那个名字已经被「当前账号」卡片上的按钮占了
    //（它刷的是 `/status`，只看当前那个号）—— 两个同名按钮在同一个面板里会互相误导。
    const refreshAccountsBtn = el('button', 'dsw-btn ghost', T('校验全部')) as HTMLButtonElement
    refreshAccountsBtn.title = T('对每个账号做一次只读校验（零额度）：刷新登录态、补上账号名、清掉已恢复的失败标记')
    // 「一键重登」（0.6.14，0.6.15 挪到这里）：用本机存的邮箱密码依次自动重登 ——
    // ⚠️ 位置很重要：第一版挂在"防风控"页的设置卡里，用户在「账号库」里根本找不到
    //（2026-10-01 反馈）。它和「登录新账号」是同一类动作（弄到可用凭证），就该放一起。
    const reloginAllBtn = el('button', 'dsw-btn', T('一键重登')) as HTMLButtonElement
    reloginAllBtn.title =
      T('用本机保存的邮箱密码，把所有匹配得到的账号依次自动重登。') +
      T('每个号会起一次无头浏览器（无窗口、跑完即杀），所以是串行的、需要等一会儿。')
    const newGroupBtn = el('button', 'dsw-btn ghost', T('新建分组')) as HTMLButtonElement
    newGroupBtn.title = T('给账号分类，只影响列表的显示方式 —— 不参与切号、也不影响会话复用与清理')
    accountsIOPanel.append(addAccountBtn, reloginAllBtn, exportBtn, importBtn, refreshAccountsBtn, newGroupBtn)
    accountsCard.append(accountsIOPanel)
    // 「一键重登」的点击处理：结果走**全局提示条**（常驻在标签栏之上）——
    // 这样在子标签之间切换也看得见，不用在卡片里再塞一个 hint 元素。
    reloginAllBtn.addEventListener('click', () => {
      reloginAllBtn.disabled = true
      showMessage(T('正在自动重登（每个号起一次无头浏览器，请稍候）…'))
      void api('/login/relogin-all', { method: 'POST', body: '{}' })
        .then((result: any) => {
          const rows: any[] = Array.isArray(result?.results) ? result.results : []
          if (rows.length === 0) {
            showMessage(result?.error ?? T('没有可重登的账号'), 'err')
            return
          }
          const failed = rows.filter((r) => !r.ok)
          showMessage(
            T(`重登完成 ${result?.okCount ?? 0}/${rows.length}`) +
              (failed.length
                ? T(`；失败：${failed.map((r) => `${r.display}（${String(r.message ?? '').slice(0, 40)}）`).join('　')}`)
                : `：${rows.map((r) => r.display).join('　')}`),
            failed.length ? '' : 'ok',
          )
        })
        .catch((error: any) => showMessage(T(`重登失败：${T(error?.message ?? error)}`), 'err'))
        .finally(() => {
          reloginAllBtn.disabled = false
        })
    })
    // 以前这里是个"要导入的备份文件路径"输入框 —— 让人手打路径本来就别扭。
    // 现在两个按钮都弹**系统对话框**（另存为 / 打开），位置和文件名由用户自己选。
    // 实现见 src/file-picker.ts（宿主是 utility 进程，拿不到 Electron 的 dialog，
    // 只能由渲染进程用 Chromium 自己的能力做）。
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        T('💡 「登录新账号」会先清掉上次的浏览器登录态（库里已有的账号不受影响），登录后新账号只入库、不切换当前账号 ——') +
          T('加完在列表里点「切换」即可使用。某个账号标着「需要重新登录」时，用它自己那行上的按钮修 ——') +
          T('那条路不清浏览器登录态，能复用就直接复用。导出/导入会弹系统对话框，自己选位置和文件。'),
      ),
    )
    const accountsMsg = createMsgNode()
    accountsCard.append(accountsMsg.node)
    accountsCard.append(
      el(
        'p',
        'dsw-hint',
        T('⚠️ 导出的备份文件就是可完整登录的凭证（等同于账号本身）—— 别分享、别提交到仓库。'),
      ),
    )
    acctLibraryPane.append(accountsCard)

    /**
     * 一个组的标题行：折叠箭头 + 组名 + 数量 + （真实组才有）改名 / 删除。
     *
     * 「未分组」是**伪组**（`groupId === null`），不给改名/删除入口 —— 它不是一个实体，
     * 只是"没归组的账号"的落脚处。
     */
    const sectionRow = (section: any, groups: any[]): HTMLElement => {
      const key = String(section?.key ?? '')
      const collapsed = collapsedGroups.has(key)
      const head = el('div', 'dsw-grouphead')
      const toggle = el('span', 'gtoggle', collapsed ? '▸' : '▾')
      toggle.title = collapsed ? T('展开') : T('折叠')
      toggle.addEventListener('click', () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key)
        else collapsedGroups.add(key)
        persistCollapsedGroups()
        // 折叠是纯前端状态 ⇒ 直接重画，不用再打一次 /accounts（也不该走重建签名）
        redrawAccounts()
      })
      head.append(toggle, el('span', 'gname', String(section?.name ?? '')))
      head.append(el('span', 'gcount', T(`${Array.isArray(section?.accounts) ? section.accounts.length : 0} 个`)))
      head.append(el('span', 'gspacer'))
      if (section?.groupId) {
        const renameGroupBtn = el('button', 'dsw-btn ghost', T('改名')) as HTMLButtonElement
        renameGroupBtn.addEventListener('click', () => {
          const input = el('input', 'dsw-labelinput') as HTMLInputElement
          input.value = String(section.name ?? '')
          input.placeholder = T('分组名')
          head.append(input)
          input.focus()
          let settled = false
          const commit = (): void => {
            if (settled) return
            settled = true
            void renameAccountGroup(String(section.groupId), input.value)
          }
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              settled = true
              redrawAccounts()
            }
          })
          input.addEventListener('blur', commit)
        })
        const deleteGroupBtn = el('button', 'dsw-btn danger', T('删除')) as HTMLButtonElement
        deleteGroupBtn.title = T('只删分组本身；组里的账号会回到「未分组」，账号与凭证都不动')
        let armed = false
        deleteGroupBtn.addEventListener('click', () => {
          if (!armed) {
            armed = true
            deleteGroupBtn.textContent = T('确认删除？')
            window.setTimeout(() => {
              armed = false
              deleteGroupBtn.textContent = T('删除')
            }, 4000)
            return
          }
          void deleteAccountGroup(String(section.groupId))
        })
        head.append(renameGroupBtn, deleteGroupBtn)
      }
      return head
    }

    const renderAccounts = (data: any): void => {
      const items: any[] = Array.isArray(data?.accounts) ? data.accounts : []
      const groups: any[] = Array.isArray(data?.groups) ? data.groups : []
      const sections: any[] = Array.isArray(data?.sections) ? data.sections : []
      accountsBadge.textContent = T(`${items.length} 个`)
      accountsBadge.className = `dsw-badge ${items.length ? 'on' : 'off'}`
      accountsEmpty.hidden = items.length > 0
      accountsList.textContent = ''
      // 兜底：万一拿到的是没有 sections 的载荷（老宿主 / 异常响应），退回单区平铺 ——
      // 宁可少个分组标题，也不能什么都看不到。
      if (!sections.length) {
        for (const item of items) accountsList.append(accountRow(item, groups, false))
        return
      }
      for (const section of sections) {
        accountsList.append(sectionRow(section, groups))
        if (collapsedGroups.has(String(section?.key ?? ''))) continue
        for (const item of Array.isArray(section?.accounts) ? section.accounts : []) {
          accountsList.append(accountRow(item, groups, true))
        }
      }
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
        // 这里刻意不写死"会复用登录态" —— 宿主在「这条账号已被标记失效」时会走清理路径
        // （0.1.75），该说什么由它随响应返回（下面用 prep.hint），免得界面与实际行为对不上。
        accountsMsg.textContent = T(`正在校验「${title}」并准备登录窗口……`)
        paintRowMsg(id, T('正在校验登录态并准备登录窗口……'), 'info')
        try {
          const prep = await api('/login/relogin', { method: 'POST', body: JSON.stringify({ id }) })
          // 0.6.6：宿主会先做一次只读探活 —— 凭证还能用的话到这里就结束了，
          // **不会打开浏览器**（这是「一键重登」那一半：网络抖动过后的号，一点就好）。
          if (prep?.alreadyValid) {
            const text = String(prep.hint ?? T('这条账号校验通过，不需要重新登录'))
            accountsMsg.textContent = text
            paintRowMsg(id, `✅ ${text}`, 'ok')
            await loadAccounts()
            return
          }
          if (prep?.ok === false) {
            // 网络类失败走到这里：只报原因，**不清登录态、不开窗口**（重登此时必然白敲）。
            const text = String(prep?.error ?? T('未知原因'))
            accountsMsg.textContent = text
            paintRowMsg(id, `⚠️ ${text}`, 'warn')
            return
          }
          boostUntil = Date.now() + 300_000
          const opened = String(
            prep?.hint ??
              T('登录窗口已打开：如果浏览器里还留着这个账号的登录态会立刻复用，否则在里面重新登录一次……'),
          )
          accountsMsg.textContent = opened
          paintRowMsg(id, opened, 'info')
          const result = await api('/login/browser', { method: 'POST', body: '{}' })
          if (result?.started === false) {
            const text = T(`打开登录窗口失败：${T(result?.reason ?? '未知原因')}（可改用「手动粘贴 Token」）`)
            accountsMsg.textContent = text
            paintRowMsg(id, `❌ ${text}`, 'err')
            return
          }
          const done = result?.relogin
            ? T(`「${title}」的凭证已原地更新（同一条记录、当前账号未变），旧的失败标记也清掉了。`)
            : result?.added
              ? T(`「${title}」已加入账号库 —— 当前使用的账号没有改变。`)
              : T('已捕获并保存凭证。')
          accountsMsg.textContent = done
          await loadAccounts()
          // 重建列表后在**新的那一行**写结果（顺序反了会被冲掉）。
          paintRowMsg(id, `✅ ${done}`, 'ok')
        } catch (error: any) {
          const message = T(`重新登录失败：${T(error?.message ?? error)}`)
          accountsMsg.textContent = message
          paintRowMsg(id, `❌ ${message}`, 'err')
        } finally {
          await refresh(false).catch(() => undefined)
        }
      })()
    }

    const accountRow = (item: any, groups: any[] = [], indent = false): HTMLElement => {
      const row = el('li', `dsw-account${item.isActive ? ' active' : ''}${indent ? ' grouped' : ''}`)
      const main = el('div', 'dsw-account-main')
      const title = el('div', 'dsw-account-title')
      title.append(el('span', undefined, item.title || item.id))
      // 「邮箱 / 手机号」标志（0.6.13）：多号并存时一眼看出这号是哪种标识
      // （判据在主机侧 `identifierKindOf`，判不出来就不显示 —— 不瞎猜）。
      if (item.identifierKind === 'email') title.append(el('span', 'dsw-badge kind', T('邮箱')))
      else if (item.identifierKind === 'mobile') title.append(el('span', 'dsw-badge kind', T('手机号')))
      if (item.isActive) title.append(el('span', 'dsw-badge on', T('✅ 当前')))
      if (item.unverified) title.append(el('span', 'dsw-badge off', T('❔ 未校验')))
      const limited = item.limit && Number.isFinite(item.limit.untilMs) && item.limit.untilMs > Date.now()
      if (limited) {
        title.append(el('span', 'dsw-badge off', T(`⏳ 受限至 ${shortTime(item.limit.untilMs)}`)))
      }
      // 徽章从「校验失败」改成**明确的行动指令**：原来只写"失败"，用户不知道该干嘛，
      // 也看不出这号还能不能用。
      // 🔴 两种失败要分开说（0.6.6）：只有**授权失效**才是"这个号要重新登录"；
      // 网络类失败（断网 / 超时 / 机器休眠）凭证往往是好的。以前两者共用一个字段，
      // 一次休眠就把整库标成"需要重新登录"，点「重登」还会清掉浏览器登录态 ⇒
      // 用户被迫重敲手机号 + 验证码（2026-09-29 现场，9 个账号同时变红）。
      if (item.lastVerifyError) title.append(el('span', 'dsw-badge err', T('❌ 需要重新登录')))
      else if (item.lastCheckError) title.append(el('span', 'dsw-badge off', T('⚠️ 未能校验（网络）')))
      main.append(title)

      // 元信息只留"什么时候捕获的 / 上次校验是什么时候"。
      // ⚠️ 2026-10-01 用户反馈后删掉两项：① 重复的脱敏账号名（标题里已经有了）；
      // ② 整段 cookie 摘要（`5 项 · 3 会话级 · 2 持久级 · thumbcache 还剩 399 天`）——
      // 又长又误导（天数跟几小时就失效的真实寿命差两个数量级）。
      const meta: string[] = []
      if (item.capturedAt) meta.push(T(`${shortTime(item.capturedAt)} 捕获`))
      meta.push(item.lastVerifiedAt ? T(`最近校验 ${relTime(item.lastVerifiedAt)}`) : T('尚未校验'))
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
            T(`⚠️ ${relTime(item.lastVerifyError.at)}校验失败（登录态已失效）：${item.lastVerifyError.message}`),
          ),
        )
      } else if (item.lastCheckError) {
        // 网络类失败：说清"没校验成功"但**不要**暗示账号坏了 ——
        // 否则用户会去点重登，白白清掉还能用的登录态。
        main.append(
          el(
            'div',
            'dsw-account-fix',
            T(`⚠️ ${relTime(item.lastCheckError.at)}未能校验（网络问题，账号未必失效）：${item.lastCheckError.message}`),
          ),
        )
      }
      // 行内结果条：**这一行上按钮**触发的操作（切换 / 重登），结果留在这张行里。
      // 空的时候被 CSS 的 `:empty{display:none}` 收掉，不占位。
      const rowMsg = el('div', 'dsw-rowmsg') as HTMLElement
      rowMsg.dataset.rowMsg = String(item.id)
      main.append(rowMsg)
      row.append(main)

      const actions = el('div', 'dsw-account-actions')
      // 失效/未校验的账号：「重登」放动作列最前面 —— 它是这行最该点的按钮。
      // 文案从「重新登录」缩成「重登」：动作列现在要放下切换/备注/归组/移除，太长会挤成两行。
      // 0.6.6：网络类失败也给这个按钮 —— 点它**先探活**，能用就直接恢复（不必敲密码）。
      if (item.lastVerifyError || item.lastCheckError) {
        const reloginBtn = el('button', 'dsw-btn dsw-preset', T('重登')) as HTMLButtonElement
        reloginBtn.title =
          T('点一下会先做一次只读校验：凭证还能用就立刻恢复（不打开浏览器、不用敲密码）；') +
          T('只有确认授权失效（401/过期）时才会清掉登录态、让你重新登录一次。') +
          T('捕获后原地更新这条记录，不新增、也不切换当前账号')
        reloginBtn.addEventListener('click', () => reloginAccount(item.id, item.title || item.id))
        actions.append(reloginBtn)
      }
      if (item.isActive) {
        actions.append(el('span', 'dsw-hint', T('使用中')))
      } else {
        const useBtn = el('button', 'dsw-btn ghost dsw-preset', T('切换')) as HTMLButtonElement
        useBtn.addEventListener('click', () => void switchToAccount(item.id, useBtn))
        actions.append(useBtn)
      }

      // 文案叫「备注」而不是「重命名」：它写的是 `label`（备注名），**不是**改显示名 ——
      // 原来的名字让人以为是重命名账号本身，结果 7 个账号的 label 一直是空的（功能没人发现）。
      const renameBtn = el('button', 'dsw-btn ghost dsw-preset', T('备注')) as HTMLButtonElement
      let editing = false
      renameBtn.addEventListener('click', () => {
        if (editing) return
        editing = true
        const input = el('input', 'dsw-labelinput') as HTMLInputElement
        input.value = item.label || ''
        input.placeholder = T('备注名，如「工作号」')
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

      // 归组用**下拉**而不是拖拽：这套面板是手写 DOM，拖拽的命中判定、与轮询重建的冲突
      // 都太容易出坑；下拉最少点击，而且天然幂等（"设成某个值"而不是"挪到某个位置"）。
      const groupSel = el('select', 'dsw-groupsel') as HTMLSelectElement
      groupSel.title = T('放进某个分组（只影响显示方式，不影响切号与会话复用）')
      groupSel.append(new Option(T('未分组'), ''))
      for (const group of groups) groupSel.append(new Option(String(group?.name ?? ''), String(group?.id ?? '')))
      groupSel.value = String(item.groupId ?? '')
      groupSel.addEventListener('change', () => void assignAccountGroup(item.id, groupSel.value))
      actions.append(groupSel)

      // 移除要二次确认：凭证一旦删掉就找不回来了（不保留明文归档，见 accounts.ts）
      const removeBtn = el('button', 'dsw-btn danger dsw-preset', T('移除')) as HTMLButtonElement
      let armed = false
      removeBtn.addEventListener('click', () => {
        if (!armed) {
          armed = true
          removeBtn.textContent = T('确认移除？')
          removeBtn.classList.add('armed')
          window.setTimeout(() => {
            armed = false
            removeBtn.textContent = T('移除')
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

    /**
     * 渲染账号库，但**内容没变就不重建 DOM**。
     *
     * 为什么要有这道守卫：轮询会按秒级节拍重读 `/accounts`（见下面的 syncAccounts），
     * 无脑重建会把用户正在悬停/正要点的按钮换掉（重命名输入框更糟 —— 直接失焦）。
     * 签名取的是界面真正渲染的东西，见 account-sync.ts。
     */
    const applyAccounts = (data: any): void => {
      lastAccountsPayload = data
      const signature = accountsSignature(data)
      if (signature && signature === accountsSignatureCache) return
      accountsSignatureCache = signature
      renderAccounts(data)
    }

    /** 用最近一次载荷重画（折叠这类纯前端状态用它，不走重建签名、也不打 HTTP）。 */
    const redrawAccounts = (): void => {
      if (lastAccountsPayload) renderAccounts(lastAccountsPayload)
    }

    /** 显式读取（失败要说给用户听）：初始化 / 切号 / 移除 / 添加 / 重新登录 / 导入之后用。 */
    const loadAccounts = async (): Promise<void> => {
      try {
        applyAccounts(await api('/accounts'))
      } catch (error: any) {
        accountsMsg.textContent = T(`账号库读取失败：${T(error?.message ?? error)}`)
      } finally {
        accountsSyncedAt = Date.now()
      }
    }

    /**
     * 后台同步账号库（静默；只在内容变了时重建列表）。
     *
     * 为什么必须有它：账号库列表**不在 `/status` 里**，登录捕获又是异步落地的
     * （CDP 那条路要等用户在浏览器里登录完；能开 Electron 窗口那条路更是"开窗即返回"）
     * ⇒ 只靠上面几个显式调用，捕获晚一步就永远不显示，得关掉设置页再打开。
     *
     * 后台同步失败**不写进 accountsMsg** —— 那是给用户操作反馈用的，
     * 被一个后台轮询的偶发失败覆盖掉会更让人困惑（下一次成功就自然好了）。
     */
    const syncAccounts = async (): Promise<void> => {
      accountsSyncedAt = Date.now()
      try {
        applyAccounts(await api('/accounts'))
      } catch {
        // 静默：这是后台同步，失败不该覆盖用户正在看的那条消息
      }
    }

    /**
     * 分组动作：**只有显示方式会变，账号与凭证一律不动。**
     *
     * 每次操作后都 `loadAccounts()` 重读，而不是就地改 DOM：
     * 宿主的 `/accounts` 是唯一事实来源；重读既能拿到组的新状态，也会顺带走一遍内容签名 ——
     * 签名没变就不重建，正在输入的框不会被打断。
     */
    const groupApi = async (path: string, body: unknown, okText: string): Promise<void> => {
      try {
        const result = await api(path, { method: 'POST', body: JSON.stringify(body) })
        if (result?.ok === false) {
          accountsMsg.textContent = T(`分组操作失败：${T(result?.error ?? '未知原因')}`)
          return
        }
        accountsMsg.textContent = okText
      } catch (error: any) {
        accountsMsg.textContent = T(`分组操作失败：${T(error?.message ?? error)}`)
      } finally {
        await loadAccounts()
      }
    }

    const assignAccountGroup = (id: string, groupId: string): Promise<void> =>
      groupApi(
        '/accounts/group/assign',
        { id, groupId },
        groupId ? T('已归组。') : T('已移出分组（回到「未分组」）。'),
      )

    const renameAccountGroup = (id: string, name: string): Promise<void> =>
      groupApi('/accounts/group/rename', { id, name }, T(`分组已改名为「${name.trim()}」。`))

    const deleteAccountGroup = (id: string): Promise<void> =>
      groupApi('/accounts/group/delete', { id }, T('分组已删除；组里的账号回到「未分组」（账号本身没动）。'))

    /** 「新建分组」的内联输入框（与「备注」同款交互：Enter 提交、Esc 取消、失焦也提交）。 */
    let newGroupInput: HTMLInputElement | null = null
    const promptNewGroup = (): void => {
      if (newGroupInput && newGroupInput.isConnected) {
        newGroupInput.focus()
        return
      }
      const input = el('input', 'dsw-labelinput') as HTMLInputElement
      input.placeholder = T('分组名，如「工作号」')
      accountsIOPanel.append(input)
      input.focus()
      newGroupInput = input
      let settled = false
      const dismiss = (): void => {
        settled = true
        newGroupInput = null
        input.remove()
      }
      const commit = (): void => {
        if (settled) return
        const name = input.value
        dismiss()
        if (!name.trim()) return
        void groupApi('/accounts/group/create', { name }, T(`已创建分组「${name.trim()}」。`))
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') dismiss()
      })
      input.addEventListener('blur', commit)
    }

    /**
     * 手动刷新账号状态：只读探活，零额度。
     *
     * 按钮会**禁用并改文案** —— 库里账号是串行校验的，7 个要十几秒；不置灰的话
     * 用户会以为没反应而反复点（宿主侧也有互斥，但界面先挡住更好）。
     */
    const refreshAccountStates = async (): Promise<void> => {
      refreshAccountsBtn.disabled = true
      const original = refreshAccountsBtn.textContent
      refreshAccountsBtn.textContent = T('校验中…')
      accountsMsg.textContent = T('正在逐个校验账号（只读、零额度，串行进行，请稍候）……')
      try {
        const result = await api('/accounts/refresh', { method: 'POST', body: '{}' })
        if (result?.ok === false) {
          accountsMsg.textContent = T(`刷新失败：${T(result?.error ?? '未知原因')}`)
          return
        }
        const failed = Number(result?.failed ?? 0)
        // 汇总必须分开说（0.6.6）：把"网络没通"也叫"需要重登"会把人骗去重敲一遍密码。
        const authFailed = Number(result?.authFailed ?? 0)
        const transportFailed = Number(result?.transportFailed ?? 0)
        const summary = [T(`${Number(result?.passed ?? 0)} 个正常`)]
        if (authFailed > 0) summary.push(T(`${authFailed} 个登录态已失效（需要重登）`))
        if (transportFailed > 0) summary.push(T(`${transportFailed} 个网络没通、未能校验（账号未必失效）`))
        if (failed === 0) summary.length = 0
        accountsMsg.textContent = failed > 0
          ? T(`已校验 ${result?.checked ?? 0} 个账号：${summary.join('、')}。`)
          : T(`已校验 ${result?.checked ?? 0} 个账号：全部正常。`)
      } catch (error: any) {
        accountsMsg.textContent = T(`刷新失败：${T(error?.message ?? error)}`)
      } finally {
        refreshAccountsBtn.disabled = false
        refreshAccountsBtn.textContent = original
        // 探活会回写记录（补账号名、清失败标记）⇒ 让它立刻出现在列表里
        await refresh(false).catch(() => undefined)
      }
    }

    refreshAccountsBtn.addEventListener('click', () => void refreshAccountStates())
    newGroupBtn.addEventListener('click', () => promptNewGroup())

    /**
     * 把结果写进**某一行的行内提示条**（按账号 id 找回节点 —— 列表重建过也能写回新的那条）。
     *
     * 为什么要有它（2026-09-30 用户反馈「点切换没反应，报错在下面显示，一点也不明显」）：
     * 切换的反馈原先只写卡片底部那一条，而用户的视线还停在他点的那颗按钮上 ——
     * 列表一长，那条消息在屏幕外，体感就是"点了没反应"。所以结果必须在**那一行**里出现。
     */
    const paintRowMsg = (
      id: string,
      text: string,
      kind: 'info' | 'ok' | 'warn' | 'err',
    ): void => {
      const node = accountsList.querySelector(
        `.dsw-rowmsg[data-row-msg="${id}"]`,
      ) as HTMLElement | null
      if (!node) return
      node.className = kind === 'info' ? 'dsw-rowmsg' : `dsw-rowmsg ${kind}`
      node.textContent = text
    }

    const switchToAccount = async (id: string, btn?: HTMLButtonElement): Promise<void> => {
      // 按钮自己先"动"起来：探活最长 10 秒，这段时间里必须让用户看到点到了。
      const originalLabel = btn?.textContent ?? ''
      if (btn) {
        btn.disabled = true
        btn.textContent = T('切换中…')
      }
      paintRowMsg(id, T('正在校验登录态并切换……'), 'info')
      accountsMsg.textContent = T('切换中……')
      try {
        const result = await api('/accounts/switch', { method: 'POST', body: JSON.stringify({ id }) })
        if (!result?.ok) {
          const message = T(`切换失败：${T(result?.error ?? '未知原因')}`)
          paintRowMsg(id, `❌ ${message}`, 'err')
          accountsMsg.textContent = message
          return
        }
        // 先重建列表（切号会改状态区），再把结果写回**新**的那一行 —— 顺序反了会被冲掉。
        await loadAccounts()
        await refresh(false)
        if (result?.warning) {
          // 网络类失败是「放行 + 提示」：已切换，但没能校验（见宿主 /accounts/switch 的分类处置）。
          const text = `⚠️ ${String(result.warning)}`
          paintRowMsg(id, text, 'warn')
          accountsMsg.textContent = text
        } else {
          paintRowMsg(id, T('✅ 已切换（下一次请求生效）'), 'ok')
          accountsMsg.textContent = T('已切换（下一次请求生效）')
        }
      } catch (error: any) {
        const message = T(`切换失败：${T(error?.message ?? error)}`)
        paintRowMsg(id, `❌ ${message}`, 'err')
        accountsMsg.textContent = message
      } finally {
        if (btn) {
          btn.disabled = false
          btn.textContent = originalLabel
        }
      }
    }

    const removeAccountById = async (id: string): Promise<void> => {
      try {
        const result = await api('/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) })
        if (!result?.ok) {
          accountsMsg.textContent = T(`移除失败：${T(result?.error ?? '未知原因')}`)
          return
        }
        accountsMsg.textContent = T('已移除该账号（凭证已删除）')
        await loadAccounts()
        await refresh(true)
      } catch (error: any) {
        accountsMsg.textContent = T(`移除失败：${T(error?.message ?? error)}`)
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
        accountsMsg.textContent = T('正在准备登录窗口（会清掉上次的浏览器登录态，不影响账号库里的账号）……')
        try {
          const prep = await api('/login/add', { method: 'POST', body: '{}' })
          if (prep?.ok === false) {
            accountsMsg.textContent = T(`准备失败：${T(prep?.error ?? '未知原因')}`)
            return
          }
          // 登录窗口是"打开后等用户操作"的，这里会一直等到捕获到凭证或超时；
          // 期间保持轮询更密一点，万一捕获是异步落地的也能及时刷出来。
          boostUntil = Date.now() + 300_000
          accountsMsg.textContent = T('登录窗口已打开：请在窗口里登录另一个账号（不要登当前这个，否则只是刷新凭证）……')
          const result = await api('/login/browser', { method: 'POST', body: '{}' })
          if (result?.started === false) {
            accountsMsg.textContent = T(`打开登录窗口失败：${T(result?.reason ?? '未知原因')}（可改用「手动粘贴 Token」）`)
            return
          }
          if (result?.added) {
            accountsMsg.textContent = result.created
              ? T('已把新账号加入账号库 —— 当前账号没有改动，点列表里的「切换」才会用它。')
              : T('这个账号本来就在库里（凭证已更新）—— 当前账号未改动。')
          } else {
            accountsMsg.textContent = T('已捕获并保存凭证。')
          }
          await loadAccounts()
        } catch (error: any) {
          accountsMsg.textContent = T(`添加账号失败：${T(error?.message ?? error)}`)
        } finally {
          addAccountBtn.disabled = false
          await refresh(false).catch(() => undefined)
        }
      })()
    })

    exportBtn.addEventListener('click', () => {
      void (async () => {
        exportBtn.disabled = true
        accountsMsg.textContent = T('导出中……')
        try {
          // 先弹系统「另存为」，内容在用户选完位置后再取（顺序见 file-picker.ts 的注释）。
          const outcome = await saveWithPicker(suggestedExportName(), async () => {
            const data = await api('/accounts/export-json', { method: 'POST', body: '{}' })
            if (!data?.ok) throw new Error(T(data?.error ?? T('读取备份内容失败')))
            const { ok: _ok, ...backup } = data
            return JSON.stringify(backup, null, 2)
          })

          if (outcome.kind === 'saved') {
            accountsMsg.textContent = T(`已保存：${outcome.name}（含明文凭证，请妥善保管）`)
          } else if (outcome.kind === 'cancelled') {
            accountsMsg.textContent = T('已取消导出。')
          } else {
            // 系统「另存为」不可用 → 回退到宿主写插件目录（功能不因此失效，只是不能选位置）
            const result = await api('/accounts/export', { method: 'POST', body: '{}' })
            const why = outcome.kind === 'unsupported' ? T('当前环境不支持系统另存为') : T(`系统另存为失败（${outcome.reason}）`)
            accountsMsg.textContent = result?.ok
              ? T(`${why}，已改为保存到插件目录：${result.path}`)
              : T(`导出失败：${T(result?.error ?? '未知原因')}`)
          }
        } catch (error: any) {
          accountsMsg.textContent = T(`导出失败：${T(error?.message ?? error)}`)
        } finally {
          exportBtn.disabled = false
        }
      })()
    })

    importBtn.addEventListener('click', () => {
      void (async () => {
        importBtn.disabled = true
        accountsMsg.textContent = T('请选择备份文件……')
        try {
          const file = await pickJsonFile()
          if (!file) {
            accountsMsg.textContent = T('已取消导入。')
            return
          }
          accountsMsg.textContent = T(`正在读取 ${file.name}……`)
          const source = await readImportSource(file)
          if (source.kind === 'unreadable') {
            accountsMsg.textContent = T(`读取失败：${source.name} 不是有效的 JSON 备份（${source.reason}）`)
            return
          }
          // 拿到真实路径时只把**路径**交给宿主（宿主自己读文件，凭证不进 HTTP）；
          // 拿不到才退回传内容 —— 兜底，免得宿主没注入路径桥时功能整体失效。
          const body = source.kind === 'path' ? { path: source.path } : { payload: source.payload }
          const result = await api('/accounts/import', { method: 'POST', body: JSON.stringify(body) })
          accountsMsg.textContent = result?.ok
            ? T(`导入完成（${source.name}）：新增 ${result.imported} / 更新 ${result.updated} / 跳过 ${result.skipped}`)
            : T(`导入失败：${T(result?.error ?? '未知原因')}`)
          if (result?.ok) await loadAccounts()
        } catch (error: any) {
          accountsMsg.textContent = T(`导入失败：${T(error?.message ?? error)}`)
        } finally {
          importBtn.disabled = false
        }
      })()
    })

    // ── 手动 token 卡 ──
    const tokenCard = el('div', 'dsw-card')
    tokenCard.append(el('div', 'dsw-cardhead', T('手动粘贴 Token（可选路径）')))
    tokenCard.append(
      el(
        'p',
        'dsw-hint',
        T('在浏览器打开 chat.deepseek.com 并登录 → F12 控制台执行下面一行 → 把结果粘贴到输入框：'),
      ),
    )
    const snippet = el('code', 'dsw-code', "JSON.parse(localStorage.getItem('userToken')).value")
    tokenCard.append(snippet)
    tokenCard.append(
      el(
        'p',
        'dsw-hint',
        T('（新版网页端 token 存在 {"value": …} 包装里；若上面那行报错，改成 localStorage.getItem(\'userToken\') 直接复制整串，插件会自动解包）'),
      ),
    )
    const tokenInput = el('textarea', 'dsw-area') as HTMLTextAreaElement
    tokenInput.placeholder = T('粘贴 token（包装 JSON 或裸 token 都行；可选：下一行粘贴 Cookie，格式 name=value; name2=value2）')
    tokenCard.append(tokenInput)
    const tokenActions = el('div', 'dsw-row')
    tokenActions.style.marginTop = '8px'
    const tokenBtn = el('button', 'dsw-btn', T('保存并验证')) as HTMLButtonElement
    tokenActions.append(tokenBtn)
    tokenCard.append(tokenActions)
    acctLibraryPane.append(tokenCard)

    // ── 测试卡 ──
    const testCard = el('div', 'dsw-card')
    testCard.append(el('div', 'dsw-cardhead', T('连通性测试')))
    testCard.append(el('p', 'dsw-hint', T('直接经适配器发一次最小请求（会消耗一点网页端额度）：')))
    const testActions = el('div', 'dsw-row')
    testActions.style.marginTop = '6px'
    const modelSelect = el('select', 'dsw-input') as HTMLSelectElement
    modelSelect.style.maxWidth = '220px'
    const testBtn = el('button', 'dsw-btn', T('发送测试')) as HTMLButtonElement
    testActions.append(modelSelect, testBtn)
    testCard.append(testActions)
    const testOut = el('div', 'dsw-msg')
    testOut.style.display = 'none'
    testCard.append(testOut)

    // ── 模型卡 ──
    const modelsCard = el('div', 'dsw-card')
    modelsCard.append(el('div', 'dsw-cardhead', T('可用模型（网页免费）')))
    const modelsList = el('ul', 'dsw-models')
    modelsCard.append(modelsList)
    const modelsHint = el('p', 'dsw-hint', '')
    modelsCard.append(modelsHint)
    modelPane.append(modelsCard, testCard)

    // （操作反馈条与 showMessage 已提到页头、标签栏之上）

    let loggedIn = false
    let electron = false
    let windowOpen = false
    /** 上次同步账号库的时刻（0 = 还没读过；初始化那次 refresh 之前会先读一次）。 */
    let accountsSyncedAt = 0
    /** 上次渲染用的内容签名（见 account-sync.ts）。 */
    let accountsSignatureCache = ''
    /**
     * 最近一次 `/accounts` 载荷。
     *
     * 折叠是**纯前端状态**（不进账号库、也不该进重建签名），但切换折叠要重画列表 ——
     * 所以留一份载荷，让"折叠"能直接触发一次局部重绘，而不必多打一次 HTTP。
     */
    let lastAccountsPayload: any = null

    const COLLAPSE_KEY = 'dsw-accounts-collapsed-groups'

    /** 折叠的组 key。读一次就常驻，避免每行都去碰 localStorage。 */
    const collapsedGroups = new Set<string>((() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.map((item: unknown) => String(item)) : []
      } catch {
        // 隐私模式 / 存储被禁：折叠状态退化成"本次会话不折叠"，不该让面板挂掉
        return []
      }
    })())

    const persistCollapsedGroups = (): void => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedGroups]))
      } catch {
        /* 存不下就算了 —— 折叠只是显示偏好 */
      }
    }
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

      badge.textContent = loggedIn ? (status.auth.unverified ? T('❔ 已捕获（未校验）') : T('✅ 已登录')) : T('⚪ 未登录')
      badge.className = `dsw-badge ${loggedIn ? (status.auth.unverified ? 'off' : 'on') : 'off'}`
      if (loggedIn && !status.auth.unverified) {
        const valid = status.validation
        if (valid && !valid.ok) {
          badge.textContent = T('❌ 登录态校验失败')
          badge.className = 'dsw-badge err'
        }
      }

      const rows: [string, string][] = []
      activeLimitUntilMs = Number.isFinite(status.auth?.limitUntilMs) ? Number(status.auth?.limitUntilMs) : null
      paintLimit()
      probeIntervalMs = Number(status.config?.probeIntervalMs ?? 0)
      renderVersion({ current: status.config?.version, probeIntervalMs })
      renderPaths(status.paths)
      rows.push([T('适配器注册'), (status.registeredProviders ?? []).includes(status.provider) ? T(`✅ ${status.provider} 已注册到 llm`) : T(`⚠️ 未在 llm 中找到 ${status.provider}`)])
      if (loggedIn) {
        rows.push([T('账号'), status.auth.display || T('（未获取到账号信息）')])
        rows.push([T('捕获时间'), status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : T('未知')])
        // 凭证来源与完整度：以前这里对缺失项写「未捕获（可能仍可用）」，读起来像风险提示，
        // 实际含义只是「你走的是手动粘贴 token 那条路」。实测（2026-09-11）：
        // 只有 Bearer token、没有 cookie / x-hif-* 时，校验、PoW、真实生成全部通过 ——
        // 所以这里如实说明「缺什么」以及「已证实不影响使用」，而不是留一句模糊的警告。
        const manualTokenMode = !status.auth.hasCookie && !status.auth.hasFingerprint
        if (manualTokenMode) {
          rows.push([T('凭证来源'), T('手动粘贴 token')])
        } else {
          rows.push([T('凭证来源'), T('浏览器登录捕获')])
        }
        // Cookie 一行说清「有没有 + 构成」。**不再单列"还剩多少天"**
        // （2026-10-01 用户反馈）：那个天数来自持久级 cookie（实测 399 天），
        // 而真正鉴权的 token 只有几小时寿命，放一起只会误导。
        rows.push([
          'Cookie',
          status.auth.hasCookie
            ? T(`✅ 已捕获${status.auth.cookieLife ? ` · ${describeCookieLife(status.auth.cookieLife)}` : ''}`)
            : T('未捕获（手动 token 模式本就没有；不影响请求）'),
        ])
        rows.push([T('指纹头'), status.auth.hasFingerprint ? T('✅ 已捕获') : T('未捕获（不影响请求）')])
        rows.push([T('token 长度'), T(`${status.auth.tokenLength ?? 0} 字符`)])
        if (status.validation) rows.push([T('服务端校验'), status.validation.ok ? T('通过') : T(`失败：${T(status.validation.error ?? '')}`)])

        // 主动探活（后台定时做的，与上面这次"按需校验"是两件事）：
        // 目的就是**在任务跑到一半之前**发现登录态失效。
        const verifiedAt = status.auth?.lastVerifiedAt
        const verifyError = status.auth?.lastVerifyError
        if (verifyError) {
          rows.push([
            T('登录态探活'),
            T(`❌ ${relTime(verifyError.at)}失败：${verifyError.message}（可能已过期，建议重新登录）`),
          ])
        } else if (verifiedAt) {
          rows.push([T('登录态探活'), T(`✅ ${relTime(verifiedAt)}通过（后台定时校验，零额度）`)])
        }
        // 让用户能确认「防风控」到底生效成什么样（值来自配置，改配置后重启生效）
        const interval = status.config?.minRequestIntervalMs
        if (interval !== undefined) {
          rows.push([
            T('请求节流'),
            status.config?.allowConcurrent
              ? T(`⚠️ 允许并发 · 间隔 ${interval}ms（并发生成有账号级限制风险，不建议）`)
              : T(`串行（一次只发一条）· 间隔 ${interval}ms`),
          ])
        }
      } else {
        // 未登录时说明「能用哪条路登录」（不要笼统写成「非 Electron 环境」：
        // 2026-09-11 起宿主是 utility 进程，但真实浏览器登录是可用的）
        const available = status.loginCapability
        rows.push([
          T('登录方式'),
          available
            ? available.canOpenWindow
              ? T('插件自开窗口（Electron 主进程，带指纹伪装）')
              : available.browser
                ? T(`用真实浏览器登录（${available.browser} + 调试协议，自动读取凭证）`)
                : T('未找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 token')
            : electron
              ? T('可开浏览器窗口')
              : T('请用「用我的默认浏览器登录」+ 手动粘贴 token'),
        ])
      }
      if (status.lastLoginResult) {
        rows.push([T('最近结果'), `${status.lastLoginResult.message} · ${new Date(status.lastLoginResult.at).toLocaleTimeString()}`])
      }
      if (status.loginWindowOpen && status.loginProgress?.captured) {
        const captured = status.loginProgress.captured
        rows.push([
          T('捕获进度'),
          T(`token ${captured.token ? '✓' : '…'} / cookie ${captured.cookie ? '✓' : '…'} / 指纹 ${captured.fingerprint ? '✓' : '…'}`),
        ])
      }
      if (status.loginProgress?.lastError && status.loginWindowOpen) {
        rows.push([T('窗口提示'), status.loginProgress.lastError])
      }
      if (status.fingerprint && status.fingerprint.stripped.length > 0) {
        rows.push([T('指纹清理'), T(`已剔除 ${status.fingerprint.stripped.length} 个 Electron 头：${status.fingerprint.stripped.join(', ')}`)])
      } else if (status.loginWindowOpen) {
        rows.push([T('指纹清理'), T('窗口已打开（尚未命中需要清理的头）')])
      }
      if (status.fingerprint?.pageUa) {
        const bad = /electron/i.test(status.fingerprint.pageUa)
        rows.push([T('页面看到 UA'), `${bad ? T('⚠️ 仍含 Electron：') : '✅ '}${status.fingerprint.pageUa}`])
      }
      if (status.fingerprint?.pageBrands?.length) {
        const dirty = status.fingerprint.pageBrands.filter((b) => /electron|dsh/i.test(b))
        rows.push([T('页面品牌'), `${dirty.length ? `⚠️ ${dirty.join(', ')}` : '✅ '}${status.fingerprint.pageBrands.join(', ')}`])
      }
      if (status.fingerprint?.pageWebdriver !== undefined) {
        rows.push(['webdriver', status.fingerprint.pageWebdriver ? T('⚠️ true（自动化痕迹）') : '✅ false'])
      }
      // ⚠️ 0.1.82：这一段必须在 renderKv 之前 —— 此前 `renderKv(rows)` 在它上面，
      // 「宿主进程」这一行 push 进去时表格已经画完了 ⇒ **那行永远不显示**，
      // 而"窗口打不开"时它恰恰是唯一能说明原因的证据。
      // 登录能力自检（2026-09-11 事故：DSH 把插件宿主挪到 utility 进程后，窗口 API 没了）
      const capability = status.loginCapability
      if (capability) {
        const mode = capability.canOpenWindow
          ? T('可开 Electron 窗口')
          : capability.browser
            ? T(`无窗口 API（${capability.processType} 进程）→ 用真实浏览器`)
            : T(`无窗口 API（${capability.processType} 进程）且未找到 Edge/Chrome`)
        rows.push([T('宿主进程'), `${capability.processType} · ${mode}`])
      }
      renderKv(rows)

      if (!browserBtn.dataset.busy) browserBtn.disabled = false
      if (capability) {
        browserBtn.textContent = capability.canOpenWindow ? T('浏览器窗口登录') : capability.browser ? T(`用 ${capability.browser} 登录`) : T('浏览器窗口登录')
        browserBtn.disabled = !capability.canOpenWindow && !capability.browser
        browserBtn.title = capability.canOpenWindow
          ? T('插件自己开窗口（带指纹伪装）')
          : capability.browser
            ? T(`拉起真实的 ${capability.browser}（独立 profile）完成登录，插件通过调试协议读取登录态`)
            : T('既不能开窗口也没找到 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token')
      } else {
        browserBtn.disabled = !electron
        browserBtn.textContent = windowOpen ? T('登录窗口已打开') : T('浏览器窗口登录')
        browserBtn.title = electron ? '' : T('当前宿主无法开窗：请用「用我的默认浏览器登录」+ 手动粘贴 Token')
      }

      // 账号卡：显示当前账号 + 退出按钮可用性
      accountLine.textContent = ''
      if (loggedIn) {
        accountLine.append(el('div', 'k', T('账号')), el('div', undefined, status.auth.display || T('（未获取到账号信息）')))
        accountLine.append(
          el('div', 'k', T('登录时间')),
          el('div', undefined, status.auth.capturedAt ? new Date(status.auth.capturedAt).toLocaleString() : T('未知')),
        )
      } else {
        accountLine.append(el('div', 'k', T('状态')), el('div', undefined, T('未登录（没有可退出的账号）')))
      }
      logoutBtn.disabled = !loggedIn
      switchBtn.disabled = !loggedIn || !electron
      switchBtn.title = electron ? '' : T('当前不是 Electron 桌面端：请先「退出当前账号」，再手动粘贴另一个账号的 token')

      // 模型下拉
      if (modelSelect.options.length !== status.models.length) {
        modelSelect.textContent = ''
        for (const model of status.models) {
          const option = document.createElement('option')
          option.value = model.id
          option.textContent = T(model.name)
          modelSelect.append(option)
        }
      }
      // 模型列表
      modelsList.textContent = ''
      for (const model of status.models) {
        const item = el('li')
        item.append(el('div', 'name', T(model.name)))
        const ctxLabel = model.contextWindow >= 1_048_576
          ? `${(model.contextWindow / 1_048_576).toFixed(0)}M`
          : `${Math.round(model.contextWindow / 1024)}K`
        item.append(el('div', 'id', T(`${model.id} · thinking ${model.thinking ? '开' : '关'} · 上下文 ${ctxLabel} token（标称）`)))
        item.append(el('div', 'id', T(model.description)))
        modelsList.append(item)
      }
      modelsHint.textContent =
        T(`两条是同一个「快速模式」的思考开关两档预设（也可在模型选择器的推理强度里切换）。`) +
        T(`图片输入直接可用（走网页端文件上传通道）。每次调用会新建并删除临时会话；`) +
        T(`prompt 字符上限 ${status.config?.maxPromptChars ?? 0}（服务端硬上限 2621440 字符，`) +
        T(`另附件 token 预算 890880 —— 后者常被误读成「上下文窗口」）。`)
    }

    const refresh = async (light = true): Promise<void> => {
      try {
        const status = await api(`/status${light ? '?light=1' : ''}`)
        if (disposed) return
        applyStatus(status)
      } catch (error: any) {
        showMessage(T(`状态读取失败：${T(error?.message ?? error)}`), 'err')
      }
    }

    // ── 请求节流卡：并发开关 + 间隔区间 + 会话清理 ──
    // 这三项直接决定会不会被账号级限流（实测双窗口并发 6 分钟内被限制 1 天），
    // 所以不该只藏在配置文件里 —— 界面上直接可调，改完即时生效并落盘。
    const gateCard = el('div', 'dsw-card')
    gateCard.append(el('div', 'dsw-cardhead', T('请求节流（防风控）')))

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
    concLabel.append(concInput, concTrack, el('span', undefined, T('允许并发（同一账号同时发两条）')))
    concRow.append(concLabel)
    gateCard.append(concRow)

    const minRow = el('div', 'dsw-gate-row')
    minRow.append(el('span', 'dsw-gate-label', T('间隔下限')))
    const minRange = rangeInput()
    const minValue = el('span', 'dsw-gate-value', '—')
    minRow.append(minRange, minValue)
    gateCard.append(minRow)

    const maxRow = el('div', 'dsw-gate-row')
    maxRow.append(el('span', 'dsw-gate-label', T('间隔上限')))
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
    promptRow.append(el('span', 'dsw-gate-label', T('prompt 上限')))
    const promptRange = el('input', 'dsw-range') as HTMLInputElement
    promptRange.type = 'range'
    promptRange.setAttribute('aria-label', T('prompt 字符上限'))
    promptRange.title = T('每次请求最多发送多少字符（含工具目录与全部历史）')
    const promptValue = el('span', 'dsw-gate-value', '—')
    promptRow.append(promptRange, promptValue)
    gateCard.append(promptRow)
    const promptHint = el('p', 'dsw-hint', '')
    gateCard.append(promptHint)

    /** 字符数 → 「万字符」。界面上出现一长串 0 没人看得出差别。 */
    const fmtChars = (n: number): string => T(`${Number.isFinite(n) ? (n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1) : '—'} 万字符`)

    const paintPromptCap = (): void => {
      const chars = Number(promptRange.value)
      promptValue.textContent = fmtChars(chars)
      const level = chars >= 1_200_000 ? T('偏高') : chars >= 600_000 ? T('中等') : T('保守')
      promptHint.textContent =
        T(`每次请求最多发送 ${fmtChars(chars)}（${level}）。`) +
        T('网页端是无状态的，每一轮都会把整段对话历史重新发一遍：') +
        T('上限越大，模型越不容易「忘事」，但单次消耗的 token 也越多。') +
        T('长任务建议调小，或拆成多个会话（新会话从零开始，单次最省）。')
    }
    // 把「底部那两个数字到底怎么来的」直接写在界面上：
    // 否则「缓存命中 0%」会被当成"真的没命中"，而它其实只是我们没有上报。
    const tokenNote = el('p', 'dsw-hint', '')
    tokenNote.textContent =
      T('💡 说明：DSH 底部的 token 数目前是按字符估算的（网页端只回一个「本消息累计 token」，') +
      T('我们还没接进来）；「缓存命中 0%」是因为网页端不提供缓存信息、我们也就没有上报 —— ') +
      T('不代表真的没命中。')
    gateCard.append(tokenNote)

    promptRange.addEventListener('input', paintPromptCap)
    promptRange.addEventListener('change', () => {
      paintPromptCap()
      void saveGate({ maxPromptChars: Number(promptRange.value) })
    })

    // ── 图片数量上限（另一个请求级阀门）──────────────────────────
    // 为什么需要：图片是**请求级**的（一次请求用一个 ref_file_ids 带一批），网页端对这一批
    // 有数量上限 —— 群友实测 40 张通过 / 52 张被拒。超了会以 biz_code 10 拒收**整轮**，
    // 而图还留在历史里 ⇒ **该会话此后每一轮都失败**，用户只能丢掉全部上下文。
    // 所以按时间只带最近的 N 张，更早的略过。
    const imgRow = el('div', 'dsw-gate-row')
    imgRow.append(el('span', 'dsw-gate-label', T('图片上限')))
    const imgRange = el('input', 'dsw-range') as HTMLInputElement
    imgRange.type = 'range'
    imgRange.setAttribute('aria-label', T('单次请求的图片数量上限'))
    imgRange.title = T('一次请求最多带多少张历史图片（0 = 不限制）')
    const imgValue = el('span', 'dsw-gate-value', '—')
    imgRow.append(imgRange, imgValue)
    gateCard.append(imgRow)
    const imgHint = el('p', 'dsw-hint', '')
    gateCard.append(imgHint)

    const paintImageCap = (): void => {
      const count = Number(imgRange.value)
      imgValue.textContent = count === 0 ? T('不限制') : T(`${count} 张`)
      imgHint.textContent =
        count === 0
          ? T('不限制（不推荐）：历史里不同图片数超过 40 张左右后，网页端会以 code 10 拒绝整轮，且该会话此后每轮都失败。')
          : T(`一次请求最多带最近的 ${count} 张图片，更早的在本次请求里略过 —— 这是正常的长度控制，不是错误。`) +
            T('网页端能引用的图片数上限实测在 40~52 之间，默认值留了足够余量。')
    }
    imgRange.addEventListener('input', paintImageCap)
    imgRange.addEventListener('change', () => {
      paintImageCap()
      void saveGate({ maxRefImages: Number(imgRange.value) })
    })

    // ── 上下文范围（第三个请求级阀门，但作用方式不同）──────────────────
    // 前两个阀门管"插件发多少"，这个管"DSH 认为模型能装多少" —— 它决定 DSH 什么时候
    // 开始压缩/截断历史。原来硬编码 1M（DeepSeek 标称值），于是 DSH 长期认为"还装得下"
    // 而不压缩；对只跑短任务的人来说，那部分体量是白烧的。
    //
    // 用**档位滑块**而不是连续值：32K→1M 是 32 倍跨度，线性拖动时前四分之三的行程都挤在
    // 低档位，手感很差。每一格翻倍则正好符合直觉（档位由后端 CONTEXT_WINDOW_OPTIONS 给）。
    const ctxRow = el('div', 'dsw-gate-row')
    ctxRow.append(el('span', 'dsw-gate-label', T('上下文')))
    const ctxRange = el('input', 'dsw-range') as HTMLInputElement
    ctxRange.type = 'range'
    ctxRange.min = '0'
    ctxRange.step = '1'
    ctxRange.setAttribute('aria-label', T('对外声明的上下文窗口大小'))
    ctxRange.title = T('告诉 DSH 这个模型能装多少上下文；调小会让它更早压缩历史')
    const ctxValue = el('span', 'dsw-gate-value', '—')
    ctxRow.append(ctxRange, ctxValue)
    gateCard.append(ctxRow)
    const ctxHint = el('p', 'dsw-hint', '')
    gateCard.append(ctxHint)

    // 档位表：接口给了就用接口的，没给（老宿主）回落到内置这份 —— 界面不该因为少一个字段就没得选。
    let ctxOptions: number[] = [32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576]

    /** token 数转人话：1M / 512K / 128K …… 与「模型」页的写法保持一致。 */
    const formatCtxWindow = (tokens: number): string =>
      tokens >= 1_048_576 ? `${(tokens / 1_048_576).toFixed(0)}M` : `${Math.round(tokens / 1024)}K`

    /** 把任意值吸附到最近的档位（配置里可能是旧值或手改过的值）。 */
    const nearestCtxIndex = (value: number): number => {
      let best = 0
      let bestDiff = Number.POSITIVE_INFINITY
      ctxOptions.forEach((option, index) => {
        const diff = Math.abs(option - value)
        if (diff < bestDiff) {
          bestDiff = diff
          best = index
        }
      })
      return best
    }

    const currentCtxTokens = (): number =>
      ctxOptions[Number(ctxRange.value)] ?? ctxOptions[ctxOptions.length - 1]

    const paintContextWindow = (): void => {
      const tokens = currentCtxTokens()
      ctxValue.textContent = formatCtxWindow(tokens)
      ctxHint.textContent =
        tokens >= 1_048_576
          ? T('当前按 DeepSeek 标称的 1M 声明 —— DSH 会认为「还装得下」，尽量不压缩历史。') +
            T('如果你的任务都很短，可以调小以省下每轮重发的体量。')
          : T(`声明 ${formatCtxWindow(tokens)}：DSH 会更早压缩/截断历史，每轮重发的转写因此更短。`) +
            T('这只是「声明值」，不改模型真实能力；调小只是让 DSH 早点动手。') +
            T('想彻底压住单次体量，上面的「prompt 上限」也要一起调。')
    }
    ctxRange.addEventListener('input', paintContextWindow)
    ctxRange.addEventListener('change', () => {
      paintContextWindow()
      void saveGate({ contextWindow: currentCtxTokens() })
    })

    // ── 自动换号（0 = 关闭）────────────────────────────────────────────
    // 语义是**按时间均衡轮换**，不是"一被限流就换号"。两者的方向相反：
    //   均衡轮换 ⇒ 每个账号分到的请求都变少，是把密度摊薄；
    //   遇限流就换 ⇒ 同一个出口 IP 上多号交替活跃，更像"有组织的规避"。
    // 所以这里**只看时间**（受限/失效的号会被跳过，但不会因为它受限就提前切）。
    const swRow = el('div', 'dsw-gate-row')
    swRow.append(el('span', 'dsw-gate-label', T('自动换号')))
    const swRange = el('input', 'dsw-range') as HTMLInputElement
    swRange.type = 'range'
    swRange.min = '0'
    swRange.max = '120'
    swRange.step = '1'
    swRange.setAttribute('aria-label', T('自动切换账号的间隔（分钟），0 表示关闭'))
    swRange.title = T('每隔这么久换到账号库里的下一个可用账号；0 = 关闭')
    // 借用成对滑块的宽度（能装下「120 分钟」），不新增样式
    const swValue = el('span', 'dsw-gate-pair-value', '—')
    swRow.append(swRange, swValue)
    gateCard.append(swRow)
    const swHint = el('p', 'dsw-hint', '')
    gateCard.append(swHint)

    const currentSwitchMinutes = (): number => Math.max(0, Math.round(Number(swRange.value) || 0))

    /** 最近一次自动换号（后端只在**自动**切号时写；手动切不记）。null = 还没有过。 */
    let lastAutoSwitchInfo: { at: number; from: string; to: string; reason?: string } | null = null

    const paintAutoSwitch = (): void => {
      const minutes = currentSwitchMinutes()
      swValue.textContent = minutes === 0 ? T('关闭') : T(`${minutes} 分钟`)
      const base =
        minutes === 0
          ? T('关闭时不会自动换号 —— 当前账号一直用到你手动切换为止。')
          : T(`每 ${minutes} 分钟换到账号库里的下一个可用账号（失效或正在受限的会跳过；可用的不足两个就不换）。`) +
            T('换号会让投喂链断掉：下一轮要全量重发，历史图也要重新上传 —— 间隔越短，这个代价出现得越频繁。') +
            // 2026-10-01：用户两次被"同一个窗口聊着聊着网页端多出一个会话"搞懵，都没意识到中间换过号。
            // 换号必然新开会话（旧会话属于旧账号、新账号看不到），这件事必须写在开关旁边。
            T('另外要注意：每换一次号，网页端就会多出一个新会话（旧会话是在旧账号名下的，') +
            T('新账号看不到它），当前窗口也会从头开始 —— 在意网页端会话数量的，把它设成「关闭」。')
      // 换号那一轮任务会"突然变慢"（全量重发 + 重建会话）。把上一次换号的时间与两端摆出来，
      // 用户看到没来由的卡顿时有地方对原因 —— 否则那只是个无法解释的变慢。
      const last = lastAutoSwitchInfo
      // 顺手说清**为什么**换的：按时间轮换与"原账号出问题提前换走"，在用户眼里都是
      // "任务突然变慢"，但后者意味着这个号刚出事 —— 而且它也解释了"为什么没等满间隔就换了"。
      const why =
        last?.reason === 'recently-throttled'
          ? T('，原账号刚被限流')
          : last?.reason === 'current-unusable'
            ? T('，原账号不可用')
            : ''
      swHint.textContent = last
        ? T(`${base}上次自动换号：${shortTime(last.at)}（${last.from} → ${last.to}${why}）。`)
        : base
    }
    swRange.addEventListener('input', paintAutoSwitch)
    swRange.addEventListener('change', () => {
      paintAutoSwitch()
      void saveGate({ autoSwitchMinutes: currentSwitchMinutes() })
    })

    // ── 工具调用方式：一次一个 / 允许多个（默认允许）──────────────────
    // 用户想"让 DSH 调工具慢下来"。⚠️ 别和本卡最上面那个「允许并发」混为一谈：
    //   · 「允许并发」＝ 对 DeepSeek **同时发两条请求**，实测 6 分钟就能换来 1 天封禁；
    //   · 这个开关   ＝ 模型一轮里发**几个工具调用**。工具在 DSH 侧执行（读文件、跑命令），
    //                   **不产生任何 DeepSeek 请求** ⇒ 对网页端完全不可见。
    // 所以它跟风控的关系只在"请求数"上：关掉 ⇒ 每个工具各占一轮 ⇒ 总请求数变多、任务更慢。
    const serialRow = el('div', 'dsw-gate-row')
    const serialLabel = el('label', 'dsw-switch')
    const serialInput = el('input') as HTMLInputElement
    serialInput.type = 'checkbox'
    const serialTrack = el('span', 'dsw-switch-track')
    serialLabel.append(serialInput, serialTrack, el('span', undefined, T('允许并行调用工具')))
    serialRow.append(serialLabel)
    gateCard.append(serialRow)
    const serialHint = el('p', 'dsw-hint', '')
    gateCard.append(serialHint)

    // 注意这里是**双否定**：勾上 = 允许并行 = 传到后端的 serialToolCalls 为 false。
    // 变量名取 checked 的语义（batched），别让读代码的人自己反推。
    const paintSerialTools = (): void => {
      const batched = serialInput.checked
      serialHint.textContent = batched
        ? T('允许并行：模型可以一次发多个工具调用（同一批最多 3 个），DSH 会并行跑它们 —— 一轮请求推进多步，任务更快。') +
          T('工具在 DSH 侧执行、不发 DeepSeek 请求，所以对网页端不可见。切换后的第一轮会全量重发一次。')
        : T('默认：一次只发一个工具调用，等结果回来再决定下一步 —— 后一步能用上前一步的真实结果，逐步反应更稳。') +
          T('代价是每个工具各占一轮请求，任务总耗时明显变长。切换后的第一轮会全量重发一次。')
    }
    // 初始按**默认**（串行 ⇒ 开关不勾）画一次，免得读回设置之前闪一下错的状态
    serialInput.checked = false
    paintSerialTools()
    serialInput.addEventListener('change', () => {
      paintSerialTools()
      void saveGate({ serialToolCalls: !serialInput.checked })
    })

    const cleanupRow = el('div', 'dsw-gate-row')
    cleanupRow.append(el('span', 'dsw-gate-label', T('会话清理')))
    const cleanupBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['immediate', T('立即')],
      ['deferred', T('延迟（推荐）')],
      ['keep', T('不删')],
    ] as const) {
      const key = pair[0]
      const btn = el('button', 'dsw-btn ghost dsw-preset', pair[1]) as HTMLButtonElement
      btn.addEventListener('click', () => void saveGate({ sessionCleanup: key }))
      cleanupBtns[key] = btn
      cleanupRow.append(btn)
    }
    gateCard.append(cleanupRow)
    // 手动清理（0.6.11）：链式投喂下自动清理是关的（会话就是链的载体，自动删等于替你清上下文），
    // 所以必须给一个"现在就把网页端弄干净"的动作。
    const cleanupNowRow = el('div', 'dsw-gate-row')
    cleanupNowRow.append(el('span', 'dsw-gate-label', T('立即清理')))
    const cleanupNowBtn = el('button', 'dsw-btn ghost', T('清掉当前网页端会话')) as HTMLButtonElement
    const cleanupNowHint = el('span', 'dsw-hint', '')
    cleanupNowBtn.addEventListener('click', () => {
      cleanupNowBtn.disabled = true
      cleanupNowHint.textContent = T('清理中…')
      void api('/cleanup', { method: 'POST', body: '{}' })
        .then((result: any) => {
          const n = Number(result?.cleared ?? 0)
          cleanupNowHint.textContent = n
            ? T(`已退出 ${n} 个网页端会话，队列剩 ${result?.pending ?? 0} 个；下一轮会重新当链首（全量发一次）`)
            : T(`没有在用会话；队列剩 ${result?.pending ?? 0} 个`)
        })
        .catch((error: any) => {
          cleanupNowHint.textContent = T(`清理失败：${T(error?.message ?? error)}`)
        })
        .finally(() => {
          cleanupNowBtn.disabled = false
        })
    })
    cleanupNowRow.append(cleanupNowBtn, cleanupNowHint)
    gateCard.append(cleanupNowRow)

    // 到期前自动重登（0.6.14）：**默认关闭**。打开后每 10 分钟检查一次，凭证失效或
    // 捕获超过 100 分钟（实测寿命 1.5~6 小时）就静默跑一次无头浏览器把凭证换新。
    const autoReloginRow = el('div', 'dsw-gate-row')
    const autoReloginLabel = el('label', 'dsw-switch')
    const autoReloginInput = el('input') as HTMLInputElement
    autoReloginInput.type = 'checkbox'
    const autoReloginTrack = el('span', 'dsw-switch-track')
    autoReloginLabel.append(
      autoReloginInput,
      autoReloginTrack,
      el('span', undefined, T('到期前自动重登（后台每约 2 小时静默跑一次无头浏览器）')),
    )
    autoReloginInput.addEventListener('change', () => void saveGate({ autoRelogin: autoReloginInput.checked }))
    autoReloginRow.append(autoReloginLabel)
    gateCard.append(autoReloginRow)
    const autoReloginHint = el('p', 'dsw-hint', T('缓存凭证实测寿命约 2 小时；关掉它就用上面的「一键重登」手动刷。'))
    gateCard.append(autoReloginHint)
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
      for (const [input, which] of [[lo, T('下限')], [hi, T('上限')]] as const) {
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
      T('攒够数量'),
      { min: 1, max: 50 },
      '1',
      (lo, hi) => T(`${lo}~${hi} 个`),
      (lo, hi) => void saveGate({ cleanupBatch: { min: lo, max: hi } }),
    )
    const delayPair = rangePair(
      T('最长等待'),
      { min: 5, max: 600 },
      '5',
      (lo, hi) => T(`${lo}~${hi} 秒`),
      (lo, hi) => void saveGate({ cleanupDelayMs: { min: Math.round(lo * 1000), max: Math.round(hi * 1000) } }),
    )
    const gapPair = rangePair(
      T('删除间隔'),
      { min: 0, max: 60 },
      '0.1',
      (lo, hi) => (hi <= 0 ? T('不等待') : T(`${lo.toFixed(1)}~${hi.toFixed(1)} 秒`)),
      (lo, hi) => void saveGate({ cleanupGapMs: { min: Math.round(lo * 1000), max: Math.round(hi * 1000) } }),
    )
    cleanupRanges.append(batchPair.row, delayPair.row, gapPair.row)
    cleanupRanges.append(
      el(
        'p',
        'dsw-hint',
        T('上面三个都是「下限 ~ 上限」：实际取值每次在区间内随机抽 —— 攒批阈值与最长等待每轮清理重抽、') +
          T('删除间隔每删一个重抽。这样"什么时候动手删"就没有固定规律了。'),
      ),
    )
    cleanupRanges.append(
      el(
        'p',
        'dsw-hint',
        T('「删除间隔」只在逐个删除时起作用：优先走一个请求批量删；若服务端不接受批量删（会自动退化为逐个删），') +
          T('相邻两个删除请求之间就按这个间隔停一下 —— 避免"一下子连发几十个删除请求"。'),
      ),
    )

    gateCard.append(
      el(
        'p',
        'dsw-hint',
        T('并发默认关闭：DSH 的会话标题生成会与主回答同时发往同一账号，网页端同一账号同时只能生成一条，') +
          T('实测双窗口并发不到 6 分钟即触发账号级限制（1 天）。'),
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
    ledgerHead.append(el('span', 'name', T('调用台账')))
    const ledgerBadge = el('span', 'dsw-badge off', T('近 24 小时'))
    ledgerHead.append(ledgerBadge)
    ledgerCard.append(ledgerHead)
    ledgerCard.append(
      el('p', 'dsw-hint', T('本地记录每次调用的结果（不含任何对话内容与凭证）。用来判断节流是否真的在起作用。')),
    )
    const ledgerKv = el('div', 'dsw-kv')
    ledgerCard.append(ledgerKv)
    const ledgerSparkBox = el('div')
    ledgerCard.append(ledgerSparkBox)
    const ledgerRow = el('div', 'dsw-row')
    const ledgerRefreshBtn = el('button', 'dsw-btn ghost', T('刷新台账')) as HTMLButtonElement
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

    const fmtMs = (ms: number): string => (ms >= 60_000 ? T(`${(ms / 60_000).toFixed(1)} 分`) : T(`${(ms / 1000).toFixed(1)} 秒`))

    const renderLedger = (data: any): void => {
      const calls = Number(data?.calls ?? 0)
      ledgerBadge.textContent = T(`近 ${data?.hours ?? 24} 小时`)
      ledgerBadge.className = `dsw-badge ${calls > 0 ? 'on' : 'off'}`
      ledgerKv.textContent = ''
      ledgerSparkBox.textContent = ''
      if (calls === 0) {
        ledgerMsg.textContent = T('还没有记录 —— 跑一次对话后回来看。')
        return
      }
      const push = (key: string, value: string): void => {
        ledgerKv.append(el('div', 'k', key), el('div', undefined, value))
      }
      push(T('调用次数'), T(`${calls}（成功 ${data.succeeded ?? 0} / 失败 ${data.failed ?? 0}）`))
      const gaps = data.gaps
      push(
        T('相邻对话间隔'),
        gaps
          ? T(`中位 ${fmtMs(gaps.p50)} · p90 ${fmtMs(gaps.p90)} · 最短 ${fmtMs(gaps.min)}（样本 ${gaps.samples}）`)
          : T('样本不足'),
      )
      if (gaps && gaps.min < 1_500) {
        ledgerMsg.textContent = T(`⚠️ 出现过 ${fmtMs(gaps.min)} 的极短间隔 —— 检查一下节流是否被关掉了。`)
      }
      const failures = data.failures ?? {}
      push(
        T('失败分类'),
        Object.keys(failures).length ? Object.entries(failures).map(([key, count]) => `${key} ${count}`).join(' · ') : T('无'),
      )
      push(T('台账占用'), T(`${data.footprint?.files ?? 0} 个文件 · ${Math.round((data.footprint?.bytes ?? 0) / 1024)} KB`))
      // F3（0.2.0）：按账号用量 —— 多账号场景"哪个号在烧钱/在被限"一目了然。
      const byAccount: any[] = Array.isArray(data.byAccount) ? data.byAccount : []
      if (byAccount.length > 0) {
        const nameOf = (id: string): string => {
          const items: any[] = Array.isArray(lastAccountsPayload?.accounts) ? lastAccountsPayload.accounts : []
          const hit = items.find((item) => item.id === id)
          return hit ? String(hit.label || hit.display || hit.id) : id
        }
        push(
          T('按账号'),
          byAccount
            .sort((a, b) => (Number(b?.calls) || 0) - (Number(a?.calls) || 0))
            .map((row) => T(`${nameOf(row.accountId)} ${row.calls} 次（失败 ${row.failed}）`))
            .join(' · '),
        )
      }
      const hourly: number[] = Array.isArray(data.hourly) ? data.hourly : []
      // 0.1.82：失败时段此前恒传空集 ⇒ `.bad` 是死样式、"标红"从未生效
      const failedHours = new Set<number>()
      const hourlyFailed: number[] = Array.isArray(data.hourlyFailed) ? data.hourlyFailed : []
      hourlyFailed.forEach((count, index) => {
        if (count > 0) failedHours.add(index)
      })
      ledgerSparkBox.innerHTML = sparkSvg(hourly, failedHours)
      ledgerSparkBox.append(el('p', 'dsw-hint', T(`每小时调用量（最近 1 小时在最右，峰值 ${Math.max(0, ...hourly)} 次）`)))
    }

    const loadLedger = async (): Promise<void> => {
      try {
        renderLedger(await api('/ledger?hours=24'))
      } catch (error: any) {
        ledgerMsg.textContent = T(`台账读取失败：${T(error?.message ?? error)}`)
      }
    }
    ledgerRefreshBtn.addEventListener('click', () => void loadLedger())

    // ── Token 统计页 ──────────────────────────────────────────────────
    // 数据源：宿主的 `/usage`（`<数据目录>/usage/*.jsonl`，按天分文件，保留 90 天）。
    // 与「防风控」页的调用台账是**两份存储**：那边只留 7 天、管请求密度与失败分类；
    // 这边 90 天、只看烧了多少 token。合并成一份会让两边的保留期互相迁就。
    const fmtTokens = (n: number): string => {
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 100_000_000) return T(`${(n / 100_000_000).toFixed(2)} 亿`)
      if (n >= 10_000) return T(`${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万`)
      return String(Math.round(n))
    }
    const fullNum = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '0')

    const TOKEN_RANGES: [number, string][] = [[1, T('今天')], [7, T('近 7 天')], [30, T('近 30 天')], [0, T('总计')]]
    let tokenDays = 30
    const tokenRangeBar = el('div', 'dsw-subtabs')
    tokenRangeBar.setAttribute('role', 'tablist')
    const tokenRangeBtns: HTMLButtonElement[] = []
    const paintTokenRange = (): void => {
      TOKEN_RANGES.forEach(([days], index) => {
        const on = days === tokenDays
        tokenRangeBtns[index].classList.toggle('active', on)
        tokenRangeBtns[index].setAttribute('aria-selected', String(on))
      })
    }
    for (const [days, label] of TOKEN_RANGES) {
      const btn = el('button', 'dsw-subtab', label) as HTMLButtonElement
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.addEventListener('click', () => {
        if (tokenDays === days) return
        tokenDays = days
        paintTokenRange()
        void loadUsage()
      })
      tokenRangeBtns.push(btn)
      tokenRangeBar.append(btn)
    }
    paintTokenRange()
    tokenPane.append(tokenRangeBar)

    /** 一格总览。`set` 一次给值和注释，避免三处各写一遍 textContent。 */
    const statCell = (label: string): { node: HTMLElement; set: (value: string, note?: string) => void } => {
      const node = el('div', 'dsw-stat')
      const value = el('div', 'v', '—')
      const note = el('div', 'n', '')
      node.append(el('div', 'k', label), value, note)
      return {
        node,
        set: (next, hint) => {
          value.textContent = next
          note.textContent = hint ?? ''
        },
      }
    }
    const sTotal = statCell(T('总 Token'))
    const sIn = statCell(T('输入 Token'))
    const sOut = statCell(T('输出 Token'))
    const sCalls = statCell(T('调用次数'))
    const tokenStats = el('div', 'dsw-stats')
    tokenStats.append(sTotal.node, sIn.node, sOut.node, sCalls.node)
    tokenPane.append(tokenStats)

    const trendCard = el('div', 'dsw-card')
    const tokenHead = el('div', 'dsw-cardhead')
    tokenHead.append(el('span', 'name', T('按天用量')))
    const tokenBadge = el('span', 'dsw-badge off', '—')
    tokenHead.append(tokenBadge)
    trendCard.append(tokenHead)
    trendCard.append(
      el('p', 'dsw-hint', T('柱高＝当天的输入 + 输出；虚线＝当天调用次数。鼠标停在柱上可看具体数字。')),
    )
    const legend = el('div', 'dsw-legend')
    legend.innerHTML =
      T('<span><i style="background:var(--accent)"></i>输入</span>') +
      T('<span><i style="background:color-mix(in srgb,var(--accent) 45%,transparent)"></i>输出</span>') +
      T('<span><i style="background:var(--fg2)"></i>调用次数</span>')
    const trendBox = el('div')
    trendCard.append(legend, trendBox)
    tokenPane.append(trendCard)

    const rankCard = el('div', 'dsw-card')
    const rankHead = el('div', 'dsw-cardhead')
    rankHead.append(el('span', 'name', T('用量分布')))
    const rankTabs = el('div', 'dsw-subtabs')
    let rankKey: 'account' | 'model' = 'account'
    const RANK_KEYS: ['account' | 'model', string][] = [['account', T('按账号')], ['model', T('按模型')]]
    const rankBtns: HTMLButtonElement[] = []
    const paintRankTabs = (): void => {
      RANK_KEYS.forEach(([key], index) => {
        const on = key === rankKey
        rankBtns[index].classList.toggle('active', on)
        rankBtns[index].setAttribute('aria-selected', String(on))
      })
    }
    for (const [key, label] of RANK_KEYS) {
      const btn = el('button', 'dsw-subtab', label) as HTMLButtonElement
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.addEventListener('click', () => {
        if (rankKey === key) return
        rankKey = key
        paintRankTabs()
        renderRanks(rankKey === 'account' ? lastUsage?.byAccount : lastUsage?.byModel, rankKey)
      })
      rankBtns.push(btn)
      rankTabs.append(btn)
    }
    paintRankTabs()
    rankHead.append(rankTabs)
    const ranks = el('div', 'dsw-ranks')
    rankCard.append(rankHead, ranks)
    tokenPane.append(rankCard)

    const tokenRow = el('div', 'dsw-row')
    const tokenRefreshBtn = el('button', 'dsw-btn ghost', T('刷新')) as HTMLButtonElement
    tokenRefreshBtn.type = 'button'
    tokenRefreshBtn.addEventListener('click', () => void loadUsage())
    tokenRow.append(tokenRefreshBtn)
    tokenPane.append(tokenRow)
    const tokenMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    tokenPane.append(tokenMsg)

    /** 账号 id → 给人看的名字（与调用台账同一套映射，拿不到就退回 id）。 */
    const accountLabel = (id: string): string => {
      const items: any[] = Array.isArray(lastAccountsPayload?.accounts) ? lastAccountsPayload.accounts : []
      const hit = items.find((item) => item.id === id)
      return hit ? String(hit.label || hit.display || hit.id) : id
    }

    /**
     * 按天趋势图。手写 SVG（不引图表库）。
     * 左轴是 token、右轴是调用次数 —— 两把尺子只共用画布，不共用刻度（把它们画在同一
     * 坐标系里是最常见的图表错误：量级差几百倍时折线会贴死在底部）。
     */
    const trendSvg = (series: any[]): string => {
      const W = 640
      const H = 170
      const padL = 46
      // 右边留出调用次数刻度的位置：**一条没有刻度的线是读不出来的**（量级全靠猜）
      const padR = 30
      const padT = 10
      const padB = 18
      const plotW = W - padL - padR
      const plotH = H - padT - padB
      const n = Math.max(1, series.length)
      const tokenOf = (d: any): number => (Number(d?.in) || 0) + (Number(d?.out) || 0)
      const maxTok = Math.max(1, ...series.map(tokenOf))
      const maxCalls = Math.max(1, ...series.map((d) => Number(d?.calls) || 0))
      // 刻度取 1/2/5×10^k 的整值：否则轴标签会是 17384 这种读不出来的数
      const niceMax = (value: number): number => {
        const base = Math.pow(10, Math.floor(Math.log10(value)))
        const norm = value / base
        return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * base
      }
      const top = niceMax(maxTok)
      const slot = plotW / n
      const barW = Math.max(1.5, slot * 0.62)
      let out = T(`<svg class="dsw-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="按天用量趋势">`)
      for (const ratio of [0, 0.5, 1]) {
        const y = padT + plotH - plotH * ratio
        out += `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"></line>`
        out += `<text class="axis" x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtTokens(top * ratio)}</text>`
      }
      series.forEach((d, i) => {
        const x = padL + slot * i + (slot - barW) / 2
        const hIn = ((Number(d?.in) || 0) / top) * plotH
        const hOut = ((Number(d?.out) || 0) / top) * plotH
        const yIn = padT + plotH - hIn
        out += T(`<g><title>${d?.date}：总 ${fullNum(tokenOf(d))} · 输入 ${fullNum(Number(d?.in) || 0)} / 输出 ${fullNum(Number(d?.out) || 0)} · 调用 ${Number(d?.calls) || 0} 次</title>`)
        if (hIn > 0) {
          out += `<rect class="bar-in" x="${x.toFixed(1)}" y="${yIn.toFixed(1)}" width="${barW.toFixed(1)}" height="${hIn.toFixed(1)}" rx="1"></rect>`
        }
        if (hOut > 0) {
          out += `<rect class="bar-out" x="${x.toFixed(1)}" y="${(yIn - hOut).toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" rx="1"></rect>`
        }
        // 有调用但 token 少到画不出高度时留一个 2px 的点：否则"那天确实跑了"看起来像空白
        if (hIn + hOut <= 0 && (Number(d?.calls) || 0) > 0) {
          out += `<rect class="bar-out" x="${x.toFixed(1)}" y="${(padT + plotH - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="0.5"></rect>`
        }
        out += '</g>'
      })
      const points = series
        .map((d, i) => {
          const x = padL + slot * i + slot / 2
          const y = padT + plotH - ((Number(d?.calls) || 0) / maxCalls) * plotH
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
      out += `<polyline class="line" points="${points}"></polyline>`
      // 右轴：调用次数。与左轴共用画布但**各自独立归一**（量级差几百倍时共用一个刻度
      // 会让折线贴死在底部），所以两侧都标出来，读者才知道哪条线看哪个轴。
      out += `<text class="axis" x="${W - padR + 4}" y="${(padT + 3).toFixed(1)}" text-anchor="start">${Math.round(maxCalls)}</text>`
      out += `<text class="axis" x="${W - padR + 4}" y="${(padT + plotH + 3).toFixed(1)}" text-anchor="start">0</text>`
      // 横轴标签最多 6 个（首尾必留）：30 天全画会糊成一片
      const labelStep = Math.max(1, Math.ceil(n / 6))
      series.forEach((d, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return
        const x = padL + slot * i + slot / 2
        const parts = String(d?.date ?? '').split('-')
        out += `<text class="axis" x="${x.toFixed(1)}" y="${H - 5}" text-anchor="middle">${Number(parts[1])}/${Number(parts[2])}</text>`
      })
      out += '</svg>'
      return out
    }

    /** 分布排行。条宽按**最大值**归一 —— 按总量归一的话只有第一名看得见，其余全是一根短刺。 */
    const renderRanks = (rows: any, key: 'account' | 'model'): void => {
      ranks.textContent = ''
      const items: any[] = Array.isArray(rows) ? rows.slice(0, 8) : []
      if (items.length === 0) {
        ranks.append(el('div', 'dsw-rank empty', T('这段时间还没有用量记录。')))
        return
      }
      const total = Number(lastUsage?.totals?.total) || 0
      const max = Math.max(1, ...items.map((row) => (Number(row?.in) || 0) + (Number(row?.out) || 0)))
      for (const row of items) {
        const value = (Number(row?.in) || 0) + (Number(row?.out) || 0)
        const name = key === 'account' ? accountLabel(String(row?.key ?? '')) : String(row?.key ?? '—')
        const line = el('div', 'dsw-rank')
        line.append(el('div', 'rk-name', name))
        line.append(
          el(
            'div',
            'rk-val',
            T(`${fmtTokens(value)}${total > 0 ? ` · ${((value / total) * 100).toFixed(1)}%` : ''} · ${Number(row?.calls) || 0} 次`),
          ),
        )
        const track = el('div', 'rk-track')
        const fill = el('div', 'rk-fill')
        fill.style.width = `${Math.max(2, (value / max) * 100).toFixed(1)}%`
        track.append(fill)
        line.append(track)
        ranks.append(line)
      }
    }

    /** 最近一次 /usage 的响应（切换"按账号/按模型"时不必重新拉）。 */
    let lastUsage: any = null

    const renderUsage = (data: any): void => {
      lastUsage = data
      const totals = data?.totals ?? {}
      const total = Number(totals.total) || 0
      const calls = Number(totals.calls) || 0
      const serverCalls = Number(totals.serverCalls) || 0
      const share = (part: number): string => (total > 0 ? T(`占总量 ${((part / total) * 100).toFixed(1)}%`) : '')
      sTotal.set(fmtTokens(total), calls > 0 ? T(`服务端口径 ${serverCalls}/${calls} 次`) : '')
      sIn.set(fmtTokens(Number(totals.in) || 0), share(Number(totals.in) || 0))
      sOut.set(fmtTokens(Number(totals.out) || 0), share(Number(totals.out) || 0))
      sCalls.set(String(calls), calls > 0 ? T(`成功 ${Number(totals.ok) || 0} · 失败 ${Number(totals.failed) || 0}`) : '')
      tokenBadge.textContent = tokenDays === 0 ? T('全部') : T(`近 ${tokenDays} 天`)
      tokenBadge.className = `dsw-badge ${total > 0 ? 'on' : 'off'}`
      const series: any[] = Array.isArray(data?.series) ? data.series : []
      trendBox.innerHTML = total > 0 ? trendSvg(series) : ''
      if (total <= 0) {
        tokenMsg.textContent =
          calls > 0
            ? T(`有 ${calls} 次调用，但没有可用的 token 数（失败调用或不带用量的响应不算）。`)
            : T('这段时间还没有用量记录 —— 跑一次对话后点「刷新」。')
      } else {
        tokenMsg.textContent =
          T(`数据覆盖 ${data?.coverage?.from ?? '—'} ~ ${data?.coverage?.to ?? '—'}（保留 ${data?.keepDays ?? 90} 天）。`) +
          T('网页端只在部分响应里给出总量，拿不到时按字符估算，所以这两个数是估算值。')
      }
      renderRanks(rankKey === 'account' ? data?.byAccount : data?.byModel, rankKey)
    }

    const loadUsage = async (): Promise<void> => {
      try {
        renderUsage(await api(`/usage?days=${tokenDays}`))
      } catch (error: any) {
        tokenMsg.textContent = T(`用量读取失败：${T(error?.message ?? error)}`)
      }
    }
    paneFirstShow.token = () => void loadUsage()

    // ── 传输层卡：请求从哪个网络栈出去（决定 TLS/HTTP2 指纹像不像浏览器）──
    // 实测：Node fetch 的 JA4 是 `t13d…h1`（不走 HTTP/2、cipher 数量差 3 倍多、不带 GREASE）；
    // 换成 Chromium 网络栈后 cipher 列表哈希与 Chrome **逐字节一致**。所以默认走 Chromium。
    // 但要留开关：Chromium 会跟随**系统代理**（Node 完全无视代理），梯子关着时可能反而连不上。
    const transportCard = el('div', 'dsw-card')
    transportCard.append(el('div', 'dsw-cardhead', T('传输层（指纹）')))

    const transportRow = el('div', 'dsw-gate-row')
    transportRow.append(el('span', 'dsw-gate-label', T('请求从哪出去')))
    const transportBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['chromium', T('Chrome 网络栈（推荐）')],
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
    const transportTestBtn = el('button', 'dsw-btn ghost', T('测试传输层（零额度）')) as HTMLButtonElement
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
    contextCard.append(el('div', 'dsw-cardhead', T('上下文投喂方式')))
    const contextRow = el('div', 'dsw-gate-row')
    contextRow.append(el('span', 'dsw-gate-label', T('每轮发什么')))
    const contextBtns: Record<string, HTMLButtonElement> = {}
    for (const pair of [
      ['full', T('每轮全量（默认）')],
      ['chained', T('链式投喂（只发增量）')],
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

    // 重开链是否换新会话（0.6.22）：**默认关**。
    // 用户现场：一个窗口聊两句，网页端多出三个会话 —— DSH 每轮都会重新生成替换式的
    // 运行时注入（`Current runtime context … supersedes earlier snapshots`），
    // 投喂链几乎每个回合都要重开，而"重开链就换会话"于是每回合都生效。
    // 关掉后一个窗口始终只用一个网页端会话；开 = 恢复 0.6.10 的老行为。
    const freshRow = el('div', 'dsw-gate-row')
    const freshLabel = el('label', 'dsw-switch')
    const freshInput = el('input', 'dsw-switch-input') as HTMLInputElement
    freshInput.type = 'checkbox'
    freshLabel.append(freshInput, el('span', 'dsw-switch-track'), el('span', undefined, T('重开链时换新会话')))
    freshRow.append(freshLabel)
    contextCard.append(freshRow)
    const freshHint = el('p', 'dsw-hint', '')
    contextCard.append(freshHint)

    const paintFreshSession = (): void => {
      freshHint.textContent = freshInput.checked
        ? T('开：每次重开链都新建一个网页端会话、旧的弃用 —— 上下文最干净，代价是网页端会多出会话。')
        : T('默认关：一个窗口始终只用一个网页端会话。DSH 每轮都会刷新运行时注入，投喂链几乎每个回合都会重开 ——') +
          T('关掉才能保证"聊十句也只有一个会话"。')
    }
    freshInput.checked = false
    paintFreshSession()
    freshInput.addEventListener('change', () => {
      paintFreshSession()
      void saveGate({ freshSessionOnRestart: freshInput.checked })
    })

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
          T(`链式投喂正在跑：网页端会话 ${String(chain.sessionId ?? '').slice(0, 8)}，`) +
          T(`链上已发 ${chain.turns} 段，父消息 ${chain.parentId}`)
      } else {
        contextStatus.textContent =
          mode === 'chained'
            ? T('链式投喂：下一条消息会重新起链（当前没有可续的链，或还没开始用）')
            : T('当前：每轮重发全量 prompt（和以前完全一致）')
      }
    }

    const applyContextCard = (info: any): void => {
      renderContextStatus?.(String(info?.mode ?? 'full'), info?.chain)
      const hint = String(info?.hint ?? '')
      // 设置文件路径单独一行 —— 想手工改配置的人需要它
      const path = String(info?.settingsPath ?? '')
      contextHintText.textContent = path ? T(`${hint}\n配置文件：${path}`) : hint
    }

    const saveContextMode = async (mode: 'full' | 'chained'): Promise<void> => {
      contextMsg.textContent = T('切换中……')
      try {
        const result = await api('/context-mode', { method: 'POST', body: JSON.stringify({ mode }) })
        if (result?.ok) {
          applyContextCard(result)
          contextMsg.textContent =
            T(`已切到${result.mode === 'chained' ? '链式投喂' : '每轮全量'}，即时生效`) +
            (result.persisted === false
              ? T('（未能写入配置，重启后会回到上次保存的值）')
              : T('（已写入配置，重启后仍生效）'))
        } else {
          contextMsg.textContent = T(`切换失败：${T(result?.error ?? '未知原因')}`)
        }
      } catch (error: any) {
        contextMsg.textContent = T(`切换失败：${T(error?.message ?? error)}`)
      }
    }

    // ── 关于页：版本与更新 / 数据位置 / 风险提示 ────────────────────
    // 单独一个标签而不是塞进别的页：这三块都是"偶尔看一眼"的信息，
    // 混进日常操作的页里只会稀释注意力。
    const aboutCard = el('div', 'dsw-card')
    aboutCard.append(el('div', 'dsw-cardhead', T('版本与更新')))
    const versionKv = el('div', 'dsw-kv')
    aboutCard.append(versionKv)
    const updateRow = el('div', 'dsw-row')
    updateRow.style.marginTop = '8px'
    const updateBtn = el('button', 'dsw-btn ghost', T('检查更新')) as HTMLButtonElement
    updateRow.append(updateBtn)
    aboutCard.append(updateRow)
    const updateMsg = el('p', 'dsw-hint dsw-gate-msg', '')
    aboutCard.append(updateMsg)
    aboutCard.append(
      el('p', 'dsw-hint', T('插件装不了包，所以这里只做"检查 + 给链接"。GitHub 在国内可能连不上，检查失败是正常的。')),
    )
    aboutPane.append(aboutCard)

    const renderVersion = (info: any): void => {
      versionKv.textContent = ''
      versionKv.append(el('div', 'k', T('当前版本')), el('div', undefined, info?.current || T('未知')))
      versionKv.append(
        el('div', 'k', T('登录态探活')),
        el(
          'div',
          undefined,
          info?.probeIntervalMs > 0
            ? T(`每 ${Math.round(info.probeIntervalMs / 60_000)} 分钟一次（只读、零额度）`)
            : T('已关闭'),
        ),
      )
    }

    updateBtn.addEventListener('click', () => {
      void (async () => {
        updateBtn.disabled = true
        updateMsg.textContent = T('正在检查……')
        try {
          const result = await api('/update-check', { method: 'POST', body: '{}' })
          if (!result?.ok) {
            updateMsg.textContent = T(`检查失败：${T(result?.error ?? '未知原因')}`)
            return
          }
          const current = result.current
          renderVersion({ current, probeIntervalMs })
          if (result.hasUpdate) {
            updateMsg.textContent = T(`发现新版本 ${result.latest}（当前 ${current}）${
              result.publishedAt ? ` · ${shortTime(result.publishedAt)} 发布` : ''
            }${result.url ? ` · ${result.url}` : ''}`)
          } else {
            updateMsg.textContent = T(`已是最新版本（${current}）。`)
          }
        } catch (error: any) {
          updateMsg.textContent = T(`检查失败：${T(error?.message ?? error)}`)
        } finally {
          updateBtn.disabled = false
        }
      })()
    })

    const pathsCard = el('div', 'dsw-card')
    pathsCard.append(el('div', 'dsw-cardhead', T('数据位置')))
    pathsCard.append(
      el('p', 'dsw-hint', T('插件的本地状态都在 DSH 主目录下，不进通用配置面（避免凭证混进 settings/credentials）。')),
    )
    const pathsKv = el('div', 'dsw-kv')
    pathsCard.append(pathsKv)
    pathsCard.append(
      el('p', 'dsw-hint', T('⚠️ 账号库里每个文件都是可完整登录的凭证；导出的备份同样是明文 —— 账号库卡片里的提示请当真。')),
    )
    aboutPane.append(pathsCard)

    const renderPaths = (paths: any): void => {
      pathsKv.textContent = ''
      const rows: [string, string][] = [
        [T('账号库'), paths?.accounts || T('（未知）')],
        [T('账号索引'), paths?.webLogin ? `${paths.webLogin}/accounts.json` : T('（未知）')],
        [T('调用台账'), paths?.ledger || T('（未知）')],
        [T('导出备份'), paths?.webLogin ? `${paths.webLogin}/exports/` : T('（未知）')],
      ]
      for (const [key, value] of rows) {
        pathsKv.append(el('div', 'k', key), el('div', 'dsw-path', value))
      }
    }

    const riskCard = el('div', 'dsw-card')
    riskCard.append(el('div', 'dsw-cardhead', T('关于「自动换号」（默认关闭）')))
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        T('💡 账号库支持一键手动切换；「防风控」页的「自动换号」滑块可以让它按时间轮换 —— ') +
          T('但默认是关闭的，因为下面这些理由仍然成立：开它是在拿「降低机器特征」换「摊薄单账号密度」。'),
      ),
    )
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        T('参考项目切的是「CLI 下次启动用哪个账号」——服务端看不到；而我们每次对话都实时发请求。') +
          T('真人不会在几分钟内换一个账号接着发消息，自动换号是极强的机器行为特征，') +
          T('与本插件在传输层指纹、随机间隔、会话清理上「降低机器可识别性」的努力直接冲突。') +
          T('⇒ 所以它默认关闭，而且判据只看时间、不看限流状态（"一被限流就换"更糟：同一出口 IP 上多号交替活跃，更像有组织的规避）。'),
      ),
    )
    riskCard.append(
      el(
        'p',
        'dsw-hint',
        T('另外：同一服务商会把多账号关联起来（同设备 / 同 IP / 同指纹 / 相近的行为模式）。') +
          T('一旦被判定为同一人的多开小号，处置通常比单账号超频更重，而且可能波及全部关联账号。') +
          T('所以账号库的目标是「在自己的多个正常账号之间切换更省事」，不是「靠轮换把限流绕过去」。'),
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
      // 只要有一种 Chrome 网络栈可用（electron.net.fetch 或系统浏览器代理）就不禁用按钮
      const available = info.chromiumAvailable !== false || info.browserAvailable !== false
      transportBtns.chromium.disabled = !available
      transportBtns.chromium.title = available
        ? ''
        : T('本环境找不到 Edge/Chrome，也没有 electron.net.fetch，不支持 Chrome 网络栈')

      const parts = [
        effective === 'chromium' ? T('实际生效：Chrome 网络栈') : T('实际生效：Node fetch'),
      ]
      if (info.degraded) parts.push(T('配置要求 Chrome，但本环境找不到 Edge/Chrome 也没有 electron.net.fetch，已降级为 Node'))
      if (effective === 'chromium') {
        if (info.viaBrowserProxy) parts.push(T('通过系统 Edge/Chrome 进程代理'))
        else parts.push(T('cipher 列表哈希与 Chrome 一致、ALPN 走 h2'))
      }
      transportHint.textContent = parts.join(' · ')
      transportProxyHint.textContent = String(info.hint ?? '')
    }

    const saveTransport = async (kind: 'chromium' | 'node'): Promise<void> => {
      transportMsg.textContent = T('切换中……')
      try {
        const result = await api('/transport', { method: 'POST', body: JSON.stringify({ transport: kind }) })
        if (result?.ok) {
          applyTransportCard(result)
          transportMsg.textContent =
            T(`已切换到 ${result.effective === 'chromium' ? 'Chrome 网络栈' : 'Node fetch'}，即时生效`) +
            (result.persisted === false
              ? T('（未能写入配置，重启后会回到上次保存的值）')
              : T('（已写入配置，重启后仍生效）'))
        } else {
          transportMsg.textContent = T(`切换失败：${T(result?.error ?? '未知原因')}`)
        }
      } catch (error: any) {
        transportMsg.textContent = T(`切换失败：${T(error?.message ?? error)}`)
      }
    }

    transportTestBtn.addEventListener('click', () => {
      void (async () => {
        transportTestBtn.disabled = true
        transportTestOut.style.display = ''
        transportTestOut.textContent = T('正在探测（指纹 / 流式 / 鉴权）……')
        try {
          const result = await api('/diagnostics/net-fetch', {
            method: 'POST',
            body: JSON.stringify({ mode: 'probe' }),
          })
          const lines: string[] = []
          for (const step of result?.results ?? []) {
            const title = String(step.step ?? '')
            if (title.startsWith('①')) {
              lines.push(T(`① 指纹  ja4=${step.ja4 ?? '-'}  HTTP=${step.http_version ?? '-'}`))
            } else if (title.startsWith('②')) {
              lines.push(
                T(`② 流式  ${step.ok ? '支持' : '不支持'}  分片=${step.chunks ?? 0}  abort=${step.abortedEarly ? '生效' : '未生效'}`),
              )
            } else if (title.startsWith('③')) {
              lines.push(T(`③ 鉴权  HTTP ${step.status ?? '-'}  ${step.ok ? '通过' : (step.error ?? '未通过')}`))
            }
          }
          transportTestOut.textContent = lines.length ? lines.join('\n') : JSON.stringify(result)
        } catch (error: any) {
          transportTestOut.textContent = T(`探测失败：${T(error?.message ?? error)}`)
        } finally {
          transportTestBtn.disabled = false
        }
      })()
    })

    void (async () => {
      try {
        applyTransportCard(await api('/transport'))
      } catch {
        transportMsg.textContent = T('传输层设置读取失败（宿主未响应）')
      }
      try {
        applyContextCard(await api('/context-mode'))
      } catch {
        contextMsg.textContent = T('上下文设置读取失败（宿主未响应）')
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
          ? T(`固定间隔 ${lo}ms（上下限相等）。建议拉开成区间 —— 固定值方差≈0，是明显的「定时器特征」。`)
          : T(`实际等待在 ${lo}~${hi}ms 之间随机取值（均值约 ${Math.round((lo + hi) / 2)}ms）。`)

      presetRow.textContent = ''
      presetRow.append(el('span', 'dsw-gate-label', T('快捷')))
      const presets: { min: number; max: number }[] =
        g.presets ?? [{ min: 1_500, max: 2_500 }, { min: 2_000, max: 4_000 }, { min: 5_000, max: 9_000 }]
      for (const preset of presets) {
        const isDefault =
          preset.min === (g.defaultMinIntervalMs ?? 2_000) && preset.max === (g.defaultMaxIntervalMs ?? 4_000)
        const btn = el(
          'button',
          'dsw-btn ghost dsw-preset',
          `${preset.min}~${preset.max}ms${isDefault ? T('（推荐）') : ''}`,
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

      const imgBounds = g.maxRefImagesBounds ?? { min: 0, max: 100 }
      imgRange.min = String(imgBounds.min)
      imgRange.max = String(imgBounds.max)
      imgRange.step = '1'
      imgRange.value = String(g.maxRefImages ?? g.maxRefImagesDefault ?? 24)
      paintImageCap()

      // 上下文范围：档位表与当前值都从后端拿，老宿主没有这两个字段就沿用内置档位。
      if (Array.isArray(g.contextWindowOptions) && g.contextWindowOptions.length > 0) {
        const parsedOptions = g.contextWindowOptions
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isFinite(value) && value > 0)
        if (parsedOptions.length > 0) ctxOptions = parsedOptions
      }
      ctxRange.min = '0'
      ctxRange.max = String(Math.max(0, ctxOptions.length - 1))
      ctxRange.value = String(
        nearestCtxIndex(
          Number(g.contextWindow ?? g.contextWindowDefault ?? ctxOptions[ctxOptions.length - 1]),
        ),
      )
      paintContextWindow()

      // 自动换号：边界与默认值同样由后端给（界面不写第二套数字）。
      const swBounds = g.autoSwitchBounds ?? { min: 0, max: 120 }
      swRange.min = String(swBounds.min)
      swRange.max = String(swBounds.max)
      swRange.value = String(g.autoSwitchMinutes ?? g.autoSwitchDefault ?? 0)
      // 后端没给（旧宿主）时按 null —— 只影响"上次换号"这一行的显示，不影响换号本身
      lastAutoSwitchInfo = g.lastAutoSwitch ?? null
      paintAutoSwitch()
      // 工具调用方式：后端给的是**当前值**（布尔，true = 一次一个）。缺省/旧宿主没这个字段 ⇒ 当串行。
      serialInput.checked = g.serialToolCalls === false
      paintSerialTools()
      // 到期前自动重登：后端给的是当前值（缺省 false ⇒ 未勾选）
      autoReloginInput.checked = g.autoRelogin === true
      // 重开链是否换新会话（0.6.22）：缺省/旧宿主没这个字段 ⇒ 当关闭（＝一个窗口一个会话）
      freshInput.checked = g.freshSessionOnRestart === true
      paintFreshSession()

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
          ? T('不删：请求最少，但网页端会留下临时会话记录。')
          : mode === 'immediate'
            ? T('立即：调用结束后 1.5 秒删掉（老行为，每轮多一个删除请求）。')
            : T(`延迟：这一轮攒够 ${g.cleanup?.batchSize ?? 8} 个、或最多等 `) +
              T(`${Math.round((g.cleanup?.delayMs ?? 90_000) / 1000)} 秒就集中清理，并优先用一个请求批量删 ——`) +
              T('减少「每轮建一个立刻删一个」的机器特征。上面三个区间决定"这一轮具体攒几个 / 等多久"。')
    }

    const saveGate = async (patch: {
      allowConcurrent?: boolean
      minRequestIntervalMs?: number
      maxRequestIntervalMs?: number
      sessionCleanup?: string
      maxPromptChars?: number
      maxRefImages?: number
      contextWindow?: number
      autoSwitchMinutes?: number
      /** true = 一次只发一个工具调用（界面上的开关未勾选）。 */
      serialToolCalls?: boolean
      /** 到期前自动重登（缺省关闭）。 */
      autoRelogin?: boolean
      /** 重开链时换新会话（缺省关闭；见上下文页的开关）。 */
      freshSessionOnRestart?: boolean
      cleanupBatch?: { min: number; max: number }
      cleanupDelayMs?: { min: number; max: number }
      cleanupGapMs?: { min: number; max: number }
    }): Promise<void> => {
      gateMsg.textContent = T('保存中……')
      try {
        const result = await api('/gate', { method: 'POST', body: JSON.stringify(patch) })
        if (result?.ok) {
          applyGate(result)
          gateMsg.textContent =
            T(`已生效：${result.allowConcurrent ? '允许并发（不推荐）' : '串行'} · `) +
            T(`间隔 ${result.minRequestIntervalMs}~${result.maxRequestIntervalMs}ms · `) +
            T(`清理 ${result.sessionCleanup ?? result.cleanup?.mode ?? '-'}`) +
            (result.cleanup?.batchRange
              ? T(`（阈值 ${result.cleanup.batchRange.min}~${result.cleanup.batchRange.max} 个 · `) +
                T(`等待 ${Math.round((result.cleanup.delayRange?.min ?? 0) / 1000)}~`) +
                `${Math.round((result.cleanup.delayRange?.max ?? 0) / 1000)}s · ` +
                (result.cleanup.gapRange
                  ? T(`删除间隔 ${(result.cleanup.gapRange.min / 1000).toFixed(1)}~${(result.cleanup.gapRange.max / 1000).toFixed(1)}s`)
                  : T('删除间隔关')) +
                '）'
              : '') +
            T(` · prompt 上限 ${fmtChars(Number(result.maxPromptChars ?? 0))}`) +
            (result.persisted === false ? ` ⚠️ ${result.warning ?? T('未能写入配置')}` : T('（已写入配置，重启后仍生效）'))
        } else {
          gateMsg.textContent = T(`保存失败：${T(result?.error ?? '未知原因')}`)
        }
      } catch (error: any) {
        gateMsg.textContent = T(`保存失败：${T(error?.message ?? error)}`)
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
        gateMsg.textContent = T('节流设置读取失败（宿主未响应）')
      }
    })()

    let boostUntil = 0

    recoverBtn.addEventListener('click', () => {
      void (async () => {
        recoverBtn.disabled = true
        showMessage(T('正在从已登录窗口分区读取凭证……（复用上次登录态，不需要重新登录）'))
        try {
          const result = await api('/login/recover', { method: 'POST', body: '{}' })
          if (result?.ok) {
            showMessage(`${result.verified ? '✅' : '⚠️'} ${result.message}`, result.verified ? 'ok' : '')
          } else {
            showMessage(`❌ ${T(result?.message ?? T('恢复失败'))}`, 'err')
          }
        } catch (error: any) {
          showMessage(T(`恢复失败：${T(error?.message ?? error)}`), 'err')
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
              T(`已用系统默认浏览器打开 ${result.url}\n`) +
                T('① 在浏览器里正常登录；②按 F12 → Console，粘贴下方「手动粘贴 Token」卡里的那行命令；') +
                T('③ 把打印出来的结果粘到那张卡的输入框 → 点「保存并验证」。'),
            )
          } else {
            showMessage(T(`打开失败：${T(result?.message ?? '未知原因')}；请手动在浏览器访问 ${result?.url ?? 'https://chat.deepseek.com'}`), 'err')
          }
        } catch (error: any) {
          showMessage(T(`打开失败：${T(error?.message ?? error)}`), 'err')
        }
        externalBtn.disabled = false
      })()
    })

    browserBtn.addEventListener('click', () => {
      void (async () => {
        browserBtn.disabled = true
        // 轮询（2 秒一次）会无条件把它设回可用 ⇒ 用标记让 applyStatus 跳过重算，
        // 否则用户在等待期间再点一下就会开第二个登录窗口（并发提交凭证）。
        browserBtn.dataset.busy = '1'
        showMessage(
          T('正在启动浏览器……会先清掉上次的登录状态，请在其中登录 DeepSeek（登录成功后会自动捕获，不用复制粘贴）。'),
        )
        try {
          // fresh：登录前先清掉独立 profile 与登录分区里的登录态。
          // 这个按钮此前是四个登录入口里**唯一没有前置清理**的那个 —— profile 里若还留着
          // 上次那个账号，窗口一打开就是已登录，用户以为在登录、抓回来的却是旧号。
          const result = await api('/login/browser', { method: 'POST', body: JSON.stringify({ fresh: true }) })
          if (result?.mode === 'browser') {
            // 真实浏览器 + CDP：成功即已抓完 token/cookie/指纹头
            if (result.ok) {
              showMessage(`${result.verified ? '✅' : '⚠️'} ${result.message}${result.display ? `（${result.display}）` : ''}`, result.verified ? 'ok' : '')
            } else {
              showMessage(`❌ ${result.message ?? T(`登录未完成（${result.reason ?? '未知'}）`)}`, 'err')
            }
          } else if (!result?.started) {
            showMessage(
              result?.reason === 'not-electron'
                ? T('当前宿主进程无法开 Electron 窗口，且没找到可用的 Edge/Chrome：请用「用我的默认浏览器登录」+ 手动粘贴 Token。')
                : T(`打开失败：${T(result?.reason ?? '未知原因')}`),
              'err',
            )
          } else {
            showMessage(T('登录窗口已打开，正在旁路捕获登录凭证……'))
          }
        } catch (error: any) {
          showMessage(T(`打开登录窗口失败：${T(error?.message ?? error)}`), 'err')
        }
        delete browserBtn.dataset.busy
        boostUntil = Date.now() + 5 * 60_000
        await refresh(false)
      })()
    })

    tokenBtn.addEventListener('click', () => {
      void (async () => {
        const raw = tokenInput.value.trim()
        if (!raw) {
          showMessage(T('请先粘贴 userToken'), 'err')
          return
        }
        const [tokenLine, ...rest] = raw.split('\n')
        const token = tokenLine.trim()
        const cookie = rest.join(' ').trim()
        tokenBtn.disabled = true
        showMessage(T('正在校验 token……'))
        try {
          const result = await api('/login/token', { method: 'POST', body: JSON.stringify({ token, cookie }) })
          if (result?.ok) {
            if (result.error) {
              showMessage(`⚠️ ${result.error}`, '')
            } else {
              showMessage(T(`✅ ${result.display ? `账号 ${result.display} · ` : ''}token 校验通过，已保存`), 'ok')
            }
            tokenInput.value = ''
          } else {
            showMessage(T(`❌ 校验失败：${T(result?.error ?? '未知原因')}`), 'err')
          }
        } catch (error: any) {
          showMessage(T(`保存失败：${T(error?.message ?? error)}`), 'err')
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
          showMessage(thenLogin ? T('已退出当前账号，正在打开登录窗口……') : T('已退出当前账号：本地凭证与浏览器登录态都已清除。'))
          await refresh(false)
          if (thenLogin) {
            const result = await api('/login/browser', { method: 'POST', body: '{}' })
            if (result?.started === false) {
              showMessage(T(`已退出账号；打开登录窗口失败：${T(result?.reason ?? '未知原因')}（可改用手动粘贴 token）`), 'err')
            } else {
              boostUntil = Date.now() + 180_000
              showMessage(T('已退出账号，登录窗口已打开：请在窗口里登录其它账号，凭证会自动捕获。'))
            }
          }
        } catch (error: any) {
          showMessage(T(`退出失败：${T(error?.message ?? error)}`), 'err')
        } finally {
          await refresh(false)
        }
      })()
    }

    armConfirm(logoutBtn, T('退出当前账号'), T('确认退出？'), () => doLogout(false))
    armConfirm(switchBtn, T('退出并登录其它账号'), T('确认退出并换号？'), () => doLogout(true))

    testBtn.addEventListener('click', () => {
      void (async () => {
        testBtn.disabled = true
        testOut.style.display = 'block'
        testOut.className = 'dsw-msg'
        testOut.textContent = T('请求中……（首次调用要解 PoW，可能需要几秒）')
        try {
          const result = await api('/test', { method: 'POST', body: JSON.stringify({ model: modelSelect.value }) })
          if (result?.ok) {
            testOut.className = 'dsw-msg ok'
            testOut.textContent = `✅ ${result.ms}ms · ${result.model}\n${result.text || T('(空响应)')}${result.reasoning ? T(`\n\n[思考] ${result.reasoning}`) : ''}`
          } else {
            testOut.className = 'dsw-msg err'
            testOut.textContent = `❌ ${result?.code ? `[${result.code}] ` : ''}${result?.error ?? T('失败')}`
          }
        } catch (error: any) {
          testOut.className = 'dsw-msg err'
          testOut.textContent = `❌ ${T(error?.message ?? error)}`
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
      // 账号库单独同步：它不在 /status 里，靠这一句才能"加完账号自己出现"。
      // 登录流程进行中 3 秒一次（捕获一落地就能看见），空闲 30 秒一次（够让探活补上的
      // 账号名 / 限制状态 / 失败标记自己出现，又不至于一直读盘）。
      if (shouldSyncAccounts(Date.now(), accountsSyncedAt, active)) void syncAccounts()
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
    // langRev в зависимостях — это и есть пересборка при смене языка.
    // ⚠️ `/status` — локальный эндпоинт host, а не запрос к DeepSeek, поэтому
    // повторный `refresh(false)` квоты не тратит.
  }, [langRev])

  return createElement('div', { ref: hostRef })
}

export function apply(ctx: ClientContext): void {
  bindLanguage(ctx)
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'deepseek-web-login', order: 46, label: () => T('DeepSeek 网页登录') }, () =>
          createElement(Panel),
        ),
      ),
    'deepseek-web-login: settings page',
  )
}
