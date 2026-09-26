import type { HealthReport } from '../api/client'
import { cx } from '../lib/cx'
import { Badge } from './Badge'

type Props = {
  health: HealthReport | null
  loading: boolean
  variant?: 'default' | 'shell'
}

export function HealthPill({ health, loading, variant = 'default' }: Props) {
  const shellClass = variant === 'shell' ? 'h-10 px-3.5 text-[0.8125rem] leading-none group-hover:text-accent group-hover:border-[rgba(var(--accent),0.3)] group-hover:bg-[rgba(var(--accent),0.12)]' : ''
  if (loading || !health) {
    return <Badge className={shellClass}>Checking…</Badge>
  }
  if (health.ok) {
    if (health.wrapper?.stallRecent) {
      return (
        <Badge
          variant="warn"
          className={shellClass}
          title="Download wrapper stalled and was auto-recovered."
        >
          ● Recovered
        </Badge>
      )
    }
    return <Badge variant="ok" className={shellClass}>● Ready</Badge>
  }
  const wrapperDown = isWrapperDown(health)
  const pause = wrapperDown ? wrapperPause(health) : null
  let label = 'Issue'
  let title = 'Something is not ready'
  if (pause) {
    label = pause.label
    title = pause.title
  } else if (wrapperDown) {
    label = 'Sign in required'
    title = 'Apple Music wrapper is offline — add credentials in Settings.'
  } else if (!health.appleToken?.ok) {
    label = 'Apple token'
    title = 'Could not fetch the public Apple Music bearer token.'
  } else if (!health.music?.ok) {
    label = 'Music folder'
    title = 'Music output folder is not writable.'
  } else {
    const partial: string[] = []
    if (!health.wrapper?.decrypt?.ok) partial.push('decrypt')
    if (!health.wrapper?.m3u8?.ok) partial.push('m3u8')
    if (!health.wrapper?.account?.ok) partial.push('account')
    label = `Wrapper: ${partial.join(', ')}`
    title = label
  }
  return (
    <Badge
      variant="warn"
      className={cx('max-w-[260px] truncate', shellClass)}
      title={title}
    >
      ● {label}
    </Badge>
  )
}

function isWrapperDown(health: HealthReport): boolean {
  return (
    !health.wrapper?.decrypt?.ok &&
    !health.wrapper?.m3u8?.ok &&
    !health.wrapper?.account?.ok
  )
}

// The ports are also closed while the supervisor restarts the wrapper, or
// waits because another device took the Apple Music stream; neither needs a
// new sign-in.
function wrapperPause(health: HealthReport): { label: string; title: string } | null {
  const sup = health.wrapper?.supervisor
  if (!sup) return null
  if (sup.reason === 'lease_lost') {
    const mins = Math.max(1, Math.ceil((sup.restartInMs ?? 0) / 60_000))
    return {
      label: 'Paused',
      title: `Apple Music is playing on another device with this account. The wrapper resumes in about ${mins} min, or right away when a download starts.`,
    }
  }
  if (sup.running || sup.restartInMs != null) {
    return { label: 'Wrapper restarting', title: 'The Apple Music wrapper is starting up.' }
  }
  return null
}

function needsSignIn(health: HealthReport): boolean {
  return isWrapperDown(health) && !wrapperPause(health)
}

export function getHealthPillTarget(health: HealthReport | null): string {
  if (!health) return '/status'
  return needsSignIn(health) ? '/settings' : '/status'
}

export function getHealthPillAriaLabel(health: HealthReport | null): string {
  if (!health) return 'Open status'
  return needsSignIn(health) ? 'Open settings' : 'Open status'
}
