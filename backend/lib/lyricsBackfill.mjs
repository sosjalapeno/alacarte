import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'
import { readAudioIdentityTags } from './audioTags.mjs'
import { readAppleCreds, readSettings } from './settingsStore.mjs'
import { getSongLyricsTtml, getSongsByIsrc } from './appleApi.mjs'
import { triggerNavidromeScan } from './navidromeApi.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const ISRC_BATCH = 25
const REQUEST_DELAY_MS = 250
const PROGRESS_MIN_INTERVAL_MS = 400

// Fetches lyrics for library tracks that have no .lrc/.ttml sidecar, e.g.
// ones downloaded before a media-user-token was set. Same start/status/stop
// shape as the tag backfill.
const state = {
  running: false,
  scanned: 0,
  total: 0,
  added: 0,
  converted: 0, // written from an existing .ttml, no Apple call
  skipped: 0,
  noLyrics: 0,
  noMatch: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  stopRequested: false,
  error: null,
}

const defaultDeps = {
  getSongsByIsrc,
  getSongLyricsTtml,
  readSettings,
  readAppleCreds,
  triggerNavidromeScan,
  delayMs: REQUEST_DELAY_MS,
  now: () => Date.now(),
}

let lastEmitAt = 0

function status() {
  const { running, scanned, total, added, converted, skipped, noLyrics, noMatch, failed, current, startedAt, finishedAt, stopRequested, error } = state
  return { running, scanned, total, added, converted, skipped, noLyrics, noMatch, failed, current, startedAt, finishedAt, stopRequested, error }
}

export function getLyricsBackfillStatus() {
  return status()
}

export function stopLyricsBackfill() {
  if (!state.running) return { ok: false, running: false }
  state.stopRequested = true
  emit(true)
  return { ok: true, running: true }
}

function emit(force = false) {
  const now = Date.now()
  if (!force && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) return
  lastEmitAt = now
  emitEvent('lyrics.backfill.progress', { ...status(), done: !state.running })
}

function parseTtmlTime(value) {
  if (!value) return null
  const parts = String(value).replace(/s$/, '').split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Same line format amdp writes: [mm:ss.cc]text, one line per <p>. Unsynced
// lyrics come out as plain lines.
export function ttmlToLrc(ttml) {
  const synced = !/itunes:timing="None"/.test(ttml)
  const out = []
  for (const m of String(ttml).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    const begin = parseTtmlTime(/\bbegin="([^"]+)"/.exec(m[1])?.[1])
    if (!synced || begin == null) {
      out.push(text)
      continue
    }
    const cs = Math.floor(begin * 100)
    const mm = String(Math.floor(cs / 6000)).padStart(2, '0')
    const ss = String(Math.floor((cs % 6000) / 100)).padStart(2, '0')
    out.push(`[${mm}:${ss}.${String(cs % 100).padStart(2, '0')}]${text}`)
  }
  return out.length ? `${out.join('\n')}\n` : null
}

async function exists(p) {
  return fsp.stat(p).then(() => true, () => false)
}

async function collectAudio(dir, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectAudio(abs, out)
    else if (/\.(flac|m4a)$/i.test(entry.name)) out.push(abs)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function wantedFormats(setting) {
  if (setting === 'both') return ['lrc', 'ttml']
  return setting === 'ttml' ? ['ttml'] : ['lrc']
}

// Writes a sidecar only if there is none yet. True when it was written.
async function writeNew(file, body) {
  try {
    await fsp.writeFile(file, body, { flag: 'wx' })
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

async function runBackfill(deps) {
  try {
    const settings = await deps.readSettings()
    const { mediaUserToken } = await deps.readAppleCreds()
    const storefront = settings.storefront || 'us'
    const language = settings.language || 'en-US'
    const wanted = wantedFormats(settings.lyricsFormat)

    const files = []
    await collectAudio(MUSIC_ROOT, files)
    state.total = files.length
    emit(true)

    const pending = []
    for (const file of files) {
      const stem = file.slice(0, -path.extname(file).length)
      const have = { lrc: await exists(`${stem}.lrc`), ttml: await exists(`${stem}.ttml`) }
      let missing = wanted.filter((f) => !have[f])
      if (missing.length === 0) {
        state.scanned += 1
        state.skipped += 1
        continue
      }
      if (missing.includes('lrc') && have.ttml) {
        // Convert what is already on disk; no Apple call needed.
        const lrc = ttmlToLrc(await fsp.readFile(`${stem}.ttml`, 'utf8').catch(() => ''))
        if (lrc && (await writeNew(`${stem}.lrc`, lrc))) {
          state.converted += 1
          missing = missing.filter((f) => f !== 'lrc')
        }
      }
      if (missing.length === 0) {
        state.scanned += 1
        emit()
        continue
      }
      const { isrc } = await readAudioIdentityTags(file)
      if (!isrc) {
        state.scanned += 1
        state.noMatch += 1
        continue
      }
      pending.push({ file, stem, isrc, missing })
    }
    emit(true)

    for (let i = 0; i < pending.length && !state.stopRequested; i += ISRC_BATCH) {
      const batch = pending.slice(i, i + ISRC_BATCH)
      const songsByIsrc = new Map()
      try {
        const json = await deps.getSongsByIsrc({
          storefront,
          isrcs: [...new Set(batch.map((b) => b.isrc))],
          language,
        })
        for (const song of json?.data || []) {
          const isrc = song.attributes?.isrc?.toUpperCase()
          if (!isrc) continue
          const prev = songsByIsrc.get(isrc)
          if (!prev || (!prev.attributes?.hasLyrics && song.attributes?.hasLyrics)) {
            songsByIsrc.set(isrc, song)
          }
        }
      } catch (err) {
        state.failed += batch.length
        state.scanned += batch.length
        state.error = err.message || 'lookup failed'
        emit()
        continue
      }
      await sleep(deps.delayMs)

      for (const item of batch) {
        if (state.stopRequested) break
        state.current = path.relative(MUSIC_ROOT, item.file)
        state.scanned += 1
        const song = songsByIsrc.get(item.isrc)
        if (!song) {
          state.noMatch += 1
          emit()
          continue
        }
        if (!song.attributes?.hasLyrics) {
          state.noLyrics += 1
          emit()
          continue
        }
        try {
          const ttml = await deps.getSongLyricsTtml({ storefront, id: song.id, language, mediaUserToken })
          let wrote = false
          for (const format of item.missing) {
            const body = ttml && (format === 'ttml' ? ttml : ttmlToLrc(ttml))
            if (body && (await writeNew(`${item.stem}.${format}`, body))) wrote = true
          }
          if (wrote) state.added += 1
          else state.noLyrics += 1
        } catch (err) {
          state.failed += 1
          state.error = err.message || 'lyrics fetch failed'
        }
        emit()
        await sleep(deps.delayMs)
      }
    }
  } catch (err) {
    state.error = err.message || 'lyrics backfill failed'
  } finally {
    state.running = false
    state.current = null
    state.finishedAt = deps.now()
    if (state.added + state.converted > 0) deps.triggerNavidromeScan().catch(() => {})
    emit(true)
  }
}

export async function startLyricsBackfill({ deps = defaultDeps } = {}) {
  if (state.running) {
    const err = new Error('a lyrics backfill is already running')
    err.statusCode = 409
    throw err
  }
  const { mediaUserToken } = await deps.readAppleCreds()
  if (!mediaUserToken) {
    const err = new Error('media-user-token not configured')
    err.statusCode = 412
    throw err
  }
  Object.assign(state, {
    running: true,
    scanned: 0,
    total: 0,
    added: 0,
    converted: 0,
    skipped: 0,
    noLyrics: 0,
    noMatch: 0,
    failed: 0,
    current: null,
    startedAt: deps.now(),
    finishedAt: null,
    stopRequested: false,
    error: null,
  })
  emit(true)
  runBackfill(deps)
  return status()
}
