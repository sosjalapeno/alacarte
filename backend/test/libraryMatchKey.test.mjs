import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyQobuzWriteNaming,
  makeAlbumMatchKey,
  makeSongMatchKey,
  normalizeForMatchKey,
} from '../lib/libraryMatchKey.mjs'

test('normalizeForMatchKey strips feat tags in a loop', () => {
  assert.equal(normalizeForMatchKey('Song (feat. Y)'), 'Song')
  assert.equal(normalizeForMatchKey('Song [ft. A] (feat. B)'), 'Song')
  assert.equal(normalizeForMatchKey('Song (featuring Guest)'), 'Song')
})

test('normalizeForMatchKey unifies curly quotes and backticks', () => {
  assert.equal(normalizeForMatchKey('Jenna\u2019s Song'), "Jenna's Song")
  assert.equal(normalizeForMatchKey('Jenna`s Song'), "Jenna's Song")
  assert.equal(
    makeSongMatchKey('Artist', 'Jenna\u2019s Song'),
    makeSongMatchKey('Artist', "Jenna's Song"),
  )
})

test('normalizeForMatchKey strips Apple product-type suffixes', () => {
  assert.equal(normalizeForMatchKey('Title - Single'), 'Title')
  assert.equal(normalizeForMatchKey('Title \u2013 EP'), 'Title')
  assert.equal(normalizeForMatchKey('Title - Remix'), 'Title')
  assert.equal(normalizeForMatchKey('Title - Soundtrack'), 'Title')
})

test('normalizeForMatchKey strips Octo duplicate counters and explicit tags', () => {
  assert.equal(normalizeForMatchKey('Title (2)'), 'Title')
  assert.equal(normalizeForMatchKey('Song [E]'), 'Song')
  assert.equal(normalizeForMatchKey('Song [C]'), 'Song')
})

test('normalizeForMatchKey does not strip deluxe remaster or live', () => {
  assert.equal(
    normalizeForMatchKey('Above (Deluxe Edition)'),
    'Above (Deluxe Edition)',
  )
  assert.equal(normalizeForMatchKey('Song (Remastered)'), 'Song (Remastered)')
  assert.equal(normalizeForMatchKey('Song (Live)'), 'Song (Live)')
  assert.notEqual(
    makeAlbumMatchKey('Mad Season', 'Above (Deluxe Edition)'),
    makeAlbumMatchKey('Mad Season', 'Above'),
  )
  assert.notEqual(
    makeSongMatchKey('A', 'Song (Remastered)'),
    makeSongMatchKey('A', 'Song'),
  )
})

test('Apple Single title matches Qobuz folder name via album key', () => {
  assert.equal(
    makeAlbumMatchKey('Artist', 'Hit - Single'),
    makeAlbumMatchKey('Artist', 'Hit'),
  )
})

test('applyQobuzWriteNaming strips feat and product suffixes', () => {
  assert.equal(applyQobuzWriteNaming('Song (feat. X)'), 'Song')
  assert.equal(applyQobuzWriteNaming('Album - Single'), 'Album')
  assert.equal(applyQobuzWriteNaming('Album – EP'), 'Album')
  assert.equal(applyQobuzWriteNaming('Above (Deluxe Edition)'), 'Above (Deluxe Edition)')
})

async function withMusicRoot(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-match-'))
  const prevRoot = process.env.AMDL_MUSIC_PATH
  process.env.AMDL_MUSIC_PATH = dir
  try {
    const mod = await import(`../lib/libraryIndex.mjs?ts=${Date.now()}`)
    mod.invalidateLibraryCache()
    await fn(dir, mod)
  } finally {
    process.env.AMDL_MUSIC_PATH = prevRoot
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('scanLibrary match keys equate Apple Single title to disk folder', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'Artist', 'Hit')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. Track.flac'), 'x')

    const idx = await mod.scanLibrary()
    assert.ok(idx.albumKeys.has(mod.makeAlbumKey('Artist', 'Hit - Single')))
    assert.ok(await mod.hasAlbumInLibrary('Artist', 'Hit – EP', idx))
  })
})

test('scanLibrary song keys match feat-stripped Apple titles', async () => {
  await withMusicRoot(async (root, mod) => {
    const singlesDir = path.join(root, 'Future', 'Singles')
    await fsp.mkdir(singlesDir, { recursive: true })
    await fsp.writeFile(path.join(singlesDir, 'After That.flac'), 'x')

    const idx = await mod.scanLibrary()
    assert.ok(idx.songKeys.has(mod.makeSongKey('Future', 'After That (feat. Drake)')))
    assert.ok(await mod.hasSongInLibrary('Future', 'After That (feat. Drake)', idx))
  })
})

test('deluxe edition still does not match standard folder', async () => {
  await withMusicRoot(async (root, mod) => {
    const standardDir = path.join(root, 'Mad Season', 'Above')
    await fsp.mkdir(standardDir, { recursive: true })
    await fsp.writeFile(path.join(standardDir, '01. Wake Up.flac'), 'x')

    assert.equal(await mod.hasAlbumInLibrary('Mad Season', 'Above (Deluxe Edition)'), false)
    assert.equal(await mod.hasAlbumInLibrary('Mad Season', 'Above'), true)
  })
})

test('isAlbumKeyVariantMatch matches album parts across artist spellings', async () => {
  const mod = await import('../lib/libraryMatchKey.mjs')
  const keys = ['denzel curry::ii', 'm i a::kala']

  // collab album artist vs the shorter folder artist
  assert.equal(
    mod.isAlbumKeyVariantMatch(keys, 'denzel curry & kenny beats::ii'),
    true,
  )
  // exact key still matches trivially
  assert.equal(mod.isAlbumKeyVariantMatch(keys, 'denzel curry::ii'), true)

  // different album, even by a related artist: no match
  assert.equal(
    mod.isAlbumKeyVariantMatch(keys, 'denzel curry & kenny beats::unlocked'),
    false,
  )
  // unrelated artist with the same album name: no match
  assert.equal(
    mod.isAlbumKeyVariantMatch(keys, 'someone else::ii'),
    false,
  )
  // empty / malformed keys: no match
  assert.equal(mod.isAlbumKeyVariantMatch(keys, ''), false)
  assert.equal(mod.isAlbumKeyVariantMatch(keys, 'no-separator'), false)
})

test('hasAlbumInLibrary resolves collab albums through the folder variant', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'Denzel Curry', 'ii')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. GONE FISHING.flac'), 'x')

    assert.equal(
      await mod.hasAlbumInLibrary('Denzel Curry & Kenny Beats', 'ii'),
      true,
    )
    assert.equal(
      await mod.hasAlbumInLibrary('Denzel Curry', 'ii'),
      true,
    )
    assert.equal(
      await mod.hasAlbumInLibrary('Denzel Curry & Kenny Beats', 'UNLOCKED'),
      false,
    )
  })
})
