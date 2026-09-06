import { getBearerToken, invalidateBearerCache } from './appleToken.mjs'

const BASE = 'https://amp-api.music.apple.com/v1/catalog'

async function apiGet(url, { language = '', mediaUserToken, signal } = {}) {
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
    return fetch(url, { headers, signal })
  }
  let res = await run(token)
  if (res.status === 401 || res.status === 403) {
    invalidateBearerCache()
    token = await getBearerToken()
    res = await run(token)
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
}) {
  const qs = new URLSearchParams({
    term,
    types,
    include: 'artists',
    limit: String(limit),
    offset: String(offset),
    l: language,
  })
  const url = `${BASE}/${encodeURIComponent(storefront)}/search?${qs.toString()}`
  return apiGet(url, { language, mediaUserToken, signal })
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
