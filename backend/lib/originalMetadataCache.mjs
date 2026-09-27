import { getAlbum, getPlaylist, getStorefront, normalizeAlbum, normalizePlaylist } from './appleApi.mjs'

// Original-language name lookups cost a second Apple catalog request per
// album/playlist. Apple's anonymous catalog API has a tight, easily-tripped
// rate limit (confirmed empirically: a couple dozen unpaced requests can
// produce a wall of 429s), so these extra requests are:
//   (a) only made when the naming mode actually needs them (queue.mjs skips
//       this entirely for the default 'display' mode),
//   (b) paced with a minimum gap between dispatches, and
//   (c) cached for the life of the process — an album's original-language
//       name never changes, so there's no reason to ever re-fetch it.
//
// ponytail: process-local Map, unbounded growth over a long-lived process.
// Swap for an LRU (or persist to the sqlite db like artistCatalogCache's
// neighbors do) if that ever matters in practice — for a self-hosted single
// user this is not expected to be a real-world problem.
const cache = new Map()
const inFlight = new Map()

const MIN_DISPATCH_INTERVAL_MS = 350
let chain = Promise.resolve()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Serialized queue with a minimum gap between dispatches — every call made
// through `paced()` waits for its predecessor to finish, then waits out the
// interval, so lookups never fire faster than one every 350ms regardless of
// how many are requested concurrently.
function paced(fn) {
  const scheduled = chain.then(async () => {
    await sleep(MIN_DISPATCH_INTERVAL_MS)
    return fn()
  })
  chain = scheduled.catch(() => {})
  return scheduled
}

// Apple's own default language for a storefront (e.g. 'ja' for jp,
// 'de-CH' for ch), i.e. what its catalog shows locally. Looked up once per
// storefront; a failed lookup is not cached so it is retried later.
const homeLanguages = new Map()
let lookupStorefront = async (id) =>
  (await getStorefront(id))?.data?.[0]?.attributes?.defaultLanguageTag || null

export function storefrontHomeLanguage(storefront) {
  const sf = String(storefront || '').trim().toLowerCase()
  if (!sf) return Promise.resolve(null)
  if (!homeLanguages.has(sf)) {
    homeLanguages.set(
      sf,
      lookupStorefront(sf).catch((err) => {
        console.error(`storefront ${sf} language lookup failed:`, err.message)
        homeLanguages.delete(sf)
        return null
      }),
    )
  }
  return homeLanguages.get(sf)
}

function cacheKey(kind, storefront, language, id) {
  return `${kind}|${storefront}|${language}|${id}`
}

async function cached(key, fetcher) {
  if (cache.has(key)) return cache.get(key)
  const pending = inFlight.get(key)
  if (pending) return pending
  const promise = paced(fetcher)
    .then((value) => {
      cache.set(key, value)
      return value
    })
    .catch((err) => {
      console.error('original-language metadata lookup failed:', err.message)
      return null
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, promise)
  return promise
}

/**
 * Original-language album metadata (name, artistName, tracks[] with the
 * same track ids as the display-language fetch), or null when the
 * storefront has no known home language or the lookup failed.
 */
export async function getOriginalAlbumMeta({ storefront, albumId }) {
  const language = await storefrontHomeLanguage(storefront)
  if (!language || !albumId) return null
  const key = cacheKey('album', storefront, language, albumId)
  return cached(key, async () => {
    const raw = await getAlbum({ storefront, id: albumId, language })
    return normalizeAlbum(raw?.data?.[0])
  })
}

/** Original-language playlist metadata (name, curatorName). */
export async function getOriginalPlaylistMeta({ storefront, playlistId }) {
  const language = await storefrontHomeLanguage(storefront)
  if (!language || !playlistId) return null
  const key = cacheKey('playlist', storefront, language, playlistId)
  return cached(key, async () => {
    const raw = await getPlaylist({ storefront, id: playlistId, language })
    return normalizePlaylist(raw?.data?.[0])
  })
}

export function __clearOriginalMetadataCacheForTests() {
  cache.clear()
  inFlight.clear()
  homeLanguages.clear()
  chain = Promise.resolve()
}

export function __setStorefrontLookupForTests(fn) {
  lookupStorefront = fn
  homeLanguages.clear()
}
