import { getBearerToken, invalidateBearerCache } from './appleToken.mjs'
import { searchCatalog } from './appleApi.mjs'

const ME = 'https://amp-api.music.apple.com/v1/me'
const LIBRARY_PAGE_SIZE = 100

async function apiGet(url, { mediaUserToken, language = 'en-US' } = {}) {
  if (!mediaUserToken) {
    const err = new Error('media-user-token not configured')
    err.code = 'NO_MEDIA_USER_TOKEN'
    err.statusCode = 412
    throw err
  }
  let token = await getBearerToken()
  const run = async (t) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${t}`,
        'Music-User-Token': mediaUserToken,
        Origin: 'https://music.apple.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': language || 'en-US',
      },
    })
  let res = await run(token)
  if (res.status === 401) {
    invalidateBearerCache()
    token = await getBearerToken()
    res = await run(token)
  }
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '')
    const err = new Error(
      `Apple library ${res.status}: media-user-token rejected (${body.slice(0, 120)})`,
    )
    err.code = 'MEDIA_USER_TOKEN_REJECTED'
    err.statusCode = res.status
    throw err
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Apple library ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 200)}`,
    )
  }
  return res.json()
}

export async function getMyStorefront({ mediaUserToken, language } = {}) {
  const json = await apiGet(`${ME}/storefront`, { mediaUserToken, language })
  return json?.data?.[0]?.id || null
}

function buildLibraryUrl(kind, { offset = 0, limit = LIBRARY_PAGE_SIZE, language = 'en-US' } = {}) {
  const qs = new URLSearchParams({
    include: 'catalog',
    extend: 'playParams,catalogId',
    limit: String(Math.max(1, Math.min(limit, LIBRARY_PAGE_SIZE))),
    offset: String(Math.max(0, offset)),
    l: language,
  })
  if (kind === 'songs') {
    qs.set('include[library-songs]', 'catalog,albums')
    qs.set('include[songs]', 'albums')
  } else if (kind === 'albums') {
    qs.set('include[library-albums]', 'catalog')
  } else if (kind === 'playlists') {
    qs.set('include[library-playlists]', 'catalog')
  }
  return `${ME}/library/${kind}?${qs.toString()}`
}

const CATALOG_NUMERIC_RE = /^\d{6,15}$/
const CATALOG_PLAYLIST_RE = /^pl\.[A-Za-z0-9-]+$/
const LIBRARY_PREFIX_RE = /^[ilp]\./

export function isAppleCatalogId(id) {
  if (!id) return false
  const s = String(id)
  if (LIBRARY_PREFIX_RE.test(s)) return false
  return CATALOG_NUMERIC_RE.test(s) || CATALOG_PLAYLIST_RE.test(s)
}

function pickCatalogId(raw) {
  const pp = raw?.attributes?.playParams || {}
  if (pp.catalogId) return String(pp.catalogId)
  const rel = raw?.relationships?.catalog?.data
  if (Array.isArray(rel) && rel[0]?.id) return String(rel[0].id)
  if (pp.purchasedId && isAppleCatalogId(pp.purchasedId)) return String(pp.purchasedId)
  if (pp.id && isAppleCatalogId(pp.id)) return String(pp.id)
  return null
}

function pickCatalogPlaylistId(raw) {
  const rel = raw?.relationships?.catalog?.data
  if (Array.isArray(rel) && rel[0]?.id) return String(rel[0].id)
  const pp = raw?.attributes?.playParams || {}
  if (pp.globalId && CATALOG_PLAYLIST_RE.test(pp.globalId)) return String(pp.globalId)
  if (
    pp.id &&
    CATALOG_PLAYLIST_RE.test(pp.id) &&
    pp.isLibrary !== true &&
    raw?.attributes?.canEdit !== true
  ) {
    return String(pp.id)
  }
  return null
}

function relationId(raw, name) {
  const rel = raw?.relationships?.[name]?.data
  return Array.isArray(rel) && rel[0]?.id ? String(rel[0].id) : null
}

export function normalizeLibraryAlbum(raw) {
  if (!raw) return null
  const a = raw.attributes || {}
  const catalogId = pickCatalogId(raw)
  return {
    libraryId: raw.id,
    catalogId,
    name: a.name || 'Unknown album',
    artistName: a.artistName || 'Unknown artist',
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    trackCount: Number(a.trackCount || 0),
    dateAdded: a.dateAdded || null,
    downloadable: Boolean(catalogId),
  }
}

export function normalizeLibraryPlaylist(raw) {
  if (!raw) return null
  const a = raw.attributes || {}
  const catalogId = pickCatalogPlaylistId(raw)
  const isUserCreated = a.canEdit === true || a.playParams?.isLibrary === true && !catalogId
  return {
    libraryId: raw.id,
    catalogId,
    name: a.name || 'Untitled playlist',
    curatorName: a.curatorName || (isUserCreated ? 'You' : 'Apple Music'),
    description: a.description?.standard || '',
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    dateAdded: a.dateAdded || null,
    isUserCreated,
    downloadable: Boolean(catalogId),
  }
}

export function normalizeLibrarySong(raw, albumLookup) {
  if (!raw) return null
  const a = raw.attributes || {}
  const catalogId = pickCatalogId(raw)
  const catalogAlbumId =
    catalogId && albumLookup ? albumLookup.get(catalogId) || null : null
  return {
    libraryId: raw.id,
    catalogId,
    catalogAlbumId,
    name: a.name || 'Unknown song',
    artistName: a.artistName || 'Unknown artist',
    albumName: a.albumName || '',
    durationMs: Number(a.durationInMillis || 0),
    artworkTemplate: a.artwork?.url || null,
    contentRating: a.contentRating || null,
    downloadable: Boolean(catalogId),
  }
}

function buildSongAlbumLookup(included) {
  const map = new Map()
  if (!Array.isArray(included)) return map
  for (const entry of included) {
    if (entry?.type !== 'songs') continue
    const albumId = entry?.relationships?.albums?.data?.[0]?.id
    if (entry.id && albumId) map.set(String(entry.id), String(albumId))
  }
  return map
}

export async function fetchLibraryPage(
  kind,
  { mediaUserToken, language, offset, limit, storefront } = {},
) {
  if (!['albums', 'playlists', 'songs'].includes(kind)) {
    throw new Error(`unknown library kind: ${kind}`)
  }
  const url = buildLibraryUrl(kind, { offset, limit, language })
  const json = await apiGet(url, { mediaUserToken, language })
  const data = json?.data || []
  let items
  if (kind === 'albums') {
    items = data.map(normalizeLibraryAlbum).filter(Boolean)
  } else if (kind === 'playlists') {
    items = data.map(normalizeLibraryPlaylist).filter(Boolean)
  } else {
    const lookup = buildSongAlbumLookup(json?.included)
    items = data.map((raw) => normalizeLibrarySong(raw, lookup)).filter(Boolean)
  }
  items = await resolveMissingCatalogIds(kind, items, {
    storefront,
    language,
    mediaUserToken,
  })
  const next = typeof json?.next === 'string' ? json.next : null
  const total = typeof json?.meta?.total === 'number' ? json.meta.total : null
  return { items, next, total }
}

export async function* iterateLibrary(kind, { mediaUserToken, language, pageSize, storefront } = {}) {
  let offset = 0
  const limit = pageSize || LIBRARY_PAGE_SIZE
  while (true) {
    const page = await fetchLibraryPage(kind, {
      mediaUserToken,
      language,
      offset,
      limit,
      storefront,
    })
    for (const item of page.items) yield item
    if (!page.next || page.items.length === 0) return
    offset += page.items.length
    if (page.total !== null && offset >= page.total) return
  }
}

export function normalizeLibraryTrack(raw) {
  if (!raw) return null
  const a = raw.attributes || {}
  const catalogId = pickCatalogId(raw)
  return {
    id: catalogId || raw.id,
    libraryId: raw.id,
    type: raw.type || null,
    catalogId,
    name: a.name || 'Unknown song',
    artistName: a.artistName || 'Unknown artist',
    albumName: a.albumName || '',
    durationMs: Number(a.durationInMillis || 0),
    artworkTemplate: a.artwork?.url || null,
    artworkColor: a.artwork?.bgColor || null,
    contentRating: a.contentRating || null,
    hasLossless: Boolean(a.audioTraits?.includes?.('lossless')),
    hasHiRes: Boolean(a.audioTraits?.includes?.('hi-res-lossless')),
    hasAtmos: Boolean(
      a.audioTraits?.includes?.('atmos') || a.audioTraits?.includes?.('spatial'),
    ),
    downloadable: Boolean(catalogId),
  }
}

const CATALOG_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000
const CATALOG_RESOLVE_NEGATIVE_TTL_MS = 60 * 60 * 1000
const _resolveCache = new Map()

function makeResolveCacheKey(kind, item) {
  return `${kind}|${normalizeText(item.artistName)}|${normalizeText(item.name)}`
}

async function mapWithConcurrency(items, fn, concurrency = 5) {
  let i = 0
  async function worker() {
    while (true) {
      const idx = i
      i += 1
      if (idx >= items.length) return
      await fn(items[idx], idx)
    }
  }
  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
}

async function fetchCatalogMatch(
  kind,
  item,
  { storefront, language, mediaUserToken, searchResolver, timeoutMs = 3000 },
) {
  const term = `${item.artistName || ''} ${item.name || ''}`.trim()
  if (!term || !storefront) return null
  const types = kind === 'songs' ? 'songs' : 'albums'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let data = []
  try {
    const json = await searchResolver({
      storefront,
      term,
      types,
      limit: 10,
      language,
      mediaUserToken,
      signal: controller.signal,
    })
    data = json?.results?.[types]?.data || []
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
  const best = pickBestSearchMatch(kind, item, data)
  if (!best?.id) return null
  return {
    catalogId: String(best.id),
    albumId: kind === 'songs' ? relationId(best, 'albums') : null,
  }
}

function pickBestSearchMatch(kind, item, data) {
  let bestScore = -1
  let best = null
  for (const raw of data) {
    const score =
      kind === 'songs' ? scoreCatalogSong(item, raw) : scoreCatalogAlbum(item, raw)
    if (score > bestScore) {
      bestScore = score
      best = raw
    }
  }
  if (bestScore < 7) return null
  return best
}

export async function resolveMissingCatalogIds(
  kind,
  items,
  {
    storefront,
    language = 'en-US',
    mediaUserToken,
    searchResolver = searchCatalog,
    cache = _resolveCache,
    concurrency = 3,
  } = {},
) {
  if (!storefront || !Array.isArray(items) || items.length === 0) return items
  if (kind !== 'songs' && kind !== 'albums') return items
  const unresolved = items.filter(
    (item) => !item.catalogId && item.name && item.artistName,
  )
  if (unresolved.length === 0) return items
  const now = Date.now()
  await mapWithConcurrency(
    unresolved,
    async (item) => {
      const key = makeResolveCacheKey(kind, item)
      const cached = cache.get(key)
      let promise
      if (cached && cached.expiresAt > now) {
        promise = cached.promise
      } else {
        promise = fetchCatalogMatch(kind, item, {
          storefront,
          language,
          mediaUserToken,
          searchResolver,
        })
        cache.set(key, { promise, expiresAt: now + CATALOG_RESOLVE_TTL_MS })
      }
      const result = await promise
      if (!result) {
        const after = cache.get(key)
        if (after && after.promise === promise && !after.negative) {
          cache.set(key, {
            promise,
            expiresAt: Date.now() + CATALOG_RESOLVE_NEGATIVE_TTL_MS,
            negative: true,
          })
        }
        return
      }
      item.catalogId = result.catalogId
      if (kind === 'songs') {
        item.catalogAlbumId =
          result.albumId || item.catalogAlbumId || null
      }
      item.downloadable = true
    },
    concurrency,
  )
  return items
}

function scoreCatalogSong(item, raw) {
  const a = raw?.attributes || {}
  let score = 0
  if (nameMatchesLoose(item.name, a.name)) score += 4
  if (artistMatchesLoose(item.artistName, a.artistName)) score += 3
  if (sameText(item.albumName, a.albumName)) score += 2
  return score
}

function scoreCatalogAlbum(item, raw) {
  const a = raw?.attributes || {}
  let score = 0
  if (nameMatchesLoose(item.name, a.name)) score += 4
  if (artistMatchesLoose(item.artistName, a.artistName)) score += 3
  if (Number(item.trackCount || 0) === Number(a.trackCount || 0)) score += 1
  return score
}

function sameText(a, b) {
  const x = normalizeText(a)
  const y = normalizeText(b)
  return Boolean(x) && x === y
}

function nameMatchesLoose(itemName, appleName) {
  const x = normalizeText(itemName)
  const y = normalizeText(appleName)
  if (!x || !y) return false
  if (x === y) return true
  if (y.startsWith(x + ' ')) return true
  if (x.startsWith(y + ' ')) return true
  return false
}

function artistMatchesLoose(itemArtist, appleArtist) {
  const x = normalizeText(itemArtist)
  const y = normalizeText(appleArtist)
  if (!x || !y) return false
  if (x === y) return true
  const xt = x.split(' ').filter(Boolean)
  const yt = new Set(y.split(' ').filter(Boolean))
  if (xt.length === 0) return false
  return xt.every((t) => yt.has(t))
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export async function fetchLibraryPlaylist({ libraryId, mediaUserToken, language = 'en-US' }) {
  if (!libraryId) throw new Error('libraryId required')
  const qs = new URLSearchParams({
    include: 'catalog',
    extend: 'playParams',
    l: language,
  })
  const url = `${ME}/library/playlists/${encodeURIComponent(libraryId)}?${qs.toString()}`
  const json = await apiGet(url, { mediaUserToken, language })
  return json?.data?.[0] || null
}

export async function fetchLibraryPlaylistTracksPage({
  libraryId,
  mediaUserToken,
  language = 'en-US',
  offset = 0,
  limit = LIBRARY_PAGE_SIZE,
}) {
  if (!libraryId) throw new Error('libraryId required')
  const qs = new URLSearchParams({
    include: 'catalog',
    'include[library-songs]': 'catalog',
    extend: 'playParams,catalogId',
    limit: String(Math.max(1, Math.min(limit, LIBRARY_PAGE_SIZE))),
    offset: String(Math.max(0, offset)),
    l: language,
  })
  const url = `${ME}/library/playlists/${encodeURIComponent(libraryId)}/tracks?${qs.toString()}`
  const json = await apiGet(url, { mediaUserToken, language })
  const data = json?.data || []
  return {
    items: data.map(normalizeLibraryTrack).filter(Boolean),
    next: typeof json?.next === 'string' ? json.next : null,
  }
}

export async function* iterateLibraryPlaylistTracks({
  libraryId,
  mediaUserToken,
  language,
  pageSize,
}) {
  let offset = 0
  const limit = pageSize || LIBRARY_PAGE_SIZE
  while (true) {
    const page = await fetchLibraryPlaylistTracksPage({
      libraryId,
      mediaUserToken,
      language,
      offset,
      limit,
    })
    for (const item of page.items) yield item
    if (!page.next || page.items.length === 0) return
    offset += page.items.length
  }
}

export async function getLibraryPlaylistDetail({ libraryId, mediaUserToken, language }) {
  const raw = await fetchLibraryPlaylist({ libraryId, mediaUserToken, language })
  if (!raw) return null
  const head = normalizeLibraryPlaylist(raw)
  const tracks = []
  for await (const track of iterateLibraryPlaylistTracks({
    libraryId,
    mediaUserToken,
    language,
  })) {
    tracks.push(track)
  }
  const undownloadableCount = tracks.filter((t) => !t.downloadable).length
  return {
    libraryId,
    catalogId: head?.catalogId || null,
    name: head?.name || 'Untitled playlist',
    curatorName: head?.curatorName || (head?.isUserCreated ? 'You' : 'Apple Music'),
    description: head?.description || '',
    artworkTemplate: head?.artworkTemplate || null,
    artworkColor: head?.artworkColor || null,
    isUserCreated: Boolean(head?.isUserCreated),
    trackCount: tracks.length,
    tracks,
    hasLossless: tracks.some((t) => t.hasLossless),
    hasHiRes: tracks.some((t) => t.hasHiRes),
    hasAtmos: tracks.some((t) => t.hasAtmos),
    undownloadableCount,
    downloadable: tracks.some((t) => t.downloadable),
  }
}

export const __test__ = {
  pickCatalogId,
  pickCatalogPlaylistId,
  buildLibraryUrl,
  resolveMissingCatalogIds,
  LIBRARY_PAGE_SIZE,
}
