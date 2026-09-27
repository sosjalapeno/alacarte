import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const music = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-lang-presence-'))
process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-lang-presence-cfg-'))
process.env.AMDL_MUSIC_PATH = music

const { buildMinimalFlacWithTags } = await import('../lib/audioTags.mjs')
const { scanLibrary, getAlbumTrackPresence, getAlbumVersionGroups, hasSongInLibrary } = await import(
  '../lib/libraryIndex.mjs'
)

// An album downloaded in dual naming mode lands under names that differ from
// the display names a later enqueue checks with, so presence has to hold on
// the ISRC/UPC tags alone.
test('an album saved under original-language names is still found by its display names', async () => {
  const dir = path.join(music, 'Singer (歌手)', 'Bubbles (泡沫)')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, '01. Bubbles (泡沫).flac'), buildMinimalFlacWithTags({ isrc: 'CNA011200001', upc: '4895123400012' }))
  await fsp.writeFile(path.join(dir, '02. Rain (雨).flac'), buildMinimalFlacWithTags({ isrc: 'CNA011200002', upc: '4895123400012' }))
  const index = await scanLibrary()

  const tracks = [
    { id: '1', name: 'Bubbles', isrc: 'CNA011200001' },
    { id: '2', name: 'Rain', isrc: 'CNA011200002' },
  ]
  const presence = await getAlbumTrackPresence('Singer', 'Bubbles', tracks, index)
  assert.equal(presence.complete, true)
  assert.ok((await getAlbumVersionGroups('Singer', 'Bubbles', '4895123400012', index)).has('lossless'))
  assert.equal(await hasSongInLibrary('Singer', 'Rain', index, 'CNA011200002'), true)
})
