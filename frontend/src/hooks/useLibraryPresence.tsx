import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  api,
  type Album,
  type LibraryAlbum,
  type LibrarySingle,
  type Playlist,
  type Song,
} from '../api/client'
import { makeAlbumMatchKey, makeSongMatchKey } from '../lib/libraryMatchKey'
import { useEventStream } from './useEventStream'

type AlbumLookup = Pick<Album, 'id' | 'artistName' | 'name'> & {
  albumName?: string | null
  upc?: string | null
}
type SongLookup = Pick<Song, 'id' | 'artistName' | 'name'> & {
  songName?: string | null
  isrc?: string | null
}
type PlaylistLookup = Pick<Playlist, 'id'>

export type AlbumTrackPresence = {
  present: number
  expected: number
  complete: boolean
  folderExists: boolean
  tracks: Record<string, boolean>
}

type AlbumTracksLookup = {
  id: string
  artistName: string
  name: string
  tracks: Array<{ id: string; name: string; isrc?: string | null }>
}

type LibraryPresenceContextValue = {
  loading: boolean
  ready: boolean
  isAlbumInLibrary: (album: AlbumLookup | null | undefined) => boolean
  isSongInLibrary: (song: SongLookup | null | undefined) => boolean
  isPlaylistInLibrary: (playlist: PlaylistLookup | null | undefined) => boolean
  verifyAlbumPresence: (album: AlbumLookup | null | undefined, force?: boolean) => Promise<boolean>
  verifySongPresence: (song: SongLookup | null | undefined, force?: boolean) => Promise<boolean>
  verifyPlaylistPresence: (playlist: PlaylistLookup | null | undefined, force?: boolean) => Promise<boolean>
  verifyAlbumTracksPresence: (
    album: AlbumTracksLookup | null | undefined,
    force?: boolean,
  ) => Promise<AlbumTrackPresence | null>
  getAlbumTrackPresence: (albumId: string | null | undefined) => AlbumTrackPresence | null
  refreshLibraryPresence: () => Promise<void>
}

type PresenceSnapshot = {
  albumKeys: Record<string, true>
  songKeys: Record<string, true>
  playlistIds: Record<string, true>
  isrcs: Record<string, true>
  upcs: Record<string, true>
  albumTrackPresence: Record<string, AlbumTrackPresence>
}

const LibraryPresenceContext = createContext<LibraryPresenceContextValue | null>(null)

function normalizeIsrcClient(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).toUpperCase().replace(/[\s\-]/g, '')
}

function normalizeUpcClient(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).replace(/\D/g, '')
}

export function LibraryPresenceProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>({
    albumKeys: {},
    songKeys: {},
    playlistIds: {},
    isrcs: {},
    upcs: {},
    albumTrackPresence: {},
  })
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const requestIdRef = useRef(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadSnapshot = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current
    if (!silent) setLoading(true)
    try {
      const r = await api.library()
      if (requestId !== requestIdRef.current) return
      setSnapshot((prev) => ({
        ...buildSnapshot(
          r.albums,
          r.singles,
          r.playlistIds || [],
          r.songKeys || [],
          r.albumKeys || [],
          r.isrcs || [],
          r.upcs || [],
        ),
        albumTrackPresence: prev.albumTrackPresence,
      }))
      setReady(true)
    } finally {
      if (!silent && requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot(false)
  }, [loadSnapshot])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  useEventStream((type, data) => {
    if (type === 'tags.backfill.progress') {
      if (data?.done) {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null
          void loadSnapshot(true)
        }, 250)
      }
      return
    }
    if (type !== 'job.update' || data?.status !== 'done') return
    const albumId = String(data?.albumId || '')
    if (albumId) {
      setSnapshot((prev) => {
        if (!prev.albumTrackPresence[albumId]) return prev
        const next = { ...prev.albumTrackPresence }
        delete next[albumId]
        return { ...prev, albumTrackPresence: next }
      })
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void loadSnapshot(true)
    }, 250)
  })

  const isAlbumInLibrary = useCallback(
    (album: AlbumLookup | null | undefined) => {
      const upc = normalizeUpcClient(album?.upc)
      if (upc && snapshot.upcs[upc]) return true
      const key = makeAlbumKey(album)
      return Boolean(key && snapshot.albumKeys[key])
    },
    [snapshot.albumKeys, snapshot.upcs],
  )

  const isSongInLibrary = useCallback(
    (song: SongLookup | null | undefined) => {
      const isrc = normalizeIsrcClient(song?.isrc)
      if (isrc && snapshot.isrcs[isrc]) return true
      const key = makeSongKey(song)
      return Boolean(key && snapshot.songKeys[key])
    },
    [snapshot.songKeys, snapshot.isrcs],
  )

  const isPlaylistInLibrary = useCallback(
    (playlist: PlaylistLookup | null | undefined) => {
      const id = String(playlist?.id || '')
      return Boolean(id && snapshot.playlistIds[id])
    },
    [snapshot.playlistIds],
  )

  const verifyAlbumPresence = useCallback(
    async (album: AlbumLookup | null | undefined, force = false) => {
      const artistName = String(album?.artistName || '').trim()
      const albumName = getAlbumName(album)
      const key = makeAlbumKey(album)
      const upc = normalizeUpcClient(album?.upc)
      if (!artistName || !albumName) return false
      if (!force) {
        if (upc && snapshot.upcs[upc]) return true
        if (key && snapshot.albumKeys[key]) return true
      }
      if (!key && !upc) return false
      const requestId = String(album?.id || key || upc)
      const r = await api.libraryPresence({
        albums: [{ id: requestId, artistName, albumName, upc: upc || null }],
      })
      const present = Boolean(r.albums?.[requestId])
      if (present) {
        setSnapshot((prev) => {
          let next = prev
          if (key && !prev.albumKeys[key]) {
            next = { ...next, albumKeys: { ...next.albumKeys, [key]: true } }
          }
          if (upc && !prev.upcs[upc]) {
            next = { ...next, upcs: { ...next.upcs, [upc]: true } }
          }
          return next
        })
      } else if (key) {
        setSnapshot((prev) => {
          if (!prev.albumKeys[key]) return prev
          const next = { ...prev.albumKeys }
          delete next[key]
          return { ...prev, albumKeys: next }
        })
      }
      return present
    },
    [snapshot.albumKeys, snapshot.upcs],
  )

  const verifySongPresence = useCallback(
    async (song: SongLookup | null | undefined, force = false) => {
      const artistName = String(song?.artistName || '').trim()
      const songName = getSongName(song)
      const key = makeSongKey(song)
      const isrc = normalizeIsrcClient(song?.isrc)
      if (!artistName || !songName) return false
      if (!force) {
        if (isrc && snapshot.isrcs[isrc]) return true
        if (key && snapshot.songKeys[key]) return true
      }
      if (!key && !isrc) return false
      const requestId = String(song?.id || key || isrc)
      const r = await api.libraryPresence({
        songs: [{ id: requestId, artistName, songName, isrc: isrc || null }],
      })
      const present = Boolean(r.songs?.[requestId])
      if (present) {
        setSnapshot((prev) => {
          let next = prev
          if (key && !prev.songKeys[key]) {
            next = { ...next, songKeys: { ...next.songKeys, [key]: true } }
          }
          if (isrc && !prev.isrcs[isrc]) {
            next = { ...next, isrcs: { ...next.isrcs, [isrc]: true } }
          }
          return next
        })
      } else if (key) {
        setSnapshot((prev) => {
          if (!prev.songKeys[key]) return prev
          const next = { ...prev.songKeys }
          delete next[key]
          return { ...prev, songKeys: next }
        })
      }
      return present
    },
    [snapshot.songKeys, snapshot.isrcs],
  )

  const verifyPlaylistPresence = useCallback(
    async (playlist: PlaylistLookup | null | undefined, force = false) => {
      const id = String(playlist?.id || '')
      if (!id) return false
      if (!force && snapshot.playlistIds[id]) return true
      const r = await api.libraryPresence({ playlists: [{ id }] })
      const present = Boolean(r.playlists?.[id])
      setSnapshot((prev) => {
        if (present === Boolean(prev.playlistIds[id])) return prev
        const next = { ...prev.playlistIds }
        if (present) next[id] = true
        else delete next[id]
        return { ...prev, playlistIds: next }
      })
      return present
    },
    [snapshot.playlistIds],
  )

  const verifyAlbumTracksPresence = useCallback(
    async (album: AlbumTracksLookup | null | undefined, force = false) => {
      const id = String(album?.id || '')
      const artistName = String(album?.artistName || '').trim()
      const albumName = String(album?.name || '').trim()
      const tracks = (album?.tracks || []).filter((t) => t && t.id && t.name)
      if (!id || !artistName || !albumName || tracks.length === 0) return null
      if (!force && snapshot.albumTrackPresence[id]) {
        return snapshot.albumTrackPresence[id]
      }
      const r = await api.libraryPresence({
        albumTracks: [
          {
            id,
            artistName,
            albumName,
            tracks: tracks.map((t) => ({
              id: String(t.id),
              name: String(t.name),
              isrc: t.isrc || null,
            })),
          },
        ],
      })
      const entry = r.albumTracks?.[id] || null
      if (!entry) return null
      setSnapshot((prev) => ({
        ...prev,
        albumTrackPresence: { ...prev.albumTrackPresence, [id]: entry },
      }))
      return entry
    },
    [snapshot.albumTrackPresence],
  )

  const getAlbumTrackPresence = useCallback(
    (albumId: string | null | undefined) => {
      const id = String(albumId || '')
      if (!id) return null
      return snapshot.albumTrackPresence[id] || null
    },
    [snapshot.albumTrackPresence],
  )

  const refreshLibraryPresence = useCallback(async () => {
    await loadSnapshot(true)
  }, [loadSnapshot])

  const value = useMemo<LibraryPresenceContextValue>(
    () => ({
      loading,
      ready,
      isAlbumInLibrary,
      isSongInLibrary,
      isPlaylistInLibrary,
      verifyAlbumPresence,
      verifySongPresence,
      verifyPlaylistPresence,
      verifyAlbumTracksPresence,
      getAlbumTrackPresence,
      refreshLibraryPresence,
    }),
    [
      isAlbumInLibrary,
      isSongInLibrary,
      isPlaylistInLibrary,
      loading,
      ready,
      refreshLibraryPresence,
      verifyAlbumPresence,
      verifySongPresence,
      verifyPlaylistPresence,
      verifyAlbumTracksPresence,
      getAlbumTrackPresence,
    ],
  )

  return (
    <LibraryPresenceContext.Provider value={value}>
      {children}
    </LibraryPresenceContext.Provider>
  )
}

export function useLibraryPresence() {
  const value = useContext(LibraryPresenceContext)
  if (!value) {
    throw new Error('useLibraryPresence must be used within LibraryPresenceProvider')
  }
  return value
}

function buildSnapshot(
  albums: LibraryAlbum[],
  singles: LibrarySingle[],
  playlistIdsArr: string[],
  songKeysArr: string[],
  albumKeysArr: string[] = [],
  isrcsArr: string[] = [],
  upcsArr: string[] = [],
): PresenceSnapshot {
  const albumKeys: Record<string, true> = {}
  const songKeys: Record<string, true> = {}
  const playlistIds: Record<string, true> = {}
  const isrcs: Record<string, true> = {}
  const upcs: Record<string, true> = {}

  for (const key of albumKeysArr || []) {
    if (key) albumKeys[String(key)] = true
  }

  // Fallback if older server omitted albumKeys
  if (albumKeysArr.length === 0) {
    for (const album of albums) {
      const key = makeAlbumKey(album)
      if (key) albumKeys[key] = true
    }
  }

  for (const single of singles) {
    const key = makeSongKey(single)
    if (key) songKeys[key] = true
  }

  for (const key of songKeysArr || []) {
    if (key) songKeys[String(key)] = true
  }

  for (const id of playlistIdsArr || []) {
    if (id) playlistIds[String(id)] = true
  }

  for (const isrc of isrcsArr || []) {
    const n = normalizeIsrcClient(isrc)
    if (n) isrcs[n] = true
  }

  for (const upc of upcsArr || []) {
    const n = normalizeUpcClient(upc)
    if (n) upcs[n] = true
  }

  return { albumKeys, songKeys, playlistIds, isrcs, upcs, albumTrackPresence: {} }
}

function makeAlbumKey(album: AlbumLookup | LibraryAlbum | null | undefined) {
  return makeAlbumMatchKey(album?.artistName, getAlbumName(album))
}

function makeSongKey(song: SongLookup | LibrarySingle | null | undefined) {
  return makeSongMatchKey(song?.artistName, getSongName(song))
}

function getAlbumName(album: AlbumLookup | LibraryAlbum | null | undefined) {
  if (!album) return ''
  const albumName = 'albumName' in album ? album.albumName : album.name
  return String(albumName || '').trim()
}

function getSongName(song: SongLookup | LibrarySingle | null | undefined) {
  if (!song) return ''
  const songName = 'songName' in song ? song.songName : song.name
  return String(songName || '').trim()
}
