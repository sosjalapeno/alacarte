import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { getRawKey } from './secretKey.mjs'

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const SECRET_FILE = path.join(CONFIG_DIR, '.secret')
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json')

const DEFAULTS = {
  storefront: 'us',
  language: 'en-US',
  quality: 'flac',
  albumFolderFormat: '{AlbumName} ({ReleaseYear})',
  artistFolderFormat: '{ArtistName}',
  songFileFormat: '{SongNumer}. {SongName}',
  convertToFlac: true,
  keepAlac: false,
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
  autoDownloadsEnabled: true,
  autoDownloadCheckFrequency: 'auto',
  stagingInsideMusicLibrary: false,
  namingConvention: 'apple',
}

const QUALITY_VALUES = new Set(['flac', 'alac', 'atmos', 'aac'])
export const NAMING_CONVENTION_VALUES = new Set(['apple', 'qobuz'])

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

export async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return normalizeSettings(parsed)
  } catch {
    return normalizeSettings({})
  }
}

export async function writeSettings(patch) {
  const current = await readSettings()
  const merged = { ...current, ...patch }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'convertToFlac') &&
    !Object.prototype.hasOwnProperty.call(patch, 'quality')
  ) {
    merged.quality = patch.convertToFlac === false ? 'alac' : 'flac'
  }
  const next = normalizeSettings(merged)
  await fsp.writeFile(
    SETTINGS_FILE,
    JSON.stringify(next, null, 2),
    { mode: 0o600 },
  )
  return next
}

function normalizeSettings(parsed) {
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
    keepAlac: toBool(parsed?.keepAlac, DEFAULTS.keepAlac),
    downloadLyrics: toBool(parsed?.downloadLyrics, DEFAULTS.downloadLyrics),
    promptForDownloadQuality: toBool(
      parsed?.promptForDownloadQuality,
      DEFAULTS.promptForDownloadQuality,
    ),
    navidromeEnabled: toBool(parsed?.navidromeEnabled, DEFAULTS.navidromeEnabled),
    autoDownloadsEnabled: toBool(parsed?.autoDownloadsEnabled, DEFAULTS.autoDownloadsEnabled),
    autoDownloadCheckFrequency,
    stagingInsideMusicLibrary: toBool(
      parsed?.stagingInsideMusicLibrary,
      DEFAULTS.stagingInsideMusicLibrary,
    ),
    namingConvention: NAMING_CONVENTION_VALUES.has(parsed?.namingConvention)
      ? parsed.namingConvention
      : DEFAULTS.namingConvention,
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
    albumFolderFormat: s.albumFolderFormat,
    artistFolderFormat: s.artistFolderFormat,
    songFileFormat: s.songFileFormat,
    convertToFlac: s.quality === 'flac',
    keepAlac: s.keepAlac,
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
    autoDownloadsEnabled: Boolean(s.autoDownloadsEnabled),
    autoDownloadCheckFrequency: s.autoDownloadCheckFrequency || 'auto',
    stagingInsideMusicLibrary: Boolean(s.stagingInsideMusicLibrary),
    namingConvention: s.namingConvention || 'apple',
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
