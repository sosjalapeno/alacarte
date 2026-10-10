import { getBearerToken, invalidateBearerCache } from './appleToken.mjs'
import { AppleRateLimitedError, appleGateway, currentLane } from './appleGateway.mjs'

const BASE = 'https://amp-api.music.apple.com/v1/catalog'

// Without a limit a stalled Apple connection hangs the request, job or
// scheduler waiting on it.
const APPLE_REQUEST_TIMEOUT_MS = 30_000

// A fresh timeout per attempt, combined with the caller's own signal.
export function appleRequestSignal(signal) {
  const timeout = AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// Rolling record of every Apple catalog request, so a 429 can be traced to
// whichever caller (importer search, scheduler, download job, UI) caused the
// burst. Logged to stdout; the caller is the first stack frame outside this file.
const recentCalls = []
const RECENT_WINDOW_MS = 60_000

function callerOf() {
  const frames = String(new Error().stack || '').split('\n').slice(1)
  const f = frames.find((l) => !l.includes('appleApi.mjs') && !l.includes('node:internal'))
  return (f || '').trim().replace(/^at /, '').replace(/.*\/(?:app|backend)\//, '').slice(0, 90)
}

// Milliseconds of local block left after a 429 (0 = Apple calls are being sent).
export function getAppleCooldownMs() {
  return appleGateway.cooldownRemainingMs()
}

function recordCall(entry) {
  const now = Date.now()
  recentCalls.push({ ...entry, at: now })
  while (recentCalls.length && now - recentCalls[0].at > RECENT_WINDOW_MS) recentCalls.shift()
  console.log(
    `[apple] ${entry.status} ${entry.lane} ${entry.path}${entry.query} ${entry.ms}ms (+${entry.waitedMs}ms queued) via ${entry.caller}` +
      (entry.retryAfter ? ` retry-after=${entry.retryAfter}` : ''),
  )
  if (entry.status === 429) {
    const st = appleGateway.status()
    console.warn(
      `[apple] 429 -> ${st.state}, calls blocked for ${st.cooldownSeconds}s, gap now ${st.intervalMs}ms (floor ${st.floorMs}ms)`,
    )
    const byCaller = {}
    for (const c of recentCalls) byCaller[`${c.lane} ${c.caller}`] = (byCaller[`${c.lane} ${c.caller}`] || 0) + 1
    console.warn(
      `[apple] 429 after ${recentCalls.length} calls in last ${RECENT_WINDOW_MS / 1000}s:`,
      JSON.stringify(byCaller),
    )
  }
}

// One request to Apple, admitted by the gateway (lane taken from the calling context).
// Rejects with AppleRateLimitedError, without a network call, while Apple is blocking us.
export async function appleFetch(url, init = {}, { caller = callerOf() } = {}) {
  const lane = currentLane()
  const u = new URL(url)
  const queuedAt = Date.now()
  try {
    return await appleGateway.schedule(
      async () => {
        const startedAt = Date.now()
        const res = await fetch(url, { ...init, signal: appleRequestSignal(init.signal) })
        appleGateway.report(res.status)
        recordCall({
          status: res.status,
          lane,
          path: u.pathname,
          query: u.search.slice(0, 80),
          ms: Date.now() - startedAt,
          waitedMs: startedAt - queuedAt,
          caller,
          retryAfter: res.headers.get('retry-after'),
        })
        return res
      },
      { lane, path: u.pathname },
    )
  } catch (err) {
    if (err instanceof AppleRateLimitedError) {
      console.warn(`[apple] SKIPPED ${lane} ${u.pathname} via ${caller}: ${err.message}`)
    }
    throw err
  }
}

const inFlightGets = new Map()

// Identical requests made at the same time share one call to Apple.
async function apiGet(url, opts = {}) {
  // Taken here, while the caller is still on the stack; it is lost across the awaits below.
  const caller = callerOf()
  if (opts.signal) return apiGetOnce(url, opts, caller)
  const key = `${currentLane()}|${url}|${opts.language || ''}|${opts.mediaUserToken ? 1 : 0}`
  let pending = inFlightGets.get(key)
  if (!pending) {
    pending = apiGetOnce(url, opts, caller).finally(() => inFlightGets.delete(key))
    inFlightGets.set(key, pending)
  }
  return structuredClone(await pending)
}

async function apiGetOnce(url, { language = '', mediaUserToken, signal } = {}, caller) {
  let token = await getBearerToken()
  const run = async (t) => {
    const headers = {
      Authorization: `Bearer ${t}`,
      Origin: 'https://music.apple.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept-Language': language || 'en-US',
    }
    if (mediaUserToken) headers['Music-User-Token'] = mediaUserToken
    return appleFetch(url, { headers, signal }, { caller })
  }
  let res = await run(token)
  if (res.status === 401 || res.status === 403) {
    invalidateBearerCache()
    token = await getBearerToken()
    res = await run(token)
  }
  if (res.status === 429) {
    const body = await res.text().catch(() => '')
    const wait = Math.ceil(appleGateway.cooldownRemainingMs() / 1000) || Number(res.headers.get('retry-after')) || 60
    throw new AppleRateLimitedError(new URL(url).pathname, wait, body.slice(0, 200))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Apple API ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 200)}`,
    )
  }
  return res.json()
}

export async function searchCatalog({
  storefront,
  term,
  types = 'albums,artists,songs,playlists',
  limit = 25,
  offset = 0,
  language = 'en-US',
  mediaUserToken,
  signal,
  withRelationships = false,
}) {
  const qs = new URLSearchParams({
    term,
    types,
    include: 'artists',
    limit: String(limit),
    offset: String(offset),
    l: language,
  })
  if (withRelationships) {
    // search ignores a bare include; per-type includes add artist/album ids
    qs.set('include[songs]', 'artists,albums')
    qs.set('include[albums]', 'artists')
  }
  const url = `${BASE}/${encodeURIComponent(storefront)}/search?${qs.toString()}`
  return apiGet(url, { language, mediaUserToken, signal })
}

export async function getStorefront(id) {
  return apiGet(`https://amp-api.music.apple.com/v1/storefronts/${encodeURIComponent(id)}`)
}

export async function listStorefronts(language = 'en-US') {
  const out = []
  let url = `https://amp-api.music.apple.com/v1/storefronts?limit=200&l=${encodeURIComponent(language)}`
  while (url) {
    const page = await apiGet(url, { language })
    out.push(...(page.data || []))
    url = page.next ? new URL(page.next, 'https://amp-api.music.apple.com').href : null
  }
  return out
}

export async function getSongsByIsrc({ storefront, isrcs, language = 'en-US', include }) {
  const qs = new URLSearchParams({ 'filter[isrc]': isrcs.join(','), l: language })
  if (include) qs.set('include', include)
  return apiGet(`${BASE}/${encodeURIComponent(storefront)}/songs?${qs.toString()}`, { language })
}

// Needs a media-user-token. Returns the TTML document, or null when Apple has
// no lyrics for the song.
export async function getSongLyricsTtml({ storefront, id, language = 'en-US', mediaUserToken }) {
  const qs = new URLSearchParams({ l: language, extend: 'ttmlLocalizations' })
  const url = `${BASE}/${encodeURIComponent(storefront)}/songs/${encodeURIComponent(id)}/lyrics?${qs.toString()}`
  try {
    const json = await apiGet(url, { language, mediaUserToken })
    const attrs = json?.data?.[0]?.attributes || {}
    return attrs.ttml || attrs.ttmlLocalizations || null
  } catch (err) {
    if (/Apple API 404/.test(err.message)) return null
    throw err
  }
}

export async function getAlbumsByUpc({ storefront, upcs, language = 'en-US', include }) {
  const qs = new URLSearchParams({ 'filter[upc]': upcs.join(','), l: language })
  if (include) qs.set('include', include)
  return apiGet(`${BASE}/${encodeURIComponent(storefront)}/albums?${qs.toString()}`, { language })
}

export async function getAlbum({ storefront, id, language = 'en-US' }) {
  const qs = new URLSearchParams({
    'omit[resource]': 'autos',
    include: 'tracks,artists,record-labels',
    'include[songs]': 'artists',
    extend: 'editorialVideo,extendedAssetUrls',
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/albums/${encodeURIComponent(id)}?${qs.toString()}`
  return apiGet(url, { language })
}

export async function getSong({ storefront, id, language = 'en-US' }) {
  const qs = new URLSearchParams({
    include: 'albums,artists',
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/songs/${encodeURIComponent(id)}?${qs.toString()}`
  return apiGet(url, { language })
}

export async function getArtist({ storefront, id, language = 'en-US' }) {
  const qs = new URLSearchParams({
    include: 'albums',
    'limit[albums]': '50',
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(id)}?${qs.toString()}`
  return apiGet(url, { language })
}

export async function getPlaylist({ storefront, id, language = 'en-US' }) {
  const qs = new URLSearchParams({
    include: 'tracks',
    'include[songs]': 'artists',
    'include[albums]': 'artists',
    extend: 'editorialVideo,extendedAssetUrls',
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/playlists/${encodeURIComponent(id)}?${qs.toString()}`
  return apiGet(url, { language })
}

const PLAYLIST_TRACKS_PAGE_SIZE = 100

export async function fetchCatalogPlaylistTracksPage({
  storefront,
  id,
  language = 'en-US',
  offset = 0,
  limit = PLAYLIST_TRACKS_PAGE_SIZE,
}) {
  const qs = new URLSearchParams({
    limit: String(Math.max(1, Math.min(limit, PLAYLIST_TRACKS_PAGE_SIZE))),
    offset: String(Math.max(0, offset)),
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/playlists/${encodeURIComponent(id)}/tracks?${qs.toString()}`
  return apiGet(url, { language })
}

export async function* iterateCatalogPlaylistTracks({
  storefront,
  id,
  language,
  pageSize,
}) {
  let offset = 0
  const limit = pageSize || PLAYLIST_TRACKS_PAGE_SIZE
  while (true) {
    const json = await fetchCatalogPlaylistTracksPage({
      storefront,
      id,
      language,
      offset,
      limit,
    })
    const data = json?.data || []
    for (const raw of data) yield raw
    const next = typeof json?.next === 'string' ? json.next : null
    if (!next || data.length === 0) return
    offset += data.length
  }
}

// A pre-release album lists every track, but only the ones already out have
// playParams; the rest cannot be played or downloaded until release day.
export function isReleasedTrack(raw) {
  return Boolean(raw?.attributes?.playParams)
}

export function formatReleaseDate(date) {
  if (!date) return null
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function normalizeAlbum(raw) {
  if (!raw) return null
  const a = raw.attributes || {}
  const artists = (raw.relationships?.artists?.data || []).map((x) => ({
    id: x.id,
    name: x.attributes?.name || a.artistName,
  }))
  const tracks = (raw.relationships?.tracks?.data || []).map((t) => {
    const ta = t.attributes || {}
    return {
      id: t.id,
      name: ta.name,
      trackNumber: ta.trackNumber,
      discNumber: ta.discNumber,
      durationMs: ta.durationInMillis,
      isrc: ta.isrc,
      artistName: ta.artistName,
      hasLossless: Boolean(ta.audioTraits?.includes?.('lossless')),
      hasHiRes: Boolean(ta.audioTraits?.includes?.('hi-res-lossless')),
      hasAtmos: Boolean(
        ta.audioTraits?.includes?.('atmos') ||
          ta.audioTraits?.includes?.('spatial'),
      ),
      isAppleDigitalMaster: Boolean(ta.isAppleDigitalMaster),
      released: isReleasedTrack(t),
    }
  })
  return {
    id: raw.id,
    type: raw.type,
    name: a.name,
    artistName: a.artistName,
    artistId: artists[0]?.id || null,
    artists,
    genreNames: a.genreNames || [],
    releaseDate: a.releaseDate,
    isPrerelease: Boolean(a.isPrerelease),
    year: a.releaseDate ? String(a.releaseDate).slice(0, 4) : null,
    trackCount: a.trackCount,
    isCompilation: a.isCompilation,
    isSingle: a.isSingle,
    recordLabel: a.recordLabel,
    copyright: a.copyright,
    upc: a.upc,
    url: a.url,
    contentRating: a.contentRating,
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    hasLossless: Boolean(a.audioTraits?.includes?.('lossless')),
    hasHiRes: Boolean(a.audioTraits?.includes?.('hi-res-lossless')),
    hasAtmos: Boolean(
      a.audioTraits?.includes?.('atmos') ||
        a.audioTraits?.includes?.('spatial'),
    ),
    // Apple Digital Master, still exposed under its old Mastered for iTunes name
    isAppleDigitalMaster: Boolean(a.isMasteredForItunes),
    tracks,
  }
}

export function normalizePlaylist(raw) {
  if (!raw) return null
  const a = raw.attributes || {}
  const curator = (raw.relationships?.curators?.data || [])[0]
  const tracks = (raw.relationships?.tracks?.data || []).map((t) => {
    const ta = t.attributes || {}
    const artistsRel = t.relationships?.artists?.data || []
    return {
      id: t.id,
      name: ta.name,
      trackNumber: ta.trackNumber,
      durationMs: ta.durationInMillis,
      isrc: ta.isrc,
      artistName: ta.artistName,
      artistId: artistsRel[0]?.id || null,
      albumName: ta.albumName,
      artworkTemplate: ta.artwork?.url || null,
      hasLossless: Boolean(ta.audioTraits?.includes?.('lossless')),
      hasHiRes: Boolean(ta.audioTraits?.includes?.('hi-res-lossless')),
      hasAtmos: Boolean(
        ta.audioTraits?.includes?.('atmos') ||
          ta.audioTraits?.includes?.('spatial'),
      ),
      isAppleDigitalMaster: Boolean(ta.isAppleDigitalMaster),
    }
  })
  return {
    id: raw.id,
    type: raw.type,
    name: a.name,
    description: a.description?.standard || '',
    curatorName: curator?.attributes?.name || a.curatorName || 'Apple Music',
    curatorId: curator?.id || null,
    trackCount: a.trackCount,
    url: a.url,
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    lastModifiedDate: a.lastModifiedDate,
    hasLossless: Boolean(a.audioTraits?.includes?.('lossless')),
    hasHiRes: Boolean(a.audioTraits?.includes?.('hi-res-lossless')),
    hasAtmos: Boolean(
      a.audioTraits?.includes?.('atmos') ||
        a.audioTraits?.includes?.('spatial'),
    ),
    tracks,
  }
}

export function artworkUrl(template, size = 600) {
  if (!template) return null
  return template.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg')
}
