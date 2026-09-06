import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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
 * Read ISRC / UPC / BARCODE from a FLAC Vorbis comment block. Walks the
 * metadata block chain with seeks, so comment blocks after large PICTURE
 * blocks are found too (ffmpeg remuxes reorder blocks). Fail-soft.
 */
export async function readAudioIdentityTags(filePath) {
  const empty = { isrc: '', upc: '' }
  try {
    if (!/\.flac$/i.test(filePath)) return empty
    const fh = await fsp.open(filePath, 'r')
    try {
      const magic = Buffer.alloc(4)
      const { bytesRead: magicRead } = await fh.read(magic, 0, 4, 0)
      if (magicRead < 4 || magic.toString('ascii', 0, 4) !== 'fLaC') {
        return empty
      }
      let offset = 4
      for (let guard = 0; guard < 128; guard += 1) {
        const header = Buffer.alloc(4)
        const { bytesRead } = await fh.read(header, 0, 4, offset)
        if (bytesRead < 4) return empty
        const word = header.readUInt32BE(0)
        const isLast = (word & 0x80000000) !== 0
        const type = (word >>> 24) & 0x7f
        const length = word & 0xffffff
        offset += 4
        if (type === 4) {
          const block = Buffer.alloc(Math.min(length, 1024 * 1024))
          const { bytesRead: blockRead } = await fh.read(
            block,
            0,
            block.length,
            offset,
          )
          if (blockRead < Math.min(length, block.length)) return empty
          return extractVorbisIdentity(block.subarray(0, blockRead))
        }
        offset += length
        if (isLast) return empty
      }
      return empty
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

/** Sync walker mirroring readAudioIdentityTags for scripts and tests. */
export function readAudioIdentityTagsSync(filePath) {
  const empty = { isrc: '', upc: '' }
  try {
    if (!/\.flac$/i.test(filePath)) return empty
    const fd = fs.openSync(filePath, 'r')
    try {
      const magic = Buffer.alloc(4)
      if (fs.readSync(fd, magic, 0, 4, 0) < 4) return empty
      if (magic.toString('ascii', 0, 4) !== 'fLaC') return empty
      let offset = 4
      for (let guard = 0; guard < 128; guard += 1) {
        const header = Buffer.alloc(4)
        if (fs.readSync(fd, header, 0, 4, offset) < 4) return empty
        const word = header.readUInt32BE(0)
        const isLast = (word & 0x80000000) !== 0
        const type = (word >>> 24) & 0x7f
        const length = word & 0xffffff
        offset += 4
        if (type === 4) {
          const block = Buffer.alloc(Math.min(length, 1024 * 1024))
          const blockRead = fs.readSync(fd, block, 0, block.length, offset)
          if (blockRead < Math.min(length, block.length)) return empty
          return extractVorbisIdentity(block.subarray(0, blockRead))
        }
        offset += length
        if (isLast) return empty
      }
      return empty
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return empty
  }
}

/**
 * Write ISRC / BARCODE vorbis comments into a FLAC via an ffmpeg stream-copy
 * remux (lossless, keeps all existing metadata). Fail-soft: returns false on
 * any problem and never touches the original file on failure.
 */
export function writeAudioIdentityTags(filePath, { isrc, upc } = {}) {
  let tmp = null
  try {
    if (!/\.flac$/i.test(filePath)) return false
    const isrcNorm = normalizeIsrc(isrc)
    const upcNorm = normalizeUpc(upc)
    if (!isrcNorm && !upcNorm) return false
    tmp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.stamp-tmp.flac`,
    )
    const args = ['-y', '-nostdin', '-i', filePath, '-map_metadata', '0', '-c', 'copy']
    if (isrcNorm) args.push('-metadata', `ISRC=${isrcNorm}`)
    if (upcNorm) args.push('-metadata', `BARCODE=${upcNorm}`)
    args.push(tmp)
    const res = spawnSync('ffmpeg', args, {
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (res.status !== 0 || !fs.existsSync(tmp)) {
      fs.unlinkSync(tmp)
      return false
    }
    fs.renameSync(tmp, filePath)
    return true
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
    return false
  }
}

/**
 * Read artist / album / title / album_artist tags via ffprobe. Fail-soft.
 * Vorbis comment keys come back in varying cases, so lookup is caseless.
 */
export function readAudioMetaTags(filePath) {
  const empty = { artist: null, album: null, title: null, albumArtist: null }
  try {
    const res = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format_tags=artist,album,title,album_artist',
        '-of',
        'json',
        filePath,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    )
    if (res.status !== 0 || !res.stdout) return empty
    const raw = JSON.parse(res.stdout)?.format?.tags || {}
    const tags = {}
    for (const [key, value] of Object.entries(raw)) {
      tags[key.toLowerCase()] = value
    }
    const clean = (value) =>
      typeof value === 'string' && value.trim() ? value.trim() : null
    return {
      artist: clean(tags.artist),
      album: clean(tags.album),
      title: clean(tags.title),
      albumArtist: clean(tags.album_artist),
    }
  } catch {
    return empty
  }
}
