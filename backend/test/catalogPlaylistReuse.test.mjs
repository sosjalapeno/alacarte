import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))
process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-cpl-'))
process.env.AMDL_MUSIC_PATH = tmpMusic

const { buildMinimalFlacWithTags } = await import('../lib/audioTags.mjs')
const { invalidateLibraryCache } = await import('../lib/libraryIndex.mjs')
const { __test__ } = await import('../lib/queue.mjs')
const { catalogPlaylistTracksIfAnyOwned } = __test__

function song(id, name, albumName, isrc) {
  return { id, type: 'songs', attributes: { name, artistName: 'Artist', albumName, isrc } }
}

async function* catalog() {
  yield song('1', 'Owned Song', 'Owned Album', 'USRC11111111')
  yield { id: 'mv', type: 'music-videos', attributes: { name: 'Video' } }
  yield song('2', 'New Song', 'New Album', 'USRC22222222')
}

async function* catalogNothingOwned() {
  yield song('2', 'New Song', 'New Album', 'USRC22222222')
}

test('catalog playlists with an owned track switch to the per-track fill', async () => {
  const dir = path.join(tmpMusic, 'Artist', 'Owned Album')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, '01. Owned Song.flac'), buildMinimalFlacWithTags({ isrc: 'USRC11111111' }))
  invalidateLibraryCache()

  const job = { storefront: 'us', playlistId: 'pl.test' }
  const tracks = await catalogPlaylistTracksIfAnyOwned(job, {}, catalog)
  assert.deepEqual(
    tracks.map((t) => [t.catalogId, t.name, t.isrc]),
    [
      ['1', 'Owned Song', 'USRC11111111'],
      ['2', 'New Song', 'USRC22222222'],
    ],
  )
  assert.equal(await catalogPlaylistTracksIfAnyOwned(job, {}, catalogNothingOwned), null)
})
