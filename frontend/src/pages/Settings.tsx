import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Lock,
  Key,
  Globe,
  FolderOpen,
  Radar,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

import { api, type EffectiveCheckInterval, type PublicSettings } from '../api/client'
import { setAppSettingsCache } from '../hooks/useAppSettings'
import { useEventStream } from '../hooks/useEventStream'

import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Modal } from '../components/Modal'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { cx } from '../lib/cx'


const isFake = true

const STOREFRONTS = [
  ['us', 'United States'],
  ['gb', 'United Kingdom'],
  ['de', 'Germany'],
  ['fr', 'France'],
  ['jp', 'Japan'],
  ['ca', 'Canada'],
  ['au', 'Australia'],
  ['it', 'Italy'],
  ['es', 'Spain'],
  ['nl', 'Netherlands'],
  ['pl', 'Poland'],
  ['br', 'Brazil'],
  ['mx', 'Mexico'],
  ['kr', 'South Korea'],
  ['tr', 'Turkey'],
  ['sg', 'Singapore'],
  ['in', 'India'],
  ['nz', 'New Zealand'],
  ['za', 'South Africa'],
  ['se', 'Sweden'],
  ['ch', 'Switzerland'],
  ['ie', 'Ireland'],
  ['at', 'Austria'],
  ['be', 'Belgium'],
  ['dk', 'Denmark'],
  ['no', 'Norway'],
  ['fi', 'Finland'],
  ['my', 'Malaysia'],
  ['id', 'Indonesia'],
  ['ph', 'Philippines'],
  ['tw', 'Taiwan'],
  ['hk', 'Hong Kong'],
  ['ar', 'Argentina'],
  ['cl', 'Chile'],
  ['co', 'Colombia'],
  ['ae', 'United Arab Emirates'],
  ['sa', 'Saudi Arabia'],
  ['il', 'Israel', { isFake }],
  ['vn', 'Vietnam'],
  ['gr', 'Greece'],
  ['th', 'Thailand'],
  ['eg', 'Egypt'],
] as const

const QUALITY_OPTIONS: Array<{ value: PublicSettings['quality']; label: string }> = [
  { value: 'flac', label: 'Prefer FLAC conversion' },
  { value: 'alac', label: 'Prefer ALAC' },
  { value: 'atmos', label: 'Prefer Dolby Atmos' },
  { value: 'aac', label: 'Prefer AAC' },
]

const AUTO_DOWNLOAD_FREQUENCY_OPTIONS: Array<{
  value: PublicSettings['autoDownloadCheckFrequency']
  label: string
}> = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: '1h', label: 'Every hour' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
]

export function SettingsPage() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const flashTimeoutRef = useRef<number | null>(null)

  const reload = () =>
    api
      .settings()
      .then((s) => {
        setSettings(s)
        setAppSettingsCache(s)
      })
      .catch(() => { })
  useEffect(() => {
    reload()
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) {
        window.clearTimeout(flashTimeoutRef.current)
      }
    }
  }, [])

  const update = async (patch: Partial<PublicSettings>) => {
    if (!settings) return
    setSettings({ ...settings, ...patch } as PublicSettings)
    try {
      const next = await api.saveSettings(patch)
      setSettings(next)
      setAppSettingsCache(next)
      flash('Saved')
    } catch (err: any) {
      flash(`Error: ${err.message}`, true)
    }
  }

  const flash = (msg: string, _err = false) => {
    if (flashTimeoutRef.current) {
      window.clearTimeout(flashTimeoutRef.current)
    }
    setMessage(msg)
    flashTimeoutRef.current = window.setTimeout(() => {
      setMessage(null)
      flashTimeoutRef.current = null
    }, 2500)
  }

  if (!settings) {
    return null
  }

  return (
    <>
      <AnimatePresence>
        {message && (
          <motion.div
            key="settings-flash"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
          >
            <Badge className="h-10 px-3.5 text-[0.8125rem] leading-none">
              {message}
            </Badge>
          </motion.div>
        )}
      </AnimatePresence>

      <StaggeredList className="mx-auto w-full max-w-3xl space-y-6 pt-4 md:pt-6">
        <StaggeredItem>
          <SettingsCard icon={<Lock className="h-4 w-4" />} title="Apple ID credentials">
            <AppleCredsForm
              settings={settings}
              onChange={reload}
              disabled={saving}
              setSaving={setSaving}
            />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Key className="h-4 w-4" />} title="media-user-token">
            <MediaUserTokenForm settings={settings} onChange={reload} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Globe className="h-4 w-4" />} title="Catalog">
            <div className="space-y-4">
              <label className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
                <span className="text-sm text-white/70 md:w-32">Storefront</span>
                <select
                  value={settings.storefront}
                  onChange={(e) => update({ storefront: e.target.value })}
                  className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)] md:flex-1"
                >
                  {STOREFRONTS.map((item) => {
                    const [v, label, extra] = item as any
                    return (
                      <option key={v} value={v} className="bg-zinc-900" disabled={extra?.isFake}>
                        {label} ({v.toUpperCase()})
                      </option>
                    )
                  })}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">
                  Content rating
                </span>
                <div className="md:flex-1">
                  <select
                    value={settings.explicitFilter}
                    onChange={(e) =>
                      update({
                        explicitFilter: e.target
                          .value as PublicSettings['explicitFilter'],
                      })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    <option value="explicit" className="bg-zinc-900">
                      Prefer explicit
                    </option>
                    <option value="clean" className="bg-zinc-900">
                      Prefer clean
                    </option>
                    <option value="both" className="bg-zinc-900">
                      Show both
                    </option>
                  </select>

                </div>
              </label>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<FolderOpen className="h-4 w-4" />} title="Library output">
            <div className="space-y-4">
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">Quality</span>
                <div className="md:flex-1">
                  <select
                    value={settings.quality}
                    onChange={(e) =>
                      update({ quality: e.target.value as PublicSettings['quality'] })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    {QUALITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-zinc-900">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.promptForDownloadQuality}
                  onChange={(e) => update({ promptForDownloadQuality: e.target.checked })}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                />
                <div>
                  <div className="text-sm font-medium">Ask for quality before manual downloads</div>
                  <div className="mt-1 text-sm text-white/55">
                    Keep the default quality for automatic downloads, but choose per album, song, or playlist when starting downloads yourself.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.stagingInsideMusicLibrary}
                  onChange={(e) => update({ stagingInsideMusicLibrary: e.target.checked })}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                />
                <div>
                  <div className="text-sm font-medium">Store temp staging inside music library</div>
                  <div className="mt-1 text-sm text-white/55">
                    Off (recommended): use <code>/tmp/alacarte-staging</code>. On: use hidden
                    <code> /music/.amdl-tmp</code>.
                  </div>
                </div>
              </label>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="text-sm font-medium">Naming convention</div>
                  <div className="mt-1 text-sm text-white/55">
                    Controls how track and album folder names are written. <em>Qobuz-compatible</em> strips
                    featured-artist tags and trailing &ldquo;&ndash;&nbsp;Single&rdquo; suffixes to match
                    Qobuz/Octo Fiesta naming.
                  </div>
                  <select
                    value={settings.namingConvention ?? 'apple'}
                    onChange={(e) => update({ namingConvention: e.target.value as 'apple' | 'qobuz' })}
                    className="mt-2 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]"
                  >
                    <option value="apple">Apple Music (default)</option>
                    <option value="qobuz">Qobuz-compatible</option>
                  </select>
                </div>
              </div>
              <label
                className={`flex items-start gap-3 ${settings.hasMediaUserToken ? 'cursor-pointer' : 'cursor-not-allowed'
                  }`}
              >
                <input
                  type="checkbox"
                  checked={settings.downloadLyrics}
                  onChange={(e) => update({ downloadLyrics: e.target.checked })}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!settings.hasMediaUserToken}
                />
                <div>
                  <div
                    className={`text-sm font-medium ${settings.hasMediaUserToken ? '' : 'text-white/45'
                      }`}
                  >
                    Download lyrics
                  </div>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">Lyrics format</span>
                <div className="md:flex-1">
                  <select
                    id="lyrics-format-select"
                    value={settings.lyricsFormat}
                    disabled={!settings.downloadLyrics}
                    onChange={(e) =>
                      update({ lyricsFormat: e.target.value as PublicSettings['lyricsFormat'] })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="lrc" className="bg-zinc-900">LRC — line-synced (recommended)</option>
                    <option value="ttml" className="bg-zinc-900">TTML — word/syllable sync</option>
                  </select>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">Lyrics type</span>
                <div className="md:flex-1">
                  <select
                    id="lyrics-type-select"
                    value={settings.lyricsType}
                    disabled={!settings.downloadLyrics}
                    onChange={(e) =>
                      update({ lyricsType: e.target.value as PublicSettings['lyricsType'] })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="lyrics" className="bg-zinc-900">Lyrics only</option>
                    <option value="lyrics-with-translation" className="bg-zinc-900">Lyrics + translation</option>
                  </select>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">
                  Cover size
                </span>
                <div className="md:flex-1">
                  <select
                    value={settings.coverSize}
                    onChange={(e) => update({ coverSize: e.target.value })}
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    <option value="1400x1400" className="bg-zinc-900">1400×1400 (recommended)</option>
                    <option value="2000x2000" className="bg-zinc-900">2000×2000</option>
                    <option value="3000x3000" className="bg-zinc-900">3000×3000</option>
                    <option value="5000x5000" className="bg-zinc-900">5000×5000 (max, large)</option>
                  </select>

                </div>
              </label>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Radar className="h-4 w-4" />} title="Auto-downloads">
            <div className="space-y-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.autoDownloadsEnabled}
                  onChange={(e) => update({ autoDownloadsEnabled: e.target.checked })}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                />
                <div>
                  <div className="text-sm font-medium">Enable Auto-Downloads</div>
                  <div className="mt-1 text-sm text-white/55">
                    Pause background checks without changing followed artists.
                  </div>
                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">Check frequency</span>
                <div className="md:flex-1">
                  <select
                    value={settings.autoDownloadCheckFrequency}
                    onChange={(e) =>
                      update({
                        autoDownloadCheckFrequency:
                          e.target.value as PublicSettings['autoDownloadCheckFrequency'],
                      })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    {AUTO_DOWNLOAD_FREQUENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-zinc-900">
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <EffectiveIntervalHint
                    mode={settings.autoDownloadCheckFrequency}
                  />
                </div>
              </label>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<ShieldCheck className="h-4 w-4" />} title="Account">
            <AccountSection onFlash={flash} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Globe className="h-4 w-4" />} title="Navidrome Integration">
            <NavidromeForm settings={settings} onChange={reload} onFlash={flash} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <footer className="pb-1 pt-1 text-center text-xs text-white/45">
            Built by{' '}
            <a
              href="https://github.com/sosjalapeno"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-white underline decoration-accent/50 underline-offset-2"
            >
              sosjalapeno
            </a>
          </footer>
        </StaggeredItem>
      </StaggeredList>
    </>
  )
}

function EffectiveIntervalHint({
  mode,
}: {
  mode: PublicSettings['autoDownloadCheckFrequency']
}) {
  const [data, setData] = useState<EffectiveCheckInterval | null>(null)
  useEffect(() => {
    let cancelled = false
    setData(null)
    api
      .effectiveCheckInterval(mode)
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode])
  if (!data || data.mode !== mode) return null
  if (mode === 'auto') {
    return (
      <p className="mt-2 text-xs text-white/45">
        Currently ≈ every {data.label} for {data.followedCount} followed artist
        {data.followedCount === 1 ? '' : 's'}. Adjusts automatically to keep Apple
        Music API calls under the daily safety budget.
      </p>
    )
  }
  return (
    <p className="mt-2 text-xs text-white/45">
      Each artist is checked at most once every {data.label}.
    </p>
  )
}

function SettingsCard({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="p-5 md:p-6">
      <header className="flex items-center gap-2 mb-4">
        {icon && <span className="text-accent">{icon}</span>}
        <h2 className="text-base font-semibold">{title}</h2>
      </header>
      {children}
    </Card>
  )
}

type LoginPhase =
  | 'idle'
  | 'preparing'
  | 'checking-network'
  | 'creating'
  | 'signing-in'
  | '2fa-required'
  | 'verifying-2fa'
  | 'starting-main'
  | 'ready'
  | 'failed'

function phaseLabel(p: LoginPhase): string {
  switch (p) {
    case 'preparing': return 'Preparing sign-in…'
    case 'checking-network': return 'Checking Apple service reachability…'
    case 'creating': return 'Preparing secure container…'
    case 'signing-in': return 'Signing in to Apple Music — this can take up to 90 seconds'
    case '2fa-required': return 'Waiting for your 2FA code'
    case 'verifying-2fa': return 'Verifying 2FA code…'
    case 'starting-main': return 'Starting Apple Music wrapper…'
    case 'ready': return 'Signed in successfully. Ready to download.'
    case 'failed': return 'Sign-in failed'
    default: return ''
  }
}

function AppleCredsForm({
  settings, onChange, disabled, setSaving,
}: {
  settings: PublicSettings
  onChange: () => void
  disabled: boolean
  setSaving: (b: boolean) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<LoginPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [failureTail, setFailureTail] = useState<string[]>([])
  const [showFailureTail, setShowFailureTail] = useState(false)
  const [showTwoFa, setShowTwoFa] = useState(false)

  useEventStream((type, data) => {
    if (type !== 'wrapper.login') return
    if (!data?.phase) return
    setPhase(data.phase as LoginPhase)
    if (data.phase === '2fa-required') {
      setShowTwoFa(true)
    } else if (data.phase === 'ready' || data.phase === 'failed' || data.phase === 'verifying-2fa') {
      setShowTwoFa(false)
    }
    if (data.phase === 'failed') {
      setError(data.error || 'Sign-in failed')
      setFailureTail(Array.isArray(data.tail) ? data.tail.map(String) : [])
      setShowFailureTail(false)
      setSaving(false)
    }
    if (data.phase === 'ready') {
      setError(null)
      setFailureTail([])
      setShowFailureTail(false)
      setSaving(false)
      onChange()
    }
  })

  const busy = phase !== 'idle' && phase !== 'ready' && phase !== 'failed'

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) return
    setError(null)
    setFailureTail([])
    setShowFailureTail(false)
    setPhase('preparing')
    setSaving(true)
    try {
      const r = await api.saveAppleCreds(email, password, true)
      if (!r.loginStarted) {
        setError(r.loginError || 'Could not start sign-in')
        setPhase('failed')
        setSaving(false)
        return
      }
      onChange()
    } catch (err: any) {
      setError(err?.message || 'Failed')
      setPhase('failed')
      setSaving(false)
    }
  }

  const clear = async () => {
    await api.clearAppleCreds()
    setPhase('idle')
    setError(null)
    onChange()
  }

  const retryLogin = async () => {
    setError(null)
    setPhase('preparing')
    setSaving(true)
    try {
      await api.runAppleLogin()
    } catch (err: any) {
      setError(err?.message || 'Failed')
      setPhase('failed')
      setSaving(false)
    }
  }

  const cancel = async () => {
    try {
      await api.cancelAppleLogin()
    } finally {
      setPhase('idle')
      setShowTwoFa(false)
      setSaving(false)
    }
  }

  useEffect(() => {
    if (phase === 'ready') {
      setEmail('')
      setPassword('')
    }
  }, [phase])

  const hardBlocked = Boolean(settings.hardBlockReason)

  return (
    <>
      <form className="space-y-3" onSubmit={save}>
        {hardBlocked && (
          <div className="rounded-app border border-rose-400/40 bg-rose-500/[0.08] p-4 space-y-2">
            <div className="flex items-center gap-2 text-rose-300 font-semibold">
              <AlertCircle className="h-4 w-4" />
              Apple Account locked
            </div>
            <div className="text-sm text-white/80">{settings.hardBlockReason}</div>
            <ol className="text-sm text-white/70 list-decimal pl-5 space-y-1">
              <li>
                Reset your password at{' '}
                <a href="https://iforgot.apple.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">iforgot.apple.com</a>.
              </li>
              <li>Sign in once with the new password on a trusted Apple device so Apple trusts the account again.</li>
              <li>Wait a few minutes, then come back here, click <em>Clear</em>, and enter the new credentials.</li>
            </ol>
            <p className="text-xs text-white/50">
              Retrying without doing the above will only deepen the lockout — this is Apple's anti-abuse protection, not a bug here.
            </p>
          </div>
        )}

        {settings.hasAppleCreds ? (
          <div className="text-sm text-white/70">
            Current: <span className="text-white">{settings.appleEmailMasked}</span>
          </div>
        ) : (
          <div className="text-sm text-white/55">
            No credentials stored. Enter your Apple ID used for Apple Music.
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <Input type="email" placeholder="Apple ID email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <Input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </div>
        <div className="flex gap-2 flex-wrap min-h-[40px]">
          <AnimatePresence initial={false} mode="popLayout">
            {(busy || (email && password && !hardBlocked) || !settings.hasAppleCreds) && (
              <motion.div
                key="save"
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                <Button
                  type="submit"
                  disabled={disabled || busy || !email || !password || hardBlocked}
                  title={hardBlocked ? 'Clear the lockout first' : 'Save credentials'}
                >
                  {busy ? 'Signing in…' : 'Save & sign in'}
                </Button>
              </motion.div>
            )}
            {settings.hasAppleCreds && !busy && (
              <motion.div
                key="creds-actions"
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="flex gap-2"
              >
                {!hardBlocked && <Button onClick={retryLogin}>Re-run sign in</Button>}
                <Button onClick={clear}>Clear</Button>
              </motion.div>
            )}
            {busy && (
              <motion.div
                key="cancel"
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                <Button onClick={cancel}>Cancel</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {error && (
          <Badge variant="bad" className="max-w-full">
            <span className="truncate">{error}</span>
          </Badge>
        )}
        {error && (
          <div className="-mt-1 ml-0.5 text-xs text-white/60">
            <a
              href="https://github.com/sosjalapeno/alacarte#sign-in-troubleshooting"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-accent/60 underline-offset-2 text-accent hover:text-white"
            >
              troubleshooting
            </a>
          </div>
        )}
        {phase === 'failed' && failureTail.length > 0 && (
          <div className="space-y-2 rounded-app border border-white/[0.08] bg-white/[0.02] p-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowFailureTail((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs text-white/70 hover:text-white"
              >
                {showFailureTail ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Show wrapper log
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(failureTail.join('\n'))
                  } catch { }
                }}
                className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </button>
            </div>
            {showFailureTail && (
              <pre className="max-h-52 overflow-auto rounded-app border border-white/[0.06] bg-black/35 px-3 py-2 text-[11px] leading-5 text-white/80 font-mono whitespace-pre-wrap break-words">
                {/* Backend already redacts Apple email/password to [redacted-email]/[redacted-password]. */}
                {failureTail.join('\n')}
              </pre>
            )}
          </div>
        )}
        {!error && phase !== 'idle' && phase !== 'failed' && (
          <Badge variant={phase === 'ready' ? 'ok' : 'accent'} className="max-w-full">
            <span className="truncate">{phaseLabel(phase)}</span>
          </Badge>
        )}

      </form>
      {showTwoFa && (
        <TwoFaModal onClose={() => setShowTwoFa(false)} onCancel={cancel} />
      )}
    </>
  )
}

function TwoFaModal({ onClose, onCancel }: { onClose: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const cleaned = code.replace(/\D/g, '')
    if (cleaned.length !== 6) {
      setErr('Enter the 6-digit code Apple showed on your trusted device')
      return
    }
    setErr(null)
    setSubmitting(true)
    try {
      await api.submitAppleTwoFa(cleaned)
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={true} onClose={onCancel} className="max-w-sm p-6" label="Two-factor code">
      <h3 className="text-lg font-semibold mb-1">Two-factor code</h3>
      <p className="text-sm text-white/60 mb-4">
        Apple sent a 6-digit verification code to your trusted devices.
        Enter it below to complete sign-in.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Input
          ref={inputRef}
          inputMode="numeric"
          pattern="\d*"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="••••••"
          className="tracking-[0.5em] text-center text-xl"
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
          }
          disabled={submitting}
        />
        {err && (
          <Badge variant="bad" className="max-w-full">
            <span className="truncate">{err}</span>
          </Badge>
        )}
        <div className="flex gap-2 justify-end">
          <Button onClick={onCancel} disabled={submitting}>Cancel sign-in</Button>
          <Button type="submit" disabled={submitting || code.replace(/\D/g, '').length !== 6}>
            {submitting ? 'Verifying…' : 'Verify'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function MediaUserTokenForm({ settings, onChange }: { settings: PublicSettings; onChange: () => void }) {
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    try {
      await api.saveMediaUserToken(token)
      setToken('')
      setMsg('Saved.')
      onChange()
    } catch (err: any) {
      setMsg(`Error: ${err.message}`)
    }
  }
  const clear = async () => {
    await api.clearMediaUserToken()
    setMsg('Cleared.')
    onChange()
  }

  return (
    <form className="space-y-3" onSubmit={save}>
      <div className="text-sm text-white/55">
        Required for lyrics. Grab the raw value from{' '}
        <a href="https://music.apple.com" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 decoration-accent/50 hover:text-white">music.apple.com</a>
        {' '}→ DevTools → Application → Cookies.
      </div>
      {settings.hasMediaUserToken && (
        <div className="text-sm text-emerald-400">Currently stored.</div>
      )}
      <Input type="password" placeholder="Paste media-user-token" value={token} onChange={(e) => setToken(e.target.value)} />
      <div className="flex gap-2 flex-wrap min-h-[40px]">
        <AnimatePresence initial={false} mode="popLayout">
          {token && (
            <motion.div
              key="save"
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <Button type="submit">Save token</Button>
            </motion.div>
          )}
          {settings.hasMediaUserToken && (
            <motion.div
              key="clear"
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <Button onClick={clear}>Clear</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {msg && <div className="text-xs text-white/60">{msg}</div>}
    </form>
  )
}

function NavidromeForm({ settings, onChange, onFlash }: { settings: PublicSettings; onChange: () => void; onFlash: (msg: string, err?: boolean) => void }) {
  const [enabled, setEnabled] = useState(settings.navidromeEnabled ?? false)
  const [url, setUrl] = useState(settings.navidromeUrl || 'http://navidrome:4533')
  const [user, setUser] = useState(settings.navidromeUser || '')
  const [password, setPassword] = useState('')

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const patch: any = { navidromeEnabled: enabled, navidromeUrl: url, navidromeUser: user }
      if (password) {
        patch.navidromePassword = password
      }
      await api.saveSettings(patch)
      onFlash('Saved')
      setPassword('')
      onChange()
    } catch (err: any) {
      onFlash(`Error: ${err.message}`, true)
    }
  }

  return (
    <form className="space-y-4" onSubmit={save}>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
        />
        <div>
          <div className="text-sm font-medium">Enable automatic Navidrome scan</div>
          <div className="text-xs text-white/55 mt-0.5">
            Triggers a Subsonic API scan immediately after a successful download.
          </div>
        </div>
      </label>

      {enabled && (
        <div className="space-y-3 pt-2">
          {settings.hasNavidromeCreds ? (
            <div className="text-sm text-white/70">
              Current: <span className="text-white">{settings.navidromeUser}</span>
            </div>
          ) : (
            <div className="text-sm text-white/55">
              No credentials stored. Enter your Navidrome admin credentials.
            </div>
          )}
          <Input 
            type="url" 
            placeholder="Navidrome URL" 
            value={url} 
            onChange={(e) => setUrl(e.target.value)} 
          />
          <div className="grid gap-2 md:grid-cols-2">
            <Input 
              type="text" 
              placeholder="Username" 
              autoComplete="username"
              value={user} 
              onChange={(e) => setUser(e.target.value)} 
            />
            <Input 
              type="password" 
              placeholder="Password"
              autoComplete="current-password"
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
            />
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap min-h-[40px]">
        <Button type="submit">Save Navidrome settings</Button>
      </div>
    </form>
  )
}

const PASSWORD_MIN = 12
const USERNAME_MIN = 2
const USERNAME_MAX = 32
const USERNAME_REGEX = /^[a-zA-Z0-9._-]+$/

function AccountSection({ onFlash }: { onFlash: (msg: string, err?: boolean) => void }) {
  const [username, setUsername] = useState<string | null>(null)
  const [showRevoke, setShowRevoke] = useState(false)
  const [revokePassword, setRevokePassword] = useState('')
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  useEffect(() => {
    api
      .authState()
      .then((s) => setUsername(s.username))
      .catch(() => { })
  }, [])

  return (
    <motion.div
      layout
      transition={{ layout: { type: 'spring', stiffness: 380, damping: 32 } }}
      className="space-y-6"
    >
      {username && (
        <div className="flex items-center gap-3 rounded-app border border-white/[0.06] bg-white/[0.025] px-4 py-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-[rgba(var(--accent),0.12)] border border-[rgba(var(--accent),0.25)] flex items-center justify-center text-[rgb(var(--accent))]">
            <UserIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-white/40">Signed in as</div>
            <div className="text-sm font-medium text-white truncate">{username}</div>
          </div>
        </div>
      )}

      <ChangeUsernameForm
        currentUsername={username}
        onUpdated={(name) => {
          setUsername(name)
          onFlash('Username updated')
        }}
      />

      <div className="border-t border-white/[0.06]" />

      <ChangePasswordForm onUpdated={() => onFlash('Password updated')} />

      <div className="border-t border-white/[0.06]" />

      <div className="space-y-3">
        <Button
          onClick={() => {
            setShowRevoke((v) => !v)
            setRevokeError(null)
          }}
          className="bg-white/[0.02]"
        >
          Sign out on all devices
        </Button>
        {showRevoke && (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!revokePassword || revoking) return
              setRevoking(true)
              setRevokeError(null)
              try {
                await api.authRevokeAll(revokePassword)
                setRevokePassword('')
                setShowRevoke(false)
                onFlash('Signed out on all other devices.')
              } catch (err: any) {
                setRevokeError(err?.message || 'Failed to revoke sessions')
              } finally {
                setRevoking(false)
              }
            }}
            className="space-y-2"
          >
            <Input
              type="password"
              placeholder="Current password"
              value={revokePassword}
              onChange={(e) => {
                setRevokePassword(e.target.value)
                if (revokeError) setRevokeError(null)
              }}
              autoComplete="current-password"
              disabled={revoking}
            />
            {revokeError && <div className="text-xs text-rose-300">{revokeError}</div>}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={revoking || !revokePassword}>
                {revoking ? 'Revoking…' : 'Confirm sign out everywhere'}
              </Button>
              <Button
                onClick={() => {
                  setShowRevoke(false)
                  setRevokePassword('')
                  setRevokeError(null)
                }}
                disabled={revoking}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </motion.div>
  )
}

function ChangeUsernameForm({
  currentUsername,
  onUpdated,
}: {
  currentUsername: string | null
  onUpdated: (newUsername: string) => void
}) {
  const [next, setNext] = useState('')
  const [pw, setPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = next.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < USERNAME_MIN
  const tooLong = trimmed.length > USERNAME_MAX
  const badChars = trimmed.length > 0 && !USERNAME_REGEX.test(trimmed)
  const sameAsCurrent = currentUsername != null && trimmed === currentUsername
  const valid =
    trimmed.length >= USERNAME_MIN && trimmed.length <= USERNAME_MAX && !badChars && !sameAsCurrent
  const canSubmit = !submitting && valid && pw.length > 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setErr(null)
    setSubmitting(true)
    try {
      const res = await api.authChangeUsername(pw, trimmed)
      setNext('')
      setPw('')
      onUpdated(res.username)
    } catch (e: any) {
      setErr(e?.message || 'Failed to change username')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium text-white/85">Change username</div>
      <div className="grid gap-3 md:grid-cols-2">
        <Input
          type="text"
          placeholder="New username"
          value={next}
          onChange={(e) => {
            setNext(e.target.value)
            if (err) setErr(null)
          }}
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          disabled={submitting}
          className={cx(
            (tooShort || tooLong || badChars) &&
            'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
          )}
        />
        <Input
          type="password"
          placeholder="Current password"
          value={pw}
          onChange={(e) => {
            setPw(e.target.value)
            if (err) setErr(null)
          }}
          autoComplete="current-password"
          disabled={submitting}
        />
      </div>
      <HintSlot
        hint={
          err
            ? { tone: 'error', text: err }
            : badChars
              ? { tone: 'warn', text: 'Username can use letters, digits, dots, underscores, and hyphens.' }
              : tooShort
                ? { tone: 'warn', text: `Username must be at least ${USERNAME_MIN} characters.` }
                : tooLong
                  ? { tone: 'warn', text: `Username must be no more than ${USERNAME_MAX} characters.` }
                  : sameAsCurrent
                    ? { tone: 'dim', text: 'Pick a different username to update.' }
                    : null
        }
      />
      <div>
        <Button
          type="submit"
          className={cx(!canSubmit && 'opacity-50 cursor-not-allowed pointer-events-none')}
          disabled={!canSubmit}
        >
          {submitting ? 'Saving…' : 'Change username'}
        </Button>
      </div>
    </form>
  )
}

function ChangePasswordForm({ onUpdated }: { onUpdated: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    next.length >= PASSWORD_MIN &&
    confirm === next

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setErr(null)
    setSubmitting(true)
    try {
      await api.authChangePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      onUpdated()
    } catch (e: any) {
      setErr(e?.message || 'Failed to change password')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium text-white/85">Change password</div>
      <div className="grid gap-3 md:grid-cols-3">
        <Input
          type="password"
          placeholder="Current password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value)
            if (err) setErr(null)
          }}
          autoComplete="current-password"
          disabled={submitting}
        />
        <Input
          type="password"
          placeholder="New password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value)
            if (err) setErr(null)
          }}
          autoComplete="new-password"
          disabled={submitting}
          className={cx(
            tooShort &&
            'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
          )}
        />
        <Input
          type="password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          disabled={submitting}
          className={cx(
            mismatch &&
            'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
          )}
        />
      </div>
      <HintSlot
        hint={
          err
            ? { tone: 'error', text: err }
            : tooShort
              ? { tone: 'warn', text: `Password: at least ${PASSWORD_MIN} characters.` }
              : mismatch
                ? { tone: 'warn', text: 'Passwords don’t match.' }
                : null
        }
      />
      <div>
        <Button
          type="submit"
          className={cx(!canSubmit && 'opacity-50 cursor-not-allowed pointer-events-none')}
          disabled={!canSubmit}
        >
          {submitting ? 'Saving…' : 'Change password'}
        </Button>
      </div>
    </form>
  )
}

type HintTone = 'dim' | 'warn' | 'error'

const HINT_TONE: Record<HintTone, string> = {
  dim: 'text-white/45',
  warn: 'text-amber-300/85',
  error: 'text-rose-300',
}

function HintSlot({ hint }: { hint: { tone: HintTone; text: string } | null }) {
  return (
    <AnimatePresence initial={false}>
      {hint && (
        <motion.div
          key="hint-slot"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          style={{ overflow: 'hidden' }}
        >
          <div className={cx('pt-1 text-xs', HINT_TONE[hint.tone])}>{hint.text}</div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
