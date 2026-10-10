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

function resetMusic() {
    for (const name of fs.readdirSync(tmpMusic)) fs.rmSync(path.join(tmpMusic, name), { recursive: true, force: true })
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

test('one album costs two Apple calls however many tracks it has', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    resetMusic()
    const titles = ['Alpha', 'Bravo', 'Charlie']
    titles.forEach((title, i) =>
        makeFlac(`Artist Four/Trio/0${i + 1}. ${title}.flac`, {
            title, artist: 'Artist Four', album: 'Trio',
        }),
    )
    const calls = []
    const deps = {
        searchCatalog: async (args) => {
            calls.push(`search:${args.types}`)
            return {
                results: { albums: { data: [{ id: 'alb1', attributes: { name: 'Trio', artistName: 'Artist Four' } }] } },
            }
        },
        getAlbum: async ({ id }) => {
            calls.push(`album:${id}`)
            return {
                data: [{
                    attributes: { upc: '4444444444444' },
                    relationships: {
                        tracks: {
                            data: titles.map((name, i) => ({
                                attributes: { name, isrc: `FOUR0000000${i + 1}`, trackNumber: i + 1 },
                            })),
                        },
                    },
                }],
            }
        },
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ dryRun: false, deps })
    const done = await waitUntilDone()
    assert.deepEqual(calls, ['search:albums', 'album:alb1'])
    assert.equal(done.stamped, 3)
    assert.equal(done.appleCalls, 2)
    assert.equal(done.phase, 'done')
    const tags = readAudioIdentityTagsSync(path.join(tmpMusic, 'Artist Four/Trio/02. Bravo.flac'))
    assert.equal(tags.isrc, 'FOUR00000002')
    assert.equal(tags.upc, '4444444444444')
})

test('a rate limit pauses the run and it carries on afterwards instead of counting files as unmatched', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    resetMusic()
    makeFlac('Artist Five/Solo/01. Only.flac', { title: 'Only', artist: 'Artist Five', album: 'Solo' })
    let first = true
    const deps = {
        searchCatalog: async () => {
            if (first) {
                first = false
                throw Object.assign(new Error('Apple API 429 on /v1/catalog/us/search: Request is forbidden'), { retryAfterSec: 1 })
            }
            return { results: { albums: { data: [{ id: 'alb5', attributes: { name: 'Solo', artistName: 'Artist Five' } }] } } }
        },
        getAlbum: async () => ({
            data: [{
                attributes: { upc: '5555555555555' },
                relationships: { tracks: { data: [{ attributes: { name: 'Only', isrc: 'FIVE00000001', trackNumber: 1 } }] } },
            }],
        }),
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ dryRun: false, deps })
    let sawWaiting = false
    for (let i = 0; i < 40 && getTagBackfillStatus().running; i++) {
        if (getTagBackfillStatus().phase === 'waiting' && getTagBackfillStatus().waitingUntil) sawWaiting = true
        await new Promise((r) => setTimeout(r, 50))
    }
    const done = await waitUntilDone()
    assert.equal(sawWaiting, true, 'status reported the wait')
    assert.equal(done.stamped, 1)
    assert.equal(done.noMatch, 0)
    assert.equal(done.failed, 0)
})

test('files Apple had nothing for are not asked about again until they change', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    resetMusic()
    const file = makeFlac('Artist Six/Lost/01. Nothing.flac', {
        title: 'Nothing', artist: 'Artist Six', album: 'Lost',
    })
    let calls = 0
    const deps = {
        searchCatalog: async () => {
            calls += 1
            return catalogResponse([], [])
        },
        getAlbum: async () => ({ data: [] }),
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ deps })
    const first = await waitUntilDone()
    assert.equal(first.noMatch, 1)
    assert.equal(first.cachedMisses, 0)
    const afterFirst = calls
    assert.ok(afterFirst >= 1)

    await startTagBackfill({ deps })
    const second = await waitUntilDone()
    assert.equal(second.noMatch, 1)
    assert.equal(second.cachedMisses, 1)
    assert.equal(calls, afterFirst, 'no Apple call for a remembered miss')

    await startTagBackfill({ deps, retryUnmatched: true })
    await waitUntilDone()
    assert.ok(calls > afterFirst, 'retryUnmatched asks again')

    const later = calls
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(file, future, future)
    await startTagBackfill({ deps })
    const changed = await waitUntilDone()
    assert.equal(changed.cachedMisses, 0)
    assert.ok(calls > later, 'a changed file is checked again')
})

test('a track the album lookup did not cover is looked up as a song', async (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    resetMusic()
    for (const [i, title] of ['Alpha', 'Bravo', 'Bonus Track'].entries()) {
        makeFlac(`Artist Seven/Deluxe/0${i + 1}. ${title}.flac`, { title, artist: 'Artist Seven', album: 'Deluxe' })
    }
    const calls = []
    const deps = {
        searchCatalog: async ({ term, types }) => {
            calls.push(`${types}:${term}`)
            if (types === 'albums') {
                return { results: { albums: { data: [{ id: 'alb7', attributes: { name: 'Deluxe', artistName: 'Artist Seven' } }] } } }
            }
            // song search, only the bonus track is found this way
            return catalogResponse(
                [{ name: 'Bonus Track', artistName: 'Artist Seven', albumName: 'Deluxe', isrc: 'SEVEN0000003' }],
                [{ name: 'Deluxe', artistName: 'Artist Seven', upc: '7777777777777' }],
            )
        },
        getAlbum: async () => ({
            data: [{
                attributes: { upc: '7777777777777' },
                relationships: {
                    tracks: {
                        data: [
                            { attributes: { name: 'Alpha', isrc: 'SEVEN0000001', trackNumber: 1 } },
                            { attributes: { name: 'Bravo', isrc: 'SEVEN0000002', trackNumber: 2 } },
                        ],
                    },
                },
            }],
        }),
        readSettings: async () => ({ storefront: 'us', language: 'en-US' }),
        now: Date.now,
    }
    await startTagBackfill({ deps })
    const done = await waitUntilDone()
    assert.equal(done.stamped, 3)
    assert.equal(done.noMatch, 0)
    assert.equal(calls.filter((c) => c.startsWith('songs')).length, 1, 'one song search, for the bonus track only')
    const bonus = readAudioIdentityTagsSync(path.join(tmpMusic, 'Artist Seven/Deluxe/03. Bonus Track.flac'))
    assert.equal(bonus.isrc, 'SEVEN0000003')
})
