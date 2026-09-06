import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpConfig = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'alacarte-tagbackfill-cfg-'),
)
const tmpMusic = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'alacarte-tagbackfill-music-'),
)
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { startTagBackfill, getTagBackfillStatus, stopTagBackfill } = await import(
    '../lib/tagBackfill.mjs'
)
const { readAudioIdentityTagsSync } = await import('../lib/audioTags.mjs')

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0

function makeFlac(relPath, { title, artist, album, isrc, upc } = {}) {
    const abs = path.join(tmpMusic, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const args = ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.05', '-c:a', 'flac']
    if (title) args.push('-metadata', `TITLE=${title}`)
    if (artist) args.push('-metadata', `ARTIST=${artist}`)
    if (album) args.push('-metadata', `ALBUM=${album}`)
    if (isrc) args.push('-metadata', `ISRC=${isrc}`)
    if (upc) args.push('-metadata', `BARCODE=${upc}`)
    args.push(abs)
    const res = spawnSync('ffmpeg', args, { encoding: 'utf8' })
    if (res.status !== 0) throw new Error('ffmpeg failed to create test flac')
    return abs
}

function catalogResponse(songs, albums) {
    return {
        results: {
            songs: { data: songs.map((s) => ({ attributes: s })) },
            albums: { data: albums.map((a) => ({ attributes: a })) },
        },
    }
}

async function waitUntilDone(timeoutMs = 30_000) {
    const t0 = Date.now()
    while (getTagBackfillStatus().running) {
        if (Date.now() - t0 > timeoutMs) throw new Error('backfill did not finish in time')
        await new Promise((r) => setTimeout(r, 100))
    }
    return getTagBackfillStatus()
}

test('backfill stamps untagged flacs and skips already-tagged ones', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    makeFlac('Artist One/Great Album/01. First.flac', {
        title: 'First', artist: 'Artist One', album: 'Great Album',
    })
    makeFlac('Artist One/Great Album/02. Second.flac', {
        title: 'Second', artist: 'Artist One', album: 'Great Album',
    })
    makeFlac('Artist One/Great Album/03. Already Tagged.flac', {
        title: 'Already Tagged', artist: 'Artist One', album: 'Great Album',
        isrc: 'AAA000000001', upc: '1111111111111',
    })

    const deps = {
        searchCatalog: async ({ term }) => {
            if (term.includes('First')) {
                return catalogResponse(
                    [{ name: 'First', artistName: 'Artist One', albumName: 'Great Album', isrc: 'AAA111111111' }],
                    [{ name: 'Great Album', artistName: 'Artist One', upc: '1111111111112' }],
                )
            }
            if (term.includes('Second')) {
                return catalogResponse(
                    [{ name: 'Second', artistName: 'Artist One', albumName: 'Great Album', isrc: 'AAA111111112' }],
                    [{ name: 'Great Album', artistName: 'Artist One', upc: '1111111111112' }],
                )
            }
            return catalogResponse([], [])
        },
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }

    const started = await startTagBackfill({ dryRun: false, deps })
    assert.equal(started.running, true)

    const done = await waitUntilDone()
    assert.equal(done.total, 3)
    assert.equal(done.stamped, 2)
    assert.equal(done.skipped, 1)
    assert.equal(done.noMatch, 0)
    assert.equal(done.failed, 0)
    assert.equal(done.error, null)

    const first = readAudioIdentityTagsSync(
        path.join(tmpMusic, 'Artist One/Great Album/01. First.flac'),
    )
    assert.equal(first.isrc, 'AAA111111111')
    assert.equal(first.upc, '1111111111112')

    // second run: everything is tagged now
    await startTagBackfill({ dryRun: false, deps })
    const second = await waitUntilDone()
    assert.equal(second.stamped, 0)
    assert.equal(second.skipped, 3)
})

test('backfill counts unmatched files without failing', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    makeFlac('Artist Two/Obscure/01. Mystery.flac', {
        title: 'Mystery', artist: 'Artist Two', album: 'Obscure',
    })
    const deps = {
        searchCatalog: async () => catalogResponse([], []),
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ dryRun: false, deps })
    const done = await waitUntilDone()
    assert.equal(done.noMatch, 1)
    assert.equal(done.stamped, 0)
    assert.equal(done.failed, 0)
})

test('stop flag ends the run early', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    for (const i of [1, 2, 3, 4]) {
        makeFlac(`Artist Three/Album/${String(i).padStart(2, '0')}. Track.flac`, {
            title: `Track ${i}`, artist: 'Artist Three', album: 'Album',
        })
    }
    const deps = {
        // slow search so the run is still in flight when we stop it
        searchCatalog: async () => {
            await new Promise((r) => setTimeout(r, 150))
            return catalogResponse([], [])
        },
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ dryRun: false, deps })
    stopTagBackfill()
    const done = await waitUntilDone()
    assert.equal(done.running, false)
    assert.ok(done.scanned < 4, `expected early exit, scanned ${done.scanned}`)
})
