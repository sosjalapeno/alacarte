import express from 'express'

import {
  getAlbum,
  getArtist,
  getPlaylist,
  getSong,
  normalizeAlbum,
  normalizePlaylist,
  searchCatalog,
} from '../lib/appleApi.mjs'
import { parseAppleMusicUrl } from '../lib/appleMusicUrl.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { filterAlbumsByRating } from '../lib/contentRatingFilter.mjs'

export const searchRouter = express.Router()

const EMPTY = { albums: [], artists: [], songs: [], playlists: [] }

function isMissingCatalogResource(err) {
  if (err?.status === 404) return true
  const msg = String(err?.message || '')
  return /Apple API 404\b/.test(msg) || /resource not found/i.test(msg)
}

function clientSafeSearchError(err) {
  const msg = String(err?.message || '')
  if (/^Apple API \d+/.test(msg)) return 'Search failed'
  return msg || 'Search failed'
}

function mapAlbum(x, resolveArtistId) {
  const relArtistId = x.relationships?.artists?.data?.[0]?.id || null
  return {
    id: x.id,
    type: x.type,
    name: x.attributes?.name,
    artistName: x.attributes?.artistName,
    artistId: resolveArtistId(relArtistId, x.attributes?.artistName),
    releaseDate: x.attributes?.releaseDate,
    year: x.attributes?.releaseDate
      ? String(x.attributes.releaseDate).slice(0, 4)
      : null,
    trackCount: x.attributes?.trackCount,
    isSingle: x.attributes?.isSingle,
    contentRating: x.attributes?.contentRating,
    artworkTemplate: x.attributes?.artwork?.url || null,
    artworkColor: x.attributes?.artwork?.bgColor || null,
    url: x.attributes?.url,
  }
}

function mapSong(x, resolveArtistId) {
  const songUrl = x.attributes?.url || ''
  const relArtistId = x.relationships?.artists?.data?.[0]?.id || null
  const m = songUrl.match(/\/album\/(?:[^/]+\/)?(\d+)(?:\?|$)/)
  const albumId = m ? m[1] : null
  return {
    id: x.id,
    type: x.type,
    name: x.attributes?.name,
    artistName: x.attributes?.artistName,
    artistId: resolveArtistId(relArtistId, x.attributes?.artistName),
    albumName: x.attributes?.albumName,
    albumId,
    durationMs: x.attributes?.durationInMillis,
    artworkTemplate: x.attributes?.artwork?.url || null,
    artworkColor: x.attributes?.artwork?.bgColor || null,
    url: songUrl,
  }
}

function mapPlaylist(x) {
  return {
    id: x.id,
    type: x.type,
    name: x.attributes?.name,
    curatorName: x.attributes?.curatorName || 'Apple Music',
    trackCount: x.attributes?.trackCount,
    artworkTemplate: x.attributes?.artwork?.url || null,
    artworkColor: x.attributes?.artwork?.bgColor || null,
    url: x.attributes?.url,
    description: x.attributes?.description?.standard || '',
  }
}

function albumFromNormalized(album) {
  if (!album) return null
  return {
    id: album.id,
    type: album.type,
    name: album.name,
    artistName: album.artistName,
    artistId: album.artistId,
    releaseDate: album.releaseDate,
    year: album.year,
    trackCount: album.trackCount,
    isSingle: album.isSingle,
    contentRating: album.contentRating,
    artworkTemplate: album.artworkTemplate,
    artworkColor: album.artworkColor,
    url: album.url,
  }
}

function playlistFromNormalized(playlist) {
  if (!playlist) return null
  return {
    id: playlist.id,
    type: playlist.type,
    name: playlist.name,
    curatorName: playlist.curatorName || 'Apple Music',
    trackCount: playlist.trackCount,
    artworkTemplate: playlist.artworkTemplate,
    artworkColor: playlist.artworkColor,
    url: playlist.url,
    description: playlist.description || '',
  }
}

async function resolveAppleMusicLink(parsed, { storefront, language, explicitFilter }) {
  const sf = parsed.storefront || storefront
  if (parsed.kind === 'album') {
    const raw = await getAlbum({ storefront: sf, id: parsed.id, language })
    const album = albumFromNormalized(normalizeAlbum(raw?.data?.[0]))
    if (!album) return { ...EMPTY, storefront: sf }
    const albums = filterAlbumsByRating([album], explicitFilter)
    if (!albums.length) return { ...EMPTY, storefront: sf }
    return {
      ...EMPTY,
      albums,
      storefront: sf,
      redirect: `/album/${encodeURIComponent(album.id)}`,
    }
  }

  if (parsed.kind === 'song') {
    let albumId = parsed.albumId || null
    if (!albumId) {
      const rawSong = await getSong({ storefront: sf, id: parsed.id, language })
      albumId = rawSong?.data?.[0]?.relationships?.albums?.data?.[0]?.id || null
    }
    if (!albumId) return { ...EMPTY, storefront: sf }
    const raw = await getAlbum({ storefront: sf, id: albumId, language })
    const album = albumFromNormalized(normalizeAlbum(raw?.data?.[0]))
    if (!album) return { ...EMPTY, storefront: sf }
    const albums = filterAlbumsByRating([album], explicitFilter)
    if (!albums.length) return { ...EMPTY, storefront: sf }
    return {
      ...EMPTY,
      albums,
      storefront: sf,
      redirect: `/album/${encodeURIComponent(album.id)}`,
    }
  }

  if (parsed.kind === 'artist') {
    const raw = await getArtist({ storefront: sf, id: parsed.id, language })
    const artistRaw = raw?.data?.[0]
    if (!artistRaw) return { ...EMPTY, storefront: sf }
    return {
      ...EMPTY,
      artists: [
        {
          id: artistRaw.id,
          type: artistRaw.type,
          name: artistRaw.attributes?.name,
          genreNames: artistRaw.attributes?.genreNames || [],
          url: artistRaw.attributes?.url,
        },
      ],
      storefront: sf,
      redirect: `/artist/${encodeURIComponent(artistRaw.id)}`,
    }
  }

  if (parsed.kind === 'playlist') {
    const raw = await getPlaylist({ storefront: sf, id: parsed.id, language })
    const playlist = playlistFromNormalized(normalizePlaylist(raw?.data?.[0]))
    if (!playlist) return { ...EMPTY, storefront: sf }
    return {
      ...EMPTY,
      playlists: [playlist],
      storefront: sf,
      redirect: `/playlist/${encodeURIComponent(playlist.id)}`,
    }
  }

  const err = new Error('unsupported Apple Music link')
  err.status = 400
  throw err
}

searchRouter.get('/', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim()
    if (!term) return res.json({ ...EMPTY })
    const types = String(req.query.types || 'albums,artists,songs,playlists')
    const limit = Math.min(Number(req.query.limit || 25), 50)
    const offset = Math.max(Number(req.query.offset || 0), 0)
    const settings = await readSettings()
    const storefront = String(req.query.storefront || settings.storefront || 'us')
    const language = settings.language || 'en-US'
    const explicitFilter = settings.explicitFilter || 'explicit'

    const parsed = parseAppleMusicUrl(term)
    if (parsed?.unsupported) {
      return res.status(400).json({ error: parsed.message })
    }
    if (parsed) {
      try {
        const resolved = await resolveAppleMusicLink(parsed, {
          storefront,
          language,
          explicitFilter,
        })
        return res.json(resolved)
      } catch (err) {
        if (err.status === 400) {
          return res.status(400).json({ error: err.message })
        }
        if (isMissingCatalogResource(err)) {
          return res.json({ ...EMPTY, storefront })
        }
        return res.status(502).json({ error: clientSafeSearchError(err) })
      }
    }

    const data = await searchCatalog({
      storefront,
      term,
      types,
      limit,
      offset,
      language,
    })
    const r = data?.results || {}
    const artists = (r.artists?.data || []).map((x) => ({
      id: x.id,
      type: x.type,
      name: x.attributes?.name,
      genreNames: x.attributes?.genreNames || [],
      url: x.attributes?.url,
    }))

    const resolveArtistId = (relId, artistName) => {
      if (relId) return relId
      const match = artists.find((a) => a.name === artistName)
      return match ? match.id : null
    }

    const albums = (r.albums?.data || []).map((x) =>
      mapAlbum(x, resolveArtistId),
    )
    const songs = (r.songs?.data || []).map((x) => mapSong(x, resolveArtistId))
    const filteredAlbums = filterAlbumsByRating(albums, explicitFilter)
    const playlists = (r.playlists?.data || []).map((x) => mapPlaylist(x))
    res.json({ albums: filteredAlbums, artists, songs, playlists, storefront })
  } catch (err) {
    res.status(502).json({ error: clientSafeSearchError(err) })
  }
})
