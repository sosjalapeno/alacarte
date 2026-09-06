import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'alacarte-playlist-sync-'),
)
process.env.AMDL_CONFIG_DIR = tmpDir

const { followPlaylist, syncFollowedPlaylist, runPlaylistSyncCheck } =
    await import('../lib/playlistSync.mjs')
const {
    readPlaylistsStore,
    getFollowedPlaylistByAnyId,
    unfollowPlaylist,
} = await import('../lib/followedPlaylistsStore.mjs')

function makeTrack(id, { name = `Track ${id}`, artist = 'Artist', isrc = null, downloadable = true } = {}) {
    return {
        id,
        catalogId: downloadable ? id : null,
        name,
        artistName: artist,
        isrc,
        catalogAlbumId: null,
        downloadable,
    }
}

// Builds injected deps. `present` are artist::song keys already in the library.
function makeDeps({
    tracks = [],
    present = new Set(),
    presentIsrcs = new Set(),
    failSongIds = {},
} = {}) {
    const enqueued = []
    const errors = []
    return {
        deps: {
            fetchSource: async (record) => ({
                meta: {
                    // deterministic per-playlist catalog id, like Apple resolving
                    // a saved catalog playlist to pl.u-<id>
                    catalogId: record.libraryId
                        ? `pl.u-${record.libraryId}`
                        : record.catalogId,
                    name: 'Test Playlist',
                    curatorName: record.libraryId ? 'You' : 'Apple Music',
                    description: '',
                    artworkTemplate: null,
                    artworkColor: null,
                    isUserCreated: Boolean(record.libraryId),
                },
                tracks,
            }),
            scanLibrary: async () => ({ songKeys: new Set(), isrcs: new Set() }),
            hasSong: async (artistName, songName, _libIndex, isrc) => {
                if (isrc && presentIsrcs.has(isrc)) return true
                return present.has(`${artistName}::${songName}`)
            },
            enqueue: async ({ songId }) => {
                if (failSongIds[songId]) {
                    const err = new Error(failSongIds[songId].message)
                    err.code = failSongIds[songId].code
                    errors.push({ songId, code: err.code })
                    throw err
                }
                enqueued.push(songId)
                return { id: `job-${songId}` }
            },
        },
        enqueued,
        errors,
    }
}

test('follow with downloadNow=false seeds known tracks without downloading', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [makeTrack('1'), makeTrack('2'), makeTrack('lib.1', { downloadable: false })],
    })
    const result = await followPlaylist({
        libraryId: 'p.seed',
        downloadNow: false,
        deps,
    })
    assert.deepEqual(enqueued, [])
    assert.equal(result.playlist.id, 'p.seed')
    assert.equal(result.playlist.isUserCreated, true)
    assert.equal(result.playlist.catalogId, 'pl.u-p.seed')
    assert.equal(result.playlist.totalTrackCount, 3)
    assert.equal(result.playlist.undownloadableTrackCount, 1)
    // every current track id is marked seen, including the undownloadable one
    const stored = (await readPlaylistsStore()).playlists['p.seed']
    assert.deepEqual(stored.knownTrackIds.sort(), ['1', '2', 'lib.1'])
    assert.equal(stored.lastCheckedAt > 0, true)
})

test('follow with downloadNow=true queues missing catalog tracks only', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [
            makeTrack('10'),
            makeTrack('11', { name: 'Have This' }),
            makeTrack('lib.2', { downloadable: false }),
        ],
        present: new Set(['Artist::Have This']),
    })
    const result = await followPlaylist({
        libraryId: 'p.now',
        downloadNow: true,
        deps,
    })
    assert.deepEqual(enqueued, ['10'])
    assert.equal(result.queued, 1)
    assert.equal(result.playlist.missingTrackCount, 1)
    assert.equal(result.playlist.totalTrackCount, 3)
})

test('tracks already in the library are marked seen without enqueueing', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [makeTrack('20'), makeTrack('21', { name: 'Owned' })],
        present: new Set(['Artist::Owned']),
    })
    const result = await followPlaylist({
        libraryId: 'p.present',
        downloadNow: true,
        deps,
    })
    assert.deepEqual(enqueued, ['20'])
    // the just-queued track is not in the library yet, so it still counts missing
    assert.equal(result.playlist.missingTrackCount, 1)
    assert.equal(result.playlist.totalTrackCount, 2)
    assert.equal(result.playlist.fullyDownloaded, false)
})

test('ALREADY_IN_LIBRARY enqueue errors count as handled', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [makeTrack('30')],
        failSongIds: { 30: { message: 'Already in library', code: 'ALREADY_IN_LIBRARY' } },
    })
    const result = await followPlaylist({
        libraryId: 'p.already',
        downloadNow: true,
        deps,
    })
    assert.deepEqual(enqueued, [])
    assert.equal(result.queued, 0)
    assert.deepEqual(result.failed, [])
    const stored = (await readPlaylistsStore()).playlists['p.already']
    assert.deepEqual(stored.knownTrackIds, ['30'])
    assert.equal(stored.lastError, null)
})

test('transient enqueue failures are retried on the next sync', async () => {
    const failing = makeDeps({
        tracks: [makeTrack('40')],
        failSongIds: { 40: { message: 'catalog down', code: 'UPSTREAM' } },
    })
    const first = await followPlaylist({
        libraryId: 'p.retry',
        downloadNow: true,
        deps: failing.deps,
    })
    assert.equal(first.queued, 0)
    assert.equal(first.failed.length, 1)
    assert.equal(first.playlist.lastError, '1 track could not be queued')
    let stored = (await readPlaylistsStore()).playlists['p.retry']
    assert.deepEqual(stored.knownTrackIds, [])

    const working = makeDeps({ tracks: [makeTrack('40')] })
    const second = await syncFollowedPlaylist('p.retry', { deps: working.deps })
    assert.deepEqual(working.enqueued, ['40'])
    assert.equal(second.queued, 1)
    stored = (await readPlaylistsStore()).playlists['p.retry']
    assert.deepEqual(stored.knownTrackIds, ['40'])
    assert.equal(stored.lastError, null)
})

test('tracks added to the playlist are picked up incrementally', async () => {
    const initial = makeDeps({ tracks: [makeTrack('50')] })
    await followPlaylist({ libraryId: 'p.incremental', downloadNow: false, deps: initial.deps })

    const grown = makeDeps({ tracks: [makeTrack('50'), makeTrack('51')] })
    const result = await syncFollowedPlaylist('p.incremental', { deps: grown.deps })
    assert.deepEqual(grown.enqueued, ['51'])
    assert.equal(result.queued, 1)
    assert.equal(result.discovered, 1)
})

test('ISRC presence match skips re-downloading a known recording', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [makeTrack('60', { name: 'Remastered Name', isrc: 'USXXX1234567' })],
        presentIsrcs: new Set(['USXXX1234567']),
    })
    const result = await followPlaylist({
        libraryId: 'p.isrc',
        downloadNow: true,
        deps,
    })
    assert.deepEqual(enqueued, [])
    assert.equal(result.queued, 0)
    assert.equal(result.playlist.missingTrackCount, 0)
})

test('removing a track from the playlist drops it from known ids but keeps files', async () => {
    const initial = makeDeps({ tracks: [makeTrack('70'), makeTrack('71')] })
    await followPlaylist({ libraryId: 'p.removal', downloadNow: false, deps: initial.deps })

    const shrunk = makeDeps({ tracks: [makeTrack('70')] })
    await syncFollowedPlaylist('p.removal', { deps: shrunk.deps })
    const stored = (await readPlaylistsStore()).playlists['p.removal']
    assert.deepEqual(stored.knownTrackIds, ['70'])
    assert.equal(stored.totalTrackCount, 1)
})

test('re-adding a previously downloaded track does not re-download it', async () => {
    const initial = makeDeps({ tracks: [makeTrack('80')] })
    await followPlaylist({ libraryId: 'p.readd', downloadNow: true, deps: initial.deps })

    // removed then re-added: presence check finds the downloaded copy
    const gone = makeDeps({ tracks: [] })
    await syncFollowedPlaylist('p.readd', { deps: gone.deps })
    const back = makeDeps({
        tracks: [makeTrack('80')],
        present: new Set(['Artist::Track 80']),
    })
    const result = await syncFollowedPlaylist('p.readd', { deps: back.deps })
    assert.deepEqual(back.enqueued, [])
    assert.equal(result.queued, 0)
})

test('following the same playlist via catalog id dedupes to the existing follow', async () => {
    const initial = makeDeps({ tracks: [makeTrack('90')] })
    await followPlaylist({ libraryId: 'p.dupe', downloadNow: false, deps: initial.deps })
    // the library follow resolved to catalog id pl.u-p.dupe, so following that
    // catalog playlist directly must reuse the existing record
    const viaCatalog = makeDeps({ tracks: [makeTrack('90')] })
    const result = await followPlaylist({
        catalogId: 'pl.u-p.dupe',
        downloadNow: false,
        deps: viaCatalog.deps,
    })
    assert.equal(result.existed, true)
    assert.equal(result.playlist.id, 'p.dupe')
    const store = await readPlaylistsStore()
    assert.equal(store.playlists['pl.u-p.dupe'], undefined)
})

test('follow aborts and creates no record when the source fetch fails', async () => {
    const failing = makeDeps({ tracks: [] })
    failing.deps.fetchSource = async () => {
        throw new Error('apple 503')
    }
    await assert.rejects(
        () => followPlaylist({ libraryId: 'p.fetchfail', downloadNow: false, deps: failing.deps }),
        /apple 503/,
    )
    assert.equal((await readPlaylistsStore()).playlists['p.fetchfail'], undefined)

    // an existing record survives a failed sync and heals on the next one
    const ok = makeDeps({ tracks: [makeTrack('96')] })
    await followPlaylist({ libraryId: 'p.heal', downloadNow: false, deps: ok.deps })

    const broken = makeDeps({ tracks: [makeTrack('96')] })
    broken.deps.fetchSource = async () => {
        throw new Error('apple 503')
    }
    const failedSync = await syncFollowedPlaylist('p.heal', { deps: broken.deps })
    assert.equal(failedSync.ok, false)
    assert.equal(failedSync.error, 'apple 503')
    const stored = (await readPlaylistsStore()).playlists['p.heal']
    assert.equal(stored.lastError, 'apple 503')
    // known ids untouched by the failed pass
    assert.deepEqual(stored.knownTrackIds, ['96'])

    const healed = makeDeps({ tracks: [makeTrack('96'), makeTrack('97')] })
    const result = await syncFollowedPlaylist('p.heal', { deps: healed.deps })
    assert.equal(result.ok, true)
    const after = (await readPlaylistsStore()).playlists['p.heal']
    assert.equal(after.lastError, null)
    assert.deepEqual(after.knownTrackIds, ['96', '97'])
})

test('runPlaylistSyncCheck force-syncs every followed playlist', async () => {
    const a = makeDeps({ tracks: [makeTrack('a1'), makeTrack('a2')] })
    await followPlaylist({ libraryId: 'p.check.a', downloadNow: false, deps: a.deps })
    const b = makeDeps({ tracks: [makeTrack('b1')] })
    await followPlaylist({ libraryId: 'p.check.b', downloadNow: false, deps: b.deps })

    const enqueued = []
    const emptyMeta = {
        catalogId: null,
        name: 'X',
        curatorName: 'You',
        description: '',
        artworkTemplate: null,
        artworkColor: null,
        isUserCreated: true,
    }
    const merged = {
        deps: {
            fetchSource: async (record) => {
                if (record.libraryId === 'p.check.a') {
                    return {
                        meta: { ...emptyMeta, name: 'A' },
                        tracks: [makeTrack('a1'), makeTrack('a2'), makeTrack('a3')],
                    }
                }
                if (record.libraryId === 'p.check.b') {
                    return {
                        meta: { ...emptyMeta, name: 'B' },
                        tracks: [makeTrack('b1'), makeTrack('b2')],
                    }
                }
                return { meta: emptyMeta, tracks: [] }
            },
            scanLibrary: async () => ({ songKeys: new Set(), isrcs: new Set() }),
            hasSong: async () => false,
            enqueue: async ({ songId }) => {
                enqueued.push(songId)
                return { id: `job-${songId}` }
            },
        },
    }
    const result = await runPlaylistSyncCheck({ reason: 'manual', force: true, deps: merged.deps })
    assert.equal(result.ok, true)
    assert.ok(result.playlists >= 2)
    // a1/a2 and b1 are known already; only the genuinely new tracks enqueue
    assert.deepEqual(enqueued.sort(), ['a3', 'b2'])
    assert.equal(result.queued, enqueued.length)
})

test('unfollow removes the record', async () => {
    const { deps } = makeDeps({ tracks: [makeTrack('99')] })
    await followPlaylist({ libraryId: 'p.unfollow', downloadNow: false, deps })
    const res = await unfollowPlaylist('p.unfollow')
    assert.equal(res.existed, true)
    assert.equal(await getFollowedPlaylistByAnyId('p.unfollow'), null)
})

test('downloadMissing backfill downloads known tracks that never landed', async () => {
    const initial = makeDeps({ tracks: [makeTrack('110'), makeTrack('111')] })
    await followPlaylist({ libraryId: 'p.backfill', downloadNow: false, deps: initial.deps })
    assert.deepEqual(initial.enqueued, [])

    // plain sync does nothing for known tracks...
    const plain = makeDeps({ tracks: [makeTrack('110'), makeTrack('111')] })
    const plainResult = await syncFollowedPlaylist('p.backfill', { deps: plain.deps })
    assert.deepEqual(plain.enqueued, [])

    // ...but downloadMissing enqueues the known-but-absent ones
    const backfill = makeDeps({
        tracks: [makeTrack('110'), makeTrack('111')],
        present: new Set(['Artist::Track 110']),
    })
    const result = await syncFollowedPlaylist('p.backfill', {
        deps: backfill.deps,
        downloadMissing: true,
    })
    assert.deepEqual(backfill.enqueued, ['111'])
    assert.equal(result.queued, 1)
})

test('re-following with downloadNow backfills an existing seeded follow', async () => {
    const initial = makeDeps({ tracks: [makeTrack('120')] })
    await followPlaylist({ libraryId: 'p.refollow', downloadNow: false, deps: initial.deps })
    const again = makeDeps({ tracks: [makeTrack('120')] })
    const result = await followPlaylist({
        libraryId: 'p.refollow',
        downloadNow: true,
        deps: again.deps,
    })
    assert.deepEqual(again.enqueued, ['120'])
    assert.equal(result.queued, 1)
    assert.equal(result.existed, true)
})

test('duplicate track entries in one playlist only enqueue once', async () => {
    const { deps, enqueued } = makeDeps({
        tracks: [makeTrack('130'), makeTrack('130'), makeTrack('130')],
    })
    const result = await followPlaylist({
        libraryId: 'p.duptracks',
        downloadNow: true,
        deps,
    })
    assert.deepEqual(enqueued, ['130'])
    assert.equal(result.queued, 1)
})

test('unfollowing mid-sync stops the pass before further enqueues', async () => {
    const { deps } = makeDeps({ tracks: [makeTrack('140')] })
    await followPlaylist({ libraryId: 'p.midcancel', downloadNow: false, deps })

    const enqueued = []
    let calls = 0
    const passDeps = makeDeps({ tracks: [makeTrack('140'), makeTrack('141'), makeTrack('142')] })
    passDeps.deps.enqueue = async ({ songId }) => {
        calls += 1
        if (calls === 1) {
            // the first enqueue triggers a concurrent unfollow
            await unfollowPlaylist('p.midcancel')
        }
        enqueued.push(songId)
        return { id: `job-${songId}` }
    }
    const result = await syncFollowedPlaylist('p.midcancel', { deps: passDeps.deps })
    assert.equal(result.ok, false)
    assert.equal(enqueued.length, 1)
    assert.equal(calls, 1)
})
