import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Download, Clock3, Badge as BadgeIcon, Check } from 'lucide-react'

import {
  api,
  artworkSrcSet,
  artworkUrl,
  type AlbumDetail,
  type Job,
} from '../api/client'
import { useLibraryPresence } from '../hooks/useLibraryPresence'
import { useDownloadQualityPrompt } from '../hooks/useDownloadQualityPrompt'
import { useQueue } from '../hooks/useQueue'
import { useTouchMode } from '../hooks/useTouchMode'
import { ProgressBar } from '../components/ProgressBar'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { DownloadButton } from '../components/DownloadButton'
import { ResolvedMediaLink } from '../components/ResolvedMediaLink'
import { stripYear, formatPercent } from '../lib/format'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { VinylCover, vinylSpring } from '../components/VinylCover'
import { cx } from '../lib/cx'
import { motion } from 'framer-motion'

function formatDur(ms: number | undefined) {
  if (!ms || !Number.isFinite(ms)) return '—'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function AlbumPage() {
  const { id } = useParams<{ id: string }>()
  const [album, setAlbum] = useState<AlbumDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enqueueing, setEnqueueing] = useState(false)
  const [vinylHovered, setVinylHovered] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const {
    ready,
    isAlbumInLibrary,
    verifyAlbumPresence,
    verifyAlbumTracksPresence,
    getAlbumTrackPresence,
  } = useLibraryPresence()
  const { jobs } = useQueue()
  const touchMode = useTouchMode()
  const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt()

  const trackPresence = album ? getAlbumTrackPresence(album.id) : null
  const presentCount = trackPresence?.present ?? 0
  const expectedCount = trackPresence?.expected ?? album?.trackCount ?? album?.tracks?.length ?? 0
  const allPresent = trackPresence ? trackPresence.complete : false
  const partialState = trackPresence
    ? presentCount > 0 && presentCount < expectedCount
    : false
  const missingCount = Math.max(0, expectedCount - presentCount)

  const existingJob: Job | undefined = useMemo(
    () =>
      jobs.find(
        (j) =>
          j.albumId === id &&
          j.kind === 'album' &&
          (j.status === 'queued' || j.status === 'running'),
      ) || ((album && isAlbumInLibrary(album)) ? jobs.find((j) => j.albumId === id && j.kind === 'album' && j.status === 'done') : undefined),
    [jobs, id, album, isAlbumInLibrary],
  )

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!id) return
    api
      .album(id)
      .then((r) => {
        if (!cancelled) {
          setAlbum(r.album)
          verifyAlbumPresence(r.album, true)
          if (r.album?.tracks?.length) {
            verifyAlbumTracksPresence(
              {
                id: r.album.id,
                artistName: r.album.artistName,
                name: r.album.name,
                tracks: r.album.tracks.map((t) => ({ id: t.id, name: t.name, isrc: t.isrc })),
              },
              true,
            )
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load')
        }
      })
    return () => {
      cancelled = true
    }
  }, [id, verifyAlbumPresence, verifyAlbumTracksPresence])

  useEffect(() => {
    if (!album?.tracks?.length) return
    if (ready && !trackPresence) {
      verifyAlbumTracksPresence(
        {
          id: album.id,
          artistName: album.artistName,
          name: album.name,
          tracks: album.tracks.map((t) => ({ id: t.id, name: t.name, isrc: t.isrc })),
        },
        false,
      )
    }
  }, [album, ready, trackPresence, verifyAlbumTracksPresence])

  const onDownload = async () => {
    if (!album) return
    setEnqueueing(true)
    try {
      if (!ready && (await verifyAlbumPresence(album))) return
      const quality = await chooseDownloadQuality()
      if (quality === false) return
      await api.enqueue(album.id, quality)
    } catch (err: any) {
      if (/already in library/i.test(String(err?.message || ''))) {
        await verifyAlbumPresence(album)
        return
      }
      setError(err?.message || 'Enqueue failed')
    } finally {
      setEnqueueing(false)
    }
  }

  const coverBig = artworkUrl(album?.artworkTemplate, 600)
  const bgColor = album?.artworkColor ? `#${album.artworkColor}` : '#1a1a1a'
  const primaryArtistId = album?.artistId || album?.artists?.[0]?.id || null
  const alreadyInLibrary = allPresent || (!trackPresence && album ? isAlbumInLibrary(album) : false)
  const downloadButtonLabel = enqueueing
    ? 'Queueing…'
    : alreadyInLibrary
    ? 'Already in library'
    : existingJob?.status === 'done'
    ? 'Already imported'
    : existingJob?.status === 'queued'
    ? 'Queued'
    : existingJob?.status === 'running'
    ? 'Downloading…'
    : partialState && missingCount > 0
    ? `Fill missing tracks · ${missingCount}`
    : 'Download'

  return (
    <div className="mx-auto w-full max-w-6xl pt-4 md:pt-6">
      {error && <Badge variant="bad">{error}</Badge>}

      {album && (
        <StaggeredList
          className="rounded-app overflow-hidden relative"
          style={{
            background: `linear-gradient(180deg, ${bgColor}99, transparent 300px)`,
          }}
        >
          <StaggeredItem className="p-4 md:p-8 flex flex-col md:flex-row gap-6">
            <div className="shrink-0 mx-auto md:mx-0 w-[min(280px,70vw)]">
              <VinylCover
                coverSrc={coverBig}
                coverSrcSet={artworkSrcSet(album.artworkTemplate)}
                sizes="(max-width: 768px) 70vw, 280px"
                hovered={isMobile ? false : vinylHovered}
                onHoverChange={setVinylHovered}
              />
            </div>
            <motion.div 
              className="min-w-0 flex-1 flex flex-col"
              initial={false}
              animate={{ x: (isMobile ? false : vinylHovered) ? '140px' : 0 }}
              transition={vinylSpring}
            >
              <div className="text-xs uppercase tracking-wider text-white/55 mb-1">Album</div>
              <h1 className="text-2xl md:text-4xl font-bold tracking-tight">{stripYear(album.name)}</h1>
              <div className="mt-1 text-white/70">
                <ResolvedMediaLink
                  kind="artist"
                  artistId={primaryArtistId}
                  artistName={album.artistName}
                  className="hover:text-accent transition-colors"
                >
                  {album.artistName}
                </ResolvedMediaLink>
                {album.year ? ` · ${album.year}` : ''}
                {album.trackCount ? ` · ${album.trackCount} tracks` : ''}
              </div>
              {album.artists && album.artists.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-2 text-sm text-white/65">
                  {album.artists.map((a) => (
                    <Link key={a.id} to={`/artist/${a.id}`} className="hover:text-accent transition-colors">
                      {a.name || album.artistName}
                    </Link>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {album.hasHiRes && <Badge>Hi-Res Lossless</Badge>}
                {album.hasLossless && !album.hasHiRes && <Badge>Lossless</Badge>}
                {album.hasAtmos && <Badge>Dolby Atmos</Badge>}
                {album.contentRating === 'explicit' && <Badge>Explicit</Badge>}
                {album.contentRating === 'clean' && <Badge>Clean</Badge>}
                {album.genreNames.slice(0, 2).map((g) => (
                  <Badge key={g}>{g}</Badge>
                ))}
              </div>

              <div className="mt-4 md:mt-6 flex flex-col gap-3">
                {existingJob &&
                  (existingJob.status === 'queued' || existingJob.status === 'running') && (
                    <ProgressBar
                      value={existingJob.progress}
                      label={`${formatPercent(existingJob.progress)} · ${existingJob.message || existingJob.status}`}
                    />
                  )}
                <div className="flex gap-2 md:sticky md:top-20">
                  <Button
                    onClick={onDownload}
                    disabled={
                      enqueueing ||
                      alreadyInLibrary ||
                      (existingJob && existingJob.status !== 'failed')
                    }
                    className="flex-1 md:min-w-[200px] md:flex-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {alreadyInLibrary ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {downloadButtonLabel}
                  </Button>
                </div>
              </div>
            </motion.div>
          </StaggeredItem>

          <div className="px-4 md:px-8 pb-8">
            <div className="mt-2 border-t border-white/10 pt-4">
              <div className="grid grid-cols-[2rem_1fr_auto_2.25rem] md:grid-cols-[2rem_1fr_8rem_5rem_2.25rem] gap-x-3 gap-y-0 text-xs uppercase tracking-wider text-white/40 border-b border-white/5 py-2">
                <div>#</div>
                <div>Title</div>
                <div className="hidden md:block">Artist</div>
                <div className="text-right"><Clock3 className="h-3.5 w-3.5 inline" /></div>
                <div />
              </div>
              {album.tracks.map((t) => {
                const tArtistId = t.artistName === album.artistName 
                  ? primaryArtistId 
                  : album.artists?.find(a => a.name === t.artistName)?.id
                const trackDownloaded = Boolean(trackPresence?.tracks?.[t.id])
                const trackJob = trackDownloaded
                  ? null
                  : jobs.find(
                      (j) =>
                        (j.songId === t.id ||
                          (j.albumId === album.id && j.kind === 'album')) &&
                        (j.status === 'queued' || j.status === 'running'),
                    ) || null

                return (
                <StaggeredItem
                  key={t.id}
                  className="group/track grid grid-cols-[2rem_1fr_auto_2.25rem] md:grid-cols-[2rem_1fr_8rem_5rem_2.25rem] gap-x-3 py-2.5 items-center border-b border-white/5 hover:bg-accent/[0.05] transition-colors rounded-[6px]"
                >
                  <div className="text-white/45 tabular-nums text-sm">{t.trackNumber ?? '—'}</div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="md:hidden truncate text-xs text-white/50">
                      <ResolvedMediaLink
                        kind="artist"
                        artistId={tArtistId}
                        artistName={t.artistName}
                        className="hover:text-accent transition-colors"
                      >
                        {t.artistName}
                      </ResolvedMediaLink>
                    </div>
                  </div>
                  <div className="hidden md:block truncate text-sm text-white/60">
                    <ResolvedMediaLink
                      kind="artist"
                      artistId={tArtistId}
                      artistName={t.artistName}
                      className="hover:text-accent transition-colors"
                    >
                      {t.artistName}
                    </ResolvedMediaLink>
                  </div>
                  <div className="text-right text-sm text-white/55 tabular-nums">
                    {formatDur(t.durationMs)}
                    {t.hasHiRes && (
                      <BadgeIcon className="h-3.5 w-3.5 text-accent inline ml-1.5" aria-label="Hi-Res" />
                    )}
                  </div>
                  <div className="flex items-center justify-end">
                    <DownloadButton
                      job={trackJob}
                      size="sm"
                      blocked={trackDownloaded}
                      ariaLabel={`Download ${t.name}`}
                      onStart={async () => {
                        try {
                          const quality = await chooseDownloadQuality()
                          if (quality === false) return false
                          await api.enqueueSong(t.id, album.id, undefined, quality)
                          return true
                        } catch (err: any) {
                          if (/already in library/i.test(String(err?.message || ''))) {
                            await verifyAlbumTracksPresence(
                              {
                                id: album.id,
                                artistName: album.artistName,
                                name: album.name,
                                tracks: album.tracks.map((x) => ({ id: x.id, name: x.name, isrc: x.isrc })),
                              },
                              true,
                            )
                            return false
                          }
                          throw err
                        }
                      }}
                      className={cx(
                        trackDownloaded || trackJob || touchMode
                          ? 'opacity-100'
                          : 'opacity-0 group-hover/track:opacity-100 focus-within:opacity-100 transition-opacity duration-200',
                      )}
                    />
                  </div>
                </StaggeredItem>
                )
              })}
            </div>
            {album.recordLabel && (
              <div className="mt-4 text-xs text-white/40">
                {album.recordLabel}
                {album.copyright ? ` · ${album.copyright}` : ''}
              </div>
            )}
          </div>
        </StaggeredList>
      )}
      {qualityPrompt}
    </div>
  )
}
