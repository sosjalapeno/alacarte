import { getDb } from './db.mjs'

// Apple artist IDs by artist name, kept in library.db. One artist can be stored
// under several names (spellings, languages): every name that is looked up or seen
// in a search result gets its own row pointing at the same ID.

export const ARTIST_FOUND_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const ARTIST_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Letters and digits of any script, so CJK, Cyrillic etc. names have a key too.
export function normalizeArtistName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Fresh rows for a storefront as name key -> id (null = looked up, no match), or
// null when the database is unavailable.
export function readStoredArtistIds(storefront) {
  try {
    const now = Date.now()
    const out = new Map()
    const rows = getDb()
      .prepare('SELECT name_key, artist_id, resolved_at FROM artist_ids WHERE storefront = ?')
      .all(storefront)
    for (const row of rows) {
      const ttl = row.artist_id ? ARTIST_FOUND_TTL_MS : ARTIST_MISS_TTL_MS
      if (now - row.resolved_at < ttl) out.set(row.name_key, row.artist_id)
    }
    return out
  } catch (err) {
    console.error('artist id cache unavailable:', err.message)
    return null
  }
}

export function storeArtistId(storefront, key, artistId) {
  getDb()
    .prepare(
      `INSERT INTO artist_ids (storefront, name_key, artist_id, resolved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(storefront, name_key) DO UPDATE SET
         artist_id = excluded.artist_id, resolved_at = excluded.resolved_at`,
    )
    .run(storefront, key, artistId, Date.now())
}

// Free by-product of any Apple response that lists artists: remember each name that
// is unambiguous in that list and not already known. Never throws.
export function rememberArtistNames(storefront, artists) {
  try {
    const byKey = new Map()
    for (const a of artists || []) {
      const key = normalizeArtistName(a?.name)
      if (!key || !a?.id) continue
      const seen = byKey.get(key)
      byKey.set(key, seen && seen !== a.id ? null : String(a.id))
    }
    if (byKey.size === 0) return
    const known = readStoredArtistIds(storefront)
    if (!known) return
    for (const [key, id] of byKey) {
      if (id && !known.get(key)) storeArtistId(storefront, key, id)
    }
  } catch (err) {
    console.warn('[artist-ids] could not remember names:', err.message)
  }
}
