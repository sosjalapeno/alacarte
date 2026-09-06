import { emitEvent } from './eventBus.mjs'
import {
    getPlaylist,
    normalizePlaylist,
    iterateCatalogPlaylistTracks,
} from './appleApi.mjs'
import { getLibraryPlaylistDetail } from './appleLibraryApi.mjs'
import { hasSongInLibrary, invalidateLibraryCache, scanLibraryOnce } from './libraryIndex.mjs'
import { enqueueSong } from './queue.mjs'
import { readSettings, readAppleCreds } from './settingsStore.mjs'
import { resolveIntervalMs } from './checkInterval.mjs'
import { readFollowingStore } from './followedArtistsStore.mjs'
import {
    readPlaylistsStore,
    createFollowedPlaylist,
    updateFollowedPlaylist,
    rebuildFollowedPlaylistM3u,
    projectPlaylist,
} from './followedPlaylistsStore.mjs'

const SCHEDULER_TICK_MS = Math.max(
    60_000,
    Number(process.env.AMDL_FOLLOW_TICK_MS) || 5 * 60 * 1000,
)
const MAX_PER_TICK = Math.max(
    1,
    Number(process.env.AMDL_FOLLOW_MAX_PER_TICK) || 6,
)

let timer = null
let running = false
const syncingIds = new Set()

const defaultDeps = {
    fetchSource,
    scanLibrary: scanLibraryOnce,
    hasSong: (artistName, songName, libIndex, isrc) =>
        hasSongInLibrary(artistName, songName, libIndex, isrc),
    enqueue: async ({ songId, albumId, storefront, quality, followedPlaylistId }) =>
        enqueueSong({ songId, albumId, storefront, quality, followedPlaylistId }),
}

export function startPlaylistSyncScheduler() {
    if (timer) return
    timer = setInterval(() => {
        runPlaylistSyncCheck({ reason: 'scheduled' }).catch((err) => {
            emitEvent('playlist-following.check', {
                phase: 'failed',
                message: err.message || 'Playlist sync failed',
            })
        })
    }, SCHEDULER_TICK_MS)
    runPlaylistSyncCheck({ reason: 'startup' }).catch(() => {})
}

export async function runPlaylistSyncCheck({
    reason = 'manual',
    force = false,
    deps = defaultDeps,
} = {}) {
    if (running) return { ok: true, skipped: true, reason: 'already-running' }
    running = true
    try {
        const settings = await readSettings()
        const store = await readPlaylistsStore()
        const playlists = Object.values(store.playlists)
        if (playlists.length === 0) {
            return { ok: true, playlists: 0, queued: 0, discovered: 0 }
        }
        // Scheduled ticks stay silent when paused — the Settings page shows
        // the paused state, and a per-tick feed warning would be noise.
        if (!settings.autoDownloadsEnabled && !force) {
            return { ok: true, skipped: true, reason: 'disabled' }
        }

        const artistsStore = await readFollowingStore()
        const followedCount =
            playlists.length + Object.keys(artistsStore.artists || {}).length
        const intervalMs = resolveIntervalMs(
            settings.autoDownloadCheckFrequency,
            followedCount,
        )
        const now = Date.now()
        const dueAll = playlists
            .filter(
                (playlist) =>
                    force ||
                    !playlist.lastCheckedAt ||
                    now - playlist.lastCheckedAt >= intervalMs,
            )
            .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))
        const due = force ? dueAll : dueAll.slice(0, MAX_PER_TICK)

        if (due.length > 0) {
            emitEvent('playlist-following.check', {
                phase: 'started',
                reason,
                playlists: due.length,
                totalPlaylists: playlists.length,
                deferred: Math.max(0, dueAll.length - due.length),
            })
        }

        let queued = 0
        let discovered = 0
        for (const playlist of due) {
            const result = await syncFollowedPlaylist(playlist.id, {
                settings,
                force,
                deps,
            })
            if (result?.ok) {
                queued += result.queued || 0
                discovered += result.discovered || 0
            }
        }

        if (due.length > 0) {
            emitEvent('playlist-following.check', {
                phase: 'completed',
                reason,
                playlists: due.length,
                queued,
                discovered,
            })
        }

        return { ok: true, playlists: due.length, queued, discovered }
    } finally {
        running = false
    }
}

export async function followPlaylist({
    libraryId,
    catalogId,
    downloadNow = false,
    quality = null,
    deps = defaultDeps,
} = {}) {
    const settings = await readSettings()
    const libId = libraryId ? String(libraryId).trim() : null
    const catId = catalogId ? String(catalogId).trim() : null
    if (!libId && !catId) {
        const err = new Error('libraryId or catalogId required')
        err.statusCode = 400
        throw err
    }

    const source = await deps.fetchSource(
        { libraryId: libId, catalogId: catId },
        settings,
    )
    const sourceCatalogId = source.meta.catalogId || catId

    const store = await readPlaylistsStore()
    const existing = Object.values(store.playlists).find(
        (playlist) =>
            (libId && playlist.libraryId === libId) ||
            (catId && playlist.catalogId === catId) ||
            (sourceCatalogId && playlist.catalogId === sourceCatalogId),
    )
    if (existing) {
        const result = await syncFollowedPlaylist(existing.id, {
            settings,
            seedOnly: !downloadNow,
            downloadMissing: downloadNow,
            quality,
            deps,
        })
        return {
            playlist: result?.playlist || projectPlaylist(existing),
            queued: result?.queued || 0,
            failed: result?.failed || [],
            existed: true,
        }
    }

    const id = libId || catId
    await createFollowedPlaylist({
        id,
        libraryId: libId,
        catalogId: sourceCatalogId || catId,
        name: source.meta.name,
        curatorName: source.meta.curatorName,
        description: source.meta.description,
        artworkTemplate: source.meta.artworkTemplate,
        artworkColor: source.meta.artworkColor,
        isUserCreated: Boolean(source.meta.isUserCreated),
        storefront: settings.storefront || 'us',
        knownTrackIds: [],
        lastCheckedAt: 0,
        followedAt: Date.now(),
        totalTrackCount: source.tracks.length,
        missingTrackCount: 0,
        undownloadableTrackCount: 0,
        lastError: null,
    })

    const result = await syncFollowedPlaylist(id, {
        settings,
        seedOnly: !downloadNow,
        quality,
        deps,
    })
    return {
        playlist: result?.playlist || null,
        queued: result?.queued || 0,
        failed: result?.failed || [],
        existed: false,
    }
}

export async function syncFollowedPlaylist(id, opts = {}) {
    const {
        settings: settingsIn,
        seedOnly = false,
        downloadMissing = false,
        quality = null,
        force = false,
        deps = defaultDeps,
    } = opts
    const target = String(id || '').trim()
    const store = await readPlaylistsStore()
    const record =
        store.playlists[target] ||
        Object.values(store.playlists).find(
            (p) => p.libraryId === target || p.catalogId === target,
        )
    if (!record) return null
    if (syncingIds.has(record.id)) {
        return { ok: true, skipped: true, reason: 'already-syncing' }
    }
    syncingIds.add(record.id)
    try {
        return await runSyncPass(record, {
            settings: settingsIn || (await readSettings()),
            seedOnly,
            downloadMissing,
            quality,
            force,
            deps,
        })
    } finally {
        syncingIds.delete(record.id)
    }
}

async function runSyncPass(
    record,
    { settings, seedOnly, downloadMissing, quality, deps },
) {
    emitEvent('playlist-following.check', {
        phase: 'playlist-started',
        playlistId: record.id,
        playlistName: record.name,
    })

    let source
    try {
        source = await deps.fetchSource(record, settings)
    } catch (err) {
        // Still count the attempt so a permanently broken playlist can't
        // occupy a scheduler slot on every tick and starve healthy ones.
        await updateFollowedPlaylist(record.id, {
            lastError: err.message || 'Failed to fetch playlist',
            lastCheckedAt: Date.now(),
        })
        emitEvent('playlist-following.check', {
            phase: 'playlist-failed',
            playlistId: record.id,
            playlistName: record.name,
            error: err.message || 'Failed to fetch playlist',
        })
        return { ok: false, error: err.message || 'Failed to fetch playlist' }
    }

    const { meta, tracks } = source
    const libIndex = await deps.scanLibrary()
    const known = new Set(record.knownTrackIds || [])
    const currentIds = tracks.map((track) => track.id).filter(Boolean)

    const presentCache = new Map()
    const isPresent = async (track) => {
        if (!track.artistName || !track.name) return false
        if (!presentCache.has(track.id)) {
            presentCache.set(
                track.id,
                await deps.hasSong(
                    track.artistName,
                    track.name,
                    libIndex,
                    track.isrc,
                ),
            )
        }
        return presentCache.get(track.id)
    }

    const handled = new Set()
    const failed = []
    let queued = 0
    let candidates = []
    if (!seedOnly) {
        const seen = new Set()
        for (const track of tracks) {
            if (!track.downloadable || !track.id || !track.catalogId) continue
            if (seen.has(track.id)) continue
            seen.add(track.id)
            if (!known.has(track.id)) {
                candidates.push(track)
            } else if (downloadMissing && !(await isPresent(track))) {
                // Backfill: known track that never made it to the library.
                candidates.push(track)
            }
        }
    }

    for (const track of candidates) {
        if (await isPresent(track)) {
            handled.add(track.id)
            continue
        }
        // Bail out if the playlist was unfollowed mid-pass.
        const currentStore = await readPlaylistsStore()
        if (!currentStore.playlists[record.id]) {
            return { ok: false, error: 'playlist unfollowed during sync' }
        }
        try {
            const job = await deps.enqueue({
                songId: track.catalogId,
                albumId: track.catalogAlbumId || null,
                storefront: record.storefront || settings.storefront,
                quality,
                followedPlaylistId: record.id,
            })
            handled.add(track.id)
            queued += 1
            emitEvent('playlist-following.download', {
                playlistId: record.id,
                playlistName: meta.name || record.name,
                trackId: track.id,
                trackName: track.name,
                artistName: track.artistName,
                jobId: job?.id || null,
            })
        } catch (err) {
            if (err?.code === 'ALREADY_IN_LIBRARY') {
                handled.add(track.id)
            } else {
                failed.push({
                    trackId: track.id,
                    trackName: track.name,
                    error: err.message || 'Failed to queue track',
                })
                emitEvent('playlist-following.download', {
                    playlistId: record.id,
                    playlistName: meta.name || record.name,
                    trackId: track.id,
                    trackName: track.name,
                    artistName: track.artistName,
                    error: err.message || 'Failed to queue track',
                })
            }
        }
    }

    let missingCount = 0
    let undownloadableCount = 0
    for (const track of tracks) {
        if (!track.downloadable) {
            undownloadableCount += 1
            continue
        }
        if (!(await isPresent(track))) missingCount += 1
    }

    const nextKnown = seedOnly
        ? currentIds
        : currentIds.filter((id) => known.has(id) || handled.has(id))

    const updated = await updateFollowedPlaylist(record.id, {
        libraryId: record.libraryId,
        catalogId: meta.catalogId || record.catalogId,
        name: meta.name || record.name,
        curatorName: meta.curatorName || record.curatorName,
        description: meta.description ?? record.description,
        artworkTemplate: meta.artworkTemplate || record.artworkTemplate,
        artworkColor: meta.artworkColor || record.artworkColor,
        isUserCreated: meta.isUserCreated ?? record.isUserCreated,
        knownTrackIds: nextKnown,
        trackIndex: tracks.map((track) => ({
            id: track.id,
            name: track.name,
            artistName: track.artistName,
        })),
        totalTrackCount: tracks.length,
        missingTrackCount: missingCount,
        undownloadableTrackCount: undownloadableCount,
        lastCheckedAt: Date.now(),
        lastError: failed.length
            ? `${failed.length} track${failed.length === 1 ? '' : 's'} could not be queued`
            : null,
    })

    // The record can vanish if the user unfollows mid-pass; don't emit
    // updates for a record that no longer exists.
    if (!updated) {
        return { ok: false, error: 'playlist unfollowed during sync' }
    }

    const projected = projectPlaylist(updated)
    let playlistPath = null
    try {
        // Refresh the m3u8 export so music servers see tracks that landed
        // since the last pass (including the just-queued ones, once done).
        invalidateLibraryCache()
        playlistPath = await rebuildFollowedPlaylistM3u(updated)
    } catch (err) {
        console.error('followed playlist m3u rebuild failed:', err.message)
    }
    emitEvent('playlist-following.updated', {
        playlistId: record.id,
        totalTrackCount: tracks.length,
        missingTrackCount: missingCount,
        undownloadableTrackCount: undownloadableCount,
        queued,
        lastError: failed.length ? failed[0].error : null,
    })
    emitEvent('playlist-following.check', {
        phase: 'playlist-completed',
        playlistId: record.id,
        playlistName: meta.name || record.name,
        discovered: candidates.length,
        queued,
        failed: failed.length,
    })

    return {
        ok: true,
        playlist: projected,
        queued,
        discovered: candidates.length,
        failed,
        playlistPath,
    }
}

async function fetchSource(record, settings) {
    if (record.libraryId) return fetchLibrarySource(record, settings)
    if (record.catalogId) return fetchCatalogSource(record, settings)
    const err = new Error('playlist has no libraryId or catalogId')
    err.statusCode = 400
    throw err
}

async function fetchLibrarySource(record, settings) {
    const creds = await readAppleCreds()
    if (!creds.mediaUserToken) {
        const err = new Error('media-user-token not configured')
        err.code = 'NO_MEDIA_USER_TOKEN'
        err.statusCode = 412
        throw err
    }
    const detail = await getLibraryPlaylistDetail({
        libraryId: record.libraryId,
        mediaUserToken: creds.mediaUserToken,
        language: settings.language,
    })
    if (!detail) {
        const err = new Error('library playlist not found')
        err.statusCode = 404
        throw err
    }
    return {
        meta: {
            catalogId: detail.catalogId || null,
            name: detail.name,
            curatorName: detail.curatorName,
            description: detail.description,
            artworkTemplate: detail.artworkTemplate,
            artworkColor: detail.artworkColor,
            isUserCreated: detail.isUserCreated,
        },
        tracks: (detail.tracks || [])
            .filter((t) => !t.type || t.type === 'library-songs')
            .map((t) => ({
                id: t.id,
                catalogId: t.catalogId || null,
                name: t.name,
                artistName: t.artistName,
                isrc: null,
                catalogAlbumId: null,
                downloadable: Boolean(t.catalogId),
            })),
    }
}

async function fetchCatalogSource(record, settings) {
    const raw = await getPlaylist({
        storefront: record.storefront || settings.storefront,
        id: record.catalogId,
        language: settings.language,
    })
    const playlist = normalizePlaylist(raw?.data?.[0])
    if (!playlist) {
        const err = new Error('playlist not found')
        err.statusCode = 404
        throw err
    }

    // The single getPlaylist response truncates the tracks relationship at one
    // page; enumerate the paginated tracks endpoint so long playlists aren't.
    const tracks = []
    for await (const trackRaw of iterateCatalogPlaylistTracks({
        storefront: record.storefront || settings.storefront,
        id: record.catalogId,
        language: settings.language,
    })) {
        if (!trackRaw) continue
        const attrs = trackRaw.attributes || {}
        const isSong = !trackRaw.type || trackRaw.type === 'songs'
        tracks.push({
            id: String(trackRaw.id),
            catalogId: isSong ? String(trackRaw.id) : null,
            name: attrs.name || 'Unknown song',
            artistName: attrs.artistName || 'Unknown artist',
            isrc: attrs.isrc || null,
            catalogAlbumId: null,
            downloadable: isSong,
        })
    }

    return {
        meta: {
            catalogId: playlist.id || record.catalogId,
            name: playlist.name,
            curatorName: playlist.curatorName,
            description: playlist.description,
            artworkTemplate: playlist.artworkTemplate,
            artworkColor: playlist.artworkColor,
            isUserCreated: false,
        },
        tracks,
    }
}
