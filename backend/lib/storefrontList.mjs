import { listStorefronts } from './appleApi.mjs'

// ui language -> apple localization tag for storefront names
const APPLE_TAGS = {
  en: 'en-US',
  zh: 'zh-Hans-CN',
  'zh-hant': 'zh-Hant-TW',
  ja: 'ja',
  ko: 'ko',
  es: 'es-ES',
  fr: 'fr-FR',
}
const TTL_MS = 24 * 60 * 60 * 1000

const cache = new Map()
let fetchStorefronts = listStorefronts

export async function storefrontList(uiLanguage) {
  const tag = APPLE_TAGS[String(uiLanguage || '').toLowerCase()] || 'en-US'
  const hit = cache.get(tag)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list
  const collator = new Intl.Collator(tag)
  const list = (await fetchStorefronts(tag))
    .map((s) => ({ id: s.id, name: s.attributes?.name || s.id }))
    .sort((a, b) => collator.compare(a.name, b.name))
  cache.set(tag, { at: Date.now(), list })
  return list
}

export function __setStorefrontFetchForTests(fn) {
  fetchStorefronts = fn || listStorefronts
  cache.clear()
}
