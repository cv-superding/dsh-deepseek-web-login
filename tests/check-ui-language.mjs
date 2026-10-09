/**
 * Язык интерфейса на host-стороне: имена моделей и имя провайдера.
 *
 * Зачем отдельный тест. Имена моделей рисует **не наша панель**, а штатный
 * селектор моделей DSH: список приходит из `adapter.listModels`, то есть
 * с хоста. Панель про свой localStorage хосту не рассказывает — поэтому
 * при смене языка она делает `POST /ui`, а хост читает язык из файла.
 *
 * Что здесь ловится (обе ошибки не видны в панели и не ломают запуск):
 *   1. `hostT` не подключён к `modelInfoFor`/`providerInfo` ⇒ в селекторе
 *      моделей остаются китайские названия, хотя панель уже русская;
 *   2. язык читается из `gate.json` ⇒ он теряется при сохранении любой
 *      настройки защиты от бана (файл пишется целиком из `gate.settings()`).
 *
 * ⚠️ Почему раннер асинхронный: проверка «hostT реально переводит» пишет
 * временный `ui.json` и импортирует модуль заново. Синхронный `test()` с
 * `await` внутри вернул бы промис, исключение улетело бы в unhandled
 * rejection, а тест остался бы **зелёным**. Это ложная зелень, а не мелочь.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ADAPTER = readFileSync(join(ROOT, 'src/adapter.ts'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
const UI = readFileSync(join(ROOT, 'src/ui-language.ts'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8')

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(` ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(` ✗ ${name}\n   ${error?.message ?? error}`)
  }
}

await test('hostT реально переводит (а не возвращает вход как есть)', async () => {
  // Проверяем поведение, а не текст: модуль читает `DSH_HOME`, поэтому пишем
  // во временный каталог. Кэш языка в модуле — на процесс, так что этот тест
  // обязан быть единственным, кто трогает `ui-language.ts` в этом процессе.
  const home = mkdtempSync(join(tmpdir(), 'dsh-ui-lang-'))
  mkdirSync(join(home, 'web-login'), { recursive: true })
  writeFileSync(join(home, 'web-login', 'ui.json'), JSON.stringify({ language: 'ru' }), 'utf8')
  process.env.DSH_HOME = home
  const { hostT, hostLanguage } = await import('../src/ui-language.ts')
  assert.equal(hostLanguage(), 'ru', 'язык должен читаться из ui.json')
  const original = 'DeepSeek 网页 · 快速模式（不思考）'
  const translated = hostT(original)
  assert.notEqual(translated, original, 'строка должна переводиться, а не возвращаться как есть')
  assert.ok(/быстр/i.test(translated), `ожидался русский перевод, получено: ${translated}`)
})

await test('неизвестный язык в файле ⇒ китайский оригинал (а не пустая строка)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ui-lang-bad-'))
  mkdirSync(join(home, 'web-login'), { recursive: true })
  writeFileSync(join(home, 'web-login', 'ui.json'), JSON.stringify({ language: 'de' }), 'utf8')
  process.env.DSH_HOME = home
  // Модуль уже в кэше с 'ru' — берём чистую копию через query-строку в URL.
  const { hostT } = await import(`../src/ui-language.ts?bad=${Date.now()}`)
  assert.equal(hostT('DeepSeek 网页版（免费）'), 'DeepSeek 网页版（免费）')
})

await test('имена моделей и провайдера проходят через hostT', () => {
  assert.ok(/import \{ hostT \} from '\.\/ui-language\.ts'/.test(ADAPTER), 'adapter.ts должен импортировать hostT')
  assert.ok(/name: hostT\(spec\.name\)/.test(ADAPTER), 'имя модели обязано переводиться')
  assert.ok(/description: hostT\(spec\.description\)/.test(ADAPTER), 'описание модели тоже (оно видно в селекторе)')
  assert.ok(/name: hostT\('DeepSeek 网页版（免费）'\)/.test(ADAPTER), 'имя провайдера тоже переводится')
})

await test('есть эндпоинт POST /ui, и он пишет язык', () => {
  assert.ok(/req\.method === 'POST' && route === '\/ui'/.test(INDEX), 'POST /ui должен существовать')
  assert.ok(/setHostLanguage\(body\?\.language\)/.test(INDEX), 'эндпоинт должен применять язык из тела запроса')
})

await test('язык хранится в ui.json, а НЕ в gate.json', () => {
  assert.ok(/web-login', 'ui\.json'/.test(UI), 'файл должен быть ui.json')
  // gate.json перезаписывается целиком из gate.settings() при сохранении любой
  // настройки защиты от бана — язык бы там не выжил. Эта проверка сторожит
  // именно такую «экономию одного файла».
  // ⚠️ Комментарии вырезаем: в шапке модуля `gate.json` упоминается **намеренно**
  // (там объяснено, почему язык туда не положили). Наивная проверка «нет слова
  // gate.json» краснела бы на собственном объяснении — то есть мешала бы
  // документировать решение, ради которого тест и написан.
  const code = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/gate\.json/.test(code), 'язык не должен жить в gate.json')
  assert.ok(!/gateSettingsPath|readGateSettings|writeGateSettings/.test(code), 'ui-language не должен трогать gate')
})

await test('запись языка атомарна (полфайла сломало бы чтение при старте)', () => {
  assert.ok(/renameSync\(/.test(UI), 'запись должна идти через временный файл + rename')
})

await test('панель сообщает хосту язык и при старте, и при переключении', () => {
  assert.ok(/function pushLanguage\(/.test(CLIENT), 'pushLanguage должна существовать')
  assert.ok(/pushLanguage\(getLanguage\(\)\)/.test(CLIENT), 'язык надо отправить при инициализации панели')
  assert.ok(/rememberLanguage\(option\.id\)[\s\S]{0,240}pushLanguage\(option\.id\)/.test(CLIENT), 'и при клике по ZH/RU/EN')
})

console.log(failed === 0 ? `\n[ui-language] ${passed} 项全部通过 ✅` : `\n[ui-language] 失败 ${failed} 项 ❌`)
if (failed > 0) process.exitCode = 1
