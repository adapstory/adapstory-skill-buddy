import { createI18n } from 'vue-i18n'
import en from './locales/en'
import zhCN from './locales/zh-CN'
import ruCore from './locales/ru-core'
import ruRest from './locales/ru-rest'

export type Locale = 'zh-CN' | 'en' | 'ru'

export function detectLocale(): Locale {
  const language = navigator.language.toLowerCase()
  if (language.startsWith('ru')) return 'ru'
  return language.startsWith('zh') ? 'zh-CN' : 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { 'zh-CN': zhCN, en, ru: { ...ruCore, ...ruRest } },
})
