import fs from 'node:fs'
import fsp from 'node:fs/promises'

const HEADER_BYTES = 64 * 1024

/**
 * Normalize ISRC: uppercase, strip hyphens/spaces.
 */
export function normalizeIsrc(value) {
  if (!value) return ''
  return String(value).toUpperCase().replace(/[\s\-]/g, '')
}

/**
 * Normalize UPC/EAN/barcode to digits only.
 */
export function normalizeUpc(value) {
  if (!value) return ''
  return String(value).replace(/\D/g, '')
}

/**
 * Read ISRC / UPC / BARCODE from a FLAC Vorbis comment block.
 * Fail-soft: returns empty fields on any parse error.
 * Only inspects the first 64KB of the file.
 */
export async function readAudioIdentityTags(filePath) {
  const empty = { isrc: '', upc: '' }
  try {
    if (!/\.flac$/i.test(filePath)) return empty
    const fh = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(HEADER_BYTES)
      const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0)
      if (bytesRead < 8) return empty
      return parseFlacIdentityTags(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  } catch {
    return empty
  }
}

export function parseFlacIdentityTags(buf) {
  const empty = { isrc: '', upc: '' }
  if (!buf || buf.length < 8) return empty
  if (buf.toString('ascii', 0, 4) !== 'fLaC') return empty

  let offset = 4
  while (offset + 4 <= buf.length) {
    const header = buf.readUInt32BE(offset)
    const isLast = (header & 0x80000000) !== 0
    const type = (header >>> 24) & 0x7f
    const length = header & 0xffffff
    offset += 4
    if (offset + length > buf.length) break
    const block = buf.subarray(offset, offset + length)
    offset += length

    if (type === 4) {
      return extractVorbisIdentity(block)
    }
    if (isLast) break
  }
  return empty
}

function extractVorbisIdentity(block) {
  const empty = { isrc: '', upc: '' }
  try {
    if (block.length < 8) return empty
    let o = 0
    const vendorLen = block.readUInt32LE(o)
    o += 4
    if (o + vendorLen + 4 > block.length) return empty
    o += vendorLen
    const commentCount = block.readUInt32LE(o)
    o += 4

    let isrc = ''
    let upc = ''
    for (let i = 0; i < commentCount; i++) {
      if (o + 4 > block.length) break
      const len = block.readUInt32LE(o)
      o += 4
      if (o + len > block.length) break
      const raw = block.toString('utf8', o, o + len)
      o += len
      const eq = raw.indexOf('=')
      if (eq <= 0) continue
      const key = raw.slice(0, eq).toUpperCase()
      const val = raw.slice(eq + 1).trim()
      if (!val) continue
      if (key === 'ISRC' && !isrc) isrc = normalizeIsrc(val)
      else if ((key === 'UPC' || key === 'BARCODE') && !upc) upc = normalizeUpc(val)
    }
    return { isrc, upc }
  } catch {
    return empty
  }
}

/**
 * Build a minimal valid-ish FLAC header with STREAMINFO + VORBIS_COMMENT.
 * Enough for parseFlacIdentityTags; not a playable encode.
 */
export function buildMinimalFlacWithTags(tags = {}) {
  const streamInfo = Buffer.alloc(34, 0)
  // min/max block size
  streamInfo.writeUInt16BE(16, 0)
  streamInfo.writeUInt16BE(16, 2)

  const comments = []
  if (tags.isrc) comments.push(`ISRC=${tags.isrc}`)
  if (tags.upc) comments.push(`UPC=${tags.upc}`)
  if (tags.barcode) comments.push(`BARCODE=${tags.barcode}`)
  for (const [k, v] of Object.entries(tags.extra || {})) {
    comments.push(`${k}=${v}`)
  }

  const vendor = Buffer.from('alacarte', 'utf8')
  const commentParts = []
  for (const c of comments) {
    const body = Buffer.from(c, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32LE(body.length, 0)
    commentParts.push(len, body)
  }
  const vorbis = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(vendor.length, 0)
      return b
    })(),
    vendor,
    (() => {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(comments.length, 0)
      return b
    })(),
    ...commentParts,
  ])

  function metaHeader(type, length, isLast) {
    const h = Buffer.alloc(4)
    const lastBit = isLast ? 0x80 : 0x00
    h[0] = lastBit | (type & 0x7f)
    h[1] = (length >>> 16) & 0xff
    h[2] = (length >>> 8) & 0xff
    h[3] = length & 0xff
    return h
  }

  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    metaHeader(0, streamInfo.length, false),
    streamInfo,
    metaHeader(4, vorbis.length, true),
    vorbis,
  ])
}

/** Sync helper for tests that already hold a buffer path open via writeFile. */
export function readAudioIdentityTagsSync(filePath) {
  try {
    if (!/\.flac$/i.test(filePath)) return { isrc: '', upc: '' }
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(HEADER_BYTES)
      const bytesRead = fs.readSync(fd, buf, 0, HEADER_BYTES, 0)
      return parseFlacIdentityTags(buf.subarray(0, bytesRead))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { isrc: '', upc: '' }
  }
}
