import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Search as SearchIcon,
  X,
  Disc3,
  UserRound,
  Music2,
  ListChecks,
  ListMusic,
} from 'lucide-react'

import { api, artworkUrl, type Album, type Artist, type Song, type Playlist } from '../api/client'
import { AlbumCard } from '../components/AlbumCard'
import { PlaylistCard } from '../components/PlaylistCard'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { Input } from '../components/Input'
import { DownloadButton } from '../components/DownloadButton'
import { ResolvedMediaLink } from '../components/ResolvedMediaLink'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { useDownloadQualityPrompt } from '../hooks/useDownloadQualityPrompt'
import { useLibraryPresence } from '../hooks/useLibraryPresence'
import { useQueue } from '../hooks/useQueue'
import { useTouchMode } from '../hooks/useTouchMode'
import { stripYear } from '../lib/format'
import { cx } from '../lib/cx'

type Results = {
  albums: Album[]
  artists: Artist[]
  songs: Song[]
  playlists: Playlist[]
}

const EMPTY: Results = { albums: [], artists: [], songs: [], playlists: [] }

type Category = 'albums' | 'artists' | 'songs' | 'playlists'
const ALL_CATS: Category[] = ['albums', 'artists', 'songs', 'playlists']
const resultCache = new Map<string, Results>()

function parseCats(param: string | null): Category[] {
  if (!param) return ALL_CATS
  const parts = param
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Category => ALL_CATS.includes(s as Category))
  return parts.length ? parts : ALL_CATS
}

export function SearchPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const urlQ = params.get('q') ?? ''
  const cats = useMemo(() => parseCats(params.get('cats')), [params])
  const catSet = useMemo(() => new Set(cats), [cats])

  const [q, setQ] = useState(urlQ)
  const [results, setResults] = useState<Results>(
    () => resultCache.get(urlQ.trim()) ?? EMPTY,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (urlQ !== q && !urlQ.startsWith(q)) {
      setQ(urlQ)
    }
    setResults(resultCache.get(urlQ.trim()) ?? EMPTY)
  }, [urlQ])

  const trimmed = useMemo(() => q.trim(), [q])

  useEffect(() => {
    const t = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (q) next.set('q', q)
          else next.delete('q')
          return next
        },
        { replace: true },
      )
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  useEffect(() => {
    if (!trimmed) {
      setResults(EMPTY)
      setError(null)
      return
    }
    const cached = resultCache.get(trimmed)
    if (cached) setResults(cached)

    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await api.search(trimmed)
        if (ctl.signal.aborted) return
        if (r.redirect) {
          navigate(r.redirect, { replace: true })
          return
        }
        const next = {
          albums: r.albums,
          artists: r.artists,
          songs: r.songs,
          playlists: r.playlists ?? [],
        }
        resultCache.set(trimmed, next)
        setResults(next)
      } catch (err: any) {
        if (!ctl.signal.aborted) setError(err?.message || 'Search failed')
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, cached ? 0 : 300)
    return () => {
      ctl.abort()
      clearTimeout(t)
    }
  }, [trimmed, navigate])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const allCatsSelected = cats.length === ALL_CATS.length

  const selectAllCats = () => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('cats')
        return next
      },
      { replace: true },
    )
  }

  const toggleCat = (c: Category) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        const isAll = cats.length === ALL_CATS.length
        let newCats: Category[]
        if (isAll) {
          newCats = [c]
        } else if (catSet.has(c)) {
          newCats = cats.filter((x) => x !== c)
          if (newCats.length === 0) newCats = ALL_CATS
        } else {
          newCats = [...cats, c]
        }
        const ordered = ALL_CATS.filter((x) => newCats.includes(x))
        if (ordered.length === ALL_CATS.length) next.delete('cats')
        else next.set('cats', ordered.join(','))
        return next
      },
      { replace: true },
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl pt-4 md:pt-6 space-y-6">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-white/40" />
        <Input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Artists, albums, songs, playlists, or Apple Music links…"
          className="pl-12 pr-12 text-base"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10"
            aria-label="Clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {error && <Badge variant="bad">{error}</Badge>}

      {!trimmed && (
        <Card className="p-8 text-center text-white/55">
          <SearchIcon className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="text-sm">
            Try searching for an artist, album, or song — or paste an Apple Music link.
          </div>
        </Card>
      )}

      {trimmed && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter results">
            <CatPill label="Show all" icon={ListChecks} active={allCatsSelected} onClick={selectAllCats} />
            <CatPill label="Albums" icon={Disc3} active={!allCatsSelected && catSet.has('albums')} onClick={() => toggleCat('albums')} count={results.albums.length} />
            <CatPill label="Artists" icon={UserRound} active={!allCatsSelected && catSet.has('artists')} onClick={() => toggleCat('artists')} count={results.artists.length} />
            <CatPill label="Songs" icon={Music2} active={!allCatsSelected && catSet.has('songs')} onClick={() => toggleCat('songs')} count={results.songs.length} />
            <CatPill label="Playlists" icon={ListMusic} active={!allCatsSelected && catSet.has('playlists')} onClick={() => toggleCat('playlists')} count={results.playlists.length} />
          </div>

          {catSet.has('albums') && (
            <Section title={`Albums${loading ? ' · searching' : ''}`} empty={results.albums.length === 0 && !loading}>
              <StaggeredList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
                {results.albums.map((a) => (
                  <StaggeredItem key={a.id}>
                    <AlbumCard album={a} />
                  </StaggeredItem>
                ))}
              </StaggeredList>
            </Section>
          )}

          {catSet.has('artists') && (
            <Section title="Artists" empty={results.artists.length === 0}>
              <StaggeredList className="flex flex-wrap gap-2">
                {results.artists.map((a) => (
                  <StaggeredItem key={a.id}>
                    <Link to={`/artist/${a.id}`}>
                      <Card hover className="px-4 py-2 text-sm">{a.name}</Card>
                    </Link>
                  </StaggeredItem>
                ))}
              </StaggeredList>
            </Section>
          )}

          {catSet.has('songs') && (
            <Section title="Songs" empty={results.songs.length === 0}>
              <StaggeredList className="flex flex-col gap-1">
                {results.songs
                  .slice(0, cats.length === 1 ? 50 : 10)
                  .map((s) => (
                    <StaggeredItem key={s.id}>
                      <SongRow song={s} />
                    </StaggeredItem>
                  ))}
              </StaggeredList>
            </Section>
          )}

          {catSet.has('playlists') && (
            <Section title={`Playlists${loading ? ' · searching' : ''}`} empty={results.playlists.length === 0 && !loading}>
              <StaggeredList className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
                {results.playlists.map((p) => (
                  <StaggeredItem key={p.id}>
                    <PlaylistCard playlist={p} />
                  </StaggeredItem>
                ))}
              </StaggeredList>
            </Section>
          )}
        </>
      )}
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
  count?: number
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

function Section({ title, children, empty }: { title: string; empty?: boolean; children: React.ReactNode }) {
  if (empty) return null
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50 mb-3">{title}</h2>
      {children}
    </section>
  )
}

function SongRow({ song }: { song: Song }) {
  const { jobs } = useQueue()
  const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt()
  const {
    ready,
    isSongInLibrary,
    isAlbumInLibrary,
    verifySongPresence,
    verifyAlbumPresence,
  } = useLibraryPresence()
  const touchMode = useTouchMode()
  const matching = useMemo(() => {
    if (!song.id) return null
    const active = jobs.find(
      (j) => j.kind === 'song' && j.songId === song.id && (j.status === 'queued' || j.status === 'running'),
    )
    if (active) return active
    return jobs.find((j) => j.kind === 'song' && j.songId === song.id) || null
  }, [jobs, song.id])

  const canDownload = Boolean(song.albumId)
  const albumLookup = song.albumName
    ? { id: song.albumId || '', artistName: song.artistName, name: song.albumName }
    : null
  const alreadyInLibrary =
    isSongInLibrary(song) || (albumLookup ? isAlbumInLibrary(albumLookup) : false)

  return (
    <Card hover className="group relative flex items-center gap-3 p-2">
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-black/50">
        {song.albumId ? (
          <Link to={`/album/${song.albumId}`}>
            {song.artworkTemplate && (
              <img src={artworkUrl(song.artworkTemplate, 100) || undefined} alt="" className="h-full w-full object-cover" />
            )}
          </Link>
        ) : (
          song.artworkTemplate && (
            <img src={artworkUrl(song.artworkTemplate, 100) || undefined} alt="" className="h-full w-full object-cover" />
          )
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {song.albumId ? (
            <Link to={`/album/${song.albumId}`} className="hover:text-accent transition-colors">{song.name}</Link>
          ) : (
            song.name
          )}
        </div>
        <div className="truncate text-xs text-white/55">
          <ResolvedMediaLink
            kind="artist"
            artistId={song.artistId}
            artistName={song.artistName}
            className="hover:text-accent transition-colors"
          >
            {song.artistName}
          </ResolvedMediaLink>
          {song.albumName ? (
            <>
              {' · '}
              <ResolvedMediaLink
                kind="album"
                artistName={song.artistName}
                artistId={song.artistId}
                albumId={song.albumId}
                albumName={song.albumName}
                className="hover:text-accent transition-colors"
              >
                {stripYear(song.albumName)}
              </ResolvedMediaLink>
            </>
          ) : null}
        </div>
      </div>
      {canDownload && (
        <div className="shrink-0 pr-1 flex items-center justify-center">
          <DownloadButton
            size="sm"
            job={matching}
            onStart={async () => {
              if (!song.albumId) return false
              if (!ready) {
                if (await verifySongPresence(song)) return false
                if (albumLookup && (await verifyAlbumPresence(albumLookup))) return false
              }
              try {
                const quality = await chooseDownloadQuality()
                if (quality === false) return false
                await api.enqueueSong(song.id, song.albumId, undefined, quality)
                return true
              } catch (err: any) {
                if (/already in library/i.test(String(err?.message || ''))) {
                  await verifySongPresence(song)
                  if (albumLookup) await verifyAlbumPresence(albumLookup)
                  return false
                }
                throw err
              }
            }}
            ariaLabel={`Download ${song.name}`}
            blocked={alreadyInLibrary}
            className={cx(
              touchMode
                ? 'opacity-100'
                : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 md:pointer-events-none md:group-hover:pointer-events-auto md:focus-within:pointer-events-auto transition-opacity duration-200',
            )}
          />
          {qualityPrompt}
        </div>
      )}
    </Card>
  )
}
