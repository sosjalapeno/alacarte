import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent, onEvent } from './eventBus.mjs'
import { getMusicRoot, invalidateLibraryCache, makeSongKey, scanLibraryOnce } from './libraryIndex.mjs'
import { sanitizeSegment } from './folderLayout.mjs'
import { writePlaylistM3U } from './playlistExport.mjs'

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const PLAYLISTS_FILE = path.join(CONFIG_DIR, 'followed-playlists.json')

const EMPTY_STORE = {
    version: 1,
    playlists: {},
}

// Mutations do a read-modify-write of the whole store file; serialize them so
// concurrent passes/follows can't clobber each other with stale snapshots.
let _writeChain = Promise.resolve()
function serialize(operation) {
    const run = _writeChain.then(operation, operation)
    _writeChain = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

export async function readPlaylistsStore() {
    try {
        const raw = await fsp.readFile(PLAYLISTS_FILE, 'utf8')
        return normalizeStore(JSON.parse(raw))
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            // Keep the corrupt file around for inspection instead of letting
            // the next write silently commit an empty store over it.
            console.error('followed-playlists.json unreadable:', err.message)
            await fsp
                .rename(
                    PLAYLISTS_FILE,
                    `${PLAYLISTS_FILE}.corrupt-${Date.now()}`,
                )
                .catch(() => null)
        }
        return normalizeStore({})
    }
}

async function writePlaylistsStore(next) {
    const normalized = normalizeStore(next)
    const tmpFile = `${PLAYLISTS_FILE}.tmp`
    await fsp.writeFile(tmpFile, JSON.stringify(normalized, null, 2), {
        mode: 0o600,
    })
    await fsp.rename(tmpFile, PLAYLISTS_FILE)
    return normalized
}

export async function listFollowedPlaylists() {
    const store = await readPlaylistsStore()
    const playlists = Object.values(store.playlists).map(projectPlaylist)
    playlists.sort((a, b) => a.name.localeCompare(b.name))
    return playlists
}

// Accepts the primary id, a library playlist id, or a catalog playlist id.
export async function getFollowedPlaylistByAnyId(id) {
    const store = await readPlaylistsStore()
    const target = String(id || '').trim()
    if (!target) return null
    const record =
        store.playlists[target] ||
        Object.values(store.playlists).find(
            (p) => p.libraryId === target || p.catalogId === target,
        )
    return record ? projectPlaylist(record) : null
}

export async function getFollowedPlaylistRecord(id) {
    const store = await readPlaylistsStore()
    return store.playlists[String(id || '').trim()] || null
}

export async function createFollowedPlaylist(record) {
    return serialize(async () => {
        const store = await readPlaylistsStore()
        const normalized = normalizePlaylistRecord(record)
        if (!normalized.id) {
            const err = new Error('playlist id required')
            err.statusCode = 400
            throw err
        }
        store.playlists[normalized.id] = normalized
        await writePlaylistsStore(store)
        return normalized
    })
}

export async function updateFollowedPlaylist(id, patch) {
    return serialize(async () => {
        const store = await readPlaylistsStore()
        const current = store.playlists[id]
        if (!current) return null
        store.playlists[id] = normalizePlaylistRecord({
            ...current,
            ...patch,
            id: current.id,
            libraryId:
                patch.libraryId !== undefined
                    ? patch.libraryId
                    : current.libraryId,
            catalogId:
                patch.catalogId !== undefined
                    ? patch.catalogId
                    : current.catalogId,
            updatedAt: Date.now(),
        })
        await writePlaylistsStore(store)
        return store.playlists[id]
    })
}

export async function unfollowPlaylist(id) {
    return serialize(async () => {
        const store = await readPlaylistsStore()
        const existed = Boolean(store.playlists[id])
        delete store.playlists[id]
        await writePlaylistsStore(store)
        if (existed) {
            emitEvent('playlist-following.updated', {
                playlistId: id,
                followed: false,
            })
        }
        return { ok: true, existed }
    })
}

// Serialized read-modify-write so concurrent job-done events can't lose
// decrements.
export async function decrementFollowedPlaylistMissing(id) {
    return serialize(async () => {
        const store = await readPlaylistsStore()
        const record = store.playlists[id]
        if (!record || record.missingTrackCount <= 0) return null
        const nextMissing = Math.max(0, record.missingTrackCount - 1)
        store.playlists[id] = normalizePlaylistRecord({
            ...record,
            missingTrackCount: nextMissing,
            updatedAt: Date.now(),
        })
        await writePlaylistsStore(store)
        return store.playlists[id]
    })
}

export function projectPlaylist(playlist) {
    const total = playlist.totalTrackCount || 0
    const missing = playlist.missingTrackCount || 0
    const downloadableTotal = Math.max(
        0,
        total - (playlist.undownloadableTrackCount || 0),
    )
    const { trackIndex, ...projected } = playlist
    return {
        ...projected,
        totalTrackCount: total,
        missingTrackCount: missing,
        undownloadableTrackCount: playlist.undownloadableTrackCount || 0,
        downloadableTrackCount: downloadableTotal,
        fullyDownloaded:
            downloadableTotal > 0 &&
            missing === 0 &&
            Boolean(playlist.lastCheckedAt),
    }
}

// Rebuild the m3u8 export for a followed playlist from the tracks that are
// actually on disk, in playlist order, so Plexamp/Navidrome/Jellyfin see the
// same playlist. No-op until at least one track has landed in the library;
// a previously written export is removed when no tracks remain on disk.
export async function rebuildFollowedPlaylistM3u(record) {
    if (!record || !Array.isArray(record.trackIndex)) return null
    if (record.trackIndex.length === 0) return null
    const index = await scanLibraryOnce()
    const musicRoot = getMusicRoot()
    const absPaths = []
    for (const track of record.trackIndex) {
        if (!track?.artistName || !track?.name) continue
        const key = makeSongKey(track.artistName, track.name)
        const rel = key ? index.songPaths?.get(key) : null
        if (rel) absPaths.push(path.join(musicRoot, rel))
    }
    if (absPaths.length === 0) {
        const base = sanitizeSegment(record.name || 'Playlist')
        const stale = path.join(musicRoot, 'Playlists', `${base}.m3u8`)
        await fsp.unlink(stale).catch(() => null)
        return null
    }
    return writePlaylistM3U({
        playlistName: record.name,
        playlistId: record.catalogId,
        libraryPlaylistId: record.libraryId,
        tracks: absPaths,
        artworkTemplate: record.artworkTemplate,
        reuseArtwork: true,
    })
}

function normalizeStore(parsed) {
    const playlists = {}
    for (const [id, playlist] of Object.entries(parsed?.playlists || {})) {
        const normalized = normalizePlaylistRecord({ ...playlist, id })
        if (normalized.id) playlists[normalized.id] = normalized
    }
    return {
        ...EMPTY_STORE,
        ...parsed,
        version: 1,
        playlists,
    }
}

function normalizePlaylistRecord(playlist) {
    const libraryId = playlist?.libraryId ? String(playlist.libraryId) : null
    const catalogId = playlist?.catalogId ? String(playlist.catalogId) : null
    const id = String(playlist?.id || libraryId || catalogId || '').trim()
    return {
        id,
        libraryId,
        catalogId,
        name: String(playlist?.name || 'Untitled playlist'),
        curatorName: String(playlist?.curatorName || 'Apple Music'),
        description: String(playlist?.description || ''),
        artworkTemplate: playlist?.artworkTemplate || null,
        artworkColor: playlist?.artworkColor || null,
        isUserCreated: Boolean(playlist?.isUserCreated),
        storefront: String(playlist?.storefront || 'us'),
        knownTrackIds: Array.from(
            new Set(
                (Array.isArray(playlist?.knownTrackIds)
                    ? playlist.knownTrackIds
                    : []
                ).map(String),
            ),
        ),
        lastCheckedAt: Number(playlist?.lastCheckedAt || 0),
        followedAt: Number(playlist?.followedAt || Date.now()),
        updatedAt: Number(playlist?.updatedAt || Date.now()),
        trackIndex: (Array.isArray(playlist?.trackIndex) ? playlist.trackIndex : [])
            .slice(0, 5000)
            .map((t) => ({
                id: String(t?.id || ''),
                name: String(t?.name || ''),
                artistName: String(t?.artistName || ''),
            }))
            .filter((t) => t.id || t.name),
        totalTrackCount: Number(playlist?.totalTrackCount || 0),
        missingTrackCount: Number(playlist?.missingTrackCount || 0),
        undownloadableTrackCount: Number(
            playlist?.undownloadableTrackCount || 0,
        ),
        lastError: playlist?.lastError || null,
    }
}

// Song jobs enqueued by the playlist sync carry followedPlaylistId; use their
// completion to keep missingTrackCount fresh between sync passes and to
// refresh the playlist m3u8 export as tracks land in the library. Songs that
// appear in several followed playlists refresh all of them.
onEvent(async (evt) => {
    if (!evt || evt.type !== 'job.update') return
    const job = evt.data
    if (
        !job ||
        job.status !== 'done' ||
        job.kind !== 'song' ||
        !job.followedPlaylistId
    )
        return
    try {
        invalidateLibraryCache()
        const store = await readPlaylistsStore()
        const affected = Object.values(store.playlists).filter(
            (record) =>
                record.id === job.followedPlaylistId ||
                (Array.isArray(record.trackIndex) &&
                    job.songId &&
                    record.trackIndex.some((t) => t.id === job.songId)),
        )
        for (const record of affected) {
            if (record.id === job.followedPlaylistId && record.missingTrackCount > 0) {
                const updated = await decrementFollowedPlaylistMissing(record.id)
                if (updated) {
                    emitEvent('playlist-following.updated', {
                        playlistId: record.id,
                        missingTrackCount: updated.missingTrackCount,
                        totalTrackCount: updated.totalTrackCount,
                    })
                }
            }
            await rebuildFollowedPlaylistM3u(record)
        }
    } catch (err) {
        console.error(
            'Failed to update followed playlist for job',
            job.id,
            err,
        )
    }
})
