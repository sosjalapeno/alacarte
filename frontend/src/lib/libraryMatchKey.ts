/**
 * Frontend twin of backend/lib/libraryMatchKey.mjs.
 * Keep rules in sync: quotes, feat, product suffixes, (N), [E]/[C]/[M].
 */

const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

const QUOTE_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2032': "'",
  '\u2033': '"',
  '`': "'",
}

const TRAILING_FEAT_RE =
  /\s+[\(\[](?:feat\.|ft\.|featuring)[^\)\]]*[\)\]]\s*$/i
const DUPLICATE_COUNTER_RE = /\s+\((\d{1,2})\)\s*$/
const EXPLICIT_TAG_RE = /\s*\[[ECM]\]\s*$/i
const PRODUCT_TYPE_SUFFIX_RE =
  /\s+[\u2013\u2014\-]\s+(?:Single|EP|Remix|Soundtrack)\s*$/i
const YEAR_SUFFIX_RE = /\s*[([]\d{4}[)\]]\s*$/

export function sanitizeSegment(name: string | null | undefined): string {
  if (!name) return '_'
  return (
    String(name)
      .replace(BAD_CHARS, '_')
      .replace(/\.+$/g, '')
      .trim()
      .slice(0, 200) || '_'
  )
}

function mapQuotes(input: string): string {
  let out = ''
  for (const ch of input) {
    out += QUOTE_MAP[ch] ?? ch
  }
  return out
}

export function normalizeForMatchKey(name: string | null | undefined): string {
  if (!name) return ''
  let s = String(name).normalize('NFKC')
  s = mapQuotes(s)
  s = s.replace(/\s+/g, ' ').trim()

  while (true) {
    const next = s.replace(TRAILING_FEAT_RE, '').trim()
    if (next === s) break
    s = next
  }

  s = s.replace(DUPLICATE_COUNTER_RE, '').trim()
  s = s.replace(EXPLICIT_TAG_RE, '').trim()
  s = s.replace(PRODUCT_TYPE_SUFFIX_RE, '').trim()
  return s
}

export function stripTrailingYear(title: string | null | undefined): string {
  if (!title) return ''
  return String(title).replace(YEAR_SUFFIX_RE, '').trim()
}

export function makeAlbumMatchKey(
  artistName: string | null | undefined,
  albumName: string | null | undefined,
): string {
  const artistKey = sanitizeSegment(normalizeForMatchKey(artistName)).toLowerCase()
  const albumKey = sanitizeSegment(
    normalizeForMatchKey(stripTrailingYear(albumName)),
  ).toLowerCase()
  if (!artistKey || !albumKey || artistKey === '_' || albumKey === '_') return ''
  return `${artistKey}::${albumKey}`
}

export function makeSongMatchKey(
  artistName: string | null | undefined,
  songName: string | null | undefined,
): string {
  const artistKey = sanitizeSegment(normalizeForMatchKey(artistName)).toLowerCase()
  const songKey = sanitizeSegment(normalizeForMatchKey(songName)).toLowerCase()
  if (!artistKey || !songKey || artistKey === '_' || songKey === '_') return ''
  return `${artistKey}::${songKey}`
}

/**
 * Album presence fallback for multi-artist releases: the album part must
 * match exactly while the artist parts are token subsets of each other
 * ("denzel curry" vs "denzel curry & kenny beats"). Keys are
 * `<artist>::<album>`; ':' never survives sanitization, so '::' is safe
 * to split on.
 */
export function isAlbumKeyVariantMatch(
  existingKeys: string[],
  key: string,
): boolean {
  const sep = key.lastIndexOf('::')
  if (sep <= 0 || sep + 2 >= key.length) return false
  const artistKey = key.slice(0, sep)
  const albumKey = key.slice(sep + 2)
  const artistTokens = new Set(artistKey.split(' ').filter(Boolean))
  if (artistTokens.size === 0) return false
  for (const existing of existingKeys) {
    const existingSep = existing.lastIndexOf('::')
    if (existingSep <= 0 || existingSep + 2 >= existing.length) continue
    if (existing.slice(existingSep + 2) !== albumKey) continue
    const existingTokens = existing
      .slice(0, existingSep)
      .split(' ')
      .filter(Boolean)
    if (existingTokens.length === 0) continue
    const subset =
      existingTokens.every((t) => artistTokens.has(t)) ||
      [...artistTokens].every((t) => existingTokens.includes(t))
    if (subset) return true
  }
  return false
}
