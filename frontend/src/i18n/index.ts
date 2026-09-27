import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import zh from './locales/zh.json'
import zhHant from './locales/zh-hant.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import es from './locales/es.json'
import fr from './locales/fr.json'

// Small, curated set of UI languages — must match backend/lib/metadataLanguage.mjs's
// LANGUAGE_CATALOG. 'zh' is Simplified Chinese (kept as the bare code for
// backward compatibility with existing installs/locale files) and 'zh-hant'
// is Traditional Chinese — see metadataLanguage.mjs's LANGUAGE_CATALOG
// comment and README's "Language support" section for why 'zh' wasn't
// renamed to 'zh-Hans'.
export const SUPPORTED_LANGUAGES = ['en', 'zh', 'zh-hant', 'ja', 'ko', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_NATIVE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      // Registered under 'zh-Hant' (title-cased script subtag), NOT our own
      // lowercase 'zh-hant' code below — i18next's internal language-resolution
      // hierarchy (services.languageUtils.formatLanguageCode /
      // toResolveHierarchy) always title-cases a small set of known script
      // subtags including 'hant' (see i18next's own specialCases list), so
      // calling changeLanguage('zh-hant') builds the lookup order
      // ['zh-Hant', 'zh', 'en'] regardless of the casing we pass in. If the
      // resource bundle key here doesn't match that exact 'zh-Hant' casing,
      // the lookup silently falls through to the 'zh' bundle instead —
      // i18n.language still reads back as 'zh-hant' (so this is easy to miss
      // in casual testing), but every t() call resolves to Simplified
      // Chinese. Confirmed by reproducing against the installed i18next
      // package directly. Our own public-facing code stays the lowercase
      // 'zh-hant' everywhere else (SUPPORTED_LANGUAGES, settings storage,
      // backend LANGUAGE_CATALOG) — only this resources key needs the
      // i18next-internal casing.
      'zh-Hant': { translation: zhHant },
      ja: { translation: ja },
      ko: { translation: ko },
      es: { translation: es },
      fr: { translation: fr },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    nonExplicitSupportedLngs: true,
    detection: {
      // "Follow system default" reads navigator.language; an explicit
      // uiLanguage setting (applyUiLanguage below) always overrides it and
      // is what gets cached, so a saved choice survives across browsers too
      // (it lives in backend settings, not just localStorage).
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      // Without this, i18next's own region-stripping (nonExplicitSupportedLngs)
      // would reduce every zh-* browser locale — including zh-TW/zh-HK/zh-Hant-* —
      // down to the bare 'zh', so Traditional-Chinese browsers would silently
      // auto-detect into the Simplified translation. Bucket by script/region
      // first, following Apple's zh-Hant-TW / zh-Hant-HK convention, before
      // i18next's own matching runs.
      convertDetectedLanguage: (lng: string) => {
        const lower = lng.toLowerCase()
        if (!lower.startsWith('zh')) return lng
        return lower.includes('hant') || /^zh-(tw|hk|mo)\b/.test(lower) ? 'zh-hant' : 'zh'
      },
    },
    interpolation: { escapeValue: false },
  })

// Keep <html lang> in step with the UI language, for screen readers and
// the browser's own hyphenation and font selection.
const syncHtmlLang = (lng?: string) => {
  document.documentElement.lang = lng || 'en'
}
i18n.on('languageChanged', syncHtmlLang)
syncHtmlLang(i18n.resolvedLanguage)

// The exact localStorage key i18next-browser-languagedetector's default
// 'localStorage' cache uses (see its lookupLocalStorage option, which
// defaults to this name). applyUiLanguage below has to know it explicitly
// so it can clear a stale explicit pick when the user switches back to
// "Follow system default" — see the comment there for why.
const DETECTOR_CACHE_KEY = 'i18nextLng'

/**
 * Apply the user's uiLanguage setting ('system' | one of SUPPORTED_LANGUAGES).
 * 'system' re-runs browser-language detection (falling back to English when
 * the browser's language isn't one of the translated ones or can't be
 * detected — i18next's fallbackLng handles that automatically).
 *
 * The detector's cache ('localStorage', checked before 'navigator' — see the
 * `detection.order` above) is exactly what makes an explicit pick sticky
 * across reloads. That means switching back to "system" has to clear it
 * first: otherwise `changeLanguage(undefined)` just re-reads the previous
 * explicit pick out of localStorage instead of ever reaching
 * navigator.language, and "Follow system default" silently stops following
 * the system.
 */
export function applyUiLanguage(uiLanguage: string | null | undefined) {
  if (!uiLanguage || uiLanguage === 'system') {
    try {
      window.localStorage.removeItem(DETECTOR_CACHE_KEY)
    } catch {
      // Private browsing / blocked storage — detection still runs below,
      // it just won't be cached for next time.
    }
    void i18n.changeLanguage(undefined)
    return
  }
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(uiLanguage)) {
    void i18n.changeLanguage(uiLanguage)
  }
}

export default i18n
