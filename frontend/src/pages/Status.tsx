import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

import type { HealthReport } from '../api/client'
import { Badge } from '../components/Badge'
import { Card } from '../components/Card'
import { ProgressBar } from '../components/ProgressBar'
import { formatPercent } from '../lib/format'
import {
  useActivityFeed,
  type ActivityFeedItem,
  type ActivitySeverity,
  type ActivityTerminalLine,
} from '../hooks/useActivityFeed'
import { useHealth } from '../hooks/useHealth'

export function StatusPage() {
  const { health, loading: healthLoading } = useHealth(10000)
  const {
    loading,
    streamStatus,
    feedItems,
    terminalLines,
    activeJobs,
    recentFailures,
    latestEventAt,
  } = useActivityFeed()
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const [followLogs, setFollowLogs] = useState(true)

  useEffect(() => {
    const node = terminalRef.current
    if (!node || !followLogs) return
    node.scrollTop = node.scrollHeight
  }, [followLogs, terminalLines.length])

  const healthRows = useMemo(() => buildHealthRows(health), [health])

  const handleTerminalScroll = () => {
    const node = terminalRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    setFollowLogs(distanceFromBottom < 48)
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 pt-4 md:pt-6">
      <section className="space-y-3">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Status
          </h1>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Backend stream"
          value={streamLabel(streamStatus)}
          detail={
            latestEventAt
              ? `Last event ${formatRelativeTime(latestEventAt)}`
              : 'No events yet'
          }
          tone={streamTone(streamStatus)}
          icon={
            streamStatus === 'open' ? CheckCircle2 : streamStatus === 'reconnecting' ? RefreshCw : Loader2
          }
          spin={streamStatus !== 'open'}
        />
        <MetricCard
          label="Active jobs"
          value={String(activeJobs.length)}
          detail={
            activeJobs[0]?.message ||
            activeJobs[0]?.currentTrack ||
            (activeJobs.length > 0 ? 'Downloads are currently running' : 'No active jobs')
          }
          tone={activeJobs.length > 0 ? 'info' : 'success'}
          icon={activeJobs.length > 0 ? Loader2 : CheckCircle2}
          spin={activeJobs.length > 0}
        />
        <MetricCard
          label="Recent failures"
          value={String(recentFailures.length)}
          detail={recentFailures[0]?.error || 'No recent failed jobs'}
          tone={recentFailures.length > 0 ? 'error' : 'success'}
          icon={recentFailures.length > 0 ? AlertCircle : CheckCircle2}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <Activity className="h-4 w-4 text-accent" />
                System health
              </div>
            </div>
            <div className="grid gap-2 px-5 py-4">
              {healthLoading || !health ? (
                <div className="text-sm text-white/55">Checking system status…</div>
              ) : (
                healthRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-3 rounded-[18px] border border-white/[0.05] bg-white/[0.025] px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {row.ok ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                      )}
                      <span className="truncate text-sm text-white/80">{row.label}</span>
                    </div>
                    {!row.ok && (
                      <span className="max-w-[48%] truncate text-right text-xs text-rose-300/90">
                        {row.hint || row.error || 'Unavailable'}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <Loader2 className="h-4 w-4 text-accent" />
                Active work
              </div>
            </div>
            <div className="space-y-3 px-5 py-4">
              {loading ? (
                <div className="text-sm text-white/55">Loading recent job state…</div>
              ) : activeJobs.length === 0 ? (
                <div className="rounded-[18px] border border-white/[0.05] bg-white/[0.025] px-4 py-4 text-sm text-white/55">
                  No active jobs.
                </div>
              ) : (
                activeJobs.slice(0, 6).map((job) => (
                  <div
                    key={job.id}
                    className="rounded-[18px] border border-white/[0.05] bg-white/[0.025] px-4 py-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-white/85">
                          {job.artist} — {job.albumTitle}
                        </div>
                        <div className="mt-1 truncate text-xs text-white/55">
                          {job.message || job.currentTrack || (job.status === 'queued' ? 'Queued' : 'Running')}
                        </div>
                      </div>
                      <Badge variant={job.status === 'queued' ? 'warn' : 'accent'}>
                        {job.status === 'queued' ? 'Queued' : 'Running'}
                      </Badge>
                    </div>
                    <div className="mt-3">
                      <ProgressBar value={job.progress} label={formatPercent(job.progress)} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Activity feed</h2>
              </div>
              <Badge
                variant={feedItems[0]?.severity === 'error' ? 'bad' : 'accent'}
                className="whitespace-nowrap text-[0.6875rem] md:text-xs"
              >
                {feedItems.length} events
              </Badge>
            </div>

            {feedItems.length === 0 ? (
              <Card className="p-6 text-sm text-white/55">
                No activity yet.
              </Card>
            ) : (
              <AnimatePresence initial={false}>
                <div className="space-y-3">
                  {feedItems.map((item) => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                    >
                      <FeedCard item={item} />
                    </motion.div>
                  ))}
                </div>
              </AnimatePresence>
            )}
          </section>
        </div>

        <div className="self-start xl:sticky xl:top-24">
          <Card className="overflow-hidden border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.025))]">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-rose-400/90 shadow-[0_0_18px_rgba(251,113,133,0.35)]" />
                    <span className="h-3 w-3 rounded-full bg-amber-300/90 shadow-[0_0_18px_rgba(252,211,77,0.32)]" />
                    <span className="h-3 w-3 rounded-full bg-emerald-400/90 shadow-[0_0_18px_rgba(74,222,128,0.34)]" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white/85">Backend log</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!followLogs && (
                    <button
                      type="button"
                      onClick={() => {
                        setFollowLogs(true)
                        if (terminalRef.current) {
                          terminalRef.current.scrollTop = terminalRef.current.scrollHeight
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/75 transition-colors duration-[200ms] ease-smooth hover:border-[rgba(var(--accent),0.25)] hover:bg-[rgba(var(--accent),0.12)] hover:text-[rgb(var(--accent))]"
                    >
                      <span className="md:hidden">Latest</span>
                      <span className="hidden md:inline">Jump to latest</span>
                    </button>
                  )}
                  <Badge variant={streamStatus === 'open' ? 'ok' : streamStatus === 'reconnecting' ? 'warn' : 'accent'}>
                    {streamLabel(streamStatus)}
                  </Badge>
                </div>
              </div>
            </div>

            <div
              ref={terminalRef}
              onScroll={handleTerminalScroll}
              className="h-[min(68vh,760px)] overflow-y-auto bg-black/20 px-3 py-3 font-mono text-[0.8125rem] leading-6"
            >
              {terminalLines.length === 0 ? (
                <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-white/45">
                  Waiting for backend events.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {terminalLines.map((line) => (
                    <div
                      key={line.id}
                      className="rounded-[16px] border border-transparent px-3 py-2 transition-colors duration-200 hover:border-white/[0.05] hover:bg-white/[0.03]"
                    >
                      <div className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-[0.08em] text-white/35">
                        <span>{formatClockTime(line.ts)}</span>
                        <span className={channelClassName(line)}>{line.channel}</span>
                        <span className={sourceClassName(line.source)}>{line.source}</span>
                      </div>
                      <div className={severityClassName(line.severity)}>{line.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </section>
    </div>
  )
}

type MetricCardProps = {
  label: string
  value: string
  detail: string
  tone: ActivitySeverity | 'success'
  icon: React.ComponentType<{ className?: string }>
  spin?: boolean
}

function MetricCard({ label, value, detail, tone, icon: Icon, spin = false }: MetricCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-white/50">{label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-white">
            {value}
          </div>
          <div className="mt-2 text-sm text-white/55">{detail}</div>
        </div>
        <div className={metricIconClassName(tone)}>
          <Icon className={spin ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </div>
      </div>
    </Card>
  )
}

function FeedCard({ item }: { item: ActivityFeedItem }) {
  return (
    <Card className={feedCardClassName(item.severity)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={feedDotClassName(item.severity)} />
            <h3 className="truncate text-sm font-medium text-white/88">{item.title}</h3>
          </div>
          {item.detail && (
            <div className="mt-2 text-sm text-white/60">{item.detail}</div>
          )}
          {(item.jobStatus === 'queued' || item.jobStatus === 'running') &&
            typeof item.progress === 'number' &&
            item.progress > 0 &&
            item.progress < 100 && (
            <div className="mt-3 max-w-sm">
              <ProgressBar value={item.progress} label={formatPercent(item.progress)} />
            </div>
          )}
        </div>
        <div className="shrink-0 text-xs text-white/35">{formatRelativeTime(item.ts)}</div>
      </div>
    </Card>
  )
}

function buildHealthRows(health: HealthReport | null) {
  if (!health) return []

  const wrapperAllDown =
    !health.wrapper.decrypt.ok &&
    !health.wrapper.m3u8.ok &&
    !health.wrapper.account.ok

  const items: Array<{ label: string; ok: boolean; error?: string | null; hint?: string }> = [
    {
      label: 'Apple Music token',
      ok: health.appleToken.ok,
      error: health.appleToken.error,
    },
  ]

  if (wrapperAllDown) {
    items.push({
      label: 'Apple Music wrapper',
      ok: false,
      hint: 'Offline. Re-authenticate in Settings to bring the wrapper back.',
    })
  } else {
    items.push(
      {
        label: 'Decryption wrapper',
        ok: health.wrapper.decrypt.ok,
        error: health.wrapper.decrypt.error,
      },
      {
        label: 'M3U8 stream service',
        ok: health.wrapper.m3u8.ok,
        error: health.wrapper.m3u8.error,
      },
      {
        label: 'Account service',
        ok: health.wrapper.account.ok,
        error: health.wrapper.account.error,
      },
    )
  }

  items.push({
    label: `Music path (${health.music.path})`,
    ok: health.music.ok,
    error: health.music.error,
  })

  return items
}

function streamLabel(status: 'connecting' | 'open' | 'reconnecting') {
  if (status === 'open') return 'Live'
  if (status === 'reconnecting') return 'Reconnecting'
  return 'Connecting'
}

function streamTone(status: 'connecting' | 'open' | 'reconnecting'): ActivitySeverity | 'success' {
  if (status === 'open') return 'success'
  if (status === 'reconnecting') return 'warning'
  return 'info'
}

function metricIconClassName(tone: ActivitySeverity | 'success') {
  if (tone === 'success') {
    return 'flex h-10 w-10 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
  }
  if (tone === 'error') {
    return 'flex h-10 w-10 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/15 text-rose-300'
  }
  if (tone === 'warning') {
    return 'flex h-10 w-10 items-center justify-center rounded-full border border-amber-400/30 bg-amber-500/15 text-amber-200'
  }
  return 'flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(var(--accent),0.3)] bg-[rgba(var(--accent),0.14)] text-[rgb(var(--accent))]'
}

function feedCardClassName(severity: ActivitySeverity) {
  if (severity === 'success') {
    return 'border-emerald-400/15 bg-emerald-500/[0.06] p-4'
  }
  if (severity === 'error') {
    return 'border-rose-400/15 bg-rose-500/[0.05] p-4'
  }
  if (severity === 'warning') {
    return 'border-amber-400/15 bg-amber-500/[0.05] p-4'
  }
  return 'border-[rgba(var(--accent),0.16)] bg-[rgba(var(--accent),0.05)] p-4'
}

function feedDotClassName(severity: ActivitySeverity) {
  if (severity === 'success') return 'h-2.5 w-2.5 rounded-full bg-emerald-400'
  if (severity === 'error') return 'h-2.5 w-2.5 rounded-full bg-rose-400'
  if (severity === 'warning') return 'h-2.5 w-2.5 rounded-full bg-amber-300'
  return 'h-2.5 w-2.5 rounded-full bg-[rgb(var(--accent))]'
}

function severityClassName(severity: ActivitySeverity) {
  if (severity === 'success') return 'break-words text-emerald-200/95'
  if (severity === 'error') return 'break-words text-rose-200/95'
  if (severity === 'warning') return 'break-words text-amber-100/92'
  return 'break-words text-white/82'
}

function channelClassName(line: ActivityTerminalLine) {
  if (line.channel === 'stderr') return 'text-rose-300/80'
  if (line.channel === 'stdout') return 'text-white/35'
  return 'text-[rgb(var(--accent))]'
}

function sourceClassName(source: ActivityTerminalLine['source']) {
  if (source === 'wrapper') return 'text-amber-100/70'
  if (source === 'job') return 'text-white/45'
  return 'text-white/35'
}

function formatRelativeTime(ts: number) {
  const diff = Date.now() - ts
  if (diff < 10_000) return 'just now'
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return formatClockTime(ts)
}

function formatClockTime(ts: number) {
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ts)
}
