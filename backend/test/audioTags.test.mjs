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

test('getAlbumTrackPresence completes on isrc matches when the folder artist differs', async () => {
  await withMusicRoot(async (root, mod) => {
    // collab release imported under the primary artist's folder while the
    // Apple album-level artist is "Denzel Curry & Kenny Beats"
    const albumDir = path.join(root, 'Denzel Curry', 'ii')
    await fsp.mkdir(albumDir, { recursive: true })
    await fsp.writeFile(
      path.join(albumDir, '01. GONE FISHING.flac'),
      buildMinimalFlacWithTags({ isrc: 'USC4R2667132' }),
    )
    await fsp.writeFile(
      path.join(albumDir, '02. EVIL GRIN.flac'),
      buildMinimalFlacWithTags({ isrc: 'USC4R2667133' }),
    )

    const presence = await mod.getAlbumTrackPresence(
      'Denzel Curry & Kenny Beats',
      'ii',
      [
        { id: 't1', name: 'GONE FISHING', isrc: 'USC4R2667132' },
        { id: 't2', name: 'EVIL GRIN', isrc: 'USC4R2667133' },
      ],
    )
    assert.equal(presence.tracks.t1, true)
    assert.equal(presence.tracks.t2, true)
    assert.equal(presence.folderExists, false)
    assert.equal(presence.complete, true)

    // one track missing from the library keeps it incomplete
    const partial = await mod.getAlbumTrackPresence(
      'Denzel Curry & Kenny Beats',
      'ii',
      [
        { id: 't1', name: 'GONE FISHING', isrc: 'USC4R2667132' },
        { id: 't2', name: 'EVIL GRIN', isrc: 'USC4R2667133' },
        { id: 't3', name: 'CANDLELIGHT', isrc: 'USC4R2667134' },
      ],
    )
    assert.equal(partial.complete, false)
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

test('findSongPathInLibrary prefers the ISRC match when titles differ', async () => {
  await withMusicRoot(async (root, mod) => {
    const singlesDir = path.join(root, 'Artist', 'Singles')
    await fsp.mkdir(singlesDir, { recursive: true })
    await fsp.writeFile(
      path.join(singlesDir, 'Canonical.flac'),
      buildMinimalFlacWithTags({ isrc: 'USRC17777777' }),
    )

    const idx = await mod.scanLibrary()
    assert.equal(
      await mod.findSongPathInLibrary('Artist', 'Radio Edit Version', 'usrc1-77-77777', idx),
      path.join(singlesDir, 'Canonical.flac'),
    )
    assert.equal(await mod.findSongPathInLibrary('Artist', 'Radio Edit Version', null, idx), null)
  })
})

function box(type, ...children) {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

// Freeform iTunes item as amdp writes it: mean / name (full boxes) + data.
function freeform(name, value) {
  const fullbox = (type, text) => box(type, Buffer.alloc(4), Buffer.from(text, 'utf8'))
  return box(
    '----',
    fullbox('mean', 'com.apple.iTunes'),
    fullbox('name', name),
    box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(value, 'utf8')),
  )
}

function buildM4a({ isrc, upc, moovFirst = false } = {}) {
  const items = []
  if (isrc) items.push(freeform('ISRC', isrc))
  if (upc) items.push(freeform('UPC', upc))
  const moov = box('moov', box('udta', box('meta', Buffer.alloc(4), box('ilst', ...items))))
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42', 'latin1'))
  const mdat = box('mdat', Buffer.alloc(256 * 1024, 7))
  return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
}

test('reads ISRC and UPC from amdp m4a freeform atoms wherever moov sits', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-m4a-'))
  try {
    for (const moovFirst of [false, true]) {
      const file = path.join(dir, `song-${moovFirst}.m4a`)
      await fsp.writeFile(file, buildM4a({ isrc: 'GBDUW0000051', upc: '0724389721157', moovFirst }))
      assert.deepEqual(await readAudioIdentityTags(file), {
        isrc: 'GBDUW0000051',
        upc: '0724389721157',
      })
    }
    const bare = path.join(dir, 'bare.m4a')
    await fsp.writeFile(bare, buildM4a())
    assert.deepEqual(await readAudioIdentityTags(bare), { isrc: '', upc: '' })
    const junk = path.join(dir, 'junk.m4a')
    await fsp.writeFile(junk, Buffer.from('not an mp4 file at all'))
    assert.deepEqual(await readAudioIdentityTags(junk), { isrc: '', upc: '' })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('findSongPathInLibrary title fallback respects album and ISRC', async () => {
  await withMusicRoot(async (root, mod) => {
    const albumDir = path.join(root, 'Artist', 'First Album')
    const otherDir = path.join(root, 'Artist', 'Other Album')
    const dotDir = path.join(root, 'Artist', 'Ends With Dot ')
    const singlesDir = path.join(root, 'Artist', 'Singles')
    for (const d of [albumDir, otherDir, dotDir, singlesDir]) await fsp.mkdir(d, { recursive: true })
    await fsp.writeFile(path.join(albumDir, '01. Intro.flac'), buildMinimalFlacWithTags({ isrc: 'USRC10000001' }))
    await fsp.writeFile(path.join(otherDir, '01. Intro.m4a'), buildM4a({ isrc: 'USRC10000002' }))
    await fsp.writeFile(path.join(dotDir, '01. Dotted.flac'), buildMinimalFlacWithTags({}))
    await fsp.writeFile(path.join(singlesDir, 'Loose.flac'), buildMinimalFlacWithTags({ isrc: 'USRC10000003' }))

    const idx = await mod.scanLibrary()
    const find = (title, isrc, album) => mod.findSongPathInLibrary('Artist', title, isrc, idx, { album })

    // ISRC wins, including m4a ISRCs
    assert.equal(await find('Intro', 'USRC10000002', null), path.join(otherDir, '01. Intro.m4a'))
    // same album counts even when its ISRC differs (clean/explicit twin, re-registration)
    assert.equal(await find('Intro', 'USRC19999999', 'First Album'), path.join(albumDir, '01. Intro.flac'))
    // a title match on a different album never counts
    assert.equal(await find('Intro', null, 'Third Album'), null)
    assert.equal(await find('Intro', null, 'Other Album - Single'), path.join(otherDir, '01. Intro.m4a'))
    // album names compare in their sanitized folder form
    assert.equal(await find('Dotted', null, 'Ends With Dot .'), path.join(dotDir, '01. Dotted.flac'))
    // loose singles match unless their ISRC contradicts
    assert.equal(await find('Loose', null, 'Loose - Single'), path.join(singlesDir, 'Loose.flac'))
    assert.equal(await find('Loose', 'USRC18888888', 'Loose - Single'), null)
  })
})
