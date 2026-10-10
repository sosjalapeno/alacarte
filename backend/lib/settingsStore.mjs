import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { getRawKey } from './secretKey.mjs'
import {
  UI_LANGUAGE_VALUES,
  ACCEPTED_LANGUAGE_VALUES,
  NAMING_LANGUAGE_MODE_VALUES,
  DEFAULT_NAMING_LANGUAGE_MODE,
  MAX_ACCEPTED_LANGUAGES,
} from './metadataLanguage.mjs'

export {
  UI_LANGUAGE_VALUES,
  ACCEPTED_LANGUAGE_VALUES,
  NAMING_LANGUAGE_MODE_VALUES,
} from './metadataLanguage.mjs'

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const SECRET_FILE = path.join(CONFIG_DIR, '.secret')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')

const DEFAULTS = {
  storefront: 'us',
  language: 'en-US',
  quality: 'flac',
  convertToFlac: true,
  coverSize: '1400x1400',
  downloadLyrics: false,
  lyricsFormat: 'lrc',
  lyricsType: 'lyrics',
  promptForDownloadQuality: false,
  explicitFilter: 'explicit',
  appleEmail: null,
  applePassword: null,
  mediaUserToken: null,
  navidromeEnabled: false,
  navidromeUrl: 'http://navidrome:4533',
  navidromeUser: null,
  navidromePassword: null,
  octoIntegrationEnabled: false,
  octoIntegrationToken: null,
  autoDownloadsEnabled: true,
  autoDownloadCheckFrequency: 'auto',
  stagingInsideMusicLibrary: false,
  namingConvention: 'apple',
  versionOptionsEnabled: false,
  versionOptions: ['atmos', 'lossless', 'aac'],
  uiLanguage: 'system',
  acceptedLanguages: [],
  namingLanguageMode: DEFAULT_NAMING_LANGUAGE_MODE,
  // Apple request pacing (see appleGateway.mjs); null = use the built-in default.
  appleGatewayIntervalMs: null,
  appleGatewayMinIntervalMs: null,
  appleGatewayAdaptive: true,
  appleGatewayCooldownMinutes: null,
}

function normalizeAcceptedLanguages(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const code = String(raw || '').trim().toLowerCase()
    if (!ACCEPTED_LANGUAGE_VALUES.has(code) || seen.has(code)) continue
    seen.add(code)
    out.push(code)
    if (out.length >= MAX_ACCEPTED_LANGUAGES) break
  }
  return out
}

const QUALITY_VALUES = new Set(['flac', 'alac', 'atmos', 'aac'])

// Number inside [min, max], or null when absent/invalid (= use the default).
export function clampSetting(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
}

export const APPLE_GATEWAY_LIMITS = {
  appleGatewayIntervalMs: [100, 30_000],
  appleGatewayMinIntervalMs: [100, 30_000],
  appleGatewayCooldownMinutes: [1, 240],
}
export const NAMING_CONVENTION_VALUES = new Set(['apple', 'qobuz'])
export const VERSION_GROUP_VALUES = new Set(['lossless', 'atmos', 'aac'])

export const AUTO_DOWNLOAD_FREQUENCY_VALUES = new Set([
  'auto',
  '1h',
  '6h',
  '12h',
  'daily',
  'weekly',
])

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'off', ''].includes(s)) return false
  }
  return Boolean(fallback)
}

export async function ensureConfigDir(dir = CONFIG_DIR) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o750 })
  if (!fs.existsSync(SECRET_FILE)) {
    let key = (process.env.AMDL_SECRET_KEY || '').trim()
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      key = crypto.randomBytes(32).toString('hex')
    }
    await fsp.writeFile(SECRET_FILE, key, { mode: 0o600 })
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    await fsp.writeFile(
      SETTINGS_FILE,
      JSON.stringify(DEFAULTS, null, 2),
      { mode: 0o600 },
    )
  }
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null
  const key = getRawKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(b64) {
  if (!b64) return null
  try {
    const key = getRawKey()
    const buf = Buffer.from(b64, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    )
  } catch (err) {
    console.error('Failed to decrypt secret:', err.message)
    return null
  }
}

// Writes do a read-modify-write of the whole file; serialize them so two
// saves can't clobber each other with stale snapshots.
let writeChain = Promise.resolve()
function serialize(operation) {
  const run = writeChain.then(operation, operation)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// A missing file means defaults. A file that is not valid JSON is moved
// aside so the encrypted credentials in it are kept for recovery; any
// other read error is thrown so a write never commits defaults over a
// file it could not read.
async function loadSettingsFile() {
  let raw
  try {
    raw = await fsp.readFile(SETTINGS_FILE, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.error('settings.json unreadable:', err.message)
    await fsp
      .rename(SETTINGS_FILE, `${SETTINGS_FILE}.corrupt-${Date.now()}`)
      .catch(() => null)
    return {}
  }
}

export async function readSettings() {
  try {
    return normalizeSettings(await loadSettingsFile())
  } catch (err) {
    console.error('settings.json read failed:', err.message)
    return normalizeSettings({})
  }
}

export function writeSettings(patch) {
  return serialize(async () => {
    const current = normalizeSettings(await loadSettingsFile())
    const merged = { ...current, ...patch }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'convertToFlac') &&
      !Object.prototype.hasOwnProperty.call(patch, 'quality')
    ) {
      merged.quality = patch.convertToFlac === false ? 'alac' : 'flac'
    }
    const next = normalizeSettings(merged)
    // Write a temp file and rename it over the old one so a reader (or a
    // crash) never sees a half-written file.
    const tmpFile = `${SETTINGS_FILE}.tmp`
    await fsp.writeFile(tmpFile, JSON.stringify(next, null, 2), { mode: 0o600 })
    await fsp.rename(tmpFile, SETTINGS_FILE)
    return next
  })
}

// Settings that never had any effect (amdp's folder and file names are fixed
// in amdpRunner, and ALAC is not kept next to the FLAC); dropped from older
// settings files on the next save.
const RETIRED_KEYS = ['albumFolderFormat', 'artistFolderFormat', 'songFileFormat', 'keepAlac']

function normalizeSettings(input) {
  const parsed = { ...input }
  for (const key of RETIRED_KEYS) delete parsed[key]
  const hasQuality = QUALITY_VALUES.has(parsed?.quality)
  const legacyFlacConversion =
    parsed?.convertToFlac ?? parsed?.flac_conversion ?? DEFAULTS.convertToFlac
  const legacyQuality = legacyFlacConversion === false ? 'alac' : 'flac'
  const quality = hasQuality ? parsed.quality : legacyQuality
  const autoDownloadCheckFrequency = AUTO_DOWNLOAD_FREQUENCY_VALUES.has(
    parsed?.autoDownloadCheckFrequency,
  )
    ? parsed.autoDownloadCheckFrequency
    : DEFAULTS.autoDownloadCheckFrequency
  return {
    ...DEFAULTS,
    ...parsed,
    quality,
    convertToFlac: quality === 'flac',
    downloadLyrics: toBool(parsed?.downloadLyrics, DEFAULTS.downloadLyrics),
    promptForDownloadQuality: toBool(
      parsed?.promptForDownloadQuality,
      DEFAULTS.promptForDownloadQuality,
    ),
    navidromeEnabled: toBool(parsed?.navidromeEnabled, DEFAULTS.navidromeEnabled),
    octoIntegrationEnabled: toBool(parsed?.octoIntegrationEnabled, DEFAULTS.octoIntegrationEnabled),
    autoDownloadsEnabled: toBool(parsed?.autoDownloadsEnabled, DEFAULTS.autoDownloadsEnabled),
    autoDownloadCheckFrequency,
    stagingInsideMusicLibrary: toBool(
      parsed?.stagingInsideMusicLibrary,
      DEFAULTS.stagingInsideMusicLibrary,
    ),
    namingConvention: NAMING_CONVENTION_VALUES.has(parsed?.namingConvention)
      ? parsed.namingConvention
      : DEFAULTS.namingConvention,
    versionOptionsEnabled: toBool(
      parsed?.versionOptionsEnabled,
      DEFAULTS.versionOptionsEnabled,
    ),
    ...(Array.isArray(parsed?.versionOptions)
      ? {
          versionOptions: parsed.versionOptions.filter((g) =>
            VERSION_GROUP_VALUES.has(g),
          ),
        }
      : {}),
    uiLanguage: UI_LANGUAGE_VALUES.has(parsed?.uiLanguage)
      ? parsed.uiLanguage
      : DEFAULTS.uiLanguage,
    acceptedLanguages: normalizeAcceptedLanguages(parsed?.acceptedLanguages),
    namingLanguageMode: NAMING_LANGUAGE_MODE_VALUES.has(parsed?.namingLanguageMode)
      ? parsed.namingLanguageMode
      : DEFAULTS.namingLanguageMode,
    appleGatewayIntervalMs: clampSetting(parsed?.appleGatewayIntervalMs, ...APPLE_GATEWAY_LIMITS.appleGatewayIntervalMs),
    appleGatewayMinIntervalMs: clampSetting(parsed?.appleGatewayMinIntervalMs, ...APPLE_GATEWAY_LIMITS.appleGatewayMinIntervalMs),
    appleGatewayAdaptive: toBool(parsed?.appleGatewayAdaptive, DEFAULTS.appleGatewayAdaptive),
    appleGatewayCooldownMinutes: clampSetting(parsed?.appleGatewayCooldownMinutes, ...APPLE_GATEWAY_LIMITS.appleGatewayCooldownMinutes),
  }
}

function maskEmail(e) {
  const [u, d] = String(e).split('@')
  if (!d) return '••••'
  const masked = u.length <= 2 ? u[0] || '•' : u[0] + '•••' + u.slice(-1)
  return `${masked}@${d}`
}

export async function readPublicSettings() {
  const s = await readSettings()
  return {
    storefront: s.storefront,
    language: s.language,
    quality: s.quality,
    convertToFlac: s.quality === 'flac',
    coverSize: s.coverSize,
    downloadLyrics: Boolean(s.downloadLyrics),
    lyricsFormat: s.lyricsFormat || 'lrc',
    lyricsType: s.lyricsType || 'lyrics',
    promptForDownloadQuality: Boolean(s.promptForDownloadQuality),
    explicitFilter: s.explicitFilter || 'explicit',
    appleEmailMasked: s.appleEmail
      ? maskEmail(decryptSecret(s.appleEmail) || '')
      : null,
    hasAppleCreds: Boolean(s.appleEmail && s.applePassword),
    hasMediaUserToken: Boolean(s.mediaUserToken),
    navidromeEnabled: Boolean(s.navidromeEnabled),
    navidromeUrl: s.navidromeUrl,
    navidromeUser: s.navidromeUser,
    hasNavidromeCreds: Boolean(s.navidromeUser && s.navidromePassword),
    octoIntegrationEnabled: Boolean(s.octoIntegrationEnabled),
    hasOctoIntegrationToken: Boolean(s.octoIntegrationToken),
    autoDownloadsEnabled: Boolean(s.autoDownloadsEnabled),
    autoDownloadCheckFrequency: s.autoDownloadCheckFrequency || 'auto',
    stagingInsideMusicLibrary: Boolean(s.stagingInsideMusicLibrary),
    namingConvention: s.namingConvention || 'apple',
    versionOptionsEnabled: Boolean(s.versionOptionsEnabled),
    versionOptions: Array.isArray(s.versionOptions)
      ? s.versionOptions.filter((g) => VERSION_GROUP_VALUES.has(g))
      : [],
    uiLanguage: s.uiLanguage || 'system',
    acceptedLanguages: Array.isArray(s.acceptedLanguages) ? s.acceptedLanguages : [],
    namingLanguageMode: s.namingLanguageMode || DEFAULT_NAMING_LANGUAGE_MODE,
  }
}

export async function readNavidromeCreds() {
  const s = await readSettings()
  return {
    enabled: Boolean(s.navidromeEnabled),
    url: s.navidromeUrl,
    user: s.navidromeUser,
    password: decryptSecret(s.navidromePassword),
  }
}

export async function readAppleCreds() {
  const s = await readSettings()
  return {
    email: decryptSecret(s.appleEmail),
    password: decryptSecret(s.applePassword),
    mediaUserToken: decryptSecret(s.mediaUserToken),
  }
}
