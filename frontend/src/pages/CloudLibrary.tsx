import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Cloud,
  CloudDownload,
  Disc3,
  Download,
  ListMusic,
  Loader2,
  Music2,
  RefreshCw,
  X,
} from 'lucide-react'

import {
  api,
  artworkUrl,
  type Album,
  type CloudLibraryAlbum,
  type CloudLibraryHealth,
  type CloudLibraryKind,
  type CloudLibraryPlaylist,
  type CloudLibrarySong,
  type Playlist,
  type QualityPreference,
  type Song,
} from '../api/client'
import { AlbumCard } from '../components/AlbumCard'
import { PlaylistCard } from '../components/PlaylistCard'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { DownloadButton } from '../components/DownloadButton'
import { Modal } from '../components/Modal'
import { QualityPicker } from '../components/QualityPicker'
import { StaggeredItem, StaggeredList } from '../components/StaggeredList'
import { useAppSettings } from '../hooks/useAppSettings'
import { useDownloadQualityPrompt } from '../hooks/useDownloadQualityPrompt'
import { useEventStream } from '../hooks/useEventStream'
import { useLibraryPresence } from '../hooks/useLibraryPresence'
import { useQueue } from '../hooks/useQueue'
import { cx } from '../lib/cx'

type TabKey = CloudLibraryKind
type AnyItem = CloudLibraryAlbum | CloudLibraryPlaylist | CloudLibrarySong

type TabState<T> = {
  items: T[]
  total: number | null
  next: number | null
  loading: boolean
  loadingMore: boolean
  error: string | null
}

type AllTabs = {
  albums: TabState<CloudLibraryAlbum>
  playlists: TabState<CloudLibraryPlaylist>
  songs: TabState<CloudLibrarySong>
}

const PAGE_SIZE = 100
const TAB_KEYS: readonly TabKey[] = ['albums', 'playlists', 'songs']

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value)
}

function emptyTab<T>(): TabState<T> {
  return {
    items: [],
    total: null,
    next: 0,
    loading: false,
    loadingMore: false,
    error: null,
  }
}

const fetchers = {
  albums: api.cloudLibraryAlbums,
  playlists: api.cloudLibraryPlaylists,
  songs: api.cloudLibrarySongs,
}

export function CloudLibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: TabKey = isTabKey(tabParam) ? tabParam : 'albums'
  const setActiveTab = useCallback(
    (tab: TabKey) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (tab === 'albums') next.delete('tab')
          else next.set('tab', tab)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const [health, setHealth] = useState<CloudLibraryHealth | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [tabs, setTabs] = useState<AllTabs>({
    albums: emptyTab<CloudLibraryAlbum>(),
    playlists: emptyTab<CloudLibraryPlaylist>(),
    songs: emptyTab<CloudLibrarySong>(),
  })
  const [confirmKind, setConfirmKind] = useState<TabKey | null>(null)
  const [bulkRunning, setBulkRunning] = useState<TabKey | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{
    kind: TabKey
    scanned: number
    queued: number
  } | null>(null)
  const [bulkBanner, setBulkBanner] = useState<{
    kind: TabKey
    queued: number
    skippedExisting: number
    unsupported: number
  } | null>(null)
  const appSettings = useAppSettings()
  const [bulkQuality, setBulkQuality] = useState<QualityPreference>('flac')

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const inFlightRef = useRef<Record<TabKey, Set<number>>>({
    albums: new Set(),
    playlists: new Set(),
    songs: new Set(),
  })

  const checkHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const h = await api.cloudLibraryHealth()
      setHealth(h)
    } catch (err: any) {
      setHealth({ available: false, reason: 'probe-failed', error: err?.message })
    } finally {
      setHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    checkHealth()
  }, [checkHealth])

  const loadPage = useCallback(
    async (kind: TabKey, mode: 'reset' | 'append') => {
      const fetcher = fetchers[kind] as (
        offset?: number,
        limit?: number,
      ) => Promise<{ items: AnyItem[]; next: number | null; total: number | null }>
      const offset = mode === 'reset' ? 0 : tabs[kind].next ?? 0
      const inflight = inFlightRef.current[kind]
      if (inflight.has(offset)) return
      inflight.add(offset)
      setTabs((prev) => ({
        ...prev,
        [kind]: {
          ...prev[kind],
          loading: mode === 'reset',
          loadingMore: mode === 'append',
          error: null,
        },
      }))
      try {
        const page = await fetcher(offset, PAGE_SIZE)
        setTabs((prev) => {
          const current = prev[kind]
          const merged =
            mode === 'reset' ? page.items : [...current.items, ...page.items]
          return {
            ...prev,
            [kind]: {
              items: merged as never,
              total: page.total,
              next: page.next,
              loading: false,
              loadingMore: false,
              error: null,
            },
          }
        })
      } catch (err: any) {
        setTabs((prev) => ({
          ...prev,
          [kind]: {
            ...prev[kind],
            loading: false,
            loadingMore: false,
            error: err?.message || 'Failed to load',
          },
        }))
      } finally {
        inflight.delete(offset)
      }
    },
    [tabs],
  )

  useEffect(() => {
    if (!health?.available) return
    const tab = tabs[activeTab]
    if (tab.items.length === 0 && !tab.loading && !tab.error) {
      loadPage(activeTab, 'reset')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, health?.available])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const tab = tabs[activeTab]
    if (tab.next === null || tab.loading || tab.loadingMore) return
    const obs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e?.isIntersecting) {
        loadPage(activeTab, 'append')
      }
    }, { rootMargin: '300px' })
    obs.observe(node)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tabs[activeTab].next, tabs[activeTab].loading, tabs[activeTab].loadingMore])

  useEventStream((type, data) => {
    if (type !== 'cloud-library.download-all.progress') return
    const payload = data as {
      kind: TabKey
      scanned: number
      queued: number
      done: boolean
    }
    if (payload.done) {
      setBulkProgress(null)
      return
    }
    setBulkProgress({
      kind: payload.kind,
      scanned: payload.scanned,
      queued: payload.queued,
    })
  })

  const refresh = () => loadPage(activeTab, 'reset')

  useEffect(() => {
    if (confirmKind && appSettings?.quality) setBulkQuality(appSettings.quality)
  }, [confirmKind, appSettings?.quality])

  const startDownloadAll = async () => {
    if (!confirmKind) return
    const kind = confirmKind
    const quality = appSettings?.promptForDownloadQuality ? bulkQuality : undefined
    setConfirmKind(null)
    setBulkRunning(kind)
    setBulkBanner(null)
    try {
      const res = await api.cloudLibraryDownloadAll(kind, quality)
      setBulkBanner({
        kind,
        queued: res.queued,
        skippedExisting: res.skippedExisting,
        unsupported: res.unsupported,
      })
    } catch (err: any) {
      setTabs((prev) => ({
        ...prev,
        [kind]: { ...prev[kind], error: err?.message || 'Bulk download failed' },
      }))
    } finally {
      setBulkRunning(null)
      setBulkProgress(null)
    }
  }

  if (healthLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl pt-6">
        <Card className="p-6 text-sm text-white/55">Checking Apple Music access…</Card>
      </div>
    )
  }

  if (!health?.available) {
    return <NotConnectedScreen reason={health?.reason} error={health?.error} onRetry={checkHealth} />
  }

  const activeState = tabs[activeTab]
  const hasItems = activeState.items.length > 0
  const neverFetched =
    activeState.total === null && activeState.items.length === 0 && !activeState.error
  const showSkeleton = (activeState.loading || neverFetched) && !hasItems
  const totalLabel = activeState.total !== null ? activeState.total : activeState.items.length

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 pt-4 md:pt-6">
      <AnimatePresence>
        {bulkBanner && (
          <motion.div
            key="bulk-banner"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            className="flex items-center justify-between gap-3 rounded-app border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.10)] px-4 py-2.5 text-sm text-white/90 backdrop-blur-[10px]"
          >
            <div>
              Queued <b>{bulkBanner.queued}</b> {bulkBanner.kind}.
              {bulkBanner.skippedExisting > 0 && (
                <span className="text-white/60"> · {bulkBanner.skippedExisting} already in library</span>
              )}
              {bulkBanner.unsupported > 0 && (
                <span className="text-white/60"> · {bulkBanner.unsupported} not downloadable</span>
              )}{' '}
              <Link
                to="/"
                className="font-medium text-[rgb(var(--accent))] underline underline-offset-2 transition-colors hover:text-white"
              >
                Open activity
              </Link>
            </div>
            <button
              type="button"
              onClick={() => setBulkBanner(null)}
              aria-label="Dismiss"
              className="shrink-0 inline-flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] text-white/75 transition-[background,border-color,color] duration-[250ms] ease-smooth hover:border-[rgba(var(--accent),0.45)] hover:bg-[rgba(var(--accent),0.18)] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Cloud
          </h1>
          <p className="max-w-2xl text-sm text-white/60 md:text-base">
            Everything saved in your Apple Music library — download what you want, or grab the lot in one go.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-start gap-2 md:w-auto md:justify-end">
          <Button onClick={refresh} disabled={activeState.loading} className="whitespace-nowrap">
            <RefreshCw className={activeState.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
          {hasItems && (
            <Button
              disabled={Boolean(bulkRunning)}
              active={bulkRunning === activeTab}
              onClick={() => setConfirmKind(activeTab)}
              className="whitespace-nowrap"
            >
              {bulkRunning === activeTab ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {bulkProgress
                    ? `Queueing ${bulkProgress.queued}/${bulkProgress.scanned}…`
                    : 'Queueing…'}
                </>
              ) : (
                <>
                  <CloudDownload className="h-4 w-4" />
                  Download all
                </>
              )}
            </Button>
          )}
        </div>
      </section>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Library section">
        <CatPill
          label="Albums"
          icon={Disc3}
          active={activeTab === 'albums'}
          onClick={() => setActiveTab('albums')}
          count={tabs.albums.total ?? tabs.albums.items.length}
        />
        <CatPill
          label="Playlists"
          icon={ListMusic}
          active={activeTab === 'playlists'}
          onClick={() => setActiveTab('playlists')}
          count={tabs.playlists.total ?? tabs.playlists.items.length}
        />
        <CatPill
          label="Songs"
          icon={Music2}
          active={activeTab === 'songs'}
          onClick={() => setActiveTab('songs')}
          count={tabs.songs.total ?? tabs.songs.items.length}
        />
      </div>

      {activeState.error && <Badge variant="bad">{activeState.error}</Badge>}

      {showSkeleton ? (
        activeTab === 'songs' ? <SongSkeletonList /> : <SkeletonGrid />
      ) : !hasItems ? (
        <Card className="relative overflow-hidden p-8 md:p-10">
          <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-[rgba(var(--accent),0.12)] blur-3xl" />
          <div className="relative max-w-xl space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.10)] text-[rgb(var(--accent))]">
              <Cloud className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-semibold text-white">Nothing here yet.</h2>
            <p className="text-sm text-white/60">
              Save some {activeTab} in Apple Music and they'll show up here.
            </p>
          </div>
        </Card>
      ) : activeTab === 'albums' ? (
        <AlbumGrid items={tabs.albums.items} />
      ) : activeTab === 'playlists' ? (
        <PlaylistGrid items={tabs.playlists.items} />
      ) : (
        <SongList items={tabs.songs.items} />
      )}

      <div ref={sentinelRef} className="h-8 w-full" aria-hidden />
      {activeState.loadingMore && (
        <div className="flex justify-center py-4 text-xs text-white/50">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          Loading more…
        </div>
      )}

      <Modal
        open={confirmKind !== null}
        onClose={() => setConfirmKind(null)}
        placement="center"
        label="Confirm download all"
        className="!max-w-[26rem]"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgba(var(--accent),0.12)] border border-[rgba(var(--accent),0.25)] text-[rgb(var(--accent))]"
              aria-hidden
            >
              <CloudDownload className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white">
                Download all {confirmKind}?
              </h2>
              <p className="mt-1 text-sm text-white/60">
                Queues every {confirmKind?.replace(/s$/, '')} in your Apple Music library
                {totalLabel ? ` (~${totalLabel} item${totalLabel === 1 ? '' : 's'})` : ''}.
                Items already in your local library are skipped automatically.
              </p>
            </div>
          </div>
          {appSettings?.promptForDownloadQuality && (
            <div className="mt-5">
              <div className="mb-3">
                <div className="text-xs uppercase tracking-wider text-white/55">Download quality</div>
                <div className="mt-1 text-sm text-white/60">
                  Applies to every item queued by this action.
                </div>
              </div>
              <QualityPicker value={bulkQuality} onChange={setBulkQuality} />
            </div>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={() => setConfirmKind(null)} variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={startDownloadAll}
              className="bg-[rgba(var(--accent),0.18)] border-[rgba(var(--accent),0.4)] text-white hover:bg-[rgba(var(--accent),0.28)] hover:text-white"
            >
              <Download className="h-4 w-4" />
              Queue {totalLabel ? `~${totalLabel}` : 'all'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function NotConnectedScreen({
  reason,
  error,
  onRetry,
}: {
  reason?: CloudLibraryHealth['reason']
  error?: string
  onRetry: () => void
}) {
  const headline =
    reason === 'token-rejected'
      ? 'Your media-user-token was rejected'
      : reason === 'probe-failed'
        ? 'Couldn\u2019t reach Apple Music'
        : 'Connect your Apple Music account'
  const body =
    reason === 'token-rejected'
      ? 'Apple rejected the saved token. Refresh it in Settings — it expires periodically.'
      : reason === 'probe-failed'
        ? error || 'Network or token error while probing the Apple Music library.'
        : 'To list your saved library here, paste your media-user-token in Settings. Without it, ALACarte can only fetch the public catalog.'
  return (
    <div className="mx-auto w-full max-w-3xl pt-6">
      <Card className="relative overflow-hidden p-8 md:p-10">
        <div className="absolute -right-20 -top-20 h-52 w-52 rounded-full bg-[rgba(var(--accent),0.14)] blur-3xl" />
        <div className="relative space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.10)] text-[rgb(var(--accent))]">
            <Cloud className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-semibold text-white">{headline}</h2>
          <p className="text-sm text-white/65">{body}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Link
              to="/settings"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-white/80 transition-all hover:border-[rgba(var(--accent),0.3)] hover:bg-[rgba(var(--accent),0.12)] hover:text-[rgb(var(--accent))]"
            >
              Open Settings
            </Link>
            <Button onClick={onRetry} variant="ghost">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function CatPill({
  label,
  icon: Icon,
  active,
  onClick,
  count,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  onClick: () => void
  count?: number | null
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'inline-flex select-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[0.8125rem] font-medium text-white/70 transition-[background,border-color,color,transform] duration-[160ms] ease-smooth hover:bg-white/[0.08] hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.30)]',
        active && '!border-accent/50 !bg-accent/22 !text-white',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className="text-white/50 text-[11px] font-normal">{count}</span>
      )}
    </button>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <Card key={i} className="aspect-square">
          <motion.div
            className="h-full w-full bg-white/[0.04]"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 }}
          />
        </Card>
      ))}
    </div>
  )
}

function SongSkeletonList() {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 12 }).map((_, i) => (
        <Card key={i} className="flex items-center gap-3 p-2">
          <motion.div
            className="h-10 w-10 shrink-0 rounded-lg bg-white/[0.04]"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 }}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <motion.div
              className="h-3.5 w-[55%] rounded-full bg-white/[0.06]"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 }}
            />
            <motion.div
              className="h-3 w-[35%] rounded-full bg-white/[0.04]"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 + 0.1 }}
            />
          </div>
          <motion.div
            className="h-7 w-16 shrink-0 rounded-full bg-white/[0.04]"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.05 + 0.05 }}
          />
        </Card>
      ))}
    </div>
  )
}

function AlbumGrid({ items }: { items: CloudLibraryAlbum[] }) {
  return (
    <StaggeredList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
      {items.map((it) => (
        <StaggeredItem key={it.libraryId}>
          <CloudAlbumTile item={it} />
        </StaggeredItem>
      ))}
    </StaggeredList>
  )
}

function CloudAlbumTile({ item }: { item: CloudLibraryAlbum }) {
  const { isAlbumInLibrary } = useLibraryPresence()
  const localAlbum = { id: item.catalogId || item.libraryId, name: item.name, artistName: item.artistName }
  const alreadyInLibrary = isAlbumInLibrary(localAlbum)

  if (!item.catalogId) {
    return (
      <UnsupportedTile
        title={item.name}
        subtitle={item.artistName}
        artworkTemplate={item.artworkTemplate}
        kind={alreadyInLibrary ? 'In Library' : 'Unavailable'}
        variant={alreadyInLibrary ? 'ok' : 'muted'}
      />
    )
  }

  const album: Album = {
    id: item.catalogId,
    name: item.name,
    artistName: item.artistName,
    artworkTemplate: item.artworkTemplate,
    artworkColor: item.artworkColor || null,
    trackCount: item.trackCount,
  }

  return <AlbumCard album={album} alreadyInLibrary={alreadyInLibrary} />
}

function PlaylistGrid({ items }: { items: CloudLibraryPlaylist[] }) {
  return (
    <StaggeredList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
      {items.map((it) => {
        const playlist: Playlist = {
          id: it.catalogId || it.libraryId,
          name: it.name,
          curatorName: it.curatorName,
          artworkTemplate: it.artworkTemplate,
          artworkColor: it.artworkColor || null,
          description: it.description,
        }
        const libraryHref = it.catalogId
          ? `/playlist/${it.catalogId}`
          : `/playlist/library/${it.libraryId}`
        return (
          <StaggeredItem key={it.libraryId}>
            <PlaylistCard
              playlist={playlist}
              href={libraryHref}
              libraryId={it.catalogId ? null : it.libraryId}
              userCreatedBadge={it.isUserCreated}
            />
          </StaggeredItem>
        )
      })}
    </StaggeredList>
  )
}

function SongList({ items }: { items: CloudLibrarySong[] }) {
  return (
    <StaggeredList className="flex flex-col gap-1">
      {items.map((it) => (
        <StaggeredItem key={it.libraryId}>
          <CloudSongRow song={it} />
        </StaggeredItem>
      ))}
    </StaggeredList>
  )
}

function CloudSongRow({ song }: { song: CloudLibrarySong }) {
  const { jobs } = useQueue()
  const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt()
  const { isAlbumInLibrary, isSongInLibrary, verifySongPresence, verifyAlbumPresence, ready } =
    useLibraryPresence()
  const matching = useMemo(() => {
    if (!song.catalogId) return null
    return (
      jobs.find(
        (j) =>
          j.kind === 'song' &&
          j.songId === song.catalogId &&
          (j.status === 'queued' || j.status === 'running'),
      ) ||
      jobs.find((j) => j.kind === 'song' && j.songId === song.catalogId) ||
      null
    )
  }, [jobs, song.catalogId])

  const albumCatalog = song.catalogAlbumId
  const thumb = artworkUrl(song.artworkTemplate, 100)
  const songForLink: Song = {
    id: song.catalogId || song.libraryId,
    name: song.name,
    artistName: song.artistName,
    albumName: song.albumName,
    albumId: albumCatalog || null,
    artworkTemplate: song.artworkTemplate,
  }

  const songLookup = {
    id: song.catalogId || song.libraryId,
    name: song.name,
    artistName: song.artistName,
    albumName: song.albumName,
  }
  const albumLookup = song.albumName
    ? { id: albumCatalog || '', artistName: song.artistName, name: song.albumName }
    : null
  const alreadyInLibrary =
    isSongInLibrary(songLookup) || (albumLookup ? isAlbumInLibrary(albumLookup) : false)

  return (
    <Card hover className="group relative flex items-center gap-3 p-2">
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-black/50">
        {thumb && (
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">
          {albumCatalog ? (
            <Link to={`/album/${albumCatalog}`} className="hover:text-accent transition-colors">
              {songForLink.name}
            </Link>
          ) : (
            songForLink.name
          )}
        </div>
        <div className="truncate text-xs text-white/55">
          {song.artistName}
          {song.albumName ? ` · ${song.albumName}` : ''}
        </div>
      </div>
      {alreadyInLibrary ? (
        <div className="shrink-0 pr-1">
          <Badge variant="ok">In library</Badge>
        </div>
      ) : !song.catalogId ? (
        <div className="shrink-0 pr-1">
          <Badge variant="muted">Unavailable</Badge>
        </div>
      ) : (
        <div className="shrink-0 pr-1">
          <DownloadButton
            size="sm"
            job={matching}
            onStart={async () => {
              if (!ready) {
                if (await verifySongPresence(songLookup)) return false
                if (albumLookup && (await verifyAlbumPresence(albumLookup))) return false
              }
              try {
                const quality = await chooseDownloadQuality()
                if (quality === false) return false
                await api.enqueueSong(song.catalogId!, albumCatalog || null, undefined, quality)
                return true
              } catch (err: any) {
                if (/already in library/i.test(String(err?.message || ''))) return false
                throw err
              }
            }}
            ariaLabel={`Download ${song.name}`}
          />
        </div>
      )}
      {qualityPrompt}
    </Card>
  )
}

function UnsupportedTile({
  title,
  subtitle,
  artworkTemplate,
  kind,
  variant = 'muted',
}: {
  title: string
  subtitle: string
  artworkTemplate: string | null
  kind: 'Unavailable' | 'User-created' | 'In Library'
  variant?: 'muted' | 'ok'
}) {
  const thumb = artworkUrl(artworkTemplate, 600)
  return (
    <Card
      className={cx('group relative block', variant === 'ok' ? '' : 'opacity-70')}
      style={{ backgroundColor: '#1a1a1a' }}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-black/50">
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-white/30 text-3xl">
            ♪
          </div>
        )}
        <div
          className={cx(
            'absolute top-2 left-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white ring-1',
            variant === 'ok'
              ? 'bg-emerald-500/90 ring-white/20'
              : 'bg-black/80 text-white/80 ring-white/15',
          )}
        >
          {kind}
        </div>
      </div>
      <div className="p-3 backdrop-blur-md bg-black/30">
        <div className="truncate text-sm font-medium text-white">{title}</div>
        <div className="truncate text-xs text-white/55">{subtitle}</div>
      </div>
    </Card>
  )
}
