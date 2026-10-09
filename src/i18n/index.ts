export {
  setLanguage,
  getLanguage,
  isSupportedLanguage,
  translate,
  dictionarySize,
  subscribeLanguage,
  storedLanguage,
  rememberLanguage,
  type Language,
} from './runtime.ts'

import { translate, getLanguage, subscribeLanguage } from './runtime.ts'

/**
 * Единая точка входа для исходников: `T('中文原文')` → строка на активном языке.
 *
 * Почему обёртка, а не `t` напрямую: `T` вызывается в момент построения DOM
 * (а не один раз при загрузке модуля), поэтому смена языка перерисовывает панель
 * без перезапуска DSH. Если строка не переведена — вернётся китайский оригинал,
 * то есть отсутствие перевода никогда не ломает интерфейс.
 */
export function T(text: string): string {
  return translate(getLanguage(), text)
}