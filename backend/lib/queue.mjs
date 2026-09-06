import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { emitEvent } from './eventBus.mjs'
import { readSettings, readAppleCreds } from './settingsStore.mjs'
import {
  artworkUrl,
  getAlbum,
  getPlaylist,
  getSong,
  normalizeAlbum,
  normalizePlaylist,
} from './appleApi.mjs'
import { getLibraryPlaylistDetail } from './appleLibraryApi.mjs'
import { triggerNavidromeScan } from './navidromeApi.mjs'
import { writeAmdpConfig, spawnAmdp } from './amdpRunner.mjs'
import {
  convertDirToFlac,
  extractFolderArt,
} from './flacConvert.mjs'
import {
  applyNamingConvention,
  computeFinalDir,
  ensureDir,
  mergeMove,
  resolveArtistDir,
  sanitizeSegment,
} from './folderLayout.mjs'
import { getAlbumTrackPresence, hasSongInLibrary, invalidateLibraryCache, isPlaylistInLibrary, stripTrailingYear } from './libraryIndex.mjs'
import { writePlaylistM3U } from './playlistExport.mjs'
import { getDb } from './db.mjs'
import { probeWrapperPorts } from './wrapperHealth.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const STAGING_ROOT_OUTSIDE = '/tmp/alacarte-staging'
const STAGING_ROOT_INSIDE = path.join(MUSIC_ROOT, '.amdl-tmp')
const STAGING_MAX_AGE_HOURS = 24
const STAGING_MAX_AGE_MS = STAGING_MAX_AGE_HOURS * 60 * 60 * 1000
const JOB_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.ndjson')
const MAX_CONCURRENT = 1
const QUALITY_VALUES = new Set(['flac', 'alac', 'atmos', 'aac'])
const STALL_WARN_MS = Math.max(5_000, Number(process.env.AMDL_STALL_WARN_MS) || 60_000)
const STALL_TIMEOUT_MS = Math.max(
  STALL_WARN_MS + 5_000,
  Number(process.env.AMDL_STALL_TIMEOUT_MS) || 120_000,
)
const STALL_TICK_MS = 5_000
const FIRST_LINE_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.AMDL_FIRST_LINE_TIMEOUT_MS) || 30_000,
)
const MAX_DOWNLOAD_ERRORS = Math.max(
  1,
  Number(process.env.AMDL_MAX_DOWNLOAD_ERRORS) || 3,
)
const FATAL_DOWNLOAD_PATTERNS = [
  /invalid CKC/i,
  /CKC.*error/i,
  /failed to get CKC/i,
  /decryption failed/i,
  /decrypt.*error/i,
  /license.*error/i,
  /DRM.*error/i,
]

const state = {
  jobs: new Map(), // id -> job
  queue: [], // job ids
  active: new Set(),
  running: new Map(), // id -> abortController
}

function createProgressState(job, { convertEnabled }) {
  const knownTotal = Number(job?.stats?.total || 0)
  const fallbackTotal = job?.kind === 'song' ? 1 : 10
  const downloadTotal = knownTotal > 0 ? knownTotal : fallbackTotal
  return {
    downloadTotal,
    downloadDone: 0,
    downloadPartial: 0,
    convertEnabled: Boolean(convertEnabled),
    convertTotal: Boolean(convertEnabled) ? downloadTotal : 0,
    convertDone: 0,
    finalizeProgress: 0,
  }
}

function resolveStagingRoot(settings) {
  if (settings?.stagingInsideMusicLibrary) {
    return STAGING_ROOT_INSIDE
  }
  return STAGING_ROOT_OUTSIDE
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function computeProgressPercent(state) {
  const downloadDoneUnits = Math.min(
    state.downloadTotal,
    Math.max(0, state.downloadDone) +
      (state.downloadDone < state.downloadTotal
        ? clamp01(state.downloadPartial)
        : 0),
  )
  const convertDoneUnits = state.convertEnabled
    ? Math.min(state.convertTotal, Math.max(0, state.convertDone))
    : 0
  const finalizeDoneUnits = clamp01(state.finalizeProgress)
  const totalUnits = Math.max(
    1,
    state.downloadTotal + (state.convertEnabled ? state.convertTotal : 0) + 1,
  )
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        ((downloadDoneUnits + convertDoneUnits + finalizeDoneUnits) / totalUnits) *
          100,
      ),
    ),
  )
}

function applyProgress(job, progressState, patch = {}) {
  updateJob(job.id, {
    ...patch,
    progress: computeProgressPercent(progressState),
  })
}

function normalizeQuality(value, fallback = 'flac') {
  return QUALITY_VALUES.has(value) ? value : fallback
}

function setConversionEnabled(progressState, enabled) {
  progressState.convertEnabled = Boolean(enabled)
  progressState.convertTotal = enabled ? Math.max(1, progressState.downloadTotal) : 0
  progressState.convertDone = 0
}

export function listJobs() {
  const all = [...state.jobs.values()]
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return all
}

export function getJob(id) {
  return state.jobs.get(id) || null
}

function updateJob(id, patch) {
  const j = state.jobs.get(id)
  if (!j) return
  const statusChanged =
    patch.status !== undefined && patch.status !== j.status
  Object.assign(j, patch, { updatedAt: Date.now() })
  persistJob(j, statusChanged)
  emitEvent('job.update', jobPublic(j))
}

const PERSIST_MIN_INTERVAL_MS = 1_000
const PERSIST_JOB_CAP = 300
const lastPersistAt = new Map()

// Persist a job snapshot to SQLite. Progress-only updates are throttled;
// status changes (and new jobs) always write. Fail-soft: a DB problem must
// never break downloads.
function persistJob(job, force = false) {
  try {
    const now = Date.now()
    const last = lastPersistAt.get(job.id) || 0
    if (!force && now - last < PERSIST_MIN_INTERVAL_MS) return
    lastPersistAt.set(job.id, now)
    const db = getDb()
    db.prepare(
      `INSERT INTO queue_jobs (id, seq, status, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
    ).run(job.id, job.createdAt || 0, job.status, JSON.stringify(job), now)
    if (force && (job.status === 'done' || job.status === 'failed')) {
      db.prepare(
        `DELETE FROM queue_jobs WHERE id IN (
           SELECT id FROM queue_jobs ORDER BY seq DESC LIMIT -1 OFFSET ?
         )`,
      ).run(PERSIST_JOB_CAP)
    }
  } catch (err) {
    console.error('queue persist failed:', err.message)
  }
}

function makeAbortError() {
  const err = new Error('Cancelled')
  err.name = 'AbortError'
  return err
}

function throwIfCancelled(job) {
  if (job?.cancelled) throw makeAbortError()
}

function jobPublic(j) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: j.progress,
    albumId: j.albumId,
    songId: j.songId || null,
    followedPlaylistId: j.followedPlaylistId || null,
    playlistId: j.playlistId || null,
    libraryPlaylistId: j.libraryPlaylistId || null,
    albumTitle: j.albumTitle,
    artist: j.artist,
    artistId: j.artistId || null,
    artworkUrl: j.artworkUrl,
    currentTrack: j.currentTrack,
    message: j.message,
    error: j.error,
    cancelled: Boolean(j.cancelled),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    finalDir: j.finalDir,
    stats: j.stats,
  }
}

function alreadyInLibraryError(message) {
  const err = new Error(message)
  err.code = 'ALREADY_IN_LIBRARY'
  err.statusCode = 409
  return err
}

const HISTORY_IMPORT_KEY = 'history_imported'
const MAX_HISTORY_ROWS = 500

async function appendHistory(j) {
  try {
    const db = getDb()
    db.prepare(
      `INSERT OR REPLACE INTO download_history (id, finished_at, payload)
       VALUES (?, ?, ?)`,
    ).run(j.id, Date.now(), JSON.stringify(jobPublic(j)))
    db.prepare(
      `DELETE FROM download_history WHERE id IN (
         SELECT id FROM download_history ORDER BY finished_at DESC LIMIT -1 OFFSET ?
       )`,
    ).run(MAX_HISTORY_ROWS)
  } catch (err) {
    console.error('history write failed', err.message)
  }
}

// One-time import of the legacy history.ndjson into SQLite; the file is kept
// around untouched as a backup.
function importLegacyHistory(db) {
  const imported = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(HISTORY_IMPORT_KEY)
  if (imported?.value === '1') return
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8')
    const insert = db.prepare(
      `INSERT OR IGNORE INTO download_history (id, finished_at, payload)
       VALUES (?, ?, ?)`,
    )
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const job = JSON.parse(trimmed)
        if (!job?.id) continue
        insert.run(job.id, Number(job.updatedAt) || 0, trimmed)
      } catch {}
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(HISTORY_IMPORT_KEY)
  } catch {
    // No legacy file or unreadable — mark as done either way.
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(HISTORY_IMPORT_KEY)
  }
}

export function listHistory(limit = 200) {
  try {
    const rows = getDb()
      .prepare(
        'SELECT payload FROM download_history ORDER BY finished_at DESC LIMIT ?',
      )
      .all(Math.max(1, Math.min(Number(limit) || 200, 500)))
    const jobs = []
    for (const row of rows) {
      try {
        jobs.push(JSON.parse(row.payload))
      } catch {}
    }
    return jobs
  } catch (err) {
    console.error('history read failed:', err.message)
    return []
  }
}

// Restore persisted jobs after a restart: queued/running jobs re-enter the
// queue in their original order, finished jobs stay visible in the UI.
function restorePersistedJobs() {
  let restored = 0
  try {
    const db = getDb()
    const rows = db
      .prepare('SELECT payload FROM queue_jobs ORDER BY seq ASC')
      .all()
    for (const row of rows) {
      let job
      try {
        job = JSON.parse(row.payload)
      } catch {
        continue
      }
      if (!job?.id || state.jobs.has(job.id)) continue
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'queued'
        job.progress = 0
        job.message = 'Requeued after restart'
        state.jobs.set(job.id, job)
        state.queue.push(job.id)
        restored += 1
      } else {
        state.jobs.set(job.id, job)
      }
      lastPersistAt.set(job.id, 0)
    }
    if (restored > 0) {
      console.log(`[queue] requeued ${restored} job(s) from previous run`)
    }
  } catch (err) {
    console.error('queue restore failed:', err.message)
  }
}

export async function enqueueAlbum({ albumId, storefront, quality, expectedArtistId }) {
  for (const j of state.jobs.values()) {
    if (
      j.albumId === albumId &&
      (j.status === 'queued' || j.status === 'running')
    ) {
      return jobPublic(j)
    }
  }

  const id = crypto.randomUUID()
  const settings = await readSettings()
  let meta = null
  try {
    const raw = await getAlbum({
      storefront: storefront || settings.storefront,
      id: albumId,
      language: settings.language,
    })
    meta = normalizeAlbum(raw?.data?.[0])
  } catch (err) {
    console.error('album metadata lookup failed', err.message)
  }

  let missingTracks = null
  if (meta?.artistName && meta?.name && Array.isArray(meta?.tracks) && meta.tracks.length > 0) {
    const presence = await getAlbumTrackPresence(
      meta.artistName,
      meta.name,
      meta.tracks.map((t) => ({ id: t.id, name: t.name, isrc: t.isrc })),
    )
    if (presence.complete) {
      throw alreadyInLibraryError('Already in library')
    }
    if (presence.present > 0) {
      missingTracks = meta.tracks
        .filter((t) => !presence.tracks[t.id])
        .map((t) => ({ id: t.id, name: t.name, isrc: t.isrc }))
    }
  }

  const job = {
    id,
    kind: 'album',
    status: 'queued',
    progress: 0,
    albumId,
    albumTitle: stripTrailingYear(meta?.name) || 'Unknown album',
    albumName: meta?.name || null,
    artist: meta?.artistName || 'Unknown artist',
    artistId: expectedArtistId || meta?.artistId || null,
    year: meta?.year || null,
    artworkUrl: meta?.artworkTemplate
      ? meta.artworkTemplate
          .replace('{w}', '600')
          .replace('{h}', '600')
          .replace('{f}', 'jpg')
      : null,
    storefront: storefront || settings.storefront || 'us',
    quality: normalizeQuality(quality, settings.quality),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentTrack: null,
    message: 'Queued',
    error: null,
    finalDir: null,
    missingTracks,
    stats: { total: missingTracks?.length || meta?.trackCount || 0, done: 0, failed: 0 },
  }
  state.jobs.set(id, job)
  state.queue.push(id)
  persistJob(job, true)
  emitEvent('job.created', jobPublic(job))
  setImmediate(tickQueue)
  return jobPublic(job)
}

export async function enqueuePlaylist({ playlistId, libraryId, storefront, quality }) {
  if (!playlistId && !libraryId) {
    throw new Error('playlistId or libraryId required')
  }
  if (libraryId) {
    return enqueueLibraryPlaylist({ libraryId, storefront, quality })
  }

  for (const j of state.jobs.values()) {
    if (
      j.kind === 'playlist' &&
      j.playlistId === playlistId &&
      (j.status === 'queued' || j.status === 'running')
    ) {
      return jobPublic(j)
    }
  }

  if (await isPlaylistInLibrary(playlistId)) {
    throw alreadyInLibraryError('Already in library')
  }

  const id = crypto.randomUUID()
  const settings = await readSettings()

  let meta = null
  try {
    const raw = await getPlaylist({
      storefront: storefront || settings.storefront,
      id: playlistId,
      language: settings.language,
    })
    meta = normalizePlaylist(raw?.data?.[0])
  } catch (err) {
    console.error('playlist metadata lookup failed', err.message)
  }

  const job = {
    id,
    kind: 'playlist',
    status: 'queued',
    progress: 0,
    albumId: '',
    playlistId,
    libraryPlaylistId: null,
    sourceUrl:
      meta?.url ||
      `https://music.apple.com/${encodeURIComponent(storefront || settings.storefront || 'us')}/playlist/_/${encodeURIComponent(playlistId)}`,
    albumTitle: meta?.name || 'Unknown playlist',
    artist: meta?.curatorName || 'Apple Music',
    artistId: meta?.curatorId || null,
    year: null,
    artworkUrl: meta?.artworkTemplate
      ? meta.artworkTemplate
          .replace('{w}', '600')
          .replace('{h}', '600')
          .replace('{f}', 'jpg')
      : null,
    storefront: storefront || settings.storefront || 'us',
    quality: normalizeQuality(quality, settings.quality),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentTrack: null,
    message: 'Queued',
    error: null,
    finalDir: null,
    stats: { total: meta?.trackCount || meta?.tracks?.length || 0, done: 0, failed: 0 },
  }

  state.jobs.set(id, job)
  state.queue.push(id)
  persistJob(job, true)
  emitEvent('job.created', jobPublic(job))
  setImmediate(tickQueue)
  return jobPublic(job)
}

async function enqueueLibraryPlaylist({ libraryId, storefront, quality }) {
  if (!libraryId) throw new Error('libraryId required')

  for (const j of state.jobs.values()) {
    if (
      j.kind === 'playlist' &&
      j.libraryPlaylistId === libraryId &&
      (j.status === 'queued' || j.status === 'running')
    ) {
      return jobPublic(j)
    }
  }

  if (await isPlaylistInLibrary(libraryId)) {
    throw alreadyInLibraryError('Already in library')
  }

  const settings = await readSettings()
  const creds = await readAppleCreds()
  if (!creds.mediaUserToken) {
    const err = new Error('media-user-token not configured')
    err.code = 'NO_MEDIA_USER_TOKEN'
    err.statusCode = 412
    throw err
  }

  const detail = await getLibraryPlaylistDetail({
    libraryId,
    mediaUserToken: creds.mediaUserToken,
    language: settings.language,
  })
  if (!detail) {
    throw new Error('library playlist not found')
  }
  if (detail.catalogId && (await isPlaylistInLibrary(detail.catalogId))) {
    throw alreadyInLibraryError('Already in library')
  }
  const playlistTracks = detail.tracks
    .filter((t) => t.catalogId)
    .map((t) => ({
      catalogId: t.catalogId,
      name: t.name,
      artistName: t.artistName,
      albumName: t.albumName,
      durationMs: t.durationMs,
    }))
  if (playlistTracks.length === 0) {
    throw new Error('playlist has no downloadable catalog tracks')
  }

  const id = crypto.randomUUID()
  const job = {
    id,
    kind: 'playlist',
    status: 'queued',
    progress: 0,
    albumId: '',
    playlistId: detail.catalogId || null,
    libraryPlaylistId: libraryId,
    sourceUrl: null,
    albumTitle: detail.name || 'Untitled playlist',
    artist: detail.curatorName || 'You',
    artistId: null,
    year: null,
    artworkUrl: detail.artworkTemplate
      ? detail.artworkTemplate
          .replace('{w}', '600')
          .replace('{h}', '600')
          .replace('{f}', 'jpg')
      : null,
    storefront: storefront || settings.storefront || 'us',
    quality: normalizeQuality(quality, settings.quality),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentTrack: null,
    message: 'Queued',
    error: null,
    finalDir: null,
    playlistTracks,
    undownloadableCount: detail.undownloadableCount,
    stats: { total: playlistTracks.length, done: 0, failed: 0 },
  }

  state.jobs.set(id, job)
  state.queue.push(id)
  persistJob(job, true)
  emitEvent('job.created', jobPublic(job))
  setImmediate(tickQueue)
  return jobPublic(job)
}

export async function enqueueSong({ songId, albumId, storefront, quality, followedPlaylistId }) {
  if (!songId) throw new Error('songId required')

  for (const j of state.jobs.values()) {
    if (
      j.kind === 'song' &&
      j.songId === songId &&
      (j.status === 'queued' || j.status === 'running')
    ) {
      return jobPublic(j)
    }
  }

  const id = crypto.randomUUID()
  const settings = await readSettings()
  const sf = storefront || settings.storefront
  let resolvedAlbumId = albumId || null
  if (!resolvedAlbumId) {
    try {
      const raw = await getSong({ storefront: sf, id: songId, language: settings.language })
      const songData = raw?.data?.[0]
      const albumRel = songData?.relationships?.albums?.data?.[0]?.id
      if (albumRel) resolvedAlbumId = String(albumRel)
    } catch (err) {
      console.error('song catalog lookup failed', err.message)
    }
    if (!resolvedAlbumId) {
      throw new Error('Could not resolve parent album for song')
    }
  }

  let meta = null
  let trackMeta = null
  try {
    const raw = await getAlbum({
      storefront: sf,
      id: resolvedAlbumId,
      language: settings.language,
    })
    meta = normalizeAlbum(raw?.data?.[0])
    const tracks = raw?.data?.[0]?.relationships?.tracks?.data || []
    trackMeta = tracks.find((t) => t.id === songId) || null
  } catch (err) {
    console.error('song metadata lookup failed', err.message)
  }

  const trackName = trackMeta?.attributes?.name || 'Unknown track'
  const trackIsrc = trackMeta?.attributes?.isrc || null

  if (
    meta?.artistName &&
    trackName &&
    trackName !== 'Unknown track' &&
    (await hasSongInLibrary(meta.artistName, trackName, null, trackIsrc))
  ) {
    throw alreadyInLibraryError('Already in library')
  }

  const job = {
    id,
    kind: 'song',
    status: 'queued',
    progress: 0,
    albumId: resolvedAlbumId,
    songId,
    followedPlaylistId: followedPlaylistId || null,
    albumTitle: trackName,
    artist: meta?.artistName || 'Unknown artist',
    artistId: meta?.artistId || null,
    year: meta?.year || null,
    artworkUrl: meta?.artworkTemplate
      ? meta.artworkTemplate
          .replace('{w}', '600')
          .replace('{h}', '600')
          .replace('{f}', 'jpg')
      : null,
    storefront: storefront || settings.storefront || 'us',
    quality: normalizeQuality(quality, settings.quality),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentTrack: null,
    message: 'Queued',
    error: null,
    finalDir: null,
    stats: { total: 1, done: 0, failed: 0 },
  }
  state.jobs.set(id, job)
  state.queue.push(id)
  persistJob(job, true)
  emitEvent('job.created', jobPublic(job))
  setImmediate(tickQueue)
  return jobPublic(job)
}

export async function cancelJob(id) {
  const j = state.jobs.get(id)
  if (!j) return { ok: false, error: 'not found' }
  if (j.status === 'done' || j.status === 'failed') {
    return { ok: true, noop: true }
  }
  const ctl = state.running.get(id)
  const wasActive = state.active.has(id)
  if (ctl) ctl.abort()
  state.queue = state.queue.filter((qid) => qid !== id)
  updateJob(id, {
    status: 'failed',
    error: 'Cancelled',
    message: 'Cancelled',
    cancelled: true,
  })
  if (!ctl && !wasActive) appendHistory(j).catch(() => {})
  return { ok: true }
}

export async function cancelAllJobs() {
  const ids = new Set([
    ...state.queue,
    ...state.active,
    ...state.running.keys(),
  ])
  let cancelled = 0
  for (const id of ids) {
    const j = state.jobs.get(id)
    if (!j || j.status === 'done' || j.status === 'failed') continue
    const result = await cancelJob(id)
    if (result.ok && !result.noop) cancelled += 1
  }
  return { ok: true, cancelled }
}

const STAGING_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
let stagingSweepTimer = null

export async function initQueue() {
  await sweepStagingRoots()
  if (!stagingSweepTimer) {
    stagingSweepTimer = setInterval(() => {
      sweepStagingRoots().catch((err) => {
        console.error('staging sweep failed:', err.message)
      })
    }, STAGING_SWEEP_INTERVAL_MS)
    stagingSweepTimer.unref?.()
  }
  try {
    importLegacyHistory(getDb())
  } catch (err) {
    console.error('history import failed:', err.message)
  }
  restorePersistedJobs()
  setImmediate(tickQueue)
}

export const __test__ = { persistJob, restorePersistedJobs }

async function sweepStagingRoots() {
  const settings = await readSettings().catch(() => null)
  const activeStagingRoot = resolveStagingRoot(settings)
  const inactiveStagingRoot =
    activeStagingRoot === STAGING_ROOT_OUTSIDE
      ? STAGING_ROOT_INSIDE
      : STAGING_ROOT_OUTSIDE
  await ensureDir(activeStagingRoot)
  await cleanupStaleStagingDirs(activeStagingRoot)
  await cleanupStaleStagingDirs(inactiveStagingRoot)
}

async function cleanupStaleStagingDirs(stagingRoot) {
  const entries = await fsp.readdir(stagingRoot, { withFileTypes: true }).catch(() => [])
  const queued = new Set(state.queue)
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_DIR_RE.test(entry.name)) continue
    if (state.active.has(entry.name) || state.running.has(entry.name) || queued.has(entry.name)) {
      continue
    }
    const abs = path.join(stagingRoot, entry.name)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat?.isDirectory()) continue
    const updatedAt = Math.max(
      Number(stat.mtimeMs) || 0,
      Number(stat.ctimeMs) || 0,
      Number(stat.birthtimeMs) || 0,
    )
    if (updatedAt <= 0) continue
    if (now - updatedAt < STAGING_MAX_AGE_MS) continue
    await fsp.rm(abs, { recursive: true, force: true }).catch(() => {})
  }
}

async function tickQueue() {
  while (state.active.size < MAX_CONCURRENT && state.queue.length > 0) {
    const id = state.queue.shift()
    const job = state.jobs.get(id)
    if (!job || job.status !== 'queued') continue
    state.active.add(id)
    runJob(job).finally(() => {
      state.active.delete(id)
      setImmediate(tickQueue)
    })
  }
}

async function runJob(job) {
  let jobStaging = null
  try {
    throwIfCancelled(job)
    updateJob(job.id, { status: 'running', message: 'Preparing' })
    throwIfCancelled(job)
    const mp4box = probeMp4Box()
    if (!mp4box.ok) {
      throw new Error(
        `MP4Box preflight failed: ${mp4box.error}. Rebuild the web image so apple-music-dl can finalize MP4 files.`,
      )
    }
    const wrapperHealth = await probeWrapperPorts()
    if (!wrapperHealth.ok) {
      const failed = wrapperHealth.failedPorts
        .map((p) => `${p.name}:${p.port}(${p.error})`)
        .join(', ')
      const e = new Error(`wrapper not reachable (${failed})`)
      e.code = 'WRAPPER_DOWN'
      emitEvent('wrapper.health', { ok: false, failedPorts: wrapperHealth.failedPorts })
      throw e
    }
    const settings = await readSettings()
    const stagingRoot = resolveStagingRoot(settings)
    await ensureDir(stagingRoot)
    jobStaging = path.join(stagingRoot, job.id)
    await ensureDir(jobStaging)
    throwIfCancelled(job)

    const quality = normalizeQuality(job.quality, settings.quality)
    job.quality = quality
    const progressState = createProgressState(job, {
      convertEnabled: quality === 'flac',
    })
    const creds = await readAppleCreds()
    await writeAmdpConfig({
      settings,
      mediaUserToken: creds.mediaUserToken,
      stagingRoot: jobStaging,
    })
    throwIfCancelled(job)

    if (
      job.kind === 'album' &&
      Array.isArray(job.missingTracks) &&
      job.missingTracks.length > 0
    ) {
      await runPartialAlbumFill({
        job,
        jobStaging,
        settings,
        creds,
        quality,
        progressState,
      })
      return
    }

    if (
      job.kind === 'playlist' &&
      Array.isArray(job.playlistTracks) &&
      job.playlistTracks.length > 0
    ) {
      await runLibraryPlaylistFill({
        job,
        jobStaging,
        settings,
        creds,
        quality,
        progressState,
      })
      return
    }

    const isSong = job.kind === 'song'
    const isPlaylist = job.kind === 'playlist'
    const baseUrl = `https://music.apple.com/${encodeURIComponent(job.storefront)}/album/_/${encodeURIComponent(job.albumId)}`
    const playlistUrl =
      job.sourceUrl ||
      `https://music.apple.com/${encodeURIComponent(job.storefront)}/playlist/_/${encodeURIComponent(job.playlistId || '')}`
    const url = isPlaylist
      ? playlistUrl
      : isSong
        ? `${baseUrl}?i=${encodeURIComponent(job.songId)}`
        : baseUrl

    throwIfCancelled(job)
    let downloadResult = await runAmdpDownload({
      job,
      jobStaging,
      url,
      quality,
      isSong,
      progressState,
    })
    let combined = `${downloadResult.stdout}\n${downloadResult.stderr}`
    if (quality === 'atmos' && (await shouldFallbackAtmosToFlac(downloadResult, combined, jobStaging))) {
      await fsp.rm(jobStaging, { recursive: true, force: true })
      await ensureDir(jobStaging)
      await writeAmdpConfig({
        settings,
        mediaUserToken: creds.mediaUserToken,
        stagingRoot: jobStaging,
      })
      progressState.downloadDone = 0
      progressState.downloadPartial = 0
      progressState.convertDone = 0
      progressState.finalizeProgress = 0
      setConversionEnabled(progressState, true)
      applyProgress(job, progressState, {
        message: 'Atmos unavailable; downloading FLAC fallback',
        currentTrack: null,
      })
      downloadResult = await runAmdpDownload({
        job,
        jobStaging,
        url,
        quality: 'flac',
        isSong,
        progressState,
      })
      combined = `${downloadResult.stdout}\n${downloadResult.stderr}`
    }
    assertAmdpResult(downloadResult, combined)

    progressState.downloadDone = progressState.downloadTotal
    progressState.downloadPartial = 0
    applyProgress(job, progressState, {
      message: progressState.convertEnabled
        ? 'Preparing FLAC conversion'
        : 'Finalizing import',
      currentTrack: null,
    })

    if (isPlaylist) {
      if (progressState.convertEnabled) {
        applyProgress(job, progressState, {
          message: 'Converting to FLAC',
          currentTrack: null,
        })
        const conv = await convertDirToFlac(jobStaging, {
          onProgress: ({ index, total }) => {
            if (total > 0) {
              progressState.convertTotal = total
            }
            progressState.convertDone = Math.max(
              progressState.convertDone,
              Math.min(progressState.convertTotal || index, index),
            )
            applyProgress(job, progressState, {
              message: `Converting to FLAC (${index}/${progressState.convertTotal || total || index})`,
            })
          },
        })
        job.stats.converted = conv.converted
        job.stats.flacFailed = conv.failed
        if (conv.total > 0) {
          progressState.convertTotal = conv.total
          progressState.convertDone = Math.max(progressState.convertDone, conv.total)
        }
        progressState.convertDone = Math.max(
          progressState.convertDone,
          progressState.convertTotal,
        )
        applyProgress(job, progressState, {
          message: 'Converting to FLAC',
        })
      }

      progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.55)
      applyProgress(job, progressState, {
        message: 'Moving into library',
        currentTrack: null,
      })

      const importedTracks = await importPlaylistTracks({
        job,
        jobStaging,
        onProgress: ({ done, total }) => {
          if (total > 0) {
            progressState.finalizeProgress = Math.max(
              progressState.finalizeProgress,
              0.55 + (Math.min(total, done) / total) * 0.35,
            )
            applyProgress(job, progressState, {
              message: `Moving into library (${done}/${total})`,
              currentTrack: null,
            })
          }
        },
      })
      if (importedTracks.length === 0) {
        throw new Error('no audio files in final folder')
      }
      job.stats.done = importedTracks.length

      progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.93)
      applyProgress(job, progressState, {
        message: 'Writing playlist file',
        currentTrack: null,
      })
      const playlistPath = await writePlaylistM3U({
        playlistName: job.albumTitle,
        playlistId: job.playlistId,
        tracks: importedTracks,
        artworkTemplate: job.artworkUrl,
      })

      try {
        await fsp.rm(jobStaging, { recursive: true, force: true })
      } catch {
        /* ignore */
      }

      progressState.finalizeProgress = 1
      applyProgress(job, progressState, {
        message: 'Finalizing import',
        currentTrack: null,
      })

      updateJob(job.id, {
        status: 'done',
        progress: 100,
        message: `Imported ${importedTracks.length} tracks`,
        finalDir: path.dirname(playlistPath),
      })
      await appendHistory(job)
      triggerNavidromeScan().catch(console.error)
      return
    }

    const artistDirs = await fsp.readdir(jobStaging, { withFileTypes: true })
    const firstArtist = artistDirs.find((e) => e.isDirectory())
    if (!firstArtist) {
      const tail = combined.slice(-600).trim()
      throw new Error(
        `amdp produced no artist folder. amdp output tail: ${tail || '(empty)'}`,
      )
    }
    const artistPath = path.join(jobStaging, firstArtist.name)
    const albumDirs = await fsp.readdir(artistPath, { withFileTypes: true })
    const firstAlbum = albumDirs.find((e) => e.isDirectory())
    if (!firstAlbum) throw new Error('amdp produced no album folder')
    const albumPath = path.join(artistPath, firstAlbum.name)

    if (progressState.convertEnabled) {
      applyProgress(job, progressState, {
        message: 'Converting to FLAC',
        currentTrack: null,
      })
      const conv = await convertDirToFlac(albumPath, {
        onProgress: ({ index, total }) => {
          if (total > 0) {
            progressState.convertTotal = total
          }
          progressState.convertDone = Math.max(
            progressState.convertDone,
            Math.min(progressState.convertTotal || index, index),
          )
          applyProgress(job, progressState, {
            message: `Converting to FLAC (${index}/${progressState.convertTotal || total || index})`,
          })
        },
      })
      job.stats.converted = conv.converted
      job.stats.flacFailed = conv.failed
      if (conv.total > 0) {
        progressState.convertTotal = conv.total
        progressState.convertDone = Math.max(progressState.convertDone, conv.total)
      }
      progressState.convertDone = Math.max(
        progressState.convertDone,
        progressState.convertTotal,
      )
      applyProgress(job, progressState, {
        message: 'Converting to FLAC',
      })
    }

    if (!isSong) {
      progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.35)
      applyProgress(job, progressState, {
        message: 'Extracting cover art',
        currentTrack: null,
      })
      await extractFolderArt(albumPath, { size: 1000 }).catch(() => null)
    }

    const finalFiles = await fsp.readdir(albumPath)
    const audioCount = finalFiles.filter((f) =>
      /\.(flac|m4a|mp3)$/i.test(f),
    ).length
    if (audioCount === 0) throw new Error('no audio files in final folder')

    const convention = settings.namingConvention || 'apple'

    let finalDir
    if (isSong) {
      // Songs import straight into their parent album folder so every
      // download lands in the same Artist/Album/Track structure with the
      // original amdp filenames (and their embedded metadata) preserved.
      const albumDirName = firstAlbum.name.replace(/\s*\(\d{4}\)\s*$/, '')
      const rawAlbumName = applyNamingConvention(albumDirName, convention)
      finalDir = await computeFinalDir(
        MUSIC_ROOT,
        firstArtist.name,
        rawAlbumName,
        job.year,
      )
      await ensureDir(finalDir)

      if (convention === 'qobuz') {
        for (const fn of finalFiles) {
          if (!/\.(flac|m4a|mp3|lrc)$/i.test(fn)) continue
          const ext = path.extname(fn)
          const stem = path.basename(fn, ext)
          const newStem = applyNamingConvention(stem, 'qobuz')
          if (newStem !== stem) {
            const src = path.join(albumPath, fn)
            const dst = path.join(albumPath, newStem + ext)
            if (!(await fsp.stat(dst).catch(() => null))) {
              await fsp.rename(src, dst)
            }
          }
        }
      }

      const movedFiles = await fsp.readdir(albumPath)
      const audioFiles = movedFiles.filter((f) => /\.(flac|m4a|mp3)$/i.test(f))
      if (audioFiles.length === 0) throw new Error('no audio file to move')
      progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.7)
      applyProgress(job, progressState, {
        message: 'Moving into library',
        currentTrack: null,
      })
      for (const fn of audioFiles) {
        await moveFileSafe(path.join(albumPath, fn), path.join(finalDir, fn))
        const srcBase = path.basename(fn, path.extname(fn))
        const srcLrcPath = path.join(albumPath, `${srcBase}.lrc`)
        const hasLrc = await fsp
          .stat(srcLrcPath)
          .then((s) => s.isFile())
          .catch(() => false)
        if (hasLrc) {
          await moveFileSafe(srcLrcPath, path.join(finalDir, `${srcBase}.lrc`))
        }
      }
      await copyFolderArtIfAny(albumPath, finalDir)
    } else {
      const rawAlbumName = applyNamingConvention(
        firstAlbum.name.replace(/\s*\(\d{4}\)\s*$/, ''),
        convention,
      )
      finalDir = await computeFinalDir(
        MUSIC_ROOT,
        firstArtist.name,
        rawAlbumName,
        job.year,
      )

      if (convention === 'qobuz') {
        const audioFiles = await fsp.readdir(albumPath)
        for (const fn of audioFiles) {
          if (!/\.(flac|m4a|mp3|lrc)$/i.test(fn)) continue
          const ext = path.extname(fn)
          const stem = path.basename(fn, ext)
          const newStem = applyNamingConvention(stem, 'qobuz')
          if (newStem !== stem) {
            const src = path.join(albumPath, fn)
            const dst = path.join(albumPath, newStem + ext)
            if (!await fsp.stat(dst).catch(() => null)) {
              await fsp.rename(src, dst)
            }
          }
        }
      }

      progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.75)
      applyProgress(job, progressState, {
        message: 'Moving into library',
        currentTrack: null,
      })
      await mergeMove(albumPath, finalDir)
    }

    try {
      await fsp.rm(albumPath, { recursive: true, force: true })
      await fsp.rmdir(artistPath)
      await fsp.rmdir(jobStaging)
    } catch {
      /* ignore */
    }

    progressState.finalizeProgress = 1
    applyProgress(job, progressState, {
      message: 'Finalizing import',
      currentTrack: null,
    })

    updateJob(job.id, {
      status: 'done',
      progress: 100,
      message: isSong ? 'Imported track' : `Imported ${audioCount} tracks`,
      finalDir,
    })
    invalidateLibraryCache()
    await appendHistory(job)
    triggerNavidromeScan().catch(console.error)
  } catch (err) {
    if (err.name === 'AbortError') {
      updateJob(job.id, {
        status: 'failed',
        error: 'Cancelled',
        message: 'Cancelled',
        cancelled: true,
      })
    } else {
      console.error(`[job ${job.id}] failed:`, err)
      updateJob(job.id, {
        status: 'failed',
        error: err.message,
        message: `Failed: ${err.message}`,
        cancelled: false,
      })
    }
    await appendHistory(job).catch(() => {})
  } finally {
    if (jobStaging) {
      await fsp.rm(jobStaging, { recursive: true, force: true }).catch(() => {})
    }
    state.running.delete(job.id)
  }
}

async function runPartialAlbumFill({
  job,
  jobStaging,
  settings,
  creds,
  quality,
  progressState,
}) {
  const missing = job.missingTracks || []
  const baseUrl = `https://music.apple.com/${encodeURIComponent(job.storefront)}/album/_/${encodeURIComponent(job.albumId)}`

  progressState.downloadTotal = missing.length
  progressState.downloadDone = 0
  progressState.downloadPartial = 0
  if (progressState.convertEnabled) {
    progressState.convertTotal = missing.length
    progressState.convertDone = 0
  }
  job.stats.total = missing.length
  job.stats.done = 0
  applyProgress(job, progressState, {
    message: `Filling missing tracks (0/${missing.length})`,
    currentTrack: null,
  })

  let firstArtistName = null
  let firstAlbumName = null
  const trackAlbumPaths = []

  for (let i = 0; i < missing.length; i += 1) {
    throwIfCancelled(job)
    const track = missing[i]
    const trackStaging = path.join(jobStaging, `t${i}`)
    await ensureDir(trackStaging)
    await writeAmdpConfig({
      settings,
      mediaUserToken: creds.mediaUserToken,
      stagingRoot: trackStaging,
    })

    applyProgress(job, progressState, {
      message: `Filling missing tracks (${i}/${missing.length})`,
      currentTrack: track.name || null,
    })

    const url = `${baseUrl}?i=${encodeURIComponent(track.id)}`
    progressState.downloadDone = i
    progressState.downloadPartial = 0
    progressState.lockDownloadTotal = true
    const sub = await runAmdpDownload({
      job,
      jobStaging: trackStaging,
      url,
      quality,
      isSong: true,
      progressState,
    })
    const combined = `${sub.stdout}\n${sub.stderr}`
    if (
      quality === 'atmos' &&
      (await shouldFallbackAtmosToFlac(sub, combined, trackStaging))
    ) {
      await fsp.rm(trackStaging, { recursive: true, force: true })
      await ensureDir(trackStaging)
      await writeAmdpConfig({
        settings,
        mediaUserToken: creds.mediaUserToken,
        stagingRoot: trackStaging,
      })
      progressState.downloadDone = i
      progressState.downloadPartial = 0
      const retry = await runAmdpDownload({
        job,
        jobStaging: trackStaging,
        url,
        quality: 'flac',
        isSong: true,
        progressState,
      })
      assertAmdpResult(retry, `${retry.stdout}\n${retry.stderr}`)
    } else {
      assertAmdpResult(sub, combined)
    }

    const artistDirs = await fsp.readdir(trackStaging, { withFileTypes: true })
    const artistEntry = artistDirs.find((e) => e.isDirectory())
    if (!artistEntry) {
      throw new Error(`amdp produced no artist folder for track ${track.id}`)
    }
    const artistPath = path.join(trackStaging, artistEntry.name)
    const albumDirs = await fsp.readdir(artistPath, { withFileTypes: true })
    const albumEntry = albumDirs.find((e) => e.isDirectory())
    if (!albumEntry) {
      throw new Error(`amdp produced no album folder for track ${track.id}`)
    }
    const albumPath = path.join(artistPath, albumEntry.name)
    if (!firstArtistName) firstArtistName = artistEntry.name
    if (!firstAlbumName) firstAlbumName = albumEntry.name
    trackAlbumPaths.push(albumPath)

    progressState.downloadDone = i + 1
    progressState.downloadPartial = 0
    job.stats.done = i + 1
    applyProgress(job, progressState, {
      message: `Filling missing tracks (${i + 1}/${missing.length})`,
    })
  }

  if (!firstArtistName || !firstAlbumName) {
    throw new Error('partial album fill produced no artist/album folder')
  }

  if (progressState.convertEnabled) {
    applyProgress(job, progressState, {
      message: 'Converting to FLAC',
      currentTrack: null,
    })
    let convertedTotal = 0
    let convertedFailed = 0
    for (const albumPath of trackAlbumPaths) {
      const conv = await convertDirToFlac(albumPath, {
        onProgress: ({ index, total }) => {
          if (total > 0) {
            progressState.convertTotal = Math.max(progressState.convertTotal, missing.length)
          }
          progressState.convertDone = Math.min(
            progressState.convertTotal,
            convertedTotal + Math.max(0, index),
          )
          applyProgress(job, progressState, {
            message: `Converting to FLAC (${progressState.convertDone}/${progressState.convertTotal})`,
          })
        },
      })
      convertedTotal += conv.converted
      convertedFailed += conv.failed
    }
    job.stats.converted = convertedTotal
    job.stats.flacFailed = convertedFailed
    progressState.convertDone = progressState.convertTotal
    applyProgress(job, progressState, { message: 'Converting to FLAC' })
  }

  const convention = settings?.namingConvention || 'apple'
  const finalDir = await computeFinalDir(
    MUSIC_ROOT,
    firstArtistName,
    applyNamingConvention(firstAlbumName.replace(/\s*\(\d{4}\)\s*$/, ''), convention),
    job.year,
  )
  if (convention === 'qobuz') {
    for (const albumPath of trackAlbumPaths) {
      const audioFiles = await fsp.readdir(albumPath).catch(() => [])
      for (const fn of audioFiles) {
        if (!/\.(flac|m4a|mp3|lrc)$/i.test(fn)) continue
        const ext = path.extname(fn)
        const stem = path.basename(fn, ext)
        const newStem = applyNamingConvention(stem, 'qobuz')
        if (newStem !== stem) {
          const src = path.join(albumPath, fn)
          const dst = path.join(albumPath, newStem + ext)
          if (!(await fsp.stat(dst).catch(() => null))) {
            await fsp.rename(src, dst)
          }
        }
      }
    }
  }
  progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.5)
  applyProgress(job, progressState, {
    message: 'Moving into library',
    currentTrack: null,
  })
  for (const albumPath of trackAlbumPaths) {
    await mergeMove(albumPath, finalDir)
  }

  await extractFolderArt(finalDir, { size: 1000 }).catch(() => null)

  try {
    await fsp.rm(jobStaging, { recursive: true, force: true })
  } catch {}

  progressState.finalizeProgress = 1
  applyProgress(job, progressState, {
    message: 'Finalizing import',
    currentTrack: null,
  })

  updateJob(job.id, {
    status: 'done',
    progress: 100,
    message: `Filled ${missing.length} missing track${missing.length === 1 ? '' : 's'}`,
    finalDir,
  })
  invalidateLibraryCache()
  await appendHistory(job)
  triggerNavidromeScan().catch(console.error)
}

async function runLibraryPlaylistFill({
  job,
  jobStaging,
  settings,
  creds,
  quality,
  progressState,
}) {
  const tracks = job.playlistTracks || []
  if (tracks.length === 0) {
    throw new Error('library playlist has no tracks to download')
  }

  progressState.downloadTotal = tracks.length
  progressState.downloadDone = 0
  progressState.downloadPartial = 0
  progressState.lockDownloadTotal = true
  if (progressState.convertEnabled) {
    progressState.convertTotal = tracks.length
    progressState.convertDone = 0
  }
  job.stats.total = tracks.length
  job.stats.done = 0
  applyProgress(job, progressState, {
    message: `Downloading playlist (0/${tracks.length})`,
    currentTrack: null,
  })

  const importedPaths = []

  for (let i = 0; i < tracks.length; i += 1) {
    throwIfCancelled(job)
    const track = tracks[i]
    const trackStaging = path.join(jobStaging, `t${i}`)
    await ensureDir(trackStaging)
    await writeAmdpConfig({
      settings,
      mediaUserToken: creds.mediaUserToken,
      stagingRoot: trackStaging,
    })

    applyProgress(job, progressState, {
      message: `Downloading playlist (${i}/${tracks.length})`,
      currentTrack: track.name || null,
    })

    let albumCatalogId = null
    try {
      const raw = await getSong({
        storefront: job.storefront,
        id: track.catalogId,
        language: settings.language,
      })
      const songData = raw?.data?.[0]
      const albumRel = songData?.relationships?.albums?.data?.[0]?.id
      if (albumRel) albumCatalogId = String(albumRel)
    } catch (err) {
      console.error('library playlist song lookup failed', track.catalogId, err.message)
    }
    if (!albumCatalogId) {
      job.stats.failed = (job.stats.failed || 0) + 1
      progressState.downloadDone = i + 1
      applyProgress(job, progressState, {
        message: `Skipped ${track.name || track.catalogId} (no album)`,
      })
      continue
    }

    const url = `https://music.apple.com/${encodeURIComponent(job.storefront)}/album/_/${encodeURIComponent(albumCatalogId)}?i=${encodeURIComponent(track.catalogId)}`
    progressState.downloadDone = i
    progressState.downloadPartial = 0
    const sub = await runAmdpDownload({
      job,
      jobStaging: trackStaging,
      url,
      quality,
      isSong: true,
      progressState,
    })
    const combined = `${sub.stdout}\n${sub.stderr}`
    if (
      quality === 'atmos' &&
      (await shouldFallbackAtmosToFlac(sub, combined, trackStaging))
    ) {
      await fsp.rm(trackStaging, { recursive: true, force: true })
      await ensureDir(trackStaging)
      await writeAmdpConfig({
        settings,
        mediaUserToken: creds.mediaUserToken,
        stagingRoot: trackStaging,
      })
      progressState.downloadDone = i
      progressState.downloadPartial = 0
      const retry = await runAmdpDownload({
        job,
        jobStaging: trackStaging,
        url,
        quality: 'flac',
        isSong: true,
        progressState,
      })
      assertAmdpResult(retry, `${retry.stdout}\n${retry.stderr}`)
    } else {
      assertAmdpResult(sub, combined)
    }

    if (progressState.convertEnabled) {
      const albumDirs = await collectAlbumStagingDirs(trackStaging)
      for (const albumPath of albumDirs) {
        const conv = await convertDirToFlac(albumPath, {})
        progressState.convertDone = Math.min(
          progressState.convertTotal,
          progressState.convertDone + (conv.converted || 0),
        )
      }
      applyProgress(job, progressState)
    }

    const importedHere = await importPlaylistTracks({
      job,
      jobStaging: trackStaging,
      onProgress: () => {},
    })
    for (const p of importedHere) importedPaths.push(p)

    progressState.downloadDone = i + 1
    progressState.downloadPartial = 0
    job.stats.done = i + 1
    applyProgress(job, progressState, {
      message: `Downloading playlist (${i + 1}/${tracks.length})`,
    })
  }

  if (importedPaths.length === 0) {
    throw new Error('no tracks were imported from playlist')
  }

  progressState.finalizeProgress = Math.max(progressState.finalizeProgress, 0.93)
  applyProgress(job, progressState, {
    message: 'Writing playlist file',
    currentTrack: null,
  })
  const playlistPath = await writePlaylistM3U({
    playlistName: job.albumTitle,
    playlistId: job.playlistId,
    libraryPlaylistId: job.libraryPlaylistId,
    tracks: importedPaths,
    artworkTemplate: job.artworkUrl,
  })

  await fsp.rm(jobStaging, { recursive: true, force: true }).catch(() => null)

  progressState.finalizeProgress = 1
  applyProgress(job, progressState, {
    message: 'Finalizing import',
    currentTrack: null,
  })
  updateJob(job.id, {
    status: 'done',
    progress: 100,
    message: `Imported ${importedPaths.length} track${importedPaths.length === 1 ? '' : 's'}`,
    finalDir: path.dirname(playlistPath),
  })
  invalidateLibraryCache()
  await appendHistory(job)
  triggerNavidromeScan().catch(console.error)
}

async function collectAlbumStagingDirs(root) {
  const out = []
  const artistEntries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const artist of artistEntries) {
    if (!artist.isDirectory()) continue
    const artistPath = path.join(root, artist.name)
    const albumEntries = await fsp.readdir(artistPath, { withFileTypes: true }).catch(() => [])
    for (const album of albumEntries) {
      if (album.isDirectory()) {
        out.push(path.join(artistPath, album.name))
      }
    }
  }
  return out
}

function handleAmdpLine(job, line, which, progressState) {
  let matchedTrackHeader = false

  const trackHeader = line.match(/^Track\s+(\d+)\s+of\s+(\d+)\s*:?\s*(.*)$/i)
  if (trackHeader) {
    const current = Number(trackHeader[1])
    const total = Number(trackHeader[2])
    if (total > 0) {
      matchedTrackHeader = true
      if (!progressState.lockDownloadTotal) {
        progressState.downloadTotal = total
      }
      const inferredDone = Math.max(0, Math.min(total, current - 1))
      if (!progressState.lockDownloadTotal && inferredDone > progressState.downloadDone) {
        progressState.downloadDone = inferredDone
      }
      progressState.downloadPartial = 0
      if (
        progressState.convertEnabled &&
        progressState.convertDone === 0 &&
        !progressState.lockDownloadTotal
      ) {
        progressState.convertTotal = total
      }

      job.stats.total = progressState.lockDownloadTotal ? progressState.downloadTotal : total
      job.stats.done = progressState.lockDownloadTotal
        ? Math.max(job.stats.done || 0, progressState.downloadDone)
        : Math.max(job.stats.done || 0, inferredDone)

      const title = String(trackHeader[3] || '').trim()
      applyProgress(job, progressState, {
        currentTrack:
          title && !/^(songs|music-videos)$/i.test(title)
            ? title
            : job.currentTrack,
      })
    }
  }

  if (!matchedTrackHeader) {
    const bracketed = line.match(/\[(\d+)\/(\d+)\]/)
    if (bracketed) {
      const done = Number(bracketed[1])
      const total = Number(bracketed[2])
      if (total > 0) {
        matchedTrackHeader = true
        if (!progressState.lockDownloadTotal) {
          progressState.downloadTotal = total
          progressState.downloadDone = Math.max(
            progressState.downloadDone,
            Math.min(total, Math.max(0, done)),
          )
        }
        progressState.downloadPartial = 0
        if (
          progressState.convertEnabled &&
          progressState.convertDone === 0 &&
          !progressState.lockDownloadTotal
        ) {
          progressState.convertTotal = total
        }

        job.stats.total = progressState.lockDownloadTotal ? progressState.downloadTotal : total
        job.stats.done = progressState.lockDownloadTotal
          ? Math.max(job.stats.done || 0, progressState.downloadDone)
          : Math.max(job.stats.done || 0, Math.min(total, done))

        applyProgress(job, progressState, {
          currentTrack: extractBracketTitle(line),
        })
      }
    }
  }

  if (!matchedTrackHeader) {
    const downloading = line.match(
      /Downloading\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.+)$/i,
    )
    if (downloading) {
      const current = Number(downloading[1])
      const total = Number(downloading[2])
      if (total > 0) {
        matchedTrackHeader = true
        if (!progressState.lockDownloadTotal) {
          progressState.downloadTotal = total
        }
        const inferredDone = Math.max(0, Math.min(total, current - 1))
        if (!progressState.lockDownloadTotal && inferredDone > progressState.downloadDone) {
          progressState.downloadDone = inferredDone
          progressState.downloadPartial = 0
        }
        if (
          progressState.convertEnabled &&
          progressState.convertDone === 0 &&
          !progressState.lockDownloadTotal
        ) {
          progressState.convertTotal = total
        }

        job.stats.total = progressState.lockDownloadTotal ? progressState.downloadTotal : total
        job.stats.done = progressState.lockDownloadTotal
          ? Math.max(job.stats.done || 0, progressState.downloadDone)
          : Math.max(job.stats.done || 0, inferredDone)

        applyProgress(job, progressState, {
          currentTrack: String(downloading[3] || '').trim() || job.currentTrack,
        })
      }
    }
  }

  if (!matchedTrackHeader) {
    const pctMatch = line.match(/(\d{1,3})\s*%/)
    if (pctMatch) {
      const pct = Math.max(0, Math.min(100, Number(pctMatch[1])))
      if (progressState.downloadDone < progressState.downloadTotal) {
        const partial = pct / 100
        if (partial > progressState.downloadPartial) {
          progressState.downloadPartial = partial
          applyProgress(job, progressState)
        }
      }
    }
  }

  if (which === 'stderr' && /error|failed|forbidden/i.test(line)) {
    job.stats.failed = (job.stats.failed || 0) + 1
  }

  emitEvent('job.log', { id: job.id, line, which })
}

function extractBracketTitle(line) {
  const m = line.match(/\]\s*(.+?)(?:\s*\[|$)/)
  return m ? m[1].trim() : null
}

function probeMp4Box() {
  try {
    const r = spawnSync('MP4Box', ['-version'], {
      encoding: 'utf8',
      timeout: 2500,
    })
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    if (r.status === 0 && /GPAC version/i.test(out)) {
      return { ok: true, error: null }
    }
    if (r.error?.code === 'ENOENT') {
      return { ok: false, error: 'executable not found in PATH' }
    }
    return {
      ok: false,
      error: `exit ${r.status ?? 'unknown'}${r.signal ? ` (${r.signal})` : ''}`,
    }
  } catch (err) {
    return { ok: false, error: err.message || 'unknown preflight error' }
  }
}

function buildAmdpArgs({ isSong, quality, url }) {
  const args = []
  if (isSong) args.push('--song')
  if (quality === 'atmos') args.push('--atmos')
  else if (quality === 'aac') args.push('--aac')
  args.push(url)
  return args
}

async function runAmdpDownload({ job, jobStaging, url, quality, isSong, progressState }) {
  throwIfCancelled(job)
  const ctl = new AbortController()
  state.running.set(job.id, ctl)

  applyProgress(job, progressState, {
    message: quality === 'atmos'
      ? 'Downloading Dolby Atmos from Apple Music'
      : 'Downloading from Apple Music',
  })

  let lastLineAt = Date.now()
  let lastLine = ''
  let firstLineSeen = false
  const startedAt = Date.now()
  let warnFired = false
  let stallReason = null
  let fatalErrorCount = 0
  let fatalAbortReason = null
  const watchdog = setInterval(() => {
    if (stallReason) return
    const idleMs = Date.now() - lastLineAt
    if (!firstLineSeen && Date.now() - startedAt >= FIRST_LINE_TIMEOUT_MS) {
      stallReason = `wrapper produced no output within ${Math.round(FIRST_LINE_TIMEOUT_MS / 1000)}s`
      emitEvent('wrapper.stall.suspected', {
        jobId: job.id,
        albumTitle: job.albumTitle,
        currentTrack: job.currentTrack || null,
        idleMs,
        thresholdMs: FIRST_LINE_TIMEOUT_MS,
        lastLine,
        phase: 'aborting',
      })
      try {
        ctl.abort()
      } catch {
        /* ignore */
      }
      return
    }
    if (idleMs >= STALL_TIMEOUT_MS) {
      stallReason = `wrapper stalled (no output for ${Math.round(idleMs / 1000)}s)`
      emitEvent('wrapper.stall.suspected', {
        jobId: job.id,
        albumTitle: job.albumTitle,
        currentTrack: job.currentTrack || null,
        idleMs,
        thresholdMs: STALL_TIMEOUT_MS,
        lastLine,
        phase: 'aborting',
      })
      try {
        ctl.abort()
      } catch {
        /* ignore */
      }
      return
    }
    const errorLines = job.stats.failed || 0
    if (errorLines >= MAX_DOWNLOAD_ERRORS * 10 && !stallReason && !fatalAbortReason) {
      fatalAbortReason = `download produced ${errorLines} error lines — likely stuck in a retry loop`
      try {
        ctl.abort()
      } catch {
      }
      return
    }
    if (idleMs >= STALL_WARN_MS && !warnFired) {
      warnFired = true
      emitEvent('wrapper.stall.suspected', {
        jobId: job.id,
        albumTitle: job.albumTitle,
        currentTrack: job.currentTrack || null,
        idleMs,
        thresholdMs: STALL_WARN_MS,
        lastLine,
        phase: 'warning',
      })
    } else if (idleMs < STALL_WARN_MS && warnFired) {
      warnFired = false
    }
  }, STALL_TICK_MS)

  try {
    const { waitExit } = spawnAmdp({
      args: buildAmdpArgs({ isSong, quality, url }),
      cwd: jobStaging,
      signal: ctl.signal,
      onLine: ({ line, which }) => {
        lastLineAt = Date.now()
        lastLine = line
        firstLineSeen = true
        handleAmdpLine(job, line, which, progressState)
        if (!fatalAbortReason && FATAL_DOWNLOAD_PATTERNS.some(re => re.test(line))) {
          fatalErrorCount++
          if (fatalErrorCount >= MAX_DOWNLOAD_ERRORS) {
            fatalAbortReason = `download aborted after ${fatalErrorCount} fatal error(s): ${line.slice(0, 200)}`
            try { ctl.abort() } catch {}
          }
        }
      },
    })
    try {
      const result = await waitExit
      throwIfCancelled(job)
      return result
    } catch (err) {
      if (job.cancelled) throw makeAbortError()
      if (stallReason) {
        const e = new Error(stallReason)
        e.code = 'WRAPPER_STALL'
        throw e
      }
      if (fatalAbortReason) {
        const e = new Error(fatalAbortReason)
        e.code = 'DOWNLOAD_FATAL'
        throw e
      }
      throw err
    }
  } finally {
    clearInterval(watchdog)
    if (state.running.get(job.id) === ctl) {
      state.running.delete(job.id)
    }
  }
}

function assertAmdpResult(result, combined) {
  if (result.code !== 0) {
    throw new Error(
      `amdp exited ${result.code}: ${result.stderr.slice(-400).trim() || 'no stderr'}`,
    )
  }

  if (/load Config failed/i.test(combined)) {
    const line =
      combined
        .split(/\r?\n/)
        .find((l) => /load Config failed/i.test(l)) || ''
    throw new Error(`amdp config error: ${line.trim()}`)
  }

  const remuxError = detectAmdpRemuxError(combined)
  if (remuxError) {
    throw new Error(remuxError)
  }
}

async function shouldFallbackAtmosToFlac(result, combined, jobStaging) {
  if (result.code !== 0) {
    return isAtmosUnavailableOutput(combined)
  }
  const files = await collectAudioFiles(jobStaging)
  return files.length === 0
}

function isAtmosUnavailableOutput(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.some((line) =>
    /atmos.*(not available|unavailable|not found|unsupported|missing|no stream|no variant)/i.test(line) ||
    /(not available|unavailable|not found|unsupported|missing|no stream|no variant).*atmos/i.test(line) ||
    /spatial.*(not available|unavailable|not found|unsupported|missing|no stream|no variant)/i.test(line) ||
    /no (dolby )?atmos/i.test(line),
  )
}

function detectAmdpRemuxError(output) {
  if (!output) return null
  const lines = String(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const patterns = [
    /Embed failed:/i,
    /exec:\s*"MP4Box":\s*executable file not found/i,
    /MP4Box.*not found/i,
    /MP4Box.*No such file/i,
    /remux.*failed/i,
  ]

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (patterns.some((re) => re.test(line))) {
      return `amdp remux/embed failed: ${line.slice(0, 260)}`
    }
  }
  return null
}

async function importPlaylistTracks({ job, jobStaging, onProgress }) {
  const settings = await readSettings().catch(() => null)
  const convention = settings?.namingConvention || 'apple'
  const candidates = await collectAudioFiles(jobStaging)
  const imported = []

  for (let i = 0; i < candidates.length; i++) {
    const srcPath = candidates[i].path
    const relParts = path
      .relative(jobStaging, srcPath)
      .split(path.sep)
      .filter(Boolean)
    const parsed = inferArtistAlbumFromPath(relParts)
    const tags = await probeAudioTags(srcPath)

    const artistName = tags.artist || parsed.artist || job.artist || 'Unknown Artist'
    const albumName = tags.album || parsed.album || null

    // Every playlist track imports into the same Artist/Album structure as
    // album and song downloads; the playlist m3u8 references these files.
    let destDir
    let targetName = path.basename(srcPath)
    if (albumName) {
      destDir = await computeFinalDir(
        MUSIC_ROOT,
        artistName,
        applyNamingConvention(stripTrailingYear(albumName), convention),
        null,
      )
      if (convention === 'qobuz') {
        const ext = path.extname(targetName)
        targetName = `${applyNamingConvention(path.basename(targetName, ext), 'qobuz')}${ext}`
      }
    } else {
      const artistDir = await resolveArtistDir(MUSIC_ROOT, artistName)
      destDir = path.join(MUSIC_ROOT, artistDir, 'Singles')
      const title = sanitizeSegment(tags.title || path.basename(srcPath, path.extname(srcPath)))
      targetName = `${title}${path.extname(srcPath)}`
    }
    await ensureDir(destDir)

    const destPath = path.join(destDir, targetName)
    await moveFileSafe(srcPath, destPath)
    await moveLyricsSidecars(srcPath, destPath)
    await copyFolderArtIfAny(path.dirname(srcPath), destDir)

    imported.push(destPath)
    onProgress?.({ done: i + 1, total: candidates.length })
  }

  return imported
}

async function collectAudioFiles(root) {
  const out = []
  await walk(root)
  out.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.path.localeCompare(b.path))
  return out

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (/\.(flac|m4a|mp3)$/i.test(entry.name)) {
        const stat = await fsp.stat(abs).catch(() => null)
        out.push({ path: abs, mtimeMs: stat?.mtimeMs || 0 })
      }
    }
  }
}

function inferArtistAlbumFromPath(parts) {
  if (parts.length >= 3) {
    return {
      artist: parts[0],
      album: parts[1],
    }
  }
  if (parts.length >= 2) {
    return {
      artist: parts[0],
      album: null,
    }
  }
  return { artist: null, album: null }
}

async function probeAudioTags(filePath) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format_tags=artist,album,title',
      '-of',
      'json',
      filePath,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  )
  if (result.status !== 0 || !result.stdout) {
    return { artist: null, album: null, title: null }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const tags = parsed?.format?.tags || {}
    return {
      artist: cleanTag(tags.artist),
      album: cleanTag(tags.album),
      title: cleanTag(tags.title),
    }
  } catch {
    return { artist: null, album: null, title: null }
  }
}

function cleanTag(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s ? s : null
}

async function moveLyricsSidecars(srcAudioPath, destAudioPath) {
  const srcBase = path.basename(srcAudioPath, path.extname(srcAudioPath))
  const destBase = path.basename(destAudioPath, path.extname(destAudioPath))
  const srcDir = path.dirname(srcAudioPath)
  const destDir = path.dirname(destAudioPath)
  for (const ext of ['.lrc', '.ttml']) {
    const src = path.join(srcDir, `${srcBase}${ext}`)
    const has = await fsp
      .stat(src)
      .then((s) => s.isFile())
      .catch(() => false)
    if (!has) continue
    const dest = path.join(destDir, `${destBase}${ext}`)
    await moveFileSafe(src, dest)
  }
}

async function copyFolderArtIfAny(srcDir, destDir) {
  const src = path.join(srcDir, 'folder.jpg')
  const exists = await fsp
    .stat(src)
    .then((s) => s.isFile())
    .catch(() => false)
  if (!exists) return
  const dest = path.join(destDir, 'folder.jpg')
  const destExists = await fsp
    .stat(dest)
    .then((s) => s.isFile())
    .catch(() => false)
  if (destExists) return
  await fsp.copyFile(src, dest).catch(() => {})
}

async function moveFileSafe(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(from, to)
      await fsp.unlink(from).catch(() => {})
    } else if (err.code === 'EEXIST') {
      await fsp.rm(to).catch(() => {})
      await fsp.rename(from, to)
    } else {
      throw err
    }
  }
}
