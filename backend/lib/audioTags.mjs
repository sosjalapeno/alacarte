import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
 * Read ISRC / UPC / BARCODE from a FLAC Vorbis comment block or from the
 * iTunes freeform atoms amdp writes into .m4a files. Walks the FLAC
 * metadata block chain with seeks, so comment blocks after large PICTURE
 * blocks are found too (ffmpeg remuxes reorder blocks). Fail-soft.
 */
export async function readAudioIdentityTags(filePath) {
  const empty = { isrc: '', upc: '' }
  if (/\.m4a$/i.test(filePath)) return readMp4IdentityTags(filePath)
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

const MAX_MOOV_BYTES = 32 * 1024 * 1024

// Top-level boxes are walked with seeks so a moov after a large mdat is
// found without reading the audio.
async function readMp4IdentityTags(filePath) {
  const empty = { isrc: '', upc: '' }
  let fh
  try {
    fh = await fsp.open(filePath, 'r')
    const { size: fileSize } = await fh.stat()
    const header = Buffer.alloc(16)
    let offset = 0
    for (let guard = 0; guard < 64 && offset + 8 <= fileSize; guard += 1) {
      await fh.read(header, 0, 16, offset)
      let size = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerLen = 8
      if (size === 1) {
        size = Number(header.readBigUInt64BE(8))
        headerLen = 16
      } else if (size === 0) {
        size = fileSize - offset
      }
      if (size < headerLen) return empty
      if (type === 'moov') {
        if (size > MAX_MOOV_BYTES) return empty
        const moov = Buffer.alloc(size - headerLen)
        await fh.read(moov, 0, moov.length, offset + headerLen)
        return parseMp4MoovIdentity(moov)
      }
      offset += size
    }
    return empty
  } catch {
    return empty
  } finally {
    await fh?.close().catch(() => {})
  }
}

function* mp4Boxes(buf, start = 0, end = buf.length) {
  let o = start
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o)
    if (size < 8 || o + size > end) return
    yield { type: buf.toString('latin1', o + 4, o + 8), start: o + 8, end: o + size }
    o += size
  }
}

function findMp4Box(buf, start, end, type) {
  for (const box of mp4Boxes(buf, start, end)) if (box.type === type) return box
  return null
}

// moov > [udta >] meta (full box) > ilst > '----' { mean, name, data }
export function parseMp4MoovIdentity(moov) {
  const out = { isrc: '', upc: '' }
  const udta = findMp4Box(moov, 0, moov.length, 'udta')
  const meta =
    (udta && findMp4Box(moov, udta.start, udta.end, 'meta')) ||
    findMp4Box(moov, 0, moov.length, 'meta')
  if (!meta) return out
  const ilst = findMp4Box(moov, meta.start + 4, meta.end, 'ilst')
  if (!ilst) return out
  for (const item of mp4Boxes(moov, ilst.start, ilst.end)) {
    if (item.type !== '----') continue
    let name = ''
    let value = ''
    for (const child of mp4Boxes(moov, item.start, item.end)) {
      if (child.type === 'name') name = moov.toString('utf8', child.start + 4, child.end)
      if (child.type === 'data') value = moov.toString('utf8', child.start + 8, child.end)
    }
    const key = name.trim().toUpperCase()
    if (key === 'ISRC' && !out.isrc) out.isrc = normalizeIsrc(value)
    if ((key === 'UPC' || key === 'BARCODE') && !out.upc) out.upc = normalizeUpc(value)
  }
  return out
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
// Writes to one file run one after another: downloads and the tag backfill
// both stamp files, and a stamp remuxes through a fixed temp file name.
const stampQueues = new Map()

export function writeAudioIdentityTags(filePath, tags = {}) {
  const key = path.resolve(filePath)
  const previous = stampQueues.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(() => stampIdentityTags(filePath, tags))
  stampQueues.set(key, run)
  const release = () => {
    if (stampQueues.get(key) === run) stampQueues.delete(key)
  }
  run.then(release, release)
  return run
}

async function stampIdentityTags(filePath, { isrc, upc } = {}) {
  if (!/\.flac$/i.test(filePath)) return false
  const isrcNorm = normalizeIsrc(isrc)
  const upcNorm = normalizeUpc(upc)
  if (!isrcNorm && !upcNorm) return false
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.stamp-tmp.flac`,
  )
  const args = ['-y', '-nostdin', '-v', 'error', '-i', filePath, '-map_metadata', '0', '-c', 'copy']
  if (isrcNorm) args.push('-metadata', `ISRC=${isrcNorm}`)
  if (upcNorm) args.push('-metadata', `BARCODE=${upcNorm}`)
  args.push(tmp)
  try {
    await execFileAsync('ffmpeg', args, { timeout: 60_000 })
    await fsp.rename(tmp, filePath)
    return true
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/**
 * Read artist / album / title / album_artist / track / isrc tags via ffprobe.
 * Fail-soft. Vorbis comment keys come back in varying cases, so lookup is
 * caseless.
 */
export async function readAudioMetaTags(filePath) {
  const empty = { artist: null, album: null, title: null, albumArtist: null, track: null, isrc: null }
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format_tags=artist,album,title,album_artist,track,isrc',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 10_000 },
    )
    const raw = JSON.parse(stdout)?.format?.tags || {}
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
      track: clean(tags.track),
      isrc: clean(tags.isrc),
    }
  } catch {
    return empty
  }
}
