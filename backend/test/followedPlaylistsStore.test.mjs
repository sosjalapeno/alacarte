import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'alacarte-followed-playlists-'),
)
process.env.AMDL_CONFIG_DIR = tmpDir

const store = await import('../lib/followedPlaylistsStore.mjs')

test('createFollowedPlaylist normalizes and persists records', async () => {
    const record = await store.createFollowedPlaylist({
        libraryId: 'p.abc123',
        name: 'My Playlist',
        knownTrackIds: ['1', '1', '2'],
        undownloadableTrackCount: 3,
    })
    assert.equal(record.id, 'p.abc123')
    assert.equal(record.name, 'My Playlist')
    assert.equal(record.storefront, 'us')
    assert.deepEqual(record.knownTrackIds, ['1', '2'])
    assert.equal(record.undownloadableTrackCount, 3)
    assert.equal(record.lastError, null)
})

test('createFollowedPlaylist requires an id', async () => {
    await assert.rejects(
        () => store.createFollowedPlaylist({ name: 'no id' }),
        /playlist id required/,
    )
})

test('getFollowedPlaylistByAnyId matches primary, library, and catalog ids', async () => {
    await store.createFollowedPlaylist({
        libraryId: 'p.lib1',
        catalogId: 'pl.u-cat1',
        name: 'Dual',
    })
    assert.equal((await store.getFollowedPlaylistByAnyId('p.lib1')).name, 'Dual')
    assert.equal(
        (await store.getFollowedPlaylistByAnyId('pl.u-cat1')).name,
        'Dual',
    )
    assert.equal(await store.getFollowedPlaylistByAnyId('p.missing'), null)
    assert.equal(await store.getFollowedPlaylistByAnyId(''), null)
})

test('updateFollowedPlaylist preserves identity fields', async () => {
    await store.createFollowedPlaylist({
        libraryId: 'p.keep',
        name: 'Before',
    })
    const updated = await store.updateFollowedPlaylist('p.keep', {
        name: 'After',
        missingTrackCount: 2,
    })
    assert.equal(updated.name, 'After')
    assert.equal(updated.missingTrackCount, 2)
    assert.equal(updated.libraryId, 'p.keep')
    assert.equal(updated.id, 'p.keep')
})

test('updateFollowedPlaylist returns null for unknown id', async () => {
    assert.equal(await store.updateFollowedPlaylist('p.nope', { name: 'X' }), null)
})

test('projectPlaylist derives downloadable and complete flags', () => {
    const projected = store.projectPlaylist({
        totalTrackCount: 4,
        missingTrackCount: 0,
        undownloadableTrackCount: 1,
        lastCheckedAt: 123,
    })
    assert.equal(projected.downloadableTrackCount, 3)
    assert.equal(projected.fullyDownloaded, true)

    const neverChecked = store.projectPlaylist({
        totalTrackCount: 4,
        missingTrackCount: 0,
        undownloadableTrackCount: 0,
        lastCheckedAt: 0,
    })
    assert.equal(neverChecked.fullyDownloaded, false)
})

test('unfollowPlaylist reports existence', async () => {
    await store.createFollowedPlaylist({ libraryId: 'p.gone', name: 'Gone' })
    const first = await store.unfollowPlaylist('p.gone')
    assert.equal(first.ok, true)
    assert.equal(first.existed, true)
    const second = await store.unfollowPlaylist('p.gone')
    assert.equal(second.existed, false)
})

test('listFollowedPlaylists sorts by name', async () => {
    await store.createFollowedPlaylist({ libraryId: 'p.b', name: 'Bravo' })
    await store.createFollowedPlaylist({ libraryId: 'p.a', name: 'Alpha' })
    const names = (await store.listFollowedPlaylists()).map((p) => p.name)
    assert.ok(names.indexOf('Alpha') < names.indexOf('Bravo'))
    assert.ok(names.includes('Alpha'))
})
