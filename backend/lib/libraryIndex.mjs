import fsp from 'node:fs/promises'
import path from 'node:path'

import { normalizeIsrc, normalizeUpc, readAudioIdentityTags } from './audioTags.mjs'
import { getDb, getMeta, setMeta } from './db.mjs'
import {
  makeAlbumMatchKey,
  makeSongMatchKey,
  stripTrailingYear,
} from './libraryMatchKey.mjs'

export { stripTrailingYear }

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const AUDIO_RE = /\.(flac|m4a|mp3)$/i

const SCAN_TTL_MS = 30_000
// Even with incremental tracking, walk everything periodically so external
// edits (re-tagged files, mtime-preserving moves) are eventually picked up.
const FULL_RESCAN_MS =
  Math.max(1, Number(process.env.AMDL_FULL_RESCAN_HOURS) || 24) *
  60 *
  60 *
  1000

let _scanCache = null
let _scanCacheAt = 0

export function getMusicRoot() {
  return MUSIC_ROOT
}

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

function tryGetDb() {
  try {
    return getDb()
  } catch (err) {
    console.error('sqlite unavailable, library scans stay ephemeral:', err.message)
    return null
  }
}

export async function scanLibrary() {
  const db = tryGetDb()
  if (!db) return walkLibrary('ephemeral')
  const lastFull = Number(getMeta('library_last_full_scan') || 0)
  const mode = Date.now() - lastFull > FULL_RESCAN_MS ? 'full' : 'incremental'
  const result = await walkLibrary(mode)
  if (mode === 'full') setMeta('library_last_full_scan', String(Date.now()))
  return result
}

function emptyIndex() {
  return {
    albums: [],
    singles: [],
    albumKeys: new Set(),
    songKeys: new Set(),
    albumTrackKeys: new Map(),
    singlesSongKeys: new Set(),
    playlistIds: new Set(),
    playlists: [],
    isrcs: new Set(),
    upcs: new Set(),
    songPaths: new Map(),
  }
}

function statSafe(p) {
  return fsp.stat(p).catch(() => null)
}

function addedAtFromStat(st) {
  return Math.round(st?.mtimeMs || st?.ctimeMs || st?.birthtimeMs || 0)
}

// Walks the music library and aggregates the index. Modes:
//  - 'ephemeral': no DB, everything read fresh (legacy behavior)
//  - 'full':      read everything fresh and (re)write the SQLite cache
//  - 'incremental': skip directories whose mtime is unchanged in the cache,
//                   reuse file rows unless mtime/size changed; tags are only
//                   read for new or changed files, keeping tag I/O bounded
async function walkLibrary(mode) {
  const acc = emptyIndex()
  const db = mode === 'ephemeral' ? null : getDb()
  const useCache = mode === 'incremental'
  const persist = mode !== 'ephemeral'
  const ctx = { db, mode, useCache, persist }

  if (mode === 'full') {
    db.exec('DELETE FROM library_files')
    db.exec('DELETE FROM library_dirs')
  }

  await scanPlaylistsDir(ctx, acc)

  const seenArtistDirs = new Set()
  const artistEntries = await readDirSafe(MUSIC_ROOT)
  for (const artistEntry of artistEntries) {
    if (!artistEntry.isDirectory()) continue
    if (artistEntry.name.startsWith('.')) continue
    if (artistEntry.name === 'Playlists') continue

    const artistName = artistEntry.name
    const artistPath = path.join(MUSIC_ROOT, artistName)
    seenArtistDirs.add(artistPath)
    const artistStat = await statSafe(artistPath)
    const cachedArtist = useCache ? getDirRow(db, artistPath) : null

    if (
      cachedArtist &&
      artistStat &&
      Math.round(artistStat.mtimeMs) === cachedArtist.mtime
    ) {
      // Artist dir untouched: revisit its album/singles dirs only if their
      // own mtime moved (contents can change without touching the parent).
      for (const child of getDirRowsByParent(db, artistPath)) {
        const childStat = await statSafe(child.path)
        if (
          childStat?.isDirectory() &&
          Math.round(childStat.mtimeMs) === child.mtime
        ) {
          aggregateAudioDirFromRows(
            listFileRowsByParent(db, child.path),
            child.kind,
            artistName,
            child.path,
            child.mtime,
            acc,
          )
        } else {
          await scanAudioDir(child.path, child.kind, artistName, ctx, acc)
        }
      }
      continue
    }

    const children = await readDirSafe(artistPath)
    const seenChildPaths = new Set()
    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name.startsWith('.')) continue
      const childPath = path.join(artistPath, child.name)
      const kind = child.name.toLowerCase() === 'singles' ? 'singles' : 'album'
      seenChildPaths.add(childPath)
      await scanAudioDir(childPath, kind, artistName, ctx, acc)
    }
    if (persist) {
      deleteDirRowsNotIn(db, artistPath, seenChildPaths)
      upsertDirRow(db, artistPath, artistStat, 'artist', MUSIC_ROOT)
    }
  }

  if (persist) {
    cleanupVanishedArtists(db, seenArtistDirs)
    // Invariant sweep: every audio row must belong to a tracked directory.
    db.exec(
      `DELETE FROM library_files WHERE kind IN ('album','single')
       AND parent NOT IN (SELECT path FROM library_dirs)`,
    )
  }

  acc.albums.sort((a, b) =>
    `${a.artistName}\u0000${a.albumName}`.localeCompare(
      `${b.artistName}\u0000${b.albumName}`,
    ),
  )
  acc.singles.sort((a, b) =>
    `${a.artistName}\u0000${a.songName}`.localeCompare(
      `${b.artistName}\u0000${b.songName}`,
    ),
  )
  acc.playlists.sort((a, b) =>
    `${a.playlistName}\u0000${a.relPath}`.localeCompare(
      `${b.playlistName}\u0000${b.relPath}`,
      undefined,
      { sensitivity: 'base' },
    ),
  )
  return acc
}

async function scanPlaylistsDir(ctx, acc) {
  const playlistsDir = path.join(MUSIC_ROOT, 'Playlists')
  const dirStat = await statSafe(playlistsDir)
  if (!dirStat?.isDirectory()) return

  const cachedDir = ctx.useCache ? getDirRow(ctx.db, playlistsDir) : null
  if (cachedDir && Math.round(dirStat.mtimeMs) === cachedDir.mtime) {
    for (const row of listFileRowsByParent(ctx.db, playlistsDir)) {
      aggregatePlaylistRow(row, acc)
    }
    return
  }

  const entries = await readDirSafe(playlistsDir)
  const existingRows = ctx.useCache
    ? getFileRowsByParent(ctx.db, playlistsDir)
    : new Map()
  const seen = new Set()
  for (const entry of entries) {
    if (!entry.isFile() || !/\.m3u8$/i.test(entry.name)) continue
    const absPath = path.join(playlistsDir, entry.name)
    const st = await statSafe(absPath)
    if (!st) continue
    seen.add(absPath)
    const mtime = Math.round(st.mtimeMs)
    const size = Number(st.size)
    let row = existingRows.get(absPath)
    if (!row || row.mtime !== mtime || row.size !== size) {
      const meta = await readPlaylistM3uFileMeta(absPath)
      row = makeFileRow({
        path: absPath,
        parent: playlistsDir,
        mtime,
        size,
        kind: 'playlist',
        meta: { ...meta, addedAt: addedAtFromStat(st) },
      })
      if (ctx.persist) upsertFileRow(ctx.db, row)
    }
    aggregatePlaylistRow(row, acc)
  }
  if (ctx.persist) {
    deleteFileRowsNotIn(ctx.db, playlistsDir, seen)
    upsertDirRow(ctx.db, playlistsDir, dirStat, 'playlists', MUSIC_ROOT)
  }
}

async function scanAudioDir(dirPath, kind, artistName, ctx, acc) {
  const dirStat = await statSafe(dirPath)
  if (!dirStat?.isDirectory()) return

  const cachedDir = ctx.useCache ? getDirRow(ctx.db, dirPath) : null
  if (cachedDir && Math.round(dirStat.mtimeMs) === cachedDir.mtime) {
    aggregateAudioDirFromRows(
      listFileRowsByParent(ctx.db, dirPath),
      kind,
      artistName,
      dirPath,
      cachedDir.mtime,
      acc,
    )
    return
  }

  const entries = await readDirSafe(dirPath)
  const existingRows = ctx.useCache
    ? getFileRowsByParent(ctx.db, dirPath)
    : new Map()
  const seen = new Set()
  const rows = []
  for (const file of entries) {
    if (!file.isFile() || !AUDIO_RE.test(file.name)) continue
    const audioPath = path.join(dirPath, file.name)
    const st = await statSafe(audioPath)
    if (!st) continue
    seen.add(audioPath)
    const mtime = Math.round(st.mtimeMs)
    const size = Number(st.size)
    let row = existingRows.get(audioPath)
    if (!row || row.mtime !== mtime || row.size !== size) {
      const songName =
        kind === 'album'
          ? songNameFromFilename(file.name)
          : path.basename(file.name, path.extname(file.name))
      const albumName = kind === 'album' ? path.basename(dirPath) : null
      const songKey = songName ? makeSongKey(artistName, songName) : ''
      const albumKey =
        kind === 'album' ? makeAlbumKey(artistName, albumName) : ''
      const hasLyrics = await hasSiblingLrc(audioPath)
      let tags = {}
      try {
        tags = await readAudioIdentityTags(audioPath)
      } catch {}
      row = makeFileRow({
        path: audioPath,
        parent: dirPath,
        mtime,
        size,
        kind,
        artistName,
        albumName,
        songName,
        songKey,
        albumKey,
        isrc: tags.isrc || null,
        upc: tags.upc || null,
        meta: { hasLyrics },
      })
      if (ctx.persist) upsertFileRow(ctx.db, row)
    }
    rows.push(row)
  }
  aggregateAudioDirFromRows(rows, kind, artistName, dirPath, addedAtFromStat(dirStat), acc)
  if (ctx.persist) {
    deleteFileRowsNotIn(ctx.db, dirPath, seen)
    upsertDirRow(ctx.db, dirPath, dirStat, kind, path.dirname(dirPath))
  }
}

function makeFileRow({
  path: rowPath,
  parent,
  mtime,
  size,
  kind,
  artistName = null,
  albumName = null,
  songName = null,
  songKey = null,
  albumKey = null,
  isrc = null,
  upc = null,
  meta = {},
}) {
  return {
    path: rowPath,
    parent,
    mtime,
    size,
    kind,
    artist_name: artistName,
    album_name: albumName,
    song_name: songName,
    song_key: songKey || null,
    album_key: albumKey || null,
    isrc: isrc ? normalizeIsrc(isrc) : null,
    upc: upc ? normalizeUpc(upc) : null,
    meta: JSON.stringify(meta || {}),
  }
}

function parseFileRow(row) {
  let meta = {}
  try {
    meta = JSON.parse(row.meta || '{}')
  } catch {}
  return { ...row, metaParsed: meta }
}

function aggregateAudioDirFromRows(rawRows, kind, artistName, dirPath, dirAddedAt, acc) {
  const rows = rawRows.map(parseFileRow)
  if (rows.length === 0) return
  const rel = toRel(dirPath)

  if (kind === 'album') {
    const albumName = rows[0].album_name || path.basename(dirPath)
    let lyricsCount = 0
    const trackSet = new Set()
    for (const row of rows) {
      if (row.metaParsed.hasLyrics) lyricsCount += 1
      if (row.song_key) trackSet.add(row.song_key)
    }
    acc.albums.push({
      id: rel,
      artistName,
      albumName,
      relPath: rel,
      trackCount: rows.length,
      lyricsCount,
      hasLyrics: lyricsCount > 0,
      addedAt: dirAddedAt,
    })
    const albumKey = makeAlbumKey(artistName, albumName)
    if (albumKey) {
      acc.albumKeys.add(albumKey)
      acc.albumTrackKeys.set(albumKey, trackSet)
    }
  } else {
    for (const row of rows) {
      acc.singles.push({
        id: toRel(row.path),
        artistName,
        songName: row.song_name || '',
        relPath: toRel(row.path),
        hasLyrics: Boolean(row.metaParsed.hasLyrics),
        addedAt: row.mtime,
      })
      if (row.song_key) acc.singlesSongKeys.add(row.song_key)
    }
  }

  for (const row of rows) {
    if (row.song_key) {
      acc.songKeys.add(row.song_key)
      if (!acc.songPaths.has(row.song_key)) {
        acc.songPaths.set(row.song_key, toRel(row.path))
      }
    }
    if (row.isrc) acc.isrcs.add(row.isrc)
    if (row.upc) acc.upcs.add(row.upc)
  }
}

function aggregatePlaylistRow(rawRow, acc) {
  const row = parseFileRow(rawRow)
  const meta = row.metaParsed
  if (meta.catalogPlaylistId) acc.playlistIds.add(meta.catalogPlaylistId)
  if (meta.libraryPlaylistId) acc.playlistIds.add(meta.libraryPlaylistId)
  const fileName = path.basename(row.path)
  const relPath = toRel(row.path)
  acc.playlists.push({
    id: relPath,
    relPath,
    fileName,
    playlistName:
      meta.playlistTitle ||
      path.basename(fileName, path.extname(fileName)) ||
      fileName,
    catalogPlaylistId: meta.catalogPlaylistId || null,
    libraryPlaylistId: meta.libraryPlaylistId || null,
    trackCount: Number(meta.trackCount || 0),
    addedAt: Number(meta.addedAt || row.mtime),
  })
}

const stmtCache = new WeakMap()

function stmt(db, sql) {
  let cache = stmtCache.get(db)
  if (!cache) {
    cache = new Map()
    stmtCache.set(db, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

function upsertDirRow(db, dirPath, stat, kind, parent) {
  stmt(
    db,
    `INSERT INTO library_dirs (path, mtime, kind, parent) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, kind = excluded.kind, parent = excluded.parent`,
  ).run(dirPath, Math.round(stat?.mtimeMs || 0), kind, parent)
}

function getDirRow(db, dirPath) {
  return stmt(db, 'SELECT path, mtime, kind, parent FROM library_dirs WHERE path = ?').get(dirPath) || null
}

function getDirRowsByParent(db, parent) {
  return stmt(db, 'SELECT path, mtime, kind, parent FROM library_dirs WHERE parent = ?').all(parent)
}

function deleteDirRowsNotIn(db, parent, seenPaths) {
  const existing = getDirRowsByParent(db, parent)
  for (const row of existing) {
    if (seenPaths.has(row.path)) continue
    stmt(db, 'DELETE FROM library_files WHERE parent = ?').run(row.path)
    stmt(db, 'DELETE FROM library_dirs WHERE path = ?').run(row.path)
  }
}

function cleanupVanishedArtists(db, seenArtistDirs) {
  const rows = stmt(db, "SELECT path FROM library_dirs WHERE kind = 'artist'").all()
  for (const row of rows) {
    if (seenArtistDirs.has(row.path)) continue
    const childDirs = getDirRowsByParent(db, row.path).map((c) => c.path)
    for (const child of childDirs) {
      stmt(db, 'DELETE FROM library_files WHERE parent = ?').run(child)
    }
    stmt(db, 'DELETE FROM library_files WHERE parent = ?').run(row.path)
    stmt(db, 'DELETE FROM library_dirs WHERE parent = ?').run(row.path)
    stmt(db, 'DELETE FROM library_dirs WHERE path = ?').run(row.path)
  }
}

function upsertFileRow(db, row) {
  stmt(
    db,
    `INSERT INTO library_files
       (path, parent, mtime, size, kind, artist_name, album_name, song_name, song_key, album_key, isrc, upc, meta)
     VALUES (@path, @parent, @mtime, @size, @kind, @artist_name, @album_name, @song_name, @song_key, @album_key, @isrc, @upc, @meta)
     ON CONFLICT(path) DO UPDATE SET
       parent = excluded.parent,
       mtime = excluded.mtime,
       size = excluded.size,
       kind = excluded.kind,
       artist_name = excluded.artist_name,
       album_name = excluded.album_name,
       song_name = excluded.song_name,
       song_key = excluded.song_key,
       album_key = excluded.album_key,
       isrc = excluded.isrc,
       upc = excluded.upc,
       meta = excluded.meta`,
  ).run(row)
}

function getFileRowsByParent(db, parent) {
  const rows = stmt(db, 'SELECT * FROM library_files WHERE parent = ?').all(parent)
  const byPath = new Map()
  for (const row of rows) byPath.set(row.path, row)
  return byPath
}

function listFileRowsByParent(db, parent) {
  return stmt(db, 'SELECT * FROM library_files WHERE parent = ?').all(parent)
}

function deleteFileRowsNotIn(db, parent, seenPaths) {
  const existing = stmt(db, 'SELECT path FROM library_files WHERE parent = ?').all(parent)
  for (const row of existing) {
    if (seenPaths.has(row.path)) continue
    stmt(db, 'DELETE FROM library_files WHERE path = ?').run(row.path)
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

export async function hasAlbumInLibrary(artistName, albumName, preScannedIndex = null, upc = null) {
  const index = preScannedIndex || (await getCachedIndex())
  const upcNorm = normalizeUpc(upc)
  if (upcNorm && index.upcs?.has(upcNorm)) return true
  const key = makeAlbumKey(artistName, stripTrailingYear(albumName))
  if (!key) return false
  return index.albumKeys.has(key)
}

export async function getAlbumTrackPresence(artistName, albumName, tracks, preScannedIndex = null) {
  const index = preScannedIndex || (await getCachedIndex())
  const albumKey = makeAlbumKey(artistName, albumName)
  const albumTrackSet = albumKey ? index.albumTrackKeys.get(albumKey) || null : null
  const singlesSet = index.singlesSongKeys || new Set()
  const isrcSet = index.isrcs || new Set()
  const present = {}
  let count = 0
  for (const track of tracks || []) {
    const id = String(track?.id || '')
    if (!id) continue
    const songKey = makeSongKey(artistName, track?.name || '')
    const isrcNorm = normalizeIsrc(track?.isrc)
    const has = Boolean(
      (songKey && ((albumTrackSet && albumTrackSet.has(songKey)) || singlesSet.has(songKey))) ||
        (isrcNorm && isrcSet.has(isrcNorm)),
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

export async function hasSongInLibrary(artistName, songName, preScannedIndex = null, isrc = null) {
  const index = preScannedIndex || (await getCachedIndex())
  const isrcNorm = normalizeIsrc(isrc)
  if (isrcNorm && index.isrcs?.has(isrcNorm)) return true
  const key = makeSongKey(artistName, songName)
  if (!key) return false
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
