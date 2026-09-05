const APPLE_HOSTS = new Set([
  'music.apple.com',
  'geo.music.apple.com',
  'itunes.apple.com',
])

const STOREFRONT_RE = /^[a-z]{2}$/i
const NUMERIC_ID_RE = /^\d+$/
const PLAYLIST_ID_RE = /^pl\.[A-Za-z0-9._-]+$/
const ITUNES_ID_RE = /^id(\d+)$/i

const UNSUPPORTED_KINDS = new Set([
  'library',
  'station',
  'stations',
  'music-video',
  'music-videos',
  'radio',
  'curator',
  'activity',
  'room',
])

function stripWrappingQuotes(value) {
  const trimmed = String(value || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function coerceUrl(input) {
  const text = stripWrappingQuotes(input)
  if (!text) return null
  try {
    return new URL(text)
  } catch {
    /* fall through */
  }
  if (/^(music\.apple\.com|geo\.music\.apple\.com|itunes\.apple\.com)\b/i.test(text)) {
    try {
      return new URL(`https://${text}`)
    } catch {
      return null
    }
  }
  return null
}

function normalizeId(raw) {
  if (!raw) return null
  const itunes = raw.match(ITUNES_ID_RE)
  if (itunes) return itunes[1]
  if (NUMERIC_ID_RE.test(raw) || PLAYLIST_ID_RE.test(raw)) return raw
  return null
}

function pathParts(pathname) {
  return String(pathname || '')
    .split('/')
    .map((p) => decodeURIComponent(p))
    .filter(Boolean)
}

function withStorefront(result, storefront) {
  if (storefront) result.storefront = storefront
  return result
}

/**
 * @param {string} input
 * @returns {null | { unsupported: true, message: string } | {
 *   kind: 'album' | 'song' | 'artist' | 'playlist',
 *   id: string,
 *   albumId?: string,
 *   storefront?: string,
 * }}
 */
export function parseAppleMusicUrl(input) {
  const url = coerceUrl(input)
  if (!url) return null

  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  if (!APPLE_HOSTS.has(host)) return null

  const parts = pathParts(url.pathname)
  if (parts.length === 0) {
    return {
      unsupported: true,
      message: 'That Apple Music link is not a catalog album, artist, song, or playlist.',
    }
  }

  let storefront = null
  let kindIndex = 0
  if (STOREFRONT_RE.test(parts[0]) && parts.length > 1) {
    storefront = parts[0].toLowerCase()
    kindIndex = 1
  }

  const kind = String(parts[kindIndex] || '').toLowerCase()
  if (!kind) {
    return {
      unsupported: true,
      message: 'That Apple Music link is not a catalog album, artist, song, or playlist.',
    }
  }

  if (UNSUPPORTED_KINDS.has(kind) || kind === 'browse') {
    return {
      unsupported: true,
      message: 'That Apple Music link is not a catalog album, artist, song, or playlist.',
    }
  }

  const rest = parts.slice(kindIndex + 1)
  const songIdFromQuery = url.searchParams.get('i')

  if (kind === 'album') {
    let albumId = null
    if (rest.length === 1) albumId = normalizeId(rest[0])
    else if (rest.length >= 2) albumId = normalizeId(rest[rest.length - 1])
    if (!albumId) {
      return {
        unsupported: true,
        message: 'That Apple Music album link is missing a catalog id.',
      }
    }
    if (songIdFromQuery && NUMERIC_ID_RE.test(songIdFromQuery)) {
      return withStorefront(
        {
          kind: 'song',
          id: songIdFromQuery,
          albumId,
        },
        storefront,
      )
    }
    return withStorefront({ kind: 'album', id: albumId }, storefront)
  }

  if (kind === 'song') {
    let songId = null
    if (rest.length === 1) songId = normalizeId(rest[0])
    else if (rest.length >= 2) songId = normalizeId(rest[rest.length - 1])
    if (!songId) {
      return {
        unsupported: true,
        message: 'That Apple Music song link is missing a catalog id.',
      }
    }
    return withStorefront({ kind: 'song', id: songId }, storefront)
  }

  if (kind === 'artist') {
    let artistId = null
    if (rest.length === 1) artistId = normalizeId(rest[0])
    else if (rest.length >= 2) artistId = normalizeId(rest[rest.length - 1])
    if (!artistId) {
      return {
        unsupported: true,
        message: 'That Apple Music artist link is missing a catalog id.',
      }
    }
    return withStorefront({ kind: 'artist', id: artistId }, storefront)
  }

  if (kind === 'playlist') {
    let playlistId = null
    if (rest.length === 1) playlistId = normalizeId(rest[0])
    else if (rest.length >= 2) playlistId = normalizeId(rest[rest.length - 1])
    if (!playlistId) {
      return {
        unsupported: true,
        message: 'That Apple Music playlist link is missing a catalog id.',
      }
    }
    return withStorefront({ kind: 'playlist', id: playlistId }, storefront)
  }

  return {
    unsupported: true,
    message: 'That Apple Music link is not a catalog album, artist, song, or playlist.',
  }
}
