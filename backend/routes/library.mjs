import express from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { getAppleCooldownMs, searchCatalog } from '../lib/appleApi.mjs'
import { runInLane } from '../lib/appleGateway.mjs'
import {
  normalizeArtistName,
  readStoredArtistIds,
  storeArtistId,
} from '../lib/artistIdCache.mjs'
import { normalizeIsrc, normalizeUpc } from '../lib/audioTags.mjs'
import { emitEvent } from '../lib/eventBus.mjs'
import {
  getAlbumTrackPresence,
  invalidateLibraryCache,
  makeAlbumKey,
  makeSongKey,
  resolvePlaylistM3u8AbsPath,
  scanLibrary,
  stripTrailingYear,
} from '../lib/libraryIndex.mjs'
import { triggerNavidromeScan } from '../lib/navidromeApi.mjs'
import { readSettings } from '../lib/settingsStore.mjs'

export const libraryRouter = express.Router()

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const AUDIO_RE = /\.(flac|m4a|mp3)$/i
// Artist IDs only feed deep links, so they are never fetched while a request
// waits. Missing ones are looked up in the background, one at a time, and kept in
// library.db so a restart or a page load costs no Apple calls.
const ARTIST_RESOLVE_INTERVAL_MS = Math.max(0, Number(process.env.AMDL_ARTIST_RESOLVE_INTERVAL_MS ?? 4000))

libraryRouter.get('/', async (_req, res) => {
  try {
    const index = await scanLibrary()
    const settings = await readSettings()
    const storefront = settings?.storefront || 'us'
    const language = settings?.language || 'en-US'
    const artistIdsByName = readStoredArtistIds(storefront)
    const unresolved = new Map()
    for (const { artistName } of [...index.albums, ...index.singles]) {
      const name = String(artistName || '').trim()
      const key = normalizeArtistName(name)
      if (key && artistIdsByName && !artistIdsByName.has(key)) unresolved.set(key, name)
    }
    queueArtistResolution(storefront, language, unresolved)

    const singles = index.singles.map((s) => ({
      ...s,
      artistId: artistIdsByName?.get(normalizeArtistName(s.artistName)) || null,
    }))
    const albums = index.albums.map((a) => ({
      ...a,
      artistId: artistIdsByName?.get(normalizeArtistName(a.artistName)) || null,
    }))

    res.json({
      albums,
      singles,
      playlists: index.playlists || [],
      albumKeys: Array.from(index.albumKeys || []),
      songKeys: Array.from(index.songKeys || []),
      playlistIds: Array.from(index.playlistIds || []),
      isrcs: Array.from(index.isrcs || []),
      upcs: Array.from(index.upcs || []),
      albumVersionGroups: Object.fromEntries(
        Array.from(index.albumVersionGroups || [], ([k, v]) => [k, Array.from(v)]),
      ),
      totals: {
        albums: albums.length,
        singles: singles.length,
        playlists: (index.playlists || []).length,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

libraryRouter.post('/presence', async (req, res) => {
  try {
    const albumChecks = Array.isArray(req.body?.albums) ? req.body.albums : []
    const songChecks = Array.isArray(req.body?.songs) ? req.body.songs : []
    const playlistChecks = Array.isArray(req.body?.playlists) ? req.body.playlists : []
    const index = await scanLibrary()

    const albums = {}
    for (const item of albumChecks) {
      const id = String(item?.id || '')
      if (!id) continue
      const artistName = String(item?.artistName || '')
      const albumName = stripTrailingYear(String(item?.albumName || ''))
      const upcNorm = normalizeUpc(item?.upc)
      const key = makeAlbumKey(artistName, albumName)
      albums[id] = Boolean(
        (key && index.albumKeys.has(key)) ||
          (upcNorm && index.upcs?.has(upcNorm)),
      )
    }

    const songs = {}
    for (const item of songChecks) {
      const id = String(item?.id || '')
      if (!id) continue
      const artistName = String(item?.artistName || '')
      const songName = String(item?.songName || '')
      const isrcNorm = normalizeIsrc(item?.isrc)
      songs[id] = Boolean(
        index.songKeys.has(makeSongKey(artistName, songName)) ||
          (isrcNorm && index.isrcs?.has(isrcNorm)),
      )
    }

    const playlists = {}
    for (const item of playlistChecks) {
      const id = String(item?.id || '')
      if (!id) continue
      playlists[id] = index.playlistIds.has(id)
    }

    const albumTrackChecks = Array.isArray(req.body?.albumTracks)
      ? req.body.albumTracks
      : []
    const albumTracks = {}
    for (const item of albumTrackChecks) {
      const id = String(item?.id || '')
      if (!id) continue
      const artistName = String(item?.artistName || '')
      const albumName = stripTrailingYear(String(item?.albumName || ''))
      const tracks = Array.isArray(item?.tracks) ? item.tracks : []
      albumTracks[id] = await getAlbumTrackPresence(
        artistName,
        albumName,
        tracks,
        index,
      )
    }

    res.json({ albums, songs, playlists, albumTracks })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

libraryRouter.delete('/song', async (req, res) => {
  try {
    const relPath = String(req.body?.relPath || '')
    const parts = relParts(relPath)
    if (parts.length !== 3 || parts[1].toLowerCase() !== 'singles') {
      return res.status(400).json({ error: 'invalid song path' })
    }
    if (parts.some((p) => p.startsWith('.'))) {
      return res.status(400).json({ error: 'invalid song path' })
    }
    if (!AUDIO_RE.test(parts[2])) {
      return res.status(400).json({ error: 'audio file required' })
    }

    const abs = resolveUnderMusicRoot(relPath)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) {
      return res.status(404).json({ error: 'song not found' })
    }

    await fsp.unlink(abs)
    const lrcPath = path.join(
      path.dirname(abs),
      `${path.basename(abs, path.extname(abs))}.lrc`,
    )
    const removedLyrics = await fsp.unlink(lrcPath).then(() => true).catch(() => false)

    invalidateLibraryCache()
    emitEvent('library.changed', {
      kind: 'song-deleted',
      artistName: parts[0],
      songName: path.basename(parts[2], path.extname(parts[2])),
    })
    triggerNavidromeScan().catch(console.error)

    return res.json({ ok: true, removedLyrics })
  } catch (err) {
    if (err.message === 'out of music root') {
      return res.status(400).json({ error: 'invalid path' })
    }
    return res.status(500).json({ error: err.message })
  }
})

libraryRouter.delete('/playlist', async (req, res) => {
  try {
    const relPath = String(req.body?.relPath || '')
    const absPath = resolvePlaylistM3u8AbsPath(MUSIC_ROOT, relPath)

    await fsp.unlink(absPath)

    const playlistsDir = path.dirname(absPath)
    const stem = path.basename(absPath, path.extname(absPath))
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      await fsp.unlink(path.join(playlistsDir, `${stem}${ext}`)).catch(() => null)
    }
    const companionDir = path.join(playlistsDir, stem)
    const dirStat = await fsp.stat(companionDir).catch(() => null)
    if (dirStat?.isDirectory()) {
      await fsp.rm(companionDir, { recursive: true, force: true })
    }

    invalidateLibraryCache()
    emitEvent('library.changed', {
      kind: 'playlist-deleted',
      relPath: path.relative(MUSIC_ROOT, absPath).split(path.sep).join('/'),
    })
    triggerNavidromeScan().catch(console.error)

    return res.json({ ok: true })
  } catch (err) {
    if (
      err.message === 'invalid playlist path' ||
      err.message === 'not an m3u8 file' ||
      err.message === 'out of playlists directory'
    ) {
      return res.status(400).json({ error: err.message })
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'playlist not found' })
    }
    return res.status(500).json({ error: err.message })
  }
})

libraryRouter.delete('/album', async (req, res) => {
  try {
    const relPath = String(req.body?.relPath || '')
    const parts = relParts(relPath)
    if (parts.length !== 2) {
      return res.status(400).json({ error: 'invalid album path' })
    }
    if (parts.some((p) => p.startsWith('.'))) {
      return res.status(400).json({ error: 'invalid album path' })
    }
    if (parts[1].toLowerCase() === 'singles') {
      return res.status(400).json({ error: 'use song delete for singles' })
    }

    const abs = resolveUnderMusicRoot(relPath)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      return res.status(404).json({ error: 'album not found' })
    }

    await fsp.rm(abs, { recursive: true, force: true })
    invalidateLibraryCache()
    emitEvent('library.changed', {
      kind: 'album-deleted',
      artistName: parts[0],
      albumName: parts[1],
    })
    triggerNavidromeScan().catch(console.error)
    return res.json({ ok: true })
  } catch (err) {
    if (err.message === 'out of music root') {
      return res.status(400).json({ error: 'invalid path' })
    }
    return res.status(500).json({ error: err.message })
  }
})

function relParts(relPath) {
  return String(relPath || '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function resolveUnderMusicRoot(relPath) {
  const root = path.resolve(MUSIC_ROOT)
  const abs = path.resolve(root, relPath)
  if (!(abs === root || abs.startsWith(`${root}${path.sep}`))) {
    throw new Error('out of music root')
  }
  return abs
}

const resolveQueue = new Map()
let resolverRunning = false

function queueArtistResolution(storefront, language, unresolved) {
  for (const [key, name] of unresolved) {
    resolveQueue.set(`${storefront}::${key}`, { storefront, language, key, name })
  }
  if (!resolverRunning && resolveQueue.size > 0) void runInLane('background', runArtistResolver)
}

const pause = () =>
  new Promise((resolve) => setTimeout(resolve, ARTIST_RESOLVE_INTERVAL_MS).unref())

// One paced search. Whatever name(s) Apple returns for the matched artist, in whatever
// language, are kept as extra keys for the same ID; no extra request is made for them.
async function lookupArtist(item) {
  const raw = await searchCatalog({
    storefront: item.storefront,
    term: item.name,
    types: 'artists',
    limit: 10,
    offset: 0,
    language: item.language,
  })
  const candidates = raw?.results?.artists?.data || []
  const artistId = pickBestArtistId(item.name, candidates)
  const names = candidates
    .filter((c) => artistId && String(c?.id) === artistId)
    .map((c) => c?.attributes?.name)
  return { artistId, names }
}

// One lookup per ARTIST_RESOLVE_INTERVAL_MS. Any Apple 429 (or an active
// cooldown) stops the run and drops the queue; the next library load re-queues
// whatever is still unresolved.
async function runArtistResolver() {
  resolverRunning = true
  try {
    while (resolveQueue.size > 0) {
      if (getAppleCooldownMs() > 0) break
      const [queueKey, item] = resolveQueue.entries().next().value
      resolveQueue.delete(queueKey)
      try {
        const { artistId, names } = await lookupArtist(item)
        storeArtistId(item.storefront, item.key, artistId)
        // Every name Apple gave this artist (one per language tried) is a key too.
        for (const name of names) {
          const alias = normalizeArtistName(name)
          if (alias && alias !== item.key) storeArtistId(item.storefront, alias, artistId)
        }
      } catch (err) {
        console.warn(`[library] artist lookup for "${item.name}" failed: ${err.message}`)
        if (/Apple API 429/.test(err.message)) break
      }
      await pause()
    }
  } finally {
    resolveQueue.clear()
    resolverRunning = false
  }
}

function pickBestArtistId(targetName, candidates) {
  const targetNorm = normalizeArtistName(targetName)
  const targetLower = String(targetName || '').toLowerCase().trim()
  const targetTokens = tokenizeArtistName(targetName)
  if (!targetNorm) return null

  const scored = candidates
    .map((c) => {
      const name = String(c?.attributes?.name || '').trim()
      const id = String(c?.id || '').trim()
      if (!name || !id) return null

      const norm = normalizeArtistName(name)
      const lower = name.toLowerCase()
      const tokens = tokenizeArtistName(name)
      let score = 0

      if (norm === targetNorm) score += 100
      if (lower === targetLower) score += 20
      if (norm.startsWith(targetNorm) || targetNorm.startsWith(norm)) score += 25
      if (lower.includes(targetLower) || targetLower.includes(lower)) score += 12

      if (targetTokens.length > 0) {
        const overlap = tokenOverlap(targetTokens, tokens)
        score += overlap * 35
      }

      return { id, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return null
  const best = scored[0]
  const second = scored[1]
  if (best.score < 80) return null
  if (second && best.score - second.score < 10) return null
  return best.id
}

function tokenizeArtistName(value) {
  return normalizeArtistName(value)
    .split(' ')
    .filter((t) => t.length > 1)
}

function tokenOverlap(a, b) {
  if (a.length === 0) return 0
  const setB = new Set(b)
  let common = 0
  for (const token of a) {
    if (setB.has(token)) common++
  }
  return common / a.length
}
