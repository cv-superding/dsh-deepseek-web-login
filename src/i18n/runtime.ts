/**
 * 插件自带的极简 i18n 运行时。
 *
 * 设计取舍（为什么不用宿主 `ctx.locale` 的 `t` 座位）：
 * 本插件的设置面板是**命令式 DOM**（`document.createElement` + `textContent`），
 * 不是 slot 渲染的 React 树，拿不到框架注入的 `t`。所以自己维护一份：
 * 语言由宿主 locale 快照驱动，字典是**以中文原文为 key** 的映射。
 *
 * 为什么用中文原文当 key 而不是造 `account.login.button` 这类键名：
 * 源码里本来就有 470+ 条中文串，造键名要人工对齐两份清单，
 * 一旦漏一条就是"界面上孤零零一句中文"——用原文当 key，漏译只会退回中文，不会崩。
 *
 * 带插值的串（`剩余 ${m} 分`）在字典里写成 `剩余 {0} 分`，
 * 运行时把它编译成正则去匹配**已经拼好的**字符串，所以调用点不需要改结构。
 */
import { RU } from './dict.ru.ts'
import { EN } from './dict.en.ts'

export type Language = 'zh' | 'ru' | 'en'
export type Dict = Record<string, string>

const DICTS: Record<'ru' | 'en', Dict> = { ru: RU, en: EN }

let language: Language = 'zh'

/**
 * Подписчики на смену языка.
 *
 * Зачем: панель строит DOM один раз в `useEffect` и дальше только обновляет
 * тексты узлов. Без подписки смена языка в настройках DSH не дошла бы до уже
 * открытой панели — пришлось бы закрыть и снова открыть страницу настроек.
 * С подпиской панель перестраивается на месте.
 */
const languageListeners = new Set<() => void>()

/**
 * Установить текущий язык; неизвестное значение (в т.ч. undefined) — китайский
 * оригинал. Повторная установка того же языка не дёргает подписчиков: иначе
 * каждое событие `locale/change` перестраивало бы панель без причины.
 */
export function setLanguage(next: string | undefined | null): void {
  const resolved: Language = next === 'ru' || next === 'en' ? next : 'zh'
  if (resolved === language) return
  language = resolved
  for (const listener of languageListeners) listener()
}

/** Подписка на смену языка; возвращает функцию отписки. */
export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener)
  return () => {
    languageListeners.delete(listener)
  }
}

/** Ключ в localStorage: язык, выбранный вручную в шапке панели. */
const STORAGE_KEY = 'dsh-deepseek-web-login.lang'

/**
 * Язык, выбранный пользователем вручную (кнопки в шапке панели).
 *
 * Почему localStorage, а не gate.json: gate.json принадлежит host-стороне и
 * перезаписывается целиком при сохранении настроек — клиентское поле там бы
 * потерялось. localStorage доступен панели напрямую и переживает перезапуск.
 *
 * Почему ручной выбор вообще нужен: встроенный набор языков DSH — только
 * `zh` и `en`, поэтому `locale.active` никогда не станет `ru`, и без своего
 * переключателя русский интерфейс было бы не включить.
 *
 * Ошибки чтения/записи глушим: запрет хранилища или приватный режим не должны
 * ломать панель — просто выбор не запомнится.
 */
export function storedLanguage(): Language | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw === 'zh' || raw === 'ru' || raw === 'en') return raw
  } catch {
    /* хранилище недоступно — остаёмся на языке по умолчанию */
  }
  return undefined
}

/** Запомнить выбор языка и сразу применить его. */
export function rememberLanguage(lang: Language): void {
  // Сначала запись, потом переключение: `setLanguage` синхронно дёргает
  // подписчиков и перестраивает панель, а она при перестройке читает
  // `storedLanguage()`. Обратный порядок вернул бы старый язык.
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang)
  } catch {
    /* не смогли запомнить — язык всё равно применится ниже */
  }
  setLanguage(lang)
}

export function getLanguage(): Language {
  return language
}

export function isSupportedLanguage(value: unknown): value is Language {
  return value === 'zh' || value === 'ru' || value === 'en'
}

interface Compiled {
  exact: Dict
  rules: { re: RegExp; to: string }[]
}

const compiledCache = new Map<'ru' | 'en', Compiled>()

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compile(lang: 'ru' | 'en'): Compiled {
  const cached = compiledCache.get(lang)
  if (cached) return cached
  const dict = DICTS[lang]
  const exact: Dict = {}
  const rules: { re: RegExp; to: string }[] = []
  for (const [key, value] of Object.entries(dict)) {
    if (!key.includes('{')) {
      exact[key] = value
      continue
    }
    // `剩余 {0} 分` → /^剩余 ([\s\S]+?) 分$/ ，译文里的 {0} 换成占位标记。
    //
    // ⚠️ Почему НЕ `$1`: подстановка `$1` + следующая за ней цифра в переводе
    // склеиваются в `$10` — а это ссылка на **десятую** группу, которой нет.
    // `String.replace` подставляет вместо неё пустую строку, и число исчезает.
    // Ровно это и было в `'{0} 万': '{0}0 тыс.'`: 142.5 万 → « тыс.» (числа нет).
    // Проверяется `tests/check-i18n.mjs` и `web-login-ru/check-fmt-bug.mjs`.
    // Символ \u0001 в текстах не встречается, поэтому он безопасен как маркер.
    let source = ''
    let last = 0
    const placeholders = /\{(\d+)\}/g
    let match: RegExpExecArray | null
    while ((match = placeholders.exec(key)) !== null) {
      source += escapeRegExp(key.slice(last, match.index)) + '([\\s\\S]+?)'
      last = match.index + match[0].length
    }
    source += escapeRegExp(key.slice(last))
    const to = value.replace(/\{(\d+)\}/g, (_all, index: string) => `\u0001${Number(index) + 1}\u0001`)
    rules.push({ re: new RegExp(`^${source}$`), to })
  }
  // 「通配符少的先试」优先于「长的先试」。
  // 只按长度排会出错：`已校验 {0} 个账号：{1}。` 的**正则源码**比
  // `已校验 {0} 个账号：全部正常。` 更长（一个通配符 `([\s\S]+?)` 占 11 个字符），
  // 于是通用规则先命中、把更具体的那条永久遮蔽 —— 第二个数字还留在中文里。
  // 约束越多的规则越具体：先比通配符个数，再比字面量长度。
  const holes = (re: RegExp): number => re.source.split('([\\s\\S]+?)').length - 1
  rules.sort((a, b) => holes(a.re) - holes(b.re) || b.re.source.length - a.re.source.length)
  const result: Compiled = { exact, rules }
  compiledCache.set(lang, result)
  return result
}

/**
 * 把一条已经拼好的中文串翻成目标语言；没有对应条目时原样返回。
 *
 * 第三个参数是**内部**递归深度，调用点不要传：见下面关于"替换值本身也是界面文案"
 * 的说明。
 */
export function translate(lang: Language, text: string, depth = 0): string {
  if (lang === 'zh' || text === '') return text
  const { exact, rules } = compile(lang)
  const hit = exact[text]
  if (hit !== undefined) return hit
  for (const rule of rules) {
    const match = rule.re.exec(text)
    if (match === null) continue
    // 插值进来的部分**本身也常常是界面文案**：`已校验 3 个账号：2 个正常。` 里第二个
    // 参数就是独立的一条 `{0} 个正常`。不做递归翻译的话，外层译好、内层仍是中文，
    // 界面上会出现「Проверено аккаунтов: 3 — 2 个正常.」这种半截译文。
    //
    // 递归有深度上限：正常嵌套只有一层（外层模板 → 内层模板），设 2 足够；
    // 没有上限时，若某条规则的捕获组恰好等于整串就会无限递归。
    return rule.to.replace(/\u0001(\d+)\u0001/g, (_all, index: string) => {
      const value = match[Number(index)]
      if (value === undefined || depth >= 2) return value ?? ''
      return translate(lang, value, depth + 1)
    })
  }
  return text
}

/** 当前语言下的翻译。默认语言是 zh ⇒ 未初始化时是恒等函数。 */
export function t(text: string): string {
  return translate(language, text)
}

/** 供 "关于" 页展示的字典条目数（翻译进度一眼可见）。 */
export function dictionarySize(lang: 'ru' | 'en'): number {
  return Object.keys(DICTS[lang]).length
}
