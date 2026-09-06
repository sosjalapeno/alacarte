import express from 'express'

import {
    listFollowedPlaylists,
    getFollowedPlaylistByAnyId,
    unfollowPlaylist,
} from '../lib/followedPlaylistsStore.mjs'
import {
    followPlaylist,
    syncFollowedPlaylist,
    runPlaylistSyncCheck,
} from '../lib/playlistSync.mjs'

export const playlistFollowingRouter = express.Router()

playlistFollowingRouter.get('/', async (_req, res) => {
    try {
        res.json({ playlists: await listFollowedPlaylists() })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

playlistFollowingRouter.post('/sync/run', async (_req, res) => {
    try {
        res.json(await runPlaylistSyncCheck({ reason: 'manual', force: true }))
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

playlistFollowingRouter.post('/library/:libraryId', async (req, res) => {
    try {
        const libraryId = String(req.params.libraryId || '').trim()
        if (!libraryId) return res.status(400).json({ error: 'libraryId required' })
        const result = await followPlaylist({
            libraryId,
            downloadNow: Boolean(req.body?.downloadNow),
            quality: req.body?.quality || null,
        })
        res.json(result)
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message })
    }
})

playlistFollowingRouter.post('/catalog/:catalogId', async (req, res) => {
    try {
        const catalogId = String(req.params.catalogId || '').trim()
        if (!catalogId) return res.status(400).json({ error: 'catalogId required' })
        const result = await followPlaylist({
            catalogId,
            downloadNow: Boolean(req.body?.downloadNow),
            quality: req.body?.quality || null,
        })
        res.json(result)
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message })
    }
})

// Resolve any of the record's ids (primary, library, or catalog) first so
// clients can address a follow the same way for every verb.
async function resolveFollowId(id) {
    const playlist = await getFollowedPlaylistByAnyId(String(id || '').trim())
    return playlist?.id || null
}

playlistFollowingRouter.post('/:id/sync', async (req, res) => {
    try {
        const recordId = await resolveFollowId(req.params.id)
        if (!recordId) return res.status(404).json({ error: 'playlist not found' })
        const result = await syncFollowedPlaylist(recordId, { force: true })
        if (!result) return res.status(404).json({ error: 'playlist not found' })
        if (!result.ok) return res.status(502).json({ error: result.error })
        res.json(result)
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message })
    }
})

playlistFollowingRouter.post('/:id/download-missing', async (req, res) => {
    try {
        const recordId = await resolveFollowId(req.params.id)
        if (!recordId) return res.status(404).json({ error: 'playlist not found' })
        const result = await syncFollowedPlaylist(recordId, {
            force: true,
            downloadMissing: true,
            quality: req.body?.quality || null,
        })
        if (!result) return res.status(404).json({ error: 'playlist not found' })
        if (!result.ok) return res.status(502).json({ error: result.error })
        res.json({ ok: true, playlist: result.playlist, queued: result.queued })
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message })
    }
})

playlistFollowingRouter.get('/:id', async (req, res) => {
    try {
        const playlist = await getFollowedPlaylistByAnyId(
            String(req.params.id || '').trim(),
        )
        res.json({ playlist })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

playlistFollowingRouter.delete('/:id', async (req, res) => {
    try {
        const recordId = await resolveFollowId(req.params.id)
        if (!recordId) return res.json({ ok: true, existed: false })
        res.json(await unfollowPlaylist(recordId))
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})
