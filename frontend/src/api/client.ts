export type Album = {
  id: string
  name: string
  artistName: string
  artistId?: string | null
  releaseDate?: string | null
  year?: string | null
  trackCount?: number
  isSingle?: boolean
  contentRating?: string
  artworkTemplate: string | null
  artworkColor?: string | null
  url?: string
}

export type Artist = {
  id: string
  name: string
  genreNames?: string[]
  url?: string
  artworkTemplate?: string | null
  artworkColor?: string | null
}

export type Song = {
  id: string
  name: string
  artistName: string
  artistId?: string | null
  albumName?: string
  albumId?: string | null
  durationMs?: number
  artworkTemplate: string | null
}

export type Playlist = {
  id: string
  name: string
  curatorName: string
  curatorId?: string | null
  trackCount?: number
  artworkTemplate: string | null
  artworkColor?: string | null
  url?: string
  description?: string
}

export type PlaylistTrack = {
  id: string
  name: string
  trackNumber?: number
  durationMs?: number
  artistName: string
  artistId?: string | null
  albumName?: string
  artworkTemplate?: string | null
  hasLossless?: boolean
  hasHiRes?: boolean
  hasAtmos?: boolean
}

export type PlaylistDetail = Playlist & {
  hasLossless: boolean
  hasHiRes: boolean
  hasAtmos: boolean
  lastModifiedDate?: string
  tracks: PlaylistTrack[]
}

export type LibraryPlaylistTrack = PlaylistTrack & {
  libraryId: string
  catalogId: string | null
  downloadable: boolean
}

export type LibraryPlaylistDetail = {
  libraryId: string
  catalogId: string | null
  name: string
  curatorName: string
  description: string
  artworkTemplate: string | null
  artworkColor: string | null
  isUserCreated: boolean
  trackCount: number
  tracks: LibraryPlaylistTrack[]
  hasLossless: boolean
  hasHiRes: boolean
  hasAtmos: boolean
  undownloadableCount: number
  downloadable: boolean
}

export type AlbumTrack = {
  id: string
  name: string
  trackNumber?: number
  discNumber?: number
  durationMs?: number
  artistName: string
  hasLossless?: boolean
  hasHiRes?: boolean
  hasAtmos?: boolean
}

export type AlbumDetail = Album & {
  genreNames: string[]
  artists?: Array<{ id: string; name?: string }>
  recordLabel?: string
  copyright?: string
  upc?: string
  hasLossless: boolean
  hasHiRes: boolean
  hasAtmos: boolean
  tracks: AlbumTrack[]
}

export type Job = {
  id: string
  kind: 'album' | 'song' | 'playlist'
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  albumId: string
  songId?: string | null
  playlistId?: string | null
  libraryPlaylistId?: string | null
  albumTitle: string
  artist: string
  artistId?: string | null
  artworkUrl?: string
  currentTrack?: string | null
  message?: string
  error?: string | null
  cancelled?: boolean
  createdAt: number
  updatedAt: number
  finalDir?: string
  stats?: { total?: number; done?: number; failed?: number; converted?: number }
}

export type QualityPreference = 'flac' | 'alac' | 'atmos' | 'aac'

export type ReleaseScope = 'albums' | 'singles_eps' | 'everything'

export type HealthReport = {
  ok: boolean
  wrapper: {
    host: string
    up?: boolean
    stallRecent?: boolean
    lastStallAt?: number | null
    lastStallAbortedAt?: number | null
    lastDownAt?: number | null
    decrypt: { ok: boolean; error: string | null }
    m3u8: { ok: boolean; error: string | null }
    account: { ok: boolean; error: string | null }
  }
  appleToken: { ok: boolean; error: string | null }
  music: { path: string; ok: boolean; error?: string }
}

export type PublicSettings = {
  storefront: string
  language: string
  quality: QualityPreference
  albumFolderFormat: string
  artistFolderFormat: string
  songFileFormat: string
  convertToFlac: boolean
  keepAlac: boolean
  coverSize: string
  downloadLyrics: boolean
  promptForDownloadQuality: boolean
  lyricsFormat: 'lrc' | 'ttml'
  lyricsType: 'lyrics' | 'lyrics-with-translation'
  explicitFilter: 'explicit' | 'clean' | 'both'
  appleEmailMasked: string | null
  hasAppleCreds: boolean
  hasMediaUserToken: boolean
  hardBlockReason?: string | null
  navidromeEnabled: boolean
  navidromeUrl: string
  navidromeUser: string | null
  hasNavidromeCreds: boolean
  autoDownloadsEnabled: boolean
  autoDownloadCheckFrequency: AutoCheckFrequency
  stagingInsideMusicLibrary: boolean
  namingConvention: 'apple' | 'qobuz'
}

export type AutoCheckFrequency =
  | 'auto'
  | '1h'
  | '6h'
  | '12h'
  | 'daily'
  | 'weekly'

export type EffectiveCheckInterval = {
  mode: AutoCheckFrequency
  followedCount: number
  ms: number | null
  label: string
}

export type FollowedArtist = Artist & {
  storefront: string
  knownReleaseIds: string[]
  latestReleaseDate: string | null
  lastCheckedAt: number
  followedAt: number
  updatedAt: number
  totalReleaseCount: number
  missingReleaseCount: number
  releaseScope: ReleaseScope
  fullyDownloaded: boolean
}

export type LibrarySingle = {
  id: string
  artistName: string
  artistId?: string | null
  songName: string
  relPath: string
  hasLyrics: boolean
  addedAt?: number
}

export type SearchOptions = {
  types?: string
  limit?: number
  offset?: number
}

export type LibraryAlbum = {
  id: string
  artistName: string
  artistId?: string | null
  albumName: string
  relPath: string
  trackCount: number
  lyricsCount: number
  hasLyrics: boolean
  addedAt?: number
}

export type LibraryPlaylist = {
  id: string
  relPath: string
  fileName: string
  playlistName: string
  catalogPlaylistId: string | null
  libraryPlaylistId: string | null
  trackCount: number
  addedAt?: number
}

export type CloudLibraryAlbum = {
  libraryId: string
  catalogId: string | null
  name: string
  artistName: string
  artworkTemplate: string | null
  artworkColor?: string | null
  trackCount: number
  dateAdded: string | null
  upc?: string | null
  downloadable: boolean
}

export type CloudLibraryPlaylist = {
  libraryId: string
  catalogId: string | null
  name: string
  curatorName: string
  description?: string
  artworkTemplate: string | null
  artworkColor?: string | null
  dateAdded: string | null
  isUserCreated: boolean
  downloadable: boolean
}

export type CloudLibrarySong = {
  libraryId: string
  catalogId: string | null
  catalogAlbumId: string | null
  name: string
  artistName: string
  albumName: string
  durationMs: number
  artworkTemplate: string | null
  contentRating: string | null
  isrc?: string | null
  downloadable: boolean
}

export type CloudLibraryKind = 'albums' | 'playlists' | 'songs'

export type CloudLibraryHealth = {
  available: boolean
  storefront?: string
  reason?: 'no-media-user-token' | 'token-rejected' | 'probe-failed'
  error?: string
}

export type CloudLibraryPage<T> = {
  items: T[]
  next: number | null
  total: number | null
}

export type CloudDownloadAllResult = {
  ok: true
  kind: CloudLibraryKind
  scanned: number
  queued: number
  skippedExisting: number
  skippedQueued: number
  unsupported: number
  errorCount: number
  errors: Array<{ libraryId: string; name: string; error: string }>
}

export type CloudDownloadAllProgress = {
  kind: CloudLibraryKind
  scanned: number
  queued: number
  skippedExisting?: number
  unsupported?: number
  total?: number | null
  done: boolean
}

type UnauthorizedHandler = (info: { needsSetup: boolean }) => void

let onUnauthorized: UnauthorizedHandler | null = null

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler
}

export class HttpError extends Error {
  status: number
  needsSetup: boolean
  retryAfter: number | null
  lockedUntil: number | null
  constructor(
    status: number,
    message: string,
    needsSetup = false,
    retryAfter: number | null = null,
    lockedUntil: number | null = null,
  ) {
    super(message)
    this.status = status
    this.needsSetup = needsSetup
    this.retryAfter = retryAfter
    this.lockedUntil = lockedUntil
  }
}

let setupToken: string | null = null

export function setSetupToken(token: string | null) {
  setupToken = token && token.trim() ? token.trim() : null
}

async function http<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    if (res.status === 401) {
      const needsSetup = Boolean(body?.needsSetup)
      // Don't trip the auth overlay for the auth endpoints themselves —
      // login/setup pages handle their own errors inline.
      if (!path.startsWith('/api/auth/') && onUnauthorized) {
        onUnauthorized({ needsSetup })
      }
      throw new HttpError(401, body?.error || 'unauthorized', needsSetup)
    }
    const msg = body?.error || `HTTP ${res.status}`
    throw new HttpError(
      res.status,
      msg,
      false,
      typeof body?.retryAfter === 'number' ? body.retryAfter : null,
      typeof body?.lockedUntil === 'number' ? body.lockedUntil : null,
    )
  }
  return body as T
}

export type AuthState = {
  authDisabled: boolean
  passwordSet: boolean
  authed: boolean
  username: string | null
  minPasswordLength: number
  usernameMinLength: number
  usernameMaxLength: number
  requiresSetupToken?: boolean
}

export type WrapperLoginStatus =
  | { inProgress: false }
  | {
      inProgress: true
      status: {
        phase: string
        error?: string
        tail?: string[]
      }
    }

export const api = {
  authState: () => http<AuthState>('/api/auth/state'),
  authSetup: (username: string, password: string) =>
    http<{ ok: boolean; username: string }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: setupToken ? { 'X-Setup-Token': setupToken } : undefined,
    }),
  authLogin: (username: string, password: string) =>
    http<{ ok: boolean; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  authLogout: () =>
    http<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  authChangePassword: (currentPassword: string, newPassword: string) =>
    http<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  authChangeUsername: (currentPassword: string, username: string) =>
    http<{ ok: boolean; username: string }>('/api/auth/change-username', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, username }),
    }),
  authRevokeAll: (currentPassword: string) =>
    http<{ ok: boolean }>('/api/auth/revoke-all', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),
  health: () => http<HealthReport>('/api/health'),
  settings: () => http<PublicSettings>('/api/settings'),
  saveSettings: (patch: Partial<PublicSettings>) =>
    http<PublicSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  saveAppleCreds: (email: string, password: string, autoLogin = true) =>
    http<{
      ok: boolean
      loginStarted?: boolean
      loginError?: string
    }>('/api/settings/apple-credentials', {
      method: 'POST',
      body: JSON.stringify({ email, password, autoLogin }),
    }),
  runAppleLogin: () =>
    http<{ ok: boolean; loginStarted?: boolean }>(
      '/api/settings/apple-credentials/login',
      { method: 'POST' },
    ),
  appleLoginStatus: () =>
    http<WrapperLoginStatus>('/api/settings/apple-credentials/login-status'),
  submitAppleTwoFa: (code: string) =>
    http<{ ok: boolean }>('/api/settings/apple-credentials/2fa', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  cancelAppleLogin: () =>
    http<{ ok: boolean }>(
      '/api/settings/apple-credentials/cancel-login',
      { method: 'POST' },
    ),
  clearAppleCreds: () =>
    http<{ ok: boolean }>('/api/settings/apple-credentials', {
      method: 'DELETE',
    }),
  saveMediaUserToken: (token: string) =>
    http<{ ok: boolean }>('/api/settings/media-user-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  clearMediaUserToken: () =>
    http<{ ok: boolean }>('/api/settings/media-user-token', {
      method: 'DELETE',
    }),
  search: (q: string, options: SearchOptions = {}) => {
    const params = new URLSearchParams({ q })
    if (options.types) params.set('types', options.types)
    if (typeof options.limit === 'number') params.set('limit', String(options.limit))
    if (typeof options.offset === 'number') params.set('offset', String(options.offset))
    return http<{
      albums: Album[]
      artists: Artist[]
      songs: Song[]
      playlists: Playlist[]
      storefront: string
      redirect?: string
    }>(`/api/search?${params.toString()}`)
  },
  album: (id: string) =>
    http<{ album: AlbumDetail; storefront: string }>(
      `/api/album/${encodeURIComponent(id)}`,
    ),
  artist: (id: string) =>
    http<{
      artist: Artist
      albums: Album[]
      storefront: string
    }>(`/api/artist/${encodeURIComponent(id)}`),
  playlist: (id: string) =>
    http<{ playlist: PlaylistDetail; storefront: string }>(
      `/api/playlist/${encodeURIComponent(id)}`,
    ),
  libraryPlaylist: (libraryId: string) =>
    http<{ playlist: LibraryPlaylistDetail; storefront: string }>(
      `/api/playlist/library/${encodeURIComponent(libraryId)}`,
    ),
  following: () => http<{ artists: FollowedArtist[] }>('/api/following'),
  followedArtist: (id: string) =>
    http<{ artist: FollowedArtist | null }>(
      `/api/following/${encodeURIComponent(id)}`,
    ),
  followArtist: (
    id: string,
    downloadNow: boolean,
    quality?: QualityPreference,
    releaseScope?: ReleaseScope,
  ) =>
    http<{
      artist: FollowedArtist | null
      queued: Job[]
      failed?: Array<{ albumId: string; albumTitle?: string; error: string }>
    }>(
      `/api/following/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ downloadNow, quality, releaseScope }),
      },
    ),
  updateFollowedArtist: (id: string, patch: { releaseScope?: ReleaseScope }) =>
    http<{ artist: FollowedArtist | null }>(
      `/api/following/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    ),
  unfollowArtist: (id: string) =>
    http<{ ok: boolean; existed: boolean }>(
      `/api/following/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  runFollowingCheck: () =>
    http<{ ok: boolean; artists?: number; queued?: number; discovered?: number }>(
      '/api/following/check/run',
      { method: 'POST' },
    ),
  downloadMissingReleases: (quality?: QualityPreference) =>
    http<{ ok: boolean; queued: number }>('/api/following/download-missing', {
      method: 'POST',
      body: JSON.stringify({ quality }),
    }),
  downloadArtistMissingReleases: (id: string, quality?: QualityPreference) =>
    http<{ ok: boolean; queued: number }>(`/api/following/${encodeURIComponent(id)}/download-missing`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    }),
  effectiveCheckInterval: (mode?: AutoCheckFrequency) =>
    http<EffectiveCheckInterval>(
      `/api/following/check/effective-interval${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`,
    ),
  queue: () => http<{ jobs: Job[] }>('/api/queue'),
  library: () =>
    http<{
      albums: LibraryAlbum[]
      singles: LibrarySingle[]
      playlists: LibraryPlaylist[]
      songKeys?: string[]
      playlistIds?: string[]
      totals: { albums: number; singles: number; playlists?: number }
    }>('/api/library'),
  libraryPresence: (payload: {
    albums?: Array<{ id: string; artistName: string; albumName: string }>
    songs?: Array<{ id: string; artistName: string; songName: string }>
    playlists?: Array<{ id: string }>
    albumTracks?: Array<{
      id: string
      artistName: string
      albumName: string
      tracks: Array<{ id: string; name: string }>
    }>
  }) =>
    http<{
      albums: Record<string, boolean>
      songs: Record<string, boolean>
      playlists: Record<string, boolean>
      albumTracks: Record<
        string,
        {
          present: number
          expected: number
          complete: boolean
          folderExists: boolean
          tracks: Record<string, boolean>
        }
      >
    }>('/api/library/presence', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteLibrarySong: (relPath: string) =>
    http<{ ok: boolean; removedLyrics?: boolean }>('/api/library/song', {
      method: 'DELETE',
      body: JSON.stringify({ relPath }),
    }),
  deleteLibraryAlbum: (relPath: string) =>
    http<{ ok: boolean }>('/api/library/album', {
      method: 'DELETE',
      body: JSON.stringify({ relPath }),
    }),
  deleteLibraryPlaylist: (relPath: string) =>
    http<{ ok: boolean }>('/api/library/playlist', {
      method: 'DELETE',
      body: JSON.stringify({ relPath }),
    }),
  enqueue: (albumId: string, quality?: QualityPreference) =>
    http<{ job: Job }>('/api/download', {
      method: 'POST',
      body: JSON.stringify({ albumId, quality }),
    }),
  enqueueSong: (songId: string, albumId?: string | null, storefront?: string, quality?: QualityPreference) =>
    http<{ job: Job }>('/api/download/song', {
      method: 'POST',
      body: JSON.stringify({ songId, albumId: albumId || null, storefront, quality }),
    }),
  enqueuePlaylist: (playlistId: string, storefront?: string, quality?: QualityPreference) =>
    http<{ job: Job }>('/api/download/playlist', {
      method: 'POST',
      body: JSON.stringify({ playlistId, storefront, quality }),
    }),
  enqueueLibraryPlaylist: (libraryId: string, storefront?: string, quality?: QualityPreference) =>
    http<{ job: Job }>('/api/download/playlist', {
      method: 'POST',
      body: JSON.stringify({ libraryId, storefront, quality }),
    }),
  cancel: (id: string) =>
    http<{ ok: boolean }>(`/api/download/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  cancelAll: () =>
    http<{ ok: boolean; cancelled: number }>('/api/download/cancel-all', {
      method: 'POST',
    }),
  cloudLibraryHealth: () =>
    http<CloudLibraryHealth>('/api/cloud-library/health'),
  cloudLibraryAlbums: (offset = 0, limit = 100) =>
    http<CloudLibraryPage<CloudLibraryAlbum>>(
      `/api/cloud-library/albums?offset=${offset}&limit=${limit}`,
    ),
  cloudLibraryPlaylists: (offset = 0, limit = 100) =>
    http<CloudLibraryPage<CloudLibraryPlaylist>>(
      `/api/cloud-library/playlists?offset=${offset}&limit=${limit}`,
    ),
  cloudLibrarySongs: (offset = 0, limit = 100) =>
    http<CloudLibraryPage<CloudLibrarySong>>(
      `/api/cloud-library/songs?offset=${offset}&limit=${limit}`,
    ),
  cloudLibraryDownloadAll: (kind: CloudLibraryKind, quality?: QualityPreference) =>
    http<CloudDownloadAllResult>('/api/cloud-library/download-all', {
      method: 'POST',
      body: JSON.stringify({ kind, quality }),
    }),
}

export function artworkUrl(
  template: string | null | undefined,
  size = 600,
): string | null {
  if (!template) return null
  return template
    .replace('{w}', String(size))
    .replace('{h}', String(size))
    .replace('{f}', 'jpg')
}

export function artworkSrcSet(template: string | null | undefined): string {
  if (!template) return ''
  const base = template.replace('{f}', 'jpg')
  return [300, 600, 1200]
    .map((s) =>
      `${base.replace('{w}', String(s)).replace('{h}', String(s))} ${s}w`,
    )
    .join(', ')
}
