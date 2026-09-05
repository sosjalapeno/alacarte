/**
 * Shared library presence / Qobuz write-path title normalizer.
 * Match keys always run through normalizeForMatchKey; write-time renaming
 * only applies when namingConvention === 'qobuz'.
 */

const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

const QUOTE_MAP = new Map([
  ['\u2018', "'"], // ‘
  ['\u2019', "'"], // ’
  ['\u201C', '"'], // “
  ['\u201D', '"'], // ”
  ['\u2032', "'"], // ′
  ['\u2033', '"'], // ″
  ['`', "'"],
])

// Trailing feat / ft / featuring in () or []
const TRAILING_FEAT_RE =
  /\s+[\(\[](?:feat\.|ft\.|featuring)[^\)\]]*[\)\]]\s*$/i

// Octo ResolveUniquePath duplicate: "Title (2)" — 1–2 digits only so years survive
const DUPLICATE_COUNTER_RE = /\s+\((\d{1,2})\)\s*$/

// amdp choice tags on filenames
const EXPLICIT_TAG_RE = /\s*\[[ECM]\]\s*$/i

// Apple product-type album suffixes (hyphen, en-dash, or em-dash)
const PRODUCT_TYPE_SUFFIX_RE =
  /\s+[\u2013\u2014\-]\s+(?:Single|EP|Remix|Soundtrack)\s*$/i

const YEAR_SUFFIX_RE = /\s*[([]\d{4}[)\]]\s*$/

export function sanitizeSegment(name) {
  if (!name) return '_'
  return (
    String(name)
      .replace(BAD_CHARS, '_')
      .replace(/\.+$/g, '')
      .trim()
      .slice(0, 200) || '_'
  )
}

function mapQuotes(input) {
  let out = ''
  for (const ch of input) {
    out += QUOTE_MAP.get(ch) ?? ch
  }
  return out
}

/**
 * Normalize a title (album or song) for comparison / presence keys.
 * Does not strip deluxe, remaster, live, or version parentheticals.
 */
export function normalizeForMatchKey(name) {
  if (!name) return ''
  let s = String(name).normalize('NFKC')
  s = mapQuotes(s)
  s = s.replace(/\s+/g, ' ').trim()

  // Loop-strip trailing feat tags (Octo style)
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

export function stripTrailingYear(title) {
  if (!title) return ''
  return String(title).replace(YEAR_SUFFIX_RE, '').trim()
}

/**
 * Write-path Qobuz renaming: strip feat + product-type suffixes.
 * Does not NFKC/quote-normalize the display name beyond those strips.
 */
export function applyQobuzWriteNaming(name) {
  if (!name) return name
  let s = String(name)
  s = s.replace(/\s+[\(\[](?:feat\.|ft\.|featuring)[^\)\]]*[\)\]]/gi, '').trim()
  s = s.replace(PRODUCT_TYPE_SUFFIX_RE, '').trim()
  return s
}

export function makeAlbumMatchKey(artistName, albumName) {
  const artistKey = sanitizeSegment(normalizeForMatchKey(artistName)).toLowerCase()
  const albumKey = sanitizeSegment(
    normalizeForMatchKey(stripTrailingYear(albumName)),
  ).toLowerCase()
  if (!artistKey || !albumKey || artistKey === '_' || albumKey === '_') return ''
  return `${artistKey}::${albumKey}`
}

export function makeSongMatchKey(artistName, songName) {
  const artistKey = sanitizeSegment(normalizeForMatchKey(artistName)).toLowerCase()
  const songKey = sanitizeSegment(normalizeForMatchKey(songName)).toLowerCase()
  if (!artistKey || !songKey || artistKey === '_' || songKey === '_') return ''
  return `${artistKey}::${songKey}`
}
