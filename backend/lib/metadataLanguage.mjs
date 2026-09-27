// Language preferences for the UI and for metadata-driven naming (song /
// album / artist names used for folders, filenames, and tags).
//
// Deliberately a small, curated set rather than exhaustive i18n coverage —
// see README's "Language support" section for what's covered today and what
// a follow-up pass would add.
//
// Chinese naming: Apple's own catalog API uses BCP-47 script subtags for
// Chinese ('zh-Hans-CN', 'zh-Hant-TW', 'zh-Hant-HK') rather than plain 'zh'. Under that scheme
// the original 'zh' code here is really "zh-Hans" (Simplified). We keep the
// bare 'zh' code as-is rather than renaming it to 'zh-Hans', so existing
// installs with `acceptedLanguages`/`uiLanguage` already set to 'zh' (and
// the existing frontend/src/i18n/locales/zh.json) keep working unchanged;
// 'zh-hant' is added alongside it as a new, distinct code for Traditional
// Chinese — lowercased (unlike Apple's own 'zh-Hant-TW' locale tags used
// below) to match every other code in this catalog and because
// settingsStore.mjs's normalizeAcceptedLanguages() lowercases incoming
// codes before checking them against this set. Must stay in sync with
// frontend/src/i18n's SUPPORTED_LANGUAGES.
export const LANGUAGE_CATALOG = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'zh-hant', label: 'Chinese (Traditional)' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
]

export const ACCEPTED_LANGUAGE_VALUES = new Set(LANGUAGE_CATALOG.map((l) => l.code))

// UI language adds 'system' — "follow the browser's language, falling back
// to English if it can't be detected or isn't one of the languages above".
export const UI_LANGUAGE_VALUES = new Set(['system', ...ACCEPTED_LANGUAGE_VALUES])

export const NAMING_LANGUAGE_MODE_VALUES = new Set([
  'display', // my display language, falling back to original if untranslated
  'original-if-accepted', // original language if it's in my accepted list, else display
  'dual', // display language, with "(original)" appended when they differ
])

export const DEFAULT_NAMING_LANGUAGE_MODE = 'display'
export const MAX_ACCEPTED_LANGUAGES = 10

// Cheap, dependency-free script sniff — enough to tell CJK/Hangul originals
// apart from everything else, which covers the stated use case (Chinese
// original names surviving alongside an English display language). It can't
// distinguish Latin-script languages from one another (en vs es vs fr); a
// real language-detection library would be needed for that — follow-up work,
// see README.
const KANA_RE = /[぀-ヿ]/
const HAN_RE = /[一-鿿㐀-䶿]/
const HANGUL_RE = /[가-힣]/

export function detectScript(text) {
  if (!text) return null
  const s = String(text)
  if (KANA_RE.test(s)) return 'ja'
  if (HANGUL_RE.test(s)) return 'ko'
  if (HAN_RE.test(s)) return 'zh'
  return null
}

// ponytail: Han-script detection can't tell Simplified from Traditional
// apart (that needs a real per-character variant table, not a cheap regex
// range) — upgrade path is a proper Hanzi-variant table or a language-detection
// library, see README. Until then, a detected 'zh' script is treated as
// matching either accepted-language code, since we genuinely don't know
// which variant the text is in.
function scriptMatchesAccepted(script, acceptedCode) {
  if (script === 'zh') return acceptedCode === 'zh' || acceptedCode === 'zh-hant'
  return script === acceptedCode
}

/**
 * Resolve the final metadata name (song / album / artist) for the user's
 * naming-language preference.
 *
 * `displayName` is the name Apple returned for the user's configured
 * catalog `language` setting; `originalName` is the name Apple returned for
 * the storefront's home locale. When they're equal (Apple had nothing
 * distinct to offer — the common case for most Western-market content),
 * every mode collapses to `displayName`, so this is a no-op for the
 * majority of downloads.
 */
export function resolveMetadataName({
  mode,
  displayName,
  originalName,
  acceptedLanguages = [],
}) {
  const display = displayName || originalName || ''
  const original = originalName || display
  if (!original || !display || original === display) return display

  if (mode === 'original-if-accepted') {
    const script = detectScript(original)
    if (script && acceptedLanguages.some((l) => scriptMatchesAccepted(script, l))) return original
    return display
  }
  if (mode === 'dual') {
    return `${display} (${original})`
  }
  return display
}
