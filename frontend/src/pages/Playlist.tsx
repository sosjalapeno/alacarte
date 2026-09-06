import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Clock3, Badge as BadgeIcon, Download, ListMusic, ListPlus, ListX, X } from 'lucide-react'

import {
  api,
  artworkSrcSet,
  artworkUrl,
  type FollowedPlaylist,
  type LibraryPlaylistDetail,
  type PlaylistDetail,
  type QualityPreference,
} from '../api/client'
import { useDownloadQualityPrompt } from '../hooks/useDownloadQualityPrompt'
import { useQueue } from '../hooks/useQueue'
import { useActivityFeed } from '../hooks/useActivityFeed'
import { useAppSettings } from '../hooks/useAppSettings'
import { Badge } from '../components/Badge'
import { ResolvedMediaLink } from '../components/ResolvedMediaLink'
import { formatPercent } from '../lib/format'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { ProgressBar } from '../components/ProgressBar'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { QualityPicker } from '../components/QualityPicker'

type AnyPlaylist =
  | (PlaylistDetail & { libraryId?: undefined; isUserCreated?: undefined; undownloadableCount?: undefined })
  | (LibraryPlaylistDetail & { url?: undefined; lastModifiedDate?: undefined })

function formatDur(ms: number | undefined) {
  if (!ms || !Number.isFinite(ms)) return '—'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function PlaylistPage() {
  const params = useParams<{ id?: string; libraryId?: string }>()
  const libraryId = params.libraryId || null
  const catalogId = libraryId ? null : params.id || null
  const [playlist, setPlaylist] = useState<AnyPlaylist | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enqueueing, setEnqueueing] = useState(false)
  const [followed, setFollowed] = useState<FollowedPlaylist | null>(null)
  const [followModalOpen, setFollowModalOpen] = useState(false)
  const [unfollowModalOpen, setUnfollowModalOpen] = useState(false)
  const [followSubmitting, setFollowSubmitting] = useState(false)
  const [followQueuedCount, setFollowQueuedCount] = useState(0)
  const [followBanner, setFollowBanner] = useState<null | 'followed' | 'unfollowed'>(null)
  const [followQuality, setFollowQuality] = useState<QualityPreference>('flac')
  const { jobs } = useQueue()
  const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt()
  const { playlistFollowingState } = useActivityFeed()
  const appSettings = useAppSettings()
  const bannerTimersRef = useRef<number[]>([])
  const pageId = libraryId || catalogId

  const clearBannerTimers = () => {
    for (const t of bannerTimersRef.current) window.clearTimeout(t)
    bannerTimersRef.current = []
  }
  useEffect(() => clearBannerTimers, [])

  useEffect(() => {
    if (!pageId) return
    let cancelled = false
    api
      .followedPlaylist(pageId)
      .then((r) => {
        if (!cancelled) setFollowed(r.playlist)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pageId, playlist])

  const livePlaylistState = followed
    ? playlistFollowingState[followed.id]
    : pageId
      ? playlistFollowingState[pageId]
      : undefined
  useEffect(() => {
    if (livePlaylistState?.unfollowed) setFollowed(null)
  }, [livePlaylistState?.unfollowed])

  const existingPlaylistJob = useMemo(
    () =>
      jobs.find(
        (j) =>
          j.kind === 'playlist' &&
          ((libraryId && j.libraryPlaylistId === libraryId) ||
            (catalogId && j.playlistId === catalogId)) &&
          (j.status === 'queued' || j.status === 'running'),
      ) ||
      jobs.find(
        (j) =>
          j.kind === 'playlist' &&
          ((libraryId && j.libraryPlaylistId === libraryId) ||
            (catalogId && j.playlistId === catalogId)) &&
          j.status === 'done',
      ),
    [jobs, catalogId, libraryId],
  )

  useEffect(() => {
    let cancelled = false
    if (!libraryId && !catalogId) return
    const loader = libraryId ? api.libraryPlaylist(libraryId) : api.playlist(catalogId!)
    loader
      .then((r) => {
        if (!cancelled) setPlaylist(r.playlist as AnyPlaylist)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [catalogId, libraryId])

  const coverBig = artworkUrl(playlist?.artworkTemplate, 600)
  const bgColor = playlist?.artworkColor ? `#${playlist.artworkColor}` : '#1a1a1a'

  const activePlaylistTrackJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.kind === 'song' &&
          playlist?.tracks.some((t) => t.id === j.songId) &&
          (j.status === 'queued' || j.status === 'running'),
      ),
    [jobs, playlist],
  )

  const onDownload = async () => {
    if (!playlist) return
    setEnqueueing(true)
    try {
      const quality = await chooseDownloadQuality()
      if (quality === false) return
      if (libraryId) {
        await api.enqueueLibraryPlaylist(libraryId, undefined, quality)
      } else if (catalogId) {
        await api.enqueuePlaylist(catalogId, undefined, quality)
      }
    } catch (err: any) {
      setError(err?.message || 'Enqueue failed')
    } finally {
      setEnqueueing(false)
    }
  }

  const isLibraryMode = Boolean(libraryId)

  const openFollowModal = () => {
    setFollowQuality(appSettings?.quality || 'flac')
    setFollowModalOpen(true)
  }

  const submitFollow = async (downloadNow: boolean) => {
    if (!pageId) return
    setFollowSubmitting(true)
    try {
      const quality = appSettings?.promptForDownloadQuality
        ? followQuality
        : undefined
      const result = libraryId
        ? await api.followLibraryPlaylist(libraryId, downloadNow, quality)
        : await api.followCatalogPlaylist(catalogId!, downloadNow, quality)
      setFollowed(result.playlist)
      setFollowModalOpen(false)
      setFollowBanner('followed')
      if (downloadNow) {
        setFollowQueuedCount(result.queued)
      }
      clearBannerTimers()
      bannerTimersRef.current = [
        window.setTimeout(() => setFollowBanner(null), 6000),
        window.setTimeout(() => setFollowQueuedCount(0), 6000),
      ]
    } catch (err: any) {
      setError(err?.message || 'Failed to follow playlist')
    } finally {
      setFollowSubmitting(false)
    }
  }

  const submitUnfollow = async () => {
    if (!followed) return
    setFollowSubmitting(true)
    try {
      await api.unfollowPlaylist(followed.id)
      setFollowed(null)
      setUnfollowModalOpen(false)
      setFollowBanner('unfollowed')
      setFollowQueuedCount(0)
      clearBannerTimers()
      bannerTimersRef.current = [
        window.setTimeout(() => setFollowBanner(null), 6000),
      ]
    } catch (err: any) {
      setError(err?.message || 'Failed to unfollow playlist')
    } finally {
      setFollowSubmitting(false)
    }
  }

  const undownloadable = isLibraryMode
    ? (playlist as LibraryPlaylistDetail | null)?.undownloadableCount || 0
    : 0
  const isUserCreated = isLibraryMode
    ? Boolean((playlist as LibraryPlaylistDetail | null)?.isUserCreated)
    : false
  const downloadable = isLibraryMode
    ? Boolean((playlist as LibraryPlaylistDetail | null)?.downloadable)
    : true

  return (
    <div className="mx-auto w-full max-w-6xl pt-4 md:pt-6">
      {error && <Badge variant="bad">{error}</Badge>}

      <AnimatePresence>
        {(followBanner || followQueuedCount > 0) && (
          <motion.div
            key="follow-banner"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            className="mb-4 flex items-center justify-between gap-3 rounded-app border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.10)] px-4 py-2.5 text-sm text-white/90 backdrop-blur-[10px]"
          >
            <div>
              {followBanner === 'unfollowed'
                ? 'Playlist unfollowed. Your existing downloads stay in the library.'
                : 'Playlist followed. New tracks will download automatically.'}{' '}
              {followQueuedCount > 0 && (
                <>
                  Queued <b>{followQueuedCount}</b> track
                  {followQueuedCount === 1 ? '' : 's'} for download.{' '}
                </>
              )}
              {followBanner !== 'unfollowed' && (
                <Link
                  to="/following"
                  className="font-medium text-[rgb(var(--accent))] underline underline-offset-2 transition-colors hover:text-white"
                >
                  Open Following
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setFollowBanner(null)
                setFollowQueuedCount(0)
              }}
              aria-label="Dismiss"
              className="shrink-0 inline-flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] text-white/75 transition-[background,border-color,color] duration-[250ms] ease-smooth hover:border-[rgba(var(--accent),0.45)] hover:bg-[rgba(var(--accent),0.18)] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {playlist && (
        <StaggeredList
          className="rounded-app overflow-hidden relative"
          style={{
            background: `linear-gradient(180deg, ${bgColor}99, transparent 300px)`,
          }}
        >
          <StaggeredItem className="p-4 md:p-8 flex flex-col md:flex-row gap-6">
            <div className="shrink-0 mx-auto md:mx-0 w-[min(280px,70vw)]">
              <div className="w-full aspect-square rounded-app overflow-hidden bg-black/50 shadow-2xl">
                {coverBig ? (
                  <img
                    src={coverBig}
                    srcSet={artworkSrcSet(playlist.artworkTemplate)}
                    sizes="(max-width: 768px) 70vw, 280px"
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-white/20 text-5xl">
                    ♫
                  </div>
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1 flex flex-col">
              <div className="text-xs uppercase tracking-wider text-white/55 mb-1">
                {isUserCreated ? 'Your Playlist' : 'Playlist'}
              </div>
              <h1 className="text-2xl md:text-4xl font-bold tracking-tight">{playlist.name}</h1>
              <div className="mt-1 text-white/70">
                {playlist.curatorName}
                {playlist.trackCount ? ` · ${playlist.trackCount} tracks` : ''}
              </div>
              {playlist.description && (
                <p className="mt-2 text-sm text-white/50 line-clamp-3">{playlist.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {playlist.hasHiRes && <Badge>Hi-Res Lossless</Badge>}
                {playlist.hasLossless && !playlist.hasHiRes && <Badge>Lossless</Badge>}
                {playlist.hasAtmos && <Badge>Dolby Atmos</Badge>}
                {undownloadable > 0 && (
                  <Badge variant="warn">
                    {undownloadable} not on Apple Music
                  </Badge>
                )}
              </div>
              {(existingPlaylistJob?.status === 'queued' ||
                existingPlaylistJob?.status === 'running') && (
                <div className="mt-4">
                  <ProgressBar
                    value={existingPlaylistJob.progress}
                    label={`${formatPercent(existingPlaylistJob.progress)} · ${existingPlaylistJob.message || existingPlaylistJob.status}`}
                  />
                </div>
              )}
              <div className="mt-4 md:mt-6 flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 md:sticky md:top-20">
                  <Button
                    onClick={onDownload}
                    disabled={
                      enqueueing ||
                      !downloadable ||
                      (existingPlaylistJob && existingPlaylistJob.status !== 'failed')
                    }
                    className="flex-1 md:min-w-[200px] md:flex-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" />
                    {existingPlaylistJob?.status === 'done'
                      ? 'Already imported'
                      : existingPlaylistJob?.status === 'queued'
                        ? 'Queued'
                        : existingPlaylistJob?.status === 'running'
                          ? 'Downloading…'
                          : !downloadable
                            ? 'No downloadable tracks'
                            : 'Download Playlist'}
                  </Button>
                  {followed ? (
                    <Button
                      onClick={() => setUnfollowModalOpen(true)}
                      disabled={followSubmitting}
                      variant="ghost"
                      className="border-rose-300/30 bg-rose-500/10 text-rose-200 hover:border-rose-300/50 hover:bg-rose-500/20 hover:text-rose-100"
                    >
                      <ListX className="h-4 w-4" />
                      Unfollow
                    </Button>
                  ) : (
                    <Button
                      onClick={openFollowModal}
                      disabled={followSubmitting}
                      variant="ghost"
                    >
                      <ListPlus className="h-4 w-4" />
                      Follow
                    </Button>
                  )}
                </div>
              </div>

              {activePlaylistTrackJobs.length > 0 && (
                <div className="mt-4 text-sm text-white/50">
                  {activePlaylistTrackJobs.length} track{activePlaylistTrackJobs.length !== 1 ? 's' : ''} downloading…
                </div>
              )}
            </div>
          </StaggeredItem>

          <div className="px-4 md:px-8 pb-8">
            <div className="mt-2 border-t border-white/10 pt-4">
              <div className="grid grid-cols-[2rem_1fr_auto] md:grid-cols-[2rem_1fr_8rem_5rem] gap-x-3 gap-y-0 text-xs uppercase tracking-wider text-white/40 border-b border-white/5 py-2">
                <div>#</div>
                <div>Title</div>
                <div className="hidden md:block">Artist</div>
                <div className="text-right"><Clock3 className="h-3.5 w-3.5 inline" /></div>
              </div>
              {playlist.tracks.map((t, i) => {
                const matchingJob = jobs.find(
                  (j) => j.songId === t.id && (j.status === 'queued' || j.status === 'running'),
                )
                return (
                  <StaggeredItem
                    key={t.id}
                    className="grid grid-cols-[2rem_1fr_auto] md:grid-cols-[2rem_1fr_8rem_5rem] gap-x-3 py-2.5 items-center border-b border-white/5 hover:bg-accent/[0.05] transition-colors rounded-[6px]"
                  >
                    <div className="text-white/45 tabular-nums text-sm">{i + 1}</div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {t.name}
                        {t.hasHiRes && (
                          <BadgeIcon className="h-3.5 w-3.5 text-accent inline ml-1.5" aria-label="Hi-Res" />
                        )}
                      </div>
                      <div className="md:hidden truncate text-xs text-white/50">
                        <ResolvedMediaLink
                          kind="artist"
                          artistId={t.artistId}
                          artistName={t.artistName}
                          className="hover:text-accent transition-colors"
                        >
                          {t.artistName}
                        </ResolvedMediaLink>
                        {t.albumName && ` · ${t.albumName}`}
                      </div>
                    </div>
                    <div className="hidden md:block truncate text-sm text-white/60">
                      <ResolvedMediaLink
                        kind="artist"
                        artistId={t.artistId}
                        artistName={t.artistName}
                        className="hover:text-accent transition-colors"
                      >
                        {t.artistName}
                      </ResolvedMediaLink>
                    </div>
                    <div className="text-right text-sm text-white/55 tabular-nums flex items-center justify-end gap-1.5">
                      {matchingJob && (
                        <span className="text-[10px] text-accent font-semibold uppercase tracking-wide">
                          {matchingJob.status === 'running'
                            ? `${formatPercent(matchingJob.progress)}`
                            : 'Queued'}
                        </span>
                      )}
                      {formatDur(t.durationMs)}
                    </div>
                  </StaggeredItem>
                )
              })}
            </div>
          </div>
        </StaggeredList>
      )}
      {qualityPrompt}
      <Modal
        open={followModalOpen}
        onClose={() => setFollowModalOpen(false)}
        label="Follow playlist"
        placement="center"
        className="!max-w-[40rem]"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]">
              <ListMusic className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-white/55">
                Follow playlist
              </div>
              <h2 className="mt-1 text-lg font-semibold text-white">
                {playlist?.name || 'Playlist'}
              </h2>
              <p className="mt-2 text-sm text-white/60">
                ALACarte will watch this playlist and automatically download
                tracks you add to it. Removing a track from the playlist keeps
                its download in your library.
              </p>
            </div>
          </div>
          {appSettings?.promptForDownloadQuality && (
            <div className="mt-5">
              <div className="mb-3">
                <div className="text-xs uppercase tracking-wider text-white/55">
                  Download quality
                </div>
                <div className="mt-1 text-sm text-white/60">
                  Applies if you download the existing tracks now.
                </div>
              </div>
              <QualityPicker value={followQuality} onChange={setFollowQuality} />
            </div>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => setFollowModalOpen(false)}
              disabled={followSubmitting}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              onClick={() => submitFollow(false)}
              disabled={followSubmitting}
            >
              Future additions only
            </Button>
            <Button
              onClick={() => submitFollow(true)}
              disabled={followSubmitting}
            >
              Download existing tracks
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={unfollowModalOpen}
        onClose={() => setUnfollowModalOpen(false)}
        label="Unfollow playlist"
        placement="center"
        className="!max-w-[36rem]"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rose-300/30 bg-rose-500/10 text-rose-200">
              <ListX className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-white/55">
                Unfollow playlist
              </div>
              <h2 className="mt-1 text-lg font-semibold text-white">
                {playlist?.name || 'Playlist'}
              </h2>
              <p className="mt-2 text-sm text-white/60">
                Stop watching for new tracks? Your existing downloads stay in
                the library.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => setUnfollowModalOpen(false)}
              disabled={followSubmitting}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              onClick={submitUnfollow}
              disabled={followSubmitting}
              className="border-rose-300/30 bg-rose-500/10 text-rose-200 hover:border-rose-300/50 hover:bg-rose-500/20 hover:text-rose-100"
            >
              <ListX className="h-4 w-4" />
              Unfollow
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
