import express from 'express'

import { sendAppleError } from '../lib/appleErrors.mjs'
import { getPlaylist, normalizePlaylist } from '../lib/appleApi.mjs'
import { getLibraryPlaylistDetail } from '../lib/appleLibraryApi.mjs'
import { readAppleCreds, readSettings } from '../lib/settingsStore.mjs'

export const playlistRouter = express.Router()

playlistRouter.get('/library/:libraryId', async (req, res) => {
  try {
    const libraryId = String(req.params.libraryId || '').trim()
    if (!libraryId) return res.status(400).json({ error: 'libraryId required' })
    const settings = await readSettings()
    const creds = await readAppleCreds()
    if (!creds.mediaUserToken) {
      return res.status(412).json({ error: 'media-user-token not configured' })
    }
    const playlist = await getLibraryPlaylistDetail({
      libraryId,
      mediaUserToken: creds.mediaUserToken,
      language: settings.language || 'en-US',
    })
    if (!playlist) return res.status(404).json({ error: 'playlist not found' })
    res.json({ playlist, storefront: settings.storefront || 'us' })
  } catch (err) {
    if (err.code === 'NO_MEDIA_USER_TOKEN' || err.code === 'MEDIA_USER_TOKEN_REJECTED') {
      return res.status(err.statusCode || 412).json({ error: err.message })
    }
    sendAppleError(res, err)
  }
})

playlistRouter.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const settings = await readSettings()
    const storefront = String(
      req.query.storefront || settings.storefront || 'us',
    )
    const language = settings.language || 'en-US'
    const raw = await getPlaylist({ storefront, id, language })
    const playlist = normalizePlaylist(raw?.data?.[0])
    if (!playlist) return res.status(404).json({ error: 'playlist not found' })
    res.json({ playlist, storefront })
  } catch (err) {
    sendAppleError(res, err)
  }
})
