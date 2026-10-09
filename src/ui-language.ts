/**
 * Язык интерфейса на **host**-стороне.
 *
 * Зачем отдельный модуль: часть строк, которые видит пользователь, формирует
 * не панель, а хост — имена и описания моделей уходят в **штатный** селектор
 * моделей DSH (`adapter.listModels`), имя провайдера — в список провайдеров.
 * Панель хранит выбор языка в localStorage, а хост туда не достаёт; поэтому
 * клиент при смене языка делает `POST /ui`, а хост кладёт значение в файл.
 *
 * Почему файл, а не `gate.json`: `gate.json` — настройки **защиты от бана**
 * (интервалы, лимиты), и записывается он целиком из `gate.settings()`. Положи
 * туда язык — он бы терялся при каждом сохранении любой другой настройки.
 *
 * Чтение кэшируется в памяти: `hostT()` вызывается в том числе из
 * `resolveModel`, то есть на каждом запросе к модели. Читать файл каждый раз
 * было бы бессмысленной работой с диском в горячем пути.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { translate, type Language } from './i18n/runtime.ts'

/** Файл с языком интерфейса: `${DSH_HOME || ~/.dsh}/web-login/ui.json`. */
export function uiLanguagePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'web-login', 'ui.json')
}

function parseLanguage(value: unknown): Language | undefined {
  return value === 'zh' || value === 'ru' || value === 'en' ? value : undefined
}

let cached: Language | undefined

/** Текущий язык интерфейса. Неизвестное/отсутствующее значение — китайский оригинал. */
export function hostLanguage(): Language {
  if (cached !== undefined) return cached
  try {
    const parsed = JSON.parse(readFileSync(uiLanguagePath(), 'utf8'))
    const stored = parseLanguage(parsed?.language)
    if (stored) {
      cached = stored
      return cached
    }
  } catch {
    /* файла нет или он битый — это норма, остаёмся на оригинале */
  }
  cached = 'zh'
  return cached
}

/**
 * Записать язык. Невалидное значение трактуется как «китайский оригинал»
 * (а не как ошибка): эндпоинт принимает данные из браузера, и падать на
 * мусоре там незачем — достаточно не применять его.
 */
export function setHostLanguage(value: unknown): Language {
  const resolved = parseLanguage(value) ?? 'zh'
  cached = resolved
  try {
    const file = uiLanguagePath()
    mkdirSync(dirname(file), { recursive: true })
    // Атомарно: половина файла (обрыв записи) сломала бы чтение при следующем старте.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ language: resolved }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch {
    /* не смогли сохранить — язык всё равно применится до перезапуска */
  }
  return resolved
}

/** Перевести host-строку на выбранный в панели язык (для имён моделей и провайдера). */
export function hostT(text: string): string {
  return translate(hostLanguage(), text)
}
