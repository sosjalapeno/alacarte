import { useEffect, useMemo, useRef, useState } from "react";

import { api, type Job, type ReleaseScope } from "../api/client";
import { stripYear } from "../lib/format";
import { useEventStream, type EventStreamStatus } from "./useEventStream";

export type ActivitySeverity = "info" | "success" | "warning" | "error";
export type ActivitySource = "job" | "wrapper" | "system";

export type ActivityFeedItem = {
    id: string;
    ts: number;
    source: ActivitySource;
    severity: ActivitySeverity;
    title: string;
    detail?: string;
    jobId?: string;
    jobStatus?: Job["status"];
    progress?: number;
};

export type ActivityTerminalLine = {
    id: string;
    ts: number;
    source: ActivitySource;
    severity: ActivitySeverity;
    text: string;
    channel: "event" | "stdout" | "stderr";
    jobId?: string;
};

type WrapperEvent = {
    phase?: string;
    error?: string | null;
};

type JobLogEvent = {
    id?: string;
    line?: string;
    which?: "stdout" | "stderr";
};

type WrapperLogEvent = {
    line?: string;
};

type FollowingCheckEvent = {
    phase?: string;
    reason?: string;
    artists?: number;
    totalArtists?: number;
    queued?: number;
    discovered?: number;
    artistName?: string;
    message?: string;
};

type FollowingDownloadEvent = {
    artistName?: string;
    albumTitle?: string;
    jobId?: string;
    error?: string;
};

type WrapperStallEvent = {
    jobId?: string;
    albumTitle?: string;
    currentTrack?: string | null;
    idleMs?: number;
    thresholdMs?: number;
    lastLine?: string;
    phase?: "warning" | "aborting";
};

type FollowingUpdatedEvent = {
    artistId?: string;
    missingReleaseCount?: number;
    totalReleaseCount?: number;
    releaseScope?: ReleaseScope;
    followed?: boolean;
    albumId?: string;
};

export type FollowingArtistState = {
    missingReleaseCount: number;
    totalReleaseCount?: number;
    releaseScope?: ReleaseScope;
    unfollowed?: boolean;
    updatedAt: number;
};

type PlaylistFollowingCheckEvent = {
    phase?: string;
    reason?: string;
    playlists?: number;
    totalPlaylists?: number;
    queued?: number;
    discovered?: number;
    playlistId?: string;
    playlistName?: string;
    message?: string;
};

type PlaylistFollowingDownloadEvent = {
    playlistId?: string;
    playlistName?: string;
    trackId?: string;
    trackName?: string;
    artistName?: string;
    jobId?: string | null;
    error?: string;
};

type PlaylistFollowingUpdatedEvent = {
    playlistId?: string;
    totalTrackCount?: number;
    missingTrackCount?: number;
    undownloadableTrackCount?: number;
    queued?: number;
    followed?: boolean;
};

export type PlaylistFollowingState = {
    totalTrackCount?: number;
    missingTrackCount?: number;
    undownloadableTrackCount?: number;
    unfollowed?: boolean;
    updatedAt: number;
};

const MAX_FEED_ITEMS = 120;
const MAX_TERMINAL_LINES = 600;

export function useActivityFeed() {
    const [jobs, setJobs] = useState<Record<string, Job>>({});
    const [feedItems, setFeedItems] = useState<ActivityFeedItem[]>([]);
    const [terminalLines, setTerminalLines] = useState<ActivityTerminalLine[]>(
        [],
    );
    const [loading, setLoading] = useState(true);
    const [streamStatus, setStreamStatus] =
        useState<EventStreamStatus>("connecting");
    const [followingState, setFollowingState] = useState<
        Record<string, FollowingArtistState>
    >({});
    const [playlistFollowingState, setPlaylistFollowingState] = useState<
        Record<string, PlaylistFollowingState>
    >({});
    const sequenceRef = useRef(0);
    const jobFeedSignatureRef = useRef(new Map<string, string>());
    const wrapperPhaseRef = useRef("");

    const nextId = () => {
        sequenceRef.current += 1;
        return `${Date.now()}-${sequenceRef.current}`;
    };

    const upsertJobFeedItem = (item: ActivityFeedItem) => {
        if (!item.jobId || !item.jobStatus) {
            appendFeedItem(item);
            return;
        }

        setFeedItems((prev) => {
            const index = prev.findIndex(
                (candidate) => candidate.jobId === item.jobId,
            );
            if (index === -1) {
                const inserted = [item, ...prev];
                return inserted.length <= MAX_FEED_ITEMS
                    ? inserted
                    : inserted.slice(0, MAX_FEED_ITEMS);
            }

            const next = [...prev];
            next[index] = {
                ...next[index],
                ...item,
                id: next[index].id,
            };

            if (index > 0) {
                const [updated] = next.splice(index, 1);
                next.unshift(updated);
            }

            return next.length <= MAX_FEED_ITEMS
                ? next
                : next.slice(0, MAX_FEED_ITEMS);
        });
    };

    const appendFeedItem = (item: ActivityFeedItem) => {
        setFeedItems((prev) => {
            const next = [item, ...prev];
            return next.length <= MAX_FEED_ITEMS
                ? next
                : next.slice(0, MAX_FEED_ITEMS);
        });
    };

    const appendTerminalLine = (line: ActivityTerminalLine) => {
        setTerminalLines((prev) => {
            const next = [...prev, line];
            return next.length <= MAX_TERMINAL_LINES
                ? next
                : next.slice(next.length - MAX_TERMINAL_LINES);
        });
    };

    useEffect(() => {
        let cancelled = false;

        api.queue()
            .then((response) => {
                if (cancelled) return;
                const map: Record<string, Job> = {};
                for (const job of response.jobs) {
                    map[job.id] = job;
                    jobFeedSignatureRef.current.set(
                        job.id,
                        buildJobSignature(job),
                    );
                }
                setJobs((prev) => ({ ...map, ...prev }));

                const seededJobs = [...response.jobs]
                    .sort(
                        (a, b) =>
                            (a.updatedAt || a.createdAt || 0) -
                            (b.updatedAt || b.createdAt || 0),
                    )
                    .slice(-12);

                const seededFeed = [...seededJobs]
                    .reverse()
                    .map((job) =>
                        makeJobFeedItem(
                            job,
                            job.updatedAt || job.createdAt || Date.now(),
                            `seed-feed-${job.id}`,
                        ),
                    );
                const seededTerminal = seededJobs.map((job) =>
                    makeJobEventLine(
                        job,
                        job.updatedAt || job.createdAt || Date.now(),
                        `seed-log-${job.id}`,
                    ),
                );

                setFeedItems((prev) => (prev.length > 0 ? prev : seededFeed));
                setTerminalLines((prev) =>
                    prev.length > 0 ? prev : seededTerminal,
                );
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEventStream(
        (type, data) => {
            const now = Date.now();

            if (type === "job.created" || type === "job.update") {
                const job = data as Job;
                setJobs((prev) => ({
                    ...prev,
                    [job.id]: { ...prev[job.id], ...job },
                }));

                const signature = buildJobSignature(job);
                const previousSignature = jobFeedSignatureRef.current.get(
                    job.id,
                );
                const shouldRecord =
                    type === "job.created" || previousSignature !== signature;
                jobFeedSignatureRef.current.set(job.id, signature);

                if (shouldRecord) {
                    upsertJobFeedItem(
                        makeJobFeedItem(
                            job,
                            job.updatedAt || now,
                            `feed-${nextId()}`,
                        ),
                    );
                    appendTerminalLine(
                        makeJobEventLine(
                            job,
                            job.updatedAt || now,
                            `event-${nextId()}`,
                        ),
                    );
                }
                return;
            }

            if (type === "job.log") {
                const event = data as JobLogEvent;
                const line = String(event?.line || "").trim();
                if (!line) return;
                appendTerminalLine({
                    id: `job-log-${nextId()}`,
                    ts: now,
                    source: "job",
                    severity: inferLogSeverity(line, event.which),
                    text: line,
                    channel: event.which || "stdout",
                    jobId: event.id,
                });
                return;
            }

            if (type === "wrapper.login") {
                const event = data as WrapperEvent;
                const phase = String(event?.phase || "").trim();
                if (!phase) return;
                if (wrapperPhaseRef.current === phase && !event.error) return;
                wrapperPhaseRef.current = phase;
                appendFeedItem(
                    makeWrapperFeedItem(event, now, `wrapper-feed-${nextId()}`),
                );
                appendTerminalLine(
                    makeWrapperEventLine(
                        event,
                        now,
                        `wrapper-event-${nextId()}`,
                    ),
                );
                return;
            }

            if (type === "wrapper.login.log") {
                const event = data as WrapperLogEvent;
                const line = String(event?.line || "").trim();
                if (!line) return;
                appendTerminalLine({
                    id: `wrapper-log-${nextId()}`,
                    ts: now,
                    source: "wrapper",
                    severity: inferLogSeverity(line),
                    text: line,
                    channel: "stdout",
                });
                return;
            }

            if (type === "following.check") {
                const event = data as FollowingCheckEvent;
                appendFeedItem(
                    makeFollowingCheckFeedItem(
                        event,
                        now,
                        `following-feed-${nextId()}`,
                    ),
                );
                appendTerminalLine(
                    makeFollowingCheckLine(
                        event,
                        now,
                        `following-event-${nextId()}`,
                    ),
                );
                return;
            }

            if (type === "following.download") {
                const event = data as FollowingDownloadEvent;
                appendFeedItem(
                    makeFollowingDownloadFeedItem(
                        event,
                        now,
                        `following-download-feed-${nextId()}`,
                    ),
                );
                appendTerminalLine(
                    makeFollowingDownloadLine(
                        event,
                        now,
                        `following-download-event-${nextId()}`,
                    ),
                );
                return;
            }

            if (type === "following.updated") {
                const event = data as FollowingUpdatedEvent;
                if (!event.artistId) return;
                setFollowingState((prev) => ({
                    ...prev,
                    [event.artistId as string]: {
                        missingReleaseCount:
                            typeof event.missingReleaseCount === "number"
                                ? event.missingReleaseCount
                                : (prev[event.artistId as string]
                                      ?.missingReleaseCount ?? 0),
                        totalReleaseCount:
                            typeof event.totalReleaseCount === "number"
                                ? event.totalReleaseCount
                                : prev[event.artistId as string]
                                      ?.totalReleaseCount,
                        releaseScope:
                            event.releaseScope ||
                            prev[event.artistId as string]?.releaseScope,
                        unfollowed: event.followed === false ? true : false,
                        updatedAt: now,
                    },
                }));
                return;
            }

            if (type === "playlist-following.check") {
                const event = data as PlaylistFollowingCheckEvent;
                appendFeedItem(
                    makePlaylistFollowingCheckFeedItem(
                        event,
                        now,
                        `playlist-following-feed-${nextId()}`,
                    ),
                );
                appendTerminalLine(
                    makePlaylistFollowingCheckLine(
                        event,
                        now,
                        `playlist-following-event-${nextId()}`,
                    ),
                );
                return;
            }

            if (type === "playlist-following.download") {
                const event = data as PlaylistFollowingDownloadEvent;
                appendFeedItem(
                    makePlaylistFollowingDownloadFeedItem(
                        event,
                        now,
                        `playlist-following-download-feed-${nextId()}`,
                    ),
                );
                appendTerminalLine(
                    makePlaylistFollowingDownloadLine(
                        event,
                        now,
                        `playlist-following-download-event-${nextId()}`,
                    ),
                );
                return;
            }

            if (type === "playlist-following.updated") {
                const event = data as PlaylistFollowingUpdatedEvent;
                if (!event.playlistId) return;
                const playlistId = event.playlistId;
                if (event.followed === false) {
                    setPlaylistFollowingState((prev) => ({
                        ...prev,
                        [playlistId]: {
                            ...prev[playlistId],
                            unfollowed: true,
                            updatedAt: now,
                        },
                    }));
                    return;
                }
                setPlaylistFollowingState((prev) => ({
                    ...prev,
                    [playlistId]: {
                        totalTrackCount:
                            typeof event.totalTrackCount === "number"
                                ? event.totalTrackCount
                                : prev[playlistId]?.totalTrackCount,
                        missingTrackCount:
                            typeof event.missingTrackCount === "number"
                                ? event.missingTrackCount
                                : prev[playlistId]?.missingTrackCount,
                        undownloadableTrackCount:
                            typeof event.undownloadableTrackCount === "number"
                                ? event.undownloadableTrackCount
                                : prev[playlistId]?.undownloadableTrackCount,
                        unfollowed: false,
                        updatedAt: now,
                    },
                }));
                return;
            }

            if (type === "wrapper.stall.suspected") {
                const event = data as WrapperStallEvent;
                const idleSec = Math.round((event.idleMs || 0) / 1000);
                const aborting = event.phase === "aborting";
                const title = aborting
                    ? "Wrapper stalled — aborting job"
                    : "Wrapper appears stalled";
                const detailParts = [
                    event.albumTitle && `${event.albumTitle}`,
                    event.currentTrack && `track: ${event.currentTrack}`,
                    `${idleSec}s without output`,
                    event.lastLine && `last: ${event.lastLine.slice(0, 140)}`,
                ].filter(Boolean) as string[];
                appendFeedItem({
                    id: `wrapper-stall-feed-${nextId()}`,
                    ts: now,
                    source: "wrapper",
                    severity: aborting ? "error" : "warning",
                    title,
                    detail: detailParts.join(" · "),
                    jobId: event.jobId,
                });
                appendTerminalLine({
                    id: `wrapper-stall-event-${nextId()}`,
                    ts: now,
                    source: "wrapper",
                    severity: aborting ? "error" : "warning",
                    text: `[wrapper] ${title}${detailParts.length ? ` · ${detailParts.join(" · ")}` : ""}`,
                    channel: "event",
                    jobId: event.jobId,
                });
            }
        },
        {
            onStatusChange: (status) => setStreamStatus(status),
        },
    );

    const jobsList = useMemo(
        () =>
            Object.values(jobs).sort(
                (a, b) =>
                    (b.updatedAt || b.createdAt || 0) -
                    (a.updatedAt || a.createdAt || 0),
            ),
        [jobs],
    );

    const activeJobs = useMemo(
        () =>
            jobsList.filter(
                (job) => job.status === "queued" || job.status === "running",
            ),
        [jobsList],
    );

    const recentFailures = useMemo(
        () => jobsList.filter((job) => job.status === "failed").slice(0, 8),
        [jobsList],
    );

    const latestEventAt =
        feedItems[0]?.ts || terminalLines[terminalLines.length - 1]?.ts || null;

    return {
        loading,
        streamStatus,
        feedItems,
        terminalLines,
        jobs: jobsList,
        activeJobs,
        recentFailures,
        latestEventAt,
        followingState,
        playlistFollowingState,
    };
}

function buildJobSignature(job: Job) {
    return [
        job.status,
        job.message || "",
        job.error || "",
        job.currentTrack || "",
        Math.round(Number(job.progress || 0)),
    ].join("::");
}

function makeJobFeedItem(job: Job, ts: number, id: string): ActivityFeedItem {
    const label = jobLabel(job);
    const importedTitle =
        job.kind === "song"
            ? "Track imported"
            : job.kind === "playlist"
              ? "Playlist imported"
              : "Album imported";
    const queuedTitle =
        job.kind === "song"
            ? "Queued track import"
            : job.kind === "playlist"
              ? "Queued playlist import"
              : "Queued album import";
    if (job.status === "done") {
        return {
            id,
            ts,
            source: "job",
            severity: "success",
            title: importedTitle,
            detail: `${label}${job.message ? ` · ${job.message}` : ""}`,
            jobId: job.id,
            jobStatus: job.status,
            progress: job.progress,
        };
    }

    if (job.status === "failed") {
        return {
            id,
            ts,
            source: "job",
            severity: "error",
            title: "Import failed",
            detail: `${label}${job.error ? ` · ${job.error}` : job.message ? ` · ${job.message}` : ""}`,
            jobId: job.id,
            jobStatus: job.status,
            progress: job.progress,
        };
    }

    if (job.status === "running") {
        return {
            id,
            ts,
            source: "job",
            severity: "info",
            title: job.message || "Download in progress",
            detail: `${label}${job.currentTrack ? ` · ${job.currentTrack}` : ""}`,
            jobId: job.id,
            jobStatus: job.status,
            progress: job.progress,
        };
    }

    return {
        id,
        ts,
        source: "job",
        severity: "warning",
        title: queuedTitle,
        detail: label,
        jobId: job.id,
        jobStatus: job.status,
        progress: job.progress,
    };
}

function makeJobEventLine(
    job: Job,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const label = jobLabel(job);
    const text =
        job.status === "done"
            ? `[job] imported ${label}${job.message ? ` · ${job.message}` : ""}`
            : job.status === "failed"
              ? `[job] failed ${label}${job.error ? ` · ${job.error}` : job.message ? ` · ${job.message}` : ""}`
              : job.status === "running"
                ? `[job] running ${label}${job.message ? ` · ${job.message}` : ""}`
                : `[job] queued ${label}`;

    return {
        id,
        ts,
        source: "job",
        severity:
            job.status === "done"
                ? "success"
                : job.status === "failed"
                  ? "error"
                  : job.status === "queued"
                    ? "warning"
                    : "info",
        text,
        channel: "event",
        jobId: job.id,
    };
}

function makeWrapperFeedItem(
    event: WrapperEvent,
    ts: number,
    id: string,
): ActivityFeedItem {
    const phase = String(event.phase || "").trim();
    return {
        id,
        ts,
        source: "wrapper",
        severity: wrapperSeverity(phase, event.error),
        title: wrapperTitle(phase),
        detail: event.error || wrapperDetail(phase),
    };
}

function makeWrapperEventLine(
    event: WrapperEvent,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const phase = String(event.phase || "").trim();
    return {
        id,
        ts,
        source: "wrapper",
        severity: wrapperSeverity(phase, event.error),
        text: `[wrapper] ${wrapperTitle(phase)}${event.error ? ` · ${event.error}` : ""}`,
        channel: "event",
    };
}

function makeFollowingCheckFeedItem(
    event: FollowingCheckEvent,
    ts: number,
    id: string,
): ActivityFeedItem {
    return {
        id,
        ts,
        source: "system",
        severity: followingCheckSeverity(event),
        title: followingCheckTitle(event),
        detail: followingCheckDetail(event),
    };
}

function makeFollowingCheckLine(
    event: FollowingCheckEvent,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const detail = followingCheckDetail(event);
    return {
        id,
        ts,
        source: "system",
        severity: followingCheckSeverity(event),
        text: `[following] ${followingCheckTitle(event)}${detail ? ` · ${detail}` : ""}`,
        channel: "event",
    };
}

function makeFollowingDownloadFeedItem(
    event: FollowingDownloadEvent,
    ts: number,
    id: string,
): ActivityFeedItem {
    const failed = Boolean(event.error);
    return {
        id,
        ts,
        source: "system",
        severity: failed ? "error" : "success",
        title: failed ? "Auto-download failed" : "Auto-download triggered",
        detail: `${event.artistName || "Followed artist"} — ${event.albumTitle || "New release"}${event.error ? ` · ${event.error}` : ""}`,
    };
}

function makeFollowingDownloadLine(
    event: FollowingDownloadEvent,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const failed = Boolean(event.error);
    return {
        id,
        ts,
        source: "system",
        severity: failed ? "error" : "success",
        text: `[following] ${failed ? "failed" : "queued"} ${event.artistName || "Followed artist"} — ${event.albumTitle || "New release"}${event.error ? ` · ${event.error}` : ""}`,
        channel: "event",
    };
}

function makePlaylistFollowingCheckFeedItem(
    event: PlaylistFollowingCheckEvent,
    ts: number,
    id: string,
): ActivityFeedItem {
    return {
        id,
        ts,
        source: "system",
        severity: playlistFollowingCheckSeverity(event),
        title: playlistFollowingCheckTitle(event),
        detail: playlistFollowingCheckDetail(event),
    };
}

function makePlaylistFollowingCheckLine(
    event: PlaylistFollowingCheckEvent,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const detail = playlistFollowingCheckDetail(event);
    return {
        id,
        ts,
        source: "system",
        severity: playlistFollowingCheckSeverity(event),
        text: `[playlist-following] ${playlistFollowingCheckTitle(event)}${detail ? ` · ${detail}` : ""}`,
        channel: "event",
    };
}

function makePlaylistFollowingDownloadFeedItem(
    event: PlaylistFollowingDownloadEvent,
    ts: number,
    id: string,
): ActivityFeedItem {
    const failed = Boolean(event.error);
    return {
        id,
        ts,
        source: "system",
        severity: failed ? "error" : "success",
        title: failed
            ? "Playlist auto-download failed"
            : "Playlist auto-download triggered",
        detail: `${event.playlistName || "Followed playlist"} — ${event.artistName || "Unknown artist"} · ${event.trackName || "New track"}${event.error ? ` · ${event.error}` : ""}`,
    };
}

function makePlaylistFollowingDownloadLine(
    event: PlaylistFollowingDownloadEvent,
    ts: number,
    id: string,
): ActivityTerminalLine {
    const failed = Boolean(event.error);
    return {
        id,
        ts,
        source: "system",
        severity: failed ? "error" : "success",
        text: `[playlist-following] ${failed ? "failed" : "queued"} ${event.trackName || "New track"} from ${event.playlistName || "followed playlist"}${event.error ? ` · ${event.error}` : ""}`,
        channel: "event",
    };
}

function playlistFollowingCheckSeverity(
    event: PlaylistFollowingCheckEvent,
): ActivitySeverity {
    if (event.phase === "failed" || event.phase === "playlist-failed")
        return "error";
    if (event.phase === "skipped") return "warning";
    if (event.phase === "completed") return event.queued ? "success" : "info";
    return "info";
}

function playlistFollowingCheckTitle(event: PlaylistFollowingCheckEvent) {
    if (event.phase === "started") return "Syncing followed playlists";
    if (event.phase === "completed") return "Followed playlists synced";
    if (event.phase === "skipped") return "Auto-downloads paused";
    if (event.phase === "playlist-started")
        return `Syncing ${event.playlistName || "playlist"}`;
    if (event.phase === "playlist-completed")
        return `Synced ${event.playlistName || "playlist"}`;
    if (event.phase === "playlist-failed")
        return `Sync failed for ${event.playlistName || "playlist"}`;
    if (event.phase === "failed") return "Playlist sync failed";
    return "Followed playlist event";
}

function playlistFollowingCheckDetail(event: PlaylistFollowingCheckEvent) {
    if (event.message) return event.message;
    if (event.phase === "started") {
        return `${event.playlists || 0} due of ${event.totalPlaylists || 0} followed playlists`;
    }
    if (event.phase === "completed") {
        return `${event.discovered || 0} new tracks found · ${event.queued || 0} queued`;
    }
    if (event.phase === "playlist-completed") {
        return `${event.discovered || 0} found · ${event.queued || 0} queued`;
    }
    return undefined;
}

function wrapperSeverity(
    phase: string,
    error?: string | null,
): ActivitySeverity {
    if (error || phase === "failed") return "error";
    if (phase === "ready") return "success";
    if (phase === "2fa-required") return "warning";
    return "info";
}

function followingCheckSeverity(event: FollowingCheckEvent): ActivitySeverity {
    if (event.phase === "failed") return "error";
    if (event.phase === "skipped") return "warning";
    if (event.phase === "completed") return event.queued ? "success" : "info";
    return "info";
}

function followingCheckTitle(event: FollowingCheckEvent) {
    if (event.phase === "started") return "Checking followed artists";
    if (event.phase === "completed") return "Followed artists checked";
    if (event.phase === "skipped") return "Auto-downloads paused";
    if (event.phase === "artist-started")
        return `Checking ${event.artistName || "artist"}`;
    if (event.phase === "artist-completed")
        return `Checked ${event.artistName || "artist"}`;
    if (event.phase === "failed") return "Followed artist check failed";
    return "Followed artist event";
}

function followingCheckDetail(event: FollowingCheckEvent) {
    if (event.message) return event.message;
    if (event.phase === "started") {
        return `${event.artists || 0} due of ${event.totalArtists || 0} followed artists`;
    }
    if (event.phase === "completed") {
        return `${event.discovered || 0} new releases found · ${event.queued || 0} queued`;
    }
    if (event.phase === "artist-completed") {
        return `${event.discovered || 0} found · ${event.queued || 0} queued`;
    }
    return undefined;
}

function wrapperTitle(phase: string) {
    if (phase === "preparing") return "Preparing sign-in";
    if (phase === "creating") return "Creating wrapper session";
    if (phase === "signing-in") return "Signing in to Apple Music";
    if (phase === "2fa-required") return "Waiting for 2FA code";
    if (phase === "verifying-2fa") return "Verifying 2FA code";
    if (phase === "starting-main") return "Starting wrapper services";
    if (phase === "ready") return "Wrapper ready";
    if (phase === "failed") return "Wrapper sign-in failed";
    return "Wrapper event";
}

function wrapperDetail(phase: string) {
    if (phase === "2fa-required") {
        return "Check your trusted Apple device and enter the code in Settings.";
    }
    if (phase === "ready") {
        return "Apple Music backend services are authenticated and ready.";
    }
    return undefined;
}

function inferLogSeverity(line: string, channel?: string): ActivitySeverity {
    const lower = line.toLowerCase();
    if (
        channel === "stderr" ||
        /error|failed|forbidden|timed out|disabled|locked|panic|fatal/.test(
            lower,
        )
    ) {
        return "error";
    }
    if (/success|ready|imported|done|cached successfully/.test(lower)) {
        return "success";
    }
    if (
        /queued|waiting|preparing|starting|verifying|moving|converting/.test(
            lower,
        )
    ) {
        return "warning";
    }
    return "info";
}

function jobLabel(job: Job) {
    return `${job.artist} — ${stripYear(job.albumTitle)}`;
}
