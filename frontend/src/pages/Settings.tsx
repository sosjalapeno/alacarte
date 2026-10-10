import { useEffect, useRef, useState, useCallback } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Lock,
  Key,
  Globe,
  FolderOpen,
  ListPlus,
  MicVocal,
  Plug,
  Radar,
  ShieldCheck,
  Tags,
  User as UserIcon,
  Users,
  Wrench,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from 'react-i18next'

import {
  api,
  type ArtistBackfillStatus,
  type EffectiveCheckInterval,
  type LyricsBackfillStatus,
  type PublicSettings,
  type TagBackfillStatus,
} from '../api/client'
import { setAppSettingsCache } from '../hooks/useAppSettings'
import { useEventStream } from '../hooks/useEventStream'
import i18n, { SUPPORTED_LANGUAGES, LANGUAGE_NATIVE_LABELS } from '../i18n'

import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Modal } from '../components/Modal'
import { ProgressBar } from '../components/ProgressBar'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { LanguageChipInput, type LanguageOption } from '../components/LanguageChipInput'
import { cx } from '../lib/cx'

// Must match backend/lib/metadataLanguage.mjs's LANGUAGE_CATALOG.
const ACCEPTED_LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese (Simplified) · 中文' },
  { code: 'zh-hant', label: 'Chinese (Traditional) · 中文（繁體）' },
  { code: 'ja', label: 'Japanese · 日本語' },
  { code: 'ko', label: 'Korean · 한국어' },
  { code: 'es', label: 'Spanish · Español' },
  { code: 'fr', label: 'French · Français' },
]

const NAMING_LANGUAGE_MODE_OPTIONS: Array<{
  value: PublicSettings['namingLanguageMode']
  labelKey: string
}> = [
  { value: 'display', labelKey: 'settings.namingModeDisplay' },
  { value: 'original-if-accepted', labelKey: 'settings.namingModeOriginalIfAccepted' },
  { value: 'dual', labelKey: 'settings.namingModeDual' },
]

const QUALITY_OPTIONS: Array<{ value: PublicSettings['quality']; labelKey: string }> = [
  { value: 'flac', labelKey: 'settings.qualityFlac' },
  { value: 'alac', labelKey: 'settings.qualityAlac' },
  { value: 'atmos', labelKey: 'settings.qualityAtmos' },
  { value: 'aac', labelKey: 'settings.qualityAac' },
]

const AUTO_DOWNLOAD_FREQUENCY_OPTIONS: Array<{
  value: PublicSettings['autoDownloadCheckFrequency']
  labelKey: string
}> = [
  { value: 'auto', labelKey: 'settings.frequencyAuto' },
  { value: '1h', labelKey: 'settings.frequencyHourly' },
  { value: '6h', labelKey: 'settings.frequency6h' },
  { value: '12h', labelKey: 'settings.frequency12h' },
  { value: 'daily', labelKey: 'settings.frequencyDaily' },
  { value: 'weekly', labelKey: 'settings.frequencyWeekly' },
]

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [storefronts, setStorefronts] = useState<Array<{ id: string; name: string }>>([])
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

  const uiLang = i18n.resolvedLanguage || 'en'
  useEffect(() => {
    api
      .storefronts(uiLang)
      .then((r) => setStorefronts(r.storefronts))
      .catch(() => { })
  }, [uiLang])

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
          <SettingsCard icon={<Lock className="h-4 w-4" />} title={t('settings.cardAppleCredentials')}>
            <AppleCredsForm
              settings={settings}
              onChange={reload}
              disabled={saving}
              setSaving={setSaving}
            />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Key className="h-4 w-4" />} title={t('settings.cardMediaUserToken')}>
            <MediaUserTokenForm settings={settings} onChange={reload} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Globe className="h-4 w-4" />} title={t('settings.cardCatalog')}>
            <div className="space-y-4">
              <label className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
                <span className="text-sm text-white/70 md:w-32">{t('settings.language')}</span>
                <select
                  value={settings.uiLanguage}
                  onChange={(e) => update({ uiLanguage: e.target.value as PublicSettings['uiLanguage'] })}
                  className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)] md:flex-1"
                >
                  <option value="system" className="bg-zinc-900">
                    {t('settings.followSystemDefault')}
                  </option>
                  {SUPPORTED_LANGUAGES.map((code) => (
                    <option key={code} value={code} className="bg-zinc-900">
                      {LANGUAGE_NATIVE_LABELS[code]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
                <span className="text-sm text-white/70 md:w-32">{t('settings.storefront')}</span>
                <select
                  value={settings.storefront}
                  onChange={(e) => update({ storefront: e.target.value })}
                  className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)] md:flex-1"
                >
                  {!storefronts.some((s) => s.id === settings.storefront) && (
                    <option value={settings.storefront} className="bg-zinc-900">
                      {settings.storefront.toUpperCase()}
                    </option>
                  )}
                  {storefronts.map((s) => (
                    <option key={s.id} value={s.id} className="bg-zinc-900">
                      {s.name} ({s.id.toUpperCase()})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">
                  {t('settings.contentRating')}
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
                      {t('settings.preferExplicit')}
                    </option>
                    <option value="clean" className="bg-zinc-900">
                      {t('settings.preferClean')}
                    </option>
                    <option value="both" className="bg-zinc-900">
                      {t('settings.showBoth')}
                    </option>
                  </select>

                </div>
              </label>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<FolderOpen className="h-4 w-4" />} title={t('settings.libraryOutput')}>
            <div className="space-y-4">
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">{t('settings.quality')}</span>
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
                        {t(option.labelKey)}
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
                  <div className="text-sm font-medium">{t('settings.askQualityBeforeManual')}</div>
                  <div className="mt-1 text-sm text-white/55">
                    {t('settings.askQualityBeforeManualHelp')}
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
                  <div className="text-sm font-medium">{t('settings.stagingInsideLibrary')}</div>
                  <div className="mt-1 text-sm text-white/55">
                    {t('settings.stagingHelpOff')} <code>/tmp/alacarte-staging</code>. {t('settings.stagingHelpOn')}
                    <code> /music/.amdl-tmp</code>.
                  </div>
                </div>
              </label>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="text-sm font-medium">{t('settings.namingConvention')}</div>
                  <div className="mt-1 text-sm text-white/55">
                    {t('settings.namingConventionHelpPre')} <em>{t('settings.qobuzCompatible')}</em>{' '}
                    {t('settings.namingConventionHelpPost')}
                  </div>
                  <select
                    value={settings.namingConvention ?? 'apple'}
                    onChange={(e) => update({ namingConvention: e.target.value as 'apple' | 'qobuz' })}
                    className="mt-2 w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    <option value="apple" className="bg-zinc-900">{t('settings.namingApple')}</option>
                    <option value="qobuz" className="bg-zinc-900">{t('settings.qobuzCompatible')}</option>
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
                    {t('settings.downloadLyrics')}
                  </div>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">{t('settings.lyricsFormat')}</span>
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
                    <option value="lrc" className="bg-zinc-900">{t('settings.lyricsFormatLrc')}</option>
                    <option value="ttml" className="bg-zinc-900">{t('settings.lyricsFormatTtml')}</option>
                    <option value="both" className="bg-zinc-900">{t('settings.lyricsFormatBoth')}</option>
                  </select>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">{t('settings.lyricsType')}</span>
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
                    <option value="lyrics" className="bg-zinc-900">{t('settings.lyricsTypeLyrics')}</option>
                    <option value="lyrics-with-translation" className="bg-zinc-900">{t('settings.lyricsTypeWithTranslation')}</option>
                  </select>

                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">
                  {t('settings.coverSize')}
                </span>
                <div className="md:flex-1">
                  <select
                    value={settings.coverSize}
                    onChange={(e) => update({ coverSize: e.target.value })}
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    <option value="1400x1400" className="bg-zinc-900">{t('settings.coverSize1400')}</option>
                    <option value="2000x2000" className="bg-zinc-900">{t('settings.coverSize2000')}</option>
                    <option value="3000x3000" className="bg-zinc-900">{t('settings.coverSize3000')}</option>
                    <option value="5000x5000" className="bg-zinc-900">{t('settings.coverSize5000')}</option>
                  </select>

                </div>
              </label>

              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">
                  {t('settings.namingLanguageMode')}
                </span>
                <div className="md:flex-1">
                  <select
                    value={settings.namingLanguageMode}
                    onChange={(e) =>
                      update({
                        namingLanguageMode: e.target.value as PublicSettings['namingLanguageMode'],
                      })
                    }
                    className="w-full rounded-app border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-white outline-none transition-[border-color,background,box-shadow] duration-[250ms] ease-smooth focus:border-[rgba(var(--accent),0.45)] focus:bg-[rgba(var(--accent),0.04)] focus:shadow-[0_0_0_3px_rgba(var(--accent),0.18)]"
                  >
                    {NAMING_LANGUAGE_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-zinc-900">
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1.5 text-[13px] text-white/45">
                    {t(`${NAMING_LANGUAGE_MODE_OPTIONS.find((o) => o.value === settings.namingLanguageMode)?.labelKey ?? 'settings.namingModeDisplay'}Help`)}
                  </div>
                </div>
              </label>

              <div className="border-t border-white/[0.06] pt-4">
                <div className="text-sm text-white/70">{t('settings.acceptedLanguages')}</div>
                <div className="mt-1 text-[13px] text-white/45">{t('settings.acceptedLanguagesHelp')}</div>
                <div className="mt-2">
                  <LanguageChipInput
                    value={settings.acceptedLanguages}
                    onChange={(next) => update({ acceptedLanguages: next })}
                    options={ACCEPTED_LANGUAGE_OPTIONS}
                    placeholder={t('settings.acceptedLanguagesPlaceholder')}
                    emptyHint={t('settings.acceptedLanguagesEmpty')}
                  />
                </div>
              </div>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<ListPlus className="h-4 w-4" />} title={t('settings.cardOtherVersions')}>
            <div className="space-y-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.versionOptionsEnabled}
                  onChange={(e) =>
                    update({ versionOptionsEnabled: e.target.checked })
                  }
                  className="mt-0.5 shrink-0"
                />
                <div>
                  <div className="text-[13px] font-medium">
                    {t('settings.showOtherVersionOptions')}
                  </div>
                  <div className="mt-0.5 text-[13px] text-[var(--text-dim)]">
                    {t('settings.showOtherVersionOptionsHelp')}
                  </div>
                </div>
              </label>
              {settings.versionOptionsEnabled && (
                <div
                  className="flex flex-wrap items-center gap-2 pt-1"
                  role="group"
                  aria-label={t('settings.versionsToOffer')}
                >
                  <span className="text-[13px] text-[var(--text-dim)]">{t('settings.offer')}</span>
                  {(['lossless', 'atmos', 'aac'] as const).map((group) => {
                    const on = settings.versionOptions.includes(group)
                    return (
                      <button
                        key={group}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          const next = on
                            ? settings.versionOptions.filter((g) => g !== group)
                            : [...settings.versionOptions, group]
                          update({ versionOptions: next })
                        }}
                        className={
                          'inline-flex select-none items-center rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ' +
                          (on
                            ? 'border-white/30 bg-white/15 text-white'
                            : 'border-white/15 bg-transparent text-white/60 hover:bg-white/10')
                        }
                      >
                        {group === 'lossless'
                          ? t('settings.versionLossless')
                          : group === 'atmos'
                            ? t('settings.versionAtmos')
                            : t('settings.versionAac')}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Radar className="h-4 w-4" />} title={t('settings.cardAutoDownloads')}>
            <div className="space-y-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={settings.autoDownloadsEnabled}
                  onChange={(e) => update({ autoDownloadsEnabled: e.target.checked })}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                />
                <div>
                  <div className="text-sm font-medium">{t('settings.enableAutoDownloads')}</div>
                  <div className="mt-1 text-sm text-white/55">
                    {t('settings.enableAutoDownloadsHelp')}
                  </div>
                </div>
              </label>
              <label className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-3">
                <span className="text-sm text-white/70 md:w-32 md:pt-2">{t('settings.checkFrequency')}</span>
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
                        {t(option.labelKey)}
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
          <SettingsCard icon={<Wrench className="h-4 w-4" />} title={t('settings.cardLibraryMaintenance')}>
            <div className="space-y-5">
              <TagBackfillCard flash={flash} />
              <div className="border-t border-white/[0.06] pt-5">
                <LyricsBackfillCard flash={flash} />
              </div>
              <div className="border-t border-white/[0.06] pt-5">
                <ArtistBackfillCard flash={flash} />
              </div>
            </div>
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<ShieldCheck className="h-4 w-4" />} title={t('settings.cardAccount')}>
            <AccountSection onFlash={flash} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Globe className="h-4 w-4" />} title={t('settings.cardNavidromeIntegration')}>
            <NavidromeForm settings={settings} onChange={reload} onFlash={flash} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <SettingsCard icon={<Plug className="h-4 w-4" />} title={t('settings.cardOctoFiestaIntegration')}>
            <OctoIntegrationForm settings={settings} onChange={reload} onFlash={flash} />
          </SettingsCard>
        </StaggeredItem>

        <StaggeredItem>
          <footer className="pb-1 pt-1 text-center text-xs text-white/45">
            {t('settings.builtBy')}{' '}
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
  const { t } = useTranslation()
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
        {t('settings.autoIntervalAuto', { count: data.followedCount, label: data.label })}
      </p>
    )
  }
  return (
    <p className="mt-2 text-xs text-white/45">
      {t('settings.autoIntervalManual', { label: data.label })}
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
    case 'preparing': return i18n.t('settings.phasePreparing')
    case 'checking-network': return i18n.t('settings.phaseCheckingNetwork')
    case 'creating': return i18n.t('settings.phaseCreating')
    case 'signing-in': return i18n.t('settings.phaseSigningIn')
    case '2fa-required': return i18n.t('settings.phaseTwoFaRequired')
    case 'verifying-2fa': return i18n.t('settings.phaseVerifyingTwoFa')
    case 'starting-main': return i18n.t('settings.phaseStartingMain')
    case 'ready': return i18n.t('settings.phaseReady')
    case 'failed': return i18n.t('settings.phaseFailed')
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
  const { t } = useTranslation()
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
      setError(data.error || t('settings.phaseFailed'))
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
        setError(r.loginError || t('settings.couldNotStartSignIn'))
        setPhase('failed')
        setSaving(false)
        return
      }
      onChange()
    } catch (err: any) {
      setError(err?.message || t('settings.failed'))
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
      setError(err?.message || t('settings.failed'))
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
              {t('settings.appleAccountLocked')}
            </div>
            <div className="text-sm text-white/80">{settings.hardBlockReason}</div>
            <ol className="text-sm text-white/70 list-decimal pl-5 space-y-1">
              <li>
                {t('settings.resetPasswordAt')}{' '}
                <a href="https://iforgot.apple.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">iforgot.apple.com</a>.
              </li>
              <li>{t('settings.signInOnTrustedDevice')}</li>
              <li>{t('settings.waitThenClear', { clear: t('settings.clear') })}</li>
            </ol>
            <p className="text-xs text-white/50">
              {t('settings.lockoutWarning')}
            </p>
          </div>
        )}

        {settings.hasAppleCreds ? (
          <div className="text-sm text-white/70">
            {t('settings.current')} <span className="text-white">{settings.appleEmailMasked}</span>
          </div>
        ) : (
          <div className="text-sm text-white/55">
            {t('settings.noAppleCredsStored')}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <Input type="email" placeholder={t('settings.appleIdEmail')} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <Input type="password" placeholder={t('settings.password')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
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
                  title={hardBlocked ? t('settings.clearLockoutFirst') : t('settings.saveCredentials')}
                >
                  {busy ? t('settings.signingIn') : t('settings.saveAndSignIn')}
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
                {!hardBlocked && <Button onClick={retryLogin}>{t('settings.reRunSignIn')}</Button>}
                <Button onClick={clear}>{t('settings.clear')}</Button>
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
                <Button onClick={cancel}>{t('settings.cancel')}</Button>
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
              {t('settings.troubleshooting')}
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
                {t('settings.showWrapperLog')}
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
                {t('settings.copy')}
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
  const { t } = useTranslation()
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
      setErr(t('settings.enterSixDigitCode'))
      return
    }
    setErr(null)
    setSubmitting(true)
    try {
      await api.submitAppleTwoFa(cleaned)
      onClose()
    } catch (e: any) {
      setErr(e?.message || t('settings.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={true} onClose={onCancel} className="max-w-sm p-6" label={t('settings.twoFactorCode')}>
      <h3 className="text-lg font-semibold mb-1">{t('settings.twoFactorCode')}</h3>
      <p className="text-sm text-white/60 mb-4">
        {t('settings.twoFactorCodeHelp')}
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
          <Button onClick={onCancel} disabled={submitting}>{t('settings.cancelSignIn')}</Button>
          <Button type="submit" disabled={submitting || code.replace(/\D/g, '').length !== 6}>
            {submitting ? t('settings.verifying') : t('settings.verify')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function MediaUserTokenForm({ settings, onChange }: { settings: PublicSettings; onChange: () => void }) {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    try {
      await api.saveMediaUserToken(token)
      setToken('')
      setMsg(t('settings.saved'))
      onChange()
    } catch (err: any) {
      setMsg(t('settings.errorPrefix', { message: err.message }))
    }
  }
  const clear = async () => {
    await api.clearMediaUserToken()
    setMsg(t('settings.cleared'))
    onChange()
  }

  return (
    <form className="space-y-3" onSubmit={save}>
      <div className="text-sm text-white/55">
        {t('settings.mediaTokenHelpPre')}{' '}
        <a href="https://music.apple.com" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 decoration-accent/50 hover:text-white">music.apple.com</a>
        {t('settings.mediaTokenHelpPost')}
      </div>
      {settings.hasMediaUserToken && (
        <div className="text-sm text-emerald-400">{t('settings.currentlyStored')}</div>
      )}
      <Input type="password" placeholder={t('settings.pasteMediaToken')} value={token} onChange={(e) => setToken(e.target.value)} />
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
              <Button type="submit">{t('settings.saveToken')}</Button>
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
              <Button onClick={clear}>{t('settings.clear')}</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {msg && <div className="text-xs text-white/60">{msg}</div>}
    </form>
  )
}

function NavidromeForm({ settings, onChange, onFlash }: { settings: PublicSettings; onChange: () => void; onFlash: (msg: string, err?: boolean) => void }) {
  const { t } = useTranslation()
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
      onFlash(t('settings.saved'))
      setPassword('')
      onChange()
    } catch (err: any) {
      onFlash(t('settings.errorPrefix', { message: err.message }), true)
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
          <div className="text-sm font-medium">{t('settings.enableNavidromeScan')}</div>
          <div className="text-xs text-white/55 mt-0.5">
            {t('settings.enableNavidromeScanHelp')}
          </div>
        </div>
      </label>

      {enabled && (
        <div className="space-y-3 pt-2">
          {settings.hasNavidromeCreds ? (
            <div className="text-sm text-white/70">
              {t('settings.current')} <span className="text-white">{settings.navidromeUser}</span>
            </div>
          ) : (
            <div className="text-sm text-white/55">
              {t('settings.noNavidromeCredsStored')}
            </div>
          )}
          <Input
            type="url"
            placeholder={t('settings.navidromeUrl')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              type="text"
              placeholder={t('settings.username')}
              autoComplete="username"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
            <Input
              type="password"
              placeholder={t('settings.password')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap min-h-[40px]">
        <Button type="submit">{t('settings.saveNavidromeSettings')}</Button>
      </div>
    </form>
  )
}

const OCTO_FIESTA_URL = 'https://github.com/filipton/octo-fiesta'

function OctoIntegrationForm({ settings, onChange, onFlash }: { settings: PublicSettings; onChange: () => void; onFlash: (msg: string, err?: boolean) => void }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(settings.octoIntegrationEnabled ?? false)
  const [token, setToken] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const alacarteUrl = window.location.origin

  const toggle = async (next: boolean) => {
    try {
      await api.saveSettings({ octoIntegrationEnabled: next })
      setEnabled(next)
      setToken(null)
      setShown(false)
      onChange()
      onFlash(next ? t('settings.octoIntegrationOn') : t('settings.octoIntegrationOff'))
    } catch (err: any) {
      onFlash(t('settings.errorPrefix', { message: err.message }), true)
    }
  }

  const loadToken = async () => token ?? (await api.octoIntegrationToken()).token

  const reveal = async () => {
    try {
      if (!shown) setToken(await loadToken())
      setShown(!shown)
    } catch (err: any) {
      onFlash(t('settings.errorPrefix', { message: err.message }), true)
    }
  }

  const copy = async () => {
    try {
      const tok = await loadToken()
      setToken(tok)
      if (!tok) return
      try {
        await navigator.clipboard.writeText(tok)
        onFlash(t('settings.tokenCopied'))
      } catch {
        // clipboard needs https or localhost
        onFlash(t('settings.copyBlocked'), true)
      }
    } catch (err: any) {
      onFlash(t('settings.errorPrefix', { message: err.message }), true)
    }
  }

  const regenerate = async () => {
    try {
      const r = await api.regenerateOctoIntegrationToken()
      setToken(r.token)
      setShown(true)
      onFlash(t('settings.newTokenRegenerated'))
    } catch (err: any) {
      onFlash(t('settings.errorPrefix', { message: err.message }), true)
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-[rgba(var(--accent),0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
        />
        <div>
          <div className="text-sm font-medium">{t('settings.letOctoFiestaUseAlacarte')}</div>
          <div className="text-xs text-white/55 mt-0.5">
            <a href={OCTO_FIESTA_URL} target="_blank" rel="noreferrer" className="underline hover:text-white">
              {t('settings.octoFiestaLinkText')}
            </a>{' '}
            {t('settings.octoFiestaDescription')}
          </div>
        </div>
      </label>

      {enabled && (
        <div className="space-y-3 pt-2">
          <div className="text-xs text-white/55">
            {t('settings.octoFiestaSetupHint')}
          </div>
          <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white/80 select-all">
{`AppleMusic__AlacarteUrl=${alacarteUrl}
AppleMusic__ApiToken=${shown && token ? token : '••••••••••••••••'}`}
          </pre>
          <div className="flex gap-2 flex-wrap">
            <Button type="button" variant="ghost" onClick={reveal}>{shown ? t('settings.hideToken') : t('settings.showToken')}</Button>
            <Button type="button" variant="ghost" onClick={copy}>{t('settings.copyToken')}</Button>
            <Button type="button" variant="ghost" onClick={regenerate}>{t('settings.regenerateToken')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

const PASSWORD_MIN = 12
const USERNAME_MIN = 2
const USERNAME_MAX = 32
const USERNAME_REGEX = /^[a-zA-Z0-9._-]+$/

function AccountSection({ onFlash }: { onFlash: (msg: string, err?: boolean) => void }) {
  const { t } = useTranslation()
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
            <div className="text-xs uppercase tracking-wide text-white/40">{t('settings.signedInAs')}</div>
            <div className="text-sm font-medium text-white truncate">{username}</div>
          </div>
        </div>
      )}

      <ChangeUsernameForm
        currentUsername={username}
        onUpdated={(name) => {
          setUsername(name)
          onFlash(t('settings.usernameUpdated'))
        }}
      />

      <div className="border-t border-white/[0.06]" />

      <ChangePasswordForm onUpdated={() => onFlash(t('settings.passwordUpdated'))} />

      <div className="border-t border-white/[0.06]" />

      <div className="space-y-3">
        <Button
          onClick={() => {
            setShowRevoke((v) => !v)
            setRevokeError(null)
          }}
          className="bg-white/[0.02]"
        >
          {t('settings.signOutOnAllDevices')}
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
                onFlash(t('settings.signedOutOnAllOtherDevices'))
              } catch (err: any) {
                setRevokeError(err?.message || t('settings.failedToRevokeSessions'))
              } finally {
                setRevoking(false)
              }
            }}
            className="space-y-2"
          >
            <Input
              type="password"
              placeholder={t('settings.currentPassword')}
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
                {revoking ? t('settings.revoking') : t('settings.confirmSignOutEverywhere')}
              </Button>
              <Button
                onClick={() => {
                  setShowRevoke(false)
                  setRevokePassword('')
                  setRevokeError(null)
                }}
                disabled={revoking}
              >
                {t('settings.cancel')}
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
  const { t } = useTranslation()
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
      setErr(e?.message || t('settings.failedToChangeUsername'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium text-white/85">{t('settings.changeUsername')}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <Input
          type="text"
          placeholder={t('settings.newUsername')}
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
          placeholder={t('settings.currentPassword')}
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
              ? { tone: 'warn', text: t('settings.usernameBadChars') }
              : tooShort
                ? { tone: 'warn', text: t('settings.usernameTooShort', { min: USERNAME_MIN }) }
                : tooLong
                  ? { tone: 'warn', text: t('settings.usernameTooLong', { max: USERNAME_MAX }) }
                  : sameAsCurrent
                    ? { tone: 'dim', text: t('settings.pickDifferentUsername') }
                    : null
        }
      />
      <div>
        <Button
          type="submit"
          className={cx(!canSubmit && 'opacity-50 cursor-not-allowed pointer-events-none')}
          disabled={!canSubmit}
        >
          {submitting ? t('settings.saving') : t('settings.changeUsername')}
        </Button>
      </div>
    </form>
  )
}

function ChangePasswordForm({ onUpdated }: { onUpdated: () => void }) {
  const { t } = useTranslation()
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
      setErr(e?.message || t('settings.failedToChangePassword'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="text-sm font-medium text-white/85">{t('settings.changePassword')}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <Input
          type="password"
          placeholder={t('settings.currentPassword')}
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
          placeholder={t('settings.newPassword')}
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
          placeholder={t('settings.confirmNewPassword')}
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
              ? { tone: 'warn', text: t('settings.passwordTooShort', { min: PASSWORD_MIN }) }
              : mismatch
                ? { tone: 'warn', text: t('settings.passwordsDontMatch') }
                : null
        }
      />
      <div>
        <Button
          type="submit"
          className={cx(!canSubmit && 'opacity-50 cursor-not-allowed pointer-events-none')}
          disabled={!canSubmit}
        >
          {submitting ? t('settings.saving') : t('settings.changePassword')}
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

type BackfillStatusBase = {
  running: boolean
  scanned: number
  total: number
  current: string | null
  finishedAt: number | null
  stopRequested: boolean
}

function BackfillCard<S extends BackfillStatusBase>({
  flash,
  icon: Icon,
  title,
  description,
  actionLabel,
  confirmTitle,
  startedMessage,
  load,
  start: startRun,
  stop: stopRun,
  badges,
}: {
  flash: (msg: string) => void
  icon: typeof Tags
  title: string
  description: string
  actionLabel: string
  confirmTitle: string
  startedMessage: string
  load: () => Promise<S>
  start: () => Promise<S>
  stop: () => Promise<unknown>
  badges: (status: S, finished: boolean) => React.ReactNode
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<S | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    load().then(setStatus).catch(() => {})
  }, [load])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [status?.running, refresh])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await startRun())
      setConfirmOpen(false)
      flash(startedMessage)
    } catch (err: any) {
      setError(err?.message || t('settings.failedToStartBackfill'))
      setConfirmOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await stopRun()
    } catch {}
    setBusy(false)
    refresh()
  }

  const running = Boolean(status?.running)
  const pct =
    status && status.total > 0
      ? Math.min(100, Math.round((status.scanned / status.total) * 100))
      : 0

  return (
    <section>
      <div className="space-y-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Icon className="h-4 w-4 text-white/55" />
            {title}
          </div>
          <div className="mt-1 text-[13px] text-white/50">{description}</div>
        </div>

        {running && (
          <div className="space-y-2">
            <ProgressBar
              value={pct}
              label={t('settings.backfillProgress', { pct, scanned: status!.scanned, total: status!.total })}
            />
            <div className="flex flex-wrap gap-1.5">{badges(status!, false)}</div>
            {status!.current && (
              <div
                className="truncate text-xs text-white/40"
                title={status!.current}
              >
                {status!.current}
              </div>
            )}
            {status!.stopRequested && (
              <div className="text-xs text-white/45">
                {t('settings.stoppingAfterCurrentFile')}
              </div>
            )}
          </div>
        )}

        {!running && status?.finishedAt && (
          <div className="flex flex-wrap items-center gap-1.5">{badges(status, true)}</div>
        )}

        {error && <Badge variant="bad">{error}</Badge>}

        <div>
          {running ? (
            <Button
              onClick={stop}
              disabled={busy || status!.stopRequested}
              className="border-rose-300/30 bg-rose-500/10 text-rose-200 hover:border-rose-300/50 hover:bg-rose-500/20 hover:text-rose-100"
            >
              {status!.stopRequested ? t('settings.stopping') : t('settings.stopBackfill')}
            </Button>
          ) : (
            <Button onClick={() => setConfirmOpen(true)}>
              <Icon className="h-4 w-4" />
              {actionLabel}
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        label={actionLabel}
        placement="center"
        className="!max-w-[36rem]"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-white/55">
                {actionLabel}
              </div>
              <h2 className="mt-1 text-lg font-semibold text-white">
                {confirmTitle}
              </h2>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
              variant="ghost"
            >
              {t('settings.cancel')}
            </Button>
            <Button onClick={start} disabled={busy}>
              <Icon className="h-4 w-4" />
              {busy ? t('settings.starting') : t('settings.startBackfill')}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  )
}

function TagBackfillCard({ flash }: { flash: (msg: string) => void }) {
  const { t } = useTranslation()
  return (
    <BackfillCard<TagBackfillStatus>
      flash={flash}
      icon={Tags}
      title={t('settings.cardLibraryTags')}
      description={t('settings.libraryTagsDescription')}
      actionLabel={t('settings.backfillLibraryTags')}
      confirmTitle={t('settings.scanLibraryForMissingTags')}
      startedMessage={t('settings.tagBackfillStarted')}
      load={api.tagBackfillStatus}
      start={() => api.startTagBackfill(false)}
      stop={api.stopTagBackfill}
      badges={(s, finished) => (
        <>
          <Badge variant="ok">
            {finished
              ? t('settings.lastRunStamped', { count: s.stamped })
              : t('settings.stampedCount', { count: s.stamped })}
          </Badge>
          <Badge>{t('settings.alreadyTaggedCount', { count: s.skipped })}</Badge>
          <Badge variant="warn">{t('settings.unmatchedCount', { count: s.noMatch })}</Badge>
          {s.failed > 0 && <Badge variant="bad">{t('settings.failedCount', { count: s.failed })}</Badge>}
        </>
      )}
    />
  )
}

function LyricsBackfillCard({ flash }: { flash: (msg: string) => void }) {
  const { t } = useTranslation()
  return (
    <BackfillCard<LyricsBackfillStatus>
      flash={flash}
      icon={MicVocal}
      title={t('settings.cardLyrics')}
      description={t('settings.lyricsBackfillDescription')}
      actionLabel={t('settings.backfillLyrics')}
      confirmTitle={t('settings.scanLibraryForMissingLyrics')}
      startedMessage={t('settings.lyricsBackfillStarted')}
      load={api.lyricsBackfillStatus}
      start={api.startLyricsBackfill}
      stop={api.stopLyricsBackfill}
      badges={(s, finished) => (
        <>
          <Badge variant="ok">
            {finished
              ? t('settings.lastRunLyricsAdded', { count: s.added })
              : t('settings.lyricsAddedCount', { count: s.added })}
          </Badge>
          {!!s.converted && (
            <Badge variant="ok">
              {t('settings.lyricsConvertedCount', { count: s.converted })}
            </Badge>
          )}
          <Badge>{t('settings.alreadyHaveLyricsCount', { count: s.skipped })}</Badge>
          <Badge>{t('settings.noAppleLyricsCount', { count: s.noLyrics })}</Badge>
          <Badge variant="warn">{t('settings.unmatchedCount', { count: s.noMatch })}</Badge>
          {s.failed > 0 && <Badge variant="bad">{t('settings.failedCount', { count: s.failed })}</Badge>}
        </>
      )}
    />
  )
}

function ArtistBackfillCard({ flash }: { flash: (msg: string) => void }) {
  const { t } = useTranslation()
  return (
    <BackfillCard<ArtistBackfillStatus>
      flash={flash}
      icon={Users}
      title={t('settings.cardArtistCredits')}
      description={t('settings.artistBackfillDescription')}
      actionLabel={t('settings.backfillArtists')}
      confirmTitle={t('settings.scanLibraryForArtistCredits')}
      startedMessage={t('settings.artistBackfillStarted')}
      load={api.artistBackfillStatus}
      start={api.startArtistBackfill}
      stop={api.stopArtistBackfill}
      badges={(s, finished) => (
        <>
          <Badge variant="ok">
            {finished
              ? t('settings.lastRunArtistsUpdated', { count: s.updated })
              : t('settings.artistsUpdatedCount', { count: s.updated })}
          </Badge>
          <Badge>{t('settings.alreadyCorrectCount', { count: s.skipped })}</Badge>
          <Badge variant="warn">{t('settings.unmatchedCount', { count: s.noMatch })}</Badge>
          {s.failed > 0 && <Badge variant="bad">{t('settings.failedCount', { count: s.failed })}</Badge>}
        </>
      )}
    />
  )
}
