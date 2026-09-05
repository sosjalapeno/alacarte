import express from 'express'

import {
  readPublicSettings,
  writeSettings,
  encryptSecret,
  readSettings,
  AUTO_DOWNLOAD_FREQUENCY_VALUES,
  NAMING_CONVENTION_VALUES,
} from '../lib/settingsStore.mjs'
import {
  startWrapperLogin,
  submit2FA,
  cancelLogin,
  getLoginStatus,
  isDockerReachable,
  clearHardBlock,
  getHardBlock,
} from '../lib/wrapperLogin.mjs'

export const settingsRouter = express.Router()

export const WRITABLE_KEYS = new Set([
  'storefront',
  'language',
  'quality',
  'albumFolderFormat',
  'artistFolderFormat',
  'songFileFormat',
  'convertToFlac',
  'keepAlac',
  'coverSize',
  'downloadLyrics',
  'promptForDownloadQuality',
  'explicitFilter',
  'lyricsFormat',
  'lyricsType',
  'navidromeEnabled',
  'navidromeUrl',
  'navidromeUser',
  'navidromePassword',
  'autoDownloadsEnabled',
  'autoDownloadCheckFrequency',
  'stagingInsideMusicLibrary',
  'namingConvention',
])

const EXPLICIT_FILTER_VALUES = new Set(['explicit', 'clean', 'both'])
const LYRICS_FORMAT_VALUES = new Set(['lrc', 'ttml'])
const LYRICS_TYPE_VALUES = new Set(['lyrics', 'lyrics-with-translation'])
const QUALITY_VALUES = new Set(['flac', 'alac', 'atmos', 'aac'])

settingsRouter.get('/', async (_req, res) => {
  try {
    const base = await readPublicSettings()
    res.json({ ...base, hardBlockReason: getHardBlock() || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.put('/', async (req, res) => {
  try {
    const body = req.body || {}
    const patch = {}
    for (const [k, v] of Object.entries(body)) {
      if (!WRITABLE_KEYS.has(k)) continue
      if (k === 'explicitFilter' && !EXPLICIT_FILTER_VALUES.has(v)) continue
      if (k === 'lyricsFormat' && !LYRICS_FORMAT_VALUES.has(v)) continue
      if (k === 'lyricsType' && !LYRICS_TYPE_VALUES.has(v)) continue
      if (k === 'quality' && !QUALITY_VALUES.has(v)) continue
      if (k === 'namingConvention' && !NAMING_CONVENTION_VALUES.has(v)) continue
      if (k === 'autoDownloadCheckFrequency' && !AUTO_DOWNLOAD_FREQUENCY_VALUES.has(v)) continue
      if (k === 'navidromePassword') {
        if (v) {
          patch[k] = encryptSecret(v)
        } else {
          patch[k] = null
        }
        continue
      }
      patch[k] = v
    }
    await writeSettings(patch)
    res.json(await readPublicSettings())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/apple-credentials', async (req, res) => {
  try {
    const { email, password, autoLogin = true } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' })
    }
    await writeSettings({
      appleEmail: encryptSecret(email),
      applePassword: encryptSecret(password),
    })
    clearHardBlock()

    if (!autoLogin) {
      return res.json({ ok: true, loginStarted: false })
    }

    const dockerOk = await isDockerReachable()
    if (!dockerOk) {
      return res.json({
        ok: true,
        loginStarted: false,
        loginError:
          'Docker socket not available in the web container — run first-time login from the host (see README).',
      })
    }

    startWrapperLogin({ email, password }).catch(() => {})
    return res.json({ ok: true, loginStarted: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.get('/apple-credentials/login-status', (_req, res) => {
  res.json(getLoginStatus())
})

settingsRouter.post('/apple-credentials/login', async (_req, res) => {
  try {
    const dockerOk = await isDockerReachable()
    if (!dockerOk) {
      return res.status(503).json({
        error:
          'Docker socket not available — mount /var/run/docker.sock into the web container',
      })
    }
    const s = await readSettings()
    const { decryptSecret } = await import('../lib/settingsStore.mjs')
    const email = decryptSecret(s.appleEmail)
    const password = decryptSecret(s.applePassword)
    if (!email || !password) {
      return res.status(400).json({ error: 'no credentials stored' })
    }
    startWrapperLogin({ email, password }).catch(() => {})
    res.json({ ok: true, loginStarted: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/apple-credentials/2fa', async (req, res) => {
  try {
    const { code } = req.body || {}
    if (!code) return res.status(400).json({ error: 'code required' })
    const r = await submit2FA(code)
    res.json(r)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

settingsRouter.post('/apple-credentials/cancel-login', async (_req, res) => {
  try {
    const r = await cancelLogin()
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.delete('/apple-credentials', async (_req, res) => {
  try {
    await writeSettings({ appleEmail: null, applePassword: null })
    clearHardBlock()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/media-user-token', async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token required' })
    await writeSettings({
      mediaUserToken: encryptSecret(token),
      downloadLyrics: true,
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.delete('/media-user-token', async (_req, res) => {
  try {
    await writeSettings({ mediaUserToken: null, downloadLyrics: false })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
