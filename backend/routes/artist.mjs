import express from 'express'

import { sendAppleError } from '../lib/appleErrors.mjs'
import { readSettings } from '../lib/settingsStore.mjs'
import { loadArtistCatalogCached } from '../lib/artistCatalogCache.mjs'

export const artistRouter = express.Router()

artistRouter.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const settings = await readSettings()
    const storefront = String(
      req.query.storefront || settings.storefront || 'us',
    )
    const language = settings.language || 'en-US'
    const catalog = await loadArtistCatalogCached({
      artistId: id,
      storefront,
      language,
      explicitFilter: settings.explicitFilter || 'explicit',
    })
    if (!catalog?.artist) return res.status(404).json({ error: 'artist not found' })
    res.json({
      artist: catalog.artist,
      albums: catalog.albums,
      storefront,
    })
  } catch (err) {
    sendAppleError(res, err)
  }
})
