import { emitEvent } from './eventBus.mjs'
import { loadArtistCatalogCached } from './artistCatalogCache.mjs'
import { resolveIntervalMs } from './checkInterval.mjs'
import { makeAlbumKey, scanLibraryOnce, stripTrailingYear } from './libraryIndex.mjs'
import { enqueueAlbum } from './queue.mjs'
import { readSettings } from './settingsStore.mjs'
import { readFollowingStore, updateFollowedArtist } from './followedArtistsStore.mjs'
import { readPlaylistsStore } from './followedPlaylistsStore.mjs'
import { filterReleasesByScope, normalizeReleaseScope } from './releaseScope.mjs'

const SCHEDULER_TICK_MS = Math.max(60_000, Number(process.env.AMDL_FOLLOW_TICK_MS) || 5 * 60 * 1000)
const MAX_PER_TICK = Math.max(1, Number(process.env.AMDL_FOLLOW_MAX_PER_TICK) || 6)

let timer = null
let running = false

export function startAutoDownloadScheduler() {
  if (timer) return
  timer = setInterval(() => {
    runAutoDownloadCheck({ reason: 'scheduled' }).catch((err) => {
      emitEvent('following.check', {
        phase: 'failed',
        message: err.message || 'Auto-download check failed',
      })
    })
  }, SCHEDULER_TICK_MS)
  runAutoDownloadCheck({ reason: 'startup' }).catch(() => {})
}

export async function runAutoDownloadCheck({ reason = 'manual', force = false } = {}) {
  if (running) return { ok: true, skipped: true, reason: 'already-running' }
  running = true
  try {
    const settings = await readSettings()
    if (!settings.autoDownloadsEnabled && !force) {
      // Scheduled ticks stay silent when paused — the Settings page shows
      // the paused state, and a per-tick feed warning would be noise.
      return { ok: true, skipped: true, reason: 'disabled' }
    }

    const store = await readFollowingStore()
    const artists = Object.values(store.artists)
    // Share the Apple API budget across artist and playlist follows so the
    // effective interval matches what the Settings hint reports.
    const playlistStore = await readPlaylistsStore()
    const followedCount =
      artists.length + Object.keys(playlistStore.playlists || {}).length
    const intervalMs = resolveIntervalMs(settings.autoDownloadCheckFrequency, followedCount)
    const now = Date.now()
    const dueArtistsAll = artists
      .filter(
        (artist) =>
          force ||
          !artist.lastCheckedAt ||
          now - artist.lastCheckedAt >= intervalMs,
      )
      .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))
    const dueArtists = force
      ? dueArtistsAll
      : dueArtistsAll.slice(0, MAX_PER_TICK)

    if (dueArtists.length > 0) {
      emitEvent('following.check', {
        phase: 'started',
        reason,
        artists: dueArtists.length,
        totalArtists: artists.length,
        deferred: Math.max(0, dueArtistsAll.length - dueArtists.length),
      })
    }

    const libIndex = await scanLibraryOnce()

    let queued = 0
    let discovered = 0
    for (const artist of dueArtists) {
      const result = await checkFollowedArtist(artist, settings, libIndex, followedCount)
      queued += result.queued
      discovered += result.discovered
    }

    if (dueArtists.length > 0) {
      emitEvent('following.check', {
        phase: 'completed',
        reason,
        artists: dueArtists.length,
        queued,
        discovered,
      })
    }

    return { ok: true, artists: dueArtists.length, queued, discovered }
  } finally {
    running = false
  }
}

async function checkFollowedArtist(artist, settings, libIndex, followedCount) {
  emitEvent('following.check', {
    phase: 'artist-started',
    artistId: artist.id,
    artistName: artist.name,
  })

  const catalog = await loadArtistCatalogCached(
    {
      artistId: artist.id,
      storefront: artist.storefront || settings.storefront || 'us',
      language: settings.language || 'en-US',
      explicitFilter: settings.explicitFilter || 'explicit',
    },
    { followedCount },
  )
  const scope = normalizeReleaseScope(artist.releaseScope)
  const albums = filterReleasesByScope(catalog?.albums || [], scope)
  const known = new Set(artist.knownReleaseIds || [])
  const newAlbums = albums.filter((album) => album.id && !known.has(album.id))
  const releaseDates = albums
    .map((album) => album.releaseDate)
    .filter(Boolean)
    .sort()
  const successfulIds = new Set(artist.knownReleaseIds || [])
  let queued = 0

  for (const album of newAlbums) {
    if (
      album.artistName &&
      album.name &&
      libIndex.albumKeys.has(
        makeAlbumKey(album.artistName, stripTrailingYear(album.name)),
      )
    ) {
      successfulIds.add(album.id)
      continue
    }

    try {
      const job = await enqueueAlbum({
        albumId: album.id,
        storefront: artist.storefront || settings.storefront || 'us',
        expectedArtistId: artist.id,
      })
      queued += 1
      successfulIds.add(album.id)
      emitEvent('following.download', {
        artistId: artist.id,
        artistName: artist.name,
        albumId: album.id,
        albumTitle: album.name,
        jobId: job.id,
      })
    } catch (err) {
      if (err?.code === 'ALREADY_IN_LIBRARY') {
        successfulIds.add(album.id)
      } else {
        emitEvent('following.download', {
          artistId: artist.id,
          artistName: artist.name,
          albumId: album.id,
          albumTitle: album.name,
          error: err.message || 'Failed to queue auto-download',
        })
      }
    }
  }

  let missingCount = 0
  for (const album of albums) {
    if (!album.artistName || !album.name) continue
    const key = makeAlbumKey(album.artistName, stripTrailingYear(album.name))
    if (!key || !libIndex.albumKeys.has(key)) {
      missingCount++
    }
  }

  await updateFollowedArtist(artist.id, {
    name: catalog?.artist?.name || artist.name,
    genreNames: catalog?.artist?.genreNames || artist.genreNames,
    url: catalog?.artist?.url || artist.url,
    artworkTemplate:
      catalog?.artist?.artworkTemplate ||
      albums.find((album) => album.artworkTemplate)?.artworkTemplate ||
      artist.artworkTemplate ||
      null,
    artworkColor:
      catalog?.artist?.artworkColor ||
      albums.find((album) => album.artworkColor)?.artworkColor ||
      artist.artworkColor ||
      null,
    knownReleaseIds: Array.from(successfulIds),
    latestReleaseDate: releaseDates[releaseDates.length - 1] || artist.latestReleaseDate || null,
    lastCheckedAt: Date.now(),
    totalReleaseCount: albums.length,
    missingReleaseCount: missingCount,
    releaseScope: scope,
  })

  emitEvent('following.check', {
    phase: 'artist-completed',
    artistId: artist.id,
    artistName: artist.name,
    discovered: newAlbums.length,
    queued,
  })

  return { discovered: newAlbums.length, queued }
}
