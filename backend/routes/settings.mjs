import express from 'express'

import {
  VERSION_GROUP_VALUES,
  readPublicSettings,
  writeSettings,
  encryptSecret,
  readSettings,
  AUTO_DOWNLOAD_FREQUENCY_VALUES,
  NAMING_CONVENTION_VALUES,
  decryptSecret,
  APPLE_GATEWAY_LIMITS,
  clampSetting,
} from '../lib/settingsStore.mjs'
import {
  UI_LANGUAGE_VALUES,
  ACCEPTED_LANGUAGE_VALUES,
  NAMING_LANGUAGE_MODE_VALUES,
  MAX_ACCEPTED_LANGUAGES,
} from '../lib/metadataLanguage.mjs'
import {
  startWrapperLogin,
  submit2FA,
  cancelLogin,
  getLoginStatus,
  isWrapperReachable,
  clearHardBlock,
  getHardBlock,
} from '../lib/wrapperLogin.mjs'
import { generateIntegrationToken } from '../lib/apiToken.mjs'
import { appleGateway, runInLane } from '../lib/appleGateway.mjs'
import { applyAppleGatewaySettings } from '../lib/appleGatewaySettings.mjs'
import { storefrontList } from '../lib/storefrontList.mjs'
import {
  startTagBackfill,
  getTagBackfillStatus,
  stopTagBackfill,
} from '../lib/tagBackfill.mjs'
import {
  startLyricsBackfill,
  getLyricsBackfillStatus,
  stopLyricsBackfill,
} from '../lib/lyricsBackfill.mjs'
import {
  startArtistBackfill,
  getArtistBackfillStatus,
  stopArtistBackfill,
} from '../lib/artistCredits.mjs'

export const settingsRouter = express.Router()

export const WRITABLE_KEYS = new Set([
  'storefront',
  'language',
  'quality',
  'convertToFlac',
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
  'octoIntegrationEnabled',
  'autoDownloadsEnabled',
  'autoDownloadCheckFrequency',
  'stagingInsideMusicLibrary',
  'namingConvention',
  'versionOptionsEnabled',
  'versionOptions',
  'uiLanguage',
  'acceptedLanguages',
  'namingLanguageMode',
  'appleGatewayIntervalMs',
  'appleGatewayMinIntervalMs',
  'appleGatewayAdaptive',
  'appleGatewayCooldownMinutes',
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

settingsRouter.get('/storefronts', async (req, res) => {
  try {
    res.json({ storefronts: await storefrontList(req.query.lang) })
  } catch (err) {
    res.status(502).json({ error: err.message })
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
      if (k === 'appleGatewayAdaptive' && typeof v !== 'boolean') continue
      if (k in APPLE_GATEWAY_LIMITS) {
        patch[k] = clampSetting(v, ...APPLE_GATEWAY_LIMITS[k])
        continue
      }
      if (k === 'versionOptionsEnabled' && typeof v !== 'boolean') continue
      if (k === 'octoIntegrationEnabled' && typeof v !== 'boolean') continue
      if (k === 'versionOptions' && !Array.isArray(v)) continue
      if (k === 'autoDownloadCheckFrequency' && !AUTO_DOWNLOAD_FREQUENCY_VALUES.has(v)) continue
      if (k === 'uiLanguage' && !UI_LANGUAGE_VALUES.has(v)) continue
      if (k === 'namingLanguageMode' && !NAMING_LANGUAGE_MODE_VALUES.has(v)) continue
      if (k === 'acceptedLanguages') {
        if (!Array.isArray(v)) continue
        const seen = new Set()
        patch[k] = v
          .map((x) => String(x || '').trim().toLowerCase())
          .filter((code) => {
            if (!ACCEPTED_LANGUAGE_VALUES.has(code) || seen.has(code)) return false
            seen.add(code)
            return true
          })
          .slice(0, MAX_ACCEPTED_LANGUAGES)
        continue
      }
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
    const saved = await writeSettings(patch)
    if (Object.keys(patch).some((k) => k.startsWith('appleGateway'))) await applyAppleGatewaySettings()
    if (saved.octoIntegrationEnabled && !saved.octoIntegrationToken) {
      await writeSettings({ octoIntegrationToken: encryptSecret(generateIntegrationToken()) })
    }
    res.json(await readPublicSettings())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Token the octo-fiesta Apple Music provider uses (AppleMusic__ApiToken).
settingsRouter.get('/octo-integration/token', async (_req, res) => {
  try {
    const s = await readSettings()
    res.json({ token: s.octoIntegrationToken ? decryptSecret(s.octoIntegrationToken) : null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/octo-integration/token', async (_req, res) => {
  try {
    const token = generateIntegrationToken()
    await writeSettings({ octoIntegrationToken: encryptSecret(token) })
    res.json({ token })
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

    const wrapperOk = await isWrapperReachable()
    if (!wrapperOk) {
      return res.json({
        ok: true,
        loginStarted: false,
        loginError:
          'Wrapper supervisor not reachable — check that the wrapper container is running.',
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
    const wrapperOk = await isWrapperReachable()
    if (!wrapperOk) {
      return res.status(503).json({
        error:
          'Wrapper supervisor not reachable — check that the wrapper container is running.',
      })
    }
    const s = await readSettings()
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

// State of the shared Apple request limiter (see lib/appleGateway.mjs).
settingsRouter.get('/apple-status', (_req, res) => {
  res.json(appleGateway.status())
})

// Forgets the pace limit learned from past 429s and the strike count.
settingsRouter.post('/apple-status/reset', (_req, res) => {
  appleGateway.resetLearned()
  res.json(appleGateway.status())
})

settingsRouter.get('/tag-backfill', (_req, res) => {
  res.json(getTagBackfillStatus())
})

settingsRouter.post('/tag-backfill', async (req, res) => {
  try {
    res.json(await runInLane('background', () => startTagBackfill({ dryRun: Boolean(req.body?.dryRun) })))
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

settingsRouter.post('/tag-backfill/stop', (_req, res) => {
  res.json(stopTagBackfill())
})

settingsRouter.get('/lyrics-backfill', (_req, res) => {
  res.json(getLyricsBackfillStatus())
})

settingsRouter.post('/lyrics-backfill', async (_req, res) => {
  try {
    res.json(await runInLane('background', () => startLyricsBackfill()))
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

settingsRouter.post('/lyrics-backfill/stop', (_req, res) => {
  res.json(stopLyricsBackfill())
})

settingsRouter.get('/artist-backfill', (_req, res) => {
  res.json(getArtistBackfillStatus())
})

settingsRouter.post('/artist-backfill', async (_req, res) => {
  try {
    res.json(await runInLane('background', () => startArtistBackfill()))
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

settingsRouter.post('/artist-backfill/stop', (_req, res) => {
  res.json(stopArtistBackfill())
})
