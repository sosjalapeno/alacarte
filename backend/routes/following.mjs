import express from 'express'

import {
  followArtist,
  getFollowedArtist,
  listFollowedArtists,
  unfollowArtist,
  readFollowingStore,
  recomputeFollowedArtist,
} from '../lib/followedArtistsStore.mjs'
import { runAutoDownloadCheck } from '../lib/autoDownloads.mjs'
import { enqueueAlbum } from '../lib/queue.mjs'
import { scanLibraryOnce, hasAlbumInLibrary } from '../lib/libraryIndex.mjs'
import { loadArtistCatalogCached } from '../lib/artistCatalogCache.mjs'
import { describeInterval, FREQUENCY_VALUES, resolveIntervalMs } from '../lib/checkInterval.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { readPlaylistsStore } from '../lib/followedPlaylistsStore.mjs'
import { filterReleasesByScope, normalizeReleaseScope } from '../lib/releaseScope.mjs'

export const followingRouter = express.Router()

followingRouter.get('/', async (_req, res) => {
  try {
    res.json({ artists: await listFollowedArtists() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.post('/check/run', async (_req, res) => {
  try {
    res.json(await runAutoDownloadCheck({ reason: 'manual', force: true }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.get('/check/effective-interval', async (req, res) => {
  try {
    const settings = await readSettings()
    const store = await readFollowingStore()
    const playlistStore = await readPlaylistsStore()
    const followedCount =
      Object.keys(store.artists || {}).length +
      Object.keys(playlistStore.playlists || {}).length
    const requestedMode = String(req.query?.mode || '')
    const mode = FREQUENCY_VALUES.has(requestedMode)
      ? requestedMode
      : settings.autoDownloadCheckFrequency
    const ms = resolveIntervalMs(mode, followedCount)
    res.json({
      mode,
      followedCount,
      ms: Number.isFinite(ms) ? ms : null,
      label: describeInterval(ms),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.post('/download-missing', async (req, res) => {
  try {
    const quality = req.body?.quality
    const store = await readFollowingStore()
    const libIndex = await scanLibraryOnce()
    const followedCount = Object.keys(store.artists || {}).length
    let queuedCount = 0
    for (const artist of Object.values(store.artists)) {
      if (!artist.missingReleaseCount) continue

      const catalog = await loadArtistCatalogCached(
        {
          artistId: artist.id,
          storefront: artist.storefront,
          language: 'en-US',
        },
        { followedCount },
      )
      
      if (!catalog?.albums) continue
      const albums = filterReleasesByScope(catalog.albums, artist.releaseScope)
      
      for (const album of albums) {
        if (!album.artistName || !album.name) continue
        if (!(await hasAlbumInLibrary(album.artistName, album.name, libIndex))) {
          try {
            await enqueueAlbum({ 
              albumId: album.id, 
              storefront: artist.storefront,
              expectedArtistId: artist.id,
              quality,
            })
            queuedCount++
          } catch {
          }
        }
      }
    }
    res.json({ ok: true, queued: queuedCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.post('/:id/download-missing', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const store = await readFollowingStore()
    const artist = store.artists[id]
    if (!artist) return res.status(404).json({ error: 'artist not found' })
    const quality = req.body?.quality

    const libIndex = await scanLibraryOnce()
    let queuedCount = 0
    if (artist.missingReleaseCount > 0) {
      const catalog = await loadArtistCatalogCached({
        artistId: id,
        storefront: artist.storefront || 'us',
        language: 'en-US',
      })

      if (catalog?.albums) {
        const albums = filterReleasesByScope(catalog.albums, artist.releaseScope)
        for (const album of albums) {
          if (!album.artistName || !album.name) continue
          if (!(await hasAlbumInLibrary(album.artistName, album.name, libIndex))) {
            try {
              await enqueueAlbum({ 
                albumId: album.id, 
                storefront: artist.storefront,
                expectedArtistId: artist.id,
                quality,
              })
              queuedCount++
            } catch {
            }
          }
        }
      }
    }
    res.json({ ok: true, queued: queuedCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.get('/:id', async (req, res) => {
  try {
    const artist = await getFollowedArtist(String(req.params.id || '').trim())
    res.json({ artist })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.patch('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const artist = await recomputeFollowedArtist(id, {
      releaseScope: normalizeReleaseScope(req.body?.releaseScope),
    })
    if (!artist) return res.status(404).json({ error: 'artist not found' })
    res.json({ artist })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

followingRouter.post('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const downloadNow = Boolean(req.body?.downloadNow)
    const quality = req.body?.quality
    const releaseScope = normalizeReleaseScope(req.body?.releaseScope)
    const result = await followArtist({ artistId: id, downloadNow, releaseScope })
    const queued = []
    const failed = []
    if (downloadNow) {
      const libIndex = await scanLibraryOnce()
      for (const album of result.albums) {
        if (
          album.artistName &&
          album.name &&
          (await hasAlbumInLibrary(album.artistName, album.name, libIndex))
        ) {
          continue
        }
        try {
          const job = await enqueueAlbum({
            albumId: album.id,
            expectedArtistId: id,
            quality,
          })
          queued.push(job)
        } catch (err) {
          if (err?.code !== 'ALREADY_IN_LIBRARY') {
            failed.push({
              albumId: album.id,
              albumTitle: album.name,
              error: err.message || 'Failed to queue album',
            })
          }
        }
      }
    }
    res.json({ artist: result.artist, queued, failed })
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

followingRouter.delete('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    res.json(await unfollowArtist(id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
