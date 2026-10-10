import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'
import { normalizeIsrc, normalizeUpc, readFlacComments, writeFlacComments } from './audioTags.mjs'
import { readSettings } from './settingsStore.mjs'
import { getAlbumsByUpc, getSongsByIsrc } from './appleApi.mjs'
import { triggerNavidromeScan } from './navidromeApi.mjs'
import { withAppleRetry } from './appleWait.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const BATCH = 25
const REQUEST_DELAY_MS = 250
const PROGRESS_MIN_INTERVAL_MS = 400

// amdp tags a multi-artist song with one display string ("A & B"), which
// Navidrome turns into a fake combined artist. Apple lists each artist and
// composer separately, so those names go into repeated ARTISTS / COMPOSER /
// ALBUMARTISTS (and PERFORMER) fields; ARTIST and ALBUMARTIST keep the
// display string. Changing that display string would give albums and their
// tracks new navidrome ids (dropping plays and stars), so it is never touched.

const defaultDeps = {
  getSongsByIsrc,
  getAlbumsByUpc,
  readSettings,
  triggerNavidromeScan,
  delayMs: REQUEST_DELAY_MS,
  now: () => Date.now(),
}

const sleep = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

const names = (rel) => (rel?.data || []).map((a) => a.attributes?.name?.trim()).filter(Boolean)

function sameList(a = [], b = []) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// Only fields with more than one name are written; a single name already
// links fine through ARTIST / COMPOSER / ALBUMARTIST.
export function creditFields(current, { artists, composers, albumArtists }) {
  const fields = {}
  if (artists?.length > 1 && !sameList(current.ARTISTS, artists)) fields.ARTISTS = artists
  // amdp also copies the display string into PERFORMER; real performer
  // credits look different and are left alone.
  const display = current.ARTIST?.[0]
  if (artists?.length > 1 && display && sameList(current.PERFORMER, [display])) fields.PERFORMER = artists
  if (composers?.length > 1 && !sameList(current.COMPOSER, composers)) fields.COMPOSER = composers
  if (albumArtists?.length > 1 && !sameList(current.ALBUMARTISTS, albumArtists)) {
    fields.ALBUMARTISTS = albumArtists
  }
  return fields
}

async function lookupBatch(items, { storefront, language, deps, retry = (fn) => fn() }) {
  const isrcs = [...new Set(items.map((i) => i.isrc).filter(Boolean))]
  const upcs = [...new Set(items.map((i) => i.upc).filter(Boolean))]
  const songs = new Map()
  const albums = new Map()
  if (isrcs.length) {
    const json = await retry(() => deps.getSongsByIsrc({ storefront, isrcs, language, include: 'artists,composers' }))
    for (const s of json?.data || []) {
      const isrc = normalizeIsrc(s.attributes?.isrc)
      if (isrc && !songs.has(isrc)) {
        songs.set(isrc, { artists: names(s.relationships?.artists), composers: names(s.relationships?.composers) })
      }
    }
    await sleep(deps.delayMs)
  }
  if (upcs.length) {
    const json = await retry(() => deps.getAlbumsByUpc({ storefront, upcs, language, include: 'artists' }))
    for (const a of json?.data || []) {
      const upc = normalizeUpc(a.attributes?.upc)
      if (upc && !albums.has(upc)) albums.set(upc, names(a.relationships?.artists))
    }
    await sleep(deps.delayMs)
  }
  return { songs, albums }
}

async function collectFlacs(target, out) {
  const stat = await fsp.stat(target).catch(() => null)
  if (!stat) return
  if (stat.isFile()) {
    if (/\.flac$/i.test(target)) out.push(target)
    return
  }
  const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    await collectFlacs(path.join(target, e.name), out)
  }
}

/**
 * Writes per-artist credits into the given FLAC files (or folders of them).
 * onFile(result) is called per file with one of: updated, unchanged,
 * noMatch, failed. Never throws for a single file.
 */
export async function creditArtists(
  targets,
  { deps = defaultDeps, shouldStop = () => false, onFile = () => {}, onWait = null, albumArtists: withAlbumArtists = true } = {},
) {
  const settings = await deps.readSettings()
  const storefront = settings.storefront || 'us'
  const language = settings.language || 'en-US'
  const files = []
  for (const t of targets) await collectFlacs(t, files)

  const items = []
  for (const file of files) {
    const current = await readFlacComments(file)
    if (!current) {
      onFile({ file, result: 'failed' })
      continue
    }
    const isrc = normalizeIsrc(current.ISRC?.[0])
    const upc = withAlbumArtists ? normalizeUpc(current.BARCODE?.[0] || current.UPC?.[0]) : ''
    if (!isrc && !upc) {
      onFile({ file, result: 'noMatch' })
      continue
    }
    items.push({ file, current, isrc, upc })
  }

  for (let i = 0; i < items.length && !shouldStop(); i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    let found
    try {
      // Only long-running backfills (onWait given) wait out a rate limit; the
      // download hook stays fail-soft so a finished job is never held up.
      const retry = onWait ? (fn) => withAppleRetry(fn, { shouldStop, onWait }) : undefined
      found = await lookupBatch(batch, { storefront, language, deps, retry })
    } catch (err) {
      for (const item of batch) onFile({ file: item.file, result: 'failed', error: err.message })
      continue
    }
    for (const item of batch) {
      const song = found.songs.get(item.isrc)
      const albumArtists = found.albums.get(item.upc)
      if (!song && !albumArtists) {
        onFile({ file: item.file, result: 'noMatch' })
        continue
      }
      const fields = creditFields(item.current, { ...(song || {}), albumArtists })
      if (Object.keys(fields).length === 0) {
        onFile({ file: item.file, result: 'unchanged' })
        continue
      }
      const ok = await writeFlacComments(item.file, fields)
      onFile({ file: item.file, result: ok ? 'updated' : 'failed' })
    }
  }
  return files.length
}

// Download hook: fail-soft, a credit lookup must never fail a finished job.
export async function creditImportedFiles(targets) {
  try {
    await creditArtists(targets.filter(Boolean))
  } catch (err) {
    console.error('artist credits failed:', err.message)
  }
}

const state = {
  running: false,
  waitingUntil: null,
  scanned: 0,
  total: 0,
  updated: 0,
  skipped: 0,
  noMatch: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  stopRequested: false,
  error: null,
}

let lastEmitAt = 0

function status() {
  const { running, scanned, total, updated, skipped, noMatch, failed, current, startedAt, finishedAt, stopRequested, error, waitingUntil } = state
  return { running, scanned, total, updated, skipped, noMatch, failed, current, startedAt, finishedAt, stopRequested, error, waitingUntil }
}

function emit(force = false) {
  const now = Date.now()
  if (!force && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) return
  lastEmitAt = now
  emitEvent('artists.backfill.progress', { ...status(), done: !state.running })
}

export function getArtistBackfillStatus() {
  return status()
}

export function stopArtistBackfill() {
  if (!state.running) return { ok: false, running: false }
  state.stopRequested = true
  emit(true)
  return { ok: true, running: true }
}

export async function startArtistBackfill({ deps = defaultDeps } = {}) {
  if (state.running) {
    const err = new Error('an artist backfill is already running')
    err.statusCode = 409
    throw err
  }
  Object.assign(state, {
    running: true,
    scanned: 0,
    total: 0,
    updated: 0,
    skipped: 0,
    noMatch: 0,
    failed: 0,
    current: null,
    startedAt: deps.now(),
    finishedAt: null,
    stopRequested: false,
    error: null,
    waitingUntil: null,
  })
  emit(true)
  const counters = { updated: 'updated', unchanged: 'skipped', noMatch: 'noMatch', failed: 'failed' }
  ;(async () => {
    try {
      const all = []
      await collectFlacs(MUSIC_ROOT, all)
      state.total = all.length
      emit(true)
      await creditArtists([MUSIC_ROOT], {
        deps,
        shouldStop: () => state.stopRequested,
        onWait: (until) => {
          state.waitingUntil = until
          emit(true)
        },
        onFile: ({ file, result, error }) => {
          state.scanned += 1
          state[counters[result]] += 1
          state.current = path.relative(MUSIC_ROOT, file)
          if (error) state.error = error
          emit()
        },
      })
    } catch (err) {
      state.error = err.message || 'artist backfill failed'
    } finally {
      state.running = false
      state.waitingUntil = null
      state.current = null
      state.finishedAt = deps.now()
      // a full scan so Navidrome drops the combined artists it built before
      if (state.updated > 0) deps.triggerNavidromeScan({ fullScan: true }).catch(() => {})
      emit(true)
    }
  })()
  return status()
}
