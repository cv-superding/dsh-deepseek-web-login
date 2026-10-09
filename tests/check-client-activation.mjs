/**
 * 客户端（lib/client.js）必须能在**真实 cordis 语义**下激活。
 *
 * 存在的理由是一个真实事故：0.6.41 给面板加了「跟随宿主语言」，代码里写了
 * `ctx.locale?.getSnapshot()` —— 看起来是无害的可选依赖，实际让整个插件
 * **激活失败**，DSH 直接起不来：
 *
 *     Error: web boot: 1 entry did not activate
 *     dsh-deepseek-web-login: failed
 *
 * 根因：cordis 的上下文是 Proxy，读一个**没在 `inject` 里声明**的服务不是
 * 返回 `undefined`，而是**抛异常**（`cannot get property "x" without inject`）。
 * `?.` 只能挡 `undefined`，挡不住抛错 —— trap 在 `?.` 之前就执行了。
 *
 * 为什么普通"调一下 apply()"的冒烟测试抓不到：手写的假 ctx 用普通对象，
 * 读不存在的属性自然得到 `undefined`，于是 `ctx.locale?.` 顺利通过。
 * **假 ctx 越宽松，这个 bug 越测不出来**。所以这里的 ctx 必须复刻 cordis
 * 的两条关键语义：未声明的属性抛错；声明的服务缺失时按注册表返回。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
function check(ok, label, detail) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** 极简 React 替身：本用例只跑激活，不跑渲染，够用即可。 */
function fakeReact() {
  return {
    createElement: (...args) => ({ args }),
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (value) => [value, () => {}],
    Fragment: {},
  }
}

/** 把 bundle 装进一个假浏览器，返回它注册的模块描述。 */
function loadBundle() {
  let captured = null
  const window = {
    __ModuleLoader__: {
      load: (mod) => {
        captured = mod
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  const document = {
    createElement: () => makeNode(),
    head: makeNode(),
    body: makeNode(),
  }
  const require = (name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`неожиданный require: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'window', 'document', bundle)(require, window, document)
  if (captured === null) throw new Error('модуль не зарегистрировался в __ModuleLoader__')
  return captured
}

function makeNode() {
  return {
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    children: [],
    append: () => {},
    appendChild: () => {},
    replaceChildren: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: '',
    innerHTML: '',
    value: '',
  }
}

/** 从 bundle 里读出插件声明的 `inject`（不 import，避免执行顺序问题）。 */
function declaredInject(exports) {
  const raw = exports.inject
  if (Array.isArray(raw)) return new Set(raw)
  if (raw && typeof raw === 'object') {
    return new Set([...(raw.required ?? []), ...(raw.optional ?? [])])
  }
  return new Set()
}

/**
 * 复刻 cordis 的上下文语义。
 *
 * `registered` —— 宿主**实际提供**的服务（inject 声明了也要宿主有才算）；
 * `declared`   —— 插件在 `inject` 里声明的服务名。
 *
 * 规则（照抄 `cordis/lib/index.js` 的 `ReflectService.handler.get`）：
 *   • 未声明 ⇒ **抛** `cannot get property "x" without inject`；
 *   • 已声明且已注册 ⇒ 返回服务；
 *   • 已声明但未注册 ⇒ cordis 会让 fiber 停在 inactive，插件不会被调用。
 *     这里已经进到 apply，说明是第三种之外的情况，故返回 undefined。
 */
function cordisContext({ declared, registered, own }) {
  const services = registered
  const target = { ...own }
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return t[prop]
      if (prop in t) return t[prop]
      if (declared.has(prop)) return services[prop]
      throw new Error(`cannot get property "${prop}" without inject`)
    },
    has(t, prop) {
      return prop in t || declared.has(prop)
    },
  })
}

function runActivation({ localeAvailable, label }) {
  const mod = loadBundle()
  const exports = mod.factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`неожиданный require: ${name}`)
  })
  const declared = declaredInject(exports)

  const registered = {
    slots: {
      inject: () => {},
      register: () => {},
      installLocale: () => {},
    },
  }
  if (localeAvailable) {
    registered.locale = {
      getSnapshot: () => ({ active: 'ru' }),
      subscribe: () => () => {},
    }
  }

  const ctx = cordisContext({
    declared,
    registered,
    own: {
      effect: () => {},
      on: () => {},
    },
  })

  try {
    exports.apply(ctx)
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

console.log('=== check-client-activation.mjs ===')
console.log(`  inject в бандле: ${JSON.stringify(loadBundle().id)}`)

// 1. 宿主提供了 locale（正常环境）。
const withLocale = runActivation({ localeAvailable: true })
check(
  withLocale.ok,
  'активация проходит, когда сервис locale доступен',
  withLocale.error ? `${withLocale.error.message}` : '',
)

// 2. 宿主没有 locale —— 这正是 0.6.41 崩溃的场景。
//    语言跟随是**可选**功能：没有它面板必须照常挂载（退回中文/自己的选择）。
const withoutLocale = runActivation({ localeAvailable: false })
check(
  withoutLocale.ok,
  'активация проходит, когда сервис locale НЕ зарегистрирован',
  withoutLocale.error
    ? `${withoutLocale.error.message}\n      ↑ это и есть «1 entry did not activate»: чтение необъявленного сервиса бросило исключение`
    : '',
)

// 3. 反向用例：守卫本身必须真的在挡。
//    如果哪天有人把 `optionalService` 换成裸 `ctx.x`，第 2 条会红；但如果
//    有人把 Proxy 换成普通对象，第 2 条就会**假绿**。这里直接验 Proxy 语义，
//    保证"测试环境本身"没有退化 —— 变异验证：删掉 optionalService 的
//    try/catch ⇒ 第 2 条红，其余不变。
const strict = cordisContext({
  declared: new Set(['slots']),
  registered: { slots: {} },
  own: {},
})
let threw = false
try {
  void strict.locale
} catch {
  threw = true
}
check(
  threw,
  'тестовый контекст воспроизводит cordis: чтение необъявленного сервиса бросает',
  threw ? '' : 'контекст стал слишком мягким — вторая проверка выше ничего не значит',
)

console.log(`\n[client-activation] ${passed}/${passed + failed}通过`)
process.exitCode = failed ? 1 : 0