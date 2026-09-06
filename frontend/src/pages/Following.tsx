import { useEffect, useState, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
    CheckCircle2,
    Clock,
    ListMusic,
    RefreshCw,
    UserRoundCheck,
    X,
    Loader2,
    Download,
    AlertTriangle,
} from "lucide-react";

import {
    api,
    artworkUrl,
    type FollowedArtist,
    type FollowedPlaylist,
    type Job,
    type QualityPreference,
    type ReleaseScope,
} from "../api/client";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { StaggeredItem, StaggeredList } from "../components/StaggeredList";
import {
    useActivityFeed,
    type FollowingArtistState,
    type PlaylistFollowingState,
} from "../hooks/useActivityFeed";
import { useDownloadQualityPrompt } from "../hooks/useDownloadQualityPrompt";
import { ReleaseScopePicker } from "../components/ReleaseScopePicker";
import { cx } from "../lib/cx";

type FollowTab = "artists" | "playlists";

function isFollowTab(value: string | null): value is FollowTab {
    return value === "artists" || value === "playlists";
}

export function FollowingPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const tabParam = searchParams.get("tab");
    const activeTab: FollowTab = isFollowTab(tabParam) ? tabParam : "artists";
    const setActiveTab = (tab: FollowTab) => {
        const next = new URLSearchParams(searchParams);
        if (tab === "artists") next.delete("tab");
        else next.set("tab", tab);
        setSearchParams(next, { replace: true });
    };

    const { jobs, followingState, playlistFollowingState } = useActivityFeed();
    const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt();
    const [artists, setArtists] = useState<FollowedArtist[]>([]);
    const [playlists, setPlaylists] = useState<FollowedPlaylist[]>([]);
    const [loading, setLoading] = useState(true);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [queuedCount, setQueuedCount] = useState(0);
    const [updatingScopeId, setUpdatingScopeId] = useState<string | null>(null);
    const [syncingPlaylistId, setSyncingPlaylistId] = useState<string | null>(
        null,
    );
    const activeJobsTotal = jobs.filter(
        (j) => j.status === "queued" || j.status === "running",
    ).length;
    const activePlaylistJobCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const j of jobs) {
            if (
                j.followedPlaylistId &&
                (j.status === "queued" || j.status === "running")
            ) {
                counts[j.followedPlaylistId] =
                    (counts[j.followedPlaylistId] || 0) + 1;
            }
        }
        return counts;
    }, [jobs]);
    const anyArtistMissing = artists.some((a) => {
        const live = followingState[a.id];
        const missing =
            typeof live?.missingReleaseCount === "number"
                ? live.missingReleaseCount
                : a.missingReleaseCount;
        return (a.totalReleaseCount || 0) > 0 && missing > 0;
    });
    const showBulkButton = anyArtistMissing || activeJobsTotal > 0;

    const reload = () => {
        setLoading(true);
        setError(null);
        Promise.all([api.following(), api.playlistFollowing()])
            .then(([artistResponse, playlistResponse]) => {
                setArtists(artistResponse.artists);
                setPlaylists(playlistResponse.playlists);
            })
            .catch((err) =>
                setError(err.message || "Failed to load followed items"),
            )
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        reload();
    }, []);

    const unfollow = async (id: string) => {
        const previous = artists;
        setArtists((items) => items.filter((artist) => artist.id !== id));
        try {
            await api.unfollowArtist(id);
        } catch (err: any) {
            setArtists(previous);
            setError(err.message || "Failed to unfollow artist");
        }
    };

    const unfollowPlaylist = async (id: string) => {
        const previous = playlists;
        setPlaylists((items) => items.filter((playlist) => playlist.id !== id));
        try {
            await api.unfollowPlaylist(id);
        } catch (err: any) {
            setPlaylists(previous);
            setError(err.message || "Failed to unfollow playlist");
        }
    };

    const syncPlaylist = async (id: string) => {
        setSyncingPlaylistId(id);
        setError(null);
        try {
            const result = await api.syncFollowedPlaylistNow(id);
            if (!result.ok) {
                setError("Playlist sync failed");
                return;
            }
            if (result.playlist) {
                setPlaylists((items) =>
                    items.map((playlist) =>
                        playlist.id === id ? result.playlist! : playlist,
                    ),
                );
            }
            if (result.queued > 0) {
                setQueuedCount((count) => count + result.queued);
                window.setTimeout(
                    () => setQueuedCount((count) => Math.max(0, count - result.queued)),
                    8000,
                );
            }
        } catch (err: any) {
            setError(err.message || "Failed to sync playlist");
        } finally {
            setSyncingPlaylistId(null);
        }
    };

    const downloadPlaylistMissing = async (
        id: string,
        quality?: QualityPreference,
    ) => {
        setSyncingPlaylistId(id);
        setError(null);
        try {
            const result = await api.downloadPlaylistMissing(id, quality);
            if (result.playlist) {
                setPlaylists((items) =>
                    items.map((playlist) =>
                        playlist.id === id ? result.playlist! : playlist,
                    ),
                );
            }
            if (result.queued > 0) {
                setQueuedCount((count) => count + result.queued);
                window.setTimeout(
                    () => setQueuedCount((count) => Math.max(0, count - result.queued)),
                    8000,
                );
            }
        } catch (err: any) {
            setError(err.message || "Failed to download missing tracks");
        } finally {
            setSyncingPlaylistId(null);
        }
    };

    const updateScope = async (id: string, releaseScope: ReleaseScope) => {
        const previous = artists;
        setUpdatingScopeId(id);
        setError(null);
        setArtists((items) =>
            items.map((artist) =>
                artist.id === id ? { ...artist, releaseScope } : artist,
            ),
        );
        try {
            const response = await api.updateFollowedArtist(id, {
                releaseScope,
            });
            if (response.artist) {
                setArtists((items) =>
                    items.map((artist) =>
                        artist.id === id ? response.artist! : artist,
                    ),
                );
            }
        } catch (err: any) {
            setArtists(previous);
            setError(err.message || "Failed to update release scope");
        } finally {
            setUpdatingScopeId(null);
        }
    };

    const runCheck = async () => {
        setChecking(true);
        setError(null);
        try {
            await Promise.all([
                api.runFollowingCheck(),
                api.runPlaylistSync().catch(() => null),
            ]);
            reload();
        } catch (err: any) {
            setError(err.message || "Failed to check for new music");
        } finally {
            setChecking(false);
        }
    };

    return (
        <div className="mx-auto w-full max-w-7xl space-y-6 pt-4 md:pt-6">
            <AnimatePresence>
                {queuedCount > 0 && (
                    <motion.div
                        key="queued-banner"
                        initial={{ opacity: 0, y: -8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.98 }}
                        transition={{
                            type: "spring",
                            stiffness: 420,
                            damping: 28,
                        }}
                        className="flex items-center justify-between gap-3 rounded-app border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.10)] px-4 py-2.5 text-sm text-white/90 backdrop-blur-[10px]"
                    >
                        <div>
                            Queued <b>{queuedCount}</b> item
                            {queuedCount === 1 ? "" : "s"}.{" "}
                            <Link
                                to="/"
                                className="font-medium text-[rgb(var(--accent))] underline underline-offset-2 transition-colors hover:text-white"
                            >
                                Open activity
                            </Link>
                        </div>
                        <button
                            type="button"
                            onClick={() => setQueuedCount(0)}
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
                        Following
                    </h1>
                    <p className="max-w-2xl text-sm text-white/60 md:text-base">
                        Follow artists to watch for new releases and playlists
                        to auto-download tracks you add to them.
                    </p>
                    <div
                        className="flex flex-wrap gap-2 pt-1"
                        role="group"
                        aria-label="Following section"
                    >
                        <FollowTabPill
                            label="Artists"
                            icon={UserRoundCheck}
                            active={activeTab === "artists"}
                            onClick={() => setActiveTab("artists")}
                            count={artists.length}
                        />
                        <FollowTabPill
                            label="Playlists"
                            icon={ListMusic}
                            active={activeTab === "playlists"}
                            onClick={() => setActiveTab("playlists")}
                            count={playlists.length}
                        />
                    </div>
                </div>
                <div
                    className="flex w-full flex-wrap items-center justify-start gap-2 md:w-auto md:justify-end"
                    aria-busy={activeJobsTotal > 0}
                >
                    <Button
                        onClick={runCheck}
                        disabled={checking || loading}
                        className="whitespace-nowrap"
                    >
                        <RefreshCw
                            className={
                                checking ? "h-4 w-4 animate-spin" : "h-4 w-4"
                            }
                        />
                        {checking ? "Checking…" : "Check now"}
                    </Button>
                    {showBulkButton && activeTab === "artists" && (
                        <Button
                            disabled={
                                checking || loading || activeJobsTotal > 0
                            }
                            active={activeJobsTotal > 0}
                            onClick={() => {
                                void (async () => {
                                    const quality =
                                        await chooseDownloadQuality();
                                    if (quality === false) return;
                                    api.downloadMissingReleases(quality)
                                        .then((res) =>
                                            setQueuedCount(res.queued),
                                        )
                                        .catch((err: any) =>
                                            setError(
                                                err.message ||
                                                    "Failed to download missing releases",
                                            ),
                                        );
                                })();
                            }}
                            className="whitespace-nowrap"
                        >
                            {activeJobsTotal > 0 ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Downloading…
                                </>
                            ) : (
                                <>
                                    <Download className="h-4 w-4" />
                                    Download missing
                                </>
                            )}
                        </Button>
                    )}
                </div>
            </section>

            {error && <Badge variant="bad">{error}</Badge>}

            {loading ? (
                <Card className="p-6 text-sm text-white/55">
                    Loading followed {activeTab}…
                </Card>
            ) : activeTab === "artists" ? (
                artists.length === 0 ? (
                    <EmptyState
                        icon={<UserRoundCheck className="h-5 w-5" />}
                        title="No artists followed yet."
                        body="Open an artist page and use Follow to start watching for new albums and singles."
                        linkLabel="Find artists"
                    />
                ) : (
                    <StaggeredList className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <AnimatePresence initial={false}>
                            {artists.map((artist) => (
                                <StaggeredItem key={artist.id}>
                                    <ArtistFollowCard
                                        artist={artist}
                                        jobs={jobs}
                                        liveState={followingState[artist.id]}
                                        onUnfollow={() => unfollow(artist.id)}
                                        onScopeChange={(scope) =>
                                            updateScope(artist.id, scope)
                                        }
                                        updatingScope={
                                            updatingScopeId === artist.id
                                        }
                                    />
                                </StaggeredItem>
                            ))}
                        </AnimatePresence>
                    </StaggeredList>
                )
            ) : playlists.length === 0 ? (
                <EmptyState
                    icon={<ListMusic className="h-5 w-5" />}
                    title="No playlists followed yet."
                    body="Open one of your Apple Music playlists (or any Apple playlist) and use Follow. ALACarte will download every track you add to it."
                    linkLabel="Browse cloud playlists"
                    linkHref="/cloud-library?tab=playlists"
                />
            ) : (
                <StaggeredList className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <AnimatePresence initial={false}>
                        {playlists.map((playlist) => (
                            <StaggeredItem key={playlist.id}>
                                <PlaylistFollowCard
                                    playlist={playlist}
                                    liveState={playlistFollowingState[playlist.id]}
                                    activeJobCount={
                                        activePlaylistJobCounts[playlist.id] || 0
                                    }
                                    syncing={syncingPlaylistId === playlist.id}
                                    onSync={() => syncPlaylist(playlist.id)}
                                    onDownloadMissing={(quality) =>
                                        downloadPlaylistMissing(
                                            playlist.id,
                                            quality,
                                        )
                                    }
                                    onUnfollow={() =>
                                        unfollowPlaylist(playlist.id)
                                    }
                                />
                            </StaggeredItem>
                        ))}
                    </AnimatePresence>
                </StaggeredList>
            )}
            {qualityPrompt}
        </div>
    );
}

function FollowTabPill({
    label,
    icon: Icon,
    active,
    onClick,
    count,
}: {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    active: boolean;
    onClick: () => void;
    count: number;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={cx(
                "inline-flex select-none items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[0.8125rem] font-medium text-white/70 transition-[background,border-color,color,transform] duration-[160ms] ease-smooth hover:bg-white/[0.08] hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.30)]",
                active && "!border-accent/50 !bg-accent/22 !text-white",
            )}
        >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {count > 0 && (
                <span className="text-white/50 text-[11px] font-normal">
                    {count}
                </span>
            )}
        </button>
    );
}

function EmptyState({
    icon,
    title,
    body,
    linkLabel,
    linkHref = "/search",
}: {
    icon: React.ReactNode;
    title: string;
    body: string;
    linkLabel: string;
    linkHref?: string;
}) {
    return (
        <Card className="relative overflow-hidden p-8 md:p-10">
            <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-[rgba(var(--accent),0.12)] blur-3xl" />
            <div className="relative max-w-xl space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.10)] text-[rgb(var(--accent))]">
                    {icon}
                </div>
                <h2 className="text-xl font-semibold text-white">{title}</h2>
                <p className="text-sm text-white/60">{body}</p>
                <Link
                    to={linkHref}
                    className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-white/80 transition-all hover:border-[rgba(var(--accent),0.3)] hover:bg-[rgba(var(--accent),0.12)] hover:text-[rgb(var(--accent))]"
                >
                    {linkLabel}
                </Link>
            </div>
        </Card>
    );
}

function PlaylistFollowCard({
    playlist,
    liveState,
    activeJobCount,
    syncing,
    onSync,
    onDownloadMissing,
    onUnfollow,
}: {
    playlist: FollowedPlaylist;
    liveState?: PlaylistFollowingState;
    activeJobCount: number;
    syncing: boolean;
    onSync: () => void;
    onDownloadMissing: (quality?: QualityPreference) => void;
    onUnfollow: () => void;
}) {
    const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt();
    const href = playlist.libraryId
        ? `/playlist/library/${playlist.libraryId}`
        : `/playlist/${playlist.catalogId}`;
    const total =
        typeof liveState?.totalTrackCount === "number"
            ? liveState.totalTrackCount
            : playlist.totalTrackCount;
    const missing =
        typeof liveState?.missingTrackCount === "number"
            ? liveState.missingTrackCount
            : playlist.missingTrackCount;
    const undownloadable =
        typeof liveState?.undownloadableTrackCount === "number"
            ? liveState.undownloadableTrackCount
            : playlist.undownloadableTrackCount;
    const lastError = playlist.lastError;
    const complete = missing === 0 && total > 0;
    const art = artworkUrl(playlist.artworkTemplate, 300);

    return (
        <motion.div
            layout
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="h-full"
        >
            <Card
                hover
                className="group relative flex h-full flex-col overflow-hidden p-4"
            >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(var(--accent),0.12),transparent_42%)] opacity-80" />
                <div className="relative flex flex-1 flex-col gap-4">
                    <div className="flex items-start gap-4">
                        <Link
                            to={href}
                            className="h-20 w-20 shrink-0 overflow-hidden rounded-[24px] border border-white/[0.08] bg-black/45 shadow-[0_18px_35px_-22px_rgba(0,0,0,0.9)]"
                        >
                            {art ? (
                                <img
                                    src={art}
                                    alt=""
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center text-white/35">
                                    <ListMusic className="h-7 w-7" />
                                </div>
                            )}
                        </Link>
                        <div className="min-w-0 flex-1">
                            <Link
                                to={href}
                                className="line-clamp-2 text-lg font-semibold leading-tight text-white transition-colors hover:text-[rgb(var(--accent))]"
                            >
                                {playlist.name}
                            </Link>
                            <div className="mt-0.5 truncate text-xs text-white/50">
                                {playlist.curatorName}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {complete ? (
                                    <Badge variant="ok">
                                        <CheckCircle2 className="h-3 w-3" />
                                        All tracks saved
                                    </Badge>
                                ) : (
                                    total > 0 && (
                                        <Badge variant="warn">
                                            {missing} not in library
                                        </Badge>
                                    )
                                )}
                                {total > 0 && <Badge>{total} tracks</Badge>}
                                {undownloadable > 0 && (
                                    <Badge variant="muted">
                                        {undownloadable} not on Apple Music
                                    </Badge>
                                )}
                            </div>
                            {lastError && (
                                <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-300/90">
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <span className="min-w-0">{lastError}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="mt-auto flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0 text-xs text-white/45">
                            <div className="flex items-center gap-1.5">
                                <Clock className="h-3.5 w-3.5" />
                                {playlist.lastCheckedAt
                                    ? `Synced ${formatRelativeTime(playlist.lastCheckedAt)}`
                                    : "Waiting for first sync"}
                            </div>
                            {activeJobCount > 0 && (
                                <div className="mt-1 text-[rgb(var(--accent))]">
                                    {activeJobCount} track
                                    {activeJobCount === 1 ? "" : "s"}{" "}
                                    downloading…
                                </div>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center justify-start gap-2 lg:shrink-0 lg:justify-end">
                            {missing > 0 && activeJobCount === 0 && (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        try {
                                            const quality =
                                                await chooseDownloadQuality();
                                            if (quality === false) return;
                                            onDownloadMissing(quality);
                                        } catch (err) {
                                            console.error(err);
                                        }
                                    }}
                                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-xs font-medium text-white/65 transition-colors hover:border-[rgba(var(--accent),0.3)] hover:bg-[rgba(var(--accent),0.12)] hover:text-white"
                                >
                                    <Download className="h-3.5 w-3.5" />
                                    Download missing
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={onSync}
                                disabled={syncing}
                                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-xs font-medium text-white/65 transition-colors hover:border-[rgba(var(--accent),0.3)] hover:bg-[rgba(var(--accent),0.12)] hover:text-white disabled:opacity-50"
                            >
                                <RefreshCw
                                    className={
                                        syncing
                                            ? "h-3.5 w-3.5 animate-spin"
                                            : "h-3.5 w-3.5"
                                    }
                                />
                                Sync now
                            </button>
                            {qualityPrompt}
                            <button
                                type="button"
                                onClick={onUnfollow}
                                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-xs font-medium text-white/65 transition-colors hover:border-rose-300/30 hover:bg-rose-500/10 hover:text-rose-200"
                            >
                                <X className="h-3.5 w-3.5" />
                                Unfollow
                            </button>
                        </div>
                    </div>
                </div>
            </Card>
        </motion.div>
    );
}

function ArtistFollowCard({
    artist,
    jobs,
    liveState,
    onUnfollow,
    onScopeChange,
    updatingScope,
}: {
    artist: FollowedArtist;
    jobs: Job[];
    liveState?: FollowingArtistState;
    onUnfollow: () => void;
    onScopeChange: (scope: ReleaseScope) => void;
    updatingScope: boolean;
}) {
    const { chooseDownloadQuality, qualityPrompt } = useDownloadQualityPrompt();
    const artistJobs = useMemo(() => {
        const map = new Map<string, Job>();
        for (const j of jobs) {
            if (j.artistId === artist.id && j.kind === "album" && j.albumId) {
                map.set(j.albumId, j);
            }
        }
        return Array.from(map.values());
    }, [jobs, artist.id]);

    const activeJobs = artistJobs.filter(
        (j) => j.status === "queued" || j.status === "running",
    );
    const finishedJobs = artistJobs.filter(
        (j) => j.status === "done" || j.status === "failed",
    );
    const totalJobs = activeJobs.length + finishedJobs.length;
    const isDownloading = activeJobs.length > 0;
    const progressPercent =
        totalJobs > 0 ? (finishedJobs.length / totalJobs) * 100 : 0;

    const displayMissingCount = Math.max(
        0,
        typeof liveState?.missingReleaseCount === "number"
            ? liveState.missingReleaseCount
            : artist.missingReleaseCount,
    );
    const totalCount = liveState?.totalReleaseCount ?? artist.totalReleaseCount;
    const releaseScope =
        liveState?.releaseScope || artist.releaseScope || "everything";
    const isFullyDownloaded = totalCount > 0 && displayMissingCount === 0;

    const art = artworkUrl(artist.artworkTemplate, 300);
    return (
        <motion.div
            layout
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="h-full"
        >
            <Card
                hover
                className="group relative flex h-full flex-col overflow-hidden p-4"
            >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(var(--accent),0.12),transparent_42%)] opacity-80" />
                <div className="relative flex flex-1 flex-col gap-4">
                    <div className="flex items-start gap-4">
                        <Link
                            to={`/artist/${artist.id}`}
                            className="h-20 w-20 shrink-0 overflow-hidden rounded-[24px] border border-white/[0.08] bg-black/45 shadow-[0_18px_35px_-22px_rgba(0,0,0,0.9)]"
                        >
                            {art ? (
                                <img
                                    src={art}
                                    alt=""
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center text-white/35">
                                    <UserRoundCheck className="h-7 w-7" />
                                </div>
                            )}
                        </Link>
                        <div className="min-w-0 flex-1">
                            <Link
                                to={`/artist/${artist.id}`}
                                className="line-clamp-2 text-lg font-semibold leading-tight text-white transition-colors hover:text-[rgb(var(--accent))]"
                            >
                                {artist.name}
                            </Link>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {isFullyDownloaded ? (
                                    <Badge variant="ok">
                                        <CheckCircle2 className="h-3 w-3" />
                                        Complete
                                    </Badge>
                                ) : (
                                    <Badge variant="warn">
                                        {displayMissingCount} missing
                                    </Badge>
                                )}
                                <Badge>{totalCount} releases</Badge>
                            </div>
                            <div className="mt-3">
                                <ReleaseScopePicker
                                    value={releaseScope}
                                    onChange={onScopeChange}
                                    compact
                                    disabled={updatingScope}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-auto flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0 text-xs text-white/45">
                            <div className="flex items-center gap-1.5">
                                <Clock className="h-3.5 w-3.5" />
                                {artist.lastCheckedAt
                                    ? `Checked ${formatRelativeTime(artist.lastCheckedAt)}`
                                    : "Waiting for first check"}
                            </div>
                            {artist.latestReleaseDate && (
                                <div
                                    className="mt-1 truncate"
                                    title={`Latest release ${artist.latestReleaseDate}`}
                                >
                                    Latest release {artist.latestReleaseDate}
                                </div>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center justify-start gap-2 lg:shrink-0 lg:justify-end">
                            {isDownloading ? (
                                <div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-3 text-xs font-medium text-[rgb(var(--accent))]">
                                    <div className="w-16">
                                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[rgba(var(--accent),0.2)]">
                                            <div
                                                className="absolute inset-y-0 left-0 rounded-full bg-[rgb(var(--accent))] transition-[width] duration-300 ease-snappy"
                                                style={{
                                                    width: `${progressPercent}%`,
                                                }}
                                            />
                                        </div>
                                    </div>
                                    <span>
                                        {finishedJobs.length}/{totalJobs}
                                    </span>
                                </div>
                            ) : displayMissingCount > 0 ? (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        try {
                                            const quality =
                                                await chooseDownloadQuality();
                                            if (quality === false) return;
                                            await api.downloadArtistMissingReleases(
                                                artist.id,
                                                quality,
                                            );
                                        } catch (err) {
                                            console.error(err);
                                        }
                                    }}
                                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-xs font-medium text-white/65 transition-colors hover:border-[rgba(var(--accent),0.3)] hover:bg-[rgba(var(--accent),0.12)] hover:text-white"
                                >
                                    Download missing
                                </button>
                            ) : null}
                            {qualityPrompt}
                            <button
                                type="button"
                                onClick={onUnfollow}
                                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-xs font-medium text-white/65 transition-colors hover:border-rose-300/30 hover:bg-rose-500/10 hover:text-rose-200"
                            >
                                <X className="h-3.5 w-3.5" />
                                Unfollow
                            </button>
                        </div>
                    </div>
                </div>
            </Card>
        </motion.div>
    );
}

function formatRelativeTime(ts: number) {
    const diff = Date.now() - ts;
    if (diff < 10_000) return "just now";
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
}
