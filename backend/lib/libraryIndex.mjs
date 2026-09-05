import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  makeAlbumMatchKey,
  makeSongMatchKey,
  stripTrailingYear,
} from './libraryMatchKey.mjs'

export { stripTrailingYear }

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const AUDIO_RE = /\.(flac|m4a|mp3)$/i

const SCAN_TTL_MS = 30_000
let _scanCache = null
let _scanCacheAt = 0

async function getCachedIndex() {
  const now = Date.now()
  if (_scanCache && now - _scanCacheAt < SCAN_TTL_MS) return _scanCache
  _scanCache = await scanLibrary()
  _scanCacheAt = now
  return _scanCache
}

export function invalidateLibraryCache() {
  _scanCache = null
  _scanCacheAt = 0
}

export async function scanLibraryOnce() {
  return getCachedIndex()
}

export async function scanLibrary() {
  const albums = []
  const singles = []
  const albumKeys = new Set()
  const songKeys = new Set()
  const albumTrackKeys = new Map()
  const singlesSongKeys = new Set()
  const playlistIds = new Set()
  const playlists = []

  const playlistsDir = path.join(MUSIC_ROOT, 'Playlists')
  const playlistEntries = await readDirSafe(playlistsDir)
  for (const entry of playlistEntries) {
    if (!entry.isFile() || !/\.m3u8$/i.test(entry.name)) continue
    const absPath = path.join(playlistsDir, entry.name)
    const meta = await readPlaylistM3uFileMeta(absPath)
    if (meta.catalogPlaylistId) playlistIds.add(meta.catalogPlaylistId)
    if (meta.libraryPlaylistId) playlistIds.add(meta.libraryPlaylistId)
    const relPath = toRel(absPath)
    const fileStat = await fsp.stat(absPath).catch(() => null)
    const addedAt = Math.round(
      fileStat?.mtimeMs || fileStat?.ctimeMs || fileStat?.birthtimeMs || 0,
    )
    const displayName =
      meta.playlistTitle ||
      path.basename(entry.name, path.extname(entry.name)) ||
      entry.name
    playlists.push({
      id: relPath,
      relPath,
      fileName: entry.name,
      playlistName: displayName,
      catalogPlaylistId: meta.catalogPlaylistId,
      libraryPlaylistId: meta.libraryPlaylistId,
      trackCount: meta.trackCount,
      addedAt,
    })
  }

  playlists.sort((a, b) =>
    `${a.playlistName}\u0000${a.relPath}`.localeCompare(
      `${b.playlistName}\u0000${b.relPath}`,
      undefined,
      { sensitivity: 'base' },
    ),
  )

  const artists = await readDirSafe(MUSIC_ROOT)
  for (const artistEntry of artists) {
    if (!artistEntry.isDirectory()) continue
    if (artistEntry.name.startsWith('.')) continue
    if (artistEntry.name === 'Playlists') continue

    const artistName = artistEntry.name
    const artistPath = path.join(MUSIC_ROOT, artistName)
    const children = await readDirSafe(artistPath)

    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('.')) continue

      const childPath = path.join(artistPath, child.name)
      if (child.name.toLowerCase() === 'singles') {
        const files = await readDirSafe(childPath)
        for (const file of files) {
          if (!file.isFile() || !AUDIO_RE.test(file.name)) continue

          const audioPath = path.join(childPath, file.name)
          const songName = path.basename(file.name, path.extname(file.name))
          const relPath = toRel(audioPath)
          const hasLyrics = await hasSiblingLrc(audioPath)
          const songStat = await fsp.stat(audioPath).catch(() => null)
          const addedAt = Math.round(
            songStat?.mtimeMs || songStat?.ctimeMs || songStat?.birthtimeMs || 0,
          )

          singles.push({
            id: relPath,
            artistName,
            songName,
            relPath,
            hasLyrics,
            addedAt,
          })
          const songKey = makeSongKey(artistName, songName)
          if (songKey) {
            songKeys.add(songKey)
            singlesSongKeys.add(songKey)
          }
        }
        continue
      }

      const files = await readDirSafe(childPath)
      const audioFiles = files.filter((f) => f.isFile() && AUDIO_RE.test(f.name))
      if (audioFiles.length === 0) continue

      let lyricsCount = 0
      for (const file of audioFiles) {
        const audioPath = path.join(childPath, file.name)
        if (await hasSiblingLrc(audioPath)) lyricsCount++
      }

      const relPath = toRel(childPath)
      const albumName = child.name
      const albumStat = await fsp.stat(childPath).catch(() => null)
      const addedAt = Math.round(
        albumStat?.mtimeMs || albumStat?.ctimeMs || albumStat?.birthtimeMs || 0,
      )
      albums.push({
        id: relPath,
        artistName,
        albumName,
        relPath,
        trackCount: audioFiles.length,
        lyricsCount,
        hasLyrics: lyricsCount > 0,
        addedAt,
      })
      const albumKey = makeAlbumKey(artistName, albumName)
      albumKeys.add(albumKey)
      const trackSet = new Set()
      for (const file of audioFiles) {
        const songName = songNameFromFilename(file.name)
        if (!songName) continue
        const songKey = makeSongKey(artistName, songName)
        if (!songKey) continue
        songKeys.add(songKey)
        trackSet.add(songKey)
      }
      if (albumKey) albumTrackKeys.set(albumKey, trackSet)
    }
  }

  singles.sort((a, b) =>
    `${a.artistName}\u0000${a.songName}`.localeCompare(
      `${b.artistName}\u0000${b.songName}`,
    ),
  )
  albums.sort((a, b) =>
    `${a.artistName}\u0000${a.albumName}`.localeCompare(
      `${b.artistName}\u0000${b.albumName}`,
    ),
  )

  return {
    albums,
    singles,
    albumKeys,
    songKeys,
    albumTrackKeys,
    singlesSongKeys,
    playlistIds,
    playlists,
  }
}

export function songNameFromFilename(filename) {
  if (!filename) return ''
  let base = String(filename).replace(/\.(flac|m4a|mp3)$/i, '')
  // Strip leading "NN. " or "NN - " or "NN " track-number prefix.
  base = base.replace(/^\s*\d{1,3}\s*[.\-]?\s+/, '')
  // Strip the [E]/[C]/[M] choice tags amdp may append.
  base = base.replace(/\s*\[[ECM]\]\s*$/i, '')
  return base.trim()
}

export function parsePlaylistM3uText(text) {
  const lines = String(text || '').split(/\r?\n/)
  let playlistTitle = null
  let catalogPlaylistId = null
  let libraryPlaylistId = null
  let trackCount = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const extInf = trimmed.match(/^#EXTINF:/)
    if (extInf) {
      continue
    }
    if (trimmed.startsWith('#')) {
      const playM = trimmed.match(/^#PLAYLIST:(.+)$/)
      if (playM) {
        playlistTitle = playM[1].trim()
        continue
      }
      const catalogM = trimmed.match(/^#ALACARTE_PLAYLIST_ID:(.+)$/)
      if (catalogM) {
        catalogPlaylistId = catalogM[1].trim()
        continue
      }
      const libM = trimmed.match(/^#ALACARTE_LIBRARY_PLAYLIST_ID:(.+)$/)
      if (libM) {
        libraryPlaylistId = libM[1].trim()
        continue
      }
      continue
    }
    trackCount++
  }

  return {
    playlistTitle: playlistTitle || null,
    catalogPlaylistId: catalogPlaylistId || null,
    libraryPlaylistId: libraryPlaylistId || null,
    trackCount,
  }
}

async function readPlaylistM3uFileMeta(absPath) {
  try {
    const text = await fsp.readFile(absPath, 'utf8')
    return parsePlaylistM3uText(text)
  } catch {
    return {
      playlistTitle: null,
      catalogPlaylistId: null,
      libraryPlaylistId: null,
      trackCount: 0,
    }
  }
}

export function resolvePlaylistM3u8AbsPath(musicRoot, relPath) {
  const root = path.resolve(String(musicRoot || ''))
  const playlistsRoot = path.join(root, 'Playlists')
  const normalized = String(relPath || '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (normalized.length === 0) {
    throw new Error('invalid playlist path')
  }
  if (normalized.some((p) => p.startsWith('.'))) {
    throw new Error('invalid playlist path')
  }
  const abs = path.resolve(root, ...normalized)
  if (!(abs === playlistsRoot || abs.startsWith(`${playlistsRoot}${path.sep}`))) {
    throw new Error('out of playlists directory')
  }
  if (!/\.m3u8$/i.test(abs)) {
    throw new Error('not an m3u8 file')
  }
  return abs
}

export async function purgePlaylistExportsSharingIds(
  musicRoot,
  { playlistId, libraryPlaylistId, keepAbsPath },
) {
  const playlistsDir = path.join(musicRoot, 'Playlists')
  const catalogStr = playlistId ? String(playlistId).trim() : ''
  const libraryStr = libraryPlaylistId ? String(libraryPlaylistId).trim() : ''
  if (!catalogStr && !libraryStr) return

  const entries = await readDirSafe(playlistsDir)
  const keepResolved = keepAbsPath ? path.resolve(keepAbsPath) : null

  for (const entry of entries) {
    if (!entry.isFile() || !/\.m3u8$/i.test(entry.name)) continue
    const abs = path.join(playlistsDir, entry.name)
    if (keepResolved && path.resolve(abs) === keepResolved) continue
    const meta = await readPlaylistM3uFileMeta(abs)
    const matchCatalog = Boolean(catalogStr && meta.catalogPlaylistId === catalogStr)
    const matchLibrary = Boolean(libraryStr && meta.libraryPlaylistId === libraryStr)
    if (matchCatalog || matchLibrary) {
      await fsp.unlink(abs).catch(() => null)
      const stem = path.basename(abs, path.extname(abs))
      for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        await fsp.unlink(path.join(playlistsDir, `${stem}${ext}`)).catch(() => null)
      }
      const companionDir = path.join(playlistsDir, stem)
      const companionStat = await fsp.stat(companionDir).catch(() => null)
      if (companionStat?.isDirectory()) {
        await fsp.rm(companionDir, { recursive: true, force: true }).catch(() => null)
      }
    }
  }
}

export async function isPlaylistInLibrary(playlistId, preScannedIndex = null) {
  if (!playlistId) return false
  const index = preScannedIndex || (await getCachedIndex())
  return index.playlistIds.has(String(playlistId))
}

export async function hasAlbumInLibrary(artistName, albumName, preScannedIndex = null) {
  const key = makeAlbumKey(artistName, stripTrailingYear(albumName))
  if (!key) return false
  const index = preScannedIndex || (await getCachedIndex())
  return index.albumKeys.has(key)
}

export async function getAlbumTrackPresence(artistName, albumName, tracks, preScannedIndex = null) {
  const index = preScannedIndex || (await getCachedIndex())
  const albumKey = makeAlbumKey(artistName, albumName)
  const albumTrackSet = albumKey ? index.albumTrackKeys.get(albumKey) || null : null
  const singlesSet = index.singlesSongKeys || new Set()
  const present = {}
  let count = 0
  for (const track of tracks || []) {
    const id = String(track?.id || '')
    if (!id) continue
    const songKey = makeSongKey(artistName, track?.name || '')
    const has = Boolean(
      songKey && ((albumTrackSet && albumTrackSet.has(songKey)) || singlesSet.has(songKey)),
    )
    present[id] = has
    if (has) count += 1
  }
  const expected = (tracks || []).length
  return {
    tracks: present,
    present: count,
    expected,
    complete: expected > 0 && count === expected && Boolean(albumTrackSet),
    folderExists: Boolean(albumTrackSet),
  }
}

export async function hasSongInLibrary(artistName, songName, preScannedIndex = null) {
  const key = makeSongKey(artistName, songName)
  if (!key) return false
  const index = preScannedIndex || (await getCachedIndex())
  return index.songKeys.has(key)
}

export function makeAlbumKey(artistName, albumName) {
  return makeAlbumMatchKey(artistName, albumName)
}

export function makeSongKey(artistName, songName) {
  return makeSongMatchKey(artistName, songName)
}

async function hasSiblingLrc(audioPath) {
  const lrcPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.lrc`,
  )
  const stat = await fsp.stat(lrcPath).catch(() => null)
  return Boolean(stat?.isFile())
}

function readDirSafe(dir) {
  return fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
}

function toRel(absPath) {
  return path.relative(MUSIC_ROOT, absPath).split(path.sep).join('/')
}
