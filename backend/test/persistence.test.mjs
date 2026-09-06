import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-db-'))
const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const dbMod = await import('../lib/db.mjs')
const { getDb, getMeta, setMeta } = dbMod

function writeAudio(relPath) {
  const abs = path.join(tmpMusic, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  // Empty files are fine: tag reads fail soft and folder names drive the keys.
  fs.writeFileSync(abs, 'x')
  return abs
}

test('sqlite schema initializes and meta round-trips', () => {
  const db = getDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name)
  for (const expected of ['meta', 'queue_jobs', 'download_history', 'library_dirs', 'library_files']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`)
  }
  setMeta('probe', 'v1')
  assert.equal(getMeta('probe'), 'v1')
})

test('full scan indexes the library and writes cache rows', async () => {
  writeAudio('Artist One/Great Album/01. First Song.flac')
  writeAudio('Artist One/Great Album/02. Second Song.flac')
  writeAudio('Artist One/Singles/Loose Track.flac')

  const { scanLibrary } = await import('../lib/libraryIndex.mjs')
  const index = await scanLibrary()

  assert.equal(index.albums.length, 1)
  assert.equal(index.albums[0].albumName, 'Great Album')
  assert.equal(index.albums[0].trackCount, 2)
  assert.equal(index.singles.length, 1)
  assert.equal(index.singles[0].songName, 'Loose Track')
  assert.ok(index.albumKeys.has('artist one::great album'))
  assert.ok(index.songKeys.has('artist one::first song'))
  assert.ok(index.isrcs.size === 0)

  // songPaths maps song keys to library-relative paths for m3u exports
  assert.equal(
    index.songPaths.get('artist one::first song'),
    'Artist One/Great Album/01. First Song.flac',
  )

  const files = getDb().prepare('SELECT COUNT(*) AS n FROM library_files').get()
  assert.equal(files.n, 3)
  const dirs = getDb().prepare('SELECT COUNT(*) AS n FROM library_dirs').get()
  assert.ok(dirs.n >= 3) // artist + album + singles (Playlists dir comes later)
  assert.equal(getMeta('library_last_full_scan') !== null, true)
})

test('incremental scan picks up additions, removals, and renames', async () => {
  const { scanLibrary, invalidateLibraryCache } = await import('../lib/libraryIndex.mjs')
  // The scanner skips directories whose mtime is unchanged; keep mutations
  // comfortably clear of previous timestamps so rounding can't collide.
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // Nothing changed: rescan is served from cache rows with identical results
  const before = await scanLibrary()
  assert.equal(before.albums.length, 1)
  const tagReadsBefore = getDb()
    .prepare('SELECT COUNT(*) AS n FROM library_files WHERE isrc IS NOT NULL')
    .get()

  writeAudio('Artist One/Great Album/03. Third Song.flac')
  await tick(15)
  invalidateLibraryCache()
  const afterAdd = await scanLibrary()
  assert.equal(afterAdd.albums[0].trackCount, 3)
  assert.ok(afterAdd.songKeys.has('artist one::third song'))
  assert.equal(
    afterAdd.songPaths.get('artist one::third song'),
    'Artist One/Great Album/03. Third Song.flac',
  )

  const removed = path.join(tmpMusic, 'Artist One/Great Album/02. Second Song.flac')
  fs.rmSync(removed)
  await tick(15)
  invalidateLibraryCache()
  const afterRemove = await scanLibrary()
  assert.equal(afterRemove.albums[0].trackCount, 2)
  assert.ok(!afterRemove.songKeys.has('artist one::second song'))

  // Renamed album folder: old album disappears, new one appears
  fs.renameSync(
    path.join(tmpMusic, 'Artist One/Great Album'),
    path.join(tmpMusic, 'Artist One/Renamed Album'),
  )
  await tick(15)
  invalidateLibraryCache()
  const afterRename = await scanLibrary()
  assert.deepEqual(
    afterRename.albums.map((a) => a.albumName).sort(),
    ['Renamed Album'],
  )
  assert.ok(afterRename.albumKeys.has('artist one::renamed album'))
  assert.ok(!afterRename.albumKeys.has('artist one::great album'))

  // Vanished artist disappears entirely
  fs.rmSync(path.join(tmpMusic, 'Artist One'), { recursive: true })
  invalidateLibraryCache()
  const afterVanish = await scanLibrary()
  assert.equal(afterVanish.albums.length, 0)
  assert.equal(afterVanish.singles.length, 0)
  assert.equal(afterVanish.songKeys.size, 0)
  assert.equal(tagReadsBefore.n, 0) // no isrc rows expected either way
})

test('m3u8 exports are indexed with their ids', async () => {
  const { scanLibrary, invalidateLibraryCache } = await import('../lib/libraryIndex.mjs')
  const playlistsDir = path.join(tmpMusic, 'Playlists')
  fs.mkdirSync(playlistsDir, { recursive: true })
  fs.writeFileSync(
    path.join(playlistsDir, 'Mix.m3u8'),
    ['#EXTM3U', '#PLAYLIST:Mix', '#ALACARTE_PLAYLIST_ID:pl.u-x', 'Artist One/Great Album/01. First Song.flac', ''].join('\n'),
  )
  invalidateLibraryCache()
  const index = await scanLibrary()
  assert.equal(index.playlists.length, 1)
  assert.equal(index.playlists[0].playlistName, 'Mix')
  assert.equal(index.playlists[0].catalogPlaylistId, 'pl.u-x')
  assert.ok(index.playlistIds.has('pl.u-x'))
})

test('queue persistence round-trips jobs across a restore', async () => {
  const queue = await import('../lib/queue.mjs')

  const doneJob = {
    id: 'job-done-1',
    kind: 'song',
    status: 'done',
    progress: 100,
    albumId: '1',
    songId: '1',
    followedPlaylistId: 'p.test',
    albumTitle: 'A Song',
    artist: 'Artist',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now() - 1000,
    message: 'Imported track',
  }
  getDb()
    .prepare(
      `INSERT INTO queue_jobs (id, seq, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(doneJob.id, doneJob.createdAt, 'done', JSON.stringify(doneJob), doneJob.updatedAt)

  const queuedJob = {
    ...doneJob,
    id: 'job-queued-1',
    status: 'queued',
    progress: 0,
    createdAt: Date.now() - 1000,
  }
  getDb()
    .prepare(
      `INSERT INTO queue_jobs (id, seq, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(queuedJob.id, queuedJob.createdAt, 'queued', JSON.stringify(queuedJob), queuedJob.updatedAt)

  queue.__test__.restorePersistedJobs()
  const jobs = queue.listJobs()
  const restored = jobs.find((j) => j.id === 'job-done-1')
  assert.equal(restored.status, 'done')
  const requeued = jobs.find((j) => j.id === 'job-queued-1')
  assert.equal(requeued.status, 'queued')
  assert.equal(requeued.message, 'Requeued after restart')
})

test('history endpoint data lives in sqlite and imports legacy ndjson', async () => {
  fs.writeFileSync(
    path.join(tmpConfig, 'history.ndjson'),
    `${JSON.stringify({ id: 'legacy-1', kind: 'album', status: 'done', albumTitle: 'Old', artist: 'A', updatedAt: 1700000000000 })}\n`,
  )
  const queue = await import('../lib/queue.mjs')
  await queue.initQueue()
  const history = queue.listHistory()
  assert.ok(history.some((j) => j.id === 'legacy-1'))

  // Re-running initQueue must not duplicate the import
  await queue.initQueue()
  const again = queue.listHistory()
  assert.equal(again.filter((j) => j.id === 'legacy-1').length, 1)
})

test('followed playlist m3u export lists present tracks in order', async () => {
  const store = await import('../lib/followedPlaylistsStore.mjs')
  const { invalidateLibraryCache } = await import('../lib/libraryIndex.mjs')
  writeAudio('Artist Two/Cool Album/01. Alpha.flac')
  writeAudio('Artist Two/Cool Album/02. Beta.flac')
  invalidateLibraryCache()

  const record = await store.createFollowedPlaylist({
    libraryId: 'p.m3u',
    name: 'My Followed Mix',
    trackIndex: [
      { id: 't1', name: 'Alpha', artistName: 'Artist Two' },
      { id: 't2', name: 'Beta', artistName: 'Artist Two' },
      { id: 't3', name: 'Not Downloaded Yet', artistName: 'Artist Two' },
    ],
    catalogId: 'pl.u-mix',
  })

  const m3uPath = await store.rebuildFollowedPlaylistM3u(record)
  assert.ok(m3uPath, 'expected an m3u8 to be written')
  const text = fs.readFileSync(m3uPath, 'utf8')
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  assert.equal(lines[0], '#EXTM3U')
  assert.ok(lines.includes('#PLAYLIST:My Followed Mix'))
  assert.ok(lines.includes('#ALACARTE_PLAYLIST_ID:pl.u-mix'))
  assert.ok(lines.includes('#ALACARTE_LIBRARY_PLAYLIST_ID:p.m3u'))
  const trackLines = lines.filter((l) => !l.startsWith('#'))
  assert.deepEqual(trackLines, [
    '../Artist Two/Cool Album/01. Alpha.flac',
    '../Artist Two/Cool Album/02. Beta.flac',
  ])

  // projected records hide the bulky trackIndex from API clients
  const projected = store.projectPlaylist(record)
  assert.equal(projected.trackIndex, undefined)
})
