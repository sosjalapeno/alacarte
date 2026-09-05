import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildMinimalFlacWithTags,
  normalizeIsrc,
  normalizeUpc,
  parseFlacIdentityTags,
  readAudioIdentityTags,
} from '../lib/audioTags.mjs'

test('normalizeIsrc uppercases and strips hyphens', () => {
  assert.equal(normalizeIsrc('us-rc1-12-34567'), 'USRC11234567')
  assert.equal(normalizeIsrc('USRC11234567'), 'USRC11234567')
})

test('normalizeUpc keeps digits only', () => {
  assert.equal(normalizeUpc('0 6025 478 1234 5'), '0602547812345')
})

test('parseFlacIdentityTags reads ISRC and UPC from vorbis comments', () => {
  const buf = buildMinimalFlacWithTags({
    isrc: 'USRC11234567',
    upc: '602547812345',
  })
  const tags = parseFlacIdentityTags(buf)
  assert.equal(tags.isrc, 'USRC11234567')
  assert.equal(tags.upc, '602547812345')
})

test('parseFlacIdentityTags accepts BARCODE as upc', () => {
  const buf = buildMinimalFlacWithTags({ barcode: '123456789012' })
  const tags = parseFlacIdentityTags(buf)
  assert.equal(tags.upc, '123456789012')
  assert.equal(tags.isrc, '')
})

test('parseFlacIdentityTags fail-softs on garbage', () => {
  assert.deepEqual(parseFlacIdentityTags(Buffer.from('not flac')), {
    isrc: '',
    upc: '',
  })
  assert.deepEqual(parseFlacIdentityTags(Buffer.from('fLaCxxxx')), {
    isrc: '',
    upc: '',
  })
})

test('readAudioIdentityTags reads from disk and ignores non-flac', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-tags-'))
  try {
    const flacPath = path.join(dir, 't.flac')
    await fsp.writeFile(
      flacPath,
      buildMinimalFlacWithTags({ isrc: 'GBUM71505078' }),
    )
    const tags = await readAudioIdentityTags(flacPath)
    assert.equal(tags.isrc, 'GBUM71505078')

    const m4aPath = path.join(dir, 't.m4a')
    await fsp.writeFile(m4aPath, 'x')
    assert.deepEqual(await readAudioIdentityTags(m4aPath), { isrc: '', upc: '' })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

async function withMusicRoot(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-isrc-'))
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

test('scanLibrary indexes ISRC and UPC from flac tags', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'Artist', 'Album')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(
      path.join(albumDir, '01. Disk Title.flac'),
      buildMinimalFlacWithTags({ isrc: 'USRC19999999', upc: '999888777666' }),
    )

    const idx = await mod.scanLibrary()
    assert.ok(idx.isrcs.has('USRC19999999'))
    assert.ok(idx.upcs.has('999888777666'))
  })
})

test('hasSongInLibrary matches by ISRC when titles differ', async () => {
  await withMusicRoot(async (root, mod) => {
    const singlesDir = path.join(root, 'Artist', 'Singles')
    await fsp.mkdir(singlesDir, { recursive: true })
    await fsp.writeFile(
      path.join(singlesDir, 'Canonical.flac'),
      buildMinimalFlacWithTags({ isrc: 'USRC18888888' }),
    )

    const idx = await mod.scanLibrary()
    assert.equal(
      await mod.hasSongInLibrary('Artist', 'Radio Edit Version', idx, 'USRC18888888'),
      true,
    )
    assert.equal(
      await mod.hasSongInLibrary('Artist', 'Radio Edit Version', idx, null),
      false,
    )
  })
})

test('hasAlbumInLibrary matches by UPC when titles differ', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'Artist', 'Short')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(
      path.join(albumDir, '01. A.flac'),
      buildMinimalFlacWithTags({ upc: '111222333444' }),
    )

    const idx = await mod.scanLibrary()
    assert.equal(
      await mod.hasAlbumInLibrary('Artist', 'Short (Deluxe Edition)', idx, '111222333444'),
      true,
    )
    // Without UPC, deluxe still does not match short name
    assert.equal(
      await mod.hasAlbumInLibrary('Artist', 'Short (Deluxe Edition)', idx, null),
      false,
    )
  })
})

test('getAlbumTrackPresence uses ISRC without merging deluxe folder', async () => {
  await withMusicRoot(async (root, mod) => {
    const standardDir = path.join(root, 'Mad Season', 'Above')
    await fsp.mkdir(standardDir, { recursive: true })
    await fsp.writeFile(
      path.join(standardDir, '01. Wake Up.flac'),
      buildMinimalFlacWithTags({ isrc: 'USRC17777777' }),
    )

    const presence = await mod.getAlbumTrackPresence(
      'Mad Season',
      'Above (Deluxe Edition)',
      [
        { id: 't1', name: 'Wake Up (Remastered)', isrc: 'USRC17777777' },
        { id: 't2', name: 'Bonus Demo', isrc: null },
      ],
    )
    assert.equal(presence.tracks.t1, true)
    assert.equal(presence.tracks.t2, false)
    assert.equal(presence.folderExists, false)
    assert.equal(presence.complete, false)
  })
})

test('malformed flac does not crash scan', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'X', 'Y')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. Bad.flac'), 'fLaC\x00truncated')
    const idx = await mod.scanLibrary()
    assert.ok(idx.albumKeys.has(mod.makeAlbumKey('X', 'Y')))
    assert.equal(idx.isrcs.size, 0)
  })
})
