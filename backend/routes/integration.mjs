import express from 'express'

import { sendAppleError } from '../lib/appleErrors.mjs'
import { hasValidApiToken } from '../lib/apiToken.mjs'
import {
  albumById,
  artistById,
  ensureSongInLibrary,
  playlistById,
  searchAll,
  songById,
} from '../lib/integrationCatalog.mjs'
import { readSettings } from '../lib/settingsStore.mjs'

// Apple Music catalog + library API for the octo-fiesta provider.
export const integrationRouter = express.Router()

// Checked here as well as in requireAuth, so it also holds with AUTH_DISABLED.
integrationRouter.use(async (req, res, next) => {
  if (await hasValidApiToken(req)) return next()
  const { octoIntegrationEnabled } = await readSettings()
  if (!octoIntegrationEnabled) {
    return res.status(404).json({ error: 'the octo-fiesta integration is turned off in Settings' })
  }
  res.status(401).json({ error: 'missing or invalid integration token' })
})

function handle(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req)
      if (out == null) return res.status(404).json({ error: 'not found' })
      res.json(out)
    } catch (err) {
      console.error(`[integration] ${req.method} ${req.path} failed:`, err.message)
      if (/^Apple API 429\b/.test(String(err?.message))) return sendAppleError(res, err)
      res.status(err.status || 502).json({ error: err.message })
    }
  }
}

integrationRouter.get(
  '/search',
  handle((req) =>
    searchAll(String(req.query.q || '').trim(), {
      songs: req.query.songs ?? 20,
      albums: req.query.albums ?? 20,
      artists: req.query.artists ?? 20,
      playlists: req.query.playlists ?? 0,
    }),
  ),
)
integrationRouter.get('/songs/:id', handle((req) => songById(req.params.id)))
integrationRouter.get('/albums/:id', handle((req) => albumById(req.params.id)))
integrationRouter.get('/artists/:id', handle((req) => artistById(req.params.id)))
integrationRouter.get('/playlists/:id', handle((req) => playlistById(req.params.id)))
integrationRouter.post(
  '/songs/:id/ensure',
  handle(async (req) => {
    const { status, path, jobId } = await ensureSongInLibrary(req.params.id)
    return { status, path, jobId: jobId || null }
  }),
)
